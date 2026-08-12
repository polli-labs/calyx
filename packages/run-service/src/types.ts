import type {
  AgentTerminalEvidence,
  AdapterSession,
  BackendOptions,
  ClassificationResult,
  LifecycleEvent,
  PartialReason,
  NotificationsSpec,
  RunHandbackSpec,
  ReceiptExit,
  ReceiptLogSummary,
  ReceiptTiming,
  RunOutputCapture,
  RunReceipt,
  RunState,
  SessionSummary,
  SessionTurnSummary,
  TurnInput,
  TurnResult,
  WorktreeSpec,
  InfraErrorClassification,
} from "@polli-labs/calyx-runner";
import type {
  ApiProvenanceV1,
  CalyxAdminReconcileUnresolvedReason,
  CalyxDaemonFeature,
  MonitorRearmPolicy,
  MonitorWakeStatus,
  PredicateEvaluationResult,
  PredicateV1,
  WorkloadAdmissionDecisionV1,
  WorkloadAdmissionFenceReason,
} from "@polli-labs/calyx-core";
import { CALYX_CLOSED_RESPONSE_OBJECT_DESCRIPTION_PREFIX } from "@polli-labs/calyx-core";
import type { SupportedBackend } from "@polli-labs/calyx-runner";
import type { DetachedWorkerSupervisor } from "./worker-supervisor.js";
import { z } from "zod";

export type ExecutionKernelId = "agent_runner" | "host_process";

export const HOST_PROCESS_RECEIPT_SCHEMA_VERSION =
  "calyx.host-process-receipt/v1" as const;

export type HostProcessHealthSourceKind = "stdout" | "stderr" | "file";
export type AgentRunnerHealthSourceKind = "lifecycle" | "stdout" | "stderr" | "turn" | "claude_stream";

export interface AgentProgressSignal {
  source: "claude_stream" | "adapter_activity";
  status: "available" | "unavailable" | "failed";
  reason:
    | "awaiting_first_signal"
    | "stream_initialized"
    | "semantic_event"
    | "no_structured_events"
    | "malformed_stream"
    | "spawn_failed"
    | "adapter_activity";
  expected_silence_until?: string;
}

export interface HostProcessStdIoHealthSource {
  kind: "stdout" | "stderr";
  label?: string;
}

export interface HostProcessFileHealthSource {
  kind: "file";
  path: string;
  label?: string;
}

export type HostProcessHealthSource = HostProcessStdIoHealthSource | HostProcessFileHealthSource;

export interface HostProcessHealthConfig {
  stale_after_ms: number;
  poll_interval_ms?: number;
  sources: HostProcessHealthSource[];
}

export interface ResolvedHostProcessHealthSource {
  kind: HostProcessHealthSourceKind;
  label: string;
  path?: string;
}

export interface ResolvedHostProcessHealthConfig {
  stale_after_ms: number;
  poll_interval_ms: number;
  sources: ResolvedHostProcessHealthSource[];
}

export interface RunHealthObservation {
  kind: HostProcessHealthSourceKind | AgentRunnerHealthSourceKind;
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
  progress_signal?: AgentProgressSignal;
  summary: string;
}

export interface HostProcessIntent {
  argv: string[];
  cwd?: string;
  env?: Record<string, string | null>;
  stop_grace_ms?: number;
  health?: HostProcessHealthConfig;
}

export type RunWorktreeSource = "run_spec" | "explicit_flag" | "activity_inventory_cwd";

export interface ResumeWorktreeResolution {
  path: string;
  source: RunWorktreeSource;
}

export interface RunIntent {
  run_id: string;
  kernel?: ExecutionKernelId;
  issue?: string;
  template?: string;
  template_vars?: Record<string, string>;
  prompt?: string;
  prompt_file?: string;
  system_prompt?: string;
  append_system_prompt?: string;
  execplan_ref?: string;
  required_features?: CalyxDaemonFeature[];
  host: string;
  backend?: SupportedBackend;
  profile?: string;
  repo?: string;
  worktree_mode?: "existing" | "managed" | "create";
  worktree_base?: string;
  worktree_path?: string;
  worktree_source?: RunWorktreeSource;
  worktree_ref?: string;
  worktree_reset_on_reuse?: boolean;
  branch?: string;
  steal_lock?: boolean;
  lock_timeout_ms?: number;
  require_execplan?: boolean;
  pull_execplan?: boolean;
  required_artifacts?: string[];
  artifact_roots?: string[];
  output_capture?: RunOutputCapture;
  max_turns_per_run?: number;
  backend_options?: BackendOptions;
  host_process?: HostProcessIntent;
  notifications?: NotificationsSpec;
  handback?: RunHandbackSpec;
  metadata?: Record<string, unknown>;
  /** When set, resume an existing session instead of starting a new one. */
  resume_session_id?: string;
  created_at: string;
}

export interface RunContinuationContext {
  turn_index: number;
  turn_summary: SessionTurnSummary;
  session_summary: SessionSummary;
  session: AdapterSession;
  terminal_state: RunState;
  classification: ClassificationResult;
  partial_reason?: PartialReason | undefined;
  result: TurnResult;
}

export type RunNextTurnInput = (
  context: RunContinuationContext,
) => Promise<TurnInput | null> | TurnInput | null;

export interface ResolutionStep {
  name: string;
  status: "resolved" | "skipped";
  detail: string;
}

export interface ResolvedExecutionSpec {
  run_id: string;
  kernel: ExecutionKernelId;
  host: string;
  required_artifacts: string[];
  artifact_roots?: string[];
  output_capture?: RunOutputCapture;
  backend_options?: BackendOptions;
  notifications?: NotificationsSpec;
  handback?: RunHandbackSpec;
  metadata?: Record<string, unknown>;
  resolved_at: string;
  resolution_log: ResolutionStep[];
}

export interface ResolvedRunSpec extends ResolvedExecutionSpec {
  kernel: "agent_runner";
  issue?: string;
  resolved_template?: string;
  backend: SupportedBackend;
  profile?: string;
  prompt: string;
  system_prompt?: string;
  append_system_prompt?: string;
  execplan_content?: string;
  execplan_source?: string;
  require_execplan?: boolean;
  worktree: WorktreeSpec;
  worktree_source?: RunWorktreeSource;
  max_turns_per_run?: number;
  /** When set, resume an existing session instead of starting a new one. */
  resume_session_id?: string;
}

export interface ResolvedHostProcessSpec extends ResolvedExecutionSpec {
  kernel: "host_process";
  process: {
    argv: string[];
    cwd: string;
    env?: Record<string, string | null>;
    stop_grace_ms: number;
  };
  health?: ResolvedHostProcessHealthConfig;
}

export interface HostProcessExecutionBinding {
  schema_version: "calyx.host-process-execution-binding/v1";
  execution_id: string;
  salt: string;
  commitment_sha256: string;
}

interface HostProcessReceiptBase {
  kernel: "host_process";
  run_id: string;
  state: RunState;
  infra_error_classification?: InfraErrorClassification;
  timing: ReceiptTiming;
  exit: ReceiptExit;
  log_summary: ReceiptLogSummary;
  process: {
    argv: string[];
    cwd: string;
    env_keys: string[];
    pid?: number;
    process_group_id?: number;
    stdout_path?: string;
    stderr_path?: string;
    stop_grace_ms: number;
    stop_requested: boolean;
    stop_signal?: string;
  };
  health?: RunHealthSnapshot;
  summary: string;
  metadata?: Record<string, unknown>;
}

