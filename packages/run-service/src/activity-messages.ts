import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir, hostname } from "node:os";
import { TextDecoder } from "node:util";
import type {
  ActivityAttachmentRow,
  ActivityMessageRow,
  ActivitySourceCursorRow,
} from "@polli-labs/calyx-core";
import {
  CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_MAX_CHARS,
  CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_PATTERN_SOURCE,
  withSqliteMutex,
} from "@polli-labs/calyx-core";
import {
  InteractiveActivityProjectionNotReadyError,
  loadInteractiveSessionEntry,
  listInteractiveSessionIdentities,
  listInteractiveSessions,
  normalizeHost,
  resolveExactInteractiveSession,
  resolveCodexSessionRoots,
} from "./interactive-activity.js";
import {
  codexSessionIdFromPath,
  describeMalformedActivityLocator,
  formatMalformedActivityLocator,
  interactiveSessionMatchesLocator,
  interactiveSessionMatchesLocatorPrefix,
  normalizeBackendSessionId,
  parseInteractiveActivityLocator,
  type MalformedActivityLocator,
} from "./activity-id-resolution.js";
import type {
  InteractiveActivityOptions,
  InteractiveSessionInspectOptions,
} from "./interactive-activity.js";
import type {
  InteractiveSessionBackend,
  InteractiveSessionEvent,
  InteractiveSessionEventRole,
  InteractiveSessionListEntry,
  ExecutionReceipt,
  RunRecord,
} from "./types.js";

/**
 * Classifier rule-set version for the semantic activity-message projection.
 *
 * Bump when the projection rules below change. Surfaced via
 * `--explain-classification` and the `classifier_version` JSON field so
 * agents can detect silent classifier drift across Calyx releases.
 */
export const ACTIVITY_MESSAGE_CLASSIFIER_VERSION = "v1.2026.06.02";

const DEFAULT_ACTIVITY_MESSAGES_LAST = 40;
const DEFAULT_ACTIVITY_MESSAGES_CONTEXT = 3;
const DEFAULT_ACTIVITY_EVENTS_TAIL = 40;
const DEFAULT_ACTIVITY_EVENTS_CONTEXT = 6;
const DEFAULT_ACTIVITY_MESSAGE_TEXT_CHARS = 4_000;
const SESSION_FRESHNESS_LIVE_MS = 5 * 60 * 1000;
const STREAM_CHUNK_BYTES = 256 * 1024;
export const ACTIVITY_ATTACHMENT_MAX_BYTES = 64 * 1024 * 1024;
export const ACTIVITY_ATTACHMENT_CACHE_OBSERVATION_MAX_ITEMS = 64;
export const ACTIVITY_ATTACHMENT_CACHE_PROVENANCE_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_RECORD_BYTES = ACTIVITY_ATTACHMENT_MAX_BYTES;
const ATTACHMENT_REF_PREFIX = "att:sha256:";
const DEFAULT_ATTACHMENT_CACHE_DIR = ".calyx/cache/attachments/sha256";

async function syncFileContents(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryEntries(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Open, version-tolerant custody tier reported by the byte-serving hop.
 *
 * The current built-in values are `local-transcript`, `origin-daemon`, and
 * `blade-archive`; newer daemons may add bounded token values without making an
 * older client discard their durable custody observation.
 */
export type ActivityAttachmentSourceTier = string;

export type ActivityAttachmentErrorCode =
  | "activity_owner_unresolved"
  | "activity_owner_unreachable"
  | "attachment_ref_unknown"
  | "attachment_bytes_unavailable"
  | "attachment_digest_mismatch"
  | "attachment_archive_unavailable";

export interface ActivityAttachmentErrorDetails {
  expected_sha256?: string;
  actual_sha256?: string;
  ref?: string;
  activity_id?: string;
  searched_sources?: string[];
  candidates?: string[];
}

export class ActivityAttachmentError extends Error {
  readonly code: ActivityAttachmentErrorCode;
  readonly httpStatus: number;
  readonly details: ActivityAttachmentErrorDetails;

  constructor(
    code: ActivityAttachmentErrorCode,
    message: string,
    options: { httpStatus?: number; details?: ActivityAttachmentErrorDetails } = {},
  ) {
    super(message);
    this.name = "ActivityAttachmentError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? defaultAttachmentErrorStatus(code);
    this.details = options.details ?? {};
  }
}

export interface ActivityAttachmentCacheObservation {
  activity_id: string;
  message_id: string;
  source_line: number;
  source_shape: ActivityAttachmentSourceShape;
  origin_host?: string;
  served_by_host?: string;
  source_tier: ActivityAttachmentSourceTier;
  fetched_at: string;
  classifier_version: string;
}

export interface ActivityAttachmentCacheEntry {
  schema_version: "activity.attachment-cache-entry/v1";
  ref: string;
  sha256: string;
  mime_type: string;
  extension: string;
  byte_size: number;
  observations: ActivityAttachmentCacheObservation[];
}

export interface ActivityAttachmentRecordResult extends ActivityAttachmentRecord {
  schema_version: "activity.attachment-record/v1";
  classifier_version: string;
  source_tier: ActivityAttachmentSourceTier;
  source_locator?: string;
  origin_host?: string;
  served_by_host?: string;
  source_receipt: ActivitySourceReadReceipt;
}

export interface ActivityAttachmentBytesResult {
  record: ActivityAttachmentRecordResult;
  bytes: Buffer;
}

export type ActivityAttachmentCacheStatus = "hit" | "written" | "rewritten";

export interface ActivityAttachmentCacheWriteResult {
  path: string;
  provenance_path: string;
  cache_status: ActivityAttachmentCacheStatus;
  quarantined_path?: string;
}

export interface VerifiedActivityAttachmentCacheFile {
  path: string;
  byte_size: number;
  sha256: string;
}

interface PendingAttachment {
  ref: string;
  sha256: string;
  mime_type: string;
  byte_size: number;
  source_shape: ActivityAttachmentSourceShape;
  exact_bytes_available: boolean;
  base64?: string;
  detail?: "resized" | "original";
  original_locator?: string;
}

interface SanitizedJsonLine {
  text: string;
  attachments: PendingAttachment[];
}

export type ActivityMessageRole =
  | "human"
  | "assistant"
  | "harness_context"
  | "tool_call"
  | "tool_result"
  | "system_notice"
  | "reasoning_summary"
  | "unknown";

export const ACTIVITY_MESSAGE_ROLES: readonly ActivityMessageRole[] = [
  "human",
  "assistant",
  "harness_context",
  "tool_call",
  "tool_result",
  "system_notice",
  "reasoning_summary",
  "unknown",
];

export type ActivityMessageVisibility = "default" | "detail" | "hidden";

export type ActivityVisibilityTier = "default" | "+detail" | "+hidden" | "all";

export const ACTIVITY_VISIBILITY_TIERS: readonly ActivityVisibilityTier[] = [
  "default",
  "+detail",
  "+hidden",
  "all",
];

export type ActivitySourceState = "complete" | "live" | "partial";

export const ACTIVITY_TURN_ROLES = ["human", "assistant", "unknown"] as const;
export type ActivityTurnRole = (typeof ACTIVITY_TURN_ROLES)[number];
export const ACTIVITY_TURN_ROLE_FILTERS = ["human", "assistant", "unknown", "all"] as const;
export type ActivityTurnRoleFilter = (typeof ACTIVITY_TURN_ROLE_FILTERS)[number];

export type ActivityTurnState = "complete" | "in_flight";

export interface ActivitySourceWarning {
  code:
    | "partial_final_line"
    | "unparseable_line"
    | "live_session"
    | "empty_session"
    | "source_too_large";
  message: string;
  source_line?: number;
}

export interface ActivitySourceReadReceipt {
  mode: "streaming" | "full_load";
  bytes_scanned: number;
  records_scanned: number;
  records_decoded: number;
  oversized_records_skipped: number;
  max_record_bytes: number;
  source_bytes?: number;
  guard_hits: string[];
}

export interface ActivityTextCursor {
  total_chars: number;
  returned: Array<[number, number]>;
  next?: number;
}

export type ActivityAttachmentSourceShape =
  | "claude.source.base64"
  | "claude.file.base64"
  | "codex.input_image.data_url"
  | "codex.local_path"
  | "codex.remote_url"
  | "file_id"
  | "pasted_clipboard"
  | "unknown";

export interface ActivityAttachmentRecord {
  ref: string;
  sha256: string;
  mime_type: string;
  byte_size: number;
  source_shape: ActivityAttachmentSourceShape;
  exact_bytes_available: boolean;
  activity_id: string;
  message_id: string;
  source_line: number;
  event_index: number;
  detail?: "resized" | "original";
  original_locator?: string;
  extracted_path?: string;
  provenance_path?: string;
  cache_status?: ActivityAttachmentCacheStatus;
  origin_host?: string;
  served_by_host?: string;
  source_tier?: ActivityAttachmentSourceTier;
}

export interface ActivityAttachmentRollup {
  images: number;
  bytes: number;
  refs: string[];
}

/**
 * Recall-index freshness for the resolved transcript source (POL-1838).
 * Additive, optional metadata attached to read results so an agent can see how
 * current the per-host recall store is for this source without a separate call.
 * In slice 1 message bodies are still served from the live truth-plane parse;
 * this block reports whether the store has caught up (the body-from-store hot
 * flip is POL-1839). `store_state`:
 *   - `fresh`: cursor has consumed the whole file and the classifier matches.
 *   - `behind`: a cursor exists but an un-ingested tail remains or the
 *     classifier was bumped; the tailer will catch up on its next tick.
 *   - `absent`: the source has no cursor yet (never ingested).
 *   - `unavailable`: the recall index migration is not applied or the store
 *     could not be opened.
 */
export interface ActivityRecallFreshness {
  schema_version: "activity.recall-freshness/v1";
  store_state: "fresh" | "behind" | "absent" | "unavailable";
  fully_indexed: boolean;
  pending_bytes: number;
  store_message_count: number;
  classifier_version: string;
  classifier_current: boolean;
  indexed_through?: string;
  last_index_run_at?: string;
}

export interface ActivityMessageClassification {
  classifier_version: string;
  rule_id: string;
  reason: string;
  source_role: InteractiveSessionEventRole;
  source_kind: string;
  raw_type?: string;
}

export const ACTIVITY_MESSAGE_PAYLOAD_SCHEMA_VERSION = "activity.message-payload/v1";
const ACTIVITY_RECALL_STORE_BLOCKED_PREFIX = "store-blocked:";
export const ACTIVITY_RECALL_STORE_BLOCKED_PARSE_WARNINGS =
  `${ACTIVITY_RECALL_STORE_BLOCKED_PREFIX}parse-warnings`;
export const ACTIVITY_RECALL_STORE_BLOCKED_RECONCILIATION =
  `${ACTIVITY_RECALL_STORE_BLOCKED_PREFIX}reconciliation`;

export function isActivityRecallStoreBlocked(contentHash: string | null | undefined): boolean {
  return typeof contentHash === "string" && contentHash.startsWith(ACTIVITY_RECALL_STORE_BLOCKED_PREFIX);
}

export function activityWarningsRequireLiveRecallRead(warnings: readonly ActivitySourceWarning[]): boolean {
  return warnings.some((warning) => warning.code === "unparseable_line" || warning.code === "source_too_large");
}

export interface ActivityAttachmentReconstructionPayload {
  ref: string;
  source_shape: ActivityAttachmentSourceShape;
  exact_bytes_available: boolean;
  source_line: number;
  event_index: number;
  detail?: "resized" | "original";
  original_locator?: string;
}

export interface ActivityMessageReconstructionPayload {
  schema_version: typeof ACTIVITY_MESSAGE_PAYLOAD_SCHEMA_VERSION;
  classification: {
    rule_id: string;
    reason: string;
    source_role: InteractiveSessionEventRole;
    source_kind: string;
    raw_type?: string;
  };
  event_refs: number[];
  source_lines: number[];
  attachments?: ActivityAttachmentReconstructionPayload[];
}

function isInteractiveEventRole(value: unknown): value is InteractiveSessionEventRole {
  return value === "user"
    || value === "assistant"
    || value === "tool"
    || value === "system"
    || value === "unknown";
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function isActivityAttachmentSourceShape(value: unknown): value is ActivityAttachmentSourceShape {
  return value === "claude.source.base64"
    || value === "claude.file.base64"
    || value === "codex.input_image.data_url"
    || value === "codex.local_path"
    || value === "codex.remote_url"
    || value === "file_id"
    || value === "pasted_clipboard"
    || value === "unknown";
}

function parseActivityAttachmentPayloads(
  value: unknown,
): ActivityAttachmentReconstructionPayload[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const attachments: ActivityAttachmentReconstructionPayload[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return undefined;
    }
    const ref = item["ref"];
    const sourceShape = item["source_shape"];
    const exactBytesAvailable = item["exact_bytes_available"];
    const sourceLine = item["source_line"];
    const eventIndex = item["event_index"];
    const detail = item["detail"];
    const originalLocator = item["original_locator"];
    if (
      typeof ref !== "string"
      || !isActivityAttachmentSourceShape(sourceShape)
      || typeof exactBytesAvailable !== "boolean"
      || typeof sourceLine !== "number"
      || !Number.isFinite(sourceLine)
      || typeof eventIndex !== "number"
      || !Number.isFinite(eventIndex)
      || (detail !== undefined && detail !== "resized" && detail !== "original")
      || (originalLocator !== undefined && typeof originalLocator !== "string")
    ) {
      return undefined;
    }
    attachments.push({
      ref,
      source_shape: sourceShape,
      exact_bytes_available: exactBytesAvailable,
      source_line: sourceLine,
      event_index: eventIndex,
      ...(detail ? { detail } : {}),
      ...(originalLocator ? { original_locator: originalLocator } : {}),
    });
  }
  return attachments;
}

export function encodeActivityMessagePayload(message: ActivityMessage): string {
  const attachments = (message.attachments ?? []).map((attachment) => ({
    ref: attachment.ref,
    source_shape: attachment.source_shape,
    exact_bytes_available: attachment.exact_bytes_available,
    source_line: attachment.source_line,
    event_index: attachment.event_index,
    ...(attachment.detail ? { detail: attachment.detail } : {}),
    ...(attachment.original_locator ? { original_locator: attachment.original_locator } : {}),
  }));
  const payload: ActivityMessageReconstructionPayload = {
    schema_version: ACTIVITY_MESSAGE_PAYLOAD_SCHEMA_VERSION,
    classification: {
      rule_id: message.classification.rule_id,
      reason: message.classification.reason,
      source_role: message.classification.source_role,
      source_kind: message.classification.source_kind,
      ...(message.classification.raw_type ? { raw_type: message.classification.raw_type } : {}),
    },
    event_refs: message.event_refs,
    source_lines: message.source_lines,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
  return JSON.stringify(payload);
}

export function parseActivityMessagePayload(
  value: string,
): ActivityMessageReconstructionPayload | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || parsed["schema_version"] !== ACTIVITY_MESSAGE_PAYLOAD_SCHEMA_VERSION) {
      return undefined;
    }
    const classification = parsed["classification"];
    if (!isRecord(classification)) {
      return undefined;
    }
    const ruleId = classification["rule_id"];
    const reason = classification["reason"];
    const sourceRole = classification["source_role"];
    const sourceKind = classification["source_kind"];
    const rawType = classification["raw_type"];
    if (
      typeof ruleId !== "string"
      || typeof reason !== "string"
      || !isInteractiveEventRole(sourceRole)
      || typeof sourceKind !== "string"
      || (rawType !== undefined && typeof rawType !== "string")
      || !isNumberArray(parsed["event_refs"])
      || !isNumberArray(parsed["source_lines"])
    ) {
      return undefined;
    }
    const attachments = parseActivityAttachmentPayloads(parsed["attachments"]);
    if (!attachments) {
      return undefined;
    }
    return {
      schema_version: ACTIVITY_MESSAGE_PAYLOAD_SCHEMA_VERSION,
      classification: {
        rule_id: ruleId,
        reason,
        source_role: sourceRole,
        source_kind: sourceKind,
        ...(rawType ? { raw_type: rawType } : {}),
      },
      event_refs: parsed["event_refs"],
      source_lines: parsed["source_lines"],
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  } catch {
    return undefined;
  }
}

export interface ActivityMessageActivityRef {
  activity_id: string;
  backend: InteractiveSessionBackend;
  session_id: string;
  session_path: string;
  source: InteractiveSessionListEntry["source"];
  cwd?: string;
  host?: string;
}

export interface ActivityMessage {
  id: string;
  activity_id: string;
  activity: ActivityMessageActivityRef;
  turn_id?: string;
  role: ActivityMessageRole;
  visibility: ActivityMessageVisibility;
  text?: string;
  text_cursor?: ActivityTextCursor;
  summary: string;
  timestamp?: string;
  truncated?: boolean;
  attachments?: ActivityAttachmentRecord[];
  event_refs: number[];
  source_lines: number[];
  classification: ActivityMessageClassification;
}

export interface ActivityMessagesSelector {
  role?: ActivityMessageRole;
  visibility: ActivityVisibilityTier;
  first?: number;
  last?: number;
  around_id?: string;
  around_text?: string;
  context?: number;
  grep?: string;
  summary_only?: boolean;
  max_text_chars?: number;
  explain_classification?: boolean;
  /** Internal immutable seek boundary used by the HTTP consumer projection. */
  after_source_line?: number;
}

export interface ActivityMessagesResult {
  schema_version: "activity.messages/v1";
  classifier_version: string;
  activity_id: string;
  run_id?: string;
  activity_resolution?: RunActivityResolution;
  backend: InteractiveSessionBackend;
  session_id: string;
  session_path: string;
  source: InteractiveSessionListEntry["source"];
  cwd?: string;
  host?: string;
  source_state: ActivitySourceState;
  warnings: ActivitySourceWarning[];
  source_receipt: ActivitySourceReadReceipt;
  total_events: number;
  total_messages: number;
  matched_messages: number;
  returned_messages: number;
  truncated: boolean;
  attachments: ActivityAttachmentRollup;
  selector: ActivityMessagesSelector;
  messages: ActivityMessage[];
  /** Recall-index freshness for this source (POL-1838); omitted if not computed. */
  recall_freshness?: ActivityRecallFreshness;
}

export interface ActivityEventsSelector {
  raw_role?: InteractiveSessionEventRole;
  tail?: number;
  around_id?: string;
  context?: number;
  classify?: boolean;
  within_turn?: boolean;
}

export interface ActivityEventEntry {
  index: number;
  line: number;
  timestamp?: string;
  role: InteractiveSessionEventRole;
  kind: string;
  raw_type?: string;
  summary: string;
  text?: string;
  redacted?: boolean;
  truncated?: boolean;
  classification?: ActivityMessageClassification & {
    projected_role: ActivityMessageRole;
    visibility: ActivityMessageVisibility;
    message_id: string;
  };
}

export interface ActivityEventsResult {
  schema_version: "activity.events/v1";
  classifier_version: string;
  activity_id: string;
  run_id?: string;
  activity_resolution?: RunActivityResolution;
  backend: InteractiveSessionBackend;
  session_id: string;
  session_path: string;
  source: InteractiveSessionListEntry["source"];
  cwd?: string;
  host?: string;
  source_state: ActivitySourceState;
  warnings: ActivitySourceWarning[];
  source_receipt: ActivitySourceReadReceipt;
  total_events: number;
  matched_events: number;
  returned_events: number;
  truncated: boolean;
  selector: ActivityEventsSelector;
  events: ActivityEventEntry[];
}

export interface ActivityTurnsSelector {
  role?: ActivityTurnRoleFilter;
  first?: number;
  last?: number;
  with_tools?: boolean;
  summary_only?: boolean;
  max_text_chars?: number;
  /** Internal immutable seek boundary used by the HTTP consumer projection. */
  after_turn_index?: number;
}

export interface ActivityTurn {
  turn_id: string;
  index: number;
  activity_id: string;
  role: ActivityTurnRole;
  state: ActivityTurnState;
  started_at?: string;
  ended_at?: string;
  source_lines: [number, number];
  event_refs: [number, number];
  total_message_count: number;
  visible_message_count: number;
  tool_call_count: number;
  tool_result_count: number;
  attachments: ActivityAttachmentRollup;
  summary: string;
  first_message_id?: string;
  last_message_id?: string;
  messages: ActivityMessage[];
}

export interface ActivityTurnsResult {
  schema_version: "activity.turns/v1";
  classifier_version: string;
  activity_id: string;
  run_id?: string;
  activity_resolution?: RunActivityResolution;
  backend: InteractiveSessionBackend;
  session_id: string;
  session_path: string;
  source: InteractiveSessionListEntry["source"];
  cwd?: string;
  host?: string;
  source_state: ActivitySourceState;
  warnings: ActivitySourceWarning[];
  source_receipt: ActivitySourceReadReceipt;
  total_events: number;
  total_messages: number;
  total_turns: number;
  matched_turns: number;
  returned_turns: number;
  truncated: boolean;
  selector: ActivityTurnsSelector;
  turns: ActivityTurn[];
  /** Recall-index freshness for this source (POL-1838); omitted if not computed. */
  recall_freshness?: ActivityRecallFreshness;
}

export interface ActivityTextSelectorInput {
  classifier_version?: string;
  range?: string;
  from?: number;
}

export interface ActivityTextResult {
  schema_version: "activity.text/v1";
  classifier_version: string;
  activity_id: string;
  backend: InteractiveSessionBackend;
  session_id: string;
  session_path: string;
  message_id: string;
  source_line: number;
  text: string;
  text_cursor: ActivityTextCursor;
  source_receipt: ActivitySourceReadReceipt;
}

export interface ActivityAttachmentsSelectorInput {
  turn?: number;
  message_id?: string;
  extract?: boolean;
  ref?: string;
  out_dir?: string;
}

export interface ActivityAttachmentsResult {
  schema_version: "activity.attachments/v1";
  classifier_version: string;
  activity_id: string;
  backend: InteractiveSessionBackend;
  session_id: string;
  session_path: string;
  source_receipt: ActivitySourceReadReceipt;
  attachments: ActivityAttachmentRecord[];
  rollup: ActivityAttachmentRollup;
}

interface InteractiveSessionEventWithRaw extends InteractiveSessionEvent {
  raw_payload?: Record<string, unknown>;
  text_total_chars?: number;
  pending_attachments?: PendingAttachment[];
  attachments?: ActivityAttachmentRecord[];
}

interface ParsedSessionEvents {
  events: InteractiveSessionEventWithRaw[];
  warnings: ActivitySourceWarning[];
}

interface ParsedSessionRead extends ParsedSessionEvents {
  sourceReceipt: ActivitySourceReadReceipt;
  /**
   * Absolute byte offset of the start of each event's source line within the
   * transcript file, aligned 1:1 with `events`. Lets the tailer record a
   * per-row `source_offset` without a second parser. Only populated by the
   * streaming reader (always, but consumers other than the tailer ignore it).
   */
  eventByteOffsets: number[];
  /**
   * Resume position after the last newline-terminated (committed) line.
   * `byteOffset` is the absolute offset just past that newline; `nextLine` is
   * the 1-based line number to read next; `sawFinalNewline` is false when the
   * file ends mid-line (a live, still-growing tail). The tailer advances its
   * cursor to this position and re-reads any uncommitted tail next tick.
   */
  resume: { byteOffset: number; nextLine: number; sawFinalNewline: boolean };
}

export interface RunActivityResolution {
  handle: string;
  run_id: string;
  run_state: RunRecord["state"];
  completed_at?: string;
  activity_id: string;
  backend: InteractiveSessionBackend;
  session_id: string;
  resolution_source: string;
}

export interface ResolvedInteractiveActivity extends InteractiveSessionListEntry {
  runActivityResolution?: RunActivityResolution;
}

export interface RunActivityRecordResolver {
  getRunRecord?: (runId: string) => Promise<RunRecord | undefined>;
  getKernelReceipt?: (runId: string) => Promise<ExecutionReceipt | undefined>;
  /**
   * Every run id the store holds, so `run:<short-id>` handles resolve the same
   * way `calyx run status` / `calyx run receipt` resolve them (POL-1825).
   */
  listRunIds?: () => Promise<string[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function attachmentRefForDigest(digest: string): string {
  return `${ATTACHMENT_REF_PREFIX}${digest}`;
}

function defaultAttachmentErrorStatus(code: ActivityAttachmentErrorCode): number {
  switch (code) {
    case "activity_owner_unresolved":
      return 404;
    case "activity_owner_unreachable":
      return 503;
    case "attachment_ref_unknown":
      return 404;
    case "attachment_bytes_unavailable":
      return 409;
    case "attachment_digest_mismatch":
      return 422;
    case "attachment_archive_unavailable":
      return 503;
  }
}

export function attachmentDigestFromRef(ref: string): string | undefined {
  return ref.match(/^att:sha256:([0-9a-f]{64})$/u)?.[1];
}

function requireAttachmentDigest(ref: string, activityId: string): string {
  const digest = attachmentDigestFromRef(ref);
  if (digest) {
    return digest;
  }
  throw new ActivityAttachmentError(
    "attachment_ref_unknown",
    `Attachment ref ${ref} is not a supported att:sha256:<digest> ref.`,
    { details: { ref, activity_id: activityId } },
  );
}

function sha256Buffer(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestAttachmentBytes(base64: string): {
  ref: string;
  sha256: string;
  byteSize: number;
} | undefined {
  try {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0) {
      return undefined;
    }
    const sha256 = sha256Buffer(bytes);
    return {
      ref: attachmentRefForDigest(sha256),
      sha256,
      byteSize: bytes.length,
    };
  } catch {
    return undefined;
  }
}

function canonicalAttachmentMimeType(mimeType: string): string {
  return mimeType.trim().toLowerCase();
}

function makePendingAttachment(args: {
  base64: string;
  mimeType: string | undefined;
  sourceShape: ActivityAttachmentSourceShape;
  detail?: "resized" | "original";
  originalLocator?: string;
}): PendingAttachment | undefined {
  const digested = digestAttachmentBytes(args.base64);
  if (!digested) {
    return undefined;
  }
  return {
    ref: digested.ref,
    sha256: digested.sha256,
    mime_type: canonicalAttachmentMimeType(args.mimeType ?? "") || "application/octet-stream",
    byte_size: digested.byteSize,
    source_shape: args.sourceShape,
    exact_bytes_available: true,
    base64: args.base64,
    ...(args.detail ? { detail: args.detail } : {}),
    ...(args.originalLocator ? { original_locator: args.originalLocator } : {}),
  };
}

export function extensionForMimeType(mimeType: string): string {
  switch (canonicalAttachmentMimeType(mimeType)) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

function dedupePendingAttachments(attachments: PendingAttachment[]): PendingAttachment[] {
  const seen = new Set<string>();
  const deduped: PendingAttachment[] = [];
  for (const attachment of attachments) {
    if (seen.has(attachment.ref)) {
      continue;
    }
    seen.add(attachment.ref);
    deduped.push(attachment);
  }
  return deduped;
}

function addPendingAttachment(
  attachments: PendingAttachment[],
  next: PendingAttachment | undefined,
): string | undefined {
  if (!next) {
    return undefined;
  }
  if (!attachments.some((attachment) => attachment.ref === next.ref)) {
    attachments.push(next);
  }
  return next.ref;
}

function sanitizeJsonLineAttachments(line: string): SanitizedJsonLine {
  const attachments: PendingAttachment[] = [];
  let text = line.replace(
    /data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)(?=["\\])/g,
    (match, mimeType: string, base64: string) => {
      const ref = addPendingAttachment(attachments, makePendingAttachment({
        base64,
        mimeType,
        sourceShape: "codex.input_image.data_url",
      }));
      return ref ? `data:${mimeType};base64,${ref}` : match;
    },
  );

  text = text.replace(
    /"source"\s*:\s*\{\s*"type"\s*:\s*"base64"\s*,\s*"media_type"\s*:\s*"([^"]+)"\s*,\s*"data"\s*:\s*"([A-Za-z0-9+/=]+)"\s*\}/g,
    (match, mimeType: string, base64: string) => {
      const ref = addPendingAttachment(attachments, makePendingAttachment({
        base64,
        mimeType,
        sourceShape: "claude.source.base64",
      }));
      return ref
        ? `"source":{"type":"base64","media_type":"${mimeType}","data":"${ref}"}`
        : match;
    },
  );

  text = text.replace(
    /"file"\s*:\s*\{([^{}]*?)"base64"\s*:\s*"([A-Za-z0-9+/=]+)"([^{}]*?)\}/g,
    (match, before: string, base64: string, after: string) => {
      const container = `${before}${after}`;
      const mimeMatch = container.match(/"(?:media_type|mime_type)"\s*:\s*"([^"]+)"/);
      const detailMatch = container.match(/"detail"\s*:\s*"(resized|original)"/);
      const ref = addPendingAttachment(attachments, makePendingAttachment({
        base64,
        mimeType: mimeMatch?.[1] ?? "image/png",
        sourceShape: "claude.file.base64",
        ...(detailMatch?.[1] === "resized" || detailMatch?.[1] === "original"
          ? { detail: detailMatch[1] }
          : {}),
      }));
      return ref ? `"file":{${before}"base64":"${ref}"${after}}` : match;
    },
  );

  return { text, attachments: dedupePendingAttachments(attachments) };
}

function pendingAttachmentMarker(attachment: PendingAttachment): string {
  const size = attachment.byte_size >= 1024 * 1024
    ? `${(attachment.byte_size / (1024 * 1024)).toFixed(1)}MB`
    : `${Math.max(1, Math.round(attachment.byte_size / 1024))}KB`;
  const typeLabel = attachment.mime_type.startsWith("image/") ? "image" : "attachment";
  return `[${typeLabel} ${attachment.mime_type} ${size} ref:${attachment.ref}]`;
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

function attachmentFromRef(ref: string | undefined, attachments: readonly PendingAttachment[] | undefined): PendingAttachment | undefined {
  if (!ref || !attachments) {
    return undefined;
  }
  return attachments.find((attachment) => attachment.ref === ref);
}

function attachmentRefFromUnknown(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const direct = value.match(/att:sha256:[0-9a-f]{64}/i)?.[0];
  if (direct) {
    return direct;
  }
  return undefined;
}

function attachmentMarkerForRef(ref: string, attachments: readonly PendingAttachment[] | undefined): string {
  const attachment = attachmentFromRef(ref, attachments);
  if (attachment) {
    return pendingAttachmentMarker(attachment);
  }
  return `[image ref:${ref}]`;
}

function attachmentMarkerFromBlock(
  block: Record<string, unknown>,
  attachments: readonly PendingAttachment[] | undefined,
): string | undefined {
  const blockType = block["type"];
  if (blockType === "input_image") {
    const imageUrl = block["image_url"];
    if (typeof imageUrl === "string") {
      const ref = attachmentRefFromUnknown(imageUrl);
      if (ref) return attachmentMarkerForRef(ref, attachments);
      return `[image source:${imageUrl}]`;
    }
    if (isRecord(imageUrl)) {
      const ref = attachmentRefFromUnknown(imageUrl["url"]);
      if (ref) return attachmentMarkerForRef(ref, attachments);
      if (typeof imageUrl["url"] === "string") return `[image source:${imageUrl["url"]}]`;
    }
  }
  if (blockType === "image") {
    if (isRecord(block["source"])) {
      const source = block["source"];
      const ref = attachmentRefFromUnknown(source["data"]);
      if (ref) return attachmentMarkerForRef(ref, attachments);
    }
    if (isRecord(block["file"])) {
      const file = block["file"];
      const ref = attachmentRefFromUnknown(file["base64"]);
      if (ref) return attachmentMarkerForRef(ref, attachments);
    }
  }
  return undefined;
}

function extractMessageText(value: unknown, attachments?: readonly PendingAttachment[]): string | undefined {
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
        continue;
      }
      if (isRecord(block)) {
        const marker = attachmentMarkerFromBlock(block, attachments);
        if (marker) {
          parts.push(marker);
        }
      }
    }
    return parts.join("\n");
  }
  return undefined;
}

function recordText(value: unknown, attachments?: readonly PendingAttachment[]): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = extractMessageText(value, attachments);
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

function messageContentBlocks(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) {
    return [];
  }
  const content = value["content"];
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(isRecord);
}

