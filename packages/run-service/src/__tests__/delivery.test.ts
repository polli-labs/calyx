import { afterEach, describe, expect, test, vi } from "vitest";

import {
  type DeliveryV1Fetch,
  postJsonDeliveryV1,
  postTextDeliveryV1,
} from "../delivery.js";

describe("delivery timeout custody", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("clears text and JSON delivery timers after the complete response settles", async () => {
    vi.useFakeTimers();
    const fetchImpl: DeliveryV1Fetch = vi.fn(async (url) => ({
      ok: true,
      status: 200,
      text: async () => "{}",
      body: null,
      url,
    }));

    await postTextDeliveryV1(fetchImpl, "http://blade:8740/text", {
      body: "hello",
      timeoutMs: 30_000,
    });
    expect(vi.getTimerCount()).toBe(0);

    await postJsonDeliveryV1(fetchImpl, "http://blade:8740/json", {
      body: { hello: "world" },
      timeoutMs: 30_000,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("keeps the abort deadline live until response-body settlement", async () => {
    vi.useFakeTimers();
    const fetchImpl: DeliveryV1Fetch = vi.fn(async (_url, init) => ({
      ok: true,
      status: 200,
      text: () => new Promise<string>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("delivery aborted")), { once: true });
      }),
      body: null,
    }));

    const delivery = postTextDeliveryV1(fetchImpl, "http://blade:8740/text", {
      body: "hello",
      timeoutMs: 50,
    });
    const rejected = expect(delivery).rejects.toThrow("delivery aborted");
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
