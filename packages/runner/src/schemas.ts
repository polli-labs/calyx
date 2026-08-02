/**
 * @polli-labs/calyx-runner — Zod validation schemas.
 *
 * Runtime-validated schemas for all runner contracts.
 * Each schema corresponds to a type in types.ts.
 *
 * @see docs/architecture/async-runner-vnext-contracts.md
 */

import { z } from "zod";
import {
  BACKEND_REASONING_EFFORTS,
  INFRA_ERROR_CLASSIFICATION_SCHEMA_VERSION,
  INFRA_ERROR_FAILURE_LAYERS,
  INFRA_ERROR_FAILURE_REASONS,
  PROVIDER_CONSTRAINT_KINDS,
  PROVIDER_CONSTRAINT_SCHEMA_VERSION,
  PROVIDER_CONSTRAINT_SOURCES,
} from "./types.js";

// ── Run lifecycle ───────────────────────────────────────────────────

export const runStateSchema = z.enum([
  "queued",
  "dispatching",
  "running",
  "succeeded",
  "failed",
  "partial",
  "cancelled",
  "auth_error",
  "infra_error",
  "completed_dirty",
]);

// ── Partial reason ──────────────────────────────────────────────────

export const partialReasonSchema = z.enum([
  "budget_exhaustion",
  "context_limit",
  "max_turns",
  "graceful_stop",
  "operator_stop",
  "unknown",
]);

export const providerConstraintSchema = z.object({
  schema_version: z.literal(PROVIDER_CONSTRAINT_SCHEMA_VERSION),
  cause: z.literal("provider_capacity_exhausted"),
  backend: z.string().min(1).max(64),
  kind: z.enum(PROVIDER_CONSTRAINT_KINDS),
  source: z.enum(PROVIDER_CONSTRAINT_SOURCES),
  observed_at: z.string().datetime(),
  confidence: z.literal("definitive"),
  provider_code: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/u).optional(),
  http_status: z.number().int().min(100).max(599).optional(),
  reset_hint: z.string().min(1).max(256).optional(),
}).strict();

// ── Infra error classification ─────────────────────────────────────

export const infraErrorFailureLayerSchema = z.enum(INFRA_ERROR_FAILURE_LAYERS);
export const infraErrorFailureReasonSchema = z.enum(INFRA_ERROR_FAILURE_REASONS);

export const infraErrorClassificationSchema = z.object({
  schema_version: z.literal(INFRA_ERROR_CLASSIFICATION_SCHEMA_VERSION),
  failure_layer: infraErrorFailureLayerSchema,
  failure_reason: infraErrorFailureReasonSchema,
  message: z.string().min(1),
});

// ── Failure classification ──────────────────────────────────────────

export const failureClassSchema = z.enum([
  "success",
  "task_failure",
  "auth_error",
  "infra_error",
  "completed_dirty",
  "dispatch_rejected",
]);

export const failureSourceSchema = z.enum([
  "exit_code",
  "backend_event",
  "stderr_pattern",
  "heuristic",
  "dispatch_gate",
]);

export const classificationResultSchema = z.object({
  class: failureClassSchema,
  source: failureSourceSchema,
  confidence: z.enum(["definitive", "heuristic"]),
  signal: z.string().min(1),
  raw_exit_code: z.number().int().optional(),
  effective_exit_code: z.number().int(),
});

// ── Run spec ────────────────────────────────────────────────────────

export const worktreeSpecSchema = z.object({
  mode: z.enum(["existing", "managed", "create"]).optional(),
  path: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  ref: z.string().min(1).default("origin/main"),
  reset_on_reuse: z.boolean().default(false),
  branch: z.string().min(1).optional(),
  steal_lock: z.boolean().default(false),
});

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema).describe("calyx-open-dictionary:run-output-capture.schema"),
]));

