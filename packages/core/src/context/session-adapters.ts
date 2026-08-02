import { accessSync, constants, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type {
  CtxpackAdapterErrorCodeV1,
  CtxpackCapabilityEvidenceV1,
  CtxpackCapabilityReasonCodeV1,
  CtxpackNormalizedSessionV1,
  CtxpackProviderAliasTraceV1,
  CtxpackProviderCapabilityFlagsV1,
  CtxpackProviderDetectionReportV1,
  CtxpackProviderIdV1,
  CtxpackProviderSessionRecordV1,
  CtxpackSessionHandleV1,
  CtxpackSessionListQueryV1,
  SessionProviderAdapter
} from "../types";

const FIRST_PARTY_SESSION_PROVIDERS_V1 = ["claude", "codex", "gemini", "hermes"] as const;

type FirstPartySessionProvider = (typeof FIRST_PARTY_SESSION_PROVIDERS_V1)[number];

const PROVIDER_ALIAS_REGISTRY_V1: Record<CtxpackProviderIdV1, readonly string[]> = {
  claude: ["claude", "claude-code", "claude_code", "anthropic-claude", "anthropic_claude"],
  codex: ["codex", "openai-codex", "openai_codex", "chatgpt-codex"],
  aider: ["aider"],
  continue: ["continue", "continue-dev", "continue_dev"],
  cursor: ["cursor"],
  gemini: ["gemini", "gemini-cli", "gemini_cli"],
  hermes: ["hermes", "hermes-cli", "hermes_cli"],
  windsurf: ["windsurf", "codeium-windsurf", "codeium_windsurf"],
  zed: ["zed", "zed-ai", "zed_ai"]
};

const ADAPTER_ERROR_TO_REASON_CODE_V1: Record<CtxpackAdapterErrorCodeV1, CtxpackCapabilityReasonCodeV1> = {
  ADAPTER_NOT_INSTALLED: "adapter_not_installed",
  ADAPTER_PATH_MISSING: "adapter_path_missing",
  ADAPTER_PERMISSION_DENIED: "adapter_permission_denied",
  ADAPTER_PARSE_ERROR: "adapter_parse_error",
  ADAPTER_UNSUPPORTED_VERSION: "adapter_unsupported_version",
  ADAPTER_INTERNAL: "adapter_internal"
};

interface ProbeCandidate {
  probe: string;
  root_path: string;
}

interface ProbeFailure {
  result: "missing" | "error";
  detail: string;
  reason_code: CtxpackCapabilityReasonCodeV1;
}

interface AliasNormalizationResult {
  providers: CtxpackProviderIdV1[];
  traces: CtxpackProviderAliasTraceV1[];
  unknown: CtxpackProviderAliasTraceV1[];
}

interface TimestampCandidate {
  value: string;
  iso: string;
}

interface HermesCandidateRoot {
  probe: string;
  root_path: string;
  state_db_path: string;
}

interface HermesResolvedSessionTable {
  table: string;
  sessionIdColumn: string;
  createdAtColumn?: string;
  updatedAtColumn?: string;
}

interface HermesResolvedMessageTable {
  table: string;
  sessionIdColumn: string;
  roleColumn?: string;
  contentColumn?: string;
  timestampColumn?: string;
}

const HERMES_STATE_DB_FILE = "state.db";
const HERMES_SESSION_DIAGNOSTIC_DIR = "sessions";
const SQLITE_MAX_BUFFER = 16 * 1024 * 1024;

const HERMES_SESSION_TABLE_CANDIDATES = [
  "sessions",
  "session",
  "conversation_sessions",
  "conversations",
  "threads",
  "chat_sessions"
] as const;

const HERMES_MESSAGE_TABLE_CANDIDATES = [
  "messages",
  "session_messages",
  "conversation_messages",
  "chat_messages",
  "events",
  "entries",
  "turns"
] as const;

const HERMES_SESSION_ID_COLUMN_CANDIDATES = [
  "session_id",
  "id",
  "uuid",
  "thread_id",
  "conversation_id"
] as const;

const HERMES_MESSAGE_SESSION_ID_COLUMN_CANDIDATES = [
  "session_id",
  "conversation_id",
  "thread_id",
  "chat_id",
  "parent_session_id"
] as const;

const HERMES_CREATED_AT_COLUMN_CANDIDATES = [
  "created_at",
  "createdat",
  "started_at",
  "startedat",
  "created",
  "timestamp"
] as const;

const HERMES_UPDATED_AT_COLUMN_CANDIDATES = [
  "updated_at",
  "updatedat",
  "last_event_at",
  "last_event_ts",
  "last_message_at",
  "modified_at",
  "modifiedat",
  "timestamp"
] as const;

const HERMES_ROLE_COLUMN_CANDIDATES = ["role", "author_role", "sender_role", "speaker", "type"] as const;
const HERMES_CONTENT_COLUMN_CANDIDATES = ["content", "text", "body", "message", "payload", "data"] as const;
const HERMES_MESSAGE_TIMESTAMP_COLUMN_CANDIDATES = [
  "timestamp",
  "created_at",
  "createdat",
  "event_time",
  "eventtime",
  "time",
  "ts"
] as const;

export class SessionProviderAdapterError extends Error {
  readonly code: CtxpackAdapterErrorCodeV1;
  readonly provider: CtxpackProviderIdV1 | "unknown";
  readonly details?: Record<string, unknown>;

  constructor(
    code: CtxpackAdapterErrorCodeV1,
    message: string,
    provider: CtxpackProviderIdV1 | "unknown",
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "SessionProviderAdapterError";
    this.code = code;
    this.provider = provider;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

function canonicalSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const PROVIDER_ALIAS_INDEX_V1: ReadonlyMap<string, { provider: CtxpackProviderIdV1; alias: string }> = (() => {
  const index = new Map<string, { provider: CtxpackProviderIdV1; alias: string }>();
  for (const [provider, aliases] of Object.entries(PROVIDER_ALIAS_REGISTRY_V1) as Array<[CtxpackProviderIdV1, readonly string[]]>) {
    for (const alias of aliases) {
      const slug = canonicalSlug(alias);
      if (!slug) {
        continue;
      }
      if (!index.has(slug)) {
        index.set(slug, { provider, alias });
      }
    }
  }
  return index;
})();

function normalizeProviderAlias(rawProvider: string): CtxpackProviderAliasTraceV1 {
  const canonical = canonicalSlug(rawProvider);
  const resolved = PROVIDER_ALIAS_INDEX_V1.get(canonical);

  if (!resolved) {
    return {
      input: rawProvider,
      canonical_slug: canonical
    };
  }

  return {
    input: rawProvider,
    canonical_slug: canonical,
    canonical_provider: resolved.provider,
    matched_alias: resolved.alias
  };
}

function normalizeRequestedProviders(rawProviders: readonly string[] | undefined): AliasNormalizationResult {
  if (!rawProviders) {
    return { providers: [], traces: [], unknown: [] };
  }

  const providers: CtxpackProviderIdV1[] = [];
  const traces: CtxpackProviderAliasTraceV1[] = [];
  const unknown: CtxpackProviderAliasTraceV1[] = [];
  const seen = new Set<CtxpackProviderIdV1>();

  for (const rawProvider of rawProviders) {
    const trace = normalizeProviderAlias(rawProvider);
    traces.push(trace);

    if (!trace.canonical_provider) {
      unknown.push(trace);
      continue;
    }

    if (seen.has(trace.canonical_provider)) {
      continue;
    }
    seen.add(trace.canonical_provider);
    providers.push(trace.canonical_provider);
  }

  return { providers, traces, unknown };
}

function fileProbeFailure(error: unknown): ProbeFailure {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";

  if (code === "ENOENT" || code === "ENOTDIR") {
    return {
      result: "missing",
      detail: "path_not_found",
      reason_code: "adapter_path_missing"
    };
  }

  if (code === "EACCES" || code === "EPERM") {
    return {
      result: "error",
      detail: "permission_denied",
      reason_code: "adapter_permission_denied"
    };
  }

  return {
    result: "error",
    detail: "probe_failed",
    reason_code: "adapter_internal"
  };
}

function toAdapterErrorCode(reasonCode: CtxpackCapabilityReasonCodeV1): CtxpackAdapterErrorCodeV1 {
  switch (reasonCode) {
    case "adapter_not_installed":
      return "ADAPTER_NOT_INSTALLED";
    case "adapter_path_missing":
      return "ADAPTER_PATH_MISSING";
    case "adapter_permission_denied":
      return "ADAPTER_PERMISSION_DENIED";
    case "adapter_parse_error":
      return "ADAPTER_PARSE_ERROR";
    case "adapter_unsupported_version":
      return "ADAPTER_UNSUPPORTED_VERSION";
    case "adapter_internal":
      return "ADAPTER_INTERNAL";
    default:
      return "ADAPTER_INTERNAL";
  }
}

function quoteSqlIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function toSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runSqliteQueryViaTabOutputV1(dbPath: string, sql: string): Array<Record<string, string>> {
  const output = execFileSync(
    "sqlite3",
    ["-readonly", "-header", "-separator", "\t", dbPath, sql],
    {
      encoding: "utf8",
      maxBuffer: SQLITE_MAX_BUFFER
    }
  );

  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }

  const lines = trimmed.split(/\r?\n/);
  if (lines.length === 0) {
    return [];
  }

  const header = lines[0]?.split("\t") ?? [];
  if (header.length === 0) {
    return [];
  }

  const records: Array<Record<string, string>> = [];
  for (const line of lines.slice(1)) {
    if (!line) {
      continue;
    }
    const cells = line.split("\t");
    const record: Record<string, string> = {};
    for (let index = 0; index < header.length; index += 1) {
      const key = header[index];
      if (!key) {
        continue;
      }
      record[key] = cells[index] ?? "";
    }
    records.push(record);
  }

  return records;
}

function runSqliteQueryV1(dbPath: string, sql: string): Array<Record<string, string>> {
  try {
    const jsonOutput = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
      encoding: "utf8",
      maxBuffer: SQLITE_MAX_BUFFER
    }).trim();

    if (!jsonOutput) {
      return [];
    }

    const parsed = JSON.parse(jsonOutput) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("sqlite3 -json output was not an array");
    }

    const records: Array<Record<string, string>> = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const record: Record<string, string> = {};
      for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
        record[key] = value == null ? "" : String(value);
      }
      records.push(record);
    }
    return records;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return runSqliteQueryViaTabOutputV1(dbPath, sql);
    }
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("unknown option") || message.includes("illegal option")) {
      return runSqliteQueryViaTabOutputV1(dbPath, sql);
    }
    throw error;
  }
}

function parseTimestampValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value >= 1_000_000_000_000 ? value : value * 1_000;
    const parsed = new Date(millis);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
    return undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return parseTimestampValue(Number(trimmed));
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString();
}

function lowerCaseLookup(values: readonly string[]): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const value of values) {
    lookup.set(value.toLowerCase(), value);
  }
  return lookup;
}

function pickColumnName(columns: readonly string[], preferred: readonly string[]): string | undefined {
  const lookup = lowerCaseLookup(columns);
  for (const candidate of preferred) {
    const matched = lookup.get(candidate);
    if (matched) {
      return matched;
    }
  }
  return undefined;
}

function listSqliteTables(dbPath: string): string[] {
  const rows = runSqliteQueryV1(
    dbPath,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
  );
  return rows
    .map((row) => row.name?.trim())
    .filter((name): name is string => Boolean(name));
}

function listSqliteTableColumns(dbPath: string, table: string): string[] {
  const rows = runSqliteQueryV1(dbPath, `PRAGMA table_info(${quoteSqlIdentifier(table)});`);
  return rows
    .map((row) => row.name?.trim())
    .filter((name): name is string => Boolean(name));
}

function candidateRootsForProvider(provider: FirstPartySessionProvider): ProbeCandidate[] {
  const home = homedir();

  const candidates: ProbeCandidate[] = [];
  const seen = new Set<string>();
  let hasExplicitOverride = false;

  function pushCandidate(probe: string, rootPath: string | undefined, explicitOverride = false): void {
    if (!rootPath || rootPath.trim().length === 0) {
      return;
    }
    const expanded = rootPath.startsWith("~/") ? path.join(home, rootPath.slice(2)) : rootPath;
    const normalized = path.resolve(expanded);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push({ probe, root_path: normalized });
    if (explicitOverride) {
      hasExplicitOverride = true;
    }
  }

  if (provider === "codex") {
    pushCandidate("env:CALYX_CONTEXT_CODEX_SESSIONS_ROOT", process.env.CALYX_CONTEXT_CODEX_SESSIONS_ROOT, true);
    pushCandidate("env:CODEX_SESSIONS_ROOT", process.env.CODEX_SESSIONS_ROOT, true);
    if (hasExplicitOverride) {
      return candidates;
    }
    if (process.env.CODEX_HOME?.trim()) {
      pushCandidate("env:CODEX_HOME/sessions", path.join(process.env.CODEX_HOME.trim(), "sessions"), true);
    }
    if (hasExplicitOverride) {
      return candidates;
    }
    pushCandidate("default:~/.codex/sessions", path.join(home, ".codex", "sessions"));
  } else if (provider === "claude") {
    pushCandidate("env:CALYX_CONTEXT_CLAUDE_SESSIONS_ROOT", process.env.CALYX_CONTEXT_CLAUDE_SESSIONS_ROOT, true);
    pushCandidate("env:CLAUDE_SESSIONS_ROOT", process.env.CLAUDE_SESSIONS_ROOT, true);
    if (hasExplicitOverride) {
      return candidates;
    }
    if (process.env.CLAUDE_HOME?.trim()) {
      const claudeHome = process.env.CLAUDE_HOME.trim();
      pushCandidate("env:CLAUDE_HOME/tasks", path.join(claudeHome, "tasks"), true);
      pushCandidate("env:CLAUDE_HOME/projects", path.join(claudeHome, "projects"), true);
    }
    if (hasExplicitOverride) {
      return candidates;
    }
    pushCandidate("default:~/.claude/tasks", path.join(home, ".claude", "tasks"));
    pushCandidate("default:~/.claude/projects", path.join(home, ".claude", "projects"));
  } else if (provider === "gemini") {
    pushCandidate("env:CALYX_CONTEXT_GEMINI_SESSIONS_ROOT", process.env.CALYX_CONTEXT_GEMINI_SESSIONS_ROOT, true);
    pushCandidate("env:GEMINI_SESSIONS_ROOT", process.env.GEMINI_SESSIONS_ROOT, true);
    if (hasExplicitOverride) {
      return candidates;
    }
    if (process.env.GEMINI_CLI_HOME?.trim()) {
      const geminiHome = process.env.GEMINI_CLI_HOME.trim();
      pushCandidate("env:GEMINI_CLI_HOME", geminiHome, true);
      pushCandidate("env:GEMINI_CLI_HOME/tmp", path.join(geminiHome, "tmp"), true);
    }
    if (hasExplicitOverride) {
      return candidates;
    }
    pushCandidate("default:~/.gemini", path.join(home, ".gemini"));
  } else {
    if (process.env.CALYX_CONTEXT_HERMES_STATE_DB?.trim()) {
      const stateDbPath = process.env.CALYX_CONTEXT_HERMES_STATE_DB.trim();
      pushCandidate("env:CALYX_CONTEXT_HERMES_STATE_DB", path.dirname(stateDbPath), true);
    }
    pushCandidate("env:CALYX_CONTEXT_HERMES_HOME", process.env.CALYX_CONTEXT_HERMES_HOME, true);
    if (hasExplicitOverride) {
      return candidates;
    }
    pushCandidate("env:HERMES_HOME", process.env.HERMES_HOME, true);
    if (hasExplicitOverride) {
      return candidates;
    }
    pushCandidate("default:~/.hermes", path.join(home, ".hermes"));
  }

  return candidates;
}

