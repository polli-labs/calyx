import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Writable } from "node:stream";
import { z } from "zod";
import {
  adminOperationRoutes,
  createCalyxAdminClient,
  type CalyxResult,
} from "@polli-labs/calyx-client/admin";
import {
  openStateStore,
  planStateMigrations,
  upsertFleetConvergenceRow,
  applySelfUpgradeOperationTransition,
  appendSelfUpgradeOperationDurabilityIssue,
  CALYX_SELF_UPGRADE_RECEIPT_MAX_BYTES,
  bindSelfUpgradeOperationTarget,
  claimSelfUpgradeOperation,
  createSelfUpgradeOperation,
  defaultSelfUpgradeOperationRoot,
  listRunServeHosts,
  openChildDirectoryDurable,
  openExistingDirectoryDurable,
  openPrivateDirectoryDurable,
  readHostsTruth,
  resolveConsumerApiClientToken,
  resolveAgentsInfraRoot,
  resolveCurrentHostAlias,
  resolveRepo,
  SELF_UPGRADE_OPERATION_MAX_HOSTS,
  SELF_UPGRADE_OPERATION_MAX_PHASE_TRANSITIONS_PER_HOST,
  selfUpgradeOperationPath,
  selfUpgradeReceiptLocatorSchema,
  selfUpgradeTransitionId,
} from "@polli-labs/calyx-core";
import type {
  RunServeHostTarget,
  DurableDirectoryAnchor,
  DurableDirectoryOpenOptions,
  SelfUpgradeHostPhaseTransition,
  SelfUpgradeOperationFinalRow,
  SelfUpgradeOperationRecord,
  SelfUpgradeOperationDurabilityIssue,
  SelfUpgradeOperationWriter,
  SelfUpgradeOperationTransition,
  SelfUpgradeOperationPhase,
  SelfUpgradeReceiptLocator,
  SelfUpgradeRelayMode,
} from "@polli-labs/calyx-core";
import {
  defaultDaemonsRoot,
  listDescriptors,
} from "@polli-labs/calyx-run-service";
import {
  appendControlEvent,
  buildControlEvent,
  formatSelfUpgradePlan,
  runSelfUpgrade,
  toSelfUpgradeFailureOutput,
} from "./self-upgrade.js";
import type {
  SelfUpgradeCommandFailureOutput,
  SelfUpgradeCommandJsonOutput,
  SelfUpgradeOptions,
  SelfUpgradePlan,
  SelfUpgradeProjectionIssue,
  SelfUpgradeReceipt,
  SelfUpgradeResult,
  SelfUpgradeTargetEvidence,
} from "./self-upgrade.js";
import type { SelfUpgradePhaseEvent } from "../self-upgrade-progress.js";
import {
  runSelfFreshnessCommand,
  type SelfFreshnessCommandDeps,
  type SelfFreshnessCommandOptions,
  type SelfFreshnessHealthSummary,
  type SelfFreshnessHostResult,
  type SelfFreshnessResult,
  type SelfFreshnessVerdict,
} from "../self-freshness.js";
import {
  buildTargetStartupContractPayload,
  validateTargetStartupContractPayload,
} from "../self-upgrade-startup-contract.js";
import {
  DEFAULT_FLEET_PROGRESS_HEARTBEAT_MS,
  SelfUpgradeFleetProgressReporter,
  formatFleetFinalTable,
} from "../self-upgrade-fleet-progress.js";
import {
  parseSelfUpgradeProgressTransition,
  toSelfUpgradeProgressTransition,
} from "../self-upgrade-progress.js";
import {
  DEFAULT_SELF_UPGRADE_COMMAND_CAPTURE_BYTES,
  DEFAULT_SELF_UPGRADE_PROJECTION_SETTLE_MS,
  createFailOpenProjectionWriter,
  execSelfUpgradeStreaming,
  settleFailOpenProjection,
  type FailOpenProjectionWriter,
  type SelfUpgradeCommandCapture,
  type SelfUpgradeStreamingExecOptions,
  type SelfUpgradeStreamingExecResult,
} from "../self-upgrade-stream-io.js";
const DEFAULT_TARGET_REF = "origin/main";
const DEFAULT_DRAIN_DEADLINE_MS = 10 * 60 * 1_000;
const DEFAULT_COMMAND_MAX_BUFFER = DEFAULT_SELF_UPGRADE_COMMAND_CAPTURE_BYTES;
const STDERR_TAIL_LINES = 40;
/** Environment noise is context for a hygiene fix, not a transcript; keep it short. */
const REMOTE_ENVIRONMENT_NOISE_TAIL_LINES = 20;
const FLEET_RECEIPT_DIRECTORY_MODE = 0o700;
const FLEET_RECEIPT_FILE_MODE = 0o600;
const FLEET_RECEIPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const FLEET_RECEIPT_RETENTION_COUNT = 256;
const FLEET_RECEIPT_INCOMPLETE_RETENTION_MS = 2 * FLEET_RECEIPT_RETENTION_MS;
const FLEET_RECEIPT_INCOMPLETE_RETENTION_COUNT = 2 * FLEET_RECEIPT_RETENTION_COUNT;
const REMOTE_PHASE_FRAME_MAX_COUNT = SELF_UPGRADE_OPERATION_MAX_PHASE_TRANSITIONS_PER_HOST;
const REMOTE_PHASE_FRAME_MAX_BYTES = 128 * 1024;
const REMOTE_PLAN_MAX_BYTES = 256 * 1024;
export const SELF_UPGRADE_FLEET_RECEIPT_MAX_BYTES = 4 * CALYX_SELF_UPGRADE_RECEIPT_MAX_BYTES;
const REMOTE_PHASE_FRAME_MAX_SINGLE_BYTES = Math.floor(
  REMOTE_PHASE_FRAME_MAX_BYTES / REMOTE_PHASE_FRAME_MAX_COUNT,
);
const FLEET_ARTIFACT_SETTLE_TIMEOUT_MS = 1_000;
const FLEET_HOST_ALIAS_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;

// POL-1933: a daemon that has just been restarted by its own upgrade can still
// be rebinding the health plane when the conductor's first postflight probe
// lands. That race wrote durable `blocked` verdicts (health_status=error plus
// full missing-feature lists) for hosts a `self freshness --fleet` seconds
// later proved clean. The postflight therefore gives each successfully upgraded
// host a bounded settle window before its verdict becomes durable. The window
// is a per-host sleep budget, not a deadline for the whole fleet, and it is
// only ever consumed while typed evidence says the host can still be in a
// restart-transient state.
const DEFAULT_POSTFLIGHT_SETTLE_WINDOW_MS = 45 * 1_000;
/** Retry backoff ramp; the last entry repeats until the window is consumed. */
const POSTFLIGHT_SETTLE_DELAY_RAMP_MS = [5_000, 15_000, 25_000] as const;
/** Hard backstop so an operator-widened window can never spin unbounded. */
const POSTFLIGHT_SETTLE_MAX_ATTEMPTS = 8;
/** Observation claiming can invoke a 2 s portable process-generation probe. */
const DEFAULT_OPERATION_CLAIM_SETTLE_TIMEOUT_MS = 5_000;
const REMOTE_RECEIPT_DEREFERENCE_ATTEMPT_TIMEOUT_MS = 10_000;
const REMOTE_RECEIPT_DEREFERENCE_MAX_ATTEMPTS = 3;
const REMOTE_RECEIPT_DEREFERENCE_RETRY_DELAYS_MS = [500, 1_500] as const;
/** Verdicts that require no further postflight observation. */
const SETTLED_FRESHNESS_VERDICTS: readonly SelfFreshnessVerdict[] = ["fresh", "usable_with_warnings"];

type ExecFileAsyncResult = Pick<SelfUpgradeStreamingExecResult, "stdout" | "stderr">
  & Partial<Pick<SelfUpgradeStreamingExecResult, "stdout_capture" | "stderr_capture">>;

interface ExecFileAsyncOptions extends SelfUpgradeStreamingExecOptions {
  /**
   * POL-2046: typed progress crosses stderr so stdout remains exactly one final
   * JSON object. Each complete stderr line is delivered as it arrives; callers
   * parse only owning-schema records; opaque diagnostics are retained only up
   * to the explicit artifact cap.
   */
  onStderrLine?: (line: string) => void;
}

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options?: ExecFileAsyncOptions,
) => Promise<ExecFileAsyncResult>;

/**
 * `execFile`'s promise resolves only once the child has exited, so it can never
 * hand back a remote host's phase records while that host is still upgrading.
 * The default exec seam therefore spawns directly and splits stderr into lines
 * as they arrive. Resolution and rejection shapes match `promisify(execFile)`
 * (`stdout`/`stderr` strings; a rejected error carrying `code`, `stdout`,
 * `stderr`) so the git callers in this module are unaffected.
 */
const execFileAsyncDefault: ExecFileAsync = execSelfUpgradeStreaming;

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  stdout_capture?: SelfUpgradeCommandCapture;
  stderr_capture?: SelfUpgradeCommandCapture;
};

type FleetHostStatus = "pending" | "dry-run" | "succeeded" | "unverified" | "failed" | "skipped";

export interface SelfUpgradeFleetOptions {
  to?: string;
  /**
   * Optional explicit target SHA. When set, supersedes the conductor's
   * `git fetch origin && git rev-parse <to>` resolution and is passed
   * verbatim to every per-host upgrade as `--target-sha <sha>`. Useful
   * for pinned-SHA fleet rollouts (e.g. canary a specific PR head, or
   * roll the fleet back to a known-good SHA).
   *
   * When omitted, the conductor auto-resolves the SHA (POL-1151).
   */
  targetSha?: string;
  dryRun?: boolean;
  parallel?: boolean;
  hosts?: string[];
  failFast?: boolean;
  drainDeadlineMs?: number;
  yes?: boolean;
  force?: boolean;
  abortRuns?: boolean;
  drainAll?: boolean;
  /**
   * POL-1933: per-host settle sleep budget for the freshness postflight, in
   * milliseconds. Defaults to {@link DEFAULT_POSTFLIGHT_SETTLE_WINDOW_MS}; `0`
   * disables retries and makes the first probe durable.
   */
  postflightSettleWindowMs?: number;
  /**
   * POL-2046: machine mode. stdout stays the single aggregate object either
   * way; this switches the conductor's stderr progress channel from human
   * lines to NDJSON records.
   */
  json?: boolean;
}

/**
 * POL-2046: what the conductor actually saw of this host's phases. `missing`
 * means the process completed without canonical phase frames. It deliberately
 * makes no claim about the remote binary generation or why frames were absent.
 * `legacy` remains readable for already-persisted predecessor receipts only.
 */
export interface SelfUpgradeFleetHostProgressRelay {
  mode: Exclude<SelfUpgradeRelayMode, "pending">;
  phases: Array<{
    transition_id: string;
    phase: SelfUpgradeOperationPhase;
    elapsed_ms: number;
    emitted_at: string;
    synthetic: boolean;
  }>;
  truncated?: boolean;
  dropped_frames?: number;
}

export type SelfUpgradeFleetCommandCapture = Omit<SelfUpgradeCommandCapture, "text">;

export interface SelfUpgradeFleetHostResult {
  host: string;
  status: Exclude<FleetHostStatus, "pending">;
  exit_code: number;
  /** Retained directly when an oversized aggregate must omit the nested host receipt. */
  before_head?: string;
  /** Retained directly when an oversized aggregate must omit the nested host receipt. */
  after_head?: string;
  stdout_path?: string;
  stderr_path?: string;
  stdout_capture?: SelfUpgradeFleetCommandCapture;
  stderr_capture?: SelfUpgradeFleetCommandCapture;
  stderr_tail?: string;
  /**
   * Remote stderr emitted *before* the conductor's dispatch reached the host's
   * calyx CLI — shell rc output, login banners, broken third-party completion
   * hooks. It is fleet-hygiene signal, never this upgrade's diagnosis, so it is
   * partitioned away from `stderr_tail`/`error` and retained under its own key.
   */
  remote_environment_noise?: string;
  receipt_locator?: SelfUpgradeReceiptLocator;
  receipt_verification?: SelfUpgradeFleetReceiptVerification;
  plan?: SelfUpgradePlan;
  receipt?: SelfUpgradeReceipt;
  /** Typed host-local observation failures retained in the canonical fleet receipt. */
  projection_issues?: SelfUpgradeProjectionIssue[];
  /**
   * The remote bootstrap stopped before any Calyx code ran. Distinct from a
   * failed upgrade: nothing on the host moved, so the operator's next move is
   * to fix the host's git/node/pnpm and retry, not to inspect a half-upgraded
   * install.
   */
  bootstrap_failure?: RemoteBootstrapFailure;
  /** Wall-clock milliseconds this host held the conductor. */
  elapsed_ms?: number;
  progress_relay?: SelfUpgradeFleetHostProgressRelay;
  artifact_warnings?: SelfUpgradeFleetHostArtifactWarning[];
  error?: string;
}

export interface SelfUpgradeFleetHostArtifactWarning {
  code: "artifact_write_unavailable" | "artifact_write_timeout";
  artifact: "stdout" | "stderr";
  message: string;
}

/** How the host's bounded postflight probe sequence concluded. */
export type SelfUpgradeFleetPostflightSettleOutcome =
  | "settled_first_probe"
  | "settled_after_retries"
  | "unsettled_no_retries"
  | "unsettled_after_retries"
  | "probe_error";

/** Why no further postflight probe was attempted for a host. */
export type SelfUpgradeFleetPostflightStopReason =
  | "settled"
  | "not_retryable"
  | "retries_disabled"
  | "no_delay_fits"
  | "window_budget"
  | "attempt_backstop"
  | "probe_error";

export type SelfUpgradeFleetPostflightProbeErrorCode =
  | "freshness_command_failed"
  | "missing_host_result"
  | "settle_delay_failed"
  | "unexpected_probe_failure";

export type SelfUpgradeFleetPostflightRetryReason =
  | "health_unreachable"
  | "target_promoted_daemon_not_restarted";

export interface SelfUpgradeFleetPostflightProbeError {
  code: SelfUpgradeFleetPostflightProbeErrorCode;
  message: string;
  /** Wall-clock anchor from the injectable conductor clock. */
  occurred_at: string;
}

interface SelfUpgradeFleetPostflightProbeBase {
  /** 1-based probe/settle attempt index within this host's window. */
  attempt: number;
  /**
   * Settle delay scheduled immediately before this attempt (0 for the first).
   * A settle_delay_failed row records the requested delay even though it did
   * not complete; waited_ms counts only completed delays.
   */
  delay_before_ms: number;
  /** Monotonic offset from this host's first attempt start. */
  started_after_ms: number;
  /** Monotonic offset from this host's first attempt start. */
  completed_after_ms: number;
  duration_ms: number;
}

export interface SelfUpgradeFleetPostflightObservedProbe
  extends SelfUpgradeFleetPostflightProbeBase {
  status: "observed";
  /** Wall-clock observation time reported by self freshness. */
  observed_at: string;
  verdict: SelfFreshnessVerdict;
  health_status: SelfFreshnessHostResult["health"]["status"];
  /** Typed daemon-response evidence when this was an observed health error. */
  health_error?: SelfUpgradeFleetPostflightObservedHealthError;
  missing_feature_count: number;
  /** Present only when typed evidence permits another settle probe. */
  retry_reason?: SelfUpgradeFleetPostflightRetryReason;
}

export interface SelfUpgradeFleetPostflightErrorProbe
  extends SelfUpgradeFleetPostflightProbeBase {
  status: "error";
  /** Typed failure evidence; no freshness verdict is fabricated for this row. */
  error: SelfUpgradeFleetPostflightProbeError;
}

export type SelfUpgradeFleetPostflightProbe =
  | SelfUpgradeFleetPostflightObservedProbe
  | SelfUpgradeFleetPostflightErrorProbe;

export interface SelfUpgradeFleetPostflightObservedHealthError {
  kind: NonNullable<SelfFreshnessHealthSummary["error_kind"]>;
  http_status?: number;
  error_code?: string;
  response_retryable?: boolean;
  response_phase?: NonNullable<SelfFreshnessHealthSummary["response_phase"]>;
}

export interface SelfUpgradeFleetPostflightSettle {
  outcome: SelfUpgradeFleetPostflightSettleOutcome;
  stop_reason: SelfUpgradeFleetPostflightStopReason;
  attempts: number;
  /** Total settle sleep spent on this host. */
  waited_ms: number;
  /** Monotonic elapsed time from the first probe start to the terminal evidence. */
  elapsed_ms: number;
  window_ms: number;
  probes: readonly SelfUpgradeFleetPostflightProbe[];
  /** Present when a probe or its preceding settle delay failed. */
  error?: SelfUpgradeFleetPostflightProbeError;
}

export interface SelfUpgradeFleetPostflightSettleSummary {
  window_ms: number;
  max_attempts: number;
  /** Backoff ramp; the last entry repeats until the window is consumed. */
  delay_ramp_ms: readonly number[];
  hosts_probed: number;
  settled_first_probe: number;
  settled_after_retries: number;
  unsettled_no_retries: number;
  unsettled_after_retries: number;
  probe_error: number;
  total_waited_ms: number;
}

export interface SelfUpgradeFleetPostflightHost {
  host: string;
  upgrade_status: FleetHostStatus;
  freshness_verdict?: SelfFreshnessVerdict;
  health_status?: SelfFreshnessHostResult["health"]["status"];
  drift_status?: NonNullable<SelfFreshnessHostResult["drift"]>["status"];
  install_drift_status?: NonNullable<SelfFreshnessHostResult["install_drift"]>["status"];
  missing_features?: readonly string[];
  /** Last observed health-error cause, when the final verdict has one. */
  health_error?: SelfUpgradeFleetPostflightObservedHealthError;
  next_action?: string;
  /** Present exactly for hosts the postflight actually probed. */
  settle?: SelfUpgradeFleetPostflightSettle;
  error?: string;
}

interface PostflightHostProbeResult {
  /** Last truthful observation, absent when the first probe failed. */
  freshness?: SelfFreshnessHostResult;
  settle: SelfUpgradeFleetPostflightSettle;
  error?: SelfUpgradeFleetPostflightProbeError;
}

export interface SelfUpgradeFleetPostflight {
  schema_version: "self-upgrade-fleet-postflight/v1";
  status: "completed" | "failed";
  /** Conductor completion anchor after all serial probes, not a snapshot time. */
  checked_at: string;
  source_schema_version: SelfFreshnessResult["schema_version"];
  target_ref: string;
  target_sha: string;
  freshness_exit_code: number | null;
  summary: Record<SelfFreshnessVerdict, number>;
  /** Additive since POL-1933; absent on receipts written before it. */
  settle?: SelfUpgradeFleetPostflightSettleSummary;
  per_host: readonly SelfUpgradeFleetPostflightHost[];
  error?: string;
}

export interface SelfUpgradeFleetReceipt {
  schema_version: "self-upgrade-fleet-receipt/v1";
  conductor_host: string;
  target_ref: string;
  dry_run: boolean;
  parallel: boolean;
  fail_fast: boolean;
  started_at: string;
  completed_at: string;
  aggregate_dir: string;
  status: "dry-run" | "succeeded" | "unverified" | "failed";
  target_evidence: SelfUpgradeFleetTargetEvidence;
  startup_contract: SelfUpgradeFleetStartupContractAggregate;
  per_host: SelfUpgradeFleetHostResult[];
  per_host_receipt_locators: Record<string, SelfUpgradeReceiptLocator>;
  postflight?: SelfUpgradeFleetPostflight;
  /** Explicit evidence that optional detail was removed to preserve final authority. */
  bounded?: {
    reason: "size_limit";
    original_bytes: number;
    max_bytes: number;
    omitted: string[];
  };
}

export type SelfUpgradeFleetTargetEvidence =
  | {
      status: "resolved";
      original_ref: string;
      target_sha: string;
      fetch_remote: string;
      fetch_ref: string;
      startup_contract_payload_sha256: string;
    }
  | {
      status: "failed";
      error_code:
        | "target_sha_unavailable"
        | "startup_contract_evidence_unavailable";
      error: string;
    };

export interface SelfUpgradeFleetStartupContractAggregate {
  total_hosts: number;
  compatible: number;
  incompatible: number;
  unknown_blocked: number;
  unknown_nonblocking: number;
  unassessed: number;
  compatible_hosts: string[];
  incompatible_hosts: string[];
  unknown_blocked_hosts: string[];
  unknown_nonblocking_hosts: string[];
  unassessed_hosts: string[];
}

export interface SelfUpgradeFleetResult {
  /** Stable operation id == aggregate-receipt dir basename. */
  operation_id: string;
  /** Optional durable `self-upgrade-operation/v1` observation read by status/watch. */
  operation_path: string;
  /** Typed availability of the conductor observation named by operation_path. */
  operation_projection: "available" | "degraded" | "unavailable";
  operation: SelfUpgradeOperationRecord;
  receipt_path: string;
  receipt: SelfUpgradeFleetReceipt;
  text: string;
  exitCode: number;
  failureMessage?: string;
  warnings?: SelfUpgradeFleetWarning[];
}

export interface SelfUpgradeFleetWarning {
  code:
    | "fleet_convergence_persist_unavailable"
    | "upgrade_operation_projection_persist_unavailable"
    | "upgrade_event_projection_unavailable"
    | "upgrade_progress_projection_unavailable"
    | "upgrade_receipt_auth_unavailable"
    | "upgrade_transition_conflict"
    | "upgrade_relay_bounded";
  message: string;
  detail?: string;
}

export interface VerifiedRemoteReceipt {
  receipt: SelfUpgradeReceipt;
  /** The exact canonical route dereferenced to establish receipt authority. */
  locator: SelfUpgradeReceiptLocator;
  attempts?: number;
}

export interface SelfUpgradeFleetReceiptVerification {
  status: "verified" | "unavailable";
  code:
    | "verified"
    | "conductor_auth_unavailable"
    | "transport_unavailable"
    | "route_unavailable"
    | "receipt_binding_unavailable";
  attempts: number;
  locator?: SelfUpgradeReceiptLocator;
  message?: string;
}

