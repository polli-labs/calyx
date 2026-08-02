import { createHash } from "node:crypto";

import { canonicalizeJcs } from "./canonical-json";
import type { StateDriverDatabase } from "./driver";
import { RUN_INDEX_TABLES } from "./migrations";

/**
 * Wave 2.2 run-index helpers. Direct, typed operations against the
 * `run_index` SQLite table introduced in migration `0003`. The shape mirrors
 * the public `RunListEntry` contract from `@polli-labs/calyx-run-service`,
 * but is declared structurally here so `core` does not depend on
 * `run-service`. Run-service owns the conversion from `RunRecord` /
 * `RunListEntry` to {@link RunIndexRow}.
 *
 * Intentionally not a generic repository registry — the wave-2 charter
 * keeps helpers narrowly typed until a second caller justifies abstraction.
 */
export interface RunIndexRow {
  run_id: string;
  state: string;
  summary: string;
  created_at: string;
  updated_at: string;
  completed_at?: string | null | undefined;
  health_status?: string | null | undefined;
  last_progress_at?: string | null | undefined;
  issue?: string | null | undefined;
  host?: string | null | undefined;
  backend?: string | null | undefined;
  progress_signal_json?: string | null | undefined;
  terminal_projection_json?: string | null | undefined;
  recovery_mode: string;
  run_dir: string;
}

interface RawRunIndexRow {
  run_id: string;
  state: string;
  summary: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  health_status: string | null;
  last_progress_at: string | null;
  issue: string | null;
  host: string | null;
  backend: string | null;
  progress_signal_json: string | null;
  terminal_projection_json: string | null;
  recovery_mode: string;
  run_dir: string;
}

function hydrateRunIndexRow(row: RawRunIndexRow): RunIndexRow {
  return {
    run_id: row.run_id,
    state: row.state,
    summary: row.summary,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.completed_at !== null ? { completed_at: row.completed_at } : {}),
    ...(row.health_status !== null ? { health_status: row.health_status } : {}),
    ...(row.last_progress_at !== null ? { last_progress_at: row.last_progress_at } : {}),
    ...(row.issue !== null ? { issue: row.issue } : {}),
    ...(row.host !== null ? { host: row.host } : {}),
    ...(row.backend !== null ? { backend: row.backend } : {}),
    ...(row.progress_signal_json !== null ? { progress_signal_json: row.progress_signal_json } : {}),
    ...(row.terminal_projection_json !== null
      ? { terminal_projection_json: row.terminal_projection_json }
      : {}),
    recovery_mode: row.recovery_mode,
    run_dir: row.run_dir,
  };
}

const RUN_INDEX_SELECT = `SELECT
  run_id, state, summary, created_at, updated_at,
  completed_at, health_status, last_progress_at, issue, host, backend,
  progress_signal_json, terminal_projection_json,
  recovery_mode, run_dir
FROM run_index`;

/**
 * Idempotent upsert keyed by `run_id`. Repeated calls for the same row
 * never duplicate rows (PRIMARY KEY on `run_id`); concurrent writes for
 * different runs cannot lose either row because each upsert is its own
 * short SQLite transaction with WAL serialization.
 */
export function upsertRunIndexEntry(
  db: StateDriverDatabase,
  row: RunIndexRow,
): RunIndexRow {
  db.prepare(
    `INSERT INTO run_index
       (run_id, state, summary, created_at, updated_at,
        completed_at, health_status, last_progress_at, issue, host, backend,
        progress_signal_json, terminal_projection_json,
        recovery_mode, run_dir)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       state = excluded.state,
       summary = excluded.summary,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       completed_at = excluded.completed_at,
       health_status = excluded.health_status,
       last_progress_at = excluded.last_progress_at,
       issue = excluded.issue,
       host = excluded.host,
       backend = excluded.backend,
       progress_signal_json = excluded.progress_signal_json,
       terminal_projection_json = excluded.terminal_projection_json,
       recovery_mode = excluded.recovery_mode,
       run_dir = excluded.run_dir`,
  ).run(
    row.run_id,
    row.state,
    row.summary,
    row.created_at,
    row.updated_at,
    row.completed_at ?? null,
    row.health_status ?? null,
    row.last_progress_at ?? null,
    row.issue ?? null,
    row.host ?? null,
    row.backend ?? null,
    row.progress_signal_json ?? null,
    row.terminal_projection_json ?? null,
    row.recovery_mode,
    row.run_dir,
  );
  return readRunIndexEntry(db, row.run_id) ?? row;
}

