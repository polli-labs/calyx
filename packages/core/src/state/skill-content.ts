import { createHash } from "node:crypto";
import type { StateDriverDatabase } from "./driver";
import { SKILL_CONTENT_TABLES } from "./migrations";
import { normalizeName } from "../skills-install";

/**
 * POL-1729 Slice 1 — agent-owned skill content state helpers. Direct, typed
 * operations against the `skill_content` (DB-of-record) and `skill_write_log`
 * (append-only) tables introduced in migration `0016`.
 *
 * `skill_content` is the source of truth for *agent-owned* skills (regime
 * `db`). A live row holds the full document as a JSON payload map of
 * relpath -> UTF-8 string content (`{"SKILL.md": "...", "references/x.md":
 * "..."}`). A tombstone row (non-null `deleted_at`) records a deletion: the
 * payload is cleared and the re-materializer prunes the installed mirrors.
 *
 * Every live write or delete appends a `skill_write_log` row in the SAME
 * transaction so the durable content row can never exist without its write
 * receipt.
 *
 * Regime vocabulary (closed set):
 *   - `db`             — agent-owned; the DB is the source of truth and the
 *                        re-materializer renders mirrors from it.
 *   - `git`            — git-sourced (agents-infra `internal`); never
 *                        re-materialized from the DB.
 *   - `vendored`       — external vendored clone; never re-materialized.
 *   - `repo-maintained`— maintained in another repo clone; never
 *                        re-materialized.
 *
 * Write-class vocabulary (closed set):
 *   - `write`  — a full-document UPSERT of live content.
 *   - `delete` — a tombstone.
 */
export const SKILL_CONTENT_REGIMES = [
  "db",
  "git",
  "vendored",
  "repo-maintained",
] as const;
export type SkillContentRegime = (typeof SKILL_CONTENT_REGIMES)[number];

export const SKILL_WRITE_CLASSES = ["write", "delete"] as const;
export type SkillWriteClass = (typeof SKILL_WRITE_CLASSES)[number];

export const SKILL_CONTENT_LIST_DEFAULT_LIMIT = 200;
export const SKILL_CONTENT_LIST_MAX_LIMIT = 2000;

/**
 * Canonical JSON serialization of a payload map: keys sorted so the same
 * logical payload always serializes identically. The serialized string is both
 * what we persist in `payload_json` and what we hash into `content_hash`.
 */
export function canonicalizeSkillPayload(payload: Record<string, string>): string {
  const sortedKeys = Object.keys(payload).sort((left, right) => left.localeCompare(right));
  const canonical: Record<string, string> = {};
  for (const key of sortedKeys) {
    canonical[key] = payload[key]!;
  }
  return JSON.stringify(canonical);
}

/** sha256 of the canonical payload JSON. Stable across key insertion order. */
export function hashSkillPayload(payload: Record<string, string>): string {
  return createHash("sha256").update(canonicalizeSkillPayload(payload), "utf8").digest("hex");
}

/** content_hash recorded for a tombstone (empty payload map). */
export const TOMBSTONE_CONTENT_HASH = hashSkillPayload({});

export interface SkillContentRow {
  host_id: string;
  skill_name: string;
  content_hash: string;
  regime: SkillContentRegime;
  /** Parsed payload map (relpath -> content). Empty object on a tombstone. */
  payload: Record<string, string>;
  deleted_at: string | null;
  origin_activity_id: string | null;
  origin_message_id: string | null;
  author: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  materialized_at: string | null;
  /**
   * Curator-apply protection fence (POL-1729 Slice 3, migration 0017). A pinned
   * skill is NEVER auto-archived or auto-consolidated by `applyCuratorReport`
   * (or `consolidateSkillContent`). Manual `skills write`/`delete` are unaffected.
   */
  pinned: boolean;
}

interface RawSkillContentRow {
  host_id: string;
  skill_name: string;
  content_hash: string;
  regime: string;
  payload_json: string;
  deleted_at: string | null;
  origin_activity_id: string | null;
  origin_message_id: string | null;
  author: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  materialized_at: string | null;
  pinned: number | bigint | null;
}

function parsePayload(input: string): Record<string, string> {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") {
          result[key] = value;
        }
      }
      return result;
    }
  } catch {
    /* fall through to empty payload */
  }
  return {};
}

