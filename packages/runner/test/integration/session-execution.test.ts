import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { executeRun } from "../../src/run.js";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import type { SessionDiscoveryFs } from "../../src/adapters/session-discovery.js";
import type { LifecycleEvent, RunHealthSnapshot, RunSpec } from "../../src/types.js";
import type {
  AdapterSession,
  AdapterStartOptions,
  AdapterTurnHandle,
  BackendAdapter,
  SessionInfo,
  TurnEvent,
  TurnInput,
  TurnResult,
} from "../../src/adapters/types.js";

async function* toAsyncIterable(events: TurnEvent[]): AsyncIterable<TurnEvent> {
  for (const event of events) {
    yield event;
  }
}

function mockExec() {
  return async (_cmd: string, args: string[]) => {
    if (args[0] === "show-ref") {
      return { code: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "remote") {
      return { code: 0, stdout: "origin\n", stderr: "" };
    }
    if (args[0] === "fetch") {
      return { code: 0, stdout: "", stderr: "" };
    }
    const worktreePath = args.at(-2);
    if (worktreePath) {
      await mkdir(worktreePath, { recursive: true });
    }
    return {
      code: 128,
      stdout: "",
      stderr: "fatal: already exists",
    };
  };
}

function validSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    run_id: randomUUID(),
    host: "blade",
    backend: "codex",
    prompt: "Initial prompt",
    require_execplan: false,
    pull_execplan: false,
    worktree: {
      ref: "origin/main",
      branch: "test-multi-turn",
      steal_lock: false,
    },
    ...overrides,
  };
}

function createSessionAdapter(
  turns: Array<{ result: TurnResult; events?: TurnEvent[] }>,
  overrides: { turnControl?: boolean } = {},
): BackendAdapter {
  const turnControl = overrides.turnControl ?? true;
  return {
    name: "session-mock",
    capabilities: {
      streaming: true,
      turnControl,
      resumeSession: true,
      forkSession: false,
      approvals: "none",
    },
    async startSession(_opts: AdapterStartOptions): Promise<AdapterSession> {
      let index = 0;
      const backendSession: SessionInfo = {
        id: "sess-001",
        path: "/tmp/sess-001.jsonl",
        backend: "codex",
      };
      return {
        id: "adapter-session-001",
        backend_session: backendSession,
        capabilities: {
          streaming: true,
          turnControl,
          resumeSession: true,
          forkSession: false,
          approvals: "none",
        },
        async startTurn(_input: TurnInput): Promise<AdapterTurnHandle> {
          const current = turns[index];
          index += 1;
          return {
            id: `adapter-turn-${index}`,
            events: toAsyncIterable(current?.events ?? []),
            wait: async (): Promise<TurnResult> => current!.result,
            interrupt: async (): Promise<void> => {},
          };
        },
        async close(): Promise<void> {},
      };
    },
    async stop(): Promise<void> {},
  };
}

function createNoisyActivityAdapter(activityCount: number): BackendAdapter {
  return {
    name: "activity-mock",
    capabilities: {
      streaming: true,
      turnControl: true,
      resumeSession: true,
      forkSession: false,
      approvals: "none",
    },
    async startSession(opts: AdapterStartOptions): Promise<AdapterSession> {
      const backendSession: SessionInfo = {
        id: "sess-noisy-001",
        path: "/tmp/sess-noisy-001.jsonl",
        backend: "codex",
      };
      const baseMs = Date.now() - activityCount * 1_000;
      for (let i = 0; i < activityCount; i += 1) {
        opts.onActivity?.({
          source: "stdout",
          bytes: 1,
          timestamp: new Date(baseMs + i * 1_000).toISOString(),
        });
      }
      return {
        id: "adapter-session-noisy-001",
        backend_session: backendSession,
        capabilities: {
          streaming: true,
          turnControl: true,
          resumeSession: true,
          forkSession: false,
          approvals: "none",
        },
        async startTurn(_input: TurnInput): Promise<AdapterTurnHandle> {
          return {
            id: "adapter-turn-noisy-001",
            events: toAsyncIterable([]),
            wait: async (): Promise<TurnResult> => ({
              exit_code: 0,
              stderr: "",
              events: [],
              duration_ms: 10,
              session: backendSession,
              agent_terminal_message: "Noisy turn complete",
              backend_turn_id: "backend-turn-noisy-001",
            }),
            interrupt: async (): Promise<void> => {},
          };
        },
        async close(): Promise<void> {},
      };
    },
    async stop(): Promise<void> {},
  };
}