export function readRunIndexEntry(
  db: StateDriverDatabase,
  runId: string,
): RunIndexRow | undefined {
  const row = db
    .prepare(`${RUN_INDEX_SELECT} WHERE run_id = ?`)
    .get(runId) as RawRunIndexRow | undefined;
  return row ? hydrateRunIndexRow(row) : undefined;
}

/**
 * List all rows ordered by `run_id` for deterministic output. Service-level
 * callers re-sort by recency (`updated_at` desc, `created_at` desc,
 * `run_id` asc) before applying paging.
 */
export function listRunIndexEntries(db: StateDriverDatabase): RunIndexRow[] {
  const rows = db
    .prepare(`${RUN_INDEX_SELECT} ORDER BY run_id ASC`)
    .all() as RawRunIndexRow[];
  return rows.map(hydrateRunIndexRow);
}

export interface ListRunIndexPageOptions {
  host?: string | undefined;
  backend?: string | undefined;
  updated_since?: string | undefined;
  created_since?: string | undefined;
  created_before?: string | undefined;
  after?: { created_at: string; run_id: string } | undefined;
  limit: number;
}

export interface ListRunIndexSnapshotPageOptions
  extends ListRunIndexPageOptions {
  expected_membership_fingerprint?: string | undefined;
}

export interface RunIndexSnapshotPage {
  membershipFingerprint: string;
  rows: RunIndexRow[];
}

export class RunIndexMembershipFingerprintMismatchError extends Error {
  readonly code = "run_index_membership_fingerprint_mismatch";

  constructor(
    readonly expectedFingerprint: string,
    readonly actualFingerprint: string,
  ) {
    super(
      `run index membership fingerprint changed: expected ${expectedFingerprint}, found ${actualFingerprint}`,
    );
    this.name = "RunIndexMembershipFingerprintMismatchError";
  }
}

export interface RunIndexMembershipIdentity {
  run_id: string;
  created_at: string;
  host: string | null;
  backend: string | null;
}

interface RunIndexMembershipSide extends RunIndexMembershipIdentity {
  updated_at: string;
}

interface RawRunIndexMembershipDelta {
  revision: number | bigint;
  operation: "insert" | "update" | "delete";
  lineage_parent_token: string;
  lineage_token: string;
  old_run_id: string | null;
  old_created_at: string | null;
  old_updated_at: string | null;
  old_host: string | null;
  old_backend: string | null;
  new_run_id: string | null;
  new_created_at: string | null;
  new_updated_at: string | null;
  new_host: string | null;
  new_backend: string | null;
}

interface RunIndexMembershipHead {
  generation: string;
  revision: number;
  lineageParentToken: string;
  lineageToken: string;
  compactedThroughRevision: number;
}

interface RunIndexMembershipCheckpoint {
  generation: string;
  revision: number;
  lineageToken: string;
  filterDigest: string;
}

const RUN_INDEX_MEMBERSHIP_FILTER_SCHEMA_VERSION =
  "calyx.run-index-membership-filter/v1" as const;

function runIndexMembershipFilterDigest(
  options: Pick<
    ListRunIndexPageOptions,
    "host" | "backend" | "updated_since" | "created_since" | "created_before"
  >,
): string {
  return createHash("sha256").update(canonicalizeJcs({
    schema_version: RUN_INDEX_MEMBERSHIP_FILTER_SCHEMA_VERSION,
    filters: {
      host: options.host ?? null,
      backend: options.backend ?? null,
      updated_since: options.updated_since ?? null,
      created_since: options.created_since ?? null,
      created_before: options.created_before ?? null,
    },
  }), "utf8").digest("hex");
}

function safeRevision(value: number | bigint, label: string): number {
  const revision = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`${label} is outside the safe integer domain: ${String(value)}`);
  }
  return revision;
}

