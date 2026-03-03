import type {
  VerifyFleetDomainResult,
  VerifyFleetOptions,
  VerifyFleetResult,
  SourceDomain
} from "./types";
import { resolveSourcePath, REGISTRY_DOMAINS, STORE_DOMAINS } from "./resolve";
import { validateSkillsRegistry } from "./skills";
import { validateToolsRegistry } from "./tools";
import { validatePromptsRegistry } from "./prompts";
import { validateAgentsRegistry } from "./agents";
import { validateKnowledgeRegistry } from "./knowledge";
import { validateExecStore } from "./exec";

type ValidateFn = (path: string, opts: { strict?: boolean }) => Promise<{ ok: boolean; errors: Array<{ message: string }>; warnings: Array<{ message: string }> }>;

const VALIDATORS: Record<string, ValidateFn> = {
  skills: validateSkillsRegistry as unknown as ValidateFn,
  tools: validateToolsRegistry as unknown as ValidateFn,
  prompts: validatePromptsRegistry as unknown as ValidateFn,
  agents: validateAgentsRegistry as unknown as ValidateFn,
  knowledge: validateKnowledgeRegistry as unknown as ValidateFn,
  exec: validateExecStore as unknown as ValidateFn
};

/**
 * Run fleet-wide verification across all configured domains.
 *
 * For each domain with a configured source path, runs the domain's
 * validator and collects results. Domains without configured paths
 * are reported as skipped.
 */
export async function verifyFleet(options: VerifyFleetOptions = {}): Promise<VerifyFleetResult> {
  const allDomains = [...REGISTRY_DOMAINS, ...STORE_DOMAINS] as string[];
  const results: VerifyFleetDomainResult[] = [];

  for (const domain of allDomains) {
    const resolved = await resolveSourcePath(domain as SourceDomain);

    if (!resolved.path) {
      results.push({
        domain,
        ok: true,
        errors: 0,
        warnings: 0,
        message: `Skipped — no path configured for ${domain}.`
      });
      continue;
    }

    const validator = VALIDATORS[domain];
    if (!validator) {
      results.push({
        domain,
        ok: true,
        errors: 0,
        warnings: 0,
        message: `No validator available for ${domain}.`
      });
      continue;
    }

    try {
      const result = await validator(resolved.path, { strict: Boolean(options.strict) });
      results.push({
        domain,
        ok: result.ok,
        errors: result.errors.length,
        warnings: result.warnings.length
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        domain,
        ok: false,
        errors: 1,
        warnings: 0,
        message
      });
    }
  }

  return {
    ok: results.every((r) => r.ok),
    timestamp: new Date().toISOString(),
    domains: results
  };
}
