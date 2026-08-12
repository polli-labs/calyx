import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname as systemHostname, homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  ClassifierPipeline,
  createBuiltInRuntimeAdapterRegistry,
  type RuntimeAdapterRegistry,
  executeRun,
  type AgentRunnerSessionCheckpoint,
  type ArtifactEntry,
  type ClassifyInfraErrorContext,
  type InfraErrorClassification,
  type LifecycleEvent,
  type RunHandbackSpec,
  type RunSpec,
  type RunState,
  type WorktreeLease,
  type WorktreeLeaseManager,
  classifyInfraError,
  infraErrorClassificationSchema,
  normalizeInfraErrorClassification,
  RECEIPT_TIMING_TOLERANCE_MS,
  receiptExitSchema,
  receiptLogSummarySchema,
  receiptTimingSchema,
  runReceiptSchema,
  runStateSchema,
} from "@polli-labs/calyx-runner";
import { z } from "zod";
import {
  acquireLease,
  applyStateMigrations,
  checkActivityIndexSchema,
  checkMessageSchema,
  createMessage,
  drainMessageReceiptMirrors,
  enqueueMessageReceiptMirror,
  enqueueMessageOutbox,
  hashCanonicalJcs,
  isSqliteBusyError,
  listLeases,
  listTerminalLeaseReleaseEventsForRun,
  listActivityAttachmentsForMessageIds,
  listActivityMessagesForActivity,
  openStateStore,
  parseJsonWithoutDuplicateObjectMembers,
  quarantineOwnerFreeRunWorktreeLeases,
  quarantineRunWorktreeLeases,
  readMessage,
  readActivitySourceCursor,
  readLatestActivityIndexRun,
  readRunnerLiveBindingByRunAdapter,
  releaseLease,
  releaseLeasesForTerminalRuns,
  releaseQuarantinedRunWorktreeLeases,
  renewLease,
  resolveMessageAddress,
  SqliteMutexBusyError,
  stealLease,
  validateApiProvenance,
  withSqliteBusyRetry,
  withSqliteMutex,
  WORKLOAD_ADMISSION_DECISION_SCHEMA_VERSION,
  WORKLOAD_ADMISSION_GATE_RECEIPT_SCHEMA_VERSION,
  WORKLOAD_ADMISSION_INTERIM_DEFERRED_SURFACES,
  WORKLOAD_ADMISSION_INTERIM_PROFILE,
  WORKLOAD_ADMISSION_INTERIM_SURFACES,
  WORKLOAD_ADMISSION_TARGET_BUNDLE_SCHEMA_VERSION,
  WorkloadAdmissionEvidenceError,
} from "@polli-labs/calyx-core";
import type {
  ActivityMarkTargetKind,
  ApiProvenanceV1,
  CalyxAdminReconcileUnresolvedReason,
  EventLogIngest,
  LeaseEventRow,
  LeaseRow,
  MessageRow,
  ParsedActivityMarkTarget,
  ResolvedMessageAddress,
  RunIndexProjection,
  StateDriverDatabase,
  StateOpenOptions,
  WorkloadAdmissionDecisionV1,
  WorkloadAdmissionFenceReason,
  WorkloadAdmissionGateReceiptV1,
  WorkloadAdmissionReconciler,
} from "@polli-labs/calyx-core";
import { AgentRunnerKernel, HostProcessKernel, type ExecutionKernel } from "./kernel.js";
import {
  REVIEW_RUN_EVIDENCE_RECEIPT_SCHEMA_VERSION,
  canonicalizeIndependentReviewJson,
  readIndependentReviewAdminProjection,
  recordIndependentReviewEvidenceFromRunService,
  recordReviewerRunObservationFromRunService,
  type IndependentReviewAdminProjection,
  type ReviewRunEvidenceReceipt,
} from "./review-coordinator.js";
import type { ReviewPublisherIdentities } from "./review-publication.js";
import {
  admitHostProcessExecution,
  freezeHostProcessSpawnEnvironment,
  HOST_PROCESS_EXECUTION_BINDING_SCHEMA_VERSION,
  type AdmittedHostProcessExecution,
} from "./host-process-execution-binding.js";
import {
  assertCanonicalRunId,
  assertRunRecordIdentity,
  EventJournalCorruptionError,
  hasLegacyDeadSettlement,
  hasLegacyResourceSettlement,
  hasSynthesizedLegacyAdmission,
  legacyDeadSettlementAuthorityId,
  legacyResourceSettlementAuthorityId,
  issueRunCreationAdmission,
  RunCreationConflictError,
  RunListSnapshotChangedError,
  RunStore,
  type RunCreationAdmission,
  defaultRunsRoot,
  isRunResourceTerminal,
  isTerminalState,
  runRecordIdentityMismatch,
} from "./store.js";
import {
  DEFAULT_INTERACTIVE_ACTIVITY_LOOKBACK_MS,
  DEFAULT_INTERACTIVE_PAGE_CANDIDATE_LIMIT,
  InteractiveActivityProjectionNotReadyError,
  inspectInteractiveSession,
  listInteractiveSessionIdentities,
  listInteractiveSessions,
  listInteractiveSessionsSnapshotPage,
  summarizeInteractiveSessions,
} from "./interactive-activity.js";
import {
  ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
  ACTIVITY_RECALL_STORE_BLOCKED_RECONCILIATION,
  ActivityIdAmbiguousError,
  ActivityIdNotFoundError,
  ActivityMessageSelectorError,
  ActivityRunMissingMetadataError,
  ActivityTurnSelectorError,
  inspectActivityAttachments,
  inspectActivityAttachmentRecord,
  inspectActivityEvents,
  inspectActivityMessages,
  inspectActivityMessagesFromStore,
  inspectActivityText,
  inspectActivityTurns,
  inspectActivityTurnsFromStore,
  isActivityRecallStoreBlocked,
  parseActivityMessageId,
  parseActivityTurnId,
  readActivityAttachmentBytes,
  resolveInteractiveActivity,
} from "./activity-messages.js";
import type {
  ActivityAttachmentBytesResult,
  ActivityAttachmentRecordResult,
  ActivityAttachmentsResult,
  ActivityAttachmentsSelectorInput,
  ActivityEventSelectorInput,
  ActivityEventsResult,
  ActivityMessageSelectorInput,
  ActivityMessagesResult,
  ActivityRecallFreshness,
  ActivityTextResult,
  ActivityTextSelectorInput,
  ActivityTurnSelectorInput,
  ActivityTurnsResult,
  InspectActivityAttachmentRecordOptions,
  ResolvedInteractiveActivity,
  RunActivityRecordResolver,
} from "./activity-messages.js";
import type {
  CalyxRunEventFilter,
  CalyxRunEventOrigin,
  CalyxStreamEvent,
  CalyxRunTerminalState,
  BoundHostProcessReceipt,
  ExecutionReceipt,
  HostProcessExecutionBinding,
  HostProcessReceipt,
  IntegrationResult,
  IntegrationStatus,
  InteractiveSessionBackend,
  InteractiveSessionInspectResult,
  InteractiveSessionSummary,
  RecordedRunEvent,
  ReconcileResult,
  RunCancellationRequest,
  RunRestartReadoptAssessment,
  RunRestartReadoptReason,
  ResolvedExecutionSpec,
  ResolvedHostProcessSpec,
  ResolvedRunSpec,
  RunActivityEntry,
  RunHealthSnapshot,
  RunIntent,
  RunExecutionAdmissionRefusal,
  RunLaunchState,
  RunLaunchMode,
  RunLaunchResult,
  RunListEntry,
  RunNextTurnInput,
  RunRecord,
  RunTerminalEvent,
  RunServiceEvent,
  RunSubscriber,
  RunSubscriberContext,
  RunHostResourceObservation,
  RunLogResult,
  RunObservationResult,
  RunResourceAttributionObservation,
  RunServiceInfraErrorCensusPoint,
  ResumeWorktreeResolution,
} from "./types.js";
import {
  HOST_PROCESS_RECEIPT_SCHEMA_VERSION,
  isCalyxRunEvent,
  isRunServiceEvent,
  isRunTerminalEvent,
} from "./types.js";
import { readRunLogs, type ReadRunLogsOptions } from "./run-logs.js";
import { collectHostResources } from "./host-resources.js";
import { collectResourceAttribution } from "./resource-attribution.js";
import { observeRun } from "./run-observation.js";
import {
  MonitorEvaluator,
  type MonitorEvaluatorTickResult,
} from "./monitor-evaluator.js";
import {
  ActivityTailer,
  type ActivityTailerTickResult,
} from "./activity-tailer.js";
import type { MonitorDeliveryDependencies } from "./monitor-delivery.js";
import type { SessionWakeRouteDependencies } from "./session-ingress.js";
import {
  MessageOutboxForwarder,
  type MessageOutboxDrainResult,
  type MessageOutboxForwardResult,
  type MessageOutboxForwarderOptions,
  type MessageOutboxObservationResult,
} from "./message-outbox-forwarder.js";
import {
  auditInfraErrorCensusAuthority,
  projectInfraErrorCensusAuthority,
  type InfraErrorCensusAuthorityAudit,
} from "./infra-error-census.js";
import {
  spawnDetachedWorker,
  type DetachedWorkerLaunchResult,
  type DetachedWorkerSupervisor,
} from "./worker-supervisor.js";
export { openDetachedLogFiles } from "./worker-supervisor.js";

const DEFAULT_RUNNER_WORKTREE_BASE_ENV = "CALYX_RUNNER_WORKTREE_BASE";
const LEGACY_WORKER_PID_FILENAME = "pid";
const LEGACY_DETACHED_LAUNCH_MESSAGE = "Spawned detached run worker.";
const LEGACY_DETACHED_LAUNCH_PAYLOAD_KEYS = new Set([
  "pid",
  "worker_supervisor",
  "systemd_unit",
  "cgroup",
]);
type LegacyDetachedWorkerObservation =
  | { status: "not_legacy" | "missing" | "untrusted" }
  | { status: "possibly_live"; pid: number }
  | {
      status: "publisher_dead";
      pid: number;
      process_group: "possibly_live" | "dead" | "untrusted";
    };
type LegacyPendingResourceSettlement = Extract<
  NonNullable<RunRecord["recovery"]["resource_settlement"]>,
  { status: "pending" }
>;
const legacySettlementTimestampSchema = z.string().datetime({ offset: true });

function legacyPendingResourceSettlement(
  record: RunRecord,
): LegacyPendingResourceSettlement | undefined {
  const settlement = record.recovery.resource_settlement;
  if (
    !hasLegacyDeadSettlement(record)
    || settlement?.schema_version !== "calyx.resource-settlement/v1"
    || settlement.status !== "pending"
    || settlement.authority !== "legacy_process_group_observation"
    || !legacySettlementTimestampSchema.safeParse(settlement.observed_at).success
    || ![
      "legacy_detached_process_group_possibly_live",
      "legacy_detached_process_group_untrusted",
    ].includes(settlement.reason_code)
    || !Number.isSafeInteger(settlement.legacy_process_group_id)
    || settlement.legacy_process_group_id <= 0
    || settlement.legacy_process_group_id !== record.recovery.owner_free_settlement?.legacy_pid
  ) {
    return undefined;
  }
  return settlement;
}

function hasLegacySettlementMarker(record: RunRecord): boolean {
  return record.recovery.owner_free_settlement !== undefined
    || record.recovery.resource_settlement !== undefined;
}

function hasLegacyExecutionBarrier(record: RunRecord): boolean {
  return hasSynthesizedLegacyAdmission(record) || hasLegacySettlementMarker(record);
}

type UnresolvedReconcileDisposition = {
  status: "unresolved" | "legacy_pending" | "classified" | "rebuilt";
  unresolved_reason: CalyxAdminReconcileUnresolvedReason;
};

function unresolvedReconcileDisposition(
  status: UnresolvedReconcileDisposition["status"],
  unresolvedReason: CalyxAdminReconcileUnresolvedReason,
): UnresolvedReconcileDisposition {
  return { status, unresolved_reason: unresolvedReason };
}

function unresolvedLegacySettlementReason(
  record: RunRecord,
): CalyxAdminReconcileUnresolvedReason {
  if (!hasLegacyDeadSettlement(record)) {
    return "legacy_owner_settlement_pending";
  }
  if (!hasLegacyResourceSettlement(record)) {
    return "legacy_resource_settlement_pending";
  }
  // A fully settled marker on a nonterminal legacy projection still cannot
  // authorize a new publisher. Callers only ask for a reason while preserving
  // such a projection, so fail closed on publication authority.
  return "legacy_publication_authority_unproven";
}

export interface RunServiceOptions {
  runsRoot?: string;
  workerEntrypoint?: string;
  detachedWorkerRedactedEnvNames?: readonly string[];
  defaultWorktreeBase?: string;
  interactiveHomeDir?: string;
  /** Test/operations override, clamped to the consumer page hard maximum. */
  interactivePageCandidateLimit?: number;
  /** Test/operations override for the compact immutable-identity prefix. */
  interactiveIdentityMaxBytes?: number;
  /** Test/operations synchronization hook immediately before transcript directory reads. */
  interactiveBeforeDiscoveryRead?: ((directoryPath: string) => Promise<void>) | undefined;
  /** Test/operations synchronization hook immediately before transcript candidate stats. */
  interactiveBeforeCandidateStat?: ((candidatePath: string) => Promise<void>) | undefined;
  agentsInfraRoot?: string;
  hostname?: string;
  subscribers?: RunSubscriber[];
  runtimeAdapterRegistry?: RuntimeAdapterRegistry;
  exitClassifierPipeline?: ClassifierPipeline;
  /**
   * Current-authority evidence provider for the universal workload boundary.
   * Absence is intentionally fail-closed; only a validated receipt opens it.
   */
  workloadAdmission?: {
    reconcile: WorkloadAdmissionReconciler;
    /** Bound admission-lock wait; callers receive a typed busy refusal. */
    acquireTimeoutMs?: number | undefined;
  } | undefined;
  /**
   * Optional projection callback. When set, every appended
   * `CalyxStreamEvent` is mirrored into the SQLite orchestration ledger
   * from the durable global event authority (POL-1342).
   */
  eventLogIngest?: EventLogIngest | undefined;
  /**
   * SQLite-backed `run_index` projection (wave 2.2). When set, every
   * `writeRunRecord` projects into SQLite and paged reads use it as their
   * snapshot authority. `startRunServer` binds a projection when callers
   * inject a service without one.
   */
  runIndex?: RunIndexProjection | undefined;
  /** Dormant Caller A state binding; no coordinator loop is activated by this option. */
  reviewCoordinatorState?: StateOpenOptions | undefined;
  /** Dormant daemon-owned publisher identity selection; no provider adapter is activated. */
  reviewCoordinatorPublisherIdentities?: ReviewPublisherIdentities | undefined;
  /**
   * Optional POL-1732a monitor evaluator. `run serve` enables this; tests may
   * call `evaluateMonitorsOnce` directly to avoid timing-sensitive sleeps.
   */
  monitorEvaluator?: {
    enabled?: boolean | undefined;
    intervalMs?: number | undefined;
    assignedHost?: string | undefined;
    state?: StateOpenOptions | undefined;
    delivery?: Omit<MonitorDeliveryDependencies, "now"> | undefined;
    sessionWake?: Omit<SessionWakeRouteDependencies, "now"> | undefined;
  } | undefined;
  /**
   * Optional POL-1838 transcript tailer. `run serve` enables this so the local
   * activity recall store stays current; tests may call `tickActivityTailerOnce`
   * directly to avoid timing-sensitive sleeps.
   */
  activityTailer?: {
    enabled?: boolean | undefined;
    intervalMs?: number | undefined;
    host?: string | undefined;
    state?: StateOpenOptions | undefined;
    watch?: boolean | undefined;
    calyxRunsRoot?: string | undefined;
  } | undefined;
  /**
   * POL-1838 recall-index freshness annotation on `activity messages` / `turns`.
   * Enabled by default (reads the local state store); set `enabled: false` to
   * skip the lookup, or pass `state` to point at a test/temp store path.
   */
  activityRecall?: {
    enabled?: boolean | undefined;
    state?: StateOpenOptions | undefined;
  } | undefined;
  /**
   * Optional POL-1789 sender outbox forwarder. `run serve` enables this so
   * remote message spools drain opportunistically through target-host daemons.
   */
  messageOutbox?: MessageOutboxForwarderOptions | undefined;
  /**
   * POL-1805 terminal handbacks. Enabled by default; tests can force
   * receipt-only behavior to mirror a daemon that lacks message.correspondence/v1.
   */
  handback?: {
    enabled?: boolean | undefined;
    state?: StateOpenOptions | undefined;
    messageCorrespondence?: boolean | undefined;
  } | undefined;
  /**
   * POL-1790 named-resource leases. Enabled by default for agent-runner
   * worktree dispatch so the SQLite lease is authoritative and the legacy
   * .calyx-runner.lock remains only a crash-safety belt.
   */
  leases?: {
    enabled?: boolean | undefined;
    state?: StateOpenOptions | undefined;
    coordinatorHost?: string | undefined;
    /** Test/operations hook proving a lease mutation reached a contended transaction boundary. */
    onTransactionContention?: ((operation: "acquire" | "renew" | "release") => void) | undefined;
  } | undefined;
}

export interface ResolveMarkableActivityTargetOptions {
  targetKind: ActivityMarkTargetKind;
  targetId: string;
}

export type ResolvedMarkableActivityTarget = ParsedActivityMarkTarget;

/**
 * One non-leaking miss for mark creation. The server maps this classification
 * to `mark_target_unknown`; submitted ids, visibility, locality, and candidate
 * counts are deliberately absent from both the type and the message.
 */
export class ActivityMarkTargetNotFoundError extends Error {
  readonly code = "mark_target_unknown" as const;

  constructor() {
    super("Mark target was not found on this daemon's consumer-visible activity projection.");
    this.name = "ActivityMarkTargetNotFoundError";
  }
}

/** Exact canonical activity identity claimed by more than one local source. */
export class ActivityMarkTargetAmbiguousError extends Error {
  readonly code = "mark_target_ambiguous" as const;

  constructor() {
    super("More than one local activity source claims the same canonical target identity.");
    this.name = "ActivityMarkTargetAmbiguousError";
  }
}

/** Consumer activity source exists in the target grammar but cannot be read now. */
export class ActivityMarkTargetUnavailableError extends Error {
  readonly code = "mark_target_unavailable" as const;

  constructor() {
    super("Activity target validation is temporarily unavailable on this daemon.");
    this.name = "ActivityMarkTargetUnavailableError";
  }
}

function isCanonicalMarkableActivityId(activityId: string): boolean {
  if (/:(?:msg|turn):\d+$/u.test(activityId)) return false;
  if (/^interactive:(?:codex|claude):[^\s]+$/u.test(activityId)) return true;
  if (!activityId.startsWith("run:")) return false;
  try {
    assertCanonicalRunId(activityId.slice("run:".length));
    return true;
  } catch {
    return false;
  }
}

function isMarkTargetResolutionMiss(error: unknown): boolean {
  return error instanceof ActivityMarkTargetNotFoundError
    || error instanceof ActivityIdAmbiguousError
    || error instanceof ActivityIdNotFoundError
    || error instanceof ActivityRunMissingMetadataError
    || error instanceof ActivityMessageSelectorError
    || error instanceof ActivityTurnSelectorError;
}

function isMarkTargetSourceUnavailable(error: unknown): boolean {
  if (error instanceof InteractiveActivityProjectionNotReadyError) return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && new Set([
    "EACCES",
    "EIO",
    "EMFILE",
    "ENFILE",
    "ENOENT",
    "ESTALE",
  ]).has(code);
}

export interface RecordIndependentReviewEvidenceOptions {
  instance_id: string;
}

export interface ObserveIndependentReviewRunOptions {
  instance_id: string;
  observation_id: string;
}

export interface RunResourceTerminalAuthority {
  schema_version: "calyx.run-resource-terminal-authority/v1";
  run_id: string;
  source: "current_record" | "legacy_resource_settlement" | "bound_receipt";
  receipt_schema_version?: string | undefined;
}

export interface RunServiceDependencies {
  resolveExecutionKernel: (intent: RunIntent) => ExecutionKernel;
  spawnWorker?: (args: {
    entrypoint: string;
    runId: string;
    runsRoot: string;
    runDir: string;
    redactedEnvNames?: readonly string[] | undefined;
  }) => Promise<DetachedWorkerLaunchResult>;
  collectHostResources: () => Promise<RunHostResourceObservation>;
  collectResourceAttribution: (rootPid?: number) => Promise<RunResourceAttributionObservation>;
  hostname: () => string;
  now: () => string;
  /**
   * Host platform the daemon will restart on. The restart-readopt classifier
   * uses it to require Linux systemd isolation and fail closed on launchd
   * (macOS) hosts (POL-2044). Injectable so the classifier is deterministic
   * across test hosts.
   */
  platform: () => NodeJS.Platform;
  /** Testable rolling-upgrade PID observation; never process identity. */
  observeLegacyWorkerPid: (pid: number) => Promise<"possibly_live" | "dead" | "untrusted">;
  /**
   * Resource-release authority for direct historical workers. The detached
   * wrapper was its process-group leader, so lease release is safe only after
   * both the leader PID and inherited process group are absent.
   */
  observeLegacyWorkerProcessGroup: (processGroupId: number) => Promise<"possibly_live" | "dead" | "untrusted">;
}

export interface LaunchRunOptions {
  detached?: boolean;
  nextTurnInput?: RunNextTurnInput | undefined;
  provenance?: ApiProvenanceV1 | undefined;
  /**
   * Runs after admission is durable but before execution dispatch. Throwing
   * keeps the admitted run queued and prevents the external execution effect.
   */
  onAdmitted?: ((record: RunRecord) => Promise<void>) | undefined;
  /**
   * Runs only after first-execution ownership is held and the queued-run
   * admission recheck passes. Throwing prevents the external execution effect.
   */
  onExecutionAdmitted?: ((record: RunRecord) => Promise<void>) | undefined;
  /** API callers bind retries to their durable idempotency key domain. */
  admissionIdentity?: string | undefined;
  /** API callers supply the hash already bound in their idempotency ledger. */
  requestHash?: string | undefined;
  /** Fleet launch authority the conductor planned against. */
  plannedTopologyProjectionSha256?: string | undefined;
}

interface InitializeRunOptions {
  creationProvenance?: ApiProvenanceV1 | undefined;
  launchMode?: RunLaunchMode | undefined;
  admissionIdentity?: string | undefined;
  requestHash?: string | undefined;
  acceptedAt?: string | undefined;
  plannedTopologyProjectionSha256?: string | undefined;
}

export interface StopRunOptions {
  reason?: string | undefined;
  provenance?: ApiProvenanceV1 | undefined;
}

type RunCancellationRequestedResult = {
  schema_version: "calyx.run-cancellation-result/v1";
  status: "cancellation_requested";
  run_id: string;
  requested_at: string;
  /**
   * Present only when this stop's targeted reconcile produced an owner-free
   * TERMINAL settlement (POL-1897): both per-run mutexes were free and the
   * reconcile authority classified or rebuilt the run to a terminal state.
   * Absent when a live owner exists, when the run was queued, or when
   * reconcile deferred settlement (a legacy publisher may still be live, or
   * its evidence is untrusted) — no publisher-extinction claim is made in
   * those cases. The free-mutex probe is only a gate, never the claim.
   */
} & (
  | {
      worker_ownership: "owner_free";
      /** Terminal state reached by the owner-free settlement. */
      settled_state: CalyxRunTerminalState;
    }
  | {
      worker_ownership?: never;
      settled_state?: never;
    }
);

export type RunCancellationResult = RunCancellationRequestedResult | {
  schema_version: "calyx.run-cancellation-result/v1";
  status: "already_terminal";
  run_id: string;
};

/**
 * Candidate selection for one reconcile pass (POL-1897).
 * - "all" (default): every retained run identity, plus non-canonical run-root
 *   inspection and the full run-index repair — boot and operator/admin
 *   reconcile behavior.
 * - "active": only runs currently projected as non-terminal — the bounded
 *   steady-state daemon cadence.
 * - { runId }: exactly one run — targeted settlement (owner-free stop()).
 */
export type ReconcileRunScope = "all" | "active" | { runId: string };

export interface ReconcileRunOptions {
  provenance?: ApiProvenanceV1 | undefined;
  scope?: ReconcileRunScope | undefined;
}

export class RunAlreadyExistsError extends Error {
  readonly runId: string;

  constructor(runId: string, state: string) {
    super(`Run ${runId} already exists with state ${state}. Use a new run_id or inspect the existing run.`);
    this.name = "RunAlreadyExistsError";
    this.runId = runId;
  }
}

export class RunNotFoundError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`Run ${runId} was not found.`);
    this.name = "RunNotFoundError";
    this.runId = runId;
  }
}

export class RunExecutionSettlementPendingError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(
      `Run ${runId} was admitted by the pre-mutex launcher; settlement is pending and no second execution effect is permitted.`,
    );
    this.name = "RunExecutionSettlementPendingError";
    this.runId = runId;
  }
}

export class WorkloadAdmissionFencedError extends Error {
  readonly code = "workload_admission_fenced" as const;
  readonly reason: WorkloadAdmissionFenceReason;
  readonly failedSurface: string;
  readonly nextAction: string;
  readonly decision: WorkloadAdmissionDecisionV1;

  constructor(args: {
    reason: WorkloadAdmissionFenceReason;
    failedSurface: string;
    nextAction: string;
    decision: WorkloadAdmissionDecisionV1;
  }) {
    super(
      `Workload admission refused (${args.reason}) at ${args.failedSurface}. `
      + `Next action: ${args.nextAction}`,
    );
    this.name = "WorkloadAdmissionFencedError";
    this.reason = args.reason;
    this.failedSurface = args.failedSurface;
    this.nextAction = args.nextAction;
    this.decision = args.decision;
  }
}

const WORKLOAD_ADMISSION_BUSY_NEXT_ACTION =
  "Retry the same operation; workload-admission evaluation is currently busy.";

export class WorkloadAdmissionBusyError extends Error {
  readonly code = "workload_admission_busy" as const;
  readonly reason = "admission_evidence_missing" as const;
  readonly failedSurface = "admission_evidence" as const;
  readonly nextAction = WORKLOAD_ADMISSION_BUSY_NEXT_ACTION;
  readonly decision: WorkloadAdmissionDecisionV1;
  readonly acquireTimeoutMs: number;

  constructor(args: {
    decision: WorkloadAdmissionDecisionV1;
    acquireTimeoutMs: number;
  }) {
    super(
      `Workload admission is busy after ${args.acquireTimeoutMs}ms. `
      + `Next action: ${WORKLOAD_ADMISSION_BUSY_NEXT_ACTION}`,
    );
    this.name = "WorkloadAdmissionBusyError";
    this.decision = args.decision;
    this.acquireTimeoutMs = args.acquireTimeoutMs;
  }
}

export interface ExecuteStoredRunOptions {
  nextTurnInput?: RunNextTurnInput | undefined;
  /** Internal worker observation used to make duplicate ownership losers exit cleanly. */
  onOwnershipResolved?: ((ownership: "acquired" | "contended") => void) | undefined;
  /** Internal first-execution publication seam; invoked only by the mutex owner. */
  onExecutionAdmitted?: ((record: RunRecord) => Promise<void>) | undefined;
}

type ReceiptRecoveryOutcome =
  | { status: "absent" }
  | { status: "rebuilt"; record: RunRecord }
  | { status: "repair_pending"; record: RunRecord }
  | { status: "classified"; record: RunRecord; reason: string };

type OwnerFreeReceiptAuthority = {
  receipt: ExecutionReceipt;
  spec: ResolvedExecutionSpec;
};

export interface RunServiceRunningMetrics {
  sse_subscribers: number;
  codex_app_server_sessions: number;
  active_runs: number;
  total_serviced_since_start: number;
}

function nowIso(now: () => string): string {
  return now();
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\..*$/, "");
}

function leaseRowToWorktreeLease(row: LeaseRow): WorktreeLease {
  return {
    key: row.key,
    holder_activity_id: row.holder_activity_id,
    ttl_ms: row.ttl_ms,
    expires_at: row.expires_at,
  };
}

function leaseConflictMessage(prefix: string, lease: LeaseRow | undefined, fallback: string): string {
  if (!lease) return `${prefix}: ${fallback}`;
  return [
    `${prefix}: lease ${lease.key} is held by ${lease.holder_activity_id} until ${lease.expires_at}.`,
    `holder acquired_at=${lease.acquired_at}${lease.renewed_at ? ` renewed_at=${lease.renewed_at}` : ""}`,
    "Use `calyx lease steal <key> --holder <activity-id> --provenance <why>` only after operator-confirmed takeover.",
  ].join(" ");
}

function createWorktreeLeaseManager(args: {
  host: string;
  state?: StateOpenOptions | undefined;
  coordinatorHost?: string | undefined;
  now: () => string;
  onTransactionContention?: ((operation: "acquire" | "renew" | "release") => void) | undefined;
}): WorktreeLeaseManager {
  const host = normalizeHost(args.host);
  const holderForRun = (runId: string): string => `run:${runId}`;
  const leaseKeyForPath = (worktreePath: string): string => `worktree:${host}:${path.resolve(worktreePath)}`;

  async function withLeaseState<T>(
    operation: "acquire" | "renew" | "release",
    fn: (db: StateDriverDatabase) => T,
  ): Promise<T> {
    return withSqliteBusyRetry(async () => {
      await applyStateMigrations({ ...(args.state ? { storeOptions: args.state } : {}) });
      const opened = await openStateStore(args.state ?? {});
      let transactionOpen = false;
      try {
        // Lease mutations read before they write. Starting as IMMEDIATE avoids
        // a WAL snapshot-upgrade race where busy_timeout cannot make progress.
        opened.db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const result = fn(opened.db);
        opened.db.exec("COMMIT");
        transactionOpen = false;
        return result;
      } catch (error) {
        if (isSqliteBusyError(error)) args.onTransactionContention?.(operation);
        if (transactionOpen) {
          try {
            opened.db.exec("ROLLBACK");
          } catch {
            // Preserve the original operation error.
          }
        }
        throw error;
      } finally {
        opened.db.close();
      }
    });
  }

  return {
    async acquire(input) {
      const key = leaseKeyForPath(input.path);
      const holder = holderForRun(input.run_id);
      return withLeaseState("acquire", (db) => {
        const result = input.steal_lock
          ? {
              acquired: true,
              lease: stealLease(db, {
                key,
                holder_activity_id: holder,
                ttl_ms: input.ttl_ms,
                provenance: {
                  reason: "agent-runner worktree --steal-lock",
                  run_id: input.run_id,
                  host,
                },
                now: args.now(),
                ...(args.coordinatorHost ? { coordinator_host: args.coordinatorHost } : {}),
              }).lease,
            }
          : acquireLease(db, {
              key,
              holder_activity_id: holder,
              ttl_ms: input.ttl_ms,
              now: args.now(),
              ...(args.coordinatorHost ? { coordinator_host: args.coordinatorHost } : {}),
              metadata: { run_id: input.run_id, host },
            });
        if (!result.acquired || !result.lease) {
          return {
            acquired: false,
            error: leaseConflictMessage("Worktree DB lease acquisition refused", result.conflict?.lease, result.conflict?.message ?? "unknown conflict"),
          };
        }
        return { acquired: true, lease: leaseRowToWorktreeLease(result.lease) };
      });
    },
    async renew(lease) {
      return withLeaseState("renew", (db) => {
        const result = renewLease(db, {
          key: lease.key,
          holder_activity_id: lease.holder_activity_id,
          ttl_ms: lease.ttl_ms,
          now: args.now(),
        });
        if (!result.renewed || !result.lease) {
          throw new Error(leaseConflictMessage("Worktree DB lease renewal refused", result.conflict?.lease, result.conflict?.message ?? "unknown conflict"));
        }
        return leaseRowToWorktreeLease(result.lease);
      });
    },
    async release(lease) {
      await withLeaseState("release", (db) => {
        const result = releaseLease(db, {
          key: lease.key,
          holder_activity_id: lease.holder_activity_id,
          now: args.now(),
        });
        if (
          !result.released
          && (result.conflict?.kind === "holder-mismatch" || result.conflict?.kind === "quarantined")
        ) {
          throw new Error(leaseConflictMessage("Worktree DB lease release refused", result.conflict.lease, result.conflict.message));
        }
      });
    },
  };
}

function defaultWorktreeBase(): string {
  const fromEnv = process.env[DEFAULT_RUNNER_WORKTREE_BASE_ENV];
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return path.join(homedir(), "projects");
}

function buildServiceEvent(
  now: () => string,
  runId: string,
  event: RunServiceEvent["event"],
  message: string,
  payload?: Record<string, unknown>,
  provenance?: ApiProvenanceV1,
): RunServiceEvent {
  return {
    timestamp: nowIso(now),
    run_id: runId,
    source: "run-service",
    event,
    message,
    ...(provenance ? { provenance } : {}),
    ...(payload ? { payload } : {}),
  };
}

function optionalApiProvenance(value: ApiProvenanceV1 | undefined): ApiProvenanceV1 | undefined {
  return value ? validateApiProvenance(value) : undefined;
}

type TerminalHandbackStatus = "sent" | "duplicate" | "updated" | "corrected" | "withheld" | "receipt_only";

type TerminalHandbackFlow = "calyx.msg/v1" | "receipt-only/v1" | "withheld/v1";

interface TerminalHandbackAuthorityAnnotation {
  schema_version: "calyx.run-handback-authority/v1";
  authority_source: "typed_projection" | "kernel_receipt";
  receipt_status: "receipt_accepted" | "receipt_rejected" | "receipt_missing";
  correction_status: "correction_pending" | "correction_unavailable";
  reason: string;
  receipt_state?: RunState;
}

interface TerminalHandbackDeliveryEvidence {
  schema_version: "calyx.run-handback-delivery-evidence/v1";
  kind: "delivery_receipt" | "acknowledgement" | "active_claim";
  observed_at: string;
  status: MessageRow["status"];
  actor?: string;
}

interface TerminalHandbackCorrection {
  schema_version: "calyx.run-handback-correction/v1";
  kind: "authoritative_supersession";
  supersedes_message_id: string;
  provisional_state: RunState;
  authoritative_state: RunState;
  delivery_evidence: TerminalHandbackDeliveryEvidence;
}

type TerminalHandbackAuthorityDecision =
  | {
      kind: "authoritative";
      annotation?: TerminalHandbackAuthorityAnnotation;
    }
  | {
      kind: "withheld";
      annotation: TerminalHandbackAuthorityAnnotation;
    };

interface TerminalHandbackDuplicateMismatch {
  message_id: string;
  recipient_address: string;
  recipient_class: string;
  recipient_host?: string;
  idempotency_key?: string;
}

interface TerminalHandbackReceipt {
  schema_version: "calyx.run-handback/v1";
  run_id: string;
  handback_key: string;
  dedupe_key: string;
  flow: TerminalHandbackFlow;
  status: TerminalHandbackStatus;
  emitted_at: string;
  recipient_address: string;
  recipient_host?: string;
  thread_key: string;
  ack_required: boolean;
  subject: string;
  outcome: {
    state: RunState;
    issue?: string;
    completed_at?: string;
  };
  review_summary?: TerminalHandbackReviewSummary;
  authority_annotation?: TerminalHandbackAuthorityAnnotation;
  correction?: TerminalHandbackCorrection;
  locators: Record<string, unknown>;
  terminal_event?: {
    event_id: string;
    cursor: string;
  };
  message?: {
    message_id: string;
    inserted: boolean;
    receipt_path?: string;
    outbox_id?: string;
    idempotency_key?: string;
    disposition?: "inserted" | "duplicate" | "updated_pending" | "authoritative_correction";
    supersedes_message_id?: string;
    duplicate_mismatch?: TerminalHandbackDuplicateMismatch;
  };
  reason?: string;
}

const terminalHandbackReceiptSchema = z.object({
  schema_version: z.literal("calyx.run-handback/v1"),
  run_id: z.string().min(1),
  handback_key: z.string().min(1),
  dedupe_key: z.string().min(1),
  flow: z.enum(["calyx.msg/v1", "receipt-only/v1", "withheld/v1"]),
  status: z.enum(["sent", "duplicate", "updated", "corrected", "withheld", "receipt_only"]),
  emitted_at: z.string().datetime(),
  recipient_address: z.string().min(1),
  recipient_host: z.string().min(1).optional(),
  thread_key: z.string().min(1),
  ack_required: z.boolean(),
  subject: z.string().min(1),
  outcome: z.object({
    state: runStateSchema,
    issue: z.string().min(1).optional(),
    completed_at: z.string().datetime().optional(),
  }),
  review_summary: z.unknown().optional(),
  authority_annotation: z.unknown().optional(),
  correction: z.unknown().optional(),
  locators: z.record(z.string(), z.unknown()),
  terminal_event: z.object({
    event_id: z.string().min(1),
    cursor: z.string().min(1),
  }).optional(),
  message: z.object({
    message_id: z.string().min(1),
    inserted: z.boolean(),
    receipt_path: z.string().min(1).optional(),
    outbox_id: z.string().min(1).optional(),
    idempotency_key: z.string().min(1).optional(),
    disposition: z.enum(["inserted", "duplicate", "updated_pending", "authoritative_correction"]).optional(),
    supersedes_message_id: z.string().min(1).optional(),
    duplicate_mismatch: z.unknown().optional(),
  }).optional(),
  reason: z.string().min(1).optional(),
}).superRefine((receipt, context) => {
  if (receipt.flow === "calyx.msg/v1" && receipt.status !== "receipt_only" && !receipt.message) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["message"],
      message: "message handback receipts require message evidence",
    });
  }
  if (receipt.flow === "receipt-only/v1" && receipt.status !== "receipt_only") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "receipt-only flow requires receipt_only status",
    });
  }
  if (receipt.flow === "withheld/v1" && receipt.status !== "withheld") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "withheld flow requires withheld status",
    });
  }
});

interface TerminalHandbackReviewSummary {
  schema_version: "calyx.review-handback-summary/v1";
  status: "available" | "artifact_missing" | "artifact_unreadable";
  review_status: string;
  coverage_status: string;
  delivery_status: string;
  verdict: string | null;
  counts: Record<string, number>;
  artifact_path?: string;
  round?: number;
  warning?: string;
}

function shortStableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function handbackDedupeKey(
  runId: string,
  handback: RunHandbackSpec,
): string {
  return handback.idempotency_key?.trim() || `handback:${runId}:${handback.key}`;
}

function terminalHandbackReceiptDedupeKeyMatches(
  actual: string,
  expected: string,
  event: RunTerminalEvent | undefined,
): boolean {
  if (actual === expected) return true;
  // Preserve already-emitted pre-POL-2128 correction receipts as historical
  // evidence. New correspondence never writes this projection-scoped key.
  return Boolean(
    event?.supersession
    && actual === `${expected}:projection:${shortStableHash(event.event_id)}`,
  );
}

function handbackMessageId(
  runId: string,
  handback: RunHandbackSpec,
): string {
  return `run-handback-${shortStableHash(`${runId}\0${handback.key}`)}`;
}

function handbackRepairSuffix(dedupeKey: string, resolved: ResolvedMessageAddress): string {
  return shortStableHash(`${dedupeKey}\0${resolved.address}\0${resolved.recipient_class}\0${resolved.target_host ?? ""}`);
}