function hydrateSkillContentRow(row: RawSkillContentRow): SkillContentRow {
  return {
    host_id: row.host_id,
    skill_name: row.skill_name,
    content_hash: row.content_hash,
    regime: row.regime as SkillContentRegime,
    payload: parsePayload(row.payload_json),
    deleted_at: row.deleted_at,
    origin_activity_id: row.origin_activity_id,
    origin_message_id: row.origin_message_id,
    author: row.author,
    summary: row.summary,
    created_at: row.created_at,
    updated_at: row.updated_at,
    materialized_at: row.materialized_at,
    pinned: toBoolean(row.pinned),
  };
}

function toBoolean(value: number | bigint | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return (typeof value === "bigint" ? Number(value) : value) !== 0;
}

const SKILL_CONTENT_SELECT = `SELECT
  host_id, skill_name, content_hash, regime, payload_json, deleted_at,
  origin_activity_id, origin_message_id, author, summary,
  created_at, updated_at, materialized_at, pinned
FROM skill_content`;

export interface UpsertSkillContentInput {
  host_id: string;
  skill_name: string;
  /** Full-document payload map (relpath -> UTF-8 content). Must include SKILL.md. */
  payload: Record<string, string>;
  regime?: SkillContentRegime;
  origin_activity_id?: string | null | undefined;
  origin_message_id?: string | null | undefined;
  author?: string | null | undefined;
  summary?: string | null | undefined;
  /** Write-log note (defaults to summary). */
  note?: string | null | undefined;
}

/**
 * Insert or update a live skill-content row (full-document UPSERT) and append a
 * `write` event to `skill_write_log`, both in a single transaction.
 *
 * On conflict (host_id, skill_name) this updates payload/content_hash/regime/
 * provenance/summary/updated_at and CLEARS `deleted_at` (a live write over a
 * tombstone recreates the skill). `created_at` is preserved on update;
 * `materialized_at` is reset to NULL because the new content has not yet been
 * rendered to the mirrors.
 */
