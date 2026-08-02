import { createHash } from "node:crypto";
import type { StateDriverDatabase } from "./driver";
import { MEMORY_CONTENT_TABLES } from "./migrations";
import { normalizeName } from "../skills-install";

/**
 * POL-1729 Slice 4 — curated-facts memory state helpers. Direct, typed
 * operations against the `memory_content` (curated facts) and
 * `memory_write_log` (append-only) tables introduced in migration `0018`.
 *
 * calyx-memory is the curated-facts sibling of skill_content on the shared
 * learned-state store. It is the always-injected / 100%-blast-radius surface
 * (a poisoned memory would detonate in every future prompt), so its posture is
 * STRICT BY CONSTRUCTION, DIFFERENT from skills:
 *
 *   - A `calyx memory write` does NOT land active/free. It lands as
 *     `review_status = "pending"` and must be explicitly APPROVED before it is
 *     considered "active". (skill_content lands live; memory does not.)
 *   - The security scan is STRICT: any SHARP finding REJECTS the write at the
 *     CLI boundary (no row is written). The store helpers never persist a value
 *     the caller has not scanned — the scan/refuse decision lives in the CLI.
 *   - Surfacing/injection is OUT OF SCOPE here. This store is INERT re:
 *     injection: nothing here auto-injects memory into any prompt. It only
 *     provides the durable store + the explicit read/write/approve commands.
 *
 * A live row holds the fact as `value` (a single UTF-8 string). A tombstone row
 * (non-null `deleted_at`) records a deletion: the value is cleared.
 *
 * Every write/approve/reject/delete appends a `memory_write_log` row in the
 * SAME transaction so the durable content row can never exist without its write
 * receipt.
 *
 * Category vocabulary (closed set — the vault memory types):
 *   - `user`      — durable facts about the operator / their preferences.
 *   - `project`   — durable facts about a project / its current state.
 *   - `reference` — durable reference facts (numbers, ids, system facts).
 *   - `feedback`  — durable behavioral feedback / corrections.
 *
 * Review-status vocabulary (closed set):
 *   - `pending`   — written but NOT yet approved (the default landing state).
 *   - `approved`  — explicitly approved; the "active" state.
 *   - `rejected`  — explicitly rejected.
 *
 * Write-class vocabulary (closed set):
 *   - `write`   — an UPSERT of a live (pending) fact.
 *   - `approve` — a review transition to `approved`.
 *   - `reject`  — a review transition to `rejected`.
 *   - `delete`  — a tombstone.
 */