export const runOutputCaptureSchema = z.object({
  name: z.string().min(1),
  source: z.literal("agent_terminal_message"),
  media_type: z.literal("application/json"),
  schema: z.record(jsonValueSchema).describe("calyx-open-dictionary:run-output-capture.schema"),
  max_bytes: z.number().int().positive(),
  required: z.literal(true),
}).strict();

function isSafeArtifactBasename(name: string): boolean {
  return name !== "."
    && name !== ".."
    && !name.includes("/")
    && !name.includes("\\")
    && !name.includes("\0");
}

export const backendOptionsSchema = z
  .object({
    allowed_tools: z.array(z.string().min(1)).optional(),
    dangerously_skip_permissions: z.boolean().optional(),
    sandbox: z.enum(["read-only", "danger-full-access"]).optional(),
    model: z.string().trim().min(1).optional(),
    reasoning_effort: z.enum(BACKEND_REASONING_EFFORTS).optional(),
    max_threads: z.number().int().positive().optional(),
    max_turns: z.number().int().positive().optional(),
    env: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
    agent_activity: z.object({
      stale_after_ms: z.number().int().optional(),
      poll_interval_ms: z.number().int().optional(),
      hard_timeout_ms: z.number().int().optional(),
      stop_grace_ms: z.number().int().optional(),
    }).optional(),
  })
  .passthrough();

export const notificationsSpecSchema = z.object({
  ntfy_topic: z.string().min(1).optional(),
  agent_mail_thread: z.string().min(1).optional(),
});

export const runHandbackSpecSchema = z.object({
  key: z.string().min(1),
  recipient_address: z.string().min(1),
  recipient_host: z.string().min(1).optional(),
  thread_key: z.string().min(1),
  ack_required: z.boolean(),
  body_contract: z.string().min(1),
  subject: z.string().min(1).optional(),
  flow: z.enum(["calyx.msg/v1", "receipt-only/v1"]).optional(),
  idempotency_key: z.string().min(1).optional(),
});

export const runSpecObjectSchema = z.object({
  run_id: z.string().min(1).optional(),
  issue: z
    .string()
    .regex(/^[A-Z]+-\d+$/)
    .optional(),
  host: z.string().min(1),
  backend: z.enum(["claude", "codex"]),
  profile: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  prompt_file: z.string().min(1).optional(),
  prompt_template: z.string().min(1).optional(),
  system_prompt: z.string().min(1).optional(),
  append_system_prompt: z.string().min(1).optional(),
  execplan_ref: z.string().min(1).optional(),
  require_execplan: z.boolean().default(true),
  pull_execplan: z.boolean().default(false),
  worktree: worktreeSpecSchema,
  required_artifacts: z.array(z.string().min(1)).optional(),
  artifact_roots: z.array(z.string().min(1)).optional(),
  output_capture: runOutputCaptureSchema.optional(),
  max_turns_per_run: z.number().int().positive().optional(),
  backend_options: backendOptionsSchema.optional(),
  notifications: notificationsSpecSchema.optional(),
  handback: runHandbackSpecSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  resume_session_id: z.string().min(1).optional(),
});

