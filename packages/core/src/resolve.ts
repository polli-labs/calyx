import { access, constants, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  CalyxConfig,
  CalyxConfigLoadResult,
  ConfigShowResult,
  KnowledgeArtifactEntry,
  RegistryDomain,
  ResolveSourceOptions,
  ResolveSourceResult,
  SourceDomain,
  StoreDomain
} from "./types";
import { resolveAgentsInfraRoot } from "./agents-infra";

// ── Constants ───────────────────────────────────────────────────────

const REGISTRY_DOMAINS: readonly RegistryDomain[] = ["skills", "tools", "prompts", "agents", "knowledge"];
const STORE_DOMAINS: readonly StoreDomain[] = ["exec"];
const ALL_DOMAINS: readonly SourceDomain[] = [...REGISTRY_DOMAINS, ...STORE_DOMAINS];

/** Environment variable names for each domain. */
const ENV_VARS: Record<SourceDomain, string> = {
  skills: "CALYX_SKILLS_REGISTRY",
  tools: "CALYX_TOOLS_REGISTRY",
  prompts: "CALYX_PROMPTS_REGISTRY",
  agents: "CALYX_AGENTS_REGISTRY",
  knowledge: "CALYX_KNOWLEDGE_REGISTRY",
  exec: "CALYX_EXEC_STORE"
};

/** Config file env var override. */
const CONFIG_ENV_VAR = "CALYX_CONFIG";

/** Source resolution mode env var. */
const SOURCE_MODE_ENV_VAR = "CALYX_SOURCE_MODE";

/** Production adapter root overrides. */
const POLLI_ROOT_ENV_VAR = "CALYX_POLLI_ROOT";
const DOCSTORE_ROOT_ENV_VAR = "CALYX_DOCSTORE_ROOT";
const ADAPTER_CACHE_ENV_VAR = "CALYX_ADAPTER_CACHE";

/** Default config file location relative to home. */
const DEFAULT_CONFIG_REL = ".config/calyx/config.json";
const DEFAULT_DOCSTORE_ROOT_REL = ".agents/docstore";
const DEFAULT_ADAPTER_CACHE_REL = ".cache/calyx/adapters";

type SourceMode = "auto" | "explicit" | "adapter";

// ── Config schema ───────────────────────────────────────────────────

