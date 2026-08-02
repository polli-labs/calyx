import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  acquireLock,
  appendOrchestrationEvent,
  applyStateMigrations,
  checkOrchestrationLedgerSchema,
  countEventsByAggregate,
  listEventsByAggregate,
  listExpiredLocks,
  listStaleSources,
  openStateStore,
  OrchestrationEventIdentityConflictError,
  OrchestrationLedgerSink,
  ORCHESTRATION_LEDGER_TABLES,
  readEventCursor,
  readLock,
  readSourceFreshness,
  releaseLock,
  reportStateHealth,
  runStateDoctor,
  upsertSourceFreshness,
  writeEventCursor,
  type SinkRunStreamEvent,
  type SinkControlStreamEvent,
} from "../state";

async function makeStateHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "calyx-orch-ledger-"));
  return join(root, "state");
}

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;

/**
 * Verbatim capture of the event that wedged `calyx self upgrade` on host
 * `worm` — `~/.calyx/runs/f89e10ba-5d48-45f1-84bc-a19245d73fdb/events.jsonl`.
 * The committed `event_log` row on worm carries the byte-identical payload
 * and differs from a self-upgrade replay only in `source`
 * (`run-service` vs `self-upgrade`). Parsed from JSON rather than written as
 * a typed literal so the fixture stays a capture, not a hand-maintained shape.
 */
const WORM_TERMINAL_EVENT = JSON.parse(`{
  "cursor": "2026-05-11T00:47:15.180Z-f89e10ba-5d48-45f1-84bc-a19245d73fdb-000001",
  "emitted_at": "2026-05-11T00:47:15.180Z",
  "emitted_by": "launch",
  "enrichment": {
    "branch": "caleb/wave-2-4-skill-proposals",
    "worktree_path": "/home/caleb/dev/calyx/wt/caleb/wave-2-4-skill-proposals"
  },
  "event_id": "ce3e7618-756d-49ab-813d-6f3464cdff24",
  "event_type": "run.terminal",
  "origin": { "launcher_kind": "cli" },
  "pointers": {
    "events_path": "/home/caleb/.calyx/runs/f89e10ba-5d48-45f1-84bc-a19245d73fdb/events.jsonl",
    "kernel_receipt_path": "/home/caleb/.calyx/runs/f89e10ba-5d48-45f1-84bc-a19245d73fdb/kernel_receipt.json",
    "run_dir": "/home/caleb/.calyx/runs/f89e10ba-5d48-45f1-84bc-a19245d73fdb",
    "run_record_path": "/home/caleb/.calyx/runs/f89e10ba-5d48-45f1-84bc-a19245d73fdb/run_record.json"
  },
  "run": {
    "backend": "claude",
    "completed_at": "2026-05-11T00:47:15.158Z",
    "created_at": "2026-05-11T00:18:46.125Z",
    "duration_ms": 1708836,
    "host": "worm",
    "issue": "POL-1363",
    "kernel": "agent_runner",
    "recovery_mode": "normal",
    "run_id": "f89e10ba-5d48-45f1-84bc-a19245d73fdb",
    "started_at": "2026-05-11T00:18:46.392Z",
    "state": "succeeded"
  },
  "schema_version": "1.0",
  "summary": { "one_line": "Run f89e10ba-5d48-45f1-84bc-a19245d73fdb succeeded." }
}`) as SinkRunStreamEvent;