/** Current receipts whose exact admitted host-process effect is recoverable. */
export interface BoundHostProcessReceipt extends HostProcessReceiptBase {
  schema_version: typeof HOST_PROCESS_RECEIPT_SCHEMA_VERSION;
  execution_binding: HostProcessExecutionBinding;
}

/**
 * Pre-POL-1980 receipt retained only for observation of an already-published,
 * coherent terminal record. Its absence of an execution binding can never
 * authorize effect admission or receipt-only reconstruction.
 */
export interface LegacyHostProcessReceipt extends HostProcessReceiptBase {
  schema_version: "1.0";
  execution_binding?: never;
}

export type HostProcessReceipt = BoundHostProcessReceipt | LegacyHostProcessReceipt;

export type ExecutionReceipt = RunReceipt | HostProcessReceipt;
export type StoredResolvedSpec = ResolvedExecutionSpec | ResolvedRunSpec | ResolvedHostProcessSpec;

export type RunLogEntryKind = "event" | "stream_line" | "agent_message";
export type RunLogEntrySource = "lifecycle" | "host_process" | "run_worker" | "agent";
export type RunLogStream = "stdout" | "stderr";
export type RunLogTimestampSource = "event" | "file_mtime" | "message";

export interface RunLogEntry {
  kind: RunLogEntryKind;
  source: RunLogEntrySource;
  text: string;
  timestamp?: string;
  timestamp_source?: RunLogTimestampSource;
  event?: string;
  stream?: RunLogStream;
  line?: number;
  path?: string;
  truncated_head_bytes?: number;
}

export interface RunLogSourceSummary {
  source: RunLogEntrySource;
  stream?: RunLogStream;
  path?: string;
  exists: boolean;
  file_size_bytes?: number;
  read_from_byte?: number;
  truncated_head_bytes?: number;
  selected_lines: number;
  line_count?: number;
  latest_modified_at?: string;
}

export interface RunLogResult {
  schema_version: "run-logs/v1";
  run_id: string;
  entries: RunLogEntry[];
  sources: RunLogSourceSummary[];
  options: {
    tail?: number;
    stream_tail: number;
    max_stream_bytes: number;
    stream_tail_defaulted: boolean;
  };
  warnings: string[];
}

export type RunObservationStatus = "present" | "missing" | "unknown";
export type RunProcessObservationStatus = "alive" | "dead" | "not_recorded" | "unknown";
export type RunGpuResourceStatus = "available" | "unavailable" | "error";

export interface RunArtifactObservation {
  name: string;
  location: "worktree" | "docstore" | "run_dir" | "unknown";
  required: boolean;
  status: RunObservationStatus;
  path?: string;
  exists?: boolean;
  file_size_bytes?: number;
  latest_modified_at?: string;
  detected_at?: string;
}

export interface RunArtifactRootObservation {
  name: string;
  path?: string;
  status: RunObservationStatus;
  exists?: boolean;
  file_count?: number;
  directory_count?: number;
  total_size_bytes?: number;
  latest_modified_at?: string;
  truncated?: boolean;
  max_entries?: number;
}

export interface RunProcessObservation {
  status: RunProcessObservationStatus;
  checked_at: string;
  pid?: number;
}

export type RunResourceAttributionStatus =
  | "pid_missing"
  | "attributed"
  | "host_only"
  | "root_not_found"
  | "process_provider_unavailable"
  | "permission_denied"
  | "error";

export type RunProcessTreeAttributionStatus =
  | "pid_missing"
  | "attributed"
  | "root_not_found"
  | "provider_unavailable"
  | "permission_denied"
  | "error";

export type RunGpuProcessAttributionStatus =
  | "attributed"
  | "host_only"
  | "none"
  | "unavailable"
  | "error";

export interface RunObservedProcess {
  pid: number;
  ppid: number;
  cpu_percent?: number;
  rss_kib?: number;
  command?: string;
}

export interface RunProcessTreeAttributionObservation {
  provider: "ps";
  status: RunProcessTreeAttributionStatus;
  checked_at: string;
  root_pid?: number;
  process_count?: number;
  total_cpu_percent?: number;
  total_rss_kib?: number;
  processes: RunObservedProcess[];
  truncated: boolean;
  max_processes: number;
  message?: string;
}

export interface RunObservedGpuProcess {
  pid: number;
  process_name?: string;
  gpu_uuid?: string;
  used_gpu_memory_mib?: number;
}

export interface RunGpuProcessAttributionObservation {
  provider: "nvidia-smi";
  status: RunGpuProcessAttributionStatus;
  checked_at: string;
  command: string[];
  host_process_count?: number;
  attributed_process_count?: number;
  attributed_memory_used_mib?: number;
  processes: RunObservedGpuProcess[];
  message?: string;
}

export interface RunResourceAttributionObservation {
  schema_version: "run-resource-attribution/v1";
  checked_at: string;
  root_pid?: number;
  status: RunResourceAttributionStatus;
  process_tree: RunProcessTreeAttributionObservation;
  gpu_processes: RunGpuProcessAttributionObservation;
}

export interface RunGpuDeviceObservation {
  index: number;
  name: string;
  utilization_gpu_percent?: number;
  memory_used_mib?: number;
  memory_total_mib?: number;
}

export interface RunGpuResourceObservation {
  provider: "nvidia-smi";
  status: RunGpuResourceStatus;
  checked_at: string;
  command: string[];
  gpus: RunGpuDeviceObservation[];
  message?: string;
}

export interface RunHostResourceObservation {
  schema_version: "host-resources/v1";
  checked_at: string;
  gpu: RunGpuResourceObservation;
}

export interface RunObservationResult {
  schema_version: "run-observation/v1";
  run_id: string;
  checked_at: string;
  run: {
    state?: RunState;
    summary?: string;
    host?: string;
    issue?: string;
    backend?: SupportedBackend;
    kernel?: ExecutionKernelId;
    updated_at?: string;
    health?: RunHealthSnapshot;
  };
  paths: {
    run_dir: string;
    worktree_path?: string;
  };
  process: RunProcessObservation;
  resource_attribution?: RunResourceAttributionObservation;
  logs: {
    sources: RunLogSourceSummary[];
    warnings: string[];
  };
  artifacts: RunArtifactObservation[];
  artifact_roots?: RunArtifactRootObservation[];
  host_resources: RunHostResourceObservation;
  warnings: string[];
}

export interface IntegrationResult {
  name: string;
  critical: boolean;
  status: "success" | "failed" | "skipped";
  error?: string;
  duration_ms?: number;
  details?: Record<string, unknown>;
}

export interface IntegrationStatus {
  results: IntegrationResult[];
  all_critical_ok: boolean;
}

export interface RecoveryCheckpoint {
  adapter_session_id?: string;
  backend_session_id?: string;
  backend_session_path?: string;
  backend_thread_id?: string;
  current_turn_id?: string;
  last_event_at?: string;
  strategy: "none" | "native_session";
}

