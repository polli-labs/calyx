import type { StateDriverDatabase } from "./driver";
import { ACTIVITY_INDEX_TABLES } from "./migrations";

/**
 * Wave 2.3 / POL-1838 activity recall-index helpers. Direct, typed operations
 * against the `activity_messages`, `activity_source_cursors`, and
 * `activity_index_runs` tables introduced in migration `0013`, plus the
 * POL-1839 reconstruction columns and attachment metadata table in migration
 * `0014`.
 *
 * The store is the per-host normalized projection of harness-native
 * transcripts: derived, rebuildable-from-source, hash-per-row, observed-time.
 * Truth stays in the transcript files; these rows are a cache the tailer
 * (`@polli-labs/calyx-run-service`) fills and the local `calyx activity` read
 * path consults. The row shapes are declared structurally here so `core` does
 * not depend on `run-service`; run-service owns the normalizer that produces
 * the rows.
 *
 * Intentionally not a generic repository registry — the wave-2 charter keeps
 * helpers narrowly typed until a second caller justifies abstraction.
 */
export interface ActivityMessageRow {
  /** Stable id `<activity-id>:msg:<source-line>` minted by the normalizer. */
  message_id: string;
  activity_id: string;
  turn_id?: string | null | undefined;
  /** Source line of the message's first event; monotonic per activity. */
  seq: number;
  /** Semantic origin (the normalizer's `ActivityMessageRole`). */
  origin: string;
  /** Normalized text with attachments already stripped to `att:sha256:` refs. */
  text: string;
  token_count?: number | null | undefined;
  host?: string | null | undefined;
  backend: string;
  source_path: string;
  /** Absolute byte offset of the source line's start within the transcript. */
  source_offset: number;
  /** Per-row content hash; the idempotency signal for re-ingest. */
  content_hash: string;
  classifier_version: string;
  /** JSON array string of `att:sha256:` refs. */
  attachment_refs: string;
  /** Observed (ingest) time, ISO-8601. */
  observed_at: string;
  /** Per-message event time, ISO-8601; distinct from ingest time. */
  timestamp?: string | null | undefined;
  /** Versioned DTO reconstruction payload; nullable for pre-0014 rows. */
  payload_json?: string | null | undefined;
}

interface RawActivityMessageRow {
  message_id: string;
  activity_id: string;
  turn_id: string | null;
  seq: number | bigint;
  origin: string;
  text: string;
  token_count: number | bigint | null;
  host: string | null;
  backend: string;
  source_path: string;
  source_offset: number | bigint;
  content_hash: string;
  classifier_version: string;
  attachment_refs: string;
  observed_at: string;
  timestamp: string | null;
  payload_json: string | null;
}

function asNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function hydrateActivityMessageRow(row: RawActivityMessageRow): ActivityMessageRow {
  return {
    message_id: row.message_id,
    activity_id: row.activity_id,
    ...(row.turn_id !== null ? { turn_id: row.turn_id } : {}),
    seq: asNumber(row.seq),
    origin: row.origin,
    text: row.text,
    ...(row.token_count !== null ? { token_count: asNumber(row.token_count) } : {}),
    ...(row.host !== null ? { host: row.host } : {}),
    backend: row.backend,
    source_path: row.source_path,
    source_offset: asNumber(row.source_offset),
    content_hash: row.content_hash,
    classifier_version: row.classifier_version,
    attachment_refs: row.attachment_refs,
    observed_at: row.observed_at,
    ...(row.timestamp !== null ? { timestamp: row.timestamp } : {}),
    ...(row.payload_json !== null ? { payload_json: row.payload_json } : {}),
  };
}

const ACTIVITY_MESSAGE_SELECT = `SELECT
  message_id, activity_id, turn_id, seq, origin, text, token_count,
  host, backend, source_path, source_offset, content_hash,
  classifier_version, attachment_refs, observed_at, timestamp, payload_json
FROM activity_messages`;