function eventContentBlocks(event: InteractiveSessionEventWithRaw): Record<string, unknown>[] {
  const rawPayload = event.raw_payload;
  if (!rawPayload) {
    return [];
  }
  const blocks: Record<string, unknown>[] = [];
  if (isRecord(rawPayload["message"])) {
    blocks.push(...messageContentBlocks(rawPayload["message"]));
  }
  if (isRecord(rawPayload["payload"])) {
    blocks.push(...messageContentBlocks(rawPayload["payload"]));
  }
  return blocks;
}

function eventContentBlockTypes(event: InteractiveSessionEventWithRaw): string[] {
  return eventContentBlocks(event)
    .map((block) => block["type"])
    .filter((type): type is string => typeof type === "string" && type.trim().length > 0);
}

function allEventContentBlocksMatch(
  event: InteractiveSessionEventWithRaw,
  predicate: (block: Record<string, unknown>) => boolean,
): boolean {
  const blocks = eventContentBlocks(event);
  return blocks.length > 0 && blocks.every(predicate);
}

function isImageSourceMetadataBlock(block: Record<string, unknown>): boolean {
  const blockType = block["type"];
  if (blockType === "image" || blockType === "source") {
    return true;
  }
  if (blockType !== "text" || typeof block["text"] !== "string") {
    return false;
  }
  return /^\[Image:\s+source:\s+.+\]$/i.test(block["text"].trim());
}

function isMetaPayload(event: InteractiveSessionEventWithRaw): boolean {
  return event.raw_payload?.["isMeta"] === true;
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

function truncateTextValue(value: string, maxChars: number): {
  text: string;
  truncated: boolean;
} {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, maxChars), truncated: true };
}

function slimContentBlock(block: Record<string, unknown>): Record<string, unknown> {
  const slim: Record<string, unknown> = {};
  if (typeof block["type"] === "string") {
    slim["type"] = block["type"];
  }
  if (typeof block["text"] === "string" && block["text"].length <= 512) {
    slim["text"] = block["text"];
  }
  return slim;
}

function slimMessageLikePayload(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const slim: Record<string, unknown> = {};
  if (Array.isArray(value["content"])) {
    slim["content"] = value["content"].filter(isRecord).map(slimContentBlock);
  }
  return Object.keys(slim).length > 0 ? slim : undefined;
}

function slimRawPayload(value: Record<string, unknown>): Record<string, unknown> {
  const slim: Record<string, unknown> = {};
  if (value["isMeta"] === true) {
    slim["isMeta"] = true;
  }
  const message = slimMessageLikePayload(value["message"]);
  if (message) {
    slim["message"] = message;
  }
  const payload = slimMessageLikePayload(value["payload"]);
  if (payload) {
    slim["payload"] = payload;
  }
  return slim;
}

function makeSessionEvent(args: {
  index: number;
  line: number;
  timestamp?: string | undefined;
  role: InteractiveSessionEventRole;
  kind: string;
  text?: string | undefined;
  fallback: string;
  rawType?: string | undefined;
  redacted?: boolean | undefined;
  rawPayload: Record<string, unknown>;
  attachments?: PendingAttachment[];
  preserveFullText?: boolean | undefined;
}): InteractiveSessionEventWithRaw {
  const truncated = args.text ? truncateTextValue(args.text, DEFAULT_ACTIVITY_MESSAGE_TEXT_CHARS) : undefined;
  const text = args.preserveFullText ? args.text : truncated?.text;
  const pendingAttachments = args.attachments && args.attachments.length > 0
    ? dedupePendingAttachments(args.attachments)
    : [];
  return {
    index: args.index,
    line: args.line,
    ...(args.timestamp ? { timestamp: args.timestamp } : {}),
    role: args.role,
    kind: args.kind,
    summary: args.redacted ? "[redacted reasoning]" : summarizeText(args.text, args.fallback),
    ...(args.redacted ? { redacted: true } : {}),
    ...(!args.redacted && text ? { text } : {}),
    ...(!args.redacted && typeof args.text === "string" ? { text_total_chars: args.text.length } : {}),
    ...(!args.redacted && !args.preserveFullText && truncated?.truncated ? { truncated: true } : {}),
    ...(pendingAttachments.length > 0 ? { pending_attachments: pendingAttachments } : {}),
    ...(args.rawType ? { raw_type: args.rawType } : {}),
    raw_payload: slimRawPayload(args.rawPayload),
  };
}

function parseCodexRecord(
  record: Record<string, unknown>,
  args: {
    index: number;
    line: number;
    attachments: PendingAttachment[];
    preserveFullText?: boolean | undefined;
  },
): InteractiveSessionEventWithRaw {
  const rawType = typeof record["type"] === "string" ? record["type"] : undefined;
  const timestamp = parseTimestamp(record["timestamp"]);

  if (rawType === "session_meta") {
    return makeSessionEvent({
      index: args.index,
      line: args.line,
      timestamp,
      role: "system",
      kind: "session_meta",
      text: recordText(record["payload"], args.attachments),
      fallback: "session metadata",
      rawType,
      rawPayload: record,
      attachments: args.attachments,
      preserveFullText: args.preserveFullText,
    });
  }

  if (rawType === "response_item" && isRecord(record["payload"])) {
    const payload = record["payload"];
    const payloadType = typeof payload["type"] === "string" ? payload["type"] : "response_item";
    const payloadTimestamp = parseTimestamp(payload["timestamp"]) ?? timestamp;
    const kind = payloadKind(payload, payloadType);
    const isTool = payloadType.includes("function_call") || payloadType.includes("tool");
    const isReasoning = payloadType.includes("reasoning");
    return makeSessionEvent({
      index: args.index,
      line: args.line,
      timestamp: payloadTimestamp,
      role: isTool ? "tool" : roleFromUnknown(payload["role"]),
      kind,
      text: isReasoning ? undefined : recordText(payload, args.attachments),
      fallback: kind,
      rawType,
      rawPayload: record,
      attachments: args.attachments,
      preserveFullText: args.preserveFullText,
      ...(isReasoning ? { redacted: true } : {}),
    });
  }

  if (rawType === "turn_context") {
    return makeSessionEvent({
      index: args.index,
      line: args.line,
      timestamp,
      role: "system",
      kind: "turn_context",
      text: recordText(record["payload"], args.attachments),
      fallback: "turn context",
      rawType,
      rawPayload: record,
      attachments: args.attachments,
      preserveFullText: args.preserveFullText,
    });
  }

  if (rawType === "event_msg") {
    return makeSessionEvent({
      index: args.index,
      line: args.line,
      timestamp,
      role: "system",
      kind: "event_msg",
      text: recordText(record["payload"], args.attachments) ?? recordText(record, args.attachments),
      fallback: "event message",
      rawType,
      rawPayload: record,
      attachments: args.attachments,
      preserveFullText: args.preserveFullText,
    });
  }

  return makeSessionEvent({
    index: args.index,
    line: args.line,
    timestamp,
    role: roleFromUnknown(record["role"]),
    kind: rawType ?? "record",
    text: recordText(record["message"], args.attachments)
      ?? recordText(record["payload"], args.attachments)
      ?? recordText(record, args.attachments),
    fallback: rawType ?? "session record",
    rawType,
    rawPayload: record,
    attachments: args.attachments,
    preserveFullText: args.preserveFullText,
  });
}

function parseClaudeRecord(
  record: Record<string, unknown>,
  args: {
    index: number;
    line: number;
    attachments: PendingAttachment[];
    preserveFullText?: boolean | undefined;
  },
): InteractiveSessionEventWithRaw {
  const rawType = typeof record["type"] === "string" ? record["type"] : undefined;
  const message = isRecord(record["message"]) ? record["message"] : undefined;
  const messageRole = message ? roleFromUnknown(message["role"]) : "unknown";
  const role = rawType === "tool_result" || rawType === "tool_use"
    ? "tool"
    : messageRole !== "unknown"
      ? messageRole
      : roleFromUnknown(rawType);
  return makeSessionEvent({
    index: args.index,
    line: args.line,
    timestamp: parseTimestamp(record["timestamp"]),
    role,
    kind: rawType ?? "record",
    text: recordText(message, args.attachments) ?? recordText(record, args.attachments),
    fallback: rawType ?? "session record",
    rawType,
    rawPayload: record,
    attachments: args.attachments,
    preserveFullText: args.preserveFullText,
  });
}

function parseCalyxRunRecord(
  record: Record<string, unknown>,
  args: {
    index: number;
    line: number;
    attachments: PendingAttachment[];
    preserveFullText?: boolean | undefined;
  },
): InteractiveSessionEventWithRaw {
  const rawType = typeof record["event_type"] === "string"
    ? record["event_type"]
    : typeof record["event"] === "string"
      ? record["event"]
      : typeof record["type"] === "string"
        ? record["type"]
        : undefined;
  return makeSessionEvent({
    index: args.index,
    line: args.line,
    timestamp: parseTimestamp(record["timestamp"]) ?? parseTimestamp(record["recorded_at"]),
    role: "system",
    kind: rawType ?? "calyx_run_event",
    text: recordText(record["message"], args.attachments)
      ?? recordText(record["backend_event"], args.attachments)
      ?? recordText(record["payload"], args.attachments)
      ?? recordText(record, args.attachments),
    fallback: rawType ?? "calyx run event",
    rawType,
    rawPayload: record,
    attachments: args.attachments,
    preserveFullText: args.preserveFullText,
  });
}

function parseSessionRecord(
  backend: InteractiveSessionBackend,
  record: Record<string, unknown>,
  args: {
    index: number;
    line: number;
    attachments: PendingAttachment[];
    preserveFullText?: boolean | undefined;
    source?: InteractiveSessionListEntry["source"] | undefined;
  },
): InteractiveSessionEventWithRaw {
  if (args.source === "calyx_runs") {
    return parseCalyxRunRecord(record, args);
  }
  return backend === "codex"
    ? parseCodexRecord(record, args)
    : parseClaudeRecord(record, args);
}

async function readSessionEventsStreaming(
  filePath: string,
  backend: InteractiveSessionBackend,
  options: {
    maxRecordBytes?: number;
    startOffset?: number;
    startLine?: number;
    startEventIndex?: number;
    preserveFullText?: boolean | undefined;
    source?: InteractiveSessionListEntry["source"] | undefined;
  } = {},
): Promise<ParsedSessionRead> {
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  const startOffset = Math.max(0, options.startOffset ?? 0);
  const startEventIndex = Math.max(0, Math.trunc(options.startEventIndex ?? 0));
  const warnings: ActivitySourceWarning[] = [];
  const events: InteractiveSessionEventWithRaw[] = [];
  const eventByteOffsets: number[] = [];
  const guardHits = new Set<string>();
  const receipt: ActivitySourceReadReceipt = {
    mode: "streaming",
    bytes_scanned: 0,
    records_scanned: 0,
    records_decoded: 0,
    oversized_records_skipped: 0,
    max_record_bytes: maxRecordBytes,
    guard_hits: [],
  };
  try {
    const info = await stat(filePath);
    receipt.source_bytes = info.size;
  } catch {
    // best effort; the open stream will surface a read failure if the file is gone.
  }

  const stream = createReadStream(filePath, { start: startOffset, highWaterMark: STREAM_CHUNK_BYTES });
  let lineChunks: Buffer[] = [];
  let lineBytes = 0;
  let lineNumber = Math.max(1, options.startLine ?? 1);
  let oversized = false;
  let lastByteWasNewline = false;
  // Absolute byte position of the start of the line currently being accumulated.
  let lineStartAbs = startOffset;
  // Resume bookmark: the last newline-terminated boundary we fully consumed.
  let committedOffset = startOffset;
  let committedNextLine = lineNumber;

  const resetLine = () => {
    lineChunks = [];
    lineBytes = 0;
    oversized = false;
  };

  const finishLine = (isFinalLine: boolean) => {
    if (lineBytes === 0 && !oversized) {
      lineNumber += 1;
      return;
    }
    receipt.records_scanned += 1;
    if (oversized) {
      receipt.oversized_records_skipped += 1;
      guardHits.add("source-too-large");
      warnings.push({
        code: "source_too_large",
        message: `Skipping JSONL record at line ${lineNumber}; record exceeded ${maxRecordBytes} bytes.`,
        source_line: lineNumber,
      });
      resetLine();
      lineNumber += 1;
      return;
    }

    let rawLine: string;
    try {
      rawLine = new TextDecoder("utf-8", { fatal: true })
        .decode(Buffer.concat(lineChunks, lineBytes))
        .replace(/\r$/, "");
    } catch {
      guardHits.add("source-invalid-utf8");
      warnings.push({
        code: "unparseable_line",
        message: `Skipping JSONL record at line ${lineNumber}; record is not valid UTF-8.`,
        source_line: lineNumber,
      });
      resetLine();
      lineNumber += 1;
      return;
    }
    const trimmed = rawLine.trim();
    resetLine();
    if (!trimmed) {
      lineNumber += 1;
      return;
    }
    const sanitized = sanitizeJsonLineAttachments(trimmed);
    for (const attachment of sanitized.attachments) {
      delete attachment.base64;
    }
    try {
      const parsed = JSON.parse(sanitized.text) as unknown;
      if (!isRecord(parsed)) {
        warnings.push({
          code: "unparseable_line",
          message: `Skipping non-object JSONL record at line ${lineNumber}.`,
          source_line: lineNumber,
        });
        lineNumber += 1;
        return;
      }
      const eventIndex = startEventIndex + events.length;
      events.push(parseSessionRecord(backend, parsed, {
        index: eventIndex,
        line: lineNumber,
        attachments: sanitized.attachments,
        preserveFullText: options.preserveFullText,
        source: options.source,
      }));
      eventByteOffsets[eventIndex] = lineStartAbs;
      receipt.records_decoded += 1;
    } catch (error) {
      warnings.push({
        code: isFinalLine ? "partial_final_line" : "unparseable_line",
        message: isFinalLine
          ? `Skipping partial final JSONL line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}.`
          : `Skipping unparseable JSONL line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}.`,
        source_line: lineNumber,
      });
    }
    lineNumber += 1;
  };

  let absChunkStart = startOffset;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receipt.bytes_scanned += buffer.length;
    let start = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      if (buffer[i] !== 10) {
        continue;
      }
      const segment = buffer.subarray(start, i);
      if (!oversized) {
        const nextBytes = lineBytes + segment.length;
        if (nextBytes > maxRecordBytes) {
          oversized = true;
          lineChunks = [];
          lineBytes = nextBytes;
        } else {
          lineChunks.push(segment);
          lineBytes = nextBytes;
        }
      } else {
        lineBytes += segment.length;
      }
      finishLine(false);
      // Commit the boundary just past this newline; the next line starts here.
      const boundary = absChunkStart + i + 1;
      committedOffset = boundary;
      committedNextLine = lineNumber;
      lineStartAbs = boundary;
      start = i + 1;
      lastByteWasNewline = true;
    }
    if (start < buffer.length) {
      const segment = buffer.subarray(start);
      if (!oversized) {
        const nextBytes = lineBytes + segment.length;
        if (nextBytes > maxRecordBytes) {
          oversized = true;
          lineChunks = [];
          lineBytes = nextBytes;
        } else {
          lineChunks.push(segment);
          lineBytes = nextBytes;
        }
      } else {
        lineBytes += segment.length;
      }
      lastByteWasNewline = false;
    }
    absChunkStart += buffer.length;
  }

  if (lineBytes > 0 || oversized || !lastByteWasNewline) {
    finishLine(!lastByteWasNewline);
  }

  receipt.guard_hits = [...guardHits];
  return {
    events,
    warnings,
    sourceReceipt: receipt,
    eventByteOffsets,
    resume: { byteOffset: committedOffset, nextLine: committedNextLine, sawFinalNewline: lastByteWasNewline },
  };
}