export interface RecoveryStatus {
  mode: "normal" | "orchestrator_crash" | "daemon_crash" | "orphaned_process";
  resumable: boolean;
  checkpoint?: RecoveryCheckpoint;
  note?: string;
  owner_free_settlement?: {
    schema_version: "calyx.owner-free-settlement/v1";
    authority: "legacy_pid_dead";
    authority_id: string;
    settled_at: string;
    reason_code: "legacy_detached_worker_observed_dead";
    legacy_pid: number;
  };
  resource_settlement?:
    | {
        schema_version: "calyx.resource-settlement/v1";
        status: "pending";
        authority: "legacy_process_group_observation";
        observed_at: string;
        reason_code:
          | "legacy_detached_process_group_possibly_live"
          | "legacy_detached_process_group_untrusted";
        legacy_process_group_id: number;
      }
    | {
        schema_version: "calyx.resource-settlement/v1";
        status: "settled";
        authority: "legacy_process_group_extinct";
        authority_id: string;
        settled_at: string;
        reason_code: "legacy_detached_process_group_observed_extinct";
        legacy_process_group_id: number;
      };
}

export type RunLaunchMode = "inline" | "detached";
export type RunLaunchStage = "accepted" | "dispatching" | "executing";

export type RunExecutionAdmissionRefusal = {
  schema_version: "calyx.run-execution-admission-refusal/v1";
  dispatch_attempt: number;
  refused_at: string;
  decision: WorkloadAdmissionDecisionV1;
  reason: WorkloadAdmissionFenceReason;
  failed_surface: string;
  next_action: string;
} & (
  | { code: "workload_admission_fenced" }
  | { code: "workload_admission_busy"; acquire_timeout_ms: number }
);

export interface RunLaunchState {
  mode: RunLaunchMode;
  stage: RunLaunchStage;
  /** Unique identity of this fresh run-record claim; changes when a reaped run id is reclaimed. */
  incarnation_id?: string;
  /** Stable identity of the launch admission binding (local or API idempotency domain). */
  admission_identity: string;
  /** RFC 8785 request hash captured before one-time execution-default resolution. */
  request_hash: string;
  accepted_at: string;
  dispatch_attempts: number;
  last_dispatch_at?: string;
  execution_id?: string;
  execution_started_at?: string;
  /** Retryable first-execution refusal published by a detached worker. */
  execution_admission_refusal?: RunExecutionAdmissionRefusal;
  /** Exact non-secret host-process effect binding persisted before spawn. */
  host_process_execution_binding?: HostProcessExecutionBinding;
}

export interface RunCancellationRequest {
  schema_version: "calyx.run-cancellation/v1";
  run_id: string;
  requested_at: string;
  reason?: string;
  provenance?: ApiProvenanceV1;
}