export const runSpecSchema = runSpecObjectSchema.superRefine((spec, ctx) => {
  if (spec.output_capture) {
    if (!isSafeArtifactBasename(spec.output_capture.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["output_capture", "name"],
        message: "output_capture.name must be a safe basename (no absolute, nested, traversal, or backslash path).",
      });
    }
    if (spec.backend !== "codex") {
      ctx.addIssue({
        code: "custom",
        path: ["output_capture"],
        message: "output_capture currently requires backend=codex for a proven config-isolated structured-output path.",
      });
    }
    if (spec.backend_options?.sandbox !== "read-only") {
      ctx.addIssue({
        code: "custom",
        path: ["backend_options", "sandbox"],
        message: "output_capture requires backend_options.sandbox=read-only.",
      });
    }
    if (spec.backend_options?.allowed_tools !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["backend_options", "allowed_tools"],
        message: "output_capture does not accept provider tool allowlists; inherited MCP/app tools are unavailable by transport.",
      });
    }
    if (spec.backend_options?.env !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["backend_options", "env"],
        message: "output_capture does not accept backend_options.env; the capture process environment is runner-owned.",
      });
    }
    if (spec.resume_session_id !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["resume_session_id"],
        message: "output_capture runs are ephemeral and cannot resume a backend session.",
      });
    }
    if ((spec.max_turns_per_run ?? 1) !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["max_turns_per_run"],
        message: "output_capture supports exactly one terminal backend turn.",
      });
    }
    if ((spec.required_artifacts ?? []).includes(spec.output_capture.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["required_artifacts"],
        message: "output_capture.name must not also appear in legacy required_artifacts.",
      });
    }
  }
  if (spec.backend === "claude" && spec.backend_options?.max_threads !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["backend_options", "max_threads"],
      message: "Claude does not support backend_options.max_threads; use max_turns only when an explicit Claude turn cap is intended.",
    });
  }
  if (spec.backend === "codex" && spec.backend_options?.max_turns !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["backend_options", "max_turns"],
      message: "Codex does not support backend_options.max_turns; use max_threads for Codex sub-agent concurrency.",
    });
  }
  if (spec.backend === "claude" && spec.backend_options?.sandbox !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["backend_options", "sandbox"],
      message: "Claude does not support backend_options.sandbox; use allowed_tools for Claude tool restrictions.",
    });
  }
  if (
    spec.backend_options?.sandbox === "read-only"
    && spec.backend_options.dangerously_skip_permissions === true
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["backend_options", "sandbox"],
      message: "backend_options.sandbox=read-only conflicts with dangerously_skip_permissions=true.",
    });
  }
});

// ── Lifecycle events ────────────────────────────────────────────────

export const lifecycleEventTypeSchema = z.enum([
  "state_transition",
  "dispatch_started",
  "dispatch_passed",
  "dispatch_rejected",
  "backend_spawned",
  "backend_event",
  "artifact_detected",
  "artifact_gate_passed",
  "artifact_gate_failed",
  "notification_sent",
  "error",
  "warning",
]);

