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
import { fleetConvergenceToolchainCheckSchema } from "../fleet-convergence-check";

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

describe("fleet convergence toolchain pass evidence", () => {
  const passing = {
    schema_version: "fleet-convergence-check/v1" as const,
    surface: "toolchain" as const,
    status: "pass" as const,
    host: "blade",
    expected: { node_range: ">=22.13.0", package_manager: "pnpm" as const, pnpm_version: "10.34.1" },
    observed: {
      process_exec_path_realpath: "/usr/bin/node",
      process_node_version: "v22.23.1",
      child_node: { executable_realpath: "/usr/bin/node", version: "v22.23.1", exit_code: 0 },
      child_pnpm: {
        executable_realpath: "/usr/bin/pnpm",
        resolution_source: "pnpm-exec-node-path" as const,
        self_dispatched: { version: "10.34.1", exit_code: 0 },
        intrinsic: { version: "10.34.1", exit_code: 0, probe: "with-current" as const },
        nested: { version: "10.34.1", exit_code: 0 },
      },
      bootstrap_cwd: "/srv/calyx",
      spawn_contract: "@polli-labs/calyx/self-upgrade-child-spawn@v1",
      environment_contract: "self-upgrade-bootstrap-isolated-env/v1" as const,
      path_resolution: {
        observer: "parent_diagnostic" as const,
        total_entries: 1,
        truncated: false,
        entries: [{ index: 0, directory: "/usr/bin" }],
      },
    },
    failures: [],
    checked_at: "2026-08-03T00:00:00.000Z",
    evidence: {
      source: "self-upgrade-bootstrap-attestation" as const,
      spawn_contract: "@polli-labs/calyx/self-upgrade-child-spawn@v1",
    },
    freshness: { status: "current" as const, observed_at: "2026-08-03T00:00:00.000Z" },
    topology_identity: { status: "not_bound" as const },
    target_bundle_identity: { calyx_source_sha: "a".repeat(40) },
  };

  test("requires pass evidence to be current, complete, and from the real child-spawn contract", () => {
    expect(fleetConvergenceToolchainCheckSchema.safeParse(passing).success).toBe(true);
    const invalidPasses = [
      { ...passing, expected: { ...passing.expected, node_range: null } },
      { ...passing, expected: { ...passing.expected, node_range: ">=not-a-node-version" } },
      { ...passing, expected: { ...passing.expected, package_manager: undefined } },
      { ...passing, expected: { ...passing.expected, pnpm_version: "not-a-pnpm-version" } },
      { ...passing, evidence: { ...passing.evidence, source: "unobserved" } },
      { ...passing, evidence: { ...passing.evidence, spawn_contract: "other" } },
      { ...passing, observed: { ...passing.observed, spawn_contract: "other" } },
      {
        ...passing,
        freshness: { status: "recalled" as const, observed_at: passing.checked_at },
      },
      { ...passing, observed: { ...passing.observed, process_exec_path_realpath: undefined } },
      {
        ...passing,
        observed: {
          ...passing.observed,
          child_pnpm: {
            ...passing.observed.child_pnpm,
            nested: { version: "11.17.0", exit_code: 0 },
          },
        },
      },
      { ...passing, target_bundle_identity: { calyx_source_sha: null } },
      {
        ...passing,
        observed: { ...passing.observed, process_node_version: undefined },
      },
      {
        ...passing,
        observed: { ...passing.observed, process_node_version: "v20.0.0" },
      },
      {
        ...passing,
        observed: {
          ...passing.observed,
          child_node: { ...passing.observed.child_node, version: "v20.0.0" },
        },
      },
      {
        ...passing,
        observed: {
          ...passing.observed,
          child_pnpm: {
            ...passing.observed.child_pnpm,
            self_dispatched: { version: "11.17.0", exit_code: 0 },
          },
        },
      },
      {
        ...passing,
        observed: {
          ...passing.observed,
          child_pnpm: {
            ...passing.observed.child_pnpm,
            intrinsic: { version: "11.17.0", exit_code: 0, probe: "with-current" },
          },
        },
      },
      {
        ...passing,
        observed: {
          ...passing.observed,
          child_node: {
            ...passing.observed.child_node,
            error: "identity observation failed",
          },
        },
      },
      {
        ...passing,
        repair_owner: "fleet_ops" as const,
        next_action: {
          kind: "repair_toolchain" as const,
          description: "repair contradictory pass",
        },
      },
    ];
    for (const invalid of invalidPasses) {
      expect(fleetConvergenceToolchainCheckSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
