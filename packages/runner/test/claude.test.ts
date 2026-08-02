import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import type { SessionDiscoveryFs } from "../src/adapters/session-discovery.js";
import type { SessionParserFs } from "../src/adapters/session-parser.js";
import type { LifecycleEvent } from "../src/types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const emptyDiscoveryFs: SessionDiscoveryFs = {
  readdir: async () => [],
  readFile: async () => "",
  stat: async () => ({ mtimeMs: 0 }),
  homedir: () => "/tmp",
};

const emptyParserFs: SessionParserFs = {
  readFile: async () => "",
};

type SpawnCall = {
  cmd: string;
  args: string[];
  opts: {
    cwd: string;
    env?: Record<string, string | undefined>;
    close_stdin?: boolean;
    onActivity?: unknown;
    onStdoutChunk?: (chunk: Buffer) => void;
    capture_stdout?: boolean;
    hard_timeout_ms?: number;
    stop_grace_ms?: number;
  };
};

function makeAdapter(calls: SpawnCall[]): ClaudeAdapter {
  return new ClaudeAdapter({
    spawn: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { code: 0, stdout: "", stderr: "" };
    },
    sessionDiscoveryFs: emptyDiscoveryFs,
    sessionParserFs: emptyParserFs,
  });
}

describe("ClaudeAdapter", () => {
  test("closes stdin while passing the prompt after an option terminator", async () => {
    const calls: SpawnCall[] = [];
    const adapter = makeAdapter(calls);

    const result = await adapter.spawn({
      run_id: "run-1099",
      cwd: "/tmp",
      prompt: "test prompt",
    });

    expect(result.exit_code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("claude");
    expect(calls[0]?.args).toEqual([
      "--session-id",
      expect.stringMatching(UUID_PATTERN),
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--",
      "test prompt",
    ]);
    expect(calls[0]?.opts.cwd).toBe("/tmp");
    expect(calls[0]?.opts.close_stdin).toBe(true);
  });

  test("protects frontmatter-leading prompt content from option parsing", async () => {
    const calls: SpawnCall[] = [];
    const adapter = makeAdapter(calls);

    await adapter.spawn({
      run_id: "run-1409-frontmatter",
      cwd: "/tmp",
      prompt: "---\ntitle: not-a-flag\n---\nDo the work.",
    });

    expect(calls[0]?.args).toEqual([
      "--session-id",
      expect.stringMatching(UUID_PATTERN),
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--",
      "---\ntitle: not-a-flag\n---\nDo the work.",
    ]);
  });

  test("uses the structured result as terminal message without retaining raw stdout", async () => {
    const calls: SpawnCall[] = [];
    const sessions: string[] = [];
    const adapter = new ClaudeAdapter({
      spawn: async (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        const expectedSessionId = args[1];
        opts.onStdoutChunk?.(Buffer.from(
          JSON.stringify({
            type: "result",
            subtype: "success",
            session_id: expectedSessionId,
            result: "Done from stream.",
          }) + "\n",
        ));
        return { code: 0, stdout: "", stderr: "" };
      },
      sessionDiscoveryFs: emptyDiscoveryFs,
      sessionParserFs: emptyParserFs,
    });

    const result = await adapter.spawn({
      run_id: "run-1409-stdout",
      cwd: "/tmp",
      prompt: "test prompt",
      onSession: (session) => sessions.push(session.id),
    });

    expect(result.agent_terminal_message).toBe("Done from stream.");
    expect(result.terminal_evidence).toMatchObject({
      source: "claude_stream",
      status: "authoritative",
      reason: "completed",
      session_id: expect.stringMatching(UUID_PATTERN),
    });
    expect(calls[0]?.opts.capture_stdout).toBe(false);
    expect(sessions).toEqual([expect.stringMatching(UUID_PATTERN)]);
  });

  test("nonzero process exit rewrites contradictory structured success authority", async () => {
    const lifecycleEvents: LifecycleEvent[] = [];
    const adapter = new ClaudeAdapter({
      spawn: async (_cmd, args, opts) => {
        const sessionId = args[1]!;
        opts.onStdoutChunk?.(Buffer.from(JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: sessionId,
          result: "Safe final message.",
          usage: { input_tokens: 12, output_tokens: 3 },
        }) + "\n"));
        return { code: 1, stdout: "", stderr: "" };
      },
      sessionDiscoveryFs: emptyDiscoveryFs,
      sessionParserFs: emptyParserFs,
    });

    const result = await adapter.spawn({
      run_id: "run-exit-1",
      cwd: "/tmp",
      prompt: "test",
      onEvent: (event) => lifecycleEvents.push(event),
    });

    expect(result.agent_terminal_message).toBe("Safe final message.");
    expect(result.terminal_evidence).toMatchObject({
      source: "process_exit",
      status: "authoritative",
      reason: "abnormal_exit",
      backend_subtype: "success",
      exit_code: 1,
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    expect(lifecycleEvents.filter((event) => event.payload?.["kind"] === "result")).toEqual([
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

  test("marks transcript discovery as a visible terminal fallback", async () => {
    let assignedSessionId: string | undefined;
    const cwd = "/tmp";
    const sessionDiscoveryFs: SessionDiscoveryFs = {
      readdir: async (path) => {
        if (path.endsWith("/.claude/projects")) return ["project"];
        if (path.endsWith("/.claude/projects/project") && assignedSessionId) {
          return [`${assignedSessionId}.jsonl`];
        }
        return [];
      },
      readFile: async () => JSON.stringify({
        sessionId: assignedSessionId,
        cwd,
        timestamp: Date.now(),
      }),
      stat: async () => ({ mtimeMs: Date.now() }),
      homedir: () => "/tmp/fallback-home",
    };
    const sessionParserFs: SessionParserFs = {
      readFile: async () => JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        message: { content: [{ type: "text", text: "Fallback final message." }] },
      }),
    };
    const adapter = new ClaudeAdapter({
      spawn: async (_cmd, args) => {
        assignedSessionId = args[1];
        return { code: 0, stdout: "", stderr: "" };
      },
      sessionDiscoveryFs,
      sessionParserFs,
    });

    const result = await adapter.spawn({
      run_id: "run-session-fallback",
      cwd,
      prompt: "test prompt",
    });

    expect(result.session).toMatchObject({ id: assignedSessionId, backend: "claude" });
    expect(result.agent_terminal_message).toBe("Fallback final message.");
    expect(result.terminal_evidence).toMatchObject({
      source: "session_fallback",
      status: "fallback",
      reason: "completed",
    });
  });

  test("returns the exact caller-assigned Claude session after terminal validation", async () => {
    let assignedSessionId: string | undefined;
    const cwd = "/work/expected";
    const sessionDiscoveryFs: SessionDiscoveryFs = {
      readdir: async (path) => {
        if (path.endsWith("/.claude/projects")) return ["project"];
        if (path.endsWith("/.claude/projects/project") && assignedSessionId) {
          return [`${assignedSessionId}.jsonl`, "newer-unrelated.jsonl"];
        }
        return [];
      },
      readFile: async (path) => {
        const sessionId = path.endsWith("newer-unrelated.jsonl")
          ? "newer-unrelated"
          : assignedSessionId;
        return JSON.stringify({ sessionId, cwd, timestamp: Date.now() });
      },
      stat: async () => ({ mtimeMs: Date.now() }),
      homedir: () => "/home/testuser",
    };
    const adapter = new ClaudeAdapter({
      spawn: async (_cmd, args) => {
        assignedSessionId = args[1];
        return { code: 0, stdout: "", stderr: "" };
      },
      sessionDiscoveryFs,
      sessionParserFs: emptyParserFs,
    });

    const result = await adapter.spawn({
      run_id: "run-exact-session",
      cwd,
      prompt: "Do the work",
    });

    expect(assignedSessionId).toMatch(UUID_PATTERN);
    expect(result.session).toEqual({
      id: assignedSessionId,
      path: `/home/testuser/.claude/projects/project/${assignedSessionId}.jsonl`,
      backend: "claude",
    });
  });

  test("assigns distinct session ids to concurrent fresh runs", async () => {
    const assignedSessionIds: string[] = [];
    const adapter = new ClaudeAdapter({
      spawn: async (_cmd, args) => {
        assignedSessionIds.push(args[1]!);
        await Promise.resolve();
        return { code: 0, stdout: "", stderr: "" };
      },
      sessionDiscoveryFs: emptyDiscoveryFs,
      sessionParserFs: emptyParserFs,
    });

    await Promise.all([
      adapter.spawn({ run_id: "concurrent-a", cwd: "/work", prompt: "A" }),
      adapter.spawn({ run_id: "concurrent-b", cwd: "/work", prompt: "B" }),
    ]);

    expect(assignedSessionIds).toHaveLength(2);
    expect(assignedSessionIds.every((sessionId) => UUID_PATTERN.test(sessionId))).toBe(true);
    expect(new Set(assignedSessionIds).size).toBe(2);
  });

  test("passes replacement and appended system prompt flags", async () => {
    const calls: SpawnCall[] = [];
    const adapter = makeAdapter(calls);

    await adapter.spawn({
      run_id: "run-1140",
      cwd: "/tmp",
      prompt: "test prompt",
      system_prompt: "Replacement system prompt.",
      append_system_prompt: "Append these instructions.",
    });

    expect(calls[0]?.args).toEqual([
      "--session-id",
      expect.stringMatching(UUID_PATTERN),
      "--system-prompt",
      "Replacement system prompt.",
      "--append-system-prompt",
      "Append these instructions.",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--",
      "test prompt",
    ]);
  });

  test("passes Claude max reasoning effort flag", async () => {
    const calls: SpawnCall[] = [];
    const adapter = makeAdapter(calls);

    await adapter.spawn({
      run_id: "run-1319",
      cwd: "/tmp",
      prompt: "test prompt",
      backend_options: { reasoning_effort: "max" },
    });

    expect(calls[0]?.args).toEqual([
      "--session-id",
      expect.stringMatching(UUID_PATTERN),
      "--effort",
      "max",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--",
      "test prompt",
    ]);
  });

  test("maps only max_turns to Claude --max-turns", async () => {
    const calls: SpawnCall[] = [];
    const adapter = makeAdapter(calls);

    await adapter.spawn({
      run_id: "run-max-turns",
      cwd: "/tmp",
      prompt: "test prompt",
      backend_options: { max_turns: 8 },
    });

    expect(calls[0]?.args).toContain("--max-turns");
    expect(calls[0]?.args).toContain("8");
  });

  test("rejects max_threads instead of aliasing it to Claude turns", async () => {
    const calls: SpawnCall[] = [];
    const adapter = makeAdapter(calls);

    await expect(adapter.spawn({
      run_id: "run-max-threads",
      cwd: "/tmp",
      prompt: "test prompt",
      backend_options: { max_threads: 8 },
    })).rejects.toThrow("Claude does not support backend_options.max_threads");

    expect(calls).toHaveLength(0);
  });

  test("passes Claude model flag", async () => {
    const calls: SpawnCall[] = [];
    const adapter = makeAdapter(calls);

    await adapter.spawn({
      run_id: "run-1494",
      cwd: "/tmp",
      prompt: "test prompt",
      backend_options: { model: "opus" },
    });

    expect(calls[0]?.args).toEqual([
      "--session-id",
      expect.stringMatching(UUID_PATTERN),
      "--model",
      "opus",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--",
      "test prompt",
    ]);
  });

  test("routes semantic activity through the stream parser and configures the hard timeout", async () => {
    const calls: SpawnCall[] = [];
    const adapter = makeAdapter(calls);
    const onActivity = () => {};

    await adapter.spawn({
      run_id: "run-1388",
      cwd: "/tmp",
      prompt: "test prompt",
      onActivity,
      backend_options: {
        agent_activity: {
          stale_after_ms: 60000,
          hard_timeout_ms: 120000,
          stop_grace_ms: 1000,
        },
      },
    });

    expect(calls[0]?.opts.onActivity).toBeUndefined();
    expect(calls[0]?.opts.onStdoutChunk).toEqual(expect.any(Function));
    expect(calls[0]?.opts.hard_timeout_ms).toBe(120000);
    expect(calls[0]?.opts.stop_grace_ms).toBe(1000);
  });

  test("passes cancellation grace without requiring an inactivity timeout", async () => {
    const calls: SpawnCall[] = [];
    const adapter = makeAdapter(calls);

    await adapter.spawn({
      run_id: "run-stop-grace",
      cwd: "/tmp",
      prompt: "test prompt",
      backend_options: {
        agent_activity: { stop_grace_ms: 750 },
      },
    });

    expect(calls[0]?.opts.hard_timeout_ms).toBeUndefined();
    expect(calls[0]?.opts.stop_grace_ms).toBe(750);
  });

  test("stop aborts the live spawn and resolves only after backend exit", async () => {
    let signal: AbortSignal | undefined;
    let resolveSpawn = (_result: { code: number; stdout: string; stderr: string; signal: string }): void => {};
    const adapter = new ClaudeAdapter({
      spawn: async (_cmd, _args, opts) => {
        signal = opts.signal;
        return await new Promise((resolve) => {
          resolveSpawn = resolve;
        });
      },
      sessionDiscoveryFs: emptyDiscoveryFs,
      sessionParserFs: emptyParserFs,
    });

    const resultPromise = adapter.spawn({
      run_id: "run-cancel-claude",
      cwd: "/tmp",
      prompt: "test prompt",
    });
    let stopSettled = false;
    const stopPromise = adapter.stop("run-cancel-claude").then(() => {
      stopSettled = true;
    });

    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    resolveSpawn({ code: 143, stdout: "", stderr: "", signal: "SIGTERM" });
    await stopPromise;
    const result = await resultPromise;
    expect(stopSettled).toBe(true);
    expect(result.events).toContainEqual({ event: "cancelled" });
    expect(result.spawn_error).toBeUndefined();
  });

  test("operator stop preserves already-parsed safe stream facts under process authority", async () => {
    let started!: () => void;
    const spawnStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const adapter = new ClaudeAdapter({
      spawn: async (_cmd, args, opts) => {
        const sessionId = args[1]!;
        opts.onStdoutChunk?.(Buffer.from(JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: sessionId,
          result: "Safe final before stop.",
          num_turns: 3,
          usage: { input_tokens: 100, output_tokens: 20 },
        }) + "\n"));
        started();
        return await new Promise((resolve) => {
          opts.signal?.addEventListener("abort", () => resolve({
            code: 143,
            stdout: "",
            stderr: "",
            signal: "SIGTERM",
            reason: "cancelled",
          }), { once: true });
        });
      },
      sessionDiscoveryFs: emptyDiscoveryFs,
      sessionParserFs: emptyParserFs,
    });

    const resultPromise = adapter.spawn({
      run_id: "run-stream-then-stop",
      cwd: "/tmp",
      prompt: "test prompt",
    });
    await spawnStarted;
    await adapter.stop("run-stream-then-stop");
    const result = await resultPromise;

    expect(result.session?.id).toMatch(UUID_PATTERN);
    expect(result.agent_terminal_message).toBe("Safe final before stop.");
    expect(result.terminal_evidence).toMatchObject({
      source: "process_exit",
      status: "authoritative",
      reason: "operator_stop",
      backend_subtype: "success",
      signal: "SIGTERM",
      num_turns: 3,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  });

  test("a throwing backend event sink still settles the active run", async () => {
    let spawnCalled = false;
    const adapter = new ClaudeAdapter({
      spawn: async () => {
        spawnCalled = true;
        return { code: 0, stdout: "", stderr: "" };
      },
      sessionDiscoveryFs: emptyDiscoveryFs,
      sessionParserFs: emptyParserFs,
    });

    const result = await adapter.spawn({
      run_id: "run-event-sink-failure",
      cwd: "/tmp",
      prompt: "test prompt",
      onEvent: () => {
        throw new Error("event sink failed");
      },
    });

    expect(spawnCalled).toBe(false);
    expect(result.events).toContainEqual({
      event: "infra_failure",
      payload: { error: "event sink failed" },
    });
    await expect(adapter.stop("run-event-sink-failure")).resolves.toBeUndefined();
  });

  test("rejects Codex-only reasoning effort values before spawning", async () => {
    const calls: SpawnCall[] = [];
    const adapter = makeAdapter(calls);

    await expect(adapter.spawn({
      run_id: "run-1319-invalid",
      cwd: "/tmp",
      prompt: "test prompt",
      backend_options: { reasoning_effort: "minimal" },
    })).rejects.toThrow("Valid Claude values: low, medium, high, xhigh, max");

    expect(calls).toHaveLength(0);
  });

  describe("anthropic auth env hygiene (POL-1139)", () => {
    const ORIGINAL = process.env.CALYX_CLAUDE_USE_API_KEY;
    beforeEach(() => {
      delete process.env.CALYX_CLAUDE_USE_API_KEY;
    });
    afterEach(() => {
      if (ORIGINAL === undefined) {
        delete process.env.CALYX_CLAUDE_USE_API_KEY;
      } else {
        process.env.CALYX_CLAUDE_USE_API_KEY = ORIGINAL;
      }
    });

    test("strips ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from spawn env by default", async () => {
      const calls: SpawnCall[] = [];
      const adapter = makeAdapter(calls);

      await adapter.spawn({
        run_id: "run-1139-a",
        cwd: "/tmp",
        prompt: "p",
      });

      const spawnEnv = calls[0]?.opts.env;
      expect(spawnEnv).toBeDefined();
      // The adapter signals "remove from child env" by setting the key to
      // undefined in the env dict; resolveSpawnEnv in spawn.ts deletes those
      // keys from the merged env before handing it to execFile.
      expect(spawnEnv).toHaveProperty("ANTHROPIC_API_KEY", undefined);
      expect(spawnEnv).toHaveProperty("ANTHROPIC_AUTH_TOKEN", undefined);
    });

    test("CALYX_CLAUDE_USE_API_KEY=1 opts in to API-key auth (no strip)", async () => {
      process.env.CALYX_CLAUDE_USE_API_KEY = "1";
      const calls: SpawnCall[] = [];
      const adapter = makeAdapter(calls);

      await adapter.spawn({
        run_id: "run-1139-b",
        cwd: "/tmp",
        prompt: "p",
      });

      const spawnEnv = calls[0]?.opts.env;
      // With the escape hatch set and no backend_options.env overrides,
      // the adapter should not pass an env dict at all (parent env is inherited
      // unchanged by spawn.ts).
      expect(spawnEnv).toBeUndefined();
    });

    test("caller backend_options.env overrides the default strip", async () => {
      const calls: SpawnCall[] = [];
      const adapter = makeAdapter(calls);

      await adapter.spawn({
        run_id: "run-1139-c",
        cwd: "/tmp",
        prompt: "p",
        backend_options: {
          env: {
            ANTHROPIC_API_KEY: "sk-ant-explicit-override",
          },
        },
      });

      const spawnEnv = calls[0]?.opts.env;
      expect(spawnEnv).toBeDefined();
      expect(spawnEnv?.ANTHROPIC_API_KEY).toBe("sk-ant-explicit-override");
      // ANTHROPIC_AUTH_TOKEN was not overridden by caller, so the default
      // strip still applies to it.
      expect(spawnEnv).toHaveProperty("ANTHROPIC_AUTH_TOKEN", undefined);
    });
  });
});
