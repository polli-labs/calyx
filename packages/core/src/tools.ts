import { readFile } from "node:fs/promises";
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
  ToolsValidateResult
} from "./types";

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

function resolveSyncTarget(options: ToolsSyncOptions): string {
  if (options.host) {
    return `host:${options.host}`;
  }

  return options.all ? "all-hosts" : "all-hosts";
}

function buildSyncActions(tools: ToolRegistryEntry[], apply: boolean, target: string): DomainSyncAction[] {
  return tools.map((tool) => ({
    action: apply ? "sync" : "plan-sync",
    id: tool.name,
    details: `target=${target}`
  }));
}

export async function syncToolsRegistry(registryPath: string, options: ToolsSyncOptions = {}): Promise<ToolsSyncResult> {
  const apply = Boolean(options.apply);
  const indexed = await indexToolsRegistry(registryPath);
  const target = resolveSyncTarget(options);

  return {
    target,
    apply,
    version: indexed.version,
    actions: buildSyncActions(indexed.items, apply, target)
  };
}
