import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_SELF_UPGRADE_COMMAND_CAPTURE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_SELF_UPGRADE_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_SELF_UPGRADE_PROJECTION_SETTLE_MS = 1_000;

export interface SelfUpgradeCommandCapture {
  text: string;
  captured_bytes: number;
  dropped_bytes: number;
  truncated: boolean;
}

export interface SelfUpgradeStreamingExecResult {
  stdout: string;
  stderr: string;
  stdout_capture: SelfUpgradeCommandCapture;
  stderr_capture: SelfUpgradeCommandCapture;
}

export type SelfUpgradeStreamingExecFailure = Error & {
  code?: number | string;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  stdout_capture?: SelfUpgradeCommandCapture;
  stderr_capture?: SelfUpgradeCommandCapture;
};

export interface SelfUpgradeStreamingExecOptions {
  encoding?: BufferEncoding;
  /**
   * Maximum diagnostic stderr bytes retained. Bytes beyond this cap are
   * dropped while the child and typed frame parser continue running. This cap
   * never consumes or truncates the sole final-stdout JSON allowance.
   */
  maxBuffer?: number;
  /** Maximum bytes retained for the authoritative final stdout JSON. */
  maxStdoutBytes?: number;
  cwd?: string;
  /**
   * Bytes written to the child's stdin, which is then closed. Absent means the
   * child gets an immediately-closed stdin: a remote command that reads stdin
   * must never block on a pipe nobody is going to write to.
   */
  stdin?: string;
  onStderrLine?: (line: string) => void;
  onStderrLineError?: (error: unknown) => void;
  maxStderrLineBytes?: number;
}

export type SelfUpgradeStreamingExec = (
  file: string,
  args: readonly string[],
  options?: SelfUpgradeStreamingExecOptions,
) => Promise<SelfUpgradeStreamingExecResult>;

interface CaptureState {
  chunks: Buffer[];
  capturedBytes: number;
  droppedBytes: number;
}

function captureChunk(state: CaptureState, chunk: Buffer, budget: { remaining: number }): void {
  const acceptedBytes = Math.min(chunk.byteLength, Math.max(0, budget.remaining));
  if (acceptedBytes > 0) {
    state.chunks.push(chunk.subarray(0, acceptedBytes));
    state.capturedBytes += acceptedBytes;
    budget.remaining -= acceptedBytes;
  }
  state.droppedBytes += chunk.byteLength - acceptedBytes;
}

function finishCapture(state: CaptureState, encoding: BufferEncoding): SelfUpgradeCommandCapture {
  return {
    text: Buffer.concat(state.chunks, state.capturedBytes).toString(encoding),
    captured_bytes: state.capturedBytes,
    dropped_bytes: state.droppedBytes,
    truncated: state.droppedBytes > 0,
  };
}

/**
 * Incrementally reassembles UTF-8 stderr lines without giving an opaque,
 * unterminated line unbounded memory. Oversized lines are ignored until their
 * next newline; later typed frames remain observable.
 */
class BoundedLineDecoder {
  private readonly decoder: StringDecoder;
  private readonly maxLineBytes: number;
  private readonly consume: (line: string) => void;
  private pending = "";
  private pendingBytes = 0;
  private discarding = false;

  constructor(
    encoding: BufferEncoding,
    maxLineBytes: number,
    consume: (line: string) => void,
  ) {
    this.decoder = new StringDecoder(encoding);
    this.maxLineBytes = maxLineBytes;
    this.consume = consume;
  }

  push(chunk: Buffer): void {
    this.consumeText(this.decoder.write(chunk));
  }

  end(): void {
    this.consumeText(this.decoder.end());
    if (!this.discarding && this.pending.length > 0) {
      this.consume(this.pending.replace(/\r$/u, ""));
    }
    this.pending = "";
    this.pendingBytes = 0;
    this.discarding = false;
  }

  private consumeText(text: string): void {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const terminal = newline < 0;
      const segment = text.slice(offset, terminal ? undefined : newline);
      if (!this.discarding) {
        const segmentBytes = Buffer.byteLength(segment, "utf8");
        if (this.pendingBytes + segmentBytes > this.maxLineBytes) {
          this.pending = "";
          this.pendingBytes = 0;
          this.discarding = true;
        } else {
          this.pending += segment;
          this.pendingBytes += segmentBytes;
        }
      }
      if (!terminal) {
        if (!this.discarding) {
          this.consume(this.pending.replace(/\r$/u, ""));
        }
        this.pending = "";
        this.pendingBytes = 0;
        this.discarding = false;
        offset = newline + 1;
      } else {
        break;
      }
    }
  }
}

