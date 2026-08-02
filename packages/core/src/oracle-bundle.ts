import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";

const execFileAsync = promisify(execFileCallback);

export type OracleBundleVersionV1 = "oracle-bundle/v1";
export type OracleBundleInclusionPolicyV1 = "broad" | "focused";
export type OracleBundleRedactionModeV1 = "strict" | "advisory";
export type OracleBundleVariantIdV1 = string;

export interface OracleBundlePolicyV1 {
  inclusion: OracleBundleInclusionPolicyV1;
  budget_tokens?: number | undefined;
  redaction: OracleBundleRedactionModeV1;
  fail_on_secret: boolean;
}

export interface OracleBundleVariantV1 {
  id: OracleBundleVariantIdV1;
  label?: string | undefined;
  tools?: boolean | undefined;
}

export interface OracleBundlePromptV1 {
  path: string;
  template?: string | undefined;
}

export interface OracleBundleVaultSearchV1 {
  query: string;
  limit?: number | undefined;
}

export interface OracleBundleVaultSourcesV1 {
  files: string[];
  globs: string[];
  searches: OracleBundleVaultSearchV1[];
}

export interface OracleBundleLinearSourcesV1 {
  issues: string[];
  include_comments: boolean;
  include_relations: boolean;
  context_path?: string | undefined;
}

export type OracleBundleRepoModeV1 = "archive" | "ctxpack";

export interface OracleBundleRepoSourceV1 {
  id?: string | undefined;
  path: string;
  mode: OracleBundleRepoModeV1;
  output?: string | undefined;
  include?: string[] | undefined;
  exclude?: string[] | undefined;
}

export type OracleBundleSessionModeV1 = "summary" | "raw";
const ORACLE_BUNDLE_SESSION_SCOPES = ["recent", "today", "sprint", "branch", "all"] as const;
const ORACLE_BUNDLE_ACTIVITY_AGENT_KINDS = ["all", "codex", "claude"] as const;
const ORACLE_BUNDLE_ACTIVITY_INCLUDE_VALUES = ["summary", "receipts", "worktrees", "prompts", "transcripts"] as const;

export interface OracleBundleSessionSourceV1 {
  id: string;
  provider?: "codex" | "claude" | "gemini" | "hermes" | string | undefined;
  mode: OracleBundleSessionModeV1;
  root?: string | undefined;
  path?: string | undefined;
  scope?: (typeof ORACLE_BUNDLE_SESSION_SCOPES)[number] | undefined;
  days?: number | undefined;
  bytes?: number | undefined;
}

export type OracleBundleActivityAgentKindV1 = (typeof ORACLE_BUNDLE_ACTIVITY_AGENT_KINDS)[number];
export type OracleBundleActivityIncludeV1 = (typeof ORACLE_BUNDLE_ACTIVITY_INCLUDE_VALUES)[number];

export interface OracleBundleActivityQueryV1 {
  id: string;
  host?: string | undefined;
  since_hours?: number | undefined;
  include_interactive: boolean;
  agent_kind: OracleBundleActivityAgentKindV1;
  limit?: number | undefined;
  include: OracleBundleActivityIncludeV1[];
}

export interface OracleBundleActivitySourcesV1 {
  queries: OracleBundleActivityQueryV1[];
}

export interface OracleBundleRecipeV1 {
  version: OracleBundleVersionV1;
  id: string;
  title?: string | undefined;
  issue?: string | undefined;
  project?: string | undefined;
  intent?: string | undefined;
  created_by?: string | undefined;
  policy: OracleBundlePolicyV1;
  variants: OracleBundleVariantV1[];
  prompt: OracleBundlePromptV1;
  vault: OracleBundleVaultSourcesV1;
  linear: OracleBundleLinearSourcesV1;
  repos: OracleBundleRepoSourceV1[];
  sessions: OracleBundleSessionSourceV1[];
  activity: OracleBundleActivitySourcesV1;
}

export interface OracleBundlePlanOutputV1 {
  kind: "authored" | "generated";
  path: string;
  source: "init" | "vault" | "linear" | "repo" | "session" | "activity" | "receipt" | "response";
  required: boolean;
}

export interface OracleBundleBudgetSummaryV1 {
  budget_tokens?: number;
  estimated_tokens: number;
  estimated_bytes: number;
  sources_measured: number;
  sources_missing: number;
}

export interface OracleBundlePlanV1 {
  version: "oracle-bundle-plan/v1";
  inquiry_dir: string;
  recipe_path: string;
  recipe_hash: string;
  plan_hash: string;
  outputs: OracleBundlePlanOutputV1[];
  budget: OracleBundleBudgetSummaryV1;
  counts: {
    variants: number;
    vault_files: number;
    vault_globs: number;
    vault_searches: number;
    linear_issues: number;
    repos: number;
    sessions: number;
    activity_queries: number;
  };
  warnings: string[];
}

export interface OracleBundleManifestV1 {
  version: "oracle-bundle-manifest/v1";
  inquiry_dir: string;
  recipe_path: string;
  recipe_hash: string;
  plan_hash: string;
  generated_at: string;
  outputs: OracleBundleMaterializedOutputV1[];
  warnings: OracleBundleApplyWarningV1[];
  redaction: OracleBundleApplyRedactionSummaryV1;
}

export type OracleBundleRedactionStatusV1 = "clean" | "redacted" | "not_applicable";

export interface OracleBundleRedactionEventV1 {
  path: string;
  line: number;
  reason_code: "credential_pattern" | "secret_assignment";
  source_preview: string;
}

export interface OracleBundleOutputRedactionV1 {
  mode: OracleBundleRedactionModeV1;
  status: OracleBundleRedactionStatusV1;
  events: OracleBundleRedactionEventV1[];
}

export interface OracleBundleMaterializedOutputV1 extends OracleBundlePlanOutputV1 {
  provider: "core" | "vault" | "linear" | "repo" | "session" | "activity";
  sha256: string;
  bytes: number;
  redaction: OracleBundleOutputRedactionV1;
  provenance: Record<string, unknown>;
  warnings: string[];
}

export interface OracleBundleApplyWarningV1 {
  level: "warning";
  code: string;
  message: string;
  source?: string | undefined;
}

export interface OracleBundleApplyRedactionSummaryV1 {
  mode: OracleBundleRedactionModeV1;
  redacted_outputs: number;
  redaction_events: number;
}

export interface OracleBundleApplyOptionsV1 {
  recipePath?: string | undefined;
  vaultPath?: string | undefined;
  ctxCommand?: string | undefined;
  calyxCommand?: string | undefined;
  now?: Date | undefined;
}

export interface OracleBundleApplyResultV1 {
  version: "oracle-bundle-apply/v1";
  inquiry_dir: string;
  plan: OracleBundlePlanV1;
  manifest: OracleBundleManifestV1;
  manifest_path: string;
  plan_receipt_path: string;
}

export interface OracleBundleInitOptionsV1 {
  slug: string;
  outDir?: string | undefined;
  daily?: boolean;
  vaultPath?: string | undefined;
  issue?: string | undefined;
  project?: string | undefined;
  variants?: string[] | undefined;
  author?: string | undefined;
  now?: Date | undefined;
  force?: boolean;
}

export interface OracleBundleInitResultV1 {
  inquiry_dir: string;
  files: string[];
  recipe: OracleBundleRecipeV1;
}

