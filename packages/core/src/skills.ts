import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  CodexSkillsSyncMode,
  DomainSyncAction,
  DomainValidationIssue,
  ProvenanceClass,
  SkillLifecycleStatus,
  SkillRegistryEntry,
  SkillSource,
  SkillsIndexOptions,
  SkillsIndexResult,
  SkillsRegistry,
  SkillsSyncOptions,
  SkillsSyncResult,
  SkillsValidateOptions,
  SkillsValidateResult,
  SyncBackend
} from "./types";
import { pathExists, resolveAgentsInfraRoot, resolveRepoClone } from "./agents-infra";
import {
  type PreparedInstallationMutation,
  type SkillBackend,
  buildExpectedInstallTree,
  cleanupPreparedInstallationMutations,
  commitPreparedInstallationMutations,
  compareFileMaps,
  preparePruneMutations,
  readInstallationTree,
  resolveSkillInstallDir,
  stageInstallationTree
} from "./skills-install";

const skillStatusSchema = z.enum(["active", "deprecated", "archived", "retired"]);

const skillSourceSchema = z
  .object({
    type: z.string().min(1),
    repo: z.string().min(1).optional(),
    path: z.string().min(1),
    ref: z.string().min(1).optional(),
    license: z.string().min(1).optional(),
    regime: z.enum(["git", "db"]).optional()
  })
  .passthrough();

