import { createHash } from "node:crypto";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
  InteractiveSessionBackend,
  InteractiveSessionEvent,
  InteractiveSessionEventRole,
  InteractiveSessionInspectResult,
  InteractiveSessionListEntry,
  InteractiveSessionSummary,
} from "./types.js";
import {
  codexSessionIdFromPath,
  interactiveSessionMatchesLocator,
  parseInteractiveActivityLocator,
} from "./activity-id-resolution.js";

export const DEFAULT_INTERACTIVE_ACTIVITY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_INTERACTIVE_ACTIVITY_LIMIT = 50;
const SESSION_METADATA_MAX_BYTES = 256 * 1024;
const SESSION_METADATA_MAX_LINES = 40;
const SESSION_IDENTITY_MAX_BYTES = 64 * 1024;
const SESSION_IDENTITY_MAX_LINES = 4;
export const DEFAULT_INTERACTIVE_PAGE_CANDIDATE_LIMIT = 4_096;
const DEFAULT_INTERACTIVE_DETAIL_TAIL = 40;
const DEFAULT_INTERACTIVE_DETAIL_CONTEXT = 6;
const MAX_INTERACTIVE_EVENT_TEXT_CHARS = 4_000;

export interface InteractiveActivityOptions {
  homeDir?: string;
  codexSessionsRoot?: string;
  /**
   * Codex's recoverable archive root. Exact activity lookups may consult it,
   * but recent/latest discovery intentionally remains scoped to `sessions`.
   */
  codexArchivedSessionsRoot?: string;
  /**
   * Include Codex's archive in low-level file discovery. This is reserved for
   * the recall tailer; user-facing recent/list/latest callers leave it false.
   */
  includeCodexArchivedSessions?: boolean;
  claudeProjectsRoot?: string;
  calyxRunsRoot?: string;
  includeCalyxRuns?: boolean;
  host?: string;
  kinds?: InteractiveSessionBackend[];
  sinceMs?: number;
  limit?: number;
  createdSince?: string;
  createdBefore?: string;
  after?: {
    created_at: string;
    run_id: string;
    /** Total-order discriminator for the merged managed + interactive view. */
    entry_kind?: "calyx_run" | "interactive_session";
  };
  /** Hard work bound for exact page identity discovery. */
  candidateLimit?: number;
  /** Test/operations override for the bounded identity prefix. */
  identityMaxBytes?: number;
  /** Exact membership fingerprint carried by a prior seek-page cursor. */
  expectedMembershipFingerprint?: string;
  /** Test/operations synchronization hook after identities, before rich reads. */
  beforePageMetadataRead?: (() => Promise<void>) | undefined;
  /** Test/operations synchronization hook after discovery, before identity reads. */
  beforeIdentityRead?: ((candidate: InteractiveSessionFileCandidate) => Promise<void>) | undefined;
  /** Test/operations synchronization hook immediately before a directory read. */
  beforeDiscoveryRead?: ((directoryPath: string) => Promise<void>) | undefined;
  /** Test/operations synchronization hook immediately before a candidate stat. */
  beforeCandidateStat?: ((candidatePath: string) => Promise<void>) | undefined;
  now?: () => Date;
}

export class InteractiveActivityProjectionNotReadyError extends Error {
  readonly code = "activity_projection_not_ready";
  readonly retryable = true;

  constructor(
    message: string,
    readonly details: {
      reason:
        | "candidate_limit"
        | "identity_prefix_limit"
        | "identity_drift"
        | "identity_read_failed"
        | "metadata_read_failed"
        | "discovery_read_failed"
        | "identity_collision"
        | "snapshot_drift";
      candidate_limit?: number;
      candidates_seen?: number;
      source_path?: string;
      identity_max_bytes?: number;
    },
  ) {
    super(message);
    this.name = "InteractiveActivityProjectionNotReadyError";
  }
}

export class InteractiveActivityRootConfigurationError extends Error {
  readonly code = "activity_root_configuration_invalid";

  constructor(
    message: string,
    readonly details: {
      backend: "calyx" | "claude" | "codex";
      reason: "conflicting_home" | "invalid_home" | "invalid_root_name" | "overlapping_roots";
      root?: string;
      expected?: string;
      sessions_root?: string;
      archived_sessions_root?: string;
    },
  ) {
    super(message);
    this.name = "InteractiveActivityRootConfigurationError";
  }
}

interface InteractiveSessionIdentity {
  candidate: InteractiveSessionFileCandidate;
  entry: InteractiveSessionListEntry;
}

interface CandidateBudget {
  limit: number;
  seen: number;
}

function isExpectedMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function discoveryReadFailed(sourcePath: string): InteractiveActivityProjectionNotReadyError {
  return new InteractiveActivityProjectionNotReadyError(
    "Interactive activity source discovery is temporarily unavailable.",
    { reason: "discovery_read_failed", source_path: sourcePath },
  );
}

export interface InteractiveSessionInspectOptions extends InteractiveActivityOptions {
  activityId: string;
  around?: string;
  tail?: number;
  context?: number;
  includeTools?: boolean;
}

/**
 * Lightweight transcript-file candidate: the cheap `readdir`+`stat` shape
 * produced before any prefix/metadata read. Exposed so callers (e.g. the
 * POL-1838 tailer) can enumerate the full local history cheaply and decide
 * which sources to fully load this tick without paying the per-file prefix
 * read for every discovered file.
 */
export interface InteractiveSessionFileCandidate {
  backend: InteractiveSessionBackend;
  source: InteractiveSessionListEntry["source"];
  path: string;
  birthtimeMs: number;
  mtimeMs: number;
  size: number;
}

interface ParsedSessionMetadata {
  sessionId?: string;
  createdAt?: string;
  cwd?: string;
  summary?: string;
}

export function normalizeHost(host: string | undefined): string | undefined {
  const normalized = host?.trim().toLowerCase().replace(/\..*$/, "");
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function summarizeText(value: string | undefined, fallback: string): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    return fallback;
  }
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function parseTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value >= 1_000_000_000_000 ? value : value * 1_000;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return parseTimestamp(numeric);
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractMessageText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const content = value["content"];
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (isRecord(block) && typeof block["text"] === "string") {
        parts.push(block["text"]);
      }
    }
    return parts.join("\n");
  }
  return undefined;
}

function isUsefulPromptSummary(text: string | undefined): text is string {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }
  if (normalized.includes("<local-command-caveat>")) {
    return false;
  }
  if (normalized.startsWith("# AGENTS.md instructions") || normalized.includes("<INSTRUCTIONS>")) {
    return false;
  }
  if (normalized.startsWith("<command-name>") || normalized.startsWith("<local-command-stdout>")) {
    return false;
  }
  return true;
}

