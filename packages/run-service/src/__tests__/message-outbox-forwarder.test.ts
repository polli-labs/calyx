import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CALYX_HTTP_DEFAULT_JSON_RESPONSE_MAX_BYTES,
  applyStateMigrations,
  claimMessageOutboxAttempt,
  createMessage,
  enqueueMessageOutbox,
  expireMessageOutbox,
  openStateStore,
  readMessage,
  readMessageOutbox,
  setMessageReceiptPath,
  type MessageRow,
} from "@polli-labs/calyx-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MessageOutboxForwarder } from "../message-outbox-forwarder.js";
import { RunService } from "./support/test-run-service.js";
import type { DeliveryV1Fetch } from "../delivery.js";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;

function acceptedMessageResponse(message: MessageRow): Awaited<ReturnType<DeliveryV1Fetch>> {
  const receiverMessage: MessageRow = {
    ...message,
    status: "pending",
    payload: {
      ...message.payload,
      remote_sender_receipt_path: message.receipt_path,
      remote_sender_spooled_at: message.spooled_at,
    },
  };
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      schema_version: "calyx.msg-receive/v1",
      inserted: true,
      message: receiverMessage,
      escalation: {
        mode: "pointer_only",
        reason: "execution_requires_control_plane_authority",
      },
    }),
  };
}

