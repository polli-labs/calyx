import { createHmac } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import {
  adminOperationRoutes,
  bufferVerifiedBinary,
  createCalyxAdminClient,
} from "../admin.js";
import {
  CalyxClientConfigurationError,
  consumerOperationRoutes,
  createCalyxClient,
} from "../consumer.js";
import type { CalyxIndeterminateReceipt } from "../errors.js";
import { operationPlans as adminOperationPlans } from "../generated/admin/serializers.js";
import { createCalyxEventStream, type CalyxEventStream } from "../sse.js";
import { CalyxTransport, generatedCodec as g } from "../transport.js";
import type { OperationPlan } from "../transport.js";

const requestHeaders = {
  "content-type": "application/json",
  "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000001",
};
const recoveryReceiptIntegrityKey = Uint8Array.from({ length: 32 }, (_value, index) => index);
const TOPOLOGY_PROJECTION_SHA256 = "a".repeat(64);
const fixtureBearerTokenContract = {
  encoding: "ascii",
  max_bytes: 4_096,
  pattern: "^[\\x21-\\x2B\\x2D-\\x7E]+$",
} as const;

function signRecoveryReceipt(
  receipt: Omit<CalyxIndeterminateReceipt, "integrity_algorithm" | "integrity_tag">,
): CalyxIndeterminateReceipt {
  const payload = JSON.stringify([
    "calyx.client-recovery-receipt-integrity/v1",
    receipt.schema_version,
    receipt.payload_sensitivity,
    receipt.credential_binding,
    receipt.contract_digest,
    receipt.operation_id,
    receipt.method,
    receipt.origin,
    receipt.base_path,
    receipt.path,
    Object.entries(receipt.safe_headers).sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
    receipt.body_bytes,
    receipt.idempotency_key,
    receipt.attempts,
    receipt.failure_stage,
    receipt.last_http_status ?? null,
    receipt.last_request_id ?? null,
  ]);
  return {
    ...receipt,
    integrity_algorithm: "HMAC-SHA-256",
    integrity_tag: createHmac("sha256", recoveryReceiptIntegrityKey).update(payload, "utf8").digest("base64url"),
  };
}

function resignRecoveryReceipt(receipt: CalyxIndeterminateReceipt): CalyxIndeterminateReceipt {
  const unsigned = Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== "integrity_algorithm" && key !== "integrity_tag"),
  ) as Omit<CalyxIndeterminateReceipt, "integrity_algorithm" | "integrity_tag">;
  return signRecoveryReceipt(unsigned);
}

function doctorBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "calyx.message-doctor/v1",
    subject: "switchboard",
    schema_status: "ok",
    counts: { total: 0, open: 0, pending: 0, claimed: 0, acked: 0, dead_letter: 0, delivery_failed: 0 },
    receipt_mirrors: { pending: 0, completed: 0 },
    ...overrides,
  };
}

function observationEvent(cursor: string): Record<string, unknown> {
  return {
    schema_version: "calyx.run-observation-event/v1",
    cursor,
    event_type: "run.progress",
    emitted_at: "2026-07-14T00:00:00.000Z",
    run: {
      schema_version: "calyx.run-observation/v1",
      run_id: "run:fixture",
      short_id: "fixture",
      host: "blade",
      backend: "codex",
      status: "running",
      health: "healthy",
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z",
      kind: "run",
    },
  };
}

function activityObservationBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: "calyx.activity-observation-list/v1",
    count: 1,
    truncated: false,
    activities: [{
      schema_version: "calyx.run-observation/v1",
      kind: "interactive",
      run_id: "interactive:codex:session-attention",
      short_id: "session-atte",
      host: "blade",
      backend: "codex",
      status: "interactive",
      health: "unknown",
      created_at: "2026-07-31T00:00:00.000Z",
      updated_at: "2026-07-31T00:01:00.000Z",
      attention_state: "awaiting",
      repo_ref: "calyx",
      worktree_ref: "feature-a",
      latest_visible_message_excerpt: "Ready for operator review.",
      visible_message_count: 2,
      ...overrides,
    }],
  };
}

function messageObservation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "calyx.message-observation/v1",
    message_id: "msg-fixture",
    sender: "client:switchboard@blade",
    recipient_address: "client:switchboard@blade",
    recipient_class: "directed",
    subject: "fixture",
    body: "body",
    body_truncated: false,
    body_total_chars: 4,
    body_locator: "/v1/message-text/msg-fixture",
    urgency: "normal",
    ack_required: false,
    status: "pending",
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

function messageSendBody(idempotencyKey: string): Record<string, unknown> {
  return {
    schema_version: "calyx.msg-send/v1",
    idempotency_key: idempotencyKey,
    recipient_address: "client:switchboard@carbon",
    reply_address: "client:switchboard@blade",
    subject: "hello",
    body: "body",
  };
}

const markId = "mark_123e4567-e89b-42d3-a456-426614174000";

function markProvenance(requestId: string, at: string): Record<string, unknown> {
  return {
    schema_version: "calyx.provenance/v1",
    request_id: requestId,
    subject: "switchboard",
    asserted_actor: "operator:caleb",
    host: "blade",
    via: "http",
    at,
  };
}

function markRevocationBody(): Record<string, unknown> {
  return {
    schema_version: "calyx.activity-mark-revocation/v1",
    mark_id: markId,
    marked_by: "switchboard",
    target_kind: "activity",
    target_id: "interactive:codex:fixture",
    kind: "high_signal",
    reason: "Decision boundary.",
    marked_at: "2026-07-21T00:00:00.000Z",
    created_provenance: markProvenance(
      "req_123e4567-e89b-42d3-a456-426614174000",
      "2026-07-21T00:00:00.000Z",
    ),
    revoked_at: "2026-07-21T00:01:00.000Z",
    revoked_provenance: markProvenance(
      "req_123e4567-e89b-42d3-a456-426614174001",
      "2026-07-21T00:01:00.000Z",
    ),
  };
}

function withOptionalSuccessHeader(plan: OperationPlan): OperationPlan {
  return {
    ...plan,
    success: plan.success.map((success) => ({
      ...success,
      headerDecoders: {
        ...success.headerDecoders,
        "x-optional-proof": (value) => value === "safe",
      },
    })),
  };
}