export interface RunRecord {
  schema_version: "1.0";
  run_id: string;
  state: RunState;
  infra_error_classification?: InfraErrorClassification;
  intent: RunIntent;
  /** Immutable attribution for the HTTP request that created this run. */
  creation_provenance?: ApiProvenanceV1;
  /** Durable launch admission, persisted before any execution effect. */
  launch: RunLaunchState;
  spec?: StoredResolvedSpec;
  kernel_receipt?: ExecutionReceipt;
  health?: RunHealthSnapshot;
  integrations: IntegrationStatus;
  recovery: RecoveryStatus;
  summary: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface RunListEntry {
  run_id: string;
  state: RunState;
  summary: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  health_status?: RunHealthSnapshot["status"];
  last_progress_at?: string;
  progress_signal?: AgentProgressSignal;
  terminal?: RunTerminalProjection;
  issue?: string;
  host?: string;
  backend?: SupportedBackend;
  recovery_mode: RecoveryStatus["mode"];
  run_dir: string;
}

/** Bounded terminal facts for list/activity projections; full messages remain on receipts. */
export interface RunTerminalProjection {
  evidence: AgentTerminalEvidence;
}

export interface RunServiceInfraErrorCensusPoint {
  failure_layer: InfraErrorClassification["failure_layer"];
  failure_reason: InfraErrorClassification["failure_reason"];
  host: string;
  kernel: ExecutionKernelId;
  backend: SupportedBackend | "unknown";
  count: number;
}

export type InteractiveSessionBackend = "claude" | "codex";

export interface InteractiveSessionListEntry {
  entry_kind: "interactive_session";
  run_id: string;
  state: "interactive";
  summary: string;
  created_at: string;
  updated_at: string;
  host?: string;
  backend: InteractiveSessionBackend;
  session_id: string;
  session_path: string;
  cwd?: string;
  source: "claude_projects" | "codex_sessions" | "calyx_runs";
  bytes?: number;
}

export type RunActivityEntry =
  | (RunListEntry & { entry_kind: "calyx_run" })
  | InteractiveSessionListEntry;

export interface InteractiveSessionSummary {
  window_ms: number;
  scanned_at: string;
  codex: number;
  claude: number;
  total: number;
  status?: "ok" | "unavailable";
  reason?: "timeout" | "error";
  timed_out_ms?: number;
  error?: string;
}

export type InteractiveSessionEventRole = "user" | "assistant" | "tool" | "system" | "unknown";

export interface InteractiveSessionEvent {
  index: number;
  line: number;
  timestamp?: string;
  role: InteractiveSessionEventRole;
  kind: string;
  summary: string;
  text?: string;
  redacted?: boolean;
  truncated?: boolean;
  raw_type?: string;
}

export interface InteractiveSessionInspectResult {
  activity_id: string;
  backend: InteractiveSessionBackend;
  session_id: string;
  session_path: string;
  source: InteractiveSessionListEntry["source"];
  cwd?: string;
  bytes?: number;
  total_events: number;
  returned_events: number;
  truncated: boolean;
  around?: string;
  tail?: number;
  context?: number;
  include_tools: boolean;
  events: InteractiveSessionEvent[];
}

export interface RunLaunchResult {
  run_id: string;
  state: RunState;
  mode: "foreground" | "background" | "remote";
  run_dir: string;
  record: RunRecord;
  server_url?: string;
}

export interface NonCanonicalRunDirectoryDisposition {
  directory_name: string;
  status: "requires_operator_migration";
  reason: string;
  record_state?: string;
  detail?: string;
}

export interface ReconcileResult {
  scanned: number;
  rebuilt: string[];
  /** Receipt-authoritative runs whose run_record.json projection could not yet be republished. */
  repair_pending?: string[];
  classified: string[];
  adopted: string[];
  /** Runs whose reconciliation deliberately refused to claim completion. */
  unresolved: Array<{
    run_id: string;
    reason: CalyxAdminReconcileUnresolvedReason;
  }>;
  /** Benign no-op or concurrently-resolved runs only; never unresolved work. */
  skipped: string[];
  noncanonical_directories: NonCanonicalRunDirectoryDisposition[];
  projection:
    | { status: "repaired"; rowCount: number }
    | { status: "not_configured" }
    | { status: "failed"; reason: string };
}

/**
 * POL-1886 restart-readopt classification reason for a single non-terminal run.
 * `detached_agent_runner_worker` is the current execution-mutex proof.
 * `legacy_process_identity_unavailable` is the rolling-upgrade block for an
 * origin/main worker that predates process-start identity and execution
 * mutexes. Its state is preserved for settlement, but it is never readopt-safe.
 * Every other value is a classified block reason.
 * `inline_worker` is the trap the classifier exists to catch: inline/daemon-
 * tick execution has no detached worker ownership that can survive and be
 * re-adopted after restart.
 *
 * POL-2044: `unproven_supervisor_isolation:*` fails a live detached worker
 * closed unless the launch evidence positively proves restart-survivable
 * supervisor isolation. Only Linux systemd cgroup isolation is proven to
 * survive a `run serve` restart (POL-1900); a `:direct` fallback/plain worker,
 * an `:unrecorded` (legacy) launch event, and a macOS `:launchd` host are all
 * unproven and drain rather than preserve.
 */
export type RunRestartReadoptReason =
  | "detached_agent_runner_worker"
  | "legacy_process_identity_unavailable"
  | "missing_record"
  | "non_agent_runner_kernel"
  | "inline_worker"
  | "no_execution_owner"
  | "active_app_server_binding"
  | "app_server_binding_unknown"
  | "unproven_supervisor_isolation:direct"
  | "unproven_supervisor_isolation:unrecorded"
  | "unproven_supervisor_isolation:launchd";

/**
 * Whether a non-terminal run is positively a live, detached `agent_runner`
 * worker that survives a daemon restart and is re-adopted by the boot
 * reconcile (run.readopt_on_boot/v1). Consumed by `self upgrade` to decide
 * which active runs can be preserved across a continuous restart.
 */
export interface RunRestartReadoptAssessment {
  run_id: string;
  readopt_safe: boolean;
  reason: RunRestartReadoptReason;
  /**
   * POL-2044: the supervisor recorded on the `launch_dispatched` evidence, when
   * present. Surfaced so `self upgrade` plan/receipts explain why a healthy run
   * drains (`direct`) versus preserves (`systemd`). Absent for inline runs and
   * legacy launch events that never recorded a supervisor.
   */
  worker_supervisor?: DetachedWorkerSupervisor;
}

export type EventCursor = string;

/**
 * Durable global-event cursors are deliberately opaque to consumers. New
 * cursors are fixed-width journal ordinals; the bounded ISO form is retained
 * only so an already-strict legacy prefix remains replayable across rollout.
 */
export const GLOBAL_EVENT_CURSOR_MAX_LENGTH = 512;
export const GLOBAL_EVENT_CURSOR_ORDINAL_WIDTH = 20;
const ALLOCATED_GLOBAL_EVENT_CURSOR_PATTERN = /^z1-[0-9]{20}$/u;
const LEGACY_GLOBAL_EVENT_CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-([A-Za-z0-9][A-Za-z0-9._:@/-]*)$/u;

export function isAllocatedGlobalEventCursor(cursor: string): boolean {
  return ALLOCATED_GLOBAL_EVENT_CURSOR_PATTERN.test(cursor)
    && BigInt(cursor.slice(3)) > 0n;
}

export function isLegacyGlobalEventCursor(cursor: string): boolean {
  if (cursor.length > GLOBAL_EVENT_CURSOR_MAX_LENGTH) return false;
  const match = LEGACY_GLOBAL_EVENT_CURSOR_PATTERN.exec(cursor);
  if (!match) return false;
  const timestamp = match[1]!;
  try {
    return new Date(timestamp).toISOString() === timestamp;
  } catch {
    return false;
  }
}

export function isGlobalEventCursor(cursor: string): boolean {
  return cursor.length <= GLOBAL_EVENT_CURSOR_MAX_LENGTH
    && (isAllocatedGlobalEventCursor(cursor) || isLegacyGlobalEventCursor(cursor));
}

export type CalyxRunEventType = "run.terminal" | "run.progress" | "run.warning";
export type CalyxMonitorEventType = "monitor.wake.created";
export type CalyxControlEventType =
  | "daemon.health.checked"
  | "daemon.drift.detected"
  | "daemon.upgrade.started"
  | "daemon.upgrade.progress"
  | "daemon.upgrade.completed"
  | "daemon.upgrade.failed"
  | "daemon.upgrade.fleet.started"
  | "daemon.upgrade.fleet.completed"
  | "daemon.upgrade.fleet.failed";

/**
 * Coarse phase of a `daemon.upgrade.progress` event. Emitted at the existing
 * single-host and fleet phase boundaries so an async agent watching the event
 * plane can distinguish "building" / "waiting on drain" / "all hosts done,
 * collecting receipts" without side-channel `self health` probes.
 *
 * Terminal/failure outcomes are carried by the dedicated
 * `daemon.upgrade.completed` / `.failed` (and fleet) events rather than a
 * progress phase, and single-host receipt-writing is folded into `finalize`,
 * so this union lists only the phases actually emitted as progress events.
 */
export type CalyxUpgradePhase =
  | "fetch"
  | "build"
  | "prepare"
  | "supervisor_ready"
  | "drain"
  | "state_snapshot"
  | "supervisor_install"
  | "promote"
  | "restart"
  | "health_wait"
  | "rollback"
  | "finalize";
export type CalyxStreamEventType =
  | CalyxRunEventType
  | CalyxControlEventType
  | CalyxMonitorEventType;

export type CalyxRunTerminalState =
  | "succeeded"
  | "failed"
  | "partial"
  | "infra_error"
  | "cancelled"
  | "completed_dirty"
  | "auth_error";

export interface CalyxRunEventOrigin {
  launcher_kind: "cli" | "daemon" | "plugin" | "session";
  launcher_id?: string;
  parent_run_id?: string;
  group_id?: string;
  reply_hint?: {
    ntfy_topic?: string;
    agent_mail_thread?: string;
  };
}

export interface CalyxRunEvent {
  schema_version: "1.0";
  event_id: string;
  cursor: EventCursor;
  emitted_at: string;
  event_type: CalyxRunEventType;
  emitted_by: "launch" | "reconcile";
  run: {
    run_id: string;
    /** Durable fresh-claim identity; absent only on events written before POL-2009. */
    incarnation_id?: string;
    state: CalyxRunTerminalState;
    previous_state?: string;
    kernel: ExecutionKernelId;
    backend?: "claude" | "codex";
    host: string;
    issue?: string;
    profile?: string;
    created_at: string;
    started_at?: string;
    completed_at?: string;
    duration_ms?: number;
    recovery_mode: RecoveryStatus["mode"];
    infra_error_classification?: InfraErrorClassification;
  };
  origin: CalyxRunEventOrigin;
  pointers: {
    run_dir: string;
    run_record_path: string;
    kernel_receipt_path?: string;
    events_path: string;
  };
  summary: {
    one_line: string;
    agent_terminal_message?: string;
    terminal_evidence?: AgentTerminalEvidence;
  };
  enrichment?: {
    worktree_path?: string;
    branch?: string;
    head_sha?: string;
    diffstat?: { files: number; additions: number; deletions: number };
    pr_url?: string;
  };
}

export type RunTerminalEvent = CalyxRunEvent & {
  event_type: "run.terminal";
  /**
   * Immutable terminal events are corrected by appending a typed successor;
   * the superseded event remains part of the durable audit history.
   */
  supersession?: {
    schema_version: "calyx.run-terminal-supersession/v1";
    supersedes_event_id: string;
    reason: "receipt_projection_corrected";
  };
};

export interface CalyxControlEvent {
  schema_version: "1.0";
  event_id: string;
  cursor: EventCursor;
  emitted_at: string;
  event_type: CalyxControlEventType;
  emitted_by: "self-upgrade" | "self-health" | "self-drift";
  control: {
    host: string;
    daemon_id?: string;
    /**
     * Stable operation id shared by every event of one upgrade operation
     * (single-host: the receipt basename; fleet: the aggregate-receipt dir
     * basename). Lets a watcher correlate started → progress → completed for a
     * given operation across a cold second-shell replay.
     */
    operation_id?: string;
    /** Phase boundary for `daemon.upgrade.progress` events. */
    phase?: CalyxUpgradePhase;
    /** Wall-clock milliseconds since the operation started, at emit time. */
    elapsed_ms?: number;
    severity?: "broken" | "incompatible" | "critical" | "major" | "minor" | "current";
    build?: {
      git_head: string;
      built_at: string;
    };
    error?: string;
    fleet?: {
      target_ref?: string;
      parallel?: boolean;
      dry_run?: boolean;
      fail_fast?: boolean;
      hosts?: Record<string, {
        status: "pending" | "dry-run" | "succeeded" | "unverified" | "failed" | "skipped";
        receipt_path?: string;
        error?: string;
      }>;
    };
  };
}

export interface CalyxMonitorEvent {
  schema_version: "1.0";
  event_id: string;
  cursor: EventCursor;
  emitted_at: string;
  event_type: CalyxMonitorEventType;
  emitted_by: "monitor";
  monitor: {
    monitor_id: string;
    wake_id: string;
    status: MonitorWakeStatus;
    transition_hash: string;
    rearm_policy: MonitorRearmPolicy;
    owner: string;
    assigned_host?: string;
    source_run_id?: string;
    preset?: string;
    receipt_path?: string;
    suggested_commands: string[];
  };
  predicate: PredicateV1;
  evaluation: PredicateEvaluationResult;
  summary: {
    one_line: string;
  };
}

export type CalyxStreamEvent =
  | CalyxRunEvent
  | CalyxControlEvent
  | CalyxMonitorEvent;

/**
 * Delivery-only receipt for a durable source event that cannot be represented
 * within the admin SSE frame contract. This shape is never durable event
 * authority: its cursor names the source row that the client may resume after.
 */
export interface CalyxStreamProjectionGapEvent {
  schema_version: "calyx.stream-projection-gap/v1";
  cursor: EventCursor;
  event_type: "stream.projection_gap";
  gap: {
    reason: "source_event_exceeds_frame_limit";
    source_event_type: CalyxStreamEventType;
  };
}

/** One admin-stream delivery frame: durable source data or an explicit gap. */
export type CalyxDeliveredStreamEvent =
  | CalyxStreamEvent
  | CalyxStreamProjectionGapEvent;

const streamNonEmptyString = z.string().min(1);
const streamEventCursor = z.string()
  .min(1)
  .max(GLOBAL_EVENT_CURSOR_MAX_LENGTH)
  .refine(isGlobalEventCursor, "must be an allocated z1 cursor or a bounded canonical legacy ISO cursor");
const closedSafetyReceiptDescription =
  `${CALYX_CLOSED_RESPONSE_OBJECT_DESCRIPTION_PREFIX}safety-redaction-receipt`;
export const calyxStreamProjectionGapEventSchema = z.object({
  schema_version: z.literal("calyx.stream-projection-gap/v1"),
  cursor: streamEventCursor,
  event_type: z.literal("stream.projection_gap"),
  gap: z.object({
    reason: z.literal("source_event_exceeds_frame_limit"),
    source_event_type: z.enum([
      "run.terminal",
      "run.progress",
      "run.warning",
      "daemon.health.checked",
      "daemon.drift.detected",
      "daemon.upgrade.started",
      "daemon.upgrade.progress",
      "daemon.upgrade.completed",
      "daemon.upgrade.failed",
      "daemon.upgrade.fleet.started",
      "daemon.upgrade.fleet.completed",
      "daemon.upgrade.fleet.failed",
      "monitor.wake.created",
    ]),
  }).strict().describe(closedSafetyReceiptDescription),
}).strict().describe(closedSafetyReceiptDescription);
const streamTimestamp = z.string().datetime();
const streamInfraErrorClassificationSchema = z.object({
  schema_version: z.literal("infra_error_classification/v1"),
  failure_layer: streamNonEmptyString,
  failure_reason: streamNonEmptyString,
  message: streamNonEmptyString,
}).passthrough();
const streamEventBase = z.object({
  schema_version: z.literal("1.0"),
  event_id: streamNonEmptyString,
  cursor: streamEventCursor,
  emitted_at: streamTimestamp,
}).passthrough();
const runStreamEventSchema = streamEventBase.extend({
  event_type: z.enum(["run.terminal", "run.progress", "run.warning"]),
  emitted_by: streamNonEmptyString,
  run: z.object({
    run_id: streamNonEmptyString,
    incarnation_id: streamNonEmptyString.optional(),
    state: streamNonEmptyString,
    previous_state: streamNonEmptyString.optional(),
    kernel: streamNonEmptyString,
    backend: streamNonEmptyString.optional(),
    host: streamNonEmptyString,
    issue: streamNonEmptyString.optional(),
    profile: streamNonEmptyString.optional(),
    created_at: streamTimestamp,
    started_at: streamTimestamp.optional(),
    completed_at: streamTimestamp.optional(),
    duration_ms: z.number().finite().nonnegative().optional(),
    recovery_mode: streamNonEmptyString,
    infra_error_classification: streamInfraErrorClassificationSchema.optional(),
  }).passthrough(),
  origin: z.object({
    launcher_kind: streamNonEmptyString,
    launcher_id: streamNonEmptyString.optional(),
    parent_run_id: streamNonEmptyString.optional(),
    group_id: streamNonEmptyString.optional(),
    reply_hint: z.object({
      ntfy_topic: streamNonEmptyString.optional(),
      agent_mail_thread: streamNonEmptyString.optional(),
    }).passthrough().optional(),
  }).passthrough(),
  pointers: z.object({
    run_dir: streamNonEmptyString,
    run_record_path: streamNonEmptyString,
    kernel_receipt_path: streamNonEmptyString.optional(),
    events_path: streamNonEmptyString,
  }).passthrough(),
  summary: z.object({
    one_line: z.string(),
    agent_terminal_message: z.string().optional(),
    terminal_evidence: z.object({
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
    }).passthrough().optional(),
  }).passthrough(),
  enrichment: z.object({
    worktree_path: streamNonEmptyString.optional(),
    branch: streamNonEmptyString.optional(),
    head_sha: streamNonEmptyString.optional(),
    diffstat: z.object({
      files: z.number().int().nonnegative(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    }).passthrough().optional(),
    pr_url: streamNonEmptyString.optional(),
  }).passthrough().optional(),
  supersession: z.object({
    schema_version: z.literal("calyx.run-terminal-supersession/v1"),
    supersedes_event_id: streamNonEmptyString,
    reason: streamNonEmptyString,
  }).passthrough().optional(),
}).passthrough();
const controlStreamEventSchema = streamEventBase.extend({
  event_type: z.enum([
    "daemon.health.checked",
    "daemon.drift.detected",
    "daemon.upgrade.started",
    "daemon.upgrade.progress",
    "daemon.upgrade.completed",
    "daemon.upgrade.failed",
    "daemon.upgrade.fleet.started",
    "daemon.upgrade.fleet.completed",
    "daemon.upgrade.fleet.failed",
  ]),
  emitted_by: streamNonEmptyString,
  control: z.object({
    host: streamNonEmptyString,
    daemon_id: streamNonEmptyString.optional(),
    operation_id: streamNonEmptyString.optional(),
    phase: streamNonEmptyString.optional(),
    elapsed_ms: z.number().finite().nonnegative().optional(),
    severity: streamNonEmptyString.optional(),
    build: z.object({ git_head: streamNonEmptyString, built_at: streamTimestamp }).passthrough().optional(),
    error: z.string().optional(),
    fleet: z.object({
      target_ref: streamNonEmptyString.optional(),
      parallel: z.boolean().optional(),
      dry_run: z.boolean().optional(),
      fail_fast: z.boolean().optional(),
      hosts: z.record(z.string(), z.object({
        status: streamNonEmptyString,
        receipt_path: streamNonEmptyString.optional(),
        error: z.string().optional(),
      }).passthrough()).optional(),
    }).passthrough().optional(),
  }).passthrough(),
}).passthrough();
const predicateArtifactIdentitySchema = z.object({
  exists: z.boolean().optional(),
  path: z.string().optional(),
  mtime_ms: z.number().finite().optional(),
  size: z.number().finite().nonnegative().optional(),
  sha256: z.string().optional(),
}).passthrough();
const predicateStreamSchema: z.ZodType = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ schema_version: z.literal("predicate/v1"), kind: z.literal("run.terminal"), run_id: streamNonEmptyString }).passthrough(),
  z.object({ schema_version: z.literal("predicate/v1"), kind: z.literal("run.failed"), run_id: streamNonEmptyString }).passthrough(),
  z.object({ schema_version: z.literal("predicate/v1"), kind: z.literal("run.health_stale"), run_id: streamNonEmptyString, threshold_ms: z.number().finite().nonnegative() }).passthrough(),
  z.object({ schema_version: z.literal("predicate/v1"), kind: z.literal("artifact.exists"), path: streamNonEmptyString }).passthrough(),
  z.object({ schema_version: z.literal("predicate/v1"), kind: z.literal("artifact.changed"), path: streamNonEmptyString, baseline: predicateArtifactIdentitySchema.optional() }).passthrough(),
  z.object({ schema_version: z.literal("predicate/v1"), kind: z.literal("receipt.appeared"), run_id: streamNonEmptyString }).passthrough(),
  z.object({ schema_version: z.literal("predicate/v1"), kind: z.literal("tracker.state_changed"), tracker_id: streamNonEmptyString, to_state: streamNonEmptyString }).passthrough(),
  z.object({ schema_version: z.literal("predicate/v1"), kind: z.literal("tracker.label_changed"), tracker_id: streamNonEmptyString, label: streamNonEmptyString }).passthrough(),
  z.object({ schema_version: z.literal("predicate/v1"), kind: z.literal("vault.path_changed"), path: streamNonEmptyString }).passthrough(),
  z.object({ schema_version: z.literal("predicate/v1"), kind: z.literal("time.cron"), expr: streamNonEmptyString, timezone: streamNonEmptyString.optional() }).passthrough(),
  z.object({ schema_version: z.literal("predicate/v1"), kind: z.literal("time.after"), at: streamTimestamp }).passthrough(),
  z.object({ schema_version: z.literal("predicate/v1"), kind: z.literal("all_of"), predicates: z.array(predicateStreamSchema) }).passthrough(),
  z.object({ schema_version: z.literal("predicate/v1"), kind: z.literal("any_of"), predicates: z.array(predicateStreamSchema) }).passthrough(),
  z.object({ schema_version: z.literal("predicate/v1"), kind: z.literal("debounce"), predicate: predicateStreamSchema, window_ms: z.number().finite().nonnegative() }).passthrough(),
  z.object({ schema_version: z.literal("predicate/v1"), kind: z.literal("for_duration"), predicate: predicateStreamSchema, duration_ms: z.number().finite().nonnegative() }).passthrough(),
]));
const monitorStreamEventSchema = streamEventBase.extend({
  event_type: z.literal("monitor.wake.created"),
  emitted_by: streamNonEmptyString,
  monitor: z.object({
    monitor_id: streamNonEmptyString,
    wake_id: streamNonEmptyString,
    status: streamNonEmptyString,
    transition_hash: streamNonEmptyString,
    rearm_policy: streamNonEmptyString,
    owner: streamNonEmptyString,
    assigned_host: streamNonEmptyString.optional(),
    source_run_id: streamNonEmptyString.optional(),
    preset: streamNonEmptyString.optional(),
    receipt_path: streamNonEmptyString.optional(),
    suggested_commands: z.array(z.string()),
  }).passthrough(),
  predicate: predicateStreamSchema,
  evaluation: z.object({
    schema_version: z.literal("predicate-evaluation/v1"),
    evaluated_at: streamTimestamp,
    matched: z.boolean(),
    predicate_hash: streamNonEmptyString,
    transition_hash: streamNonEmptyString,
    fingerprint: streamNonEmptyString,
    cursor: z.record(z.string(), z.unknown()),
    evidence: z.array(z.object({
      schema_version: z.literal("predicate-evidence/v1"),
      kind: streamNonEmptyString,
      source: streamNonEmptyString,
      locator: streamNonEmptyString,
      observed_at: streamTimestamp,
      status: streamNonEmptyString,
      detail: z.string().optional(),
      cursor: z.string().optional(),
      value: z.unknown().optional(),
    }).passthrough()),
    warnings: z.array(z.string()),
  }).passthrough(),
  summary: z.object({ one_line: z.string() }).passthrough(),
}).passthrough();

