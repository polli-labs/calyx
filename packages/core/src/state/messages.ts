import { createHash, randomUUID } from "node:crypto";
import { mkdir, open as openFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { canonicalizeJcs as canonicalizeJsonJcs } from "./canonical-json";
import type { StateDriverDatabase } from "./driver";
export {
  API_IDEMPOTENCY_CANONICALIZER,
  API_IDEMPOTENCY_SCHEMA_MAJOR,
  readApiIdempotency,
  recordApiIdempotency,
} from "./api-idempotency";
export type {
  ApiIdempotencyRow,
  RecordApiIdempotencyInput,
} from "./api-idempotency";
import {
  messageReceiptAdmissionSnapshotValidationError,
  messageReceiptFileEvidenceError,
  messageReceiptMirrorControlValidationError,
  messageReceiptSnapshotCorrespondenceError,
  messageReceiptSnapshotSourceDomainError,
  scanMessageReceiptFileEvidence,
  serializeCanonicalMessageReceiptEnvelope,
} from "./message-receipt-snapshot";
import { parseApiProvenanceJson, validateApiProvenance, type ApiProvenanceV1 } from "./provenance";
import { MESSAGE_RECEIPT_MIRROR_CONTROL_CHECK_SQL, MESSAGE_TABLES } from "./migrations";
import { SqliteMutexBusyError, withSqliteMutex } from "./sqlite-mutex";

export const MESSAGE_SCHEMA_VERSION = "calyx.message/v1";
export const MESSAGE_DELIVERY_SCHEMA_VERSION = "calyx.message-delivery/v1";
export const MESSAGE_OUTBOX_SCHEMA_VERSION = "calyx.message-outbox/v1";
export const MESSAGE_RECEIPT_MIRROR_SCHEMA_VERSION = "calyx.message-receipt-mirror/v1";
export const MESSAGE_JSONL_RELATIVE_PATH = "receipts/messages.jsonl";
const MESSAGE_JSONL_MUTEX_RELATIVE_PATH = "locks/message-receipts.lock.sqlite3";
export const MESSAGE_OUTBOX_TTL_MS = 72 * 60 * 60 * 1000;
export const MESSAGE_OUTBOX_ATTEMPT_TTL_MS = 30_000;
export const MESSAGE_CLAIM_TTL_MS = 5 * 60 * 1000;
export const MESSAGE_EXPIRED_CLAIM_DEAD_LETTER_CYCLES = 3;

export const MESSAGE_RECIPIENT_CLASSES = ["directed", "scope"] as const;
export type MessageRecipientClass = (typeof MESSAGE_RECIPIENT_CLASSES)[number];

export const MESSAGE_URGENCIES = ["low", "normal", "high"] as const;
export type MessageUrgency = (typeof MESSAGE_URGENCIES)[number];

export const MESSAGE_STATUSES = [
  "outbox",
  "pending",
  "claimed",
  "acked",
  "dead_letter",
  "delivery_failed",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const MESSAGE_DELIVERY_ADAPTERS = [
  "daemon_outbox",
  "session_ingress",
  "ntfy",
  "linear_comment",
  "vault_receipt",
  "codex_automation",
  "codex_app_server_steer",
  "claude_reinvoke",
  "claude_channel",
] as const;
export type MessageDeliveryAdapterV1 = (typeof MESSAGE_DELIVERY_ADAPTERS)[number];

export const MESSAGE_DELIVERY_STATUSES = [
  "attempted",
  "delivered",
  "failed",
] as const;
export type MessageDeliveryStatus = (typeof MESSAGE_DELIVERY_STATUSES)[number];

export const MESSAGE_OUTBOX_STATUSES = [
  "pending",
  "in_flight",
  "forwarded",
  "indeterminate",
  "delivery_failed",
] as const;
export type MessageOutboxStatus = (typeof MESSAGE_OUTBOX_STATUSES)[number];

export const MESSAGE_RECEIPT_MIRROR_STATUSES = ["pending", "completed"] as const;
export type MessageReceiptMirrorStatus = (typeof MESSAGE_RECEIPT_MIRROR_STATUSES)[number];

export type MessageStatusCounts = Record<MessageStatus, number>;
export type MessageDeliveryStatusCounts = Record<MessageDeliveryStatus, number>;
export type MessageOutboxStatusCounts = Record<MessageOutboxStatus, number>;
export type MessageReceiptMirrorStatusCounts = Record<MessageReceiptMirrorStatus, number>;

export interface MessageRow {
  message_id: string;
  schema_version: typeof MESSAGE_SCHEMA_VERSION;
  sender: string;
  recipient_address: string;
  recipient_class: MessageRecipientClass;
  recipient_host: string | null;
  subject: string;
  body: string;
  thread_key: string | null;
  reply_to: string | null;
  idempotency_key: string | null;
  urgency: MessageUrgency;
  ack_required: boolean;
  expires_at: string | null;
  status: MessageStatus;
  claimed_until: string | null;
  claimed_by: string | null;
  expired_claim_cycles: number;
  dead_letter: boolean;
  dead_letter_reason: string | null;
  created_at: string;
  updated_at: string;
  spooled_at: string;
  delivered_at: string | null;
  acked_at: string | null;
  acked_by: string | null;
  receipt_path: string | null;
  payload: Record<string, unknown>;
  created_provenance: ApiProvenanceV1 | null;
  ingress_provenance: ApiProvenanceV1 | null;
}

export interface CreateMessageInput {
  message_id?: string | undefined;
  sender: string;
  recipient_address: string;
  recipient_class: MessageRecipientClass;
  recipient_host?: string | null | undefined;
  subject: string;
  body?: string | undefined;
  thread_key?: string | null | undefined;
  reply_to?: string | null | undefined;
  idempotency_key?: string | null | undefined;
  urgency?: MessageUrgency | undefined;
  ack_required?: boolean | undefined;
  expires_at?: string | null | undefined;
  status?: MessageStatus | undefined;
  now?: string | undefined;
  spooled_at?: string | undefined;
  delivered_at?: string | null | undefined;
  payload?: Record<string, unknown> | undefined;
  created_provenance?: ApiProvenanceV1 | null | undefined;
  ingress_provenance?: ApiProvenanceV1 | null | undefined;
}

export interface CreateMessageResult {
  message: MessageRow;
  inserted: boolean;
}

export interface ListMessagesOptions {
  recipient_address?: string | undefined;
  recipient_class?: MessageRecipientClass | undefined;
  recipient_host?: string | undefined;
  status?: MessageStatus | "open" | "all" | undefined;
  thread_key?: string | undefined;
  include_expired?: boolean | undefined;
  now?: string | undefined;
  limit?: number | undefined;
}

export interface AuthorizedMessageListOptions {
  read_grants: readonly string[];
  send_as_grants: readonly string[];
  recipient_address?: string | undefined;
  thread_key?: string | undefined;
  status?: MessageStatus | "open" | "all" | undefined;
  include_expired?: boolean | undefined;
  cursor_context: string;
  cursor?: string | undefined;
  limit?: number | undefined;
  now?: string | undefined;
}

export interface AuthorizedMessageListResult {
  messages: MessageRow[];
  truncated: boolean;
  next_cursor?: string | undefined;
}

export interface AuthorizedMessageCounts {
  total: number;
  open: number;
  pending: number;
  claimed: number;
  acked: number;
  dead_letter: number;
  delivery_failed: number;
}

export class MessageCursorError extends Error {
  constructor(message = "message cursor is invalid") {
    super(message);
    this.name = "MessageCursorError";
  }
}

export const MSG_SEND_SEMANTIC_CANONICALIZER = "calyx.msg-send-semantic/v1";

export interface ClaimMessagesOptions {
  recipient_address: string;
  claimed_by: string;
  now?: string | undefined;
  claim_ttl_ms?: number | undefined;
  max_expired_claim_cycles?: number | undefined;
  limit?: number | undefined;
  peek?: boolean | undefined;
}

export interface AckMessageResult {
  message: MessageRow | undefined;
  changed: boolean;
}

export interface MessageDeliveryRow {
  delivery_id: string;
  message_id: string;
  binding_id: string;
  adapter: MessageDeliveryAdapterV1;
  status: MessageDeliveryStatus;
  attempted_at: string;
  delivered_at: string | null;
  failed_at: string | null;
  updated_at: string;
  target: Record<string, unknown>;
  evidence: unknown;
  error_code: string | null;
  error_message: string | null;
}

export interface CreateMessageDeliveryAttemptInput {
  message: MessageRow;
  binding_id: string;
  adapter: MessageDeliveryAdapterV1;
  attempted_at?: string | undefined;
  target?: Record<string, unknown> | undefined;
  evidence?: unknown;
}

export interface CreateMessageDeliveryAttemptResult {
  delivery: MessageDeliveryRow;
  inserted: boolean;
}

export interface CompleteMessageDeliveryInput {
  delivery_id: string;
  status: Exclude<MessageDeliveryStatus, "attempted">;
  completed_at?: string | undefined;
  target?: Record<string, unknown> | undefined;
  evidence?: unknown;
  error_code?: string | null | undefined;
  error_message?: string | null | undefined;
}

export interface ListMessageDeliveriesOptions {
  message_id?: string | undefined;
  status?: MessageDeliveryStatus | "all" | undefined;
  limit?: number | undefined;
}

export interface MessageOutboxRow {
  outbox_id: string;
  schema_version: typeof MESSAGE_OUTBOX_SCHEMA_VERSION;
  message_id: string;
  target_host: string;
  target_url: string | null;
  status: MessageOutboxStatus;
  attempt_count: number;
  acceptance_ambiguous: boolean;
  attempt_id: string | null;
  attempt_expires_at: string | null;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  forwarded_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  last_error_code: string | null;
  last_error_message: string | null;
  payload: Record<string, unknown>;
}

export interface MessageReceiptMirrorRow {
  message_id: string;
  schema_version: typeof MESSAGE_RECEIPT_MIRROR_SCHEMA_VERSION;
  status: MessageReceiptMirrorStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  completed_at: string | null;
  receipt_path: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface DrainMessageReceiptMirrorsResult {
  attempted: number;
  completed: number;
  failed: number;
  pending: number;
}

export interface EnqueueMessageOutboxInput {
  message_id: string;
  target_host: string;
  now?: string | undefined;
  expires_at?: string | undefined;
  payload?: Record<string, unknown> | undefined;
}

export interface ListPendingOutboxOptions {
  now?: string | undefined;
  limit?: number | undefined;
}

export interface ClaimMessageOutboxAttemptOptions {
  now?: string | undefined;
  attempt_ttl_ms?: number | undefined;
  attempt_id?: string | undefined;
}

export interface MessagePendingCounts {
  directed_pending: number;
  directed_claimed: number;
  scope_pending: number;
  dead_letter: number;
  delivery_failed: number;
  outbox_pending: number;
}

export interface MessageSchemaFinding {
  table: string;
  code: "missing-table" | "missing-column" | "missing-index" | "invalid-column-constraint";
  detail: string;
}

export interface MalformedMessageReceiptSnapshotFinding {
  message_id: string;
  code: "invalid-receipt-snapshot" | "invalid-receipt-control";
  detail: string;
}

export type MessageAddressKind =
  | "run"
  | "interactive"
  | "authorship_alias"
  | "client"
  | "role"
  | "host"
  | "fleet";

export interface ResolveMessageAddressOptions {
  currentHost: string;
  coordinatorHost?: string | undefined;
  explicitHost?: string | undefined;
}

export interface ResolvedMessageAddress {
  input: string;
  address: string;
  recipient_class: MessageRecipientClass;
  target_host: string | null;
  kind: MessageAddressKind;
}

export function executionCapableMessageAddressKind(
  resolved: ResolvedMessageAddress,
): "run" | "interactive" | null {
  // Authorization follows the canonical address, never the input spelling.
  // Authorship aliases such as codex:blade:<session> resolve to an interactive
  // address and therefore carry the same execution capability.
  if (resolved.address.startsWith("run:")) return "run";
  if (resolved.address.startsWith("interactive:")) return "interactive";
  return null;
}

const SELECT_MESSAGE = `SELECT
  message_id, schema_version, sender, recipient_address, recipient_class,
  recipient_host, subject, body, thread_key, reply_to, idempotency_key, urgency,
  ack_required, expires_at, status, claimed_until, claimed_by,
  expired_claim_cycles, dead_letter, dead_letter_reason, created_at, updated_at,
  spooled_at, delivered_at, acked_at, acked_by, receipt_path, payload_json,
  created_provenance_json, ingress_provenance_json
FROM messages`;

const SELECT_DELIVERY = `SELECT
  delivery_id, message_id, binding_id, adapter, status, attempted_at,
  delivered_at, failed_at, updated_at, target_json, evidence_json, error_code,
  error_message
FROM message_deliveries`;

const SELECT_OUTBOX = `SELECT
  outbox_id, schema_version, message_id, target_host, target_url, status,
  attempt_count, acceptance_ambiguous, attempt_id, attempt_expires_at, next_attempt_at,
  last_attempt_at, forwarded_at, expires_at,
  created_at, updated_at, last_error_code, last_error_message, payload_json
FROM outbox`;

const SELECT_RECEIPT_MIRROR = `SELECT
  message_id, receipt_snapshot_json, status, attempt_count, next_attempt_at, last_attempt_at,
  completed_at, receipt_path, last_error_code, last_error_message, created_at,
  updated_at
FROM message_receipt_mirrors`;

function nowIso(): string {
  return new Date().toISOString();
}

function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function normalizeRequired(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must be non-empty`);
  }
  return trimmed;
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function assertInSet<T extends string>(
  label: string,
  value: string,
  allowed: readonly T[],
): asserts value is T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
}

function normalizeLimit(limit: number | undefined, fallback = 50, max = 500): number {
  if (limit === undefined) return fallback;
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), max);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseObjectJson(value: string): Record<string, unknown> {
  const parsed = parseJson(value);
  return isRecord(parsed) ? parsed : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function changeCount(result: { changes: number | bigint }): number {
  return typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
}

function hydrateMessage(row: RawMessageRow): MessageRow {
  return {
    message_id: row.message_id,
    schema_version: row.schema_version as typeof MESSAGE_SCHEMA_VERSION,
    sender: row.sender,
    recipient_address: row.recipient_address,
    recipient_class: row.recipient_class as MessageRecipientClass,
    recipient_host: row.recipient_host,
    subject: row.subject,
    body: row.body,
    thread_key: row.thread_key,
    reply_to: row.reply_to,
    idempotency_key: row.idempotency_key,
    urgency: row.urgency as MessageUrgency,
    ack_required: row.ack_required === 1,
    expires_at: row.expires_at,
    status: row.status as MessageStatus,
    claimed_until: row.claimed_until,
    claimed_by: row.claimed_by,
    expired_claim_cycles: Number(row.expired_claim_cycles),
    dead_letter: row.dead_letter === 1,
    dead_letter_reason: row.dead_letter_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    spooled_at: row.spooled_at ?? row.created_at,
    delivered_at: row.delivered_at,
    acked_at: row.acked_at,
    acked_by: row.acked_by,
    receipt_path: row.receipt_path,
    payload: parseObjectJson(row.payload_json),
    created_provenance: row.created_provenance_json ? parseApiProvenanceJson(row.created_provenance_json) : null,
    ingress_provenance: row.ingress_provenance_json ? parseApiProvenanceJson(row.ingress_provenance_json) : null,
  };
}

function hydrateDelivery(row: RawMessageDeliveryRow): MessageDeliveryRow {
  return {
    delivery_id: row.delivery_id,
    message_id: row.message_id,
    binding_id: row.binding_id,
    adapter: row.adapter as MessageDeliveryAdapterV1,
    status: row.status as MessageDeliveryStatus,
    attempted_at: row.attempted_at,
    delivered_at: row.delivered_at,
    failed_at: row.failed_at,
    updated_at: row.updated_at,
    target: parseObjectJson(row.target_json),
    evidence: parseJson(row.evidence_json),
    error_code: row.error_code,
    error_message: row.error_message,
  };
}

function hydrateOutbox(row: RawMessageOutboxRow): MessageOutboxRow {
  return {
    outbox_id: row.outbox_id,
    schema_version: row.schema_version as typeof MESSAGE_OUTBOX_SCHEMA_VERSION,
    message_id: row.message_id,
    target_host: row.target_host,
    target_url: row.target_url,
    status: row.status as MessageOutboxStatus,
    attempt_count: Number(row.attempt_count),
    acceptance_ambiguous: row.acceptance_ambiguous === 1,
    attempt_id: row.attempt_id,
    attempt_expires_at: row.attempt_expires_at,
    next_attempt_at: row.next_attempt_at,
    last_attempt_at: row.last_attempt_at,
    forwarded_at: row.forwarded_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_error_code: row.last_error_code,
    last_error_message: row.last_error_message,
    payload: parseObjectJson(row.payload_json),
  };
}

function hydrateReceiptMirror(row: RawMessageReceiptMirrorRow): MessageReceiptMirrorRow {
  return {
    message_id: row.message_id,
    schema_version: MESSAGE_RECEIPT_MIRROR_SCHEMA_VERSION,
    status: row.status as MessageReceiptMirrorStatus,
    attempt_count: Number(row.attempt_count),
    next_attempt_at: row.next_attempt_at,
    last_attempt_at: row.last_attempt_at,
    completed_at: row.completed_at,
    receipt_path: row.receipt_path,
    last_error_code: row.last_error_code,
    last_error_message: row.last_error_message,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

interface RawMessageRow {
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
  ack_required: number;
  expires_at: string | null;
  status: string;
  claimed_until: string | null;
  claimed_by: string | null;
  expired_claim_cycles: number | bigint;
  dead_letter: number;
  dead_letter_reason: string | null;
  created_at: string;
  updated_at: string;
  spooled_at: string | null;
  delivered_at: string | null;
  acked_at: string | null;
  acked_by: string | null;
  receipt_path: string | null;
  payload_json: string;
  created_provenance_json: string | null;
  ingress_provenance_json: string | null;
}

interface RawMessageDeliveryRow {
  delivery_id: string;
  message_id: string;
  binding_id: string;
  adapter: string;
  status: string;
  attempted_at: string;
  delivered_at: string | null;
  failed_at: string | null;
  updated_at: string;
  target_json: string;
  evidence_json: string;
  error_code: string | null;
  error_message: string | null;
}

interface RawMessageOutboxRow {
  outbox_id: string;
  schema_version: string;
  message_id: string;
  target_host: string;
  target_url: string | null;
  status: string;
  attempt_count: number | bigint;
  acceptance_ambiguous: number;
  attempt_id: string | null;
  attempt_expires_at: string | null;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  forwarded_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  last_error_code: string | null;
  last_error_message: string | null;
  payload_json: string;
}

interface RawMessageReceiptMirrorRow {
  message_id: string;
  receipt_snapshot_json: string;
  status: string;
  attempt_count: unknown;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  completed_at: string | null;
  receipt_path: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

export function resolveMessageAddress(
  rawAddress: string,
  options: ResolveMessageAddressOptions,
): ResolvedMessageAddress {
  const input = normalizeRequired("address", rawAddress);
  const currentHost = normalizeRequired("currentHost", options.currentHost);
  const coordinatorHost = normalizeOptional(options.coordinatorHost) ?? currentHost;
  const explicitHost = normalizeOptional(options.explicitHost);

  if (input === "fleet") {
    return {
      input,
      address: "fleet",
      recipient_class: "scope",
      target_host: coordinatorHost,
      kind: "fleet",
    };
  }

  if (input.startsWith("host:")) {
    const host = normalizeRequired("host", input.slice("host:".length));
    return {
      input,
      address: `host:${host}`,
      recipient_class: "scope",
      target_host: host,
      kind: "host",
    };
  }

  if (input.startsWith("run:")) {
    const runId = normalizeRequired("run id", input.slice("run:".length));
    return {
      input,
      address: `run:${runId}`,
      recipient_class: "directed",
      target_host: explicitHost ?? currentHost,
      kind: "run",
    };
  }

  if (input.startsWith("interactive:")) {
    const parts = input.split(":");
    if (parts.length < 3) {
      throw new Error("interactive address must be interactive:<backend>:<session-id>");
    }
    const backend = normalizeRequired("backend", parts[1] ?? "");
    const sessionId = normalizeRequired("session id", parts.slice(2).join(":"));
    return {
      input,
      address: `interactive:${backend}:${sessionId}`,
      recipient_class: "directed",
      target_host: explicitHost ?? currentHost,
      kind: "interactive",
    };
  }

  if (input.startsWith("client:")) {
    const clientAddress = input.slice("client:".length);
    const match = /^([a-z][a-z0-9_.:-]*)@([a-z0-9][a-z0-9.-]*)$/.exec(clientAddress);
    if (!match) {
      throw new Error("client address must be client:<client-id>@<host>");
    }
    const clientId = normalizeRequired("client id", match[1] ?? "");
    const host = normalizeRequired("host", match[2] ?? "");
    return {
      input,
      address: `client:${clientId}@${host}`,
      recipient_class: "directed",
      target_host: host,
      kind: "client",
    };
  }

  const authorship = /^([A-Za-z][A-Za-z0-9_-]*):([^:]+):(.+)$/.exec(input);
  if (authorship && !["role", "host", "run", "interactive"].includes(authorship[1] ?? "")) {
    const backend = normalizeRequired("backend", authorship[1] ?? "");
    const host = normalizeRequired("host", authorship[2] ?? "");
    const sessionId = normalizeRequired("session id", authorship[3] ?? "");
    return {
      input,
      address: `interactive:${backend}:${sessionId}`,
      recipient_class: "directed",
      target_host: explicitHost ?? host,
      kind: "authorship_alias",
    };
  }

  const roleSpec = input.startsWith("role:") ? input.slice("role:".length) : input;
  const roleMatch = /^([^@]+)(?:@(.+))?$/.exec(roleSpec);
  if (!roleMatch) {
    throw new Error(`unsupported message address: ${input}`);
  }
  const role = normalizeRequired("role", roleMatch[1] ?? "");
  const roleHost = normalizeOptional(roleMatch[2]) ?? explicitHost ?? coordinatorHost;
  return {
    input,
    address: `role:${role}@${roleHost}`,
    recipient_class: "directed",
    target_host: roleHost,
    kind: "role",
  };
}

export function createMessage(db: StateDriverDatabase, input: CreateMessageInput): CreateMessageResult {
  const messageId = normalizeRequired("message_id", input.message_id ?? `msg_${randomUUID()}`);
  const sender = normalizeRequired("sender", input.sender);
  const recipientAddress = normalizeRequired("recipient_address", input.recipient_address);
  const recipientClass = input.recipient_class;
  assertInSet("recipient_class", recipientClass, MESSAGE_RECIPIENT_CLASSES);
  const urgency = input.urgency ?? "normal";
  assertInSet("urgency", urgency, MESSAGE_URGENCIES);
  const status = input.status ?? "pending";
  assertInSet("status", status, MESSAGE_STATUSES);
  const subject = normalizeRequired("subject", input.subject);
  const expiresAt = normalizeOptional(input.expires_at);
  if (recipientClass === "scope" && !expiresAt) {
    throw new Error("scope messages require expires_at");
  }
  const now = input.now ?? nowIso();
  const spooledAt = input.spooled_at ?? now;
  const createdProvenance = input.created_provenance ? validateApiProvenance(input.created_provenance) : null;
  const ingressProvenance = input.ingress_provenance ? validateApiProvenance(input.ingress_provenance) : null;
  const result = db.prepare(
    `INSERT OR IGNORE INTO messages
       (message_id, schema_version, sender, recipient_address, recipient_class,
        recipient_host, subject, body, thread_key, reply_to, idempotency_key,
        urgency, ack_required, expires_at, status, created_at, updated_at,
        spooled_at, delivered_at, payload_json, created_provenance_json,
        ingress_provenance_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    messageId,
    MESSAGE_SCHEMA_VERSION,
    sender,
    recipientAddress,
    recipientClass,
    normalizeOptional(input.recipient_host),
    subject,
    input.body ?? "",
    normalizeOptional(input.thread_key),
    normalizeOptional(input.reply_to),
    normalizeOptional(input.idempotency_key),
    urgency,
    input.ack_required ? 1 : 0,
    expiresAt,
    status,
    now,
    now,
    spooledAt,
    input.delivered_at ?? null,
    JSON.stringify(input.payload ?? {}),
    createdProvenance ? JSON.stringify(createdProvenance) : null,
    ingressProvenance ? JSON.stringify(ingressProvenance) : null,
  );
  const inserted = changeCount(result) > 0;
  const message =
    readMessage(db, messageId)
    ?? (input.idempotency_key ? readMessageBySenderIdempotency(db, sender, input.idempotency_key) : undefined);
  if (!message) {
    throw new Error(`message ${messageId} was not readable after insert`);
  }
  return { message, inserted };
}

export function readMessage(
  db: StateDriverDatabase,
  messageId: string,
): MessageRow | undefined {
  const row = db
    .prepare(`${SELECT_MESSAGE} WHERE message_id = ?`)
    .get(messageId) as RawMessageRow | undefined;
  return row ? hydrateMessage(row) : undefined;
}

export function readMessageBySenderIdempotency(
  db: StateDriverDatabase,
  sender: string,
  idempotencyKey: string,
): MessageRow | undefined {
  const row = db
    .prepare(`${SELECT_MESSAGE} WHERE sender = ? AND idempotency_key = ?`)
    .get(sender, idempotencyKey) as RawMessageRow | undefined;
  return row ? hydrateMessage(row) : undefined;
}

export function listMessages(
  db: StateDriverDatabase,
  options: ListMessagesOptions = {},
): MessageRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const now = options.now ?? nowIso();
  if (options.recipient_address) {
    clauses.push("recipient_address = ?");
    params.push(options.recipient_address);
  }
  if (options.recipient_class) {
    clauses.push("recipient_class = ?");
    params.push(options.recipient_class);
  }
  if (options.recipient_host) {
    clauses.push("recipient_host = ?");
    params.push(options.recipient_host);
  }
  if (options.thread_key) {
    clauses.push("thread_key = ?");
    params.push(options.thread_key);
  }
  if (options.status && options.status !== "all") {
    if (options.status === "open") {
      clauses.push("status IN ('pending', 'claimed')");
    } else {
      clauses.push("status = ?");
      params.push(options.status);
    }
  }
  if (!options.include_expired) {
    clauses.push("(expires_at IS NULL OR expires_at > ?)");
    params.push(now);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = normalizeLimit(options.limit);
  const rows = db
    .prepare(`${SELECT_MESSAGE}${where} ORDER BY created_at ASC, message_id ASC LIMIT ?`)
    .all(...params, limit) as RawMessageRow[];
  return rows.map(hydrateMessage);
}

export function listThreadMessages(
  db: StateDriverDatabase,
  threadKey: string,
  options: { limit?: number | undefined } = {},
): MessageRow[] {
  return listMessages(db, {
    thread_key: normalizeRequired("thread_key", threadKey),
    status: "all",
    include_expired: true,
    limit: options.limit,
  });
}

function grantWhere(
  column: "recipient_address" | "sender",
  grants: readonly string[],
  params: unknown[],
  tablePrefix: "" | "message." = "",
): string {
  const predicates: string[] = [];
  for (const grant of grants) {
    if (grant.endsWith(":*")) {
      const prefix = grant.slice(0, -1);
      // SQLite LIKE folds ASCII case by default, and COLLATE BINARY does not
      // change LIKE semantics. Grants are exact protocol identities, so use a
      // binary prefix comparison that cannot promote a noncanonical legacy
      // row such as CLIENT:... into a client:* capability.
      predicates.push(`substr(${tablePrefix}${column}, 1, ?) = ? COLLATE BINARY`);
      params.push(prefix.length, prefix);
    } else {
      predicates.push(`${tablePrefix}${column} = ?`);
      params.push(grant);
    }
  }
  return predicates.length > 0 ? `(${predicates.join(" OR ")})` : "0";
}

function authorizedMessageWhere(
  options: Pick<AuthorizedMessageListOptions, "read_grants" | "send_as_grants">
    & Partial<Pick<AuthorizedMessageListOptions, "recipient_address" | "thread_key" | "status" | "include_expired" | "now">>,
  params: unknown[],
  tablePrefix: "" | "message." = "",
): string[] {
  const recipient = grantWhere("recipient_address", options.read_grants, params, tablePrefix);
  const sender = grantWhere("sender", options.send_as_grants, params, tablePrefix);
  const clauses = [`(${recipient} OR ${sender})`];
  if (options.recipient_address) {
    clauses.push(`${tablePrefix}recipient_address = ?`);
    params.push(normalizeRequired("recipient_address", options.recipient_address));
  }
  if (options.thread_key) {
    clauses.push(`${tablePrefix}thread_key = ?`);
    params.push(normalizeRequired("thread_key", options.thread_key));
  }
  if (options.status && options.status !== "all") {
    if (options.status === "open") {
      clauses.push(`${tablePrefix}status IN ('pending', 'claimed')`);
    } else {
      clauses.push(`${tablePrefix}status = ?`);
      params.push(options.status);
    }
  }
  if (!options.include_expired) {
    clauses.push(`(${tablePrefix}expires_at IS NULL OR ${tablePrefix}expires_at > ?)`);
    params.push(options.now ?? nowIso());
  }
  return clauses;
}

function cursorContextHash(context: string): string {
  return createHash("sha256").update(context).digest("hex");
}

function decodeMessageCursor(cursor: string, context: string): { created_at: string; message_id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      !isRecord(value)
      || typeof value["created_at"] !== "string"
      || typeof value["message_id"] !== "string"
      || value["context_hash"] !== cursorContextHash(context)
      || !value["created_at"]
      || !value["message_id"]
      || !Number.isFinite(Date.parse(value["created_at"]))
    ) {
      throw new Error("invalid shape");
    }
    return { created_at: value["created_at"], message_id: value["message_id"] };
  } catch {
    throw new MessageCursorError();
  }
}

function encodeMessageCursor(message: MessageRow, context: string): string {
  return Buffer.from(JSON.stringify({
    created_at: message.created_at,
    message_id: message.message_id,
    context_hash: cursorContextHash(context),
  })).toString("base64url");
}

/** Applies row authorization in SQL before ordering and pagination. */
export function listAuthorizedMessages(
  db: StateDriverDatabase,
  options: AuthorizedMessageListOptions,
): AuthorizedMessageListResult {
  const params: unknown[] = [];
  const clauses = authorizedMessageWhere(options, params);
  if (options.cursor) {
    const cursor = decodeMessageCursor(options.cursor, options.cursor_context);
    clauses.push("(created_at > ? OR (created_at = ? AND message_id > ?))");
    params.push(cursor.created_at, cursor.created_at, cursor.message_id);
  }
  const limit = normalizeLimit(options.limit, 50, 100);
  const rows = db.prepare(
    `${SELECT_MESSAGE}
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at ASC, message_id ASC
     LIMIT ?`,
  ).all(...params, limit + 1) as RawMessageRow[];
  const truncated = rows.length > limit;
  const messages = rows.slice(0, limit).map(hydrateMessage);
  return {
    messages,
    truncated,
    ...(truncated && messages.length > 0
      ? { next_cursor: encodeMessageCursor(messages.at(-1)!, options.cursor_context) }
      : {}),
  };
}

/** Reads one row only when it belongs to the caller-authorized SQL set. */
export function readAuthorizedMessage(
  db: StateDriverDatabase,
  messageId: string,
  options: Pick<AuthorizedMessageListOptions, "read_grants" | "send_as_grants" | "include_expired" | "now">,
): MessageRow | undefined {
  const params: unknown[] = [];
  const clauses = authorizedMessageWhere(options, params);
  clauses.push("message_id = ?");
  params.push(normalizeRequired("messageId", messageId));
  const row = db.prepare(
    `${SELECT_MESSAGE} WHERE ${clauses.join(" AND ")} LIMIT 1`,
  ).get(...params) as RawMessageRow | undefined;
  return row ? hydrateMessage(row) : undefined;
}

/** Returns only counts over the caller-authorized row set. */
export function countAuthorizedMessages(
  db: StateDriverDatabase,
  options: Pick<AuthorizedMessageListOptions, "read_grants" | "send_as_grants" | "now">,
): AuthorizedMessageCounts {
  const params: unknown[] = [];
  const clauses = authorizedMessageWhere(options, params);
  const rows = db.prepare(
    `SELECT status, COUNT(*) AS n
       FROM messages
      WHERE ${clauses.join(" AND ")}
      GROUP BY status`,
  ).all(...params) as Array<{ status: string; n: number | bigint }>;
  const counts: AuthorizedMessageCounts = {
    total: 0,
    open: 0,
    pending: 0,
    claimed: 0,
    acked: 0,
    dead_letter: 0,
    delivery_failed: 0,
  };
  for (const row of rows) {
    const n = typeof row.n === "bigint" ? Number(row.n) : row.n;
    counts.total += n;
    if (row.status === "pending" || row.status === "claimed") counts.open += n;
    if (row.status in counts && row.status !== "total" && row.status !== "open") {
      (counts as unknown as Record<string, number>)[row.status] = n;
    }
  }
  return counts;
}

export function canonicalizeJcs(value: unknown): string {
  return canonicalizeJsonJcs(value);
}

export function hashCanonicalJcs(value: unknown): string {
  return createHash("sha256").update(canonicalizeJcs(value)).digest("hex");
}

/**
 * Build the durable run identity for a Calyx-owned message-to-run delivery.
 *
 * The readable prefixes are bounded for operator ergonomics, while the full
 * message and source-run identities remain bound by the SHA-256 suffix. This
 * prevents punctuation normalization or prefix truncation from aliasing two
 * independent deliveries onto the same run.
 */
export function messageDeliveryTurnRunId(messageId: string, sourceRunId: string): string {
  const safeMessage = messageId.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
  const safeRun = sourceRunId.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
  const identityHash = hashCanonicalJcs({
    domain: "calyx.message-delivery-turn-run-id/v1",
    message_id: messageId,
    source_run_id: sourceRunId,
  });
  return `msg-${safeMessage}-to-${safeRun}-${identityHash}`;
}

export function claimDirectedMessages(
  db: StateDriverDatabase,
  options: ClaimMessagesOptions,
): MessageRow[] {
  const recipientAddress = normalizeRequired("recipient_address", options.recipient_address);
  const claimedBy = normalizeRequired("claimed_by", options.claimed_by);
  const now = options.now ?? nowIso();
  expireDirectedMessages(db, { now });
  expireDirectedClaims(db, {
    recipient_address: recipientAddress,
    now,
    max_expired_claim_cycles: options.max_expired_claim_cycles,
  });
  const limit = normalizeLimit(options.limit);
  const statusClause = options.peek
    ? "status IN ('pending', 'claimed')"
    : "(status = 'pending' OR (status = 'claimed' AND claimed_by = ?))";
  const params: unknown[] = options.peek
    ? [recipientAddress, now, limit]
    : [recipientAddress, claimedBy, now, limit];
  const rows = db
    .prepare(
      `${SELECT_MESSAGE}
       WHERE recipient_class = 'directed'
         AND recipient_address = ?
         AND ${statusClause}
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY
         CASE urgency WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
         created_at ASC,
         message_id ASC
       LIMIT ?`,
    )
    .all(...params) as RawMessageRow[];
  if (options.peek || rows.length === 0) {
    return rows.map(hydrateMessage);
  }
  const pendingIds = rows
    .filter((row) => row.status === "pending")
    .map((row) => row.message_id);
  if (pendingIds.length > 0) {
    const claimedUntil = addMs(now, options.claim_ttl_ms ?? MESSAGE_CLAIM_TTL_MS);
    const placeholders = pendingIds.map(() => "?").join(", ");
    db.prepare(
      `UPDATE messages
       SET status = 'claimed',
           claimed_until = ?,
           claimed_by = ?,
           updated_at = ?
       WHERE message_id IN (${placeholders}) AND status = 'pending'`,
    ).run(claimedUntil, claimedBy, now, ...pendingIds);
  }
  const pending = new Set(pendingIds);
  return rows.map((row) => {
    if (!pending.has(row.message_id)) {
      return hydrateMessage(row);
    }
    return readMessage(db, row.message_id) ?? hydrateMessage(row);
  });
}

export function peekScopeMessages(
  db: StateDriverDatabase,
  scopeAddress: string,
  options: { now?: string | undefined; limit?: number | undefined } = {},
): MessageRow[] {
  const now = options.now ?? nowIso();
  return listMessages(db, {
    recipient_address: normalizeRequired("scopeAddress", scopeAddress),
    recipient_class: "scope",
    status: "pending",
    now,
    limit: options.limit,
  });
}

export function ackMessage(
  db: StateDriverDatabase,
  messageId: string,
  options: { acked_by: string; acked_at?: string | undefined },
): AckMessageResult {
  const existing = readMessage(db, messageId);
  if (!existing) return { message: undefined, changed: false };
  if (existing.status === "acked") {
    return { message: existing, changed: false };
  }
  if (existing.recipient_class === "scope") {
    throw new Error("scope messages are bulletins and cannot be acked");
  }
  const ackedAt = options.acked_at ?? nowIso();
  const result = db.prepare(
    `UPDATE messages
     SET status = 'acked',
         claimed_until = NULL,
         claimed_by = NULL,
         updated_at = ?,
         acked_at = ?,
         acked_by = ?
     WHERE message_id = ? AND status IN ('pending', 'claimed')`,
  ).run(ackedAt, ackedAt, normalizeRequired("acked_by", options.acked_by), messageId);
  return { message: readMessage(db, messageId), changed: changeCount(result) > 0 };
}

export function markMessageDeadLetter(
  db: StateDriverDatabase,
  messageId: string,
  options: { reason: string; now?: string | undefined },
): MessageRow | undefined {
  const now = options.now ?? nowIso();
  db.prepare(
    `UPDATE messages
     SET status = 'dead_letter',
         dead_letter = 1,
         dead_letter_reason = ?,
         claimed_until = NULL,
         claimed_by = NULL,
         updated_at = ?
     WHERE message_id = ? AND recipient_class = 'directed' AND status IN ('pending', 'claimed')`,
  ).run(normalizeRequired("reason", options.reason), now, messageId);
  return readMessage(db, messageId);
}

export function markMessageDeliveryFailed(
  db: StateDriverDatabase,
  messageId: string,
  options: { reason: string; now?: string | undefined },
): MessageRow | undefined {
  const now = options.now ?? nowIso();
  db.prepare(
    `UPDATE messages
     SET status = 'delivery_failed',
         dead_letter = 1,
         dead_letter_reason = ?,
         claimed_until = NULL,
         claimed_by = NULL,
         updated_at = ?
     WHERE message_id = ? AND status IN ('outbox', 'pending', 'claimed')`,
  ).run(normalizeRequired("reason", options.reason), now, messageId);
  return readMessage(db, messageId);
}

export function expireDirectedMessages(
  db: StateDriverDatabase,
  options: { now?: string | undefined } = {},
): number {
  const now = options.now ?? nowIso();
  const result = db.prepare(
    `UPDATE messages
     SET status = 'dead_letter',
         dead_letter = 1,
         dead_letter_reason = 'expired',
         claimed_until = NULL,
         claimed_by = NULL,
         updated_at = ?
     WHERE recipient_class = 'directed'
       AND status IN ('pending', 'claimed')
       AND expires_at IS NOT NULL
       AND expires_at <= ?`,
  ).run(now, now);
  return changeCount(result);
}

export function expireDirectedClaims(
  db: StateDriverDatabase,
  options: {
    recipient_address?: string | undefined;
    now?: string | undefined;
    max_expired_claim_cycles?: number | undefined;
  } = {},
): number {
  const now = options.now ?? nowIso();
  const maxCycles = options.max_expired_claim_cycles ?? MESSAGE_EXPIRED_CLAIM_DEAD_LETTER_CYCLES;
  const clauses = [
    "recipient_class = 'directed'",
    "status = 'claimed'",
    "claimed_until IS NOT NULL",
    "claimed_until <= ?",
  ];
  const params: unknown[] = [now];
  if (options.recipient_address) {
    clauses.push("recipient_address = ?");
    params.push(options.recipient_address);
  }
  const rows = db.prepare(
    `SELECT message_id, expired_claim_cycles FROM messages WHERE ${clauses.join(" AND ")}`,
  ).all(...params) as Array<{ message_id: string; expired_claim_cycles: number | bigint }>;
  for (const row of rows) {
    const cycles = Number(row.expired_claim_cycles) + 1;
    if (cycles >= maxCycles) {
      db.prepare(
        `UPDATE messages
         SET status = 'dead_letter',
             dead_letter = 1,
             dead_letter_reason = 'expired_claim',
             expired_claim_cycles = ?,
             claimed_until = NULL,
             claimed_by = NULL,
             updated_at = ?
         WHERE message_id = ?`,
      ).run(cycles, now, row.message_id);
    } else {
      db.prepare(
        `UPDATE messages
         SET status = 'pending',
             expired_claim_cycles = ?,
             claimed_until = NULL,
             claimed_by = NULL,
             updated_at = ?
         WHERE message_id = ?`,
      ).run(cycles, now, row.message_id);
    }
  }
  return rows.length;
}

export function setMessageReceiptPath(
  db: StateDriverDatabase,
  messageId: string,
  receiptPath: string,
): MessageRow | undefined {
  const current = readMessage(db, messageId);
  const payload = current ? { ...current.payload } : {};
  delete payload["receipt_mirror"];
  db.prepare(`UPDATE messages SET receipt_path = ?, payload_json = ? WHERE message_id = ?`).run(
    receiptPath,
    JSON.stringify(payload),
    messageId,
  );
  return readMessage(db, messageId);
}

export function enqueueMessageReceiptMirror(
  db: StateDriverDatabase,
  messageId: string,
  queuedAt = nowIso(),
): MessageReceiptMirrorRow {
  // A savepoint composes with the caller's larger message/idempotency
  // transaction while also making standalone enqueue calls atomic. Holding
  // the read lock through the insert prevents another connection from
  // mutating the message between snapshot capture and durable enqueue.
  db.exec("SAVEPOINT enqueue_message_receipt_mirror");
  try {
    const existing = readMessageReceiptMirror(db, messageId);
    if (existing) {
      db.exec("RELEASE SAVEPOINT enqueue_message_receipt_mirror");
      return existing;
    }
    // Read and validate the raw SQLite domains and JSON before hydration can
    // coerce corrupt booleans, timestamps, or payloads into plausible values.
    const message = readMessageReceiptSnapshotSource(db, messageId);
    const admissionError = messageReceiptAdmissionSnapshotValidationError(message, messageId);
    if (admissionError) {
      throw new Error(
        `message receipt mirror ${messageId} requires an authentic admission snapshot: ${admissionError}`,
      );
    }
    db.prepare(
      `INSERT OR IGNORE INTO message_receipt_mirrors
         (message_id, receipt_snapshot_json, status, attempt_count,
          next_attempt_at, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, ?, ?, ?)`,
    ).run(messageId, JSON.stringify(message), queuedAt, queuedAt, queuedAt);
    const mirror = readMessageReceiptMirror(db, messageId);
    if (!mirror) {
      throw new Error(`message receipt mirror ${messageId} was not readable after insert`);
    }
    db.exec("RELEASE SAVEPOINT enqueue_message_receipt_mirror");
    return mirror;
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT enqueue_message_receipt_mirror");
    db.exec("RELEASE SAVEPOINT enqueue_message_receipt_mirror");
    throw error;
  }
}

export function readMessageReceiptMirror(
  db: StateDriverDatabase,
  messageId: string,
): MessageReceiptMirrorRow | undefined {
  const row = readRawMessageReceiptMirror(db, messageId);
  return row ? hydrateReceiptMirror(row) : undefined;
}

function readRawMessageReceiptMirror(
  db: StateDriverDatabase,
  messageId: string,
): RawMessageReceiptMirrorRow | undefined {
  return db.prepare(`${SELECT_RECEIPT_MIRROR} WHERE message_id = ?`).get(messageId) as
    | RawMessageReceiptMirrorRow
    | undefined;
}

export function countMessageReceiptMirrorsByStatus(
  db: StateDriverDatabase,
): MessageReceiptMirrorStatusCounts {
  const counts: MessageReceiptMirrorStatusCounts = { pending: 0, completed: 0 };
  const rows = db.prepare(
    `SELECT status, COUNT(*) AS count
     FROM message_receipt_mirrors
     GROUP BY status`,
  ).all() as Array<{ status: string; count: number | bigint }>;
  for (const row of rows) {
    if (row.status === "pending" || row.status === "completed") {
      counts[row.status] = Number(row.count);
    }
  }
  return counts;
}

/** Returns receipt-mirror counts only for messages in the caller-authorized SQL set. */
export function countAuthorizedMessageReceiptMirrorsByStatus(
  db: StateDriverDatabase,
  options: Pick<AuthorizedMessageListOptions, "read_grants" | "send_as_grants" | "now">,
): MessageReceiptMirrorStatusCounts {
  const params: unknown[] = [];
  const clauses = authorizedMessageWhere(options, params, "message.");
  const counts: MessageReceiptMirrorStatusCounts = { pending: 0, completed: 0 };
  const rows = db.prepare(
    `SELECT mirror.status, COUNT(*) AS count
       FROM message_receipt_mirrors AS mirror
       INNER JOIN messages AS message ON message.message_id = mirror.message_id
      WHERE ${clauses.join(" AND ")}
      GROUP BY mirror.status`,
  ).all(...params) as Array<{ status: string; count: number | bigint }>;
  for (const row of rows) {
    if (row.status === "pending" || row.status === "completed") {
      counts[row.status] = Number(row.count);
    }
  }
  return counts;
}

function listPendingMessageReceiptMirrors(
  db: StateDriverDatabase,
  options: { now: string; limit: number; message_id?: string | undefined; force?: boolean | undefined },
): RawMessageReceiptMirrorRow[] {
  const clauses = ["status = 'pending'"];
  const params: unknown[] = [];
  if (options.message_id) {
    clauses.push("message_id = ?");
    params.push(options.message_id);
  }
  if (!options.force) {
    clauses.push("(next_attempt_at IS NULL OR next_attempt_at <= ?)");
    params.push(options.now);
  }
  params.push(Math.max(1, Math.min(options.limit, 100)));
  return db.prepare(
    `${SELECT_RECEIPT_MIRROR}
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at ASC, message_id ASC
     LIMIT ?`,
  ).all(...params) as RawMessageReceiptMirrorRow[];
}

function messageReceiptMirrorError(error: unknown): { code: string; message: string } {
  const typed = error as NodeJS.ErrnoException | undefined;
  return {
    code: typeof typed?.code === "string" && typed.code.length > 0 ? typed.code : "mirror_write_failed",
    message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
  };
}

function messageReceiptMirrorRetryAt(attemptCount: number, attemptedAt: string): string {
  const base = Date.parse(attemptedAt);
  const delay = Math.min(60_000, 1_000 * (2 ** Math.max(0, Math.min(attemptCount - 1, 6))));
  return new Date((Number.isFinite(base) ? base : Date.now()) + delay).toISOString();
}

export function recordMessageReceiptMirrorFailure(
  db: StateDriverDatabase,
  messageId: string,
  error: unknown,
  attemptedAt = nowIso(),
  attemptAlreadyRecorded = false,
): MessageReceiptMirrorRow | undefined {
  if (!readMessage(db, messageId)) return undefined;
  const current = enqueueMessageReceiptMirror(db, messageId, attemptedAt);
  const nextAttemptCount = current.attempt_count + (attemptAlreadyRecorded ? 0 : 1);
  const normalized = messageReceiptMirrorError(error);
  db.prepare(
    `UPDATE message_receipt_mirrors
     SET status = 'pending',
         attempt_count = ?,
         next_attempt_at = ?,
         last_attempt_at = ?,
         last_error_code = ?,
         last_error_message = ?,
         updated_at = ?
     WHERE message_id = ?`,
  ).run(
    nextAttemptCount,
    messageReceiptMirrorRetryAt(nextAttemptCount, attemptedAt),
    attemptedAt,
    normalized.code,
    normalized.message,
    attemptedAt,
    messageId,
  );
  return readMessageReceiptMirror(db, messageId);
}

class MessageReceiptIdentityConflictError extends Error {
  readonly code = "receipt_identity_conflict";
}

class MessageReceiptHistoryInvalidError extends Error {
  readonly code = "receipt_history_invalid";
}

class MessageReceiptSnapshotInvalidError extends Error {
  readonly code = "receipt_snapshot_invalid";
}

function readMessageReceiptSnapshotSource(
  db: StateDriverDatabase,
  messageId: string,
): MessageRow {
  const row = db.prepare(`${SELECT_MESSAGE} WHERE message_id = ?`).get(messageId) as
    | RawMessageRow
    | undefined;
  if (!row) {
    throw new MessageReceiptSnapshotInvalidError(
      `Message receipt mirror ${messageId} has no authoritative source message.`,
    );
  }
  const sourceDomainError = messageReceiptSnapshotSourceDomainError(row);
  if (sourceDomainError) {
    throw new MessageReceiptSnapshotInvalidError(
      `Message receipt mirror ${messageId} has a malformed authoritative source row: ${sourceDomainError}.`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch {
    payload = undefined;
  }
  if (!isRecord(payload)) {
    throw new MessageReceiptSnapshotInvalidError(
      `Message receipt mirror ${messageId} has malformed authoritative payload JSON.`,
    );
  }
  try {
    return { ...hydrateMessage(row), payload };
  } catch (error) {
    throw new MessageReceiptSnapshotInvalidError(
      `Message receipt mirror ${messageId} has malformed authoritative provenance: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

function readMessageReceiptSnapshot(
  db: StateDriverDatabase,
  messageId: string,
): MessageRow {
  const row = db.prepare(
    `SELECT receipt_snapshot_json
     FROM message_receipt_mirrors
     WHERE message_id = ?`,
  ).get(messageId) as { receipt_snapshot_json: string | null } | undefined;
  if (!row?.receipt_snapshot_json) {
    throw new MessageReceiptSnapshotInvalidError(
      `Message receipt mirror ${messageId} has no immutable receipt snapshot.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.receipt_snapshot_json) as unknown;
  } catch {
    throw new MessageReceiptSnapshotInvalidError(
      `Message receipt mirror ${messageId} has malformed receipt snapshot JSON.`,
    );
  }
  const validationError = messageReceiptAdmissionSnapshotValidationError(parsed, messageId);
  const correspondenceError = validationError
    ? undefined
    : messageReceiptSnapshotCorrespondenceError(
        parsed,
        readMessageReceiptSnapshotSource(db, messageId),
      );
  if (validationError || correspondenceError) {
    throw new MessageReceiptSnapshotInvalidError(
      `Message receipt mirror ${messageId} has an invalid immutable receipt snapshot: ${validationError ?? correspondenceError}.`,
    );
  }
  return parsed as unknown as MessageRow;
}

async function repairMessageReceiptTail(receiptPath: string): Promise<void> {
  let handle;
  try {
    handle = await openFile(receiptPath, "r+");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return;
    const last = Buffer.alloc(1);
    await readFileHandleFully(handle, last, size - 1);
    if (last[0] === 10) return;

    let cursor = size;
    let recordStart = 0;
    while (cursor > 0) {
      const chunkStart = Math.max(0, cursor - 64 * 1024);
      const chunk = Buffer.alloc(cursor - chunkStart);
      await readFileHandleFully(handle, chunk, chunkStart);
      const newline = chunk.lastIndexOf(10);
      if (newline >= 0) {
        recordStart = chunkStart + newline + 1;
        break;
      }
      cursor = chunkStart;
    }
    const tail = Buffer.alloc(size - recordStart);
    await readFileHandleFully(handle, tail, recordStart);
    let validTail = true;
    try {
      JSON.parse(tail.toString("utf8"));
    } catch {
      validTail = false;
    }
    if (!validTail) {
      await handle.truncate(recordStart);
    } else {
      // A missing newline does not make an otherwise complete JSON receipt
      // disposable. Propagate I/O failures without truncating proven data.
      await writeFileHandleFully(handle, Buffer.from("\n"), size);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readFileHandleFully(
  handle: Awaited<ReturnType<typeof openFile>>,
  bytes: Uint8Array,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.read(
      bytes,
      offset,
      bytes.byteLength - offset,
      position + offset,
    );
    if (result.bytesRead <= 0) {
      throw new Error("receipt read reached an unexpected EOF");
    }
    if (result.bytesRead > bytes.byteLength - offset) {
      throw new Error("receipt read exceeded the requested byte range");
    }
    offset += result.bytesRead;
  }
}

async function writeFileHandleFully(
  handle: Awaited<ReturnType<typeof openFile>>,
  bytes: Uint8Array,
  position: number | null,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      position === null ? null : position + offset,
    );
    if (result.bytesWritten <= 0) {
      throw new Error("receipt write made no forward progress");
    }
    offset += result.bytesWritten;
  }
}

async function messageReceiptAlreadyExists(
  receiptPath: string,
  desiredEnvelope: { schema_version: typeof MESSAGE_SCHEMA_VERSION; message: MessageRow },
): Promise<boolean> {
  const desiredCanonical = serializeCanonicalMessageReceiptEnvelope(
    desiredEnvelope.message,
    receiptPath,
  );
  let foundDesiredEnvelope = false;
  let identityError: MessageReceiptIdentityConflictError | undefined;
  const scan = scanMessageReceiptFileEvidence(receiptPath, (messageId, parsed) => {
    if (messageId !== desiredEnvelope.message.message_id) return;
    if (
      !isRecord(parsed)
      || serializeCanonicalMessageReceiptEnvelope(parsed["message"], receiptPath) !== desiredCanonical
    ) {
      identityError ??= new MessageReceiptIdentityConflictError(
        `Receipt ${desiredEnvelope.message.message_id} already exists with a different canonical envelope.`,
      );
      return;
    }
    if (foundDesiredEnvelope) {
      identityError ??= new MessageReceiptIdentityConflictError(
        `Receipt ${desiredEnvelope.message.message_id} has duplicate canonical envelopes.`,
      );
      return;
    }
    foundDesiredEnvelope = true;
  });
  if (scan.read_error_code === "ENOENT") return false;
  if (scan.read_error || scan.malformed_evidence) {
    throw new MessageReceiptHistoryInvalidError(
      scan.read_error ?? scan.malformed_evidence ?? `Receipt history ${receiptPath} is invalid.`,
    );
  }
  if (identityError) throw identityError;
  return foundDesiredEnvelope;
}

async function appendMessageJsonlReceiptLocked(
  stateDir: string,
  message: MessageRow,
  options: {
    syncDirectory?: ((directoryPath: string) => Promise<void>) | undefined;
  } = {},
): Promise<string> {
  const receiptPath = resolve(stateDir, MESSAGE_JSONL_RELATIVE_PATH);
  await mkdir(dirname(receiptPath), { recursive: true });
  await repairMessageReceiptTail(receiptPath);
  const desiredEnvelope = {
    schema_version: MESSAGE_SCHEMA_VERSION as typeof MESSAGE_SCHEMA_VERSION,
    message: { ...message, receipt_path: receiptPath },
  };
  if (await messageReceiptAlreadyExists(receiptPath, desiredEnvelope)) {
    // A matching line may be the residue of a prior append whose fsync failed.
    // Re-establish file durability before directory sync or DB completion.
    const handle = await openFile(receiptPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    const handle = await openFile(receiptPath, "a");
    try {
      await writeFileHandleFully(
        handle,
        Buffer.from(`${serializeCanonicalMessageReceiptEnvelope(message, receiptPath)}\n`, "utf8"),
        null,
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const syncDirectory = options.syncDirectory ?? syncMessageReceiptDirectory;
  await syncDirectory(dirname(receiptPath));
  // The receipt directory may have been created by this append. Sync its
  // parent on every attempt so a failed first parent fsync cannot be skipped
  // by a retry that now observes an existing child directory.
  await syncDirectory(dirname(dirname(receiptPath)));
  return receiptPath;
}

export async function appendMessageJsonlReceipt(
  stateDir: string,
  message: MessageRow,
  options: {
    syncDirectory?: ((directoryPath: string) => Promise<void>) | undefined;
  } = {},
): Promise<string> {
  return withSqliteMutex(
    resolve(stateDir, MESSAGE_JSONL_MUTEX_RELATIVE_PATH),
    () => appendMessageJsonlReceiptLocked(stateDir, message, options),
  );
}

export async function syncMessageReceiptDirectory(directoryPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    handle = await openFile(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && ["EACCES", "EBADF", "EISDIR", "EINVAL", "EPERM"].includes(code ?? "")) return;
    throw error;
  } finally {
    await handle?.close();
  }
}

function completeMessageReceiptMirror(
  db: StateDriverDatabase,
  messageId: string,
  receiptPath: string,
  completedAt: string,
): void {
  setMessageReceiptPath(db, messageId, receiptPath);
  db.prepare(
    `UPDATE message_receipt_mirrors
     SET status = 'completed',
         next_attempt_at = NULL,
         completed_at = ?,
         receipt_path = ?,
         last_error_code = NULL,
         last_error_message = NULL,
         updated_at = ?
     WHERE message_id = ?`,
  ).run(completedAt, receiptPath, completedAt, messageId);
}

export async function drainMessageReceiptMirrors(
  db: StateDriverDatabase,
  stateDir: string,
  options: {
    now?: string | undefined;
    limit?: number | undefined;
    message_id?: string | undefined;
    force?: boolean | undefined;
    syncDirectory?: ((directoryPath: string) => Promise<void>) | undefined;
  } = {},
): Promise<DrainMessageReceiptMirrorsResult> {
  const now = options.now ?? nowIso();
  const pending = listPendingMessageReceiptMirrors(db, {
    now,
    limit: options.limit ?? 25,
    ...(options.message_id ? { message_id: options.message_id } : {}),
    ...(options.force !== undefined ? { force: options.force } : {}),
  });
  let completed = 0;
  let failed = 0;
  for (const mirror of pending) {
    try {
      const outcome = await withSqliteMutex(resolve(stateDir, MESSAGE_JSONL_MUTEX_RELATIVE_PATH), async () => {
        const currentMirror = readRawMessageReceiptMirror(db, mirror.message_id);
        if (currentMirror?.status !== "pending") return "skipped" as const;
        // Validate SQLite's raw storage domains before any Number coercion can
        // normalize hostile TEXT into an apparently legitimate attempt count.
        const controlError = messageReceiptMirrorControlValidationError(currentMirror);
        if (controlError) return "failed" as const;

        const attemptedAt = nowIso();
        db.prepare(
          `UPDATE message_receipt_mirrors
           SET attempt_count = attempt_count + 1,
               last_attempt_at = ?,
               next_attempt_at = ?,
               updated_at = ?
           WHERE message_id = ? AND status = 'pending'`,
        ).run(attemptedAt, attemptedAt, attemptedAt, mirror.message_id);
        try {
          const message = readMessageReceiptSnapshot(db, mirror.message_id);
          const receiptPath = await appendMessageJsonlReceiptLocked(stateDir, message, {
            ...(options.syncDirectory ? { syncDirectory: options.syncDirectory } : {}),
          });
          completeMessageReceiptMirror(db, mirror.message_id, receiptPath, nowIso());
          return "completed" as const;
        } catch (error) {
          recordMessageReceiptMirrorFailure(db, mirror.message_id, error, attemptedAt, true);
          return "failed" as const;
        }
      });
      if (outcome === "completed") completed += 1;
      if (outcome === "failed") failed += 1;
    } catch (error) {
      if (!(error instanceof SqliteMutexBusyError)) throw error;
      // Lock acquisition itself owns no mirror state. Preserve pending truth;
      // a concurrent owner may be about to complete it.
      failed += 1;
    }
  }
  return {
    attempted: pending.length,
    completed,
    failed,
    pending: countMessageReceiptMirrorsByStatus(db).pending,
  };
}

export function createMessageDeliveryAttempt(
  db: StateDriverDatabase,
  input: CreateMessageDeliveryAttemptInput,
): CreateMessageDeliveryAttemptResult {
  const bindingId = normalizeRequired("binding_id", input.binding_id);
  assertInSet("adapter", input.adapter, MESSAGE_DELIVERY_ADAPTERS);
  const attemptedAt = input.attempted_at ?? nowIso();
  const deliveryId = messageDeliveryId(input.message.message_id, bindingId);
  const result = db.prepare(
    `INSERT OR IGNORE INTO message_deliveries
       (delivery_id, message_id, binding_id, adapter, status, attempted_at,
        updated_at, target_json, evidence_json)
       VALUES (?, ?, ?, ?, 'attempted', ?, ?, ?, ?)`,
  ).run(
    deliveryId,
    input.message.message_id,
    bindingId,
    input.adapter,
    attemptedAt,
    attemptedAt,
    JSON.stringify(input.target ?? {}),
    JSON.stringify(input.evidence ?? {}),
  );
  const delivery = readMessageDelivery(db, deliveryId);
  if (!delivery) {
    throw new Error(`message delivery ${deliveryId} was not readable after insert`);
  }
  return { delivery, inserted: changeCount(result) > 0 };
}

export function readMessageDelivery(
  db: StateDriverDatabase,
  deliveryId: string,
): MessageDeliveryRow | undefined {
  const row = db
    .prepare(`${SELECT_DELIVERY} WHERE delivery_id = ?`)
    .get(deliveryId) as RawMessageDeliveryRow | undefined;
  return row ? hydrateDelivery(row) : undefined;
}

export function listMessageDeliveries(
  db: StateDriverDatabase,
  options: ListMessageDeliveriesOptions = {},
): MessageDeliveryRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.message_id) {
    clauses.push("message_id = ?");
    params.push(options.message_id);
  }
  if (options.status && options.status !== "all") {
    clauses.push("status = ?");
    params.push(options.status);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = normalizeLimit(options.limit);
  const rows = db
    .prepare(`${SELECT_DELIVERY}${where} ORDER BY attempted_at DESC, delivery_id ASC LIMIT ?`)
    .all(...params, limit) as RawMessageDeliveryRow[];
  return rows.map(hydrateDelivery);
}

export function completeMessageDelivery(
  db: StateDriverDatabase,
  input: CompleteMessageDeliveryInput,
): MessageDeliveryRow | undefined {
  assertInSet("status", input.status, ["delivered", "failed"] as const);
  const existing = readMessageDelivery(db, input.delivery_id);
  if (!existing) return undefined;
  if (existing.status !== "attempted") return existing;
  const completedAt = input.completed_at ?? nowIso();
  const target = input.target ?? existing.target;
  const evidence = input.evidence ?? existing.evidence;
  const errorCode = input.status === "failed" ? input.error_code ?? "delivery_failed" : null;
  const errorMessage = input.status === "failed" ? input.error_message ?? null : null;
  db.prepare(
    `UPDATE message_deliveries
     SET status = ?,
         delivered_at = ?,
         failed_at = ?,
         updated_at = ?,
         target_json = ?,
         evidence_json = ?,
         error_code = ?,
         error_message = ?
     WHERE delivery_id = ? AND status = 'attempted'`,
  ).run(
    input.status,
    input.status === "delivered" ? completedAt : null,
    input.status === "failed" ? completedAt : null,
    completedAt,
    JSON.stringify(target),
    JSON.stringify(evidence),
    errorCode,
    errorMessage,
    input.delivery_id,
  );
  if (input.status === "delivered") {
    db.prepare(
      `UPDATE messages
       SET delivered_at = COALESCE(delivered_at, ?),
           updated_at = ?
       WHERE message_id = ?`,
    ).run(completedAt, completedAt, existing.message_id);
  }
  return readMessageDelivery(db, input.delivery_id);
}

export function enqueueMessageOutbox(
  db: StateDriverDatabase,
  input: EnqueueMessageOutboxInput,
): MessageOutboxRow {
  const messageId = normalizeRequired("message_id", input.message_id);
  const targetHost = normalizeRequired("target_host", input.target_host);
  const now = input.now ?? nowIso();
  const outboxId = messageOutboxId(messageId, targetHost);
  db.prepare(
    `INSERT OR IGNORE INTO outbox
       (outbox_id, schema_version, message_id, target_host, target_url, status,
        expires_at, created_at, updated_at, payload_json)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
  ).run(
    outboxId,
    MESSAGE_OUTBOX_SCHEMA_VERSION,
    messageId,
    targetHost,
    null,
    input.expires_at ?? addMs(now, MESSAGE_OUTBOX_TTL_MS),
    now,
    now,
    JSON.stringify(input.payload ?? {}),
  );
  const row = readMessageOutbox(db, outboxId);
  if (!row) {
    throw new Error(`message outbox ${outboxId} was not readable after insert`);
  }
  return row;
}

export function readMessageOutbox(
  db: StateDriverDatabase,
  outboxId: string,
): MessageOutboxRow | undefined {
  const row = db
    .prepare(`${SELECT_OUTBOX} WHERE outbox_id = ?`)
    .get(outboxId) as RawMessageOutboxRow | undefined;
  return row ? hydrateOutbox(row) : undefined;
}

export function listPendingMessageOutbox(
  db: StateDriverDatabase,
  options: ListPendingOutboxOptions = {},
): MessageOutboxRow[] {
  const now = options.now ?? nowIso();
  const limit = normalizeLimit(options.limit);
  const rows = db
    .prepare(
      `${SELECT_OUTBOX}
       WHERE status = 'pending'
         AND expires_at > ?
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC, outbox_id ASC
       LIMIT ?`,
    )
    .all(now, now, limit) as RawMessageOutboxRow[];
  return rows.map(hydrateOutbox);
}

/**
 * Atomically owns one transport attempt before any credential lookup or
 * network I/O. The attempt id is the fencing token used by every completion.
 */
export function claimMessageOutboxAttempt(
  db: StateDriverDatabase,
  outboxId: string,
  options: ClaimMessageOutboxAttemptOptions = {},
): MessageOutboxRow | undefined {
  const now = options.now ?? nowIso();
  const attemptId = normalizeOptional(options.attempt_id) ?? randomUUID();
  const attemptTtlMs = options.attempt_ttl_ms ?? MESSAGE_OUTBOX_ATTEMPT_TTL_MS;
  if (!Number.isFinite(attemptTtlMs) || attemptTtlMs <= 0) {
    throw new Error("attempt_ttl_ms must be positive");
  }
  const changed = changeCount(db.prepare(
    `UPDATE outbox
     SET status = 'in_flight',
         attempt_count = attempt_count + 1,
         attempt_id = ?,
         attempt_expires_at = ?,
         next_attempt_at = NULL,
         last_attempt_at = ?,
         updated_at = ?,
         last_error_code = NULL,
         last_error_message = NULL
     WHERE outbox_id = ?
       AND status = 'pending'
       AND expires_at > ?
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
  ).run(
    attemptId,
    addMs(now, attemptTtlMs),
    now,
    now,
    outboxId,
    now,
    now,
  ));
  if (changed !== 1) return undefined;
  const claimed = readMessageOutbox(db, outboxId);
  return claimed?.status === "in_flight" && claimed.attempt_id === attemptId
    ? claimed
    : undefined;
}

export function markMessageOutboxForwarded(
  db: StateDriverDatabase,
  outboxId: string,
  options: { attempt_id: string; now?: string | undefined },
): MessageOutboxRow | undefined {
  const now = options.now ?? nowIso();
  const attemptId = normalizeRequired("attempt_id", options.attempt_id);
  db.exec("SAVEPOINT complete_message_outbox_forwarded");
  try {
    const changed = changeCount(db.prepare(
      `UPDATE outbox
       SET status = 'forwarded',
           forwarded_at = ?,
           updated_at = ?,
           acceptance_ambiguous = 0,
           attempt_id = NULL,
           attempt_expires_at = NULL,
           next_attempt_at = NULL,
           last_error_code = NULL,
           last_error_message = NULL
       WHERE outbox_id = ? AND status = 'in_flight' AND attempt_id = ?`,
    ).run(now, now, outboxId, attemptId));
    if (changed === 0) {
      const current = readMessageOutbox(db, outboxId);
      if (!current) {
        db.exec("RELEASE SAVEPOINT complete_message_outbox_forwarded");
        return undefined;
      }
      // A positive target response is stronger evidence than any local lease,
      // expiry, or competing-attempt projection. Reconcile instead of leaving a
      // false definitive failure after the target durably accepted the message.
      if (current.status !== "forwarded") {
        db.prepare(
          `UPDATE outbox
         SET status = 'forwarded',
             forwarded_at = ?,
             updated_at = ?,
             acceptance_ambiguous = 0,
               attempt_id = NULL,
               attempt_expires_at = NULL,
               next_attempt_at = NULL,
               last_error_code = NULL,
               last_error_message = NULL
           WHERE outbox_id = ? AND status != 'forwarded'`,
        ).run(now, now, outboxId);
      }
    }
    const forwarded = readMessageOutbox(db, outboxId);
    if (forwarded?.status === "forwarded") {
      db.prepare(
        `UPDATE messages
         SET status = 'outbox',
             dead_letter = 0,
             dead_letter_reason = NULL,
             updated_at = ?
         WHERE message_id = ? AND status = 'delivery_failed'`,
      ).run(now, forwarded.message_id);
    }
    db.exec("RELEASE SAVEPOINT complete_message_outbox_forwarded");
    return forwarded;
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT complete_message_outbox_forwarded");
    db.exec("RELEASE SAVEPOINT complete_message_outbox_forwarded");
    throw error;
  }
}

export function markMessageOutboxAttemptFailed(
  db: StateDriverDatabase,
  outboxId: string,
  options: {
    attempt_id: string;
    outcome: "not_accepted" | "unknown";
    error_code: string;
    error_message?: string | null | undefined;
    now?: string | undefined;
    retry_after_ms?: number | undefined;
  },
): MessageOutboxRow | undefined {
  const now = options.now ?? nowIso();
  const nextAttempt = options.retry_after_ms === undefined ? null : addMs(now, options.retry_after_ms);
  const unknownAfterTtl = options.outcome === "unknown";
  db.prepare(
    `UPDATE outbox
     SET status = CASE
           WHEN (acceptance_ambiguous = 1 OR ? = 1) AND expires_at <= ? THEN 'indeterminate'
           ELSE 'pending'
         END,
         acceptance_ambiguous = CASE
           WHEN ? = 1 THEN 1
           ELSE acceptance_ambiguous
         END,
         attempt_id = NULL,
         attempt_expires_at = NULL,
         next_attempt_at = CASE
           WHEN (acceptance_ambiguous = 1 OR ? = 1) AND expires_at <= ? THEN NULL
           ELSE ?
         END,
         updated_at = ?,
         last_error_code = ?,
         last_error_message = ?
     WHERE outbox_id = ? AND status = 'in_flight' AND attempt_id = ?`,
  ).run(
    unknownAfterTtl ? 1 : 0,
    now,
    unknownAfterTtl ? 1 : 0,
    unknownAfterTtl ? 1 : 0,
    now,
    nextAttempt,
    now,
    normalizeRequired("error_code", options.error_code),
    options.error_message ?? null,
    outboxId,
    normalizeRequired("attempt_id", options.attempt_id),
  );
  return readMessageOutbox(db, outboxId);
}

export function markMessageOutboxDeliveryFailed(
  db: StateDriverDatabase,
  outboxId: string,
  options: {
    attempt_id?: string | undefined;
    error_code: string;
    error_message?: string | null | undefined;
    now?: string | undefined;
  },
): MessageOutboxRow | undefined {
  const now = options.now ?? nowIso();
  const attemptId = normalizeOptional(options.attempt_id);
  db.exec("SAVEPOINT complete_message_outbox_failed");
  try {
    const changed = changeCount(db.prepare(
      `UPDATE outbox
       SET status = CASE
             WHEN acceptance_ambiguous = 1 THEN 'indeterminate'
             ELSE 'delivery_failed'
           END,
           attempt_id = NULL,
           attempt_expires_at = NULL,
           next_attempt_at = NULL,
           updated_at = ?,
           last_error_code = ?,
           last_error_message = ?
       WHERE outbox_id = ?
         AND ((? IS NULL AND status = 'pending')
           OR (? IS NOT NULL AND status = 'in_flight' AND attempt_id = ?))`,
    ).run(
      now,
      normalizeRequired("error_code", options.error_code),
      options.error_message ?? null,
      outboxId,
      attemptId,
      attemptId,
      attemptId,
    ));
    if (changed === 1) {
      const existing = readMessageOutbox(db, outboxId);
      if (existing?.status === "delivery_failed") {
        markMessageDeliveryFailed(db, existing.message_id, {
          now,
          reason: options.error_code,
        });
      }
    }
    const current = readMessageOutbox(db, outboxId);
    db.exec("RELEASE SAVEPOINT complete_message_outbox_failed");
    return current;
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT complete_message_outbox_failed");
    db.exec("RELEASE SAVEPOINT complete_message_outbox_failed");
    throw error;
  }
}

/**
 * Reclaims crashed attempts. Before the row TTL it is safe to retry because
 * remote receive is idempotent; after the TTL the only honest terminal state
 * is indeterminate because the target may have accepted before the crash.
 */
export function recoverExpiredMessageOutboxAttempts(
  db: StateDriverDatabase,
  options: { now?: string | undefined; outbox_id?: string | undefined } = {},
): MessageOutboxRow[] {
  const now = options.now ?? nowIso();
  const outboxId = normalizeOptional(options.outbox_id);
  const rows = db.prepare(
    `${SELECT_OUTBOX}
     WHERE status = 'in_flight'
       AND attempt_expires_at IS NOT NULL
       AND attempt_expires_at <= ?
       ${outboxId ? "AND outbox_id = ?" : ""}
     ORDER BY attempt_expires_at ASC, outbox_id ASC`,
  ).all(...(outboxId ? [now, outboxId] : [now])) as RawMessageOutboxRow[];
  const recovered: MessageOutboxRow[] = [];
  for (const row of rows) {
    const projected = projectMessageOutboxAt(hydrateOutbox(row), { now });
    const status = projected.status === "indeterminate" ? "indeterminate" : "pending";
    const changed = changeCount(db.prepare(
      `UPDATE outbox
       SET status = ?,
           acceptance_ambiguous = 1,
           attempt_id = NULL,
           attempt_expires_at = NULL,
           next_attempt_at = ?,
           updated_at = ?,
           last_error_code = ?,
           last_error_message = ?
       WHERE outbox_id = ?
         AND status = 'in_flight'
         AND attempt_id = ?
         AND attempt_expires_at <= ?`,
    ).run(
      status,
      projected.next_attempt_at,
      projected.updated_at,
      projected.last_error_code,
      projected.last_error_message,
      row.outbox_id,
      row.attempt_id,
      now,
    ));
    if (changed === 1) {
      const current = readMessageOutbox(db, row.outbox_id);
      if (current) recovered.push(current);
    }
  }
  return recovered;
}

/**
 * Project one outbox row at an observation instant without mutating storage.
 * Exact read projections use this so an elapsed pending row cannot appear live
 * merely because the background drain has not persisted its terminal state yet.
 */
export function projectMessageOutboxAt(
  outbox: MessageOutboxRow,
  options: { now?: string | undefined } = {},
): MessageOutboxRow {
  const now = options.now ?? nowIso();
  if (
    outbox.status === "in_flight"
    && outbox.attempt_expires_at !== null
    && outbox.attempt_expires_at <= now
  ) {
    const terminal = outbox.expires_at <= now;
    const transitionAt = terminal && outbox.expires_at > outbox.attempt_expires_at
      ? outbox.expires_at
      : outbox.attempt_expires_at;
    return {
      ...outbox,
      status: terminal ? "indeterminate" : "pending",
      acceptance_ambiguous: true,
      attempt_id: null,
      attempt_expires_at: null,
      next_attempt_at: terminal ? null : transitionAt,
      updated_at: transitionAt,
      last_error_code: terminal ? "outbox_attempt_result_unknown" : "outbox_attempt_lease_expired",
      last_error_message: terminal
        ? "message outbox attempt lease elapsed after forwarding TTL; target acceptance is unknown"
        : "message outbox attempt lease elapsed; retry is eligible",
    };
  }
  if (outbox.status !== "pending" || outbox.expires_at > now) return outbox;
  if (outbox.acceptance_ambiguous) {
    return {
      ...outbox,
      status: "indeterminate",
      next_attempt_at: null,
      updated_at: outbox.expires_at,
      last_error_code: "outbox_acceptance_ambiguous",
      last_error_message: "forwarding TTL elapsed after an attempt with unknown acceptance",
    };
  }
  return {
    ...outbox,
    status: "delivery_failed",
    next_attempt_at: null,
    updated_at: outbox.expires_at,
    last_error_code: "outbox_expired",
    last_error_message: "message outbox forwarding TTL elapsed",
  };
}

export function expireMessageOutbox(
  db: StateDriverDatabase,
  options: { now?: string | undefined; outbox_id?: string | undefined } = {},
): MessageOutboxRow[] {
  const now = options.now ?? nowIso();
  const outboxId = normalizeOptional(options.outbox_id);
  const expired = db.prepare(
    `${SELECT_OUTBOX}
     WHERE status = 'pending' AND expires_at <= ?
       ${outboxId ? "AND outbox_id = ?" : ""}
     ORDER BY expires_at ASC, outbox_id ASC`,
  ).all(...(outboxId ? [now, outboxId] : [now])) as RawMessageOutboxRow[];
  const terminalized: MessageOutboxRow[] = [];
  for (const row of expired) {
    const projected = projectMessageOutboxAt(hydrateOutbox(row), { now });
    if (row.acceptance_ambiguous === 1) {
      const changed = changeCount(db.prepare(
        `UPDATE outbox
         SET status = 'indeterminate',
             next_attempt_at = NULL,
             updated_at = ?,
             last_error_code = 'outbox_acceptance_ambiguous',
             last_error_message = 'forwarding TTL elapsed after an attempt with unknown acceptance'
         WHERE outbox_id = ?
           AND status = 'pending'
           AND acceptance_ambiguous = 1
           AND expires_at <= ?`,
      ).run(projected.updated_at, row.outbox_id, now));
      if (changed === 1) {
        const current = readMessageOutbox(db, row.outbox_id);
        if (current) terminalized.push(current);
      }
      continue;
    }
    const current = markMessageOutboxDeliveryFailed(db, row.outbox_id, {
      now: projected.updated_at,
      error_code: "outbox_expired",
      error_message: "message outbox forwarding TTL elapsed",
    });
    if (current?.status === "delivery_failed" && current.last_error_code === "outbox_expired") {
      terminalized.push(current);
    }
  }
  return terminalized;
}

export function countMessages(db: StateDriverDatabase): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM messages`)
    .get() as { n: number | bigint } | undefined;
  if (!row) return 0;
  return typeof row.n === "bigint" ? Number(row.n) : row.n;
}

export function countMessageDeliveries(db: StateDriverDatabase): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM message_deliveries`)
    .get() as { n: number | bigint } | undefined;
  if (!row) return 0;
  return typeof row.n === "bigint" ? Number(row.n) : row.n;
}

export function countMessageOutboxRows(db: StateDriverDatabase): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM outbox`)
    .get() as { n: number | bigint } | undefined;
  if (!row) return 0;
  return typeof row.n === "bigint" ? Number(row.n) : row.n;
}

export function countMessagesByStatus(db: StateDriverDatabase): MessageStatusCounts {
  const counts = zeroMessageStatusCounts();
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM messages GROUP BY status`)
    .all() as Array<{ status: string; n: number | bigint }>;
  for (const row of rows) {
    if ((MESSAGE_STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status as MessageStatus] =
        typeof row.n === "bigint" ? Number(row.n) : row.n;
    }
  }
  return counts;
}