const calyxConfigSchema = z
  .object({
    version: z.string().min(1),
    registries: z
      .object({
        skills: z.string().min(1).optional(),
        tools: z.string().min(1).optional(),
        prompts: z.string().min(1).optional(),
        agents: z.string().min(1).optional(),
        knowledge: z.string().min(1).optional()
      })
      .passthrough()
      .optional(),
    stores: z
      .object({
        exec: z.string().min(1).optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

// ── Path helpers ────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(homedir(), p.slice(2));
  }
  return p;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonFile(targetPath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function parseSourceMode(rawValue?: string): SourceMode {
  const value = (rawValue ?? "").trim().toLowerCase();
  if (value === "adapter") {
    return "adapter";
  }
  if (value === "explicit") {
    return "explicit";
  }
  return "auto";
}

/**
 * The Polli monorepo checkout, if the operator declared one.
 *
 * There is deliberately no default. A library default here is a machine-shaped
 * literal — one user's absolute path, on one OS — evaluated on whichever host
 * happens to run the process. It cannot be right on a mac, and on the host it
 * was written for it now points at a retired repo, so an unset variable was
 * reported as somebody else's missing file rather than as unconfigured.
 */
function polliRoot(): string | undefined {
  const raw = process.env[POLLI_ROOT_ENV_VAR];
  return raw && raw.trim().length > 0 ? expandHome(raw) : undefined;
}

function docstoreRoot(): string {
  const raw = process.env[DOCSTORE_ROOT_ENV_VAR];
  const base = raw && raw.trim().length > 0 ? raw : path.join(homedir(), DEFAULT_DOCSTORE_ROOT_REL);
  return expandHome(base);
}

function adapterCacheRoot(): string {
  const raw = process.env[ADAPTER_CACHE_ENV_VAR];
  const base = raw && raw.trim().length > 0 ? raw : path.join(homedir(), DEFAULT_ADAPTER_CACHE_REL);
  return expandHome(base);
}

const POLLI_REGISTRY_MAP: Record<Exclude<RegistryDomain, "agents" | "knowledge">, string> = {
  skills: "docs/org-kb/agents/skills/SOURCES.json",
  tools: "docs/org-kb/agents/tools/TOOLS.json",
  prompts: "docs/org-kb/agents/prompts/REGISTRY.json"
};

function inferIssueFromId(rawId: string): string | undefined {
  const match = rawId.match(/POL-\d+/i);
  return match ? match[0].toUpperCase() : undefined;
}

function fallbackTitle(rawId: string): string {
  return rawId
    .replace(/[-_]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase()) || rawId;
}

async function readMarkdownTitle(markdownPath: string, fallbackId: string): Promise<string> {
  try {
    const text = await readFile(markdownPath, "utf8");
    const heading = text.match(/^#\s+(.+)$/m);
    if (heading?.[1]) {
      return heading[1].trim();
    }
  } catch {
    // Ignore and fall back to derived title.
  }
  return fallbackTitle(fallbackId);
}

async function collectDocstoreExecplans(): Promise<KnowledgeArtifactEntry[]> {
  const root = docstoreRoot();
  const artifacts: KnowledgeArtifactEntry[] = [];

  const directRoot = path.join(root, "execplan");
  if (await fileExists(directRoot)) {
    const entries = await readdir(directRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const id = entry.name;
      const execPlanPath = path.join(directRoot, id, "EXECPLAN.md");
      const legacyPath = path.join(directRoot, id, "plan.md");
      const sourcePath = (await fileExists(execPlanPath)) ? execPlanPath : (await fileExists(legacyPath) ? legacyPath : undefined);
      if (!sourcePath) {
        continue;
      }
      const title = await readMarkdownTitle(sourcePath, id);
      const linkedIssue = inferIssueFromId(id);
      const mtime = (await stat(sourcePath)).mtime.toISOString();
      artifacts.push({
        id,
        title,
        kind: "execplan",
        source_path: sourcePath,
        tags: ["docstore", "execplan"],
        linked_issues: linkedIssue ? [linkedIssue] : [],
        created_at: mtime
      });
    }
  }

  const legacyItemsRoot = path.join(root, "execplan", "items");
  if (await fileExists(legacyItemsRoot)) {
    const itemDirs = await readdir(legacyItemsRoot, { withFileTypes: true });
    for (const dir of itemDirs) {
      if (!dir.isDirectory()) {
        continue;
      }
      const id = dir.name;
      const sourceRoot = path.join(legacyItemsRoot, id, "source", "default");
      const execPlanPath = path.join(sourceRoot, "EXECPLAN.md");
      const legacyPath = path.join(sourceRoot, "plan.md");
      const sourcePath = (await fileExists(execPlanPath)) ? execPlanPath : (await fileExists(legacyPath) ? legacyPath : undefined);
      if (!sourcePath) {
        continue;
      }
      if (artifacts.some((artifact) => artifact.id === id)) {
        continue;
      }
      const title = await readMarkdownTitle(sourcePath, id);
      const linkedIssue = inferIssueFromId(id);
      const mtime = (await stat(sourcePath)).mtime.toISOString();
      artifacts.push({
        id,
        title,
        kind: "execplan",
        source_path: sourcePath,
        tags: ["docstore", "execplan"],
        linked_issues: linkedIssue ? [linkedIssue] : [],
        created_at: mtime
      });
    }
  }

  return artifacts.sort((a, b) => a.id.localeCompare(b.id));
}

async function materializeKnowledgeRegistry(cachePath: string): Promise<string> {
  const artifacts = await collectDocstoreExecplans();
  await writeJsonFile(cachePath, {
    version: new Date().toISOString().slice(0, 10),
    artifacts
  });
  return cachePath;
}

async function materializeExecStore(cachePath: string): Promise<string> {
  await writeJsonFile(cachePath, {
    version: "1",
    runs: []
  });
  return cachePath;
}

async function resolveAdapterPath(domain: SourceDomain): Promise<string> {
  const cacheDir = adapterCacheRoot();

  if (domain === "skills" || domain === "tools" || domain === "prompts") {
    const root = polliRoot();
    if (!root) {
      throw new Error(`Adapter source for ${domain} needs ${POLLI_ROOT_ENV_VAR}; no Polli repo root is configured.`);
    }
    const sourcePath = path.join(root, POLLI_REGISTRY_MAP[domain]);
    if (!(await fileExists(sourcePath))) {
      throw new Error(`Adapter source missing for ${domain}: ${sourcePath}`);
    }
    return sourcePath;
  }

  if (domain === "agents") {
    const agentsInfraRoot = await resolveAgentsInfraRoot();
    const polliCandidateRoot = polliRoot();
    const candidate = agentsInfraRoot
      ? path.join(agentsInfraRoot, "instructions", "agents", "AGENTS.json")
      : polliCandidateRoot
        ? path.join(polliCandidateRoot, "instructions", "agents", "AGENTS.json")
        : undefined;
    if (!candidate) {
      throw new Error(`Adapter source for agents needs a resolvable agents-infra root or ${POLLI_ROOT_ENV_VAR}.`);
    }
    if (!(await fileExists(candidate))) {
      throw new Error(`Adapter source missing for agents: ${candidate}`);
    }
    return candidate;
  }

  if (domain === "knowledge") {
    return materializeKnowledgeRegistry(path.join(cacheDir, "knowledge.registry.json"));
  }

  return materializeExecStore(path.join(cacheDir, "exec.store.json"));
}

// ── Config loading ──────────────────────────────────────────────────

export async function loadCalyxConfig(configPathOverride?: string): Promise<CalyxConfigLoadResult> {
  let configPath: string | undefined;
  let source: "env" | "default" | "none" = "none";

  if (configPathOverride) {
    configPath = expandHome(configPathOverride);
    source = "env";
  } else {
    const envPath = process.env[CONFIG_ENV_VAR];
    if (envPath) {
      configPath = expandHome(envPath);
      source = "env";
    } else {
      const defaultPath = path.join(homedir(), DEFAULT_CONFIG_REL);
      if (await fileExists(defaultPath)) {
        configPath = defaultPath;
        source = "default";
      }
    }
  }

  if (!configPath) {
    return { config: undefined, configPath: undefined, source: "none" };
  }

  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return { config: undefined, configPath, source };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { config: undefined, configPath, source };
  }

  const result = calyxConfigSchema.safeParse(parsed);
  if (!result.success) {
    return { config: undefined, configPath, source };
  }

  return { config: result.data as CalyxConfig, configPath, source };
}

// ── Source resolution ───────────────────────────────────────────────

function resolveFromEnv(domain: SourceDomain): string | undefined {
  const envVar = ENV_VARS[domain];
  const value = process.env[envVar];
  if (value && value.trim().length > 0) {
    return expandHome(value.trim());
  }
  return undefined;
}

function resolveFromConfig(config: CalyxConfig | undefined, domain: SourceDomain): string | undefined {
  if (!config) {
    return undefined;
  }

  if (REGISTRY_DOMAINS.includes(domain as RegistryDomain)) {
    const registryPath = config.registries?.[domain as RegistryDomain];
    if (registryPath) {
      return expandHome(registryPath);
    }
  }

  if (STORE_DOMAINS.includes(domain as StoreDomain)) {
    const storePath = config.stores?.[domain as StoreDomain];
    if (storePath) {
      return expandHome(storePath);
    }
  }

  return undefined;
}

/**
 * Resolve a source path for a domain using the precedence chain:
 * CLI flag > environment variable > config file > none.
 *
 * This function does NOT check whether the resolved path exists — that
 * is the caller's responsibility (the domain loaders already produce
 * clear error messages for missing files).
 */
export async function resolveSourcePath(
  domain: SourceDomain,
  options: ResolveSourceOptions = {}
): Promise<ResolveSourceResult> {
  // 1. CLI flag — highest precedence
  if (options.cliValue && options.cliValue.trim().length > 0) {
    return { path: expandHome(options.cliValue.trim()), source: "cli" };
  }

  // 2. Environment variable
  const envPath = resolveFromEnv(domain);
  if (envPath) {
    return { path: envPath, source: "env" };
  }

  // 3. Config file
  const { config } = await loadCalyxConfig(options.configPath);
  const configResolvedPath = resolveFromConfig(config, domain);
  if (configResolvedPath) {
    return { path: configResolvedPath, source: "config" };
  }

  // 4. No source found
  return { path: undefined, source: "none" };
}

/**
 * Resolve a source path, throwing if no path can be resolved.
 * This is the primary entry point for CLI commands that previously
 * required `--registry` or `--store`.
 */
export async function requireSourcePath(
  domain: SourceDomain,
  options: ResolveSourceOptions = {}
): Promise<string> {
  const result = await resolveSourcePath(domain, options);
  if (result.path) {
    return result.path;
  }

  const mode = parseSourceMode(process.env[SOURCE_MODE_ENV_VAR]);
  if (mode !== "explicit") {
    try {
      return await resolveAdapterPath(domain);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const envVar = ENV_VARS[domain];
      const flag = STORE_DOMAINS.includes(domain as StoreDomain) ? "--store" : "--registry";
      throw new Error(
        `No ${domain} source path found via explicit resolution (${flag}, ${envVar}, config) ` +
        `and adapter resolution failed: ${message}`
      );
    }
  }

  {
    const envVar = ENV_VARS[domain];
    const flag = STORE_DOMAINS.includes(domain as StoreDomain) ? "--store" : "--registry";
    throw new Error(
      `No ${domain} source path found. Provide ${flag} <path>, ` +
      `set ${envVar}, or configure it in ~/.config/calyx/config.json.`
    );
  }
}

// ── Config show ─────────────────────────────────────────────────────

export async function showConfig(configPathOverride?: string): Promise<ConfigShowResult> {
  const { config, configPath, source } = await loadCalyxConfig(configPathOverride);

  const resolved: Record<string, ResolveSourceResult> = {};
  for (const domain of ALL_DOMAINS) {
    // Check CLI (always undefined in show context), env, config
    const envPath = resolveFromEnv(domain);
    if (envPath) {
      resolved[domain] = { path: envPath, source: "env" };
      continue;
    }

    const configResolvedPath = resolveFromConfig(config, domain);
    if (configResolvedPath) {
      resolved[domain] = { path: configResolvedPath, source: "config" };
      continue;
    }

    resolved[domain] = { path: undefined, source: "none" };
  }

  return {
    configPath,
    configSource: source,
    resolved: resolved as Record<SourceDomain, ResolveSourceResult>
  };
}

export {
  ENV_VARS,
  CONFIG_ENV_VAR,
  SOURCE_MODE_ENV_VAR,
  POLLI_ROOT_ENV_VAR,
  DOCSTORE_ROOT_ENV_VAR,
  ADAPTER_CACHE_ENV_VAR,
  REGISTRY_DOMAINS,
  STORE_DOMAINS,
  ALL_DOMAINS
};
