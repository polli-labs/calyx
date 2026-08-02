import { createReadStream } from "node:fs";
import { chmod, mkdir, open as openFile, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { isAbsolute, join, resolve } from "node:path";

import { canonicalizeJcs } from "./canonical-json";
import type { StateDriverDatabase, StateDriverModule } from "./driver";
import { loadStateDriver } from "./driver";
import { OrchestrationLedgerSink, type SinkStreamEvent } from "./event-log-sink";
import {
  appendOrchestrationEvent,
  OrchestrationEventIdentityConflictError,
  type AppendEventInput,
} from "./orchestration-ledger";
import {
  assertStatePathAllowedForTests,
  resolveStatePaths,
  type ResolvedStatePaths,
  type ResolveStatePathsOptions,
} from "./paths";

/**
 * `event_log` is a PROJECTION, not a system of record.
 *
 * The authority for run/control/monitor events is the run-root stream
 * journal (`<runsRoot>/events.index.jsonl`, itself the durable receipt of
 * `<runsRoot>/events.authority.sqlite3`). `OrchestrationLedgerSink` mirrors
 * those events into `event_log`. Treating that mirror as an unrebuildable
 * append-only log is what made a single divergent row terminal for
 * `calyx self upgrade` (POL-2090): the ledger had no repair surface.
 *
 * This module gives the projection the two properties `run_index` already
 * has — it is rebuildable, and a row it cannot accept is set aside rather
 * than fatal — plus the honest boundary of what a rebuild can and cannot
 * restore.
 *
 * ## The rebuild boundary
 *
 * `event_log` has two classes of writer and the difference is not cosmetic:
 *
 *   - **journal-derived** rows arrive through `RunStore.appendStreamEvent`
 *     and are durably journaled before the sink ever sees them. Losing the
 *     ledger row loses nothing: it can be re-projected from the journal.
 *   - **ledger-native** rows are written straight to `event_log` by
 *     `DaemonLedger` (`packages/run-service/src/daemon-ledger.ts`). There is
 *     no journal behind them. **The SQLite row is the only durable copy.**
 *
 * A rebuild that truncated and re-projected would therefore destroy the
 * Symphony daemon's claim/launch/terminal/handoff history. So the rebuild
 * here is a **merge, never a replace** — it inserts what the journal has and
 * the ledger lacks, repairs rows that genuinely disagree, and touches
 * nothing else. {@link EventLogRebuildResult.not_restorable} states in
 * words what the operation cannot recover, so a green rebuild is never
 * mistaken for a complete one.
 *
 * A domain in neither class is `unclassified`: a new ledger writer appeared
 * without declaring its provenance. That is a blocking doctor finding, and
 * the rebuild refuses to guess — an undeclared writer is exactly how a
 * "rebuild" silently eats data.
 */

/** Domains projected from the run-root stream journal. Rebuildable. */
export const JOURNAL_DERIVED_EVENT_DOMAINS = ["run", "control", "monitor"] as const;

/**
 * Domains written directly into `event_log` with no journal behind them.
 * `calyx.symphony` rows come from `DaemonLedger`; the row *is* the record.
 * A rebuild preserves these and can never recreate them.
 */
export const LEDGER_NATIVE_EVENT_DOMAINS = ["calyx.symphony"] as const;

export type EventLogProvenance = "journal-derived" | "ledger-native" | "unclassified";

export function classifyEventLogDomain(domain: string): EventLogProvenance {
  if ((JOURNAL_DERIVED_EVENT_DOMAINS as readonly string[]).includes(domain)) {
    return "journal-derived";
  }
  if ((LEDGER_NATIVE_EVENT_DOMAINS as readonly string[]).includes(domain)) {
    return "ledger-native";
  }
  return "unclassified";
}

export const CALYX_RUNS_ROOT_ENV = "CALYX_RUNS_ROOT";
export const EVENT_JOURNAL_FILENAME = "events.index.jsonl";
export const DEFAULT_RUNS_ROOT_SUBPATH = ".calyx/runs";

export interface ResolveEventJournalPathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Explicit runs root; wins over env and the default. */
  runsRoot?: string;
}

/**
 * Resolve the run-root stream journal.
 *
 * This mirrors `defaultRunsRoot()` in `@polli-labs/calyx-run-service`, which
 * core cannot import (run-service depends on core; the reverse is a cycle —
 * the same reason `event-log-sink.ts` re-declares the stream-event shape).
 * `packages/cli/src/__tests__/state-event-log-command.test.ts` pins the two
 * resolutions to each other so the duplication cannot drift silently.
 */
export function resolveEventJournalPath(
  options: ResolveEventJournalPathOptions = {},
): string {
  const env = options.env ?? process.env;
  const explicit = options.runsRoot?.trim();
  if (explicit) {
    return join(isAbsolute(explicit) ? explicit : resolve(explicit), EVENT_JOURNAL_FILENAME);
  }
  const fromEnv = env[CALYX_RUNS_ROOT_ENV]?.trim();
  if (fromEnv) {
    return join(resolve(fromEnv), EVENT_JOURNAL_FILENAME);
  }
  return join(resolve(options.homeDir ?? homedir(), DEFAULT_RUNS_ROOT_SUBPATH), EVENT_JOURNAL_FILENAME);
}

