/**
 * Integration tests — Rejection path.
 *
 * Exercises dispatch rejection, worktree lock conflicts, and failure
 * classification paths through the orchestrator.
 *
 * Scenarios:
 *   - Missing prompt → dispatch rejected
 *   - Missing execplan_ref when required → dispatch rejected
 *   - Worktree lock conflict → infra_error
 *   - Backend auth failure → auth_error
 *   - Backend infra failure → infra_error
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { executeRun } from "../../src/run.js";
import { evaluateDispatch } from "../../src/dispatch.js";
import { acquireWorktree, releaseWorktree } from "../../src/worktree.js";
import { evaluateArtifactGate } from "../../src/receipt.js";
import {
  runReceiptSchema,
  dispatchReceiptSchema,
  artifactManifestSchema,
} from "../../src/schemas.js";
import type { RunSpec } from "../../src/types.js";
import type { BackendAdapter, AdapterResult, AdapterSpawnOptions } from "../../src/adapters/types.js";

/** Mock adapter returning configurable results. */
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
    async spawn(_opts: AdapterSpawnOptions): Promise<AdapterResult> {
      return {
        exit_code: result.exit_code ?? 0,
        stderr: result.stderr ?? "",
        events: result.events ?? [],
        duration_ms: result.duration_ms ?? 50,
      };
    },
    async stop() {},
  };
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