const calyxStreamEventSchema = z.union([
  runStreamEventSchema,
  controlStreamEventSchema,
  monitorStreamEventSchema,
]);

/** Parse one durable global-index row without silently dropping corrupt data. */
export function parseCalyxStreamEvent(event: unknown): CalyxStreamEvent {
  return calyxStreamEventSchema.parse(event) as CalyxStreamEvent;
}

export interface CalyxStreamEventFilter {
  run_id?: string;
  event_type?: CalyxStreamEventType;
}

export type CalyxRunEventFilter = CalyxStreamEventFilter;

export interface RunServiceEvent {
  timestamp: string;
  run_id: string;
  source: "run-service";
  event:
    | "intent_persisted"
    | "launch_intent"
    | "launch_result"
    | "spec_persisted"
    | "launch_dispatched"
    | "execution_admission_refused"
    | "launch_started"
    | "launch_completed"
    | "integration_started"
    | "integration_finished"
    | "handback_emitted"
    | "handback_withheld"
    | "stop_intent"
    | "stop_result"
    | "reconcile_intent"
    | "reconcile_result"
    | "reconciled"
    | "warning";
  message: string;
  /** Authenticated request attribution when this event represents an HTTP mutation. */
  provenance?: ApiProvenanceV1;
  payload?: Record<string, unknown>;
}

