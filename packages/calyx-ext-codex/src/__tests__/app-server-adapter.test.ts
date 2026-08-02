import { EventEmitter } from "node:events";
import fs from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeRun,
  type AdapterStartOptions,
  type RunSpec,
  type TurnEvent,
} from "@polli-labs/calyx-runner";
import {
  applyStateMigrations,
  openStateStore,
  readRunnerLiveBindingByRunAdapter,
} from "@polli-labs/calyx-core";
import { CodexAppServerAdapter, createCodexRuntimeAdapterFactory } from "../runtime/index.js";
import { resolveCodexCommand } from "../runtime/app-server-adapter.js";
import { resolveCodexCommandOrDefault } from "../runtime/app-server-command.js";
import type {
  JsonRpcNotificationMessage,
  JsonRpcRequestMessage,
  SpawnCodexProcess,
  SpawnedCodexProcess,
} from "../runtime/index.js";

interface MockServerRequest extends JsonRpcRequestMessage {
  id: number;
}

class MockCodexProcess extends EventEmitter implements SpawnedCodexProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = 424242;
  readonly killCalls: Array<NodeJS.Signals | undefined> = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    this.emit("exit", signal === "SIGKILL" ? 137 : 0, signal ?? null);
    return true;
  }
}

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CALYX_STATE_HOME = process.env.CALYX_STATE_HOME;
const ORIGINAL_CALYX_STATE_DB = process.env.CALYX_STATE_DB;
const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;
const ORIGINAL_CALYX_CODEX_BIN = process.env.CALYX_CODEX_BIN;

/**
 * Every `startSession` test drives a mocked `SpawnCodexProcess`, so no real
 * Codex process is ever launched — but `resolveCodexCommand` still runs for
 * real against the child env, and used to find a Codex only because fleet
 * hosts happen to have one installed. That made the suite unrunnable anywhere
 * else: CI failed with "Codex executable not found (tried: PATH)" from
 * 2026-06-23 until this fixture landed. Point the documented override at a
 * stub executable instead, so resolution still exercises its real code path
 * and resolves the same way on any host.
 */
let stubCodexRoot: string;
let stubCodexBin: string;

function createMockSpawn(
  handler: (message: Record<string, unknown>, tools: {
    respond: (id: number, result?: unknown, error?: { code: number; message: string }) => void;
    notify: (method: string, params?: unknown) => void;
    request: (id: number, method: string, params?: unknown) => void;
    writeStderr: (message: string) => void;
  }) => void | Promise<void>,
): {
  spawn: SpawnCodexProcess;
  processes: MockCodexProcess[];
  calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }>;
} {
  const processes: MockCodexProcess[] = [];
  const calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const spawn: SpawnCodexProcess = (args) => {
    const process = new MockCodexProcess();
    processes.push(process);
    calls.push({
      command: args.command,
      args: [...args.args],
      cwd: args.cwd,
      env: { ...args.env },
    });
    process.stdin.setEncoding("utf8");
    let buffer = "";

    const respond = (id: number, result?: unknown, error?: { code: number; message: string }): void => {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) })}\n`);
    };
    const notify = (method: string, params?: unknown): void => {
      const message: JsonRpcNotificationMessage = {
        jsonrpc: "2.0",
        method,
        ...(params !== undefined ? { params } : {}),
      };
      process.stdout.write(`${JSON.stringify(message)}\n`);
    };
    const request = (id: number, method: string, params?: unknown): void => {
      const message: MockServerRequest = {
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      };
      process.stdout.write(`${JSON.stringify(message)}\n`);
    };
    const writeStderr = (message: string): void => {
      process.stderr.write(message);
    };

    process.stdin.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString();
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          return;
        }
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) {
          continue;
        }
        void handler(JSON.parse(line) as Record<string, unknown>, {
          respond,
          notify,
          request,
          writeStderr,
        });
      }
    });

    return process;
  };
  return { spawn, processes, calls };
}

async function collectEvents(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const collected: TurnEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function validStartOptions(overrides: Partial<AdapterStartOptions> = {}): AdapterStartOptions {
  return {
    run_id: "run-001",
    cwd: "/tmp/worktree",
    ...overrides,
  };
}

function mockExec(): (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> {
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

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  message: string,
): Promise<T> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${message}; last=${JSON.stringify(await read())}`);
}

