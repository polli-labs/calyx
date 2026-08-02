import { canonicalizeJcs } from "./canonical-json";
import type { StateDriverDatabase } from "./driver";
import { ORCHESTRATION_LEDGER_TABLES } from "./migrations";

/**
 * Wave 2.1 orchestration ledger helpers. Direct, typed operations against
 * the SQLite tables introduced in migration `0002`. Intentionally not a
 * generic repository registry — per the wave-2 charter, helpers stay
 * narrowly typed until a second caller justifies abstraction.
 */

export interface AppendEventInput {
  /** Idempotency key. Repeated appends with the same `event_id` are no-ops. */
  event_id: string;
  domain: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  cursor: string;
  occurred_at: string;
  /** Provenance: which host recorded the row. Not identity. */
  host?: string | undefined;
  /** Provenance: which agent recorded the row. Not identity. */
  agent_id?: string | undefined;
  /** Provenance: which component recorded the row. Not identity. */
  source?: string | undefined;
  payload: unknown;
}

export interface AppendEventResult {
  event_id: string;
  inserted: boolean;
}

export class OrchestrationEventIdentityConflictError extends Error {
  readonly eventId: string;
  /** Identity fields that actually diverged, so operators are not left guessing. */
  readonly divergentFields: readonly string[];

  constructor(eventId: string, divergentFields: readonly string[]) {
    const detail = divergentFields.length > 0
      ? ` Divergent identity fields: ${divergentFields.join(", ")}.`
      : "";
    super(
      `Orchestration event ${eventId} conflicts with the row already committed under that event_id.${detail}`,
    );
    this.name = "OrchestrationEventIdentityConflictError";
    this.eventId = eventId;
    this.divergentFields = divergentFields;
  }
}

/**
 * What an event *is*. `host`, `agent_id` and `source` are deliberately absent:
 * they record *who wrote the row*, not what happened. The same logical event
 * re-ingested by a different component (run-service live ingest vs a
 * `self upgrade` replay of the same run journal) is the same event, and must
 * be an idempotent no-op rather than a permanent fail-closed conflict.
 *
 * Per-writer progress is tracked where it belongs — `event_cursors` is keyed
 * `(source, domain)` and `source_freshness` on `(source_kind, source_id)`.
 */
interface EventIdentity {
  event_id: string;
  domain: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  cursor: string;
  occurred_at: string;
  payload: unknown;
}

const EVENT_IDENTITY_SCALAR_FIELDS = [
  "domain",
  "aggregate_type",
  "aggregate_id",
  "event_type",
  "cursor",
  "occurred_at",
] as const satisfies readonly (keyof EventIdentity)[];

/**
 * Identity fields on which `candidate` differs from `committed`. Empty means
 * the two are the same event and the append is a no-op. `event_id` is the
 * lookup key, so it is equal by construction and never reported.
 */
function divergentIdentityFields(
  candidate: EventIdentity,
  committed: EventIdentity,
): string[] {
  const divergent: string[] = EVENT_IDENTITY_SCALAR_FIELDS.filter(
    (field) => candidate[field] !== committed[field],
  );
  if (canonicalizeJcs(candidate.payload ?? null) !== canonicalizeJcs(committed.payload ?? null)) {
    divergent.push("payload");
  }
  return divergent;
}

/**
 * Exact-idempotent event append keyed by `event_id`. A repeated id is a no-op
 * when every identity-bearing field ({@link EventIdentity}) is equal; divergent
 * reuse fails closed instead of laundering a different event through
 * `INSERT OR IGNORE`. Provenance columns are recorded first-writer-wins: the
 * committed row keeps the writer that observed the event first, matching its
 * `recorded_at`, and `event_log` is never updated in place.
 */
