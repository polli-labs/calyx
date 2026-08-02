import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  applyStateMigrations,
  openStateStore,
  OrchestrationLedgerSink,
  resolveEventJournalPath,
  type SinkRunStreamEvent,
} from "@polli-labs/calyx-core";
import { EVENTS_INDEX_FILENAME, defaultRunsRoot } from "@polli-labs/calyx-run-service";

import { buildProgram } from "../run-cli";

interface CapturedIO {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  thrown?: unknown;
}

async function runCalyx(argv: string[]): Promise<CapturedIO> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts) => {
    out.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...parts) => {
    err.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  });
  let thrown: unknown;
  let exitCode: number | null = null;
  try {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "calyx", ...argv]);
  } catch (e) {
    thrown = e;
    if (e && typeof e === "object" && "exitCode" in e) {
      const code = (e as { exitCode?: unknown }).exitCode;
      if (typeof code === "number") exitCode = code;
    }
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { stdout: out, stderr: err, exitCode, thrown };
}

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB", "CALYX_RUNS_ROOT"] as const;

let root: string;
let stateHome: string;
let runsRoot: string;
let journalPath: string;
let original: Record<string, string | undefined>;

function runEvent(event_id: string, state = "succeeded"): SinkRunStreamEvent & { run: { state: string } } {
  return {
    schema_version: "1.0",
    event_id,
    cursor: `2026-07-27T00:00:00.000Z-${event_id}-000001`,
    emitted_at: "2026-07-27T00:00:00.000Z",
    event_type: "run.terminal",
    emitted_by: "run-service",
    run: { run_id: `run-${event_id}`, host: "blade", state },
  };
}