function handbackRepairMessageId(runId: string, handback: RunHandbackSpec, dedupeKey: string, resolved: ResolvedMessageAddress): string {
  return `${handbackMessageId(runId, handback)}-${handbackRepairSuffix(dedupeKey, resolved).slice(0, 12)}`;
}

function handbackRepairDedupeKey(dedupeKey: string, resolved: ResolvedMessageAddress): string {
  return `${dedupeKey}:terminal:${handbackRepairSuffix(dedupeKey, resolved)}`;
}

function handbackCorrectionSuffix(dedupeKey: string, provisionalMessageId: string): string {
  return shortStableHash(`${dedupeKey}\0${provisionalMessageId}\0authoritative-correction`);
}

function handbackCorrectionMessageId(
  runId: string,
  handback: RunHandbackSpec,
  dedupeKey: string,
  provisionalMessageId: string,
): string {
  return `${handbackMessageId(runId, handback)}-correction-${handbackCorrectionSuffix(dedupeKey, provisionalMessageId).slice(0, 12)}`;
}

function handbackCorrectionDedupeKey(dedupeKey: string, provisionalMessageId: string): string {
  return `${dedupeKey}:correction:${handbackCorrectionSuffix(dedupeKey, provisionalMessageId)}`;
}

function normalizeOptionalHost(host: string | null | undefined): string {
  return host ? normalizeHost(host) : "";
}

function terminalHandbackDuplicateMismatch(
  message: MessageRow,
  resolved: ResolvedMessageAddress,
): TerminalHandbackDuplicateMismatch | undefined {
  if (
    message.recipient_address === resolved.address
    && message.recipient_class === resolved.recipient_class
    && normalizeOptionalHost(message.recipient_host) === normalizeOptionalHost(resolved.target_host)
  ) {
    return undefined;
  }
  return {
    message_id: message.message_id,
    recipient_address: message.recipient_address,
    recipient_class: message.recipient_class,
    ...(message.recipient_host ? { recipient_host: message.recipient_host } : {}),
    ...(message.idempotency_key ? { idempotency_key: message.idempotency_key } : {}),
  };
}

function terminalHandbackMessageOutcome(
  message: MessageRow,
  record: RunRecord,
  handback: RunHandbackSpec,
): RunState | undefined {
  if (
    message.payload["source"] !== "run-service-terminal-handback"
    || message.payload["run_id"] !== record.run_id
    || message.payload["handback_key"] !== handback.key
  ) {
    return undefined;
  }
  const parsed = runStateSchema.safeParse(message.payload["terminal_state"]);
  return parsed.success && isTerminalState(parsed.data) ? parsed.data : undefined;
}

function terminalHandbackDeliveryEvidence(message: MessageRow): TerminalHandbackDeliveryEvidence | undefined {
  if (message.delivered_at) {
    return {
      schema_version: "calyx.run-handback-delivery-evidence/v1",
      kind: "delivery_receipt",
      observed_at: message.delivered_at,
      status: message.status,
    };
  }
  if (message.acked_at) {
    return {
      schema_version: "calyx.run-handback-delivery-evidence/v1",
      kind: "acknowledgement",
      observed_at: message.acked_at,
      status: message.status,
      ...(message.acked_by ? { actor: message.acked_by } : {}),
    };
  }
  if (message.status === "claimed" && message.claimed_until) {
    return {
      schema_version: "calyx.run-handback-delivery-evidence/v1",
      kind: "active_claim",
      observed_at: message.updated_at,
      status: message.status,
      ...(message.claimed_by ? { actor: message.claimed_by } : {}),
    };
  }
  return undefined;
}

function updateUndeliveredTerminalHandbackMessage(
  db: StateDriverDatabase,
  messageId: string,
  input: {
    subject: string;
    body: string;
    payload: Record<string, unknown>;
    updatedAt: string;
  },
): MessageRow | undefined {
  const result = db.prepare(
    `UPDATE messages
     SET subject = ?, body = ?, payload_json = ?, updated_at = ?
     WHERE message_id = ?
       AND status IN ('pending', 'outbox')
       AND delivered_at IS NULL
       AND acked_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM message_deliveries
         WHERE message_deliveries.message_id = messages.message_id
           AND message_deliveries.status IN ('attempted', 'delivered')
       )`,
  ).run(
    input.subject,
    input.body,
    JSON.stringify(input.payload),
    input.updatedAt,
    messageId,
  );
  return Number(result.changes) > 0 ? readMessage(db, messageId) : undefined;
}

class TerminalHandbackDeliveryUnsettledError extends Error {
  constructor(readonly messageId: string) {
    super(`provisional_terminal_handback_delivery_unsettled:${messageId}`);
    this.name = "TerminalHandbackDeliveryUnsettledError";
  }
}

function terminalHandbackReceiptPath(paths: ReturnType<RunStore["paths"]>, handback: RunHandbackSpec): string {
  return path.join(paths.runDir, `handback-${shortStableHash(handback.key)}.json`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeReviewCounts(value: unknown, findings: unknown): Record<string, number> {
  const counts: Record<string, number> = { total: 0, P0: 0, P1: 0, P2: 0, P3: 0 };
  const rawCounts = asRecord(value);
  if (rawCounts) {
    for (const [key, count] of Object.entries(rawCounts)) {
      if (typeof count === "number" && Number.isFinite(count)) {
        counts[key] = count;
      }
    }
    if (typeof rawCounts["total"] !== "number") {
      counts["total"] = Object.entries(counts)
        .filter(([key]) => key !== "total")
        .reduce((sum, [, count]) => sum + count, 0);
    }
    return counts;
  }

  if (Array.isArray(findings)) {
    for (const finding of findings) {
      const severity = asRecord(finding)?.["severity"];
      if (typeof severity === "string") {
        counts[severity] = (counts[severity] ?? 0) + 1;
      }
    }
    counts["total"] = findings.length;
  }
  return counts;
}

function nullableReviewText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requiredReviewText(value: unknown, fallback: string): string {
  return nullableReviewText(value) ?? fallback;
}

function formatReviewCounts(counts: Record<string, number>): string {
  const preferred = ["total", "P0", "P1", "P2", "P3"];
  const keys = [
    ...preferred.filter((key) => Object.prototype.hasOwnProperty.call(counts, key)),
    ...Object.keys(counts).filter((key) => !preferred.includes(key)).sort(),
  ];
  return keys.map((key) => `${key}=${counts[key]}`).join(" ");
}

function buildUnavailableReviewSummary(
  status: TerminalHandbackReviewSummary["status"],
  warning: string,
  artifactPath?: string,
): TerminalHandbackReviewSummary {
  return {
    schema_version: "calyx.review-handback-summary/v1",
    status,
    review_status: status,
    coverage_status: "unknown",
    delivery_status: "degraded",
    verdict: null,
    counts: { total: 0, P0: 0, P1: 0, P2: 0, P3: 0 },
    ...(artifactPath ? { artifact_path: artifactPath } : {}),
    warning,
  };
}

function reviewConductMetadata(record: RunRecord): Record<string, unknown> | undefined {
  return asRecord(asRecord(record.spec?.metadata)?.["review_conduct"])
    ?? asRecord(asRecord(record.intent.metadata)?.["review_conduct"]);
}

function terminalHandbackNeedsReviewSummary(record: RunRecord, handback: RunHandbackSpec): boolean {
  const contract = handback.body_contract.toLowerCase();
  return Boolean(reviewConductMetadata(record)) || (contract.includes("verdict") && contract.includes("counts"));
}

function reviewFindingsArtifact(record: RunRecord): ArtifactEntry | undefined {
  const receipt = record.kernel_receipt;
  const artifacts = receipt && "artifacts" in receipt ? receipt.artifacts : undefined;
  return [...(artifacts?.required ?? []), ...(artifacts?.discovered ?? [])]
    .find((artifact) => artifact.name === "findings.json");
}

const MAX_REVIEW_EVIDENCE_SOURCE_BYTES = 1_048_576;

async function readBoundedReviewEvidenceSource(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_REVIEW_EVIDENCE_SOURCE_BYTES) {
      throw new Error(
        `Review findings source must be a 1-${String(MAX_REVIEW_EVIDENCE_SOURCE_BYTES)} byte regular file.`,
      );
    }
    const buffer = Buffer.alloc(MAX_REVIEW_EVIDENCE_SOURCE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset > MAX_REVIEW_EVIDENCE_SOURCE_BYTES
      || after.size !== before.size
      || after.size !== offset
      || after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error("Review findings source changed or exceeded its bound while RunService read it.");
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function mintReviewRunEvidence(args: {
  receipt: ExecutionReceipt;
  reviewerAttemptId: string;
  source: Buffer;
  issuedAt: string;
}): { artifact: unknown; evidenceReceipt: ReviewRunEvidenceReceipt } {
  if (!("artifacts" in args.receipt) || args.receipt.state !== "succeeded") {
    throw new Error("Reviewer evidence requires a succeeded agent-runner kernel receipt.");
  }
  const required = args.receipt.artifacts.required.filter(
    (artifact) => artifact.name === "findings.json",
  );
  if (
    !args.receipt.artifacts.gate_passed
    || args.receipt.artifacts.missing.length > 0
    || required.length !== 1
    || !required[0]!.required
    || (args.receipt.run_spec.required_artifacts ?? [])
      .filter((name) => name === "findings.json").length !== 1
  ) {
    throw new Error("RunService receipt did not bind exactly one required findings.json artifact.");
  }
  const artifactEntry = required[0]!;
  const sourceSha = createHash("sha256").update(args.source).digest("hex");
  if (artifactEntry.size_bytes !== args.source.byteLength || artifactEntry.sha256 !== sourceSha) {
    throw new Error("Review findings bytes do not match the RunService kernel receipt.");
  }
  let sourceText: string;
  try {
    sourceText = new TextDecoder("utf-8", { fatal: true }).decode(args.source);
  } catch {
    throw new Error("Review findings source is not valid UTF-8.");
  }
  let artifact: unknown;
  try {
    artifact = parseJsonWithoutDuplicateObjectMembers(sourceText);
  } catch {
    throw new Error("Review findings source is not valid JSON without duplicate object members.");
  }
  const canonicalArtifact = canonicalizeIndependentReviewJson(artifact);
  const canonicalSize = Buffer.byteLength(canonicalArtifact, "utf8");
  if (canonicalSize < 1 || canonicalSize > MAX_REVIEW_EVIDENCE_SOURCE_BYTES) {
    throw new Error("Canonical review findings exceed the RunService evidence bound.");
  }
  const canonicalSha = createHash("sha256").update(canonicalArtifact, "utf8").digest("hex");
  const terminalReceiptJson = canonicalizeIndependentReviewJson(args.receipt);
  return {
    artifact,
    evidenceReceipt: {
      schema_version: REVIEW_RUN_EVIDENCE_RECEIPT_SCHEMA_VERSION,
      issuer: "run_service",
      run_id: args.receipt.run_id,
      reviewer_attempt_id: args.reviewerAttemptId,
      terminal_receipt_digest: createHash("sha256")
        .update(terminalReceiptJson, "utf8")
        .digest("hex"),
      artifact: {
        name: "findings.json",
        locator: `calyx-run-artifact:${args.receipt.run_id}:findings.json`,
        media_type: "application/json",
        source_sha256: sourceSha,
        source_size_bytes: args.source.byteLength,
        canonical_sha256: canonicalSha,
        canonical_size_bytes: canonicalSize,
      },
      issued_at: args.issuedAt,
    },
  };
}

async function buildTerminalHandbackReviewSummary(record: RunRecord): Promise<TerminalHandbackReviewSummary> {
  const artifact = reviewFindingsArtifact(record);
  if (!artifact) {
    return buildUnavailableReviewSummary(
      "artifact_missing",
      "review findings artifact findings.json was not recorded in the kernel receipt",
    );
  }

  try {
    const payload = JSON.parse(await readFile(artifact.path, "utf8")) as unknown;
    const root = asRecord(payload);
    if (!root) {
      return buildUnavailableReviewSummary(
        "artifact_unreadable",
        "review findings artifact did not contain a JSON object",
        artifact.path,
      );
    }
    const counts = normalizeReviewCounts(root["counts"], root["findings"]);
    const round = root["round"];
    return {
      schema_version: "calyx.review-handback-summary/v1",
      status: "available",
      review_status: requiredReviewText(root["review_status"], "unknown"),
      coverage_status: requiredReviewText(root["coverage_status"], "unknown"),
      delivery_status: requiredReviewText(root["delivery_status"], "unknown"),
      verdict: nullableReviewText(root["verdict"]),
      counts,
      artifact_path: artifact.path,
      ...(typeof round === "number" && Number.isFinite(round) ? { round } : {}),
    };
  } catch (error) {
    return buildUnavailableReviewSummary(
      "artifact_unreadable",
      error instanceof Error ? error.message : String(error),
      artifact.path,
    );
  }
}

function buildTerminalHandbackLocators(
  record: RunRecord,
  paths: ReturnType<RunStore["paths"]>,
  event: RunTerminalEvent | undefined,
): Record<string, unknown> {
  const locators: Record<string, unknown> = {
    run_id: record.run_id,
    run_dir: paths.runDir,
    run_record_path: paths.runRecordPath,
    events_path: paths.eventsPath,
  };
  if (record.kernel_receipt) {
    locators["kernel_receipt_path"] = paths.kernelReceiptPath;
  }
  if (record.intent.issue) {
    locators["linear_issue"] = record.intent.issue;
  }
  if (event?.cursor) {
    locators["terminal_event_cursor"] = event.cursor;
  }
  const receipt = record.kernel_receipt;
  const environment = receipt && "environment" in receipt ? receipt.environment : undefined;
  if (environment?.worktree_path) {
    locators["worktree_path"] = environment.worktree_path;
  } else if (record.spec && "worktree" in record.spec && record.spec.worktree.path) {
    locators["worktree_path"] = record.spec.worktree.path;
  }
  if (environment?.branch) {
    locators["branch"] = environment.branch;
  } else if (record.spec && "worktree" in record.spec && record.spec.worktree.branch) {
    locators["branch"] = record.spec.worktree.branch;
  }
  const reviewConduct = reviewConductMetadata(record);
  const target = asRecord(reviewConduct?.["target"]);
  if (target) {
    locators["review_target"] = target;
    if (target["scope"] === "pr" && typeof target["repo"] === "string" && typeof target["pr"] === "number") {
      locators["github_pr"] = `${target["repo"]}#${target["pr"]}`;
    }
  }
  return locators;
}

function renderTerminalHandbackBody(args: {
  record: RunRecord;
  handback: RunHandbackSpec;
  locators: Record<string, unknown>;
  reviewSummary?: TerminalHandbackReviewSummary;
  authorityAnnotation?: TerminalHandbackAuthorityAnnotation;
  correction?: TerminalHandbackCorrection;
}): string {
  const completedAt = args.record.completed_at ?? args.record.kernel_receipt?.timing.completed_at;
  const locatorLines = Object.entries(args.locators)
    .map(([key, value]) => `- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  const reviewSummary = args.reviewSummary;
  return [
    args.correction
      ? "Calyx run authoritative terminal correction."
      : "Calyx run terminal handback.",
    "",
    `run_id: ${args.record.run_id}`,
    `state: ${args.record.state}`,
    ...(args.record.intent.issue ? [`issue: ${args.record.intent.issue}`] : []),
    ...(completedAt ? [`completed_at: ${completedAt}`] : []),
    `body_contract: ${args.handback.body_contract}`,
    ...(args.correction
      ? [
          "",
          "correction:",
          `schema_version: ${args.correction.schema_version}`,
          `kind: ${args.correction.kind}`,
          `supersedes_message_id: ${args.correction.supersedes_message_id}`,
          `provisional_state: ${args.correction.provisional_state}`,
          `authoritative_state: ${args.correction.authoritative_state}`,
          `delivery_evidence: ${args.correction.delivery_evidence.kind}`,
        ]
      : []),
    ...(args.authorityAnnotation
      ? [
          "",
          "authority_annotation:",
          `schema_version: ${args.authorityAnnotation.schema_version}`,
          `authority_source: ${args.authorityAnnotation.authority_source}`,
          `receipt_status: ${args.authorityAnnotation.receipt_status}`,
          `correction_status: ${args.authorityAnnotation.correction_status}`,
          ...(args.authorityAnnotation.receipt_state
            ? [`receipt_state: ${args.authorityAnnotation.receipt_state}`]
            : []),
          `reason: ${args.authorityAnnotation.reason}`,
        ]
      : []),
    ...(reviewSummary
      ? [
          "",
          "review_summary:",
          `review_artifact_status: ${reviewSummary.status}`,
          `review_status: ${reviewSummary.review_status}`,
          `coverage_status: ${reviewSummary.coverage_status}`,
          `delivery_status: ${reviewSummary.delivery_status}`,
          `verdict: ${reviewSummary.verdict ?? "null"}`,
          `counts: ${formatReviewCounts(reviewSummary.counts)}`,
          ...(typeof reviewSummary.round === "number" ? [`round: ${reviewSummary.round}`] : []),
          ...(reviewSummary.artifact_path ? [`findings_json_path: ${reviewSummary.artifact_path}`] : []),
          ...(reviewSummary.warning ? [`warning: ${reviewSummary.warning}`] : []),
        ]
      : []),
    "",
    "locators:",
    ...locatorLines,
  ].join("\n");
}

function makeTerminalHandbackReceipt(args: {
  record: RunRecord;
  handback: RunHandbackSpec;
  dedupeKey: string;
  flow: TerminalHandbackFlow;
  status: TerminalHandbackStatus;
  emittedAt: string;
  subject: string;
  locators: Record<string, unknown>;
  reviewSummary?: TerminalHandbackReviewSummary;
  authorityAnnotation?: TerminalHandbackAuthorityAnnotation;
  correction?: TerminalHandbackCorrection;
  event?: RunTerminalEvent | undefined;
  message?: TerminalHandbackReceipt["message"];
  reason?: string | undefined;
}): TerminalHandbackReceipt {
  const completedAt = args.record.completed_at ?? args.record.kernel_receipt?.timing.completed_at;
  return {
    schema_version: "calyx.run-handback/v1",
    run_id: args.record.run_id,
    handback_key: args.handback.key,
    dedupe_key: args.dedupeKey,
    flow: args.flow,
    status: args.status,
    emitted_at: args.emittedAt,
    recipient_address: args.handback.recipient_address,
    ...(args.handback.recipient_host ? { recipient_host: args.handback.recipient_host } : {}),
    thread_key: args.handback.thread_key,
    ack_required: args.handback.ack_required,
    subject: args.subject,
    outcome: {
      state: args.record.state,
      ...(args.record.intent.issue ? { issue: args.record.intent.issue } : {}),
      ...(completedAt ? { completed_at: completedAt } : {}),
    },
    ...(args.reviewSummary ? { review_summary: args.reviewSummary } : {}),
    ...(args.authorityAnnotation ? { authority_annotation: args.authorityAnnotation } : {}),
    ...(args.correction ? { correction: args.correction } : {}),
    locators: args.locators,
    ...(args.event ? { terminal_event: { event_id: args.event.event_id, cursor: args.event.cursor } } : {}),
    ...(args.message ? { message: args.message } : {}),
    ...(args.reason ? { reason: args.reason } : {}),
  };
}

async function writeTerminalHandbackReceipt(
  filePath: string,
  receipt: TerminalHandbackReceipt,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
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
    await rename(temporaryPath, filePath);
    const directory = await open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readValidTerminalHandbackReceipt(args: {
  filePath: string;
  record: RunRecord;
  handback: RunHandbackSpec;
  dedupeKey: string;
  event?: RunTerminalEvent | undefined;
}): Promise<TerminalHandbackReceipt | undefined> {
  try {
    const parsed = terminalHandbackReceiptSchema.safeParse(
      JSON.parse(await readFile(args.filePath, "utf8")) as unknown,
    );
    if (!parsed.success) return undefined;
    const receipt = parsed.data;
    const completedAt = args.record.completed_at ?? args.record.kernel_receipt?.timing.completed_at;
    const subject = args.handback.subject?.trim() || `Run ${args.record.run_id} terminal: ${args.record.state}`;
    if (
      receipt.run_id !== args.record.run_id
      || receipt.handback_key !== args.handback.key
      || !terminalHandbackReceiptDedupeKeyMatches(
        receipt.dedupe_key,
        args.dedupeKey,
        args.event,
      )
      || receipt.recipient_address !== args.handback.recipient_address
      || normalizeOptionalHost(receipt.recipient_host) !== normalizeOptionalHost(args.handback.recipient_host)
      || receipt.thread_key !== args.handback.thread_key
      || receipt.ack_required !== args.handback.ack_required
      || receipt.subject !== subject
      || receipt.outcome.state !== args.record.state
      || receipt.outcome.issue !== args.record.intent.issue
      || receipt.outcome.completed_at !== completedAt
      || (args.event && (
        receipt.terminal_event?.event_id !== args.event.event_id
        || receipt.terminal_event?.cursor !== args.event.cursor
      ))
      || (receipt.flow === "calyx.msg/v1" && !receipt.message?.receipt_path)
    ) {
      return undefined;
    }
    return receipt as TerminalHandbackReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

function isCalyxTerminalState(state: RunState): state is CalyxRunTerminalState {
  return (
    state === "succeeded"
    || state === "failed"
    || state === "partial"
    || state === "infra_error"
    || state === "cancelled"
    || state === "completed_dirty"
    || state === "auth_error"
  );
}

function terminalHandbackOutcomeIsAuthoritative(
  record: RunRecord,
  durableReceipt: ExecutionReceipt | undefined,
): boolean {
  // These outcomes can be owned by the service itself before or outside
  // receipt-producing execution. A durable contradictory receipt means the
  // service projection is provisional, however, and must remain audit-only
  // until reconciliation derives the caller outcome from that receipt.
  if (
    record.state === "infra_error"
    || record.state === "cancelled"
    || record.state === "partial"
  ) {
    return !durableReceipt
      || (
        durableReceipt.run_id === record.run_id
        && durableReceipt.state === record.state
      );
  }
  if (record.kernel_receipt) {
    return record.kernel_receipt.run_id === record.run_id
      && record.kernel_receipt.state === record.state;
  }
  // Positive and agent-derived outcomes require a corresponding typed kernel
  // receipt before they may leave the run.
  return false;
}

function readMetadataString(intent: RunIntent, key: string): string | undefined {
  const metadata = intent.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function deriveEventOrigin(intent: RunIntent): CalyxRunEventOrigin {
  const launcherKind = readMetadataString(intent, "launcher_kind");
  const daemonId = readMetadataString(intent, "daemon_id");
  const launcherId = readMetadataString(intent, "launcher_id") ?? daemonId;
  const parentRunId = readMetadataString(intent, "parent_run_id");
  const groupId = readMetadataString(intent, "group_id");
  const origin: CalyxRunEventOrigin = {
    launcher_kind: launcherKind === "cli" || launcherKind === "daemon" || launcherKind === "plugin" || launcherKind === "session"
      ? launcherKind
      : daemonId
        ? "daemon"
        : "cli",
    ...(launcherId ? { launcher_id: launcherId } : {}),
    ...(parentRunId ? { parent_run_id: parentRunId } : {}),
    ...(groupId ? { group_id: groupId } : {}),
  };

  if (intent.notifications?.ntfy_topic || intent.notifications?.agent_mail_thread) {
    origin.reply_hint = {
      ...(intent.notifications.ntfy_topic ? { ntfy_topic: intent.notifications.ntfy_topic } : {}),
      ...(intent.notifications.agent_mail_thread ? { agent_mail_thread: intent.notifications.agent_mail_thread } : {}),
    };
  }
  return origin;
}

function extractAgentTerminalMessage(receipt: ExecutionReceipt | undefined): string | undefined {
  return receipt && "agent_terminal_message" in receipt && typeof receipt.agent_terminal_message === "string"
    ? receipt.agent_terminal_message
    : undefined;
}

function extractAgentTerminalEvidence(receipt: ExecutionReceipt | undefined) {
  return receipt && "terminal_evidence" in receipt ? receipt.terminal_evidence : undefined;
}

function extractInfraErrorClassification(receipt: ExecutionReceipt | undefined): InfraErrorClassification | undefined {
  return receipt?.infra_error_classification;
}

function inferInfraErrorMessageFromReceipt(receipt: ExecutionReceipt | undefined, fallback: string): string {
  if (!receipt) return fallback;
  if (receipt.infra_error_classification?.message) {
    return receipt.infra_error_classification.message;
  }
  if ("backend_stderr" in receipt && receipt.backend_stderr) {
    return receipt.backend_stderr;
  }
  if ("spawn_error" in receipt && receipt.spawn_error) {
    return receipt.spawn_error;
  }
  if (receipt.exit.error) {
    return receipt.exit.error;
  }
  return fallback;
}

function inferInfraErrorSiteFromMessage(message: string): ClassifyInfraErrorContext["site"] {
  if (/worktree/i.test(message)) return "worktree_acquisition";
  if (/\b(secret|credential|token|auth|authentication|unauthorized|forbidden)\b/i.test(message)) return "secrets_auth";
  if (/prompt|execplan|template/i.test(message)) return "prompts_resolution";
  if (/feature|protocol epoch|self upgrade/i.test(message)) return "daemon_feature_refusal";
  return "runner_task";
}

function normalizeInfraErrorForRecord(
  record: RunRecord,
  ctx: {
    classification?: InfraErrorClassification | undefined;
    message?: string | undefined;
    site?: ClassifyInfraErrorContext["site"] | undefined;
  } = {},
): RunRecord {
  if (record.state !== "infra_error") {
    if (!record.infra_error_classification) return record;
    const next: RunRecord = { ...record };
    delete next.infra_error_classification;
    return next;
  }
  const message = ctx.message
    ?? (record.infra_error_classification
      ? record.summary
      : inferInfraErrorMessageFromReceipt(record.kernel_receipt, record.summary));
  const classification = normalizeInfraErrorClassification(
    ctx.classification ?? record.infra_error_classification ?? extractInfraErrorClassification(record.kernel_receipt),
    {
      site: ctx.site ?? inferInfraErrorSiteFromMessage(message),
      message,
    },
  );
  return {
    ...record,
    infra_error_classification: classification,
  };
}

function infraErrorMetricKey(point: Omit<RunServiceInfraErrorCensusPoint, "count">): string {
  return [
    point.failure_layer,
    point.failure_reason,
    point.host,
    point.kernel,
    point.backend,
  ].join("\0");
}

interface InfraErrorCensusContribution {
  key: string;
  point: RunServiceInfraErrorCensusPoint;
}

function infraErrorCensusContribution(event: RunTerminalEvent): InfraErrorCensusContribution | undefined {
  if (event.run.state !== "infra_error") {
    return undefined;
  }
  // Older imported terminal events can predate the typed classification field.
  // Keep those transitions visible under the same bounded taxonomy rather than
  // silently dropping them from the cumulative counter.
  const classification = normalizeInfraErrorClassification(event.run.infra_error_classification, {
    message: event.summary.one_line,
  });
  const point: Omit<RunServiceInfraErrorCensusPoint, "count"> = {
    failure_layer: classification.failure_layer,
    failure_reason: classification.failure_reason,
    host: normalizeHost(event.run.host),
    kernel: event.run.kernel,
    backend: event.run.backend ?? "unknown",
  };
  return {
    key: infraErrorMetricKey(point),
    point: {
      ...point,
      count: 1,
    },
  };
}

function defaultSummary(
  record: Pick<
    RunRecord,
    | "run_id"
    | "state"
    | "integrations"
    | "recovery"
    | "health"
    | "infra_error_classification"
    | "kernel_receipt"
  >,
): string {
  const integrationFailures = record.integrations.results.filter((item) => item.status === "failed").length;
  const parts = [`Run ${record.run_id} ${record.state}`];
  if (record.state === "infra_error" && record.infra_error_classification) {
    parts.push(`${record.infra_error_classification.failure_layer}/${record.infra_error_classification.failure_reason}`);
  }
  if (integrationFailures > 0) {
    parts.push(`${integrationFailures} integration failure(s)`);
  }
  if (record.recovery.mode !== "normal") {
    parts.push(`recovery=${record.recovery.mode}`);
  }
  if (record.health) {
    parts.push(`health=${record.health.status}`);
    parts.push(record.health.summary);
  }
  return parts.join("; ") + ".";
}

function applyActivityLimit(
  entries: RunActivityEntry[],
  limit: number | undefined,
): RunActivityEntry[] {
  return typeof limit === "number" ? entries.slice(0, Math.max(limit, 0)) : entries;
}

function applyRunListLimit(
  entries: RunListEntry[],
  limit: number | undefined,
): RunListEntry[] {
  return typeof limit === "number" ? entries.slice(0, Math.max(limit, 0)) : entries;
}

function compareUtf8Identity(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareRunListEntries(left: RunListEntry, right: RunListEntry): number {
  const updated = Date.parse(right.updated_at) - Date.parse(left.updated_at);
  if (updated !== 0) {
    return updated;
  }
  const created = Date.parse(right.created_at) - Date.parse(left.created_at);
  if (created !== 0) {
    return created;
  }
  return compareUtf8Identity(left.run_id, right.run_id);
}

function compareActivityEntries(left: RunActivityEntry, right: RunActivityEntry): number {
  const timeCompare = Date.parse(right.updated_at) - Date.parse(left.updated_at);
  if (timeCompare !== 0) {
    return timeCompare;
  }
  return compareUtf8Identity(left.run_id, right.run_id);
}

function compareActivityPageEntries(left: RunActivityEntry, right: RunActivityEntry): number {
  const created = Date.parse(right.created_at) - Date.parse(left.created_at);
  if (created !== 0) return created;
  const runId = compareUtf8Identity(left.run_id, right.run_id);
  if (runId !== 0) return runId;
  const entryKindRank = (entry: RunActivityEntry): number => (
    entry.entry_kind === "calyx_run" ? 0 : 1
  );
  return entryKindRank(left) - entryKindRank(right);
}

interface ActivityListMembershipFence {
  v: 1;
  managed: string;
  interactive: string;
}

function encodeActivityListMembershipFence(fence: ActivityListMembershipFence): string {
  return Buffer.from(JSON.stringify(fence)).toString("base64url");
}

function decodeActivityListMembershipFence(value: string | undefined): ActivityListMembershipFence | undefined {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !decoded
      || typeof decoded !== "object"
      || Array.isArray(decoded)
      || (decoded as Record<string, unknown>)["v"] !== 1
      || typeof (decoded as Record<string, unknown>)["managed"] !== "string"
      || typeof (decoded as Record<string, unknown>)["interactive"] !== "string"
    ) {
      throw new Error("invalid shape");
    }
    return decoded as ActivityListMembershipFence;
  } catch {
    throw new RunListSnapshotChangedError("List cursor membership fence is invalid.");
  }
}

function deriveCrashRecoveryMode(intent: RunIntent): RunRecord["recovery"]["mode"] {
  const metadata = intent.metadata;
  if (
    metadata
    && typeof metadata === "object"
    && !Array.isArray(metadata)
    && typeof (metadata as Record<string, unknown>)["daemon_id"] === "string"
  ) {
    return "daemon_crash";
  }
  return "orchestrator_crash";
}

function draftLinearComment(context: RunSubscriberContext): string {
  const lines = [
    `Calyx run ${context.run_record.run_id}`,
    `State: ${context.run_record.state}`,
    `Kernel: ${context.spec.kernel}`,
    `Host: ${context.spec.host}`,
    ...("backend" in context.spec ? [`Backend: ${context.spec.backend}`] : []),
    ...(context.intent.issue ? [`Issue: ${context.intent.issue}`] : []),
    `Summary: ${context.run_record.summary}`,
  ];
  if (context.run_record.completed_at) {
    lines.push(`Completed: ${context.run_record.completed_at}`);
  }
  return lines.join("\n");
}

function makeDefaultSubscribers(): RunSubscriber[] {
  return [
    {
      name: "linear_comment_draft",
      async run(context): Promise<IntegrationResult> {
        if (!context.intent.issue) {
          return {
            name: "linear_comment_draft",
            critical: false,
            status: "skipped",
            details: { reason: "no_issue" },
          };
        }
        const targetPath = path.join(context.run_dir, "linear-comment.md");
        await writeFile(targetPath, `${draftLinearComment(context)}\n`, "utf8");
        return {
          name: "linear_comment_draft",
          critical: false,
          status: "success",
          details: { path: targetPath, issue: context.intent.issue },
        };
      },
    },
    {
      name: "vault_backlink_draft",
      async run(context): Promise<IntegrationResult> {
        const targetPath = path.join(context.run_dir, "vault-backlink.md");
        const body = [
          `# Calyx Run ${context.run_record.run_id}`,
          "",
          `- state: ${context.run_record.state}`,
          `- kernel: ${context.spec.kernel}`,
          `- host: ${context.spec.host}`,
          ...("backend" in context.spec ? [`- backend: ${context.spec.backend}`] : []),
          ...(context.intent.issue ? [`- issue: ${context.intent.issue}`] : []),
          ...(context.run_record.health ? [`- health: ${context.run_record.health.status}`] : []),
          "",
          context.run_record.summary,
          "",
          `Run dir: ${context.run_dir}`,
        ].join("\n");
        await writeFile(targetPath, `${body}\n`, "utf8");
        return {
          name: "vault_backlink_draft",
          critical: false,
          status: "success",
          details: { path: targetPath },
        };
      },
    },
  ];
}

async function observeLegacyWorkerPid(pid: number): Promise<"possibly_live" | "dead" | "untrusted"> {
  try {
    process.kill(pid, 0);
    return "possibly_live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return "possibly_live";
    if (code === "ESRCH") return "dead";
    return "untrusted";
  }
}

async function observeLegacyWorkerProcessGroup(
  processGroupId: number,
): Promise<"possibly_live" | "dead" | "untrusted"> {
  if (process.platform === "win32") return "untrusted";
  try {
    process.kill(-processGroupId, 0);
    return "possibly_live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return "possibly_live";
    if (code === "ESRCH") return "dead";
    return "untrusted";
  }
}

const DEFAULT_DEPS: Pick<
  RunServiceDependencies,
  | "collectHostResources"
  | "collectResourceAttribution"
  | "hostname"
  | "now"
  | "platform"
  | "observeLegacyWorkerPid"
  | "observeLegacyWorkerProcessGroup"
> = {
  collectHostResources: () => collectHostResources({ now: () => new Date().toISOString() }),
  collectResourceAttribution: (rootPid?: number) =>
    collectResourceAttribution({
      ...(typeof rootPid === "number" ? { rootPid } : {}),
      now: () => new Date().toISOString(),
    }),
  hostname: () => systemHostname(),
  now: () => new Date().toISOString(),
  platform: () => process.platform,
  observeLegacyWorkerPid,
  observeLegacyWorkerProcessGroup,
};

function deriveRecoveryStatus(intent: RunIntent, receipt: ExecutionReceipt): RunRecord["recovery"] {
  if (!("backend_session" in receipt) || !receipt.backend_session) {
    return { mode: "normal", resumable: false };
  }

  const checkpoint: NonNullable<RunRecord["recovery"]["checkpoint"]> = {
    backend_session_id: receipt.backend_session.id,
    ...(receipt.backend_session.path ? { backend_session_path: receipt.backend_session.path } : {}),
    last_event_at: receipt.timing.completed_at,
    strategy: "native_session",
  };

  if ("metadata" in receipt && receipt.metadata && typeof receipt.metadata === "object") {
    const sessionSummary = (receipt.metadata as Record<string, unknown>)["session_summary"];
    if (sessionSummary && typeof sessionSummary === "object") {
      const typed = sessionSummary as Record<string, unknown>;
      if (typeof typed["adapter_session_id"] === "string") {
        checkpoint.adapter_session_id = typed["adapter_session_id"];
      }
      const turns = typed["turns"];
      if (Array.isArray(turns) && turns.length > 0) {
        const lastTurn = turns[turns.length - 1];
        if (lastTurn && typeof lastTurn === "object") {
          const typedTurn = lastTurn as Record<string, unknown>;
          if (typeof typedTurn["adapter_turn_id"] === "string") {
            checkpoint.current_turn_id = typedTurn["adapter_turn_id"];
          }
          if (typeof typedTurn["backend_turn_id"] === "string") {
            checkpoint.backend_thread_id = typedTurn["backend_turn_id"];
          }
        }
      }
    }
  }

  return {
    mode: "normal",
    resumable: Boolean(receipt.backend_session.id || intent.resume_session_id),
    checkpoint,
  };
}

function extractReceiptHealth(receipt: ExecutionReceipt): RunHealthSnapshot | undefined {
  if ("kernel" in receipt && receipt.kernel === "host_process" && receipt.health) {
    return receipt.health;
  }
  if (!("kernel" in receipt) && receipt.health) {
    return receipt.health;
  }
  return undefined;
}