describe("orchestration ledger schema (migration 0002)", () => {
  let stateHome: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const k of ENV_KEYS) delete process.env[k];
    stateHome = await makeStateHome();
    process.env["CALYX_STATE_HOME"] = stateHome;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const parent = stateHome.replace(/\/state$/, "");
    await rm(parent, { recursive: true, force: true });
  });

  test("applyStateMigrations creates the orchestration ledger tables and indexes", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      const parity = checkOrchestrationLedgerSchema(opened.db);
      expect(parity.status).toBe("ok");
      expect(parity.findings).toEqual([]);
    } finally {
      opened.db.close();
    }
  });

  test("ORCHESTRATION_LEDGER_TABLES enumerates the four substrate tables", () => {
    const names = ORCHESTRATION_LEDGER_TABLES.map((t) => t.table).sort();
    expect(names).toEqual(["event_cursors", "event_log", "locks", "source_freshness"]);
  });

  test("doctor surfaces orchestration-ledger schema parity green when applied", async () => {
    await applyStateMigrations();
    const report = await runStateDoctor();
    expect(report.orchestrationLedger.migrationApplied).toBe(true);
    expect(report.orchestrationLedger.schemaParity).toBe("ok");
    expect(report.orchestrationLedger.schemaFindings).toEqual([]);
    expect(report.findings.some((f) => f.code === "orchestration-ledger-schema")).toBe(false);
    expect(report.ok).toBe(true);
  });

  test("doctor reports schema drift when an expected table is dropped", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      opened.db.exec("DROP TABLE event_log");
    } finally {
      opened.db.close();
    }
    const report = await runStateDoctor();
    expect(report.orchestrationLedger.schemaParity).toBe("drift");
    expect(report.findings.some((f) => f.code === "orchestration-ledger-schema")).toBe(true);
    expect(report.ok).toBe(false);
  });

  test("doctor reports stale lock + source-freshness fixtures rather than hiding them", async () => {
    await applyStateMigrations();

    const opened = await openStateStore();
    try {
      // Fixture: lock that already expired.
      acquireLock(
        opened.db,
        { lock_key: "test:lock", owner_id: "owner-A", ttl_ms: 1 },
        () => new Date("2026-04-01T00:00:00.000Z"),
      );
      // Fixture: freshness explicitly stale.
      upsertSourceFreshness(opened.db, {
        source_kind: "linear",
        source_id: "INGEST",
        status: "stale",
        observed_at: "2026-05-09T00:00:00.000Z",
        detail: "tracker poll failed",
      });
    } finally {
      opened.db.close();
    }

    const report = await runStateDoctor();
    expect(report.findings.some((f) => f.code === "orchestration-lock-expired")).toBe(true);
    expect(report.findings.some((f) => f.code === "orchestration-source-stale")).toBe(true);
    // Stale-source / expired-lock findings are warnings, not errors —
    // they surface in `findings` without forcing `ok=false`.
    expect(report.ok).toBe(true);
    expect(report.orchestrationLedger.expiredLocks).toHaveLength(1);
    expect(report.orchestrationLedger.expiredLocksTotal).toBe(1);
    expect(report.orchestrationLedger.expiredLocksTruncated).toBe(false);
    expect(report.orchestrationLedger.staleSources).toHaveLength(1);
    expect(report.orchestrationLedger.staleSourcesTotal).toBe(1);
    expect(report.orchestrationLedger.staleSourcesTruncated).toBe(false);
  });

  test("reportStateHealth reflects orchestration ledger status before and after migrate", async () => {
    const before = await reportStateHealth();
    expect(before.orchestrationLedger.migrationApplied).toBe(false);
    expect(before.orchestrationLedger.schemaParity).toBe("absent");

    await applyStateMigrations();

    const after = await reportStateHealth();
    expect(after.orchestrationLedger.migrationApplied).toBe(true);
    expect(after.orchestrationLedger.schemaParity).toBe("ok");
  });
});