export type RecordedRunEvent = LifecycleEvent | RunServiceEvent | CalyxRunEvent;

export function isRunServiceEvent(event: RecordedRunEvent): event is RunServiceEvent {
  return "source" in event && event.source === "run-service";
}

export function isCalyxRunEvent(event: unknown): event is CalyxRunEvent {
  return runStreamEventSchema.safeParse(event).success;
}

export function isCalyxControlEvent(event: unknown): event is CalyxControlEvent {
  return controlStreamEventSchema.safeParse(event).success;
}

export function isCalyxMonitorEvent(event: unknown): event is CalyxMonitorEvent {
  return monitorStreamEventSchema.safeParse(event).success;
}

export function isCalyxStreamEvent(event: unknown): event is CalyxStreamEvent {
  return isCalyxRunEvent(event as RecordedRunEvent)
    || isCalyxControlEvent(event)
    || isCalyxMonitorEvent(event);
}

export function isCalyxStreamProjectionGapEvent(
  event: unknown,
): event is CalyxStreamProjectionGapEvent {
  return calyxStreamProjectionGapEventSchema.safeParse(event).success;
}

export function isCalyxDeliveredStreamEvent(event: unknown): event is CalyxDeliveredStreamEvent {
  return isCalyxStreamEvent(event) || isCalyxStreamProjectionGapEvent(event);
}