function truncateText(value: string, maxChars = MAX_INTERACTIVE_EVENT_TEXT_CHARS): {
  text: string;
  truncated: boolean;
} {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, maxChars), truncated: true };
}

function summarizeEventText(value: string | undefined, fallback: string): string {
  return summarizeText(value, fallback);
}

function recordText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = extractMessageText(value);
  if (direct) {
    return direct;
  }
  for (const key of ["text", "message", "output", "arguments", "call_id"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
}

function roleFromUnknown(value: unknown): InteractiveSessionEventRole {
  if (value === "user" || value === "assistant" || value === "tool" || value === "system") {
    return value;
  }
  return "unknown";
}

function payloadKind(payload: Record<string, unknown>, fallback: string): string {
  const type = typeof payload["type"] === "string" ? payload["type"] : fallback;
  const name = typeof payload["name"] === "string" ? payload["name"] : undefined;
  return name ? `${type}:${name}` : type;
}

function makeEvent(args: {
  index: number;
  line: number;
  timestamp?: string | undefined;
  role: InteractiveSessionEventRole;
  kind: string;
  text?: string | undefined;
  fallback: string;
  rawType?: string | undefined;
  redacted?: boolean | undefined;
}): InteractiveSessionEvent {
  const truncated = args.text ? truncateText(args.text) : undefined;
  return {
    index: args.index,
    line: args.line,
    ...(args.timestamp ? { timestamp: args.timestamp } : {}),
    role: args.role,
    kind: args.kind,
    summary: args.redacted ? "[redacted reasoning]" : summarizeEventText(truncated?.text, args.fallback),
    ...(args.redacted ? { redacted: true } : {}),
    ...(!args.redacted && truncated?.text ? { text: truncated.text } : {}),
    ...(!args.redacted && truncated?.truncated ? { truncated: true } : {}),
    ...(args.rawType ? { raw_type: args.rawType } : {}),
  };
}

function parseCodexSessionEvents(raw: string): InteractiveSessionEvent[] {
  const events: InteractiveSessionEvent[] = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, offset) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) {
        return;
      }
      record = parsed;
    } catch {
      return;
    }

    const rawType = typeof record["type"] === "string" ? record["type"] : undefined;
    const timestamp = parseTimestamp(record["timestamp"]);
    const index = events.length;
    const lineNumber = offset + 1;

    if (rawType === "session_meta") {
      events.push(makeEvent({
        index,
        line: lineNumber,
        timestamp,
        role: "system",
        kind: "session_meta",
        text: recordText(record["payload"]),
        fallback: "session metadata",
        rawType,
      }));
      return;
    }

    if (rawType === "response_item" && isRecord(record["payload"])) {
      const payload = record["payload"];
      const payloadType = typeof payload["type"] === "string" ? payload["type"] : "response_item";
      const payloadTimestamp = parseTimestamp(payload["timestamp"]) ?? timestamp;
      const kind = payloadKind(payload, payloadType);
      const isTool = payloadType.includes("function_call") || payloadType.includes("tool");
      const isReasoning = payloadType.includes("reasoning");
      events.push(makeEvent({
        index,
        line: lineNumber,
        timestamp: payloadTimestamp,
        role: isTool ? "tool" : roleFromUnknown(payload["role"]),
        kind,
        text: isReasoning ? undefined : recordText(payload),
        fallback: kind,
        rawType,
        ...(isReasoning ? { redacted: true } : {}),
      }));
      return;
    }

    if (rawType === "turn_context") {
      events.push(makeEvent({
        index,
        line: lineNumber,
        timestamp,
        role: "system",
        kind: "turn_context",
        text: recordText(record["payload"]),
        fallback: "turn context",
        rawType,
      }));
      return;
    }

    if (rawType === "event_msg") {
      events.push(makeEvent({
        index,
        line: lineNumber,
        timestamp,
        role: "system",
        kind: "event_msg",
        text: recordText(record["payload"]) ?? recordText(record),
        fallback: "event message",
        rawType,
      }));
      return;
    }

    events.push(makeEvent({
      index,
      line: lineNumber,
      timestamp,
      role: roleFromUnknown(record["role"]),
      kind: rawType ?? "record",
      text: recordText(record["message"]) ?? recordText(record["payload"]) ?? recordText(record),
      fallback: rawType ?? "session record",
      rawType,
    }));
  });
  return events;
}

function parseClaudeSessionEvents(raw: string): InteractiveSessionEvent[] {
  const events: InteractiveSessionEvent[] = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, offset) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) {
        return;
      }
      record = parsed;
    } catch {
      return;
    }
    const rawType = typeof record["type"] === "string" ? record["type"] : undefined;
    const message = isRecord(record["message"]) ? record["message"] : undefined;
    const messageRole = message ? roleFromUnknown(message["role"]) : "unknown";
    const role = rawType === "tool_result" || rawType === "tool_use"
      ? "tool"
      : messageRole !== "unknown" ? messageRole : roleFromUnknown(rawType);
    events.push(makeEvent({
      index: events.length,
      line: offset + 1,
      timestamp: parseTimestamp(record["timestamp"]),
      role,
      kind: rawType ?? "record",
      text: recordText(message) ?? recordText(record),
      fallback: rawType ?? "session record",
      rawType,
    }));
  });
  return events;
}

function parseCalyxRunEvents(raw: string): InteractiveSessionEvent[] {
  const events: InteractiveSessionEvent[] = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, offset) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) {
        return;
      }
      record = parsed;
    } catch {
      return;
    }
    const rawType = typeof record["event_type"] === "string"
      ? record["event_type"]
      : typeof record["event"] === "string"
        ? record["event"]
        : typeof record["type"] === "string"
          ? record["type"]
          : undefined;
    events.push(makeEvent({
      index: events.length,
      line: offset + 1,
      timestamp: parseTimestamp(record["timestamp"]) ?? parseTimestamp(record["recorded_at"]),
      role: "system",
      kind: rawType ?? "calyx_run_event",
      text: recordText(record["message"]) ?? recordText(record["backend_event"]) ?? recordText(record["payload"]) ?? recordText(record),
      fallback: rawType ?? "calyx run event",
      rawType,
    }));
  });
  return events;
}

function filterInteractiveEvents(
  events: InteractiveSessionEvent[],
  includeTools: boolean,
): InteractiveSessionEvent[] {
  const isLowSignalSystemEvent = (event: InteractiveSessionEvent): boolean => (
    event.role === "system"
    && (event.kind === "session_meta" || event.kind === "turn_context" || event.kind === "event_msg")
  );
  return events.filter((event) => (
    !isLowSignalSystemEvent(event)
    && !event.redacted
    && (includeTools || event.role !== "tool")
  ));
}

