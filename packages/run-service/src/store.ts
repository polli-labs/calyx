import { randomUUID } from "node:crypto";
import { access, link, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { agentTerminalEvidenceSchema, lifecycleEventSchema } from "@polli-labs/calyx-runner";
import type { RunState, SupportedBackend } from "@polli-labs/calyx-runner";
import { z } from "zod";
import type {
  ApiProvenanceV1,
  EventLogIngest,
  IngestOutcome,
  RunIndexProjection,
  RunIndexRow,
} from "@polli-labs/calyx-core";
import {
  CALYX_HTTP_DEFAULT_JSON_RESPONSE_MAX_BYTES,
  CALYX_HTTP_SSE_MAX_FRAME_BYTES,
  hashCanonicalJcs,
  encodeCalyxSseFrameData,
  isCanonicalApiTimestamp,
  loadStateDriver,
  RunIndexMembershipFingerprintMismatchError,
  validateApiProvenance,
  withSqliteBusyRetry,
  withSqliteMutex,
} from "@polli-labs/calyx-core";
import type { StateDriverDatabase } from "@polli-labs/calyx-core";
import type {
  CalyxRunEventFilter,
  CalyxStreamEvent,
  ExecutionReceipt,
  IntegrationStatus,
  RecordedRunEvent,
  ReconcileResult,
  ResolvedExecutionSpec,
  ResolvedRunSpec,
  NonCanonicalRunDirectoryDisposition,
  RunCancellationRequest,
  RunIntent,
  RunLaunchMode,
  RunListEntry,
  RunTerminalProjection,
  RunRecord,
  RunTerminalEvent,
} from "./types.js";
import {
  GLOBAL_EVENT_CURSOR_ORDINAL_WIDTH,
  isAllocatedGlobalEventCursor,
  isCalyxRunEvent,
  isCalyxStreamEvent,
  isGlobalEventCursor,
  isRunTerminalEvent,
  parseCalyxStreamEvent,
} from "./types.js";

export const EVENTS_INDEX_FILENAME = "events.index.jsonl";
/**
 * Legacy authority can contain rows admitted before the 1 MiB SSE frame law;
 * those rows remain readable so delivery can project a bounded gap. Keep the
 * physical receipt ceiling finite, but deliberately above the delivery limit.
 */
export const EVENT_JOURNAL_MAX_LINE_BYTES = CALYX_HTTP_DEFAULT_JSON_RESPONSE_MAX_BYTES;
const LEGACY_GLOBAL_PROJECTION_TAIL_MAX_BYTES = 8 * 1024 * 1024;

const agentProgressSignalSchema = z.object({
  source: z.enum(["claude_stream", "adapter_activity"]),
  status: z.enum(["available", "unavailable", "failed"]),
  reason: z.enum([
    "awaiting_first_signal",
    "stream_initialized",
    "semantic_event",
    "no_structured_events",
    "malformed_stream",
    "spawn_failed",
    "adapter_activity",
  ]),
  expected_silence_until: z.string().datetime().optional(),
}).strict();

const runTerminalProjectionSchema = z.object({
  evidence: agentTerminalEvidenceSchema,
}).strip();

function isJsonBoundaryWhitespaceOnly(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d && codePoint !== 0x20) {
      return false;
    }
  }
  return true;
}

export function legacyLaunchAdmissionIdentity(runId: string, requestHash: string): string {
  return hashCanonicalJcs({
    domain: "calyx.legacy-run-launch/v1",
    run_id: runId,
    request_hash: requestHash,
  });
}

export function hasSynthesizedLegacyAdmission(record: RunRecord): boolean {
  return record.launch.admission_identity === legacyLaunchAdmissionIdentity(
    record.run_id,
    record.launch.request_hash,
  );
}

const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  "succeeded",
  "failed",
  "partial",
  "cancelled",
  "auth_error",
  "infra_error",
  "completed_dirty",
]);

export interface RunPaths {
  runDir: string;
  specPath: string;
  kernelReceiptPath: string;
  runRecordPath: string;
  cancellationPath: string;
  effectAdmissionMutexPath: string;
  dispatchMutexPath: string;
  executionMutexPath: string;
  finalizationMutexPath: string;
  eventsPath: string;
  integrationsPath: string;
}

export interface RunListPageOptions {
  host?: string | undefined;
  backend?: SupportedBackend | undefined;
  updated_since?: string | undefined;
  created_since?: string | undefined;
  created_before?: string | undefined;
  after?: { created_at: string; run_id: string } | undefined;
  expected_membership_fence?: string | undefined;
  limit: number;
}

export interface RunListSnapshotPage {
  entries: RunListEntry[];
  membershipFence: string;
}

export class RunListSnapshotChangedError extends Error {
  readonly code = "list_snapshot_changed";
  readonly retryable = true;

  constructor(message = "List membership changed after the seek-page snapshot was established.") {
    super(message);
    this.name = "RunListSnapshotChangedError";
  }
}

export class RunIndexProjectionNotReadyError extends Error {
  readonly code = "activity_projection_not_ready";
  readonly retryable = true;

  constructor(readonly reason: string) {
    super(`Run-index projection is not ready for bounded snapshot pagination: ${reason}`);
    this.name = "RunIndexProjectionNotReadyError";
  }
}

const RUN_LIST_MEMBERSHIP_FENCE_PREFIX = "run-list-membership:v3:";

function parseRunIndexMembershipFence(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^run-list-membership:v3:([0-9a-f]{32}:(?:0|[1-9][0-9]*):[0-9a-f]{32}:[0-9a-f]{64})$/u.exec(value);
  if (!match) throw new RunListSnapshotChangedError("List cursor membership fence is invalid.");
  return match[1]!;
}

function formatRunIndexMembershipFence(fingerprint: string): string {
  if (!/^[0-9a-f]{32}:(?:0|[1-9][0-9]*):[0-9a-f]{32}:[0-9a-f]{64}$/u.test(fingerprint)) {
    throw new Error("Run-index membership checkpoint is malformed.");
  }
  return `${RUN_LIST_MEMBERSHIP_FENCE_PREFIX}${fingerprint}`;
}

export type RunIndexRepairOutcome =
  | { status: "repaired"; rowCount: number }
  | { status: "not_configured" }
  | { status: "failed"; reason: string };

function parseShortHostname(input: string): string {
  return input.trim().toLowerCase().replace(/\..*$/, "");
}

export function isTerminalState(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

export function legacyDeadSettlementAuthorityId(
  record: RunRecord,
  pid: number,
): string {
  return hashCanonicalJcs({
    domain: "calyx.legacy-owner-free-settlement/v1",
    run_id: record.run_id,
    admission_identity: record.launch.admission_identity,
    request_hash: record.launch.request_hash,
    dispatch_attempts: record.launch.dispatch_attempts,
    last_dispatch_at: record.launch.last_dispatch_at ?? null,
    execution_id: record.launch.execution_id ?? null,
    authority: "legacy_pid_dead",
    legacy_pid: pid,
  });
}

export function hasLegacyDeadSettlement(record: RunRecord): boolean {
  try {
    const settlement = record.recovery.owner_free_settlement;
    return settlement?.schema_version === "calyx.owner-free-settlement/v1"
      && settlement.authority === "legacy_pid_dead"
      && settlement.reason_code === "legacy_detached_worker_observed_dead"
      && isCanonicalApiTimestamp(settlement.settled_at)
      && Number.isSafeInteger(settlement.legacy_pid)
      && settlement.legacy_pid > 0
      && settlement.authority_id === legacyDeadSettlementAuthorityId(
        record,
        settlement.legacy_pid,
      );
  } catch {
    return false;
  }
}

export function legacyResourceSettlementAuthorityId(
  record: RunRecord,
  processGroupId: number,
): string {
  return hashCanonicalJcs({
    domain: "calyx.legacy-resource-settlement/v1",
    run_id: record.run_id,
    admission_identity: record.launch.admission_identity,
    request_hash: record.launch.request_hash,
    owner_free_authority_id: record.recovery.owner_free_settlement?.authority_id ?? null,
    authority: "legacy_process_group_extinct",
    legacy_process_group_id: processGroupId,
  });
}

export function hasLegacyResourceSettlement(record: RunRecord): boolean {
  try {
    const settlement = record.recovery.resource_settlement;
    return hasLegacyDeadSettlement(record)
      && settlement?.schema_version === "calyx.resource-settlement/v1"
      && settlement.status === "settled"
      && settlement.authority === "legacy_process_group_extinct"
      && settlement.reason_code === "legacy_detached_process_group_observed_extinct"
      && isCanonicalApiTimestamp(settlement.settled_at)
      && Number.isSafeInteger(settlement.legacy_process_group_id)
      && settlement.legacy_process_group_id > 0
      && settlement.legacy_process_group_id === record.recovery.owner_free_settlement?.legacy_pid
      && settlement.authority_id === legacyResourceSettlementAuthorityId(
        record,
        settlement.legacy_process_group_id,
      );
  } catch {
    return false;
  }
}

/**
 * Publisher terminality and resource terminality are deliberately separate.
 * Historical direct workers can stop publishing while an inherited process
 * group still owns the worktree. Consumers that mutate or remove run
 * resources must require this guard in addition to `isTerminalState`.
 */
export function isRunResourceTerminal(
  record: RunRecord,
  options: { validatedLegacyReceipt?: boolean | undefined } = {},
): boolean {
  const recovery = record.recovery as unknown;
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) {
    return false;
  }
  const candidate = recovery as Record<string, unknown>;
  const hasOwnerMarker = candidate["owner_free_settlement"] !== undefined;
  const hasResourceMarker = candidate["resource_settlement"] !== undefined;
  if (!hasOwnerMarker && !hasResourceMarker) {
    // Current launch generations own their terminal resource projection.
    // A synthesized legacy generation does not: RunService must first prove
    // that an exact durable receipt corresponds to the embedded terminal
    // projection. Consumers without that proof fail closed.
    return !hasSynthesizedLegacyAdmission(record)
      || options.validatedLegacyReceipt === true;
  }
  return hasLegacyResourceSettlement(record);
}

export function runRecordIdentityMismatch(runId: string, record: RunRecord): string | undefined {
  if (record.run_id !== runId) return `record.run_id=${record.run_id}`;
  if (record.intent.run_id !== runId) return `record.intent.run_id=${record.intent.run_id}`;
  if (record.spec && record.spec.run_id !== runId) return `record.spec.run_id=${record.spec.run_id}`;
  if (!record.kernel_receipt) return undefined;
  const receipt = record.kernel_receipt as unknown;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return "record.kernel_receipt=<malformed>";
  }
  const candidate = receipt as Record<string, unknown>;
  if (candidate["run_id"] !== runId) return `record.kernel_receipt.run_id=${String(candidate["run_id"])}`;
  for (const key of ["run_spec", "artifacts"] as const) {
    if (!(key in candidate)) continue;
    const nested = candidate[key];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
      return `record.kernel_receipt.${key}=<malformed>`;
    }
    const nestedRunId = (nested as Record<string, unknown>)["run_id"];
    if (nestedRunId !== runId) {
      return `record.kernel_receipt.${key}.run_id=${String(nestedRunId)}`;
    }
  }
  return undefined;
}

export function assertRunRecordIdentity(runId: string, record: RunRecord): void {
  const mismatch = runRecordIdentityMismatch(runId, record);
  if (mismatch) {
    throw new Error(`Run directory ${runId} contains mismatched record identity: ${mismatch}.`);
  }
}

export function defaultRunsRoot(): string {
  const fromEnv = process.env["CALYX_RUNS_ROOT"];
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv.trim());
  }
  return path.join(homedir(), ".calyx", "runs");
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

interface Utf8LineStreamSummary {
  byteCount: number;
  lineCount: number;
  endsWithNewline: boolean;
  missing: boolean;
}

/**
 * Consume one physical JSONL generation without normalizing malformed UTF-8.
 * The byte stream is incremental, so a code point split across filesystem
 * chunks is retained until its physical line is complete. Fatal decoding then
 * rejects malformed or truncated bytes at that exact line. Only the current
 * unterminated line is retained.
 */
async function consumeFatalUtf8Lines(
  filePath: string,
  consume: (
    rawLine: string,
    lineNumber: number,
    terminated: boolean,
  ) => Promise<void> | void,
  options: { skipInvalidRows?: boolean } = {},
): Promise<Utf8LineStreamSummary> {
  const handle = await open(filePath, "r").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!handle) {
    return { byteCount: 0, lineCount: 0, endsWithNewline: true, missing: true };
  }

  const input = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
  let byteCount = 0;
  let lineCount = 0;
  let pendingChunks: Buffer[] = [];
  let pendingByteCount = 0;
  let discardingOversizedLine = false;
  let endsWithNewline = true;

  const consumeLine = async (lineBytes: Buffer, terminated: boolean): Promise<void> => {
    lineCount += 1;
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes);
    } catch (error) {
      if (options.skipInvalidRows) return;
      throw new EventJournalCorruptionError(filePath, lineCount, error);
    }
    await consume(decoded, lineCount, terminated);
  };

  const assertLineWithinLimit = (lineBytes: number): boolean => {
    if (lineBytes > EVENT_JOURNAL_MAX_LINE_BYTES) {
      if (options.skipInvalidRows) return false;
      throw new EventJournalCorruptionError(
        filePath,
        lineCount + 1,
        `physical journal row exceeds ${EVENT_JOURNAL_MAX_LINE_BYTES} byte limit`,
      );
    }
    return true;
  };

  const consumePendingLine = async (tail: Buffer, terminated: boolean): Promise<void> => {
    const lineBytes = pendingByteCount + tail.byteLength;
    if (!assertLineWithinLimit(lineBytes)) {
      pendingChunks = [];
      pendingByteCount = 0;
      lineCount += 1;
      return;
    }
    const line = pendingByteCount === 0
      ? tail
      : Buffer.concat([...pendingChunks, tail], lineBytes);
    pendingChunks = [];
    pendingByteCount = 0;
    await consumeLine(line, terminated);
  };

  const consumeChunk = async (chunk: Buffer): Promise<void> => {
    let start = 0;
    let boundary = chunk.indexOf(0x0a, start);
    while (boundary >= 0) {
      if (discardingOversizedLine) {
        lineCount += 1;
        discardingOversizedLine = false;
      } else {
        await consumePendingLine(chunk.subarray(start, boundary), true);
      }
      start = boundary + 1;
      boundary = chunk.indexOf(0x0a, start);
    }
    const tail = chunk.subarray(start);
    if (tail.byteLength > 0 && !discardingOversizedLine) {
      if (!assertLineWithinLimit(pendingByteCount + tail.byteLength)) {
        pendingChunks = [];
        pendingByteCount = 0;
        discardingOversizedLine = true;
        return;
      }
      pendingChunks.push(Buffer.from(tail));
      pendingByteCount += tail.byteLength;
    }
  };

  try {
    for await (const rawChunk of input) {
      const chunk = rawChunk as Buffer;
      byteCount += chunk.byteLength;
      if (chunk.byteLength > 0) endsWithNewline = chunk.at(-1) === 0x0a;
      await consumeChunk(chunk);
    }
    if (discardingOversizedLine) {
      lineCount += 1;
    } else if (pendingByteCount > 0) {
      await consumePendingLine(Buffer.alloc(0), false);
    }
    return { byteCount, lineCount, endsWithNewline, missing: false };
  } finally {
    input.destroy();
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function ensureDurableDirectory(directoryPath: string): Promise<void> {
  const missing: string[] = [];
  let candidate = path.resolve(directoryPath);
  while (true) {
    try {
      await stat(candidate);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(candidate);
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  for (const directory of missing.reverse()) {
    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await syncDirectory(path.dirname(directory));
  }
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureDurableDirectory(directory);
  const temporaryPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  let preparationError: unknown;
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    preparationError = error;
  } finally {
    await handle.close();
  }
  if (preparationError) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw preparationError;
  }
  try {
    await rename(temporaryPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function replaceJsonLinesFileWithQuarantine(
  filePath: string,
  quarantinedPath: string,
  writeReplacement: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>,
): Promise<boolean> {
  const directory = path.dirname(filePath);
  await ensureDurableDirectory(directory);
  const temporaryPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  let preparationError: unknown;
  try {
    await writeReplacement(handle);
    await handle.sync();
  } catch (error) {
    preparationError = error;
  } finally {
    await handle.close();
  }
  if (preparationError) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw preparationError;
  }
  let quarantined = false;
  try {
    // Preserve the corrupt inode first without removing the live path. The
    // prepared replacement then atomically swaps over it, so a crash observes
    // either the old journal or the complete replacement, never an absent or
    // partially written active generation.
    try {
      await link(filePath, quarantinedPath);
      quarantined = true;
      await syncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(temporaryPath, filePath);
    await syncDirectory(directory);
    return quarantined;
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeJsonLineToHandle(
  handle: Awaited<ReturnType<typeof open>>,
  row: unknown,
): Promise<void> {
  const bytes = serializeBoundedEventJournalRow(row);
  await writeBufferToHandle(handle, bytes, null);
}

function serializeBoundedEventJournalRow(row: unknown): Buffer {
  const serialized = JSON.stringify(row);
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > EVENT_JOURNAL_MAX_LINE_BYTES) {
    throw new Error(
      `event journal row exceeds ${EVENT_JOURNAL_MAX_LINE_BYTES} byte limit`,
    );
  }
  return Buffer.from(`${serialized}\n`, "utf8");
}

async function writeBufferToHandle(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
  position: number | null,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const written = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      position === null ? null : position + offset,
    );
    if (written.bytesWritten === 0) throw new Error("File write made no progress.");
    offset += written.bytesWritten;
  }
}

// Per-run lifecycle and run-service rows are legacy schema-less records, not
// rolling-open global stream envelopes. Keep their authority-bearing top level
// closed and use `payload` as the sole additive extension channel. Repair may
// omit an invalid top-level addition from the active projection only after the
// exact source journal generation has been preserved in quarantine.
const runServiceJournalEventSchema = z.object({
  timestamp: z.string().datetime(),
  run_id: z.string().min(1),
  source: z.literal("run-service"),
  event: z.enum([
    "intent_persisted",
    "launch_intent",
    "launch_result",
    "spec_persisted",
    "launch_dispatched",
    "launch_started",
    "launch_completed",
    "integration_started",
    "integration_finished",
    "handback_emitted",
    "handback_withheld",
    "stop_intent",
    "stop_result",
    "reconcile_intent",
    "reconcile_result",
    "reconciled",
    "warning",
  ]),
  message: z.string(),
  provenance: z.unknown().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
}).strict();

const localRunJournalEventSchema = z.union([
  runServiceJournalEventSchema,
  lifecycleEventSchema.strict(),
]);

export class RunCreationConflictError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`Run ${runId} already has an authoritative creation record.`);
    this.name = "RunCreationConflictError";
    this.runId = runId;
  }
}