export interface OracleBundleDoctorFindingV1 {
  level: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

export interface OracleBundleDoctorResultV1 {
  ok: boolean;
  inquiry_dir: string;
  findings: OracleBundleDoctorFindingV1[];
}

export const DEFAULT_ORACLE_GEMINI_MODEL_V1 = "gemini-3.1-pro";

export type OracleRunProviderV1 = "gemini";

export interface OracleRunAttachmentV1 {
  path: string;
  absolute_path: string;
  source: OracleBundlePlanOutputV1["source"];
  provider: OracleBundleMaterializedOutputV1["provider"];
  sha256: string;
  bytes: number;
  mime_type: string;
  upload_required: boolean;
}

export interface OracleRunPlanV1 {
  version: "oracle-run-plan/v1";
  inquiry_dir: string;
  provider: OracleRunProviderV1;
  model: string;
  variant: string;
  run_plan_hash: string;
  ready: boolean;
  dry_run_only: boolean;
  prompt: {
    path: string;
    absolute_path: string;
    sha256: string;
    bytes: number;
    estimated_tokens: number;
  };
  manifest: {
    path: string;
    absolute_path: string;
    sha256: string;
    recipe_hash: string;
    plan_hash: string;
    generated_at: string;
  };
  response_path: string;
  receipt_path: string;
  attachments: OracleRunAttachmentV1[];
  budget: {
    estimated_tokens: number;
    estimated_bytes: number;
    attachment_count: number;
  };
  warnings: OracleBundleApplyWarningV1[];
}

export interface OracleRunPlanOptionsV1 {
  recipePath?: string | undefined;
  manifestPath?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  variant?: string | undefined;
  responsePath?: string | undefined;
  dryRunOnly?: boolean | undefined;
}

export interface OracleRunUsageV1 {
  prompt_tokens?: number | undefined;
  response_tokens?: number | undefined;
  total_tokens?: number | undefined;
  raw?: unknown;
}

export interface OracleRunReceiptV1 {
  version: "oracle-run-receipt/v1";
  inquiry_dir: string;
  provider: OracleRunProviderV1;
  model: string;
  variant: string;
  status: "succeeded";
  started_at: string;
  completed_at: string;
  run_plan_hash: string;
  manifest_hash: string;
  prompt_hash: string;
  response_hash: string;
  response_path: string;
  attachments: OracleRunAttachmentV1[];
  usage?: OracleRunUsageV1 | undefined;
  provider_response_id?: string | undefined;
  warnings: OracleBundleApplyWarningV1[];
}

export interface OracleRunWriteOptionsV1 {
  plan: OracleRunPlanV1;
  responseText: string;
  startedAt?: Date | undefined;
  completedAt?: Date | undefined;
  usage?: OracleRunUsageV1 | undefined;
  providerResponseId?: string | undefined;
}

export interface OracleRunWriteResultV1 {
  version: "oracle-run-result/v1";
  inquiry_dir: string;
  response_path: string;
  receipt_path: string;
  receipt: OracleRunReceiptV1;
}

export interface OracleSynthesisResponseV1 {
  path: string;
  absolute_path: string;
  sha256: string;
  bytes: number;
}

export interface OracleSynthesisResultV1 {
  version: "oracle-synthesis/v1";
  inquiry_dir: string;
  synthesis_path: string;
  responses: OracleSynthesisResponseV1[];
  warnings: OracleBundleApplyWarningV1[];
  wrote: boolean;
}

export interface OracleSynthesisOptionsV1 {
  outputPath?: string | undefined;
  dryRun?: boolean | undefined;
  force?: boolean | undefined;
  now?: Date | undefined;
}

interface OracleBundleError extends Error {
  exitCode?: number;
}

function createOracleBundleError(message: string, exitCode = 2): OracleBundleError {
  const error = new Error(message) as OracleBundleError;
  error.exitCode = exitCode;
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requiredString(value: unknown, label: string): string {
  const parsed = optionalString(value);
  if (!parsed) {
    throw createOracleBundleError(`${label} must be a non-empty string.`);
  }
  return parsed;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw createOracleBundleError(`${label} must be a positive integer.`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw createOracleBundleError(`${label} must be an array.`);
  }
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`));
}

function enumString<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  label: string,
): T {
  const parsed = optionalString(value) ?? fallback;
  if ((allowed as readonly string[]).includes(parsed)) {
    return parsed as T;
  }
  throw createOracleBundleError(`${label} must be one of: ${allowed.join(", ")}.`);
}

function optionalEnumString<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T | undefined {
  const parsed = optionalString(value);
  if (!parsed) {
    return undefined;
  }
  if ((allowed as readonly string[]).includes(parsed)) {
    return parsed as T;
  }
  throw createOracleBundleError(`${label} must be one of: ${allowed.join(", ")}.`);
}

function enumStringArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: readonly T[],
  label: string,
): T[] {
  if (value === undefined || value === null) {
    return [...fallback];
  }
  if (!Array.isArray(value)) {
    throw createOracleBundleError(`${label} must be an array.`);
  }
  return value.map((entry, index) => enumString(entry, allowed, fallback[0]!, `${label}[${index}]`));
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (!isRecord(value)) {
    return JSON.stringify(value);
  }
  return `{${Object.keys(value)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Buffer(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function relativeManifestPath(inquiryDir: string, absolutePath: string): string {
  return toPosixPath(path.relative(inquiryDir, absolutePath));
}

const REDACTION_PATTERNS: Array<{
  reason_code: OracleBundleRedactionEventV1["reason_code"];
  regex: RegExp;
}> = [
  {
    reason_code: "credential_pattern",
    regex: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    reason_code: "credential_pattern",
    regex: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  {
    reason_code: "credential_pattern",
    regex: /\bsk-[A-Za-z0-9]{20,}\b/,
  },
  {
    reason_code: "secret_assignment",
    regex: /\b(api[_-]?key|token|secret|password|passwd|bearer)\b\s*[:=]/i,
  },
  {
    reason_code: "secret_assignment",
    regex: /\b(AUTH|TOKEN|SECRET|PASSWORD|API_KEY)\b\s*=\s*\S+/,
  },
];

function redactText(text: string, outputPath: string, mode: OracleBundleRedactionModeV1): {
  text: string;
  redaction: OracleBundleOutputRedactionV1;
} {
  const lines = text.split("\n");
  const redacted = [...lines];
  const events: OracleBundleRedactionEventV1[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const match = REDACTION_PATTERNS.find((pattern) => pattern.regex.test(line));
    if (!match) {
      continue;
    }
    events.push({
      path: outputPath,
      line: index + 1,
      reason_code: match.reason_code,
      source_preview: trimmed.slice(0, 160),
    });
    redacted[index] = `[calyx-oracle-redacted:${mode}:${match.reason_code}]`;
  }

  return {
    text: redacted.join("\n"),
    redaction: {
      mode,
      status: events.length > 0 ? "redacted" : "clean",
      events,
    },
  };
}

function notApplicableRedaction(mode: OracleBundleRedactionModeV1): OracleBundleOutputRedactionV1 {
  return {
    mode,
    status: "not_applicable",
    events: [],
  };
}

function resolveVaultPath(requestedPath?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (requestedPath?.trim()) {
    return path.resolve(requestedPath.trim());
  }
  if (env["VAULT_PATH"]?.trim()) {
    return path.resolve(env["VAULT_PATH"].trim());
  }
  return path.join(env["HOME"] || os.homedir(), "vault", "fieldwork");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeSlug(value: string, label: string): string {
  const slug = slugify(value);
  if (slug.length === 0) {
    throw createOracleBundleError(`${label} must not be empty after slugify.`);
  }
  return slug;
}

function safeRelativePath(value: unknown, label: string): string {
  const raw = requiredString(value, label);
  if (path.win32.isAbsolute(raw)) {
    throw createOracleBundleError(`${label} must be a relative path inside the inquiry.`);
  }
  const parsed = raw.replace(/\\/g, "/");
  if (parsed.startsWith("/") || parsed.split("/").includes("..")) {
    throw createOracleBundleError(`${label} must be a relative path inside the inquiry.`);
  }
  const normalized = path.posix.normalize(parsed);
  if (normalized === "." || normalized.startsWith("../")) {
    throw createOracleBundleError(`${label} must be a relative path inside the inquiry.`);
  }
  return normalized;
}

function normalizeVariants(values: readonly string[] | undefined): OracleBundleVariantV1[] {
  const raw = values && values.length > 0 ? values : ["sandbox"];
  const variants = raw
    .map((entry, index) => normalizeSlug(entry, `variants[${index}]`))
    .map((id) => ({
      id,
      label: id === "sandbox" ? "Sandbox-only" : id === "tools" ? "Tools-enabled" : id,
      tools: id === "tools",
    }));
  const unique = new Map<string, OracleBundleVariantV1>();
  for (const variant of variants) {
    unique.set(variant.id, variant);
  }
  return [...unique.values()];
}

function normalizeRecipe(raw: unknown): OracleBundleRecipeV1 {
  if (!isRecord(raw)) {
    throw createOracleBundleError("Oracle bundle recipe must be a YAML mapping.");
  }
  const version = requiredString(raw.version, "version");
  if (version !== "oracle-bundle/v1") {
    throw createOracleBundleError(`Unsupported oracle bundle recipe version "${version}".`);
  }

  const policyRaw = isRecord(raw.policy) ? raw.policy : {};
  const inclusion = optionalString(policyRaw.inclusion) ?? "broad";
  if (inclusion !== "broad" && inclusion !== "focused") {
    throw createOracleBundleError("policy.inclusion must be broad or focused.");
  }
  const redaction = optionalString(policyRaw.redaction) ?? "strict";
  if (redaction !== "strict" && redaction !== "advisory") {
    throw createOracleBundleError("policy.redaction must be strict or advisory.");
  }
  const budgetTokens = optionalPositiveInteger(policyRaw.budget_tokens, "policy.budget_tokens");

  const promptRaw = isRecord(raw.prompt) ? raw.prompt : {};
  const vaultRaw = isRecord(raw.vault) ? raw.vault : {};
  const linearRaw = isRecord(raw.linear) ? raw.linear : {};
  const activityRaw = isRecord(raw.activity) ? raw.activity : {};
  const repoRaw = Array.isArray(raw.repos) ? raw.repos : [];
  const sessionRaw = Array.isArray(raw.sessions) ? raw.sessions : [];
  const variantRaw = Array.isArray(raw.variants) ? raw.variants : [];

  const variants = variantRaw.length > 0
    ? variantRaw.map((entry, index) => {
        if (!isRecord(entry)) {
          throw createOracleBundleError(`variants[${index}] must be a mapping.`);
        }
        const id = normalizeSlug(requiredString(entry.id, `variants[${index}].id`), `variants[${index}].id`);
        return {
          id,
          ...(optionalString(entry.label) ? { label: optionalString(entry.label) } : {}),
          tools: optionalBoolean(entry.tools, false),
        };
      })
    : normalizeVariants(undefined);

  const repos = repoRaw.map((entry, index) => {
    if (!isRecord(entry)) {
      throw createOracleBundleError(`repos[${index}] must be a mapping.`);
    }
    const mode = optionalString(entry.mode) ?? "archive";
    if (mode !== "archive" && mode !== "ctxpack") {
      throw createOracleBundleError(`repos[${index}].mode must be archive or ctxpack.`);
    }
    const repoMode: OracleBundleRepoModeV1 = mode;
    return {
      ...(optionalString(entry.id) ? { id: normalizeSlug(requiredString(entry.id, `repos[${index}].id`), `repos[${index}].id`) } : {}),
      path: requiredString(entry.path, `repos[${index}].path`),
      mode: repoMode,
      ...(optionalString(entry.output) ? { output: safeRelativePath(entry.output, `repos[${index}].output`) } : {}),
      include: stringArray(entry.include, `repos[${index}].include`).map((include, includeIndex) =>
        safeRelativePath(include, `repos[${index}].include[${includeIndex}]`)
      ),
      exclude: stringArray(entry.exclude, `repos[${index}].exclude`).map((exclude, excludeIndex) =>
        safeRelativePath(exclude, `repos[${index}].exclude[${excludeIndex}]`)
      ),
    };
  });
  const seenRepoOutputs = new Set<string>();
  for (const [index, repo] of repos.entries()) {
    const outputPath = repoOutputPath(repo);
    if (seenRepoOutputs.has(outputPath)) {
      throw createOracleBundleError(`repos[${index}] produces duplicate output path: ${outputPath}`);
    }
    seenRepoOutputs.add(outputPath);
  }

  const sessions = sessionRaw.map((entry, index) => {
    if (!isRecord(entry)) {
      throw createOracleBundleError(`sessions[${index}] must be a mapping.`);
    }
    const mode = optionalString(entry.mode) ?? "summary";
    if (mode !== "summary" && mode !== "raw") {
      throw createOracleBundleError(`sessions[${index}].mode must be summary or raw.`);
    }
    const sessionMode: OracleBundleSessionModeV1 = mode;
    const provider = optionalString(entry.provider);
    const root = optionalString(entry.root);
    const sessionPath = optionalString(entry.path);
    const scope = optionalEnumString(entry.scope, ORACLE_BUNDLE_SESSION_SCOPES, `sessions[${index}].scope`);
    const days = optionalPositiveInteger(entry.days, `sessions[${index}].days`);
    const bytes = optionalPositiveInteger(entry.bytes, `sessions[${index}].bytes`);
    return {
      id: requiredString(entry.id, `sessions[${index}].id`),
      ...(provider ? { provider } : {}),
      mode: sessionMode,
      ...(root ? { root } : {}),
      ...(sessionPath ? { path: sessionPath } : {}),
      ...(scope ? { scope } : {}),
      ...(days === undefined ? {} : { days }),
      ...(bytes === undefined ? {} : { bytes }),
    };
  });

  const activityQueries = (Array.isArray(activityRaw.queries) ? activityRaw.queries : []).map((entry, index) => {
    if (!isRecord(entry)) {
      throw createOracleBundleError(`activity.queries[${index}] must be a mapping.`);
    }
    const sinceHours = optionalPositiveInteger(entry.since_hours, `activity.queries[${index}].since_hours`);
    const limit = optionalPositiveInteger(entry.limit, `activity.queries[${index}].limit`);
    const host = optionalString(entry.host);
    return {
      id: normalizeSlug(requiredString(entry.id, `activity.queries[${index}].id`), `activity.queries[${index}].id`),
      ...(host ? { host } : {}),
      ...(sinceHours === undefined ? {} : { since_hours: sinceHours }),
      include_interactive: optionalBoolean(entry.include_interactive, true),
      agent_kind: enumString(
        entry.agent_kind,
        ORACLE_BUNDLE_ACTIVITY_AGENT_KINDS,
        "all",
        `activity.queries[${index}].agent_kind`,
      ),
      ...(limit === undefined ? {} : { limit }),
      include: enumStringArray(
        entry.include,
        ORACLE_BUNDLE_ACTIVITY_INCLUDE_VALUES,
        ["summary"],
        `activity.queries[${index}].include`,
      ),
    };
  });

  return {
    version: "oracle-bundle/v1",
    id: normalizeSlug(requiredString(raw.id, "id"), "id"),
    ...(optionalString(raw.title) ? { title: optionalString(raw.title) } : {}),
    ...(optionalString(raw.issue) ? { issue: optionalString(raw.issue) } : {}),
    ...(optionalString(raw.project) ? { project: optionalString(raw.project) } : {}),
    ...(optionalString(raw.intent) ? { intent: optionalString(raw.intent) } : {}),
    ...(optionalString(raw.created_by) ? { created_by: optionalString(raw.created_by) } : {}),
    policy: {
      inclusion,
      ...(budgetTokens === undefined ? {} : { budget_tokens: budgetTokens }),
      redaction,
      fail_on_secret: optionalBoolean(policyRaw.fail_on_secret, true),
    },
    variants,
    prompt: {
      path: promptRaw.path === undefined ? "oracle-prompt.md" : safeRelativePath(promptRaw.path, "prompt.path"),
      ...(optionalString(promptRaw.template) ? { template: optionalString(promptRaw.template) } : {}),
    },
    vault: {
      files: stringArray(vaultRaw.files, "vault.files"),
      globs: stringArray(vaultRaw.globs, "vault.globs"),
      searches: (Array.isArray(vaultRaw.searches) ? vaultRaw.searches : []).map((entry, index) => {
        if (!isRecord(entry)) {
          throw createOracleBundleError(`vault.searches[${index}] must be a mapping.`);
        }
        const limit = optionalPositiveInteger(entry.limit, `vault.searches[${index}].limit`);
        return {
          query: requiredString(entry.query, `vault.searches[${index}].query`),
          ...(limit === undefined ? {} : { limit }),
        };
      }),
    },
    linear: {
      issues: stringArray(linearRaw.issues, "linear.issues"),
      include_comments: optionalBoolean(linearRaw.include_comments, true),
      include_relations: optionalBoolean(linearRaw.include_relations, true),
      ...(optionalString(linearRaw.context_path) ? { context_path: safeRelativePath(linearRaw.context_path, "linear.context_path") } : {}),
    },
    repos,
    sessions,
    activity: {
      queries: activityQueries,
    },
  };
}

export function parseOracleBundleRecipeV1(rawText: string, sourceLabel = "inquiry.yaml"): OracleBundleRecipeV1 {
  try {
    return normalizeRecipe(YAML.parse(rawText));
  } catch (error) {
    if (error instanceof Error && "exitCode" in error) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw createOracleBundleError(`Failed to parse oracle bundle recipe ${sourceLabel}: ${message}`);
  }
}

export async function readOracleBundleRecipeV1(recipePath: string): Promise<OracleBundleRecipeV1> {
  const raw = await readFile(recipePath, "utf8");
  return parseOracleBundleRecipeV1(raw, recipePath);
}

function renderRecipeYaml(recipe: OracleBundleRecipeV1): string {
  return `${YAML.stringify(recipe).trimEnd()}\n`;
}

function buildDefaultRecipe(options: OracleBundleInitOptionsV1, id: string): OracleBundleRecipeV1 {
  return {
    version: "oracle-bundle/v1",
    id,
    title: options.issue ? `${options.issue}: Oracle inquiry` : `${id}: Oracle inquiry`,
    ...(options.issue ? { issue: options.issue } : {}),
    ...(options.project ? { project: options.project } : {}),
    intent: "architecture-review",
    ...(options.author ? { created_by: options.author } : {}),
    policy: {
      inclusion: "broad",
      budget_tokens: 300000,
      redaction: "strict",
      fail_on_secret: true,
    },
    variants: normalizeVariants(options.variants),
    prompt: {
      path: "oracle-prompt.md",
      template: "architecture-review",
    },
    vault: {
      files: [],
      globs: [],
      searches: [],
    },
    linear: {
      issues: options.issue ? [options.issue] : [],
      include_comments: true,
      include_relations: true,
    },
    repos: [],
    sessions: [],
    activity: {
      queries: [],
    },
  };
}

function renderReadme(recipe: OracleBundleRecipeV1): string {
  const variants = recipe.variants.map((variant) => `- ${variant.id}: ${variant.label ?? variant.id}`).join("\n");
  return `---\ntype: daily\nissue: ${recipe.issue ?? ""}\nproject: ${recipe.project ?? ""}\ntags: [oracle, inquiry]\n---\n\n# ${recipe.title ?? recipe.id}\n\n## How To Run\n\n1. Edit \`${recipe.prompt.path}\` so the problem statement and questions are concrete.\n2. Run \`calyx oracle bundle . --recipe inquiry.yaml --plan --json\` to inspect expected attachments.\n3. Run \`calyx oracle bundle . --recipe inquiry.yaml --apply --json\` to materialize \`context/\`, \`code/\`, and \`receipts/\` outputs.\n4. Run \`calyx oracle doctor .\` and resolve any blocking findings.\n5. Run \`calyx oracle run . --dry-run --json\` to inspect the Gemini upload/model plan.\n6. Run \`calyx oracle run . --provider gemini --variant sandbox\` to write a response markdown file plus a run receipt.\n7. Run \`calyx oracle synthesize .\` after responses exist, then complete the synthesis by reading the response files and updating the plan/Linear issue.\n\nUse human ChatGPT web only when the user explicitly asks for a GPT Pro / ChatGPT web consultation.\n\n## Variants\n\n${variants || "- sandbox"}\n\n## Bundle Commands\n\n\`\`\`bash\ncalyx oracle bundle . --recipe inquiry.yaml --plan --json\ncalyx oracle bundle . --recipe inquiry.yaml --apply --json\ncalyx oracle doctor .\ncalyx oracle run . --dry-run --json\ncalyx oracle run . --provider gemini --variant sandbox\ncalyx oracle synthesize .\n\`\`\`\n`;
}

function renderPrompt(recipe: OracleBundleRecipeV1): string {
  return `# Oracle Consultation: ${recipe.title ?? recipe.id}\n\n## Role\n\nYou are an expert reviewer. Read the attached context and give concrete, opinionated guidance.\n\n## Problem Statement\n\nDescribe the problem here before running the oracle.\n\n## Proposed Design\n\nSummarize the current design here.\n\n## Questions\n\n1. What is the strongest critique of this plan?\n2. What should change before implementation?\n3. What are we missing?\n\n## Expected Deliverable\n\nReturn a structured recommendation, risks, and implementation priorities.\n`;
}

function renderResponseSkeleton(recipe: OracleBundleRecipeV1, now: Date): string {
  const variant = recipe.variants[0]?.id ?? "";
  return `---\ntype: daily\ncreated: ${isoDate(now)}\nauthor: oracle\nissue: ${recipe.issue ?? ""}\nproject: ${recipe.project ?? ""}\nvariant: ${variant}\ntags: [oracle, response]\n---\n\n# Oracle Response: ${recipe.title ?? recipe.id}\n\n## TL;DR\n\n## Recommendation\n\n## Risks\n\n## Implementation Priorities\n\n## Confidence\n`;
}

function resolveInitDir(options: OracleBundleInitOptionsV1, normalizedSlug: string, now: Date): string {
  if (options.outDir?.trim()) {
    return path.resolve(options.outDir.trim());
  }
  if (options.daily) {
    const vaultPath = resolveVaultPath(options.vaultPath);
    return path.join(vaultPath, "10-daily", isoDate(now), normalizedSlug);
  }
  return path.resolve(normalizedSlug);
}

export async function initOracleBundleV1(options: OracleBundleInitOptionsV1): Promise<OracleBundleInitResultV1> {
  const now = options.now ?? new Date();
  const normalizedSlug = normalizeSlug(options.slug, "slug");
  const inquiryDir = resolveInitDir(options, normalizedSlug, now);
  const recipe = buildDefaultRecipe(options, normalizedSlug);
  const files = [
    path.join(inquiryDir, "inquiry.yaml"),
    path.join(inquiryDir, "README.md"),
    path.join(inquiryDir, recipe.prompt.path),
    path.join(inquiryDir, "oracle-response-skeleton.md"),
  ];

  await mkdir(inquiryDir, { recursive: true });
  for (const file of files) {
    if (!options.force && existsSync(file)) {
      throw createOracleBundleError(`Refusing to overwrite existing file: ${file}`, 2);
    }
  }
  await writeFile(files[0]!, renderRecipeYaml(recipe), "utf8");
  await writeFile(files[1]!, renderReadme(recipe), "utf8");
  await writeFile(files[2]!, renderPrompt(recipe), "utf8");
  await writeFile(files[3]!, renderResponseSkeleton(recipe, now), "utf8");

  return {
    inquiry_dir: inquiryDir,
    files,
    recipe,
  };
}

function repoOutputPath(repo: OracleBundleRepoSourceV1): string {
  if (repo.output) {
    return path.posix.join("code", repo.output);
  }
  const id = repo.id ? normalizeSlug(repo.id, "repos[].id") : normalizeSlug(path.basename(repo.path), "repos[].path");
  return path.posix.join("code", repo.mode === "archive" ? `${id}-codebase.zip` : `${id}-ctxpack.txt`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function measureExistingFile(filePath: string): Promise<{ bytes: number; exists: boolean; error?: string }> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return { bytes: 0, exists: false };
    }
    return { bytes: fileStat.size, exists: true };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return { bytes: 0, exists: false };
    }
    return { bytes: 0, exists: false, error: errorMessage(error) };
  }
}

function addMeasuredSource(
  measured: { bytes: number; exists: boolean; error?: string },
  messages: { missing: string; unreadable: string },
  state: { estimatedBytes: number; sourcesMeasured: number; sourcesMissing: number; warnings: string[] },
): void {
  if (measured.exists) {
    state.estimatedBytes += measured.bytes;
    state.sourcesMeasured += 1;
    return;
  }
  state.sourcesMissing += 1;
  state.warnings.push(measured.error ? `${messages.unreadable}: ${measured.error}` : messages.missing);
}

async function checkReadableFile(
  findings: OracleBundleDoctorFindingV1[],
  absolutePath: string,
  relativePath: string,
  missingCode: string,
  unreadableCode: string,
): Promise<void> {
  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      findings.push({
        level: "error",
        code: unreadableCode,
        message: `${relativePath} is not a readable file.`,
        path: absolutePath,
      });
      return;
    }
    await readFile(absolutePath, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    findings.push({
      level: "error",
      code: code === "ENOENT" || code === "ENOTDIR" ? missingCode : unreadableCode,
      message: code === "ENOENT" || code === "ENOTDIR" ? `Missing ${relativePath}.` : `${relativePath} is unreadable: ${errorMessage(error)}`,
      path: absolutePath,
    });
  }
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function mimeTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".md":
    case ".txt":
    case ".log":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".yaml":
    case ".yml":
      return "application/x-yaml";
    case ".csv":
      return "text/csv";
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
    case ".ts":
    case ".tsx":
      return "text/plain";
    case ".py":
    case ".sh":
    case ".rb":
    case ".go":
    case ".rs":
      return "text/plain";
    case ".pdf":
      return "application/pdf";
    case ".zip":
      return "application/zip";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function normalizeOracleRunProvider(value: string | undefined): OracleRunProviderV1 {
  const provider = (value ?? "gemini").trim().toLowerCase();
  if (provider === "gemini") {
    return provider;
  }
  if (provider === "openai" || provider === "chatgpt" || provider === "gpt" || provider === "gpt-pro") {
    throw createOracleBundleError(
      "OpenAI/GPT Pro API oracle runs are not supported by calyx oracle. Use provider gemini for unattended runs, or ask the user explicitly for a human ChatGPT web consultation.",
      2,
    );
  }
  throw createOracleBundleError(`Unsupported oracle run provider "${provider}". Supported providers: gemini.`);
}

function assertOracleRunModelAllowed(provider: OracleRunProviderV1, model: string): void {
  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    throw createOracleBundleError("Oracle run model must be a non-empty string.");
  }
  if (/(^|[^a-z0-9])(gpt|openai|chatgpt|o[0-9])([a-z0-9-]*)([^a-z0-9]|$)/i.test(model)) {
    throw createOracleBundleError(
      `Model "${model}" is not allowed for unattended oracle runs. GPT Pro-class OpenAI oracle consultations require an explicit human ChatGPT web path.`,
      2,
    );
  }
  if (provider === "gemini" && !normalized.includes("gemini")) {
    throw createOracleBundleError(`Gemini oracle runs require a Gemini model name, got "${model}".`);
  }
}

function responsePathForOracleRun(provider: OracleRunProviderV1, variant: string, requested?: string): string {
  if (requested?.trim()) {
    return safeRelativePath(requested, "responsePath");
  }
  return `oracle-response-${provider}-${normalizeSlug(variant, "variant")}.md`;
}

function receiptPathForOracleRun(provider: OracleRunProviderV1, variant: string): string {
  return toPosixPath(path.join("receipts", `oracle-run-${provider}-${normalizeSlug(variant, "variant")}.json`));
}

function isOracleRunAttachmentOutput(output: OracleBundleMaterializedOutputV1): boolean {
  return output.source === "vault" ||
    output.source === "linear" ||
    output.source === "repo" ||
    output.source === "session" ||
    output.source === "activity";
}

function oracleWarning(code: string, message: string, source?: string): OracleBundleApplyWarningV1 {
  return {
    level: "warning",
    code,
    message,
    ...(source ? { source } : {}),
  };
}

async function readOracleBundleManifestV1(manifestPath: string): Promise<OracleBundleManifestV1> {
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as OracleBundleManifestV1;
  if (parsed.version !== "oracle-bundle-manifest/v1") {
    throw createOracleBundleError(`Unsupported oracle bundle manifest version "${String(parsed.version)}".`);
  }
  return parsed;
}

async function materializeTextOutput(params: {
  inquiryDir: string;
  relativePath: string;
  source: OracleBundlePlanOutputV1["source"];
  provider: OracleBundleMaterializedOutputV1["provider"];
  required: boolean;
  text: string;
  recipe: OracleBundleRecipeV1;
  provenance: Record<string, unknown>;
  warnings?: string[];
}): Promise<OracleBundleMaterializedOutputV1> {
  const outputPath = path.join(params.inquiryDir, params.relativePath);
  const redacted = redactText(params.text, params.relativePath, params.recipe.policy.redaction);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, redacted.text, "utf8");
  const bytes = Buffer.byteLength(redacted.text, "utf8");
  return {
    kind: "generated",
    path: toPosixPath(params.relativePath),
    source: params.source,
    required: params.required,
    provider: params.provider,
    sha256: sha256Buffer(redacted.text),
    bytes,
    redaction: redacted.redaction,
    provenance: params.provenance,
    warnings: params.warnings ?? [],
  };
}

function globToRegExp(glob: string): RegExp {
  const normalized = toPosixPath(glob);
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? "";
    const next = normalized[index + 1] ?? "";
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  source += "$";
  return new RegExp(source);
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, absolutePath)));
    } else if (entry.isFile()) {
      files.push(toPosixPath(path.relative(root, absolutePath)));
    }
  }
  return files;
}