function chooseInteractiveEvents(
  events: InteractiveSessionEvent[],
  options: Pick<InteractiveSessionInspectOptions, "around" | "tail" | "context" | "includeTools">,
): InteractiveSessionEvent[] {
  const filtered = filterInteractiveEvents(events, options.includeTools ?? false);
  const context = Math.max(options.context ?? DEFAULT_INTERACTIVE_DETAIL_CONTEXT, 0);
  const tail = options.tail === undefined ? DEFAULT_INTERACTIVE_DETAIL_TAIL : Math.max(options.tail, 0);
  const around = options.around?.trim();

  if (around) {
    const numeric = Number.parseInt(around, 10);
    const matchIndex = Number.isFinite(numeric) && /^\d+$/.test(around)
      ? filtered.findIndex((event) => event.index === numeric || event.line === numeric)
      : filtered.findIndex((event) => {
        const haystack = `${event.kind}\n${event.summary}\n${event.text ?? ""}`.toLowerCase();
        return haystack.includes(around.toLowerCase());
      });
    if (matchIndex >= 0) {
      return filtered.slice(Math.max(matchIndex - context, 0), matchIndex + context + 1);
    }
  }

  return tail > 0 ? filtered.slice(-tail) : [];
}

async function readSessionPrefix(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    let totalBytes = 0;
    let newlineCount = 0;

    while (totalBytes < SESSION_METADATA_MAX_BYTES && newlineCount < SESSION_METADATA_MAX_LINES) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, SESSION_METADATA_MAX_BYTES - totalBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
      totalBytes += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      chunks.push(chunk);
      for (const byte of chunk) {
        if (byte === 10) {
          newlineCount += 1;
        }
      }
    }

    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readSessionIdentityPrefix(
  candidate: InteractiveSessionFileCandidate,
  maxBytes: number,
): Promise<string> {
  const boundedMaxBytes = Math.max(maxBytes, 1);
  const handle = await open(candidate.path, "r");
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    let totalBytes = 0;
    let newlineCount = 0;
    while (totalBytes < boundedMaxBytes && newlineCount < SESSION_IDENTITY_MAX_LINES) {
      const buffer = Buffer.alloc(Math.min(16 * 1024, boundedMaxBytes - totalBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      totalBytes += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      chunks.push(chunk);
      for (const byte of chunk) {
        if (byte === 10) newlineCount += 1;
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

function parseCodexFilename(filePath: string): { sessionId?: string; createdAt?: string } {
  const filename = path.basename(filePath);
  const isoMatch = filename.match(/^rollout-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-([0-9a-f-]+)\.jsonl$/i);
  if (isoMatch && isoMatch[1] && isoMatch[2] && isoMatch[3] && isoMatch[4]) {
    const createdAt = parseTimestamp(`${isoMatch[1]}:${isoMatch[2]}:${isoMatch[3]}Z`);
    return {
      sessionId: isoMatch[4],
      ...(createdAt ? { createdAt } : {}),
    };
  }

  const numericMatch = filename.match(/^rollout-(\d+)-([0-9a-f-]+)\.jsonl$/i);
  if (numericMatch && numericMatch[1] && numericMatch[2]) {
    const createdAt = parseTimestamp(Number(numericMatch[1]));
    return {
      sessionId: numericMatch[2],
      ...(createdAt ? { createdAt } : {}),
    };
  }

  const sessionId = codexSessionIdFromPath(filePath);
  return sessionId ? { sessionId } : {};
}

function parseCodexMetadata(filePath: string, raw: string): ParsedSessionMetadata {
  const parsedFromFilename = parseCodexFilename(filePath);
  const metadata: ParsedSessionMetadata = { ...parsedFromFilename };
  const lines = raw.split(/\r?\n/, 40);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }
      record = parsed;
    } catch {
      continue;
    }

    if (record["type"] === "session_meta" && isRecord(record["payload"])) {
      const payload = record["payload"];
      if (typeof payload["id"] === "string") {
        metadata.sessionId = payload["id"];
      }
      const createdAt = parseTimestamp(payload["timestamp"]);
      if (createdAt) {
        metadata.createdAt = createdAt;
      }
      if (typeof payload["cwd"] === "string") {
        metadata.cwd = payload["cwd"];
      }
      continue;
    }

    if (!metadata.summary && record["type"] === "response_item" && isRecord(record["payload"])) {
      const payload = record["payload"];
      if (payload["type"] === "message" && payload["role"] === "user") {
        const text = extractMessageText(payload);
        if (isUsefulPromptSummary(text)) {
          metadata.summary = text;
        }
      }
    }
  }

  return metadata;
}

function parseClaudeMetadata(filePath: string, raw: string): ParsedSessionMetadata {
  const metadata: ParsedSessionMetadata = {
    sessionId: path.basename(filePath, ".jsonl"),
  };
  const lines = raw.split(/\r?\n/, 40);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }
      record = parsed;
    } catch {
      continue;
    }

    if (typeof record["sessionId"] === "string") {
      metadata.sessionId = record["sessionId"];
    }
    const createdAt = parseTimestamp(record["timestamp"]);
    if (!metadata.createdAt && createdAt) {
      metadata.createdAt = createdAt;
    }
    if (typeof record["cwd"] === "string") {
      metadata.cwd = record["cwd"];
    }
    if (!metadata.summary && record["type"] === "user") {
      const text = extractMessageText(record["message"]);
      if (isUsefulPromptSummary(text)) {
        metadata.summary = text;
      }
    }
  }

  return metadata;
}

function parseCalyxRunMetadata(filePath: string, raw: string): ParsedSessionMetadata {
  const metadata: ParsedSessionMetadata = {
    sessionId: path.basename(path.dirname(filePath)),
  };
  const lines = raw.split(/\r?\n/, 40);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }
      record = parsed;
    } catch {
      continue;
    }
    if (typeof record["run_id"] === "string") {
      metadata.sessionId = record["run_id"];
    }
    const createdAt = parseTimestamp(record["timestamp"]) ?? parseTimestamp(record["recorded_at"]);
    if (!metadata.createdAt && createdAt) {
      metadata.createdAt = createdAt;
    }
    if (!metadata.summary) {
      const summary = recordText(record["message"]) ?? recordText(record["payload"]) ?? recordText(record);
      if (summary) {
        metadata.summary = summary;
      }
    }
  }
  return metadata;
}

