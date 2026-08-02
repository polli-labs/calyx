import { chmod, mkdir, stat } from "node:fs/promises";
import { hostname as systemHostname } from "node:os";
import { dirname } from "node:path";

import type { TaskRenderPreflightReceipt } from "../types";

import {
  loadStateDriver,
  StateDriverError,
  type StateDriverDatabase,
  type StateDriverModule,
} from "./driver";
import {
  checkFleetConvergenceSchema,
  countFleetConvergenceRows,
  type FleetConvergenceSchemaFinding,
} from "./fleet-convergence";
import {
  applyMigrations,
  checkMigrationConsistency,
  computeMigrationPlan,
  STATE_MIGRATIONS,
  type AppliedMigration,
  type MigrationApplyResult,
  type MigrationConsistency,
  type MigrationPlan,
  type StateMigration,
} from "./migrations";
import {
  checkLeaseSchema,
  countExpiredLeases,
  countLeases,
  listMalformedLeaseMetadata,
  type MalformedLeaseMetadataFinding,
  type LeaseSchemaFinding,
} from "./leases";
import {
  checkMonitorSchema,
  countMonitorDeliveries,
  countMonitorDeliveriesByStatus,
  countMonitorWakes,
  countMonitors,
  type MonitorDeliveryStatusCounts,
  type MonitorSchemaFinding,
} from "./monitors";
import {
  checkMessageSchema,
  countMessageDeliveries,
  countMessageDeliveriesByStatus,
  countMessageOutboxByStatus,
  countMessageOutboxRows,
  countMessages,
  countMessagesByStatus,
  countPendingMessages,
  listMalformedMessageReceiptSnapshots,
  type MalformedMessageReceiptSnapshotFinding,
  type MessageDeliveryStatusCounts,
  type MessageOutboxStatusCounts,
  type MessagePendingCounts,
  type MessageSchemaFinding,
  type MessageStatusCounts,
} from "./messages";
import {
  checkOrchestrationLedgerSchema,
  listExpiredLocks,
  listStaleSources,
  type LockHolder,
  type SchemaParityFinding,
  type SourceFreshnessRow,
} from "./orchestration-ledger";
import {
  listEventLogQuarantineRecords,
  verifyEventLogProjection,
  type EventLogProjectionReport,
  type EventLogQuarantineInventory,
} from "./event-log-recovery";
import {
  checkRunIndexSchema,
  countRunIndexEntries,
  type RunIndexSchemaFinding,
} from "./run-index";
import {
  checkActivityIndexSchema,
  countActivityMessages,
  listMalformedActivityMessages,
  summarizeActivityIndexFreshness,
  type ActivityIndexFreshness,
  type ActivityIndexSchemaFinding,
  type MalformedActivityMessageFinding,
} from "./activity-index";
import {
  checkActivityMarksSchema,
  doctorActivityMarks,
  readActivityMarksMembership,
  type ActivityMarkMembership,
  type ActivityMarksDoctorFinding,
  type ActivityMarksSchemaFinding,
} from "./activity-marks";
import {
  checkRunnerLiveBindingSchema,
  countRunnerLiveBindings,
  countRunnerLiveBindingsByStatus,
  type RunnerLiveBindingSchemaFinding,
  type RunnerLiveBindingStatusCounts,
} from "./runner-live-bindings";
import {
  checkSkillProposalsSchema,
  countSkillProposalsByStatus,
  listMalformedSkillProposals,
  type MalformedSkillProposalFinding,
  type SkillProposalStatusCounts,
  type SkillProposalsSchemaFinding,
} from "./skill-proposals";
import {
  checkSkillContentSchema,
  countSkillContent,
  countSkillWriteLog,
  listMalformedSkillContent,
  type MalformedSkillContentFinding,
  type SkillContentCounts,
  type SkillContentSchemaFinding,
} from "./skill-content";
import {
  checkMemoryContentSchema,
  countMemoryContent,
  countMemoryWriteLog,
  listMalformedMemoryContent,
  type MalformedMemoryContentFinding,
  type MemoryContentCounts,
  type MemoryContentSchemaFinding,
} from "./memory-content";
import {
  checkTaskSchema,
  codexTaskRenderLossFinding,
  countTaskInstalls,
  countTaskInstallsByStatus,
  countTaskRuns,
  listTaskInstalls,
  type TaskInstallStatus,
  type TaskSchemaFinding,
} from "./task-lifecycle";
import {
  assertStatePathAllowedForTests,
  resolveStatePaths,
  type ResolvedStatePaths,
  type ResolveStatePathsOptions,
} from "./paths";

export const STATE_DIR_MODE = 0o700;
export const STATE_DB_FILE_MODE = 0o600;

export type ModeEnforcementStatus =
  | "enforced"
  | "drifted"
  | "platform-skipped"
  | "missing"
  | "error";

export interface FileModeReport {
  path: string;
  mode: number | null;
  modeOctal: string | null;
  expectedOctal: string;
  status: ModeEnforcementStatus;
  message?: string;
}

export interface StateOpenOptions extends ResolveStatePathsOptions {
  /** Override the WAL pragma. Tests use `MEMORY` for `:memory:` databases. */
  journalMode?: "wal" | "delete" | "memory" | "off";
  /** Override busy_timeout in ms. */
  busyTimeoutMs?: number;
  /** Toggle foreign_keys. Default true. */
  foreignKeys?: boolean;
  /** Override path resolution entirely; useful for tests. */
  paths?: ResolvedStatePaths;
  /** Skip directory creation/chmod. Used for `:memory:` style tests. */
  skipFilesystem?: boolean;
  /** Force a particular driver module (test injection). */
  driver?: StateDriverModule;
}

export interface OpenedState {
  db: StateDriverDatabase;
  driver: StateDriverModule;
  paths: ResolvedStatePaths;
  journalMode: string;
  foreignKeysEnabled: boolean;
  busyTimeoutMs: number;
  /** True when this state file was created by this open call. */
  createdDb: boolean;
  /** True when the state directory was created by this open call. */
  createdStateDir: boolean;
}

function pragmaScalar<T = unknown>(db: StateDriverDatabase, pragma: string): T {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  if (!row) return undefined as unknown as T;
  const values = Object.values(row);
  return (values[0] as T) ?? (undefined as unknown as T);
}

