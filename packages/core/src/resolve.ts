import { readFile } from "node:fs/promises";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  CalyxConfig,
  CalyxConfigLoadResult,
  ConfigShowResult,
  RegistryDomain,
  ResolveSourceOptions,
  ResolveSourceResult,
  SourceDomain,
  StoreDomain
} from "./types";

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

/** Default config file location relative to home. */
const DEFAULT_CONFIG_REL = ".config/calyx/config.json";

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
  if (!result.path) {
    const envVar = ENV_VARS[domain];
    const flag = STORE_DOMAINS.includes(domain as StoreDomain) ? "--store" : "--registry";
    throw new Error(
      `No ${domain} source path found. Provide ${flag} <path>, ` +
      `set ${envVar}, or configure it in ~/.config/calyx/config.json.`
    );
  }
  return result.path;
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

export { ENV_VARS, CONFIG_ENV_VAR, REGISTRY_DOMAINS, STORE_DOMAINS, ALL_DOMAINS };
