import { readFile } from "node:fs/promises";
import { z } from "zod";
import type {
  DomainSyncAction,
  DomainValidationIssue,
  SkillLifecycleStatus,
  SkillsIndexOptions,
  SkillsIndexResult,
  SkillsRegistry,
  SkillsSyncOptions,
  SkillsSyncResult,
  SkillsValidateOptions,
  SkillsValidateResult,
  SyncBackend
} from "./types";

const skillStatusSchema = z.enum(["active", "deprecated", "archived"]);

const skillSourceSchema = z
  .object({
    type: z.string().min(1),
    repo: z.string().min(1).optional(),
    path: z.string().min(1),
    ref: z.string().min(1).optional(),
    license: z.string().min(1).optional()
  })
  .passthrough();

const skillRegistryEntrySchema = z
  .object({
    id: z.string().min(1),
    status: skillStatusSchema.optional(),
    deprecated_by: z.string().min(1).optional(),
    archived_at: z.string().min(1).optional(),
    local_archive_path: z.string().min(1).optional(),
    source: skillSourceSchema
  })
  .passthrough();

const skillsRegistrySchema = z
  .object({
    version: z.string().min(1),
    generated_at: z.string().min(1).optional(),
    skills: z.array(skillRegistryEntrySchema)
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

function lifecycleStatus(entryStatus?: SkillLifecycleStatus): SkillLifecycleStatus {
  return entryStatus ?? "active";
}

async function loadSkillsRegistry(registryPath: string): Promise<SkillsRegistry> {
  let text = "";
  try {
    text = await readFile(registryPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read skills registry at ${registryPath}: ${message}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON at ${registryPath}: ${message}`);
  }

  const parsedRegistry = skillsRegistrySchema.safeParse(parsedJson);
  if (!parsedRegistry.success) {
    throw new Error(`Invalid skills registry schema at ${registryPath}: ${formatSchemaError(parsedRegistry.error)}`);
  }

  return parsedRegistry.data as SkillsRegistry;
}

function evaluateSkillsRegistry(registry: SkillsRegistry, options: SkillsValidateOptions = {}): SkillsValidateResult {
  const strict = options.strict ?? false;
  const errors: DomainValidationIssue[] = [];
  const warnings: DomainValidationIssue[] = [];

  const knownIds = new Set<string>();
  let active = 0;
  let deprecated = 0;
  let archived = 0;

  for (const [index, skill] of registry.skills.entries()) {
    const status = lifecycleStatus(skill.status);

    if (knownIds.has(skill.id)) {
      errors.push(toIssue("skills.duplicate-id", `Duplicate skill id "${skill.id}".`, `skills[${index}].id`));
    }
    knownIds.add(skill.id);

    if (status === "active") {
      active += 1;
    }
    if (status === "deprecated") {
      deprecated += 1;
      if (!skill.deprecated_by) {
        errors.push(
          toIssue(
            "skills.deprecated-missing-replacement",
            `Deprecated skill "${skill.id}" must set deprecated_by.`,
            `skills[${index}].deprecated_by`
          )
        );
      }
    }
    if (status === "archived") {
      archived += 1;
      if (!skill.archived_at) {
        const issue = toIssue(
          "skills.archived-missing-date",
          `Archived skill "${skill.id}" should set archived_at.`,
          `skills[${index}].archived_at`
        );
        if (strict) {
          errors.push(issue);
        } else {
          warnings.push(issue);
        }
      }
    }

    if (skill.deprecated_by && skill.deprecated_by === skill.id) {
      errors.push(
        toIssue(
          "skills.invalid-self-replacement",
          `Skill "${skill.id}" cannot deprecate to itself.`,
          `skills[${index}].deprecated_by`
        )
      );
    }

    if (skill.deprecated_by && status !== "deprecated") {
      warnings.push(
        toIssue(
          "skills.unexpected-replacement",
          `Skill "${skill.id}" sets deprecated_by without deprecated status.`,
          `skills[${index}].deprecated_by`
        )
      );
    }
  }

  for (const [index, skill] of registry.skills.entries()) {
    if (!skill.deprecated_by || !skill.deprecated_by.trim()) {
      continue;
    }

    if (!knownIds.has(skill.deprecated_by)) {
      const issue = toIssue(
        "skills.replacement-not-found",
        `Skill "${skill.id}" references missing replacement "${skill.deprecated_by}".`,
        `skills[${index}].deprecated_by`
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
    total: registry.skills.length,
    active,
    deprecated,
    archived
  };
}

function ensureValidOrThrow(validation: SkillsValidateResult, registryPath: string): void {
  if (validation.ok) {
    return;
  }

  const details = validation.errors
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("; ");
  throw new Error(`Skills registry validation failed at ${registryPath}: ${details}`);
}

export async function validateSkillsRegistry(
  registryPath: string,
  options: SkillsValidateOptions = {}
): Promise<SkillsValidateResult> {
  const registry = await loadSkillsRegistry(registryPath);
  return evaluateSkillsRegistry(registry, options);
}

export async function indexSkillsRegistry(
  registryPath: string,
  options: SkillsIndexOptions = {}
): Promise<SkillsIndexResult> {
  const includeActive = options.includeActive ?? true;
  const includeDeprecated = options.includeDeprecated ?? true;
  const includeArchived = options.includeArchived ?? false;

  const registry = await loadSkillsRegistry(registryPath);
  const validation = evaluateSkillsRegistry(registry, { strict: true });
  ensureValidOrThrow(validation, registryPath);

  const items = registry.skills.filter((skill) => {
    const status = lifecycleStatus(skill.status);
    if (status === "active") {
      return includeActive;
    }
    if (status === "deprecated") {
      return includeDeprecated;
    }
    return includeArchived;
  });

  return {
    version: registry.version,
    total: registry.skills.length,
    items
  };
}

export async function syncSkillsRegistry(registryPath: string, options: SkillsSyncOptions = {}): Promise<SkillsSyncResult> {
  const backend: SyncBackend = options.backend ?? "all";
  const apply = Boolean(options.apply);

  const indexed = await indexSkillsRegistry(registryPath, {
    ...(options.includeActive !== undefined ? { includeActive: options.includeActive } : {}),
    ...(options.includeDeprecated !== undefined ? { includeDeprecated: options.includeDeprecated } : {}),
    ...(options.includeArchived !== undefined ? { includeArchived: options.includeArchived } : {})
  });

  const actions: DomainSyncAction[] = [];
  for (const skill of indexed.items) {
    const status = lifecycleStatus(skill.status);
    if (options.pruneDeprecated && status === "deprecated") {
      actions.push({
        action: apply ? "prune" : "plan-prune",
        id: skill.id,
        details: "deprecated skill"
      });
      continue;
    }

    actions.push({
      action: apply ? "sync" : "plan-sync",
      id: skill.id,
      details: `backend=${backend}`
    });
  }

  return {
    backend,
    apply,
    version: indexed.version,
    actions
  };
}
