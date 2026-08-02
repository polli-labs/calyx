/**
 * @polli-labs/calyx-runner — Artifact gate and receipt emission.
 *
 * Evaluates required artifacts against discovered artifacts, produces
 * an ArtifactManifest, and builds a complete RunReceipt from execution
 * context.
 *
 * @see docs/architecture/async-runner-vnext-contracts.md
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AgentTerminalEvidence,
  ArtifactEntry,
  ArtifactManifest,
  ClassificationResult,
  InfraErrorClassification,
  LifecycleEvent,
  PartialReason,
  ReceiptBackendSession,
  ReceiptEnvironment,
  ReceiptExit,
  ReceiptLogSummary,
  ReceiptTiming,
  RunReceipt,
  RunHealthSnapshot,
  RunSpec,
  RunState,
} from "./types.js";
import { runReceiptSchema } from "./schemas.js";
import { normalizeInfraErrorClassification } from "./infra-error.js";

/**
 * Evaluate the artifact gate: compare required artifacts against discovered.
 *
 * @param run_id - The run identifier.
 * @param requiredNames - List of artifact names that must be present.
 * @param discovered - Artifacts actually found after execution.
 * @returns ArtifactManifest with gate_passed and missing list.
 */
export function evaluateArtifactGate(
  run_id: string,
  requiredNames: string[],
  discovered: ArtifactEntry[],
): ArtifactManifest {
  const discoveredNames = new Set(discovered.map((a) => a.name));
  const missing = requiredNames.filter((name) => !discoveredNames.has(name));
  const required = discovered.filter((a) => requiredNames.includes(a.name));

  return {
    run_id,
    finalized_at: new Date().toISOString(),
    required,
    discovered,
    gate_passed: missing.length === 0,
    missing,
  };
}

/** Context needed to build a RunReceipt. */
export interface ReceiptBuildContext {
  run_id: string;
  state: RunState;
  spec: RunSpec;
  classification?: ClassificationResult;
  artifacts: ArtifactManifest;
  events: LifecycleEvent[];
  environment: ReceiptEnvironment;
  timing: {
    created_at: string;
    dispatched_at?: string;
    started_at?: string;
    completed_at: string;
    dispatch_duration_ms?: number;
    backend_duration_ms?: number;
  };
  ntfy_sent?: boolean;
  agent_mail_sent?: boolean;
  /** Backend session locator from adapter result. */
  backend_session?: ReceiptBackendSession;
  /** Agent terminal message from adapter result. */
  agent_terminal_message?: string;
  /** Partial reason when state is `partial`. */
  partial_reason?: PartialReason;
  /** Typed infra_error classification when state is `infra_error`. */
  infra_error_classification?: InfraErrorClassification;
  /** Captured stderr from the backend process (truncated to 10KB for diagnostics). */
  backend_stderr?: string;
  /** Signal that killed the backend process, if any. */
  backend_signal?: string;
  /** Spawn-level error (e.g., maxBuffer overflow), if any. */
  spawn_error?: string;
  /** Latest sparse health snapshot observed before terminal receipt materialization. */
  health?: RunHealthSnapshot;
  /** Sparse terminal lifecycle evidence from the backend stream. */
  terminal_evidence?: AgentTerminalEvidence;
  /** Additional metadata merged into receipt.metadata after spec provenance. */
  metadata?: Record<string, unknown>;
}

/**
 * Build a complete RunReceipt from execution context.
 * The receipt is validated against the schema before returning.
 */