export interface ActivityAttachmentRow {
  attachment_id: string;
  message_id: string;
  origin: string;
  sha256: string;
  mime: string;
  byte_size: number;
  observed_at: string;
}

interface RawActivityAttachmentRow {
  attachment_id: string;
  message_id: string;
  origin: string;
  sha256: string;
  mime: string;
  byte_size: number | bigint;
  observed_at: string;
}

function hydrateAttachmentRow(row: RawActivityAttachmentRow): ActivityAttachmentRow {
  return {
    attachment_id: row.attachment_id,
    message_id: row.message_id,
    origin: row.origin,
    sha256: row.sha256,
    mime: row.mime,
    byte_size: asNumber(row.byte_size),
    observed_at: row.observed_at,
  };
}

/**
 * Idempotent upsert keyed by `message_id`. Re-ingesting the same source bytes
 * produces identical rows (same stable id, same content), so repeated calls
 * never duplicate and the store stays rebuildable from transcripts. Returns the
 * number of rows whose content actually changed (insert or content-hash flip),
 * so the tailer can report real work done vs. no-op re-scans.
 */
export function upsertActivityMessages(
  db: StateDriverDatabase,
  rows: readonly ActivityMessageRow[],
): { upserted: number; changed: number } {
  if (rows.length === 0) return { upserted: 0, changed: 0 };
  const existing = db.prepare(
    `SELECT content_hash FROM activity_messages WHERE message_id = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO activity_messages
       (message_id, activity_id, turn_id, seq, origin, text, token_count,
        host, backend, source_path, source_offset, content_hash,
        classifier_version, attachment_refs, observed_at, timestamp, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       activity_id = excluded.activity_id,
       turn_id = excluded.turn_id,
       seq = excluded.seq,
       origin = excluded.origin,
       text = excluded.text,
       token_count = excluded.token_count,
       host = excluded.host,
       backend = excluded.backend,
       source_path = excluded.source_path,
       source_offset = excluded.source_offset,
       content_hash = excluded.content_hash,
       classifier_version = excluded.classifier_version,
       attachment_refs = excluded.attachment_refs,
       observed_at = excluded.observed_at,
       timestamp = excluded.timestamp,
       payload_json = excluded.payload_json`,
  );
  let changed = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const prior = existing.get(row.message_id) as { content_hash?: string } | undefined;
      if (!prior || prior.content_hash !== row.content_hash) {
        changed += 1;
      }
      insert.run(
        row.message_id,
        row.activity_id,
        row.turn_id ?? null,
        row.seq,
        row.origin,
        row.text,
        row.token_count ?? null,
        row.host ?? null,
        row.backend,
        row.source_path,
        row.source_offset,
        row.content_hash,
        row.classifier_version,
        row.attachment_refs,
        row.observed_at,
        row.timestamp ?? null,
        row.payload_json ?? null,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* swallow secondary error */
    }
    throw err;
  }
  return { upserted: rows.length, changed };
}

/**
 * Idempotent upsert of attachment metadata keyed by `attachment_id`.
 * Stores metadata only; exact bytes stay in the origin transcript and are
 * fetched lazily by the attachment read path.
 */
export function upsertActivityAttachments(
  db: StateDriverDatabase,
  rows: readonly ActivityAttachmentRow[],
): { upserted: number } {
  if (rows.length === 0) return { upserted: 0 };
  const insert = db.prepare(
    `INSERT INTO activity_attachments
       (attachment_id, message_id, origin, sha256, mime, byte_size, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(attachment_id) DO UPDATE SET
       message_id = excluded.message_id,
       origin = excluded.origin,
       sha256 = excluded.sha256,
       mime = excluded.mime,
       byte_size = excluded.byte_size,
       observed_at = excluded.observed_at`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      insert.run(
        row.attachment_id,
        row.message_id,
        row.origin,
        row.sha256,
        row.mime,
        row.byte_size,
        row.observed_at,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* swallow secondary error */
    }
    throw err;
  }
  return { upserted: rows.length };
}