function createClaudeSignalAdapter(
  signal: "available" | "unavailable" | "failed",
  delayMs = 0,
): BackendAdapter {
  return {
    name: "claude",
    capabilities: {
      streaming: true,
      turnControl: false,
      resumeSession: true,
      forkSession: false,
      approvals: "none",
    },
    async startSession(opts: AdapterStartOptions): Promise<AdapterSession> {
      opts.onActivity?.({
        source: "claude_stream",
        timestamp: new Date().toISOString(),
        semantic: signal === "available",
        signal: {
          source: "claude_stream",
          status: signal,
          reason: signal === "available"
            ? "stream_initialized"
            : signal === "failed"
              ? "malformed_stream"
              : "no_structured_events",
        },
      });
      return {
        id: "claude-session-adapter",
        backend_session: { id: "claude-session", backend: "claude" },
        capabilities: this.capabilities,
        async startTurn(): Promise<AdapterTurnHandle> {
          return {
            id: "claude-turn",
            events: toAsyncIterable([]),
            wait: async (): Promise<TurnResult> => {
              if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
              return {
                exit_code: 0,
                stderr: "",
                events: [],
                duration_ms: delayMs,
                session: { id: "claude-session", backend: "claude" },
                agent_terminal_message: "Done.",
                terminal_evidence: signal === "available"
                  ? {
                      schema_version: "calyx.agent-terminal-evidence/v1",
                      source: "claude_stream",
                      status: "authoritative",
                      reason: "completed",
                      backend_subtype: "success",
                      session_id: "claude-session",
                    }
                  : {
                      schema_version: "calyx.agent-terminal-evidence/v1",
                      source: "claude_stream",
                      status: signal === "failed" ? "malformed" : "missing",
                      reason: "missing_result",
                      session_id: "claude-session",
                    },
              };
            },
            interrupt: async () => {},
          };
        },
        async close() {},
      };
    },
    async stop() {},
  };
}

