import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyStateMigrations,
  createSessionWakeDeliveryAttempt,
  createMessage,
  exchangeSessionIngressLaunch,
  listMessageDeliveries,
  openStateStore,
  prepareSessionIngressLaunch,
  readMessage,
  renewSessionIngressBinding,
  retireSessionIngressBinding,
  type SessionWakeEnvelopeV1,
} from "@polli-labs/calyx-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  deliverSessionWakeViaPrivateIpc,
  routeSessionWake,
  startSessionIngressReceiver,
} from "../session-ingress.js";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;

describe("session ingress router", () => {
  let root: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    root = await mkdtemp(join(tmpdir(), "calyx-session-router-"));
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

  test("ordinary unbound sessions retain a typed durable-only result", async () => {
    const opened = await openStateStore();
    try {
      const result = await routeSessionWake(opened.db, {
        recipient_activity_id: "interactive:claude:ordinary-session",
        pointer_kind: "message",
        pointer_id: "msg-unbound",
        created_at: "2026-07-17T12:00:00.000Z",
      }, { now: () => "2026-07-17T12:00:01.000Z" });
      expect(result).toMatchObject({
        schema_version: "calyx.session-wake-result/v1",
        delivery_state: "spooled",
        wake_state: "binding_unavailable",
        delivery: {
          status: "failed",
          error_code: "binding_unavailable",
        },
      });
    } finally {
      opened.db.close();
    }
  });

  test("a replayed attempted delivery is explicitly indeterminate and never redelivered", async () => {
    const opened = await openStateStore();
    try {
      createSessionWakeDeliveryAttempt(opened.db, {
        pointer_kind: "message",
        pointer_id: "msg-crash-window",
        activity_id: "interactive:claude:crash-window",
        attempted_at: "2026-07-17T12:00:00.000Z",
      });
      const deliver = vi.fn();
      const result = await routeSessionWake(opened.db, {
        recipient_activity_id: "interactive:claude:crash-window",
        pointer_kind: "message",
        pointer_id: "msg-crash-window",
        created_at: "2026-07-17T12:00:00.000Z",
      }, { deliver });

      expect(result).toMatchObject({
        schema_version: "calyx.session-wake-result/v1",
        delivery_state: "spooled",
        wake_state: "delivery_indeterminate",
        delivery: {
          status: "attempted",
          delivered_at: null,
          failed_at: null,
          error_code: null,
        },
      });
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      opened.db.close();
    }
  });

  test("an explicitly registered conductor receives a body-free pointer over private IPC", async () => {
    const opened = await openStateStore();
    const runtimeDir = join(root, "runtime");
    let receiver: Awaited<ReturnType<typeof startSessionIngressReceiver>> | undefined;
    try {
      const prepared = prepareSessionIngressLaunch(opened.db, {
        backend: "claude",
        destination_host: "carbon",
        now: "2026-07-17T12:00:00.000Z",
      });
      const received: SessionWakeEnvelopeV1[] = [];
      receiver = await startSessionIngressReceiver({
        endpoint_ref: prepared.launch.endpoint_ref,
        generation: prepared.launch.generation,
        runtimeDir,
        now: () => "2026-07-17T12:00:03.000Z",
        onWake: (envelope) => { received.push(envelope); },
      });
      const runtimeMode = (await stat(runtimeDir)).mode & 0o777;
      const [socketName] = await readdir(runtimeDir);
      const socketMode = (await stat(join(runtimeDir, socketName!))).mode & 0o777;
      expect(runtimeMode).toBe(0o700);
      expect(socketMode).toBe(0o600);

      const binding = exchangeSessionIngressLaunch(opened.db, {
        launch_nonce: prepared.launch_nonce,
        activity_id: "interactive:claude:conductor-session",
        harness_session_id: "conductor-session",
        now: "2026-07-17T12:00:01.000Z",
      });
      createMessage(opened.db, {
        message_id: "msg-conductor",
        sender: "interactive:codex:sender",
        recipient_address: binding.activity_id,
        recipient_class: "directed",
        recipient_host: "carbon",
        subject: "wake",
        status: "pending",
        now: "2026-07-17T12:00:02.000Z",
      });
      const result = await routeSessionWake(opened.db, {
        recipient_activity_id: binding.activity_id,
        pointer_kind: "message",
        pointer_id: "msg-conductor",
        created_at: "2026-07-17T12:00:02.000Z",
      }, {
        runtimeDir,
        now: () => "2026-07-17T12:00:04.000Z",
      });
      expect(result.wake_state, JSON.stringify(result)).toBe("wake_delivered");
      expect(result).toMatchObject({
        delivery_state: "spooled",
        wake_state: "wake_delivered",
        delivery: { status: "delivered" },
      });
      expect(received).toEqual([{
        schema_version: "calyx.session-wake/v1",
        delivery_id: result.delivery.delivery_id,
        recipient_activity_id: binding.activity_id,
        binding: {
          binding_id: binding.binding_id,
          generation: binding.generation,
        },
        pointer: { kind: "message", id: "msg-conductor" },
        first_command: `calyx msg inbox --for ${binding.activity_id} --json`,
        created_at: "2026-07-17T12:00:02.000Z",
      }]);
      expect(JSON.stringify(received[0])).not.toContain("body");
      expect(JSON.stringify(result)).not.toContain(`${runtimeDir}/`);
      expect(readMessage(opened.db, "msg-conductor")?.delivered_at).toBe("2026-07-17T12:00:04.000Z");
      expect(listMessageDeliveries(opened.db, { message_id: "msg-conductor" })).toMatchObject([
        { adapter: "session_ingress", status: "delivered" },
      ]);
    } finally {
      await receiver?.close();
      opened.db.close();
    }
  });

  test("heartbeat renews while matching SessionEnd retires and stale generations cannot interfere", async () => {
    const opened = await openStateStore();
    try {
      const prepared = prepareSessionIngressLaunch(opened.db, {
        backend: "codex",
        destination_host: "carbon",
        now: "2026-07-17T12:00:00.000Z",
      });
      const binding = exchangeSessionIngressLaunch(opened.db, {
        launch_nonce: prepared.launch_nonce,
        activity_id: "interactive:codex:conductor",
        harness_session_id: "conductor",
        now: "2026-07-17T12:00:01.000Z",
        lease_ttl_ms: 5_000,
      });
      expect(renewSessionIngressBinding(opened.db, {
        binding_id: binding.binding_id,
        generation: binding.generation,
        now: "2026-07-17T12:00:04.000Z",
        lease_ttl_ms: 5_000,
      })?.expires_at).toBe("2026-07-17T12:00:09.000Z");
      expect(retireSessionIngressBinding(opened.db, {
        binding_id: binding.binding_id,
        generation: "old-generation",
        now: "2026-07-17T12:00:05.000Z",
      })).toBeUndefined();
      expect(retireSessionIngressBinding(opened.db, {
        binding_id: binding.binding_id,
        generation: binding.generation,
        now: "2026-07-17T12:00:06.000Z",
      })?.retired_at).toBe("2026-07-17T12:00:06.000Z");

      const result = await routeSessionWake(opened.db, {
        recipient_activity_id: binding.activity_id,
        pointer_kind: "monitor_wake",
        pointer_id: "wake-after-end",
        created_at: "2026-07-17T12:00:07.000Z",
      }, { now: () => "2026-07-17T12:00:08.000Z" });
      expect(result.wake_state).toBe("binding_unavailable");
    } finally {
      opened.db.close();
    }
  });

  test("destination time expires an old lease even when the sender supplies an earlier created_at", async () => {
    const opened = await openStateStore();
    try {
      const prepared = prepareSessionIngressLaunch(opened.db, {
        backend: "codex",
        destination_host: "carbon",
        now: "2026-07-17T12:00:00.000Z",
      });
      const binding = exchangeSessionIngressLaunch(opened.db, {
        launch_nonce: prepared.launch_nonce,
        activity_id: "interactive:codex:expired-at-destination",
        harness_session_id: "expired-at-destination",
        now: "2026-07-17T12:00:01.000Z",
        lease_ttl_ms: 1_000,
      });
      const result = await routeSessionWake(opened.db, {
        recipient_activity_id: binding.activity_id,
        pointer_kind: "monitor_wake",
        pointer_id: "wake-old-provenance",
        created_at: "2026-07-17T11:00:00.000Z",
      }, { now: () => "2026-07-17T12:00:03.000Z" });
      expect(result).toMatchObject({
        wake_state: "binding_expired",
        delivery: { error_code: "binding_expired" },
      });
    } finally {
      opened.db.close();
    }
  });

  test("a bound destination rejects a ghost message pointer before private IPC", async () => {
    const opened = await openStateStore();
    try {
      const prepared = prepareSessionIngressLaunch(opened.db, {
        backend: "claude",
        destination_host: "carbon",
      });
      const binding = exchangeSessionIngressLaunch(opened.db, {
        launch_nonce: prepared.launch_nonce,
        activity_id: "interactive:claude:ghost-target",
        harness_session_id: "ghost-target",
      });
      const deliver = vi.fn();
      const result = await routeSessionWake(opened.db, {
        recipient_activity_id: binding.activity_id,
        pointer_kind: "message",
        pointer_id: "msg-never-admitted",
      }, { deliver });
      expect(result).toMatchObject({
        wake_state: "pointer_unavailable",
        delivery: { error_code: "pointer_unavailable" },
      });
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      opened.db.close();
    }
  });

  test("the private receiver rejects an old delivery after rapid binding replacement", async () => {
    const opened = await openStateStore();
    const runtimeDir = await mkdtemp(join(tmpdir(), "calyx-replacement-runtime-"));
    let receiver: Awaited<ReturnType<typeof startSessionIngressReceiver>> | undefined;
    try {
      const firstLaunch = prepareSessionIngressLaunch(opened.db, {
        backend: "codex",
        destination_host: "carbon",
      });
      const received = vi.fn();
      receiver = await startSessionIngressReceiver({
        endpoint_ref: firstLaunch.launch.endpoint_ref,
        generation: firstLaunch.launch.generation,
        runtimeDir,
        onWake: received,
      });
      const first = exchangeSessionIngressLaunch(opened.db, {
        launch_nonce: firstLaunch.launch_nonce,
        activity_id: "interactive:codex:rapid-replacement",
        harness_session_id: "rapid-replacement",
      });
      const secondLaunch = prepareSessionIngressLaunch(opened.db, {
        backend: "codex",
        destination_host: "carbon",
      });
      const result = await routeSessionWake(opened.db, {
        recipient_activity_id: first.activity_id,
        pointer_kind: "monitor_wake",
        pointer_id: "wake-selected-old-binding",
      }, {
        runtimeDir,
        deliver: async (selected, envelope) => {
          exchangeSessionIngressLaunch(opened.db, {
            launch_nonce: secondLaunch.launch_nonce,
            activity_id: first.activity_id,
            harness_session_id: "rapid-replacement",
          });
          return deliverSessionWakeViaPrivateIpc(selected, envelope, { runtimeDir });
        },
      });
      expect(result).toMatchObject({
        wake_state: "binding_replaced",
        delivery: { error_code: "binding_replaced" },
      });
      expect(received).not.toHaveBeenCalled();
    } finally {
      await receiver?.close();
      await rm(runtimeDir, { recursive: true, force: true });
      opened.db.close();
    }
  });

  test("public wake JSON sanitizes private IPC paths", async () => {
    const opened = await openStateStore();
    try {
      const prepared = prepareSessionIngressLaunch(opened.db, {
        backend: "claude",
        destination_host: "carbon",
      });
      const binding = exchangeSessionIngressLaunch(opened.db, {
        launch_nonce: prepared.launch_nonce,
        activity_id: "interactive:claude:sanitized-failure",
        harness_session_id: "sanitized-failure",
      });
      const leakedPath = "/private/runtime/session-ingress/secret.sock";
      const result = await routeSessionWake(opened.db, {
        recipient_activity_id: binding.activity_id,
        pointer_kind: "monitor_wake",
        pointer_id: "wake-sanitized",
      }, {
        deliver: async () => { throw new Error(`connect ENOENT ${leakedPath}`); },
      });
      expect(result.wake_state).toBe("adapter_failure");
      expect(JSON.stringify(result)).not.toContain(leakedPath);
      expect(result.delivery.error_message).toBe("Session ingress transport failed; the durable pointer remains available.");
    } finally {
      opened.db.close();
    }
  });
});
