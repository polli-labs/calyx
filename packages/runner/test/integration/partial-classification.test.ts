/**
 * Integration tests — Partial classification (POL-904).
 *
 * Exercises the full orchestrator pipeline with the exit classifier wired in:
 *   dispatch gate → worktree acquire → adapter execution → classification →
 *   exit classifier → artifact gate → receipt emission → worktree release
 *
 * Variants:
 *   - Budget-exhausted run (many events, session evidence, exit 1) → partial
 *   - Immediate crash (no work done, exit 1) → failed
 *   - Clean success (exit 0) → succeeded (no regression)
 *   - Receipt reflects correct classification and partial_reason
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { executeRun } from "../../src/run.js";
import { runReceiptSchema } from "../../src/schemas.js";
import type { RunSpec, LifecycleEvent } from "../../src/types.js";
import type {
  BackendAdapter,
  AdapterResult,
  AdapterSpawnOptions,
} from "../../src/adapters/types.js";

/** Mock adapter that returns configurable results. */
function createMockAdapter(result: Partial<AdapterResult> = {}): BackendAdapter {
  return {
    name: "mock",
    capabilities: {
      streaming: false,
      turnControl: false,
      resumeSession: false,
      forkSession: false,
      approvals: "none",
    },
    async spawn(opts: AdapterSpawnOptions): Promise<AdapterResult> {
      opts.onEvent?.({
        timestamp: new Date().toISOString(),
        run_id: opts.run_id,
        event: "backend_spawned",
        message: "Mock adapter spawned",
      });
      const durationMs = result.duration_ms ?? 100;
      vi.setSystemTime(new Date(Date.now() + durationMs));
      return {
        exit_code: result.exit_code ?? 0,
        stderr: result.stderr ?? "",
        events: result.events ?? [],
        duration_ms: durationMs,
        session: result.session,
        agent_terminal_message: result.agent_terminal_message,
      };
    },
    async stop() {},
  };
}

/** Mock exec for worktree manager. */
function mockExec(): (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }> {
  return async (_cmd, args) => {
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
    return { code: 128, stdout: "", stderr: "fatal: already exists" };
  };
}

/** Build a valid RunSpec for testing. */
function validSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    run_id: randomUUID(),
    host: "blade",
    backend: "claude",
    prompt: "Test prompt",
    require_execplan: false,
    pull_execplan: false,
    worktree: {
      ref: "origin/main",
      branch: "test-branch",
      steal_lock: false,
    },
    ...overrides,
  };
}