export function countMessageDeliveriesByStatus(
  db: StateDriverDatabase,
): MessageDeliveryStatusCounts {
  const counts: MessageDeliveryStatusCounts = {
    attempted: 0,
    delivered: 0,
    failed: 0,
  };
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM message_deliveries GROUP BY status`)
    .all() as Array<{ status: string; n: number | bigint }>;
  for (const row of rows) {
    if ((MESSAGE_DELIVERY_STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status as MessageDeliveryStatus] =
        typeof row.n === "bigint" ? Number(row.n) : row.n;
    }
  }
  return counts;
}

export function countMessageOutboxByStatus(
  db: StateDriverDatabase,
): MessageOutboxStatusCounts {
  const counts: MessageOutboxStatusCounts = {
    pending: 0,
    in_flight: 0,
    forwarded: 0,
    indeterminate: 0,
    delivery_failed: 0,
  };
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM outbox GROUP BY status`)
    .all() as Array<{ status: string; n: number | bigint }>;
  for (const row of rows) {
    if ((MESSAGE_OUTBOX_STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status as MessageOutboxStatus] =
        typeof row.n === "bigint" ? Number(row.n) : row.n;
    }
  }
  return counts;
}

export function countPendingMessages(
  db: StateDriverDatabase,
  options: { now?: string | undefined } = {},
): MessagePendingCounts {
  const now = options.now ?? nowIso();
  const counts = {
    directed_pending: scalarCount(
      db,
      `SELECT COUNT(*) AS n FROM messages
       WHERE recipient_class = 'directed' AND status = 'pending'
         AND (expires_at IS NULL OR expires_at > ?)`,
      [now],
    ),
    directed_claimed: scalarCount(
      db,
      `SELECT COUNT(*) AS n FROM messages
       WHERE recipient_class = 'directed' AND status = 'claimed'
         AND (expires_at IS NULL OR expires_at > ?)`,
      [now],
    ),
    scope_pending: scalarCount(
      db,
      `SELECT COUNT(*) AS n FROM messages
       WHERE recipient_class = 'scope' AND status = 'pending' AND expires_at > ?`,
      [now],
    ),
    dead_letter: scalarCount(
      db,
      `SELECT COUNT(*) AS n FROM messages WHERE status = 'dead_letter'`,
      [],
    ),
    delivery_failed: scalarCount(
      db,
      `SELECT COUNT(*) AS n FROM messages WHERE status = 'delivery_failed'`,
      [],
    ),
    outbox_pending: scalarCount(
      db,
      `SELECT COUNT(*) AS n FROM outbox
       WHERE status IN ('pending', 'in_flight') AND expires_at > ?`,
      [now],
    ),
  };
  return counts;
}

