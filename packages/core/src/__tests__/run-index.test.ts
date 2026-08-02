import { copyFile, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  applyStateMigrations,
  checkRunIndexSchema,
  countRunIndexEntries,
  deleteRunIndexEntry,
  listActiveRunIndexEntries,
  listRunIndexEntries,
  listRunIndexPage,
  listRunIndexSnapshotPage,
  openStateStore,
  readRunIndexEntry,
  readRunIndexMembershipHead,
  readRunIndexMembershipRevision,
  readStateMeta,
  replaceRunIndex,
  reportStateHealth,
  RUN_INDEX_MEMBERSHIP_DELTA_RETENTION,
  RUN_INDEX_INITIAL_BACKFILL_KEY,
  RUN_INDEX_PROJECTION_DEGRADED_KEY,
  RUN_INDEX_TABLES,
  RunIndexMembershipFingerprintMismatchError,
  RunIndexProjection,
  runStateDoctor,
  STATE_MIGRATIONS,
  upsertRunIndexEntry,
  type RunIndexRow,
} from "../state";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;

async function makeStateHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "calyx-run-index-"));
  return join(root, "state");
}

function makeRow(runId: string, overrides: Partial<RunIndexRow> = {}): RunIndexRow {
  return {
    run_id: runId,
    state: "succeeded",
    summary: `Run ${runId} succeeded.`,
    created_at: "2026-05-10T00:00:00.000Z",
    updated_at: "2026-05-10T00:01:00.000Z",
    completed_at: "2026-05-10T00:01:00.000Z",
    recovery_mode: "normal",
    run_dir: `/tmp/runs/${runId}`,
    ...overrides,
  };
}

describe("run_index schema (migration 0003)", () => {
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

  test("STATE_MIGRATIONS includes 0003 in lexical/numeric order after 0002", () => {
    const ids = STATE_MIGRATIONS.map((m) => m.id);
    expect(ids).toContain("0003");
    expect(ids.indexOf("0003")).toBeGreaterThan(ids.indexOf("0002"));
  });

  test("RUN_INDEX_TABLES enumerates the run index and bounded membership journal", () => {
    const names = RUN_INDEX_TABLES.map((t) => t.table);
    expect(names).toEqual([
      "run_index",
      "run_index_membership_revision",
      "run_index_membership_deltas",
    ]);
    const cols = RUN_INDEX_TABLES[0]!.columns;
    expect(cols).toContain("run_id");
    expect(cols).toContain("state");
    expect(cols).toContain("recovery_mode");
    expect(cols).toContain("run_dir");
    expect(RUN_INDEX_TABLES[1]!.columns).toEqual([
      "singleton", "generation", "revision", "lineage_parent_token",
      "lineage_token", "compacted_through_revision",
    ]);
    expect(RUN_INDEX_TABLES[2]!.columns).toContain("lineage_parent_token");
    expect(RUN_INDEX_TABLES[2]!.columns).toContain("lineage_token");
    expect(RUN_INDEX_TABLES[2]!.columns).toContain("old_run_id");
    expect(RUN_INDEX_TABLES[2]!.columns).toContain("new_updated_at");
  });

  test("applyStateMigrations creates the run_index table and indexes", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      const parity = checkRunIndexSchema(opened.db);
      expect(parity.status).toBe("ok");
      expect(parity.findings).toEqual([]);
    } finally {
      opened.db.close();
    }
  });

  test("migration 0030 creates the singleton membership revision and its triggers", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      expect(readRunIndexMembershipRevision(opened.db)).toBe(0);
      expect(readRunIndexMembershipHead(opened.db)).toMatchObject({
        generation: expect.stringMatching(/^[0-9a-f]{32}$/u),
        revision: 0,
        lineageParentToken: expect.stringMatching(/^[0-9a-f]{32}$/u),
        lineageToken: expect.stringMatching(/^[0-9a-f]{32}$/u),
        compactedThroughRevision: 0,
      });
      const triggers = opened.db.prepare(
        `SELECT name
           FROM sqlite_master
          WHERE type = 'trigger' AND tbl_name = 'run_index'
          ORDER BY name`,
      ).all() as Array<{ name: string }>;
      expect(triggers.map((row) => row.name)).toEqual([
        "run_index_membership_revision_delete",
        "run_index_membership_revision_insert",
        "run_index_membership_revision_update",
      ]);
    } finally {
      opened.db.close();
    }
  });

  test("doctor reports run-index schema parity green when applied", async () => {
    await applyStateMigrations();
    const report = await runStateDoctor();
    expect(report.runIndex.migrationApplied).toBe(true);
    expect(report.runIndex.schemaParity).toBe("ok");
    expect(report.runIndex.schemaFindings).toEqual([]);
    expect(report.findings.some((f) => f.code === "run-index-schema")).toBe(false);
    expect(report.ok).toBe(true);
  });

  test("doctor reports run-index schema drift when the table is dropped", async () => {
    await applyStateMigrations();
    {
      const opened = await openStateStore();
      try {
        opened.db.exec("DROP TABLE run_index");
      } finally {
        opened.db.close();
      }
    }
    const report = await runStateDoctor();
    expect(report.runIndex.schemaParity).toBe("drift");
    expect(report.findings.some((f) => f.code === "run-index-schema")).toBe(true);
    expect(report.ok).toBe(false);
  });

  test.each([
    ["missing", "missing-trigger"],
    ["altered", "trigger-sql-mismatch"],
  ] as const)("doctor reports run-index schema drift when a membership trigger is %s", async (
    mode,
    expectedCode,
  ) => {
    await applyStateMigrations();
    {
      const opened = await openStateStore();
      try {
        opened.db.exec("DROP TRIGGER run_index_membership_revision_insert");
        if (mode === "altered") {
          opened.db.exec(`
            CREATE TRIGGER run_index_membership_revision_insert
            AFTER INSERT ON run_index
            BEGIN
              UPDATE run_index_membership_revision
                 SET revision = revision + 2
               WHERE singleton = 1;
            END;
          `);
        }
        expect(checkRunIndexSchema(opened.db).findings).toEqual(expect.arrayContaining([
          expect.objectContaining({
            table: "run_index",
            code: expectedCode,
          }),
        ]));
      } finally {
        opened.db.close();
      }
    }
    const report = await runStateDoctor();
    expect(report.runIndex.schemaParity).toBe("drift");
    expect(report.findings.some((finding) => finding.code === "run-index-schema")).toBe(true);
    expect(report.ok).toBe(false);
  });

  test("reportStateHealth surfaces run_index status block (pre-apply)", async () => {
    // Pre-apply: the doctor open path implicitly creates the DB and
    // applies 0001 baseline only when called via runStateDoctor — for
    // pure health check, we expect runIndex.migrationApplied=false until
    // the run-index migration runs.
    const opened = await openStateStore();
    opened.db.close();
    const health = await reportStateHealth();
    // pending migrations 0001, 0002, 0003 are all pending until apply.
    expect(health.runIndex.migrationApplied).toBe(false);
    expect(health.runIndex.schemaParity).toBe("absent");
    expect(health.runIndex.rowCount).toBe(0);
  });
});