export function appendOrchestrationEvent(
  db: StateDriverDatabase,
  input: AppendEventInput,
  now: () => string = () => new Date().toISOString(),
): AppendEventResult {
  const payloadJson = canonicalizeJcs(input.payload ?? null);
  const recorded_at = now();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO event_log
        (event_id, domain, aggregate_type, aggregate_id, event_type,
         cursor, occurred_at, recorded_at, host, agent_id, source, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.event_id,
      input.domain,
      input.aggregate_type,
      input.aggregate_id,
      input.event_type,
      input.cursor,
      input.occurred_at,
      recorded_at,
      input.host ?? null,
      input.agent_id ?? null,
      input.source ?? null,
      payloadJson,
    );
  const changes = typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
  if (changes === 0) {
    const existing = db.prepare(
      `SELECT event_id, domain, aggregate_type, aggregate_id, event_type,
              cursor, occurred_at, payload_json
       FROM event_log WHERE event_id = ?`,
    ).get(input.event_id) as
      | Omit<RawEventLogRow, "recorded_at" | "host" | "agent_id" | "source">
      | undefined;
    if (!existing) {
      throw new Error(`Orchestration event ${input.event_id} was ignored but no committed row exists.`);
    }
    let existingPayload: unknown;
    try {
      existingPayload = JSON.parse(existing.payload_json) as unknown;
    } catch {
      throw new OrchestrationEventIdentityConflictError(input.event_id, ["payload"]);
    }
    const divergent = divergentIdentityFields(input, {
      event_id: existing.event_id,
      domain: existing.domain,
      aggregate_type: existing.aggregate_type,
      aggregate_id: existing.aggregate_id,
      event_type: existing.event_type,
      cursor: existing.cursor,
      occurred_at: existing.occurred_at,
      payload: existingPayload,
    });
    if (divergent.length > 0) {
      throw new OrchestrationEventIdentityConflictError(input.event_id, divergent);
    }
  }
  return { event_id: input.event_id, inserted: changes > 0 };
}

export interface OrchestrationEventRow {
  event_id: string;
  domain: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  cursor: string;
  occurred_at: string;
  recorded_at: string;
  host: string | null;
  agent_id: string | null;
  source: string | null;
  payload: unknown;
}

interface RawEventLogRow {
  event_id: string;
  domain: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  cursor: string;
  occurred_at: string;
  recorded_at: string;
  host: string | null;
  agent_id: string | null;
  source: string | null;
  payload_json: string;
}

function hydrateEventRow(row: RawEventLogRow): OrchestrationEventRow {
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = row.payload_json;
  }
  return {
    event_id: row.event_id,
    domain: row.domain,
    aggregate_type: row.aggregate_type,
    aggregate_id: row.aggregate_id,
    event_type: row.event_type,
    cursor: row.cursor,
    occurred_at: row.occurred_at,
    recorded_at: row.recorded_at,
    host: row.host,
    agent_id: row.agent_id,
    source: row.source,
    payload,
  };
}

export interface ListEventsByAggregateOptions {
  /** Cap returned rows. Bounded responses by default. */
  limit?: number;
  /** Return events physically ingested after the row carrying this opaque cursor. */
  afterCursor?: string;
}

export function listEventsByAggregate(
  db: StateDriverDatabase,
  aggregate_type: string,
  aggregate_id: string,
  options: ListEventsByAggregateOptions = {},
): OrchestrationEventRow[] {
  const limit = typeof options.limit === "number" ? Math.max(0, Math.floor(options.limit)) : 1000;
  if (options.afterCursor !== undefined) {
    const boundary = db
      .prepare(
        `SELECT rowid AS ingest_ordinal
         FROM event_log
         WHERE aggregate_type = ? AND aggregate_id = ? AND cursor = ?
         ORDER BY rowid DESC
         LIMIT 1`,
      )
      .get(aggregate_type, aggregate_id, options.afterCursor) as
        | { ingest_ordinal: number | bigint }
        | undefined;
    if (!boundary) return [];
    const rows = db
      .prepare(
        `SELECT event_id, domain, aggregate_type, aggregate_id, event_type,
                cursor, occurred_at, recorded_at, host, agent_id, source, payload_json
         FROM event_log
         WHERE aggregate_type = ? AND aggregate_id = ? AND rowid > ?
         ORDER BY rowid ASC
         LIMIT ?`,
      )
      .all(aggregate_type, aggregate_id, boundary.ingest_ordinal, limit) as RawEventLogRow[];
    return rows.map(hydrateEventRow);
  }
  const rows = db
    .prepare(
      `SELECT event_id, domain, aggregate_type, aggregate_id, event_type,
              cursor, occurred_at, recorded_at, host, agent_id, source, payload_json
       FROM event_log
       WHERE aggregate_type = ? AND aggregate_id = ?
       ORDER BY rowid ASC
       LIMIT ?`,
    )
    .all(aggregate_type, aggregate_id, limit) as RawEventLogRow[];
  return rows.map(hydrateEventRow);
}