describe("Codex app-server adapter", () => {
  beforeAll(async () => {
    stubCodexRoot = await mkdtemp(join(tmpdir(), "codex-stub-bin-"));
    stubCodexBin = join(stubCodexRoot, "codex");
    await writeFile(stubCodexBin, "#!/bin/sh\nexit 0\n");
    await chmod(stubCodexBin, 0o755);
  });

  afterAll(async () => {
    await rm(stubCodexRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.CALYX_CODEX_BIN = stubCodexBin;
  });

  afterEach(() => {
    vi.restoreAllMocks();

    if (ORIGINAL_CALYX_CODEX_BIN === undefined) {
      delete process.env.CALYX_CODEX_BIN;
    } else {
      process.env.CALYX_CODEX_BIN = ORIGINAL_CALYX_CODEX_BIN;
    }

    if (ORIGINAL_PATH === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = ORIGINAL_PATH;
    }

    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }

    if (ORIGINAL_CALYX_STATE_HOME === undefined) {
      delete process.env.CALYX_STATE_HOME;
    } else {
      process.env.CALYX_STATE_HOME = ORIGINAL_CALYX_STATE_HOME;
    }

    if (ORIGINAL_CALYX_STATE_DB === undefined) {
      delete process.env.CALYX_STATE_DB;
    } else {
      process.env.CALYX_STATE_DB = ORIGINAL_CALYX_STATE_DB;
    }

    if (ORIGINAL_CODEX_HOME === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = ORIGINAL_CODEX_HOME;
    }
  });

  describe("resolveCodexCommand", () => {
    function mockPlatform(platform: NodeJS.Platform): void {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    }

    function mockExecutableFiles(files: string[]): void {
      const executableFiles = new Set(files);
      vi.spyOn(fs, "statSync").mockImplementation((filePath) => {
        const normalized = String(filePath);
        if (!executableFiles.has(normalized)) {
          throw Object.assign(new Error("not found"), { code: "ENOENT" });
        }
        return { isFile: () => true } as ReturnType<typeof fs.statSync>;
      });
      vi.spyOn(fs, "accessSync").mockImplementation((filePath) => {
        if (!executableFiles.has(String(filePath))) {
          throw Object.assign(new Error("not executable"), { code: "EACCES" });
        }
      });
    }

    it("uses CALYX_CODEX_BIN when it points at an executable file", () => {
      mockPlatform("linux");
      mockExecutableFiles(["/custom/bin/codex"]);

      expect(resolveCodexCommand({
        CALYX_CODEX_BIN: "/custom/bin/codex",
        PATH: "/usr/local/bin:/usr/bin",
      })).toBe("/custom/bin/codex");
    });

    it("accepts CODEX_BIN as an alias when the canonical override is unset", () => {
      mockPlatform("linux");
      mockExecutableFiles(["/alias/bin/codex"]);

      expect(resolveCodexCommand({
        CODEX_BIN: "/alias/bin/codex",
        PATH: "/usr/local/bin:/usr/bin",
      })).toBe("/alias/bin/codex");
    });

    it("prefers Apple-silicon Homebrew codex on macOS before PATH", () => {
      mockPlatform("darwin");
      mockExecutableFiles([
        "/opt/homebrew/bin/codex",
        "/Users/carbon/.npm-global/bin/codex",
      ]);

      expect(resolveCodexCommand({
        PATH: "/Users/carbon/.npm-global/bin:/usr/bin",
      })).toBe("/opt/homebrew/bin/codex");
    });

    it("resolves the first executable codex on PATH on Linux", () => {
      mockPlatform("linux");
      mockExecutableFiles(["/usr/local/bin/codex"]);

      expect(resolveCodexCommand({
        PATH: "/missing/bin:/usr/local/bin:/usr/bin",
      })).toBe("/usr/local/bin/codex");
    });

    it("resolves Windows codex executable names from PATH", () => {
      mockPlatform("win32");
      mockExecutableFiles(["C:\\Program Files\\Codex\\codex.cmd"]);

      expect(resolveCodexCommand({
        PATH: "C:\\Missing;C:\\Program Files\\Codex",
      })).toBe("C:\\Program Files\\Codex\\codex.cmd");
    });

    it("falls back to bare codex when PATH is unavailable to inspect", () => {
      mockPlatform("linux");
      mockExecutableFiles([]);

      expect(resolveCodexCommand({})).toBe("codex");
    });

    it("throws an actionable error when an explicit override is not executable", () => {
      mockPlatform("linux");
      mockExecutableFiles([]);

      expect(() => resolveCodexCommand({
        CALYX_CODEX_BIN: "/missing/codex",
        PATH: "/missing/bin:/also-missing/bin",
      })).toThrow(
        "Codex executable not found (tried: CALYX_CODEX_BIN=/missing/codex). Install codex or set CALYX_CODEX_BIN.",
      );
    });

    it("throws an actionable error when PATH is searchable and no candidate exists", () => {
      mockPlatform("linux");
      mockExecutableFiles([]);

      expect(() => resolveCodexCommand({
        PATH: "/missing/bin:/also-missing/bin",
      })).toThrow(
        "Codex executable not found (tried: PATH). Install codex or set CALYX_CODEX_BIN.",
      );
    });

    // POL-1889 replaced the stale-shim resolution on the app-server transport
    // but left the one-shot exec transport spawning a bare "codex". On a host
    // whose PATH leads with ~/.npm-global/bin that bare name is the npm
    // launcher, which is exactly the shim the resolver exists to skip.
    it("prefers the Homebrew binary over a leading npm-global shim", () => {
      mockPlatform("darwin");
      mockExecutableFiles([
        "/opt/homebrew/bin/codex",
        "/Users/carbon/.npm-global/bin/codex",
      ]);

      expect(resolveCodexCommandOrDefault({
        PATH: "/Users/carbon/.npm-global/bin:/usr/bin",
      })).toBe("/opt/homebrew/bin/codex");
    });

    it("returns the bare name instead of throwing when nothing resolves", () => {
      mockPlatform("linux");
      mockExecutableFiles([]);

      // Callers that already classify spawn failures must keep their spawn
      // diagnosis; a resolver exception would be a worse error, not a better
      // one. This is also why a codex-less CI host stays green.
      expect(resolveCodexCommandOrDefault({
        PATH: "/missing/bin:/also-missing/bin",
      })).toBe("codex");
    });
  });

  it("prepends managed harness paths when daemon PATH is minimal", async () => {
    process.env.PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    process.env.HOME = "/home/caleb";
    const { spawn, calls } = createMockSpawn((message, tools) => {
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, { userAgent: "calyx-test/0.0.0" });
        return;
      }
      if (message["method"] === "thread/start") {
        tools.respond(message["id"] as number, {
          thread: { id: "thread-1", path: null, cwd: "/tmp/worktree" },
        });
      }
    });
    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });

    const session = await adapter.startSession(validStartOptions());
    await session.close();

    expect(calls[0]?.env.PATH).toBe([
      "/home/caleb/.agents/run",
      "/home/caleb/.npm-global/bin",
      "/home/caleb/.local/share/pnpm",
      "/home/caleb/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/local/sbin",
      "/usr/sbin",
      "/sbin",
    ].join(":"));
  });

  it("preserves explicit backend PATH override", async () => {
    const binDir = stubCodexRoot;
    process.env.PATH = "/process/path";
    process.env.HOME = "/home/caleb";
    const { spawn, calls } = createMockSpawn((message, tools) => {
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, { userAgent: "calyx-test/0.0.0" });
        return;
      }
      if (message["method"] === "thread/start") {
        tools.respond(message["id"] as number, {
          thread: { id: "thread-1", path: null, cwd: "/tmp/worktree" },
        });
      }
    });
    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });

    const session = await adapter.startSession(validStartOptions({
      backend_options: { env: { PATH: binDir } },
    }));
    await session.close();

    expect(calls[0]?.env.PATH).toBe(binDir);
  });

  it("preserves explicit backend PATH removal", async () => {
    process.env.PATH = "/process/path";
    process.env.HOME = "/home/caleb";
    const { spawn, calls } = createMockSpawn((message, tools) => {
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, { userAgent: "calyx-test/0.0.0" });
        return;
      }
      if (message["method"] === "thread/start") {
        tools.respond(message["id"] as number, {
          thread: { id: "thread-1", path: null, cwd: "/tmp/worktree" },
        });
      }
    });
    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });

    const session = await adapter.startSession(validStartOptions({
      backend_options: { env: { PATH: null } },
    }));
    await session.close();

    expect(calls[0]?.env.PATH).toBeUndefined();
  });

  it("keeps a single backend thread alive across multiple turns in one session", async () => {
    const sessionLines: string[] = [];
    let nextTurn = 0;
    const { spawn } = createMockSpawn(async (message, tools) => {
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, {
          userAgent: "calyx-test/0.0.0",
          platformFamily: "unix",
          platformOs: "linux",
        });
        return;
      }
      if (message["method"] === "thread/start") {
        tools.respond(message["id"] as number, {
          thread: {
            id: "thread-001",
            path: "/tmp/thread-001.jsonl",
            cwd: "/tmp/worktree",
          },
        });
        return;
      }
      if (message["method"] === "turn/start") {
        nextTurn += 1;
        const turnId = `turn-00${nextTurn}`;
        tools.respond(message["id"] as number, {
          turn: { id: turnId, items: [], status: "inProgress", error: null },
        });
        sessionLines.push(
          JSON.stringify({
            type: "response_item",
            timestamp: `2026-03-20T00:00:0${nextTurn}Z`,
            payload: {
              role: "assistant",
              type: "message",
              content: `Turn ${nextTurn} complete`,
            },
          }),
        );
        queueMicrotask(() => {
          tools.notify("turn/started", {
            threadId: "thread-001",
            turn: { id: turnId, items: [], status: "inProgress", error: null },
          });
          tools.notify("item/agentMessage/delta", {
            threadId: "thread-001",
            turnId,
            itemId: `item-${nextTurn}`,
            delta: `delta-${nextTurn}`,
          });
          tools.notify("turn/completed", {
            threadId: "thread-001",
            turn: { id: turnId, items: [], status: "completed", error: null },
          });
        });
      }
    });

    const adapter = new CodexAppServerAdapter({
      spawnProcess: spawn,
      sessionParserFs: {
        readFile: async () => `${sessionLines.join("\n")}\n`,
      },
    });
    const activities: string[] = [];
    const session = await adapter.startSession(validStartOptions({
      onActivity: (activity) => activities.push(`${activity.source}:${activity.detail ?? ""}`),
    }));

    const firstHandle = await session.startTurn({ prompt: "First prompt" });
    const firstEventsPromise = collectEvents(firstHandle.events);
    const firstResult = await firstHandle.wait();
    const firstEvents = await firstEventsPromise;

    const secondHandle = await session.startTurn({ prompt: "Second prompt" });
    const secondEventsPromise = collectEvents(secondHandle.events);
    const secondResult = await secondHandle.wait();
    const secondEvents = await secondEventsPromise;

    expect(session.backend_session?.id).toBe("thread-001");
    expect(firstResult.exit_code).toBe(0);
    expect(firstResult.backend_turn_id).toBe("turn-001");
    expect(firstResult.agent_terminal_message).toBe("Turn 1 complete");
    expect(firstEvents.some((event) => event.kind === "item")).toBe(true);
    expect(secondResult.exit_code).toBe(0);
    expect(secondResult.backend_turn_id).toBe("turn-002");
    expect(secondResult.agent_terminal_message).toBe("Turn 2 complete");
    expect(secondEvents.some((event) => event.kind === "item")).toBe(true);
    expect(activities).toContain("turn:turn_started");
    expect(activities).toContain("turn:agent_message_delta");
    expect(activities).toContain("turn:turn_completed");

    await session.close();
  });

  it("persists a live binding, records active turns, and clears them on completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-app-server-live-binding-"));
    delete process.env.CALYX_STATE_DB;
    process.env.CALYX_STATE_HOME = join(root, "state");
    process.env.CODEX_HOME = join(root, "codex-home");
    await applyStateMigrations();

    const runId = "run-live-binding-app-server";
    const seenMethods: string[] = [];
    const steerProbeParams: unknown[] = [];
    let notifyServer: ((method: string, params?: unknown) => void) | undefined;

    const { spawn } = createMockSpawn(async (message, tools) => {
      if (typeof message["method"] === "string") {
        seenMethods.push(message["method"]);
      }
      notifyServer = tools.notify;
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, {
          userAgent: "calyx-test/0.0.0",
          platformFamily: "unix",
          platformOs: "linux",
        });
        return;
      }
      if (message["method"] === "thread/start") {
        tools.respond(message["id"] as number, {
          thread: {
            id: "thread-live-binding",
            path: "/tmp/thread-live-binding.jsonl",
            cwd: "/tmp/worktree",
          },
        });
        return;
      }
      if (message["method"] === "turn/steer") {
        steerProbeParams.push(message["params"]);
        tools.respond(message["id"] as number, undefined, {
          code: -32000,
          message: "No active turn for expectedTurnId startup probe.",
        });
        return;
      }
      if (message["method"] === "turn/start") {
        tools.respond(message["id"] as number, {
          turn: { id: "turn-live-binding", items: [], status: "inProgress", error: null },
        });
      }
    });

    const readBinding = async () => {
      const opened = await openStateStore();
      try {
        return readRunnerLiveBindingByRunAdapter(opened.db, runId, "codex_app_server_steer");
      } finally {
        opened.db.close();
      }
    };

    try {
      const adapter = new CodexAppServerAdapter({
        spawnProcess: spawn,
        liveBindings: {
          enabled: true,
          host: "blade.example.test",
          protocol_probe_timeout_ms: 100,
        },
      });
      const session = await adapter.startSession(validStartOptions({ run_id: runId }));
      const registered = await readBinding();
      expect(registered).toMatchObject({
        run_id: runId,
        adapter: "codex_app_server_steer",
        backend: "codex",
        lifecycle_owner: "calyx",
        host: "blade",
        status: "active",
        codex_home: join(root, "codex-home"),
        thread_id: "thread-live-binding",
        auth_ref: { mode: "codex_home", codex_home: join(root, "codex-home") },
      });
      expect(registered?.endpoint).toMatchObject({
        transport: "stdio-jsonl",
        experimental_api: true,
        turn_steer_probe: {
          status: "dispatchable",
        },
      });
      expect(seenMethods.indexOf("turn/steer")).toBeGreaterThan(seenMethods.indexOf("thread/start"));
      expect(steerProbeParams).toHaveLength(1);
      expect(steerProbeParams[0]).toMatchObject({
        threadId: "thread-live-binding",
        expectedTurnId: "calyx-turn-steer-startup-probe",
      });

      const handle = await session.startTurn({ prompt: "Keep the turn open for steer." });
      const active = await readBinding();
      expect(active).toMatchObject({
        active_turn_id: "turn-live-binding",
        active_turn_source: "app-server-response:turn/start",
        active_turn_status: "in_progress",
      });

      notifyServer?.("turn/completed", {
        threadId: "thread-live-binding",
        turn: { id: "turn-live-binding", items: [], status: "completed", error: null },
      });
      await handle.wait();
      const cleared = await waitFor(
        readBinding,
        (binding) => binding?.active_turn_id === null && binding.active_turn_status === "completed",
        "live binding active turn was not cleared",
      );
      expect(cleared).toMatchObject({
        active_turn_id: null,
        active_turn_source: "app-server-notification:turn/completed",
        active_turn_status: "completed",
      });

      await session.close();
      const closed = await waitFor(
        readBinding,
        (binding) => binding?.status === "closed",
        "live binding was not closed",
      );
      expect(closed).toMatchObject({
        status: "closed",
        active_turn_id: null,
        active_turn_status: "closed",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps resume_session_id to thread/resume and preserves the resumed thread id", async () => {
    const seenMethods: string[] = [];
    let resumeParams: Record<string, unknown> | undefined;
    const { spawn } = createMockSpawn(async (message, tools) => {
      if (typeof message["method"] === "string") {
        seenMethods.push(message["method"]);
      }
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, {
          userAgent: "calyx-test/0.0.0",
          platformFamily: "unix",
          platformOs: "linux",
        });
        return;
      }
      if (message["method"] === "thread/resume") {
        resumeParams = message["params"] as Record<string, unknown>;
        tools.respond(message["id"] as number, {
          thread: {
            id: "thread-resumed",
            path: "/tmp/thread-resumed.jsonl",
            cwd: "/tmp/worktree",
          },
        });
      }
    });

    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });
    const session = await adapter.startSession(validStartOptions({ resume_session_id: "thread-resumed" }));

    expect(session.backend_session?.id).toBe("thread-resumed");
    expect(seenMethods).toContain("thread/resume");
    expect(seenMethods).not.toContain("thread/start");
    expect(resumeParams).toEqual({
      threadId: "thread-resumed",
      cwd: "/tmp/worktree",
      persistExtendedHistory: true,
    });

    await session.close();
  });

  it("maps system prompt fields to thread/start instruction overrides", async () => {
    let threadStartParams: Record<string, unknown> | undefined;
    const { spawn } = createMockSpawn(async (message, tools) => {
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, {
          userAgent: "calyx-test/0.0.0",
          platformFamily: "unix",
          platformOs: "linux",
        });
        return;
      }
      if (message["method"] === "thread/start") {
        threadStartParams = message["params"] as Record<string, unknown>;
        tools.respond(message["id"] as number, {
          thread: {
            id: "thread-instructions",
            path: "/tmp/thread-instructions.jsonl",
            cwd: "/tmp/worktree",
          },
        });
      }
    });

    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });
    const session = await adapter.startSession(validStartOptions({
      system_prompt: "Replacement base instructions.",
      append_system_prompt: "Additional developer instructions.",
    }));

    expect(threadStartParams).toMatchObject({
      baseInstructions: "Replacement base instructions.",
      developerInstructions: "Additional developer instructions.",
    });

    await session.close();
  });

  it("passes one-off reasoning effort to turn/start", async () => {
    let turnStartParams: Record<string, unknown> | undefined;
    const { spawn } = createMockSpawn(async (message, tools) => {
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, {
          userAgent: "calyx-test/0.0.0",
          platformFamily: "unix",
          platformOs: "linux",
        });
        return;
      }
      if (message["method"] === "thread/start") {
        tools.respond(message["id"] as number, {
          thread: {
            id: "thread-effort",
            path: "/tmp/thread-effort.jsonl",
            cwd: "/tmp/worktree",
          },
        });
        return;
      }
      if (message["method"] === "turn/start") {
        turnStartParams = message["params"] as Record<string, unknown>;
        tools.respond(message["id"] as number, {
          turn: { id: "turn-effort", items: [], status: "inProgress", error: null },
        });
        queueMicrotask(() => {
          tools.notify("turn/completed", {
            threadId: "thread-effort",
            turn: { id: "turn-effort", items: [], status: "completed", error: null },
          });
        });
      }
    });

    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });
    const session = await adapter.startSession(validStartOptions({
      backend_options: { reasoning_effort: "xhigh" },
    }));
    const handle = await session.startTurn({ prompt: "Use the high-effort lane." });
    await handle.wait();

    expect(turnStartParams).toMatchObject({ effort: "xhigh" });

    await session.close();
  });

  it("maps max_threads to the Codex app-server process config", async () => {
    const { spawn, calls } = createMockSpawn(async (message, tools) => {
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, {
          userAgent: "calyx-test/0.0.0",
          platformFamily: "unix",
          platformOs: "linux",
        });
        return;
      }
      if (message["method"] === "thread/start") {
        tools.respond(message["id"] as number, {
          thread: {
            id: "thread-max-threads",
            path: "/tmp/thread-max-threads.jsonl",
            cwd: "/tmp/worktree",
          },
        });
      }
    });

    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });
    const session = await adapter.startSession(validStartOptions({
      backend_options: { max_threads: 8 },
    }));

    expect(calls[0]?.args).toEqual([
      "-c",
      "agents.max_threads=8",
      "app-server",
      "--listen",
      "stdio://",
    ]);

    await session.close();
  });

  it.each([
    ["read-only", "read-only"],
    ["danger-full-access", "danger-full-access"],
  ] as const)("passes backend_options.sandbox=%s to thread/start", async (configured, expected) => {
    let threadStartParams: Record<string, unknown> | undefined;
    const { spawn } = createMockSpawn(async (message, tools) => {
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, { userAgent: "calyx-test/0.0.0" });
        return;
      }
      if (message["method"] === "thread/start") {
        threadStartParams = message["params"] as Record<string, unknown>;
        tools.respond(message["id"] as number, {
          thread: { id: `thread-${configured}`, path: null, cwd: "/tmp/worktree" },
          ...(configured === "read-only" ? { sandbox: { type: "readOnly", networkAccess: false } } : {}),
        });
      }
    });
    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });

    const session = await adapter.startSession(validStartOptions({
      backend_options: { sandbox: configured },
    }));

    expect(threadStartParams).toMatchObject({ sandbox: expected });
    await session.close();
  });

  it("passes read-only sandbox to thread/resume", async () => {
    let threadResumeParams: Record<string, unknown> | undefined;
    const { spawn } = createMockSpawn(async (message, tools) => {
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, { userAgent: "calyx-test/0.0.0" });
        return;
      }
      if (message["method"] === "thread/resume") {
        threadResumeParams = message["params"] as Record<string, unknown>;
        tools.respond(message["id"] as number, {
          thread: { id: "thread-resumed", path: null, cwd: "/tmp/worktree" },
          sandbox: { type: "readOnly", networkAccess: false },
        });
      }
    });
    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });

    const session = await adapter.startSession(validStartOptions({
      resume_session_id: "thread-resumed",
      backend_options: { sandbox: "read-only" },
    }));

    expect(threadResumeParams).toMatchObject({
      threadId: "thread-resumed",
      sandbox: "read-only",
    });
    await session.close();
  });

  it("maps the permissions bypass to danger-full-access", async () => {
    let threadStartParams: Record<string, unknown> | undefined;
    const { spawn } = createMockSpawn(async (message, tools) => {
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, { userAgent: "calyx-test/0.0.0" });
        return;
      }
      if (message["method"] === "thread/start") {
        threadStartParams = message["params"] as Record<string, unknown>;
        tools.respond(message["id"] as number, {
          thread: { id: "thread-bypass", path: null, cwd: "/tmp/worktree" },
        });
      }
    });
    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });

    const session = await adapter.startSession(validStartOptions({
      backend_options: { dangerously_skip_permissions: true },
    }));

    expect(threadStartParams).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    await session.close();
  });

  it.each([
    [{ sandbox: "workspace-write" }, "must be read-only or danger-full-access"],
    [{ sandbox_class: "read-only" }, "does not support backend_options.sandbox_class"],
    [{ dangerously_skip_permissions: "true" }, "dangerously_skip_permissions must be a boolean"],
    [
      { sandbox: "read-only", dangerously_skip_permissions: true },
      "sandbox=read-only conflicts with dangerously_skip_permissions=true",
    ],
  ])("rejects invalid or conflicting sandbox options before spawning app-server", async (backendOptions, expected) => {
    const { spawn, calls } = createMockSpawn(() => {});
    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });

    await expect(adapter.startSession(validStartOptions({
      backend_options: backendOptions as NonNullable<AdapterStartOptions["backend_options"]>,
    }))).rejects.toThrow(expected);

    expect(calls).toHaveLength(0);
  });

  it.each([
    [undefined, "undefined"],
    [{ type: "workspaceWrite" }, '"workspaceWrite"'],
  ])("rejects and closes when app-server does not confirm read-only sandbox", async (responseSandbox, expected) => {
    const { spawn, processes } = createMockSpawn(async (message, tools) => {
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, { userAgent: "calyx-test/0.0.0" });
        return;
      }
      if (message["method"] === "thread/start") {
        tools.respond(message["id"] as number, {
          thread: { id: "thread-unconfirmed", path: null, cwd: "/tmp/worktree" },
          ...(responseSandbox === undefined ? {} : { sandbox: responseSandbox }),
        });
      }
    });
    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });

    await expect(adapter.startSession(validStartOptions({
      backend_options: { sandbox: "read-only" },
    }))).rejects.toThrow(`response.sandbox.type=${expected}`);

    expect(processes[0]?.killCalls).toContain("SIGTERM");
  });

  it("rejects Claude max_turns before spawning Codex app-server", async () => {
    const { spawn, calls } = createMockSpawn(() => {});
    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });

    await expect(adapter.startSession(validStartOptions({
      backend_options: { max_turns: 8 },
    }))).rejects.toThrow("Codex app-server does not support backend_options.max_turns");

    expect(calls).toHaveLength(0);
  });

  it("rejects model selection until Codex app-server model forwarding has a Calyx contract", async () => {
    let threadStartSeen = false;
    const { spawn } = createMockSpawn(async (message, tools) => {
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, {
          userAgent: "calyx-test/0.0.0",
          platformFamily: "unix",
          platformOs: "linux",
        });
        return;
      }
      if (message["method"] === "thread/start") {
        threadStartSeen = true;
      }
    });

    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });
    await expect(adapter.startSession(validStartOptions({
      backend_options: { model: "gpt-5.5" },
    }))).rejects.toThrow("does not yet support backend_options.model");
    expect(threadStartSeen).toBe(false);
  });

  it("rejects Claude-only max reasoning effort before turn/start", async () => {
    let turnStartSeen = false;
    const { spawn } = createMockSpawn(async (message, tools) => {
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, {
          userAgent: "calyx-test/0.0.0",
          platformFamily: "unix",
          platformOs: "linux",
        });
        return;
      }
      if (message["method"] === "thread/start") {
        tools.respond(message["id"] as number, {
          thread: {
            id: "thread-effort-max",
            path: "/tmp/thread-effort-max.jsonl",
            cwd: "/tmp/worktree",
          },
        });
        return;
      }
      if (message["method"] === "turn/start") {
        turnStartSeen = true;
      }
    });

    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });
    const session = await adapter.startSession(validStartOptions({
      backend_options: { reasoning_effort: "max" },
    }));

    await expect(session.startTurn({ prompt: "Use an unsupported Codex effort." }))
      .rejects.toThrow("Valid Codex values: none, minimal, low, medium, high, xhigh");
    expect(turnStartSeen).toBe(false);

    await session.close();
  });

  it("falls back to an empty backend session path when app-server omits it", async () => {
    const { spawn } = createMockSpawn(async (message, tools) => {
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, {
          userAgent: "calyx-test/0.0.0",
          platformFamily: "unix",
          platformOs: "linux",
        });
        return;
      }
      if (message["method"] === "thread/start") {
        tools.respond(message["id"] as number, {
          thread: {
            id: "thread-no-path",
            path: null,
            cwd: "/tmp/worktree",
          },
        });
      }
    });

    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });
    const session = await adapter.startSession(validStartOptions());

    expect(session.backend_session).toEqual({
      id: "thread-no-path",
      path: "",
      backend: "codex",
    });

    await session.close();
  });

  it("injects CALYX_RUN metadata env into the spawned app-server process through executeRun", async () => {
    const { spawn, calls } = createMockSpawn(async (message, tools) => {
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, {
          userAgent: "calyx-test/0.0.0",
          platformFamily: "unix",
          platformOs: "linux",
        });
        return;
      }
      if (message["method"] === "thread/start") {
        tools.respond(message["id"] as number, {
          thread: {
            id: "thread-env",
            path: "/tmp/thread-env.jsonl",
            cwd: "/tmp/worktree",
          },
        });
        return;
      }
      if (message["method"] === "turn/start") {
        tools.respond(message["id"] as number, {
          turn: { id: "turn-env", items: [], status: "inProgress", error: null },
        });
        queueMicrotask(() => {
          tools.notify("turn/completed", {
            threadId: "thread-env",
            turn: { id: "turn-env", items: [], status: "completed", error: null },
          });
        });
      }
    });
    const tmpDir = await mkdtemp(join(tmpdir(), "calyx-codex-app-env-"));

    try {
      await mkdir(join(tmpDir, ".git"), { recursive: true });
      const runId = "app-server-metadata-run";
      const branch = "app-server-metadata-branch";
      const runDir = join(tmpDir, "runs", runId);
      const spec: RunSpec = {
        run_id: runId,
        host: "blade",
        backend: "codex",
        issue: "POL-1324",
        prompt: "Test metadata env",
        require_execplan: false,
        pull_execplan: false,
        worktree: {
          ref: "origin/main",
          branch,
          steal_lock: false,
        },
        required_artifacts: [],
        backend_options: {
          env: {
            CALYX_RUN_ID: "forged-run",
            CUSTOM_VAR: "kept",
          },
        },
      };

      await mkdir(runDir, { recursive: true });
      await executeRun(spec, {
        adapter: new CodexAppServerAdapter({ spawnProcess: spawn }),
        worktree: { base_path: tmpDir, exec: mockExec() },
        receiptPath: join(runDir, "kernel_receipt.json"),
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.env).toMatchObject({
        CALYX_RUN_ID: runId,
        CALYX_RUN_DIR: runDir,
        CALYX_RUN_HOST: "blade",
        CALYX_RUN_ISSUE: "POL-1324",
        CALYX_RUN_WORKTREE: join(tmpDir, branch),
        CUSTOM_VAR: "kept",
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("auto-denies unexpected approval requests under approval_policy=never", async () => {
    let approvalResponse: Record<string, unknown> | undefined;
    const lifecycleWarnings: string[] = [];
    const { spawn } = createMockSpawn(async (message, tools) => {
      if (typeof message["method"] === "string") {
        if (message["method"] === "initialize") {
          tools.respond(message["id"] as number, {
            userAgent: "calyx-test/0.0.0",
            platformFamily: "unix",
            platformOs: "linux",
          });
          return;
        }
        if (message["method"] === "thread/start") {
          tools.respond(message["id"] as number, {
            thread: {
              id: "thread-approval",
              path: "/tmp/thread-approval.jsonl",
              cwd: "/tmp/worktree",
            },
          });
          return;
        }
        if (message["method"] === "turn/start") {
          tools.respond(message["id"] as number, {
            turn: { id: "turn-approval", items: [], status: "inProgress", error: null },
          });
          queueMicrotask(() => {
            tools.request(99, "item/commandExecution/requestApproval", {
              threadId: "thread-approval",
              turnId: "turn-approval",
              itemId: "item-approval",
              command: ["touch", "x"],
            });
          });
          queueMicrotask(() => {
            tools.notify("turn/completed", {
              threadId: "thread-approval",
              turn: { id: "turn-approval", items: [], status: "completed", error: null },
            });
          });
          return;
        }
        return;
      }

      if (message["id"] === 99) {
        approvalResponse = message;
      }
    });

    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });
    const session = await adapter.startSession(validStartOptions({
      backend_options: { dangerously_skip_permissions: true },
      onEvent: (event) => {
        if (event.event === "warning" && event.message) {
          lifecycleWarnings.push(event.message);
        }
      },
    }));

    const handle = await session.startTurn({ prompt: "Try a tool" });
    await handle.wait();

    expect(approvalResponse).toEqual({
      jsonrpc: "2.0",
      id: 99,
      result: { decision: "decline" },
    });
    expect(lifecycleWarnings.some((message) => message.includes("approval_policy=never"))).toBe(true);

    await session.close();
  });

  it("interrupts the active turn when stop(run_id) is requested", async () => {
    let interruptCount = 0;
    const { spawn } = createMockSpawn(async (message, tools) => {
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, {
          userAgent: "calyx-test/0.0.0",
          platformFamily: "unix",
          platformOs: "linux",
        });
        return;
      }
      if (message["method"] === "thread/start") {
        tools.respond(message["id"] as number, {
          thread: {
            id: "thread-stop",
            path: "/tmp/thread-stop.jsonl",
            cwd: "/tmp/worktree",
          },
        });
        return;
      }
      if (message["method"] === "turn/start") {
        tools.respond(message["id"] as number, {
          turn: { id: "turn-stop", items: [], status: "inProgress", error: null },
        });
        queueMicrotask(() => {
          tools.notify("turn/started", {
            threadId: "thread-stop",
            turn: { id: "turn-stop", items: [], status: "inProgress", error: null },
          });
        });
        return;
      }
      if (message["method"] === "turn/interrupt") {
        interruptCount += 1;
        tools.respond(message["id"] as number, null);
        queueMicrotask(() => {
          tools.notify("turn/completed", {
            threadId: "thread-stop",
            turn: { id: "turn-stop", items: [], status: "interrupted", error: null },
          });
        });
      }
    });

    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });
    const session = await adapter.startSession(validStartOptions());
    const handle = await session.startTurn({ prompt: "Long running turn" });

    await adapter.stop("run-001");
    const result = await handle.wait();

    expect(interruptCount).toBe(1);
    expect(result.exit_code).toBe(130);
    expect(result.signal).toBe("SIGINT");

    await session.close();
  });

  it("fails fast on malformed app-server stdout", async () => {
    const adapter = new CodexAppServerAdapter({
      spawnProcess: () => {
        const process = new MockCodexProcess();
        queueMicrotask(() => {
          process.stdout.write("not-json\n");
        });
        return process;
      },
    });

    await expect(adapter.startSession(validStartOptions())).rejects.toThrow("Malformed app-server stdout");
  });

  it("flushes startup stderr to backend-stderr.log when initialize fails", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "codex-app-server-stderr-"));
    const { spawn } = createMockSpawn(async (message, tools) => {
      if (message["method"] === "initialize") {
        tools.writeStderr("startup failure on stderr\n");
        tools.respond(message["id"] as number, undefined, {
          code: -32000,
          message: "initialize failed",
        });
      }
    });

    const adapter = new CodexAppServerAdapter({ spawnProcess: spawn });

    try {
      await expect(adapter.startSession(validStartOptions({ run_dir: runDir }))).rejects.toThrow("initialize failed");
      await expect(readFile(join(runDir, "backend-stderr.log"), "utf8")).resolves.toContain(
        "startup failure on stderr",
      );
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it("reuses one adapter instance for runtime metrics", () => {
    const factory = createCodexRuntimeAdapterFactory();
    const first = factory();
    const second = factory();

    expect(first).toBe(second);
    expect(factory.activeSessionCount?.()).toBe(0);
  });

  it("routes ordinary sessions through app-server without invoking legacy exec", async () => {
    let legacySpawned = false;
    const { spawn, calls } = createMockSpawn((message, tools) => {
      if (message["method"] === "initialize") {
        tools.respond(message["id"] as number, { userAgent: "calyx-test/0.0.0" });
        return;
      }
      if (message["method"] === "thread/start") {
        tools.respond(message["id"] as number, {
          thread: { id: "thread-router", path: null, cwd: "/tmp/worktree" },
        });
      }
    });
    const factory = createCodexRuntimeAdapterFactory({
      spawnProcess: spawn,
      outputCaptureLegacy: {
        spawn: async () => {
          legacySpawned = true;
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    });

    const session = await factory().startSession!(validStartOptions());
    await session.close();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["app-server", "--listen", "stdio://"]);
    expect(legacySpawned).toBe(false);
  });
});
