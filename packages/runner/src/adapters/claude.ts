/**
 * @polli-labs/calyx-runner — Claude backend adapter.
 *
 * MVP adapter that spawns `claude` CLI in non-interactive mode with
 * the provided prompt. Captures exit code, stderr, and duration.
 *
 * The adapter uses dependency injection for the spawn function to
 * enable deterministic testing without requiring a real Claude CLI.
 *
 * @see docs/architecture/async-runner-vnext-contracts.md
 */

import { randomUUID } from "node:crypto";
import {
  CLAUDE_BACKEND_REASONING_EFFORTS,
  isClaudeBackendReasoningEffort,
  type AgentTerminalEvidence,
  type BackendEvent,
  type ProviderConstraint,
} from "../types.js";
import { createSpawnCompatibilitySession } from "./session-compat.js";
import type {
  AdapterResult,
  AdapterSpawnOptions,
  AdapterStartOptions,
  BackendAdapter,
  SessionInfo,
} from "./types.js";
import {
  defaultSpawn as sharedDefaultSpawn,
  type SpawnFunction,
  type SpawnOptions,
} from "./spawn.js";
import { discoverClaudeSession, type SessionDiscoveryFs } from "./session-discovery.js";
import {
  parseClaudeProviderConstraint,
  parseClaudeTerminalMessage,
  type SessionParserFs,
} from "./session-parser.js";
import { ClaudeStreamParser } from "./claude-stream.js";