/**
 * Spawn a command with separately bounded authoritative stdout and diagnostic
 * stderr capture. Capture exhaustion never terminates the child. Stderr frame
 * delivery consumes the raw byte stream independently of retained artifacts,
 * and stderr volume never consumes the final-stdout protocol allowance.
 */
export function execSelfUpgradeStreaming(
  file: string,
  args: readonly string[],
  options: SelfUpgradeStreamingExecOptions = {},
): Promise<SelfUpgradeStreamingExecResult> {
  return new Promise<SelfUpgradeStreamingExecResult>((resolve, reject) => {
    const encoding = options.encoding ?? "utf8";
    const stderrCaptureLimit = Math.max(0, options.maxBuffer ?? DEFAULT_SELF_UPGRADE_COMMAND_CAPTURE_BYTES);
    const stdoutCaptureLimit = Math.max(
      0,
      options.maxStdoutBytes ?? DEFAULT_SELF_UPGRADE_COMMAND_CAPTURE_BYTES,
    );
    const stdoutBudget = { remaining: stdoutCaptureLimit };
    const stderrBudget = { remaining: stderrCaptureLimit };
    const stdoutState: CaptureState = { chunks: [], capturedBytes: 0, droppedBytes: 0 };
    const stderrState: CaptureState = { chunks: [], capturedBytes: 0, droppedBytes: 0 };
    const child = spawn(file, [...args], options.cwd ? { cwd: options.cwd } : {});
    let settled = false;

    const consumeLine = (line: string): void => {
      try {
        options.onStderrLine?.(line);
      } catch (error) {
        try {
          options.onStderrLineError?.(error);
        } catch {
          // Diagnostic callbacks are projections too. A failed observer must
          // never escape the child stream's data event and abort the mutation.
        }
      }
    };
    const lineDecoder = options.onStderrLine
      ? new BoundedLineDecoder(
          encoding,
          Math.max(1, options.maxStderrLineBytes ?? DEFAULT_SELF_UPGRADE_FRAME_BYTES),
          consumeLine,
        )
      : undefined;

    const captures = (): Pick<
      SelfUpgradeStreamingExecResult,
      "stdout" | "stderr" | "stdout_capture" | "stderr_capture"
    > => {
      const stdoutCapture = finishCapture(stdoutState, encoding);
      const stderrCapture = finishCapture(stderrState, encoding);
      return {
        stdout: stdoutCapture.text,
        stderr: stderrCapture.text,
        stdout_capture: stdoutCapture,
        stderr_capture: stderrCapture,
      };
    };
    const fail = (error: SelfUpgradeStreamingExecFailure): void => {
      if (settled) {
        return;
      }
      settled = true;
      Object.assign(error, captures());
      reject(error);
    };

    // The child owns when it stops reading; a plan the child rejects early must
    // surface as the child's own verdict, not as an EPIPE thrown out of here.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.stdin ?? "");

    child.stdout?.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, encoding);
      captureChunk(stdoutState, chunk, stdoutBudget);
    });
    child.stderr?.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, encoding);
      captureChunk(stderrState, chunk, stderrBudget);
      lineDecoder?.push(chunk);
    });
    child.on("error", (error) => fail(error as SelfUpgradeStreamingExecFailure));
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      lineDecoder?.end();
      const captured = captures();
      if (code === 0) {
        settled = true;
        resolve(captured);
        return;
      }
      const error = new Error(
        `Command failed: ${file} ${args.join(" ")}${captured.stderr ? `\n${captured.stderr}` : ""}`,
      ) as SelfUpgradeStreamingExecFailure;
      if (code !== null) {
        error.code = code;
      }
      error.signal = signal;
      fail(error);
    });
  });
}

export interface FailOpenProjectionWriter {
  write: (chunk: string) => void;
  stop: () => Promise<void>;
}

export type FailOpenProjectionSettlement<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "timeout" };

/**
 * Bound a projection without cancelling or leaking a later rejection. The
 * owning mutation may continue after `timeout`; the underlying projection is
 * deliberately left to finish as non-authoritative evidence. Callers that can
 * acquire a resource after a timeout remain responsible for late cleanup.
 */
export async function settleFailOpenProjection<T>(
  project: () => Promise<T>,
  timeoutMs = DEFAULT_SELF_UPGRADE_PROJECTION_SETTLE_MS,
): Promise<FailOpenProjectionSettlement<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const projected = Promise.resolve().then(project).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  const timed = new Promise<{ status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), Math.max(0, timeoutMs));
  });
  const outcome = await Promise.race([projected, timed]);
  if (timer) {
    clearTimeout(timer);
  }
  return outcome;
}

interface ProjectionSignalHub {
  callbacks: Set<(reason: string) => void>;
  /**
   * At most one stopped operation remains attributable on a shared stream.
   * A later writer replaces it, so process.stderr never accumulates one
   * listener/closure per invocation.
   */
  retired?: (reason: string) => void;
  unavailableReason?: string;
}