export const MEMORY_CATEGORIES = ["user", "project", "reference", "feedback"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
export type MemoryReviewStatus = (typeof MEMORY_REVIEW_STATUSES)[number];

export const MEMORY_WRITE_CLASSES = ["write", "approve", "reject", "delete"] as const;
export type MemoryWriteClass = (typeof MEMORY_WRITE_CLASSES)[number];

export const MEMORY_CONTENT_LIST_DEFAULT_LIMIT = 200;
export const MEMORY_CONTENT_LIST_MAX_LIMIT = 2000;
export const MEMORY_CONTENT_SEARCH_DEFAULT_LIMIT = 50;
export const MEMORY_CONTENT_SEARCH_MAX_LIMIT = 500;

/**
 * sha256 of the fact value. Deterministic and stable: the same value always
 * hashes identically (no field ordering to worry about — a memory fact is a
 * single string, unlike a skill's multi-file payload map).
 */
export function hashMemoryValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** content_hash recorded for a tombstone (empty value). */
export const MEMORY_TOMBSTONE_CONTENT_HASH = hashMemoryValue("");

export interface MemoryContentRow {
  host_id: string;
  memory_key: string;
  /** The fact. Empty string on a tombstone. */
  value: string;
  content_hash: string;
  category: MemoryCategory;
  review_status: MemoryReviewStatus;
  pinned: boolean;
  deleted_at: string | null;
  origin_activity_id: string | null;
  origin_message_id: string | null;
  author: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
}

interface RawMemoryContentRow {
  host_id: string;
  memory_key: string;
  value: string;
  content_hash: string;
  category: string;
  review_status: string;
  pinned: number | bigint | null;
  deleted_at: string | null;
  origin_activity_id: string | null;
  origin_message_id: string | null;
  author: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
}

function toBoolean(value: number | bigint | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return (typeof value === "bigint" ? Number(value) : value) !== 0;
}

function hydrateMemoryContentRow(row: RawMemoryContentRow): MemoryContentRow {
  return {
    host_id: row.host_id,
    memory_key: row.memory_key,
    value: row.value,
    content_hash: row.content_hash,
    category: row.category as MemoryCategory,
    review_status: row.review_status as MemoryReviewStatus,
    pinned: toBoolean(row.pinned),
    deleted_at: row.deleted_at,
    origin_activity_id: row.origin_activity_id,
    origin_message_id: row.origin_message_id,
    author: row.author,
    summary: row.summary,
    created_at: row.created_at,
    updated_at: row.updated_at,
    approved_at: row.approved_at,
  };
}

const MEMORY_CONTENT_SELECT = `SELECT
  host_id, memory_key, value, content_hash, category, review_status, pinned, deleted_at,
  origin_activity_id, origin_message_id, author, summary,
  created_at, updated_at, approved_at
FROM memory_content`;

export interface UpsertMemoryContentInput {
  host_id: string;
  memory_key: string;
  /** The fact value (a single UTF-8 string). Must be non-empty. */
  value: string;
  category: MemoryCategory;
  origin_activity_id?: string | null | undefined;
  origin_message_id?: string | null | undefined;
  author?: string | null | undefined;
  summary?: string | null | undefined;
  /** Write-log note (defaults to summary). */
  note?: string | null | undefined;
}

/**
 * Insert or update a memory-content row and append a `write` event to
 * `memory_write_log`, both in a single transaction.
 *
 * STRICT POSTURE: the row always lands `review_status = 'pending'`. A write
 * NEVER lands `approved`/active — approval is a separate, explicit review step
 * (see {@link setMemoryReviewStatus}). On conflict (host_id, memory_key) this
 * updates value/content_hash/category/provenance/summary/updated_at, CLEARS
 * `deleted_at` (a live write over a tombstone recreates the fact), and RESETS
 * `review_status` to `pending` + `approved_at` to NULL — a re-write of a fact
 * must be re-approved (the content changed; the prior approval is void).
 * `created_at` is preserved on update.
 */
export function upsertMemoryContent(
  db: StateDriverDatabase,
  input: UpsertMemoryContentInput,
  now: () => string = () => new Date().toISOString(),
): MemoryContentRow {
  const timestamp = now();
  // Defense-in-depth: normalize the key so direct callers can never split-brain
  // a fact across surface forms (the CLI entry also normalizes; normalizeName is
  // idempotent, so double-normalizing is a no-op).
  const memoryKey = normalizeName(input.memory_key);
  const contentHash = hashMemoryValue(input.value);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO memory_content
        (host_id, memory_key, value, content_hash, category, review_status, pinned, deleted_at,
         origin_activity_id, origin_message_id, author, summary,
         created_at, updated_at, approved_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(host_id, memory_key) DO UPDATE SET
         value = excluded.value,
         content_hash = excluded.content_hash,
         category = excluded.category,
         review_status = 'pending',
         deleted_at = NULL,
         origin_activity_id = excluded.origin_activity_id,
         origin_message_id = excluded.origin_message_id,
         author = excluded.author,
         summary = excluded.summary,
         updated_at = excluded.updated_at,
         approved_at = NULL`,
    ).run(
      input.host_id,
      memoryKey,
      input.value,
      contentHash,
      input.category,
      input.origin_activity_id ?? null,
      input.origin_message_id ?? null,
      input.author ?? null,
      input.summary ?? null,
      timestamp,
      timestamp,
    );
    db.prepare(
      `INSERT INTO memory_write_log
        (memory_key, host_id, write_class, content_hash, review_status,
         origin_activity_id, origin_message_id, actor, note, occurred_at)
       VALUES (?, ?, 'write', ?, 'pending', ?, ?, ?, ?, ?)`,
    ).run(
      memoryKey,
      input.host_id,
      contentHash,
      input.origin_activity_id ?? null,
      input.origin_message_id ?? null,
      input.author ?? null,
      input.note ?? input.summary ?? null,
      timestamp,
    );
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* swallow secondary error */
    }
    throw err;
  }
  return readMemoryContent(db, input.host_id, memoryKey)!;
}

/**
 * Thrown when {@link setMemoryReviewStatus} aborts. `code` is one of:
 *   - `not_found`        — no live `memory_content` row for (host, key).
 *   - `concurrent_write` — the CAS guard fired: the row's `content_hash`
 *     changed between the caller's intent and the transition (a concurrent
 *     writer landed new content). Nothing is committed; re-review the new value.
 *   - `invalid_transition` — the target status is not a review terminal
 *     (`approved`/`rejected`); `pending` is the write-landing state, not a
 *     review action.
 */
export class MemoryReviewAborted extends Error {
  readonly code: "not_found" | "concurrent_write" | "invalid_transition";

  constructor(code: MemoryReviewAborted["code"], message: string) {
    super(message);
    this.name = "MemoryReviewAborted";
    this.code = code;
  }
}

export interface SetMemoryReviewStatusInput {
  host_id: string;
  memory_key: string;
  status: "approved" | "rejected";
  /**
   * Optional CAS guard: the content_hash the reviewer believes they are
   * approving/rejecting. When supplied, the transition refuses (throws
   * `concurrent_write`) if the live row's hash differs — i.e. a newer write
   * landed after the reviewer read the value.
   */
  expected_content_hash?: string | null | undefined;
  origin_activity_id?: string | null | undefined;
  origin_message_id?: string | null | undefined;
  actor?: string | null | undefined;
  note?: string | null | undefined;
}

/**
 * Approve or reject a memory fact — the explicit review step that makes a
 * `pending` write "active". Sets `review_status` and (on approve) `approved_at`,
 * and appends an `approve`/`reject` event to `memory_write_log`, all in one
 * transaction.
 *
 * On `approved`: `approved_at` is stamped. On `rejected`: `approved_at` is
 * cleared (a previously-approved fact that gets rejected loses its approval
 * stamp). The CAS guard (when `expected_content_hash` is supplied) ensures the
 * reviewer is approving the value they actually saw.
 *
 * Refuses (throws {@link MemoryReviewAborted}) when no live row exists, on a
 * content-hash mismatch, or on an invalid target status.
 */
export function setMemoryReviewStatus(
  db: StateDriverDatabase,
  input: SetMemoryReviewStatusInput,
  now: () => string = () => new Date().toISOString(),
): MemoryContentRow {
  if (input.status !== "approved" && input.status !== "rejected") {
    throw new MemoryReviewAborted(
      "invalid_transition",
      `memory review target must be "approved" or "rejected"; got "${String(input.status)}"`,
    );
  }
  const timestamp = now();
  const memoryKey = normalizeName(input.memory_key);

  db.exec("BEGIN IMMEDIATE");
  try {
    const row = readMemoryContent(db, input.host_id, memoryKey);
    if (!row || row.deleted_at !== null) {
      db.exec("ROLLBACK");
      throw new MemoryReviewAborted(
        "not_found",
        `memory key "${memoryKey}" has no live memory_content row on host ${input.host_id}`,
      );
    }
    if (
      input.expected_content_hash !== undefined &&
      input.expected_content_hash !== null &&
      input.expected_content_hash !== row.content_hash
    ) {
      db.exec("ROLLBACK");
      throw new MemoryReviewAborted(
        "concurrent_write",
        `memory key "${memoryKey}" changed concurrently (content_hash drift); re-review the current value`,
      );
    }
    const approvedAt = input.status === "approved" ? timestamp : null;
    db.prepare(
      `UPDATE memory_content
          SET review_status = ?, approved_at = ?, updated_at = ?
        WHERE host_id = ? AND memory_key = ?`,
    ).run(input.status, approvedAt, timestamp, input.host_id, memoryKey);
    db.prepare(
      `INSERT INTO memory_write_log
        (memory_key, host_id, write_class, content_hash, review_status,
         origin_activity_id, origin_message_id, actor, note, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      memoryKey,
      input.host_id,
      input.status === "approved" ? "approve" : "reject",
      row.content_hash,
      input.status,
      input.origin_activity_id ?? null,
      input.origin_message_id ?? null,
      input.actor ?? null,
      input.note ?? null,
      timestamp,
    );
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* swallow secondary error */
    }
    throw err;
  }
  return readMemoryContent(db, input.host_id, memoryKey)!;
}

