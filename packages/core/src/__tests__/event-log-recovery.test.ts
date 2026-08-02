import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  appendOrchestrationEvent,
  appendOrchestrationEventWithQuarantine,
  applyStateMigrations,
  canonicalizeJcs,
  classifyEventLogDomain,
  eventLogQuarantineDir,
  EVENT_LOG_QUARANTINE_SCHEMA_VERSION,
  EVENT_LOG_REBUILD_SOURCE,
  JOURNAL_DERIVED_EVENT_DOMAINS,
  LEDGER_NATIVE_EVENT_DOMAINS,
  listEventLogQuarantineRecords,
  openStateStore,
  OrchestrationLedgerSink,
  rebuildEventLogProjection,
  resolveEventJournalPath,
  runStateDoctor,
  verifyEventLogProjection,
  type SinkControlStreamEvent,
  type SinkRunStreamEvent,
  type StateDriverDatabase,
} from "../state";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB", "CALYX_RUNS_ROOT"] as const;

let root: string;
let stateHome: string;
let runsRoot: string;
let journalPath: string;
let original: Record<string, string | undefined>;

function runEvent(overrides: Partial<SinkRunStreamEvent> & { event_id: string }): SinkRunStreamEvent {
  return {
    schema_version: "1.0",
    cursor: `2026-07-27T00:00:00.000Z-${overrides.event_id}-000001`,
    emitted_at: "2026-07-27T00:00:00.000Z",
    event_type: "run.terminal",
    emitted_by: "run-service",
    run: { run_id: `run-${overrides.event_id}`, host: "blade" },
    ...overrides,
  };
}

function controlEvent(event_id: string): SinkControlStreamEvent {
  return {
    schema_version: "1.0",
    event_id,
    cursor: `2026-07-27T00:00:01.000Z-control-blade-${event_id}`,
    emitted_at: "2026-07-27T00:00:01.000Z",
    event_type: "daemon.upgrade.completed",
    emitted_by: "self-upgrade",
    control: { host: "blade", daemon_id: "run-serve" },
  };
}

