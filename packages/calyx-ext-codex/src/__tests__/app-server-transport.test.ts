import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerConnection,
  DEFAULT_CODEX_APP_SERVER_ARGS,
  type JsonRpcNotificationMessage,
  type JsonRpcRequestMessage,
  type JsonRpcResponseMessage,
  type SpawnCodexProcess,
  type SpawnedCodexProcess,
} from "../runtime/index.js";

class MockCodexProcess extends EventEmitter implements SpawnedCodexProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writtenMessages: Record<string, unknown>[] = [];
  pid = 424242;
  private stdinBuffer = "";

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdout.setEncoding("utf8");
    this.stderr.setEncoding("utf8");
    this.stdin.on("data", (chunk: string | Buffer) => {
      this.stdinBuffer += chunk.toString();
      while (true) {
        const newline = this.stdinBuffer.indexOf("\n");
        if (newline === -1) {
          return;
        }
        const line = this.stdinBuffer.slice(0, newline).trim();
        this.stdinBuffer = this.stdinBuffer.slice(newline + 1);
        if (line.length === 0) {
          continue;
        }
        this.writtenMessages.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
  }

  writeStdoutChunks(...chunks: string[]): void {
    for (const chunk of chunks) {
      this.stdout.write(chunk);
    }
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.emit("exit", signal === "SIGKILL" ? 137 : 0, signal ?? null);
    return true;
  }
}

class FailingStdinProcess extends EventEmitter implements SpawnedCodexProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  pid = 31337;

  constructor() {
    super();
    this.stdout.setEncoding("utf8");
    this.stderr.setEncoding("utf8");
    this.stdin = new Writable({
      write: (_chunk, _encoding, callback) => {
        const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
        this.stdin.emit("error", error);
        queueMicrotask(() => {
          this.emit("exit", 1, null);
        });
        callback(error);
      },
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.emit("exit", signal === "SIGKILL" ? 137 : 0, signal ?? null);
    return true;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition.");
}

function createMockSpawn(
  handler: (
    message: Record<string, unknown>,
    tools: {
      respond: (id: number, result?: unknown, error?: { code: number; message: string }) => void;
      notify: (method: string, params?: unknown) => void;
      request: (id: number, method: string, params?: unknown) => void;
      writeStdoutChunks: (...chunks: string[]) => void;
    },
  ) => void | Promise<void>,
): { spawn: SpawnCodexProcess; processes: MockCodexProcess[] } {
  const processes: MockCodexProcess[] = [];
  const spawn: SpawnCodexProcess = () => {
    const process = new MockCodexProcess();
    processes.push(process);

    process.stdin.on("data", (chunk: string | Buffer) => {
      const lines = chunk.toString().split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
      for (const line of lines) {
        void handler(JSON.parse(line) as Record<string, unknown>, {
          respond: (id, result, error) => {
            const message: JsonRpcResponseMessage = {
              jsonrpc: "2.0",
              id,
              ...(error ? { error } : { result }),
            };
            process.writeStdoutChunks(`${JSON.stringify(message)}\n`);
          },
          notify: (method, params) => {
            const message: JsonRpcNotificationMessage = {
              jsonrpc: "2.0",
              method,
              ...(params !== undefined ? { params } : {}),
            };
            process.writeStdoutChunks(`${JSON.stringify(message)}\n`);
          },
          request: (id, method, params) => {
            const message: JsonRpcRequestMessage = {
              jsonrpc: "2.0",
              id,
              method,
              ...(params !== undefined ? { params } : {}),
            };
            process.writeStdoutChunks(`${JSON.stringify(message)}\n`);
          },
          writeStdoutChunks: (...chunks) => {
            process.writeStdoutChunks(...chunks);
          },
        });
      }
    });

    return process;
  };
  return { spawn, processes };
}

describe("Codex app-server transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses the supported default app-server argv", async () => {
    let spawnArgs: string[] | undefined;
    const spawn: SpawnCodexProcess = (args) => {
      spawnArgs = args.args;
      return new MockCodexProcess();
    };

    const connection = new CodexAppServerConnection({
      cwd: "/tmp/worktree",
      env: {},
      spawnProcess: spawn,
      requestTimeoutMs: 50,
    });

    expect(spawnArgs).toEqual([...DEFAULT_CODEX_APP_SERVER_ARGS]);
    await connection.close();
  });

  it("buffers partial stdout lines and dispatches notifications", async () => {
    const notifications: JsonRpcNotificationMessage[] = [];
    const { spawn } = createMockSpawn(async (message, tools) => {
      if (message["method"] === "initialize") {
        tools.writeStdoutChunks(
          "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}",
          "\n{\"jsonrpc\":\"2.0\",\"method\":\"server/notice\",\"params\":{\"value\":1}}\n",
        );
      }
    });

    const connection = new CodexAppServerConnection({
      cwd: "/tmp/worktree",
      env: {},
      spawnProcess: spawn,
      requestTimeoutMs: 50,
    });
    connection.onNotification((message) => {
      notifications.push(message);
    });

    await expect(connection.request("initialize")).resolves.toEqual({ ok: true });
    expect(notifications).toEqual([
      {
        jsonrpc: "2.0",
        method: "server/notice",
        params: { value: 1 },
      },
    ]);

    await connection.close();
  });

  it("matches out-of-order responses to the originating request ids", async () => {
    let alphaId: number | undefined;
    const { spawn } = createMockSpawn(async (message, tools) => {
      if (message["method"] === "alpha") {
        alphaId = message["id"] as number;
        return;
      }
      if (message["method"] === "beta") {
        tools.respond(message["id"] as number, { value: "beta" });
        tools.respond(alphaId ?? -1, { value: "alpha" });
      }
    });

    const connection = new CodexAppServerConnection({
      cwd: "/tmp/worktree",
      env: {},
      spawnProcess: spawn,
      requestTimeoutMs: 50,
    });

    const [alpha, beta] = await Promise.all([
      connection.request<{ value: string }>("alpha"),
      connection.request<{ value: string }>("beta"),
    ]);

    expect(alpha).toEqual({ value: "alpha" });
    expect(beta).toEqual({ value: "beta" });

    await connection.close();
  });

  it("times out pending requests when the server never responds", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "codex-app-server-timeout-"));
    const { spawn, processes } = createMockSpawn(async () => {});
    const connection = new CodexAppServerConnection({
      cwd: "/tmp/worktree",
      env: {},
      runDir,
      spawnProcess: spawn,
      requestTimeoutMs: 10,
    });

    processes[0]!.stderr.write("recent stderr");

    try {
      await expect(connection.request("initialize")).rejects.toThrow(
        `stderr log=${join(runDir, "backend-stderr.log")}`,
      );
      await expect(connection.request("initialize")).rejects.toThrow(/stderr \(recent\)=recent stderr/);
      await connection.close();
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it("flushes stderr to disk and truncates the in-memory buffer", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "codex-app-server-flush-"));
    const process = new MockCodexProcess();
    const connection = new CodexAppServerConnection({
      cwd: "/tmp/worktree",
      env: {},
      runDir,
      spawnProcess: () => process,
      requestTimeoutMs: 50,
    });

    const stderrChunk = "x".repeat(1024 * 1024);
    process.stderr.write(stderrChunk);
    await waitFor(() => connection.getStderrSnapshot() === stderrChunk.length);

    try {
      const logPath = await connection.flushStderrToDisk();
      expect(logPath).toBe(join(runDir, "backend-stderr.log"));
      await expect(readFile(logPath!, "utf8")).resolves.toBe(stderrChunk);
      // Snapshot is an absolute byte-offset since connection start — after a
      // flush it stays monotonic (= total bytes ever observed), even though
      // the in-memory buffer has been reclaimed.
      expect(connection.getStderrSnapshot()).toBe(stderrChunk.length);
      // The in-memory buffer should be empty now; `readStderrSince(0)` maps
      // to `Math.max(0, 0 - droppedBytes) = 0` into an empty buffer.
      expect(connection.readStderrSince(0)).toBe("");
      await connection.close();
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it("preserves turn-scoped stderr readability across mid-turn flushes", async () => {
    // Regression for the Greptile P1 on POL-1129: a turn captures a snapshot
    // offset at turn-start, stderr arrives, a periodic flush truncates the
    // buffer mid-turn, more stderr arrives, turn-end calls readStderrSince(
    // snapshot). Under broken semantics that returns "" silently. Under
    // absolute-offset semantics it returns the post-flush bytes (non-empty),
    // and the flushed portion is available on disk.
    const runDir = await mkdtemp(join(tmpdir(), "codex-app-server-turn-stderr-"));
    const process = new MockCodexProcess();
    const connection = new CodexAppServerConnection({
      cwd: "/tmp/worktree",
      env: {},
      runDir,
      spawnProcess: () => process,
    });

    try {
      // Turn start — capture absolute snapshot offset
      const turnStart = connection.getStderrSnapshot();

      // Pre-flush stderr (goes to disk on flush)
      const preFlush = "pre-flush-line\n".repeat(100);
      process.stderr.write(preFlush);
      await waitFor(() => connection.getStderrSnapshot() === turnStart + preFlush.length);

      // Mid-turn flush truncates the in-memory buffer
      await connection.flushStderrToDisk();

      // Post-flush stderr (still in memory)
      const postFlush = "post-flush-line\n".repeat(50);
      process.stderr.write(postFlush);
      await waitFor(
        () => connection.getStderrSnapshot() === turnStart + preFlush.length + postFlush.length,
      );

      // Turn-end reader asks for "everything since turn-start"
      const readAtTurnEnd = connection.readStderrSince(turnStart);
      // Old buggy behavior would return "" (silent drop). Fixed behavior
      // returns at minimum the post-flush bytes.
      expect(readAtTurnEnd.length).toBeGreaterThan(0);
      expect(readAtTurnEnd).toBe(postFlush);

      // The flushed portion is on disk for full-fidelity recovery
      const logPath = join(runDir, "backend-stderr.log");
      await expect(readFile(logPath, "utf8")).resolves.toBe(preFlush);

      await connection.close();
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it("periodically flushes stderr while the connection is alive and stops after close", async () => {
    vi.useFakeTimers();
    const runDir = await mkdtemp(join(tmpdir(), "codex-app-server-periodic-flush-"));
    const connection = new CodexAppServerConnection({
      cwd: "/tmp/worktree",
      env: {},
      runDir,
      spawnProcess: () => new MockCodexProcess(),
      requestTimeoutMs: 50,
    });
    const flushSpy = vi
      .spyOn(connection, "flushStderrToDisk")
      .mockResolvedValue(join(runDir, "backend-stderr.log"));

    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(flushSpy).toHaveBeenCalledTimes(1);

      await connection.close();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(flushSpy).toHaveBeenCalledTimes(1);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it("routes server-initiated requests through the request handler", async () => {
    const { spawn, processes } = createMockSpawn(async () => {});
    const connection = new CodexAppServerConnection({
      cwd: "/tmp/worktree",
      env: {},
      spawnProcess: spawn,
      requestTimeoutMs: 50,
    });
    connection.setRequestHandler(async (message) => {
      expect(message.method).toBe("item/commandExecution/requestApproval");
      return { result: { decision: "decline" } };
    });

    const process = processes[0]!;
    process.writeStdoutChunks(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 88,
        method: "item/commandExecution/requestApproval",
        params: { command: ["touch", "x"] },
      })}\n`,
    );
    await waitFor(() => process.writtenMessages.some((message) => message["id"] === 88));

    expect(process.writtenMessages.find((message) => message["id"] === 88)).toEqual({
      jsonrpc: "2.0",
      id: 88,
      result: { decision: "decline" },
    });

    await connection.close();
  });

  it("fails on malformed stdout lines", async () => {
    const spawn: SpawnCodexProcess = () => {
      const process = new MockCodexProcess();
      queueMicrotask(() => {
        process.writeStdoutChunks("not-json\n");
      });
      return process;
    };
    const connection = new CodexAppServerConnection({
      cwd: "/tmp/worktree",
      env: {},
      spawnProcess: spawn,
      requestTimeoutMs: 50,
    });

    await expect(connection.request("initialize")).rejects.toThrow(/malformed app-server stdout/i);
  });

  it("rejects pending requests when stdin fails with EPIPE", async () => {
    const connection = new CodexAppServerConnection({
      cwd: "/tmp/worktree",
      env: {},
      spawnProcess: () => new FailingStdinProcess(),
      requestTimeoutMs: 50,
    });

    await expect(connection.request("initialize")).rejects.toThrow(/stdin failed/i);
  });
});