async function ensureDirMode(path: string): Promise<FileModeReport> {
  try {
    const stats = await stat(path);
    if (process.platform === "win32") {
      return {
        path,
        mode: stats.mode & 0o777,
        modeOctal: (stats.mode & 0o777).toString(8).padStart(3, "0"),
        expectedOctal: STATE_DIR_MODE.toString(8).padStart(3, "0"),
        status: "platform-skipped",
        message: "POSIX file modes are not enforced on win32.",
      };
    }
    try {
      await chmod(path, STATE_DIR_MODE);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        path,
        mode: stats.mode & 0o777,
        modeOctal: (stats.mode & 0o777).toString(8).padStart(3, "0"),
        expectedOctal: STATE_DIR_MODE.toString(8).padStart(3, "0"),
        status: "error",
        message,
      };
    }
    const after = await stat(path);
    const mode = after.mode & 0o777;
    return {
      path,
      mode,
      modeOctal: mode.toString(8).padStart(3, "0"),
      expectedOctal: STATE_DIR_MODE.toString(8).padStart(3, "0"),
      status: mode === STATE_DIR_MODE ? "enforced" : "drifted",
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        path,
        mode: null,
        modeOctal: null,
        expectedOctal: STATE_DIR_MODE.toString(8).padStart(3, "0"),
        status: "missing",
        message: "directory does not exist",
      };
    }
    return {
      path,
      mode: null,
      modeOctal: null,
      expectedOctal: STATE_DIR_MODE.toString(8).padStart(3, "0"),
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function reportDirMode(path: string): Promise<FileModeReport> {
  return await ensureDirMode(path);
}

async function ensureFileMode(path: string): Promise<FileModeReport> {
  const expectedOctal = STATE_DB_FILE_MODE.toString(8).padStart(3, "0");
  try {
    const stats = await stat(path);
    if (process.platform === "win32") {
      return {
        path,
        mode: stats.mode & 0o777,
        modeOctal: (stats.mode & 0o777).toString(8).padStart(3, "0"),
        expectedOctal,
        status: "platform-skipped",
        message: "POSIX file modes are not enforced on win32.",
      };
    }
    try {
      await chmod(path, STATE_DB_FILE_MODE);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        path,
        mode: stats.mode & 0o777,
        modeOctal: (stats.mode & 0o777).toString(8).padStart(3, "0"),
        expectedOctal,
        status: "error",
        message,
      };
    }
    const after = await stat(path);
    const mode = after.mode & 0o777;
    return {
      path,
      mode,
      modeOctal: mode.toString(8).padStart(3, "0"),
      expectedOctal,
      status: mode === STATE_DB_FILE_MODE ? "enforced" : "drifted",
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        path,
        mode: null,
        modeOctal: null,
        expectedOctal,
        status: "missing",
        message: "database file does not exist",
      };
    }
    return {
      path,
      mode: null,
      modeOctal: null,
      expectedOctal,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Open the Calyx state database. Resolves paths, creates the directory at
 * 0700 when missing, opens the SQLite file at 0600, and applies the wave-1
 * baseline pragmas (`journal_mode = WAL`, `foreign_keys = ON`,
 * `busy_timeout = 5000`).
 */
export async function openStateStore(options: StateOpenOptions = {}): Promise<OpenedState> {
  const paths = options.paths ?? resolveStatePaths(options);
  assertStatePathAllowedForTests(paths, options);
  const driver = options.driver ?? (await loadStateDriver());

  let createdStateDir = false;
  let createdDb = false;

  if (!options.skipFilesystem) {
    try {
      await stat(paths.stateDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      await mkdir(paths.stateDir, { recursive: true, mode: STATE_DIR_MODE });
      createdStateDir = true;
    }
    if (process.platform !== "win32") {
      try {
        await chmod(paths.stateDir, STATE_DIR_MODE);
      } catch {
        // Surface mode drift via the doctor report instead of failing open.
      }
    }

    try {
      await stat(paths.dbPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      createdDb = true;
    }
    // Ensure the parent directory of dbPath exists when callers point
    // CALYX_STATE_DB at a different directory than CALYX_STATE_HOME.
    const dbDir = dirname(paths.dbPath);
    if (dbDir !== paths.stateDir) {
      await mkdir(dbDir, { recursive: true, mode: STATE_DIR_MODE });
    }
  }

  const db = driver.open(paths.dbPath);

  const busy = options.busyTimeoutMs ?? 5000;
  db.exec(`PRAGMA busy_timeout = ${busy};`);
  const journalRequest = options.journalMode ?? "wal";
  db.exec(`PRAGMA journal_mode = ${journalRequest.toUpperCase()};`);
  const fkOn = options.foreignKeys ?? true;
  db.exec(`PRAGMA foreign_keys = ${fkOn ? "ON" : "OFF"};`);

  if (!options.skipFilesystem && createdDb && process.platform !== "win32") {
    try {
      await chmod(paths.dbPath, STATE_DB_FILE_MODE);
    } catch {
      // Surface via doctor.
    }
  }

  const journalMode = String(pragmaScalar<string>(db, "journal_mode") ?? journalRequest);
  const foreignKeysEnabled = Number(pragmaScalar<number>(db, "foreign_keys") ?? 0) === 1;
  const busyTimeoutMs = Number(pragmaScalar<number>(db, "busy_timeout") ?? busy);

  return {
    db,
    driver,
    paths,
    journalMode,
    foreignKeysEnabled,
    busyTimeoutMs,
    createdDb,
    createdStateDir,
  };
}

export interface StatePathInfo {
  stateDir: string;
  dbPath: string;
  source: ResolvedStatePaths["source"];
  dirSource: ResolvedStatePaths["dirSource"];
  envVars: { home: string; db: string };
}

export function describeStatePaths(options: ResolveStatePathsOptions = {}): StatePathInfo {
  const resolved = resolveStatePaths(options);
  return {
    stateDir: resolved.stateDir,
    dbPath: resolved.dbPath,
    source: resolved.source,
    dirSource: resolved.dirSource,
    envVars: { home: "CALYX_STATE_HOME", db: "CALYX_STATE_DB" },
  };
}

export interface OrchestrationLedgerStatus {
  /** True when the migration that introduces the ledger has been applied. */
  migrationApplied: boolean;
  /** "ok" — all expected tables/columns/indexes present. "drift" — at least one missing. "absent" — migration not yet applied. */
  schemaParity: "ok" | "drift" | "absent";
  schemaFindings: SchemaParityFinding[];
  /** Bounded sample of locks whose expiry time has elapsed. */
  expiredLocks: LockHolder[];
  /** Total count of expired locks at evaluation time. */
  expiredLocksTotal: number;
  /** True when `expiredLocks` is a truncated sample of `expiredLocksTotal`. */
  expiredLocksTruncated: boolean;
  /** Bounded sample of source-freshness rows that are stale, error, or past their stale_after_ms deadline. */
  staleSources: SourceFreshnessRow[];
  /** Total count of stale sources at evaluation time. */
  staleSourcesTotal: number;
  /** True when `staleSources` is a truncated sample of `staleSourcesTotal`. */
  staleSourcesTruncated: boolean;
}

export interface RunIndexStatus {
  /** True when migration 0003 has been applied. */
  migrationApplied: boolean;
  /** "ok" — all expected columns/indexes present. "drift" — at least one missing. "absent" — migration not yet applied. */
  schemaParity: "ok" | "drift" | "absent";
  schemaFindings: RunIndexSchemaFinding[];
  /** Number of rows currently projected into `run_index`. */
  rowCount: number;
}

export interface ActivityIndexStatus {
  /** True when migration 0013 has been applied. */
  migrationApplied: boolean;
  /** "ok" — all expected tables/columns/indexes present. "drift" — at least one missing. "absent" — migration not yet applied. */
  schemaParity: "ok" | "drift" | "absent";
  schemaFindings: ActivityIndexSchemaFinding[];
  /** Number of normalized message rows currently retained. */
  messageCount: number;
  /** Freshness snapshot: indexed-through, pending sources, last ingest run. */
  freshness: ActivityIndexFreshness;
  /** Bounded list of structurally malformed rows surfaced as blocking findings. */
  malformed: MalformedActivityMessageFinding[];
}

export interface ActivityMarksStatus {
  /** True when migration 0035 has been applied. */
  migrationApplied: boolean;
  /** Marks are authoritative and intentionally independent from activity-index parity. */
  schemaParity: "ok" | "drift" | "absent";
  schemaFindings: ActivityMarksSchemaFinding[];
  total: number;
  active: number;
  revoked: number;
  malformed: number;
  membership: ActivityMarkMembership | null;
  doctorFindings: ActivityMarksDoctorFinding[];
}

export interface SkillProposalsStatus {
  /** True when migration 0004 has been applied. */
  migrationApplied: boolean;
  /** "ok" — all expected columns/indexes present. "drift" — at least one missing. "absent" — migration not yet applied. */
  schemaParity: "ok" | "drift" | "absent";
  schemaFindings: SkillProposalsSchemaFinding[];
  /** Bounded counts of proposals by status. Zero when migration not applied. */
  counts: SkillProposalStatusCounts;
  /** Total count across all statuses. */
  total: number;
  /** Bounded list of malformed rows surfaced as blocking findings. */
  malformed: MalformedSkillProposalFinding[];
}

export interface SkillContentStatus {
  /** True when migration 0016 has been applied. */
  migrationApplied: boolean;
  /** "ok" — all expected columns/indexes present. "drift" — at least one missing. "absent" — migration not yet applied. */
  schemaParity: "ok" | "drift" | "absent";
  schemaFindings: SkillContentSchemaFinding[];
  /** Live + tombstoned counts and a per-regime distribution. Zero when migration not applied. */
  counts: SkillContentCounts;
  /** Total skill_write_log rows. */
  writeLogCount: number;
  /** Bounded list of malformed rows surfaced as blocking findings. */
  malformed: MalformedSkillContentFinding[];
}

export interface MemoryContentStatus {
  /** True when migration 0018 has been applied. */
  migrationApplied: boolean;
  /** "ok" — all expected columns/indexes present. "drift" — at least one missing. "absent" — migration not yet applied. */
  schemaParity: "ok" | "drift" | "absent";
  schemaFindings: MemoryContentSchemaFinding[];
  /** Live + tombstoned counts, per-review-status and per-category distributions. Zero when migration not applied. */
  counts: MemoryContentCounts;
  /** Total memory_write_log rows. */
  writeLogCount: number;
  /** Bounded list of malformed rows surfaced as blocking findings. */
  malformed: MalformedMemoryContentFinding[];
}

export interface FleetConvergenceStatus {
  /** True when migration 0005 has been applied. */
  migrationApplied: boolean;
  /** "ok" — all expected columns/indexes present. "drift" — at least one missing. "absent" — migration not yet applied. */
  schemaParity: "ok" | "drift" | "absent";
  schemaFindings: FleetConvergenceSchemaFinding[];
  /** Number of rows currently projected into `fleet_convergence`. */
  rowCount: number;
}

export interface MonitorStoreStatus {
  /** True when migration 0007 has been applied. */
  migrationApplied: boolean;
  /** "ok" — all expected columns/indexes present. "drift" — at least one missing. "absent" — migration not yet applied. */
  schemaParity: "ok" | "drift" | "absent";
  schemaFindings: MonitorSchemaFinding[];
  /** Number of monitor rows currently persisted. */
  monitorCount: number;
  /** Number of wake rows retained in the durable inbox. */
  wakeCount: number;
  /** Number of delivery-state rows retained for monitor delivery bindings. */
  deliveryCount: number;
  /** Delivery-state counts by attempted/delivered/failed status. */
  deliveryCounts: MonitorDeliveryStatusCounts;
  /** Active monitor rows assigned to a non-local host. These are inert here. */
  foreignAssignedHostCount: number;
  /** Bounded evidence rows for foreign-assigned active monitors. */
  foreignAssignedHostSamples: Array<{ monitor_id: string; assigned_host: string }>;
}

export interface MessageStoreStatus {
  /** True when migration 0011 has been applied. */
  migrationApplied: boolean;
  /** "ok" — all expected columns/indexes present. "drift" — at least one missing. "absent" — migration not yet applied. */
  schemaParity: "ok" | "drift" | "absent";
  schemaFindings: MessageSchemaFinding[];
  /** Number of message rows retained across recipient inboxes and sender outbox copies. */
  messageCount: number;
  /** Message rows by lifecycle status. */
  messageCounts: MessageStatusCounts;
  /** Number of delivery-state rows retained for correspondence delivery bindings. */
  deliveryCount: number;
  /** Delivery-state counts by attempted/delivered/failed status. */
  deliveryCounts: MessageDeliveryStatusCounts;
  /** Number of sender outbox rows. */
  outboxCount: number;
  /** Sender outbox rows by forwarding status. */
  outboxCounts: MessageOutboxStatusCounts;
  /** Small pending-count summary used by agent-context and doctor output. */
  pendingCounts: MessagePendingCounts;
  /** Explicit-doctor findings; ordinary health reports leave this empty. */
  malformed: MalformedMessageReceiptSnapshotFinding[];
}

export interface RunnerLiveBindingsStatus {
  /** True when migration 0010 has been applied. */
  migrationApplied: boolean;
  /** "ok" — all expected columns/indexes present. "drift" — at least one missing. "absent" — migration not yet applied. */
  schemaParity: "ok" | "drift" | "absent";
  schemaFindings: RunnerLiveBindingSchemaFinding[];
  /** Number of live-binding rows currently retained. */
  rowCount: number;
  /** Live-binding counts by active/closed status. */
  counts: RunnerLiveBindingStatusCounts;
}

export interface LeaseStoreStatus {
  /** True when migration 0012 has been applied. */
  migrationApplied: boolean;
  /** "ok" - expected lease table/columns/indexes present. "drift" - at least one missing. "absent" - migration not yet applied. */
  schemaParity: "ok" | "drift" | "absent";
  schemaFindings: LeaseSchemaFinding[];
  /** Number of lease rows currently retained. */
  rowCount: number;
  /** Number of retained leases whose expiry time has elapsed. */
  expiredCount: number;
  /** Explicit-doctor findings; ordinary health reports leave this empty. */
  malformed: MalformedLeaseMetadataFinding[];
}

export interface TaskLifecycleStatus {
  /** True when migration 0008 has been applied. */
  migrationApplied: boolean;
  /** "ok" — all expected columns/indexes present. "drift" — at least one missing. "absent" — migration not yet applied. */
  schemaParity: "ok" | "drift" | "absent";
  schemaFindings: TaskSchemaFinding[];
  /** Number of task installs currently persisted. */
  installCount: number;
  /** Number of task-run rows currently persisted. */
  taskRunCount: number;
  /** Install counts by status. */
  installCounts: Record<TaskInstallStatus, number>;
}

export interface StateHealthReport {
  driver: string;
  driverMinNode: string;
  nodeVersion: string;
  paths: StatePathInfo;
  journalMode: string;
  foreignKeysEnabled: boolean;
  busyTimeoutMs: number;
  schemaVersion: string | null;
  targetSchemaVersion: string | null;
  pendingMigrations: number;
  appliedMigrations: AppliedMigration[];
  lastMigration: AppliedMigration | null;
  directoryMode: FileModeReport;
  databaseMode: FileModeReport;
  migrationConsistency: MigrationConsistency;
  orchestrationLedger: OrchestrationLedgerStatus;
  runIndex: RunIndexStatus;
  activityIndex: ActivityIndexStatus;
  activityMarks: ActivityMarksStatus;
  skillProposals: SkillProposalsStatus;
  skillContent: SkillContentStatus;
  memoryContent: MemoryContentStatus;
  fleetConvergence: FleetConvergenceStatus;
  monitors: MonitorStoreStatus;
  messages: MessageStoreStatus;
  runnerLiveBindings: RunnerLiveBindingsStatus;
  leases: LeaseStoreStatus;
  tasks: TaskLifecycleStatus;
  ok: boolean;
}

export interface StateDoctorFinding {
  code: string;
  severity: "info" | "warn" | "error";
  message: string;
  task_id?: string;
  install_id?: string;
  manifest_path?: string;
  receipt?: TaskRenderPreflightReceipt;
}

export interface StateDoctorReport extends StateHealthReport {
  findings: StateDoctorFinding[];
  ok: boolean;
  /**
   * Per-domain results. Populated only when the caller passes
   * `domains: [...]` to {@link runStateDoctor}. When present, `ok` reflects
   * only the selected domains' blocking findings, not the full report.
   */
  domains?: StateDoctorDomainResult[];
  /**
   * `event_log`-vs-run-journal projection scan. Doctor-only: it reads the
   * whole stream journal, so ordinary health stays cheap. Only the host
   * holding both the journal and the database can compute it — which is the
   * point, since replay divergence must be found here rather than
   * mid-upgrade (POL-2090).
   */
  eventLogProjection: EventLogProjectionReport;
  /** Rows set aside so ingest could continue, and never silently dropped. */
  eventLogQuarantine: EventLogQuarantineInventory;
}

interface ConductOptions {
  paths?: ResolveStatePathsOptions;
  storeOptions?: StateOpenOptions;
  /** Inject a fixed driver (tests). */
  driver?: StateDriverModule;
  /** Override migration source (tests / future slices). */
  migrations?: readonly StateMigration[];
  /**
   * Per-domain doctor filter. When set, `runStateDoctor` populates the
   * `domains` field and computes `ok` against the selected subset only.
   * Unknown domains surface as `unknown-domain` results, and statically
   * not-applicable domains (e.g. `activity`) surface as `not-applicable`
   * results — never silently dropped.
   */
  domains?: readonly string[];
  /**
   * Run-root stream journal to compare `event_log` against. Defaults to
   * `resolveEventJournalPath()`.
   */
  journalPath?: string;
  /** Cap on journal lines scanned by the doctor's projection check. */
  journalScanLimit?: number;
}

/**
 * Plan migrations without writing. Honors the read-only contract: when the
 * database file does not exist, the plan is derived from the source
 * migrations and neither the state directory nor the DB file is created.
 * When it does exist, the ledger is read through a read-only SQLite
 * connection so no pragmas, journal sidecars, or mode changes are written.
 */
export async function planStateMigrations(opts: ConductOptions = {}): Promise<MigrationPlan> {
  const driver =
    opts.driver ?? opts.storeOptions?.driver ?? (await loadStateDriver());
  const migrations = opts.migrations ?? STATE_MIGRATIONS;
  const skipFs = opts.storeOptions?.skipFilesystem ?? false;
  const paths = opts.storeOptions?.paths ?? resolveStatePaths(opts.storeOptions ?? {});

  if (skipFs) {
    // Caller manages filesystem (e.g. `:memory:` in tests). Use the writable
    // open since `:memory:` cannot be opened read-only and is per-process.
    assertStatePathAllowedForTests(paths, opts.storeOptions ?? {});
    const db = driver.open(paths.dbPath);
    try {
      return computeMigrationPlan(db, migrations, driver.id);
    } finally {
      db.close();
    }
  }

  const dbExists = await pathExists(paths.dbPath);
  if (!dbExists) {
    return planFromSource(migrations, driver.id);
  }

  assertStatePathAllowedForTests(paths, opts.storeOptions ?? {});
  const db = driver.openReadOnly(paths.dbPath);
  try {
    return computeMigrationPlan(db, migrations, driver.id);
  } finally {
    db.close();
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw err;
  }
}

function planFromSource(
  source: readonly StateMigration[],
  driverId: string,
): MigrationPlan {
  return {
    driver: driverId,
    current: null,
    target: source.length === 0 ? null : source[source.length - 1]!.id,
    pending: source.map((m) => ({
      id: m.id,
      description: m.description,
      status: "pending",
      growthBound: m.growthBound,
    })),
    applied: [],
    ledgerExists: false,
  };
}

/** Apply migrations idempotently. */
export async function applyStateMigrations(
  opts: ConductOptions = {},
): Promise<MigrationApplyResult> {
  const opened = await openStateStore({ ...(opts.storeOptions ?? {}), ...(opts.driver ? { driver: opts.driver } : {}) });
  try {
    return applyMigrations(opened.db, opts.migrations ?? STATE_MIGRATIONS, opened.driver.id);
  } finally {
    opened.db.close();
  }
}

const ORCHESTRATION_LEDGER_MIGRATION_ID = "0002";
const RUN_INDEX_MIGRATION_ID = "0003";
const SKILL_PROPOSALS_MIGRATION_ID = "0004";
const FLEET_CONVERGENCE_MIGRATION_ID = "0005";
const MONITOR_MIGRATION_ID = "0007";
const TASK_LIFECYCLE_MIGRATION_ID = "0008";
const RUNNER_LIVE_BINDINGS_MIGRATION_ID = "0010";
const MESSAGE_MIGRATION_ID = "0011";
const LEASE_MIGRATION_ID = "0012";
const ACTIVITY_INDEX_MIGRATION_ID = "0013";
const ACTIVITY_MARKS_MIGRATION_ID = "0035";
const SKILL_CONTENT_MIGRATION_ID = "0016";
const MEMORY_CONTENT_MIGRATION_ID = "0018";

/**
 * Supported `--domain` selectors for `calyx state doctor`. Domains not in
 * this set are not silently ignored — see `runStateDoctor` for the
 * not-applicable + unknown-domain result envelope.
 */
export const STATE_DOCTOR_DOMAINS = [
  "state",
  "orchestration",
  "run_index",
  "activity",
  "marks",
  "skill_proposals",
  "skill_content",
  "memory_content",
  "fleet_convergence",
  "monitors",
  "messages",
  "runner_live_bindings",
  "leases",
  "tasks",
] as const;
export type StateDoctorDomain = (typeof STATE_DOCTOR_DOMAINS)[number];

/**
 * Domains that are valid input to `--domain` but have no SQLite schema yet.
 * The doctor reports an explicit `not-applicable` result for these instead
 * of silently dropping the request. `activity` graduated to a real domain in
 * POL-1838 (migration 0013); this set is now empty but retained so a future
 * pre-schema domain can be declared without re-introducing the envelope.
 */
export const STATE_DOCTOR_NOT_APPLICABLE_DOMAINS = [] as const;
export type StateDoctorNotApplicableDomain =
  (typeof STATE_DOCTOR_NOT_APPLICABLE_DOMAINS)[number];

export interface StateDoctorDomainResult {
  domain: string;
  status: "ok" | "drift" | "absent" | "not-applicable" | "unknown-domain";
  findings: StateDoctorFinding[];
  detail?: string;
}

function tableExists(db: StateDriverDatabase, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name?: string } | undefined;
  return Boolean(row && row.name === table);
}

function evaluateRunIndex(
  db: StateDriverDatabase,
  plan: MigrationPlan,
): RunIndexStatus {
  const migrationApplied = plan.applied.some(
    (m) => m.id === RUN_INDEX_MIGRATION_ID,
  );
  if (!migrationApplied) {
    return {
      migrationApplied: false,
      schemaParity: "absent",
      schemaFindings: [],
      rowCount: 0,
    };
  }
  const parity = checkRunIndexSchema(db);
  const rowCount = tableExists(db, "run_index") ? countRunIndexEntries(db) : 0;
  return {
    migrationApplied: true,
    schemaParity: parity.status,
    schemaFindings: parity.findings,
    rowCount,
  };
}

function evaluateActivityIndex(
  db: StateDriverDatabase,
  plan: MigrationPlan,
): ActivityIndexStatus {
  const migrationApplied = plan.applied.some(
    (m) => m.id === ACTIVITY_INDEX_MIGRATION_ID,
  );
  if (!migrationApplied) {
    return {
      migrationApplied: false,
      schemaParity: "absent",
      schemaFindings: [],
      messageCount: 0,
      freshness: { message_count: 0, source_count: 0, pending_sources: 0 },
      malformed: [],
    };
  }
  const parity = checkActivityIndexSchema(db);
  const hasMessages = tableExists(db, "activity_messages");
  const hasCursors = tableExists(db, "activity_source_cursors");
  const hasRuns = tableExists(db, "activity_index_runs");
  const messageCount = hasMessages ? countActivityMessages(db) : 0;
  const freshness =
    hasMessages && hasCursors && hasRuns
      ? summarizeActivityIndexFreshness(db)
      : { message_count: messageCount, source_count: 0, pending_sources: 0 };
  const malformed = hasMessages ? listMalformedActivityMessages(db) : [];
  return {
    migrationApplied: true,
    schemaParity: parity.status,
    schemaFindings: parity.findings,
    messageCount,
    freshness,
    malformed,
  };
}

function evaluateActivityMarks(
  db: StateDriverDatabase,
  plan: MigrationPlan,
): ActivityMarksStatus {
  const migrationApplied = plan.applied.some((migration) => migration.id === ACTIVITY_MARKS_MIGRATION_ID);
  if (!migrationApplied) {
    return {
      migrationApplied: false,
      schemaParity: "absent",
      schemaFindings: [],
      total: 0,
      active: 0,
      revoked: 0,
      malformed: 0,
      membership: null,
      doctorFindings: [],
    };
  }
  const schema = checkActivityMarksSchema(db);
  if (schema.status === "drift") {
    return {
      migrationApplied: true,
      schemaParity: "drift",
      schemaFindings: schema.findings,
      total: 0,
      active: 0,
      revoked: 0,
      malformed: 0,
      membership: null,
      doctorFindings: [],
    };
  }
  const counts = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked
       FROM activity_marks`,
  ).get() as {
    total: number | bigint;
    active: number | bigint | null;
    revoked: number | bigint | null;
  };
  let membership: ActivityMarkMembership | null = null;
  let malformed = 0;
  try {
    membership = readActivityMarksMembership(db);
  } catch {
    // Explicit doctor owns the detailed malformed membership finding. Ordinary
    // health remains bounded and reports the absent head without laundering it.
    malformed = 1;
  }
  return {
    migrationApplied: true,
    schemaParity: "ok",
    schemaFindings: [],
    total: Number(counts.total),
    active: Number(counts.active ?? 0),
    revoked: Number(counts.revoked ?? 0),
    malformed,
    membership,
    doctorFindings: [],
  };
}

function evaluateSkillProposals(
  db: StateDriverDatabase,
  plan: MigrationPlan,
): SkillProposalsStatus {
  const migrationApplied = plan.applied.some(
    (m) => m.id === SKILL_PROPOSALS_MIGRATION_ID,
  );
  const zeroCounts: SkillProposalStatusCounts = {
    proposed: 0,
    validated: 0,
    materialized: 0,
    accepted: 0,
    rejected: 0,
    superseded: 0,
  };
  if (!migrationApplied) {
    return {
      migrationApplied: false,
      schemaParity: "absent",
      schemaFindings: [],
      counts: zeroCounts,
      total: 0,
      malformed: [],
    };
  }
  const parity = checkSkillProposalsSchema(db);
  const counts = tableExists(db, "skill_proposals")
    ? countSkillProposalsByStatus(db)
    : zeroCounts;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const malformed = tableExists(db, "skill_proposals")
    ? listMalformedSkillProposals(db)
    : [];
  return {
    migrationApplied: true,
    schemaParity: parity.status,
    schemaFindings: parity.findings,
    counts,
    total,
    malformed,
  };
}

function evaluateSkillContent(
  db: StateDriverDatabase,
  plan: MigrationPlan,
): SkillContentStatus {
  const migrationApplied = plan.applied.some(
    (m) => m.id === SKILL_CONTENT_MIGRATION_ID,
  );
  const zeroCounts: SkillContentCounts = { live: 0, tombstoned: 0, pinned: 0, byRegime: {} };
  if (!migrationApplied) {
    return {
      migrationApplied: false,
      schemaParity: "absent",
      schemaFindings: [],
      counts: zeroCounts,
      writeLogCount: 0,
      malformed: [],
    };
  }
  const parity = checkSkillContentSchema(db);
  const schemaQueryable = parity.status === "ok";
  const counts = schemaQueryable
    ? countSkillContent(db)
    : zeroCounts;
  const writeLogCount = tableExists(db, "skill_write_log")
    ? countSkillWriteLog(db)
    : 0;
  const malformed =
    schemaQueryable && tableExists(db, "skill_write_log")
      ? listMalformedSkillContent(db)
      : [];
  return {
    migrationApplied: true,
    schemaParity: parity.status,
    schemaFindings: parity.findings,
    counts,
    writeLogCount,
    malformed,
  };
}

function evaluateMemoryContent(
  db: StateDriverDatabase,
  plan: MigrationPlan,
): MemoryContentStatus {
  const migrationApplied = plan.applied.some(
    (m) => m.id === MEMORY_CONTENT_MIGRATION_ID,
  );
  const zeroCounts: MemoryContentCounts = {
    live: 0,
    tombstoned: 0,
    pinned: 0,
    byReviewStatus: {},
    byCategory: {},
  };
  if (!migrationApplied) {
    return {
      migrationApplied: false,
      schemaParity: "absent",
      schemaFindings: [],
      counts: zeroCounts,
      writeLogCount: 0,
      malformed: [],
    };
  }
  const parity = checkMemoryContentSchema(db);
  const counts = tableExists(db, "memory_content")
    ? countMemoryContent(db)
    : zeroCounts;
  const writeLogCount = tableExists(db, "memory_write_log")
    ? countMemoryWriteLog(db)
    : 0;
  const malformed =
    tableExists(db, "memory_content") && tableExists(db, "memory_write_log")
      ? listMalformedMemoryContent(db)
      : [];
  return {
    migrationApplied: true,
    schemaParity: parity.status,
    schemaFindings: parity.findings,
    counts,
    writeLogCount,
    malformed,
  };
}

function evaluateFleetConvergence(
  db: StateDriverDatabase,
  plan: MigrationPlan,
): FleetConvergenceStatus {
  const migrationApplied = plan.applied.some(
    (m) => m.id === FLEET_CONVERGENCE_MIGRATION_ID,
  );
  if (!migrationApplied) {
    return {
      migrationApplied: false,
      schemaParity: "absent",
      schemaFindings: [],
      rowCount: 0,
    };
  }
  const parity = checkFleetConvergenceSchema(db);
  const rowCount = tableExists(db, "fleet_convergence")
    ? countFleetConvergenceRows(db)
    : 0;
  return {
    migrationApplied: true,
    schemaParity: parity.status,
    schemaFindings: parity.findings,
    rowCount,
  };
}

function evaluateMonitors(
  db: StateDriverDatabase,
  plan: MigrationPlan,
): MonitorStoreStatus {
  const migrationApplied = plan.applied.some((m) => m.id === MONITOR_MIGRATION_ID);
  if (!migrationApplied) {
    return {
      migrationApplied: false,
      schemaParity: "absent",
      schemaFindings: [],
      monitorCount: 0,
      wakeCount: 0,
      deliveryCount: 0,
      deliveryCounts: { attempted: 0, delivered: 0, failed: 0 },
      foreignAssignedHostCount: 0,
      foreignAssignedHostSamples: [],
    };
  }
  const parity = checkMonitorSchema(db);
  const hasDeliveryTable = tableExists(db, "monitor_deliveries");
  const hasMonitorTable = tableExists(db, "monitors");
  // Mirror the evaluator's host normalization (monitor-evaluator.ts normalizeHost):
  // trim, lowercase, strip the domain suffix. A legacy row storing `carbon.local`
  // on host carbon does evaluate locally and must not be flagged as foreign.
  const normalizeAssignedHost = (host: string): string => host.trim().toLowerCase().replace(/\..*$/, "");
  const localHost = normalizeAssignedHost(systemHostname());
  const activeAssignedRows = hasMonitorTable
    ? db.prepare(
      `SELECT monitor_id, assigned_host
       FROM monitors
       WHERE status = 'active'
         AND assigned_host IS NOT NULL
       ORDER BY created_at DESC, monitor_id ASC`,
    ).all() as Array<{ monitor_id: string; assigned_host: string }>
    : [];
  const foreignAssignedAll = activeAssignedRows
    .filter((row) => normalizeAssignedHost(row.assigned_host) !== localHost);
  const foreignAssignedRows = foreignAssignedAll.slice(0, 5);
  const foreignAssignedCount = foreignAssignedAll.length;
  return {
    migrationApplied: true,
    schemaParity: parity.status,
    schemaFindings: parity.findings,
    monitorCount: hasMonitorTable ? countMonitors(db) : 0,
    wakeCount: tableExists(db, "monitor_wakes") ? countMonitorWakes(db) : 0,
    deliveryCount: hasDeliveryTable ? countMonitorDeliveries(db) : 0,
    deliveryCounts: hasDeliveryTable
      ? countMonitorDeliveriesByStatus(db)
      : { attempted: 0, delivered: 0, failed: 0 },
    foreignAssignedHostCount: foreignAssignedCount,
    foreignAssignedHostSamples: foreignAssignedRows,
  };
}

function zeroMessageStoreStatus(): Omit<MessageStoreStatus, "migrationApplied" | "schemaParity" | "schemaFindings"> {
  return {
    messageCount: 0,
    messageCounts: {
      outbox: 0,
      pending: 0,
      claimed: 0,
      acked: 0,
      dead_letter: 0,
      delivery_failed: 0,
    },
    deliveryCount: 0,
    deliveryCounts: { attempted: 0, delivered: 0, failed: 0 },
    outboxCount: 0,
    outboxCounts: {
      pending: 0,
      in_flight: 0,
      forwarded: 0,
      indeterminate: 0,
      delivery_failed: 0,
    },
    pendingCounts: {
      directed_pending: 0,
      directed_claimed: 0,
      scope_pending: 0,
      dead_letter: 0,
      delivery_failed: 0,
      outbox_pending: 0,
    },
    malformed: [],
  };
}

function evaluateMessages(
  db: StateDriverDatabase,
  plan: MigrationPlan,
): MessageStoreStatus {
  const migrationApplied = plan.applied.some((m) => m.id === MESSAGE_MIGRATION_ID);
  const zero = zeroMessageStoreStatus();
  if (!migrationApplied) {
    return {
      migrationApplied: false,
      schemaParity: "absent",
      schemaFindings: [],
      ...zero,
    };
  }
  const parity = checkMessageSchema(db);
  const hasMessages = tableExists(db, "messages");
  const hasDeliveries = tableExists(db, "message_deliveries");
  const hasOutbox = tableExists(db, "outbox");
  return {
    migrationApplied: true,
    schemaParity: parity.status,
    schemaFindings: parity.findings,
    messageCount: hasMessages ? countMessages(db) : 0,
    messageCounts: hasMessages ? countMessagesByStatus(db) : zero.messageCounts,
    deliveryCount: hasDeliveries ? countMessageDeliveries(db) : 0,
    deliveryCounts: hasDeliveries ? countMessageDeliveriesByStatus(db) : zero.deliveryCounts,
    outboxCount: hasOutbox ? countMessageOutboxRows(db) : 0,
    outboxCounts: hasOutbox ? countMessageOutboxByStatus(db) : zero.outboxCounts,
    pendingCounts: hasMessages && hasOutbox ? countPendingMessages(db) : zero.pendingCounts,
    // Row-level receipt validation is intentionally reserved for explicit
    // doctor runs; ordinary health remains bounded regardless of ledger size.
    malformed: [],
  };
}

function evaluateRunnerLiveBindings(
  db: StateDriverDatabase,
  plan: MigrationPlan,
): RunnerLiveBindingsStatus {
  const migrationApplied = plan.applied.some((m) => m.id === RUNNER_LIVE_BINDINGS_MIGRATION_ID);
  const zeroCounts: RunnerLiveBindingStatusCounts = { active: 0, closed: 0 };
  if (!migrationApplied) {
    return {
      migrationApplied: false,
      schemaParity: "absent",
      schemaFindings: [],
      rowCount: 0,
      counts: zeroCounts,
    };
  }
  const parity = checkRunnerLiveBindingSchema(db);
  const hasTable = tableExists(db, "runner_live_bindings");
  return {
    migrationApplied: true,
    schemaParity: parity.status,
    schemaFindings: parity.findings,
    rowCount: hasTable ? countRunnerLiveBindings(db) : 0,
    counts: hasTable ? countRunnerLiveBindingsByStatus(db) : zeroCounts,
  };
}

function evaluateLeases(
  db: StateDriverDatabase,
  plan: MigrationPlan,
): LeaseStoreStatus {
  const migrationApplied = plan.applied.some((m) => m.id === LEASE_MIGRATION_ID);
  if (!migrationApplied) {
    return {
      migrationApplied: false,
      schemaParity: "absent",
      schemaFindings: [],
      rowCount: 0,
      expiredCount: 0,
      malformed: [],
    };
  }
  const parity = checkLeaseSchema(db);
  const hasTable = tableExists(db, "leases");
  return {
    migrationApplied: true,
    schemaParity: parity.status,
    schemaFindings: parity.findings,
    rowCount: hasTable ? countLeases(db) : 0,
    expiredCount: hasTable ? countExpiredLeases(db) : 0,
    malformed: [],
  };
}

function evaluateTasks(
  db: StateDriverDatabase,
  plan: MigrationPlan,
): TaskLifecycleStatus {
  const migrationApplied = plan.applied.some((m) => m.id === TASK_LIFECYCLE_MIGRATION_ID);
  const zeroCounts: Record<TaskInstallStatus, number> = {
    active: 0,
    paused: 0,
    retired: 0,
    failed_needs_attention: 0,
  };
  if (!migrationApplied) {
    return {
      migrationApplied: false,
      schemaParity: "absent",
      schemaFindings: [],
      installCount: 0,
      taskRunCount: 0,
      installCounts: zeroCounts,
    };
  }
  const parity = checkTaskSchema(db);
  return {
    migrationApplied: true,
    schemaParity: parity.status,
    schemaFindings: parity.findings,
    installCount: tableExists(db, "task_installs") ? countTaskInstalls(db) : 0,
    taskRunCount: tableExists(db, "task_runs") ? countTaskRuns(db) : 0,
    installCounts: tableExists(db, "task_installs") ? countTaskInstallsByStatus(db) : zeroCounts,
  };
}

function evaluateOrchestrationLedger(
  db: StateDriverDatabase,
  plan: MigrationPlan,
): OrchestrationLedgerStatus {
  const migrationApplied = plan.applied.some(
    (m) => m.id === ORCHESTRATION_LEDGER_MIGRATION_ID,
  );

  if (!migrationApplied) {
    return {
      migrationApplied: false,
      schemaParity: "absent",
      schemaFindings: [],
      expiredLocks: [],
      expiredLocksTotal: 0,
      expiredLocksTruncated: false,
      staleSources: [],
      staleSourcesTotal: 0,
      staleSourcesTruncated: false,
    };
  }

  const parity = checkOrchestrationLedgerSchema(db);
  const locks = tableExists(db, "locks")
    ? listExpiredLocks(db)
    : { rows: [], total: 0, truncated: false };
  const sources = tableExists(db, "source_freshness")
    ? listStaleSources(db)
    : { rows: [], total: 0, truncated: false };

  return {
    migrationApplied: true,
    schemaParity: parity.status,
    schemaFindings: parity.findings,
    expiredLocks: locks.rows,
    expiredLocksTotal: locks.total,
    expiredLocksTruncated: locks.truncated,
    staleSources: sources.rows,
    staleSourcesTotal: sources.total,
    staleSourcesTruncated: sources.truncated,
  };
}

async function buildHealthReport(
  opened: OpenedState,
  migrations: readonly StateMigration[],
): Promise<StateHealthReport> {
  const plan = computeMigrationPlan(opened.db, migrations, opened.driver.id);
  const consistency = checkMigrationConsistency(opened.db, migrations);
  const dirMode = opened.paths.stateDir
    ? await reportDirMode(opened.paths.stateDir)
    : ({
        path: "",
        mode: null,
        modeOctal: null,
        expectedOctal: STATE_DIR_MODE.toString(8).padStart(3, "0"),
        status: "missing",
      } satisfies FileModeReport);
  const fileMode = await ensureFileMode(opened.paths.dbPath);
  const orchestrationLedger = evaluateOrchestrationLedger(opened.db, plan);
  const runIndex = evaluateRunIndex(opened.db, plan);
  const activityIndex = evaluateActivityIndex(opened.db, plan);
  const activityMarks = evaluateActivityMarks(opened.db, plan);
  const skillProposals = evaluateSkillProposals(opened.db, plan);
  const skillContent = evaluateSkillContent(opened.db, plan);
  const memoryContent = evaluateMemoryContent(opened.db, plan);
  const fleetConvergence = evaluateFleetConvergence(opened.db, plan);
  const monitors = evaluateMonitors(opened.db, plan);
  const messages = evaluateMessages(opened.db, plan);
  const runnerLiveBindings = evaluateRunnerLiveBindings(opened.db, plan);
  const leases = evaluateLeases(opened.db, plan);
  const tasks = evaluateTasks(opened.db, plan);

  const expectedOk =
    plan.pending.length === 0 &&
    consistency.status !== "drift" &&
    (dirMode.status === "enforced" || dirMode.status === "platform-skipped") &&
    (fileMode.status === "enforced" || fileMode.status === "platform-skipped") &&
    orchestrationLedger.schemaParity !== "drift" &&
    runIndex.schemaParity !== "drift" &&
    activityIndex.schemaParity !== "drift" &&
    activityIndex.malformed.length === 0 &&
    activityMarks.schemaParity !== "drift" &&
    activityMarks.malformed === 0 &&
    skillProposals.schemaParity !== "drift" &&
    skillProposals.malformed.length === 0 &&
    skillContent.schemaParity !== "drift" &&
    skillContent.malformed.length === 0 &&
    memoryContent.schemaParity !== "drift" &&
    memoryContent.malformed.length === 0 &&
    fleetConvergence.schemaParity !== "drift" &&
    monitors.schemaParity !== "drift" &&
    messages.schemaParity !== "drift" &&
    messages.malformed.length === 0 &&
    runnerLiveBindings.schemaParity !== "drift" &&
    leases.schemaParity !== "drift" &&
    leases.malformed.length === 0 &&
    tasks.schemaParity !== "drift";

  return {
    driver: opened.driver.id,
    driverMinNode: opened.driver.minNode,
    nodeVersion: process.versions.node,
    paths: {
      stateDir: opened.paths.stateDir,
      dbPath: opened.paths.dbPath,
      source: opened.paths.source,
      dirSource: opened.paths.dirSource,
      envVars: { home: "CALYX_STATE_HOME", db: "CALYX_STATE_DB" },
    },
    journalMode: opened.journalMode,
    foreignKeysEnabled: opened.foreignKeysEnabled,
    busyTimeoutMs: opened.busyTimeoutMs,
    schemaVersion: plan.current,
    targetSchemaVersion: plan.target,
    pendingMigrations: plan.pending.length,
    appliedMigrations: plan.applied,
    lastMigration: plan.applied.length === 0 ? null : plan.applied[plan.applied.length - 1]!,
    directoryMode: dirMode,
    databaseMode: fileMode,
    migrationConsistency: consistency,
    orchestrationLedger,
    runIndex,
    activityIndex,
    activityMarks,
    skillProposals,
    skillContent,
    memoryContent,
    fleetConvergence,
    monitors,
    messages,
    runnerLiveBindings,
    leases,
    tasks,
    ok: expectedOk,
  };
}

export async function reportStateHealth(opts: ConductOptions = {}): Promise<StateHealthReport> {
  const opened = await openStateStore({ ...(opts.storeOptions ?? {}), ...(opts.driver ? { driver: opts.driver } : {}) });
  try {
    return await buildHealthReport(opened, opts.migrations ?? STATE_MIGRATIONS);
  } finally {
    opened.db.close();
  }
}

export async function runStateDoctor(opts: ConductOptions = {}): Promise<StateDoctorReport> {
  const opened = await openStateStore({ ...(opts.storeOptions ?? {}), ...(opts.driver ? { driver: opts.driver } : {}) });
  try {
    const health = await buildHealthReport(opened, opts.migrations ?? STATE_MIGRATIONS);
    if (health.messages.schemaParity === "ok") {
      health.messages.malformed = listMalformedMessageReceiptSnapshots(opened.db);
    }
    if (health.leases.schemaParity === "ok") {
      health.leases.malformed = listMalformedLeaseMetadata(opened.db);
    }
    const eventLogProjection = await verifyEventLogProjection(opened.db, {
      ...(opts.journalPath === undefined ? {} : { journalPath: opts.journalPath }),
      ...(opts.journalScanLimit === undefined ? {} : { scanLimit: opts.journalScanLimit }),
    });
    const eventLogQuarantine = await listEventLogQuarantineRecords(opened.paths.stateDir);
    if (health.activityMarks.migrationApplied) {
      const marks = doctorActivityMarks(opened.db);
      health.activityMarks = {
        migrationApplied: true,
        schemaParity: marks.schema.status,
        schemaFindings: marks.schema.findings,
        total: marks.total,
        active: marks.active,
        revoked: marks.revoked,
        malformed: marks.malformed,
        membership: marks.membership,
        doctorFindings: marks.findings,
      };
    }
    const findings: StateDoctorFinding[] = [];

    if (!isWalLike(health.journalMode)) {
      findings.push({
        code: "journal-mode",
        severity: "warn",
        message: `journal_mode is ${health.journalMode}; wave 1 expects WAL.`,
      });
    }
    if (!health.foreignKeysEnabled) {
      findings.push({
        code: "foreign-keys",
        severity: "warn",
        message: "foreign_keys pragma is OFF; wave 1 expects ON.",
      });
    }
    if (health.busyTimeoutMs < 5000) {
      findings.push({
        code: "busy-timeout",
        severity: "warn",
        message: `busy_timeout=${health.busyTimeoutMs}; wave 1 expects >=5000.`,
      });
    }
    if (health.pendingMigrations > 0) {
      findings.push({
        code: "pending-migrations",
        severity: "error",
        message: `${health.pendingMigrations} migration(s) pending; run \`calyx state migrate --plan\`, inspect the pending migrations, then run \`calyx state migrate --apply\`.`,
      });
    }
    if (health.migrationConsistency.status === "drift") {
      findings.push({
        code: "migration-drift",
        severity: "error",
        message:
          health.migrationConsistency.reason ?? "schema_migrations diverges from source migrations",
      });
    }
    if (health.migrationConsistency.status === "no-ledger") {
      findings.push({
        code: "no-ledger",
        severity: "info",
        message:
          "schema_migrations table not present; run `calyx state migrate --apply` to initialize.",
      });
    }
    if (health.directoryMode.status === "drifted") {
      findings.push({
        code: "directory-mode",
        severity: "warn",
        message: `state directory mode ${health.directoryMode.modeOctal} != ${health.directoryMode.expectedOctal}`,
      });
    } else if (health.directoryMode.status === "error") {
      findings.push({
        code: "directory-mode",
        severity: "warn",
        message: health.directoryMode.message ?? "directory mode could not be enforced",
      });
    } else if (health.directoryMode.status === "platform-skipped") {
      findings.push({
        code: "directory-mode",
        severity: "info",
        message:
          health.directoryMode.message ?? "directory mode enforcement skipped on this platform",
      });
    }
    if (health.databaseMode.status === "drifted") {
      findings.push({
        code: "database-mode",
        severity: "warn",
        message: `database file mode ${health.databaseMode.modeOctal} != ${health.databaseMode.expectedOctal}`,
      });
    } else if (health.databaseMode.status === "error") {
      findings.push({
        code: "database-mode",
        severity: "warn",
        message: health.databaseMode.message ?? "database mode could not be enforced",
      });
    } else if (health.databaseMode.status === "platform-skipped") {
      findings.push({
        code: "database-mode",
        severity: "info",
        message:
          health.databaseMode.message ?? "database file mode enforcement skipped on this platform",
      });
    }
    if (health.orchestrationLedger.schemaParity === "drift") {
      for (const f of health.orchestrationLedger.schemaFindings) {
        findings.push({
          code: "orchestration-ledger-schema",
          severity: "error",
          message: `${f.table}: ${f.detail}`,
        });
      }
    } else if (health.orchestrationLedger.schemaParity === "absent") {
      findings.push({
        code: "orchestration-ledger-absent",
        severity: "info",
        message:
          "orchestration ledger migration 0002 not applied; run `calyx state migrate --apply` to enable event_log/locks/source_freshness.",
      });
    }
    for (const lock of health.orchestrationLedger.expiredLocks) {
      findings.push({
        code: "orchestration-lock-expired",
        severity: "warn",
        message: `lock "${lock.lock_key}" held by "${lock.owner_id}" expired at ${lock.expires_at}`,
      });
    }
    if (health.orchestrationLedger.expiredLocksTruncated) {
      findings.push({
        code: "orchestration-lock-expired-truncated",
        severity: "info",
        message: `${health.orchestrationLedger.expiredLocksTotal} expired locks total; showing first ${health.orchestrationLedger.expiredLocks.length}.`,
      });
    }
    for (const source of health.orchestrationLedger.staleSources) {
      findings.push({
        code: "orchestration-source-stale",
        severity: "warn",
        message: `source ${source.source_kind}:${source.source_id} status=${source.status}${
          source.detail ? ` (${source.detail})` : ""
        }`,
      });
    }
    if (health.orchestrationLedger.staleSourcesTruncated) {
      findings.push({
        code: "orchestration-source-stale-truncated",
        severity: "info",
        message: `${health.orchestrationLedger.staleSourcesTotal} stale sources total; showing first ${health.orchestrationLedger.staleSources.length}.`,
      });
    }
    // `event_log` is a projection of the run-root stream journal. These
    // findings exist so replay divergence is discovered here, on the host
    // that holds the data, rather than by an upgrade that already depends
    // on it (POL-2090). None of them blocks except the two that mean the
    // scan itself cannot be trusted — quarantine and divergence are
    // reported, repaired, and never gated on an operator acknowledgement.
    if (eventLogQuarantine.total > 0) {
      const sample = eventLogQuarantine.entries
        .slice(0, 3)
        .map((e) => `${e.record.event_id} (${e.record.origin}, kept ${e.record.resolution === "kept-committed" ? "committed" : "journal"})`)
        .join(", ");
      findings.push({
        code: "orchestration-event-log-quarantined",
        severity: "warn",
        message:
          `${eventLogQuarantine.total} event_log row(s) were quarantined so ingest could continue`
          + `${sample ? ` (${sample})` : ""}. Both versions are preserved in ${eventLogQuarantine.dir}; `
          + "inspect with `calyx state event-log quarantine --json`.",
      });
    }
    if (eventLogQuarantine.unreadable > 0) {
      findings.push({
        code: "orchestration-event-log-quarantine-unreadable",
        severity: "warn",
        message: `${eventLogQuarantine.unreadable} file(s) in ${eventLogQuarantine.dir} did not parse as a quarantine record; the evidence they hold is not machine-readable.`,
      });
    }
    if (eventLogProjection.status === "scanned") {
      if (eventLogProjection.unclassified_rows > 0) {
        findings.push({
          code: "orchestration-event-log-unclassified-domain",
          severity: "error",
          message:
            `${eventLogProjection.unclassified_rows} event_log row(s) sit in undeclared domain(s) `
            + `${eventLogProjection.unclassified_domains.join(", ")}. A ledger writer was added without declaring whether its rows have a journal behind them, `
            + "so no rebuild can know which rows it may recreate. Declare the domain in JOURNAL_DERIVED_EVENT_DOMAINS or LEDGER_NATIVE_EVENT_DOMAINS.",
        });
      }
      if (eventLogProjection.truncated) {
        findings.push({
          code: "orchestration-event-log-scan-truncated",
          severity: "error",
          message:
            `journal scan stopped after ${eventLogProjection.scanned} line(s) of ${eventLogProjection.journal_path}; `
            + "a partial scan cannot distinguish a rebuildable gap from an unrecoverable orphan, so projection health is unproven.",
        });
      }
      if (eventLogProjection.divergent > 0) {
        const sample = eventLogProjection.divergent_samples
          .slice(0, 3)
          .map((d) => `${d.event_id} [${d.divergent_fields.join(",")}]`)
          .join(", ");
        findings.push({
          code: "orchestration-event-log-divergent",
          severity: "warn",
          message:
            `${eventLogProjection.divergent} event_log row(s) genuinely disagree with ${eventLogProjection.journal_path}`
            + `${sample ? ` (${sample})` : ""}. The journal is the authority; repair with `
            + "`calyx state event-log rebuild --apply`, which quarantines each displaced row.",
        });
      }
      if (eventLogProjection.missing > 0) {
        findings.push({
          code: "orchestration-event-log-gap",
          severity: "info",
          message:
            `${eventLogProjection.missing} journaled event(s) are absent from event_log and can be re-projected; `
            + "run `calyx state event-log rebuild --plan` to review, `--apply` to merge.",
        });
      }
      if (eventLogProjection.unparsable > 0) {
        findings.push({
          code: "orchestration-event-log-journal-unparsable",
          severity: "warn",
          message: `${eventLogProjection.unparsable} line(s) in ${eventLogProjection.journal_path} are not usable stream events; they cannot be projected or rebuilt.`,
        });
      }
      if (!eventLogProjection.journal_present && eventLogProjection.orphaned_rows > 0) {
        findings.push({
          code: "orchestration-event-log-journal-absent",
          severity: "warn",
          message:
            `no stream journal at ${eventLogProjection.journal_path}, so none of the ${eventLogProjection.orphaned_rows} journal-derived event_log row(s) is rebuildable here. `
            + "Rebuild is unavailable until the run root is reachable.",
        });
      }
    }
    if (health.runIndex.schemaParity === "drift") {
      for (const f of health.runIndex.schemaFindings) {
        findings.push({
          code: "run-index-schema",
          severity: "error",
          message: `${f.table}: ${f.detail}`,
        });
      }
    } else if (health.runIndex.schemaParity === "absent") {
      findings.push({
        code: "run-index-absent",
        severity: "info",
        message:
          "run index migration 0003 not applied; run `calyx state migrate --apply` to enable SQLite-backed run listing.",
      });
    }
    if (health.activityIndex.schemaParity === "drift") {
      for (const f of health.activityIndex.schemaFindings) {
        findings.push({
          code: "activity-index-schema",
          severity: "error",
          message: `${f.table}: ${f.detail}`,
        });
      }
    } else if (health.activityIndex.schemaParity === "absent") {
      findings.push({
        code: "activity-index-absent",
        severity: "info",
        message:
          "activity recall index migration 0013 not applied; run `calyx state migrate --apply` to enable the transcript-tailer store behind `calyx activity`.",
      });
    }
    for (const malformed of health.activityIndex.malformed) {
      findings.push({
        code: `activity-index-${malformed.code}`,
        severity: "error",
        message: malformed.detail,
      });
    }
    if (
      health.activityIndex.schemaParity === "ok" &&
      health.activityIndex.freshness.pending_sources > 0
    ) {
      findings.push({
        code: "activity-index-pending-sources",
        severity: "info",
        message: `${health.activityIndex.freshness.pending_sources} transcript source(s) are pending ingest (un-ingested tails or not-yet-backfilled history); the tailer pages through them on subsequent ticks (reads fall back to live-parse meanwhile).`,
      });
    }
    if (health.activityMarks.schemaParity === "drift") {
      for (const finding of health.activityMarks.schemaFindings) {
        findings.push({
          code: "activity-marks-schema",
          severity: "error",
          message: `${finding.table}: ${finding.detail}`,
        });
      }
    } else if (health.activityMarks.schemaParity === "absent") {
      findings.push({
        code: "activity-marks-absent",
        severity: "info",
        message:
          "activity marks migration 0035 not applied; run `calyx state migrate --apply` to enable authoritative attention marks.",
      });
    }
    for (const malformed of health.activityMarks.doctorFindings) {
      findings.push({
        code: `activity-marks-${malformed.code}`,
        severity: "error",
        message: malformed.detail,
      });
    }
    if (health.skillProposals.schemaParity === "drift") {
      for (const f of health.skillProposals.schemaFindings) {
        findings.push({
          code: "skill-proposals-schema",
          severity: "error",
          message: `${f.table}: ${f.detail}`,
        });
      }
    } else if (health.skillProposals.schemaParity === "absent") {
      findings.push({
        code: "skill-proposals-absent",
        severity: "info",
        message:
          "skill proposals migration 0004 not applied; run `calyx state migrate --apply` to enable `calyx skills propose` and `calyx skills proposals`.",
      });
    }
    for (const malformed of health.skillProposals.malformed) {
      findings.push({
        code: `skill-proposals-${malformed.code}`,
        severity: "error",
        message: malformed.detail,
      });
    }
    if (health.skillContent.schemaParity === "drift") {
      for (const f of health.skillContent.schemaFindings) {
        findings.push({
          code: "skill-content-schema",
          severity: "error",
          message: `${f.table}: ${f.detail}`,
        });
      }
    } else if (health.skillContent.schemaParity === "absent") {
      findings.push({
        code: "skill-content-absent",
        severity: "info",
        message:
          "skill content migration 0016 not applied; run `calyx state migrate --apply` to enable `calyx skills write` and `calyx skills delete`.",
      });
    }
    for (const malformed of health.skillContent.malformed) {
      findings.push({
        code: `skill-content-${malformed.code}`,
        severity: "error",
        message: malformed.detail,
      });
    }
    if (health.memoryContent.schemaParity === "drift") {
      for (const f of health.memoryContent.schemaFindings) {
        findings.push({
          code: "memory-content-schema",
          severity: "error",
          message: `${f.table}: ${f.detail}`,
        });
      }
    } else if (health.memoryContent.schemaParity === "absent") {
      findings.push({
        code: "memory-content-absent",
        severity: "info",
        message:
          "memory content migration 0018 not applied; run `calyx state migrate --apply` to enable `calyx memory write` and `calyx memory approve`.",
      });
    }
    for (const malformed of health.memoryContent.malformed) {
      findings.push({
        code: `memory-content-${malformed.code}`,
        severity: "error",
        message: malformed.detail,
      });
    }
    if (health.fleetConvergence.schemaParity === "drift") {
      for (const f of health.fleetConvergence.schemaFindings) {
        findings.push({
          code: "fleet-convergence-schema",
          severity: "error",
          message: `${f.table}: ${f.detail}`,
        });
      }
    } else if (health.fleetConvergence.schemaParity === "absent") {
      findings.push({
        code: "fleet-convergence-absent",
        severity: "info",
        message:
          "fleet convergence migration 0005 not applied; run `calyx state migrate --apply` to enable `calyx fleet status`.",
      });
    }
    if (health.monitors.schemaParity === "drift") {
      for (const f of health.monitors.schemaFindings) {
        findings.push({
          code: "monitors-schema",
          severity: "error",
          message: `${f.table}: ${f.detail}`,
        });
      }
    } else if (health.monitors.schemaParity === "absent") {
      findings.push({
        code: "monitors-absent",
        severity: "info",
        message:
          "monitor migration 0007 not applied; run `calyx state migrate --apply` to enable monitor wake records.",
      });
    }
    if (health.monitors.foreignAssignedHostCount > 0) {
      const samples = health.monitors.foreignAssignedHostSamples
        .map((row) => `${row.monitor_id}->${row.assigned_host}`)
        .join(", ");
      findings.push({
        code: "monitors-foreign-assigned-host",
        severity: "error",
        message:
          `${health.monitors.foreignAssignedHostCount} active monitor row(s) are assigned to a non-local host and will not evaluate here`
          + `${samples ? ` (${samples})` : ""}. Cancel them in this store, then recreate with \`calyx monitor create --assigned-host <host> ...\` from any host or run the create command on the owning host.`,
      });
    }
    if (health.messages.schemaParity === "drift") {
      for (const f of health.messages.schemaFindings) {
        findings.push({
          code: "messages-schema",
          severity: "error",
          message: `${f.table}: ${f.detail}`,
        });
      }
    } else if (health.messages.schemaParity === "absent") {
      findings.push({
        code: "messages-absent",
        severity: "info",
        message:
          "message migration 0011 not applied; run `calyx state migrate --apply` to enable `calyx msg` correspondence rows.",
      });
    }
    for (const malformed of health.messages.malformed) {
      findings.push({
        code: `messages-${malformed.code}`,
        severity: "error",
        message: malformed.detail,
      });
    }
    if (health.runnerLiveBindings.schemaParity === "drift") {
      for (const f of health.runnerLiveBindings.schemaFindings) {
        findings.push({
          code: "runner-live-bindings-schema",
          severity: "error",
          message: `${f.table}: ${f.detail}`,
        });
      }
    } else if (health.runnerLiveBindings.schemaParity === "absent") {
      findings.push({
        code: "runner-live-bindings-absent",
        severity: "info",
        message:
          "runner live bindings migration 0010 not applied; run `calyx state migrate --apply` to enable live monitor delivery metadata.",
      });
    }
    if (health.leases.schemaParity === "drift") {
      for (const f of health.leases.schemaFindings) {
        findings.push({
          code: "leases-schema",
          severity: "error",
          message: `${f.table}: ${f.detail}`,
        });
      }
    } else if (health.leases.schemaParity === "absent") {
      findings.push({
        code: "leases-absent",
        severity: "info",
        message:
          "lease migration 0012 not applied; run `calyx state migrate --apply` to enable named-resource leases.",
      });
    }
    for (const malformed of health.leases.malformed) {
      findings.push({
        code: `leases-${malformed.code}`,
        severity: "error",
        message: malformed.detail,
      });
    }
    if (health.leases.expiredCount > 0) {
      findings.push({
        code: "leases-expired",
        severity: "warn",
        message: `${health.leases.expiredCount} lease(s) are expired; release or steal with provenance before relying on them.`,
      });
    }
    if (health.tasks.schemaParity === "drift") {
      for (const f of health.tasks.schemaFindings) {
        findings.push({
          code: "tasks-schema",
          severity: "error",
          message: `${f.table}: ${f.detail}`,
        });
      }
    } else if (health.tasks.schemaParity === "absent") {
      findings.push({
        code: "tasks-absent",
        severity: "info",
        message:
          "task lifecycle migration 0008 not applied; run `calyx state migrate --apply` to enable task installs and task-run records.",
      });
    } else {
      const installs = listTaskInstalls(opened.db, { status: "all", limit: 500 });
      for (const install of installs) {
        const loss = codexTaskRenderLossFinding(install.task, install.host, {
          install_id: install.install_id,
          manifest_path: install.manifest_path,
          subject: `installed codex_app task ${install.task_id}`,
        });
        if (!loss) {
          continue;
        }
        findings.push({
          code: "tasks-codex-render-loss",
          severity: "error",
          message: loss.message,
          task_id: install.task_id,
          install_id: install.install_id,
          manifest_path: install.manifest_path,
          ...(loss.receipt ? { receipt: loss.receipt } : {}),
        });
      }
      if (health.tasks.installCount > installs.length) {
        findings.push({
          code: "tasks-codex-render-loss-scan-truncated",
          severity: "error",
          message: `Codex render-loss doctor scan inspected only ${installs.length}/${health.tasks.installCount} task installs; health is unproven until every persisted task is scanned.`,
        });
      }
    }

    const blocking = findings.some((f) => f.severity === "error");
    const fullReport: StateDoctorReport = {
      ...health,
      findings,
      ok: !blocking,
      eventLogProjection,
      eventLogQuarantine,
    };
    if (opts.domains && opts.domains.length > 0) {
      const domains = buildDomainResults(opts.domains, fullReport);
      fullReport.domains = domains;
      const domainBlocking = domains.some((d) =>
        d.findings.some((f) => f.severity === "error"),
      );
      fullReport.ok = !domainBlocking;
    }
    return fullReport;
  } finally {
    opened.db.close();
  }
}

