import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  RunCreationConflictError,
  RunStore,
  type RecordedRunEvent,
  type RunIntent,
  type RunRecord,
} from "../index.js";
import type { RunCancellationRequest } from "../types.js";
import {
  issueRunCreationAdmission,
  legacyLaunchAdmissionIdentity,
} from "../store.js";

const syncTrace = vi.hoisted(() => [] as string[]);
const noReplaceLinkBarrier = vi.hoisted(() => ({
  targetPath: null as string | null,
  onLinked: null as (() => void) | null,
  waitForRelease: null as Promise<void> | null,
  release: null as (() => void) | null,
}));
const directorySyncBarrier = vi.hoisted(() => ({
  targetPath: null as string | null,
  onEntered: null as (() => void) | null,
  waitForRelease: null as Promise<void> | null,
  release: null as (() => void) | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      await actual.link(...args);
      if (String(args[1]) === noReplaceLinkBarrier.targetPath) {
        noReplaceLinkBarrier.onLinked?.();
        await noReplaceLinkBarrier.waitForRelease;
      }
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const originalSync = handle.sync.bind(handle);
      handle.sync = async () => {
        syncTrace.push(String(args[0]));
        await originalSync();
        if (String(args[0]) === directorySyncBarrier.targetPath) {
          directorySyncBarrier.targetPath = null;
          directorySyncBarrier.onEntered?.();
          await directorySyncBarrier.waitForRelease;
        }
      };
      return handle;
    },
  };
});

