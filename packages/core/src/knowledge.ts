import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  DomainValidationIssue,
  KnowledgeIndexOptions,
  KnowledgeIndexResult,
  KnowledgeLinkOptions,
  KnowledgeLinkResult,
  KnowledgeRegistry,
  KnowledgeSearchOptions,
  KnowledgeSearchResult,
  KnowledgeValidateOptions,
  KnowledgeValidateResult,
  KnowledgeExecPlanNewOptions,
  KnowledgeExecPlanNewResult,
  DocstoreAdapterOptions,
  DocstoreAdapterResult
} from "./types";

const artifactKindSchema = z.enum(["execplan", "transcript", "report", "runbook", "reference"]);

const knowledgeArtifactEntrySchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    kind: artifactKindSchema,
    source_path: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
    linked_issues: z.array(z.string().min(1)).optional(),
    created_at: z.string().min(1).optional()
  })
  .passthrough();

const knowledgeRegistrySchema = z
  .object({
    version: z.string().min(1),
    artifacts: z.array(knowledgeArtifactEntrySchema)
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

async function loadKnowledgeRegistry(registryPath: string): Promise<KnowledgeRegistry> {
  let text = "";
  try {
    text = await readFile(registryPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read knowledge registry at ${registryPath}: ${message}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON at ${registryPath}: ${message}`);
  }

  const parsedRegistry = knowledgeRegistrySchema.safeParse(parsedJson);
  if (!parsedRegistry.success) {
    throw new Error(`Invalid knowledge registry schema at ${registryPath}: ${formatSchemaError(parsedRegistry.error)}`);
  }

  return parsedRegistry.data as KnowledgeRegistry;
}

function evaluateKnowledgeRegistry(
  registry: KnowledgeRegistry,
  options: KnowledgeValidateOptions = {}
): KnowledgeValidateResult {
  const strict = options.strict ?? false;
  const errors: DomainValidationIssue[] = [];
  const warnings: DomainValidationIssue[] = [];
  const knownIds = new Set<string>();

  for (const [index, artifact] of registry.artifacts.entries()) {
    if (knownIds.has(artifact.id)) {
      errors.push(
        toIssue("knowledge.duplicate-id", `Duplicate artifact id "${artifact.id}".`, `artifacts[${index}].id`)
      );
    }
    knownIds.add(artifact.id);

    if (artifact.tags) {
      const tagSet = new Set<string>();
      for (const tag of artifact.tags) {
        if (tagSet.has(tag)) {
          const issue = toIssue(
            "knowledge.duplicate-tag",
            `Artifact "${artifact.id}" has duplicate tag "${tag}".`,
            `artifacts[${index}].tags`
          );
          if (strict) {
            errors.push(issue);
          } else {
            warnings.push(issue);
          }
          break;
        }
        tagSet.add(tag);
      }
    }

    if (artifact.linked_issues) {
      const issueSet = new Set<string>();
      for (const issue of artifact.linked_issues) {
        if (issueSet.has(issue)) {
          errors.push(
            toIssue(
              "knowledge.duplicate-linked-issue",
              `Artifact "${artifact.id}" has duplicate linked issue "${issue}".`,
              `artifacts[${index}].linked_issues`
            )
          );
          break;
        }
        issueSet.add(issue);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    version: registry.version,
    total: registry.artifacts.length
  };
}

function ensureValidOrThrow(validation: KnowledgeValidateResult, registryPath: string): void {
  if (validation.ok) {
    return;
  }

  const details = validation.errors
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("; ");
  throw new Error(`Knowledge registry validation failed at ${registryPath}: ${details}`);
}

export async function validateKnowledgeRegistry(
  registryPath: string,
  options: KnowledgeValidateOptions = {}
): Promise<KnowledgeValidateResult> {
  const registry = await loadKnowledgeRegistry(registryPath);
  return evaluateKnowledgeRegistry(registry, options);
}

export async function indexKnowledgeRegistry(
  registryPath: string,
  options: KnowledgeIndexOptions = {}
): Promise<KnowledgeIndexResult> {
  const registry = await loadKnowledgeRegistry(registryPath);
  const validation = evaluateKnowledgeRegistry(registry, { strict: true });
  ensureValidOrThrow(validation, registryPath);

  let items = registry.artifacts;
  if (options.kind) {
    items = items.filter((artifact) => artifact.kind === options.kind);
  }

  return {
    version: registry.version,
    total: registry.artifacts.length,
    items
  };
}

export async function searchKnowledgeRegistry(
  registryPath: string,
  options: KnowledgeSearchOptions
): Promise<KnowledgeSearchResult> {
  const indexed = await indexKnowledgeRegistry(registryPath, {
    ...(options.kind ? { kind: options.kind } : {})
  });

  const queryLower = options.query.toLowerCase();
  const matchingItems = indexed.items.filter((artifact) => {
    if (artifact.title.toLowerCase().includes(queryLower)) {
      return true;
    }
    if (artifact.id.toLowerCase().includes(queryLower)) {
      return true;
    }
    if (artifact.tags?.some((tag) => tag.toLowerCase().includes(queryLower))) {
      return true;
    }
    if (artifact.linked_issues?.some((issue) => issue.toLowerCase().includes(queryLower))) {
      return true;
    }
    return false;
  });

  let results = matchingItems;
  if (options.tags && options.tags.length > 0) {
    results = results.filter(
      (artifact) => artifact.tags && options.tags!.every((tag) => artifact.tags!.includes(tag))
    );
  }

  return {
    query: options.query,
    total: results.length,
    items: results
  };
}

export async function linkKnowledgeArtifact(
  registryPath: string,
  options: KnowledgeLinkOptions
): Promise<KnowledgeLinkResult> {
  const indexed = await indexKnowledgeRegistry(registryPath);
  const artifact = indexed.items.find((a) => a.id === options.artifactId);

  if (!artifact) {
    throw new Error(`Artifact "${options.artifactId}" not found in knowledge registry at ${registryPath}.`);
  }

  const alreadyLinked = artifact.linked_issues?.includes(options.issueId) ?? false;
  const apply = Boolean(options.apply);

  return {
    artifactId: options.artifactId,
    issueId: options.issueId,
    apply,
    action: alreadyLinked ? "already-linked" : apply ? "link" : "plan-link"
  };
}

// ── ExecPlan new ────────────────────────────────────────────────────

/**
 * Create a new ExecPlan scaffold.
 *
 * In plan mode (default), returns the planned artifact without side
 * effects. In apply mode, writes the scaffold to the output path.
 */
export async function createExecPlan(
  options: KnowledgeExecPlanNewOptions
): Promise<KnowledgeExecPlanNewResult> {
  const id = `execplan-${options.issueId?.toLowerCase() ?? randomUUID().slice(0, 8)}`;
  const apply = Boolean(options.apply);

  if (apply && options.outPath) {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(options.outPath), { recursive: true });

    const scaffold = [
      `# ExecPlan ${id}`,
      "",
      `## Title`,
      options.title,
      "",
      `## Goal`,
      "(describe goal)",
      "",
      `## Scope`,
      "In scope:",
      "- ",
      "",
      "Out of scope:",
      "- ",
      "",
      `## Execution Plan`,
      "1. ",
      "",
      `## Acceptance Criteria`,
      "- ",
      "",
      `## Done / Next / Blocked`,
      "Done:",
      "- ",
      "",
      "Next:",
      "- ",
      "",
      "Blocked:",
      "- None",
      ""
    ].join("\n");
    await writeFile(options.outPath, scaffold);
  }

  return {
    id,
    title: options.title,
    ...(options.issueId ? { issueId: options.issueId } : {}),
    ...(options.outPath ? { outPath: options.outPath } : {}),
    apply,
    action: apply ? "create" : "plan-create"
  };
}

// ── Docstore adapter ────────────────────────────────────────────────

/**
 * Adapter for docstore CLI operations.
 *
 * Delegates to the `docstore` CLI via child_process when available,
 * returning structured results. Falls back to a descriptive error
 * if the docstore binary is not found.
 */
export async function docstoreAdapter(
  options: DocstoreAdapterOptions
): Promise<DocstoreAdapterResult> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const args: string[] = [options.verb];
  if (options.query) args.push(options.query);
  if (options.id) args.push(options.id);

  try {
    const { stdout } = await execFileAsync("docstore", args, {
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
    return {
      verb: options.verb,
      delegated: true,
      exitCode: 0,
      output: stdout.trim()
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exitCode = (err as { code?: number }).code ?? 1;
    return {
      verb: options.verb,
      delegated: false,
      exitCode: typeof exitCode === "number" ? exitCode : 1,
      output: `Docstore delegation failed: ${message}`
    };
  }
}
