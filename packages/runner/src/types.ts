/**
 * @polli-labs/calyx-runner — Contract-first type definitions.
 *
 * Canonical types for the vNext async runner lifecycle, failure classification,
 * dispatch gating, and run receipts. These extend the calyx-core ExecRunState
 * with refined failure categories.
 *
 * @see docs/architecture/async-runner-vnext-contracts.md
 */

// ── Run lifecycle ───────────────────────────────────────────────────

/**
 * 9-state lifecycle for vNext runner.
 * Superset of calyx-core ExecRunState (queued | running | succeeded | failed | cancelled)
 * with refined failure categories: dispatching, auth_error, infra_error, completed_dirty.
 */
export type RunState =
  | "queued"
  | "dispatching"
  | "running"
  | "succeeded"
  | "failed"
  | "partial"
  | "cancelled"
  | "auth_error"
  | "infra_error"
  | "completed_dirty";

// ── Partial reason taxonomy ─────────────────────────────────────────

/**
 * Why a run was classified as `partial` rather than succeeded or failed.
 * Encodes the resource boundary or operational reason the run terminated
 * before completing all objectives.
 */
export type PartialReason =
  | "budget_exhaustion"
  | "context_limit"
  | "max_turns"
  | "graceful_stop"
  | "operator_stop"
  | "unknown";

// ── Provider capacity evidence ─────────────────────────────────────

export const PROVIDER_CONSTRAINT_SCHEMA_VERSION = "calyx.provider-constraint/v1";

export const PROVIDER_CONSTRAINT_KINDS = [
  "session_window",
  "weekly_limit",
  "credits",
  "usage_limit",
] as const;

export type ProviderConstraintKind = typeof PROVIDER_CONSTRAINT_KINDS[number];

export const PROVIDER_CONSTRAINT_SOURCES = [
  "backend_stream",
  "session_transcript",
  "backend_stderr",
  "terminal_message",
] as const;

export type ProviderConstraintSource = typeof PROVIDER_CONSTRAINT_SOURCES[number];

/**
 * Bounded provider-capacity fact derived from terminal evidence.
 *
 * This deliberately excludes raw provider payloads. Provider codes/status and
 * a short redacted reset hint are sufficient for status, await, monitor, and
 * activity projections without copying transcript content into receipts.
 */
export interface ProviderConstraint {
  schema_version: typeof PROVIDER_CONSTRAINT_SCHEMA_VERSION;
  cause: "provider_capacity_exhausted";
  backend: string;
  kind: ProviderConstraintKind;
  source: ProviderConstraintSource;
  observed_at: string;
  confidence: "definitive";
  provider_code?: string;
  http_status?: number;
  reset_hint?: string;
}

// ── Infra error classification ─────────────────────────────────────

export const INFRA_ERROR_CLASSIFICATION_SCHEMA_VERSION = "infra_error_classification/v1";

export const INFRA_ERROR_FAILURE_LAYERS = [
  "worktree_acquisition",
  "backend_spawn",
  "secrets_auth",
  "daemon_feature",
  "prompts_resolution",
  "runtime_config",
  "runner_task",
  "unknown",
] as const;

export type InfraErrorFailureLayer = typeof INFRA_ERROR_FAILURE_LAYERS[number];

export const INFRA_ERROR_FAILURE_REASONS = [
  "worktree_ref_unresolved",
  "worktree_locked",
  "worktree_lease_refused",
  "repo_unregistered",
  "worktree_base_not_repo",
  "worktree_branch_required",
  "worktree_ref_invalid",
  "worktree_path_missing",
  "git_worktree_lock",
  "backend_spawn_exit",
  "feature_missing",
  "prompts_source_missing",
  "unknown",
] as const;

export type InfraErrorFailureReason = typeof INFRA_ERROR_FAILURE_REASONS[number];

export interface InfraErrorClassification {
  schema_version: typeof INFRA_ERROR_CLASSIFICATION_SCHEMA_VERSION;
  failure_layer: InfraErrorFailureLayer;
  failure_reason: InfraErrorFailureReason;
  message: string;
}

// ── Failure classification ──────────────────────────────────────────

export type FailureClass =
  | "success"
  | "task_failure"
  | "auth_error"
  | "infra_error"
  | "completed_dirty"
  | "dispatch_rejected";

export type FailureSource =
  | "exit_code"
  | "backend_event"
  | "stderr_pattern"
  | "heuristic"
  | "dispatch_gate";

export interface ClassificationResult {
  class: FailureClass;
  source: FailureSource;
  confidence: "definitive" | "heuristic";
  signal: string;
  raw_exit_code?: number;
  effective_exit_code: number;
}

// ── Stderr pattern registry ─────────────────────────────────────────