// ── Quarantine ────────────────────────────────────────────────────────

export const EVENT_LOG_QUARANTINE_SCHEMA_VERSION = "calyx.event-log-quarantine/v1";

/** Directory mode matches the state directory; records can name run ids. */
const QUARANTINE_DIR_MODE = 0o700;
const QUARANTINE_FILE_MODE = 0o600;

/** One version of a contested event, captured whole so nothing is dropped. */
export interface EventLogQuarantineSide {
  /** Canonical JCS of the full event body. The whole payload, not a digest. */
  payload_json: string;
  event_type: string;
  cursor: string;
  occurred_at: string;
  /** Provenance stamp of the writer that produced this version. */
  source: string | null;
  host: string | null;
  agent_id: string | null;
  /**
   * Ledger placement columns. Present for a side read out of `event_log`;
   * absent for a side that is still a journal event, because placement is
   * derived by the sink's projection and this module never re-derives it.
   */
  domain?: string;
  aggregate_type?: string;
  aggregate_id?: string;
}

export interface EventLogQuarantineFieldDiff {
  field: string;
  committed: string | null;
  incoming: string | null;
}

/**
 * The durable record of a row set aside so ingest could continue.
 *
 * Deliberately **not** a SQLite table. The ledger is the thing being
 * repaired: a quarantine surface that lives inside it cannot record a
 * failure whose cause is that the ledger is locked, corrupt, or at a
 * migration the writing host does not have. The measured fleet at the time
 * of POL-2090 ran four hosts on four schema versions — a quarantine that
 * needed its own migration would have been unavailable on the one host that
 * needed it. A JSON sidecar next to `calyx.db` has neither dependency and
 * matches the durable-JSON receipts the repo already writes.
 *
 * There is no `acknowledged` field, by design. Quarantine auto-handles and
 * continues; an acknowledgement gate would reintroduce the stall this
 * exists to remove. Visibility comes from `calyx state doctor` (a `warn`,
 * never a blocker) and `calyx state event-log quarantine`.
 */
export interface EventLogQuarantineRecord {
  schema_version: typeof EVENT_LOG_QUARANTINE_SCHEMA_VERSION;
  /** Identity of this quarantine record. */
  quarantine_id: string;
  /** The contested `event_id` — the key both versions claim. */
  event_id: string;
  quarantined_at: string;
  reason: "identity-conflict" | "unparsable-payload";
  /** Which path set the row aside. */
  origin: "ingest" | "rebuild";
  /** Host that performed the quarantine. */
  host: string | null;
  /** The version that was already committed under `event_id`. */
  committed: EventLogQuarantineSide | null;
  /**
   * The version that lost. On the rebuild path the journal is authority, so
   * `committed` is displaced and this holds the journal's version *after* it
   * was installed — `resolution` says which one now lives in `event_log`.
   */
  incoming: EventLogQuarantineSide | null;
  /** Which version `event_log` holds after the quarantine. */
  resolution: "kept-committed" | "kept-incoming";
  /** Field-by-field divergence between the two versions. */
  divergent_fields: EventLogQuarantineFieldDiff[];
  /** Underlying error / explanation. */
  detail: string;
}

export function eventLogQuarantineDir(stateDir: string): string {
  return join(stateDir, "quarantine", "event-log");
}

function quarantineFilename(record: EventLogQuarantineRecord): string {
  const stamp = record.quarantined_at.replace(/[:.]/gu, "-");
  const safeEventId = record.event_id.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120);
  return `${stamp}-${safeEventId}-${record.quarantine_id.slice(0, 8)}.json`;
}

/**
 * The fields both sides always carry. Ledger placement (`domain`,
 * `aggregate_*`) is deliberately excluded: it is derived from the payload by
 * the sink, so a payload difference already subsumes it, and a journal-side
 * value would be a guess.
 */
const QUARANTINE_SIDE_FIELDS = [
  "event_type",
  "cursor",
  "occurred_at",
  "source",
  "host",
  "agent_id",
  "payload_json",
] as const;

export function diffQuarantineSides(
  committed: EventLogQuarantineSide | null,
  incoming: EventLogQuarantineSide | null,
): EventLogQuarantineFieldDiff[] {
  const diffs: EventLogQuarantineFieldDiff[] = [];
  for (const field of QUARANTINE_SIDE_FIELDS) {
    const a = committed ? committed[field] : null;
    const b = incoming ? incoming[field] : null;
    if (a !== b) diffs.push({ field, committed: a, incoming: b });
  }
  return diffs;
}

/**
 * Persist a quarantine record. Write-then-chmod so the file is never
 * world-readable for long, and never overwrite: each quarantine is its own
 * file so a repeated conflict leaves a trail rather than one survivor.
 */