async function resolveVaultSourceFiles(recipe: OracleBundleRecipeV1, vaultPath: string): Promise<{
  files: string[];
  warnings: OracleBundleApplyWarningV1[];
}> {
  const files = new Set<string>();
  const warnings: OracleBundleApplyWarningV1[] = [];

  for (const file of recipe.vault.files) {
    files.add(path.isAbsolute(file) ? file : path.join(vaultPath, file));
  }

  if (recipe.vault.globs.length > 0) {
    let walked: string[] = [];
    try {
      walked = await walkFiles(vaultPath);
    } catch (error) {
      warnings.push({
        level: "warning",
        code: "vault_glob_root_unreadable",
        message: `Unable to walk vault root for globs: ${errorMessage(error)}`,
        source: vaultPath,
      });
    }
    for (const glob of recipe.vault.globs) {
      const regex = globToRegExp(glob);
      const matched = walked.filter((candidate) => regex.test(candidate));
      if (matched.length === 0) {
        warnings.push({
          level: "warning",
          code: "vault_glob_no_matches",
          message: `Vault glob matched no files: ${glob}`,
          source: glob,
        });
      }
      for (const match of matched) {
        files.add(path.join(vaultPath, match));
      }
    }
  }

  for (const search of recipe.vault.searches) {
    warnings.push({
      level: "warning",
      code: "vault_search_unimplemented",
      message: `Vault search materialization is not implemented in this slice: ${search.query}`,
      source: search.query,
    });
  }

  return {
    files: [...files].sort((left, right) => left.localeCompare(right)),
    warnings,
  };
}

