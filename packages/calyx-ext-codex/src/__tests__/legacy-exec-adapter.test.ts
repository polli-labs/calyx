/**
 * Integration tests — Codex adapter parity.
 *
 * Validates that the Codex adapter satisfies the same BackendAdapter contract
 * as the Claude adapter, and that the orchestrator produces identical receipt
 * semantics regardless of which backend is selected.
 *
 * Test groups:
 *   - CodexAdapter unit contract (spawn args, events, stop semantics)
 *   - Orchestrator parity (golden path, rejection, failure classification)
 *   - Adapter factory / selection matrix
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import {
  ClaudeAdapter,
  createRuntimeAdapterRegistry,
  executeRun,
  registerBuiltInRuntimeAdapters,
  runReceiptSchema,
  SUPPORTED_BACKENDS,
} from "@polli-labs/calyx-runner";
import type {
  AdapterResult,
  AdapterSpawnOptions,
  ArtifactEntry,
  BackendAdapter,
  ClaudeAdapterOptions,
  LifecycleEvent,
  RunSpec,
} from "@polli-labs/calyx-runner";
import {
  CodexAdapter,
  createCodexRuntimeAdapterFactory,
  createLegacyCodexRuntimeAdapterFactory,
} from "../runtime/index.js";
import type { CodexAdapterOptions } from "../runtime/index.js";

function createAdapter(
  backend: string,
  opts?: {
    claude?: ClaudeAdapterOptions;
    codex?: CodexAdapterOptions;
  },
): BackendAdapter {
  const registry = registerBuiltInRuntimeAdapters(createRuntimeAdapterRegistry(), {
    ...(opts?.claude ? { claude: opts.claude } : {}),
  });
  registry.register("codex", createLegacyCodexRuntimeAdapterFactory(opts?.codex));
  return registry.create(backend);
}

// ── Shared helpers ──────────────────────────────────────────────────

/** Controllable mock spawn capturing invocation args. */
function createCapturingSpawn(
  result: { code: number; stdout: string; stderr: string } = { code: 0, stdout: "", stderr: "" },
) {
  const calls: Array<{
    cmd: string;
    args: string[];
    cwd: string;
    env?: Record<string, string | undefined>;
    max_stdout_bytes?: number;
    resolve_command_before_env?: boolean;
    onActivity?: unknown;
    hard_timeout_ms?: number;
    stop_grace_ms?: number;
  }> = [];
  const fn = async (
    cmd: string,
    args: string[],
    opts: {
      cwd: string;
      env?: Record<string, string | undefined>;
      max_stdout_bytes?: number;
      resolve_command_before_env?: boolean;
      onActivity?: unknown;
      hard_timeout_ms?: number;
      stop_grace_ms?: number;
    },
  ) => {
    calls.push({
      cmd,
      args,
      cwd: opts.cwd,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.max_stdout_bytes ? { max_stdout_bytes: opts.max_stdout_bytes } : {}),
      ...(opts.resolve_command_before_env
        ? { resolve_command_before_env: opts.resolve_command_before_env }
        : {}),
      ...(opts.onActivity ? { onActivity: opts.onActivity } : {}),
      ...(opts.hard_timeout_ms ? { hard_timeout_ms: opts.hard_timeout_ms } : {}),
      ...(opts.stop_grace_ms ? { stop_grace_ms: opts.stop_grace_ms } : {}),
    });
    return result;
  };
  return { fn, calls };
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

function createArtifactDiscoverer(
  artifacts: ArtifactEntry[],
): (cwd: string, run_id: string) => Promise<ArtifactEntry[]> {
  return async () => artifacts;
}

function validSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    run_id: randomUUID(),
    host: "blade",
    backend: "codex",
    prompt: "Test prompt for codex adapter",
    require_execplan: false,
    pull_execplan: false,
    worktree: {
      ref: "origin/main",
      branch: "test-codex-branch",
      steal_lock: false,
    },
    required_artifacts: ["receipt.json"],
    ...overrides,
  };
}

// ── CodexAdapter unit contract ──────────────────────────────────────