const skillRegistryEntrySchema = z
  .object({
    id: z.string().min(1),
    status: skillStatusSchema.optional(),
    deprecated_by: z.string().min(1).optional(),
    archived_at: z.string().min(1).optional(),
    retired_at: z.string().min(1).optional(),
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

function lifecycleStatus(entry: Pick<SkillRegistryEntry, "status"> & { deprecated?: unknown }): SkillLifecycleStatus {
  if (entry.status) {
    return entry.status;
  }

  return entry.deprecated === true ? "deprecated" : "active";
}

/**
 * Derive the provenance class of a skill from its registry source.
 * Total over the three documented source.type values; returns undefined for
 * unknown/free-form types (surfaced as "unclassified" rather than mis-bucketed).
 * Source-of-truth taxonomy is documented in SOURCES.json schema_notes.source_types.
 */
export function deriveProvenanceClass(source: SkillSource): ProvenanceClass | undefined {
  switch (source.type.trim().toLowerCase()) {
    case "internal":
      return "repo-managed";
    case "external":
      return "vendored";
    case "repo-maintained":
      return "repo-maintained";
    default:
      return undefined;
  }
}

/**
 * Resolve a skill's current source-of-truth regime (POL-1729 Slice 2).
 * Absent `source.regime` ⇒ `git` (backward-compatible default). A `db` regime
 * means the agent-owned DB owns the content and the re-materializer — not
 * `calyx skills sync` — renders its mirrors.
 *
 * ORTHOGONAL to {@link deriveProvenanceClass}: provenance_class describes origin
 * (repo-managed/vendored/repo-maintained from source.type); regime describes the
 * current source-of-truth (git|db). A migrated first-party skill keeps
 * provenance_class `repo-managed` but gets `regime: db`.
 */
export function resolveSkillRegime(source: SkillSource): "git" | "db" {
  return source.regime === "db" ? "db" : "git";
}

export async function resolveSkillSourcePath(
  entry: SkillRegistryEntry,
  agentsInfraRoot?: string
): Promise<string | undefined> {
  const sourceType = entry.source.type.trim().toLowerCase();

  if (sourceType === "internal") {
    if (!agentsInfraRoot) {
      return undefined;
    }
    const resolvedSkillPath = path.resolve(agentsInfraRoot, entry.source.path);
    return resolvedSkillPath.endsWith(".md") ? resolvedSkillPath : path.join(resolvedSkillPath, "SKILL.md");
  }

  if ((sourceType === "repo-maintained" || sourceType === "external") && entry.source.repo) {
    const repoId =
      sourceType === "external"
        ? entry.source.repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "")
        : entry.source.repo;
    const cloneRoot = repoId.includes("/") ? await resolveRepoClone(repoId) : undefined;
    if (!cloneRoot) {
      return undefined;
    }
    const resolvedSkillPath = path.resolve(cloneRoot, entry.source.path);
    return resolvedSkillPath.endsWith(".md") ? resolvedSkillPath : path.join(resolvedSkillPath, "SKILL.md");
  }

  return undefined;
}

export function syncBackends(backend: SyncBackend, codexMode: CodexSkillsSyncMode): SkillBackend[] {
  const requestedBackends: SkillBackend[] = backend === "all" ? ["agents", "claude", "codex"] : [backend];
  const resolvedBackends: SkillBackend[] = [];

  for (const requestedBackend of requestedBackends) {
    const resolvedBackend =
      requestedBackend === "codex" && codexMode === "alias-agents" ? "agents" : requestedBackend;
    if (!resolvedBackends.includes(resolvedBackend)) {
      resolvedBackends.push(resolvedBackend);
    }
  }

  return resolvedBackends;
}

function formatSyncBackendDetails(backend: SyncBackend, codexMode: CodexSkillsSyncMode): string {
  if (codexMode === "native" || (backend !== "codex" && backend !== "all")) {
    return `backend=${backend}`;
  }

  if (backend === "codex") {
    return "backend=codex(alias=agents)";
  }

  return `backend=${backend}(codex=agents)`;
}

async function prepareSkillSyncMutations(
  targetBackends: SkillBackend[],
  entry: SkillRegistryEntry,
  skillPath: string
): Promise<PreparedInstallationMutation[]> {
  const preparedMutations: PreparedInstallationMutation[] = [];

  try {
    for (const targetBackend of targetBackends) {
      const installDir = resolveSkillInstallDir(targetBackend, entry.id);
      const expectedFiles = await buildExpectedInstallTree(targetBackend, entry.id, skillPath);
      const liveFiles = await readInstallationTree(installDir);
      if (compareFileMaps(expectedFiles, liveFiles)) {
        continue;
      }

      preparedMutations.push(await stageInstallationTree(installDir, expectedFiles));
    }
  } catch (error) {
    await cleanupPreparedInstallationMutations(preparedMutations);
    throw error;
  }

  return preparedMutations;
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

/**
 * Read a skills registry without enforcing the strict lifecycle schema. Used by
 * read-only surfaces (e.g. the curator report) that must tolerate registries
 * with pre-existing validation errors rather than refusing to run.
 */
export async function loadSkillsRegistryLoose(registryPath: string): Promise<SkillsRegistry> {
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

  if (!parsedJson || typeof parsedJson !== "object" || Array.isArray(parsedJson)) {
    throw new Error(`Invalid skills registry at ${registryPath}: expected an object.`);
  }

  const version = (parsedJson as { version?: unknown }).version;
  const skills = (parsedJson as { skills?: unknown }).skills;
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error(`Invalid skills registry at ${registryPath}: missing version.`);
  }
  if (!Array.isArray(skills)) {
    throw new Error(`Invalid skills registry at ${registryPath}: missing skills array.`);
  }

  return {
    version,
    skills: skills as SkillRegistryEntry[],
  };
}

function evaluateSkillsRegistry(registry: SkillsRegistry, options: SkillsValidateOptions = {}): SkillsValidateResult {
  const strict = options.strict ?? false;
  const errors: DomainValidationIssue[] = [];
  const warnings: DomainValidationIssue[] = [];

  const knownIds = new Set<string>();
  let active = 0;
  let deprecated = 0;
  let archived = 0;
  let retired = 0;

  for (const [index, skill] of registry.skills.entries()) {
    const status = lifecycleStatus(skill);

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
    if (status === "retired") {
      retired += 1;
      if (!skill.retired_at) {
        const issue = toIssue(
          "skills.retired-missing-date",
          `Retired skill "${skill.id}" should set retired_at.`,
          `skills[${index}].retired_at`
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

    if (skill.deprecated_by && status !== "deprecated" && status !== "retired") {
      warnings.push(
        toIssue(
          "skills.unexpected-replacement",
          `Skill "${skill.id}" sets deprecated_by without deprecated or retired status.`,
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
    archived,
    retired
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
  const includeRetired = options.includeRetired ?? false;

  const registry = await loadSkillsRegistry(registryPath);
  const validation = evaluateSkillsRegistry(registry, { strict: true });
  ensureValidOrThrow(validation, registryPath);

  const items = registry.skills.filter((skill) => {
    const status = lifecycleStatus(skill);
    if (status === "active") {
      return includeActive;
    }
    if (status === "deprecated") {
      return includeDeprecated;
    }
    if (status === "retired") {
      return includeRetired;
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
  const codexMode = options.codexMode ?? "alias-agents";
  const targetBackends = syncBackends(backend, codexMode);
  const backendDetails = formatSyncBackendDetails(backend, codexMode);
  const includeRetired = options.pruneDeprecated ? true : options.includeRetired;

  const indexed = await indexSkillsRegistry(registryPath, {
    ...(options.includeActive !== undefined ? { includeActive: options.includeActive } : {}),
    ...(options.includeDeprecated !== undefined ? { includeDeprecated: options.includeDeprecated } : {}),
    ...(options.includeArchived !== undefined ? { includeArchived: options.includeArchived } : {}),
    ...(includeRetired !== undefined ? { includeRetired } : {})
  });

  const actions: DomainSyncAction[] = [];
  const preparedMutations: PreparedInstallationMutation[] = [];
  const agentsInfraRoot = apply ? await resolveAgentsInfraRoot({ registryPath }) : undefined;
  try {
    for (const skill of indexed.items) {
      const status = lifecycleStatus(skill);
      if (options.pruneDeprecated && (status === "deprecated" || status === "retired")) {
        actions.push({
          action: apply ? "prune" : "plan-prune",
          id: skill.id,
          details: `${status} skill`
        });

        if (apply) {
          for (const targetBackend of targetBackends) {
            preparedMutations.push(...(await preparePruneMutations(targetBackend, skill.id)));
          }
        }
        continue;
      }

      // Contract #8 (git-shadows-db / no-cross-regime-clobber): a db-regime
      // skill is owned by the Slice-1 re-materializer, NOT by git sync. Skip it
      // entirely so `calyx skills sync` never clobbers an agent-owned mirror.
      if (resolveSkillRegime(skill.source) === "db") {
        actions.push({
          action: apply ? "skip" : "plan-skip",
          id: skill.id,
          details: "db-regime (re-materializer-owned)"
        });
        continue;
      }

      const sourceType = skill.source.type.trim().toLowerCase();
      const canSkipUnresolvableSource = sourceType === "external" || sourceType === "repo-maintained";
      const resolvedRepoBackedSkillPath =
        canSkipUnresolvableSource ? await resolveSkillSourcePath(skill, agentsInfraRoot) : undefined;
      const hasResolvableRepoBackedSource =
        canSkipUnresolvableSource && resolvedRepoBackedSkillPath
          ? await pathExists(resolvedRepoBackedSkillPath)
          : false;

      if (canSkipUnresolvableSource && !hasResolvableRepoBackedSource) {
        actions.push({
          action: apply ? "skip" : "plan-skip",
          id: skill.id,
          details: `unresolvable source type=${sourceType}`
        });
        continue;
      }

      actions.push({
        action: apply ? "sync" : "plan-sync",
        id: skill.id,
        details: backendDetails
      });

      if (!apply) {
        continue;
      }

      const skillPath = resolvedRepoBackedSkillPath ?? (await resolveSkillSourcePath(skill, agentsInfraRoot));
      if (!skillPath || !(await pathExists(skillPath))) {
        throw new Error(
          `Unable to resolve source for skill "${skill.id}" (type=${skill.source.type}, path=${skill.source.path}).`
        );
      }

      preparedMutations.push(...(await prepareSkillSyncMutations(targetBackends, skill, skillPath)));
    }
  } catch (error) {
    await cleanupPreparedInstallationMutations(preparedMutations);
    throw error;
  }

  if (apply && preparedMutations.length > 0) {
    await commitPreparedInstallationMutations(preparedMutations);
  }

  return {
    backend,
    apply,
    version: indexed.version,
    actions
  };
}