const hostProcessExecutionBindingSchema = z.object({
  schema_version: z.literal(HOST_PROCESS_EXECUTION_BINDING_SCHEMA_VERSION),
  execution_id: z.string().min(1),
  salt: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  commitment_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();

const hostProcessReceiptBaseSchema = z.object({
  kernel: z.literal("host_process"),
  run_id: z.string().min(1),
  state: runStateSchema,
  infra_error_classification: infraErrorClassificationSchema.optional(),
  timing: receiptTimingSchema,
  exit: receiptExitSchema,
  log_summary: receiptLogSummarySchema,
  process: z.object({
    argv: z.array(z.string().min(1)).min(1),
    cwd: z.string().min(1),
    env_keys: z.array(z.string()),
    pid: z.number().int().positive().optional(),
    process_group_id: z.number().int().positive().optional(),
    stdout_path: z.string().min(1).optional(),
    stderr_path: z.string().min(1).optional(),
    stop_grace_ms: z.number().int().nonnegative(),
    stop_requested: z.boolean(),
    stop_signal: z.string().min(1).optional(),
  }),
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
  summary: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const boundHostProcessReceiptSchema = hostProcessReceiptBaseSchema.extend({
  schema_version: z.literal(HOST_PROCESS_RECEIPT_SCHEMA_VERSION),
  execution_binding: hostProcessExecutionBindingSchema,
}).strict();

// This exact predecessor shape is observation-only. It is never upgraded into
// receipt authority merely by being readable under the same schema major.
const legacyHostProcessReceiptSchema = hostProcessReceiptBaseSchema.extend({
  schema_version: z.literal("1.0"),
}).strict();

const hostProcessReceiptSchema = z.union([
  boundHostProcessReceiptSchema,
  legacyHostProcessReceiptSchema,
]);

function isBoundHostProcessReceipt(
  receipt: HostProcessReceipt,
): receipt is BoundHostProcessReceipt {
  return receipt.schema_version === HOST_PROCESS_RECEIPT_SCHEMA_VERSION;
}

function assertExecutionReceiptShape(
  runId: string,
  spec: ResolvedExecutionSpec,
  receipt: ExecutionReceipt,
): void {
  const parsed = spec.kernel === "host_process"
    ? hostProcessReceiptSchema.safeParse(receipt)
    : runReceiptSchema.safeParse(receipt);
  if (parsed.success) return;
  const detail = parsed.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "receipt"}: ${issue.message}`)
    .join("; ");
  throw new Error(
    `Run ${runId} finalization receipt is malformed for ${spec.kernel}: ${detail}.`,
  );
}

function stableBackendOptions(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const stable = { ...value as Record<string, unknown> };
  delete stable["env"];
  return Object.keys(stable).length > 0 ? stable : undefined;
}

function backendEnvironmentCorresponds(expectedOptions: unknown, actualOptions: unknown): boolean {
  const optionsRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  const expectedEnv = optionsRecord(optionsRecord(expectedOptions)["env"]);
  const actualEnv = optionsRecord(optionsRecord(actualOptions)["env"]);
  for (const [name, value] of Object.entries(expectedEnv)) {
    if (!isDeepStrictEqual(actualEnv[name], value)) return false;
  }
  for (const [name, value] of Object.entries(actualEnv)) {
    if (!(name in expectedEnv) && value !== null) return false;
  }
  return true;
}

function canonicalWorktreeSpec(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const worktree = value as Record<string, unknown>;
  return {
    ...worktree,
    ref: worktree["ref"] ?? "origin/main",
    reset_on_reuse: worktree["reset_on_reuse"] ?? false,
    steal_lock: worktree["steal_lock"] ?? false,
  };
}

function canonicalReceiptAuthorityWorktreeSpec(value: unknown): unknown {
  const canonical = canonicalWorktreeSpec(value);
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) return canonical;
  const worktree = { ...canonical as Record<string, unknown> };
  if (worktree["mode"] === "managed") {
    // Managed worktree paths are runtime locators published under
    // receipt.environment.worktree_path. They are not part of the command
    // authority echoed by receipt.run_spec.worktree.
    delete worktree["path"];
  }
  return worktree;
}

function assertHostProcessVisibleCorrespondence(
  runId: string,
  spec: ResolvedHostProcessSpec,
  receipt: HostProcessReceipt,
): void {
  const actual = receipt.process as unknown as Record<string, unknown>;
  for (const [field, expected] of [
    ["process.argv", spec.process.argv],
    ["process.cwd", spec.process.cwd],
    ["process.stop_grace_ms", spec.process.stop_grace_ms],
  ] as const) {
    const key = field.slice("process.".length);
    if (!isDeepStrictEqual(actual[key], expected)) {
      throw new Error(
        `Run ${runId} finalization receipt does not correspond to the stored host_process spec at ${field}.`,
      );
    }
  }
}

function assertExecutionReceiptCorrespondence(
  runId: string,
  spec: ResolvedExecutionSpec,
  receipt: ExecutionReceipt,
  admittedHostProcessBinding?: HostProcessExecutionBinding,
): void {
  const mismatch = (field: string): never => {
    throw new Error(
      `Run ${runId} finalization receipt does not correspond to the stored ${spec.kernel} spec at ${field}.`,
    );
  };

  if (spec.kernel === "host_process") {
    const hostSpec = spec as ResolvedHostProcessSpec;
    const hostReceipt = receipt as HostProcessReceipt;
    assertHostProcessVisibleCorrespondence(runId, hostSpec, hostReceipt);
    if (!isBoundHostProcessReceipt(hostReceipt)) mismatch("execution_binding");
    if (!admittedHostProcessBinding) mismatch("launch.host_process_execution_binding");
    if (!isDeepStrictEqual(hostReceipt.execution_binding, admittedHostProcessBinding)) {
      mismatch("execution_binding");
    }
    return;
  }

  const agentSpec = spec as ResolvedRunSpec;
  const actual = (receipt as unknown as Record<string, unknown>)["run_spec"] as Record<string, unknown>;
  const expected: RunSpec = {
    run_id: agentSpec.run_id,
    host: agentSpec.host,
    backend: agentSpec.backend,
    require_execplan: agentSpec.require_execplan ?? agentSpec.execplan_source !== undefined,
    pull_execplan: false,
    worktree: {
      ...agentSpec.worktree,
      ref: agentSpec.worktree.ref ?? "origin/main",
      reset_on_reuse: agentSpec.worktree.reset_on_reuse ?? false,
      steal_lock: agentSpec.worktree.steal_lock ?? false,
    },
    prompt: agentSpec.prompt,
    ...(agentSpec.system_prompt ? { system_prompt: agentSpec.system_prompt } : {}),
    ...(agentSpec.append_system_prompt ? { append_system_prompt: agentSpec.append_system_prompt } : {}),
    ...(typeof agentSpec.max_turns_per_run === "number" ? { max_turns_per_run: agentSpec.max_turns_per_run } : {}),
    ...(agentSpec.issue ? { issue: agentSpec.issue } : {}),
    ...(agentSpec.profile ? { profile: agentSpec.profile } : {}),
    ...(agentSpec.execplan_source ? { execplan_ref: agentSpec.execplan_source } : {}),
    ...(agentSpec.required_artifacts.length > 0 ? { required_artifacts: agentSpec.required_artifacts } : {}),
    ...(agentSpec.artifact_roots && agentSpec.artifact_roots.length > 0 ? { artifact_roots: agentSpec.artifact_roots } : {}),
    ...(agentSpec.output_capture ? { output_capture: agentSpec.output_capture } : {}),
    ...(agentSpec.backend_options ? { backend_options: agentSpec.backend_options } : {}),
    ...(agentSpec.notifications ? { notifications: agentSpec.notifications } : {}),
    ...(agentSpec.handback ? { handback: agentSpec.handback } : {}),
    ...(agentSpec.metadata ? { metadata: agentSpec.metadata } : {}),
    ...(agentSpec.resume_session_id ? { resume_session_id: agentSpec.resume_session_id } : {}),
  };
  const stableFields = [
    "run_id",
    "issue",
    "host",
    "backend",
    "profile",
    "prompt",
    "prompt_file",
    "prompt_template",
    "system_prompt",
    "append_system_prompt",
    "execplan_ref",
    "require_execplan",
    "pull_execplan",
    "worktree",
    "required_artifacts",
    "artifact_roots",
    "output_capture",
    "max_turns_per_run",
    "backend_options",
    "notifications",
    "handback",
    "metadata",
    "resume_session_id",
  ] as const;
  const expectedRecord = expected as unknown as Record<string, unknown>;
  for (const field of stableFields) {
    const actualValue = field === "backend_options"
      ? stableBackendOptions(actual[field])
      : field === "worktree"
        ? canonicalReceiptAuthorityWorktreeSpec(actual[field])
        : actual[field];
    const expectedValue = field === "backend_options"
      ? stableBackendOptions(expectedRecord[field])
      : field === "worktree"
        ? canonicalReceiptAuthorityWorktreeSpec(expectedRecord[field])
        : expectedRecord[field];
    if (!isDeepStrictEqual(actualValue, expectedValue)) mismatch(`run_spec.${field}`);
  }
  if (
    agentSpec.worktree.mode === "managed"
    && agentSpec.worktree.path
    && agentSpec.worktree.path !== extractReceiptWorktreePath(receipt)
  ) {
    mismatch("environment.worktree_path");
  }
  if (!backendEnvironmentCorresponds(expectedRecord["backend_options"], actual["backend_options"])) {
    mismatch("run_spec.backend_options.env");
  }
}

function assertReceiptTimingCorrespondence(
  runId: string,
  receipt: ExecutionReceipt,
  launch?: RunLaunchState,
): void {
  const parsed = receiptTimingSchema.safeParse(receipt.timing);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "timing"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Run ${runId} finalization receipt timing is invalid: ${detail}.`);
  }
  if (!launch) return;

  const timing = parsed.data;
  const assertOrdered = (earlier: string, later: string, boundary: string): void => {
    if (new Date(later).getTime() + RECEIPT_TIMING_TOLERANCE_MS < new Date(earlier).getTime()) {
      throw new Error(
        `Run ${runId} finalization receipt timing does not correspond to durable ${boundary} chronology within ${RECEIPT_TIMING_TOLERANCE_MS}ms.`,
      );
    }
  };

  // A receipt's created_at is the runner-execution creation authority, while
  // accepted_at, last_dispatch_at, and execution_started_at are earlier
  // durable service admission boundaries. A receipt cannot rebuild state
  // unless those clocks describe one possible execution.
  assertOrdered(launch.accepted_at, timing.created_at, "admission/receipt creation");
  assertOrdered(launch.accepted_at, timing.completed_at, "admission/completion");
  if (launch.last_dispatch_at) {
    assertOrdered(launch.accepted_at, launch.last_dispatch_at, "admission/dispatch");
    assertOrdered(launch.last_dispatch_at, timing.completed_at, "dispatch/completion");
    if (timing.dispatched_at) {
      assertOrdered(launch.last_dispatch_at, timing.dispatched_at, "durable/receipt dispatch");
    }
  }
  if (launch.execution_started_at) {
    assertOrdered(launch.accepted_at, launch.execution_started_at, "admission/execution");
    assertOrdered(launch.execution_started_at, timing.created_at, "execution/receipt creation");
    assertOrdered(launch.execution_started_at, timing.completed_at, "execution/completion");
    if (timing.dispatched_at) {
      assertOrdered(launch.execution_started_at, timing.dispatched_at, "execution/receipt dispatch");
    }
    if (timing.started_at) {
      assertOrdered(launch.execution_started_at, timing.started_at, "durable/receipt execution start");
    }
  }
}

function assertAuthoritativeRunIdentity(args: {
  runId: string;
  intent: RunIntent;
  spec?: ResolvedExecutionSpec | undefined;
  receipt?: ExecutionReceipt | undefined;
  launch?: RunLaunchState | undefined;
  admittedHostProcessBinding?: HostProcessExecutionBinding | undefined;
}): void {
  const mismatch = (surface: string, actual: unknown): never => {
    throw new Error(
      `Run ${args.runId} finalization identity mismatch: ${surface}=${String(actual)}.`,
    );
  };
  if (args.intent.run_id !== args.runId) mismatch("intent.run_id", args.intent.run_id);
  if (args.spec && args.spec.run_id !== args.runId) mismatch("spec.run_id", args.spec.run_id);
  if (!args.receipt) return;
  const receipt = args.receipt as unknown;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    mismatch("receipt", typeof receipt);
  }
  const candidate = receipt as Record<string, unknown>;
  if (args.spec) assertExecutionReceiptShape(args.runId, args.spec, args.receipt);
  if (candidate["run_id"] !== args.runId) mismatch("receipt.run_id", candidate["run_id"]);
  if (typeof candidate["state"] !== "string" || !isTerminalState(candidate["state"] as RunState)) {
    throw new Error(
      `Run ${args.runId} finalization receipt is malformed: receipt.state must be terminal.`,
    );
  }
  const timing = candidate["timing"];
  if (!timing || typeof timing !== "object" || Array.isArray(timing)) {
    throw new Error(`Run ${args.runId} finalization receipt is malformed: receipt.timing is missing.`);
  }
  if ("run_spec" in candidate) {
    const runSpec = candidate["run_spec"];
    if (!runSpec || typeof runSpec !== "object" || Array.isArray(runSpec)) {
      throw new Error(`Run ${args.runId} finalization receipt is malformed: receipt.run_spec is missing.`);
    }
    const nestedRunId = (runSpec as Record<string, unknown>)["run_id"];
    if (nestedRunId !== args.runId) mismatch("receipt.run_spec.run_id", nestedRunId);
    const artifacts = candidate["artifacts"];
    if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) {
      throw new Error(`Run ${args.runId} finalization receipt is malformed: receipt.artifacts is missing.`);
    }
    const artifactRunId = (artifacts as Record<string, unknown>)["run_id"];
    if (artifactRunId !== args.runId) mismatch("receipt.artifacts.run_id", artifactRunId);
  }
  if (args.spec) {
    assertExecutionReceiptCorrespondence(
      args.runId,
      args.spec,
      args.receipt,
      args.admittedHostProcessBinding,
    );
  }
  assertReceiptTimingCorrespondence(args.runId, args.receipt, args.launch);
}

function assertObservedReceiptIdentity(runId: string, receipt: ExecutionReceipt): void {
  const candidate = receipt as unknown as Record<string, unknown>;
  const runSpec = candidate["run_spec"] as Record<string, unknown> | undefined;
  const artifacts = candidate["artifacts"] as Record<string, unknown> | undefined;
  if (
    candidate["run_id"] !== runId
    || (runSpec && runSpec["run_id"] !== runId)
    || (artifacts && artifacts["run_id"] !== runId)
  ) {
    throw new Error(
      `Run directory ${runId} contains a mismatched kernel receipt; run reconciliation before continuing.`,
    );
  }
}

function deriveInfraErrorClassificationFromReceipt(
  receipt: ExecutionReceipt,
): InfraErrorClassification | undefined {
  if (receipt.state !== "infra_error") return undefined;
  const message = inferInfraErrorMessageFromReceipt(receipt, receipt.summary);
  return normalizeInfraErrorClassification(extractInfraErrorClassification(receipt), {
    site: inferInfraErrorSiteFromMessage(message),
    message,
  });
}

function createRunRecordFromReceipt(
  intent: RunIntent,
  launch: RunRecord["launch"],
  spec: ResolvedExecutionSpec,
  receipt: ExecutionReceipt,
  integrations: IntegrationStatus,
  now: string,
  creationProvenance?: ApiProvenanceV1,
): RunRecord {
  const authoritativeIntent: RunIntent = {
    ...intent,
    created_at: receipt.timing.created_at,
  };
  const health = extractReceiptHealth(receipt);
  const infraErrorClassification = deriveInfraErrorClassificationFromReceipt(receipt);
  const infraErrorMessage = receipt.state === "infra_error"
    ? inferInfraErrorMessageFromReceipt(receipt, receipt.summary)
    : undefined;
  const record: RunRecord = {
    schema_version: "1.0",
    run_id: authoritativeIntent.run_id,
    state: receipt.state,
    ...(infraErrorClassification ? { infra_error_classification: infraErrorClassification } : {}),
    intent: authoritativeIntent,
    ...(creationProvenance ? { creation_provenance: creationProvenance } : {}),
    launch,
    spec,
    kernel_receipt: receipt,
    ...(health ? { health } : {}),
    integrations,
    recovery: deriveRecoveryStatus(authoritativeIntent, receipt),
    summary: "",
    created_at: receipt.timing.created_at,
    updated_at: now,
    ...(receipt.timing.completed_at ? { completed_at: receipt.timing.completed_at } : {}),
  };
  record.summary = defaultSummary(record);
  return normalizeInfraErrorForRecord(record, {
    ...(infraErrorClassification ? { classification: infraErrorClassification } : {}),
    ...(infraErrorMessage ? { message: infraErrorMessage } : {}),
  });
}

function authoritativeIntentProjectionDisagrees(
  intent: RunIntent,
  spec: ResolvedExecutionSpec,
): boolean {
  const intentKernel = intent.kernel ?? "agent_runner";
  if (
    intentKernel !== spec.kernel
    || intent.host !== spec.host
  ) {
    return true;
  }
  if (spec.kernel !== "agent_runner") return false;
  const agentSpec = spec as ResolvedRunSpec;
  return (intent.backend ?? "claude") !== agentSpec.backend
    || intent.issue !== agentSpec.issue;
}

function canonicalizeAuthoritativeIntentProjection(
  intent: RunIntent,
  spec: ResolvedExecutionSpec,
  receiptCreatedAt: string,
): RunIntent {
  const canonical: RunIntent = {
    ...intent,
    host: spec.host,
    created_at: receiptCreatedAt,
  };
  if ((intent.kernel ?? "agent_runner") !== spec.kernel) {
    canonical.kernel = spec.kernel;
  }
  if (spec.kernel === "agent_runner") {
    const agentSpec = spec as ResolvedRunSpec;
    if ((intent.backend ?? "claude") !== agentSpec.backend) {
      canonical.backend = agentSpec.backend;
    }
    if (agentSpec.issue === undefined) {
      delete canonical.issue;
    } else {
      canonical.issue = agentSpec.issue;
    }
  }
  return canonical;
}

function terminalReceiptProjectionDisagrees(
  record: RunRecord,
  spec: ResolvedExecutionSpec,
  receipt: ExecutionReceipt,
): boolean {
  return record.state !== receipt.state
    || record.completed_at !== receipt.timing.completed_at
    || record.created_at !== receipt.timing.created_at
    || record.intent.created_at !== receipt.timing.created_at
    || !isDeepStrictEqual(record.spec, spec)
    || authoritativeIntentProjectionDisagrees(record.intent, spec)
    || !isDeepStrictEqual(record.health, extractReceiptHealth(receipt))
    || !isDeepStrictEqual(
      record.infra_error_classification,
      deriveInfraErrorClassificationFromReceipt(receipt),
    );
}

function terminalEventOutcomeMatchesRecord(event: RunTerminalEvent, record: RunRecord): boolean {
  const spec = record.spec;
  const receipt = record.kernel_receipt;
  const expectedBackend = spec && "backend" in spec ? spec.backend : record.intent.backend;
  const expectedCompletedAt = record.completed_at ?? receipt?.timing.completed_at;
  const expectedAgentMessage = extractAgentTerminalMessage(receipt);
  const expectedTerminalEvidence = extractAgentTerminalEvidence(receipt);
  return event.run.state === record.state
    && event.run.incarnation_id === record.launch.incarnation_id
    && event.run.kernel === (spec?.kernel ?? record.intent.kernel ?? "agent_runner")
    && event.run.backend === expectedBackend
    && event.run.host === (spec?.host ?? record.intent.host)
    && event.run.issue === record.intent.issue
    && event.run.profile === record.intent.profile
    && event.run.created_at === record.created_at
    && event.run.started_at === receipt?.timing.started_at
    && event.run.completed_at === expectedCompletedAt
    && event.run.duration_ms === receipt?.timing.duration_ms
    && event.run.recovery_mode === record.recovery.mode
    && isDeepStrictEqual(event.run.infra_error_classification, record.infra_error_classification)
    && event.summary.one_line === record.summary
    && event.summary.agent_terminal_message === expectedAgentMessage
    && isDeepStrictEqual(event.summary.terminal_evidence, expectedTerminalEvidence);
}

function legacyHostTerminalObservationIsCoherent(
  record: RunRecord,
  storedSpec: ResolvedExecutionSpec,
  receipt: HostProcessReceipt,
): boolean {
  if (
    storedSpec.kernel !== "host_process"
    || isBoundHostProcessReceipt(receipt)
    || !isTerminalState(record.state)
    || record.launch.stage !== "executing"
    || record.launch.host_process_execution_binding !== undefined
    || record.state !== receipt.state
    || record.completed_at !== receipt.timing.completed_at
    || record.created_at !== receipt.timing.created_at
    || record.intent.created_at !== receipt.timing.created_at
    || !record.spec
    || !isDeepStrictEqual(record.spec, storedSpec)
    || !record.kernel_receipt
    || !isDeepStrictEqual(record.kernel_receipt, receipt)
    || authoritativeIntentProjectionDisagrees(record.intent, storedSpec)
    || !isDeepStrictEqual(record.health, extractReceiptHealth(receipt))
    || !isDeepStrictEqual(
      record.infra_error_classification,
      deriveInfraErrorClassificationFromReceipt(receipt),
    )
  ) {
    return false;
  }
  try {
    assertObservedReceiptIdentity(record.run_id, receipt);
    assertExecutionReceiptShape(record.run_id, storedSpec, receipt);
    assertHostProcessVisibleCorrespondence(
      record.run_id,
      storedSpec as ResolvedHostProcessSpec,
      receipt,
    );
    return true;
  } catch {
    return false;
  }
}

const LEGACY_HOST_RECEIPT_AUTHORITY_REASON =
  "Legacy host-process receipt has no admitted execution binding and is observation-only; it cannot authorize reconstruction or a new effect.";

function createErroredRunRecord(
  intent: RunIntent,
  launch: RunRecord["launch"],
  spec: ResolvedExecutionSpec | undefined,
  message: string,
  now: string,
  recoveryMode: RunRecord["recovery"]["mode"] = "normal",
  creationProvenance?: ApiProvenanceV1,
  integrations: IntegrationStatus = { results: [], all_critical_ok: true },
): RunRecord {
  const authoritativeSpec = spec?.run_id === intent.run_id ? spec : undefined;
  const infraErrorClassification = classifyInfraError({
    site: inferInfraErrorSiteFromMessage(message),
    message,
  });
  const record: RunRecord = {
    schema_version: "1.0",
    run_id: intent.run_id,
    state: "infra_error",
    infra_error_classification: infraErrorClassification,
    intent,
    ...(creationProvenance ? { creation_provenance: creationProvenance } : {}),
    launch,
    integrations,
    recovery: {
      mode: recoveryMode,
      resumable: false,
      note: message,
    },
    summary: message,
    created_at: intent.created_at,
    updated_at: now,
    completed_at: now,
    ...(authoritativeSpec ? { spec: authoritativeSpec } : {}),
  };
  return record;
}

function createRunningUpdate(
  record: RunRecord,
  state: RunState,
  updatedAt: string,
  spec?: ResolvedExecutionSpec,
  infraErrorClassification?: InfraErrorClassification,
  message?: string,
): RunRecord {
  const next: RunRecord = {
    ...record,
    state,
    ...(state === "infra_error"
      ? {
          infra_error_classification: normalizeInfraErrorClassification(infraErrorClassification, {
            site: message ? inferInfraErrorSiteFromMessage(message) : undefined,
            message,
          }),
        }
      : {}),
    updated_at: updatedAt,
    ...(spec ? { spec } : {}),
  };
  return normalizeInfraErrorForRecord({
    ...next,
    summary: defaultSummary(next),
  }, { classification: infraErrorClassification, message });
}

function mergeRunHealth(
  record: RunRecord,
  health: RunHealthSnapshot,
  spec?: ResolvedExecutionSpec,
): RunRecord {
  const nextUpdatedAt = health.last_progress_at
    && new Date(health.last_progress_at).getTime() > new Date(record.updated_at).getTime()
    ? health.last_progress_at
    : record.updated_at;
  const next: RunRecord = {
    ...record,
    ...(spec ? { spec } : {}),
    health,
    updated_at: nextUpdatedAt,
  };
  next.summary = defaultSummary(next);
  return next;
}

function mergeRunSessionCheckpoint(
  record: RunRecord,
  checkpoint: AgentRunnerSessionCheckpoint,
  spec?: ResolvedExecutionSpec,
): RunRecord {
  const backendSessionId = checkpoint.backend_session?.id?.trim();
  if (!backendSessionId) {
    return record;
  }
  const next: RunRecord = {
    ...record,
    ...(spec ? { spec } : {}),
    recovery: {
      ...record.recovery,
      resumable: true,
      checkpoint: {
        ...record.recovery.checkpoint,
        adapter_session_id: checkpoint.adapter_session_id,
        backend_session_id: backendSessionId,
        ...(checkpoint.backend_session?.path ? { backend_session_path: checkpoint.backend_session.path } : {}),
        last_event_at: checkpoint.timestamp,
        strategy: "native_session",
      },
    },
    updated_at: checkpoint.timestamp,
  };
  next.summary = defaultSummary(next);
  return next;
}

async function discoverArtifacts(
  cwd: string,
  requiredArtifacts: string[],
  kernelReceiptPath: string,
  now: () => string,
): Promise<ArtifactEntry[]> {
  const discovered: ArtifactEntry[] = [];
  for (const artifactName of requiredArtifacts) {
    if (artifactName === path.basename(kernelReceiptPath)) {
      discovered.push({
        name: artifactName,
        location: "run_dir",
        path: kernelReceiptPath,
        required: true,
        detected_at: nowIso(now),
      });
      continue;
    }

    const runDirCandidate = path.join(path.dirname(kernelReceiptPath), artifactName);
    try {
      await access(runDirCandidate);
      discovered.push({
        name: artifactName,
        location: "run_dir",
        path: runDirCandidate,
        required: true,
        detected_at: nowIso(now),
      });
      continue;
    } catch {
      // Fall through to the worktree mirror check.
    }

    const candidate = path.join(cwd, artifactName);
    try {
      await access(candidate);
      discovered.push({
        name: artifactName,
        location: "worktree",
        path: candidate,
        required: true,
        detected_at: nowIso(now),
      });
    } catch {
      // Missing artifacts are handled by the kernel artifact gate.
    }
  }
  return discovered;
}

function currentHost(deps: RunServiceDependencies): string {
  return normalizeHost(deps.hostname());
}

export function isLocalRunTarget(host: string, deps: Pick<RunServiceDependencies, "hostname">): boolean {
  const target = normalizeHost(host);
  return target === "local" || target === currentHost(deps as RunServiceDependencies);
}

type ResumeSessionMatchKind = "recovery_checkpoint" | "resume_reference";

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isResolvedRunSpec(spec: ResolvedExecutionSpec | undefined): spec is ResolvedRunSpec {
  return spec?.kernel === "agent_runner";
}

function extractResolvedWorktreePath(spec: ResolvedExecutionSpec | undefined): string | undefined {
  if (!isResolvedRunSpec(spec)) {
    return undefined;
  }
  return normalizeOptionalText(spec.worktree.path);
}

function extractReceiptWorktreePath(receipt: ExecutionReceipt | undefined): string | undefined {
  if (!receipt || !("environment" in receipt)) {
    return undefined;
  }
  return normalizeOptionalText(receipt.environment.worktree_path);
}

function extractStoredWorktreePath(record: RunRecord): string | undefined {
  return extractResolvedWorktreePath(record.spec)
    ?? normalizeOptionalText(record.intent.worktree_path)
    ?? extractReceiptWorktreePath(record.kernel_receipt);
}

function classifyResumeSessionMatch(record: RunRecord, sessionId: string): ResumeSessionMatchKind | undefined {
  if (record.recovery.checkpoint?.backend_session_id === sessionId) {
    return "recovery_checkpoint";
  }

  const kernelReceipt = record.kernel_receipt;
  if (
    kernelReceipt
    && "backend_session" in kernelReceipt
    && normalizeOptionalText(kernelReceipt.backend_session?.id) === sessionId
  ) {
    return "recovery_checkpoint";
  }

  if (normalizeOptionalText(record.intent.resume_session_id) === sessionId) {
    return "resume_reference";
  }

  if (isResolvedRunSpec(record.spec) && normalizeOptionalText(record.spec.resume_session_id) === sessionId) {
    return "resume_reference";
  }

  return undefined;
}

function buildResumeWorktreeResolutionMessage(sessionId: string, detail: string): string {
  return [
    `Error: calyx run resume cannot determine working directory for session ${sessionId}.`,
    `  - ${detail}`,
    "  - No --worktree-path provided on the command line.",
    "  - No default worktree is safe to auto-resolve to because concurrent resumes would collide.",
    "",
    "Retry with an explicit --worktree-path pointing at a valid working directory for this session.",
  ].join("\n");
}

function buildMissingResumeWorktreeMessage(worktreePath: string): string {
  return `Error: session's prior working directory at ${worktreePath} no longer exists; pass --worktree-path to resume in a different directory.`;
}

function buildMissingActivityCwdMessage(sessionId: string, cwd: string): string {
  return `Error: activity inventory cwd for session ${sessionId} resolved to ${cwd}, but it does not exist as a directory on this host; pass --worktree-path to resume in a valid directory.`;
}

function deriveReceiptComparisonSpec(
  spec: ResolvedExecutionSpec,
  receipt: ExecutionReceipt,
): ResolvedExecutionSpec {
  if (!isResolvedRunSpec(spec)) {
    return spec;
  }

  const worktreePath = extractReceiptWorktreePath(receipt);
  if (!worktreePath || spec.worktree.path === worktreePath) {
    return spec;
  }

  const enrichedSpec: ResolvedRunSpec = {
    ...spec,
    worktree: {
      ...spec.worktree,
      path: worktreePath,
    },
  };
  return enrichedSpec;
}

export class RunService {
  readonly store: RunStore;
  readonly options: Required<Pick<RunServiceOptions, "defaultWorktreeBase">> & RunServiceOptions;
  readonly deps: RunServiceDependencies;
  readonly subscribers: RunSubscriber[];
  readonly runtimeAdapterRegistry: RuntimeAdapterRegistry;
  private readonly inlineStopHandlers = new Map<string, () => void>();
  private readonly eventSubscribers = new Set<(event: CalyxStreamEvent) => void>();
  private readonly monitorEvaluator: MonitorEvaluator | null = null;
  private readonly activityTailer: ActivityTailer | null = null;
  private readonly messageOutboxForwarder: MessageOutboxForwarder | null = null;
  private readonly infraErrorCensusPoints = new Map<string, RunServiceInfraErrorCensusPoint>();
  private readonly infraErrorCensusEvents: RunTerminalEvent[] = [];
  private infraErrorCensusCursor: string | undefined;
  private infraErrorCensusRefresh: Promise<void> | undefined;
  private totalServicedSinceStart = 0;
  private workloadAdmissionState!: WorkloadAdmissionDecisionV1;

  constructor(options: RunServiceOptions = {}, deps: Partial<RunServiceDependencies> = {}) {
    this.store = new RunStore(options.runsRoot ?? defaultRunsRoot(), {
      ...(options.eventLogIngest ? { eventLogIngest: options.eventLogIngest } : {}),
      ...(options.runIndex ? { runIndex: options.runIndex } : {}),
    });
    this.store.subscribeToCommittedStreamEvents((event) => {
      this.notifyEventSubscribers(event);
    });
    this.options = {
      ...options,
      defaultWorktreeBase: options.defaultWorktreeBase ?? defaultWorktreeBase(),
    };
    const runtimeAdapterRegistry = options.runtimeAdapterRegistry ?? createBuiltInRuntimeAdapterRegistry();
    this.runtimeAdapterRegistry = runtimeAdapterRegistry;
    this.deps = {
      ...DEFAULT_DEPS,
      ...deps,
      resolveExecutionKernel: deps.resolveExecutionKernel ?? ((intent: RunIntent) => {
        if (intent.kernel === "host_process") {
          return new HostProcessKernel();
        }
        return new AgentRunnerKernel({
          runtimeAdapterRegistry,
          executeRun,
          ...(options.exitClassifierPipeline ? { exitClassifierPipeline: options.exitClassifierPipeline } : {}),
          ...(options.leases?.enabled === false
            ? {}
            : {
                worktreeLease: createWorktreeLeaseManager({
                  host: currentHost(this.deps),
                  state: options.leases?.state,
                  coordinatorHost: options.leases?.coordinatorHost,
                  now: this.deps.now,
                  onTransactionContention: options.leases?.onTransactionContention,
                }),
              }),
        });
      }),
      ...(deps.spawnWorker ? { spawnWorker: deps.spawnWorker } : {}),
    };
    this.workloadAdmissionState = this.fencedWorkloadAdmissionDecision({
      reason: "admission_evidence_missing",
      failedSurface: "admission_evidence",
      nextAction: "Run workload-admission reconciliation against current topology and target-bundle evidence.",
    });
    this.subscribers = options.subscribers ?? makeDefaultSubscribers();
    const subscriberNames = new Set<string>();
    for (const subscriber of this.subscribers) {
      if (!subscriber.name.trim() || subscriberNames.has(subscriber.name)) {
        throw new Error(`Run subscribers require unique non-empty names; received ${subscriber.name || "<empty>"}.`);
      }
      subscriberNames.add(subscriber.name);
    }
    if (options.monitorEvaluator?.enabled) {
      const delivery = {
        ...(options.monitorEvaluator.delivery ?? {}),
        serverOnlyEnvNames: [
          ...(options.detachedWorkerRedactedEnvNames ?? []),
          ...(options.monitorEvaluator.delivery?.serverOnlyEnvNames ?? []),
        ],
        ...(options.monitorEvaluator.delivery?.codexAppServerSteer
          ? {}
          : {
              codexAppServerSteer: (input) =>
                runtimeAdapterRegistry.steerCodexAppServerTurn?.(input)
                ?? Promise.reject(new Error("Codex app-server steer transport is unavailable.")),
            }),
      } satisfies Omit<MonitorDeliveryDependencies, "now">;
      this.monitorEvaluator = new MonitorEvaluator(
        {
          enabled: true,
          intervalMs: options.monitorEvaluator.intervalMs,
          assignedHost: options.monitorEvaluator.assignedHost ?? this.deps.hostname(),
          ...(options.monitorEvaluator.state ? { state: options.monitorEvaluator.state } : {}),
        },
        {
          store: this.store,
          now: this.deps.now,
          emit: async (event) => {
            await this.emitStreamEvent(event);
          },
          delivery,
          ...(options.monitorEvaluator.sessionWake
            ? { sessionWake: options.monitorEvaluator.sessionWake }
            : {}),
          onError: (error) => {
            try {
              process.stderr.write(`[calyx-monitor] evaluator error: ${error.message}\n`);
            } catch {
              /* swallow */
            }
          },
        },
      );
    }
    if (options.activityTailer?.enabled) {
      this.activityTailer = new ActivityTailer(
        {
          enabled: true,
          ...(options.activityTailer.intervalMs !== undefined
            ? { intervalMs: options.activityTailer.intervalMs }
            : {}),
          host: options.activityTailer.host ?? this.deps.hostname(),
          ...(options.activityTailer.state ? { state: options.activityTailer.state } : {}),
          ...(options.activityTailer.watch !== undefined ? { watch: options.activityTailer.watch } : {}),
          calyxRunsRoot: options.activityTailer.calyxRunsRoot ?? this.store.root,
          ...(this.options.interactiveHomeDir ? { homeDir: this.options.interactiveHomeDir } : {}),
        },
        {
          now: () => nowIso(this.deps.now),
          onError: (error) => {
            try {
              process.stderr.write(`[calyx-activity] tailer error: ${error.message}\n`);
            } catch {
              /* swallow */
            }
          },
        },
      );
    }
    if (options.messageOutbox?.enabled) {
      this.messageOutboxForwarder = new MessageOutboxForwarder(options.messageOutbox);
    }
  }

  startMonitorEvaluator(): void {
    this.monitorEvaluator?.start();
  }

  stopMonitorEvaluator(): void {
    this.monitorEvaluator?.stop();
  }

  startActivityTailer(): void {
    this.activityTailer?.start();
  }

  stopActivityTailer(): void {
    this.activityTailer?.stop();
  }

  private activityReadOptions(observationHost?: string): {
    homeDir?: string;
    codexSessionsRoot?: string;
    codexArchivedSessionsRoot?: string;
    claudeProjectsRoot?: string;
    host: string;
    includeCalyxRuns: true;
    calyxRunsRoot: string;
    beforeDiscoveryRead?: ((directoryPath: string) => Promise<void>) | undefined;
    beforeCandidateStat?: ((candidatePath: string) => Promise<void>) | undefined;
    now: () => Date;
  } {
    return {
      ...(this.options.interactiveHomeDir
        ? {
            homeDir: this.options.interactiveHomeDir,
            codexSessionsRoot: path.join(this.options.interactiveHomeDir, ".codex", "sessions"),
            codexArchivedSessionsRoot: path.join(
              this.options.interactiveHomeDir,
              ".codex",
              "archived_sessions",
            ),
            claudeProjectsRoot: path.join(this.options.interactiveHomeDir, ".claude", "projects"),
          }
        : {}),
      host: observationHost ?? currentHost(this.deps),
      includeCalyxRuns: true,
      calyxRunsRoot: this.options.activityTailer?.calyxRunsRoot ?? this.store.root,
      ...(this.options.interactiveBeforeDiscoveryRead
        ? { beforeDiscoveryRead: this.options.interactiveBeforeDiscoveryRead }
        : {}),
      ...(this.options.interactiveBeforeCandidateStat
        ? { beforeCandidateStat: this.options.interactiveBeforeCandidateStat }
        : {}),
      now: () => new Date(nowIso(this.deps.now)),
    };
  }

  /**
   * Run-record lookups every activity read shares. `listRunIds` is what lets
   * `run:<short-id>` resolve here exactly as it does for `calyx run status`
   * and `calyx run receipt` (POL-1825).
   */
  private runActivityResolver(): RunActivityRecordResolver {
    return {
      getRunRecord: (runId) => this.store.readRunRecord(runId),
      getKernelReceipt: (runId) => this.store.readKernelReceipt(runId),
      listRunIds: () => this.store.listRunIds(),
    };
  }

  async tickActivityTailerOnce(): Promise<ActivityTailerTickResult> {
    if (!this.activityTailer) {
      return {
        status: "disabled",
        sourcesScanned: 0,
        sourcesChanged: 0,
        sourcesPending: 0,
        messagesUpserted: 0,
        bytesIngested: 0,
        errors: 0,
      };
    }
    return this.activityTailer.tickOnce();
  }

  async evaluateMonitorsOnce(): Promise<MonitorEvaluatorTickResult> {
    if (!this.monitorEvaluator) {
      return {
        status: "disabled",
        scanned: 0,
        evaluated: 0,
        wakesCreated: 0,
        duplicates: 0,
        deliveriesAttempted: 0,
        deliveriesDelivered: 0,
        deliveriesFailed: 0,
        deliveriesSkipped: 0,
        errors: 0,
        taskInstallsScanned: 0,
        taskLaunchIntentsCreated: 0,
      };
    }
    return this.monitorEvaluator.tickOnce();
  }

  startMessageOutboxForwarder(): void {
    this.messageOutboxForwarder?.start();
  }

  stopMessageOutboxForwarder(): void {
    this.messageOutboxForwarder?.stop();
  }

  async drainMessageOutboxOnce(): Promise<MessageOutboxDrainResult> {
    if (!this.messageOutboxForwarder) {
      return { expired: 0, scanned: 0, forwarded: 0, failed: 0 };
    }
    return this.messageOutboxForwarder.drainOnce();
  }

  async forwardMessageOutbox(outboxId: string): Promise<MessageOutboxForwardResult | undefined> {
    return this.messageOutboxForwarder?.forwardOutbox(outboxId);
  }

  async observeMessageOutbox(outboxId: string): Promise<MessageOutboxObservationResult | undefined> {
    return this.messageOutboxForwarder?.observeOutbox(outboxId);
  }

  async runningMetrics(): Promise<RunServiceRunningMetrics> {
    let activeRuns = 0;
    for (const entry of await this.store.listActiveRuns()) {
      const ownership = await this.tryExecutionOwnership(entry.run_id, async () => undefined);
      if (!ownership.owned) activeRuns += 1;
    }

    return {
      sse_subscribers: this.eventSubscribers.size,
      codex_app_server_sessions: this.runtimeAdapterRegistry.activeSessionCount?.("codex") ?? 0,
      active_runs: activeRuns,
      total_serviced_since_start: this.totalServicedSinceStart,
    };
  }

  async infraErrorCensus(): Promise<RunServiceInfraErrorCensusPoint[]> {
    if (!this.infraErrorCensusRefresh) {
      this.infraErrorCensusRefresh = this.refreshInfraErrorCensus()
        .finally(() => {
          this.infraErrorCensusRefresh = undefined;
        });
    }
    await this.infraErrorCensusRefresh;
    return [...this.infraErrorCensusPoints.values()].sort((left, right) =>
      left.host.localeCompare(right.host)
      || left.kernel.localeCompare(right.kernel)
      || left.backend.localeCompare(right.backend)
      || left.failure_layer.localeCompare(right.failure_layer)
      || left.failure_reason.localeCompare(right.failure_reason)
    );
  }

  /** Read-only pre-deploy audit of the complete terminal supersession graph. */
  async auditTerminalAuthority(): Promise<InfraErrorCensusAuthorityAudit> {
    const inspected = await this.store.inspectExistingEventAuthority({
      event_type: "run.terminal",
    });
    const events = inspected.events.filter(isRunTerminalEvent);
    return auditInfraErrorCensusAuthority(events, inspected.source);
  }