describe("orchestration ledger helpers", () => {
  let stateHome: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const k of ENV_KEYS) delete process.env[k];
    stateHome = await makeStateHome();
    process.env["CALYX_STATE_HOME"] = stateHome;
    await applyStateMigrations();
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const parent = stateHome.replace(/\/state$/, "");
    await rm(parent, { recursive: true, force: true });
  });

  test("appendOrchestrationEvent is idempotent on event_id (no duplicate rows)", async () => {
    const opened = await openStateStore();
    try {
      const first = appendOrchestrationEvent(opened.db, {
        event_id: "evt-1",
        domain: "run",
        aggregate_type: "run",
        aggregate_id: "run-A",
        event_type: "run.terminal",
        cursor: "2026-05-10T00:00:00.000Z-run-A-000001",
        occurred_at: "2026-05-10T00:00:00.000Z",
        payload: { state: "succeeded" },
      });
      expect(first.inserted).toBe(true);

      const second = appendOrchestrationEvent(opened.db, {
        event_id: "evt-1",
        domain: "run",
        aggregate_type: "run",
        aggregate_id: "run-A",
        event_type: "run.terminal",
        cursor: "2026-05-10T00:00:00.000Z-run-A-000001",
        occurred_at: "2026-05-10T00:00:00.000Z",
        payload: { state: "succeeded" },
      });
      expect(second.inserted).toBe(false);

      expect(countEventsByAggregate(opened.db, "run", "run-A")).toBe(1);
    } finally {
      opened.db.close();
    }
  });

  test("listEventsByAggregate follows ingest order and treats afterCursor as opaque", async () => {
    const opened = await openStateStore();
    try {
      const cursors = [
        "2026-07-20T19:23:21.248Z-control-mba-0d500000-0000-4000-8000-000000000000",
        "2026-07-20T19:23:21.248Z-control-mba-0bfd0000-0000-4000-8000-000000000000",
        "z1-00000000000000000003",
      ];
      for (let i = 0; i < cursors.length; i++) {
        appendOrchestrationEvent(opened.db, {
          event_id: `evt-${i + 1}`,
          domain: "run",
          aggregate_type: "run",
          aggregate_id: "run-B",
          event_type: "run.terminal",
          cursor: cursors[i]!,
          occurred_at: "2026-05-10T00:00:00.000Z",
          payload: { i },
        });
      }
      const all = listEventsByAggregate(opened.db, "run", "run-B");
      expect(all.map((r) => r.event_id)).toEqual(["evt-1", "evt-2", "evt-3"]);

      const after = listEventsByAggregate(opened.db, "run", "run-B", {
        afterCursor: cursors[0]!,
      });
      expect(after.map((r) => r.event_id)).toEqual(["evt-2", "evt-3"]);
      const afterDescending = listEventsByAggregate(opened.db, "run", "run-B", {
        afterCursor: cursors[1]!,
      });
      expect(afterDescending.map((r) => r.event_id)).toEqual(["evt-3"]);
    } finally {
      opened.db.close();
    }
  });

  test("event_cursors retain the last committed opaque cursor", async () => {
    const opened = await openStateStore();
    try {
      writeEventCursor(opened.db, {
        source: "run-stream",
        domain: "run",
        cursor: "2026-05-10T00:00:00.000Z-run-A-000005",
      });
      writeEventCursor(opened.db, {
        source: "run-stream",
        domain: "run",
        cursor: "2026-05-10T00:00:00.000Z-run-A-000003",
      });
      const cur = readEventCursor(opened.db, "run-stream", "run");
      expect(cur?.cursor).toBe("2026-05-10T00:00:00.000Z-run-A-000003");
    } finally {
      opened.db.close();
    }
  });

  test("acquireLock fences contenders and releases cleanly", async () => {
    const opened = await openStateStore();
    try {
      const ownerA = acquireLock(
        opened.db,
        { lock_key: "claim:POL-1", owner_id: "A", ttl_ms: 60_000 },
        () => new Date("2026-05-10T12:00:00.000Z"),
      );
      expect(ownerA.status).toBe("acquired");

      const ownerB = acquireLock(
        opened.db,
        { lock_key: "claim:POL-1", owner_id: "B", ttl_ms: 60_000 },
        () => new Date("2026-05-10T12:00:01.000Z"),
      );
      expect(ownerB.status).toBe("held");
      if (ownerB.status === "held") {
        expect(ownerB.holder.owner_id).toBe("A");
      }

      // Other owner cannot release A's lock.
      const wrongRelease = releaseLock(opened.db, {
        lock_key: "claim:POL-1",
        owner_id: "B",
      });
      expect(wrongRelease.status).toBe("owned-by-other");

      // Owner A releases successfully.
      const release = releaseLock(opened.db, {
        lock_key: "claim:POL-1",
        owner_id: "A",
      });
      expect(release.status).toBe("released");
      expect(readLock(opened.db, "claim:POL-1")).toBeUndefined();
    } finally {
      opened.db.close();
    }
  });

  test("acquireLock steals after expiry with `stolen=true` and previous_owner_id", async () => {
    const opened = await openStateStore();
    try {
      acquireLock(
        opened.db,
        { lock_key: "claim:POL-2", owner_id: "stale-owner", ttl_ms: 1 },
        () => new Date("2026-05-10T12:00:00.000Z"),
      );
      // 30 seconds later: prior lease is long expired.
      const result = acquireLock(
        opened.db,
        { lock_key: "claim:POL-2", owner_id: "fresh-owner", ttl_ms: 60_000 },
        () => new Date("2026-05-10T12:00:30.000Z"),
      );
      expect(result.status).toBe("acquired");
      if (result.status === "acquired") {
        expect(result.stolen).toBe(true);
        expect(result.previous_owner_id).toBe("stale-owner");
        expect(result.holder.owner_id).toBe("fresh-owner");
      }
    } finally {
      opened.db.close();
    }
  });

  test("listExpiredLocks reports leases past expiry and not active leases", async () => {
    const opened = await openStateStore();
    try {
      acquireLock(
        opened.db,
        { lock_key: "claim:expired", owner_id: "A", ttl_ms: 1 },
        () => new Date("2026-05-10T12:00:00.000Z"),
      );
      acquireLock(
        opened.db,
        { lock_key: "claim:fresh", owner_id: "B", ttl_ms: 60_000 },
        () => new Date("2026-05-10T12:00:00.000Z"),
      );
      const stale = listExpiredLocks(opened.db, { asOf: "2026-05-10T12:00:30.000Z" });
      expect(stale.rows.map((l) => l.lock_key)).toEqual(["claim:expired"]);
      expect(stale.total).toBe(1);
      expect(stale.truncated).toBe(false);
    } finally {
      opened.db.close();
    }
  });

  test("listExpiredLocks caps sample at the default limit and reports total/truncated", async () => {
    const opened = await openStateStore();
    try {
      // Default cap is 20. Insert 25 expired locks so we cross the cap.
      for (let i = 0; i < 25; i++) {
        acquireLock(
          opened.db,
          { lock_key: `claim:bulk-${String(i).padStart(2, "0")}`, owner_id: "A", ttl_ms: 1 },
          () => new Date("2026-05-10T12:00:00.000Z"),
        );
      }
      const stale = listExpiredLocks(opened.db, { asOf: "2026-05-10T12:00:30.000Z" });
      expect(stale.rows.length).toBe(20);
      expect(stale.total).toBe(25);
      expect(stale.truncated).toBe(true);

      // Explicit limit honored.
      const small = listExpiredLocks(opened.db, {
        asOf: "2026-05-10T12:00:30.000Z",
        limit: 5,
      });
      expect(small.rows.length).toBe(5);
      expect(small.total).toBe(25);
      expect(small.truncated).toBe(true);
    } finally {
      opened.db.close();
    }
  });

  test("source_freshness upsert + listStaleSources surfaces stale and overdue rows", async () => {
    const opened = await openStateStore();
    try {
      // Fresh, with a 60s deadline; observed in the past, deadline already elapsed.
      upsertSourceFreshness(opened.db, {
        source_kind: "tracker",
        source_id: "linear/INGEST",
        status: "fresh",
        observed_at: "2026-05-10T11:59:00.000Z",
        stale_after_ms: 60_000,
      });
      // Explicit stale.
      upsertSourceFreshness(opened.db, {
        source_kind: "tracker",
        source_id: "linear/CHARTER",
        status: "stale",
        observed_at: "2026-05-10T12:00:00.000Z",
        detail: "poll failed",
      });
      // Fresh and not yet overdue.
      upsertSourceFreshness(opened.db, {
        source_kind: "tracker",
        source_id: "linear/AGENTS",
        status: "fresh",
        observed_at: "2026-05-10T12:01:00.000Z",
        stale_after_ms: 600_000,
      });

      const stale = listStaleSources(opened.db, { asOf: "2026-05-10T12:01:30.000Z" });
      const ids = stale.rows.map((r) => r.source_id).sort();
      expect(ids).toEqual(["linear/CHARTER", "linear/INGEST"]);
      expect(stale.total).toBe(2);
      expect(stale.truncated).toBe(false);

      // Per-kind filter still works.
      const filtered = listStaleSources(opened.db, {
        asOf: "2026-05-10T12:01:30.000Z",
        source_kind: "tracker",
      });
      expect(filtered.rows.length).toBe(2);
      expect(filtered.total).toBe(2);

      // Idempotent re-upsert overwrites prior row in place.
      upsertSourceFreshness(opened.db, {
        source_kind: "tracker",
        source_id: "linear/INGEST",
        status: "fresh",
        observed_at: "2026-05-10T12:01:25.000Z",
        stale_after_ms: 60_000,
      });
      const ingest = readSourceFreshness(opened.db, "tracker", "linear/INGEST");
      expect(ingest?.status).toBe("fresh");
      expect(ingest?.observed_at).toBe("2026-05-10T12:01:25.000Z");
    } finally {
      opened.db.close();
    }
  });

  test("listStaleSources caps sample at the default limit and reports total/truncated", async () => {
    const opened = await openStateStore();
    try {
      // Default cap is 20. Insert 25 explicitly stale rows.
      for (let i = 0; i < 25; i++) {
        upsertSourceFreshness(opened.db, {
          source_kind: "tracker",
          source_id: `linear/BULK-${String(i).padStart(2, "0")}`,
          status: "stale",
          observed_at: "2026-05-10T11:00:00.000Z",
          detail: "bulk fixture",
        });
      }
      const stale = listStaleSources(opened.db, { asOf: "2026-05-10T12:00:00.000Z" });
      expect(stale.rows.length).toBe(20);
      expect(stale.total).toBe(25);
      expect(stale.truncated).toBe(true);

      // Explicit small limit applies.
      const small = listStaleSources(opened.db, {
        asOf: "2026-05-10T12:00:00.000Z",
        limit: 3,
      });
      expect(small.rows.length).toBe(3);
      expect(small.total).toBe(25);
      expect(small.truncated).toBe(true);
    } finally {
      opened.db.close();
    }
  });

  test("doctor surfaces bounded orchestration samples and emits truncation findings", async () => {
    const opened = await openStateStore();
    try {
      // Insert 25 expired locks and 25 stale sources to exceed the default 20-row cap.
      for (let i = 0; i < 25; i++) {
        acquireLock(
          opened.db,
          { lock_key: `claim:doctor-${String(i).padStart(2, "0")}`, owner_id: "A", ttl_ms: 1 },
          () => new Date("2026-04-01T00:00:00.000Z"),
        );
        upsertSourceFreshness(opened.db, {
          source_kind: "tracker",
          source_id: `linear/DOCTOR-${String(i).padStart(2, "0")}`,
          status: "stale",
          observed_at: "2026-05-09T00:00:00.000Z",
          detail: "doctor fixture",
        });
      }
    } finally {
      opened.db.close();
    }

    const report = await runStateDoctor();
    expect(report.orchestrationLedger.expiredLocks.length).toBe(20);
    expect(report.orchestrationLedger.expiredLocksTotal).toBe(25);
    expect(report.orchestrationLedger.expiredLocksTruncated).toBe(true);
    expect(report.orchestrationLedger.staleSources.length).toBe(20);
    expect(report.orchestrationLedger.staleSourcesTotal).toBe(25);
    expect(report.orchestrationLedger.staleSourcesTruncated).toBe(true);

    // Findings cap matches the sample, not the total.
    const lockFindings = report.findings.filter((f) => f.code === "orchestration-lock-expired");
    expect(lockFindings.length).toBe(20);
    const sourceFindings = report.findings.filter(
      (f) => f.code === "orchestration-source-stale",
    );
    expect(sourceFindings.length).toBe(20);

    // Truncation summary findings surface so operators see the elided count.
    expect(
      report.findings.some(
        (f) => f.code === "orchestration-lock-expired-truncated" && f.severity === "info",
      ),
    ).toBe(true);
    expect(
      report.findings.some(
        (f) => f.code === "orchestration-source-stale-truncated" && f.severity === "info",
      ),
    ).toBe(true);
  });
});

