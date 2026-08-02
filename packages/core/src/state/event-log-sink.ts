import { stat } from "node:fs/promises";

import {
  loadStateDriver,
  type StateDriverDatabase,
  type StateDriverModule,
} from "./driver";
import { checkOrchestrationLedgerSchema } from "./orchestration-ledger";
import {
  appendOrchestrationEvent,
  OrchestrationEventIdentityConflictError,
  writeEventCursor,
} from "./orchestration-ledger";
import { appendOrchestrationEventWithQuarantine } from "./event-log-recovery";
import {
  assertStatePathAllowedForTests,
  resolveStatePaths,
  type ResolveStatePathsOptions,
  type ResolvedStatePaths,
} from "./paths";

/**
 * Stable shape of the stream events the run service writes today
 * (`CalyxStreamEvent` from `@polli-labs/calyx-run-service`). The sink only
 * relies on the durable, identity-bearing fields. We re-declare the shape
 * here to avoid a `core -> run-service` cycle.
 */
export interface SinkRunStreamEvent {
  schema_version: "1.0";
  event_id: string;
  cursor: string;
  emitted_at: string;
  event_type: string;
  emitted_by: string;
  run: {
    run_id: string;
    host?: string;
  };
  origin?: { launcher_kind?: string };
}

export interface SinkControlStreamEvent {
  schema_version: "1.0";
  event_id: string;
  cursor: string;
  emitted_at: string;
  event_type: string;
  emitted_by: string;
  control: {
    host?: string;
    daemon_id?: string;
  };
}

export interface SinkMonitorStreamEvent {
  schema_version: "1.0";
  event_id: string;
  cursor: string;
  emitted_at: string;
  event_type: string;
  emitted_by: string;
  monitor: {
    monitor_id: string;
    wake_id?: string;
    assigned_host?: string;
  };
}

export type SinkStreamEvent =
  | SinkRunStreamEvent
  | SinkControlStreamEvent
  | SinkMonitorStreamEvent;

function isRunStreamEvent(event: SinkStreamEvent): event is SinkRunStreamEvent {
  return "run" in event && typeof (event as SinkRunStreamEvent).run?.run_id === "string";
}

function isControlStreamEvent(event: SinkStreamEvent): event is SinkControlStreamEvent {
  return "control" in event;
}

function isMonitorStreamEvent(event: SinkStreamEvent): event is SinkMonitorStreamEvent {
  return "monitor" in event && typeof (event as SinkMonitorStreamEvent).monitor?.monitor_id === "string";
}

export interface OrchestrationLedgerSinkOptions {
  /** Override path resolution (test injection). */
  paths?: ResolveStatePathsOptions | ResolvedStatePaths;
  /** Pre-opened driver/database (test injection). */
  database?: StateDriverDatabase;
  /** Driver module override (test injection). */
  driver?: StateDriverModule;
  /** Default `host` column when an event doesn't carry one. */
  host?: string | undefined;
  /** Default `agent_id` column for stamped writes. */
  agentId?: string | undefined;
  /**
   * Source string written to `event_log.source`. Defaults to `run-service`.
   */
  source?: string | undefined;
  /**
   * Cursor source key (the "source" of `event_cursors` rows). Defaults to
   * `run-stream`. Different orchestrators (CLI, daemon, server) may share
   * one source when they all consume the same stream.
   */
  cursorSource?: string | undefined;
  /**
   * When `true`, refuse to silently disable when the migration is missing
   * — throw instead. Tests use this to fail loud on misconfiguration.
   */
  strict?: boolean;
}

/**
 * Ingest reasons. Returned to callers so they can record telemetry without
 * inspecting the row.
 */
export type IngestOutcome =
  | { status: "ingested"; inserted: boolean }
  /**
   * A genuine identity conflict was set aside rather than propagated. The
   * event is *handled*, not ingested — reporting it as `ingested` would make
   * the sink claim a row it does not hold. `path` locates the durable record
   * carrying both versions.
   */
  | { status: "quarantined"; path: string; reason: string }
  | { status: "disabled"; reason: string }
  | { status: "skipped"; reason: string };

/**
 * Run-service projection sink. Mirrors stream events to `event_log` and
 * advances `event_cursors`. Lazy-init: opens the state database on first
 * `ingestStreamEvent` call. Disables itself (and emits one warning to
 * stderr) when:
 *
 *   - the database file does not exist;
 *   - migration `0002` is not yet applied;
 *   - the schema is present but parity is broken.
 *
 * The sink never throws on ingest unless `strict: true`. The run service's
 * physical-root event authority remains authoritative; this state-database
 * ledger and its cursor advance together as one exact-idempotent projection.
 */
