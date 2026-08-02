/**
 * Tests for Claude session file parsing.
 *
 * Codex-specific parser coverage lives under calyx-ext-codex.
 */

import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  parseClaudeProviderConstraint,
  parseClaudeTerminalMessage,
  parseClaudeAssistantMessages,
} from "@polli-labs/calyx-runner";
import type { SessionParserFs } from "@polli-labs/calyx-runner";

const FIXTURE_DIR = resolve(import.meta.dirname, "../../../fixtures/domains/runner/sessions");

/** Default filesystem that reads real fixture files. */
const realFs: SessionParserFs = {
  readFile: (p, enc) => readFile(p, enc),
};

// ── Claude Code session parsing ─────────────────────────────────────

describe("parseClaudeTerminalMessage", () => {
  test("extracts the last assistant message from fixture", async () => {
    const path = resolve(FIXTURE_DIR, "claude-session.jsonl");
    const result = await parseClaudeTerminalMessage(path, realFs);
    expect(result).toBeDefined();
    expect(result).toContain("I've implemented the feature");
    expect(result).toContain("All checks pass.");
  });

  test("returns undefined when no assistant messages", async () => {
    const path = resolve(FIXTURE_DIR, "claude-session-empty.jsonl");
    const result = await parseClaudeTerminalMessage(path, realFs);
    expect(result).toBeUndefined();
  });

  test("handles string content format", async () => {
    const path = resolve(FIXTURE_DIR, "claude-string-content.jsonl");
    const result = await parseClaudeTerminalMessage(path, realFs);
    expect(result).toBe("This is a simple string content message.");
  });

  test("extracts valid messages from partially malformed JSONL", async () => {
    const path = resolve(FIXTURE_DIR, "malformed.jsonl");
    const result = await parseClaudeTerminalMessage(path, realFs);
    // The one valid assistant line should be found
    expect(result).toBe("This one is valid");
  });

  test("returns undefined for nonexistent file", async () => {
    const result = await parseClaudeTerminalMessage("/nonexistent/path.jsonl", realFs);
    expect(result).toBeUndefined();
  });

  test("does NOT truncate long messages", async () => {
    const longText = "A".repeat(50000);
    const mockFs: SessionParserFs = {
      readFile: async () =>
        JSON.stringify({
          uuid: "msg-long",
          timestamp: "2026-03-18T10:00:00Z",
          sessionId: "sess-long",
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: longText }] },
        }),
    };
    const result = await parseClaudeTerminalMessage("/fake/path.jsonl", mockFs);
    expect(result).toBe(longText);
    expect(result!.length).toBe(50000);
  });
});

describe("parseClaudeProviderConstraint", () => {
  test("requires Claude's typed API-error assistant record", async () => {
    const exactRecord = JSON.stringify({
      type: "assistant",
      isApiErrorMessage: true,
      error: "rate_limit",
      apiErrorStatus: 429,
      timestamp: "2026-07-21T07:06:08.573Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "You've hit your session limit · resets 8:10am (UTC)" }],
      },
    });
    const unrelatedProse = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-21T07:06:09.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The docs mention a session limit." }],
      },
    });
    const fs: SessionParserFs = {
      readFile: async () => `${unrelatedProse}\n${exactRecord}\n`,
    };

    expect(await parseClaudeProviderConstraint("/fake/session.jsonl", fs)).toEqual({
      schema_version: "calyx.provider-constraint/v1",
      cause: "provider_capacity_exhausted",
      backend: "claude",
      kind: "session_window",
      source: "session_transcript",
      observed_at: "2026-07-21T07:06:08.573Z",
      confidence: "definitive",
      provider_code: "rate_limit",
      http_status: 429,
      reset_hint: "resets 8:10am (UTC)",
    });
  });

  test("a later resumed turn supersedes historical Claude capacity evidence", async () => {
    const records = [
      {
        type: "assistant",
        isApiErrorMessage: true,
        error: "rate_limit",
        apiErrorStatus: 429,
        timestamp: "2026-07-21T07:06:08.573Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "You've hit your session limit · resets 8:10am (UTC)" }],
        },
      },
      {
        type: "user",
        timestamp: "2026-07-21T08:11:00.000Z",
        message: { role: "user", content: "Continue." },
      },
      {
        type: "assistant",
        timestamp: "2026-07-21T08:11:05.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The resumed turn completed successfully." }],
        },
      },
    ];
    const fs: SessionParserFs = {
      readFile: async () => records.map((record) => JSON.stringify(record)).join("\n"),
    };

    expect(await parseClaudeProviderConstraint("/fake/session.jsonl", fs)).toBeUndefined();
  });

  test.each([
    ["wrong code", "overloaded_error", 429, "You've hit your session limit · resets 8:10am (UTC)"],
    ["wrong status", "rate_limit", 503, "You've hit your session limit · resets 8:10am (UTC)"],
    ["near-miss message", "rate_limit", 429, "The session limit documentation moved."],
  ])("rejects Claude API-error near miss: %s", async (_label, error, apiErrorStatus, text) => {
    const fs: SessionParserFs = {
      readFile: async () => JSON.stringify({
        type: "assistant",
        isApiErrorMessage: true,
        error,
        apiErrorStatus,
        timestamp: "2026-07-21T07:06:08.573Z",
        message: { role: "assistant", content: [{ type: "text", text }] },
      }),
    };

    expect(await parseClaudeProviderConstraint("/fake/session.jsonl", fs)).toBeUndefined();
  });
});

describe("parseClaudeAssistantMessages", () => {
  test("extracts all assistant messages in order", async () => {
    const path = resolve(FIXTURE_DIR, "claude-session.jsonl");
    const messages = await parseClaudeAssistantMessages(path, realFs);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.text).toContain("reading the relevant files");
    expect(messages[0]!.timestamp).toBe("2026-03-18T10:00:05Z");
    expect(messages[1]!.text).toContain("I've implemented the feature");
    expect(messages[1]!.timestamp).toBe("2026-03-18T10:00:15Z");
  });

  test("returns empty array for no assistant messages", async () => {
    const path = resolve(FIXTURE_DIR, "claude-session-empty.jsonl");
    const messages = await parseClaudeAssistantMessages(path, realFs);
    expect(messages).toHaveLength(0);
  });

  test("returns empty array for nonexistent file", async () => {
    const messages = await parseClaudeAssistantMessages("/nonexistent/path.jsonl", realFs);
    expect(messages).toHaveLength(0);
  });
});