describe("OrchestrationLedgerSink ingestion", () => {
  let stateHome: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const k of ENV_KEYS) delete process.env[k];
    stateHome = await makeStateHome();
    process.env["CALYX_STATE_HOME"] = stateHome;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const parent = stateHome.replace(/\/state$/, "");
    await rm(parent, { recursive: true, force: true });
  });

  function buildRunEvent(overrides: Partial<SinkRunStreamEvent> = {}): SinkRunStreamEvent {
    return {
      schema_version: "1.0",
      event_id: "evt-run-1",
      cursor: "2026-05-10T00:00:00.000Z-run-A-000001",
      emitted_at: "2026-05-10T00:00:00.000Z",
      event_type: "run.terminal",
      emitted_by: "launch",
      run: { run_id: "run-A", host: "blade" },
      origin: { launcher_kind: "cli" },
      ...overrides,
    };
  }

  function buildControlEvent(overrides: Partial<SinkControlStreamEvent> = {}): SinkControlStreamEvent {
    return {
      schema_version: "1.0",
      event_id: "evt-ctl-1",
      cursor: "2026-05-10T00:00:00.000Z-ctl-000001",
      emitted_at: "2026-05-10T00:00:00.000Z",
      event_type: "daemon.health.checked",
      emitted_by: "self-health",
      control: { host: "blade", daemon_id: "blade-default" },
      ...overrides,
    };
  }

  test("disables silently and warns when migration 0002 is not applied", async () => {
    // No applyStateMigrations() — migration absent.
    const sink = new OrchestrationLedgerSink({ source: "test" });
    const result = await sink.ingestStreamEvent(buildRunEvent());
    expect(result.status).toBe("disabled");
    expect(sink.isDisabled).toBe(true);
    sink.close();
  });

  test("strict mode throws when migration is absent", async () => {
    const sink = new OrchestrationLedgerSink({ source: "test", strict: true });
    await expect(sink.ingestStreamEvent(buildRunEvent())).rejects.toThrow(
      /OrchestrationLedgerSink/,
    );
    sink.close();
  });

  test("ingests run + control events idempotently keyed by event_id", async () => {
    await applyStateMigrations();
    const sink = new OrchestrationLedgerSink({ source: "test" });
    try {
      const a = await sink.ingestStreamEvent(buildRunEvent());
      expect(a.status).toBe("ingested");
      if (a.status === "ingested") expect(a.inserted).toBe(true);

      // Second append with the same event_id is a no-op.
      const b = await sink.ingestStreamEvent(buildRunEvent());
      expect(b.status).toBe("ingested");
      if (b.status === "ingested") expect(b.inserted).toBe(false);

      // A different run event, different event_id, different cursor.
      const c = await sink.ingestStreamEvent(
        buildRunEvent({
          event_id: "evt-run-2",
          cursor: "2026-05-10T00:00:00.000Z-run-A-000002",
        }),
      );
      expect(c.status).toBe("ingested");
      if (c.status === "ingested") expect(c.inserted).toBe(true);

      const d = await sink.ingestStreamEvent(buildControlEvent());
      expect(d.status).toBe("ingested");
      if (d.status === "ingested") expect(d.inserted).toBe(true);
    } finally {
      sink.close();
    }

    const opened = await openStateStore();
    try {
      const runRows = listEventsByAggregate(opened.db, "run", "run-A");
      expect(runRows).toHaveLength(2);
      expect(runRows.map((r) => r.event_id).sort()).toEqual(["evt-run-1", "evt-run-2"]);

      const ctlRows = listEventsByAggregate(opened.db, "daemon", "blade-default");
      expect(ctlRows).toHaveLength(1);
      expect(ctlRows[0]?.domain).toBe("control");

      const runCursor = readEventCursor(opened.db, "run-stream", "run");
      expect(runCursor?.cursor).toBe("2026-05-10T00:00:00.000Z-run-A-000002");
      const ctlCursor = readEventCursor(opened.db, "run-stream", "control");
      expect(ctlCursor?.cursor).toBe("2026-05-10T00:00:00.000Z-ctl-000001");
    } finally {
      opened.db.close();
    }
  });

  test("same event_id is idempotent only for the exact committed event identity", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      const input = {
        event_id: "evt-exact-identity",
        domain: "run",
        aggregate_type: "run",
        aggregate_id: "run-exact-identity",
        event_type: "run.terminal",
        cursor: "z1-00000000000000000001",
        occurred_at: "2026-05-10T00:00:00.000Z",
        source: "test",
        payload: { b: 2, a: 1 },
      };
      expect(appendOrchestrationEvent(opened.db, input).inserted).toBe(true);
      expect(appendOrchestrationEvent(opened.db, {
        ...input,
        payload: { a: 1, b: 2 },
      }).inserted).toBe(false);
      expect(() => appendOrchestrationEvent(opened.db, {
        ...input,
        cursor: "z1-00000000000000000002",
      })).toThrow(OrchestrationEventIdentityConflictError);
      expect(countEventsByAggregate(opened.db, "run", "run-exact-identity")).toBe(1);
    } finally {
      opened.db.close();
    }
  });

  test("genuine divergence under one event_id still fails closed and names the fields", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      const input = {
        event_id: "evt-divergent-payload",
        domain: "run",
        aggregate_type: "run",
        aggregate_id: "run-divergent",
        event_type: "run.terminal",
        cursor: "z1-00000000000000000001",
        occurred_at: "2026-05-10T00:00:00.000Z",
        source: "run-service",
        payload: { state: "succeeded" },
      };
      expect(appendOrchestrationEvent(opened.db, input).inserted).toBe(true);

      // Same id, different payload — a different event wearing a used id.
      // Provenance leaving identity must not weaken this.
      let thrown: unknown;
      try {
        appendOrchestrationEvent(opened.db, {
          ...input,
          source: "self-upgrade",
          payload: { state: "failed" },
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(OrchestrationEventIdentityConflictError);
      expect((thrown as OrchestrationEventIdentityConflictError).divergentFields).toEqual(["payload"]);
      expect((thrown as Error).message).toMatch(/Divergent identity fields: payload\./u);

      // Aggregate/type divergence is reported per field, not as one opaque hash.
      let aggregateConflict: unknown;
      try {
        appendOrchestrationEvent(opened.db, {
          ...input,
          aggregate_id: "run-other",
          event_type: "run.started",
        });
      } catch (err) {
        aggregateConflict = err;
      }
      expect((aggregateConflict as OrchestrationEventIdentityConflictError).divergentFields)
        .toEqual(["aggregate_id", "event_type"]);

      expect(countEventsByAggregate(opened.db, "run", "run-divergent")).toBe(1);
      const [row] = listEventsByAggregate(opened.db, "run", "run-divergent");
      expect(row?.payload).toEqual({ state: "succeeded" });
    } finally {
      opened.db.close();
    }
  });

  test("re-ingest by a different writer is a no-op and keeps first-writer provenance", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      // The worm case: `run-service` ingested this run.terminal event live on
      // 2026-05-11; a later `calyx self upgrade` replays the same run journal
      // through a `self-upgrade`-stamped sink. Same event, different writer.
      const committed = appendOrchestrationEvent(
        opened.db,
        {
          event_id: WORM_TERMINAL_EVENT.event_id,
          domain: "run",
          aggregate_type: "run",
          aggregate_id: WORM_TERMINAL_EVENT.run.run_id,
          event_type: WORM_TERMINAL_EVENT.event_type,
          cursor: WORM_TERMINAL_EVENT.cursor,
          occurred_at: WORM_TERMINAL_EVENT.emitted_at,
          host: "worm",
          source: "run-service",
          payload: WORM_TERMINAL_EVENT,
        },
        () => "2026-05-11T00:47:15.182Z",
      );
      expect(committed.inserted).toBe(true);

      const replayed = appendOrchestrationEvent(
        opened.db,
        {
          event_id: WORM_TERMINAL_EVENT.event_id,
          domain: "run",
          aggregate_type: "run",
          aggregate_id: WORM_TERMINAL_EVENT.run.run_id,
          event_type: WORM_TERMINAL_EVENT.event_type,
          cursor: WORM_TERMINAL_EVENT.cursor,
          occurred_at: WORM_TERMINAL_EVENT.emitted_at,
          // Every provenance column differs on the replay.
          host: "blade",
          agent_id: "upgrade-operator",
          source: "self-upgrade",
          payload: WORM_TERMINAL_EVENT,
        },
        () => "2026-07-27T00:00:00.000Z",
      );
      expect(replayed.inserted).toBe(false);

      // First-writer-wins: the committed row still records who observed the
      // event first, and `recorded_at` still matches that first write.
      const rows = listEventsByAggregate(opened.db, "run", WORM_TERMINAL_EVENT.run.run_id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.source).toBe("run-service");
      expect(rows[0]?.host).toBe("worm");
      expect(rows[0]?.agent_id).toBeNull();
      expect(rows[0]?.recorded_at).toBe("2026-05-11T00:47:15.182Z");
    } finally {
      opened.db.close();
    }
  });

  test("a payload stored before JCS canonicalization re-ingests as a no-op", async () => {
    // Rows committed by older daemons — worm's included — hold `payload_json`
    // in insertion order, not JCS order. Identity compares canonical *values*,
    // so the committed side must be parsed and re-canonicalized rather than
    // byte-compared; a byte compare would fail closed on every such row.
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      opened.db
        .prepare(
          `INSERT INTO event_log
             (event_id, domain, aggregate_type, aggregate_id, event_type, cursor,
              occurred_at, recorded_at, host, agent_id, source, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "evt-legacy-order",
          "run",
          "run",
          "run-legacy-order",
          "run.terminal",
          "z1-00000000000000000001",
          "2026-05-10T00:00:00.000Z",
          "2026-05-10T00:00:00.001Z",
          "worm",
          null,
          "run-service",
          // Insertion order, exactly as a pre-canonicalization writer stored it.
          `{"schema_version":"1.0","event_id":"evt-legacy-order","state":"succeeded"}`,
        );

      const replay = appendOrchestrationEvent(opened.db, {
        event_id: "evt-legacy-order",
        domain: "run",
        aggregate_type: "run",
        aggregate_id: "run-legacy-order",
        event_type: "run.terminal",
        cursor: "z1-00000000000000000001",
        occurred_at: "2026-05-10T00:00:00.000Z",
        source: "self-upgrade",
        payload: { event_id: "evt-legacy-order", schema_version: "1.0", state: "succeeded" },
      });
      expect(replay.inserted).toBe(false);
      expect(countEventsByAggregate(opened.db, "run", "run-legacy-order")).toBe(1);
    } finally {
      opened.db.close();
    }
  });

  test("event row and projection cursor commit in one transaction", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      opened.db.exec(`
        CREATE TRIGGER reject_event_cursor BEFORE INSERT ON event_cursors
        BEGIN SELECT RAISE(ABORT, 'cursor rejected'); END;
      `);
    } finally {
      opened.db.close();
    }
    const sink = new OrchestrationLedgerSink({ source: "test", strict: true });
    await expect(sink.ingestStreamEvent(buildRunEvent({
      event_id: "evt-atomic-cursor",
      cursor: "z1-00000000000000000001",
    }))).rejects.toThrow(/cursor rejected/u);
    sink.close();

    const verified = await openStateStore();
    try {
      expect(countEventsByAggregate(verified.db, "run", "run-A")).toBe(0);
      expect(readEventCursor(verified.db, "run-stream", "run")).toBeUndefined();
    } finally {
      verified.db.close();
    }
  });

  test("concurrent ingestion of the same event_id never produces duplicate rows", async () => {
    await applyStateMigrations();
    const sink = new OrchestrationLedgerSink({ source: "test" });
    try {
      const event = buildRunEvent({
        event_id: "evt-concurrent-1",
        cursor: "2026-05-10T00:00:00.000Z-run-Z-000001",
        run: { run_id: "run-Z" },
      });
      const settled = await Promise.all(
        Array.from({ length: 16 }, () => sink.ingestStreamEvent(event)),
      );
      const inserted = settled.filter((s) => s.status === "ingested" && s.inserted).length;
      expect(inserted).toBe(1);
    } finally {
      sink.close();
    }

    const opened = await openStateStore();
    try {
      expect(countEventsByAggregate(opened.db, "run", "run-Z")).toBe(1);
    } finally {
      opened.db.close();
    }
  });

  test("a self-upgrade sink re-ingesting a run-service event stays enabled (worm regression)", async () => {
    // Regression for the permanently wedged `calyx self upgrade` on host worm.
    // `appendControlEvent` re-projects the global event authority through a
    // sink stamped `self-upgrade`; every event already ingested live by
    // `run-service` came back with the same id, the same payload, and a
    // different `source`. Provenance in the identity comparison turned that
    // into `event_log append failed: ... conflicts with the row already
    // committed under that event_id`, which disabled the sink for good.
    await applyStateMigrations();
    const live = new OrchestrationLedgerSink({ source: "run-service", host: "worm", strict: true });
    try {
      const first = await live.ingestStreamEvent(WORM_TERMINAL_EVENT);
      expect(first).toEqual({ status: "ingested", inserted: true });
    } finally {
      live.close();
    }

    const replay = new OrchestrationLedgerSink({
      source: "self-upgrade",
      host: "worm",
      agentId: "upgrade-operator",
      strict: true,
    });
    try {
      const second = await replay.ingestStreamEvent(WORM_TERMINAL_EVENT);
      expect(second).toEqual({ status: "ingested", inserted: false });
      expect(replay.isDisabled).toBe(false);
      expect(replay.disabledMessage).toBeNull();
    } finally {
      replay.close();
    }

    const opened = await openStateStore();
    try {
      const rows = listEventsByAggregate(opened.db, "run", WORM_TERMINAL_EVENT.run.run_id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.event_id).toBe("ce3e7618-756d-49ab-813d-6f3464cdff24");
      expect(rows[0]?.source).toBe("run-service");
      expect(rows[0]?.agent_id).toBeNull();
    } finally {
      opened.db.close();
    }
  });

  test("concurrent first-use ingestion of distinct events all ingest (init race regression)", async () => {
    // Regression for the wave-2.1 init race: concurrent first-use callers
    // that all hit init() simultaneously must wait on a shared init promise
    // instead of seeing `initialized=true` while `db` is still null. The
    // pre-fix sink dropped 19/20 events as `disabled: no database`.
    await applyStateMigrations();
    const sink = new OrchestrationLedgerSink({ source: "test" });
    try {
      const events = Array.from({ length: 20 }, (_, i) =>
        buildRunEvent({
          event_id: `evt-race-${String(i).padStart(6, "0")}`,
          cursor: `2026-05-10T00:00:00.000Z-run-race-${String(i).padStart(6, "0")}`,
          run: { run_id: "run-race", host: "blade" },
        }),
      );
      const settled = await Promise.all(events.map((e) => sink.ingestStreamEvent(e)));

      const ingested = settled.filter(
        (s) => s.status === "ingested" && s.inserted,
      ).length;
      const disabled = settled.filter((s) => s.status === "disabled").length;

      expect(disabled).toBe(0);
      expect(ingested).toBe(20);
      expect(sink.isDisabled).toBe(false);
    } finally {
      sink.close();
    }

    const opened = await openStateStore();
    try {
      expect(countEventsByAggregate(opened.db, "run", "run-race")).toBe(20);
    } finally {
      opened.db.close();
    }
  });

  test("concurrent first-use callers share one disabled outcome when migration is absent", async () => {
    // Same init race window, disabled branch: every concurrent caller must
    // see the same disabled reason — not "no database" for the first caller
    // and the proper migration-absent message for the rest.
    const sink = new OrchestrationLedgerSink({ source: "test" });
    try {
      const events = Array.from({ length: 8 }, (_, i) =>
        buildRunEvent({ event_id: `evt-disabled-${i}` }),
      );
      const settled = await Promise.all(events.map((e) => sink.ingestStreamEvent(e)));

      expect(settled.every((s) => s.status === "disabled")).toBe(true);
      const reasons = new Set(
        settled.flatMap((s) => (s.status === "disabled" ? [s.reason] : [])),
      );
      expect(reasons.size).toBe(1);
      expect(sink.isDisabled).toBe(true);
    } finally {
      sink.close();
    }
  });

  test("ingestion does not mutate JSONL state — sink is a projection", async () => {
    await applyStateMigrations();
    // The sink writes only to SQLite. JSONL receipts are written by the
    // run-service store; this assertion guards against regression of the
    // run-service contract: opening a sink and ingesting events should
    // never create files outside the state directory.
    const sink = new OrchestrationLedgerSink({ source: "test" });
    try {
      await sink.ingestStreamEvent(buildRunEvent());
      // No `runs/` or `daemons/` siblings should appear.
      const stateParent = stateHome.replace(/\/state$/, "");
      await expect(stat(join(stateParent, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(stateParent, "daemons"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      sink.close();
    }
  });
});

describe("RunStore JSONL preservation", () => {
  // Cross-package smoke: importing run-service here would create a cycle in
  // the test target, so we keep this assertion in run-service's own test
  // suite. The orchestration-ledger tests above prove the SQLite side.
  test("placeholder — see packages/run-service/src/__tests__/store-event-log.test.ts", () => {
    expect(true).toBe(true);
  });
});

// Silence unused import warnings; readFile is used by future helpers.
void readFile;
