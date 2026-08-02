import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { StateDriverDatabase } from "./driver";

export const SESSION_INGRESS_BINDING_SCHEMA_VERSION = "calyx.session-ingress-binding/v1";
export const SESSION_WAKE_DELIVERY_SCHEMA_VERSION = "calyx.session-wake-delivery/v1";
export const SESSION_WAKE_ENVELOPE_SCHEMA_VERSION = "calyx.session-wake/v1";

export const SESSION_INGRESS_BACKENDS = ["codex", "claude"] as const;
export type SessionIngressBackend = (typeof SESSION_INGRESS_BACKENDS)[number];

export const SESSION_INGRESS_ADAPTERS = ["unix_socket"] as const;
export type SessionIngressAdapter = (typeof SESSION_INGRESS_ADAPTERS)[number];

export const SESSION_WAKE_POINTER_KINDS = ["message", "monitor_wake"] as const;
export type SessionWakePointerKind = (typeof SESSION_WAKE_POINTER_KINDS)[number];

export const SESSION_WAKE_DELIVERY_STATUSES = ["attempted", "delivered", "failed"] as const;
export type SessionWakeDeliveryStatus = (typeof SESSION_WAKE_DELIVERY_STATUSES)[number];

export const DEFAULT_SESSION_INGRESS_LAUNCH_TTL_MS = 60_000;
export const DEFAULT_SESSION_INGRESS_LEASE_TTL_MS = 45_000;