export const lifecycleEventSchema = z.object({
  timestamp: z.string().datetime(),
  run_id: z.string().min(1),
  event: lifecycleEventTypeSchema,
  from: runStateSchema.optional(),
  to: runStateSchema.optional(),
  message: z.string().optional(),
  infra_error_classification: infraErrorClassificationSchema.optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

// ── Artifacts ───────────────────────────────────────────────────────

export const artifactLocationSchema = z.enum(["worktree", "docstore", "run_dir"]);

export const artifactEntrySchema = z.object({
  name: z.string().min(1),
  location: artifactLocationSchema,
  path: z.string().min(1),
  size_bytes: z.number().int().nonnegative().optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  required: z.boolean(),
  detected_at: z.string().datetime(),
});

export const artifactManifestSchema = z.object({
  run_id: z.string().min(1),
  finalized_at: z.string().datetime(),
  required: z.array(artifactEntrySchema),
  discovered: z.array(artifactEntrySchema),
  gate_passed: z.boolean(),
  missing: z.array(z.string().min(1)),
});

// ── Dispatch ────────────────────────────────────────────────────────

export const dispatchCheckSchema = z.object({
  name: z.string().min(1),
  passed: z.boolean(),
  message: z.string().min(1),
});

export const dispatchReceiptSchema = z.object({
  dispatch_id: z.string().min(1),
  run_id: z.string().min(1).optional(),
  timestamp: z.string().datetime(),
  decision: z.enum(["accepted", "rejected"]),
  lane: z.enum(["execplan", "prompt_only", "prompt_template"]).optional(),
  rejection_reason: z.string().min(1).optional(),
  overridden: z.boolean(),
  override_reason: z.string().min(1).optional(),
  checks: z.array(dispatchCheckSchema),
  warnings: z.array(z.string()),
});

// ── Run receipt ─────────────────────────────────────────────────────

/**
 * Receipts are assembled across a handful of adjacent async boundaries. Keep
 * duration correspondence strict enough to reject forged/stale chronology,
 * while allowing one second for timestamp serialization and scheduler skew.
 */
export const RECEIPT_TIMING_TOLERANCE_MS = 1_000;

function timingDeltaMs(later: string, earlier: string): number {
  return new Date(later).getTime() - new Date(earlier).getTime();
}

function durationCorresponds(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= RECEIPT_TIMING_TOLERANCE_MS;
}

export const receiptTimingSchema = z.object({
  created_at: z.string().datetime(),
  dispatched_at: z.string().datetime().optional(),
  started_at: z.string().datetime().optional(),
  completed_at: z.string().datetime(),
  duration_ms: z.number().int().nonnegative().optional(),
  dispatch_duration_ms: z.number().int().nonnegative().optional(),
  backend_duration_ms: z.number().int().nonnegative().optional(),
}).superRefine((timing, context) => {
  const chronological = [
    ["created_at", timing.created_at],
    ...(timing.dispatched_at ? [["dispatched_at", timing.dispatched_at] as const] : []),
    ...(timing.started_at ? [["started_at", timing.started_at] as const] : []),
    ["completed_at", timing.completed_at],
  ] as const;
  for (let index = 1; index < chronological.length; index += 1) {
    const previous = chronological[index - 1]!;
    const current = chronological[index]!;
    if (timingDeltaMs(current[1], previous[1]) < 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [current[0]],
        message: `${current[0]} must not precede ${previous[0]}`,
      });
    }
  }

  const totalDuration = timingDeltaMs(timing.completed_at, timing.created_at);
  if (timing.duration_ms !== undefined && !durationCorresponds(timing.duration_ms, totalDuration)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["duration_ms"],
      message: `duration_ms must correspond to completed_at - created_at within ${RECEIPT_TIMING_TOLERANCE_MS}ms`,
    });
  }

  if (timing.dispatch_duration_ms !== undefined) {
    if (!timing.dispatched_at) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dispatch_duration_ms"],
        message: "dispatch_duration_ms requires dispatched_at",
      });
    } else {
      const dispatchEnd = timing.started_at ?? timing.completed_at;
      const dispatchDuration = timingDeltaMs(dispatchEnd, timing.dispatched_at);
      if (!durationCorresponds(timing.dispatch_duration_ms, dispatchDuration)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dispatch_duration_ms"],
          message: `dispatch_duration_ms must correspond to dispatch completion within ${RECEIPT_TIMING_TOLERANCE_MS}ms`,
        });
      }
    }
  }

  if (timing.backend_duration_ms !== undefined) {
    if (!timing.started_at) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["backend_duration_ms"],
        message: "backend_duration_ms requires started_at",
      });
    } else {
      // Backend completion precedes artifact discovery and final receipt
      // publication, so it must fit inside (rather than equal) this envelope.
      const executionEnvelope = timingDeltaMs(timing.completed_at, timing.started_at);
      if (timing.backend_duration_ms > executionEnvelope + RECEIPT_TIMING_TOLERANCE_MS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["backend_duration_ms"],
          message: `backend_duration_ms must fit within the started_at/completed_at envelope plus ${RECEIPT_TIMING_TOLERANCE_MS}ms`,
        });
      }
    }
  }
});

export const receiptExitSchema = z.object({
  exit_code: z.number().int().optional(),
  error: z.string().optional(),
  failure_class: failureClassSchema.optional(),
  failure_source: failureSourceSchema.optional(),
  failure_layer: infraErrorFailureLayerSchema.optional(),
  failure_reason: infraErrorFailureReasonSchema.optional(),
  partial_reason: partialReasonSchema.optional(),
});

export const receiptEnvironmentSchema = z.object({
  host: z.string().min(1),
  backend: z.string().min(1),
  profile: z.string().min(1).optional(),
  worktree_path: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  node_version: z.string().min(1).optional(),
  calyx_version: z.string().min(1).optional(),
});