export function countEventsByAggregate(
  db: StateDriverDatabase,
  aggregate_type: string,
  aggregate_id: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM event_log WHERE aggregate_type = ? AND aggregate_id = ?`,
    )
    .get(aggregate_type, aggregate_id) as { n: number | bigint } | undefined;
  if (!row) return 0;
  return typeof row.n === "bigint" ? Number(row.n) : row.n;
}

/**
 * Cursor read helper — returns the last durably observed opaque cursor for a
 * given `(source, domain)` pair, or `undefined` when none has been written.
 * Callers update the cursor in authority order with {@link writeEventCursor}.
 */
export interface EventCursorRow {
  source: string;
  domain: string;
  cursor: string;
  observed_at: string;
  payload: unknown;
}

interface RawEventCursorRow {
  source: string;
  domain: string;
  cursor: string;
  observed_at: string;
  payload_json: string | null;
}

function hydrateCursorRow(row: RawEventCursorRow): EventCursorRow {
  let payload: unknown = null;
  if (row.payload_json) {
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = row.payload_json;
    }
  }
  return {
    source: row.source,
    domain: row.domain,
    cursor: row.cursor,
    observed_at: row.observed_at,
    payload,
  };
}

export function readEventCursor(
  db: StateDriverDatabase,
  source: string,
  domain: string,
): EventCursorRow | undefined {
  const row = db
    .prepare(
      `SELECT source, domain, cursor, observed_at, payload_json
       FROM event_cursors WHERE source = ? AND domain = ?`,
    )
    .get(source, domain) as RawEventCursorRow | undefined;
  return row ? hydrateCursorRow(row) : undefined;
}

export interface WriteEventCursorInput {
  source: string;
  domain: string;
  cursor: string;
  observed_at?: string;
  payload?: unknown;
}

export function writeEventCursor(
  db: StateDriverDatabase,
  input: WriteEventCursorInput,
  now: () => string = () => new Date().toISOString(),
): EventCursorRow {
  const observed_at = input.observed_at ?? now();
  const payloadJson =
    input.payload === undefined ? null : JSON.stringify(input.payload);
  // Cursors are opaque continuation tokens. Transaction commit order, not
  // lexical token order, determines which observation is latest.
  db.prepare(
    `INSERT INTO event_cursors (source, domain, cursor, observed_at, payload_json)
       VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source, domain) DO UPDATE SET
       cursor = excluded.cursor,
       observed_at = excluded.observed_at,
       payload_json = excluded.payload_json`,
  ).run(input.source, input.domain, input.cursor, observed_at, payloadJson);
  // Always read back so callers see the committed observation.
  return readEventCursor(db, input.source, input.domain) ?? {
    source: input.source,
    domain: input.domain,
    cursor: input.cursor,
    observed_at,
    payload: input.payload ?? null,
  };
}

/**
 * Lock acquisition with explicit stale-owner / expiry semantics:
 *
 *   - "acquired": no current holder OR the prior holder expired and was
 *     stolen (stolen=true in that case);
 *   - "held": a different owner holds the lock and it has not expired.
 *
 * The caller decides whether to retry, surface the held-by-other error, or
 * extend its own lock. Acquire calls are short transactions; callers must
 * not hold the SQLite write transaction open while doing other work.
 */
export interface LockHolder {
  lock_key: string;
  owner_id: string;
  acquired_at: string;
  expires_at: string;
  metadata: unknown;
}

interface RawLockRow {
  lock_key: string;
  owner_id: string;
  acquired_at: string;
  expires_at: string;
  metadata_json: string | null;
}

function hydrateLockRow(row: RawLockRow): LockHolder {
  let metadata: unknown = null;
  if (row.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json);
    } catch {
      metadata = row.metadata_json;
    }
  }
  return {
    lock_key: row.lock_key,
    owner_id: row.owner_id,
    acquired_at: row.acquired_at,
    expires_at: row.expires_at,
    metadata,
  };
}

export interface AcquireLockInput {
  lock_key: string;
  owner_id: string;
  /** Lease duration; the lock expires at acquired_at + ttl. */
  ttl_ms: number;
  metadata?: unknown;
}

export type AcquireLockOutcome =
  | {
      status: "acquired";
      holder: LockHolder;
      stolen: boolean;
      previous_owner_id?: string;
    }
  | {
      status: "held";
      holder: LockHolder;
    };

export function acquireLock(
  db: StateDriverDatabase,
  input: AcquireLockInput,
  now: () => Date = () => new Date(),
): AcquireLockOutcome {
  if (!Number.isFinite(input.ttl_ms) || input.ttl_ms <= 0) {
    throw new Error(`acquireLock: ttl_ms must be a positive finite number (got ${input.ttl_ms})`);
  }
  const acquiredAt = now();
  const acquired_at = acquiredAt.toISOString();
  const expires_at = new Date(acquiredAt.getTime() + input.ttl_ms).toISOString();
  const metadataJson =
    input.metadata === undefined ? null : JSON.stringify(input.metadata);

  // Single transaction so the read-modify-write is atomic against other
  // writers. SQLite serializes writers; concurrent acquires never both
  // succeed because of the PRIMARY KEY on lock_key.
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare(
        `SELECT lock_key, owner_id, acquired_at, expires_at, metadata_json
         FROM locks WHERE lock_key = ?`,
      )
      .get(input.lock_key) as RawLockRow | undefined;

    if (existing) {
      const expired = existing.expires_at <= acquired_at;
      const sameOwner = existing.owner_id === input.owner_id;
      if (!expired && !sameOwner) {
        db.exec("COMMIT");
        return { status: "held", holder: hydrateLockRow(existing) };
      }
      const previous_owner_id = sameOwner ? undefined : existing.owner_id;
      db.prepare(
        `UPDATE locks SET owner_id = ?, acquired_at = ?, expires_at = ?, metadata_json = ?
         WHERE lock_key = ?`,
      ).run(input.owner_id, acquired_at, expires_at, metadataJson, input.lock_key);
      db.exec("COMMIT");
      const refreshed: LockHolder = {
        lock_key: input.lock_key,
        owner_id: input.owner_id,
        acquired_at,
        expires_at,
        metadata: input.metadata ?? null,
      };
      return {
        status: "acquired",
        holder: refreshed,
        stolen: expired && !sameOwner,
        ...(previous_owner_id ? { previous_owner_id } : {}),
      };
    }

    db.prepare(
      `INSERT INTO locks (lock_key, owner_id, acquired_at, expires_at, metadata_json)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(input.lock_key, input.owner_id, acquired_at, expires_at, metadataJson);
    db.exec("COMMIT");
    return {
      status: "acquired",
      holder: {
        lock_key: input.lock_key,
        owner_id: input.owner_id,
        acquired_at,
        expires_at,
        metadata: input.metadata ?? null,
      },
      stolen: false,
    };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* swallow secondary error */
    }
    throw err;
  }
}

