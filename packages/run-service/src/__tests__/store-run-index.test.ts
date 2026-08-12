import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  applyStateMigrations,
  countRunIndexEntries,
  openStateStore,
  RUN_INDEX_INITIAL_BACKFILL_KEY,
  RUN_INDEX_PROJECTION_DEGRADED_KEY,
  RunIndexProjection,
  readStateMeta,
  upsertRunIndexEntry,
} from "@polli-labs/calyx-core";

import {
  issueRunCreationAdmission,
  RunIndexProjectionNotReadyError,
  RunListSnapshotChangedError,
  RunStore,
} from "../store.js";
import { RunService } from "./support/test-run-service.js";
import type {
  RunIntent,
  RunRecord,
} from "../types.js";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;

async function makeStateHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "calyx-store-run-index-"));
  return join(root, "state");
}

function buildIntent(runId: string, overrides: Partial<RunIntent> = {}): RunIntent {
  return {
    run_id: runId,
    host: "blade",
    created_at: "2026-05-10T00:00:00.000Z",
    ...overrides,
  };
}

function buildTerminalRecord(intent: RunIntent, overrides: Partial<RunRecord> = {}): RunRecord {
  const completedAt = "2026-05-10T01:00:00.000Z";
  return {
    schema_version: "1.0",
    run_id: intent.run_id,
    state: "succeeded",
    intent,
    launch: {
      mode: "inline",
      stage: "executing",
      admission_identity: "a".repeat(64),
      request_hash: "b".repeat(64),
      accepted_at: intent.created_at,
      dispatch_attempts: 0,
    },
    integrations: { results: [], all_critical_ok: true },
    recovery: { mode: "normal", resumable: false },
    summary: `Run ${intent.run_id} succeeded.`,
    created_at: intent.created_at,
    updated_at: completedAt,
    completed_at: completedAt,
    ...overrides,
  };
}

async function writeCurrentClaimRecord(store: RunStore, record: RunRecord): Promise<void> {
  const current = await store.readRunRecord(record.run_id);
  const launch = { ...record.launch };
  if (current?.launch?.incarnation_id === undefined) {
    delete launch.incarnation_id;
  } else {
    launch.incarnation_id = current.launch.incarnation_id;
  }
  await store.writeRunRecord(record.run_id, { ...record, launch });
}

