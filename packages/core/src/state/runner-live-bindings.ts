import type { StateDriverDatabase } from "./driver";
import { RUNNER_LIVE_BINDING_TABLES } from "./migrations";

export const RUNNER_LIVE_BINDING_SCHEMA_VERSION = "calyx.runner-live-binding/v1";

export const RUNNER_LIVE_BINDING_STATUSES = ["active", "closed"] as const;
export type RunnerLiveBindingStatus = (typeof RUNNER_LIVE_BINDING_STATUSES)[number];

export interface RunnerLiveBindingRow {
  binding_id: string;
  schema_version: typeof RUNNER_LIVE_BINDING_SCHEMA_VERSION;
  run_id: string;
  adapter: string;
  backend: string;
  lifecycle_owner: string;
  host: string;
  status: RunnerLiveBindingStatus;
  codex_home: string | null;
  transport_kind: string;
  endpoint: Record<string, unknown>;
  thread_id: string | null;
  active_turn_id: string | null;
  active_turn_source: string | null;
  active_turn_observed_at: string | null;
  active_turn_status: string | null;
  adapter_session_id: string | null;
  connection_id: string | null;
  auth_ref: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  last_error: string | null;
}

export interface UpsertRunnerLiveBindingInput {
  binding_id?: string | undefined;
  run_id: string;
  adapter: string;
  backend: string;
  lifecycle_owner: string;
  host: string;
  status?: RunnerLiveBindingStatus | undefined;
  codex_home?: string | null | undefined;
  transport_kind: string;
  endpoint?: Record<string, unknown> | undefined;
  thread_id?: string | null | undefined;
  active_turn_id?: string | null | undefined;
  active_turn_source?: string | null | undefined;
  active_turn_observed_at?: string | null | undefined;
  active_turn_status?: string | null | undefined;
  adapter_session_id?: string | null | undefined;
  connection_id?: string | null | undefined;
  auth_ref?: Record<string, unknown> | undefined;
  now?: string | undefined;
  closed_at?: string | null | undefined;
  last_error?: string | null | undefined;
}

export interface ListRunnerLiveBindingsOptions {
  run_id?: string | undefined;
  adapter?: string | undefined;
  status?: RunnerLiveBindingStatus | "all" | undefined;
  limit?: number | undefined;
}

export interface RecordRunnerLiveBindingActiveTurnInput {
  binding_id?: string | undefined;
  run_id?: string | undefined;
  adapter?: string | undefined;
  turn_id: string;
  source: string;
  observed_at?: string | undefined;
  status?: string | undefined;
}

export interface ClearRunnerLiveBindingActiveTurnInput {
  binding_id?: string | undefined;
  run_id?: string | undefined;
  adapter?: string | undefined;
  source: string;
  observed_at?: string | undefined;
  status?: string | null | undefined;
  last_error?: string | null | undefined;
}

export interface CloseRunnerLiveBindingInput {
  binding_id?: string | undefined;
  run_id?: string | undefined;
  adapter?: string | undefined;
  closed_at?: string | undefined;
  source?: string | undefined;
  last_error?: string | null | undefined;
}

export interface RunnerLiveBindingSchemaFinding {
  table: string;
  code: "missing-table" | "missing-column" | "missing-index";
  detail: string;
}

export type RunnerLiveBindingStatusCounts = Record<RunnerLiveBindingStatus, number>;

interface RawRunnerLiveBindingRow {
  binding_id: string;
  schema_version: string;
  run_id: string;
  adapter: string;
  backend: string;
  lifecycle_owner: string;
  host: string;
  status: string;
  codex_home: string | null;
  transport_kind: string;
  endpoint_json: string;
  thread_id: string | null;
  active_turn_id: string | null;
  active_turn_source: string | null;
  active_turn_observed_at: string | null;
  active_turn_status: string | null;
  adapter_session_id: string | null;
  connection_id: string | null;
  auth_ref_json: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  last_error: string | null;
}

const SECRET_AUTH_REF_KEYS = new Set([
  "api_key",
  "apikey",
  "authorization",
  "bearer",
  "password",
  "refresh_token",
  "secret",
  "token",
  "access_token",
]);

