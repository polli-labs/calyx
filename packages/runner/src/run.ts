/**
 * @polli-labs/calyx-runner — Run orchestrator.
 *
 * Drives the end-to-end execution pipeline:
 *   1. Validate RunSpec
 *   2. Dispatch gate evaluation
 *   3. State: queued → dispatching → running
 *   4. Worktree acquisition
 *   5. Backend adapter execution
 *   6. Classification of result
 *   7. Artifact gate evaluation
 *   8. Receipt emission
 *   9. Worktree release
 *
 * The orchestrator is parameterized by injectable dependencies to
 * enable deterministic integration testing.
 *
 * @see docs/architecture/async-runner-vnext.md
 */

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AgentProgressSignal,
  AgentRunnerSessionCheckpoint,
  AgentTerminalEvidence,
  ArtifactEntry,
  BackendEvent,
  ClassifierInput,
  ClassificationResult,
  FailureClass,
  InfraErrorClassification,
  LifecycleEvent,
  PartialReason,
  ProviderConstraint,
  ReceiptEnvironment,
  RunHealthSnapshot,
  RunReceipt,
  RunOutputCaptureObservation,
  RunSpec,
  RunState,
  SessionStopReason,
  SessionSummary,
  SessionTurnSummary,
} from "./types.js";
import { runSpecSchema } from "./schemas.js";
import { assertTransition } from "./state-machine.js";
import { classify } from "./classifier.js";
import { classifyInfraError, normalizeInfraErrorClassification } from "./infra-error.js";
import { detectProviderConstraint } from "./provider-constraint.js";
import { ClassifierPipeline } from "./exit-classifier.js";
import type { ExitEvidence } from "./exit-classifier.js";
import { evaluateDispatch } from "./dispatch.js";
import {
  acquireWorktree,
  releaseWorktree,
  type WorktreeManagerOptions,
} from "./worktree.js";
import { ensureAdapterSession } from "./adapters/session-compat.js";
import type {
  AdapterSession,
  AdapterStartOptions,
  BackendAdapter,
  TurnEvent,
  TurnInput,
  TurnResult,
} from "./adapters/types.js";
import { buildRunReceipt, evaluateArtifactGate, writeReceipt } from "./receipt.js";
import type { ReceiptBuildContext } from "./receipt.js";
import { materializeRunOutputCapture, RunOutputCaptureError } from "./output-capture.js";
import {
  buildCalyxRunMetadataEnv,
  mergeBackendOptionsWithCalyxRunMetadataEnv,
} from "./run-metadata-env.js";

/** Injectable dependencies for the orchestrator. */
export interface RunDeps {
  /** Backend adapter to use for execution. */
  adapter: BackendAdapter;
  /** Trusted server-owned environment keys to remove from a capture provider child. */
  backendEnvironmentRedactions?: readonly string[];
  /** Worktree manager options. */
  worktree: WorktreeManagerOptions;
  /** Optional: function to discover artifacts after execution. */
  discoverArtifacts?: (cwd: string, run_id: string) => Promise<ArtifactEntry[]>;
  /** Optional: path to write the receipt file. */
  receiptPath?: string;
  /** Optional: callback for each lifecycle event. */
  onEvent?: (event: LifecycleEvent) => void;
  /** Optional: callback for sparse run health snapshots. */
  onHealthUpdate?: (health: RunHealthSnapshot) => void;
  /** Optional: callback when a native backend session is available before terminal receipt materialization. */
  onSessionCheckpoint?: (checkpoint: AgentRunnerSessionCheckpoint) => void;
  /** Optional: exit classifier pipeline for partial detection. Uses default if unset. */
  exitClassifierPipeline?: ClassifierPipeline;
  /**
   * Optional continuation callback for multi-turn sessions.
   *
   * The provided `session` handle is for read access to the current live
   * session state and identity. Callers must not start extra turns or close the
   * session directly from this callback; runner owns turn sequencing and
   * session lifecycle for the run.
   */
  nextTurnInput?: (context: {
    turn_index: number;
    turn_summary: SessionTurnSummary;
    session_summary: SessionSummary;
    session: AdapterSession;
    terminal_state: RunState;
    classification: ClassificationResult;
    partial_reason?: PartialReason;
    result: TurnResult;
  }) => Promise<TurnInput | null> | TurnInput | null;
}

/** Result of executeRun — includes final state, receipt, and all events. */
export interface RunResult {
  receipt: RunReceipt;
  events: LifecycleEvent[];
  dispatch_accepted: boolean;
}

/** Internal mutable execution context. */
interface RunContext {
  run_id: string;
  state: RunState;
  spec: RunSpec;
  events: LifecycleEvent[];
  created_at: string;
  dispatched_at?: string;
  started_at?: string;
}

interface ClassifiedTurn {
  state: RunState;
  classification: ClassificationResult;
  partial_reason?: PartialReason;
  provider_constraint?: ProviderConstraint;
}

interface SessionExecutionResult {
  state: RunState;
  classification: ClassificationResult;
  partial_reason?: PartialReason;
  duration_ms: number;
  classifier_input: ClassifierInput;
  backend_session?: {
    id: string;
    path?: string;
    backend: string;
  };
  agent_terminal_message?: string;
  output_capture_observation?: RunOutputCaptureObservation;
  backend_stderr?: string;
  backend_signal?: string;
  spawn_error?: string;
  infra_error_classification?: InfraErrorClassification;
  terminal_evidence?: AgentTerminalEvidence;
  session_summary: SessionSummary;
}

const DEFAULT_AGENT_ACTIVITY_STALE_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_AGENT_ACTIVITY_POLL_INTERVAL_MS = 5_000;
const DEFAULT_AGENT_ACTIVITY_STOP_GRACE_MS = 5_000;

interface ResolvedAgentActivityConfig {
  stale_after_ms: number;
  poll_interval_ms: number;
  hard_timeout_ms?: number;
  stop_grace_ms: number;
}

