import { afterEach, describe, expect, test, vi } from "vitest";

import { CalyxSseProtocolError, createCalyxEventStream } from "../sse.js";

interface CursorEvent {
  readonly cursor?: string;
  readonly value: number;
}

const encoder = new TextEncoder();
const validateCursorEvent = (value: unknown): boolean => (
  typeof value === "object"
  && value !== null
  && "value" in value
  && typeof value.value === "number"
);
const selectCursor = (value: CursorEvent): string | undefined => value.cursor;
const frame = (cursor: string, value: number, id = cursor): Uint8Array => (
  encoder.encode(`id: ${id}\ndata: ${JSON.stringify({ cursor, value })}\n\n`)
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Calyx SSE transport", () => {
  test("backpressures application events at one item when the caller does not consume", async () => {
    let pulls = 0;
    const cancelled = vi.fn();
    const bodies = [frame("one", 1), frame("two", 2), frame("three", 3)];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        const next = bodies.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
      cancel: cancelled,
    }, { highWaterMark: 0 });
    const stream = createCalyxEventStream<CursorEvent>(body, validateCursorEvent, selectCursor);

    await vi.waitFor(() => expect(pulls).toBe(1));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(pulls).toBe(1);

    stream.cancel();
    await expect(stream.closed).rejects.toThrow(/aborted/u);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  test("cancels the response body after a local frame-bound protocol rejection", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: this-frame-never-terminates"));
      },
      cancel: cancelled,
    });
    const stream = createCalyxEventStream<CursorEvent>(
      body,
      validateCursorEvent,
      selectCursor,
      undefined,
      undefined,
      12,
    );

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(CalyxSseProtocolError);
    await expect(stream.closed).rejects.toThrow(/exceeds 12 wire bytes/u);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  test("cancels an unclaimed initial response body for an already-aborted caller", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const caller = new AbortController();
    caller.abort();

    const stream = createCalyxEventStream<CursorEvent>(
      body,
      validateCursorEvent,
      selectCursor,
      caller.signal,
    );

    await expect(stream.closed).rejects.toThrow(/aborted/u);
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });

  test("breaking async iteration waits for active response cancellation", async () => {
    const cancelled = vi.fn();
    let finishCancellation!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame("one", 1));
      },
      cancel() {
        cancelled();
        return new Promise<void>((resolve) => {
          finishCancellation = resolve;
        });
      },
    });
    const stream = createCalyxEventStream<CursorEvent>(body, validateCursorEvent, selectCursor);

    let iterationReturned = false;
    const iteration = (async () => {
      for await (const event of stream) {
        expect(event).toEqual({ cursor: "one", value: 1 });
        break;
      }
      iterationReturned = true;
    })();

    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(iterationReturned).toBe(false);
    finishCancellation();
    await iteration;
    expect(iterationReturned).toBe(true);
    await expect(stream.closed).rejects.toThrow(/aborted/u);
  });

  test("accepts matching event ids and payload cursors across split multi-event input", async () => {
    const encoded = encoder.encode(
      'id: one\r\ndata: {"cursor":"one","value":1}\r\n\r\nid: two\ndata: {"cursor":"two","value":2}\n\n',
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 17));
        controller.enqueue(encoded.slice(17, encoded.length - 1));
        controller.enqueue(encoded.slice(encoded.length - 1));
        controller.close();
      },
    });
    const stream = createCalyxEventStream<CursorEvent>(body, validateCursorEvent, selectCursor);

    const events: CursorEvent[] = [];
    for await (const event of stream) events.push(event);

    await expect(stream.closed).resolves.toBeUndefined();
    expect(events).toEqual([
      { cursor: "one", value: 1 },
      { cursor: "two", value: 2 },
    ]);
    expect(stream.latestEventId).toBe("two");
  });

  test("dispatches a complete event terminated by bare CR line endings at EOF", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('id: one\rdata: {"cursor":"one","value":1}\r\r'));
        controller.close();
      },
    });
    const stream = createCalyxEventStream<CursorEvent>(body, validateCursorEvent, selectCursor);

    const events: CursorEvent[] = [];
    for await (const event of stream) events.push(event);

    expect(events).toEqual([{ cursor: "one", value: 1 }]);
    expect(stream.latestEventId).toBe("one");
    await expect(stream.closed).resolves.toBeUndefined();
  });

  test("treats invalid UTF-8 as terminal protocol failure and cancels without reconnecting", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff]));
      },
      cancel: cancelled,
    });
    const connect = vi.fn();
    const stream = createCalyxEventStream<CursorEvent>(body, validateCursorEvent, selectCursor, undefined, {
      maxAttempts: 1,
      minDelayMs: 0,
      maxDelayMs: 0,
      connect,
    });

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(/invalid UTF-8/u);
    expect(connect).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledOnce();
  });

  test("cancels a replacement body returned after caller abort wins a reconnect race", async () => {
    const caller = new AbortController();
    const initialBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    let resolveConnect!: (body: ReadableStream<Uint8Array>) => void;
    const connect = vi.fn(() => new Promise<ReadableStream<Uint8Array>>((resolve) => {
      resolveConnect = resolve;
    }));
    const stream = createCalyxEventStream<CursorEvent>(initialBody, validateCursorEvent, selectCursor, caller.signal, {
      maxAttempts: 1,
      minDelayMs: 0,
      maxDelayMs: 0,
      connect,
      random: () => 0.5,
    });

    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    caller.abort();
    const cancelled = vi.fn();
    resolveConnect(new ReadableStream<Uint8Array>({ cancel: cancelled }));

    await expect(stream.closed).rejects.toThrow(/aborted/u);
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });

  test.each([
    {
      name: "missing event id",
      input: encoder.encode('data: {"cursor":"untrusted","value":1}\n\n'),
      message: /required nonempty id/u,
    },
    {
      name: "missing payload cursor",
      input: encoder.encode('id: untrusted\ndata: {"value":1}\n\n'),
      message: /omitted.*payload cursor/u,
    },
    {
      name: "mismatched event id",
      input: frame("verified", 1, "untrusted"),
      message: /does not match/u,
    },
  ])("fails on $name without advancing the reconnect cursor", async ({ input, message }) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(input);
        controller.close();
      },
    });
    const stream = createCalyxEventStream<CursorEvent>(body, validateCursorEvent, selectCursor, undefined, {
      maxAttempts: 1,
      minDelayMs: 0,
      maxDelayMs: 0,
      initialEventId: "last-verified",
      connect: vi.fn(),
    });

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(message);
    expect(stream.latestEventId).toBe("last-verified");
  });

  test("rejects duplicate event id fields instead of trusting the parser's last value", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'id: untrusted\nid: verified\ndata: {"cursor":"verified","value":1}\n\n',
        ));
        controller.close();
      },
    });
    const stream = createCalyxEventStream<CursorEvent>(body, validateCursorEvent, selectCursor);

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(/duplicate id fields/u);
    expect(stream.latestEventId).toBeUndefined();
  });

  test("retains exact number lexemes for generated SSE validation", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'id: verified\ndata: {"cursor":"verified","value":0.99999999999999999}\n\n',
        ));
        controller.close();
      },
    });
    const stream = createCalyxEventStream<CursorEvent>(
      body,
      (value, numberLexemes) => (
        typeof value === "object"
        && value !== null
        && numberLexemes?.byContainer.get(value)?.get("value") === "1"
      ),
      selectCursor,
    );

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(/generated structural contract/u);
    expect(stream.latestEventId).toBeUndefined();
  });

  test("reconnects with the last event id verified against its payload cursor", async () => {
    let firstPull = true;
    const initialBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (firstPull) {
          firstPull = false;
          controller.enqueue(frame("verified", 1));
          return;
        }
        controller.error(new Error("connection lost"));
      },
    }, { highWaterMark: 0 });
    const connect = vi.fn<(
      lastEventId: string | undefined,
      signal: AbortSignal,
    ) => Promise<ReadableStream<Uint8Array>>>(async () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }));
    const stream = createCalyxEventStream<CursorEvent>(initialBody, validateCursorEvent, selectCursor, undefined, {
      maxAttempts: 1,
      minDelayMs: 0,
      maxDelayMs: 0,
      connect,
      random: () => 0.5,
    });
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: { cursor: "verified", value: 1 } });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });

    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0]?.[0]).toBe("verified");
    await expect(stream.closed).resolves.toBeUndefined();
  });

  test("handles closed internally when the caller observes only iterator failure", async () => {
    const unhandled: unknown[] = [];
    const recordUnhandled = (failure: unknown): void => {
      unhandled.push(failure);
    };
    process.on("unhandledRejection", recordUnhandled);
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('id: bad\ndata: {"cursor":"bad","value":}\n\n'));
          controller.close();
        },
      });
      const stream = createCalyxEventStream<CursorEvent>(body, validateCursorEvent, selectCursor);

      await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }
  });
});
