import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeRun } from "../../src/run.js";
import { runReceiptSchema } from "../../src/schemas.js";
import type {
  AdapterResult,
  AdapterSpawnOptions,
  BackendAdapter,
} from "../../src/adapters/types.js";
import type { ArtifactEntry, RunOutputCapture, RunSpec } from "../../src/types.js";

function outputCapture(overrides: Partial<RunOutputCapture> = {}): RunOutputCapture {
  return {
    name: "proposal.json",
    source: "agent_terminal_message",
    media_type: "application/json",
    schema: {
      type: "object",
      properties: {
        verdict: { enum: ["approve", "reject"] },
        findings: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["verdict", "findings"],
      additionalProperties: false,
    },
    max_bytes: 4096,
    required: true,
    ...overrides,
  };
}

function adapterReturning(
  result: Partial<AdapterResult>,
  inspect?: (options: AdapterSpawnOptions) => void,
): BackendAdapter {
  return {
    name: "typed-output-mock",
    capabilities: {
      streaming: false,
      turnControl: false,
      resumeSession: false,
      forkSession: false,
      approvals: "none",
    },
    async spawn(options): Promise<AdapterResult> {
      inspect?.(options);
      return {
        exit_code: result.exit_code ?? 0,
        stderr: result.stderr ?? "",
        events: result.events ?? [],
        duration_ms: result.duration_ms ?? 25,
        ...(result.agent_terminal_message !== undefined
          ? { agent_terminal_message: result.agent_terminal_message }
          : {}),
        ...(result.output_capture_observation
          ? { output_capture_observation: result.output_capture_observation }
          : {}),
        ...(result.spawn_error ? { spawn_error: result.spawn_error } : {}),
        ...(result.signal ? { signal: result.signal } : {}),
      };
    },
    async stop() {},
  };
}

describe("executeRun typed terminal output capture", () => {
  let root: string;
  let worktree: string;
  let runDir: string;
  let receiptPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "calyx-output-run-"));
    worktree = join(root, "checkout");
    runDir = join(root, "run");
    receiptPath = join(runDir, "receipt.json");
    await mkdir(worktree);
    await mkdir(runDir);
    await writeFile(join(worktree, "source.txt"), "source bytes must remain unchanged\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function spec(capture = outputCapture()): RunSpec {
    return {
      run_id: randomUUID(),
      host: "local",
      backend: "codex",
      prompt: "Return the required structured review.",
      require_execplan: false,
      pull_execplan: false,
      worktree: {
        mode: "existing",
        path: worktree,
        steal_lock: false,
      },
      output_capture: capture,
      backend_options: { sandbox: "read-only" },
    };
  }

  it("passes the capture contract to the adapter and records the runner-owned artifact", async () => {
    const canonical = '{"findings":["one","two"],"verdict":"approve"}';
    let adapterOptions: AdapterSpawnOptions | undefined;

    const result = await executeRun(spec(), {
      adapter: adapterReturning(
        {
          agent_terminal_message: ' { "verdict": "approve", "findings": ["one", "two"] }\n',
        },
        (options) => { adapterOptions = options; },
      ),
      worktree: { base_path: root },
      receiptPath,
    });

    expect(adapterOptions?.output_capture).toEqual(outputCapture());
    expect(adapterOptions?.cwd).toBe(worktree);
    expect(adapterOptions?.backend_options?.env).toBeUndefined();
    expect(result.receipt.state).toBe("succeeded");
    expect(result.receipt.exit.failure_class).toBe("success");
    expect(result.receipt.artifacts.gate_passed).toBe(true);
    expect(result.receipt.artifacts.missing).toEqual([]);
    expect(result.receipt.artifacts.required).toEqual([
      expect.objectContaining({ name: "proposal.json", location: "run_dir" }),
    ]);
    expect(result.receipt.artifacts.discovered).toEqual([
      expect.objectContaining({
        name: "proposal.json",
        location: "run_dir",
        path: join(await realpath(runDir), "proposal.json"),
        size_bytes: Buffer.byteLength(canonical),
        sha256: createHash("sha256").update(canonical).digest("hex"),
        required: true,
      }),
    ]);
    expect(await readFile(join(runDir, "proposal.json"), "utf8")).toBe(canonical);
    expect((await stat(join(runDir, "proposal.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(worktree, "source.txt"), "utf8")).toBe(
      "source bytes must remain unchanged\n",
    );
    await expect(lstat(join(worktree, "proposal.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(runReceiptSchema.safeParse(result.receipt).success).toBe(true);
    expect(runReceiptSchema.safeParse(JSON.parse(await readFile(receiptPath, "utf8"))).success).toBe(true);
    expect(result.receipt.agent_terminal_message).toBeUndefined();
    expect(result.receipt.metadata?.output_capture).toEqual({
      status: "materialized",
      bytes_observed: Buffer.byteLength(' { "verdict": "approve", "findings": ["one", "two"] }\n'),
      sha256: createHash("sha256")
        .update(' { "verdict": "approve", "findings": ["one", "two"] }\n')
        .digest("hex"),
      artifact: {
        name: "proposal.json",
        size_bytes: Buffer.byteLength(canonical),
        sha256: createHash("sha256").update(canonical).digest("hex"),
      },
    });
  });

  it.each([
    ["missing", undefined],
    ["empty", "  \n"],
    ["malformed", '{"verdict":"approve"'],
    ["duplicate-key", '{"verdict":"approve","verdict":"reject","findings":[]}'],
    ["schema-invalid", '{"verdict":"maybe","findings":[]}'],
    ["oversize", '{"verdict":"approve","findings":["this is too long"]}'],
  ])("cannot succeed with %s terminal output", async (label, terminalMessage) => {
    const capture = label === "oversize"
      ? outputCapture({ max_bytes: 20 })
      : outputCapture();
    const result = await executeRun(spec(capture), {
      adapter: adapterReturning({ agent_terminal_message: terminalMessage }),
      worktree: { base_path: root },
      receiptPath,
    });

    expect(result.receipt.state).toBe("failed");
    expect(result.receipt.exit).toMatchObject({
      failure_class: "task_failure",
      failure_source: "heuristic",
    });
    expect(result.events).toContainEqual(expect.objectContaining({
      event: "artifact_gate_failed",
      payload: expect.objectContaining({
        name: "proposal.json",
        failure_kind: "invalid_output",
      }),
    }));
    expect(result.receipt.artifacts.gate_passed).toBe(false);
    expect(result.receipt.artifacts.missing).toEqual(["proposal.json"]);
    expect(result.receipt.artifacts.discovered).toEqual([]);
    await expect(lstat(join(runDir, "proposal.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(runReceiptSchema.safeParse(result.receipt).success).toBe(true);
    expect(result.receipt.agent_terminal_message).toBeUndefined();
    const persistedReceipt = await readFile(receiptPath, "utf8");
    if (terminalMessage) expect(persistedReceipt).not.toContain(terminalMessage);
    expect(result.receipt.metadata?.output_capture).toMatchObject({
      status: "rejected",
      bytes_observed: Buffer.byteLength(terminalMessage ?? ""),
      sha256: createHash("sha256").update(terminalMessage ?? "").digest("hex"),
      failure_kind: "invalid_output",
      error: expect.any(String),
    });
  });

  it("classifies a streaming byte-limit stop as rejected output without raw payload", async () => {
    const observed = "x".repeat(14);
    const result = await executeRun(spec(outputCapture({ max_bytes: 8 })), {
      adapter: adapterReturning({
        exit_code: 137,
        signal: "SIGKILL",
        spawn_error: "stdout exceeded max_stdout_bytes=8 (observed 14 bytes)",
        output_capture_observation: {
          status: "limit_exceeded",
          bytes_observed: Buffer.byteLength(observed),
          sha256: createHash("sha256").update(observed).digest("hex"),
        },
      }),
      worktree: { base_path: root },
      receiptPath,
    });

    expect(result.receipt.state).toBe("failed");
    expect(result.receipt.exit).toMatchObject({
      failure_class: "task_failure",
      failure_source: "heuristic",
      exit_code: 1,
    });
    expect(result.receipt.agent_terminal_message).toBeUndefined();
    expect(result.receipt.metadata?.output_capture).toMatchObject({
      status: "rejected",
      bytes_observed: 14,
      sha256: createHash("sha256").update(observed).digest("hex"),
      failure_kind: "invalid_output",
      error: expect.stringContaining("exceeded 8 bytes"),
    });
    expect(result.events).toContainEqual(expect.objectContaining({
      event: "artifact_gate_failed",
      payload: expect.objectContaining({
        bytes_observed: 14,
        sha256: createHash("sha256").update(observed).digest("hex"),
      }),
    }));
    expect(JSON.stringify(result.receipt)).not.toContain(observed);
  });

  it("classifies publication failure as infra_error and preserves an existing target", async () => {
    const target = join(runDir, "proposal.json");
    await writeFile(target, "pre-existing-owner", { mode: 0o600 });

    const result = await executeRun(spec(), {
      adapter: adapterReturning({
        agent_terminal_message: '{"verdict":"approve","findings":[]}',
      }),
      worktree: { base_path: root },
      receiptPath,
    });

    expect(result.receipt.state).toBe("infra_error");
    expect(result.receipt.exit).toMatchObject({
      failure_class: "infra_error",
      failure_source: "heuristic",
    });
    expect(result.events).toContainEqual(expect.objectContaining({
      event: "artifact_gate_failed",
      payload: expect.objectContaining({
        name: "proposal.json",
        failure_kind: "materialization_failed",
      }),
    }));
    expect(result.receipt.infra_error_classification).toMatchObject({
      failure_layer: "runner_task",
    });
    expect(result.receipt.artifacts.gate_passed).toBe(false);
    expect(result.receipt.artifacts.missing).toEqual(["proposal.json"]);
    expect(await readFile(target, "utf8")).toBe("pre-existing-owner");
    expect(runReceiptSchema.safeParse(result.receipt).success).toBe(true);
  });

  it("does not allow a same-named legacy worktree artifact to satisfy typed capture", async () => {
    const worktreeArtifactPath = join(worktree, "proposal.json");
    await writeFile(worktreeArtifactPath, '{"verdict":"approve","findings":[]}');
    const legacyArtifact: ArtifactEntry = {
      name: "proposal.json",
      location: "worktree",
      path: worktreeArtifactPath,
      required: true,
      detected_at: "2026-07-21T18:00:00.000Z",
    };

    const result = await executeRun(spec(), {
      adapter: adapterReturning({}),
      worktree: { base_path: root },
      discoverArtifacts: async () => [legacyArtifact],
      receiptPath,
    });

    expect(result.receipt.state).toBe("failed");
    expect(result.receipt.exit.failure_class).toBe("task_failure");
    expect(result.receipt.artifacts.gate_passed).toBe(false);
    expect(result.receipt.artifacts.missing).toEqual(["proposal.json"]);
    expect(result.receipt.artifacts.discovered).toEqual([]);
    expect(await readFile(worktreeArtifactPath, "utf8")).toBe(
      '{"verdict":"approve","findings":[]}',
    );
    await expect(lstat(join(runDir, "proposal.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cannot succeed without a trusted receipt/run directory", async () => {
    const result = await executeRun(spec(), {
      adapter: adapterReturning({
        agent_terminal_message: '{"verdict":"approve","findings":[]}',
      }),
      worktree: { base_path: root },
    });

    expect(result.receipt.state).toBe("infra_error");
    expect(result.receipt.exit.failure_class).toBe("infra_error");
    expect(result.receipt.artifacts.gate_passed).toBe(false);
    expect(result.receipt.artifacts.missing).toEqual(["proposal.json"]);
    await expect(lstat(join(worktree, "proposal.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not follow a same-named symlink in the trusted run directory", async () => {
    const outside = join(root, "outside.json");
    await writeFile(outside, "outside-owned", { mode: 0o600 });
    await symlink(outside, join(runDir, "proposal.json"));

    const result = await executeRun(spec(), {
      adapter: adapterReturning({
        agent_terminal_message: '{"verdict":"approve","findings":[]}',
      }),
      worktree: { base_path: root },
      receiptPath,
    });

    expect(result.receipt.state).toBe("infra_error");
    expect(result.receipt.artifacts.gate_passed).toBe(false);
    expect(await readFile(outside, "utf8")).toBe("outside-owned");
    expect((await lstat(join(runDir, "proposal.json"))).isSymbolicLink()).toBe(true);
  });
});