async function readSanitizedJsonLineAt(
  filePath: string,
  sourceLine: number,
  options: { maxRecordBytes?: number } = {},
): Promise<{ sanitized?: SanitizedJsonLine; sourceReceipt: ActivitySourceReadReceipt; warning?: ActivitySourceWarning }> {
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  const guardHits = new Set<string>();
  const receipt: ActivitySourceReadReceipt = {
    mode: "streaming",
    bytes_scanned: 0,
    records_scanned: 0,
    records_decoded: 0,
    oversized_records_skipped: 0,
    max_record_bytes: maxRecordBytes,
    guard_hits: [],
  };
  try {
    const info = await stat(filePath);
    receipt.source_bytes = info.size;
  } catch {
    // best effort
  }

  const stream = createReadStream(filePath, { highWaterMark: STREAM_CHUNK_BYTES });
  let lineChunks: Buffer[] = [];
  let lineBytes = 0;
  let lineNumber = 1;
  let oversized = false;

  const resetLine = () => {
    lineChunks = [];
    lineBytes = 0;
    oversized = false;
  };

  const finishLine = (): { done: boolean; sanitized?: SanitizedJsonLine; warning?: ActivitySourceWarning } => {
    const currentLine = lineNumber;
    lineNumber += 1;
    if (currentLine !== sourceLine) {
      resetLine();
      return { done: false };
    }
    receipt.records_scanned += 1;
    if (oversized) {
      receipt.oversized_records_skipped += 1;
      guardHits.add("source-too-large");
      resetLine();
      return {
        done: true,
        warning: {
          code: "source_too_large",
          message: `Skipping JSONL record at line ${currentLine}; record exceeded ${maxRecordBytes} bytes.`,
          source_line: currentLine,
        },
      };
    }
    let rawLine: string;
    try {
      rawLine = new TextDecoder("utf-8", { fatal: true })
        .decode(Buffer.concat(lineChunks, lineBytes))
        .replace(/\r$/, "");
    } catch {
      guardHits.add("source-invalid-utf8");
      resetLine();
      return {
        done: true,
        warning: {
          code: "unparseable_line",
          message: `Skipping JSONL record at line ${currentLine}; record is not valid UTF-8.`,
          source_line: currentLine,
        },
      };
    }
    resetLine();
    if (!rawLine.trim()) {
      return { done: true };
    }
    receipt.records_decoded += 1;
    return { done: true, sanitized: sanitizeJsonLineAttachments(rawLine.trim()) };
  };

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receipt.bytes_scanned += buffer.length;
    let start = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      if (buffer[i] !== 10) {
        continue;
      }
      const segment = buffer.subarray(start, i);
      if (!oversized) {
        const nextBytes = lineBytes + segment.length;
        if (nextBytes > maxRecordBytes) {
          oversized = true;
          lineChunks = [];
          lineBytes = nextBytes;
        } else {
          lineChunks.push(segment);
          lineBytes = nextBytes;
        }
      } else {
        lineBytes += segment.length;
      }
      const result = finishLine();
      if (result.done) {
        stream.destroy();
        receipt.guard_hits = [...guardHits];
        return { sourceReceipt: receipt, ...(result.sanitized ? { sanitized: result.sanitized } : {}), ...(result.warning ? { warning: result.warning } : {}) };
      }
      start = i + 1;
    }
    if (start < buffer.length) {
      const segment = buffer.subarray(start);
      if (!oversized) {
        const nextBytes = lineBytes + segment.length;
        if (nextBytes > maxRecordBytes) {
          oversized = true;
          lineChunks = [];
          lineBytes = nextBytes;
        } else {
          lineChunks.push(segment);
          lineBytes = nextBytes;
        }
      } else {
        lineBytes += segment.length;
      }
    }
  }

  if (lineBytes > 0 || oversized) {
    const result = finishLine();
    if (result.done) {
      receipt.guard_hits = [...guardHits];
      return { sourceReceipt: receipt, ...(result.sanitized ? { sanitized: result.sanitized } : {}), ...(result.warning ? { warning: result.warning } : {}) };
    }
  }
  receipt.guard_hits = [...guardHits];
  return { sourceReceipt: receipt };
}

function fullTextFromRecord(
  backend: InteractiveSessionBackend,
  record: Record<string, unknown>,
  attachments: readonly PendingAttachment[],
): string | undefined {
  if (backend === "codex") {
    const rawType = typeof record["type"] === "string" ? record["type"] : undefined;
    if (rawType === "response_item" && isRecord(record["payload"])) {
      const payload = record["payload"];
      const payloadType = typeof payload["type"] === "string" ? payload["type"] : "response_item";
      return payloadType.includes("reasoning") ? undefined : recordText(payload, attachments);
    }
    return recordText(record["message"], attachments)
      ?? recordText(record["payload"], attachments)
      ?? recordText(record, attachments);
  }
  const message = isRecord(record["message"]) ? record["message"] : undefined;
  return recordText(message, attachments) ?? recordText(record, attachments);
}

async function readFullMessageTextAtLine(
  session: ResolvedInteractiveActivity,
  sourceLine: number,
): Promise<{ text?: string; sourceReceipt: ActivitySourceReadReceipt; warning?: ActivitySourceWarning }> {
  const line = await readSanitizedJsonLineAt(session.session_path, sourceLine);
  if (!line.sanitized) {
    return line.warning
      ? { sourceReceipt: line.sourceReceipt, warning: line.warning }
      : { sourceReceipt: line.sourceReceipt };
  }
  try {
    const parsed = JSON.parse(line.sanitized.text) as unknown;
    if (!isRecord(parsed)) {
      return {
        sourceReceipt: line.sourceReceipt,
        warning: {
          code: "unparseable_line",
          message: `Skipping non-object JSONL record at line ${sourceLine}.`,
          source_line: sourceLine,
        },
      };
    }
    const text = fullTextFromRecord(session.backend, parsed, line.sanitized.attachments);
    return {
      sourceReceipt: line.sourceReceipt,
      ...(typeof text === "string" ? { text } : {}),
    };
  } catch (error) {
    return {
      sourceReceipt: line.sourceReceipt,
      warning: {
        code: "unparseable_line",
        message: `Skipping unparseable JSONL line ${sourceLine}: ${error instanceof Error ? error.message : String(error)}.`,
        source_line: sourceLine,
      },
    };
  }
}

async function hydrateReturnedMessageText(
  session: ResolvedInteractiveActivity,
  messages: ActivityMessage[],
): Promise<ActivityMessage[]> {
  const hydrated: ActivityMessage[] = [];
  for (const message of messages) {
    if (typeof message.text !== "string" || message.source_lines.length === 0) {
      hydrated.push(message);
      continue;
    }
    const sourceLine = message.source_lines[0]!;
    const loaded = await readFullMessageTextAtLine(session, sourceLine);
    if (typeof loaded.text === "string") {
      const { truncated, text_cursor, ...rest } = message;
      void truncated;
      void text_cursor;
      hydrated.push({ ...rest, text: loaded.text });
    } else {
      hydrated.push(message);
    }
  }
  return hydrated;
}

async function hydrateReturnedTurnText(
  session: ResolvedInteractiveActivity,
  turns: ActivityTurn[],
): Promise<ActivityTurn[]> {
  const hydrated: ActivityTurn[] = [];
  for (const turn of turns) {
    hydrated.push({
      ...turn,
      messages: await hydrateReturnedMessageText(session, turn.messages),
    });
  }
  return hydrated;
}

interface ClassificationOutcome {
  role: ActivityMessageRole;
  visibility: ActivityMessageVisibility;
  rule_id: string;
  reason: string;
}

const HARNESS_TEXT_PREFIXES: Array<{ prefix: string; rule: string; reason: string }> = [
  { prefix: "# AGENTS.md instructions", rule: "harness/agents-md-prefix", reason: "Codex AGENTS.md harness payload, not a human prompt." },
  { prefix: "<environment_context>", rule: "harness/environment-context", reason: "Codex environment-context harness payload." },
  { prefix: "<collaboration_mode>", rule: "harness/collaboration-mode", reason: "Codex collaboration-mode harness payload." },
  { prefix: "<apps_instructions>", rule: "harness/apps-instructions", reason: "Codex apps-instructions harness payload." },
  { prefix: "<skills_instructions>", rule: "harness/skills-instructions", reason: "Codex skills-instructions harness payload." },
  { prefix: "<plugins_instructions>", rule: "harness/plugins-instructions", reason: "Codex plugins-instructions harness payload." },
  { prefix: "<skill", rule: "harness/skill-payload", reason: "Skill payload injected by the harness, not a human prompt." },
  { prefix: "<plugin", rule: "harness/plugin-payload", reason: "Plugin payload injected by the harness, not a human prompt." },
  { prefix: "<heartbeat", rule: "automation/heartbeat", reason: "Automation heartbeat payload, not a human prompt." },
  { prefix: "<task-notification", rule: "harness/task-notification", reason: "Task notification payload, not a human prompt." },
  { prefix: "<command-name>", rule: "harness/command-name", reason: "Claude command-name shell harness payload." },
  { prefix: "<local-command-stdout>", rule: "harness/local-command-stdout", reason: "Claude local-command-stdout harness payload." },
  { prefix: "<local-command-stderr>", rule: "harness/local-command-stderr", reason: "Claude local-command-stderr harness payload." },
];

const HARNESS_TEXT_CONTAINS: Array<{ marker: string; rule: string; reason: string }> = [
  { marker: "<INSTRUCTIONS>", rule: "harness/instructions-block", reason: "Codex/Claude harness <INSTRUCTIONS> block, not a human prompt." },
  { marker: "<local-command-caveat>", rule: "harness/local-command-caveat", reason: "Claude local-command caveat marker, harness-injected text." },
];

function classifySessionEvent(event: InteractiveSessionEventWithRaw): ClassificationOutcome {
  const sourceRole = event.role;
  const sourceKind = event.kind;
  const text = normalizeText(event.text);
  const rawType = event.raw_type;
  const contentBlockTypes = eventContentBlockTypes(event);
  const allContentBlocksAreToolResults = contentBlockTypes.length > 0
    && contentBlockTypes.every((type) => type === "tool_result");
  const allContentBlocksAreToolUses = contentBlockTypes.length > 0
    && contentBlockTypes.every((type) => type === "tool_use");
  const imageSourceOnlyMetadata = allEventContentBlocksMatch(event, isImageSourceMetadataBlock);

  if (event.redacted || (rawType && rawType.toLowerCase().includes("reasoning")) || sourceKind.toLowerCase().includes("reasoning")) {
    return {
      role: "reasoning_summary",
      visibility: "hidden",
      rule_id: "reasoning/redacted-or-marker",
      reason: "Reasoning summary or redacted reasoning event.",
    };
  }

  // Order matters: check tool_result first so `function_call_output` (Codex)
  // and `tool_result` (Claude) are not mis-classified as tool_call by the
  // sourceRole === "tool" branch below. This fix is part of the slice 1B
  // turn-grouping work where tool_call vs tool_result must be separable.
  if (
    allContentBlocksAreToolResults
    || sourceKind === "tool_result"
    || rawType === "tool_result"
    || sourceKind.startsWith("local_command")
    || sourceKind === "function_call_output"
    || rawType === "function_call_output"
    || sourceKind.startsWith("function_call_output")
  ) {
    return {
      role: "tool_result",
      visibility: "detail",
      rule_id: "tool/result-or-stdout",
      reason: "Tool result, local command output, or MCP tool output.",
    };
  }

  if (
    allContentBlocksAreToolUses
    || sourceRole === "tool"
    || sourceKind.includes("function_call")
    || sourceKind === "tool_use"
    || rawType === "tool_use"
  ) {
    return {
      role: "tool_call",
      visibility: "detail",
      rule_id: "tool/call-or-function",
      reason: "Tool/function call invocation event.",
    };
  }

  if (sourceRole === "user") {
    if (text) {
      for (const rule of HARNESS_TEXT_PREFIXES) {
        if (text.startsWith(rule.prefix)) {
          return {
            role: "harness_context",
            visibility: "hidden",
            rule_id: rule.rule,
            reason: rule.reason,
          };
        }
      }
      for (const rule of HARNESS_TEXT_CONTAINS) {
        if (text.includes(rule.marker)) {
          return {
            role: "harness_context",
            visibility: "hidden",
            rule_id: rule.rule,
            reason: rule.reason,
          };
        }
      }
    }
    if (isMetaPayload(event)) {
      return {
        role: "harness_context",
        visibility: "hidden",
        rule_id: "harness/provider-meta",
        reason: "Provider metadata or task-notification payload, not a human-authored prompt.",
      };
    }
    if (imageSourceOnlyMetadata) {
      return {
        role: "harness_context",
        visibility: "hidden",
        rule_id: "harness/attachment-metadata",
        reason: "Attachment/image source metadata without human prompt text.",
      };
    }
    if (!text) {
      return {
        role: "unknown",
        visibility: "detail",
        rule_id: "unknown/raw-user-empty",
        reason: "Raw user-role event without a positive human-authored text signal.",
      };
    }
    return {
      role: "human",
      visibility: "default",
      rule_id: "human/user-message",
      reason: "Raw user-role message that is not classified as harness, tool, or system.",
    };
  }

  if (sourceRole === "assistant") {
    return {
      role: "assistant",
      visibility: "default",
      rule_id: "assistant/message",
      reason: "Raw assistant-role message.",
    };
  }

  if (sourceRole === "system") {
    return {
      role: "system_notice",
      visibility: "hidden",
      rule_id: "system/low-signal",
      reason: "Low-signal system event (session metadata, turn context, event message).",
    };
  }

  return {
    role: "unknown",
    visibility: "detail",
    rule_id: "unknown/fallback",
    reason: `Unclassified event (raw role=${sourceRole}, kind=${sourceKind}).`,
  };
}

function makeMessageId(activityId: string, sourceLine: number): string {
  return `${activityId}:msg:${sourceLine}`;
}

function buildActivityRef(session: InteractiveSessionListEntry): ActivityMessageActivityRef {
  return {
    activity_id: session.run_id,
    backend: session.backend,
    session_id: session.session_id,
    session_path: session.session_path,
    source: session.source,
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.host ? { host: session.host } : {}),
  };
}

function attachmentRecordFromPending(
  pending: PendingAttachment,
  args: {
    activityId: string;
    messageId: string;
    sourceLine: number;
    eventIndex: number;
  },
): ActivityAttachmentRecord {
  return {
    ref: pending.ref,
    sha256: pending.sha256,
    mime_type: pending.mime_type,
    byte_size: pending.byte_size,
    source_shape: pending.source_shape,
    exact_bytes_available: pending.exact_bytes_available,
    activity_id: args.activityId,
    message_id: args.messageId,
    source_line: args.sourceLine,
    event_index: args.eventIndex,
    ...(pending.detail ? { detail: pending.detail } : {}),
    ...(pending.original_locator ? { original_locator: pending.original_locator } : {}),
  };
}

function rollupAttachments(attachments: readonly ActivityAttachmentRecord[]): ActivityAttachmentRollup {
  const byRef = new Map<string, ActivityAttachmentRecord>();
  for (const attachment of attachments) {
    if (!byRef.has(attachment.ref)) {
      byRef.set(attachment.ref, attachment);
    }
  }
  const records = [...byRef.values()];
  return {
    images: records.filter((attachment) => attachment.mime_type.startsWith("image/")).length,
    bytes: records.reduce((total, attachment) => total + attachment.byte_size, 0),
    refs: records.map((attachment) => attachment.ref),
  };
}

function attachmentsForMessages(messages: readonly ActivityMessage[]): ActivityAttachmentRecord[] {
  return messages.flatMap((message) => message.attachments ?? []);
}

function projectEvent(
  event: InteractiveSessionEventWithRaw,
  activity: ActivityMessageActivityRef,
  turnId?: string,
  options: { preserveFullText?: boolean } = {},
): { message: ActivityMessage; outcome: ClassificationOutcome } {
  const outcome = classifySessionEvent(event);
  const id = makeMessageId(activity.activity_id, event.line);
  void options;
  const attachments = (event.pending_attachments ?? []).map((attachment) =>
    attachmentRecordFromPending(attachment, {
      activityId: activity.activity_id,
      messageId: id,
      sourceLine: event.line,
      eventIndex: event.index,
    }),
  );
  const message: ActivityMessage = {
    id,
    activity_id: activity.activity_id,
    activity,
    ...(turnId ? { turn_id: turnId } : {}),
    role: outcome.role,
    visibility: outcome.visibility,
    summary: event.summary,
    ...(event.text ? { text: event.text } : {}),
    ...(event.text_total_chars !== undefined && event.text_total_chars > (event.text?.length ?? 0)
      ? {
        text_cursor: {
          total_chars: event.text_total_chars,
          returned: [[0, event.text?.length ?? 0]],
          next: event.text?.length ?? 0,
        },
      }
      : {}),
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    ...(event.truncated ? { truncated: event.truncated } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    event_refs: [event.index],
    source_lines: [event.line],
    classification: {
      classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
      rule_id: outcome.rule_id,
      reason: outcome.reason,
      source_role: event.role,
      source_kind: event.kind,
      ...(event.raw_type ? { raw_type: event.raw_type } : {}),
    },
  };
  return { message, outcome };
}

export function projectInteractiveSessionToMessages(
  events: InteractiveSessionEventWithRaw[],
  activity: ActivityMessageActivityRef,
): ActivityMessage[] {
  const assignment = assignTurnsToEvents(events, activity);
  return events.map((event, index) =>
    projectEvent(event, activity, assignment.eventTurnIds[index]).message,
  );
}

function projectInteractiveSessionToMessagesForSelection(
  events: InteractiveSessionEventWithRaw[],
  activity: ActivityMessageActivityRef,
): ActivityMessage[] {
  const assignment = assignTurnsToEvents(events, activity);
  return events.map((event, index) =>
    projectEvent(event, activity, assignment.eventTurnIds[index], { preserveFullText: true }).message,
  );
}

export interface NormalizeActivitySliceOptions {
  /** Session whose transcript file is being tailed (from listInteractiveSessions). */
  session: InteractiveSessionListEntry;
  /** Absolute byte offset to resume from (a committed newline boundary). */
  startOffset?: number;
  /** 1-based line number corresponding to `startOffset`. */
  startLine?: number;
  /** Absolute event index corresponding to the first decoded event in the slice. */
  startEventIndex?: number;
  maxRecordBytes?: number;
}

export interface NormalizedActivitySliceMessage {
  /** Full-text projection with attachments already stripped to `att:sha256:` refs. */
  message: ActivityMessage;
  /** Absolute byte offset of the message's source line within the transcript. */
  sourceByteOffset: number;
  /** Primary (first) source line of the message; the stable per-activity `seq`. */
  sourceLine: number;
}

export interface NormalizeActivitySliceResult {
  activity: ActivityMessageActivityRef;
  /** Only committed (newline-terminated) messages; the uncommitted tail is dropped. */
  messages: NormalizedActivitySliceMessage[];
  warnings: ActivitySourceWarning[];
  sourceReceipt: ActivitySourceReadReceipt;
  /** Resume bookmark to persist as the source cursor. */
  resume: { byteOffset: number; nextLine: number; sawFinalNewline: boolean };
}

/**
 * Tailer ingest seam (POL-1838). Reads a bounded slice of a transcript from a
 * resume offset and returns the normalized message projection for the committed
 * lines, plus the resume bookmark. This reuses the one canonical streaming
 * reader and the one canonical semantic-origin projection that the live read
 * path uses — there is deliberately no second parser. Messages from the
 * uncommitted (still-growing) tail are excluded so the persisted store only
 * ever holds fully-written records; the tailer re-reads that tail next tick.
 */
export async function normalizeActivitySlice(
  options: NormalizeActivitySliceOptions,
): Promise<NormalizeActivitySliceResult> {
  const session = options.session;
  const activity = buildActivityRef(session);
  const parsed = await readSessionEventsStreaming(session.session_path, session.backend, {
    ...(options.startOffset !== undefined ? { startOffset: options.startOffset } : {}),
    ...(options.startLine !== undefined ? { startLine: options.startLine } : {}),
    ...(options.startEventIndex !== undefined ? { startEventIndex: options.startEventIndex } : {}),
    ...(options.maxRecordBytes !== undefined ? { maxRecordBytes: options.maxRecordBytes } : {}),
    preserveFullText: true,
    source: session.source,
  });
  const projected = projectInteractiveSessionToMessagesForSelection(parsed.events, activity);
  const committedExclusive = parsed.resume.nextLine;
  const messages: NormalizedActivitySliceMessage[] = [];
  for (const message of projected) {
    const sourceLine = message.source_lines[0];
    if (sourceLine === undefined || sourceLine >= committedExclusive) {
      // Drop the uncommitted tail; it is re-read once newline-terminated.
      continue;
    }
    const eventIndex = message.event_refs[0];
    const sourceByteOffset =
      eventIndex !== undefined ? parsed.eventByteOffsets[eventIndex] ?? 0 : 0;
    messages.push({ message, sourceByteOffset, sourceLine });
  }
  return {
    activity,
    messages,
    warnings: parsed.warnings,
    sourceReceipt: parsed.sourceReceipt,
    resume: parsed.resume,
  };
}

/**
 * Turn grouping (slice 1B).
 *
 * Operates on the raw event sequence, not the visibility-filtered messages, so
 * that the same boundaries hold whether or not harness/tool/reasoning detail
 * is requested. The boundary rules are intentionally simple:
 *
 * - A `human` projected event opens a new human turn (closing any prior turn).
 * - An `assistant` projected event opens a new assistant turn unless the
 *   current turn is already an assistant turn — in which case the assistant
 *   message continues that turn.
 * - `tool_call` / `tool_result` events attach to the current assistant turn.
 *   If the current turn is a human turn (or there is no turn yet), they open
 *   a new assistant turn — tools cannot legitimately appear inside a human
 *   turn.
 * - `harness_context`, `system_notice`, `reasoning_summary`, and `unknown`
 *   events attach to whatever turn is currently open. If no turn is open
 *   (pre-prompt session metadata / harness payloads), they go into a synthetic
 *   `unknown` preamble turn.
 *
 * The classifier_version covers both projection and turn grouping; bump it
 * when either changes. Turn IDs are stable across reads of the same file
 * because they encode the source line of the boundary-opening event.
 */
interface TurnAssignmentEntry {
  turn_id: string;
  index: number;
  role: ActivityTurnRole;
  startEventIndex: number;
  endEventIndex: number;
  startLine: number;
  endLine: number;
  startedAt?: string;
  endedAt?: string;
  eventIndexes: number[];
}

interface TurnAssignment {
  turns: TurnAssignmentEntry[];
  eventTurnIds: Array<string | undefined>;
}

function makeTurnId(activityId: string, sourceLine: number): string {
  return `${activityId}:turn:${sourceLine}`;
}

function assignTurnsToEvents(
  events: InteractiveSessionEventWithRaw[],
  activity: ActivityMessageActivityRef,
): TurnAssignment {
  const turns: TurnAssignmentEntry[] = [];
  const eventTurnIds: Array<string | undefined> = new Array(events.length);
  let current: TurnAssignmentEntry | null = null;

  const openTurn = (role: ActivityTurnRole, eventIndex: number) => {
    const event = events[eventIndex]!;
    const turn: TurnAssignmentEntry = {
      turn_id: makeTurnId(activity.activity_id, event.line),
      index: turns.length,
      role,
      startEventIndex: eventIndex,
      endEventIndex: eventIndex,
      startLine: event.line,
      endLine: event.line,
      ...(event.timestamp ? { startedAt: event.timestamp } : {}),
      ...(event.timestamp ? { endedAt: event.timestamp } : {}),
      eventIndexes: [],
    };
    turns.push(turn);
    return turn;
  };

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    const projected = classifySessionEvent(event).role;
    let newRole: ActivityTurnRole | null = null;
    if (projected === "human") {
      newRole = "human";
    } else if (projected === "assistant") {
      if (!current || current.role !== "assistant") {
        newRole = "assistant";
      }
    } else if (projected === "tool_call" || projected === "tool_result") {
      if (!current || current.role !== "assistant") {
        newRole = "assistant";
      }
    } else {
      if (!current) {
        newRole = "unknown";
      }
    }
    if (newRole) {
      current = openTurn(newRole, i);
    }
    if (current) {
      current.eventIndexes.push(i);
      current.endEventIndex = i;
      current.endLine = event.line;
      if (event.timestamp) {
        current.endedAt = event.timestamp;
      }
      eventTurnIds[i] = current.turn_id;
    }
  }

  return { turns, eventTurnIds };
}