export interface TombstoneMemoryContentInput {
  host_id: string;
  memory_key: string;
  origin_activity_id?: string | null | undefined;
  origin_message_id?: string | null | undefined;
  author?: string | null | undefined;
  summary?: string | null | undefined;
  note?: string | null | undefined;
}

/**
 * Tombstone a memory-content row: UPSERT with `deleted_at` set, the value
 * cleared, the empty-value content hash, and `review_status` reset to
 * `pending` (a tombstone is not an approved fact). Appends a `delete` event to
 * `memory_write_log` in the same transaction.
 *
 * A tombstone for a never-seen key still inserts a row (so the deletion is
 * durably recorded and the write-log captures intent).
 */
export function tombstoneMemoryContent(
  db: StateDriverDatabase,
  input: TombstoneMemoryContentInput,
  now: () => string = () => new Date().toISOString(),
): MemoryContentRow {
  const timestamp = now();
  const memoryKey = normalizeName(input.memory_key);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO memory_content
        (host_id, memory_key, value, content_hash, category, review_status, pinned, deleted_at,
         origin_activity_id, origin_message_id, author, summary,
         created_at, updated_at, approved_at)
       VALUES (?, ?, '', ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(host_id, memory_key) DO UPDATE SET
         value = '',
         content_hash = excluded.content_hash,
         review_status = 'pending',
         deleted_at = excluded.deleted_at,
         origin_activity_id = excluded.origin_activity_id,
         origin_message_id = excluded.origin_message_id,
         author = excluded.author,
         summary = excluded.summary,
         updated_at = excluded.updated_at,
         approved_at = NULL`,
    ).run(
      input.host_id,
      memoryKey,
      MEMORY_TOMBSTONE_CONTENT_HASH,
      // A tombstone for a never-seen key needs SOME category to satisfy NOT NULL;
      // `reference` is the neutral default and is overwritten if the key already
      // existed (the ON CONFLICT clause does not touch category, preserving it).
      "reference",
      timestamp,
      input.origin_activity_id ?? null,
      input.origin_message_id ?? null,
      input.author ?? null,
      input.summary ?? null,
      timestamp,
      timestamp,
    );
    db.prepare(
      `INSERT INTO memory_write_log
        (memory_key, host_id, write_class, content_hash, review_status,
         origin_activity_id, origin_message_id, actor, note, occurred_at)
       VALUES (?, ?, 'delete', ?, 'pending', ?, ?, ?, ?, ?)`,
    ).run(
      memoryKey,
      input.host_id,
      MEMORY_TOMBSTONE_CONTENT_HASH,
      input.origin_activity_id ?? null,
      input.origin_message_id ?? null,
      input.author ?? null,
      input.note ?? input.summary ?? null,
      timestamp,
    );
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* swallow secondary error */
    }
    throw err;
  }
  return readMemoryContent(db, input.host_id, memoryKey)!;
}

export function readMemoryContent(
  db: StateDriverDatabase,
  hostId: string,
  memoryKey: string,
): MemoryContentRow | undefined {
  const row = db
    .prepare(`${MEMORY_CONTENT_SELECT} WHERE host_id = ? AND memory_key = ?`)
    .get(hostId, memoryKey) as RawMemoryContentRow | undefined;
  return row ? hydrateMemoryContentRow(row) : undefined;
}

export interface ListMemoryContentOptions {
  category?: MemoryCategory;
  review_status?: MemoryReviewStatus;
  /** Include tombstoned (deleted_at non-null) rows. Defaults to false. */
  includeTombstoned?: boolean;
  host_id?: string;
  limit?: number;
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isFinite(limit) || limit <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(limit), max);
}

export function listMemoryContent(
  db: StateDriverDatabase,
  options: ListMemoryContentOptions = {},
): MemoryContentRow[] {
  const limit = clampLimit(options.limit, MEMORY_CONTENT_LIST_DEFAULT_LIMIT, MEMORY_CONTENT_LIST_MAX_LIMIT);
  const filters: string[] = [];
  const args: unknown[] = [];

  if (options.category !== undefined) {
    filters.push("category = ?");
    args.push(options.category);
  }
  if (options.review_status !== undefined) {
    filters.push("review_status = ?");
    args.push(options.review_status);
  }
  if (options.host_id !== undefined) {
    filters.push("host_id = ?");
    args.push(options.host_id);
  }
  if (!options.includeTombstoned) {
    filters.push("deleted_at IS NULL");
  }

  const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
  args.push(limit);
  const rows = db
    .prepare(`${MEMORY_CONTENT_SELECT}${where} ORDER BY updated_at DESC, memory_key ASC LIMIT ?`)
    .all(...args) as RawMemoryContentRow[];
  return rows.map(hydrateMemoryContentRow);
}

export interface SearchMemoryContentOptions {
  review_status?: MemoryReviewStatus;
  category?: MemoryCategory;
  includeTombstoned?: boolean;
  limit?: number;
}

/**
 * Case-insensitive substring search over key + value + summary — the
 * check-at-will read for an agent (or operator) probing memory before a task.
 * This is NOT a semantic engine: it is a literal LIKE over three columns,
 * ranked by recency. Tombstones are excluded by default.
 */
export function searchMemoryContent(
  db: StateDriverDatabase,
  hostId: string,
  query: string,
  options: SearchMemoryContentOptions = {},
): MemoryContentRow[] {
  const limit = clampLimit(options.limit, MEMORY_CONTENT_SEARCH_DEFAULT_LIMIT, MEMORY_CONTENT_SEARCH_MAX_LIMIT);
  // Escape LIKE wildcards in the user query so a literal % or _ matches itself.
  const escaped = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const needle = `%${escaped}%`;
  const filters: string[] = ["host_id = ?"];
  const args: unknown[] = [hostId];

  if (!options.includeTombstoned) {
    filters.push("deleted_at IS NULL");
  }
  if (options.review_status !== undefined) {
    filters.push("review_status = ?");
    args.push(options.review_status);
  }
  if (options.category !== undefined) {
    filters.push("category = ?");
    args.push(options.category);
  }
  // Case-insensitive: lower() both sides. memory_key is already normalized to
  // lower case, but value/summary are free text.
  filters.push(
    "(lower(memory_key) LIKE lower(?) ESCAPE '\\' OR lower(value) LIKE lower(?) ESCAPE '\\' OR lower(COALESCE(summary, '')) LIKE lower(?) ESCAPE '\\')",
  );
  args.push(needle, needle, needle);

  args.push(limit);
  const rows = db
    .prepare(
      `${MEMORY_CONTENT_SELECT} WHERE ${filters.join(" AND ")} ORDER BY updated_at DESC, memory_key ASC LIMIT ?`,
    )
    .all(...args) as RawMemoryContentRow[];
  return rows.map(hydrateMemoryContentRow);
}

export interface MemoryWriteLogRow {
  event_seq: number;
  memory_key: string;
  host_id: string;
  write_class: MemoryWriteClass;
  content_hash: string;
  review_status: MemoryReviewStatus;
  origin_activity_id: string | null;
  origin_message_id: string | null;
  actor: string | null;
  note: string | null;
  occurred_at: string;
}

interface RawMemoryWriteLogRow {
  event_seq: number | bigint;
  memory_key: string;
  host_id: string;
  write_class: string;
  content_hash: string;
  review_status: string;
  origin_activity_id: string | null;
  origin_message_id: string | null;
  actor: string | null;
  note: string | null;
  occurred_at: string;
}

export function listMemoryWriteLog(
  db: StateDriverDatabase,
  memoryKey: string,
): MemoryWriteLogRow[] {
  const rows = db
    .prepare(
      `SELECT event_seq, memory_key, host_id, write_class, content_hash, review_status,
              origin_activity_id, origin_message_id, actor, note, occurred_at
       FROM memory_write_log
       WHERE memory_key = ?
       ORDER BY event_seq ASC`,
    )
    .all(memoryKey) as RawMemoryWriteLogRow[];
  return rows.map((row) => ({
    event_seq: typeof row.event_seq === "bigint" ? Number(row.event_seq) : row.event_seq,
    memory_key: row.memory_key,
    host_id: row.host_id,
    write_class: row.write_class as MemoryWriteClass,
    content_hash: row.content_hash,
    review_status: row.review_status as MemoryReviewStatus,
    origin_activity_id: row.origin_activity_id,
    origin_message_id: row.origin_message_id,
    actor: row.actor,
    note: row.note,
    occurred_at: row.occurred_at,
  }));
}

export interface MemoryContentCounts {
  live: number;
  tombstoned: number;
  /** Live rows with the protection fence set. */
  pinned: number;
  byReviewStatus: Record<string, number>;
  byCategory: Record<string, number>;
}

export function countMemoryContent(db: StateDriverDatabase): MemoryContentCounts {
  const counts: MemoryContentCounts = {
    live: 0,
    tombstoned: 0,
    pinned: 0,
    byReviewStatus: {},
    byCategory: {},
  };
  const rows = db
    .prepare(
      `SELECT review_status, category, deleted_at, pinned FROM memory_content`,
    )
    .all() as Array<{
    review_status: string;
    category: string;
    deleted_at: string | null;
    pinned: number | bigint | null;
  }>;
  for (const row of rows) {
    const live = row.deleted_at === null;
    if (live) {
      counts.live += 1;
      if (toBoolean(row.pinned)) counts.pinned += 1;
      counts.byReviewStatus[row.review_status] =
        (counts.byReviewStatus[row.review_status] ?? 0) + 1;
      counts.byCategory[row.category] = (counts.byCategory[row.category] ?? 0) + 1;
    } else {
      counts.tombstoned += 1;
    }
  }
  return counts;
}

export function countMemoryWriteLog(db: StateDriverDatabase): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM memory_write_log`).get() as {
    n: number | bigint;
  };
  return typeof row.n === "bigint" ? Number(row.n) : row.n;
}