describe("CodexAdapter contract", () => {
  it("uses the config-isolated one-shot contract for typed terminal output capture", async () => {
    const schema = {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
      additionalProperties: false,
    };
    const terminalJson = '{"verdict":"approve"}\n';
    let schemaPath = "";
    let schemaContents = "";
    let schemaMode = 0;
    const adapter = new CodexAdapter({
      spawn: async (cmd, args, options) => {
        expect(basename(cmd)).toBe("codex");
        expect(options.cwd).toBe("/tmp/read-only-checkout");
        expect(options.max_stdout_bytes).toBe(4096);
        expect(options.resolve_command_before_env).toBe(true);

        const outputSchemaIndex = args.indexOf("--output-schema");
        expect(outputSchemaIndex).toBeGreaterThan(0);
        schemaPath = args[outputSchemaIndex + 1]!;
        schemaContents = await readFile(schemaPath, "utf8");
        schemaMode = (await stat(schemaPath)).mode & 0o777;

        expect(args).toEqual([
          "exec",
          "--sandbox",
          "read-only",
          "--ignore-user-config",
          "--ignore-rules",
          "-c",
          "project_doc_max_bytes=0",
          "--ephemeral",
          "--output-schema",
          schemaPath,
          "Return the typed decision",
        ]);
        expect(args).not.toContain("--add-dir");
        expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
        expect(args).not.toContain("resume");

        return { code: 0, stdout: terminalJson, stderr: "" };
      },
    });

    const result = await adapter.spawn({
      run_id: "typed-output-capture",
      cwd: "/tmp/read-only-checkout",
      prompt: "Return the typed decision",
      output_capture: {
        name: "decision.json",
        source: "agent_terminal_message",
        media_type: "application/json",
        schema,
        max_bytes: 4096,
        required: true,
      },
      backend_options: { sandbox: "read-only" },
    });

    expect(schemaContents).toBe(JSON.stringify(schema));
    expect(schemaMode).toBe(0o600);
    expect(result.agent_terminal_message).toBe(terminalJson);
    expect(result.session).toBeUndefined();
    await expect(readFile(schemaPath, "utf8")).rejects.toThrow();
  });

  it.each([
    [undefined, undefined, "requires backend_options.sandbox=read-only"],
    [{ sandbox: "danger-full-access" }, undefined, "requires backend_options.sandbox=read-only"],
    [{ sandbox: "read-only" }, "thread-existing", "is ephemeral and cannot resume"],
  ] as const)(
    "rejects unsafe typed output capture launch options before spawning",
    async (backendOptions, resumeSessionId, expected) => {
      const spawn = createCapturingSpawn();
      const adapter = new CodexAdapter({ spawn: spawn.fn });

      await expect(adapter.spawn({
        run_id: "typed-output-rejected",
        cwd: "/tmp/read-only-checkout",
        prompt: "Return JSON",
        output_capture: {
          name: "decision.json",
          source: "agent_terminal_message",
          media_type: "application/json",
          schema: { type: "object" },
          max_bytes: 4096,
          required: true,
        },
        ...(backendOptions ? { backend_options: backendOptions } : {}),
        ...(resumeSessionId ? { resume_session_id: resumeSessionId } : {}),
      })).rejects.toThrow(expected);

      expect(spawn.calls).toHaveLength(0);
    },
  );

  it.each(["PATH", "HOME", "CODEX_HOME", "NODE_OPTIONS", "OPENAI_API_KEY", "CODEX_CONFIG"])(
    "rejects direct typed-capture adapter env key %s before provider spawn",
    async (key) => {
      const spawn = createCapturingSpawn();
      const adapter = new CodexAdapter({ spawn: spawn.fn });
      await expect(adapter.spawn({
        run_id: `typed-output-env-${key}`,
        cwd: "/tmp/read-only-checkout",
        prompt: "Return JSON",
        output_capture: {
          name: "decision.json",
          source: "agent_terminal_message",
          media_type: "application/json",
          schema: { type: "object" },
          max_bytes: 4096,
          required: true,
        },
        backend_options: {
          sandbox: "read-only",
          env: { [key]: "forged" },
        },
      })).rejects.toThrow("output_capture does not accept backend_options.env");
      expect(spawn.calls).toHaveLength(0);
    },
  );

  it("returns only a bounded observation when capture stdout crosses its limit", async () => {
    const rawPrefix = "do-not-persist";
    const adapter = new CodexAdapter({
      spawn: async (_cmd, _args, options) => {
        expect(options.max_stdout_bytes).toBe(8);
        return {
          code: 137,
          stdout: rawPrefix,
          stderr: "",
          signal: "SIGKILL",
          spawn_error: "stdout exceeded max_stdout_bytes=8 (observed 14 bytes)",
          stdout_observation: {
            bytes_observed: 14,
            sha256: createHash("sha256").update(rawPrefix).digest("hex"),
            complete: false,
          },
        };
      },
    });

    const result = await adapter.spawn({
      run_id: "typed-output-over-limit",
      cwd: "/tmp/read-only-checkout",
      prompt: "Return JSON",
      output_capture: {
        name: "decision.json",
        source: "agent_terminal_message",
        media_type: "application/json",
        schema: { type: "object" },
        max_bytes: 8,
        required: true,
      },
      backend_options: { sandbox: "read-only" },
    });

    expect(result.agent_terminal_message).toBeUndefined();
    expect(result.output_capture_observation).toEqual({
      status: "limit_exceeded",
      bytes_observed: 14,
      sha256: createHash("sha256").update(rawPrefix).digest("hex"),
    });
  });

  it("applies runner-owned capture redactions without accepting caller env values", async () => {
    const spawn = createCapturingSpawn({
      code: 0,
      stdout: '{"verdict":"approve"}',
      stderr: "",
    });
    const adapter = new CodexAdapter({ spawn: spawn.fn });
    await adapter.spawn({
      run_id: "typed-output-redactions",
      cwd: "/tmp/read-only-checkout",
      prompt: "Return JSON",
      output_capture: {
        name: "decision.json",
        source: "agent_terminal_message",
        media_type: "application/json",
        schema: { type: "object" },
        max_bytes: 4096,
        required: true,
      },
      backend_options: { sandbox: "read-only" },
      environment_redactions: ["OPENAI_API_KEY", "CALYX_SERVER_TOKEN"],
      workspace_mutation: "forbidden",
    });

    expect(spawn.calls[0]?.env).toEqual({
      OPENAI_API_KEY: undefined,
      CALYX_SERVER_TOKEN: undefined,
      CALYX_AGENT_WORKSPACE_MUTATION: "forbidden",
    });
  });

  it("routes typed output capture through legacy exec without starting app-server", async () => {
    let appServerSpawned = false;
    const legacySpawn = createCapturingSpawn({
      code: 0,
      stdout: '{"verdict":"approve"}',
      stderr: "",
    });
    const factory = createCodexRuntimeAdapterFactory({
      spawnProcess: () => {
        appServerSpawned = true;
        throw new Error("app-server must not start for output capture");
      },
      outputCaptureLegacy: { spawn: legacySpawn.fn },
    });
    const adapter = factory();
    const session = await adapter.startSession!({
      run_id: "typed-output-router",
      cwd: "/tmp/read-only-checkout",
      output_capture: {
        name: "decision.json",
        source: "agent_terminal_message",
        media_type: "application/json",
        schema: { type: "object" },
        max_bytes: 4096,
        required: true,
      },
      backend_options: { sandbox: "read-only" },
    });

    const turn = await session.startTurn({ prompt: "Return JSON" });
    const result = await turn.wait();
    await session.close();

    expect(appServerSpawned).toBe(false);
    expect(legacySpawn.calls).toHaveLength(1);
    expect(legacySpawn.calls[0]!.args).toContain("--output-schema");
    expect(result.agent_terminal_message).toBe('{"verdict":"approve"}');
  });

  it("spawns codex exec CLI contract with prompt argument", async () => {
    const spawn = createCapturingSpawn();
    const adapter = new CodexAdapter({ spawn: spawn.fn });
    const events: LifecycleEvent[] = [];

    await adapter.spawn({
      run_id: "test-1",
      cwd: "/tmp/test",
      prompt: "Do the thing",
      onEvent: (ev) => events.push(ev),
    });

    expect(spawn.calls).toHaveLength(1);
    expect(basename(spawn.calls[0]!.cmd)).toBe("codex");
    expect(spawn.calls[0]!.args[0]).toBe("exec");
    expect(spawn.calls[0]!.args).toContain("Do the thing");
    expect(spawn.calls[0]!.cwd).toBe("/tmp/test");
  });

  it("adds bypass flag for dangerously_skip_permissions", async () => {
    const spawn = createCapturingSpawn();
    const adapter = new CodexAdapter({ spawn: spawn.fn });

    await adapter.spawn({
      run_id: "test-2",
      cwd: "/tmp/test",
      prompt: "Test",
      backend_options: { dangerously_skip_permissions: true },
    });

    expect(spawn.calls[0]!.args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it.each(["read-only", "danger-full-access"] as const)(
    "passes backend_options.sandbox=%s to codex exec",
    async (sandbox) => {
      const spawn = createCapturingSpawn();
      const adapter = new CodexAdapter({ spawn: spawn.fn });

      await adapter.spawn({
        run_id: `test-sandbox-${sandbox}`,
        cwd: "/tmp/test",
        prompt: "Test",
        backend_options: { sandbox },
      });

      const sandboxFlag = spawn.calls[0]!.args.indexOf("--sandbox");
      expect(sandboxFlag).toBeGreaterThanOrEqual(0);
      expect(spawn.calls[0]!.args[sandboxFlag + 1]).toBe(sandbox);
    },
  );

  it.each([
    [{ sandbox: "workspace-write" }, "must be read-only or danger-full-access"],
    [{ sandbox_class: "read-only" }, "does not support backend_options.sandbox_class"],
    [{ dangerously_skip_permissions: "true" }, "dangerously_skip_permissions must be a boolean"],
    [
      { sandbox: "read-only", dangerously_skip_permissions: true },
      "sandbox=read-only conflicts with dangerously_skip_permissions=true",
    ],
  ])("rejects invalid or conflicting sandbox options before spawning codex exec", async (backendOptions, expected) => {
    const spawn = createCapturingSpawn();
    const adapter = new CodexAdapter({ spawn: spawn.fn });

    await expect(adapter.spawn({
      run_id: "test-invalid-sandbox",
      cwd: "/tmp/test",
      prompt: "Test",
      backend_options: backendOptions as NonNullable<AdapterSpawnOptions["backend_options"]>,
    })).rejects.toThrow(expected);

    expect(spawn.calls).toHaveLength(0);
  });

  it("adds model_reasoning_effort config for one-off reasoning effort", async () => {
    const spawn = createCapturingSpawn();
    const adapter = new CodexAdapter({ spawn: spawn.fn });

    await adapter.spawn({
      run_id: "test-effort",
      cwd: "/tmp/test",
      prompt: "Test",
      backend_options: { reasoning_effort: "xhigh" },
    });

    expect(spawn.calls[0]!.args).toContain("-c");
    expect(spawn.calls[0]!.args).toContain('model_reasoning_effort="xhigh"');
  });

  it("maps max_threads to Codex agents.max_threads", async () => {
    const spawn = createCapturingSpawn();
    const adapter = new CodexAdapter({ spawn: spawn.fn });

    await adapter.spawn({
      run_id: "test-max-threads",
      cwd: "/tmp/test",
      prompt: "Test",
      backend_options: { max_threads: 8 },
    });

    expect(spawn.calls[0]!.args).toContain("agents.max_threads=8");
    expect(spawn.calls[0]!.args).not.toContain("--max-turns");
  });

  it("rejects Claude max_turns before spawning codex exec", async () => {
    const spawn = createCapturingSpawn();
    const adapter = new CodexAdapter({ spawn: spawn.fn });

    await expect(adapter.spawn({
      run_id: "test-max-turns",
      cwd: "/tmp/test",
      prompt: "Test",
      backend_options: { max_turns: 8 },
    })).rejects.toThrow("codex exec does not support backend_options.max_turns");

    expect(spawn.calls).toHaveLength(0);
  });

  it("rejects model selection until Codex model forwarding has a Calyx contract", async () => {
    const spawn = createCapturingSpawn();
    const adapter = new CodexAdapter({ spawn: spawn.fn });

    await expect(adapter.spawn({
      run_id: "test-model",
      cwd: "/tmp/test",
      prompt: "Test",
      backend_options: { model: "gpt-5.5" },
    })).rejects.toThrow("does not yet support backend_options.model");

    expect(spawn.calls).toHaveLength(0);
  });

  it("rejects Claude-only max reasoning effort before spawning codex exec", async () => {
    const spawn = createCapturingSpawn();
    const adapter = new CodexAdapter({ spawn: spawn.fn });

    await expect(adapter.spawn({
      run_id: "test-effort-max",
      cwd: "/tmp/test",
      prompt: "Test",
      backend_options: { reasoning_effort: "max" },
    })).rejects.toThrow("Valid Codex values: none, minimal, low, medium, high, xhigh");

    expect(spawn.calls).toHaveLength(0);
  });

  it("uses a temporary model_instructions_file for replacement prompts and config for appended instructions", async () => {
    let seenArgs: string[] = [];
    let modelInstructionsPath = "";
    let modelInstructionsContent = "";
    const adapter = new CodexAdapter({
      spawn: async (_cmd, args) => {
        seenArgs = args;
        const configValue = args[args.indexOf("-c") + 1]!;
        modelInstructionsPath = JSON.parse(
          configValue.slice("model_instructions_file=".length),
        ) as string;
        modelInstructionsContent = await readFile(modelInstructionsPath, "utf8");
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await adapter.spawn({
      run_id: "test-1140",
      cwd: "/tmp/test",
      prompt: "Do the thing",
      system_prompt: "Base line 1\nBase line 2",
      append_system_prompt: "Append line 1\nAppend line 2",
    });

    expect(seenArgs[0]).toBe("exec");
    expect(seenArgs).toContain(`model_instructions_file=${JSON.stringify(modelInstructionsPath)}`);
    expect(seenArgs).toContain(`developer_instructions=${JSON.stringify("Append line 1\nAppend line 2")}`);
    expect(modelInstructionsContent).toBe("Base line 1\nBase line 2");
    await expect(readFile(modelInstructionsPath, "utf8")).rejects.toThrow();
  });

  it("default spawn uses codex exec contract with compatibility shim", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-codex-shim-"));
    const binDir = join(tmp, "bin");
    const shimPath = join(binDir, "codex");
    const capturePath = join(tmp, "codex-argv.json");
    const originalPath = process.env.PATH;
    const originalCodexBin = process.env.CALYX_CODEX_BIN;

    try {
      await mkdir(binDir, { recursive: true });
      await writeFile(
        shimPath,
        `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.CODEX_CAPTURE_PATH, JSON.stringify({ argv: process.argv.slice(2) }));
`,
        { encoding: "utf8" },
      );
      await chmod(shimPath, 0o755);
      process.env.PATH = `${binDir}:${originalPath ?? ""}`;
      // Darwin intentionally prefers a known-good Homebrew binary over PATH.
      // Bind the resolver to this test-owned executable on every platform.
      process.env.CALYX_CODEX_BIN = shimPath;

      const adapter = new CodexAdapter();
      await adapter.spawn({
        run_id: "test-2b",
        cwd: tmp,
        prompt: "Shim prompt",
        backend_options: {
          dangerously_skip_permissions: true,
          env: {
            CODEX_CAPTURE_PATH: capturePath,
            PATH: process.env.PATH,
          },
        },
      });

      const captured = JSON.parse(await readFile(capturePath, "utf8")) as { argv: string[] };
      expect(captured.argv[0]).toBe("exec");
      expect(captured.argv).toContain("Shim prompt");
      expect(captured.argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalCodexBin === undefined) delete process.env.CALYX_CODEX_BIN;
      else process.env.CALYX_CODEX_BIN = originalCodexBin;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("passes env overrides to spawn", async () => {
    const spawn = createCapturingSpawn();
    const adapter = new CodexAdapter({ spawn: spawn.fn });

    await adapter.spawn({
      run_id: "test-3",
      cwd: "/tmp/test",
      prompt: "Test",
      backend_options: {
        env: { MY_VAR: "value", REMOVE_ME: null },
      },
    });

    expect(spawn.calls[0]!.env).toEqual({
      MY_VAR: "value",
      REMOVE_ME: undefined,
    });
  });

  it("passes agent activity hooks and configured hard timeout to shared spawn", async () => {
    const spawn = createCapturingSpawn();
    const adapter = new CodexAdapter({ spawn: spawn.fn });
    const onActivity = () => {};

    await adapter.spawn({
      run_id: "test-1388",
      cwd: "/tmp/test",
      prompt: "Test",
      onActivity,
      backend_options: {
        agent_activity: {
          stale_after_ms: 60000,
          hard_timeout_ms: 120000,
          stop_grace_ms: 1000,
        },
      },
    });

    expect(spawn.calls[0]!.onActivity).toBe(onActivity);
    expect(spawn.calls[0]!.hard_timeout_ms).toBe(120000);
    expect(spawn.calls[0]!.stop_grace_ms).toBe(1000);
  });

  it("emits backend_spawned event with args payload", async () => {
    const spawn = createCapturingSpawn();
    const adapter = new CodexAdapter({ spawn: spawn.fn });
    const events: LifecycleEvent[] = [];

    await adapter.spawn({
      run_id: "test-4",
      cwd: "/tmp/test",
      prompt: "Test",
      onEvent: (ev) => events.push(ev),
    });

    const spawned = events.find((e) => e.event === "backend_spawned");
    expect(spawned).toBeDefined();
    expect(spawned!.message).toContain("codex");
    expect(spawned!.payload?.args).toBeDefined();
  });

  it("returns AdapterResult with all required fields", async () => {
    const spawn = createCapturingSpawn({ code: 0, stdout: "ok", stderr: "warn" });
    const adapter = new CodexAdapter({ spawn: spawn.fn });

    const result = await adapter.spawn({
      run_id: "test-5",
      cwd: "/tmp/test",
      prompt: "Test",
    });

    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("warn");
    expect(Array.isArray(result.events)).toBe(true);
    expect(typeof result.duration_ms).toBe("number");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("captures non-zero exit code", async () => {
    const spawn = createCapturingSpawn({ code: 42, stdout: "", stderr: "error output" });
    const adapter = new CodexAdapter({ spawn: spawn.fn });

    const result = await adapter.spawn({
      run_id: "test-6",
      cwd: "/tmp/test",
      prompt: "Test",
    });

    expect(result.exit_code).toBe(42);
    expect(result.stderr).toBe("error output");
  });

  it("handles spawn errors with infra_failure event", async () => {
    const adapter = new CodexAdapter({
      spawn: async () => { throw new Error("codex not found"); },
    });

    const result = await adapter.spawn({
      run_id: "test-7",
      cwd: "/tmp/test",
      prompt: "Test",
    });

    expect(result.exit_code).toBeUndefined();
    expect(result.stderr).toContain("codex not found");
    expect(result.events).toContainEqual(
      expect.objectContaining({ event: "infra_failure" }),
    );
  });

  it("stop aborts the live spawn and resolves only after backend exit", async () => {
    let resolveSpawn: () => void;
    const spawnPromise = new Promise<void>((r) => { resolveSpawn = r; });
    let markSpawnStarted: () => void;
    const spawnStarted = new Promise<void>((r) => { markSpawnStarted = r; });
    let signal: AbortSignal | undefined;

    const adapter = new CodexAdapter({
      spawn: async (_cmd, _args, opts) => {
        signal = opts.signal;
        markSpawnStarted!();
        await spawnPromise;
        return { code: 143, stdout: "", stderr: "", signal: "SIGTERM" };
      },
    });

    const resultPromise = adapter.spawn({
      run_id: "abort-test",
      cwd: "/tmp/test",
      prompt: "Test",
    });
    await spawnStarted;

    let stopSettled = false;
    const stopPromise = adapter.stop("abort-test").then(() => {
      stopSettled = true;
    });
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    resolveSpawn!();
    await stopPromise;

    const result = await resultPromise;
    expect(stopSettled).toBe(true);
    expect(result.spawn_error).toBeUndefined();
    expect(result.events).toContainEqual(
      expect.objectContaining({ event: "cancelled" }),
    );
  });

  it("stop during async launch preparation prevents the backend spawn", async () => {
    let spawnCalled = false;
    const adapter = new CodexAdapter({
      spawn: async () => {
        spawnCalled = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const resultPromise = adapter.spawn({
      run_id: "pre-spawn-abort-test",
      cwd: "/tmp/test",
      prompt: "Test",
      system_prompt: "Temporary instructions force asynchronous file preparation.",
    });
    await adapter.stop("pre-spawn-abort-test");
    const result = await resultPromise;

    expect(spawnCalled).toBe(false);
    expect(result.exit_code).toBe(143);
    expect(result.spawn_error).toBeUndefined();
    expect(result.events).toContainEqual({ event: "cancelled" });
  });

  it("name property is 'codex'", () => {
    const adapter = new CodexAdapter();
    expect(adapter.name).toBe("codex");
  });
});

// ── Resume session arg construction ──────────────────────────────────

describe("Claude adapter resume args", () => {
  it("includes --resume when resume_session_id is set", async () => {
    const spawn = createCapturingSpawn();
    const adapter = new ClaudeAdapter({ spawn: spawn.fn });

    await adapter.spawn({
      run_id: "resume-claude-1",
      cwd: "/tmp/test",
      prompt: "Continue the work",
      resume_session_id: "sess-abc-123",
    });

    expect(spawn.calls).toHaveLength(1);
    const args = spawn.calls[0]!.args;
    expect(args[0]).toBe("--resume");
    expect(args[1]).toBe("sess-abc-123");
    expect(args[2]).toBe("--print");
    expect(args).toContain("Continue the work");
  });

  it("assigns a fresh session id when resume_session_id is not set", async () => {
    const spawn = createCapturingSpawn();
    const adapter = new ClaudeAdapter({ spawn: spawn.fn });

    await adapter.spawn({
      run_id: "normal-claude-1",
      cwd: "/tmp/test",
      prompt: "Normal run",
    });

    expect(spawn.calls[0]!.args[0]).toBe("--session-id");
    expect(spawn.calls[0]!.args[1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(spawn.calls[0]!.args[2]).toBe("--print");
    expect(spawn.calls[0]!.args).not.toContain("--resume");
  });
});

describe("Codex adapter resume args", () => {
  it("includes resume subcommand when resume_session_id is set", async () => {
    const spawn = createCapturingSpawn();
    const adapter = new CodexAdapter({ spawn: spawn.fn });

    await adapter.spawn({
      run_id: "resume-codex-1",
      cwd: "/tmp/test",
      prompt: "Continue the work",
      resume_session_id: "abcd-ef01-2345-6789",
    });

    expect(spawn.calls).toHaveLength(1);
    const args = spawn.calls[0]!.args;
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    expect(args[2]).toBe("abcd-ef01-2345-6789");
    expect(args[3]).toBe("Continue the work");
  });

  it("omits resume subcommand when resume_session_id is not set", async () => {
    const spawn = createCapturingSpawn();
    const adapter = new CodexAdapter({ spawn: spawn.fn });

    await adapter.spawn({
      run_id: "normal-codex-1",
      cwd: "/tmp/test",
      prompt: "Normal run",
    });

    expect(spawn.calls[0]!.args[0]).toBe("exec");
    expect(spawn.calls[0]!.args[1]).toBe("Normal run");
    expect(spawn.calls[0]!.args).not.toContain("resume");
  });

  it("places the read-only sandbox flag on outer exec before resume", async () => {
    const spawn = createCapturingSpawn();
    const adapter = new CodexAdapter({ spawn: spawn.fn });

    await adapter.spawn({
      run_id: "resume-codex-read-only",
      cwd: "/tmp/test",
      prompt: "Continue read-only",
      resume_session_id: "abcd-ef01-2345-6789",
      backend_options: { sandbox: "read-only" },
    });

    expect(spawn.calls[0]!.args.slice(0, 4)).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "resume",
    ]);
  });
});

// ── Adapter factory ─────────────────────────────────────────────────

describe("Adapter factory", () => {
  it("creates Claude adapter for 'claude'", () => {
    const adapter = createAdapter("claude");
    expect(adapter.name).toBe("claude");
    expect(adapter).toBeInstanceOf(ClaudeAdapter);
  });

  it("creates Codex adapter for 'codex'", () => {
    const adapter = createAdapter("codex");
    expect(adapter.name).toBe("codex");
    expect(adapter).toBeInstanceOf(CodexAdapter);
  });

  it("throws for unsupported backend", () => {
    expect(() => createAdapter("gpt")).toThrow("Unsupported backend");
    expect(() => createAdapter("gpt")).toThrow("claude, codex");
  });

  it("passes adapter-specific options through", async () => {
    const spawn = createCapturingSpawn();
    const adapter = createAdapter("codex", { codex: { spawn: spawn.fn } });

    await adapter.spawn!({
      run_id: "factory-test",
      cwd: "/tmp/test",
      prompt: "Factory prompt",
    });

    expect(basename(spawn.calls[0]!.cmd)).toBe("codex");
    expect(spawn.calls[0]!.args).toContain("Factory prompt");
  });

  it("SUPPORTED_BACKENDS includes both backends", () => {
    expect(SUPPORTED_BACKENDS).toContain("claude");
    expect(SUPPORTED_BACKENDS).toContain("codex");
    expect(SUPPORTED_BACKENDS).toHaveLength(2);
  });
});

// ── Adapter selection matrix ────────────────────────────────────────

describe("Adapter selection matrix", () => {
  let tmpDir: string;
  let receiptPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "calyx-matrix-"));
    await mkdir(join(tmpDir, ".git"), { recursive: true });
    receiptPath = join(tmpDir, "receipt.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Run a golden-path execution with a given backend and assert parity. */
  async function runWithBackend(backend: "claude" | "codex") {
    const spawn = createCapturingSpawn({ code: 0, stdout: "", stderr: "" });
    const adapter = createAdapter(backend, {
      claude: { spawn: spawn.fn },
      codex: { spawn: spawn.fn },
    });

    const spec = validSpec({
      backend,
      required_artifacts: ["receipt.json"],
    });

    const result = await executeRun(spec, {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
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
    });

    return { result, spawnCalls: spawn.calls };
  }

  it("claude backend routes to claude CLI", async () => {
    const { spawnCalls } = await runWithBackend("claude");
    expect(spawnCalls[0]!.cmd).toBe("claude");
  });

  it("codex backend routes to codex CLI", async () => {
    const { spawnCalls } = await runWithBackend("codex");
    expect(basename(spawnCalls[0]!.cmd)).toBe("codex");
  });

  it("receipt schema is valid for both backends", async () => {
    for (const backend of ["claude", "codex"] as const) {
      const { result } = await runWithBackend(backend);
      expect(runReceiptSchema.safeParse(result.receipt).success).toBe(true);
    }
  });

  it("receipt state is 'succeeded' for both backends on exit 0", async () => {
    for (const backend of ["claude", "codex"] as const) {
      const { result } = await runWithBackend(backend);
      expect(result.receipt.state).toBe("succeeded");
      expect(result.receipt.exit.failure_class).toBe("success");
    }
  });

  it("receipt environment.backend reflects selected backend", async () => {
    for (const backend of ["claude", "codex"] as const) {
      const { result } = await runWithBackend(backend);
      expect(result.receipt.environment.backend).toBe(backend);
    }
  });

  it("injects CALYX_RUN metadata env for claude and legacy codex launches", async () => {
    for (const backend of ["claude", "codex"] as const) {
      const spawn = createCapturingSpawn({ code: 0, stdout: "", stderr: "" });
      const adapter = createAdapter(backend, {
        claude: { spawn: spawn.fn },
        codex: { spawn: spawn.fn },
      });
      const runId = `metadata-${backend}-run`;
      const branch = `metadata-${backend}-branch`;
      const runDir = join(tmpDir, "runs", runId);
      const spec = validSpec({
        run_id: runId,
        backend,
        host: "blade",
        issue: "POL-1324",
        required_artifacts: [],
        worktree: {
          ref: "origin/main",
          branch,
          steal_lock: false,
        },
        backend_options: {
          env: {
            CALYX_RUN_ID: "forged-run",
            CUSTOM_VAR: "kept",
          },
        },
      });

      await mkdir(runDir, { recursive: true });
      await executeRun(spec, {
        adapter,
        worktree: { base_path: tmpDir, exec: mockExec() },
        receiptPath: join(runDir, "kernel_receipt.json"),
      });

      expect(spawn.calls).toHaveLength(1);
      expect(spawn.calls[0]!.env).toMatchObject({
        CALYX_RUN_ID: runId,
        CALYX_RUN_DIR: runDir,
        CALYX_RUN_HOST: "blade",
        CALYX_RUN_ISSUE: "POL-1324",
        CALYX_RUN_WORKTREE: join(tmpDir, branch),
        CUSTOM_VAR: "kept",
      });
    }
  });

  it("state transitions are identical for both backends on golden path", async () => {
    const expected = [
      { from: "queued", to: "dispatching" },
      { from: "dispatching", to: "running" },
      { from: "running", to: "succeeded" },
    ];

    for (const backend of ["claude", "codex"] as const) {
      const { result } = await runWithBackend(backend);
      const transitions = result.events
        .filter((e) => e.event === "state_transition")
        .map((e) => ({ from: e.from, to: e.to }));
      expect(transitions).toEqual(expected);
    }
  });

  it("artifact gate parity across backends", async () => {
    for (const backend of ["claude", "codex"] as const) {
      const { result } = await runWithBackend(backend);
      expect(result.receipt.artifacts.gate_passed).toBe(true);
      expect(result.receipt.artifacts.missing).toEqual([]);
    }
  });
});

// ── Codex orchestrator failure paths ────────────────────────────────

describe("Codex failure paths through orchestrator", () => {
  let tmpDir: string;
  let receiptPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "calyx-codex-fail-"));
    await mkdir(join(tmpDir, ".git"), { recursive: true });
    receiptPath = join(tmpDir, "receipt.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("codex auth_failure event → auth_error state", async () => {
    const spawn = createCapturingSpawn({ code: 1, stdout: "", stderr: "" });
    const adapter = new CodexAdapter({ spawn: spawn.fn });

    // Override to inject auth_failure event
    const wrappedAdapter: BackendAdapter = {
      name: "codex",
      capabilities: adapter.capabilities,
      async spawn(opts: AdapterSpawnOptions): Promise<AdapterResult> {
        const result = await adapter.spawn(opts);
        return { ...result, events: [{ event: "auth_failure" }] };
      },
      async stop(run_id: string) { await adapter.stop(run_id); },
    };

    const spec = validSpec({ backend: "codex" });
    const result = await executeRun(spec, {
      adapter: wrappedAdapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.state).toBe("auth_error");
    expect(result.receipt.exit.failure_class).toBe("auth_error");
    expect(runReceiptSchema.safeParse(result.receipt).success).toBe(true);
  });

  it("codex infra_error from OOM stderr pattern", async () => {
    const spawn = createCapturingSpawn({
      code: 137,
      stdout: "",
      stderr: "Out of memory: Killed process 54321",
    });
    const adapter = new CodexAdapter({ spawn: spawn.fn });

    const spec = validSpec({ backend: "codex" });
    const result = await executeRun(spec, {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.state).toBe("infra_error");
    expect(result.receipt.exit.failure_class).toBe("infra_error");
    expect(result.receipt.exit.failure_source).toBe("stderr_pattern");
    expect(runReceiptSchema.safeParse(result.receipt).success).toBe(true);
  });

  it("codex task_failure for generic non-zero exit", async () => {
    const spawn = createCapturingSpawn({ code: 42, stdout: "", stderr: "" });
    const adapter = new CodexAdapter({ spawn: spawn.fn });

    const spec = validSpec({ backend: "codex" });
    const result = await executeRun(spec, {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.state).toBe("failed");
    expect(result.receipt.exit.failure_class).toBe("task_failure");
    expect(runReceiptSchema.safeParse(result.receipt).success).toBe(true);
  });

  it("codex spawn failure → infra_error with undefined exit_code", async () => {
    const adapter = new CodexAdapter({
      spawn: async () => { throw new Error("ENOENT: codex binary not found"); },
    });

    const spec = validSpec({ backend: "codex" });
    const result = await executeRun(spec, {
      adapter,
      worktree: { base_path: tmpDir, exec: mockExec() },
      receiptPath,
    });

    expect(result.receipt.state).toBe("infra_error");
    expect(result.receipt.exit.failure_class).toBe("infra_error");
    expect(runReceiptSchema.safeParse(result.receipt).success).toBe(true);
  });

  it("codex completed_dirty when artifacts present with non-zero exit", async () => {
    // Adapter that emits many events to exceed dirty threshold
    const highEventAdapter: BackendAdapter = {
      name: "codex",
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
            message: `Codex event ${i}`,
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

    const spec = validSpec({
      backend: "codex",
      required_artifacts: ["output.txt"],
    });

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
    expect(runReceiptSchema.safeParse(result.receipt).success).toBe(true);
  });
});