function normalizeAgentActivityConfig(spec: RunSpec): ResolvedAgentActivityConfig {
  const config = spec.backend_options?.agent_activity;
  const staleAfterMs = config?.stale_after_ms ?? DEFAULT_AGENT_ACTIVITY_STALE_AFTER_MS;
  if (!Number.isInteger(staleAfterMs) || staleAfterMs <= 0) {
    throw new Error(
      `Invalid backend_options.agent_activity.stale_after_ms value: ${String(config?.stale_after_ms)}. Must be a positive integer.`,
    );
  }
  const pollIntervalMs = config?.poll_interval_ms ?? Math.min(
    staleAfterMs,
    DEFAULT_AGENT_ACTIVITY_POLL_INTERVAL_MS,
  );
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(
      `Invalid backend_options.agent_activity.poll_interval_ms value: ${String(config?.poll_interval_ms)}. Must be a positive integer.`,
    );
  }
  if (config?.hard_timeout_ms !== undefined && (!Number.isInteger(config.hard_timeout_ms) || config.hard_timeout_ms <= 0)) {
    throw new Error(
      `Invalid backend_options.agent_activity.hard_timeout_ms value: ${String(config.hard_timeout_ms)}. Must be a positive integer.`,
    );
  }
  const stopGraceMs = config?.stop_grace_ms ?? DEFAULT_AGENT_ACTIVITY_STOP_GRACE_MS;
  if (!Number.isInteger(stopGraceMs) || stopGraceMs <= 0) {
    throw new Error(
      `Invalid backend_options.agent_activity.stop_grace_ms value: ${String(config?.stop_grace_ms)}. Must be a positive integer.`,
    );
  }
  return {
    stale_after_ms: staleAfterMs,
    poll_interval_ms: pollIntervalMs,
    ...(config?.hard_timeout_ms !== undefined ? { hard_timeout_ms: config.hard_timeout_ms } : {}),
    stop_grace_ms: stopGraceMs,
  };
}

function buildAgentRunnerHealthSummary(args: {
  status: RunHealthSnapshot["status"];
  staleAfterMs: number;
  lastProgressAtMs?: number;
  label?: string;
  progressSignal?: AgentProgressSignal;
}): string {
  if (args.progressSignal?.status === "unavailable") {
    return `Agent-runner health is unknown: ${args.progressSignal.source} progress is unavailable (${args.progressSignal.reason}).`;
  }
  if (args.progressSignal?.status === "failed") {
    return `Agent-runner health is unknown: ${args.progressSignal.source} progress failed (${args.progressSignal.reason}).`;
  }
  if (args.status === "healthy" && args.progressSignal?.expected_silence_until) {
    return `Backend-declared semantic silence is expected until ${args.progressSignal.expected_silence_until}; last agent-runner progress was observed at ${args.lastProgressAtMs ? new Date(args.lastProgressAtMs).toISOString() : "an unknown time"} via ${args.label ?? "runner lifecycle"}.`;
  }
  if (args.status === "healthy" && args.lastProgressAtMs) {
    return `Recent agent-runner progress observed at ${new Date(args.lastProgressAtMs).toISOString()} via ${args.label ?? "runner lifecycle"}.`;
  }
  if (args.status === "stale" && args.lastProgressAtMs) {
    return `Last agent-runner progress at ${new Date(args.lastProgressAtMs).toISOString()} via ${args.label ?? "runner lifecycle"} is older than ${args.staleAfterMs} ms.`;
  }
  if (args.status === "stale") {
    return `No agent-runner progress was observed within ${args.staleAfterMs} ms.`;
  }
  return "Waiting for first agent-runner progress signal.";
}

/** Build a ReceiptEnvironment, omitting undefined optional fields. */
function buildEnvironment(
  spec: RunSpec,
  extra?: { worktree_path?: string; branch?: string },
): ReceiptEnvironment {
  const env: ReceiptEnvironment = {
    host: spec.host,
    backend: spec.backend,
  };
  if (spec.profile !== undefined) env.profile = spec.profile;
  if (extra?.worktree_path !== undefined) env.worktree_path = extra.worktree_path;
  if (extra?.branch !== undefined) env.branch = extra.branch;
  return env;
}

function mergeTurnStderr(values: string[]): string | undefined {
  const nonEmpty = values.map((value) => value.trim()).filter((value) => value.length > 0);
  if (nonEmpty.length === 0) {
    return undefined;
  }
  return nonEmpty.join("\n\n");
}

