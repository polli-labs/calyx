import { stat } from "node:fs/promises";

import {
  loadStateDriver,
  type StateDriverDatabase,
  type StateDriverModule,
} from "./driver";
import {
  assertStatePathAllowedForTests,
  resolveStatePaths,
  type ResolveStatePathsOptions,
  type ResolvedStatePaths,
} from "./paths";
import {
  checkRunIndexSchema,
  countRunIndexEntries,
  deleteRunIndexEntry,
  listActiveRunIndexEntries,
  listRunIndexEntries,
  listRunIndexPage,
  listRunIndexSnapshotPage,
  readRunIndexEntry,
  replaceRunIndex,
  upsertRunIndexEntry,
  type RunIndexRow,
  type ListRunIndexPageOptions,
  type ListRunIndexSnapshotPageOptions,
  RunIndexMembershipFingerprintMismatchError,
} from "./run-index";
import {
  RUN_INDEX_INITIAL_BACKFILL_KEY,
  RUN_INDEX_PROJECTION_DEGRADED_KEY,
  deleteStateMeta,
  readStateMeta,
  writeStateMeta,
} from "./state-meta";
import { isSqliteBusyError } from "./sqlite-mutex";

export interface RunIndexProjectionOptions {
  /** Override path resolution (test injection). */
  paths?: ResolveStatePathsOptions | ResolvedStatePaths;
  /** Pre-opened driver/database (test injection). */
  database?: StateDriverDatabase;
  /** Driver module override (test injection). */
  driver?: StateDriverModule;
  /**
   * When `true`, refuse to silently disable when the migration is missing
   * — throw instead. Tests use this to fail loud on misconfiguration.
   */
  strict?: boolean;
}

/**
 * Wave 2.2 SQLite-backed projection of `RunListEntry` (the `run_index`
 * table). Replaces the racy `runs/index.jsonl` upsert.
 *
 * Lazy-init: opens the state database on first call. Disables itself with
 * one stderr warning and falls through to a "no SQLite" outcome when:
 *
 *   - the database file does not exist;
 *   - migration `0003` is not yet applied;
 *   - the schema is present but parity is broken.
 *
 * RunStore is the only consumer; it reacts to disabled outcomes by
 * reading authoritative `run_record.json` files directly.
 */
export type RunIndexUpsertOutcome =
  | { status: "upserted" }
  | { status: "disabled"; reason: string };

export type RunIndexDeleteOutcome =
  | { status: "deleted"; existed: boolean }
  | { status: "disabled"; reason: string };

export type RunIndexReplaceOutcome =
  | { status: "replaced"; rowCount: number }
  | { status: "disabled"; reason: string };

export type RunIndexListOutcome =
  | { status: "listed"; rows: RunIndexRow[] }
  | { status: "disabled"; reason: string };

export type RunIndexSnapshotPageOutcome =
  | { status: "listed"; rows: RunIndexRow[]; membershipFingerprint: string }
  | { status: "disabled"; reason: string };

export type RunIndexCountOutcome =
  | { status: "counted"; count: number }
  | { status: "disabled"; reason: string };

export type RunIndexReadMarkerOutcome =
  | { status: "present"; completedAt: string }
  | { status: "absent" }
  | { status: "disabled"; reason: string };

export type RunIndexWriteMarkerOutcome =
  | { status: "written"; completedAt: string }
  | { status: "disabled"; reason: string };

export type RunIndexProjectionDegradedMarkerOutcome =
  | { status: "present"; value: string }
  | { status: "absent" }
  | { status: "disabled"; reason: string };

export type RunIndexProjectionDegradedMutationOutcome =
  | { status: "written"; value: string }
  | { status: "cleared"; existed: boolean }
  | { status: "disabled"; reason: string };

export type RunIndexInitialBackfillOutcome =
  | {
      status: "merged";
      rowCount: number;
      completedAt: string;
      alreadyCompleted: boolean;
    }
  | { status: "disabled"; reason: string };

export class RunIndexProjection {
  private readonly options: RunIndexProjectionOptions;
  private db: StateDriverDatabase | null;
  private ownsDb: boolean;
  private initPromise: Promise<boolean> | null = null;
  private disabledReason: string | null = null;
  private warned = false;

  constructor(options: RunIndexProjectionOptions = {}) {
    this.options = options;
    this.db = options.database ?? null;
    this.ownsDb = !options.database;
  }

  get isDisabled(): boolean {
    return this.disabledReason !== null;
  }

  get disabledMessage(): string | null {
    return this.disabledReason;
  }