function firstBoundedTimestamp(raw: string): string | undefined {
  const contentBoundary = [raw.indexOf('"message"'), raw.indexOf('"content"')]
    .filter((index) => index >= 0)
    .reduce((minimum, index) => Math.min(minimum, index), Number.POSITIVE_INFINITY);
  const match = /"timestamp"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/.exec(raw);
  if (!match || match.index > contentBoundary || !match[1]) return undefined;
  try {
    return parseTimestamp(JSON.parse(`"${match[1]}"`) as unknown);
  } catch {
    return undefined;
  }
}

function decodeJsonStringCapture(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(`"${value}"`) as unknown;
    return typeof decoded === "string" && decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function boundedCodexSessionMetaId(raw: string): string | undefined {
  const match = /"type"\s*:\s*"session_meta"[\s\S]{0,4096}?"payload"\s*:\s*\{[\s\S]{0,4096}?"id"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/.exec(raw);
  return decodeJsonStringCapture(match?.[1]);
}

function canonicalIdentityMetadata(
  candidate: InteractiveSessionFileCandidate,
  raw: string,
): Required<Pick<ParsedSessionMetadata, "sessionId" | "createdAt">> {
  const firstRecordComplete = raw.includes("\n") || Buffer.byteLength(raw) >= candidate.size;
  let sessionId: string | undefined;
  let createdAt: string | undefined;

  if (candidate.source === "codex_sessions") {
    const fromFilename = parseCodexFilename(candidate.path);
    const fromPrefix = parseCodexMetadata(candidate.path, raw);
    sessionId = boundedCodexSessionMetaId(raw) ?? fromPrefix.sessionId ?? fromFilename.sessionId;
    createdAt = fromFilename.createdAt ?? fromPrefix.createdAt;
  } else if (candidate.source === "claude_projects") {
    sessionId = path.basename(candidate.path, ".jsonl");
    createdAt = firstRecordComplete
      ? parseClaudeMetadata(candidate.path, raw).createdAt
      : firstBoundedTimestamp(raw);
  } else {
    sessionId = path.basename(path.dirname(candidate.path));
    createdAt = firstRecordComplete
      ? parseCalyxRunMetadata(candidate.path, raw).createdAt
      : firstBoundedTimestamp(raw);
  }

  if (!createdAt && candidate.birthtimeMs > 0) {
    createdAt = new Date(candidate.birthtimeMs).toISOString();
  }
  if (!sessionId || !createdAt) {
    throw new InteractiveActivityProjectionNotReadyError(
      "Interactive activity source does not expose a bounded immutable identity.",
      {
        reason: "identity_prefix_limit",
        source_path: candidate.path,
      },
    );
  }
  return { sessionId, createdAt };
}

async function collectSessionFiles(
  root: string,
  backend: InteractiveSessionBackend,
  source: InteractiveSessionListEntry["source"],
  budget?: CandidateBudget,
  beforeDiscoveryRead?: ((directoryPath: string) => Promise<void>) | undefined,
  beforeCandidateStat?: ((candidatePath: string) => Promise<void>) | undefined,
): Promise<InteractiveSessionFileCandidate[]> {
  const candidates: InteractiveSessionFileCandidate[] = [];
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    let entries;
    try {
      await beforeDiscoveryRead?.(current);
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (isExpectedMissingPathError(error)) continue;
      throw discoveryReadFailed(current);
    }

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (backend === "claude" && entry.name === "subagents") {
          continue;
        }
        queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      try {
        await beforeCandidateStat?.(absolutePath);
        const info = await stat(absolutePath);
        if (budget) {
          budget.seen += 1;
          if (budget.seen > budget.limit) {
            throw new InteractiveActivityProjectionNotReadyError(
              `Interactive activity identity discovery exceeded the bounded ${budget.limit}-source page budget.`,
              {
                reason: "candidate_limit",
                candidate_limit: budget.limit,
                candidates_seen: budget.seen,
              },
            );
          }
        }
        candidates.push({
          backend,
          source,
          path: absolutePath,
          birthtimeMs: info.birthtimeMs,
          mtimeMs: info.mtimeMs,
          size: info.size,
        });
      } catch (error) {
        if (error instanceof InteractiveActivityProjectionNotReadyError) throw error;
        if (isExpectedMissingPathError(error)) continue;
        throw discoveryReadFailed(absolutePath);
      }
    }
  }

  return candidates;
}

async function readCalyxRunBackend(eventsPath: string): Promise<InteractiveSessionBackend> {
  try {
    const recordPath = path.join(path.dirname(eventsPath), "run_record.json");
    const parsed = JSON.parse(await readFile(recordPath, "utf8")) as unknown;
    if (isRecord(parsed) && isRecord(parsed["intent"])) {
      const backend = parsed["intent"]["backend"];
      if (backend === "claude" || backend === "codex") {
        return backend;
      }
    }
  } catch {
    // Fall through to the parser-safe default. Calyx run streams are
    // operational JSONL; `codex` here is only the generic fallback parser.
  }
  return "codex";
}

async function collectCalyxRunEventFiles(
  root: string,
  budget?: CandidateBudget,
  beforeDiscoveryRead?: ((directoryPath: string) => Promise<void>) | undefined,
  beforeCandidateStat?: ((candidatePath: string) => Promise<void>) | undefined,
): Promise<InteractiveSessionFileCandidate[]> {
  const candidates: InteractiveSessionFileCandidate[] = [];
  let entries;
  try {
    await beforeDiscoveryRead?.(root);
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isExpectedMissingPathError(error)) return candidates;
    throw discoveryReadFailed(root);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const eventsPath = path.join(root, entry.name, "events.jsonl");
    try {
      await beforeCandidateStat?.(eventsPath);
      const info = await stat(eventsPath);
      if (budget) {
        budget.seen += 1;
        if (budget.seen > budget.limit) {
          throw new InteractiveActivityProjectionNotReadyError(
            `Interactive activity identity discovery exceeded the bounded ${budget.limit}-source page budget.`,
            {
              reason: "candidate_limit",
              candidate_limit: budget.limit,
              candidates_seen: budget.seen,
            },
          );
        }
      }
      candidates.push({
        backend: await readCalyxRunBackend(eventsPath),
        source: "calyx_runs",
        path: eventsPath,
        birthtimeMs: info.birthtimeMs,
        mtimeMs: info.mtimeMs,
        size: info.size,
      });
    } catch (error) {
      if (error instanceof InteractiveActivityProjectionNotReadyError) throw error;
      if (isExpectedMissingPathError(error)) continue;
      throw discoveryReadFailed(eventsPath);
    }
  }
  return candidates;
}

export interface ResolvedCodexSessionRoots {
  sessionsRoot: string;
  archivedSessionsRoot: string;
}