describe("Partial classification integration", () => {
  let tmpDir: string;
  let receiptPath: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T10:00:00.000Z"));
    tmpDir = await mkdtemp(join(tmpdir(), "calyx-partial-"));
    await mkdir(join(tmpDir, ".git"), { recursive: true });
    receiptPath = join(tmpDir, "receipt.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("budget-exhausted run with session evidence → partial state in receipt", async () => {
    // Create a session fixture in the tmp dir
    const sessionPath = join(tmpDir, "session.jsonl");
    const sessionLines = [
      '{"uuid":"m1","timestamp":"2026-03-18T10:00:01Z","sessionId":"s1","type":"human","message":{"role":"human","content":"Do the work."}}',
      '{"uuid":"m2","timestamp":"2026-03-18T10:00:05Z","sessionId":"s1","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Reading files."},{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}',
      '{"uuid":"m3","timestamp":"2026-03-18T10:00:10Z","sessionId":"s1","type":"tool_result","message":{"role":"tool","content":"data"}}',
      '{"uuid":"m4","timestamp":"2026-03-18T10:00:15Z","sessionId":"s1","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Editing files."},{"type":"tool_use","id":"t2","name":"Edit","input":{}}]}}',
      '{"uuid":"m5","timestamp":"2026-03-18T10:00:20Z","sessionId":"s1","type":"tool_result","message":{"role":"tool","content":"done"}}',
      '{"uuid":"m6","timestamp":"2026-03-18T10:00:25Z","sessionId":"s1","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Running tests."},{"type":"tool_use","id":"t3","name":"Bash","input":{}}]}}',
      '{"uuid":"m7","timestamp":"2026-03-18T10:00:30Z","sessionId":"s1","type":"tool_result","message":{"role":"tool","content":"pass"}}',
      '{"uuid":"m8","timestamp":"2026-03-18T10:00:35Z","sessionId":"s1","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I completed phases A and B. The types were updated and the classifier was created."}]}}',
    ].join("\n");
    await writeFile(sessionPath, sessionLines, "utf-8");

    const spec = validSpec();
    const result = await executeRun(spec, {
      adapter: createMockAdapter({
        exit_code: 1,
        duration_ms: 300_000,
        session: { id: "s1", path: sessionPath, backend: "claude" },
        agent_terminal_message:
          "I completed phases A and B. The types were updated and the classifier was created.",
      }),
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    // State should be partial
    expect(result.receipt.state).toBe("partial");
    expect(result.receipt.exit.partial_reason).toBe("budget_exhaustion");

    // Receipt still validates against schema
    const parsed = runReceiptSchema.safeParse(result.receipt);
    expect(parsed.success).toBe(true);

    // Summary mentions partial
    expect(result.receipt.summary).toContain("partially");

    // Receipt was written to disk
    const diskReceipt = JSON.parse(await readFile(receiptPath, "utf-8"));
    expect(diskReceipt.state).toBe("partial");
    expect(diskReceipt.exit.partial_reason).toBe("budget_exhaustion");
  });

  it("immediate crash with no session → failed (no regression)", async () => {
    const spec = validSpec();
    const result = await executeRun(spec, {
      adapter: createMockAdapter({
        exit_code: 1,
        duration_ms: 2000,
        stderr: "",
      }),
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.state).toBe("failed");
    expect(result.receipt.exit.partial_reason).toBeUndefined();

    const parsed = runReceiptSchema.safeParse(result.receipt);
    expect(parsed.success).toBe(true);
  });

  it("clean success → succeeded (no regression)", async () => {
    const spec = validSpec();
    const result = await executeRun(spec, {
      adapter: createMockAdapter({ exit_code: 0 }),
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.state).toBe("succeeded");
    expect(result.receipt.exit.partial_reason).toBeUndefined();

    const parsed = runReceiptSchema.safeParse(result.receipt);
    expect(parsed.success).toBe(true);
  });

  it("SIGTERM stderr with no session → partial with operator_stop", async () => {
    const spec = validSpec();
    const result = await executeRun(spec, {
      adapter: createMockAdapter({
        exit_code: 143,
        duration_ms: 120_000,
        stderr: "Received SIGTERM, shutting down gracefully",
      }),
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.state).toBe("partial");
    expect(result.receipt.exit.partial_reason).toBe("operator_stop");
  });

  it("long run without session evidence → partial (low confidence) via duration heuristic", async () => {
    const spec = validSpec();
    const result = await executeRun(spec, {
      adapter: createMockAdapter({
        exit_code: 1,
        duration_ms: 600_000, // 10 minutes
        stderr: "",
      }),
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.state).toBe("partial");
    expect(result.receipt.exit.partial_reason).toBe("unknown");
  });

  it("state transition events include partial transition", async () => {
    const sessionPath = join(tmpDir, "session-events.jsonl");
    const sessionLines = [
      '{"uuid":"m1","timestamp":"2026-03-18T10:00:01Z","sessionId":"s1","type":"human","message":{"role":"human","content":"work"}}',
      '{"uuid":"m2","timestamp":"2026-03-18T10:00:05Z","sessionId":"s1","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I merged the PR and updated the docs."}]}}',
      '{"uuid":"m3","timestamp":"2026-03-18T10:00:10Z","sessionId":"s1","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Completed the implementation."}]}}',
    ].join("\n");
    await writeFile(sessionPath, sessionLines, "utf-8");

    const spec = validSpec();
    const collectedEvents: LifecycleEvent[] = [];

    await executeRun(spec, {
      adapter: createMockAdapter({
        exit_code: 1,
        duration_ms: 300_000,
        session: { id: "s1", path: sessionPath, backend: "claude" },
        agent_terminal_message: "Completed the implementation.",
      }),
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
      onEvent: (ev) => collectedEvents.push(ev),
    });

    const transitions = collectedEvents
      .filter((e) => e.event === "state_transition")
      .map((e) => ({ from: e.from, to: e.to }));

    expect(transitions).toEqual([
      { from: "queued", to: "dispatching" },
      { from: "dispatching", to: "running" },
      { from: "running", to: "partial" },
    ]);
  });

  it("adapter spawn_error propagates through to receipt (POL-912)", async () => {
    const spawnErrorAdapter: BackendAdapter = {
      name: "mock-spawn-error",
      capabilities: {
        streaming: false,
        turnControl: false,
        resumeSession: false,
        forkSession: false,
        approvals: "none",
      },
      async spawn(opts: AdapterSpawnOptions): Promise<AdapterResult> {
        opts.onEvent?.({
          timestamp: new Date().toISOString(),
          run_id: opts.run_id,
          event: "backend_spawned",
          message: "Mock adapter spawned",
        });
        vi.setSystemTime(new Date(Date.now() + 60_000));
        return {
          exit_code: 1,
          stderr: "partial output before buffer overflow",
          events: [],
          duration_ms: 60_000,
          spawn_error: "maxBuffer exceeded",
        };
      },
      async stop() {},
    };

    const spec = validSpec();
    const result = await executeRun(spec, {
      adapter: spawnErrorAdapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    // SpawnErrorClassifier should classify as infra_error
    expect(result.receipt.state).toBe("infra_error");
    expect(result.receipt.spawn_error).toBe("maxBuffer exceeded");
    expect(result.receipt.backend_stderr).toBe("partial output before buffer overflow");

    const parsed = runReceiptSchema.safeParse(result.receipt);
    expect(parsed.success).toBe(true);
  });

  it("adapter signal propagates through to receipt (POL-912)", async () => {
    const signalAdapter: BackendAdapter = {
      name: "mock-signal",
      capabilities: {
        streaming: false,
        turnControl: false,
        resumeSession: false,
        forkSession: false,
        approvals: "none",
      },
      async spawn(opts: AdapterSpawnOptions): Promise<AdapterResult> {
        opts.onEvent?.({
          timestamp: new Date().toISOString(),
          run_id: opts.run_id,
          event: "backend_spawned",
          message: "Mock adapter spawned",
        });
        vi.setSystemTime(new Date(Date.now() + 120_000));
        return {
          exit_code: 137,
          stderr: "",
          events: [],
          duration_ms: 120_000,
          signal: "SIGKILL",
        };
      },
      async stop() {},
    };

    const spec = validSpec();
    const result = await executeRun(spec, {
      adapter: signalAdapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.backend_signal).toBe("SIGKILL");

    const parsed = runReceiptSchema.safeParse(result.receipt);
    expect(parsed.success).toBe(true);
  });

  it("backend_stderr is truncated to 10KB in receipt (POL-912)", async () => {
    const largeStderr = "X".repeat(20_000);
    const spec = validSpec();
    const result = await executeRun(spec, {
      adapter: createMockAdapter({
        exit_code: 1,
        duration_ms: 2000,
        stderr: largeStderr,
      }),
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.backend_stderr).toBeDefined();
    expect(result.receipt.backend_stderr!.length).toBe(10240);

    const parsed = runReceiptSchema.safeParse(result.receipt);
    expect(parsed.success).toBe(true);
  });

  it("existing completed_dirty path still works", async () => {
    // High event adapter (exceeds dirty threshold)
    const highEventAdapter: BackendAdapter = {
      name: "mock-dirty",
      capabilities: {
        streaming: false,
        turnControl: false,
        resumeSession: false,
        forkSession: false,
        approvals: "none",
      },
      async spawn(opts: AdapterSpawnOptions): Promise<AdapterResult> {
        for (let i = 0; i < 12; i++) {
          opts.onEvent?.({
            timestamp: new Date().toISOString(),
            run_id: opts.run_id,
            event: "backend_event",
            message: `Event ${i}`,
          });
        }
        return {
          exit_code: 1,
          stderr: "",
          events: [],
          duration_ms: 500, // Short duration — no session
        };
      },
      async stop() {},
    };

    const spec = validSpec({ required_artifacts: ["output.txt"] });
    const result = await executeRun(spec, {
      adapter: highEventAdapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      discoverArtifacts: async () => [
        {
          name: "output.txt",
          location: "worktree",
          path: join(tmpDir, "output.txt"),
          required: true,
          detected_at: new Date().toISOString(),
        },
      ],
      receiptPath,
    });

    // Without session evidence but short duration, the exit classifier
    // won't trigger partial; legacy classifier produces completed_dirty
    // when event count + artifact present. But since exit_code is 1 and
    // short duration and no session, the exit pipeline says "failed".
    // The legacy classifier says "completed_dirty" but the exit pipeline
    // runs AFTER and overrides only when it says "partial".
    // Since exit pipeline says "failed" for short run + exit 1 + no session,
    // the legacy completed_dirty takes precedence.
    expect(result.receipt.state).toBe("completed_dirty");
    expect(result.receipt.exit.failure_class).toBe("completed_dirty");
  });
});