export interface SelfUpgradeFleetDependencies {
  now?: () => string;
  homeDir?: () => string;
  execFileAsync?: ExecFileAsync;
  resolveAgentsInfraRoot?: () => Promise<string | undefined>;
  resolveCurrentHostAlias?: (host?: string, agentsInfraRoot?: string) => Promise<string>;
  listRunServeHosts?: (agentsInfraRoot: string) => Promise<RunServeHostTarget[]>;
  listDescriptors?: typeof listDescriptors;
  /** Resolve one normalized conductor authority via targeted fetch + FETCH_HEAD. */
  resolveConductorTargetEvidence?: (
    targetRef: string,
    conductorHost: string,
    explicitTargetSha?: string,
  ) => Promise<SelfUpgradeTargetEvidence | undefined>;
  /** Read, validate, digest, and SHA-bind the target manifest on the conductor. */
  resolveConductorStartupContractPayload?: (targetSha: string, conductorHost: string) => Promise<string>;
  resolveConductorCheckoutSha?: (conductorHost: string) => Promise<string | undefined>;
  /**
   * Absolute path of a remote host's calyx checkout, from fleet truth. The
   * preamble needs it as argv `$1`, and it cannot be guessed: `mba` and
   * `carbon` do not share blade's home prefix. A host with no registered
   * checkout fails that host explicitly rather than dispatching a guess.
   */
  resolveRemoteCloneRoot?: (host: string) => Promise<string>;
  /**
   * POL-1145: when the conductor is itself a fleet target, invoke the
   * single-host upgrade in-process instead of ssh-ing to itself. Defaults
   * to `runSelfUpgrade`. Tests can inject a stub to assert the local path
   * is taken (or skipped) without spinning up the real upgrade routine.
   */
  runLocalUpgrade?: (
    options: SelfUpgradeOptions,
    dependencies?: { onPhase?: (event: SelfUpgradePhaseEvent) => void },
  ) => Promise<SelfUpgradeResult>;
  runFreshnessCommand?: (
    options: SelfFreshnessCommandOptions,
    deps?: SelfFreshnessCommandDeps,
  ) => Promise<SelfFreshnessResult>;
  /** Postflight settle sleep; injected so tests exercise the window without wall time. */
  sleep?: (ms: number) => Promise<void>;
  /** Read and validate the host-owned durable receipt named by a success result. */
  verifyRemoteReceipt?: (
    host: string,
    receiptPath: string,
    projectedReceipt: SelfUpgradeReceipt,
    runServeUrl: string,
    fleetOperationId: string,
  ) => Promise<VerifiedRemoteReceipt>;
  /** Testable production credential path for the canonical receipt route. */
  resolveReceiptAuthToken?: (host: string) => Promise<string | undefined>;
  /** Generated privileged client factory used to dereference host-qualified receipt locators. */
  createAdminClient?: typeof createCalyxAdminClient;
  /** Conductor observation-writer claim seam for projection fault tests. */
  claimOperation?: typeof claimSelfUpgradeOperation;
  /** Maximum time an observation-writer claim may delay host dispatch. */
  operationClaimSettleTimeoutMs?: number;
  authToken?: string;
  persistConvergence?: boolean;
  /** POL-2046 progress sink; defaults to the conductor's stderr. */
  progressWrite?: (chunk: string) => void;
  /** Native stream seam used to exercise asynchronous close/EPIPE behavior. */
  progressStream?: Writable;
  /** Test seam for conductor event-log projections; never execution authority. */
  appendEventProjection?: typeof appendControlEvent;
  /** Maximum time one event-log projection may delay conductor progress. */
  eventProjectionSettleTimeoutMs?: number;
  /** Projection/event timestamp clock; separate from receipt lifecycle time. */
  progressNow?: () => string;
  /** Monotonic clock for per-host elapsed and heartbeat quiet detection. */
  monotonicNowMs?: () => number;
  /** Quiet period before the conductor prints a per-host elapsed heartbeat. */
  heartbeatIntervalMs?: number;
  /** Diagnostic artifact seam; failures and timeouts are fail-open. */
  writeArtifact?: (targetPath: string, contents: string) => Promise<void>;
  artifactSettleTimeoutMs?: number;
  /** Canonical aggregate-receipt writer seam for durability boundary tests. */
  writeFleetReceipt?: (targetPath: string, contents: string) => Promise<void>;
  /** Deterministic aggregate-size seam; production uses the exported hard bound. */
  fleetReceiptMaxBytes?: number;
  /** Deterministic held-cwd portability seam for receipt authority tests. */
  durableDirectoryOpenOptions?: DurableDirectoryOpenOptions;
  /** Deterministic race seam immediately before aggregate retention mutation. */
  afterFleetReceiptRootValidatedBeforeRetention?: () => Promise<void>;
}

type FleetUpgradeError = Error & { exitCode: number };

function createFleetUpgradeError(message: string, exitCode = 1): FleetUpgradeError {
  const error = new Error(message) as FleetUpgradeError;
  error.exitCode = exitCode;
  return error;
}

function normalizeHostAlias(value: string): string {
  return value.trim().toLowerCase().replace(/\..*$/, "");
}

function canonicalFleetHostAlias(value: string): string {
  const normalized = normalizeHostAlias(value);
  if (
    !FLEET_HOST_ALIAS_PATTERN.test(normalized)
    || /[\\/\0\r\n]/u.test(value)
    || value.trim() === "."
    || value.trim() === ".."
  ) {
    throw createFleetUpgradeError(`Fleet host alias is not path-safe: ${JSON.stringify(value)}`, 2);
  }
  return normalized;
}

function receiptOperationId(receiptPath: string): string | undefined {
  if (!path.posix.isAbsolute(receiptPath) || /[\0\r\n]/u.test(receiptPath)) {
    return undefined;
  }
  const operationId = path.posix.basename(receiptPath, ".json");
  if (
    path.posix.extname(receiptPath) !== ".json"
    || path.posix.basename(path.posix.dirname(receiptPath)) !== "self-upgrade-receipts"
    || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254})$/u.test(operationId)
    || operationId === "."
    || operationId === ".."
  ) {
    return undefined;
  }
  return operationId;
}

function hostReceiptLocator(host: string, receiptPath: string): SelfUpgradeReceiptLocator | undefined {
  const operationId = receiptOperationId(receiptPath);
  if (!operationId) return undefined;
  return selfUpgradeReceiptLocatorSchema.parse({
    host: canonicalFleetHostAlias(host),
    route: adminOperationRoutes.selfUpgrade.receipt({ operationId }),
  });
}

function persistenceWarning(message: string, detail?: string): SelfUpgradeFleetWarning {
  return {
    code: "fleet_convergence_persist_unavailable",
    message,
    ...(detail ? { detail } : {}),
  };
}

function parseRequestedHosts(hosts: string[] | undefined): string[] {
  if (!hosts || hosts.length === 0) {
    return [];
  }
  const normalized = hosts
    .flatMap((entry) => entry.split(","))
    .filter((entry) => entry.trim().length > 0)
    .map((entry) => canonicalFleetHostAlias(entry))
    .filter((entry, index, values) => entry.length > 0 && values.indexOf(entry) === index);
  return normalized;
}

function formatTimestampForFilename(value: string): string {
  return value.replace(/[:.]/g, "-");
}

async function writeFleetArtifactDurable(
  targetPath: string,
  contents: string,
  heldAnchor?: DurableDirectoryAnchor,
): Promise<void> {
  const canonicalTarget = path.resolve(targetPath);
  const directory = path.dirname(canonicalTarget);
  const basename = path.basename(canonicalTarget);
  const anchor = heldAnchor ?? await openExistingDirectoryDurable(directory);
  const ownsAnchor = heldAnchor === undefined;
  if (path.resolve(anchor.directory) !== directory) {
    if (ownsAnchor) await anchor.close().catch(() => undefined);
    throw new Error(`Fleet artifact escaped its held authority directory: ${targetPath}`);
  }
  const temporaryName = `${basename}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await anchor.assertCanonical();
    await anchor.authority.replaceFile(
      basename,
      temporaryName,
      contents,
      FLEET_RECEIPT_FILE_MODE,
    );
    await anchor.assertCanonical();
  } finally {
    if (ownsAnchor) {
      await anchor.close().catch(() => undefined);
    }
  }
}

async function pruneFleetReceiptDirectories(
  rootAnchor: DurableDirectoryAnchor,
  nowMs: number,
  directoryOpenOptions: DurableDirectoryOpenOptions,
): Promise<void> {
  const entries: Array<{ name: string; mtimeMs: number }> = [];
  for (const entry of await rootAnchor.authority.readdir()) {
    if (entry.kind !== "directory" || !entry.name.startsWith("fleet-")) {
      continue;
    }
    entries.push({ name: entry.name, mtimeMs: (await rootAnchor.authority.lstat(entry.name)).mtimeMs });
  }
  entries.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  let removed = false;
  const retainedPrevious = Math.max(0, FLEET_RECEIPT_RETENTION_COUNT - 1);
  for (const [index, entry] of entries.entries()) {
    if (nowMs - entry.mtimeMs < FLEET_RECEIPT_RETENTION_MS && index < retainedPrevious) {
      continue;
    }
    let removable = false;
    let receiptAnchor: DurableDirectoryAnchor | undefined;
    try {
      receiptAnchor = await openChildDirectoryDurable(rootAnchor, entry.name, directoryOpenOptions);
      const parsed = JSON.parse(await receiptAnchor.authority.readFile(
        "summary.json",
        SELF_UPGRADE_FLEET_RECEIPT_MAX_BYTES,
      )) as {
        schema_version?: unknown;
        status?: unknown;
      };
      removable = parsed.schema_version === "self-upgrade-fleet-receipt/v1"
        && (
          parsed.status === "dry-run"
          || parsed.status === "succeeded"
          || parsed.status === "unverified"
          || parsed.status === "failed"
        );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Only an absent summary in a directory that we opened by verified child
      // identity is an incomplete receipt. Oversized, malformed, unreadable,
      // or stale-identity evidence must remain available for diagnosis, and a
      // failed child open must never authorize deletion through an ancestor
      // replacement.
      const missingVerifiedChildSummary = receiptAnchor !== undefined && code === "ENOENT";
      removable = missingVerifiedChildSummary && (
        nowMs - entry.mtimeMs >= FLEET_RECEIPT_INCOMPLETE_RETENTION_MS
        || index >= FLEET_RECEIPT_INCOMPLETE_RETENTION_COUNT - 1
      );
    } finally {
      await receiptAnchor?.close().catch(() => undefined);
    }
    if (!removable) {
      continue;
    }
    await rootAnchor.authority.remove(entry.name, { recursive: true, force: true });
    removed = true;
  }
  if (removed) await rootAnchor.sync();
}

async function createFleetReceiptDirectory(
  homeDir: string,
  operationId: string,
  nowMs: number,
  directoryOpenOptions: DurableDirectoryOpenOptions,
  afterRootValidatedBeforeRetention: () => Promise<void>,
): Promise<DurableDirectoryAnchor> {
  const root = path.join(homeDir, ".calyx", "self-upgrade-receipts");
  const rootAnchor = await openPrivateDirectoryDurable(
    root,
    FLEET_RECEIPT_DIRECTORY_MODE,
    directoryOpenOptions,
  );
  try {
    await rootAnchor.assertCanonical();
    await afterRootValidatedBeforeRetention();
    await pruneFleetReceiptDirectories(rootAnchor, nowMs, directoryOpenOptions);
    await rootAnchor.assertCanonical();
    await rootAnchor.authority.mkdir(operationId, FLEET_RECEIPT_DIRECTORY_MODE);
    await rootAnchor.sync();
    await rootAnchor.assertCanonical();
    const aggregateAnchor = await openChildDirectoryDurable(
      rootAnchor,
      operationId,
      directoryOpenOptions,
    );
    try {
      await aggregateAnchor.chmod(FLEET_RECEIPT_DIRECTORY_MODE);
      await aggregateAnchor.sync();
      await aggregateAnchor.assertCanonical();
      return aggregateAnchor;
    } catch (error) {
      await aggregateAnchor.close().catch(() => undefined);
      throw error;
    }
  } finally {
    await rootAnchor.close().catch(() => undefined);
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Marker the dispatch script writes to stderr immediately before handing off to
 * the host's calyx CLI.
 *
 * ssh runs the remote command through the target user's *login shell*, and bash
 * reads `~/.bashrc` whenever its stdin is a network connection. Any rc noise —
 * banners, deprecation warnings, a third-party shell-completion hook whose
 * binary is broken — therefore lands on the same stderr stream the conductor
 * reads, before the upgrade has begun. Without a boundary the conductor cannot
 * tell the host's diagnosis from its neighbours' and reports whichever bytes
 * arrived, so an unrelated broken tool on the host becomes the recorded cause
 * of an upgrade failure.
 *
 * The marker is emitted by `printf` in the conductor-authored script, not by
 * the remote CLI, so it costs the remote install no capability at all: a host
 * running an arbitrarily old calyx still partitions correctly. It is bound to
 * the operation id and host so ambient output cannot forge it.
 */
export function remoteStderrBoundaryMarker(fleetOperationId: string, host: string): string {
  return `__calyx_self_upgrade_stderr_boundary/v1 ${fleetOperationId} ${host}`;
}

/**
 * Split remote stderr into pre-dispatch environment noise and output
 * attributable to the host's calyx invocation.
 *
 * Splits on the *last* marker occurrence so an rc file that echoes its own
 * input cannot shift the boundary earlier. A missing marker means the dispatch
 * never got far enough to print it (ssh failure, shell exec failure), so every
 * byte stays attributed — the pre-marker behaviour, unchanged.
 */
export function partitionRemoteStderr(
  stderr: string,
  marker: string,
): { environment: string; attributed: string } {
  const index = stderr.lastIndexOf(marker);
  if (index < 0) {
    return { environment: "", attributed: stderr };
  }
  const after = stderr.slice(index + marker.length);
  return {
    environment: stderr.slice(0, index),
    attributed: after.startsWith("\n") ? after.slice(1) : after,
  };
}

function tailText(value: string, lines = STDERR_TAIL_LINES): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.split(/\r?\n/).slice(-lines).join("\n");
}

function captureSummary(
  capture: SelfUpgradeCommandCapture | undefined,
): SelfUpgradeFleetCommandCapture | undefined {
  if (!capture) {
    return undefined;
  }
  return {
    captured_bytes: capture.captured_bytes,
    dropped_bytes: capture.dropped_bytes,
    truncated: capture.truncated,
  };
}

function commandCaptureFields(command: CommandResult): Pick<
  SelfUpgradeFleetHostResult,
  "stdout_capture" | "stderr_capture"
> {
  const stdoutCapture = captureSummary(command.stdout_capture);
  const stderrCapture = captureSummary(command.stderr_capture);
  return {
    ...(stdoutCapture ? { stdout_capture: stdoutCapture } : {}),
    ...(stderrCapture ? { stderr_capture: stderrCapture } : {}),
  };
}

/**
 * The conductor→remote dispatch contract.
 *
 * ## Why this is a preamble and not an argv
 *
 * A fleet upgrade is an operation between two versions of Calyx by
 * construction: the conductor runs the version it has, the remote runs the one
 * it is about to replace. Every flag the conductor used to append to
 * `calyx self upgrade` was therefore a fact derived from a flag table on
 * another machine, in another build, that no checker on either side could read.
 * `0f8128a` added `--target-fetch-remote`, `--target-fetch-ref` and
 * `--startup-contract-payload`; none of the four fleet hosts had a build that
 * accepted them, and nothing failed until dispatch.
 *
 * The preamble ends that class of defect by carrying **no upgrade semantics at
 * all**. Its four positional arguments are irreducible facts about git, its
 * stdin is opaque bytes it never parses, and it `exec`s rather than spawns so
 * it cannot become a version-skewed supervisor. Because the conductor emits it
 * fresh on every dispatch it is never installed, so it can never be stale;
 * because it is frozen, a conductor of any age can emit it and a remote of any
 * age can run it.
 *
 * Everything that *is* version-dependent — the planner's flag table, the
 * relay's environment variables, the secrets wrapper — is decided by
 * `scripts/calyx-upgrade-agent.mjs`, read out of the target commit the remote
 * has just fetched. That file and the flag table it speaks always ship in the
 * same commit, so one CI process can check them against each other.
 *
 * ## The frozen contract
 *
 * - argv: exactly four positional arguments, no flags, ever —
 *   `$1` clone root · `$2` fetch remote · `$3` fetch ref · `$4` 40-hex target SHA.
 * - stdin: one UTF-8 versioned `calyx-upgrade-plan/*` JSON object,
 *   newline-terminated,
 *   at most {@link REMOTE_PLAN_MAX_BYTES} bytes, first key `schema_version`.
 *   The preamble never reads it; `exec` hands the open pipe to the agent.
 * - stdout: at most one JSON object, and only on the bootstrap's own failure.
 * - stderr: unstructured, never parsed for authority.
 * - exit: {@link REMOTE_BOOTSTRAP_EXIT_CODE} when the bootstrap could not reach
 *   the target agent and no host state was touched; `0` when the target ran and
 *   wrote its envelope (the envelope carries the verdict, not the code);
 *   anything else is the target's own exit code.
 */
export const REMOTE_BOOTSTRAP_ENVELOPE_SCHEMA = "calyx-upgrade-preamble/v1";
/** No host state was touched: the conductor must not record an upgrade attempt. */
export const REMOTE_BOOTSTRAP_EXIT_CODE = 78;
export const REMOTE_UPGRADE_PLAN_SCHEMA = "calyx-upgrade-plan/v2";
/**
 * Written into the scratch tree by the preamble and required by the agent. It
 * is the agent's only authority to recursively delete the tree it runs from.
 */
export const REMOTE_SCRATCH_MARKER_FILENAME = ".calyx-upgrade-scratch";
const REMOTE_NODE_FLOOR = "22.13.0";

/** One host's dispatch instructions. Written here, validated by the agent. */
export interface RemoteUpgradePlan {
  schema_version: typeof REMOTE_UPGRADE_PLAN_SCHEMA;
  fleet_operation_id: string;
  host: string;
  clone_root: string;
  target: {
    original_ref: string;
    target_sha: string;
    fetch_remote: string;
    fetch_ref: string;
  };
  request: {
    dry_run: boolean;
    yes: boolean;
    force: boolean;
    abort_runs: boolean;
    drain_all: boolean;
    drain_deadline_ms: number;
  };
  startup_contract_payload: string | null;
  progress_relay: { schema: "self-upgrade-operation/v1" } | null;
}

const remoteBootstrapFailureSchema = z.object({
  schema_version: z.literal(REMOTE_BOOTSTRAP_ENVELOPE_SCHEMA),
  status: z.literal("preamble_failed"),
  code: z.string().trim().min(1).max(128),
  message: z.string().trim().min(1).max(4_096),
}).strip();

/** The bootstrap's sole self-authored output, emitted only when it fails. */
export type RemoteBootstrapFailure = z.infer<typeof remoteBootstrapFailureSchema>;

/**
 * Emit the frozen preamble.
 *
 * The only interpolated value is the stderr boundary marker, which the preamble
 * `printf`s before doing anything else so an rc file's banner cannot be
 * mistaken for this host's diagnosis (#322). Every failure message is a fixed
 * literal — no host output and none of the four arguments is ever spliced into
 * the JSON envelope, so its bytes are valid by construction.
 */
export function buildRemotePreamble(fleetOperationId: string, host: string): string {
  const marker = shellEscape(remoteStderrBoundaryMarker(fleetOperationId, host));
  const nodeFloorProbe =
    "const v=process.versions.node.split(\".\").map(Number);"
    + "process.exit(v[0]>22||(v[0]===22&&v[1]>=13)?0:1)";
  return [
    "set -u",
    `printf '%s\\n' ${marker} >&2`,
    "__calyx_scratch=''",
    "__calyx_fail() {",
    // Nothing reached the agent, so nothing is left to own the scratch tree.
    // A bootstrap that fails after materialising it must take it with it, or a
    // host that keeps failing keeps accumulating checkouts in /tmp.
    "  [ -z \"$__calyx_scratch\" ] || rm -rf \"$__calyx_scratch\"",
    `  printf '{"schema_version":"${REMOTE_BOOTSTRAP_ENVELOPE_SCHEMA}","status":"preamble_failed","code":"%s","message":"%s"}\\n' "$1" "$2"`,
    `  exit ${REMOTE_BOOTSTRAP_EXIT_CODE}`,
    "}",
    "[ \"$#\" -eq 4 ] || __calyx_fail preamble_arity 'the preamble takes exactly four positional arguments'",
    "case \"$1\" in /*) ;; *) __calyx_fail clone_root_invalid 'the clone root is not an absolute path' ;; esac",
    "case \"$4\" in *[!0-9a-f]*|'') __calyx_fail target_sha_invalid 'the target sha is not lowercase 40-hex' ;; esac",
    "[ ${#4} -eq 40 ] || __calyx_fail target_sha_invalid 'the target sha is not lowercase 40-hex'",
    // A fixed search path: the preamble has to find git and hand the agent a
    // usable PATH without depending on how the host's shell init behaves.
    "PATH=\"/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$HOME/.local/bin:$HOME/.local/share/pnpm:$PATH\"; export PATH",
    "command -v git >/dev/null 2>&1 || __calyx_fail git_unavailable 'git is not on the remote PATH'",
    "[ -e \"$1/.git\" ] || __calyx_fail clone_root_invalid 'the clone root is not a git checkout'",
    "__calyx_node=''",
    "for __calyx_candidate in \"$HOME\"/.nvm/versions/node/*/bin/node \"$(command -v node 2>/dev/null || true)\" /usr/local/bin/node /opt/homebrew/bin/node \"$HOME/.local/bin/node\" \"$HOME/.local/share/pnpm/node\" /usr/bin/node; do",
    "  [ -x \"$__calyx_candidate\" ] || continue",
    `  "$__calyx_candidate" -e ${shellEscape(nodeFloorProbe)} </dev/null >/dev/null 2>&1 || continue`,
    "  __calyx_node=\"$__calyx_candidate\"",
    "  break",
    "done",
    `[ -n "$__calyx_node" ] || __calyx_fail node_unavailable 'no node >=${REMOTE_NODE_FLOOR} was found on the remote host'`,
    "PATH=\"$(dirname \"$__calyx_node\"):$PATH\"; export PATH",
    // git's own stdout goes to stderr: stdout belongs to the terminal JSON
    // contract and to nothing else.
    "git -C \"$1\" fetch --no-tags -- \"$2\" \"$3\" </dev/null >&2 || __calyx_fail fetch_failed 'git fetch of the target ref failed'",
    "git -C \"$1\" merge-base --is-ancestor \"$4\" FETCH_HEAD </dev/null >&2 || __calyx_fail target_unreachable 'the target sha is not an ancestor of the fetched ref'",
    "__calyx_scratch=\"$(mktemp -d \"${TMPDIR:-/tmp}/calyx-upgrade-XXXXXXXX\" || true)\"",
    "[ -n \"$__calyx_scratch\" ] || __calyx_fail scratch_unavailable 'could not create a scratch directory'",
    // `--shared` borrows the clone's object database instead of copying it, so
    // materialising the target tree costs no network and leaves the host's
    // checkout — its HEAD, its index, its build output — entirely untouched.
    // A dry run must be able to answer from the target's own planner without
    // moving the thing it is reporting on.
    "git clone --quiet --shared --no-checkout -- \"$1\" \"$__calyx_scratch\" </dev/null >&2 || __calyx_fail scratch_unavailable 'could not materialise the target tree'",
    "git -C \"$__calyx_scratch\" checkout --quiet --detach \"$4\" </dev/null >&2 || __calyx_fail scratch_unavailable 'could not check out the target commit'",
    // Evidence, left for the agent, that this tree is a throwaway the bootstrap
    // created. The agent builds into this tree and deletes it on the way out;
    // it must never infer ownership from its own file path, because being wrong
    // about that destroys a real checkout.
    `printf '%s\\n' "$4" > "$__calyx_scratch/${REMOTE_SCRATCH_MARKER_FILENAME}" || __calyx_fail scratch_unavailable 'could not claim the scratch directory'`,
    "[ -f \"$__calyx_scratch/scripts/calyx-upgrade-agent.mjs\" ] || __calyx_fail agent_missing 'the target commit carries no scripts/calyx-upgrade-agent.mjs'",
    // exec, not spawn: from here the preamble owns nothing, holds nothing open,
    // and cannot interpose itself between the agent and the conductor.
    "exec \"$__calyx_node\" \"$__calyx_scratch/scripts/calyx-upgrade-agent.mjs\" \"$1\" \"$2\" \"$3\" \"$4\"",
  ].join("\n");
}

/** The exact remote command string ssh hands to the login shell. */
export function buildRemoteDispatchCommand(
  fleetOperationId: string,
  host: string,
  cloneRoot: string,
  targetEvidence: SelfUpgradeTargetEvidence,
): string {
  return [
    "bash",
    "-c",
    shellEscape(buildRemotePreamble(fleetOperationId, host)),
    "calyx-upgrade-preamble",
    shellEscape(cloneRoot),
    shellEscape(targetEvidence.fetch_remote),
    shellEscape(targetEvidence.fetch_ref),
    shellEscape(targetEvidence.target_sha),
  ].join(" ");
}

/** Build one host's plan. `schema_version` is deliberately the first key. */
export function buildRemoteUpgradePlan(args: {
  fleetOperationId: string;
  host: string;
  cloneRoot: string;
  targetEvidence: SelfUpgradeTargetEvidence;
  startupContractPayload: string | undefined;
  options: Required<Pick<SelfUpgradeFleetOptions, "dryRun" | "drainDeadlineMs" | "yes" | "force" | "abortRuns" | "drainAll">>;
}): RemoteUpgradePlan {
  return {
    schema_version: REMOTE_UPGRADE_PLAN_SCHEMA,
    fleet_operation_id: args.fleetOperationId,
    host: args.host,
    clone_root: args.cloneRoot,
    target: {
      original_ref: args.targetEvidence.original_ref,
      target_sha: args.targetEvidence.target_sha,
      fetch_remote: args.targetEvidence.fetch_remote,
      fetch_ref: args.targetEvidence.fetch_ref,
    },
    request: {
      dry_run: args.options.dryRun,
      yes: args.options.yes,
      force: args.options.force,
      abort_runs: args.options.abortRuns,
      drain_all: args.options.drainAll,
      drain_deadline_ms: args.options.drainDeadlineMs,
    },
    startup_contract_payload: args.startupContractPayload ?? null,
    // The relay is private single-hop process context, not a CLI or API
    // surface. The agent turns it into the planner's environment.
    progress_relay: { schema: "self-upgrade-operation/v1" },
  };
}

/** Serialize a plan for stdin, refusing anything the agent would reject. */
export function encodeRemoteUpgradePlan(plan: RemoteUpgradePlan): string {
  const encoded = `${JSON.stringify(plan)}\n`;
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > REMOTE_PLAN_MAX_BYTES) {
    throw new Error(
      `Remote upgrade plan for ${plan.host} is ${bytes} bytes, over the ${REMOTE_PLAN_MAX_BYTES}-byte stdin budget.`,
    );
  }
  return encoded;
}