function observeTerminalCapture(message: string | undefined): RunOutputCaptureObservation {
  const bytes = Buffer.from(message ?? "", "utf8");
  return {
    status: message === undefined ? "incomplete" : "complete",
    bytes_observed: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function turnEventToBackendEvent(event: TurnEvent, turnIndex: number, adapterTurnId: string): BackendEvent {
  return {
    event: `turn_${event.kind}`,
    payload: {
      turn_index: turnIndex,
      adapter_turn_id: adapterTurnId,
      ...event.payload,
    },
  };
}

function emitTurnEvent(
  emit: (event: Omit<LifecycleEvent, "timestamp" | "run_id">) => LifecycleEvent,
  event: TurnEvent,
  turnIndex: number,
  adapterTurnId: string,
): void {
  const payload: Record<string, unknown> = {
    turn_index: turnIndex,
    adapter_turn_id: adapterTurnId,
    ...event.payload,
  };
  const message =
    typeof event.payload.message === "string"
      ? event.payload.message
      : `Turn ${turnIndex} emitted ${event.kind}`;

  if (event.kind === "warning") {
    emit({ event: "warning", message, payload });
    return;
  }
  if (event.kind === "error") {
    emit({ event: "error", message, payload });
    return;
  }
  emit({
    event: "backend_event",
    message,
    payload: {
      kind: event.kind,
      ...payload,
    },
  });
}

async function drainTurnEvents(args: {
  events: AsyncIterable<TurnEvent>;
  turnIndex: number;
  adapterTurnId: string;
  emit: (event: Omit<LifecycleEvent, "timestamp" | "run_id">) => LifecycleEvent;
  streamedBackendEvents: BackendEvent[];
}): Promise<number> {
  let count = 0;
  for await (const event of args.events) {
    count += 1;
    emitTurnEvent(args.emit, event, args.turnIndex, args.adapterTurnId);
    args.streamedBackendEvents.push(turnEventToBackendEvent(event, args.turnIndex, args.adapterTurnId));
  }
  return count;
}

function buildClassifiedTurn(
  classification: ClassificationResult,
  partialReason?: PartialReason,
  providerConstraint?: ProviderConstraint,
): ClassifiedTurn {
  return {
    state: partialReason ? "partial" : classToState(classification.class),
    classification,
    ...(partialReason ? { partial_reason: partialReason } : {}),
    ...(providerConstraint ? { provider_constraint: providerConstraint } : {}),
  };
}

function isTypedFatalClassification(classification: ClassificationResult): boolean {
  return (
    (
      classification.source === "exit_code"
      && classification.raw_exit_code !== undefined
    )
    || classification.source === "backend_event"
  ) && (
    classification.class === "auth_error"
    || classification.class === "infra_error"
    || classification.class === "dispatch_rejected"
  );
}

function buildCancelledTurn(exitCode: number | undefined): ClassifiedTurn {
  return {
    state: "cancelled",
    // Cancellation is a lifecycle outcome rather than a FailureClass. Keep the
    // receipt's existing non-success classification shape while making the
    // typed backend event, not the process's conventional signal exit code,
    // the definitive source of the terminal state.
    classification: {
      class: "task_failure",
      source: "backend_event",
      confidence: "definitive",
      signal: "backend event: cancelled",
      effective_exit_code: exitCode ?? 130,
      ...(exitCode !== undefined ? { raw_exit_code: exitCode } : {}),
    },
  };
}

function normalizeTerminalEvidenceForOutcome(
  result: TurnResult,
  state: RunState,
  providerConstraint?: ProviderConstraint,
): AgentTerminalEvidence | undefined {
  const evidence = result.terminal_evidence;
  if (providerConstraint) {
    const source = providerConstraint.source === "backend_stream"
      ? "claude_stream"
      : providerConstraint.source === "session_transcript"
        ? "session_fallback"
        : "process_exit";
    return {
      ...(evidence ?? {
        schema_version: "calyx.agent-terminal-evidence/v1" as const,
      }),
      schema_version: "calyx.agent-terminal-evidence/v1",
      source,
      status: "authoritative",
      reason: "provider_capacity_exhausted",
      ...(result.session?.id ? { session_id: result.session.id } : {}),
      ...(result.exit_code !== undefined ? { exit_code: result.exit_code } : {}),
      ...(result.signal ? { signal: result.signal } : {}),
      duration_ms: result.duration_ms,
      provider_constraint: providerConstraint,
    };
  }
  if (!evidence) return undefined;
  if (state === "cancelled") {
    return {
      ...evidence,
      source: "process_exit",
      status: "authoritative",
      reason: "operator_stop",
      ...(result.exit_code !== undefined ? { exit_code: result.exit_code } : {}),
      ...(result.signal ? { signal: result.signal } : {}),
    };
  }
  if (
    evidence.status === "authoritative"
    && evidence.reason === "completed"
    && state !== "succeeded"
  ) {
    return {
      ...evidence,
      source: "process_exit",
      status: "authoritative",
      reason: "abnormal_exit",
      ...(result.exit_code !== undefined ? { exit_code: result.exit_code } : {}),
      ...(result.signal ? { signal: result.signal } : {}),
    };
  }
  return evidence;
}

async function classifyTurn(args: {
  result: TurnResult;
  backend: string;
  eventCount: number;
  exitClassifierPipeline: ClassifierPipeline;
}): Promise<ClassifiedTurn> {
  const classifierInput: ClassifierInput = {
    stderr: args.result.stderr,
    event_count: args.eventCount,
    backend_events: args.result.events,
  };
  if (args.result.exit_code !== undefined) {
    classifierInput.exit_code = args.result.exit_code;
  }
  classifierInput.final_artifact_present = args.result.session !== undefined;

  const classification = classify(classifierInput);
  const exitEvidence: ExitEvidence = {
    exit_code: args.result.exit_code,
    duration_ms: args.result.duration_ms,
    stderr: args.result.stderr,
    backend: args.backend,
    ...(args.result.session?.path ? { session_path: args.result.session.path } : {}),
    ...(args.result.agent_terminal_message ? { terminal_message: args.result.agent_terminal_message } : {}),
    ...(args.result.signal ? { signal: args.result.signal } : {}),
    ...(args.result.spawn_error ? { spawn_error: args.result.spawn_error } : {}),
  };
  const exitOutcome = await args.exitClassifierPipeline.classify(exitEvidence);
  // Typed fatal evidence remains authoritative even when cancellation races
  // with it. In particular, a failed spawn or backend-auth failure must not be
  // laundered into an operator cancellation merely because stop was also
  // requested.
  if (isTypedFatalClassification(classification)) {
    return buildClassifiedTurn(classification);
  }
  if (exitOutcome.failure_class === "infra_error" && args.result.spawn_error) {
    return {
      state: "infra_error",
      classification,
    };
  }
  if (args.result.events.some((event) => event.event === "cancelled")) {
    return buildCancelledTurn(args.result.exit_code);
  }
  const terminal = args.result.terminal_evidence;
  if (terminal?.status === "authoritative" && terminal.reason === "completed") {
    // Current-turn successful authority supersedes any historical provider
    // observation recovered from a reused session transcript.
    if (args.result.exit_code !== undefined && args.result.exit_code !== 0) {
      return buildClassifiedTurn(classification);
    }
    return buildClassifiedTurn(classify({ exit_code: 0 }));
  }
  const providerConstraintEligible = args.result.exit_code !== 0
    || (terminal?.status === "authoritative" && terminal.reason !== "completed");
  const providerConstraint = providerConstraintEligible
    ? args.result.provider_constraint
      ?? detectProviderConstraint({
        backend: args.backend,
        source: "backend_stderr",
        message: args.result.stderr,
        terminal_failure: args.result.exit_code !== undefined && args.result.exit_code !== 0,
      })
    : undefined;
  if (providerConstraint) {
    return buildClassifiedTurn(classification, "budget_exhaustion", providerConstraint);
  }
  if (terminal?.status === "authoritative") {
    if (terminal.reason === "max_turns") {
      return buildClassifiedTurn(classify({ exit_code: args.result.exit_code ?? 0 }), "max_turns");
    }
    if (terminal.reason === "budget_exhaustion") {
      return buildClassifiedTurn(classify({ exit_code: args.result.exit_code ?? 0 }), "budget_exhaustion");
    }
    if (terminal.reason === "operator_stop") {
      return buildClassifiedTurn(classify({ exit_code: args.result.exit_code ?? 0 }), "operator_stop");
    }
    if (terminal.reason === "deferred") {
      return buildClassifiedTurn(classify({ exit_code: args.result.exit_code ?? 0 }), "graceful_stop");
    }
    return buildClassifiedTurn({
      class: "task_failure",
      source: "backend_event",
      confidence: "definitive",
      signal: `Claude structured result: ${terminal.reason}`,
      effective_exit_code: args.result.exit_code ?? 1,
      ...(args.result.exit_code !== undefined ? { raw_exit_code: args.result.exit_code } : {}),
    });
  }
  if (terminal?.status === "malformed" && terminal.reason === "malformed_result") {
    return buildClassifiedTurn({
      class: "infra_error",
      source: "backend_event",
      confidence: "definitive",
      signal: "Claude structured result: malformed_result",
      effective_exit_code: 6,
      ...(args.result.exit_code !== undefined ? { raw_exit_code: args.result.exit_code } : {}),
    });
  }
  if (exitOutcome.state === "partial") {
    return buildClassifiedTurn(classification, exitOutcome.partial_reason);
  }
  return buildClassifiedTurn(classification);
}

async function executeSession(args: {
  spec: RunSpec;
  adapter: BackendAdapter;
  session: AdapterSession;
  initialInput: TurnInput;
  maxTurns: number;
  emit: (event: Omit<LifecycleEvent, "timestamp" | "run_id">) => LifecycleEvent;
  exitClassifierPipeline: ClassifierPipeline;
  nextTurnInput?: RunDeps["nextTurnInput"];
}): Promise<SessionExecutionResult> {
  const summaries: SessionTurnSummary[] = [];
  const stderrChunks: string[] = [];
  let totalDurationMs = 0;
  let stopReason: SessionStopReason = "natural_stop";
  let turnInput: TurnInput | null = args.initialInput;
  let turnIndex = 0;
  let lastResult: TurnResult | undefined;
  let lastClassified: ClassifiedTurn | undefined;

  while (turnInput) {
    turnIndex += 1;
    const startedAt = new Date().toISOString();
    const turnHandle = await args.session.startTurn(turnInput);
    const streamedBackendEvents: BackendEvent[] = [];
    const drainPromise = drainTurnEvents({
      events: turnHandle.events,
      turnIndex,
      adapterTurnId: turnHandle.id,
      emit: args.emit,
      streamedBackendEvents,
    });
    const result = await turnHandle.wait();
    const streamedEventCount = await drainPromise;
    const classified = await classifyTurn({
      result: {
        ...result,
        events: [...result.events, ...streamedBackendEvents],
      },
      backend: args.spec.backend,
      eventCount: streamedEventCount + result.events.length,
      exitClassifierPipeline: args.exitClassifierPipeline,
    });
    const completedAt = new Date().toISOString();
    totalDurationMs += result.duration_ms;
    if (result.stderr.trim().length > 0) {
      stderrChunks.push(result.stderr);
    }
    lastResult = {
      ...result,
      events: [...result.events, ...streamedBackendEvents],
    };
    lastClassified = classified;

    summaries.push({
      turn_index: turnIndex,
      adapter_turn_id: turnHandle.id,
      ...(result.backend_turn_id ? { backend_turn_id: result.backend_turn_id } : {}),
      ...(result.session?.id ? { backend_session_id: result.session.id } : {}),
      state: classified.state,
      failure_class: classified.classification.class,
      failure_source: classified.classification.source,
      ...(classified.partial_reason ? { partial_reason: classified.partial_reason } : {}),
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: result.duration_ms,
    });

    if (classified.state === "auth_error") {
      stopReason = "auth_error";
      break;
    }
    if (classified.state === "infra_error") {
      stopReason = "infra_error";
      break;
    }
    if (classified.state === "cancelled") {
      stopReason = "cancelled";
      break;
    }
    if (classified.provider_constraint) {
      stopReason = "provider_capacity_exhausted";
      break;
    }
    if (!args.session.capabilities.turnControl) {
      stopReason = "natural_stop";
      break;
    }
    if (!args.nextTurnInput) {
      stopReason = "natural_stop";
      break;
    }
    if (turnIndex >= args.maxTurns) {
      stopReason = "max_turns";
      break;
    }

    const currentSummary: SessionSummary = {
      adapter_name: args.adapter.name,
      adapter_session_id: args.session.id,
      ...(args.session.backend_session?.id ? { backend_session_id: args.session.backend_session.id } : {}),
      ...(args.spec.resume_session_id ? { resumed_from_session_id: args.spec.resume_session_id } : {}),
      turns_total: summaries.length,
      terminal_turn_index: turnIndex,
      stop_reason: stopReason,
      turns: summaries,
    };
    turnInput = await args.nextTurnInput({
      turn_index: turnIndex,
      turn_summary: summaries[summaries.length - 1]!,
      session_summary: currentSummary,
      session: args.session,
      terminal_state: classified.state,
      classification: classified.classification,
      ...(classified.partial_reason ? { partial_reason: classified.partial_reason } : {}),
      result: lastResult,
    });
    if (!turnInput) {
      stopReason = "continuation_declined";
      break;
    }
  }

  if (!lastResult || !lastClassified) {
    const message = `Adapter ${args.adapter.name} session ${args.session.id} completed without producing a turn result.`;
    const infraErrorClassification = classifyInfraError({
      site: "backend_spawn",
      message,
    });
    return {
      state: "infra_error",
      classification: classify({
        stderr: message,
        backend_events: [{ event: "infra_failure", payload: { error: message } }],
      }),
      duration_ms: 0,
      classifier_input: {
        stderr: message,
        backend_events: [{ event: "infra_failure", payload: { error: message } }],
      },
      backend_stderr: message,
      spawn_error: message,
      infra_error_classification: infraErrorClassification,
      session_summary: {
        adapter_name: args.adapter.name,
        adapter_session_id: args.session.id,
        ...(args.spec.resume_session_id ? { resumed_from_session_id: args.spec.resume_session_id } : {}),
        turns_total: 0,
        terminal_turn_index: 0,
        stop_reason: "infra_error",
        turns: [],
      },
    };
  }

  const finalState =
    stopReason === "max_turns"
      ? "partial"
      : lastClassified.state;
  const finalPartialReason =
    stopReason === "max_turns"
      ? "max_turns"
      : lastClassified.partial_reason;
  const sessionInfo = args.session.backend_session ?? lastResult.session;
  const mergedStderr = mergeTurnStderr(stderrChunks);
  const terminalEvidence = normalizeTerminalEvidenceForOutcome(
    lastResult,
    finalState,
    lastClassified.provider_constraint,
  );

  return {
    state: finalState,
    classification: lastClassified.classification,
    ...(finalPartialReason ? { partial_reason: finalPartialReason } : {}),
    duration_ms: totalDurationMs,
    classifier_input: {
      stderr: lastResult.stderr,
      event_count: summaries.length,
      backend_events: lastResult.events,
      ...(typeof lastResult.exit_code === "number" ? { exit_code: lastResult.exit_code } : {}),
    },
    ...(sessionInfo
      ? {
          backend_session: {
            id: sessionInfo.id,
            ...(sessionInfo.path ? { path: sessionInfo.path } : {}),
            backend: sessionInfo.backend,
          },
        }
      : {}),
    ...(lastResult.agent_terminal_message ? { agent_terminal_message: lastResult.agent_terminal_message } : {}),
    ...(args.spec.output_capture
      ? {
          output_capture_observation: lastResult.output_capture_observation
            ?? observeTerminalCapture(lastResult.agent_terminal_message),
        }
      : {}),
    ...(mergedStderr ? { backend_stderr: mergedStderr } : {}),
    ...(lastResult.signal ? { backend_signal: lastResult.signal } : {}),
    ...(lastResult.spawn_error ? { spawn_error: lastResult.spawn_error } : {}),
    ...(terminalEvidence ? { terminal_evidence: terminalEvidence } : {}),
    session_summary: {
      adapter_name: args.adapter.name,
      adapter_session_id: args.session.id,
      ...(sessionInfo?.id ? { backend_session_id: sessionInfo.id } : {}),
      ...(args.spec.resume_session_id ? { resumed_from_session_id: args.spec.resume_session_id } : {}),
      turns_total: summaries.length,
      terminal_turn_index: summaries[summaries.length - 1]!.turn_index,
      stop_reason: stopReason,
      turns: summaries,
    },
  };
}

/**
 * Execute a full run pipeline.
 *
 * @param rawSpec - The run specification (will be validated via schema).
 * @param deps - Injectable dependencies (adapter, worktree config, etc.).
 * @returns RunResult with the final receipt, events, and dispatch status.
 */
export async function executeRun(
  rawSpec: unknown,
  deps: RunDeps,
): Promise<RunResult> {
  // Validate spec
  const spec = runSpecSchema.parse(rawSpec) as RunSpec;
  const agentActivity = normalizeAgentActivityConfig(spec);
  const run_id = spec.run_id ?? randomUUID();
  const created_at = new Date().toISOString();

  const ctx: RunContext = {
    run_id,
    state: "queued",
    spec: { ...spec, run_id },
    events: [],
    created_at,
  };
  let agentActivityTimer: NodeJS.Timeout | undefined;
  let agentActivityStartedAtMs = Number.NaN;
  let lastAgentProgressAtMs: number | undefined;
  let agentExpectedSilenceUntilMs: number | undefined;
  let lastAgentProgressLabel: "lifecycle" | "stdout" | "stderr" | "turn" | "claude_stream" | undefined;
  let agentProgressSignal: AgentProgressSignal = {
    source: spec.backend === "claude" ? "claude_stream" : "adapter_activity",
    status: "unavailable",
    reason: "awaiting_first_signal",
  };
  let lastAgentHealthSnapshot: RunHealthSnapshot | undefined;
  const emitAgentHealth = (checkedAtMs: number, force = false): void => {
    if (!Number.isFinite(agentActivityStartedAtMs)) {
      return;
    }
    const referenceMs = lastAgentProgressAtMs ?? agentActivityStartedAtMs;
    const ageMs = Math.max(0, checkedAtMs - referenceMs);
    const withinExpectedSilence = agentExpectedSilenceUntilMs !== undefined
      && checkedAtMs <= agentExpectedSilenceUntilMs;
    const status: RunHealthSnapshot["status"] = agentProgressSignal.status !== "available"
      ? "unknown"
      : lastAgentProgressAtMs === undefined
        ? "unknown"
        : ageMs > agentActivity.stale_after_ms && !withinExpectedSilence ? "stale" : "healthy";
    const observationKind = lastAgentProgressLabel
      ?? (agentProgressSignal.source === "claude_stream" ? "claude_stream" : "lifecycle");
    const snapshot: RunHealthSnapshot = {
      source: "agent_runner",
      status,
      checked_at: new Date(checkedAtMs).toISOString(),
      stale_after_ms: agentActivity.stale_after_ms,
      ...(lastAgentProgressAtMs ? { last_activity_at: new Date(lastAgentProgressAtMs).toISOString() } : {}),
      ...(lastAgentProgressAtMs ? { last_progress_at: new Date(lastAgentProgressAtMs).toISOString() } : {}),
      observations: [{
        kind: observationKind,
        label: observationKind === "lifecycle" ? "runner lifecycle" : observationKind,
        exists: agentProgressSignal.status === "available",
        ...(lastAgentProgressAtMs ? { last_modified_at: new Date(lastAgentProgressAtMs).toISOString() } : {}),
      }],
      progress_signal: agentProgressSignal,
      summary: buildAgentRunnerHealthSummary({
        status,
        staleAfterMs: agentActivity.stale_after_ms,
        ...(lastAgentProgressAtMs ? { lastProgressAtMs: lastAgentProgressAtMs } : {}),
        ...(lastAgentProgressLabel ? { label: lastAgentProgressLabel } : {}),
        progressSignal: agentProgressSignal,
      }),
    };
    if (
      force
      || !lastAgentHealthSnapshot
      || lastAgentHealthSnapshot.status !== snapshot.status
      || lastAgentHealthSnapshot.last_progress_at !== snapshot.last_progress_at
    ) {
      lastAgentHealthSnapshot = snapshot;
      deps.onHealthUpdate?.(snapshot);
    }
  };
  const markAgentActivity = (
    source: "lifecycle" | "stdout" | "stderr" | "turn" | "claude_stream",
    timestamp?: string,
    semantic = true,
    signal?: AgentProgressSignal,
    expectedSilenceMs?: number,
  ): void => {
    const atMs = timestamp ? new Date(timestamp).getTime() : Date.now();
    if (!Number.isFinite(atMs)) {
      return;
    }
    if (signal) {
      agentProgressSignal = signal;
      if (signal.status !== "available") {
        agentExpectedSilenceUntilMs = undefined;
      }
    }
    if (!semantic) {
      emitAgentHealth(atMs, true);
      return;
    }
    if (agentProgressSignal.status !== "available") {
      agentProgressSignal = {
        source: source === "claude_stream" ? "claude_stream" : "adapter_activity",
        status: "available",
        reason: source === "claude_stream" ? "semantic_event" : "adapter_activity",
      };
    }
    lastAgentProgressAtMs = atMs;
    lastAgentProgressLabel = source;
    agentExpectedSilenceUntilMs = expectedSilenceMs !== undefined
      ? atMs + expectedSilenceMs + agentActivity.stale_after_ms
      : undefined;
    agentProgressSignal = {
      source: agentProgressSignal.source,
      status: agentProgressSignal.status,
      reason: agentProgressSignal.reason,
      ...(agentExpectedSilenceUntilMs !== undefined
        ? { expected_silence_until: new Date(agentExpectedSilenceUntilMs).toISOString() }
        : {}),
    };
    if (source === "lifecycle" || source === "turn") {
      emitAgentHealth(atMs, true);
    }
  };

  const emit = (
    event: Omit<LifecycleEvent, "timestamp" | "run_id">,
    notify = true,
  ): LifecycleEvent => {
    const ev: LifecycleEvent = {
      timestamp: new Date().toISOString(),
      run_id: ctx.run_id,
      ...event,
    };
    ctx.events.push(ev);
    if (notify) {
      deps.onEvent?.(ev);
    }
    if (
      Number.isFinite(agentActivityStartedAtMs)
      && (
        ev.event === "state_transition"
        || ev.event === "backend_spawned"
        || ev.event === "backend_event"
        || ev.event === "warning"
        || ev.event === "error"
      )
    ) {
      if (spec.backend !== "claude") {
        markAgentActivity("lifecycle", ev.timestamp);
      }
    }
    return ev;
  };

  const transition = (
    to: RunState,
    message?: string,
    infraErrorClassification?: InfraErrorClassification,
    notify = true,
  ): LifecycleEvent => {
    assertTransition(ctx.state, to);
    const from = ctx.state;
    ctx.state = to;
    const transitionEvent: Omit<LifecycleEvent, "timestamp" | "run_id"> = {
      event: "state_transition",
      from,
      to,
    };
    if (message !== undefined) transitionEvent.message = message;
    if (to === "infra_error") {
      transitionEvent.infra_error_classification = normalizeInfraErrorClassification(
        infraErrorClassification,
        { message },
      );
    }
    return emit(transitionEvent, notify);
  };

  // ── Step 1: Dispatch gate ────────────────────────────────────────
  transition("dispatching", "Evaluating dispatch gate");
  ctx.dispatched_at = new Date().toISOString();

  emit({ event: "dispatch_started", message: "Running dispatch checks" });

  const dispatchReceipt = evaluateDispatch(ctx.spec, {
    run_id: ctx.run_id,
    timestamp: ctx.dispatched_at,
  });

  if (dispatchReceipt.decision === "rejected") {
    const rejMsg = dispatchReceipt.rejection_reason ?? "Dispatch checks failed";
    emit({
      event: "dispatch_rejected",
      message: rejMsg,
      payload: { dispatch_receipt: dispatchReceipt as unknown as Record<string, unknown> },
    });

    const infraErrorClassification = classifyInfraError({
      site: "runner_task",
      message: `Dispatch rejected: ${rejMsg}`,
    });
    const terminalEvent = transition(
      "infra_error",
      `Dispatch rejected: ${rejMsg}`,
      infraErrorClassification,
      false,
    );

    const classification = classify({ exit_code: 9 });
    const artifacts = evaluateArtifactGate(ctx.run_id, spec.required_artifacts ?? [], []);
    const completed_at = new Date().toISOString();

    const receiptCtx: ReceiptBuildContext = {
      run_id: ctx.run_id,
      state: ctx.state,
      spec: ctx.spec,
      classification,
      artifacts,
      events: ctx.events,
      environment: buildEnvironment(spec),
      infra_error_classification: infraErrorClassification,
      timing: {
        created_at: ctx.created_at,
        dispatched_at: ctx.dispatched_at,
        completed_at,
        dispatch_duration_ms:
          new Date(completed_at).getTime() - new Date(ctx.dispatched_at).getTime(),
      },
    };

    const receipt = buildRunReceipt(receiptCtx);

    if (deps.receiptPath) {
      await writeReceipt(receipt, deps.receiptPath);
    }
    deps.onEvent?.(terminalEvent);

    return { receipt, events: ctx.events, dispatch_accepted: false };
  }

  emit({
    event: "dispatch_passed",
    message: `Dispatch accepted (lane: ${dispatchReceipt.lane ?? "unknown"})`,
    payload: { dispatch_receipt: dispatchReceipt as unknown as Record<string, unknown> },
  });

  // ── Step 2: Worktree acquisition ─────────────────────────────────
  const wtResult = await acquireWorktree(spec.worktree, ctx.run_id, deps.worktree);

  if (!wtResult.acquired) {
    emit({
      event: "error",
      message: `Worktree acquisition failed: ${wtResult.error ?? "unknown"}`,
    });
    const infraErrorClassification = classifyInfraError({
      site: "worktree_acquisition",
      message: `Worktree acquisition failed: ${wtResult.error ?? "unknown"}`,
    });
    const terminalEvent = transition(
      "infra_error",
      infraErrorClassification.message,
      infraErrorClassification,
      false,
    );

    const classification = classify({ exit_code: 6 });
    const artifacts = evaluateArtifactGate(ctx.run_id, spec.required_artifacts ?? [], []);
    const completed_at = new Date().toISOString();

    const receiptCtx: ReceiptBuildContext = {
      run_id: ctx.run_id,
      state: ctx.state,
      spec: ctx.spec,
      classification,
      artifacts,
      events: ctx.events,
      environment: buildEnvironment(spec, { worktree_path: wtResult.path }),
      infra_error_classification: infraErrorClassification,
      timing: {
        created_at: ctx.created_at,
        dispatched_at: ctx.dispatched_at,
        completed_at,
      },
    };

    const receipt = buildRunReceipt(receiptCtx);

    if (deps.receiptPath) {
      await writeReceipt(receipt, deps.receiptPath);
    }
    deps.onEvent?.(terminalEvent);

    return { receipt, events: ctx.events, dispatch_accepted: true };
  }

  let worktreeLeaseTimer: NodeJS.Timeout | undefined;
  if (wtResult.lease && deps.worktree.lease?.renew) {
    const intervalMs = Math.max(1_000, Math.min(60_000, Math.floor(wtResult.lease.ttl_ms / 2)));
    worktreeLeaseTimer = setInterval(() => {
      if (!wtResult.lease || !deps.worktree.lease?.renew) return;
      void deps.worktree.lease.renew(wtResult.lease)
        .then((lease) => {
          wtResult.lease = lease;
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          emit({
            event: "warning",
            message: `Worktree lease renewal failed: ${message}`,
            payload: { worktree_path: wtResult.path, lease_key: wtResult.lease?.key },
          });
        });
    }, intervalMs);
    worktreeLeaseTimer.unref?.();
  }

  // ── Step 3: Backend execution ────────────────────────────────────
  transition("running", `Backend ${spec.backend} starting in ${wtResult.path}`);
  ctx.started_at = new Date().toISOString();
  agentActivityStartedAtMs = new Date(ctx.started_at).getTime();
  markAgentActivity("lifecycle", ctx.started_at, spec.backend !== "claude");
  agentActivityTimer = setInterval(() => {
    emitAgentHealth(Date.now());
  }, agentActivity.poll_interval_ms);
  agentActivityTimer.unref?.();

  const prompt = spec.prompt ?? spec.prompt_file ?? spec.prompt_template ?? "";
  const calyxMetadataEnv = buildCalyxRunMetadataEnv({
    run_id: ctx.run_id,
    host: spec.host,
    worktree: wtResult.path,
    ...(spec.issue ? { issue: spec.issue } : {}),
    ...(deps.receiptPath ? { run_dir: path.dirname(deps.receiptPath) } : {}),
  });
  const backendOptions = spec.output_capture
    ? spec.backend_options
    : mergeBackendOptionsWithCalyxRunMetadataEnv(spec.backend_options, calyxMetadataEnv);
  const startOpts: AdapterStartOptions = {
    run_id: ctx.run_id,
    cwd: wtResult.path,
    onEvent: (ev) => {
      ctx.events.push(ev);
      deps.onEvent?.(ev);
      if (
        ev.event === "state_transition"
        || ev.event === "backend_spawned"
        || ev.event === "backend_event"
        || ev.event === "warning"
        || ev.event === "error"
      ) {
        if (spec.backend !== "claude") {
          markAgentActivity("lifecycle", ev.timestamp);
        }
      }
    },
    onActivity: (activity) => {
      markAgentActivity(
        activity.source,
        activity.timestamp,
        activity.semantic ?? true,
        activity.signal,
        activity.expected_silence_ms,
      );
    },
    onSession: (backendSession) => {
      deps.onSessionCheckpoint?.({
        adapter_session_id: session?.id ?? `${deps.adapter.name}-starting-session`,
        backend_session: backendSession,
        timestamp: new Date().toISOString(),
      });
    },
    ...(deps.receiptPath ? { run_dir: path.dirname(deps.receiptPath) } : {}),
    ...(spec.output_capture ? { output_capture: spec.output_capture } : {}),
    ...(spec.output_capture && deps.backendEnvironmentRedactions
      ? { environment_redactions: deps.backendEnvironmentRedactions }
      : {}),
  };
  if (backendOptions !== undefined) {
    startOpts.backend_options = backendOptions;
  }
  if (spec.system_prompt !== undefined) {
    startOpts.system_prompt = spec.system_prompt;
  }
  if (spec.append_system_prompt !== undefined) {
    startOpts.append_system_prompt = spec.append_system_prompt;
  }
  if (spec.resume_session_id !== undefined) {
    startOpts.resume_session_id = spec.resume_session_id;
  }

  const exitPipeline = deps.exitClassifierPipeline ?? new ClassifierPipeline();
  let session: AdapterSession | undefined;
  let sessionResult: SessionExecutionResult;
  try {
    session = await ensureAdapterSession(deps.adapter, startOpts);
    deps.onSessionCheckpoint?.({
      adapter_session_id: session.id,
      ...(session.backend_session ? { backend_session: session.backend_session } : {}),
      timestamp: new Date().toISOString(),
    });
    sessionResult = await executeSession({
      spec: ctx.spec,
      adapter: deps.adapter,
      session,
      initialInput: { prompt },
      maxTurns: ctx.spec.max_turns_per_run ?? 1,
      emit,
      exitClassifierPipeline: exitPipeline,
      nextTurnInput: deps.nextTurnInput,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const infraErrorClassification = classifyInfraError({
      site: "backend_spawn",
      message: `Adapter session failed: ${message}`,
    });
    emit({
      event: "error",
      message: infraErrorClassification.message,
      payload: { backend: spec.backend },
    });
    sessionResult = {
      state: "infra_error",
      classification: classify({
        stderr: message,
        backend_events: [{ event: "infra_failure", payload: { error: message } }],
      }),
      duration_ms: 0,
      classifier_input: {
        stderr: message,
        backend_events: [{ event: "infra_failure", payload: { error: message } }],
      },
      backend_stderr: message,
      spawn_error: message,
      infra_error_classification: infraErrorClassification,
      session_summary: {
        adapter_name: deps.adapter.name,
        adapter_session_id: session?.id ?? `${deps.adapter.name}-failed-session`,
        ...(spec.resume_session_id ? { resumed_from_session_id: spec.resume_session_id } : {}),
        turns_total: 0,
        terminal_turn_index: 0,
        stop_reason: "infra_error",
        turns: [],
      },
    };
  } finally {
    if (session) {
      try {
        await session.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit({
          event: "warning",
          message: `Adapter session close failed: ${message}`,
          payload: { backend: spec.backend, adapter_session_id: session.id },
        });
      }
    }
  }
  if (agentActivityTimer) {
    clearInterval(agentActivityTimer);
    agentActivityTimer = undefined;
  }
  if (Number.isFinite(agentActivityStartedAtMs)) {
    emitAgentHealth(Date.now(), true);
  }

  // ── Step 4: Classification ───────────────────────────────────────
  const legacyDiscovered = deps.discoverArtifacts
    ? await deps.discoverArtifacts(wtResult.path, ctx.run_id)
    : [];

  const classifierInput: ClassifierInput = {
    ...sessionResult.classifier_input,
    event_count: ctx.events.length,
    final_artifact_present: legacyDiscovered.length > 0,
  };
  let classification = sessionResult.classification;
  const partialReason = sessionResult.partial_reason;
  let terminalState = sessionResult.state;
  const artifactAwareClassification = classify(classifierInput);
  if (
    terminalState === "failed"
    && artifactAwareClassification.class === "completed_dirty"
  ) {
    classification = artifactAwareClassification;
    terminalState = "completed_dirty";
  }

  let capturedArtifact: ArtifactEntry | undefined;
  let outputCaptureError: RunOutputCaptureError | undefined;
  if (spec.output_capture && sessionResult.output_capture_observation?.status === "limit_exceeded") {
    outputCaptureError = new RunOutputCaptureError(
      `Terminal JSON output exceeded ${spec.output_capture.max_bytes} bytes; ${sessionResult.output_capture_observation.bytes_observed} bytes were observed before provider teardown.`,
      "invalid_output",
    );
    classification = {
      class: "task_failure",
      source: "heuristic",
      confidence: "definitive",
      signal: `output capture rejected: ${outputCaptureError.message}`,
      ...(sessionResult.classifier_input.exit_code !== undefined
        ? { raw_exit_code: sessionResult.classifier_input.exit_code }
        : {}),
      effective_exit_code: 1,
    };
    terminalState = "failed";
    emit({
      event: "artifact_gate_failed",
      message: outputCaptureError.message,
      payload: {
        name: spec.output_capture.name,
        failure_kind: outputCaptureError.failure_kind,
        bytes_observed: sessionResult.output_capture_observation.bytes_observed,
        sha256: sessionResult.output_capture_observation.sha256,
      },
    });
  } else if (spec.output_capture && terminalState === "succeeded") {
    try {
      capturedArtifact = await materializeRunOutputCapture({
        run_id: ctx.run_id,
        run_dir: deps.receiptPath ? path.dirname(deps.receiptPath) : undefined,
        capture: spec.output_capture,
        terminal_message: sessionResult.agent_terminal_message,
      });
      emit({
        event: "artifact_detected",
        message: `Materialized typed terminal output ${capturedArtifact.name}`,
        payload: {
          name: capturedArtifact.name,
          location: capturedArtifact.location,
          size_bytes: capturedArtifact.size_bytes,
          sha256: capturedArtifact.sha256,
        },
      });
    } catch (error) {
      outputCaptureError = error instanceof RunOutputCaptureError
        ? error
        : new RunOutputCaptureError(
            error instanceof Error ? error.message : String(error),
            "materialization_failed",
          );
      if (outputCaptureError.failure_kind === "invalid_output") {
        classification = {
          class: "task_failure",
          source: "heuristic",
          confidence: "definitive",
          signal: `output capture rejected: ${outputCaptureError.message}`,
          ...(sessionResult.classifier_input.exit_code !== undefined
            ? { raw_exit_code: sessionResult.classifier_input.exit_code }
            : {}),
          effective_exit_code: 1,
        };
        terminalState = "failed";
      } else {
        classification = {
          class: "infra_error",
          source: "heuristic",
          confidence: "definitive",
          signal: `output capture materialization failed: ${outputCaptureError.message}`,
          ...(sessionResult.classifier_input.exit_code !== undefined
            ? { raw_exit_code: sessionResult.classifier_input.exit_code }
            : {}),
          effective_exit_code: 6,
        };
        terminalState = "infra_error";
      }
      emit({
        event: "artifact_gate_failed",
        message: outputCaptureError.message,
        payload: {
          name: spec.output_capture.name,
          failure_kind: outputCaptureError.failure_kind,
        },
      });
    }
  }

  // ── Step 5: Artifact gate ────────────────────────────────────────
  // A runner-owned terminal capture is a distinct evidence lane. Never allow a
  // same-named file found in the checkout to satisfy its required-artifact gate.
  const eligibleLegacyDiscovered = spec.output_capture
    ? legacyDiscovered.filter(
        (artifact) => artifact.name !== spec.output_capture?.name,
      )
    : legacyDiscovered;
  const discovered = capturedArtifact
    ? [...eligibleLegacyDiscovered, capturedArtifact]
    : eligibleLegacyDiscovered;
  const requiredArtifacts = spec.output_capture
    ? [...(spec.required_artifacts ?? []), spec.output_capture.name]
    : (spec.required_artifacts ?? []);
  const artifacts = evaluateArtifactGate(
    ctx.run_id,
    requiredArtifacts,
    discovered,
  );

  if (artifacts.gate_passed) {
    emit({ event: "artifact_gate_passed", message: "All required artifacts present" });
  } else {
    emit({
      event: "artifact_gate_failed",
      message: `Missing artifacts: ${artifacts.missing.join(", ")}`,
      payload: { missing: artifacts.missing },
    });
  }

  // ── Step 6: Terminal state transition ────────────────────────────
  const transitionMsg = terminalState === "partial"
    ? `Classified as partial (${partialReason ?? "unknown"})`
    : `Classified as ${classification.class} (${classification.source})`;
  const infraErrorClassification = terminalState === "infra_error"
    ? outputCaptureError?.failure_kind === "materialization_failed"
      ? classifyInfraError({ site: "runner_task", message: outputCaptureError.message })
      : normalizeInfraErrorClassification(sessionResult.infra_error_classification, {
          site: "backend_spawn",
          message: sessionResult.spawn_error
            ?? sessionResult.backend_stderr
            ?? transitionMsg,
        })
    : undefined;
  const terminalEvent = transition(
    terminalState,
    transitionMsg,
    infraErrorClassification,
    false,
  );

  // ── Step 7: Receipt ──────────────────────────────────────────────
  const completed_at = new Date().toISOString();

  const timingCtx: ReceiptBuildContext["timing"] = {
    created_at: ctx.created_at,
    completed_at,
    backend_duration_ms: sessionResult.duration_ms,
  };
  if (ctx.dispatched_at !== undefined) timingCtx.dispatched_at = ctx.dispatched_at;
  if (ctx.started_at !== undefined) timingCtx.started_at = ctx.started_at;
  if (ctx.dispatched_at !== undefined && ctx.started_at !== undefined) {
    timingCtx.dispatch_duration_ms =
      new Date(ctx.started_at).getTime() - new Date(ctx.dispatched_at).getTime();
  }

  const receiptCtx: ReceiptBuildContext = {
    run_id: ctx.run_id,
    state: ctx.state,
    spec: ctx.spec,
    classification,
    artifacts,
    events: ctx.events,
    environment: buildEnvironment(spec, {
      worktree_path: wtResult.path,
      ...(spec.worktree.branch !== undefined ? { branch: spec.worktree.branch } : {}),
    }),
    timing: timingCtx,
    ...(sessionResult.backend_session ? { backend_session: sessionResult.backend_session } : {}),
    ...(!spec.output_capture && sessionResult.agent_terminal_message ? {
      agent_terminal_message: sessionResult.agent_terminal_message,
    } : {}),
    ...(partialReason ? { partial_reason: partialReason } : {}),
    ...(infraErrorClassification ? { infra_error_classification: infraErrorClassification } : {}),
    ...(sessionResult.backend_stderr ? {
      backend_stderr: sessionResult.backend_stderr.slice(0, 10240),
    } : {}),
    ...(sessionResult.backend_signal ? { backend_signal: sessionResult.backend_signal } : {}),
    ...(sessionResult.spawn_error ? { spawn_error: sessionResult.spawn_error } : {}),
    ...(lastAgentHealthSnapshot ? { health: lastAgentHealthSnapshot } : {}),
    ...(sessionResult.terminal_evidence ? { terminal_evidence: sessionResult.terminal_evidence } : {}),
    metadata: {
      ...(spec.backend_options?.model
        ? {
            backend_model: {
              requested: spec.backend_options.model,
              applied: spec.backend_options.model,
              source: "backend_options.model",
            },
          }
        : {}),
      session_summary: sessionResult.session_summary,
      ...(spec.output_capture
        ? {
            output_capture: {
              status: capturedArtifact
                ? "materialized"
                : outputCaptureError
                  ? "rejected"
                  : sessionResult.output_capture_observation?.status ?? "incomplete",
              bytes_observed: sessionResult.output_capture_observation?.bytes_observed ?? 0,
              sha256: sessionResult.output_capture_observation?.sha256
                ?? createHash("sha256").digest("hex"),
              ...(outputCaptureError
                ? {
                    failure_kind: outputCaptureError.failure_kind,
                    error: outputCaptureError.message,
                  }
                : sessionResult.output_capture_observation?.status !== "complete"
                  ? {
                      error: sessionResult.spawn_error
                        ?? classification.signal,
                    }
                  : {}),
              ...(capturedArtifact
                ? {
                    artifact: {
                      name: capturedArtifact.name,
                      size_bytes: capturedArtifact.size_bytes,
                      sha256: capturedArtifact.sha256,
                    },
                  }
                : {}),
            },
          }
        : {}),
    },
  };

  const receipt = buildRunReceipt(receiptCtx);

  if (deps.receiptPath) {
    await writeReceipt(receipt, deps.receiptPath);
  }
  deps.onEvent?.(terminalEvent);

  // ── Step 8: Cleanup ──────────────────────────────────────────────
  if (worktreeLeaseTimer) {
    clearInterval(worktreeLeaseTimer);
    worktreeLeaseTimer = undefined;
  }
  try {
    await releaseWorktree(wtResult.path, deps.worktree, wtResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({
      event: "warning",
      message: `Failed to release worktree ${wtResult.path}: ${message}`,
      payload: { worktree_path: wtResult.path },
    });
  }

  return { receipt, events: ctx.events, dispatch_accepted: true };
}

/** Map a FailureClass to the corresponding terminal RunState. */
function classToState(cls: FailureClass): RunState {
  switch (cls) {
    case "success": return "succeeded";
    case "task_failure": return "failed";
    case "auth_error": return "auth_error";
    case "infra_error": return "infra_error";
    case "completed_dirty": return "completed_dirty";
    case "dispatch_rejected": return "infra_error";
    default: {
      const exhaustive: never = cls;
      throw new Error(`Unhandled failure class ${String(exhaustive)}`);
    }
  }
}

export type { SessionExecutionResult };