export function readRunIndexMembershipHead(db: StateDriverDatabase): RunIndexMembershipHead {
  const row = db.prepare(
    `SELECT generation, revision, lineage_parent_token, lineage_token,
            compacted_through_revision
       FROM run_index_membership_revision
      WHERE singleton = 1`,
  ).get() as {
    generation: string;
    revision: number | bigint;
    lineage_parent_token: string;
    lineage_token: string;
    compacted_through_revision: number | bigint;
  } | undefined;
  if (!row) {
    throw new Error("run_index_membership_revision singleton row is missing");
  }
  if (!/^[0-9a-f]{32}$/u.test(row.generation)) {
    throw new Error("run index membership generation is malformed");
  }
  if (!/^[0-9a-f]{32}$/u.test(row.lineage_parent_token)) {
    throw new Error("run index membership parent lineage token is malformed");
  }
  if (!/^[0-9a-f]{32}$/u.test(row.lineage_token)) {
    throw new Error("run index membership lineage token is malformed");
  }
  const revision = safeRevision(row.revision, "run index membership revision");
  const compactedThroughRevision = safeRevision(
    row.compacted_through_revision,
    "run index membership compaction watermark",
  );
  if (compactedThroughRevision > revision) {
    throw new Error("run index membership compaction watermark exceeds the head revision");
  }
  return {
    generation: row.generation,
    revision,
    lineageParentToken: row.lineage_parent_token,
    lineageToken: row.lineage_token,
    compactedThroughRevision,
  };
}

/** Backward-compatible diagnostic accessor for callers that only need the head revision. */
export function readRunIndexMembershipRevision(db: StateDriverDatabase): number {
  return readRunIndexMembershipHead(db).revision;
}

function formatRunIndexMembershipCheckpoint(checkpoint: RunIndexMembershipCheckpoint): string {
  return `${checkpoint.generation}:${checkpoint.revision}:${checkpoint.lineageToken}:${checkpoint.filterDigest}`;
}

function parseRunIndexMembershipCheckpoint(value: string): RunIndexMembershipCheckpoint {
  const match = /^([0-9a-f]{32}):(0|[1-9][0-9]*):([0-9a-f]{32}):([0-9a-f]{64})$/u.exec(value);
  if (!match) {
    throw new RangeError("expected run index membership checkpoint is malformed");
  }
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision)) {
    throw new RangeError("expected run index membership checkpoint revision is outside the safe integer domain");
  }
  return {
    generation: match[1]!,
    revision,
    lineageToken: match[3]!,
    filterDigest: match[4]!,
  };
}

function runIndexEligibilitySql(options: ListRunIndexPageOptions): {
  clauses: string[];
  params: Array<string | number>;
} {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.host) {
    clauses.push("host = ?");
    params.push(options.host);
  }
  if (options.backend) {
    clauses.push("backend = ?");
    params.push(options.backend);
  }
  if (options.updated_since) {
    clauses.push("updated_at >= ?");
    params.push(options.updated_since);
  }
  if (options.created_since) {
    clauses.push("created_at >= ?");
    params.push(options.created_since);
  }
  if (options.created_before) {
    clauses.push("created_at <= ?");
    params.push(options.created_before);
  }
  return { clauses, params };
}

