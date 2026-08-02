import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  applyStateMigrations,
  CALYX_HTTP_SSE_MAX_FRAME_BYTES,
  countEventsByAggregate,
  hashCanonicalJcs,
  loadStateDriver,
  listEventsByAggregate,
  openStateStore,
  listEventLogQuarantineRecords,
  OrchestrationLedgerSink,
} from "@polli-labs/calyx-core";

import {
  EVENT_JOURNAL_MAX_LINE_BYTES,
  EventAuthorityNotPreparedError,
  EventJournalCorruptionError,
  EventJournalEventIdentityConflictError,
  EventReplayCursorError,
  EventSseFrameTooLargeError,
  RunIndexProjectionNotReadyError,
  RunStore,
} from "../store.js";
import type {
  CalyxControlEvent,
  CalyxRunEvent,
  CalyxRunEventFilter,
  CalyxStreamEvent,
  RunIntent,
} from "../types.js";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;
const execFileAsync = promisify(execFile);

async function makeStateHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "calyx-store-event-log-"));
  return join(root, "state");
}

function buildIntent(runId: string): RunIntent {
  return {
    run_id: runId,
    host: "blade",
    created_at: "2026-05-10T00:00:00.000Z",
  };
}

function buildRunEvent(
  runId: string,
  overrides: { event_id?: string; cursor?: string } = {},
): CalyxRunEvent {
  return {
    schema_version: "1.0",
    event_id: overrides.event_id ?? `evt-${runId}-1`,
    cursor: overrides.cursor ?? `2026-05-10T00:00:00.000Z-${runId}-000001`,
    emitted_at: "2026-05-10T00:00:00.000Z",
    event_type: "run.terminal",
    emitted_by: "launch",
    run: {
      run_id: runId,
      state: "succeeded",
      kernel: "agent_runner",
      host: "blade",
      created_at: "2026-05-10T00:00:00.000Z",
      recovery_mode: "normal",
    },
    origin: { launcher_kind: "cli" },
    pointers: {
      run_dir: `/tmp/${runId}`,
      run_record_path: `/tmp/${runId}/run_record.json`,
      events_path: `/tmp/${runId}/events.jsonl`,
    },
    summary: { one_line: "test run" },
  };
}

function buildControlEvent(eventId: string, cursor: string): CalyxControlEvent {
  return {
    schema_version: "1.0",
    event_id: eventId,
    cursor,
    emitted_at: "2026-05-10T00:01:00.000Z",
    event_type: "daemon.health.checked",
    emitted_by: "self-health",
    control: {
      host: "blade",
      daemon_id: "blade-default",
    },
  };
}

function streamEventIdentityHash(event: CalyxStreamEvent): string {
  return hashCanonicalJcs(JSON.parse(JSON.stringify({
    ...event,
    cursor: "<durable-global-cursor>",
  })) as unknown);
}

function allocatedCursor(ordinal: number): string {
  return `z1-${String(ordinal).padStart(20, "0")}`;
}

