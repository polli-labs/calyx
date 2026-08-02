import { closeSync, openSync, readSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { validateApiProvenance } from "./provenance";

const MESSAGE_SNAPSHOT_KEYS = [
  "message_id",
  "schema_version",
  "sender",
  "recipient_address",
  "recipient_class",
  "recipient_host",
  "subject",
  "body",
  "thread_key",
  "reply_to",
  "idempotency_key",
  "urgency",
  "ack_required",
  "expires_at",
  "status",
  "claimed_until",
  "claimed_by",
  "expired_claim_cycles",
  "dead_letter",
  "dead_letter_reason",
  "created_at",
  "updated_at",
  "spooled_at",
  "delivered_at",
  "acked_at",
  "acked_by",
  "receipt_path",
  "payload",
  "created_provenance",
  "ingress_provenance",
] as const;

/**
 * Project the known calyx.message/v1 snapshot fields from a same-major wire
 * acknowledgement. Durable receipt files remain exact-schema artifacts, but
 * readers on a rolling deployment must ignore optional fields added by a
 * newer writer before applying that strict validation.
 */
export function projectCompatibleMessageReceiptSnapshot(
  value: unknown,
  expectedMessageId?: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  // Status is receiver-local observation, not correspondence identity. The
  // msg-receive response intentionally leaves this same-major enum open, while
  // durable receipt files retain the closed set owned by this binary.
  if (!isCanonicalString(value["status"])) return undefined;
  const projected: Record<string, unknown> = {};
  for (const key of MESSAGE_SNAPSHOT_KEYS) {
    projected[key] = value[key];
  }
  const validationProjection = { ...projected, status: "pending" };
  return messageReceiptSnapshotValidationError(validationProjection, expectedMessageId) === undefined
    ? projected
    : undefined;
}

/**
 * Stable calyx.message/v1 JSONL bytes. This preserves the original writer's
 * top-level and MessageRow field order while making that order explicit.
 */
export function serializeCanonicalMessageReceiptEnvelope(
  message: unknown,
  receiptPath: string,
): string {
  if (!isRecord(message)) throw new Error("receipt message must be an object");
  const orderedMessage: Record<string, unknown> = {};
  for (const key of MESSAGE_SNAPSHOT_KEYS) {
    orderedMessage[key] = key === "receipt_path" ? receiptPath : message[key];
  }
  return JSON.stringify({
    schema_version: "calyx.message/v1",
    message: orderedMessage,
  });
}

const MESSAGE_RECIPIENT_CLASSES = new Set(["directed", "scope"]);
const MESSAGE_URGENCIES = new Set(["low", "normal", "high"]);
const MESSAGE_STATUSES = new Set([
  "outbox",
  "pending",
  "claimed",
  "acked",
  "dead_letter",
  "delivery_failed",
]);
const MESSAGE_ADMISSION_STATUSES = new Set(["outbox", "pending"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isCanonicalString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isNullableCanonicalTimestamp(value: unknown): boolean {
  return value === null || isCanonicalTimestamp(value);
}

function provenanceError(value: unknown): string | undefined {
  if (value === null) return undefined;
  try {
    validateApiProvenance(value as Parameters<typeof validateApiProvenance>[0]);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export interface MessageReceiptSnapshotSource {
  message_id: string;
  schema_version: string;
  sender: string;
  recipient_address: string;
  recipient_class: string;
  recipient_host: string | null;
  subject: string;
  body: string;
  thread_key: string | null;
  reply_to: string | null;
  idempotency_key: string | null;
  urgency: string;
  ack_required: boolean;
  expires_at: string | null;
  created_at: string;
  spooled_at: string;
  payload: Record<string, unknown>;
  created_provenance: unknown;
  ingress_provenance: unknown;
}

export interface RawMessageReceiptSnapshotSourceDomain {
  ack_required: unknown;
  expired_claim_cycles: unknown;
  dead_letter: unknown;
  spooled_at: unknown;
}

export interface MessageReceiptMirrorControlState {
  message_id: unknown;
  status: unknown;
  attempt_count: unknown;
  next_attempt_at: unknown;
  last_attempt_at: unknown;
  completed_at: unknown;
  receipt_path: unknown;
  last_error_code: unknown;
  last_error_message: unknown;
  created_at: unknown;
  updated_at: unknown;
}

export interface MessageReceiptFileEvidenceIndex {
  readonly receipt_path: string;
  readonly envelopes_by_message_id: ReadonlyMap<string, MessageReceiptFileEvidenceCandidate>;
  readonly malformed_evidence?: string | undefined;
  readonly read_error?: string | undefined;
}

export interface MessageReceiptFileEvidenceCandidate {
  readonly first_envelope: unknown;
  /** Saturates at two: callers only distinguish unique from duplicated. */
  readonly count: 1 | 2;
}

export interface MessageReceiptFileEvidenceScanResult {
  readonly receipt_path: string;
  readonly malformed_evidence?: string | undefined;
  readonly read_error?: string | undefined;
  readonly read_error_code?: string | undefined;
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    return Number(value);
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Validate raw SQLite domains before hydration can coerce malformed values. */
export function messageReceiptSnapshotSourceDomainError(
  value: RawMessageReceiptSnapshotSourceDomain,
): string | undefined {
  for (const field of ["ack_required", "dead_letter"] as const) {
    const raw = value[field];
    if (raw !== 0 && raw !== 1 && raw !== 0n && raw !== 1n) {
      return `${field} must be the SQLite integer 0 or 1`;
    }
  }
  if (safeNonNegativeInteger(value.expired_claim_cycles) === undefined) {
    return "expired_claim_cycles must be a non-negative safe SQLite integer";
  }
  if (!isCanonicalTimestamp(value.spooled_at)) {
    return "spooled_at must be a non-null canonical UTC ISO timestamp";
  }
  return undefined;
}

/**
 * Validate the durable mirror reducer state. This is shared by migration,
 * runtime drain, and doctor so none can silently normalize a state another
 * surface would reject.
 */
export function messageReceiptMirrorControlValidationError(
  value: MessageReceiptMirrorControlState,
): string | undefined {
  if (!isCanonicalString(value.message_id)) return "message_id must be a non-empty canonical string";
  if (value.status !== "pending" && value.status !== "completed") {
    return "status must be pending or completed";
  }
  const attemptCount = safeNonNegativeInteger(value.attempt_count);
  if (attemptCount === undefined) {
    return "attempt_count must be a non-negative safe SQLite integer";
  }
  for (const field of ["next_attempt_at", "last_attempt_at", "completed_at"] as const) {
    if (!isNullableCanonicalTimestamp(value[field])) {
      return `${field} must be a canonical UTC ISO timestamp or null`;
    }
  }
  for (const field of ["created_at", "updated_at"] as const) {
    if (!isCanonicalTimestamp(value[field])) {
      return `${field} must be a canonical UTC ISO timestamp`;
    }
  }
  for (const field of ["receipt_path", "last_error_code", "last_error_message"] as const) {
    if (!isNullableString(value[field])) return `${field} must be a string or null`;
  }
  const hasErrorCode = value.last_error_code !== null;
  const hasErrorMessage = value.last_error_message !== null;
  if (hasErrorCode !== hasErrorMessage) {
    return "last_error_code and last_error_message must be null or present together";
  }
  if (hasErrorCode && !isCanonicalString(value.last_error_code)) {
    return "last_error_code must be a non-empty canonical string when present";
  }
  if (hasErrorMessage && (typeof value.last_error_message !== "string" || value.last_error_message.length === 0)) {
    return "last_error_message must be a non-empty string when present";
  }

  const createdAt = value.created_at as string;
  const updatedAt = value.updated_at as string;
  const nextAttemptAt = value.next_attempt_at as string | null;
  const lastAttemptAt = value.last_attempt_at as string | null;
  const completedAt = value.completed_at as string | null;
  if (updatedAt < createdAt) return "updated_at cannot precede created_at";
  if (nextAttemptAt !== null && nextAttemptAt < createdAt) {
    return "next_attempt_at cannot precede created_at";
  }
  if (lastAttemptAt !== null && lastAttemptAt < createdAt) {
    return "last_attempt_at cannot precede created_at";
  }
  if (completedAt !== null && completedAt < createdAt) {
    return "completed_at cannot precede created_at";
  }

  if (value.status === "pending") {
    if (value.completed_at !== null || value.receipt_path !== null) {
      return "pending mirrors cannot carry completion evidence";
    }
    if (value.next_attempt_at === null) return "pending mirrors require next_attempt_at";
    if (attemptCount === 0) {
      if (value.last_attempt_at !== null || hasErrorCode) {
        return "unattempted pending mirrors cannot carry attempt or error evidence";
      }
      if (updatedAt !== createdAt) {
        return "unattempted pending mirror updated_at must equal created_at";
      }
    } else if (value.last_attempt_at === null) {
      return "attempted pending mirrors require last_attempt_at";
    } else if ((nextAttemptAt as string) < (lastAttemptAt as string)) {
      return "next_attempt_at cannot precede last_attempt_at";
    } else if (updatedAt !== lastAttemptAt) {
      return "attempted pending mirror updated_at must equal last_attempt_at";
    }
    return undefined;
  }

  if (attemptCount < 1) return "completed mirrors require at least one recorded attempt";
  if (value.next_attempt_at !== null) return "completed mirrors cannot remain scheduled";
  if (value.last_attempt_at === null) return "completed mirrors require last_attempt_at";
  if (value.completed_at === null) return "completed mirrors require completed_at";
  if (!isCanonicalString(value.receipt_path)) return "completed mirrors require a canonical receipt_path";
  if (!isAbsolute(value.receipt_path) || normalize(value.receipt_path) !== value.receipt_path) {
    return "completed mirrors require an exact normalized absolute receipt_path";
  }
  if (hasErrorCode) return "completed mirrors cannot retain error evidence";
  if (value.updated_at !== value.completed_at) {
    return "completed mirror updated_at must equal completed_at";
  }
  if ((value.completed_at as string) < (value.last_attempt_at as string)) {
    return "completed_at cannot precede last_attempt_at";
  }
  return undefined;
}

function receiptEvidenceReadError(receiptPath: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const detail = error instanceof Error ? error.message : String(error);
  return `receipt evidence ${receiptPath} is unreadable${code ? ` (${code})` : ""}: ${detail}`;
}

/** Stream one JSONL receipt file once, reporting each structurally valid envelope. */
export function scanMessageReceiptFileEvidence(
  receiptPath: string,
  visitEnvelope: (messageId: string, envelope: unknown) => void,
): MessageReceiptFileEvidenceScanResult {
  let descriptor: number | undefined;
  let visitorFailed = false;
  let visitorError: unknown;
  try {
    descriptor = openSync(receiptPath, "r");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let remainder = Buffer.alloc(0);
    let lineNumber = 0;
    let malformedEvidence: string | undefined;
    const inspectLine = (lineBytes: Uint8Array): void => {
      lineNumber += 1;
      if (lineBytes.byteLength === 0) {
        malformedEvidence ??= `receipt evidence ${receiptPath} has a blank line at line ${lineNumber}`;
        return;
      }
      let line: string;
      try {
        line = decoder.decode(lineBytes);
      } catch {
        malformedEvidence ??= `receipt evidence ${receiptPath} has invalid UTF-8 at line ${lineNumber}`;
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        malformedEvidence ??= `receipt evidence ${receiptPath} has malformed JSON at line ${lineNumber}`;
        return;
      }
      let canonicalLine: string;
      try {
        canonicalLine = isRecord(parsed) && isRecord(parsed["message"])
          ? serializeCanonicalMessageReceiptEnvelope(parsed["message"], receiptPath)
          : "";
      } catch (error) {
        malformedEvidence ??= `receipt evidence ${receiptPath} is not canonical JSON at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`;
        return;
      }
      if (line !== canonicalLine) {
        malformedEvidence ??= `receipt evidence ${receiptPath} is not exact canonical JSON at line ${lineNumber}`;
        return;
      }
      if (
        !isRecord(parsed)
        || parsed["schema_version"] !== "calyx.message/v1"
        || !isRecord(parsed["message"])
      ) {
        malformedEvidence ??= `receipt evidence ${receiptPath} has a malformed envelope at line ${lineNumber}`;
        return;
      }
      const messageId = parsed["message"]["message_id"];
      if (!isCanonicalString(messageId)) {
        malformedEvidence ??= `receipt evidence ${receiptPath} has a malformed message id at line ${lineNumber}`;
        return;
      }
      if (parsed["message"]["receipt_path"] !== receiptPath) {
        malformedEvidence ??= `receipt evidence ${receiptPath} has mismatched receipt_path at line ${lineNumber}`;
        return;
      }
      const snapshotError = messageReceiptAdmissionSnapshotValidationError({
        ...parsed["message"],
        receipt_path: null,
      }, messageId);
      if (snapshotError) {
        malformedEvidence ??= `receipt evidence ${receiptPath} has an invalid admission snapshot at line ${lineNumber}: ${snapshotError}`;
        return;
      }
      try {
        visitEnvelope(messageId, parsed);
      } catch (error) {
        visitorFailed = true;
        visitorError = error;
        throw error;
      }
    };
    while (true) {
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      remainder = Buffer.concat([remainder, chunk.subarray(0, bytesRead)]);
      let newline = remainder.indexOf(0x0a);
      while (newline >= 0) {
        inspectLine(remainder.subarray(0, newline));
        remainder = remainder.subarray(newline + 1);
        newline = remainder.indexOf(0x0a);
      }
    }
    if (remainder.byteLength > 0) {
      malformedEvidence ??= `receipt evidence ${receiptPath} has an unterminated line after line ${lineNumber}`;
    }
    return {
      receipt_path: receiptPath,
      malformed_evidence: malformedEvidence,
    };
  } catch (error) {
    if (visitorFailed) throw visitorError;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return {
      receipt_path: receiptPath,
      read_error: receiptEvidenceReadError(receiptPath, error),
      ...(code ? { read_error_code: code } : {}),
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readMessageReceiptFileEvidence(
  receiptPath: string,
  expectedMessageIds: ReadonlySet<string>,
): MessageReceiptFileEvidenceIndex {
  const envelopes = new Map<string, MessageReceiptFileEvidenceCandidate>();
  const scan = scanMessageReceiptFileEvidence(receiptPath, (messageId, envelope) => {
    if (!expectedMessageIds.has(messageId)) return;
    const existing = envelopes.get(messageId);
    envelopes.set(messageId, existing === undefined
      ? { first_envelope: envelope, count: 1 }
      : { first_envelope: existing.first_envelope, count: 2 });
  });
  return {
    ...scan,
    envelopes_by_message_id: envelopes,
  };
}

/** Prove one completed mirror has exactly one canonical on-disk envelope. */
export function messageReceiptFileEvidenceError(
  index: MessageReceiptFileEvidenceIndex,
  snapshot: unknown,
  messageId: string,
): string | undefined {
  if (index.read_error) return index.read_error;
  if (index.malformed_evidence) return index.malformed_evidence;
  const candidate = index.envelopes_by_message_id.get(messageId);
  if (candidate === undefined) {
    return `receipt evidence ${index.receipt_path} has no envelope for ${messageId}`;
  }
  const expected = {
    schema_version: "calyx.message/v1",
    message: {
      ...(snapshot as Record<string, unknown>),
      receipt_path: index.receipt_path,
    },
  };
  if (candidate.count !== 1) {
    return `receipt evidence ${index.receipt_path} has multiple envelopes for ${messageId}; exactly one is required`;
  }
  if (!isDeepStrictEqual(candidate.first_envelope, expected)) {
    return `receipt evidence ${index.receipt_path} has a conflicting envelope for ${messageId}`;
  }
  return undefined;
}

function immutablePayload(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const normalized = { ...value };
  // Legacy receipt bookkeeping was intentionally removed from the message
  // row after the immutable mirror snapshot was queued.
  delete normalized["receipt_mirror"];
  return normalized;
}

const IMMUTABLE_SOURCE_FIELDS = [
  "message_id",
  "schema_version",
  "sender",
  "recipient_address",
  "recipient_class",
  "recipient_host",
  "subject",
  "body",
  "thread_key",
  "reply_to",
  "idempotency_key",
  "urgency",
  "ack_required",
  "expires_at",
  "created_at",
  "spooled_at",
  "created_provenance",
  "ingress_provenance",
] as const satisfies readonly (keyof MessageReceiptSnapshotSource)[];

/**
 * Prove that a structurally valid historical snapshot belongs to its
 * authoritative message row. Delivery status and acknowledgement fields are
 * deliberately excluded because they may advance after the mirror is queued.
 */
export function messageReceiptSnapshotCorrespondenceError(
  value: unknown,
  source: MessageReceiptSnapshotSource,
): string | undefined {
  if (!isRecord(value)) return "snapshot must be a JSON object";
  for (const field of IMMUTABLE_SOURCE_FIELDS) {
    if (!isDeepStrictEqual(value[field], source[field])) {
      return `${field} does not match the authoritative message row`;
    }
  }
  if (!isDeepStrictEqual(immutablePayload(value["payload"]), immutablePayload(source.payload))) {
    return "payload does not match the authoritative message row";
  }
  return undefined;
}

/**
 * Prove that the immutable snapshot is an admission-boundary record, not a
 * later live-row projection. Sender-side remote correspondence begins in
 * `outbox`; local and receiver-side correspondence begins in `pending`.
 */
export function messageReceiptAdmissionSnapshotValidationError(
  value: unknown,
  expectedMessageId?: string,
): string | undefined {
  const structuralError = messageReceiptSnapshotValidationError(value, expectedMessageId);
  if (structuralError) return structuralError;
  if (!isRecord(value)) return "snapshot must be a JSON object";
  if (!MESSAGE_ADMISSION_STATUSES.has(value["status"] as string)) {
    return "admission snapshot status must be outbox or pending";
  }
  for (const field of [
    "claimed_until",
    "claimed_by",
    "dead_letter_reason",
    "delivered_at",
    "acked_at",
    "acked_by",
    "receipt_path",
  ] as const) {
    if (value[field] !== null) return `admission snapshot ${field} must be null`;
  }
  if (value["expired_claim_cycles"] !== 0) {
    return "admission snapshot expired_claim_cycles must be 0";
  }
  if (value["dead_letter"] !== false) return "admission snapshot dead_letter must be false";
  if (value["updated_at"] !== value["created_at"]) {
    return "admission snapshot updated_at must equal created_at";
  }
  const payload = value["payload"];
  if (isRecord(payload) && "receipt_mirror" in payload) {
    return "admission snapshot payload cannot contain legacy receipt_mirror bookkeeping";
  }
  return undefined;
}

/**
 * Runtime validation for the immutable message snapshot persisted by the
 * receipt-mirror queue. JSON validity alone cannot establish a v1 receipt:
 * every MessageRow field and both provenance envelopes are part of the wire
 * contract that the eventual JSONL receipt claims to carry.
 */
export function messageReceiptSnapshotValidationError(
  value: unknown,
  expectedMessageId?: string,
): string | undefined {
  if (!isRecord(value)) return "snapshot must be a JSON object";

  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...MESSAGE_SNAPSHOT_KEYS].sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    const missing = expectedKeys.filter((key) => !(key in value));
    const extra = actualKeys.filter((key) => !expectedKeys.includes(key as typeof MESSAGE_SNAPSHOT_KEYS[number]));
    return [
      missing.length > 0 ? `missing fields: ${missing.join(", ")}` : undefined,
      extra.length > 0 ? `unknown fields: ${extra.join(", ")}` : undefined,
    ].filter(Boolean).join("; ") || "snapshot fields do not match calyx.message/v1";
  }

  if (typeof value["message_id"] !== "string" || value["message_id"].length === 0) {
    return "message_id must be a non-empty string";
  }
  if (expectedMessageId !== undefined && value["message_id"] !== expectedMessageId) {
    return `message_id must equal ${expectedMessageId}`;
  }
  if (value["schema_version"] !== "calyx.message/v1") {
    return "schema_version must be calyx.message/v1";
  }
  for (const field of ["sender", "recipient_address", "subject"] as const) {
    if (!isCanonicalString(value[field])) return `${field} must be a non-empty canonical string`;
  }
  if (typeof value["body"] !== "string") return "body must be a string";
  if (!MESSAGE_RECIPIENT_CLASSES.has(value["recipient_class"] as string)) {
    return "recipient_class must be directed or scope";
  }
  for (const field of [
    "recipient_host",
    "thread_key",
    "reply_to",
    "idempotency_key",
    "claimed_by",
    "dead_letter_reason",
    "acked_by",
    "receipt_path",
  ] as const) {
    if (!isNullableString(value[field])) return `${field} must be a string or null`;
  }
  for (const field of [
    "expires_at",
    "claimed_until",
    "delivered_at",
    "acked_at",
  ] as const) {
    if (!isNullableCanonicalTimestamp(value[field])) {
      return `${field} must be a canonical UTC ISO timestamp or null`;
    }
  }
  if (!MESSAGE_URGENCIES.has(value["urgency"] as string)) {
    return "urgency must be low, normal, or high";
  }
  if (typeof value["ack_required"] !== "boolean") return "ack_required must be boolean";
  if (!MESSAGE_STATUSES.has(value["status"] as string)) return "status is invalid";
  if (
    typeof value["expired_claim_cycles"] !== "number"
    || !Number.isSafeInteger(value["expired_claim_cycles"])
    || value["expired_claim_cycles"] < 0
  ) {
    return "expired_claim_cycles must be a non-negative safe integer";
  }
  if (typeof value["dead_letter"] !== "boolean") return "dead_letter must be boolean";
  for (const field of ["created_at", "updated_at", "spooled_at"] as const) {
    if (!isCanonicalTimestamp(value[field])) {
      return `${field} must be a canonical UTC ISO timestamp`;
    }
  }
  if (!isRecord(value["payload"])) return "payload must be a JSON object";
  for (const field of ["created_provenance", "ingress_provenance"] as const) {
    const error = provenanceError(value[field]);
    if (error) return `${field} is invalid: ${error}`;
  }
  return undefined;
}