export function checkMessageSchema(
  db: StateDriverDatabase,
): { status: "ok" | "drift"; findings: MessageSchemaFinding[] } {
  const findings: MessageSchemaFinding[] = [];
  for (const expected of MESSAGE_TABLES) {
    const tableRow = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(expected.table) as { name?: string } | undefined;
    if (!tableRow || tableRow.name !== expected.table) {
      findings.push({
        table: expected.table,
        code: "missing-table",
        detail: `expected table "${expected.table}" not present in schema`,
      });
      continue;
    }
    const columnInfo = db
      .prepare(`PRAGMA table_info(${expected.table})`)
      .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    const columns = columnInfo.map((column) => column.name);
    for (const required of expected.columns) {
      if (!columns.includes(required)) {
        findings.push({
          table: expected.table,
          code: "missing-column",
          detail: `expected column "${required}" not present on "${expected.table}"`,
        });
      }
    }
    if (expected.table === "message_receipt_mirrors") {
      const criticalColumnContract = [
        ["message_id", "TEXT"],
        ["receipt_snapshot_json", "TEXT"],
        ["status", "TEXT"],
        ["attempt_count", "INTEGER"],
        ["created_at", "TEXT"],
        ["updated_at", "TEXT"],
      ] as const;
      for (const [columnName, declaredType] of criticalColumnContract) {
        const column = columnInfo.find((candidate) => candidate.name === columnName);
        if (column && (column.type.toUpperCase() !== declaredType || column.notnull !== 1)) {
          findings.push({
            table: expected.table,
            code: "invalid-column-constraint",
            detail: `${columnName} must be declared ${declaredType} NOT NULL`,
          });
        }
      }
      const messageIdColumn = columnInfo.find((column) => column.name === "message_id");
      if (
        messageIdColumn
        && (
          messageIdColumn.pk !== 1
          || columnInfo.filter((column) => column.pk > 0).length !== 1
        )
      ) {
        findings.push({
          table: expected.table,
          code: "invalid-column-constraint",
          detail: "message_id must be the single-column primary key",
        });
      }
      const foreignKeys = db.prepare(
        "PRAGMA foreign_key_list(message_receipt_mirrors)",
      ).all() as Array<{
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
      }>;
      if (
        foreignKeys.length !== 1
        || foreignKeys[0]?.table !== "messages"
        || foreignKeys[0]?.from !== "message_id"
        || foreignKeys[0]?.to !== "message_id"
        || foreignKeys[0]?.on_update.toUpperCase() !== "NO ACTION"
        || foreignKeys[0]?.on_delete.toUpperCase() !== "CASCADE"
      ) {
        findings.push({
          table: expected.table,
          code: "invalid-column-constraint",
          detail: "message_id must reference messages(message_id) ON DELETE CASCADE with ON UPDATE NO ACTION",
        });
      }
      const tableSql = db.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).get(expected.table) as { sql?: string | null } | undefined;
      const checkExpressions = extractSqlCheckExpressions(tableSql?.sql ?? "")
        .map(normalizeSqlExpression);
      if (!checkExpressions.includes(normalizeSqlExpression("json_valid(receipt_snapshot_json)"))) {
        findings.push({
          table: expected.table,
          code: "invalid-column-constraint",
          detail: "receipt_snapshot_json must enforce CHECK (json_valid(receipt_snapshot_json))",
        });
      }
      if (!checkExpressions.includes(normalizeSqlExpression("status IN ('pending', 'completed')"))) {
        findings.push({
          table: expected.table,
          code: "invalid-column-constraint",
          detail: "status must enforce CHECK (status IN ('pending', 'completed'))",
        });
      }
      if (!checkExpressions.includes(normalizeSqlExpression(
        "typeof(attempt_count) = 'integer' AND attempt_count >= 0",
      ))) {
        findings.push({
          table: expected.table,
          code: "invalid-column-constraint",
          detail: "attempt_count must enforce a non-negative SQLite integer CHECK",
        });
      }
      if (!checkExpressions.includes(normalizeSqlExpression(MESSAGE_RECEIPT_MIRROR_CONTROL_CHECK_SQL))) {
        findings.push({
          table: expected.table,
          code: "invalid-column-constraint",
          detail: "receipt mirror status must enforce the exact relational and chronological control-state constraint",
        });
      }
    }
    if (expected.indexes && expected.indexes.length > 0) {
      const indexes = (db
        .prepare(`PRAGMA index_list(${expected.table})`)
        .all() as Array<{ name: string }>)
        .map((index) => index.name);
      for (const index of expected.indexes) {
        if (!indexes.includes(index)) {
          findings.push({
            table: expected.table,
            code: "missing-index",
            detail: `expected index "${index}" not present on "${expected.table}"`,
          });
        }
      }
    }
  }
  return { status: findings.length === 0 ? "ok" : "drift", findings };
}