describe("Dispatch rejection", () => {
  let tmpDir: string;
  let receiptPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "calyx-reject-"));
    await mkdir(join(tmpDir, ".git"), { recursive: true });
    receiptPath = join(tmpDir, "receipt.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects when no prompt source is provided", async () => {
    const spec: RunSpec = {
      run_id: randomUUID(),
      host: "blade",
      backend: "claude",
      // No prompt, prompt_file, or prompt_template
      require_execplan: false,
      pull_execplan: false,
      worktree: { ref: "origin/main" },
    };

    const result = await executeRun(spec, {
      adapter: createMockAdapter(),
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.dispatch_accepted).toBe(false);
    expect(result.receipt.state).toBe("infra_error");
    expect(result.receipt.infra_error_classification).toMatchObject({
      failure_layer: "prompts_resolution",
      failure_reason: "prompts_source_missing",
    });
    expect(result.receipt.exit.failure_layer).toBe("prompts_resolution");
    expect(result.receipt.exit.failure_reason).toBe("prompts_source_missing");

    // Receipt validates
    expect(runReceiptSchema.safeParse(result.receipt).success).toBe(true);

    // Dispatch rejected event emitted
    const rejectedEv = result.events.find((e) => e.event === "dispatch_rejected");
    expect(rejectedEv).toBeDefined();
    expect(rejectedEv?.message).toContain("prompt");

    // State transitions
    const transitions = result.events
      .filter((e) => e.event === "state_transition")
      .map((e) => ({ from: e.from, to: e.to }));

    expect(transitions).toEqual([
      { from: "queued", to: "dispatching" },
      { from: "dispatching", to: "infra_error" },
    ]);
    const infraTransitions = result.events.filter(
      (e) => e.event === "state_transition" && e.to === "infra_error",
    );
    expect(infraTransitions).toHaveLength(1);
    expect(infraTransitions[0]?.infra_error_classification).toMatchObject({
      failure_layer: "prompts_resolution",
      failure_reason: "prompts_source_missing",
    });
  });

  it("rejects when execplan_ref missing but required", async () => {
    const spec: RunSpec = {
      run_id: randomUUID(),
      host: "blade",
      backend: "claude",
      prompt: "Do things",
      require_execplan: true,
      pull_execplan: false,
      // No execplan_ref
      worktree: { ref: "origin/main" },
    };

    const result = await executeRun(spec, {
      adapter: createMockAdapter(),
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.dispatch_accepted).toBe(false);
    expect(result.receipt.state).toBe("infra_error");
    expect(result.receipt.infra_error_classification).toMatchObject({
      failure_layer: "prompts_resolution",
      failure_reason: "prompts_source_missing",
    });

    const rejectedEv = result.events.find((e) => e.event === "dispatch_rejected");
    expect(rejectedEv?.message).toContain("execplan");
  });

  it("evaluateDispatch produces a valid DispatchReceipt for rejection", () => {
    const spec: RunSpec = {
      host: "blade",
      backend: "claude",
      require_execplan: true,
      pull_execplan: false,
      worktree: { ref: "origin/main" },
    };

    const receipt = evaluateDispatch(spec, {
      run_id: randomUUID(),
      timestamp: new Date().toISOString(),
    });

    expect(receipt.decision).toBe("rejected");
    expect(receipt.rejection_reason).toBeDefined();
    expect(receipt.checks.length).toBeGreaterThanOrEqual(2);

    // Schema validation
    expect(dispatchReceiptSchema.safeParse(receipt).success).toBe(true);

    // At least prompt_present and execplan_required should fail
    const failedChecks = receipt.checks.filter((c) => !c.passed);
    expect(failedChecks.length).toBeGreaterThanOrEqual(2);
    expect(failedChecks.map((c) => c.name)).toContain("prompt_present");
    expect(failedChecks.map((c) => c.name)).toContain("execplan_required");
  });

  it("evaluateDispatch accepts override for failing checks", () => {
    const spec: RunSpec = {
      host: "blade",
      backend: "claude",
      require_execplan: false,
      pull_execplan: false,
      // No prompt source
      worktree: { ref: "origin/main" },
    };

    const receipt = evaluateDispatch(spec, {
      run_id: randomUUID(),
      timestamp: new Date().toISOString(),
      override: { reason: "Manual override for testing" },
    });

    expect(receipt.decision).toBe("accepted");
    expect(receipt.overridden).toBe(true);
    expect(receipt.override_reason).toBe("Manual override for testing");
  });

  it("adds warning when dangerously_skip_permissions is enabled", () => {
    const spec: RunSpec = {
      host: "blade",
      backend: "claude",
      prompt: "Test",
      require_execplan: false,
      pull_execplan: false,
      worktree: { ref: "origin/main" },
      backend_options: {
        dangerously_skip_permissions: true,
      },
    };

    const receipt = evaluateDispatch(spec);
    expect(receipt.decision).toBe("accepted");
    expect(receipt.warnings).toContain("dangerously_skip_permissions is enabled");
  });

  it("accepts direct prompt and template lanes when ExecPlan is not required", () => {
    const promptReceipt = evaluateDispatch({
      host: "blade",
      backend: "claude",
      prompt: "Run a bounded probe.",
      require_execplan: false,
      pull_execplan: false,
      worktree: { ref: "origin/main" },
    });

    expect(promptReceipt.decision).toBe("accepted");
    expect(promptReceipt.lane).toBe("prompt_only");
    expect(promptReceipt.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "execplan_required",
          passed: true,
          message: "ExecPlan not required for this run",
        }),
      ]),
    );

    const templateReceipt = evaluateDispatch({
      host: "blade",
      backend: "codex",
      prompt_template: "ops-review",
      require_execplan: false,
      pull_execplan: false,
      worktree: { ref: "origin/main" },
    });

    expect(templateReceipt.decision).toBe("accepted");
    expect(templateReceipt.lane).toBe("prompt_template");
  });
});

