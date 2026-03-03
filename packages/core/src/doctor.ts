import type {
  DoctorDomainHealth,
  DoctorDomainStatus,
  DoctorOptions,
  DoctorResult,
  SourceDomain
} from "./types";
import { resolveSourcePath, ALL_DOMAINS } from "./resolve";

/**
 * Probe a single domain's health: resolve its path, attempt a basic
 * file-existence check, and classify the result.
 */
async function probeDomain(domain: SourceDomain): Promise<DoctorDomainStatus> {
  const resolved = await resolveSourcePath(domain);

  if (!resolved.path) {
    return {
      domain,
      health: "unconfigured" as DoctorDomainHealth,
      source: resolved.source,
      message: `No path configured for ${domain}.`
    };
  }

  try {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(resolved.path, "utf8");
    JSON.parse(content);
    return {
      domain,
      health: "ok" as DoctorDomainHealth,
      path: resolved.path,
      source: resolved.source
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      domain,
      health: "error" as DoctorDomainHealth,
      path: resolved.path,
      source: resolved.source,
      message
    };
  }
}

/**
 * Run a health check across all configured domains.
 *
 * Returns a structured result with per-domain health status.
 * A domain is "ok" if its source path resolves and the file is valid JSON.
 * A domain is "unconfigured" if no path is resolved.
 * A domain is "error" if the file cannot be read or parsed.
 */
export async function runDoctor(_options: DoctorOptions = {}): Promise<DoctorResult> {
  const domains = ALL_DOMAINS as readonly SourceDomain[];
  const statuses = await Promise.all(domains.map(probeDomain));

  const ok = statuses.every(
    (s) => s.health === "ok" || s.health === "unconfigured"
  );

  return {
    ok,
    timestamp: new Date().toISOString(),
    domains: statuses
  };
}
