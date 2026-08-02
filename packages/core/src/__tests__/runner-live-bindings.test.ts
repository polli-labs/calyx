import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  applyStateMigrations,
  checkRunnerLiveBindingSchema,
  clearRunnerLiveBindingActiveTurn,
  closeRunnerLiveBinding,
  countRunnerLiveBindingsByStatus,
  listRunnerLiveBindings,
  openStateStore,
  readRunnerLiveBindingByRunAdapter,
  recordRunnerLiveBindingActiveTurn,
  runStateDoctor,
  upsertRunnerLiveBinding,
} from "../state";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;

describe("runner live binding state", () => {
  let root: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of ENV_KEYS) delete process.env[key];
    root = await mkdtemp(join(tmpdir(), "calyx-runner-live-bindings-"));
    process.env["CALYX_STATE_HOME"] = join(root, "state");
    await applyStateMigrations();
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  test("migration 0010 creates runner_live_bindings and state doctor reports it", async () => {
    const opened = await openStateStore();
    try {
      expect(checkRunnerLiveBindingSchema(opened.db)).toEqual({ status: "ok", findings: [] });
    } finally {
      opened.db.close();
    }

    const report = await runStateDoctor({ domains: ["runner_live_bindings"] });
    expect(report.ok).toBe(true);
    expect(report.runnerLiveBindings).toMatchObject({
      migrationApplied: true,
      schemaParity: "ok",
      rowCount: 0,
    });
    expect(report.domains?.find((domain) => domain.domain === "runner_live_bindings")).toMatchObject({
      status: "ok",
    });
  });

  test("upserts, records, clears, and closes Calyx-owned active turn bindings", async () => {
    const opened = await openStateStore();
    try {
      const inserted = upsertRunnerLiveBinding(opened.db, {
        run_id: "run-live-1",
        adapter: "codex_app_server_steer",
        backend: "codex",
        lifecycle_owner: "calyx",
        host: "blade",
        codex_home: join(root, "codex-home"),
        transport_kind: "stdio-jsonl",
        endpoint: {
          transport: "stdio-jsonl",
          command: "codex",
          args: ["app-server", "--listen", "stdio://"],
        },
        thread_id: "thread-live-1",
        adapter_session_id: "session-live-1",
        connection_id: "connection-live-1",
        auth_ref: { mode: "codex_home", codex_home: join(root, "codex-home") },
        now: "2026-06-12T05:00:00.000Z",
      });

      expect(inserted).toMatchObject({
        run_id: "run-live-1",
        adapter: "codex_app_server_steer",
        status: "active",
        thread_id: "thread-live-1",
      });

      const active = recordRunnerLiveBindingActiveTurn(opened.db, {
        run_id: "run-live-1",
        adapter: "codex_app_server_steer",
        turn_id: "turn-live-1",
        source: "app-server-notification:turn/started",
        observed_at: "2026-06-12T05:00:01.000Z",
        status: "in_progress",
      });
      expect(active).toMatchObject({
        active_turn_id: "turn-live-1",
        active_turn_source: "app-server-notification:turn/started",
        active_turn_observed_at: "2026-06-12T05:00:01.000Z",
      });

      const cleared = clearRunnerLiveBindingActiveTurn(opened.db, {
        run_id: "run-live-1",
        adapter: "codex_app_server_steer",
        source: "app-server-notification:turn/completed",
        observed_at: "2026-06-12T05:00:02.000Z",
        status: "completed",
      });
      expect(cleared).toMatchObject({
        active_turn_id: null,
        active_turn_status: "completed",
      });

      const closed = closeRunnerLiveBinding(opened.db, {
        run_id: "run-live-1",
        adapter: "codex_app_server_steer",
        source: "session-close",
        closed_at: "2026-06-12T05:00:03.000Z",
      });
      expect(closed).toMatchObject({
        status: "closed",
        active_turn_id: null,
        closed_at: "2026-06-12T05:00:03.000Z",
      });
      expect(countRunnerLiveBindingsByStatus(opened.db)).toEqual({ active: 0, closed: 1 });
      expect(listRunnerLiveBindings(opened.db, { status: "all" })).toHaveLength(1);
    } finally {
      opened.db.close();
    }
  });

  test("refuses obvious auth material in auth_ref_json", async () => {
    const opened = await openStateStore();
    try {
      expect(() => upsertRunnerLiveBinding(opened.db, {
        run_id: "run-live-secret",
        adapter: "codex_app_server_steer",
        backend: "codex",
        lifecycle_owner: "calyx",
        host: "blade",
        transport_kind: "stdio-jsonl",
        endpoint: {},
        thread_id: "thread-live-secret",
        auth_ref: { mode: "inline", access_token: "do-not-store" },
      })).toThrow("must be a reference descriptor");
      expect(readRunnerLiveBindingByRunAdapter(opened.db, "run-live-secret", "codex_app_server_steer")).toBeUndefined();
    } finally {
      opened.db.close();
    }
  });
});