describe("MessageOutboxForwarder", () => {
  let root: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of ENV_KEYS) delete process.env[key];
    root = await mkdtemp(join(tmpdir(), "calyx-message-outbox-"));
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

  test("drains pending outbox rows through the target daemon route", async () => {
    const opened = await openStateStore();
    try {
      createMessage(opened.db, {
        message_id: "msg_forward_1",
        sender: "interactive:codex:sender",
        recipient_address: "interactive:codex:target",
        recipient_class: "directed",
        recipient_host: "remote",
        subject: "baton",
        status: "outbox",
        now: "2026-06-12T00:00:00.000Z",
      });
      setMessageReceiptPath(opened.db, "msg_forward_1", "/tmp/sender-state/receipts/messages.jsonl");
      enqueueMessageOutbox(opened.db, {
        message_id: "msg_forward_1",
        target_host: "remote",
        now: "2026-06-12T00:00:00.000Z",
      });
    } finally {
      opened.db.close();
    }

    const requests: Array<{ url: string; authorization?: string; body: unknown }> = [];
    const fetchImpl: DeliveryV1Fetch = async (url, init) => {
      requests.push({
        url,
        ...(init.headers?.["authorization"] ? { authorization: init.headers["authorization"] } : {}),
        body: init.body ? JSON.parse(init.body) as unknown : null,
      });
      const body = JSON.parse(init.body!) as { message: MessageRow };
      return acceptedMessageResponse(body.message);
    };
    const forwarder = new MessageOutboxForwarder({
      enabled: true,
      fetch: fetchImpl,
      serverUrlForHost: (host) => `http://${host}:8740`,
      tokenForHost: () => "token-1",
      now: () => "2026-06-12T00:00:05.000Z",
    });

    const result = await forwarder.drainOnce();
    expect(result).toEqual({ expired: 0, scanned: 1, forwarded: 1, failed: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "http://remote:8740/v1/internal/messages/receive",
      authorization: "Bearer token-1",
    });
    expect(requests[0]?.body).toMatchObject({
      schema_version: "calyx.msg-send/v1",
      message: {
        message_id: "msg_forward_1",
        status: "pending",
        spooled_at: "2026-06-12T00:00:00.000Z",
        delivered_at: null,
        receipt_path: "/tmp/sender-state/receipts/messages.jsonl",
      },
    });

    const after = await openStateStore();
    try {
      const outbox = after.db
        .prepare(`SELECT status, forwarded_at FROM outbox WHERE message_id = 'msg_forward_1'`)
        .get() as { status: string; forwarded_at: string | null } | undefined;
      expect(outbox).toEqual({
        status: "forwarded",
        forwarded_at: "2026-06-12T00:00:05.000Z",
      });
      expect(readMessage(after.db, "msg_forward_1")?.delivered_at).toBe("2026-06-12T00:00:05.000Z");
      expect(after.db.prepare(
        `SELECT adapter, status, delivered_at FROM message_deliveries WHERE message_id = ?`,
      ).get("msg_forward_1")).toEqual({
        adapter: "daemon_outbox",
        status: "delivered",
        delivered_at: "2026-06-12T00:00:05.000Z",
      });
    } finally {
      after.db.close();
    }
  });

  test("expiry cannot publish delivery_failed while a target acceptance is in flight", async () => {
    const opened = await openStateStore();
    try {
      createMessage(opened.db, {
        message_id: "msg_expiry_acceptance_race",
        sender: "client:sender@blade",
        recipient_address: "client:target@remote",
        recipient_class: "directed",
        recipient_host: "remote",
        subject: "target acceptance wins",
        status: "outbox",
        now: "2026-07-14T04:00:00.000Z",
      });
      enqueueMessageOutbox(opened.db, {
        message_id: "msg_expiry_acceptance_race",
        target_host: "remote",
        expires_at: "2026-07-14T04:00:06.000Z",
        now: "2026-07-14T04:00:00.000Z",
      });
    } finally {
      opened.db.close();
    }

    const fetchImpl: DeliveryV1Fetch = async (_url, init) => {
      const concurrent = await openStateStore();
      try {
        expect(expireMessageOutbox(concurrent.db, {
          now: "2026-07-14T04:00:07.000Z",
        })).toEqual([]);
        expect(concurrent.db.prepare(
          `SELECT status, attempt_id
           FROM outbox
           WHERE message_id = 'msg_expiry_acceptance_race'`,
        ).get()).toEqual({ status: "in_flight", attempt_id: expect.any(String) });
      } finally {
        concurrent.db.close();
      }
      const body = JSON.parse(init.body!) as { message: MessageRow };
      return acceptedMessageResponse(body.message);
    };
    const forwarder = new MessageOutboxForwarder({
      enabled: true,
      fetch: fetchImpl,
      serverUrlForHost: (host) => `http://${host}:8740`,
      tokenForHost: () => "token-1",
      now: () => "2026-07-14T04:00:05.000Z",
    });

    await expect(forwarder.drainOnce()).resolves.toEqual({
      expired: 0,
      scanned: 1,
      forwarded: 1,
      failed: 0,
    });
    const after = await openStateStore();
    try {
      expect(after.db.prepare(
        `SELECT status, forwarded_at, last_error_code
         FROM outbox
         WHERE message_id = 'msg_expiry_acceptance_race'`,
      ).get()).toEqual({
        status: "forwarded",
        forwarded_at: "2026-07-14T04:00:05.000Z",
        last_error_code: null,
      });
      expect(after.db.prepare(
        `SELECT status FROM messages WHERE message_id = 'msg_expiry_acceptance_race'`,
      ).get()).toEqual({ status: "outbox" });
    } finally {
      after.db.close();
    }
  });

  test("a 500 received after forwarding TTL remains indeterminate", async () => {
    const opened = await openStateStore();
    try {
      createMessage(opened.db, {
        message_id: "msg_server_error_unknown",
        sender: "client:sender@blade",
        recipient_address: "client:target@remote",
        recipient_class: "directed",
        recipient_host: "remote",
        subject: "server error cannot disprove acceptance",
        status: "outbox",
        now: "2026-07-14T04:30:00.000Z",
      });
      enqueueMessageOutbox(opened.db, {
        message_id: "msg_server_error_unknown",
        target_host: "remote",
        expires_at: "2026-07-14T04:30:06.000Z",
        now: "2026-07-14T04:30:00.000Z",
      });
    } finally {
      opened.db.close();
    }

    const times = [
      "2026-07-14T04:30:05.000Z",
      "2026-07-14T04:30:05.000Z",
      "2026-07-14T04:30:07.000Z",
    ];
    const forwarder = new MessageOutboxForwarder({
      enabled: true,
      fetch: async () => ({
        ok: false,
        status: 500,
        text: async () => "proxy failed after upstream acceptance",
      }),
      serverUrlForHost: (host) => `http://${host}:8740`,
      tokenForHost: () => "token-1",
      now: () => times.shift()!,
    });

    await expect(forwarder.drainOnce()).resolves.toEqual({
      expired: 0,
      scanned: 1,
      forwarded: 0,
      failed: 1,
    });
    const after = await openStateStore();
    try {
      expect(after.db.prepare(
        `SELECT status, last_error_code
         FROM outbox WHERE message_id = 'msg_server_error_unknown'`,
      ).get()).toEqual({ status: "indeterminate", last_error_code: "http_500" });
      expect(after.db.prepare(
        `SELECT status, dead_letter
         FROM messages WHERE message_id = 'msg_server_error_unknown'`,
      ).get()).toEqual({ status: "outbox", dead_letter: 0 });
      expect(expireMessageOutbox(after.db, { now: "2026-07-14T04:31:00.000Z" })).toEqual([]);
    } finally {
      after.db.close();
    }
  });

  test("an explicit 4xx rejection remains retryable and can expire definitively", async () => {
    const opened = await openStateStore();
    try {
      createMessage(opened.db, {
        message_id: "msg_client_rejection",
        sender: "client:sender@blade",
        recipient_address: "client:target@remote",
        recipient_class: "directed",
        recipient_host: "remote",
        subject: "explicit rejection is definitive",
        status: "outbox",
        now: "2026-07-14T04:45:00.000Z",
      });
      enqueueMessageOutbox(opened.db, {
        message_id: "msg_client_rejection",
        target_host: "remote",
        expires_at: "2026-07-14T04:45:06.000Z",
        now: "2026-07-14T04:45:00.000Z",
      });
    } finally {
      opened.db.close();
    }

    const times = [
      "2026-07-14T04:45:05.000Z",
      "2026-07-14T04:45:05.000Z",
      "2026-07-14T04:45:07.000Z",
    ];
    const forwarder = new MessageOutboxForwarder({
      enabled: true,
      fetch: async () => ({
        ok: false,
        status: 409,
        text: async () => "request rejected before acceptance",
      }),
      serverUrlForHost: (host) => `http://${host}:8740`,
      tokenForHost: () => "token-1",
      now: () => times.shift()!,
    });

    await expect(forwarder.drainOnce()).resolves.toMatchObject({
      expired: 0,
      scanned: 1,
      forwarded: 0,
      failed: 1,
    });
    const after = await openStateStore();
    try {
      expect(after.db.prepare(
        `SELECT status, last_error_code
         FROM outbox WHERE message_id = 'msg_client_rejection'`,
      ).get()).toEqual({ status: "pending", last_error_code: "http_409" });
      expect(expireMessageOutbox(after.db, {
        now: "2026-07-14T04:45:07.000Z",
      })).toEqual([
        expect.objectContaining({ status: "delivery_failed", last_error_code: "outbox_expired" }),
      ]);
      expect(after.db.prepare(
        `SELECT status, dead_letter, dead_letter_reason
         FROM messages WHERE message_id = 'msg_client_rejection'`,
      ).get()).toEqual({
        status: "delivery_failed",
        dead_letter: 1,
        dead_letter_reason: "outbox_expired",
      });
    } finally {
      after.db.close();
    }
  });

  test("an unknown target host cannot reach URL resolution or a token-bearing fetch", async () => {
    const opened = await openStateStore();
    try {
      createMessage(opened.db, {
        message_id: "msg_unknown_target",
        sender: "client:switchboard@blade",
        recipient_address: "role:reviewer@attacker.example",
        recipient_class: "directed",
        recipient_host: "attacker.example",
        subject: "must remain inert",
        status: "outbox",
        now: "2026-07-14T00:00:00.000Z",
      });
      enqueueMessageOutbox(opened.db, {
        message_id: "msg_unknown_target",
        target_host: "attacker.example",
        now: "2026-07-14T00:00:00.000Z",
      });
    } finally {
      opened.db.close();
    }

    const fetchImpl = vi.fn<DeliveryV1Fetch>();
    const serverUrlForHost = vi.fn(() => "https://attacker.example:8740");
    const tokenForHost = vi.fn((host: string) => host === "worm" ? "daemon-token" : undefined);
    const forwarder = new MessageOutboxForwarder({
      enabled: true,
      fetch: fetchImpl,
      serverUrlForHost,
      tokenForHost,
      now: () => "2026-07-14T00:00:05.000Z",
    });

    await expect(forwarder.drainOnce()).resolves.toEqual({
      expired: 0,
      scanned: 1,
      forwarded: 0,
      failed: 1,
    });
    expect(tokenForHost).toHaveBeenCalledWith("attacker.example");
    expect(serverUrlForHost).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    const after = await openStateStore();
    try {
      const outbox = after.db.prepare(
        "SELECT status, last_error_code FROM outbox WHERE message_id = 'msg_unknown_target'",
      ).get() as { status: string; last_error_code: string | null };
      expect(outbox).toEqual({ status: "pending", last_error_code: "auth_token_missing" });
    } finally {
      after.db.close();
    }
  });

  test("a malformed or mismatched 2xx acknowledgement cannot terminalize forwarding", async () => {
    for (const [messageId, mutateAcknowledgement] of [
      ["msg_ack_malformed", (acknowledgement: Record<string, unknown>) => JSON.stringify({
        ...acknowledgement,
        inserted: "not-a-boolean",
      })],
      ["msg_ack_mismatch", (acknowledgement: Record<string, unknown>) => JSON.stringify({
        ...acknowledgement,
        message: {
          ...(acknowledgement["message"] as MessageRow),
          subject: "different immutable message",
        },
      })],
      ["msg_ack_duplicate", (acknowledgement: Record<string, unknown>) => JSON.stringify(acknowledgement)
        .replace('"inserted":true', '"inserted":true,"inserted":false')],
    ] as const) {
      const opened = await openStateStore();
      try {
        createMessage(opened.db, {
          message_id: messageId,
          sender: "client:switchboard@blade",
          recipient_address: "role:reviewer@worm",
          recipient_class: "directed",
          recipient_host: "worm",
          subject: "require typed target acceptance",
          status: "outbox",
          now: "2026-07-14T05:00:00.000Z",
        });
        enqueueMessageOutbox(opened.db, {
          message_id: messageId,
          target_host: "worm",
          now: "2026-07-14T05:00:00.000Z",
        });
      } finally {
        opened.db.close();
      }

      const forwarder = new MessageOutboxForwarder({
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body!) as { message: MessageRow };
          const acknowledgement = {
            schema_version: "calyx.msg-receive/v1",
            inserted: true,
            message: body.message,
            escalation: {
              mode: "pointer_only",
              reason: "execution_requires_control_plane_authority",
            },
          };
          return {
            ok: true,
            status: 200,
            text: async () => mutateAcknowledgement(acknowledgement),
          };
        },
        serverUrlForHost: (host) => `https://${host}:8740`,
        tokenForHost: () => "daemon-token",
        now: () => "2026-07-14T05:00:05.000Z",
      });
      await expect(forwarder.drainOnce()).resolves.toMatchObject({ forwarded: 0, failed: 1 });

      const after = await openStateStore();
      try {
        expect(after.db.prepare(
          `SELECT status, acceptance_ambiguous, last_error_code
           FROM outbox WHERE message_id = ?`,
        ).get(messageId)).toEqual({
          status: "pending",
          acceptance_ambiguous: 1,
          last_error_code: "invalid_target_acknowledgement",
        });
      } finally {
        after.db.close();
      }
    }
  });

  test("same-major additive acknowledgement fields preserve accepted delivery identity", async () => {
    const messageId = "msg_ack_additive_same_major";
    const opened = await openStateStore();
    try {
      createMessage(opened.db, {
        message_id: messageId,
        sender: "client:switchboard@blade",
        recipient_address: "role:reviewer@worm",
        recipient_class: "directed",
        recipient_host: "worm",
        subject: "accept additive response observations",
        status: "outbox",
        created_provenance: {
          schema_version: "calyx.provenance/v1",
          request_id: "req_00000000-0000-4000-8000-000000000001",
          subject: "switchboard",
          asserted_actor: "operator:caleb",
          host: "blade",
          via: "http",
          at: "2026-07-14T05:15:00.000Z",
        },
        now: "2026-07-14T05:15:00.000Z",
      });
      enqueueMessageOutbox(opened.db, {
        message_id: messageId,
        target_host: "worm",
        now: "2026-07-14T05:15:00.000Z",
      });
    } finally {
      opened.db.close();
    }

    const forwarder = new MessageOutboxForwarder({
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body!) as { message: MessageRow };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            schema_version: "calyx.msg-receive/v1",
            inserted: true,
            message: {
              ...body.message,
              status: "receiver_archived_in_v1_1",
              created_provenance: {
                ...body.message.created_provenance,
                receiver_observation: { version: "N+1" },
              },
              receiver_observation: { version: "N+1" },
            },
            escalation: {
              mode: "pointer_only",
              reason: "execution_requires_control_plane_authority",
              receiver_observation: { version: "N+1" },
            },
            receiver_observation: { version: "N+1" },
          }),
        };
      },
      serverUrlForHost: (host) => `https://${host}:8740`,
      tokenForHost: () => "daemon-token",
      now: () => "2026-07-14T05:15:05.000Z",
    });
    await expect(forwarder.drainOnce()).resolves.toMatchObject({ forwarded: 1, failed: 0 });

    const after = await openStateStore();
    try {
      expect(after.db.prepare(
        "SELECT status, acceptance_ambiguous, last_error_code FROM outbox WHERE message_id = ?",
      ).get(messageId)).toEqual({
        status: "forwarded",
        acceptance_ambiguous: 0,
        last_error_code: null,
      });
    } finally {
      after.db.close();
    }
  });

  test("rejects removed execution-shaped acknowledgement variants", async () => {
    for (const [messageId, escalation] of [
      ["msg_ack_legacy_pointer", {
        mode: "pointer_only",
        source_run_id: "run-legacy-pointer",
        reason: "run_not_resumable_by_calyx",
      }],
      ["msg_ack_legacy_resume", {
        mode: "run_resume",
        source_run_id: "run-legacy-source",
        resume_session_id: "session-legacy-source",
        delivery_id: "delivery-legacy-source",
        turn_run_id: "run-legacy-turn",
        acked: true,
        state: "queued",
      }],
    ] as const) {
      const opened = await openStateStore();
      try {
        createMessage(opened.db, {
          message_id: messageId,
          sender: "client:switchboard@blade",
          recipient_address: "role:reviewer@worm",
          recipient_class: "directed",
          recipient_host: "worm",
          subject: "accept legacy receipt observation",
          status: "outbox",
          now: "2026-07-14T05:30:00.000Z",
        });
        enqueueMessageOutbox(opened.db, {
          message_id: messageId,
          target_host: "worm",
          now: "2026-07-14T05:30:00.000Z",
        });
      } finally {
        opened.db.close();
      }

      const forwarder = new MessageOutboxForwarder({
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body!) as { message: MessageRow };
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              schema_version: "calyx.msg-receive/v1",
              inserted: true,
              message: body.message,
              escalation,
            }),
          };
        },
        serverUrlForHost: (host) => `https://${host}:8740`,
        tokenForHost: () => "daemon-token",
        now: () => "2026-07-14T05:30:05.000Z",
      });
      await expect(forwarder.drainOnce()).resolves.toMatchObject({ forwarded: 0, failed: 1 });

      const after = await openStateStore();
      try {
        expect(after.db.prepare(
          `SELECT status, acceptance_ambiguous, last_error_code
           FROM outbox WHERE message_id = ?`,
        ).get(messageId)).toEqual({
          status: "pending",
          acceptance_ambiguous: 1,
          last_error_code: "invalid_target_acknowledgement",
        });
      } finally {
        after.db.close();
      }
    }
  });

  test("resamples the claim clock so a delayed first row cannot send an expired sibling", async () => {
    const opened = await openStateStore();
    try {
      for (const [messageId, createdAt, expiresAt] of [
        ["msg_clock_first", "2026-07-14T06:00:00.000Z", "2026-07-14T07:00:00.000Z"],
        ["msg_clock_expired_sibling", "2026-07-14T06:00:01.000Z", "2026-07-14T06:00:15.000Z"],
      ] as const) {
        createMessage(opened.db, {
          message_id: messageId,
          sender: "client:switchboard@blade",
          recipient_address: "role:reviewer@worm",
          recipient_class: "directed",
          recipient_host: "worm",
          subject: "fresh claim clock",
          status: "outbox",
          now: createdAt,
        });
        enqueueMessageOutbox(opened.db, {
          message_id: messageId,
          target_host: "worm",
          now: createdAt,
          expires_at: expiresAt,
        });
      }
    } finally {
      opened.db.close();
    }

    const times = [
      "2026-07-14T06:00:02.000Z",
      "2026-07-14T06:00:02.000Z",
      "2026-07-14T06:00:20.000Z",
      "2026-07-14T06:00:20.000Z",
    ];
    const sent: string[] = [];
    const forwarder = new MessageOutboxForwarder({
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body!) as { message: MessageRow };
        sent.push(body.message.message_id);
        return acceptedMessageResponse(body.message);
      },
      serverUrlForHost: (host) => `https://${host}:8740`,
      tokenForHost: () => "daemon-token",
      now: () => times.shift()!,
    });

    await expect(forwarder.drainOnce()).resolves.toEqual({
      expired: 0,
      scanned: 2,
      forwarded: 1,
      failed: 1,
    });
    expect(sent).toEqual(["msg_clock_first"]);
    const after = await openStateStore();
    try {
      expect(after.db.prepare(
        `SELECT status, forwarded_at FROM outbox WHERE message_id = 'msg_clock_first'`,
      ).get()).toEqual({ status: "forwarded", forwarded_at: "2026-07-14T06:00:20.000Z" });
      expect(after.db.prepare(
        `SELECT status, attempt_count FROM outbox WHERE message_id = 'msg_clock_expired_sibling'`,
      ).get()).toEqual({ status: "pending", attempt_count: 0 });
    } finally {
      after.db.close();
    }
  });

  test("a persisted target URL cannot redirect a configured host bearer", async () => {
    const opened = await openStateStore();
    try {
      createMessage(opened.db, {
        message_id: "msg_persisted_url_override",
        sender: "client:switchboard@blade",
        recipient_address: "role:reviewer@worm",
        recipient_class: "directed",
        recipient_host: "worm",
        subject: "use configured transport truth",
        status: "outbox",
        now: "2026-07-14T00:00:00.000Z",
      });
      const outbox = enqueueMessageOutbox(opened.db, {
        message_id: "msg_persisted_url_override",
        target_host: "worm",
        now: "2026-07-14T00:00:00.000Z",
      });
      opened.db.prepare("UPDATE outbox SET target_url = ? WHERE outbox_id = ?")
        .run("https://attacker.example:8740", outbox.outbox_id);
    } finally {
      opened.db.close();
    }

    const fetchImpl = vi.fn<DeliveryV1Fetch>(async (_url, init) => {
      const body = JSON.parse(init.body!) as { message: MessageRow };
      return acceptedMessageResponse(body.message);
    });
    const serverUrlForHost = vi.fn((host: string) => `https://${host}.internal.example:8740`);
    const tokenForHost = vi.fn((host: string) => host === "worm" ? "daemon-token" : undefined);
    const forwarder = new MessageOutboxForwarder({
      enabled: true,
      fetch: fetchImpl,
      serverUrlForHost,
      tokenForHost,
      now: () => "2026-07-14T00:00:05.000Z",
    });

    await expect(forwarder.drainOnce()).resolves.toEqual({
      expired: 0,
      scanned: 1,
      forwarded: 1,
      failed: 0,
    });
    expect(serverUrlForHost).toHaveBeenCalledWith("worm");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://worm.internal.example:8740/v1/internal/messages/receive",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer daemon-token" }),
      }),
    );
    expect(fetchImpl.mock.calls.some(([url]) => url.includes("attacker.example"))).toBe(false);
  });

  test("RunService forwards one admitted outbox through the resident forwarder and preserves its configured base path", async () => {
    let outboxId = "";
    const opened = await openStateStore();
    try {
      createMessage(opened.db, {
        message_id: "msg_source_daemon_forward",
        sender: "client:operator_cli@blade",
        recipient_address: "role:reviewer@worm",
        recipient_class: "directed",
        recipient_host: "worm",
        subject: "source daemon owns forwarding",
        status: "outbox",
        now: "2026-07-20T00:00:00.000Z",
      });
      outboxId = enqueueMessageOutbox(opened.db, {
        message_id: "msg_source_daemon_forward",
        target_host: "worm",
        now: "2026-07-20T00:00:00.000Z",
      }).outbox_id;
    } finally {
      opened.db.close();
    }

    const fetchImpl = vi.fn<DeliveryV1Fetch>(async (_url, init) => {
      const body = JSON.parse(init.body!) as { message: MessageRow };
      return acceptedMessageResponse(body.message);
    });
    const service = new RunService({
      messageOutbox: {
        enabled: true,
        fetch: fetchImpl,
        serverUrlForHost: () => "https://worm.internal.example:8740/calyx/control/",
        tokenForHost: () => "daemon-token",
        now: () => "2026-07-20T00:00:05.000Z",
      },
    });

    await expect(service.forwardMessageOutbox(outboxId)).resolves.toMatchObject({
      accepted: true,
      outbox: { outbox_id: outboxId, status: "forwarded" },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://worm.internal.example:8740/calyx/control/v1/internal/messages/receive",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer daemon-token" }),
      }),
    );
  });

  test("reports an unavailable resident schema before attempting message delivery", async () => {
    const state = {
      env: {
        ...process.env,
        CALYX_STATE_DB: join(root, "unmigrated", "state.sqlite"),
      },
    };
    const fetchImpl = vi.fn<DeliveryV1Fetch>();
    const forwarder = new MessageOutboxForwarder({
      state,
      fetch: fetchImpl,
      serverUrlForHost: () => "https://worm.internal.example:8740",
      tokenForHost: () => "daemon-token",
    });

    await expect(forwarder.forwardOutbox("outbox-missing")).resolves.toEqual({
      status: "schema_unavailable",
      accepted: false,
    });
    await expect(forwarder.observeOutbox("outbox-missing")).resolves.toEqual({
      status: "schema_unavailable",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("does not recover unrelated expired attempts while forwarding one selected outbox", async () => {
    const opened = await openStateStore();
    let unrelatedOutboxId = "";
    try {
      createMessage(opened.db, {
        message_id: "msg_unrelated_expired_attempt",
        sender: "client:operator_cli@blade",
        recipient_address: "role:reviewer@worm",
        recipient_class: "directed",
        recipient_host: "worm",
        subject: "preserve unrelated attempt ownership",
        status: "outbox",
        now: "2026-07-20T00:00:00.000Z",
      });
      unrelatedOutboxId = enqueueMessageOutbox(opened.db, {
        message_id: "msg_unrelated_expired_attempt",
        target_host: "worm",
        expires_at: "2026-07-20T00:10:00.000Z",
        now: "2026-07-20T00:00:00.000Z",
      }).outbox_id;
      expect(claimMessageOutboxAttempt(opened.db, unrelatedOutboxId, {
        attempt_id: "attempt-unrelated",
        attempt_ttl_ms: 1_000,
        now: "2026-07-20T00:00:01.000Z",
      })).toMatchObject({ status: "in_flight" });
    } finally {
      opened.db.close();
    }
    const fetchImpl = vi.fn<DeliveryV1Fetch>();
    const forwarder = new MessageOutboxForwarder({
      fetch: fetchImpl,
      serverUrlForHost: () => "https://worm.internal.example:8740",
      tokenForHost: () => "daemon-token",
      now: () => "2026-07-20T00:00:05.000Z",
    });

    await expect(forwarder.forwardOutbox("outbox-does-not-exist")).resolves.toEqual({
      status: "not_found",
      accepted: false,
    });
    const after = await openStateStore();
    try {
      expect(readMessageOutbox(after.db, unrelatedOutboxId)).toMatchObject({
        status: "in_flight",
        attempt_id: "attempt-unrelated",
        attempt_expires_at: "2026-07-20T00:00:02.000Z",
      });
    } finally {
      after.db.close();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    ["userinfo", "https://operator@worm.internal.example:8740/calyx"],
    ["query", "https://worm.internal.example:8740/calyx?target=other"],
    ["fragment", "https://worm.internal.example:8740/calyx#other"],
  ] as const)("rejects configured target %s before transmitting its resolved bearer", async (label, baseUrl) => {
    let outboxId = "";
    const opened = await openStateStore();
    try {
      createMessage(opened.db, {
        message_id: `msg_invalid_target_${label}`,
        sender: "client:operator_cli@blade",
        recipient_address: "role:reviewer@worm",
        recipient_class: "directed",
        recipient_host: "worm",
        subject: "reject invalid configured endpoint",
        status: "outbox",
        now: "2026-07-20T00:00:00.000Z",
      });
      outboxId = enqueueMessageOutbox(opened.db, {
        message_id: `msg_invalid_target_${label}`,
        target_host: "worm",
        now: "2026-07-20T00:00:00.000Z",
      }).outbox_id;
    } finally {
      opened.db.close();
    }
    const tokenForHost = vi.fn(() => "must-not-resolve");
    const fetchImpl = vi.fn<DeliveryV1Fetch>();
    const forwarder = new MessageOutboxForwarder({
      fetch: fetchImpl,
      serverUrlForHost: () => baseUrl,
      tokenForHost,
      now: () => "2026-07-20T00:00:05.000Z",
    });

    await expect(forwarder.forwardOutbox(outboxId)).resolves.toMatchObject({
      accepted: false,
      outbox: { outbox_id: outboxId, status: "pending", last_error_code: "daemon_unreachable" },
    });
    expect(tokenForHost).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(["redirect", "oversized-chunked"] as const)(
    "fails closed on a %s internal receive response without forwarding the outbox row",
    async (responseKind) => {
      const opened = await openStateStore();
      try {
        createMessage(opened.db, {
          message_id: `msg_internal_transport_${responseKind}`,
          sender: "client:switchboard@blade",
          recipient_address: "role:reviewer@worm",
          recipient_class: "directed",
          recipient_host: "worm",
          subject: "keep bearer and response bytes bounded",
          status: "outbox",
          now: "2026-07-15T00:00:00.000Z",
        });
        enqueueMessageOutbox(opened.db, {
          message_id: `msg_internal_transport_${responseKind}`,
          target_host: "worm",
          now: "2026-07-15T00:00:00.000Z",
        });
      } finally {
        opened.db.close();
      }

      const cancel = vi.fn();
      const fetchImpl = vi.fn<DeliveryV1Fetch>(async (_url, init) => {
        expect(init.redirect).toBe("manual");
        if (responseKind === "redirect") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/v1/internal/messages/receive" },
          });
        }
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(CALYX_HTTP_DEFAULT_JSON_RESPONSE_MAX_BYTES + 1));
          },
          cancel,
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
          },
        });
      });
      const forwarder = new MessageOutboxForwarder({
        enabled: true,
        fetch: fetchImpl,
        serverUrlForHost: () => "https://worm.internal.example:8740",
        tokenForHost: () => "daemon-token",
        now: () => "2026-07-15T00:00:05.000Z",
      });

      await expect(forwarder.drainOnce()).resolves.toEqual({
        expired: 0,
        scanned: 1,
        forwarded: 0,
        failed: 1,
      });
      if (responseKind === "oversized-chunked") expect(cancel).toHaveBeenCalledTimes(1);
      const after = await openStateStore();
      try {
        expect(after.db.prepare(
          "SELECT status, last_error_code FROM outbox WHERE message_id = ?",
        ).get(`msg_internal_transport_${responseKind}`)).toMatchObject({
          status: "pending",
          last_error_code: "daemon_unreachable",
        });
      } finally {
        after.db.close();
      }
    },
  );
});