function isSessionFile(fileName: string): boolean {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith(".lock")) {
    return false;
  }
  return lowered.endsWith(".jsonl") || lowered.endsWith(".json");
}

function collectSessionFiles(
  rootPath: string,
  includeSessionFile: (absolutePath: string, entry: Dirent<string>) => boolean
): string[] {
  const files: string[] = [];
  const queue: string[] = [rootPath];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    let entries: Array<Dirent<string>>;
    try {
      entries = readdirSync(current, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!isSessionFile(entry.name)) {
        continue;
      }
      if (!includeSessionFile(absolute, entry)) {
        continue;
      }
      files.push(absolute);
    }
  }

  return files;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    const records: Record<string, unknown>[] = [];
    for (const item of value) {
      if (!isRecord(item)) {
        throw new Error("session array payload must contain only object entries");
      }
      records.push(item);
    }
    return records;
  }

  if (isRecord(value)) {
    return [value];
  }

  throw new Error("session payload must be an object or object array");
}

function parseSessionDocument(filePath: string, raw: string): Record<string, unknown>[] {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".json") {
    return asRecordArray(JSON.parse(raw));
  }

  const entries: Record<string, unknown>[] = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    const parsed = JSON.parse(line);
    if (!isRecord(parsed)) {
      throw new Error(`line ${index + 1} is not a JSON object`);
    }
    entries.push(parsed);
  }
  return entries;
}

function extractTimestamp(entry: Record<string, unknown>): TimestampCandidate | undefined {
  const keys = [
    "timestamp",
    "time",
    "ts",
    "created_at",
    "createdAt",
    "updated_at",
    "updatedAt",
    "event_time",
    "eventTime"
  ] as const;

  for (const key of keys) {
    const value = entry[key];
    const iso = parseTimestampValue(value);
    if (!iso) {
      continue;
    }
    return { value: String(value), iso };
  }

  return undefined;
}

function extractGeminiContent(contentRaw: unknown): string {
  if (typeof contentRaw === "string") {
    return contentRaw;
  }

  if (Array.isArray(contentRaw)) {
    const parts: string[] = [];
    for (const part of contentRaw) {
      if (typeof part === "string") {
        if (part.trim().length > 0) {
          parts.push(part);
        }
        continue;
      }
      if (isRecord(part)) {
        if (typeof part["text"] === "string" && part["text"].trim().length > 0) {
          parts.push(part["text"]);
          continue;
        }
        if (typeof part["content"] === "string" && part["content"].trim().length > 0) {
          parts.push(part["content"]);
          continue;
        }
        const serialized = JSON.stringify(part);
        if (serialized && serialized !== "{}") {
          parts.push(serialized);
        }
        continue;
      }
      if (part !== undefined && part !== null) {
        parts.push(String(part));
      }
    }
    return parts.join("\n");
  }

  if (isRecord(contentRaw)) {
    if (typeof contentRaw["text"] === "string") {
      return contentRaw["text"];
    }
    return JSON.stringify(contentRaw);
  }

  if (contentRaw === undefined || contentRaw === null) {
    return "";
  }

  return String(contentRaw);
}

function normalizeGeminiRole(
  rawType: unknown
): { role: string; raw_type?: string; reason_code?: CtxpackCapabilityReasonCodeV1 } {
  if (typeof rawType !== "string" || rawType.trim().length === 0) {
    return { role: "unknown", reason_code: "adapter_unsupported_version" };
  }

  const slug = canonicalSlug(rawType);
  if (slug === "assistant" || slug === "gemini" || slug === "model" || slug === "ai") {
    return { role: "assistant", raw_type: rawType };
  }
  if (slug === "user" || slug === "human" || slug === "prompt" || slug === "client") {
    return { role: "user", raw_type: rawType };
  }
  if (slug === "system") {
    return { role: "system", raw_type: rawType };
  }
  if (slug === "tool" || slug === "function" || slug === "function-call" || slug === "tool-result") {
    return { role: "tool", raw_type: rawType };
  }

  return { role: "unknown", raw_type: rawType, reason_code: "adapter_unsupported_version" };
}

