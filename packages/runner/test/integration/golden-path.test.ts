/**
 * Integration tests — Golden path.
 *
 * Exercises the full orchestrator pipeline with mocked dependencies:
 *   dispatch gate → worktree acquire → adapter execution → classification →
 *   artifact gate → receipt emission → worktree release
 *
 * Variants:
 *   - Successful run (exit 0, all artifacts present)
 *   - completed_dirty run (exit 1, artifacts present, high event count)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { executeRun } from "../../src/run.js";
import { runReceiptSchema } from "../../src/schemas.js";
import type { RunSpec, ArtifactEntry, LifecycleEvent } from "../../src/types.js";
import type { BackendAdapter, AdapterResult, AdapterSpawnOptions } from "../../src/adapters/types.js";

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
      // Emit a backend_spawned event to generate lifecycle events
      opts.onEvent?.({
        timestamp: new Date().toISOString(),
        run_id: opts.run_id,
        event: "backend_spawned",
        message: "Mock adapter spawned",
      });
      return {
        exit_code: result.exit_code ?? 0,
        stderr: result.stderr ?? "",
        events: result.events ?? [],
        duration_ms: result.duration_ms ?? 100,
      };
    },
    async stop() {},
  };
}

/** Mock exec that simulates an already-present git worktree target. */
function mockExec(): (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> {
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
    return {
      code: 128, // "already exists" is fine when the target directory exists.
      stdout: "",
      stderr: "fatal: already exists",
    };
  };
}

/** Create a mock artifact discoverer. */
function createArtifactDiscoverer(
  artifacts: ArtifactEntry[],
): (cwd: string, run_id: string) => Promise<ArtifactEntry[]> {
  return async () => artifacts;
}

/** Build a valid RunSpec for testing. */
function validSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    run_id: randomUUID(),
    host: "blade",
    backend: "claude",
    prompt: "Test prompt for golden path",
    require_execplan: false,
    pull_execplan: false,
    worktree: {
      ref: "origin/main",
      branch: "test-branch",
      steal_lock: false,
    },
    required_artifacts: ["receipt.json"],
    ...overrides,
  };
}