  /**
   * Advance the current OTel census from the durable cross-process
   * terminal-event authority. Current events use durable
   * `(run_id, incarnation_id)` claims. A chain containing legacy events instead
   * uses its immutable supersession-root event id. Only a valid chain's unique
   * leaf contributes, so corrections replace prior state and classification.
   * Moving the cursor only after the entire candidate graph validates makes
   * malformed history fail atomically and keeps restart replay deterministic.
   *
   * `run.terminal` is the only census authority. In particular, do not bind
   * this projection to a run-record callback when POL-1990's terminal
   * settlement hook lands. A tombstone-settled ghost enters this census only
   * after settlement publishes its authoritative terminal event.
   */
  private async refreshInfraErrorCensus(): Promise<void> {
    const appendedEvents: RunTerminalEvent[] = [];
    let nextCursor = this.infraErrorCensusCursor;
    for await (const event of this.store.readEventsSince(this.infraErrorCensusCursor, {
      event_type: "run.terminal",
    })) {
      if (isRunTerminalEvent(event)) appendedEvents.push(event);
      nextCursor = event.cursor;
    }
    if (appendedEvents.length === 0) return;

    const candidateEvents = [...this.infraErrorCensusEvents, ...appendedEvents];
    const projection = projectInfraErrorCensusAuthority(candidateEvents);
    const nextPoints = new Map<string, RunServiceInfraErrorCensusPoint>();

    // OTel JS retains asynchronous-gauge attribute sets across collections.
    // Reconstruct every historically observed bounded tuple at zero first, so
    // classification and state corrections explicitly clear stale positives,
    // including after a daemon restart.
    for (const event of candidateEvents) {
      const contribution = infraErrorCensusContribution(event);
      if (contribution && !nextPoints.has(contribution.key)) {
        nextPoints.set(contribution.key, { ...contribution.point, count: 0 });
      }
    }
    for (const leaf of projection.leaves) {
      const contribution = infraErrorCensusContribution(leaf.event);
      if (!contribution) continue;
      const point = nextPoints.get(contribution.key) ?? { ...contribution.point, count: 0 };
      point.count += 1;
      nextPoints.set(contribution.key, point);
    }

    this.infraErrorCensusPoints.clear();
    for (const [key, point] of nextPoints) {
      this.infraErrorCensusPoints.set(key, point);
    }
    this.infraErrorCensusEvents.push(...appendedEvents);
    this.infraErrorCensusCursor = nextCursor;
  }

  async *readEventsSince(
    cursor: string | undefined,
    filter: CalyxRunEventFilter = {},
  ): AsyncIterable<CalyxStreamEvent> {
    yield* this.store.readEventsSince(cursor, filter);
  }

  async assertGlobalEventReplayCursor(cursor: string | undefined): Promise<void> {
    await this.store.assertGlobalEventReplayCursor(cursor);
  }

  async prepareGlobalEventAuthority(): Promise<void> {
    await this.store.prepareGlobalEventAuthority();
  }

  subscribeToEvents(
    listener: (event: CalyxStreamEvent) => void,
    filter: CalyxRunEventFilter = {},
  ): () => void {
    const wrapped = (event: CalyxStreamEvent): void => {
      if (filter.run_id && (!("run" in event) || event.run.run_id !== filter.run_id)) {
        return;
      }
      if (filter.event_type && event.event_type !== filter.event_type) {
        return;
      }
      listener(event);
    };
    this.eventSubscribers.add(wrapped);
    return () => {
      this.eventSubscribers.delete(wrapped);
    };
  }

  createIntent(input: Partial<RunIntent> & Pick<RunIntent, "host">): RunIntent {
    const runId = typeof input.run_id === "string" && input.run_id.trim().length > 0
      ? input.run_id.trim()
      : randomUUID();
    assertCanonicalRunId(runId);
    return {
      run_id: runId,
      kernel: input.kernel ?? "agent_runner",
      host: input.host,
      created_at: nowIso(this.deps.now),
      ...(input.issue ? { issue: input.issue } : {}),
      ...(input.template ? { template: input.template } : {}),
      ...(input.template_vars ? { template_vars: input.template_vars } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.prompt_file ? { prompt_file: input.prompt_file } : {}),
      ...(input.system_prompt ? { system_prompt: input.system_prompt } : {}),
      ...(input.append_system_prompt ? { append_system_prompt: input.append_system_prompt } : {}),
      ...(input.execplan_ref ? { execplan_ref: input.execplan_ref } : {}),
      ...(input.backend ? { backend: input.backend } : {}),
      ...(input.profile ? { profile: input.profile } : {}),
      ...(input.repo ? { repo: input.repo } : {}),
      ...(input.worktree_mode ? { worktree_mode: input.worktree_mode } : {}),
      ...(input.worktree_base ? { worktree_base: input.worktree_base } : {}),
      ...(input.worktree_path ? { worktree_path: input.worktree_path } : {}),
      ...(input.worktree_source ? { worktree_source: input.worktree_source } : {}),
      ...(input.worktree_ref ? { worktree_ref: input.worktree_ref } : {}),
      ...(input.worktree_reset_on_reuse ? { worktree_reset_on_reuse: true } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.steal_lock ? { steal_lock: input.steal_lock } : {}),
      ...(typeof input.lock_timeout_ms === "number" ? { lock_timeout_ms: input.lock_timeout_ms } : {}),
      ...(typeof input.require_execplan === "boolean" ? { require_execplan: input.require_execplan } : {}),
      ...(typeof input.pull_execplan === "boolean" ? { pull_execplan: input.pull_execplan } : {}),
      ...(input.required_features ? { required_features: input.required_features } : {}),
      ...(input.required_artifacts ? { required_artifacts: input.required_artifacts } : {}),
      ...(input.artifact_roots ? { artifact_roots: input.artifact_roots } : {}),
      ...(input.output_capture ? { output_capture: input.output_capture } : {}),
      ...(typeof input.max_turns_per_run === "number" ? { max_turns_per_run: input.max_turns_per_run } : {}),
      ...(input.backend_options ? { backend_options: input.backend_options } : {}),
      ...(input.host_process ? { host_process: input.host_process } : {}),
      ...(input.notifications ? { notifications: input.notifications } : {}),
      ...(input.handback ? { handback: input.handback } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.resume_session_id ? { resume_session_id: input.resume_session_id } : {}),
    };
  }

  private async validateResumeDirectory(resolvedPath: string, missingMessage: string): Promise<string> {
    const info = await stat(resolvedPath).catch(() => undefined);
    if (!info?.isDirectory()) {
      throw new Error(missingMessage);
    }
    return resolvedPath;
  }

  private activitySessionMatchesResumeId(sessionId: string, entry: RunActivityEntry): boolean {
    if (entry.entry_kind !== "interactive_session") {
      return false;
    }
    return entry.session_id === sessionId
      || entry.run_id === sessionId
      || entry.run_id.endsWith(`:${sessionId}`);
  }

  private async resolveInteractiveActivityWorktreePath(
    sessionId: string,
    options: { backend?: InteractiveSessionBackend | undefined } = {},
  ): Promise<ResumeWorktreeResolution | { errorDetail: string }> {
    const entries = await this.listActivity({
      includeInteractive: true,
      host: currentHost(this.deps),
      ...(options.backend ? { agentKind: options.backend } : {}),
      sinceMs: 0,
      limit: 10_000,
    });
    const matches = entries
      .filter((entry) => this.activitySessionMatchesResumeId(sessionId, entry))
      .filter((entry): entry is Extract<RunActivityEntry, { entry_kind: "interactive_session" }> =>
        entry.entry_kind === "interactive_session"
      )
      .sort((left, right) => {
        const updated = right.updated_at.localeCompare(left.updated_at);
        if (updated !== 0) {
          return updated;
        }
        return right.created_at.localeCompare(left.created_at);
      });

    const latestWithCwd = matches.find((entry) => normalizeOptionalText(entry.cwd));
    if (!latestWithCwd) {
      return {
        errorDetail: matches.length > 0
          ? `Activity inventory was consulted for session ${sessionId}, and ${matches.length} matching interactive session${matches.length === 1 ? "" : "s"} were found, but none recorded a cwd.`
          : `Activity inventory was consulted for session ${sessionId}, but no matching interactive session with a cwd was found.`,
      };
    }

    const resolvedPath = path.resolve(latestWithCwd.cwd!);
    return {
      path: await this.validateResumeDirectory(
        resolvedPath,
        buildMissingActivityCwdMessage(sessionId, resolvedPath),
      ),
      source: "activity_inventory_cwd",
    };
  }