/**
 * Replace attachment metadata for a bounded set of messages. The tailer uses
 * this for re-read turn overlaps where a message id is stable but the source
 * line's attachment set may have changed after an in-flight write.
 */
export function replaceActivityAttachmentsForMessages(
  db: StateDriverDatabase,
  messageIds: readonly string[],
  rows: readonly ActivityAttachmentRow[],
): { upserted: number } {
  if (messageIds.length === 0) return { upserted: 0 };
  const placeholders = messageIds.map(() => "?").join(", ");
  const insert = db.prepare(
    `INSERT INTO activity_attachments
       (attachment_id, message_id, origin, sha256, mime, byte_size, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `DELETE FROM activity_attachments
       WHERE message_id IN (${placeholders})`,
    ).run(...messageIds);
    for (const row of rows) {
      insert.run(
        row.attachment_id,
        row.message_id,
        row.origin,
        row.sha256,
        row.mime,
        row.byte_size,
        row.observed_at,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* swallow secondary error */
    }
    throw err;
  }
  return { upserted: rows.length };
}

export function listActivityAttachmentsForMessageIds(
  db: StateDriverDatabase,
  messageIds: readonly string[],
): ActivityAttachmentRow[] {
  if (messageIds.length === 0) return [];
  const placeholders = messageIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT attachment_id, message_id, origin, sha256, mime, byte_size, observed_at
       FROM activity_attachments
       WHERE message_id IN (${placeholders})
       ORDER BY message_id ASC, attachment_id ASC`,
    )
    .all(...messageIds) as RawActivityAttachmentRow[];
  return rows.map(hydrateAttachmentRow);
}

/** List messages for an activity ordered by `seq` (stable transcript order). */
export function listActivityMessagesForActivity(
  db: StateDriverDatabase,
  activityId: string,
): ActivityMessageRow[] {
  const rows = db
    .prepare(`${ACTIVITY_MESSAGE_SELECT} WHERE activity_id = ? ORDER BY seq ASC, message_id ASC`)
    .all(activityId) as RawActivityMessageRow[];
  return rows.map(hydrateActivityMessageRow);
}

/** List messages for a source path ordered by `seq`. */
export function listActivityMessagesForSource(
  db: StateDriverDatabase,
  sourcePath: string,
): ActivityMessageRow[] {
  const rows = db
    .prepare(`${ACTIVITY_MESSAGE_SELECT} WHERE source_path = ? ORDER BY seq ASC, message_id ASC`)
    .all(sourcePath) as RawActivityMessageRow[];
  return rows.map(hydrateActivityMessageRow);
}

export function countActivityMessages(db: StateDriverDatabase): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM activity_messages`)
    .get() as { n: number | bigint } | undefined;
  if (!row) return 0;
  return asNumber(row.n);
}

/** Count distinct stored messages for one source (accurate under re-reads). */
export function countActivityMessagesForSource(
  db: StateDriverDatabase,
  sourcePath: string,
): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM activity_messages WHERE source_path = ?`)
    .get(sourcePath) as { n: number | bigint } | undefined;
  if (!row) return 0;
  return asNumber(row.n);
}

/**
 * Delete every message row for a source path. Used when a transcript is
 * removed or a full re-ingest needs to evict stale rows before replacement.
 */
export function deleteActivityMessagesForSource(
  db: StateDriverDatabase,
  sourcePath: string,
): { deleted: number } {
  db
    .prepare(
      `DELETE FROM activity_attachments
       WHERE message_id IN (
         SELECT message_id FROM activity_messages WHERE source_path = ?
       )`,
    )
    .run(sourcePath);
  const result = db
    .prepare(`DELETE FROM activity_messages WHERE source_path = ?`)
    .run(sourcePath);
  return { deleted: asNumber(result.changes) };
}

// --- Source cursors -------------------------------------------------------