describe("Golden path integration", () => {
  let tmpDir: string;
  let receiptPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "calyx-golden-"));
    await mkdir(join(tmpDir, ".git"), { recursive: true });
    receiptPath = join(tmpDir, "receipt.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("successful run produces valid receipt with correct state transitions", async () => {
    const spec = validSpec();
    const collectedEvents: LifecycleEvent[] = [];

    const result = await executeRun(spec, {
      adapter: createMockAdapter({ exit_code: 0 }),
      worktree: {
        base_path: tmpDir,
        exec: mockExec(),
      },
      discoverArtifacts: createArtifactDiscoverer([
        {
          name: "receipt.json",
          location: "run_dir",
          path: receiptPath,
          required: true,
          detected_at: new Date().toISOString(),
        },
      ]),
      receiptPath,
      onEvent: (ev) => collectedEvents.push(ev),
    });

    // Dispatch was accepted
    expect(result.dispatch_accepted).toBe(true);

    // Final state is succeeded
    expect(result.receipt.state).toBe("succeeded");
    expect(result.receipt.schema_version).toBe("1.0");

    // Receipt validates against schema
    const parsed = runReceiptSchema.safeParse(result.receipt);
    expect(parsed.success).toBe(true);

    // Classification
    expect(result.receipt.exit.failure_class).toBe("success");
    expect(result.receipt.exit.failure_source).toBe("exit_code");
    expect(result.receipt.exit.exit_code).toBe(0);

    // Artifacts gate passed
    expect(result.receipt.artifacts.gate_passed).toBe(true);
    expect(result.receipt.artifacts.missing).toEqual([]);
    expect(result.receipt.artifacts.required).toHaveLength(1);

    // State transitions follow valid path
    const transitions = collectedEvents
      .filter((e) => e.event === "state_transition")
      .map((e) => ({ from: e.from, to: e.to }));

    expect(transitions).toEqual([
      { from: "queued", to: "dispatching" },
      { from: "dispatching", to: "running" },
      { from: "running", to: "succeeded" },
    ]);

    // Dispatch events present
    const dispatchStarted = collectedEvents.find((e) => e.event === "dispatch_started");
    expect(dispatchStarted).toBeDefined();
    const dispatchPassed = collectedEvents.find((e) => e.event === "dispatch_passed");
    expect(dispatchPassed).toBeDefined();

    // Artifact gate passed event
    const gatePassedEv = collectedEvents.find((e) => e.event === "artifact_gate_passed");
    expect(gatePassedEv).toBeDefined();

    // Receipt was written to disk
    const diskReceipt = JSON.parse(await readFile(receiptPath, "utf-8"));
    expect(diskReceipt.run_id).toBe(result.receipt.run_id);
    expect(runReceiptSchema.safeParse(diskReceipt).success).toBe(true);
  });

  it("publishes the terminal callback only after the typed receipt is durable", async () => {
    const spec = validSpec();
    let terminalReceiptRead: Promise<string> | undefined;

    await executeRun(spec, {
      adapter: createMockAdapter({ exit_code: 0 }),
      worktree: {
        base_path: tmpDir,
        exec: mockExec(),
      },
      discoverArtifacts: createArtifactDiscoverer([]),
      receiptPath,
      onEvent: (event) => {
        if (event.event === "state_transition" && event.to === "succeeded") {
          terminalReceiptRead = readFile(receiptPath, "utf8");
        }
      },
    });

    expect(terminalReceiptRead).toBeDefined();
    await expect(terminalReceiptRead).resolves.toContain(`"state": "succeeded"`);
  });

  it("successful run with execplan lane sets correct dispatch lane", async () => {
    const spec = validSpec({
      require_execplan: true,
      execplan_ref: "execplan/POL-701/inputs/plan.md",
    });

    const result = await executeRun(spec, {
      adapter: createMockAdapter({ exit_code: 0 }),
      worktree: { base_path: tmpDir, exec: mockExec() },
      discoverArtifacts: createArtifactDiscoverer([]),
      receiptPath,
    });

    expect(result.dispatch_accepted).toBe(true);

    // Check the dispatch_passed event has execplan lane
    const dispatchPassed = result.events.find((e) => e.event === "dispatch_passed");
    expect(dispatchPassed?.message).toContain("execplan");
  });

  it("completed_dirty run classified correctly when artifacts present with non-zero exit", async () => {
    // Create an adapter that emits enough events to exceed dirty threshold
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
        // Emit many events to exceed dirty threshold (default 10)
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
          duration_ms: 500,
        };
      },
      async stop() {},
    };

    const spec = validSpec({ required_artifacts: ["output.txt"] });

    const result = await executeRun(spec, {
      adapter: highEventAdapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      discoverArtifacts: createArtifactDiscoverer([
        {
          name: "output.txt",
          location: "worktree",
          path: join(tmpDir, "output.txt"),
          required: true,
          detected_at: new Date().toISOString(),
        },
      ]),
      receiptPath,
    });

    expect(result.receipt.state).toBe("completed_dirty");
    expect(result.receipt.exit.failure_class).toBe("completed_dirty");
    expect(result.receipt.exit.failure_source).toBe("heuristic");
    expect(result.receipt.artifacts.gate_passed).toBe(true);

    // Receipt still validates
    expect(runReceiptSchema.safeParse(result.receipt).success).toBe(true);
  });

  it("run with missing required artifacts reports artifact gate failure", async () => {
    const spec = validSpec({ required_artifacts: ["receipt.json", "report.md"] });

    const result = await executeRun(spec, {
      adapter: createMockAdapter({ exit_code: 0 }),
      worktree: { base_path: tmpDir, exec: mockExec() },
      discoverArtifacts: createArtifactDiscoverer([
        {
          name: "receipt.json",
          location: "run_dir",
          path: receiptPath,
          required: true,
          detected_at: new Date().toISOString(),
        },
        // report.md is missing
      ]),
      receiptPath,
    });

    // Run still succeeds (exit 0), but artifact gate reports missing
    expect(result.receipt.state).toBe("succeeded");
    expect(result.receipt.artifacts.gate_passed).toBe(false);
    expect(result.receipt.artifacts.missing).toEqual(["report.md"]);

    const gateFailed = result.events.find((e) => e.event === "artifact_gate_failed");
    expect(gateFailed).toBeDefined();
    expect(gateFailed?.message).toContain("report.md");
  });

  it("timing fields are populated correctly", async () => {
    const spec = validSpec();

    const result = await executeRun(spec, {
      adapter: createMockAdapter({ exit_code: 0, duration_ms: 250 }),
      worktree: { base_path: tmpDir, exec: mockExec() },
      discoverArtifacts: createArtifactDiscoverer([]),
      receiptPath,
    });

    const timing = result.receipt.timing;
    expect(timing.created_at).toBeDefined();
    expect(timing.dispatched_at).toBeDefined();
    expect(timing.started_at).toBeDefined();
    expect(timing.completed_at).toBeDefined();
    expect(typeof timing.duration_ms).toBe("number");
    expect(timing.duration_ms!).toBeGreaterThanOrEqual(0);
    expect(timing.backend_duration_ms).toBe(250);
  });

  it("environment fields reflect the run spec", async () => {
    const spec = validSpec({
      host: "carbon",
      backend: "claude",
      profile: "fast",
    });

    const result = await executeRun(spec, {
      adapter: createMockAdapter({ exit_code: 0 }),
      worktree: { base_path: tmpDir, exec: mockExec() },
      discoverArtifacts: createArtifactDiscoverer([]),
      receiptPath,
    });

    expect(result.receipt.environment.host).toBe("carbon");
    expect(result.receipt.environment.backend).toBe("claude");
    expect(result.receipt.environment.profile).toBe("fast");
    expect(result.receipt.environment.branch).toBe("test-branch");
  });

  it("summary line is descriptive", async () => {
    const spec = validSpec();

    const result = await executeRun(spec, {
      adapter: createMockAdapter({ exit_code: 0 }),
      worktree: { base_path: tmpDir, exec: mockExec() },
      discoverArtifacts: createArtifactDiscoverer([]),
      receiptPath,
    });

    expect(result.receipt.summary).toContain("completed successfully");
    expect(result.receipt.summary).toContain("log entries");
    expect(result.receipt.summary).toContain("missing artifact");
  });
});
