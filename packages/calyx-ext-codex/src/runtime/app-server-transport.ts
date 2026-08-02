import { spawn as spawnChild } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { resolveCodexCommand } from "./app-server-command.js";

export interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponseMessage {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: JsonRpcErrorPayload;
}

export interface JsonRpcRequestMessage {
  jsonrpc?: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotificationMessage {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcRequestResolution {
  result?: unknown;
  error?: JsonRpcErrorPayload;
}

export interface SpawnedCodexProcess {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type SpawnCodexProcess = (args: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => SpawnedCodexProcess;

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const CLOSE_GRACE_MS = 1_000;
const PERIODIC_STDERR_FLUSH_INTERVAL_MS = 30_000;
export const DEFAULT_CODEX_APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const;

function defaultSpawnProcess(args: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): SpawnedCodexProcess {
  return spawnChild(args.command, args.args, {
    cwd: args.cwd,
    env: args.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isResponseMessage(message: Record<string, unknown>): boolean {
  return typeof message.id === "number"
    && (Object.prototype.hasOwnProperty.call(message, "result")
      || Object.prototype.hasOwnProperty.call(message, "error"));
}

function isRequestMessage(message: Record<string, unknown>): boolean {
  return typeof message.id === "number" && typeof message.method === "string";
}

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export interface CodexAppServerConnectionOptions {
  command?: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  runDir?: string;
  spawnProcess?: SpawnCodexProcess;
  requestTimeoutMs?: number;
}

export class CodexAppServerConnection {
  private readonly child: SpawnedCodexProcess;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<(message: JsonRpcNotificationMessage) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private requestHandler: ((message: JsonRpcRequestMessage) => Promise<JsonRpcRequestResolution>) | undefined;
  private readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly stderrLogPath: string | undefined;
  private periodicFlushTimer: NodeJS.Timeout | undefined;
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private flushedStderrLength = 0;
  // Monotonic count of stderr bytes truncated out of `stderrBuffer` via
  // `flushStderrToDisk()`. Callers of `getStderrSnapshot()` receive an
  // absolute byte offset (since connection start); `readStderrSince()` maps
  // that absolute offset back into the current `stderrBuffer` by subtracting
  // this counter. This keeps turn-scoped stderr readable across mid-turn
  // periodic flushes. Bytes that have been flushed + dropped are no longer
  // in memory — consumers should reach for `<run-dir>/backend-stderr.log` if
  // they need the full history.
  private stderrDroppedBytes = 0;
  private closed = false;
  private fatalError: Error | undefined;
  private closeNotified = false;

  constructor(options: CodexAppServerConnectionOptions) {
    const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
    this.child = spawnProcess({
      command: options.command ?? resolveCodexCommand(options.env),
      args: options.args ?? [...DEFAULT_CODEX_APP_SERVER_ARGS],
      cwd: options.cwd,
      env: options.env,
    });
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.stderrLogPath = options.runDir ? path.join(options.runDir, "backend-stderr.log") : undefined;
    this.periodicFlushTimer = setInterval(() => {
      void this.flushStderrToDisk().catch(() => undefined);
    }, PERIODIC_STDERR_FLUSH_INTERVAL_MS);
    this.periodicFlushTimer.unref?.();
    this.exitPromise = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string | Buffer) => {
      this.handleStdoutChunk(chunk.toString());
    });
    this.child.stderr.on("data", (chunk: string | Buffer) => {
      this.stderrBuffer += chunk.toString();
    });
    this.child.stdin.on("error", (error) => {
      if (this.closed) {
        return;
      }
      this.fatalError = new Error(`Codex app-server stdin failed: ${error.message}`);
      this.closed = true;
      this.notifyClose(this.fatalError);
      this.fail(this.fatalError);
    });
    this.child.on("error", (error) => {
      this.fatalError = new Error(`Failed to spawn codex app-server: ${error.message}`);
      this.fail(this.fatalError);
    });
    this.child.on("exit", (code, signal) => {
      const reason = this.fatalError
        ?? new Error(
          `Codex app-server exited before completing all requests (code=${String(code)}, signal=${String(signal)}).`,
        );
      this.notifyClose(reason);
      this.fail(reason);
    });
  }

  onNotification(listener: (message: JsonRpcNotificationMessage) => void): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  setRequestHandler(handler: (message: JsonRpcRequestMessage) => Promise<JsonRpcRequestResolution>): void {
    this.requestHandler = handler;
  }

  getStderrSnapshot(): number {
    // Absolute byte offset since connection start. Survives mid-turn
    // truncations by `flushStderrToDisk()`.
    return this.stderrDroppedBytes + this.stderrBuffer.length;
  }

  readStderrSince(offset: number): string {
    // Map absolute offset back into the current buffer. If the caller's
    // offset has been dropped by a flush, clamp to buffer start — they get
    // best-effort current-buffer contents rather than silent empty string.
    // Full history is in `<run-dir>/backend-stderr.log`.
    const localOffset = Math.max(0, offset - this.stderrDroppedBytes);
    return this.stderrBuffer.slice(localOffset);
  }

  async flushStderrToDisk(): Promise<string | undefined> {
    if (!this.stderrLogPath) {
      return undefined;
    }
    const flushStart = this.flushedStderrLength;
    const nextChunk = this.stderrBuffer.slice(flushStart);
    if (nextChunk.length === 0) {
      return this.stderrLogPath;
    }
    await mkdir(path.dirname(this.stderrLogPath), { recursive: true });
    await appendFile(this.stderrLogPath, nextChunk, "utf8");
    const flushEnd = flushStart + nextChunk.length;
    this.stderrDroppedBytes += flushEnd;
    this.stderrBuffer = this.stderrBuffer.slice(flushEnd);
    this.flushedStderrLength = 0;
    return this.stderrLogPath;
  }

  async request<TResult = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<TResult> {
    this.assertOpen();
    const id = this.nextId++;
    const message: JsonRpcRequestMessage = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const promise = new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timed out waiting for Codex app-server response to ${method}. stderr (recent)=${this.stderrBuffer} | stderr log=${this.stderrLogPath ?? "(none)"}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.writeMessage(message);
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.assertOpen();
    const message: JsonRpcNotificationMessage = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.writeMessage(message);
  }

  async close(): Promise<void> {
    if (this.periodicFlushTimer) {
      clearInterval(this.periodicFlushTimer);
      this.periodicFlushTimer = undefined;
    }
    if (this.closed) {
      await this.exitPromise.catch(() => undefined);
      return;
    }
    this.closed = true;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    const timeout = setTimeout(() => {
      this.child.kill("SIGKILL");
    }, CLOSE_GRACE_MS);
    try {
      await this.exitPromise;
    } finally {
      clearTimeout(timeout);
    }
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length === 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        this.dispatchMessage(parsed);
      } catch (error) {
        this.fatalError = new Error(`Malformed app-server stdout: ${line} (${toErrorMessage(error)})`);
        void this.close();
        this.fail(this.fatalError);
        return;
      }
    }
  }

  private dispatchMessage(message: Record<string, unknown>): void {
    if (isResponseMessage(message)) {
      const typed = message as unknown as JsonRpcResponseMessage;
      const pending = this.pending.get(typed.id);
      if (!pending) {
        return;
      }
      this.pending.delete(typed.id);
      clearTimeout(pending.timeout);
      if (typed.error) {
        pending.reject(new Error(typed.error.message));
        return;
      }
      pending.resolve(typed.result);
      return;
    }

    if (isRequestMessage(message)) {
      void this.handleServerRequest(message as unknown as JsonRpcRequestMessage);
      return;
    }

    if (typeof message.method === "string") {
      for (const listener of this.notificationListeners) {
        listener(message as unknown as JsonRpcNotificationMessage);
      }
    }
  }

  private async handleServerRequest(message: JsonRpcRequestMessage): Promise<void> {
    if (!this.requestHandler) {
      this.writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `Unhandled server request ${message.method}`,
        },
      });
      return;
    }
    try {
      const resolution = await this.requestHandler(message);
      const response: JsonRpcResponseMessage = {
        jsonrpc: "2.0",
        id: message.id,
        ...(resolution.error ? { error: resolution.error } : { result: resolution.result ?? null }),
      };
      this.writeMessage(response);
    } catch (error) {
      this.writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: toErrorMessage(error),
        },
      });
    }
  }

  private writeMessage(message: JsonRpcRequestMessage | JsonRpcNotificationMessage | JsonRpcResponseMessage): void {
    const payload = `${JSON.stringify(message)}\n`;
    try {
      this.child.stdin.write(payload, "utf8");
    } catch (error) {
      this.fatalError = new Error(`Failed to write to codex app-server stdin: ${toErrorMessage(error)}`);
      this.closed = true;
      this.notifyClose(this.fatalError);
      this.fail(this.fatalError);
      throw this.fatalError;
    }
  }

  private assertOpen(): void {
    if (this.fatalError) {
      throw this.fatalError;
    }
    if (this.closed) {
      throw new Error("Codex app-server connection is already closed.");
    }
  }

  private fail(error: Error): void {
    this.fatalError = error;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private notifyClose(error: Error): void {
    if (this.closeNotified) {
      return;
    }
    this.closeNotified = true;
    for (const listener of this.closeListeners) {
      listener(error);
    }
  }
}
