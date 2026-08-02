import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type {
  DomainValidationIssue,
  KnowledgeArtifactEntry,
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
  KnowledgeExecPlanPromoteOptions,
  KnowledgeExecPlanPromoteResult,
  DocstoreAdapterOptions,
  DocstoreAdapterResult
} from "./types";
import { getPrimaryExecPlanIssue } from "./execplan-metadata";
import { putVaultArtifact } from "./vault";

const artifactKindSchema = z.enum(["execplan", "transcript", "report", "runbook", "reference"]);

interface KnowledgeError extends Error {
  exitCode?: number;
}

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

function createKnowledgeError(message: string, exitCode: number): KnowledgeError {
  const error = new Error(message) as KnowledgeError;
  error.exitCode = exitCode;
  return error;
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

interface SearchTerm {
  field?: string;
  value: string;
}

type SearchIndex = Map<string, string[]>;

function normalizeSearchValue(value: string): string {
  return value.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenPrimitiveValues(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenPrimitiveValues(entry));
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap((entry) => flattenPrimitiveValues(entry));
  }
  return [];
}

interface FlattenedFieldValue {
  path: string;
  value: string;
}

function flattenFieldEntries(value: unknown, prefix = ""): FlattenedFieldValue[] {
  if (!isRecord(value)) {
    return [];
  }

  const entries: FlattenedFieldValue[] = [];
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (nested === undefined || nested === null) {
      continue;
    }
    if (typeof nested === "string" || typeof nested === "number" || typeof nested === "boolean") {
      entries.push({ path, value: String(nested) });
      continue;
    }
    if (Array.isArray(nested)) {
      for (const leafValue of flattenPrimitiveValues(nested)) {
        entries.push({ path, value: leafValue });
      }
      continue;
    }
    entries.push(...flattenFieldEntries(nested, path));
  }

  return entries;
}

function splitSearchQuery(query: string): SearchTerm[] {
  const rawTokens = query.match(/"[^"]+"|\S+/g) ?? [];
  const terms: SearchTerm[] = [];

  for (const rawToken of rawTokens) {
    const token = rawToken.startsWith("\"") && rawToken.endsWith("\"")
      ? rawToken.slice(1, -1)
      : rawToken;
    const normalizedToken = normalizeSearchValue(token);
    if (!normalizedToken) {
      continue;
    }

    const separatorIndex = normalizedToken.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex >= normalizedToken.length - 1) {
      terms.push({ value: normalizedToken });
      continue;
    }

    const rawField = normalizedToken.slice(0, separatorIndex);
    const rawValue = normalizedToken.slice(separatorIndex + 1);
    if (!rawField || !rawValue) {
      terms.push({ value: normalizedToken });
      continue;
    }

    terms.push({ field: normalizeSearchField(rawField), value: rawValue });
  }

  return terms;
}

function normalizeSearchField(field: string): string {
  switch (field) {
    case "source":
      return "source_path";
    case "issue":
    case "issues":
      return "linked_issues";
    case "tag":
      return "tags";
    case "created":
      return "created_at";
    default:
      return field;
  }
}

function pushSearchIndexValue(index: SearchIndex, field: string, value: unknown): void {
  const normalizedField = normalizeSearchField(field);
  if (!normalizedField) {
    return;
  }

  const normalizedValues = flattenPrimitiveValues(value)
    .map((entry) => normalizeSearchValue(entry))
    .filter((entry) => entry.length > 0);
  if (normalizedValues.length === 0) {
    return;
  }

  const existing = index.get(normalizedField) ?? [];
  existing.push(...normalizedValues);
  index.set(normalizedField, existing);
}