async function materializeVaultProvider(params: {
  inquiryDir: string;
  recipe: OracleBundleRecipeV1;
  vaultPath: string;
  warnings: OracleBundleApplyWarningV1[];
}): Promise<OracleBundleMaterializedOutputV1 | undefined> {
  if (
    params.recipe.vault.files.length === 0 &&
    params.recipe.vault.globs.length === 0 &&
    params.recipe.vault.searches.length === 0
  ) {
    return undefined;
  }

  const resolved = await resolveVaultSourceFiles(params.recipe, params.vaultPath);
  params.warnings.push(...resolved.warnings);

  const sections: string[] = [
    "# Vault Context",
    "",
    `vault_root: ${params.vaultPath}`,
    "",
  ];
  const outputWarnings: string[] = resolved.warnings.map((warning) => warning.message);

  for (const file of resolved.files) {
    try {
      const fileStat = await stat(file);
      if (!fileStat.isFile()) {
        const message = `Vault source is not a regular file: ${file}`;
        params.warnings.push({ level: "warning", code: "vault_source_not_file", message, source: file });
        outputWarnings.push(message);
        continue;
      }
      const text = await readFile(file, "utf8");
      const label = path.isAbsolute(file) ? relativeManifestPath(params.vaultPath, file) : file;
      sections.push(`## ${toPosixPath(label)}`, "", "```markdown", text.trimEnd(), "```", "");
    } catch (error) {
      const message = `Unable to read vault source ${file}: ${errorMessage(error)}`;
      params.warnings.push({ level: "warning", code: "vault_source_unreadable", message, source: file });
      outputWarnings.push(message);
    }
  }

  return materializeTextOutput({
    inquiryDir: params.inquiryDir,
    relativePath: path.join("context", "vault-context.md"),
    source: "vault",
    provider: "vault",
    required: true,
    text: `${sections.join("\n").trimEnd()}\n`,
    recipe: params.recipe,
    provenance: {
      vault_root: params.vaultPath,
      files: resolved.files.map((file) => toPosixPath(file)),
      globs: params.recipe.vault.globs,
      searches: params.recipe.vault.searches,
    },
    warnings: outputWarnings,
  });
}