/** Schema parity check used by `calyx state doctor` (migration 0018). */
export interface MemoryContentSchemaFinding {
  table: string;
  code: "missing-table" | "missing-column" | "missing-index";
  detail: string;
}

export function checkMemoryContentSchema(
  db: StateDriverDatabase,
): { status: "ok" | "drift"; findings: MemoryContentSchemaFinding[] } {
  const findings: MemoryContentSchemaFinding[] = [];
  for (const expected of MEMORY_CONTENT_TABLES) {
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
 * Doctor-level malformed-row scan. Flags rows whose `category` or
 * `review_status` is outside the closed vocabulary, live rows with an empty
 * value, and write-log rows whose `write_class` is unknown.
 */
export interface MalformedMemoryContentFinding {
  memory_key: string;
  host_id: string;
  code:
    | "unknown-category"
    | "unknown-review-status"
    | "live-empty-value"
    | "unknown-write-class";
  detail: string;
}

export function listMalformedMemoryContent(
  db: StateDriverDatabase,
): MalformedMemoryContentFinding[] {
  const findings: MalformedMemoryContentFinding[] = [];
  const categorySet = new Set<string>(MEMORY_CATEGORIES);
  const reviewStatusSet = new Set<string>(MEMORY_REVIEW_STATUSES);
  const writeClassSet = new Set<string>(MEMORY_WRITE_CLASSES);

  const rows = db
    .prepare(
      `SELECT host_id, memory_key, value, category, review_status, deleted_at FROM memory_content`,
    )
    .all() as Array<{
    host_id: string;
    memory_key: string;
    value: string;
    category: string;
    review_status: string;
    deleted_at: string | null;
  }>;
  for (const row of rows) {
    if (!categorySet.has(row.category)) {
      findings.push({
        memory_key: row.memory_key,
        host_id: row.host_id,
        code: "unknown-category",
        detail: `memory_content ${row.host_id}/${row.memory_key} has unknown category "${row.category}"`,
      });
    }
    if (!reviewStatusSet.has(row.review_status)) {
      findings.push({
        memory_key: row.memory_key,
        host_id: row.host_id,
        code: "unknown-review-status",
        detail: `memory_content ${row.host_id}/${row.memory_key} has unknown review_status "${row.review_status}"`,
      });
    }
    if (row.deleted_at === null && row.value.length === 0) {
      findings.push({
        memory_key: row.memory_key,
        host_id: row.host_id,
        code: "live-empty-value",
        detail: `live memory_content ${row.host_id}/${row.memory_key} has an empty value`,
      });
    }
  }

  const logRows = db
    .prepare(`SELECT DISTINCT memory_key, host_id, write_class FROM memory_write_log`)
    .all() as Array<{ memory_key: string; host_id: string; write_class: string }>;
  for (const row of logRows) {
    if (!writeClassSet.has(row.write_class)) {
      findings.push({
        memory_key: row.memory_key,
        host_id: row.host_id,
        code: "unknown-write-class",
        detail: `memory_write_log for ${row.host_id}/${row.memory_key} has unknown write_class "${row.write_class}"`,
      });
    }
  }
  return findings;
}