function processAuthoritativeTerminalEvidence(args: {
  projected?: AgentTerminalEvidence | undefined;
  reason: "abnormal_exit" | "operator_stop";
  exitCode?: number;
  signal?: string;
  durationMs: number;
  malformedLineCount: number;
  unknownRecordCount: number;
}): AgentTerminalEvidence {
  return {
    ...(args.projected ?? {}),
    schema_version: "calyx.agent-terminal-evidence/v1",
    source: "process_exit",
    status: "authoritative",
    reason: args.reason,
    ...(args.exitCode !== undefined ? { exit_code: args.exitCode } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
    duration_ms: args.durationMs,
    malformed_line_count: args.malformedLineCount,
    unknown_record_count: args.unknownRecordCount,
  };
}

/** Options for constructing a ClaudeAdapter. */
export interface ClaudeAdapterOptions {
  /** Override the default spawn implementation for testing. */
  spawn?: SpawnFunction;
  /** Override filesystem for session discovery (testing). */
  sessionDiscoveryFs?: SessionDiscoveryFs;
  /** Override filesystem for session parsing (testing). */
  sessionParserFs?: SessionParserFs;
}

/**
 * Claude backend adapter.
 *
 * Spawns Claude in structured streaming mode and projects sparse lifecycle
 * facts without persisting raw model or tool payloads.
 */
export class ClaudeAdapter implements BackendAdapter {
  readonly name = "claude";
  readonly capabilities = {
    streaming: true,
    turnControl: false,
    resumeSession: true,
    forkSession: false,
    approvals: "none",
  } as const;
  private readonly spawnFn: NonNullable<ClaudeAdapterOptions["spawn"]>;
  private readonly discoveryFs: SessionDiscoveryFs | undefined;
  private readonly parserFs: SessionParserFs | undefined;
  private activeRuns = new Map<string, {
    aborted: boolean;
    abortController: AbortController;
    settled: Promise<void>;
    settle: () => void;
  }>();

  constructor(opts?: ClaudeAdapterOptions) {
    this.spawnFn = opts?.spawn ?? sharedDefaultSpawn;
    this.discoveryFs = opts?.sessionDiscoveryFs;
    this.parserFs = opts?.sessionParserFs;
  }

  async startSession(opts: AdapterStartOptions) {
    return createSpawnCompatibilitySession(this, opts);
  }

  async spawn(opts: AdapterSpawnOptions): Promise<AdapterResult> {
    const expectedSessionId = opts.resume_session_id ?? randomUUID();
    const args = opts.resume_session_id
      ? ["--resume", opts.resume_session_id]
      : ["--session-id", expectedSessionId];
    if (opts.system_prompt) {
      args.push("--system-prompt", opts.system_prompt);
    }
    if (opts.append_system_prompt) {
      args.push("--append-system-prompt", opts.append_system_prompt);
    }
    if (opts.backend_options?.model) {
      args.push("--model", opts.backend_options.model);
    }
    if (opts.backend_options?.reasoning_effort) {
      const effort = opts.backend_options.reasoning_effort;
      if (!isClaudeBackendReasoningEffort(effort)) {
        throw new Error(
          `Claude does not support backend_options.reasoning_effort=${JSON.stringify(effort)}. ` +
            `Valid Claude values: ${CLAUDE_BACKEND_REASONING_EFFORTS.join(", ")}.`,
        );
      }
      args.push("--effort", effort);
    }
    // Add allowed tools if specified
    if (opts.backend_options?.allowed_tools) {
      for (const tool of opts.backend_options.allowed_tools) {
        args.push("--allowedTools", tool);
      }
    }

    if (opts.backend_options?.max_threads !== undefined) {
      throw new Error(
        "Claude does not support backend_options.max_threads. " +
          "Use backend_options.max_turns only when an explicit Claude turn cap is intended.",
      );
    }
    if (opts.backend_options?.max_turns !== undefined) {
      const maxTurns = opts.backend_options.max_turns;
      if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
        throw new Error("Claude backend_options.max_turns must be a positive integer.");
      }
      args.push("--max-turns", String(maxTurns));
    }

    // Add dangerously skip permissions
    if (opts.backend_options?.dangerously_skip_permissions) {
      args.push("--dangerously-skip-permissions");
    }
    args.push("--print", "--output-format", "stream-json", "--verbose", "--", opts.prompt);

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

    const start = Date.now();
    const events: BackendEvent[] = [];
    const stream = new ClaudeStreamParser({
      run_id: opts.run_id,
      expected_session_id: expectedSessionId,
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.onActivity ? { onActivity: opts.onActivity } : {}),
      ...(opts.onSession ? { onSession: opts.onSession } : {}),
    });

    try {
      // Keep event sinks inside the run lifecycle boundary: a throwing sink
      // must still delete and settle the active run so stop() cannot hang.
      opts.onEvent?.({
        timestamp: new Date().toISOString(),
        run_id: opts.run_id,
        event: "backend_spawned",
        message: `Spawning claude CLI in ${opts.cwd}`,
        payload: { args },
      });

      // Build env, merging backend_options.env.
      //
      // POL-1139: strip ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN by default so
      // the spawned claude CLI uses the OAuth token in ~/.claude/.credentials.json
      // (Max plan auth) instead of silently falling back to API-key billing on
      // an exhausted key inherited from the calyx daemon's parent shell. Set
      // CALYX_CLAUDE_USE_API_KEY=1 in the daemon env to opt in to API-key auth.
      // Caller-provided backend_options.env values override the strip.
      const envEntries: Record<string, string | undefined> = {};
      let hasEnv = false;
      if (process.env.CALYX_CLAUDE_USE_API_KEY !== "1") {
        envEntries.ANTHROPIC_API_KEY = undefined;
        envEntries.ANTHROPIC_AUTH_TOKEN = undefined;
        hasEnv = true;
      }
      if (opts.backend_options?.env) {
        for (const [k, v] of Object.entries(opts.backend_options.env)) {
          envEntries[k] = v ?? undefined;
          hasEnv = true;
        }
      }

      const spawnOpts: SpawnOptions = {
        cwd: opts.cwd,
        close_stdin: true,
        signal: runState.abortController.signal,
        onStdoutChunk: (chunk) => stream.write(chunk),
        capture_stdout: false,
      };
      if (opts.backend_options?.agent_activity?.hard_timeout_ms !== undefined) {
        spawnOpts.hard_timeout_ms = opts.backend_options.agent_activity.hard_timeout_ms;
      }
      if (opts.backend_options?.agent_activity?.stop_grace_ms !== undefined) {
        spawnOpts.stop_grace_ms = opts.backend_options.agent_activity.stop_grace_ms;
      }
      if (hasEnv) {
        spawnOpts.env = envEntries;
      }

      const result = await this.spawnFn("claude", args, spawnOpts);
      const end = Date.now();
      const projection = stream.finish();

      if (runState.aborted) {
        events.push({ event: "cancelled" });
        const terminalEvidence = processAuthoritativeTerminalEvidence({
          projected: projection.terminal_evidence,
          reason: "operator_stop",
          exitCode: result.code,
          ...(result.signal ? { signal: result.signal } : {}),
          durationMs: end - start,
          malformedLineCount: projection.malformed_line_count,
          unknownRecordCount: projection.unknown_record_count,
        });
        stream.publishTerminalEvent(terminalEvidence);
        return {
          exit_code: result.code,
          stderr: result.stderr,
          events,
          duration_ms: end - start,
          ...(result.signal ? { signal: result.signal } : {}),
          ...(result.spawn_error ? { spawn_error: result.spawn_error } : {}),
          ...(projection.session ? { session: projection.session } : {}),
          ...(projection.agent_terminal_message
            ? { agent_terminal_message: projection.agent_terminal_message }
            : {}),
          terminal_evidence: terminalEvidence,
          ...(projection.provider_constraint
            ? { provider_constraint: projection.provider_constraint }
            : {}),
        };
      }
      if (result.reason === "stalled_inactivity") {
        events.push({ event: "infra_failure", payload: { reason: "stalled_inactivity" } });
        opts.onEvent?.({
          timestamp: new Date().toISOString(),
          run_id: opts.run_id,
          event: "warning",
          message: "Claude backend stopped after configured agent inactivity timeout.",
          payload: { reason: "stalled_inactivity" },
        });
      }

      // Session discovery + terminal message extraction (graceful degradation).
      // 5s buffer on each side for cross-process timestamp correlation.
      const discovered = await this.discoverSession({
        sessionId: expectedSessionId,
        startTime: start - 5000,
        endTime: end + 5000,
        cwd: opts.cwd,
        isResume: opts.resume_session_id !== undefined,
      });
      const session = projection.session
        ? {
            ...projection.session,
            ...(discovered.session?.id === projection.session.id && discovered.session.path
              ? { path: discovered.session.path }
              : {}),
          }
        : discovered.session;
      const agentTerminalMessage = projection.agent_terminal_message
        ?? discovered.agent_terminal_message;
      const providerConstraint = projection.provider_constraint
        ?? discovered.provider_constraint;
      const projectedTerminalEvidence = projection.terminal_evidence ? {
        ...projection.terminal_evidence,
        exit_code: result.code,
        ...(result.signal ? { signal: result.signal } : {}),
        duration_ms: projection.terminal_evidence.duration_ms ?? end - start,
      } : discovered.session || discovered.agent_terminal_message ? {
        schema_version: "calyx.agent-terminal-evidence/v1" as const,
        source: "session_fallback" as const,
        status: "fallback" as const,
        reason: result.code === 0 ? "completed" as const : "abnormal_exit" as const,
        ...(session?.id ? { session_id: session.id } : {}),
        exit_code: result.code,
        ...(result.signal ? { signal: result.signal } : {}),
        duration_ms: end - start,
        malformed_line_count: projection.malformed_line_count,
        unknown_record_count: projection.unknown_record_count,
      } : {
        schema_version: "calyx.agent-terminal-evidence/v1" as const,
        source: projection.structured_record_count > 0 || projection.malformed_line_count > 0
          ? "claude_stream" as const
          : "process_exit" as const,
        status: projection.structured_record_count > 0
          ? "missing" as const
          : projection.malformed_line_count > 0
            ? "malformed" as const
            : "missing" as const,
        reason: projection.structured_record_count > 0
          ? "missing_result" as const
          : result.code === 0
            ? "missing_result" as const
            : "abnormal_exit" as const,
        ...(session?.id ? { session_id: session.id } : {}),
        exit_code: result.code,
        ...(result.signal ? { signal: result.signal } : {}),
        duration_ms: end - start,
        malformed_line_count: projection.malformed_line_count,
        unknown_record_count: projection.unknown_record_count,
      };
      const terminalEvidence = result.spawn_error
        || (
          projectedTerminalEvidence.status === "authoritative"
          && projectedTerminalEvidence.reason === "completed"
          && result.code !== 0
        )
        ? processAuthoritativeTerminalEvidence({
            projected: projectedTerminalEvidence,
            reason: "abnormal_exit",
            exitCode: result.code,
            ...(result.signal ? { signal: result.signal } : {}),
            durationMs: end - start,
            malformedLineCount: projection.malformed_line_count,
            unknownRecordCount: projection.unknown_record_count,
          })
        : projectedTerminalEvidence;
      stream.publishTerminalEvent(terminalEvidence);
      if (projection.protocol_failed || projection.semantic_progress_count === 0) {
        try {
          const signalFailed = projection.protocol_failed || Boolean(result.spawn_error);
          opts.onActivity?.({
            source: "claude_stream",
            timestamp: new Date().toISOString(),
            semantic: false,
            detail: result.spawn_error ? "spawn_failed" : projection.protocol_failed
              ? "malformed_stream"
              : "no_structured_events",
            signal: {
              source: "claude_stream",
              status: signalFailed ? "failed" : "unavailable",
              reason: result.spawn_error ? "spawn_failed" : projection.protocol_failed
                ? "malformed_stream"
                : "no_structured_events",
            },
          });
        } catch {
          // Health projection is observational; terminal evidence remains valid.
        }
      }

      return {
        exit_code: result.code,
        stderr: result.stderr,
        events,
        duration_ms: end - start,
        ...(session ? { session } : {}),
        ...(agentTerminalMessage ? { agent_terminal_message: agentTerminalMessage } : {}),
        ...(result.signal ? { signal: result.signal } : {}),
        ...(result.spawn_error ? { spawn_error: result.spawn_error } : {}),
        terminal_evidence: terminalEvidence,
        ...(providerConstraint ? { provider_constraint: providerConstraint } : {}),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const projection = stream.finish();
      if (runState.aborted) {
        events.push({ event: "cancelled" });
        const terminalEvidence = processAuthoritativeTerminalEvidence({
          projected: projection.terminal_evidence,
          reason: "operator_stop",
          durationMs: Date.now() - start,
          malformedLineCount: projection.malformed_line_count,
          unknownRecordCount: projection.unknown_record_count,
        });
        stream.publishTerminalEvent(terminalEvidence);
        return {
          stderr: message,
          events,
          duration_ms: Date.now() - start,
          ...(projection.session ? { session: projection.session } : {}),
          ...(projection.agent_terminal_message
            ? { agent_terminal_message: projection.agent_terminal_message }
            : {}),
          terminal_evidence: terminalEvidence,
          ...(projection.provider_constraint
            ? { provider_constraint: projection.provider_constraint }
            : {}),
        };
      }
      events.push({ event: "infra_failure", payload: { error: message } });
      const adapterResult: AdapterResult = {
        stderr: message,
        events,
        duration_ms: Date.now() - start,
        ...(projection.session ? { session: projection.session } : {}),
        ...(projection.agent_terminal_message
          ? { agent_terminal_message: projection.agent_terminal_message }
          : {}),
        terminal_evidence: processAuthoritativeTerminalEvidence({
          projected: projection.terminal_evidence,
          reason: "abnormal_exit",
          durationMs: Date.now() - start,
          malformedLineCount: projection.malformed_line_count,
          unknownRecordCount: projection.unknown_record_count,
        }),
        ...(projection.provider_constraint
          ? { provider_constraint: projection.provider_constraint }
          : {}),
      };
      stream.publishTerminalEvent(adapterResult.terminal_evidence!);
      try {
        opts.onActivity?.({
          source: "claude_stream",
          timestamp: new Date().toISOString(),
          semantic: false,
          detail: "spawn_failed",
          signal: { source: "claude_stream", status: "failed", reason: "spawn_failed" },
        });
      } catch {
        // Health projection is observational.
      }
      return adapterResult;
    } finally {
      this.activeRuns.delete(opts.run_id);
      runState.settle();
    }
  }

  /** Attempt session discovery and terminal message extraction. Gracefully returns empty on failure. */
  private async discoverSession(
    request: Parameters<typeof discoverClaudeSession>[0],
  ): Promise<{
    session?: SessionInfo;
    agent_terminal_message?: string;
    provider_constraint?: ProviderConstraint;
  }> {
    try {
      const session = await discoverClaudeSession(request, this.discoveryFs);
      if (!session) return {};

      let agent_terminal_message: string | undefined;
      let provider_constraint: ProviderConstraint | undefined;
      if (session.path?.endsWith(".jsonl")) {
        try {
          [agent_terminal_message, provider_constraint] = await Promise.all([
            parseClaudeTerminalMessage(session.path, this.parserFs),
            parseClaudeProviderConstraint(session.path, this.parserFs),
          ]);
        } catch {
          // Session identity remains authoritative even if optional message parsing fails.
        }
      }

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