const SELECT_RUNNER_LIVE_BINDING = `SELECT
  binding_id, schema_version, run_id, adapter, backend, lifecycle_owner, host,
  status, codex_home, transport_kind, endpoint_json, thread_id,
  active_turn_id, active_turn_source, active_turn_observed_at,
  active_turn_status, adapter_session_id, connection_id, auth_ref_json,
  created_at, updated_at, closed_at, last_error
FROM runner_live_bindings`;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeRequired(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must be non-empty`);
  }
  return trimmed;
}

function optionalTrimmed(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
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

function parseObjectJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to empty object.
  }
  return {};
}

function assertAuthRefContainsNoSecrets(value: Record<string, unknown>): void {
  const stack: Array<{ path: string; value: unknown }> = [{ path: "auth_ref", value }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!current.value || typeof current.value !== "object") {
      continue;
    }
    if (Array.isArray(current.value)) {
      current.value.forEach((item, index) => stack.push({ path: `${current.path}[${index}]`, value: item }));
      continue;
    }
    for (const [key, child] of Object.entries(current.value as Record<string, unknown>)) {
      const normalized = key.trim().toLowerCase().replace(/[-\s]/g, "_");
      if (SECRET_AUTH_REF_KEYS.has(normalized)) {
        throw new Error(`${current.path}.${key} must be a reference descriptor, not secret material`);
      }
      stack.push({ path: `${current.path}.${key}`, value: child });
    }
  }
}

function defaultBindingId(runId: string, adapter: string): string {
  return `runner-live:${adapter}:${runId}`;
}

function hydrate(row: RawRunnerLiveBindingRow): RunnerLiveBindingRow {
  return {
    binding_id: row.binding_id,
    schema_version: row.schema_version as typeof RUNNER_LIVE_BINDING_SCHEMA_VERSION,
    run_id: row.run_id,
    adapter: row.adapter,
    backend: row.backend,
    lifecycle_owner: row.lifecycle_owner,
    host: row.host,
    status: row.status as RunnerLiveBindingStatus,
    codex_home: row.codex_home,
    transport_kind: row.transport_kind,
    endpoint: parseObjectJson(row.endpoint_json),
    thread_id: row.thread_id,
    active_turn_id: row.active_turn_id,
    active_turn_source: row.active_turn_source,
    active_turn_observed_at: row.active_turn_observed_at,
    active_turn_status: row.active_turn_status,
    adapter_session_id: row.adapter_session_id,
    connection_id: row.connection_id,
    auth_ref: parseObjectJson(row.auth_ref_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at,
    last_error: row.last_error,
  };
}

export function upsertRunnerLiveBinding(
  db: StateDriverDatabase,
  input: UpsertRunnerLiveBindingInput,
): RunnerLiveBindingRow {
  const runId = normalizeRequired("run_id", input.run_id);
  const adapter = normalizeRequired("adapter", input.adapter);
  const backend = normalizeRequired("backend", input.backend);
  const lifecycleOwner = normalizeRequired("lifecycle_owner", input.lifecycle_owner);
  const host = normalizeRequired("host", input.host);
  const transportKind = normalizeRequired("transport_kind", input.transport_kind);
  const status = input.status ?? "active";
  assertInSet("status", status, RUNNER_LIVE_BINDING_STATUSES);
  const authRef = input.auth_ref ?? {};
  assertAuthRefContainsNoSecrets(authRef);
  const timestamp = input.now ?? nowIso();
  const bindingId = optionalTrimmed(input.binding_id) ?? defaultBindingId(runId, adapter);

  db.prepare(
    `INSERT INTO runner_live_bindings
       (binding_id, schema_version, run_id, adapter, backend, lifecycle_owner,
        host, status, codex_home, transport_kind, endpoint_json, thread_id,
        active_turn_id, active_turn_source, active_turn_observed_at,
        active_turn_status, adapter_session_id, connection_id, auth_ref_json,
        created_at, updated_at, closed_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, adapter) DO UPDATE SET
       schema_version = excluded.schema_version,
       backend = excluded.backend,
       lifecycle_owner = excluded.lifecycle_owner,
       host = excluded.host,
       status = excluded.status,
       codex_home = excluded.codex_home,
       transport_kind = excluded.transport_kind,
       endpoint_json = excluded.endpoint_json,
       thread_id = excluded.thread_id,
       active_turn_id = excluded.active_turn_id,
       active_turn_source = excluded.active_turn_source,
       active_turn_observed_at = excluded.active_turn_observed_at,
       active_turn_status = excluded.active_turn_status,
       adapter_session_id = excluded.adapter_session_id,
       connection_id = excluded.connection_id,
       auth_ref_json = excluded.auth_ref_json,
       updated_at = excluded.updated_at,
       closed_at = excluded.closed_at,
       last_error = excluded.last_error`,
  ).run(
    bindingId,
    RUNNER_LIVE_BINDING_SCHEMA_VERSION,
    runId,
    adapter,
    backend,
    lifecycleOwner,
    host,
    status,
    optionalTrimmed(input.codex_home),
    transportKind,
    JSON.stringify(input.endpoint ?? {}),
    optionalTrimmed(input.thread_id),
    optionalTrimmed(input.active_turn_id),
    optionalTrimmed(input.active_turn_source),
    optionalTrimmed(input.active_turn_observed_at),
    optionalTrimmed(input.active_turn_status),
    optionalTrimmed(input.adapter_session_id),
    optionalTrimmed(input.connection_id),
    JSON.stringify(authRef),
    timestamp,
    timestamp,
    optionalTrimmed(input.closed_at),
    optionalTrimmed(input.last_error),
  );

  return readRunnerLiveBindingByRunAdapter(db, runId, adapter) ?? hydrate({
    binding_id: bindingId,
    schema_version: RUNNER_LIVE_BINDING_SCHEMA_VERSION,
    run_id: runId,
    adapter,
    backend,
    lifecycle_owner: lifecycleOwner,
    host,
    status,
    codex_home: optionalTrimmed(input.codex_home),
    transport_kind: transportKind,
    endpoint_json: JSON.stringify(input.endpoint ?? {}),
    thread_id: optionalTrimmed(input.thread_id),
    active_turn_id: optionalTrimmed(input.active_turn_id),
    active_turn_source: optionalTrimmed(input.active_turn_source),
    active_turn_observed_at: optionalTrimmed(input.active_turn_observed_at),
    active_turn_status: optionalTrimmed(input.active_turn_status),
    adapter_session_id: optionalTrimmed(input.adapter_session_id),
    connection_id: optionalTrimmed(input.connection_id),
    auth_ref_json: JSON.stringify(authRef),
    created_at: timestamp,
    updated_at: timestamp,
    closed_at: optionalTrimmed(input.closed_at),
    last_error: optionalTrimmed(input.last_error),
  });
}

export function readRunnerLiveBinding(
  db: StateDriverDatabase,
  bindingId: string,
): RunnerLiveBindingRow | undefined {
  const row = db
    .prepare(`${SELECT_RUNNER_LIVE_BINDING} WHERE binding_id = ?`)
    .get(bindingId) as RawRunnerLiveBindingRow | undefined;
  return row ? hydrate(row) : undefined;
}

export function readRunnerLiveBindingByRunAdapter(
  db: StateDriverDatabase,
  runId: string,
  adapter: string,
): RunnerLiveBindingRow | undefined {
  const row = db
    .prepare(`${SELECT_RUNNER_LIVE_BINDING} WHERE run_id = ? AND adapter = ?`)
    .get(runId, adapter) as RawRunnerLiveBindingRow | undefined;
  return row ? hydrate(row) : undefined;
}

export function listRunnerLiveBindings(
  db: StateDriverDatabase,
  options: ListRunnerLiveBindingsOptions = {},
): RunnerLiveBindingRow[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (options.run_id) {
    clauses.push("run_id = ?");
    params.push(options.run_id);
  }
  if (options.adapter) {
    clauses.push("adapter = ?");
    params.push(options.adapter);
  }
  if (options.status && options.status !== "all") {
    clauses.push("status = ?");
    params.push(options.status);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = normalizeLimit(options.limit);
  const rows = db
    .prepare(`${SELECT_RUNNER_LIVE_BINDING}${where} ORDER BY updated_at DESC, binding_id ASC LIMIT ?`)
    .all(...params, limit) as RawRunnerLiveBindingRow[];
  return rows.map(hydrate);
}

export function recordRunnerLiveBindingActiveTurn(
  db: StateDriverDatabase,
  input: RecordRunnerLiveBindingActiveTurnInput,
): RunnerLiveBindingRow | undefined {
  const existing = resolveBinding(db, input);
  if (!existing) return undefined;
  const observedAt = input.observed_at ?? nowIso();
  db.prepare(
    `UPDATE runner_live_bindings
       SET status = 'active',
           active_turn_id = ?,
           active_turn_source = ?,
           active_turn_observed_at = ?,
           active_turn_status = ?,
           updated_at = ?,
           closed_at = NULL,
           last_error = NULL
     WHERE binding_id = ?`,
  ).run(
    normalizeRequired("turn_id", input.turn_id),
    normalizeRequired("source", input.source),
    observedAt,
    optionalTrimmed(input.status) ?? "in_progress",
    observedAt,
    existing.binding_id,
  );
  return readRunnerLiveBinding(db, existing.binding_id);
}

export function clearRunnerLiveBindingActiveTurn(
  db: StateDriverDatabase,
  input: ClearRunnerLiveBindingActiveTurnInput,
): RunnerLiveBindingRow | undefined {
  const existing = resolveBinding(db, input);
  if (!existing) return undefined;
  const observedAt = input.observed_at ?? nowIso();
  db.prepare(
    `UPDATE runner_live_bindings
       SET active_turn_id = NULL,
           active_turn_source = ?,
           active_turn_observed_at = ?,
           active_turn_status = ?,
           updated_at = ?,
           last_error = ?
     WHERE binding_id = ?`,
  ).run(
    normalizeRequired("source", input.source),
    observedAt,
    optionalTrimmed(input.status),
    observedAt,
    optionalTrimmed(input.last_error),
    existing.binding_id,
  );
  return readRunnerLiveBinding(db, existing.binding_id);
}

export function closeRunnerLiveBinding(
  db: StateDriverDatabase,
  input: CloseRunnerLiveBindingInput,
): RunnerLiveBindingRow | undefined {
  const existing = resolveBinding(db, input);
  if (!existing) return undefined;
  const closedAt = input.closed_at ?? nowIso();
  db.prepare(
    `UPDATE runner_live_bindings
       SET status = 'closed',
           active_turn_id = NULL,
           active_turn_source = ?,
           active_turn_observed_at = ?,
           active_turn_status = 'closed',
           updated_at = ?,
           closed_at = ?,
           last_error = ?
     WHERE binding_id = ?`,
  ).run(
    optionalTrimmed(input.source) ?? "binding-closed",
    closedAt,
    closedAt,
    closedAt,
    optionalTrimmed(input.last_error),
    existing.binding_id,
  );
  return readRunnerLiveBinding(db, existing.binding_id);
}

export function countRunnerLiveBindings(db: StateDriverDatabase): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM runner_live_bindings`)
    .get() as { n: number | bigint } | undefined;
  if (!row) return 0;
  return typeof row.n === "bigint" ? Number(row.n) : row.n;
}