describe("RunStore durable event persistence", () => {
  let container: string;

  beforeEach(async () => {
    syncTrace.length = 0;
    noReplaceLinkBarrier.targetPath = null;
    noReplaceLinkBarrier.onLinked = null;
    noReplaceLinkBarrier.waitForRelease = null;
    noReplaceLinkBarrier.release = null;
    directorySyncBarrier.targetPath = null;
    directorySyncBarrier.onEntered = null;
    directorySyncBarrier.waitForRelease = null;
    directorySyncBarrier.release = null;
    container = await mkdtemp(path.join(tmpdir(), "calyx-run-store-durability-"));
  });

  afterEach(async () => {
    noReplaceLinkBarrier.release?.();
    directorySyncBarrier.release?.();
    await rm(container, { recursive: true, force: true });
  });

  test("syncs a completely new durable event subtree from file through the runs-root parent", async () => {
    const runsRoot = path.join(container, "runs");
    const runId = "run-first-durable-intent";
    const store = new RunStore(runsRoot);
    const event: RecordedRunEvent = {
      timestamp: "2026-07-14T04:30:00.000Z",
      run_id: runId,
      source: "run-service",
      event: "launch_intent",
      message: "Launch requested.",
    };

    await store.appendDurableEvent(runId, event);

    const paths = store.paths(runId);
    expect(syncTrace).toEqual([
      paths.eventsPath,
      paths.runDir,
      runsRoot,
      container,
    ]);
  });

  test("quarantine cannot pass a durable append before its directory fsync barrier", async () => {
    const runsRoot = path.join(container, "runs");
    const runId = "run-quarantine-append-barrier";
    const stores = [new RunStore(runsRoot), new RunStore(runsRoot)];
    const paths = stores[0]!.paths(runId);
    const event: RecordedRunEvent = {
      timestamp: "2026-07-14T04:30:00.000Z",
      run_id: runId,
      source: "run-service",
      event: "launch_intent",
      message: "Launch requested durably.",
    };
    let entered!: () => void;
    const atDirectorySync = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    directorySyncBarrier.targetPath = paths.runDir;
    directorySyncBarrier.onEntered = entered;
    directorySyncBarrier.waitForRelease = released;
    directorySyncBarrier.release = release;

    const append = stores[0]!.appendDurableEvent(runId, event);
    await atDirectorySync;
    let quarantineSettled = false;
    const quarantine = stores[1]!.quarantineEventJournal(runId).finally(() => {
      quarantineSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(quarantineSettled).toBe(false);
    release();
    await append;
    await expect(quarantine).resolves.toBeUndefined();
    expect(syncTrace).toEqual([
      paths.eventsPath,
      paths.runDir,
      runsRoot,
      container,
    ]);
    expect((await readdir(paths.runDir)).some((entry) => entry.includes(".corrupt."))).toBe(false);
    await expect(readFile(paths.eventsPath, "utf8")).resolves.toContain("Launch requested durably.");
  });

  test("publishes one complete first-creator record across independent stores", async () => {
    const runsRoot = path.join(container, "runs");
    const runId = "run-cross-process-claim";
    const intents: RunIntent[] = [
      { run_id: runId, host: "blade", prompt: "creator one", created_at: "2026-07-14T05:00:00.000Z" },
      { run_id: runId, host: "blade", prompt: "creator two", created_at: "2026-07-14T05:00:01.000Z" },
    ];
    const provenances = [
      {
        schema_version: "calyx.provenance/v1" as const,
        request_id: "req_00000000-0000-4000-8000-000000000011",
        subject: "control-plane:test",
        asserted_actor: "operator:one",
        host: "blade",
        via: "http" as const,
        at: "2026-07-14T05:00:00.000Z",
      },
      {
        schema_version: "calyx.provenance/v1" as const,
        request_id: "req_00000000-0000-4000-8000-000000000012",
        subject: "control-plane:test",
        asserted_actor: "operator:two",
        host: "blade",
        via: "http" as const,
        at: "2026-07-14T05:00:01.000Z",
      },
    ];
    const stores = [new RunStore(runsRoot), new RunStore(runsRoot)];
    const outcomes = await Promise.allSettled(stores.map((store, index) => store.createRun(issueRunCreationAdmission(), intents[index]!, {
      creationProvenance: provenances[index],
    })));
    const winnerIndex = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
    const loser = outcomes.find((outcome) => outcome.status === "rejected");
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(loser).toMatchObject({ reason: expect.any(RunCreationConflictError) });

    const reader = new RunStore(runsRoot);
    expect(await reader.readRunRecord(runId)).toMatchObject({
      intent: intents[winnerIndex],
      creation_provenance: provenances[winnerIndex],
    });
    expect((await reader.readRunRecord(runId))?.intent).toEqual(intents[winnerIndex]);
    expect((await readdir(reader.paths(runId).runDir)).filter((name) => name.includes(".claim."))).toEqual([]);
  });

  test("an EEXIST cancellation publisher fsyncs the winning link before acknowledging it", async () => {
    const runsRoot = path.join(container, "runs");
    const runId = "run-concurrent-cancellation";
    const paths = new RunStore(runsRoot).paths(runId);
    const first: RunCancellationRequest = {
      schema_version: "calyx.run-cancellation/v1",
      run_id: runId,
      requested_at: "2026-07-14T05:30:00.000Z",
      reason: "first admission",
    };
    const second: RunCancellationRequest = {
      schema_version: "calyx.run-cancellation/v1",
      run_id: runId,
      requested_at: "2026-07-14T05:30:01.000Z",
      reason: "concurrent retry",
    };
    let markLinked!: () => void;
    const linked = new Promise<void>((resolve) => { markLinked = resolve; });
    let releaseWinner!: () => void;
    const waitForRelease = new Promise<void>((resolve) => { releaseWinner = resolve; });
    noReplaceLinkBarrier.targetPath = paths.cancellationPath;
    noReplaceLinkBarrier.onLinked = markLinked;
    noReplaceLinkBarrier.waitForRelease = waitForRelease;
    noReplaceLinkBarrier.release = releaseWinner;

    let winnerSettled = false;
    const winner = new RunStore(runsRoot).requestCancellation(first).finally(() => {
      winnerSettled = true;
    });
    await linked;
    expect(winnerSettled).toBe(false);

    // The winner's link exists, but its mocked link(2) has not returned, so it
    // cannot have reached the directory fsync below publishJsonNoReplace yet.
    syncTrace.length = 0;
    const observed = await new RunStore(runsRoot).requestCancellation(second);
    expect(observed).toEqual(first);
    expect(winnerSettled).toBe(false);
    expect(syncTrace.at(-1)).toBe(paths.runDir);

    releaseWinner();
    await winner;
  });

  test("rejects non-canonical run ids before resolving a filesystem path", async () => {
    const store = new RunStore(path.join(container, "runs"));
    for (const runId of ["../escape", "nested/run", ".", " run", "run\nnext"]) {
      expect(() => store.paths(runId), runId).toThrow(/run_id must be/);
    }
  });

  test("normalizes a terminal pre-launch-metadata record without inventing execution identity", async () => {
    const store = new RunStore(path.join(container, "runs"));
    const runId = "legacy-terminal-record";
    const paths = store.paths(runId);
    await mkdir(paths.runDir, { recursive: true });
    const legacy = {
      schema_version: "1.0",
      run_id: runId,
      state: "succeeded",
      intent: { run_id: runId, host: "blade", created_at: "2026-04-20T00:00:00.000Z" },
      integrations: { results: [], all_critical_ok: true },
      recovery: { mode: "normal", resumable: false },
      summary: `Run ${runId} succeeded.`,
      created_at: "2026-04-20T00:00:00.000Z",
      updated_at: "2026-04-20T00:01:00.000Z",
      completed_at: "2026-04-20T00:01:00.000Z",
    };
    await writeFile(paths.runRecordPath, `${JSON.stringify(legacy)}\n`, "utf8");

    const normalized = await store.readRunRecord(runId);
    expect(normalized?.launch).toMatchObject({
      mode: "inline",
      stage: "executing",
      admission_identity: expect.any(String),
      request_hash: expect.any(String),
      accepted_at: legacy.created_at,
      dispatch_attempts: 0,
    });
    expect(normalized?.launch).not.toHaveProperty("execution_id");
    expect(store.needsLaunchMigration(runId)).toBe(true);
    expect(JSON.parse(await readFile(paths.runRecordPath, "utf8"))).not.toHaveProperty("launch");
  });

  test("normalizes a queued legacy detached record from durable launch evidence", async () => {
    const store = new RunStore(path.join(container, "runs"));
    const runId = "legacy-queued-detached-record";
    const paths = store.paths(runId);
    await store.appendEvent(runId, {
      timestamp: "2026-04-20T00:00:30.000Z",
      run_id: runId,
      source: "run-service",
      event: "launch_dispatched",
      message: "Spawned detached run worker.",
    });
    const legacy: Omit<RunRecord, "launch"> = {
      schema_version: "1.0",
      run_id: runId,
      state: "queued",
      intent: { run_id: runId, host: "blade", created_at: "2026-04-20T00:00:00.000Z" },
      integrations: { results: [], all_critical_ok: true },
      recovery: { mode: "normal", resumable: false },
      summary: `Run ${runId} queued.`,
      created_at: "2026-04-20T00:00:00.000Z",
      updated_at: "2026-04-20T00:00:30.000Z",
    };
    await writeFile(paths.runRecordPath, `${JSON.stringify(legacy)}\n`, "utf8");

    const normalized = await store.readRunRecord(runId);
    expect(normalized?.launch).toMatchObject({
      mode: "detached",
      stage: "accepted",
      accepted_at: legacy.created_at,
      dispatch_attempts: 1,
      last_dispatch_at: "2026-04-20T00:00:30.000Z",
    });
    expect(normalized?.launch).not.toHaveProperty("execution_id");
  });

  test("normalizes a running legacy record as owner-free without synthetic ownership", async () => {
    const store = new RunStore(path.join(container, "runs"));
    const runId = "legacy-running-record";
    const paths = store.paths(runId);
    await mkdir(paths.runDir, { recursive: true });
    const legacy: Omit<RunRecord, "launch"> = {
      schema_version: "1.0",
      run_id: runId,
      state: "running",
      intent: { run_id: runId, host: "blade", created_at: "2026-04-20T00:00:00.000Z" },
      integrations: { results: [], all_critical_ok: true },
      recovery: { mode: "normal", resumable: false },
      summary: `Run ${runId} running.`,
      created_at: "2026-04-20T00:00:00.000Z",
      updated_at: "2026-04-20T00:01:00.000Z",
    };
    await writeFile(paths.runRecordPath, `${JSON.stringify(legacy)}\n`, "utf8");

    const normalized = await store.readRunRecord(runId);
    expect(normalized?.launch).toMatchObject({
      mode: "inline",
      stage: "executing",
      dispatch_attempts: 0,
    });
    expect(normalized?.launch).not.toHaveProperty("execution_id");
    expect(normalized?.launch).not.toHaveProperty("execution_started_at");
  });

  test.each([
    ["missing mode", { mode: undefined }],
    ["invalid mode", { mode: "remote" }],
    ["missing stage", { stage: undefined }],
    ["invalid stage", { stage: "finished" }],
    ["missing admission identity", { admission_identity: undefined }],
    ["invalid admission identity", { admission_identity: "not-a-hash" }],
    ["missing request hash", { request_hash: undefined }],
    ["invalid request hash", { request_hash: "not-a-hash" }],
    ["missing accepted timestamp", { accepted_at: undefined }],
    ["invalid accepted timestamp", { accepted_at: "yesterday" }],
    ["missing dispatch attempts", { dispatch_attempts: undefined }],
    ["negative dispatch attempts", { dispatch_attempts: -1 }],
    ["fractional dispatch attempts", { dispatch_attempts: 1.5 }],
    [
      "invalid optional fields",
      { last_dispatch_at: "yesterday", execution_id: "", execution_started_at: "tomorrow" },
    ],
  ])("normalizes partial legacy launch metadata with %s", async (_label, patch) => {
    const suffix = String(_label).replace(/[^a-z]+/gu, "-").replace(/^-|-$/gu, "");
    const runId = `legacy-partial-launch-${suffix}`;
    const store = new RunStore(path.join(container, "runs"));
    const paths = store.paths(runId);
    await mkdir(paths.runDir, { recursive: true });
    const createdAt = "2026-04-20T00:00:00.000Z";
    const launch = {
      mode: "detached",
      stage: "dispatching",
      admission_identity: "a".repeat(64),
      request_hash: "b".repeat(64),
      accepted_at: createdAt,
      dispatch_attempts: 2,
      ...patch,
    };
    const legacy = {
      schema_version: "1.0",
      run_id: runId,
      state: "succeeded",
      intent: { run_id: runId, host: "blade", created_at: createdAt },
      launch,
      integrations: { results: [], all_critical_ok: true },
      recovery: { mode: "normal", resumable: false },
      summary: `Run ${runId} succeeded.`,
      created_at: createdAt,
      updated_at: "2026-04-20T00:01:00.000Z",
      completed_at: "2026-04-20T00:01:00.000Z",
    };
    await writeFile(paths.runRecordPath, `${JSON.stringify(legacy)}\n`, "utf8");

    const normalized = await store.readRunRecord(runId);
    expect(normalized?.launch.mode).toMatch(/^(?:inline|detached)$/u);
    expect(normalized?.launch.stage).toMatch(/^(?:accepted|dispatching|executing)$/u);
    expect(normalized?.launch.admission_identity).toBe(legacyLaunchAdmissionIdentity(
      runId,
      normalized!.launch.request_hash,
    ));
    expect(normalized?.launch.request_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(normalized?.launch.accepted_at).toBe(createdAt);
    expect(Number.isInteger(normalized?.launch.dispatch_attempts)).toBe(true);
    expect(normalized?.launch.dispatch_attempts).toBeGreaterThanOrEqual(0);
    expect(normalized?.launch).not.toHaveProperty("last_dispatch_at");
    expect(normalized?.launch).not.toHaveProperty("execution_id");
    expect(normalized?.launch).not.toHaveProperty("execution_started_at");
    expect(store.needsLaunchMigration(runId)).toBe(true);
  });

  test("reserves the synthesized legacy admission identity for read-time migration", async () => {
    const runId = "reserved-legacy-launch-admission";
    const requestHash = "b".repeat(64);
    const store = new RunStore(path.join(container, "runs"));
    const intent: RunIntent = {
      run_id: runId,
      host: "blade",
      created_at: "2026-04-20T00:00:00.000Z",
    };

    await expect(store.createRun(issueRunCreationAdmission(), intent, {
      requestHash,
      admissionIdentity: legacyLaunchAdmissionIdentity(runId, requestHash),
    })).rejects.toThrow("reserved for read-time migration");
  });
});
