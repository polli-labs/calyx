import { execFile } from "node:child_process";
import { access, constants, readFile, stat } from "node:fs/promises";
import { homedir, hostname as systemHostname } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import type { RepoRegistryAliasCollision, RepoRegistryDoctorResult, RepoRegistryRootStatus } from "./types";
import type { ConsumerApiCredentialTruth } from "./consumer-credentials";

export const AGENTS_INFRA_ROOT_ENV_VAR = "CALYX_AGENTS_INFRA_ROOT";
export const HOSTS_TRUTH_RELATIVE_PATH = path.join("fleet", "truths", "hosts.yaml");
export const GIT_PROBE_TIMEOUT_MS = 5_000;
const execFileP = promisify(execFile);

interface AgentsLocalConfig {
  hostAlias?: string;
}

export interface HostTruthEntry {
  home?: string;
  vault_root?: string;
  repos?: Record<string, RepoTruthEntry>;
  run_serve_url?: string;
  consumer_api_credentials?: ConsumerApiCredentialTruth[];
  gpus?: Array<{ model?: string; vram_gb?: number; type?: string }>;
  ram_gb?: number;
  roles?: string[];
  services?: string[];
  notes?: string;
}

export type RepoTruthEntry = string | {
  path?: string;
  aliases?: string[];
};

export interface ResolvedRepoIdentity {
  slug: string;
  path: string;
}

export interface HostsTruthFile {
  hosts?: Record<string, HostTruthEntry>;
}