function parseGeminiSessionDocument(raw: string): Record<string, unknown>[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    return asRecordArray(parsed);
  }

  const messagesRaw = parsed["messages"];
  if (!Array.isArray(messagesRaw)) {
    return asRecordArray(parsed);
  }

  const entries: Record<string, unknown>[] = [];
  for (const messageRaw of messagesRaw) {
    if (!isRecord(messageRaw)) {
      throw new Error("gemini messages payload must contain only object entries");
    }

    const role = normalizeGeminiRole(messageRaw["type"]);
    const entry: Record<string, unknown> = {
      role: role.role,
      content: extractGeminiContent(messageRaw["content"])
    };

    const timestamp = parseTimestampValue(messageRaw["timestamp"]);
    if (timestamp) {
      entry["timestamp"] = timestamp;
    }

    if (role.raw_type && role.raw_type !== role.role) {
      entry["gemini_type"] = role.raw_type;
    }

    if (role.reason_code) {
      entry["_ctxpack_reason_code"] = role.reason_code;
      entry["_ctxpack_status"] = "partial";
    }

    if (typeof messageRaw["model"] === "string" && messageRaw["model"].trim().length > 0) {
      entry["model"] = messageRaw["model"];
    }

    entries.push(entry);
  }

  return entries;
}

abstract class BaseSessionProviderAdapter implements SessionProviderAdapter {
  readonly provider: FirstPartySessionProvider;

  constructor(provider: FirstPartySessionProvider) {
    this.provider = provider;
  }

  protected includeSessionFile(absolutePath: string, entry: Dirent<string>): boolean {
    void absolutePath;
    return isSessionFile(entry.name);
  }

  protected collectSessionFilesForRoot(rootPath: string): string[] {
    return collectSessionFiles(rootPath, (absolutePath, entry) => this.includeSessionFile(absolutePath, entry));
  }

  detect(): CtxpackProviderDetectionReportV1 {
    const reasons = new Set<CtxpackCapabilityReasonCodeV1>();
    const evidence: CtxpackCapabilityEvidenceV1[] = [];
    const providerSlug = canonicalSlug(this.provider);

    const aliasTrace = normalizeProviderAlias(this.provider);
    evidence.push({
      probe: "provider:alias",
      result: "success",
      detail: "provider_alias_normalized",
      metadata: {
        input: aliasTrace.input,
        canonical_slug: aliasTrace.canonical_slug,
        canonical_provider: aliasTrace.canonical_provider,
        matched_alias: aliasTrace.matched_alias
      }
    });

    for (const candidate of candidateRootsForProvider(this.provider)) {
      try {
        accessSync(candidate.root_path, constants.R_OK);
        const stats = statSync(candidate.root_path);
        if (!stats.isDirectory()) {
          throw Object.assign(new Error(`Probe target is not a directory: ${candidate.root_path}`), { code: "ENOTDIR" });
        }

        evidence.push({
          probe: candidate.probe,
          result: "success",
          detail: "probe_path_readable",
          metadata: { root_path: candidate.root_path }
        });

        return {
          provider: this.provider,
          provider_slug: providerSlug,
          detected: true,
          detected_root: candidate.root_path,
          evidence
        };
      } catch (error) {
        const failure = fileProbeFailure(error);
        reasons.add(failure.reason_code);
        evidence.push({
          probe: candidate.probe,
          result: failure.result,
          detail: failure.detail,
          reason_code: failure.reason_code,
          metadata: {
            root_path: candidate.root_path
          }
        });
      }
    }

    if (reasons.size === 0) {
      reasons.add("adapter_path_missing");
    }

    return {
      provider: this.provider,
      provider_slug: providerSlug,
      detected: false,
      reasons: [...reasons],
      evidence
    };
  }

  listSessions(query?: CtxpackSessionListQueryV1): CtxpackSessionHandleV1[] {
    const detection = this.detect();
    if (!detection.detected || !detection.detected_root) {
      const reason = detection.reasons?.[0] ?? "adapter_path_missing";
      throw new SessionProviderAdapterError(
        toAdapterErrorCode(reason),
        `Provider ${this.provider} session root could not be detected.`,
        this.provider,
        {
          reason_code: reason,
          evidence: detection.evidence
        }
      );
    }

    const filePaths = this.collectSessionFilesForRoot(detection.detected_root);
    const handles: CtxpackSessionHandleV1[] = [];

    for (const filePath of filePaths) {
      let stats;
      try {
        stats = statSync(filePath);
      } catch {
        continue;
      }

      const extension = path.extname(filePath);
      const baseName = path.basename(filePath, extension);
      const sessionId = baseName;
      const sessionSlug = canonicalSlug(baseName) || canonicalSlug(path.relative(detection.detected_root, filePath));

      handles.push({
        provider: this.provider,
        provider_slug: canonicalSlug(this.provider),
        session_id: sessionId,
        session_slug: sessionSlug,
        source_path: filePath,
        detected_root: detection.detected_root,
        bytes: stats.size,
        modified_at: stats.mtime.toISOString()
      });
    }

    handles.sort((left, right) => {
      const timeCompare = Date.parse(right.modified_at) - Date.parse(left.modified_at);
      if (timeCompare !== 0) {
        return timeCompare;
      }
      return left.source_path.localeCompare(right.source_path);
    });

    if (!query?.limit || query.limit <= 0) {
      return handles;
    }
    return handles.slice(0, query.limit);
  }

  readSession(handle: CtxpackSessionHandleV1): CtxpackProviderSessionRecordV1 {
    if (handle.provider !== this.provider) {
      throw new SessionProviderAdapterError(
        "ADAPTER_INTERNAL",
        `Handle provider mismatch: expected ${this.provider}, received ${handle.provider}.`,
        this.provider,
        { handle_provider: handle.provider }
      );
    }

    let raw = "";
    try {
      raw = readFileSync(handle.source_path, "utf8");
    } catch (error) {
      const failure = fileProbeFailure(error);
      throw new SessionProviderAdapterError(
        toAdapterErrorCode(failure.reason_code),
        `Unable to read session file: ${handle.source_path}`,
        this.provider,
        {
          reason_code: failure.reason_code,
          source_path: handle.source_path
        }
      );
    }

    try {
      return {
        provider: this.provider,
        handle,
        entries: parseSessionDocument(handle.source_path, raw)
      };
    } catch (error) {
      throw new SessionProviderAdapterError(
        "ADAPTER_PARSE_ERROR",
        `Failed to parse session document for ${this.provider}.`,
        this.provider,
        {
          source_path: handle.source_path,
          reason_code: ADAPTER_ERROR_TO_REASON_CODE_V1.ADAPTER_PARSE_ERROR,
          parse_error: error instanceof Error ? error.message : String(error)
        }
      );
    }
  }