export interface ActivitySourceCursorRow {
  source_path: string;
  backend: string;
  activity_id?: string | null | undefined;
  /**
   * Committed byte offset: the last fully-consumed newline boundary. Drives
   * freshness (`pending_bytes = size - byte_offset`); always advances.
   */
  byte_offset: number;
  /** Next source line after the committed boundary (1-based). */
  next_line: number;
  /**
   * Turn-aware re-read start: the byte offset of the opening line of the last
   * (possibly in-flight) turn. The tailer reads from here so every slice starts
   * at a turn boundary and turn ids are assigned with full context — never
   * mid-turn. `resume_offset <= byte_offset`; the bounded overlap (one open
   * turn) is re-read each tick and upserted idempotently.
   */
  resume_offset: number;
  /** 1-based line corresponding to `resume_offset`. */
  resume_line: number;
  size_bytes?: number | null | undefined;
  mtime_ms?: number | null | undefined;
  content_hash?: string | null | undefined;
  classifier_version: string;
  message_count: number;
  updated_at: string;
  last_indexed_at?: string | null | undefined;
}

interface RawActivitySourceCursorRow {
  source_path: string;
  backend: string;
  activity_id: string | null;
  byte_offset: number | bigint;
  next_line: number | bigint;
  resume_offset: number | bigint;
  resume_line: number | bigint;
  size_bytes: number | bigint | null;
  mtime_ms: number | bigint | null;
  content_hash: string | null;
  classifier_version: string;
  message_count: number | bigint;
  updated_at: string;
  last_indexed_at: string | null;
}

function hydrateCursorRow(row: RawActivitySourceCursorRow): ActivitySourceCursorRow {
  return {
    source_path: row.source_path,
    backend: row.backend,
    ...(row.activity_id !== null ? { activity_id: row.activity_id } : {}),
    byte_offset: asNumber(row.byte_offset),
    next_line: asNumber(row.next_line),
    resume_offset: asNumber(row.resume_offset),
    resume_line: asNumber(row.resume_line),
    ...(row.size_bytes !== null ? { size_bytes: asNumber(row.size_bytes) } : {}),
    ...(row.mtime_ms !== null ? { mtime_ms: asNumber(row.mtime_ms) } : {}),
    ...(row.content_hash !== null ? { content_hash: row.content_hash } : {}),
    classifier_version: row.classifier_version,
    message_count: asNumber(row.message_count),
    updated_at: row.updated_at,
    ...(row.last_indexed_at !== null ? { last_indexed_at: row.last_indexed_at } : {}),
  };
}

const ACTIVITY_CURSOR_SELECT = `SELECT
  source_path, backend, activity_id, byte_offset, next_line, resume_offset,
  resume_line, size_bytes, mtime_ms, content_hash, classifier_version,
  message_count, updated_at, last_indexed_at
FROM activity_source_cursors`;

export function readActivitySourceCursor(
  db: StateDriverDatabase,
  sourcePath: string,
): ActivitySourceCursorRow | undefined {
  const row = db
    .prepare(`${ACTIVITY_CURSOR_SELECT} WHERE source_path = ?`)
    .get(sourcePath) as RawActivitySourceCursorRow | undefined;
  return row ? hydrateCursorRow(row) : undefined;
}

export function listActivitySourceCursors(
  db: StateDriverDatabase,
): ActivitySourceCursorRow[] {
  const rows = db
    .prepare(`${ACTIVITY_CURSOR_SELECT} ORDER BY source_path ASC`)
    .all() as RawActivitySourceCursorRow[];
  return rows.map(hydrateCursorRow);
}

/**
 * Move one derived activity source projection to a new truth-plane path.
 *
 * Harnesses may move a transcript without changing its activity identity (for
 * example Codex `sessions` -> `archived_sessions`). Keep the cursor and every
 * projected row together in one transaction so the next tailer tick resumes at
 * the existing byte boundary and never duplicates stable message ids.
 *
 * This deliberately refuses to merge two projections. Callers must first
 * prove that `fromSourcePath` disappeared and `toSourcePath` is the same
 * transcript identity; an already-indexed target is therefore a collision.
 */
