import { describe, expect, test, vi } from "vitest";

import { createCalyxClient } from "../consumer.js";
import type { CalyxIndeterminateReceipt } from "../errors.js";

const recoveryReceiptIntegrityKey = Uint8Array.from({ length: 32 }, (_value, index) => index);

function sendBody(idempotencyKey: string) {
  return {
    schema_version: "calyx.msg-send/v1" as const,
    idempotency_key: idempotencyKey,
    recipient_address: "client:switchboard@carbon",
    reply_address: "client:operator_cli@blade",
    subject: "reservation proof",
    body: "sensitive exact request bytes",
  };
}

describe("keyed-write recovery reservation", () => {
  test("fails before dispatch when encrypted replay authority cannot be reserved", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const save = vi.fn();
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
      recoveryReceiptIntegrityKey,
      recoveryStore: {
        custody: "encrypted_access_controlled",
        reserve: () => { throw new Error("fixture reservation failure"); },
        save,
        release: () => undefined,
      },
    });

    await expect(client.consumer.msg.send({ body: sendBody("reserve-refused") })).resolves.toMatchObject({
      ok: false,
      kind: "transport",
      stage: "recovery_store",
      attempts: 0,
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  test("retains a shared reservation when one caller aborts before dispatch", async () => {
    const controller = new AbortController();
    const fetchImplementation = vi.fn<typeof fetch>();
    const release = vi.fn();
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
      bearerToken: "token",
      fetch: fetchImplementation,
      recoveryReceiptIntegrityKey,
      recoveryStore: {
        custody: "encrypted_access_controlled",
        reserve: () => { controller.abort(); },
        save: () => undefined,
        release,
      },
    });

    await expect(client.consumer.msg.send({
      body: sendBody("shared-aborted-reservation"),
      signal: controller.signal,
    })).resolves.toMatchObject({
      ok: false,
      kind: "transport",
      stage: "aborted",
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  test("retains the exact pre-dispatch receipt when final diagnostic persistence fails", async () => {
    const events: string[] = [];
    let reserved: CalyxIndeterminateReceipt | undefined;
    const release = vi.fn();
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      events.push("fetch");
      return new Response("{malformed", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000001",
        },
      });
    });
    const client = createCalyxClient({
      baseUrl: "https://blade.example/control",
      bearerToken: "token",
      fetch: fetchImplementation,
      retry: { maxAttempts: 1, recoveryAttempts: 1 },
      recoveryReceiptIntegrityKey,
      recoveryStore: {
        custody: "encrypted_access_controlled",
        reserve: (receipt) => {
          events.push("reserve");
          reserved = receipt;
        },
        save: () => {
          events.push("save");
          throw new Error("fixture finalization failure");
        },
        release,
      },
    });

    const result = await client.consumer.msg.send({ body: sendBody("reserved-exact-wire") });

    expect(events[0]).toBe("reserve");
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: false,
      kind: "indeterminate",
      persistenceFailure: { stage: "recovery_store" },
      receipt: { idempotency_key: "reserved-exact-wire" },
    });
    expect(reserved).toMatchObject({
      operation_id: "msg.send",
      path: "/control/v1/messages/send",
      idempotency_key: "reserved-exact-wire",
      attempts: 0,
      failure_stage: "reserved_before_dispatch",
    });
    expect(reserved?.body_bytes).toBe(
      result.ok || result.kind !== "indeterminate" ? undefined : result.receipt.body_bytes,
    );
    expect(release).not.toHaveBeenCalled();
  });

  test("releases the reservation after a definitive generated API result", async () => {
    const reserve = vi.fn();
    const save = vi.fn();
    const release = vi.fn();
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: {
        schema_version: "calyx.error/v1",
        code: "address_grant_forbidden",
        message: "fixture refusal",
        retryable: false,
      },
    }), {
      status: 403,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-calyx-request-id": "req_00000000-0000-4000-8000-000000000002",
      },
    }));
    const client = createCalyxClient({
      baseUrl: "https://blade.example",
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

    await expect(client.consumer.msg.send({ body: sendBody("definitive-refusal") })).resolves.toMatchObject({
      ok: false,
      kind: "api",
      status: 403,
    });
    expect(reserve).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(reserve.mock.calls[0]?.[0]);
    expect(save).not.toHaveBeenCalled();
  });
});