/**
 * Recover the bootstrap's failure envelope from stdout.
 *
 * Scanned backwards from the last non-empty line because an rc file that greets
 * non-interactive ssh sessions can still print to stdout ahead of us — the
 * boundary marker only partitions stderr.
 */
export function parseRemoteBootstrapFailure(stdout: string): RemoteBootstrapFailure | undefined {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line.startsWith("{") || !line.includes(REMOTE_BOOTSTRAP_ENVELOPE_SCHEMA)) {
      continue;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = remoteBootstrapFailureSchema.safeParse(decoded);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

async function defaultExecRemoteCommand(
  host: string,
  command: string,
  plan: string,
  execFileAsync: ExecFileAsync,
  onStderrLine: (line: string) => void,
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(
      "ssh",
      [
        // Non-interactive safety rails: fail fast on unreachable hosts and
        // detect mid-transaction hangs so a single wedged host doesn't block
        // the rest of the serial fleet upgrade.
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "BatchMode=yes",
        host,
        command,
      ],
      { encoding: "utf8", maxBuffer: DEFAULT_COMMAND_MAX_BUFFER, onStderrLine, stdin: plan },
    );
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.stdout_capture ? { stdout_capture: result.stdout_capture } : {}),
      ...(result.stderr_capture ? { stderr_capture: result.stderr_capture } : {}),
    };
  } catch (error) {
    const typed = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
      stdout_capture?: SelfUpgradeCommandCapture;
      stderr_capture?: SelfUpgradeCommandCapture;
      message?: string;
    };
    return {
      code: typeof typed.code === "number" ? typed.code : 255,
      stdout: typed.stdout ?? "",
      stderr: typed.stderr ?? typed.message ?? "ssh invocation failed",
      ...(typed.stdout_capture ? { stdout_capture: typed.stdout_capture } : {}),
      ...(typed.stderr_capture ? { stderr_capture: typed.stderr_capture } : {}),
    };
  }
}

class RemoteReceiptVerificationUnavailableError extends Error {
  readonly verification: SelfUpgradeFleetReceiptVerification;

  constructor(verification: SelfUpgradeFleetReceiptVerification) {
    super(verification.message ?? verification.code);
    this.name = "RemoteReceiptVerificationUnavailableError";
    this.verification = verification;
  }
}

function assertReceiptInvocationBinding(args: {
  host: string;
  receiptPath: string;
  receipt: SelfUpgradeReceipt;
  expectedFleetOperationId: string;
  locator: SelfUpgradeReceiptLocator;
  attempts: number;
}): void {
  const operationId = receiptOperationId(args.receiptPath);
  if (!operationId) {
    throw new Error(`Remote receipt path is not a canonical self-upgrade receipt for ${args.host}.`);
  }
  if (!args.receipt.operation_id || !args.receipt.fleet_operation_id) {
    throw new RemoteReceiptVerificationUnavailableError({
      status: "unavailable",
      code: "receipt_binding_unavailable",
      attempts: args.attempts,
      locator: args.locator,
      message: `Canonical receipt for ${canonicalFleetHostAlias(args.host)} lacks a durable current-fleet operation binding.`,
    });
  }
  if (args.receipt.operation_id !== operationId) {
    throw new Error(
      `Canonical receipt operation_id does not match its route for ${canonicalFleetHostAlias(args.host)}.`,
    );
  }
  if (args.receipt.fleet_operation_id !== args.expectedFleetOperationId) {
    throw new Error(
      `Canonical receipt fleet_operation_id does not match the current dispatch for ${canonicalFleetHostAlias(args.host)}.`,
    );
  }
}

async function defaultVerifyRemoteReceipt(
  host: string,
  receiptPath: string,
  _projectedReceipt: SelfUpgradeReceipt,
  runServeUrl: string,
  expectedFleetOperationId: string,
  explicitAuthToken: string,
  createAdminClient: typeof createCalyxAdminClient,
  resolveReceiptAuthToken: (host: string) => Promise<string | undefined>,
  sleep: (ms: number) => Promise<void>,
): Promise<VerifiedRemoteReceipt> {
  const operationId = receiptOperationId(receiptPath);
  if (!operationId) {
    throw new Error(`Remote receipt path is not a canonical self-upgrade receipt for ${host}.`);
  }
  const canonicalHost = canonicalFleetHostAlias(host);
  const locator = hostReceiptLocator(canonicalHost, receiptPath)!;
  const serverUrl = runServeUrl.trim();
  if (!serverUrl) {
    throw new RemoteReceiptVerificationUnavailableError({
      status: "unavailable",
      code: "route_unavailable",
      attempts: 0,
      locator,
      message: `Canonical receipt route is unavailable for ${canonicalHost}: run_serve_url is not configured.`,
    });
  }
  let authToken = explicitAuthToken.trim();
  if (!authToken) {
    try {
      authToken = (await resolveReceiptAuthToken(canonicalHost))?.trim() ?? "";
    } catch (error) {
      throw new RemoteReceiptVerificationUnavailableError({
        status: "unavailable",
        code: "conductor_auth_unavailable",
        attempts: 0,
        locator,
        message: `Conductor operator_cli credential resolution failed for ${canonicalHost}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  if (!authToken) {
    throw new RemoteReceiptVerificationUnavailableError({
      status: "unavailable",
      code: "conductor_auth_unavailable",
      attempts: 0,
      locator,
      message: `Conductor operator_cli credential is unavailable for ${canonicalHost}.`,
    });
  }
  const client = createAdminClient({
    baseUrl: serverUrl,
    bearerToken: authToken,
    // This call has an explicit cross-attempt receipt-verification budget below.
    retry: { maxAttempts: 1 },
  });

  for (let attempt = 1; attempt <= REMOTE_RECEIPT_DEREFERENCE_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REMOTE_RECEIPT_DEREFERENCE_ATTEMPT_TIMEOUT_MS);
    let result: CalyxResult<unknown, string>;
    try {
      result = await client.admin.selfUpgrade.receipt({
        path: { operationId },
        signal: controller.signal,
      });
    } catch (error) {
      if (attempt < REMOTE_RECEIPT_DEREFERENCE_MAX_ATTEMPTS) {
        await sleep(REMOTE_RECEIPT_DEREFERENCE_RETRY_DELAYS_MS[attempt - 1] ?? 0);
        continue;
      }
      throw new RemoteReceiptVerificationUnavailableError({
        status: "unavailable",
        code: "transport_unavailable",
        attempts: attempt,
        locator,
        message: `Canonical receipt transport remained unavailable for ${canonicalHost} after ${attempt} attempts: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!result.ok) {
      const status = result.kind === "api" || result.kind === "protocol"
        ? result.status
        : undefined;
      const code = result.kind === "api" ? String(result.error.error.code) : undefined;
      const message = result.kind === "api"
        ? result.error.error.message
        : result.kind === "transport" || result.kind === "protocol"
          ? result.message
          : "generated receipt read returned an impossible indeterminate result";
      const detail = status === undefined
        ? message
        : `HTTP ${status}${code ? ` (${code})` : ""}: ${message}`;
      const retryable = result.kind === "transport"
        || (
          result.kind === "api"
          && (
            result.error.error.retryable === true
            || (
              result.error.error.retryable === undefined
              && (result.status === 429 || result.status >= 500)
            )
          )
        )
        || result.kind === "protocol";
      if (retryable && attempt < REMOTE_RECEIPT_DEREFERENCE_MAX_ATTEMPTS) {
        await sleep(REMOTE_RECEIPT_DEREFERENCE_RETRY_DELAYS_MS[attempt - 1] ?? 0);
        continue;
      }
      if (
        result.kind === "api"
        && result.status === 422
        && result.error.error.code === "self_upgrade_receipt_invalid"
      ) {
        throw new Error(`Canonical receipt route rejected ${canonicalHost}: ${detail}.`);
      }
      throw new RemoteReceiptVerificationUnavailableError({
        status: "unavailable",
        code: status === 401 || status === 403
          ? "conductor_auth_unavailable"
          : status === 404
            ? "route_unavailable"
            : "transport_unavailable",
        attempts: attempt,
        locator,
        message: `Canonical receipt route is unavailable for ${canonicalHost}: ${detail}.`,
      });
    }
    const receipt = remoteReceiptSchema.parse(result.data) as unknown as SelfUpgradeReceipt;
    assertReceiptInvocationBinding({
      host: canonicalHost,
      receiptPath,
      receipt,
      expectedFleetOperationId,
      locator,
      attempts: attempt,
    });
    return { receipt, locator, attempts: attempt };
  }

  throw new Error(`Canonical receipt dereference exhausted unexpectedly for ${canonicalHost}.`);
}

const fullGitShaSchema = z.string().regex(/^[0-9a-f]{40}$/iu);
const remoteReceiptPathSchema = z.string().trim().min(1).refine(
  (value) => path.posix.isAbsolute(value) && !/[\0\r\n]/u.test(value),
  "remote receipt path must be a safe absolute path",
);
const remoteTargetEvidenceSchema = z.object({
  original_ref: z.string().trim().min(1),
  target_sha: fullGitShaSchema,
  fetch_remote: z.string().trim().min(1),
  fetch_ref: z.string().trim().min(1),
}).passthrough();
const remotePlanSchema = z.object({
  host: z.string().trim().min(1),
  repo_root: z.string().trim().min(1),
  current_head: fullGitShaSchema,
  target_ref: z.string().trim().min(1),
  target_head: fullGitShaSchema.optional(),
  target_evidence: remoteTargetEvidenceSchema,
}).passthrough().refine(
  (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= REMOTE_PLAN_MAX_BYTES,
  `remote self-upgrade plan must not exceed ${REMOTE_PLAN_MAX_BYTES} bytes`,
);
const remoteReceiptSchema = z.object({
  schema_version: z.literal("self-upgrade-receipt/v1"),
  operation_id: z.string().min(1).max(255).regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254})$/u).optional(),
  fleet_operation_id: z.string().min(1).max(255).regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254})$/u).optional(),
  host: z.string().trim().min(1),
  target_ref: z.string().trim().min(1),
  target_evidence: remoteTargetEvidenceSchema,
  status: z.enum(["succeeded", "failed"]),
  started_at: z.string().datetime({ offset: true }),
  completed_at: z.string().datetime({ offset: true }),
  repo_root: z.string().trim().min(1),
  before_head: fullGitShaSchema,
  after_head: fullGitShaSchema.optional(),
  commit_list: z.array(z.string()),
  before_builds: z.array(z.object({
    daemon_id: z.string().trim().min(1),
    pid: z.number().int().positive(),
    build: z.object({}).passthrough(),
  }).passthrough()),
  after_builds: z.array(z.object({
    daemon_id: z.string().trim().min(1),
    pid: z.number().int().positive().optional(),
    build: z.object({}).passthrough().optional(),
  }).passthrough()),
  active_run_classification: z.array(z.object({
    run_id: z.string().trim().min(1),
    runs_root: z.string().trim().min(1),
    state: z.string().trim().min(1),
    resumable: z.boolean(),
    category: z.string().trim().min(1),
    restart_safe: z.boolean(),
    summary: z.string(),
  }).passthrough()),
  drain_mode: z.enum(["continuous", "drain"]),
  readopted_run_ids: z.array(z.string().trim().min(1)),
  drain_duration_ms: z.number().int().nonnegative(),
  daemons_restarted: z.array(z.object({
    daemon_id: z.string().trim().min(1),
    supervisor: z.string().trim().min(1),
    stopped: z.string(),
    started: z.string(),
  }).passthrough()),
  explicit_target_adoption: z.object({}).passthrough().optional(),
  install: z.object({}).passthrough().optional(),
  rollback: z.object({}).passthrough().optional(),
  warnings: z.array(z.string()),
  durability_issues: z.array(z.object({
    scope: z.literal("final_receipt"),
    code: z.literal("receipt_persist_failed"),
    observed_at: z.string().datetime({ offset: true }),
    message: z.string().trim().min(1),
  }).strict()).optional(),
  error: z.string().optional(),
}).passthrough();
const remoteProjectionIssueSchema = z.object({
  scope: z.enum(["status_stderr", "remote_phase_stderr", "lock_cleanup"]),
  code: z.enum(["projection_unavailable", "cleanup_unavailable"]),
  observed_at: z.string().datetime({ offset: true }),
  message: z.string().trim().min(1).max(4_096),
}).strip();
const remoteSelfUpgradeOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("dry-run"),
    plan: remotePlanSchema,
    projection_issues: z.array(remoteProjectionIssueSchema).max(16).optional(),
  }).passthrough(),
  z.object({
    status: z.literal("succeeded"),
    plan: remotePlanSchema,
    operation_id: z.string().trim().min(1).optional(),
    receipt_path: remoteReceiptPathSchema,
    receipt: remoteReceiptSchema,
    projection_issues: z.array(remoteProjectionIssueSchema).max(16).optional(),
  }).passthrough(),
  z.object({
    status: z.literal("failed"),
    error: z.string().trim().min(1),
    exit_code: z.number().int().positive(),
    plan: remotePlanSchema.optional(),
    receipt_path: remoteReceiptPathSchema.optional(),
    receipt: remoteReceiptSchema.optional(),
    projection_issues: z.array(remoteProjectionIssueSchema).max(16).optional(),
  }).passthrough(),
]);

function parseSelfUpgradeJsonOutput(stdout: string): SelfUpgradeCommandJsonOutput | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  const decoded = JSON.parse(trimmed) as unknown;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return remoteSelfUpgradeOutputSchema.parse(decoded) as unknown as SelfUpgradeCommandJsonOutput;
  }
  const { projection_issues: untrustedProjectionIssues, ...authorityEnvelope } = decoded as Record<string, unknown>;
  const parsed = remoteSelfUpgradeOutputSchema.parse(authorityEnvelope) as unknown as SelfUpgradeCommandJsonOutput;
  // Projection diagnostics are additive, bounded, and fail-open. A future
  // remote issue scope/code must never invalidate the terminal authority
  // envelope or change the host verdict.
  const projectionIssues = Array.isArray(untrustedProjectionIssues)
    ? untrustedProjectionIssues.slice(0, 16).flatMap((candidate) => {
        const issue = remoteProjectionIssueSchema.safeParse(candidate);
        return issue.success ? [issue.data as SelfUpgradeProjectionIssue] : [];
      })
    : [];
  return projectionIssues.length > 0
    ? { ...parsed, projection_issues: projectionIssues }
    : parsed;
}

function targetEvidenceMatches(
  candidate: SelfUpgradeTargetEvidence,
  expected: SelfUpgradeTargetEvidence,
): boolean {
  return candidate.original_ref === expected.original_ref
    && candidate.target_sha === expected.target_sha
    && candidate.fetch_remote === expected.fetch_remote
    && candidate.fetch_ref === expected.fetch_ref;
}

function assertRemotePlanSemantics(args: {
  host: string;
  cloneRoot: string;
  targetEvidence: SelfUpgradeTargetEvidence;
  plan: SelfUpgradePlan;
}): void {
  if (normalizeHostAlias(args.plan.host) !== normalizeHostAlias(args.host)) {
    throw new Error(`Remote plan host identity does not match dispatched host ${args.host}.`);
  }
  // The conductor fetched into `cloneRoot` and the planner resolved its own
  // repo root independently. Both facts are now in one process, so the
  // restatement is checked instead of assumed: a preamble that fetched into a
  // checkout the planner never looked at must fail loudly, not silently
  // upgrade from a stale tree.
  if (args.plan.repo_root !== args.cloneRoot) {
    throw new Error(
      `Remote plan built from ${args.plan.repo_root}, but the preamble fetched into ${args.cloneRoot} on ${args.host}.`,
    );
  }
  if (
    args.plan.target_ref !== args.targetEvidence.original_ref
    || args.plan.target_head !== args.targetEvidence.target_sha
    || !targetEvidenceMatches(args.plan.target_evidence, args.targetEvidence)
  ) {
    throw new Error(
      `Remote plan does not prove target ${args.targetEvidence.original_ref} at ${args.targetEvidence.target_sha}.`,
    );
  }
}

function assertRemoteSuccessEnvelopeSemantics(args: {
  host: string;
  cloneRoot: string;
  targetEvidence: SelfUpgradeTargetEvidence;
  payload: SelfUpgradeResult;
}): void {
  const { cloneRoot, host, payload, targetEvidence } = args;
  assertRemotePlanSemantics({ host, cloneRoot, targetEvidence, plan: payload.plan });
  const receiptPath = payload.receipt_path;
  if (!receiptPath) {
    throw new Error("Remote success output omitted its receipt locator.");
  }
  const receiptId = receiptOperationId(receiptPath);
  if (!receiptId) {
    throw new Error("Remote success output named a noncanonical self-upgrade receipt path.");
  }
  if (payload.operation_id && receiptId !== payload.operation_id) {
    throw new Error("Remote success operation_id does not match its receipt locator.");
  }
}

function assertRemoteSuccessSemantics(args: {
  host: string;
  cloneRoot: string;
  targetEvidence: SelfUpgradeTargetEvidence;
  payload: SelfUpgradeResult;
  receipt: SelfUpgradeReceipt;
}): void {
  const { cloneRoot, host, payload, receipt, targetEvidence } = args;
  assertRemoteSuccessEnvelopeSemantics({ host, cloneRoot, targetEvidence, payload });
  if (
    normalizeHostAlias(receipt.host) !== normalizeHostAlias(host)
  ) {
    throw new Error(`Remote success host identity does not match dispatched host ${host}.`);
  }
  if (
    receipt.target_ref !== targetEvidence.original_ref
    || !targetEvidenceMatches(receipt.target_evidence, targetEvidence)
    || receipt.status !== "succeeded"
    || receipt.after_head !== targetEvidence.target_sha
    || receipt.before_head !== payload.plan.current_head
    || receipt.repo_root !== payload.plan.repo_root
  ) {
    throw new Error(
      `Remote success receipt does not prove target ${targetEvidence.original_ref} at ${targetEvidence.target_sha}.`,
    );
  }
  if (Date.parse(receipt.completed_at) < Date.parse(receipt.started_at)) {
    throw new Error("Remote success receipt completed_at precedes started_at.");
  }
}

/** Conductor-side callbacks for one host's relayed transitions. */
interface FleetHostRelay {
  operationId: string;
  now: () => string;
  transition: (transition: SelfUpgradeOperationTransition) => Promise<void>;
}

interface FleetOperationProjection {
  readonly operationPath: string;
  readonly projectionStatus: "available" | "degraded" | "unavailable";
  readonly record: SelfUpgradeOperationRecord;
  readonly warnings: SelfUpgradeFleetWarning[];
  readonly relay: FleetHostRelay;
  bindTarget: (targetSha: string, observedAt: string) => Promise<void>;
  appendEventProjection: (
    event: ReturnType<typeof buildControlEvent>,
    failureMessage: string,
  ) => Promise<void>;
  recordDurabilityIssue: (
    issue: Omit<SelfUpgradeOperationDurabilityIssue, "issue_id">,
  ) => Promise<void>;
  warning: (code: SelfUpgradeFleetWarning["code"], message: string, detail?: string) => void;
  finalize: (transition: Extract<SelfUpgradeOperationTransition, { kind: "fleet_final" }>) => Promise<void>;
  stop: () => Promise<void>;
}

function buildFleetPhaseProjectionEvent(transition: SelfUpgradeHostPhaseTransition) {
  const projected = buildControlEvent({
    now: transition.emitted_at,
    eventType: "daemon.upgrade.progress",
    emittedBy: "self-upgrade",
    host: transition.host,
    operationId: transition.operation_id,
    phase: transition.phase,
    elapsedMs: transition.elapsed_ms,
  });
  return {
    ...projected,
    event_id: transition.transition_id,
    cursor: `${transition.emitted_at}-control-${normalizeHostAlias(transition.host)}-${transition.transition_id}`,
  };
}