function buildDomainResults(
  requestedDomains: readonly string[],
  report: StateDoctorReport,
): StateDoctorDomainResult[] {
  const knownDomains = new Set<string>(STATE_DOCTOR_DOMAINS);
  const notApplicable = new Set<string>(STATE_DOCTOR_NOT_APPLICABLE_DOMAINS);
  // De-duplicate but preserve request order.
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of requestedDomains) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered.map((domain): StateDoctorDomainResult => {
    if (notApplicable.has(domain)) {
      return {
        domain,
        status: "not-applicable",
        findings: [],
        detail: `domain "${domain}" has no SQLite schema yet; doctor reports it explicitly rather than ignoring it.`,
      };
    }
    if (!knownDomains.has(domain)) {
      return {
        domain,
        status: "unknown-domain",
        findings: [
          {
            code: `unknown-domain-${domain}`,
            severity: "error",
            message: `unknown --domain "${domain}". Known: ${[...STATE_DOCTOR_DOMAINS, ...STATE_DOCTOR_NOT_APPLICABLE_DOMAINS].join(", ")}.`,
          },
        ],
        detail: `unknown domain; choose one of: ${[...STATE_DOCTOR_DOMAINS, ...STATE_DOCTOR_NOT_APPLICABLE_DOMAINS].join(", ")}.`,
      };
    }
    return filterDomain(report, domain as StateDoctorDomain);
  });
}