export function relocateActivitySource(
  db: StateDriverDatabase,
  fromSourcePath: string,
  toSourcePath: string,
): void {
  if (fromSourcePath === toSourcePath) return;
  const source = readActivitySourceCursor(db, fromSourcePath);
  if (!source) {
    throw new Error(`activity source cursor not found for relocation: ${fromSourcePath}`);
  }
  if (readActivitySourceCursor(db, toSourcePath)) {
    throw new Error(`activity source relocation target already has a cursor: ${toSourcePath}`);
  }
  const targetMessages = countActivityMessagesForSource(db, toSourcePath);
  if (targetMessages > 0) {
    throw new Error(`activity source relocation target already has ${targetMessages} message(s): ${toSourcePath}`);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE activity_messages SET source_path = ? WHERE source_path = ?")
      .run(toSourcePath, fromSourcePath);
    db.prepare("UPDATE activity_source_cursors SET source_path = ? WHERE source_path = ?")
      .run(toSourcePath, fromSourcePath);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* preserve the primary relocation failure */
    }
    throw error;
  }
}

/** Idempotent upsert of a source cursor keyed by `source_path`. */
export function upsertActivitySourceCursor(
  db: StateDriverDatabase,
  row: ActivitySourceCursorRow,
): void {
  db.prepare(
    `INSERT INTO activity_source_cursors
       (source_path, backend, activity_id, byte_offset, next_line, resume_offset,
        resume_line, size_bytes, mtime_ms, content_hash, classifier_version,
        message_count, updated_at, last_indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET
       backend = excluded.backend,
       activity_id = excluded.activity_id,
       byte_offset = excluded.byte_offset,
       next_line = excluded.next_line,
       resume_offset = excluded.resume_offset,
       resume_line = excluded.resume_line,
       size_bytes = excluded.size_bytes,
       mtime_ms = excluded.mtime_ms,
       content_hash = excluded.content_hash,
       classifier_version = excluded.classifier_version,
       message_count = excluded.message_count,
       updated_at = excluded.updated_at,
       last_indexed_at = excluded.last_indexed_at`,
  ).run(
    row.source_path,
    row.backend,
    row.activity_id ?? null,
    row.byte_offset,
    row.next_line,
    row.resume_offset,
    row.resume_line,
    row.size_bytes ?? null,
    row.mtime_ms ?? null,
    row.content_hash ?? null,
    row.classifier_version,
    row.message_count,
    row.updated_at,
    row.last_indexed_at ?? null,
  );
}

// --- Index runs (freshness) ----------------------------------------------

export type ActivityIndexRunStatus = "running" | "ok" | "error";

export interface ActivityIndexRunRow {
  run_id: string;
  host?: string | null | undefined;
  /** What scheduled this run: `watch`, `interval`, `manual`, `backfill`. */
  trigger: string;
  started_at: string;
  finished_at?: string | null | undefined;
  status: ActivityIndexRunStatus;
  sources_scanned: number;
  sources_changed: number;
  sources_pending: number;
  messages_upserted: number;
  bytes_ingested: number;
  /** Newest source observed-time covered by this run, ISO-8601. */
  indexed_through?: string | null | undefined;
  classifier_version: string;
  error?: string | null | undefined;
}

interface RawActivityIndexRunRow {
  run_id: string;
  host: string | null;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  sources_scanned: number | bigint;
  sources_changed: number | bigint;
  sources_pending: number | bigint;
  messages_upserted: number | bigint;
  bytes_ingested: number | bigint;
  indexed_through: string | null;
  classifier_version: string;
  error: string | null;
}