export const receiptNotificationsSchema = z.object({
  ntfy_sent: z.boolean().optional(),
  agent_mail_sent: z.boolean().optional(),
});

export const receiptLogSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  info: z.number().int().nonnegative(),
  warn: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
  streams: z.object({
    stdout_lines: z.number().int().nonnegative().optional(),
    stderr_lines: z.number().int().nonnegative().optional(),
  }).optional(),
  severity: z.object({
    info: z.number().int().nonnegative(),
    warn: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }).optional(),
  classifier_version: z.string().optional(),
});

export const receiptBackendSessionSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1).optional(),
  backend: z.string().min(1),
});

export const agentTerminalEvidenceSchema = z.object({
  schema_version: z.literal("calyx.agent-terminal-evidence/v1"),
  source: z.enum(["claude_stream", "session_fallback", "process_exit"]),
  status: z.enum(["authoritative", "fallback", "missing", "malformed"]),
  reason: z.enum([
    "completed",
    "max_turns",
    "budget_exhaustion",
    "provider_capacity_exhausted",
    "operator_stop",
    "backend_failure",
    "abnormal_exit",
    "malformed_result",
    "missing_result",
    "deferred",
    "unknown",
  ]),
  backend_subtype: z.string().optional(),
  backend_terminal_reason: z.string().optional(),
  backend_stop_reason: z.string().optional(),
  session_id: z.string().min(1).optional(),
  exit_code: z.number().int().optional(),
  signal: z.string().min(1).optional(),
  duration_ms: z.number().nonnegative().optional(),
  duration_api_ms: z.number().nonnegative().optional(),
  num_turns: z.number().int().nonnegative().optional(),
  total_cost_usd: z.number().nonnegative().optional(),
  permission_denial_count: z.number().int().nonnegative().optional(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
  }).optional(),
  provider_constraint: providerConstraintSchema.optional(),
  malformed_line_count: z.number().int().nonnegative().optional(),
  unknown_record_count: z.number().int().nonnegative().optional(),
}).strict();

export const runReceiptSchema = z.object({
  schema_version: z.literal("1.0"),
  run_id: z.string().min(1),
  state: runStateSchema,
  infra_error_classification: infraErrorClassificationSchema.optional(),
  run_spec: runSpecSchema,
  timing: receiptTimingSchema,
  exit: receiptExitSchema,
  artifacts: artifactManifestSchema,
  log_summary: receiptLogSummarySchema,
  environment: receiptEnvironmentSchema,
  notifications: receiptNotificationsSchema.optional(),
  backend_session: receiptBackendSessionSchema.optional(),
  agent_terminal_message: z.string().optional(),
  backend_stderr: z.string().optional(),
  backend_signal: z.string().optional(),
  spawn_error: z.string().optional(),
  health: z.object({
    source: z.enum(["host_process", "agent_runner"]),
    status: z.enum(["healthy", "stale", "unknown"]),
    checked_at: z.string().datetime(),
    stale_after_ms: z.number().int().positive(),
    last_activity_at: z.string().datetime().optional(),
    last_progress_at: z.string().datetime().optional(),
    observations: z.array(z.object({
      kind: z.enum(["stdout", "stderr", "file", "lifecycle", "turn", "claude_stream"]),
      label: z.string().min(1),
      path: z.string().optional(),
      exists: z.boolean(),
      last_modified_at: z.string().datetime().optional(),
    })),
    progress_signal: z.object({
      source: z.enum(["claude_stream", "adapter_activity"]),
      status: z.enum(["available", "unavailable", "failed"]),
      reason: z.enum([
        "awaiting_first_signal",
        "stream_initialized",
        "semantic_event",
        "no_structured_events",
        "malformed_stream",
        "spawn_failed",
        "adapter_activity",
      ]),
      expected_silence_until: z.string().datetime().optional(),
    }).optional(),
    summary: z.string().min(1),
  }).optional(),
  terminal_evidence: agentTerminalEvidenceSchema.optional(),
  summary: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