export class OrchestrationLedgerSink {
  private readonly options: OrchestrationLedgerSinkOptions;
  private db: StateDriverDatabase | null;
  private ownsDb: boolean;
  // A single shared promise tracks init lifecycle so concurrent first-use
  // callers await the same DB open / schema check instead of racing past a
  // half-initialized state. Without this, distinct events submitted during
  // the first init window would see a partial-`initialized` sink and bail
  // out as disabled, silently dropping the SQLite projection.
  private initPromise: Promise<boolean> | null = null;
  private disabledReason: string | null = null;
  private warned = false;
  /** Resolved at init; the quarantine sidecar is written beside the DB. */
  private stateDir: string | null = null;

  constructor(options: OrchestrationLedgerSinkOptions = {}) {
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
   * Idempotent initialization. Returns `true` when the sink is ready,
   * `false` when it disabled itself (no-op afterward). Concurrent callers
   * share a single init promise so the DB open / schema check runs once.
   */
  async init(): Promise<boolean> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.runInit();
    return this.initPromise;
  }

  private async runInit(): Promise<boolean> {
    // Resolved even when the database is injected: an injected db still needs a
    // state dir for the quarantine sidecar, and skipping this left it null so
    // quarantine wrote to "".
    const resolvedPaths: ResolvedStatePaths =
      this.options.paths && "stateDir" in this.options.paths
        ? (this.options.paths as ResolvedStatePaths)
        : resolveStatePaths(
            (this.options.paths as ResolveStatePathsOptions | undefined) ?? {},
          );
    this.stateDir = resolvedPaths.stateDir;

    if (!this.db) {
      const paths: ResolvedStatePaths = resolvedPaths;
      assertStatePathAllowedForTests(paths, this.options.paths as ResolveStatePathsOptions | undefined);

      try {
        await stat(paths.dbPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return this.disable(
            `state DB does not exist at ${paths.dbPath}; run \`calyx state migrate --apply\` to enable orchestration ledger ingest.`,
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
        // Pragmas are best-effort here; the migrate path enforces the
        // canonical pragmas. Continue.
      }
    }

    const parity = checkOrchestrationLedgerSchema(this.db);
    if (parity.status !== "ok") {
      const reasons = parity.findings.map((f) => `${f.table}: ${f.detail}`).join("; ");
      return this.disable(
        `orchestration ledger schema is incomplete (${reasons || "migration 0002 not applied"}); run \`calyx state migrate --apply\`.`,
      );
    }

    return true;
  }

  private disable(reason: string): false {
    this.disabledReason = reason;
    if (this.options.strict) {
      throw new Error(`OrchestrationLedgerSink: ${reason}`);
    }
    if (!this.warned) {
      this.warned = true;
      try {
        process.stderr.write(
          `[calyx-orchestration-ledger] ${reason} Continuing with JSON/JSONL only.\n`,
        );
      } catch {
        /* swallow secondary IO errors */
      }
    }
    return false;
  }

  /**
   * Commit the projection cursor in its own transaction. Returns `false` after
   * disabling the sink when the commit fails; under `strict` the disable throws,
   * so a cursor failure can never be reported as progress.
   */
  private commitCursor(cursor: Parameters<typeof writeEventCursor>[1]): boolean {
    if (!this.db) return false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      writeEventCursor(this.db, cursor);
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The disable below is the only remaining recovery.
      }
      this.disable(`event_log cursor commit failed: ${(err as Error).message}`);
      return false;
    }
  }