export function toCalyxStreamProjectionGapEvent(
  event: CalyxStreamEvent,
): CalyxStreamProjectionGapEvent {
  return calyxStreamProjectionGapEventSchema.parse({
    schema_version: "calyx.stream-projection-gap/v1",
    cursor: event.cursor,
    event_type: "stream.projection_gap",
    gap: {
      reason: "source_event_exceeds_frame_limit",
      source_event_type: event.event_type,
    },
  });
}

export function isRunTerminalEvent(event: unknown): event is RunTerminalEvent {
  return isCalyxRunEvent(event) && event.event_type === "run.terminal";
}

export interface TemplateResolution {
  templateId: string;
  prompt: string;
  templatePath: string;
}

export interface RunSubscriberContext {
  run_dir: string;
  intent: RunIntent;
  spec: StoredResolvedSpec;
  kernel_receipt: ExecutionReceipt;
  run_record: RunRecord;
}

export interface RunSubscriber {
  name: string;
  critical?: boolean;
  run(context: RunSubscriberContext): Promise<IntegrationResult>;
}

export interface TrackerStateRef {
  name: string;
  type?: string | undefined;
}

export interface TrackerIssue {
  id: string;
  identifier: string;
  title: string;
  url?: string | undefined;
  updated_at: string;
  state: TrackerStateRef;
  labels: string[];
  team?: string | undefined;
  project?: string | undefined;
}

export interface TrackerPollRequest {
  team?: string | undefined;
  project?: string | undefined;
}

export interface TrackerPollResult {
  fetched_at: string;
  issues: TrackerIssue[];
}

export interface TrackerClaimRequest {
  issue: TrackerIssue;
  /** Target state name (e.g. workflow.claim_state). */
  target_state: string;
}

export interface TrackerClaimResult {
  issue_id: string;
  identifier: string;
  previous_state: string;
  current_state: string;
  /** True if the tracker actually transitioned the issue. */
  transitioned: boolean;
  transition_at: string;
}

export interface TrackerHandoffRequest {
  issue: TrackerIssue;
  /** Target state name (e.g. workflow.handoff_state). */
  target_state: string;
  /** Bounded receipt payload posted as a tracker comment. */
  comment_body: string;
}

export interface TrackerHandoffResult {
  issue_id: string;
  identifier: string;
  previous_state: string;
  current_state: string;
  transitioned: boolean;
  transition_at: string;
  comment_id?: string;
}

export interface TrackerClient {
  readonly kind: string;
  pollIssues(request: TrackerPollRequest): Promise<TrackerPollResult>;
  /**
   * Optional v0 mutation seam. The daemon calls this when claiming an
   * eligible issue. Trackers that do not implement it leave the issue
   * in its source state and the daemon proceeds with claim-by-launch.
   */
  claimIssue?(request: TrackerClaimRequest): Promise<TrackerClaimResult>;
  /**
   * Optional v0 mutation seam. The daemon calls this when a successful
   * terminal run is handed off. Trackers that do not implement it leave
   * the issue in its source state and rely on the operator to advance it.
   */
  handoffIssue?(request: TrackerHandoffRequest): Promise<TrackerHandoffResult>;
}

export type TrackerClientFactory = () => TrackerClient;

export interface TrackerRegistry {
  register(kind: string, factory: TrackerClientFactory): void;
  create(kind: string): TrackerClient;
  has(kind: string): boolean;
  list(): string[];
}

export interface WorkflowTrackerConfig {
  kind: string;
  team?: string | undefined;
  project?: string | undefined;
  active_states: string[];
  terminal_states: string[];
  /**
   * State name issues are transitioned into when the daemon claims them.
   * Wave 3 default: "In Progress".
   */
  claim_state: string;
  /**
   * State name issues are transitioned into when the daemon hands them
   * off after a successful terminal run. Wave 3 default: "In Review".
   * Done is NOT inferred — the daemon does not mark issues complete.
   */
  handoff_state: string;
  include_labels?: string[] | undefined;
  exclude_labels?: string[] | undefined;
}

export interface WorkflowSelectionConfig {
  /**
   * Hard cap on the number of issues a daemon tick may select for launch.
   * This is intentionally separate from max_concurrent_agents: concurrency
   * limits running lanes, while selection caps protect operator intent.
   */
  max_selected_issues?: number | undefined;
}

export interface WorkflowPolicyConfig {
  /**
   * Explicit escape hatch for daemon workflows that really are allowed to
   * hand off directly to Done. The default policy is In Review.
   */
  allow_done_handoff: boolean;
}

export interface WorkflowPollingConfig {
  interval_seconds: number;
  idle_backoff_seconds: number;
  max_interval_seconds: number;
  stall_timeout_seconds: number;
  max_concurrent_agents: number;
  continuation_delay_seconds: number;
  failure_backoff_seconds: number;
  max_failure_backoff_seconds: number;
  max_retries: number;
}

export interface WorkflowWorkspaceConfig {
  root: string;
  repo_root: string;
  branch_template: string;
  ref: string;
  cleanup_terminal_after_hours?: number | undefined;
  after_create?: string[] | undefined;
  before_run?: string[] | undefined;
  after_run?: string[] | undefined;
  before_remove?: string[] | undefined;
}

export interface WorkflowAgentConfig {
  host: string;
  backend: SupportedBackend;
  profile?: string | undefined;
  max_turns_per_run: number;
  require_execplan: boolean;
  pull_execplan: boolean;
  allowed_tools?: string[] | undefined;
  dangerously_skip_permissions?: boolean;
  max_threads?: number | undefined;
  max_turns?: number | undefined;
}

export interface WorkflowLoggingConfig {
  level: "debug" | "info" | "warn" | "error";
}

export interface WorkflowConfig {
  tracker: WorkflowTrackerConfig;
  polling: WorkflowPollingConfig;
  selection: WorkflowSelectionConfig;
  workflow_policy: WorkflowPolicyConfig;
  workspace: WorkflowWorkspaceConfig;
  agent: WorkflowAgentConfig;
  logging: WorkflowLoggingConfig;
}

export interface WorkflowFile {
  path: string;
  loaded_at: string;
  config: WorkflowConfig;
  prompt_template: string;
  raw_frontmatter: Record<string, unknown>;
}

export type DaemonStatus = "idle" | "running" | "stopped" | "error";

export type IssueDispatchStatus =
  | "idle"
  | "running"
  | "cancellation_requested"
  | "waiting_continuation"
  | "waiting_retry"
  | "waiting_external"
  | "released";