  normalize(session: CtxpackProviderSessionRecordV1): CtxpackNormalizedSessionV1 {
    const timestamps = session.entries
      .map((entry) => extractTimestamp(entry))
      .filter((candidate): candidate is TimestampCandidate => candidate !== undefined)
      .map((candidate) => candidate.iso);

    return {
      provider: this.provider,
      provider_slug: canonicalSlug(this.provider),
      session_id: session.handle.session_id,
      session_slug: session.handle.session_slug,
      source_path: session.handle.source_path,
      event_count: session.entries.length,
      ...(timestamps[0] ? { started_at: timestamps[0] } : {}),
      ...(timestamps.length > 0 ? { last_event_at: timestamps[timestamps.length - 1] } : {})
    };
  }

  capabilities(): CtxpackProviderCapabilityFlagsV1 {
    return {
      detect: "ready",
      list: "ready",
      read: "ready",
      normalize: "ready",
      evidence: "ready"
    };
  }
}

class CodexSessionProviderAdapter extends BaseSessionProviderAdapter {
  constructor() {
    super("codex");
  }
}

class ClaudeSessionProviderAdapter extends BaseSessionProviderAdapter {
  constructor() {
    super("claude");
  }
}

class GeminiSessionProviderAdapter extends BaseSessionProviderAdapter {
  constructor() {
    super("gemini");
  }

  protected includeSessionFile(absolutePath: string, entry: Dirent<string>): boolean {
    const fileName = entry.name.toLowerCase();
    if (!fileName.startsWith("session-") || !fileName.endsWith(".json")) {
      return false;
    }
    if (fileName.includes("subagent")) {
      return false;
    }

    const normalizedPath = absolutePath.split(path.sep).join("/").toLowerCase();
    return /\/tmp\/[^/]+\/chats\/session-[^/]+\.json$/.test(normalizedPath);
  }

  readSession(handle: CtxpackSessionHandleV1): CtxpackProviderSessionRecordV1 {
    if (handle.provider !== this.provider) {
      throw new SessionProviderAdapterError(
        "ADAPTER_INTERNAL",
        `Handle provider mismatch: expected ${this.provider}, received ${handle.provider}.`,
        this.provider,
        { handle_provider: handle.provider }
      );
    }

    let raw = "";
    try {
      raw = readFileSync(handle.source_path, "utf8");
    } catch (error) {
      const failure = fileProbeFailure(error);
      throw new SessionProviderAdapterError(
        toAdapterErrorCode(failure.reason_code),
        `Unable to read session file: ${handle.source_path}`,
        this.provider,
        {
          reason_code: failure.reason_code,
          source_path: handle.source_path
        }
      );
    }

    try {
      const entries = parseGeminiSessionDocument(raw);
      return {
        provider: this.provider,
        handle,
        entries
      };
    } catch (error) {
      throw new SessionProviderAdapterError(
        "ADAPTER_PARSE_ERROR",
        `Failed to parse session document for ${this.provider}.`,
        this.provider,
        {
          source_path: handle.source_path,
          reason_code: ADAPTER_ERROR_TO_REASON_CODE_V1.ADAPTER_PARSE_ERROR,
          parse_error: error instanceof Error ? error.message : String(error)
        }
      );
    }
  }
}

function resolveHermesCandidateRoots(): HermesCandidateRoot[] {
  const explicitStateDb = process.env.CALYX_CONTEXT_HERMES_STATE_DB?.trim();
  const resolvedStateDb = explicitStateDb
    ? path.resolve(explicitStateDb.startsWith("~/") ? path.join(homedir(), explicitStateDb.slice(2)) : explicitStateDb)
    : undefined;

  return candidateRootsForProvider("hermes").map((candidate) => ({
    probe: candidate.probe,
    root_path: candidate.root_path,
    state_db_path:
      candidate.probe === "env:CALYX_CONTEXT_HERMES_STATE_DB" && resolvedStateDb
        ? resolvedStateDb
        : path.join(candidate.root_path, HERMES_STATE_DB_FILE)
  }));
}

function resolveHermesStateDbPathFromDetection(
  detection: CtxpackProviderDetectionReportV1
): string | undefined {
  for (const entry of detection.evidence) {
    if (entry.probe.endsWith("/state.db") && entry.result === "success") {
      const candidate = entry.metadata?.state_db_path;
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate;
      }
    }
  }
  return undefined;
}

function resolveHermesSessionTable(dbPath: string): HermesResolvedSessionTable | undefined {
  const tables = listSqliteTables(dbPath);
  const tableLookup = lowerCaseLookup(tables);

  for (const preferredName of HERMES_SESSION_TABLE_CANDIDATES) {
    const table = tableLookup.get(preferredName);
    if (!table) {
      continue;
    }

    const columns = listSqliteTableColumns(dbPath, table);
    const sessionIdColumn = pickColumnName(columns, HERMES_SESSION_ID_COLUMN_CANDIDATES);
    if (!sessionIdColumn) {
      continue;
    }
    const createdAtColumn = pickColumnName(columns, HERMES_CREATED_AT_COLUMN_CANDIDATES);
    const updatedAtColumn = pickColumnName(columns, HERMES_UPDATED_AT_COLUMN_CANDIDATES);
    return {
      table,
      sessionIdColumn,
      ...(createdAtColumn ? { createdAtColumn } : {}),
      ...(updatedAtColumn ? { updatedAtColumn } : {})
    };
  }

  for (const table of tables) {
    const lowered = table.toLowerCase();
    if (!lowered.includes("session") && !lowered.includes("conversation") && !lowered.includes("thread")) {
      continue;
    }
    const columns = listSqliteTableColumns(dbPath, table);
    const sessionIdColumn = pickColumnName(columns, HERMES_SESSION_ID_COLUMN_CANDIDATES);
    if (!sessionIdColumn) {
      continue;
    }
    const createdAtColumn = pickColumnName(columns, HERMES_CREATED_AT_COLUMN_CANDIDATES);
    const updatedAtColumn = pickColumnName(columns, HERMES_UPDATED_AT_COLUMN_CANDIDATES);
    return {
      table,
      sessionIdColumn,
      ...(createdAtColumn ? { createdAtColumn } : {}),
      ...(updatedAtColumn ? { updatedAtColumn } : {})
    };
  }

  return undefined;
}