describe("RunStore SQLite run_index (wave 2.2)", () => {
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

  test("writeRunRecord upserts into SQLite run_index instead of index.jsonl", async () => {
    const projection = new RunIndexProjection();
    const store = new RunStore(runsRoot, { runIndex: projection });

    const intent = buildIntent("run-write-1");
    await store.createRun(issueRunCreationAdmission(), intent);
    await writeCurrentClaimRecord(store, buildTerminalRecord(intent));

    // SQLite has the row.
    const opened = await openStateStore();
    try {
      expect(countRunIndexEntries(opened.db)).toBe(1);
      const row = opened.db
        .prepare(`SELECT state, summary, recovery_mode, run_dir FROM run_index WHERE run_id = ?`)
        .get("run-write-1") as { state: string; summary: string; recovery_mode: string; run_dir: string };
      expect(row.state).toBe("succeeded");
      expect(row.recovery_mode).toBe("normal");
      expect(row.run_dir).toBe(join(runsRoot, "run-write-1"));
    } finally {
      opened.db.close();
    }

    projection.close();

    // Deletion proof: index.jsonl is not created.
    await expect(stat(join(runsRoot, "index.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("listRuns reads SQLite as the source of truth", async () => {
    const projection = new RunIndexProjection();
    const store = new RunStore(runsRoot, { runIndex: projection });

    const intentA = buildIntent("run-list-A");
    const intentB = buildIntent("run-list-B");
    await store.createRun(issueRunCreationAdmission(), intentA);
    await store.createRun(issueRunCreationAdmission(), intentB);
    await writeCurrentClaimRecord(store, buildTerminalRecord(intentA));
    await writeCurrentClaimRecord(store, buildTerminalRecord(intentB, { state: "running" }));

    const runs = await store.listRuns();
    expect(runs.map((entry) => entry.run_id).sort()).toEqual(["run-list-A", "run-list-B"]);
    const active = await store.listActiveRuns();
    expect(active.map((entry) => entry.run_id)).toEqual(["run-list-B"]);

    projection.close();
  });

  test("membership-checkpointed store pages reject a post-page backdated run", async () => {
    const projection = new RunIndexProjection();
    const store = new RunStore(runsRoot, { runIndex: projection });
    for (const [runId, createdAt] of [
      ["run-page-newest", "2026-05-10T02:00:00.000Z"],
      ["run-page-oldest", "2026-05-10T00:00:00.000Z"],
    ] as const) {
      const intent = buildIntent(runId, { created_at: createdAt });
      await store.createRun(issueRunCreationAdmission(), intent);
      await writeCurrentClaimRecord(store, buildTerminalRecord(intent));
    }

    const first = await store.listRunsSnapshotPage({ limit: 1 });
    expect(first.entries.map((entry) => entry.run_id)).toEqual(["run-page-newest"]);
    expect(first.membershipFence).toMatch(
      /^run-list-membership:v3:[0-9a-f]{32}:[0-9]+:[0-9a-f]{32}:[0-9a-f]{64}$/u,
    );

    const backdated = buildIntent("run-page-backdated", {
      created_at: "2026-05-10T01:00:00.000Z",
    });
    await store.createRun(issueRunCreationAdmission(), backdated);
    await writeCurrentClaimRecord(store, buildTerminalRecord(backdated));

    await expect(store.listRunsSnapshotPage({
      after: {
        created_at: first.entries[0]!.created_at,
        run_id: first.entries[0]!.run_id,
      },
      expected_membership_fence: first.membershipFence,
      limit: 1,
    })).rejects.toBeInstanceOf(RunListSnapshotChangedError);
    projection.close();
  });

  test("updated_at-only progress preserves the store cursor and reaches page two", async () => {
    const projection = new RunIndexProjection();
    const store = new RunStore(runsRoot, { runIndex: projection });
    const newest = buildIntent("run-progress-newest", {
      created_at: "2026-05-10T02:00:00.000Z",
    });
    const oldest = buildIntent("run-progress-oldest", {
      created_at: "2026-05-10T01:00:00.000Z",
    });
    for (const intent of [newest, oldest]) {
      await store.createRun(issueRunCreationAdmission(), intent);
      await writeCurrentClaimRecord(store, buildTerminalRecord(intent, {
        updated_at: intent.created_at,
        completed_at: intent.created_at,
      }));
    }
    const first = await store.listRunsSnapshotPage({ limit: 1 });

    await writeCurrentClaimRecord(store, buildTerminalRecord(newest, {
      summary: "New progress without list identity drift.",
      updated_at: "2026-05-10T03:00:00.000Z",
      completed_at: "2026-05-10T03:00:00.000Z",
    }));

    const second = await store.listRunsSnapshotPage({
      after: {
        created_at: first.entries[0]!.created_at,
        run_id: first.entries[0]!.run_id,
      },
      expected_membership_fence: first.membershipFence,
      limit: 1,
    });
    expect(second.membershipFence).not.toBe(first.membershipFence);
    expect(second.entries.map((entry) => entry.run_id)).toEqual([oldest.run_id]);
    projection.close();
  });

  test("updated_at crossing updated_since eligibility invalidates the store cursor", async () => {
    const projection = new RunIndexProjection();
    const store = new RunStore(runsRoot, { runIndex: projection });
    const eligible = buildIntent("run-filter-eligible", {
      created_at: "2026-05-10T02:00:00.000Z",
    });
    const crossing = buildIntent("run-filter-crossing", {
      created_at: "2026-05-10T01:00:00.000Z",
    });
    await store.createRun(issueRunCreationAdmission(), eligible);
    await writeCurrentClaimRecord(store, buildTerminalRecord(eligible, {
      updated_at: "2026-05-10T03:00:00.000Z",
      completed_at: "2026-05-10T03:00:00.000Z",
    }));
    await store.createRun(issueRunCreationAdmission(), crossing);
    await writeCurrentClaimRecord(store, buildTerminalRecord(crossing, {
      updated_at: "2026-05-10T02:00:00.000Z",
      completed_at: "2026-05-10T02:00:00.000Z",
    }));
    const options = { updated_since: "2026-05-10T02:30:00.000Z", limit: 1 } as const;
    const first = await store.listRunsSnapshotPage(options);

    await writeCurrentClaimRecord(store, buildTerminalRecord(crossing, {
      updated_at: "2026-05-10T03:30:00.000Z",
      completed_at: "2026-05-10T03:30:00.000Z",
    }));

    await expect(store.listRunsSnapshotPage({
      ...options,
      after: {
        created_at: first.entries[0]!.created_at,
        run_id: first.entries[0]!.run_id,
      },
      expected_membership_fence: first.membershipFence,
    })).rejects.toBeInstanceOf(RunListSnapshotChangedError);
    projection.close();
  });

  test("snapshot pagination requires the SQLite projection instead of scanning records", async () => {
    const fileOnly = new RunStore(runsRoot);
    for (const [runId, createdAt] of [
      ["run-parity-newest", "2026-05-10T02:00:00.000Z"],
      ["run-parity-oldest", "2026-05-10T01:00:00.000Z"],
    ] as const) {
      const intent = buildIntent(runId, { created_at: createdAt });
      await fileOnly.createRun(issueRunCreationAdmission(), intent);
      await writeCurrentClaimRecord(fileOnly, buildTerminalRecord(intent));
    }
    const options = {
      host: "blade.polli.test",
      created_before: "2026-05-10T03:00:00.000Z",
      limit: 1,
    } as const;
    await expect(fileOnly.listRunsSnapshotPage(options))
      .rejects.toBeInstanceOf(RunIndexProjectionNotReadyError);

    const projection = new RunIndexProjection();
    const projected = new RunStore(runsRoot, { runIndex: projection });
    const sqliteFirst = await projected.listRunsSnapshotPage(options);
    expect(sqliteFirst.entries.map((entry) => entry.run_id)).toEqual(["run-parity-newest"]);
    expect(sqliteFirst.membershipFence).toMatch(
      /^run-list-membership:v3:[0-9a-f]{32}:[0-9]+:[0-9a-f]{32}:[0-9a-f]{64}$/u,
    );
    projection.close();
  });

  test("one-time rebuild from run_record.json files when SQLite is empty", async () => {
    // First, write records using a store without a projection (no SQLite
    // rows produced). This simulates a fresh DB after a migration when
    // the runs directory already has authoritative records.
    const fileOnlyStore = new RunStore(runsRoot);
    const intentA = buildIntent("run-rebuild-A");
    const intentB = buildIntent("run-rebuild-B");
    await fileOnlyStore.createRun(issueRunCreationAdmission(), intentA);
    await fileOnlyStore.createRun(issueRunCreationAdmission(), intentB);
    await writeCurrentClaimRecord(fileOnlyStore, buildTerminalRecord(intentA));
    await writeCurrentClaimRecord(fileOnlyStore, buildTerminalRecord(intentB));

    // Sanity: SQLite is empty pre-rebuild.
    {
      const opened = await openStateStore();
      try {
        expect(countRunIndexEntries(opened.db)).toBe(0);
      } finally {
        opened.db.close();
      }
    }

    // Now open with a projection. The first listRuns call should rebuild
    // from authoritative run_record.json files.
    const projection = new RunIndexProjection();
    const store = new RunStore(runsRoot, { runIndex: projection });

    const runs = await store.listRuns();
    expect(runs.map((entry) => entry.run_id).sort()).toEqual([
      "run-rebuild-A",
      "run-rebuild-B",
    ]);

    {
      const opened = await openStateStore();
      try {
        expect(countRunIndexEntries(opened.db)).toBe(2);
      } finally {
        opened.db.close();
      }
    }

    projection.close();
  });

  test("rebuildRunIndex replaces stale SQLite rows from authoritative records", async () => {
    const projection = new RunIndexProjection();
    const store = new RunStore(runsRoot, { runIndex: projection });

    const intent = buildIntent("run-rebuild-divergence");
    await store.createRun(issueRunCreationAdmission(), intent);
    await writeCurrentClaimRecord(store, buildTerminalRecord(intent));

    // Consume the one-time first-list backfill so subsequent direct
    // SQLite mutations are visible via listRuns. After this call,
    // `run_index` reflects disk exactly; the next listRuns reads SQLite
    // as the source of truth.
    await store.listRuns();

    // Directly inject a stale `running` row into SQLite, modeling the
    // divergent state the pre-2.2 race could leave on index.jsonl.
    {
      const opened = await openStateStore();
      try {
        upsertRunIndexEntry(opened.db, {
          run_id: intent.run_id,
          state: "running",
          summary: "stale",
          created_at: intent.created_at,
          updated_at: intent.created_at,
          recovery_mode: "normal",
          run_dir: join(runsRoot, intent.run_id),
        });
      } finally {
        opened.db.close();
      }
    }

    // Before rebuild, listRuns reports the stale SQLite row.
    {
      const before = await store.listRuns();
      expect(before.find((entry) => entry.run_id === intent.run_id)?.state).toBe(
        "running",
      );
    }

    // rebuildRunIndex (called by RunService.reconcile) heals the divergence.
    await store.rebuildRunIndex();
    const after = await store.listRuns();
    expect(after.find((entry) => entry.run_id === intent.run_id)?.state).toBe(
      "succeeded",
    );

    const active = await store.listActiveRuns();
    expect(active.find((entry) => entry.run_id === intent.run_id)).toBeUndefined();

    projection.close();
  });

  test("explicit rebuild preserves writes published after its scan", async () => {
    const oldIntent = buildIntent("run-explicit-rebuild-race-existing");
    {
      const fileOnly = new RunStore(runsRoot);
      await fileOnly.createRun(issueRunCreationAdmission(), oldIntent);
      await writeCurrentClaimRecord(fileOnly, buildTerminalRecord(oldIntent, {
        state: "succeeded",
        summary: "stale explicit-rebuild scan",
      }));
    }

    const projection = new RunIndexProjection();
    const store = new RunStore(runsRoot, { runIndex: projection });
    const originalReplace = projection.replace.bind(projection);
    const concurrentIntent = buildIntent("run-explicit-rebuild-race-new", {
      created_at: "2026-05-10T02:00:00.000Z",
    });
    const newerExisting = buildTerminalRecord(oldIntent, {
      state: "failed",
      summary: "newer authoritative record with rolled-back clock",
      updated_at: "2026-05-09T23:00:00.000Z",
      completed_at: "2026-05-09T23:00:00.000Z",
    });
    let createPromise: Promise<RunRecord> | undefined;
    let updatePromise: Promise<void> | undefined;
    const replaceSpy = vi.spyOn(projection, "replace").mockImplementation(async (rows) => {
      // rebuildRunIndex holds the projection mutex here. Both writers queue
      // behind the durable marker -> JSON -> projection publication boundary.
      createPromise = store.createRun(issueRunCreationAdmission(), concurrentIntent);
      updatePromise = writeCurrentClaimRecord(store, newerExisting);
      return originalReplace(rows);
    });

    const rebuilt = await store.rebuildRunIndex();
    await Promise.all([createPromise, updatePromise]);

    expect(rebuilt.projection).toEqual({ status: "repaired", rowCount: 1 });
    const listed = await store.listRuns();
    expect(listed.find((entry) => entry.run_id === concurrentIntent.run_id)).toMatchObject({
      state: "queued",
    });
    expect(listed.find((entry) => entry.run_id === oldIntent.run_id)).toMatchObject({
      state: "failed",
      summary: newerExisting.summary,
      updated_at: newerExisting.updated_at,
    });

    replaceSpy.mockRestore();
    projection.close();
  });

  test("explicit rebuild reports a disabled projection as a failed repair", async () => {
    const projection = new RunIndexProjection();
    const store = new RunStore(runsRoot, { runIndex: projection });
    const intent = buildIntent("run-explicit-rebuild-disabled");
    await store.createRun(issueRunCreationAdmission(), intent);
    vi.spyOn(projection, "replace").mockResolvedValue({
      status: "disabled",
      reason: "simulated projection failure",
    });

    await expect(store.rebuildRunIndex()).resolves.toMatchObject({
      projection: { status: "failed", reason: "simulated projection failure" },
    });
    projection.close();
  });

  test("projection failure leaves run_record authoritative and does not kill its writer", async () => {
    const projection = new RunIndexProjection();
    const store = new RunStore(runsRoot, { runIndex: projection });

    // Establish the steady-state marker. A fresh process will now trust SQLite
    // rather than implicitly scanning a newly-published disk-only record.
    expect(await store.listRuns()).toEqual([]);
    const upsertSpy = vi.spyOn(projection, "upsert").mockResolvedValue({
      status: "disabled",
      reason: "simulated transient projection failure",
    });
    const rebuildSpy = vi.spyOn(store, "rebuildRunIndex").mockResolvedValue({
      entries: [],
      missingRecordRunIds: [],
      projection: { status: "failed", reason: "simulated repair contention" },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const intent = buildIntent("run-projection-write-disabled");

    await expect(store.createRun(issueRunCreationAdmission(), intent)).resolves.toMatchObject({
      run_id: intent.run_id,
      state: "queued",
    });
    await vi.waitFor(() => expect(rebuildSpy).toHaveBeenCalled());

    // JSON publication is the authority. A derived projection outage is
    // observable and repairable, but cannot revoke execution ownership.
    expect(JSON.parse(await readFile(store.paths(intent.run_id).runRecordPath, "utf8"))).toMatchObject({
      run_id: intent.run_id,
      state: "queued",
    });
    expect(store.isRunIndexProjectionRepairPending(intent.run_id)).toBe(true);
    {
      const opened = await openStateStore();
      try {
        expect(readStateMeta(opened.db, RUN_INDEX_PROJECTION_DEGRADED_KEY)?.value)
          .toContain(intent.run_id);
      } finally {
        opened.db.close();
      }
    }

    // The reviewer's direct probe: queued JSON + repair pending must never
    // disappear from either the same process or a fresh RunStore. The first
    // reader falls back to authoritative records while its injected repair
    // remains failed; the fresh reader owns restart convergence.
    await expect(store.listRuns()).resolves.toEqual([
      expect.objectContaining({ run_id: intent.run_id, state: "queued" }),
    ]);
    const freshQueuedProjection = new RunIndexProjection();
    const freshQueuedStore = new RunStore(runsRoot, { runIndex: freshQueuedProjection });
    await expect(freshQueuedStore.listRuns()).resolves.toEqual([
      expect.objectContaining({ run_id: intent.run_id, state: "queued" }),
    ]);
    freshQueuedProjection.close();

    await expect(store.writeRunRecord(intent.run_id, {
      ...(await store.readRunRecord(intent.run_id))!,
      state: "running",
      summary: "writer remained alive after projection failure",
      updated_at: "2026-05-10T00:00:01.000Z",
    })).resolves.toBeUndefined();
    await expect(store.readRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "running",
      summary: "writer remained alive after projection failure",
    });
    const opened = await openStateStore();
    try {
      expect(countRunIndexEntries(opened.db)).toBe(1);
      expect(readStateMeta(opened.db, RUN_INDEX_PROJECTION_DEGRADED_KEY)?.value)
        .toContain(intent.run_id);
    } finally {
      opened.db.close();
    }

    const freshProjection = new RunIndexProjection();
    const freshStore = new RunStore(runsRoot, { runIndex: freshProjection });
    await expect(freshStore.listRuns()).resolves.toEqual([
      expect.objectContaining({
        run_id: intent.run_id,
        state: "running",
        summary: "writer remained alive after projection failure",
      }),
    ]);
    {
      const repaired = await openStateStore();
      try {
        expect(readStateMeta(repaired.db, RUN_INDEX_PROJECTION_DEGRADED_KEY)).toBeUndefined();
        expect(countRunIndexEntries(repaired.db)).toBe(1);
      } finally {
        repaired.db.close();
      }
    }
    await vi.waitFor(() => expect(rebuildSpy.mock.calls.length).toBeGreaterThanOrEqual(4));

    warnSpy.mockRestore();
    rebuildSpy.mockRestore();
    upsertSpy.mockRestore();
    freshProjection.close();
    projection.close();
  });

  test("first-list rebuild backfills pre-existing records even when a new run is projected first", async () => {
    // POL-1348 conductor-blocker regression. Models the post-migration
    // transitional window where:
    //   1. migration 0003 has been applied, `run_index` is empty;
    //   2. pre-existing `run_record.json` files exist on disk from
    //      before the migration (written by a store without a
    //      projection);
    //   3. a projection-backed store then writes one new run before
    //      the first `listRuns()` / `listActiveRuns()` call, leaving
    //      `run_index` with a single row that is _not_ proof the
    //      backfill has happened.
    // The first list call must still surface all pre-existing records,
    // not silently elide them.
    const intentOldA = buildIntent("run-pre-A");
    const intentOldB = buildIntent("run-pre-B");
    const intentOldActive = buildIntent("run-pre-active");

    // 1+2. Write pre-existing records via a store with no projection
    //      so SQLite stays empty.
    {
      const fileOnly = new RunStore(runsRoot);
      await fileOnly.createRun(issueRunCreationAdmission(), intentOldA);
      await fileOnly.createRun(issueRunCreationAdmission(), intentOldB);
      await fileOnly.createRun(issueRunCreationAdmission(), intentOldActive);
      await writeCurrentClaimRecord(
        fileOnly,
        buildTerminalRecord(intentOldA),
      );
      await writeCurrentClaimRecord(
        fileOnly,
        buildTerminalRecord(intentOldB, {
          state: "failed",
          summary: "Run B failed.",
        }),
      );
      // Leave intentOldActive in a non-terminal state so the
      // listActiveRuns assertion below has something to find.
      await writeCurrentClaimRecord(
        fileOnly,
        buildTerminalRecord(intentOldActive, {
          state: "running",
          summary: "Run pre-active still running.",
        }),
      );
    }

    // Sanity: SQLite is empty pre-projection.
    {
      const opened = await openStateStore();
      try {
        expect(countRunIndexEntries(opened.db)).toBe(0);
      } finally {
        opened.db.close();
      }
    }

    // 3. Stand up a projection-backed store and write exactly one
    //    new run BEFORE any list call. The blocker scenario: this
    //    leaves `run_index` non-empty with only the new row.
    const projection = new RunIndexProjection();
    const store = new RunStore(runsRoot, { runIndex: projection });

    const intentNew = buildIntent("run-post-mig-new");
    await store.createRun(issueRunCreationAdmission(), intentNew);
    await writeCurrentClaimRecord(store, buildTerminalRecord(intentNew));

    // Confirm the failure shape before the first list: SQLite has
    // exactly the new row, none of the pre-existing ones.
    {
      const opened = await openStateStore();
      try {
        const before = countRunIndexEntries(opened.db);
        expect(before).toBe(1);
      } finally {
        opened.db.close();
      }
    }

    // First listRuns must backfill the pre-existing records.
    const listed = await store.listRuns();
    const listedIds = listed.map((entry) => entry.run_id).sort();
    expect(listedIds).toEqual([
      "run-post-mig-new",
      "run-pre-A",
      "run-pre-active",
      "run-pre-B",
    ].sort());

    // First listActiveRuns (after the first listRuns already
    // triggered the backfill, but also independently exercised) must
    // include the pre-existing active record.
    const active = await store.listActiveRuns();
    const activeIds = active.map((entry) => entry.run_id).sort();
    expect(activeIds).toEqual(["run-pre-active"]);

    // SQLite row count must cover all expected runs after the
    // backfill (3 pre-existing + 1 new).
    {
      const opened = await openStateStore();
      try {
        expect(countRunIndexEntries(opened.db)).toBe(4);
      } finally {
        opened.db.close();
      }
    }

    // Wave 2.2 deletion proof: `runs/index.jsonl` is never written.
    await expect(stat(join(runsRoot, "index.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    projection.close();
  });

  test("first-list rebuild also covers the listActiveRuns entrypoint when called first", async () => {
    // Same transitional window as above, but `listActiveRuns()` is the
    // first surface called. Without the fix, an old active record would
    // be omitted because `run_index` already has the newly-projected
    // (terminal) row.
    const intentOldActive = buildIntent("run-pre-active-first");
    {
      const fileOnly = new RunStore(runsRoot);
      await fileOnly.createRun(issueRunCreationAdmission(), intentOldActive);
      await writeCurrentClaimRecord(
        fileOnly,
        buildTerminalRecord(intentOldActive, {
          state: "running",
          summary: "still running",
        }),
      );
    }

    const projection = new RunIndexProjection();
    const store = new RunStore(runsRoot, { runIndex: projection });

    const intentNew = buildIntent("run-post-mig-new-active");
    await store.createRun(issueRunCreationAdmission(), intentNew);
    await writeCurrentClaimRecord(store, buildTerminalRecord(intentNew));

    const active = await store.listActiveRuns();
    expect(active.map((entry) => entry.run_id).sort()).toEqual([
      "run-pre-active-first",
    ]);

    {
      const opened = await openStateStore();
      try {
        expect(countRunIndexEntries(opened.db)).toBe(2);
      } finally {
        opened.db.close();
      }
    }

    await expect(stat(join(runsRoot, "index.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    projection.close();
  });

  test("first-list backfill preserves concurrent new runs and newer same-run projections", async () => {
    // Deterministic interleaving for the scan -> publish race:
    //
    //   1. listRuns scans an old authoritative record;
    //   2. before the backfill transaction starts, another writer projects a
    //      brand-new run and a newer version of the scanned run;
    //   3. the stale scan is merged.
    //
    // A destructive replace loses the new run and regresses the existing run.
    // The atomic monotonic merge must preserve both concurrent writes.
    const oldIntent = buildIntent("run-backfill-race-existing");
    {
      const fileOnly = new RunStore(runsRoot);
      await fileOnly.createRun(issueRunCreationAdmission(), oldIntent);
      await writeCurrentClaimRecord(
        fileOnly,
        buildTerminalRecord(oldIntent, {
          state: "succeeded",
          summary: "stale scanned version",
          updated_at: "2026-05-10T01:00:00.000Z",
          completed_at: "2026-05-10T01:00:00.000Z",
        }),
      );
    }

    const projection = new RunIndexProjection();
    const store = new RunStore(runsRoot, { runIndex: projection });
    const originalMerge = projection.mergeInitialBackfill.bind(projection);
    const concurrentIntent = buildIntent("run-backfill-race-new", {
      created_at: "2026-05-10T02:00:00.000Z",
    });
    let injected = false;
    const mergeSpy = vi
      .spyOn(projection, "mergeInitialBackfill")
      .mockImplementation(async (rows, now) => {
        if (!injected) {
          injected = true;
          await store.createRun(issueRunCreationAdmission(), concurrentIntent);
          await writeCurrentClaimRecord(
            store,
            buildTerminalRecord(concurrentIntent, {
              summary: "concurrent new run",
              updated_at: "2026-05-10T03:00:00.000Z",
              completed_at: "2026-05-10T03:00:00.000Z",
            }),
          );
          await writeCurrentClaimRecord(
            store,
            buildTerminalRecord(oldIntent, {
              state: "failed",
              summary: "newer concurrent version with a rolled-back clock",
              updated_at: "2026-05-09T23:00:00.000Z",
              completed_at: "2026-05-09T23:00:00.000Z",
            }),
          );
        }
        return originalMerge(rows, now);
      });

    const listed = await store.listRuns();
    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(listed.map((entry) => entry.run_id).sort()).toEqual([
      concurrentIntent.run_id,
      oldIntent.run_id,
    ].sort());
    expect(listed.find((entry) => entry.run_id === concurrentIntent.run_id)).toMatchObject({
      state: "succeeded",
      summary: "concurrent new run",
      updated_at: "2026-05-10T03:00:00.000Z",
    });
    expect(listed.find((entry) => entry.run_id === oldIntent.run_id)).toMatchObject({
      state: "failed",
      summary: "newer concurrent version with a rolled-back clock",
      updated_at: "2026-05-09T23:00:00.000Z",
    });

    const opened = await openStateStore();
    try {
      expect(countRunIndexEntries(opened.db)).toBe(2);
      expect(readStateMeta(opened.db, RUN_INDEX_INITIAL_BACKFILL_KEY)?.value).toBeDefined();
    } finally {
      opened.db.close();
    }

    mergeSpy.mockRestore();
    projection.close();
  });

  test("concurrent writes for different runs cannot lose either row", async () => {
    const projection = new RunIndexProjection();
    const store = new RunStore(runsRoot, { runIndex: projection });

    const intents = Array.from({ length: 16 }, (_, i) =>
      buildIntent(`run-concurrent-${i.toString().padStart(3, "0")}`),
    );
    for (const intent of intents) {
      await store.createRun(issueRunCreationAdmission(), intent);
    }

    // Fire all writeRunRecord calls in parallel. SQLite's serialized
    // writers and the wave-2.2 upsert guarantee no row is lost.
    await Promise.all(
      intents.map((intent) =>
        writeCurrentClaimRecord(store, buildTerminalRecord(intent)),
      ),
    );

    const opened = await openStateStore();
    try {
      expect(countRunIndexEntries(opened.db)).toBe(intents.length);
    } finally {
      opened.db.close();
    }

    // Repeated upserts for the same run also do not duplicate.
    await Promise.all(
      intents.map((intent) =>
        writeCurrentClaimRecord(store, buildTerminalRecord(intent)),
      ),
    );
    {
      const opened = await openStateStore();
      try {
        expect(countRunIndexEntries(opened.db)).toBe(intents.length);
      } finally {
        opened.db.close();
      }
    }

    projection.close();
  });

  test("reconcile rebuilds SQLite run_index from authoritative records", async () => {
    const projection = new RunIndexProjection();
    const service = new RunService({ runsRoot, runIndex: projection });

    // Stand up two runs via direct store writes (no kernel involvement)
    // and seed SQLite with stale state.
    const intentA = buildIntent("run-svc-reconcile-A");
    const intentB = buildIntent("run-svc-reconcile-B");
    await service.store.createRun(issueRunCreationAdmission(), intentA);
    await service.store.createRun(issueRunCreationAdmission(), intentB);
    await writeCurrentClaimRecord(service.store, buildTerminalRecord(intentA, {
      launch: {
        ...buildTerminalRecord(intentA).launch,
        stage: "accepted",
      },
    }));
    await writeCurrentClaimRecord(
      service.store,
      buildTerminalRecord(intentB, {
        state: "failed",
        summary: "Run B failed.",
        launch: {
          ...buildTerminalRecord(intentB).launch,
          stage: "accepted",
        },
      }),
    );

    // Corrupt the SQLite run_index directly: drop one row, mark the other
    // stale.
    {
      const opened = await openStateStore();
      try {
        opened.db.prepare(`DELETE FROM run_index WHERE run_id = ?`).run(intentA.run_id);
        upsertRunIndexEntry(opened.db, {
          run_id: intentB.run_id,
          state: "running",
          summary: "stale-running",
          created_at: intentB.created_at,
          updated_at: intentB.created_at,
          recovery_mode: "normal",
          run_dir: join(runsRoot, intentB.run_id),
        });
        expect(countRunIndexEntries(opened.db)).toBe(1);
      } finally {
        opened.db.close();
      }
    }

    // reconcile() rebuilds run_index from run_record.json files.
    await service.reconcile();

    const runs = await service.store.listRuns();
    const a = runs.find((entry) => entry.run_id === intentA.run_id);
    const b = runs.find((entry) => entry.run_id === intentB.run_id);
    expect(a?.state).toBe("succeeded");
    expect(b?.state).toBe("failed");

    // index.jsonl was never created.
    await expect(stat(join(runsRoot, "index.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    projection.close();
  });

  test("RunStore without a projection still works (no SQLite, no index.jsonl)", async () => {
    // Wave 2.2 contract: omitting the SQLite projection falls back to
    // scanning authoritative run_record.json files. The legacy
    // `index.jsonl` upsert is gone — it is never written either way.
    const store = new RunStore(runsRoot);
    const intent = buildIntent("run-no-projection");
    await store.createRun(issueRunCreationAdmission(), intent);
    await writeCurrentClaimRecord(store, buildTerminalRecord(intent));

    const runs = await store.listRuns();
    expect(runs.map((entry) => entry.run_id)).toEqual(["run-no-projection"]);

    await expect(stat(join(runsRoot, "index.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("first-list backfill writes SQLite marker so subsequent stores skip the disk scan", async () => {
    // POL-1348 second-remediation regression. Wave 2.2 charter rule:
    // SQLite is the source of truth for normal reads after the
    // initial backfill. Local CLI commands build a fresh `RunStore`
    // per invocation, so the "first-list rebuild" must persist its
    // completion marker in `state_meta` rather than as in-memory
    // RunStore state — otherwise every `calyx run ps` would re-scan
    // run directories and `replace()` SQLite, clobbering rows
    // written by other concurrent processes.
    const intentOldA = buildIntent("run-marker-pre-A");
    {
      const fileOnly = new RunStore(runsRoot);
      await fileOnly.createRun(issueRunCreationAdmission(), intentOldA);
      await writeCurrentClaimRecord(fileOnly, buildTerminalRecord(intentOldA));
    }

    // Sanity: marker is absent before any list call.
    {
      const opened = await openStateStore();
      try {
        expect(readStateMeta(opened.db, RUN_INDEX_INITIAL_BACKFILL_KEY)).toBeUndefined();
      } finally {
        opened.db.close();
      }
    }

    // First store: triggers the first-list backfill and writes the
    // marker.
    {
      const projection = new RunIndexProjection();
      const store = new RunStore(runsRoot, { runIndex: projection });
      const listed = await store.listRuns();
      expect(listed.map((entry) => entry.run_id)).toEqual(["run-marker-pre-A"]);
      projection.close();
    }

    // Marker is now present in SQLite.
    {
      const opened = await openStateStore();
      try {
        const marker = readStateMeta(opened.db, RUN_INDEX_INITIAL_BACKFILL_KEY);
        expect(marker?.value).toBeDefined();
      } finally {
        opened.db.close();
      }
    }

    // Mutate disk *without* projecting/reconciling: write a brand-new
    // `run_record.json` for an additional run. With the wave-2.2
    // contract the second store must read SQLite, NOT this changed
    // disk state.
    const intentDiskOnly = buildIntent("run-marker-disk-only");
    {
      const fileOnly = new RunStore(runsRoot);
      await fileOnly.createRun(issueRunCreationAdmission(), intentDiskOnly);
      await writeCurrentClaimRecord(fileOnly, buildTerminalRecord(intentDiskOnly));
    }

    // Disk now has 2 records, but SQLite still has only the 1 from
    // the first store's backfill.
    {
      const opened = await openStateStore();
      try {
        expect(countRunIndexEntries(opened.db)).toBe(1);
      } finally {
        opened.db.close();
      }
    }

    // Second store against the same state DB: marker is present, so
    // listRuns must return SQLite state — the disk-only record is
    // intentionally invisible until reconcile.
    const projection2 = new RunIndexProjection();
    const store2 = new RunStore(runsRoot, { runIndex: projection2 });
    const listed2 = await store2.listRuns();
    expect(listed2.map((entry) => entry.run_id)).toEqual(["run-marker-pre-A"]);

    const active2 = await store2.listActiveRuns();
    expect(active2).toEqual([]);

    // SQLite row count must remain 1 — the second store did NOT
    // rebuild from disk.
    {
      const opened = await openStateStore();
      try {
        expect(countRunIndexEntries(opened.db)).toBe(1);
      } finally {
        opened.db.close();
      }
    }

    projection2.close();
  });

  test("rebuildRunIndex repairs stale rows even after the marker is set", async () => {
    // The marker only gates the implicit first-list backfill. The
    // explicit reconcile path (`RunService.reconcile()` ->
    // `RunStore.rebuildRunIndex()`) must still rebuild from
    // authoritative records regardless of marker, so operators can
    // recover from divergence at any time.
    const intent = buildIntent("run-reconcile-after-marker");
    {
      const fileOnly = new RunStore(runsRoot);
      await fileOnly.createRun(issueRunCreationAdmission(), intent);
      await writeCurrentClaimRecord(fileOnly, buildTerminalRecord(intent));
    }

    // First store: triggers backfill, writes the marker, then
    // releases SQLite.
    {
      const projection = new RunIndexProjection();
      const store = new RunStore(runsRoot, { runIndex: projection });
      await store.listRuns();
      projection.close();
    }

    // Inject divergence: stale `running` row in SQLite that no
    // longer matches the authoritative `run_record.json` file.
    {
      const opened = await openStateStore();
      try {
        upsertRunIndexEntry(opened.db, {
          run_id: intent.run_id,
          state: "running",
          summary: "stale-after-marker",
          created_at: intent.created_at,
          updated_at: intent.created_at,
          recovery_mode: "normal",
          run_dir: join(runsRoot, intent.run_id),
        });
      } finally {
        opened.db.close();
      }
    }

    // Second store sees the stale row from SQLite (marker is set, so
    // no implicit rebuild).
    {
      const projection = new RunIndexProjection();
      const store = new RunStore(runsRoot, { runIndex: projection });
      const before = await store.listRuns();
      expect(before.find((entry) => entry.run_id === intent.run_id)?.state).toBe(
        "running",
      );

      // Explicit rebuildRunIndex repairs the divergence even though
      // the marker is already present.
      await store.rebuildRunIndex();
      const after = await store.listRuns();
      expect(after.find((entry) => entry.run_id === intent.run_id)?.state).toBe(
        "succeeded",
      );

      projection.close();
    }
  });
});
