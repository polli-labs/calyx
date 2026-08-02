import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_BACKEND_REASONING_EFFORTS,
  createSpawnCompatibilitySession,
  defaultSpawn as sharedDefaultSpawn,
  isCodexBackendReasoningEffort,
  type AdapterResult,
  type AdapterSpawnOptions,
  type AdapterStartOptions,
  type BackendAdapter,
  type SessionDiscoveryFs,
  type SessionInfo,
  type SessionParserFs,
  type SpawnFunction,
  type SpawnOptions,
  type ProviderConstraint,
} from "@polli-labs/calyx-runner";
import type { BackendEvent } from "@polli-labs/calyx-runner";
import { resolveCodexCommandOrDefault } from "./app-server-command.js";
import { discoverCodexSession } from "./session-discovery.js";
import {
  parseCodexProviderConstraint,
  parseCodexTerminalMessage,
} from "./session-parser.js";

type CodexSandboxMode = "read-only" | "danger-full-access";

function resolveSandboxMode(opts: AdapterSpawnOptions): CodexSandboxMode | undefined {
  const bypass = opts.backend_options?.dangerously_skip_permissions;
  if (bypass !== undefined && typeof bypass !== "boolean") {
    throw new Error("codex exec backend_options.dangerously_skip_permissions must be a boolean.");
  }
  const legacySandboxClass = opts.backend_options?.["sandbox_class"];
  if (legacySandboxClass !== undefined) {
    throw new Error(
      "codex exec does not support backend_options.sandbox_class. " +
        "Use backend_options.sandbox=read-only or danger-full-access.",
    );
  }

  const explicit = opts.backend_options?.["sandbox"];
  if (explicit !== undefined && explicit !== "read-only" && explicit !== "danger-full-access") {
    throw new Error(
      `codex exec backend_options.sandbox must be read-only or danger-full-access; received ${JSON.stringify(explicit)}.`,
    );
  }
  if (bypass && explicit === "read-only") {
    throw new Error(
      "codex exec backend_options.sandbox=read-only conflicts with dangerously_skip_permissions=true.",
    );
  }
  if (bypass) {
    return "danger-full-access";
  }
  return explicit;
}