function hydrateIndexRunRow(row: RawActivityIndexRunRow): ActivityIndexRunRow {
  return {
    run_id: row.run_id,
    ...(row.host !== null ? { host: row.host } : {}),
    trigger: row.trigger,
    started_at: row.started_at,
    ...(row.finished_at !== null ? { finished_at: row.finished_at } : {}),
    status: row.status as ActivityIndexRunStatus,
    sources_scanned: asNumber(row.sources_scanned),
    sources_changed: asNumber(row.sources_changed),
    sources_pending: asNumber(row.sources_pending),
    messages_upserted: asNumber(row.messages_upserted),
    bytes_ingested: asNumber(row.bytes_ingested),
    ...(row.indexed_through !== null ? { indexed_through: row.indexed_through } : {}),
    classifier_version: row.classifier_version,
    ...(row.error !== null ? { error: row.error } : {}),
  };
}

const ACTIVITY_INDEX_RUN_SELECT = `SELECT
  run_id, host, trigger, started_at, finished_at, status, sources_scanned,
  sources_changed, sources_pending, messages_upserted, bytes_ingested,
  indexed_through, classifier_version, error
FROM activity_index_runs`;

/** Insert-or-replace an index-run row keyed by `run_id`. */
export function recordActivityIndexRun(
  db: StateDriverDatabase,
  row: ActivityIndexRunRow,
): void {
  db.prepare(
    `INSERT INTO activity_index_runs
       (run_id, host, trigger, started_at, finished_at, status, sources_scanned,
        sources_changed, sources_pending, messages_upserted, bytes_ingested,
        indexed_through, classifier_version, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       host = excluded.host,
       trigger = excluded.trigger,
       started_at = excluded.started_at,
       finished_at = excluded.finished_at,
       status = excluded.status,
       sources_scanned = excluded.sources_scanned,
       sources_changed = excluded.sources_changed,
       sources_pending = excluded.sources_pending,
       messages_upserted = excluded.messages_upserted,
       bytes_ingested = excluded.bytes_ingested,
       indexed_through = excluded.indexed_through,
       classifier_version = excluded.classifier_version,
       error = excluded.error`,
  ).run(
    row.run_id,
    row.host ?? null,
    row.trigger,
    row.started_at,
    row.finished_at ?? null,
    row.status,
    row.sources_scanned,
    row.sources_changed,
    row.sources_pending,
    row.messages_upserted,
    row.bytes_ingested,
    row.indexed_through ?? null,
    row.classifier_version,
    row.error ?? null,
  );
}

export function readLatestActivityIndexRun(
  db: StateDriverDatabase,
): ActivityIndexRunRow | undefined {
  const row = db
    .prepare(`${ACTIVITY_INDEX_RUN_SELECT} ORDER BY started_at DESC, run_id DESC LIMIT 1`)
    .get() as RawActivityIndexRunRow | undefined;
  return row ? hydrateIndexRunRow(row) : undefined;
}

/**
 * Freshness summary surfaced in recall receipts and by `calyx state doctor`.
 * `indexed_through` is the newest observed source time the store has covered;
 * `pending_sources` counts cursors whose last-seen file size is ahead of the
 * resume byte offset (an un-ingested tail).
 */
export interface ActivityIndexFreshness {
  message_count: number;
  source_count: number;
  pending_sources: number;
  indexed_through?: string | undefined;
  last_run?: ActivityIndexRunRow | undefined;
}