export interface StderrPattern {
  id: string;
  pattern: RegExp;
  class: FailureClass;
  negated_by?: RegExp[];
  since: string;
  retired?: string;
}

// ── Run spec ────────────────────────────────────────────────────────

export interface WorktreeSpec {
  mode?: "existing" | "managed" | "create";
  path?: string;
  repo?: string;
  ref?: string;
  reset_on_reuse?: boolean;
  branch?: string;
  steal_lock?: boolean;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Trusted runner materialization of a backend's terminal assistant message.
 *
 * The agent never receives a writable artifact directory. The backend returns
 * one schema-constrained terminal JSON value and the runner owns validation,
 * canonicalization, and durable publication under the run directory.
 */
export interface RunOutputCapture {
  name: string;
  source: "agent_terminal_message";
  media_type: "application/json";
  schema: JsonValue;
  max_bytes: number;
  required: true;
}

/** Bounded facts about terminal bytes observed by a capture-aware adapter. */
export interface RunOutputCaptureObservation {
  status: "complete" | "limit_exceeded" | "incomplete";
  bytes_observed: number;
  sha256: string;
}

export const CODEX_BACKEND_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export const CLAUDE_BACKEND_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const BACKEND_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type CodexBackendReasoningEffort = typeof CODEX_BACKEND_REASONING_EFFORTS[number];
export type ClaudeBackendReasoningEffort = typeof CLAUDE_BACKEND_REASONING_EFFORTS[number];
export type BackendReasoningEffort = typeof BACKEND_REASONING_EFFORTS[number];

export function isCodexBackendReasoningEffort(value: string): value is CodexBackendReasoningEffort {
  return (CODEX_BACKEND_REASONING_EFFORTS as readonly string[]).includes(value);
}

export function isClaudeBackendReasoningEffort(value: string): value is ClaudeBackendReasoningEffort {
  return (CLAUDE_BACKEND_REASONING_EFFORTS as readonly string[]).includes(value);
}

export interface BackendOptions {
  allowed_tools?: string[];
  dangerously_skip_permissions?: boolean;
  /** Codex sandbox mode enforced by both app-server and legacy exec adapters. */
  sandbox?: "read-only" | "danger-full-access";
  model?: string;
  reasoning_effort?: BackendReasoningEffort;
  /** Codex-native concurrent sub-agent limit (`agents.max_threads`). */
  max_threads?: number;
  /** Claude-native agentic turn cap (`--max-turns`). */
  max_turns?: number;
  env?: Record<string, string | null>;
  agent_activity?: AgentActivityConfig;
  [key: string]: unknown; // forward-compat passthrough
}

export interface AgentActivityConfig {
  stale_after_ms?: number;
  poll_interval_ms?: number;
  hard_timeout_ms?: number;
  stop_grace_ms?: number;
}

export type AgentActivityProgressSource =
  | "lifecycle"
  | "stdout"
  | "stderr"
  | "turn"
  | "claude_stream";

export type AgentProgressSignalStatus = "available" | "unavailable" | "failed";

export interface AgentProgressSignal {
  source: "claude_stream" | "adapter_activity";
  status: AgentProgressSignalStatus;
  reason:
    | "awaiting_first_signal"
    | "stream_initialized"
    | "semantic_event"
    | "no_structured_events"
    | "malformed_stream"
    | "spawn_failed"
    | "adapter_activity";
  /** Declared semantic-silence deadline that currently extends freshness. */
  expected_silence_until?: string;
}

export interface AgentActivityProgress {
  source: AgentActivityProgressSource;
  bytes?: number;
  timestamp: string;
  detail?: string;
  /**
   * Bounded interval during which the backend has declared that semantic
   * silence is expected (for example, an API retry backoff).
   */
  expected_silence_ms?: number;
  /** Availability of the backend semantic progress channel. */
  signal?: AgentProgressSignal;
  /** True only for a sparse semantic progress fact, never raw transport bytes. */
  semantic?: boolean;
}

export interface AgentRunnerSessionCheckpoint {
  adapter_session_id: string;
  backend_session?: ReceiptBackendSession;
  timestamp: string;
}

export interface RunHealthObservation {
  kind: "stdout" | "stderr" | "file" | AgentActivityProgressSource;
  label: string;
  path?: string;
  exists: boolean;
  last_modified_at?: string;
}

export interface RunHealthSnapshot {
  source: "host_process" | "agent_runner";
  status: "healthy" | "stale" | "unknown";
  checked_at: string;
  stale_after_ms: number;
  last_activity_at?: string;
  last_progress_at?: string;
  observations: RunHealthObservation[];
  /** Typed source and availability of semantic progress evidence. */
  progress_signal?: AgentProgressSignal;
  summary: string;
}

export interface NotificationsSpec {
  ntfy_topic?: string;
  agent_mail_thread?: string;
}

export type RunHandbackFlow = "calyx.msg/v1" | "receipt-only/v1";

export interface RunHandbackSpec {
  /** Stable logical binding key, scoped by run_id for terminal handback dedupe. */
  key: string;
  /** Directed calyx msg recipient, typically the caller activity id. */
  recipient_address: string;
  /** Target host for directed recipients without an embedded host. */
  recipient_host?: string;
  /** Message thread to keep multi-round handbacks grouped. */
  thread_key: string;
  /** Ack policy for the directed message. */
  ack_required: boolean;
  /** Contract for the generated terminal body. */
  body_contract: string;
  /** Optional subject override for the generated message. */
  subject?: string;
  /** Delivery flow selected at launch after feature detection. */
  flow?: RunHandbackFlow;
  /** Optional explicit idempotency key; defaults to handback:<run_id>:<key>. */
  idempotency_key?: string;
}

export interface RunSpec {
  run_id?: string;
  issue?: string;
  host: string;
  backend: "claude" | "codex";
  profile?: string;
  prompt?: string;
  prompt_file?: string;
  prompt_template?: string;
  system_prompt?: string;
  append_system_prompt?: string;
  execplan_ref?: string;
  require_execplan: boolean;
  pull_execplan: boolean;
  worktree: WorktreeSpec;
  required_artifacts?: string[];
  artifact_roots?: string[];
  output_capture?: RunOutputCapture;
  /** Upper bound on how many turns may run inside one adapter session. */
  max_turns_per_run?: number;
  backend_options?: BackendOptions;
  notifications?: NotificationsSpec;
  handback?: RunHandbackSpec;
  metadata?: Record<string, unknown>;
  /** When set, resume an existing session instead of starting a new one. */
  resume_session_id?: string;
}

// ── Lifecycle events ────────────────────────────────────────────────

export type LifecycleEventType =
  | "state_transition"
  | "dispatch_started"
  | "dispatch_passed"
  | "dispatch_rejected"
  | "backend_spawned"
  | "backend_event"
  | "artifact_detected"
  | "artifact_gate_passed"
  | "artifact_gate_failed"
  | "notification_sent"
  | "error"
  | "warning";

export interface LifecycleEvent {
  timestamp: string;
  run_id: string;
  event: LifecycleEventType;
  from?: RunState;
  to?: RunState;
  message?: string;
  infra_error_classification?: InfraErrorClassification;
  payload?: Record<string, unknown>;
}

// ── Artifacts ───────────────────────────────────────────────────────

export type ArtifactLocation = "worktree" | "docstore" | "run_dir";

export interface ArtifactEntry {
  name: string;
  location: ArtifactLocation;
  path: string;
  size_bytes?: number;
  sha256?: string;
  required: boolean;
  detected_at: string;
}

export interface ArtifactManifest {
  run_id: string;
  finalized_at: string;
  required: ArtifactEntry[];
  discovered: ArtifactEntry[];
  gate_passed: boolean;
  missing: string[];
}

// ── Dispatch ────────────────────────────────────────────────────────

export interface DispatchCheck {
  name: string;
  passed: boolean;
  message: string;
}

export interface DispatchReceipt {
  dispatch_id: string;
  run_id?: string;
  timestamp: string;
  decision: "accepted" | "rejected";
  lane?: "execplan" | "prompt_only" | "prompt_template";
  rejection_reason?: string;
  overridden: boolean;
  override_reason?: string;
  checks: DispatchCheck[];
  warnings: string[];
}

// ── Run receipt ─────────────────────────────────────────────────────

export interface ReceiptTiming {
  created_at: string;
  dispatched_at?: string;
  started_at?: string;
  completed_at: string;
  duration_ms?: number;
  dispatch_duration_ms?: number;
  backend_duration_ms?: number;
}

export interface ReceiptExit {
  exit_code?: number;
  error?: string;
  failure_class?: FailureClass;
  failure_source?: FailureSource;
  failure_layer?: InfraErrorFailureLayer;
  failure_reason?: InfraErrorFailureReason;
  /** Present when state is `partial` — encodes why the run was partial. */
  partial_reason?: PartialReason;
}

export interface ReceiptEnvironment {
  host: string;
  backend: string;
  profile?: string;
  worktree_path?: string;
  branch?: string;
  node_version?: string;
  calyx_version?: string;
}

export interface ReceiptNotifications {
  ntfy_sent?: boolean;
  agent_mail_sent?: boolean;
}

export interface ReceiptLogSummary {
  total: number;
  info: number;
  warn: number;
  error: number;
  streams?: {
    stdout_lines?: number;
    stderr_lines?: number;
  };
  severity?: {
    info: number;
    warn: number;
    error: number;
    unknown: number;
  };
  classifier_version?: string;
}

/** Backend session locator stored in the receipt. */
export interface ReceiptBackendSession {
  /** Backend-specific session identifier. */
  id: string;
  /** Absolute path to the session file. */
  path?: string;
  /** Which backend produced this session. */
  backend: string;
}

export type AgentTerminalReason =
  | "completed"
  | "max_turns"
  | "budget_exhaustion"
  | "provider_capacity_exhausted"
  | "operator_stop"
  | "backend_failure"
  | "abnormal_exit"
  | "malformed_result"
  | "missing_result"
  | "deferred"
  | "unknown";

export interface AgentTerminalUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Sparse authoritative terminal projection from a structured backend stream. */
export interface AgentTerminalEvidence {
  schema_version: "calyx.agent-terminal-evidence/v1";
  source: "claude_stream" | "session_fallback" | "process_exit";
  status: "authoritative" | "fallback" | "missing" | "malformed";
  reason: AgentTerminalReason;
  backend_subtype?: string;
  backend_terminal_reason?: string;
  backend_stop_reason?: string;
  session_id?: string;
  exit_code?: number;
  signal?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  permission_denial_count?: number;
  usage?: AgentTerminalUsage;
  /** Typed provider-capacity cause; raw provider payloads are never retained. */
  provider_constraint?: ProviderConstraint;
  malformed_line_count?: number;
  unknown_record_count?: number;
}

export interface RunReceipt {
  schema_version: "1.0";
  run_id: string;
  state: RunState;
  infra_error_classification?: InfraErrorClassification;
  run_spec: RunSpec;
  timing: ReceiptTiming;
  exit: ReceiptExit;
  artifacts: ArtifactManifest;
  log_summary: ReceiptLogSummary;
  environment: ReceiptEnvironment;
  notifications?: ReceiptNotifications;
  /** Backend session locator, if session discovery succeeded. */
  backend_session?: ReceiptBackendSession;
  /** The agent's final assistant message. No truncation. */
  agent_terminal_message?: string;
  /** Captured stderr from the backend process (truncated to 10KB for diagnostics). */
  backend_stderr?: string;
  /** Signal that killed the backend process, if any. */
  backend_signal?: string;
  /** Spawn-level error (e.g., maxBuffer overflow), if any. */
  spawn_error?: string;
  /** Latest sparse health snapshot observed before terminal receipt materialization. */
  health?: RunHealthSnapshot;
  /** Typed terminal lifecycle evidence from the backend structured stream. */
  terminal_evidence?: AgentTerminalEvidence;
  summary: string;
  metadata?: Record<string, unknown>;
}

export type SessionStopReason =
  | "natural_stop"
  | "provider_capacity_exhausted"
  | "max_turns"
  | "auth_error"
  | "infra_error"
  | "cancelled"
  | "continuation_declined";

export interface SessionTurnSummary {
  turn_index: number;
  adapter_turn_id: string;
  backend_turn_id?: string;
  backend_session_id?: string;
  state: RunState;
  failure_class?: FailureClass;
  failure_source?: FailureSource;
  partial_reason?: PartialReason;
  started_at: string;
  completed_at: string;
  duration_ms: number;
}

export interface SessionSummary {
  adapter_name: string;
  adapter_session_id: string;
  backend_session_id?: string;
  resumed_from_session_id?: string;
  turns_total: number;
  terminal_turn_index: number;
  stop_reason: SessionStopReason;
  turns: SessionTurnSummary[];
}

// ── Configuration ───────────────────────────────────────────────────

export interface BackendProfile {
  backend: "claude" | "codex";
  model?: string;
  reasoning_level?: "low" | "medium" | "high" | "xhigh";
  max_threads?: number;
  max_turns?: number;
  description: string;
}

export interface HostConfig {
  ssh: string;
  roles: string[];
  gpu?: string;
}

export interface RunnerConfig {
  default_backend: "claude" | "codex";
  profiles: Record<string, BackendProfile>;
  classification: {
    dirty_threshold: number;
    pattern_version: string;
  };
  notifications: {
    ntfy_topic?: string;
    agent_mail_enabled: boolean;
  };
  worktree: {
    base_path: string;
    default_ref: string;
    lock_timeout_ms: number;
  };
  hosts?: Record<string, HostConfig>;
}

// ── Classifier input ────────────────────────────────────────────────

/** Input bundle for the failure classifier. */
export interface ClassifierInput {
  exit_code?: number;
  stderr?: string;
  event_count?: number;
  final_artifact_present?: boolean;
  backend_events?: BackendEvent[];
  dirty_threshold?: number;
}

/** Typed backend event for classifier consumption. */
export interface BackendEvent {
  event: string;
  payload?: Record<string, unknown>;
}