/** fsync a directory so a rename into it survives a crash. */
export async function syncEventLogQuarantineDirectory(directoryPath: string): Promise<void> {
  const handle = await openFile(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Publish a quarantine record durably, following the repo's established
 * protocol (exclusive temp -> write -> fsync file -> atomic rename -> fsync
 * directory).
 *
 * This is not defensive polish. `rebuildEventLogProjection` writes this record
 * and then **deletes the displaced committed row**, so the sidecar is the sole
 * surviving copy of a version the repair is about to destroy. A plain
 * `writeFile` leaves that copy in page cache: a crash between write and
 * writeback loses the evidence *after* the destructive step has advanced. Any
 * failure here must therefore throw, never be swallowed — the caller may not
 * treat the row as preserved unless this resolves.
 */
export async function writeEventLogQuarantineRecord(
  stateDir: string,
  record: EventLogQuarantineRecord,
  options: {
    syncDirectory?: ((directoryPath: string) => Promise<void>) | undefined;
  } = {},
): Promise<string> {
  const dir = eventLogQuarantineDir(stateDir);
  await mkdir(dir, { recursive: true, mode: QUARANTINE_DIR_MODE });
  const syncDirectory = options.syncDirectory ?? syncEventLogQuarantineDirectory;
  const path = join(dir, quarantineFilename(record));
  const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`;

  // `wx` is exclusive: a colliding temp name fails rather than clobbering a
  // concurrent writer's in-flight evidence.
  const handle = await openFile(temporaryPath, "wx", QUARANTINE_FILE_MODE);
  let preparationError: unknown;
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    preparationError = error;
  } finally {
    await handle.close();
  }
  if (preparationError) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw preparationError;
  }

  try {
    await chmod(temporaryPath, QUARANTINE_FILE_MODE);
  } catch {
    // Platforms without POSIX modes; the record itself is what matters.
  }

  try {
    await rename(temporaryPath, path);
    // Sync the whole lineage, not just the leaf. The recursive mkdir above may
    // also have created `<stateDir>/quarantine` and `<stateDir>/quarantine/
    // event-log`; an unsynced parent means a crash can lose the entire subtree
    // — record included — after rebuild has already deleted the displaced row.
    //
    // Done on every attempt, not only on first use. A retry that observes the
    // directories already present cannot know whether the earlier fsync that
    // would have made them durable actually completed, so skipping the sync
    // because the entry is visible is exactly the window this closes. Same
    // reasoning as messages.ts:1861-1865.
    for (const directory of quarantineDirectoryLineage(stateDir)) {
      await syncDirectory(directory);
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return path;
}

/** Leaf-first: the quarantine dir, its parent, and the state dir itself. */
function quarantineDirectoryLineage(stateDir: string): string[] {
  const leaf = eventLogQuarantineDir(stateDir);
  return [leaf, join(stateDir, "quarantine"), stateDir];
}

export interface EventLogQuarantineEntry {
  path: string;
  record: EventLogQuarantineRecord;
}

export interface EventLogQuarantineInventory {
  dir: string;
  /** Total quarantine records on disk. */
  total: number;
  /** Files present that did not parse as a quarantine record. */
  unreadable: number;
  /** Bounded sample, newest first. */
  entries: EventLogQuarantineEntry[];
  truncated: boolean;
}

export const EVENT_LOG_QUARANTINE_LIST_DEFAULT_LIMIT = 20;

export async function listEventLogQuarantineRecords(
  stateDir: string,
  options: { limit?: number } = {},
): Promise<EventLogQuarantineInventory> {
  const dir = eventLogQuarantineDir(stateDir);
  const limit = Number.isFinite(options.limit) && (options.limit ?? 0) >= 0
    ? Math.floor(options.limit as number)
    : EVENT_LOG_QUARANTINE_LIST_DEFAULT_LIMIT;
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { dir, total: 0, unreadable: 0, entries: [], truncated: false };
    }
    throw err;
  }
  // Filenames lead with the ISO timestamp, so lexical descending is newest first.
  names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const entries: EventLogQuarantineEntry[] = [];
  let unreadable = 0;
  let total = 0;
  for (const name of names) {
    const path = join(dir, name);
    let record: EventLogQuarantineRecord;
    try {
      record = JSON.parse(await readFile(path, "utf8")) as EventLogQuarantineRecord;
    } catch {
      unreadable += 1;
      continue;
    }
    if (record?.schema_version !== EVENT_LOG_QUARANTINE_SCHEMA_VERSION) {
      unreadable += 1;
      continue;
    }
    total += 1;
    if (entries.length < limit) entries.push({ path, record });
  }
  return { dir, total, unreadable, entries, truncated: total > entries.length };
}

// ── Quarantining append (the ingest boundary) ─────────────────────────

export type QuarantiningAppendOutcome =
  | { status: "appended"; inserted: boolean }
  | { status: "quarantined"; record: EventLogQuarantineRecord; path: string };

export interface QuarantiningAppendOptions {
  host?: string | undefined;
  now?: () => string;
  newId?: () => string;
}

/**
 * `appendOrchestrationEvent`, but a genuine identity conflict sets the
 * incoming event aside instead of propagating a throw that fails the whole
 * ingest closed forever.
 *
 * **First-writer-wins at ingest.** The committed row stays; the rejected
 * version is preserved in full in the quarantine record. A live ingest has
 * no way to know which side is authoritative — the committed row may
 * already have been read — so it declines to choose and records both.
 * {@link rebuildEventLogProjection} is the deliberate repair that *does*
 * know: there the journal is authority and the ledger row yields.
 *
 * No acknowledgement gate, by construction: the caller gets a
 * `quarantined` outcome and continues. Visibility is `calyx state doctor`
 * and `calyx state event-log quarantine`.
 */
export async function appendOrchestrationEventWithQuarantine(
  db: StateDriverDatabase,
  stateDir: string,
  input: AppendEventInput,
  options: QuarantiningAppendOptions = {},
): Promise<QuarantiningAppendOutcome> {
  try {
    const result = appendOrchestrationEvent(db, input);
    return { status: "appended", inserted: result.inserted };
  } catch (err) {
    if (!(err instanceof OrchestrationEventIdentityConflictError)) throw err;
    const now = options.now ?? (() => new Date().toISOString());
    const newId = options.newId ?? (() => globalThis.crypto.randomUUID());
    const committed = db
      .prepare(
        `SELECT domain, aggregate_type, aggregate_id, event_type, cursor, occurred_at,
                host, agent_id, source, payload_json
         FROM event_log WHERE event_id = ?`,
      )
      .get(input.event_id) as CommittedRow | undefined;

    let incomingPayload: string;
    let reason: EventLogQuarantineRecord["reason"] = "identity-conflict";
    try {
      incomingPayload = canonicalizeJcs(input.payload ?? null);
    } catch {
      incomingPayload = "";
      reason = "unparsable-payload";
    }
    const incoming: EventLogQuarantineSide = {
      payload_json: incomingPayload,
      event_type: input.event_type,
      cursor: input.cursor,
      occurred_at: input.occurred_at,
      source: input.source ?? null,
      // Exactly what the rejected append carried. The host that performed
      // the quarantine is `record.host`; conflating the two would invent a
      // divergence that the append never had.
      host: input.host ?? null,
      agent_id: input.agent_id ?? null,
      domain: input.domain,
      aggregate_type: input.aggregate_type,
      aggregate_id: input.aggregate_id,
    };
    const committedSide = committed ? rowToSide(committed) : null;
    const record: EventLogQuarantineRecord = {
      schema_version: EVENT_LOG_QUARANTINE_SCHEMA_VERSION,
      quarantine_id: newId(),
      event_id: input.event_id,
      quarantined_at: now(),
      reason,
      origin: "ingest",
      host: options.host ?? null,
      committed: committedSide,
      incoming,
      resolution: "kept-committed",
      divergent_fields: diffQuarantineSides(committedSide, incoming),
      detail: err.message,
    };
    const path = await writeEventLogQuarantineRecord(stateDir, record);
    return { status: "quarantined", record, path };
  }
}

// ── Journal-vs-ledger verification ────────────────────────────────────

export const EVENT_LOG_PROJECTION_SCHEMA_VERSION = "calyx.event-log-projection/v1";

/**
 * Bounded scan cap. A scan that hits it reports `truncated` and doctor
 * raises a blocking finding — a partial scan is never proof of health.
 */
export const EVENT_LOG_JOURNAL_SCAN_LIMIT = 200_000;
export const EVENT_LOG_PROJECTION_SAMPLE_LIMIT = 20;

export interface EventLogJournalSample {
  event_id: string;
  domain: string;
  event_type: string;
  cursor: string;
  occurred_at: string;
}

export interface EventLogDivergenceSample extends EventLogJournalSample {
  /** Provenance stamp on the row `event_log` currently holds. */
  committed_source: string | null;
  /** Fields where the committed row and the journal event disagree. */
  divergent_fields: string[];
}

export interface EventLogProjectionReport {
  schema_version: typeof EVENT_LOG_PROJECTION_SCHEMA_VERSION;
  status: "scanned" | "skipped";
  /** Set when `status` is `skipped`. */
  skipped_reason?: string;
  journal_path: string;
  journal_present: boolean;
  /** Journal lines read. */
  scanned: number;
  /** Lines that were not JSON or carried no usable `event_id`. */
  unparsable: number;
  /** Journal lines the sink does not project (no run/control/monitor shape). */
  non_projectable: number;
  /** Repeated `event_id`s within the journal (exact-idempotent repairs). */
  duplicate_journal_ids: number;
  truncated: boolean;
  /** Journal events whose ledger row matches byte-for-byte. */
  matched: number;
  /** Journal events with no ledger row — the rebuildable gap. */
  missing: number;
  /** Journal events whose ledger row genuinely disagrees. */
  divergent: number;
  /** Ledger rows total. */
  ledger_rows: number;
  /** Ledger rows in ledger-native domains — never rebuildable. */
  ledger_native_rows: number;
  /** Ledger rows in journal-derived domains with no journal line. */
  orphaned_rows: number;
  /** Ledger rows whose domain is declared by neither provenance class. */
  unclassified_rows: number;
  unclassified_domains: string[];
  missing_samples: EventLogJournalSample[];
  divergent_samples: EventLogDivergenceSample[];
}

export interface VerifyEventLogProjectionOptions {
  /** Journal path override; defaults to {@link resolveEventJournalPath}. */
  journalPath?: string;
  scanLimit?: number;
  sampleLimit?: number;
}

interface CommittedRow {
  domain: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  cursor: string;
  occurred_at: string;
  host: string | null;
  agent_id: string | null;
  source: string | null;
  payload_json: string;
}

function rowToSide(row: CommittedRow): EventLogQuarantineSide {
  return {
    payload_json: row.payload_json,
    event_type: row.event_type,
    cursor: row.cursor,
    occurred_at: row.occurred_at,
    source: row.source,
    host: row.host,
    agent_id: row.agent_id,
    domain: row.domain,
    aggregate_type: row.aggregate_type,
    aggregate_id: row.aggregate_id,
  };
}

/** The journal's version of an event, with no projection guesswork. */
function journalEventToSide(
  event: unknown,
  canonicalPayload: string,
  source: string | null,
  host: string | null,
): EventLogQuarantineSide {
  const e = (event ?? {}) as Record<string, unknown>;
  return {
    payload_json: canonicalPayload,
    event_type: typeof e["event_type"] === "string" ? e["event_type"] : "",
    cursor: typeof e["cursor"] === "string" ? e["cursor"] : "",
    occurred_at: typeof e["emitted_at"] === "string" ? e["emitted_at"] : "",
    source,
    host,
    agent_id: null,
  };
}

/**
 * Does the stored row hold the same event as the journal?
 *
 * Compares **meaning, not bytes**. `appendOrchestrationEvent` only began
 * canonicalizing `payload_json` on 2026-07-15 (`1c0f5b0`); every row written
 * before that is stored in insertion order. A byte-wise compare therefore
 * reports the entire pre-cutover ledger as divergent — measured at 1458 of
 * 1458 comparable rows on `blade` — and a repair driven off it would
 * quarantine and rewrite the whole projection.
 *
 * That is the same defect as POL-2090 one layer down: an encoding difference
 * read as a data difference. Both sides are normalized so no writer-format
 * change can ever manufacture divergence again.
 *
 * A payload that does not parse is genuine corruption, and reports as
 * divergent so quarantine preserves it before the journal re-projects.
 */
function ledgerPayloadMatches(storedPayloadJson: string, canonicalEvent: string): boolean {
  if (storedPayloadJson === canonicalEvent) return true;
  try {
    return canonicalizeJcs(JSON.parse(storedPayloadJson)) === canonicalEvent;
  } catch {
    return false;
  }
}

/**
 * Structural discriminator matching `event-log-sink`'s projection: a stream
 * event is projectable when it carries a `run.run_id`, a `control` block, or
 * a `monitor.monitor_id`. This is the shape check only — the projection
 * itself is never re-implemented here; the rebuild writes through the very
 * same `OrchestrationLedgerSink` so one writer produces every row.
 */
function journalEventDomain(event: unknown): "run" | "control" | "monitor" | null {
  if (typeof event !== "object" || event === null) return null;
  const e = event as Record<string, unknown>;
  const run = e["run"] as { run_id?: unknown } | undefined;
  if (run && typeof run.run_id === "string") return "run";
  if ("control" in e && typeof e["control"] === "object" && e["control"] !== null) return "control";
  const monitor = e["monitor"] as { monitor_id?: unknown } | undefined;
  if (monitor && typeof monitor.monitor_id === "string") return "monitor";
  return null;
}

function tableExists(db: StateDriverDatabase, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name?: string } | undefined;
  return Boolean(row && row.name === table);
}