async function materializeLinearProvider(params: {
  inquiryDir: string;
  recipe: OracleBundleRecipeV1;
  warnings: OracleBundleApplyWarningV1[];
}): Promise<OracleBundleMaterializedOutputV1 | undefined> {
  if (params.recipe.linear.issues.length === 0 && !params.recipe.linear.context_path) {
    return undefined;
  }

  let context: unknown;
  const outputWarnings: string[] = [];
  if (params.recipe.linear.context_path) {
    const contextPath = path.isAbsolute(params.recipe.linear.context_path)
      ? params.recipe.linear.context_path
      : path.join(params.inquiryDir, params.recipe.linear.context_path);
    try {
      const raw = await readFile(contextPath, "utf8");
      try {
        context = JSON.parse(raw);
      } catch {
        context = raw;
      }
    } catch (error) {
      const message = `Unable to read Linear context file ${params.recipe.linear.context_path}: ${errorMessage(error)}`;
      params.warnings.push({ level: "warning", code: "linear_context_unreadable", message, source: params.recipe.linear.context_path });
      outputWarnings.push(message);
    }
  }

  const payload = {
    issues: params.recipe.linear.issues,
    include_comments: params.recipe.linear.include_comments,
    include_relations: params.recipe.linear.include_relations,
    context_path: params.recipe.linear.context_path ?? null,
    context: context ?? null,
    note: context === undefined
      ? "Direct Linear API fetching is deferred; provide linear.context_path for richer issue context."
      : "Linear context materialized from recipe linear.context_path.",
  };

  return materializeTextOutput({
    inquiryDir: params.inquiryDir,
    relativePath: path.join("context", "linear-context.json"),
    source: "linear",
    provider: "linear",
    required: true,
    text: `${JSON.stringify(payload, null, 2)}\n`,
    recipe: params.recipe,
    provenance: {
      issues: params.recipe.linear.issues,
      context_path: params.recipe.linear.context_path ?? null,
    },
    warnings: outputWarnings,
  });
}

type OracleActivityEntry = Record<string, unknown>;
interface OracleActivityQueryWarning {
  code: "activity_query_failed" | "activity_query_invalid_json" | "activity_query_unexpected_shape" | "calyx_command_unavailable";
  message: string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function activityEntryId(entry: OracleActivityEntry): string {
  return stringValue(entry.run_id) ?? stringValue(entry.session_id) ?? "unknown";
}

function activityEntryUpdatedAt(entry: OracleActivityEntry): string {
  return stringValue(entry.updated_at) ?? stringValue(entry.created_at) ?? "";
}

function sortActivityEntries(entries: OracleActivityEntry[]): OracleActivityEntry[] {
  return [...entries].sort((left, right) => {
    const time = activityEntryUpdatedAt(right).localeCompare(activityEntryUpdatedAt(left));
    return time === 0 ? activityEntryId(left).localeCompare(activityEntryId(right)) : time;
  });
}

function pushStringActivityLine(lines: string[], entry: OracleActivityEntry, key: string, label = key): void {
  const value = stringValue(entry[key]);
  if (value) {
    lines.push(`- ${label}: ${value}`);
  }
}

function renderActivityEntry(entry: OracleActivityEntry, include: ReadonlySet<OracleBundleActivityIncludeV1>): string[] {
  const entryKind = stringValue(entry.entry_kind) ?? "calyx_run";
  const runId = activityEntryId(entry);
  const lines = [
    `### ${runId}`,
    "",
    `- kind: ${entryKind}`,
    `- state: ${stringValue(entry.state) ?? "-"}`,
    `- host: ${stringValue(entry.host) ?? "-"}`,
    `- backend: ${stringValue(entry.backend) ?? "-"}`,
    `- created_at: ${stringValue(entry.created_at) ?? "-"}`,
    `- updated_at: ${stringValue(entry.updated_at) ?? "-"}`,
  ];

  const issue = stringValue(entry.issue);
  if (issue) {
    lines.push(`- issue: ${issue}`);
  }
  if (include.has("receipts")) {
    pushStringActivityLine(lines, entry, "run_dir");
    pushStringActivityLine(lines, entry, "kernel_receipt_path");
    pushStringActivityLine(lines, entry, "receipt_path");
  }
  if (include.has("worktrees")) {
    pushStringActivityLine(lines, entry, "cwd");
    pushStringActivityLine(lines, entry, "worktree_path");
    pushStringActivityLine(lines, entry, "branch");
  }
  if (include.has("transcripts")) {
    pushStringActivityLine(lines, entry, "session_id");
    pushStringActivityLine(lines, entry, "session_path");
    pushStringActivityLine(lines, entry, "source");
    const bytes = numberValue(entry.bytes);
    if (bytes !== undefined) {
      lines.push(`- bytes: ${bytes}`);
    }
  }
  if (include.has("prompts")) {
    pushStringActivityLine(lines, entry, "prompt_path");
    pushStringActivityLine(lines, entry, "prompt_file");
    pushStringActivityLine(lines, entry, "system_prompt_path");
    pushStringActivityLine(lines, entry, "append_system_prompt_path");
  }
  if (include.has("summary")) {
    lines.push("", stringValue(entry.summary) ?? "(no summary)", "");
  } else {
    lines.push("");
  }
  return lines;
}

async function queryCalyxActivity(params: {
  query: OracleBundleActivityQueryV1;
  calyxCommand: string;
}): Promise<{ entries: OracleActivityEntry[]; warnings: OracleActivityQueryWarning[] }> {
  const args = ["run", "ps", "--json"];
  if (params.query.include_interactive) {
    args.push("--include-interactive");
  }
  if (params.query.host) {
    args.push("--host", params.query.host);
  }
  if (params.query.agent_kind !== "all") {
    args.push("--agent-kind", params.query.agent_kind);
  }
  if (params.query.since_hours !== undefined) {
    args.push("--since-hours", String(params.query.since_hours));
  }
  if (params.query.limit !== undefined) {
    args.push("--limit", String(params.query.limit));
  }

  try {
    const { stdout } = await execFileAsync(params.calyxCommand, args, { maxBuffer: 20 * 1024 * 1024 });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout) as unknown;
    } catch (error) {
      return {
        entries: [],
        warnings: [
          {
            code: "activity_query_invalid_json",
            message: `calyx run ps for activity query ${params.query.id} returned invalid JSON: ${errorMessage(error)}`,
          },
        ],
      };
    }
    if (!Array.isArray(parsed)) {
      return {
        entries: [],
        warnings: [
          {
            code: "activity_query_unexpected_shape",
            message: `calyx run ps for activity query ${params.query.id} did not return an array.`,
          },
        ],
      };
    }
    return {
      entries: parsed.filter(isRecord),
      warnings: [],
    };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    const warningCode = code === "ENOENT" ? "calyx_command_unavailable" : "activity_query_failed";
    return {
      entries: [],
      warnings: [
        {
          code: warningCode,
          message: `${params.calyxCommand} run ps failed for activity query ${params.query.id}: ${errorMessage(error)}`,
        },
      ],
    };
  }
}

async function materializeActivityProvider(params: {
  inquiryDir: string;
  recipe: OracleBundleRecipeV1;
  calyxCommand: string;
  warnings: OracleBundleApplyWarningV1[];
}): Promise<OracleBundleMaterializedOutputV1 | undefined> {
  if (params.recipe.activity.queries.length === 0) {
    return undefined;
  }

  const sections: string[] = [
    "# Activity Summary",
    "",
    "Generated from `calyx run ps --json` queries declared in `activity.queries`.",
    "",
  ];
  const provenanceQueries: Array<Record<string, unknown>> = [];
  const outputWarnings: string[] = [];

  for (const query of params.recipe.activity.queries) {
    const result = await queryCalyxActivity({ query, calyxCommand: params.calyxCommand });
    for (const warning of result.warnings) {
      params.warnings.push({ level: "warning", code: warning.code, message: warning.message, source: query.id });
      outputWarnings.push(`${warning.code}: ${warning.message}`);
    }
    const entries = sortActivityEntries(result.entries);
    provenanceQueries.push({
      id: query.id,
      host: query.host ?? null,
      since_hours: query.since_hours ?? null,
      include_interactive: query.include_interactive,
      agent_kind: query.agent_kind,
      limit: query.limit ?? null,
      include: query.include,
      entries: entries.length,
    });

    sections.push(`## Query: ${query.id}`, "");
    sections.push(`- host: ${query.host ?? "local"}`);
    sections.push(`- since_hours: ${query.since_hours ?? "default"}`);
    sections.push(`- include_interactive: ${query.include_interactive}`);
    sections.push(`- agent_kind: ${query.agent_kind}`);
    sections.push(`- include: ${query.include.join(", ")}`);
    sections.push(`- entries: ${entries.length}`, "");
    if (entries.length === 0) {
      sections.push("_No activity entries returned._", "");
      continue;
    }
    const include = new Set(query.include);
    for (const entry of entries) {
      sections.push(...renderActivityEntry(entry, include));
    }
  }

  return materializeTextOutput({
    inquiryDir: params.inquiryDir,
    relativePath: path.join("context", "activity-summary.md"),
    source: "activity",
    provider: "activity",
    required: true,
    text: `${sections.join("\n").trimEnd()}\n`,
    recipe: params.recipe,
    provenance: {
      command: params.calyxCommand,
      queries: provenanceQueries,
    },
    warnings: outputWarnings,
  });
}

interface CtxkitSessionSection {
  provider: string;
  sessionId: string;
  body: string;
}