function resolveHermesMessageTable(dbPath: string): HermesResolvedMessageTable | undefined {
  const tables = listSqliteTables(dbPath);
  const tableLookup = lowerCaseLookup(tables);

  for (const preferredName of HERMES_MESSAGE_TABLE_CANDIDATES) {
    const table = tableLookup.get(preferredName);
    if (!table) {
      continue;
    }
    const columns = listSqliteTableColumns(dbPath, table);
    const sessionIdColumn = pickColumnName(columns, HERMES_MESSAGE_SESSION_ID_COLUMN_CANDIDATES);
    if (!sessionIdColumn) {
      continue;
    }
    const roleColumn = pickColumnName(columns, HERMES_ROLE_COLUMN_CANDIDATES);
    const contentColumn = pickColumnName(columns, HERMES_CONTENT_COLUMN_CANDIDATES);
    const timestampColumn = pickColumnName(columns, HERMES_MESSAGE_TIMESTAMP_COLUMN_CANDIDATES);
    return {
      table,
      sessionIdColumn,
      ...(roleColumn ? { roleColumn } : {}),
      ...(contentColumn ? { contentColumn } : {}),
      ...(timestampColumn ? { timestampColumn } : {})
    };
  }

  for (const table of tables) {
    const lowered = table.toLowerCase();
    if (!lowered.includes("message") && !lowered.includes("event") && !lowered.includes("entry") && !lowered.includes("turn")) {
      continue;
    }
    const columns = listSqliteTableColumns(dbPath, table);
    const sessionIdColumn = pickColumnName(columns, HERMES_MESSAGE_SESSION_ID_COLUMN_CANDIDATES);
    if (!sessionIdColumn) {
      continue;
    }
    const roleColumn = pickColumnName(columns, HERMES_ROLE_COLUMN_CANDIDATES);
    const contentColumn = pickColumnName(columns, HERMES_CONTENT_COLUMN_CANDIDATES);
    const timestampColumn = pickColumnName(columns, HERMES_MESSAGE_TIMESTAMP_COLUMN_CANDIDATES);
    return {
      table,
      sessionIdColumn,
      ...(roleColumn ? { roleColumn } : {}),
      ...(contentColumn ? { contentColumn } : {}),
      ...(timestampColumn ? { timestampColumn } : {})
    };
  }

  return undefined;
}

function normalizeHermesRole(
  rawRole: unknown
): { role: string; raw_role?: string; reason_code?: CtxpackCapabilityReasonCodeV1 } {
  if (typeof rawRole !== "string" || rawRole.trim().length === 0) {
    return { role: "unknown", reason_code: "adapter_unsupported_version" };
  }

  const slug = canonicalSlug(rawRole);
  if (slug === "assistant" || slug === "model" || slug === "ai" || slug === "hermes") {
    return { role: "assistant", raw_role: rawRole };
  }
  if (slug === "user" || slug === "human" || slug === "prompt" || slug === "client") {
    return { role: "user", raw_role: rawRole };
  }
  if (slug === "system") {
    return { role: "system", raw_role: rawRole };
  }
  if (
    slug === "tool" ||
    slug === "function" ||
    slug === "function-call" ||
    slug === "tool-call" ||
    slug === "tool-result" ||
    slug === "toolresult"
  ) {
    return { role: "tool", raw_role: rawRole };
  }
  return { role: "unknown", raw_role: rawRole, reason_code: "adapter_unsupported_version" };
}

function createHermesEntry(
  roleRaw: unknown,
  contentRaw: unknown,
  timestampRaw: unknown,
  partialReason?: CtxpackCapabilityReasonCodeV1
): Record<string, unknown> {
  const role = normalizeHermesRole(roleRaw);
  const entry: Record<string, unknown> = {
    role: role.role,
    content: typeof contentRaw === "string" ? contentRaw : contentRaw == null ? "" : String(contentRaw)
  };

  const iso = parseTimestampValue(timestampRaw);
  if (iso) {
    entry.timestamp = iso;
  }

  if (role.raw_role && role.raw_role !== role.role) {
    entry.hermes_role = role.raw_role;
  }

  const reason = partialReason ?? role.reason_code;
  if (reason) {
    entry._ctxpack_reason_code = reason;
    entry._ctxpack_status = "partial";
  }

  return entry;
}

class HermesSessionProviderAdapter extends BaseSessionProviderAdapter {
  constructor() {
    super("hermes");
  }

  detect(): CtxpackProviderDetectionReportV1 {
    const reasons = new Set<CtxpackCapabilityReasonCodeV1>();
    const evidence: CtxpackCapabilityEvidenceV1[] = [];
    const providerSlug = canonicalSlug(this.provider);

    const aliasTrace = normalizeProviderAlias(this.provider);
    evidence.push({
      probe: "provider:alias",
      result: "success",
      detail: "provider_alias_normalized",
      metadata: {
        input: aliasTrace.input,
        canonical_slug: aliasTrace.canonical_slug,
        canonical_provider: aliasTrace.canonical_provider,
        matched_alias: aliasTrace.matched_alias
      }
    });

    for (const candidate of resolveHermesCandidateRoots()) {
      try {
        accessSync(candidate.root_path, constants.R_OK);
        const rootStats = statSync(candidate.root_path);
        if (!rootStats.isDirectory()) {
          throw Object.assign(new Error(`Probe target is not a directory: ${candidate.root_path}`), { code: "ENOTDIR" });
        }

        evidence.push({
          probe: candidate.probe,
          result: "success",
          detail: "probe_path_readable",
          metadata: { root_path: candidate.root_path }
        });

        accessSync(candidate.state_db_path, constants.R_OK);
        const stateDbStats = statSync(candidate.state_db_path);
        if (!stateDbStats.isFile()) {
          throw Object.assign(new Error(`Probe target is not a file: ${candidate.state_db_path}`), { code: "ENOTDIR" });
        }

        evidence.push({
          probe: `${candidate.probe}/state.db`,
          result: "success",
          detail: "sqlite_state_db_readable",
          metadata: {
            root_path: candidate.root_path,
            state_db_path: candidate.state_db_path
          }
        });

        const diagnosticSessionsPath = path.join(candidate.root_path, HERMES_SESSION_DIAGNOSTIC_DIR);
        try {
          accessSync(diagnosticSessionsPath, constants.R_OK);
          const diagnosticsStats = statSync(diagnosticSessionsPath);
          if (diagnosticsStats.isDirectory()) {
            evidence.push({
              probe: `${candidate.probe}/sessions`,
              result: "success",
              detail: "diagnostic_sessions_path_readable",
              metadata: { sessions_path: diagnosticSessionsPath }
            });
          }
        } catch {
          evidence.push({
            probe: `${candidate.probe}/sessions`,
            result: "missing",
            detail: "diagnostic_sessions_path_unavailable",
            metadata: { sessions_path: diagnosticSessionsPath }
          });
        }

        return {
          provider: this.provider,
          provider_slug: providerSlug,
          detected: true,
          detected_root: candidate.root_path,
          evidence
        };
      } catch (error) {
        const failure = fileProbeFailure(error);
        reasons.add(failure.reason_code);
        evidence.push({
          probe: candidate.probe,
          result: failure.result,
          detail: failure.detail,
          reason_code: failure.reason_code,
          metadata: {
            root_path: candidate.root_path,
            state_db_path: candidate.state_db_path
          }
        });
      }
    }

    if (reasons.size === 0) {
      reasons.add("adapter_path_missing");
    }

    return {
      provider: this.provider,
      provider_slug: providerSlug,
      detected: false,
      reasons: [...reasons],
      evidence
    };
  }