function filterDomain(
  report: StateDoctorReport,
  domain: StateDoctorDomain,
): StateDoctorDomainResult {
  switch (domain) {
    case "state": {
      // Baseline doctor: pragmas, modes, migrations consistency.
      const stateCodes = new Set<string>([
        "journal-mode",
        "foreign-keys",
        "busy-timeout",
        "pending-migrations",
        "migration-drift",
        "no-ledger",
        "directory-mode",
        "database-mode",
      ]);
      const findings = report.findings.filter((f) => stateCodes.has(f.code));
      const status = deriveDomainStatus(findings);
      return { domain, status, findings };
    }
    case "orchestration": {
      const findings = report.findings.filter(
        (f) => f.code.startsWith("orchestration-"),
      );
      // A blocking projection finding (an undeclared ledger writer, a
      // truncated scan) is drift even when the schema itself is intact —
      // it means the rebuild boundary can no longer be trusted.
      const status: StateDoctorDomainResult["status"] =
        report.orchestrationLedger.schemaParity === "drift"
          ? "drift"
          : report.orchestrationLedger.schemaParity === "absent"
            ? "absent"
            : findings.some((f) => f.severity === "error")
              ? "drift"
              : "ok";
      return { domain, status, findings };
    }
    case "run_index": {
      const status: StateDoctorDomainResult["status"] =
        report.runIndex.schemaParity === "drift"
          ? "drift"
          : report.runIndex.schemaParity === "absent"
            ? "absent"
            : "ok";
      const findings = report.findings.filter((f) =>
        f.code.startsWith("run-index"),
      );
      return { domain, status, findings };
    }
    case "activity": {
      const blocking = report.activityIndex.malformed.length > 0;
      const status: StateDoctorDomainResult["status"] = blocking
        ? "drift"
        : report.activityIndex.schemaParity === "drift"
          ? "drift"
          : report.activityIndex.schemaParity === "absent"
            ? "absent"
            : "ok";
      const findings = report.findings.filter((f) =>
        f.code.startsWith("activity-index-"),
      );
      return { domain, status, findings };
    }
    case "marks": {
      const status: StateDoctorDomainResult["status"] =
        report.activityMarks.malformed > 0 || report.activityMarks.schemaParity === "drift"
          ? "drift"
          : report.activityMarks.schemaParity === "absent"
            ? "absent"
            : "ok";
      const findings = report.findings.filter((finding) =>
        finding.code.startsWith("activity-marks-"),
      );
      return { domain, status, findings };
    }
    case "skill_proposals": {
      const blocking = report.skillProposals.malformed.length > 0;
      const status: StateDoctorDomainResult["status"] = blocking
        ? "drift"
        : report.skillProposals.schemaParity === "drift"
          ? "drift"
          : report.skillProposals.schemaParity === "absent"
            ? "absent"
            : "ok";
      const findings = report.findings.filter((f) =>
        f.code.startsWith("skill-proposals-"),
      );
      return { domain, status, findings };
    }
    case "skill_content": {
      const blocking = report.skillContent.malformed.length > 0;
      const status: StateDoctorDomainResult["status"] = blocking
        ? "drift"
        : report.skillContent.schemaParity === "drift"
          ? "drift"
          : report.skillContent.schemaParity === "absent"
            ? "absent"
            : "ok";
      const findings = report.findings.filter((f) =>
        f.code.startsWith("skill-content-"),
      );
      return { domain, status, findings };
    }
    case "memory_content": {
      const blocking = report.memoryContent.malformed.length > 0;
      const status: StateDoctorDomainResult["status"] = blocking
        ? "drift"
        : report.memoryContent.schemaParity === "drift"
          ? "drift"
          : report.memoryContent.schemaParity === "absent"
            ? "absent"
            : "ok";
      const findings = report.findings.filter((f) =>
        f.code.startsWith("memory-content-"),
      );
      return { domain, status, findings };
    }
    case "fleet_convergence": {
      const status: StateDoctorDomainResult["status"] =
        report.fleetConvergence.schemaParity === "drift"
          ? "drift"
          : report.fleetConvergence.schemaParity === "absent"
            ? "absent"
            : "ok";
      const findings = report.findings.filter((f) =>
        f.code.startsWith("fleet-convergence-"),
      );
      return { domain, status, findings };
    }
    case "monitors": {
      const status: StateDoctorDomainResult["status"] =
        report.monitors.schemaParity === "drift"
          ? "drift"
          : report.monitors.schemaParity === "absent"
            ? "absent"
            : "ok";
      const findings = report.findings.filter((f) =>
        f.code.startsWith("monitors-"),
      );
      return { domain, status, findings };
    }
    case "messages": {
      const blocking = report.messages.malformed.length > 0;
      const status: StateDoctorDomainResult["status"] =
        blocking
          ? "drift"
          : report.messages.schemaParity === "drift"
          ? "drift"
          : report.messages.schemaParity === "absent"
            ? "absent"
            : "ok";
      const findings = report.findings.filter((f) =>
        f.code.startsWith("messages-"),
      );
      return { domain, status, findings };
    }
    case "runner_live_bindings": {
      const status: StateDoctorDomainResult["status"] =
        report.runnerLiveBindings.schemaParity === "drift"
          ? "drift"
          : report.runnerLiveBindings.schemaParity === "absent"
            ? "absent"
            : "ok";
      const findings = report.findings.filter((f) =>
        f.code.startsWith("runner-live-bindings-"),
      );
      return { domain, status, findings };
    }
    case "leases": {
      const blocking = report.leases.malformed.length > 0;
      const status: StateDoctorDomainResult["status"] =
        blocking
          ? "drift"
          : report.leases.schemaParity === "drift"
          ? "drift"
          : report.leases.schemaParity === "absent"
            ? "absent"
            : "ok";
      const findings = report.findings.filter((f) =>
        f.code.startsWith("leases-"),
      );
      return { domain, status, findings };
    }
    case "tasks": {
      const schemaStatus: StateDoctorDomainResult["status"] =
        report.tasks.schemaParity === "drift"
          ? "drift"
          : report.tasks.schemaParity === "absent"
            ? "absent"
            : "ok";
      const findings = report.findings.filter((f) =>
        f.code.startsWith("tasks-"),
      );
      const status = schemaStatus === "ok" ? deriveDomainStatus(findings) : schemaStatus;
      return { domain, status, findings };
    }
  }
}

function deriveDomainStatus(
  findings: readonly StateDoctorFinding[],
): StateDoctorDomainResult["status"] {
  if (findings.some((f) => f.severity === "error")) return "drift";
  return "ok";
}

function isWalLike(mode: string): boolean {
  const value = mode.toLowerCase();
  return value === "wal" || value === "memory";
}

export { StateDriverError };