export function upsertSkillContent(
  db: StateDriverDatabase,
  input: UpsertSkillContentInput,
  now: () => string = () => new Date().toISOString(),
): SkillContentRow {
  const timestamp = now();
  // Defense-in-depth: normalize the name so direct callers can never split-brain
  // a skill across backends (the CLI entry also normalizes; normalizeName is
  // idempotent, so double-normalizing is a no-op).
  const skillName = normalizeName(input.skill_name);
  const regime: SkillContentRegime = input.regime ?? "db";
  const payloadJson = canonicalizeSkillPayload(input.payload);
  const contentHash = hashSkillPayload(input.payload);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO skill_content
        (host_id, skill_name, content_hash, regime, payload_json, deleted_at,
         origin_activity_id, origin_message_id, author, summary,
         created_at, updated_at, materialized_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(host_id, skill_name) DO UPDATE SET
         content_hash = excluded.content_hash,
         regime = excluded.regime,
         payload_json = excluded.payload_json,
         deleted_at = NULL,
         origin_activity_id = excluded.origin_activity_id,
         origin_message_id = excluded.origin_message_id,
         author = excluded.author,
         summary = excluded.summary,
         updated_at = excluded.updated_at,
         materialized_at = NULL`,
    ).run(
      input.host_id,
      skillName,
      contentHash,
      regime,
      payloadJson,
      input.origin_activity_id ?? null,
      input.origin_message_id ?? null,
      input.author ?? null,
      input.summary ?? null,
      timestamp,
      timestamp,
    );
    db.prepare(
      `INSERT INTO skill_write_log
        (skill_name, host_id, regime, write_class, content_hash,
         origin_activity_id, origin_message_id, actor, note, occurred_at)
       VALUES (?, ?, ?, 'write', ?, ?, ?, ?, ?, ?)`,
    ).run(
      skillName,
      input.host_id,
      regime,
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
  return readSkillContent(db, input.host_id, skillName)!;
}

export interface TombstoneSkillContentInput {
  host_id: string;
  skill_name: string;
  regime?: SkillContentRegime;
  origin_activity_id?: string | null | undefined;
  origin_message_id?: string | null | undefined;
  author?: string | null | undefined;
  summary?: string | null | undefined;
  note?: string | null | undefined;
}

/**
 * Tombstone a skill-content row: UPSERT with `deleted_at` set, the payload
 * cleared, and the empty-payload content hash. Appends a `delete` event to
 * `skill_write_log` in the same transaction.
 *
 * A tombstone for a never-seen skill still inserts a row (so the deletion is
 * durably recorded and the write-log captures intent); the re-materializer
 * treats it as a prune no-op when no mirror exists.
 */
export function tombstoneSkillContent(
  db: StateDriverDatabase,
  input: TombstoneSkillContentInput,
  now: () => string = () => new Date().toISOString(),
): SkillContentRow {
  const timestamp = now();
  // Defense-in-depth: normalize the name so a tombstone always targets the same
  // canonical row a live write created (the CLI entry also normalizes;
  // normalizeName is idempotent, so double-normalizing is a no-op).
  const skillName = normalizeName(input.skill_name);
  const regime: SkillContentRegime = input.regime ?? "db";
  const emptyPayloadJson = canonicalizeSkillPayload({});

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO skill_content
        (host_id, skill_name, content_hash, regime, payload_json, deleted_at,
         origin_activity_id, origin_message_id, author, summary,
         created_at, updated_at, materialized_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(host_id, skill_name) DO UPDATE SET
         content_hash = excluded.content_hash,
         regime = excluded.regime,
         payload_json = excluded.payload_json,
         deleted_at = excluded.deleted_at,
         origin_activity_id = excluded.origin_activity_id,
         origin_message_id = excluded.origin_message_id,
         author = excluded.author,
         summary = excluded.summary,
         updated_at = excluded.updated_at,
         materialized_at = NULL`,
    ).run(
      input.host_id,
      skillName,
      TOMBSTONE_CONTENT_HASH,
      regime,
      emptyPayloadJson,
      timestamp,
      input.origin_activity_id ?? null,
      input.origin_message_id ?? null,
      input.author ?? null,
      input.summary ?? null,
      timestamp,
      timestamp,
    );
    db.prepare(
      `INSERT INTO skill_write_log
        (skill_name, host_id, regime, write_class, content_hash,
         origin_activity_id, origin_message_id, actor, note, occurred_at)
       VALUES (?, ?, ?, 'delete', ?, ?, ?, ?, ?, ?)`,
    ).run(
      skillName,
      input.host_id,
      regime,
      TOMBSTONE_CONTENT_HASH,
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
  return readSkillContent(db, input.host_id, skillName)!;
}

export function readSkillContent(
  db: StateDriverDatabase,
  hostId: string,
  skillName: string,
): SkillContentRow | undefined {
  const row = db
    .prepare(`${SKILL_CONTENT_SELECT} WHERE host_id = ? AND skill_name = ?`)
    .get(hostId, skillName) as RawSkillContentRow | undefined;
  return row ? hydrateSkillContentRow(row) : undefined;
}

export interface ListSkillContentOptions {
  regime?: SkillContentRegime;
  /** Include tombstoned (deleted_at non-null) rows. Defaults to false. */
  includeTombstoned?: boolean;
  host_id?: string;
  limit?: number;
}

function clampListLimit(limit: number | undefined): number {
  if (limit === undefined) return SKILL_CONTENT_LIST_DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    return SKILL_CONTENT_LIST_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), SKILL_CONTENT_LIST_MAX_LIMIT);
}