  async ingestStreamEvent(event: SinkStreamEvent): Promise<IngestOutcome> {
    const ok = await this.init();
    if (!ok) {
      return { status: "disabled", reason: this.disabledReason ?? "uninitialized" };
    }
    if (this.isDisabled || !this.db) {
      return { status: "disabled", reason: this.disabledReason ?? "no database" };
    }

    const projection = projectEventForLedger(event, this.options);
    if (!projection) {
      return { status: "skipped", reason: "event missing identifiable shape" };
    }

    // A genuine identity conflict is one bad row, not a broken database, so it
    // must not latch the whole sink off — that is what made a single divergent
    // 2026-05-11 event permanently unupgradeable on worm (POL-2090). Set the
    // event aside and keep ingesting. Every other failure still disables,
    // because those do mean the projection is unsound.
    //
    // The transaction body stays strictly synchronous. Awaiting inside
    // BEGIN IMMEDIATE lets concurrent callers interleave on the one shared
    // connection and nest transactions, which disables the sink for every
    // in-flight event; the quarantine write therefore happens after ROLLBACK.
    let inserted: boolean;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const result = appendOrchestrationEvent(this.db, projection.event);
      writeEventCursor(this.db, projection.cursor);
      this.db.exec("COMMIT");
      inserted = result.inserted;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Closing or disabling below is the only remaining recovery.
      }
      if (!(err instanceof OrchestrationEventIdentityConflictError)) {
        this.disable(`event_log append failed: ${(err as Error).message}`);
        return { status: "disabled", reason: this.disabledReason ?? "append failed" };
      }
      const outcome = await appendOrchestrationEventWithQuarantine(
        this.db,
        this.stateDir ?? "",
        projection.event,
        { ...(this.options.host ? { host: this.options.host } : {}) },
      );
      // The cursor commit is part of the outcome, not a best-effort epilogue.
      // Swallowing it and still reporting progress lets RunStore advance
      // `mirroredAuthorityOrdinal` past an event whose durable cursor is still
      // on the prior row, so a restart replays from a position the live process
      // has already claimed — and it breaks the row/cursor atomicity contract
      // asserted in orchestration-ledger.test.ts.
      if (!this.commitCursor(projection.cursor)) {
        return { status: "disabled", reason: this.disabledReason ?? "cursor commit failed" };
      }
      if (outcome.status !== "quarantined") {
        // The conflict did not reproduce outside the transaction; the append
        // landed, so report it normally.
        return { status: "ingested", inserted: outcome.inserted };
      }
      return {
        status: "quarantined",
        path: outcome.path,
        reason: `event_log identity conflict for ${projection.event.event_id} quarantined`,
      };
    }

    return { status: "ingested", inserted };
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

interface LedgerProjection {
  event: Parameters<typeof appendOrchestrationEventWithQuarantine>[2];
  cursor: Parameters<typeof writeEventCursor>[1];
}

function projectEventForLedger(
  event: SinkStreamEvent,
  options: OrchestrationLedgerSinkOptions,
): LedgerProjection | null {
  const source = options.source ?? "run-service";
  const cursorSource = options.cursorSource ?? "run-stream";

  if (isRunStreamEvent(event)) {
    return {
      event: {
        event_id: event.event_id,
        domain: "run",
        aggregate_type: "run",
        aggregate_id: event.run.run_id,
        event_type: event.event_type,
        cursor: event.cursor,
        occurred_at: event.emitted_at,
        ...(event.run.host || options.host
          ? { host: event.run.host ?? options.host }
          : {}),
        ...(options.agentId ? { agent_id: options.agentId } : {}),
        source,
        payload: event,
      },
      cursor: {
        source: cursorSource,
        domain: "run",
        cursor: event.cursor,
        observed_at: event.emitted_at,
        payload: { event_id: event.event_id, event_type: event.event_type },
      },
    };
  }
  if (isControlStreamEvent(event)) {
    const aggregateId = event.control.daemon_id ?? event.control.host ?? "unknown";
    return {
      event: {
        event_id: event.event_id,
        domain: "control",
        aggregate_type: "daemon",
        aggregate_id: aggregateId,
        event_type: event.event_type,
        cursor: event.cursor,
        occurred_at: event.emitted_at,
        ...(event.control.host || options.host
          ? { host: event.control.host ?? options.host }
          : {}),
        ...(options.agentId ? { agent_id: options.agentId } : {}),
        source,
        payload: event,
      },
      cursor: {
        source: cursorSource,
        domain: "control",
        cursor: event.cursor,
        observed_at: event.emitted_at,
        payload: { event_id: event.event_id, event_type: event.event_type },
      },
    };
  }
  if (isMonitorStreamEvent(event)) {
    return {
      event: {
        event_id: event.event_id,
        domain: "monitor",
        aggregate_type: "monitor",
        aggregate_id: event.monitor.monitor_id,
        event_type: event.event_type,
        cursor: event.cursor,
        occurred_at: event.emitted_at,
        ...(event.monitor.assigned_host || options.host
          ? { host: event.monitor.assigned_host ?? options.host }
          : {}),
        ...(options.agentId ? { agent_id: options.agentId } : {}),
        source,
        payload: event,
      },
      cursor: {
        source: cursorSource,
        domain: "monitor",
        cursor: event.cursor,
        observed_at: event.emitted_at,
        payload: { event_id: event.event_id, event_type: event.event_type },
      },
    };
  }
  return null;
}

export type EventLogIngest = (event: SinkStreamEvent) => Promise<IngestOutcome>;
