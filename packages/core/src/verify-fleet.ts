import type {
  VerifyFleetDomainResult,
  VerifyFleetOptions,
  VerifyFleetResult,
  SourceDomain
} from "./types";
import {
  SOURCE_MODE_ENV_VAR,
  requireSourcePath,
  resolveSourcePath,
  REGISTRY_DOMAINS,
  STORE_DOMAINS
} from "./resolve";
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

function sourceMode(): "auto" | "explicit" | "adapter" {
  const raw = (process.env[SOURCE_MODE_ENV_VAR] ?? "").trim().toLowerCase();
  if (raw === "explicit") {
    return "explicit";
  }
  if (raw === "adapter") {
    return "adapter";
  }
  return "auto";
}

/**
 * Run fleet-wide verification across all configured domains.
 *
 * In explicit mode, only domains with an explicit source path are checked.
 * In adapter mode, missing explicit paths resolve through adapter-backed
 * fallbacks. In auto mode, missing explicit paths are reported as skipped.
 */
export async function verifyFleet(options: VerifyFleetOptions = {}): Promise<VerifyFleetResult> {
  const allDomains = [...REGISTRY_DOMAINS, ...STORE_DOMAINS] as string[];
  const results: VerifyFleetDomainResult[] = [];
  const mode = sourceMode();

  for (const domain of allDomains) {
    const resolved = await resolveSourcePath(domain as SourceDomain);
    let effectivePath = resolved.path;

    if (!effectivePath && mode === "adapter") {
      try {
        effectivePath = await requireSourcePath(domain as SourceDomain);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          domain,
          ok: false,
          errors: 1,
          warnings: 0,
          message
        });
        continue;
      }
    }

    if (!effectivePath) {
      results.push({
        domain,
        ok: true,
        errors: 0,
        warnings: 0,
        message: `Skipped — no path configured for ${domain} (source mode: ${mode}).`
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
      const result = await validator(effectivePath, { strict: Boolean(options.strict) });
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