describe("Worktree lock conflicts", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "calyx-lock-"));
    await mkdir(join(tmpDir, ".git"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("blocks acquisition when worktree is locked", async () => {
    const wtPath = join(tmpDir, "test-branch");
    await mkdir(wtPath, { recursive: true });

    // Write a fresh lock
    const lock = {
      run_id: randomUUID(),
      pid: process.pid,
      acquired_at: new Date().toISOString(),
    };
    await writeFile(
      join(wtPath, ".calyx-runner.lock"),
      JSON.stringify(lock),
      "utf-8",
    );

    // Try to acquire — should fail
    const result = await acquireWorktree(
      { path: wtPath, ref: "origin/main" },
      randomUUID(),
      { base_path: tmpDir, exec: mockExec() },
    );

    expect(result.acquired).toBe(false);
    expect(result.error).toContain("locked by run");
  });

  it("acquires stale lock after timeout", async () => {
    const wtPath = join(tmpDir, "test-branch");
    await mkdir(wtPath, { recursive: true });

    // Write a lock that's older than timeout
    const lock = {
      run_id: randomUUID(),
      pid: 99999,
      acquired_at: new Date(Date.now() - 60_000).toISOString(),
    };
    await writeFile(
      join(wtPath, ".calyx-runner.lock"),
      JSON.stringify(lock),
      "utf-8",
    );

    const result = await acquireWorktree(
      { path: wtPath, ref: "origin/main" },
      randomUUID(),
      {
        base_path: tmpDir,
        lock_timeout_ms: 30_000, // 30s — lock is 60s old
        exec: mockExec(),
      },
    );

    expect(result.acquired).toBe(true);
    expect(result.stale_lock_removed).toBe(true);
  });

  it("steal_lock overrides active lock", async () => {
    const wtPath = join(tmpDir, "test-branch");
    await mkdir(wtPath, { recursive: true });

    // Write a fresh lock
    const lock = {
      run_id: randomUUID(),
      pid: process.pid,
      acquired_at: new Date().toISOString(),
    };
    await writeFile(
      join(wtPath, ".calyx-runner.lock"),
      JSON.stringify(lock),
      "utf-8",
    );

    const result = await acquireWorktree(
      { path: wtPath, ref: "origin/main", steal_lock: true },
      randomUUID(),
      { base_path: tmpDir, exec: mockExec() },
    );

    expect(result.acquired).toBe(true);
    expect(result.stolen).toBe(true);
  });

  it("release removes lock file", async () => {
    const wtPath = join(tmpDir, "test-branch");
    await mkdir(wtPath, { recursive: true });

    // Acquire
    const result = await acquireWorktree(
      { path: wtPath, ref: "origin/main" },
      randomUUID(),
      { base_path: tmpDir, exec: mockExec() },
    );
    expect(result.acquired).toBe(true);

    // Release
    await releaseWorktree(wtPath);

    // Try to acquire again — should succeed
    const result2 = await acquireWorktree(
      { path: wtPath, ref: "origin/main" },
      randomUUID(),
      { base_path: tmpDir, exec: mockExec() },
    );
    expect(result2.acquired).toBe(true);
  });

  it("worktree lock conflict terminates orchestrator with infra_error", async () => {
    const wtPath = join(tmpDir, "test-branch");
    await mkdir(wtPath, { recursive: true });

    // Pre-lock the worktree
    await writeFile(
      join(wtPath, ".calyx-runner.lock"),
      JSON.stringify({
        run_id: randomUUID(),
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      }),
      "utf-8",
    );

    const spec: RunSpec = {
      run_id: randomUUID(),
      host: "blade",
      backend: "claude",
      prompt: "Test",
      require_execplan: false,
      pull_execplan: false,
      worktree: { path: wtPath, ref: "origin/main" },
    };

    const receiptPath = join(tmpDir, "receipt.json");
    const result = await executeRun(spec, {
      adapter: createMockAdapter(),
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.dispatch_accepted).toBe(true); // dispatch passed
    expect(result.receipt.state).toBe("infra_error"); // but worktree failed
    expect(result.receipt.infra_error_classification).toMatchObject({
      failure_layer: "worktree_acquisition",
      failure_reason: "worktree_locked",
    });
    const infraTransition = result.events.find(
      (e) => e.event === "state_transition" && e.to === "infra_error",
    );
    expect(infraTransition?.infra_error_classification).toMatchObject({
      failure_layer: "worktree_acquisition",
      failure_reason: "worktree_locked",
    });
    expect(runReceiptSchema.safeParse(result.receipt).success).toBe(true);
  });
});

describe("Artifact gate", () => {
  it("gate passes when all required artifacts are discovered", () => {
    const manifest = evaluateArtifactGate(
      randomUUID(),
      ["receipt.json", "report.md"],
      [
        {
          name: "receipt.json",
          location: "run_dir",
          path: "/tmp/receipt.json",
          required: true,
          detected_at: new Date().toISOString(),
        },
        {
          name: "report.md",
          location: "worktree",
          path: "/tmp/report.md",
          required: true,
          detected_at: new Date().toISOString(),
        },
      ],
    );

    expect(manifest.gate_passed).toBe(true);
    expect(manifest.missing).toEqual([]);
    expect(manifest.required).toHaveLength(2);
    expect(artifactManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("gate fails when required artifact is missing", () => {
    const manifest = evaluateArtifactGate(
      randomUUID(),
      ["receipt.json", "report.md"],
      [
        {
          name: "receipt.json",
          location: "run_dir",
          path: "/tmp/receipt.json",
          required: true,
          detected_at: new Date().toISOString(),
        },
      ],
    );

    expect(manifest.gate_passed).toBe(false);
    expect(manifest.missing).toEqual(["report.md"]);
    expect(artifactManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("gate passes with no required artifacts", () => {
    const manifest = evaluateArtifactGate(randomUUID(), [], []);
    expect(manifest.gate_passed).toBe(true);
    expect(manifest.missing).toEqual([]);
  });
});

describe("Backend failure classification through orchestrator", () => {
  let tmpDir: string;
  let receiptPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "calyx-fail-"));
    await mkdir(join(tmpDir, ".git"), { recursive: true });
    receiptPath = join(tmpDir, "receipt.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("auth_error from backend event", async () => {
    const spec: RunSpec = {
      run_id: randomUUID(),
      host: "blade",
      backend: "claude",
      prompt: "Test",
      require_execplan: false,
      pull_execplan: false,
      worktree: { ref: "origin/main", branch: "auth-test" },
    };

    const result = await executeRun(spec, {
      adapter: createMockAdapter({
        exit_code: 1,
        events: [{ event: "auth_failure" }],
      }),
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.state).toBe("auth_error");
    expect(result.receipt.exit.failure_class).toBe("auth_error");
    expect(runReceiptSchema.safeParse(result.receipt).success).toBe(true);
  });

  it("infra_error from stderr pattern", async () => {
    const spec: RunSpec = {
      run_id: randomUUID(),
      host: "blade",
      backend: "claude",
      prompt: "Test",
      require_execplan: false,
      pull_execplan: false,
      worktree: { ref: "origin/main", branch: "infra-test" },
    };

    const result = await executeRun(spec, {
      adapter: createMockAdapter({
        exit_code: 137,
        stderr: "Out of memory: Killed process 12345",
      }),
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.state).toBe("infra_error");
    expect(result.receipt.exit.failure_class).toBe("infra_error");
    expect(result.receipt.exit.failure_source).toBe("stderr_pattern");
    expect(result.receipt.infra_error_classification).toMatchObject({
      failure_layer: "backend_spawn",
      failure_reason: "backend_spawn_exit",
    });
    const infraTransition = result.events.find(
      (e) => e.event === "state_transition" && e.to === "infra_error",
    );
    expect(infraTransition?.infra_error_classification).toMatchObject({
      failure_layer: "backend_spawn",
      failure_reason: "backend_spawn_exit",
    });
    expect(runReceiptSchema.safeParse(result.receipt).success).toBe(true);
  });

  it("task_failure for generic non-zero exit", async () => {
    const spec: RunSpec = {
      run_id: randomUUID(),
      host: "blade",
      backend: "claude",
      prompt: "Test",
      require_execplan: false,
      pull_execplan: false,
      worktree: { ref: "origin/main", branch: "fail-test" },
    };

    const result = await executeRun(spec, {
      adapter: createMockAdapter({ exit_code: 42 }),
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.state).toBe("failed");
    expect(result.receipt.exit.failure_class).toBe("task_failure");
    expect(runReceiptSchema.safeParse(result.receipt).success).toBe(true);
  });
});