async function readStreamRows(filePath: string): Promise<CalyxStreamEvent[]> {
  return (await readFile(filePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CalyxStreamEvent);
}

describe("RunStore SQLite mirror (POL-1342)", () => {
  let stateHome: string;
  let runsRoot: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const k of ENV_KEYS) delete process.env[k];
    stateHome = await makeStateHome();
    process.env["CALYX_STATE_HOME"] = stateHome;
    runsRoot = await mkdtemp(join(tmpdir(), "calyx-runs-"));
    await applyStateMigrations();
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const stateParent = stateHome.replace(/\/state$/, "");
    await rm(stateParent, { recursive: true, force: true });
    await rm(runsRoot, { recursive: true, force: true });
  });

  test("appendStreamEvent writes events.jsonl AND mirrors to SQLite event_log", async () => {
    const sink = new OrchestrationLedgerSink({ source: "test" });
    const store = new RunStore(runsRoot, {
      eventLogIngest: (event) => sink.ingestStreamEvent(event),
    });

    const intent = buildIntent("run-A");
    await store.createRun(intent);
    const event = buildRunEvent("run-A");
    await store.appendStreamEvent(event);

    // JSONL receipts unchanged.
    const perRun = await readFile(store.paths("run-A").eventsPath, "utf8");
    expect(perRun.trim().split("\n").length).toBe(1);
    expect(perRun).toContain(event.event_id);
    const indexed = await readFile(store.eventsIndexPath(), "utf8");
    expect(indexed).toContain(event.event_id);

    sink.close();

    // SQLite mirror has exactly one row.
    const opened = await openStateStore();
    try {
      expect(countEventsByAggregate(opened.db, "run", "run-A")).toBe(1);
      const rows = listEventsByAggregate(opened.db, "run", "run-A");
      expect(rows[0]?.event_id).toBe(event.event_id);
      expect(rows[0]?.event_type).toBe("run.terminal");
    } finally {
      opened.db.close();
    }
  });

  test("process-local stream wakes publish only after durable projection and cannot fail the append", async () => {
    const sink = new OrchestrationLedgerSink({ source: "test" });
    let projectionStarted!: () => void;
    let releaseProjection!: () => void;
    const projectionStartedBarrier = new Promise<void>((resolve) => {
      projectionStarted = resolve;
    });
    const projectionReleaseBarrier = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    const store = new RunStore(runsRoot, {
      eventLogIngest: async (event) => {
        projectionStarted();
        await projectionReleaseBarrier;
        return sink.ingestStreamEvent(event);
      },
    });
    const observed: CalyxStreamEvent[] = [];
    store.subscribeToCommittedStreamEvents(() => {
      throw new Error("injected observational subscriber failure");
    });
    const unsubscribe = store.subscribeToCommittedStreamEvents((event) => {
      observed.push(event);
    });

    await store.createRun(buildIntent("run-process-local-wake"));
    const event = buildRunEvent("run-process-local-wake");
    const append = store.appendStreamEvent(event);
    await projectionStartedBarrier;
    expect(observed).toEqual([]);
    releaseProjection();
    await expect(append).resolves.toMatchObject({ event_id: event.event_id });
    expect(observed).toEqual([expect.objectContaining({ event_id: event.event_id })]);

    unsubscribe();
    await store.appendStreamEvent(event);
    expect(observed).toHaveLength(1);
    sink.close();
  });

  test("repeated terminal-event ingestion does not duplicate SQLite rows", async () => {
    const sink = new OrchestrationLedgerSink({ source: "test" });
    const store = new RunStore(runsRoot, {
      eventLogIngest: (event) => sink.ingestStreamEvent(event),
    });

    await store.createRun(buildIntent("run-B"));
    const event = buildRunEvent("run-B");

    // Simulate a launch + a reconcile pass that re-emits the same event.
    await store.appendStreamEvent(event);
    await store.appendStreamEvent(event);
    await store.appendStreamEvent(event);

    sink.close();

    // JSON/JSONL paths already deduplicate (their pre-existing contract).
    const perRun = await readFile(store.paths("run-B").eventsPath, "utf8");
    expect(perRun.trim().split("\n").filter((l) => l.length).length).toBe(1);
    const indexed = await readFile(store.eventsIndexPath(), "utf8");
    const indexedLines = indexed.trim().split("\n").filter((l) => l.length);
    expect(indexedLines.length).toBe(1);

    // SQLite mirror also dedupes.
    const opened = await openStateStore();
    try {
      expect(countEventsByAggregate(opened.db, "run", "run-B")).toBe(1);
    } finally {
      opened.db.close();
    }
  });

  test("concurrent appendStreamEvent calls do not duplicate rows", async () => {
    const sink = new OrchestrationLedgerSink({ source: "test" });
    const store = new RunStore(runsRoot, {
      eventLogIngest: (event) => sink.ingestStreamEvent(event),
    });

    await store.createRun(buildIntent("run-C"));
    const event = buildRunEvent("run-C");

    await Promise.all(
      Array.from({ length: 8 }, () => store.appendStreamEvent(event)),
    );
    sink.close();

    const opened = await openStateStore();
    try {
      expect(countEventsByAggregate(opened.db, "run", "run-C")).toBe(1);
    } finally {
      opened.db.close();
    }
  });

  test("independent stores atomically append one global and local row for the same event id", async () => {
    const stores = [new RunStore(runsRoot), new RunStore(runsRoot)];
    await stores[0]!.createRun(buildIntent("run-cross-store-event"));
    const event = buildRunEvent("run-cross-store-event");

    await Promise.all(
      Array.from({ length: 16 }, (_, index) => stores[index % stores.length]!.appendStreamEvent(event)),
    );

    const parseRows = async (filePath: string) => (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event_id?: string });
    const globalRows = await parseRows(stores[0]!.eventsIndexPath());
    const localRows = await parseRows(stores[0]!.paths(event.run.run_id).eventsPath);

    expect(globalRows.filter((row) => row.event_id === event.event_id)).toHaveLength(1);
    expect(localRows.filter((row) => row.event_id === event.event_id)).toHaveLength(1);
  });

  test("two processes through real and symlink roots share one physical cursor authority", async () => {
    const childRoot = process.env["CALYX_EVENT_AUTHORITY_CHILD_ROOT"];
    if (childRoot) {
      const childStore = new RunStore(childRoot);
      await childStore.appendStreamEvent(buildControlEvent(
        process.env["CALYX_EVENT_AUTHORITY_CHILD_ID"]!,
        `2026-05-10T00:01:00.000Z-${process.env["CALYX_EVENT_AUTHORITY_CHILD_ID"]}`,
      ));
      return;
    }

    const aliasRoot = `${runsRoot}-alias`;
    await symlink(runsRoot, aliasRoot, "dir");
    const testFile = join(
      process.cwd(),
      "packages/run-service/src/__tests__/store-event-log.test.ts",
    );
    const child = (root: string, eventId: string) => execFileAsync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        testFile,
        "-t",
        "two processes through real and symlink roots share one physical cursor authority",
        "--maxWorkers=1",
        "--minWorkers=1",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CALYX_STATE_HOME: join(root, `.child-state-${eventId}`),
          CALYX_STATE_DB: join(root, `.child-state-${eventId}`, "calyx.db"),
          CALYX_EVENT_AUTHORITY_CHILD_ROOT: root,
          CALYX_EVENT_AUTHORITY_CHILD_ID: eventId,
        },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    try {
      await Promise.all([
        child(runsRoot, "evt-process-real"),
        child(aliasRoot, "evt-process-alias"),
      ]);
      const rows: CalyxStreamEvent[] = [];
      const reader = new RunStore(runsRoot);
      await reader.prepareGlobalEventAuthority();
      for await (const event of reader.readEventsSince(undefined)) rows.push(event);
      expect(rows.map((event) => event.cursor)).toEqual([allocatedCursor(1), allocatedCursor(2)]);
      expect(new Set(rows.map((event) => event.event_id))).toEqual(
        new Set(["evt-process-real", "evt-process-alias"]),
      );
      expect(await readStreamRows(join(runsRoot, "events.index.jsonl"))).toHaveLength(2);
    } finally {
      await rm(aliasRoot, { force: true });
    }
  });

  test("global authority replaces reverse producer cursors with replay-safe journal ordinals", async () => {
    const store = new RunStore(runsRoot);
    const runId = "run-reverse-producer-order";
    await store.createRun(buildIntent(runId));
    const laterProducerCursor = buildControlEvent(
      "evt-reverse-control",
      "2026-05-10T00:00:02.000Z-control-later",
    );
    const earlierProducerCursor = buildRunEvent(runId, {
      event_id: "evt-reverse-run",
      cursor: "2026-05-10T00:00:01.000Z-run-earlier",
    });

    const first = await store.appendStreamEvent(laterProducerCursor);
    const second = await store.appendStreamEvent(earlierProducerCursor);

    expect(first.cursor).toBe(allocatedCursor(1));
    expect(second.cursor).toBe(allocatedCursor(2));
    const afterFirst: CalyxStreamEvent[] = [];
    for await (const event of store.readEventsSince(first.cursor)) afterFirst.push(event);
    expect(afterFirst.map((event) => event.event_id)).toEqual([second.event_id]);
    expect((await readStreamRows(store.paths(runId).eventsPath))[0]?.cursor).toBe(second.cursor);
  });

  test("independent store actors allocate one strict sequence across concurrent event families", async () => {
    const stores = Array.from({ length: 4 }, () => new RunStore(runsRoot));
    const runEvents = Array.from({ length: 6 }, (_, index) => {
      const runId = `run-cross-family-${index}`;
      return buildRunEvent(runId, {
        event_id: `evt-cross-family-run-${index}`,
        cursor: `2026-05-10T00:00:0${5 - index}.000Z-run-${index}`,
      });
    });
    await Promise.all(runEvents.map((event) => stores[0]!.createRun(buildIntent(event.run.run_id))));
    const events: CalyxStreamEvent[] = runEvents.flatMap((runEvent, index) => [
      buildControlEvent(
        `evt-cross-family-control-${index}`,
        `2026-05-10T00:01:0${5 - index}.000Z-control-${index}`,
      ),
      runEvent,
    ]);

    const completionOrder: string[] = [];
    const committed = await Promise.all(events.map(async (event, index) => {
      const stored = await stores[index % stores.length]!.appendStreamEvent(event);
      completionOrder.push(stored.cursor);
      return stored;
    }));
    const rows = await readStreamRows(stores[0]!.eventsIndexPath());

    expect(rows.map((event) => event.cursor)).toEqual(
      Array.from({ length: events.length }, (_, index) => allocatedCursor(index + 1)),
    );
    expect(new Set(completionOrder)).toEqual(new Set(rows.map((event) => event.cursor)));
    expect(new Set(committed.map((event) => event.cursor))).toEqual(new Set(rows.map((event) => event.cursor)));
    for (const runEvent of runEvents) {
      const global = rows.find((event) => event.event_id === runEvent.event_id)!;
      const local = (await readStreamRows(stores[0]!.paths(runEvent.run.run_id).eventsPath))
        .find((event) => event.event_id === runEvent.event_id);
      expect(local).toEqual(global);
    }
  });

  test("strict legacy prefix rolls forward to a cursor greater than every legacy row", async () => {
    const store = new RunStore(runsRoot);
    const first = buildControlEvent("evt-legacy-prefix-1", "2026-05-10T00:00:00.000Z-legacy-000001");
    const second = buildControlEvent("evt-legacy-prefix-2", "2026-05-10T00:00:01.000Z-legacy-000002");
    await writeFile(
      store.eventsIndexPath(),
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
      "utf8",
    );

    const committed = await store.appendStreamEvent(
      buildControlEvent("evt-after-legacy-prefix", "2020-01-01T00:00:00.000Z-producer-clock-regressed"),
    );

    expect(committed.cursor).toBe(allocatedCursor(3));
    expect(committed.cursor > second.cursor).toBe(true);
    expect((await readStreamRows(store.eventsIndexPath())).map((event) => event.cursor)).toEqual([
      first.cursor,
      second.cursor,
      committed.cursor,
    ]);
  });

  test("replay cursor preflight classifies malformed, unknown, future, legacy, exact, and tail cursors", async () => {
    const store = new RunStore(runsRoot);
    const legacy = buildControlEvent(
      "evt-replay-cursor-legacy",
      "2026-05-10T00:00:00.000Z-replay-cursor-legacy",
    );
    await writeFile(store.eventsIndexPath(), `${JSON.stringify(legacy)}\n`, "utf8");
    await store.prepareGlobalEventAuthority();
    await store.assertGlobalEventReplayCursor(legacy.cursor);
    const firstAllocated = await store.appendStreamEvent(buildControlEvent(
      "evt-replay-cursor-allocated-1",
      "2020-01-01T00:00:00.000Z-producer-1",
    ));
    const tail = await store.appendStreamEvent(buildControlEvent(
      "evt-replay-cursor-allocated-2",
      "2020-01-01T00:00:00.000Z-producer-2",
    ));
    await expect(store.assertGlobalEventReplayCursor(firstAllocated.cursor)).resolves.toBeUndefined();
    await expect(store.assertGlobalEventReplayCursor(tail.cursor)).resolves.toBeUndefined();

    await expect(store.assertGlobalEventReplayCursor("not-a-cursor")).rejects.toMatchObject({
      name: EventReplayCursorError.name,
      reason: "malformed",
    });
    await expect(store.assertGlobalEventReplayCursor(
      "2026-05-10T00:00:00.000Z-valid-shaped-but-unknown",
    )).rejects.toMatchObject({
      name: EventReplayCursorError.name,
      reason: "unknown",
    });
    await expect(store.assertGlobalEventReplayCursor(allocatedCursor(99))).rejects.toMatchObject({
      name: EventReplayCursorError.name,
      reason: "future",
    });
  });

  test("prepared-only replay reads cannot create authority state", async () => {
    const store = new RunStore(runsRoot);
    const collect = async () => {
      const events: CalyxStreamEvent[] = [];
      for await (const event of store.readEventsSince(undefined)) events.push(event);
      return events;
    };
    await expect(collect()).rejects.toBeInstanceOf(EventAuthorityNotPreparedError);
    await expect(store.assertGlobalEventReplayCursor(
      "2026-05-10T00:00:00.000Z-valid-shaped-cursor",
    )).rejects.toBeInstanceOf(EventAuthorityNotPreparedError);
    await expect(store.inspectExistingEventAuthority())
      .rejects.toBeInstanceOf(EventAuthorityNotPreparedError);
    await expect(stat(join(runsRoot, "events.authority.sqlite3")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("read-only authority inspection opens existing SQLite without startup preparation", async () => {
    const writer = new RunStore(runsRoot);
    const terminal = buildRunEvent("run-read-only-authority-audit");
    await writer.appendStreamEvent(terminal);

    const inspector = new RunStore(runsRoot);
    const inspected = await inspector.inspectExistingEventAuthority({
      event_type: "run.terminal",
    });

    expect(inspected).toEqual({
      source: "sqlite",
      events: [{
        ...terminal,
        cursor: allocatedCursor(1),
      }],
    });
  });

  test("startup additively migrates an existing authority for indexed supersession edges", async () => {
    const driver = await loadStateDriver();
    const databasePath = join(runsRoot, "events.authority.sqlite3");
    const partialMigrationChild = {
      ...buildRunEvent("run-partial-migration-child", {
        event_id: "evt-partial-migration-child",
        cursor: allocatedCursor(1),
      }),
      supersession: {
        schema_version: "calyx.run-terminal-supersession/v1" as const,
        supersedes_event_id: "evt-partial-migration-parent",
        reason: "receipt_projection_corrected" as const,
      },
    };
    const legacyDb = driver.open(databasePath);
    try {
      legacyDb.exec(`
        CREATE TABLE global_event_authority (
          ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          cursor TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          run_id TEXT,
          supersedes_event_id TEXT,
          identity_hash TEXT NOT NULL,
          event_json TEXT NOT NULL,
          receipt_written INTEGER NOT NULL DEFAULT 0 CHECK (receipt_written IN (0, 1)),
          run_receipt_written INTEGER NOT NULL DEFAULT 0 CHECK (run_receipt_written IN (0, 1))
        );
        CREATE TABLE global_event_authority_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO global_event_authority_meta (key, value) VALUES
          ('schema_version', '1'),
          ('receipt_bytes', '0'),
          ('initialized', '1');
      `);
      legacyDb.prepare(
        `INSERT INTO global_event_authority
           (event_id, cursor, event_type, run_id, supersedes_event_id,
            identity_hash, event_json, receipt_written, run_receipt_written)
         VALUES (?, ?, ?, ?, NULL, ?, ?, 0, 0)`,
      ).run(
        partialMigrationChild.event_id,
        partialMigrationChild.cursor,
        partialMigrationChild.event_type,
        partialMigrationChild.run.run_id,
        streamEventIdentityHash(partialMigrationChild),
        JSON.stringify(partialMigrationChild),
      );
    } finally {
      legacyDb.close();
    }

    await new RunStore(runsRoot).prepareGlobalEventAuthority();

    const migratedDb = driver.openReadOnly(databasePath);
    try {
      const columns = migratedDb.prepare(
        "PRAGMA table_info(global_event_authority)",
      ).all() as Array<{ name: string }>;
      const objects = migratedDb.prepare(
        `SELECT name, type FROM sqlite_master
         WHERE name IN (
           'idx_global_event_authority_supersedes',
           'global_event_authority_identity_immutable',
           'global_event_authority_supersedes_insert',
           'global_event_authority_supersedes_update'
         )`,
      ).all() as Array<{ name: string; type: string }>;
      expect(columns.map((column) => column.name)).toContain("supersedes_event_id");
      expect(new Set(objects.map((entry) => entry.name))).toEqual(new Set([
        "idx_global_event_authority_supersedes",
        "global_event_authority_identity_immutable",
        "global_event_authority_supersedes_insert",
        "global_event_authority_supersedes_update",
      ]));
      const repaired = migratedDb.prepare(
        "SELECT supersedes_event_id FROM global_event_authority WHERE event_id = ?",
      ).get(partialMigrationChild.event_id) as { supersedes_event_id: string | null };
      expect(repaired.supersedes_event_id).toBe("evt-partial-migration-parent");
    } finally {
      migratedDb.close();
    }

    // A rolling older writer omits the additive column. Its pending-to-final
    // update is still accepted, and the compatibility trigger derives the
    // indexed edge from the finalized JSON before the row becomes observable.
    const rollingDb = driver.open(databasePath);
    try {
      const child = {
        ...buildRunEvent("run-rolling-supersession-child", {
          event_id: "evt-rolling-supersession-child",
          cursor: allocatedCursor(2),
        }),
        supersession: {
          schema_version: "calyx.run-terminal-supersession/v1",
          supersedes_event_id: "evt-rolling-supersession-parent",
          reason: "receipt_projection_corrected",
        },
      };
      rollingDb.prepare(
        `INSERT INTO global_event_authority
           (event_id, cursor, event_type, run_id, identity_hash, event_json,
            receipt_written, run_receipt_written)
         VALUES (?, ?, ?, ?, ?, '{}', 0, 0)`,
      ).run(
        child.event_id,
        "pending-rolling-writer",
        child.event_type,
        child.run.run_id,
        streamEventIdentityHash(child),
      );
      rollingDb.prepare(
        "UPDATE global_event_authority SET cursor = ?, event_json = ? WHERE event_id = ?",
      ).run(child.cursor, JSON.stringify(child), child.event_id);
      const row = rollingDb.prepare(
        "SELECT supersedes_event_id FROM global_event_authority WHERE event_id = ?",
      ).get(child.event_id) as { supersedes_event_id: string | null };
      expect(row.supersedes_event_id).toBe("evt-rolling-supersession-parent");
    } finally {
      rollingDb.close();
    }
    await expect(new RunStore(runsRoot).prepareGlobalEventAuthority()).resolves.toBeUndefined();
  });

  test("startup rejects a conflicting denormalized supersession edge at its exact validation path", async () => {
    const driver = await loadStateDriver();
    const databasePath = join(runsRoot, "events.authority.sqlite3");
    const child = {
      ...buildRunEvent("run-conflicting-supersession-child", {
        event_id: "evt-conflicting-supersession-child",
        cursor: allocatedCursor(1),
      }),
      supersession: {
        schema_version: "calyx.run-terminal-supersession/v1" as const,
        supersedes_event_id: "evt-canonical-parent",
        reason: "receipt_projection_corrected" as const,
      },
    };
    const db = driver.open(databasePath);
    try {
      db.exec(`
        CREATE TABLE global_event_authority (
          ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          cursor TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          run_id TEXT,
          supersedes_event_id TEXT,
          identity_hash TEXT NOT NULL,
          event_json TEXT NOT NULL,
          receipt_written INTEGER NOT NULL DEFAULT 0 CHECK (receipt_written IN (0, 1)),
          run_receipt_written INTEGER NOT NULL DEFAULT 0 CHECK (run_receipt_written IN (0, 1))
        );
        CREATE TABLE global_event_authority_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO global_event_authority_meta (key, value) VALUES
          ('schema_version', '1'),
          ('receipt_bytes', '0'),
          ('initialized', '1');
      `);
      db.prepare(
        `INSERT INTO global_event_authority
           (event_id, cursor, event_type, run_id, supersedes_event_id,
            identity_hash, event_json, receipt_written, run_receipt_written)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      ).run(
        child.event_id,
        child.cursor,
        child.event_type,
        child.run.run_id,
        "evt-conflicting-parent",
        streamEventIdentityHash(child),
        JSON.stringify(child),
      );
    } finally {
      db.close();
    }

    await expect(new RunStore(runsRoot).prepareGlobalEventAuthority()).rejects.toMatchObject({
      name: "EventJournalCorruptionError",
      filePath: "global_event_authority",
      lineNumber: 1,
      message: expect.stringContaining(
        "authority supersedes_event_id disagrees with event_json",
      ),
    });
  });

  test("read-only authority inspection strictly falls back to predecessor JSONL", async () => {
    const terminal = buildRunEvent("run-read-only-legacy-authority-audit");
    await writeFile(
      join(runsRoot, "events.index.jsonl"),
      `${JSON.stringify(terminal)}\n`,
      "utf8",
    );

    await expect(new RunStore(runsRoot).inspectExistingEventAuthority({
      event_type: "run.terminal",
    })).resolves.toEqual({
      source: "legacy_jsonl",
      events: [terminal],
    });
    await expect(stat(join(runsRoot, "events.authority.sqlite3")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("read-only predecessor inspection preserves file order for non-lexical legacy cursors", async () => {
    const first = buildRunEvent("run-read-only-legacy-cursor-audit-a", {
      event_id: "evt-read-only-legacy-cursor-audit-a",
      cursor: "2026-05-31T10:27:15.643Z-f29a29a6-f015-4fdc-a478-a8bee458ffc1-000001",
    });
    const second = buildRunEvent("run-read-only-legacy-cursor-audit-b", {
      event_id: "evt-read-only-legacy-cursor-audit-b",
      cursor: "2026-05-31T10:27:15.643Z-2f42f8c1-f847-40de-9f26-70ef0d55f68e-000001",
    });
    await writeFile(
      join(runsRoot, "events.index.jsonl"),
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
      "utf8",
    );

    await expect(new RunStore(runsRoot).inspectExistingEventAuthority({
      event_type: "run.terminal",
    })).resolves.toEqual({
      source: "legacy_jsonl",
      events: [first, second],
    });
  });

  test.each([
    ["malformed", "{not-json}\n"],
    ["truncated", JSON.stringify(buildRunEvent("run-truncated-legacy-authority-audit"))],
  ])("read-only predecessor JSONL inspection fails closed on %s input", async (_name, body) => {
    await writeFile(join(runsRoot, "events.index.jsonl"), body, "utf8");

    await expect(new RunStore(runsRoot).inspectExistingEventAuthority())
      .rejects.toBeInstanceOf(EventJournalCorruptionError);
    await expect(stat(join(runsRoot, "events.authority.sqlite3")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("existing SQLite authority wins over malformed sibling predecessor JSONL", async () => {
    const writer = new RunStore(runsRoot);
    const terminal = buildRunEvent("run-sqlite-precedence-audit");
    await writer.appendStreamEvent(terminal);
    await writeFile(join(runsRoot, "events.index.jsonl"), "{not-json}\n", "utf8");

    await expect(new RunStore(runsRoot).inspectExistingEventAuthority()).resolves.toEqual({
      source: "sqlite",
      events: [{ ...terminal, cursor: allocatedCursor(1) }],
    });
  });

  test("SQLite authority identity is immutable and startup validation precedes semantic filters", async () => {
    const writer = new RunStore(runsRoot);
    const terminal = buildRunEvent("run-filtered-authority-corruption");
    await writer.appendStreamEvent(terminal);
    await writer.prepareGlobalEventAuthority();

    const driver = await loadStateDriver();
    const databasePath = join(runsRoot, "events.authority.sqlite3");
    const db = driver.open(databasePath);
    try {
      expect(() => db.prepare(
        "UPDATE global_event_authority SET event_type = 'run.progress' WHERE event_id = ?",
      ).run(terminal.event_id)).toThrow(/identity is immutable/u);
      // Simulate an authority created by an older build before the immutable
      // identity trigger existed. The next startup must validate the raw row
      // before an indexed terminal filter can omit it.
      db.exec("DROP TRIGGER global_event_authority_identity_immutable");
      db.prepare(
        "UPDATE global_event_authority SET event_type = 'run.progress' WHERE event_id = ?",
      ).run(terminal.event_id);
    } finally {
      db.close();
    }

    await expect(new RunStore(runsRoot).inspectExistingEventAuthority({
      event_type: "run.terminal",
    })).rejects.toBeInstanceOf(EventJournalCorruptionError);
    await expect(new RunStore(runsRoot).prepareGlobalEventAuthority())
      .rejects.toBeInstanceOf(EventJournalCorruptionError);
  });

  test("validated high-water makes filtered replay indexed and advances over nonmatching tails", async () => {
    const writer = new RunStore(runsRoot);
    const terminal = buildRunEvent("run-filter-high-water", {
      cursor: allocatedCursor(1),
    });
    const initialEvents: CalyxStreamEvent[] = [
      terminal,
      ...Array.from({ length: 20 }, (_, index) => buildControlEvent(
        `evt-filter-tail-${index}`,
        allocatedCursor(index + 2),
      )),
    ];
    // Import one already-committed predecessor generation so preparation is
    // the deterministic semantic barrier under test. Twenty-one independent
    // durable appends would instead make this replay test's fixed timeout a
    // function of unrelated repository-wide fsync contention.
    await writeFile(
      writer.eventsIndexPath(),
      `${initialEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    const reader = new RunStore(runsRoot);
    await reader.prepareGlobalEventAuthority();
    const internal = reader as unknown as {
      parseGlobalEventAuthorityRow: (row: unknown) => CalyxStreamEvent;
    };
    const parseSpy = vi.spyOn(internal, "parseGlobalEventAuthorityRow");
    const collect = async (cursor: string | undefined, filter: CalyxRunEventFilter) => {
      const events: CalyxStreamEvent[] = [];
      for await (const event of reader.readEventsSince(cursor, filter)) events.push(event);
      return events;
    };

    await expect(collect(undefined, { run_id: "absent-run" })).resolves.toEqual([]);
    expect(parseSpy).not.toHaveBeenCalled();
    await expect(collect(terminal.cursor, { event_type: "run.terminal" })).resolves.toEqual([]);
    await expect(collect(terminal.cursor, { event_type: "run.terminal" })).resolves.toEqual([]);
    expect(parseSpy).not.toHaveBeenCalled();

    await writer.appendStreamEvent(buildControlEvent(
      "evt-filter-tail-new",
      "2026-05-10T00:02:00.000Z-filter-tail-new",
    ));
    await expect(collect(terminal.cursor, { event_type: "run.terminal" })).resolves.toEqual([]);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    parseSpy.mockClear();
    await expect(collect(terminal.cursor, { event_type: "run.terminal" })).resolves.toEqual([]);
    expect(parseSpy).not.toHaveBeenCalled();
  });

  test("global event authority fails closed on an unknown durable schema version", async () => {
    const store = new RunStore(runsRoot);
    await store.appendStreamEvent(buildControlEvent(
      "evt-authority-schema-version",
      "2026-05-10T00:00:00.000Z-authority-schema-version",
    ));
    const driver = await loadStateDriver();
    const db = driver.open(join(runsRoot, "events.authority.sqlite3"));
    try {
      db.prepare(
        "UPDATE global_event_authority_meta SET value = '999' WHERE key = 'schema_version'",
      ).run();
    } finally {
      db.close();
    }
    await expect(new RunStore(runsRoot).assertGlobalEventIndexReadable())
      .rejects.toThrow(/unsupported global event authority schema version 999/u);
  });

  test("imports unique non-lexical legacy cursors in physical receipt order", async () => {
    const store = new RunStore(runsRoot);
    const events = [
      buildControlEvent(
        "evt-order-reverse-1",
        "2026-07-20T19:23:21.248Z-control-mba-0d500000-0000-4000-8000-000000000000",
      ),
      buildControlEvent(
        "evt-order-reverse-2",
        "2026-07-20T19:23:21.248Z-control-mba-0bfd0000-0000-4000-8000-000000000000",
      ),
    ];
    const original = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    await writeFile(store.eventsIndexPath(), original, "utf8");

    await expect(store.assertGlobalEventIndexReadable()).resolves.toBeUndefined();
    const replayed: CalyxStreamEvent[] = [];
    for await (const event of store.readEventsSince(undefined)) replayed.push(event);
    expect(replayed).toEqual(events);
    await expect(readFile(store.eventsIndexPath(), "utf8")).resolves.toBe(original);

    const allocated = await store.appendStreamEvent(buildControlEvent(
      "evt-order-after-legacy",
      "2026-07-20T19:23:22.000Z-control-mba-after-legacy",
    ));
    expect(allocated.cursor).toBe(allocatedCursor(3));

    const afterFirst: CalyxStreamEvent[] = [];
    for await (const event of store.readEventsSince(events[0]!.cursor)) afterFirst.push(event);
    expect(afterFirst).toEqual([events[1], allocated]);

    const afterDescending: CalyxStreamEvent[] = [];
    for await (const event of store.readEventsSince(events[1]!.cursor)) {
      afterDescending.push(event);
    }
    expect(afterDescending).toEqual([allocated]);
  });

  test.each([
    [
      "duplicate legacy cursors",
      [
        buildControlEvent("evt-order-duplicate-1", "2026-05-10T00:00:00.000Z-order-same"),
        buildControlEvent("evt-order-duplicate-2", "2026-05-10T00:00:00.000Z-order-same"),
      ],
    ],
    [
      "duplicate legacy event ids",
      [
        buildControlEvent("evt-order-duplicate-id", "2026-05-10T00:00:00.000Z-order-id-1"),
        buildControlEvent("evt-order-duplicate-id", "2026-05-10T00:00:00.000Z-order-id-2"),
      ],
    ],
    [
      "legacy cursor after allocated cursor",
      [
        buildControlEvent("evt-order-allocated-first", allocatedCursor(1)),
        buildControlEvent("evt-order-legacy-late", "2026-05-10T00:00:00.000Z-order-legacy-late"),
      ],
    ],
    [
      "allocated ordinal that disagrees with its journal line",
      [{ ...buildControlEvent("evt-order-ordinal", allocatedCursor(2)) }],
    ],
  ])("existing %s fails closed without rewriting journal bytes", async (_name, events) => {
    const store = new RunStore(runsRoot);
    const original = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    await writeFile(store.eventsIndexPath(), original, "utf8");

    await expect(store.assertGlobalEventIndexReadable()).rejects.toBeInstanceOf(EventJournalCorruptionError);
    await expect(store.appendStreamEvent(
      buildControlEvent("evt-after-order-corruption", "2026-05-10T00:02:00.000Z-after-corruption"),
    )).rejects.toBeInstanceOf(EventJournalCorruptionError);
    await expect(readFile(store.eventsIndexPath(), "utf8")).resolves.toBe(original);
  });

  test("duplicate event ids reuse only the exact canonical row and reject divergent payloads", async () => {
    const store = new RunStore(runsRoot);
    const runId = "run-event-id-authority";
    await store.createRun(buildIntent(runId));
    const event = buildRunEvent(runId, { event_id: "evt-event-id-authority" });
    const canonical = await store.appendStreamEvent(event);

    await expect(store.appendStreamEvent({
      ...event,
      summary: { one_line: "divergent outcome under reused identity" },
    })).rejects.toBeInstanceOf(EventJournalEventIdentityConflictError);
    const replayed = await store.appendStreamEvent(event);

    expect(replayed).toEqual(canonical);
    expect(await readStreamRows(store.eventsIndexPath())).toEqual([canonical]);
    expect(await readStreamRows(store.paths(runId).eventsPath)).toEqual([canonical]);
  });

  test("global duplicate repair refuses a divergent local row and heals a missing local row canonically", async () => {
    const store = new RunStore(runsRoot);
    const runId = "run-local-global-authority";
    await store.createRun(buildIntent(runId));
    const event = buildRunEvent(runId, { event_id: "evt-local-global-authority" });
    const canonical = await store.appendStreamEvent(event);
    const divergentLocal = {
      ...event,
      summary: { one_line: "not the globally committed outcome" },
    };
    const localPath = store.paths(runId).eventsPath;
    const divergentBytes = `${JSON.stringify(divergentLocal)}\n`;
    await writeFile(localPath, divergentBytes, "utf8");

    await expect(store.appendStreamEvent(event)).rejects.toBeInstanceOf(EventJournalCorruptionError);
    await expect(readFile(localPath, "utf8")).resolves.toBe(divergentBytes);

    await writeFile(localPath, "", "utf8");
    await expect(store.appendStreamEvent(event)).resolves.toEqual(canonical);
    expect(await readStreamRows(localPath)).toEqual([canonical]);
  });

  test("invalid unterminated per-run receipt fails closed without truncation or cursor reuse", async () => {
    const store = new RunStore(runsRoot);
    const runId = "run-local-invalid-tail";
    await store.createRun(buildIntent(runId));
    const event = buildRunEvent(runId, { event_id: "evt-local-invalid-tail" });
    const canonical = await store.appendStreamEvent(event);
    const localPath = store.paths(runId).eventsPath;
    const corruptBytes = `${await readFile(localPath, "utf8")}{"uncommitted":`;
    await writeFile(localPath, corruptBytes, "utf8");

    await expect(store.appendStreamEvent(event)).rejects.toBeInstanceOf(EventJournalCorruptionError);
    await expect(readFile(localPath, "utf8")).resolves.toBe(corruptBytes);
    const next = await store.appendStreamEvent(buildControlEvent(
      "evt-after-local-invalid-tail",
      "2026-05-10T00:02:00.000Z-after-local-invalid-tail",
    ));
    expect(canonical.cursor).toBe(allocatedCursor(1));
    expect(next.cursor).toBe(allocatedCursor(2));
  });

  test("global preparation defers a corrupt per-run projection for authority-aware service recovery", async () => {
    const store = new RunStore(runsRoot);
    const runId = "run-deferred-corrupt-projection";
    await store.createRun(buildIntent(runId));
    const event = await store.appendStreamEvent(buildRunEvent(runId, {
      event_id: "evt-deferred-corrupt-projection",
    }));
    const localPath = store.paths(runId).eventsPath;
    const corruptBytes = `${await readFile(localPath, "utf8")}{"uncommitted":`;
    await writeFile(localPath, corruptBytes, "utf8");
    const driver = await loadStateDriver();
    const db = driver.open(join(runsRoot, "events.authority.sqlite3"));
    try {
      db.prepare(
        "UPDATE global_event_authority SET run_receipt_written = 0 WHERE event_id = ?",
      ).run(event.event_id);
    } finally {
      db.close();
    }

    await expect(new RunStore(runsRoot).prepareGlobalEventAuthority()).resolves.toBeUndefined();
    await expect(readFile(localPath, "utf8")).resolves.toBe(corruptBytes);
    const verified = driver.openReadOnly(join(runsRoot, "events.authority.sqlite3"));
    try {
      expect(verified.prepare(
        "SELECT run_receipt_written FROM global_event_authority WHERE event_id = ?",
      ).get(event.event_id)).toEqual({ run_receipt_written: 0 });
    } finally {
      verified.close();
    }
  });

  test("startup defers and exact-idempotently repairs duplicate per-run event identities", async () => {
    const store = new RunStore(runsRoot);
    const runId = "run-duplicate-projection-identity";
    await store.createRun(buildIntent(runId));
    const event = buildRunEvent(runId, { event_id: "evt-duplicate-projection-identity" });
    const canonical = await store.appendStreamEvent(event);
    const localPath = store.paths(runId).eventsPath;
    const duplicateBytes = `${JSON.stringify(canonical)}\n${JSON.stringify(canonical)}\n`;
    await writeFile(localPath, duplicateBytes, "utf8");

    const restarted = new RunStore(runsRoot);
    await expect(restarted.prepareGlobalEventAuthority()).resolves.toBeUndefined();
    await expect(restarted.readEvents(runId)).rejects.toMatchObject({
      filePath: localPath,
      lineNumber: 2,
    });
    const quarantinedPath = await restarted.quarantineEventJournal(runId);
    expect(quarantinedPath).toEqual(expect.stringContaining(`${localPath}.corrupt.`));
    await expect(readFile(quarantinedPath!, "utf8")).resolves.toBe(duplicateBytes);

    await expect(restarted.appendStreamEvent(event)).resolves.toEqual(canonical);
    expect(await readStreamRows(localPath)).toEqual([canonical]);
  });

  test("startup defers and exact-idempotently repairs divergent per-run event identities", async () => {
    const store = new RunStore(runsRoot);
    const runId = "run-divergent-projection-identity";
    await store.createRun(buildIntent(runId));
    const event = buildRunEvent(runId, { event_id: "evt-divergent-projection-identity" });
    const canonical = await store.appendStreamEvent(event);
    const localPath = store.paths(runId).eventsPath;
    const divergentBytes = `${JSON.stringify({
      ...canonical,
      summary: { one_line: "divergent per-run projection" },
    })}\n`;
    await writeFile(localPath, divergentBytes, "utf8");

    const restarted = new RunStore(runsRoot);
    await expect(restarted.prepareGlobalEventAuthority()).resolves.toBeUndefined();
    await expect(restarted.readEvents(runId)).rejects.toMatchObject({
      filePath: localPath,
      lineNumber: 1,
    });
    const quarantinedPath = await restarted.quarantineEventJournal(runId);
    expect(quarantinedPath).toEqual(expect.stringContaining(`${localPath}.corrupt.`));
    await expect(readFile(quarantinedPath!, "utf8")).resolves.toBe(divergentBytes);

    await expect(restarted.appendStreamEvent(event)).resolves.toEqual(canonical);
    expect(await readStreamRows(localPath)).toEqual([canonical]);
  });

  test("quarantine preserves verified local launch, lifecycle, and reconcile authority around a corrupt global row", async () => {
    const store = new RunStore(runsRoot);
    const runId = "run-mixed-local-global-quarantine";
    await store.createRun(buildIntent(runId));
    const launchIntent = {
      timestamp: "2026-05-10T00:00:00.000Z",
      run_id: runId,
      source: "run-service" as const,
      event: "launch_intent" as const,
      message: "Persisted the launch effect intent.",
      payload: { correlation_id: "launch-1" },
    };
    const lifecycleDispatch = {
      timestamp: "2026-05-10T00:00:01.000Z",
      run_id: runId,
      event: "dispatch_started" as const,
      message: "Dispatch began.",
    };
    const reconcileIntent = {
      timestamp: "2026-05-10T00:00:03.000Z",
      run_id: runId,
      source: "run-service" as const,
      event: "reconcile_intent" as const,
      message: "Persisted the reconcile effect intent.",
      payload: { correlation_id: "reconcile-1" },
    };
    const reconcileResult = {
      timestamp: "2026-05-10T00:00:04.000Z",
      run_id: runId,
      source: "run-service" as const,
      event: "reconcile_result" as const,
      message: "Persisted the reconcile effect result.",
      payload: { correlation_id: "reconcile-1", outcome: "completed" },
    };
    await store.appendEvent(runId, launchIntent);
    await store.appendEvent(runId, lifecycleDispatch);
    const canonical = await store.appendStreamEvent(buildRunEvent(runId, {
      event_id: "evt-mixed-local-global-quarantine",
    }));
    await store.appendEvent(runId, reconcileIntent);
    await store.appendEvent(runId, reconcileResult);

    const localPath = store.paths(runId).eventsPath;
    const corruptGlobal = {
      ...canonical,
      summary: { one_line: "corrupt global projection amid local authority" },
    };
    const corruptBytes = `${[
      launchIntent,
      lifecycleDispatch,
      corruptGlobal,
      reconcileIntent,
      reconcileResult,
    ].map((row) => JSON.stringify(row)).join("\n")}\n`;
    await writeFile(localPath, corruptBytes, "utf8");

    const restarted = new RunStore(runsRoot);
    await restarted.prepareGlobalEventAuthority();
    await expect(restarted.readEvents(runId)).rejects.toBeInstanceOf(
      EventJournalCorruptionError,
    );
    const quarantinedPath = await restarted.quarantineEventJournal(runId);

    expect(quarantinedPath).toEqual(expect.stringContaining(`${localPath}.corrupt.`));
    await expect(readFile(quarantinedPath!, "utf8")).resolves.toBe(corruptBytes);
    const repaired = (await readFile(localPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(repaired).toEqual([
      launchIntent,
      lifecycleDispatch,
      canonical,
      reconcileIntent,
      reconcileResult,
    ]);
  });

  test("quarantine replays the full SQLite authority before cached startup health clears", async () => {
    const store = new RunStore(runsRoot);
    const runId = "run-quarantine-full-authority-replay";
    await store.createRun(buildIntent(runId));
    const first = await store.appendStreamEvent(buildRunEvent(runId, {
      event_id: "evt-quarantine-full-authority-replay-1",
    }));
    const second = await store.appendStreamEvent(buildRunEvent(runId, {
      event_id: "evt-quarantine-full-authority-replay-2",
    }));
    const localPath = store.paths(runId).eventsPath;
    const corruptBytes = `${JSON.stringify({
      ...first,
      summary: { one_line: "divergent first projection row" },
    })}\n`;
    await writeFile(localPath, corruptBytes, "utf8");

    // Production startup scans every per-run projection even though all
    // durable markers from the prior healthy generation remain current.
    const restarted = new RunStore(runsRoot);
    await restarted.prepareGlobalEventAuthority();
    const driver = await loadStateDriver();
    const authorityPath = join(runsRoot, "events.authority.sqlite3");
    const beforeRepair = driver.openReadOnly(authorityPath);
    try {
      const markers = beforeRepair.prepare(
        `SELECT run_receipt_written FROM global_event_authority
         WHERE run_id = ? ORDER BY ordinal ASC`,
      ).all(runId) as Array<{ run_receipt_written: number | bigint }>;
      expect(markers.map((row) => Number(row.run_receipt_written))).toEqual([1, 1]);
    } finally {
      beforeRepair.close();
    }
    await expect(restarted.readEvents(runId)).rejects.toBeInstanceOf(EventJournalCorruptionError);

    const quarantinedPath = await restarted.quarantineEventJournal(runId);
    expect(quarantinedPath).toEqual(expect.stringContaining(`${localPath}.corrupt.`));
    await expect(readFile(quarantinedPath!, "utf8")).resolves.toBe(corruptBytes);
    expect(await readStreamRows(localPath)).toEqual([first, second]);

    const third = await restarted.appendStreamEvent(buildRunEvent(runId, {
      event_id: "evt-quarantine-full-authority-replay-3",
    }));
    expect(await readStreamRows(localPath)).toEqual([first, second, third]);
    const afterRepair = driver.openReadOnly(authorityPath);
    try {
      const markers = afterRepair.prepare(
        `SELECT run_receipt_written FROM global_event_authority
         WHERE run_id = ? ORDER BY ordinal ASC`,
      ).all(runId) as Array<{ run_receipt_written: number | bigint }>;
      expect(markers.map((row) => Number(row.run_receipt_written))).toEqual([1, 1, 1]);
    } finally {
      afterRepair.close();
    }
  });

  test("quarantine validates the promoted journal without whole-file materialization", async () => {
    const store = new RunStore(runsRoot);
    const runId = "run-quarantine-streaming-validation";
    await store.createRun(buildIntent(runId));
    const first = await store.appendStreamEvent(buildRunEvent(runId, {
      event_id: "evt-quarantine-streaming-validation-1",
    }));
    const second = await store.appendStreamEvent(buildRunEvent(runId, {
      event_id: "evt-quarantine-streaming-validation-2",
    }));
    const localPath = store.paths(runId).eventsPath;
    await writeFile(localPath, `${JSON.stringify({
      ...first,
      summary: { one_line: "divergent streaming projection" },
    })}\n`, "utf8");

    const restarted = new RunStore(runsRoot);
    await restarted.prepareGlobalEventAuthority();
    await expect(restarted.readEvents(runId)).rejects.toBeInstanceOf(EventJournalCorruptionError);

    const internals = restarted as unknown as {
      readEventLinesOwned: (...args: unknown[]) => Promise<unknown[]>;
    };
    internals.readEventLinesOwned = async () => {
      throw new Error("whole-file journal reader must not run during quarantine validation");
    };

    await expect(restarted.quarantineEventJournal(runId))
      .resolves.toEqual(expect.stringContaining(`${localPath}.corrupt.`));
    expect(await readStreamRows(localPath)).toEqual([first, second]);

    const driver = await loadStateDriver();
    const authority = driver.openReadOnly(join(runsRoot, "events.authority.sqlite3"));
    try {
      const markers = authority.prepare(
        `SELECT run_receipt_written FROM global_event_authority
         WHERE run_id = ? ORDER BY ordinal ASC`,
      ).all(runId) as Array<{ run_receipt_written: number | bigint }>;
      expect(markers.map((row) => Number(row.run_receipt_written))).toEqual([1, 1]);
    } finally {
      authority.close();
    }
  });

  test("a peer repair releases another store's cached corruption fence for append and retry", async () => {
    const seed = new RunStore(runsRoot);
    const runId = "run-cross-store-projection-repair";
    await seed.createRun(buildIntent(runId));
    const first = await seed.appendStreamEvent(buildRunEvent(runId, {
      event_id: "evt-cross-store-projection-repair-1",
    }));
    const localPath = seed.paths(runId).eventsPath;
    await writeFile(localPath, `${JSON.stringify({
      ...first,
      summary: { one_line: "divergent peer projection" },
    })}\n`, "utf8");

    const repairingStore = new RunStore(runsRoot);
    const retryingStore = new RunStore(runsRoot);
    await repairingStore.prepareGlobalEventAuthority();
    await retryingStore.prepareGlobalEventAuthority();
    await expect(repairingStore.readEvents(runId))
      .rejects.toBeInstanceOf(EventJournalCorruptionError);
    await expect(retryingStore.readEvents(runId))
      .rejects.toBeInstanceOf(EventJournalCorruptionError);

    await expect(repairingStore.quarantineEventJournal(runId))
      .resolves.toEqual(expect.stringContaining(`${localPath}.corrupt.`));
    const secondInput = buildRunEvent(runId, {
      event_id: "evt-cross-store-projection-repair-2",
    });
    const second = await retryingStore.appendStreamEvent(secondInput);
    await expect(retryingStore.appendStreamEvent(secondInput)).resolves.toEqual(second);
    expect(await readStreamRows(localPath)).toEqual([first, second]);
    await expect(retryingStore.readEvents(runId)).resolves.toEqual([first, second]);
  });

  test("a same-run append committed after quarantine replay retains its pending marker", async () => {
    const seed = new RunStore(runsRoot);
    const runId = "run-concurrent-quarantine-append";
    await seed.createRun(buildIntent(runId));
    const first = await seed.appendStreamEvent(buildRunEvent(runId, {
      event_id: "evt-concurrent-quarantine-append-1",
    }));
    const second = await seed.appendStreamEvent(buildRunEvent(runId, {
      event_id: "evt-concurrent-quarantine-append-2",
    }));
    const localPath = seed.paths(runId).eventsPath;
    await writeFile(localPath, `${JSON.stringify({
      ...first,
      summary: { one_line: "divergent concurrent projection" },
    })}\n`, "utf8");

    const repairingStore = new RunStore(runsRoot);
    const appendingStore = new RunStore(runsRoot);
    await repairingStore.prepareGlobalEventAuthority();
    await appendingStore.prepareGlobalEventAuthority();

    let reachedFinalReplay!: () => void;
    const finalReplayReached = new Promise<void>((resolve) => {
      reachedFinalReplay = resolve;
    });
    let releaseFinalReplay!: () => void;
    const finalReplayReleased = new Promise<void>((resolve) => {
      releaseFinalReplay = resolve;
    });
    const internals = repairingStore as unknown as {
      projectRunAuthorityIntoJournalOwned: (...args: unknown[]) => Promise<void>;
    };
    const originalReplay = internals.projectRunAuthorityIntoJournalOwned.bind(repairingStore);
    let replayCalls = 0;
    let paused = false;
    internals.projectRunAuthorityIntoJournalOwned = async (...args: unknown[]) => {
      replayCalls += 1;
      await originalReplay(...args);
      if (replayCalls === 2 && !paused) {
        paused = true;
        reachedFinalReplay();
        await finalReplayReleased;
      }
    };

    const quarantine = repairingStore.quarantineEventJournal(runId);
    let append: Promise<CalyxRunEvent> | undefined;
    try {
      await finalReplayReached;
      const concurrentInput = buildRunEvent(runId, {
        event_id: "evt-concurrent-quarantine-append-3",
      });
      append = appendingStore.appendStreamEvent(concurrentInput);

      const driver = await loadStateDriver();
      const authorityPath = join(runsRoot, "events.authority.sqlite3");
      const deadline = Date.now() + 5_000;
      let concurrentMarker: number | undefined;
      while (concurrentMarker === undefined) {
        const db = driver.openReadOnly(authorityPath);
        try {
          const row = db.prepare(
            `SELECT run_receipt_written FROM global_event_authority
             WHERE event_id = ?`,
          ).get(concurrentInput.event_id) as { run_receipt_written: number | bigint } | undefined;
          if (row) concurrentMarker = Number(row.run_receipt_written);
        } finally {
          db.close();
        }
        if (concurrentMarker === undefined) {
          if (Date.now() >= deadline) throw new Error("concurrent authority append did not commit");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      expect(concurrentMarker).toBe(0);
      expect(await readStreamRows(localPath)).toEqual([first, second]);

      releaseFinalReplay();
      await expect(quarantine)
        .resolves.toEqual(expect.stringContaining(`${localPath}.corrupt.`));
      const third = await append;
      expect(await readStreamRows(localPath)).toEqual([first, second, third]);
      const verified = driver.openReadOnly(authorityPath);
      try {
        const markers = verified.prepare(
          `SELECT run_receipt_written FROM global_event_authority
           WHERE run_id = ? ORDER BY ordinal ASC`,
        ).all(runId) as Array<{ run_receipt_written: number | bigint }>;
        expect(markers.map((row) => Number(row.run_receipt_written))).toEqual([1, 1, 1]);
      } finally {
        verified.close();
      }
    } finally {
      releaseFinalReplay();
      await Promise.allSettled([quarantine, ...(append ? [append] : [])]);
    }
  });

  test("one damaged run projection does not obstruct unrelated run or control acknowledgements", async () => {
    const store = new RunStore(runsRoot);
    const damagedRunId = "run-projection-isolation-damaged";
    const healthyRunId = "run-projection-isolation-healthy";
    await store.createRun(buildIntent(damagedRunId));
    await store.createRun(buildIntent(healthyRunId));
    const damagedInput = buildRunEvent(damagedRunId, {
      event_id: "evt-projection-isolation-damaged-1",
    });
    const damagedCanonical = await store.appendStreamEvent(damagedInput);
    const damagedPath = store.paths(damagedRunId).eventsPath;
    const corruptBytes = `${JSON.stringify({
      ...damagedCanonical,
      summary: { one_line: "parseable but divergent projection" },
    })}\n`;
    await writeFile(damagedPath, corruptBytes, "utf8");
    const driver = await loadStateDriver();
    const authorityPath = join(runsRoot, "events.authority.sqlite3");
    const damagedDb = driver.open(authorityPath);
    try {
      damagedDb.prepare(
        "UPDATE global_event_authority SET run_receipt_written = 0 WHERE event_id = ?",
      ).run(damagedCanonical.event_id);
    } finally {
      damagedDb.close();
    }

    const restarted = new RunStore(runsRoot);
    await expect(restarted.prepareGlobalEventAuthority()).resolves.toBeUndefined();
    const affectedInput = buildRunEvent(damagedRunId, {
      event_id: "evt-projection-isolation-damaged-2",
    });
    await expect(restarted.appendStreamEvent(affectedInput))
      .rejects.toBeInstanceOf(EventJournalCorruptionError);

    const healthy = await restarted.appendStreamEvent(buildRunEvent(healthyRunId, {
      event_id: "evt-projection-isolation-healthy",
    }));
    const control = await restarted.appendStreamEvent(buildControlEvent(
      "evt-projection-isolation-control",
      "2026-05-10T00:02:00.000Z-projection-isolation-control",
    ));
    expect(healthy.cursor).toBe(allocatedCursor(3));
    expect(control.cursor).toBe(allocatedCursor(4));
    expect(await readStreamRows(restarted.paths(healthyRunId).eventsPath)).toEqual([healthy]);
    await expect(readFile(damagedPath, "utf8")).resolves.toBe(corruptBytes);

    const pendingDb = driver.openReadOnly(authorityPath);
    try {
      const rows = pendingDb.prepare(
        `SELECT event_id, run_receipt_written FROM global_event_authority
         WHERE run_id IS NOT NULL ORDER BY ordinal ASC`,
      ).all() as Array<{ event_id: string; run_receipt_written: number | bigint }>;
      expect(rows.map((row) => ({
        event_id: row.event_id,
        run_receipt_written: Number(row.run_receipt_written),
      }))).toEqual([
        { event_id: damagedCanonical.event_id, run_receipt_written: 0 },
        { event_id: affectedInput.event_id, run_receipt_written: 0 },
        { event_id: healthy.event_id, run_receipt_written: 1 },
      ]);
    } finally {
      pendingDb.close();
    }

    await expect(restarted.quarantineEventJournal(damagedRunId))
      .resolves.toEqual(expect.stringContaining(`${damagedPath}.corrupt.`));
    const repaired = await restarted.appendStreamEvent(affectedInput);
    expect(repaired.cursor).toBe(allocatedCursor(2));
    expect(await readStreamRows(damagedPath)).toEqual([damagedCanonical, repaired]);
    const repairedDb = driver.openReadOnly(authorityPath);
    try {
      const rows = repairedDb.prepare(
        `SELECT run_receipt_written FROM global_event_authority
         WHERE run_id = ? ORDER BY ordinal ASC`,
      ).all(damagedRunId) as Array<{ run_receipt_written: number | bigint }>;
      expect(rows.map((row) => Number(row.run_receipt_written))).toEqual([1, 1]);
    } finally {
      repairedDb.close();
    }
  });

  test("restart reconciliation backfills transiently missed SQLite projections exactly", async () => {
    const event = buildControlEvent(
      "evt-restart-backfill",
      "2026-05-10T00:01:00.000Z-restart-backfill",
    );
    const failing = new RunStore(runsRoot, {
      eventLogIngest: async () => {
        throw new Error("transient projection outage");
      },
    });
    await failing.appendStreamEvent(event);

    const sink = new OrchestrationLedgerSink({ source: "test" });
    const restarted = new RunStore(runsRoot, {
      eventLogIngest: (candidate) => sink.ingestStreamEvent(candidate),
    });
    await restarted.assertGlobalEventIndexReadable();
    sink.close();

    const opened = await openStateStore();
    try {
      expect(listEventsByAggregate(opened.db, "daemon", "blade-default")).toEqual([
        expect.objectContaining({
          event_id: event.event_id,
          cursor: allocatedCursor(1),
        }),
      ]);
    } finally {
      opened.db.close();
    }
  });

  test("restart reconciliation publishes pending global and per-run receipts without a new append", async () => {
    const runId = "run-restart-pending-receipts";
    const store = new RunStore(runsRoot);
    await store.createRun(buildIntent(runId));
    const event = await store.appendStreamEvent(buildRunEvent(runId, {
      event_id: "evt-restart-pending-receipts",
    }));
    await writeFile(store.eventsIndexPath(), "", "utf8");
    await writeFile(store.paths(runId).eventsPath, "", "utf8");
    const driver = await loadStateDriver();
    const db = driver.open(join(runsRoot, "events.authority.sqlite3"));
    try {
      db.prepare(
        `UPDATE global_event_authority
         SET receipt_written = 0 WHERE event_id = ?`,
      ).run(event.event_id);
      db.prepare(
        "UPDATE global_event_authority_meta SET value = '0' WHERE key = 'receipt_bytes'",
      ).run();
    } finally {
      db.close();
    }

    await new RunStore(runsRoot).assertGlobalEventIndexReadable();
    expect(await readStreamRows(store.eventsIndexPath())).toEqual([event]);
    expect(await readStreamRows(store.paths(runId).eventsPath)).toEqual([event]);
  });

  test("explicit reconcile rejects same-byte JSONL receipt mutation", async () => {
    const store = new RunStore(runsRoot);
    const event = await store.appendStreamEvent(buildControlEvent(
      "evt-same-byte-receipt-A",
      "2026-05-10T00:01:00.000Z-same-byte-receipt",
    ));
    const original = await readFile(store.eventsIndexPath(), "utf8");
    const mutated = original.replace(event.event_id, "evt-same-byte-receipt-B");
    expect(Buffer.byteLength(mutated)).toBe(Buffer.byteLength(original));
    await writeFile(store.eventsIndexPath(), mutated, "utf8");

    await expect(store.assertGlobalEventIndexReadable())
      .rejects.toBeInstanceOf(EventJournalCorruptionError);
    const replayed: CalyxStreamEvent[] = [];
    for await (const candidate of store.readEventsSince(undefined)) replayed.push(candidate);
    expect(replayed).toEqual([event]);
  });

  test("explicit reconcile validates logical authority row identity, not only SQLite pages", async () => {
    const store = new RunStore(runsRoot);
    await store.appendStreamEvent(buildControlEvent(
      "evt-logical-authority-corruption",
      "2026-05-10T00:01:00.000Z-logical-authority-corruption",
    ));
    const driver = await loadStateDriver();
    const db = driver.open(join(runsRoot, "events.authority.sqlite3"));
    try {
      db.exec("DROP TRIGGER global_event_authority_identity_immutable");
      db.prepare(
        "UPDATE global_event_authority SET identity_hash = ? WHERE event_id = ?",
      ).run("0".repeat(64), "evt-logical-authority-corruption");
    } finally {
      db.close();
    }

    await expect(store.assertGlobalEventIndexReadable())
      .rejects.toBeInstanceOf(EventJournalCorruptionError);
  });

  test("restart backfill quarantines a conflicting event identity and keeps mirroring", async () => {
    // Was: this rejected the whole backfill. One divergent row then blocked
    // every subsequent event forever, which is how a single 2026-05-11 event
    // made worm permanently unupgradeable (POL-2090). The divergence is still
    // never silently mirrored — it is set aside with both versions recorded and
    // surfaced by `calyx state doctor` — but it no longer halts the mirror.
    const event = buildControlEvent(
      "evt-backfill-identity-conflict",
      "2026-05-10T00:01:00.000Z-backfill-identity-conflict",
    );
    await new RunStore(runsRoot).appendStreamEvent(event);
    const sink = new OrchestrationLedgerSink({ source: "test", strict: true });
    await sink.ingestStreamEvent({
      ...event,
      cursor: "z1-00000000000000000099",
      control: { host: "blade", daemon_id: "divergent-daemon" },
    });
    const restarted = new RunStore(runsRoot, {
      eventLogIngest: (candidate) => sink.ingestStreamEvent(candidate),
    });
    await expect(restarted.assertGlobalEventIndexReadable()).resolves.toBeUndefined();

    const quarantined = await listEventLogQuarantineRecords(stateHome);
    expect(quarantined.total).toBeGreaterThan(0);
    expect(
      quarantined.entries.some((e) => e.record?.event_id === "evt-backfill-identity-conflict"),
    ).toBe(true);
    expect(sink.isDisabled).toBe(false);
    sink.close();
  });

  test("large legacy history is indexed once and tail replay remains bounded", async () => {
    const rowCount = 2_000;
    const rows = Array.from({ length: rowCount }, (_, index) => buildControlEvent(
      `evt-scale-${String(index + 1).padStart(6, "0")}`,
      `2026-05-10T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z-scale-${String(index + 1).padStart(6, "0")}`,
    ));
    await writeFile(
      join(runsRoot, "events.index.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
    const store = new RunStore(runsRoot);
    await store.assertGlobalEventIndexReadable();
    const tail: CalyxStreamEvent[] = [];
    for await (const event of store.readEventsSince(rows[rowCount - 11]!.cursor)) tail.push(event);
    expect(tail.map((event) => event.event_id)).toEqual(
      rows.slice(rowCount - 10).map((event) => event.event_id),
    );
    const appended = await store.appendStreamEvent(buildControlEvent(
      "evt-scale-appended",
      "2020-01-01T00:00:00.000Z-producer-regressed",
    ));
    expect(appended.cursor).toBe(allocatedCursor(rowCount + 1));
  });

  test("explicit reconcile and a concurrent writer observe one serialized authority boundary", async () => {
    const seedCount = 200;
    const seed = Array.from({ length: seedCount }, (_, index) => buildControlEvent(
      `evt-reconcile-boundary-${String(index + 1).padStart(4, "0")}`,
      `2026-05-10T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z-reconcile-boundary-${String(index + 1).padStart(4, "0")}`,
    ));
    await writeFile(
      join(runsRoot, "events.index.jsonl"),
      `${seed.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );
    const reconciler = new RunStore(runsRoot);
    const writer = new RunStore(runsRoot);
    await Promise.all([
      reconciler.assertGlobalEventIndexReadable(),
      writer.appendStreamEvent(buildControlEvent(
        "evt-concurrent-reconcile-writer",
        "2020-01-01T00:00:00.000Z-concurrent-reconcile-writer",
      )),
    ]);
    await reconciler.assertGlobalEventIndexReadable();
    const replayed: CalyxStreamEvent[] = [];
    for await (const event of reconciler.readEventsSince(undefined)) replayed.push(event);
    expect(replayed).toHaveLength(seedCount + 1);
    expect(replayed.at(-1)).toMatchObject({
      event_id: "evt-concurrent-reconcile-writer",
      cursor: allocatedCursor(seedCount + 1),
    });
  });

  test("control events mirror under domain=control / aggregate_type=daemon", async () => {
    const sink = new OrchestrationLedgerSink({ source: "test" });
    const store = new RunStore(runsRoot, {
      eventLogIngest: (event) => sink.ingestStreamEvent(event),
    });

    const ev = buildControlEvent("evt-ctl-A", "2026-05-10T00:01:00.000Z-ctl-000001");
    await store.appendStreamEvent(ev);
    // Dedup on repeat.
    await store.appendStreamEvent(ev);

    sink.close();

    const opened = await openStateStore();
    try {
      const rows = listEventsByAggregate(opened.db, "daemon", "blade-default");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.domain).toBe("control");
    } finally {
      opened.db.close();
    }
  });

  test("RunStore without an eventLogIngest sink keeps existing JSONL behavior unchanged", async () => {
    // Wave 1 contract: omitting the sink still works (sink is optional).
    const store = new RunStore(runsRoot);
    await store.createRun(buildIntent("run-D"));
    const event = buildRunEvent("run-D");
    await store.appendStreamEvent(event);

    const perRun = await readFile(store.paths("run-D").eventsPath, "utf8");
    expect(perRun).toContain(event.event_id);
    const indexed = await readFile(store.eventsIndexPath(), "utf8");
    expect(indexed).toContain(event.event_id);

    // No SQLite write happened — the table is still empty.
    const opened = await openStateStore();
    try {
      expect(countEventsByAggregate(opened.db, "run", "run-D")).toBe(0);
    } finally {
      opened.db.close();
    }
  });

  test("interior JSONL receipt corruption cannot shrink or replace SQLite replay authority", async () => {
    const store = new RunStore(runsRoot);
    await store.createRun(buildIntent("run-index-corruption-A"));
    await store.createRun(buildIntent("run-index-corruption-B"));
    const first = buildRunEvent("run-index-corruption-A", {
      event_id: "evt-index-corruption-A",
      cursor: "2026-05-10T00:00:00.000Z-index-000001",
    });
    const second = buildRunEvent("run-index-corruption-B", {
      event_id: "evt-index-corruption-B",
      cursor: "2026-05-10T00:00:01.000Z-index-000002",
    });
    await store.appendStreamEvent(first);
    await store.appendStreamEvent(second);

    const validLines = (await readFile(store.eventsIndexPath(), "utf8")).trimEnd().split("\n");
    const corrupted = `${validLines[0]}\n{"complete_but_malformed":\n${validLines[1]}\n`;
    await writeFile(store.eventsIndexPath(), corrupted, "utf8");
    const collect = async () => {
      const events: CalyxRunEvent[] = [];
      for await (const event of store.readEventsSince(undefined)) {
        if (event.event_type === "run.terminal") events.push(event as CalyxRunEvent);
      }
      return events;
    };

    await expect(collect()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: first.event_id }),
      expect.objectContaining({ event_id: second.event_id }),
    ]));
    await expect(store.assertGlobalEventIndexReadable()).rejects.toBeInstanceOf(EventJournalCorruptionError);
    await expect(store.appendStreamEvent(buildRunEvent("run-index-corruption-A", {
      event_id: "evt-index-corruption-C",
      cursor: "2026-05-10T00:00:02.000Z-index-000003",
    }))).rejects.toBeInstanceOf(EventJournalCorruptionError);
    await expect(collect()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: "evt-index-corruption-C", cursor: allocatedCursor(3) }),
    ]));
    await expect(readFile(store.eventsIndexPath(), "utf8")).resolves.toBe(corrupted);
    expect((await readdir(runsRoot)).some((entry) => entry.startsWith("events.index.jsonl.corrupt.")))
      .toBe(false);
  });

  test.each([
    ["unknown event major", {
      ...buildRunEvent("run-index-schema-corruption"),
      schema_version: "2.0",
    }],
    ["shallow run-shaped row", {
      schema_version: "1.0",
      event_id: "evt-shallow-corruption",
      cursor: 7,
      emitted_at: "2026-05-10T00:00:00.000Z",
      event_type: "run.terminal",
      emitted_by: "launch",
      run: null,
    }],
  ])("parseable %s cannot enter SQLite replay authority through the JSONL receipt", async (_name, corruptRow) => {
    const store = new RunStore(runsRoot);
    const event = buildRunEvent("run-index-schema-corruption");
    await store.createRun(buildIntent(event.run.run_id));
    await store.appendStreamEvent(event);
    const original = await readFile(store.eventsIndexPath(), "utf8");
    const corrupted = `${JSON.stringify(corruptRow)}\n${original}`;
    await writeFile(store.eventsIndexPath(), corrupted, "utf8");

    const collect = async () => {
      const events = [];
      for await (const candidate of store.readEventsSince(undefined)) events.push(candidate);
      return events;
    };
    await expect(collect()).resolves.toEqual([expect.objectContaining({ event_id: event.event_id })]);
    await expect(store.assertGlobalEventIndexReadable()).rejects.toBeInstanceOf(EventJournalCorruptionError);
    await expect(store.appendStreamEvent(buildRunEvent("run-index-schema-corruption", {
      event_id: "evt-after-schema-corruption",
      cursor: "2026-05-10T00:00:03.000Z-index-000004",
    }))).rejects.toBeInstanceOf(EventJournalCorruptionError);
    await expect(collect()).resolves.toEqual([
      expect.objectContaining({ event_id: event.event_id }),
      expect.objectContaining({ event_id: "evt-after-schema-corruption", cursor: allocatedCursor(2) }),
    ]);
    await expect(readFile(store.eventsIndexPath(), "utf8")).resolves.toBe(corrupted);
  });

  test("same-major response enum additions remain replayable when they do not select a shape", async () => {
    const store = new RunStore(runsRoot);
    const runId = "run-index-open-enums";
    await store.createRun(buildIntent(runId));
    const runEvent = {
      ...buildRunEvent(runId),
      emitted_by: "future_reconciler",
      run: {
        ...buildRunEvent(runId).run,
        state: "future_terminal_state",
        kernel: "future_kernel",
        backend: "future_backend",
        recovery_mode: "future_recovery_mode",
        infra_error_classification: {
          schema_version: "infra_error_classification/v1",
          failure_layer: "future_layer",
          failure_reason: "future_reason",
          message: "Future same-major classification.",
        },
      },
      origin: { launcher_kind: "future_launcher" },
    } as unknown as CalyxRunEvent;
    const controlEvent = {
      ...buildControlEvent(
        "evt-index-open-control-enums",
        "2026-05-10T00:01:00.000Z-index-open-control-enums",
      ),
      emitted_by: "future_health_source",
      control: { host: "blade", severity: "future_severity" },
    } as unknown as CalyxControlEvent;
    await store.appendStreamEvent(runEvent);
    await store.appendStreamEvent(controlEvent);

    const replayed = [];
    for await (const event of store.readEventsSince(undefined)) replayed.push(event);
    expect(replayed).toHaveLength(2);
    expect(replayed[0]).toMatchObject({
      emitted_by: "future_reconciler",
      run: {
        state: "future_terminal_state",
        kernel: "future_kernel",
        backend: "future_backend",
        recovery_mode: "future_recovery_mode",
        infra_error_classification: {
          failure_layer: "future_layer",
          failure_reason: "future_reason",
        },
      },
      origin: { launcher_kind: "future_launcher" },
    });
    expect(replayed[1]).toMatchObject({
      emitted_by: "future_health_source",
      control: { severity: "future_severity" },
    });
  });

  test("a parseable schema-invalid final row fails closed without normalizing its bytes", async () => {
    const store = new RunStore(runsRoot);
    const corruptTail = "{}";
    await writeFile(store.eventsIndexPath(), corruptTail, "utf8");

    await expect(store.assertGlobalEventIndexReadable()).rejects.toBeInstanceOf(EventJournalCorruptionError);
    await expect(store.appendStreamEvent(buildRunEvent("run-after-schema-invalid-tail")))
      .rejects.toBeInstanceOf(EventJournalCorruptionError);
    await expect(readFile(store.eventsIndexPath(), "utf8")).resolves.toBe(corruptTail);
    expect((await readdir(runsRoot)).some((entry) => (
      entry.startsWith("events.index.jsonl.torn.")
      || entry.startsWith("events.index.jsonl.recovery.")
      || entry.startsWith("events.index.jsonl.corrupt.")
    ))).toBe(false);
  });

  test("oversized SSE admission rolls back its authority row and cursor ordinal", async () => {
    const store = new RunStore(runsRoot);
    const base = buildControlEvent(
      "evt-oversized-sse-admission",
      "2026-05-10T00:01:00.000Z-oversized-sse-admission",
    );
    const oversized: CalyxControlEvent = {
      ...base,
      control: {
        ...base.control,
        error: "x".repeat(CALYX_HTTP_SSE_MAX_FRAME_BYTES),
      },
    };

    await expect(store.appendStreamEvent(oversized)).rejects.toMatchObject({
      name: EventSseFrameTooLargeError.name,
      eventId: oversized.event_id,
      maximumBytes: CALYX_HTTP_SSE_MAX_FRAME_BYTES,
    });
    const driver = await loadStateDriver();
    const rejectedDb = driver.openReadOnly(join(runsRoot, "events.authority.sqlite3"));
    try {
      const count = rejectedDb.prepare(
        "SELECT COUNT(*) AS count FROM global_event_authority",
      ).get() as { count: number | bigint };
      expect(Number(count.count)).toBe(0);
    } finally {
      rejectedDb.close();
    }
    await expect(stat(store.eventsIndexPath())).rejects.toMatchObject({ code: "ENOENT" });

    const accepted = await store.appendStreamEvent(buildControlEvent(
      "evt-after-oversized-sse-admission",
      "2026-05-10T00:01:01.000Z-after-oversized-sse-admission",
    ));
    expect(accepted.cursor).toBe(allocatedCursor(1));
    expect(await readStreamRows(store.eventsIndexPath())).toEqual([accepted]);
  });

  test("restart rewrites an exact partial pending global receipt row and rejects a divergent prefix", async () => {
    const store = new RunStore(runsRoot);
    await store.appendStreamEvent(buildControlEvent(
      "evt-partial-global-receipt",
      "2026-05-10T00:01:00.000Z-partial-global-receipt",
    ));
    const receiptPath = store.eventsIndexPath();
    const completeReceipt = await readFile(receiptPath);
    const driver = await loadStateDriver();
    const markPending = () => {
      const db = driver.open(join(runsRoot, "events.authority.sqlite3"));
      try {
        db.prepare(
          "UPDATE global_event_authority SET receipt_written = 0 WHERE event_id = ?",
        ).run("evt-partial-global-receipt");
        db.prepare(
          "UPDATE global_event_authority_meta SET value = '0' WHERE key = 'receipt_bytes'",
        ).run();
      } finally {
        db.close();
      }
    };

    markPending();
    await writeFile(receiptPath, completeReceipt.subarray(0, Math.floor(completeReceipt.length / 2)));
    await expect(new RunStore(runsRoot).assertGlobalEventIndexReadable()).resolves.toBeUndefined();
    await expect(readFile(receiptPath)).resolves.toEqual(completeReceipt);

    markPending();
    const divergentPrefix = Buffer.from(completeReceipt.subarray(0, 16));
    divergentPrefix[0] = 0x5b;
    await writeFile(receiptPath, divergentPrefix);
    await expect(new RunStore(runsRoot).assertGlobalEventIndexReadable())
      .rejects.toThrow(/not an exact prefix/u);
    await expect(readFile(receiptPath)).resolves.toEqual(divergentPrefix);
  });

  test("restart quarantines a complete legacy-writer tail before projecting pending SQLite authority", async () => {
    const store = new RunStore(runsRoot);
    const committed = await store.appendStreamEvent(buildControlEvent(
      "evt-before-legacy-writer-tail",
      "2026-05-10T00:01:00.000Z-before-legacy-writer-tail",
    ));
    const legacyTail = [
      buildControlEvent(
        "evt-legacy-writer-tail-started",
        "2026-05-10T00:02:00.000Z-legacy-writer-tail-started",
      ),
    ];
    const receiptPath = store.eventsIndexPath();
    const authoritativePrefix = await readFile(receiptPath);
    await writeFile(
      receiptPath,
      Buffer.concat([
        authoritativePrefix,
        Buffer.from(`${legacyTail.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8"),
      ]),
    );

    const restarted = new RunStore(runsRoot);
    const pending = await restarted.appendStreamEvent(buildControlEvent(
      "evt-after-legacy-writer-tail",
      "2026-05-10T00:03:00.000Z-after-legacy-writer-tail",
    ));

    expect(pending.cursor).toBe(allocatedCursor(2));
    expect(await readStreamRows(receiptPath)).toEqual([committed, pending]);
    const quarantines = (await readdir(runsRoot))
      .filter((entry) => entry.startsWith("events.index.jsonl.legacy-tail."));
    expect(quarantines).toHaveLength(1);
    expect(await readStreamRows(join(runsRoot, quarantines[0]!))).toEqual([
      committed,
      ...legacyTail,
    ]);

    const driver = await loadStateDriver();
    const db = driver.openReadOnly(join(runsRoot, "events.authority.sqlite3"));
    try {
      const rows = db.prepare(
        `SELECT event_id, receipt_written FROM global_event_authority
         ORDER BY ordinal ASC`,
      ).all() as Array<{ event_id: string; receipt_written: number | bigint }>;
      expect(rows.map((row) => ({
        event_id: row.event_id,
        receipt_written: Number(row.receipt_written),
      }))).toEqual([
        { event_id: committed.event_id, receipt_written: 1 },
        { event_id: pending.event_id, receipt_written: 1 },
      ]);
      const boundary = db.prepare(
        "SELECT value FROM global_event_authority_meta WHERE key = 'receipt_bytes'",
      ).get() as { value: string };
      expect(boundary.value).toBe(String((await stat(receiptPath)).size));
    } finally {
      db.close();
    }
  });

  test("restart does not quarantine an untracked tail that claims an allocated authority cursor", async () => {
    const store = new RunStore(runsRoot);
    await store.appendStreamEvent(buildControlEvent(
      "evt-before-untrusted-authority-tail",
      "2026-05-10T00:01:00.000Z-before-untrusted-authority-tail",
    ));
    const receiptPath = store.eventsIndexPath();
    const authoritativePrefix = await readFile(receiptPath);
    const untrusted = [
      buildControlEvent(
        "evt-untrusted-authority-tail-1",
        allocatedCursor(999),
      ),
      buildControlEvent(
        "evt-untrusted-authority-tail-2",
        allocatedCursor(1_000),
      ),
    ];
    const untrustedBytes = Buffer.from(
      `${untrusted.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );
    await writeFile(
      receiptPath,
      Buffer.concat([
        authoritativePrefix,
        untrustedBytes,
      ]),
    );

    await expect(new RunStore(runsRoot).appendStreamEvent(buildControlEvent(
      "evt-after-untrusted-authority-tail",
      "2026-05-10T00:02:00.000Z-after-untrusted-authority-tail",
    ))).rejects.toThrow(/untracked receipt tail contains an allocated authority cursor/u);
    await expect(readFile(receiptPath)).resolves.toEqual(Buffer.concat([
      authoritativePrefix,
      untrustedBytes,
    ]));
    expect((await readdir(runsRoot))
      .some((entry) => entry.startsWith("events.index.jsonl.legacy-tail.")))
      .toBe(false);
  });

  test("legacy global import streams batches and records its exact byte boundary", async () => {
    const rowCount = 513;
    const rows = Array.from({ length: rowCount }, (_, index) => ({
      ...buildControlEvent(
        `evt-batched-import-${String(index + 1).padStart(4, "0")}`,
        `2026-05-10T00:01:00.000Z-batched-import-${String(index + 1).padStart(4, "0")}`,
      ),
      control: { host: "blåde", daemon_id: "pollinátor" },
    }));
    const receipt = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    await writeFile(join(runsRoot, "events.index.jsonl"), receipt);

    await expect(new RunStore(runsRoot).assertGlobalEventIndexReadable()).resolves.toBeUndefined();
    const driver = await loadStateDriver();
    const db = driver.openReadOnly(join(runsRoot, "events.authority.sqlite3"));
    try {
      const count = db.prepare(
        "SELECT COUNT(*) AS count FROM global_event_authority",
      ).get() as { count: number | bigint };
      const boundary = db.prepare(
        "SELECT value FROM global_event_authority_meta WHERE key = 'receipt_bytes'",
      ).get() as { value: string };
      expect(Number(count.count)).toBe(rowCount);
      expect(boundary.value).toBe(String(receipt.byteLength));
    } finally {
      db.close();
    }
  });

  test("global and per-run JSONL readers reject malformed UTF-8 without replacement", async () => {
    const invalidUtf8Row = Buffer.from([
      0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d, 0x0a,
    ]);
    const store = new RunStore(runsRoot);
    await writeFile(store.eventsIndexPath(), invalidUtf8Row);
    await expect(store.assertGlobalEventIndexReadable()).rejects.toMatchObject({
      filePath: store.eventsIndexPath(),
      lineNumber: 1,
    });
    await expect(readFile(store.eventsIndexPath())).resolves.toEqual(invalidUtf8Row);

    const runId = "run-invalid-utf8";
    await store.createRun(buildIntent(runId));
    await writeFile(store.paths(runId).eventsPath, invalidUtf8Row);
    await expect(store.readEvents(runId)).rejects.toMatchObject({
      filePath: store.paths(runId).eventsPath,
      lineNumber: 1,
    });
    await expect(readFile(store.paths(runId).eventsPath)).resolves.toEqual(invalidUtf8Row);
  });

  test("bounds oversized physical rows across read, repair, and append", async () => {
    const store = new RunStore(runsRoot);
    const runId = "run-oversized-physical-row";
    await store.createRun(buildIntent(runId));
    const oversizedRow = Buffer.alloc(EVENT_JOURNAL_MAX_LINE_BYTES + 1, 0x78);

    await writeFile(store.eventsIndexPath(), oversizedRow);
    await expect(store.assertGlobalEventIndexReadable()).rejects.toMatchObject({
      name: EventJournalCorruptionError.name,
      filePath: store.eventsIndexPath(),
      lineNumber: 1,
    });
    await expect(stat(store.eventsIndexPath())).resolves.toMatchObject({
      size: oversizedRow.byteLength,
    });

    const localPath = store.paths(runId).eventsPath;
    const terminatedOversizedRow = Buffer.concat([oversizedRow, Buffer.from("\n")]);
    await writeFile(localPath, terminatedOversizedRow);
    await expect(new RunStore(runsRoot).readEvents(runId)).rejects.toMatchObject({
      name: EventJournalCorruptionError.name,
      filePath: localPath,
      lineNumber: 1,
    });
    await expect(stat(localPath)).resolves.toMatchObject({
      size: terminatedOversizedRow.byteLength,
    });

    // Repair consumes the corrupt source in bounded chunks, preserves its
    // exact bytes in quarantine, and skips the unrepresentable physical row.
    await writeFile(store.eventsIndexPath(), "", "utf8");
    const restarted = new RunStore(runsRoot);
    const quarantinedPath = await restarted.quarantineEventJournal(runId);
    expect(quarantinedPath).toEqual(expect.stringContaining(`${localPath}.corrupt.`));
    expect(Buffer.compare(await readFile(quarantinedPath!), terminatedOversizedRow)).toBe(0);
    await expect(restarted.readEvents(runId)).resolves.toEqual([]);

    const beforeRejectedAppend = await readFile(localPath);
    await expect(restarted.appendEvent(runId, {
      timestamp: "2026-05-10T00:02:00.000Z",
      run_id: runId,
      source: "run-service",
      event: "warning",
      message: "x".repeat(EVENT_JOURNAL_MAX_LINE_BYTES),
    })).rejects.toThrow(`event journal row exceeds ${EVENT_JOURNAL_MAX_LINE_BYTES} byte limit`);
    await expect(readFile(localPath)).resolves.toEqual(beforeRejectedAppend);
  });

  test.each([
    ["NBSP", "\u00a0"],
    ["FEFF", "\ufeff"],
  ])("per-run readers quarantine %s-wrapped JSON without normalizing its boundary", async (_name, boundary) => {
    const runId = `run-invalid-json-boundary-${boundary.codePointAt(0)!.toString(16)}`;
    const store = new RunStore(runsRoot);
    await store.createRun(buildIntent(runId));
    const localPath = store.paths(runId).eventsPath;
    const row = {
      timestamp: "2026-05-10T00:00:00.000Z",
      run_id: runId,
      source: "run-service" as const,
      event: "warning" as const,
      message: "boundary whitespace is not JSON whitespace",
    };
    const invalidRow = `${boundary}${JSON.stringify(row)}${boundary}\n`;
    await writeFile(localPath, invalidRow, "utf8");

    const restarted = new RunStore(runsRoot);
    await expect(restarted.readEvents(runId)).rejects.toMatchObject({
      name: EventJournalCorruptionError.name,
      filePath: localPath,
      lineNumber: 1,
    });
    await expect(readFile(localPath, "utf8")).resolves.toBe(invalidRow);

    const quarantinedPath = await restarted.quarantineEventJournal(runId);
    expect(quarantinedPath).toEqual(expect.stringContaining(`${localPath}.corrupt.`));
    await expect(readFile(quarantinedPath!, "utf8")).resolves.toBe(invalidRow);
    await expect(restarted.readEvents(runId)).resolves.toEqual([]);
  });

  test("per-run readers quarantine schema-invalid local rows without normalizing them", async () => {
    const runId = "run-invalid-local-event-schema";
    const store = new RunStore(runsRoot);
    await store.createRun(buildIntent(runId));
    const localPath = store.paths(runId).eventsPath;
    const invalidRow = `${JSON.stringify({
      timestamp: "2026-05-10T00:00:00.000Z",
      run_id: runId,
      source: "run-service",
      event: "warning",
      message: 42,
    })}\n`;
    await writeFile(localPath, invalidRow, "utf8");

    const restarted = new RunStore(runsRoot);
    await expect(restarted.readEvents(runId)).rejects.toMatchObject({
      filePath: localPath,
      lineNumber: 1,
    });
    await expect(readFile(localPath, "utf8")).resolves.toBe(invalidRow);

    const quarantinedPath = await restarted.quarantineEventJournal(runId);
    expect(quarantinedPath).toEqual(expect.stringContaining(`${localPath}.corrupt.`));
    await expect(readFile(quarantinedPath!, "utf8")).resolves.toBe(invalidRow);
    await expect(restarted.readEvents(runId)).resolves.toEqual([]);
  });

  test("local rolling additions survive through payload while unknown top-level fields remain quarantined", async () => {
    const runId = "run-local-event-extension-law";
    const store = new RunStore(runsRoot);
    await store.createRun(buildIntent(runId));
    const localPath = store.paths(runId).eventsPath;
    const runServicePayloadExtension = {
      timestamp: "2026-05-10T00:00:00.000Z",
      run_id: runId,
      source: "run-service" as const,
      event: "warning" as const,
      message: "A newer producer used the local extension channel.",
      payload: {
        future_extension: {
          schema_version: "future.run-service-extension/v1",
          enabled: true,
        },
      },
    };
    const runServiceTopLevelAddition = {
      ...runServicePayloadExtension,
      timestamp: "2026-05-10T00:00:01.000Z",
      future_top_level: { enabled: true },
    };
    const lifecyclePayloadExtension = {
      timestamp: "2026-05-10T00:00:02.000Z",
      run_id: runId,
      event: "warning" as const,
      message: "A newer lifecycle producer used the local extension channel.",
      payload: {
        future_extension: {
          schema_version: "future.lifecycle-extension/v1",
          enabled: true,
        },
      },
    };
    const lifecycleTopLevelAddition = {
      ...lifecyclePayloadExtension,
      timestamp: "2026-05-10T00:00:03.000Z",
      future_top_level: { enabled: true },
    };
    const corruptBytes = `${[
      runServicePayloadExtension,
      runServiceTopLevelAddition,
      lifecyclePayloadExtension,
      lifecycleTopLevelAddition,
    ].map((row) => JSON.stringify(row)).join("\n")}\n`;
    await writeFile(localPath, corruptBytes, "utf8");

    const restarted = new RunStore(runsRoot);
    await expect(restarted.readEvents(runId)).rejects.toMatchObject({
      name: EventJournalCorruptionError.name,
      filePath: localPath,
      lineNumber: 2,
    });

    const quarantinedPath = await restarted.quarantineEventJournal(runId);
    expect(quarantinedPath).toEqual(expect.stringContaining(`${localPath}.corrupt.`));
    await expect(readFile(quarantinedPath!, "utf8")).resolves.toBe(corruptBytes);
    await expect(restarted.readEvents(runId)).resolves.toEqual([
      runServicePayloadExtension,
      lifecyclePayloadExtension,
    ]);
  });

  test("missing-middle per-run projection fails closed then rebuilds its global subsequence in authority order", async () => {
    const runId = "run-missing-middle-projection";
    const store = new RunStore(runsRoot);
    await store.createRun(buildIntent(runId));
    const first = await store.appendStreamEvent(buildRunEvent(runId, {
      event_id: "evt-missing-middle-A",
    }));
    const middle = await store.appendStreamEvent(buildRunEvent(runId, {
      event_id: "evt-missing-middle-B",
    }));
    const last = await store.appendStreamEvent(buildRunEvent(runId, {
      event_id: "evt-missing-middle-C",
    }));
    const localBefore = {
      timestamp: "2026-05-10T00:02:00.000Z",
      run_id: runId,
      source: "run-service" as const,
      event: "warning" as const,
      message: "local before missing row",
    };
    const localAfter = {
      ...localBefore,
      timestamp: "2026-05-10T00:03:00.000Z",
      message: "local after later row",
    };
    const damaged = `${JSON.stringify(first)}\n${JSON.stringify(localBefore)}\n${JSON.stringify(last)}\n${JSON.stringify(localAfter)}\n`;
    const localPath = store.paths(runId).eventsPath;
    await writeFile(localPath, damaged, "utf8");
    const driver = await loadStateDriver();
    const db = driver.open(join(runsRoot, "events.authority.sqlite3"));
    try {
      db.prepare(
        "UPDATE global_event_authority SET run_receipt_written = 0 WHERE event_id = ?",
      ).run(middle.event_id);
    } finally {
      db.close();
    }

    const restarted = new RunStore(runsRoot);
    await expect(restarted.assertGlobalEventIndexReadable()).resolves.toBeUndefined();
    await expect(readFile(localPath, "utf8")).resolves.toBe(damaged);
    await expect(restarted.readEvents(runId)).rejects.toThrow(/omits authority event/u);
    await expect(restarted.quarantineEventJournal(runId))
      .resolves.toEqual(expect.stringContaining(`${localPath}.corrupt.`));

    const repaired = await restarted.readEvents(runId);
    expect(repaired.filter((event) => "event_id" in event).map((event) => (
      event as CalyxStreamEvent
    ).event_id)).toEqual([first.event_id, middle.event_id, last.event_id]);
    expect(repaired.filter((event) => "source" in event).map((event) => (
      event as typeof localBefore
    ).message)).toEqual([localBefore.message, localAfter.message]);
  });

  test("snapshot pagination fails closed without SQLite while non-paged local recovery remains available", async () => {
    const store = new RunStore(runsRoot);
    for (const [runId, createdAt, host] of [
      ["run-page-E", "2026-05-10T00:05:00.000Z", "blade.example"],
      ["run-page-D", "2026-05-10T00:04:00.000Z", "carbon"],
      ["run-page-C", "2026-05-10T00:03:00.000Z", "blade"],
      ["run-page-B", "2026-05-10T00:02:00.000Z", "blade"],
      ["run-page-A", "2026-05-10T00:01:00.000Z", "blade"],
    ] as const) {
      await store.createRun({ run_id: runId, created_at: createdAt, host });
    }

    await expect(store.listRunsPage({ host: "blade", limit: 2 })).rejects.toBeInstanceOf(
      RunIndexProjectionNotReadyError,
    );
    await expect(store.listRuns()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ run_id: "run-page-E" }),
      expect.objectContaining({ run_id: "run-page-A" }),
    ]));
  });

  test("ingestion failure inside the sink does not break JSONL writes", async () => {
    // A failing sink simulates a misconfigured DB. The store must still
    // produce a complete events.jsonl + events.index.jsonl pair.
    const ingestErr = new Error("simulated SQLite write failure");
    const store = new RunStore(runsRoot, {
      eventLogIngest: () => {
        throw ingestErr;
      },
    });
    await store.createRun(buildIntent("run-E"));
    const event = buildRunEvent("run-E");
    await store.appendStreamEvent(event);

    const perRun = await readFile(store.paths("run-E").eventsPath, "utf8");
    expect(perRun).toContain(event.event_id);
    const indexed = await readFile(store.eventsIndexPath(), "utf8");
    expect(indexed).toContain(event.event_id);
  });

  test("disabled sink (migration absent) does not raise; JSONL still complete", async () => {
    // Drop the orchestration-ledger migration to simulate a fresh state DB.
    const opened = await openStateStore();
    try {
      opened.db.exec("DROP TABLE IF EXISTS event_log");
      opened.db.exec("DROP TABLE IF EXISTS event_cursors");
      opened.db.exec("DROP TABLE IF EXISTS locks");
      opened.db.exec("DROP TABLE IF EXISTS source_freshness");
      opened.db.exec("DELETE FROM schema_migrations WHERE id = '0002'");
    } finally {
      opened.db.close();
    }

    const sink = new OrchestrationLedgerSink({ source: "test" });
    const store = new RunStore(runsRoot, {
      eventLogIngest: (event) => sink.ingestStreamEvent(event),
    });

    await store.createRun(buildIntent("run-F"));
    const event = buildRunEvent("run-F");
    await store.appendStreamEvent(event);

    expect(sink.isDisabled).toBe(true);
    const perRun = await readFile(store.paths("run-F").eventsPath, "utf8");
    expect(perRun).toContain(event.event_id);

    sink.close();
  });

  test("JSONL files do not appear under the state directory", async () => {
    const sink = new OrchestrationLedgerSink({ source: "test" });
    const store = new RunStore(runsRoot, {
      eventLogIngest: (event) => sink.ingestStreamEvent(event),
    });
    await store.createRun(buildIntent("run-G"));
    await store.appendStreamEvent(buildRunEvent("run-G"));
    sink.close();

    // Boundary check: the run directory and JSONL receipts live under
    // runsRoot, not under the SQLite state directory.
    await expect(stat(join(stateHome, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(runsRoot, "run-G", "events.jsonl"))).resolves.toMatchObject({});
  });
});