/**
 * Read-only comparison of the run-root stream journal against `event_log`.
 *
 * The comparison needs no projection logic: the sink stores the entire
 * stream event as `payload_json`, so a row matches its journal line exactly
 * when `canonicalizeJcs(line) === payload_json`. That is also the right
 * semantics — the payload *is* the event, and the columns around it are
 * derived from it plus the writer's provenance stamp.
 *
 * Only the host holding the journal and the database can run this. That is
 * the whole lesson of POL-2090: divergence is local evidence, and a fleet
 * upgrade that discovers it mid-flight has already failed.
 */
export async function verifyEventLogProjection(
  db: StateDriverDatabase,
  options: VerifyEventLogProjectionOptions = {},
): Promise<EventLogProjectionReport> {
  const journalPath = options.journalPath ?? resolveEventJournalPath();
  const scanLimit = options.scanLimit ?? EVENT_LOG_JOURNAL_SCAN_LIMIT;
  const sampleLimit = options.sampleLimit ?? EVENT_LOG_PROJECTION_SAMPLE_LIMIT;

  const base: EventLogProjectionReport = {
    schema_version: EVENT_LOG_PROJECTION_SCHEMA_VERSION,
    status: "scanned",
    journal_path: journalPath,
    journal_present: false,
    scanned: 0,
    unparsable: 0,
    non_projectable: 0,
    duplicate_journal_ids: 0,
    truncated: false,
    matched: 0,
    missing: 0,
    divergent: 0,
    ledger_rows: 0,
    ledger_native_rows: 0,
    orphaned_rows: 0,
    unclassified_rows: 0,
    unclassified_domains: [],
    missing_samples: [],
    divergent_samples: [],
  };

  if (!tableExists(db, "event_log")) {
    return {
      ...base,
      status: "skipped",
      skipped_reason:
        "event_log table is absent; run `calyx state migrate --apply` before verifying the projection.",
    };
  }

  const domainRows = db
    .prepare(`SELECT domain, COUNT(*) AS n FROM event_log GROUP BY domain`)
    .all() as Array<{ domain: string; n: number | bigint }>;
  let ledgerRows = 0;
  let ledgerNativeRows = 0;
  let journalDerivedRows = 0;
  let unclassifiedRows = 0;
  const unclassifiedDomains: string[] = [];
  for (const row of domainRows) {
    const n = typeof row.n === "bigint" ? Number(row.n) : row.n;
    ledgerRows += n;
    switch (classifyEventLogDomain(row.domain)) {
      case "ledger-native":
        ledgerNativeRows += n;
        break;
      case "journal-derived":
        journalDerivedRows += n;
        break;
      default:
        unclassifiedRows += n;
        unclassifiedDomains.push(row.domain);
    }
  }

  let journalPresent = true;
  try {
    await stat(journalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    journalPresent = false;
  }

  if (!journalPresent) {
    return {
      ...base,
      journal_present: false,
      ledger_rows: ledgerRows,
      ledger_native_rows: ledgerNativeRows,
      // Every journal-derived row is orphaned when there is no journal at all.
      orphaned_rows: journalDerivedRows,
      unclassified_rows: unclassifiedRows,
      unclassified_domains: unclassifiedDomains,
    };
  }

  const lookup = db.prepare(
    `SELECT domain, aggregate_type, aggregate_id, event_type, cursor, occurred_at,
            host, agent_id, source, payload_json
     FROM event_log WHERE event_id = ?`,
  );

  const seen = new Set<string>();
  let scanned = 0;
  let unparsable = 0;
  let nonProjectable = 0;
  let duplicates = 0;
  let matched = 0;
  let missing = 0;
  let divergent = 0;
  const missingSamples: EventLogJournalSample[] = [];
  const divergentSamples: EventLogDivergenceSample[] = [];
  let truncated = false;

  const stream = createReadStream(journalPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (scanned >= scanLimit) {
        truncated = true;
        break;
      }
      scanned += 1;

      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        unparsable += 1;
        continue;
      }
      const eventId = (event as { event_id?: unknown })?.event_id;
      if (typeof eventId !== "string" || eventId.length === 0) {
        unparsable += 1;
        continue;
      }
      const domain = journalEventDomain(event);
      if (!domain) {
        nonProjectable += 1;
        continue;
      }
      if (seen.has(eventId)) {
        duplicates += 1;
        continue;
      }
      seen.add(eventId);

      let canonical: string;
      try {
        canonical = canonicalizeJcs(event);
      } catch {
        unparsable += 1;
        continue;
      }

      const committed = lookup.get(eventId) as CommittedRow | undefined;
      const sample: EventLogJournalSample = {
        event_id: eventId,
        domain,
        event_type: String((event as { event_type?: unknown }).event_type ?? ""),
        cursor: String((event as { cursor?: unknown }).cursor ?? ""),
        occurred_at: String((event as { emitted_at?: unknown }).emitted_at ?? ""),
      };
      if (!committed) {
        missing += 1;
        if (missingSamples.length < sampleLimit) missingSamples.push(sample);
        continue;
      }
      if (ledgerPayloadMatches(committed.payload_json, canonical)) {
        matched += 1;
        continue;
      }
      divergent += 1;
      if (divergentSamples.length < sampleLimit) {
        // Neutralize the provenance stamp on the journal side so the reported
        // fields are the genuine body/identity difference, not "a different
        // component re-ingested the same event" — the false positive that
        // made POL-2090 terminal in the first place.
        const diffs = diffQuarantineSides(
          rowToSide(committed),
          journalEventToSide(event, canonical, committed.source, committed.host),
        );
        divergentSamples.push({
          ...sample,
          committed_source: committed.source,
          divergent_fields: diffs.map((d) => d.field),
        });
      }
    }
  } finally {
    lines.close();
    stream.close();
  }

  return {
    schema_version: EVENT_LOG_PROJECTION_SCHEMA_VERSION,
    status: "scanned",
    journal_path: journalPath,
    journal_present: true,
    scanned,
    unparsable,
    non_projectable: nonProjectable,
    duplicate_journal_ids: duplicates,
    truncated,
    matched,
    missing,
    divergent,
    ledger_rows: ledgerRows,
    ledger_native_rows: ledgerNativeRows,
    // Journal-derived rows the scan never reached. Exact when the scan
    // completed; a truncated scan inflates it, which the truncation finding
    // makes explicit rather than silently reporting as damage.
    orphaned_rows: Math.max(0, journalDerivedRows - matched - divergent),
    unclassified_rows: unclassifiedRows,
    unclassified_domains: unclassifiedDomains,
    missing_samples: missingSamples,
    divergent_samples: divergentSamples,
  };
}

