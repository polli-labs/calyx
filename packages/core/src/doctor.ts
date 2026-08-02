import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
  DoctorFinding,
  DoctorDomainHealth,
  DoctorDomainStatus,
  DoctorOptions,
  DoctorResult,
  RepoRegistryDoctorResult,
  SourceDomain
} from "./types";
import { resolveSourcePath, ALL_DOMAINS } from "./resolve";
import {
  AGENTS_INFRA_ROOT_ENV_VAR,
  HOSTS_TRUTH_RELATIVE_PATH,
  doctorRepoRegistry,
  resolveAgentsInfraRoot,
  resolveExplicitAgentsInfraRoot,
} from "./agents-infra";

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
async function probeRepoRegistry(options: DoctorOptions): Promise<RepoRegistryDoctorResult | undefined> {
  if (options.includeRepoRegistry === false) {
    return undefined;
  }

  const resolved = await resolveRepoRegistryDoctorRoot(options);
  if (!resolved) {
    return undefined;
  }
  if ("error" in resolved) {
    return resolved.error;
  }

  try {
    return await doctorRepoRegistry({
      agentsInfraRoot: resolved.agentsInfraRoot,
      ...(options.host ? { host: options.host } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return repoRegistryInputError({
      host: options.host ?? "local",
      agentsInfraRoot: resolved.agentsInfraRoot,
      message,
      remediation: `Check ${HOSTS_TRUTH_RELATIVE_PATH} and the --host value; run on the target host for local filesystem validation.`,
    });
  }
}

function expandHomePath(pathname: string): string {
  if (pathname === "~") {
    return homedir();
  }
  if (pathname.startsWith("~/")) {
    return path.join(homedir(), pathname.slice(2));
  }
  return pathname;
}

function repoRegistryInputError(input: {
  host: string;
  agentsInfraRoot: string;
  message: string;
  remediation: string;
}): RepoRegistryDoctorResult {
  return {
    ok: false,
    host: input.host,
    source_path: path.join(path.resolve(expandHomePath(input.agentsInfraRoot)), HOSTS_TRUTH_RELATIVE_PATH),
    roots: [],
    code: "repo-registry-input-error",
    message: input.message,
    remediation: input.remediation,
  };
}

async function resolveRepoRegistryDoctorRoot(
  options: DoctorOptions,
): Promise<{ agentsInfraRoot: string } | { error: RepoRegistryDoctorResult } | undefined> {
  const explicitRoot = options.agentsInfraRoot?.trim();
  if (explicitRoot) {
    const agentsInfraRoot = await resolveExplicitAgentsInfraRoot(explicitRoot);
    if (agentsInfraRoot) {
      return { agentsInfraRoot };
    }
    return {
      error: repoRegistryInputError({
        host: options.host ?? "local",
        agentsInfraRoot: explicitRoot,
        message: `Configured agents-infra root is not a valid agents-infra checkout: ${explicitRoot}`,
        remediation: `Point agentsInfraRoot at a checkout containing ${HOSTS_TRUTH_RELATIVE_PATH}.`,
      }),
    };
  }

  const envRoot = process.env[AGENTS_INFRA_ROOT_ENV_VAR]?.trim();
  if (envRoot) {
    const agentsInfraRoot = await resolveExplicitAgentsInfraRoot(envRoot);
    if (agentsInfraRoot) {
      return { agentsInfraRoot };
    }
    return {
      error: repoRegistryInputError({
        host: options.host ?? "local",
        agentsInfraRoot: envRoot,
        message: `${AGENTS_INFRA_ROOT_ENV_VAR} is not a valid agents-infra checkout: ${envRoot}`,
        remediation: `Unset ${AGENTS_INFRA_ROOT_ENV_VAR} or point it at a checkout containing ${HOSTS_TRUTH_RELATIVE_PATH}.`,
      }),
    };
  }

  const agentsInfraRoot = await resolveAgentsInfraRoot();
  return agentsInfraRoot ? { agentsInfraRoot } : undefined;
}

function defaultDaemonsRoot(): string {
  const fromEnv = process.env["CALYX_DAEMONS_ROOT"]?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.join(homedir(), ".calyx", "daemons");
}

function defaultWrapperPath(): string {
  return path.join(homedir(), ".agents", "run", "calyx");
}

function pathReferencesRepo(candidate: string, repoRoot: string): boolean {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedRoot = path.resolve(repoRoot);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function inferCalyxRepoRoot(repoRegistry: RepoRegistryDoctorResult | undefined): string {
  const registeredRoot = repoRegistry?.roots.find((root) => root.repo === "calyx")?.configured_root;
  return registeredRoot ? path.resolve(expandHomePath(registeredRoot)) : path.join(homedir(), "dev", "calyx", "dev");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function collectDaemonServesFromCloneFindings(
  repoRegistry: RepoRegistryDoctorResult | undefined,
): Promise<DoctorFinding[]> {
  const repoRoot = inferCalyxRepoRoot(repoRegistry);
  const evidence: string[] = [];
  const daemonsRoot = defaultDaemonsRoot();

  try {
    const entries = await readdir(daemonsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const descriptorPath = path.join(daemonsRoot, entry.name, "descriptor.json");
      let descriptor: unknown;
      try {
        descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(descriptor) || !Array.isArray(descriptor["argv"])) {
        continue;
      }
      const argv = descriptor["argv"].filter((part): part is string => typeof part === "string");
      const cloneArgv = argv.filter((part) => path.isAbsolute(part) && pathReferencesRepo(part, repoRoot));
      if (cloneArgv.length > 0) {
        const daemonId = typeof descriptor["daemon_id"] === "string" ? descriptor["daemon_id"] : entry.name;
        evidence.push(`descriptor ${daemonId} argv references clone path(s): ${cloneArgv.join(" ")}`);
      }
    }
  } catch {
    // Absence or unreadability of the daemon registry is not itself this finding.
  }

  const wrapperPath = defaultWrapperPath();
  try {
    const wrapper = await readFile(wrapperPath, "utf8");
    if (wrapper.includes(repoRoot)) {
      evidence.push(`wrapper ${wrapperPath} references clone root ${repoRoot}`);
    }
  } catch {
    // Missing wrapper is handled by bootstrap, not this clone-serving finding.
  }

  if (evidence.length === 0) {
    return [];
  }

  return [
    {
      code: "daemon-serves-from-clone",
      severity: "error",
      message:
        "A Calyx daemon serving path references the live dev clone. Promote a versioned install and repoint supervisors through the bootstrap wrapper.",
      evidence,
      remediation:
        "Run `calyx self upgrade --host <this-host>` to promote ~/.calyx/installs/current, then `calyx install bootstrap --apply`; systemd/launchd units should exec ~/.agents/run/calyx.",
    },
  ];
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const domains = ALL_DOMAINS as readonly SourceDomain[];
  const statuses = await Promise.all(domains.map(probeDomain));
  const repoRegistry = await probeRepoRegistry(options);
  const findings = await collectDaemonServesFromCloneFindings(repoRegistry);

  const ok = statuses.every(
    (s) => s.health === "ok" || s.health === "unconfigured"
  ) && (repoRegistry?.ok ?? true) && findings.length === 0;

  return {
    ok,
    timestamp: new Date().toISOString(),
    domains: statuses,
    ...(repoRegistry ? { repoRegistry } : {}),
    ...(findings.length > 0 ? { findings } : {}),
  };
}