function normalizeHomeDir(
  homeDir: string,
  backend: "calyx" | "claude" | "codex",
): string {
  const trimmed = homeDir.trim();
  if (!trimmed) {
    throw new InteractiveActivityRootConfigurationError(
      `Interactive ${backend} homeDir must not be empty.`,
      { backend, reason: "invalid_home" },
    );
  }
  return path.resolve(trimmed);
}

function codexRootsFromHome(codexHome: string): ResolvedCodexSessionRoots {
  const normalizedHome = path.resolve(codexHome);
  return {
    sessionsRoot: path.join(normalizedHome, "sessions"),
    archivedSessionsRoot: path.join(normalizedHome, "archived_sessions"),
  };
}

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertDisjointCodexRoots(roots: ResolvedCodexSessionRoots): ResolvedCodexSessionRoots {
  if (
    pathContains(roots.sessionsRoot, roots.archivedSessionsRoot)
    || pathContains(roots.archivedSessionsRoot, roots.sessionsRoot)
  ) {
    throw new InteractiveActivityRootConfigurationError(
      "Codex active and archived session roots must be disjoint.",
      {
        backend: "codex",
        reason: "overlapping_roots",
        sessions_root: roots.sessionsRoot,
        archived_sessions_root: roots.archivedSessionsRoot,
      },
    );
  }
  return roots;
}

function codexHomeFromPartialRoot(root: string, expectedLeaf: "archived_sessions" | "sessions"): string {
  const normalizedRoot = path.resolve(root);
  if (path.basename(normalizedRoot) !== expectedLeaf) {
    throw new InteractiveActivityRootConfigurationError(
      `A partial Codex ${expectedLeaf} root must end with "${expectedLeaf}".`,
      {
        backend: "codex",
        reason: "invalid_root_name",
        root: normalizedRoot,
        expected: expectedLeaf,
      },
    );
  }
  return path.dirname(normalizedRoot);
}

function assertPartialCodexRootMatchesHome(
  suppliedRoot: string,
  expectedRoot: string,
): void {
  const normalizedRoot = path.resolve(suppliedRoot);
  if (normalizedRoot !== expectedRoot) {
    throw new InteractiveActivityRootConfigurationError(
      "A partial Codex root cannot escape an explicit homeDir isolation boundary.",
      {
        backend: "codex",
        reason: "conflicting_home",
        root: normalizedRoot,
        expected: expectedRoot,
      },
    );
  }
}

/**
 * Resolve Codex's active and recoverable-archive roots as one coherent pair.
 *
 * A fully explicit pair is authoritative. Otherwise an explicit home is an
 * isolation boundary; a partial explicit root must agree with that boundary.
 * Without an explicit home, a partial option is accepted only when its final
 * path segment names the declared root, then both roots are derived from the
 * normalized Codex home. Legacy environment overrides keep their historical
 * free-form active-root contract; the archive root remains derived from
 * CODEX_HOME (or the default Codex home). Every returned pair is absolute and
 * disjoint.
 */
export function resolveCodexSessionRoots(
  options: Pick<
    InteractiveActivityOptions,
    "homeDir" | "codexSessionsRoot" | "codexArchivedSessionsRoot"
  >,
): ResolvedCodexSessionRoots {
  const explicitSessionsRoot = options.codexSessionsRoot?.trim();
  const explicitArchivedSessionsRoot = options.codexArchivedSessionsRoot?.trim();
  if (explicitSessionsRoot && explicitArchivedSessionsRoot) {
    return assertDisjointCodexRoots({
      sessionsRoot: path.resolve(explicitSessionsRoot),
      archivedSessionsRoot: path.resolve(explicitArchivedSessionsRoot),
    });
  }

  if (options.homeDir !== undefined) {
    const roots = codexRootsFromHome(path.join(normalizeHomeDir(options.homeDir, "codex"), ".codex"));
    if (explicitSessionsRoot) {
      assertPartialCodexRootMatchesHome(explicitSessionsRoot, roots.sessionsRoot);
    }
    if (explicitArchivedSessionsRoot) {
      assertPartialCodexRootMatchesHome(explicitArchivedSessionsRoot, roots.archivedSessionsRoot);
    }
    return assertDisjointCodexRoots(roots);
  }

  if (explicitSessionsRoot) {
    return assertDisjointCodexRoots(codexRootsFromHome(
      codexHomeFromPartialRoot(explicitSessionsRoot, "sessions"),
    ));
  }
  if (explicitArchivedSessionsRoot) {
    return assertDisjointCodexRoots(codexRootsFromHome(
      codexHomeFromPartialRoot(explicitArchivedSessionsRoot, "archived_sessions"),
    ));
  }

  const legacySessionsRoot = process.env["CALYX_CONTEXT_CODEX_SESSIONS_ROOT"]?.trim()
    || process.env["CODEX_SESSIONS_ROOT"]?.trim();
  const codexHome = process.env["CODEX_HOME"]?.trim() || path.join(homedir(), ".codex");
  if (legacySessionsRoot) {
    return assertDisjointCodexRoots({
      sessionsRoot: path.resolve(legacySessionsRoot),
      archivedSessionsRoot: codexRootsFromHome(codexHome).archivedSessionsRoot,
    });
  }

  return assertDisjointCodexRoots(codexRootsFromHome(codexHome));
}

export function codexSessionsRoot(options: { homeDir: string; explicitRoot?: string }): string {
  return resolveCodexSessionRoots({
    homeDir: options.homeDir,
    ...(options.explicitRoot !== undefined ? { codexSessionsRoot: options.explicitRoot } : {}),
  }).sessionsRoot;
}

export function resolveCodexSessionsRoot(
  options: Pick<
    InteractiveActivityOptions,
    "homeDir" | "codexSessionsRoot" | "codexArchivedSessionsRoot"
  >,
): string {
  return resolveCodexSessionRoots(options).sessionsRoot;
}

export function codexArchivedSessionsRoot(options: { homeDir: string; explicitRoot?: string }): string {
  return resolveCodexSessionRoots({
    homeDir: options.homeDir,
    ...(options.explicitRoot !== undefined
      ? { codexArchivedSessionsRoot: options.explicitRoot }
      : {}),
  }).archivedSessionsRoot;
}

export function resolveCodexArchivedSessionsRoot(
  options: Pick<
    InteractiveActivityOptions,
    "homeDir" | "codexSessionsRoot" | "codexArchivedSessionsRoot"
  >,
): string {
  return resolveCodexSessionRoots(options).archivedSessionsRoot;
}