  async resolveResumeWorktreePath(
    sessionId: string,
    options: { backend?: InteractiveSessionBackend | undefined } = {},
  ): Promise<ResumeWorktreeResolution> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error(
        buildResumeWorktreeResolutionMessage(sessionId, "Session ID is empty."),
      );
    }

    const entries = [...await this.store.listRuns()].sort((left, right) => {
      const updated = right.updated_at.localeCompare(left.updated_at);
      if (updated !== 0) {
        return updated;
      }
      return right.created_at.localeCompare(left.created_at);
    });

    let sawCheckpointMatch = false;
    let sawResumeReferenceMatch = false;

    for (const entry of entries) {
      const record = await this.store.readRunRecord(entry.run_id);
      if (!record) {
        continue;
      }

      const matchKind = classifyResumeSessionMatch(record, normalizedSessionId);
      if (matchKind !== "recovery_checkpoint") {
        continue;
      }
      sawCheckpointMatch = true;

      const storedWorktreePath = extractStoredWorktreePath(record);
      if (!storedWorktreePath) {
        continue;
      }

      const resolvedPath = path.resolve(storedWorktreePath);
      return {
        path: await this.validateResumeDirectory(
          resolvedPath,
          buildMissingResumeWorktreeMessage(resolvedPath),
        ),
        source: "run_spec",
      };
    }

    let runRecordMissDetail: string | undefined;
    if (sawCheckpointMatch) {
      runRecordMissDetail = "Prior runs for this session do not record a working directory.";
    }

    for (const entry of entries) {
      const record = await this.store.readRunRecord(entry.run_id);
      if (!record) {
        continue;
      }

      const matchKind = classifyResumeSessionMatch(record, normalizedSessionId);
      if (matchKind !== "resume_reference") {
        continue;
      }
      sawResumeReferenceMatch = true;

      const storedWorktreePath = extractStoredWorktreePath(record);
      if (!storedWorktreePath) {
        continue;
      }

      const resolvedPath = path.resolve(storedWorktreePath);
      return {
        path: await this.validateResumeDirectory(
          resolvedPath,
          buildMissingResumeWorktreeMessage(resolvedPath),
        ),
        source: "run_spec",
      };
    }

    if (sawResumeReferenceMatch) {
      runRecordMissDetail = "Prior resume references for this session do not record a working directory.";
    }

    const activityResolution = await this.resolveInteractiveActivityWorktreePath(normalizedSessionId, options);
    if ("path" in activityResolution) {
      return activityResolution;
    }

    throw new Error(
      buildResumeWorktreeResolutionMessage(
        normalizedSessionId,
        runRecordMissDetail
          ? `${runRecordMissDetail} ${activityResolution.errorDetail}`
          : `No prior run spec found for this session. ${activityResolution.errorDetail}`,
      ),
    );
  }

  private async applyResumeWorktreeDefaults(intent: RunIntent): Promise<RunIntent> {
    if (!intent.resume_session_id) {
      return intent;
    }

    const explicitWorktreePath = normalizeOptionalText(intent.worktree_path);
    if (explicitWorktreePath) {
      return {
        ...intent,
        worktree_path: explicitWorktreePath,
        worktree_source: intent.worktree_source ?? "explicit_flag",
      };
    }

    const resolution = await this.resolveResumeWorktreePath(intent.resume_session_id, {
      ...(intent.backend === "codex" || intent.backend === "claude" ? { backend: intent.backend } : {}),
    });
    return {
      ...intent,
      worktree_path: resolution.path,
      worktree_source: resolution.source,
    };
  }

  private notifyEventSubscribers(event: CalyxStreamEvent): void {
    for (const subscriber of this.eventSubscribers) {
      try {
        const notification = (subscriber as (candidate: CalyxStreamEvent) => unknown)(event);
        if (
          notification
          && (typeof notification === "object" || typeof notification === "function")
          && "then" in notification
        ) {
          void Promise.resolve(notification).catch(() => undefined);
        }
      } catch {
        // Event delivery is observational. A broken SSE/listener consumer must
        // never roll an already-durable terminal outcome back into infra_error.
      }
    }
  }

  private async emitStreamEvent<T extends CalyxStreamEvent>(event: T): Promise<T> {
    return this.store.appendEvent(event);
  }

  private async findTerminalEvent(record: RunRecord): Promise<RunTerminalEvent | undefined> {
    const runEvents = await this.store.readEvents(record.run_id);
    const terminalEvents = new Map<string, RunTerminalEvent>();
    for (const event of runEvents) {
      if (isRunTerminalEvent(event)) {
        terminalEvents.set(event.event_id, event);
      }
    }
    for (const terminalEvent of await this.store.readConnectedTerminalEvents(record.run_id)) {
      terminalEvents.set(terminalEvent.event_id, terminalEvent);
    }
    if (terminalEvents.size === 0) return undefined;

    // Correction order is the immutable supersession graph, not producer wall
    // clock. The graph projector rejects malformed branches/cycles before a
    // new terminal event can be published. A current UUID claim has exactly
    // one leaf; a legacy claim with multiple roots cannot be linked back to an
    // extant record safely and therefore also fails closed.
    const projection = projectInfraErrorCensusAuthority([...terminalEvents.values()]);
    const candidates = projection.leaves.filter(
      ({ event }) => event.run.incarnation_id === record.launch.incarnation_id,
    );
    if (candidates.length > 1) {
      throw new Error(
        `Run ${record.run_id} terminal authority has ${candidates.length} leaves for the extant claim; refusing to publish a correction.`,
      );
    }
    return candidates[0]?.event;
  }

  private async buildTerminalEvent(
    record: RunRecord,
    emittedBy: RunTerminalEvent["emitted_by"],
    previousState?: RunState,
    supersedes?: RunTerminalEvent,
  ): Promise<RunTerminalEvent | undefined> {
    if (!isTerminalState(record.state) || !isCalyxTerminalState(record.state)) {
      return undefined;
    }
    const eventRecord = record.state === "infra_error"
      ? normalizeInfraErrorForRecord(record)
      : record;
    if (eventRecord !== record && !record.infra_error_classification) {
      await this.store.writeRunRecord(record.run_id, eventRecord);
    }
    const sequence = (await this.store.readEvents(record.run_id)).filter((event) => isCalyxRunEvent(event)).length + 1;
    const emittedAt = nowIso(this.deps.now);
    const paths = this.store.paths(record.run_id);
    const spec = record.spec;
    const receipt = record.kernel_receipt;
    const worktreePath = receipt && "environment" in receipt && typeof receipt.environment.worktree_path === "string"
      ? receipt.environment.worktree_path
      : spec && "worktree" in spec
        ? spec.worktree.path
        : undefined;
    const branch = receipt && "environment" in receipt && typeof receipt.environment.branch === "string"
      ? receipt.environment.branch
      : spec && "worktree" in spec
        ? spec.worktree.branch
        : undefined;
    const agentTerminalMessage = extractAgentTerminalMessage(receipt);
    const terminalEvidence = extractAgentTerminalEvidence(receipt);
    const terminalState = eventRecord.state as CalyxRunTerminalState;
    return {
      schema_version: "1.0",
      event_id: randomUUID(),
      cursor: `${emittedAt}-${record.run_id}-${String(sequence).padStart(6, "0")}`,
      emitted_at: emittedAt,
      event_type: "run.terminal",
      emitted_by: emittedBy,
      run: {
        run_id: eventRecord.run_id,
        ...(record.launch.incarnation_id ? { incarnation_id: record.launch.incarnation_id } : {}),
        state: terminalState,
        ...(previousState && previousState !== record.state ? { previous_state: previousState } : {}),
        kernel: spec?.kernel ?? record.intent.kernel ?? "agent_runner",
        ...(spec && "backend" in spec ? { backend: spec.backend } : record.intent.backend ? { backend: record.intent.backend } : {}),
        host: spec?.host ?? record.intent.host,
        ...(record.intent.issue ? { issue: record.intent.issue } : {}),
        ...(record.intent.profile ? { profile: record.intent.profile } : {}),
        created_at: record.created_at,
        ...(receipt?.timing.started_at ? { started_at: receipt.timing.started_at } : {}),
        ...(record.completed_at ? { completed_at: record.completed_at } : receipt?.timing.completed_at ? { completed_at: receipt.timing.completed_at } : {}),
        ...(typeof receipt?.timing.duration_ms === "number" ? { duration_ms: receipt.timing.duration_ms } : {}),
        recovery_mode: record.recovery.mode,
        ...(eventRecord.state === "infra_error" && eventRecord.infra_error_classification
          ? { infra_error_classification: eventRecord.infra_error_classification }
          : {}),
      },
      origin: deriveEventOrigin(record.intent),
      pointers: {
        run_dir: paths.runDir,
        run_record_path: paths.runRecordPath,
        ...(receipt ? { kernel_receipt_path: paths.kernelReceiptPath } : {}),
        events_path: paths.eventsPath,
      },
      summary: {
        one_line: record.summary,
        ...(agentTerminalMessage ? { agent_terminal_message: agentTerminalMessage } : {}),
        ...(terminalEvidence ? { terminal_evidence: terminalEvidence } : {}),
      },
      ...(supersedes
        ? {
            supersession: {
              schema_version: "calyx.run-terminal-supersession/v1",
              supersedes_event_id: supersedes.event_id,
              reason: "receipt_projection_corrected",
            },
          }
        : {}),
      ...(worktreePath || branch
        ? {
            enrichment: {
              ...(worktreePath ? { worktree_path: worktreePath } : {}),
              ...(branch ? { branch } : {}),
            },
          }
        : {}),
    };
  }

  private async ensureTerminalEvent(
    record: RunRecord,
    emittedBy: RunTerminalEvent["emitted_by"],
    previousState?: RunState,
  ): Promise<RunTerminalEvent | undefined> {
    // Terminal publication is a mutation boundary even for direct/local
    // RunService callers that do not pass through daemon startup. Prepare the
    // replay authority once here; observation endpoints remain prepared-only
    // and therefore cannot import or repair state from a GET request.
    await this.store.prepareGlobalEventAuthority();
    return withSqliteMutex(
      this.store.paths(record.run_id).finalizationMutexPath,
      () => this.ensureTerminalEventOwned(record, emittedBy, previousState),
      { acquireTimeoutMs: null },
    );
  }

  private async ensureTerminalEventOwned(
    record: RunRecord,
    emittedBy: RunTerminalEvent["emitted_by"],
    previousState?: RunState,
  ): Promise<RunTerminalEvent | undefined> {
    if (!isTerminalState(record.state) || !isCalyxTerminalState(record.state)) {
      return undefined;
    }
    const existing = await this.findTerminalEvent(record);
    if (existing && terminalEventOutcomeMatchesRecord(existing, record)) {
      // appendStreamEvent is idempotent per journal by event_id. Replaying the
      // exact authoritative event heals either half of the global-then-local
      // crash window without minting a competing terminal correction.
      const canonicalExisting = await this.store.appendEvent(existing);
      await this.ensureTerminalHandback(record, canonicalExisting);
      return canonicalExisting;
    }
    const event = await this.buildTerminalEvent(record, emittedBy, previousState, existing);
    if (!event) {
      return undefined;
    }
    const canonicalEvent = await this.emitStreamEvent(event);
    await this.ensureTerminalHandback(record, canonicalEvent);
    return canonicalEvent;
  }

  private async terminalHandbackAuthorityDecision(
    record: RunRecord,
  ): Promise<TerminalHandbackAuthorityDecision> {
    let durableReceipt = record.kernel_receipt;
    if (!durableReceipt) {
      let observedReceipt: ExecutionReceipt | undefined;
      try {
        observedReceipt = await this.store.readKernelReceipt(record.run_id);
      } catch (error) {
        return {
          kind: "authoritative",
          annotation: {
            schema_version: "calyx.run-handback-authority/v1",
            authority_source: "typed_projection",
            receipt_status: "receipt_rejected",
            correction_status: "correction_unavailable",
            reason: error instanceof SyntaxError
              ? `Kernel receipt is invalid JSON: ${error.message}`
              : error instanceof Error
                ? error.message
                : String(error),
          },
        };
      }
      if (observedReceipt) {
        try {
          durableReceipt = (await this.validateOwnerFreeReceiptAuthority(record, observedReceipt)).receipt;
        } catch (error) {
          const parsedState = runStateSchema.safeParse(
            (observedReceipt as unknown as Record<string, unknown>)["state"],
          );
          return {
            kind: "authoritative",
            annotation: {
              schema_version: "calyx.run-handback-authority/v1",
              authority_source: "typed_projection",
              receipt_status: "receipt_rejected",
              correction_status: "correction_unavailable",
              reason: error instanceof Error ? error.message : String(error),
              ...(parsedState.success && isTerminalState(parsedState.data)
                ? { receipt_state: parsedState.data }
                : {}),
            },
          };
        }
      }
    }

    if (terminalHandbackOutcomeIsAuthoritative(record, durableReceipt)) {
      return { kind: "authoritative" };
    }
    if (durableReceipt) {
      return {
        kind: "withheld",
        annotation: {
          schema_version: "calyx.run-handback-authority/v1",
          authority_source: "kernel_receipt",
          receipt_status: "receipt_accepted",
          correction_status: "correction_pending",
          reason: "validated_kernel_receipt_contradicts_typed_projection",
          receipt_state: durableReceipt.state,
        },
      };
    }
    return {
      kind: "withheld",
      annotation: {
        schema_version: "calyx.run-handback-authority/v1",
        authority_source: "typed_projection",
        receipt_status: "receipt_missing",
        correction_status: "correction_pending",
        reason: "terminal_outcome_requires_kernel_receipt",
      },
    };
  }

  private async ensureTerminalHandback(
    record: RunRecord,
    event: RunTerminalEvent | undefined,
  ): Promise<TerminalHandbackReceipt | undefined> {
    if (this.options.handback?.enabled === false) {
      return undefined;
    }
    const handback = record.spec?.handback ?? record.intent.handback;
    if (!handback || !handback.key.trim() || !handback.recipient_address.trim()) {
      return undefined;
    }
    const paths = this.store.paths(record.run_id);
    const receiptPath = terminalHandbackReceiptPath(paths, handback);
    const dedupeKey = handbackDedupeKey(record.run_id, handback);
    const authority = await this.terminalHandbackAuthorityDecision(record);
    const existingReceipt = await readValidTerminalHandbackReceipt({
      filePath: receiptPath,
      record,
      handback,
      dedupeKey,
      ...(event ? { event } : {}),
    });

    const emittedAt = nowIso(this.deps.now);
    const subject = handback.subject?.trim() || `Run ${record.run_id} terminal: ${record.state}`;
    const locators = buildTerminalHandbackLocators(record, paths, event);
    const writeWithheld = async (
      annotation: TerminalHandbackAuthorityAnnotation,
    ): Promise<TerminalHandbackReceipt> => {
      if (
        existingReceipt?.status === "withheld"
        && isDeepStrictEqual(existingReceipt.authority_annotation, annotation)
      ) {
        return existingReceipt;
      }
      const receipt = makeTerminalHandbackReceipt({
        record,
        handback,
        dedupeKey,
        flow: "withheld/v1",
        status: "withheld",
        emittedAt,
        subject,
        locators,
        authorityAnnotation: annotation,
        ...(event ? { event } : {}),
        reason: annotation.reason,
      });
      await writeTerminalHandbackReceipt(receiptPath, receipt);
      await this.store.appendEvent(
        record.run_id,
        buildServiceEvent(this.deps.now, record.run_id, "handback_withheld", "Withheld a non-authoritative terminal handback.", {
          handback_key: handback.key,
          receipt_path: receiptPath,
          projection_state: record.state,
          receipt_status: annotation.receipt_status,
          correction_status: annotation.correction_status,
          ...(annotation.receipt_state ? { receipt_state: annotation.receipt_state } : {}),
          reason: annotation.reason,
        }),
      );
      return receipt;
    };
    if (authority.kind === "withheld") {
      return writeWithheld(authority.annotation);
    }
    if (existingReceipt && existingReceipt.status !== "withheld") return existingReceipt;

    // Terminal events are an immutable audit surface and may be superseded.
    // Caller correspondence normally keeps one stable identity. A second,
    // explicitly typed identity is reserved for the correction of a
    // contradictory provisional outcome with durable delivery evidence.
    const flow = handback.flow ?? "calyx.msg/v1";
    const reviewSummary = terminalHandbackNeedsReviewSummary(record, handback)
      ? await buildTerminalHandbackReviewSummary(record)
      : undefined;

    const writeReceiptOnly = async (reason: string): Promise<TerminalHandbackReceipt> => {
      const receipt = makeTerminalHandbackReceipt({
        record,
        handback,
        dedupeKey,
        flow: "receipt-only/v1",
        status: "receipt_only",
        emittedAt,
        subject,
        locators,
        ...(reviewSummary ? { reviewSummary } : {}),
        ...(authority.annotation ? { authorityAnnotation: authority.annotation } : {}),
        ...(event ? { event } : {}),
        reason,
      });
      await writeTerminalHandbackReceipt(receiptPath, receipt);
      await this.store.appendEvent(
        record.run_id,
        buildServiceEvent(this.deps.now, record.run_id, "handback_emitted", "Recorded terminal handback receipt-only degrade.", {
          handback_key: handback.key,
          receipt_path: receiptPath,
          reason,
        }),
      );
      return receipt;
    };

    if (flow === "receipt-only/v1" || this.options.handback?.messageCorrespondence === false) {
      return writeReceiptOnly(
        flow === "receipt-only/v1"
          ? "message_correspondence_unavailable"
          : "message_correspondence_disabled",
      );
    }

    let correspondenceCommitted = false;
    try {
      await applyStateMigrations({ ...(this.options.handback?.state ? { storeOptions: this.options.handback.state } : {}) });
      const opened = await openStateStore(this.options.handback?.state ?? {});
      try {
        const schema = checkMessageSchema(opened.db);
        if (schema.status !== "ok") {
          return await writeReceiptOnly("message_schema_unavailable");
        }
        const resolved = resolveMessageAddress(handback.recipient_address, {
          currentHost: currentHost(this.deps),
          ...(handback.recipient_host ? { explicitHost: handback.recipient_host } : {}),
        });
        const local = !resolved.target_host || normalizeHost(resolved.target_host) === currentHost(this.deps);
        const renderBody = (correction?: TerminalHandbackCorrection): string => renderTerminalHandbackBody({
          record,
          handback,
          locators,
          ...(reviewSummary ? { reviewSummary } : {}),
          ...(authority.annotation ? { authorityAnnotation: authority.annotation } : {}),
          ...(correction ? { correction } : {}),
        });
        const buildPayload = (
          duplicateMismatch?: TerminalHandbackDuplicateMismatch,
          correction?: TerminalHandbackCorrection,
        ): Record<string, unknown> => ({
          source: "run-service-terminal-handback",
          run_id: record.run_id,
          handback_key: handback.key,
          dedupe_key: dedupeKey,
          terminal_state: record.state,
          correspondence: correction
            ? {
                schema_version: correction.schema_version,
                kind: correction.kind,
                supersedes_message_id: correction.supersedes_message_id,
                provisional_state: correction.provisional_state,
                authoritative_state: correction.authoritative_state,
              }
            : {
                schema_version: "calyx.run-handback-correspondence/v1",
                kind: "terminal_outcome",
              },
          ...(event ? { terminal_event_id: event.event_id } : {}),
          ...(duplicateMismatch ? { duplicate_mismatch: duplicateMismatch } : {}),
          ...(authority.annotation ? { authority_annotation: authority.annotation } : {}),
          ...(correction ? { correction } : {}),
          ...(reviewSummary ? { review_summary: reviewSummary } : {}),
          locators,
        });
        let activeDedupeKey = dedupeKey;
        let duplicateMismatch: TerminalHandbackDuplicateMismatch | undefined;
        let correction: TerminalHandbackCorrection | undefined;
        let messageDisposition: NonNullable<TerminalHandbackReceipt["message"]>["disposition"] = "inserted";
        let result: ReturnType<typeof createMessage>;
        let outbox: ReturnType<typeof enqueueMessageOutbox> | undefined;
        opened.db.exec("BEGIN IMMEDIATE");
        try {
          result = createMessage(opened.db, {
            message_id: handbackMessageId(record.run_id, handback),
            sender: `run:${record.run_id}`,
            recipient_address: resolved.address,
            recipient_class: resolved.recipient_class,
            recipient_host: resolved.target_host,
            subject,
            body: renderBody(),
            thread_key: handback.thread_key,
            idempotency_key: dedupeKey,
            urgency: "normal",
            ack_required: handback.ack_required,
            status: local ? "pending" : "outbox",
            now: emittedAt,
            payload: buildPayload(),
          });
          if (!result.inserted) {
            messageDisposition = "duplicate";
            duplicateMismatch = terminalHandbackDuplicateMismatch(result.message, resolved);
            if (duplicateMismatch) {
              activeDedupeKey = handbackRepairDedupeKey(dedupeKey, resolved);
              result = createMessage(opened.db, {
                message_id: handbackRepairMessageId(record.run_id, handback, dedupeKey, resolved),
                sender: `run:${record.run_id}`,
                recipient_address: resolved.address,
                recipient_class: resolved.recipient_class,
                recipient_host: resolved.target_host,
                subject,
                body: renderBody(),
                thread_key: handback.thread_key,
                idempotency_key: activeDedupeKey,
                urgency: "normal",
                ack_required: handback.ack_required,
                status: local ? "pending" : "outbox",
                now: emittedAt,
                payload: buildPayload(duplicateMismatch),
              });
              const repairMismatch = terminalHandbackDuplicateMismatch(result.message, resolved);
              if (repairMismatch) {
                throw new Error(`message_duplicate_destination_mismatch:${repairMismatch.message_id}`);
              }
              messageDisposition = result.inserted ? "inserted" : "duplicate";
            } else {
              const provisionalState = terminalHandbackMessageOutcome(result.message, record, handback);
              if (provisionalState && provisionalState !== record.state) {
                const deliveryEvidence = terminalHandbackDeliveryEvidence(result.message);
                if (deliveryEvidence) {
                  correction = {
                    schema_version: "calyx.run-handback-correction/v1",
                    kind: "authoritative_supersession",
                    supersedes_message_id: result.message.message_id,
                    provisional_state: provisionalState,
                    authoritative_state: record.state,
                    delivery_evidence: deliveryEvidence,
                  };
                  activeDedupeKey = handbackCorrectionDedupeKey(dedupeKey, result.message.message_id);
                  result = createMessage(opened.db, {
                    message_id: handbackCorrectionMessageId(
                      record.run_id,
                      handback,
                      dedupeKey,
                      correction.supersedes_message_id,
                    ),
                    sender: `run:${record.run_id}`,
                    recipient_address: resolved.address,
                    recipient_class: resolved.recipient_class,
                    recipient_host: resolved.target_host,
                    subject,
                    body: renderBody(correction),
                    thread_key: handback.thread_key,
                    idempotency_key: activeDedupeKey,
                    urgency: "normal",
                    ack_required: handback.ack_required,
                    status: local ? "pending" : "outbox",
                    now: emittedAt,
                    payload: buildPayload(undefined, correction),
                  });
                  const correctionMismatch = terminalHandbackDuplicateMismatch(result.message, resolved);
                  const correctionState = terminalHandbackMessageOutcome(result.message, record, handback);
                  if (correctionMismatch || correctionState !== record.state) {
                    throw new Error(`authoritative_correction_collision:${result.message.message_id}`);
                  }
                  messageDisposition = "authoritative_correction";
                } else {
                  const updated = updateUndeliveredTerminalHandbackMessage(
                    opened.db,
                    result.message.message_id,
                    {
                      subject,
                      body: renderBody(),
                      payload: buildPayload(),
                      updatedAt: emittedAt,
                    },
                  );
                  if (!updated) {
                    throw new TerminalHandbackDeliveryUnsettledError(result.message.message_id);
                  }
                  result = { message: updated, inserted: false };
                  messageDisposition = "updated_pending";
                }
              }
            }
          }
          enqueueMessageReceiptMirror(opened.db, result.message.message_id, emittedAt);
          outbox = !local && resolved.target_host
            ? enqueueMessageOutbox(opened.db, {
                message_id: result.message.message_id,
                target_host: resolved.target_host,
                now: emittedAt,
                payload: {
                  recipient_address: resolved.address,
                  source: "run-service-terminal-handback",
                  ...(duplicateMismatch ? { duplicate_mismatch: duplicateMismatch } : {}),
                  ...(correction ? { correction } : {}),
                },
              })
            : undefined;
          opened.db.exec("COMMIT");
          correspondenceCommitted = true;
        } catch (error) {
          try {
            opened.db.exec("ROLLBACK");
          } catch {
            // Preserve the transaction failure rather than a secondary rollback error.
          }
          throw error;
        }

        let mirrorFailure: string | undefined;
        try {
          await drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
            message_id: result.message.message_id,
            force: true,
            limit: 1,
          });
        } catch (error) {
          mirrorFailure = error instanceof Error ? error.message : String(error);
        }
        const message = readMessage(opened.db, result.message.message_id) ?? result.message;
        const messageReceiptPath = message.receipt_path ?? undefined;
        if (!messageReceiptPath && !mirrorFailure) {
          mirrorFailure = "message receipt mirror remains pending";
        }
        const receipt = makeTerminalHandbackReceipt({
          record,
          handback,
          dedupeKey,
          flow: "calyx.msg/v1",
          status: correction
            ? "corrected"
            : messageDisposition === "updated_pending"
              ? "updated"
              : result.inserted
                ? "sent"
                : "duplicate",
          emittedAt,
          subject,
          locators,
          ...(reviewSummary ? { reviewSummary } : {}),
          ...(authority.annotation ? { authorityAnnotation: authority.annotation } : {}),
          ...(correction ? { correction } : {}),
          ...(event ? { event } : {}),
          message: {
            message_id: message.message_id,
            inserted: result.inserted,
            idempotency_key: activeDedupeKey,
            disposition: messageDisposition,
            ...(correction ? { supersedes_message_id: correction.supersedes_message_id } : {}),
            ...(messageReceiptPath ? { receipt_path: messageReceiptPath } : {}),
            ...(outbox ? { outbox_id: outbox.outbox_id } : {}),
            ...(duplicateMismatch ? { duplicate_mismatch: duplicateMismatch } : {}),
          },
          ...(mirrorFailure ? { reason: `message_receipt_pending:${mirrorFailure}` } : {}),
        });
        await writeTerminalHandbackReceipt(receiptPath, receipt);
        await this.store.appendEvent(
          record.run_id,
          buildServiceEvent(this.deps.now, record.run_id, "handback_emitted", "Emitted terminal handback.", {
            handback_key: handback.key,
            status: receipt.status,
            message_id: message.message_id,
            receipt_path: receiptPath,
            message_receipt_status: messageReceiptPath ? "durable" : "pending",
            ...(duplicateMismatch ? { duplicate_mismatch: duplicateMismatch } : {}),
            ...(correction
              ? {
                  correction: correction.kind,
                  supersedes_message_id: correction.supersedes_message_id,
                }
              : {}),
          }),
        );
        return receipt;
      } finally {
        opened.db.close();
      }
    } catch (error) {
      if (correspondenceCommitted) throw error;
      if (error instanceof TerminalHandbackDeliveryUnsettledError) {
        return writeWithheld({
          schema_version: "calyx.run-handback-authority/v1",
          authority_source: "kernel_receipt",
          receipt_status: "receipt_accepted",
          correction_status: "correction_pending",
          reason: error.message,
          ...(record.kernel_receipt ? { receipt_state: record.kernel_receipt.state } : {}),
        });
      }
      return writeReceiptOnly(error instanceof Error ? error.message : String(error));
    }
  }

  private async appendMutationIntent(
    runId: string,
    event: "launch_intent" | "stop_intent" | "reconcile_intent",
    message: string,
    provenance: ApiProvenanceV1,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.store.appendDurableEvent(
      runId,
      buildServiceEvent(this.deps.now, runId, event, message, {
        correlation_id: provenance.request_id,
        ...payload,
      }, provenance),
    );
  }

  private async appendMutationResult(
    runId: string,
    event: "launch_result" | "stop_result" | "reconcile_result",
    message: string,
    provenance: ApiProvenanceV1,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.store.appendDurableEvent(
        runId,
        buildServiceEvent(this.deps.now, runId, event, message, {
          correlation_id: provenance.request_id,
          ...payload,
        }, provenance),
      );
    } catch (error) {
      // The preceding intent remains the truthful indeterminate observation.
      // Do not turn an already-applied capability effect into a retry-inducing
      // transport failure merely because its trailing observation could not
      // be appended.
      console.warn(
        `calyx run ${event} observation failed for ${runId}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async appendPostEffectEvent(runId: string, event: RunServiceEvent): Promise<void> {
    try {
      await this.store.appendEvent(runId, event);
    } catch (error) {
      console.warn(
        `calyx run post-effect observation failed for ${runId}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async applyReconcileEffect<T>(
    runId: string,
    effect: string,
    provenance: ApiProvenanceV1 | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    if (provenance) {
      await this.appendMutationIntent(
        runId,
        "reconcile_intent",
        `Reconciliation intends to apply ${effect}.`,
        provenance,
        { effect, batch_atomic: false },
      );
    }
    try {
      const result = await action();
      if (provenance) {
        await this.appendMutationResult(
          runId,
          "reconcile_result",
          `Reconciliation observed ${effect} complete.`,
          provenance,
          { effect, outcome: "completed", batch_atomic: false },
        );
      }
      return result;
    } catch (error) {
      if (provenance) {
        await this.appendMutationResult(
          runId,
          "reconcile_result",
          `Reconciliation could not prove ${effect} complete.`,
          provenance,
          {
            effect,
            outcome: "indeterminate",
            batch_atomic: false,
            error_code: "reconcile_effect_failed",
          },
        );
      }
      throw error;
    }
  }

  protected async initializeAdmittedRun(
    admission: RunCreationAdmission,
    intent: RunIntent,
    options: InitializeRunOptions = {},
  ): Promise<RunRecord> {
    await this.store.ensureRoot();
    const creationProvenance = optionalApiProvenance(options.creationProvenance);
    let record: RunRecord;
    try {
      record = await this.store.createRun(admission, intent, {
        ...(creationProvenance ? { creationProvenance } : {}),
        launchMode: options.launchMode ?? "inline",
        admissionIdentity: options.admissionIdentity,
        requestHash: options.requestHash,
        acceptedAt: options.acceptedAt ?? nowIso(this.deps.now),
      });
    } catch (error) {
      if (error instanceof RunCreationConflictError) {
        const winner = await this.store.readRunRecord(intent.run_id);
        if (winner) throw new RunAlreadyExistsError(intent.run_id, winner.state);
      }
      throw error;
    }
    await this.ensureLaunchAdmissionEvents(record, false);
    return record;
  }

  /**
   * Protected test/internal seam that remains safe when re-publicized: it
   * obtains a fresh one-shot capability beneath the universal boundary.
   */
  protected async initializeRun(
    input: RunIntent,
    options: InitializeRunOptions = {},
  ): Promise<RunRecord> {
    const admission = await this.withWorkloadAdmissionBoundary(async () => {
      await this.reconcileWorkloadAdmissionUnserialized();
      this.assertWorkloadAdmission(options.plannedTopologyProjectionSha256);
      return issueRunCreationAdmission();
    });
    const intent = await this.applyResumeWorktreeDefaults(input);
    return this.initializeAdmittedRun(admission, intent, options);
  }

  private async ensureLaunchAdmissionEvents(
    record: RunRecord,
    includeLaunchIntent: boolean,
  ): Promise<void> {
    const events = (await this.store.readEvents(record.run_id)).filter(isRunServiceEvent);
    const provenanceMatches = (candidate: ApiProvenanceV1 | undefined): boolean =>
      isDeepStrictEqual(candidate, record.creation_provenance);
    const hasIntentPersisted = events.some((event) =>
      event.event === "intent_persisted" && provenanceMatches(event.provenance)
    );
    if (!hasIntentPersisted) {
      await this.store.appendDurableEvent(
        record.run_id,
        buildServiceEvent(
          this.deps.now,
          record.run_id,
          "intent_persisted",
          "Persisted authoritative run launch admission.",
          undefined,
          record.creation_provenance,
        ),
      );
    }

    if (!includeLaunchIntent || !record.creation_provenance) return;
    const provenance = record.creation_provenance;
    const hasLaunchIntent = events.some((event) => {
      if (event.event !== "launch_intent" || !provenanceMatches(event.provenance)) return false;
      const payload = event.payload as { correlation_id?: unknown; mode?: unknown } | undefined;
      return payload?.correlation_id === provenance.request_id
        && payload.mode === record.launch.mode;
    });
    if (!hasLaunchIntent) {
      await this.appendMutationIntent(
        record.run_id,
        "launch_intent",
        "Run launch was durably admitted before execution dispatch.",
        provenance,
        { mode: record.launch.mode },
      );
    }
  }

  private assertLaunchReplayMatches(
    existing: RunRecord,
    admissionIdentity: string,
    requestHash: string,
    mode: RunLaunchMode,
    provenance: ApiProvenanceV1 | undefined,
  ): void {
    if (
      existing.launch.mode !== mode
      || existing.launch.admission_identity !== admissionIdentity
      || existing.launch.request_hash !== requestHash
      || !isDeepStrictEqual(existing.creation_provenance, provenance)
    ) {
      throw new RunAlreadyExistsError(existing.run_id, existing.state);
    }
  }

  private fencedWorkloadAdmissionDecision(args: {
    reason: WorkloadAdmissionFenceReason;
    failedSurface: WorkloadAdmissionEvidenceError["failedSurface"];
    nextAction: string;
    accepted?: WorkloadAdmissionDecisionV1;
  }): WorkloadAdmissionDecisionV1 {
    const accepted = args.accepted;
    const retained = accepted?.admission === "open"
      ? {
          last_accepted_topology: accepted.accepted_topology,
          last_accepted_target_bundle: accepted.accepted_target_bundle,
          last_gate_receipt: accepted.gate_receipt,
        }
      : accepted?.last_accepted_topology
          && accepted.last_accepted_target_bundle
          && accepted.last_gate_receipt
        ? {
            last_accepted_topology: accepted.last_accepted_topology,
            last_accepted_target_bundle: accepted.last_accepted_target_bundle,
            last_gate_receipt: accepted.last_gate_receipt,
          }
        : {};
    return {
      schema_version: WORKLOAD_ADMISSION_DECISION_SCHEMA_VERSION,
      admission: "fenced",
      reason: args.reason,
      failed_surface: args.failedSurface ?? "admission_evidence",
      next_action: args.nextAction,
      ...retained,
      decided_at: nowIso(this.deps.now),
    };
  }

  private async withWorkloadAdmissionBoundary<T>(action: () => Promise<T>): Promise<T> {
    const acquireTimeoutMs = this.options.workloadAdmission?.acquireTimeoutMs ?? 5_000;
    try {
      return await withSqliteMutex(
        this.store.workloadAdmissionMutexPath(),
        action,
        { acquireTimeoutMs, queueInProcess: false },
      );
    } catch (error) {
      if (error instanceof SqliteMutexBusyError) {
        throw new WorkloadAdmissionBusyError({
          decision: this.workloadAdmissionDecision(),
          acquireTimeoutMs,
        });
      }
      throw error;
    }
  }

  private validateWorkloadAdmissionReceipt(
    receipt: WorkloadAdmissionGateReceiptV1,
    host: string,
  ): void {
    const invalid = (failedSurface: string, message: string): never => {
      throw new WorkloadAdmissionEvidenceError({
        reason: "admission_evidence_missing",
        failedSurface: failedSurface === "admission_evidence"
          ? "admission_evidence"
          : failedSurface as WorkloadAdmissionGateReceiptV1["evaluated_surfaces"][number],
        nextAction: "Regenerate the admission receipt from the current reconciler and retry.",
        message,
      });
    };
    if (
      receipt.schema_version !== WORKLOAD_ADMISSION_GATE_RECEIPT_SCHEMA_VERSION
      || receipt.profile !== WORKLOAD_ADMISSION_INTERIM_PROFILE
    ) {
      invalid("admission_evidence", "Unsupported workload-admission receipt contract or profile.");
    }
    if (
      !isDeepStrictEqual(receipt.evaluated_surfaces, [...WORKLOAD_ADMISSION_INTERIM_SURFACES])
      || !isDeepStrictEqual(receipt.deferred_surfaces, [...WORKLOAD_ADMISSION_INTERIM_DEFERRED_SURFACES])
    ) {
      invalid("admission_evidence", "The workload-admission receipt does not name the exact interim check set.");
    }
    if (normalizeHost(receipt.host) !== host || receipt.desired_membership !== "active") {
      invalid("topology", `The workload-admission receipt is not bound to desired-active host ${host}.`);
    }
    if (
      receipt.topology.schema_version !== "fleet-topology-snapshot/v1"
      || receipt.topology.source_repository !== "polli-labs/agents-infra"
      || !receipt.topology.source_commit.trim()
      || !receipt.topology.projection_sha256.trim()
      || receipt.checks.topology.status !== "pass"
      || receipt.checks.topology.authority !== "authoritative"
    ) {
      invalid("topology", "The workload-admission receipt lacks authoritative topology identity.");
    }
    if (
      receipt.target_bundle.schema_version !== WORKLOAD_ADMISSION_TARGET_BUNDLE_SCHEMA_VERSION
      || !receipt.target_bundle.calyx_build.git_head.trim()
      || !receipt.target_bundle.calyx_build.package_version.trim()
      || !receipt.target_bundle.state_schema_target.trim()
    ) {
      invalid("running", "The workload-admission receipt lacks a complete target-bundle identity.");
    }
    if (
      receipt.checks.running.status !== "pass"
      || receipt.checks.running.dirty !== false
      || receipt.checks.running.git_head !== receipt.target_bundle.calyx_build.git_head
      || receipt.checks.running.package_version !== receipt.target_bundle.calyx_build.package_version
    ) {
      invalid("running", "The passing running-build evidence does not match the target bundle.");
    }
    if (
      receipt.checks.reachability.status !== "pass"
      || !["daemon_listener", "in_process_composition"].includes(receipt.checks.reachability.evidence)
    ) {
      invalid("reachability", "The workload-admission receipt lacks passing reachability evidence.");
    }
    if (
      receipt.checks.state_schema.status !== "pass"
      || receipt.checks.state_schema.current !== receipt.checks.state_schema.target
      || receipt.checks.state_schema.target !== receipt.target_bundle.state_schema_target
    ) {
      invalid("state_schema", "The passing state-schema evidence does not match the target bundle.");
    }
    if (!Number.isFinite(Date.parse(receipt.issued_at))) {
      invalid("admission_evidence", "The workload-admission receipt timestamp is invalid.");
    }
  }

  private async reconcileWorkloadAdmissionUnserialized(): Promise<WorkloadAdmissionDecisionV1> {
    const previouslyAccepted = this.workloadAdmissionState;
    const reconciler = this.options.workloadAdmission?.reconcile;
    if (!reconciler) {
      this.workloadAdmissionState = this.fencedWorkloadAdmissionDecision({
        reason: "admission_evidence_missing",
        failedSurface: "admission_evidence",
        nextAction: "Configure the workload-admission reconciler, then retry the launch.",
        accepted: previouslyAccepted,
      });
      return this.workloadAdmissionState;
    }
    const host = normalizeHost(this.options.hostname ?? this.deps.hostname());
    try {
      const receipt = await reconciler({ host });
      this.validateWorkloadAdmissionReceipt(receipt, host);
      this.workloadAdmissionState = {
        schema_version: WORKLOAD_ADMISSION_DECISION_SCHEMA_VERSION,
        admission: "open",
        accepted_topology: receipt.topology,
        accepted_target_bundle: receipt.target_bundle,
        gate_receipt: receipt,
        decided_at: nowIso(this.deps.now),
      };
    } catch (error) {
      const evidence = error instanceof WorkloadAdmissionEvidenceError
        ? error
        : new WorkloadAdmissionEvidenceError({
            reason: "admission_evidence_missing",
            failedSurface: "admission_evidence",
            nextAction: "Restore workload-admission evidence, then retry the launch.",
            message: error instanceof Error ? error.message : String(error),
          });
      this.workloadAdmissionState = this.fencedWorkloadAdmissionDecision({
        reason: evidence.reason,
        failedSurface: evidence.failedSurface,
        nextAction: evidence.nextAction,
        accepted: previouslyAccepted,
      });
    }
    return this.workloadAdmissionState;
  }

  /** Current immutable workload-admission publication for health/status. */
  workloadAdmissionDecision(): WorkloadAdmissionDecisionV1 {
    return structuredClone(this.workloadAdmissionState);
  }

  /** The only action capable of replacing fenced boot state with an open receipt. */
  reconcileWorkloadAdmission(): Promise<WorkloadAdmissionDecisionV1> {
    return this.withWorkloadAdmissionBoundary(() => this.reconcileWorkloadAdmissionUnserialized());
  }

  private assertWorkloadAdmission(
    plannedTopologyProjectionSha256: string | undefined,
  ): void {
    const decision = this.workloadAdmissionState;
    if (decision.admission === "fenced") {
      throw new WorkloadAdmissionFencedError({
        reason: decision.reason,
        failedSurface: decision.failed_surface,
        nextAction: decision.next_action,
        decision,
      });
    }
    if (
      plannedTopologyProjectionSha256 !== undefined
      && plannedTopologyProjectionSha256 !== decision.accepted_topology.projection_sha256
    ) {
      throw new WorkloadAdmissionFencedError({
        reason: "topology_mismatch",
        failedSurface: "topology",
        nextAction: "Retry the original launch command so it replans against the current authoritative topology digest.",
        decision,
      });
    }
  }

  private async admitLaunch(
    input: RunIntent,
    mode: RunLaunchMode,
    provenance: ApiProvenanceV1 | undefined,
    binding: Pick<
      LaunchRunOptions,
      "admissionIdentity" | "requestHash" | "plannedTopologyProjectionSha256"
    > = {},
  ): Promise<{ record: RunRecord; created: boolean }> {
    const requestHash = binding.requestHash ?? hashCanonicalJcs(input);
    const admissionIdentity = binding.admissionIdentity ?? hashCanonicalJcs({
      domain: "calyx.local-run-launch/v1",
      request_hash: requestHash,
    });
    const existing = await this.store.readRunRecord(input.run_id);
    if (existing) {
      assertRunRecordIdentity(input.run_id, existing);
      this.assertLaunchReplayMatches(
        existing,
        admissionIdentity,
        requestHash,
        mode,
        provenance,
      );
      await this.ensureLaunchAdmissionEvents(existing, true);
      return { record: existing, created: false };
    }

    const record = await this.initializeRun(input, {
      ...(provenance ? { creationProvenance: provenance } : {}),
      launchMode: mode,
      admissionIdentity,
      requestHash,
      acceptedAt: nowIso(this.deps.now),
      ...(binding.plannedTopologyProjectionSha256
        ? { plannedTopologyProjectionSha256: binding.plannedTopologyProjectionSha256 }
        : {}),
    });
    await this.ensureLaunchAdmissionEvents(record, true);
    return { record, created: true };
  }

  private launchResult(record: RunRecord): RunLaunchResult {
    return {
      run_id: record.run_id,
      state: record.state,
      mode: record.launch.mode === "detached" ? "background" : "foreground",
      run_dir: this.store.paths(record.run_id).runDir,
      record,
    };
  }

  private async tryExecutionOwnership<T>(
    runId: string,
    action: () => Promise<T>,
  ): Promise<{ owned: true; value: T } | { owned: false }> {
    try {
      const value = await withSqliteMutex(
        this.store.paths(runId).executionMutexPath,
        action,
        { acquireTimeoutMs: 0, queueInProcess: false },
      );
      return { owned: true, value };
    } catch (error) {
      if (error instanceof SqliteMutexBusyError) return { owned: false };
      throw error;
    }
  }

  private async tryDispatchOwnership<T>(
    runId: string,
    action: () => Promise<T>,
  ): Promise<{ owned: true; value: T } | { owned: false }> {
    try {
      const value = await withSqliteMutex(
        this.store.paths(runId).dispatchMutexPath,
        action,
        { acquireTimeoutMs: 0, queueInProcess: false },
      );
      return { owned: true, value };
    } catch (error) {
      if (error instanceof SqliteMutexBusyError) return { owned: false };
      throw error;
    }
  }

  private unknownIntegrationStatus(): IntegrationStatus {
    const results = this.subscribers.map((subscriber): IntegrationResult => ({
      name: subscriber.name,
      critical: Boolean(subscriber.critical),
      status: "failed",
      error: "Integration outcome is unknown; execution ended before a durable subscriber result was published.",
      details: { outcome: "unknown" },
    }));
    return {
      results,
      all_critical_ok: results.every((result) => !result.critical),
    };
  }

  private recoverIntegrationStatus(stored: IntegrationStatus | undefined): IntegrationStatus {
    const currentByName = new Map(this.subscribers.map((subscriber) => [subscriber.name, subscriber]));
    const unknownByName = new Map(this.unknownIntegrationStatus().results.map((result) => [result.name, result]));
    const seen = new Set<string>();
    const results: IntegrationResult[] = [];
    for (const storedResult of stored?.results ?? []) {
      if (seen.has(storedResult.name)) continue;
      seen.add(storedResult.name);
      const current = currentByName.get(storedResult.name);
      results.push({
        ...storedResult,
        critical: storedResult.critical || Boolean(current?.critical),
      });
    }
    for (const subscriber of this.subscribers) {
      if (seen.has(subscriber.name)) continue;
      seen.add(subscriber.name);
      results.push(unknownByName.get(subscriber.name)!);
    }
    return {
      results,
      all_critical_ok: results.every((result) => !result.critical || result.status !== "failed"),
    };
  }

  private async recoverAndPersistIntegrationStatus(
    runId: string,
    options: { failSoft?: boolean | undefined } = {},
  ): Promise<IntegrationStatus> {
    let stored: IntegrationStatus | undefined;
    try {
      stored = await this.store.readIntegrations(runId);
    } catch {
      // A missing, torn, or malformed result cannot prove that an external
      // subscriber effect did not run. Preserve that ambiguity as unknown.
      stored = undefined;
    }
    const recovered = this.recoverIntegrationStatus(stored);
    try {
      await this.store.writeIntegrations(runId, recovered);
    } catch (error) {
      if (!options.failSoft) throw error;
      console.warn(
        `calyx run ${runId} receipt-backed integration repair remains pending`,
        error instanceof Error ? error.message : String(error),
      );
    }
    return recovered;
  }

  private async persistReceiptDerivedRunRecord(record: RunRecord): Promise<"current" | "repaired" | "repair_pending"> {
    await this.store.writeRunRecord(record.run_id, record);
    return this.store.isRunIndexProjectionRepairPending(record.run_id)
      ? "repair_pending"
      : "current";
  }

  private async observeReceiptDerivedFinalization(
    record: RunRecord,
    previousState: RunState,
    projection: "current" | "repaired" | "repair_pending",
    repairReason?: string,
  ): Promise<void> {
    try {
      await this.ensureTerminalEvent(record, "launch", previousState);
      await this.store.appendEvent(
        record.run_id,
        buildServiceEvent(
          this.deps.now,
          record.run_id,
          "launch_completed",
          repairReason
            ? "Run execution finished from its durable receipt; post-receipt finalization required repair."
            : "Run execution finished.",
          {
            state: record.state,
            projection_repair: projection,
            ...(repairReason ? { finalization_repair: repairReason } : {}),
            ...(record.infra_error_classification
              ? { infra_error_classification: record.infra_error_classification }
              : {}),
          },
        ),
      );
    } catch (error) {
      console.warn(
        `calyx run ${record.run_id} terminal observation requires reconciliation`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async readOwnerFreeReceiptAuthority(
    record: RunRecord,
  ): Promise<OwnerFreeReceiptAuthority | undefined> {
    const receipt = await this.store.readKernelReceipt(record.run_id);
    if (!receipt) return undefined;
    return this.validateOwnerFreeReceiptAuthority(record, receipt);
  }

  private async validateOwnerFreeReceiptAuthority(
    record: RunRecord,
    receipt: ExecutionReceipt,
  ): Promise<OwnerFreeReceiptAuthority> {
    if (
      "kernel" in receipt
      && receipt.kernel === "host_process"
      && !isBoundHostProcessReceipt(receipt)
    ) {
      throw new Error(LEGACY_HOST_RECEIPT_AUTHORITY_REASON);
    }

    const storedSpec = await this.store.readSpec(record.run_id);
    const kernel = this.deps.resolveExecutionKernel(record.intent);
    const spec = storedSpec ?? record.spec ?? kernel.createRecoverySpec(record.intent, this.deps.now);
    assertAuthoritativeRunIdentity({
      runId: record.run_id,
      intent: record.intent,
      spec,
      receipt,
      launch: record.launch,
      admittedHostProcessBinding: record.launch.host_process_execution_binding,
    });
    return { receipt, spec };
  }

  private async rebuildOwnerFreeRecordFromReceipt(
    record: RunRecord,
    emittedBy: RunTerminalEvent["emitted_by"],
    provenance?: ApiProvenanceV1,
    options: {
      invalidReceiptDisposition?: "classify" | "defer";
      validatedAuthority?: OwnerFreeReceiptAuthority;
    } = {},
  ): Promise<ReceiptRecoveryOutcome> {
    const classifyInvalidReceipt = options.invalidReceiptDisposition !== "defer";
    let authority: OwnerFreeReceiptAuthority | undefined;
    try {
      authority = options.validatedAuthority
        ?? await this.readOwnerFreeReceiptAuthority(record);
    } catch (error) {
      if (!classifyInvalidReceipt) return { status: "absent" };
      const reason = error instanceof SyntaxError
        ? `Kernel receipt is invalid JSON: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
      const integrations = await this.recoverAndPersistIntegrationStatus(record.run_id);
      const classified = await this.classifyOwnerFreeRecord(record, reason, integrations);
      return { status: "classified", record: classified, reason };
    }
    if (!authority) return { status: "absent" };
    const { receipt, spec } = authority;

    // Receipt correspondence is the terminal authority boundary. Everything
    // below is a repairable projection or observation and therefore cannot
    // downgrade the typed outcome if it fails.
    const integrations = await this.recoverAndPersistIntegrationStatus(record.run_id, { failSoft: true });
    const authoritativeIntent = canonicalizeAuthoritativeIntentProjection(
      record.intent,
      spec,
      receipt.timing.created_at,
    );
    const rebuilt = createRunRecordFromReceipt(
      authoritativeIntent,
      record.launch,
      spec,
      receipt,
      integrations,
      nowIso(this.deps.now),
      record.creation_provenance,
    );
    rebuilt.recovery = {
      mode: deriveCrashRecoveryMode(record.intent),
      resumable: false,
      note: "Rebuilt run_record.json from an existing kernel receipt after execution ownership ended.",
    };
    const normalized = normalizeInfraErrorForRecord({
      ...rebuilt,
      summary: defaultSummary(rebuilt),
    });
    let projection: "current" | "repaired" | "repair_pending" = "repair_pending";
    let recordPublished = false;
    try {
      projection = await this.persistReceiptDerivedRunRecord(normalized);
      recordPublished = true;
    } catch (error) {
      console.warn(
        `calyx run ${record.run_id} receipt-backed record repair remains pending`,
        error instanceof Error ? error.message : String(error),
      );
    }
    const recordProjectionCurrent = recordPublished && projection !== "repair_pending";
    try {
      await this.ensureTerminalEvent(normalized, emittedBy, record.state);
      await this.store.appendEvent(
        record.run_id,
        buildServiceEvent(
          this.deps.now,
          record.run_id,
          "reconciled",
          recordProjectionCurrent
            ? "Rebuilt run record from a durable kernel receipt after execution ownership ended."
            : "Durable kernel receipt is authoritative; run record projection repair remains pending.",
          {
            reconcile: recordProjectionCurrent
              ? "record_rebuild_from_receipt"
              : "record_rebuild_from_receipt_pending",
            projection_repair: projection,
          },
          provenance,
        ),
      );
    } catch (error) {
      console.warn(
        `calyx run ${record.run_id} receipt-backed terminal observation remains pending`,
        error instanceof Error ? error.message : String(error),
      );
    }
    return recordProjectionCurrent
      ? { status: "rebuilt", record: normalized }
      : { status: "repair_pending", record: normalized };
  }

  private async rebuildLegacyRecordFromReceipt(
    record: RunRecord,
    emittedBy: RunTerminalEvent["emitted_by"],
    provenance?: ApiProvenanceV1,
  ): Promise<ReceiptRecoveryOutcome> {
    // Receipt correspondence is checked before the provenance intent. A
    // partial or mismatched receipt can still belong to the unfenced legacy
    // publisher, so even an intent append would be a competing write.
    let authority: OwnerFreeReceiptAuthority | undefined;
    try {
      authority = await this.readOwnerFreeReceiptAuthority(record);
    } catch {
      return { status: "absent" };
    }
    if (!authority) return { status: "absent" };

    let recovery: ReceiptRecoveryOutcome | undefined;
    await this.applyReconcileEffect(
      record.run_id,
      "legacy_record_rebuild_from_receipt",
      provenance,
      async () => {
        recovery = await this.rebuildOwnerFreeRecordFromReceipt(
          record,
          emittedBy,
          provenance,
          {
            invalidReceiptDisposition: "defer",
            validatedAuthority: authority,
          },
        );
        if (recovery.status === "absent") {
          throw new Error(`Run ${record.run_id} validated receipt authority disappeared.`);
        }
        if (recovery.status === "rebuilt" || recovery.status === "repair_pending") {
          await this.clearLegacyWorkerPidEvidence(record.run_id);
        }
      },
    );
    return recovery!;
  }

  private async receiptDerivedRecordIsCurrent(runId: string): Promise<boolean> {
    try {
      const [record, receipt, storedSpec] = await Promise.all([
        this.store.readRunRecord(runId),
        this.store.readKernelReceipt(runId),
        this.store.readSpec(runId),
      ]);
      const authoritativeSpec = storedSpec ?? record?.spec;
      return Boolean(
        record
        && receipt
        && authoritativeSpec
        && !terminalReceiptProjectionDisagrees(record, authoritativeSpec, receipt)
        && record.kernel_receipt
        && isDeepStrictEqual(record.kernel_receipt, receipt),
      );
    } catch {
      return false;
    }
  }

  private async waitForExecutionRegistration(
    runId: string,
    options: {
      timeoutMs?: number;
      provenance?: ApiProvenanceV1;
      dispatchAttempt?: number;
    } = {},
  ): Promise<RunRecord> {
    const deadline = Date.now() + (options.timeoutMs ?? 10_000);
    while (Date.now() <= deadline) {
      const record = await this.store.readRunRecord(runId);
      if (!record) throw new Error(`Run record disappeared while dispatching ${runId}.`);
      if (isTerminalState(record.state)) return record;
      const ownership = await this.tryExecutionOwnership(runId, async () => {
        const current = await this.store.readRunRecord(runId);
        if (!current) throw new Error(`Run record disappeared while dispatching ${runId}.`);
        if (isTerminalState(current.state) || current.state === "queued") return current;
        const recovery = await this.rebuildOwnerFreeRecordFromReceipt(
          current,
          "launch",
          options.provenance,
        );
        if (recovery.status !== "absent") return recovery.record;
        const failed = await this.classifyOwnerFreeRecord(
          current,
          "Execution ownership ended before a terminal receipt was durable; refusing ambiguous effect replay.",
        );
        throw new Error(failed.summary);
      });
      if (ownership.owned) {
        if (isTerminalState(ownership.value.state)) return ownership.value;
        const refusal = ownership.value.launch.execution_admission_refusal;
        if (
          refusal
          && options.dispatchAttempt !== undefined
          && refusal.dispatch_attempt === options.dispatchAttempt
        ) {
          throw this.executionAdmissionRefusalError(refusal);
        }
      }
      if (
        !ownership.owned
        && record.state !== "queued"
        && record.launch.stage === "executing"
        && record.launch.execution_id
      ) {
        return record;
      }
      await delay(25);
    }
    throw new Error(
      `Detached worker for ${runId} did not durably register execution ownership before the dispatch deadline.`,
    );
  }

  private executionAdmissionRefusalError(
    refusal: RunExecutionAdmissionRefusal,
  ): WorkloadAdmissionFencedError | WorkloadAdmissionBusyError {
    return refusal.code === "workload_admission_busy"
      ? new WorkloadAdmissionBusyError({
          decision: refusal.decision,
          acquireTimeoutMs: refusal.acquire_timeout_ms,
        })
      : new WorkloadAdmissionFencedError({
          reason: refusal.reason,
          failedSurface: refusal.failed_surface,
          nextAction: refusal.next_action,
          decision: refusal.decision,
        });
  }

  private async publishExecutionAdmissionRefusal(
    record: RunRecord,
    error: WorkloadAdmissionFencedError | WorkloadAdmissionBusyError,
  ): Promise<void> {
    const refusedAt = nowIso(this.deps.now);
    const commonRefusal = {
      schema_version: "calyx.run-execution-admission-refusal/v1" as const,
      dispatch_attempt: record.launch.dispatch_attempts,
      refused_at: refusedAt,
      reason: error.reason,
      failed_surface: error.failedSurface,
      next_action: error.nextAction,
      decision: error.decision,
    };
    const refusal: RunExecutionAdmissionRefusal = error instanceof WorkloadAdmissionBusyError
      ? {
          ...commonRefusal,
          code: "workload_admission_busy",
          acquire_timeout_ms: error.acquireTimeoutMs,
        }
      : { ...commonRefusal, code: "workload_admission_fenced" };
    const current = await this.store.readRunRecord(record.run_id);
    if (!current) throw new Error(`Run record disappeared while refusing execution ${record.run_id}.`);
    assertRunRecordIdentity(record.run_id, current);
    if (current.state !== "queued") {
      throw new Error(
        `Run ${record.run_id} left queued state before its execution-admission refusal was durable.`,
      );
    }
    const retryable: RunRecord = {
      ...current,
      launch: {
        ...current.launch,
        stage: "accepted",
        execution_admission_refusal: refusal,
      },
      summary: `Run ${record.run_id} remains queued after a retryable execution-admission refusal.`,
      updated_at: refusedAt,
    };
    await this.store.writeRunRecord(record.run_id, retryable);
    await this.store.appendEvent(
      record.run_id,
      buildServiceEvent(
        this.deps.now,
        record.run_id,
        "execution_admission_refused",
        "Detached worker refused first execution before an external effect.",
        { refusal },
      ),
    );
  }

  private async classifyOwnerFreeRecord(
    record: RunRecord,
    message: string,
    integrations?: IntegrationStatus,
    authoritativeRunId: string = record.run_id,
  ): Promise<RunRecord> {
    const authoritativeIntent = record.intent.run_id === authoritativeRunId
      ? record.intent
      : { ...record.intent, run_id: authoritativeRunId };
    const authoritativeSpec = record.spec?.run_id === authoritativeRunId
      ? record.spec
      : undefined;
    const durableIntegrations = integrations
      ?? await this.recoverAndPersistIntegrationStatus(authoritativeRunId);
    const next = createErroredRunRecord(
      authoritativeIntent,
      record.launch,
      authoritativeSpec,
      message,
      nowIso(this.deps.now),
      deriveCrashRecoveryMode(authoritativeIntent),
      record.creation_provenance,
      durableIntegrations,
    );
    if (!hasSynthesizedLegacyAdmission(next)) {
      // Quarantine publication must complete before the run leaves the active
      // set. If SQLite commits but the run-event append fails, the still-active
      // record guarantees that a later reconcile (including after restart)
      // re-enters the repair path.
      await this.quarantineOwnerFreeSettledRunWorktreeLeases(authoritativeRunId);
    }
    await this.store.writeRunRecord(authoritativeRunId, next);
    await this.ensureTerminalEvent(next, "reconcile", record.state);
    await this.store.appendEvent(
      authoritativeRunId,
      buildServiceEvent(
        this.deps.now,
        authoritativeRunId,
        "reconciled",
        `Marked owner-free run as ${deriveCrashRecoveryMode(authoritativeIntent)}.`,
        { reconcile: "owner_free_fail_closed" },
      ),
    );
    return next;
  }

  async submitDetached(
    input: RunIntent,
    options: Omit<LaunchRunOptions, "detached" | "nextTurnInput"> = {},
  ): Promise<RunLaunchResult> {
    const provenance = optionalApiProvenance(options.provenance);
    const intent = input;
    const legacyReplay = (existing: RunRecord): RunLaunchResult | undefined => {
      assertRunRecordIdentity(intent.run_id, existing);
      if (!hasSynthesizedLegacyAdmission(existing)) return undefined;
      const replayRequestHash = options.requestHash ?? hashCanonicalJcs(intent);
      if (
        existing.launch.mode !== "detached"
        || existing.launch.request_hash !== replayRequestHash
        || !isDeepStrictEqual(existing.creation_provenance, provenance)
      ) {
        throw new RunAlreadyExistsError(existing.run_id, existing.state);
      }
      return this.launchResult(existing);
    };

    // Refuse the migration-only generation before creating or acquiring a
    // current-generation dispatch mutex. Recheck under the mutex below to
    // close the ordinary read-to-lock race for current admissions.
    const preflightExisting = await this.store.readRunRecord(intent.run_id);
    if (preflightExisting) {
      const replay = legacyReplay(preflightExisting);
      if (replay) return replay;
      if (hasLegacySettlementMarker(preflightExisting)) {
        throw new RunExecutionSettlementPendingError(intent.run_id);
      }
    }
    try {
      return await withSqliteMutex(this.store.paths(intent.run_id).dispatchMutexPath, async () => {
        const existing = await this.store.readRunRecord(intent.run_id);
        if (existing) {
          const replay = legacyReplay(existing);
          if (replay) return replay;
          if (hasLegacySettlementMarker(existing)) {
            throw new RunExecutionSettlementPendingError(intent.run_id);
          }
        }
        const admitted = await this.admitLaunch(intent, "detached", provenance, options);
        await options.onAdmitted?.(admitted.record);
        let record = await this.store.readRunRecord(intent.run_id) ?? admitted.record;
        if (isTerminalState(record.state)) {
          return this.launchResult(record);
        }
        if (hasSynthesizedLegacyAdmission(record)) {
          throw new RunExecutionSettlementPendingError(intent.run_id);
        }

        const ownershipProbe = await this.tryExecutionOwnership(intent.run_id, async () => {
          const current = await this.store.readRunRecord(intent.run_id) ?? record;
          if (isTerminalState(current.state) || current.state === "queued") {
            return { record: current, failedClosed: false };
          }
          const recovery = await this.rebuildOwnerFreeRecordFromReceipt(
            current,
            "launch",
            provenance,
          );
          if (recovery.status === "rebuilt" || recovery.status === "repair_pending") {
            return { record: recovery.record, failedClosed: false };
          }
          if (recovery.status === "classified") {
            return { record: recovery.record, failedClosed: true };
          }
          const failed = await this.classifyOwnerFreeRecord(
            current,
            "Execution ownership ended before a terminal receipt was durable; refusing ambiguous effect replay.",
          );
          return { record: failed, failedClosed: true };
        });
        if (!ownershipProbe.owned) {
          return this.launchResult(await this.waitForExecutionRegistration(intent.run_id, {
            ...(provenance ? { provenance } : {}),
            dispatchAttempt: record.launch.dispatch_attempts,
          }));
        }
        record = ownershipProbe.value.record;
        if (ownershipProbe.value.failedClosed) {
          throw new Error(record.summary);
        }
        if (isTerminalState(record.state)) {
          return this.launchResult(record);
        }

        const entrypoint = this.options.workerEntrypoint;
        if (!entrypoint) {
          throw new Error(
            "RunService detached submission requires a workerEntrypoint.",
          );
        }
        const retryableLaunch = { ...record.launch };
        delete retryableLaunch.execution_admission_refusal;
        record = {
          ...record,
          launch: {
            ...retryableLaunch,
            stage: "dispatching",
            dispatch_attempts: record.launch.dispatch_attempts + 1,
            last_dispatch_at: nowIso(this.deps.now),
          },
          updated_at: nowIso(this.deps.now),
        };
        await this.store.writeRunRecord(intent.run_id, record);

        const launcher = this.deps.spawnWorker ?? spawnDetachedWorker;
        const launched = await launcher({
          entrypoint,
          runId: intent.run_id,
          runsRoot: this.store.root,
          runDir: this.store.paths(intent.run_id).runDir,
          ...(this.options.detachedWorkerRedactedEnvNames
            ? { redactedEnvNames: this.options.detachedWorkerRedactedEnvNames }
            : {}),
        });
        const launchPayload: Record<string, unknown> = {};
        if (launched.pid) launchPayload.pid = launched.pid;
        if (launched.supervisor) launchPayload.worker_supervisor = launched.supervisor;
        if (launched.systemdUnit) launchPayload.systemd_unit = launched.systemdUnit;
        if (launched.cgroup) launchPayload.cgroup = launched.cgroup;
        // POL-2044: persist the systemd→direct fallback fact so restart-safety
        // diagnosis reads the launch evidence instead of scraping worker stderr.
        if (launched.supervisorFallbackReason) {
          launchPayload.worker_supervisor_fallback = launched.supervisorFallbackReason;
        }
        await this.store.appendEvent(
          intent.run_id,
          buildServiceEvent(this.deps.now, intent.run_id, "launch_dispatched", "Spawned detached run worker.", launchPayload),
        );
        const registered = await this.waitForExecutionRegistration(intent.run_id, {
          ...(provenance ? { provenance } : {}),
          dispatchAttempt: record.launch.dispatch_attempts,
        });
        this.totalServicedSinceStart += 1;
        if (provenance) {
          await this.appendMutationResult(
            intent.run_id,
            "launch_result",
            "Detached run launch observed a persisted worker dispatch.",
            provenance,
            { outcome: "completed", mode: "background", state: registered.state },
          );
        }
        return this.launchResult(registered);
      });
    } catch (error) {
      if (provenance) {
        await this.appendMutationResult(
          intent.run_id,
          "launch_result",
          "Run launch did not produce a complete dispatch observation.",
          provenance,
          { outcome: "indeterminate", error_code: "launch_incomplete" },
        );
      }
      throw error;
    }
  }

  async runInline(input: RunIntent, options: LaunchRunOptions = {}): Promise<RunLaunchResult> {
    const provenance = optionalApiProvenance(options.provenance);
    const preflightExisting = await this.store.readRunRecord(input.run_id);
    if (preflightExisting && hasLegacyExecutionBarrier(preflightExisting)) {
      throw new RunExecutionSettlementPendingError(input.run_id);
    }
    const handoff = await withSqliteMutex(
      this.store.paths(input.run_id).dispatchMutexPath,
      async () => {
        const existing = await this.store.readRunRecord(input.run_id);
        if (existing && hasLegacyExecutionBarrier(existing)) {
          throw new RunExecutionSettlementPendingError(input.run_id);
        }
        const admitted = await this.admitLaunch(input, "inline", provenance, options);
        await options.onAdmitted?.(admitted.record);
        let resolveOwnership!: (ownership: "acquired" | "contended") => void;
        let rejectOwnership!: (error: unknown) => void;
        const ownershipReady = new Promise<"acquired" | "contended">((resolve, reject) => {
          resolveOwnership = resolve;
          rejectOwnership = reject;
        });
        const execution = this.executeStoredRun(admitted.record.run_id, {
          ...(options.nextTurnInput ? { nextTurnInput: options.nextTurnInput } : {}),
          onOwnershipResolved: resolveOwnership,
          ...(options.onExecutionAdmitted
            ? { onExecutionAdmitted: options.onExecutionAdmitted }
            : {}),
        });
        void execution.catch(rejectOwnership);
        await ownershipReady;
        return { admitted, execution };
      },
    );
    const finalRecord = await handoff.execution;
    this.totalServicedSinceStart += 1;
    if (provenance) {
      await this.appendMutationResult(
        handoff.admitted.record.run_id,
        "launch_result",
        "Inline run launch returned an authoritative run state.",
        provenance,
        { outcome: "completed", mode: "foreground", state: finalRecord.state },
      );
    }
    return this.launchResult(finalRecord);
  }

  async launch(input: RunIntent, options: LaunchRunOptions = {}): Promise<RunLaunchResult> {
    return options.detached === false
      ? this.runInline(input, options)
      : this.submitDetached(input, options);
  }

  async executeStoredRun(runId: string, options: ExecuteStoredRunOptions = {}): Promise<RunRecord> {
    // A synthesized legacy admission predates current execution ownership.
    // Reading it is safe; acquiring the SQLite mutex is not, because a
    // concurrent reconciler would mistake that contention for a live current
    // owner and durably publish a false adoption.
    const preflightRecord = await this.store.readRunRecord(runId);
    if (!preflightRecord) throw new Error(`Run record not found for ${runId}.`);
    if (hasLegacyExecutionBarrier(preflightRecord)) {
      throw new RunExecutionSettlementPendingError(runId);
    }
    const result = await this.tryExecutionOwnership(
      runId,
      async () => {
        options.onOwnershipResolved?.("acquired");
        const ownedRecord = await this.store.readRunRecord(runId);
        if (!ownedRecord) throw new Error(`Run record not found for ${runId}.`);
        if (ownedRecord.state === "queued") {
          try {
            await this.withWorkloadAdmissionBoundary(async () => {
              await this.reconcileWorkloadAdmissionUnserialized();
              this.assertWorkloadAdmission(undefined);
            });
          } catch (error) {
            if (
              ownedRecord.launch.mode === "detached"
              && (
                error instanceof WorkloadAdmissionFencedError
                || error instanceof WorkloadAdmissionBusyError
              )
            ) {
              await this.publishExecutionAdmissionRefusal(ownedRecord, error);
            }
            throw error;
          }
          await options.onExecutionAdmitted?.(ownedRecord);
        }
        return this.executeStoredRunOwned(runId, options);
      },
    );
    if (result.owned) {
      return result.value;
    }
    options.onOwnershipResolved?.("contended");
    const current = await this.store.readRunRecord(runId);
    if (!current) throw new Error(`Run record not found for ${runId}.`);
    if (hasLegacyExecutionBarrier(current)) {
      throw new RunExecutionSettlementPendingError(runId);
    }
    assertRunRecordIdentity(runId, current);
    return current;
  }

  private async executeStoredRunOwned(runId: string, options: ExecuteStoredRunOptions): Promise<RunRecord> {
    const initialRecord = await this.store.readRunRecord(runId);
    if (!initialRecord) throw new Error(`Run record not found for ${runId}.`);
    if (hasLegacyExecutionBarrier(initialRecord)) {
      throw new RunExecutionSettlementPendingError(runId);
    }
    const initialIdentityMismatch = runRecordIdentityMismatch(runId, initialRecord);
    if (initialIdentityMismatch) {
      return this.classifyOwnerFreeRecord(
        initialRecord,
        `Run directory ${runId} contains mismatched record identity: ${initialIdentityMismatch}.`,
        undefined,
        runId,
      );
    }
    let record: RunRecord = initialRecord;
    if (isTerminalState(record.state)) return record;
    if (record.state !== "queued") {
      throw new Error(
        `Run ${runId} is owner-free in state ${record.state}; refusing to repeat an ambiguous execution effect.`,
      );
    }
    const intent = record.intent;
    let spec: ResolvedExecutionSpec | undefined;
    let onTerminate: (() => void) | undefined;
    let kernelTerminate: (() => void) | undefined;
    let terminationPending = false;
    let stopping = false;
    let effectAdmitted = false;
    let admittedHostProcessExecution: AdmittedHostProcessExecution | undefined;
    let effectAdmissionBaseRecord = record;
    let receiptAuthority: {
      receipt: ExecutionReceipt;
      spec: ResolvedExecutionSpec;
      integrations: IntegrationStatus;
    } | undefined;
    let cancellationPoll: NodeJS.Timeout | undefined;
    let cancellationReadInFlight = false;
    const kernel = this.deps.resolveExecutionKernel(intent);

    const finalizePreEffectCancellation = async (baseRecord: RunRecord = record): Promise<RunRecord> => {
      const cancelledAt = nowIso(this.deps.now);
      const cancelledRecord: RunRecord = {
        ...baseRecord,
        state: "cancelled",
        summary: `Run ${runId} was cancelled before execution began.`,
        updated_at: cancelledAt,
        completed_at: cancelledAt,
      };
      await this.store.writeRunRecord(runId, cancelledRecord);
      await this.ensureTerminalEvent(cancelledRecord, "launch", baseRecord.state);
      await this.store.appendEvent(
        runId,
        buildServiceEvent(
          this.deps.now,
          runId,
          "launch_completed",
          "Run cancellation became durable before the external execution effect.",
          { state: "cancelled", effect_started: false },
        ),
      );
      return cancelledRecord;
    };

    await this.store.appendEvent(
      runId,
      buildServiceEvent(this.deps.now, runId, "launch_started", "Starting stored run execution."),
    );

    try {
      // The durable cancellation marker is authoritative. This hook only
      // accelerates delivery when stop() runs in the same process.
      onTerminate = (): void => {
        if (stopping) return;
        stopping = true;
        if (kernelTerminate) kernelTerminate();
        else terminationPending = true;
      };
      this.inlineStopHandlers.set(runId, onTerminate);
      process.once("SIGTERM", onTerminate);
      process.once("SIGINT", onTerminate);
      const pollCancellation = async (): Promise<boolean> => {
        if (cancellationReadInFlight || stopping) return false;
        cancellationReadInFlight = true;
        try {
          const cancellation = await this.store.readCancellation(runId);
          if (cancellation) onTerminate?.();
          return Boolean(cancellation);
        } finally {
          cancellationReadInFlight = false;
        }
      };
      if (await pollCancellation()) {
        return await finalizePreEffectCancellation();
      }
      cancellationPoll = setInterval(() => void pollCancellation(), 50);
      spec = await kernel.resolveIntent(intent, {
        now: this.deps.now,
        ...(this.options.agentsInfraRoot ? { agentsInfraRoot: this.options.agentsInfraRoot } : {}),
      });
      assertAuthoritativeRunIdentity({ runId, intent, spec });
      await this.store.writeSpec(runId, spec);
      await this.store.appendEvent(
        runId,
        buildServiceEvent(this.deps.now, runId, "spec_persisted", "Persisted resolved run spec."),
      );
      record = {
        ...record,
        spec,
        updated_at: nowIso(this.deps.now),
      };
      await this.store.writeRunRecord(runId, record);
      effectAdmissionBaseRecord = record;

      const resolvedSpec = spec;
      const paths = this.store.paths(runId);
      let eventWriteChain = Promise.resolve();
      const deferredTerminalEvents: LifecycleEvent[] = [];
      const queueEventWrite = (writeOp: () => Promise<void>): void => {
        eventWriteChain = eventWriteChain.then(writeOp);
      };
      const preEffectCancellation = await withSqliteMutex(
        paths.effectAdmissionMutexPath,
        async () => {
          if (await this.store.readCancellation(runId)) {
            return finalizePreEffectCancellation(effectAdmissionBaseRecord);
          }
          if (await this.store.readKernelReceipt(runId)) {
            throw new Error(
              `Run ${runId} already has a durable kernel receipt; refusing to admit a new external execution effect.`,
            );
          }
          const executionStartedAt = nowIso(this.deps.now);
          const executionId = randomUUID();
          const hostProcessExecution = resolvedSpec.kernel === "host_process"
            ? admitHostProcessExecution(
                resolvedSpec as ResolvedHostProcessSpec,
                executionId,
                freezeHostProcessSpawnEnvironment(
                  (resolvedSpec as ResolvedHostProcessSpec).process.env,
                  process.env,
                  this.options.detachedWorkerRedactedEnvNames ?? [],
                ),
              )
            : undefined;
          const dispatchingRecord: RunRecord = {
            ...effectAdmissionBaseRecord,
            state: "dispatching",
            launch: {
              ...effectAdmissionBaseRecord.launch,
              stage: "executing",
              execution_id: executionId,
              execution_started_at: executionStartedAt,
              ...(hostProcessExecution
                ? { host_process_execution_binding: hostProcessExecution.binding }
                : {}),
            },
            summary: `Run ${runId} is dispatching on host ${intent.host}.`,
            updated_at: executionStartedAt,
          };
          await this.store.writeRunRecord(runId, dispatchingRecord);
          record = dispatchingRecord;
          admittedHostProcessExecution = hostProcessExecution;
          effectAdmitted = true;
          return undefined;
        },
        { acquireTimeoutMs: null },
      );
      if (preEffectCancellation) return preEffectCancellation;

      const executionId = record.launch.execution_id;
      if (!executionId) {
        throw new Error(`Run ${runId} effect admission did not publish an execution identity.`);
      }

      await kernel.executeResolvedSpec(spec, {
        intent,
        executionId,
        ...(admittedHostProcessExecution
          ? { hostProcessExecution: admittedHostProcessExecution }
          : {}),
        receiptPath: paths.kernelReceiptPath,
        defaultWorktreeBase: this.options.defaultWorktreeBase,
        ...(this.options.detachedWorkerRedactedEnvNames
          ? { serverOnlyEnvNames: this.options.detachedWorkerRedactedEnvNames }
          : {}),
        ...(this.options.agentsInfraRoot ? { agentsInfraRoot: this.options.agentsInfraRoot } : {}),
        discoverArtifacts: async (cwd: string) =>
          discoverArtifacts(cwd, resolvedSpec.required_artifacts, paths.kernelReceiptPath, this.deps.now),
        onEvent: (event): void => {
          if (
            event.event === "state_transition"
            && typeof event.to === "string"
            && isTerminalState(event.to)
          ) {
            // Kernel terminal events are receipt-derived authority. Alternate
            // kernels may emit their callback before they publish the typed
            // receipt, so hold the event until executeResolvedSpec returns.
            deferredTerminalEvents.push(event);
            return;
          }
          queueEventWrite(async () => {
            await this.store.appendEvent(runId, event);
            if (event.event === "state_transition" && typeof event.to === "string") {
              const updated = createRunningUpdate(
                record,
                event.to,
                nowIso(this.deps.now),
                resolvedSpec,
                event.infra_error_classification,
                event.message,
              );
              record = updated;
              await this.store.writeRunRecord(runId, updated);
            }
          });
        },
        onHealthUpdate: (health): void => {
          queueEventWrite(async () => {
            const updated = mergeRunHealth(record, health, resolvedSpec);
            record = updated;
            await this.store.writeRunRecord(runId, updated);
          });
        },
        onSessionCheckpoint: (checkpoint): void => {
          queueEventWrite(async () => {
            const updated = mergeRunSessionCheckpoint(record, checkpoint, resolvedSpec);
            if (updated === record) {
              return;
            }
            record = updated;
            await this.store.writeRunRecord(runId, updated);
          });
        },
        registerTerminationHook: (handler): void => {
          kernelTerminate = handler;
          if (terminationPending) handler();
        },
        ...(options.nextTurnInput ? { nextTurnInput: options.nextTurnInput } : {}),
      });

      const durableReceipt = await this.store.readKernelReceipt(runId);
      if (!durableReceipt) {
        throw new Error(`Run ${runId} kernel returned without publishing its typed receipt.`);
      }
      const kernelReceipt = durableReceipt;
      assertAuthoritativeRunIdentity({
        runId,
        intent,
        spec,
        receipt: kernelReceipt,
        launch: record.launch,
        admittedHostProcessBinding: record.launch.host_process_execution_binding,
      });
      const comparisonSpec = deriveReceiptComparisonSpec(spec, kernelReceipt);
      assertAuthoritativeRunIdentity({
        runId,
        intent,
        spec: comparisonSpec,
        receipt: kernelReceipt,
        launch: record.launch,
        admittedHostProcessBinding: record.launch.host_process_execution_binding,
      });
      const initialIntegrations = this.unknownIntegrationStatus();
      receiptAuthority = {
        receipt: kernelReceipt,
        spec,
        integrations: initialIntegrations,
      };

      await eventWriteChain;
      await this.store.writeIntegrations(runId, initialIntegrations);
      const receiptRecord = createRunRecordFromReceipt(
        intent,
        record.launch,
        spec,
        kernelReceipt,
        initialIntegrations,
        nowIso(this.deps.now),
        record.creation_provenance,
      );
      let projection = await this.persistReceiptDerivedRunRecord(receiptRecord);
      for (const event of deferredTerminalEvents) {
        if (event.run_id !== runId || event.to !== kernelReceipt.state) {
          throw new Error(
            `Kernel terminal event does not match durable receipt for ${runId}: event=${event.run_id}:${String(event.to)} receipt=${kernelReceipt.run_id}:${kernelReceipt.state}.`,
          );
        }
        await this.store.appendEvent(runId, event);
      }
      const integrations = await this.runSubscribers({
        run_dir: paths.runDir,
        intent,
        spec,
        kernel_receipt: kernelReceipt,
        run_record: receiptRecord,
      });
      receiptAuthority.integrations = integrations;

      const finalRecord = createRunRecordFromReceipt(
        intent,
        record.launch,
        spec,
        kernelReceipt,
        integrations,
        nowIso(this.deps.now),
        record.creation_provenance,
      );
      await this.store.writeIntegrations(runId, integrations);
      projection = await this.persistReceiptDerivedRunRecord(finalRecord);
      await this.observeReceiptDerivedFinalization(finalRecord, record.state, projection);
      this.inlineStopHandlers.delete(runId);
      return finalRecord;
    } catch (error) {
      if (!receiptAuthority && effectAdmitted && spec) {
        try {
          const durableReceipt = await this.store.readKernelReceipt(runId);
          if (durableReceipt) {
            const comparisonSpec = deriveReceiptComparisonSpec(spec, durableReceipt);
            assertAuthoritativeRunIdentity({
              runId,
              intent,
              spec: comparisonSpec,
              receipt: durableReceipt,
              launch: record.launch,
              admittedHostProcessBinding: record.launch.host_process_execution_binding,
            });
            receiptAuthority = {
              receipt: durableReceipt,
              spec,
              integrations: this.unknownIntegrationStatus(),
            };
          }
        } catch (receiptError) {
          // A missing, torn, or identity-invalid receipt cannot establish
          // outcome authority. The original execution failure remains the
          // classification input below.
          console.warn(
            `calyx run ${runId} could not recover receipt authority after kernel rejection`,
            receiptError instanceof Error ? receiptError.message : String(receiptError),
          );
        }
      }
      if (receiptAuthority) {
        const message = error instanceof Error ? error.message : String(error);
        let storedIntegrations: IntegrationStatus | undefined;
        try {
          storedIntegrations = await this.store.readIntegrations(runId);
        } catch {
          storedIntegrations = undefined;
        }
        const integrations = this.recoverIntegrationStatus(
          storedIntegrations ?? receiptAuthority.integrations,
        );
        try {
          await this.store.writeIntegrations(runId, integrations);
        } catch (integrationError) {
          console.warn(
            `calyx run ${runId} integration repair remains pending`,
            integrationError instanceof Error ? integrationError.message : String(integrationError),
          );
        }
        const finalRecord = createRunRecordFromReceipt(
          intent,
          record.launch,
          receiptAuthority.spec,
          receiptAuthority.receipt,
          integrations,
          nowIso(this.deps.now),
          record.creation_provenance,
        );
        const projection = await this.persistReceiptDerivedRunRecord(finalRecord);
        await this.observeReceiptDerivedFinalization(finalRecord, record.state, projection, message);
        this.inlineStopHandlers.delete(runId);
        return finalRecord;
      }
      const message = error instanceof Error ? error.message : String(error);
      const integrations = await this.recoverAndPersistIntegrationStatus(runId);
      const failedRecord = createErroredRunRecord(
        intent,
        effectAdmitted ? record.launch : effectAdmissionBaseRecord.launch,
        spec,
        message,
        nowIso(this.deps.now),
        "normal",
        record.creation_provenance,
        integrations,
      );
      if (!effectAdmitted) {
        const preEffectOutcome = await withSqliteMutex(
          this.store.paths(runId).effectAdmissionMutexPath,
          async () => {
            if (await this.store.readCancellation(runId)) {
              return finalizePreEffectCancellation(effectAdmissionBaseRecord);
            }
            await this.store.writeRunRecord(runId, failedRecord);
            return failedRecord;
          },
          { acquireTimeoutMs: null },
        );
        if (preEffectOutcome.state === "cancelled") return preEffectOutcome;
      } else {
        await this.store.writeRunRecord(runId, failedRecord);
      }
      await this.ensureTerminalEvent(failedRecord, "launch", record.state);
      await this.store.appendEvent(
        runId,
        buildServiceEvent(this.deps.now, runId, "warning", message),
      );
      this.inlineStopHandlers.delete(runId);
      return failedRecord;
    } finally {
      if (cancellationPoll) clearInterval(cancellationPoll);
      this.inlineStopHandlers.delete(runId);
      if (onTerminate) {
        process.removeListener("SIGTERM", onTerminate);
        process.removeListener("SIGINT", onTerminate);
      }
    }
  }

  private async runSubscribers(context: RunSubscriberContext): Promise<IntegrationStatus> {
    const status = this.unknownIntegrationStatus();
    // This is the durable subscriber manifest and ambiguity boundary. It must
    // reach disk before the first subscriber effect begins, and each completed
    // result replaces its unknown slot before the next effect starts.
    await this.store.writeIntegrations(context.intent.run_id, status);
    for (const [index, subscriber] of this.subscribers.entries()) {
      const startedAt = Date.now();
      await this.store.appendEvent(
        context.intent.run_id,
        buildServiceEvent(this.deps.now, context.intent.run_id, "integration_started", `Running integration ${subscriber.name}.`),
      );
      try {
        const result = await subscriber.run(context);
        const enriched: IntegrationResult = {
          ...result,
          name: subscriber.name,
          critical: Boolean(subscriber.critical) || result.critical,
          duration_ms: result.duration_ms ?? (Date.now() - startedAt),
        };
        status.results[index] = enriched;
        status.all_critical_ok = status.results.every(
          (candidate) => !candidate.critical || candidate.status !== "failed",
        );
        await this.store.writeIntegrations(context.intent.run_id, status);
        await this.store.appendEvent(
          context.intent.run_id,
          buildServiceEvent(
            this.deps.now,
            context.intent.run_id,
            "integration_finished",
            `Integration ${subscriber.name} completed with status ${enriched.status}.`,
            {
              status: enriched.status,
            },
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status.results[index] = {
          name: subscriber.name,
          critical: Boolean(subscriber.critical),
          status: "failed",
          error: message,
          duration_ms: Date.now() - startedAt,
        };
        status.all_critical_ok = status.results.every(
          (candidate) => !candidate.critical || candidate.status !== "failed",
        );
        await this.store.writeIntegrations(context.intent.run_id, status);
        await this.store.appendEvent(
          context.intent.run_id,
          buildServiceEvent(
            this.deps.now,
            context.intent.run_id,
            "integration_finished",
            `Integration ${subscriber.name} failed.`,
            { error: message },
          ),
        );
      }
    }
    return status;
  }

  async getRunRecord(runId: string): Promise<RunRecord | undefined> {
    const record = await this.store.readRunRecord(runId);
    if (!record) return undefined;
    assertRunRecordIdentity(runId, record);
    return normalizeInfraErrorForRecord(record);
  }

  /**
   * Prove that a terminal record may release or mutate run-owned resources.
   * This is deliberately stronger than receipt observation: synthesized
   * legacy records require the same bound receipt authority used by
   * reconciliation, and bare host-process 1.0 receipts never qualify.
   */
  async getResourceTerminalAuthority(
    runId: string,
  ): Promise<RunResourceTerminalAuthority | undefined> {
    try {
      const record = await this.store.readRunRecord(runId);
      if (!record || !isTerminalState(record.state)) return undefined;
      assertRunRecordIdentity(runId, record);
      if (hasLegacyResourceSettlement(record) && isRunResourceTerminal(record)) {
        return {
          schema_version: "calyx.run-resource-terminal-authority/v1",
          run_id: record.run_id,
          source: "legacy_resource_settlement",
        };
      }
      if (
        record.kernel_receipt
        && "kernel" in record.kernel_receipt
        && record.kernel_receipt.kernel === "host_process"
        && !isBoundHostProcessReceipt(record.kernel_receipt)
      ) {
        return undefined;
      }
      if (isRunResourceTerminal(record)) {
        return {
          schema_version: "calyx.run-resource-terminal-authority/v1",
          run_id: record.run_id,
          source: "current_record",
        };
      }
      if (!hasSynthesizedLegacyAdmission(record)) return undefined;
      const authority = await this.readOwnerFreeReceiptAuthority(record);
      const valid = Boolean(
        authority
        && record.kernel_receipt
        && authority.receipt.state === record.state
        && isDeepStrictEqual(record.kernel_receipt, authority.receipt)
        && isRunResourceTerminal(record, { validatedLegacyReceipt: true }),
      );
      return valid && authority
        ? {
            schema_version: "calyx.run-resource-terminal-authority/v1",
            run_id: record.run_id,
            source: "bound_receipt",
            receipt_schema_version: authority.receipt.schema_version,
          }
        : undefined;
    } catch {
      return undefined;
    }
  }

  async getKernelReceipt(runId: string): Promise<ExecutionReceipt | undefined> {
    const receipt = await this.store.readKernelReceipt(runId);
    if (receipt) {
      assertObservedReceiptIdentity(runId, receipt);
      const record = await this.store.readRunRecord(runId);
      const storedSpec = await this.store.readSpec(runId);
      const spec = storedSpec ?? record?.spec;
      const legacyHostReceipt = "kernel" in receipt
        && receipt.kernel === "host_process"
        && !isBoundHostProcessReceipt(receipt);
      if (legacyHostReceipt) {
        if (
          !record
          || !storedSpec
          || !legacyHostTerminalObservationIsCoherent(record, storedSpec, receipt)
        ) {
          throw new Error(LEGACY_HOST_RECEIPT_AUTHORITY_REASON);
        }
      } else if (spec) {
        assertExecutionReceiptShape(runId, spec, receipt);
        assertExecutionReceiptCorrespondence(
          runId,
          spec,
          receipt,
          record?.launch.host_process_execution_binding,
        );
        assertReceiptTimingCorrespondence(runId, receipt, record?.launch);
      }
    }
    return receipt;
  }

  /** Bounded Caller A read model; this does not activate a coordinator loop. */
  async readIndependentReviewAdminProjection(
    instanceId: string,
    observedAt = this.deps.now(),
  ): Promise<IndependentReviewAdminProjection | undefined> {
    const state = this.options.reviewCoordinatorState;
    await applyStateMigrations({ ...(state ? { storeOptions: state } : {}) });
    const opened = await openStateStore(state ?? {});
    try {
      return readIndependentReviewAdminProjection(opened.db, instanceId, { now: observedAt });
    } finally {
      opened.db.close();
    }
  }

  /** Resolve leaf truth from RunService rather than accepting caller-authored run state. */
  async observeIndependentReviewRun(
    input: ObserveIndependentReviewRunOptions,
  ): Promise<ReturnType<typeof recordReviewerRunObservationFromRunService>> {
    const observedAt = this.deps.now();
    const projection = await this.readIndependentReviewAdminProjection(
      input.instance_id,
      observedAt,
    );
    if (!projection) throw new Error(`Independent review ${input.instance_id} was not found.`);
    const receipt = await this.getKernelReceipt(projection.attempt.reviewer_run_id);
    const record = await this.getRunRecord(projection.attempt.reviewer_run_id);
    if (receipt && !runReceiptSchema.safeParse(receipt).success) {
      throw new Error(
        `Reviewer run ${projection.attempt.reviewer_run_id} has a malformed kernel receipt.`,
      );
    }
    if (
      receipt
      && (
        !isTerminalState(receipt.state)
        || !record
        || record.state !== receipt.state
        || !record.kernel_receipt
        || !isDeepStrictEqual(record.kernel_receipt, receipt)
      )
    ) {
      throw new Error(
        `RunService cannot establish authoritative terminal receipt state for reviewer run ${projection.attempt.reviewer_run_id}.`,
      );
    }
    const runState = receipt?.state ?? record?.state;
    if (!runState || (isTerminalState(runState) && !receipt)) {
      throw new Error(
        `RunService cannot establish authoritative state for reviewer run ${projection.attempt.reviewer_run_id}.`,
      );
    }
    const state = this.options.reviewCoordinatorState;
    const opened = await openStateStore(state ?? {});
    try {
      return recordReviewerRunObservationFromRunService(opened.db, {
        instance_id: input.instance_id,
        observation_id: input.observation_id,
        reviewer_run_id: projection.attempt.reviewer_run_id,
        run_state: runState,
        observed_at: observedAt,
      });
    } finally {
      opened.db.close();
    }
  }

  /**
   * Resolve the durable terminal receipt and bounded findings bytes, mint the
   * correspondence receipt, then enter Caller A through its internal writer.
   */
  async recordIndependentReviewEvidence(
    input: RecordIndependentReviewEvidenceOptions,
  ): Promise<ReturnType<typeof recordIndependentReviewEvidenceFromRunService>> {
    const recordedAt = this.deps.now();
    const projection = await this.readIndependentReviewAdminProjection(
      input.instance_id,
      recordedAt,
    );
    if (!projection) throw new Error(`Independent review ${input.instance_id} was not found.`);
    const receipt = await this.getKernelReceipt(projection.attempt.reviewer_run_id);
    const record = await this.getRunRecord(projection.attempt.reviewer_run_id);
    if (!receipt || !("artifacts" in receipt)) {
      throw new Error(
        `Reviewer run ${projection.attempt.reviewer_run_id} has no authoritative kernel receipt.`,
      );
    }
    if (!runReceiptSchema.safeParse(receipt).success) {
      throw new Error(
        `Reviewer run ${projection.attempt.reviewer_run_id} has a malformed kernel receipt.`,
      );
    }
    if (
      !record
      || record.state !== "succeeded"
      || !record.kernel_receipt
      || !isDeepStrictEqual(record.kernel_receipt, receipt)
    ) {
      throw new Error(
        `RunService cannot establish authoritative terminal receipt state for reviewer run ${projection.attempt.reviewer_run_id}.`,
      );
    }
    if (!record.intent.issue?.trim()) {
      throw new Error(
        `Reviewer run ${projection.attempt.reviewer_run_id} has no immutable issue correspondence for publication.`,
      );
    }
    const publisherIdentities = this.options.reviewCoordinatorPublisherIdentities;
    if (!publisherIdentities) {
      throw new Error(
        "Independent review publication identities are not configured on this daemon.",
      );
    }
    const required = receipt.artifacts.required.filter(
      (artifact) => artifact.name === "findings.json",
    );
    if (required.length !== 1) {
      throw new Error(
        `Reviewer run ${projection.attempt.reviewer_run_id} did not record exactly one required findings.json.`,
      );
    }
    const source = await readBoundedReviewEvidenceSource(required[0]!.path);
    const resolved = mintReviewRunEvidence({
      receipt,
      reviewerAttemptId: projection.attempt.attempt_id,
      source,
      // Evidence identity must survive retries at a later RunService clock.
      // The validated terminal receipt is immutable; the DB transition time is not.
      issuedAt: receipt.timing.completed_at,
    });
    const state = this.options.reviewCoordinatorState;
    const opened = await openStateStore(state ?? {});
    try {
      return recordIndependentReviewEvidenceFromRunService(opened.db, {
        instance_id: input.instance_id,
        artifact: resolved.artifact,
        evidence_receipt: resolved.evidenceReceipt,
        reviewer_run_issue: record.intent.issue,
        publisher_identities: publisherIdentities,
        recorded_at: recordedAt,
      });
    } finally {
      opened.db.close();
    }
  }

  async listRuns(options: { limit?: number } = {}): Promise<Awaited<ReturnType<RunStore["listRuns"]>>> {
    const runs = [...await this.store.listRuns()].sort(compareRunListEntries);
    return applyRunListLimit(runs, options.limit);
  }

  async listRunsPage(options: Parameters<RunStore["listRunsPage"]>[0]): Promise<RunListEntry[]> {
    return this.store.listRunsPage(options);
  }

  async listRunsSnapshotPage(
    options: Parameters<RunStore["listRunsSnapshotPage"]>[0],
  ): ReturnType<RunStore["listRunsSnapshotPage"]> {
    return this.store.listRunsSnapshotPage(options);
  }

  async listActivity(options: {
    includeInteractive?: boolean;
    /** Requested host filter. Bound separately from observationHost by server projections. */
    host?: string;
    /** Host identity pinned by the observing daemon. */
    observationHost?: string;
    agentKind?: InteractiveSessionBackend;
    sinceMs?: number;
    limit?: number;
  } = {}): Promise<RunActivityEntry[]> {
    const requestedHost = options.host;
    const observationHost = options.observationHost ?? currentHost(this.deps);
    const runs: RunActivityEntry[] = (await this.listRuns())
      .filter((entry) => !requestedHost || normalizeHost(entry.host ?? "") === normalizeHost(requestedHost))
      .filter((entry) => !options.agentKind || entry.backend === options.agentKind)
      .map((entry) => ({
        entry_kind: "calyx_run",
        ...entry,
      }));
    if (!options.includeInteractive) {
      return applyActivityLimit(runs, options.limit);
    }

    const interactive = requestedHost && normalizeHost(requestedHost) !== normalizeHost(observationHost)
      ? []
      : await listInteractiveSessions({
        ...this.activityReadOptions(observationHost),
        // Canonical Calyx runs already come from the typed run index above.
        // The transcript projection is for unmanaged interactive sessions only.
        includeCalyxRuns: false,
        ...(options.agentKind ? { kinds: [options.agentKind] } : {}),
        ...(typeof options.sinceMs === "number" ? { sinceMs: options.sinceMs } : {}),
        ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
      });
    return applyActivityLimit([...runs, ...interactive].sort(compareActivityEntries), options.limit);
  }

  async listActivityPage(options: {
    includeInteractive: boolean;
    /** Requested host filter. */
    host?: string;
    /** Host identity pinned by the observing daemon. */
    observationHost?: string;
    agentKind?: InteractiveSessionBackend;
    createdSince?: string;
    createdBefore?: string;
    after?: {
      created_at: string;
      run_id: string;
      entry_kind: RunActivityEntry["entry_kind"];
    };
    limit: number;
  }): Promise<RunActivityEntry[]> {
    return (await this.listActivitySnapshotPage(options)).entries;
  }

  async listActivitySnapshotPage(options: {
    includeInteractive: boolean;
    /** Requested host filter. */
    host?: string;
    /** Host identity pinned by the observing daemon. */
    observationHost?: string;
    agentKind?: InteractiveSessionBackend;
    createdSince?: string;
    createdBefore?: string;
    after?: {
      created_at: string;
      run_id: string;
      entry_kind: RunActivityEntry["entry_kind"];
    };
    expectedMembershipFence?: string;
    limit: number;
  }): Promise<{ entries: RunActivityEntry[]; membershipFence: string }> {
    const expectedFence = decodeActivityListMembershipFence(options.expectedMembershipFence);
    const managedPage = await this.listRunsSnapshotPage({
      ...(options.host ? { host: options.host } : {}),
      ...(options.agentKind ? { backend: options.agentKind } : {}),
      ...(options.createdSince ? { created_since: options.createdSince } : {}),
      ...(options.createdBefore ? { created_before: options.createdBefore } : {}),
      ...(options.after ? { after: options.after } : {}),
      ...(expectedFence ? { expected_membership_fence: expectedFence.managed } : {}),
      limit: options.limit,
    });
    const runs: RunActivityEntry[] = managedPage.entries
      .map((entry) => ({ entry_kind: "calyx_run" as const, ...entry }));
    if (!options.includeInteractive) {
      return { entries: runs, membershipFence: managedPage.membershipFence };
    }
    const observationHost = options.observationHost ?? currentHost(this.deps);
    if (options.host && normalizeHost(options.host) !== normalizeHost(observationHost)) {
      const interactiveFence = "remote-host-excluded";
      if (expectedFence && expectedFence.interactive !== interactiveFence) {
        throw new RunListSnapshotChangedError();
      }
      return {
        entries: runs,
        membershipFence: encodeActivityListMembershipFence({
          v: 1,
          managed: managedPage.membershipFence,
          interactive: interactiveFence,
        }),
      };
    }
    const interactivePage = await listInteractiveSessionsSnapshotPage({
      ...this.activityReadOptions(observationHost),
      // Keep the two list sources disjoint: managed runs are projected above.
      includeCalyxRuns: false,
      ...(options.agentKind ? { kinds: [options.agentKind] } : {}),
      ...(options.createdSince ? { createdSince: options.createdSince } : {}),
      ...(options.createdBefore ? { createdBefore: options.createdBefore } : {}),
      ...(options.after ? { after: options.after } : {}),
      ...(expectedFence
        ? { expectedMembershipFingerprint: expectedFence.interactive }
        : {}),
      ...(this.options.interactivePageCandidateLimit !== undefined
        ? {
            candidateLimit: Math.min(
              Math.max(this.options.interactivePageCandidateLimit, 0),
              DEFAULT_INTERACTIVE_PAGE_CANDIDATE_LIMIT,
            ),
          }
        : {}),
      ...(this.options.interactiveIdentityMaxBytes !== undefined
        ? { identityMaxBytes: this.options.interactiveIdentityMaxBytes }
        : {}),
      limit: options.limit,
    }).catch((error: unknown) => {
      if (
        error instanceof InteractiveActivityProjectionNotReadyError
        && error.details.reason === "snapshot_drift"
      ) {
        throw new RunListSnapshotChangedError();
      }
      throw error;
    });
    return {
      entries: [...runs, ...interactivePage.entries]
        .sort(compareActivityPageEntries)
        .slice(0, options.limit),
      membershipFence: encodeActivityListMembershipFence({
        v: 1,
        managed: managedPage.membershipFence,
        interactive: interactivePage.membershipFingerprint,
      }),
    };
  }

  async interactiveSessionSummary(options: {
    host?: string;
    windowMs?: number;
  } = {}): Promise<InteractiveSessionSummary> {
    return summarizeInteractiveSessions({
      ...this.activityReadOptions(options.host),
      sinceMs: options.windowMs ?? DEFAULT_INTERACTIVE_ACTIVITY_LOOKBACK_MS,
    });
  }

  async inspectInteractiveSession(options: {
    activityId: string;
    host?: string;
    around?: string;
    tail?: number;
    context?: number;
    includeTools?: boolean;
  }): Promise<InteractiveSessionInspectResult> {
    return inspectInteractiveSession({
      ...this.activityReadOptions(options.host),
      activityId: options.activityId,
      ...(options.around ? { around: options.around } : {}),
      ...(typeof options.tail === "number" ? { tail: options.tail } : {}),
      ...(typeof options.context === "number" ? { context: options.context } : {}),
      ...(typeof options.includeTools === "boolean" ? { includeTools: options.includeTools } : {}),
    });
  }

  /** Resolve a consumer-visible interactive work locator through the bounded identity scan. */
  async resolveInteractiveSession(options: {
    activityId: string;
    host?: string;
  }): Promise<ResolvedInteractiveActivity> {
    if (options.activityId.trim().startsWith("run:")) {
      throw new ActivityIdNotFoundError(options.activityId);
    }
    return resolveInteractiveActivity({
      ...this.activityReadOptions(options.host),
      activityId: options.activityId,
      ...(this.options.interactivePageCandidateLimit !== undefined
        ? {
            candidateLimit: Math.min(
              Math.max(this.options.interactivePageCandidateLimit, 0),
              DEFAULT_INTERACTIVE_PAGE_CANDIDATE_LIMIT,
            ),
          }
        : {}),
      ...(this.options.interactiveIdentityMaxBytes !== undefined
        ? { identityMaxBytes: this.options.interactiveIdentityMaxBytes }
        : {}),
    });
  }

  /**
   * Compute recall-index freshness for a resolved transcript source (POL-1838).
   * Best-effort: any failure to open or read the state store degrades to
   * `store_state: "unavailable"` rather than failing the read. Returns
   * `undefined` only when freshness annotation is explicitly disabled.
   */
  private async computeRecallFreshness(sessionPath: string): Promise<ActivityRecallFreshness | undefined> {
    if (this.options.activityRecall?.enabled === false) return undefined;
    const unavailable: ActivityRecallFreshness = {
      schema_version: "activity.recall-freshness/v1",
      store_state: "unavailable",
      fully_indexed: false,
      pending_bytes: 0,
      store_message_count: 0,
      classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
      classifier_current: false,
    };
    let opened: Awaited<ReturnType<typeof openStateStore>>;
    try {
      opened = await openStateStore(this.options.activityRecall?.state ?? {});
    } catch {
      return unavailable;
    }
    try {
      if (checkActivityIndexSchema(opened.db).status !== "ok") return unavailable;
      const lastRun = readLatestActivityIndexRun(opened.db);
      const cursor = readActivitySourceCursor(opened.db, sessionPath);
      if (!cursor) {
        return {
          schema_version: "activity.recall-freshness/v1",
          store_state: "absent",
          fully_indexed: false,
          pending_bytes: 0,
          store_message_count: 0,
          classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
          classifier_current: true,
          ...(lastRun?.indexed_through ? { indexed_through: lastRun.indexed_through } : {}),
          ...(lastRun?.finished_at ? { last_index_run_at: lastRun.finished_at } : {}),
        };
      }
      let size = cursor.size_bytes ?? cursor.byte_offset;
      try {
        size = (await stat(sessionPath)).size;
      } catch {
        /* keep last-observed size */
      }
      const pendingBytes = Math.max(0, size - cursor.byte_offset);
      const classifierCurrent = cursor.classifier_version === ACTIVITY_MESSAGE_CLASSIFIER_VERSION;
      const reconciliationBlocked =
        cursor.content_hash === ACTIVITY_RECALL_STORE_BLOCKED_RECONCILIATION;
      const fullyIndexed = pendingBytes === 0 && classifierCurrent && !reconciliationBlocked;
      return {
        schema_version: "activity.recall-freshness/v1",
        store_state: fullyIndexed ? "fresh" : "behind",
        fully_indexed: fullyIndexed,
        pending_bytes: pendingBytes,
        store_message_count: cursor.message_count,
        classifier_version: cursor.classifier_version,
        classifier_current: classifierCurrent,
        ...(lastRun?.indexed_through ? { indexed_through: lastRun.indexed_through } : {}),
        ...(lastRun?.finished_at ? { last_index_run_at: lastRun.finished_at } : {}),
      };
    } catch {
      return unavailable;
    } finally {
      opened.db.close();
    }
  }

  private async resolveActivityForRecallRead(options: {
    activityId?: string;
    host?: string;
    latestSession?: boolean;
    latestSessionBackend?: InteractiveSessionBackend;
  }): Promise<ResolvedInteractiveActivity> {
    return resolveInteractiveActivity({
      ...this.activityReadOptions(options.host),
      ...(options.activityId ? { activityId: options.activityId } : {}),
      ...(options.latestSession ? { latestSession: true } : {}),
      ...(options.latestSessionBackend ? { latestSessionBackend: options.latestSessionBackend } : {}),
      runActivityResolver: this.runActivityResolver(),
    });
  }

  private async resolveLocalCanonicalMarkActivity(
    activityId: string,
  ): Promise<ResolvedInteractiveActivity> {
    if (!isCanonicalMarkableActivityId(activityId)) {
      throw new ActivityMarkTargetNotFoundError();
    }
    const resolved = await this.resolveActivityForRecallRead({ activityId });
    const localHost = currentHost(this.deps);
    if (
      resolved.host
      && normalizeHost(resolved.host) !== "local"
      && normalizeHost(resolved.host) !== localHost
    ) {
      throw new ActivityMarkTargetNotFoundError();
    }

    if (activityId.startsWith("run:")) {
      const resolution = resolved.runActivityResolution;
      if (resolution?.handle !== activityId) {
        throw new ActivityMarkTargetNotFoundError();
      }
      const record = await this.store.readRunRecord(resolution.run_id);
      if (!record || !isLocalRunTarget(record.intent.host, this.deps)) {
        throw new ActivityMarkTargetNotFoundError();
      }
      const exactSources = await listInteractiveSessionIdentities({
        ...this.activityReadOptions(),
        kinds: [resolution.backend],
      });
      const exactPaths = new Set(
        exactSources
          .filter((source) => source.run_id === resolution.activity_id)
          .map((source) => path.resolve(source.session_path)),
      );
      exactPaths.add(path.resolve(resolved.session_path));
      if (exactPaths.size > 1) {
        throw new ActivityMarkTargetAmbiguousError();
      }
      return resolved;
    }

    if (resolved.runActivityResolution || resolved.run_id !== activityId) {
      throw new ActivityMarkTargetNotFoundError();
    }
    const exactSources = await listInteractiveSessionIdentities({
      ...this.activityReadOptions(),
      kinds: [resolved.backend],
    });
    if (exactSources.filter((source) => source.run_id === activityId).length > 1) {
      throw new ActivityMarkTargetAmbiguousError();
    }
    return resolved;
  }

  /**
   * Admit one canonical, host-local target from the consumer activity
   * projection. Callers invoke this only for fresh mark creation; committed
   * idempotency replays return their original receipt before revalidation.
   */
  async resolveMarkableActivityTarget(
    options: ResolveMarkableActivityTargetOptions,
  ): Promise<ResolvedMarkableActivityTarget> {
    try {
      if (options.targetKind === "activity") {
        await this.resolveLocalCanonicalMarkActivity(options.targetId);
        return {
          target_kind: "activity",
          target_id: options.targetId,
          activity_id: options.targetId,
        };
      }

      if (options.targetKind === "message") {
        const parsed = parseActivityMessageId(options.targetId);
        await this.resolveLocalCanonicalMarkActivity(parsed.activityId);
        const source = await this.inspectActivityMessages({
          activityId: parsed.activityId,
          consumerVisibleOnly: true,
          selector: {
            around_id: options.targetId,
            context: 0,
            summary_only: true,
          },
        });
        if (source.messages.length !== 1 || source.messages[0]?.id !== options.targetId) {
          throw new ActivityMarkTargetNotFoundError();
        }
        return {
          target_kind: "message",
          target_id: options.targetId,
          activity_id: parsed.activityId,
          source_line: parsed.sourceLine,
        };
      }

      if (options.targetKind === "turn") {
        const parsed = parseActivityTurnId(options.targetId);
        await this.resolveLocalCanonicalMarkActivity(parsed.activityId);
        const source = await this.inspectActivityTurns({
          activityId: parsed.activityId,
          consumerVisibleOnly: true,
          selector: {
            first: parsed.sourceLine,
            summary_only: true,
          },
        });
        if (!source.turns.some((turn) => turn.turn_id === options.targetId)) {
          throw new ActivityMarkTargetNotFoundError();
        }
        return {
          target_kind: "turn",
          target_id: options.targetId,
          activity_id: parsed.activityId,
          source_line: parsed.sourceLine,
        };
      }

      throw new ActivityMarkTargetNotFoundError();
    } catch (error) {
      if (
        error instanceof InteractiveActivityProjectionNotReadyError
        && error.details.reason === "identity_collision"
      ) {
        throw new ActivityMarkTargetAmbiguousError();
      }
      if (isMarkTargetResolutionMiss(error)) {
        throw new ActivityMarkTargetNotFoundError();
      }
      if (isMarkTargetSourceUnavailable(error)) {
        throw new ActivityMarkTargetUnavailableError();
      }
      throw error;
    }
  }

  private async readFreshActivityProjection(
    session: ResolvedInteractiveActivity,
  ): Promise<{
    rows: ReturnType<typeof listActivityMessagesForActivity>;
    attachmentRows: ReturnType<typeof listActivityAttachmentsForMessageIds>;
    cursor: NonNullable<ReturnType<typeof readActivitySourceCursor>>;
  } | undefined> {
    if (this.options.activityRecall?.enabled === false) return undefined;
    let opened: Awaited<ReturnType<typeof openStateStore>>;
    try {
      opened = await openStateStore(this.options.activityRecall?.state ?? {});
    } catch {
      return undefined;
    }
    try {
      if (checkActivityIndexSchema(opened.db).status !== "ok") return undefined;
      const cursor = readActivitySourceCursor(opened.db, session.session_path);
      if (!cursor || cursor.classifier_version !== ACTIVITY_MESSAGE_CLASSIFIER_VERSION) {
        return undefined;
      }
      if (isActivityRecallStoreBlocked(cursor.content_hash)) {
        return undefined;
      }
      let size = cursor.size_bytes ?? cursor.byte_offset;
      try {
        size = (await stat(session.session_path)).size;
      } catch {
        /* keep last-observed size */
      }
      if (Math.max(0, size - cursor.byte_offset) !== 0) {
        return undefined;
      }
      const rows = listActivityMessagesForActivity(opened.db, session.run_id);
      if (rows.some((row) => (
        row.classifier_version !== ACTIVITY_MESSAGE_CLASSIFIER_VERSION
        || !row.payload_json
      ))) {
        return undefined;
      }
      const attachmentRows = listActivityAttachmentsForMessageIds(
        opened.db,
        rows.map((row) => row.message_id),
      );
      return { rows, attachmentRows, cursor };
    } catch {
      return undefined;
    } finally {
      opened.db.close();
    }
  }

  async inspectActivityMessages(options: {
    activityId?: string;
    host?: string;
    latestSession?: boolean;
    latestSessionBackend?: InteractiveSessionBackend;
    selector?: ActivityMessageSelectorInput;
    consumerVisibleOnly?: boolean;
  }): Promise<ActivityMessagesResult> {
    const resolved = await this.resolveActivityForRecallRead(options);
    const projection = await this.readFreshActivityProjection(resolved);
    if (projection) {
      const fromStore = inspectActivityMessagesFromStore({
        session: resolved,
        rows: projection.rows,
        attachmentRows: projection.attachmentRows,
        cursor: projection.cursor,
        ...(options.selector ? { selector: options.selector } : {}),
        ...(options.consumerVisibleOnly ? { consumerVisibleOnly: true } : {}),
        now: () => new Date(nowIso(this.deps.now)),
      });
      if (fromStore) {
        const recall = await this.computeRecallFreshness(fromStore.session_path);
        return recall ? { ...fromStore, recall_freshness: recall } : fromStore;
      }
    }
    const result = await inspectActivityMessages({
      ...this.activityReadOptions(options.host),
      ...(options.activityId ? { activityId: options.activityId } : {}),
      ...(options.latestSession ? { latestSession: true } : {}),
      ...(options.latestSessionBackend ? { latestSessionBackend: options.latestSessionBackend } : {}),
      ...(options.selector ? { selector: options.selector } : {}),
      ...(options.consumerVisibleOnly ? { consumerVisibleOnly: true } : {}),
      runActivityResolver: this.runActivityResolver(),
    });
    const recall = await this.computeRecallFreshness(result.session_path);
    return recall ? { ...result, recall_freshness: recall } : result;
  }

  async inspectActivityEvents(options: {
    activityId?: string;
    host?: string;
    latestSession?: boolean;
    latestSessionBackend?: InteractiveSessionBackend;
    selector?: ActivityEventSelectorInput;
  }): Promise<ActivityEventsResult> {
    return inspectActivityEvents({
      ...this.activityReadOptions(options.host),
      ...(options.activityId ? { activityId: options.activityId } : {}),
      ...(options.latestSession ? { latestSession: true } : {}),
      ...(options.latestSessionBackend ? { latestSessionBackend: options.latestSessionBackend } : {}),
      ...(options.selector ? { selector: options.selector } : {}),
      runActivityResolver: this.runActivityResolver(),
    });
  }

  async inspectActivityTurns(options: {
    activityId?: string;
    host?: string;
    latestSession?: boolean;
    latestSessionBackend?: InteractiveSessionBackend;
    selector?: ActivityTurnSelectorInput;
    consumerVisibleOnly?: boolean;
  }): Promise<ActivityTurnsResult> {
    const resolved = await this.resolveActivityForRecallRead(options);
    const projection = await this.readFreshActivityProjection(resolved);
    if (projection) {
      const fromStore = inspectActivityTurnsFromStore({
        session: resolved,
        rows: projection.rows,
        attachmentRows: projection.attachmentRows,
        cursor: projection.cursor,
        ...(options.selector ? { selector: options.selector } : {}),
        ...(options.consumerVisibleOnly ? { consumerVisibleOnly: true } : {}),
        now: () => new Date(nowIso(this.deps.now)),
      });
      if (fromStore) {
        const recall = await this.computeRecallFreshness(fromStore.session_path);
        return recall ? { ...fromStore, recall_freshness: recall } : fromStore;
      }
    }
    const result = await inspectActivityTurns({
      ...this.activityReadOptions(options.host),
      ...(options.activityId ? { activityId: options.activityId } : {}),
      ...(options.latestSession ? { latestSession: true } : {}),
      ...(options.latestSessionBackend ? { latestSessionBackend: options.latestSessionBackend } : {}),
      ...(options.selector ? { selector: options.selector } : {}),
      ...(options.consumerVisibleOnly ? { consumerVisibleOnly: true } : {}),
      runActivityResolver: this.runActivityResolver(),
    });
    const recall = await this.computeRecallFreshness(result.session_path);
    return recall ? { ...result, recall_freshness: recall } : result;
  }

  async inspectActivityText(options: {
    messageId: string;
    host?: string;
    selector?: ActivityTextSelectorInput;
    consumerVisibleOnly?: boolean;
  }): Promise<ActivityTextResult> {
    return inspectActivityText({
      ...this.activityReadOptions(options.host),
      messageId: options.messageId,
      ...(options.selector ? { selector: options.selector } : {}),
      ...(options.consumerVisibleOnly ? { consumerVisibleOnly: true } : {}),
      runActivityResolver: this.runActivityResolver(),
    });
  }

  async inspectActivityAttachments(options: {
    activityId: string;
    host?: string;
    selector?: ActivityAttachmentsSelectorInput;
    consumerVisibleOnly?: boolean;
  }): Promise<ActivityAttachmentsResult> {
    return inspectActivityAttachments({
      ...this.activityReadOptions(options.host),
      activityId: options.activityId,
      ...(options.selector ? { selector: options.selector } : {}),
      ...(options.consumerVisibleOnly ? { consumerVisibleOnly: true } : {}),
      runActivityResolver: this.runActivityResolver(),
    });
  }

  async inspectActivityAttachmentRecord(options: {
    activityId: string;
    ref: string;
    host?: string;
    servedByHost?: string;
    sourceTier?: InspectActivityAttachmentRecordOptions["sourceTier"];
  }): Promise<ActivityAttachmentRecordResult> {
    return inspectActivityAttachmentRecord({
      ...this.activityReadOptions(options.host),
      activityId: options.activityId,
      ref: options.ref,
      ...(options.servedByHost ? { servedByHost: options.servedByHost } : {}),
      ...(options.sourceTier ? { sourceTier: options.sourceTier } : {}),
      runActivityResolver: this.runActivityResolver(),
    });
  }

  async readActivityAttachmentBytes(options: {
    activityId: string;
    ref: string;
    host?: string;
    servedByHost?: string;
    sourceTier?: InspectActivityAttachmentRecordOptions["sourceTier"];
  }): Promise<ActivityAttachmentBytesResult> {
    return readActivityAttachmentBytes({
      ...this.activityReadOptions(options.host),
      activityId: options.activityId,
      ref: options.ref,
      ...(options.servedByHost ? { servedByHost: options.servedByHost } : {}),
      ...(options.sourceTier ? { sourceTier: options.sourceTier } : {}),
      runActivityResolver: this.runActivityResolver(),
    });
  }

  async readEvents(runId: string): Promise<RecordedRunEvent[]> {
    return this.store.readEvents(runId);
  }

  async readLogs(runId: string, options: ReadRunLogsOptions = {}): Promise<RunLogResult> {
    return readRunLogs(this.store, runId, options);
  }

  async observeRun(runId: string, options: ReadRunLogsOptions = {}): Promise<RunObservationResult> {
    await this.getRunRecord(runId);
    return observeRun(this.store, runId, {
      ...options,
      now: this.deps.now,
      collectHostResources: this.deps.collectHostResources,
      collectResourceAttribution: (rootPid) => this.deps.collectResourceAttribution(rootPid),
    });
  }

  async stop(runId: string, options: StopRunOptions = {}): Promise<RunCancellationResult> {
    const provenance = optionalApiProvenance(options.provenance);
    const initialRecord = await this.store.readRunRecord(runId);
    if (!initialRecord) throw new RunNotFoundError(runId);
    assertRunRecordIdentity(runId, initialRecord);
    const reason = options.reason?.trim() || undefined;
    if (provenance) {
      await this.appendMutationIntent(
        runId,
        "stop_intent",
        "Run stop intent persisted before durable cancellation admission.",
        provenance,
        { ...(reason ? { reason } : {}) },
      );
    }
    let admission:
      | { status: "cancellation_requested"; cancellation: RunCancellationRequest }
      | { status: "already_terminal" };
    try {
      admission = await withSqliteMutex(
        this.store.paths(runId).effectAdmissionMutexPath,
        async () => {
          const current = await this.store.readRunRecord(runId);
          if (!current) throw new RunNotFoundError(runId);
          assertRunRecordIdentity(runId, current);
          const existing = await this.store.readCancellation(runId);
          if (existing) return { status: "cancellation_requested" as const, cancellation: existing };
          if (isTerminalState(current.state)) return { status: "already_terminal" as const };
          const cancellation = await this.store.requestCancellation({
            schema_version: "calyx.run-cancellation/v1",
            run_id: runId,
            requested_at: nowIso(this.deps.now),
            ...(reason ? { reason } : {}),
            ...(provenance ? { provenance } : {}),
          });
          return { status: "cancellation_requested" as const, cancellation };
        },
        { acquireTimeoutMs: null },
      );
    } catch (error) {
      if (provenance) {
        await this.appendMutationResult(
          runId,
          "stop_result",
          "Run cancellation admission could not be proven complete.",
          provenance,
          {
            outcome: "indeterminate",
            status: "cancellation_admission_failed",
            error_code: "cancellation_admission_failed",
          },
        );
      }
      throw error;
    }
    if (admission.status === "already_terminal") {
      if (provenance) {
        await this.appendMutationResult(
          runId,
          "stop_result",
          "Run was already terminal before cancellation admission.",
          provenance,
          { outcome: "completed", status: "already_terminal" },
        );
      }
      return {
        schema_version: "calyx.run-cancellation-result/v1",
        status: "already_terminal",
        run_id: runId,
      };
    }
    const cancellation = admission.cancellation;

    const inlineStop = this.inlineStopHandlers.get(runId);
    if (inlineStop) {
      try {
        inlineStop();
      } catch (error) {
        // The durable marker is the cancellation authority. An acceleration
        // hook must never downgrade an admission that callers may safely retry.
        console.warn(
          `calyx run inline cancellation hook failed for ${runId}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    await this.appendPostEffectEvent(
      runId,
      buildServiceEvent(this.deps.now, runId, "warning", "Durable cancellation requested for run worker.", {
        requested_at: cancellation.requested_at,
        transport: inlineStop ? "durable_marker_and_inline_hook" : "durable_marker",
        ...(cancellation.reason ? { reason: cancellation.reason } : {}),
      }, provenance),
    );
    // A durable cancellation marker settles only when a live owner observes
    // it. If the run is post-dispatch and BOTH per-run mutexes are free, no
    // current-generation owner exists to observe the marker — settle now
    // through the targeted reconcile authority instead of leaving the run
    // active forever (POL-1897). Queued runs are excluded: their marker is
    // observed at effect admission, and reconcile's redispatch branch owns
    // their recovery. The free-mutex probe is only a gate: pre-mutex legacy
    // workers never hold these mutexes, so the owner-free claim is derived
    // from the reconcile OUTCOME, which defers possibly-live and untrusted
    // legacy evidence instead of overclaiming publisher extinction.
    let ownerFreeSettlement:
      | { worker_ownership: "owner_free"; settled_state: CalyxRunTerminalState }
      | undefined;
    const postAdmissionRecord = await this.store.readRunRecord(runId);
    const settlementEligible =
      postAdmissionRecord
      && !isTerminalState(postAdmissionRecord.state)
      && postAdmissionRecord.state !== "queued";
    if (settlementEligible) {
      const dispatchProbe = await this.tryDispatchOwnership(runId, async () => {
        const executionProbe = await this.tryExecutionOwnership(runId, async () => undefined);
        return executionProbe.owned;
      });
      if (dispatchProbe.owned && dispatchProbe.value) {
        const outcome = await this.reconcile({ scope: { runId }, ...(provenance ? { provenance } : {}) });
        const settledOwnerFree = outcome.classified.includes(runId)
          || outcome.rebuilt.includes(runId)
          || (outcome.repair_pending?.includes(runId) ?? false);
        const settled = settledOwnerFree ? await this.store.readRunRecord(runId) : undefined;
        if (settled && isCalyxTerminalState(settled.state)) {
          ownerFreeSettlement = {
            worker_ownership: "owner_free",
            settled_state: settled.state,
          };
        }
      }
    }
    if (provenance) {
      await this.appendMutationResult(
        runId,
        "stop_result",
        "Durable cancellation admission completed.",
        provenance,
        {
          outcome: "completed",
          status: "cancellation_requested",
          requested_at: cancellation.requested_at,
          transport: inlineStop ? "durable_marker_and_inline_hook" : "durable_marker",
          ...(ownerFreeSettlement ?? {}),
        },
      );
    }
    return {
      schema_version: "calyx.run-cancellation-result/v1",
      status: "cancellation_requested",
      run_id: runId,
      requested_at: cancellation.requested_at,
      ...(ownerFreeSettlement ?? {}),
    };
  }

  private legacyWorkerPidPath(runId: string): string {
    return path.join(this.store.paths(runId).runDir, LEGACY_WORKER_PID_FILENAME);
  }

  private async clearLegacyWorkerPidEvidence(runId: string): Promise<void> {
    await rm(this.legacyWorkerPidPath(runId), { force: true });
  }

  /**
   * Rolling-upgrade bridge for detached workers launched by origin/main before
   * execution mutexes existed. Those launches did not persist a process-start
   * token, so a historical PID can never prove process identity after restart.
   * The bridge therefore fails closed unless there was exactly one historical
   * launch. Wrapper extinction settles only the historical Calyx publisher;
   * inherited process-group extinction is tracked separately as lease-release
   * authority. Possibly-live or untrusted publisher evidence preserves the
   * nonterminal projection and is never adoption or readopt authority.
   */
  private async inspectLegacyDetachedWorker(
    runId: string,
    record: RunRecord,
  ): Promise<LegacyDetachedWorkerObservation> {
    if (!hasSynthesizedLegacyAdmission(record)) {
      return { status: "not_legacy" };
    }
    const kernelId = record.spec?.kernel ?? record.intent.kernel ?? "agent_runner";
    const events = await this.store.readEvents(runId);
    const launchEvents = events.filter(
      (event): event is RunServiceEvent => isRunServiceEvent(event) && event.event === "launch_dispatched",
    );
    const launchEvent = launchEvents.at(-1);
    const payload = asRecord(launchEvent?.payload);
    const historicalPid = payload?.["pid"];
    const supervisor = payload?.["worker_supervisor"];
    const systemdUnit = payload?.["systemd_unit"];
    const cgroup = payload?.["cgroup"];
    const exactLaunchEvidence = (
      kernelId === "agent_runner"
      && record.launch.mode === "detached"
      && record.launch.execution_id === undefined
      && record.launch.host_process_execution_binding === undefined
      && launchEvents.length === 1
      && record.launch.dispatch_attempts === launchEvents.length
      && launchEvent?.message === LEGACY_DETACHED_LAUNCH_MESSAGE
      && record.launch.last_dispatch_at === launchEvent.timestamp
      && typeof historicalPid === "number"
      && Number.isSafeInteger(historicalPid)
      && historicalPid > 0
      && payload !== undefined
      && Object.keys(payload).every((key) => LEGACY_DETACHED_LAUNCH_PAYLOAD_KEYS.has(key))
      && (supervisor === undefined || supervisor === "direct" || supervisor === "systemd")
      && (systemdUnit === undefined || (
        supervisor === "systemd"
        && typeof systemdUnit === "string"
        && systemdUnit.length > 0
      ))
      && (cgroup === undefined || (
        supervisor === "systemd"
        && typeof cgroup === "string"
        && cgroup.length > 0
      ))
    );
    if (!exactLaunchEvidence) {
      return { status: "untrusted" };
    }

    let rawPid: string;
    try {
      rawPid = await readFile(this.legacyWorkerPidPath(runId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      return { status: "untrusted" };
    }

    if (!/^[1-9][0-9]*\n?$/u.test(rawPid)) {
      return { status: "untrusted" };
    }
    const pid = Number(rawPid.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid !== historicalPid) {
      return { status: "untrusted" };
    }

    // Historical systemd launches require cgroup/unit extinction authority,
    // which this one-off direct-worker bridge deliberately does not invent.
    if (supervisor === "systemd") {
      return { status: "untrusted" };
    }

    const observation = await this.deps.observeLegacyWorkerPid(pid).catch(() => "untrusted" as const);
    if (observation === "possibly_live") {
      return { status: "possibly_live", pid };
    }
    if (observation !== "dead") return { status: "untrusted" };

    const processGroupObservation = await this.deps.observeLegacyWorkerProcessGroup(pid)
      .catch(() => "untrusted" as const);
    return {
      status: "publisher_dead",
      pid,
      process_group: processGroupObservation,
    };
  }

  private async refreshLegacyResourceSettlement(
    record: RunRecord,
    provenance?: ApiProvenanceV1,
  ): Promise<RunRecord> {
    if (!hasLegacyDeadSettlement(record) || hasLegacyResourceSettlement(record)) {
      return record;
    }
    const pending = legacyPendingResourceSettlement(record);
    if (!pending) return record;
    const observation = await this.deps.observeLegacyWorkerProcessGroup(
      pending.legacy_process_group_id,
    ).catch(() => "untrusted" as const);
    if (observation !== "dead") {
      await this.applyReconcileEffect(
        record.run_id,
        "legacy_resource_quarantine",
        provenance,
        () => this.quarantineLegacyRunWorktreeLeases(record, provenance),
      );
      return record;
    }

    let refreshed = record;
    await this.applyReconcileEffect(
      record.run_id,
      "legacy_resource_settlement",
      provenance,
      async () => {
        const current = await this.store.readRunRecord(record.run_id);
        if (!current || !hasLegacyDeadSettlement(current) || hasLegacyResourceSettlement(current)) {
          refreshed = current ?? record;
          return;
        }
        const currentPending = legacyPendingResourceSettlement(current);
        if (!currentPending || currentPending.legacy_process_group_id !== pending.legacy_process_group_id) {
          refreshed = current;
          return;
        }
        const settledAt = nowIso(this.deps.now);
        refreshed = {
          ...current,
          recovery: {
            ...current.recovery,
            resource_settlement: {
              schema_version: "calyx.resource-settlement/v1",
              status: "settled",
              authority: "legacy_process_group_extinct",
              authority_id: legacyResourceSettlementAuthorityId(
                current,
                currentPending.legacy_process_group_id,
              ),
              settled_at: settledAt,
              reason_code: "legacy_detached_process_group_observed_extinct",
              legacy_process_group_id: currentPending.legacy_process_group_id,
            },
          },
          updated_at: settledAt,
        };
        await this.store.writeRunRecord(record.run_id, refreshed);
      },
    );
    return refreshed;
  }

  private async quarantineLegacyRunWorktreeLeases(
    record: RunRecord,
    provenance?: ApiProvenanceV1,
  ): Promise<void> {
    if (this.options.leases?.enabled === false) return;
    const pending = legacyPendingResourceSettlement(record);
    const ownerSettlement = record.recovery.owner_free_settlement;
    if (!pending || !ownerSettlement) {
      throw new Error(`Run ${record.run_id} has no valid pending legacy resource settlement to fence.`);
    }
    await applyStateMigrations({ ...(this.options.leases?.state ? { storeOptions: this.options.leases.state } : {}) });
    const opened = await openStateStore(this.options.leases?.state ?? {});
    try {
      quarantineRunWorktreeLeases(opened.db, {
        run_id: record.run_id,
        owner_free_authority_id: ownerSettlement.authority_id,
        expected_resource_authority_id: legacyResourceSettlementAuthorityId(
          record,
          pending.legacy_process_group_id,
        ),
        legacy_process_group_id: pending.legacy_process_group_id,
        quarantined_at: pending.observed_at,
        ...(provenance ? { request_provenance: provenance } : {}),
      });
    } finally {
      opened.db.close();
    }
  }

  /**
   * POL-1897 (minimal honest posture): a current-generation owner-free
   * terminal settlement proves only that the Calyx publisher is gone — the
   * detached backend process group may still own the worktree
   * (packages/runner/src/adapters/spawn.ts records that a leader exit does
   * not prove group extinction). Fence the run's worktree leases with a typed
   * quarantine instead of releasing them through terminal lease GC; POL-1990
   * owns proving backend extinction and un-quarantining. The typed run event
   * appended below is the durable marker POL-1990 keys on.
   */
  private async quarantineOwnerFreeSettledRunWorktreeLeases(
    runId: string,
    provenance?: ApiProvenanceV1,
  ): Promise<void> {
    if (this.options.leases?.enabled === false) return;
    await applyStateMigrations({ ...(this.options.leases?.state ? { storeOptions: this.options.leases.state } : {}) });
    const opened = await openStateStore(this.options.leases?.state ?? {});
    let affectedLeaseKeys: string[];
    try {
      const quarantine = quarantineOwnerFreeRunWorktreeLeases(opened.db, {
        run_id: runId,
        quarantined_at: nowIso(this.deps.now),
        ...(provenance ? { request_provenance: provenance } : {}),
      });
      affectedLeaseKeys = [...new Set([
        ...quarantine.quarantined,
        ...quarantine.already_quarantined,
      ].map((lease) => lease.key))].sort();
    } finally {
      opened.db.close();
    }
    if (affectedLeaseKeys.length === 0) return;

    // SQLite quarantine and the run journal are separate durable stores. A
    // crash after the SQLite commit must be repairable: include already-
    // quarantined rows, then append only the lease keys not covered by an
    // existing typed marker. This also makes replay after a successful append
    // idempotent.
    const publishedLeaseKeys = new Set(
      (await this.store.readEvents(runId)).flatMap((event) => {
        if (!isRunServiceEvent(event) || event.event !== "reconciled") return [];
        const payload = asRecord(event.payload);
        if (
          payload?.["reconcile"] !== "owner_free_resource_quarantine"
          || payload["authority"] !== "owner_free_settlement_unproven_backend"
          || !Array.isArray(payload["lease_keys"])
        ) {
          return [];
        }
        return payload["lease_keys"].filter((key): key is string => typeof key === "string");
      }),
    );
    const unpublishedLeaseKeys = affectedLeaseKeys.filter((key) => !publishedLeaseKeys.has(key));
    if (unpublishedLeaseKeys.length === 0) return;
    await this.store.appendEvent(
      runId,
      buildServiceEvent(
        this.deps.now,
        runId,
        "reconciled",
        "Quarantined terminal worktree leases: owner-free settlement proves the publisher gone, not the detached backend process group.",
        {
          reconcile: "owner_free_resource_quarantine",
          authority: "owner_free_settlement_unproven_backend",
          lease_keys: unpublishedLeaseKeys,
        },
        provenance,
      ),
    );
  }

  private async hasLegacySettlementObservation(runId: string): Promise<boolean> {
    const events = await this.store.readEvents(runId);
    return events.some((event) => {
      if (!isRunServiceEvent(event) || event.event !== "reconciled") return false;
      const payload = asRecord(event.payload);
      return payload?.["reconcile"] === "legacy_settlement_pending"
        && payload["authority"] === "legacy_pid_observation";
    });
  }

  private async hasReconcileAdoptionEvent(runId: string, authority?: string): Promise<boolean> {
    const events = await this.store.readEvents(runId);
    return events.some(
      (event) => {
        if (!isRunServiceEvent(event) || event.event !== "reconciled") return false;
        const payload = asRecord(event.payload);
        return payload?.["reconcile"] === "adopted"
          && (authority === undefined || payload["authority"] === authority);
      },
    );
  }

  async reconcile(options: ReconcileRunOptions = {}): Promise<ReconcileResult> {
    // The public operation advertises fixed operation-identity retry. Queue the
    // complete pass across sibling RunService instances so a retry can never
    // classify the first attempt's held per-run mutexes as a converged result.
    return withSqliteMutex(
      this.store.reconcileMutexPath(),
      () => this.reconcilePass(options),
      { acquireTimeoutMs: null, queueInProcess: true },
    );
  }

  private async reconcilePass(options: ReconcileRunOptions): Promise<ReconcileResult> {
    const provenance = optionalApiProvenance(options.provenance);
    const scope = options.scope ?? "all";
    // Narrowed scopes settle their candidates through the same per-run
    // classification and lease authority as a full pass; only the estate
    // enumeration, the non-canonical directory sweep, and the full run-index
    // repair are reserved for scope "all" (POL-1897).
    const nonCanonicalDirectories = scope === "all"
      ? await this.store.inspectNonCanonicalRunDirectories()
      : [];
    const runIds = scope === "all"
      ? await this.store.listReconcileRunIds()
      : scope === "active"
        ? (await this.store.listActiveRuns()).map((entry) => entry.run_id).sort()
        : [scope.runId];
    const result: ReconcileResult = {
      scanned: runIds.length + nonCanonicalDirectories.length,
      rebuilt: [],
      repair_pending: [],
      classified: [],
      adopted: [],
      unresolved: [],
      skipped: [],
      noncanonical_directories: nonCanonicalDirectories,
      projection: { status: "not_configured" },
    };
    const terminalRunIds = new Set<string>();
    let projectionRepairBlockReason: string | undefined;
    const addUnresolved = (
      runId: string,
      reason: CalyxAdminReconcileUnresolvedReason,
    ): void => {
      if (!result.unresolved.some((entry) => entry.run_id === runId)) {
        result.unresolved.push({ run_id: runId, reason });
      }
    };
    const missingCanonicalRecordDisposition = (): UnresolvedReconcileDisposition => {
      return unresolvedReconcileDisposition(
        "unresolved",
        "canonical_run_record_missing",
      );
    };
    const addMissingCanonicalRecord = (runId: string): void => {
      const disposition = missingCanonicalRecordDisposition();
      addUnresolved(runId, disposition.unresolved_reason);
    };

    try {
      await this.store.assertGlobalEventIndexReadable();
    } catch (error) {
      if (!(error instanceof EventJournalCorruptionError)) throw error;
      result.skipped.push(...runIds);
      result.projection = {
        status: "failed",
        reason: `Global event replay is corrupt and was preserved in place: ${error.message}`,
      };
      await this.store.summarizeReconcile(result, {
        ...(provenance ? { provenance } : {}),
      });
      return result;
    }

    for (const runId of runIds) {
      try {
        try {
          await this.store.readEvents(runId);
        } catch (error) {
          if (!(error instanceof EventJournalCorruptionError)) throw error;
          const storedGeneration = await this.store.inspectStoredLaunchGeneration(runId);
          const storedRecord = "record" in storedGeneration ? storedGeneration.record : undefined;
          if (
            storedRecord
            && hasLegacySettlementMarker(storedRecord)
            && !hasLegacyDeadSettlement(storedRecord)
          ) {
            addUnresolved(runId, "legacy_owner_settlement_pending");
            projectionRepairBlockReason =
              "Run-index repair deferred because an invalid legacy settlement marker owns a corrupt event journal.";
            continue;
          }
          if (
            storedGeneration.status === "legacy"
            && (!storedGeneration.record || !hasLegacyDeadSettlement(storedGeneration.record))
          ) {
            // An unfenced historical publisher may still own both the journal
            // and its terminal receipt. Preserve the corrupt bytes in place;
            // quarantine is itself a competing publication effect.
            addUnresolved(runId, "legacy_publication_authority_unproven");
            projectionRepairBlockReason =
              "Run-index repair deferred because an unfenced legacy publisher owns a corrupt event journal.";
            continue;
          }
          const ownership = await this.tryExecutionOwnership(runId, async () => {
            const quarantinedPath = await this.store.quarantineEventJournal(runId);
            const damagedRecord = await this.store.readRunRecord(runId);
            if (!damagedRecord) {
              return missingCanonicalRecordDisposition();
            }
            if (hasLegacySettlementMarker(damagedRecord)) {
              if (!hasLegacyDeadSettlement(damagedRecord)) {
                return unresolvedReconcileDisposition(
                  "legacy_pending",
                  "legacy_owner_settlement_pending",
                );
              }
              const finalRecord = await this.refreshLegacyResourceSettlement(
                damagedRecord,
                provenance,
              );
              await this.applyReconcileEffect(
                runId,
                "legacy_settlement_finalization",
                provenance,
                async () => {
                  await this.ensureTerminalEvent(finalRecord, "reconcile");
                },
              );
              if (!hasLegacyResourceSettlement(finalRecord)) {
                return unresolvedReconcileDisposition(
                  "rebuilt",
                  "legacy_resource_settlement_pending",
                );
              }
              return "rebuilt" as const;
            }
            const receiptRecovery = await this.rebuildOwnerFreeRecordFromReceipt(
              damagedRecord,
              "reconcile",
              provenance,
              hasSynthesizedLegacyAdmission(damagedRecord)
                ? { invalidReceiptDisposition: "defer" }
                : {},
            );
            if (receiptRecovery.status !== "absent") return receiptRecovery.status;
            if (hasSynthesizedLegacyAdmission(damagedRecord)) {
              return unresolvedReconcileDisposition(
                "legacy_pending",
                "legacy_publication_authority_unproven",
              );
            }
            const message = `${error.message}; quarantined at ${quarantinedPath ?? "unknown"}.`;
            const integrations = await this.recoverAndPersistIntegrationStatus(runId);
            await this.applyReconcileEffect(runId, "event_journal_corruption_classification", provenance, async () => {
              await this.classifyOwnerFreeRecord(damagedRecord, message, integrations, runId);
            });
            return "classified" as const;
          });
          if (!ownership.owned) {
            if (storedRecord && hasLegacyExecutionBarrier(storedRecord)) {
              addUnresolved(
                runId,
                hasLegacySettlementMarker(storedRecord)
                  ? unresolvedLegacySettlementReason(storedRecord)
                  : "legacy_publication_authority_unproven",
              );
            }
            result.adopted.push(runId);
            projectionRepairBlockReason =
              "Run-index repair deferred because a live execution owner has a corrupt event journal.";
          } else {
            const disposition = ownership.value;
            const status = typeof disposition === "string" ? disposition : disposition.status;
            if (typeof disposition !== "string") {
              addUnresolved(runId, disposition.unresolved_reason);
            }
            if (status === "rebuilt") {
              result.rebuilt.push(runId);
              terminalRunIds.add(runId);
            } else if (status === "repair_pending") {
              result.repair_pending!.push(runId);
              terminalRunIds.add(runId);
            } else if (status === "unresolved") {
              // The typed unresolved disposition was recorded above.
            } else if (status === "legacy_pending") {
              result.skipped.push(runId);
            } else {
              result.classified.push(runId);
              terminalRunIds.add(runId);
            }
          }
          continue;
        }
        const initialRecord = await this.store.readRunRecord(runId);
        if (!initialRecord) {
          addMissingCanonicalRecord(runId);
          continue;
        }

        if (runRecordIdentityMismatch(runId, initialRecord)) {
          if (hasSynthesizedLegacyAdmission(initialRecord) || hasLegacySettlementMarker(initialRecord)) {
            addUnresolved(
              runId,
              hasLegacySettlementMarker(initialRecord)
                ? unresolvedLegacySettlementReason(initialRecord)
                : "legacy_publication_authority_unproven",
            );
            result.skipped.push(runId);
            projectionRepairBlockReason =
              "Run-index repair deferred because an unfenced legacy record or settlement marker has mismatched identity.";
            continue;
          }
          const malformedOwnership = await this.tryExecutionOwnership(runId, async () => {
            const current = await this.store.readRunRecord(runId);
            if (!current) return missingCanonicalRecordDisposition();
            if (hasLegacyExecutionBarrier(current)) {
              projectionRepairBlockReason =
                "Run-index repair deferred because an unfenced legacy record or settlement marker has mismatched identity.";
              return unresolvedReconcileDisposition(
                "legacy_pending",
                hasLegacySettlementMarker(current)
                  ? unresolvedLegacySettlementReason(current)
                  : "legacy_publication_authority_unproven",
              );
            }
            const mismatch = runRecordIdentityMismatch(runId, current);
            if (!mismatch) return "skipped" as const;
            const message = `Run directory ${runId} contains mismatched record identity: ${mismatch}.`;
            const integrations = await this.recoverAndPersistIntegrationStatus(runId);
            await this.applyReconcileEffect(runId, "record_identity_classification", provenance, async () => {
              await this.classifyOwnerFreeRecord(current, message, integrations, runId);
            });
            return "classified" as const;
          });
          if (!malformedOwnership.owned) {
            result.adopted.push(runId);
          } else if (
            (typeof malformedOwnership.value === "string"
              ? malformedOwnership.value
              : malformedOwnership.value.status) === "classified"
          ) {
            result.classified.push(runId);
            terminalRunIds.add(runId);
          } else {
            if (typeof malformedOwnership.value !== "string") {
              addUnresolved(runId, malformedOwnership.value.unresolved_reason);
            }
            result.skipped.push(runId);
          }
          continue;
        }

        if (hasLegacySettlementMarker(initialRecord) && !isTerminalState(initialRecord.state)) {
          addUnresolved(runId, unresolvedLegacySettlementReason(initialRecord));
          result.skipped.push(runId);
          projectionRepairBlockReason =
            "Run-index repair deferred because a nonterminal record carries a legacy settlement marker.";
          continue;
        }

        if (isTerminalState(initialRecord.state)) {
          const initialLegacyBarrierReason = hasLegacySettlementMarker(initialRecord)
            ? !hasLegacyDeadSettlement(initialRecord)
              ? "legacy_owner_settlement_pending" as const
              : !hasLegacyResourceSettlement(initialRecord)
                ? "legacy_resource_settlement_pending" as const
                : undefined
            : hasSynthesizedLegacyAdmission(initialRecord)
              ? "legacy_publication_authority_unproven" as const
              : undefined;
          const terminalOwnership = await this.tryExecutionOwnership(runId, async () => {
            const current = await this.store.readRunRecord(runId);
            if (!current) return missingCanonicalRecordDisposition();
            if (!isTerminalState(current.state)) {
              const currentLegacyBarrierReason = current && hasLegacyExecutionBarrier(current)
                ? hasLegacySettlementMarker(current)
                  ? unresolvedLegacySettlementReason(current)
                  : "legacy_publication_authority_unproven" as const
                : undefined;
              const unresolvedReason = currentLegacyBarrierReason ?? initialLegacyBarrierReason;
              return unresolvedReason
                ? unresolvedReconcileDisposition("legacy_pending", unresolvedReason)
                : "skipped" as const;
            }
            const legacyAdmission = hasSynthesizedLegacyAdmission(current);
            const preserveLegacySettlement = async (): Promise<
              "skipped" | UnresolvedReconcileDisposition
            > => {
              if (!hasLegacySettlementMarker(current)) {
                return unresolvedReconcileDisposition(
                  "legacy_pending",
                  "legacy_publication_authority_unproven",
                );
              }
              if (!hasLegacyDeadSettlement(current)) {
                return unresolvedReconcileDisposition(
                  "legacy_pending",
                  "legacy_owner_settlement_pending",
                );
              }
              const finalRecord = await this.refreshLegacyResourceSettlement(current, provenance);
              await this.applyReconcileEffect(
                runId,
                "legacy_settlement_finalization",
                provenance,
                async () => {
                  await this.ensureTerminalEvent(finalRecord, "reconcile");
                },
              );
              if (!hasLegacyResourceSettlement(finalRecord)) {
                return unresolvedReconcileDisposition(
                  "legacy_pending",
                  "legacy_resource_settlement_pending",
                );
              }
              return "skipped";
            };
            if (hasLegacySettlementMarker(current)) {
              return preserveLegacySettlement();
            }
            let durableReceipt: ExecutionReceipt | undefined;
            try {
              durableReceipt = await this.store.readKernelReceipt(runId);
            } catch (error) {
              if (legacyAdmission) return preserveLegacySettlement();
              const reason = `Terminal run record has no valid durable kernel receipt: ${error instanceof Error ? error.message : String(error)}`;
              const integrations = await this.recoverAndPersistIntegrationStatus(runId);
              await this.applyReconcileEffect(
                runId,
                "terminal_without_receipt_classification",
                provenance,
                async () => {
                  await this.classifyOwnerFreeRecord(current, reason, integrations);
                },
              );
              return "classified" as const;
            }
            if (!durableReceipt && legacyAdmission) {
              return preserveLegacySettlement();
            }
            if (!durableReceipt && current.launch.stage === "executing") {
              const reason = "Terminal run record was published before a matching typed kernel receipt became durable; outcome is indeterminate.";
              const integrations = await this.recoverAndPersistIntegrationStatus(runId);
              await this.applyReconcileEffect(
                runId,
                "terminal_without_receipt_classification",
                provenance,
                async () => {
                  await this.classifyOwnerFreeRecord(current, reason, integrations);
                },
              );
              return "classified" as const;
            }
            if (durableReceipt) {
              let authoritativeSpec: ResolvedExecutionSpec;
              try {
                const storedSpec = await this.store.readSpec(runId);
                const legacyHostReceipt = "kernel" in durableReceipt
                  && durableReceipt.kernel === "host_process"
                  && !isBoundHostProcessReceipt(durableReceipt)
                  ? durableReceipt
                  : undefined;
                if (legacyHostReceipt) {
                  if (
                    !storedSpec
                    || !legacyHostTerminalObservationIsCoherent(
                      current,
                      storedSpec,
                      legacyHostReceipt,
                    )
                  ) {
                    throw new Error(LEGACY_HOST_RECEIPT_AUTHORITY_REASON);
                  }
                  authoritativeSpec = storedSpec;
                } else {
                  const kernel = this.deps.resolveExecutionKernel(current.intent);
                  authoritativeSpec = storedSpec
                    ?? current.spec
                    ?? kernel.createRecoverySpec(current.intent, this.deps.now);
                  assertAuthoritativeRunIdentity({
                    runId,
                    intent: current.intent,
                    spec: authoritativeSpec,
                    receipt: durableReceipt,
                    launch: current.launch,
                    admittedHostProcessBinding: current.launch.host_process_execution_binding,
                  });
                }
              } catch (error) {
                if (legacyAdmission) return preserveLegacySettlement();
                const reason = `Terminal run record does not match its durable kernel receipt: ${error instanceof Error ? error.message : String(error)}`;
                const integrations = await this.recoverAndPersistIntegrationStatus(runId);
                await this.applyReconcileEffect(
                  runId,
                  "terminal_receipt_mismatch_classification",
                  provenance,
                  async () => {
                    await this.classifyOwnerFreeRecord(current, reason, integrations);
                  },
                );
                return "classified" as const;
              }
              if (
                terminalReceiptProjectionDisagrees(current, authoritativeSpec, durableReceipt)
                || !current.kernel_receipt
                || !isDeepStrictEqual(current.kernel_receipt, durableReceipt)
              ) {
                let recovery: ReceiptRecoveryOutcome | undefined;
                if (legacyAdmission) {
                  recovery = await this.rebuildLegacyRecordFromReceipt(
                    current,
                    "reconcile",
                    provenance,
                  );
                } else {
                  await this.applyReconcileEffect(
                    runId,
                    "terminal_record_rebuild_from_receipt",
                    provenance,
                    async () => {
                      recovery = await this.rebuildOwnerFreeRecordFromReceipt(
                        current,
                        "reconcile",
                        provenance,
                      );
                    },
                  );
                }
                if (legacyAdmission && recovery?.status === "absent") {
                  return unresolvedReconcileDisposition(
                    "legacy_pending",
                    "legacy_publication_authority_unproven",
                  );
                }
                return recovery?.status === "rebuilt"
                  ? "rebuilt" as const
                  : recovery?.status === "repair_pending"
                    ? "repair_pending" as const
                    : "classified" as const;
              }
              if (legacyAdmission) {
                const pidPath = path.join(this.store.paths(runId).runDir, "pid");
                if (await fileExists(pidPath)) {
                  await this.applyReconcileEffect(
                    runId,
                    "legacy_pid_evidence_retirement",
                    provenance,
                    async () => {
                      await this.clearLegacyWorkerPidEvidence(runId);
                    },
                  );
                }
              }
            }
            const needsLaunchMigration = this.store.needsLaunchMigration(runId);
            const normalizedRecord = normalizeInfraErrorForRecord(current);
            const existingTerminalEvent = await this.findTerminalEvent(normalizedRecord);
            const hadTerminalEvent = existingTerminalEvent !== undefined;
            const terminalProjectionCurrent = existingTerminalEvent !== undefined
              && terminalEventOutcomeMatchesRecord(existingTerminalEvent, normalizedRecord);
            if (normalizedRecord === current && terminalProjectionCurrent && !needsLaunchMigration) {
              await this.ensureTerminalEvent(current, "reconcile");
              return "skipped" as const;
            }
            await this.applyReconcileEffect(
              runId,
              !hadTerminalEvent
                ? "terminal_event_backfill"
                : !terminalProjectionCurrent
                  ? "terminal_projection_correction"
                  : "terminal_record_normalization",
              provenance,
              async () => {
                if (normalizedRecord !== current || needsLaunchMigration) {
                  await this.store.writeRunRecord(runId, normalizedRecord);
                }
                await this.ensureTerminalEvent(normalizedRecord, "reconcile");
                if (!terminalProjectionCurrent || needsLaunchMigration) {
                  await this.store.appendEvent(
                    runId,
                    buildServiceEvent(
                      this.deps.now,
                      runId,
                      "reconciled",
                      needsLaunchMigration
                        ? "Persisted legacy launch metadata and backfilled terminal observations."
                        : hadTerminalEvent
                          ? "Appended a superseding terminal event and replaced the handback projection from the corrected durable outcome."
                          : "Backfilled missing terminal event from terminal run record.",
                      undefined,
                      provenance,
                    ),
                  );
                }
              },
            );
            return (!terminalProjectionCurrent || needsLaunchMigration) ? "rebuilt" as const : "skipped" as const;
          });
          if (!terminalOwnership.owned) {
            const current = await this.store.readRunRecord(runId);
            if (!current) {
              addMissingCanonicalRecord(runId);
              continue;
            }
            if (current && hasLegacyExecutionBarrier(current)) {
              addUnresolved(
                runId,
                hasLegacySettlementMarker(current)
                  ? unresolvedLegacySettlementReason(current)
                  : "legacy_publication_authority_unproven",
              );
            }
            result.adopted.push(runId);
          } else {
            const disposition = terminalOwnership.value;
            const status = typeof disposition === "string" ? disposition : disposition.status;
            if (typeof disposition !== "string") {
              addUnresolved(runId, disposition.unresolved_reason);
            }
            if (status === "rebuilt") {
              result.rebuilt.push(runId);
              terminalRunIds.add(runId);
            } else if (status === "repair_pending") {
              result.repair_pending!.push(runId);
              terminalRunIds.add(runId);
            } else if (status === "unresolved") {
              // The typed unresolved disposition was recorded above.
            } else if (status === "classified") {
              result.classified.push(runId);
              terminalRunIds.add(runId);
            } else if (status === "legacy_pending") {
              result.skipped.push(runId);
            } else {
              result.skipped.push(runId);
              terminalRunIds.add(runId);
            }
          }
          continue;
        }

        const dispatchOwnership = await this.tryDispatchOwnership(runId, async () => this.tryExecutionOwnership(runId, async () => {
          const initialLegacyAdmission = hasSynthesizedLegacyAdmission(initialRecord);
          const record = await this.store.readRunRecord(runId);
          if (!record) {
            return missingCanonicalRecordDisposition();
          }
          if (isTerminalState(record.state)) {
            return initialLegacyAdmission || hasSynthesizedLegacyAdmission(record)
              ? unresolvedReconcileDisposition(
                  "legacy_pending",
                  "legacy_publication_authority_unproven",
                )
              : "skipped" as const;
          }
          if (hasLegacySettlementMarker(record)) {
            return unresolvedReconcileDisposition(
              "legacy_pending",
              unresolvedLegacySettlementReason(record),
            );
          }
          if (initialLegacyAdmission && !hasSynthesizedLegacyAdmission(record)) {
            return unresolvedReconcileDisposition(
              "legacy_pending",
              "legacy_publication_authority_unproven",
            );
          }
          const legacyAdmission = hasSynthesizedLegacyAdmission(record);
          const needsLaunchMigration = this.store.needsLaunchMigration(runId);
          if (needsLaunchMigration && !legacyAdmission) {
            await this.store.writeRunRecord(runId, record);
          }
          const receiptPresent = await fileExists(this.store.paths(runId).kernelReceiptPath);

          if (receiptPresent) {
            if (legacyAdmission) {
              const recovery = await this.rebuildLegacyRecordFromReceipt(
                record,
                "reconcile",
                provenance,
              );
              if (recovery.status === "absent") {
                return unresolvedReconcileDisposition(
                  "legacy_pending",
                  "legacy_publication_authority_unproven",
                );
              }
              return recovery.status;
            }
            let recovery: ReceiptRecoveryOutcome | undefined;
            await this.applyReconcileEffect(runId, "record_rebuild_from_receipt", provenance, async () => {
              recovery = await this.rebuildOwnerFreeRecordFromReceipt(
                record,
                "reconcile",
                provenance,
              );
              if (recovery.status === "absent") {
                throw new Error(`Run ${runId} kernel receipt disappeared during reconciliation.`);
              }
            });
            return recovery!.status;
          }

          const legacyWorker = await this.inspectLegacyDetachedWorker(runId, record);
          // A pre-mutex worker publishes its durable receipt before its terminal
          // run record. Re-read both after the liveness probe: the worker may
          // have crossed that publication boundary after the initial pre-check.
          const postProbeRecord = await this.store.readRunRecord(runId);
          let postProbeReceipt: ExecutionReceipt | undefined;
          try {
            postProbeReceipt = await this.store.readKernelReceipt(runId);
          } catch {
            // The receipt recovery path below owns invalid-receipt classification.
            if (await fileExists(this.store.paths(runId).kernelReceiptPath)) {
              if (legacyAdmission) {
                const recovery = await this.rebuildLegacyRecordFromReceipt(
                  postProbeRecord ?? record,
                  "reconcile",
                  provenance,
                );
                if (recovery.status === "absent") {
                  return unresolvedReconcileDisposition(
                    "legacy_pending",
                    "legacy_publication_authority_unproven",
                  );
                }
                return recovery.status;
              }
              let recovery: ReceiptRecoveryOutcome | undefined;
              await this.applyReconcileEffect(runId, "record_rebuild_from_receipt", provenance, async () => {
                recovery = await this.rebuildOwnerFreeRecordFromReceipt(
                  postProbeRecord ?? record,
                  "reconcile",
                  provenance,
                );
              });
              return recovery!.status;
            }
          }
          if (postProbeReceipt) {
            if (legacyAdmission) {
              const recovery = await this.rebuildLegacyRecordFromReceipt(
                postProbeRecord ?? record,
                "reconcile",
                provenance,
              );
              if (recovery.status === "absent") {
                return unresolvedReconcileDisposition(
                  "legacy_pending",
                  "legacy_publication_authority_unproven",
                );
              }
              return recovery.status;
            }
            const legacyHostReceipt = "kernel" in postProbeReceipt
              && postProbeReceipt.kernel === "host_process"
              && !isBoundHostProcessReceipt(postProbeReceipt)
              ? postProbeReceipt
              : undefined;
            if (legacyHostReceipt) {
              const storedSpec = await this.store.readSpec(runId);
              if (
                !postProbeRecord
                || !storedSpec
                || !legacyHostTerminalObservationIsCoherent(
                  postProbeRecord,
                  storedSpec,
                  legacyHostReceipt,
                )
              ) {
                return unresolvedReconcileDisposition(
                  "legacy_pending",
                  "legacy_publication_authority_unproven",
                );
              }
            }
            let recovery: ReceiptRecoveryOutcome | undefined;
            await this.applyReconcileEffect(runId, "record_rebuild_from_receipt", provenance, async () => {
              recovery = legacyHostReceipt
                ? { status: "rebuilt", record: postProbeRecord! }
                : await this.rebuildOwnerFreeRecordFromReceipt(
                  postProbeRecord ?? record,
                  "reconcile",
                  provenance,
                );
              if (legacyHostReceipt) {
                await this.ensureTerminalEvent(postProbeRecord!, "reconcile", record.state);
              }
            });
            await this.clearLegacyWorkerPidEvidence(runId);
            return recovery!.status;
          }
          if (!postProbeRecord) {
            return missingCanonicalRecordDisposition();
          }
          if (isTerminalState(postProbeRecord.state)) {
            return legacyAdmission
              ? unresolvedReconcileDisposition(
                  "legacy_pending",
                  "legacy_publication_authority_unproven",
                )
              : "skipped" as const;
          }
          if (!isDeepStrictEqual(postProbeRecord, record)) {
            return legacyAdmission
              ? unresolvedReconcileDisposition(
                  "legacy_pending",
                  "legacy_publication_authority_unproven",
                )
              : "skipped" as const;
          }
          if (legacyWorker.status === "possibly_live") {
            if (!(await this.hasLegacySettlementObservation(runId))) {
              await this.applyReconcileEffect(runId, "legacy_worker_settlement_observation", provenance, async () => {
                await this.store.appendEvent(
                  runId,
                  buildServiceEvent(
                    this.deps.now,
                    runId,
                    "reconciled",
                    "Deferred classification for a pre-mutex worker because historical PID state cannot prove process identity.",
                    {
                      reconcile: "legacy_settlement_pending",
                      authority: "legacy_pid_observation",
                      worker_pid: legacyWorker.pid,
                      effect_authority: false,
                      readopt_safe: false,
                    },
                    provenance,
                  ),
                );
              });
            }
            return unresolvedReconcileDisposition(
              "legacy_pending",
              "legacy_publication_authority_unproven",
            );
          }
          if (legacyWorker.status === "missing" || legacyWorker.status === "untrusted") {
            // Without a process-instance token, missing or malformed legacy PID
            // evidence cannot prove that the old publisher is gone. Preserve the
            // nonterminal projection for explicit operator settlement rather
            // than racing an uncoordinated receipt/record publication.
            return unresolvedReconcileDisposition(
              "legacy_pending",
              "legacy_publication_authority_unproven",
            );
          }

          if (
            legacyWorker.status === "not_legacy"
            && postProbeRecord.state === "queued"
            && postProbeRecord.launch.mode === "detached"
            && postProbeRecord.launch.stage !== "executing"
          ) {
            return "redispatch" as const;
          }
          let finalOutcome:
            | "classified"
            | ReceiptRecoveryOutcome["status"]
            | "skipped"
            | UnresolvedReconcileDisposition = "skipped";
          await this.applyReconcileEffect(runId, "owner_free_execution_classification", provenance, async () => {
            const finalRecord = await this.store.readRunRecord(runId);
            if (!finalRecord) {
              finalOutcome = missingCanonicalRecordDisposition();
              return;
            }
            if (
              isTerminalState(finalRecord.state)
              || !isDeepStrictEqual(finalRecord, postProbeRecord)
            ) {
              if (legacyAdmission) {
                finalOutcome = unresolvedReconcileDisposition(
                  "legacy_pending",
                  "legacy_publication_authority_unproven",
                );
              }
              return;
            }
            if (await fileExists(this.store.paths(runId).kernelReceiptPath)) {
              const recovery = await this.rebuildOwnerFreeRecordFromReceipt(
                finalRecord,
                "reconcile",
                provenance,
                legacyAdmission ? { invalidReceiptDisposition: "defer" } : {},
              );
              if (legacyAdmission && recovery.status === "absent") {
                finalOutcome = unresolvedReconcileDisposition(
                  "legacy_pending",
                  "legacy_publication_authority_unproven",
                );
                return;
              }
              if (
                legacyAdmission
                && (recovery.status === "rebuilt" || recovery.status === "repair_pending")
              ) {
                await this.clearLegacyWorkerPidEvidence(runId);
              }
              finalOutcome = recovery.status;
              return;
            }
            const message = "Execution ownership ended before a terminal receipt was durable; refusing ambiguous effect replay.";
            const integrations = await this.recoverAndPersistIntegrationStatus(runId);
            const settledAt = nowIso(this.deps.now);
            const classified = createErroredRunRecord(
              finalRecord.intent,
              finalRecord.launch,
              await this.store.readSpec(runId),
              message,
              settledAt,
              deriveCrashRecoveryMode(finalRecord.intent),
              finalRecord.creation_provenance,
              integrations,
            );
            const publisherSettled = legacyAdmission && legacyWorker.status === "publisher_dead"
              ? {
                  ...classified,
                  recovery: {
                    ...classified.recovery,
                    owner_free_settlement: {
                      schema_version: "calyx.owner-free-settlement/v1" as const,
                      authority: "legacy_pid_dead" as const,
                      authority_id: legacyDeadSettlementAuthorityId(finalRecord, legacyWorker.pid),
                      settled_at: settledAt,
                      reason_code: "legacy_detached_worker_observed_dead" as const,
                      legacy_pid: legacyWorker.pid,
                    },
                  },
                }
              : classified;
            const next = legacyAdmission && legacyWorker.status === "publisher_dead"
              ? {
                  ...publisherSettled,
                  recovery: {
                    ...publisherSettled.recovery,
                    resource_settlement: legacyWorker.process_group === "dead"
                      ? {
                          schema_version: "calyx.resource-settlement/v1" as const,
                          status: "settled" as const,
                          authority: "legacy_process_group_extinct" as const,
                          authority_id: legacyResourceSettlementAuthorityId(
                            publisherSettled,
                            legacyWorker.pid,
                          ),
                          settled_at: settledAt,
                          reason_code: "legacy_detached_process_group_observed_extinct" as const,
                          legacy_process_group_id: legacyWorker.pid,
                        }
                      : {
                          schema_version: "calyx.resource-settlement/v1" as const,
                          status: "pending" as const,
                          authority: "legacy_process_group_observation" as const,
                          observed_at: settledAt,
                          reason_code: legacyWorker.process_group === "possibly_live"
                            ? "legacy_detached_process_group_possibly_live" as const
                            : "legacy_detached_process_group_untrusted" as const,
                          legacy_process_group_id: legacyWorker.pid,
                        },
                  },
                }
              : classified;
            if (legacyPendingResourceSettlement(next)) {
              await this.quarantineLegacyRunWorktreeLeases(next, provenance);
            } else if (!legacyAdmission) {
              // Current-generation owner-free fail-closed settlement: the free
              // mutex proved the publisher gone, not the backend group.
              await this.quarantineOwnerFreeSettledRunWorktreeLeases(runId, provenance);
            }
            await this.store.writeRunRecord(runId, next);
            await this.ensureTerminalEvent(next, "reconcile", finalRecord.state);
            await this.store.appendEvent(
              runId,
              buildServiceEvent(
                this.deps.now,
                runId,
                "reconciled",
                `Marked owner-free run as ${deriveCrashRecoveryMode(finalRecord.intent)} after reconciliation.`,
                { reconcile: "owner_free_fail_closed" },
                provenance,
              ),
            );
            finalOutcome = legacyPendingResourceSettlement(next)
              ? unresolvedReconcileDisposition(
                  "classified",
                  "legacy_resource_settlement_pending",
                )
              : "classified";
          });
          return finalOutcome;
        }));

        if (!dispatchOwnership.owned) {
          // Admission owns the dispatch mutex until it has transferred authority
          // to the execution mutex. A busy dispatch mutex is therefore positive
          // evidence of a live handoff, not an owner-free orphan.
          const current = await this.store.readRunRecord(runId);
          if (!current) {
            addMissingCanonicalRecord(runId);
            continue;
          }
          if (current && hasLegacyExecutionBarrier(current)) {
            addUnresolved(
              runId,
              hasLegacySettlementMarker(current)
                ? unresolvedLegacySettlementReason(current)
                : "legacy_publication_authority_unproven",
            );
            result.skipped.push(runId);
            continue;
          }
          if (!(await this.hasReconcileAdoptionEvent(runId))) {
            await this.applyReconcileEffect(runId, "live_dispatch_handoff_adoption", provenance, async () => {
              await this.store.appendEvent(
                runId,
                buildServiceEvent(
                  this.deps.now,
                  runId,
                  "reconciled",
                  "Re-adopted a live run admission-to-execution handoff during reconciliation.",
                  { reconcile: "adopted", authority: "sqlite_dispatch_mutex" },
                  provenance,
                ),
              );
            });
          }
          result.adopted.push(runId);
          continue;
        }

        const ownership = dispatchOwnership.value;

        if (!ownership.owned) {
          // The SQLite transaction, not a process-local PID, is the execution
          // authority. A held mutex survives sibling service instances and is
          // released automatically if its worker process crashes.
          const current = await this.store.readRunRecord(runId);
          if (!current) {
            addMissingCanonicalRecord(runId);
            continue;
          }
          if (current && hasLegacyExecutionBarrier(current)) {
            addUnresolved(
              runId,
              hasLegacySettlementMarker(current)
                ? unresolvedLegacySettlementReason(current)
                : "legacy_publication_authority_unproven",
            );
            result.skipped.push(runId);
            continue;
          }
          if (!(await this.hasReconcileAdoptionEvent(runId))) {
            await this.applyReconcileEffect(runId, "live_execution_owner_adoption", provenance, async () => {
              await this.store.appendEvent(
                runId,
                buildServiceEvent(
                  this.deps.now,
                  runId,
                  "reconciled",
                  "Re-adopted a live run execution owner during reconciliation.",
                  { reconcile: "adopted", authority: "sqlite_execution_mutex" },
                  provenance,
                ),
              );
            });
          }
          result.adopted.push(runId);
          continue;
        }

        const disposition = ownership.value;
        const status = typeof disposition === "string" ? disposition : disposition.status;
        if (typeof disposition !== "string") {
          addUnresolved(runId, disposition.unresolved_reason);
        }

        if (status === "redispatch") {
          await this.submitDetached(initialRecord.intent, {
            ...(initialRecord.creation_provenance
              ? { provenance: initialRecord.creation_provenance }
              : {}),
            admissionIdentity: initialRecord.launch.admission_identity,
            requestHash: initialRecord.launch.request_hash,
          });
          result.adopted.push(runId);
        } else if (status === "rebuilt") {
          result.rebuilt.push(runId);
          terminalRunIds.add(runId);
        } else if (status === "repair_pending") {
          result.repair_pending!.push(runId);
          terminalRunIds.add(runId);
        } else if (status === "unresolved") {
          // The typed unresolved disposition was recorded above.
        } else if (status === "legacy_pending") {
          result.skipped.push(runId);
        } else if (status === "classified") {
          result.classified.push(runId);
          terminalRunIds.add(runId);
        } else {
          result.skipped.push(runId);
        }
      } catch (error) {
        // POL-1897: one damaged candidate must never block the rest of the
        // estate (or a targeted stop() settlement). The failure is preserved
        // as a typed unresolved disposition, and scope-'all' index repair is
        // deferred because an unreconciled candidate leaves the projection
        // unproven.
        addUnresolved(runId, "reconcile_candidate_failed");
        projectionRepairBlockReason =
          `Run-index repair deferred because reconciliation of ${runId} raised: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    // `skipped` is reserved for benign no-ops. Authority-sensitive branches
    // carry their typed unresolved disposition directly; this finalization is
    // bookkeeping only and must never reconstruct durable authority from the
    // embedded `run_record.kernel_receipt` projection.
    if (result.unresolved.length > 0) {
      const unresolvedRunIds = new Set(result.unresolved.map((entry) => entry.run_id));
      result.skipped = result.skipped.filter((runId) => !unresolvedRunIds.has(runId));
    }

    // POL-1144 / wave 2.2: rebuild the SQLite `run_index` projection
    // from authoritative `run_record.json` files. Wave 2.2 replaced the
    // racy `index.jsonl` upsert with a SQLite table keyed by `run_id`,
    // but reconcile still owns the "always-safe repair path" contract:
    // even with SQLite's serialized writers, a bug or interrupted write
    // could leave a stale row. A missing canonical run record is damage, not
    // proof that the run ceased to exist, so its last known row remains visible
    // until an operator proves a disposition. A full rebuild from authoritative records is cheap
    // (one disk scan + one transactional swap), idempotent, and makes
    // `calyx run reconcile` the repair path operators reach for instead
    // of hand-editing state.
    // `run_index` is a replaceable projection of the authoritative records,
    // not an additional capability mutation. The persisted summary below
    // names that authority boundary and carries the request provenance.
    const indexRepair = scope !== "all"
      ? {
          missingRecordRunIds: [],
          projection: {
            status: "failed" as const,
            reason: "Run-index repair deferred because this pass reconciled a narrowed scope; scope-'all' reconcile owns projection repair.",
          },
        }
      : projectionRepairBlockReason
        ? {
            missingRecordRunIds: [],
            projection: { status: "failed" as const, reason: projectionRepairBlockReason },
          }
        : await this.store.rebuildRunIndex();
    for (const runId of indexRepair.missingRecordRunIds) addMissingCanonicalRecord(runId);
    result.projection = indexRepair.projection;
    if (indexRepair.projection.status === "repaired" && result.repair_pending!.length > 0) {
      const stillPending: string[] = [];
      for (const runId of result.repair_pending!) {
        if (!(await this.receiptDerivedRecordIsCurrent(runId))) {
          stillPending.push(runId);
          continue;
        }
        if (!result.rebuilt.includes(runId)) result.rebuilt.push(runId);
        await this.appendPostEffectEvent(
          runId,
          buildServiceEvent(
            this.deps.now,
            runId,
            "reconciled",
            "The final full run-index rebuild resolved the receipt-backed projection repair.",
            {
              reconcile: "record_rebuild_from_receipt",
              projection_repair: "repaired",
              supersedes_projection_repair: "repair_pending",
            },
            provenance,
          ),
        );
      }
      result.repair_pending = stillPending;
    }
    await this.garbageCollectTerminalRunLeases([...terminalRunIds], provenance);
    await this.store.summarizeReconcile(result, {
      ...(provenance ? { provenance } : {}),
    });
    return result;
  }

  /**
   * POL-1886: classify whether each given non-terminal run is a live, detached
   * `agent_runner` worker that survives a daemon restart and is re-adopted by
   * the boot reconcile (run.readopt_on_boot/v1). `self upgrade` uses this to
   * decide which active runs can be preserved across a continuous restart
   * instead of drained.
   *
   * A run is restart-safe (`detached_agent_runner_worker`) iff ALL hold:
   *  - the background-launch path recorded the worker via a `launch_dispatched`
   *    "Spawned detached run worker." event — this is the discriminator that
   *    excludes inline/daemon-tick execution;
   *  - the per-run SQLite execution mutex proves a live owner;
   *  - the resolved kernel is `agent_runner`;
   *  - the launch evidence positively proves restart-survivable supervisor
   *    isolation (POL-2044): on Linux, `worker_supervisor === 'systemd'` — the
   *    only supervisor proven to survive a `run serve` restart (POL-1900). A
   *    `direct` worker (including a silent systemd→direct fallback), an
   *    unrecorded (legacy) launch event, and macOS launchd hosts all fail
   *    closed with an `unproven_supervisor_isolation:*` reason;
   *  - the run carries no active Codex app-server binding (re-attach is
   *    POL-1880, not yet shipped).
   *
   * Anything not positively proven is reported as not safe with a classified
   * reason. Resumable / unhealthy runs are still surfaced as live workers when
   * they are detached; the caller layers its own health/recovery policy on top.
   */
  async assessRestartReadopt(runIds: readonly string[]): Promise<RunRestartReadoptAssessment[]> {
    if (runIds.length === 0) {
      return [];
    }
    // Cheap, file-only checks first so the SQLite state store is only opened
    // when at least one otherwise-safe detached worker needs an app-server
    // binding check.
    const preliminary: RunRestartReadoptAssessment[] = [];
    for (const runId of runIds) {
      preliminary.push(await this.assessDetachedWorkerLiveness(runId));
    }
    const appServerCandidates = preliminary
      .filter((assessment) => assessment.readopt_safe)
      .map((assessment) => assessment.run_id);
    if (appServerCandidates.length === 0) {
      return preliminary;
    }
    const appServerBindingState = await this.readActiveAppServerBoundRunIds(appServerCandidates);
    if (appServerBindingState.status === "unavailable") {
      return preliminary.map((assessment) =>
        assessment.readopt_safe
          ? {
              run_id: assessment.run_id,
              readopt_safe: false,
              reason: "app_server_binding_unknown",
              ...(assessment.worker_supervisor ? { worker_supervisor: assessment.worker_supervisor } : {}),
            }
          : assessment,
      );
    }
    const appServerBound = appServerBindingState.bound;
    return preliminary.map((assessment) =>
      assessment.readopt_safe && appServerBound.has(assessment.run_id)
        ? {
            run_id: assessment.run_id,
            readopt_safe: false,
            reason: "active_app_server_binding",
            ...(assessment.worker_supervisor ? { worker_supervisor: assessment.worker_supervisor } : {}),
          }
        : assessment,
    );
  }

  private async assessDetachedWorkerLiveness(runId: string): Promise<RunRestartReadoptAssessment> {
    const record = await this.store.readRunRecord(runId);
    if (!record) {
      return { run_id: runId, readopt_safe: false, reason: "missing_record" };
    }
    assertRunRecordIdentity(runId, record);
    const kernelId = record.spec?.kernel ?? record.intent.kernel ?? "agent_runner";
    if (kernelId !== "agent_runner") {
      return { run_id: runId, readopt_safe: false, reason: "non_agent_runner_kernel" };
    }
    const launch = await this.readDetachedLaunchSupervisorEvidence(runId);
    if (!launch.launched) {
      // No background-launch event: this is an inline/daemon-tick run, not a
      // detached worker that the restarted daemon can re-adopt.
      return {
        run_id: runId,
        readopt_safe: false,
        reason: "inline_worker",
      };
    }
    const ownership = await this.tryExecutionOwnership(runId, async () => undefined);
    if (!ownership.owned) {
      // A live detached worker holds the mutex. Preserve it across a restart
      // only with positive supervisor-isolation proof (POL-2044) — otherwise a
      // silent systemd→direct fallback or a launchd host drains instead of
      // orphaning the worker on restart. `worker_supervisor` is surfaced here,
      // where the supervisor gate is the discriminator, so `self upgrade`
      // explains preserve-vs-drain.
      const supervisorField = launch.supervisor ? { worker_supervisor: launch.supervisor } : {};
      const proof = this.classifySupervisorRestartProof(launch.supervisor);
      return proof.proven
        ? { run_id: runId, readopt_safe: true, reason: "detached_agent_runner_worker", ...supervisorField }
        : { run_id: runId, readopt_safe: false, reason: proof.reason, ...supervisorField };
    }
    const legacyWorker = await this.inspectLegacyDetachedWorker(runId, record);
    return legacyWorker.status === "possibly_live"
      || legacyWorker.status === "missing"
      || legacyWorker.status === "untrusted"
      ? { run_id: runId, readopt_safe: false, reason: "legacy_process_identity_unavailable" }
      : { run_id: runId, readopt_safe: false, reason: "no_execution_owner" };
  }

  /**
   * POL-2044: reduce a live detached worker's recorded launch supervisor to a
   * restart-survival verdict. Only Linux systemd cgroup isolation is proven to
   * survive a `run serve` restart (POL-1900); every other posture fails closed
   * with an `unproven_supervisor_isolation:*` reason so the operator sees why a
   * healthy run drains.
   */
  private classifySupervisorRestartProof(
    supervisor: DetachedWorkerSupervisor | undefined,
  ): { proven: true } | { proven: false; reason: RunRestartReadoptReason } {
    if (this.deps.platform() !== "linux") {
      // Non-Linux fleet hosts run under launchd (macOS); detached-worker
      // survival across a `run serve` restart is unproven. Fail closed.
      return { proven: false, reason: "unproven_supervisor_isolation:launchd" };
    }
    if (supervisor === "systemd") {
      return { proven: true };
    }
    if (supervisor === "direct") {
      return { proven: false, reason: "unproven_supervisor_isolation:direct" };
    }
    return { proven: false, reason: "unproven_supervisor_isolation:unrecorded" };
  }

  private async readDetachedLaunchSupervisorEvidence(
    runId: string,
  ): Promise<{ launched: boolean; supervisor?: DetachedWorkerSupervisor }> {
    const events = await this.store.readEvents(runId);
    const launchEvent = events
      .filter((event): event is RunServiceEvent => isRunServiceEvent(event) && event.event === "launch_dispatched")
      .at(-1);
    if (!launchEvent) {
      return { launched: false };
    }
    const supervisor = asRecord(launchEvent.payload)?.["worker_supervisor"];
    return {
      launched: true,
      ...(supervisor === "systemd" || supervisor === "direct" ? { supervisor } : {}),
    };
  }

  private async readActiveAppServerBoundRunIds(runIds: readonly string[]): Promise<
    | { status: "ok"; bound: ReadonlySet<string> }
    | { status: "unavailable" }
  > {
    const bound = new Set<string>();
    let opened: Awaited<ReturnType<typeof openStateStore>>;
    try {
      await applyStateMigrations({ ...(this.options.leases?.state ? { storeOptions: this.options.leases.state } : {}) });
      opened = await openStateStore(this.options.leases?.state ?? {});
    } catch {
      // App-server-bound runs are restart-unsafe until POL-1880. If the state
      // store cannot be read, every otherwise-safe candidate must fail closed.
      return { status: "unavailable" };
    }
    try {
      for (const runId of runIds) {
        const binding = readRunnerLiveBindingByRunAdapter(opened.db, runId, "codex_app_server_steer");
        if (binding && binding.status === "active") {
          bound.add(runId);
        }
      }
    } finally {
      opened.db.close();
    }
    return { status: "ok", bound };
  }

  private async garbageCollectTerminalRunLeases(
    candidateRunIds: readonly string[],
    provenance?: ApiProvenanceV1,
  ): Promise<void> {
    if (candidateRunIds.length === 0 || this.options.leases?.enabled === false) {
      return;
    }
    const runIds: string[] = [];
    for (const runId of candidateRunIds) {
      const record = await this.store.readRunRecord(runId);
      if (!record || !isTerminalState(record.state)) continue;
      if (!await this.getResourceTerminalAuthority(runId)) continue;
      runIds.push(runId);
    }
    if (runIds.length === 0) return;
    await applyStateMigrations({ ...(this.options.leases?.state ? { storeOptions: this.options.leases.state } : {}) });
    const opened = await openStateStore(this.options.leases?.state ?? {});
    try {
      const pendingReleaseReceipts = async (runId: string): Promise<LeaseEventRow[]> => {
        const events = await this.store.readEvents(runId);
        const intentIndexByRequest = new Map<string, number>();
        const completedResultIndexByRequest = new Map<string, number>();
        events.forEach((event, index) => {
          const payload = isRunServiceEvent(event) ? asRecord(event.payload) : undefined;
          if (
            isRunServiceEvent(event)
            && event.event === "reconcile_intent"
            && payload?.["effect"] === "terminal_lease_release"
            && event.provenance
            && payload["correlation_id"] === event.provenance.request_id
            && !intentIndexByRequest.has(event.provenance.request_id)
          ) {
            intentIndexByRequest.set(event.provenance.request_id, index);
          }
          if (
            isRunServiceEvent(event)
            && event.event === "reconcile_result"
            && payload?.["effect"] === "terminal_lease_release"
            && payload["outcome"] === "completed"
            && event.provenance
            && payload["correlation_id"] === event.provenance.request_id
          ) {
            completedResultIndexByRequest.set(event.provenance.request_id, index);
          }
        });
        const settledProjectionPayloads = new Map<number, Record<string, unknown>[]>();
        events.forEach((event, index) => {
          const payload = isRunServiceEvent(event) ? asRecord(event.payload) : undefined;
          const receiptId = payload?.["lease_event_id"];
          if (
            !isRunServiceEvent(event)
            || event.event !== "reconciled"
            || payload?.["reconcile"] !== "terminal_lease_release"
            || !Number.isSafeInteger(receiptId)
          ) {
            return;
          }
          if (!event.provenance) {
            const projections = settledProjectionPayloads.get(Number(receiptId)) ?? [];
            projections.push(payload);
            settledProjectionPayloads.set(Number(receiptId), projections);
            return;
          }
          const completedResultIndex = completedResultIndexByRequest.get(event.provenance.request_id);
          const intentIndex = intentIndexByRequest.get(event.provenance.request_id);
          if (
            intentIndex !== undefined
            && intentIndex < index
            && completedResultIndex !== undefined
            && completedResultIndex > index
          ) {
            const projections = settledProjectionPayloads.get(Number(receiptId)) ?? [];
            projections.push(payload);
            settledProjectionPayloads.set(Number(receiptId), projections);
          }
        });
        const receipts: LeaseEventRow[] = [];
        let afterEventId = 0;
        while (true) {
          const page = listTerminalLeaseReleaseEventsForRun(opened.db, runId, {
            after_event_id: afterEventId,
            limit: 1000,
          });
          receipts.push(...page);
          if (page.length < 1000) break;
          afterEventId = page.at(-1)!.event_id;
        }
        return receipts.filter((receipt) => {
          const releasedLease = receipt.before_lease!;
          const expectedReleaseRequestId = receipt.request_provenance?.request_id;
          return !(settledProjectionPayloads.get(receipt.event_id) ?? []).some((payload) => (
            payload["lease_key"] === receipt.key
            && payload["holder_activity_id"] === releasedLease.holder_activity_id
            && payload["release_reason"] === receipt.reason
            && (expectedReleaseRequestId === undefined
              ? payload["release_request_id"] === undefined
              : payload["release_request_id"] === expectedReleaseRequestId)
          ));
        });
      };

      const releaseAndRecord = async (affectedRunIds: readonly string[]): Promise<void> => {
        for (const affectedRunId of affectedRunIds) {
          const record = await this.store.readRunRecord(affectedRunId);
          if (!record || !hasLegacyResourceSettlement(record)) continue;
          const ownerSettlement = record.recovery.owner_free_settlement!;
          const resourceSettlement = record.recovery.resource_settlement!;
          if (resourceSettlement.status !== "settled") continue;
          releaseQuarantinedRunWorktreeLeases(opened.db, {
            run_id: affectedRunId,
            owner_free_authority_id: ownerSettlement.authority_id,
            resource_authority_id: resourceSettlement.authority_id,
            legacy_process_group_id: resourceSettlement.legacy_process_group_id,
            now: this.deps.now(),
            ...(provenance ? { request_provenance: provenance } : {}),
          });
        }
        releaseLeasesForTerminalRuns(opened.db, affectedRunIds, {
          now: this.deps.now(),
          ...(provenance ? { request_provenance: provenance } : {}),
        });
        for (const affectedRunId of affectedRunIds) {
          for (const receipt of await pendingReleaseReceipts(affectedRunId)) {
            const releasedLease = receipt.before_lease!;
            await this.store.appendEvent(
              affectedRunId,
              buildServiceEvent(
                this.deps.now,
                affectedRunId,
                "reconciled",
                `Recorded terminal-run DB lease release ${receipt.event_id} for ${receipt.key}.`,
                {
                  reconcile: "terminal_lease_release",
                  lease_event_id: receipt.event_id,
                  lease_key: receipt.key,
                  holder_activity_id: releasedLease.holder_activity_id,
                  release_reason: receipt.reason,
                  ...(receipt.request_provenance
                    ? { release_request_id: receipt.request_provenance.request_id }
                    : {}),
                },
                provenance,
              ),
            );
          }
        }
      };

      if (!provenance) {
        await releaseAndRecord(runIds);
        return;
      }

      for (const runId of runIds) {
        const held = [
          ...listLeases(opened.db, {
            holder_activity_id: runId,
            include_expired: true,
            limit: 1000,
          }),
          ...listLeases(opened.db, {
            holder_activity_id: `run:${runId}`,
            include_expired: true,
            limit: 1000,
          }),
        ];
        if (held.length === 0 && (await pendingReleaseReceipts(runId)).length === 0) {
          continue;
        }
        await this.applyReconcileEffect(
          runId,
          "terminal_lease_release",
          provenance,
          () => releaseAndRecord([runId]),
        );
      }
    } finally {
      opened.db.close();
    }
  }
}