async function writeModelInstructionsFile(text: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "calyx-codex-instructions-"));
  const path = join(dir, "model-instructions.md");
  await writeFile(path, text, "utf8");
  return {
    path,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function writeOutputSchemaFile(schema: unknown): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "calyx-codex-output-schema-"));
  const path = join(dir, "output-schema.json");
  await writeFile(path, JSON.stringify(schema), { encoding: "utf8", mode: 0o600 });
  return {
    path,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function appendCodexInstructionConfig(
  args: string[],
  opts: AdapterSpawnOptions,
): Promise<() => Promise<void>> {
  const cleanups: Array<() => Promise<void>> = [];
  if (opts.system_prompt) {
    const instructions = await writeModelInstructionsFile(opts.system_prompt);
    cleanups.push(instructions.cleanup);
    args.push("-c", `model_instructions_file=${JSON.stringify(instructions.path)}`);
  }
  if (opts.append_system_prompt) {
    args.push("-c", `developer_instructions=${JSON.stringify(opts.append_system_prompt)}`);
  }
  return async () => {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
  };
}

export interface LegacyExecCodexAdapterOptions {
  spawn?: SpawnFunction;
  sessionDiscoveryFs?: SessionDiscoveryFs;
  sessionParserFs?: SessionParserFs;
}

export class LegacyExecCodexAdapter implements BackendAdapter {
  readonly name = "codex";
  readonly capabilities = {
    streaming: false,
    turnControl: false,
    resumeSession: true,
    forkSession: false,
    approvals: "none",
  } as const;
  private readonly spawnFn: NonNullable<LegacyExecCodexAdapterOptions["spawn"]>;
  private readonly discoveryFs: SessionDiscoveryFs | undefined;
  private readonly parserFs: SessionParserFs | undefined;
  private activeRuns = new Map<string, {
    aborted: boolean;
    abortController: AbortController;
    settled: Promise<void>;
    settle: () => void;
  }>();

  constructor(opts?: LegacyExecCodexAdapterOptions) {
    this.spawnFn = opts?.spawn ?? sharedDefaultSpawn;
    this.discoveryFs = opts?.sessionDiscoveryFs;
    this.parserFs = opts?.sessionParserFs;
  }

  async startSession(opts: AdapterStartOptions) {
    return createSpawnCompatibilitySession(this, opts);
  }

  async spawn(opts: AdapterSpawnOptions): Promise<AdapterResult> {
    const sandbox = resolveSandboxMode(opts);
    const args = ["exec"];
    if (opts.output_capture && sandbox !== "read-only") {
      throw new Error("codex exec output_capture requires backend_options.sandbox=read-only.");
    }
    if (opts.output_capture && opts.resume_session_id) {
      throw new Error("codex exec output_capture is ephemeral and cannot resume a backend session.");
    }
    if (opts.output_capture && opts.backend_options?.env !== undefined) {
      throw new Error(
        "codex exec output_capture does not accept backend_options.env; the capture process environment is runner-owned.",
      );
    }
    if (sandbox !== undefined && !opts.backend_options?.dangerously_skip_permissions) {
      args.push("--sandbox", sandbox);
    }
    if (opts.resume_session_id) {
      args.push("resume");
    }
    if (opts.backend_options?.model) {
      throw new Error(
        `codex exec does not yet support backend_options.model=${JSON.stringify(opts.backend_options.model)} through Calyx. ` +
          "Use --backend claude for explicit Calyx model forwarding.",
      );
    }
    if (opts.backend_options?.reasoning_effort) {
      const effort = opts.backend_options.reasoning_effort;
      if (!isCodexBackendReasoningEffort(effort)) {
        throw new Error(
          `codex exec does not support backend_options.reasoning_effort=${JSON.stringify(effort)}. ` +
          `Valid Codex values: ${CODEX_BACKEND_REASONING_EFFORTS.join(", ")}.`,
        );
      }
    }
    if (opts.backend_options?.max_turns !== undefined) {
      throw new Error(
        "codex exec does not support backend_options.max_turns. " +
          "Use backend_options.max_threads for Codex sub-agent concurrency.",
      );
    }
    if (opts.backend_options?.max_threads !== undefined) {
      const maxThreads = opts.backend_options.max_threads;
      if (!Number.isInteger(maxThreads) || maxThreads <= 0) {
        throw new Error("codex exec backend_options.max_threads must be a positive integer.");
      }
    }
    const start = Date.now();
    const events: BackendEvent[] = [];
    let settle = (): void => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const runState = {
      aborted: false,
      abortController: new AbortController(),
      settled,
      settle,
    };
    this.activeRuns.set(opts.run_id, runState);
    let cleanupInstructionFiles: () => Promise<void> = async () => {};
    let cleanupOutputSchema: () => Promise<void> = async () => {};

    try {
      cleanupInstructionFiles = await appendCodexInstructionConfig(args, opts);
      if (opts.output_capture) {
        const outputSchema = await writeOutputSchemaFile(opts.output_capture.schema);
        cleanupOutputSchema = outputSchema.cleanup;
        args.push(
          "--ignore-user-config",
          "--ignore-rules",
          "-c",
          "project_doc_max_bytes=0",
          "--ephemeral",
          "--output-schema",
          outputSchema.path,
        );
      }
      if (opts.backend_options?.reasoning_effort) {
        args.push("-c", `model_reasoning_effort=${JSON.stringify(opts.backend_options.reasoning_effort)}`);
      }
      if (opts.backend_options?.max_threads !== undefined) {
        args.push("-c", `agents.max_threads=${opts.backend_options.max_threads}`);
      }
      if (opts.resume_session_id) {
        args.push(opts.resume_session_id, opts.prompt);
      } else {
        args.push(opts.prompt);
      }
      if (opts.backend_options?.dangerously_skip_permissions) {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      }

      if (runState.aborted) {
        events.push({ event: "cancelled" });
        return {
          exit_code: 143,
          signal: "SIGTERM",
          stderr: "",
          events,
          duration_ms: Date.now() - start,
        };
      }

      opts.onEvent?.({
        timestamp: new Date().toISOString(),
        run_id: opts.run_id,
        event: "backend_spawned",
        message: `Spawning codex CLI in ${opts.cwd}`,
        payload: { args },
      });

      try {
        const envEntries: Record<string, string | undefined> = {};
        let hasEnv = false;
        if (opts.output_capture && opts.environment_redactions) {
          for (const key of opts.environment_redactions) {
            envEntries[key] = undefined;
            hasEnv = true;
          }
        } else if (opts.backend_options?.env) {
          for (const [k, v] of Object.entries(opts.backend_options.env)) {
            envEntries[k] = v ?? undefined;
            hasEnv = true;
          }
        }

        const spawnOpts: SpawnOptions = {
          cwd: opts.cwd,
          signal: runState.abortController.signal,
          ...(opts.output_capture
            ? {
                max_stdout_bytes: opts.output_capture.max_bytes,
                resolve_command_before_env: true,
              }
            : {}),
        };
        if (opts.onActivity) {
          spawnOpts.onActivity = opts.onActivity;
        }
        if (opts.backend_options?.agent_activity?.hard_timeout_ms !== undefined) {
          spawnOpts.hard_timeout_ms = opts.backend_options.agent_activity.hard_timeout_ms;
        }
        if (opts.backend_options?.agent_activity?.stop_grace_ms !== undefined) {
          spawnOpts.stop_grace_ms = opts.backend_options.agent_activity.stop_grace_ms;
        }
        if (hasEnv) {
          spawnOpts.env = envEntries;
        }

        // Resolve the same way the app-server transport does. A bare "codex"
        // is PATH-resolved by the OS, and PATH on a fleet host can lead to a
        // stale npm-global launcher whose vendored platform binary is gone —
        // the exact shim POL-1889 removed from the app-server path. Leaving
        // one literal behind left the resolver half-installed.
        const result = await this.spawnFn(resolveCodexCommandOrDefault(process.env), args, spawnOpts);
        const end = Date.now();
        const stdoutObservation = result.stdout_observation ?? {
          bytes_observed: Buffer.byteLength(result.stdout, "utf8"),
          sha256: createHash("sha256").update(result.stdout).digest("hex"),
          complete: true,
        };
        const outputCaptureObservation = opts.output_capture
          ? {
              status: result.spawn_error?.startsWith("stdout exceeded max_stdout_bytes=")
                ? "limit_exceeded" as const
                : result.code === 0 && stdoutObservation.complete
                  ? "complete" as const
                  : "incomplete" as const,
              bytes_observed: stdoutObservation.bytes_observed,
              sha256: stdoutObservation.sha256,
            }
          : undefined;

        if (runState.aborted) {
          events.push({ event: "cancelled" });
          return {
            exit_code: result.code,
            stderr: result.stderr,
            events,
            duration_ms: end - start,
            ...(result.signal ? { signal: result.signal } : {}),
            ...(result.spawn_error ? { spawn_error: result.spawn_error } : {}),
            ...(outputCaptureObservation ? { output_capture_observation: outputCaptureObservation } : {}),
          };
        }
        if (result.reason === "stalled_inactivity") {
          events.push({ event: "infra_failure", payload: { reason: "stalled_inactivity" } });
          opts.onEvent?.({
            timestamp: new Date().toISOString(),
            run_id: opts.run_id,
            event: "warning",
            message: "Codex legacy exec stopped after configured agent inactivity timeout.",
            payload: { reason: "stalled_inactivity" },
          });
        }

        const discovered = opts.output_capture
          ? {
              ...(outputCaptureObservation?.status === "complete"
                ? { agent_terminal_message: result.stdout }
                : {}),
            }
          : await this.discoverSession(start - 5000, end + 5000);

        return {
          exit_code: result.code,
          stderr: result.stderr,
          events,
          duration_ms: end - start,
          ...(discovered.session ? { session: discovered.session } : {}),
          ...(discovered.agent_terminal_message !== undefined
            ? { agent_terminal_message: discovered.agent_terminal_message }
            : {}),
          ...(discovered.provider_constraint
            ? { provider_constraint: discovered.provider_constraint }
            : {}),
          ...(outputCaptureObservation ? { output_capture_observation: outputCaptureObservation } : {}),
          ...(result.signal ? { signal: result.signal } : {}),
          ...(result.spawn_error ? { spawn_error: result.spawn_error } : {}),
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (runState.aborted) {
          events.push({ event: "cancelled" });
          return {
            stderr: message,
            events,
            duration_ms: Date.now() - start,
          };
        }
        events.push({ event: "infra_failure", payload: { error: message } });
        return {
          stderr: message,
          events,
          duration_ms: Date.now() - start,
        };
      }
    } finally {
      this.activeRuns.delete(opts.run_id);
      runState.settle();
      await Promise.all([cleanupInstructionFiles(), cleanupOutputSchema()]);
    }
  }

  private async discoverSession(
    startTime: number,
    endTime: number,
  ): Promise<{
    session?: SessionInfo;
    agent_terminal_message?: string;
    provider_constraint?: ProviderConstraint;
  }> {
    try {
      const session = await discoverCodexSession(startTime, endTime, this.discoveryFs);
      if (!session) return {};

      const [agent_terminal_message, provider_constraint] = session.path
        ? await Promise.all([
            parseCodexTerminalMessage(session.path, this.parserFs),
            parseCodexProviderConstraint(session.path, this.parserFs),
          ])
        : [undefined, undefined];

      return {
        session,
        ...(agent_terminal_message ? { agent_terminal_message } : {}),
        ...(provider_constraint ? { provider_constraint } : {}),
      };
    } catch {
      return {};
    }
  }

  async stop(run_id: string): Promise<void> {
    const state = this.activeRuns.get(run_id);
    if (state) {
      state.aborted = true;
      state.abortController.abort();
      await state.settled;
    }
  }
}

export function createLegacyCodexRuntimeAdapterFactory(
  opts?: LegacyExecCodexAdapterOptions,
): () => LegacyExecCodexAdapter {
  return () => new LegacyExecCodexAdapter(opts);
}
