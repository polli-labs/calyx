import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  DomainSyncAction,
  DomainValidationIssue,
  ToolRegistryEntry,
  ToolsIndexResult,
  ToolsRegistry,
  ToolsSyncOptions,
  ToolsSyncResult,
  ToolsValidateOptions,
  ToolsValidateResult,
  ToolVersionBumpOptions,
  ToolVersionBumpResult
} from "./types";
import {
  expandHomePath,
  pathExists,
  readHostsTruth,
  resolveAgentsInfraRoot,
  resolveCurrentHostAlias
} from "./agents-infra";

const VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+].+)?$/;

const toolRegistryEntrySchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    status: z.string().min(1).optional()
  })
  .passthrough();

const toolsRegistrySchema = z
  .object({
    version: z.string().min(1),
    tools: z.array(toolRegistryEntrySchema)
  })
  .passthrough();

interface ResolvedToolTarget {
  alias: string;
  configPath: string;
}

interface PreparedToolConfigMutation {
  targetPath: string;
  stagedDir: string;
  stagedPath: string;
  backupPath: string;
  hadExistingTarget: boolean;
  movedExistingTarget: boolean;
  wroteNewFile: boolean;
}

function toIssue(code: string, message: string, path?: string): DomainValidationIssue {
  return {
    code,
    message,
    ...(path ? { path } : {})
  };
}

function formatSchemaError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${at}: ${issue.message}`;
    })
    .join("; ");
}

async function loadToolsRegistry(registryPath: string): Promise<ToolsRegistry> {
  let text = "";
  try {
    text = await readFile(registryPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read tools registry at ${registryPath}: ${message}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON at ${registryPath}: ${message}`);
  }

  const parsedRegistry = toolsRegistrySchema.safeParse(parsedJson);
  if (!parsedRegistry.success) {
    throw new Error(`Invalid tools registry schema at ${registryPath}: ${formatSchemaError(parsedRegistry.error)}`);
  }

  return parsedRegistry.data as ToolsRegistry;
}

