import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyStateMigrations,
  openStateStore,
  upsertFleetConvergenceRow,
} from "@polli-labs/calyx-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { buildProgram } from "../run-cli";
import {
  makeFleetTopologyTarget,
  makeFleetTopologyTargets,
  TEST_TOPOLOGY_COMMIT,
  TEST_TOPOLOGY_DIGEST,
} from "./fleet-topology-fixture.js";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;
const TARGET_SHA = "1111111111111111111111111111111111111111";
const OBSERVED_SHA = "2222222222222222222222222222222222222222";
const CHECKOUT_SHA = "3333333333333333333333333333333333333333";

describe("fleet status command", () => {
  let root: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env.CALYX_STATE_HOME,
      CALYX_STATE_DB: process.env.CALYX_STATE_DB,
    };
    for (const key of ENV_KEYS) delete process.env[key];
    root = await mkdtemp(join(tmpdir(), "calyx-fleet-status-"));
    process.env.CALYX_STATE_HOME = join(root, "state");
    await applyStateMigrations();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  test("calyx fleet status --json reads convergence rows without probing hosts", async () => {
    const opened = await openStateStore();
    try {
      upsertFleetConvergenceRow(opened.db, {
        host: "blade",
        leg: "daemon_build",
        target_rev: TARGET_SHA,
        observed_rev: TARGET_SHA,
        converged_from: CHECKOUT_SHA,
        policy: "auto",
        last_checked_at: "2026-06-10T20:00:00.000Z",
        verdict: "fresh",
      });
      upsertFleetConvergenceRow(opened.db, {
        host: "mba",
        leg: "daemon_build",
        target_rev: TARGET_SHA,
        observed_rev: null,
        converged_from: CHECKOUT_SHA,
        policy: "auto",
        last_checked_at: "2026-06-10T20:01:00.000Z",
        verdict: "pending",
        receipt_path: "/tmp/summary.json",
      });
      upsertFleetConvergenceRow(opened.db, {
        host: "mba",
        leg: "skills",
        target_rev: null,
        observed_rev: OBSERVED_SHA,
        converged_from: CHECKOUT_SHA,
        policy: "auto",
        last_checked_at: "2026-06-10T20:01:00.000Z",
        verdict: "fresh",
      });
    } finally {
      opened.db.close();
    }

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({
      runCli: {
        now: () => new Date("2026-06-10T20:02:00.000Z"),
        resolveFleetTopology: async () => makeFleetTopologyTargets({
          active: [
            makeFleetTopologyTarget("blade"),
            makeFleetTopologyTarget("mba"),
            makeFleetTopologyTarget("worm"),
          ],
          withdrawn: [makeFleetTopologyTarget("carbon", "withdrawn")],
        }),
      },
    });

    await expect(
      program.parseAsync(["node", "calyx", "fleet", "status", "--json"]),
    ).rejects.toMatchObject({ exitCode: 6 });

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      schema_version: string;
      checked_at: string;
      topology_snapshot: { source: { commit: string }; projection_sha256: string };
      summary: Record<string, number | boolean>;
      hosts: Array<{ host: string; verdict: string; effective_state: string; legs: Array<{ leg: string; verdict: string; receipt_path?: string }> }>;
      excluded_withdrawn: Array<{ host: string; effective_state: string }>;
    };
    expect(payload.schema_version).toBe("fleet-convergence-status/v2");
    expect(payload.checked_at).toBe("2026-06-10T20:02:00.000Z");
    expect(payload.topology_snapshot).toMatchObject({
      source: { commit: TEST_TOPOLOGY_COMMIT },
      projection_sha256: TEST_TOPOLOGY_DIGEST,
    });
    expect(payload.summary).toMatchObject({
      fresh: 1,
      pending: 1,
      structural: 0,
      missing: 1,
      active: 1,
      repair: 1,
      unavailable: 1,
      desired_active_total: 3,
      withdrawn_total: 1,
      green: false,
    });
    expect(payload.hosts.map((host) => [host.host, host.verdict, host.effective_state])).toEqual([
      ["blade", "fresh", "active"],
      ["mba", "pending", "repair"],
      ["worm", "missing", "unavailable"],
    ]);
    expect(payload.excluded_withdrawn).toEqual([
      expect.objectContaining({ host: "carbon", effective_state: "withdrawn" }),
    ]);
    expect(payload.hosts.find((host) => host.host === "mba")?.legs).toEqual([
      expect.objectContaining({ leg: "daemon_build", verdict: "pending", receipt_path: "/tmp/summary.json" }),
      expect.objectContaining({ leg: "skills", verdict: "fresh" }),
    ]);
  });

  test("calyx fleet status --host filters rows", async () => {
    const opened = await openStateStore();
    try {
      for (const host of ["blade", "worm"]) {
        upsertFleetConvergenceRow(opened.db, {
          host,
          leg: "daemon_build",
          target_rev: TARGET_SHA,
          observed_rev: TARGET_SHA,
          converged_from: CHECKOUT_SHA,
          policy: "auto",
          last_checked_at: "2026-06-10T20:00:00.000Z",
          verdict: "fresh",
        });
      }
    } finally {
      opened.db.close();
    }

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({
      runCli: {
        resolveFleetTopology: async () => makeFleetTopologyTargets({
          active: [makeFleetTopologyTarget("blade"), makeFleetTopologyTarget("worm")],
        }),
      },
    });
    await program.parseAsync(["node", "calyx", "fleet", "status", "--host", "worm", "--json"]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as { hosts: Array<{ host: string }> };
    expect(payload.hosts.map((host) => host.host)).toEqual(["worm"]);
  });
});