export function listSkillContent(
  db: StateDriverDatabase,
  options: ListSkillContentOptions = {},
): SkillContentRow[] {
  const limit = clampListLimit(options.limit);
  const filters: string[] = [];
  const args: unknown[] = [];

  if (options.regime !== undefined) {
    filters.push("regime = ?");
    args.push(options.regime);
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
    .prepare(`${SKILL_CONTENT_SELECT}${where} ORDER BY updated_at DESC, skill_name ASC LIMIT ?`)
    .all(...args) as RawSkillContentRow[];
  return rows.map(hydrateSkillContentRow);
}

/**
 * Compare-and-set the `materialized_at` stamp. Only stamps the row when the
 * live `content_hash` still matches `contentHash` — i.e. no newer write landed
 * between the read and the mirror commit. When 0 rows change this is NOT an
 * error (oracle ruling D): a newer write is mid-flight and will be
 * re-materialized by its own pass, so the stale stamp is simply skipped.
 *
 * Returns true when the stamp was applied, false when skipped.
 */
export function stampMaterialized(
  db: StateDriverDatabase,
  hostId: string,
  skillName: string,
  contentHash: string,
  now: () => string = () => new Date().toISOString(),
): boolean {
  const result = db
    .prepare(
      `UPDATE skill_content
          SET materialized_at = ?
        WHERE host_id = ? AND skill_name = ? AND content_hash = ?`,
    )
    .run(now(), hostId, skillName, contentHash);
  const changes = typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
  return changes > 0;
}

/**
 * Set (or clear) the curator-apply protection fence on a skill (migration 0017).
 * A pinned skill is fenced off from `applyCuratorReport`'s deterministic archive
 * and from `consolidateSkillContent`; manual `skills write`/`delete` are
 * unaffected. The id is normalized (defense-in-depth, like the other helpers).
 *
 * Returns the updated row, or `undefined` when no `skill_content` row exists for
 * the (host, name) — pinning a never-seen skill is a no-op, not an error.
 */
export function setPinned(
  db: StateDriverDatabase,
  hostId: string,
  skillName: string,
  pinned: boolean,
  now: () => string = () => new Date().toISOString(),
): SkillContentRow | undefined {
  const normalized = normalizeName(skillName);
  db.prepare(
    `UPDATE skill_content
        SET pinned = ?, updated_at = ?
      WHERE host_id = ? AND skill_name = ?`,
  ).run(pinned ? 1 : 0, now(), hostId, normalized);
  return readSkillContent(db, hostId, normalized);
}

export interface ArchiveSkillContentInput {
  host_id: string;
  skill_name: string;
  origin_activity_id?: string | null | undefined;
  origin_message_id?: string | null | undefined;
  author?: string | null | undefined;
  summary?: string | null | undefined;
  note?: string | null | undefined;
}

/**
 * Recoverable archive (POL-1729 Slice 3, curator apply). Unlike
 * {@link tombstoneSkillContent} — which clears the payload and stamps
 * `TOMBSTONE_CONTENT_HASH` (the user-driven `skills delete` semantics) — this
 * sets `deleted_at` while RETAINING `payload_json` and `content_hash`. That
 * retention is what makes `curator rollback` possible WITHOUT a backup table:
 * the prior content stays in the row, so an un-archive only flips `deleted_at`
 * back to NULL. The re-materializer prunes on `deleted_at !== null` regardless
 * of payload, so the mirror is still pruned. A `delete` event is appended in the
 * same transaction.
 *
 * Refuses (returns `undefined`) when no live row exists for (host, name): the
 * curator only archives skills it just observed as live archive-candidates.
 */
export function archiveSkillContent(
  db: StateDriverDatabase,
  input: ArchiveSkillContentInput,
  now: () => string = () => new Date().toISOString(),
): SkillContentRow | undefined {
  const timestamp = now();
  const skillName = normalizeName(input.skill_name);

  db.exec("BEGIN IMMEDIATE");
  try {
    const row = readSkillContent(db, input.host_id, skillName);
    if (!row || row.deleted_at !== null) {
      db.exec("ROLLBACK");
      return undefined;
    }
    db.prepare(
      `UPDATE skill_content
          SET deleted_at = ?, updated_at = ?, materialized_at = NULL,
              origin_activity_id = ?, origin_message_id = ?, author = ?, summary = ?
        WHERE host_id = ? AND skill_name = ?`,
    ).run(
      timestamp,
      timestamp,
      input.origin_activity_id ?? row.origin_activity_id,
      input.origin_message_id ?? row.origin_message_id,
      input.author ?? row.author,
      input.summary ?? row.summary,
      input.host_id,
      skillName,
    );
    db.prepare(
      `INSERT INTO skill_write_log
        (skill_name, host_id, regime, write_class, content_hash,
         origin_activity_id, origin_message_id, actor, note, occurred_at)
       VALUES (?, ?, ?, 'delete', ?, ?, ?, ?, ?, ?)`,
    ).run(
      skillName,
      input.host_id,
      row.regime,
      row.content_hash,
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
  return readSkillContent(db, input.host_id, skillName);
}

/**
 * Un-archive a recoverable archive (the {@link archiveSkillContent} inverse used
 * by `curator rollback`). Flips `deleted_at` back to NULL for a row whose
 * payload was retained, resets `materialized_at`, and appends a `write` event so
 * the round-trip is durable. Returns `undefined` when no archived row exists, or
 * when the row has an empty (cleared) payload — a hard tombstone is NOT
 * recoverable by this path (its content is gone).
 */
export function restoreArchivedSkillContent(
  db: StateDriverDatabase,
  hostId: string,
  skillName: string,
  options: {
    note?: string | null | undefined;
    author?: string | null | undefined;
  } = {},
  now: () => string = () => new Date().toISOString(),
): SkillContentRow | undefined {
  const timestamp = now();
  const normalized = normalizeName(skillName);

  db.exec("BEGIN IMMEDIATE");
  try {
    const row = readSkillContent(db, hostId, normalized);
    if (!row || row.deleted_at === null) {
      db.exec("ROLLBACK");
      return undefined;
    }
    if (typeof row.payload["SKILL.md"] !== "string" || row.payload["SKILL.md"].length === 0) {
      // Hard tombstone (payload cleared): not restorable without a backup.
      db.exec("ROLLBACK");
      return undefined;
    }
    db.prepare(
      `UPDATE skill_content
          SET deleted_at = NULL, updated_at = ?, materialized_at = NULL
        WHERE host_id = ? AND skill_name = ?`,
    ).run(timestamp, hostId, normalized);
    db.prepare(
      `INSERT INTO skill_write_log
        (skill_name, host_id, regime, write_class, content_hash,
         origin_activity_id, origin_message_id, actor, note, occurred_at)
       VALUES (?, ?, ?, 'write', ?, NULL, NULL, ?, ?, ?)`,
    ).run(
      normalized,
      hostId,
      row.regime,
      row.content_hash,
      options.author ?? null,
      options.note ?? "curator rollback: un-archive",
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
  return readSkillContent(db, hostId, normalized);
}

/**
 * The current write-log high-water mark (max event_seq), or 0 when empty. Used
 * by the curator apply as the rollback cursor captured before any mutation.
 */
export function skillWriteLogHighWater(db: StateDriverDatabase): number {
  const row = db.prepare(`SELECT MAX(event_seq) AS hw FROM skill_write_log`).get() as {
    hw: number | bigint | null;
  };
  if (row.hw === null || row.hw === undefined) return 0;
  return typeof row.hw === "bigint" ? Number(row.hw) : row.hw;
}

/**
 * Thrown when {@link consolidateSkillContent} aborts. `code` is one of:
 *   - `concurrent_write` — a CAS guard fired: one of the involved rows changed
 *     content_hash between read and write (a concurrent writer). The WHOLE
 *     consolidation is rolled back (RFC #9: all-or-nothing).
 *   - `pinned_source`    — a source skill is pinned (fenced from auto-mutation).
 *   - `empty_sources`    — no source ids supplied.
 *   - `self_consolidation`— a source id equals the target id.
 *   - `source_not_found` — a named source has no live `skill_content` row.
 *   - `source_not_db`    — a source is not regime `db` (only agent-owned skills
 *     consolidate; git/vendored/repo-maintained live in their source repos).
 */
export class ConsolidationAborted extends Error {
  readonly code:
    | "concurrent_write"
    | "pinned_source"
    | "empty_sources"
    | "self_consolidation"
    | "source_not_found"
    | "source_not_db";

  constructor(code: ConsolidationAborted["code"], message: string) {
    super(message);
    this.name = "ConsolidationAborted";
    this.code = code;
  }
}

export interface ConsolidateSkillContentInput {
  hostId: string;
  /** Source skill ids to fold INTO the target and tombstone. */
  sourceIds: string[];
  /** Target skill id (created/updated as the consolidated survivor). */
  targetId: string;
  /** Full-document payload map for the target survivor (must include SKILL.md). */
  targetPayload: Record<string, string>;
  summary?: string | null | undefined;
  originActivityId?: string | null | undefined;
  originMessageId?: string | null | undefined;
  author?: string | null | undefined;
}

export interface ConsolidateSkillContentResult {
  targetContentHash: string;
  /** Normalized source ids that were tombstoned. */
  consolidated: string[];
  /** Normalized target id. */
  targetId: string;
}

/**
 * Multi-row compare-and-set consolidation (RFC #9 — the dangerous primitive).
 * Folds N source skills into one target survivor and tombstones the sources,
 * ALL-OR-NOTHING in a single `BEGIN IMMEDIATE` transaction.
 *
 * The CAS contract: every involved row's current `content_hash` is read at the
 * start of the transaction. Each source is tombstoned with
 * `UPDATE … WHERE host_id=? AND skill_name=? AND content_hash=<hash-read-at-start>`;
 * the target is written with the same guard when it already existed. If ANY
 * guarded UPDATE affects 0 rows (a concurrent writer changed that row after our
 * read), the ENTIRE transaction is rolled back and `ConsolidationAborted`
 * (`concurrent_write`) is thrown — not just the one row. Nothing is committed.
 *
 * Refusals (checked before any write): empty sources, self-consolidation
 * (source === target), a pinned source, a missing source, and a non-`db`
 * source. A `skill_write_log` row is appended for the target (`write`) and each
 * source (`delete`) in the SAME transaction.
 *
 * The CALLER re-materializes the target and prunes the source mirrors after
 * this returns (reuse `rematerializeSkill` per id).
 */
export function consolidateSkillContent(
  db: StateDriverDatabase,
  input: ConsolidateSkillContentInput,
  now: () => string = () => new Date().toISOString(),
): ConsolidateSkillContentResult {
  const targetId = normalizeName(input.targetId);
  // Normalize + de-duplicate sources, and drop the target if it sneaks into the
  // source list under a different surface form (it is written, not tombstoned).
  const sourceIds = Array.from(
    new Set(input.sourceIds.map((id) => normalizeName(id))),
  ).filter((id) => id !== targetId);

  if (input.sourceIds.length === 0) {
    throw new ConsolidationAborted("empty_sources", "consolidate requires at least one source id");
  }
  // After normalization, a source list that was ONLY the target (self) leaves
  // an empty set — that is self-consolidation, not a valid fold.
  if (sourceIds.length === 0) {
    throw new ConsolidationAborted(
      "self_consolidation",
      `consolidate refuses self-consolidation: every source normalizes to the target "${targetId}"`,
    );
  }

  const timestamp = now();
  const targetPayloadJson = canonicalizeSkillPayload(input.targetPayload);
  const targetContentHash = hashSkillPayload(input.targetPayload);

  db.exec("BEGIN IMMEDIATE");
  try {
    // Read the current state of every involved row INSIDE the transaction.
    const targetBefore = readSkillContentTx(db, input.hostId, targetId);

    // Validate every source ONCE inside the transaction and keep the read rows;
    // the tombstone CAS below guards on these validated content_hashes (the
    // BEGIN IMMEDIATE lock prevents any concurrent writer in between, so a
    // re-read would be redundant).
    const sourceRows = new Map<string, SkillContentRow>();
    for (const sourceId of sourceIds) {
      const source = readSkillContentTx(db, input.hostId, sourceId);
      if (!source || source.deleted_at !== null) {
        throw new ConsolidationAborted(
          "source_not_found",
          `consolidate source "${sourceId}" has no live skill_content row on host ${input.hostId}`,
        );
      }
      if (source.regime !== "db") {
        throw new ConsolidationAborted(
          "source_not_db",
          `consolidate refuses source "${sourceId}": regime "${source.regime}" is not "db" (the DB is not its source of truth)`,
        );
      }
      if (source.pinned) {
        throw new ConsolidationAborted(
          "pinned_source",
          `consolidate refuses source "${sourceId}": it is pinned (unpin it first)`,
        );
      }
      sourceRows.set(sourceId, source);
    }

    // UPSERT the target survivor. When it already existed, guard the UPDATE on
    // its content_hash read above; an insert (new target) needs no guard.
    if (targetBefore) {
      const targetUpdate = db
        .prepare(
          `UPDATE skill_content
              SET content_hash = ?, regime = 'db', payload_json = ?, deleted_at = NULL,
                  origin_activity_id = ?, origin_message_id = ?, author = ?, summary = ?,
                  updated_at = ?, materialized_at = NULL
            WHERE host_id = ? AND skill_name = ? AND content_hash = ?`,
        )
        .run(
          targetContentHash,
          targetPayloadJson,
          input.originActivityId ?? null,
          input.originMessageId ?? null,
          input.author ?? null,
          input.summary ?? null,
          timestamp,
          input.hostId,
          targetId,
          targetBefore.content_hash,
        );
      if (asNumber(targetUpdate.changes) !== 1) {
        throw new ConsolidationAborted(
          "concurrent_write",
          `consolidate aborted: target "${targetId}" changed concurrently (content_hash drift); nothing committed`,
        );
      }
    } else {
      db.prepare(
        `INSERT INTO skill_content
          (host_id, skill_name, content_hash, regime, payload_json, deleted_at,
           origin_activity_id, origin_message_id, author, summary,
           created_at, updated_at, materialized_at)
         VALUES (?, ?, ?, 'db', ?, NULL, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        input.hostId,
        targetId,
        targetContentHash,
        targetPayloadJson,
        input.originActivityId ?? null,
        input.originMessageId ?? null,
        input.author ?? null,
        input.summary ?? null,
        timestamp,
        timestamp,
      );
    }
    db.prepare(
      `INSERT INTO skill_write_log
        (skill_name, host_id, regime, write_class, content_hash,
         origin_activity_id, origin_message_id, actor, note, occurred_at)
       VALUES (?, ?, 'db', 'write', ?, ?, ?, ?, ?, ?)`,
    ).run(
      targetId,
      input.hostId,
      targetContentHash,
      input.originActivityId ?? null,
      input.originMessageId ?? null,
      input.author ?? null,
      input.summary ?? `consolidated ${sourceIds.join(", ")} into ${targetId}`,
      timestamp,
    );

    // Tombstone each source under its own CAS guard, keyed on the content_hash
    // validated above. ANY 0-row update aborts the whole consolidation (all-or-nothing).
    for (const sourceId of sourceIds) {
      const sourceBefore = sourceRows.get(sourceId)!;
      const tombstoneUpdate = db
        .prepare(
          `UPDATE skill_content
              SET content_hash = ?, payload_json = ?, deleted_at = ?,
                  origin_activity_id = ?, origin_message_id = ?, author = ?, summary = ?,
                  updated_at = ?, materialized_at = NULL
            WHERE host_id = ? AND skill_name = ? AND content_hash = ?`,
        )
        .run(
          TOMBSTONE_CONTENT_HASH,
          canonicalizeSkillPayload({}),
          timestamp,
          input.originActivityId ?? null,
          input.originMessageId ?? null,
          input.author ?? null,
          input.summary ?? `consolidated into ${targetId}`,
          timestamp,
          input.hostId,
          sourceId,
          sourceBefore.content_hash,
        );
      if (asNumber(tombstoneUpdate.changes) !== 1) {
        throw new ConsolidationAborted(
          "concurrent_write",
          `consolidate aborted: source "${sourceId}" changed concurrently (content_hash drift); nothing committed`,
        );
      }
      db.prepare(
        `INSERT INTO skill_write_log
          (skill_name, host_id, regime, write_class, content_hash,
           origin_activity_id, origin_message_id, actor, note, occurred_at)
         VALUES (?, ?, 'db', 'delete', ?, ?, ?, ?, ?, ?)`,
      ).run(
        sourceId,
        input.hostId,
        TOMBSTONE_CONTENT_HASH,
        input.originActivityId ?? null,
        input.originMessageId ?? null,
        input.author ?? null,
        input.summary ?? `consolidated into ${targetId}`,
        timestamp,
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

  return { targetContentHash, consolidated: sourceIds, targetId };
}

function asNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

/**
 * Read a skill_content row WITHOUT opening its own transaction (the public
 * {@link readSkillContent} is plain SELECT, so it composes inside the caller's
 * `BEGIN IMMEDIATE`; this alias documents that intent at the consolidate call
 * sites where transactional read ordering is load-bearing).
 */
function readSkillContentTx(
  db: StateDriverDatabase,
  hostId: string,
  skillName: string,
): SkillContentRow | undefined {
  return readSkillContent(db, hostId, skillName);
}

export interface SkillWriteLogRow {
  event_seq: number;
  skill_name: string;
  host_id: string;
  regime: string;
  write_class: SkillWriteClass;
  content_hash: string;
  origin_activity_id: string | null;
  origin_message_id: string | null;
  actor: string | null;
  note: string | null;
  occurred_at: string;
}

interface RawSkillWriteLogRow {
  event_seq: number | bigint;
  skill_name: string;
  host_id: string;
  regime: string;
  write_class: string;
  content_hash: string;
  origin_activity_id: string | null;
  origin_message_id: string | null;
  actor: string | null;
  note: string | null;
  occurred_at: string;
}

export function listSkillWriteLog(
  db: StateDriverDatabase,
  skillName: string,
): SkillWriteLogRow[] {
  const rows = db
    .prepare(
      `SELECT event_seq, skill_name, host_id, regime, write_class, content_hash,
              origin_activity_id, origin_message_id, actor, note, occurred_at
       FROM skill_write_log
       WHERE skill_name = ?
       ORDER BY event_seq ASC`,
    )
    .all(skillName) as RawSkillWriteLogRow[];
  return rows.map((row) => ({
    event_seq: typeof row.event_seq === "bigint" ? Number(row.event_seq) : row.event_seq,
    skill_name: row.skill_name,
    host_id: row.host_id,
    regime: row.regime,
    write_class: row.write_class as SkillWriteClass,
    content_hash: row.content_hash,
    origin_activity_id: row.origin_activity_id,
    origin_message_id: row.origin_message_id,
    actor: row.actor,
    note: row.note,
    occurred_at: row.occurred_at,
  }));
}

export interface SkillContentCounts {
  live: number;
  tombstoned: number;
  /** Live rows with the curator-apply protection fence set (migration 0017). */
  pinned: number;
  byRegime: Record<string, number>;
}

export function countSkillContent(db: StateDriverDatabase): SkillContentCounts {
  const counts: SkillContentCounts = { live: 0, tombstoned: 0, pinned: 0, byRegime: {} };
  const rows = db
    .prepare(
      `SELECT regime,
              SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS live,
              SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS tombstoned,
              SUM(CASE WHEN deleted_at IS NULL AND pinned = 1 THEN 1 ELSE 0 END) AS pinned
       FROM skill_content GROUP BY regime`,
    )
    .all() as Array<{ regime: string; live: number | bigint; tombstoned: number | bigint; pinned: number | bigint }>;
  for (const row of rows) {
    const live = typeof row.live === "bigint" ? Number(row.live) : row.live;
    const tombstoned = typeof row.tombstoned === "bigint" ? Number(row.tombstoned) : row.tombstoned;
    const pinned = typeof row.pinned === "bigint" ? Number(row.pinned) : row.pinned;
    counts.live += live;
    counts.tombstoned += tombstoned;
    counts.pinned += pinned;
    counts.byRegime[row.regime] = (counts.byRegime[row.regime] ?? 0) + live + tombstoned;
  }
  return counts;
}

export function countSkillWriteLog(db: StateDriverDatabase): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM skill_write_log`).get() as {
    n: number | bigint;
  };
  return typeof row.n === "bigint" ? Number(row.n) : row.n;
}

/** Schema parity check used by `calyx state doctor` (migration 0016). */
export interface SkillContentSchemaFinding {
  table: string;
  code: "missing-table" | "missing-column" | "missing-index";
  detail: string;
}

export function checkSkillContentSchema(
  db: StateDriverDatabase,
): { status: "ok" | "drift"; findings: SkillContentSchemaFinding[] } {
  const findings: SkillContentSchemaFinding[] = [];
  for (const expected of SKILL_CONTENT_TABLES) {
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
 * Doctor-level malformed-row scan. Flags rows whose `regime` is not in the
 * closed vocabulary, live rows missing a SKILL.md payload key, and write-log
 * rows whose `write_class` is unknown.
 */
export interface MalformedSkillContentFinding {
  skill_name: string;
  host_id: string;
  code: "unknown-regime" | "live-missing-skill-md" | "unknown-write-class";
  detail: string;
}

export function listMalformedSkillContent(
  db: StateDriverDatabase,
): MalformedSkillContentFinding[] {
  const findings: MalformedSkillContentFinding[] = [];
  const regimeSet = new Set<string>(SKILL_CONTENT_REGIMES);
  const writeClassSet = new Set<string>(SKILL_WRITE_CLASSES);

  const rows = db
    .prepare(
      `SELECT host_id, skill_name, regime, payload_json, deleted_at FROM skill_content`,
    )
    .all() as Array<{
    host_id: string;
    skill_name: string;
    regime: string;
    payload_json: string;
    deleted_at: string | null;
  }>;
  for (const row of rows) {
    if (!regimeSet.has(row.regime)) {
      findings.push({
        skill_name: row.skill_name,
        host_id: row.host_id,
        code: "unknown-regime",
        detail: `skill_content ${row.host_id}/${row.skill_name} has unknown regime "${row.regime}"`,
      });
    }
    if (row.deleted_at === null) {
      const payload = parsePayload(row.payload_json);
      if (typeof payload["SKILL.md"] !== "string" || payload["SKILL.md"].length === 0) {
        findings.push({
          skill_name: row.skill_name,
          host_id: row.host_id,
          code: "live-missing-skill-md",
          detail: `live skill_content ${row.host_id}/${row.skill_name} is missing a SKILL.md payload entry`,
        });
      }
    }
  }

  const logRows = db
    .prepare(`SELECT DISTINCT skill_name, host_id, write_class FROM skill_write_log`)
    .all() as Array<{ skill_name: string; host_id: string; write_class: string }>;
  for (const row of logRows) {
    if (!writeClassSet.has(row.write_class)) {
      findings.push({
        skill_name: row.skill_name,
        host_id: row.host_id,
        code: "unknown-write-class",
        detail: `skill_write_log for ${row.host_id}/${row.skill_name} has unknown write_class "${row.write_class}"`,
      });
    }
  }
  return findings;
}