function assertSingleExactSessionMatch(
  activityId: string,
  matches: InteractiveSessionListEntry[],
): InteractiveSessionListEntry | undefined {
  if (matches.length > 1) {
    throw new InteractiveActivityProjectionNotReadyError(
      `Multiple interactive activity sources resolve to exact activity "${activityId}".`,
      { reason: "identity_collision" },
    );
  }
  return matches[0];
}

/**
 * Resolve an exact interactive identity across active truth and Codex's
 * recoverable archive with one complete, hard-bounded identity scan. This is
 * intentionally exact-only: prefix/recent/latest discovery remains active.
 */
export async function resolveExactInteractiveSession(
  options: InteractiveActivityOptions & { activityId: string },
): Promise<InteractiveSessionListEntry | undefined> {
  const parsed = parseInteractiveActivityLocator(options.activityId);
  const sessions = await listInteractiveSessionIdentities({
    ...options,
    ...(parsed.backend ? { kinds: [parsed.backend] } : {}),
    includeCodexArchivedSessions: parsed.backend === undefined || parsed.backend === "codex",
    candidateLimit: options.candidateLimit ?? DEFAULT_INTERACTIVE_PAGE_CANDIDATE_LIMIT,
  });
  return assertSingleExactSessionMatch(
    options.activityId,
    sessions.filter((candidate) => (
      candidate.run_id === options.activityId
      || interactiveSessionMatchesLocator(candidate, parsed)
    )),
  );
}

export function resolveClaudeProjectsRoot(
  options: Pick<InteractiveActivityOptions, "homeDir" | "claudeProjectsRoot">,
): string {
  const explicitRoot = options.claudeProjectsRoot?.trim();
  if (explicitRoot) return path.resolve(explicitRoot);
  if (options.homeDir !== undefined) {
    return path.join(normalizeHomeDir(options.homeDir, "claude"), ".claude", "projects");
  }
  const environmentRoot = process.env["CALYX_CONTEXT_CLAUDE_PROJECTS_ROOT"]?.trim()
    || process.env["CLAUDE_PROJECTS_ROOT"]?.trim();
  if (environmentRoot) return path.resolve(environmentRoot);
  const claudeHome = process.env["CLAUDE_HOME"]?.trim();
  return claudeHome
    ? path.join(path.resolve(claudeHome), "projects")
    : path.join(homedir(), ".claude", "projects");
}

export function claudeProjectsRoot(options: { homeDir: string; explicitRoot?: string }): string {
  return resolveClaudeProjectsRoot({
    homeDir: options.homeDir,
    ...(options.explicitRoot !== undefined ? { claudeProjectsRoot: options.explicitRoot } : {}),
  });
}

export function resolveCalyxRunsRoot(
  options: Pick<InteractiveActivityOptions, "homeDir" | "calyxRunsRoot">,
): string {
  const explicitRoot = options.calyxRunsRoot?.trim();
  if (explicitRoot) return path.resolve(explicitRoot);
  if (options.homeDir !== undefined) {
    return path.join(normalizeHomeDir(options.homeDir, "calyx"), ".calyx", "runs");
  }
  const environmentRoot = process.env["CALYX_RUNS_ROOT"]?.trim();
  return environmentRoot ? path.resolve(environmentRoot) : path.join(homedir(), ".calyx", "runs");
}

export function calyxRunsRoot(options: { homeDir: string; explicitRoot?: string }): string {
  return resolveCalyxRunsRoot({
    homeDir: options.homeDir,
    ...(options.explicitRoot !== undefined ? { calyxRunsRoot: options.explicitRoot } : {}),
  });
}

function toInteractiveEntry(
  candidate: InteractiveSessionFileCandidate,
  metadata: ParsedSessionMetadata,
  options: { host?: string },
): InteractiveSessionListEntry {
  const sessionId = metadata.sessionId ?? path.basename(candidate.path, ".jsonl");
  const createdAt = metadata.createdAt ?? new Date(candidate.mtimeMs).toISOString();
  const fallbackSummary = `${candidate.backend} interactive session${metadata.cwd ? ` in ${metadata.cwd}` : ""}`;
  return {
    entry_kind: "interactive_session",
    run_id: `interactive:${candidate.backend}:${sessionId}`,
    state: "interactive",
    summary: summarizeText(metadata.summary, fallbackSummary),
    created_at: createdAt,
    updated_at: new Date(candidate.mtimeMs).toISOString(),
    ...(options.host ? { host: options.host } : {}),
    backend: candidate.backend,
    session_id: sessionId,
    session_path: candidate.path,
    ...(metadata.cwd ? { cwd: metadata.cwd } : {}),
    source: candidate.source,
    bytes: candidate.size,
  };
}

/**
 * Cheap discovery of every transcript file under the harness-native roots:
 * `readdir`+`stat` only, sorted newest-first and filtered by the `sinceMs`
 * lookback. No prefix/metadata read happens here, so enumerating the full
 * local history (thousands of files) is bounded by directory walking, not by
 * per-file opens. Callers that need full entries load only the slice they
 * intend to process via {@link loadInteractiveSessionEntry}.
 */
export async function discoverInteractiveSessionFiles(
  options: InteractiveActivityOptions = {},
): Promise<InteractiveSessionFileCandidate[]> {
  const codexRoots = resolveCodexSessionRoots(options);
  const claudeRoot = resolveClaudeProjectsRoot(options);
  const calyxRoot = resolveCalyxRunsRoot(options);
  const kinds = new Set<InteractiveSessionBackend>(options.kinds ?? ["claude", "codex"]);
  const now = options.now?.() ?? new Date();
  const lookbackMs = options.sinceMs ?? DEFAULT_INTERACTIVE_ACTIVITY_LOOKBACK_MS;
  const cutoff = lookbackMs > 0 ? now.getTime() - lookbackMs : undefined;
  const budget = options.candidateLimit === undefined
    ? undefined
    : { limit: Math.max(options.candidateLimit, 0), seen: 0 };

  const batches = await Promise.all([
    kinds.has("codex")
      ? collectSessionFiles(
        codexRoots.sessionsRoot,
        "codex",
        "codex_sessions",
        budget,
        options.beforeDiscoveryRead,
        options.beforeCandidateStat,
      )
      : Promise.resolve([]),
    kinds.has("codex") && options.includeCodexArchivedSessions === true
      ? collectSessionFiles(
        codexRoots.archivedSessionsRoot,
        "codex",
        "codex_sessions",
        budget,
        options.beforeDiscoveryRead,
        options.beforeCandidateStat,
      )
      : Promise.resolve([]),
    kinds.has("claude")
      ? collectSessionFiles(
        claudeRoot,
        "claude",
        "claude_projects",
        budget,
        options.beforeDiscoveryRead,
        options.beforeCandidateStat,
      )
      : Promise.resolve([]),
    options.includeCalyxRuns === true
      ? collectCalyxRunEventFiles(
        calyxRoot,
        budget,
        options.beforeDiscoveryRead,
        options.beforeCandidateStat,
      )
      : Promise.resolve([]),
  ]);

  return batches
    .flat()
    .filter((candidate) => cutoff === undefined || candidate.mtimeMs >= cutoff)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
}