async function writeJournal(events: unknown[]): Promise<void> {
  await writeFile(journalPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

beforeEach(async () => {
  original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  root = await mkdtemp(join(tmpdir(), "calyx-state-event-log-cli-"));
  stateHome = join(root, "state");
  runsRoot = join(root, "runs");
  journalPath = join(runsRoot, EVENTS_INDEX_FILENAME);
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

describe("journal path resolution", () => {
  test("core's resolver and the run-service runs root cannot drift apart", () => {
    // `core` cannot import `run-service` (that direction is a cycle), so the
    // two resolutions are pinned to each other here instead of by types.
    delete process.env["CALYX_RUNS_ROOT"];
    try {
      expect(resolveEventJournalPath()).toBe(join(defaultRunsRoot(), EVENTS_INDEX_FILENAME));
    } finally {
      process.env["CALYX_RUNS_ROOT"] = runsRoot;
    }
    expect(resolveEventJournalPath()).toBe(join(defaultRunsRoot(), EVENTS_INDEX_FILENAME));
  });
});

describe("calyx state event-log rebuild", () => {
  test("--plan reports the gap as JSON and writes nothing", async () => {
    await writeJournal([runEvent("11111111-0000-0000-0000-000000000001")]);
    const result = await runCalyx(["state", "event-log", "rebuild", "--plan", "--json"]);
    expect(result.thrown).toBeUndefined();
    const parsed = JSON.parse(result.stdout.join("\n"));
    expect(parsed.schema_version).toBe("calyx.event-log-rebuild/v1");
    expect(parsed.mode).toBe("plan");
    expect(parsed.report.missing).toBe(1);
    expect(parsed.restored).toBe(0);
    expect(parsed.not_restorable.length).toBeGreaterThan(0);

    const opened = await openStateStore();
    try {
      const count = opened.db.prepare("SELECT COUNT(*) AS n FROM event_log").get() as { n: number };
      expect(Number(count.n)).toBe(0);
    } finally {
      opened.db.close();
    }
  });

  test("plan is the default — no flag must never write", async () => {
    await writeJournal([runEvent("11111111-0000-0000-0000-000000000002")]);
    const result = await runCalyx(["state", "event-log", "rebuild", "--json"]);
    const parsed = JSON.parse(result.stdout.join("\n"));
    expect(parsed.mode).toBe("plan");
    expect(parsed.restored).toBe(0);
  });

  test("--apply merges the journal and reports what it cannot restore", async () => {
    await writeJournal([
      runEvent("22222222-0000-0000-0000-000000000001"),
      runEvent("22222222-0000-0000-0000-000000000002"),
    ]);
    const result = await runCalyx(["state", "event-log", "rebuild", "--apply", "--json"]);
    expect(result.thrown).toBeUndefined();
    const parsed = JSON.parse(result.stdout.join("\n"));
    expect(parsed.mode).toBe("apply");
    expect(parsed.restored).toBe(2);
    expect(parsed.report.missing).toBe(2);
    expect(parsed.not_restorable.join("\n")).toContain("recorded_at");
  });

  test("--runs-root points the scan at another journal", async () => {
    const otherRoot = join(root, "other-runs");
    await mkdir(otherRoot, { recursive: true });
    await writeFile(
      join(otherRoot, EVENTS_INDEX_FILENAME),
      JSON.stringify(runEvent("33333333-0000-0000-0000-000000000001")) + "\n",
      "utf8",
    );
    await writeJournal([]);
    const result = await runCalyx([
      "state",
      "event-log",
      "rebuild",
      "--apply",
      "--runs-root",
      otherRoot,
      "--json",
    ]);
    const parsed = JSON.parse(result.stdout.join("\n"));
    expect(parsed.report.journal_path).toBe(join(otherRoot, EVENTS_INDEX_FILENAME));
    expect(parsed.restored).toBe(1);
  });

  test("--plan and --apply together is a usage error", async () => {
    const result = await runCalyx(["state", "event-log", "rebuild", "--plan", "--apply"]);
    expect(result.exitCode).toBe(2);
  });

  test("a refusal exits non-zero and names the reason", async () => {
    // An undeclared ledger writer means no rebuild can know its boundary.
    const opened = await openStateStore();
    try {
      opened.db
        .prepare(
          `INSERT INTO event_log (event_id, domain, aggregate_type, aggregate_id, event_type,
                                  cursor, occurred_at, recorded_at, payload_json)
           VALUES ('x1','calyx.mystery','t','a','e','c','2026-07-27T00:00:00.000Z','2026-07-27T00:00:00.000Z','{}')`,
        )
        .run();
    } finally {
      opened.db.close();
    }
    await writeJournal([]);
    const result = await runCalyx(["state", "event-log", "rebuild", "--apply", "--json"]);
    expect(result.exitCode).toBe(4);
    const parsed = JSON.parse(result.stdout.join("\n"));
    expect(parsed.refused_reason).toContain("calyx.mystery");
  });
});

describe("calyx state event-log quarantine", () => {
  test("lists nothing on a clean store", async () => {
    const result = await runCalyx(["state", "event-log", "quarantine", "--json"]);
    expect(result.thrown).toBeUndefined();
    const parsed = JSON.parse(result.stdout.join("\n"));
    expect(parsed.total).toBe(0);
    expect(parsed.entries).toEqual([]);
    expect(parsed.dir).toBe(join(stateHome, "quarantine", "event-log"));
  });

  test("shows both versions of a row a rebuild set aside", async () => {
    const committed = runEvent("44444444-0000-0000-0000-000000000001", "succeeded");
    const opened = await openStateStore();
    try {
      const sink = new OrchestrationLedgerSink({
        database: opened.db,
        source: "run-service",
        strict: true,
      });
      await sink.ingestStreamEvent(committed);
      sink.close();
    } finally {
      opened.db.close();
    }
    await writeJournal([runEvent("44444444-0000-0000-0000-000000000001", "failed")]);

    const rebuild = await runCalyx(["state", "event-log", "rebuild", "--apply", "--json"]);
    expect(JSON.parse(rebuild.stdout.join("\n")).replaced).toBe(1);

    const listed = await runCalyx(["state", "event-log", "quarantine", "--json"]);
    const parsed = JSON.parse(listed.stdout.join("\n"));
    expect(parsed.total).toBe(1);
    const record = parsed.entries[0].record;
    expect(record.event_id).toBe("44444444-0000-0000-0000-000000000001");
    expect(record.origin).toBe("rebuild");
    expect(record.resolution).toBe("kept-incoming");
    expect(record.committed.payload_json).toContain('"succeeded"');
    expect(record.incoming.payload_json).toContain('"failed"');
    // No acknowledgement surface exists: quarantine never gates.
    expect(record).not.toHaveProperty("acknowledged");
    expect(listed.exitCode).toBeNull();
  });
});

describe("calyx state doctor", () => {
  test("surfaces the projection summary and stays green on a repairable ledger", async () => {
    await writeJournal([runEvent("55555555-0000-0000-0000-000000000001")]);
    const result = await runCalyx(["state", "doctor", "--json"]);
    expect(result.thrown).toBeUndefined();
    const parsed = JSON.parse(result.stdout.join("\n"));
    expect(parsed.eventLogProjection.schema_version).toBe("calyx.event-log-projection/v1");
    expect(parsed.eventLogProjection.missing).toBe(1);
    expect(parsed.eventLogQuarantine.total).toBe(0);
    const gap = parsed.findings.find((f: { code: string }) => f.code === "orchestration-event-log-gap");
    expect(gap.severity).toBe("info");
    expect(parsed.ok).toBe(true);
  });

  test("human output names the projection state", async () => {
    await writeJournal([runEvent("66666666-0000-0000-0000-000000000001")]);
    const result = await runCalyx(["state", "doctor"]);
    expect(result.stderr.join("\n")).toContain("event-log:");
    expect(result.stderr.join("\n")).toContain("missing=1");
  });

  test("--domain orchestration carries the projection findings", async () => {
    await writeJournal([runEvent("77777777-0000-0000-0000-000000000001")]);
    const result = await runCalyx(["state", "doctor", "--domain", "orchestration", "--json"]);
    const parsed = JSON.parse(result.stdout.join("\n"));
    const codes = parsed.domains[0].findings.map((f: { code: string }) => f.code);
    expect(codes).toContain("orchestration-event-log-gap");
    expect(parsed.domains[0].status).toBe("ok");
  });
});