  private listSessionsFromDiagnosticFiles(rootPath: string): CtxpackSessionHandleV1[] {
    const sessionsPath = path.join(rootPath, HERMES_SESSION_DIAGNOSTIC_DIR);
    const files = collectSessionFiles(
      sessionsPath,
      (absolutePath, entry) => absolutePath.endsWith(".json") && /^session_.+\.json$/i.test(entry.name)
    );

    const handles: CtxpackSessionHandleV1[] = [];
    for (const filePath of files) {
      let stats;
      try {
        stats = statSync(filePath);
      } catch {
        continue;
      }

      const baseName = path.basename(filePath, ".json");
      const sessionId = baseName.replace(/^session_/i, "") || baseName;
      const sessionSlug = canonicalSlug(sessionId) || canonicalSlug(baseName);
      handles.push({
        provider: this.provider,
        provider_slug: canonicalSlug(this.provider),
        session_id: sessionId,
        session_slug: sessionSlug,
        source_path: filePath,
        detected_root: rootPath,
        bytes: stats.size,
        modified_at: stats.mtime.toISOString()
      });
    }

    handles.sort((left, right) => {
      const timeCompare = Date.parse(right.modified_at) - Date.parse(left.modified_at);
      if (timeCompare !== 0) {
        return timeCompare;
      }
      return left.session_id.localeCompare(right.session_id);
    });

    return handles;
  }

  listSessions(query?: CtxpackSessionListQueryV1): CtxpackSessionHandleV1[] {
    const detection = this.detect();
    if (!detection.detected || !detection.detected_root) {
      const reason = detection.reasons?.[0] ?? "adapter_path_missing";
      throw new SessionProviderAdapterError(
        toAdapterErrorCode(reason),
        `Provider ${this.provider} session root could not be detected.`,
        this.provider,
        {
          reason_code: reason,
          evidence: detection.evidence
        }
      );
    }

    const stateDbPath = resolveHermesStateDbPathFromDetection(detection);
    if (!stateDbPath) {
      throw new SessionProviderAdapterError(
        "ADAPTER_INTERNAL",
        `Provider ${this.provider} did not surface a readable SQLite state database path during detection.`,
        this.provider,
        {
          reason_code: ADAPTER_ERROR_TO_REASON_CODE_V1.ADAPTER_INTERNAL,
          evidence: detection.evidence
        }
      );
    }

    let stateDbStats;
    try {
      stateDbStats = statSync(stateDbPath);
    } catch (error) {
      const failure = fileProbeFailure(error);
      throw new SessionProviderAdapterError(
        toAdapterErrorCode(failure.reason_code),
        `Unable to inspect Hermes SQLite state database at ${stateDbPath}.`,
        this.provider,
        {
          reason_code: failure.reason_code,
          source_path: stateDbPath
        }
      );
    }

    let sessionHandles: CtxpackSessionHandleV1[] = [];
    try {
      const sessionTable = resolveHermesSessionTable(stateDbPath);
      if (!sessionTable) {
        const fallback = this.listSessionsFromDiagnosticFiles(detection.detected_root);
        if (fallback.length > 0) {
          sessionHandles = fallback;
        } else {
          throw new SessionProviderAdapterError(
            "ADAPTER_UNSUPPORTED_VERSION",
            "Hermes SQLite schema does not expose a recognizable sessions table.",
            this.provider,
            {
              reason_code: ADAPTER_ERROR_TO_REASON_CODE_V1.ADAPTER_UNSUPPORTED_VERSION,
              state_db_path: stateDbPath,
              available_tables: listSqliteTables(stateDbPath)
            }
          );
        }
      } else {
        const updatedExpr = sessionTable.updatedAtColumn
          ? `CAST(${quoteSqlIdentifier(sessionTable.updatedAtColumn)} AS TEXT)`
          : "''";
        const createdExpr = sessionTable.createdAtColumn
          ? `CAST(${quoteSqlIdentifier(sessionTable.createdAtColumn)} AS TEXT)`
          : "''";
        const sql = [
          "SELECT",
          `  CAST(${quoteSqlIdentifier(sessionTable.sessionIdColumn)} AS TEXT) AS session_id,`,
          `  ${updatedExpr} AS updated_at,`,
          `  ${createdExpr} AS created_at`,
          `FROM ${quoteSqlIdentifier(sessionTable.table)};`
        ].join("\n");

        const rows = runSqliteQueryV1(stateDbPath, sql);
        for (const row of rows) {
          const sessionId = row.session_id?.trim();
          if (!sessionId) {
            continue;
          }
          const modifiedAt =
            parseTimestampValue(row.updated_at) ??
            parseTimestampValue(row.created_at) ??
            stateDbStats.mtime.toISOString();

          sessionHandles.push({
            provider: this.provider,
            provider_slug: canonicalSlug(this.provider),
            session_id: sessionId,
            session_slug: canonicalSlug(sessionId) || canonicalSlug(`session-${sessionId}`),
            source_path: stateDbPath,
            detected_root: detection.detected_root,
            bytes: stateDbStats.size,
            modified_at: modifiedAt
          });
        }
      }
    } catch (error) {
      if (error instanceof SessionProviderAdapterError) {
        throw error;
      }
      throw new SessionProviderAdapterError(
        "ADAPTER_PARSE_ERROR",
        "Failed to query Hermes sessions from SQLite state database.",
        this.provider,
        {
          reason_code: ADAPTER_ERROR_TO_REASON_CODE_V1.ADAPTER_PARSE_ERROR,
          state_db_path: stateDbPath,
          parse_error: error instanceof Error ? error.message : String(error)
        }
      );
    }

    sessionHandles.sort((left, right) => {
      const timeCompare = Date.parse(right.modified_at) - Date.parse(left.modified_at);
      if (timeCompare !== 0) {
        return timeCompare;
      }
      return left.session_id.localeCompare(right.session_id);
    });

    if (!query?.limit || query.limit <= 0) {
      return sessionHandles;
    }
    return sessionHandles.slice(0, query.limit);
  }