// ── Rebuild ───────────────────────────────────────────────────────────

export const EVENT_LOG_REBUILD_SCHEMA_VERSION = "calyx.event-log-rebuild/v1";

/**
 * Provenance stamp on rebuilt rows. A rebuilt row was materialized from the
 * journal by this repair, not observed live, and the `source` column should
 * say so rather than impersonate the original writer.
 */
export const EVENT_LOG_REBUILD_SOURCE = "event-log-rebuild";

export interface EventLogRebuildSkip {
  event_id: string;
  reason: string;
}

export interface EventLogRebuildResult {
  schema_version: typeof EVENT_LOG_REBUILD_SCHEMA_VERSION;
  mode: "plan" | "apply";
  report: EventLogProjectionReport;
  /** Journal events inserted because the ledger lacked them. */
  restored: number;
  /** Divergent rows quarantined and re-projected from the journal. */
  replaced: number;
  /** Quarantine records written (empty in `plan` mode). */
  quarantined: EventLogQuarantineRecord[];
  /** Journal events the rebuild refused to write, with the reason. */
  skipped: EventLogRebuildSkip[];
  /** Rows deliberately left alone. */
  preserved: { ledger_native: number; orphaned: number };
  /** What this operation cannot restore. Read it before trusting a green run. */
  not_restorable: string[];
  /** Set when the rebuild refused to run at all. */
  refused_reason?: string;
}

