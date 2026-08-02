/**
 * Shared spawn implementation for backend adapters.
 *
 * Uses child_process.spawn with a generous maxBuffer (200MB) to prevent
 * silent process kills on verbose sessions. Unix children lead an isolated
 * process group so cancellation tears down the whole backend tree rather than
 * abandoning CLI descendants.
 */

import { createHash } from "node:crypto";
import { constants, accessSync } from "node:fs";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const MAX_BUFFER = 200 * 1024 * 1024; // 200 MB

function managedPathEntries(home: string | undefined): string[] {
  return [
    home ? `${home}/.agents/run` : undefined,
    home ? `${home}/.npm-global/bin` : undefined,
    home ? `${home}/.local/share/pnpm` : undefined,
    home ? `${home}/.local/bin` : undefined,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter((entry): entry is string => entry !== undefined);
}

export function buildManagedBackendPath(
  inheritedPath: string | undefined,
  home: string | undefined,
): string {
  const seen = new Set<string>();
  const entries = [
    ...managedPathEntries(home),
    ...(inheritedPath && inheritedPath.length > 0 ? inheritedPath.split(":") : []),
  ].filter((entry) => {
    if (entry.length === 0 || seen.has(entry)) {
      return false;
    }
    seen.add(entry);
    return true;
  });
  return entries.join(":");
}

/** Resolve a bare provider command before the child environment is assembled. */
export function resolveManagedBackendExecutable(
  command: string,
  inheritedPath: string | undefined,
  home: string | undefined,
): string | undefined {
  if (command.includes("/") || command.includes("\\")) {
    return command;
  }
  for (const directory of buildManagedBackendPath(inheritedPath, home).split(delimiter)) {
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the parent-owned provider path.
    }
  }
  return undefined;
}

function resolveSpawnEnv(
  env: Record<string, string | undefined> | undefined,
): NodeJS.ProcessEnv {
  const mergedEnv = { ...process.env, ...env } as NodeJS.ProcessEnv;
  // An explicit `undefined` in opts.env means "remove this key from the child
  // env". Without the delete, Node forwards the value as the literal string
  // "undefined", which silently re-enables whatever the caller meant to
  // suppress (e.g. an inherited ANTHROPIC_API_KEY the claude adapter strips
  // under POL-1139).
  if (env) {
    for (const key of Object.keys(env)) {
      if (env[key] === undefined) {
        delete mergedEnv[key];
      }
    }
  }
  if (env?.PATH !== undefined) {
    mergedEnv.PATH = env.PATH;
  } else {
    mergedEnv.PATH = buildManagedBackendPath(process.env.PATH, process.env.HOME);
  }
  return mergedEnv;
}

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the process was killed by a signal (e.g., "SIGTERM", "SIGKILL"). */
  signal?: string;
  /** Set when the spawn itself failed (e.g., buffer overflow, ENOENT). */
  spawn_error?: string;
  /** Narrow machine-readable reason for Calyx-initiated infrastructure stops. */
  reason?: "stalled_inactivity" | "cancelled";
  /** Bounded facts about stdout observed from the child. Never contains raw output. */
  stdout_observation?: {
    bytes_observed: number;
    sha256: string;
    complete: boolean;
  };
}

export interface SpawnOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  close_stdin?: boolean;
  onActivity?: (activity: {
    source: "stdout" | "stderr";
    bytes: number;
    timestamp: string;
  }) => void;
  /** Incremental stdout consumer for structured backend protocols. */
  onStdoutChunk?: (chunk: Buffer) => void;
  /** Disable retaining stdout after an incremental consumer projects it. */
  capture_stdout?: boolean;
  /** Stop the process tree as soon as observed stdout exceeds this byte limit. */
  max_stdout_bytes?: number;
  /** Resolve a bare provider command against parent-owned PATH before child env assembly. */
  resolve_command_before_env?: boolean;
  hard_timeout_ms?: number;
  stop_grace_ms?: number;
  /** Run-scoped cancellation; resolution waits for the owned process tree to exit. */
  signal?: AbortSignal;
}

export type SpawnFunction = (
  cmd: string,
  args: string[],
  opts: SpawnOptions,
) => Promise<SpawnResult>;