describe("run_index helpers", () => {
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

  test("upsertRunIndexEntry is idempotent on run_id", async () => {
    const opened = await openStateStore();
    try {
      upsertRunIndexEntry(opened.db, makeRow("run-a", { state: "running" }));
      upsertRunIndexEntry(opened.db, makeRow("run-a", { state: "succeeded" }));
      expect(countRunIndexEntries(opened.db)).toBe(1);
      const row = readRunIndexEntry(opened.db, "run-a");
      expect(row?.state).toBe("succeeded");
    } finally {
      opened.db.close();
    }
  });

  test("listActiveRunIndexEntries filters by state NOT IN terminal", async () => {
    const opened = await openStateStore();
    try {
      upsertRunIndexEntry(opened.db, makeRow("run-running", { state: "running" }));
      upsertRunIndexEntry(opened.db, makeRow("run-queued", { state: "queued" }));
      upsertRunIndexEntry(opened.db, makeRow("run-success", { state: "succeeded" }));
      upsertRunIndexEntry(opened.db, makeRow("run-failed", { state: "failed" }));
      const active = listActiveRunIndexEntries(opened.db, [
        "succeeded",
        "failed",
        "partial",
        "cancelled",
        "auth_error",
        "infra_error",
        "completed_dirty",
      ]);
      const ids = active.map((row) => row.run_id).sort();
      expect(ids).toEqual(["run-queued", "run-running"]);
    } finally {
      opened.db.close();
    }
  });

  test("listRunIndexEntries returns rows ordered by run_id", async () => {
    const opened = await openStateStore();
    try {
      upsertRunIndexEntry(opened.db, makeRow("run-c"));
      upsertRunIndexEntry(opened.db, makeRow("run-a"));
      upsertRunIndexEntry(opened.db, makeRow("run-b"));
      const rows = listRunIndexEntries(opened.db);
      expect(rows.map((row) => row.run_id)).toEqual(["run-a", "run-b", "run-c"]);
    } finally {
      opened.db.close();
    }
  });

  test("listRunIndexPage applies the immutable creation-time snapshot fence", async () => {
    const opened = await openStateStore();
    try {
      upsertRunIndexEntry(opened.db, makeRow("run-before", {
        created_at: "2026-05-10T00:00:00.000Z",
      }));
      upsertRunIndexEntry(opened.db, makeRow("run-after", {
        created_at: "2026-05-10T00:02:00.000Z",
      }));
      const rows = listRunIndexPage(opened.db, {
        created_before: "2026-05-10T00:01:00.000Z",
        limit: 10,
      });
      expect(rows.map((row) => row.run_id)).toEqual(["run-before"]);
    } finally {
      opened.db.close();
    }
  });

  test("membership journal records exact OLD/NEW identity and progress mutations", async () => {
    const opened = await openStateStore();
    try {
      expect(readRunIndexMembershipRevision(opened.db)).toBe(0);

      upsertRunIndexEntry(opened.db, makeRow("run-revision", {
        created_at: "2026-05-09T00:00:00.000Z",
        host: "blade",
        backend: "codex",
      }));
      expect(readRunIndexMembershipRevision(opened.db)).toBe(1);

      upsertRunIndexEntry(opened.db, makeRow("run-revision", {
        state: "running",
        summary: "Progress changed without changing page membership.",
        created_at: "2026-05-09T00:00:00.000Z",
        host: "blade",
        backend: "codex",
      }));
      expect(readRunIndexMembershipRevision(opened.db)).toBe(1);

      opened.db.prepare("UPDATE run_index SET updated_at = ? WHERE run_id = ?")
        .run("2026-05-10T00:02:00.000Z", "run-revision");
      expect(readRunIndexMembershipRevision(opened.db)).toBe(2);
      opened.db.prepare("UPDATE run_index SET host = ? WHERE run_id = ?")
        .run("carbon", "run-revision");
      expect(readRunIndexMembershipRevision(opened.db)).toBe(3);
      opened.db.prepare("UPDATE run_index SET backend = ? WHERE run_id = ?")
        .run("claude", "run-revision");
      expect(readRunIndexMembershipRevision(opened.db)).toBe(4);
      opened.db.prepare("UPDATE run_index SET created_at = ? WHERE run_id = ?")
        .run("2026-05-08T00:00:00.000Z", "run-revision");
      expect(readRunIndexMembershipRevision(opened.db)).toBe(5);

      expect(deleteRunIndexEntry(opened.db, "run-revision").deleted).toBe(true);
      expect(readRunIndexMembershipRevision(opened.db)).toBe(6);
      expect(deleteRunIndexEntry(opened.db, "run-revision").deleted).toBe(false);
      expect(readRunIndexMembershipRevision(opened.db)).toBe(6);
      const deltas = opened.db.prepare(
        `SELECT revision, operation, old_run_id, new_run_id, old_host, new_host
           FROM run_index_membership_deltas ORDER BY revision`,
      ).all() as Array<Record<string, unknown>>;
      expect(deltas).toHaveLength(6);
      expect(deltas[0]).toMatchObject({
        revision: 1,
        operation: "insert",
        old_run_id: null,
        new_run_id: "run-revision",
      });
      expect(deltas[2]).toMatchObject({
        revision: 3,
        operation: "update",
        old_host: "blade",
        new_host: "carbon",
      });
      expect(deltas[5]).toMatchObject({
        revision: 6,
        operation: "delete",
        old_run_id: "run-revision",
        new_run_id: null,
      });
    } finally {
      opened.db.close();
    }
  });

  test("membership-fingerprinted pagination rejects an in-window admission", async () => {
    const opened = await openStateStore();
    try {
      upsertRunIndexEntry(opened.db, makeRow("run-newest", {
        created_at: "2026-05-10T02:00:00.000Z",
      }));
      upsertRunIndexEntry(opened.db, makeRow("run-oldest", {
        created_at: "2026-05-10T00:00:00.000Z",
      }));
      const pageOptions = {
        created_before: "2026-05-10T03:00:00.000Z",
        limit: 1,
      } as const;
      const first = listRunIndexSnapshotPage(opened.db, pageOptions);
      expect(first).toMatchObject({
        rows: [{ run_id: "run-newest" }],
      });
      expect(first.membershipFingerprint).toMatch(
        /^[0-9a-f]{32}:[0-9]+:[0-9a-f]{32}:[0-9a-f]{64}$/u,
      );

      upsertRunIndexEntry(opened.db, makeRow("run-backdated", {
        created_at: "2026-05-10T01:00:00.000Z",
      }));
      expect(() => listRunIndexSnapshotPage(opened.db, {
        ...pageOptions,
        after: {
          created_at: first.rows[0]!.created_at,
          run_id: first.rows[0]!.run_id,
        },
        expected_membership_fingerprint: first.membershipFingerprint,
      })).toThrowError(RunIndexMembershipFingerprintMismatchError);
      try {
        listRunIndexSnapshotPage(opened.db, {
          ...pageOptions,
          after: {
            created_at: first.rows[0]!.created_at,
            run_id: first.rows[0]!.run_id,
          },
          expected_membership_fingerprint: first.membershipFingerprint,
        });
      } catch (error) {
        expect(error).toMatchObject({
          code: "run_index_membership_fingerprint_mismatch",
          expectedFingerprint: first.membershipFingerprint,
          actualFingerprint: expect.stringMatching(
            /^[0-9a-f]{32}:[0-9]+:[0-9a-f]{32}:[0-9a-f]{64}$/u,
          ),
        });
      }
    } finally {
      opened.db.close();
    }
  });

  test("updated_at-only progress without an updated_since filter does not stale page two", async () => {
    const opened = await openStateStore();
    try {
      upsertRunIndexEntry(opened.db, makeRow("run-newest", {
        created_at: "2026-05-10T02:00:00.000Z",
        updated_at: "2026-05-10T02:00:00.000Z",
      }));
      upsertRunIndexEntry(opened.db, makeRow("run-oldest", {
        created_at: "2026-05-10T01:00:00.000Z",
        updated_at: "2026-05-10T01:00:00.000Z",
      }));
      const first = listRunIndexSnapshotPage(opened.db, { limit: 1 });
      expect(first.rows.map((row) => row.run_id)).toEqual(["run-newest"]);

      opened.db.prepare("UPDATE run_index SET updated_at = ? WHERE run_id = ?")
        .run("2026-05-10T03:00:00.000Z", "run-newest");
      const second = listRunIndexSnapshotPage(opened.db, {
        after: {
          created_at: first.rows[0]!.created_at,
          run_id: first.rows[0]!.run_id,
        },
        expected_membership_fingerprint: first.membershipFingerprint,
        limit: 1,
      });
      expect(second.rows).toMatchObject([{ run_id: "run-oldest" }]);
      expect(second.membershipFingerprint).not.toBe(first.membershipFingerprint);
    } finally {
      opened.db.close();
    }
  });

  test("updated_at progress on the same side of updated_since preserves membership", async () => {
    const opened = await openStateStore();
    try {
      upsertRunIndexEntry(opened.db, makeRow("run-newest", {
        created_at: "2026-05-10T02:00:00.000Z",
        updated_at: "2026-05-10T02:00:00.000Z",
      }));
      upsertRunIndexEntry(opened.db, makeRow("run-oldest", {
        created_at: "2026-05-10T01:00:00.000Z",
        updated_at: "2026-05-10T01:00:00.000Z",
      }));
      const options = { updated_since: "2026-05-10T00:00:00.000Z", limit: 1 } as const;
      const first = listRunIndexSnapshotPage(opened.db, options);

      opened.db.prepare("UPDATE run_index SET updated_at = ? WHERE run_id = ?")
        .run("2026-05-10T03:00:00.000Z", "run-newest");

      const second = listRunIndexSnapshotPage(opened.db, {
        ...options,
        after: {
          created_at: first.rows[0]!.created_at,
          run_id: first.rows[0]!.run_id,
        },
        expected_membership_fingerprint: first.membershipFingerprint,
      });
      expect(second.membershipFingerprint).not.toBe(first.membershipFingerprint);
      expect(second.rows.map((row) => row.run_id)).toEqual(["run-oldest"]);
    } finally {
      opened.db.close();
    }
  });

  test("crossing updated_since eligibility invalidates the membership fingerprint", async () => {
    const opened = await openStateStore();
    try {
      upsertRunIndexEntry(opened.db, makeRow("run-already-eligible", {
        created_at: "2026-05-10T02:00:00.000Z",
        updated_at: "2026-05-10T02:00:00.000Z",
      }));
      upsertRunIndexEntry(opened.db, makeRow("run-becomes-eligible", {
        created_at: "2026-05-10T01:00:00.000Z",
        updated_at: "2026-05-09T00:00:00.000Z",
      }));
      const options = { updated_since: "2026-05-10T00:00:00.000Z", limit: 1 } as const;
      const first = listRunIndexSnapshotPage(opened.db, options);

      opened.db.prepare("UPDATE run_index SET updated_at = ? WHERE run_id = ?")
        .run("2026-05-10T01:00:00.000Z", "run-becomes-eligible");

      expect(() => listRunIndexSnapshotPage(opened.db, {
        ...options,
        after: {
          created_at: first.rows[0]!.created_at,
          run_id: first.rows[0]!.run_id,
        },
        expected_membership_fingerprint: first.membershipFingerprint,
      })).toThrowError(RunIndexMembershipFingerprintMismatchError);
    } finally {
      opened.db.close();
    }
  });

  test("filter replay and missing journal coverage fail stale", async () => {
    const opened = await openStateStore();
    try {
      upsertRunIndexEntry(opened.db, makeRow("run-filter-bound", {
        host: "blade",
        created_at: "2026-05-10T02:00:00.000Z",
      }));
      const first = listRunIndexSnapshotPage(opened.db, { limit: 1 });
      expect(() => listRunIndexSnapshotPage(opened.db, {
        host: "blade",
        limit: 1,
        expected_membership_fingerprint: first.membershipFingerprint,
      })).toThrowError(RunIndexMembershipFingerprintMismatchError);

      opened.db.prepare("UPDATE run_index SET updated_at = ? WHERE run_id = ?")
        .run("2026-05-10T03:00:00.000Z", "run-filter-bound");
      const head = readRunIndexMembershipHead(opened.db);
      opened.db.prepare("DELETE FROM run_index_membership_deltas WHERE revision = ?")
        .run(head.revision);
      expect(() => listRunIndexSnapshotPage(opened.db, {
        limit: 1,
        expected_membership_fingerprint: first.membershipFingerprint,
      })).toThrowError(RunIndexMembershipFingerprintMismatchError);
    } finally {
      opened.db.close();
    }
  });

  test("seek pages are forced onto the canonical creation index without a temp sort", async () => {
    const opened = await openStateStore();
    try {
      const plans = opened.db.prepare(
        `EXPLAIN QUERY PLAN
         SELECT run_id
           FROM run_index INDEXED BY idx_run_index_created_seek
          WHERE created_at <= ?
            AND (created_at < ? OR (created_at = ? AND run_id COLLATE BINARY > ?))
          ORDER BY created_at DESC, run_id COLLATE BINARY ASC
          LIMIT ?`,
      ).all(
        "2026-05-11T00:00:00.000Z",
        "2026-05-10T02:00:00.000Z",
        "2026-05-10T02:00:00.000Z",
        "run-probe",
        10,
      ) as Array<{ detail: string }>;
      const detail = plans.map((plan) => plan.detail).join("\n");
      expect(detail).toContain("idx_run_index_created_seek");
      expect(detail).not.toContain("USE TEMP B-TREE");
    } finally {
      opened.db.close();
    }
  });

  test("an admission after the frozen created_before snapshot does not stale the traversal", async () => {
    const opened = await openStateStore();
    try {
      upsertRunIndexEntry(opened.db, makeRow("run-newest", {
        created_at: "2026-05-10T02:00:00.000Z",
      }));
      upsertRunIndexEntry(opened.db, makeRow("run-oldest", {
        created_at: "2026-05-10T01:00:00.000Z",
      }));
      const options = { created_before: "2026-05-10T02:30:00.000Z", limit: 1 } as const;
      const first = listRunIndexSnapshotPage(opened.db, options);

      upsertRunIndexEntry(opened.db, makeRow("run-after-snapshot", {
        created_at: "2026-05-10T03:00:00.000Z",
      }));

      const second = listRunIndexSnapshotPage(opened.db, {
        ...options,
        after: {
          created_at: first.rows[0]!.created_at,
          run_id: first.rows[0]!.run_id,
        },
        expected_membership_fingerprint: first.membershipFingerprint,
      });
      expect(second.membershipFingerprint).not.toBe(first.membershipFingerprint);
      expect(second.rows.map((row) => row.run_id)).toEqual(["run-oldest"]);
    } finally {
      opened.db.close();
    }
  });

  test("static traversal checkpoint excludes seek position and limit but binds filters", async () => {
    const opened = await openStateStore();
    try {
      replaceRunIndex(opened.db, Array.from({ length: 513 }, (_, index) => (
        makeRow(`run-bounded-${String(index).padStart(4, "0")}`, {
          created_at: "2026-05-10T01:00:00.000Z",
        })
      )));
      const first = listRunIndexSnapshotPage(opened.db, { limit: 1 });
      const continued = listRunIndexSnapshotPage(opened.db, {
        after: {
          created_at: first.rows[0]!.created_at,
          run_id: first.rows[0]!.run_id,
        },
        limit: 37,
      });
      expect(continued.membershipFingerprint).toBe(first.membershipFingerprint);
      expect(continued.rows).toHaveLength(37);

      const filterBound = listRunIndexSnapshotPage(opened.db, {
        created_before: "2026-05-11T00:00:00.000Z",
        limit: 1,
      });
      expect(filterBound.rows).toEqual(first.rows);
      expect(filterBound.membershipFingerprint).not.toBe(first.membershipFingerprint);
    } finally {
      opened.db.close();
    }
  });

  test("net-restored identity mutations preserve membership while advancing the checkpoint", async () => {
    const opened = await openStateStore();
    try {
      const original = makeRow("run-identity", {
        created_at: "2026-05-10T01:00:00.000Z",
        host: "blade",
        backend: "codex",
      });
      upsertRunIndexEntry(opened.db, original);
      let checkpoint = listRunIndexSnapshotPage(opened.db, { limit: 10 }).membershipFingerprint;

      for (const [mutation, restore] of [
        [
          ["UPDATE run_index SET host = ? WHERE run_id = ?", "carbon", "run-identity"],
          ["UPDATE run_index SET host = ? WHERE run_id = ?", "blade", "run-identity"],
        ],
        [
          ["UPDATE run_index SET backend = ? WHERE run_id = ?", "claude", "run-identity"],
          ["UPDATE run_index SET backend = ? WHERE run_id = ?", "codex", "run-identity"],
        ],
        [
          ["UPDATE run_index SET created_at = ? WHERE run_id = ?", "2026-05-09T00:00:00.000Z", "run-identity"],
          ["UPDATE run_index SET created_at = ? WHERE run_id = ?", original.created_at, "run-identity"],
        ],
        [
          ["UPDATE run_index SET run_id = ? WHERE run_id = ?", "run-identity-renamed", "run-identity"],
          ["UPDATE run_index SET run_id = ? WHERE run_id = ?", "run-identity", "run-identity-renamed"],
        ],
      ] as const) {
        opened.db.prepare(mutation[0]).run(...mutation.slice(1));
        opened.db.prepare(restore[0]).run(...restore.slice(1));
        const restored = listRunIndexSnapshotPage(opened.db, {
          limit: 10,
          expected_membership_fingerprint: checkpoint,
        });
        expect(restored.membershipFingerprint).not.toBe(checkpoint);
        checkpoint = restored.membershipFingerprint;
      }

      expect(deleteRunIndexEntry(opened.db, original.run_id).deleted).toBe(true);
      upsertRunIndexEntry(opened.db, original);
      const restored = listRunIndexSnapshotPage(opened.db, {
        limit: 10,
        expected_membership_fingerprint: checkpoint,
      });
      expect(restored.rows.map((row) => row.run_id)).toEqual([original.run_id]);

      const filterBound = listRunIndexSnapshotPage(opened.db, {
        host: "blade",
        limit: 10,
      });
      expect(filterBound.membershipFingerprint).not.toBe(restored.membershipFingerprint);
    } finally {
      opened.db.close();
    }
  });

  test("lineage rejects a restored generation after alternate history reaches the cursor revision", async () => {
    let opened = await openStateStore();
    const backupPath = join(stateHome, "..", "run-index-rollback.db");
    try {
      upsertRunIndexEntry(opened.db, makeRow("run-lineage-a", {
        created_at: "2026-05-10T03:00:00.000Z",
      }));
      opened.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const dbPath = opened.paths.dbPath;
      opened.db.close();
      await copyFile(dbPath, backupPath);

      opened = await openStateStore();
      upsertRunIndexEntry(opened.db, makeRow("run-lineage-b", {
        created_at: "2026-05-10T02:00:00.000Z",
      }));
      const original = listRunIndexSnapshotPage(opened.db, { limit: 1 });
      opened.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      opened.db.close();

      await copyFile(backupPath, dbPath);
      await unlink(`${dbPath}-wal`).catch(() => undefined);
      await unlink(`${dbPath}-shm`).catch(() => undefined);

      opened = await openStateStore();
      upsertRunIndexEntry(opened.db, makeRow("run-lineage-c", {
        created_at: "2026-05-10T01:00:00.000Z",
      }));
      expect(() => listRunIndexSnapshotPage(opened.db, {
        after: {
          created_at: original.rows[0]!.created_at,
          run_id: original.rows[0]!.run_id,
        },
        expected_membership_fingerprint: original.membershipFingerprint,
        limit: 10,
      })).toThrowError(RunIndexMembershipFingerprintMismatchError);
    } finally {
      opened.db.close();
    }
  });

  test("the compaction boundary retains an anchored lineage chain and rejects older cursors", async () => {
    const opened = await openStateStore();
    try {
      upsertRunIndexEntry(opened.db, makeRow("run-compaction-lineage", {
        host: "blade",
      }));
      const compactedCursor = listRunIndexSnapshotPage(opened.db, { limit: 10 });

      opened.db.prepare("UPDATE run_index SET host = ? WHERE run_id = ?")
        .run("carbon", "run-compaction-lineage");
      const boundaryCursor = listRunIndexSnapshotPage(opened.db, { limit: 10 });

      const update = opened.db.prepare("UPDATE run_index SET host = ? WHERE run_id = ?");
      opened.db.exec("BEGIN IMMEDIATE");
      try {
        for (let index = 0; index < RUN_INDEX_MEMBERSHIP_DELTA_RETENTION; index += 1) {
          update.run(index % 2 === 0 ? "blade" : "carbon", "run-compaction-lineage");
        }
        opened.db.exec("COMMIT");
      } catch (error) {
        opened.db.exec("ROLLBACK");
        throw error;
      }

      expect(readRunIndexMembershipHead(opened.db)).toMatchObject({
        revision: RUN_INDEX_MEMBERSHIP_DELTA_RETENTION + 2,
        compactedThroughRevision: 2,
      });
      const continued = listRunIndexSnapshotPage(opened.db, {
        expected_membership_fingerprint: boundaryCursor.membershipFingerprint,
        limit: 10,
      });
      expect(continued.rows).toMatchObject([{
        run_id: "run-compaction-lineage",
        host: "carbon",
      }]);
      expect(() => listRunIndexSnapshotPage(opened.db, {
        expected_membership_fingerprint: compactedCursor.membershipFingerprint,
        limit: 10,
      })).toThrowError(RunIndexMembershipFingerprintMismatchError);

      const firstRetained = opened.db.prepare(
        `SELECT lineage_parent_token, lineage_token
           FROM run_index_membership_deltas
          WHERE revision = 3`,
      ).get() as { lineage_parent_token: string; lineage_token: string };
      const brokenParent = ["0".repeat(32), "f".repeat(32)].find((candidate) => (
        candidate !== firstRetained.lineage_parent_token
        && candidate !== firstRetained.lineage_token
      ))!;
      opened.db.prepare(
        "UPDATE run_index_membership_deltas SET lineage_parent_token = ? WHERE revision = 3",
      ).run(brokenParent);
      expect(() => listRunIndexSnapshotPage(opened.db, {
        expected_membership_fingerprint: boundaryCursor.membershipFingerprint,
        limit: 10,
      })).toThrowError(RunIndexMembershipFingerprintMismatchError);
    } finally {
      opened.db.close();
    }
  });

  test("deleteRunIndexEntry removes by run_id", async () => {
    const opened = await openStateStore();
    try {
      upsertRunIndexEntry(opened.db, makeRow("run-del"));
      expect(countRunIndexEntries(opened.db)).toBe(1);
      const result = deleteRunIndexEntry(opened.db, "run-del");
      expect(result.deleted).toBe(true);
      expect(countRunIndexEntries(opened.db)).toBe(0);
      const again = deleteRunIndexEntry(opened.db, "run-missing");
      expect(again.deleted).toBe(false);
    } finally {
      opened.db.close();
    }
  });

  test("replaceRunIndex atomically swaps the table contents", async () => {
    const opened = await openStateStore();
    try {
      upsertRunIndexEntry(opened.db, makeRow("run-old"));
      replaceRunIndex(opened.db, [makeRow("run-new-1"), makeRow("run-new-2")]);
      const ids = listRunIndexEntries(opened.db).map((row) => row.run_id).sort();
      expect(ids).toEqual(["run-new-1", "run-new-2"]);
    } finally {
      opened.db.close();
    }
  });

  test("RunIndexProjection upsert + list end-to-end", async () => {
    const projection = new RunIndexProjection();
    try {
      const up = await projection.upsert(makeRow("run-proj-1", { state: "running" }));
      expect(up.status).toBe("upserted");
      const listed = await projection.list();
      expect(listed.status).toBe("listed");
      if (listed.status === "listed") {
        expect(listed.rows.map((r) => r.run_id)).toEqual(["run-proj-1"]);
      }
      const active = await projection.listActive(["succeeded", "failed"]);
      expect(active.status).toBe("listed");
      if (active.status === "listed") {
        expect(active.rows.map((r) => r.run_id)).toEqual(["run-proj-1"]);
      }
    } finally {
      projection.close();
    }
  });

  test("RunIndexProjection initial-backfill marker round-trip", async () => {
    // Marker lives in `state_meta` so it survives across processes and
    // gates the wave-2.2 first-list backfill of `run_index` from
    // authoritative `run_record.json` files.
    const projection = new RunIndexProjection();
    try {
      const before = await projection.readInitialBackfillMarker();
      expect(before.status).toBe("absent");

      const written = await projection.writeInitialBackfillMarker();
      expect(written.status).toBe("written");
      if (written.status === "written") {
        expect(typeof written.completedAt).toBe("string");
        expect(written.completedAt.length).toBeGreaterThan(0);
      }

      const after = await projection.readInitialBackfillMarker();
      expect(after.status).toBe("present");
      if (after.status === "present" && written.status === "written") {
        expect(after.completedAt).toBe(written.completedAt);
      }

      // Direct state_meta read confirms it landed under the canonical key.
      const opened = await openStateStore();
      try {
        const entry = readStateMeta(opened.db, RUN_INDEX_INITIAL_BACKFILL_KEY);
        expect(entry?.value).toBe(after.status === "present" ? after.completedAt : "");
      } finally {
        opened.db.close();
      }
    } finally {
      projection.close();
    }
  });

  test("RunIndexProjection degraded marker survives projection instances until cleared", async () => {
    const first = new RunIndexProjection();
    const second = new RunIndexProjection();
    try {
      await expect(first.readProjectionDegradedMarker()).resolves.toEqual({ status: "absent" });
      const written = await first.writeProjectionDegradedMarker("run-durable-degraded");
      expect(written).toMatchObject({ status: "written" });
      await expect(second.readProjectionDegradedMarker()).resolves.toMatchObject({
        status: "present",
        value: expect.stringContaining("run-durable-degraded"),
      });

      const opened = await openStateStore();
      try {
        expect(readStateMeta(opened.db, RUN_INDEX_PROJECTION_DEGRADED_KEY)?.value)
          .toContain("run-durable-degraded");
      } finally {
        opened.db.close();
      }

      await expect(second.clearProjectionDegradedMarker()).resolves.toEqual({
        status: "cleared",
        existed: true,
      });
      await expect(first.readProjectionDegradedMarker()).resolves.toEqual({ status: "absent" });
    } finally {
      first.close();
      second.close();
    }
  });
});