export class EventJournalCorruptionError extends Error {
  readonly filePath: string;
  readonly lineNumber: number;

  constructor(filePath: string, lineNumber: number, cause: unknown) {
    super(
      `Event journal ${filePath} contains invalid JSON or event schema at line ${lineNumber}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "EventJournalCorruptionError";
    this.filePath = filePath;
    this.lineNumber = lineNumber;
  }
}

export class EventJournalEventIdentityConflictError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`Global event ${eventId} conflicts with the payload already committed under that event_id.`);
    this.name = "EventJournalEventIdentityConflictError";
    this.eventId = eventId;
  }
}

export class EventSseFrameTooLargeError extends Error {
  readonly eventId: string;
  readonly frameBytes: number;
  readonly maximumBytes: number;

  constructor(eventId: string, frameBytes: number, maximumBytes: number) {
    super(
      `Global event ${eventId} would produce a ${frameBytes}-byte SSE frame; the limit is ${maximumBytes} bytes.`,
    );
    this.name = "EventSseFrameTooLargeError";
    this.eventId = eventId;
    this.frameBytes = frameBytes;
    this.maximumBytes = maximumBytes;
  }
}

class PerRunEventProjectionIdentityConflictError extends EventJournalCorruptionError {
  readonly eventId: string;

  constructor(filePath: string, lineNumber: number, eventId: string) {
    super(filePath, lineNumber, new EventJournalEventIdentityConflictError(eventId));
    this.name = "PerRunEventProjectionIdentityConflictError";
    this.eventId = eventId;
  }
}

class PerRunEventProjectionOrderError extends EventJournalCorruptionError {
  constructor(filePath: string, lineNumber: number, detail: string) {
    super(filePath, lineNumber, detail);
    this.name = "PerRunEventProjectionOrderError";
  }
}

export type EventReplayCursorErrorReason = "malformed" | "unknown" | "future";

export class EventReplayCursorError extends Error {
  readonly cursor: string;
  readonly reason: EventReplayCursorErrorReason;

  constructor(cursor: string, reason: EventReplayCursorErrorReason) {
    super(`Global event replay cursor is ${reason}: ${cursor}`);
    this.name = "EventReplayCursorError";
    this.cursor = cursor;
    this.reason = reason;
  }
}

export class EventAuthorityNotPreparedError extends Error {
  constructor() {
    super("Global event authority is not prepared; call prepareGlobalEventAuthority() at startup.");
    this.name = "EventAuthorityNotPreparedError";
  }
}

interface GlobalEventAuthorityRow {
  ordinal: number | bigint;
  event_id: string;
  cursor: string;
  event_type: string;
  run_id: string | null;
  supersedes_event_id?: string | null;
  identity_hash: string;
  event_json: string;
  receipt_written: number | bigint;
  run_receipt_written: number | bigint;
}

interface GlobalEventAuthorityPaths {
  physicalRoot: string;
  databasePath: string;
  mutationMutexPath: string;
  receiptMutexPath: string;
}

export const RUN_ID_PATTERN_SOURCE = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$";
const RUN_ID_PATTERN = new RegExp(RUN_ID_PATTERN_SOURCE);
const NON_CANONICAL_RUN_ID_REASON =
  "run_id must be 1-256 ASCII letters, digits, dot, underscore, colon, or hyphen; it must start with a letter or digit";
const CANONICAL_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCanonicalHash(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_HASH_PATTERN.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && ISO_TIMESTAMP_PATTERN.test(value)
    && Number.isFinite(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRunLaunchMode(value: unknown): value is RunLaunchMode {
  return value === "inline" || value === "detached";
}

function isRunLaunchStage(value: unknown): value is RunRecord["launch"]["stage"] {
  return value === "accepted" || value === "dispatching" || value === "executing";
}

function isHostProcessExecutionBinding(
  value: unknown,
  executionId: string | undefined,
): value is NonNullable<RunRecord["launch"]["host_process_execution_binding"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate["schema_version"] === "calyx.host-process-execution-binding/v1"
    && typeof executionId === "string"
    && candidate["execution_id"] === executionId
    && typeof candidate["salt"] === "string"
    && /^[A-Za-z0-9_-]{43}$/u.test(candidate["salt"])
    && isCanonicalHash(candidate["commitment_sha256"]);
}

function isCompleteRunLaunchState(
  launch: Partial<RunRecord["launch"]> | undefined,
): launch is RunRecord["launch"] {
  return Boolean(
    launch
    && isRunLaunchMode(launch.mode)
    && isRunLaunchStage(launch.stage)
    && (launch.incarnation_id === undefined || isNonEmptyString(launch.incarnation_id))
    && isCanonicalHash(launch.admission_identity)
    && isCanonicalHash(launch.request_hash)
    && isIsoTimestamp(launch.accepted_at)
    && isNonNegativeInteger(launch.dispatch_attempts)
    && (launch.last_dispatch_at === undefined || isIsoTimestamp(launch.last_dispatch_at))
    && (launch.execution_id === undefined || isNonEmptyString(launch.execution_id))
    && (launch.execution_started_at === undefined || isIsoTimestamp(launch.execution_started_at))
    && (
      launch.host_process_execution_binding === undefined
      || isHostProcessExecutionBinding(
        launch.host_process_execution_binding,
        launch.execution_id,
      )
    ),
  );
}

export function assertCanonicalRunId(runId: string): string {
  if (!isCanonicalRunId(runId)) {
    throw new Error(NON_CANONICAL_RUN_ID_REASON);
  }
  return runId;
}

export function isCanonicalRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId);
}

async function publishRunRecordNoReplace(filePath: string, runId: string, record: RunRecord): Promise<void> {
  const published = await publishJsonNoReplace(filePath, record);
  if (!published) throw new RunCreationConflictError(runId);
}

async function publishJsonNoReplace(filePath: string, payload: unknown): Promise<boolean> {
  const directory = path.dirname(filePath);
  await ensureDurableDirectory(directory);
  const temporaryPath = `${filePath}.claim.${process.pid}.${randomUUID()}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  let preparationError: unknown;
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    preparationError = error;
  } finally {
    await handle.close();
  }
  if (preparationError) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw preparationError;
  }
  try {
    await link(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // The winning publisher may still be between link(2) and its own
      // directory fsync. `false` means a durable admission already exists, so
      // establish that durability before a losing caller is allowed to return.
      await syncDirectory(directory);
      return false;
    }
    throw error;
  }
  await syncDirectory(directory);
  // The authoritative hard link is durable before claim-file cleanup. A
  // cleanup failure cannot turn a completed creation claim into a reported
  // failure that a caller might retry as if no record existed.
  const removed = await rm(temporaryPath, { force: true }).then(() => true, () => false);
  if (removed) await syncDirectory(directory);
  return true;
}

function isAgentRunnerSpec(spec: ResolvedExecutionSpec): spec is ResolvedRunSpec {
  return spec.kernel === "agent_runner";
}

function toRunListEntry(root: string, record: RunRecord): RunListEntry {
  const backend: SupportedBackend | undefined = record.spec && isAgentRunnerSpec(record.spec)
    ? record.spec.backend
    : undefined;
  const agentReceipt = record.kernel_receipt && !("kernel" in record.kernel_receipt)
    ? record.kernel_receipt
    : undefined;
  const terminal: RunTerminalProjection | undefined = agentReceipt?.terminal_evidence
    ? {
        evidence: agentReceipt.terminal_evidence,
      }
    : undefined;
  return {
    run_id: record.run_id,
    state: record.state,
    summary: record.summary,
    created_at: record.created_at,
    updated_at: record.updated_at,
    ...(record.completed_at ? { completed_at: record.completed_at } : {}),
    ...(record.health ? { health_status: record.health.status } : {}),
    ...(record.health?.last_progress_at ? { last_progress_at: record.health.last_progress_at } : {}),
    ...(record.health?.progress_signal ? { progress_signal: record.health.progress_signal } : {}),
    ...(terminal ? { terminal } : {}),
    ...(record.intent.issue ? { issue: record.intent.issue } : {}),
    ...(record.intent.host ? { host: parseShortHostname(record.intent.host) } : {}),
    ...(backend ? { backend } : {}),
    recovery_mode: record.recovery.mode,
    run_dir: path.join(root, record.run_id),
  };
}

function runListEntryToIndexRow(entry: RunListEntry): RunIndexRow {
  return {
    run_id: entry.run_id,
    state: entry.state,
    summary: entry.summary,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    ...(entry.completed_at ? { completed_at: entry.completed_at } : {}),
    ...(entry.health_status ? { health_status: entry.health_status } : {}),
    ...(entry.last_progress_at ? { last_progress_at: entry.last_progress_at } : {}),
    ...(entry.issue ? { issue: entry.issue } : {}),
    ...(entry.host ? { host: entry.host } : {}),
    ...(entry.backend ? { backend: entry.backend } : {}),
    ...(entry.progress_signal
      ? { progress_signal_json: JSON.stringify(entry.progress_signal) }
      : {}),
    ...(entry.terminal ? { terminal_projection_json: JSON.stringify(entry.terminal) } : {}),
    recovery_mode: entry.recovery_mode,
    run_dir: entry.run_dir,
  };
}

function indexRowToRunListEntry(row: RunIndexRow): RunListEntry {
  const state = row.state as RunListEntry["state"];
  const recovery_mode = row.recovery_mode as RunListEntry["recovery_mode"];
  const progressSignal = row.progress_signal_json
    ? agentProgressSignalSchema.parse(JSON.parse(row.progress_signal_json)) as NonNullable<RunListEntry["progress_signal"]>
    : undefined;
  const terminal = row.terminal_projection_json
    ? runTerminalProjectionSchema.parse(JSON.parse(row.terminal_projection_json)) as RunTerminalProjection
    : undefined;
  return {
    run_id: row.run_id,
    state,
    summary: row.summary,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.completed_at ? { completed_at: row.completed_at } : {}),
    ...(row.health_status
      ? { health_status: row.health_status as NonNullable<RunListEntry["health_status"]> }
      : {}),
    ...(row.last_progress_at ? { last_progress_at: row.last_progress_at } : {}),
    ...(progressSignal ? { progress_signal: progressSignal } : {}),
    ...(terminal ? { terminal } : {}),
    ...(row.issue ? { issue: row.issue } : {}),
    ...(row.host ? { host: row.host } : {}),
    ...(row.backend ? { backend: row.backend as SupportedBackend } : {}),
    recovery_mode,
    run_dir: row.run_dir,
  };
}

export interface RunStoreOptions {
  /**
   * Optional projection sink. When set, every appended `CalyxStreamEvent`
   * is exact-idempotently mirrored from the physical-root SQLite event
   * authority into the state orchestration ledger. A transient sink failure
   * defers the projection; restart reconciliation backfills from ordinal zero.
   */
  eventLogIngest?: EventLogIngest | undefined;
  /**
   * SQLite-backed `run_index` projection (wave 2.2). When omitted, record
   * writes still succeed and non-paged local reads may recover from
   * authoritative `run_record.json` files. Snapshot-paged reads fail closed
   * until a projection is bound; a server binds one during startup.
   */
  runIndex?: RunIndexProjection | undefined;
}

export class RunStore {
  readonly root: string;
  private readonly eventLogIngest: EventLogIngest | undefined;
  private runIndexProjection: RunIndexProjection | undefined;
  private readonly committedStreamEventSubscribers = new Set<(
    event: CalyxStreamEvent,
  ) => unknown>();
  private readonly creationProvenanceByRun = new Map<string, ApiProvenanceV1>();
  private readonly authoritativeRunRecordKnown = new Set<string>();
  private readonly pendingLaunchMigrations = new Set<string>();
  private readonly pendingRunIndexRepairs = new Map<string, string>();
  private runIndexRepairPromise: Promise<void> | null = null;
  private globalEventAuthorityPathsPromise: Promise<GlobalEventAuthorityPaths> | null = null;
  private globalEventAuthorityReadyPromise: Promise<GlobalEventAuthorityPaths> | null = null;
  private globalEventAuthorityPreparedPromise: Promise<void> | null = null;
  private validatedGlobalEventAuthorityOrdinal = 0n;
  private validatedGlobalEventAuthorityCursor: string | undefined;
  private validatedGlobalEventAuthorityAllocatedCursorSeen = false;
  private readonly corruptPerRunEventProjections = new Map<string, EventJournalCorruptionError>();
  private mirroredAuthorityOrdinal = 0n;
  /**
   * Per-RunStore in-flight latch that coalesces concurrent first-list
   * callers so they share a single check of the SQLite marker (and, if
   * the marker is absent, a single rebuild). Reset to `null` only via
   * `close`-equivalent paths — there is no such path today, but tests
   * mutate the underlying DB and re-check, so the marker, not this
   * promise, is the source of truth across processes.
   *
   * Wave 2.2 charter rule: SQLite is the source of truth after
   * migration `0003`. The post-migration backfill that copies
   * authoritative `run_record.json` files into `run_index` runs at most
   * once per state DB and is gated by the
   * `run_index.initial_backfill_completed_at` row in `state_meta`.
   * Short-lived CLI processes consult that marker before deciding
   * whether to scan run directories, so steady-state `calyx run ps` /
   * `listActiveRuns()` reads stay SQLite-only.
   */
  private firstListRebuildPromise: Promise<void> | null = null;

  constructor(root: string = defaultRunsRoot(), options: RunStoreOptions = {}) {
    this.root = path.resolve(root);
    this.eventLogIngest = options.eventLogIngest;
    this.runIndexProjection = options.runIndex;
  }

  /**
   * Bind the server-owned snapshot authority exactly once. A RunService can
   * be assembled before server state paths are known, so the HTTP server
   * installs its projection after pinning those paths and before accepting
   * requests. Existing caller-owned projections always win.
   *
   * Returns true only when this call installed the projection and therefore
   * transferred lifecycle ownership to the caller.
   */
  bindRunIndexProjection(projection: RunIndexProjection): boolean {
    if (this.runIndexProjection) return false;
    this.runIndexProjection = projection;
    // A pre-server local read may have completed the no-projection branch.
    // Re-check the SQLite backfill marker now that an authority is present.
    this.firstListRebuildPromise = null;
    return true;
  }

  /**
   * Release a server-owned snapshot authority without disturbing a projection
   * supplied by the RunStore caller. Identity matching makes startup-failure
   * and shutdown cleanup safe even when ownership was never transferred.
   */
  unbindRunIndexProjection(projection: RunIndexProjection): boolean {
    if (this.runIndexProjection !== projection) return false;
    this.runIndexProjection = undefined;
    this.firstListRebuildPromise = null;
    return true;
  }

  /**
   * Register a process-local wake hint for a stream event whose complete
   * durable projection has settled. The shared event authority remains truth:
   * subscribers must reread it, and callback failure cannot change the append.
   */
  subscribeToCommittedStreamEvents(
    listener: (event: CalyxStreamEvent) => unknown,
  ): () => void {
    this.committedStreamEventSubscribers.add(listener);
    return () => {
      this.committedStreamEventSubscribers.delete(listener);
    };
  }

  private notifyCommittedStreamEventSubscribers(event: CalyxStreamEvent): void {
    for (const subscriber of this.committedStreamEventSubscribers) {
      try {
        const notification = subscriber(event);
        if (
          notification
          && (typeof notification === "object" || typeof notification === "function")
          && "then" in notification
        ) {
          void Promise.resolve(notification).catch(() => undefined);
        }
      } catch {
        // Notifications are observational wake hints after durable commit.
      }
    }
  }

  paths(runId: string): RunPaths {
    const canonicalRunId = assertCanonicalRunId(runId);
    const runDir = path.join(this.root, canonicalRunId);
    const mutexDir = path.join(this.root, ".mutexes");
    return {
      runDir,
      specPath: path.join(runDir, "spec.json"),
      kernelReceiptPath: path.join(runDir, "kernel_receipt.json"),
      runRecordPath: path.join(runDir, "run_record.json"),
      cancellationPath: path.join(runDir, "cancellation.json"),
      // Mutex acquisition can precede authoritative run creation. Keep these
      // outside the run directory so a failed admission cannot invent a run.
      dispatchMutexPath: path.join(mutexDir, `${canonicalRunId}.dispatch.sqlite3`),
      effectAdmissionMutexPath: path.join(mutexDir, `${canonicalRunId}.effect-admission.sqlite3`),
      executionMutexPath: path.join(mutexDir, `${canonicalRunId}.execution.sqlite3`),
      finalizationMutexPath: path.join(mutexDir, `${canonicalRunId}.finalization.sqlite3`),
      eventsPath: path.join(runDir, "events.jsonl"),
      integrationsPath: path.join(runDir, "integrations.json"),
    };
  }

  /** Cross-process serialization authority for the fixed reconcile operation. */
  reconcileMutexPath(): string {
    return path.join(this.root, ".mutexes", "reconcile-preserving.sqlite3");
  }

  eventsIndexPath(): string {
    return path.join(this.root, EVENTS_INDEX_FILENAME);
  }

  async ensureRoot(): Promise<void> {
    await ensureDurableDirectory(this.root);
  }