function extractCtxkitSessionSections(output: string): CtxkitSessionSection[] {
  const lines = output.split("\n");
  const sections: CtxkitSessionSection[] = [];
  let current: { provider: string; sessionId: string; body: string[] } | undefined;
  const header = /^--- \.ctxkit\/sessions\/([^/]+)\/(.+) ---$/;

  for (const line of lines) {
    const match = header.exec(line);
    if (match) {
      if (current) {
        sections.push({ provider: current.provider, sessionId: current.sessionId, body: current.body.join("\n").trimEnd() });
      }
      current = { provider: match[1]!, sessionId: match[2]!, body: [] };
      continue;
    }
    if (line.startsWith("--- ") && current) {
      sections.push({ provider: current.provider, sessionId: current.sessionId, body: current.body.join("\n").trimEnd() });
      current = undefined;
    }
    if (current) {
      current.body.push(line);
    }
  }
  if (current) {
    sections.push({ provider: current.provider, sessionId: current.sessionId, body: current.body.join("\n").trimEnd() });
  }
  return sections;
}

function requestedSessionIds(session: OracleBundleSessionSourceV1): Set<string> {
  const ids = new Set<string>([session.id]);
  const addPathDerivedIds = (candidatePath: string | undefined): void => {
    if (!candidatePath?.trim()) {
      return;
    }
    const basename = path.basename(candidatePath.trim());
    ids.add(basename);
    const extension = path.extname(basename);
    if (extension) {
      ids.add(basename.slice(0, -extension.length));
    }
  };
  addPathDerivedIds(session.id);
  addPathDerivedIds(session.path);
  return ids;
}

function requestedSessionMatches(section: CtxkitSessionSection, session: OracleBundleSessionSourceV1): boolean {
  if (session.provider && section.provider !== session.provider) {
    return false;
  }
  return requestedSessionIds(session).has(section.sessionId);
}

function sessionCtxkitRoot(session: OracleBundleSessionSourceV1, fallbackRoot: string): string {
  if (session.root?.trim()) {
    return session.root.trim();
  }
  if (session.path?.trim()) {
    return path.dirname(session.path.trim());
  }
  return fallbackRoot;
}

async function materializeSessionProvider(params: {
  inquiryDir: string;
  recipe: OracleBundleRecipeV1;
  ctxCommand: string;
  warnings: OracleBundleApplyWarningV1[];
}): Promise<OracleBundleMaterializedOutputV1 | undefined> {
  if (params.recipe.sessions.length === 0) {
    return undefined;
  }

  const roots = [...new Set(params.recipe.sessions.map((session) => sessionCtxkitRoot(session, params.inquiryDir)))];
  const scopes = [...new Set(params.recipe.sessions.map((session) => session.scope).filter(Boolean))] as string[];
  const days = params.recipe.sessions.map((session) => session.days).filter((value): value is number => value !== undefined);
  const bytes = params.recipe.sessions.map((session) => session.bytes).filter((value): value is number => value !== undefined);
  const outputWarnings: string[] = [];
  if (scopes.length > 1) {
    const message = `Multiple session scopes requested (${scopes.join(", ")}); ctxkit accepts one scope per invocation, so --session-scope was omitted.`;
    params.warnings.push({ level: "warning", code: "session_scope_conflict", message, source: "sessions" });
    outputWarnings.push(message);
  }
  const args = [
    "--sessions",
    "--format",
    "markdown",
    ...(scopes.length === 1 ? ["--session-scope", scopes[0]!] : []),
    ...(days.length > 0 ? ["--session-days", String(Math.max(...days))] : []),
    ...(bytes.length > 0 ? ["--session-bytes", String(Math.max(...bytes))] : []),
    ...roots,
  ];

  let stdout = "";
  try {
    const result = await execFileAsync(params.ctxCommand, args, { maxBuffer: 20 * 1024 * 1024 });
    stdout = result.stdout;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    const warningCode = code === "ENOENT" ? "ctxkit_unavailable" : "ctxkit_session_failed";
    const message = `${params.ctxCommand} could not materialize selected session excerpts: ${errorMessage(error)}`;
    params.warnings.push({ level: "warning", code: warningCode, message, source: "sessions" });
    return materializeTextOutput({
      inquiryDir: params.inquiryDir,
      relativePath: path.join("context", "session-context.md"),
      source: "session",
      provider: "session",
      required: true,
      text: `# Session Context\n\n${message}\n`,
      recipe: params.recipe,
      provenance: {
        ctx_command: params.ctxCommand,
        roots,
        requested_sessions: params.recipe.sessions,
      },
      warnings: [...outputWarnings, message],
    });
  }

  const sections = extractCtxkitSessionSections(stdout);
  const rendered: string[] = [
    "# Session Context",
    "",
    "Selected excerpts delegated to ctxkit (`ctx --sessions`).",
    "",
  ];
  let included = 0;
  for (const session of params.recipe.sessions) {
    const match = sections.find((section) => requestedSessionMatches(section, session));
    if (!match) {
      const message = `ctxkit returned no matching session section for ${session.provider ? `${session.provider}/` : ""}${session.id}.`;
      params.warnings.push({ level: "warning", code: "session_excerpt_missing", message, source: session.id });
      outputWarnings.push(message);
      continue;
    }
    included += 1;
    rendered.push(`## ${match.provider}/${match.sessionId}`, "");
    rendered.push(`- requested_id: ${session.id}`);
    if (session.path) {
      rendered.push(`- session_path: ${session.path}`);
    }
    if (session.root) {
      rendered.push(`- root: ${session.root}`);
    }
    rendered.push("", match.body.trimEnd(), "");
  }

  if (included === 0) {
    rendered.push("_No requested session excerpts were materialized._", "");
  }

  return materializeTextOutput({
    inquiryDir: params.inquiryDir,
    relativePath: path.join("context", "session-context.md"),
    source: "session",
    provider: "session",
    required: true,
    text: `${rendered.join("\n").trimEnd()}\n`,
    recipe: params.recipe,
    provenance: {
      ctx_command: params.ctxCommand,
      roots,
      requested_sessions: params.recipe.sessions,
      matched_sessions: included,
    },
    warnings: outputWarnings,
  });
}