function buildSearchIndex(artifact: KnowledgeArtifactEntry): SearchIndex {
  const index: SearchIndex = new Map<string, string[]>();
  pushSearchIndexValue(index, "id", artifact.id);
  pushSearchIndexValue(index, "title", artifact.title);
  pushSearchIndexValue(index, "kind", artifact.kind);
  pushSearchIndexValue(index, "source_path", artifact.source_path);
  pushSearchIndexValue(index, "path", artifact.source_path);
  pushSearchIndexValue(index, "created_at", artifact.created_at);
  pushSearchIndexValue(index, "tags", artifact.tags);
  pushSearchIndexValue(index, "linked_issues", artifact.linked_issues);

  const metadataEntries = flattenFieldEntries(artifact["metadata"]);
  for (const entry of metadataEntries) {
    pushSearchIndexValue(index, "metadata", entry.value);
    pushSearchIndexValue(index, "meta", entry.value);
    pushSearchIndexValue(index, `metadata.${entry.path}`, entry.value);
    pushSearchIndexValue(index, `meta.${entry.path}`, entry.value);

    const [topLevelKey] = entry.path.split(".");
    if (topLevelKey) {
      pushSearchIndexValue(index, `metadata.${topLevelKey}`, entry.value);
      pushSearchIndexValue(index, `meta.${topLevelKey}`, entry.value);
    }
  }

  const frontmatterEntries = flattenFieldEntries(artifact["frontmatter"]);
  for (const entry of frontmatterEntries) {
    pushSearchIndexValue(index, "frontmatter", entry.value);
    pushSearchIndexValue(index, "fm", entry.value);
    pushSearchIndexValue(index, `frontmatter.${entry.path}`, entry.value);
    pushSearchIndexValue(index, `fm.${entry.path}`, entry.value);

    const [topLevelKey] = entry.path.split(".");
    if (topLevelKey) {
      // Top-level frontmatter keys (doc_type, scope, owner, etc.) are first-class selectors.
      pushSearchIndexValue(index, topLevelKey, entry.value);
    }
  }

  return index;
}

function getAllSearchValues(index: SearchIndex): string[] {
  const values: string[] = [];
  for (const entries of index.values()) {
    values.push(...entries);
  }
  return values;
}

function matchesSearchTerm(index: SearchIndex, term: SearchTerm): boolean {
  const value = normalizeSearchValue(term.value);
  if (!value) {
    return true;
  }

  if (term.field) {
    const values = index.get(term.field) ?? [];
    return values.some((entry) => entry.includes(value));
  }

  return getAllSearchValues(index).some((entry) => entry.includes(value));
}