describe("RunIndexProjection disabled paths", () => {
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

  test("projection disables itself when the state DB does not exist", async () => {
    const projection = new RunIndexProjection();
    const outcome = await projection.upsert(makeRow("run-disabled"));
    expect(outcome.status).toBe("disabled");
    expect(projection.isDisabled).toBe(true);
    expect(projection.disabledMessage).toContain("state DB does not exist");
    projection.close();
  });

  test("projection disables itself when migration 0003 is absent", async () => {
    // Apply only 0001/0002 by injecting a subset.
    const subset = STATE_MIGRATIONS.filter((m) => m.id === "0001" || m.id === "0002");
    const opened = await openStateStore();
    try {
      // Use applyMigrations via the public surface — easier path is to
      // open then run them directly. We open the DB so the file exists.
    } finally {
      opened.db.close();
    }
    // Apply explicit subset.
    const { applyMigrations } = await import("../state");
    const re = await openStateStore();
    try {
      applyMigrations(re.db, subset, re.driver.id);
    } finally {
      re.db.close();
    }
    const projection = new RunIndexProjection();
    const outcome = await projection.upsert(makeRow("run-no-mig"));
    expect(outcome.status).toBe("disabled");
    expect(projection.disabledMessage).toContain("run_index");
    projection.close();
  });
});