function visibilityAllowed(
  visibility: ActivityMessageVisibility,
  tier: ActivityVisibilityTier,
): boolean {
  switch (tier) {
    case "default":
      return visibility === "default";
    case "+detail":
      return visibility === "default" || visibility === "detail";
    case "+hidden":
      return visibility === "default" || visibility === "detail" || visibility === "hidden";
    case "all":
      return true;
  }
}

function messageSearchHaystack(message: ActivityMessage, maxTextChars: number): string {
  const text = message.text ?? "";
  const boundedText = text.length > maxTextChars ? text.slice(0, maxTextChars) : text;
  return `${message.role}\n${message.summary}\n${boundedText}`;
}

function applyMessageGrep(message: ActivityMessage, grep: string, maxTextChars: number): boolean {
  const haystack = messageSearchHaystack(message, maxTextChars);
  try {
    const pattern = new RegExp(grep, "i");
    return pattern.test(haystack);
  } catch {
    return haystack.toLowerCase().includes(grep.toLowerCase());
  }
}

interface ActivityTextSearchScan {
  grep_lines: Set<number>;
  around_text_line?: number;
  hit_ranges: Map<number, [number, number]>;
}

function textMatchRange(text: string, query: string, regex: boolean): [number, number] | undefined {
  if (regex) {
    try {
      const match = new RegExp(query, "i").exec(text);
      if (match?.index !== undefined) {
        return [match.index, match.index + match[0].length];
      }
      return undefined;
    } catch {
      // Fall through to literal matching for invalid regex patterns.
    }
  }
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  return index >= 0 ? [index, index + query.length] : undefined;
}

async function scanFullTextMatches(
  session: ResolvedInteractiveActivity,
  messages: ActivityMessage[],
  selector: ActivityMessagesSelector,
): Promise<ActivityTextSearchScan | undefined> {
  if (!selector.grep && !selector.around_text) {
    return undefined;
  }
  const candidates = new Map<number, ActivityMessage>();
  for (const message of messages) {
    if (!visibilityAllowed(message.visibility, selector.visibility)) {
      continue;
    }
    if (selector.role && message.role !== selector.role) {
      continue;
    }
    const sourceLine = message.source_lines[0];
    if (typeof sourceLine === "number") {
      candidates.set(sourceLine, message);
    }
  }
  if (candidates.size === 0) {
    return { grep_lines: new Set(), hit_ranges: new Map() };
  }

  const result: ActivityTextSearchScan = {
    grep_lines: new Set<number>(),
    hit_ranges: new Map<number, [number, number]>(),
  };
  const stream = createReadStream(session.session_path, { highWaterMark: STREAM_CHUNK_BYTES });
  let lineChunks: Buffer[] = [];
  let lineBytes = 0;
  let lineNumber = 1;
  let oversized = false;

  const resetLine = () => {
    lineChunks = [];
    lineBytes = 0;
    oversized = false;
  };

  const finishLine = () => {
    const currentLine = lineNumber;
    lineNumber += 1;
    const message = candidates.get(currentLine);
    if (!message || oversized) {
      resetLine();
      return;
    }
    const rawLine = Buffer.concat(lineChunks, lineBytes).toString("utf8").replace(/\r$/, "");
    resetLine();
    if (!rawLine.trim()) {
      return;
    }
    const sanitized = sanitizeJsonLineAttachments(rawLine.trim());
    try {
      const parsed = JSON.parse(sanitized.text) as unknown;
      if (!isRecord(parsed)) {
        return;
      }
      const fullText = fullTextFromRecord(session.backend, parsed, sanitized.attachments) ?? "";
      const fullHaystack = `${message.role}\n${message.summary}\n${fullText}`;
      if (selector.grep) {
        const grepRange = textMatchRange(fullHaystack, selector.grep, true);
        if (grepRange) {
          result.grep_lines.add(currentLine);
          const textRange = textMatchRange(fullText, selector.grep, true);
          if (textRange) {
            result.hit_ranges.set(currentLine, textRange);
          }
        }
      }
      if (selector.around_text && result.around_text_line === undefined) {
        const aroundRange = textMatchRange(fullHaystack, selector.around_text, false);
        if (aroundRange) {
          result.around_text_line = currentLine;
          const textRange = textMatchRange(fullText, selector.around_text, false);
          if (textRange) {
            result.hit_ranges.set(currentLine, textRange);
          }
        }
      }
    } catch {
      // Search skips malformed records; the projection pass records warnings.
    }
  };

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      if (buffer[i] !== 10) {
        continue;
      }
      const segment = buffer.subarray(start, i);
      const capture = candidates.has(lineNumber);
      if (capture && !oversized) {
        const nextBytes = lineBytes + segment.length;
        if (nextBytes > DEFAULT_MAX_RECORD_BYTES) {
          oversized = true;
          lineChunks = [];
          lineBytes = nextBytes;
        } else {
          lineChunks.push(segment);
          lineBytes = nextBytes;
        }
      } else {
        lineBytes += segment.length;
      }
      finishLine();
      start = i + 1;
    }
    if (start < buffer.length) {
      const segment = buffer.subarray(start);
      const capture = candidates.has(lineNumber);
      if (capture && !oversized) {
        const nextBytes = lineBytes + segment.length;
        if (nextBytes > DEFAULT_MAX_RECORD_BYTES) {
          oversized = true;
          lineChunks = [];
          lineBytes = nextBytes;
        } else {
          lineChunks.push(segment);
          lineBytes = nextBytes;
        }
      } else {
        lineBytes += segment.length;
      }
    }
  }
  if (lineBytes > 0 || oversized) {
    finishLine();
  }
  return result;
}

function textRangeCommand(messageId: string, start: number, end: number): string {
  return `calyx activity text ${messageId} --range ${start}:${end} --classifier-version ${ACTIVITY_MESSAGE_CLASSIFIER_VERSION}`;
}

function elisionMarker(messageId: string, start: number, end: number): string {
  return `[... ${end - start} chars omitted (chars ${start}-${end}) - ${textRangeCommand(messageId, start, end)}]`;
}

function applyTextProjection(
  message: ActivityMessage,
  maxChars: number,
  options: { hitRange?: [number, number] } = {},
): ActivityMessage {
  if (typeof message.text !== "string" || message.text.length <= maxChars) {
    return message;
  }
  const total = message.text.length;
  if (maxChars <= 0) {
    return {
      ...message,
      text: elisionMarker(message.id, 0, total),
      truncated: true,
      text_cursor: {
        total_chars: total,
        returned: [],
        next: 0,
      },
    };
  }

  if (options.hitRange) {
    const [hitStart, hitEnd] = options.hitRange;
    const hitMid = Math.floor((hitStart + hitEnd) / 2);
    let start = Math.max(0, hitMid - Math.floor(maxChars / 2));
    let end = Math.min(total, start + maxChars);
    start = Math.max(0, end - maxChars);
    end = Math.min(total, start + maxChars);
    const parts: string[] = [];
    if (start > 0) {
      parts.push(elisionMarker(message.id, 0, start));
    }
    if (end > start) {
      parts.push(message.text.slice(start, end));
    }
    if (end < total) {
      parts.push(elisionMarker(message.id, end, total));
    }
    const cursor: ActivityTextCursor = {
      total_chars: total,
      returned: end > start ? [[start, end]] : [],
    };
    if (end < total) {
      cursor.next = end;
    } else if (start > 0) {
      cursor.next = 0;
    }
    return {
      ...message,
      text: parts.join("\n"),
      truncated: true,
      text_cursor: cursor,
    };
  }

  const headChars = Math.min(total, Math.ceil(maxChars * 0.6));
  const tailChars = Math.max(0, maxChars - headChars);
  const tailStart = Math.max(headChars, total - tailChars);
  const returned: Array<[number, number]> = [[0, headChars]];
  const parts = [message.text.slice(0, headChars)];
  if (tailStart > headChars) {
    parts.push(elisionMarker(message.id, headChars, tailStart));
  }
  if (tailStart < total) {
    parts.push(message.text.slice(tailStart));
    returned.push([tailStart, total]);
  }
  return {
    ...message,
    text: parts.join("\n"),
    truncated: true,
    text_cursor: {
      total_chars: total,
      returned,
      next: headChars,
    },
  };
}

function summaryOnlyMessage(message: ActivityMessage): ActivityMessage {
  if (message.text === undefined) {
    return message;
  }
  const next = { ...message };
  delete next.text;
  return next;
}

function sliceAroundIndex(
  filtered: ActivityMessage[],
  matchIndex: number,
  context: number,
): ActivityMessage[] {
  const start = Math.max(matchIndex - context, 0);
  const end = matchIndex + context + 1;
  return filtered.slice(start, end);
}

function findMessageById(filtered: ActivityMessage[], id: string): number {
  const exact = filtered.findIndex((message) => message.id === id);
  if (exact >= 0) {
    return exact;
  }
  const numeric = Number.parseInt(id, 10);
  if (Number.isFinite(numeric) && /^\d+$/.test(id)) {
    return filtered.findIndex((message) => message.source_lines.includes(numeric));
  }
  return -1;
}

function findMessageByText(filtered: ActivityMessage[], query: string, maxTextChars: number): number {
  const lowered = query.toLowerCase();
  return filtered.findIndex((message) => {
    const haystack = messageSearchHaystack(message, maxTextChars).toLowerCase();
    return haystack.includes(lowered);
  });
}

export interface ActivityMessageSelectorInput {
  role?: ActivityMessageRole;
  visibility?: ActivityVisibilityTier;
  first?: number;
  last?: number;
  around_id?: string;
  around_text?: string;
  context?: number;
  grep?: string;
  summary_only?: boolean;
  max_text_chars?: number;
  explain_classification?: boolean;
  after_source_line?: number;
}

export class ActivityMessageSelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivityMessageSelectorError";
  }
}

export class ActivityMessageNotFoundError extends Error {
  constructor(messageId: string) {
    super(`Activity message "${messageId}" was not found in the requested visibility projection.`);
    this.name = "ActivityMessageNotFoundError";
  }
}

function normalizeSelector(input: ActivityMessageSelectorInput): ActivityMessagesSelector {
  const visibility = input.visibility ?? "default";
  if (!ACTIVITY_VISIBILITY_TIERS.includes(visibility)) {
    throw new ActivityMessageSelectorError(
      `Invalid --visibility value "${visibility}". Use one of: ${ACTIVITY_VISIBILITY_TIERS.join(", ")}.`,
    );
  }
  if (input.role !== undefined && !ACTIVITY_MESSAGE_ROLES.includes(input.role)) {
    throw new ActivityMessageSelectorError(
      `Invalid --role value "${input.role}". Use one of: ${ACTIVITY_MESSAGE_ROLES.join(", ")}.`,
    );
  }
  if (typeof input.first === "number" && typeof input.last === "number") {
    throw new ActivityMessageSelectorError("--first and --last are mutually exclusive.");
  }
  if (typeof input.first === "number" && input.first < 0) {
    throw new ActivityMessageSelectorError("--first must be a non-negative integer.");
  }
  if (typeof input.last === "number" && input.last < 0) {
    throw new ActivityMessageSelectorError("--last must be a non-negative integer.");
  }
  if (input.around_id && input.around_text) {
    throw new ActivityMessageSelectorError("--around-id and --around-text are mutually exclusive.");
  }
  if (typeof input.context === "number" && input.context < 0) {
    throw new ActivityMessageSelectorError("--context must be a non-negative integer.");
  }
  if (typeof input.context === "number" && !input.around_id && !input.around_text) {
    throw new ActivityMessageSelectorError("--context requires --around-id or --around-text.");
  }
  if (typeof input.max_text_chars === "number" && input.max_text_chars < 0) {
    throw new ActivityMessageSelectorError("--max-text-chars must be a non-negative integer.");
  }
  if (typeof input.after_source_line === "number" && (!Number.isInteger(input.after_source_line) || input.after_source_line < 0)) {
    throw new ActivityMessageSelectorError("after_source_line must be a non-negative integer.");
  }
  return {
    ...(input.role ? { role: input.role } : {}),
    visibility,
    ...(typeof input.first === "number" ? { first: input.first } : {}),
    ...(typeof input.last === "number" ? { last: input.last } : {}),
    ...(input.around_id ? { around_id: input.around_id } : {}),
    ...(input.around_text ? { around_text: input.around_text } : {}),
    ...(typeof input.context === "number" ? { context: input.context } : {}),
    ...(input.grep ? { grep: input.grep } : {}),
    ...(input.summary_only ? { summary_only: input.summary_only } : {}),
    max_text_chars: input.max_text_chars ?? DEFAULT_ACTIVITY_MESSAGE_TEXT_CHARS,
    ...(input.explain_classification ? { explain_classification: input.explain_classification } : {}),
    ...(typeof input.after_source_line === "number" ? { after_source_line: input.after_source_line } : {}),
  };
}

function applyMessagesSelector(
  messages: ActivityMessage[],
  selector: ActivityMessagesSelector,
  search?: ActivityTextSearchScan,
): { matched: ActivityMessage[]; returned: ActivityMessage[] } {
  let filtered = messages.filter((message) => visibilityAllowed(message.visibility, selector.visibility));
  if (selector.role) {
    filtered = filtered.filter((message) => message.role === selector.role);
  }
  const maxTextChars = selector.max_text_chars ?? DEFAULT_ACTIVITY_MESSAGE_TEXT_CHARS;
  if (selector.grep) {
    filtered = search
      ? filtered.filter((message) => message.source_lines.some((line) => search.grep_lines.has(line)))
      : filtered.filter((message) => applyMessageGrep(message, selector.grep!, maxTextChars));
  }

  const matched = filtered;
  if (typeof selector.after_source_line === "number") {
    filtered = filtered.filter((message) => (message.source_lines[0] ?? -1) > selector.after_source_line!);
  }
  let returned: ActivityMessage[];

  if (selector.around_id || selector.around_text) {
    const matchIndex = selector.around_id
      ? findMessageById(filtered, selector.around_id)
      : search?.around_text_line !== undefined
        ? filtered.findIndex((message) => message.source_lines.includes(search.around_text_line!))
        : findMessageByText(filtered, selector.around_text!, maxTextChars);
    if (matchIndex >= 0) {
      const context = selector.context ?? DEFAULT_ACTIVITY_MESSAGES_CONTEXT;
      returned = sliceAroundIndex(filtered, matchIndex, context);
    } else {
      returned = [];
    }
  } else if (typeof selector.first === "number") {
    returned = filtered.slice(0, selector.first);
  } else if (typeof selector.last === "number") {
    returned = selector.last > 0 ? filtered.slice(-selector.last) : [];
  } else {
    returned = filtered.slice(-DEFAULT_ACTIVITY_MESSAGES_LAST);
  }

  return { matched, returned };
}

function applyMessageDecorations(
  messages: ActivityMessage[],
  selector: ActivityMessagesSelector,
  search?: ActivityTextSearchScan,
): ActivityMessage[] {
  return messages.map((message) => {
    let next = message;
    const sourceLine = next.source_lines[0];
    next = applyTextProjection(
      next,
      selector.max_text_chars ?? DEFAULT_ACTIVITY_MESSAGE_TEXT_CHARS,
      typeof sourceLine === "number" && search?.hit_ranges.has(sourceLine)
        ? { hitRange: search.hit_ranges.get(sourceLine)! }
        : {},
    );
    if (selector.summary_only) {
      next = summaryOnlyMessage(next);
    }
    if (!selector.explain_classification) {
      const stripped: ActivityMessage = {
        ...next,
        classification: {
          classifier_version: next.classification.classifier_version,
          rule_id: next.classification.rule_id,
          reason: next.classification.reason,
          source_role: next.classification.source_role,
          source_kind: next.classification.source_kind,
          ...(next.classification.raw_type ? { raw_type: next.classification.raw_type } : {}),
        },
      };
      return stripped;
    }
    return next;
  });
}

async function probeSourceState(
  filePath: string,
  warnings: ActivitySourceWarning[],
  events: InteractiveSessionEventWithRaw[],
  now: Date,
): Promise<ActivitySourceState> {
  if (warnings.some((warning) => warning.code === "partial_final_line" || warning.code === "unparseable_line")) {
    return "partial";
  }
  try {
    const info = await stat(filePath);
    const ageMs = now.getTime() - info.mtimeMs;
    if (ageMs >= 0 && ageMs <= SESSION_FRESHNESS_LIVE_MS) {
      warnings.push({
        code: "live_session",
        message: `Session file modified within the last ${Math.round(SESSION_FRESHNESS_LIVE_MS / 60_000)} minutes; results may not include the most recent events.`,
      });
      return "live";
    }
  } catch {
    // best-effort
  }
  if (events.length === 0) {
    warnings.push({
      code: "empty_session",
      message: "Session file has no parseable events.",
    });
  }
  return "complete";
}

export class ActivityRunMissingMetadataError extends Error {
  readonly runId: string;
  /** Host the run record names as its executor, when it is not the queried host. */
  readonly residentHost?: string;

  constructor(runId: string, detail?: string, residentHost?: string) {
    super(
      [
        `Run activity handle "run:${runId}" has no resolvable backend activity session${detail ? `: ${detail}` : "."}`,
        ...(residentHost
          ? [`The run record names host "${residentHost}" as its executor; retry with --host ${residentHost}.`]
          : []),
        "Inspect `calyx run logs --run-id <id> --full`, `calyx run receipt --run-id <id>`, or the run record for backend session metadata.",
      ].join("\n"),
    );
    this.name = "ActivityRunMissingMetadataError";
    this.runId = runId;
    if (residentHost) {
      this.residentHost = residentHost;
    }
  }
}

export class ActivityIdAmbiguousError extends Error {
  /** Rendered candidate labels, one per matching session or run. */
  readonly candidates: string[];
  constructor(handle: string, kind: "sessions" | "runs", candidates: string[]) {
    super(
      [
        `Short-prefix handle "${handle}" matches ${candidates.length} ${kind}:`,
        ...candidates.slice(0, 5).map((candidate) => `  - ${candidate}`),
        candidates.length > 5 ? `  ...and ${candidates.length - 5} more` : "",
        `Pass a longer prefix or the full ${kind === "runs" ? "run id" : "activity id"}.`,
      ].filter((line) => line.length > 0).join("\n"),
    );
    this.name = "ActivityIdAmbiguousError";
    this.candidates = candidates;
  }
}

/**
 * An activity id no accepted locator form can parse (POL-1825). Distinct from
 * {@link ActivityIdNotFoundError}: the id is a syntax error, so no host holds
 * the activity and retrying elsewhere cannot help.
 */
export class ActivityIdMalformedError extends Error {
  readonly activityId: string;
  readonly reason: MalformedActivityLocator["reason"];
  readonly correctedActivityId?: string;
  readonly host?: string;

  constructor(activityId: string, malformed: MalformedActivityLocator) {
    super(formatMalformedActivityLocator(activityId, malformed));
    this.name = "ActivityIdMalformedError";
    this.activityId = activityId;
    this.reason = malformed.reason;
    if (malformed.correctedActivityId) {
      this.correctedActivityId = malformed.correctedActivityId;
    }
    if (malformed.host) {
      this.host = malformed.host;
    }
  }
}

export class ActivityIdNotFoundError extends Error {
  /** Host whose session stores were searched, when the caller resolved one. */
  readonly searchedHost?: string;

  constructor(activityId: string, options: { searchedHost?: string; hint?: string } = {}) {
    super(
      `Interactive activity "${activityId}" not found`
      + `${options.searchedHost ? ` on host "${options.searchedHost}"` : ""}.`
      + `${options.hint ? ` ${options.hint}` : ""}`,
    );
    this.name = "ActivityIdNotFoundError";
    if (options.searchedHost) {
      this.searchedHost = options.searchedHost;
    }
  }
}

/**
 * Host whose stores a read actually searches: the explicit `--host`, or this
 * machine when the caller passed nothing or the `local` alias.
 */
function resolveQueriedHost(host: string | undefined): string | undefined {
  const normalized = normalizeHost(host);
  return normalized === undefined || normalized === "local" ? normalizeHost(hostname()) : normalized;
}

export interface ResolveInteractiveActivityOptions extends InteractiveActivityOptions {
  activityId?: string | undefined;
  latestSession?: boolean | undefined;
  latestSessionBackend?: InteractiveSessionBackend | undefined;
  runActivityResolver?: RunActivityRecordResolver | undefined;
}

interface RunActivityCandidate {
  backend: InteractiveSessionBackend;
  sessionId: string;
  sessionPath?: string;
  resolutionSource: string;
}

function normalizeBackend(value: unknown): InteractiveSessionBackend | undefined {
  return value === "codex" || value === "claude" ? value : undefined;
}

function sessionSourceForBackend(backend: InteractiveSessionBackend): InteractiveSessionListEntry["source"] {
  return backend === "codex" ? "codex_sessions" : "claude_projects";
}

function readReceiptBackendSession(
  receipt: ExecutionReceipt | undefined,
): { backend: InteractiveSessionBackend; id: string; path?: string } | undefined {
  if (!receipt || !("backend_session" in receipt) || !receipt.backend_session) {
    return undefined;
  }
  const backend = normalizeBackend(receipt.backend_session.backend);
  const id = receipt.backend_session.id?.trim();
  if (!backend || !id) {
    return undefined;
  }
  return {
    backend,
    id,
    ...(receipt.backend_session.path?.trim() ? { path: receipt.backend_session.path.trim() } : {}),
  };
}

function candidateFromReceipt(
  receipt: ExecutionReceipt | undefined,
  resolutionSource: string,
): RunActivityCandidate | undefined {
  const session = readReceiptBackendSession(receipt);
  if (!session) {
    return undefined;
  }
  return {
    backend: session.backend,
    sessionId: normalizeBackendSessionId(session.id, session.backend),
    ...(session.path ? { sessionPath: session.path } : {}),
    resolutionSource,
  };
}

function candidateFromRecoveryCheckpoint(record: RunRecord): RunActivityCandidate | undefined {
  const sessionId = record.recovery.checkpoint?.backend_session_id?.trim();
  const backend = normalizeBackend(record.intent.backend)
    ?? normalizeBackend(record.spec && "backend" in record.spec ? record.spec.backend : undefined);
  if (!sessionId || !backend) {
    return undefined;
  }
  return {
    backend,
    sessionId: normalizeBackendSessionId(sessionId, backend),
    ...(record.recovery.checkpoint?.backend_session_path?.trim()
      ? { sessionPath: record.recovery.checkpoint.backend_session_path.trim() }
      : {}),
    resolutionSource: "run_record.recovery.checkpoint.backend_session_id",
  };
}

function candidateFromResumeSession(record: RunRecord): RunActivityCandidate | undefined {
  const sessionId = record.intent.resume_session_id?.trim();
  const backend = normalizeBackend(record.intent.backend)
    ?? normalizeBackend(record.spec && "backend" in record.spec ? record.spec.backend : undefined);
  // Spawn-backed Claude runs validate the exact transcript produced by this
  // execution before publishing durable session metadata. The resume target
  // names the prior transcript, so treating it as recovery evidence would make
  // a run that never reached Claude look successfully resolvable.
  if (!sessionId || !backend || backend === "claude") {
    return undefined;
  }
  return {
    backend,
    sessionId: normalizeBackendSessionId(sessionId, backend),
    resolutionSource: "run_record.intent.resume_session_id",
  };
}