export interface IssueRuntimeRecord {
  issue_id: string;
  issue_identifier: string;
  title: string;
  state_name: string;
  state_type?: string | undefined;
  workspace_key: string;
  workspace_path: string;
  branch_name: string;
  status: IssueDispatchStatus;
  claim_status: "unclaimed" | "claimed" | "released";
  retry_count: number;
  last_seen_at: string;
  tracker_updated_at?: string | undefined;
  last_run_id?: string | undefined;
  active_run_id?: string | undefined;
  last_run_state?: RunState | undefined;
  last_run_completed_at?: string | undefined;
  continuation_due_at?: string | undefined;
  retry_due_at?: string | undefined;
  last_backend_session_id?: string | undefined;
  last_backend_thread_id?: string | undefined;
  last_error?: string | undefined;
  after_run_applied_at?: string | undefined;
  after_run_applied_for_run_id?: string | undefined;
  released_at?: string | undefined;
  /** Wall-clock when the daemon first wrote a claim event for this issue. */
  claimed_at?: string | undefined;
  /** Wall-clock when the daemon last dispatched a run for this issue. */
  launched_at?: string | undefined;
  /** Wall-clock of the most recent terminal run completion. */
  terminal_at?: string | undefined;
  /** Wall-clock when the daemon posted the handoff receipt. */
  handoff_at?: string | undefined;
  /** Ledger cursor for the most recent event the daemon wrote. */
  last_ledger_cursor?: string | undefined;
}

export interface DaemonStateSnapshot {
  schema_version: "1.0";
  daemon_id: string;
  workflow_path: string;
  current_interval_seconds: number;
  active_run_ids: string[];
  issues: Record<string, IssueRuntimeRecord>;
  last_tick_at?: string | undefined;
  last_tracker_sync_at?: string | undefined;
  next_poll_at?: string | undefined;
  last_error?: string | undefined;
}

export interface DaemonRecord {
  schema_version: "1.0";
  daemon_id: string;
  workflow_path: string;
  status: DaemonStatus;
  created_at: string;
  updated_at: string;
  started_at?: string | undefined;
  stopped_at?: string | undefined;
  pid?: number | undefined;
  claimed_issues: number;
  active_runs: number;
  last_tick_at?: string | undefined;
  last_tracker_sync_at?: string | undefined;
  next_poll_at?: string | undefined;
  last_error?: string | undefined;
}

export interface DaemonDescriptor {
  schema_version: "1.0";
  daemon_id: string;
  workflow_path: string;
  created_at: string;
}

export interface DaemonEvent {
  timestamp: string;
  daemon_id: string;
  level: "info" | "warn" | "error";
  event: string;
  message: string;
  payload?: Record<string, unknown> | undefined;
}

/**
 * Bounded payload for the v0 handoff receipt the daemon posts back to
 * the tracker on successful terminal handoff. Stays narrow so we do not
 * leak unbounded prompt content into the tracker.
 */
export interface DaemonHandoffReceipt {
  schema_version: "calyx.daemon.handoff/v1";
  daemon_id: string;
  workflow_path: string;
  workflow_hash: string;
  issue_id: string;
  issue_identifier: string;
  selected_issue: {
    id: string;
    identifier: string;
    title: string;
  };
  run_id: string;
  worktree_path?: string;
  branch?: string;
  pr_url?: string;
  changed_files: string[];
  commands: string[];
  artifacts: string[];
  warnings: DaemonPlanWarning[];
  stop_condition_review: {
    status: "pending";
    summary: string;
  };
  handoff: {
    target_state: string;
    conductor_review_required: boolean;
    state: "ready_for_review" | "done_allowed";
  };
  /** Resolved activity id (POL-1389 run activity bridge) or undefined. */
  activity_id?: string;
  /** Explicit reason when activity_id is missing. */
  activity_missing_reason?: string;
  /** Latest or terminal assistant turn id when available. */
  latest_assistant_turn_id?: string;
  /** Highest ledger cursor written by the daemon for this issue at handoff. */
  ledger_cursor?: string;
  /** Issue state transition timestamps captured by the daemon. */
  transitions: {
    claimed_at?: string;
    launched_at?: string;
    terminal_at?: string;
    handoff_at?: string;
  };
  /** Run terminal state (succeeded, completed_dirty, ...). */
  run_state: RunState;
  /** Short, single-line summary. */
  summary: string;
}

/**
 * Optional resolver the daemon uses to map a terminal run to its
 * activity bridge handle and latest assistant turn. Production wires
 * this to the run-service activity APIs (POL-1389). Tests use a fake.
 */
export interface DaemonActivityResolver {
  resolve(input: {
    run_id: string;
    intent: RunIntent;
    record: RunRecord;
  }): Promise<{
    activity_id?: string;
    activity_missing_reason?: string;
    latest_assistant_turn_id?: string;
  }>;
}

export interface DaemonTickOptions {
  awaitLaunchedRuns?: boolean | undefined;
}

export interface DaemonTickResult {
  daemon_id: string;
  workflow_path: string;
  workflow_snapshot_from_cache: boolean;
  tracker_issues: number;
  eligible_issues: number;
  active_runs: number;
  launched_runs: string[];
  continued_runs: string[];
  retried_runs: string[];
  cancellation_requested_runs: string[];
  released_issues: string[];
  cleaned_workspaces: string[];
  next_poll_at: string;
  preflight_verdict?: DaemonPlanVerdict | undefined;
  warnings?: DaemonPlanWarning[] | undefined;
}

export type DaemonPlanWarningSeverity = "info" | "warn" | "error";

export interface DaemonPlanWarning {
  code: string;
  severity: DaemonPlanWarningSeverity;
  message: string;
  issue_identifier?: string | undefined;
  run_id?: string | undefined;
  hint?: string | undefined;
}

export interface DaemonPlanIssueSummary {
  issue_id: string;
  issue_identifier: string;
  title: string;
  state_name: string;
  state_type?: string | undefined;
  labels: string[];
  reason: string;
  updated_at?: string | undefined;
  run_id?: string | undefined;
}

export interface DaemonPlanActiveRun {
  issue_identifier: string;
  run_id: string;
  source: "daemon_state" | "in_memory";
  state?: RunState | "missing" | undefined;
  worktree_path?: string | undefined;
  branch?: string | undefined;
}

export interface DaemonReconciliationFlag {
  code:
    | "run_daemon_state_mismatch"
    | "missing_activity"
    | "missing_receipt"
    | "missing_run_record"
    | "missing_worktree"
    | "missing_branch";
  severity: "warn" | "error";
  issue_identifier?: string | undefined;
  run_id?: string | undefined;
  message: string;
}

export interface DaemonPlanVerdict {
  safe_to_launch: boolean;
  verdict: "safe" | "unsafe";
  blocking_reasons: string[];
  checks: Array<{
    name: string;
    status: "ok" | "warn" | "error" | "skipped";
    message: string;
  }>;
}

export interface DaemonPlanResult {
  schema_version: "calyx.daemon.plan/v1";
  daemon_id: string;
  workflow_path: string;
  workflow_snapshot_from_cache: false;
  planned_at: string;
  tracker_issues: number;
  eligible_issues: DaemonPlanIssueSummary[];
  skipped_issues: DaemonPlanIssueSummary[];
  active_runs: DaemonPlanActiveRun[];
  available_launch_slots: number;
  selected_issues: DaemonPlanIssueSummary[];
  selection: {
    max_selected_issues?: number | undefined;
    selected_count: number;
    eligible_count: number;
  };
  warnings: DaemonPlanWarning[];
  reconciliation_flags: DaemonReconciliationFlag[];
  verdict: DaemonPlanVerdict;
}

export interface DaemonStartResult {
  daemon_id: string;
  state_root: string;
  record: DaemonRecord;
  pid?: number | undefined;
}
