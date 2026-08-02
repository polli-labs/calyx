import type { StateDriverDatabase } from "./driver";

/**
 * Tiny key/value helpers over the `state_meta` table created by migration
 * `0001`. Used to persist store-level markers across processes — e.g. the
 * wave-2.2 `run_index.initial_backfill_completed_at` marker that gates the
 * one-time post-migration rebuild from authoritative `run_record.json`
 * files. Keep this surface intentionally small; helpers are added when a
 * concrete caller needs them.
 */
export interface StateMetaEntry {
  key: string;
  value: string;
  updated_at: string;
}

export function readStateMeta(
  db: StateDriverDatabase,
  key: string,
): StateMetaEntry | undefined {
  const row = db
    .prepare(`SELECT key, value, updated_at FROM state_meta WHERE key = ?`)
    .get(key) as
    | { key: string; value: string; updated_at: string }
    | undefined;
  return row ? { key: row.key, value: row.value, updated_at: row.updated_at } : undefined;
}

export function writeStateMeta(
  db: StateDriverDatabase,
  key: string,
  value: string,
  now: () => string = () => new Date().toISOString(),
): StateMetaEntry {
  const updated_at = now();
  db.prepare(
    `INSERT INTO state_meta (key, value, updated_at)
       VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  ).run(key, value, updated_at);
  return { key, value, updated_at };
}

export function deleteStateMeta(
  db: StateDriverDatabase,
  key: string,
): boolean {
  return db.prepare("DELETE FROM state_meta WHERE key = ?").run(key).changes > 0;
}

/**
 * Wave 2.2: marker key written after the first post-migration rebuild of
 * `run_index` from authoritative `run_record.json` files. Once present,
 * `RunStore.listRuns()` / `listActiveRuns()` read SQLite directly without
 * scanning run directories. `RunService.reconcile()` /
 * `RunStore.rebuildRunIndex()` remain the explicit repair path and may
 * rebuild regardless of marker.
 */
export const RUN_INDEX_INITIAL_BACKFILL_KEY =
  "run_index.initial_backfill_completed_at";

/**
 * Durable fail-closed marker for a published `run_record.json` mutation whose
 * SQLite projection has not yet converged. Writers set it before publishing
 * the authoritative record and clear it only after the matching projection
 * write (or a full rebuild) succeeds under the shared projection mutex.
 */
export const RUN_INDEX_PROJECTION_DEGRADED_KEY =
  "run_index.projection_degraded";
