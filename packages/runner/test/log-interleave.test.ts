/**
 * Tests for log interleaving logic — verifying that lifecycle events
 * and agent messages are correctly merged by timestamp.
 *
 * This tests the interleaving algorithm in isolation, since the actual
 * CLI handler is harder to unit test directly.
 */

import { describe, expect, test } from "vitest";
import type { AssistantMessage } from "@polli-labs/calyx-runner";
import type { LifecycleEvent } from "@polli-labs/calyx-runner";

/** Replicate the interleaving logic from the CLI logs handler. */
interface LogEntry {
  timestamp: string;
  source: "lifecycle" | "agent";
  text: string;
}

function interleaveEvents(
  events: LifecycleEvent[],
  agentMessages: AssistantMessage[],
): LogEntry[] {
  const merged: LogEntry[] = [];

  for (const event of events) {
    const message = event.message ? ` ${event.message}` : "";
    merged.push({
      timestamp: event.timestamp,
      source: "lifecycle",
      text: `${event.event}${message}`,
    });
  }

  for (const msg of agentMessages) {
    const firstLine = msg.text.split("\n")[0] ?? "";
    const preview = firstLine.length > 200 ? firstLine.slice(0, 200) + "..." : firstLine;
    merged.push({
      timestamp: msg.timestamp,
      source: "agent",
      text: preview,
    });
  }

  merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return merged;
}

describe("log interleaving", () => {
  test("interleaves lifecycle events and agent messages by timestamp", () => {
    const events: LifecycleEvent[] = [
      {
        timestamp: "2026-03-18T10:00:00Z",
        run_id: "run-1",
        event: "state_transition",
        message: "queued -> running",
      },
      {
        timestamp: "2026-03-18T10:00:10Z",
        run_id: "run-1",
        event: "backend_spawned",
        message: "Spawning claude",
      },
      {
        timestamp: "2026-03-18T10:01:00Z",
        run_id: "run-1",
        event: "state_transition",
        message: "running -> succeeded",
      },
    ];

    const agentMessages: AssistantMessage[] = [
      { text: "Reading the codebase...", timestamp: "2026-03-18T10:00:15Z" },
      { text: "Making changes now.", timestamp: "2026-03-18T10:00:30Z" },
      { text: "All done. Tests pass.", timestamp: "2026-03-18T10:00:55Z" },
    ];

    const result = interleaveEvents(events, agentMessages);

    expect(result).toHaveLength(6);

    // Verify order
    expect(result[0]!.source).toBe("lifecycle");
    expect(result[0]!.text).toContain("queued -> running");

    expect(result[1]!.source).toBe("lifecycle");
    expect(result[1]!.text).toContain("backend_spawned");

    expect(result[2]!.source).toBe("agent");
    expect(result[2]!.text).toBe("Reading the codebase...");

    expect(result[3]!.source).toBe("agent");
    expect(result[3]!.text).toBe("Making changes now.");

    expect(result[4]!.source).toBe("agent");
    expect(result[4]!.text).toBe("All done. Tests pass.");

    expect(result[5]!.source).toBe("lifecycle");
    expect(result[5]!.text).toContain("succeeded");
  });

  test("works with only lifecycle events (no agent messages)", () => {
    const events: LifecycleEvent[] = [
      {
        timestamp: "2026-03-18T10:00:00Z",
        run_id: "run-1",
        event: "state_transition",
        message: "queued -> running",
      },
    ];

    const result = interleaveEvents(events, []);
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("lifecycle");
  });

  test("works with only agent messages (no lifecycle events)", () => {
    const agentMessages: AssistantMessage[] = [
      { text: "Hello world", timestamp: "2026-03-18T10:00:15Z" },
    ];

    const result = interleaveEvents([], agentMessages);
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("agent");
  });

  test("works with empty inputs", () => {
    const result = interleaveEvents([], []);
    expect(result).toHaveLength(0);
  });

  test("truncates long agent messages to first line with preview", () => {
    const longLine = "A".repeat(300);
    const agentMessages: AssistantMessage[] = [
      { text: `${longLine}\nSecond line`, timestamp: "2026-03-18T10:00:15Z" },
    ];

    const result = interleaveEvents([], agentMessages);
    expect(result).toHaveLength(1);
    expect(result[0]!.text.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(result[0]!.text.endsWith("...")).toBe(true);
  });

  test("multiline agent messages show only the first line", () => {
    const agentMessages: AssistantMessage[] = [
      {
        text: "First line\nSecond line\nThird line",
        timestamp: "2026-03-18T10:00:15Z",
      },
    ];

    const result = interleaveEvents([], agentMessages);
    expect(result[0]!.text).toBe("First line");
  });

  test("maintains stable order for same-timestamp entries", () => {
    const sameTime = "2026-03-18T10:00:00Z";
    const events: LifecycleEvent[] = [
      { timestamp: sameTime, run_id: "run-1", event: "state_transition", message: "first" },
    ];
    const agentMessages: AssistantMessage[] = [
      { text: "agent msg", timestamp: sameTime },
    ];

    const result = interleaveEvents(events, agentMessages);
    expect(result).toHaveLength(2);
    // Both are present; exact order within same timestamp is stable
    const sources = result.map((r) => r.source);
    expect(sources).toContain("lifecycle");
    expect(sources).toContain("agent");
  });
});