  private readDiagnosticSession(handle: CtxpackSessionHandleV1): CtxpackProviderSessionRecordV1 {
    let raw = "";
    try {
      raw = readFileSync(handle.source_path, "utf8");
    } catch (error) {
      const failure = fileProbeFailure(error);
      throw new SessionProviderAdapterError(
        toAdapterErrorCode(failure.reason_code),
        `Unable to read Hermes diagnostic session file: ${handle.source_path}`,
        this.provider,
        {
          reason_code: failure.reason_code,
          source_path: handle.source_path
        }
      );
    }

    try {
      const parsed = parseSessionDocument(handle.source_path, raw);
      const entries = parsed.map((entry) => {
        const role = HERMES_ROLE_COLUMN_CANDIDATES
          .map((key) => entry[key])
          .find((value) => typeof value === "string" && value.trim().length > 0);
        const content = HERMES_CONTENT_COLUMN_CANDIDATES
          .map((key) => entry[key])
          .find((value) => value !== undefined && value !== null);
        const timestamp = HERMES_MESSAGE_TIMESTAMP_COLUMN_CANDIDATES
          .map((key) => entry[key])
          .find((value) => value !== undefined && value !== null);
        const normalized = createHermesEntry(role, content, timestamp);
        normalized._ctxpack_source = "diagnostic_session_file";
        return normalized;
      });
      return {
        provider: this.provider,
        handle,
        entries
      };
    } catch (error) {
      throw new SessionProviderAdapterError(
        "ADAPTER_PARSE_ERROR",
        "Failed to parse Hermes diagnostic session file.",
        this.provider,
        {
          reason_code: ADAPTER_ERROR_TO_REASON_CODE_V1.ADAPTER_PARSE_ERROR,
          source_path: handle.source_path,
          parse_error: error instanceof Error ? error.message : String(error)
        }
      );
    }
  }

  readSession(handle: CtxpackSessionHandleV1): CtxpackProviderSessionRecordV1 {
    if (handle.provider !== this.provider) {
      throw new SessionProviderAdapterError(
        "ADAPTER_INTERNAL",
        `Handle provider mismatch: expected ${this.provider}, received ${handle.provider}.`,
        this.provider,
        { handle_provider: handle.provider }
      );
    }

    if (path.extname(handle.source_path).toLowerCase() === ".json") {
      return this.readDiagnosticSession(handle);
    }

    const stateDbPath = handle.source_path;
    try {
      const messageTable = resolveHermesMessageTable(stateDbPath);
      if (!messageTable) {
        const fallbackPath = path.join(
          handle.detected_root,
          HERMES_SESSION_DIAGNOSTIC_DIR,
          `session_${handle.session_id}.json`
        );
        try {
          accessSync(fallbackPath, constants.R_OK);
          return this.readDiagnosticSession({
            ...handle,
            source_path: fallbackPath
          });
        } catch {
          throw new SessionProviderAdapterError(
            "ADAPTER_UNSUPPORTED_VERSION",
            "Hermes SQLite schema does not expose a recognizable messages table.",
            this.provider,
            {
              reason_code: ADAPTER_ERROR_TO_REASON_CODE_V1.ADAPTER_UNSUPPORTED_VERSION,
              state_db_path: stateDbPath,
              available_tables: listSqliteTables(stateDbPath)
            }
          );
        }
      }

      const roleExpr = messageTable.roleColumn
        ? `CAST(${quoteSqlIdentifier(messageTable.roleColumn)} AS TEXT)`
        : "''";
      const contentExpr = messageTable.contentColumn
        ? `CAST(${quoteSqlIdentifier(messageTable.contentColumn)} AS TEXT)`
        : "''";
      const timestampExpr = messageTable.timestampColumn
        ? `CAST(${quoteSqlIdentifier(messageTable.timestampColumn)} AS TEXT)`
        : "''";

      const sql = [
        "SELECT",
        `  ${roleExpr} AS role_raw,`,
        `  ${contentExpr} AS content_raw,`,
        `  ${timestampExpr} AS timestamp_raw`,
        `FROM ${quoteSqlIdentifier(messageTable.table)}`,
        `WHERE CAST(${quoteSqlIdentifier(messageTable.sessionIdColumn)} AS TEXT) = ${toSqlLiteral(handle.session_id)}`,
        messageTable.timestampColumn
          ? `ORDER BY ${quoteSqlIdentifier(messageTable.timestampColumn)} ASC;`
          : ";"
      ].join("\n");

      const rows = runSqliteQueryV1(stateDbPath, sql);
      const partialReason = !messageTable.roleColumn || !messageTable.contentColumn
        ? "adapter_unsupported_version"
        : undefined;

      const entries = rows
        .map((row) =>
          createHermesEntry(row.role_raw, row.content_raw, row.timestamp_raw, partialReason)
        )
        .sort((left, right) => {
          const leftTimestamp = parseTimestampValue(left.timestamp);
          const rightTimestamp = parseTimestampValue(right.timestamp);
          if (leftTimestamp && rightTimestamp && leftTimestamp !== rightTimestamp) {
            return leftTimestamp.localeCompare(rightTimestamp);
          }
          if (leftTimestamp && !rightTimestamp) {
            return -1;
          }
          if (!leftTimestamp && rightTimestamp) {
            return 1;
          }
          return 0;
        });
      return {
        provider: this.provider,
        handle,
        entries
      };
    } catch (error) {
      if (error instanceof SessionProviderAdapterError) {
        throw error;
      }
      throw new SessionProviderAdapterError(
        "ADAPTER_PARSE_ERROR",
        "Failed to parse Hermes session rows from SQLite state database.",
        this.provider,
        {
          reason_code: ADAPTER_ERROR_TO_REASON_CODE_V1.ADAPTER_PARSE_ERROR,
          state_db_path: stateDbPath,
          parse_error: error instanceof Error ? error.message : String(error)
        }
      );
    }
  }
}

export function capabilityReasonFromAdapterErrorCodeV1(
  code: CtxpackAdapterErrorCodeV1
): CtxpackCapabilityReasonCodeV1 {
  return ADAPTER_ERROR_TO_REASON_CODE_V1[code];
}

export function createSessionProviderAdapterV1(provider: CtxpackProviderIdV1): SessionProviderAdapter {
  if (provider === "codex") {
    return new CodexSessionProviderAdapter();
  }
  if (provider === "claude") {
    return new ClaudeSessionProviderAdapter();
  }
  if (provider === "gemini") {
    return new GeminiSessionProviderAdapter();
  }
  if (provider === "hermes") {
    return new HermesSessionProviderAdapter();
  }

  throw new SessionProviderAdapterError(
    "ADAPTER_NOT_INSTALLED",
    `Provider ${provider} does not have a first-party SessionProviderAdapter in ctxpack v1.`,
    provider,
    {
      reason_code: "adapter_not_implemented"
    }
  );
}

export function isFirstPartySessionProviderV1(provider: CtxpackProviderIdV1): provider is FirstPartySessionProvider {
  return (FIRST_PARTY_SESSION_PROVIDERS_V1 as readonly string[]).includes(provider);
}

export function normalizeProviderAliasV1(rawProvider: string): CtxpackProviderAliasTraceV1 {
  return normalizeProviderAlias(rawProvider);
}

export function normalizeRequestedProvidersV1(rawProviders: readonly string[] | undefined): AliasNormalizationResult {
  return normalizeRequestedProviders(rawProviders);
}