/** Stable, store-native page ordered only by immutable creation identity. */
export function listRunIndexPage(
  db: StateDriverDatabase,
  options: ListRunIndexPageOptions,
): RunIndexRow[] {
  const { clauses, params } = runIndexEligibilitySql(options);
  if (options.after) {
    clauses.push("(created_at < ? OR (created_at = ? AND run_id COLLATE BINARY > ?))");
    params.push(options.after.created_at, options.after.created_at, options.after.run_id);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(
    `${RUN_INDEX_SELECT} INDEXED BY idx_run_index_created_seek${where}
      ORDER BY created_at DESC, run_id COLLATE BINARY ASC LIMIT ?`,
  ).all(...params, Math.max(1, Math.trunc(options.limit))) as RawRunIndexRow[];
  return rows.map(hydrateRunIndexRow);
}

function membershipSideEligible(
  side: RunIndexMembershipSide,
  options: ListRunIndexPageOptions,
): boolean {
  return (!options.host || side.host === options.host)
    && (!options.backend || side.backend === options.backend)
    && (!options.updated_since || side.updated_at >= options.updated_since)
    && (!options.created_since || side.created_at >= options.created_since)
    && (!options.created_before || side.created_at <= options.created_before);
}

function deltaSide(
  row: RawRunIndexMembershipDelta,
  prefix: "old" | "new",
): RunIndexMembershipSide | undefined {
  const runId = row[`${prefix}_run_id`];
  const createdAt = row[`${prefix}_created_at`];
  const updatedAt = row[`${prefix}_updated_at`];
  if (runId === null && createdAt === null && updatedAt === null) return undefined;
  if (runId === null || createdAt === null || updatedAt === null) {
    throw new Error(`run index membership delta ${String(row.revision)} has an incomplete ${prefix} side`);
  }
  return {
    run_id: runId,
    created_at: createdAt,
    updated_at: updatedAt,
    host: row[`${prefix}_host`],
    backend: row[`${prefix}_backend`],
  };
}

function membershipIdentityKey(side: RunIndexMembershipSide): string {
  return canonicalizeJcs({
    run_id: side.run_id,
    created_at: side.created_at,
    host: side.host,
    backend: side.backend,
  });
}

function assertRunIndexMembershipUnchanged(
  db: StateDriverDatabase,
  expected: RunIndexMembershipCheckpoint,
  head: RunIndexMembershipHead,
  options: ListRunIndexPageOptions,
  actualCheckpoint: string,
): void {
  if (
    expected.generation !== head.generation
    || expected.filterDigest !== runIndexMembershipFilterDigest(options)
    || expected.revision > head.revision
    || expected.revision < head.compactedThroughRevision
  ) {
    throw new RunIndexMembershipFingerprintMismatchError(
      formatRunIndexMembershipCheckpoint(expected),
      actualCheckpoint,
    );
  }
  const rows = db.prepare(
    `SELECT revision, operation, lineage_parent_token, lineage_token,
            old_run_id, old_created_at, old_updated_at, old_host, old_backend,
            new_run_id, new_created_at, new_updated_at, new_host, new_backend
       FROM run_index_membership_deltas
      WHERE revision > ? AND revision <= ?
      ORDER BY revision ASC`,
  ).all(expected.revision, head.revision) as RawRunIndexMembershipDelta[];
  if (rows.length !== head.revision - expected.revision) {
    throw new RunIndexMembershipFingerprintMismatchError(
      formatRunIndexMembershipCheckpoint(expected),
      actualCheckpoint,
    );
  }
  const net = new Map<string, number>();
  let lineageToken = expected.lineageToken;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (
      safeRevision(row.revision, "run index membership delta revision") !== expected.revision + index + 1
      || !/^[0-9a-f]{32}$/u.test(row.lineage_parent_token)
      || !/^[0-9a-f]{32}$/u.test(row.lineage_token)
      || row.lineage_parent_token !== lineageToken
    ) {
      throw new RunIndexMembershipFingerprintMismatchError(
        formatRunIndexMembershipCheckpoint(expected),
        actualCheckpoint,
      );
    }
    lineageToken = row.lineage_token;
    for (const [side, direction] of [[deltaSide(row, "old"), -1], [deltaSide(row, "new"), 1]] as const) {
      if (!side || !membershipSideEligible(side, options)) continue;
      const key = membershipIdentityKey(side);
      const count = (net.get(key) ?? 0) + direction;
      if (count === 0) net.delete(key);
      else net.set(key, count);
    }
  }
  if (lineageToken !== head.lineageToken || net.size > 0) {
    throw new RunIndexMembershipFingerprintMismatchError(
      formatRunIndexMembershipCheckpoint(expected),
      actualCheckpoint,
    );
  }
}

/**
 * Validate only the bounded OLD/NEW mutation delta since the preceding page,
 * then read one indexed seek page from the same SQLite snapshot.
 */
export function listRunIndexSnapshotPage(
  db: StateDriverDatabase,
  options: ListRunIndexSnapshotPageOptions,
): RunIndexSnapshotPage {
  const expectedCheckpoint = options.expected_membership_fingerprint === undefined
    ? undefined
    : parseRunIndexMembershipCheckpoint(options.expected_membership_fingerprint);
  db.exec("BEGIN DEFERRED");
  try {
    const head = readRunIndexMembershipHead(db);
    const membershipFingerprint = formatRunIndexMembershipCheckpoint({
      generation: head.generation,
      revision: head.revision,
      lineageToken: head.lineageToken,
      filterDigest: runIndexMembershipFilterDigest(options),
    });
    if (expectedCheckpoint) {
      assertRunIndexMembershipUnchanged(
        db,
        expectedCheckpoint,
        head,
        options,
        membershipFingerprint,
      );
    }
    const rows = listRunIndexPage(db, options);
    db.exec("COMMIT");
    return { membershipFingerprint, rows };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* preserve the original read or revision error */
    }
    throw error;
  }
}

/**
 * List rows whose `state` is not terminal. Terminal state names are
 * supplied by the caller because the canonical list lives in
 * `@polli-labs/calyx-runner`; this keeps `core` from depending on the
 * runner state taxonomy.
 */