/**
 * Read one discovered candidate's metadata prefix and build its full
 * {@link InteractiveSessionListEntry}. Returns `undefined` if the file vanished
 * between discovery and read. This is the per-file expensive step; callers
 * bound how many they invoke per tick.
 */
export async function loadInteractiveSessionEntry(
  candidate: InteractiveSessionFileCandidate,
  options: { host?: string | undefined; failClosed?: boolean | undefined } = {},
): Promise<InteractiveSessionListEntry | undefined> {
  let raw: string;
  let identityRaw: string;
  try {
    [raw, identityRaw] = await Promise.all([
      readSessionPrefix(candidate.path),
      readSessionIdentityPrefix(candidate, SESSION_IDENTITY_MAX_BYTES),
    ]);
  } catch (error) {
    if (error instanceof InteractiveActivityProjectionNotReadyError) throw error;
    if (options.failClosed) {
      throw new InteractiveActivityProjectionNotReadyError(
        "Interactive activity source became unreadable during its metadata projection.",
        { reason: "metadata_read_failed", source_path: candidate.path },
      );
    }
    return undefined;
  }
  const richMetadata = candidate.source === "calyx_runs"
    ? parseCalyxRunMetadata(candidate.path, raw)
    : candidate.backend === "codex"
      ? parseCodexMetadata(candidate.path, raw)
      : parseClaudeMetadata(candidate.path, raw);
  const identity = canonicalIdentityMetadata(candidate, identityRaw);
  const metadata = { ...richMetadata, ...identity };
  const host = normalizeHost(options.host);
  return toInteractiveEntry(candidate, metadata, host ? { host } : {});
}

async function loadInteractiveSessionIdentity(
  candidate: InteractiveSessionFileCandidate,
  options: { host?: string; identityMaxBytes: number },
): Promise<InteractiveSessionIdentity | undefined> {
  let raw: string;
  try {
    raw = await readSessionIdentityPrefix(
      candidate,
      candidate.source === "codex_sessions"
        ? Math.min(options.identityMaxBytes, 4 * 1024)
        : options.identityMaxBytes,
    );
  } catch (error) {
    if (error instanceof InteractiveActivityProjectionNotReadyError) throw error;
    throw new InteractiveActivityProjectionNotReadyError(
      "Interactive activity source became unreadable during its identity projection.",
      { reason: "identity_read_failed", source_path: candidate.path },
    );
  }
  const metadata = canonicalIdentityMetadata(candidate, raw);
  const host = normalizeHost(options.host);
  return {
    candidate,
    entry: toInteractiveEntry(candidate, metadata, host ? { host } : {}),
  };
}

/**
 * Complete bounded identity scan used by detail locators. Unlike the legacy
 * recent-session list, this never truncates before an exact locator match and
 * pays the richer metadata read only after a caller has selected a source.
 */
export async function listInteractiveSessionIdentities(
  options: InteractiveActivityOptions = {},
): Promise<InteractiveSessionListEntry[]> {
  const candidates = await discoverInteractiveSessionFiles({
    ...options,
    sinceMs: 0,
    candidateLimit: options.candidateLimit ?? DEFAULT_INTERACTIVE_PAGE_CANDIDATE_LIMIT,
  });
  const entries: InteractiveSessionListEntry[] = [];
  for (const candidate of candidates) {
    await options.beforeIdentityRead?.(candidate);
    const identity = await loadInteractiveSessionIdentity(candidate, {
      ...(options.host ? { host: options.host } : {}),
      identityMaxBytes: options.identityMaxBytes ?? SESSION_IDENTITY_MAX_BYTES,
    });
    if (identity) entries.push(identity.entry);
  }
  return entries.sort(compareInteractivePageEntries);
}

function compareInteractivePageEntries(
  left: InteractiveSessionListEntry,
  right: InteractiveSessionListEntry,
): number {
  const timeCompare = Date.parse(right.created_at) - Date.parse(left.created_at);
  if (timeCompare !== 0) return timeCompare;
  return compareUtf8Identity(left.run_id, right.run_id);
}