export function summarizeActivityIndexFreshness(
  db: StateDriverDatabase,
): ActivityIndexFreshness {
  const messageCount = countActivityMessages(db);
  const sourceRow = db
    .prepare(`SELECT COUNT(*) AS n FROM activity_source_cursors`)
    .get() as { n: number | bigint } | undefined;
  const sourceCount = sourceRow ? asNumber(sourceRow.n) : 0;
  const pendingRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM activity_source_cursors
       WHERE size_bytes IS NOT NULL AND size_bytes > byte_offset`,
    )
    .get() as { n: number | bigint } | undefined;
  const pendingSources = pendingRow ? asNumber(pendingRow.n) : 0;
  const lastRun = readLatestActivityIndexRun(db);
  const indexedThrough = lastRun?.indexed_through ?? undefined;
  return {
    message_count: messageCount,
    source_count: sourceCount,
    pending_sources: pendingSources,
    ...(indexedThrough ? { indexed_through: indexedThrough } : {}),
    ...(lastRun ? { last_run: lastRun } : {}),
  };
}

// --- Doctor surfaces ------------------------------------------------------

/** Schema parity check used by `calyx state doctor --domain activity`. */
export interface ActivityIndexSchemaFinding {
  table: string;
  code: "missing-table" | "missing-column" | "missing-index";
  detail: string;
}

export function checkActivityIndexSchema(
  db: StateDriverDatabase,
): { status: "ok" | "drift"; findings: ActivityIndexSchemaFinding[] } {
  const findings: ActivityIndexSchemaFinding[] = [];
  for (const expected of ACTIVITY_INDEX_TABLES) {
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

/**
 * Doctor-level malformed-row scan. Flags structural corruption that would make
 * a row unsafe to serve on the read path: blank required identity fields,
 * non-positive sequence, or `attachment_refs` that is not a JSON array. Origin
 * vocabulary is intentionally not enforced here — the canonical enum lives in
 * the run-service normalizer, and duplicating it in `core` would drift; the
 * read path tolerates unknown origins by passing them through verbatim.
 */
export interface MalformedActivityMessageFinding {
  message_id: string;
  code:
    | "blank-activity-id"
    | "blank-content-hash"
    | "blank-classifier-version"
    | "non-positive-seq"
    | "invalid-attachment-refs"
    | "invalid-payload-json";
  detail: string;
}

export function listMalformedActivityMessages(
  db: StateDriverDatabase,
  limit = 50,
): MalformedActivityMessageFinding[] {
  const findings: MalformedActivityMessageFinding[] = [];
  const rows = db
    .prepare(
      `SELECT message_id, activity_id, seq, content_hash, classifier_version, attachment_refs
            , payload_json
       FROM activity_messages
       ORDER BY observed_at DESC, message_id ASC`,
    )
    .all() as Array<{
    message_id: string;
    activity_id: string;
    seq: number | bigint;
    content_hash: string;
    classifier_version: string;
    attachment_refs: string;
    payload_json: string | null;
  }>;
  for (const row of rows) {
    if (findings.length >= limit) break;
    if (!row.activity_id || row.activity_id.trim() === "") {
      findings.push({
        message_id: row.message_id,
        code: "blank-activity-id",
        detail: `message ${row.message_id} has a blank activity_id`,
      });
      continue;
    }
    if (!row.content_hash || row.content_hash.trim() === "") {
      findings.push({
        message_id: row.message_id,
        code: "blank-content-hash",
        detail: `message ${row.message_id} has a blank content_hash`,
      });
      continue;
    }
    if (!row.classifier_version || row.classifier_version.trim() === "") {
      findings.push({
        message_id: row.message_id,
        code: "blank-classifier-version",
        detail: `message ${row.message_id} has a blank classifier_version`,
      });
      continue;
    }
    if (asNumber(row.seq) <= 0) {
      findings.push({
        message_id: row.message_id,
        code: "non-positive-seq",
        detail: `message ${row.message_id} has non-positive seq ${asNumber(row.seq)}`,
      });
      continue;
    }
    if (!isJsonArray(row.attachment_refs)) {
      findings.push({
        message_id: row.message_id,
        code: "invalid-attachment-refs",
        detail: `message ${row.message_id} has attachment_refs that is not a JSON array`,
      });
      continue;
    }
    if (row.payload_json !== null && !isJsonObject(row.payload_json)) {
      findings.push({
        message_id: row.message_id,
        code: "invalid-payload-json",
        detail: `message ${row.message_id} has payload_json that is not a JSON object`,
      });
      continue;
    }
  }
  return findings;
}

function isJsonArray(value: string): boolean {
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
}

function isJsonObject(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}