export interface ReleaseLockInput {
  lock_key: string;
  owner_id: string;
}

export type ReleaseLockOutcome =
  | { status: "released" }
  | { status: "not-held" }
  | { status: "owned-by-other"; holder: LockHolder };

/**
 * Release a lock, but only if the calling owner still holds it. Callers
 * see one of three outcomes so they can distinguish "we never had it",
 * "we released cleanly", and "someone stole it from us via expiry".
 */
export function releaseLock(
  db: StateDriverDatabase,
  input: ReleaseLockInput,
): ReleaseLockOutcome {
  const existing = db
    .prepare(
      `SELECT lock_key, owner_id, acquired_at, expires_at, metadata_json
       FROM locks WHERE lock_key = ?`,
    )
    .get(input.lock_key) as RawLockRow | undefined;
  if (!existing) {
    return { status: "not-held" };
  }
  if (existing.owner_id !== input.owner_id) {
    return { status: "owned-by-other", holder: hydrateLockRow(existing) };
  }
  db.prepare(`DELETE FROM locks WHERE lock_key = ? AND owner_id = ?`).run(
    input.lock_key,
    input.owner_id,
  );
  return { status: "released" };
}

export function readLock(
  db: StateDriverDatabase,
  lock_key: string,
): LockHolder | undefined {
  const row = db
    .prepare(
      `SELECT lock_key, owner_id, acquired_at, expires_at, metadata_json
       FROM locks WHERE lock_key = ?`,
    )
    .get(lock_key) as RawLockRow | undefined;
  return row ? hydrateLockRow(row) : undefined;
}

/**
 * Default cap for bounded list helpers used by `calyx state doctor`. Doctor
 * output must stay fixed-size per the wave-2 charter; callers that need a
 * different cap can pass `limit` explicitly.
 */
export const ORCHESTRATION_LIST_DEFAULT_LIMIT = 20;

/** Bounded result with sample rows plus total/truncated metadata. */
export interface BoundedList<T> {
  rows: T[];
  total: number;
  truncated: boolean;
}

function clampListLimit(limit: number | undefined): number {
  if (limit === undefined) return ORCHESTRATION_LIST_DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 0) return ORCHESTRATION_LIST_DEFAULT_LIMIT;
  return Math.floor(limit);
}