  /**
   * Idempotent initialization. Returns `true` when the projection is ready,
   * `false` when it disabled itself (no-op afterward). Concurrent callers
   * share a single init promise so the DB open / schema check runs once.
   */
  async init(): Promise<boolean> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.runInit();
    return this.initPromise;
  }

  private async runInit(): Promise<boolean> {
    if (!this.db) {
      const paths: ResolvedStatePaths =
        this.options.paths && "stateDir" in this.options.paths
          ? (this.options.paths as ResolvedStatePaths)
          : resolveStatePaths(
              (this.options.paths as ResolveStatePathsOptions | undefined) ?? {},
            );
      assertStatePathAllowedForTests(paths, this.options.paths as ResolveStatePathsOptions | undefined);

      try {
        await stat(paths.dbPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return this.disable(
            `state DB does not exist at ${paths.dbPath}; run \`calyx state migrate --apply\` to enable the SQLite run index.`,
          );
        }
        return this.disable(
          `failed to stat state DB at ${paths.dbPath}: ${(err as Error).message}`,
        );
      }

      const driver = this.options.driver ?? (await loadStateDriver());
      try {
        this.db = driver.open(paths.dbPath);
      } catch (err) {
        return this.disable(
          `failed to open state DB at ${paths.dbPath}: ${(err as Error).message}`,
        );
      }
      this.ownsDb = true;

      try {
        this.db.exec("PRAGMA foreign_keys = ON;");
        this.db.exec("PRAGMA busy_timeout = 5000;");
      } catch {
        // Best-effort: migrate path enforces canonical pragmas.
      }
    }

    const parity = checkRunIndexSchema(this.db);
    if (parity.status !== "ok") {
      const reasons = parity.findings.map((f) => `${f.table}: ${f.detail}`).join("; ");
      return this.disable(
        `run_index schema is incomplete (${reasons || "migration 0003 not applied"}); run \`calyx state migrate --apply\`.`,
      );
    }

    return true;
  }

  private disable(reason: string): false {
    this.disabledReason = reason;
    if (this.options.strict) {
      throw new Error(`RunIndexProjection: ${reason}`);
    }
    if (!this.warned) {
      this.warned = true;
      try {
        process.stderr.write(
          `[calyx-run-index] ${reason} Falling back to run_record.json scan.\n`,
        );
      } catch {
        /* swallow secondary IO errors */
      }
    }
    return false;
  }

  async upsert(row: RunIndexRow): Promise<RunIndexUpsertOutcome> {
    const ok = await this.init();
    if (!ok || !this.db) {
      return { status: "disabled", reason: this.disabledReason ?? "uninitialized" };
    }
    try {
      upsertRunIndexEntry(this.db, row);
      return { status: "upserted" };
    } catch (err) {
      // Lock contention is transient and the projection is rebuildable. Let
      // RunStore retry the complete write instead of permanently latching this
      // long-lived projection off on one competing SQLite writer.
      if (isSqliteBusyError(err)) throw err;
      this.disable(`run_index upsert failed: ${(err as Error).message}`);
      return { status: "disabled", reason: this.disabledReason ?? "upsert failed" };
    }
  }

  async list(): Promise<RunIndexListOutcome> {
    const ok = await this.init();
    if (!ok || !this.db) {
      return { status: "disabled", reason: this.disabledReason ?? "uninitialized" };
    }
    try {
      return { status: "listed", rows: listRunIndexEntries(this.db) };
    } catch (err) {
      this.disable(`run_index list failed: ${(err as Error).message}`);
      return { status: "disabled", reason: this.disabledReason ?? "list failed" };
    }
  }

  async listPage(options: ListRunIndexPageOptions): Promise<RunIndexListOutcome> {
    const ok = await this.init();
    if (!ok || !this.db) {
      return { status: "disabled", reason: this.disabledReason ?? "uninitialized" };
    }
    try {
      return { status: "listed", rows: listRunIndexPage(this.db, options) };
    } catch (err) {
      this.disable(`run_index page failed: ${(err as Error).message}`);
      return { status: "disabled", reason: this.disabledReason ?? "page failed" };
    }
  }

  async listSnapshotPage(
    options: ListRunIndexSnapshotPageOptions,
  ): Promise<RunIndexSnapshotPageOutcome> {
    const ok = await this.init();
    if (!ok || !this.db) {
      return { status: "disabled", reason: this.disabledReason ?? "uninitialized" };
    }
    try {
      const page = listRunIndexSnapshotPage(this.db, options);
      return {
        status: "listed",
        rows: page.rows,
        membershipFingerprint: page.membershipFingerprint,
      };
    } catch (error) {
      if (error instanceof RunIndexMembershipFingerprintMismatchError) throw error;
      this.disable(`run_index snapshot page failed: ${(error as Error).message}`);
      return { status: "disabled", reason: this.disabledReason ?? "snapshot page failed" };
    }
  }

  async listActive(terminalStates: readonly string[]): Promise<RunIndexListOutcome> {
    const ok = await this.init();
    if (!ok || !this.db) {
      return { status: "disabled", reason: this.disabledReason ?? "uninitialized" };
    }
    try {
      return {
        status: "listed",
        rows: listActiveRunIndexEntries(this.db, terminalStates),
      };
    } catch (err) {
      this.disable(`run_index listActive failed: ${(err as Error).message}`);
      return { status: "disabled", reason: this.disabledReason ?? "listActive failed" };
    }
  }

  async count(): Promise<RunIndexCountOutcome> {
    const ok = await this.init();
    if (!ok || !this.db) {
      return { status: "disabled", reason: this.disabledReason ?? "uninitialized" };
    }
    try {
      return { status: "counted", count: countRunIndexEntries(this.db) };
    } catch (err) {
      this.disable(`run_index count failed: ${(err as Error).message}`);
      return { status: "disabled", reason: this.disabledReason ?? "count failed" };
    }
  }

  async readEntry(runId: string): Promise<RunIndexRow | undefined> {
    const ok = await this.init();
    if (!ok || !this.db) {
      return undefined;
    }
    return readRunIndexEntry(this.db, runId);
  }

  async delete(runId: string): Promise<RunIndexDeleteOutcome> {
    const ok = await this.init();
    if (!ok || !this.db) {
      return { status: "disabled", reason: this.disabledReason ?? "uninitialized" };
    }
    try {
      const result = deleteRunIndexEntry(this.db, runId);
      return { status: "deleted", existed: result.deleted };
    } catch (err) {
      this.disable(`run_index delete failed: ${(err as Error).message}`);
      return { status: "disabled", reason: this.disabledReason ?? "delete failed" };
    }
  }

  async replace(rows: readonly RunIndexRow[]): Promise<RunIndexReplaceOutcome> {
    const ok = await this.init();
    if (!ok || !this.db) {
      return { status: "disabled", reason: this.disabledReason ?? "uninitialized" };
    }
    try {
      replaceRunIndex(this.db, rows);
      return { status: "replaced", rowCount: rows.length };
    } catch (err) {
      if (isSqliteBusyError(err)) throw err;
      this.disable(`run_index replace failed: ${(err as Error).message}`);
      return { status: "disabled", reason: this.disabledReason ?? "replace failed" };
    }
  }

  /**
   * Read the wave-2.2 marker that records when the one-time post-migration
   * backfill of `run_index` completed. Returns `absent` when the marker
   * has never been written, `present` with the recorded ISO timestamp
   * otherwise. The marker lives in `state_meta` so it survives across
   * processes — short-lived CLI invocations of `RunStore` consult it
   * before deciding whether to scan authoritative `run_record.json` files.
   */
  async readInitialBackfillMarker(): Promise<RunIndexReadMarkerOutcome> {
    const ok = await this.init();
    if (!ok || !this.db) {
      return { status: "disabled", reason: this.disabledReason ?? "uninitialized" };
    }
    try {
      const entry = readStateMeta(this.db, RUN_INDEX_INITIAL_BACKFILL_KEY);
      if (!entry) {
        return { status: "absent" };
      }
      return { status: "present", completedAt: entry.value };
    } catch (err) {
      this.disable(`run_index marker read failed: ${(err as Error).message}`);
      return { status: "disabled", reason: this.disabledReason ?? "marker read failed" };
    }
  }

  /**
   * Persist the wave-2.2 marker that gates the one-time post-migration
   * backfill of `run_index`. Idempotent on key — repeated writes refresh
   * the timestamp but never duplicate the row. Callers (RunStore) write
   * this only after a successful `replace()` of the projection from
   * authoritative records.
   */
  async writeInitialBackfillMarker(
    now: () => string = () => new Date().toISOString(),
  ): Promise<RunIndexWriteMarkerOutcome> {
    const ok = await this.init();
    if (!ok || !this.db) {
      return { status: "disabled", reason: this.disabledReason ?? "uninitialized" };
    }
    try {
      const completedAt = now();
      writeStateMeta(this.db, RUN_INDEX_INITIAL_BACKFILL_KEY, completedAt, () => completedAt);
      return { status: "written", completedAt };
    } catch (err) {
      if (isSqliteBusyError(err)) throw err;
      this.disable(`run_index marker write failed: ${(err as Error).message}`);
      return { status: "disabled", reason: this.disabledReason ?? "marker write failed" };
    }
  }

  async readProjectionDegradedMarker(): Promise<RunIndexProjectionDegradedMarkerOutcome> {
    const ok = await this.init();
    if (!ok || !this.db) {
      return { status: "disabled", reason: this.disabledReason ?? "uninitialized" };
    }
    try {
      const entry = readStateMeta(this.db, RUN_INDEX_PROJECTION_DEGRADED_KEY);
      return entry ? { status: "present", value: entry.value } : { status: "absent" };
    } catch (err) {
      this.disable(`run_index degraded marker read failed: ${(err as Error).message}`);
      return { status: "disabled", reason: this.disabledReason ?? "degraded marker read failed" };
    }
  }

  async writeProjectionDegradedMarker(
    runId: string,
    now: () => string = () => new Date().toISOString(),
  ): Promise<RunIndexProjectionDegradedMutationOutcome> {
    const ok = await this.init();
    if (!ok || !this.db) {
      return { status: "disabled", reason: this.disabledReason ?? "uninitialized" };
    }
    try {
      const value = JSON.stringify({ run_id: runId, marked_at: now() });
      writeStateMeta(this.db, RUN_INDEX_PROJECTION_DEGRADED_KEY, value, now);
      return { status: "written", value };
    } catch (err) {
      if (isSqliteBusyError(err)) throw err;
      this.disable(`run_index degraded marker write failed: ${(err as Error).message}`);
      return { status: "disabled", reason: this.disabledReason ?? "degraded marker write failed" };
    }
  }

  async clearProjectionDegradedMarker(): Promise<RunIndexProjectionDegradedMutationOutcome> {
    const ok = await this.init();
    if (!ok || !this.db) {
      return { status: "disabled", reason: this.disabledReason ?? "uninitialized" };
    }
    try {
      return {
        status: "cleared",
        existed: deleteStateMeta(this.db, RUN_INDEX_PROJECTION_DEGRADED_KEY),
      };
    } catch (err) {
      if (isSqliteBusyError(err)) throw err;
      this.disable(`run_index degraded marker clear failed: ${(err as Error).message}`);
      return { status: "disabled", reason: this.disabledReason ?? "degraded marker clear failed" };
    }
  }

  /**
   * Atomically merge the one-time file backfill into `run_index` and publish
   * its completion marker.
   *
   * This is deliberately not `replace()`: a run may be projected after the
   * caller scans `run_record.json` but before it enters this transaction.
   * Deleting the table in that window loses the concurrent row. Likewise, a
   * stale scanned version of a run must not overwrite a projected version.
   * `BEGIN IMMEDIATE` serializes writers, the marker is re-checked inside the
   * transaction, and scanned rows are inserted only when absent. Deliberately
   * avoiding timestamp comparisons makes the merge safe across equal stamps,
   * clock rollback, and writers with different clock epochs; explicit
   * reconcile remains the authority for repairing pre-existing divergence.
   */
  async mergeInitialBackfill(
    rows: readonly RunIndexRow[],
    now: () => string = () => new Date().toISOString(),
  ): Promise<RunIndexInitialBackfillOutcome> {
    const ok = await this.init();
    if (!ok || !this.db) {
      return { status: "disabled", reason: this.disabledReason ?? "uninitialized" };
    }

    let transactionOpen = false;
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      transactionOpen = true;

      const existingMarker = readStateMeta(this.db, RUN_INDEX_INITIAL_BACKFILL_KEY);
      if (existingMarker) {
        this.db.exec("COMMIT;");
        transactionOpen = false;
        return {
          status: "merged",
          rowCount: 0,
          completedAt: existingMarker.value,
          alreadyCompleted: true,
        };
      }

      let rowCount = 0;
      for (const row of rows) {
        const existing = readRunIndexEntry(this.db, row.run_id);
        if (!existing) {
          upsertRunIndexEntry(this.db, row);
          rowCount += 1;
        }
      }

      const completedAt = now();
      writeStateMeta(
        this.db,
        RUN_INDEX_INITIAL_BACKFILL_KEY,
        completedAt,
        () => completedAt,
      );
      this.db.exec("COMMIT;");
      transactionOpen = false;
      return {
        status: "merged",
        rowCount,
        completedAt,
        alreadyCompleted: false,
      };
    } catch (err) {
      if (transactionOpen) {
        try {
          this.db.exec("ROLLBACK;");
        } catch {
          // Preserve the original failure. Closing the projection below is the
          // fail-safe if SQLite could not unwind the transaction.
        }
      }
      if (isSqliteBusyError(err)) throw err;
      this.disable(`run_index initial backfill failed: ${(err as Error).message}`);
      return {
        status: "disabled",
        reason: this.disabledReason ?? "initial backfill failed",
      };
    }
  }

  close(): void {
    if (this.ownsDb && this.db) {
      try {
        this.db.close();
      } catch {
        /* swallow */
      }
      this.db = null;
    }
  }
}