export function countRunnerLiveBindingsByStatus(
  db: StateDriverDatabase,
): RunnerLiveBindingStatusCounts {
  const counts: RunnerLiveBindingStatusCounts = { active: 0, closed: 0 };
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM runner_live_bindings GROUP BY status`)
    .all() as Array<{ status: string; n: number | bigint }>;
  for (const row of rows) {
    if ((RUNNER_LIVE_BINDING_STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status as RunnerLiveBindingStatus] =
        typeof row.n === "bigint" ? Number(row.n) : row.n;
    }
  }
  return counts;
}

export function checkRunnerLiveBindingSchema(
  db: StateDriverDatabase,
): { status: "ok" | "drift"; findings: RunnerLiveBindingSchemaFinding[] } {
  const findings: RunnerLiveBindingSchemaFinding[] = [];
  for (const expected of RUNNER_LIVE_BINDING_TABLES) {
    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(expected.table) as { name?: string } | undefined;
    if (!table) {
      findings.push({
        table: expected.table,
        code: "missing-table",
        detail: `missing table ${expected.table}`,
      });
      continue;
    }
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${expected.table})`).all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    for (const column of expected.columns) {
      if (!columns.has(column)) {
        findings.push({
          table: expected.table,
          code: "missing-column",
          detail: `missing column ${expected.table}.${column}`,
        });
      }
    }
    const indexes = new Set(
      (db.prepare(`PRAGMA index_list(${expected.table})`).all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    for (const index of expected.indexes ?? []) {
      if (!indexes.has(index)) {
        findings.push({
          table: expected.table,
          code: "missing-index",
          detail: `missing index ${index}`,
        });
      }
    }
  }
  return { status: findings.length === 0 ? "ok" : "drift", findings };
}

function resolveBinding(
  db: StateDriverDatabase,
  input: {
    binding_id?: string | undefined;
    run_id?: string | undefined;
    adapter?: string | undefined;
  },
): RunnerLiveBindingRow | undefined {
  if (input.binding_id) {
    return readRunnerLiveBinding(db, input.binding_id);
  }
  if (input.run_id && input.adapter) {
    return readRunnerLiveBindingByRunAdapter(db, input.run_id, input.adapter);
  }
  throw new Error("binding_id or run_id+adapter is required");
}

function normalizeLimit(limit: number | undefined, fallback = 50, max = 500): number {
  if (limit === undefined) return fallback;
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), max);
}