describe("generated Calyx client", () => {
  test("enforces bounded retry options for untyped JavaScript callers", () => {
    const invalid = [Number.POSITIVE_INFINITY, Number.NaN, -1, 1.5, 60_000];
    for (const value of invalid) {
      expect(() => createCalyxClient({
        baseUrl: "https://blade.example",
        bearerToken: "token",
        retry: { maxAttempts: value } as never,
      })).toThrow(CalyxClientConfigurationError);
      expect(() => createCalyxClient({
        baseUrl: "https://blade.example",
        bearerToken: "token",
        retry: { recoveryAttempts: value } as never,
      })).toThrow(CalyxClientConfigurationError);
      expect(() => createCalyxClient({
        baseUrl: "https://blade.example",
        bearerToken: "token",
        retry: { sseReconnectAttempts: value } as never,
      })).toThrow(CalyxClientConfigurationError);
    }
    expect(() => createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      retry: { maxAttempts: 0 } as never,
    })).toThrow(CalyxClientConfigurationError);
    expect(() => createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      retry: { recoveryAttempts: 0 } as never,
    })).toThrow(CalyxClientConfigurationError);
    expect(() => createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      retry: { maxAttempts: 1, recoveryAttempts: 3, sseReconnectAttempts: 0 },
    })).not.toThrow();
  });

  test("requires explicit encrypted custody before accepting a recovery store", () => {
    expect(() => createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      recoveryStore: { save: () => undefined } as never,
    })).toThrow(/encrypted_access_controlled custody/u);
    expect(() => createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      recoveryStore: {
        custody: "encrypted_access_controlled",
        reserve: () => undefined,
        save: () => undefined,
        release: () => undefined,
      },
    })).toThrow(/requires a protected recoveryReceiptIntegrityKey/u);
    expect(() => createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      recoveryReceiptIntegrityKey,
      recoveryStore: { custody: "encrypted_access_controlled", save: () => undefined } as never,
    })).toThrow(/implement reserve, save, and release/u);
    for (const length of [0, 16, 31, 33, 64]) {
      expect(() => createCalyxClient({
        baseUrl: "https://blade.example",
        bearerToken: "token",
        recoveryReceiptIntegrityKey: new Uint8Array(length),
      })).toThrow(/exactly 32 bytes/u);
    }
  });

  test("separates consumer and explicit privileged roots", () => {
    const consumer = createCalyxClient({ baseUrl: "https://blade.example", bearerToken: "consumer-token" });
    const admin = createCalyxAdminClient({ baseUrl: "https://blade.example", bearerToken: "admin-token" });

    expect(Object.keys(consumer.consumer).sort()).toEqual(["activity", "attention", "lease", "monitor", "msg", "work"]);
    expect("admin" in consumer).toBe(false);
    expect(Object.keys(admin)).toEqual(["consumer", "admin", "replayIndeterminate"]);
    expect(consumer.consumer.attention.mark.create).toBeTypeOf("function");
    expect(consumer.consumer.attention.mark.list).toBeTypeOf("function");
    expect(consumer.consumer.attention.mark.revoke).toBeTypeOf("function");
    expect(admin.consumer.attention.mark.create).toBeTypeOf("function");
    expect(admin.consumer.attention.mark.list).toBeTypeOf("function");
    expect(admin.consumer.attention.mark.revoke).toBeTypeOf("function");
    expect(admin.admin).not.toHaveProperty("attention");
    expect(admin.admin.run).toHaveProperty("reconcilePreserving");
    expect(admin.admin.run).not.toHaveProperty("reconcile");
    expect(admin.admin.monitor.claim).toBeTypeOf("function");
    expect(admin.admin.sessionWake.deliver).toBeTypeOf("function");
  });

  test("preserves proxy base paths and encodes a path value as exactly one segment", async () => {
    const messageId = "../%2f/雪😀";
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      schema_version: "calyx.message-text/v1",
      message_id: "m1",
      text: "hello",
      text_cursor: { total_chars: 5, returned: [0, 5] },
      additive_future_field: true,
    }), { status: 200, headers: requestHeaders }));
    const client = createCalyxClient({
      baseUrl: "https://blade.example/reverse/proxy/",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    const result = await client.consumer.msg.text({
      path: { messageId },
      query: { from: "0" },
    });

    expect(result.ok).toBe(true);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      `https://blade.example/reverse/proxy${consumerOperationRoutes.msg.text({ messageId })}?from=0`,
    );
    expect(consumerOperationRoutes.msg.text({ messageId })).toBe(
      "/v1/message-text/%2E%2E%2F%252f%2F%E9%9B%AA%F0%9F%98%80",
    );
  });

  test("derives durable receipt locators and requests from one generated route contract", async () => {
    const operationId = "self-upgrade.receipt-01";
    const receipt = {
      schema_version: "self-upgrade-receipt/v1",
      operation_id: operationId,
      fleet_operation_id: "fleet-current-test",
      host: "blade",
      target_ref: "origin/main",
      target_evidence: {
        original_ref: "origin/main",
        target_sha: "b".repeat(40),
        fetch_remote: "origin",
        fetch_ref: "main",
      },
      status: "succeeded",
      started_at: "2026-07-23T08:00:00.000Z",
      completed_at: "2026-07-23T08:01:00.000Z",
      repo_root: "/srv/blade/calyx",
      before_head: "a".repeat(40),
      after_head: "b".repeat(40),
      commit_list: [],
      before_builds: [],
      after_builds: [],
      active_run_classification: [],
      drain_mode: "drain",
      readopted_run_ids: [],
      drain_duration_ms: 1_000,
      daemons_restarted: [],
      warnings: [],
    };
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify(receipt),
      { status: 200, headers: requestHeaders },
    ));
    const client = createCalyxAdminClient({
      baseUrl: "https://blade.example/calyx/control/",
      bearerToken: "admin-token",
      fetch: fetchImplementation,
    });
    const route = adminOperationRoutes.selfUpgrade.receipt({ operationId });

    const result = await client.admin.selfUpgrade.receipt({ path: { operationId } });

    expect(result).toMatchObject({ ok: true, data: receipt });
    expect(route).toBe("/v1/admin/self-upgrade-receipts/self-upgrade%2Ereceipt-01");
    expect(fetchImplementation).toHaveBeenCalledWith(
      `https://blade.example/calyx/control${route}`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(() => adminOperationRoutes.selfUpgrade.receipt({ operationId: "receipt/escape" }))
      .toThrow(CalyxClientConfigurationError);
    await expect(client.admin.selfUpgrade.receipt({ path: { operationId: "receipt/escape" } }))
      .rejects.toThrow(CalyxClientConfigurationError);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  test("freezes every generated route namespace and leaf and exposes readonly leaf properties", () => {
    const assertDeepFrozen = (value: object, label: string): void => {
      expect(Object.isFrozen(value), label).toBe(true);
      for (const [name, child] of Object.entries(value)) {
        if ((typeof child === "object" && child !== null) || typeof child === "function") {
          assertDeepFrozen(child as object, `${label}.${name}`);
        }
      }
    };

    assertDeepFrozen(consumerOperationRoutes, "consumerOperationRoutes");
    assertDeepFrozen(adminOperationRoutes, "adminOperationRoutes");
    expect(() => {
      (adminOperationRoutes.selfUpgrade as { receipt: () => string }).receipt = () => "/mutated";
    }).toThrow(TypeError);
    const assertReadonlyLeafType = (): void => {
      // @ts-expect-error Generated route leaves are readonly function properties.
      adminOperationRoutes.selfUpgrade.receipt = () => "/mutated";
    };
    void assertReadonlyLeafType;
  });

  test("rejects an oversized encoded route before both locator projection and request dispatch", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = createCalyxClient({
      baseUrl: "https://blade.example/calyx/control/",
      bearerToken: "consumer-token",
      fetch: fetchImplementation,
    });
    const runId = "😀".repeat(2_000);

    expect(() => consumerOperationRoutes.work.get({ runId }))
      .toThrowError("Encoded operation route exceeds 8000 bytes.");
    await expect(client.consumer.work.get({ path: { runId } }))
      .rejects.toThrowError("Encoded operation route exceeds 8000 bytes.");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  test("rejects pure dot path segments before credentials or fetch", async () => {
    const tokenProvider = vi.fn(() => "token");
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = createCalyxClient({
      baseUrl: "https://blade.example/proxy",
      bearerToken: tokenProvider,
      fetch: fetchImplementation,
    });

    for (const messageId of [".", ".."]) {
      await expect(client.consumer.msg.text({ path: { messageId } })).rejects.toBeInstanceOf(CalyxClientConfigurationError);
    }
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  test("rejects lone UTF-16 surrogates before credentials or fetch", async () => {
    const tokenProvider = vi.fn(() => "token");
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = createCalyxClient({
      baseUrl: "https://blade.example/proxy",
      bearerToken: tokenProvider,
      fetch: fetchImplementation,
    });

    for (const messageId of ["\ud800", "\udc00"]) {
      await expect(client.consumer.msg.text({ path: { messageId } }))
        .rejects.toBeInstanceOf(CalyxClientConfigurationError);
    }
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  test("rejects an oversized composed request target before credentials or fetch", async () => {
    const tokenProvider = vi.fn(() => "token");
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = createCalyxClient({
      baseUrl: "https://blade.example/proxy",
      bearerToken: tokenProvider,
      fetch: fetchImplementation,
    });
    const messageId = "😀".repeat(665);
    expect(Buffer.byteLength(`/v1/message-text/${encodeURIComponent(messageId)}`)).toBeLessThanOrEqual(8_000);
    expect(Buffer.byteLength(`/proxy/v1/message-text/${encodeURIComponent(messageId)}`)).toBeGreaterThan(8_000);

    await expect(client.consumer.msg.text({
      path: { messageId },
    })).rejects.toThrow(/request target exceeds 8000 bytes/u);
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  test("accepts the exact 8000-byte composed request-target boundary", async () => {
    const fixedTarget = "/proxy/v1/message-text/";
    const remaining = 8000 - Buffer.byteLength(fixedTarget);
    const emojiCount = Math.floor(remaining / 12);
    const messageId = `${"😀".repeat(emojiCount)}${"x".repeat(remaining - (emojiCount * 12))}`;
    expect(Buffer.byteLength(`${fixedTarget}${encodeURIComponent(messageId)}`)).toBe(8000);
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      schema_version: "calyx.message-text/v1",
      message_id: messageId,
      text: "",
      text_cursor: { total_chars: 0, returned: [0, 0] },
    }), { status: 200, headers: requestHeaders }));
    const client = createCalyxClient({
      baseUrl: "https://blade.example/proxy",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    await expect(client.consumer.msg.text({ path: { messageId } })).resolves.toMatchObject({ ok: true });
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(`https://blade.example${fixedTarget}${encodeURIComponent(messageId)}`);
  });

  test("enforces the generated bearer-token language before the ambiguity boundary", async () => {
    for (const token of ["", " ", "token ", "token,other", "😀", "line\nbreak", "x".repeat(4_097)]) {
      const fetchImplementation = vi.fn<typeof fetch>();
      const client = createCalyxClient({
        baseUrl: "https://blade.example",
        bearerToken: token,
        fetch: fetchImplementation,
      });
      await expect(client.consumer.msg.doctor()).rejects.toThrow(CalyxClientConfigurationError);
      expect(fetchImplementation).not.toHaveBeenCalled();
    }

    const maximum = "x".repeat(4_096);
    const authorization = new Headers({ Authorization: `Bearer ${maximum}` }).get("authorization");
    expect(authorization).toBe(`Bearer ${maximum}`);
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${maximum}`);
      return new Response(JSON.stringify(doctorBody()), { status: 200, headers: requestHeaders });
    });
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: maximum,
      fetch: fetchImplementation,
    });
    await expect(client.consumer.msg.doctor()).resolves.toMatchObject({ ok: true });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  test("rejects redirects and never forwards the bearer to their target", async () => {
    const cancel = vi.fn();
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status: 307,
      headers: { location: "https://attacker.example/steal", "x-calyx-request-id": "attacker-controlled" },
    }));
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "secret-token",
      fetch: fetchImplementation,
    });

    const result = await client.consumer.msg.doctor();

    expect(result).toMatchObject({ ok: false, kind: "protocol", stage: "redirect_refused" });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("attacker-controlled");
  });

  test("does not preserve an invalid redirect request ID across keyed-write recovery", async () => {
    const cancel = vi.fn();
    const tokenProvider = vi.fn()
      .mockReturnValueOnce("token")
      .mockImplementation(() => { throw new Error("credential backend unavailable"); });
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(
      new ReadableStream<Uint8Array>({ cancel }),
      {
        status: 307,
        headers: {
          location: "https://attacker.example/steal",
          "x-calyx-request-id": "attacker-controlled",
        },
      },
    ));
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: tokenProvider,
      fetch: fetchImplementation,
    });

    const result = await client.consumer.msg.send({
      body: {
        schema_version: "calyx.msg-send/v1",
        idempotency_key: "redirect-request-id",
        recipient_address: "client:switchboard@carbon",
        reply_address: "client:switchboard@blade",
        subject: "hello",
        body: "body",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      kind: "indeterminate",
      attempts: 3,
      receipt: { failure_stage: "redirect_refused" },
    });
    expect(result).not.toHaveProperty("requestId");
    expect(result).not.toHaveProperty("receipt.last_http_status");
    expect(result).not.toHaveProperty("receipt.last_request_id");
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(tokenProvider).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain("attacker-controlled");
  });

  test("cancels every rejected initial response body before returning protocol failure", async () => {
    const cancellations = [vi.fn(), vi.fn(), vi.fn()];
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel: cancellations[0]! }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel: cancellations[1]! }), {
        status: 200,
        headers: { ...requestHeaders, "content-type": "text/plain" },
      }))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel: cancellations[2]! }), {
        status: 401,
        headers: requestHeaders,
      }));
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    await expect(client.consumer.msg.doctor()).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "missing_required_header",
    });
    await expect(client.consumer.msg.doctor()).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "unexpected_media_type",
    });
    await expect(client.consumer.msg.doctor()).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "missing_required_header",
    });
    for (const cancel of cancellations) expect(cancel).toHaveBeenCalledOnce();
  });

  test("accepts one syntactically valid response media type with compatible parameters", async () => {
    const vendorMediaType = "application/vnd.polli.calyx.run-launch-receipt+json;version=1";
    for (const [expectedMediaType, actualMediaType] of [
      ["application/json", "Application/JSON; charset=UTF-8"],
      [vendorMediaType, 'Application/Vnd.Polli.Calyx.Run-Launch-Receipt+Json ; charset="utf-8" ; VERSION="1"'],
      [vendorMediaType, 'application/vnd.polli.calyx.run-launch-receipt+json;version=1;profile="release,fixture"'],
      [`${vendorMediaType};charset=UTF-8`, 'application/vnd.polli.calyx.run-launch-receipt+json;CHARSET="utf-8";version="1"'],
    ] as const) {
      const base = adminOperationPlans["msg.doctor"];
      const plan: OperationPlan = {
        ...base,
        success: base.success.map((success) => ({ ...success, mediaType: expectedMediaType })),
      };
      const transport = new CalyxTransport(
        {
          baseUrl: "https://blade.example",
          bearerToken: "token",
          fetch: async () => new Response(JSON.stringify(doctorBody()), {
            status: 200,
            headers: { ...requestHeaders, "content-type": actualMediaType },
          }),
        },
        { [plan.operationId]: plan },
        fixtureBearerTokenContract,
      );

      await expect(transport.execute("admin", plan, {})).resolves.toMatchObject({ ok: true });
    }
  });

  test("fails closed on combined or syntactically invalid response media types", async () => {
    const vendorMediaType = "application/vnd.polli.calyx.run-launch-receipt+json;version=1";
    for (const [expectedMediaType, actualMediaType] of [
      ["application/json", "application/json, text/plain"],
      ["application/json", 'application/json;profile="unterminated'],
      ["application/json", 'application/json;profile="dangling\\'],
      ["application/json", "application/json;charset=utf-8;CHARSET=UTF-8"],
      ["application/json", "application/json;charset"],
      ["application/json", "application/json;charset="],
      ["application/json", 'application/json;charset="utf-8"junk'],
      ["application/json", "application/json;charset=ut f-8"],
      ["application/json", "application/json;"],
      ["application/json", "application/json;;charset=utf-8"],
      ["application/json", "application /json"],
      [vendorMediaType, "application/vnd.polli.calyx.run-launch-receipt+json"],
      [vendorMediaType, "application/vnd.polli.calyx.run-launch-receipt+json;version=2"],
      [vendorMediaType, "application/vnd.polli.calyx.run-launch-receipt+json;version=1;VERSION=1"],
    ] as const) {
      const base = adminOperationPlans["msg.doctor"];
      const plan: OperationPlan = {
        ...base,
        success: base.success.map((success) => ({ ...success, mediaType: expectedMediaType })),
      };
      const transport = new CalyxTransport(
        {
          baseUrl: "https://blade.example",
          bearerToken: "token",
          fetch: async () => new Response(JSON.stringify(doctorBody()), {
            status: 200,
            headers: { ...requestHeaders, "content-type": actualMediaType },
          }),
        },
        { [plan.operationId]: plan },
        fixtureBearerTokenContract,
      );

      await expect(transport.execute("admin", plan, {})).resolves.toMatchObject({
        ok: false,
        kind: "protocol",
        stage: "unexpected_media_type",
      });
    }
  });

  test("preserves bounded raw bodies and only redaction-safe response headers on protocol failures", async () => {
    const completeBytes = new Uint8Array(2_200).fill(0x61);
    completeBytes[2_047] = 0xf0;
    completeBytes[2_048] = 0x28;
    const nonClosingCancel = vi.fn();
    const nonClosingBytes = new TextEncoder().encode(`<html>${"x".repeat(3_000)}</html>`);
    const partialBytes = new TextEncoder().encode("partial-json-evidence");
    let partialSent = false;
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(completeBytes, {
        status: 200,
        headers: {
          ...requestHeaders,
          "content-length": String(completeBytes.byteLength),
          "retry-after": "5",
          server: "fixture-proxy/1",
          via: "1.1 fixture-edge",
          "x-request-id": "edge-request-1",
          authorization: "Bearer response-secret",
          "set-cookie": "session=response-cookie",
          "www-authenticate": 'Bearer realm="secret-realm"',
          location: "https://example.invalid/?token=redirect-secret",
          "x-private-debug": "private-header-secret",
        },
      }))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(nonClosingBytes);
        },
        cancel: nonClosingCancel,
      }), {
        status: 200,
        headers: { ...requestHeaders, "content-type": "text/html", server: "fixture-proxy/2" },
      }))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!partialSent) {
            partialSent = true;
            controller.enqueue(partialBytes);
            return;
          }
          controller.error(new Error("fixture interrupted response body"));
        },
      }), { status: 200, headers: requestHeaders }));
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "transport-secret",
      fetch: fetchImplementation,
      retry: { maxAttempts: 1 },
    });

    const complete = await client.consumer.msg.doctor();
    expect(complete).toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "invalid_utf8",
      rawBodySnippet: new TextDecoder().decode(completeBytes.slice(0, 2_048)),
      rawBodyBytes: completeBytes.byteLength,
      rawBodyComplete: true,
      responseHeaders: {
        "content-type": "application/json",
        "content-length": String(completeBytes.byteLength),
        "retry-after": "5",
        server: "fixture-proxy/1",
        via: "1.1 fixture-edge",
        "x-request-id": "edge-request-1",
        "x-calyx-request-id": requestHeaders["x-calyx-request-id"],
      },
    });
    if (complete.ok || complete.kind !== "protocol") throw new Error("Expected protocol wire evidence fixture.");
    expect(Object.isFrozen(complete.responseHeaders)).toBe(true);
    expect(JSON.stringify(complete)).not.toMatch(
      /transport-secret|response-secret|response-cookie|secret-realm|redirect-secret|private-header-secret/u,
    );

    const nonClosing = await client.consumer.msg.doctor();
    expect(nonClosing).toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "unexpected_media_type",
      rawBodySnippet: new TextDecoder().decode(nonClosingBytes.slice(0, 2_048)),
      rawBodyBytes: nonClosingBytes.byteLength,
      rawBodyComplete: false,
      responseHeaders: {
        "content-type": "text/html",
        server: "fixture-proxy/2",
        "x-calyx-request-id": requestHeaders["x-calyx-request-id"],
      },
    });
    expect(nonClosingCancel).toHaveBeenCalledOnce();

    const interrupted = await client.consumer.msg.doctor();
    expect(interrupted).toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "invalid_response",
      rawBodySnippet: "partial-json-evidence",
      rawBodyBytes: partialBytes.byteLength,
      rawBodyComplete: false,
    });
  });

  test("accepts additive response fields and open enum values but rejects unknown schema majors", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(doctorBody({ additive_field: "safe" })), {
        status: 200,
        headers: requestHeaders,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(doctorBody({ schema_version: "calyx.message-doctor/v2" })), {
        status: 200,
        headers: requestHeaders,
      }));
    const client = createCalyxClient({ baseUrl: "https://blade.example", bearerToken: "token", fetch: fetchImplementation });

    await expect(client.consumer.msg.doctor()).resolves.toMatchObject({ ok: true });
    await expect(client.consumer.msg.doctor()).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "schema_major_mismatch",
    });
  });

  test("rejects duplicate JSON members before returning typed data", async () => {
    const body = JSON.stringify(doctorBody()).replace(
      '"schema_version":"calyx.message-doctor/v1"',
      '"schema_version":"calyx.message-doctor/v1","schema_version":"calyx.message-doctor/v1"',
    );
    const split = body.indexOf("schema_version", body.indexOf("schema_version") + 1) + 4;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(body.slice(0, split)));
        controller.enqueue(encoder.encode(body.slice(split)));
        controller.close();
      },
    });
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: async () => new Response(stream, { status: 200, headers: requestHeaders }),
    });

    await expect(client.consumer.msg.doctor()).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "duplicate_json_member",
    });
  });

  test("yields across fragmented JSON byte quanta and preserves split UTF-8", async () => {
    const quantum = 256 * 1024;
    const chunkSize = 16 * 1024;
    const marker = "__SCAN_BOUNDARY__";
    const encoder = new TextEncoder();
    const template = JSON.stringify(doctorBody({ additive_padding: marker }));
    const markerOffset = template.indexOf(marker);
    expect(markerOffset).toBeGreaterThan(0);
    const prefixBytes = encoder.encode(template.slice(0, markerOffset)).byteLength;
    const padding = `${"x".repeat(quantum - prefixBytes - 1)}💚${"x".repeat(chunkSize)}`;
    const body = template.replace(marker, padding);
    const emojiOffset = body.indexOf("💚");
    expect(encoder.encode(body.slice(0, emojiOffset)).byteLength).toBe(quantum - 1);
    const encoded = encoder.encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < encoded.byteLength; offset += chunkSize) {
          controller.enqueue(encoded.slice(offset, offset + chunkSize));
        }
        controller.close();
      },
    });
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: async () => new Response(stream, { status: 200, headers: requestHeaders }),
    });

    let eventLoopTurnObserved = false;
    const sentinel = setImmediate(() => {
      eventLoopTurnObserved = true;
    });
    try {
      await expect(client.consumer.msg.doctor()).resolves.toMatchObject({ ok: true });
      expect(eventLoopTurnObserved).toBe(true);
    } finally {
      clearImmediate(sentinel);
    }
  });

  test("keeps yielding after an early duplicate JSON member is already known", async () => {
    const chunkSize = 16 * 1024;
    const encoded = new TextEncoder().encode(
      `{"duplicate":1,"duplicate":2,"padding":"${"x".repeat((256 * 1024) + chunkSize)}"}`,
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < encoded.byteLength; offset += chunkSize) {
          controller.enqueue(encoded.slice(offset, offset + chunkSize));
        }
        controller.close();
      },
    });
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: async () => new Response(stream, { status: 200, headers: requestHeaders }),
    });

    let eventLoopTurnObserved = false;
    const sentinel = setImmediate(() => {
      eventLoopTurnObserved = true;
    });
    try {
      await expect(client.consumer.msg.doctor()).resolves.toMatchObject({
        ok: false,
        kind: "protocol",
        stage: "duplicate_json_member",
      });
      expect(eventLoopTurnObserved).toBe(true);
    } finally {
      clearImmediate(sentinel);
    }
  });

  test("rejects fatal UTF-8 and wrong closed response discriminants", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new Uint8Array([0xff]), { status: 200, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response(JSON.stringify(doctorBody({ schema_status: "future" })), {
        status: 200,
        headers: requestHeaders,
      }));
    const client = createCalyxClient({ baseUrl: "https://blade.example", bearerToken: "token", fetch: fetchImplementation });

    await expect(client.consumer.msg.doctor()).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "invalid_utf8",
    });
    await expect(client.consumer.msg.doctor()).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "invalid_response",
    });
  });

  test("ordinary retry requires a valid retryable error envelope", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { schema_version: "calyx.error/v1", code: "future_busy", message: "busy", retryable: true },
      }), { status: 503, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response(JSON.stringify(doctorBody()), { status: 200, headers: requestHeaders }));
    const client = createCalyxClient({ baseUrl: "https://blade.example", bearerToken: "token", fetch: fetchImplementation });

    await expect(client.consumer.msg.doctor()).resolves.toMatchObject({ ok: true, attempts: 2 });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  test("does not let an async token provider rotate principals inside one retry operation", async () => {
    const tokenProvider = vi.fn()
      .mockReturnValueOnce("subject-a-token")
      .mockReturnValueOnce("subject-b-token");
    const authorization: Array<string | null> = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      authorization.push(new Headers(init?.headers).get("authorization"));
      if (authorization.length === 1) throw new Error("fixture ambiguous pre-header loss");
      return new Response(JSON.stringify(doctorBody()), { status: 200, headers: requestHeaders });
    });
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: tokenProvider,
      fetch: fetchImplementation,
    });

    await expect(client.consumer.msg.doctor()).resolves.toMatchObject({ ok: true, attempts: 2 });
    expect(tokenProvider).toHaveBeenCalledOnce();
    expect(authorization).toEqual(["Bearer subject-a-token", "Bearer subject-a-token"]);
  });

  test("lets abort win over stalled credential resolution for JSON and initial SSE calls", async () => {
    const jsonAbort = new AbortController();
    const jsonFetch = vi.fn<typeof fetch>();
    const jsonProvider = vi.fn((_signal?: AbortSignal) => new Promise<string>(() => undefined));
    const jsonClient = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: jsonProvider,
      fetch: jsonFetch,
    });
    const jsonResult = jsonClient.consumer.msg.doctor({ signal: jsonAbort.signal });
    await Promise.resolve();
    jsonAbort.abort();
    await expect(jsonResult).resolves.toMatchObject({
      ok: false,
      kind: "transport",
      stage: "aborted",
      attempts: 1,
    });
    expect(jsonProvider).toHaveBeenCalledWith(jsonAbort.signal);
    expect(jsonFetch).not.toHaveBeenCalled();

    const sseAbort = new AbortController();
    const sseFetch = vi.fn<typeof fetch>();
    const sseProvider = vi.fn((_signal?: AbortSignal) => new Promise<string>(() => undefined));
    const sseClient = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: sseProvider,
      fetch: sseFetch,
    });
    const sseResult = sseClient.consumer.work.observe({ signal: sseAbort.signal });
    await Promise.resolve();
    sseAbort.abort();
    await expect(sseResult).resolves.toMatchObject({
      ok: false,
      kind: "transport",
      stage: "aborted",
      attempts: 1,
    });
    expect(sseProvider).toHaveBeenCalledWith(sseAbort.signal);
    expect(sseFetch).not.toHaveBeenCalled();
  });

  test("preserves keyed-write indeterminacy for undeclared generated error pairs", async () => {
    const futureFailure = (retryable?: boolean): Response => new Response(JSON.stringify({
      error: {
        schema_version: "calyx.error/v1",
        code: "future_admission_state",
        message: "rolling daemon result",
        ...(retryable === undefined ? {} : { retryable }),
      },
    }), { status: 418, headers: requestHeaders });
    const sendRequest = (idempotencyKey: string) => ({
      body: {
        schema_version: "calyx.msg-send/v1" as const,
        idempotency_key: idempotencyKey,
        recipient_address: "client:switchboard@carbon",
        reply_address: "client:switchboard@blade",
        subject: "hello",
        body: "body",
      },
    });
    const ambiguousFetch = vi.fn<typeof fetch>(async () => futureFailure());
    const ambiguous = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: ambiguousFetch,
    });

    await expect(ambiguous.consumer.msg.send(sendRequest(
      "future-error-without-terminal-authority",
    ))).resolves.toMatchObject({
      ok: false,
      kind: "indeterminate",
      attempts: 3,
      receipt: { last_http_status: 418 },
    });
    expect(ambiguousFetch).toHaveBeenCalledTimes(3);

    const knownFailure = (): Response => new Response(JSON.stringify({
      error: {
        schema_version: "calyx.error/v1",
        code: "invalid_request",
        message: "known but cannot disprove the earlier admission",
        retryable: false,
      },
    }), { status: 400, headers: requestHeaders });
    const knownAfterUnknownFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(futureFailure(true))
      .mockImplementation(async () => knownFailure());
    const knownAfterUnknown = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: knownAfterUnknownFetch,
    });
    await expect(knownAfterUnknown.consumer.msg.send(sendRequest(
      "future-retryable-then-known",
    ))).resolves.toMatchObject({
      ok: false,
      kind: "indeterminate",
      attempts: 3,
      receipt: { failure_stage: "api_during_recovery", last_http_status: 400 },
    });
    expect(knownAfterUnknownFetch).toHaveBeenCalledTimes(3);

    const tokenProvider = vi.fn()
      .mockReturnValueOnce("token")
      .mockImplementation(() => { throw new Error("fixture token loss"); });
    const tokenAfterUnknownFetch = vi.fn<typeof fetch>(async () => futureFailure(true));
    const tokenAfterUnknown = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: tokenProvider,
      fetch: tokenAfterUnknownFetch,
    });
    await expect(tokenAfterUnknown.consumer.msg.send(sendRequest(
      "future-retryable-then-token-loss",
    ))).resolves.toMatchObject({
      ok: false,
      kind: "indeterminate",
      attempts: 3,
      receipt: { failure_stage: "invalid_response", last_http_status: 418 },
    });
    expect(tokenProvider).toHaveBeenCalledOnce();
    expect(tokenAfterUnknownFetch).toHaveBeenCalledTimes(3);

    const controller = new AbortController();
    const abortAfterUnknownFetch = vi.fn<typeof fetch>(async () => {
      controller.abort();
      return futureFailure(true);
    });
    const abortAfterUnknown = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: abortAfterUnknownFetch,
    });
    await expect(abortAfterUnknown.consumer.msg.send({
      ...sendRequest("future-retryable-then-abort"),
      signal: controller.signal,
    })).resolves.toMatchObject({
      ok: false,
      kind: "indeterminate",
      attempts: 3,
      receipt: { failure_stage: "invalid_response", last_http_status: 418 },
    });
    expect(abortAfterUnknownFetch).toHaveBeenCalledTimes(3);

    const inFlightAbortController = new AbortController();
    const inFlightAbortFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(futureFailure(true))
      .mockImplementationOnce(async () => {
        inFlightAbortController.abort();
        throw new Error("fixture in-flight abort");
      });
    const inFlightAbort = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: inFlightAbortFetch,
    });
    await expect(inFlightAbort.consumer.msg.send({
      body: messageSendBody("future-retryable-then-in-flight-abort") as never,
      signal: inFlightAbortController.signal,
    })).resolves.toMatchObject({
      ok: false,
      kind: "indeterminate",
      attempts: 2,
      requestId: requestHeaders["x-calyx-request-id"],
      receipt: {
        failure_stage: "aborted",
        last_http_status: 418,
        last_request_id: requestHeaders["x-calyx-request-id"],
      },
    });

    const networkAfterUnknownFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(futureFailure(true))
      .mockRejectedValue(new Error("fixture network loss"));
    const networkAfterUnknown = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: networkAfterUnknownFetch,
      retry: { maxAttempts: 2, recoveryAttempts: 1 },
    });
    await expect(networkAfterUnknown.consumer.msg.send({
      body: messageSendBody("future-retryable-then-network-loss") as never,
    })).resolves.toMatchObject({
      ok: false,
      kind: "indeterminate",
      attempts: 2,
      requestId: requestHeaders["x-calyx-request-id"],
      receipt: {
        failure_stage: "network",
        last_http_status: 418,
        last_request_id: requestHeaders["x-calyx-request-id"],
      },
    });

    const incompleteLaterResponses: Array<[string, () => Response]> = [
      ["redirect", () => new Response(null, { status: 307 })],
      ["missing-request-id", () => new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })],
      ["invalid-request-id", () => new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "x-calyx-request-id": "invalid" },
      })],
    ];
    for (const [label, laterResponse] of incompleteLaterResponses) {
      const stickyFetch = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(futureFailure(true))
        .mockImplementation(async () => laterResponse());
      const sticky = createCalyxClient({
        baseUrl: "https://blade.example",
        bearerToken: "token",
        fetch: stickyFetch,
        retry: { maxAttempts: 2, recoveryAttempts: 1 },
      });
      await expect(sticky.consumer.msg.send({
        body: messageSendBody(`future-retryable-then-${label}`) as never,
      })).resolves.toMatchObject({
        ok: false,
        kind: "indeterminate",
        attempts: 2,
        requestId: requestHeaders["x-calyx-request-id"],
        receipt: {
          last_http_status: 418,
          last_request_id: requestHeaders["x-calyx-request-id"],
        },
      });
    }

    const reserve = vi.fn((_receipt: CalyxIndeterminateReceipt) => undefined);
    const save = vi.fn((_receipt: CalyxIndeterminateReceipt) => undefined);
    const release = vi.fn((_receipt: CalyxIndeterminateReceipt) => undefined);
    const undeclaredDefinitiveLookingFetch = vi.fn<typeof fetch>(async () => futureFailure(false));
    const undeclaredDefinitiveLooking = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: undeclaredDefinitiveLookingFetch,
      retry: { maxAttempts: 1, recoveryAttempts: 1 },
      recoveryReceiptIntegrityKey,
      recoveryStore: {
        custody: "encrypted_access_controlled",
        reserve,
        save,
        release,
      },
    });
    await expect(undeclaredDefinitiveLooking.consumer.msg.send(sendRequest(
      "future-error-without-generated-authority",
    ))).resolves.toMatchObject({
      ok: false,
      kind: "indeterminate",
      attempts: 2,
      receipt: {
        failure_stage: "invalid_response",
        last_http_status: 418,
        last_request_id: requestHeaders["x-calyx-request-id"],
      },
    });
    expect(undeclaredDefinitiveLookingFetch).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  test("never grants terminal authority to malformed generated error envelopes", async () => {
    const malformedErrors = [
      { schema_version: "calyx.error/v1", code: "INVALID CODE", message: "bad", retryable: false },
      { schema_version: "calyx.error/v1", code: "invalid_request", message: "", retryable: false },
      {
        schema_version: "calyx.error/v1",
        code: "invalid_request",
        message: "bad details",
        details: { candidate_limit: -1 },
        retryable: false,
      },
    ];
    for (const [index, error] of malformedErrors.entries()) {
      const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error }), {
        status: 400,
        headers: requestHeaders,
      }));
      const client = createCalyxClient({
        baseUrl: "https://blade.example",
        bearerToken: "token",
        fetch: fetchImplementation,
        retry: { maxAttempts: 1, recoveryAttempts: 1 },
      });
      await expect(client.consumer.msg.send({
        body: messageSendBody(`malformed-error-${String(index)}`) as never,
      })).resolves.toMatchObject({
        ok: false,
        kind: "indeterminate",
        attempts: 2,
        receipt: { failure_stage: "invalid_error_envelope", last_http_status: 400 },
      });
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
    }
  });

  test("classifies undeclared success-class statuses before error decoding", async () => {
    const errorShaped = JSON.stringify({
      error: {
        schema_version: "calyx.error/v1",
        code: "future_result",
        message: "wrong status",
        retryable: false,
      },
    });
    const readFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(errorShaped, { status: 299, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response(JSON.stringify(doctorBody()), { status: 299, headers: requestHeaders }));
    const readClient = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: readFetch,
    });
    await expect(readClient.consumer.msg.doctor()).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "unexpected_status",
      status: 299,
    });
    await expect(readClient.consumer.msg.doctor()).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "unexpected_status",
      status: 299,
    });

    const keyedFetch = vi.fn<typeof fetch>(async () => new Response(errorShaped, {
      status: 299,
      headers: requestHeaders,
    }));
    const keyedClient = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: keyedFetch,
      retry: { maxAttempts: 1, recoveryAttempts: 1 },
    });
    await expect(keyedClient.consumer.msg.send({
      body: messageSendBody("undeclared-2xx") as never,
    })).resolves.toMatchObject({
      ok: false,
      kind: "indeterminate",
      attempts: 2,
      receipt: { failure_stage: "unexpected_status", last_http_status: 299 },
    });
  });

  test("does not grant retry authority from an undeclared idempotency-looking field", async () => {
    let sentBody = "";
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      sentBody = Buffer.from(init?.body as Uint8Array).toString("utf8");
      throw new Error("fixture network loss");
    });
    const admin = createCalyxAdminClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    const result = await admin.admin.run.stop({
      path: { runId: "run:fixture" },
      body: { reason: "fixture", idempotency_key: "not-in-contract" } as never,
    });
    expect(result).toMatchObject({
      ok: false,
      kind: "unkeyed_indeterminate",
      operationId: "admin.run.stop",
      attempts: 1,
      cause: { kind: "transport", stage: "network", attempts: 1 },
      reconciliation: {
        kind: "read_projection",
        operationIds: ["admin.run.get"],
        absence: "inconclusive",
      },
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(sentBody).toBe('{"reason":"fixture"}');
  });

  test("projects source-daemon message forwarding only on admin and reports response loss through admin.msg.operation", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      throw new Error("source daemon response lost");
    });
    const client = createCalyxAdminClient({
      baseUrl: "https://blade.example/calyx/control/",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    await expect(client.admin.msg.forward({
      path: { outboxId: "outbox-fixture" },
    })).resolves.toMatchObject({
      ok: false,
      kind: "unkeyed_indeterminate",
      operationId: "admin.msg.forward",
      attempts: 1,
      reconciliation: {
        kind: "read_projection",
        operationIds: ["admin.msg.operation"],
        absence: "inconclusive",
      },
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [requestUrl, requestInit] = fetchImplementation.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://blade.example/calyx/control/v1/admin/message-operations/outbox-fixture/forward",
    );
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.body).toBeUndefined();
    expect(adminOperationPlans["admin.msg.forward"].success).toEqual([
      expect.objectContaining({
        semantics: expect.objectContaining({
          mutation: "stateful_write",
          reconciliation_operation_ids: ["admin.msg.operation"],
        }),
      }),
    ]);
    expect(adminOperationPlans["admin.msg.operation"]).toMatchObject({
      method: "GET",
      pathTemplate: "/v1/admin/message-operations/{outboxId}",
      profile: "control_plane_admin_v1",
    });
  });

  test("classifies every post-dispatch non-authoritative unkeyed-write result as indeterminate", async () => {
    const fixtures = [
      {
        name: "invalid success",
        response: new Response('{"schema_version":"calyx.run-cancellation-result/v1"}', {
          status: 200,
          headers: requestHeaders,
        }),
        stage: "invalid_response",
      },
      {
        name: "invalid error envelope",
        response: new Response('{"error":{"message":"temporarily unavailable"}}', {
          status: 503,
          headers: requestHeaders,
        }),
        stage: "invalid_error_envelope",
      },
      {
        name: "undeclared error pair with definitive-looking retry metadata",
        response: new Response(JSON.stringify({
          error: {
            schema_version: "calyx.error/v1",
            code: "future_run_state",
            message: "rolling daemon result",
            retryable: false,
          },
        }), {
          status: 418,
          headers: requestHeaders,
        }),
        stage: "invalid_response",
      },
    ] as const;

    for (const fixture of fixtures) {
      const fetchImplementation = vi.fn<typeof fetch>(async () => fixture.response.clone());
      const admin = createCalyxAdminClient({
        baseUrl: "https://blade.example",
        bearerToken: "token",
        fetch: fetchImplementation,
      });
      await expect(admin.admin.run.stop({
        path: { runId: "run:fixture" },
        body: { reason: fixture.name },
      })).resolves.toMatchObject({
        ok: false,
        kind: "unkeyed_indeterminate",
        operationId: "admin.run.stop",
        attempts: 1,
        cause: { kind: "protocol", stage: fixture.stage, attempts: 1 },
        reconciliation: {
          kind: "read_projection",
          operationIds: ["admin.run.get"],
          absence: "inconclusive",
        },
      });
      expect(fetchImplementation, fixture.name).toHaveBeenCalledOnce();
    }
  });

  test("keeps a generated API error definitive for an unkeyed write", async () => {
    const admin = createCalyxAdminClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: async () => new Response(JSON.stringify({
        error: {
          schema_version: "calyx.error/v1",
          code: "not_found",
          message: "run is unknown",
          retryable: false,
        },
      }), { status: 404, headers: requestHeaders }),
    });

    await expect(admin.admin.run.stop({
      path: { runId: "run:fixture" },
      body: {},
    })).resolves.toMatchObject({
      ok: false,
      kind: "api",
      status: 404,
      error: { error: { code: "not_found" } },
    });
  });

  test("keeps pre-dispatch cancellation outside the unkeyed indeterminate state", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const admin = createCalyxAdminClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
    });
    const abort = new AbortController();
    abort.abort();

    await expect(admin.admin.run.stop({
      path: { runId: "run:fixture" },
      body: {},
      signal: abort.signal,
    })).resolves.toMatchObject({ ok: false, kind: "transport", stage: "aborted", attempts: 1 });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  test("binds session wake retry to its deterministic delivery identity", () => {
    expect(adminOperationPlans["admin.session-wake.deliver"].retryAuthority).toEqual({
      kind: "request_body_field",
      field: "delivery_id",
    });
    expect(adminOperationPlans["admin.session-wake.deliver"].success.every((success) => (
      success.semantics["mutation"] === "idempotent_write"
    ))).toBe(true);
  });

  test("retries the fixed naturally convergent reconciliation operation after response loss", async () => {
    const reconciled = {
      schema_version: "calyx.admin-reconcile-result/v1",
      status: "completed",
      scanned: 0,
      changed: {
        rebuilt: 0,
        repair_pending: 0,
        classified: 0,
        adopted: 0,
        skipped: 0,
        unresolved: 0,
        noncanonical_directories: 0,
      },
      unresolved: [],
      noncanonical_directories: [],
      projection: { status: "not_configured" },
      completed_at: "2026-07-15T00:00:00.000Z",
    };
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("fixture response loss after convergent reconcile"))
      .mockResolvedValueOnce(new Response(JSON.stringify(reconciled), { status: 200, headers: requestHeaders }));
    const admin = createCalyxAdminClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    await expect(admin.admin.run.reconcilePreserving()).resolves.toMatchObject({
      ok: true,
      attempts: 2,
      data: { schema_version: "calyx.admin-reconcile-result/v1", status: "completed" },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    for (const call of fetchImplementation.mock.calls) {
      expect(call[0]).toBe("https://blade.example/v1/admin/runs/reconcile-preserving/v1");
      expect(call[1]).toMatchObject({ method: "POST" });
      expect(call[1]).not.toHaveProperty("body");
    }
  });

  test("retries a request-target DELETE after response loss without creating keyed recovery custody", async () => {
    const reserve = vi.fn(() => undefined);
    const save = vi.fn(() => undefined);
    const release = vi.fn(() => undefined);
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("fixture response loss after mark revocation"))
      .mockResolvedValueOnce(new Response(JSON.stringify(markRevocationBody()), {
        status: 200,
        headers: requestHeaders,
      }));
    const client = createCalyxClient({
      baseUrl: "https://blade.example/reverse/proxy/",
      bearerToken: "token",
      fetch: fetchImplementation,
      recoveryReceiptIntegrityKey,
      recoveryStore: {
        custody: "encrypted_access_controlled",
        reserve,
        save,
        release,
      },
    });

    await expect(client.consumer.attention.mark.revoke({
      path: { markId },
      assertedActor: "operator:caleb",
    })).resolves.toMatchObject({
      ok: true,
      attempts: 2,
      data: { schema_version: "calyx.activity-mark-revocation/v1", mark_id: markId },
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    for (const [input, init] of fetchImplementation.mock.calls) {
      expect(input).toBe(`https://blade.example/reverse/proxy/v1/marks/${markId}`);
      expect(init).toMatchObject({ method: "DELETE", redirect: "manual" });
      expect(init).not.toHaveProperty("body");
      expect(new Headers(init?.headers).has("content-type")).toBe(false);
    }
    expect(reserve).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  test("rejects noncanonical activity-mark timestamps from generated response validation", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      schema_version: "calyx.activity-mark-list/v1",
      snapshot_at: "not-a-time",
      marks: [],
      truncated: false,
    }), { status: 200, headers: requestHeaders }));
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    await expect(client.consumer.attention.mark.list({ query: {} })).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "invalid_response",
      attempts: 1,
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  test("validates closed and bounded activity attention fields in the generated client", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(activityObservationBody()), {
        status: 200,
        headers: requestHeaders,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(activityObservationBody({
        attention_state: "paused",
      })), { status: 200, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response(JSON.stringify(activityObservationBody({
        repo_ref: "polli/calyx",
      })), { status: 200, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response(JSON.stringify(activityObservationBody({
        worktree_ref: "wt/feature-a",
      })), { status: 200, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response(JSON.stringify(activityObservationBody({
        latest_visible_message_excerpt: "x".repeat(321),
      })), { status: 200, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response(JSON.stringify(activityObservationBody({
        visible_message_count: -1,
      })), { status: 200, headers: requestHeaders }));
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    await expect(client.consumer.activity.list()).resolves.toMatchObject({
      ok: true,
      data: {
        activities: [{
          attention_state: "awaiting",
          repo_ref: "calyx",
          worktree_ref: "feature-a",
          latest_visible_message_excerpt: "Ready for operator review.",
          visible_message_count: 2,
        }],
      },
    });
    for (let index = 0; index < 5; index += 1) {
      await expect(client.consumer.activity.list()).resolves.toMatchObject({
        ok: false,
        kind: "protocol",
        stage: "invalid_response",
      });
    }
    expect(fetchImplementation).toHaveBeenCalledTimes(6);
  });

  test("rejects contradictory activity-mark provenance and target authority", async () => {
    const mark = markRevocationBody();
    mark.schema_version = "calyx.activity-mark/v1";
    delete mark.revoked_at;
    delete mark.revoked_provenance;
    mark.marked_by = "contradicts-provenance";
    mark.target_kind = "turn";
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      schema_version: "calyx.activity-mark-list/v1",
      snapshot_at: "2026-07-21T00:02:00.000Z",
      marks: [mark],
      truncated: false,
    }), { status: 200, headers: requestHeaders }));
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    await expect(client.consumer.attention.mark.list({ query: {} })).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "invalid_response",
      attempts: 1,
    });
  });

  test("retries an ambiguous protocol response only under generated convergence authority", async () => {
    const successfulRevocation = new Response(JSON.stringify(markRevocationBody()), {
      status: 200,
      headers: requestHeaders,
    });
    const convergentFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(markRevocationBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(successfulRevocation);
    const convergent = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: convergentFetch,
    });

    await expect(convergent.consumer.attention.mark.revoke({ path: { markId } }))
      .resolves.toMatchObject({ ok: true, attempts: 2 });
    expect(convergentFetch).toHaveBeenCalledTimes(2);

    const ordinaryFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const ordinary = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: ordinaryFetch,
    });
    await expect(ordinary.consumer.activity.list()).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "missing_required_header",
      attempts: 1,
    });
    expect(ordinaryFetch).toHaveBeenCalledOnce();
  });

  test("retries monitor claims only with the exact generated idempotency authority", async () => {
    const bodies: string[] = [];
    const claimed = {
      schema_version: "calyx.monitor-inbox/v1",
      owner_host: "blade",
      count: 0,
      wakes: [],
      delivery_state: {
        count: 0,
        counts: { attempted: 0, delivered: 0, failed: 0 },
        deliveries: [],
        failures: [],
      },
    };
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(Buffer.from(init?.body as Uint8Array).toString("utf8"));
      if (bodies.length === 1) throw new Error("fixture response loss after committed monitor claim");
      return new Response(JSON.stringify(claimed), { status: 200, headers: requestHeaders });
    });
    const admin = createCalyxAdminClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    await expect(admin.admin.monitor.claim({ body: {
      idempotency_key: "monitor-claim-generated-retry",
      claimed_by: "operator",
      limit: 10,
    } })).resolves.toMatchObject({ ok: true, attempts: 2, data: claimed });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[0]!)).toEqual({
      claimed_by: "operator",
      idempotency_key: "monitor-claim-generated-retry",
      limit: 10,
    });
  });

  test("spends operation identity on every indeterminate post-header reconciliation result", async () => {
    const reconciled = {
      schema_version: "calyx.admin-reconcile-result/v1",
      status: "completed",
      scanned: 0,
      changed: {
        rebuilt: 0,
        repair_pending: 0,
        classified: 0,
        adopted: 0,
        skipped: 0,
        unresolved: 0,
        noncanonical_directories: 0,
      },
      unresolved: [],
      noncanonical_directories: [],
      projection: { status: "not_configured" },
      completed_at: "2026-07-15T00:00:00.000Z",
    };
    const json = JSON.stringify(reconciled);
    const interrupted = (): Response => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(json.slice(0, 12)));
        controller.error(new Error("fixture interrupted body"));
      },
    }), { status: 200, headers: requestHeaders });
    const cases: Array<[string, () => Response]> = [
      ["redirect", () => new Response(null, { status: 307, headers: { ...requestHeaders, location: "https://other.example/" } })],
      ["missing request id", () => new Response(json, { status: 200, headers: { "content-type": "application/json" } })],
      ["invalid request id", () => new Response(json, { status: 200, headers: { ...requestHeaders, "x-calyx-request-id": "invalid" } })],
      ["undeclared success", () => new Response(json, { status: 299, headers: requestHeaders })],
      ["wrong media", () => new Response(json, { status: 200, headers: { ...requestHeaders, "content-type": "text/plain" } })],
      ["empty body", () => new Response("", { status: 200, headers: requestHeaders })],
      ["malformed body", () => new Response("{malformed", { status: 200, headers: requestHeaders })],
      ["schema-invalid body", () => new Response('{"schema_version":"calyx.admin-reconcile-result/v1"}', { status: 200, headers: requestHeaders })],
      ["interrupted body", interrupted],
      ["malformed error envelope", () => new Response("{malformed", { status: 500, headers: requestHeaders })],
      ["missing required error header", () => new Response(JSON.stringify({
        error: { schema_version: "calyx.error/v1", code: "unauthorized", message: "fixture" },
      }), { status: 401, headers: requestHeaders })],
    ];

    for (const [label, firstResponse] of cases) {
      const fetchImplementation = vi.fn<typeof fetch>()
        .mockImplementationOnce(async () => firstResponse())
        .mockResolvedValueOnce(new Response(json, { status: 200, headers: requestHeaders }));
      const admin = createCalyxAdminClient({
        baseUrl: "https://blade.example",
        bearerToken: "token",
        fetch: fetchImplementation,
      });
      await expect(admin.admin.run.reconcilePreserving(), label).resolves.toMatchObject({
        ok: true,
        attempts: 2,
        data: { status: "completed" },
      });
      expect(fetchImplementation, label).toHaveBeenCalledTimes(2);
    }
  });

  test("does not spend operation identity on a definitive generated API failure", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: {
        schema_version: "calyx.error/v1",
        code: "invalid_request",
        message: "fixture definitive rejection",
      },
    }), { status: 400, headers: requestHeaders }));
    const admin = createCalyxAdminClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    await expect(admin.admin.run.reconcilePreserving()).resolves.toMatchObject({
      ok: false,
      kind: "api",
      status: 400,
      attempts: 1,
      error: { error: { code: "invalid_request" } },
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  test("keeps known and future error codes as API failures but rejects malformed envelopes and missing error headers", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { schema_version: "calyx.error/v1", code: "future_error", message: "future" },
      }), { status: 418, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { schema_version: "calyx.error/v1", code: 42, message: "malformed" },
      }), { status: 400, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { schema_version: "calyx.error/v1", code: "busy", message: "malformed", retryable: "yes" },
      }), { status: 503, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { schema_version: "calyx.error/v1", code: "unauthorized", message: "known" },
      }), { status: 401, headers: requestHeaders }));
    const client = createCalyxClient({ baseUrl: "https://blade.example", bearerToken: "token", fetch: fetchImplementation });

    await expect(client.consumer.msg.doctor()).resolves.toMatchObject({
      ok: false,
      kind: "api",
      status: 418,
      error: { error: { code: "future_error" } },
    });
    await expect(client.consumer.msg.doctor()).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "invalid_error_envelope",
    });
    await expect(client.consumer.msg.doctor()).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "invalid_error_envelope",
    });
    await expect(client.consumer.msg.doctor()).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "missing_required_header",
    });
  });

  test("validates non-success response headers against their generated schemas", async () => {
    const unauthorized = JSON.stringify({
      error: { schema_version: "calyx.error/v1", code: "unauthorized", message: "unauthorized" },
    });
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(unauthorized, {
        status: 401,
        headers: {
          ...requestHeaders,
          "x-calyx-request-id": "attacker-controlled",
          "www-authenticate": 'Bearer realm="calyx-run"',
        },
      }))
      .mockResolvedValueOnce(new Response(unauthorized, {
        status: 401,
        headers: { ...requestHeaders, "www-authenticate": "Basic realm=attacker" },
      }))
      .mockResolvedValueOnce(new Response(unauthorized, {
        status: 401,
        headers: { ...requestHeaders, "www-authenticate": 'Bearer realm="calyx-run"' },
      }));
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    await expect(client.consumer.activity.list()).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "invalid_response",
    });
    await expect(client.consumer.activity.list()).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "invalid_response",
    });
    await expect(client.consumer.activity.list()).resolves.toMatchObject({
      ok: false,
      kind: "api",
      status: 401,
      error: { error: { code: "unauthorized" } },
    });
  });

  test("validates optional referenced error headers when they are present", async () => {
    const plan: OperationPlan = {
      ...adminOperationPlans["activity.list"],
      errorRequiredHeaderDecoders: {
        ...adminOperationPlans["activity.list"].errorRequiredHeaderDecoders,
        "401": {
          ...adminOperationPlans["activity.list"].errorRequiredHeaderDecoders["401"],
          "x-optional-proof": (value) => value === "safe",
        },
      },
    };
    const transport = new CalyxTransport(
      {
        baseUrl: "https://blade.example",
        bearerToken: "token",
        fetch: async () => new Response(JSON.stringify({
          error: { schema_version: "calyx.error/v1", code: "unauthorized", message: "unauthorized" },
        }), {
          status: 401,
          headers: {
            ...requestHeaders,
            "www-authenticate": 'Bearer realm="calyx-run"',
            "x-optional-proof": "attacker-controlled",
          },
        }),
      },
      { [plan.operationId]: plan },
      fixtureBearerTokenContract,
    );

    await expect(transport.execute("admin", plan, {})).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "invalid_response",
    });
  });

  test("validates optional success headers before exposing JSON or SSE bodies", async () => {
    const encoder = new TextEncoder();
    for (const [operationId, mediaType, bodyBytes] of [
      ["msg.doctor", "application/json", encoder.encode(JSON.stringify(doctorBody()))],
      ["admin.events", "text/event-stream", encoder.encode("data: never-exposed\n\n")],
    ] as const) {
      const cancellation = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bodyBytes);
        },
        cancel: cancellation,
      });
      const plan = withOptionalSuccessHeader(adminOperationPlans[operationId]);
      const transport = new CalyxTransport(
        {
          baseUrl: "https://blade.example",
          bearerToken: "token",
          fetch: async () => new Response(body, {
            status: plan.success[0]!.status,
            headers: {
              "content-type": mediaType,
              "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000001",
              "x-optional-proof": "attacker-controlled",
            },
          }),
        },
        { [plan.operationId]: plan },
        fixtureBearerTokenContract,
      );

      await expect(transport.execute("admin", plan, {})).resolves.toMatchObject({
        ok: false,
        kind: "protocol",
        stage: "invalid_response",
      });
      expect(cancellation).toHaveBeenCalledOnce();
    }
  });

  test("decodes only canonical bounded non-negative integer response headers", async () => {
    const base = adminOperationPlans["msg.doctor"];
    const plan: OperationPlan = {
      ...base,
      success: base.success.map((success) => ({
        ...success,
        headerDecoders: {
          ...success.headerDecoders,
          "x-count": (raw) => /^(?:0|[1-9][0-9]*)$/u.test(raw) && Number.isSafeInteger(Number(raw)),
        },
      })),
    };
    for (const [raw, ok] of [
      ["0", true],
      [String(Number.MAX_SAFE_INTEGER), true],
      ["-1", false],
      ["01", false],
      ["1.0", false],
      ["1e3", false],
      [" 1", false],
      ["1 ", false],
      ["+1", false],
      [String(Number.MAX_SAFE_INTEGER + 1), false],
    ] as const) {
      const transport = new CalyxTransport(
        {
          baseUrl: "https://blade.example",
          bearerToken: "token",
          fetch: async () => {
            const response = new Response(JSON.stringify(doctorBody()), {
              status: 200,
              headers: requestHeaders,
            });
            const get = response.headers.get.bind(response.headers);
            Object.defineProperty(response.headers, "get", {
              value: (name: string) => name.toLowerCase() === "x-count" ? raw : get(name),
            });
            return response;
          },
        },
        { [plan.operationId]: plan },
        fixtureBearerTokenContract,
      );
      const result = await transport.execute("admin", plan, {});
      expect(result.ok).toBe(ok);
      if (!ok) expect(result).toMatchObject({ kind: "protocol", stage: "invalid_response" });
    }
  });

  test("keeps optional success-header violations indeterminate during keyed recovery", async () => {
    const cancellation = vi.fn();
    const plan = withOptionalSuccessHeader(adminOperationPlans["msg.send"]);
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("fixture response loss"))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel: cancellation }), {
        status: plan.success[0]!.status,
        headers: {
          ...requestHeaders,
          "x-optional-proof": "attacker-controlled",
        },
      }));
    const transport = new CalyxTransport(
      {
        baseUrl: "https://blade.example",
        bearerToken: "token",
        fetch: fetchImplementation,
        retry: { maxAttempts: 1, recoveryAttempts: 1 },
      },
      { [plan.operationId]: plan },
      fixtureBearerTokenContract,
    );

    await expect(transport.execute("admin", plan, {
      body: {
        schema_version: "calyx.msg-send/v1",
        idempotency_key: "optional-header-recovery",
        recipient_address: "client:switchboard@carbon",
        reply_address: "client:switchboard@blade",
        subject: "hello",
        body: "body",
      },
    })).resolves.toMatchObject({
      ok: false,
      kind: "indeterminate",
      attempts: 2,
      receipt: { failure_stage: "invalid_response" },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(cancellation).toHaveBeenCalledOnce();
  });

  test("keeps unknown-status keyed results indeterminate when request identity is malformed", async () => {
    const cancellations = [vi.fn(), vi.fn(), vi.fn()];
    let attempt = 0;
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: async () => {
        const cancellation = cancellations[attempt++]!;
        return new Response(new ReadableStream<Uint8Array>({ cancel: cancellation }), {
          status: 418,
          headers: {
            "content-type": "application/json",
            "x-calyx-request-id": "attacker-controlled",
          },
        });
      },
    });

    const malformedIdentity = await client.consumer.msg.send({
      body: {
        schema_version: "calyx.msg-send/v1",
        idempotency_key: "malformed-request-id",
        recipient_address: "client:switchboard@carbon",
        reply_address: "client:switchboard@blade",
        subject: "hello",
        body: "body",
      },
    });
    expect(malformedIdentity).toMatchObject({
      ok: false,
      kind: "indeterminate",
      attempts: 3,
      receipt: { failure_stage: "invalid_response" },
    });
    expect(malformedIdentity).not.toHaveProperty("receipt.last_http_status");
    expect(malformedIdentity).not.toHaveProperty("receipt.last_request_id");
    for (const cancellation of cancellations) expect(cancellation).toHaveBeenCalledOnce();
  });

  test("keyed-write recovery reuses exact bytes and persists an explicitly sensitive receipt", async () => {
    const bodies: string[] = [];
    const recovery: CalyxIndeterminateReceipt[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(Buffer.from(init?.body as Uint8Array).toString("utf8"));
      return new Response("{malformed", { status: 200, headers: requestHeaders });
    });
    const client = createCalyxClient({
      baseUrl: "https://blade.example/proxy",
      bearerToken: "secret-token",
      fetch: fetchImplementation,
      recoveryReceiptIntegrityKey,
      recoveryStore: {
        custody: "encrypted_access_controlled",
        reserve: () => undefined,
        save: (receipt) => { recovery.push(receipt); },
        release: () => undefined,
      },
    });

    const result = await client.consumer.msg.send({
      body: {
        schema_version: "calyx.msg-send/v1",
        idempotency_key: "idem-1",
        recipient_address: "client:switchboard@carbon",
        reply_address: "client:switchboard@blade",
        subject: "hello",
        body: "body",
        ack_required: false,
        ignored_extra: "must not cross",
      } as never,
    });

    expect(result).toMatchObject({ ok: false, kind: "indeterminate", attempts: 3 });
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toContain("ignored_extra");
    expect(recovery).toHaveLength(1);
    expect(JSON.stringify(recovery[0])).not.toContain("secret-token");
    expect(recovery[0]).toMatchObject({
      operation_id: "msg.send",
      contract_digest: adminOperationPlans["msg.send"].recoveryContractDigest,
      payload_sensitivity: "sensitive_request_payload",
      path: "/proxy/v1/messages/send",
      idempotency_key: "idem-1",
    });
    const receipt = recovery[0]!;
    await expect(client.replayIndeterminate(receipt)).resolves.toMatchObject({
      ok: false,
      kind: "indeterminate",
      receipt: { operation_id: "msg.send", idempotency_key: "idem-1" },
    });
    const changedBody = JSON.parse(Buffer.from(receipt.body_bytes, "base64").toString("utf8")) as Record<string, unknown>;
    changedBody["recipient_address"] = "client:attacker@carbon";
    await expect(client.replayIndeterminate({
      ...receipt,
      body_bytes: Buffer.from(JSON.stringify(changedBody), "utf8").toString("base64"),
    })).rejects.toThrow(/integrity authority.*originally issued request/u);
    changedBody["idempotency_key"] = "idem-forged";
    await expect(client.replayIndeterminate({
      ...receipt,
      body_bytes: Buffer.from(JSON.stringify(changedBody), "utf8").toString("base64"),
      idempotency_key: "idem-forged",
    })).rejects.toThrow(/integrity authority.*originally issued request/u);
    await expect(client.replayIndeterminate({
      ...receipt,
      safe_headers: { ...receipt.safe_headers, "X-Calyx-Asserted-Actor": "run:rewritten" },
    })).rejects.toThrow(/integrity authority.*originally issued request/u);
    await expect(client.replayIndeterminate({
      ...receipt,
      path: "/proxy/v1/messages/other",
    })).rejects.toThrow(/integrity authority.*originally issued request/u);
    await expect(client.replayIndeterminate({
      ...receipt,
      last_request_id: "req_00000000-0000-4000-8000-000000000002",
    })).rejects.toThrow(/integrity authority.*originally issued request/u);
    await expect(client.replayIndeterminate({
      ...receipt,
      integrity_tag: `${receipt.integrity_tag}=`,
    })).rejects.toThrow(/integrity authority.*originally issued request/u);
    await expect(client.replayIndeterminate({
      ...receipt,
      credential_binding: `${receipt.credential_binding.slice(0, -1)}${receipt.credential_binding.endsWith("A") ? "B" : "A"}`,
    })).rejects.toThrow(/integrity authority.*originally issued request/u);
    await expect(client.replayIndeterminate({
      ...receipt,
      future_field: "must-fail-closed",
    } as CalyxIndeterminateReceipt)).rejects.toThrow(/invalid runtime shape/u);
    await expect(client.replayIndeterminate(resignRecoveryReceipt({
      ...receipt,
      contract_digest: "0".repeat(64),
    }))).rejects.toThrow(/different generated request contract for this operation/u);
    await expect(client.replayIndeterminate(resignRecoveryReceipt({
      ...receipt,
      safe_headers: { ...receipt.safe_headers, "X-Transport-Escape": "forbidden" },
    }))).rejects.toThrow(/non-generated.*header/u);
    await expect(client.replayIndeterminate(resignRecoveryReceipt({
      ...receipt,
      safe_headers: { ...receipt.safe_headers, Accept: "application/vnd.attacker-controlled+json" },
    }))).rejects.toThrow(/non-generated|Accept binding/u);
    await expect(client.replayIndeterminate(resignRecoveryReceipt({
      ...receipt,
      safe_headers: { ...receipt.safe_headers, "content-type": "application/json" },
    }))).rejects.toThrow(/case-colliding|non-generated/u);
    await expect(client.replayIndeterminate(resignRecoveryReceipt({
      ...receipt,
      body_bytes: Buffer.alloc(2 * 1024 * 1024).toString("base64"),
    }))).rejects.toThrow(/request-body bound/u);
    await expect(client.replayIndeterminate(resignRecoveryReceipt({
      ...receipt,
      last_request_id: "attacker-controlled",
    }))).rejects.toThrow(/last request ID violates its generated schema/u);
    await expect(client.replayIndeterminate({
      ...receipt,
      last_request_id: undefined,
    } as never)).rejects.toThrow(/invalid runtime shape/u);
  });

  test("caller cancellation bounds durable replay credential resolution", async () => {
    const source = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      recoveryReceiptIntegrityKey,
      fetch: async () => { throw new Error("fixture ambiguous dispatch"); },
      retry: { maxAttempts: 1, recoveryAttempts: 1 },
    });
    const result = await source.consumer.msg.send({
      body: messageSendBody("replay-token-cancellation") as never,
    });
    if (result.ok || result.kind !== "indeterminate") throw new Error("fixture did not produce a recovery receipt");

    const controller = new AbortController();
    const replacement = new AbortController();
    const tokenProvider = vi.fn((_signal?: AbortSignal) => new Promise<string>(() => undefined));
    const fetchImplementation = vi.fn<typeof fetch>();
    const replay = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: tokenProvider,
      recoveryReceiptIntegrityKey,
      fetch: fetchImplementation,
    });
    const options: { signal?: AbortSignal } = { signal: controller.signal };
    const replayed = replay.replayIndeterminate(result.receipt, options);
    options.signal = replacement.signal;
    controller.abort();

    await expect(replayed).resolves.toMatchObject({
      ok: false,
      kind: "transport",
      stage: "aborted",
      message: "Recovery replay was aborted by the caller.",
    });
    expect(tokenProvider).toHaveBeenCalledOnce();
    expect(tokenProvider).toHaveBeenCalledWith(controller.signal);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  test("caller cancellation stops durable replay after one fetch attempt", async () => {
    const source = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      recoveryReceiptIntegrityKey,
      fetch: async () => { throw new Error("fixture ambiguous dispatch"); },
      retry: { maxAttempts: 1, recoveryAttempts: 1 },
    });
    const result = await source.consumer.msg.send({
      body: messageSendBody("replay-fetch-cancellation") as never,
    });
    if (result.ok || result.kind !== "indeterminate") throw new Error("fixture did not produce a recovery receipt");

    const controller = new AbortController();
    const persisted: CalyxIndeterminateReceipt[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new Error("fixture aborted replay request");
    });
    const replay = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      recoveryReceiptIntegrityKey,
      recoveryStore: {
        custody: "encrypted_access_controlled",
        reserve: () => undefined,
        save: (receipt) => { persisted.push(receipt); },
        release: () => undefined,
      },
      fetch: fetchImplementation,
      retry: { maxAttempts: 1, recoveryAttempts: 3 },
    });

    await expect(replay.replayIndeterminate(result.receipt, { signal: controller.signal })).resolves.toMatchObject({
      ok: false,
      kind: "indeterminate",
      attempts: 1,
      receipt: { failure_stage: "aborted" },
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      operation_id: result.receipt.operation_id,
      contract_digest: result.receipt.contract_digest,
      credential_binding: result.receipt.credential_binding,
      failure_stage: "aborted",
    });
  });

  test("caller cancellation bounds retained replay credential resolution", async () => {
    const source = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "old-token",
      recoveryReceiptIntegrityKey,
      fetch: async () => { throw new Error("fixture ambiguous dispatch"); },
      retry: { maxAttempts: 1, recoveryAttempts: 1 },
    });
    const result = await source.consumer.msg.send({
      body: messageSendBody("replay-retained-token-cancellation") as never,
    });
    if (result.ok || result.kind !== "indeterminate") throw new Error("fixture did not produce a recovery receipt");

    const controller = new AbortController();
    const currentTokenProvider = vi.fn((_signal?: AbortSignal) => "new-token");
    let markPreviousStarted!: () => void;
    const previousStarted = new Promise<void>((resolve) => { markPreviousStarted = resolve; });
    const previousTokenProvider = vi.fn((_signal?: AbortSignal) => {
      markPreviousStarted();
      return new Promise<string>(() => undefined);
    });
    const fetchImplementation = vi.fn<typeof fetch>();
    const replay = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: currentTokenProvider,
      previousBearerToken: previousTokenProvider,
      recoveryReceiptIntegrityKey,
      fetch: fetchImplementation,
    });
    const replayed = replay.replayIndeterminate(result.receipt, { signal: controller.signal });
    await previousStarted;
    controller.abort();

    await expect(replayed).resolves.toMatchObject({
      ok: false,
      kind: "transport",
      stage: "aborted",
      message: "Recovery replay was aborted by the caller.",
    });
    expect(currentTokenProvider).toHaveBeenCalledWith(controller.signal);
    expect(previousTokenProvider).toHaveBeenCalledWith(controller.signal);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  test("preserves an atomic validated response identity across replay network exhaustion", async () => {
    const source = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      recoveryReceiptIntegrityKey,
      fetch: async () => new Response("{malformed", { status: 200, headers: requestHeaders }),
      retry: { maxAttempts: 1, recoveryAttempts: 1 },
    });
    const first = await source.consumer.msg.send({
      body: messageSendBody("replay-sticky-response-identity") as never,
    });
    expect(first).toMatchObject({
      ok: false,
      kind: "indeterminate",
      receipt: {
        last_http_status: 200,
        last_request_id: requestHeaders["x-calyx-request-id"],
      },
    });
    if (first.ok || first.kind !== "indeterminate") throw new Error("fixture did not produce an indeterminate receipt");

    const replay = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      recoveryReceiptIntegrityKey,
      fetch: async () => { throw new Error("fixture replay network loss"); },
      retry: { maxAttempts: 1, recoveryAttempts: 2 },
    });
    await expect(replay.replayIndeterminate(first.receipt)).resolves.toMatchObject({
      ok: false,
      kind: "indeterminate",
      attempts: 2,
      requestId: requestHeaders["x-calyx-request-id"],
      receipt: {
        failure_stage: "network",
        last_http_status: 200,
        last_request_id: requestHeaders["x-calyx-request-id"],
      },
    });
  });

  test("keeps process-local recovery receipts bound to the issuing client instance", async () => {
    const source = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: async () => { throw new Error("fixture ambiguous dispatch"); },
      retry: { maxAttempts: 1, recoveryAttempts: 1 },
    });
    const result = await source.consumer.msg.send({
      body: messageSendBody("process-local-integrity") as never,
    });
    if (result.ok || result.kind !== "indeterminate") throw new Error("fixture did not produce a recovery receipt");

    const tokenProvider = vi.fn(() => "token");
    const fetchImplementation = vi.fn<typeof fetch>();
    const other = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: tokenProvider,
      fetch: fetchImplementation,
    });
    await expect(other.replayIndeterminate(result.receipt)).rejects.toThrow(
      /integrity authority.*originally issued request/u,
    );
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  test("rejects durable replay under a different exact bearer credential before fetch", async () => {
    const source = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "subject-a-token",
      recoveryReceiptIntegrityKey,
      fetch: async () => { throw new Error("fixture ambiguous dispatch"); },
      retry: { maxAttempts: 1, recoveryAttempts: 1 },
    });
    const result = await source.consumer.msg.send({
      body: messageSendBody("durable-credential-binding") as never,
    });
    if (result.ok || result.kind !== "indeterminate") throw new Error("fixture did not produce a recovery receipt");

    const tokenProvider = vi.fn(() => "subject-b-token");
    const fetchImplementation = vi.fn<typeof fetch>();
    const other = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: tokenProvider,
      recoveryReceiptIntegrityKey,
      fetch: fetchImplementation,
    });
    await expect(other.replayIndeterminate(result.receipt)).rejects.toThrow(
      /different bearer credential authority/u,
    );
    expect(tokenProvider).toHaveBeenCalledOnce();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  test("replays a durable receipt through the exact retained credential during one-step rotation", async () => {
    const source = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "old-subject-a-token",
      recoveryReceiptIntegrityKey,
      fetch: async () => { throw new Error("fixture ambiguous dispatch"); },
      retry: { maxAttempts: 1, recoveryAttempts: 1 },
    });
    const result = await source.consumer.msg.send({
      body: messageSendBody("durable-credential-rotation") as never,
    });
    if (result.ok || result.kind !== "indeterminate") throw new Error("fixture did not produce a recovery receipt");

    const currentTokenProvider = vi.fn(() => "new-subject-a-token");
    const previousTokenProvider = vi.fn(() => "old-subject-a-token");
    const sentHeaders: Headers[] = [];
    const replay = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: currentTokenProvider,
      previousBearerToken: previousTokenProvider,
      recoveryReceiptIntegrityKey,
      fetch: async (_input, init) => {
        sentHeaders.push(new Headers(init?.headers));
        throw new Error("fixture replay network loss");
      },
      retry: { maxAttempts: 1, recoveryAttempts: 1 },
    });
    await expect(replay.replayIndeterminate(result.receipt)).resolves.toMatchObject({
      ok: false,
      kind: "indeterminate",
    });
    expect(currentTokenProvider).toHaveBeenCalledOnce();
    expect(previousTokenProvider).toHaveBeenCalledOnce();
    expect(sentHeaders).toHaveLength(1);
    expect(sentHeaders[0]?.get("authorization")).toBe("Bearer old-subject-a-token");
  });

  test("does not consult the retained rotation credential when the current bearer matches", async () => {
    const source = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "current-token",
      recoveryReceiptIntegrityKey,
      fetch: async () => { throw new Error("fixture ambiguous dispatch"); },
      retry: { maxAttempts: 1, recoveryAttempts: 1 },
    });
    const result = await source.consumer.msg.send({
      body: messageSendBody("durable-current-credential") as never,
    });
    if (result.ok || result.kind !== "indeterminate") throw new Error("fixture did not produce a recovery receipt");

    const previousTokenProvider = vi.fn(() => "previous-token");
    const replay = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "current-token",
      previousBearerToken: previousTokenProvider,
      recoveryReceiptIntegrityKey,
      fetch: async () => { throw new Error("fixture replay network loss"); },
      retry: { maxAttempts: 1, recoveryAttempts: 1 },
    });
    await expect(replay.replayIndeterminate(result.receipt)).resolves.toMatchObject({
      ok: false,
      kind: "indeterminate",
    });
    expect(previousTokenProvider).not.toHaveBeenCalled();
  });

  test("drains an old receipt when current credential resolution fails during rotation", async () => {
    const source = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "old-subject-a-token",
      recoveryReceiptIntegrityKey,
      fetch: async () => { throw new Error("fixture ambiguous dispatch"); },
      retry: { maxAttempts: 1, recoveryAttempts: 1 },
    });
    const result = await source.consumer.msg.send({
      body: messageSendBody("durable-credential-resolution-fallback") as never,
    });
    if (result.ok || result.kind !== "indeterminate") throw new Error("fixture did not produce a recovery receipt");

    const previousTokenProvider = vi.fn(() => "old-subject-a-token");
    const sentHeaders: Headers[] = [];
    const replay = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: () => { throw new Error("current credential unavailable"); },
      previousBearerToken: previousTokenProvider,
      recoveryReceiptIntegrityKey,
      fetch: async (_input, init) => {
        sentHeaders.push(new Headers(init?.headers));
        throw new Error("fixture replay network loss");
      },
      retry: { maxAttempts: 1, recoveryAttempts: 1 },
    });
    await expect(replay.replayIndeterminate(result.receipt)).resolves.toMatchObject({
      ok: false,
      kind: "indeterminate",
    });
    expect(previousTokenProvider).toHaveBeenCalledOnce();
    expect(sentHeaders).toHaveLength(1);
    expect(sentHeaders[0]?.get("authorization")).toBe("Bearer old-subject-a-token");
  });

  test("snapshots authenticated recovery headers before awaiting token resolution", async () => {
    const source = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      recoveryReceiptIntegrityKey,
      fetch: async () => { throw new Error("fixture ambiguous dispatch"); },
      retry: { maxAttempts: 1, recoveryAttempts: 1 },
    });
    const result = await source.consumer.msg.send({
      body: messageSendBody("recovery-header-snapshot") as never,
    });
    if (result.ok || result.kind !== "indeterminate") throw new Error("fixture did not produce a recovery receipt");

    let releaseToken!: (token: string) => void;
    const token = new Promise<string>((resolve) => { releaseToken = resolve; });
    const sentHeaders: Headers[] = [];
    const replay = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: () => token,
      recoveryReceiptIntegrityKey,
      fetch: async (_input, init) => {
        sentHeaders.push(new Headers(init?.headers));
        throw new Error("fixture recovery response loss");
      },
      retry: { maxAttempts: 1, recoveryAttempts: 1 },
    });

    const persistedReceipt = JSON.parse(JSON.stringify(result.receipt)) as CalyxIndeterminateReceipt;
    const replayed = replay.replayIndeterminate(persistedReceipt);
    const mutableHeaders = persistedReceipt.safe_headers as Record<string, string>;
    mutableHeaders["Content-Type"] = "text/plain";
    mutableHeaders["X-Transport-Escape"] = "forbidden";
    releaseToken("token");

    await expect(replayed).resolves.toMatchObject({ ok: false, kind: "indeterminate" });
    expect(sentHeaders).toHaveLength(1);
    expect(sentHeaders[0]!.get("content-type")).toBe("application/json");
    expect(sentHeaders[0]!.has("x-transport-escape")).toBe(false);
  });

  test("keeps the prepared AbortSignal when caller state mutates during credential resolution", async () => {
    const preparedController = new AbortController();
    const replacementController = new AbortController();
    let releaseToken!: (token: string) => void;
    const token = new Promise<string>((resolve) => { releaseToken = resolve; });
    let sentSignal: AbortSignal | null | undefined;
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: () => token,
      fetch: async (_input, init) => {
        sentSignal = init?.signal;
        return new Response(JSON.stringify(doctorBody()), { status: 200, headers: requestHeaders });
      },
    });
    const request = { signal: preparedController.signal };

    const pending = client.consumer.msg.doctor(request);
    request.signal = replacementController.signal;
    replacementController.abort();
    releaseToken("token");

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(sentSignal).toBe(preparedController.signal);
    expect(preparedController.signal.aborted).toBe(false);
  });

  test("persists secret-capable launch bytes only through an opted-in sensitive store", async () => {
    const recovery: CalyxIndeterminateReceipt[] = [];
    const admin = createCalyxAdminClient({
      baseUrl: "https://blade.example",
      bearerToken: "transport-secret",
      fetch: async () => new Response("{malformed", {
        status: 202,
        headers: {
          "content-type": "application/vnd.polli.calyx.run-launch-receipt+json;version=1",
          "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000001",
        },
      }),
      retry: { maxAttempts: 1, recoveryAttempts: 1 },
      recoveryReceiptIntegrityKey,
      recoveryStore: {
        custody: "encrypted_access_controlled",
        reserve: () => undefined,
        save: (receipt) => { recovery.push(receipt); },
        release: () => undefined,
      },
    });

    await expect(admin.admin.run.launch({
      body: {
        schema_version: "calyx.run-launch-request/v1",
        intent: {
          run_id: "run:sensitive-recovery",
          host: "blade",
          created_at: "2026-07-15T00:00:00.000Z",
          host_process: {
            argv: ["fixture"],
            env: { ARBITRARY_SECRET: "body-secret" },
          },
        },
        idempotency_key: "sensitive-recovery",
        topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
      },
    })).resolves.toMatchObject({
      ok: false,
      kind: "indeterminate",
      receipt: { payload_sensitivity: "sensitive_request_payload" },
    });
    expect(recovery).toHaveLength(1);
    expect(Buffer.from(recovery[0]!.body_bytes, "base64").toString("utf8")).toContain("body-secret");
    expect(JSON.stringify(recovery[0])).not.toContain("transport-secret");
  });

  test("cancels rejected keyed-write recovery response bodies", async () => {
    const recoveryCancellations = [vi.fn(), vi.fn()];
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{malformed", { status: 200, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel: recoveryCancellations[0]! }), {
        status: 200,
        headers: { ...requestHeaders, "content-type": "text/plain" },
      }))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel: recoveryCancellations[1]! }), {
        status: 200,
        headers: { ...requestHeaders, "content-type": "text/plain" },
      }));
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    const result = await client.consumer.msg.send({
      body: {
        schema_version: "calyx.msg-send/v1",
        idempotency_key: "cancel-recovery-bodies",
        recipient_address: "client:switchboard@carbon",
        reply_address: "client:switchboard@blade",
        subject: "hello",
        body: "body",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      kind: "indeterminate",
      attempts: 3,
      receipt: { failure_stage: "unexpected_media_type" },
    });
    expect(result).not.toHaveProperty("receipt.rawBodySnippet");
    expect(result).not.toHaveProperty("receipt.rawBodyBytes");
    expect(result).not.toHaveProperty("receipt.responseHeaders");
    for (const cancel of recoveryCancellations) expect(cancel).toHaveBeenCalledOnce();
  });

  test("rejects noncanonical and oversized future keyed recovery paths before credentials", async () => {
    const tokenProvider = vi.fn(() => "token");
    const fetchImplementation = vi.fn<typeof fetch>();
    const stringSerializer = g.requestGuard(g.requestString(1, 64, undefined, undefined), false, undefined, false, undefined);
    const requestSerializer = g.requestGuard(
      g.requestObject({ idempotency_key: stringSerializer }, ["idempotency_key"], undefined),
      false,
      undefined,
      false,
      undefined,
    );
    const objectDecoder = g.response(g.responseObject({}, [], false, undefined, undefined), false, undefined, [], [], [], false, undefined, undefined, []);
    const plan = {
      operationId: "fixture.keyed-path-write",
      surface: "admin",
      profile: "control_plane_admin_v1",
      capability: "fixture.write",
      domain: "fixture",
      effects: {},
      method: "POST",
      pathTemplate: "/v1/admin/runs/{runId}/stop",
      requestTargetMaxBytes: 8000,
      pathParameterSerializers: { runId: g.requestGuard(g.requestString(undefined, undefined, undefined, undefined), false, undefined, false, undefined) },
      requestBody: "json",
      requestMediaType: "application/json",
      maxBodyBytes: 1024,
      requestSerializer,
      requestIdHeaderDecoder: (value: string) => value.length > 0,
      retryAuthority: { kind: "request_body_field", field: "idempotency_key" },
      success: [{
        status: 200,
        representation: "json",
        mediaType: "application/json",
        decoder: objectDecoder,
        requiredHeaders: ["x-calyx-request-id"],
        headerDecoders: { "x-calyx-request-id": (value: string) => value.length > 0 },
        maxBytes: 1024,
        semantics: { mutation: "idempotent_write" },
      }],
      errorCodes: {},
      errorEnvelopeDecoder: objectDecoder,
      errorDecoders: {},
      errorRequiredHeaders: {},
      errorRequiredHeaderDecoders: {},
      recoveryContractDigest: "fixture-recovery-contract",
    } as const satisfies OperationPlan;
    const transport = new CalyxTransport(
      {
        baseUrl: "https://blade.example/proxy",
        bearerToken: tokenProvider,
        fetch: fetchImplementation,
        recoveryReceiptIntegrityKey,
      },
      { [plan.operationId]: plan },
      fixtureBearerTokenContract,
    );
    const bodyBytes = Buffer.from('{"idempotency_key":"fixture-key"}', "utf8").toString("base64");

    for (const segment of [".", "..", "%2e", "%2e%2e", "%2E%2E"]) {
      const receipt = signRecoveryReceipt({
        schema_version: "calyx.client-indeterminate-result/v1",
        payload_sensitivity: "sensitive_request_payload",
        credential_binding: "fixture-credential-binding",
        contract_digest: "fixture-recovery-contract",
        operation_id: plan.operationId,
        method: "POST",
        origin: "https://blade.example",
        base_path: "/proxy",
        path: `/proxy/v1/admin/runs/${segment}/stop`,
        safe_headers: { "Content-Type": "application/json" },
        body_bytes: bodyBytes,
        idempotency_key: "fixture-key",
        attempts: 1,
        failure_stage: "fixture",
      });
      await expect(transport.replay(receipt)).rejects.toThrow(/path is not canonical/u);
    }
    const oversizedReceipt = signRecoveryReceipt({
      schema_version: "calyx.client-indeterminate-result/v1",
      payload_sensitivity: "sensitive_request_payload",
      credential_binding: "fixture-credential-binding",
      contract_digest: "fixture-recovery-contract",
      operation_id: plan.operationId,
      method: "POST",
      origin: "https://blade.example",
      base_path: "/proxy",
      path: `/proxy/v1/admin/runs/${"x".repeat(8000)}/stop`,
      safe_headers: { "Content-Type": "application/json" },
      body_bytes: bodyBytes,
      idempotency_key: "fixture-key",
      attempts: 1,
      failure_stage: "fixture",
    });
    await expect(transport.replay(oversizedReceipt)).rejects.toThrow(/request target exceeds 8000 bytes/u);
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  test("moves ambiguous keyed connection failures into exact-byte recovery", async () => {
    const bodies: string[] = [];
    const recovery: CalyxIndeterminateReceipt[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(Buffer.from(init?.body as Uint8Array).toString("utf8"));
      throw new Error("fixture connection loss after dispatch");
    });
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
      recoveryReceiptIntegrityKey,
      recoveryStore: {
        custody: "encrypted_access_controlled",
        reserve: () => undefined,
        save: (receipt) => { recovery.push(receipt); },
        release: () => undefined,
      },
    });

    const result = await client.consumer.msg.send({
      body: {
        schema_version: "calyx.msg-send/v1",
        idempotency_key: "network-ambiguity",
        recipient_address: "client:switchboard@carbon",
        reply_address: "client:switchboard@blade",
        subject: "hello",
        body: "body",
      },
    });

    expect(result).toMatchObject({ ok: false, kind: "indeterminate", attempts: 4 });
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    expect(new Set(bodies).size).toBe(1);
    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toMatchObject({ idempotency_key: "network-ambiguity", failure_stage: "network" });
  });

  test("does not mistake a later API error for proof that an ambiguous keyed write was not admitted", async () => {
    const apiFailure = (): Response => new Response(JSON.stringify({
      error: { schema_version: "calyx.error/v1", code: "invalid_request", message: "later admission state" },
    }), { status: 400, headers: requestHeaders });
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("fixture connection loss after dispatch"))
      .mockImplementation(async () => apiFailure());
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    const result = await client.consumer.msg.send({
      body: {
        schema_version: "calyx.msg-send/v1",
        idempotency_key: "api-after-ambiguity",
        recipient_address: "client:switchboard@carbon",
        reply_address: "client:switchboard@blade",
        subject: "hello",
        body: "body",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      kind: "indeterminate",
      attempts: 4,
      receipt: {
        failure_stage: "api_during_recovery",
        last_http_status: 400,
      },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
  });

  test("does not let an API error erase ambiguity created by a malformed keyed-write success", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{malformed", { status: 200, headers: requestHeaders }))
      .mockImplementation(async () => new Response(JSON.stringify({
        error: { schema_version: "calyx.error/v1", code: "invalid_request", message: "admission state changed" },
      }), { status: 400, headers: requestHeaders }));
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    const result = await client.consumer.msg.send({
      body: {
        schema_version: "calyx.msg-send/v1",
        idempotency_key: "api-during-recovery",
        recipient_address: "client:switchboard@carbon",
        reply_address: "client:switchboard@blade",
        subject: "hello",
        body: "body",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      kind: "indeterminate",
      attempts: 3,
      receipt: {
        failure_stage: "api_during_recovery",
        last_http_status: 400,
      },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  test("pins one bearer credential across ordinary and recovery attempts", async () => {
    const tokenProvider = vi.fn()
      .mockReturnValueOnce("subject-a-token")
      .mockReturnValueOnce("subject-b-token");
    const authorization: Array<string | null> = [];
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: tokenProvider,
      fetch: async (_input, init) => {
        authorization.push(new Headers(init?.headers).get("authorization"));
        throw new Error("fixture connection loss after dispatch");
      },
    });

    const result = await client.consumer.msg.send({
      body: {
        schema_version: "calyx.msg-send/v1",
        idempotency_key: "token-after-ambiguity",
        recipient_address: "client:switchboard@carbon",
        reply_address: "client:switchboard@blade",
        subject: "hello",
        body: "body",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      kind: "indeterminate",
      attempts: 4,
      receipt: { failure_stage: "network" },
    });
    expect(tokenProvider).toHaveBeenCalledOnce();
    expect(authorization).toEqual(Array.from({ length: 4 }, () => "Bearer subject-a-token"));
  });

  test("returns immutable recovery identity when durable custody fails", async () => {
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: async () => new Response("{malformed", { status: 200, headers: requestHeaders }),
      recoveryReceiptIntegrityKey,
      recoveryStore: {
        custody: "encrypted_access_controlled",
        reserve: () => undefined,
        save: () => { throw new Error("disk path and secret must not escape"); },
        release: () => undefined,
      },
    });

    const result = await client.consumer.msg.send({
      body: {
        schema_version: "calyx.msg-send/v1",
        idempotency_key: "custody-failure",
        recipient_address: "client:switchboard@carbon",
        reply_address: "client:switchboard@blade",
        subject: "hello",
        body: "body",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      kind: "indeterminate",
      receipt: { idempotency_key: "custody-failure" },
      persistenceFailure: { stage: "recovery_store" },
    });
    expect(JSON.stringify(result)).not.toContain("disk path");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("does not let a failing recovery store mutate the returned immutable receipt", async () => {
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: async () => new Response("{malformed", { status: 200, headers: requestHeaders }),
      recoveryReceiptIntegrityKey,
      recoveryStore: {
        custody: "encrypted_access_controlled",
        reserve: () => undefined,
        save: (receipt) => {
          Reflect.set(receipt, "body_bytes", "CORRUPTED");
          Reflect.set(receipt.safe_headers, "X-Escape", "yes");
          throw new Error("fixture persistence failure");
        },
        release: () => undefined,
      },
    });

    const result = await client.consumer.msg.send({
      body: {
        schema_version: "calyx.msg-send/v1",
        idempotency_key: "immutable-store-handback",
        recipient_address: "client:switchboard@carbon",
        reply_address: "client:switchboard@blade",
        subject: "hello",
        body: "body",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      kind: "indeterminate",
      persistenceFailure: { stage: "recovery_store" },
      receipt: { idempotency_key: "immutable-store-handback" },
    });
    if (result.ok || result.kind !== "indeterminate") throw new Error("fixture did not reach indeterminate handback");
    expect(result.receipt.body_bytes).not.toBe("CORRUPTED");
    expect(result.receipt.safe_headers).not.toHaveProperty("X-Escape");
    expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(Object.isFrozen(result.receipt.safe_headers)).toBe(true);
  });

  test("token-provider failures do not expose thrown credential material", async () => {
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: () => { throw new Error("provider leaked super-secret-material"); },
    });

    const result = await client.consumer.msg.doctor();
    expect(result).toMatchObject({ ok: false, kind: "transport", stage: "token" });
    expect(JSON.stringify(result)).not.toContain("super-secret-material");
  });

  test("serializes explicit JSON dictionaries without prototype pollution", async () => {
    const serializedBodies: string[] = [];
    const admin = createCalyxAdminClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: async (_input, init) => {
        serializedBodies.push(Buffer.from(init?.body as Uint8Array).toString("utf8"));
        return new Response(JSON.stringify({
          error: { schema_version: "calyx.error/v1", code: "lease_owner_mismatch", message: "fixture" },
        }), { status: 409, headers: requestHeaders });
      },
    });
    const metadata = JSON.parse('{"__proto__":{"polluted":true},"nested":{"value":1}}') as Record<string, unknown>;

    await admin.admin.lease.steal({
      body: {
        key: "worktree:fixture",
        idempotency_key: "lease-idem",
        holder_activity_id: "interactive:codex:fixture",
        ttl_ms: 1000,
        provenance: metadata,
      },
    });
    await admin.admin.lease.steal({
      body: {
        key: "worktree:fixture",
        idempotency_key: "lease-string-provenance",
        holder_activity_id: "interactive:codex:fixture",
        ttl_ms: 1000,
        provenance: "operator supplied reason",
      },
    });

    const parsed = JSON.parse(serializedBodies[0]!) as { provenance: Record<string, unknown> };
    expect(parsed.provenance).toHaveProperty("__proto__");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(JSON.parse(serializedBodies[1]!) as { provenance: unknown }).toMatchObject({
      provenance: "operator supplied reason",
    });
  });

  test("selects admitted object-union branches by their literal discriminator", async () => {
    let serializedBody = "";
    const literalString = (literal: string) => g.requestGuard(
      g.requestString(undefined, undefined, undefined, undefined),
      false,
      undefined,
      true,
      literal,
    );
    const string = g.requestGuard(g.requestString(undefined, undefined, undefined, undefined), false, undefined, false, undefined);
    const branch = (kind: string) => g.requestGuard(g.requestObject({
      kind: literalString(kind),
      mode: literalString("shared"),
      value: string,
    }, ["kind", "mode", "value"], undefined), false, undefined, false, undefined);
    const plan: OperationPlan = {
      ...adminOperationPlans["admin.run.stop"],
      requestSerializer: g.requestGuard(g.requestUnion([
        { serialize: branch("a"), wireType: "object" },
        { serialize: branch("b"), wireType: "object" },
      ], { property: "kind", values: ["a", "b"] }), false, undefined, false, undefined),
    };
    const transport = new CalyxTransport(
      {
        baseUrl: "https://blade.example",
        bearerToken: "token",
        fetch: async (_input, init) => {
          serializedBody = Buffer.from(init?.body as Uint8Array).toString("utf8");
          return new Response(JSON.stringify({
            error: { schema_version: "calyx.error/v1", code: "invalid_request", message: "fixture" },
          }), { status: 400, headers: requestHeaders });
        },
      },
      { [plan.operationId]: plan },
      fixtureBearerTokenContract,
    );

    await expect(transport.execute("admin", plan, {
      path: { runId: "run:fixture" },
      body: { kind: "a", mode: "shared", value: "selected" },
    })).resolves.toMatchObject({ ok: false, kind: "api", status: 400 });
    expect(serializedBody).toBe('{"kind":"a","mode":"shared","value":"selected"}');
    await expect(transport.execute("admin", plan, {
      path: { runId: "run:fixture" },
      body: { kind: "future", mode: "shared", value: "rejected" },
    })).rejects.toThrow(/exactly one declared discriminator branch/u);
  });

  test("rejects cycles and oversized bodies before resolving credentials", async () => {
    const tokenProvider = vi.fn(() => "token");
    const admin = createCalyxAdminClient({ baseUrl: "https://blade.example", bearerToken: tokenProvider });
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    await expect(admin.admin.lease.steal({
      body: {
        key: "worktree:fixture",
        idempotency_key: "lease-cycle",
        holder_activity_id: "interactive:codex:fixture",
        ttl_ms: 1000,
        provenance: cyclic,
      },
    })).rejects.toThrow(/cycles/u);

    const consumer = createCalyxClient({ baseUrl: "https://blade.example", bearerToken: tokenProvider });
    await expect(consumer.consumer.msg.send({
      body: {
        schema_version: "calyx.msg-send/v1",
        idempotency_key: "oversized",
        recipient_address: "client:switchboard@carbon",
        reply_address: "client:switchboard@blade",
        subject: "large",
        body: "x".repeat(1_100_000),
      },
    })).rejects.toThrow(/at most|exceeds/u);
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  test("rejects noncanonical date-times and unsafe integers before credentials", async () => {
    const tokenProvider = vi.fn(() => "token");
    const client = createCalyxClient({ baseUrl: "https://blade.example", bearerToken: tokenProvider });
    const admin = createCalyxAdminClient({ baseUrl: "https://blade.example", bearerToken: tokenProvider });

    await expect(client.consumer.msg.send({
      body: {
        ...messageSendBody("invalid-date-time"),
        expires_at: "2026-07-14T00:00:00+00:00",
      } as never,
    })).rejects.toThrow(/declared pattern|declared format/u);
    await expect(admin.admin.lease.steal({
      body: {
        key: "worktree:fixture",
        idempotency_key: "unsafe-integer",
        holder_activity_id: "interactive:codex:fixture",
        ttl_ms: Number.MAX_SAFE_INTEGER + 1,
        provenance: "fixture",
      },
    })).rejects.toThrow(/finite integer|declared maximum/u);
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  test("rejects undefined required properties and array entries before credentials", async () => {
    const tokenProvider = vi.fn(() => "token");
    const client = createCalyxClient({ baseUrl: "https://blade.example", bearerToken: tokenProvider });
    const admin = createCalyxAdminClient({ baseUrl: "https://blade.example", bearerToken: tokenProvider });

    await expect(client.consumer.msg.send({
      body: {
        schema_version: "calyx.msg-send/v1",
        idempotency_key: "undefined-required",
        recipient_address: "client:switchboard@blade",
        reply_address: "client:switchboard@blade",
        subject: undefined,
      } as never,
    })).rejects.toThrow(/required property subject/u);
    await expect(admin.admin.run.launch({
      body: {
        schema_version: "calyx.run-launch-request/v1",
        intent: {
          run_id: "run:fixture",
          host: "blade",
          created_at: "2026-07-14T00:00:00.000Z",
          host_process: { argv: ["echo", undefined] },
        },
        idempotency_key: "undefined-array",
        topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
      } as never,
    })).rejects.toThrow(/must not contain undefined/u);
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  test("rejects an absent required JSON body before credentials or fetch", async () => {
    const tokenProvider = vi.fn(() => "token");
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: tokenProvider,
      fetch: fetchImplementation,
    });
    const invokeWithoutRequest = client.consumer.msg.send as unknown as () => Promise<unknown>;

    await expect(invokeWithoutRequest()).rejects.toThrow(/requires a JSON request body/u);
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  test("rejects an absent required query container before credentials or fetch", async () => {
    const tokenProvider = vi.fn(() => "token");
    const fetchImplementation = vi.fn<typeof fetch>();
    const plan: OperationPlan = {
      ...adminOperationPlans["activity.list"],
      queryRequired: true,
      requestSerializer: g.requestGuard(g.requestObject({
        agent_kind: g.requestGuard(g.requestString(undefined, undefined, undefined, undefined), false, undefined, false, undefined),
      }, ["agent_kind"], undefined), false, undefined, false, undefined),
    };
    const transport = new CalyxTransport(
      {
        baseUrl: "https://blade.example",
        bearerToken: tokenProvider,
        fetch: fetchImplementation,
      },
      { [plan.operationId]: plan },
      fixtureBearerTokenContract,
    );

    await expect(transport.execute("admin", plan, {})).rejects.toThrow(/requires generated query input/u);
    await expect(transport.execute("admin", plan, { query: {} })).rejects.toThrow(/required property agent_kind/u);
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  test("reconnects SSE with the operation-bound token and latest event id", async () => {
    const encoder = new TextEncoder();
    const authorization: Array<string | null> = [];
    const cursors: Array<string | null> = [];
    const tokenProvider = vi.fn()
      .mockReturnValueOnce("token-one")
      .mockReturnValueOnce("token-two");
    const firstBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`id: evt-1\ndata: ${JSON.stringify(observationEvent("evt-1"))}\n\n`));
      },
      pull(controller) {
        controller.error(new Error("fixture connection loss"));
      },
    });
    const secondBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`id: evt-2\ndata: ${JSON.stringify(observationEvent("evt-2"))}\n\n`));
        controller.close();
      },
    });
    let connectionCount = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      connectionCount += 1;
      const headers = new Headers(init?.headers);
      authorization.push(headers.get("authorization"));
      cursors.push(headers.get("last-event-id"));
      const body = connectionCount === 1 ? firstBody : secondBody;
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-calyx-request-id": `req_00000000-0000-4000-8000-${String(connectionCount).padStart(12, "0")}`,
        },
      });
    });
    const client = createCalyxClient({
      baseUrl: "https://blade.example/proxy",
      bearerToken: tokenProvider,
      fetch: fetchImplementation,
      retry: { sseReconnectAttempts: 1 },
    });

    const result = await client.consumer.work.observe();
    if (!result.ok) throw new Error(`SSE fixture failed before streaming: ${result.kind}`);
    const events: Array<{ cursor: string }> = [];
    for await (const event of result.data) events.push(event);
    await result.data.closed;

    expect(events.map((event) => event.cursor)).toEqual(["evt-1", "evt-2"]);
    expect(authorization).toEqual(["Bearer token-one", "Bearer token-one"]);
    expect(tokenProvider).toHaveBeenCalledOnce();
    expect(cursors).toEqual([null, "evt-1"]);
    expect(result.data.latestEventId).toBe("evt-2");
  });

  test("rejects an event cursor that cannot be replayed as Last-Event-ID", async () => {
    const cursor = "x".repeat(513);
    const event = {
      schema_version: "1.0",
      event_id: cursor,
      cursor,
      emitted_at: "2026-07-14T00:00:00.000Z",
      event_type: "run.progress",
      emitted_by: "daemon:blade",
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`id: ${cursor}\ndata: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    });
    const admin = createCalyxAdminClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      retry: { sseReconnectAttempts: 0 },
      fetch: async () => new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000001",
        },
      }),
    });

    const result = await admin.admin.events();
    if (!result.ok) throw new Error(`SSE cursor fixture failed before streaming: ${result.kind}`);
    const closed = result.data.closed.catch((error: unknown) => error);
    await expect(result.data[Symbol.asyncIterator]().next()).rejects.toThrow(/generated structural contract/u);
    await expect(closed).resolves.toMatchObject({ message: expect.stringMatching(/generated structural contract/u) });
    expect(result.data.latestEventId).toBeUndefined();
  });

  test("rejects an event-derived cursor with a replay-header control character", async () => {
    const cursor = "evt-control-\u0001";
    const event = {
      schema_version: "1.0",
      event_id: cursor,
      cursor,
      emitted_at: "2026-07-14T00:00:00.000Z",
      event_type: "run.progress",
      emitted_by: "daemon:blade",
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`id: ${cursor}\ndata: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    });
    const admin = createCalyxAdminClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      retry: { sseReconnectAttempts: 0 },
      fetch: async () => new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000001",
        },
      }),
    });

    const result = await admin.admin.events();
    if (!result.ok) throw new Error(`SSE cursor fixture failed before streaming: ${result.kind}`);
    const closed = result.data.closed.catch((error: unknown) => error);
    await expect(result.data[Symbol.asyncIterator]().next()).rejects.toThrow(/Last-Event-ID contract/u);
    await expect(closed).resolves.toMatchObject({ message: expect.stringMatching(/Last-Event-ID contract/u) });
    expect(result.data.latestEventId).toBeUndefined();
  });

  test("validates a caller-supplied Last-Event-ID pattern before credentials", async () => {
    const tokenProvider = vi.fn(() => "secret-token");
    const fetchImplementation = vi.fn<typeof fetch>();
    const plan: OperationPlan = {
      ...adminOperationPlans["admin.events"],
      lastEventIdPattern: "^evt-[0-9]+$",
    };
    const transport = new CalyxTransport(
      {
        baseUrl: "https://blade.example",
        bearerToken: tokenProvider,
        fetch: fetchImplementation,
      },
      { [plan.operationId]: plan },
      fixtureBearerTokenContract,
    );

    await expect(transport.execute("admin", plan, { lastEventId: "attacker-controlled" }))
      .rejects.toThrow(/generated replay-header contract/u);
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  test("cancels a rejected SSE reconnect body", async () => {
    const reconnectCancel = vi.fn();
    const firstBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("fixture connection loss"));
      },
    });
    const rejectedReconnectBody = new ReadableStream<Uint8Array>({ cancel: reconnectCancel });
    let connectionCount = 0;
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      retry: { sseReconnectAttempts: 1 },
      fetch: async () => {
        connectionCount += 1;
        return new Response(connectionCount === 1 ? firstBody : rejectedReconnectBody, {
          status: 200,
          headers: {
            "content-type": connectionCount === 1 ? "text/event-stream" : "text/plain",
            "x-calyx-request-id": `req_00000000-0000-4000-8000-${String(connectionCount).padStart(12, "0")}`,
          },
        });
      },
    });

    const result = await client.consumer.work.observe();
    if (!result.ok) throw new Error(`SSE rejection fixture failed before streaming: ${result.kind}`);
    const closed = result.data.closed.catch((error: unknown) => error);
    const iterator = result.data[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/unexpected media type/u);
    await expect(closed).resolves.toMatchObject({ message: expect.stringMatching(/unexpected media type/u) });
    expect(reconnectCancel).toHaveBeenCalledOnce();
  });

  test("validates optional success headers on SSE reconnect before exposing the replacement body", async () => {
    const reconnectCancel = vi.fn();
    const firstBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("fixture connection loss"));
      },
    });
    const rejectedReconnectBody = new ReadableStream<Uint8Array>({ cancel: reconnectCancel });
    const plan = withOptionalSuccessHeader(adminOperationPlans["admin.events"]);
    let connectionCount = 0;
    const transport = new CalyxTransport(
      {
        baseUrl: "https://blade.example",
        bearerToken: "token",
        retry: { sseReconnectAttempts: 1 },
        fetch: async () => {
          connectionCount += 1;
          return new Response(connectionCount === 1 ? firstBody : rejectedReconnectBody, {
            status: plan.success[0]!.status,
            headers: {
              "content-type": "text/event-stream",
              "x-calyx-request-id": `req_00000000-0000-4000-8000-${String(connectionCount).padStart(12, "0")}`,
              "x-optional-proof": connectionCount === 1 ? "safe" : "attacker-controlled",
            },
          });
        },
      },
      { [plan.operationId]: plan },
      fixtureBearerTokenContract,
    );

    const result = await transport.execute("admin", plan, {});
    if (!result.ok) throw new Error("SSE optional-header fixture failed before streaming.");
    const stream = result.data as {
      readonly closed: Promise<void>;
      [Symbol.asyncIterator](): AsyncIterator<unknown>;
    };
    const closed = stream.closed.catch((error: unknown) => error);
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(
      /SSE reconnect header x-optional-proof violates its generated schema/u,
    );
    await expect(closed).resolves.toBeInstanceOf(Error);
    expect(reconnectCancel).toHaveBeenCalledOnce();
  });

  test("keeps the prepared Last-Event-ID when caller state mutates before the first SSE response", async () => {
    const cursors: Array<string | null> = [];
    const firstBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("fixture connection loss before an event"));
      },
    });
    const secondBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`id: resumed\ndata: ${JSON.stringify(observationEvent("resumed"))}\n\n`));
        controller.close();
      },
    });
    let connectionCount = 0;
    let releaseToken!: (token: string) => void;
    const token = new Promise<string>((resolve) => { releaseToken = resolve; });
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: () => token,
      retry: { sseReconnectAttempts: 1 },
      fetch: async (_input, init) => {
        connectionCount += 1;
        cursors.push(new Headers(init?.headers).get("last-event-id"));
        return new Response(connectionCount === 1 ? firstBody : secondBody, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-calyx-request-id": `req_00000000-0000-4000-8000-${String(connectionCount).padStart(12, "0")}`,
          },
        });
      },
    });

    const request = { lastEventId: "seed" };
    const pending = client.consumer.work.observe(request);
    request.lastEventId = "x".repeat(513);
    releaseToken("token");
    const result = await pending;
    if (!result.ok) throw new Error(`SSE fixture failed before streaming: ${result.kind}`);
    const events = [];
    for await (const event of result.data) events.push(event);
    expect(events).toHaveLength(1);
    expect(cursors).toEqual(["seed", "seed"]);
    expect(result.data.latestEventId).toBe("resumed");
  });

  test("rejects invalid generated header values before credentials", async () => {
    const tokenProvider = vi.fn(() => "token");
    const client = createCalyxClient({ baseUrl: "https://blade.example", bearerToken: tokenProvider });
    const admin = createCalyxAdminClient({ baseUrl: "https://blade.example", bearerToken: tokenProvider });

    await expect(client.consumer.work.observe({ lastEventId: "line\nbreak" })).rejects.toThrow(/lastEventId/u);
    await expect(client.consumer.work.observe({ lastEventId: "x".repeat(513) })).rejects.toThrow(
      /generated replay-header contract/u,
    );
    await expect(admin.admin.run.reconcilePreserving({
      assertedActor: `operator:${"a".repeat(249)}`,
    })).rejects.toThrow(/assertedActor/u);
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  test("measures generated Last-Event-ID bounds in Unicode code points", async () => {
    const cursor = "💚".repeat(512);
    let observedCursor: string | null = null;
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: async (_input, init) => {
        observedCursor = (init?.headers as Record<string, string> | undefined)?.["Last-Event-ID"] ?? null;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }), {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000001",
          },
        });
      },
    });

    const result = await client.consumer.work.observe({ lastEventId: cursor });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) await result.data.closed;
    expect(observedCursor).toBe(cursor);
  });

  test("fails an SSE stream on an unknown event schema major", async () => {
    const future = { ...observationEvent("evt-future"), schema_version: "calyx.run-observation-event/v2" };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`id: evt-future\ndata: ${JSON.stringify(future)}\n\n`));
        controller.close();
      },
    });
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      retry: { sseReconnectAttempts: 0 },
      fetch: async () => new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000006",
        },
      }),
    });

    const result = await client.consumer.work.observe();
    if (!result.ok) throw new Error(`SSE fixture failed before streaming: ${result.kind}`);
    const closed = result.data.closed.catch((error: unknown) => error);
    await expect(result.data[Symbol.asyncIterator]().next()).rejects.toThrow(/structural contract/u);
    await expect(closed).resolves.toBeInstanceOf(Error);
  });

  test("rejects undeclared fields in closed SSE gap variants", async () => {
    const gap = {
      schema_version: "calyx.run-observation-gap/v1",
      cursor: "evt-gap",
      event_type: "run.projection_gap",
      gap: {
        reason: "source_event_unrepresentable",
        source_event_type: "run.progress",
        undeclared: "must fail closed",
      },
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`id: evt-gap\ndata: ${JSON.stringify(gap)}\n\n`));
        controller.close();
      },
    });
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      retry: { sseReconnectAttempts: 0 },
      fetch: async () => new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000008",
        },
      }),
    });

    const result = await client.consumer.work.observe();
    if (!result.ok) throw new Error(`SSE gap fixture failed before streaming: ${result.kind}`);
    const closed = result.data.closed.catch((error: unknown) => error);
    await expect(result.data[Symbol.asyncIterator]().next()).rejects.toThrow(/structural contract/u);
    await expect(closed).resolves.toBeInstanceOf(Error);
  });

  test("streams attachment bytes and validates the matching HEAD metadata", async () => {
    const sha256 = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
    const attachmentRef = `att:sha256:${sha256}`;
    const binaryHeaders = {
      "content-length": "3",
      "content-type": "application/octet-stream",
      digest: "sha-256=A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc+4E=",
      etag: `"sha256:${sha256}"`,
      "x-calyx-attachment-ref": attachmentRef,
      "x-calyx-origin-host": "carbon",
      "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000002",
      "x-calyx-served-by-host": "blade",
      "x-calyx-source-tier": "origin-daemon",
    };
    const invalidMetadataCancel = vi.fn();
    const invalidOptionalHeaderCancel = vi.fn();
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: binaryHeaders }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: binaryHeaders }))
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: { ...binaryHeaders, "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000003" },
      }))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel: invalidMetadataCancel }), {
        status: 200,
        headers: {
          ...binaryHeaders,
          digest: "md5=forbidden",
          "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000004",
        },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 4]), {
        status: 200,
        headers: { ...binaryHeaders, "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000005" },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 4]), {
        status: 200,
        headers: { ...binaryHeaders, "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000006" },
      }))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel: invalidOptionalHeaderCancel }), {
        status: 200,
        headers: {
          ...binaryHeaders,
          "x-calyx-origin-host": "bad host",
          "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000007",
        },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: {
          ...binaryHeaders,
          "x-calyx-served-by-host": "bad host",
          "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000008",
        },
      }));
    const admin = createCalyxAdminClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    const bytes = await admin.admin.activity.attachmentBytes({ path: { activityId: "run:fixture", ref: attachmentRef } });
    if (!bytes.ok) throw new Error(`Binary fixture failed: ${bytes.kind}`);
    expect(bytes.data).toMatchObject({
      contentLength: 3,
      contentType: "application/octet-stream",
      attachmentRef,
      originHost: "carbon",
      servedByHost: "blade",
      requestId: "req_00000000-0000-4000-8000-000000000002",
    });
    expect(bytes.data.body).toBeInstanceOf(ReadableStream);
    await expect(new Response(bytes.data.body).arrayBuffer()).resolves.toEqual(Uint8Array.from([1, 2, 3]).buffer);
    await expect(bytes.data.verified).resolves.toBeUndefined();

    const buffered = await admin.admin.activity.attachmentBytes({ path: { activityId: "run:fixture", ref: attachmentRef } });
    if (!buffered.ok) throw new Error(`Buffered binary fixture failed: ${buffered.kind}`);
    await expect(bufferVerifiedBinary(buffered.data)).resolves.toEqual(Uint8Array.from([1, 2, 3]));

    const head = await admin.admin.activity.attachmentBytesHead({ path: { activityId: "run:fixture", ref: attachmentRef } });
    expect(head).toMatchObject({
      ok: true,
      data: { contentLength: 3, requestId: "req_00000000-0000-4000-8000-000000000003" },
    });
    await expect(admin.admin.activity.attachmentBytes({
      path: { activityId: "run:fixture", ref: attachmentRef },
    })).resolves.toMatchObject({ ok: false, kind: "protocol", stage: "invalid_response" });
    expect(invalidMetadataCancel).toHaveBeenCalledOnce();

    const digestMismatch = await admin.admin.activity.attachmentBytes({
      path: { activityId: "run:fixture", ref: attachmentRef },
    });
    if (!digestMismatch.ok) throw new Error(`Digest mismatch fixture failed before streaming: ${digestMismatch.kind}`);
    const verified = digestMismatch.data.verified.catch((error: unknown) => error);
    await expect(new Response(digestMismatch.data.body).arrayBuffer()).rejects.toThrow(/digest/u);
    await expect(verified).resolves.toMatchObject({ message: expect.stringMatching(/digest/u) });

    const bufferedMismatch = await admin.admin.activity.attachmentBytes({
      path: { activityId: "run:fixture", ref: attachmentRef },
    });
    if (!bufferedMismatch.ok) throw new Error(`Buffered digest fixture failed before streaming: ${bufferedMismatch.kind}`);
    await expect(bufferVerifiedBinary(bufferedMismatch.data)).rejects.toThrow(/digest/u);

    await expect(admin.admin.activity.attachmentBytes({
      path: { activityId: "run:fixture", ref: attachmentRef },
    })).resolves.toMatchObject({ ok: false, kind: "protocol", stage: "invalid_response" });
    expect(invalidOptionalHeaderCancel).toHaveBeenCalledOnce();
    await expect(admin.admin.activity.attachmentBytesHead({
      path: { activityId: "run:fixture", ref: attachmentRef },
    })).resolves.toMatchObject({ ok: false, kind: "protocol", stage: "invalid_response" });
  });

  test.each(["bytes", "head"] as const)(
    "binds %s custody to the path identity actually prepared before token resolution",
    async (representation) => {
      const requestedSha = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
      const mutatedSha = "139058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
      const requestedRef = `att:sha256:${requestedSha}`;
      const mutatedRef = `att:sha256:${mutatedSha}`;
      let releaseToken!: (token: string) => void;
      const token = new Promise<string>((resolve) => { releaseToken = resolve; });
      let requestedUrl = "";
      const admin = createCalyxAdminClient({
        baseUrl: "https://blade.example",
        bearerToken: () => token,
        retry: { maxAttempts: 1 },
        fetch: async (input) => {
          requestedUrl = String(input);
          return new Response(
            representation === "bytes" ? new Uint8Array([1, 2, 3]) : null,
            {
              status: 200,
              headers: {
                "content-type": "application/octet-stream",
                "content-length": "3",
                etag: `"sha256:${mutatedSha}"`,
                digest: `sha-256=${Buffer.from(mutatedSha, "hex").toString("base64")}`,
                "x-calyx-attachment-ref": mutatedRef,
                "x-calyx-source-tier": "origin-daemon",
                "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000001",
              },
            },
          );
        },
      });
      const request = { path: { activityId: "run:fixture", ref: requestedRef } };
      const pending = representation === "bytes"
        ? admin.admin.activity.attachmentBytes(request)
        : admin.admin.activity.attachmentBytesHead(request);
      request.path.ref = mutatedRef;
      releaseToken("token");

      await expect(pending).resolves.toMatchObject({
        ok: false,
        kind: "protocol",
        stage: "custody_mismatch",
      });
      expect(decodeURIComponent(requestedUrl)).toContain(requestedRef);
      expect(decodeURIComponent(requestedUrl)).not.toContain(mutatedRef);
    },
  );

  test("accepts prepared binary custody when caller path state mutates during credential resolution", async () => {
    const requestedSha = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
    const mutatedSha = "139058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
    const requestedRef = `att:sha256:${requestedSha}`;
    const mutatedRef = `att:sha256:${mutatedSha}`;
    let releaseToken!: (token: string) => void;
    const token = new Promise<string>((resolve) => { releaseToken = resolve; });
    const admin = createCalyxAdminClient({
      baseUrl: "https://blade.example",
      bearerToken: () => token,
      fetch: async () => new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "3",
          etag: `"sha256:${requestedSha}"`,
          digest: `sha-256=${Buffer.from(requestedSha, "hex").toString("base64")}`,
          "x-calyx-attachment-ref": requestedRef,
          "x-calyx-source-tier": "origin-daemon",
          "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000001",
        },
      }),
    });
    const request = { path: { activityId: "run:fixture", ref: requestedRef } };

    const pending = admin.admin.activity.attachmentBytes(request);
    request.path.ref = mutatedRef;
    releaseToken("token");

    const result = await pending;
    if (!result.ok) throw new Error(`Prepared binary custody fixture failed: ${result.kind}`);
    expect(result.data.attachmentRef).toBe(requestedRef);
    await expect(new Response(result.data.body).arrayBuffer()).resolves.toEqual(
      Uint8Array.from([1, 2, 3]).buffer,
    );
    await expect(result.data.verified).resolves.toBeUndefined();
  });

  test("enforces declared and streamed JSON response bounds", async () => {
    const declaredCancel = vi.fn();
    const streamedCancel = vi.fn();
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8_388_609));
        controller.enqueue(new Uint8Array(8_388_608));
      },
      cancel: streamedCancel,
    });
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel: declaredCancel }), {
        status: 200,
        headers: { ...requestHeaders, "content-length": "16777217" },
      }))
      .mockResolvedValueOnce(new Response(oversizedStream, { status: 200, headers: requestHeaders }));
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    const declared = await client.consumer.msg.doctor();
    expect(declared).toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "response_too_large",
      rawBodySnippet: "",
      rawBodyBytes: 0,
      rawBodyComplete: false,
      responseHeaders: { "content-length": "16777217" },
    });
    expect(declaredCancel).toHaveBeenCalledOnce();
    const streamed = await client.consumer.msg.doctor();
    expect(streamed).toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "response_too_large",
      rawBodyBytes: 16_777_217,
      rawBodyComplete: false,
    });
    expect(streamedCancel).toHaveBeenCalledOnce();
  });

  test("enforces response cross-field contracts", async () => {
    const sha256 = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
    const mismatchedSha256 = "139058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
    const attachment = {
      ref: `att:sha256:${sha256}`,
      sha256: mismatchedSha256,
      mime_type: "application/octet-stream",
      byte_size: 3,
      source_shape: "event",
      exact_bytes_available: true,
      activity_id: "run:fixture",
      message_id: "msg-fixture",
      source_line: 1,
      event_index: 1,
      source_tier: "origin-daemon",
      schema_version: "activity.attachment-record/v1",
      classifier_version: "fixture-v1",
      source_receipt: {
        mode: "streaming",
        bytes_scanned: 3,
        records_scanned: 1,
        records_decoded: 1,
        oversized_records_skipped: 0,
        max_record_bytes: 1024,
        guard_hits: [],
      },
    };
    const reconcile = {
      schema_version: "calyx.admin-reconcile-result/v1",
      status: "completed",
      scanned: 1,
      changed: {
        rebuilt: 0,
        repair_pending: 0,
        classified: 0,
        adopted: 0,
        skipped: 0,
        unresolved: 1,
        noncanonical_directories: 0,
      },
      unresolved: [{ reason: "canonical_run_record_missing", count: 2 }],
      noncanonical_directories: [],
      projection: { status: "not_configured" },
      completed_at: "2026-07-14T00:00:00.000Z",
    };
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(attachment), { status: 200, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response(JSON.stringify(reconcile), { status: 200, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response(JSON.stringify(reconcile), { status: 200, headers: requestHeaders }));
    const admin = createCalyxAdminClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    await expect(admin.admin.activity.attachmentRecord({
      path: { activityId: "run:fixture", ref: attachment.ref },
    })).resolves.toMatchObject({ ok: false, kind: "protocol", stage: "invalid_response" });
    await expect(admin.admin.run.reconcilePreserving()).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "invalid_response",
      attempts: 2,
    });
  });

  test("pins portable run launch negotiation and never supplies request identity", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const headers = new Headers(init?.headers);
      expect(String(input)).toBe("https://blade.example/proxy/v1/admin/runs");
      expect(headers.get("accept")).toBe("application/vnd.polli.calyx.run-launch-receipt+json;version=1");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.has("x-calyx-request-id")).toBe(false);
      expect(JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8"))).toEqual({
        idempotency_key: "launch-fixture",
        intent: {
          created_at: "2026-07-14T00:00:00.000Z",
          host: "blade",
          host_process: {
            argv: ["echo", "fixture"],
            env: { KEEP: "yes", UNSET: null },
          },
          run_id: "run:fixture",
          template_vars: { ALPHA: "one", ZETA: "two" },
        },
        schema_version: "calyx.run-launch-request/v1",
        topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
      });
      return new Response(JSON.stringify({
        schema_version: "calyx.run-launch-result/v1",
        status: "accepted",
        run_id: "run:fixture",
        operation: {
          route: "/v1/admin/runs/run%3Afixture",
          events_route: "/v1/admin/runs/run%3Afixture/events",
          receipt_route: "/v1/admin/runs/run%3Afixture/receipt",
        },
      }), {
        status: 202,
        headers: {
          "content-type": "application/vnd.polli.calyx.run-launch-receipt+json;version=1",
          "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000007",
        },
      });
    });
    const admin = createCalyxAdminClient({
      baseUrl: "https://blade.example/proxy",
      bearerToken: "token",
      fetch: fetchImplementation,
    });

    await expect(admin.admin.run.launch({
      body: {
        schema_version: "calyx.run-launch-request/v1",
        intent: {
          run_id: "run:fixture",
          host: "blade",
          created_at: "2026-07-14T00:00:00.000Z",
          template_vars: { ZETA: "two", ALPHA: "one" },
          host_process: {
            argv: ["echo", "fixture"],
            env: { KEEP: "yes", UNSET: null },
            unknown_sibling: "must not cross",
          },
          unknown_sibling: "must not cross",
        },
        idempotency_key: "launch-fixture",
        topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
      } as never,
    })).resolves.toMatchObject({
      ok: true,
      status: 202,
      requestId: "req_00000000-0000-4000-8000-000000000007",
    });
  });

  test("preserves same-major additive fields even when an old sibling union branch names them", async () => {
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: async () => new Response(JSON.stringify({
        schema_version: "calyx.run-observation/v1",
        kind: "interactive",
        run_id: "interactive:codex:session-skew",
        short_id: "session-skew",
        host: "blade",
        backend: "codex",
        status: "interactive",
        health: "healthy",
        created_at: "2026-07-14T00:00:00.000Z",
        updated_at: "2026-07-14T00:01:00.000Z",
        issue: "POL-FUTURE",
      }), { status: 200, headers: requestHeaders }),
    });

    await expect(client.consumer.work.get({
      path: { runId: "interactive:codex:session-skew" },
    })).resolves.toMatchObject({ ok: true, data: { issue: "POL-FUTURE" } });
  });

  test("rejects malformed response formats and inexact integer wire lexemes", async () => {
    const baseRun = {
      schema_version: "calyx.run-observation/v1",
      kind: "run",
      run_id: "run:fixture",
      short_id: "fixture",
      host: "blade",
      backend: "codex",
      status: "running",
      health: "healthy",
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z",
    };
    const invalidIntegerDoctors = [
      "9007199254740993",
      "9007199254740991.1",
      "0.99999999999999999",
      "90071992547409911e-1",
    ].map((lexeme) => JSON.stringify(doctorBody()).replace('"total":0', `"total":${lexeme}`));
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...baseRun, created_at: "2026-02-29T00:00:00Z" }), {
        status: 200,
        headers: requestHeaders,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...baseRun, pr_url: "/relative/pr" }), {
        status: 200,
        headers: requestHeaders,
      }))
      .mockResolvedValueOnce(new Response(invalidIntegerDoctors[0], { status: 200, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response(invalidIntegerDoctors[1], { status: 200, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response(invalidIntegerDoctors[2], { status: 200, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response(invalidIntegerDoctors[3], { status: 200, headers: requestHeaders }));
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
      retry: { maxAttempts: 1 },
    });

    await expect(client.consumer.work.get({ path: { runId: "run:fixture" } })).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "invalid_response",
    });
    await expect(client.consumer.work.get({ path: { runId: "run:fixture" } })).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "invalid_response",
    });
    for (let index = 0; index < invalidIntegerDoctors.length; index += 1) {
      await expect(client.consumer.msg.doctor()).resolves.toMatchObject({
        ok: false,
        kind: "protocol",
        stage: "invalid_response",
      });
    }
  });

  test("uses exact mathematical JSON tokens for closed number literals", async () => {
    const numberDecoder = g.response(
      g.responseNumber(false, undefined, false, undefined, false),
      false,
      undefined,
      [],
      [],
      [],
      false,
      undefined,
      [0],
      [],
    );
    const jsonPlan: OperationPlan = {
      ...adminOperationPlans["msg.doctor"],
      success: adminOperationPlans["msg.doctor"].success.map((success) => ({
        ...success,
        decoder: numberDecoder,
      })),
    };
    const ssePlan: OperationPlan = {
      ...adminOperationPlans["admin.events"],
      success: adminOperationPlans["admin.events"].success.map((success) => ({
        ...success,
        decoder: numberDecoder,
      })),
    };
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("1e-400", { status: 200, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response("0e+400", { status: 200, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response("0e9007199254740992", { status: 200, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response("id: evt-1\ndata: 1e-400\n\n", {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000003",
        },
      }));
    const transport = new CalyxTransport(
      {
        baseUrl: "https://blade.example",
        bearerToken: "token",
        fetch: fetchImplementation,
        retry: { maxAttempts: 1, sseReconnectAttempts: 0 },
      },
      { [jsonPlan.operationId]: jsonPlan, [ssePlan.operationId]: ssePlan },
      fixtureBearerTokenContract,
    );

    await expect(transport.execute("admin", jsonPlan)).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "invalid_response",
    });
    await expect(transport.execute("admin", jsonPlan)).resolves.toMatchObject({ ok: true, data: 0 });
    await expect(transport.execute("admin", jsonPlan)).resolves.toMatchObject({ ok: true, data: 0 });
    const streamResult = await transport.execute<number>("admin", ssePlan);
    if (!streamResult.ok) throw new Error(`SSE number-literal fixture failed before streaming: ${streamResult.kind}`);
    const stream = streamResult.data as CalyxEventStream<number>;
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(/structural contract/u);
  });

  test("decodes both local-inert and cross-host msg.send success representations", async () => {
    const local = {
      schema_version: "calyx.msg-send-result/v1",
      inserted: true,
      message: messageObservation(),
      delivery_state: "inert",
    };
    const outbox = {
      schema_version: "calyx.msg-send-result/v1",
      inserted: true,
      message: messageObservation({ status: "outbox" }),
      delivery_state: "outbox",
      operation: {
        status: "accepted",
        locator: "/v1/message-operations/outbox-fixture",
        receipt_locator: "/v1/message-operations/outbox-fixture/receipt",
      },
      outbox: {
        outbox_id: "outbox-fixture",
        target_host: "carbon",
        status: "pending",
        created_at: "2026-07-14T00:00:00.000Z",
        expires_at: "2026-07-15T00:00:00.000Z",
      },
    };
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(local), { status: 200, headers: requestHeaders }))
      .mockResolvedValueOnce(new Response(JSON.stringify(outbox), { status: 202, headers: requestHeaders }));
    const client = createCalyxClient({ baseUrl: "https://blade.example", bearerToken: "token", fetch: fetchImplementation });
    const body = {
      schema_version: "calyx.msg-send/v1" as const,
      idempotency_key: "msg-fixture",
      recipient_address: "client:switchboard@blade",
      reply_address: "client:switchboard@blade",
      subject: "fixture",
    };

    await expect(client.consumer.msg.send({ body })).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { delivery_state: "inert" },
    });
    await expect(client.consumer.msg.send({ body: { ...body, idempotency_key: "msg-outbox-fixture" } })).resolves.toMatchObject({
      ok: true,
      status: 202,
      data: { delivery_state: "outbox", outbox: { outbox_id: "outbox-fixture" } },
    });
  });
});