export interface RebuildEventLogProjectionOptions {
  /** `plan` is read-only; `apply` writes. Defaults to `plan`. */
  mode?: "plan" | "apply";
  journalPath?: string;
  scanLimit?: number;
  sampleLimit?: number;
  /** Override path resolution (test injection). */
  paths?: ResolveStatePathsOptions | ResolvedStatePaths;
  /** Pre-opened database (test injection). */
  database?: StateDriverDatabase;
  driver?: StateDriverModule;
  host?: string | undefined;
  now?: () => string;
  newId?: () => string;
}

function describeNotRestorable(
  report: EventLogProjectionReport,
): string[] {
  const notes: string[] = [];
  if (report.ledger_native_rows > 0) {
    notes.push(
      `${report.ledger_native_rows} ledger-native row(s) in domain(s) ${LEDGER_NATIVE_EVENT_DOMAINS.join(", ")} have no journal behind them (Symphony daemon claim/launch/terminal/handoff facts written straight to event_log). They are preserved untouched and could never be recreated if deleted.`,
    );
  }
  if (report.orphaned_rows > 0) {
    notes.push(
      `${report.orphaned_rows} row(s) in journal-derived domains have no matching line in ${report.journal_path} — a rotated or truncated journal, a different runs root, or events predating journal receipts. They are preserved untouched; the rebuild cannot recreate them.`,
    );
  }
  if (report.unclassified_rows > 0) {
    notes.push(
      `${report.unclassified_rows} row(s) sit in undeclared domain(s) ${report.unclassified_domains.join(", ")}. Their provenance is unknown, so they are preserved and excluded from every rebuild claim.`,
    );
  }
  notes.push(
    "`recorded_at` is re-stamped on every restored row: it records when this host observed the event, and a rebuild observes it now. `occurred_at` and the event body come from the journal and are exact.",
  );
  notes.push(
    "`event_cursors`, `locks`, and `source_freshness` are not rebuilt. Cursors are monotonic and advance from live ingest, locks are live claims, freshness is observational.",
  );
  return notes;
}