function assertConsistentRunActivityMetadata(
  runId: string,
  candidates: RunActivityCandidate[],
): void {
  const identities = new Set(candidates.map((candidate) => (
    `${candidate.backend}:${candidate.sessionId}`
  )));
  if (identities.size > 1) {
    throw new ActivityRunMissingMetadataError(
      runId,
      `conflicting durable backend session identities (${[...identities].join(", ")})`,
    );
  }
}

function runActivityMetadataDetail(
  record: RunRecord,
  hasCandidates: boolean,
  hasReceipt: boolean,
): string {
  const backend = normalizeBackend(record.intent.backend)
    ?? normalizeBackend(record.spec && "backend" in record.spec ? record.spec.backend : undefined);
  const isActive = record.state === "queued"
    || record.state === "dispatching"
    || record.state === "running";
  if (hasCandidates) {
    return isActive
      ? `agent_runner run is still "${record.state}"; backend metadata is present, but the referenced transcript is not available yet`
      : `terminal agent_runner run in state "${record.state}" has durable backend session metadata, but the referenced transcript is unavailable`;
  }
  if (record.intent.kernel && record.intent.kernel !== "agent_runner") {
    return `run kernel "${record.intent.kernel}" does not expose backend activity metadata`;
  }
  if (!isActive) {
    return hasReceipt
      ? `terminal agent_runner run in state "${record.state}" has no backend session discovery result after terminal receipt materialization`
      : `terminal agent_runner run in state "${record.state}" has no backend session discovery result; no terminal receipt is available`;
  }
  return backend === "claude"
    ? `spawn-backed Claude run is still "${record.state}"; backend session discovery remains pending until terminal receipt materialization`
    : backend === "codex"
      ? `Codex app-server run is still "${record.state}", but its expected active recovery checkpoint is absent`
      : `agent_runner run is still "${record.state}" and has no backend session metadata`;
}

function withRunResolution(
  entry: InteractiveSessionListEntry,
  runId: string,
  record: RunRecord,
  candidate: RunActivityCandidate,
): ResolvedInteractiveActivity {
  const activityId = `interactive:${entry.backend}:${entry.session_id}`;
  return {
    ...entry,
    run_id: activityId,
    runActivityResolution: {
      handle: `run:${runId}`,
      run_id: runId,
      run_state: record.state,
      ...(record.completed_at ? { completed_at: record.completed_at } : {}),
      activity_id: activityId,
      backend: entry.backend,
      session_id: entry.session_id,
      resolution_source: candidate.resolutionSource,
    },
  };
}