describe("Session execution integration", () => {
  let tmpDir: string;
  let receiptPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "calyx-session-"));
    await mkdir(join(tmpDir, ".git"), { recursive: true });
    receiptPath = join(tmpDir, "receipt.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("persists a validated spawn-backed Claude session in the terminal receipt", async () => {
    let assignedSessionId: string | undefined;
    let spawnedCwd: string | undefined;
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
        cwd: spawnedCwd,
        timestamp: Date.now(),
      }),
      stat: async () => ({ mtimeMs: Date.now() }),
      homedir: () => "/home/testuser",
    };
    const adapter = new ClaudeAdapter({
      spawn: async (_cmd, args, opts) => {
        assignedSessionId = args[1];
        spawnedCwd = opts.cwd;
        return { code: 0, stdout: "Claude run complete.", stderr: "" };
      },
      sessionDiscoveryFs,
      sessionParserFs: { readFile: async () => "" },
    });

    const result = await executeRun(validSpec({ backend: "claude" }), {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    const expectedSession = {
      id: assignedSessionId,
      path: `/home/testuser/.claude/projects/project/${assignedSessionId}.jsonl`,
      backend: "claude",
    };
    expect(result.receipt.backend_session).toEqual(expectedSession);
    const persisted = JSON.parse(await readFile(receiptPath, "utf8")) as {
      backend_session?: unknown;
    };
    expect(persisted.backend_session).toEqual(expectedSession);
  });

  it("stops successfully after one turn when a non-turn-control session receives daemon continuation input", async () => {
    let nextTurnCalls = 0;
    const adapter = createSessionAdapter([
      {
        result: {
          exit_code: 0,
          stderr: "",
          events: [],
          duration_ms: 25,
          session: { id: "sess-001", path: "/tmp/sess-001.jsonl", backend: "codex" },
          agent_terminal_message: "Spawn-compatible turn complete",
          backend_turn_id: "backend-turn-1",
        },
      },
    ], { turnControl: false });

    const result = await executeRun(validSpec({ max_turns_per_run: 3 }), {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
      nextTurnInput: async () => {
        nextTurnCalls += 1;
        return { prompt: "Daemon continuation that must not be used" };
      },
    });

    const sessionSummary = result.receipt.metadata?.session_summary as {
      turns_total: number;
      terminal_turn_index: number;
      stop_reason: string;
      turns: Array<{ turn_index: number; state: string }>;
    };

    expect(result.receipt.state).toBe("succeeded");
    expect(nextTurnCalls).toBe(0);
    expect(sessionSummary.turns_total).toBe(1);
    expect(sessionSummary.terminal_turn_index).toBe(1);
    expect(sessionSummary.stop_reason).toBe("natural_stop");
    expect(sessionSummary.turns[0]?.state).toBe("succeeded");
  });

  it("persists an explicit backend cancellation as a cancelled run receipt", async () => {
    const adapter = createSessionAdapter([
      {
        result: {
          exit_code: 143,
          signal: "SIGTERM",
          stderr: "",
          events: [{ event: "cancelled" }],
          duration_ms: 25,
        },
      },
    ], { turnControl: false });

    const result = await executeRun(validSpec(), {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });
    const sessionSummary = result.receipt.metadata?.session_summary as {
      stop_reason: string;
      turns: Array<{ state: string }>;
    };

    expect(result.receipt.state).toBe("cancelled");
    expect(result.receipt.spawn_error).toBeUndefined();
    expect(result.receipt.exit).toMatchObject({
      exit_code: 143,
      failure_class: "task_failure",
      failure_source: "backend_event",
    });
    expect(sessionSummary.stop_reason).toBe("cancelled");
    expect(sessionSummary.turns[0]?.state).toBe("cancelled");
  });

  it("persists cancellation when an aborted spawn returns no process exit code", async () => {
    const adapter = createSessionAdapter([
      {
        result: {
          stderr: "The spawn promise rejected after abort",
          events: [{ event: "cancelled" }],
          duration_ms: 25,
        },
      },
    ], { turnControl: false });

    const result = await executeRun(validSpec(), {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.state).toBe("cancelled");
    expect(result.receipt.spawn_error).toBeUndefined();
    expect(result.receipt.exit).toMatchObject({
      exit_code: 130,
      failure_class: "task_failure",
      failure_source: "backend_event",
    });
  });

  it.each([
    ["auth_failure", "auth_error"],
    ["infra_failure", "infra_error"],
  ] as const)(
    "preserves typed %s precedence when cancellation races a fatal backend event",
    async (fatalEvent, expectedState) => {
      const adapter = createSessionAdapter([
        {
          result: {
            exit_code: 143,
            stderr: "",
            events: [{ event: "cancelled" }, { event: fatalEvent }],
            duration_ms: 25,
          },
        },
      ], { turnControl: false });

      const result = await executeRun(validSpec(), {
        adapter,
        worktree: { base_path: tmpDir, exec: mockExec() },
        receiptPath,
      });

      expect(result.receipt.state).toBe(expectedState);
      expect(result.receipt.exit.failure_class).toBe(expectedState);
    },
  );

  it("preserves a malformed Claude result as typed terminal infra failure", async () => {
    const adapter = createSessionAdapter([{
      result: {
        exit_code: 0,
        stderr: "",
        events: [],
        duration_ms: 10,
        agent_terminal_message: "Last completed assistant message.",
        terminal_evidence: {
          schema_version: "calyx.agent-terminal-evidence/v1",
          source: "claude_stream",
          status: "malformed",
          reason: "malformed_result",
          session_id: "malformed-session",
        },
      },
    }], { turnControl: false });
    const result = await executeRun(validSpec({ backend: "claude" }), {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });
    expect(result.receipt.state).toBe("infra_error");
    expect(result.receipt.agent_terminal_message).toBe("Last completed assistant message.");
    expect(result.receipt.terminal_evidence).toMatchObject({
      status: "malformed",
      reason: "malformed_result",
    });
  });

  it("preserves a typed spawn failure when cancellation races teardown", async () => {
    const adapter = createSessionAdapter([
      {
        result: {
          exit_code: 137,
          signal: "SIGKILL",
          stderr: "",
          spawn_error: "process tree remained alive after SIGKILL",
          events: [{ event: "cancelled" }],
          duration_ms: 25,
        },
      },
    ], { turnControl: false });

    const result = await executeRun(validSpec(), {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.state).toBe("infra_error");
    expect(result.receipt.spawn_error).toBe("process tree remained alive after SIGKILL");
  });

  it("records multi-turn session summaries inside a single run", async () => {
    const adapter = createSessionAdapter([
      {
        result: {
          exit_code: 0,
          stderr: "",
          events: [],
          duration_ms: 25,
          session: { id: "sess-001", path: "/tmp/sess-001.jsonl", backend: "codex" },
          agent_terminal_message: "First turn complete",
          backend_turn_id: "backend-turn-1",
        },
        events: [{ kind: "turn", payload: { phase: "completed", message: "Turn 1 completed" } }],
      },
      {
        result: {
          exit_code: 0,
          stderr: "",
          events: [],
          duration_ms: 40,
          session: { id: "sess-001", path: "/tmp/sess-001.jsonl", backend: "codex" },
          agent_terminal_message: "Second turn complete",
          backend_turn_id: "backend-turn-2",
        },
        events: [{ kind: "token_usage", payload: { input_tokens: 10, output_tokens: 20 } }],
      },
    ]);

    const result = await executeRun(validSpec({ max_turns_per_run: 3 }), {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
      nextTurnInput: async ({ turn_index }) => (
        turn_index === 1 ? { prompt: "Continue the run" } : null
      ),
    });

    const sessionSummary = result.receipt.metadata?.session_summary as {
      turns_total: number;
      terminal_turn_index: number;
      stop_reason: string;
      turns: Array<{ turn_index: number; backend_turn_id?: string }>;
    };

    expect(result.receipt.state).toBe("succeeded");
    expect(result.receipt.backend_session?.id).toBe("sess-001");
    expect(sessionSummary.turns_total).toBe(2);
    expect(sessionSummary.terminal_turn_index).toBe(2);
    expect(sessionSummary.stop_reason).toBe("continuation_declined");
    expect(sessionSummary.turns.map((turn) => turn.turn_index)).toEqual([1, 2]);
    expect(sessionSummary.turns[1]?.backend_turn_id).toBe("backend-turn-2");
  });

  it("records requested and applied backend model metadata in receipts", async () => {
    let startOptions: AdapterStartOptions | undefined;
    const adapter = {
      ...createSessionAdapter([
        {
          result: {
            exit_code: 0,
            stderr: "",
            events: [],
            duration_ms: 25,
            session: { id: "sess-001", path: "/tmp/sess-001.jsonl", backend: "claude" },
            agent_terminal_message: "Model-specific turn complete",
          },
        },
      ]),
      async startSession(opts: AdapterStartOptions): Promise<AdapterSession> {
        startOptions = opts;
        return createSessionAdapter([
          {
            result: {
              exit_code: 0,
              stderr: "",
              events: [],
              duration_ms: 25,
              session: { id: "sess-001", path: "/tmp/sess-001.jsonl", backend: "claude" },
              agent_terminal_message: "Model-specific turn complete",
            },
          },
        ]).startSession!(opts);
      },
    } satisfies BackendAdapter;

    const result = await executeRun(validSpec({
      backend: "claude",
      profile: "review-profile",
      backend_options: { model: "opus" },
    }), {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(startOptions?.backend_options?.model).toBe("opus");
    expect(result.receipt.run_spec.profile).toBe("review-profile");
    expect(result.receipt.run_spec.backend_options?.model).toBe("opus");
    expect(result.receipt.metadata?.backend_model).toEqual({
      requested: "opus",
      applied: "opus",
      source: "backend_options.model",
    });
  });

  it("preserves the Claude-native max_turns field from spec through receipt", async () => {
    let startOptions: AdapterStartOptions | undefined;
    const adapter = {
      ...createSessionAdapter([{
        result: {
          exit_code: 0,
          stderr: "",
          events: [],
          duration_ms: 25,
          session: { id: "sess-turn-cap", path: "/tmp/sess-turn-cap.jsonl", backend: "claude" },
          agent_terminal_message: "Bounded turn complete",
        },
      }]),
      async startSession(opts: AdapterStartOptions): Promise<AdapterSession> {
        startOptions = opts;
        return createSessionAdapter([{
          result: {
            exit_code: 0,
            stderr: "",
            events: [],
            duration_ms: 25,
            session: { id: "sess-turn-cap", path: "/tmp/sess-turn-cap.jsonl", backend: "claude" },
            agent_terminal_message: "Bounded turn complete",
          },
        }]).startSession!(opts);
      },
    } satisfies BackendAdapter;

    const result = await executeRun(validSpec({
      backend: "claude",
      backend_options: { max_turns: 8 },
    }), {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(startOptions?.backend_options).toMatchObject({ max_turns: 8 });
    expect(startOptions?.backend_options).not.toHaveProperty("max_threads");
    expect(result.receipt.run_spec.backend_options).toMatchObject({ max_turns: 8 });
    expect(result.receipt.run_spec.backend_options).not.toHaveProperty("max_threads");
  });

  it("classifies turn-budget exhaustion as partial", async () => {
    const adapter = createSessionAdapter([
      {
        result: {
          exit_code: 0,
          stderr: "",
          events: [],
          duration_ms: 30,
          session: { id: "sess-001", path: "/tmp/sess-001.jsonl", backend: "codex" },
          agent_terminal_message: "Need another turn",
          backend_turn_id: "backend-turn-1",
        },
      },
    ]);

    const result = await executeRun(validSpec({ max_turns_per_run: 1 }), {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
      nextTurnInput: async () => ({ prompt: "Would continue if budget allowed" }),
    });

    const sessionSummary = result.receipt.metadata?.session_summary as { stop_reason: string };

    expect(result.receipt.state).toBe("partial");
    expect(result.receipt.exit.partial_reason).toBe("max_turns");
    expect(sessionSummary.stop_reason).toBe("max_turns");
  });

  it("coalesces noisy stdout activity into sparse health snapshots", async () => {
    const healthUpdates: RunHealthSnapshot[] = [];
    const noisyChunkCount = 25;

    const result = await executeRun(validSpec({
      backend_options: {
        agent_activity: {
          stale_after_ms: 60_000,
          poll_interval_ms: 60_000,
        },
      },
    }), {
      adapter: createNoisyActivityAdapter(noisyChunkCount),
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
      onHealthUpdate: (health) => {
        healthUpdates.push(health);
      },
    });

    const stdoutSnapshots = healthUpdates.filter((health) =>
      health.observations.some((observation) => observation.kind === "stdout"),
    );

    expect(result.receipt.state).toBe("succeeded");
    expect(stdoutSnapshots).toHaveLength(1);
    expect(healthUpdates.length).toBeLessThan(noisyChunkCount);
  });

  it.each(["unavailable", "failed"] as const)(
    "keeps Claude health unknown when the semantic stream is %s",
    async (signal) => {
      const result = await executeRun(validSpec({
        backend: "claude",
        backend_options: { agent_activity: { stale_after_ms: 10, poll_interval_ms: 5 } },
      }), {
        adapter: createClaudeSignalAdapter(signal, 20),
        worktree: { base_path: tmpDir, exec: mockExec() },
        receiptPath,
      });

      expect(result.receipt.state).toBe("succeeded");
      expect(result.receipt.health).toMatchObject({
        status: "unknown",
        progress_signal: {
          source: "claude_stream",
          status: signal,
        },
      });
      expect(result.receipt.health?.summary).toContain(
        signal === "failed" ? "progress failed" : "progress is unavailable",
      );
    },
  );

  it("keeps a silent unstructured Claude process unknown instead of false stale", async () => {
    const adapter = new ClaudeAdapter({
      spawn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { code: 0, stdout: "", stderr: "" };
      },
      sessionDiscoveryFs: {
        readdir: async () => [],
        readFile: async () => "",
        stat: async () => ({ mtimeMs: 0 }),
        homedir: () => "/tmp",
      },
      sessionParserFs: { readFile: async () => "" },
    });
    const result = await executeRun(validSpec({
      backend: "claude",
      backend_options: { agent_activity: { stale_after_ms: 10, poll_interval_ms: 5 } },
    }), {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });
    expect(result.receipt.state).toBe("succeeded");
    expect(result.receipt.health).toMatchObject({
      status: "unknown",
      progress_signal: {
        source: "claude_stream",
        status: "unavailable",
        reason: "no_structured_events",
      },
    });
    expect(result.receipt.terminal_evidence).toMatchObject({
      source: "process_exit",
      status: "missing",
      reason: "missing_result",
    });
  });

  it("marks init followed by a malformed Claude result failed/unknown end to end", async () => {
    const adapter = new ClaudeAdapter({
      spawn: async (_cmd, args, opts) => {
        const sessionId = args[1]!;
        opts.onStdoutChunk?.(Buffer.from([
          JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
          JSON.stringify({ type: "result", session_id: sessionId }),
          "",
        ].join("\n")));
        return { code: 0, stdout: "", stderr: "" };
      },
      sessionDiscoveryFs: {
        readdir: async () => [],
        readFile: async () => "",
        stat: async () => ({ mtimeMs: 0 }),
        homedir: () => "/tmp",
      },
      sessionParserFs: { readFile: async () => "" },
    });
    const result = await executeRun(validSpec({ backend: "claude" }), {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.state).toBe("infra_error");
    expect(result.receipt.health).toMatchObject({
      status: "unknown",
      progress_signal: {
        source: "claude_stream",
        status: "failed",
        reason: "malformed_stream",
      },
    });
    expect(result.receipt.terminal_evidence).toMatchObject({
      source: "claude_stream",
      status: "malformed",
      reason: "malformed_result",
    });
  });

  it("persists reconciled process authority without a contradictory Claude result event", async () => {
    const forwardedEvents: LifecycleEvent[] = [];
    const adapter = new ClaudeAdapter({
      spawn: async (_cmd, args, opts) => {
        const sessionId = args[1]!;
        opts.onStdoutChunk?.(Buffer.from(JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: sessionId,
          result: "Structured success contradicted by process exit.",
        }) + "\n"));
        return { code: 1, stdout: "", stderr: "" };
      },
      sessionDiscoveryFs: {
        readdir: async () => [],
        readFile: async () => "",
        stat: async () => ({ mtimeMs: 0 }),
        homedir: () => "/tmp",
      },
      sessionParserFs: { readFile: async () => "" },
    });
    const result = await executeRun(validSpec({ backend: "claude" }), {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
      onEvent: (event) => forwardedEvents.push(event),
    });
    const persisted = JSON.parse(await readFile(receiptPath, "utf8")) as {
      terminal_evidence?: unknown;
    };
    const resultEvents = result.events.filter((event) => event.payload?.["kind"] === "result");
    const forwardedResultEvents = forwardedEvents.filter(
      (event) => event.payload?.["kind"] === "result",
    );

    expect(result.receipt.state).toBe("failed");
    expect(result.receipt.terminal_evidence).toMatchObject({
      source: "process_exit",
      status: "authoritative",
      reason: "abnormal_exit",
      exit_code: 1,
    });
    expect(persisted.terminal_evidence).toEqual(result.receipt.terminal_evidence);
    expect(resultEvents).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          source: "process_exit",
          status: "authoritative",
          reason: "abnormal_exit",
          exit_code: 1,
        }),
      }),
    ]);
    expect(forwardedResultEvents).toEqual(resultEvents);
    expect(JSON.stringify({ resultEvents, forwardedResultEvents })).not.toContain('"reason":"completed"');
  });

  it("refreshes semantic health during a bounded Claude api_retry backoff", async () => {
    const healthUpdates: RunHealthSnapshot[] = [];
    const adapter = new ClaudeAdapter({
      spawn: async (_cmd, args, opts) => {
        const sessionId = args[1]!;
        opts.onStdoutChunk?.(Buffer.from(
          JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\n",
        ));
        await new Promise((resolve) => setTimeout(resolve, 20));
        opts.onStdoutChunk?.(Buffer.from(JSON.stringify({
          type: "system",
          subtype: "api_retry",
          session_id: sessionId,
          attempt: 1,
          max_retries: 3,
          retry_delay_ms: 20000,
          error_status: 529,
          error: "PRIVATE_RETRY_SENTINEL",
        }) + "\n"));
        await new Promise((resolve) => setTimeout(resolve, 50));
        opts.onStdoutChunk?.(Buffer.from(JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: sessionId,
          result: "Done.",
        }) + "\n"));
        return { code: 0, stdout: "", stderr: "" };
      },
      sessionDiscoveryFs: {
        readdir: async () => [],
        readFile: async () => "",
        stat: async () => ({ mtimeMs: 0 }),
        homedir: () => "/tmp",
      },
      sessionParserFs: { readFile: async () => "" },
    });
    const result = await executeRun(validSpec({
      backend: "claude",
      backend_options: { agent_activity: { stale_after_ms: 30, poll_interval_ms: 5 } },
    }), {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
      onHealthUpdate: (health) => healthUpdates.push(health),
    });

    expect(result.receipt.state).toBe("succeeded");
    expect(healthUpdates.some((health) => health.status === "stale")).toBe(false);
    expect(healthUpdates).toContainEqual(expect.objectContaining({
      status: "healthy",
      progress_signal: expect.objectContaining({
        expected_silence_until: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      }),
      summary: expect.stringContaining("semantic silence is expected until"),
    }));
    expect(result.events.some((event) => event.payload?.["kind"] === "api_retry")).toBe(true);
    expect(JSON.stringify(result.events)).not.toContain("PRIVATE_RETRY_SENTINEL");
  });

  it("marks an established Claude semantic stream stale after policy silence", async () => {
    const result = await executeRun(validSpec({
      backend: "claude",
      backend_options: { agent_activity: { stale_after_ms: 10, poll_interval_ms: 5 } },
    }), {
      adapter: createClaudeSignalAdapter("available", 25),
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.health).toMatchObject({
      status: "stale",
      progress_signal: {
        source: "claude_stream",
        status: "available",
      },
    });
    expect(result.receipt.health?.summary).toContain("via claude_stream");
  });

  it.each([
    ["max_turns", "partial", "max_turns"],
    ["budget_exhaustion", "partial", "budget_exhaustion"],
    ["operator_stop", "partial", "operator_stop"],
    ["backend_failure", "failed", undefined],
  ] as const)(
    "maps Claude terminal reason %s through the receipt taxonomy",
    async (terminalReason, expectedState, expectedPartialReason) => {
      const adapter = createSessionAdapter([{
        result: {
          exit_code: 0,
          stderr: "",
          events: [],
          duration_ms: 10,
          session: { id: "claude-terminal", backend: "claude" },
          agent_terminal_message: "Final message preserved.",
          terminal_evidence: {
            schema_version: "calyx.agent-terminal-evidence/v1",
            source: "claude_stream",
            status: "authoritative",
            reason: terminalReason,
            backend_subtype: terminalReason === "max_turns" ? "error_max_turns" : "error_during_execution",
          },
        },
      }], { turnControl: false });
      const result = await executeRun(validSpec({ backend: "claude" }), {
        adapter,
        worktree: { base_path: tmpDir, exec: mockExec() },
        receiptPath,
      });

      expect(result.receipt.state).toBe(expectedState);
      expect(result.receipt.exit.partial_reason).toBe(expectedPartialReason);
      expect(result.receipt.agent_terminal_message).toBe("Final message preserved.");
      expect(result.receipt.terminal_evidence?.reason).toBe(terminalReason);
    },
  );

  it.each([
    {
      label: "Claude typed stream evidence",
      backend: "claude" as const,
      stderr: "",
      providerConstraint: {
        schema_version: "calyx.provider-constraint/v1" as const,
        cause: "provider_capacity_exhausted" as const,
        backend: "claude",
        kind: "session_window" as const,
        source: "backend_stream" as const,
        observed_at: "2026-07-21T07:06:08.573Z",
        confidence: "definitive" as const,
        provider_code: "rate_limit",
        http_status: 429,
        reset_hint: "resets 8:10am (UTC)",
      },
      expectedKind: "session_window",
      expectedSource: "backend_stream",
    },
    {
      label: "Codex terminal stderr",
      backend: "codex" as const,
      stderr: "You've hit your usage limit. Purchase more credits or try again at Jul 23, 2026 03:00 UTC.",
      providerConstraint: undefined,
      expectedKind: "credits",
      expectedSource: "backend_stderr",
    },
  ])(
    "persists provider capacity from $label and stops continuation",
    async ({ backend, stderr, providerConstraint, expectedKind, expectedSource }) => {
      let continuationCalls = 0;
      const adapter = createSessionAdapter([{
        result: {
          exit_code: 1,
          stderr,
          events: [],
          duration_ms: 10,
          session: { id: `${backend}-capacity`, backend },
          ...(providerConstraint ? { provider_constraint: providerConstraint } : {}),
        },
      }]);
      const result = await executeRun(validSpec({ backend }), {
        adapter,
        worktree: { base_path: tmpDir, exec: mockExec() },
        receiptPath,
        nextTurnInput: () => {
          continuationCalls += 1;
          return { prompt: "This turn must never launch." };
        },
      });
      const persisted = JSON.parse(await readFile(receiptPath, "utf8")) as {
        terminal_evidence?: unknown;
      };

      expect(continuationCalls).toBe(0);
      expect(result.receipt.state).toBe("partial");
      expect(result.receipt.exit.partial_reason).toBe("budget_exhaustion");
      expect(result.receipt.terminal_evidence).toMatchObject({
        schema_version: "calyx.agent-terminal-evidence/v1",
        status: "authoritative",
        reason: "provider_capacity_exhausted",
        session_id: `${backend}-capacity`,
        exit_code: 1,
        provider_constraint: {
          schema_version: "calyx.provider-constraint/v1",
          cause: "provider_capacity_exhausted",
          backend,
          kind: expectedKind,
          source: expectedSource,
          confidence: "definitive",
        },
      });
      expect(persisted.terminal_evidence).toEqual(result.receipt.terminal_evidence);
      expect(JSON.stringify(result.receipt.terminal_evidence)).not.toContain("You've hit");
    },
  );

  it("does not derive provider capacity from arbitrary assistant prose", async () => {
    const adapter = createSessionAdapter([{
      result: {
        exit_code: 0,
        stderr: "",
        events: [],
        duration_ms: 10,
        session: { id: "assistant-prose", backend: "claude" },
        agent_terminal_message: "The docs mention a session limit.",
      },
    }], { turnControl: false });
    const result = await executeRun(validSpec({ backend: "claude" }), {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.state).toBe("succeeded");
    expect(result.receipt.exit.partial_reason).toBeUndefined();
    expect(result.receipt.terminal_evidence?.reason).not.toBe("provider_capacity_exhausted");
  });

  it("current structured success supersedes stale typed capacity evidence", async () => {
    const adapter = createSessionAdapter([{
      result: {
        exit_code: 0,
        stderr: "",
        events: [],
        duration_ms: 10,
        session: { id: "resumed-success", backend: "claude" },
        provider_constraint: {
          schema_version: "calyx.provider-constraint/v1",
          cause: "provider_capacity_exhausted",
          backend: "claude",
          kind: "session_window",
          source: "session_transcript",
          observed_at: "2026-07-21T07:06:08.573Z",
          confidence: "definitive",
        },
        terminal_evidence: {
          schema_version: "calyx.agent-terminal-evidence/v1",
          source: "claude_stream",
          status: "authoritative",
          reason: "completed",
          session_id: "resumed-success",
        },
      },
    }], { turnControl: false });
    const result = await executeRun(validSpec({ backend: "claude" }), {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.state).toBe("succeeded");
    expect(result.receipt.exit.partial_reason).toBeUndefined();
    expect(result.receipt.terminal_evidence).toMatchObject({
      status: "authoritative",
      reason: "completed",
    });
    expect(result.receipt.terminal_evidence?.provider_constraint).toBeUndefined();
  });

  it.each([
    [0, "Warning: usage limit configuration ignored; continuing normally.", "succeeded"],
    [1, "Warning: usage limit configuration ignored; continuing normally.", "failed"],
  ] as const)(
    "does not derive capacity from benign stderr at exit %i",
    async (exitCode, stderr, expectedState) => {
      const adapter = createSessionAdapter([{
        result: {
          exit_code: exitCode,
          stderr,
          events: [],
          duration_ms: 10,
          session: { id: "benign-stderr", backend: "codex" },
        },
      }], { turnControl: false });
      const result = await executeRun(validSpec({ backend: "codex" }), {
        adapter,
        worktree: { base_path: tmpDir, exec: mockExec() },
        receiptPath,
      });

      expect(result.receipt.state).toBe(expectedState);
      expect(result.receipt.exit.partial_reason).toBeUndefined();
      expect(result.receipt.terminal_evidence?.provider_constraint).toBeUndefined();
    },
  );

  it.each([
    [[{ event: "cancelled" }], undefined, 130, "cancelled"],
    [[], "process tree remained alive after SIGKILL", 1, "infra_error"],
    [[], undefined, 1, "failed"],
  ] as const)(
    "does not let a successful structured result override Calyx process authority (%s)",
    async (events, spawnError, exitCode, expectedState) => {
      const adapter = createSessionAdapter([{
        result: {
          exit_code: exitCode,
          stderr: "",
          events: [...events],
          duration_ms: 10,
          ...(spawnError ? { spawn_error: spawnError } : {}),
          terminal_evidence: {
            schema_version: "calyx.agent-terminal-evidence/v1",
            source: "claude_stream",
            status: "authoritative",
            reason: "completed",
            backend_subtype: "success",
          },
        },
      }], { turnControl: false });
      const result = await executeRun(validSpec({ backend: "claude" }), {
        adapter,
        worktree: { base_path: tmpDir, exec: mockExec() },
        receiptPath,
      });
      expect(result.receipt.state).toBe(expectedState);
      expect(result.receipt.terminal_evidence).toMatchObject({
        source: "process_exit",
        status: "authoritative",
        reason: expectedState === "cancelled" ? "operator_stop" : "abnormal_exit",
        exit_code: exitCode,
        backend_subtype: "success",
      });
    },
  );
});