  async createRun(
    intent: RunIntent,
    options: {
      creationProvenance?: ApiProvenanceV1 | undefined;
      launchMode?: RunLaunchMode | undefined;
      admissionIdentity?: string | undefined;
      requestHash?: string | undefined;
      acceptedAt?: string | undefined;
    } = {},
  ): Promise<RunRecord> {
    const requestHash = options.requestHash ?? hashCanonicalJcs(intent);
    const admissionIdentity = options.admissionIdentity ?? hashCanonicalJcs({
      domain: "calyx.local-run-launch/v1",
      request_hash: requestHash,
    });
    if (admissionIdentity === legacyLaunchAdmissionIdentity(intent.run_id, requestHash)) {
      throw new Error(
        "The synthesized legacy launch admission domain is reserved for read-time migration.",
      );
    }
    const paths = this.paths(intent.run_id);
    await this.ensureRoot();
    await ensureDurableDirectory(paths.runDir);
    const record: RunRecord = {
      schema_version: "1.0",
      run_id: intent.run_id,
      state: "queued",
      intent,
      ...(options.creationProvenance
        ? { creation_provenance: validateApiProvenance(options.creationProvenance) }
        : {}),
      launch: {
        mode: options.launchMode ?? "inline",
        stage: "accepted",
        incarnation_id: randomUUID(),
        admission_identity: admissionIdentity,
        request_hash: requestHash,
        accepted_at: options.acceptedAt ?? new Date().toISOString(),
        dispatch_attempts: 0,
      },
      integrations: { results: [], all_critical_ok: true },
      recovery: { mode: "normal", resumable: false },
      summary: `Run ${intent.run_id} queued for host ${intent.host}.`,
      created_at: intent.created_at,
      updated_at: intent.created_at,
    };
    await this.publishRunRecordWithProjection(
      record,
      () => publishRunRecordNoReplace(paths.runRecordPath, intent.run_id, record),
    );
    this.pendingLaunchMigrations.delete(intent.run_id);
    this.authoritativeRunRecordKnown.add(intent.run_id);
    if (record.creation_provenance) {
      this.creationProvenanceByRun.set(intent.run_id, record.creation_provenance);
    }
    return record;
  }

  async requestCancellation(request: RunCancellationRequest): Promise<RunCancellationRequest> {
    const cancellationPath = this.paths(request.run_id).cancellationPath;
    if (await publishJsonNoReplace(cancellationPath, request)) return request;
    const existing = await readJsonFile<RunCancellationRequest>(cancellationPath);
    if (!existing) {
      throw new Error(`Run ${request.run_id} cancellation admission was lost after a conflicting publish.`);
    }
    return existing;
  }

  async readCancellation(runId: string): Promise<RunCancellationRequest | undefined> {
    return readJsonFile<RunCancellationRequest>(this.paths(runId).cancellationPath);
  }

  async writeSpec(runId: string, spec: ResolvedExecutionSpec): Promise<void> {
    if (spec.run_id !== runId) {
      throw new Error(`Run ${runId} spec identity mismatch: spec=${spec.run_id}.`);
    }
    await writeJsonFile(this.paths(runId).specPath, spec);
  }

  async readSpec(runId: string): Promise<ResolvedExecutionSpec | undefined> {
    return readJsonFile<ResolvedExecutionSpec>(this.paths(runId).specPath);
  }

  async writeKernelReceipt(runId: string, receipt: ExecutionReceipt): Promise<void> {
    const candidate = receipt as unknown as Record<string, unknown>;
    const runSpec = candidate["run_spec"] as Record<string, unknown> | undefined;
    const artifacts = candidate["artifacts"] as Record<string, unknown> | undefined;
    if (
      candidate["run_id"] !== runId
      || (runSpec && runSpec["run_id"] !== runId)
      || (artifacts && artifacts["run_id"] !== runId)
    ) {
      throw new Error(`Run ${runId} receipt identity mismatch.`);
    }
    await writeJsonFile(this.paths(runId).kernelReceiptPath, receipt);
  }

  async readKernelReceipt(runId: string): Promise<ExecutionReceipt | undefined> {
    return readJsonFile<ExecutionReceipt>(this.paths(runId).kernelReceiptPath);
  }

  async writeIntegrations(runId: string, integrations: IntegrationStatus): Promise<void> {
    await writeJsonFile(this.paths(runId).integrationsPath, integrations);
  }

  async readIntegrations(runId: string): Promise<IntegrationStatus | undefined> {
    return readJsonFile<IntegrationStatus>(this.paths(runId).integrationsPath);
  }

  async writeRunRecord(runId: string, record: RunRecord): Promise<void> {
    assertRunRecordIdentity(runId, record);
    const next = record.creation_provenance
      ? { ...record, creation_provenance: validateApiProvenance(record.creation_provenance) }
      : record;

    // A fresh createRun claim mints incarnation_id. Every ordinary record
    // update must preserve that identity, including across short-lived store
    // instances and sibling writers. Legacy claims without an id remain
    // legacy; only a guarded reap-and-create path may mint a new incarnation.
    const authoritativeRecord = await readJsonFile<RunRecord>(this.paths(runId).runRecordPath);
    if (authoritativeRecord
      && authoritativeRecord.launch?.incarnation_id !== next.launch?.incarnation_id) {
      throw new Error(`Run ${runId} launch.incarnation_id is immutable for an extant claim.`);
    }

    // A RunStore is commonly short-lived, so its in-memory provenance cache
    // cannot establish creation immutability on its own. Read the authoritative
    // record once before this instance's first write for the run, then keep the
    // hot update path free of redundant disk reads.
    if (!this.authoritativeRunRecordKnown.has(runId)) {
      const existing = authoritativeRecord;
      if (existing) {
        this.authoritativeRunRecordKnown.add(runId);
        if (existing.creation_provenance) {
          this.creationProvenanceByRun.set(
            runId,
            validateApiProvenance(existing.creation_provenance),
          );
        }
      }
    }

    if (this.authoritativeRunRecordKnown.has(runId)) {
      const existingProvenance = this.creationProvenanceByRun.get(runId);
      if (
        Boolean(existingProvenance) !== Boolean(next.creation_provenance)
        || (existingProvenance
          && JSON.stringify(existingProvenance) !== JSON.stringify(next.creation_provenance))
      ) {
        throw new Error(`Run ${runId} creation_provenance is immutable.`);
      }
    }
    await this.publishRunRecordWithProjection(
      next,
      () => writeJsonFile(this.paths(runId).runRecordPath, next),
    );
    this.pendingLaunchMigrations.delete(runId);
    this.authoritativeRunRecordKnown.add(runId);
    if (next.creation_provenance) {
      this.creationProvenanceByRun.set(runId, next.creation_provenance);
    }
  }

  private async publishRunRecordWithProjection(
    record: RunRecord,
    publish: () => Promise<void>,
  ): Promise<void> {
    const runId = record.run_id;
    let published = false;
    let projectionFailure: string | undefined;
    if (this.runIndexProjection) {
      try {
        await withSqliteMutex(
          path.join(this.root, "run-index-projection.mutex.sqlite3"),
          async () => {
            // The marker is the cross-process read fence. Publishing JSON
            // without first making projection degradation durable would let a
            // fresh process trust an already-present initial-backfill marker
            // and silently omit this acknowledged record.
            const marked = await withSqliteBusyRetry(
              () => this.runIndexProjection!.writeProjectionDegradedMarker(runId),
            );
            if (marked.status === "disabled") {
              throw new RunIndexProjectionNotReadyError(marked.reason);
            }

            try {
              await publish();
            } catch (error) {
              // No authoritative bytes changed, so this writer does not own a
              // degraded read fence. Clear its pre-publication marker while
              // still holding the shared projection mutex.
              await withSqliteBusyRetry(
                () => this.runIndexProjection!.clearProjectionDegradedMarker(),
              ).catch(() => undefined);
              throw error;
            }
            published = true;

            const entry = toRunListEntry(this.root, record);
            const projected = await withSqliteBusyRetry(
              () => this.runIndexProjection!.upsert(runListEntryToIndexRow(entry)),
            );
            if (projected.status === "disabled") {
              projectionFailure = projected.reason;
              return;
            }
            const cleared = await withSqliteBusyRetry(
              () => this.runIndexProjection!.clearProjectionDegradedMarker(),
            );
            if (cleared.status === "disabled") {
              projectionFailure = cleared.reason;
            }
          },
          // Writers and rebuilds share this cross-process mutex. Holding it
          // across marker -> JSON -> projection -> clear prevents one writer
          // from clearing another writer's degraded fence.
          { acquireTimeoutMs: null },
        );
      } catch (error) {
        if (!published) throw error;
        projectionFailure = error instanceof Error ? error.message : String(error);
      }
    } else {
      await publish();
      published = true;
    }

    if (!published) {
      throw new Error(`Run ${runId} record publication did not complete.`);
    }
    if (projectionFailure) {
      this.scheduleRunIndexRepair(runId, projectionFailure);
      return;
    }
    this.pendingRunIndexRepairs.delete(runId);
  }

  isRunIndexProjectionRepairPending(runId: string): boolean {
    return this.pendingRunIndexRepairs.has(runId);
  }

  private scheduleRunIndexRepair(runId: string, reason: string): void {
    this.pendingRunIndexRepairs.set(runId, reason);
    console.warn(
      `calyx run ${runId} is authoritative but run_index repair remains pending`,
      reason,
    );
    if (this.runIndexRepairPromise) return;

    this.runIndexRepairPromise = Promise.resolve()
      .then(async () => {
        // Retry more than once in the owning process. A durable degraded marker
        // keeps readers correct if all bounded background attempts fail; the
        // next read or a fresh process then owns another synchronous repair.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const repair = await this.rebuildRunIndex();
          if (repair.projection.status === "repaired") {
            this.pendingRunIndexRepairs.clear();
            return;
          }
          if (repair.projection.status === "failed") {
            console.warn("calyx run_index scheduled repair remains pending", repair.projection.reason);
          }
          if (this.runIndexProjection?.isDisabled || attempt === 2) return;
        }
      })
      .catch((error: unknown) => {
        console.warn(
          "calyx run_index scheduled repair remains pending",
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        this.runIndexRepairPromise = null;
      });
  }

  async readRunRecord(runId: string): Promise<RunRecord | undefined> {
    const stored = await readJsonFile<
      Omit<RunRecord, "launch"> & { launch?: Partial<RunRecord["launch"]> }
    >(this.paths(runId).runRecordPath);
    if (!stored) return undefined;
    let record: RunRecord;
    if (isCompleteRunLaunchState(stored.launch)) {
      record = stored as RunRecord;
    } else {
      const events = await this.readEvents(runId);
      const launchEvents = events.filter((event) => (
        "source" in event
        && event.source === "run-service"
        && "event" in event
        && event.event === "launch_dispatched"
      ));
      const inferredDetached = launchEvents.length > 0;
      const lastLaunchEvent = launchEvents.at(-1);
      const inferredLastDispatchAt = lastLaunchEvent
        && "timestamp" in lastLaunchEvent
        && typeof lastLaunchEvent.timestamp === "string"
        ? lastLaunchEvent.timestamp
        : undefined;
      const existingLaunch = stored.launch;
      const requestHash = isCanonicalHash(existingLaunch?.request_hash)
        ? existingLaunch.request_hash
        : hashCanonicalJcs(stored.intent);
      record = {
        ...stored,
        launch: {
          mode: isRunLaunchMode(existingLaunch?.mode)
            ? existingLaunch.mode
            : inferredDetached ? "detached" : "inline",
          stage: isRunLaunchStage(existingLaunch?.stage)
            ? existingLaunch.stage
            : stored.state === "queued" ? "accepted" : "executing",
          admission_identity: legacyLaunchAdmissionIdentity(stored.run_id, requestHash),
          request_hash: requestHash,
          accepted_at: isIsoTimestamp(existingLaunch?.accepted_at)
            ? existingLaunch.accepted_at
            : stored.created_at,
          dispatch_attempts: isNonNegativeInteger(existingLaunch?.dispatch_attempts)
            ? existingLaunch.dispatch_attempts
            : launchEvents.length,
          ...(isIsoTimestamp(existingLaunch?.last_dispatch_at)
            ? { last_dispatch_at: existingLaunch.last_dispatch_at }
            : inferredLastDispatchAt
              ? { last_dispatch_at: inferredLastDispatchAt }
              : {}),
          ...(isNonEmptyString(existingLaunch?.execution_id)
            ? { execution_id: existingLaunch.execution_id }
            : {}),
          ...(isIsoTimestamp(existingLaunch?.execution_started_at)
            ? { execution_started_at: existingLaunch.execution_started_at }
            : {}),
          ...(isHostProcessExecutionBinding(
            existingLaunch?.host_process_execution_binding,
            existingLaunch?.execution_id,
          )
            ? { host_process_execution_binding: existingLaunch.host_process_execution_binding }
            : {}),
        },
      } as RunRecord;
      this.pendingLaunchMigrations.add(runId);
    }
    if (record) {
      this.authoritativeRunRecordKnown.add(runId);
      if (record.creation_provenance) {
        this.creationProvenanceByRun.set(runId, validateApiProvenance(record.creation_provenance));
      }
    }
    return record;
  }

  async inspectStoredLaunchGeneration(runId: string): Promise<
    | { status: "missing" }
    | { status: "current"; record: RunRecord }
    | { status: "legacy"; record?: RunRecord }
  > {
    const stored = await readJsonFile<
      Omit<RunRecord, "launch"> & { launch?: Partial<RunRecord["launch"]> }
    >(this.paths(runId).runRecordPath);
    if (!stored) return { status: "missing" };
    if (!isCompleteRunLaunchState(stored.launch)) {
      return { status: "legacy" };
    }
    const record = stored as RunRecord;
    return record.launch.admission_identity === legacyLaunchAdmissionIdentity(
      record.run_id,
      record.launch.request_hash,
    )
      ? { status: "legacy", record }
      : { status: "current", record };
  }

  needsLaunchMigration(runId: string): boolean {
    return this.pendingLaunchMigrations.has(runId);
  }

  async appendEvent(runId: string, event: RecordedRunEvent): Promise<void>;
  async appendEvent<T extends CalyxStreamEvent>(event: T): Promise<T>;
  async appendEvent(
    runIdOrEvent: string | CalyxStreamEvent,
    maybeEvent?: RecordedRunEvent,
  ): Promise<void | CalyxStreamEvent> {
    if (typeof runIdOrEvent !== "string") {
      return this.appendStreamEvent(runIdOrEvent);
    }

    const event = maybeEvent;
    if (!event) {
      throw new Error("appendEvent(runId, event) requires an event payload.");
    }
    await this.appendEventLine(this.paths(runIdOrEvent).eventsPath, event);
  }

  /** Append and fsync a capability mutation boundary before control returns. */
  async appendDurableEvent(runId: string, event: RecordedRunEvent): Promise<void> {
    await this.appendDurableEventLine(this.paths(runId).eventsPath, event);
  }

  async appendStreamEvent<T extends CalyxStreamEvent>(event: T): Promise<T> {
    const committed = await this.appendGlobalStreamEvent(event);
    const canonicalEvent = committed.event;
    const authority = await this.ensureGlobalEventAuthority();
    await withSqliteMutex(authority.receiptMutexPath, async () => {
      // Cursor publication is one ordered cross-process lane: durable JSONL
      // receipts, exact duplicate repair, and the state-ledger projection must
      // complete before a later cursor can return to its caller or be announced
      // to process-local subscribers.
      await this.projectGlobalEventReceiptsOwned(authority, {
        ...(isCalyxRunEvent(canonicalEvent)
          ? { requiredRunId: canonicalEvent.run.run_id }
          : {}),
      });
      if (!committed.inserted && isCalyxRunEvent(canonicalEvent)) {
        // A duplicate authority append doubles as exact-idempotent repair for a
        // per-run receipt removed after its projection marker was committed.
        try {
          const cachedCorruption = this.corruptPerRunEventProjections.get(
            canonicalEvent.run.run_id,
          );
          let knownCorruption = await this.revalidateCachedPerRunEventProjectionOwned(
            authority,
            canonicalEvent.run.run_id,
            { allowMissingPending: true },
          );
          if (knownCorruption
            && cachedCorruption instanceof PerRunEventProjectionIdentityConflictError
            && cachedCorruption.eventId === canonicalEvent.event_id) {
            // The conflicting generation may have been removed by an operator
            // or peer. Repair the complete run projection, not only this exact
            // duplicate, and make the marker transition crash-safe.
            const repairThroughOrdinal = await this.readPerRunEventAuthorityTail(
              authority,
              canonicalEvent.run.run_id,
            );
            await this.setPerRunEventProjectionMarkers(
              authority,
              canonicalEvent.run.run_id,
              0,
              repairThroughOrdinal,
            );
            try {
              const filePath = this.paths(canonicalEvent.run.run_id).eventsPath;
              await this.withEventJournalMutex(filePath, async () => {
                await this.projectRunAuthorityIntoJournalOwned(
                  authority,
                  canonicalEvent.run.run_id,
                  filePath,
                  {
                    appendMissing: true,
                    allowMissingPending: false,
                    throughOrdinal: repairThroughOrdinal,
                  },
                );
                await this.projectRunAuthorityIntoJournalOwned(
                  authority,
                  canonicalEvent.run.run_id,
                  filePath,
                  {
                    appendMissing: false,
                    allowMissingPending: false,
                    throughOrdinal: repairThroughOrdinal,
                  },
                );
              });
              await this.setPerRunEventProjectionMarkers(
                authority,
                canonicalEvent.run.run_id,
                1,
                repairThroughOrdinal,
              );
              this.corruptPerRunEventProjections.delete(canonicalEvent.run.run_id);
              knownCorruption = undefined;
            } catch (error) {
              if (error instanceof EventJournalCorruptionError) {
                this.recordPerRunEventProjectionCorruption(
                  canonicalEvent.run.run_id,
                  error,
                );
              }
              throw error;
            }
          }
          if (knownCorruption
            && (!(knownCorruption instanceof PerRunEventProjectionIdentityConflictError)
              || knownCorruption.eventId !== canonicalEvent.event_id)) {
            throw knownCorruption;
          }
          const runId = canonicalEvent.run.run_id;
          const filePath = this.paths(runId).eventsPath;
          const throughOrdinal = await this.readPerRunEventAuthorityTail(authority, runId);
          await this.withEventJournalMutex(filePath, () => this.projectRunAuthorityIntoJournalOwned(
            authority,
            runId,
            filePath,
            { appendMissing: true, allowMissingPending: false, throughOrdinal },
          ));
          await this.setPerRunEventProjectionMarkers(authority, runId, 1, throughOrdinal);
          if (knownCorruption) {
            this.corruptPerRunEventProjections.delete(runId);
          }
        } catch (error) {
          if (error instanceof EventJournalCorruptionError) {
            this.recordPerRunEventProjectionCorruption(canonicalEvent.run.run_id, error);
          }
          throw error;
        }
      }
      await this.mirrorAuthorityToEventLog();
    }, { acquireTimeoutMs: null });
    this.notifyCommittedStreamEventSubscribers(canonicalEvent);
    return canonicalEvent as T;
  }