function compareUtf8Identity(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export async function listInteractiveSessions(
  options: InteractiveActivityOptions = {},
): Promise<InteractiveSessionListEntry[]> {
  const limit = options.limit ?? DEFAULT_INTERACTIVE_ACTIVITY_LIMIT;
  const candidates = (await discoverInteractiveSessionFiles(options)).slice(0, Math.max(limit, 0));

  const entries: InteractiveSessionListEntry[] = [];
  for (const candidate of candidates) {
    const entry = await loadInteractiveSessionEntry(candidate, { host: options.host });
    const after = options.after;
    const isAfter = !after
      || entry && (entry.created_at < after.created_at
        || (entry.created_at === after.created_at
          && compareUtf8Identity(entry.run_id, after.run_id) > 0));
    const isRecentEnough = !options.createdSince
      || entry && entry.created_at >= options.createdSince;
    const isWithinSnapshot = !options.createdBefore
      || entry && entry.created_at <= options.createdBefore;
    if (entry && isAfter && isRecentEnough && isWithinSnapshot) {
      entries.push(entry);
      if (entries.length >= Math.max(limit, 0)) break;
    }
  }

  return entries.sort(compareInteractivePageEntries);
}

/**
 * Exact immutable-key page source for consumer list operations.
 *
 * Discovery has a hard source-count bound. Every candidate pays only a small
 * identity-prefix read so the complete set can be filtered and ordered by
 * `(created_at DESC, run_id ASC)`; the richer 256 KiB prefix is loaded only for
 * the selected page. If the bounded identity pass cannot prove completeness,
 * the function fails typed and retryably instead of returning a partial page.
 */
export async function listInteractiveSessionsPage(
  options: InteractiveActivityOptions & { limit: number },
): Promise<InteractiveSessionListEntry[]> {
  return (await listInteractiveSessionsSnapshotPage(options)).entries;
}

export interface InteractiveSessionSnapshotPage {
  entries: InteractiveSessionListEntry[];
  membershipFingerprint: string;
}

/**
 * Exact page plus a privacy-preserving digest of the complete eligible source
 * membership. Continuations present the digest from page one; any source
 * admission, removal, or immutable identity change fails closed instead of
 * mixing two estate snapshots.
 */
export async function listInteractiveSessionsSnapshotPage(
  options: InteractiveActivityOptions & { limit: number },
): Promise<InteractiveSessionSnapshotPage> {
  const limit = Math.max(options.limit, 0);
  const candidates = await discoverInteractiveSessionFiles({
    ...options,
    sinceMs: 0,
    candidateLimit: options.candidateLimit ?? DEFAULT_INTERACTIVE_PAGE_CANDIDATE_LIMIT,
  });
  const snapshotIdentities: InteractiveSessionIdentity[] = [];
  for (const candidate of candidates) {
    await options.beforeIdentityRead?.(candidate);
    const identity = await loadInteractiveSessionIdentity(candidate, {
      ...(options.host ? { host: options.host } : {}),
      identityMaxBytes: options.identityMaxBytes ?? SESSION_IDENTITY_MAX_BYTES,
    });
    if (!identity) continue;
    const { entry } = identity;
    if (options.createdSince && entry.created_at < options.createdSince) continue;
    if (options.createdBefore && entry.created_at > options.createdBefore) continue;
    snapshotIdentities.push(identity);
  }
  const publicIdentityKeys = new Set<string>();
  for (const { entry } of snapshotIdentities) {
    const key = JSON.stringify([entry.created_at, entry.run_id]);
    if (publicIdentityKeys.has(key)) {
      throw new InteractiveActivityProjectionNotReadyError(
        "Multiple interactive activity sources resolve to the same public list identity.",
        { reason: "identity_collision" },
      );
    }
    publicIdentityKeys.add(key);
  }
  const membershipFingerprint = createHash("sha256")
    .update(JSON.stringify(snapshotIdentities
      .map(({ candidate, entry }) => ({
        backend: candidate.backend,
        source: candidate.source,
        path: candidate.path,
        birthtime_ms: candidate.birthtimeMs,
        run_id: entry.run_id,
        created_at: entry.created_at,
      }))
      .sort((left, right) => compareUtf8Identity(left.path, right.path))))
    .digest("base64url");
  if (
    options.expectedMembershipFingerprint
    && options.expectedMembershipFingerprint !== membershipFingerprint
  ) {
    throw new InteractiveActivityProjectionNotReadyError(
      "Interactive activity membership changed after the seek-page snapshot was established.",
      { reason: "snapshot_drift" },
    );
  }

  const identities: InteractiveSessionIdentity[] = [];
  for (const identity of snapshotIdentities) {
    const { entry } = identity;
    const after = options.after;
    if (after && !(
      entry.created_at < after.created_at
      || (entry.created_at === after.created_at
        && (
          compareUtf8Identity(entry.run_id, after.run_id) > 0
          || (
            entry.run_id === after.run_id
            && after.entry_kind === "calyx_run"
          )
        ))
    )) continue;
    identities.push(identity);
  }
  identities.sort((left, right) => compareInteractivePageEntries(left.entry, right.entry));
  await options.beforePageMetadataRead?.();

  const page: InteractiveSessionListEntry[] = [];
  for (const identity of identities.slice(0, limit)) {
    const entry = await loadInteractiveSessionEntry(identity.candidate, {
      host: options.host,
      failClosed: true,
    });
    if (!entry) {
      throw new InteractiveActivityProjectionNotReadyError(
        "Interactive activity source disappeared during its metadata projection.",
        { reason: "metadata_read_failed", source_path: identity.candidate.path },
      );
    }
    if (
      entry.created_at !== identity.entry.created_at
      || entry.run_id !== identity.entry.run_id
    ) {
      throw new InteractiveActivityProjectionNotReadyError(
        `Interactive activity identity changed between the bounded identity and page metadata reads.`,
        {
          reason: "identity_drift",
          source_path: identity.candidate.path,
        },
      );
    }
    page.push(entry);
  }
  return {
    entries: page.sort(compareInteractivePageEntries),
    membershipFingerprint,
  };
}

export async function inspectInteractiveSession(
  options: InteractiveSessionInspectOptions,
): Promise<InteractiveSessionInspectResult> {
  const identity = await resolveExactInteractiveSession(options);
  if (!identity) {
    throw new Error(`Interactive session "${options.activityId}" not found.`);
  }

  const info = await stat(identity.session_path);
  const session = await loadInteractiveSessionEntry({
    backend: identity.backend,
    source: identity.source,
    path: identity.session_path,
    birthtimeMs: info.birthtimeMs,
    mtimeMs: info.mtimeMs,
    size: info.size,
  }, { ...(options.host ? { host: options.host } : {}), failClosed: true });
  if (!session || session.run_id !== identity.run_id) {
    throw new InteractiveActivityProjectionNotReadyError(
      "Interactive activity identity changed during exact detail resolution.",
      { reason: "identity_drift", source_path: identity.session_path },
    );
  }

  const raw = await readFile(session.session_path, "utf8");
  const events = session.source === "calyx_runs"
    ? parseCalyxRunEvents(raw)
    : session.backend === "codex"
      ? parseCodexSessionEvents(raw)
      : parseClaudeSessionEvents(raw);
  const selected = chooseInteractiveEvents(events, options);
  const filteredCount = filterInteractiveEvents(events, options.includeTools ?? false).length;

  return {
    activity_id: session.run_id,
    backend: session.backend,
    session_id: session.session_id,
    session_path: session.session_path,
    source: session.source,
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(typeof session.bytes === "number" ? { bytes: session.bytes } : {}),
    total_events: events.length,
    returned_events: selected.length,
    truncated: selected.length < filteredCount,
    ...(options.around ? { around: options.around } : {}),
    ...(typeof options.tail === "number" ? { tail: options.tail } : {}),
    ...(typeof options.context === "number" ? { context: options.context } : {}),
    include_tools: options.includeTools ?? false,
    events: selected,
  };
}

export async function summarizeInteractiveSessions(
  options: InteractiveActivityOptions = {},
): Promise<InteractiveSessionSummary> {
  const windowMs = options.sinceMs ?? DEFAULT_INTERACTIVE_ACTIVITY_LOOKBACK_MS;
  const scannedAt = (options.now?.() ?? new Date()).toISOString();
  const sessions = await listInteractiveSessions({
    ...options,
    sinceMs: windowMs,
    limit: options.limit ?? 1_000,
  });
  const codex = sessions.filter((session) => session.backend === "codex").length;
  const claude = sessions.filter((session) => session.backend === "claude").length;
  return {
    window_ms: windowMs,
    scanned_at: scannedAt,
    codex,
    claude,
    total: codex + claude,
    status: "ok",
  };
}