function parseTagsFilter(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) {
    return [];
  }
  return tags
    .map((tag) => normalizeSearchValue(tag))
    .filter((tag) => tag.length > 0);
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

  const queryTerms = splitSearchQuery(options.query);
  let results = indexed.items.filter((artifact) => {
    const index = buildSearchIndex(artifact);
    return queryTerms.every((term) => matchesSearchTerm(index, term));
  });

  const normalizedTags = parseTagsFilter(options.tags);
  if (normalizedTags.length > 0) {
    results = results.filter((artifact) => {
      const artifactTags = parseTagsFilter(artifact.tags);
      return normalizedTags.every((tag) => artifactTags.includes(tag));
    });
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

function slugifyExecPlanPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function deriveExecPlanId(title: string, issueId?: string): string {
  const normalizedIssue = issueId?.trim().toLowerCase();
  if (normalizedIssue) {
    return `execplan-${normalizedIssue}`;
  }

  const titleSlug = slugifyExecPlanPart(title);
  return titleSlug ? `execplan-${titleSlug}` : `execplan-${randomUUID().slice(0, 8)}`;
}

function renderExecPlanScaffold(options: KnowledgeExecPlanNewOptions, id: string): string {
  const now = new Date().toISOString();
  const kind = options.kind ?? "implementation";
  const state = options.state ?? "draft";
  const owner = options.owner ?? "polli-labs";
  const scope = options.scope ?? "repo";
  const targetHosts = options.targetHosts?.filter((value) => value.trim()).map((value) => value.trim()) ?? [];
  const runnerHarness = options.runnerHarness ?? "codex-cli";
  const runnerMode = options.runnerMode ?? "interactive";

  const frontmatter = {
    title: options.title,
    doc_type: "execplan",
    status: "active",
    owner,
    last_modified: now,
    last_reviewed: now,
    scope,
    execplan: {
      id,
      kind,
      state,
      linear: {
        issues: options.issueId ? [options.issueId] : [],
      },
      target: {
        ...(options.targetRepo ? { repo: options.targetRepo } : {}),
        ...(options.targetBranch ? { branch: options.targetBranch } : {}),
        ...(options.targetWorkdir ? { workdir: options.targetWorkdir } : {}),
        hosts: targetHosts,
      },
      runner: {
        harness: runnerHarness,
        mode: runnerMode,
      },
    },
  };

  const contextLines = [
    options.issueId ? `- Linked issue: ${options.issueId}` : "- Linked issue: (add issue if applicable)",
    options.targetRepo ? `- Target repo: ${options.targetRepo}` : "- Target repo: (fill in repo)",
    options.targetBranch ? `- Target branch: ${options.targetBranch}` : "- Target branch: (fill in branch)",
    options.targetWorkdir ? `- Target workdir: ${options.targetWorkdir}` : "- Target workdir: (fill in workdir)",
    targetHosts.length > 0 ? `- Target hosts: ${targetHosts.join(", ")}` : "- Target hosts: (fill in host list)",
  ];

  const scaffold = [
    "---",
    YAML.stringify(frontmatter).trimEnd(),
    "---",
    "",
    `# ${options.title}`,
    "",
    "## Goal",
    "Describe the concrete outcome this ExecPlan should deliver.",
    "",
    "## Context",
    ...contextLines,
    "- Relevant prior plans, reports, or receipts: ",
    "",
    "## Scope",
    "In scope:",
    "- ",
    "",
    "Out of scope:",
    "- ",
    "",
    "Constraints:",
    "- ",
    "",
    "## Prereqs",
    "- Verify repo, branch, host, and secrets assumptions before execution.",
    "- Add any setup commands or env requirements here.",
    "",
    "## Plan (ordered)",
    "1. Scope and ground the change.",
    "   Verification:",
    "   - ",
    "2. Implement the bounded slice.",
    "   Verification:",
    "   - ",
    "3. Run final verification and leave receipts.",
    "   Verification:",
    "   - ",
    "",
    "## Log requirements",
    "- Post start and finish receipts to the relevant coordination surface.",
    "- Update the linked issue with Done / Next / Blocked.",
    "- Append execution receipts below during or after execution.",
    "",
    "## Execution receipts",
    "### <timestamp> (<host>)",
    "- state:",
    "- issue:",
    "- pr:",
    "- branch:",
    "- commit:",
    "- notes:",
    "",
  ].join("\n");

  return scaffold;
}

interface ParsedExecPlanDraft {
  frontmatter: Record<string, unknown>;
  body: string;
}

function extractPromoteTitle(rawBody: string, parsedFrontmatter: Record<string, unknown>, sourcePath: string): string {
  const frontmatterTitle = parsedFrontmatter["title"];
  if (typeof frontmatterTitle === "string" && frontmatterTitle.trim()) {
    return frontmatterTitle.trim();
  }

  const headingMatch = rawBody.match(/^#\s+(.+?)\s*$/m);
  if (headingMatch?.[1]?.trim()) {
    return headingMatch[1].trim();
  }

  return path.basename(sourcePath, path.extname(sourcePath));
}

function parseDraftInput(raw: string, sourcePath: string): ParsedExecPlanDraft {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return {
      frontmatter: {},
      body: raw,
    };
  }

  try {
    const parsed = YAML.parse(match[1] ?? "");
    if (parsed == null) {
      return {
        frontmatter: {},
        body: raw.slice(match[0].length),
      };
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("frontmatter must be a mapping");
    }
    return {
      frontmatter: parsed as Record<string, unknown>,
      body: raw.slice(match[0].length),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createKnowledgeError(`[knowledge execplan promote] failed to parse frontmatter in ${sourcePath}: ${message}`, 2);
  }
}

function assertPromotableExecPlan(frontmatter: Record<string, unknown>, sourcePath: string): void {
  const execplan = frontmatter["execplan"];
  if (!execplan || typeof execplan !== "object" || Array.isArray(execplan)) {
    throw createKnowledgeError(
      `[knowledge execplan promote] ${sourcePath} is not a compatible ExecPlan draft: missing execplan metadata.`,
      2,
    );
  }

  const execplanRecord = execplan as Record<string, unknown>;
  const id = execplanRecord["id"];
  const kind = execplanRecord["kind"];
  const state = execplanRecord["state"];

  if (typeof id !== "string" || !id.trim() || typeof kind !== "string" || !kind.trim() || typeof state !== "string" || !state.trim()) {
    throw createKnowledgeError(
      `[knowledge execplan promote] ${sourcePath} is not a compatible ExecPlan draft: expected execplan.id, execplan.kind, and execplan.state.`,
      2,
    );
  }
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

function applyTitleToBody(body: string, title: string): string {
  const headingPattern = /^#\s+.+?$/m;
  if (headingPattern.test(body)) {
    return body.replace(headingPattern, `# ${title}`);
  }
  return `# ${title}\n\n${body.trimStart()}`;
}

function normalizePromotedDraft(
  draft: ParsedExecPlanDraft,
  sourcePath: string,
  overrides: { title?: string; issueId?: string },
): ParsedExecPlanDraft & { title: string; issueId?: string } {
  assertPromotableExecPlan(draft.frontmatter, sourcePath);

  const sourceFrontmatter = draft.frontmatter;
  const frontmatter: Record<string, unknown> = {};
  for (const key of ["doc_type", "owner", "last_modified", "last_reviewed", "scope"] as const) {
    if (Object.hasOwn(sourceFrontmatter, key)) {
      frontmatter[key] = sourceFrontmatter[key];
    }
  }

  const execplanRecord = cloneRecord(sourceFrontmatter["execplan"] as Record<string, unknown>);
  const linearRecord = typeof execplanRecord["linear"] === "object" && !Array.isArray(execplanRecord["linear"])
    ? cloneRecord(execplanRecord["linear"] as Record<string, unknown>)
    : {};

  const title = overrides.title ?? extractPromoteTitle(draft.body, sourceFrontmatter, sourcePath);
  const issueId = overrides.issueId ?? getPrimaryExecPlanIssue(sourceFrontmatter);

  frontmatter["title"] = title;
  const body = applyTitleToBody(draft.body, title);

  if (issueId) {
    frontmatter["issue"] = issueId;
    linearRecord["issues"] = [issueId];
    execplanRecord["linear"] = linearRecord;
  }

  frontmatter["execplan"] = execplanRecord;

  return {
    frontmatter,
    body,
    title,
    ...(issueId ? { issueId } : {}),
  };
}

/**
 * Create a new ExecPlan scaffold.
 *
 * In plan mode (default), returns the planned artifact without side
 * effects. In apply mode, writes the scaffold to the output path.
 */
export async function createExecPlan(
  options: KnowledgeExecPlanNewOptions
): Promise<KnowledgeExecPlanNewResult> {
  const id = deriveExecPlanId(options.title, options.issueId);
  const apply = Boolean(options.apply);
  const content = renderExecPlanScaffold(options, id);
  const resolvedOutPath = apply ? path.resolve(options.outPath ?? `${id}.md`) : options.outPath;

  if (apply && resolvedOutPath) {
    await mkdir(path.dirname(resolvedOutPath), { recursive: true });
    try {
      await access(resolvedOutPath);
      throw createKnowledgeError(
        `[knowledge execplan new] file already exists: ${resolvedOutPath}\nUse a different title or --out-path, or edit the existing ExecPlan directly.`,
        1,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await writeFile(resolvedOutPath, content, "utf8");
  }

  return {
    id,
    title: options.title,
    ...(options.issueId ? { issueId: options.issueId } : {}),
    kind: options.kind ?? "implementation",
    state: options.state ?? "draft",
    ...(resolvedOutPath ? { outPath: resolvedOutPath } : {}),
    content,
    apply,
    action: apply ? "create" : "plan-create"
  };
}

/**
 * Promote a scaffold or compatible draft into the fieldwork continuity plane.
 *
 * Promotion keeps canonical ExecPlan metadata intact while adding the
 * fieldwork-facing note metadata required for vault routing and coordination.
 */
export async function promoteExecPlan(
  options: KnowledgeExecPlanPromoteOptions,
): Promise<KnowledgeExecPlanPromoteResult> {
  const inputPath = path.resolve(options.inputPath);
  let raw: string;
  try {
    raw = await readFile(inputPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw createKnowledgeError(`[knowledge execplan promote] source file not found: ${inputPath}`, 1);
    }
    throw error;
  }
  const draft = parseDraftInput(raw, inputPath);
  const normalizedDraft = normalizePromotedDraft(draft, inputPath, {
    ...(options.title ? { title: options.title } : {}),
    ...(options.issueId ? { issueId: options.issueId } : {}),
  });

  const result = await putVaultArtifact({
    type: "execplan",
    title: normalizedDraft.title,
    ...(normalizedDraft.issueId ? { issue: normalizedDraft.issueId } : {}),
    ...(options.project ? { project: options.project } : {}),
    ...(options.workstream ? { workstream: options.workstream } : {}),
    ...(options.author ? { author: options.author } : {}),
    ...(options.assignee ? { assignee: options.assignee } : {}),
    ...(options.updated ? { updated: options.updated } : {}),
    ...(options.updatedBy ? { updatedBy: options.updatedBy } : {}),
    ...(options.status ? { status: options.status } : {}),
    inputFrontmatterOverride: normalizedDraft.frontmatter,
    mergeInputFrontmatter: true,
    stdinText: normalizedDraft.body,
    dryRun: Boolean(options.dryRun),
    ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
  });

  return {
    sourcePath: inputPath,
    outputPath: result.outputPath,
    relativePath: result.relativePath,
    title: normalizedDraft.title,
    ...(normalizedDraft.issueId ? { issueId: normalizedDraft.issueId } : {}),
    dryRun: result.dryRun,
    action: result.dryRun ? "plan-promote" : "promote",
    content: result.content,
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