const projectionSignalHubs = new WeakMap<Writable, ProjectionSignalHub>();

function projectionSignalHub(stream: Writable): ProjectionSignalHub {
  const existing = projectionSignalHubs.get(stream);
  if (existing) {
    return existing;
  }
  const hub: ProjectionSignalHub = { callbacks: new Set() };
  const notify = (reason: string): void => {
    hub.unavailableReason = hub.unavailableReason ?? reason;
    for (const callback of hub.callbacks) {
      callback(reason);
    }
    hub.retired?.(reason);
  };
  stream.on("error", (error: Error) => {
    notify(error.message || "projection stream emitted an error");
  });
  stream.on("close", () => {
    notify("projection stream closed");
  });
  projectionSignalHubs.set(stream, hub);
  return hub;
}

/**
 * Non-blocking projection writer for stderr/NDJSON. Synchronous throws,
 * callback errors, `error`/`close`, and backpressure all degrade observation;
 * none can throw into or await the owning mutation.
 */
export function createFailOpenProjectionWriter(
  stream: Writable,
  onUnavailable: (reason: string) => void = () => undefined,
  settleTimeoutMs = DEFAULT_SELF_UPGRADE_PROJECTION_SETTLE_MS,
): FailOpenProjectionWriter {
  let accepting = !stream.destroyed && !stream.writableEnded;
  let backpressured = false;
  let notifiedUnavailable = false;
  let notifiedBackpressure = false;
  let stopPromise: Promise<void> | undefined;
  const pendingWrites = new Set<symbol>();
  const settledWaiters = new Set<() => void>();

  const notifySettled = (): void => {
    if (pendingWrites.size !== 0) {
      return;
    }
    for (const resolve of settledWaiters) {
      resolve();
    }
    settledWaiters.clear();
  };
  const abandonPendingWrites = (): void => {
    pendingWrites.clear();
    notifySettled();
  };

  const notifyUnavailable = (reason: string): void => {
    if (notifiedUnavailable) {
      return;
    }
    notifiedUnavailable = true;
    try {
      onUnavailable(reason);
    } catch {
      // Reporting projection loss is itself best-effort.
    }
  };
  const onSignal = (reason: string): void => {
    accepting = false;
    notifyUnavailable(reason);
    abandonPendingWrites();
  };
  const onDrain = (): void => {
    backpressured = false;
  };
  const signalHub = projectionSignalHub(stream);
  // A new active writer becomes the sole attribution target. The previous
  // stopped writer was retained only for the otherwise-unattributable gap
  // between operations.
  delete signalHub.retired;
  signalHub.callbacks.add(onSignal);
  stream.on("drain", onDrain);
  if (signalHub.unavailableReason) {
    onSignal(signalHub.unavailableReason);
  }

  return {
    write(chunk: string): void {
      if (!accepting || backpressured) {
        return;
      }
      const pendingWrite = Symbol("projection-write");
      pendingWrites.add(pendingWrite);
      const complete = (error?: Error | null): void => {
        if (!pendingWrites.delete(pendingWrite)) {
          return;
        }
        if (error) {
          onSignal(error.message || "projection stream write callback failed");
        }
        notifySettled();
      };
      try {
        const writable = stream.write(chunk, "utf8", complete);
        if (!writable) {
          backpressured = true;
          if (!notifiedBackpressure) {
            notifiedBackpressure = true;
            notifyUnavailable("projection stream is backpressured; progress records are being dropped");
          }
        }
      } catch (error) {
        complete();
        accepting = false;
        notifyUnavailable(error instanceof Error ? error.message : String(error));
      }
    },
    stop(): Promise<void> {
      stopPromise ??= (async () => {
        accepting = false;
        if (pendingWrites.size > 0) {
          const outcome = await settleFailOpenProjection(
            () => new Promise<void>((resolve) => {
              settledWaiters.add(resolve);
              notifySettled();
            }),
            settleTimeoutMs,
          );
          if (outcome.status === "timeout") {
            notifyUnavailable(
              `projection stream did not settle within ${Math.max(0, settleTimeoutMs)}ms; pending output was dropped`,
            );
            abandonPendingWrites();
          }
        }
        stream.off("drain", onDrain);
        signalHub.callbacks.delete(onSignal);
        if (signalHub.callbacks.size === 0) {
          signalHub.retired = onSignal;
        }
        // The shared hub retains exactly one stopped writer attribution. Late
        // EPIPE/error/close signals therefore remain operation-observable with
        // no finite event-loop horizon and no per-invocation listener leak.
      })();
      return stopPromise;
    },
  };
}