async function buildEntryFromSessionPath(
  candidate: RunActivityCandidate,
  host: string | undefined,
  runId: string,
  beforeCandidateStat?: ((candidatePath: string) => Promise<void>) | undefined,
): Promise<InteractiveSessionListEntry | undefined> {
  if (!candidate.sessionPath) {
    return undefined;
  }
  try {
    await beforeCandidateStat?.(candidate.sessionPath);
    const info = await stat(candidate.sessionPath);
    const entry = await loadInteractiveSessionEntry({
      backend: candidate.backend,
      source: sessionSourceForBackend(candidate.backend),
      path: candidate.sessionPath,
      birthtimeMs: info.birthtimeMs,
      mtimeMs: info.mtimeMs,
      size: info.size,
    }, {
      ...(host ? { host } : {}),
      failClosed: true,
    });
    if (entry && !interactiveSessionMatchesLocator(entry, {
      backend: candidate.backend,
      sessionId: candidate.sessionId,
    })) {
      throw new ActivityRunMissingMetadataError(
        runId,
        "durable backend session id and path identify different transcripts",
      );
    }
    return entry;
  } catch (error) {
    if (error instanceof ActivityRunMissingMetadataError) throw error;
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function assertSingleExactActivityMatch(
  activityId: string,
  matches: InteractiveSessionListEntry[],
): InteractiveSessionListEntry | undefined {
  const byPath = new Map(matches.map((session) => [path.resolve(session.session_path), session]));
  if (byPath.size > 1) {
    throw new InteractiveActivityProjectionNotReadyError(
      `Multiple interactive activity sources resolve to exact activity "${activityId}".`,
      { reason: "identity_collision" },
    );
  }
  return byPath.values().next().value;
}

function isPathWithinRoot(candidatePath: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertProvedCodexArchiveRelocation(
  missingPath: string,
  selected: InteractiveSessionListEntry,
  candidate: RunActivityCandidate,
  options: ResolveInteractiveActivityOptions,
  runId: string,
): void {
  const codexRoots = resolveCodexSessionRoots(options);
  const activeRoot = codexRoots.sessionsRoot;
  const archiveRoot = codexRoots.archivedSessionsRoot;
  const oldFilenameId = codexSessionIdFromPath(missingPath);
  const newFilenameId = codexSessionIdFromPath(selected.session_path);
  const expectedId = normalizeBackendSessionId(candidate.sessionId, "codex");
  const proved = candidate.backend === "codex"
    && selected.backend === "codex"
    && isPathWithinRoot(missingPath, activeRoot)
    && isPathWithinRoot(selected.session_path, archiveRoot)
    && path.basename(missingPath) === path.basename(selected.session_path)
    && oldFilenameId !== undefined
    && normalizeBackendSessionId(oldFilenameId, "codex") === expectedId
    && newFilenameId !== undefined
    && normalizeBackendSessionId(newFilenameId, "codex") === expectedId
    && normalizeBackendSessionId(selected.session_id, "codex") === expectedId;
  if (!proved) {
    throw new ActivityRunMissingMetadataError(
      runId,
      "durable backend session path is absent and does not prove a Codex sessions-to-archived_sessions relocation",
    );
  }
}

async function resolveRunActivityCandidates(
  candidates: RunActivityCandidate[],
  options: ResolveInteractiveActivityOptions,
  runId: string,
  record: RunRecord,
  baseListOptions: InteractiveActivityOptions,
): Promise<ResolvedInteractiveActivity | undefined> {
  const primary = candidates[0];
  if (!primary) return undefined;
  const activityId = `interactive:${primary.backend}:${primary.sessionId}`;

  // This scan is complete or fails typed on its hard candidate budget. It is
  // always performed, even when a durable direct path exists, so a second
  // active/archive source cannot be bypassed by ID-only checkpoint metadata.
  const discovered = await resolveExactInteractiveSession({
    ...baseListOptions,
    activityId,
    ...(options.candidateLimit !== undefined ? { candidateLimit: options.candidateLimit } : {}),
  });

  const pathCandidates = new Map<string, RunActivityCandidate>();
  for (const candidate of candidates) {
    if (candidate.sessionPath) pathCandidates.set(path.resolve(candidate.sessionPath), candidate);
  }
  const extant: InteractiveSessionListEntry[] = [];
  const missing: Array<{ sourcePath: string; candidate: RunActivityCandidate }> = [];
  for (const [sourcePath, candidate] of pathCandidates) {
    const entry = await buildEntryFromSessionPath(
      { ...candidate, sessionPath: sourcePath },
      options.host,
      runId,
      options.beforeCandidateStat,
    );
    if (entry) extant.push(entry);
    else missing.push({ sourcePath, candidate });
  }

  const selected = assertSingleExactActivityMatch(
    `run:${runId}`,
    [...extant, ...(discovered ? [discovered] : [])],
  );
  if (!selected) return undefined;

  // Every absent durable path remains an obligation. The sole accepted drift
  // is Codex moving the same basename from its active root into its archive.
  for (const item of missing) {
    assertProvedCodexArchiveRelocation(item.sourcePath, selected, item.candidate, options, runId);
  }
  return withRunResolution(selected, runId, record, primary);
}

const FULL_RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a `run:<handle>` to its run record, accepting the unique short
 * prefixes `calyx run status` / `calyx run receipt` already accept (POL-1825).
 * A prefix that matches nothing says so explicitly instead of reporting the
 * record as absent.
 */
async function resolveRunRecordForHandle(
  runId: string,
  resolver: RunActivityRecordResolver,
): Promise<RunRecord> {
  if (!resolver.getRunRecord) {
    throw new ActivityRunMissingMetadataError(runId, "run record lookup is unavailable");
  }
  const exact = await resolver.getRunRecord(runId);
  if (exact) {
    return exact;
  }
  const known = (await resolver.listRunIds?.()) ?? [];
  const matches = known.filter((candidate) => candidate.startsWith(runId));
  if (matches.length > 1) {
    throw new ActivityIdAmbiguousError(`run:${runId}`, "runs", matches.map((id) => `run:${id}`));
  }
  const record = matches[0] ? await resolver.getRunRecord(matches[0]) : undefined;
  if (record) {
    return record;
  }
  throw new ActivityRunMissingMetadataError(
    runId,
    FULL_RUN_ID_RE.test(runId)
      ? "run record not found"
      : `no run record matches the "${runId}" prefix among ${known.length} known run(s); pass the full run id.`,
  );
}

async function resolveRunActivity(
  activityId: string,
  options: ResolveInteractiveActivityOptions,
  baseListOptions: InteractiveActivityOptions,
): Promise<ResolvedInteractiveActivity> {
  const handle = activityId.slice("run:".length).trim();
  const resolver = options.runActivityResolver ?? {};
  const record = await resolveRunRecordForHandle(handle, resolver);
  const runId = record.run_id;
  const kernel = await resolver.getKernelReceipt?.(runId);
  const durableCandidates = [
    candidateFromRecoveryCheckpoint(record),
    candidateFromReceipt(record.kernel_receipt, "run_record.kernel_receipt.backend_session"),
    candidateFromReceipt(kernel, "kernel_receipt.backend_session"),
  ].filter((candidate): candidate is RunActivityCandidate => Boolean(candidate));
  assertConsistentRunActivityMetadata(runId, durableCandidates);

  // Codex resume intent remains a locator of last resort. Spawn-backed Claude
  // requires a validated durable candidate from this execution.
  const resumeCandidate = candidateFromResumeSession(record);
  const candidates = durableCandidates.length > 0
    ? durableCandidates
    : resumeCandidate
      ? [resumeCandidate]
      : [];

  const resolved = await resolveRunActivityCandidates(candidates, options, runId, record, baseListOptions);
  if (resolved) {
    return resolved;
  }

  // The run record knows which host executed the run. When that is not the host
  // this read searched, the transcript's absence here is locality, not loss.
  const residentHost = normalizeHost(record.intent.host);
  const crossHost = residentHost !== undefined && residentHost !== resolveQueriedHost(options.host);
  throw new ActivityRunMissingMetadataError(
    runId,
    runActivityMetadataDetail(
      record,
      candidates.length > 0,
      Boolean(record.kernel_receipt || kernel),
    ),
    crossHost ? residentHost : undefined,
  );
}

function runResolutionResultFields(session: ResolvedInteractiveActivity): {
  run_id?: string;
  activity_resolution?: RunActivityResolution;
} {
  const resolution = session.runActivityResolution;
  return resolution
    ? {
      run_id: resolution.run_id,
      activity_resolution: resolution,
    }
    : {};
}

/**
 * Resolves an activity id to the matching {@link InteractiveSessionListEntry}.
 *
 * Supports these resolution modes:
 *   1. Full activity id (`interactive:<backend>:<session-id>`).
 *   2. Codex thread locator (`codex://threads/<uuid>` or the rollout filename UUID).
 *   3. Vault authorship alias (`<backend>:<host>:<session-id>`); resolution runs against
 *      the queried host's session stores — exact session-id match always, prefix
 *      expansion only when the alias names that host. A cross-host miss names the
 *      locator host in the error so callers can retry with `--host` (POL-1774).
 *   4. Short-prefix id matching against the recent session list.
 *   5. `latestSession=true` with optional `latestSessionBackend`.
 *   6. Run handle (`run:<run-id>`), full id or unique short prefix, backed by
 *      durable backend-session metadata.
 *
 * Throws {@link ActivityIdMalformedError} when the id matches no accepted form —
 * a grammar error, reported before any store is scanned, never as an absence
 * (POL-1825). Throws {@link ActivityRunMissingMetadataError} when a run handle
 * has no durable backend session metadata. Throws
 * {@link ActivityIdAmbiguousError} when a short prefix matches more than one
 * session or run.
 */
export async function resolveInteractiveActivity(
  options: ResolveInteractiveActivityOptions,
): Promise<ResolvedInteractiveActivity> {
  const baseListOptions: InteractiveActivityOptions = {
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.codexSessionsRoot ? { codexSessionsRoot: options.codexSessionsRoot } : {}),
    ...(options.codexArchivedSessionsRoot
      ? { codexArchivedSessionsRoot: options.codexArchivedSessionsRoot }
      : {}),
    ...(options.claudeProjectsRoot ? { claudeProjectsRoot: options.claudeProjectsRoot } : {}),
    ...(options.calyxRunsRoot ? { calyxRunsRoot: options.calyxRunsRoot } : {}),
    ...(options.includeCalyxRuns !== undefined ? { includeCalyxRuns: options.includeCalyxRuns } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.identityMaxBytes !== undefined ? { identityMaxBytes: options.identityMaxBytes } : {}),
    ...(options.beforeDiscoveryRead ? { beforeDiscoveryRead: options.beforeDiscoveryRead } : {}),
    ...(options.beforeCandidateStat ? { beforeCandidateStat: options.beforeCandidateStat } : {}),
    ...(options.beforeIdentityRead ? { beforeIdentityRead: options.beforeIdentityRead } : {}),
    ...(options.beforePageMetadataRead ? { beforePageMetadataRead: options.beforePageMetadataRead } : {}),
    sinceMs: 0,
    limit: options.limit ?? 1_000,
    ...(options.now ? { now: options.now } : {}),
  };

  const queriedHost = resolveQueriedHost(options.host);

  if (options.latestSession) {
    const sessions = await listInteractiveSessions({
      ...baseListOptions,
      ...(options.latestSessionBackend ? { kinds: [options.latestSessionBackend] } : {}),
      limit: 1,
    });
    const session = sessions[0];
    if (!session) {
      throw new ActivityIdNotFoundError(
        options.latestSessionBackend
          ? `latest ${options.latestSessionBackend} session`
          : "latest interactive session",
        { ...(queriedHost ? { searchedHost: queriedHost } : {}) },
      );
    }
    return session;
  }

  const activityId = options.activityId?.trim();
  if (!activityId) {
    throw new ActivityIdNotFoundError("(no activity id provided)");
  }

  // A locator the grammar cannot parse is a syntax error, not an absence: no
  // host holds it, so fail before scanning any store (POL-1825).
  const malformed = describeMalformedActivityLocator(activityId);
  if (malformed) {
    throw new ActivityIdMalformedError(activityId, malformed);
  }

  if (activityId.startsWith("run:")) {
    return resolveRunActivity(activityId, options, baseListOptions);
  }

  const parsed = parseInteractiveActivityLocator(activityId);
  const exact = await resolveExactInteractiveSession({
    ...baseListOptions,
    activityId,
    ...(options.candidateLimit !== undefined ? { candidateLimit: options.candidateLimit } : {}),
  });
  if (exact) {
    return exact;
  }

  // Prefix expansion is intentionally active-only. Archives are addressable
  // by exact immutable identity but never promoted into discovery behavior.
  const sessions = await listInteractiveSessionIdentities({
    ...baseListOptions,
    ...(parsed.backend ? { kinds: [parsed.backend] } : {}),
    ...(options.candidateLimit !== undefined ? { candidateLimit: options.candidateLimit } : {}),
  });

  // Authorship aliases (`<backend>:<host>:<session-id>`) naming a different host get
  // exact-match resolution only. Codex session ids are uuidv7, so sessions started in the
  // same ~minute share an 8-hex-char prefix across hosts; expanding a truncated alias
  // against the wrong host's stores would silently bind to a different session. The miss
  // falls through to the not-found hint naming the locator host instead (POL-1774).
  // `local` is the supported alias for this host (see isLocalRunTarget); resolve it to the
  // machine hostname before comparing.
  const locatorHost = normalizeHost(parsed.host);
  const aliasHostMismatch = locatorHost !== undefined && locatorHost !== queriedHost;
  const prefixCandidates = aliasHostMismatch ? [] : sessions.filter((session) => (
    interactiveSessionMatchesLocatorPrefix(session, activityId, parsed)
  ));
  if (prefixCandidates.length === 1) {
    return prefixCandidates[0]!;
  }
  if (prefixCandidates.length > 1) {
    // Deduplicate by run_id in case of overlap.
    const seen = new Set<string>();
    const deduped = prefixCandidates.filter((session) => {
      if (seen.has(session.run_id)) {
        return false;
      }
      seen.add(session.run_id);
      return true;
    });
    if (deduped.length === 1) {
      return deduped[0]!;
    }
    throw new ActivityIdAmbiguousError(
      activityId,
      "sessions",
      deduped.map((entry) => `${entry.run_id} (${entry.backend}, ${entry.updated_at})`),
    );
  }

  // Interactive activity ids are host-local: this read only ever searched one
  // host's session stores, so name it rather than implying global absence.
  throw new ActivityIdNotFoundError(activityId, {
    ...(queriedHost ? { searchedHost: queriedHost } : {}),
    hint: aliasHostMismatch
      ? `Locator names host "${locatorHost}"; if the session lives there, retry with --host ${locatorHost}.`
      : "Activity ids are host-local; if the session lives on another host, retry with --host <host>.",
  });
}

export interface InspectActivityMessagesOptions extends InteractiveActivityOptions {
  activityId?: string;
  latestSession?: boolean;
  latestSessionBackend?: InteractiveSessionBackend;
  selector?: ActivityMessageSelectorInput;
  /**
   * Consumer-profile authority boundary. When true, default-visible messages
   * are the sole input to totals, matching, ordering, and selection. Admin
   * callers omit this flag.
   */
  consumerVisibleOnly?: boolean;
  runActivityResolver?: RunActivityRecordResolver;
}

export async function inspectActivityMessages(
  options: InspectActivityMessagesOptions,
): Promise<ActivityMessagesResult> {
  const session = await resolveInteractiveActivity({
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.codexSessionsRoot ? { codexSessionsRoot: options.codexSessionsRoot } : {}),
    ...(options.codexArchivedSessionsRoot
      ? { codexArchivedSessionsRoot: options.codexArchivedSessionsRoot }
      : {}),
    ...(options.claudeProjectsRoot ? { claudeProjectsRoot: options.claudeProjectsRoot } : {}),
    ...(options.calyxRunsRoot ? { calyxRunsRoot: options.calyxRunsRoot } : {}),
    ...(options.includeCalyxRuns !== undefined ? { includeCalyxRuns: options.includeCalyxRuns } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.activityId ? { activityId: options.activityId } : {}),
    ...(options.latestSession ? { latestSession: true } : {}),
    ...(options.latestSessionBackend ? { latestSessionBackend: options.latestSessionBackend } : {}),
    ...(options.runActivityResolver ? { runActivityResolver: options.runActivityResolver } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const selector = normalizeSelector(options.selector ?? {});
  const parsed = await readSessionEventsStreaming(session.session_path, session.backend);
  const activityRef = buildActivityRef(session);
  const allMessages = projectInteractiveSessionToMessagesForSelection(parsed.events, activityRef);
  const projectedMessages = options.consumerVisibleOnly
    ? allMessages.filter((message) => message.visibility === "default")
    : allMessages;
  const search = await scanFullTextMatches(session, projectedMessages, selector);
  const { matched, returned } = applyMessagesSelector(projectedMessages, selector, search);
  const hydrated = selector.summary_only ? returned : await hydrateReturnedMessageText(session, returned);
  const decorated = applyMessageDecorations(hydrated, selector, search);
  const now = options.now?.() ?? new Date();
  const sourceState = await probeSourceState(session.session_path, parsed.warnings, parsed.events, now);

  return {
    schema_version: "activity.messages/v1",
    classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
    activity_id: activityRef.activity_id,
    ...runResolutionResultFields(session),
    backend: activityRef.backend,
    session_id: activityRef.session_id,
    session_path: activityRef.session_path,
    source: activityRef.source,
    ...(activityRef.cwd ? { cwd: activityRef.cwd } : {}),
    ...(activityRef.host ? { host: activityRef.host } : {}),
    source_state: sourceState,
    warnings: parsed.warnings,
    source_receipt: parsed.sourceReceipt,
    total_events: parsed.events.length,
    total_messages: projectedMessages.length,
    matched_messages: matched.length,
    returned_messages: decorated.length,
    truncated: decorated.length < matched.length,
    attachments: rollupAttachments(attachmentsForMessages(projectedMessages)),
    selector,
    messages: decorated,
  };
}

function isActivityMessageRole(value: string): value is ActivityMessageRole {
  return ACTIVITY_MESSAGE_ROLES.includes(value as ActivityMessageRole);
}

function visibilityForStoredRole(role: ActivityMessageRole): ActivityMessageVisibility {
  switch (role) {
    case "human":
    case "assistant":
      return "default";
    case "tool_call":
    case "tool_result":
    case "unknown":
      return "detail";
    case "harness_context":
    case "system_notice":
    case "reasoning_summary":
      return "hidden";
  }
}

function sourceStateFromStoredRows(
  session: ResolvedInteractiveActivity,
  rows: readonly ActivityMessageRow[],
  now: Date,
): { sourceState: ActivitySourceState; warnings: ActivitySourceWarning[] } {
  const warnings: ActivitySourceWarning[] = [];
  const updatedAt = Date.parse(session.updated_at);
  if (Number.isFinite(updatedAt)) {
    const ageMs = now.getTime() - updatedAt;
    if (ageMs >= 0 && ageMs <= SESSION_FRESHNESS_LIVE_MS) {
      warnings.push({
        code: "live_session",
        message: `Session file modified within the last ${Math.round(SESSION_FRESHNESS_LIVE_MS / 60_000)} minutes; results may not include the most recent events.`,
      });
      return { sourceState: "live", warnings };
    }
  }
  if (rows.length === 0) {
    warnings.push({
      code: "empty_session",
      message: "Session file has no parseable events.",
    });
  }
  return { sourceState: "complete", warnings };
}

function storedSourceReceipt(
  rows: readonly ActivityMessageRow[],
  cursor: ActivitySourceCursorRow | undefined,
): ActivitySourceReadReceipt {
  const sourceBytes = cursor?.size_bytes ?? cursor?.byte_offset;
  return {
    mode: "streaming",
    bytes_scanned: sourceBytes ?? 0,
    records_scanned: rows.length,
    records_decoded: rows.length,
    oversized_records_skipped: 0,
    max_record_bytes: DEFAULT_MAX_RECORD_BYTES,
    ...(sourceBytes !== undefined ? { source_bytes: sourceBytes } : {}),
    guard_hits: [],
  };
}

function storedAttachmentsByMessageId(
  rows: readonly ActivityAttachmentRow[],
): Map<string, ActivityAttachmentRow[]> {
  const byMessageId = new Map<string, ActivityAttachmentRow[]>();
  for (const row of rows) {
    const existing = byMessageId.get(row.message_id);
    if (existing) {
      existing.push(row);
    } else {
      byMessageId.set(row.message_id, [row]);
    }
  }
  return byMessageId;
}

function attachmentRecordFromStoredRow(
  row: ActivityAttachmentRow,
  message: ActivityMessage,
  metadata: ActivityAttachmentReconstructionPayload,
): ActivityAttachmentRecord | undefined {
  const ref = attachmentRefForDigest(row.sha256);
  if (metadata.ref !== ref) {
    return undefined;
  }
  return {
    ref,
    sha256: row.sha256,
    mime_type: canonicalAttachmentMimeType(row.mime),
    byte_size: row.byte_size,
    source_shape: metadata.source_shape,
    exact_bytes_available: metadata.exact_bytes_available,
    activity_id: message.activity_id,
    message_id: message.id,
    source_line: metadata.source_line,
    event_index: metadata.event_index,
    ...(metadata.detail ? { detail: metadata.detail } : {}),
    ...(metadata.original_locator ? { original_locator: metadata.original_locator } : {}),
  };
}

function storedSummaryFallback(
  role: ActivityMessageRole,
  payload: ActivityMessageReconstructionPayload,
): string {
  if (role === "reasoning_summary") {
    return "[redacted reasoning]";
  }
  switch (payload.classification.source_kind) {
    case "session_meta":
      return "session metadata";
    case "turn_context":
      return "turn context";
    case "event_msg":
      return "event message";
    default:
      return payload.classification.source_kind;
  }
}

function messageFromStoredRow(
  row: ActivityMessageRow,
  activity: ActivityMessageActivityRef,
  attachmentRows: readonly ActivityAttachmentRow[],
): ActivityMessage | undefined {
  if (
    row.classifier_version !== ACTIVITY_MESSAGE_CLASSIFIER_VERSION
    || !row.payload_json
    || !isActivityMessageRole(row.origin)
  ) {
    return undefined;
  }
  const payload = parseActivityMessagePayload(row.payload_json);
  if (!payload) {
    return undefined;
  }
  const base: ActivityMessage = {
    id: row.message_id,
    activity_id: row.activity_id,
    activity,
    ...(row.turn_id ? { turn_id: row.turn_id } : {}),
    role: row.origin,
    visibility: visibilityForStoredRole(row.origin),
    summary: summarizeText(row.text, storedSummaryFallback(row.origin, payload)),
    ...(row.text ? { text: row.text } : {}),
    ...(row.timestamp ? { timestamp: row.timestamp } : {}),
    event_refs: payload.event_refs,
    source_lines: payload.source_lines,
    classification: {
      classifier_version: row.classifier_version,
      rule_id: payload.classification.rule_id,
      reason: payload.classification.reason,
      source_role: payload.classification.source_role,
      source_kind: payload.classification.source_kind,
      ...(payload.classification.raw_type ? { raw_type: payload.classification.raw_type } : {}),
    },
  };
  const payloadAttachments = payload.attachments ?? [];
  const attachmentPayloads = new Map(payloadAttachments.map((attachment) => [attachment.ref, attachment]));
  if (attachmentRows.length !== payloadAttachments.length || attachmentPayloads.size !== payloadAttachments.length) {
    return undefined;
  }
  const attachments: ActivityAttachmentRecord[] = [];
  for (const attachment of attachmentRows) {
    const metadata = attachmentPayloads.get(attachmentRefForDigest(attachment.sha256));
    if (!metadata) {
      return undefined;
    }
    const record = attachmentRecordFromStoredRow(attachment, base, metadata);
    if (!record) {
      return undefined;
    }
    attachments.push(record);
  }
  return attachments.length > 0 ? { ...base, attachments } : base;
}

function uniqueStoredActivityHost(rows: readonly ActivityMessageRow[]): string | undefined {
  const hosts = new Set(rows.map((row) => row.host).filter((host): host is string => Boolean(host)));
  return hosts.size === 1 ? [...hosts][0] : undefined;
}

function storedActivityRef(
  session: ResolvedInteractiveActivity,
  rows: readonly ActivityMessageRow[],
): ActivityMessageActivityRef {
  const activity = buildActivityRef(session);
  const storedHost = uniqueStoredActivityHost(rows);
  return storedHost ? { ...activity, host: storedHost } : activity;
}

function messagesFromStoredRows(
  activity: ActivityMessageActivityRef,
  rows: readonly ActivityMessageRow[],
  attachmentRows: readonly ActivityAttachmentRow[],
): ActivityMessage[] | undefined {
  const attachmentsByMessageId = storedAttachmentsByMessageId(attachmentRows);
  const messages: ActivityMessage[] = [];
  for (const row of rows) {
    const message = messageFromStoredRow(row, activity, attachmentsByMessageId.get(row.message_id) ?? []);
    if (!message) {
      return undefined;
    }
    messages.push(message);
  }
  return messages;
}

function scanStoredTextMatches(
  messages: ActivityMessage[],
  selector: ActivityMessagesSelector,
): ActivityTextSearchScan | undefined {
  if (!selector.grep && !selector.around_text) {
    return undefined;
  }
  const result: ActivityTextSearchScan = {
    grep_lines: new Set<number>(),
    hit_ranges: new Map<number, [number, number]>(),
  };
  for (const message of messages) {
    if (!visibilityAllowed(message.visibility, selector.visibility)) {
      continue;
    }
    if (selector.role && message.role !== selector.role) {
      continue;
    }
    const sourceLine = message.source_lines[0];
    if (typeof sourceLine !== "number") {
      continue;
    }
    const text = message.text ?? "";
    const haystack = `${message.role}\n${message.summary}\n${text}`;
    if (selector.grep) {
      const grepRange = textMatchRange(haystack, selector.grep, true);
      if (grepRange) {
        result.grep_lines.add(sourceLine);
        const textRange = textMatchRange(text, selector.grep, true);
        if (textRange) {
          result.hit_ranges.set(sourceLine, textRange);
        }
      }
    }
    if (selector.around_text && result.around_text_line === undefined) {
      const aroundRange = textMatchRange(haystack, selector.around_text, false);
      if (aroundRange) {
        result.around_text_line = sourceLine;
        const textRange = textMatchRange(text, selector.around_text, false);
        if (textRange) {
          result.hit_ranges.set(sourceLine, textRange);
        }
      }
    }
  }
  return result;
}

export interface InspectActivityMessagesFromStoreOptions {
  session: ResolvedInteractiveActivity;
  rows: readonly ActivityMessageRow[];
  attachmentRows: readonly ActivityAttachmentRow[];
  cursor?: ActivitySourceCursorRow | undefined;
  selector?: ActivityMessageSelectorInput;
  consumerVisibleOnly?: boolean;
  now?: () => Date;
}

export function inspectActivityMessagesFromStore(
  options: InspectActivityMessagesFromStoreOptions,
): ActivityMessagesResult | undefined {
  const selector = normalizeSelector(options.selector ?? {});
  const activityRef = storedActivityRef(options.session, options.rows);
  const allMessages = messagesFromStoredRows(activityRef, options.rows, options.attachmentRows);
  if (!allMessages) {
    return undefined;
  }
  const projectedMessages = options.consumerVisibleOnly
    ? allMessages.filter((message) => message.visibility === "default")
    : allMessages;
  const search = scanStoredTextMatches(projectedMessages, selector);
  const { matched, returned } = applyMessagesSelector(projectedMessages, selector, search);
  const decorated = applyMessageDecorations(returned, selector, search);
  const { sourceState, warnings } = sourceStateFromStoredRows(
    options.session,
    options.rows,
    options.now?.() ?? new Date(),
  );

  return {
    schema_version: "activity.messages/v1",
    classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
    activity_id: activityRef.activity_id,
    ...runResolutionResultFields(options.session),
    backend: activityRef.backend,
    session_id: activityRef.session_id,
    session_path: activityRef.session_path,
    source: activityRef.source,
    ...(activityRef.cwd ? { cwd: activityRef.cwd } : {}),
    ...(activityRef.host ? { host: activityRef.host } : {}),
    source_state: sourceState,
    warnings,
    source_receipt: storedSourceReceipt(options.rows, options.cursor),
    total_events: options.rows.length,
    total_messages: projectedMessages.length,
    matched_messages: matched.length,
    returned_messages: decorated.length,
    truncated: decorated.length < matched.length,
    attachments: rollupAttachments(attachmentsForMessages(projectedMessages)),
    selector,
    messages: decorated,
  };
}

export interface ParsedActivitySourceId {
  activityId: string;
  sourceLine: number;
}

function parseFinalActivitySourceId(
  value: string,
  marker: ":msg:" | ":turn:",
  label: "Message" | "Turn",
  makeError: (message: string) => Error,
): ParsedActivitySourceId {
  const index = value.lastIndexOf(marker);
  if (index <= 0) {
    throw makeError(`${label} id must have the form <activity-id>${marker}<source-line>.`);
  }
  const activityId = value.slice(0, index);
  const lineText = value.slice(index + marker.length);
  if (!/^[1-9]\d*$/u.test(lineText)) {
    throw makeError(`${label} id source line must be a canonical positive integer.`);
  }
  const sourceLine = Number(lineText);
  if (!Number.isSafeInteger(sourceLine) || String(sourceLine) !== lineText) {
    throw makeError(`${label} id source line must be a safe positive integer.`);
  }
  return { activityId, sourceLine };
}

/** Split only on the final marker so canonical activity IDs may contain colons. */
export function parseActivityMessageId(messageId: string): ParsedActivitySourceId {
  return parseFinalActivitySourceId(
    messageId,
    ":msg:",
    "Message",
    (message) => new ActivityMessageSelectorError(message),
  );
}

function parseTextRange(range: string | undefined, totalChars: number, from: number | undefined): [number, number] {
  if (range && from !== undefined) {
    throw new ActivityMessageSelectorError("--range and --from are mutually exclusive.");
  }
  if (range) {
    const match = range.trim().match(/^(\d+):(\d+)$/);
    if (!match) {
      throw new ActivityMessageSelectorError("--range must be A:B with non-negative integer offsets.");
    }
    const start = Number.parseInt(match[1]!, 10);
    const end = Number.parseInt(match[2]!, 10);
    if (start > end || end > totalChars) {
      throw new ActivityMessageSelectorError(`--range ${range} is outside text bounds 0:${totalChars}.`);
    }
    return [start, end];
  }
  if (from !== undefined) {
    if (!Number.isInteger(from) || from < 0 || from > totalChars) {
      throw new ActivityMessageSelectorError(`--from must be between 0 and ${totalChars}.`);
    }
    return [from, totalChars];
  }
  return [0, totalChars];
}

export interface InspectActivityTextOptions extends InteractiveActivityOptions {
  messageId: string;
  selector?: ActivityTextSelectorInput;
  /** Require the message to be default-visible before reading its raw text. */
  consumerVisibleOnly?: boolean;
  runActivityResolver?: RunActivityRecordResolver;
}

export async function inspectActivityText(
  options: InspectActivityTextOptions,
): Promise<ActivityTextResult> {
  if (options.selector?.classifier_version && options.selector.classifier_version !== ACTIVITY_MESSAGE_CLASSIFIER_VERSION) {
    throw new ActivityMessageSelectorError(
      `classifier_version mismatch: cursor was minted for ${options.selector.classifier_version}, current classifier is ${ACTIVITY_MESSAGE_CLASSIFIER_VERSION}.`,
    );
  }
  const parsedId = parseActivityMessageId(options.messageId);
  const session = await resolveInteractiveActivity({
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.codexSessionsRoot ? { codexSessionsRoot: options.codexSessionsRoot } : {}),
    ...(options.codexArchivedSessionsRoot
      ? { codexArchivedSessionsRoot: options.codexArchivedSessionsRoot }
      : {}),
    ...(options.claudeProjectsRoot ? { claudeProjectsRoot: options.claudeProjectsRoot } : {}),
    ...(options.calyxRunsRoot ? { calyxRunsRoot: options.calyxRunsRoot } : {}),
    ...(options.includeCalyxRuns !== undefined ? { includeCalyxRuns: options.includeCalyxRuns } : {}),
    ...(options.host ? { host: options.host } : {}),
    activityId: parsedId.activityId,
    ...(options.runActivityResolver ? { runActivityResolver: options.runActivityResolver } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  if (options.consumerVisibleOnly) {
    const parsed = await readSessionEventsStreaming(session.session_path, session.backend);
    const activityRef = buildActivityRef(session);
    const message = projectInteractiveSessionToMessagesForSelection(parsed.events, activityRef)
      .find((candidate) => candidate.id === options.messageId);
    if (!message || message.visibility !== "default") {
      throw new ActivityMessageNotFoundError(options.messageId);
    }
  }
  const loaded = await readFullMessageTextAtLine(session, parsedId.sourceLine);
  const text = loaded.text ?? "";
  const [start, end] = parseTextRange(options.selector?.range, text.length, options.selector?.from);
  const cursor: ActivityTextCursor = {
    total_chars: text.length,
    returned: [[start, end]],
  };
  if (end < text.length) {
    cursor.next = end;
  }
  return {
    schema_version: "activity.text/v1",
    classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
    activity_id: parsedId.activityId,
    backend: session.backend,
    session_id: session.session_id,
    session_path: session.session_path,
    message_id: options.messageId,
    source_line: parsedId.sourceLine,
    text: text.slice(start, end),
    text_cursor: cursor,
    source_receipt: loaded.sourceReceipt,
  };
}

export function defaultAttachmentCacheDir(homeDir?: string): string {
  return path.join(homeDir ?? homedir(), DEFAULT_ATTACHMENT_CACHE_DIR);
}

function attachmentMimeIdentity(mimeType: string): string {
  return createHash("sha256").update(canonicalAttachmentMimeType(mimeType)).digest("hex");
}

function attachmentCacheObjectPath(outDir: string, attachment: Pick<ActivityAttachmentRecord, "sha256" | "mime_type">): string {
  return path.join(
    outDir,
    `${attachment.sha256}.${attachmentMimeIdentity(attachment.mime_type)}.${extensionForMimeType(attachment.mime_type)}`,
  );
}

function attachmentCacheProvenancePath(
  outDir: string,
  attachment: Pick<ActivityAttachmentRecord, "sha256" | "mime_type">,
): string {
  return path.join(
    outDir,
    `${attachment.sha256}.${attachmentMimeIdentity(attachment.mime_type)}.provenance.json`,
  );
}

function legacyAttachmentCacheObjectPath(
  outDir: string,
  attachment: Pick<ActivityAttachmentRecord, "sha256" | "mime_type">,
): string {
  return path.join(outDir, `${attachment.sha256}.${extensionForMimeType(attachment.mime_type)}`);
}

function legacyAttachmentCacheProvenancePath(
  outDir: string,
  attachment: Pick<ActivityAttachmentRecord, "sha256">,
): string {
  return path.join(outDir, `${attachment.sha256}.provenance.json`);
}

function observationFromAttachment(
  attachment: ActivityAttachmentRecord,
  args: {
    sourceTier: ActivityAttachmentSourceTier;
    fetchedAt: string;
    classifierVersion: string;
    originHost?: string;
    servedByHost?: string;
  },
): ActivityAttachmentCacheObservation {
  return {
    activity_id: attachment.activity_id,
    message_id: attachment.message_id,
    source_line: attachment.source_line,
    source_shape: attachment.source_shape,
    ...(args.originHost ? { origin_host: args.originHost } : {}),
    ...(args.servedByHost ? { served_by_host: args.servedByHost } : {}),
    source_tier: requireActivityAttachmentSourceTier(args.sourceTier),
    fetched_at: args.fetchedAt,
    classifier_version: args.classifierVersion,
  };
}

const ACTIVITY_ATTACHMENT_SOURCE_SHAPES = new Set<ActivityAttachmentSourceShape>([
  "claude.source.base64",
  "claude.file.base64",
  "codex.input_image.data_url",
  "codex.local_path",
  "codex.remote_url",
  "file_id",
  "pasted_clipboard",
  "unknown",
]);
const ACTIVITY_ATTACHMENT_SOURCE_TIER_PATTERN = new RegExp(
  CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_PATTERN_SOURCE,
  "u",
);
const ATTACHMENT_MIME_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;

class ActivityAttachmentCacheProvenanceEncodingError extends Error {
  constructor(filePath: string) {
    super(`Attachment cache provenance ${filePath} is not valid UTF-8; refusing to replace original custody evidence.`);
    this.name = "ActivityAttachmentCacheProvenanceEncodingError";
  }
}

function decodeProvenanceUtf8(bytes: Buffer, filePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ActivityAttachmentCacheProvenanceEncodingError(filePath);
  }
}

async function readTextFileBounded(filePath: string, maxBytes: number): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(16 * 1024, maxBytes + 1 - totalBytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return decodeProvenanceUtf8(Buffer.concat(chunks, totalBytes), filePath);
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    return undefined;
  } catch (error) {
    if (error instanceof ActivityAttachmentCacheProvenanceEncodingError) throw error;
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function boundedNonEmptyString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function parseActivityAttachmentSourceTier(value: unknown): ActivityAttachmentSourceTier | undefined {
  return typeof value === "string" && ACTIVITY_ATTACHMENT_SOURCE_TIER_PATTERN.test(value)
    ? value
    : undefined;
}

function requireActivityAttachmentSourceTier(value: string): ActivityAttachmentSourceTier {
  const sourceTier = parseActivityAttachmentSourceTier(value);
  if (!sourceTier) {
    throw new Error(
      `Attachment source_tier must be a 1-${CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_MAX_CHARS} character ASCII custody token.`,
    );
  }
  return sourceTier;
}

function parseAttachmentCacheObservation(value: unknown): ActivityAttachmentCacheObservation | undefined {
  if (!isRecord(value)) return undefined;
  const sourceShape = value["source_shape"];
  const sourceTier = parseActivityAttachmentSourceTier(value["source_tier"]);
  const fetchedAt = value["fetched_at"];
  const sourceLine = value["source_line"];
  if (
    !boundedNonEmptyString(value["activity_id"], 1_024)
    || !boundedNonEmptyString(value["message_id"], 1_024)
    || !Number.isSafeInteger(sourceLine)
    || (sourceLine as number) < 0
    || typeof sourceShape !== "string"
    || !ACTIVITY_ATTACHMENT_SOURCE_SHAPES.has(sourceShape as ActivityAttachmentSourceShape)
    || sourceTier === undefined
    || !boundedNonEmptyString(fetchedAt, 64)
    || !Number.isFinite(Date.parse(fetchedAt))
    || !boundedNonEmptyString(value["classifier_version"], 255)
    || (value["origin_host"] !== undefined && !boundedNonEmptyString(value["origin_host"], 255))
    || (value["served_by_host"] !== undefined && !boundedNonEmptyString(value["served_by_host"], 255))
  ) {
    return undefined;
  }
  return {
    activity_id: value["activity_id"],
    message_id: value["message_id"],
    source_line: sourceLine as number,
    source_shape: sourceShape as ActivityAttachmentSourceShape,
    ...(typeof value["origin_host"] === "string" ? { origin_host: value["origin_host"] } : {}),
    ...(typeof value["served_by_host"] === "string" ? { served_by_host: value["served_by_host"] } : {}),
    source_tier: sourceTier,
    fetched_at: fetchedAt,
    classifier_version: value["classifier_version"],
  };
}

async function readAttachmentCacheEntry(
  provenancePath: string,
  attachment: ActivityAttachmentRecord,
): Promise<ActivityAttachmentCacheEntry | undefined> {
  try {
    const source = await readTextFileBounded(
      provenancePath,
      ACTIVITY_ATTACHMENT_CACHE_PROVENANCE_MAX_BYTES,
    );
    if (source === undefined) return undefined;
    const parsed = JSON.parse(source) as unknown;
    const canonicalMimeType = canonicalAttachmentMimeType(attachment.mime_type);
    const parsedMimeType = isRecord(parsed) && typeof parsed["mime_type"] === "string"
      ? canonicalAttachmentMimeType(parsed["mime_type"])
      : undefined;
    const expectedExtension = extensionForMimeType(canonicalMimeType);
    if (
      !isRecord(parsed)
      || parsed["schema_version"] !== "activity.attachment-cache-entry/v1"
      || parsed["ref"] !== attachment.ref
      || parsed["sha256"] !== attachment.sha256
      || parsedMimeType !== canonicalMimeType
      || parsed["extension"] !== expectedExtension
      || parsed["byte_size"] !== attachment.byte_size
      || !ATTACHMENT_MIME_TYPE_PATTERN.test(canonicalMimeType)
      || !Array.isArray(parsed["observations"])
      || parsed["observations"].length > ACTIVITY_ATTACHMENT_CACHE_OBSERVATION_MAX_ITEMS
    ) {
      return undefined;
    }
    const observations: ActivityAttachmentCacheObservation[] = [];
    for (const candidate of parsed["observations"]) {
      const observation = parseAttachmentCacheObservation(candidate);
      if (!observation) return undefined;
      observations.push(observation);
    }
    return {
      schema_version: "activity.attachment-cache-entry/v1",
      ref: attachment.ref,
      sha256: attachment.sha256,
      mime_type: canonicalMimeType,
      extension: expectedExtension,
      byte_size: attachment.byte_size,
      observations,
    };
  } catch (error) {
    if (error instanceof ActivityAttachmentCacheProvenanceEncodingError) throw error;
    return undefined;
  }
}

async function writeAttachmentCacheEntry(
  provenancePath: string,
  entry: ActivityAttachmentCacheEntry,
): Promise<void> {
  const tmpPath = `${provenancePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const serialized = `${JSON.stringify(entry, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > ACTIVITY_ATTACHMENT_CACHE_PROVENANCE_MAX_BYTES) {
      throw new Error(
        `Attachment cache provenance exceeds ${ACTIVITY_ATTACHMENT_CACHE_PROVENANCE_MAX_BYTES} bytes.`,
      );
    }
    await writeFile(tmpPath, serialized, { mode: 0o600 });
    await syncFileContents(tmpPath);
    await rename(tmpPath, provenancePath);
    await syncDirectoryEntries(path.dirname(provenancePath));
  } finally {
    await rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

function attachmentObservationIdentity(observation: ActivityAttachmentCacheObservation): string {
  return JSON.stringify({
    activity_id: observation.activity_id,
    message_id: observation.message_id,
    source_line: observation.source_line,
    source_shape: observation.source_shape,
    origin_host: observation.origin_host ?? null,
    served_by_host: observation.served_by_host ?? null,
    source_tier: observation.source_tier,
    classifier_version: observation.classifier_version,
  });
}

async function appendAttachmentCacheObservation(
  outDir: string,
  attachment: ActivityAttachmentRecord,
  observation: ActivityAttachmentCacheObservation,
): Promise<string> {
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const provenancePath = attachmentCacheProvenancePath(outDir, attachment);
  const mutexPath = path.join(
    outDir,
    "_mutexes",
    `${attachment.sha256}.${attachmentMimeIdentity(attachment.mime_type)}.provenance.sqlite3`,
  );
  return withSqliteMutex(mutexPath, async () => {
    const existing = await readAttachmentCacheEntry(provenancePath, attachment);
    const canonicalMimeType = canonicalAttachmentMimeType(attachment.mime_type);
    const observationIdentity = attachmentObservationIdentity(observation);
    const observations = [
      ...(existing?.observations ?? []).filter(
        (candidate) => attachmentObservationIdentity(candidate) !== observationIdentity,
      ),
      observation,
    ].slice(-ACTIVITY_ATTACHMENT_CACHE_OBSERVATION_MAX_ITEMS);
    const entry: ActivityAttachmentCacheEntry = {
      schema_version: "activity.attachment-cache-entry/v1",
      ref: attachment.ref,
      sha256: attachment.sha256,
      mime_type: canonicalMimeType,
      extension: extensionForMimeType(canonicalMimeType),
      byte_size: attachment.byte_size,
      observations,
    };
    await writeAttachmentCacheEntry(provenancePath, entry);
    return provenancePath;
  }, { acquireTimeoutMs: null });
}

async function digestAttachmentFile(
  filePath: string,
  maxBytes: number,
): Promise<{ byteSize: number; sha256: string }> {
  const hash = createHash("sha256");
  let byteSize = 0;
  const stream = createReadStream(filePath, { highWaterMark: STREAM_CHUNK_BYTES });
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    byteSize += chunk.length;
    if (byteSize > maxBytes) {
      stream.destroy();
      throw new Error(`Attachment cache object exceeds the ${maxBytes}-byte verification limit.`);
    }
    hash.update(chunk);
  }
  return { byteSize, sha256: hash.digest("hex") };
}

async function verifyCacheFileAtPath(
  outputPath: string,
  attachment: Pick<ActivityAttachmentRecord, "sha256" | "mime_type" | "byte_size">,
): Promise<VerifiedActivityAttachmentCacheFile | undefined> {
  try {
    const verified = await digestAttachmentFile(
      outputPath,
      Math.min(ACTIVITY_ATTACHMENT_MAX_BYTES, attachment.byte_size),
    );
    if (verified.byteSize !== attachment.byte_size || verified.sha256 !== attachment.sha256) {
      return undefined;
    }
    return {
      path: outputPath,
      byte_size: verified.byteSize,
      sha256: verified.sha256,
    };
  } catch {
    return undefined;
  }
}

async function readCacheFileIfVerified(
  outDir: string,
  attachment: Pick<ActivityAttachmentRecord, "sha256" | "mime_type" | "byte_size">,
): Promise<VerifiedActivityAttachmentCacheFile | undefined> {
  const outputPath = attachmentCacheObjectPath(outDir, attachment);
  const current = await verifyCacheFileAtPath(outputPath, attachment);
  const legacyObjectPath = legacyAttachmentCacheObjectPath(outDir, attachment);
  const legacyProvenancePath = legacyAttachmentCacheProvenancePath(outDir, attachment);
  if (current) {
    await rm(legacyObjectPath, { force: true }).catch(() => undefined);
    await rm(legacyProvenancePath, { force: true }).catch(() => undefined);
    return current;
  }

  const legacy = await verifyCacheFileAtPath(legacyObjectPath, attachment);
  if (!legacy) return undefined;
  try {
    await link(legacyObjectPath, outputPath);
    await syncDirectoryEntries(outDir);
  } catch {
    const competingCurrent = await verifyCacheFileAtPath(outputPath, attachment);
    if (!competingCurrent) return undefined;
  }
  const promoted = await verifyCacheFileAtPath(outputPath, attachment);
  if (!promoted) return undefined;
  await rm(legacyObjectPath, { force: true }).catch(() => undefined);
  // Legacy provenance was keyed only by digest and could therefore describe a
  // different representation. Discard it and let the current observation
  // publish an exact digest+MIME receipt instead of misattributing history.
  await rm(legacyProvenancePath, { force: true }).catch(() => undefined);
  return promoted;
}

export async function readVerifiedAttachmentCache(
  outDir: string,
  attachment: Pick<ActivityAttachmentRecord, "sha256" | "mime_type" | "byte_size">,
): Promise<VerifiedActivityAttachmentCacheFile | undefined> {
  return readCacheFileIfVerified(outDir, attachment);
}

export async function createAttachmentCacheTempPath(
  outDir: string,
  attachment: Pick<ActivityAttachmentRecord, "sha256" | "mime_type">,
): Promise<string> {
  const tmpDir = path.join(outDir, "_tmp");
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  return path.join(
    tmpDir,
    `${attachment.sha256}.${extensionForMimeType(attachment.mime_type)}.${process.pid}.${randomUUID()}`,
  );
}

export async function recordVerifiedAttachmentCacheHit(args: {
  outDir: string;
  attachment: ActivityAttachmentRecord;
  sourceTier: ActivityAttachmentSourceTier;
  classifierVersion?: string;
  fetchedAt?: string;
  originHost?: string;
  servedByHost?: string;
}): Promise<ActivityAttachmentCacheWriteResult | undefined> {
  const verified = await readCacheFileIfVerified(args.outDir, args.attachment);
  if (!verified) return undefined;
  const observation = observationFromAttachment(args.attachment, {
    sourceTier: args.sourceTier,
    fetchedAt: args.fetchedAt ?? new Date().toISOString(),
    classifierVersion: args.classifierVersion ?? ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
    ...(args.originHost ? { originHost: args.originHost } : {}),
    ...(args.servedByHost ? { servedByHost: args.servedByHost } : {}),
  });
  const provenancePath = await appendAttachmentCacheObservation(args.outDir, args.attachment, observation);
  return { path: verified.path, provenance_path: provenancePath, cache_status: "hit" };
}

/**
 * Verifies and atomically publishes a caller-populated cache temporary file.
 *
 * Ownership of `tempPath` transfers to this function: it is removed on every
 * failure and after a verified cache hit. Callers must create it through
 * `createAttachmentCacheTempPath` so the final rename remains on one filesystem.
 */
export async function publishVerifiedAttachmentCacheFile(args: {
  outDir: string;
  attachment: ActivityAttachmentRecord;
  tempPath: string;
  sourceTier: ActivityAttachmentSourceTier;
  classifierVersion?: string;
  fetchedAt?: string;
  originHost?: string;
  servedByHost?: string;
}): Promise<ActivityAttachmentCacheWriteResult> {
  const expectedTmpDir = path.resolve(args.outDir, "_tmp");
  if (path.dirname(path.resolve(args.tempPath)) !== expectedTmpDir) {
    throw new Error(`Attachment cache temporary file must be created under ${expectedTmpDir}.`);
  }
  try {
    if (
      !Number.isSafeInteger(args.attachment.byte_size)
      || args.attachment.byte_size < 0
      || args.attachment.byte_size > ACTIVITY_ATTACHMENT_MAX_BYTES
    ) {
      throw new Error(
        `Attachment ${args.attachment.ref} declares ${args.attachment.byte_size} bytes; the hard maximum is ${ACTIVITY_ATTACHMENT_MAX_BYTES}.`,
      );
    }

    const verifiedSource = await digestAttachmentFile(args.tempPath, ACTIVITY_ATTACHMENT_MAX_BYTES);
    if (verifiedSource.byteSize !== args.attachment.byte_size) {
      throw new Error(
        `Attachment ${args.attachment.ref} failed byte-size verification: expected ${args.attachment.byte_size}, got ${verifiedSource.byteSize}.`,
      );
    }
    if (verifiedSource.sha256 !== args.attachment.sha256) {
      throw new ActivityAttachmentError(
        "attachment_digest_mismatch",
        `Attachment ${args.attachment.ref} failed sha256 verification: expected ${args.attachment.sha256}, got ${verifiedSource.sha256}.`,
        {
          details: {
            ref: args.attachment.ref,
            activity_id: args.attachment.activity_id,
            expected_sha256: args.attachment.sha256,
            actual_sha256: verifiedSource.sha256,
          },
        },
      );
    }
    // A successful cache receipt is a custody boundary. Persist the verified
    // bytes before making their content-addressed name reachable.
    await syncFileContents(args.tempPath);

    await mkdir(args.outDir, { recursive: true, mode: 0o700 });
    const outputPath = attachmentCacheObjectPath(args.outDir, args.attachment);
    const observation = observationFromAttachment(args.attachment, {
      sourceTier: args.sourceTier,
      fetchedAt: args.fetchedAt ?? new Date().toISOString(),
      classifierVersion: args.classifierVersion ?? ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
      ...(args.originHost ? { originHost: args.originHost } : {}),
      ...(args.servedByHost ? { servedByHost: args.servedByHost } : {}),
    });

    const verifiedHit = await readCacheFileIfVerified(args.outDir, args.attachment);
    if (verifiedHit) {
      const provenancePath = await appendAttachmentCacheObservation(args.outDir, args.attachment, observation);
      return { path: verifiedHit.path, provenance_path: provenancePath, cache_status: "hit" };
    }

    let quarantinedPath: string | undefined;
    try {
      await stat(outputPath);
      const candidatePath = `${outputPath}.corrupt-${Date.now()}-${randomUUID()}`;
      await rename(outputPath, candidatePath);
      quarantinedPath = candidatePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (quarantinedPath) await syncDirectoryEntries(args.outDir);

    // The content-addressed object is the durable first commit. If provenance
    // publication fails, an exact retry verifies this object and completes the
    // missing observation as a cache hit; it never republishes unverified bytes.
    await rename(args.tempPath, outputPath);
    await syncDirectoryEntries(args.outDir);
    const provenancePath = await appendAttachmentCacheObservation(args.outDir, args.attachment, observation);
    return {
      path: outputPath,
      provenance_path: provenancePath,
      cache_status: quarantinedPath ? "rewritten" : "written",
      ...(quarantinedPath ? { quarantined_path: quarantinedPath } : {}),
    };
  } finally {
    await rm(args.tempPath, { force: true }).catch(() => undefined);
    await rmdir(path.dirname(args.tempPath)).catch(() => undefined);
  }
}

export async function writeVerifiedAttachmentCache(args: {
  outDir: string;
  attachment: ActivityAttachmentRecord;
  bytes: Buffer;
  sourceTier: ActivityAttachmentSourceTier;
  classifierVersion?: string;
  fetchedAt?: string;
  originHost?: string;
  servedByHost?: string;
}): Promise<ActivityAttachmentCacheWriteResult> {
  if (
    !Number.isSafeInteger(args.attachment.byte_size)
    || args.attachment.byte_size < 0
    || args.attachment.byte_size > ACTIVITY_ATTACHMENT_MAX_BYTES
    || args.bytes.length > ACTIVITY_ATTACHMENT_MAX_BYTES
  ) {
    throw new Error(
      `Attachment ${args.attachment.ref} exceeds the hard maximum of ${ACTIVITY_ATTACHMENT_MAX_BYTES} bytes.`,
    );
  }
  if (args.bytes.length !== args.attachment.byte_size) {
    throw new Error(
      `Attachment ${args.attachment.ref} failed byte-size verification: expected ${args.attachment.byte_size}, got ${args.bytes.length}.`,
    );
  }
  const actualDigest = sha256Buffer(args.bytes);
  if (actualDigest !== args.attachment.sha256) {
    throw new ActivityAttachmentError(
      "attachment_digest_mismatch",
      `Attachment ${args.attachment.ref} failed sha256 verification: expected ${args.attachment.sha256}, got ${actualDigest}.`,
      {
        details: {
          ref: args.attachment.ref,
          activity_id: args.attachment.activity_id,
          expected_sha256: args.attachment.sha256,
          actual_sha256: actualDigest,
        },
      },
    );
  }

  const tmpPath = await createAttachmentCacheTempPath(args.outDir, args.attachment);
  try {
    await writeFile(tmpPath, args.bytes, { mode: 0o600, flag: "wx" });
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return publishVerifiedAttachmentCacheFile({
    ...args,
    tempPath: tmpPath,
  });
}

function sourceLocatorForSession(session: ResolvedInteractiveActivity): string {
  if (session.runActivityResolution) {
    return `run:${session.runActivityResolution.run_id}`;
  }
  if (session.backend === "codex") {
    return `codex://threads/${session.session_id}`;
  }
  return `interactive:${session.backend}:${session.session_id}`;
}

function attachmentOriginHost(session: ResolvedInteractiveActivity, fallbackHost?: string): string | undefined {
  return session.host ?? fallbackHost;
}

async function decodeAttachmentBytesFromSource(
  session: ResolvedInteractiveActivity,
  attachment: ActivityAttachmentRecord,
): Promise<Buffer> {
  if (!attachment.exact_bytes_available) {
    throw new ActivityAttachmentError(
      "attachment_bytes_unavailable",
      `Attachment ${attachment.ref} was observed, but exact bytes are unavailable from source shape ${attachment.source_shape}.`,
      { details: { ref: attachment.ref, activity_id: attachment.activity_id } },
    );
  }
  const line = await readSanitizedJsonLineAt(session.session_path, attachment.source_line);
  const pending = line.sanitized?.attachments.find((candidate) => candidate.ref === attachment.ref);
  if (!pending?.base64) {
    throw new ActivityAttachmentError(
      "attachment_bytes_unavailable",
      `Attachment ${attachment.ref} was observed, but source bytes could not be recovered from line ${attachment.source_line}.`,
      { details: { ref: attachment.ref, activity_id: attachment.activity_id } },
    );
  }
  const bytes = Buffer.from(pending.base64, "base64");
  const digest = sha256Buffer(bytes);
  if (digest !== attachment.sha256) {
    throw new ActivityAttachmentError(
      "attachment_digest_mismatch",
      `Attachment ${attachment.ref} failed sha256 verification: expected ${attachment.sha256}, got ${digest}.`,
      {
        details: {
          ref: attachment.ref,
          activity_id: attachment.activity_id,
          expected_sha256: attachment.sha256,
          actual_sha256: digest,
        },
      },
    );
  }
  return bytes;
}

async function extractAttachment(
  session: ResolvedInteractiveActivity,
  attachment: ActivityAttachmentRecord,
  outDir: string,
  options: {
    sourceTier?: ActivityAttachmentSourceTier;
    originHost?: string;
    servedByHost?: string;
  } = {},
): Promise<ActivityAttachmentRecord> {
  let bytes: Buffer;
  try {
    bytes = await decodeAttachmentBytesFromSource(session, attachment);
  } catch (error) {
    if (error instanceof ActivityAttachmentError && error.code === "attachment_bytes_unavailable") {
      return attachment;
    }
    throw error;
  }
  const host = options.originHost ?? attachmentOriginHost(session);
  const sourceTier = options.sourceTier ?? "local-transcript";
  const servedByHost = options.servedByHost ?? host;
  const cacheResult = await writeVerifiedAttachmentCache({
    outDir,
    attachment,
    bytes,
    sourceTier,
    classifierVersion: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
    ...(host ? { originHost: host } : {}),
    ...(servedByHost ? { servedByHost } : {}),
  });
  return {
    ...attachment,
    extracted_path: cacheResult.path,
    provenance_path: cacheResult.provenance_path,
    cache_status: cacheResult.cache_status,
    source_tier: sourceTier,
    ...(host ? { origin_host: host } : {}),
    ...(servedByHost ? { served_by_host: servedByHost } : {}),
  };
}

async function resolveActivityAttachmentsForActivity(options: {
  homeDir?: string;
  codexSessionsRoot?: string;
  codexArchivedSessionsRoot?: string;
  claudeProjectsRoot?: string;
  calyxRunsRoot?: string;
  includeCalyxRuns?: boolean;
  host?: string;
  activityId: string;
  runActivityResolver?: RunActivityRecordResolver;
  now?: () => Date;
}): Promise<{
  session: ResolvedInteractiveActivity;
  parsed: ParsedSessionRead;
  activityRef: ActivityMessageActivityRef;
  attachments: ActivityAttachmentRecord[];
  turnIndexByMessageId: Map<string, number>;
  consumerAttachments: ActivityAttachmentRecord[];
  consumerTurnIndexByMessageId: Map<string, number>;
}> {
  const session = await resolveInteractiveActivity({
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.codexSessionsRoot ? { codexSessionsRoot: options.codexSessionsRoot } : {}),
    ...(options.codexArchivedSessionsRoot
      ? { codexArchivedSessionsRoot: options.codexArchivedSessionsRoot }
      : {}),
    ...(options.claudeProjectsRoot ? { claudeProjectsRoot: options.claudeProjectsRoot } : {}),
    ...(options.calyxRunsRoot ? { calyxRunsRoot: options.calyxRunsRoot } : {}),
    ...(options.includeCalyxRuns !== undefined ? { includeCalyxRuns: options.includeCalyxRuns } : {}),
    ...(options.host ? { host: options.host } : {}),
    activityId: options.activityId,
    ...(options.runActivityResolver ? { runActivityResolver: options.runActivityResolver } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const parsed = await readSessionEventsStreaming(session.session_path, session.backend);
  const activityRef = buildActivityRef(session);
  const assignment = assignTurnsToEvents(parsed.events, activityRef);
  const allMessages = parsed.events.map((event, index) =>
    projectEvent(event, activityRef, assignment.eventTurnIds[index]).message,
  );
  const turnIndexByMessageId = new Map<string, number>();
  const turns = buildActivityTurns(assignment, allMessages, activityRef, "complete");
  for (const turn of turns) {
    for (const message of turn.messages) {
      turnIndexByMessageId.set(message.id, turn.index);
    }
  }
  const consumerMessages = allMessages.filter((message) => message.visibility === "default");
  const consumerTurns = buildActivityTurnsFromMessages(
    consumerMessages,
    activityRef,
    "complete",
  );
  const consumerTurnIndexByMessageId = new Map<string, number>();
  for (const turn of consumerTurns) {
    for (const message of turn.messages) {
      consumerTurnIndexByMessageId.set(message.id, turn.index);
    }
  }
  return {
    session,
    parsed,
    activityRef,
    attachments: attachmentsForMessages(allMessages),
    turnIndexByMessageId,
    consumerAttachments: attachmentsForMessages(consumerMessages),
    consumerTurnIndexByMessageId,
  };
}

function filterActivityAttachments(
  attachments: ActivityAttachmentRecord[],
  selector: ActivityAttachmentsSelectorInput | undefined,
  turnIndexByMessageId: Map<string, number>,
): ActivityAttachmentRecord[] {
  let filtered = attachments;
  if (selector?.message_id) {
    filtered = filtered.filter((attachment) => attachment.message_id === selector.message_id);
  }
  if (typeof selector?.turn === "number") {
    filtered = filtered.filter((attachment) => turnIndexByMessageId.get(attachment.message_id) === selector.turn);
  }
  if (selector?.ref) {
    filtered = filtered.filter((attachment) => attachment.ref === selector.ref);
  }
  return filtered;
}

function attachmentRecordResult(
  attachment: ActivityAttachmentRecord,
  args: {
    session: ResolvedInteractiveActivity;
    sourceReceipt: ActivitySourceReadReceipt;
    sourceTier: ActivityAttachmentSourceTier;
    originHost?: string;
    servedByHost?: string;
  },
): ActivityAttachmentRecordResult {
  return {
    schema_version: "activity.attachment-record/v1",
    classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
    ...attachment,
    source_tier: requireActivityAttachmentSourceTier(args.sourceTier),
    source_locator: sourceLocatorForSession(args.session),
    ...(args.originHost ? { origin_host: args.originHost } : {}),
    ...(args.servedByHost ? { served_by_host: args.servedByHost } : {}),
    source_receipt: args.sourceReceipt,
  };
}

export interface InspectActivityAttachmentRecordOptions extends InteractiveActivityOptions {
  activityId: string;
  ref: string;
  servedByHost?: string;
  sourceTier?: ActivityAttachmentSourceTier;
  runActivityResolver?: RunActivityRecordResolver;
}

export async function inspectActivityAttachmentRecord(
  options: InspectActivityAttachmentRecordOptions,
): Promise<ActivityAttachmentRecordResult> {
  const expectedDigest = requireAttachmentDigest(options.ref, options.activityId);
  const resolved = await resolveActivityAttachmentsForActivity({
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.codexSessionsRoot ? { codexSessionsRoot: options.codexSessionsRoot } : {}),
    ...(options.codexArchivedSessionsRoot
      ? { codexArchivedSessionsRoot: options.codexArchivedSessionsRoot }
      : {}),
    ...(options.claudeProjectsRoot ? { claudeProjectsRoot: options.claudeProjectsRoot } : {}),
    ...(options.calyxRunsRoot ? { calyxRunsRoot: options.calyxRunsRoot } : {}),
    ...(options.includeCalyxRuns !== undefined ? { includeCalyxRuns: options.includeCalyxRuns } : {}),
    ...(options.host ? { host: options.host } : {}),
    activityId: options.activityId,
    ...(options.runActivityResolver ? { runActivityResolver: options.runActivityResolver } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const attachment = resolved.attachments.find((candidate) => candidate.sha256 === expectedDigest);
  if (!attachment) {
    throw new ActivityAttachmentError(
      "attachment_ref_unknown",
      `Activity ${resolved.activityRef.activity_id} does not contain attachment ref ${options.ref}.`,
      {
        details: {
          ref: options.ref,
          activity_id: resolved.activityRef.activity_id,
          searched_sources: [resolved.session.session_path],
        },
      },
    );
  }
  const originHost = attachmentOriginHost(resolved.session, options.host);
  return attachmentRecordResult(attachment, {
    session: resolved.session,
    sourceReceipt: resolved.parsed.sourceReceipt,
    sourceTier: options.sourceTier ?? "local-transcript",
    ...(originHost ? { originHost } : {}),
    ...(options.servedByHost ? { servedByHost: options.servedByHost } : originHost ? { servedByHost: originHost } : {}),
  });
}

export type ReadActivityAttachmentBytesOptions = InspectActivityAttachmentRecordOptions;

export async function readActivityAttachmentBytes(
  options: ReadActivityAttachmentBytesOptions,
): Promise<ActivityAttachmentBytesResult> {
  const record = await inspectActivityAttachmentRecord(options);
  const resolved = await resolveInteractiveActivity({
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.codexSessionsRoot ? { codexSessionsRoot: options.codexSessionsRoot } : {}),
    ...(options.codexArchivedSessionsRoot
      ? { codexArchivedSessionsRoot: options.codexArchivedSessionsRoot }
      : {}),
    ...(options.claudeProjectsRoot ? { claudeProjectsRoot: options.claudeProjectsRoot } : {}),
    ...(options.calyxRunsRoot ? { calyxRunsRoot: options.calyxRunsRoot } : {}),
    ...(options.includeCalyxRuns !== undefined ? { includeCalyxRuns: options.includeCalyxRuns } : {}),
    ...(options.host ? { host: options.host } : {}),
    activityId: options.activityId,
    ...(options.runActivityResolver ? { runActivityResolver: options.runActivityResolver } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const bytes = await decodeAttachmentBytesFromSource(resolved, record);
  return { record, bytes };
}

export interface InspectActivityAttachmentsOptions extends InteractiveActivityOptions {
  activityId: string;
  selector?: ActivityAttachmentsSelectorInput;
  /**
   * Consumer-profile authority boundary. When true, attachment metadata is
   * derived only from messages classified `visibility=default` before any
   * turn/message/ref selection. Admin callers omit this flag.
   */
  consumerVisibleOnly?: boolean;
  servedByHost?: string;
  sourceTier?: ActivityAttachmentSourceTier;
  runActivityResolver?: RunActivityRecordResolver;
}

export async function inspectActivityAttachments(
  options: InspectActivityAttachmentsOptions,
): Promise<ActivityAttachmentsResult> {
  const resolved = await resolveActivityAttachmentsForActivity({
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.codexSessionsRoot ? { codexSessionsRoot: options.codexSessionsRoot } : {}),
    ...(options.codexArchivedSessionsRoot
      ? { codexArchivedSessionsRoot: options.codexArchivedSessionsRoot }
      : {}),
    ...(options.claudeProjectsRoot ? { claudeProjectsRoot: options.claudeProjectsRoot } : {}),
    ...(options.calyxRunsRoot ? { calyxRunsRoot: options.calyxRunsRoot } : {}),
    ...(options.includeCalyxRuns !== undefined ? { includeCalyxRuns: options.includeCalyxRuns } : {}),
    ...(options.host ? { host: options.host } : {}),
    activityId: options.activityId,
    ...(options.runActivityResolver ? { runActivityResolver: options.runActivityResolver } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const attachmentSource = options.consumerVisibleOnly
    ? resolved.consumerAttachments
    : resolved.attachments;
  const turnIndexByMessageId = options.consumerVisibleOnly
    ? resolved.consumerTurnIndexByMessageId
    : resolved.turnIndexByMessageId;
  let attachments = filterActivityAttachments(attachmentSource, options.selector, turnIndexByMessageId);
  if (options.selector?.extract) {
    const outDir = options.selector.out_dir?.trim() || defaultAttachmentCacheDir(options.homeDir);
    const extracted: ActivityAttachmentRecord[] = [];
    for (const attachment of attachments) {
      const originHost = attachmentOriginHost(resolved.session, options.host);
      extracted.push(await extractAttachment(resolved.session, attachment, outDir, {
        ...(options.sourceTier ? { sourceTier: options.sourceTier } : {}),
        ...(originHost ? { originHost } : {}),
        ...(options.servedByHost ? { servedByHost: options.servedByHost } : {}),
      }));
    }
    attachments = extracted;
  }
  return {
    schema_version: "activity.attachments/v1",
    classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
    activity_id: resolved.activityRef.activity_id,
    backend: resolved.activityRef.backend,
    session_id: resolved.activityRef.session_id,
    session_path: resolved.activityRef.session_path,
    source_receipt: resolved.parsed.sourceReceipt,
    attachments,
    rollup: rollupAttachments(attachments),
  };
}

export interface ActivityEventSelectorInput {
  raw_role?: InteractiveSessionEventRole;
  tail?: number;
  around_id?: string;
  context?: number;
  classify?: boolean;
  within_turn?: boolean;
}

export class ActivityEventSelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivityEventSelectorError";
  }
}

function normalizeEventSelector(input: ActivityEventSelectorInput): ActivityEventsSelector {
  if (input.raw_role !== undefined) {
    if (!["user", "assistant", "tool", "system", "unknown"].includes(input.raw_role)) {
      throw new ActivityEventSelectorError(
        `Invalid --raw-role value "${input.raw_role}". Use one of: user, assistant, tool, system, unknown.`,
      );
    }
  }
  if (typeof input.tail === "number" && input.tail < 0) {
    throw new ActivityEventSelectorError("--tail must be a non-negative integer.");
  }
  if (typeof input.context === "number" && input.context < 0) {
    throw new ActivityEventSelectorError("--context must be a non-negative integer.");
  }
  if (typeof input.context === "number" && !input.around_id) {
    throw new ActivityEventSelectorError("--context requires --around-id.");
  }
  if (input.within_turn && !input.around_id) {
    throw new ActivityEventSelectorError("--within-turn requires --around-id.");
  }
  if (input.within_turn && typeof input.context === "number") {
    throw new ActivityEventSelectorError("--within-turn is mutually exclusive with --context.");
  }
  if (input.within_turn && typeof input.tail === "number") {
    throw new ActivityEventSelectorError("--within-turn is mutually exclusive with --tail.");
  }
  if (input.within_turn && input.raw_role !== undefined) {
    throw new ActivityEventSelectorError(
      "--within-turn returns the raw events for the containing turn; remove --raw-role.",
    );
  }
  return {
    ...(input.raw_role ? { raw_role: input.raw_role } : {}),
    ...(typeof input.tail === "number" ? { tail: input.tail } : {}),
    ...(input.around_id ? { around_id: input.around_id } : {}),
    ...(typeof input.context === "number" ? { context: input.context } : {}),
    ...(input.classify ? { classify: input.classify } : {}),
    ...(input.within_turn ? { within_turn: input.within_turn } : {}),
  };
}

function findEventByLineOrId(
  events: InteractiveSessionEventWithRaw[],
  activityId: string,
  identifier: string,
): number {
  const messageMatch = identifier.match(new RegExp(`^${escapeRegExp(activityId)}:msg:(\\d+)$`));
  if (messageMatch) {
    const lineNumber = Number.parseInt(messageMatch[1]!, 10);
    return events.findIndex((event) => event.line === lineNumber);
  }
  const numeric = Number.parseInt(identifier, 10);
  if (Number.isFinite(numeric) && /^\d+$/.test(identifier)) {
    const byLine = events.findIndex((event) => event.line === numeric);
    if (byLine >= 0) {
      return byLine;
    }
    return events.findIndex((event) => event.index === numeric);
  }
  return -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function eventsToEntries(
  events: InteractiveSessionEventWithRaw[],
  activityRef: ActivityMessageActivityRef,
  classify: boolean,
): ActivityEventEntry[] {
  return events.map((event) => {
    const base: ActivityEventEntry = {
      index: event.index,
      line: event.line,
      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
      role: event.role,
      kind: event.kind,
      ...(event.raw_type ? { raw_type: event.raw_type } : {}),
      summary: event.summary,
      ...(event.text ? { text: event.text } : {}),
      ...(event.redacted ? { redacted: event.redacted } : {}),
      ...(event.truncated ? { truncated: event.truncated } : {}),
    };
    if (!classify) {
      return base;
    }
    const outcome = classifySessionEvent(event);
    return {
      ...base,
      classification: {
        classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
        rule_id: outcome.rule_id,
        reason: outcome.reason,
        source_role: event.role,
        source_kind: event.kind,
        ...(event.raw_type ? { raw_type: event.raw_type } : {}),
        projected_role: outcome.role,
        visibility: outcome.visibility,
        message_id: makeMessageId(activityRef.activity_id, event.line),
      },
    };
  });
}

export interface InspectActivityEventsOptions extends InteractiveActivityOptions {
  activityId?: string;
  latestSession?: boolean;
  latestSessionBackend?: InteractiveSessionBackend;
  selector?: ActivityEventSelectorInput;
  runActivityResolver?: RunActivityRecordResolver;
}

export async function inspectActivityEvents(
  options: InspectActivityEventsOptions,
): Promise<ActivityEventsResult> {
  const session = await resolveInteractiveActivity({
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.codexSessionsRoot ? { codexSessionsRoot: options.codexSessionsRoot } : {}),
    ...(options.codexArchivedSessionsRoot
      ? { codexArchivedSessionsRoot: options.codexArchivedSessionsRoot }
      : {}),
    ...(options.claudeProjectsRoot ? { claudeProjectsRoot: options.claudeProjectsRoot } : {}),
    ...(options.calyxRunsRoot ? { calyxRunsRoot: options.calyxRunsRoot } : {}),
    ...(options.includeCalyxRuns !== undefined ? { includeCalyxRuns: options.includeCalyxRuns } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.activityId ? { activityId: options.activityId } : {}),
    ...(options.latestSession ? { latestSession: true } : {}),
    ...(options.latestSessionBackend ? { latestSessionBackend: options.latestSessionBackend } : {}),
    ...(options.runActivityResolver ? { runActivityResolver: options.runActivityResolver } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const selector = normalizeEventSelector(options.selector ?? {});
  const parsed = await readSessionEventsStreaming(session.session_path, session.backend);
  const activityRef = buildActivityRef(session);
  const turnAssignment = assignTurnsToEvents(parsed.events, activityRef);

  let filtered = parsed.events;
  if (selector.raw_role) {
    filtered = filtered.filter((event) => event.role === selector.raw_role);
  }

  const matchedCount = filtered.length;
  let chosen: InteractiveSessionEventWithRaw[];
  if (selector.within_turn) {
    // Within-turn: locate the anchor message/event, find its containing turn,
    // and return *all* raw events in that turn (ignoring --raw-role and the
    // visibility-filtered `filtered` slice — within-turn is for audit).
    const anchorIndex = findEventByLineOrId(parsed.events, activityRef.activity_id, selector.around_id!);
    if (anchorIndex >= 0) {
      const turnId = turnAssignment.eventTurnIds[anchorIndex];
      const turn = turnAssignment.turns.find((entry) => entry.turn_id === turnId);
      chosen = turn ? turn.eventIndexes.map((eventIndex) => parsed.events[eventIndex]!) : [];
    } else {
      chosen = [];
    }
  } else if (selector.around_id) {
    const matchIndex = findEventByLineOrId(filtered, activityRef.activity_id, selector.around_id);
    if (matchIndex >= 0) {
      const context = selector.context ?? DEFAULT_ACTIVITY_EVENTS_CONTEXT;
      chosen = filtered.slice(Math.max(matchIndex - context, 0), matchIndex + context + 1);
    } else {
      chosen = [];
    }
  } else if (typeof selector.tail === "number") {
    chosen = selector.tail > 0 ? filtered.slice(-selector.tail) : [];
  } else {
    chosen = filtered.slice(-DEFAULT_ACTIVITY_EVENTS_TAIL);
  }

  const classify = selector.classify ?? false;
  const entries = eventsToEntries(chosen, activityRef, classify);
  const now = options.now?.() ?? new Date();
  const sourceState = await probeSourceState(session.session_path, parsed.warnings, parsed.events, now);

  return {
    schema_version: "activity.events/v1",
    classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
    activity_id: activityRef.activity_id,
    ...runResolutionResultFields(session),
    backend: activityRef.backend,
    session_id: activityRef.session_id,
    session_path: activityRef.session_path,
    source: activityRef.source,
    ...(activityRef.cwd ? { cwd: activityRef.cwd } : {}),
    ...(activityRef.host ? { host: activityRef.host } : {}),
    source_state: sourceState,
    warnings: parsed.warnings,
    source_receipt: parsed.sourceReceipt,
    total_events: parsed.events.length,
    matched_events: matchedCount,
    returned_events: entries.length,
    truncated: entries.length < matchedCount,
    selector,
    events: entries,
  };
}

export interface ActivityTurnSelectorInput {
  role?: ActivityTurnRoleFilter;
  first?: number;
  last?: number;
  with_tools?: boolean;
  summary_only?: boolean;
  max_text_chars?: number;
  after_turn_index?: number;
}

export class ActivityTurnSelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivityTurnSelectorError";
  }
}

/** Split only on the final marker so canonical activity IDs may contain colons. */
export function parseActivityTurnId(turnId: string): ParsedActivitySourceId {
  return parseFinalActivitySourceId(
    turnId,
    ":turn:",
    "Turn",
    (message) => new ActivityTurnSelectorError(message),
  );
}

const DEFAULT_ACTIVITY_TURNS_LAST = 20;

function normalizeTurnSelector(input: ActivityTurnSelectorInput): ActivityTurnsSelector {
  if (input.role !== undefined && !ACTIVITY_TURN_ROLE_FILTERS.includes(input.role)) {
    throw new ActivityTurnSelectorError(
      `Invalid --role value "${input.role}". Use one of: ${ACTIVITY_TURN_ROLE_FILTERS.join(", ")}.`,
    );
  }
  if (typeof input.first === "number" && typeof input.last === "number") {
    throw new ActivityTurnSelectorError("--first and --last are mutually exclusive.");
  }
  if (typeof input.first === "number" && input.first < 0) {
    throw new ActivityTurnSelectorError("--first must be a non-negative integer.");
  }
  if (typeof input.last === "number" && input.last < 0) {
    throw new ActivityTurnSelectorError("--last must be a non-negative integer.");
  }
  if (typeof input.max_text_chars === "number" && input.max_text_chars < 0) {
    throw new ActivityTurnSelectorError("--max-text-chars must be a non-negative integer.");
  }
  if (typeof input.after_turn_index === "number" && (!Number.isInteger(input.after_turn_index) || input.after_turn_index < 0)) {
    throw new ActivityTurnSelectorError("after_turn_index must be a non-negative integer.");
  }
  return {
    ...(input.role ? { role: input.role } : {}),
    ...(typeof input.first === "number" ? { first: input.first } : {}),
    ...(typeof input.last === "number" ? { last: input.last } : {}),
    ...(input.with_tools ? { with_tools: input.with_tools } : {}),
    ...(input.summary_only ? { summary_only: input.summary_only } : {}),
    max_text_chars: input.max_text_chars ?? DEFAULT_ACTIVITY_MESSAGE_TEXT_CHARS,
    ...(typeof input.after_turn_index === "number" ? { after_turn_index: input.after_turn_index } : {}),
  };
}

function buildActivityTurns(
  assignment: TurnAssignment,
  allMessages: ActivityMessage[],
  activity: ActivityMessageActivityRef,
  sourceState: ActivitySourceState,
): ActivityTurn[] {
  const messagesByEventIndex = new Map<number, ActivityMessage>();
  for (const message of allMessages) {
    if (message.event_refs.length > 0) {
      messagesByEventIndex.set(message.event_refs[0]!, message);
    }
  }
  const turns: ActivityTurn[] = [];
  for (let t = 0; t < assignment.turns.length; t += 1) {
    const entry = assignment.turns[t]!;
    const turnMessages: ActivityMessage[] = [];
    for (const eventIndex of entry.eventIndexes) {
      const message = messagesByEventIndex.get(eventIndex);
      if (message) {
        turnMessages.push(message);
      }
    }
    const isLast = t === assignment.turns.length - 1;
    const state: ActivityTurnState = isLast && sourceState === "live" ? "in_flight" : "complete";
    const visibleMessages = turnMessages.filter((message) => message.visibility === "default");
    const toolCallCount = turnMessages.filter((message) => message.role === "tool_call").length;
    const toolResultCount = turnMessages.filter((message) => message.role === "tool_result").length;
    const attachmentRollup = rollupAttachments(attachmentsForMessages(turnMessages));
    const summarySource = visibleMessages[0] ?? turnMessages[0];
    const firstMessage = turnMessages[0];
    const lastMessage = turnMessages[turnMessages.length - 1];
    turns.push({
      turn_id: entry.turn_id,
      index: entry.index,
      activity_id: activity.activity_id,
      role: entry.role,
      state,
      ...(entry.startedAt ? { started_at: entry.startedAt } : {}),
      ...(entry.endedAt ? { ended_at: entry.endedAt } : {}),
      source_lines: [entry.startLine, entry.endLine],
      event_refs: [entry.startEventIndex, entry.endEventIndex],
      total_message_count: turnMessages.length,
      visible_message_count: visibleMessages.length,
      tool_call_count: toolCallCount,
      tool_result_count: toolResultCount,
      attachments: attachmentRollup,
      summary: summarySource?.summary ?? "(no messages)",
      ...(firstMessage ? { first_message_id: firstMessage.id } : {}),
      ...(lastMessage ? { last_message_id: lastMessage.id } : {}),
      messages: turnMessages,
    });
  }
  return turns;
}

function inferStoredTurnRole(messages: readonly ActivityMessage[]): ActivityTurnRole {
  if (messages.some((message) => message.role === "human")) {
    return "human";
  }
  if (messages.some((message) => (
    message.role === "assistant"
    || message.role === "tool_call"
    || message.role === "tool_result"
  ))) {
    return "assistant";
  }
  return "unknown";
}

function buildActivityTurnsFromMessages(
  allMessages: ActivityMessage[],
  activity: ActivityMessageActivityRef,
  sourceState: ActivitySourceState,
): ActivityTurn[] {
  const grouped: Array<{ turnId: string; messages: ActivityMessage[] }> = [];
  const byTurnId = new Map<string, { turnId: string; messages: ActivityMessage[] }>();
  for (const message of allMessages) {
    const turnId = message.turn_id ?? makeTurnId(activity.activity_id, message.source_lines[0] ?? 0);
    let group = byTurnId.get(turnId);
    if (!group) {
      group = { turnId, messages: [] };
      byTurnId.set(turnId, group);
      grouped.push(group);
    }
    group.messages.push(message);
  }

  return grouped.map((group, index) => {
    const turnMessages = group.messages;
    const isLast = index === grouped.length - 1;
    const state: ActivityTurnState = isLast && sourceState === "live" ? "in_flight" : "complete";
    const visibleMessages = turnMessages.filter((message) => message.visibility === "default");
    const toolCallCount = turnMessages.filter((message) => message.role === "tool_call").length;
    const toolResultCount = turnMessages.filter((message) => message.role === "tool_result").length;
    const attachmentRollup = rollupAttachments(attachmentsForMessages(turnMessages));
    const summarySource = visibleMessages[0] ?? turnMessages[0];
    const firstMessage = turnMessages[0];
    const lastMessage = turnMessages[turnMessages.length - 1];
    const sourceLines = turnMessages.flatMap((message) => message.source_lines);
    const eventRefs = turnMessages.flatMap((message) => message.event_refs);
    const timestamps = turnMessages
      .map((message) => message.timestamp)
      .filter((timestamp): timestamp is string => typeof timestamp === "string" && timestamp.length > 0);
    return {
      turn_id: group.turnId,
      index,
      activity_id: activity.activity_id,
      role: inferStoredTurnRole(turnMessages),
      state,
      ...(timestamps[0] ? { started_at: timestamps[0] } : {}),
      ...(timestamps[timestamps.length - 1] ? { ended_at: timestamps[timestamps.length - 1] } : {}),
      source_lines: [
        sourceLines.length > 0 ? Math.min(...sourceLines) : 0,
        sourceLines.length > 0 ? Math.max(...sourceLines) : 0,
      ],
      event_refs: [
        eventRefs.length > 0 ? Math.min(...eventRefs) : 0,
        eventRefs.length > 0 ? Math.max(...eventRefs) : 0,
      ],
      total_message_count: turnMessages.length,
      visible_message_count: visibleMessages.length,
      tool_call_count: toolCallCount,
      tool_result_count: toolResultCount,
      attachments: attachmentRollup,
      summary: summarySource?.summary ?? "(no messages)",
      ...(firstMessage ? { first_message_id: firstMessage.id } : {}),
      ...(lastMessage ? { last_message_id: lastMessage.id } : {}),
      messages: turnMessages,
    };
  });
}

function isTerminalRunResolution(session: ResolvedInteractiveActivity): boolean {
  const state = session.runActivityResolution?.run_state;
  return Boolean(state && state !== "queued" && state !== "dispatching" && state !== "running");
}

function applyTurnsSelector(
  turns: ActivityTurn[],
  selector: ActivityTurnsSelector,
): { matched: ActivityTurn[]; returned: ActivityTurn[] } {
  let filtered = turns;
  const roleFilter = selector.role ?? "all";
  if (roleFilter !== "all") {
    filtered = filtered.filter((turn) => turn.role === roleFilter);
  }
  const matched = filtered;
  if (typeof selector.after_turn_index === "number") {
    filtered = filtered.filter((turn) => turn.index > selector.after_turn_index!);
  }
  let returned: ActivityTurn[];
  if (typeof selector.first === "number") {
    returned = filtered.slice(0, selector.first);
  } else if (typeof selector.last === "number") {
    returned = selector.last > 0 ? filtered.slice(-selector.last) : [];
  } else {
    returned = filtered.slice(-DEFAULT_ACTIVITY_TURNS_LAST);
  }
  return { matched, returned };
}

function decorateTurns(turns: ActivityTurn[], selector: ActivityTurnsSelector): ActivityTurn[] {
  return turns.map((turn) => {
    let visible = turn.messages.filter((message) => {
      if (message.visibility === "default") return true;
      if (selector.with_tools && (message.role === "tool_call" || message.role === "tool_result")) {
        return true;
      }
      return false;
    });
    const maxChars = selector.max_text_chars ?? DEFAULT_ACTIVITY_MESSAGE_TEXT_CHARS;
    visible = visible.map((message) => applyTextProjection(message, maxChars));
    if (selector.summary_only) {
      visible = visible.map((message) => summaryOnlyMessage(message));
    }
    return { ...turn, messages: visible };
  });
}

export interface InspectActivityTurnsOptions extends InteractiveActivityOptions {
  activityId?: string;
  latestSession?: boolean;
  latestSessionBackend?: InteractiveSessionBackend;
  selector?: ActivityTurnSelectorInput;
  /**
   * Consumer-profile authority boundary. When true, default-visible messages
   * are the sole input to turn grouping, counts, ordering, and selection.
   * Admin callers omit this flag.
   */
  consumerVisibleOnly?: boolean;
  runActivityResolver?: RunActivityRecordResolver;
}

export async function inspectActivityTurns(
  options: InspectActivityTurnsOptions,
): Promise<ActivityTurnsResult> {
  const session = await resolveInteractiveActivity({
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.codexSessionsRoot ? { codexSessionsRoot: options.codexSessionsRoot } : {}),
    ...(options.codexArchivedSessionsRoot
      ? { codexArchivedSessionsRoot: options.codexArchivedSessionsRoot }
      : {}),
    ...(options.claudeProjectsRoot ? { claudeProjectsRoot: options.claudeProjectsRoot } : {}),
    ...(options.calyxRunsRoot ? { calyxRunsRoot: options.calyxRunsRoot } : {}),
    ...(options.includeCalyxRuns !== undefined ? { includeCalyxRuns: options.includeCalyxRuns } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.activityId ? { activityId: options.activityId } : {}),
    ...(options.latestSession ? { latestSession: true } : {}),
    ...(options.latestSessionBackend ? { latestSessionBackend: options.latestSessionBackend } : {}),
    ...(options.runActivityResolver ? { runActivityResolver: options.runActivityResolver } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const selector = normalizeTurnSelector(options.selector ?? {});
  const parsed = await readSessionEventsStreaming(session.session_path, session.backend);
  const activityRef = buildActivityRef(session);
  const assignment = assignTurnsToEvents(parsed.events, activityRef);
  const allMessages = parsed.events.map((event, index) =>
    projectEvent(event, activityRef, assignment.eventTurnIds[index], { preserveFullText: true }).message,
  );
  const projectedMessages = options.consumerVisibleOnly
    ? allMessages.filter((message) => message.visibility === "default")
    : allMessages;
  const now = options.now?.() ?? new Date();
  const sourceState = await probeSourceState(session.session_path, parsed.warnings, parsed.events, now);
  const effectiveSourceState = isTerminalRunResolution(session) ? "complete" : sourceState;
  const builtTurns = options.consumerVisibleOnly
    ? buildActivityTurnsFromMessages(projectedMessages, activityRef, effectiveSourceState)
    : buildActivityTurns(assignment, projectedMessages, activityRef, effectiveSourceState);
  const { matched, returned } = applyTurnsSelector(builtTurns, selector);
  const hydrated = selector.summary_only ? returned : await hydrateReturnedTurnText(session, returned);
  const decorated = decorateTurns(hydrated, selector);

  return {
    schema_version: "activity.turns/v1",
    classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
    activity_id: activityRef.activity_id,
    ...runResolutionResultFields(session),
    backend: activityRef.backend,
    session_id: activityRef.session_id,
    session_path: activityRef.session_path,
    source: activityRef.source,
    ...(activityRef.cwd ? { cwd: activityRef.cwd } : {}),
    ...(activityRef.host ? { host: activityRef.host } : {}),
    source_state: sourceState,
    warnings: parsed.warnings,
    source_receipt: parsed.sourceReceipt,
    total_events: parsed.events.length,
    total_messages: projectedMessages.length,
    total_turns: builtTurns.length,
    matched_turns: matched.length,
    returned_turns: decorated.length,
    truncated: decorated.length < matched.length,
    selector,
    turns: decorated,
  };
}

export interface InspectActivityTurnsFromStoreOptions {
  session: ResolvedInteractiveActivity;
  rows: readonly ActivityMessageRow[];
  attachmentRows: readonly ActivityAttachmentRow[];
  cursor?: ActivitySourceCursorRow | undefined;
  selector?: ActivityTurnSelectorInput;
  consumerVisibleOnly?: boolean;
  now?: () => Date;
}

export function inspectActivityTurnsFromStore(
  options: InspectActivityTurnsFromStoreOptions,
): ActivityTurnsResult | undefined {
  const selector = normalizeTurnSelector(options.selector ?? {});
  const activityRef = storedActivityRef(options.session, options.rows);
  const allMessages = messagesFromStoredRows(activityRef, options.rows, options.attachmentRows);
  if (!allMessages) {
    return undefined;
  }
  const projectedMessages = options.consumerVisibleOnly
    ? allMessages.filter((message) => message.visibility === "default")
    : allMessages;
  const baseState = sourceStateFromStoredRows(
    options.session,
    options.rows,
    options.now?.() ?? new Date(),
  );
  const builtTurns = buildActivityTurnsFromMessages(
    projectedMessages,
    activityRef,
    isTerminalRunResolution(options.session) ? "complete" : baseState.sourceState,
  );
  const { matched, returned } = applyTurnsSelector(builtTurns, selector);
  const decorated = decorateTurns(returned, selector);

  return {
    schema_version: "activity.turns/v1",
    classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
    activity_id: activityRef.activity_id,
    ...runResolutionResultFields(options.session),
    backend: activityRef.backend,
    session_id: activityRef.session_id,
    session_path: activityRef.session_path,
    source: activityRef.source,
    ...(activityRef.cwd ? { cwd: activityRef.cwd } : {}),
    ...(activityRef.host ? { host: activityRef.host } : {}),
    source_state: baseState.sourceState,
    warnings: baseState.warnings,
    source_receipt: storedSourceReceipt(options.rows, options.cursor),
    total_events: options.rows.length,
    total_messages: projectedMessages.length,
    total_turns: builtTurns.length,
    matched_turns: matched.length,
    returned_turns: decorated.length,
    truncated: decorated.length < matched.length,
    selector,
    turns: decorated,
  };
}

// Re-export for tests / external probing.
export type { InteractiveSessionInspectOptions };
// Tests use this synchronous helper to validate classification of a single event.
export function classifyEventForTesting(event: InteractiveSessionEvent): ClassificationOutcome {
  return classifySessionEvent(event as InteractiveSessionEventWithRaw);
}