/**
 * Merge the run-root stream journal into `event_log`, quarantining rows
 * that genuinely disagree.
 *
 * Never a truncate-and-replace: ledger-native and orphaned rows have no
 * journal behind them, so a replace would delete history no one can restore.
 *
 * On a genuine disagreement the **journal wins** — it is the authority and
 * `event_log` is the projection — and the displaced row is written to the
 * quarantine sidecar first, so the losing version survives in full even if
 * the process dies mid-repair. Quarantine is ordered write → delete →
 * re-project precisely so a crash leaves a recoverable state: a missing row
 * is re-added by the next rebuild from the same authority.
 *
 * Refuses to write when an undeclared domain is present: an unknown writer
 * means the provenance boundary above is stale, and guessing is how a
 * rebuild eats data.
 */
export async function rebuildEventLogProjection(
  options: RebuildEventLogProjectionOptions = {},
): Promise<EventLogRebuildResult> {
  const mode = options.mode ?? "plan";
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());

  const paths: ResolvedStatePaths =
    options.paths && "stateDir" in options.paths
      ? (options.paths as ResolvedStatePaths)
      : resolveStatePaths((options.paths as ResolveStatePathsOptions | undefined) ?? {});
  assertStatePathAllowedForTests(paths, options.paths as ResolveStatePathsOptions | undefined);

  let db = options.database ?? null;
  let ownsDb = false;
  if (!db) {
    const driver = options.driver ?? (await loadStateDriver());
    db = driver.open(paths.dbPath);
    ownsDb = true;
    try {
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec("PRAGMA busy_timeout = 5000;");
    } catch {
      // The migrate path owns canonical pragmas.
    }
  }

  try {
    const verifyOptions: VerifyEventLogProjectionOptions = {};
    if (options.journalPath !== undefined) verifyOptions.journalPath = options.journalPath;
    if (options.scanLimit !== undefined) verifyOptions.scanLimit = options.scanLimit;
    if (options.sampleLimit !== undefined) verifyOptions.sampleLimit = options.sampleLimit;
    const report = await verifyEventLogProjection(db, verifyOptions);

    const result: EventLogRebuildResult = {
      schema_version: EVENT_LOG_REBUILD_SCHEMA_VERSION,
      mode,
      report,
      restored: 0,
      replaced: 0,
      quarantined: [],
      skipped: [],
      preserved: { ledger_native: report.ledger_native_rows, orphaned: report.orphaned_rows },
      not_restorable: describeNotRestorable(report),
    };

    if (report.status === "skipped") {
      return { ...result, refused_reason: report.skipped_reason ?? "projection scan skipped" };
    }
    if (report.unclassified_rows > 0) {
      return {
        ...result,
        refused_reason:
          `event_log holds ${report.unclassified_rows} row(s) in undeclared domain(s) ${report.unclassified_domains.join(", ")}. `
          + "A writer was added without declaring whether its rows have a journal behind them. Declare it in JOURNAL_DERIVED_EVENT_DOMAINS or LEDGER_NATIVE_EVENT_DOMAINS before rebuilding.",
      };
    }
    if (!report.journal_present) {
      return {
        ...result,
        refused_reason: `no stream journal at ${report.journal_path}; nothing to rebuild from.`,
      };
    }
    if (report.truncated) {
      return {
        ...result,
        refused_reason:
          `journal scan stopped at ${report.scanned} line(s) (limit ${options.scanLimit ?? EVENT_LOG_JOURNAL_SCAN_LIMIT}); `
          + "a partial scan cannot tell a gap from an orphan, so the rebuild refuses rather than guess.",
      };
    }
    if (mode === "plan") {
      return result;
    }

    // One connection for the repair: the sink writes through the handle we
    // already hold, so the delete and the re-projection cannot deadlock
    // against each other.
    const sink = new OrchestrationLedgerSink({
      database: db,
      source: EVENT_LOG_REBUILD_SOURCE,
      ...(options.host ? { host: options.host } : {}),
    });
    const lookup = db.prepare(
      `SELECT domain, aggregate_type, aggregate_id, event_type, cursor, occurred_at,
              host, agent_id, source, payload_json
       FROM event_log WHERE event_id = ?`,
    );
    const deleteRow = db.prepare(`DELETE FROM event_log WHERE event_id = ?`);

    const seen = new Set<string>();
    const stream = createReadStream(report.journal_path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const eventId = (event as { event_id?: unknown })?.event_id;
        if (typeof eventId !== "string" || !eventId) continue;
        if (!journalEventDomain(event)) continue;
        if (seen.has(eventId)) continue;
        seen.add(eventId);

        let canonical: string;
        try {
          canonical = canonicalizeJcs(event);
        } catch {
          result.skipped.push({ event_id: eventId, reason: "journal event is not canonicalizable" });
          continue;
        }

        const committed = lookup.get(eventId) as CommittedRow | undefined;
        if (committed && ledgerPayloadMatches(committed.payload_json, canonical)) continue;

        if (committed) {
          // Genuine disagreement. Preserve the losing version in full before
          // anything is removed, then let the authority re-project.
          const committedSide = rowToSide(committed);
          const incomingSide = journalEventToSide(
            event,
            canonical,
            EVENT_LOG_REBUILD_SOURCE,
            options.host ?? null,
          );
          const record: EventLogQuarantineRecord = {
            schema_version: EVENT_LOG_QUARANTINE_SCHEMA_VERSION,
            quarantine_id: newId(),
            event_id: eventId,
            quarantined_at: now(),
            reason: "identity-conflict",
            origin: "rebuild",
            host: options.host ?? null,
            committed: committedSide,
            incoming: incomingSide,
            resolution: "kept-incoming",
            divergent_fields: diffQuarantineSides(committedSide, incomingSide),
            detail:
              `The committed row and ${report.journal_path} disagree on event ${eventId}. `
              + "The journal is the authority for this projection, so the committed row was displaced and preserved here.",
          };
          await writeEventLogQuarantineRecord(paths.stateDir, record);
          deleteRow.run(eventId);
          const outcome = await sink.ingestStreamEvent(event as SinkStreamEvent);
          if (outcome.status !== "ingested") {
            result.skipped.push({
              event_id: eventId,
              reason: `re-projection did not commit: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`,
            });
            continue;
          }
          result.quarantined.push(record);
          result.replaced += 1;
          continue;
        }

        const outcome = await sink.ingestStreamEvent(event as SinkStreamEvent);
        if (outcome.status === "ingested") {
          result.restored += 1;
          continue;
        }
        result.skipped.push({
          event_id: eventId,
          reason: `${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""}`,
        });
      }
    } finally {
      lines.close();
      stream.close();
      sink.close();
    }

    return result;
  } finally {
    if (ownsDb && db) {
      try {
        db.close();
      } catch {
        /* swallow */
      }
    }
  }
}