async function createFleetOperationProjection(args: {
  initial: SelfUpgradeOperationRecord;
  operationRoot: string;
  eventRoots: string[];
  json: boolean;
  progressWrite?: (chunk: string) => void;
  progressStream: Writable;
  appendEventProjection: typeof appendControlEvent;
  operationClaimSettleTimeoutMs: number;
  eventProjectionSettleTimeoutMs: number;
  now: () => string;
  monotonicNowMs: () => number;
  heartbeatIntervalMs: number;
  claimOperation: typeof claimSelfUpgradeOperation;
}): Promise<FleetOperationProjection> {
  let operationWriter: SelfUpgradeOperationWriter | undefined;
  let operationProjectionAvailable = true;
  let operationProjectionStatus: "available" | "degraded" | "unavailable" = "available";
  let initialProjectionFailure: string | undefined;
  let record = args.initial;
  let operationPath = selfUpgradeOperationPath(args.operationRoot, args.initial.operation_id);
  const claimPromise = Promise.resolve().then(() => args.claimOperation(
    args.operationRoot,
    args.initial,
    {
      now: () => args.initial.started_at,
    },
  ));
  const claim = await settleFailOpenProjection(
    () => claimPromise,
    args.operationClaimSettleTimeoutMs,
  );
  if (claim.status === "fulfilled") {
    operationWriter = claim.value;
    record = claim.value.record;
    operationPath = claim.value.operationPath;
  } else {
    operationProjectionAvailable = false;
    operationProjectionStatus = "unavailable";
    initialProjectionFailure = claim.status === "timeout"
      ? `did not settle within ${Math.max(0, args.operationClaimSettleTimeoutMs)}ms`
      : claim.error instanceof Error
        ? claim.error.message
        : String(claim.error);
    if (claim.status === "timeout") {
      // A claim that settles after its projection circuit opened must not leave
      // a live owner/descriptor behind. Cleanup remains best-effort and cannot
      // rejoin or delay the host mutation path.
      void claimPromise.then((lateWriter) => lateWriter.release()).catch(() => undefined);
    }
  }
  const warnings: SelfUpgradeFleetWarning[] = [];
  const warningKeys = new Set<string>();
  const addWarning = (code: SelfUpgradeFleetWarning["code"], message: string, detail?: string): boolean => {
    const key = `${code}\0${message}\0${detail ?? ""}`;
    if (warningKeys.has(key)) {
      return false;
    }
    warningKeys.add(key);
    warnings.push({ code, message, ...(detail ? { detail } : {}) });
    return true;
  };
  let projectionWriter: FailOpenProjectionWriter | undefined;
  if (!args.progressWrite) {
    projectionWriter = createFailOpenProjectionWriter(args.progressStream, (reason) => {
      addWarning(
        "upgrade_progress_projection_unavailable",
        "Fleet progress output became unavailable; host-local truth and final receipts are unchanged.",
        reason,
      );
    });
  }
  const safeProgressWrite = (chunk: string): void => {
    try {
      if (args.progressWrite) {
        args.progressWrite(chunk);
      } else {
        projectionWriter?.write(chunk);
      }
    } catch (error) {
      addWarning(
        "upgrade_progress_projection_unavailable",
        "Unable to write a fleet progress projection; host-local truth and final receipts are unchanged.",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const reporter = new SelfUpgradeFleetProgressReporter({
    json: args.json,
    operationPath,
    write: safeProgressWrite,
    now: args.now,
    monotonicNowMs: args.monotonicNowMs,
    heartbeatIntervalMs: args.heartbeatIntervalMs,
    getRecord: () => record,
    getProjectionStatus: () => operationProjectionStatus,
  });
  const warn = (code: SelfUpgradeFleetWarning["code"], message: string, detail?: string): void => {
    if (!addWarning(code, message, detail)) {
      return;
    }
    try {
      reporter.warning(code, detail ? `${message} (${detail})` : message);
    } catch (error) {
      addWarning(
        "upgrade_progress_projection_unavailable",
        "Unable to render a fleet progress warning; host-local truth and final receipts are unchanged.",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  try {
    reporter.start(record);
  } catch (error) {
    addWarning(
      "upgrade_progress_projection_unavailable",
      "Unable to render the fleet progress prelude; host-local truth and final receipts are unchanged.",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (initialProjectionFailure) {
    warn(
      "upgrade_operation_projection_persist_unavailable",
      "Unable to create the conductor observation record; host dispatch and receipt authority remain available.",
      initialProjectionFailure,
    );
  }

  let queue: Promise<void> = Promise.resolve();
  const pendingDurabilityIssues = new Map<string, SelfUpgradeOperationDurabilityIssue>();
  let eventProjectionAvailable = true;
  const withPendingDurabilityIssues = (
    candidate: SelfUpgradeOperationRecord,
  ): SelfUpgradeOperationRecord => [...pendingDurabilityIssues.values()].reduce(
    (current, issue) => appendSelfUpgradeOperationDurabilityIssue(current, issue),
    candidate,
  );
  const rememberDurabilityIssue = (issue: SelfUpgradeOperationDurabilityIssue): void => {
    try {
      const next = appendSelfUpgradeOperationDurabilityIssue(record, issue);
      pendingDurabilityIssues.set(issue.issue_id, issue);
      record = next;
    } catch (error) {
      operationProjectionStatus = operationProjectionStatus === "unavailable" ? "unavailable" : "degraded";
      addWarning(
        "upgrade_operation_projection_persist_unavailable",
        "Unable to retain a conductor projection durability issue; host dispatch and receipt authority are unchanged.",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const persistProjectionSnapshot = async (
    candidate: SelfUpgradeOperationRecord,
    transitionId: string,
  ): Promise<void> => {
    record = withPendingDurabilityIssues(candidate);
    if (!operationWriter || !operationProjectionAvailable) {
      return;
    }
    const outcome = await settleFailOpenProjection(
      () => operationWriter!.write(record),
      args.eventProjectionSettleTimeoutMs,
    );
    if (outcome.status === "fulfilled") {
      record = outcome.value;
      pendingDurabilityIssues.clear();
      return;
    }
    operationProjectionAvailable = false;
    operationProjectionStatus = "degraded";
    const detail = outcome.status === "timeout"
      ? `did not settle within ${Math.max(0, args.eventProjectionSettleTimeoutMs)}ms`
      : outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error);
    const issue: SelfUpgradeOperationDurabilityIssue = {
      issue_id: selfUpgradeTransitionId([
        record.operation_id,
        "operation_state_projection_failed",
        transitionId,
        detail,
      ]),
      observed_at: args.now(),
      scope: "operation_state",
      code: "operation_state_projection_failed",
      message: detail,
      transition_id: transitionId,
    };
    rememberDurabilityIssue(issue);
    warn(
      "upgrade_operation_projection_persist_unavailable",
      "Conductor observation persistence became unavailable; host dispatch and receipt authority are unchanged.",
      detail,
    );
  };
  const persistStructuredDurabilityIssue = async (
    issue: SelfUpgradeOperationDurabilityIssue,
  ): Promise<void> => {
    rememberDurabilityIssue(issue);
    await persistProjectionSnapshot(record, issue.issue_id);
  };
  const appendEventProjection = async (
    event: ReturnType<typeof buildControlEvent>,
    failureMessage: string,
  ): Promise<void> => {
    if (!eventProjectionAvailable) {
      return;
    }
    const outcome = await settleFailOpenProjection(
      () => args.appendEventProjection(args.eventRoots, event),
      args.eventProjectionSettleTimeoutMs,
    );
    if (outcome.status !== "fulfilled") {
      eventProjectionAvailable = false;
      const detail = outcome.status === "timeout"
        ? `did not settle within ${Math.max(0, args.eventProjectionSettleTimeoutMs)}ms`
        : outcome.error instanceof Error
          ? outcome.error.message
          : String(outcome.error);
      warn(
        "upgrade_event_projection_unavailable",
        failureMessage,
        detail,
      );
      // Event-log loss is projection evidence, not a second authority write.
      // Carry it into the next retained observation snapshot when the optional
      // operation sink is still healthy. A stuck event sink cannot delay host
      // execution or final-receipt persistence.
      rememberDurabilityIssue({
        issue_id: selfUpgradeTransitionId([
          record.operation_id,
          "event_log_projection_failed",
          event.event_id,
          detail,
        ]),
        observed_at: args.now(),
        scope: "event_log",
        code: "event_log_projection_failed",
        message: detail,
      });
    }
  };
  const apply = async (transition: SelfUpgradeOperationTransition): Promise<void> => {
    const task = queue.then(async () => {
      const applied = applySelfUpgradeOperationTransition(record, transition);
      if (applied.disposition === "duplicate") {
        return;
      }
      if (applied.disposition === "bounded_drop") {
        warn(
          "upgrade_relay_bounded",
          `dropped bounded progress transition ${transition.transition_id}`,
        );
        return;
      }
      if (applied.disposition === "conflict") {
        warn(
          "upgrade_transition_conflict",
          `canonically reduced conflicting transition ${transition.transition_id}`,
        );
        if (applied.record === record) {
          return;
        }
      }
      record = applied.record;
      // The transition set is already hard-bounded per host and per operation.
      // Persist each retained snapshot before rendering when the projection is
      // healthy, but bound the sink and disable it after one failure. Host-local
      // durable events and verified receipts remain the only mutation truth.
      await persistProjectionSnapshot(record, transition.transition_id);
      try {
        reporter.observe(record, transition, applied.changed_host);
      } catch (error) {
        addWarning(
          "upgrade_progress_projection_unavailable",
          "Unable to render a fleet host-state projection; host-local truth and final receipts are unchanged.",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (transition.kind === "host_phase") {
        await appendEventProjection(
          buildFleetPhaseProjectionEvent(transition),
          "Unable to append a relayed phase to the conductor event log; host-local truth and final receipts are unchanged.",
        );
      }
    });
    const contained = task.catch((error: unknown) => {
      operationProjectionAvailable = false;
      operationProjectionStatus = operationProjectionStatus === "unavailable" ? "unavailable" : "degraded";
      const detail = error instanceof Error ? error.message : String(error);
      rememberDurabilityIssue({
        issue_id: selfUpgradeTransitionId([
          record.operation_id,
          "operation_state_projection_failed",
          transition.transition_id,
          detail,
        ]),
        observed_at: args.now(),
        scope: "operation_state",
        code: "operation_state_projection_failed",
        message: detail || "Unknown conductor projection failure.",
        transition_id: transition.transition_id,
      });
      warn(
        "upgrade_operation_projection_persist_unavailable",
        "Unable to reduce a conductor operation projection; host dispatch and receipt authority are unchanged.",
        detail,
      );
    });
    queue = contained;
    await contained;
  };

  return {
    operationPath,
    get projectionStatus() {
      return operationProjectionStatus;
    },
    get record() {
      return record;
    },
    warnings,
    relay: {
      operationId: record.operation_id,
      now: args.now,
      transition: (transition) => apply(transition),
    },
    async bindTarget(targetSha: string, observedAt: string): Promise<void> {
      await queue;
      const transitionId = selfUpgradeTransitionId([record.operation_id, "bind_target", targetSha]);
      try {
        record = bindSelfUpgradeOperationTarget(record, targetSha, observedAt);
        await persistProjectionSnapshot(record, transitionId);
      } catch (error) {
        operationProjectionAvailable = false;
        operationProjectionStatus = operationProjectionStatus === "unavailable" ? "unavailable" : "degraded";
        warn(
          "upgrade_operation_projection_persist_unavailable",
          "Unable to bind the conductor target projection; host dispatch and receipt authority are unchanged.",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    appendEventProjection,
    async recordDurabilityIssue(issue): Promise<void> {
      await queue;
      const durableIssue: SelfUpgradeOperationDurabilityIssue = {
        ...issue,
        issue_id: selfUpgradeTransitionId([
          record.operation_id,
          issue.scope,
          issue.code,
          issue.transition_id ?? "",
          issue.message,
        ]),
      };
      await persistStructuredDurabilityIssue(durableIssue);
    },
    warning: warn,
    async finalize(transition): Promise<void> {
      await apply(transition);
      try {
        reporter.final(record);
      } catch (error) {
        addWarning(
          "upgrade_progress_projection_unavailable",
          "Unable to render the fleet final projection; host-local truth and final receipts remain authoritative.",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    async stop(): Promise<void> {
      reporter.stop();
      if (operationWriter) {
        const release = await settleFailOpenProjection(
          () => operationWriter!.release(),
          args.eventProjectionSettleTimeoutMs,
        );
        if (release.status !== "fulfilled") {
          if (operationProjectionStatus === "available") {
            operationProjectionStatus = "degraded";
          }
          const detail = release.status === "timeout"
            ? `did not settle within ${Math.max(0, args.eventProjectionSettleTimeoutMs)}ms`
            : release.error instanceof Error
              ? release.error.message
              : String(release.error);
          warn(
            "upgrade_operation_projection_persist_unavailable",
            "Unable to release the observation writer; stale-owner cleanup remains available.",
            detail,
          );
        }
      }
      await projectionWriter?.stop();
    },
  };
}

/**
 * Incremental reader for one remote's stderr. It accepts only strict
 * `self-upgrade-operation/v1` transition records for this fleet operation and
 * host. All other stderr remains an artifact, never a protocol dialect.
 */
function createRemoteStreamConsumer(host: string, relay: FleetHostRelay) {
  let mode: Exclude<SelfUpgradeRelayMode, "local"> = "pending";
  const phases = new Map<string, SelfUpgradeHostPhaseTransition>();
  const relayedFingerprints = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  let budgetExceeded = false;
  let liveFrameCount = 0;
  let liveFrameBytes = 0;

  const phaseFingerprint = (transition: SelfUpgradeHostPhaseTransition): string => JSON.stringify(transition);
  const comparePhases = (
    left: SelfUpgradeHostPhaseTransition,
    right: SelfUpgradeHostPhaseTransition,
  ): number => left.emitted_at.localeCompare(right.emitted_at)
    || left.elapsed_ms - right.elapsed_ms
    || left.transition_id.localeCompare(right.transition_id);

  const queueLiveProjection = (transition: SelfUpgradeHostPhaseTransition): void => {
    const fingerprint = phaseFingerprint(transition);
    if (relayedFingerprints.has(fingerprint)) {
      return;
    }
    relayedFingerprints.add(fingerprint);
    chain = chain.then(() => relay.transition(transition)).catch(() => undefined);
  };

  const markBudgetExceeded = (): void => {
    if (budgetExceeded) {
      return;
    }
    budgetExceeded = true;
    mode = "stream";
    const observedAt = relay.now();
    chain = chain.then(() => relay.transition({
      schema_version: "self-upgrade-operation/v1",
      record: "transition",
      kind: "host_relay_degraded",
      transition_id: selfUpgradeTransitionId([relay.operationId, "frame_budget_exceeded", host]),
      operation_id: relay.operationId,
      emitted_at: observedAt,
      observed_at: observedAt,
      host,
      reason: "frame_budget_exceeded",
    })).catch(() => undefined);
  };

  return {
    onStderrLine(line: string): void {
      if (line.trim().length === 0) {
        return;
      }
      const transition = parseSelfUpgradeProgressTransition(line);
      if (
        !transition
        || transition.operation_id !== relay.operationId
        || !("host" in transition)
        || normalizeHostAlias(transition.host) !== normalizeHostAlias(host)
      ) {
        return;
      }
      if (transition.kind !== "host_phase" || transition.source !== "host_event") {
        return;
      }
      const fingerprint = phaseFingerprint(transition);
      // Supporting remotes use the canonical one-object-per-line encoder.
      // Treat alternate JSON spellings as opaque diagnostics so whitespace or
      // key-order variants cannot create a second budget/replay dialect.
      if (line !== fingerprint) {
        return;
      }
      mode = "stream";
      const frameBytes = Buffer.byteLength(line, "utf8") + 1;
      if (frameBytes > REMOTE_PHASE_FRAME_MAX_SINGLE_BYTES) {
        markBudgetExceeded();
        return;
      }
      const existing = phases.get(transition.transition_id);
      if (existing) {
        if (phaseFingerprint(existing) === fingerprint) {
          return;
        }
        // Phase ids content-address the complete observation. Reaching this
        // branch would require a digest collision; retain neither a second
        // persistence task nor a second protocol dialect.
        markBudgetExceeded();
        return;
      }
      const retained = [...phases.values(), transition]
        .sort(comparePhases)
        .slice(-REMOTE_PHASE_FRAME_MAX_COUNT);
      if (!retained.some((candidate) => candidate.transition_id === transition.transition_id)) {
        markBudgetExceeded();
        return;
      }
      const evicted = retained.length < phases.size + 1;
      if (evicted) {
        markBudgetExceeded();
      }
      phases.clear();
      for (const candidate of retained) {
        phases.set(candidate.transition_id, candidate);
      }
      const insideLiveBudget = liveFrameCount < REMOTE_PHASE_FRAME_MAX_COUNT
        && liveFrameBytes + frameBytes <= REMOTE_PHASE_FRAME_MAX_BYTES;
      if (insideLiveBudget) {
        liveFrameCount += 1;
        liveFrameBytes += frameBytes;
        queueLiveProjection(transition);
      } else if (!evicted) {
        markBudgetExceeded();
      }
    },
    async drain(): Promise<void> {
      await chain;
      // The live queue is hard-capped. Reconcile the final canonical top-K in
      // deterministic order after the child closes; this adds at most K more
      // quick in-memory/event projections and evicts provisional early phases
      // without allowing stderr volume to enqueue unbounded filesystem work.
      for (const transition of [...phases.values()].sort(comparePhases)) {
        const fingerprint = phaseFingerprint(transition);
        if (relayedFingerprints.has(fingerprint)) {
          continue;
        }
        relayedFingerprints.add(fingerprint);
        await relay.transition(transition);
      }
    },
    async markProjectionUnavailable(): Promise<void> {
      if (mode === "pending") {
        mode = "missing";
      }
      const observedAt = relay.now();
      await relay.transition({
        schema_version: "self-upgrade-operation/v1",
        record: "transition",
        kind: "host_relay_degraded",
        transition_id: selfUpgradeTransitionId([
          relay.operationId,
          "host_relay_projection_unavailable",
          host,
        ]),
        operation_id: relay.operationId,
        emitted_at: observedAt,
        observed_at: observedAt,
        host,
        reason: "projection_unavailable",
      });
    },
    recordNoFramesObserved(): void {
      if (mode !== "pending") {
        return;
      }
      mode = "missing";
    },
    relayReceipt(): SelfUpgradeFleetHostProgressRelay {
      return {
        mode: mode === "pending" ? "missing" : mode,
        phases: [...phases.values()]
          .sort((left, right) => left.elapsed_ms - right.elapsed_ms || left.transition_id.localeCompare(right.transition_id))
          .map((transition) => ({
            transition_id: transition.transition_id,
            phase: transition.phase,
            elapsed_ms: transition.elapsed_ms,
            emitted_at: transition.emitted_at,
            synthetic: transition.synthetic,
          })),
        // The count intentionally saturates: retaining an exact global count
        // would require an unbounded seen-id set and would make duplicate
        // replay change the receipt. `1` means one-or-more frames were omitted
        // from the live bounded projection while the canonical top-K remains.
        ...(budgetExceeded ? { truncated: true, dropped_frames: 1 } : {}),
      };
    },
  };
}

function isFailureOutput(
  payload: SelfUpgradeCommandJsonOutput | undefined,
): payload is SelfUpgradeCommandFailureOutput {
  return Boolean(payload && payload.status === "failed");
}

async function writeCommandArtifacts(
  aggregateDir: string,
  host: string,
  commandResult: CommandResult,
  writeArtifact: (targetPath: string, contents: string) => Promise<void>,
  settleTimeoutMs: number,
): Promise<{
  stdoutPath?: string;
  stderrPath?: string;
  warnings: SelfUpgradeFleetHostArtifactWarning[];
}> {
  const safeHost = canonicalFleetHostAlias(host);
  const stdoutPath = path.join(aggregateDir, `${safeHost}.stdout.txt`);
  const stderrPath = path.join(aggregateDir, `${safeHost}.stderr.txt`);
  const settle = async (
    artifact: "stdout" | "stderr",
    targetPath: string,
    contents: string,
  ): Promise<{ path?: string; warning?: SelfUpgradeFleetHostArtifactWarning }> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const write = Promise.resolve().then(() => writeArtifact(targetPath, contents)).then(
      () => ({ outcome: "written" as const }),
      (error: unknown) => ({ outcome: "failed" as const, error }),
    );
    const timed = new Promise<{ outcome: "timeout" }>((resolve) => {
      timeout = setTimeout(() => resolve({ outcome: "timeout" }), Math.max(0, settleTimeoutMs));
    });
    const outcome = await Promise.race([write, timed]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (outcome.outcome === "written") {
      return { path: targetPath };
    }
    if (outcome.outcome === "timeout") {
      return {
        warning: {
          code: "artifact_write_timeout",
          artifact,
          message: `Diagnostic ${artifact} artifact did not settle within ${Math.max(0, settleTimeoutMs)}ms; host truth is unchanged.`,
        },
      };
    }
    return {
      warning: {
        code: "artifact_write_unavailable",
        artifact,
        message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      },
    };
  };
  const [stdout, stderr] = await Promise.all([
    settle("stdout", stdoutPath, commandResult.stdout),
    settle("stderr", stderrPath, commandResult.stderr),
  ]);
  return {
    ...(stdout.path ? { stdoutPath: stdout.path } : {}),
    ...(stderr.path ? { stderrPath: stderr.path } : {}),
    warnings: [stdout.warning, stderr.warning].filter(
      (warning): warning is SelfUpgradeFleetHostArtifactWarning => Boolean(warning),
    ),
  };
}

async function executeFleetHost(
  host: string,
  runServeUrl: string,
  aggregateDir: string,
  options: Required<Pick<SelfUpgradeFleetOptions, "to" | "dryRun" | "drainDeadlineMs" | "yes" | "force" | "abortRuns" | "drainAll">>,
  conductorTargetEvidence: SelfUpgradeTargetEvidence | undefined,
  conductorStartupContractPayload: string | undefined,
  isLocal: boolean,
  deps: Required<Pick<SelfUpgradeFleetDependencies,
    | "execFileAsync"
    | "runLocalUpgrade"
    | "resolveRemoteCloneRoot"
    | "monotonicNowMs"
    | "verifyRemoteReceipt"
    | "writeArtifact"
    | "artifactSettleTimeoutMs"
  >>,
  relay: FleetHostRelay,
): Promise<SelfUpgradeFleetHostResult> {
  const startedMs = deps.monotonicNowMs();
  const dispatch = isLocal ? "local" : "ssh";
  const dispatchedAt = relay.now();
  await relay.transition({
    schema_version: "self-upgrade-operation/v1",
    record: "transition",
    kind: "host_dispatched",
    transition_id: selfUpgradeTransitionId([relay.operationId, "host_dispatched", host]),
    operation_id: relay.operationId,
    emitted_at: dispatchedAt,
    observed_at: dispatchedAt,
    host,
    dispatch,
  });
  // POL-1145: when the conductor IS the target, skip SSH and run the upgrade
  // routine in-process. The conductor doesn't need to ssh-self (which fails
  // on every host that doesn't have caleb@<own-shortname> in authorized_keys
  // — and there's no reason to add that just to satisfy a fan-out shape).
  const result = isLocal
    ? await executeFleetHostLocal(
        host,
        aggregateDir,
        options,
        conductorTargetEvidence,
        conductorStartupContractPayload,
        deps,
        relay,
      )
    : await executeFleetHostRemote(
        host,
        runServeUrl,
        aggregateDir,
        options,
        conductorTargetEvidence,
        conductorStartupContractPayload,
        deps,
        relay,
      );
  const elapsedMs = Math.max(0, Math.floor(deps.monotonicNowMs() - startedMs));
  const settled: SelfUpgradeFleetHostResult = {
    ...result,
    elapsed_ms: elapsedMs,
  };
  const relayMode = settled.progress_relay?.mode ?? (isLocal ? "local" : "missing");
  const resultAt = relay.now();
  await relay.transition({
    schema_version: "self-upgrade-operation/v1",
    record: "transition",
    kind: "host_result",
    transition_id: selfUpgradeTransitionId([relay.operationId, "host_result", host]),
    operation_id: relay.operationId,
    emitted_at: resultAt,
    observed_at: resultAt,
    host,
    status: settled.status,
    elapsed_ms: elapsedMs,
    relay_mode: relayMode,
    ...(settled.receipt?.before_head ?? settled.plan?.current_head
      ? { before_head: settled.receipt?.before_head ?? settled.plan?.current_head }
      : {}),
    ...(settled.receipt?.after_head ? { after_head: settled.receipt.after_head } : {}),
    ...(settled.receipt_locator ? { receipt_locator: settled.receipt_locator } : {}),
    ...(settled.error ? { error: settled.error } : {}),
  });
  return settled;
}

async function executeFleetHostRemote(
  host: string,
  runServeUrl: string,
  aggregateDir: string,
  options: Required<Pick<SelfUpgradeFleetOptions, "to" | "dryRun" | "drainDeadlineMs" | "yes" | "force" | "abortRuns" | "drainAll">>,
  conductorTargetEvidence: SelfUpgradeTargetEvidence | undefined,
  conductorStartupContractPayload: string | undefined,
  deps: Required<Pick<SelfUpgradeFleetDependencies,
    | "execFileAsync"
    | "runLocalUpgrade"
    | "resolveRemoteCloneRoot"
    | "verifyRemoteReceipt"
    | "writeArtifact"
    | "artifactSettleTimeoutMs"
  >>,
  relay: FleetHostRelay,
): Promise<SelfUpgradeFleetHostResult> {
  if (!conductorTargetEvidence) {
    return {
      host,
      status: "failed",
      exit_code: 1,
      error: "Conductor target evidence is unavailable; the remote preamble cannot be dispatched.",
    };
  }
  // The remote's checkout path is fleet truth, resolved once by the conductor
  // and then *checked against what the host reports back* — a restatement is
  // only safe when one process reads both the literal and the source and
  // errors on disagreement. Guessing it from the conductor's own home
  // directory would be exactly the failure this contract exists to end: mba
  // and carbon do not share blade's `/home/caleb` prefix.
  let cloneRoot: string;
  try {
    cloneRoot = await deps.resolveRemoteCloneRoot(host);
  } catch (error) {
    return {
      host,
      status: "failed",
      exit_code: 1,
      error: `Unable to resolve the calyx checkout path for ${host} from fleet truth: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const command = buildRemoteDispatchCommand(relay.operationId, host, cloneRoot, conductorTargetEvidence);
  const plan = encodeRemoteUpgradePlan(buildRemoteUpgradePlan({
    fleetOperationId: relay.operationId,
    host,
    cloneRoot,
    targetEvidence: conductorTargetEvidence,
    startupContractPayload: conductorStartupContractPayload,
    options,
  }));
  const stream = createRemoteStreamConsumer(host, relay);
  const commandResult = await defaultExecRemoteCommand(
    host,
    command,
    plan,
    deps.execFileAsync,
    stream.onStderrLine,
  );
  // Relaying is async (each transition also lands on the conductor's event
  // plane); drain it before reading the terminal payload so the host's own
  // result line never races ahead of its phases.
  await stream.drain();
  // Attribute stderr before anything reads it as a diagnosis. The artifact on
  // disk stays whole — operators still want the host's full transcript — but
  // the conductor's error may only quote what this dispatch produced.
  const stderrPartition = partitionRemoteStderr(
    commandResult.stderr,
    remoteStderrBoundaryMarker(relay.operationId, host),
  );
  const environmentNoise = tailText(
    stderrPartition.environment,
    REMOTE_ENVIRONMENT_NOISE_TAIL_LINES,
  );
  const artifacts = await writeCommandArtifacts(
    aggregateDir,
    host,
    commandResult,
    deps.writeArtifact,
    deps.artifactSettleTimeoutMs,
  );

  // A bootstrap failure is not an upgrade attempt. The preamble and the agent
  // both stop before the planner runs, so nothing on the host moved: no fetch
  // ref adopted, no build, no install, no daemon touched. Report it as its own
  // thing and say so, because the operator's next move is "retry", not
  // "inspect the half-upgraded host".
  const bootstrapFailure = commandResult.code === REMOTE_BOOTSTRAP_EXIT_CODE
    ? parseRemoteBootstrapFailure(commandResult.stdout)
    : undefined;
  if (bootstrapFailure) {
    stream.recordNoFramesObserved();
    const attributedTail = tailText(stderrPartition.attributed);
    return {
      host,
      status: "failed",
      exit_code: REMOTE_BOOTSTRAP_EXIT_CODE,
      ...(artifacts.stdoutPath ? { stdout_path: artifacts.stdoutPath } : {}),
      ...(artifacts.stderrPath ? { stderr_path: artifacts.stderrPath } : {}),
      ...commandCaptureFields(commandResult),
      progress_relay: stream.relayReceipt(),
      ...(artifacts.warnings.length > 0 ? { artifact_warnings: artifacts.warnings } : {}),
      ...(attributedTail ? { stderr_tail: attributedTail } : {}),
      ...(environmentNoise ? { remote_environment_noise: environmentNoise } : {}),
      bootstrap_failure: bootstrapFailure,
      error: `Remote upgrade bootstrap failed before ${host} ran any Calyx code (${bootstrapFailure.code}): ${bootstrapFailure.message}. No host state was touched.`,
    };
  }

  let payload: SelfUpgradeCommandJsonOutput | undefined;
  let parseError: string | undefined;
  try {
    payload = parseSelfUpgradeJsonOutput(commandResult.stdout);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  const relayProjectionUnavailable = payload?.projection_issues?.some(
    (issue: SelfUpgradeProjectionIssue) =>
      issue.scope === "remote_phase_stderr" && issue.code === "projection_unavailable",
  ) ?? false;
  if (relayProjectionUnavailable) {
    await stream.markProjectionUnavailable();
  } else {
    // Frame absence is observation, not capability or generation evidence. A
    // current binary can complete through the final-JSON path while emitting
    // no canonical frames, so silence remains evidence-neutral.
    stream.recordNoFramesObserved();
  }
  const progressRelay = stream.relayReceipt();
  let successValidationError: string | undefined;
  let dryRunValidationError: string | undefined;
  let authoritativeReceipt: SelfUpgradeReceipt | undefined;
  let authoritativeReceiptLocator: SelfUpgradeReceiptLocator | undefined;
  let receiptVerification: SelfUpgradeFleetReceiptVerification | undefined;
  if (commandResult.code === 0 && payload?.status === "dry-run") {
    try {
      assertRemotePlanSemantics({ host, cloneRoot, targetEvidence: conductorTargetEvidence, plan: payload.plan });
    } catch (error) {
      dryRunValidationError = error instanceof Error ? error.message : String(error);
    }
  }
  if (commandResult.code === 0 && payload?.status === "succeeded") {
    try {
      assertRemoteSuccessEnvelopeSemantics({
        host,
        cloneRoot,
        targetEvidence: conductorTargetEvidence,
        payload,
      });
      const verified = await deps.verifyRemoteReceipt(
        host,
        payload.receipt_path!,
        payload.receipt!,
        runServeUrl,
        relay.operationId,
      );
      assertReceiptInvocationBinding({
        host,
        receiptPath: payload.receipt_path!,
        receipt: verified.receipt,
        expectedFleetOperationId: relay.operationId,
        locator: verified.locator,
        attempts: verified.attempts ?? 1,
      });
      authoritativeReceipt = verified.receipt;
      authoritativeReceiptLocator = verified.locator;
      receiptVerification = {
        status: "verified",
        code: "verified",
        attempts: verified.attempts ?? 1,
        locator: verified.locator,
      };
      assertRemoteSuccessSemantics({
        host,
        cloneRoot,
        targetEvidence: conductorTargetEvidence,
        payload,
        receipt: authoritativeReceipt,
      });
    } catch (error) {
      if (error instanceof RemoteReceiptVerificationUnavailableError) {
        receiptVerification = error.verification;
      } else {
        successValidationError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  if (commandResult.code === 0 && payload && payload.status === "dry-run" && !dryRunValidationError) {
    return {
      host,
      status: "dry-run",
      exit_code: 0,
      ...(artifacts.stdoutPath ? { stdout_path: artifacts.stdoutPath } : {}),
      ...(artifacts.stderrPath ? { stderr_path: artifacts.stderrPath } : {}),
      ...commandCaptureFields(commandResult),
      progress_relay: progressRelay,
      ...(artifacts.warnings.length > 0 ? { artifact_warnings: artifacts.warnings } : {}),
      ...(payload.plan ? { plan: payload.plan } : {}),
      ...(payload.projection_issues?.length ? { projection_issues: payload.projection_issues } : {}),
    };
  }

  if (
    commandResult.code === 0
    && payload?.status === "succeeded"
    && !successValidationError
    && receiptVerification?.status === "verified"
  ) {
    return {
      host,
      status: "succeeded",
      exit_code: 0,
      ...(artifacts.stdoutPath ? { stdout_path: artifacts.stdoutPath } : {}),
      ...(artifacts.stderrPath ? { stderr_path: artifacts.stderrPath } : {}),
      ...commandCaptureFields(commandResult),
      progress_relay: progressRelay,
      ...(artifacts.warnings.length > 0 ? { artifact_warnings: artifacts.warnings } : {}),
      ...(authoritativeReceiptLocator ? { receipt_locator: authoritativeReceiptLocator } : {}),
      ...(receiptVerification ? { receipt_verification: receiptVerification } : {}),
      ...(authoritativeReceipt ? { receipt: authoritativeReceipt } : {}),
      ...(payload.plan ? { plan: payload.plan } : {}),
      ...(payload.projection_issues?.length ? { projection_issues: payload.projection_issues } : {}),
    };
  }

  if (
    commandResult.code === 0
    && payload?.status === "succeeded"
    && !successValidationError
    && receiptVerification?.status === "unavailable"
  ) {
    return {
      host,
      status: "unverified",
      exit_code: 0,
      ...(artifacts.stdoutPath ? { stdout_path: artifacts.stdoutPath } : {}),
      ...(artifacts.stderrPath ? { stderr_path: artifacts.stderrPath } : {}),
      ...commandCaptureFields(commandResult),
      progress_relay: progressRelay,
      ...(artifacts.warnings.length > 0 ? { artifact_warnings: artifacts.warnings } : {}),
      receipt_verification: receiptVerification,
      ...(payload.plan ? { plan: payload.plan } : {}),
      ...(payload.projection_issues?.length ? { projection_issues: payload.projection_issues } : {}),
      error: receiptVerification.message ?? "Canonical receipt verification is unavailable.",
    };
  }

  const stderrTail = tailText(stderrPartition.attributed);
  const failure = isFailureOutput(payload) ? payload : undefined;
  const errorMessage = failure?.error
    ?? successValidationError
    ?? dryRunValidationError
    ?? (parseError ? `Remote self upgrade JSON parse failed: ${parseError}` : undefined)
    ?? stderrTail
    ?? (commandResult.code !== 0 ? `ssh exited with code ${commandResult.code}` : "Remote self upgrade did not emit JSON output.");

  return {
    host,
    status: "failed",
    exit_code: failure?.exit_code ?? (commandResult.code === 0 ? 1 : commandResult.code),
    ...(artifacts.stdoutPath ? { stdout_path: artifacts.stdoutPath } : {}),
    ...(artifacts.stderrPath ? { stderr_path: artifacts.stderrPath } : {}),
    ...commandCaptureFields(commandResult),
    progress_relay: progressRelay,
    ...(artifacts.warnings.length > 0 ? { artifact_warnings: artifacts.warnings } : {}),
    ...(stderrTail ? { stderr_tail: stderrTail } : {}),
    ...(environmentNoise ? { remote_environment_noise: environmentNoise } : {}),
    ...(payload?.projection_issues?.length ? { projection_issues: payload.projection_issues } : {}),
    // Failed remote stdout is diagnostic projection only. Without a durable
    // receipt reread and semantic validation it cannot contribute heads,
    // locators, plan evidence, or a synthetic finalize transition.
    error: errorMessage,
  };
}

async function resolveConductorCalyxRepoRoot(conductorHost: string): Promise<string> {
  const agentsInfraRoot = await resolveAgentsInfraRoot();
  let calyxRepoRoot: string | undefined;
  if (agentsInfraRoot) {
    try {
      calyxRepoRoot = await resolveRepo("calyx", conductorHost, agentsInfraRoot);
    } catch {
      // Fall through to the conventional layout below.
    }
  }
  if (!calyxRepoRoot) {
    calyxRepoRoot = path.join(homedir(), "dev", "calyx", "dev");
  }
  return calyxRepoRoot;
}

/**
 * The remote's calyx checkout, from `fleet/truths/hosts.yaml`.
 *
 * Deliberately without a conductor-local fallback: `homedir()` is the
 * *conductor's* home, and a remote path derived from it is a fact restated
 * across a machine boundary with nothing on either side able to check it —
 * precisely the shape that makes these dispatches fail silently. An
 * unregistered host is a precondition failure with a fixable message.
 */
async function defaultResolveRemoteCloneRoot(
  host: string,
  resolveRoot: () => Promise<string | undefined>,
): Promise<string> {
  const agentsInfraRoot = await resolveRoot();
  if (!agentsInfraRoot) {
    throw new Error("agents-infra truth is unavailable, so the remote calyx checkout cannot be resolved");
  }
  return resolveRepo("calyx", host, agentsInfraRoot);
}

async function defaultResolveConductorCheckoutSha(
  conductorHost: string,
): Promise<string | undefined> {
  const calyxRepoRoot = await resolveConductorCalyxRepoRoot(conductorHost);
  try {
    const result = await execFileAsyncDefault("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER,
      cwd: calyxRepoRoot,
    } as ExecFileAsyncOptions & { cwd?: string });
    const sha = result.stdout.trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

async function defaultResolveConductorTargetEvidence(
  targetRef: string,
  conductorHost: string,
  explicitTargetSha?: string,
  execFileAsync: ExecFileAsync = execFileAsyncDefault,
): Promise<SelfUpgradeTargetEvidence | undefined> {
  const calyxRepoRoot = await resolveConductorCalyxRepoRoot(conductorHost);
  return resolveFetchedConductorTargetEvidence(
    calyxRepoRoot,
    targetRef,
    execFileAsync,
    explicitTargetSha,
  );
}

function sourceRefForTrackingDestination(
  refspec: string,
  destination: string,
): string | undefined {
  const normalized = refspec.startsWith("+") ? refspec.slice(1) : refspec;
  const separator = normalized.indexOf(":");
  if (separator < 1) {
    return undefined;
  }
  const source = normalized.slice(0, separator);
  const target = normalized.slice(separator + 1);
  const sourceWildcard = source.indexOf("*");
  const targetWildcard = target.indexOf("*");
  if (sourceWildcard < 0 && targetWildcard < 0) {
    return target === destination ? source : undefined;
  }
  if (sourceWildcard < 0 || targetWildcard < 0) {
    return undefined;
  }
  const targetPrefix = target.slice(0, targetWildcard);
  const targetSuffix = target.slice(targetWildcard + 1);
  if (!destination.startsWith(targetPrefix) || !destination.endsWith(targetSuffix)) {
    return undefined;
  }
  const wildcard = destination.slice(
    targetPrefix.length,
    destination.length - targetSuffix.length,
  );
  return `${source.slice(0, sourceWildcard)}${wildcard}${source.slice(sourceWildcard + 1)}`;
}

async function resolveConductorFetchTarget(
  calyxRepoRoot: string,
  targetRef: string,
  execFileAsync: ExecFileAsync,
): Promise<{ remote: string; fetchRef: string }> {
  const remotesResult = await execFileAsync("git", ["remote"], {
    encoding: "utf8",
    maxBuffer: DEFAULT_COMMAND_MAX_BUFFER,
    cwd: calyxRepoRoot,
  });
  const remotes = remotesResult.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  const fallbackRemote = remotes.includes("origin") ? "origin" : remotes[0];
  if (!fallbackRemote) {
    throw new Error("the conductor checkout has no configured Git remote");
  }

  const slash = targetRef.indexOf("/");
  const explicitRemote = slash > 0 && remotes.includes(targetRef.slice(0, slash))
    ? targetRef.slice(0, slash)
    : undefined;
  if (explicitRemote) {
    return { remote: explicitRemote, fetchRef: targetRef.slice(slash + 1) };
  }

  const trackingDestination = targetRef.startsWith("refs/remotes/")
    ? targetRef
    : `refs/remotes/${targetRef}`;
  for (const remote of remotes) {
    let refspecs: string[] = [];
    try {
      const result = await execFileAsync("git", ["config", "--get-all", `remote.${remote}.fetch`], {
        encoding: "utf8",
        maxBuffer: DEFAULT_COMMAND_MAX_BUFFER,
        cwd: calyxRepoRoot,
      });
      refspecs = result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    } catch {
      // A remote without a configured fetch refspec cannot define this local
      // remote-tracking spelling; continue to the next remote.
    }
    for (const refspec of refspecs) {
      const source = sourceRefForTrackingDestination(refspec, trackingDestination);
      if (source) {
        return { remote, fetchRef: source };
      }
    }
  }

  return { remote: fallbackRemote, fetchRef: targetRef };
}

/** Fetch one normalized ref and bind authority to the fetched commit object. */
export async function resolveFetchedConductorTargetEvidence(
  calyxRepoRoot: string,
  targetRef: string,
  execFileAsync: ExecFileAsync = execFileAsyncDefault,
  explicitTargetSha?: string,
): Promise<SelfUpgradeTargetEvidence> {
  // Fetch the targetRef specifically (avoid blanket `git fetch origin` which
  // would advance every remote-tracking ref in the conductor's calyx-dev
  // checkout as a side effect of fleet upgrade). This evidence is mandatory:
  // failure is a non-verdict fleet precondition failure, never authorization
  // for each host to resolve its own possibly stale remote-tracking ref.
  //
  const trimmedRef = targetRef.trim();
  if (!trimmedRef) {
    throw new Error("Unable to fetch an empty conductor target ref");
  }
  let remote: string;
  let fetchRef: string;
  try {
    ({ remote, fetchRef } = await resolveConductorFetchTarget(
      calyxRepoRoot,
      trimmedRef,
      execFileAsync,
    ));
    await execFileAsync("git", ["fetch", remote, fetchRef], {
      encoding: "utf8",
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER,
      cwd: calyxRepoRoot,
    });
  } catch (error) {
    throw new Error(`Unable to fetch conductor target ${targetRef}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const result = await execFileAsync("git", ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], {
      encoding: "utf8",
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER,
      cwd: calyxRepoRoot,
    });
    const sha = result.stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
      throw new Error(`Fetched conductor target ${targetRef} resolved to a non-SHA commit: ${sha || "<empty>"}`);
    }
    const targetSha = explicitTargetSha?.trim() || sha;
    if (explicitTargetSha) {
      if (!/^[0-9a-f]{40}$/i.test(targetSha)) {
        throw new Error(`Explicit conductor target is not a full SHA: ${targetSha || "<empty>"}`);
      }
      const reachable = await execFileAsync(
        "git",
        ["merge-base", "--is-ancestor", targetSha, "FETCH_HEAD"],
        {
          encoding: "utf8",
          maxBuffer: DEFAULT_COMMAND_MAX_BUFFER,
          cwd: calyxRepoRoot,
        },
      );
      void reachable;
    }
    return {
      original_ref: trimmedRef,
      target_sha: targetSha,
      fetch_remote: remote,
      fetch_ref: fetchRef,
    };
  } catch (error) {
    throw new Error(`Unable to resolve fetched conductor target ${targetRef}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Compatibility-free convenience for callers that need only the fetched SHA. */
export async function resolveFetchedConductorTargetSha(
  calyxRepoRoot: string,
  targetRef: string,
  execFileAsync: ExecFileAsync = execFileAsyncDefault,
): Promise<string> {
  return (await resolveFetchedConductorTargetEvidence(calyxRepoRoot, targetRef, execFileAsync)).target_sha;
}

async function defaultResolveConductorStartupContractPayload(
  targetSha: string,
  conductorHost: string,
  execFileAsync: ExecFileAsync = execFileAsyncDefault,
): Promise<string> {
  const calyxRepoRoot = await resolveConductorCalyxRepoRoot(conductorHost);
  return buildTargetStartupContractPayload(targetSha, calyxRepoRoot, async (args, cwd) => {
    try {
      const result = await execFileAsync("git", args, {
        encoding: "utf8",
        maxBuffer: DEFAULT_COMMAND_MAX_BUFFER,
        cwd,
      });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const typed = error as { code?: number; stdout?: string; stderr?: string; message?: string };
      return {
        code: typeof typed.code === "number" ? typed.code : 1,
        stdout: typed.stdout ?? "",
        stderr: typed.stderr ?? typed.message ?? "git invocation failed",
      };
    }
  });
}

async function executeFleetHostLocal(
  host: string,
  aggregateDir: string,
  options: Required<Pick<SelfUpgradeFleetOptions, "to" | "dryRun" | "drainDeadlineMs" | "yes" | "force" | "abortRuns" | "drainAll">>,
  conductorTargetEvidence: SelfUpgradeTargetEvidence | undefined,
  conductorStartupContractPayload: string | undefined,
  deps: Required<Pick<SelfUpgradeFleetDependencies,
    | "runLocalUpgrade"
    | "resolveRemoteCloneRoot"
    | "writeArtifact"
    | "artifactSettleTimeoutMs"
  >>,
  relay: FleetHostRelay,
): Promise<SelfUpgradeFleetHostResult> {
  // Local fast-path produces the same SelfUpgradeFleetHostResult shape as
  // the SSH path. Diagnostic artifacts are useful but never authoritative.

  // Note on `options.yes`: today this is a CLI-parse-layer flag with no
  // counterpart on `SelfUpgradeOptions` — the SSH path appends `--yes` to the
  // remote `calyx self upgrade` invocation, but the per-host upgrade routine
  // itself has no programmatic confirmation gate to skip. Forwarding it here
  // would require a no-op field on the options type. If the upgrade flow ever
  // gains a real confirmation, lift `yes` onto `SelfUpgradeOptions` and add it
  // to the spread below so the local path stays in lockstep with SSH.
  const upgradeOptions: SelfUpgradeOptions = {
    host,
    fleetOperationId: relay.operationId,
    ...(options.to ? { to: options.to } : {}),
    ...(conductorTargetEvidence
      ? {
          targetSha: conductorTargetEvidence.target_sha,
          targetEvidence: conductorTargetEvidence,
        }
      : {}),
    ...(conductorStartupContractPayload ? { startupContractPayload: conductorStartupContractPayload } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.force ? { force: true } : {}),
    ...(options.abortRuns ? { abortRuns: true } : {}),
    ...(options.drainAll ? { drainAll: true } : {}),
    // Use `!== undefined` so an explicit `drainDeadlineMs: 0` (operator opt-out)
    // is preserved instead of being dropped by a truthy check.
    ...(options.drainDeadlineMs !== undefined ? { drainDeadlineMs: options.drainDeadlineMs } : {}),
  };

  // POL-2046: the local host reaches the conductor's terminal through the same
  // relay as an SSH host — no ssh channel to cross, so the phase sink is wired
  // straight into the in-process upgrade.
  const phases = new Map<string, SelfUpgradeHostPhaseTransition>();
  let chain: Promise<void> = Promise.resolve();
  const progressRelay = (): SelfUpgradeFleetHostProgressRelay => ({
    mode: "local",
    phases: [...phases.values()]
      .sort((left, right) => left.elapsed_ms - right.elapsed_ms || left.transition_id.localeCompare(right.transition_id))
      .map((transition) => ({
        transition_id: transition.transition_id,
        phase: transition.phase,
        elapsed_ms: transition.elapsed_ms,
        emitted_at: transition.emitted_at,
        synthetic: transition.synthetic,
      })),
  });
  const onPhase = (event: SelfUpgradePhaseEvent): void => {
    const transition = toSelfUpgradeProgressTransition({
      fleetOperationId: relay.operationId,
      event,
      source: "local_event",
      observedAt: relay.now(),
    });
    phases.set(transition.transition_id, transition);
    chain = chain.then(() => relay.transition(transition)).catch(() => undefined);
  };

  // Run the upgrade in its own try so that artifact-write errors AFTER a
  // successful upgrade aren't reinterpreted as upgrade failures (which would
  // also re-enter the catch's writeFile and likely throw a second time).
  let result: SelfUpgradeResult;
  try {
    result = await deps.runLocalUpgrade(upgradeOptions, { onPhase });
  } catch (error) {
    await chain;
    const failure = toSelfUpgradeFailureOutput(error);
    const stderrTail = tailText(failure.error ?? "");
    const artifacts = await writeCommandArtifacts(
      aggregateDir,
      host,
      {
        code: failure.exit_code,
        stdout: `${JSON.stringify(failure, null, 2)}\n`,
        stderr: failure.error || "",
      },
      deps.writeArtifact,
      deps.artifactSettleTimeoutMs,
    );
    const receiptLocator = failure.receipt_path
      ? hostReceiptLocator(host, failure.receipt_path)
      : undefined;
    return {
      host,
      status: "failed",
      exit_code: failure.exit_code,
      ...(artifacts.stdoutPath ? { stdout_path: artifacts.stdoutPath } : {}),
      ...(artifacts.stderrPath ? { stderr_path: artifacts.stderrPath } : {}),
      progress_relay: progressRelay(),
      ...(artifacts.warnings.length > 0 ? { artifact_warnings: artifacts.warnings } : {}),
      ...(stderrTail ? { stderr_tail: stderrTail } : {}),
      ...(receiptLocator ? { receipt_locator: receiptLocator } : {}),
      ...(failure.receipt ? { receipt: failure.receipt } : {}),
      ...(failure.plan ? { plan: failure.plan } : {}),
      ...(failure.projection_issues?.length ? { projection_issues: failure.projection_issues } : {}),
      error: failure.error,
    };
  }
  await chain;

  const artifacts = await writeCommandArtifacts(
    aggregateDir,
    host,
    { code: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: "" },
    deps.writeArtifact,
    deps.artifactSettleTimeoutMs,
  );

  if (result.status === "dry-run") {
    return {
      host,
      status: "dry-run",
      exit_code: 0,
      ...(artifacts.stdoutPath ? { stdout_path: artifacts.stdoutPath } : {}),
      ...(artifacts.stderrPath ? { stderr_path: artifacts.stderrPath } : {}),
      progress_relay: progressRelay(),
      ...(artifacts.warnings.length > 0 ? { artifact_warnings: artifacts.warnings } : {}),
      ...(result.projection_issues?.length ? { projection_issues: result.projection_issues } : {}),
      plan: result.plan,
    };
  }
  const receiptLocator = result.receipt_path
    ? hostReceiptLocator(host, result.receipt_path)
    : undefined;
  const localObservationFields = {
    ...(artifacts.stdoutPath ? { stdout_path: artifacts.stdoutPath } : {}),
    ...(artifacts.stderrPath ? { stderr_path: artifacts.stderrPath } : {}),
    progress_relay: progressRelay(),
    ...(artifacts.warnings.length > 0 ? { artifact_warnings: artifacts.warnings } : {}),
    ...(result.projection_issues?.length ? { projection_issues: result.projection_issues } : {}),
  };
  const failedLocalValidation = (message: string): SelfUpgradeFleetHostResult => ({
    host,
    status: "failed",
    exit_code: 1,
    ...localObservationFields,
    error: message,
  });
  const unverifiedLocalResult = (
    verification: SelfUpgradeFleetReceiptVerification,
  ): SelfUpgradeFleetHostResult => ({
    host,
    status: "unverified",
    exit_code: 0,
    ...localObservationFields,
    receipt_verification: verification,
    plan: result.plan,
    error: verification.message ?? "Canonical receipt verification is unavailable.",
  });

  if (!conductorTargetEvidence) {
    return failedLocalValidation("Conductor target evidence is unavailable for local success validation.");
  }
  // The in-process path checks its checkout against the same fleet truth the
  // preamble path uses as argv `$1`. Until `runLocalUpgrade` goes away, the
  // conductor's own host is the one host whose dispatch contract is untested
  // by construction; holding both paths to one assertion is the least that
  // exemption should cost.
  let localCloneRoot: string;
  try {
    localCloneRoot = await deps.resolveRemoteCloneRoot(host);
  } catch (error) {
    return failedLocalValidation(
      `Unable to resolve the calyx checkout path for ${host} from fleet truth: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    assertRemotePlanSemantics({
      host,
      cloneRoot: localCloneRoot,
      targetEvidence: conductorTargetEvidence,
      plan: result.plan,
    });
  } catch (error) {
    return failedLocalValidation(error instanceof Error ? error.message : String(error));
  }
  if (!receiptLocator || !result.receipt) {
    const receiptVerification: SelfUpgradeFleetReceiptVerification = {
      status: "unavailable",
      code: "receipt_binding_unavailable",
      attempts: 0,
      ...(receiptLocator ? { locator: receiptLocator } : {}),
      message: `Canonical receipt for ${canonicalFleetHostAlias(host)} lacks a durable current-fleet operation binding.`,
    };
    return unverifiedLocalResult(receiptVerification);
  }
  try {
    assertReceiptInvocationBinding({
      host,
      receiptPath: result.receipt_path!,
      receipt: result.receipt,
      expectedFleetOperationId: relay.operationId,
      locator: receiptLocator,
      attempts: 0,
    });
    assertRemoteSuccessSemantics({
      host,
      cloneRoot: localCloneRoot,
      targetEvidence: conductorTargetEvidence,
      payload: result,
      receipt: result.receipt,
    });
  } catch (error) {
    if (error instanceof RemoteReceiptVerificationUnavailableError) {
      return unverifiedLocalResult(error.verification);
    }
    return failedLocalValidation(error instanceof Error ? error.message : String(error));
  }
  return {
    host,
    status: "succeeded",
    exit_code: 0,
    ...localObservationFields,
    receipt_locator: receiptLocator,
    receipt_verification: {
      status: "verified",
      code: "verified",
      attempts: 0,
      locator: receiptLocator,
    },
    receipt: result.receipt,
    plan: result.plan,
  };
}

async function resolveFleetTargets(
  options: SelfUpgradeFleetOptions,
  deps: Required<Pick<SelfUpgradeFleetDependencies, "resolveAgentsInfraRoot" | "listRunServeHosts">>,
): Promise<RunServeHostTarget[]> {
  const agentsInfraRoot = await deps.resolveAgentsInfraRoot();
  if (!agentsInfraRoot) {
    throw createFleetUpgradeError("Unable to resolve agents-infra root for fleet self upgrade.", 6);
  }

  const configuredTargets = await deps.listRunServeHosts(agentsInfraRoot);
  if (configuredTargets.length === 0) {
    throw createFleetUpgradeError("No hosts with run_serve_url configured in fleet/truths/hosts.yaml.", 2);
  }
  const normalizedTargets = configuredTargets.map((target) => ({
    ...target,
    host: canonicalFleetHostAlias(target.host),
  }));
  if (new Set(normalizedTargets.map((target) => target.host)).size !== normalizedTargets.length) {
    throw createFleetUpgradeError("Fleet host aliases collide after canonical normalization.", 2);
  }

  const requestedHosts = parseRequestedHosts(options.hosts);
  if (requestedHosts.length === 0) {
    if (normalizedTargets.length > SELF_UPGRADE_OPERATION_MAX_HOSTS) {
      throw createFleetUpgradeError(
        `Fleet self upgrade supports at most ${SELF_UPGRADE_OPERATION_MAX_HOSTS} hosts per operation.`,
        2,
      );
    }
    return normalizedTargets;
  }

  const configuredByHost = new Map(
    normalizedTargets.map((target) => [target.host, target] as const),
  );
  const missingHosts = requestedHosts.filter((host) => !configuredByHost.has(host));
  if (missingHosts.length > 0) {
    throw createFleetUpgradeError(
      `Requested host(s) missing run_serve_url in fleet/truths/hosts.yaml: ${missingHosts.join(", ")}.`,
      2,
    );
  }

  const selected = requestedHosts.map((host) => configuredByHost.get(host)!).filter(Boolean);
  if (selected.length > SELF_UPGRADE_OPERATION_MAX_HOSTS) {
    throw createFleetUpgradeError(
      `Fleet self upgrade supports at most ${SELF_UPGRADE_OPERATION_MAX_HOSTS} hosts per operation.`,
      2,
    );
  }
  return selected;
}

async function resolveConductorEventRoots(
  deps: Required<Pick<SelfUpgradeFleetDependencies, "homeDir" | "listDescriptors">>,
): Promise<string[]> {
  try {
    const descriptors = await deps.listDescriptors({ root: defaultDaemonsRoot() });
    const roots = [...new Set(descriptors.map((descriptor) => descriptor.runs_root).filter((value) => value.trim().length > 0))]
      .sort();
    if (roots.length > 0) {
      return roots;
    }
  } catch {
    // Fall through to the default local runs root when the descriptor registry is unavailable.
  }
  return [path.join(deps.homeDir(), ".calyx", "runs")];
}

function buildFleetStatusMap(results: Array<Pick<SelfUpgradeFleetHostResult, "host" | "status" | "receipt_locator" | "error">>): Record<string, {
  status: FleetHostStatus;
  receipt_route?: string;
  error?: string;
}> {
  return Object.fromEntries(
    results.map((result) => [
      result.host,
      {
        status: result.status,
        ...(result.receipt_locator ? { receipt_route: result.receipt_locator.route } : {}),
        ...(result.error ? { error: result.error } : {}),
      },
    ]),
  );
}

function buildPendingStatusMap(targets: RunServeHostTarget[]): Record<string, { status: FleetHostStatus }> {
  return Object.fromEntries(targets.map((target) => [target.host, { status: "pending" as const }]));
}

function summarizeFleetFailure(results: SelfUpgradeFleetHostResult[]): string | undefined {
  const failures = results.filter((result) => result.status === "failed");
  const unverified = results.filter((result) => result.status === "unverified");
  if (failures.length === 0 && unverified.length === 0) {
    return undefined;
  }
  return [
    ...(failures.length > 0
      ? [`${failures.length} host(s) failed: ${failures.map((result) => result.host).join(", ")}`]
      : []),
    ...(unverified.length > 0
      ? [`${unverified.length} host(s) completed with canonical receipt verification unavailable: ${unverified.map((result) => result.host).join(", ")}`]
      : []),
  ].join("; ");
}

function summarizeFleetAuthorityFailure(
  results: SelfUpgradeFleetHostResult[],
  postflight: SelfUpgradeFleetPostflight | undefined,
): string | undefined {
  const hostFailure = summarizeFleetFailure(results);
  if (hostFailure) {
    return hostFailure;
  }
  if (postflight?.status === "failed") {
    return postflight.error ?? "Fleet postflight failed: authoritative freshness observation unavailable";
  }
  if (postflight && postflight.freshness_exit_code !== 0) {
    return `Fleet postflight was not fresh (exit ${postflight.freshness_exit_code}).`;
  }
  return undefined;
}

async function persistFleetUpgradePendingRows(args: {
  perHost: readonly SelfUpgradeFleetHostResult[];
  targetRev: string | null;
  checkoutHead: string;
  checkedAt: string;
  receiptPath: string;
  targetRef: string;
  dryRun: boolean;
}): Promise<void> {
  if (args.dryRun) {
    return;
  }
  const pending = args.perHost.filter((result) =>
    result.status === "failed" || result.status === "unverified" || result.status === "skipped",
  );
  if (pending.length === 0) {
    return;
  }
  const plan = await planStateMigrations();
  if (!plan.applied.some((entry) => entry.id === "0006")) {
    throw new Error("fleet_convergence schema migration 0006 is not applied; run `calyx state migrate --apply`.");
  }
  const opened = await openStateStore();
  try {
    for (const result of pending) {
      const promotedRev = result.receipt?.install?.git_head ?? result.plan?.promoted_build?.git_head ?? null;
      const runningRev = result.receipt?.after_builds.find((build) => build.build?.git_head)?.build?.git_head
        ?? result.plan?.current_head
        ?? null;
      upsertFleetConvergenceRow(opened.db, {
        host: result.host,
        leg: "daemon_build",
        target_rev: args.targetRev,
        observed_rev: promotedRev ?? runningRev,
        converged_from: args.checkoutHead,
        policy: "auto",
        last_checked_at: args.checkedAt,
        verdict: "pending",
        receipt_path: args.receiptPath,
        receipt_id: path.basename(path.dirname(args.receiptPath)),
        detail: result.error ?? null,
        payload: {
          source: "self-upgrade-fleet",
          target_ref: args.targetRef,
          host_status: result.status,
          exit_code: result.exit_code,
          running_rev: runningRev,
          promoted_rev: promotedRev,
          receipt_locator: result.receipt_locator ?? null,
        },
      });
    }
  } finally {
    opened.db.close();
  }
}

function emptyFreshnessSummary(): Record<SelfFreshnessVerdict, number> {
  return { fresh: 0, usable_with_warnings: 0, stale: 0, blocked: 0 };
}

function freshnessExitCodeFor(summary: Record<SelfFreshnessVerdict, number>): number {
  if (summary.blocked > 0) return 6;
  if (summary.stale > 0) return 3;
  if (summary.usable_with_warnings > 0) return 1;
  return 0;
}

function observedHealthErrorFor(
  health: SelfFreshnessHealthSummary,
): SelfUpgradeFleetPostflightObservedHealthError | undefined {
  if (health.status !== "error") {
    return undefined;
  }
  return {
    kind: health.error_kind ?? "missing_health",
    ...(health.http_status !== undefined ? { http_status: health.http_status } : {}),
    ...(health.error_code ? { error_code: health.error_code } : {}),
    ...(health.response_retryable !== undefined
      ? { response_retryable: health.response_retryable }
      : {}),
    ...(health.response_phase ? { response_phase: health.response_phase } : {}),
  };
}

function createPostflightHost(
  upgrade: Pick<SelfUpgradeFleetHostResult, "host" | "status" | "error">,
  freshness?: SelfFreshnessHostResult,
  settle?: SelfUpgradeFleetPostflightSettle,
  postflightError?: SelfUpgradeFleetPostflightProbeError,
): SelfUpgradeFleetPostflightHost {
  const error = postflightError?.message ?? upgrade.error;
  const healthError = freshness ? observedHealthErrorFor(freshness.health) : undefined;
  return {
    host: upgrade.host,
    upgrade_status: upgrade.status,
    ...(freshness
      ? {
          freshness_verdict: freshness.verdict,
          health_status: freshness.health.status,
          ...(freshness.drift ? { drift_status: freshness.drift.status } : {}),
          ...(freshness.install_drift ? { install_drift_status: freshness.install_drift.status } : {}),
          missing_features: freshness.capabilities.missing,
          ...(healthError ? { health_error: healthError } : {}),
          ...(freshness.actions[0] ? { next_action: freshness.actions[0] } : {}),
        }
      : {}),
    ...(settle ? { settle } : {}),
    ...(error ? { error } : {}),
  };
}

function normalizeSettleWindowMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_POSTFLIGHT_SETTLE_WINDOW_MS;
  }
  return Math.max(0, Math.trunc(value));
}

function settleDelayMsFor(retryIndex: number): number {
  const ramp = POSTFLIGHT_SETTLE_DELAY_RAMP_MS;
  return ramp[Math.min(retryIndex, ramp.length - 1)] ?? ramp[ramp.length - 1]!;
}

function settleOutcomeFor(
  settled: boolean,
  attempts: number,
): SelfUpgradeFleetPostflightSettleOutcome {
  if (settled) {
    return attempts > 1 ? "settled_after_retries" : "settled_first_probe";
  }
  return attempts > 1 ? "unsettled_after_retries" : "unsettled_no_retries";
}

/**
 * A stale/blocked verdict is not itself evidence of a restart race. Retry only
 * the two states that waiting can resolve: request-stage unreachable health
 * (refusal/request failure/timeout), or an old daemon still serving after the
 * exact target was promoted and materialized.
 * The latter is derived entirely from one health payload. Drift and capability
 * facts describe that old running daemon and therefore cannot disprove the
 * typed restart transition; a real target defect remains after the new daemon
 * serves and then stops without this promoted-not-restarted evidence.
 */
function postflightRetryReasonFor(
  freshness: SelfFreshnessHostResult,
  targetSha: string,
): SelfUpgradeFleetPostflightRetryReason | undefined {
  if (freshness.health.status === "error") {
    return freshness.health.error_kind === "unreachable" ? "health_unreachable" : undefined;
  }
  const install = freshness.install_drift;
  if (
    install?.status === "promoted_not_restarted"
    && install.promoted_head === targetSha
    && install.clone_head === targetSha
  ) {
    return "target_promoted_daemon_not_restarted";
  }
  return undefined;
}

function summarizeSettle(
  settles: readonly SelfUpgradeFleetPostflightSettle[],
  windowMs: number,
): SelfUpgradeFleetPostflightSettleSummary {
  const summary: SelfUpgradeFleetPostflightSettleSummary = {
    window_ms: windowMs,
    max_attempts: POSTFLIGHT_SETTLE_MAX_ATTEMPTS,
    delay_ramp_ms: [...POSTFLIGHT_SETTLE_DELAY_RAMP_MS],
    hosts_probed: settles.length,
    settled_first_probe: 0,
    settled_after_retries: 0,
    unsettled_no_retries: 0,
    unsettled_after_retries: 0,
    probe_error: 0,
    total_waited_ms: 0,
  };
  for (const settle of settles) {
    summary[settle.outcome] += 1;
    summary.total_waited_ms += settle.waited_ms;
  }
  return summary;
}

/**
 * Probes one upgraded host until freshness settles, a typed failure occurs, or
 * a bound stops retries. The optional returned freshness row is always the last
 * truthful observation; a later probe failure cannot erase or replace it.
 */
async function probeHostFreshnessUntilSettled(args: {
  host: string;
  targetSha: string;
  authToken: string;
  windowMs: number;
  runFreshnessCommand: NonNullable<SelfUpgradeFleetDependencies["runFreshnessCommand"]>;
  sleep: (ms: number) => Promise<void>;
  monotonicNowMs: () => number;
  now: () => string;
}): Promise<PostflightHostProbeResult> {
  const probes: SelfUpgradeFleetPostflightProbe[] = [];
  const startedMs = args.monotonicNowMs();
  let lastElapsedMs = 0;
  const elapsedSinceStart = (): number => {
    const observedMs = Math.max(0, args.monotonicNowMs() - startedMs);
    lastElapsedMs = Math.max(lastElapsedMs, observedMs);
    return lastElapsedMs;
  };
  let waitedMs = 0;
  let delayBeforeMs = 0;
  let lastFreshness: SelfFreshnessHostResult | undefined;

  function failedResult(
    code: SelfUpgradeFleetPostflightProbeErrorCode,
    message: string,
    probeStartedAfterMs?: number,
    errorDelayBeforeMs = delayBeforeMs,
  ): PostflightHostProbeResult {
    const error: SelfUpgradeFleetPostflightProbeError = {
      code,
      message,
      occurred_at: args.now(),
    };
    if (probeStartedAfterMs !== undefined) {
      const probeCompletedAfterMs = elapsedSinceStart();
      probes.push({
        status: "error",
        attempt: probes.length + 1,
        delay_before_ms: errorDelayBeforeMs,
        started_after_ms: probeStartedAfterMs,
        completed_after_ms: probeCompletedAfterMs,
        duration_ms: probeCompletedAfterMs - probeStartedAfterMs,
        error,
      });
    }
    return {
      ...(lastFreshness ? { freshness: lastFreshness } : {}),
      settle: {
        outcome: "probe_error",
        stop_reason: "probe_error",
        attempts: probes.length,
        waited_ms: waitedMs,
        elapsed_ms: elapsedSinceStart(),
        window_ms: args.windowMs,
        probes,
        error,
      },
      error,
    };
  }

  for (;;) {
    const probeStartedAfterMs = elapsedSinceStart();
    let freshness: SelfFreshnessResult;
    try {
      freshness = await args.runFreshnessCommand(
        { host: args.host, against: args.targetSha, json: true },
        { authToken: args.authToken },
      );
    } catch (error) {
      return failedResult(
        "freshness_command_failed",
        error instanceof Error ? error.message : String(error),
        probeStartedAfterMs,
      );
    }
    const hostFreshness = freshness.hosts.find(
      (entry) => normalizeHostAlias(entry.host) === normalizeHostAlias(args.host),
    );
    if (!hostFreshness) {
      return failedResult(
        "missing_host_result",
        `self freshness did not return a row for upgraded host ${args.host}`,
        probeStartedAfterMs,
      );
    }
    const probeCompletedAfterMs = elapsedSinceStart();
    const attempt = probes.length + 1;
    const retryReason = postflightRetryReasonFor(hostFreshness, args.targetSha);
    const healthError = observedHealthErrorFor(hostFreshness.health);
    probes.push({
      status: "observed",
      attempt,
      delay_before_ms: delayBeforeMs,
      started_after_ms: probeStartedAfterMs,
      completed_after_ms: probeCompletedAfterMs,
      duration_ms: probeCompletedAfterMs - probeStartedAfterMs,
      observed_at: freshness.checked_at,
      verdict: hostFreshness.verdict,
      health_status: hostFreshness.health.status,
      ...(healthError ? { health_error: healthError } : {}),
      missing_feature_count: hostFreshness.capabilities.missing.length,
      ...(retryReason ? { retry_reason: retryReason } : {}),
    });
    lastFreshness = hostFreshness;

    const settled = SETTLED_FRESHNESS_VERDICTS.includes(hostFreshness.verdict);
    const nextDelayMs = settleDelayMsFor(attempt - 1);
    const canRetry = !settled
      && retryReason !== undefined
      && attempt < POSTFLIGHT_SETTLE_MAX_ATTEMPTS
      && waitedMs + nextDelayMs <= args.windowMs;
    if (!canRetry) {
      const stopReason: SelfUpgradeFleetPostflightStopReason = settled
        ? "settled"
        : retryReason === undefined
          ? "not_retryable"
          : attempt >= POSTFLIGHT_SETTLE_MAX_ATTEMPTS
            ? "attempt_backstop"
            : args.windowMs === 0
              ? "retries_disabled"
              : attempt === 1 && waitedMs === 0
                ? "no_delay_fits"
                : "window_budget";
      return {
        freshness: hostFreshness,
        settle: {
          outcome: settleOutcomeFor(settled, attempt),
          stop_reason: stopReason,
          attempts: attempt,
          waited_ms: waitedMs,
          elapsed_ms: elapsedSinceStart(),
          window_ms: args.windowMs,
          probes,
        },
      };
    }

    const delayStartedAfterMs = elapsedSinceStart();
    try {
      await args.sleep(nextDelayMs);
    } catch (error) {
      return failedResult(
        "settle_delay_failed",
        error instanceof Error ? error.message : String(error),
        delayStartedAfterMs,
        nextDelayMs,
      );
    }
    waitedMs += nextDelayMs;
    delayBeforeMs = nextDelayMs;
  }
}

async function collectFleetPostflight(args: {
  dryRun: boolean;
  targetRef: string;
  targetSha: string;
  perHost: readonly SelfUpgradeFleetHostResult[];
  authToken: string;
  settleWindowMs: number;
  runFreshnessCommand: NonNullable<SelfUpgradeFleetDependencies["runFreshnessCommand"]>;
  sleep: (ms: number) => Promise<void>;
  monotonicNowMs: () => number;
  now: () => string;
}): Promise<Omit<SelfUpgradeFleetPostflight, "checked_at"> | undefined> {
  if (args.dryRun) {
    return undefined;
  }

  const summary = emptyFreshnessSummary();
  const rows: SelfUpgradeFleetPostflightHost[] = [];
  const settles: SelfUpgradeFleetPostflightSettle[] = [];
  const errors: string[] = [];

  for (const upgrade of args.perHost) {
    if (upgrade.status !== "succeeded" && upgrade.status !== "unverified") {
      rows.push(createPostflightHost(upgrade));
      continue;
    }

    let probed: PostflightHostProbeResult;
    const hostStartedMs = args.monotonicNowMs();
    try {
      probed = await probeHostFreshnessUntilSettled({
        host: upgrade.host,
        targetSha: args.targetSha,
        authToken: args.authToken,
        windowMs: args.settleWindowMs,
        runFreshnessCommand: args.runFreshnessCommand,
        sleep: args.sleep,
        monotonicNowMs: args.monotonicNowMs,
        now: args.now,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const typedError: SelfUpgradeFleetPostflightProbeError = {
        code: "unexpected_probe_failure",
        message,
        occurred_at: args.now(),
      };
      const elapsedMs = Math.max(0, args.monotonicNowMs() - hostStartedMs);
      probed = {
        settle: {
          outcome: "probe_error",
          stop_reason: "probe_error",
          attempts: 1,
          waited_ms: 0,
          elapsed_ms: elapsedMs,
          window_ms: args.settleWindowMs,
          probes: [{
            status: "error",
            attempt: 1,
            delay_before_ms: 0,
            started_after_ms: 0,
            completed_after_ms: elapsedMs,
            duration_ms: elapsedMs,
            error: typedError,
          }],
          error: typedError,
        },
        error: typedError,
      };
    }

    if (probed.freshness) {
      summary[probed.freshness.verdict] += 1;
    }
    settles.push(probed.settle);
    rows.push(createPostflightHost(upgrade, probed.freshness, probed.settle, probed.error));
    if (probed.error) {
      errors.push(`${upgrade.host}: ${probed.error.message}`);
    }
  }

  const failed = errors.length > 0;
  return {
    schema_version: "self-upgrade-fleet-postflight/v1",
    status: failed ? "failed" : "completed",
    source_schema_version: "self-freshness/v1",
    target_ref: args.targetRef,
    target_sha: args.targetSha,
    freshness_exit_code: failed ? null : freshnessExitCodeFor(summary),
    summary,
    settle: summarizeSettle(settles, args.settleWindowMs),
    per_host: rows,
    ...(failed ? { error: `Postflight probing failed for ${errors.join("; ")}` } : {}),
  };
}

/**
 * POL-2045: aggregate the per-host startup-contract verdicts the conductor
 * collected. Each host's verdict rides on `plan.startup_contract`; hosts whose
 * upgrade never produced a plan are explicitly `unassessed` so totals reconcile.
 */
function summarizeStartupContractVerdicts(
  perHost: readonly SelfUpgradeFleetHostResult[],
): SelfUpgradeFleetStartupContractAggregate {
  const summary: SelfUpgradeFleetStartupContractAggregate = {
    total_hosts: perHost.length,
    compatible: 0,
    incompatible: 0,
    unknown_blocked: 0,
    unknown_nonblocking: 0,
    unassessed: 0,
    compatible_hosts: [],
    incompatible_hosts: [],
    unknown_blocked_hosts: [],
    unknown_nonblocking_hosts: [],
    unassessed_hosts: [],
  };
  for (const host of perHost) {
    const status = host.plan?.startup_contract?.status;
    if (status === "compatible") {
      summary.compatible += 1;
      summary.compatible_hosts.push(host.host);
    } else if (status === "incompatible") {
      summary.incompatible += 1;
      summary.incompatible_hosts.push(host.host);
    } else if (status === "unknown" && host.plan?.startup_contract?.mutation_disposition === "block") {
      summary.unknown_blocked += 1;
      summary.unknown_blocked_hosts.push(host.host);
    } else if (status === "unknown") {
      summary.unknown_nonblocking += 1;
      summary.unknown_nonblocking_hosts.push(host.host);
    } else {
      summary.unassessed += 1;
      summary.unassessed_hosts.push(host.host);
    }
  }
  return summary;
}

function buildFleetFinalRows(receipt: SelfUpgradeFleetReceipt): SelfUpgradeOperationFinalRow[] {
  const postflightByHost = new Map(
    (receipt.postflight?.per_host ?? []).map((row) => [normalizeHostAlias(row.host), row] as const),
  );
  return receipt.per_host.map((host) => {
    const postflight = postflightByHost.get(normalizeHostAlias(host.host));
    return {
      host: host.host,
      status: host.status,
      ...(host.before_head ?? host.receipt?.before_head ?? host.plan?.current_head
        ? { before_head: host.before_head ?? host.receipt?.before_head ?? host.plan?.current_head }
        : {}),
      ...(host.after_head ?? host.receipt?.after_head
        ? { after_head: host.after_head ?? host.receipt?.after_head }
        : {}),
      ...(host.elapsed_ms !== undefined ? { elapsed_ms: host.elapsed_ms } : {}),
      ...(host.receipt_locator ? { receipt_locator: host.receipt_locator } : {}),
      ...(postflight?.freshness_verdict ? { freshness_verdict: postflight.freshness_verdict } : {}),
    };
  });
}

function boundedDiagnostic(value: string | undefined, maxCharacters = 2_048): string | undefined {
  if (value === undefined || value.length <= maxCharacters) return value;
  return `${value.slice(0, maxCharacters)}…[bounded]`;
}

function prepareAuthoritativeFleetReceipt(
  receipt: SelfUpgradeFleetReceipt,
  maxBytes: number,
): { receipt: SelfUpgradeFleetReceipt; contents: string; wasBounded: boolean } {
  const contents = `${JSON.stringify(receipt, null, 2)}\n`;
  const originalBytes = Buffer.byteLength(contents, "utf8");
  if (originalBytes <= maxBytes) {
    return { receipt, contents, wasBounded: false };
  }

  const bounded: SelfUpgradeFleetReceipt = {
    ...receipt,
    per_host: receipt.per_host.map((host) => ({ ...host })),
    bounded: {
      reason: "size_limit",
      original_bytes: originalBytes,
      max_bytes: maxBytes,
      omitted: [],
    },
  };

  const minimalHost = (host: SelfUpgradeFleetHostResult): SelfUpgradeFleetHostResult => {
    const beforeHead = host.before_head ?? host.receipt?.before_head ?? host.plan?.current_head;
    const afterHead = host.after_head ?? host.receipt?.after_head;
    const verificationMessage = boundedDiagnostic(host.receipt_verification?.message, 1_024);
    return {
      host: host.host,
      status: host.status,
      exit_code: host.exit_code,
      ...(beforeHead ? { before_head: beforeHead } : {}),
      ...(afterHead ? { after_head: afterHead } : {}),
      ...(host.elapsed_ms !== undefined ? { elapsed_ms: host.elapsed_ms } : {}),
      ...(host.receipt_locator ? { receipt_locator: host.receipt_locator } : {}),
      ...(host.receipt_verification
        ? {
            receipt_verification: {
              ...host.receipt_verification,
              ...(verificationMessage ? { message: verificationMessage } : {}),
            },
          }
        : {}),
      ...(host.projection_issues?.length
        ? {
            projection_issues: host.projection_issues.map((issue) => ({
              ...issue,
              message: boundedDiagnostic(issue.message, 256)!,
            })),
          }
        : {}),
      ...(host.error ? { error: boundedDiagnostic(host.error, 1_024)! } : {}),
    };
  };
  const hostOmittedFields = (host: SelfUpgradeFleetHostResult): string[] => {
    const omitted = [
      ["artifact_warnings", host.artifact_warnings],
      ["plan", host.plan],
      ["progress_relay", host.progress_relay],
      ["receipt", host.receipt],
      ["remote_environment_noise", host.remote_environment_noise],
      ["stderr_capture", host.stderr_capture],
      ["stderr_path", host.stderr_path],
      ["stderr_tail", host.stderr_tail],
      ["stdout_capture", host.stdout_capture],
      ["stdout_path", host.stdout_path],
    ].flatMap(([field, value]) => value === undefined ? [] : [`per_host.${host.host}.${String(field)}`]);
    if (host.projection_issues?.some((issue) => issue.message.length > 256)) {
      omitted.push(`per_host.${host.host}.projection_issues[].message[bounded]`);
    }
    return omitted;
  };
  const serialized = (): string => `${JSON.stringify(bounded, null, 2)}\n`;
  const contributors: Array<{ key: string; savings: number; apply: () => void }> = bounded.per_host.map(
    (host, index) => {
      const replacement = minimalHost(host);
      return {
        key: `per_host.${host.host}`,
        savings: Buffer.byteLength(JSON.stringify(host), "utf8")
          - Buffer.byteLength(JSON.stringify(replacement), "utf8"),
        apply: () => {
          bounded.per_host[index] = replacement;
          bounded.bounded!.omitted.push(...hostOmittedFields(host));
        },
      };
    },
  );
  if (bounded.postflight) {
    const postflight = bounded.postflight;
    contributors.push({
      key: "postflight",
      savings: Buffer.byteLength(JSON.stringify(postflight), "utf8"),
      apply: () => {
        delete bounded.postflight;
        bounded.bounded!.omitted.push("postflight");
      },
    });
  }
  if (bounded.target_evidence.status === "failed" && bounded.target_evidence.error.length > 4_096) {
    const targetEvidence = bounded.target_evidence;
    contributors.push({
      key: "target_evidence.error",
      savings: targetEvidence.error.length - 4_096,
      apply: () => {
        bounded.target_evidence = {
          ...targetEvidence,
          error: boundedDiagnostic(targetEvidence.error, 4_096)!,
        };
        bounded.bounded!.omitted.push("target_evidence.error[bounded]");
      },
    });
  }
  contributors.sort((left, right) => right.savings - left.savings || left.key.localeCompare(right.key));
  let contributorIndex = 0;
  const applyUntilEstimatedBudget = (startingBytes: number): void => {
    let estimatedBytes = startingBytes;
    while (estimatedBytes > maxBytes && contributorIndex < contributors.length) {
      const contributor = contributors[contributorIndex++]!;
      if (contributor.savings <= 0) continue;
      contributor.apply();
      estimatedBytes = Math.max(0, estimatedBytes - contributor.savings);
    }
  };

  // Serialize the whole aggregate a constant number of times. Contributor
  // savings choose the proportional reductions; one measured correction pass
  // accounts for pretty-print and omitted-list overhead without O(hosts × bytes)
  // main-thread work after the fleet has already mutated.
  let boundedContents = serialized();
  applyUntilEstimatedBudget(Buffer.byteLength(boundedContents, "utf8"));
  boundedContents = serialized();
  if (Buffer.byteLength(boundedContents, "utf8") > maxBytes) {
    applyUntilEstimatedBudget(Buffer.byteLength(boundedContents, "utf8"));
    boundedContents = serialized();
  }
  if (Buffer.byteLength(boundedContents, "utf8") > maxBytes && contributorIndex < contributors.length) {
    for (; contributorIndex < contributors.length; contributorIndex += 1) {
      const contributor = contributors[contributorIndex]!;
      if (contributor.savings > 0) contributor.apply();
    }
    boundedContents = serialized();
  }
  if (Buffer.byteLength(boundedContents, "utf8") > maxBytes) {
    throw Object.assign(
      new Error(`Bounded fleet self-upgrade receipt still exceeds ${maxBytes} bytes.`),
      { code: "EFBIG" },
    );
  }
  return { receipt: bounded, contents: boundedContents, wasBounded: true };
}

function formatFleetText(
  receipt: SelfUpgradeFleetReceipt,
  receiptPath: string,
  operationPath: string,
  operationProjection: SelfUpgradeFleetResult["operation_projection"],
): string {
  const lines = [
    `status: ${receipt.status}`,
    `operation_id: ${path.basename(receipt.aggregate_dir)}`,
    `operation_path: ${operationPath}`,
    `operation_projection: ${operationProjection}`,
    `conductor_host: ${receipt.conductor_host}`,
    `target_ref: ${receipt.target_ref}`,
    `aggregate_receipt: ${receiptPath}`,
  ];

  lines.push(receipt.target_evidence.status === "resolved"
    ? `target_evidence: status=resolved original_ref=${receipt.target_evidence.original_ref} target_sha=${receipt.target_evidence.target_sha} fetch_remote=${receipt.target_evidence.fetch_remote} fetch_ref=${receipt.target_evidence.fetch_ref} payload_sha256=${receipt.target_evidence.startup_contract_payload_sha256}`
    : `target_evidence: status=failed code=${receipt.target_evidence.error_code} error=${receipt.target_evidence.error}`);

  const contractSummary = receipt.startup_contract;
  lines.push(
    `startup_contract: compatible=${contractSummary.compatible} `
    + `incompatible=${contractSummary.incompatible} unknown_blocked=${contractSummary.unknown_blocked} `
    + `unknown_nonblocking=${contractSummary.unknown_nonblocking} `
    + `unassessed=${contractSummary.unassessed}`
    + (contractSummary.incompatible_hosts.length > 0
      ? ` incompatible_hosts=${contractSummary.incompatible_hosts.join(",")}`
      : "")
    + (contractSummary.unknown_blocked_hosts.length > 0
      ? ` unknown_blocked_hosts=${contractSummary.unknown_blocked_hosts.join(",")}`
      : "")
    + (contractSummary.unknown_nonblocking_hosts.length > 0
      ? ` unknown_nonblocking_hosts=${contractSummary.unknown_nonblocking_hosts.join(",")}`
      : ""),
  );

  for (const host of receipt.per_host) {
    const detail = host.receipt_locator
      ? ` receipt=${host.receipt_locator.host}:${host.receipt_locator.route}`
      : "";
    const verificationReceiptLocator = host.receipt_verification?.locator;
    const verificationLocator = verificationReceiptLocator
      && (
        verificationReceiptLocator.host !== host.receipt_locator?.host
        || verificationReceiptLocator.route !== host.receipt_locator?.route
      )
      ? ` verification_receipt=${verificationReceiptLocator.host}:${verificationReceiptLocator.route}`
      : "";
    const verification = host.receipt_verification
      ? ` verification=${host.receipt_verification.code}${verificationLocator}`
      : "";
    const error = host.error ? ` error=${host.error}` : "";
    lines.push(`host: ${host.host} status=${host.status} exit_code=${host.exit_code}${detail}${verification}${error}`);
    if (host.status === "dry-run" && host.plan) {
      try {
        lines.push(formatSelfUpgradePlan(host.plan));
      } catch (renderError) {
        lines.push(
          `plan: unavailable for ${host.host} (${boundedDiagnostic(
            renderError instanceof Error ? renderError.message : String(renderError),
            512,
          )})`,
        );
      }
    }
  }

  if (receipt.postflight) {
    lines.push([
      "postflight:",
      `status=${receipt.postflight.status}`,
      `target_sha=${receipt.postflight.target_sha}`,
      `freshness_exit_code=${receipt.postflight.freshness_exit_code ?? "unknown"}`,
      `fresh=${receipt.postflight.summary.fresh}`,
      `usable_with_warnings=${receipt.postflight.summary.usable_with_warnings}`,
      `stale=${receipt.postflight.summary.stale}`,
      `blocked=${receipt.postflight.summary.blocked}`,
    ].join(" "));
    const settleSummary = receipt.postflight.settle;
    if (settleSummary) {
      lines.push([
        "postflight_settle:",
        `window_ms=${settleSummary.window_ms}`,
        `max_attempts=${settleSummary.max_attempts}`,
        `hosts_probed=${settleSummary.hosts_probed}`,
        `settled_first_probe=${settleSummary.settled_first_probe}`,
        `settled_after_retries=${settleSummary.settled_after_retries}`,
        `unsettled_after_retries=${settleSummary.unsettled_after_retries}`,
        `unsettled_no_retries=${settleSummary.unsettled_no_retries}`,
        `probe_error=${settleSummary.probe_error}`,
        `total_waited_ms=${settleSummary.total_waited_ms}`,
      ].join(" "));
    }
    // Only hosts whose verdict is NOT a clean first-probe answer get a row: an
    // agent reading this must be able to tell "blocked after N probes across
    // the settle window" from "blocked on the first probe".
    for (const host of receipt.postflight.per_host) {
      if (!host.settle || host.settle.outcome === "settled_first_probe") {
        continue;
      }
      lines.push([
        `postflight_host: ${host.host}`,
        `verdict=${host.freshness_verdict ?? "unknown"}`,
        `settle=${host.settle.outcome}`,
        `stop_reason=${host.settle.stop_reason}`,
        `attempts=${host.settle.attempts}`,
        `waited_ms=${host.settle.waited_ms}`,
        `elapsed_ms=${host.settle.elapsed_ms}`,
        `probe_results=${host.settle.probes.map((probe) =>
          probe.status === "observed" ? probe.verdict : `error:${probe.error.code}`).join(">")}`,
        ...(host.health_error ? [`health_error=${host.health_error.kind}`] : []),
        ...(host.health_error?.http_status !== undefined
          ? [`health_http_status=${host.health_error.http_status}`]
          : []),
        ...(host.health_error?.response_phase
          ? [`health_response_phase=${host.health_error.response_phase}`]
          : []),
        ...(host.settle.error ? [`error_code=${host.settle.error.code}`] : []),
      ].join(" "));
    }
    if (receipt.postflight.error) {
      lines.push(`postflight_error: ${receipt.postflight.error}`);
    }
  }

  lines.push("final_hosts:");
  lines.push(formatFleetFinalTable(buildFleetFinalRows(receipt)));

  return lines.join("\n");
}

function formatFleetTextFailOpen(
  receipt: SelfUpgradeFleetReceipt,
  receiptPath: string,
  operationPath: string,
  operationProjection: SelfUpgradeFleetResult["operation_projection"],
): string {
  try {
    return formatFleetText(receipt, receiptPath, operationPath, operationProjection);
  } catch (error) {
    return [
      `status: ${receipt.status}`,
      `operation_id: ${path.basename(receipt.aggregate_dir)}`,
      `operation_path: ${operationPath}`,
      `operation_projection: ${operationProjection}`,
      `aggregate_receipt: ${receiptPath}`,
      `render_warning: ${boundedDiagnostic(error instanceof Error ? error.message : String(error), 512)}`,
    ].join("\n");
  }
}

export async function runSelfUpgradeFleet(
  options: SelfUpgradeFleetOptions,
  dependencies: SelfUpgradeFleetDependencies = {},
): Promise<SelfUpgradeFleetResult> {
  const execFileAsync = dependencies.execFileAsync ?? execFileAsyncDefault;
  const resolveAgentsInfraRootDependency = dependencies.resolveAgentsInfraRoot ?? resolveAgentsInfraRoot;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const resolveReceiptAuthTokenUncached = dependencies.resolveReceiptAuthToken ?? (async (host: string) => {
    const agentsInfraRoot = await resolveAgentsInfraRootDependency();
    if (!agentsInfraRoot) return undefined;
    const hostsTruth = await readHostsTruth(agentsInfraRoot);
    const canonicalHost = canonicalFleetHostAlias(host);
    const matchingEntries = Object.entries(hostsTruth.hosts ?? {}).filter(([configuredHost]) => {
      try {
        return canonicalFleetHostAlias(configuredHost) === canonicalHost;
      } catch {
        return false;
      }
    });
    if (matchingEntries.length > 1) {
      throw new Error(
        `Host truth has multiple entries for canonical fleet alias ${canonicalHost}: ${matchingEntries.map(([configuredHost]) => configuredHost).sort().join(", ")}.`,
      );
    }
    const [configuredHost, entry] = matchingEntries[0] ?? [canonicalHost, undefined];
    return resolveConsumerApiClientToken(
      configuredHost,
      entry,
      "operator_cli",
    );
  });
  // Resolve each target credential at most once per fleet invocation. The
  // pre-dispatch probe is an observation: an unavailable token predicts an
  // `unverified` result, but cannot turn receipt verification into mutation
  // authority or suppress otherwise valid host dispatch.
  const receiptAuthTokenResolutions = new Map<string, Promise<string | undefined>>();
  const resolveReceiptAuthToken = (host: string): Promise<string | undefined> => {
    const canonicalHost = canonicalFleetHostAlias(host);
    const pending = receiptAuthTokenResolutions.get(canonicalHost)
      ?? Promise.resolve().then(() => resolveReceiptAuthTokenUncached(canonicalHost));
    receiptAuthTokenResolutions.set(canonicalHost, pending);
    return pending;
  };
  const deps: Required<SelfUpgradeFleetDependencies> = {
    now: dependencies.now ?? (() => new Date().toISOString()),
    homeDir: dependencies.homeDir ?? (() => homedir()),
    execFileAsync,
    resolveAgentsInfraRoot: resolveAgentsInfraRootDependency,
    resolveCurrentHostAlias: dependencies.resolveCurrentHostAlias ?? resolveCurrentHostAlias,
    listRunServeHosts: dependencies.listRunServeHosts ?? listRunServeHosts,
    listDescriptors: dependencies.listDescriptors ?? listDescriptors,
    resolveConductorTargetEvidence:
      dependencies.resolveConductorTargetEvidence
      ?? ((targetRef, conductorHost, explicitTargetSha) => defaultResolveConductorTargetEvidence(
        targetRef,
        conductorHost,
        explicitTargetSha,
        execFileAsync,
      )),
    resolveConductorStartupContractPayload:
      dependencies.resolveConductorStartupContractPayload
      ?? ((targetSha, conductorHost) => defaultResolveConductorStartupContractPayload(targetSha, conductorHost, execFileAsync)),
    resolveConductorCheckoutSha: dependencies.resolveConductorCheckoutSha ?? defaultResolveConductorCheckoutSha,
    resolveRemoteCloneRoot: dependencies.resolveRemoteCloneRoot
      ?? ((host: string) => defaultResolveRemoteCloneRoot(host, resolveAgentsInfraRootDependency)),
    runLocalUpgrade: dependencies.runLocalUpgrade ?? runSelfUpgrade,
    runFreshnessCommand: dependencies.runFreshnessCommand ?? runSelfFreshnessCommand,
    sleep,
    verifyRemoteReceipt:
      dependencies.verifyRemoteReceipt
      ?? ((host, receiptPath, projectedReceipt, runServeUrl, fleetOperationId) => defaultVerifyRemoteReceipt(
        host,
        receiptPath,
        projectedReceipt,
        runServeUrl,
        fleetOperationId,
        dependencies.authToken ?? "",
        dependencies.createAdminClient ?? createCalyxAdminClient,
        resolveReceiptAuthToken,
        sleep,
      )),
    resolveReceiptAuthToken,
    createAdminClient: dependencies.createAdminClient ?? createCalyxAdminClient,
    claimOperation: dependencies.claimOperation ?? claimSelfUpgradeOperation,
    authToken: dependencies.authToken ?? "",
    persistConvergence: dependencies.persistConvergence ?? false,
    progressWrite: dependencies.progressWrite ?? (() => undefined),
    progressStream: dependencies.progressStream ?? process.stderr,
    appendEventProjection: dependencies.appendEventProjection ?? appendControlEvent,
    operationClaimSettleTimeoutMs:
      dependencies.operationClaimSettleTimeoutMs ?? DEFAULT_OPERATION_CLAIM_SETTLE_TIMEOUT_MS,
    eventProjectionSettleTimeoutMs:
      dependencies.eventProjectionSettleTimeoutMs ?? DEFAULT_SELF_UPGRADE_PROJECTION_SETTLE_MS,
    progressNow: dependencies.progressNow ?? (() => new Date().toISOString()),
    monotonicNowMs: dependencies.monotonicNowMs ?? (() => performance.now()),
    heartbeatIntervalMs: dependencies.heartbeatIntervalMs ?? DEFAULT_FLEET_PROGRESS_HEARTBEAT_MS,
    writeArtifact: dependencies.writeArtifact ?? writeFleetArtifactDurable,
    artifactSettleTimeoutMs: dependencies.artifactSettleTimeoutMs ?? FLEET_ARTIFACT_SETTLE_TIMEOUT_MS,
    writeFleetReceipt: dependencies.writeFleetReceipt ?? writeFleetArtifactDurable,
    fleetReceiptMaxBytes:
      dependencies.fleetReceiptMaxBytes ?? SELF_UPGRADE_FLEET_RECEIPT_MAX_BYTES,
    durableDirectoryOpenOptions: dependencies.durableDirectoryOpenOptions ?? {},
    afterFleetReceiptRootValidatedBeforeRetention:
      dependencies.afterFleetReceiptRootValidatedBeforeRetention ?? (async () => {}),
  };

  if (!Number.isSafeInteger(deps.fleetReceiptMaxBytes) || deps.fleetReceiptMaxBytes <= 0) {
    throw createFleetUpgradeError("Fleet receipt byte limit must be a positive safe integer.", 2);
  }

  const targetRef = options.to?.trim() || DEFAULT_TARGET_REF;
  const dryRun = Boolean(options.dryRun);
  const parallel = Boolean(options.parallel);
  const failFast = Boolean(options.failFast);
  const drainDeadlineMs = options.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS;
  const startedAt = deps.now();
  const conductorHost = normalizeHostAlias(await deps.resolveCurrentHostAlias()) || "local";
  const targets = await resolveFleetTargets(options, deps);
  const operationId = `fleet-${formatTimestampForFilename(startedAt)}-${randomUUID()}`;
  const writerId = `fleet-writer-${randomUUID()}`;
  const aggregateAnchor = await createFleetReceiptDirectory(
    deps.homeDir(),
    operationId,
    Date.now(),
    deps.durableDirectoryOpenOptions,
    deps.afterFleetReceiptRootValidatedBeforeRetention,
  );
  const aggregateDir = aggregateAnchor.directory;
  deps.writeArtifact = dependencies.writeArtifact
    ?? ((targetPath, contents) => writeFleetArtifactDurable(targetPath, contents, aggregateAnchor));
  deps.writeFleetReceipt = dependencies.writeFleetReceipt
    ?? ((targetPath, contents) => writeFleetArtifactDurable(targetPath, contents, aggregateAnchor));
  const receiptPath = path.join(aggregateDir, "summary.json");
  // Stable operation id == aggregate-receipt dir basename. Announced (and put
  // on the started event) up front so an async agent driving the fleet upgrade
  // has the handle to watch/recover before the long per-host loop begins.
  let projection: FleetOperationProjection;
  try {
    const eventRoots = await resolveConductorEventRoots(deps);
    projection = await createFleetOperationProjection({
      initial: createSelfUpgradeOperation({
        operationId,
        writerId,
        conductorHost,
        targetRef,
        hosts: targets.map((target) => target.host),
        dryRun,
        parallel,
        failFast,
        startedAt,
      }),
      operationRoot: defaultSelfUpgradeOperationRoot(deps.homeDir()),
      eventRoots,
      json: Boolean(options.json),
      ...(dependencies.progressWrite ? { progressWrite: deps.progressWrite } : {}),
      progressStream: deps.progressStream,
      appendEventProjection: deps.appendEventProjection,
      operationClaimSettleTimeoutMs: deps.operationClaimSettleTimeoutMs,
      eventProjectionSettleTimeoutMs: deps.eventProjectionSettleTimeoutMs,
      now: deps.progressNow,
      monotonicNowMs: deps.monotonicNowMs,
      heartbeatIntervalMs: deps.heartbeatIntervalMs,
      claimOperation: deps.claimOperation,
    });
  } catch (error) {
    await aggregateAnchor.close().catch(() => undefined);
    throw error;
  }

  const persistAuthoritativeFleetReceipt = async (
    candidate: SelfUpgradeFleetReceipt,
  ): Promise<SelfUpgradeFleetReceipt> => {
    let prepared: ReturnType<typeof prepareAuthoritativeFleetReceipt>;
    try {
      prepared = prepareAuthoritativeFleetReceipt(candidate, deps.fleetReceiptMaxBytes);
      await deps.writeFleetReceipt(receiptPath, prepared.contents);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await projection.recordDurabilityIssue({
        observed_at: deps.progressNow(),
        scope: "final_receipt",
        code: "fleet_receipt_persist_failed",
        message,
      });
      throw error;
    }
    if (prepared.wasBounded) {
      await projection.recordDurabilityIssue({
        observed_at: deps.progressNow(),
        scope: "final_receipt",
        code: "fleet_receipt_bounded",
        message: `Fleet receipt was reduced from ${prepared.receipt.bounded!.original_bytes} bytes to remain within ${prepared.receipt.bounded!.max_bytes} bytes; host verdicts and canonical locators were retained.`,
      }).catch(() => undefined);
    }
    return prepared.receipt;
  };
  let fleetResult: SelfUpgradeFleetResult | undefined;

  try {

    // POL-2045: resolve and validate the one conductor-owned evidence bundle
  // before any local or SSH host dispatch. Persist a typed non-verdict receipt
  // on failure; every host remains explicitly unassessed.
  let evidencePhase: "target_sha" | "startup_contract" = "target_sha";
  let conductorTargetEvidence: SelfUpgradeTargetEvidence;
  let conductorStartupContractPayload: string;
  let targetEvidence: SelfUpgradeFleetTargetEvidence;
  try {
    conductorTargetEvidence = await deps.resolveConductorTargetEvidence(
      targetRef,
      conductorHost,
      options.targetSha?.trim(),
    ) ?? {
      original_ref: targetRef,
      target_sha: "",
      fetch_remote: "",
      fetch_ref: "",
    };
    if (
      conductorTargetEvidence.original_ref !== targetRef
      || !/^[0-9a-f]{40}$/i.test(conductorTargetEvidence.target_sha)
      || !conductorTargetEvidence.fetch_remote.trim()
      || !conductorTargetEvidence.fetch_ref.trim()
    ) {
      throw new Error(`Conductor target ${targetRef} did not resolve to a full 40-character SHA.`);
    }
    evidencePhase = "startup_contract";
    conductorStartupContractPayload = await deps.resolveConductorStartupContractPayload(
      conductorTargetEvidence.target_sha,
      conductorHost,
    );
    validateTargetStartupContractPayload(conductorStartupContractPayload, conductorTargetEvidence.target_sha);
    targetEvidence = {
      status: "resolved",
      original_ref: conductorTargetEvidence.original_ref,
      target_sha: conductorTargetEvidence.target_sha,
      fetch_remote: conductorTargetEvidence.fetch_remote,
      fetch_ref: conductorTargetEvidence.fetch_ref,
      startup_contract_payload_sha256: createHash("sha256").update(conductorStartupContractPayload, "utf8").digest("hex"),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const failedEvidence: Extract<SelfUpgradeFleetTargetEvidence, { status: "failed" }> = {
      status: "failed",
      error_code: evidencePhase === "target_sha"
        ? "target_sha_unavailable"
        : "startup_contract_evidence_unavailable",
      error: detail,
    };
    targetEvidence = failedEvidence;
    const perHost: SelfUpgradeFleetHostResult[] = targets.map((target) => ({
      host: target.host,
      status: "skipped",
      exit_code: 0,
      elapsed_ms: 0,
      error: `Not dispatched: mandatory conductor target evidence failed (${failedEvidence.error_code}).`,
    }));
    const completedAt = deps.now();
    let receipt: SelfUpgradeFleetReceipt = {
      schema_version: "self-upgrade-fleet-receipt/v1",
      conductor_host: conductorHost,
      target_ref: targetRef,
      dry_run: dryRun,
      parallel,
      fail_fast: failFast,
      started_at: startedAt,
      completed_at: completedAt,
      aggregate_dir: aggregateDir,
      status: "failed",
      target_evidence: targetEvidence,
      startup_contract: summarizeStartupContractVerdicts(perHost),
      per_host: perHost,
      per_host_receipt_locators: {},
    };
    receipt = await persistAuthoritativeFleetReceipt(receipt);
    for (const host of perHost) {
      await projection.relay.transition({
        schema_version: "self-upgrade-operation/v1",
        record: "transition",
        kind: "host_result",
        transition_id: selfUpgradeTransitionId([operationId, "host_result", host.host]),
        operation_id: operationId,
        emitted_at: completedAt,
        observed_at: completedAt,
        host: host.host,
        status: host.status,
        elapsed_ms: 0,
        relay_mode: "missing",
        ...(host.error ? { error: host.error } : {}),
      });
    }
    const finalRows = buildFleetFinalRows(receipt);
    await projection.finalize({
      schema_version: "self-upgrade-operation/v1",
      record: "transition",
      kind: "fleet_final",
      transition_id: selfUpgradeTransitionId([operationId, "fleet_final"]),
      operation_id: operationId,
      emitted_at: completedAt,
      observed_at: deps.progressNow(),
      status: receipt.status,
      receipt_path: receiptPath,
      rows: finalRows,
    });
    const failureMessage = `${targetEvidence.error_code}: ${detail}; zero fleet hosts dispatched.`;
    fleetResult = {
      operation_id: operationId,
      operation_path: projection.operationPath,
      operation_projection: projection.projectionStatus,
      operation: projection.record,
      receipt_path: receiptPath,
      receipt,
      text: formatFleetTextFailOpen(
        receipt,
        receiptPath,
        projection.operationPath,
        projection.projectionStatus,
      ),
      exitCode: 6,
      failureMessage,
      ...(projection.warnings.length > 0 ? { warnings: projection.warnings } : {}),
    };
    return fleetResult;
  }

  if (
    !dryRun
    && dependencies.verifyRemoteReceipt === undefined
    && !deps.authToken.trim()
  ) {
    const unavailable: string[] = [];
    for (const target of targets.filter(
      (candidate) => normalizeHostAlias(candidate.host) !== conductorHost,
    )) {
      try {
        if (!(await deps.resolveReceiptAuthToken(target.host))?.trim()) {
          unavailable.push(`${target.host}: credential unavailable`);
        }
      } catch (error) {
        unavailable.push(
          `${target.host}: ${boundedDiagnostic(error instanceof Error ? error.message : String(error), 1_024)}`,
        );
      }
    }
    if (unavailable.length > 0) {
      projection.warning(
        "upgrade_receipt_auth_unavailable",
        "Canonical receipt authentication is unavailable before dispatch; affected hosts will still run and settle as unverified unless another authoritative verification path succeeds.",
        unavailable.join("; "),
      );
    }
  }

  await projection.bindTarget(conductorTargetEvidence.target_sha, deps.progressNow());
  await projection.appendEventProjection(
    buildControlEvent({
      now: startedAt,
      eventType: "daemon.upgrade.fleet.started",
      emittedBy: "self-upgrade",
      host: conductorHost,
      operationId,
      fleet: {
        target_ref: targetRef,
        parallel,
        dry_run: dryRun,
        fail_fast: failFast,
        hosts: buildPendingStatusMap(targets),
      },
    }),
    "Unable to append the fleet-started event; host-local execution truth is unchanged.",
  );

  const perHost: SelfUpgradeFleetHostResult[] = [];
  const hostOptions = {
    to: targetRef,
    dryRun,
    drainDeadlineMs,
    yes: Boolean(options.yes),
    force: Boolean(options.force),
    abortRuns: Boolean(options.abortRuns),
    drainAll: Boolean(options.drainAll),
  };

  if (parallel) {
    const settled = await Promise.allSettled(
      targets.map((target) => executeFleetHost(
        target.host,
        target.runServeUrl,
        aggregateDir,
        hostOptions,
        conductorTargetEvidence,
        conductorStartupContractPayload,
        normalizeHostAlias(target.host) === conductorHost,
        deps,
        projection.relay,
      )),
    );
    const rejected: string[] = [];
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === "fulfilled") {
        perHost.push(outcome.value);
        continue;
      }
      const host = targets[index]?.host ?? `host-${index}`;
      rejected.push(`${host}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
    }
    if (rejected.length > 0) {
      throw createFleetUpgradeError(
        `Parallel fleet execution failed after every dispatched host settled: ${rejected.join("; ")}`,
        1,
      );
    }
  } else {
    for (const target of targets) {
      const result = await executeFleetHost(
        target.host,
        target.runServeUrl,
        aggregateDir,
        hostOptions,
        conductorTargetEvidence,
        conductorStartupContractPayload,
        normalizeHostAlias(target.host) === conductorHost,
        deps,
        projection.relay,
      );
      perHost.push(result);
      if (failFast && result.status === "failed") {
        for (const skipped of targets.slice(perHost.length)) {
          const skippedResult: SelfUpgradeFleetHostResult = {
            host: skipped.host,
            status: "skipped",
            exit_code: 0,
            elapsed_ms: 0,
            error: `Skipped because --fail-fast stopped after ${result.host}.`,
          };
          perHost.push(skippedResult);
          const skippedAt = deps.progressNow();
          await projection.relay.transition({
            schema_version: "self-upgrade-operation/v1",
            record: "transition",
            kind: "host_result",
            transition_id: selfUpgradeTransitionId([operationId, "host_result", skipped.host]),
            operation_id: operationId,
            emitted_at: skippedAt,
            observed_at: skippedAt,
            host: skipped.host,
            status: "skipped",
            elapsed_ms: 0,
            relay_mode: "missing",
            error: skippedResult.error!,
          });
        }
        break;
      }
    }
  }

  const failures = perHost.filter((result) => result.status === "failed");
  const unverified = perHost.filter((result) => result.status === "unverified");
  const postflightEvidence = await collectFleetPostflight({
    dryRun,
    targetRef,
    targetSha: conductorTargetEvidence.target_sha,
    perHost,
    authToken: deps.authToken,
    settleWindowMs: normalizeSettleWindowMs(options.postflightSettleWindowMs),
    runFreshnessCommand: deps.runFreshnessCommand,
    sleep: deps.sleep,
    monotonicNowMs: deps.monotonicNowMs,
    now: deps.now,
  });
  const completedAt = deps.now();
  const postflight: SelfUpgradeFleetPostflight | undefined = postflightEvidence
    ? { ...postflightEvidence, checked_at: completedAt }
    : undefined;
  const authorityFailure = postflight?.status === "failed"
    || (postflight?.freshness_exit_code ?? 0) !== 0;
  let receipt: SelfUpgradeFleetReceipt = {
    schema_version: "self-upgrade-fleet-receipt/v1",
    conductor_host: conductorHost,
    target_ref: targetRef,
    dry_run: dryRun,
    parallel,
    fail_fast: failFast,
    started_at: startedAt,
    completed_at: completedAt,
    aggregate_dir: aggregateDir,
    status: failures.length > 0 || authorityFailure
      ? "failed"
      : unverified.length > 0
        ? "unverified"
        : dryRun
          ? "dry-run"
          : "succeeded",
    target_evidence: targetEvidence,
    startup_contract: summarizeStartupContractVerdicts(perHost),
    per_host: perHost,
    per_host_receipt_locators: Object.fromEntries(
      perHost
        .filter((result) => result.receipt_locator)
        .map((result) => [result.host, result.receipt_locator!] as const),
    ),
    ...(postflight ? { postflight } : {}),
  };
  // Finalization phase: every host has been dispatched and is at target; the
  // conductor is now collecting per-host receipts into the aggregate summary.
  // Emitted on the same event plane (reuses `appendControlEvent`) before the
  // summary write so a watcher can distinguish "still rolling hosts" from "all
  // hosts done, writing the aggregate receipt." Shares `completedAt` so the
  // JSONL/event_log order stays started → finalize → fleet.completed.
  await projection.appendEventProjection(
    buildControlEvent({
      now: completedAt,
      eventType: "daemon.upgrade.progress",
      emittedBy: "self-upgrade",
      host: conductorHost,
      operationId,
      phase: "finalize",
    }),
    "Unable to append the fleet-finalize event; aggregate receipt authority is unchanged.",
  );
  receipt = await persistAuthoritativeFleetReceipt(receipt);

  const failureMessage = summarizeFleetAuthorityFailure(perHost, postflight);
  await projection.appendEventProjection(
    buildControlEvent({
      now: completedAt,
      eventType: receipt.status === "succeeded" || receipt.status === "dry-run"
        ? "daemon.upgrade.fleet.completed"
        : "daemon.upgrade.fleet.failed",
      emittedBy: "self-upgrade",
      host: conductorHost,
      operationId,
      ...(failureMessage ? { error: failureMessage } : {}),
      fleet: {
        target_ref: targetRef,
        parallel,
        dry_run: dryRun,
        fail_fast: failFast,
        hosts: buildFleetStatusMap(perHost),
      },
    }),
    "Unable to append the fleet terminal event; host-local truth and the final receipt remain authoritative.",
  );

  const warnings = projection.warnings;
  const finalRows = buildFleetFinalRows(receipt);
  await projection.finalize({
    schema_version: "self-upgrade-operation/v1",
    record: "transition",
    kind: "fleet_final",
    transition_id: selfUpgradeTransitionId([operationId, "fleet_final"]),
    operation_id: operationId,
    emitted_at: completedAt,
    observed_at: deps.progressNow(),
    status: receipt.status,
    receipt_path: receiptPath,
    rows: finalRows,
  });

  // Fleet convergence is a best-effort local projection. Emit fleet_final
  // first, then bound checkout/SQLite persistence so a hung diagnostic probe
  // cannot delay the authoritative terminal receipt or progress stream.
  if (deps.persistConvergence) {
    const convergence = await settleFailOpenProjection(async () => {
      const conductorCheckoutSha = await deps.resolveConductorCheckoutSha(conductorHost);
      if (!conductorCheckoutSha) {
        throw new Error("Unable to resolve the conductor source checkout HEAD.");
      }
      await persistFleetUpgradePendingRows({
        perHost,
        targetRev: conductorTargetEvidence.target_sha,
        checkoutHead: conductorCheckoutSha,
        checkedAt: completedAt,
        receiptPath,
        targetRef,
        dryRun,
      });
    }, deps.eventProjectionSettleTimeoutMs);
    if (convergence.status !== "fulfilled") {
      warnings.push(persistenceWarning(
        "Unable to persist fleet convergence pending rows; fleet upgrade receipt and exit code are unchanged.",
        convergence.status === "timeout"
          ? `did not settle within ${Math.max(0, deps.eventProjectionSettleTimeoutMs)}ms`
          : convergence.error instanceof Error
            ? convergence.error.message
            : String(convergence.error),
      ));
    }
  }

    fleetResult = {
      operation_id: operationId,
      operation_path: projection.operationPath,
      operation_projection: projection.projectionStatus,
      operation: projection.record,
      receipt_path: receiptPath,
      receipt,
      text: formatFleetTextFailOpen(
        receipt,
        receiptPath,
        projection.operationPath,
        projection.projectionStatus,
      ),
      exitCode: failures.length > 0 || unverified.length > 0
        ? 1
        : authorityFailure
          ? Math.max(1, postflight?.freshness_exit_code ?? 1)
          : 0,
      ...(failureMessage ? { failureMessage } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    return fleetResult;
  } finally {
    try {
      await projection.stop();
      if (fleetResult) {
        fleetResult.operation_projection = projection.projectionStatus;
        fleetResult.text = formatFleetTextFailOpen(
          fleetResult.receipt,
          fleetResult.receipt_path,
          fleetResult.operation_path,
          projection.projectionStatus,
        );
        if (projection.warnings.length > 0) {
          fleetResult.warnings = projection.warnings;
        } else {
          delete fleetResult.warnings;
        }
      }
    } finally {
      await aggregateAnchor.close().catch(() => undefined);
    }
  }
}