async function materializeArchiveRepo(params: {
  inquiryDir: string;
  recipe: OracleBundleRecipeV1;
  repo: OracleBundleRepoSourceV1;
  relativePath: string;
}): Promise<OracleBundleMaterializedOutputV1> {
  const outputPath = path.join(params.inquiryDir, params.relativePath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const args = ["-C", params.repo.path, "archive", "--format=zip", "--output", outputPath, "HEAD"];
  if (params.repo.include && params.repo.include.length > 0) {
    args.push(...params.repo.include);
  }
  try {
    await execFileAsync("git", args, {
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    throw createOracleBundleError(`Failed to archive repo ${params.repo.path}: ${errorMessage(error)}`, 2);
  }
  const buffer = await readFile(outputPath);
  return {
    kind: "generated",
    path: toPosixPath(params.relativePath),
    source: "repo",
    required: true,
    provider: "repo",
    sha256: sha256Buffer(buffer),
    bytes: buffer.byteLength,
    redaction: notApplicableRedaction(params.recipe.policy.redaction),
    provenance: {
      repo_path: params.repo.path,
      mode: "archive",
      include: params.repo.include ?? [],
      exclude: params.repo.exclude ?? [],
    },
    warnings: [
      "Repo archives are binary attachments; inspect source repo before upload.",
      ...((params.repo.exclude ?? []).length > 0 ? ["repos[].exclude is only honored by ctxpack mode in this slice."] : []),
    ],
  };
}

async function materializeCtxpackRepo(params: {
  inquiryDir: string;
  recipe: OracleBundleRecipeV1;
  repo: OracleBundleRepoSourceV1;
  relativePath: string;
  ctxCommand: string;
  warnings: OracleBundleApplyWarningV1[];
}): Promise<OracleBundleMaterializedOutputV1 | undefined> {
  const outputPath = path.join(params.inquiryDir, params.relativePath);
  const args = [
    "--format",
    "markdown",
    "--output",
    outputPath,
    ...((params.repo.include ?? []).flatMap((entry) => ["--include", entry])),
    ...((params.repo.exclude ?? []).flatMap((entry) => ["--exclude", entry])),
    params.repo.path,
  ];
  await mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await execFileAsync(params.ctxCommand, args, { maxBuffer: 20 * 1024 * 1024 });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    const warningCode = code === "ENOENT" ? "ctxkit_unavailable" : "ctxkit_failed";
    const message = `${params.ctxCommand} could not materialize repo ctxpack for ${params.repo.path}: ${errorMessage(error)}`;
    params.warnings.push({ level: "warning", code: warningCode, message, source: params.repo.path });
    return undefined;
  }
  const text = await readFile(outputPath, "utf8");
  return {
    kind: "generated",
    path: toPosixPath(params.relativePath),
    source: "repo",
    required: true,
    provider: "repo",
    sha256: sha256Buffer(text),
    bytes: Buffer.byteLength(text, "utf8"),
    redaction: notApplicableRedaction(params.recipe.policy.redaction),
    provenance: {
      repo_path: params.repo.path,
      mode: "ctxpack",
      ctx_command: params.ctxCommand,
      include: params.repo.include ?? [],
      exclude: params.repo.exclude ?? [],
    },
    warnings: [],
  };
}

export async function planOracleBundleV1(inquiryDir: string, recipePath = "inquiry.yaml"): Promise<OracleBundlePlanV1> {
  const resolvedInquiryDir = path.resolve(inquiryDir);
  const resolvedRecipePath = path.isAbsolute(recipePath) ? recipePath : path.join(resolvedInquiryDir, recipePath);
  const rawRecipe = await readFile(resolvedRecipePath, "utf8");
  const recipe = parseOracleBundleRecipeV1(rawRecipe, resolvedRecipePath);
  const recipeOutputPath = path.basename(resolvedRecipePath);
  const recipeHash = sha256(stableStringify(recipe));
  const outputs: OracleBundlePlanOutputV1[] = [
    { kind: "authored", path: "README.md", source: "init", required: true },
    { kind: "authored", path: recipeOutputPath, source: "init", required: true },
    { kind: "authored", path: recipe.prompt.path, source: "init", required: true },
    { kind: "authored", path: "oracle-response-skeleton.md", source: "response", required: true },
    { kind: "generated", path: path.posix.join("receipts", "bundle.plan.json"), source: "receipt", required: true },
    { kind: "generated", path: path.posix.join("receipts", "bundle.manifest.json"), source: "receipt", required: false },
  ];

  if (recipe.vault.files.length > 0 || recipe.vault.globs.length > 0 || recipe.vault.searches.length > 0) {
    outputs.push({ kind: "generated", path: path.posix.join("context", "vault-context.md"), source: "vault", required: true });
  }
  if (recipe.linear.issues.length > 0 || recipe.linear.context_path) {
    outputs.push({ kind: "generated", path: path.posix.join("context", "linear-context.json"), source: "linear", required: true });
  }
  if (recipe.activity.queries.length > 0) {
    outputs.push({ kind: "generated", path: path.posix.join("context", "activity-summary.md"), source: "activity", required: true });
  }
  if (recipe.sessions.length > 0) {
    outputs.push({ kind: "generated", path: path.posix.join("context", "session-context.md"), source: "session", required: true });
  }
  for (const repo of recipe.repos) {
    outputs.push({ kind: "generated", path: repoOutputPath(repo), source: "repo", required: true });
  }

  const budgetState = {
    estimatedBytes: rawRecipe.length,
    sourcesMeasured: 1,
    sourcesMissing: 0,
    warnings: [] as string[],
  };
  for (const vaultFile of recipe.vault.files) {
    const candidate = path.isAbsolute(vaultFile) ? vaultFile : path.join(resolveVaultPath(), vaultFile);
    const measured = await measureExistingFile(candidate);
    addMeasuredSource(
      measured,
      {
        missing: `Vault file not found during plan: ${vaultFile}`,
        unreadable: `Vault file unreadable during plan: ${vaultFile}`,
      },
      budgetState,
    );
  }
  if (recipe.linear.context_path) {
    const candidate = path.isAbsolute(recipe.linear.context_path)
      ? recipe.linear.context_path
      : path.join(resolvedInquiryDir, recipe.linear.context_path);
    const measured = await measureExistingFile(candidate);
    addMeasuredSource(
      measured,
      {
        missing: `Linear context file not found during plan: ${recipe.linear.context_path}`,
        unreadable: `Linear context file unreadable during plan: ${recipe.linear.context_path}`,
      },
      budgetState,
    );
  }

  const estimatedTokens = Math.ceil(budgetState.estimatedBytes / 4);
  const planSeed = {
    recipe_hash: recipeHash,
    outputs,
    estimated_tokens: estimatedTokens,
  };
  const planHash = sha256(stableStringify(planSeed));

  return {
    version: "oracle-bundle-plan/v1",
    inquiry_dir: resolvedInquiryDir,
    recipe_path: resolvedRecipePath,
    recipe_hash: recipeHash,
    plan_hash: planHash,
    outputs,
    budget: {
      ...(recipe.policy.budget_tokens ? { budget_tokens: recipe.policy.budget_tokens } : {}),
      estimated_tokens: estimatedTokens,
      estimated_bytes: budgetState.estimatedBytes,
      sources_measured: budgetState.sourcesMeasured,
      sources_missing: budgetState.sourcesMissing,
    },
    counts: {
      variants: recipe.variants.length,
      vault_files: recipe.vault.files.length,
      vault_globs: recipe.vault.globs.length,
      vault_searches: recipe.vault.searches.length,
      linear_issues: recipe.linear.issues.length,
      repos: recipe.repos.length,
      sessions: recipe.sessions.length,
      activity_queries: recipe.activity.queries.length,
    },
    warnings: budgetState.warnings,
  };
}

export async function applyOracleBundleV1(
  inquiryDir: string,
  options: OracleBundleApplyOptionsV1 = {},
): Promise<OracleBundleApplyResultV1> {
  const resolvedInquiryDir = path.resolve(inquiryDir);
  const recipePath = options.recipePath ?? "inquiry.yaml";
  const resolvedRecipePath = path.isAbsolute(recipePath) ? recipePath : path.join(resolvedInquiryDir, recipePath);
  const recipe = await readOracleBundleRecipeV1(resolvedRecipePath);
  const plan = await planOracleBundleV1(resolvedInquiryDir, recipePath);
  const warnings: OracleBundleApplyWarningV1[] = plan.warnings.map((message) => ({
    level: "warning",
    code: "plan_warning",
    message,
  }));
  const outputs: OracleBundleMaterializedOutputV1[] = [];

  const receiptsDir = path.join(resolvedInquiryDir, "receipts");
  const planReceiptPath = path.join(receiptsDir, "bundle.plan.json");
  const manifestPath = path.join(receiptsDir, "bundle.manifest.json");
  await writeJsonFile(planReceiptPath, plan);
  const planReceiptRaw = await readFile(planReceiptPath, "utf8");
  outputs.push({
    kind: "generated",
    path: toPosixPath(path.join("receipts", "bundle.plan.json")),
    source: "receipt",
    required: true,
    provider: "core",
    sha256: sha256Buffer(planReceiptRaw),
    bytes: Buffer.byteLength(planReceiptRaw, "utf8"),
    redaction: notApplicableRedaction(recipe.policy.redaction),
    provenance: {
      plan_hash: plan.plan_hash,
      recipe_hash: plan.recipe_hash,
    },
    warnings: [],
  });

  const vaultOutput = await materializeVaultProvider({
    inquiryDir: resolvedInquiryDir,
    recipe,
    vaultPath: resolveVaultPath(options.vaultPath),
    warnings,
  });
  if (vaultOutput) {
    outputs.push(vaultOutput);
  }

  const linearOutput = await materializeLinearProvider({
    inquiryDir: resolvedInquiryDir,
    recipe,
    warnings,
  });
  if (linearOutput) {
    outputs.push(linearOutput);
  }

  const activityOutput = await materializeActivityProvider({
    inquiryDir: resolvedInquiryDir,
    recipe,
    calyxCommand: options.calyxCommand ?? "calyx",
    warnings,
  });
  if (activityOutput) {
    outputs.push(activityOutput);
  }

  const sessionOutput = await materializeSessionProvider({
    inquiryDir: resolvedInquiryDir,
    recipe,
    ctxCommand: options.ctxCommand ?? "ctx",
    warnings,
  });
  if (sessionOutput) {
    outputs.push(sessionOutput);
  }

  for (const repo of recipe.repos) {
    const relativePath = repoOutputPath(repo);
    if (repo.mode === "archive") {
      outputs.push(await materializeArchiveRepo({ inquiryDir: resolvedInquiryDir, recipe, repo, relativePath }));
    } else {
      const output = await materializeCtxpackRepo({
        inquiryDir: resolvedInquiryDir,
        recipe,
        repo,
        relativePath,
        ctxCommand: options.ctxCommand ?? "ctx",
        warnings,
      });
      if (output) {
        outputs.push(output);
      }
    }
  }

  const redactionEvents = outputs.flatMap((output) => output.redaction.events);
  const manifest: OracleBundleManifestV1 = {
    version: "oracle-bundle-manifest/v1",
    inquiry_dir: resolvedInquiryDir,
    recipe_path: resolvedRecipePath,
    recipe_hash: plan.recipe_hash,
    plan_hash: plan.plan_hash,
    generated_at: (options.now ?? new Date()).toISOString(),
    outputs,
    warnings,
    redaction: {
      mode: recipe.policy.redaction,
      redacted_outputs: outputs.filter((output) => output.redaction.status === "redacted").length,
      redaction_events: redactionEvents.length,
    },
  };
  await writeJsonFile(manifestPath, manifest);

  return {
    version: "oracle-bundle-apply/v1",
    inquiry_dir: resolvedInquiryDir,
    plan,
    manifest,
    manifest_path: manifestPath,
    plan_receipt_path: planReceiptPath,
  };
}

export async function planOracleRunV1(
  inquiryDir: string,
  options: OracleRunPlanOptionsV1 = {},
): Promise<OracleRunPlanV1> {
  const resolvedInquiryDir = path.resolve(inquiryDir);
  const recipePath = options.recipePath ?? "inquiry.yaml";
  const manifestPath = options.manifestPath ?? path.join("receipts", "bundle.manifest.json");
  const resolvedRecipePath = path.isAbsolute(recipePath) ? recipePath : path.join(resolvedInquiryDir, recipePath);
  const resolvedManifestPath = path.isAbsolute(manifestPath) ? manifestPath : path.join(resolvedInquiryDir, manifestPath);
  const provider = normalizeOracleRunProvider(options.provider);
  const model = (options.model ?? DEFAULT_ORACLE_GEMINI_MODEL_V1).trim();
  assertOracleRunModelAllowed(provider, model);
  const variant = normalizeSlug(options.variant ?? "sandbox", "variant");

  const recipe = await readOracleBundleRecipeV1(resolvedRecipePath);
  const manifest = await readOracleBundleManifestV1(resolvedManifestPath);
  const manifestRaw = await readFile(resolvedManifestPath, "utf8");
  const promptAbsolutePath = path.join(resolvedInquiryDir, recipe.prompt.path);
  const promptText = await readFile(promptAbsolutePath, "utf8");
  const promptBytes = Buffer.byteLength(promptText, "utf8");
  const warnings: OracleBundleApplyWarningV1[] = [...manifest.warnings];
  const attachments: OracleRunAttachmentV1[] = [];

  for (const output of manifest.outputs.filter(isOracleRunAttachmentOutput)) {
    const absolutePath = path.join(resolvedInquiryDir, output.path);
    try {
      const outputStat = await stat(absolutePath);
      if (!outputStat.isFile()) {
        warnings.push(oracleWarning("attachment_unreadable", `${output.path} is not a readable file.`, output.path));
        continue;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(oracleWarning("attachment_missing", `${output.path} is missing or unreadable: ${message}`, output.path));
      continue;
    }
    attachments.push({
      path: output.path,
      absolute_path: absolutePath,
      source: output.source,
      provider: output.provider,
      sha256: output.sha256,
      bytes: output.bytes,
      mime_type: mimeTypeForPath(output.path),
      upload_required: true,
    });
  }

  if (attachments.some((attachment) => attachment.mime_type === "application/zip")) {
    warnings.push(
      oracleWarning(
        "archive_upload_explicit",
        "Gemini file upload will receive at least one archive attachment; if the provider rejects it, rerun the bundle with ctxpack/text outputs or use human web mode.",
      ),
    );
  }

  const responsePath = responsePathForOracleRun(provider, variant, options.responsePath);
  const receiptPath = receiptPathForOracleRun(provider, variant);
  const estimatedBytes = promptBytes + attachments.reduce((total, attachment) => total + attachment.bytes, 0);
  const hashBasis = {
    provider,
    model,
    variant,
    prompt: {
      path: recipe.prompt.path,
      sha256: sha256Buffer(promptText),
      bytes: promptBytes,
    },
    manifest: {
      path: toPosixPath(path.relative(resolvedInquiryDir, resolvedManifestPath)),
      sha256: sha256Buffer(manifestRaw),
      recipe_hash: manifest.recipe_hash,
      plan_hash: manifest.plan_hash,
    },
    response_path: responsePath,
    attachments: attachments.map((attachment) => ({
      path: attachment.path,
      sha256: attachment.sha256,
      bytes: attachment.bytes,
      mime_type: attachment.mime_type,
    })),
  };
  const runPlanHash = sha256(stableStringify(hashBasis));
  const ready = warnings.every((warning) => warning.code !== "attachment_missing" && warning.code !== "attachment_unreadable");

  return {
    version: "oracle-run-plan/v1",
    inquiry_dir: resolvedInquiryDir,
    provider,
    model,
    variant,
    run_plan_hash: runPlanHash,
    ready,
    dry_run_only: Boolean(options.dryRunOnly),
    prompt: {
      path: recipe.prompt.path,
      absolute_path: promptAbsolutePath,
      sha256: sha256Buffer(promptText),
      bytes: promptBytes,
      estimated_tokens: estimateTokensFromBytes(promptBytes),
    },
    manifest: {
      path: toPosixPath(path.relative(resolvedInquiryDir, resolvedManifestPath)),
      absolute_path: resolvedManifestPath,
      sha256: sha256Buffer(manifestRaw),
      recipe_hash: manifest.recipe_hash,
      plan_hash: manifest.plan_hash,
      generated_at: manifest.generated_at,
    },
    response_path: responsePath,
    receipt_path: receiptPath,
    attachments,
    budget: {
      estimated_tokens: estimateTokensFromBytes(estimatedBytes),
      estimated_bytes: estimatedBytes,
      attachment_count: attachments.length,
    },
    warnings,
  };
}

export async function writeOracleRunResultV1(options: OracleRunWriteOptionsV1): Promise<OracleRunWriteResultV1> {
  const startedAt = options.startedAt ?? new Date();
  const completedAt = options.completedAt ?? new Date();
  const responseAbsolutePath = path.join(options.plan.inquiry_dir, options.plan.response_path);
  const receiptAbsolutePath = path.join(options.plan.inquiry_dir, options.plan.receipt_path);
  const responseFrontmatter = {
    type: "daily",
    created: isoDate(completedAt),
    author: `oracle (${options.plan.provider})`,
    provider: options.plan.provider,
    model: options.plan.model,
    variant: options.plan.variant,
    source_manifest_hash: options.plan.manifest.sha256,
    source_manifest_path: options.plan.manifest.path,
    prompt_hash: options.plan.prompt.sha256,
    run_plan_hash: options.plan.run_plan_hash,
    receipt: options.plan.receipt_path,
    tags: ["oracle", "response", options.plan.provider],
  };
  const responseMarkdown = `---\n${YAML.stringify(responseFrontmatter).trimEnd()}\n---\n\n# Oracle Response: ${options.plan.variant}\n\n${options.responseText.trim()}\n`;
  const responseHash = sha256Buffer(responseMarkdown);

  await mkdir(path.dirname(responseAbsolutePath), { recursive: true });
  await writeFile(responseAbsolutePath, responseMarkdown, "utf8");

  const receipt: OracleRunReceiptV1 = {
    version: "oracle-run-receipt/v1",
    inquiry_dir: options.plan.inquiry_dir,
    provider: options.plan.provider,
    model: options.plan.model,
    variant: options.plan.variant,
    status: "succeeded",
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    run_plan_hash: options.plan.run_plan_hash,
    manifest_hash: options.plan.manifest.sha256,
    prompt_hash: options.plan.prompt.sha256,
    response_hash: responseHash,
    response_path: options.plan.response_path,
    attachments: options.plan.attachments,
    ...(options.usage ? { usage: options.usage } : {}),
    ...(options.providerResponseId ? { provider_response_id: options.providerResponseId } : {}),
    warnings: options.plan.warnings,
  };
  await writeJsonFile(receiptAbsolutePath, receipt);

  return {
    version: "oracle-run-result/v1",
    inquiry_dir: options.plan.inquiry_dir,
    response_path: responseAbsolutePath,
    receipt_path: receiptAbsolutePath,
    receipt,
  };
}

export async function synthesizeOracleResponsesV1(
  inquiryDir: string,
  options: OracleSynthesisOptionsV1 = {},
): Promise<OracleSynthesisResultV1> {
  const resolvedInquiryDir = path.resolve(inquiryDir);
  const outputPath = safeRelativePath(options.outputPath ?? "oracle-synthesis.md", "outputPath");
  const synthesisAbsolutePath = path.join(resolvedInquiryDir, outputPath);
  const entries = await readdir(resolvedInquiryDir, { withFileTypes: true });
  const responses: OracleSynthesisResponseV1[] = [];
  const warnings: OracleBundleApplyWarningV1[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!/^oracle-response.*\.md$/.test(entry.name) || entry.name === "oracle-response-skeleton.md") {
      continue;
    }
    const absolutePath = path.join(resolvedInquiryDir, entry.name);
    const raw = await readFile(absolutePath, "utf8");
    responses.push({
      path: entry.name,
      absolute_path: absolutePath,
      sha256: sha256Buffer(raw),
      bytes: Buffer.byteLength(raw, "utf8"),
    });
  }

  responses.sort((first, second) => first.path.localeCompare(second.path));
  if (responses.length === 0) {
    warnings.push(oracleWarning("no_oracle_responses", "No oracle-response*.md files were found to synthesize."));
  }

  if (!options.dryRun) {
    if (existsSync(synthesisAbsolutePath) && !options.force) {
      throw createOracleBundleError(`${outputPath} already exists. Pass --force to overwrite.`);
    }
    const now = options.now ?? new Date();
    const responseList = responses.length > 0
      ? responses.map((response) => `- \`${response.path}\` (${response.bytes} bytes, sha256:${response.sha256.slice(0, 12)})`).join("\n")
      : "- No response files found yet.";
    const synthesisMarkdown = `---\ntype: daily\ncreated: ${isoDate(now)}\nauthor: primary-agent\ntags: [oracle, synthesis]\n---\n\n# Oracle Synthesis\n\n## Source Responses\n\n${responseList}\n\n## Strong Convergence\n\n## Disagreements / Human Judgment\n\n## Plan Updates\n\n## Linear / PR Receipts\n\n`;
    await mkdir(path.dirname(synthesisAbsolutePath), { recursive: true });
    await writeFile(synthesisAbsolutePath, synthesisMarkdown, "utf8");
  }

  return {
    version: "oracle-synthesis/v1",
    inquiry_dir: resolvedInquiryDir,
    synthesis_path: synthesisAbsolutePath,
    responses,
    warnings,
    wrote: !options.dryRun,
  };
}

export async function doctorOracleBundleV1(inquiryDir: string, recipePath = "inquiry.yaml"): Promise<OracleBundleDoctorResultV1> {
  const resolvedInquiryDir = path.resolve(inquiryDir);
  const findings: OracleBundleDoctorFindingV1[] = [];
  const resolvedRecipePath = path.isAbsolute(recipePath) ? recipePath : path.join(resolvedInquiryDir, recipePath);
  let recipe: OracleBundleRecipeV1 | undefined;
  try {
    recipe = await readOracleBundleRecipeV1(resolvedRecipePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push({ level: "error", code: "recipe_invalid", message, path: resolvedRecipePath });
  }

  if (recipe) {
    const recipeOutputPath = path.basename(resolvedRecipePath);
    await checkReadableFile(findings, resolvedRecipePath, recipeOutputPath, "missing_authored_file", "authored_file_unreadable");
    for (const relativePath of ["README.md", recipe.prompt.path, "oracle-response-skeleton.md"]) {
      const absolutePath = path.join(resolvedInquiryDir, relativePath);
      await checkReadableFile(findings, absolutePath, relativePath, "missing_authored_file", "authored_file_unreadable");
    }
    if (recipe.linear.context_path) {
      const linearContextPath = path.join(resolvedInquiryDir, recipe.linear.context_path);
      await checkReadableFile(findings, linearContextPath, recipe.linear.context_path, "linear_context_missing", "linear_context_unreadable");
    }
    const promptPath = path.join(resolvedInquiryDir, recipe.prompt.path);
    if (existsSync(promptPath)) {
      try {
        const promptText = await readFile(promptPath, "utf8");
        if (promptText.trim().length === 0) {
          findings.push({ level: "error", code: "empty_prompt", message: "Oracle prompt is empty.", path: promptPath });
        }
      } catch (error) {
        findings.push({
          level: "error",
          code: "prompt_unreadable",
          message: `Oracle prompt file unreadable: ${errorMessage(error)}`,
          path: promptPath,
        });
      }
    }
    if (
      recipe.vault.files.length === 0 &&
      recipe.vault.globs.length === 0 &&
      recipe.vault.searches.length === 0 &&
      recipe.linear.issues.length === 0 &&
      !recipe.linear.context_path &&
      recipe.repos.length === 0 &&
      recipe.sessions.length === 0 &&
      recipe.activity.queries.length === 0
    ) {
      findings.push({ level: "warning", code: "no_context_sources", message: "Recipe has no context sources yet." });
    }
    if (!existsSync(path.join(resolvedInquiryDir, "receipts", "bundle.manifest.json"))) {
      findings.push({
        level: "warning",
        code: "manifest_missing",
        message: "Bundle manifest is missing; run a future --apply materialization before upload.",
      });
    }
  }

  return {
    ok: findings.every((finding) => finding.level !== "error"),
    inquiry_dir: resolvedInquiryDir,
    findings,
  };
}