function normalizeSqlExpression(value: string): string {
  let normalized = "";
  let index = 0;
  let quote: "'" | '"' | "`" | "]" | undefined;
  while (index < value.length) {
    const char = value[index]!;
    const next = value[index + 1];
    if (quote !== undefined) {
      normalized += char;
      if (quote === "]") {
        if (char === "]") quote = undefined;
        index += 1;
        continue;
      }
      if (char === quote) {
        if (next === quote) {
          normalized += next;
          index += 2;
          continue;
        }
        quote = undefined;
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      normalized += char;
      index += 1;
      continue;
    }
    if (char === "[") {
      quote = "]";
      normalized += char;
      index += 1;
      continue;
    }
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    normalized += char.toLowerCase();
    index += 1;
  }
  return normalized;
}

function stripSqlComments(sql: string): string {
  let result = "";
  let index = 0;
  let quote: "'" | '"' | "`" | "]" | undefined;
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (quote !== undefined) {
      result += char;
      if (quote === "]") {
        if (char === "]") quote = undefined;
        index += 1;
        continue;
      }
      if (char === quote) {
        if (next === quote) {
          result += next;
          index += 2;
          continue;
        }
        quote = undefined;
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      result += char;
      index += 1;
      continue;
    }
    if (char === "[") {
      quote = "]";
      result += char;
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index += 1;
      result += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index = Math.min(sql.length, index + 2);
      result += " ";
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

function extractSqlCheckExpressions(sql: string): string[] {
  const commentFree = stripSqlComments(sql);
  const expressions: string[] = [];
  let index = 0;
  let quote: "'" | '"' | "`" | "]" | undefined;
  while (index < commentFree.length) {
    const char = commentFree[index]!;
    const next = commentFree[index + 1];
    if (quote !== undefined) {
      if (quote === "]") {
        if (char === "]") quote = undefined;
        index += 1;
        continue;
      }
      if (char === quote) {
        if (next === quote) {
          index += 2;
          continue;
        }
        quote = undefined;
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "[") {
      quote = "]";
      index += 1;
      continue;
    }
    if (
      commentFree.slice(index, index + 5).toLowerCase() !== "check"
      || /[a-z0-9_]/iu.test(commentFree[index - 1] ?? "")
      || /[a-z0-9_]/iu.test(commentFree[index + 5] ?? "")
    ) {
      index += 1;
      continue;
    }
    let openIndex = index + 5;
    while (/\s/u.test(commentFree[openIndex] ?? "")) openIndex += 1;
    if (commentFree[openIndex] !== "(") {
      index += 5;
      continue;
    }
    let depth = 0;
    let expressionQuote: "'" | '"' | "`" | "]" | undefined;
    let closeIndex: number | undefined;
    for (let cursor = openIndex; cursor < commentFree.length; cursor += 1) {
      const expressionChar = commentFree[cursor]!;
      const expressionNext = commentFree[cursor + 1];
      if (expressionQuote !== undefined) {
        if (expressionQuote === "]") {
          if (expressionChar === "]") expressionQuote = undefined;
          continue;
        }
        if (expressionChar === expressionQuote) {
          if (expressionNext === expressionQuote) {
            cursor += 1;
            continue;
          }
          expressionQuote = undefined;
        }
        continue;
      }
      if (expressionChar === "'" || expressionChar === '"' || expressionChar === "`") {
        expressionQuote = expressionChar;
        continue;
      }
      if (expressionChar === "[") {
        expressionQuote = "]";
        continue;
      }
      if (expressionChar === "(") depth += 1;
      if (expressionChar !== ")") continue;
      depth -= 1;
      if (depth === 0) {
        closeIndex = cursor;
        break;
      }
    }
    if (closeIndex === undefined) break;
    expressions.push(commentFree.slice(openIndex + 1, closeIndex));
    index = closeIndex + 1;
  }
  return expressions;
}

/**
 * Explicit-doctor exhaustive malformed-row scan for the durable JSONL receipt
 * mirror. Rows are paged so memory is bounded; `limit` caps findings, not rows
 * inspected. Runtime delivery validates its selected row independently.
 */
export function listMalformedMessageReceiptSnapshots(
  db: StateDriverDatabase,
  limit = 50,
): MalformedMessageReceiptSnapshotFinding[] {
  const table = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get("message_receipt_mirrors") as { name?: string } | undefined;
  if (table?.name !== "message_receipt_mirrors") return [];
  const columns = (db.prepare("PRAGMA table_info(message_receipt_mirrors)").all() as Array<{
    name: string;
  }>).map((column) => column.name);
  if (!columns.includes("receipt_snapshot_json")) return [];

  const findings: MalformedMessageReceiptSnapshotFinding[] = [];
  const pageSize = 256;
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS calyx_receipt_doctor_expected (
      receipt_path TEXT NOT NULL,
      message_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      PRIMARY KEY (receipt_path, message_id)
    ) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS calyx_receipt_doctor_evidence (
      receipt_path TEXT NOT NULL,
      message_id TEXT NOT NULL,
      first_envelope_json TEXT NOT NULL,
      candidate_count INTEGER NOT NULL CHECK (candidate_count IN (1, 2)),
      PRIMARY KEY (receipt_path, message_id)
    ) WITHOUT ROWID;
    DELETE FROM calyx_receipt_doctor_expected;
    DELETE FROM calyx_receipt_doctor_evidence;
  `);
  try {
    const retainExpectation = db.prepare(
      `INSERT INTO calyx_receipt_doctor_expected
         (receipt_path, message_id, snapshot_json)
       VALUES (?, ?, ?)`,
    );
    let afterMessageId: string | undefined;
    while (findings.length < limit) {
      const rows = db.prepare(
        `SELECT message_id, receipt_snapshot_json, status, attempt_count,
                next_attempt_at, last_attempt_at, completed_at, receipt_path,
                last_error_code, last_error_message, created_at, updated_at
         FROM message_receipt_mirrors
         ${afterMessageId === undefined ? "" : "WHERE message_id > ?"}
         ORDER BY message_id
         LIMIT ?`,
      ).all(...(afterMessageId === undefined ? [pageSize] : [afterMessageId, pageSize])) as Array<{
        message_id: string;
        receipt_snapshot_json: string | null;
        status: string;
        attempt_count: number | bigint;
        next_attempt_at: string | null;
        last_attempt_at: string | null;
        completed_at: string | null;
        receipt_path: string | null;
        last_error_code: string | null;
        last_error_message: string | null;
        created_at: string;
        updated_at: string;
      }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        afterMessageId = row.message_id;
        const controlError = messageReceiptMirrorControlValidationError(row);
        if (controlError) {
          findings.push({
            message_id: row.message_id,
            code: "invalid-receipt-control",
            detail: `message ${row.message_id} has invalid receipt-mirror control state: ${controlError}`,
          });
          if (findings.length >= limit) break;
          continue;
        }
        let parsed: unknown;
        try {
          parsed = row.receipt_snapshot_json === null
            ? null
            : JSON.parse(row.receipt_snapshot_json) as unknown;
        } catch {
          parsed = undefined;
        }
        let validationError = messageReceiptAdmissionSnapshotValidationError(parsed, row.message_id);
        let source: MessageRow | undefined;
        if (!validationError) {
          try {
            source = readMessageReceiptSnapshotSource(db, row.message_id);
            validationError = messageReceiptSnapshotCorrespondenceError(
              parsed,
              source,
            );
          } catch (error) {
            validationError = error instanceof Error ? error.message : String(error);
          }
        }
        if (validationError) {
          findings.push({
            message_id: row.message_id,
            code: "invalid-receipt-snapshot",
            detail: `message ${row.message_id} has an invalid receipt snapshot: ${validationError}`,
          });
          if (findings.length >= limit) break;
          continue;
        }
        if (row.status === "completed") {
          if (row.receipt_path !== source?.receipt_path) {
            findings.push({
              message_id: row.message_id,
              code: "invalid-receipt-control",
              detail: `message ${row.message_id} has invalid receipt-mirror control state: mirror receipt_path does not match the authoritative message row`,
            });
            if (findings.length >= limit) break;
            continue;
          }
          retainExpectation.run(row.receipt_path!, row.message_id, JSON.stringify(parsed));
        }
      }
      if (rows.length < pageSize) break;
    }

    const retainEvidence = db.prepare(
      `INSERT INTO calyx_receipt_doctor_evidence
         (receipt_path, message_id, first_envelope_json, candidate_count)
       SELECT ?, ?, ?, 1
        WHERE EXISTS (
          SELECT 1 FROM calyx_receipt_doctor_expected
           WHERE receipt_path = ? AND message_id = ?
        )
       ON CONFLICT (receipt_path, message_id) DO UPDATE
         SET candidate_count = 2`,
    );
    const discardPathEvidence = db.prepare(
      "DELETE FROM calyx_receipt_doctor_evidence WHERE receipt_path = ?",
    );
    const discardPathExpectations = db.prepare(
      "DELETE FROM calyx_receipt_doctor_expected WHERE receipt_path = ?",
    );
    let afterReceiptPath: string | undefined;
    while (findings.length < limit) {
      const pathRow = db.prepare(
        `SELECT receipt_path
           FROM calyx_receipt_doctor_expected
          ${afterReceiptPath === undefined ? "" : "WHERE receipt_path > ?"}
          GROUP BY receipt_path
          ORDER BY receipt_path
          LIMIT 1`,
      ).get(...(afterReceiptPath === undefined ? [] : [afterReceiptPath])) as
        | { receipt_path: string }
        | undefined;
      if (!pathRow) break;
      const receiptPath = pathRow.receipt_path;
      afterReceiptPath = receiptPath;
      const scan = scanMessageReceiptFileEvidence(receiptPath, (messageId, envelope) => {
        retainEvidence.run(
          receiptPath,
          messageId,
          JSON.stringify(envelope),
          receiptPath,
          messageId,
        );
      });
      let afterExpectedMessageId: string | undefined;
      while (findings.length < limit) {
        const expectedRows = db.prepare(
          `SELECT expected.message_id, expected.snapshot_json,
                  evidence.first_envelope_json, evidence.candidate_count
             FROM calyx_receipt_doctor_expected AS expected
             LEFT JOIN calyx_receipt_doctor_evidence AS evidence
               ON evidence.receipt_path = expected.receipt_path
              AND evidence.message_id = expected.message_id
            WHERE expected.receipt_path = ?
              ${afterExpectedMessageId === undefined ? "" : "AND expected.message_id > ?"}
            ORDER BY expected.message_id
            LIMIT ?`,
        ).all(...(
          afterExpectedMessageId === undefined
            ? [receiptPath, pageSize]
            : [receiptPath, afterExpectedMessageId, pageSize]
        )) as Array<{
          message_id: string;
          snapshot_json: string;
          first_envelope_json: string | null;
          candidate_count: number | bigint | null;
        }>;
        if (expectedRows.length === 0) break;
        for (const expected of expectedRows) {
          afterExpectedMessageId = expected.message_id;
          const candidate = expected.first_envelope_json === null
            ? undefined
            : {
                first_envelope: JSON.parse(expected.first_envelope_json) as unknown,
                count: Number(expected.candidate_count) === 1 ? 1 as const : 2 as const,
              };
          const evidenceError = messageReceiptFileEvidenceError({
            receipt_path: receiptPath,
            envelopes_by_message_id: candidate === undefined
              ? new Map()
              : new Map([[expected.message_id, candidate]]),
            ...(scan.read_error ? { read_error: scan.read_error } : {}),
            ...(scan.malformed_evidence ? { malformed_evidence: scan.malformed_evidence } : {}),
          }, JSON.parse(expected.snapshot_json) as unknown, expected.message_id);
          if (!evidenceError) continue;
          findings.push({
            message_id: expected.message_id,
            code: "invalid-receipt-control",
            detail: `message ${expected.message_id} has invalid completed receipt evidence: ${evidenceError}`,
          });
          if (findings.length >= limit) break;
        }
        if (expectedRows.length < pageSize) break;
      }
      discardPathEvidence.run(receiptPath);
      discardPathExpectations.run(receiptPath);
    }
    return findings;
  } finally {
    db.exec(`
      DROP TABLE IF EXISTS temp.calyx_receipt_doctor_evidence;
      DROP TABLE IF EXISTS temp.calyx_receipt_doctor_expected;
    `);
  }
}

function scalarCount(
  db: StateDriverDatabase,
  sql: string,
  params: readonly unknown[],
): number {
  const row = db.prepare(sql).get(...params) as { n: number | bigint } | undefined;
  if (!row) return 0;
  return typeof row.n === "bigint" ? Number(row.n) : row.n;
}

function zeroMessageStatusCounts(): MessageStatusCounts {
  return {
    outbox: 0,
    pending: 0,
    claimed: 0,
    acked: 0,
    dead_letter: 0,
    delivery_failed: 0,
  };
}

function messageDeliveryId(messageId: string, bindingId: string): string {
  return `msgdel_${shortHash(`${messageId}\0${bindingId}`)}`;
}

function messageOutboxId(messageId: string, targetHost: string): string {
  return `outbox_${shortHash(`${messageId}\0${targetHost}`)}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