export function listActiveRunIndexEntries(
  db: StateDriverDatabase,
  terminalStates: readonly string[],
): RunIndexRow[] {
  if (terminalStates.length === 0) {
    return listRunIndexEntries(db);
  }
  const placeholders = terminalStates.map(() => "?").join(",");
  const rows = db
    .prepare(
      `${RUN_INDEX_SELECT} WHERE state NOT IN (${placeholders}) ORDER BY run_id ASC`,
    )
    .all(...terminalStates) as RawRunIndexRow[];
  return rows.map(hydrateRunIndexRow);
}

export function countRunIndexEntries(db: StateDriverDatabase): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM run_index`)
    .get() as { n: number | bigint } | undefined;
  if (!row) return 0;
  return typeof row.n === "bigint" ? Number(row.n) : row.n;
}

/**
 * Delete a row by `run_id`. Used when a run directory is removed or a
 * full rebuild needs to evict missing rows.
 */
export function deleteRunIndexEntry(
  db: StateDriverDatabase,
  runId: string,
): { deleted: boolean } {
  const result = db
    .prepare(`DELETE FROM run_index WHERE run_id = ?`)
    .run(runId);
  const changes = typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
  return { deleted: changes > 0 };
}

/**
 * Replace the run_index contents with `rows`. Wraps the swap in a single
 * SQLite transaction so partial replacement is impossible. Used by
 * reconcile and by the one-time post-migration rebuild from authoritative
 * `run_record.json` files.
 */
export function replaceRunIndex(
  db: StateDriverDatabase,
  rows: readonly RunIndexRow[],
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM run_index");
    const insert = db.prepare(
      `INSERT INTO run_index
         (run_id, state, summary, created_at, updated_at,
          completed_at, health_status, last_progress_at, issue, host, backend,
          progress_signal_json, terminal_projection_json,
          recovery_mode, run_dir)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        row.run_id,
        row.state,
        row.summary,
        row.created_at,
        row.updated_at,
        row.completed_at ?? null,
        row.health_status ?? null,
        row.last_progress_at ?? null,
        row.issue ?? null,
        row.host ?? null,
        row.backend ?? null,
        row.progress_signal_json ?? null,
        row.terminal_projection_json ?? null,
        row.recovery_mode,
        row.run_dir,
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
}

/** Schema parity check used by `calyx state doctor` (migration 0003). */
export interface RunIndexSchemaFinding {
  table: string;
  code:
    | "missing-table"
    | "missing-column"
    | "missing-index"
    | "missing-trigger"
    | "trigger-sql-mismatch"
    | "invalid-table-constraint";
  detail: string;
}

function canonicalTriggerSql(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim().replace(/;$/u, "");
}

export function checkRunIndexSchema(
  db: StateDriverDatabase,
): { status: "ok" | "drift"; findings: RunIndexSchemaFinding[] } {
  const findings: RunIndexSchemaFinding[] = [];
  for (const expected of RUN_INDEX_TABLES) {
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
    if (expected.requiredSqlFragments?.length) {
      const tableSql = db.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).get(expected.table) as { sql: string | null } | undefined;
      const normalized = canonicalTriggerSql(tableSql?.sql ?? "").toLowerCase();
      if (expected.requiredSqlFragments.some((fragment) => (
        !normalized.includes(canonicalTriggerSql(fragment).toLowerCase())
      ))) {
        findings.push({
          table: expected.table,
          code: "invalid-table-constraint",
          detail: `table "${expected.table}" does not carry its canonical constraints`,
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
    if (expected.triggers && expected.triggers.length > 0) {
      const liveTriggers = new Map((db
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`)
        .all(expected.table) as Array<{ name: string; sql: string | null }>)
        .map((trigger) => [trigger.name, trigger.sql]));
      for (const trigger of expected.triggers) {
        const liveSql = liveTriggers.get(trigger.name);
        if (liveSql === undefined) {
          findings.push({
            table: expected.table,
            code: "missing-trigger",
            detail: `expected trigger "${trigger.name}" not present on "${expected.table}"`,
          });
          continue;
        }
        if (
          liveSql === null
          || canonicalTriggerSql(liveSql) !== canonicalTriggerSql(trigger.sql)
        ) {
          findings.push({
            table: expected.table,
            code: "trigger-sql-mismatch",
            detail: `trigger "${trigger.name}" on "${expected.table}" does not match the canonical definition`,
          });
        }
      }
    }
  }
  return { status: findings.length === 0 ? "ok" : "drift", findings };
}