export function buildRunReceipt(ctx: ReceiptBuildContext): RunReceipt {
  const logSummary = summarizeEvents(ctx.events);

  const duration_ms =
    new Date(ctx.timing.completed_at).getTime() -
    new Date(ctx.timing.created_at).getTime();

  // Build timing with only defined optional fields
  const timing: ReceiptTiming = {
    created_at: ctx.timing.created_at,
    completed_at: ctx.timing.completed_at,
    duration_ms,
  };
  if (ctx.timing.dispatched_at !== undefined) timing.dispatched_at = ctx.timing.dispatched_at;
  if (ctx.timing.started_at !== undefined) timing.started_at = ctx.timing.started_at;
  if (ctx.timing.dispatch_duration_ms !== undefined) timing.dispatch_duration_ms = ctx.timing.dispatch_duration_ms;
  if (ctx.timing.backend_duration_ms !== undefined) timing.backend_duration_ms = ctx.timing.backend_duration_ms;

  // Build exit with only defined optional fields
  const exit: ReceiptExit = {};
  if (ctx.classification) {
    exit.exit_code = ctx.classification.effective_exit_code;
    exit.failure_class = ctx.classification.class;
    exit.failure_source = ctx.classification.source;
  }
  const infraErrorClassification = ctx.state === "infra_error"
    ? normalizeInfraErrorClassification(ctx.infra_error_classification, {
        message: ctx.backend_stderr ?? ctx.spawn_error ?? ctx.events.at(-1)?.message ?? ctx.classification?.signal,
      })
    : undefined;
  if (infraErrorClassification) {
    exit.failure_layer = infraErrorClassification.failure_layer;
    exit.failure_reason = infraErrorClassification.failure_reason;
  }
  if (ctx.partial_reason !== undefined) {
    exit.partial_reason = ctx.partial_reason;
  }

  const receipt: RunReceipt = {
    schema_version: "1.0",
    run_id: ctx.run_id,
    state: ctx.state,
    ...(infraErrorClassification ? { infra_error_classification: infraErrorClassification } : {}),
    run_spec: ctx.spec,
    timing,
    exit,
    artifacts: ctx.artifacts,
    log_summary: logSummary,
    environment: ctx.environment,
    summary: buildSummaryLine(ctx.state, logSummary, ctx.artifacts),
  };

  // Build metadata — merge spec.metadata with resume provenance
  const hasSpecMeta = ctx.spec.metadata !== undefined;
  const hasResume = ctx.spec.resume_session_id !== undefined;
  const hasContextMeta = ctx.metadata !== undefined;
  if (hasSpecMeta || hasResume || hasContextMeta) {
    receipt.metadata = {
      ...(hasSpecMeta ? ctx.spec.metadata : {}),
      ...(hasResume ? { resumed_from_session_id: ctx.spec.resume_session_id } : {}),
      ...(hasContextMeta ? ctx.metadata : {}),
    };
  }
  if (ctx.backend_session !== undefined) receipt.backend_session = ctx.backend_session;
  if (ctx.agent_terminal_message !== undefined) receipt.agent_terminal_message = ctx.agent_terminal_message;
  if (ctx.backend_stderr !== undefined) receipt.backend_stderr = ctx.backend_stderr;
  if (ctx.backend_signal !== undefined) receipt.backend_signal = ctx.backend_signal;
  if (ctx.spawn_error !== undefined) receipt.spawn_error = ctx.spawn_error;
  if (ctx.health !== undefined) receipt.health = ctx.health;
  if (ctx.terminal_evidence !== undefined) receipt.terminal_evidence = ctx.terminal_evidence;

  if (ctx.ntfy_sent !== undefined || ctx.agent_mail_sent !== undefined) {
    receipt.notifications = {};
    if (ctx.ntfy_sent !== undefined) receipt.notifications.ntfy_sent = ctx.ntfy_sent;
    if (ctx.agent_mail_sent !== undefined) receipt.notifications.agent_mail_sent = ctx.agent_mail_sent;
  }

  // Validate before returning
  runReceiptSchema.parse(receipt);

  return receipt;
}

/**
 * Write a receipt to disk as JSON.
 */
export async function writeReceipt(receipt: RunReceipt, path: string): Promise<void> {
  runReceiptSchema.parse(receipt);
  await writeReceiptAtomically(receipt, path);
}

/**
 * Publish a validated receipt payload without exposing a torn final path.
 * The temp file and parent directory are fsynced before success returns, so a
 * recovery reader sees either the previous complete receipt or the new one.
 */
export async function writeReceiptAtomically(receipt: unknown, path: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  let preparationError: unknown;
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    preparationError = error;
  } finally {
    await handle.close();
  }
  if (preparationError) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw preparationError;
  }
  try {
    await rename(temporaryPath, path);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Summarize lifecycle events into log-level counts. */
function summarizeEvents(events: LifecycleEvent[]): ReceiptLogSummary {
  let info = 0;
  let warn = 0;
  let error = 0;

  for (const ev of events) {
    if (ev.event === "error") {
      error++;
    } else if (ev.event === "warning") {
      warn++;
    } else {
      info++;
    }
  }

  return { total: events.length, info, warn, error };
}

/** Build a one-line summary string for the receipt. */
function buildSummaryLine(
  state: RunState,
  logSummary: ReceiptLogSummary,
  artifacts: ArtifactManifest,
): string {
  const stateLabel =
    state === "succeeded" ? "completed successfully" :
    state === "partial" ? "completed partially" :
    state === "completed_dirty" ? "completed dirty (artifacts present)" :
    `terminated in state '${state}'`;

  const parts = [`Run ${stateLabel}`, `${logSummary.total} log entries`];

  if (artifacts.missing.length > 0) {
    parts.push(`${artifacts.missing.length} missing artifact(s)`);
  } else {
    parts.push("0 missing artifacts");
  }

  return parts.join(": ") + ".";
}
