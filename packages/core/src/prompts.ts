import { readFile } from "node:fs/promises";
import { z } from "zod";
import type {
  DomainSyncAction,
  DomainValidationIssue,
  PromptBackend,
  PromptsIndexResult,
  PromptsRegistry,
  PromptsSyncOptions,
  PromptsSyncResult,
  PromptsValidateOptions,
  PromptsValidateResult
} from "./types";

const promptRegistryEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    category: z.string().min(1),
    template_path: z.string().min(1),
    variables: z.array(z.string().min(1)),
    optional_variables: z.array(z.string().min(1)).optional(),
    targets: z.array(z.string().min(1)),
    exported_as_slash_command: z.boolean().optional()
  })
  .passthrough();

const promptsRegistrySchema = z
  .object({
    version: z.string().min(1),
    schema_version: z.string().min(1).optional(),
    prompts: z.array(promptRegistryEntrySchema)
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

async function loadPromptsRegistry(registryPath: string): Promise<PromptsRegistry> {
  let text = "";
  try {
    text = await readFile(registryPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read prompts registry at ${registryPath}: ${message}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON at ${registryPath}: ${message}`);
  }

  const parsedRegistry = promptsRegistrySchema.safeParse(parsedJson);
  if (!parsedRegistry.success) {
    throw new Error(`Invalid prompts registry schema at ${registryPath}: ${formatSchemaError(parsedRegistry.error)}`);
  }

  return parsedRegistry.data as PromptsRegistry;
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }

  return [...duplicates].sort();
}

function evaluatePromptsRegistry(registry: PromptsRegistry, options: PromptsValidateOptions = {}): PromptsValidateResult {
  const strict = options.strict ?? false;
  const errors: DomainValidationIssue[] = [];
  const warnings: DomainValidationIssue[] = [];
  const knownIds = new Set<string>();

  for (const [index, prompt] of registry.prompts.entries()) {
    if (knownIds.has(prompt.id)) {
      errors.push(toIssue("prompts.duplicate-id", `Duplicate prompt id "${prompt.id}".`, `prompts[${index}].id`));
    }
    knownIds.add(prompt.id);

    const variableDuplicates = duplicateValues(prompt.variables);
    if (variableDuplicates.length > 0) {
      errors.push(
        toIssue(
          "prompts.duplicate-required-variable",
          `Prompt "${prompt.id}" has duplicate required variables: ${variableDuplicates.join(", ")}.`,
          `prompts[${index}].variables`
        )
      );
    }

    const optionalVariables = prompt.optional_variables ?? [];
    const optionalDuplicates = duplicateValues(optionalVariables);
    if (optionalDuplicates.length > 0) {
      errors.push(
        toIssue(
          "prompts.duplicate-optional-variable",
          `Prompt "${prompt.id}" has duplicate optional variables: ${optionalDuplicates.join(", ")}.`,
          `prompts[${index}].optional_variables`
        )
      );
    }

    const overlap = prompt.variables.filter((variable) => optionalVariables.includes(variable));
    if (overlap.length > 0) {
      const issue = toIssue(
        "prompts.variable-overlap",
        `Prompt "${prompt.id}" repeats variables in required and optional sets: ${overlap.join(", ")}.`,
        `prompts[${index}]`
      );
      if (strict) {
        errors.push(issue);
      } else {
        warnings.push(issue);
      }
    }

    if (prompt.targets.length === 0) {
      errors.push(
        toIssue("prompts.targets-empty", `Prompt "${prompt.id}" must declare at least one target.`, `prompts[${index}].targets`)
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    version: registry.version,
    total: registry.prompts.length
  };
}

function ensureValidOrThrow(validation: PromptsValidateResult, registryPath: string): void {
  if (validation.ok) {
    return;
  }

  const details = validation.errors
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("; ");
  throw new Error(`Prompts registry validation failed at ${registryPath}: ${details}`);
}

export async function validatePromptsRegistry(
  registryPath: string,
  options: PromptsValidateOptions = {}
): Promise<PromptsValidateResult> {
  const registry = await loadPromptsRegistry(registryPath);
  return evaluatePromptsRegistry(registry, options);
}

export async function indexPromptsRegistry(registryPath: string): Promise<PromptsIndexResult> {
  const registry = await loadPromptsRegistry(registryPath);
  const validation = evaluatePromptsRegistry(registry, { strict: true });
  ensureValidOrThrow(validation, registryPath);

  return {
    version: registry.version,
    total: registry.prompts.length,
    items: registry.prompts
  };
}

export async function syncPromptsRegistry(
  registryPath: string,
  options: PromptsSyncOptions = {}
): Promise<PromptsSyncResult> {
  const backend: PromptBackend = options.backend ?? "all";
  const apply = Boolean(options.apply);
  const indexed = await indexPromptsRegistry(registryPath);

  const actions: DomainSyncAction[] = indexed.items.map((prompt) => ({
    action: apply ? "sync" : "plan-sync",
    id: prompt.id,
    details: `backend=${backend}`
  }));

  return {
    backend,
    apply,
    version: indexed.version,
    actions
  };
}