export interface RepoRegistryDoctorOptions {
  agentsInfraRoot?: string;
  host?: string;
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

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function agentsInfraMarkers(root: string): string[] {
  return [
    path.join(root, "instructions", "skills", "SOURCES.json"),
    path.join(root, "instructions", "templates", "REGISTRY.json"),
    path.join(root, "fleet", "truths", "hosts.yaml"),
  ];
}

async function isAgentsInfraRoot(root: string): Promise<boolean> {
  const markers = agentsInfraMarkers(root);
  for (const marker of markers) {
    if (!(await pathExists(marker))) {
      return false;
    }
  }
  return true;
}

export async function resolveExplicitAgentsInfraRoot(candidate: string): Promise<string | undefined> {
  const resolved = path.resolve(expandHomePath(candidate));
  return await isAgentsInfraRoot(resolved) ? resolved : undefined;
}

async function deriveAgentsInfraRootFromPath(
  pathname?: string,
): Promise<string | undefined> {
  if (!pathname || pathname.trim().length === 0) {
    return undefined;
  }

  let current = path.resolve(expandHomePath(pathname));
  const statsPath = current.endsWith(path.sep) ? current.slice(0, -1) : current;
  current = path.extname(statsPath) ? path.dirname(statsPath) : statsPath;

  while (true) {
    if (await isAgentsInfraRoot(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export async function resolveAgentsInfraRoot(options: {
  explicitRoot?: string;
  registryPath?: string;
  surfacesDir?: string;
} = {}): Promise<string | undefined> {
  const candidates: Array<string | undefined> = [
    options.explicitRoot,
    process.env[AGENTS_INFRA_ROOT_ENV_VAR],
  ];

  for (const candidate of candidates) {
    if (!candidate || candidate.trim().length === 0) {
      continue;
    }
    const resolved = path.resolve(expandHomePath(candidate));
    if (await isAgentsInfraRoot(resolved)) {
      return resolved;
    }
  }

  const derivedCandidates = [
    await deriveAgentsInfraRootFromPath(options.registryPath),
    await deriveAgentsInfraRootFromPath(options.surfacesDir),
  ];
  for (const derived of derivedCandidates) {
    if (derived) {
      return derived;
    }
  }

  const canonicalCandidates = [
    path.join(homedir(), "dev", "agents-infra", "dev"),
    path.join(homedir(), "projects", "agents-infra"),
    path.join(homedir(), "repo", "agents-infra"),
  ];

  for (const candidate of canonicalCandidates) {
    if (await isAgentsInfraRoot(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export async function resolveRepoClone(repoId: string): Promise<string | undefined> {
  const repoName = repoId.trim().split("/").pop();
  if (!repoName) {
    return undefined;
  }

  const baseName = repoName.endsWith("-dev") ? repoName.slice(0, -4) : undefined;
  const candidates = [
    path.join(homedir(), "dev", repoName, "dev"),
    ...(baseName ? [path.join(homedir(), "dev", baseName, "dev", repoName)] : []),
    ...(baseName ? [path.join(homedir(), "dev", baseName, "dev")] : []),
    path.join(homedir(), "projects", repoName),
    path.join(homedir(), "repo", repoName),
    ...(baseName ? [path.join(homedir(), "repo", baseName)] : []),
  ];

  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, ".git"))) {
      return candidate;
    }
  }

  return undefined;
}

export async function resolveCurrentHostAlias(
  explicitHost?: string,
  agentsInfraRoot?: string,
): Promise<string> {
  if (explicitHost && explicitHost.trim().length > 0) {
    return explicitHost.trim();
  }

  const localConfigPath = path.join(homedir(), ".config", "polli", "agents.local.json");
  if (await pathExists(localConfigPath)) {
    try {
      const parsed = JSON.parse(await readFile(localConfigPath, "utf8")) as AgentsLocalConfig;
      if (parsed.hostAlias && parsed.hostAlias.trim().length > 0) {
        return parsed.hostAlias.trim();
      }
    } catch {
      // Ignore and continue to fallback resolution.
    }
  }

  const hostname = systemHostname().trim();
  if (hostname.length > 0) {
    if (!agentsInfraRoot) {
      return hostname;
    }

    const hostsTruth = await readHostsTruth(agentsInfraRoot);
    if (hostsTruth.hosts && hostsTruth.hosts[hostname]) {
      return hostname;
    }

    const home = homedir();
    for (const [alias, entry] of Object.entries(hostsTruth.hosts ?? {})) {
      if (entry.home && path.resolve(expandHomePath(entry.home)) === path.resolve(home)) {
        return alias;
      }
    }
    return hostname;
  }

  return "unknown";
}

export async function readHostsTruth(agentsInfraRoot: string): Promise<HostsTruthFile> {
  const truthPath = path.join(agentsInfraRoot, HOSTS_TRUTH_RELATIVE_PATH);
  if (!(await pathExists(truthPath))) {
    return {};
  }

  try {
    const parsed = YAML.parse(await readFile(truthPath, "utf8")) as HostsTruthFile | null;
    return parsed ?? {};
  } catch {
    return {};
  }
}

async function gitRevParseTopLevel(repoRoot: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(
      "git",
      ["-C", repoRoot, "rev-parse", "--show-toplevel"],
      { timeout: GIT_PROBE_TIMEOUT_MS },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      code?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      code: typeof execError.code === "number" ? execError.code : 1,
      stdout: execError.stdout?.toString() ?? "",
      stderr: execError.stderr?.toString() ?? execError.message,
    };
  }
}

function repoRegistryRemediation(host: string, repo: string, configuredRoot: string): string {
  return [
    `Update ${HOSTS_TRUTH_RELATIVE_PATH} for host "${host}" repo "${repo}" to point at a Git checkout,`,
    `or create/migrate the checkout at ${configuredRoot}.`,
  ].join(" ");
}

function repoEntryPath(entry: RepoTruthEntry | undefined): string | undefined {
  if (typeof entry === "string") {
    return entry.trim();
  }
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  return typeof entry.path === "string" ? entry.path.trim() : undefined;
}

function repoEntryAliases(entry: RepoTruthEntry | undefined): string[] {
  if (!entry || typeof entry === "string" || !Array.isArray(entry.aliases)) {
    return [];
  }
  return entry.aliases
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Polli's durable private repositories use an explicit `<owner>/<repo>-dev`
 * registry identity while operators naturally type the remote leaf. Derive
 * that one bounded alias from configured truth instead of basename-guessing
 * arbitrary repository names. Cross-owner leaf collisions remain visible to
 * the normal fail-closed alias-collision machinery.
 */
function privateDevLeafAlias(alias: string): string | undefined {
  const normalized = normalizeRepoIdentifier(alias);
  const separator = normalized.lastIndexOf("/");
  if (separator <= 0 || separator === normalized.length - 1) {
    return undefined;
  }
  const leaf = normalized.slice(separator + 1);
  return leaf.endsWith("-dev") ? leaf : undefined;
}

function repoEntryDerivedIdentities(slug: string, entry: RepoTruthEntry | undefined): string[] {
  const identities = new Set<string>();
  for (const alias of repoEntryAliases(entry)) {
    const leaf = privateDevLeafAlias(alias);
    if (leaf && normalizeRepoIdentifier(leaf) !== normalizeRepoIdentifier(slug)) {
      identities.add(leaf);
    }
  }
  return Array.from(identities);
}

function normalizeRepoIdentifier(identifier: string): string {
  let value = identifier.trim();
  if (value.length === 0) {
    return "";
  }

  const scpMatch = value.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  const scpOwner = scpMatch?.[1];
  const scpRepo = scpMatch?.[2];
  if (scpOwner && scpRepo) {
    return `${scpOwner.toLowerCase()}/${scpRepo.toLowerCase()}`;
  }

  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() === "github.com") {
      const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
      if (segments.length >= 2 && segments[0] && segments[1]) {
        const repo = segments[1].replace(/\.git$/i, "");
        return `${segments[0].toLowerCase()}/${repo.toLowerCase()}`;
      }
    }
  } catch {
    // Continue with non-URL normalization.
  }

  value = value.replace(/^github:/i, "");
  value = value.replace(/\.git$/i, "");
  return value.toLowerCase();
}

function formatRepoIdentityCandidates(candidates: readonly {
  slug: string;
  path: string;
  identities: string[];
}[]): string {
  return candidates
    .map((candidate) => {
      const identities = candidate.identities.length > 0
        ? ` identities: ${candidate.identities.join(", ")}`
        : "";
      return `${candidate.slug} (${candidate.path}${identities})`;
    })
    .join("; ");
}

function buildRepoIdentityCandidates(repos: Record<string, RepoTruthEntry>): Array<{
  slug: string;
  path: string;
  identities: string[];
  configuredIdentities: string[];
  derivedIdentities: string[];
}> {
  return Object.entries(repos)
    .flatMap(([slug, entry]) => {
      const repoPath = repoEntryPath(entry);
      if (!repoPath) {
        return [];
      }
      const configuredIdentities = repoEntryAliases(entry);
      const derivedIdentities = repoEntryDerivedIdentities(slug, entry);
      return [{
        slug,
        path: repoPath,
        identities: [...configuredIdentities, ...derivedIdentities],
        configuredIdentities,
        derivedIdentities,
      }];
    })
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

function detectRepoAliasCollisions(candidates: readonly {
  slug: string;
  identities: string[];
}[]): RepoRegistryAliasCollision[] {
  const groups = new Map<string, { aliases: Set<string>; repos: Set<string> }>();

  for (const candidate of candidates) {
    for (const alias of [candidate.slug, ...candidate.identities]) {
      const normalized = normalizeRepoIdentifier(alias);
      if (!normalized) {
        continue;
      }
      const group = groups.get(normalized) ?? { aliases: new Set<string>(), repos: new Set<string>() };
      group.aliases.add(alias);
      group.repos.add(candidate.slug);
      groups.set(normalized, group);
    }
  }

  return Array.from(groups.entries())
    .flatMap(([normalizedIdentity, group]) => {
      if (group.repos.size < 2) {
        return [];
      }
      return [{
        normalized_identity: normalizedIdentity,
        aliases: Array.from(group.aliases).sort(),
        repos: Array.from(group.repos).sort(),
      }];
    })
    .sort((left, right) => left.normalized_identity.localeCompare(right.normalized_identity));
}

function repoRegistryStatus(input: {
  host: string;
  repo: string;
  configuredRoot: string;
  source: string;
  ok: boolean;
  code: RepoRegistryRootStatus["code"];
  health: RepoRegistryRootStatus["health"];
  aliases?: string[] | undefined;
  configuredAliases?: string[] | undefined;
  derivedAliases?: string[] | undefined;
  message?: string;
  gitToplevel?: string;
}): RepoRegistryRootStatus {
  const aliases = input.aliases ?? [];
  return {
    host: input.host,
    repo: input.repo,
    configured_root: input.configuredRoot,
    source: input.source,
    ok: input.ok,
    health: input.health,
    code: input.code,
    ...(aliases.length > 0
      ? {
          aliases,
          normalized_aliases: Array.from(new Set(aliases.map(normalizeRepoIdentifier))).sort(),
        }
      : {}),
    ...(input.configuredAliases && input.configuredAliases.length > 0
      ? { configured_aliases: input.configuredAliases }
      : {}),
    ...(input.derivedAliases && input.derivedAliases.length > 0
      ? { derived_aliases: input.derivedAliases }
      : {}),
    ...(input.gitToplevel ? { git_toplevel: input.gitToplevel } : {}),
    ...(input.message ? { message: input.message } : {}),
    ...(input.ok
      ? {}
      : { remediation: repoRegistryRemediation(input.host, input.repo, input.configuredRoot) }),
  };
}

export async function validateRepoRegistryRoot(input: {
  host: string;
  repo: string;
  configuredRoot: string;
  source: string;
  aliases?: string[];
  configuredAliases?: string[];
  derivedAliases?: string[];
}): Promise<RepoRegistryRootStatus> {
  const configuredRoot = path.resolve(expandHomePath(input.configuredRoot));

  try {
    const info = await stat(configuredRoot);
    if (!info.isDirectory()) {
      return repoRegistryStatus({
        host: input.host,
        repo: input.repo,
        configuredRoot,
        source: input.source,
        ok: false,
        health: "error",
        code: "repo-root-not-directory",
        aliases: input.aliases,
        configuredAliases: input.configuredAliases,
        derivedAliases: input.derivedAliases,
        message: "Configured repo root exists but is not a directory.",
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return repoRegistryStatus({
        host: input.host,
        repo: input.repo,
        configuredRoot,
        source: input.source,
        ok: false,
        health: "error",
        code: "repo-root-missing",
        aliases: input.aliases,
        configuredAliases: input.configuredAliases,
        derivedAliases: input.derivedAliases,
        message: "Configured repo root does not exist.",
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return repoRegistryStatus({
      host: input.host,
      repo: input.repo,
      configuredRoot,
      source: input.source,
      ok: false,
      health: "error",
      code: "repo-root-check-error",
      aliases: input.aliases,
      configuredAliases: input.configuredAliases,
      derivedAliases: input.derivedAliases,
      message,
    });
  }

  const result = await gitRevParseTopLevel(configuredRoot);
  const gitToplevel = result.stdout.trim();
  if (result.code === 0 && gitToplevel.length > 0) {
    return repoRegistryStatus({
      host: input.host,
      repo: input.repo,
      configuredRoot,
      source: input.source,
      ok: true,
      health: "ok",
      code: "repo-root-ok",
      aliases: input.aliases,
      configuredAliases: input.configuredAliases,
      derivedAliases: input.derivedAliases,
      gitToplevel,
    });
  }

  const message = (result.stderr || result.stdout || `git rev-parse exited ${result.code}`).trim();
  return repoRegistryStatus({
    host: input.host,
    repo: input.repo,
    configuredRoot,
    source: input.source,
    ok: false,
    health: "error",
    code: "repo-root-not-git-repository",
    aliases: input.aliases,
    configuredAliases: input.configuredAliases,
    derivedAliases: input.derivedAliases,
    message,
  });
}

export function formatRepoRegistryRootError(status: RepoRegistryRootStatus): string {
  return [
    "Repo registry/config failure before worktree acquisition.",
    `host: ${status.host}`,
    `repo: ${status.repo}`,
    `configured_root: ${status.configured_root}`,
    `source: ${status.source}`,
    `code: ${status.code}`,
    ...(status.message ? [`error: ${status.message}`] : []),
    ...(status.remediation ? [`fix: ${status.remediation}`] : []),
  ].join("\n");
}

export async function doctorRepoRegistry(
  options: RepoRegistryDoctorOptions = {},
): Promise<RepoRegistryDoctorResult> {
  const agentsInfraRoot = options.agentsInfraRoot ?? await resolveAgentsInfraRoot();
  if (!agentsInfraRoot) {
    throw new Error(
      `Repo registry doctor requires agents-infra root discovery, but it could not be found. Set ${AGENTS_INFRA_ROOT_ENV_VAR} or ensure ~/dev/agents-infra/dev exists.`,
    );
  }

  const host = await resolveTargetHostAlias(options.host ?? "local", agentsInfraRoot);
  const hostsTruth = await readHostsTruth(agentsInfraRoot);
  const hostEntry = hostsTruth.hosts?.[host];
  if (!hostEntry) {
    throw new Error(`Unknown host alias "${host}". Add it to ${HOSTS_TRUTH_RELATIVE_PATH}.`);
  }

  const source = path.join(agentsInfraRoot, HOSTS_TRUTH_RELATIVE_PATH);
  const repoEntries = buildRepoIdentityCandidates(hostEntry.repos ?? {});
  const aliasCollisions = detectRepoAliasCollisions(repoEntries);
  const roots = await Promise.all(
    repoEntries.map((entry) =>
      validateRepoRegistryRoot({
        host,
        repo: entry.slug,
        configuredRoot: entry.path,
        source,
        aliases: entry.identities,
        configuredAliases: entry.configuredIdentities,
        derivedAliases: entry.derivedIdentities,
      }),
    ),
  );

  return {
    ok: roots.every((root) => root.ok) && aliasCollisions.length === 0,
    host,
    source_path: source,
    roots,
    ...(aliasCollisions.length > 0 ? { alias_collisions: aliasCollisions } : {}),
  };
}

function normalizeHostAlias(host: string): string {
  return host.trim().toLowerCase().replace(/\..*$/, "");
}

async function resolveTargetHostAlias(host: string, agentsInfraRoot: string): Promise<string> {
  const hostAlias = normalizeHostAlias(host);
  if (hostAlias === "local" || hostAlias.length === 0) {
    return resolveCurrentHostAlias(undefined, agentsInfraRoot);
  }
  return hostAlias;
}

export async function resolveVaultUri(
  uri: string,
  host: string,
  agentsInfraRoot: string,
): Promise<string> {
  if (!uri.startsWith("vault://")) {
    return uri;
  }

  const rawRelativePath = uri.slice("vault://".length).trim().replace(/^\/+/, "");
  if (!rawRelativePath) {
    throw new Error(`Invalid vault URI: ${uri}. Expected vault://<path-relative-to-fieldwork>.`);
  }

  const targetHost = await resolveTargetHostAlias(host, agentsInfraRoot);
  const hostsTruth = await readHostsTruth(agentsInfraRoot);
  const hostEntry = hostsTruth.hosts?.[targetHost];
  if (!hostEntry) {
    throw new Error(`Unknown host alias "${targetHost}". Add it to fleet/truths/hosts.yaml.`);
  }

  const vaultRoot = hostEntry.vault_root?.trim();
  if (!vaultRoot) {
    throw new Error(
      `Host "${targetHost}" has no vault_root configured in fleet/truths/hosts.yaml. Add it or pass an absolute --execplan-ref path.`,
    );
  }

  return path.join(path.resolve(expandHomePath(vaultRoot)), rawRelativePath);
}

export async function resolveRepo(
  slug: string,
  host: string,
  agentsInfraRoot: string,
): Promise<string> {
  const resolved = await resolveRepoIdentity(slug, host, agentsInfraRoot);
  return resolved.path;
}

/**
 * Suggest the closest registered repo slugs for an unresolved identifier so the
 * unregistered-repo dead-end carries an actionable "did you mean" hint
 * (POL-1826 — repo_unregistered is the dominant worktree-acquisition
 * infra_error). Pure string heuristic: substring containment in either
 * direction or a shared 3+ character prefix, matched on the basename of
 * slash-bearing identifiers.
 */
export function suggestNearestRepos(identifier: string, slugs: string[], limit = 3): string[] {
  const needle = identifier.trim().toLowerCase();
  const base = needle.includes("/") ? needle.slice(needle.lastIndexOf("/") + 1) : needle;
  if (base.length < 2) return [];
  const matches = slugs.filter((slug) => {
    const candidate = slug.toLowerCase();
    if (candidate.includes(base) || base.includes(candidate)) return true;
    const shared = Math.min(candidate.length, base.length);
    let prefix = 0;
    while (prefix < shared && candidate[prefix] === base[prefix]) prefix += 1;
    return prefix >= 3;
  });
  return matches.slice(0, limit);
}

export async function resolveRepoIdentity(
  identifier: string,
  host: string,
  agentsInfraRoot: string,
): Promise<ResolvedRepoIdentity> {
  const trimmedIdentifier = identifier.trim();
  if (!trimmedIdentifier) {
    throw new Error("Invalid repo identifier: expected a non-empty value.");
  }

  const targetHost = await resolveTargetHostAlias(host, agentsInfraRoot);
  const hostsTruth = await readHostsTruth(agentsInfraRoot);
  const hostEntry = hostsTruth.hosts?.[targetHost];
  if (!hostEntry) {
    throw new Error(`Unknown host alias "${targetHost}". Add it to fleet/truths/hosts.yaml.`);
  }

  const repos = hostEntry.repos ?? {};
  const candidates = buildRepoIdentityCandidates(repos);
  const repoSlugs = candidates.map((candidate) => candidate.slug);
  if (candidates.length === 0) {
    throw new Error(
      `Host "${targetHost}" has no repos configured in fleet/truths/hosts.yaml. Add the repo to fleet/truths/hosts.yaml or pass --worktree-path explicitly.`,
    );
  }

  const normalizedIdentifier = normalizeRepoIdentifier(trimmedIdentifier);
  const aliasMatches = candidates.filter((candidate) =>
    normalizeRepoIdentifier(candidate.slug) === normalizedIdentifier
    || candidate.identities.some((alias) => normalizeRepoIdentifier(alias) === normalizedIdentifier)
  );
  if (aliasMatches.length === 1) {
    const match = aliasMatches[0]!;
    return { slug: match.slug, path: path.resolve(expandHomePath(match.path)) };
  }
  if (aliasMatches.length > 1) {
    throw new Error(
      `Repo identifier "${trimmedIdentifier}" is ambiguous on host "${targetHost}". Candidate canonical repos: ${formatRepoIdentityCandidates(aliasMatches)}. Refuse to guess through a repo identity collision; fix duplicate aliases in ${HOSTS_TRUTH_RELATIVE_PATH}.`,
    );
  }

  const slashBearing = /[:/]/.test(trimmedIdentifier);
  const normalizedAliases = candidates.flatMap((candidate) =>
    candidate.identities.map((alias) => `${alias} -> ${candidate.slug}`)
  );
  const aliasSuffix = normalizedAliases.length > 0
    ? ` Configured aliases on ${targetHost}: ${normalizedAliases.sort().join(", ")}.`
    : "";
  const slashHint = slashBearing
    ? " Slash-bearing repo identifiers must match an explicit configured alias; Calyx will not basename-guess through namespace collisions."
    : "";
  const suggestions = suggestNearestRepos(trimmedIdentifier, repoSlugs);
  const didYouMean = suggestions.length > 0
    ? ` Did you mean: ${suggestions.join(", ")}?`
    : "";
  throw new Error(
    `Host "${targetHost}" does not have repo slug or alias "${trimmedIdentifier}" in fleet/truths/hosts.yaml.${didYouMean} Available repos on ${targetHost}: ${repoSlugs.join(", ")}.${aliasSuffix}${slashHint} (Add the repo alias to fleet/truths/hosts.yaml or pass --worktree-path explicitly.)`,
  );
}

export async function resolveRepoForRun(
  slug: string,
  host: string,
  agentsInfraRoot: string,
): Promise<string> {
  const resolvedRepo = await resolveRepoIdentity(slug, host, agentsInfraRoot);
  const repoPath = resolvedRepo.path;
  const targetHost = await resolveTargetHostAlias(host, agentsInfraRoot);
  // Reuse the doctor validator so run preflight and `calyx doctor` classify
  // configured roots the same way, even though resolveRepo already normalizes.
  const status = await validateRepoRegistryRoot({
    host: targetHost,
    repo: resolvedRepo.slug,
    configuredRoot: repoPath,
    source: path.join(agentsInfraRoot, HOSTS_TRUTH_RELATIVE_PATH),
  });

  if (!status.ok) {
    throw new Error(formatRepoRegistryRootError(status));
  }

  return repoPath;
}

export function agentsInfraEnvVar(): string {
  return AGENTS_INFRA_ROOT_ENV_VAR;
}

export { expandHomePath, pathExists };
