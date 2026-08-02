import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { SessionParserFs } from "@polli-labs/calyx-runner";
import {
  parseCodexAssistantMessages,
  parseCodexProviderConstraint,
  parseCodexTerminalMessage,
} from "../runtime/index.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "../../../../fixtures/domains/calyx-ext-codex/sessions");

const realFs: SessionParserFs = {
  readFile: (p, enc) => readFile(p, enc),
};

describe("parseCodexTerminalMessage", () => {
  test("extracts the last assistant message from fixture", async () => {
    const path = resolve(FIXTURE_DIR, "codex-session.jsonl");
    const result = await parseCodexTerminalMessage(path, realFs);
    expect(result).toBeDefined();
    expect(result).toContain("bug has been fixed");
    expect(result).toContain("regression test");
  });

  test("returns undefined when no assistant messages", async () => {
    const path = resolve(FIXTURE_DIR, "codex-session-empty.jsonl");
    const result = await parseCodexTerminalMessage(path, realFs);
    expect(result).toBeUndefined();
  });

  test("returns undefined for nonexistent file", async () => {
    const result = await parseCodexTerminalMessage("/nonexistent/path.jsonl", realFs);
    expect(result).toBeUndefined();
  });

  test("does not truncate long messages", async () => {
    const longText = "B".repeat(50_000);
    const mockFs: SessionParserFs = {
      readFile: async () =>
        JSON.stringify({
          timestamp: "2026-03-18T10:00:00Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: longText }],
          },
        }),
    };

    const result = await parseCodexTerminalMessage("/fake/path.jsonl", mockFs);
    expect(result).toBe(longText);
    expect(result!.length).toBe(50_000);
  });
});

describe("parseCodexProviderConstraint", () => {
  test("binds credits=false to a terminal task without an assistant message", async () => {
    const path = resolve(FIXTURE_DIR, "codex-credits-exhausted.jsonl");
    expect(await parseCodexProviderConstraint(path, realFs)).toEqual({
      schema_version: "calyx.provider-constraint/v1",
      cause: "provider_capacity_exhausted",
      backend: "codex",
      kind: "credits",
      source: "session_transcript",
      observed_at: "2026-07-12T00:00:32.393Z",
      confidence: "definitive",
    });
  });

  test("does not treat an in-flight credits=false snapshot as terminal", async () => {
    const mockFs: SessionParserFs = {
      readFile: async () => JSON.stringify({
        timestamp: "2026-07-12T00:00:32.393Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: { credits: { has_credits: false } },
        },
      }),
    };
    expect(await parseCodexProviderConstraint("/fake/path.jsonl", mockFs)).toBeUndefined();
  });

  test("does not carry credits evidence across a completed turn", async () => {
    const mockFs: SessionParserFs = {
      readFile: async () => [
        {
          timestamp: "2026-07-12T00:00:32.393Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: { credits: { has_credits: false } },
          },
        },
        {
          timestamp: "2026-07-12T00:00:33.000Z",
          type: "event_msg",
          payload: { type: "task_complete", last_agent_message: "Existing turn completed." },
        },
        {
          timestamp: "2026-07-12T00:00:34.000Z",
          type: "event_msg",
          payload: { type: "task_complete", last_agent_message: null },
        },
      ].map((record) => JSON.stringify(record)).join("\n"),
    };
    expect(await parseCodexProviderConstraint("/fake/path.jsonl", mockFs)).toBeUndefined();
  });

  test("a later successful resumed turn supersedes historical Codex exhaustion", async () => {
    const mockFs: SessionParserFs = {
      readFile: async () => [
        {
          timestamp: "2026-07-12T00:00:32.393Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: { credits: { has_credits: false } },
          },
        },
        {
          timestamp: "2026-07-12T00:00:33.000Z",
          type: "event_msg",
          payload: { type: "task_complete", last_agent_message: null },
        },
        {
          timestamp: "2026-07-12T01:00:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "resumed-turn" },
        },
        {
          timestamp: "2026-07-12T01:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: { credits: { has_credits: true } },
          },
        },
        {
          timestamp: "2026-07-12T01:00:05.000Z",
          type: "event_msg",
          payload: { type: "task_complete", last_agent_message: "Resumed successfully." },
        },
      ].map((record) => JSON.stringify(record)).join("\n"),
    };

    expect(await parseCodexProviderConstraint("/fake/path.jsonl", mockFs)).toBeUndefined();
  });

  test("a new in-flight Codex turn clears historical exhaustion immediately", async () => {
    const mockFs: SessionParserFs = {
      readFile: async () => [
        {
          timestamp: "2026-07-12T00:00:32.393Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: { credits: { has_credits: false } },
          },
        },
        {
          timestamp: "2026-07-12T00:00:33.000Z",
          type: "event_msg",
          payload: { type: "task_complete", last_agent_message: null },
        },
        {
          timestamp: "2026-07-12T01:00:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "resumed-in-flight" },
        },
      ].map((record) => JSON.stringify(record)).join("\n"),
    };

    expect(await parseCodexProviderConstraint("/fake/path.jsonl", mockFs)).toBeUndefined();
  });
});

describe("parseCodexAssistantMessages", () => {
  test("extracts all assistant messages in order", async () => {
    const path = resolve(FIXTURE_DIR, "codex-session.jsonl");
    const messages = await parseCodexAssistantMessages(path, realFs);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.text).toContain("investigate the issue");
    expect(messages[0]!.timestamp).toBe("2026-03-18T10:00:05Z");
    expect(messages[1]!.text).toContain("bug has been fixed");
    expect(messages[1]!.timestamp).toBe("2026-03-18T10:00:15Z");
  });

  test("skips non-message response items", async () => {
    const path = resolve(FIXTURE_DIR, "codex-session.jsonl");
    const messages = await parseCodexAssistantMessages(path, realFs);
    expect(messages).toHaveLength(2);
  });

  test("returns empty array for nonexistent file", async () => {
    const messages = await parseCodexAssistantMessages("/nonexistent/path.jsonl", realFs);
    expect(messages).toHaveLength(0);
  });
});