export interface SessionIngressLaunchRow {
  launch_id: string;
  generation: string;
  backend: SessionIngressBackend;
  destination_host: string;
  adapter: SessionIngressAdapter;
  endpoint_ref: string;
  capabilities: SessionWakePointerKind[];
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface PreparedSessionIngressLaunch {
  launch: SessionIngressLaunchRow;
  /** One-use secret. Callers must only export it to the matching launch. */
  launch_nonce: string;
}

export interface SessionIngressBindingRow {
  binding_id: string;
  schema_version: typeof SESSION_INGRESS_BINDING_SCHEMA_VERSION;
  activity_id: string;
  backend: SessionIngressBackend;
  destination_host: string;
  harness_session_id: string;
  generation: string;
  launch_id: string;
  adapter: SessionIngressAdapter;
  endpoint_ref: string;
  capabilities: SessionWakePointerKind[];
  registered_at: string;
  renewed_at: string;
  expires_at: string;
  retired_at: string | null;
}

export interface SessionWakeDeliveryRow {
  delivery_id: string;
  schema_version: typeof SESSION_WAKE_DELIVERY_SCHEMA_VERSION;
  pointer_kind: SessionWakePointerKind;
  pointer_id: string;
  activity_id: string;
  binding_id: string | null;
  binding_generation: string | null;
  adapter: SessionIngressAdapter | null;
  status: SessionWakeDeliveryStatus;
  attempted_at: string;
  delivered_at: string | null;
  failed_at: string | null;
  updated_at: string;
  target: Record<string, unknown>;
  evidence: unknown;
  error_code: string | null;
  error_message: string | null;
}

export interface SessionWakeEnvelopeV1 {
  schema_version: typeof SESSION_WAKE_ENVELOPE_SCHEMA_VERSION;
  delivery_id: string;
  recipient_activity_id: string;
  binding: {
    binding_id: string;
    generation: string;
  };
  pointer: {
    kind: SessionWakePointerKind;
    id: string;
  };
  first_command: string;
  created_at: string;
}

interface RawLaunchRow {
  launch_id: string;
  nonce_hash: string;
  generation: string;
  backend: string;
  destination_host: string;
  adapter: string;
  endpoint_ref: string;
  capabilities_json: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

interface RawBindingRow {
  binding_id: string;
  schema_version: string;
  activity_id: string;
  backend: string;
  destination_host: string;
  harness_session_id: string;
  generation: string;
  launch_id: string;
  adapter: string;
  endpoint_ref: string;
  capabilities_json: string;
  registered_at: string;
  renewed_at: string;
  expires_at: string;
  retired_at: string | null;
}

interface RawDeliveryRow {
  delivery_id: string;
  schema_version: string;
  pointer_kind: string;
  pointer_id: string;
  activity_id: string;
  binding_id: string | null;
  binding_generation: string | null;
  adapter: string | null;
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

const SELECT_LAUNCH = `SELECT
  launch_id, nonce_hash, generation, backend, destination_host, adapter,
  endpoint_ref, capabilities_json, created_at, expires_at, consumed_at
FROM session_ingress_launches`;

const SELECT_BINDING = `SELECT
  binding_id, schema_version, activity_id, backend, destination_host,
  harness_session_id, generation, launch_id, adapter, endpoint_ref,
  capabilities_json, registered_at, renewed_at, expires_at, retired_at
FROM session_ingress_bindings`;

const SELECT_DELIVERY = `SELECT
  delivery_id, schema_version, pointer_kind, pointer_id, activity_id,
  binding_id, binding_generation, adapter, status, attempted_at, delivered_at,
  failed_at, updated_at, target_json, evidence_json, error_code, error_message
FROM session_wake_deliveries`;

export function prepareSessionIngressLaunch(
  db: StateDriverDatabase,
  input: {
    backend: SessionIngressBackend;
    destination_host: string;
    capabilities?: readonly SessionWakePointerKind[] | undefined;
    now?: string | undefined;
    launch_ttl_ms?: number | undefined;
  },
): PreparedSessionIngressLaunch {
  assertInSet("backend", input.backend, SESSION_INGRESS_BACKENDS);
  const destinationHost = required("destination_host", input.destination_host);
  const capabilities = normalizeCapabilities(input.capabilities);
  const now = input.now ?? new Date().toISOString();
  const expiresAt = addMs(now, positiveMs("launch_ttl_ms", input.launch_ttl_ms ?? DEFAULT_SESSION_INGRESS_LAUNCH_TTL_MS));
  const launchNonce = randomBytes(32).toString("base64url");
  const launchId = `ingress_launch_${randomUUID()}`;
  const generation = `ingress_generation_${randomUUID()}`;
  const endpointRef = `ingress_endpoint_${randomUUID()}`;
  db.prepare(
    `INSERT INTO session_ingress_launches
       (launch_id, nonce_hash, generation, backend, destination_host, adapter,
        endpoint_ref, capabilities_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'unix_socket', ?, ?, ?, ?)`,
  ).run(
    launchId,
    nonceHash(launchNonce),
    generation,
    input.backend,
    destinationHost,
    endpointRef,
    JSON.stringify(capabilities),
    now,
    expiresAt,
  );
  const launch = readSessionIngressLaunch(db, launchId);
  if (!launch) throw new Error(`session ingress launch ${launchId} was not readable after insert`);
  return { launch, launch_nonce: launchNonce };
}

export function readSessionIngressLaunch(
  db: StateDriverDatabase,
  launchId: string,
): SessionIngressLaunchRow | undefined {
  const row = db.prepare(`${SELECT_LAUNCH} WHERE launch_id = ?`).get(launchId) as RawLaunchRow | undefined;
  return row ? hydrateLaunch(row) : undefined;
}

export function exchangeSessionIngressLaunch(
  db: StateDriverDatabase,
  input: {
    launch_nonce: string;
    activity_id: string;
    harness_session_id: string;
    now?: string | undefined;
    lease_ttl_ms?: number | undefined;
  },
): SessionIngressBindingRow {
  const now = input.now ?? new Date().toISOString();
  const leaseTtlMs = positiveMs("lease_ttl_ms", input.lease_ttl_ms ?? DEFAULT_SESSION_INGRESS_LEASE_TTL_MS);
  const activity = parseExactInteractiveActivity(input.activity_id);
  const harnessSessionId = required("harness_session_id", input.harness_session_id);
  if (activity.sessionId !== harnessSessionId) {
    throw new Error("harness_session_id must match the exact activity session identity");
  }
  const hash = nonceHash(required("launch_nonce", input.launch_nonce));
  const savepoint = "exchange_session_ingress_launch";
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const raw = db.prepare(`${SELECT_LAUNCH} WHERE nonce_hash = ?`).get(hash) as RawLaunchRow | undefined;
    if (!raw) throw new Error("session ingress launch nonce is invalid");
    const launch = hydrateLaunch(raw);
    if (launch.consumed_at) throw new Error("session ingress launch nonce was already consumed");
    if (launch.expires_at <= now) throw new Error("session ingress launch nonce expired");
    if (launch.backend !== activity.backend) {
      throw new Error(`session ingress launch backend ${launch.backend} does not match activity backend ${activity.backend}`);
    }

    const consumed = changeCount(db.prepare(
      `UPDATE session_ingress_launches
       SET consumed_at = ?
       WHERE launch_id = ? AND consumed_at IS NULL AND expires_at > ?`,
    ).run(now, launch.launch_id, now));
    if (consumed !== 1) throw new Error("session ingress launch nonce could not be consumed exactly once");

    db.prepare(
      `UPDATE session_ingress_bindings
       SET retired_at = ?
       WHERE activity_id = ? AND retired_at IS NULL`,
    ).run(now, activity.activityId);

    const bindingId = `ingress_binding_${randomUUID()}`;
    db.prepare(
      `INSERT INTO session_ingress_bindings
         (binding_id, schema_version, activity_id, backend, destination_host,
          harness_session_id, generation, launch_id, adapter, endpoint_ref,
          capabilities_json, registered_at, renewed_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      bindingId,
      SESSION_INGRESS_BINDING_SCHEMA_VERSION,
      activity.activityId,
      activity.backend,
      launch.destination_host,
      harnessSessionId,
      launch.generation,
      launch.launch_id,
      launch.adapter,
      launch.endpoint_ref,
      JSON.stringify(launch.capabilities),
      now,
      now,
      addMs(now, leaseTtlMs),
    );
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    const binding = readSessionIngressBinding(db, bindingId);
    if (!binding) throw new Error(`session ingress binding ${bindingId} was not readable after insert`);
    return binding;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}

export function readSessionIngressBinding(
  db: StateDriverDatabase,
  bindingId: string,
): SessionIngressBindingRow | undefined {
  const row = db.prepare(`${SELECT_BINDING} WHERE binding_id = ?`).get(bindingId) as RawBindingRow | undefined;
  return row ? hydrateBinding(row) : undefined;
}

export function readActiveSessionIngressBinding(
  db: StateDriverDatabase,
  activityId: string,
): SessionIngressBindingRow | undefined {
  const activity = parseExactInteractiveActivity(activityId);
  const row = db.prepare(
    `${SELECT_BINDING} WHERE activity_id = ? AND retired_at IS NULL`,
  ).get(activity.activityId) as RawBindingRow | undefined;
  return row ? hydrateBinding(row) : undefined;
}

export function renewSessionIngressBinding(
  db: StateDriverDatabase,
  input: {
    binding_id: string;
    generation: string;
    now?: string | undefined;
    lease_ttl_ms?: number | undefined;
  },
): SessionIngressBindingRow | undefined {
  const now = input.now ?? new Date().toISOString();
  const expiresAt = addMs(now, positiveMs("lease_ttl_ms", input.lease_ttl_ms ?? DEFAULT_SESSION_INGRESS_LEASE_TTL_MS));
  const changed = changeCount(db.prepare(
    `UPDATE session_ingress_bindings
     SET renewed_at = ?, expires_at = ?
     WHERE binding_id = ? AND generation = ? AND retired_at IS NULL AND expires_at > ?`,
  ).run(now, expiresAt, required("binding_id", input.binding_id), required("generation", input.generation), now));
  return changed === 1 ? readSessionIngressBinding(db, input.binding_id) : undefined;
}

export function retireSessionIngressBinding(
  db: StateDriverDatabase,
  input: {
    binding_id: string;
    generation: string;
    now?: string | undefined;
  },
): SessionIngressBindingRow | undefined {
  const now = input.now ?? new Date().toISOString();
  const changed = changeCount(db.prepare(
    `UPDATE session_ingress_bindings
     SET retired_at = ?
     WHERE binding_id = ? AND generation = ? AND retired_at IS NULL`,
  ).run(now, required("binding_id", input.binding_id), required("generation", input.generation)));
  return changed === 1 ? readSessionIngressBinding(db, input.binding_id) : undefined;
}

export function expireSessionIngressBindings(
  db: StateDriverDatabase,
  options: { now?: string | undefined } = {},
): number {
  const now = options.now ?? new Date().toISOString();
  return changeCount(db.prepare(
    `UPDATE session_ingress_bindings
     SET retired_at = ?
     WHERE retired_at IS NULL AND expires_at <= ?`,
  ).run(now, now));
}

export type SessionIngressResolution =
  | { state: "available"; binding: SessionIngressBindingRow }
  | { state: "binding_expired"; binding: SessionIngressBindingRow }
  | { state: "binding_unavailable" };

export function resolveSessionIngressBinding(
  db: StateDriverDatabase,
  activityId: string,
  options: { now?: string | undefined } = {},
): SessionIngressResolution {
  const activity = parseExactInteractiveActivity(activityId);
  const binding = readActiveSessionIngressBinding(db, activity.activityId);
  if (!binding) return { state: "binding_unavailable" };
  const now = options.now ?? new Date().toISOString();
  if (binding.expires_at <= now) {
    retireSessionIngressBinding(db, {
      binding_id: binding.binding_id,
      generation: binding.generation,
      now,
    });
    return { state: "binding_expired", binding: { ...binding, retired_at: now } };
  }
  return { state: "available", binding };
}

export function sessionWakeDeliveryId(
  pointerKind: SessionWakePointerKind,
  pointerId: string,
  activityId: string,
): string {
  assertInSet("pointer_kind", pointerKind, SESSION_WAKE_POINTER_KINDS);
  const digest = createHash("sha256")
    .update(`${pointerKind}\0${required("pointer_id", pointerId)}\0${parseExactInteractiveActivity(activityId).activityId}`)
    .digest("hex");
  return `session_wake_${digest}`;
}

export function createSessionWakeDeliveryAttempt(
  db: StateDriverDatabase,
  input: {
    pointer_kind: SessionWakePointerKind;
    pointer_id: string;
    activity_id: string;
    attempted_at?: string | undefined;
  },
): { delivery: SessionWakeDeliveryRow; inserted: boolean } {
  const attemptedAt = input.attempted_at ?? new Date().toISOString();
  const activity = parseExactInteractiveActivity(input.activity_id);
  const pointerId = required("pointer_id", input.pointer_id);
  const deliveryId = sessionWakeDeliveryId(input.pointer_kind, pointerId, activity.activityId);
  const result = db.prepare(
    `INSERT OR IGNORE INTO session_wake_deliveries
       (delivery_id, schema_version, pointer_kind, pointer_id, activity_id,
        status, attempted_at, updated_at, target_json, evidence_json)
     VALUES (?, ?, ?, ?, ?, 'attempted', ?, ?, '{}', '{}')`,
  ).run(
    deliveryId,
    SESSION_WAKE_DELIVERY_SCHEMA_VERSION,
    input.pointer_kind,
    pointerId,
    activity.activityId,
    attemptedAt,
    attemptedAt,
  );
  const delivery = readSessionWakeDelivery(db, deliveryId);
  if (!delivery) throw new Error(`session wake delivery ${deliveryId} was not readable after insert`);
  return { delivery, inserted: changeCount(result) === 1 };
}

export function attachSessionWakeDeliveryBinding(
  db: StateDriverDatabase,
  deliveryId: string,
  binding: SessionIngressBindingRow,
  target: Record<string, unknown>,
): SessionWakeDeliveryRow | undefined {
  db.prepare(
    `UPDATE session_wake_deliveries
     SET binding_id = ?, binding_generation = ?, adapter = ?, target_json = ?
     WHERE delivery_id = ? AND status = 'attempted' AND binding_id IS NULL`,
  ).run(
    binding.binding_id,
    binding.generation,
    binding.adapter,
    JSON.stringify(target),
    deliveryId,
  );
  return readSessionWakeDelivery(db, deliveryId);
}

export function completeSessionWakeDelivery(
  db: StateDriverDatabase,
  input: {
    delivery_id: string;
    status: "delivered" | "failed";
    completed_at?: string | undefined;
    target?: Record<string, unknown> | undefined;
    evidence?: unknown;
    error_code?: string | null | undefined;
    error_message?: string | null | undefined;
  },
): SessionWakeDeliveryRow | undefined {
  const existing = readSessionWakeDelivery(db, input.delivery_id);
  if (!existing || existing.status !== "attempted") return existing;
  const completedAt = input.completed_at ?? new Date().toISOString();
  const errorCode = input.status === "failed"
    ? required("error_code", input.error_code ?? "delivery_failed")
    : null;
  db.prepare(
    `UPDATE session_wake_deliveries
     SET status = ?, delivered_at = ?, failed_at = ?, updated_at = ?,
         target_json = ?, evidence_json = ?, error_code = ?, error_message = ?
     WHERE delivery_id = ? AND status = 'attempted'`,
  ).run(
    input.status,
    input.status === "delivered" ? completedAt : null,
    input.status === "failed" ? completedAt : null,
    completedAt,
    JSON.stringify(input.target ?? existing.target),
    JSON.stringify(input.evidence ?? existing.evidence),
    errorCode,
    input.status === "failed" ? input.error_message ?? null : null,
    input.delivery_id,
  );
  return readSessionWakeDelivery(db, input.delivery_id);
}

export function readSessionWakeDelivery(
  db: StateDriverDatabase,
  deliveryId: string,
): SessionWakeDeliveryRow | undefined {
  const row = db.prepare(`${SELECT_DELIVERY} WHERE delivery_id = ?`).get(deliveryId) as RawDeliveryRow | undefined;
  return row ? hydrateDelivery(row) : undefined;
}

export function listSessionWakeDeliveries(
  db: StateDriverDatabase,
  options: { pointer_kind?: SessionWakePointerKind; pointer_id?: string; activity_id?: string; limit?: number } = {},
): SessionWakeDeliveryRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.pointer_kind) {
    clauses.push("pointer_kind = ?");
    params.push(options.pointer_kind);
  }
  if (options.pointer_id) {
    clauses.push("pointer_id = ?");
    params.push(options.pointer_id);
  }
  if (options.activity_id) {
    clauses.push("activity_id = ?");
    params.push(parseExactInteractiveActivity(options.activity_id).activityId);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(250, options.limit ?? 100));
  return (db.prepare(
    `${SELECT_DELIVERY}${where} ORDER BY attempted_at DESC, delivery_id ASC LIMIT ?`,
  ).all(...params, limit) as RawDeliveryRow[]).map(hydrateDelivery);
}

export function sessionWakeFirstCommand(kind: SessionWakePointerKind, pointerId: string): string {
  required("pointer_id", pointerId);
  return kind === "message"
    ? `calyx msg inbox --json`
    : `calyx monitor inbox --json`;
}

function hydrateLaunch(row: RawLaunchRow): SessionIngressLaunchRow {
  return {
    launch_id: row.launch_id,
    generation: row.generation,
    backend: row.backend as SessionIngressBackend,
    destination_host: row.destination_host,
    adapter: row.adapter as SessionIngressAdapter,
    endpoint_ref: row.endpoint_ref,
    capabilities: parseCapabilities(row.capabilities_json),
    created_at: row.created_at,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
  };
}

function hydrateBinding(row: RawBindingRow): SessionIngressBindingRow {
  return {
    binding_id: row.binding_id,
    schema_version: row.schema_version as typeof SESSION_INGRESS_BINDING_SCHEMA_VERSION,
    activity_id: row.activity_id,
    backend: row.backend as SessionIngressBackend,
    destination_host: row.destination_host,
    harness_session_id: row.harness_session_id,
    generation: row.generation,
    launch_id: row.launch_id,
    adapter: row.adapter as SessionIngressAdapter,
    endpoint_ref: row.endpoint_ref,
    capabilities: parseCapabilities(row.capabilities_json),
    registered_at: row.registered_at,
    renewed_at: row.renewed_at,
    expires_at: row.expires_at,
    retired_at: row.retired_at,
  };
}

function hydrateDelivery(row: RawDeliveryRow): SessionWakeDeliveryRow {
  return {
    delivery_id: row.delivery_id,
    schema_version: row.schema_version as typeof SESSION_WAKE_DELIVERY_SCHEMA_VERSION,
    pointer_kind: row.pointer_kind as SessionWakePointerKind,
    pointer_id: row.pointer_id,
    activity_id: row.activity_id,
    binding_id: row.binding_id,
    binding_generation: row.binding_generation,
    adapter: row.adapter as SessionIngressAdapter | null,
    status: row.status as SessionWakeDeliveryStatus,
    attempted_at: row.attempted_at,
    delivered_at: row.delivered_at,
    failed_at: row.failed_at,
    updated_at: row.updated_at,
    target: parseRecord(row.target_json),
    evidence: parseUnknown(row.evidence_json),
    error_code: row.error_code,
    error_message: row.error_message,
  };
}

function parseExactInteractiveActivity(value: string): {
  activityId: string;
  backend: SessionIngressBackend;
  sessionId: string;
} {
  const normalized = required("activity_id", value);
  const match = /^interactive:(codex|claude):(.+)$/u.exec(normalized);
  if (!match) throw new Error("activity_id must be exact interactive:<codex|claude>:<session-id>");
  return {
    activityId: normalized,
    backend: match[1] as SessionIngressBackend,
    sessionId: required("activity session id", match[2] ?? ""),
  };
}

function normalizeCapabilities(input: readonly SessionWakePointerKind[] | undefined): SessionWakePointerKind[] {
  const values = input ?? SESSION_WAKE_POINTER_KINDS;
  const unique = [...new Set(values)];
  if (unique.length === 0) throw new Error("capabilities must include at least one pointer kind");
  for (const value of unique) assertInSet("capability", value, SESSION_WAKE_POINTER_KINDS);
  return unique;
}

function parseCapabilities(value: string): SessionWakePointerKind[] {
  const parsed = parseUnknown(value);
  if (!Array.isArray(parsed)) throw new Error("session ingress capabilities must be an array");
  return normalizeCapabilities(parsed as SessionWakePointerKind[]);
}

function parseRecord(value: string): Record<string, unknown> {
  const parsed = parseUnknown(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function parseUnknown(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function nonceHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function addMs(value: string, ms: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`timestamp must be ISO-8601: ${value}`);
  return new Date(timestamp + ms).toISOString();
}

function positiveMs(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function required(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function assertInSet<T extends string>(label: string, value: string, values: readonly T[]): asserts value is T {
  if (!values.includes(value as T)) throw new Error(`${label} must be one of: ${values.join(", ")}`);
}

function changeCount(result: unknown): number {
  const changes = (result as { changes?: unknown }).changes;
  return typeof changes === "number" ? changes : Number(changes ?? 0);
}
