import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  applyStateMigrations,
  OrchestrationLedgerSink,
  type SinkRunStreamEvent,
} from "../state";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB", "CALYX_RUNS_ROOT"] as const;

let root: string;
let original: Record<string, string | undefined>;

beforeEach(async () => {
  original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  root = await mkdtemp(join(tmpdir(), "calyx-sink-quarantine-"));
  process.env["CALYX_STATE_HOME"] = join(root, "state");
  process.env["CALYX_RUNS_ROOT"] = join(root, "runs");
  await mkdir(join(root, "runs"), { recursive: true });
  await applyStateMigrations();
});

afterEach(async () => {
  for (const [k, v] of Object.entries(original)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
});

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

describe("OrchestrationLedgerSink quarantine boundary", () => {
  test("a genuine identity conflict is quarantined and the sink keeps ingesting", async () => {
    // POL-2090. Before this wiring, `disable()` fired on any append error and
    // the sink refused every later event for the life of the process — which is
    // how one divergent 2026-05-11 row made worm permanently unupgradeable.
    const sink = new OrchestrationLedgerSink({ host: "blade" });

    const first = await sink.ingestStreamEvent(runEvent({ event_id: "aaaaaaaa" }));
    expect(first.status).toBe("ingested");

    // Same id, materially different event: a real conflict, not provenance.
    const second = await sink.ingestStreamEvent(
      runEvent({ event_id: "aaaaaaaa", event_type: "run.started" }),
    );
    expect(second.status).toBe("quarantined");
    if (second.status === "quarantined") {
      expect(existsSync(second.path)).toBe(true);
      const record = JSON.parse(readFileSync(second.path, "utf8")) as {
        committed?: unknown;
        incoming?: unknown;
      };
      expect(record.committed).toBeTruthy();
      expect(record.incoming).toBeTruthy();
    }

    // The whole point: the sink is still live and still accepts new work.
    expect(sink.isDisabled).toBe(false);
    const third = await sink.ingestStreamEvent(runEvent({ event_id: "bbbbbbbb" }));
    expect(third.status).toBe("ingested");
    sink.close();
  });

  test("a provenance-only re-ingest is a plain no-op, never quarantined", async () => {
    // The identity fix (#326) means a different writer re-ingesting the same
    // event is idempotent. Quarantine must not fire here or every replay would
    // litter the store with records of nothing.
    const daemon = new OrchestrationLedgerSink({ host: "blade", source: "run-service" });
    expect((await daemon.ingestStreamEvent(runEvent({ event_id: "cccccccc" }))).status).toBe("ingested");
    daemon.close();

    const upgrade = new OrchestrationLedgerSink({ host: "blade", source: "self-upgrade" });
    const replay = await upgrade.ingestStreamEvent(runEvent({ event_id: "cccccccc" }));
    expect(replay.status).toBe("ingested");
    if (replay.status === "ingested") expect(replay.inserted).toBe(false);
    expect(upgrade.isDisabled).toBe(false);
    upgrade.close();
  });
});

describe("durability faults are never reported as progress (PR #329 review)", () => {
  /** Abort the next `event_cursors` write at the SQLite layer. */
  async function armCursorFailure(): Promise<void> {
    const { openStateStore } = await import("../state");
    const opened = await openStateStore();
    opened.db.exec(`
      CREATE TRIGGER IF NOT EXISTS zz_fail_cursor
      BEFORE INSERT ON event_cursors
      BEGIN SELECT RAISE(ABORT, 'injected cursor failure'); END;
    `);
    opened.db.close();
  }

  test("a cursor commit failure on the quarantine path reports disabled, not quarantined", async () => {
    // Reviewer repro: with the cursor error swallowed, this resolved
    // `{status:"quarantined"}` while readEventCursor stayed on the prior row,
    // so RunStore advanced its ordinal past an event the durable cursor had
    // never reached.
    const sink = new OrchestrationLedgerSink({ host: "blade" });
    expect((await sink.ingestStreamEvent(runEvent({ event_id: "dddddddd" }))).status).toBe("ingested");
    await armCursorFailure();

    const conflicting = runEvent({ event_id: "dddddddd", event_type: "run.started" });
    const outcome = await sink.ingestStreamEvent(conflicting);

    expect(outcome.status).toBe("disabled");
    expect(sink.isDisabled).toBe(true);
    expect(sink.disabledMessage).toMatch(/cursor commit failed/u);
    sink.close();
  });

  test("a cursor commit failure on the conflict-disappeared path also reports disabled", async () => {
    const sink = new OrchestrationLedgerSink({ host: "blade" });
    expect((await sink.ingestStreamEvent(runEvent({ event_id: "eeeeeeee" }))).status).toBe("ingested");
    await armCursorFailure();

    // Same identity, same content: the append is a no-op, but the cursor still
    // has to commit before this may be called progress.
    const outcome = await sink.ingestStreamEvent(runEvent({ event_id: "eeeeeeee" }));
    expect(outcome.status).toBe("disabled");
    expect(sink.isDisabled).toBe(true);
    sink.close();
  });

  test("strict mode propagates a cursor commit failure instead of resolving", async () => {
    const sink = new OrchestrationLedgerSink({ host: "blade", strict: true });
    expect((await sink.ingestStreamEvent(runEvent({ event_id: "ffffffff" }))).status).toBe("ingested");
    await armCursorFailure();

    await expect(
      sink.ingestStreamEvent(runEvent({ event_id: "ffffffff", event_type: "run.started" })),
    ).rejects.toThrow(/cursor commit failed/u);
    sink.close();
  });
});