  private async appendGlobalStreamEvent<T extends CalyxStreamEvent>(
    event: T,
  ): Promise<{ event: T; inserted: boolean }> {
    const authority = await this.ensureGlobalEventAuthority();
    return withSqliteMutex(authority.mutationMutexPath, async () => {
      const db = await this.openGlobalEventAuthority(authority.databasePath);
      try {
        db.exec("BEGIN IMMEDIATE");
        const existing = db.prepare(
          `SELECT ordinal, event_id, cursor, event_type, run_id, identity_hash,
                  event_json, receipt_written, run_receipt_written
           FROM global_event_authority WHERE event_id = ?`,
        ).get(event.event_id) as GlobalEventAuthorityRow | undefined;
        if (existing) {
          if (existing.identity_hash !== streamEventIdentityHash(event)) {
            throw new EventJournalEventIdentityConflictError(event.event_id);
          }
          const canonical = this.parseGlobalEventAuthorityRow(existing);
          db.exec("COMMIT");
          return { event: canonical as T, inserted: false };
        }

        const pendingCursor = `pending-${randomUUID()}`;
        const inserted = db.prepare(
          `INSERT INTO global_event_authority
             (event_id, cursor, event_type, run_id, supersedes_event_id,
              identity_hash, event_json, receipt_written, run_receipt_written)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        ).run(
          event.event_id,
          pendingCursor,
          event.event_type,
          isCalyxRunEvent(event) ? event.run.run_id : null,
          isRunTerminalEvent(event) ? event.supersession?.supersedes_event_id ?? null : null,
          streamEventIdentityHash(event),
          "{}",
          isCalyxRunEvent(event) ? 0 : 1,
        );
        const ordinal = BigInt(inserted.lastInsertRowid);
        const digits = ordinal.toString().padStart(GLOBAL_EVENT_CURSOR_ORDINAL_WIDTH, "0");
        if (digits.length !== GLOBAL_EVENT_CURSOR_ORDINAL_WIDTH) {
          throw new Error(`Global event authority exhausted its ${GLOBAL_EVENT_CURSOR_ORDINAL_WIDTH}-digit cursor space.`);
        }
        const canonicalEvent = { ...event, cursor: `z1-${digits}` } as T;
        try {
          parseCalyxStreamEvent(canonicalEvent);
        } catch (error) {
          throw new EventJournalCorruptionError(authority.databasePath, Number(ordinal), error);
        }
        const eventJson = JSON.stringify(canonicalEvent);
        const sseFrameBytes = Buffer.byteLength(
          encodeCalyxSseFrameData(canonicalEvent.cursor, eventJson),
          "utf8",
        );
        if (sseFrameBytes > CALYX_HTTP_SSE_MAX_FRAME_BYTES) {
          throw new EventSseFrameTooLargeError(
            canonicalEvent.event_id,
            sseFrameBytes,
            CALYX_HTTP_SSE_MAX_FRAME_BYTES,
          );
        }
        db.prepare(
          `UPDATE global_event_authority SET cursor = ?, event_json = ? WHERE ordinal = ?`,
        ).run(canonicalEvent.cursor, eventJson, ordinal);
        db.exec("COMMIT");
        return { event: canonicalEvent, inserted: true };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Closing the handle releases the writer lock.
        }
        throw error;
      } finally {
        db.close();
      }
    }, { acquireTimeoutMs: null });
  }

  private async resolveGlobalEventAuthorityPaths(): Promise<GlobalEventAuthorityPaths> {
    if (!this.globalEventAuthorityPathsPromise) {
      this.globalEventAuthorityPathsPromise = (async () => {
        await ensureDurableDirectory(this.root);
        const physicalRoot = await realpath(this.root);
        const mutexRoot = path.join(physicalRoot, ".mutexes");
        return {
          physicalRoot,
          databasePath: path.join(physicalRoot, "events.authority.sqlite3"),
          mutationMutexPath: path.join(mutexRoot, "global-event-authority.mutation.sqlite3"),
          receiptMutexPath: path.join(mutexRoot, "global-event-authority.receipt.sqlite3"),
        };
      })();
    }
    return this.globalEventAuthorityPathsPromise;
  }

  private async openGlobalEventAuthority(
    databasePath: string,
    readOnly = false,
  ): Promise<StateDriverDatabase> {
    const driver = await loadStateDriver();
    const db = readOnly ? driver.openReadOnly(databasePath) : driver.open(databasePath);
    db.exec("PRAGMA busy_timeout = 5000");
    if (!readOnly) {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = FULL");
    }
    return db;
  }

  private async importLegacyGlobalEventsOwned(
    db: StateDriverDatabase,
    filePath: string,
  ): Promise<number> {
    const insert = db.prepare(
      `INSERT INTO global_event_authority
         (ordinal, event_id, cursor, event_type, run_id, supersedes_event_id,
          identity_hash, event_json, receipt_written, run_receipt_written)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    );
    const batch: Array<{ event: CalyxStreamEvent; ordinal: bigint; lineNumber: number }> = [];
    let eventOrdinal = 0n;
    let allocatedCursorSeen = false;

    const flush = (): void => {
      for (const row of batch) {
        try {
          insert.run(
            row.ordinal,
            row.event.event_id,
            row.event.cursor,
            row.event.event_type,
            isCalyxRunEvent(row.event) ? row.event.run.run_id : null,
            isRunTerminalEvent(row.event)
              ? row.event.supersession?.supersedes_event_id ?? null
              : null,
            streamEventIdentityHash(row.event),
            JSON.stringify(row.event),
          );
        } catch (error) {
          throw new EventJournalCorruptionError(filePath, row.lineNumber, error);
        }
      }
      batch.length = 0;
    };

    const summary = await consumeFatalUtf8Lines(
      filePath,
      (rawLine, lineNumber, terminated) => {
        if (!terminated) {
          throw new EventJournalCorruptionError(
            filePath,
            lineNumber,
            "unterminated final row has no independent commit boundary",
          );
        }
        if (rawLine.trim().length === 0) {
          throw new EventJournalCorruptionError(filePath, lineNumber, "blank receipt row");
        }
        let parsed: CalyxStreamEvent;
        try {
          parsed = parseCalyxStreamEvent(JSON.parse(rawLine) as unknown);
          eventOrdinal += 1n;
          if (isAllocatedGlobalEventCursor(parsed.cursor)) {
            allocatedCursorSeen = true;
            if (BigInt(parsed.cursor.slice(3)) !== eventOrdinal) {
              throw new Error(`allocated cursor ordinal must equal journal event ordinal ${eventOrdinal}`);
            }
          } else if (allocatedCursorSeen) {
            throw new Error("legacy cursor appears after an allocated cursor");
          }
        } catch (error) {
          throw new EventJournalCorruptionError(filePath, lineNumber, error);
        }
        batch.push({ event: parsed, ordinal: eventOrdinal, lineNumber });
        if (batch.length === 256) flush();
      },
    );
    flush();
    return summary.byteCount;
  }

  private async ensureGlobalEventAuthority(): Promise<GlobalEventAuthorityPaths> {
    if (!this.globalEventAuthorityReadyPromise) {
      this.globalEventAuthorityReadyPromise = (async () => {
        const authority = await this.resolveGlobalEventAuthorityPaths();
        return withSqliteMutex(authority.mutationMutexPath, async () => {
          const db = await this.openGlobalEventAuthority(authority.databasePath);
          try {
            db.exec(`
              CREATE TABLE IF NOT EXISTS global_event_authority (
                ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                cursor TEXT NOT NULL UNIQUE,
                event_type TEXT NOT NULL,
                run_id TEXT,
                supersedes_event_id TEXT,
                identity_hash TEXT NOT NULL,
                event_json TEXT NOT NULL,
                receipt_written INTEGER NOT NULL DEFAULT 0 CHECK (receipt_written IN (0, 1)),
                run_receipt_written INTEGER NOT NULL DEFAULT 0 CHECK (run_receipt_written IN (0, 1))
              );
              CREATE INDEX IF NOT EXISTS idx_global_event_authority_cursor
                ON global_event_authority(cursor);
              CREATE INDEX IF NOT EXISTS idx_global_event_authority_filter
                ON global_event_authority(event_type, run_id, ordinal);
              CREATE INDEX IF NOT EXISTS idx_global_event_authority_run
                ON global_event_authority(run_id, ordinal);
              CREATE INDEX IF NOT EXISTS idx_global_event_authority_type
                ON global_event_authority(event_type, ordinal);
              CREATE INDEX IF NOT EXISTS idx_global_event_authority_receipt
                ON global_event_authority(receipt_written, ordinal);
              CREATE INDEX IF NOT EXISTS idx_global_event_authority_run_receipt
                ON global_event_authority(run_receipt_written, ordinal);
              CREATE TABLE IF NOT EXISTS global_event_authority_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
              );
            `);
            const authorityColumns = db.prepare(
              "PRAGMA table_info(global_event_authority)",
            ).all() as Array<{ name: string }>;
            if (!authorityColumns.some((column) => column.name === "supersedes_event_id")) {
              db.exec("ALTER TABLE global_event_authority ADD COLUMN supersedes_event_id TEXT");
            }
            db.exec(`
              UPDATE global_event_authority
              SET supersedes_event_id = json_extract(
                event_json,
                '$.supersession.supersedes_event_id'
              )
              WHERE supersedes_event_id IS NULL
                AND event_type = 'run.terminal'
                AND json_extract(
                  event_json,
                  '$.supersession.supersedes_event_id'
                ) IS NOT NULL;
              CREATE INDEX IF NOT EXISTS idx_global_event_authority_supersedes
                ON global_event_authority(supersedes_event_id, ordinal);
              CREATE TRIGGER IF NOT EXISTS global_event_authority_identity_immutable
              BEFORE UPDATE OF event_id, cursor, event_type, run_id,
                               supersedes_event_id, identity_hash, event_json
              ON global_event_authority
              WHEN NOT (
                (
                  OLD.cursor GLOB 'pending-*'
                  AND OLD.event_json = '{}'
                  AND NEW.event_id = OLD.event_id
                  AND NEW.event_type = OLD.event_type
                  AND NEW.run_id IS OLD.run_id
                  AND NEW.supersedes_event_id IS OLD.supersedes_event_id
                  AND NEW.identity_hash = OLD.identity_hash
                )
                OR (
                  OLD.supersedes_event_id IS NULL
                  AND NEW.supersedes_event_id IS json_extract(
                    OLD.event_json,
                    '$.supersession.supersedes_event_id'
                  )
                  AND NEW.event_id = OLD.event_id
                  AND NEW.cursor = OLD.cursor
                  AND NEW.event_type = OLD.event_type
                  AND NEW.run_id IS OLD.run_id
                  AND NEW.identity_hash = OLD.identity_hash
                  AND NEW.event_json = OLD.event_json
                )
              )
              BEGIN
                SELECT RAISE(ABORT, 'global event authority identity is immutable');
              END;
              CREATE TRIGGER IF NOT EXISTS global_event_authority_supersedes_insert
              AFTER INSERT ON global_event_authority
              WHEN NEW.supersedes_event_id IS NULL
                AND json_extract(
                  NEW.event_json,
                  '$.supersession.supersedes_event_id'
                ) IS NOT NULL
              BEGIN
                UPDATE global_event_authority
                SET supersedes_event_id = json_extract(
                  NEW.event_json,
                  '$.supersession.supersedes_event_id'
                )
                WHERE ordinal = NEW.ordinal;
              END;
              CREATE TRIGGER IF NOT EXISTS global_event_authority_supersedes_update
              AFTER UPDATE OF event_json ON global_event_authority
              WHEN NEW.supersedes_event_id IS NULL
                AND json_extract(
                  NEW.event_json,
                  '$.supersession.supersedes_event_id'
                ) IS NOT NULL
              BEGIN
                UPDATE global_event_authority
                SET supersedes_event_id = json_extract(
                  NEW.event_json,
                  '$.supersession.supersedes_event_id'
                )
                WHERE ordinal = NEW.ordinal;
              END;
            `);
            const initialized = db.prepare(
              "SELECT value FROM global_event_authority_meta WHERE key = 'initialized'",
            ).get();
            const schemaVersion = db.prepare(
              "SELECT value FROM global_event_authority_meta WHERE key = 'schema_version'",
            ).get() as { value: string } | undefined;
            if (schemaVersion && schemaVersion.value !== "1") {
              throw new EventJournalCorruptionError(
                authority.databasePath,
                0,
                `unsupported global event authority schema version ${schemaVersion.value}`,
              );
            }
            if (!schemaVersion && initialized) {
              throw new EventJournalCorruptionError(
                authority.databasePath,
                0,
                "initialized global event authority has no schema version",
              );
            }
            if (!schemaVersion) {
              db.prepare(
                "INSERT INTO global_event_authority_meta (key, value) VALUES ('schema_version', '1')",
              ).run();
            }
            if (!initialized) {
              db.exec("BEGIN IMMEDIATE");
              try {
                const receiptBytes = await this.importLegacyGlobalEventsOwned(
                  db,
                  this.eventsIndexPath(),
                );
                db.prepare(
                  "INSERT INTO global_event_authority_meta (key, value) VALUES ('receipt_bytes', ?)",
                ).run(String(receiptBytes));
                db.prepare(
                  "INSERT INTO global_event_authority_meta (key, value) VALUES ('initialized', '1')",
                ).run();
                db.exec("COMMIT");
              } catch (error) {
                try {
                  db.exec("ROLLBACK");
                } catch {
                  // Closing below releases the writer lock.
                }
                throw error;
              }
            }
          } finally {
            db.close();
          }
          return authority;
        }, { acquireTimeoutMs: null });
      })();
    }
    return this.globalEventAuthorityReadyPromise;
  }

  private async requireGlobalEventAuthorityPrepared(): Promise<GlobalEventAuthorityPaths> {
    if (!this.globalEventAuthorityReadyPromise) {
      throw new EventAuthorityNotPreparedError();
    }
    return this.globalEventAuthorityReadyPromise;
  }

  /** Explicit mutating startup boundary for legacy import and projection repair. */
  async prepareGlobalEventAuthority(): Promise<void> {
    if (!this.globalEventAuthorityPreparedPromise) {
      this.globalEventAuthorityPreparedPromise = this.assertGlobalEventIndexReadable();
    }
    await this.globalEventAuthorityPreparedPromise;
  }

  private parseGlobalEventAuthorityRow(row: GlobalEventAuthorityRow): CalyxStreamEvent {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.event_json) as unknown;
      const event = parseCalyxStreamEvent(parsed);
      if (event.event_id !== row.event_id
        || event.cursor !== row.cursor
        || event.event_type !== row.event_type
        || streamEventIdentityHash(event) !== row.identity_hash
        || (isCalyxRunEvent(event) ? event.run.run_id : null) !== row.run_id) {
        throw new Error("authority columns disagree with event_json");
      }
      if (row.supersedes_event_id !== undefined
        && (isRunTerminalEvent(event)
          ? event.supersession?.supersedes_event_id ?? null
          : null) !== row.supersedes_event_id) {
        throw new Error("authority supersedes_event_id disagrees with event_json");
      }
      return event;
    } catch (error) {
      throw new EventJournalCorruptionError(
        "global_event_authority",
        Number(row.ordinal),
        error,
      );
    }
  }

  private async readGlobalEventAuthorityRows(
    databasePath: string,
    afterOrdinal: bigint,
    limit: number,
    filter: CalyxRunEventFilter = {},
    throughOrdinal?: bigint,
  ): Promise<GlobalEventAuthorityRow[]> {
    const db = await this.openGlobalEventAuthority(databasePath, true);
    try {
      const predicates = ["ordinal > ?"];
      const params: unknown[] = [afterOrdinal];
      if (throughOrdinal !== undefined) {
        predicates.push("ordinal <= ?");
        params.push(throughOrdinal);
      }
      if (filter.event_type) {
        predicates.push("event_type = ?");
        params.push(filter.event_type);
      }
      if (filter.run_id) {
        predicates.push("run_id = ?");
        params.push(filter.run_id);
      }
      params.push(limit);
      return db.prepare(
        `SELECT ordinal, event_id, cursor, event_type, run_id,
                supersedes_event_id, identity_hash, event_json,
                receipt_written, run_receipt_written
         FROM global_event_authority
         WHERE ${predicates.join(" AND ")}
         ORDER BY ordinal ASC LIMIT ?`,
      ).all(...params) as GlobalEventAuthorityRow[];
    } finally {
      db.close();
    }
  }

  private async readTerminalGraphRowsByIds(
    databasePath: string,
    column: "event_id" | "supersedes_event_id",
    eventIds: readonly string[],
    throughOrdinal: bigint,
  ): Promise<GlobalEventAuthorityRow[]> {
    if (eventIds.length === 0) return [];
    const db = await this.openGlobalEventAuthority(databasePath, true);
    try {
      const placeholders = eventIds.map(() => "?").join(", ");
      return db.prepare(
        `SELECT ordinal, event_id, cursor, event_type, run_id,
                supersedes_event_id, identity_hash, event_json,
                receipt_written, run_receipt_written
         FROM global_event_authority
         WHERE ordinal <= ?
           AND event_type = 'run.terminal'
           AND ${column} IN (${placeholders})
         ORDER BY ordinal ASC`,
      ).all(throughOrdinal, ...eventIds) as GlobalEventAuthorityRow[];
    } finally {
      db.close();
    }
  }

  private parseTerminalGraphRow(row: GlobalEventAuthorityRow): RunTerminalEvent {
    const event = this.parseGlobalEventAuthorityRow(row);
    if (!isRunTerminalEvent(event)
      || (event.supersession?.supersedes_event_id ?? null) !== row.supersedes_event_id) {
      throw new EventJournalCorruptionError(
        "global_event_authority",
        Number(row.ordinal),
        "terminal supersession column disagrees with event_json",
      );
    }
    return event;
  }

  /**
   * Read the terminal component that can affect one run's leaf selection.
   * The indexed incoming-edge walk includes foreign-run children and parents,
   * so cross-run edges and branches cannot be hidden by a run_id filter.
   */
  async readConnectedTerminalEvents(runId: string): Promise<RunTerminalEvent[]> {
    const authority = await this.requireGlobalEventAuthorityPrepared();
    const validatedThroughOrdinal = await this.validateGlobalEventAuthorityTail(authority);
    const eventsById = new Map<string, RunTerminalEvent>();
    let afterOrdinal = 0n;
    while (true) {
      const rows = await this.readGlobalEventAuthorityRows(
        authority.databasePath,
        afterOrdinal,
        256,
        { event_type: "run.terminal", run_id: runId },
        validatedThroughOrdinal,
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        afterOrdinal = BigInt(row.ordinal);
        const event = this.parseGlobalEventAuthorityRow(row);
        if (!isRunTerminalEvent(event)) {
          throw new EventJournalCorruptionError(
            authority.databasePath,
            Number(row.ordinal),
            "terminal graph seed is not a terminal event",
          );
        }
        eventsById.set(event.event_id, event);
      }
    }

    let frontier = [...eventsById.keys()];
    const attemptedParentIds = new Set<string>();
    while (frontier.length > 0) {
      const nextFrontier: string[] = [];
      for (let offset = 0; offset < frontier.length; offset += 128) {
        const batch = frontier.slice(offset, offset + 128);
        const children = await this.readTerminalGraphRowsByIds(
          authority.databasePath,
          "supersedes_event_id",
          batch,
          validatedThroughOrdinal,
        );
        for (const row of children) {
          const event = this.parseTerminalGraphRow(row);
          if (!eventsById.has(event.event_id)) {
            eventsById.set(event.event_id, event);
            nextFrontier.push(event.event_id);
          }
        }
      }

      const parentIds = frontier.flatMap((eventId) => {
        const parentId = eventsById.get(eventId)?.supersession?.supersedes_event_id;
        if (!parentId || eventsById.has(parentId) || attemptedParentIds.has(parentId)) return [];
        attemptedParentIds.add(parentId);
        return [parentId];
      });
      for (let offset = 0; offset < parentIds.length; offset += 128) {
        const batch = parentIds.slice(offset, offset + 128);
        const parents = await this.readTerminalGraphRowsByIds(
          authority.databasePath,
          "event_id",
          batch,
          validatedThroughOrdinal,
        );
        for (const row of parents) {
          const event = this.parseTerminalGraphRow(row);
          if (!eventsById.has(event.event_id)) {
            eventsById.set(event.event_id, event);
            nextFrontier.push(event.event_id);
          }
        }
      }
      frontier = nextFrontier;
    }
    return [...eventsById.values()];
  }

  private async projectGlobalEventReceiptsOwned(
    authority: GlobalEventAuthorityPaths,
    options: { requiredRunId?: string | undefined },
  ): Promise<void> {
    const db = await this.openGlobalEventAuthority(authority.databasePath);
    try {
      while (true) {
        const row = db.prepare(
          `SELECT ordinal, event_id, cursor, event_type, run_id, identity_hash,
                  event_json, receipt_written, run_receipt_written
           FROM global_event_authority
           WHERE receipt_written = 0 ORDER BY ordinal ASC LIMIT 1`,
        ).get() as GlobalEventAuthorityRow | undefined;
        if (!row) break;
        const expectedBytesRow = db.prepare(
          "SELECT value FROM global_event_authority_meta WHERE key = 'receipt_bytes'",
        ).get() as { value: string } | undefined;
        if (!expectedBytesRow || !/^\d+$/u.test(expectedBytesRow.value)) {
          throw new EventJournalCorruptionError(authority.databasePath, Number(row.ordinal), "missing receipt byte boundary");
        }
        const expectedBytes = Number(expectedBytesRow.value);
        if (!Number.isSafeInteger(expectedBytes)) {
          throw new EventJournalCorruptionError(
            authority.databasePath,
            Number(row.ordinal),
            "receipt byte boundary exceeds the safe positional I/O range",
          );
        }
        const filePath = path.join(authority.physicalRoot, EVENTS_INDEX_FILENAME);
        let actualBytes = 0;
        try {
          actualBytes = (await stat(filePath)).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const receiptLine = Buffer.from(`${row.event_json}\n`, "utf8");
        const receiptBytes = receiptLine.byteLength;
        if (actualBytes < expectedBytes) {
          throw new EventJournalCorruptionError(filePath, Number(row.ordinal), "receipt byte boundary diverged from authority");
        }
        if (actualBytes > expectedBytes) {
          const tailBytes = actualBytes - expectedBytes;
          let exactPendingPrefix = false;
          let tailHasCommitBoundary = tailBytes > receiptBytes;
          if (tailBytes <= receiptBytes) {
            const handle = await open(filePath, "r+");
            try {
              const uncommittedTail = Buffer.alloc(tailBytes);
              const read = await handle.read(uncommittedTail, 0, tailBytes, expectedBytes);
              tailHasCommitBoundary = uncommittedTail.at(-1) === 0x0a;
              exactPendingPrefix = read.bytesRead === tailBytes
                && uncommittedTail.equals(receiptLine.subarray(0, tailBytes));
              if (exactPendingPrefix && tailBytes < receiptBytes) {
                // A crash can expose a prefix of the one pending row. Prove the
                // prefix byte-for-byte, remove it, then rewrite the complete row;
                // never normalize a divergent closed tail into authority.
                await handle.truncate(expectedBytes);
                await writeBufferToHandle(handle, receiptLine, expectedBytes);
              }
              if (exactPendingPrefix) await handle.sync();
            } finally {
              await handle.close();
            }
          }
          if (!exactPendingPrefix) {
            if (!tailHasCommitBoundary) {
              throw new EventJournalCorruptionError(
                filePath,
                Number(row.ordinal),
                "receipt tail is not an exact prefix of the pending authority row",
              );
            }
            await this.quarantineLegacyGlobalProjectionTailOwned({
              database: db,
              filePath,
              expectedBytes,
              actualBytes,
              pendingOrdinal: Number(row.ordinal),
            });
            actualBytes = expectedBytes;
          }
        }
        if (actualBytes === expectedBytes) {
          const handle = await open(filePath, "a", 0o600);
          try {
            await writeBufferToHandle(handle, receiptLine, null);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await syncDirectory(path.dirname(filePath));
        }
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare(
            "UPDATE global_event_authority SET receipt_written = 1 WHERE ordinal = ?",
          ).run(row.ordinal);
          db.prepare(
            "UPDATE global_event_authority_meta SET value = ? WHERE key = 'receipt_bytes'",
          ).run(String(expectedBytes + receiptBytes));
          db.exec("COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Recovery compares the exact tail on the next pass.
          }
          throw error;
        }
      }
      let afterRunId = "";
      while (true) {
        const pending = db.prepare(
          `SELECT DISTINCT run_id FROM global_event_authority
           WHERE run_receipt_written = 0 AND run_id IS NOT NULL AND run_id > ?
           ORDER BY run_id COLLATE BINARY ASC LIMIT 128`,
        ).all(afterRunId) as Array<{ run_id: string }>;
        if (pending.length === 0) break;
        for (const { run_id: runId } of pending) {
          const filePath = this.paths(runId).eventsPath;
          const throughOrdinal = await this.readPerRunEventAuthorityTail(authority, runId);
          try {
            await this.withEventJournalMutex(filePath, () => this.projectRunAuthorityIntoJournalOwned(
              authority,
              runId,
              filePath,
              { appendMissing: true, allowMissingPending: false, throughOrdinal },
            ));
            await this.setPerRunEventProjectionMarkers(authority, runId, 1, throughOrdinal);
            this.corruptPerRunEventProjections.delete(runId);
          } catch (error) {
            if (!(error instanceof EventJournalCorruptionError)) throw error;
            this.recordPerRunEventProjectionCorruption(runId, error);
            if (options.requiredRunId === runId) throw error;
          }
          afterRunId = runId;
        }
      }
    } finally {
      db.close();
    }
  }

  private async quarantineLegacyGlobalProjectionTailOwned(args: {
    database: StateDriverDatabase;
    filePath: string;
    expectedBytes: number;
    actualBytes: number;
    pendingOrdinal: number;
  }): Promise<string> {
    return this.withEventJournalMutex(args.filePath, async () => {
      const observedBytes = (await stat(args.filePath)).size;
      if (observedBytes !== args.actualBytes) {
        throw new EventJournalCorruptionError(
          args.filePath,
          args.pendingOrdinal,
          "receipt byte boundary changed while acquiring the legacy-tail repair lock",
        );
      }
      const tailByteCount = observedBytes - args.expectedBytes;
      if (tailByteCount <= 0 || tailByteCount > LEGACY_GLOBAL_PROJECTION_TAIL_MAX_BYTES) {
        throw new EventJournalCorruptionError(
          args.filePath,
          args.pendingOrdinal,
          `untracked receipt tail is outside the ${LEGACY_GLOBAL_PROJECTION_TAIL_MAX_BYTES} byte compatibility-repair bound`,
        );
      }

      const source = await open(args.filePath, "r");
      let tail: Buffer;
      try {
        tail = Buffer.alloc(tailByteCount);
        const read = await source.read(tail, 0, tailByteCount, args.expectedBytes);
        if (read.bytesRead !== tailByteCount) {
          throw new EventJournalCorruptionError(
            args.filePath,
            args.pendingOrdinal,
            "untracked receipt tail changed during compatibility validation",
          );
        }
      } finally {
        await source.close();
      }

      let tailText: string;
      try {
        tailText = new TextDecoder("utf-8", { fatal: true }).decode(tail);
      } catch (error) {
        throw new EventJournalCorruptionError(args.filePath, args.pendingOrdinal, error);
      }
      if (!tailText.endsWith("\n")) {
        throw new EventJournalCorruptionError(
          args.filePath,
          args.pendingOrdinal,
          "untracked receipt tail has no independent final commit boundary",
        );
      }

      const tailEventIds = new Set<string>();
      const rawLines = tailText.slice(0, -1).split("\n");
      for (let index = 0; index < rawLines.length; index += 1) {
        const rawLine = rawLines[index]!;
        if (rawLine.length === 0) {
          throw new EventJournalCorruptionError(
            args.filePath,
            args.pendingOrdinal + index,
            "untracked receipt tail contains a blank row",
          );
        }
        let event: CalyxStreamEvent;
        try {
          event = parseCalyxStreamEvent(JSON.parse(rawLine) as unknown);
        } catch (error) {
          throw new EventJournalCorruptionError(
            args.filePath,
            args.pendingOrdinal + index,
            error,
          );
        }
        if (isAllocatedGlobalEventCursor(event.cursor)) {
          throw new EventJournalCorruptionError(
            args.filePath,
            args.pendingOrdinal + index,
            "untracked receipt tail contains an allocated authority cursor",
          );
        }
        if (tailEventIds.has(event.event_id)
          || args.database.prepare(
            "SELECT 1 AS present FROM global_event_authority WHERE event_id = ?",
          ).get(event.event_id)) {
          throw new EventJournalCorruptionError(
            args.filePath,
            args.pendingOrdinal + index,
            `untracked receipt tail repeats authority event ${event.event_id}`,
          );
        }
        tailEventIds.add(event.event_id);
      }

      const quarantinedPath = `${args.filePath}.legacy-tail.${Date.now()}.${randomUUID()}`;
      const quarantined = await replaceJsonLinesFileWithQuarantine(
        args.filePath,
        quarantinedPath,
        async (replacement) => {
          const original = await open(args.filePath, "r");
          try {
            const buffer = Buffer.alloc(Math.min(64 * 1024, args.expectedBytes));
            let offset = 0;
            while (offset < args.expectedBytes) {
              const requested = Math.min(buffer.byteLength, args.expectedBytes - offset);
              const read = await original.read(buffer, 0, requested, offset);
              if (read.bytesRead !== requested) {
                throw new EventJournalCorruptionError(
                  args.filePath,
                  args.pendingOrdinal,
                  "authoritative receipt prefix changed during compatibility repair",
                );
              }
              await writeBufferToHandle(replacement, buffer.subarray(0, requested), null);
              offset += requested;
            }
          } finally {
            await original.close();
          }
        },
      );
      if (!quarantined) {
        throw new EventJournalCorruptionError(
          args.filePath,
          args.pendingOrdinal,
          "legacy receipt tail vanished before its source generation could be quarantined",
        );
      }
      return quarantinedPath;
    });
  }

  private warnEventLogMirror(eventId: string, error: unknown): void {
    try {
      process.stderr.write(
        `[calyx-orchestration-ledger] event ingest deferred for ${eventId}: ${(error as Error).message}\n`,
      );
    } catch {
      // Projection warnings never replace the authority receipt.
    }
  }

  private warnPerRunEventProjection(runId: string, error: EventJournalCorruptionError): void {
    try {
      process.stderr.write(
        `[calyx-run-store] per-run event projection deferred for ${runId}: ${error.message}\n`,
      );
    } catch {
      // A diagnostic failure cannot change replay authority.
    }
  }

  private recordPerRunEventProjectionCorruption(
    runId: string,
    error: EventJournalCorruptionError,
  ): void {
    this.corruptPerRunEventProjections.set(runId, error);
    this.warnPerRunEventProjection(runId, error);
  }

  /**
   * Revalidate a process-local corruption hint against the shared projection
   * generation while the cross-process receipt lane is owned. A peer may have
   * quarantined and rebuilt the journal since this RunStore cached the error.
   * Missing marker-zero rows are allowed only for the projector that is about
   * to append them; observation callers require a completely current journal.
   */
  private async revalidateCachedPerRunEventProjectionOwned(
    authority: GlobalEventAuthorityPaths,
    runId: string,
    options: { allowMissingPending: boolean },
  ): Promise<EventJournalCorruptionError | undefined> {
    const cached = this.corruptPerRunEventProjections.get(runId);
    if (!cached) return undefined;
    const filePath = this.paths(runId).eventsPath;
    const throughOrdinal = await this.readPerRunEventAuthorityTail(authority, runId);
    try {
      await this.withEventJournalMutex(filePath, () => this.projectRunAuthorityIntoJournalOwned(
        authority,
        runId,
        filePath,
        {
          appendMissing: false,
          allowMissingPending: options.allowMissingPending,
          throughOrdinal,
        },
      ));
      if (!options.allowMissingPending) {
        const db = await this.openGlobalEventAuthority(authority.databasePath, true);
        try {
          const pending = db.prepare(
            `SELECT 1 AS present FROM global_event_authority
             WHERE run_id = ? AND run_receipt_written = 0 AND ordinal <= ? LIMIT 1`,
          ).get(runId, throughOrdinal);
          if (pending) return cached;
        } finally {
          db.close();
        }
      }
      this.corruptPerRunEventProjections.delete(runId);
      return undefined;
    } catch (error) {
      if (!(error instanceof EventJournalCorruptionError)) throw error;
      this.corruptPerRunEventProjections.set(runId, error);
      return error;
    }
  }

  private async assertGlobalEventReceiptBoundary(
    authority: GlobalEventAuthorityPaths,
  ): Promise<void> {
    const db = await this.openGlobalEventAuthority(authority.databasePath, true);
    let expectedBytes: number;
    try {
      const row = db.prepare(
        "SELECT value FROM global_event_authority_meta WHERE key = 'receipt_bytes'",
      ).get() as { value: string } | undefined;
      if (!row || !/^\d+$/u.test(row.value)) {
        throw new EventJournalCorruptionError(authority.databasePath, 0, "missing receipt byte boundary");
      }
      expectedBytes = Number(row.value);
    } finally {
      db.close();
    }
    const filePath = path.join(authority.physicalRoot, EVENTS_INDEX_FILENAME);
    let actualBytes = 0;
    try {
      actualBytes = (await stat(filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (actualBytes !== expectedBytes) {
      throw new EventJournalCorruptionError(
        filePath,
        0,
        `receipt bytes ${actualBytes} do not match committed boundary ${expectedBytes}`,
      );
    }
  }

  private async validateGlobalEventAuthorityRows(
    authority: GlobalEventAuthorityPaths,
  ): Promise<void> {
    let afterOrdinal = 0n;
    let previousCursor: string | undefined;
    let allocatedCursorSeen = false;
    while (true) {
      const rows = await this.readGlobalEventAuthorityRows(
        authority.databasePath,
        afterOrdinal,
        256,
      );
      if (rows.length === 0) {
        this.validatedGlobalEventAuthorityOrdinal = afterOrdinal;
        this.validatedGlobalEventAuthorityCursor = previousCursor;
        this.validatedGlobalEventAuthorityAllocatedCursorSeen = allocatedCursorSeen;
        return;
      }
      for (const row of rows) {
        const ordinal = BigInt(row.ordinal);
        if (ordinal !== afterOrdinal + 1n) {
          throw new EventJournalCorruptionError(
            authority.databasePath,
            Number(ordinal),
            `authority ordinal ${ordinal} does not follow ${afterOrdinal}`,
          );
        }
        const event = this.parseGlobalEventAuthorityRow(row);
        if (isAllocatedGlobalEventCursor(event.cursor)) {
          if (allocatedCursorSeen
            && previousCursor !== undefined
            && event.cursor <= previousCursor) {
            throw new EventJournalCorruptionError(
              authority.databasePath,
              Number(ordinal),
              `allocated cursor ${event.cursor} is not strictly greater than ${previousCursor}`,
            );
          }
          allocatedCursorSeen = true;
          if (BigInt(event.cursor.slice(3)) !== ordinal) {
            throw new EventJournalCorruptionError(
              authority.databasePath,
              Number(ordinal),
              `allocated cursor does not equal authority ordinal ${ordinal}`,
            );
          }
        } else if (allocatedCursorSeen) {
          throw new EventJournalCorruptionError(
            authority.databasePath,
            Number(ordinal),
            "legacy cursor appears after an allocated cursor",
          );
        }
        previousCursor = event.cursor;
        afterOrdinal = ordinal;
      }
    }
  }

  /**
   * Validate each newly appended raw authority row exactly once before an
   * indexed semantic query can observe it. Identity columns are protected by
   * the SQLite append-only trigger after startup, so the validated high-water
   * remains authoritative while nonmatching tails do not need to be reparsed.
   */
  private async validateGlobalEventAuthorityTail(
    authority: GlobalEventAuthorityPaths,
  ): Promise<bigint> {
    if (this.validatedGlobalEventAuthorityOrdinal === 0n
      && this.validatedGlobalEventAuthorityCursor === undefined) {
      await this.validateGlobalEventAuthorityRows(authority);
      return this.validatedGlobalEventAuthorityOrdinal;
    }
    let afterOrdinal = this.validatedGlobalEventAuthorityOrdinal;
    let previousCursor = this.validatedGlobalEventAuthorityCursor;
    let allocatedCursorSeen = this.validatedGlobalEventAuthorityAllocatedCursorSeen;
    while (true) {
      const rows = await this.readGlobalEventAuthorityRows(
        authority.databasePath,
        afterOrdinal,
        256,
      );
      if (rows.length === 0) {
        if (afterOrdinal > this.validatedGlobalEventAuthorityOrdinal) {
          this.validatedGlobalEventAuthorityOrdinal = afterOrdinal;
          this.validatedGlobalEventAuthorityCursor = previousCursor;
          this.validatedGlobalEventAuthorityAllocatedCursorSeen = allocatedCursorSeen;
        }
        return this.validatedGlobalEventAuthorityOrdinal;
      }
      for (const row of rows) {
        const ordinal = BigInt(row.ordinal);
        if (ordinal !== afterOrdinal + 1n) {
          throw new EventJournalCorruptionError(
            authority.databasePath,
            Number(ordinal),
            `authority ordinal ${ordinal} does not follow ${afterOrdinal}`,
          );
        }
        const event = this.parseGlobalEventAuthorityRow(row);
        if (previousCursor !== undefined && event.cursor <= previousCursor) {
          throw new EventJournalCorruptionError(
            authority.databasePath,
            Number(ordinal),
            `cursor ${event.cursor} is not strictly greater than ${previousCursor}`,
          );
        }
        if (!isAllocatedGlobalEventCursor(event.cursor)
          || BigInt(event.cursor.slice(3)) !== ordinal) {
          throw new EventJournalCorruptionError(
            authority.databasePath,
            Number(ordinal),
            `new authority cursor does not equal authority ordinal ${ordinal}`,
          );
        }
        allocatedCursorSeen = true;
        previousCursor = event.cursor;
        afterOrdinal = ordinal;
      }
    }
  }

  private async validateGlobalEventReceipt(
    authority: GlobalEventAuthorityPaths,
  ): Promise<void> {
    await this.assertGlobalEventReceiptBoundary(authority);
    const db = await this.openGlobalEventAuthority(authority.databasePath, true);
    let expectedCount: bigint;
    try {
      const row = db.prepare(
        "SELECT COUNT(*) AS count FROM global_event_authority",
      ).get() as { count: number | bigint };
      expectedCount = BigInt(row.count);
    } finally {
      db.close();
    }
    if (expectedCount === 0n) return;

    const filePath = path.join(authority.physicalRoot, EVENTS_INDEX_FILENAME);
    let lineNumber = 0n;
    let batchStart = 0n;
    let batch: GlobalEventAuthorityRow[] = [];
    await consumeFatalUtf8Lines(filePath, async (rawLine, physicalLineNumber, terminated) => {
      lineNumber += 1n;
      if (!terminated) {
        throw new EventJournalCorruptionError(
          filePath,
          physicalLineNumber,
          "unterminated final row has no independent commit boundary",
        );
      }
      if (rawLine.length === 0) {
        throw new EventJournalCorruptionError(filePath, physicalLineNumber, "blank receipt row");
      }
      if (batch.length === 0 || lineNumber > batchStart + BigInt(batch.length)) {
        batchStart = lineNumber - 1n;
        batch = await this.readGlobalEventAuthorityRows(
          authority.databasePath,
          batchStart,
          256,
        );
      }
      const row = batch[Number(lineNumber - batchStart - 1n)];
      if (!row) {
        throw new EventJournalCorruptionError(filePath, physicalLineNumber, "receipt has no authority row");
      }
      let receiptEvent: CalyxStreamEvent;
      try {
        receiptEvent = parseCalyxStreamEvent(JSON.parse(rawLine) as unknown);
      } catch (error) {
        throw new EventJournalCorruptionError(filePath, physicalLineNumber, error);
      }
      const authorityEvent = this.parseGlobalEventAuthorityRow(row);
      if (streamEventIdentityHash(receiptEvent, false)
        !== streamEventIdentityHash(authorityEvent, false)) {
        throw new EventJournalCorruptionError(
          filePath,
          physicalLineNumber,
          "receipt row does not exactly match its authority row",
        );
      }
    });
    if (lineNumber !== expectedCount) {
      throw new EventJournalCorruptionError(
        filePath,
        Number(lineNumber + 1n),
        `receipt row count ${lineNumber} does not match authority count ${expectedCount}`,
      );
    }
  }

  private async readPerRunEventAuthorityTail(
    authority: GlobalEventAuthorityPaths,
    runId: string,
  ): Promise<bigint> {
    const db = await this.openGlobalEventAuthority(authority.databasePath, true);
    try {
      const tail = db.prepare(
        `SELECT COALESCE(MAX(ordinal), 0) AS maximum
         FROM global_event_authority WHERE run_id = ?`,
      ).get(runId) as { maximum: number | bigint };
      return BigInt(tail.maximum);
    } finally {
      db.close();
    }
  }

  private parseVerifiedLocalRunJournalEvent(
    value: unknown,
    runId: string,
  ): RecordedRunEvent | undefined {
    const parsed = localRunJournalEventSchema.safeParse(value);
    if (!parsed.success || parsed.data.run_id !== runId) return undefined;
    if ("source" in parsed.data && parsed.data.provenance !== undefined) {
      try {
        validateApiProvenance(parsed.data.provenance as ApiProvenanceV1);
      } catch {
        return undefined;
      }
    }
    return parsed.data as RecordedRunEvent;
  }

  private parseVerifiedRunJournalEvent(
    value: unknown,
    runId: string,
  ): RecordedRunEvent | undefined {
    if (isCalyxRunEvent(value) && value.run.run_id === runId) return value;
    return this.parseVerifiedLocalRunJournalEvent(value, runId);
  }

  private async writeRepairedRunJournal(
    authority: GlobalEventAuthorityPaths,
    runId: string,
    filePath: string,
    throughOrdinal: bigint,
    handle: Awaited<ReturnType<typeof open>>,
  ): Promise<void> {
    const db = await this.openGlobalEventAuthority(authority.databasePath, true);
    try {
      db.exec(`PRAGMA temp_store = FILE;
      CREATE TEMP TABLE preserved_local_run_events (
        source_sequence INTEGER PRIMARY KEY,
        after_authority_ordinal INTEGER NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE INDEX preserved_local_run_events_anchor
        ON preserved_local_run_events(after_authority_ordinal, source_sequence)`);
      const authorityById = db.prepare(
        `SELECT ordinal, event_id, cursor, event_type, run_id, identity_hash,
                event_json, receipt_written, run_receipt_written
         FROM global_event_authority
         WHERE event_id = ? AND run_id = ? AND ordinal <= ?`,
      );
      const preserveLocal = db.prepare(
        `INSERT INTO preserved_local_run_events
           (source_sequence, after_authority_ordinal, event_json)
         VALUES (?, ?, ?)`,
      );
      const localsAfterOrdinal = db.prepare(
        `SELECT event_json FROM preserved_local_run_events
         WHERE after_authority_ordinal = ? ORDER BY source_sequence ASC`,
      );

      let sourceSequence = 0;
      let maximumSeenAuthorityOrdinal = 0n;
      await consumeFatalUtf8Lines(filePath, (rawLine, _lineNumber, terminated) => {
        sourceSequence += 1;
        if (!terminated || rawLine.trim().length === 0) return;
        let value: unknown;
        try {
          value = JSON.parse(rawLine) as unknown;
        } catch {
          return;
        }
        const eventId = streamEventId(value);
        if (eventId) {
          const row = authorityById.get(eventId, runId, throughOrdinal) as GlobalEventAuthorityRow | undefined;
          if (row) {
            const ordinal = BigInt(row.ordinal);
            if (ordinal > maximumSeenAuthorityOrdinal) maximumSeenAuthorityOrdinal = ordinal;
            return;
          }
        }
        const localEvent = this.parseVerifiedLocalRunJournalEvent(value, runId);
        if (localEvent) {
          preserveLocal.run(
            sourceSequence,
            maximumSeenAuthorityOrdinal,
            JSON.stringify(localEvent),
          );
        }
      }, { skipInvalidRows: true });

      const writeLocals = async (afterOrdinal: bigint): Promise<void> => {
        const rows = localsAfterOrdinal.all(afterOrdinal) as Array<{ event_json: string }>;
        for (const row of rows) {
          await writeJsonLineToHandle(handle, JSON.parse(row.event_json) as unknown);
        }
      };
      await writeLocals(0n);

      let afterOrdinal = 0n;
      while (true) {
        const rows = db.prepare(
          `SELECT ordinal, event_id, cursor, event_type, run_id, identity_hash,
                  event_json, receipt_written, run_receipt_written
           FROM global_event_authority
           WHERE run_id = ? AND ordinal > ? AND ordinal <= ?
           ORDER BY ordinal ASC LIMIT 256`,
        ).all(runId, afterOrdinal, throughOrdinal) as GlobalEventAuthorityRow[];
        if (rows.length === 0) break;
        for (const row of rows) {
          await writeJsonLineToHandle(handle, this.parseGlobalEventAuthorityRow(row));
          afterOrdinal = BigInt(row.ordinal);
          await writeLocals(afterOrdinal);
        }
      }
    } finally {
      db.close();
    }
  }

  private async projectRunAuthorityIntoJournalOwned(
    authority: GlobalEventAuthorityPaths,
    runId: string,
    filePath: string,
    options: {
      appendMissing: boolean;
      allowMissingPending: boolean;
      throughOrdinal: bigint;
    },
  ): Promise<void> {
    const authorityDb = await this.openGlobalEventAuthority(authority.databasePath, true);
    try {
      // Projection histories can be much larger than the service heap. Keep
      // the exact-id comparison set in SQLite while both the journal and the
      // authority are consumed in bounded streams.
      authorityDb.exec(`PRAGMA temp_store = FILE;
      CREATE TEMP TABLE verified_run_projection_ids (
        event_id TEXT PRIMARY KEY,
        identity_hash TEXT,
        line_number INTEGER NOT NULL,
        authority_ordinal INTEGER
      ) WITHOUT ROWID`);
      const projectedById = authorityDb.prepare(
        `SELECT identity_hash, line_number, authority_ordinal
         FROM verified_run_projection_ids WHERE event_id = ?`,
      );
      const rememberProjected = authorityDb.prepare(
        `INSERT INTO verified_run_projection_ids
           (event_id, identity_hash, line_number, authority_ordinal)
         VALUES (?, ?, ?, ?)`,
      );
      const authorityById = authorityDb.prepare(
        `SELECT ordinal, event_id, cursor, event_type, run_id, identity_hash,
                event_json, receipt_written, run_receipt_written
         FROM global_event_authority
         WHERE event_id = ? AND run_id = ? AND ordinal <= ?`,
      );

      let lineNumber = 0;
      let previousAuthorityOrdinal = 0n;
      const source = await consumeFatalUtf8Lines(
        filePath,
        (rawLine, physicalLineNumber, terminated) => {
          lineNumber = physicalLineNumber;
          if (!terminated) {
            throw new EventJournalCorruptionError(
              filePath,
              lineNumber,
              "unterminated final row has no independent commit boundary",
            );
          }
          if (isJsonBoundaryWhitespaceOnly(rawLine)) {
            throw new EventJournalCorruptionError(filePath, lineNumber, "blank journal row");
          }
          let existing: unknown;
          try {
            existing = JSON.parse(rawLine) as unknown;
          } catch (error) {
            throw new EventJournalCorruptionError(filePath, lineNumber, error);
          }
          const eventId = streamEventId(existing);
          if (!eventId) {
            if (!this.parseVerifiedLocalRunJournalEvent(existing, runId)) {
              throw new EventJournalCorruptionError(filePath, lineNumber, "row is not a valid run-bound event");
            }
            return;
          }
          const duplicate = projectedById.get(eventId) as
            | { identity_hash: string | null; line_number: number; authority_ordinal: number | bigint | null }
            | undefined;
          if (duplicate) {
            throw new PerRunEventProjectionIdentityConflictError(
              filePath,
              lineNumber,
              eventId,
            );
          }
          let identityHash: string | null = null;
          let authorityOrdinal: bigint | null = null;
          let streamEvent: CalyxStreamEvent | undefined;
          try {
            const candidate = parseCalyxStreamEvent(existing);
            if (isCalyxRunEvent(candidate) && candidate.run.run_id === runId) {
              streamEvent = candidate;
            }
          } catch {
            // The row may still be a strictly valid run-local lifecycle event.
          }
          if (streamEvent) {
            const authorityRow = authorityById.get(
              eventId,
              runId,
              options.throughOrdinal,
            ) as GlobalEventAuthorityRow | undefined;
            if (!authorityRow) {
              throw new PerRunEventProjectionIdentityConflictError(
                filePath,
                lineNumber,
                eventId,
              );
            }
            const authorityEvent = this.parseGlobalEventAuthorityRow(authorityRow);
            identityHash = streamEventIdentityHash(streamEvent, false);
            if (identityHash !== streamEventIdentityHash(authorityEvent, false)) {
              throw new PerRunEventProjectionIdentityConflictError(
                filePath,
                lineNumber,
                eventId,
              );
            }
            authorityOrdinal = BigInt(authorityRow.ordinal);
            if (authorityOrdinal <= previousAuthorityOrdinal) {
              throw new PerRunEventProjectionOrderError(
                filePath,
                lineNumber,
                `global event ${eventId} at authority ordinal ${authorityOrdinal} follows ordinal ${previousAuthorityOrdinal}`,
              );
            }
            previousAuthorityOrdinal = authorityOrdinal;
          } else {
            const localEvent = this.parseVerifiedLocalRunJournalEvent(existing, runId);
            if (!localEvent) {
              throw new EventJournalCorruptionError(filePath, lineNumber, "row is not a valid run-bound event");
            }
            // A non-stream local run event may also carry an event_id. It is
            // valid only while the global authority does not claim that id.
            if (eventId && authorityById.get(eventId, runId, options.throughOrdinal)) {
              throw new PerRunEventProjectionIdentityConflictError(filePath, lineNumber, eventId);
            }
          }
          rememberProjected.run(eventId, identityHash, lineNumber, authorityOrdinal);
        },
      );
      if (source.missing) lineNumber = 0;

      let afterOrdinal = 0n;
      let appended = false;
      let durableParentReady = false;
      while (true) {
        const rows = authorityDb.prepare(
          `SELECT ordinal, event_id, cursor, event_type, run_id, identity_hash,
                  event_json, receipt_written, run_receipt_written
           FROM global_event_authority
           WHERE run_id = ? AND ordinal > ? AND ordinal <= ?
           ORDER BY ordinal ASC LIMIT 256`,
        ).all(runId, afterOrdinal, options.throughOrdinal) as GlobalEventAuthorityRow[];
        if (rows.length === 0) break;
        for (const row of rows) {
          const authorityEvent = this.parseGlobalEventAuthorityRow(row);
          const existing = projectedById.get(row.event_id) as
            | { identity_hash: string | null; line_number: number; authority_ordinal: number | bigint | null }
            | undefined;
          if (existing) {
            if (existing.identity_hash
              !== streamEventIdentityHash(authorityEvent, false)) {
              throw new PerRunEventProjectionIdentityConflictError(
                filePath,
                existing.line_number,
                row.event_id,
              );
            }
          } else if (options.appendMissing) {
            if (BigInt(row.ordinal) < previousAuthorityOrdinal) {
              throw new PerRunEventProjectionOrderError(
                filePath,
                lineNumber + 1,
                `projection omits authority event ${row.event_id} before a later projected event`,
              );
            }
            if (!durableParentReady) {
              await ensureDurableDirectory(path.dirname(filePath));
              durableParentReady = true;
            }
            await this.writeEventLineOwned(filePath, authorityEvent);
            lineNumber += 1;
            rememberProjected.run(
              row.event_id,
              streamEventIdentityHash(authorityEvent, false),
              lineNumber,
              row.ordinal,
            );
            previousAuthorityOrdinal = BigInt(row.ordinal);
            appended = true;
          } else if (!(options.allowMissingPending && Number(row.run_receipt_written) === 0)) {
            throw new EventJournalCorruptionError(
              filePath,
              lineNumber + 1,
              `projection omits authority event ${row.event_id}`,
            );
          }
          afterOrdinal = BigInt(row.ordinal);
        }
      }
      if (appended) await syncDirectory(path.dirname(filePath));
    } finally {
      authorityDb.close();
    }
  }

  private async setPerRunEventProjectionMarkers(
    authority: GlobalEventAuthorityPaths,
    runId: string,
    written: 0 | 1,
    throughOrdinal: bigint,
  ): Promise<void> {
    const db = await this.openGlobalEventAuthority(authority.databasePath);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `UPDATE global_event_authority SET run_receipt_written = ?
           WHERE run_id = ? AND ordinal <= ?`,
        ).run(written, runId, throughOrdinal);
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Closing below releases the writer lock.
        }
        throw error;
      }
    } finally {
      db.close();
    }
  }

  private async reconcilePerRunEventReceipts(
    authority: GlobalEventAuthorityPaths,
  ): Promise<void> {
    let afterRunId = "";
    while (true) {
      const db = await this.openGlobalEventAuthority(authority.databasePath, true);
      let runIds: string[];
      try {
        const rows = db.prepare(
          `SELECT DISTINCT run_id FROM global_event_authority
           WHERE run_id IS NOT NULL AND run_id > ?
           ORDER BY run_id ASC LIMIT 128`,
        ).all(afterRunId) as Array<{ run_id: string }>;
        runIds = rows.map((row) => row.run_id);
      } finally {
        db.close();
      }
      if (runIds.length === 0) return;
      for (const runId of runIds) {
        const filePath = this.paths(runId).eventsPath;
        const throughOrdinal = await this.readPerRunEventAuthorityTail(authority, runId);
        try {
          await this.withEventJournalMutex(filePath, () => this.projectRunAuthorityIntoJournalOwned(
            authority,
            runId,
            filePath,
            { appendMissing: true, allowMissingPending: false, throughOrdinal },
          ));
        } catch (error) {
          if (!(error instanceof EventJournalCorruptionError)) throw error;
          // The per-run journal is a projection, and RunService reconciliation
          // owns the authority-aware quarantine decision. Do not let a corrupt
          // projection block the global replay authority or silently mark the
          // projection current.
          this.recordPerRunEventProjectionCorruption(runId, error);
          afterRunId = runId;
          continue;
        }
        await this.setPerRunEventProjectionMarkers(authority, runId, 1, throughOrdinal);
        this.corruptPerRunEventProjections.delete(runId);
        afterRunId = runId;
      }
    }
  }

  private async mirrorAuthorityToEventLog(strict = false): Promise<void> {
    if (!this.eventLogIngest) return;
    const authority = await this.ensureGlobalEventAuthority();
    while (true) {
      const rows = await this.readGlobalEventAuthorityRows(
        authority.databasePath,
        this.mirroredAuthorityOrdinal,
        256,
      );
      if (rows.length === 0) return;
      for (const row of rows) {
        const event = this.parseGlobalEventAuthorityRow(row);
        let outcome: IngestOutcome;
        try {
          outcome = await this.eventLogIngest(event);
        } catch (error) {
          this.warnEventLogMirror(event.event_id, error);
          if (strict) throw error;
          return;
        }
        // A quarantined event was durably set aside with both versions
        // recorded; the mirror is intact and must keep advancing. Only a
        // disabled/skipped sink is a mirror failure.
        if (outcome.status === "quarantined") {
          this.mirroredAuthorityOrdinal = BigInt(row.ordinal);
          continue;
        }
        if (outcome.status !== "ingested") {
          const error = new Error(outcome.reason);
          this.warnEventLogMirror(event.event_id, error);
          if (strict) throw error;
          return;
        }
        this.mirroredAuthorityOrdinal = BigInt(row.ordinal);
      }
    }
  }

  async readEvents(runId: string): Promise<RecordedRunEvent[]> {
    if (this.corruptPerRunEventProjections.has(runId)) {
      const authority = await this.ensureGlobalEventAuthority();
      const knownCorruption = await withSqliteMutex(
        authority.receiptMutexPath,
        () => this.revalidateCachedPerRunEventProjectionOwned(
          authority,
          runId,
          { allowMissingPending: false },
        ),
        { acquireTimeoutMs: null },
      );
      if (knownCorruption) throw knownCorruption;
    }
    const filePath = this.paths(runId).eventsPath;
    const eventIds = new Set<string>();
    try {
      return await this.readEventLines<RecordedRunEvent>(filePath, (event, lineNumber) => {
        const verified = this.parseVerifiedRunJournalEvent(event, runId);
        if (!verified) {
          throw new EventJournalCorruptionError(filePath, lineNumber, "row is not a valid run-bound event");
        }
        const eventId = streamEventId(event);
        if (eventId && eventIds.has(eventId)) {
          throw new PerRunEventProjectionIdentityConflictError(
            filePath,
            lineNumber,
            eventId,
          );
        }
        if (eventId) eventIds.add(eventId);
        return verified;
      });
    } catch (error) {
      if (error instanceof EventJournalCorruptionError) {
        this.recordPerRunEventProjectionCorruption(runId, error);
      }
      throw error;
    }
  }

  async *readEventsSince(
    cursor: string | undefined,
    filter: CalyxRunEventFilter = {},
  ): AsyncIterable<CalyxStreamEvent> {
    const authority = await this.requireGlobalEventAuthorityPrepared();
    const validatedThroughOrdinal = await this.validateGlobalEventAuthorityTail(authority);
    let afterOrdinal = 0n;
    if (cursor) {
      await this.assertGlobalEventReplayCursor(cursor);
      const db = await this.openGlobalEventAuthority(authority.databasePath, true);
      try {
        const row = db.prepare(
          "SELECT ordinal FROM global_event_authority WHERE cursor = ?",
        ).get(cursor) as { ordinal: number | bigint };
        afterOrdinal = BigInt(row.ordinal);
      } finally {
        db.close();
      }
    }
    while (true) {
      const rows = await this.readGlobalEventAuthorityRows(
        authority.databasePath,
        afterOrdinal,
        256,
        filter,
        validatedThroughOrdinal,
      );
      if (rows.length === 0) return;
      for (const row of rows) {
        afterOrdinal = BigInt(row.ordinal);
        yield this.parseGlobalEventAuthorityRow(row);
      }
    }
  }

  /**
   * Inspect an already-materialized global event authority without importing,
   * repairing, creating directories, or taking a mutation mutex. This is the
   * read-only boundary used by pre-deploy authority audits.
   */
  async inspectExistingEventAuthority(
    filter: CalyxRunEventFilter = {},
  ): Promise<{ source: "sqlite" | "legacy_jsonl"; events: CalyxStreamEvent[] }> {
    let physicalRoot: string;
    try {
      physicalRoot = await realpath(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new EventAuthorityNotPreparedError();
      }
      throw error;
    }
    const databasePath = path.join(physicalRoot, "events.authority.sqlite3");
    let sqlitePresent = true;
    try {
      await access(databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        sqlitePresent = false;
      } else {
        throw error;
      }
    }
    if (sqlitePresent) {
      const db = await this.openGlobalEventAuthority(databasePath, true);
      try {
        const quickCheck = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
        if (!quickCheck || !Object.values(quickCheck).includes("ok")) {
          throw new EventJournalCorruptionError(databasePath, 0, "SQLite quick_check failed");
        }
        const schemaVersion = db.prepare(
          "SELECT value FROM global_event_authority_meta WHERE key = 'schema_version'",
        ).get() as { value: string } | undefined;
        const initialized = db.prepare(
          "SELECT value FROM global_event_authority_meta WHERE key = 'initialized'",
        ).get() as { value: string } | undefined;
        if (schemaVersion?.value !== "1" || initialized?.value !== "1") {
          throw new EventJournalCorruptionError(
            databasePath,
            0,
            `global event authority is not initialized at schema version 1 (schema=${schemaVersion?.value ?? "missing"}, initialized=${initialized?.value ?? "missing"})`,
          );
        }
        const bounds = db.prepare(
          `SELECT COUNT(*) AS count, COALESCE(MIN(ordinal), 0) AS minimum,
                  COALESCE(MAX(ordinal), 0) AS maximum
           FROM global_event_authority`,
        ).get() as { count: number | bigint; minimum: number | bigint; maximum: number | bigint };
        const count = BigInt(bounds.count);
        if ((count === 0n && BigInt(bounds.maximum) !== 0n)
          || (count > 0n && (BigInt(bounds.minimum) !== 1n || BigInt(bounds.maximum) !== count))) {
          throw new EventJournalCorruptionError(databasePath, 0, "authority ordinal sequence is not contiguous");
        }
      } finally {
        db.close();
      }

      const events: CalyxStreamEvent[] = [];
      let afterOrdinal = 0n;
      while (true) {
        const rows = await this.readGlobalEventAuthorityRows(databasePath, afterOrdinal, 256);
        if (rows.length === 0) return { source: "sqlite", events };
        for (const row of rows) {
          afterOrdinal = BigInt(row.ordinal);
          const event = this.parseGlobalEventAuthorityRow(row);
          if ((!filter.event_type || event.event_type === filter.event_type)
            && (!filter.run_id || (isCalyxRunEvent(event) && event.run.run_id === filter.run_id))) {
            events.push(event);
          }
        }
      }
    }

    const legacyPath = path.join(physicalRoot, "events.index.jsonl");
    try {
      await access(legacyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new EventAuthorityNotPreparedError();
      }
      throw error;
    }
    const events: CalyxStreamEvent[] = [];
    const eventIds = new Set<string>();
    const cursors = new Set<string>();
    let ordinal = 0n;
    let allocatedCursorSeen = false;
    await consumeFatalUtf8Lines(legacyPath, async (rawLine, lineNumber, terminated) => {
      if (!terminated) {
        throw new EventJournalCorruptionError(
          legacyPath,
          lineNumber,
          "unterminated final row has no independent commit boundary",
        );
      }
      if (rawLine.trim().length === 0) {
        throw new EventJournalCorruptionError(legacyPath, lineNumber, "blank receipt row");
      }
      let event: CalyxStreamEvent;
      try {
        event = parseCalyxStreamEvent(JSON.parse(rawLine) as unknown);
        ordinal += 1n;
        if (eventIds.has(event.event_id)) throw new Error(`duplicate event_id ${event.event_id}`);
        if (cursors.has(event.cursor)) throw new Error(`duplicate cursor ${event.cursor}`);
        if (isAllocatedGlobalEventCursor(event.cursor)) {
          allocatedCursorSeen = true;
          if (BigInt(event.cursor.slice(3)) !== ordinal) {
            throw new Error(`allocated cursor ordinal must equal journal event ordinal ${ordinal}`);
          }
        } else if (allocatedCursorSeen) {
          throw new Error("legacy cursor appears after an allocated cursor");
        }
      } catch (error) {
        throw new EventJournalCorruptionError(legacyPath, lineNumber, error);
      }
      eventIds.add(event.event_id);
      cursors.add(event.cursor);
      if ((!filter.event_type || event.event_type === filter.event_type)
        && (!filter.run_id || (isCalyxRunEvent(event) && event.run.run_id === filter.run_id))) {
        events.push(event);
      }
    });
    return { source: "legacy_jsonl", events };
  }

  /** Fail-closed integrity preflight for the global replay authority. */
  async assertGlobalEventIndexReadable(): Promise<void> {
    const authority = await this.ensureGlobalEventAuthority();
    await withSqliteMutex(authority.mutationMutexPath, async () => {
      await this.reconcileGlobalEventAuthorityOwned(authority);
    }, { acquireTimeoutMs: null });
  }

  private async reconcileGlobalEventAuthorityOwned(
    authority: GlobalEventAuthorityPaths,
  ): Promise<void> {
    const db = await this.openGlobalEventAuthority(authority.databasePath, true);
    try {
      const quickCheck = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
      if (!quickCheck || !Object.values(quickCheck).includes("ok")) {
        throw new EventJournalCorruptionError(authority.databasePath, 0, "SQLite quick_check failed");
      }
      const bounds = db.prepare(
        `SELECT COUNT(*) AS count, COALESCE(MIN(ordinal), 0) AS minimum,
                COALESCE(MAX(ordinal), 0) AS maximum
         FROM global_event_authority`,
      ).get() as { count: number | bigint; minimum: number | bigint; maximum: number | bigint };
      const count = BigInt(bounds.count);
      if ((count === 0n && BigInt(bounds.maximum) !== 0n)
        || (count > 0n && (BigInt(bounds.minimum) !== 1n || BigInt(bounds.maximum) !== count))) {
        throw new EventJournalCorruptionError(authority.databasePath, 0, "authority ordinal sequence is not contiguous");
      }
      const schemaVersion = db.prepare(
        "SELECT value FROM global_event_authority_meta WHERE key = 'schema_version'",
      ).get() as { value: string } | undefined;
      if (schemaVersion?.value !== "1") {
        throw new EventJournalCorruptionError(
          authority.databasePath,
          0,
          `unsupported global event authority schema version ${schemaVersion?.value ?? "missing"}`,
        );
      }
    } finally {
      db.close();
    }
    await this.validateGlobalEventAuthorityRows(authority);
    await withSqliteMutex(authority.receiptMutexPath, async () => {
      await this.projectGlobalEventReceiptsOwned(authority, {
      });
      await this.reconcilePerRunEventReceipts(authority);
      await this.mirrorAuthorityToEventLog(true);
      await this.validateGlobalEventReceipt(authority);
    }, { acquireTimeoutMs: null });
  }

  /** Reject malformed, unknown, and future replay cursors before streaming begins. */
  async assertGlobalEventReplayCursor(cursor: string | undefined): Promise<void> {
    if (cursor === undefined) return;
    if (!isGlobalEventCursor(cursor)) throw new EventReplayCursorError(cursor, "malformed");
    const authority = await this.requireGlobalEventAuthorityPrepared();
    const db = await this.openGlobalEventAuthority(authority.databasePath, true);
    try {
      const exact = db.prepare(
        "SELECT 1 AS present FROM global_event_authority WHERE cursor = ?",
      ).get(cursor);
      if (exact) return;
      if (isAllocatedGlobalEventCursor(cursor)) {
        const tail = db.prepare(
          "SELECT COALESCE(MAX(ordinal), 0) AS maximum FROM global_event_authority",
        ).get() as { maximum: number | bigint };
        if (BigInt(cursor.slice(3)) > BigInt(tail.maximum)) {
          throw new EventReplayCursorError(cursor, "future");
        }
      }
      throw new EventReplayCursorError(cursor, "unknown");
    } finally {
      db.close();
    }
  }

  async hasTerminalEventForRun(runId: string): Promise<boolean> {
    const runEvents = await this.readEvents(runId);
    const localHasTerminal = runEvents.some((event) => isRunTerminalEvent(event));
    if (!localHasTerminal) return false;
    for await (const event of this.readEventsSince(undefined, {
      run_id: runId,
      event_type: "run.terminal",
    })) {
      if (isRunTerminalEvent(event)) return true;
    }
    return false;
  }

  async listRunIds(): Promise<string[]> {
    await this.ensureRoot();
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && isCanonicalRunId(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  /**
   * Snapshot every run identity reconciliation must account for. The durable
   * projection is deliberately part of this estate: a missing directory or
   * `run_record.json` is damage to classify, not evidence that an indexed run
   * can be forgotten.
   */
  async listReconcileRunIds(): Promise<string[]> {
    const runIds = new Set(await this.listRunIds());
    if (this.runIndexProjection) {
      const listed = await this.runIndexProjection.list();
      if (listed.status === "listed") {
        for (const row of listed.rows) runIds.add(row.run_id);
      }
    }
    return [...runIds].sort();
  }

  async inspectNonCanonicalRunDirectories(): Promise<NonCanonicalRunDirectoryDisposition[]> {
    await this.ensureRoot();
    const entries = await readdir(this.root, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !isCanonicalRunId(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    const dispositions: NonCanonicalRunDirectoryDisposition[] = [];

    for (const entry of candidates) {
      const sourcePath = path.join(this.root, entry.name);
      let legacyRecord: unknown;
      try {
        legacyRecord = JSON.parse(await readFile(path.join(sourcePath, "run_record.json"), "utf8")) as unknown;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        dispositions.push({
          directory_name: entry.name,
          status: "requires_operator_migration",
          reason: NON_CANONICAL_RUN_ID_REASON,
          detail: code === "ENOENT"
            ? "authoritative run_record.json is missing"
            : `authoritative run_record.json is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      const recordState = legacyRecord && typeof legacyRecord === "object" && !Array.isArray(legacyRecord)
        ? (legacyRecord as Record<string, unknown>)["state"]
        : undefined;
      dispositions.push({
        directory_name: entry.name,
        status: "requires_operator_migration",
        reason: NON_CANONICAL_RUN_ID_REASON,
        ...(typeof recordState === "string" ? { record_state: recordState } : {}),
        detail: typeof recordState !== "string"
          ? "authoritative run state is missing or invalid"
          : TERMINAL_STATES.has(recordState as RunState)
            ? "terminal state does not prove legacy writers are quiescent; the directory is preserved until an operator migrates its identity"
            : "nonterminal legacy runs are preserved until an operator migrates their identity",
      });
    }

    return dispositions;
  }

  async listRuns(): Promise<RunListEntry[]> {
    if (this.runIndexProjection) {
      const authority = await this.ensureRunIndexReadAuthority();
      if (authority !== "ready") {
        return this.collectEntriesFromRecords();
      }
      await this.ensureFirstListRebuild();
      const listed = await this.runIndexProjection.list();
      if (listed.status === "listed") {
        return listed.rows.map(indexRowToRunListEntry);
      }
      // Projection disabled (migration 0003 not applied / DB unavailable).
      // Wave 2.2 contract: no fallback to index.jsonl. Read directly from
      // authoritative run_record.json files so callers still get the
      // right answer.
      return this.collectEntriesFromRecords();
    }
    // No projection wired (e.g. tests that build RunStore directly without
    // a SQLite state DB). Fall back to authoritative records — never to
    // index.jsonl, which no longer exists.
    return this.collectEntriesFromRecords();
  }

  async listRunsPage(options: RunListPageOptions): Promise<RunListEntry[]> {
    return (await this.listRunsSnapshotPage(options)).entries;
  }

  async listRunsSnapshotPage(options: RunListPageOptions): Promise<RunListSnapshotPage> {
    const normalizedOptions: RunListPageOptions = {
      ...options,
      ...(options.host ? { host: parseShortHostname(options.host) } : {}),
    };
    const expectedFingerprint = parseRunIndexMembershipFence(
      normalizedOptions.expected_membership_fence,
    );
    if (this.runIndexProjection) {
      const authority = await this.ensureRunIndexReadAuthority();
      if (authority === "degraded") {
        throw new RunIndexProjectionNotReadyError(
          "SQLite run-index projection is durably marked degraded; authoritative repair is pending",
        );
      }
      await this.ensureFirstListRebuild();
      try {
        const listed = await this.runIndexProjection.listSnapshotPage({
          ...(normalizedOptions.host ? { host: normalizedOptions.host } : {}),
          ...(normalizedOptions.backend ? { backend: normalizedOptions.backend } : {}),
          ...(normalizedOptions.updated_since ? { updated_since: normalizedOptions.updated_since } : {}),
          ...(normalizedOptions.created_since ? { created_since: normalizedOptions.created_since } : {}),
          ...(normalizedOptions.created_before ? { created_before: normalizedOptions.created_before } : {}),
          ...(normalizedOptions.after ? { after: normalizedOptions.after } : {}),
          ...(expectedFingerprint !== undefined
            ? { expected_membership_fingerprint: expectedFingerprint }
            : {}),
          limit: normalizedOptions.limit,
        });
        if (listed.status === "listed") {
          return {
            entries: listed.rows.map(indexRowToRunListEntry),
            membershipFence: formatRunIndexMembershipFence(listed.membershipFingerprint),
          };
        }
        throw new RunIndexProjectionNotReadyError(listed.reason);
      } catch (error) {
        if (error instanceof RunIndexMembershipFingerprintMismatchError) {
          throw new RunListSnapshotChangedError();
        }
        throw error;
      }
    }
    throw new RunIndexProjectionNotReadyError("SQLite run-index projection is not configured");
  }

  async listActiveRuns(): Promise<RunListEntry[]> {
    if (this.runIndexProjection) {
      const authority = await this.ensureRunIndexReadAuthority();
      if (authority !== "ready") {
        return (await this.collectEntriesFromRecords())
          .filter((entry) => !isTerminalState(entry.state));
      }
      await this.ensureFirstListRebuild();
      const listed = await this.runIndexProjection.listActive(Array.from(TERMINAL_STATES));
      if (listed.status === "listed") {
        return listed.rows.map(indexRowToRunListEntry);
      }
    }
    return (await this.listRuns()).filter((entry) => !isTerminalState(entry.state));
  }

  /**
   * Honor the durable cross-process degraded fence before trusting SQLite.
   * A reader that observes the fence owns one synchronous full repair. If
   * convergence still fails, ordinary lists fall back to authoritative JSON
   * and snapshot-paged reads fail closed.
   */
  private async ensureRunIndexReadAuthority(): Promise<"ready" | "degraded" | "disabled"> {
    if (!this.runIndexProjection) return "disabled";
    const marker = await this.runIndexProjection.readProjectionDegradedMarker();
    if (marker.status === "disabled") return "disabled";
    if (marker.status === "absent") return "ready";

    const repair = await this.rebuildRunIndex().catch((error: unknown) => ({
      entries: [],
      missingRecordRunIds: [],
      projection: {
        status: "failed" as const,
        reason: error instanceof Error ? error.message : String(error),
      },
    }));
    if (repair.projection.status === "repaired") return "ready";

    let runId = "durable-degraded-marker";
    try {
      const parsed = JSON.parse(marker.value) as { run_id?: unknown };
      if (typeof parsed.run_id === "string" && parsed.run_id.length > 0) {
        runId = parsed.run_id;
      }
    } catch {
      // The marker's presence, not its diagnostic JSON, is the read fence.
    }
    this.scheduleRunIndexRepair(
      runId,
      repair.projection.status === "failed"
        ? repair.projection.reason
        : "run_index projection is not configured",
    );
    return "degraded";
  }

  /**
   * Gate the one-time post-migration backfill of `run_index` from
   * authoritative `run_record.json` files. The marker that records
   * "this DB has been backfilled" lives in SQLite (`state_meta` row
   * keyed by `run_index.initial_backfill_completed_at`), so:
   *
   *   - the first list call against a fresh state DB (no marker)
   *     scans run directories, then atomically merges those rows and
   *     writes the marker;
   *   - every subsequent process (including short-lived CLI commands
   *     that build a new `RunStore` per invocation) sees the marker
   *     and reads SQLite directly;
   *   - the disabled-projection path (DB missing / migration not
   *     applied) is a no-op here — callers fall through to direct
   *     `run_record.json` reads.
   *
   * Concurrent first-list callers within a single process share the
   * `firstListRebuildPromise` latch so the SQLite read + optional
   * rebuild runs at most once per RunStore instance.
   */
  private async ensureFirstListRebuild(): Promise<void> {
    if (!this.runIndexProjection) return;
    if (!this.firstListRebuildPromise) {
      this.firstListRebuildPromise = this.runFirstListRebuild();
    }
    await this.firstListRebuildPromise;
  }

  private async runFirstListRebuild(): Promise<void> {
    if (!this.runIndexProjection) return;
    const marker = await this.runIndexProjection.readInitialBackfillMarker();
    if (marker.status === "present") {
      // Steady-state path: another process (or an earlier instance in
      // this one) already backfilled the table. SQLite is the source
      // of truth from here on.
      return;
    }
    if (marker.status === "disabled") {
      // Projection unavailable — disabled-outcome warnings have already
      // been logged once by RunIndexProjection. Fall through to record
      // scans on the list path.
      return;
    }
    const entries = await this.collectEntriesFromRecords();
    const merged = await this.runIndexProjection.mergeInitialBackfill(
      entries.map(runListEntryToIndexRow),
    );
    if (merged.status === "disabled") {
      // The transactional merge itself disabled the projection — leave the marker
      // alone and let the list path fall back to record scans.
      return;
    }
  }

  /**
   * Rebuild the SQLite `run_index` from authoritative `run_record.json`
   * files. Used by `RunService.reconcile()` as the always-safe repair
   * path for the index. Refreshes the initial-backfill marker so a
   * fresh DB reconciled before any list call still records that the
   * backfill happened.
   */
  async rebuildRunIndex(): Promise<{
    entries: RunListEntry[];
    missingRecordRunIds: string[];
    projection: RunIndexRepairOutcome;
  }> {
    if (!this.runIndexProjection) {
      return {
        entries: await this.collectEntriesFromRecords(),
        missingRecordRunIds: [],
        projection: { status: "not_configured" },
      };
    }
    return withSqliteMutex(
      path.join(this.root, "run-index-projection.mutex.sqlite3"),
      () => withSqliteBusyRetry(async () => {
        const entries = await this.collectEntriesFromRecords();
        const entryRunIds = new Set(entries.map((entry) => entry.run_id));
        const prior = await this.runIndexProjection!.list();
        if (prior.status === "disabled") {
          return {
            entries,
            missingRecordRunIds: [],
            projection: { status: "failed", reason: prior.reason } as const,
          };
        }
        const missingRecordRunIds: string[] = [];
        for (const row of prior.rows) {
          if (entryRunIds.has(row.run_id)) continue;
          missingRecordRunIds.push(row.run_id);
          entries.push(indexRowToRunListEntry(row));
          entryRunIds.add(row.run_id);
        }
        entries.sort((left, right) => left.run_id.localeCompare(right.run_id));
        const replaced = await this.runIndexProjection!.replace(
          entries.map(runListEntryToIndexRow),
        );
        if (replaced.status === "disabled") {
          return {
            entries,
            missingRecordRunIds,
            projection: { status: "failed", reason: replaced.reason } as const,
          };
        }
        const marker = await this.runIndexProjection!.writeInitialBackfillMarker();
        if (marker.status === "disabled") {
          return {
            entries,
            missingRecordRunIds,
            projection: { status: "failed", reason: marker.reason } as const,
          };
        }
        const cleared = await this.runIndexProjection!.clearProjectionDegradedMarker();
        if (cleared.status === "disabled") {
          return {
            entries,
            missingRecordRunIds,
            projection: { status: "failed", reason: cleared.reason } as const,
          };
        }
        // Reconcile has just performed an authoritative rebuild — the
        // first-list latch is satisfied without an additional check.
        this.firstListRebuildPromise = Promise.resolve();
        this.pendingRunIndexRepairs.clear();
        return {
          entries,
          missingRecordRunIds,
          projection: { status: "repaired", rowCount: replaced.rowCount } as const,
        };
      }),
      // Every ordinary projection mutation uses the same no-loss wait policy;
      // a live rebuild may be slow, while a crashed owner releases SQLite's
      // transaction lock automatically.
      { acquireTimeoutMs: null },
    );
  }

  private async collectEntriesFromRecords(): Promise<RunListEntry[]> {
    await this.ensureRoot();
    const runIds = await this.listRunIds();
    const entries: RunListEntry[] = [];
    for (const runId of runIds) {
      const record = await this.readRunRecord(runId);
      if (!record) {
        continue;
      }
      if (runRecordIdentityMismatch(runId, record)) {
        throw new Error(
          `Run directory ${runId} contains mismatched record identity; run reconciliation before listing runs.`,
        );
      }
      entries.push(toRunListEntry(this.root, record));
    }
    return entries.sort((left, right) => left.run_id.localeCompare(right.run_id));
  }

  async runExists(runId: string): Promise<boolean> {
    const runDir = this.paths(runId).runDir;
    try {
      const stats = await stat(runDir);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  async summarizeReconcile(
    result: ReconcileResult,
    options: { provenance?: ApiProvenanceV1 | undefined } = {},
  ): Promise<void> {
    await writeJsonFile(path.join(this.root, "last_reconcile.json"), {
      ...result,
      batch_atomic: false,
      run_index_authority: "derived_projection",
      ...(options.provenance
        ? { provenance: validateApiProvenance(options.provenance) }
        : {}),
    });
  }

  private async appendEventLine(filePath: string, event: RecordedRunEvent | CalyxStreamEvent): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await this.withEventJournalMutex(filePath, async () => {
      const appended = await this.appendEventLineOwned(filePath, event);
      if (appended) {
        await syncDirectory(path.dirname(filePath));
      }
    });
  }

  private async appendDurableEventLine(
    filePath: string,
    event: RecordedRunEvent | CalyxStreamEvent,
  ): Promise<void> {
    const parent = path.dirname(filePath);
    const runsRoot = path.dirname(parent);
    await mkdir(parent, { recursive: true });
    await this.withEventJournalMutex(filePath, async () => {
      const appended = await this.appendEventLineOwned(filePath, event);
      if (appended) {
        // Conservatively persist the complete authority chain while journal
        // ownership prevents quarantine or another append from interleaving.
        await syncDirectory(parent);
        await syncDirectory(runsRoot);
        await syncDirectory(path.dirname(runsRoot));
      }
    });
  }

  private async appendEventLineOwned(
    filePath: string,
    event: RecordedRunEvent | CalyxStreamEvent,
  ): Promise<boolean> {
    // Refuse oversized producer rows before schema discrimination. Besides
    // keeping the journal writable, this prevents validators from cloning or
    // formatting an input that is already outside the physical row contract.
    const serializedEvent = serializeBoundedEventJournalRow(event);
    const existing = await this.readEventLinesOwned(filePath);
    if (isCalyxStreamEvent(event)) {
      const duplicateIndexes = existing.flatMap((candidate, index) => (
        streamEventId(candidate) === event.event_id ? [index] : []
      ));
      if (duplicateIndexes.length === 0) {
        await this.writeEventLineOwned(filePath, event, serializedEvent);
        return true;
      }
      if (duplicateIndexes.length > 1) {
        throw new PerRunEventProjectionIdentityConflictError(
          filePath,
          duplicateIndexes[1]! + 1,
          event.event_id,
        );
      }
      const duplicateIndex = duplicateIndexes[0]!;
      const duplicate = existing[duplicateIndex]!;
      let parsedDuplicate: CalyxStreamEvent;
      try {
        parsedDuplicate = parseCalyxStreamEvent(duplicate);
      } catch {
        throw new PerRunEventProjectionIdentityConflictError(
          filePath,
          duplicateIndex + 1,
          event.event_id,
        );
      }
      if (streamEventIdentityHash(parsedDuplicate, false) !== streamEventIdentityHash(event, false)) {
        throw new PerRunEventProjectionIdentityConflictError(
          filePath,
          duplicateIndex + 1,
          event.event_id,
        );
      }
      return false;
    }
    await this.writeEventLineOwned(filePath, event, serializedEvent);
    return true;
  }

  private async writeEventLineOwned(
    filePath: string,
    event: RecordedRunEvent | CalyxStreamEvent,
    serializedEvent = serializeBoundedEventJournalRow(event),
  ): Promise<void> {
    const handle = await open(filePath, "a");
    try {
      await writeBufferToHandle(handle, serializedEvent, null);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async readEventLines<T>(
    filePath: string,
    validate?: ((value: unknown, lineNumber: number) => T) | undefined,
  ): Promise<T[]> {
    return this.withEventJournalMutex(filePath, () => this.readEventLinesOwned<T>(filePath, validate));
  }

  private async eventJournalMutexPath(filePath: string): Promise<string> {
    const authority = await this.resolveGlobalEventAuthorityPaths();
    const relativePath = path.relative(this.root, path.resolve(filePath));
    const digest = hashCanonicalJcs({ relative_path: relativePath });
    return path.join(authority.physicalRoot, ".mutexes", `event-journal.${digest}.sqlite3`);
  }

  private async withEventJournalMutex<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const mutexPath = await this.eventJournalMutexPath(filePath);
    return withSqliteMutex(mutexPath, operation, { acquireTimeoutMs: null });
  }

  private async readEventLinesOwned<T>(
    filePath: string,
    validate?: ((value: unknown, lineNumber: number) => T) | undefined,
  ): Promise<T[]> {
    const events: T[] = [];
    await consumeFatalUtf8Lines(filePath, (rawLine, lineNumber, terminated) => {
      if (!terminated) {
        throw new EventJournalCorruptionError(
          filePath,
          lineNumber,
          "unterminated final row has no independent commit boundary",
        );
      }
      if (isJsonBoundaryWhitespaceOnly(rawLine)) {
        throw new EventJournalCorruptionError(filePath, lineNumber, "blank journal row");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawLine) as unknown;
      } catch (error) {
        throw new EventJournalCorruptionError(filePath, lineNumber, error);
      }
      events.push(validate ? validate(parsed, lineNumber) : parsed as T);
    });
    return events;
  }

  async quarantineEventJournal(runId: string): Promise<string | undefined> {
    const filePath = this.paths(runId).eventsPath;
    if (!this.corruptPerRunEventProjections.has(runId)) {
      try {
        const rows = await this.readEventLines<RecordedRunEvent>(filePath, (event, lineNumber) => {
          const verified = this.parseVerifiedRunJournalEvent(event, runId);
          if (!verified) {
            throw new EventJournalCorruptionError(filePath, lineNumber, "row is not a valid run-bound event");
          }
          return verified;
        });
        const eventIds = new Set<string>();
        for (let index = 0; index < rows.length; index += 1) {
          const eventId = streamEventId(rows[index]);
          if (!eventId) continue;
          if (eventIds.has(eventId)) {
            throw new PerRunEventProjectionIdentityConflictError(
              filePath,
              index + 1,
              eventId,
            );
          }
          eventIds.add(eventId);
        }
        return undefined;
      } catch (error) {
        if (!(error instanceof EventJournalCorruptionError) || error.filePath !== filePath) throw error;
        this.recordPerRunEventProjectionCorruption(runId, error);
      }
    }

    const authority = await this.ensureGlobalEventAuthority();
    return withSqliteMutex(authority.receiptMutexPath, () => this.withEventJournalMutex(
      filePath,
      async () => {
        // This tail is the immutable repair boundary. Same-run rows committed
        // after it retain their default marker-zero state and are projected by
        // the appender once this receipt lane is released.
        const throughOrdinal = await this.readPerRunEventAuthorityTail(authority, runId);
        try {
          // A peer may already have repaired the generation that produced the
          // cached error. Exact authority comparison, not process memory,
          // decides whether quarantine is still necessary.
          await this.projectRunAuthorityIntoJournalOwned(
            authority,
            runId,
            filePath,
            { appendMissing: false, allowMissingPending: false, throughOrdinal },
          );
          await this.setPerRunEventProjectionMarkers(authority, runId, 1, throughOrdinal);
          this.corruptPerRunEventProjections.delete(runId);
          return undefined;
        } catch (error) {
          if (!(error instanceof EventJournalCorruptionError)) throw error;
          this.corruptPerRunEventProjections.set(runId, error);
        }

        // Invalidate every durable marker before removing the old generation.
        // Any crash from this point leaves SQLite demanding a full replay while
        // the old live generation remains present until the prepared stream is
        // fsynced and atomically promoted.
        await this.setPerRunEventProjectionMarkers(authority, runId, 0, throughOrdinal);
        const quarantinedPath = `${filePath}.corrupt.${Date.now()}.${randomUUID()}`;

        try {
          const quarantined = await replaceJsonLinesFileWithQuarantine(
            filePath,
            quarantinedPath,
            (handle) => this.writeRepairedRunJournal(
              authority,
              runId,
              filePath,
              throughOrdinal,
              handle,
            ),
          );
          await this.projectRunAuthorityIntoJournalOwned(
            authority,
            runId,
            filePath,
            { appendMissing: false, allowMissingPending: false, throughOrdinal },
          );
          await this.setPerRunEventProjectionMarkers(authority, runId, 1, throughOrdinal);
          this.corruptPerRunEventProjections.delete(runId);
          return quarantined ? quarantinedPath : undefined;
        } catch (error) {
          if (error instanceof EventJournalCorruptionError) {
            this.recordPerRunEventProjectionCorruption(runId, error);
          }
          throw error;
        }
      },
    ), { acquireTimeoutMs: null });
  }

}

function streamEventIdentityHash(event: CalyxStreamEvent, ignoreCursor = true): string {
  const serializable = JSON.parse(JSON.stringify({
    ...event,
    ...(ignoreCursor ? { cursor: "<durable-global-cursor>" } : {}),
  })) as unknown;
  return hashCanonicalJcs(serializable);
}

function streamEventId(event: unknown): string | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
  const eventId = (event as Record<string, unknown>)["event_id"];
  return typeof eventId === "string" ? eventId : undefined;
}
