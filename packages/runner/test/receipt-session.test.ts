/**
 * Tests for receipt builder with backend_session and agent_terminal_message.
 */

import { describe, expect, test } from "vitest";
import { buildRunReceipt, runReceiptSchema } from "@polli-labs/calyx-runner";
import type { ReceiptBuildContext } from "@polli-labs/calyx-runner";

/** Build a minimal valid ReceiptBuildContext for testing. */
function makeContext(overrides?: Partial<ReceiptBuildContext>): ReceiptBuildContext {
  const now = "2026-03-18T10:00:00Z";
  return {
    run_id: "test-run-001",
    state: "succeeded",
    spec: {
      host: "blade",
      backend: "claude",
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
    },
    artifacts: {
      run_id: "test-run-001",
      finalized_at: now,
      required: [],
      discovered: [],
      gate_passed: true,
      missing: [],
    },
    events: [],
    environment: { host: "blade", backend: "claude" },
    timing: {
      created_at: now,
      completed_at: now,
    },
    ...overrides,
  };
}

describe("buildRunReceipt with session data", () => {
  test("receipt includes backend_session when provided", () => {
    const ctx = makeContext({
      backend_session: {
        id: "sess-abc-123",
        path: "/home/user/.claude/projects/hash/sess-abc-123.jsonl",
        backend: "claude",
      },
    });

    const receipt = buildRunReceipt(ctx);
    expect(receipt.backend_session).toBeDefined();
    expect(receipt.backend_session!.id).toBe("sess-abc-123");
    expect(receipt.backend_session!.path).toContain("sess-abc-123.jsonl");
    expect(receipt.backend_session!.backend).toBe("claude");
  });

  test("receipt includes agent_terminal_message when provided", () => {
    const ctx = makeContext({
      agent_terminal_message: "All tasks completed successfully. 3 files changed, tests pass.",
    });

    const receipt = buildRunReceipt(ctx);
    expect(receipt.agent_terminal_message).toBe(
      "All tasks completed successfully. 3 files changed, tests pass.",
    );
  });

  test("receipt omits backend_session when not provided", () => {
    const ctx = makeContext();
    const receipt = buildRunReceipt(ctx);
    expect(receipt.backend_session).toBeUndefined();
  });

  test("receipt omits agent_terminal_message when not provided", () => {
    const ctx = makeContext();
    const receipt = buildRunReceipt(ctx);
    expect(receipt.agent_terminal_message).toBeUndefined();
  });

  test("receipt with session data passes schema validation", () => {
    const ctx = makeContext({
      backend_session: {
        id: "sess-abc-123",
        path: "/home/user/.claude/projects/hash/sess-abc-123.jsonl",
        backend: "claude",
      },
      agent_terminal_message: "Done.",
    });

    const receipt = buildRunReceipt(ctx);
    // buildRunReceipt already validates, but let's be explicit
    const parseResult = runReceiptSchema.safeParse(receipt);
    expect(parseResult.success).toBe(true);
  });

  test("receipt without session data still passes schema validation", () => {
    const ctx = makeContext();
    const receipt = buildRunReceipt(ctx);
    const parseResult = runReceiptSchema.safeParse(receipt);
    expect(parseResult.success).toBe(true);
  });

  test("receipt accepts a stream-derived session id before transcript path discovery", () => {
    const receipt = buildRunReceipt(makeContext({
      backend_session: { id: "stream-session", backend: "claude" },
    }));
    expect(receipt.backend_session).toEqual({ id: "stream-session", backend: "claude" });
    expect(runReceiptSchema.safeParse(receipt).success).toBe(true);
  });

  test("receipt preserves typed structured terminal evidence", () => {
    const receipt = buildRunReceipt(makeContext({
      terminal_evidence: {
        schema_version: "calyx.agent-terminal-evidence/v1",
        source: "claude_stream",
        status: "authoritative",
        reason: "max_turns",
        backend_subtype: "error_max_turns",
        session_id: "stream-session",
        num_turns: 12,
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    }));
    expect(receipt.terminal_evidence).toMatchObject({
      reason: "max_turns",
      backend_subtype: "error_max_turns",
      num_turns: 12,
    });
    expect(runReceiptSchema.safeParse(receipt).success).toBe(true);
  });

  test("preserves full terminal message without truncation", () => {
    const longMessage = "X".repeat(100000);
    const ctx = makeContext({ agent_terminal_message: longMessage });
    const receipt = buildRunReceipt(ctx);
    expect(receipt.agent_terminal_message).toBe(longMessage);
    expect(receipt.agent_terminal_message!.length).toBe(100000);
  });
});

describe("buildRunReceipt with backend_stderr and spawn diagnostics (POL-912)", () => {
  test("receipt includes backend_stderr when provided", () => {
    const ctx = makeContext({
      backend_stderr: "Error: something went wrong\n",
    });
    const receipt = buildRunReceipt(ctx);
    expect(receipt.backend_stderr).toBe("Error: something went wrong\n");
  });

  test("receipt omits backend_stderr when not provided", () => {
    const ctx = makeContext();
    const receipt = buildRunReceipt(ctx);
    expect(receipt.backend_stderr).toBeUndefined();
  });

  test("receipt includes backend_signal when provided", () => {
    const ctx = makeContext({
      state: "failed",
      backend_signal: "SIGKILL",
    });
    const receipt = buildRunReceipt(ctx);
    expect(receipt.backend_signal).toBe("SIGKILL");
  });

  test("receipt omits backend_signal when not provided", () => {
    const ctx = makeContext();
    const receipt = buildRunReceipt(ctx);
    expect(receipt.backend_signal).toBeUndefined();
  });

  test("receipt includes spawn_error when provided", () => {
    const ctx = makeContext({
      state: "infra_error",
      spawn_error: "maxBuffer exceeded",
    });
    const receipt = buildRunReceipt(ctx);
    expect(receipt.spawn_error).toBe("maxBuffer exceeded");
  });

  test("receipt omits spawn_error when not provided", () => {
    const ctx = makeContext();
    const receipt = buildRunReceipt(ctx);
    expect(receipt.spawn_error).toBeUndefined();
  });

  test("receipt with all diagnostic fields passes schema validation", () => {
    const ctx = makeContext({
      state: "infra_error",
      backend_stderr: "Out of memory",
      backend_signal: "SIGKILL",
      spawn_error: "maxBuffer exceeded",
    });
    const receipt = buildRunReceipt(ctx);
    const parseResult = runReceiptSchema.safeParse(receipt);
    expect(parseResult.success).toBe(true);
  });
});