function evaluateToolsRegistry(registry: ToolsRegistry, options: ToolsValidateOptions = {}): ToolsValidateResult {
  const strict = options.strict ?? false;
  const errors: DomainValidationIssue[] = [];
  const warnings: DomainValidationIssue[] = [];
  const knownNames = new Set<string>();

  for (const [index, tool] of registry.tools.entries()) {
    if (knownNames.has(tool.name)) {
      errors.push(toIssue("tools.duplicate-name", `Duplicate tool name "${tool.name}".`, `tools[${index}].name`));
    }
    knownNames.add(tool.name);

    if (!VERSION_PATTERN.test(tool.version)) {
      const issue = toIssue(
        "tools.version-format",
        `Tool "${tool.name}" has non-semver version "${tool.version}".`,
        `tools[${index}].version`
      );
      if (strict) {
        errors.push(issue);
      } else {
        warnings.push(issue);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    version: registry.version,
    total: registry.tools.length
  };
}

function ensureValidOrThrow(validation: ToolsValidateResult, registryPath: string): void {
  if (validation.ok) {
    return;
  }

  const details = validation.errors
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("; ");
  throw new Error(`Tools registry validation failed at ${registryPath}: ${details}`);
}

export async function validateToolsRegistry(registryPath: string, options: ToolsValidateOptions = {}): Promise<ToolsValidateResult> {
  const registry = await loadToolsRegistry(registryPath);
  return evaluateToolsRegistry(registry, options);
}

export async function indexToolsRegistry(registryPath: string): Promise<ToolsIndexResult> {
  const registry = await loadToolsRegistry(registryPath);
  const validation = evaluateToolsRegistry(registry, { strict: true });
  ensureValidOrThrow(validation, registryPath);

  return {
    version: registry.version,
    total: registry.tools.length,
    items: registry.tools
  };
}

async function resolveSyncTarget(options: ToolsSyncOptions, agentsInfraRoot?: string): Promise<string> {
  if (options.host) {
    return `host:${options.host}`;
  }

  if (options.all) {
    return "all-hosts";
  }

  return `host:${await resolveCurrentHostAlias(undefined, agentsInfraRoot)}`;
}

function buildSyncActions(tools: ToolRegistryEntry[], apply: boolean, target: string): DomainSyncAction[] {
  return tools.map((tool) => ({
    action: apply ? "sync" : "plan-sync",
    id: tool.name,
    details: `target=${target}`
  }));
}

function renderAgentToolsConfig(version: string, tools: ToolRegistryEntry[]): string {
  const renderedTools: Record<string, Record<string, unknown>> = {};
  for (const tool of tools) {
    const { name, ...rest } = tool;
    renderedTools[name] = rest;
  }

  return `${JSON.stringify({ version, tools: renderedTools }, null, 2)}\n`;
}

function toolConfigPathForHome(homePath: string): string {
  return path.join(path.resolve(expandHomePath(homePath)), ".config", "polli", "agent-tools.json");
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  if (!(await pathExists(filePath))) {
    return undefined;
  }
  return readFile(filePath, "utf8");
}

async function stageToolConfigWrite(targetPath: string, content: string): Promise<PreparedToolConfigMutation> {
  const parentDir = path.dirname(targetPath);
  await mkdir(parentDir, { recursive: true });

  const stagedDir = await mkdtemp(path.join(parentDir, ".calyx-tool-stage-"));
  const stagedPath = path.join(stagedDir, path.basename(targetPath));
  try {
    await writeFile(stagedPath, content, "utf8");
    return {
      targetPath,
      stagedDir,
      stagedPath,
      backupPath: path.join(parentDir, `.calyx-tool-backup-${randomUUID()}.json`),
      hadExistingTarget: await pathExists(targetPath),
      movedExistingTarget: false,
      wroteNewFile: false
    };
  } catch (error) {
    if (await pathExists(stagedDir)) {
      await rm(stagedDir, { recursive: true, force: true });
    }
    throw error;
  }
}

async function cleanupPreparedToolMutations(preparedMutations: PreparedToolConfigMutation[]): Promise<void> {
  for (const preparedMutation of preparedMutations) {
    if (await pathExists(preparedMutation.stagedDir)) {
      await rm(preparedMutation.stagedDir, { recursive: true, force: true });
    }
    if (preparedMutation.movedExistingTarget && (await pathExists(preparedMutation.backupPath))) {
      await rm(preparedMutation.backupPath, { force: true });
    }
  }
}

async function commitPreparedToolMutations(preparedMutations: PreparedToolConfigMutation[]): Promise<void> {
  const committedMutations: PreparedToolConfigMutation[] = [];

  try {
    for (const preparedMutation of preparedMutations) {
      if (preparedMutation.hadExistingTarget) {
        await rename(preparedMutation.targetPath, preparedMutation.backupPath);
        preparedMutation.movedExistingTarget = true;
      }

      try {
        await rename(preparedMutation.stagedPath, preparedMutation.targetPath);
        preparedMutation.wroteNewFile = true;
        committedMutations.push(preparedMutation);
      } catch (error) {
        if (
          preparedMutation.movedExistingTarget &&
          !(await pathExists(preparedMutation.targetPath)) &&
          (await pathExists(preparedMutation.backupPath))
        ) {
          await rename(preparedMutation.backupPath, preparedMutation.targetPath).catch(() => undefined);
          preparedMutation.movedExistingTarget = false;
        }
        throw error;
      }
    }

    for (const preparedMutation of preparedMutations) {
      if (preparedMutation.movedExistingTarget && (await pathExists(preparedMutation.backupPath))) {
        await rm(preparedMutation.backupPath, { force: true });
        preparedMutation.movedExistingTarget = false;
      }
    }
  } catch (error) {
    for (const committedMutation of committedMutations.reverse()) {
      if (committedMutation.wroteNewFile && (await pathExists(committedMutation.targetPath))) {
        await rm(committedMutation.targetPath, { force: true });
        committedMutation.wroteNewFile = false;
      }
      if (committedMutation.movedExistingTarget && (await pathExists(committedMutation.backupPath))) {
        await rename(committedMutation.backupPath, committedMutation.targetPath).catch(() => undefined);
        committedMutation.movedExistingTarget = false;
      }
    }
    throw error;
  } finally {
    for (const preparedMutation of preparedMutations) {
      if (await pathExists(preparedMutation.stagedDir)) {
        await rm(preparedMutation.stagedDir, { recursive: true, force: true });
      }
      if (preparedMutation.movedExistingTarget && (await pathExists(preparedMutation.backupPath))) {
        await rm(preparedMutation.backupPath, { force: true });
      }
    }
  }
}

async function resolveToolTargets(
  options: ToolsSyncOptions,
  agentsInfraRoot?: string
): Promise<ResolvedToolTarget[]> {
  const currentAlias = await resolveCurrentHostAlias(undefined, agentsInfraRoot);
  const currentHome = path.resolve(homedir());

  const resolveHomeForAlias = async (alias: string): Promise<string> => {
    const hostsTruth = agentsInfraRoot ? await readHostsTruth(agentsInfraRoot) : {};
    const configuredHome = hostsTruth.hosts?.[alias]?.home;
    if (configuredHome && configuredHome.trim().length > 0) {
      return path.resolve(expandHomePath(configuredHome));
    }
    if (alias === currentAlias) {
      return currentHome;
    }
    throw new Error(`Unable to resolve home for tools sync target "${alias}".`);
  };

  if (options.host) {
    return [
      {
        alias: options.host,
        configPath: toolConfigPathForHome(await resolveHomeForAlias(options.host))
      }
    ];
  }

  if (options.all) {
    const hostsTruth = agentsInfraRoot ? await readHostsTruth(agentsInfraRoot) : {};
    const aliases = Object.keys(hostsTruth.hosts ?? {}).sort();
    if (aliases.length === 0) {
      throw new Error("Unable to resolve any hosts for tools sync --all; hosts truth is missing or empty.");
    }

    const resolvedTargets: ResolvedToolTarget[] = [];
    for (const alias of aliases) {
      resolvedTargets.push({
        alias,
        configPath: toolConfigPathForHome(await resolveHomeForAlias(alias))
      });
    }
    return resolvedTargets;
  }

  return [
    {
      alias: currentAlias,
      configPath: toolConfigPathForHome(currentHome)
    }
  ];
}

export async function syncToolsRegistry(registryPath: string, options: ToolsSyncOptions = {}): Promise<ToolsSyncResult> {
  const apply = Boolean(options.apply);
  const indexed = await indexToolsRegistry(registryPath);
  const agentsInfraRoot = await resolveAgentsInfraRoot({ registryPath });
  const target = await resolveSyncTarget(options, agentsInfraRoot);

  if (apply) {
    const desiredContent = renderAgentToolsConfig(indexed.version, indexed.items);
    const preparedMutations: PreparedToolConfigMutation[] = [];
    try {
      for (const resolvedTarget of await resolveToolTargets(options, agentsInfraRoot)) {
        const existingContent = await readTextIfExists(resolvedTarget.configPath);
        if (existingContent === desiredContent) {
          continue;
        }

        preparedMutations.push(await stageToolConfigWrite(resolvedTarget.configPath, desiredContent));
      }
    } catch (error) {
      await cleanupPreparedToolMutations(preparedMutations);
      throw error;
    }

    if (preparedMutations.length > 0) {
      await commitPreparedToolMutations(preparedMutations);
    }
  }

  return {
    target,
    apply,
    version: indexed.version,
    actions: buildSyncActions(indexed.items, apply, target)
  };
}

// ── Tools versions bump ─────────────────────────────────────────────

/**
 * Bump the version of a named tool in the registry.
 *
 * In plan mode (default), returns what would change without modifying
 * the registry file. In apply mode, writes the updated version back.
 */
export async function bumpToolVersion(
  registryPath: string,
  options: ToolVersionBumpOptions
): Promise<ToolVersionBumpResult> {
  const indexed = await indexToolsRegistry(registryPath);
  const tool = indexed.items.find((t) => t.name === options.tool);

  if (!tool) {
    return {
      tool: options.tool,
      from: undefined,
      to: options.to,
      apply: Boolean(options.apply),
      action: "not-found"
    };
  }

  const apply = Boolean(options.apply);
  const from = tool.version;

  if (apply) {
    const raw = await readFile(registryPath, "utf8");
    const registry = JSON.parse(raw) as ToolsRegistry;
    const entry = registry.tools.find((t) => t.name === options.tool);
    if (entry) {
      entry.version = options.to;
    }
    await writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n");
  }

  return {
    tool: options.tool,
    from,
    to: options.to,
    apply,
    action: apply ? "bump" : "plan-bump"
  };
}