describe("SSE framing", () => {
  test("parses fragmented UTF-8, multiline data, ids, comments, and clean EOF", async () => {
    const encoded = new TextEncoder().encode(': keepalive\r\nevent: fixture\r\nretry: 10\r\nid: evt-1\r\ndata: {"word":\r\ndata: "polliné"}\r\n\r\n');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, encoded.length - 2));
        controller.enqueue(encoded.slice(encoded.length - 2));
        controller.close();
      },
    });
    const stream = createCalyxEventStream<{ word: string }>(
      body,
      (value) => typeof value === "object" && value !== null && "word" in value,
      () => "evt-1",
    );

    const events: Array<{ word: string }> = [];
    for await (const event of stream) events.push(event);
    await stream.closed;
    expect(events).toEqual([{ word: "polliné" }]);
    expect(stream.latestEventId).toBe("evt-1");
  });

  test("fails the iterable and closed promise on malformed event JSON", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"word":}\n\n'));
        controller.close();
      },
    });
    const stream = createCalyxEventStream<{ word: string }>(body, () => true, () => undefined);
    const closed = stream.closed.catch((error: unknown) => error);

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow();
    await expect(closed).resolves.toBeInstanceOf(Error);
  });

  test("fails before buffering an oversized unterminated wire frame", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: 1234"));
        controller.enqueue(new TextEncoder().encode("567890"));
        controller.close();
      },
    });
    const stream = createCalyxEventStream<{ word: string }>(body, () => true, () => undefined, undefined, undefined, 12);
    const closed = stream.closed.catch((error: unknown) => error);

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(/12 wire bytes/u);
    await expect(closed).resolves.toMatchObject({ message: expect.stringMatching(/12 wire bytes/u) });
  });

  test("caller cancellation terminates a pending stream", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>();
    const stream = createCalyxEventStream<{ word: string }>(body, () => true, () => undefined, controller.signal);
    const closed = stream.closed.catch((error: unknown) => error);
    const next = stream[Symbol.asyncIterator]().next();

    controller.abort();
    await expect(next).rejects.toThrow(/aborted/u);
    await expect(closed).resolves.toMatchObject({ message: expect.stringMatching(/aborted/u) });
  });
});