export interface ListExpiredLocksOptions {
  /** Comparison time. Defaults to "now". */
  asOf?: string;
  /** Cap returned sample. Defaults to `ORCHESTRATION_LIST_DEFAULT_LIMIT`. */
  limit?: number;
}

/**
 * Expired locks at `asOf`. Returns a bounded sample plus the total count and
 * a truncation flag so doctor output stays fixed-size. Operators inspect
 * this surface via `calyx state doctor`; orchestrators can surface stale
 * claims to the user without silently stealing them.
 */
export function listExpiredLocks(
  db: StateDriverDatabase,
  options: ListExpiredLocksOptions = {},
): BoundedList<LockHolder> {
  const asOf = options.asOf ?? new Date().toISOString();
  const limit = clampListLimit(options.limit);

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM locks WHERE expires_at <= ?`)
    .get(asOf) as { n: number | bigint } | undefined;
  const total = totalRow ? (typeof totalRow.n === "bigint" ? Number(totalRow.n) : totalRow.n) : 0;

  const rows = db
    .prepare(
      `SELECT lock_key, owner_id, acquired_at, expires_at, metadata_json
       FROM locks WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT ?`,
    )
    .all(asOf, limit) as RawLockRow[];

  return {
    rows: rows.map(hydrateLockRow),
    total,
    truncated: total > limit,
  };
}

/** Source freshness — substrate for stale-source reporting. */
export type SourceFreshnessStatus = "fresh" | "stale" | "error" | "unknown";

export interface SourceFreshnessRow {
  source_kind: string;
  source_id: string;
  observed_at: string;
  status: SourceFreshnessStatus;
  stale_after_ms: number | null;
  cursor: string | null;
  detail: string | null;
  payload: unknown;
}

interface RawFreshnessRow {
  source_kind: string;
  source_id: string;
  observed_at: string;
  status: string;
  stale_after_ms: number | null;
  cursor: string | null;
  detail: string | null;
  payload_json: string | null;
}

function hydrateFreshnessRow(row: RawFreshnessRow): SourceFreshnessRow {
  let payload: unknown = null;
  if (row.payload_json) {
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = row.payload_json;
    }
  }
  const status: SourceFreshnessStatus =
    row.status === "fresh" || row.status === "stale" || row.status === "error"
      ? row.status
      : "unknown";
  return {
    source_kind: row.source_kind,
    source_id: row.source_id,
    observed_at: row.observed_at,
    status,
    stale_after_ms: row.stale_after_ms,
    cursor: row.cursor,
    detail: row.detail,
    payload,
  };
}

export interface UpsertSourceFreshnessInput {
  source_kind: string;
  source_id: string;
  status: SourceFreshnessStatus;
  observed_at?: string;
  stale_after_ms?: number;
  cursor?: string;
  detail?: string;
  payload?: unknown;
}

export function upsertSourceFreshness(
  db: StateDriverDatabase,
  input: UpsertSourceFreshnessInput,
  now: () => string = () => new Date().toISOString(),
): SourceFreshnessRow {
  const observed_at = input.observed_at ?? now();
  const payloadJson =
    input.payload === undefined ? null : JSON.stringify(input.payload);
  db.prepare(
    `INSERT INTO source_freshness
       (source_kind, source_id, observed_at, status, stale_after_ms, cursor, detail, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_kind, source_id) DO UPDATE SET
       observed_at = excluded.observed_at,
       status = excluded.status,
       stale_after_ms = excluded.stale_after_ms,
       cursor = excluded.cursor,
       detail = excluded.detail,
       payload_json = excluded.payload_json`,
  ).run(
    input.source_kind,
    input.source_id,
    observed_at,
    input.status,
    input.stale_after_ms ?? null,
    input.cursor ?? null,
    input.detail ?? null,
    payloadJson,
  );
  return readSourceFreshness(db, input.source_kind, input.source_id) ?? {
    source_kind: input.source_kind,
    source_id: input.source_id,
    observed_at,
    status: input.status,
    stale_after_ms: input.stale_after_ms ?? null,
    cursor: input.cursor ?? null,
    detail: input.detail ?? null,
    payload: input.payload ?? null,
  };
}

export function readSourceFreshness(
  db: StateDriverDatabase,
  source_kind: string,
  source_id: string,
): SourceFreshnessRow | undefined {
  const row = db
    .prepare(
      `SELECT source_kind, source_id, observed_at, status, stale_after_ms, cursor, detail, payload_json
       FROM source_freshness WHERE source_kind = ? AND source_id = ?`,
    )
    .get(source_kind, source_id) as RawFreshnessRow | undefined;
  return row ? hydrateFreshnessRow(row) : undefined;
}

export interface ListStaleSourcesOptions {
  /** Comparison time. Defaults to "now". */
  asOf?: string;
  /** Restrict to a particular source_kind. */
  source_kind?: string;
  /** Cap returned sample. Defaults to `ORCHESTRATION_LIST_DEFAULT_LIMIT`. */
  limit?: number;
}

/**
 * Stale-source reporting. Returns a bounded sample plus the total count and
 * a truncation flag so doctor output stays fixed-size. Stale rows are those
 * explicitly marked `stale`/`error`, plus rows whose `stale_after_ms`
 * deadline has elapsed relative to `asOf` even if the recorded `status` is
 * still `fresh`.
 */
export function listStaleSources(
  db: StateDriverDatabase,
  options: ListStaleSourcesOptions = {},
): BoundedList<SourceFreshnessRow> {
  const asOf = options.asOf ?? new Date().toISOString();
  const asOfMs = Date.parse(asOf);
  const limit = clampListLimit(options.limit);

  const rows = options.source_kind
    ? (db
        .prepare(
          `SELECT source_kind, source_id, observed_at, status, stale_after_ms, cursor, detail, payload_json
           FROM source_freshness WHERE source_kind = ? ORDER BY observed_at ASC`,
        )
        .all(options.source_kind) as RawFreshnessRow[])
    : (db
        .prepare(
          `SELECT source_kind, source_id, observed_at, status, stale_after_ms, cursor, detail, payload_json
           FROM source_freshness ORDER BY observed_at ASC`,
        )
        .all() as RawFreshnessRow[]);

  // The stale check straddles SQL columns and JS time math (status flag OR
  // observed_at + stale_after_ms past asOf), so we scan and filter in JS.
  // For wave 2.1 the source_freshness table is bounded by source kind cardinality.
  const sample: SourceFreshnessRow[] = [];
  let total = 0;
  for (const row of rows) {
    let isStale = false;
    if (row.status === "stale" || row.status === "error") {
      isStale = true;
    } else if (row.stale_after_ms != null) {
      const observedMs = Date.parse(row.observed_at);
      if (
        Number.isFinite(observedMs) &&
        Number.isFinite(asOfMs) &&
        asOfMs - observedMs >= row.stale_after_ms
      ) {
        isStale = true;
      }
    }
    if (isStale) {
      total++;
      if (sample.length < limit) {
        sample.push(hydrateFreshnessRow(row));
      }
    }
  }
  return { rows: sample, total, truncated: total > limit };
}

/** Schema parity check used by `calyx state doctor` (migration 0002). */
export interface SchemaParityFinding {
  table: string;
  /** "missing-table" | "missing-column" | "missing-index" */
  code: "missing-table" | "missing-column" | "missing-index";
  detail: string;
}

export function checkOrchestrationLedgerSchema(
  db: StateDriverDatabase,
): { status: "ok" | "drift"; findings: SchemaParityFinding[] } {
  const findings: SchemaParityFinding[] = [];
  for (const expected of ORCHESTRATION_LEDGER_TABLES) {
    const tableRow = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(expected.table) as { name?: string } | undefined;
    if (!tableRow || tableRow.name !== expected.table) {
      findings.push({
        table: expected.table,
        code: "missing-table",
        detail: `expected table "${expected.table}" not present in schema`,
      });
      continue;
    }
    const columns = (db
      .prepare(`PRAGMA table_info(${expected.table})`)
      .all() as Array<{ name: string }>)
      .map((c) => c.name);
    for (const required of expected.columns) {
      if (!columns.includes(required)) {
        findings.push({
          table: expected.table,
          code: "missing-column",
          detail: `expected column "${required}" not present on "${expected.table}"`,
        });
      }
    }
    if (expected.indexes && expected.indexes.length > 0) {
      const liveIndexes = (db
        .prepare(`PRAGMA index_list(${expected.table})`)
        .all() as Array<{ name: string }>)
        .map((i) => i.name);
      for (const idx of expected.indexes) {
        if (!liveIndexes.includes(idx)) {
          findings.push({
            table: expected.table,
            code: "missing-index",
            detail: `expected index "${idx}" not present on "${expected.table}"`,
          });
        }
      }
    }
  }
  return { status: findings.length === 0 ? "ok" : "drift", findings };
}
