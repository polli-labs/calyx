import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { ClaudeStreamParser } from "../src/adapters/claude-stream.js";
import type { AgentActivityProgress, LifecycleEvent } from "../src/types.js";
import type { SessionInfo } from "../src/adapters/types.js";

function parseLines(lines: string[], expectedSessionId?: string) {
  const events: LifecycleEvent[] = [];
  const activity: AgentActivityProgress[] = [];
  const sessions: SessionInfo[] = [];
  const parser = new ClaudeStreamParser({
    run_id: "run-stream",
    ...(expectedSessionId ? { expected_session_id: expectedSessionId } : {}),
    now: () => "2026-07-17T12:00:00.000Z",
    onEvent: (event) => events.push(event),
    onActivity: (progress) => activity.push(progress),
    onSession: (session) => sessions.push(session),
  });
  const payload = lines.join("\n");
  const split = Math.floor(payload.length / 2);
  parser.write(Buffer.from(payload.slice(0, split)));
  parser.write(Buffer.from(payload.slice(split)));
  const projection = parser.finish();
  if (projection.terminal_evidence) {
    parser.publishTerminalEvent(projection.terminal_evidence);
  }
  return { projection, events, activity, sessions };
}

describe("ClaudeStreamParser", () => {
  test("projects Claude's typed session-limit API error as bounded capacity evidence", () => {
    const raw = "You've hit your session limit · resets 8:10am (UTC)";
    const { projection } = parseLines([JSON.stringify({
      type: "assistant",
      isApiErrorMessage: true,
      error: "rate_limit",
      apiErrorStatus: 429,
      timestamp: "2026-07-21T07:06:08.573Z",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: raw }],
      },
    })]);

    expect(projection.provider_constraint).toMatchObject({
      cause: "provider_capacity_exhausted",
      backend: "claude",
      kind: "session_window",
      source: "backend_stream",
      provider_code: "rate_limit",
      http_status: 429,
      reset_hint: "resets 8:10am (UTC)",
    });
    expect(JSON.stringify(projection.provider_constraint)).not.toContain("You've hit");
  });

  test.each([
    ["wrong code", "overloaded_error", 429, "You've hit your session limit · resets 8:10am (UTC)"],
    ["wrong status", "rate_limit", 503, "You've hit your session limit · resets 8:10am (UTC)"],
    ["near-miss message", "rate_limit", 429, "The session limit documentation moved."],
  ])("rejects Claude stream capacity near miss: %s", (_label, error, apiErrorStatus, text) => {
    const { projection } = parseLines([JSON.stringify({
      type: "assistant",
      isApiErrorMessage: true,
      error,
      apiErrorStatus,
      timestamp: "2026-07-21T07:06:08.573Z",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    })]);

    expect(projection.provider_constraint).toBeUndefined();
  });

  test("current structured success supersedes an earlier capacity record", () => {
    const { projection } = parseLines([
      JSON.stringify({
        type: "assistant",
        isApiErrorMessage: true,
        error: "rate_limit",
        apiErrorStatus: 429,
        timestamp: "2026-07-21T07:06:08.573Z",
        parent_tool_use_id: null,
        message: {
          role: "assistant",
          content: [{
            type: "text",
            text: "You've hit your session limit · resets 8:10am (UTC)",
          }],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "resumed-session",
        result: "Completed after resuming.",
      }),
    ]);

    expect(projection.terminal_evidence?.reason).toBe("completed");
    expect(projection.provider_constraint).toBeUndefined();
  });

  test("defers terminal publication until process authority is reconciled", () => {
    const events: LifecycleEvent[] = [];
    const parser = new ClaudeStreamParser({
      run_id: "run-process-authority",
      expected_session_id: "expected-session",
      onEvent: (event) => events.push(event),
    });
    parser.write(`${JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "expected-session",
      result: "Done.",
    })}\n`);

    const projection = parser.finish();
    expect(events.filter((event) => event.payload?.["kind"] === "result")).toEqual([]);

    parser.publishTerminalEvent({
      ...projection.terminal_evidence!,
      source: "process_exit",
      reason: "abnormal_exit",
      exit_code: 1,
    });
    parser.publishTerminalEvent(projection.terminal_evidence!);

    expect(events.filter((event) => event.payload?.["kind"] === "result")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          source: "process_exit",
          status: "authoritative",
          reason: "abnormal_exit",
          exit_code: 1,
        }),
      }),
    ]);
  });

  test("projects the multi-tool fixture without exposing private payload sentinels", () => {
    const fixture = readFileSync(
      new URL("./fixtures/claude-stream/multi-tool-success.jsonl", import.meta.url),
      "utf8",
    );
    const { projection, events, activity } = parseLines(fixture.trimEnd().split("\n"));
    expect(projection.agent_terminal_message).toBe("Fixture result final.");
    expect(projection.terminal_evidence).toMatchObject({
      status: "authoritative",
      reason: "completed",
      session_id: "fixture-session",
    });
    const sparseProjection = JSON.stringify({ events, activity, terminal: projection.terminal_evidence });
    expect(sparseProjection).not.toContain("PRIVATE_FIXTURE_THINKING");
    expect(sparseProjection).not.toContain("PRIVATE_FIXTURE_TOOL_INPUT");
    expect(sparseProjection).not.toContain("PRIVATE_FIXTURE_TOOL_RESULT");
  });

  test("projects multi-tool JSONL into sparse semantic facts and preserves terminal authority", () => {
    const rawThinking = "PRIVATE_THINKING_SENTINEL";
    const rawToolInput = "PRIVATE_TOOL_INPUT_SENTINEL";
    const rawToolResult = "PRIVATE_TOOL_RESULT_SENTINEL";
    const { projection, events, activity, sessions } = parseLines([
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "session-structured-1",
        model: "claude-opus-4-6",
        claude_code_version: "2.1.212",
      }),
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [
          { type: "thinking", thinking: rawThinking },
          { type: "text", text: "I will inspect the repository." },
          { type: "tool_use", name: "Read", input: { file_path: rawToolInput } },
        ] },
      }),
      "not json at all",
      JSON.stringify({ type: "PRIVATE_UNKNOWN_TYPE_SENTINEL", payload: rawToolInput }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", content: rawToolResult }] },
      }),
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "Completed from assistant fallback." }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "session-structured-1",
        result: "Completed from result.",
        duration_ms: 1500,
        duration_api_ms: 900,
        num_turns: 2,
        total_cost_usd: 0.42,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 80,
        },
        permission_denials: [{ tool_name: "Bash", tool_input: rawToolInput }],
      }),
    ]);

    expect(projection.agent_terminal_message).toBe("Completed from result.");
    expect(projection.session).toEqual({ id: "session-structured-1", backend: "claude" });
    expect(projection.terminal_evidence).toEqual({
      schema_version: "calyx.agent-terminal-evidence/v1",
      source: "claude_stream",
      status: "authoritative",
      reason: "completed",
      backend_subtype: "success",
      session_id: "session-structured-1",
      duration_ms: 1500,
      duration_api_ms: 900,
      num_turns: 2,
      total_cost_usd: 0.42,
      permission_denial_count: 1,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
      malformed_line_count: 1,
      unknown_record_count: 1,
    });
    expect(sessions).toEqual([{ id: "session-structured-1", backend: "claude" }]);
    expect(activity.length).toBeGreaterThanOrEqual(5);
    expect(activity.every((entry) => entry.source === "claude_stream" && entry.semantic)).toBe(true);

    const durableProjection = JSON.stringify({ events, activity, terminal: projection.terminal_evidence });
    expect(durableProjection).not.toContain(rawThinking);
    expect(durableProjection).not.toContain(rawToolInput);
    expect(durableProjection).not.toContain(rawToolResult);
    expect(durableProjection).not.toContain("PRIVATE_UNKNOWN_TYPE_SENTINEL");
    expect(durableProjection).not.toContain("I will inspect the repository.");
    expect(durableProjection).not.toContain("Completed from result.");
  });

  test.each([
    ["error_max_turns", undefined, "max_turns"],
    ["error_max_budget_usd", undefined, "budget_exhaustion"],
    ["error_during_execution", "aborted_streaming", "operator_stop"],
    ["error_during_execution", "api_error", "backend_failure"],
  ] as const)("maps %s/%s to %s", (subtype, terminalReason, expected) => {
    const { projection } = parseLines([JSON.stringify({
      type: "result",
      subtype,
      ...(terminalReason ? { terminal_reason: terminalReason } : {}),
      session_id: "session-terminal",
    })]);
    expect(projection.terminal_evidence).toMatchObject({
      status: "authoritative",
      reason: expected,
      backend_subtype: subtype,
    });
  });

  test("a malformed result is typed without exposing its raw payload", () => {
    const secret = "MALFORMED_RESULT_SECRET";
    const { projection, events } = parseLines([
      JSON.stringify({ type: "result", session_id: "session-malformed", errors: [secret] }),
    ]);
    expect(projection.terminal_evidence).toMatchObject({
      status: "malformed",
      reason: "malformed_result",
      session_id: "session-malformed",
    });
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  test("treats a success result without its required final text as malformed", () => {
    const { projection, activity } = parseLines([
      JSON.stringify({ type: "result", subtype: "success", session_id: "session-malformed-success" }),
    ]);

    expect(projection.terminal_evidence).toMatchObject({
      status: "malformed",
      reason: "malformed_result",
      session_id: "session-malformed-success",
    });
    expect(projection.agent_terminal_message).toBeUndefined();
    expect(activity.at(-1)).toMatchObject({
      semantic: false,
      signal: { status: "failed", reason: "malformed_stream" },
    });
  });

  test("does not surface a stream session that contradicts the preassigned identity", () => {
    const { projection, events, activity, sessions } = parseLines([
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "wrong-session",
        result: "Terminal facts remain usable.",
      }),
    ], "expected-session");

    expect(projection.session).toBeUndefined();
    expect(projection.terminal_evidence).toBeUndefined();
    expect(projection.agent_terminal_message).toBeUndefined();
    expect(projection.semantic_progress_count).toBe(0);
    expect(projection.malformed_line_count).toBe(1);
    expect(projection.protocol_failed).toBe(true);
    expect(activity).toEqual([
      expect.objectContaining({
        semantic: false,
        signal: expect.objectContaining({ status: "failed", reason: "malformed_stream" }),
      }),
    ]);
    expect(sessions).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("wrong-session");
    expect(JSON.stringify(events)).not.toContain("Terminal facts remain usable.");
  });

  test.each([
    [[
      { type: "system", subtype: "init", session_id: "expected-session" },
      {
        type: "assistant",
        session_id: "wrong-session",
        message: { content: [{ type: "text", text: "WRONG_ASSISTANT_SENTINEL" }] },
      },
      { type: "result", subtype: "success", session_id: "expected-session", result: "Done." },
    ]],
    [[
      { type: "system", subtype: "init", session_id: "expected-session" },
      { type: "result", subtype: "success", result: "MISSING_RESULT_SESSION_SENTINEL" },
    ]],
    [[
      { type: "result", subtype: "success", session_id: "expected-session", result: "First." },
      { type: "system", subtype: "init", session_id: "wrong-session" },
    ]],
    [[
      { type: "result", subtype: "success", session_id: "expected-session", result: "First." },
      { type: "result", subtype: "success", session_id: "expected-session", result: "Second." },
    ]],
  ])("quarantines an exact-session/cardinality protocol violation retroactively", (records) => {
    const { projection, activity, sessions } = parseLines(
      records.map((record) => JSON.stringify(record)),
      "expected-session",
    );
    expect(projection.protocol_failed).toBe(true);
    expect(projection.agent_terminal_message).toBeUndefined();
    expect(projection.session).toBeUndefined();
    expect(projection.semantic_progress_count).toBe(0);
    expect(activity.at(-1)).toMatchObject({
      semantic: false,
      signal: { source: "claude_stream", status: "failed", reason: "malformed_stream" },
    });
    expect(JSON.stringify(projection)).not.toContain("SENTINEL");
    // A matching init may have published an id-only live checkpoint before a
    // later whole-stream violation; terminal projection no longer trusts it.
    expect(sessions.every((session) => session.id === "expected-session")).toBe(true);
  });

  test("projects api_retry as bounded semantic liveness without raw error payloads", () => {
    const secret = "PRIVATE_RETRY_ERROR_SENTINEL";
    const { projection, events, activity } = parseLines([
      JSON.stringify({ type: "system", subtype: "init", session_id: "expected-session" }),
      JSON.stringify({
        type: "system",
        subtype: "api_retry",
        session_id: "expected-session",
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 30000,
        error_status: 529,
        error: secret,
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "expected-session",
        result: "Done.",
      }),
    ], "expected-session");

    expect(projection.protocol_failed).toBe(false);
    expect(activity).toContainEqual(expect.objectContaining({
      detail: "api_retry",
      semantic: true,
      expected_silence_ms: 30000,
    }));
    const retryEvent = events.find((event) => event.payload?.["kind"] === "api_retry");
    expect(retryEvent?.payload).toMatchObject({
      attempt: 2,
      max_retries: 5,
      retry_delay_ms: 30000,
      error_status: 529,
    });
    expect(JSON.stringify({ events, activity })).not.toContain(secret);
  });

  test("caps untrusted api_retry silence intervals", () => {
    const { activity } = parseLines([
      JSON.stringify({ type: "system", subtype: "init", session_id: "expected-session" }),
      JSON.stringify({
        type: "system",
        subtype: "api_retry",
        session_id: "expected-session",
        retry_delay_ms: Number.MAX_SAFE_INTEGER,
      }),
    ], "expected-session");

    expect(activity).toContainEqual(expect.objectContaining({
      detail: "api_retry",
      expected_silence_ms: 300000,
    }));
  });
});