async function writeJournal(events: unknown[]): Promise<void> {
  await writeFile(journalPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

/** Ingest through the real sink so rows carry exactly the live projection. */
async function ingest(db: StateDriverDatabase, events: unknown[], source: string): Promise<void> {
  const sink = new OrchestrationLedgerSink({ database: db, source, strict: true });
  for (const event of events) {
    const outcome = await sink.ingestStreamEvent(event as SinkRunStreamEvent);
    expect(outcome.status).toBe("ingested");
  }
  sink.close();
}

beforeEach(async () => {
  original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  root = await mkdtemp(join(tmpdir(), "calyx-event-log-recovery-"));
  stateHome = join(root, "state");
  runsRoot = join(root, "runs");
  journalPath = join(runsRoot, "events.index.jsonl");
  process.env["CALYX_STATE_HOME"] = stateHome;
  process.env["CALYX_RUNS_ROOT"] = runsRoot;
  await mkdir(runsRoot, { recursive: true });
  await applyStateMigrations();
});

afterEach(async () => {
  for (const [k, v] of Object.entries(original)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
});

describe("rebuild boundary", () => {
  test("declares every domain a ledger writer actually produces", () => {
    // The sink writes run/control/monitor; DaemonLedger writes calyx.symphony.
    // A writer added without a declaration is `unclassified` on purpose —
    // that is what makes the boundary enforceable instead of aspirational.
    expect(JOURNAL_DERIVED_EVENT_DOMAINS).toEqual(["run", "control", "monitor"]);
    expect(LEDGER_NATIVE_EVENT_DOMAINS).toEqual(["calyx.symphony"]);
    expect(classifyEventLogDomain("run")).toBe("journal-derived");
    expect(classifyEventLogDomain("monitor")).toBe("journal-derived");
    expect(classifyEventLogDomain("calyx.symphony")).toBe("ledger-native");
    expect(classifyEventLogDomain("something.new")).toBe("unclassified");
  });

  test("resolveEventJournalPath honors CALYX_RUNS_ROOT and an explicit root", () => {
    expect(resolveEventJournalPath()).toBe(journalPath);
    expect(resolveEventJournalPath({ runsRoot: "/srv/other" })).toBe("/srv/other/events.index.jsonl");
    expect(resolveEventJournalPath({ env: {}, homeDir: "/home/x" })).toBe(
      "/home/x/.calyx/runs/events.index.jsonl",
    );
  });
});

describe("verifyEventLogProjection", () => {
  test("classifies matched, missing, divergent, ledger-native, and orphaned rows", async () => {
    const kept = runEvent({ event_id: "aaaaaaaa-0000-0000-0000-000000000001" });
    const gap = runEvent({ event_id: "aaaaaaaa-0000-0000-0000-000000000002" });
    const conflict = runEvent({ event_id: "aaaaaaaa-0000-0000-0000-000000000003" });
    const orphan = controlEvent("aaaaaaaa-0000-0000-0000-000000000004");

    const opened = await openStateStore();
    try {
      // `kept` and `conflict` ingest live; `orphan` too, but the journal will
      // never mention it. `gap` exists only in the journal.
      await ingest(opened.db, [kept, conflict, orphan], "run-service");
      // A ledger-native row: written straight to event_log, no journal.
      appendOrchestrationEvent(opened.db, {
        event_id: "symphony:POL-1:issue.claimed",
        domain: "calyx.symphony",
        aggregate_type: "calyx.symphony.issue",
        aggregate_id: "daemon-a:POL-1",
        event_type: "issue.claimed",
        cursor: "2026-07-27T00:00:00.000Z#00000001",
        occurred_at: "2026-07-27T00:00:00.000Z",
        source: "daemon:daemon-a",
        payload: { issue: "POL-1" },
      });

      // The journal's version of `conflict` genuinely differs in body.
      const conflictInJournal = { ...conflict, run: { ...conflict.run, state: "failed" } };
      await writeJournal([kept, gap, conflictInJournal]);

      const report = await verifyEventLogProjection(opened.db, { journalPath });
      expect(report.status).toBe("scanned");
      expect(report.journal_present).toBe(true);
      expect(report.scanned).toBe(3);
      expect(report.matched).toBe(1);
      expect(report.missing).toBe(1);
      expect(report.divergent).toBe(1);
      expect(report.ledger_native_rows).toBe(1);
      // run(kept) + run(conflict) + control(orphan) = 3 journal-derived rows,
      // minus 1 matched and 1 divergent, leaves the control row orphaned.
      expect(report.orphaned_rows).toBe(1);
      expect(report.unclassified_rows).toBe(0);
      expect(report.missing_samples.map((s) => s.event_id)).toEqual([gap.event_id]);
      expect(report.divergent_samples[0]?.event_id).toBe(conflict.event_id);
      // Provenance is neutralized in the diff, so only the real body change shows.
      expect(report.divergent_samples[0]?.divergent_fields).toEqual(["payload_json"]);
    } finally {
      opened.db.close();
    }
  });

  test("a provenance-only difference is not divergence", async () => {
    // The POL-2090 false positive: the same event re-ingested by a different
    // component. The payload is the event, so the projection sees a match.
    const event = runEvent({ event_id: "bbbbbbbb-0000-0000-0000-000000000001" });
    const opened = await openStateStore();
    try {
      await ingest(opened.db, [event], "run-service");
      opened.db.prepare("UPDATE event_log SET source = ? WHERE event_id = ?").run(
        "self-upgrade",
        event.event_id,
      );
      await writeJournal([event]);
      const report = await verifyEventLogProjection(opened.db, { journalPath });
      expect(report.matched).toBe(1);
      expect(report.divergent).toBe(0);
    } finally {
      opened.db.close();
    }
  });

  test("a non-canonical stored encoding is not divergence", async () => {
    // `appendOrchestrationEvent` only began canonicalizing `payload_json` on
    // 2026-07-15 (1c0f5b0); every earlier row is stored in insertion order.
    // A byte-wise compare called all 1458 comparable rows on `blade`
    // divergent — the POL-2090 defect (encoding read as data) one layer
    // down, and a repair driven off it would rewrite the whole ledger.
    const event = runEvent({ event_id: "aaaabbbb-0000-0000-0000-000000000001" });
    const opened = await openStateStore();
    try {
      await ingest(opened.db, [event], "run-service");
      const stored = opened.db
        .prepare("SELECT payload_json FROM event_log WHERE event_id = ?")
        .get(event.event_id) as { payload_json: string };
      // Re-store the identical event with the keys in a different order.
      const reordered = Object.fromEntries(
        Object.entries(JSON.parse(stored.payload_json)).reverse(),
      );
      expect(JSON.stringify(reordered)).not.toBe(stored.payload_json);
      opened.db
        .prepare("UPDATE event_log SET payload_json = ? WHERE event_id = ?")
        .run(JSON.stringify(reordered), event.event_id);

      await writeJournal([event]);
      const report = await verifyEventLogProjection(opened.db, { journalPath });
      expect(report.matched).toBe(1);
      expect(report.divergent).toBe(0);
    } finally {
      opened.db.close();
    }

    // And the rebuild leaves it alone rather than quarantining it.
    const result = await rebuildEventLogProjection({ mode: "apply", journalPath });
    expect(result.replaced).toBe(0);
    expect(result.quarantined).toEqual([]);
  });

  test("an unparseable stored payload is divergence, not a match", async () => {
    const event = runEvent({ event_id: "aaaacccc-0000-0000-0000-000000000001" });
    const opened = await openStateStore();
    try {
      await ingest(opened.db, [event], "run-service");
      opened.db
        .prepare("UPDATE event_log SET payload_json = ? WHERE event_id = ?")
        .run("{not json", event.event_id);
      await writeJournal([event]);
      const report = await verifyEventLogProjection(opened.db, { journalPath });
      expect(report.divergent).toBe(1);
      expect(report.matched).toBe(0);
    } finally {
      opened.db.close();
    }
  });

  test("counts unclassified rows so an undeclared writer cannot hide", async () => {
    const opened = await openStateStore();
    try {
      appendOrchestrationEvent(opened.db, {
        event_id: "new-writer-1",
        domain: "calyx.brandnew",
        aggregate_type: "thing",
        aggregate_id: "t1",
        event_type: "thing.happened",
        cursor: "c1",
        occurred_at: "2026-07-27T00:00:00.000Z",
        payload: {},
      });
      await writeJournal([]);
      const report = await verifyEventLogProjection(opened.db, { journalPath });
      expect(report.unclassified_rows).toBe(1);
      expect(report.unclassified_domains).toEqual(["calyx.brandnew"]);
    } finally {
      opened.db.close();
    }
  });

  test("reports a truncated scan instead of implying health", async () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      runEvent({ event_id: `cccccccc-0000-0000-0000-00000000000${i}` }),
    );
    await writeJournal(events);
    const opened = await openStateStore();
    try {
      const report = await verifyEventLogProjection(opened.db, { journalPath, scanLimit: 2 });
      expect(report.truncated).toBe(true);
      expect(report.scanned).toBe(2);
    } finally {
      opened.db.close();
    }
  });

  test("skips cleanly when the journal is absent", async () => {
    const opened = await openStateStore();
    try {
      await ingest(opened.db, [runEvent({ event_id: "dddddddd-0000-0000-0000-000000000001" })], "run-service");
      const report = await verifyEventLogProjection(opened.db, { journalPath });
      expect(report.journal_present).toBe(false);
      expect(report.orphaned_rows).toBe(1);
    } finally {
      opened.db.close();
    }
  });
});

describe("appendOrchestrationEventWithQuarantine", () => {
  const base = {
    event_id: "conflict-1",
    domain: "run",
    aggregate_type: "run",
    aggregate_id: "run-1",
    event_type: "run.terminal",
    cursor: "c1",
    occurred_at: "2026-07-27T00:00:00.000Z",
    source: "run-service",
  };

  test("a genuine conflict is set aside with both versions, and ingest continues", async () => {
    const opened = await openStateStore();
    try {
      appendOrchestrationEvent(opened.db, { ...base, payload: { state: "succeeded" } });

      const outcome = await appendOrchestrationEventWithQuarantine(
        opened.db,
        stateHome,
        { ...base, source: "self-upgrade", payload: { state: "failed" } },
        { host: "blade", now: () => "2026-07-27T12:00:00.000Z", newId: () => "q-0001" },
      );

      expect(outcome.status).toBe("quarantined");
      if (outcome.status !== "quarantined") throw new Error("unreachable");

      // First-writer-wins at ingest: the committed row is untouched.
      const row = opened.db
        .prepare("SELECT payload_json, source FROM event_log WHERE event_id = ?")
        .get("conflict-1") as { payload_json: string; source: string };
      expect(row.payload_json).toBe(canonicalizeJcs({ state: "succeeded" }));
      expect(row.source).toBe("run-service");

      // The rejected version survives in full — quarantine is not a drop.
      const record = outcome.record;
      expect(record.schema_version).toBe(EVENT_LOG_QUARANTINE_SCHEMA_VERSION);
      expect(record.origin).toBe("ingest");
      expect(record.resolution).toBe("kept-committed");
      expect(record.reason).toBe("identity-conflict");
      expect(record.committed?.payload_json).toBe(canonicalizeJcs({ state: "succeeded" }));
      expect(record.incoming?.payload_json).toBe(canonicalizeJcs({ state: "failed" }));
      expect(record.committed?.source).toBe("run-service");
      expect(record.incoming?.source).toBe("self-upgrade");
      expect(record.divergent_fields.map((d) => d.field)).toEqual(["source", "payload_json"]);
      // No acknowledgement field exists to gate on.
      expect(Object.keys(record)).not.toContain("acknowledged");

      // Persisted at 0600 under the state dir, readable by an agent later.
      const onDisk = JSON.parse(await readFile(outcome.path, "utf8"));
      expect(onDisk).toEqual(record);
      const mode = (await stat(outcome.path)).mode & 0o777;
      if (process.platform !== "win32") expect(mode).toBe(0o600);

      // Ingest continues: the next distinct event still lands.
      const next = await appendOrchestrationEventWithQuarantine(
        opened.db,
        stateHome,
        { ...base, event_id: "conflict-2", payload: { state: "succeeded" } },
      );
      expect(next).toEqual({ status: "appended", inserted: true });
    } finally {
      opened.db.close();
    }
  });

  test("an exact re-append is a no-op, not a quarantine", async () => {
    const opened = await openStateStore();
    try {
      appendOrchestrationEvent(opened.db, { ...base, payload: { state: "succeeded" } });
      const outcome = await appendOrchestrationEventWithQuarantine(opened.db, stateHome, {
        ...base,
        payload: { state: "succeeded" },
      });
      expect(outcome).toEqual({ status: "appended", inserted: false });
      const inventory = await listEventLogQuarantineRecords(stateHome);
      expect(inventory.total).toBe(0);
    } finally {
      opened.db.close();
    }
  });

  test("repeated conflicts leave a trail rather than one survivor", async () => {
    const opened = await openStateStore();
    try {
      appendOrchestrationEvent(opened.db, { ...base, payload: { v: 0 } });
      for (const v of [1, 2, 3]) {
        await appendOrchestrationEventWithQuarantine(opened.db, stateHome, {
          ...base,
          payload: { v },
        });
      }
      const files = await readdir(eventLogQuarantineDir(stateHome));
      expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(3);
      const inventory = await listEventLogQuarantineRecords(stateHome);
      expect(inventory.total).toBe(3);
    } finally {
      opened.db.close();
    }
  });
});

describe("rebuildEventLogProjection", () => {
  test("--plan reports the gap and names what it cannot restore, without writing", async () => {
    const present = runEvent({ event_id: "eeeeeeee-0000-0000-0000-000000000001" });
    const gap = runEvent({ event_id: "eeeeeeee-0000-0000-0000-000000000002" });
    const opened = await openStateStore();
    try {
      await ingest(opened.db, [present], "run-service");
      appendOrchestrationEvent(opened.db, {
        event_id: "symphony:POL-2:issue.claimed",
        domain: "calyx.symphony",
        aggregate_type: "calyx.symphony.issue",
        aggregate_id: "daemon-a:POL-2",
        event_type: "issue.claimed",
        cursor: "2026-07-27T00:00:00.000Z#00000001",
        occurred_at: "2026-07-27T00:00:00.000Z",
        source: "daemon:daemon-a",
        payload: { issue: "POL-2" },
      });
    } finally {
      opened.db.close();
    }
    await writeJournal([present, gap]);

    const before = await rebuildEventLogProjection({ journalPath });
    expect(before.mode).toBe("plan");
    expect(before.report.missing).toBe(1);
    expect(before.restored).toBe(0);
    expect(before.preserved.ledger_native).toBe(1);
    expect(before.not_restorable.join("\n")).toContain("ledger-native");
    expect(before.not_restorable.join("\n")).toContain("recorded_at");
    expect(before.not_restorable.join("\n")).toContain("event_cursors");

    const reopened = await openStateStore();
    try {
      const still = await verifyEventLogProjection(reopened.db, { journalPath });
      expect(still.missing).toBe(1);
    } finally {
      reopened.db.close();
    }
  });

  test("--apply merges the gap and never deletes ledger-native rows", async () => {
    const present = runEvent({ event_id: "ffffffff-0000-0000-0000-000000000001" });
    const gap = runEvent({ event_id: "ffffffff-0000-0000-0000-000000000002" });
    const opened = await openStateStore();
    try {
      await ingest(opened.db, [present], "run-service");
      appendOrchestrationEvent(opened.db, {
        event_id: "symphony:POL-3:issue.terminal",
        domain: "calyx.symphony",
        aggregate_type: "calyx.symphony.issue",
        aggregate_id: "daemon-a:POL-3",
        event_type: "issue.terminal",
        cursor: "2026-07-27T00:00:00.000Z#00000001",
        occurred_at: "2026-07-27T00:00:00.000Z",
        source: "daemon:daemon-a",
        payload: { issue: "POL-3" },
      });
    } finally {
      opened.db.close();
    }
    await writeJournal([present, gap]);

    const result = await rebuildEventLogProjection({ mode: "apply", journalPath });
    expect(result.restored).toBe(1);
    expect(result.replaced).toBe(0);
    expect(result.skipped).toEqual([]);

    const reopened = await openStateStore();
    try {
      const row = reopened.db
        .prepare("SELECT source, payload_json FROM event_log WHERE event_id = ?")
        .get(gap.event_id) as { source: string; payload_json: string };
      // The rebuilt row says who materialized it rather than impersonating
      // the original writer.
      expect(row.source).toBe(EVENT_LOG_REBUILD_SOURCE);
      expect(row.payload_json).toBe(canonicalizeJcs(gap));

      // The Symphony row is untouched: a rebuild merges, it never replaces.
      const native = reopened.db
        .prepare("SELECT payload_json FROM event_log WHERE event_id = ?")
        .get("symphony:POL-3:issue.terminal") as { payload_json: string };
      expect(native.payload_json).toBe(canonicalizeJcs({ issue: "POL-3" }));

      const after = await verifyEventLogProjection(reopened.db, { journalPath });
      expect(after.missing).toBe(0);
      expect(after.divergent).toBe(0);
      expect(after.matched).toBe(2);
      expect(after.ledger_native_rows).toBe(1);
    } finally {
      reopened.db.close();
    }
  });

  test("--apply performs no deletion when quarantine publication fails (review r2 P1)", async () => {
    // The safety property behind the durable-publication work: the sidecar is
    // the sole surviving copy of the row rebuild is about to delete, so if
    // publication cannot be proven durable the displaced row must still be
    // there afterwards.
    const { chmod, mkdir } = await import("node:fs/promises");
    const conflict = runEvent({ event_id: "99999999-0000-0000-0000-0000000000ff" });
    const opened = await openStateStore();
    try {
      await ingest(opened.db, [conflict], "run-service");
    } finally {
      opened.db.close();
    }
    await writeJournal([{ ...conflict, run: { ...conflict.run, state: "failed" } }]);

    // Make the quarantine directory unwritable so the exclusive temp open fails.
    const qdir = eventLogQuarantineDir(stateHome);
    await mkdir(qdir, { recursive: true });
    await chmod(qdir, 0o500);
    try {
      await expect(
        rebuildEventLogProjection({ mode: "apply", journalPath, host: "blade" }),
      ).rejects.toThrow();

      // The displaced row must survive: no destructive step may outrun the
      // evidence that preserves what it destroys.
      const reopened = await openStateStore();
      try {
        const row = reopened.db
          .prepare("SELECT event_id FROM event_log WHERE event_id = ?")
          .get(conflict.event_id) as { event_id?: string } | undefined;
        expect(row?.event_id).toBe(conflict.event_id);
      } finally {
        reopened.db.close();
      }
    } finally {
      await chmod(qdir, 0o700);
    }
  });

  test("--apply quarantines a genuinely divergent row and installs the journal's version", async () => {
    const conflict = runEvent({ event_id: "99999999-0000-0000-0000-000000000001" });
    const opened = await openStateStore();
    try {
      await ingest(opened.db, [conflict], "run-service");
    } finally {
      opened.db.close();
    }
    const journalVersion = { ...conflict, run: { ...conflict.run, state: "failed" } };
    await writeJournal([journalVersion]);

    const result = await rebuildEventLogProjection({
      mode: "apply",
      journalPath,
      host: "blade",
      now: () => "2026-07-27T13:00:00.000Z",
      newId: () => "q-rebuild-1",
    });
    expect(result.replaced).toBe(1);
    expect(result.restored).toBe(0);
    expect(result.quarantined).toHaveLength(1);

    const record = result.quarantined[0]!;
    expect(record.origin).toBe("rebuild");
    // The journal is the authority for this projection, so the ledger yields.
    expect(record.resolution).toBe("kept-incoming");
    expect(record.committed?.payload_json).toBe(canonicalizeJcs(conflict));
    expect(record.incoming?.payload_json).toBe(canonicalizeJcs(journalVersion));
    expect(record.divergent_fields.map((d) => d.field)).toContain("payload_json");
    expect(record.detail).toContain(journalPath);

    const inventory = await listEventLogQuarantineRecords(stateHome);
    expect(inventory.total).toBe(1);
    expect(inventory.entries[0]?.record.event_id).toBe(conflict.event_id);

    const reopened = await openStateStore();
    try {
      const row = reopened.db
        .prepare("SELECT payload_json FROM event_log WHERE event_id = ?")
        .get(conflict.event_id) as { payload_json: string };
      expect(row.payload_json).toBe(canonicalizeJcs(journalVersion));
      const after = await verifyEventLogProjection(reopened.db, { journalPath });
      expect(after.divergent).toBe(0);
      expect(after.matched).toBe(1);
    } finally {
      reopened.db.close();
    }
  });

  test("refuses to write when an undeclared domain is present", async () => {
    const opened = await openStateStore();
    try {
      appendOrchestrationEvent(opened.db, {
        event_id: "undeclared-1",
        domain: "calyx.unknown-writer",
        aggregate_type: "x",
        aggregate_id: "y",
        event_type: "z",
        cursor: "c",
        occurred_at: "2026-07-27T00:00:00.000Z",
        payload: {},
      });
    } finally {
      opened.db.close();
    }
    await writeJournal([runEvent({ event_id: "88888888-0000-0000-0000-000000000001" })]);

    const result = await rebuildEventLogProjection({ mode: "apply", journalPath });
    expect(result.refused_reason).toContain("calyx.unknown-writer");
    expect(result.restored).toBe(0);

    const reopened = await openStateStore();
    try {
      const report = await verifyEventLogProjection(reopened.db, { journalPath });
      expect(report.missing).toBe(1);
    } finally {
      reopened.db.close();
    }
  });

  test("refuses to write from a truncated scan", async () => {
    await writeJournal(
      Array.from({ length: 4 }, (_, i) =>
        runEvent({ event_id: `77777777-0000-0000-0000-00000000000${i}` }),
      ),
    );
    const result = await rebuildEventLogProjection({ mode: "apply", journalPath, scanLimit: 2 });
    expect(result.refused_reason).toContain("partial scan");
    expect(result.restored).toBe(0);
  });

  test("is idempotent — a second apply changes nothing", async () => {
    const gap = runEvent({ event_id: "66666666-0000-0000-0000-000000000001" });
    await writeJournal([gap]);
    const first = await rebuildEventLogProjection({ mode: "apply", journalPath });
    expect(first.restored).toBe(1);
    const second = await rebuildEventLogProjection({ mode: "apply", journalPath });
    expect(second.restored).toBe(0);
    expect(second.replaced).toBe(0);
    expect(second.report.matched).toBe(1);
    const inventory = await listEventLogQuarantineRecords(stateHome);
    expect(inventory.total).toBe(0);
  });
});

describe("calyx state doctor surfaces", () => {
  test("reports divergence, gaps, and quarantine without blocking", async () => {
    const conflict = runEvent({ event_id: "55555555-0000-0000-0000-000000000001" });
    const gap = runEvent({ event_id: "55555555-0000-0000-0000-000000000002" });
    const opened = await openStateStore();
    try {
      await ingest(opened.db, [conflict], "run-service");
      await appendOrchestrationEventWithQuarantine(
        opened.db,
        stateHome,
        {
          event_id: conflict.event_id,
          domain: "run",
          aggregate_type: "run",
          aggregate_id: conflict.run.run_id,
          event_type: "run.terminal",
          cursor: conflict.cursor,
          occurred_at: conflict.emitted_at,
          source: "self-upgrade",
          payload: { different: true },
        },
      );
    } finally {
      opened.db.close();
    }
    await writeJournal([{ ...conflict, run: { ...conflict.run, state: "failed" } }, gap]);

    const report = await runStateDoctor({ journalPath });
    const codes = report.findings.map((f) => f.code);
    expect(codes).toContain("orchestration-event-log-quarantined");
    expect(codes).toContain("orchestration-event-log-divergent");
    expect(codes).toContain("orchestration-event-log-gap");

    // Recoverable, not terminal: none of these gates the doctor.
    for (const code of [
      "orchestration-event-log-quarantined",
      "orchestration-event-log-divergent",
      "orchestration-event-log-gap",
    ]) {
      expect(report.findings.find((f) => f.code === code)?.severity).not.toBe("error");
    }
    expect(report.ok).toBe(true);

    expect(report.eventLogProjection.divergent).toBe(1);
    expect(report.eventLogProjection.missing).toBe(1);
    expect(report.eventLogQuarantine.total).toBe(1);
    expect(report.findings.find((f) => f.code === "orchestration-event-log-divergent")?.message)
      .toContain("calyx state event-log rebuild --apply");
  });

  test("blocks only when the rebuild boundary itself is untrustworthy", async () => {
    const opened = await openStateStore();
    try {
      appendOrchestrationEvent(opened.db, {
        event_id: "undeclared-doctor-1",
        domain: "calyx.undeclared",
        aggregate_type: "x",
        aggregate_id: "y",
        event_type: "z",
        cursor: "c",
        occurred_at: "2026-07-27T00:00:00.000Z",
        payload: {},
      });
    } finally {
      opened.db.close();
    }
    await writeJournal([]);

    const report = await runStateDoctor({ journalPath });
    const finding = report.findings.find((f) => f.code === "orchestration-event-log-unclassified-domain");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("calyx.undeclared");
    expect(report.ok).toBe(false);

    const scoped = await runStateDoctor({ journalPath, domains: ["orchestration"] });
    expect(scoped.domains?.[0]?.status).toBe("drift");
  });

  test("a truncated doctor scan is a blocking finding, not silent health", async () => {
    await writeJournal(
      Array.from({ length: 4 }, (_, i) =>
        runEvent({ event_id: `44444444-0000-0000-0000-00000000000${i}` }),
      ),
    );
    const report = await runStateDoctor({ journalPath, journalScanLimit: 1 });
    const finding = report.findings.find((f) => f.code === "orchestration-event-log-scan-truncated");
    expect(finding?.severity).toBe("error");
    expect(report.ok).toBe(false);
  });

  test("stays quiet on a healthy store", async () => {
    const event = runEvent({ event_id: "33333333-0000-0000-0000-000000000001" });
    const opened = await openStateStore();
    try {
      await ingest(opened.db, [event], "run-service");
    } finally {
      opened.db.close();
    }
    await writeJournal([event]);
    const report = await runStateDoctor({ journalPath });
    expect(report.findings.filter((f) => f.code.startsWith("orchestration-event-log"))).toEqual([]);
    expect(report.eventLogProjection.matched).toBe(1);
    expect(report.eventLogQuarantine.total).toBe(0);
  });
});
