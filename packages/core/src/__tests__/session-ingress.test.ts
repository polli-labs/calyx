import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  applyStateMigrations,
  attachSessionWakeDeliveryBinding,
  checkMessageSchema,
  completeSessionWakeDelivery,
  createSessionWakeDeliveryAttempt,
  exchangeSessionIngressLaunch,
  openStateStore,
  prepareSessionIngressLaunch,
  readActiveSessionIngressBinding,
  readSessionIngressBinding,
  renewSessionIngressBinding,
  resolveSessionIngressBinding,
  retireSessionIngressBinding,
} from "../state";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;

describe("session ingress state", () => {
  let root: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    root = await mkdtemp(join(tmpdir(), "calyx-session-ingress-"));
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

  test("migration 0032 participates in message schema parity", async () => {
    const opened = await openStateStore();
    try {
      expect(checkMessageSchema(opened.db)).toEqual({ status: "ok", findings: [] });
    } finally {
      opened.db.close();
    }
  });

  test("one-use launch nonce binds an exact activity and generation-gates lifecycle", async () => {
    const opened = await openStateStore();
    try {
      const prepared = prepareSessionIngressLaunch(opened.db, {
        backend: "claude",
        destination_host: "carbon",
        capabilities: ["message", "monitor_wake"],
        now: "2026-07-17T12:00:00.000Z",
      });
      expect(JSON.stringify(prepared.launch)).not.toContain(prepared.launch_nonce);
      expect(prepared.launch.endpoint_ref).not.toContain("/");

      const binding = exchangeSessionIngressLaunch(opened.db, {
        launch_nonce: prepared.launch_nonce,
        activity_id: "interactive:claude:session-1",
        harness_session_id: "session-1",
        now: "2026-07-17T12:00:01.000Z",
        lease_ttl_ms: 10_000,
      });
      expect(binding).toMatchObject({
        activity_id: "interactive:claude:session-1",
        backend: "claude",
        destination_host: "carbon",
        generation: prepared.launch.generation,
        adapter: "unix_socket",
        retired_at: null,
      });
      expect(() => exchangeSessionIngressLaunch(opened.db, {
        launch_nonce: prepared.launch_nonce,
        activity_id: "interactive:claude:session-1",
        harness_session_id: "session-1",
        now: "2026-07-17T12:00:02.000Z",
      })).toThrow(/already consumed/);

      expect(renewSessionIngressBinding(opened.db, {
        binding_id: binding.binding_id,
        generation: "stale-generation",
        now: "2026-07-17T12:00:03.000Z",
      })).toBeUndefined();
      const renewed = renewSessionIngressBinding(opened.db, {
        binding_id: binding.binding_id,
        generation: binding.generation,
        now: "2026-07-17T12:00:03.000Z",
        lease_ttl_ms: 20_000,
      });
      expect(renewed?.renewed_at).toBe("2026-07-17T12:00:03.000Z");

      expect(retireSessionIngressBinding(opened.db, {
        binding_id: binding.binding_id,
        generation: "stale-generation",
        now: "2026-07-17T12:00:04.000Z",
      })).toBeUndefined();
      expect(readActiveSessionIngressBinding(opened.db, binding.activity_id)?.binding_id).toBe(binding.binding_id);
      expect(retireSessionIngressBinding(opened.db, {
        binding_id: binding.binding_id,
        generation: binding.generation,
        now: "2026-07-17T12:00:04.000Z",
      })?.retired_at).toBe("2026-07-17T12:00:04.000Z");
      expect(resolveSessionIngressBinding(opened.db, binding.activity_id, {
        now: "2026-07-17T12:00:05.000Z",
      })).toEqual({ state: "binding_unavailable" });
    } finally {
      opened.db.close();
    }
  });

  test("rapid replacement rejects stale heartbeat and SessionEnd from the old generation", async () => {
    const opened = await openStateStore();
    try {
      const firstLaunch = prepareSessionIngressLaunch(opened.db, {
        backend: "codex",
        destination_host: "carbon",
        now: "2026-07-17T12:00:00.000Z",
      });
      const first = exchangeSessionIngressLaunch(opened.db, {
        launch_nonce: firstLaunch.launch_nonce,
        activity_id: "interactive:codex:same-session",
        harness_session_id: "same-session",
        now: "2026-07-17T12:00:01.000Z",
      });
      const secondLaunch = prepareSessionIngressLaunch(opened.db, {
        backend: "codex",
        destination_host: "carbon",
        now: "2026-07-17T12:00:02.000Z",
      });
      const second = exchangeSessionIngressLaunch(opened.db, {
        launch_nonce: secondLaunch.launch_nonce,
        activity_id: "interactive:codex:same-session",
        harness_session_id: "same-session",
        now: "2026-07-17T12:00:03.000Z",
      });

      expect(readSessionIngressBinding(opened.db, first.binding_id)?.retired_at).toBe("2026-07-17T12:00:03.000Z");
      expect(renewSessionIngressBinding(opened.db, {
        binding_id: first.binding_id,
        generation: first.generation,
        now: "2026-07-17T12:00:04.000Z",
      })).toBeUndefined();
      expect(retireSessionIngressBinding(opened.db, {
        binding_id: first.binding_id,
        generation: first.generation,
        now: "2026-07-17T12:00:05.000Z",
      })).toBeUndefined();
      expect(readActiveSessionIngressBinding(opened.db, second.activity_id)?.binding_id).toBe(second.binding_id);
    } finally {
      opened.db.close();
    }
  });

  test("expired bindings remain distinct from absent bindings", async () => {
    const opened = await openStateStore();
    try {
      const launch = prepareSessionIngressLaunch(opened.db, {
        backend: "claude",
        destination_host: "carbon",
        now: "2026-07-17T12:00:00.000Z",
      });
      const binding = exchangeSessionIngressLaunch(opened.db, {
        launch_nonce: launch.launch_nonce,
        activity_id: "interactive:claude:expiring",
        harness_session_id: "expiring",
        now: "2026-07-17T12:00:01.000Z",
        lease_ttl_ms: 1_000,
      });
      expect(resolveSessionIngressBinding(opened.db, binding.activity_id, {
        now: "2026-07-17T12:00:02.000Z",
      })).toMatchObject({ state: "binding_expired", binding: { binding_id: binding.binding_id } });
      expect(resolveSessionIngressBinding(opened.db, binding.activity_id, {
        now: "2026-07-17T12:00:03.000Z",
      })).toEqual({ state: "binding_unavailable" });
    } finally {
      opened.db.close();
    }
  });

  test("one pointer/activity pair has one delivery attempt across router retries", async () => {
    const opened = await openStateStore();
    try {
      const launch = prepareSessionIngressLaunch(opened.db, {
        backend: "codex",
        destination_host: "carbon",
        now: "2026-07-17T12:00:00.000Z",
      });
      const binding = exchangeSessionIngressLaunch(opened.db, {
        launch_nonce: launch.launch_nonce,
        activity_id: "interactive:codex:target",
        harness_session_id: "target",
        now: "2026-07-17T12:00:01.000Z",
      });
      const first = createSessionWakeDeliveryAttempt(opened.db, {
        pointer_kind: "message",
        pointer_id: "msg-1",
        activity_id: binding.activity_id,
        attempted_at: "2026-07-17T12:00:02.000Z",
      });
      const attached = attachSessionWakeDeliveryBinding(opened.db, first.delivery.delivery_id, binding, {
        adapter: binding.adapter,
        endpoint_ref: binding.endpoint_ref,
      });
      expect(attached).toMatchObject({
        binding_id: binding.binding_id,
        binding_generation: binding.generation,
        status: "attempted",
      });
      const delivered = completeSessionWakeDelivery(opened.db, {
        delivery_id: first.delivery.delivery_id,
        status: "delivered",
        completed_at: "2026-07-17T12:00:03.000Z",
        evidence: { accepted: true },
      });
      expect(delivered).toMatchObject({ status: "delivered", delivered_at: "2026-07-17T12:00:03.000Z" });

      const replay = createSessionWakeDeliveryAttempt(opened.db, {
        pointer_kind: "message",
        pointer_id: "msg-1",
        activity_id: binding.activity_id,
        attempted_at: "2026-07-17T12:00:04.000Z",
      });
      expect(replay.inserted).toBe(false);
      expect(replay.delivery).toEqual(delivered);
    } finally {
      opened.db.close();
    }
  });
});
