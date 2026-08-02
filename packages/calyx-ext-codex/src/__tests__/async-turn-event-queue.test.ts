import { describe, expect, it } from "vitest";
import type { TurnEvent } from "@polli-labs/calyx-runner";
import { AsyncTurnEventQueue } from "../runtime/index.js";

describe("AsyncTurnEventQueue", () => {
  it("delivers pushed events in order and closes cleanly", async () => {
    const queue = new AsyncTurnEventQueue();
    const iterator = queue[Symbol.asyncIterator]();
    const event: TurnEvent = {
      kind: "warning",
      payload: { message: "hello" },
    };

    queue.push(event);
    await expect(iterator.next()).resolves.toEqual({ done: false, value: event });

    queue.close();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("rejects pending iterators when the queue fails", async () => {
    const queue = new AsyncTurnEventQueue();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();

    queue.fail(new Error("boom"));

    await expect(pending).rejects.toThrow("boom");
  });

  it("ignores pushes after close", async () => {
    const queue = new AsyncTurnEventQueue();
    const iterator = queue[Symbol.asyncIterator]();

    queue.close();
    queue.push({
      kind: "warning",
      payload: { message: "ignored" },
    });

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