export async function defaultSpawn(
  cmd: string,
  args: string[],
  opts: SpawnOptions,
): Promise<SpawnResult> {
  if (
    opts.max_stdout_bytes !== undefined
    && (!Number.isInteger(opts.max_stdout_bytes) || opts.max_stdout_bytes <= 0)
  ) {
    throw new Error("max_stdout_bytes must be a positive integer.");
  }
  if (opts.signal?.aborted) {
    return {
      code: 143,
      stdout: "",
      stderr: "",
      signal: "SIGTERM",
      reason: "cancelled",
    };
  }

  const resolvedCommand = opts.resolve_command_before_env
    ? resolveManagedBackendExecutable(cmd, process.env.PATH, process.env.HOME)
    : cmd;
  if (resolvedCommand === undefined) {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      spawn_error: `executable not found on runner-managed PATH: ${cmd}`,
      stdout_observation: {
        bytes_observed: 0,
        sha256: createHash("sha256").digest("hex"),
        complete: false,
      },
    };
  }

  const { spawn } = await import("node:child_process");
  if (opts.signal?.aborted) {
    return {
      code: 143,
      stdout: "",
      stderr: "",
      signal: "SIGTERM",
      reason: "cancelled",
    };
  }
  return await new Promise<SpawnResult>((resolve) => {
    let inactivityTimer: NodeJS.Timeout | undefined;
    let stopReason: "stalled_inactivity" | "cancelled" | "max_buffer" | "stdout_limit" | undefined;
    let callbackResult: SpawnResult | undefined;
    let teardownRequired = false;
    let teardownComplete = false;
    let teardownConfirmed: boolean | undefined;
    let teardownPromise: Promise<boolean> | undefined;
    let teardownFinalizerAttached = false;
    let settled = false;
    let spawnFailed = false;
    const detachedProcessGroup = process.platform !== "win32";
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutHash = createHash("sha256");

    const clearInactivityTimer = (): void => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = undefined;
      }
    };
    const finishIfReady = (): void => {
      if (settled || !callbackResult || (teardownRequired && !teardownComplete)) return;
      if (teardownConfirmed === false) {
        callbackResult = {
          ...callbackResult,
          code: 1,
          spawn_error: "process tree remained alive after SIGKILL",
        };
      } else if (stopReason === "cancelled" && callbackResult.reason === undefined) {
        // Cancellation may race a leader `close` while group stragglers are
        // still being reaped. Preserve the late cancellation in the result.
        callbackResult = { ...callbackResult, reason: "cancelled" };
      }
      settled = true;
      clearInactivityTimer();
      opts.signal?.removeEventListener("abort", requestCancellation);
      resolve(callbackResult);
    };

    const child = spawn(
      resolvedCommand,
      args,
      {
        cwd: opts.cwd,
        env: resolveSpawnEnv(opts.env),
        detached: detachedProcessGroup,
      },
    );

    const processGroupAlive = (): boolean => {
      if (!child.pid) {
        // ENOENT and other pre-spawn failures never acquire a pid. Once the
        // close event reports that failure there is no process tree to
        // await, even though Node leaves exitCode/signalCode null.
        return callbackResult === undefined
          && child.exitCode === null
          && child.signalCode === null;
      }
      try {
        process.kill(detachedProcessGroup ? -child.pid : child.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };

    const signalProcessTree = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        process.kill(detachedProcessGroup ? -child.pid : child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          try {
            child.kill(signal);
          } catch {
            // A concurrently exited process already satisfies teardown.
          }
        }
      }
    };

    const waitForProcessTreeExit = async (timeoutMs?: number): Promise<boolean> => {
      const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
      while (processGroupAlive()) {
        if (deadline !== undefined && Date.now() >= deadline) return false;
        await delay(deadline === undefined
          ? 20
          : Math.min(20, Math.max(1, deadline - Date.now())));
      }
      return true;
    };

    const beginProcessTreeTeardown = (force: boolean): void => {
      teardownRequired = true;
      teardownPromise ??= (async () => {
        if (!force) {
          signalProcessTree("SIGTERM");
          const exitedGracefully = await waitForProcessTreeExit(opts.stop_grace_ms ?? 5_000);
          if (exitedGracefully) return true;
        }
        signalProcessTree("SIGKILL");
        // Bound the post-SIGKILL confirmation too. A process in an
        // uninterruptible kernel state must fail closed instead of hanging the
        // daemon forever or being reported as a successful teardown.
        return waitForProcessTreeExit(opts.stop_grace_ms ?? 5_000);
      })();
      if (teardownFinalizerAttached) return;
      teardownFinalizerAttached = true;
      void teardownPromise.then((confirmed) => {
        teardownConfirmed = confirmed;
        teardownComplete = true;
        finishIfReady();
      });
    };

    const requestStop = (
      reason: "stalled_inactivity" | "cancelled" | "max_buffer" | "stdout_limit",
    ): void => {
      if (stopReason) return;
      stopReason = reason;
      clearInactivityTimer();
      beginProcessTreeTeardown(reason === "max_buffer" || reason === "stdout_limit");
    };

    function requestCancellation(): void {
      requestStop("cancelled");
    }

    const recordOutput = (source: "stdout" | "stderr", chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const nextBytes = (source === "stdout" ? stdoutBytes : stderrBytes) + bytes.byteLength;
      if (source === "stdout") {
        stdoutBytes = nextBytes;
        stdoutHash.update(bytes);
        if (opts.max_stdout_bytes !== undefined && nextBytes > opts.max_stdout_bytes) {
          requestStop("stdout_limit");
          return;
        }
      }
      if (nextBytes > MAX_BUFFER && (source === "stderr" || opts.capture_stdout !== false)) {
        requestStop("max_buffer");
        return;
      }
      if (source === "stdout") {
        opts.onStdoutChunk?.(bytes);
        if (opts.capture_stdout !== false) {
          stdoutChunks.push(bytes);
        }
      } else {
        stderrBytes = nextBytes;
        stderrChunks.push(bytes);
      }
      opts.onActivity?.({
        source,
        bytes: bytes.byteLength,
        timestamp: new Date().toISOString(),
      });
      armInactivityTimer();
    };

    child.once("error", () => {
      spawnFailed = true;
    });
    child.once("close", (code, signal) => {
      clearInactivityTimer();
      const exitCode = typeof code === "number"
        ? code
        : signal === "SIGKILL"
          ? 137
          : signal === "SIGTERM"
            ? 143
            : signal === "SIGINT"
              ? 130
              : 1;
      const publicReason = stopReason === "cancelled" || stopReason === "stalled_inactivity"
        ? stopReason
        : undefined;
      callbackResult = {
        code: spawnFailed ? 1 : exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        ...(signal ? { signal } : {}),
        ...(publicReason ? { reason: publicReason } : {}),
        stdout_observation: {
          // Includes every stdout chunk observed by the parent, including the
          // chunk that first crossed max_stdout_bytes.
          bytes_observed: stdoutBytes,
          sha256: stdoutHash.digest("hex"),
          complete: stopReason === undefined,
        },
        ...(stopReason === "stalled_inactivity"
          ? { spawn_error: "stalled_inactivity" }
          : stopReason === "stdout_limit"
            ? {
                spawn_error: `stdout exceeded max_stdout_bytes=${opts.max_stdout_bytes} (observed ${stdoutBytes} bytes)`,
              }
          : stopReason === "max_buffer"
            ? { spawn_error: "maxBuffer exceeded" }
            : {}),
      };
      // A backend leader exiting does not prove its owned Unix process group is
      // gone: daemonized or stdio-detached descendants can outlive `close`.
      // Reap those stragglers before reporting the spawn complete. Windows has
      // no negative-PID group signalling, so it retains direct-child semantics.
      if (!stopReason && detachedProcessGroup && processGroupAlive()) {
        beginProcessTreeTeardown(false);
      }
      finishIfReady();
    });

    const armInactivityTimer = (): void => {
      if (opts.hard_timeout_ms === undefined) {
        return;
      }
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
      }
      inactivityTimer = setTimeout(() => {
        requestStop("stalled_inactivity");
      }, opts.hard_timeout_ms);
      inactivityTimer.unref?.();
    };

    child.stdout?.on("data", (chunk: Buffer | string) => recordOutput("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => recordOutput("stderr", chunk));
    armInactivityTimer();

    if (opts.signal) {
      opts.signal.addEventListener("abort", requestCancellation, { once: true });
      if (opts.signal.aborted) requestCancellation();
    }

    if (opts.close_stdin) {
      child.stdin?.once("error", () => {
        // Stdin can already be closed if the child exits immediately.
      });
      child.stdin?.end();
    }
  });
}
