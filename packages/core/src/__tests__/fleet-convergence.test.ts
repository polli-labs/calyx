import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  applyStateMigrations,
  checkFleetConvergenceSchema,
  FLEET_CONVERGENCE_TABLES,
  listFleetConvergenceRows,
  openStateStore,
  planStateMigrations,
  readFleetConvergenceRow,
  runStateDoctor,
  STATE_MIGRATIONS,
  upsertFleetConvergenceRow,
} from "../state";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;

describe("fleet convergence state (migration 0005)", () => {
  let root: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of ENV_KEYS) delete process.env[key];
    root = await mkdtemp(join(tmpdir(), "calyx-fleet-convergence-"));
    process.env["CALYX_STATE_HOME"] = join(root, "state");
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  test("migration 0005 creates the fleet_convergence table", async () => {
    const plan = await planStateMigrations();
    expect(plan.pending.map((entry) => entry.id)).toContain("0005");

    const result = await applyStateMigrations();
    expect(result.applied.map((entry) => entry.id)).toContain("0005");
    // The latest migration advances as new domains land (POL-1838 added 0013);
    // pin only that this migration set still includes the slots this suite owns.
    expect(STATE_MIGRATIONS.map((entry) => entry.id)).toContain("0012");
    expect(STATE_MIGRATIONS.map((entry) => entry.id)).toContain("0011");
    expect(FLEET_CONVERGENCE_TABLES.map((table) => table.table)).toEqual(["fleet_convergence"]);

    const opened = await openStateStore();
    try {
      expect(checkFleetConvergenceSchema(opened.db)).toEqual({ status: "ok", findings: [] });
    } finally {
      opened.db.close();
    }
  });

  test("upserts one row per host and leg with receipt linkage", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      upsertFleetConvergenceRow(opened.db, {
        host: "mba",
        leg: "daemon_build",
        target_rev: "e0574b2e0574b2e0574b2e0574b2e0574b2e0574",
        observed_rev: null,
        converged_from: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        policy: "auto",
        last_checked_at: "2026-06-10T19:00:00.000Z",
        verdict: "pending",
        receipt_path: "/tmp/summary.json",
        receipt_id: "fleet-20260610",
        detail: "ssh exited with code 255",
        payload: { source: "self-upgrade-fleet" },
      });
      upsertFleetConvergenceRow(opened.db, {
        host: "mba",
        leg: "skills",
        target_rev: null,
        observed_rev: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        converged_from: "cccccccccccccccccccccccccccccccccccccccc",
        policy: "auto",
        last_checked_at: "2026-06-10T19:01:00.000Z",
        verdict: "fresh",
      });

      const daemon = readFleetConvergenceRow(opened.db, "mba", "daemon_build");
      expect(daemon).toMatchObject({
        host: "mba",
        leg: "daemon_build",
        verdict: "pending",
        policy: "auto",
        receipt_path: "/tmp/summary.json",
        receipt_id: "fleet-20260610",
        detail: "ssh exited with code 255",
        payload: { source: "self-upgrade-fleet" },
      });

      upsertFleetConvergenceRow(opened.db, {
        host: "mba",
        leg: "daemon_build",
        target_rev: "dddddddddddddddddddddddddddddddddddddddd",
        observed_rev: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        converged_from: "ffffffffffffffffffffffffffffffffffffffff",
        policy: "auto",
        last_checked_at: "2026-06-10T20:00:00.000Z",
        verdict: "pending",
      });

      const rows = listFleetConvergenceRows(opened.db, { host: "mba" });
      expect(rows.map((row) => [row.host, row.leg, row.target_rev])).toEqual([
        ["mba", "daemon_build", "dddddddddddddddddddddddddddddddddddddddd"],
        ["mba", "skills", null],
      ]);
      expect(rows.find((row) => row.leg === "daemon_build")).toMatchObject({
        receipt_path: "/tmp/summary.json",
        receipt_id: "fleet-20260610",
      });
    } finally {
      opened.db.close();
    }
  });

  test("rejects ref-looking target revisions instead of persisting refs", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      expect(() => upsertFleetConvergenceRow(opened.db, {
        host: "mba",
        leg: "daemon_build",
        target_rev: "origin/main",
        observed_rev: null,
        converged_from: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        policy: "auto",
        last_checked_at: "2026-06-10T19:00:00.000Z",
        verdict: "pending",
      })).toThrow(/target_rev must be a full git SHA or null/);
    } finally {
      opened.db.close();
    }
  });

  test("state doctor reports fleet_convergence schema parity", async () => {
    await applyStateMigrations();
    const report = await runStateDoctor({ domains: ["fleet_convergence"] });
    expect(report.ok).toBe(true);
    expect(report.fleetConvergence.migrationApplied).toBe(true);
    expect(report.fleetConvergence.schemaParity).toBe("ok");
    expect(report.domains?.find((domain) => domain.domain === "fleet_convergence")).toMatchObject({
      status: "ok",
    });
  });
});
