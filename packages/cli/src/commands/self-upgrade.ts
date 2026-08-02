import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback, spawn as spawnChild } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { createReadStream } from "node:fs";
import type { BigIntStats } from "node:fs";
import { access, copyFile, link, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, stat, statfs, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import { promisify } from "node:util";
import YAML from "yaml";
import {
  adminOperationRoutes,
  createCalyxAdminClient,
  type CalyxResult,
} from "@polli-labs/calyx-client/admin";
import {
  CALYX_CLI_PACKAGE_NAME,
  CALYX_ADMIN_RUN_LIST_MAX_ITEMS,
  CALYX_DAEMON_FEATURES,
  CALYX_INSTALL_BUILD_INFO_FILENAME,
  acquireCooperativeFileLock,
  OrchestrationLedgerSink,
  applySelfUpgradeOperationTransition,
  bindSelfUpgradeOperationTarget,
  claimSelfUpgradeOperation,
  createSelfUpgradeOperation,
  defaultSelfUpgradeOperationRoot,
  installBootstrap,
  loadStateDriver,
  openStateStore,
  readCalyxBuildInfo,
  readHostsTruth,
  resolveCalyxInstallBinPath,
  resolveCalyxInstallBuildInfoPath,
  resolveCalyxInstallPackageBuildInfoPath,
  resolveCalyxInstallsRoot,
  resolveAgentsInfraRoot,
  resolveConsumerApiClientToken,
  resolveConsumerApiCredentialVerifiers,
  resolveCurrentHostAlias,
  resolveCurrentCalyxInstallLink,
  resolveRepo,
  resolveStatePaths,
  isConsumerApiSecretEnvName,
  RunIndexProjection,
  selfUpgradeTransitionId,
} from "@polli-labs/calyx-core";
import type {
  CalyxBuildInfo,
  CalyxAdminHealth as CalyxDaemonHealth,
  CalyxDaemonDescriptor,
  CalyxDaemonSupervisorAdapter,
  HostsTruthFile,
  InstallBootstrapResult,
  SelfUpgradeOperationRecord,
  SelfUpgradeOperationTransition,
  SelfUpgradeOperationWriter,
} from "@polli-labs/calyx-core";
import {
  createSupervisorAdapter,
  defaultDaemonsRoot,
  listDescriptors,
  readDescriptor,
  RunService,
  RunStore,
  writeDescriptor,
} from "@polli-labs/calyx-run-service";
import {
  validateOperationSuccessResponse,
  type SelfUpgradeArtifactCleanupReceipt as SelfUpgradeArtifactCleanupContract,
  type SelfUpgradeFilesystemIdentity as SelfUpgradeFilesystemIdentityContract,
  type SelfUpgradeMaintenanceDispositionReceipt as SelfUpgradeMaintenanceDispositionContract,
  type SelfUpgradeStateSnapshotReceipt as SelfUpgradeStateSnapshotContract,
  type SelfUpgradeSupervisorEffectiveStateReceipt as SelfUpgradeSupervisorEffectiveStateContract,
  type SelfUpgradeSupervisorInstallReceipt as SelfUpgradeSupervisorInstallContract,
  type SelfUpgradeSupervisorReadinessReceipt as SelfUpgradeSupervisorReadinessContract,
  type SelfUpgradeTargetAcceptanceReceipt as SelfUpgradeTargetAcceptanceContract,
  type SelfUpgradeTargetStateAppliedReceipt as SelfUpgradeTargetStateAppliedContract,
  type SelfUpgradeTargetStateMigratedReceipt as SelfUpgradeTargetStateMigratedContract,
  type SelfUpgradeTargetStateReadinessReceipt as SelfUpgradeTargetStateReadinessContract,
} from "@polli-labs/calyx-server";
import type {
  CalyxControlEvent,
  CalyxUpgradePhase,
  DetachedWorkerSupervisor,
  RunListEntry,
  RunRecord,
} from "@polli-labs/calyx-run-service";
import { defaultSelfUpgradeLockPath, acquireSelfUpgradeLock } from "../self-upgrade-lock.js";
import {
  toSelfUpgradeProgressTransition,
  type SelfUpgradePhaseEvent,
} from "../self-upgrade-progress.js";
import {
  computeStartupContractVerdict,
  defaultResolveSupervisorEnvNames,
  resolveConsumerApiCredentialEnvContract,
  type SelfUpgradeStartupContractVerdict,
  type StartupContractBlockingReasonCode,
  type SupervisorEnvInspection,
} from "../self-upgrade-startup-contract.js";
import {
  createFailOpenProjectionWriter,
  DEFAULT_SELF_UPGRADE_PROJECTION_SETTLE_MS,
  settleFailOpenProjection,
} from "../self-upgrade-stream-io.js";
import {
  defaultSelfUpgradeReceiptRoot,
  writeSelfUpgradeReceiptDurable,
} from "../self-upgrade-receipt-store.js";

const execFile = promisify(execFileCallback);

const DEFAULT_TARGET_REF = "origin/main";
const DEFAULT_DRAIN_DEADLINE_MS = 10 * 60 * 1_000;
// Restart verification must cover a real cold start, not only the time needed
// for the supervisor to fork a process. Blade's 14.3 GB state store can take
// more than six minutes to reopen, reconcile, and begin listening after an
// otherwise healthy restart. Keep the wait finite and on the semantic clock,
// but do not trigger rollback while the target is still legitimately booting.
const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1_000;
const DRAIN_POLL_INTERVAL_MS = 1_000;
const VERIFY_POLL_INTERVAL_MS = 500;
const BUILD_LOG_TAIL_LINES = 40;
const STALE_INSTALL_RESIDUE_AGE_MS = 24 * 60 * 60 * 1_000;
const STAGING_MINIMUM_RELEASE_AGE_MINUTES = 10_080;
const EXPLICIT_TARGET_BACKUP_REF_PREFIX = "backup/self-upgrade/";
const EXPLICIT_TARGET_BACKUP_REF_KEEP = 12;
const EXPLICIT_TARGET_BACKUP_REF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const SELF_UPGRADE_ADMIN_RUN_SCAN_MAX_ITEMS = CALYX_ADMIN_RUN_LIST_MAX_ITEMS * 100;
const STATE_CUTOVER_MINIMUM_GROWTH_RESERVE_BYTES = 64 * 1024 * 1024;
const STATE_CUTOVER_FILESYSTEM_OVERHEAD_BYTES = 16 * 1024 * 1024;
const SELF_UPGRADE_TARGET_NON_SECRET_ENV_ALLOWLIST = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  // The target owns the supervisor cutover, so it must be able to reach the
  // per-user service manager. `systemctl --user` resolves the session bus from
  // XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS and fails closed without them
  // ("Failed to connect to bus: No medium found"), which the systemd adapter
  // reports as `running: false` and the cutover gate correctly refuses to
  // snapshot. Neither name is a secret. Same class as the daemon-side strip
  // fixed in agents-infra 08bc760; this is the self-upgrade side of it.
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "CALYX_AGENTS_INFRA_ROOT",
  "CALYX_STATE_HOME",
  "CALYX_STATE_DB",
] as const;

// TODO POL-1120: swap these literals for the shared daemon feature registry once PR3 merges.
export const EXPECTED_DAEMON_BASELINE_FEATURES = [
  "run.agent_runner/v1",
  "run.default_path_injection/v1",
  "run.detached_worker_diagnostics/v1",
] as const;

const REQUIRED_BUILD_ARTIFACTS = [
  "packages/cli/dist/bin.js",
  "packages/cli/dist/index.js",
  "packages/run-service/dist/index.js",
  "packages/server/dist/index.js",
  "packages/server/dist/.build-info.json",
] as const;

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export interface VersionedInstallWorkspacePackage {
  name: string;
  relativePath: string;
}

type WorkspacePackageManifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export interface VersionedInstallPrepareOptions {
  repoRoot: string;
  gitHead: string;
  installsRoot?: string;
  keep?: number;
  workspacePackages?: readonly VersionedInstallWorkspacePackage[];
  entryPackageName?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<CommandResult>;
}

export interface VersionedInstallPruneOptions {
  installsRoot?: string;
  keep?: number;
  descriptors?: readonly Pick<CalyxDaemonDescriptor, "argv">[];
  wrapperPath?: string;
  nowMs?: number;
  staleResidueAgeMs?: number;
}

export interface VersionedInstallPruneReceipt {
  pruned: string[];
  swept_stale_temps: string[];
}

export interface VersionedInstallReceipt {
  install_path: string;
  current_link: string;
  /** Exact current target observed before preparation; null means absent. */
  previous_current_install_path?: string | null;
  build_info_path: string;
  bin_path: string;
  git_head: string;
  verified_version: string;
  artifact_manifest_sha256?: string;
  artifact_manifest_packages?: string[];
  pruned: string[];
  swept_stale_temps?: string[];
  materialized: boolean;
  /**
   * Preparation and promotion are separate authority boundaries. A prepared
   * install is verified and immutable but cannot affect the running fleet
   * until the canonical self-upgrade transaction atomically flips `current`.
   */
  promoted: boolean;
  mechanism: "pack-install";
  rollback_command: string;
}

export interface SelfUpgradeDaemonRestartReceipt {
  daemon_id: string;
  supervisor: CalyxDaemonDescriptor["supervisor"]["kind"];
  stopped: string;
  started: string;
}

export type SelfUpgradeSupervisorReadinessReceipt = SelfUpgradeSupervisorReadinessContract;
export type SelfUpgradeSupervisorEffectiveStateReceipt = SelfUpgradeSupervisorEffectiveStateContract;
export type SelfUpgradeTargetStateReadinessReceipt = SelfUpgradeTargetStateReadinessContract;

/**
 * The cutover's own migration step: the prepared target brings the state store
 * to its declared schema while every daemon is stopped and the rollback
 * snapshot is already pinned, before the supervisor unit or the `current`
 * symlink has been touched. A failure here unwinds state only.
 */
export type SelfUpgradeTargetStateMigratedReceipt = SelfUpgradeTargetStateMigratedContract;
export type SelfUpgradeTargetStateAppliedReceipt = SelfUpgradeTargetStateAppliedContract;

export interface SelfUpgradeTargetHandoff {
  schema_version: "self-upgrade-target-handoff/v1";
  operation_id: string;
  fleet_operation_id?: string;
  created_at: string;
  planner: {
    entry_realpath: string;
    node_realpath: string;
    node_version: string;
    handoff_interface: "self-upgrade-target-handoff/v1";
    operation_schema: "self-upgrade-operation/v1";
  };
  target: {
    git_head: string;
    install_path: string;
    bin_path: string;
    build_info_path: string;
    build_info_sha256: string;
    artifact_manifest_sha256: string;
    artifact_manifest_packages: string[];
    verified_version: string;
    planning_interface: "self-upgrade-target-planning/v1";
    startup_contract_interface: "calyx-startup-contract/v1";
  };
  previous_current: {
    install_path: string;
    git_head: string;
    current_link: string;
  };
  request: {
    host: string;
    target_ref: string;
    target_evidence: SelfUpgradeTargetEvidence;
    force: boolean;
    abort_runs: boolean;
    /** Added in POL-2048; absence identifies a legacy request normalized below. */
    drain_all?: boolean;
    /** @deprecated Interpreted only when a legacy handoff omits `drain_all`. */
    continuous: boolean;
    drain_deadline_ms: number;
  };
}

export type SelfUpgradeTargetAcceptanceReceipt = SelfUpgradeTargetAcceptanceContract;

export interface SelfUpgradeTargetProcessEnvelope {
  schema_version: "self-upgrade-target-process-result/v1";
  operation_id: string;
  result?: SelfUpgradeResult;
  failure?: SelfUpgradeCommandFailureOutput;
}

export type SelfUpgradeStateSnapshotReceipt = SelfUpgradeStateSnapshotContract;
export type SelfUpgradeFilesystemIdentity = SelfUpgradeFilesystemIdentityContract;

export interface SelfUpgradeStateRollbackReceipt {
  schema_version: "self-upgrade-state-rollback/v1";
  status: "succeeded" | "failed";
  restored_sha256?: string;
  quick_check?: "ok";
  error?: string;
}

export interface SelfUpgradeStateCutover {
  snapshot: SelfUpgradeStateSnapshotReceipt;
  restore: () => Promise<SelfUpgradeStateRollbackReceipt>;
  cleanup: () => Promise<void>;
}

type SelfUpgradeCutoverJournalPhase =
  | "prepared"
  | "quiesced"
  | "daemons_stopping"
  | "daemons_stopped"
  | "state_snapshotting"
  | "state_snapshotted"
  | "state_migrating"
  | "state_migrated"
  | "supervisor_installing"
  | "supervisor_installed"
  | "binary_promoting"
  | "binary_promoted"
  | "target_starting"
  | "target_started"
  | "target_verified"
  | "committed";

const SELF_UPGRADE_CUTOVER_JOURNAL_PHASES: readonly SelfUpgradeCutoverJournalPhase[] = [
  "prepared",
  "quiesced",
  "daemons_stopping",
  "daemons_stopped",
  "state_snapshotting",
  "state_snapshotted",
  "state_migrating",
  "state_migrated",
  "supervisor_installing",
  "supervisor_installed",
  "binary_promoting",
  "binary_promoted",
  "target_starting",
  "target_started",
  "target_verified",
  "committed",
];

export interface SelfUpgradeCutoverJournal {
  schema_version: "self-upgrade-cutover-journal/v1";
  operation_id: string;
  host: string;
  phase: SelfUpgradeCutoverJournalPhase;
  updated_at: string;
  previous_install_path: string;
  previous_git_head: string;
  current_link: string;
  wrapper_path: string;
  target_install_path: string;
  descriptors: CalyxDaemonDescriptor[];
  plan_daemons: SelfUpgradePlanDaemon[];
  maintenance_before?: Array<{
    daemon_id: string;
    enabled: boolean;
  }>;
  target_acceptance?: SelfUpgradeTargetAcceptanceReceipt;
  supervisor_readiness: SelfUpgradeSupervisorReadinessReceipt;
  state_snapshot?: SelfUpgradeStateSnapshotReceipt;
}

export type SelfUpgradeSupervisorInstallReceipt = SelfUpgradeSupervisorInstallContract;

export interface SelfUpgradeSupervisorRollbackReceipt {
  schema_version: "self-upgrade-supervisor-rollback/v1";
  status: "skipped" | "succeeded" | "failed";
  restored_sha256?: string;
  restored_present?: boolean;
  restored_loaded?: boolean;
  restored_running?: boolean;
  effective_state?: SelfUpgradeSupervisorEffectiveStateReceipt;
  error?: string;
}

export interface SelfUpgradeSupervisorCutover {
  readiness: SelfUpgradeSupervisorReadinessReceipt;
  install: () => Promise<SelfUpgradeSupervisorInstallReceipt>;
  restore: () => Promise<SelfUpgradeSupervisorRollbackReceipt>;
  verifyInstalled?: () => Promise<SelfUpgradeSupervisorEffectiveStateReceipt>;
  verifyRestored?: () => Promise<SelfUpgradeSupervisorEffectiveStateReceipt>;
}

export interface SelfUpgradeRollbackReceipt {
  status: "skipped" | "succeeded" | "failed";
  reason?: string;
  failed_promote?: Pick<VersionedInstallReceipt, "install_path" | "current_link" | "git_head">;
  previous_install_path?: string;
  previous_git_head?: string;
  current_link?: string;
  daemons_restarted?: SelfUpgradeDaemonRestartReceipt[];
  verified_daemons?: Array<{
    daemon_id: string;
    pid?: number;
    build: CalyxDaemonDescriptor["build"];
  }>;
  supervisor?: SelfUpgradeSupervisorRollbackReceipt;
  state?: SelfUpgradeStateRollbackReceipt;
  error?: string;
}

export interface SelfUpgradeExplicitTargetAdoptionReceipt {
  mode: "ff-only" | "hard-reset";
  target_head: string;
  fetch_head: string;
  before_reset_head?: string;
  backup_ref?: string;
  pruned_backup_refs?: string[];
  pruned_superseded_backup_refs?: string[];
  pruned_expired_unmerged_backup_refs?: string[];
  backup_prune_warnings?: string[];
}

/** One normalized target authority shared by conductor planning and host apply. */
export interface SelfUpgradeTargetEvidence {
  original_ref: string;
  target_sha: string;
  fetch_remote: string;
  fetch_ref: string;
}

type ActiveRunCategory =
  | "drainable"
  | "blocking_resumable"
  | "blocking_unhealthy"
  | "blocking_unknown";

export interface SelfUpgradeOptions {
  host: string;
  /** Private prepared-target entry marker; never exposed as CLI grammar. */
  targetHandoffOperationId?: string;
  /** Test-only/internal recursion barrier for the target-owned engine. */
  targetOwnedExecution?: boolean;
  /**
   * Private conductor binding for one host mutation inside a fleet operation.
   * This is persisted in the host-owned receipt so terminal stdout cannot
   * select an unrelated durable receipt as authority for the current dispatch.
   * It is not a public CLI flag.
   */
  fleetOperationId?: string;
  to?: string;
  /**
   * Explicit target SHA to upgrade to. When set, supersedes `to`-based target
   * selection. When omitted, planning fetches `to` and pins `FETCH_HEAD` before
   * assessing the startup contract. Apply always re-fetches the branch, proves
   * the planned SHA remains reachable, and adopts that exact planned SHA.
   *
   * Intended for fleet upgrades where the conductor has already resolved
   * the canonical target SHA (e.g. by observing the merged HEAD on its
   * own checkout) and wants every host to converge on that exact SHA
   * regardless of each host's local fetch state. See POL-1151.
   *
   * There is no unpinned pull path within an invocation. A standalone dry-run
   * is a point-in-time assessment; replaying it exactly requires passing its
   * `target_head` back as `--target-sha` on the later apply invocation.
   */
  targetSha?: string;
  /** Conductor-normalized ref evidence; required for non-default fleet spellings. */
  targetEvidence?: SelfUpgradeTargetEvidence;
  /** SHA-bound conductor evidence; transported only between fleet invocations. */
  startupContractPayload?: string;
  dryRun?: boolean;
  force?: boolean;
  abortRuns?: boolean;
  /** Force every active run through the drain path, including restart-safe runs. */
  drainAll?: boolean;
  authToken?: string;
  drainDeadlineMs?: number;
  /** @deprecated CLI compatibility input; transparent preservation is the default. */
  continuous?: boolean;
}

export interface SelfUpgradeActiveRun {
  run_id: string;
  runs_root: string;
  state: RunRecord["state"];
  health_status?: NonNullable<RunRecord["health"]>["status"];
  resumable: boolean;
  category: ActiveRunCategory;
  /**
   * POL-1886: true iff this run is a live detached `agent_runner` worker that
   * survives a daemon restart and is re-adopted on boot (so transparent update
   * can preserve it). `restart_block_reason` carries the classified
   * reason when false.
   */
  restart_safe: boolean;
  restart_block_reason?: string;
  /**
   * POL-2044: the supervisor recorded on the run's detached-launch evidence,
   * when present. Explains why a healthy run drains (`direct`) versus preserves
   * (`systemd`) across a preserving restart.
   */
  worker_supervisor?: DetachedWorkerSupervisor;
  summary: string;
}

export interface SelfUpgradePlanDaemon {
  daemon_id: string;
  pid: number;
  runs_root: string;
  health_url: string;
  restart_order: number;
  supervisor: CalyxDaemonDescriptor["supervisor"];
  build: CalyxDaemonDescriptor["build"];
  maintenance_mode: boolean;
}

export type SelfUpgradeDiagnosticKind = "daemon_out_of_registration";

export interface SelfUpgradeDiagnostic {
  kind: SelfUpgradeDiagnosticKind;
  severity: "blocking";
  daemon_id: string;
  health_url: string;
  pid?: number;
  active_runs: number;
  message: string;
  actions: string[];
}

export interface SelfUpgradePlan {
  host: string;
  repo_root: string;
  current_head: string;
  target_ref: string;
  target_head?: string;
  target_evidence: SelfUpgradeTargetEvidence;
  promoted_build?: {
    git_head: string;
    install_path: string;
    current_link: string;
  };
  dirty: boolean;
  dirty_paths: string[];
  missing_build_artifacts: string[];
  daemons: SelfUpgradePlanDaemon[];
  active_runs_post_reconcile: SelfUpgradeActiveRun[];
  preservation: SelfUpgradePreservationPlan;
  /**
   * POL-2045: per-host startup-contract preflight. Compares the target binary's
   * versioned startup-environment requirements (env NAMES only) against the live
   * supervisor definition. `incompatible` names the diff and blocks promotion;
   * `unknown` is reserved for proven pre-contract targets or uninspectable
   * supervisor semantics; corrupt/future post-contract manifests fail closed.
   */
  startup_contract?: SelfUpgradeStartupContractVerdict;
  blockers: string[];
  warnings: string[];
  diagnostics: SelfUpgradeDiagnostic[];
}

export interface SelfUpgradePreservationPlan {
  policy: "automatic" | "drain_all" | "abort_runs";
  status: "available" | "disabled" | "unavailable" | "not_applicable";
  required_features: string[];
  /** Populated only when `status` is `unavailable`; names the failed feature proofs. */
  unavailable_reasons: string[];
  /** Explains a `disabled`/`not_applicable` status without implying degradation. */
  note?: string;
}

export interface SelfUpgradeReceipt {
  schema_version: "self-upgrade-receipt/v1";
  /** Host-local operation id; must equal the canonical receipt basename. */
  operation_id?: string;
  /** Conductor-generated parent operation id for fleet-dispatched upgrades. */
  fleet_operation_id?: string;
  host: string;
  target_ref: string;
  target_evidence: SelfUpgradeTargetEvidence;
  status: "succeeded" | "failed";
  started_at: string;
  completed_at: string;
  repo_root: string;
  before_head: string;
  after_head?: string;
  commit_list: string[];
  before_builds: Array<{
    daemon_id: string;
    pid: number;
    build: CalyxDaemonDescriptor["build"];
  }>;
  after_builds: Array<{
    daemon_id: string;
    pid?: number;
    build?: CalyxDaemonDescriptor["build"];
  }>;
  active_run_classification: SelfUpgradeActiveRun[];
  /**
   * `continuous` when restart-safe runs were preserved across the restart;
   * `drain` when every active run completed or was explicitly interrupted.
   */
  drain_mode: "continuous" | "drain";
  /** Run ids preserved across the restart and re-adopted by the boot reconcile. */
  readopted_run_ids: string[];
  /**
   * Total monotonic drain-phase cost from phase entry through active-run
   * classification, preservation attestation, and any drain wait;
   * this is not only wait time. Restart, health verification, install pruning,
   * and receipt publication are later phases and are excluded. On a failure
   * receipt, 0 can also mean the drain phase was never entered; drain_mode does
   * not disambiguate that case.
   */
  drain_duration_ms: number;
  daemons_restarted: SelfUpgradeDaemonRestartReceipt[];
  explicit_target_adoption?: SelfUpgradeExplicitTargetAdoptionReceipt;
  install?: VersionedInstallReceipt;
  target_acceptance?: SelfUpgradeTargetAcceptanceReceipt;
  target_state_readiness?: SelfUpgradeTargetStateReadinessReceipt;
  target_state_migrated?: SelfUpgradeTargetStateMigratedReceipt;
  target_state_applied?: SelfUpgradeTargetStateAppliedReceipt;
  state_snapshot?: SelfUpgradeStateSnapshotReceipt;
  supervisor_readiness?: SelfUpgradeSupervisorReadinessReceipt;
  supervisor_install?: SelfUpgradeSupervisorInstallReceipt;
  rollback?: SelfUpgradeRollbackReceipt;
  maintenance_disposition?: SelfUpgradeMaintenanceDispositionContract;
  artifact_cleanup?: SelfUpgradeArtifactCleanupContract;
  warnings: string[];
  durability_issues?: SelfUpgradeReceiptDurabilityIssue[];
  error?: string;
}

export interface SelfUpgradeReceiptDurabilityIssue {
  scope: "final_receipt";
  code: "receipt_persist_failed";
  observed_at: string;
  message: string;
}

export function serializeSelfUpgradeReceipt(receipt: SelfUpgradeReceipt): string {
  const validated = validateOperationSuccessResponse(
    "admin.self-upgrade.receipt",
    200,
    receipt,
  ).value;
  return `${JSON.stringify(validated, null, 2)}\n`;
}

/** Typed non-authoritative evidence about terminal/relay observability loss. */
export interface SelfUpgradeProjectionIssue {
  scope: "status_stderr" | "remote_phase_stderr" | "operation_state" | "lock_cleanup";
  code: "projection_unavailable" | "cleanup_unavailable";
  observed_at: string;
  message: string;
}

export interface SelfUpgradeResult {
  status: "dry-run" | "succeeded";
  plan: SelfUpgradePlan;
  /**
   * Stable operation id for the upgrade (the receipt basename). Present once the
   * operation begins mutating; absent for `dry-run` (no operation is performed).
   * Shared by every `daemon.upgrade.*` event for this operation.
   */
  operation_id?: string;
  receipt_path?: string;
  receipt?: SelfUpgradeReceipt;
  projection_issues?: SelfUpgradeProjectionIssue[];
}

export interface SelfUpgradeCommandFailureOutput {
  status: "failed";
  error: string;
  exit_code: number;
  plan?: SelfUpgradePlan;
  receipt_path?: string;
  receipt?: SelfUpgradeReceipt;
  projection_issues?: SelfUpgradeProjectionIssue[];
}

export type SelfUpgradeCommandJsonOutput = SelfUpgradeResult | SelfUpgradeCommandFailureOutput;

export type SelfUpgradeExecutionError = Error & {
  exitCode: number;
  plan?: SelfUpgradePlan;
  receipt_path?: string;
  receipt?: SelfUpgradeReceipt;
  projection_issues?: SelfUpgradeProjectionIssue[];
};

export interface SelfUpgradeDependencies {
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  homeDir?: () => string;
  createAdminClient?: typeof createCalyxAdminClient;
  resolveAgentsInfraRoot?: () => Promise<string | undefined>;
  resolveCurrentHostAlias?: (host?: string, agentsInfraRoot?: string) => Promise<string>;
  resolveRepo?: (slug: string, host: string, agentsInfraRoot: string) => Promise<string>;
  readHostsTruth?: (agentsInfraRoot: string) => Promise<HostsTruthFile>;
  listDescriptors?: (options?: { root?: string }) => Promise<CalyxDaemonDescriptor[]>;
  readDescriptor?: (daemonId: string, options?: { root?: string }) => Promise<CalyxDaemonDescriptor | undefined>;
  writeDescriptor?: (
    descriptor: CalyxDaemonDescriptor,
    options?: {
      root?: string;
      expectedDescriptor?: CalyxDaemonDescriptor;
    },
  ) => Promise<string>;
  createRunService?: (options: { runsRoot: string }) => SelfUpgradeRunServiceLike;
  createSupervisorAdapter?: (descriptor: CalyxDaemonDescriptor) => CalyxDaemonSupervisorAdapter;
  /**
   * POL-2045: inspect one daemon's live supervisor definition and return the env
   * var NAMES it projects (names only, never values). Defaults to reading the
   * systemd user unit / launchd plist; tests inject a stub.
   */
  resolveSupervisorEnvNames?: (
    descriptor: Pick<CalyxDaemonDescriptor, "daemon_id" | "supervisor">,
    expectedHost: string,
  ) => Promise<SupervisorEnvInspection>;
  acquireLock?: typeof acquireSelfUpgradeLock;
  /**
   * Elapsed-time source for progress, drain, and health deadlines. Production
   * uses performance.now(); bounded poll budgets contain a faulty injected
   * source that stalls, regresses, returns a non-finite value, or throws.
   */
  monotonicNowMs?: () => number;
  /** Host event-log projection seam. Failures never decide mutation outcome. */
  appendEventProjection?: typeof appendControlEvent;
  /** Maximum time a host event projection may delay mutation progress. */
  eventProjectionSettleTimeoutMs?: number;
  /** Maximum time the read-only operation projection may delay mutation progress. */
  operationProjectionSettleTimeoutMs?: number;
  /** Test seam for the U4 operation-projection writer. */
  claimOperation?: typeof claimSelfUpgradeOperation;
  /** Maximum time lock release may delay terminal return; late release remains valid. */
  lockReleaseSettleTimeoutMs?: number;
  /** Test seam for the fail-open single-host stderr projection. */
  statusProjectionStream?: Writable;
  /**
    * POL-2046: live phase sink, invoked at each phase boundary alongside the
   * host event projection. Private fleet process context can relay those
   * phases as NDJSON while the fleet conductor's local fast path projects them
   * into its own terminal and event log. Neither sink is execution authority.
   */
  onPhase?: (event: SelfUpgradePhaseEvent) => void;
  /** Canonical receipt writer seam for crash/durability boundary tests. */
  writeReceipt?: typeof writeSelfUpgradeReceiptDurable;
  execGit?: (args: string[], cwd: string) => Promise<CommandResult>;
  runBuild?: (repoRoot: string, logPath: string) => Promise<CommandResult>;
  prepareInstall?: (options: VersionedInstallPrepareOptions) => Promise<VersionedInstallReceipt>;
  promoteInstall?: (
    receipt: VersionedInstallReceipt,
    options?: AtomicPromoteOptions,
  ) => Promise<VersionedInstallReceipt>;
  /**
   * Typed cross-repo seam for POL-2072. Calyx owns the transaction; the
   * implementation may consume the canonical agents-infra projection, but it
   * cannot delegate installation, restart, rollback, or receipt authority.
   */
  prepareSupervisorCutover?: (args: {
    plan: SelfUpgradePlan;
    preparedInstall: VersionedInstallReceipt;
    descriptors: CalyxDaemonDescriptor[];
    operationId: string;
    homeDir: string;
  }) => Promise<SelfUpgradeSupervisorCutover>;
  runSupervisorStage?: (args: {
    agentsInfraRoot: string;
    host: string;
    preparedInstall: VersionedInstallReceipt;
  }) => Promise<CommandResult>;
  runTargetStatePlan?: (preparedInstall: VersionedInstallReceipt) => Promise<CommandResult>;
  runTargetStateMigrate?: (preparedInstall: VersionedInstallReceipt) => Promise<CommandResult>;
  runTargetOwnedUpgrade?: (handoff: SelfUpgradeTargetHandoff) => Promise<SelfUpgradeResult>;
  recoverInterruptedCutover?: typeof recoverInterruptedCutover;
  removeTargetHandoff?: typeof removeTargetHandoff;
  reloadSupervisorDefinition?: (kind: "systemd" | "launchd") => Promise<
    "systemd-daemon-reload" | "launchd-on-restart"
  >;
  inspectSupervisorEffectiveState?: (
    descriptor: CalyxDaemonDescriptor,
  ) => Promise<SelfUpgradeSupervisorEffectiveStateReceipt>;
  prepareStateCutover?: (args: {
    operationId: string;
    homeDir: string;
    migrationGrowthBounds?: SelfUpgradeTargetStateReadinessReceipt["pending_migration_growth_bounds"];
  }) => Promise<SelfUpgradeStateCutover>;
  installBootstrap?: typeof installBootstrap;
}

type SelfUpgradeRunServiceLike = Pick<RunService, "getRunRecord" | "listRuns" | "reconcile" | "stop" | "assessRestartReadopt">;

function createSelfUpgradeError(
  message: string,
  exitCode = 1,
  context: Partial<Omit<SelfUpgradeExecutionError, "name" | "message" | "stack" | "cause" | "exitCode">> = {},
): SelfUpgradeExecutionError {
  const error = new Error(message) as SelfUpgradeExecutionError;
  error.exitCode = exitCode;
  if (context.plan) {
    error.plan = context.plan;
  }
  if (context.receipt_path) {
    error.receipt_path = context.receipt_path;
  }
  if (context.receipt) {
    error.receipt = context.receipt;
  }
  return error;
}

export function toSelfUpgradeFailureOutput(error: unknown): SelfUpgradeCommandFailureOutput {
  if (error instanceof Error) {
    const typed = error as SelfUpgradeExecutionError;
    return {
      status: "failed",
      error: error.message,
      exit_code: typed.exitCode ?? 1,
      ...(typed.plan ? { plan: typed.plan } : {}),
      ...(typed.receipt_path ? { receipt_path: typed.receipt_path } : {}),
      ...(typed.receipt ? { receipt: typed.receipt } : {}),
      ...(typed.projection_issues?.length ? { projection_issues: typed.projection_issues } : {}),
    };
  }
  return {
    status: "failed",
    error: String(error),
    exit_code: 1,
  };
}

function normalizeHostAlias(value: string): string {
  return value.trim().toLowerCase().replace(/\..*$/, "");
}

function formatTimestampForFilename(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function refNameToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return token.length > 0 ? token.slice(0, 64) : "head";
}

function backupRefForExplicitTargetAdoption(startedAt: string, head: string): string {
  return `${EXPLICIT_TARGET_BACKUP_REF_PREFIX}${formatTimestampForFilename(startedAt)}-${refNameToken(head.slice(0, 12))}-${randomUUID().slice(0, 8)}`;
}

function parsePullTarget(targetRef: string): { remote: string; ref: string } {
  const trimmed = targetRef.trim();
  if (!trimmed) {
    return { remote: "origin", ref: "main" };
  }
  const parts = trimmed.split("/");
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return {
      remote: parts[0]!,
      ref: parts.slice(1).join("/"),
    };
  }
  return {
    remote: "origin",
    ref: trimmed,
  };
}

function loopbackBaseUrl(baseUrl: string): string | undefined {
  const url = new URL(baseUrl);
  if (["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
    return undefined;
  }
  url.hostname = "127.0.0.1";
  return url.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandDetail(result: CommandResult): string {
  return result.stderr.trim() || result.stdout.trim();
}

async function readDirtyPaths(
  repoRoot: string,
  execGit: Required<SelfUpgradeDependencies>["execGit"],
): Promise<string[]> {
  const dirtyResult = await execGit(["status", "--porcelain"], repoRoot);
  if (dirtyResult.code !== 0) {
    throw createSelfUpgradeError(commandDetail(dirtyResult) || `git status --porcelain failed in ${repoRoot}.`, 6);
  }
  return dirtyResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function resolveGitRef(
  repoRoot: string,
  ref: string,
  execGit: Required<SelfUpgradeDependencies>["execGit"],
): Promise<string> {
  const result = await execGit(["rev-parse", ref], repoRoot);
  if (result.code !== 0) {
    throw createSelfUpgradeError(commandDetail(result) || `git rev-parse ${ref} failed in ${repoRoot}.`, 6);
  }
  return result.stdout.trim();
}

async function assertExplicitTargetWasFetched(args: {
  repoRoot: string;
  targetRef: string;
  explicitTargetSha: string;
  fetchHead: string;
  execGit: Required<SelfUpgradeDependencies>["execGit"];
}): Promise<void> {
  if (args.fetchHead === args.explicitTargetSha) {
    return;
  }
  const reachable = await args.execGit(["merge-base", "--is-ancestor", args.explicitTargetSha, args.fetchHead], args.repoRoot);
  if (reachable.code === 0) {
    return;
  }
  throw createSelfUpgradeError(
    `Fetched ${args.targetRef} at ${args.fetchHead}, but explicit target ${args.explicitTargetSha} is not reachable from the fetched ref; refusing to adopt a stale local object.`,
    6,
  );
}

function resetFailureMessage(args: {
  explicitTargetSha: string;
  mergeResult: CommandResult;
  resetResult: CommandResult;
}): string {
  const mergeDetail = commandDetail(args.mergeResult);
  const resetDetail = commandDetail(args.resetResult);
  if (mergeDetail && resetDetail) {
    return `git reset --hard ${args.explicitTargetSha} failed after git merge --ff-only could not adopt the explicit target SHA.\nff-only: ${mergeDetail}\nreset: ${resetDetail}`;
  }
  return resetDetail
    || mergeDetail
    || `git reset --hard ${args.explicitTargetSha} failed after git merge --ff-only could not adopt the explicit target SHA.`;
}

type ExplicitTargetBackupRef = {
  name: string;
  createdAtMs: number;
};

type ExplicitTargetBackupPruneReceipt = {
  pruned_refs: string[];
  pruned_superseded_refs: string[];
  pruned_expired_unmerged_refs: string[];
  warnings: string[];
};

function parseExplicitTargetBackupRef(name: string): ExplicitTargetBackupRef | undefined {
  if (!name.startsWith(EXPLICIT_TARGET_BACKUP_REF_PREFIX)) {
    return undefined;
  }
  const rest = name.slice(EXPLICIT_TARGET_BACKUP_REF_PREFIX.length);
  const timestampToken = rest.slice(0, 24);
  const match = timestampToken.match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/);
  if (!match) {
    return undefined;
  }
  const [, dateHour, minute, second, millisZone] = match;
  const createdAtMs = Date.parse(`${dateHour}:${minute}:${second}.${millisZone}`);
  if (!Number.isFinite(createdAtMs)) {
    return undefined;
  }
  return { name, createdAtMs };
}

function explicitTargetBackupPruneFields(
  prune: ExplicitTargetBackupPruneReceipt,
): Partial<SelfUpgradeExplicitTargetAdoptionReceipt> {
  return {
    ...(prune.pruned_refs.length > 0 ? { pruned_backup_refs: prune.pruned_refs } : {}),
    ...(prune.pruned_superseded_refs.length > 0 ? { pruned_superseded_backup_refs: prune.pruned_superseded_refs } : {}),
    ...(prune.pruned_expired_unmerged_refs.length > 0 ? { pruned_expired_unmerged_backup_refs: prune.pruned_expired_unmerged_refs } : {}),
    ...(prune.warnings.length > 0 ? { backup_prune_warnings: prune.warnings } : {}),
  };
}

function emptyExplicitTargetBackupPruneReceipt(warnings: string[] = []): ExplicitTargetBackupPruneReceipt {
  return {
    pruned_refs: [],
    pruned_superseded_refs: [],
    pruned_expired_unmerged_refs: [],
    warnings,
  };
}

async function pruneExplicitTargetBackupRefs(args: {
  repoRoot: string;
  now: string;
  execGit: Required<SelfUpgradeDependencies>["execGit"];
}): Promise<ExplicitTargetBackupPruneReceipt> {
  const nowMs = Date.parse(args.now);
  if (!Number.isFinite(nowMs)) {
    return emptyExplicitTargetBackupPruneReceipt([
      `Could not prune ${EXPLICIT_TARGET_BACKUP_REF_PREFIX} refs because ${args.now} is not a parseable timestamp.`,
    ]);
  }

  const listResult = await args.execGit(
    ["for-each-ref", "--format=%(refname:short)", `refs/heads/${EXPLICIT_TARGET_BACKUP_REF_PREFIX.replace(/\/$/, "")}`],
    args.repoRoot,
  );
  if (listResult.code !== 0) {
    return emptyExplicitTargetBackupPruneReceipt([
      `Could not inspect ${EXPLICIT_TARGET_BACKUP_REF_PREFIX} refs before explicit target adoption: ${commandDetail(listResult) || "git for-each-ref failed"}.`,
    ]);
  }

  const refs = listResult.stdout
    .split("\n")
    .map((line) => parseExplicitTargetBackupRef(line.trim()))
    .filter((ref): ref is ExplicitTargetBackupRef => Boolean(ref))
    .sort((left, right) => right.createdAtMs - left.createdAtMs);
  const supersededRefs: ExplicitTargetBackupRef[] = [];
  const unmergedRefs: ExplicitTargetBackupRef[] = [];
  const prunedRefs: string[] = [];
  const prunedSupersededRefs: string[] = [];
  const prunedExpiredUnmergedRefs: string[] = [];
  const warnings: string[] = [];

  for (const ref of refs) {
    const mergedResult = await args.execGit(["merge-base", "--is-ancestor", ref.name, "HEAD"], args.repoRoot);
    if (mergedResult.code === 0) {
      supersededRefs.push(ref);
    } else if (mergedResult.code === 1) {
      unmergedRefs.push(ref);
    } else {
      warnings.push(
        `Could not determine whether ${ref.name} is merged into HEAD before pruning; preserving it: ${commandDetail(mergedResult) || "git merge-base --is-ancestor failed"}.`,
      );
    }
  }

  const supersededPruneCandidates = supersededRefs.filter((ref, index) =>
    index >= EXPLICIT_TARGET_BACKUP_REF_KEEP
    || nowMs - ref.createdAtMs > EXPLICIT_TARGET_BACKUP_REF_MAX_AGE_MS);
  // Unmerged backups may be the only anchor for local commits displaced by a
  // hard-reset adoption, so count-based pruning applies only to superseded refs.
  const expiredUnmergedPruneCandidates = unmergedRefs.filter((ref) =>
    nowMs - ref.createdAtMs > EXPLICIT_TARGET_BACKUP_REF_MAX_AGE_MS);

  for (const ref of supersededPruneCandidates) {
    const deleteResult = await args.execGit(["branch", "-D", ref.name], args.repoRoot);
    if (deleteResult.code === 0) {
      prunedRefs.push(ref.name);
      prunedSupersededRefs.push(ref.name);
    } else {
      warnings.push(`Could not prune superseded backup ${ref.name}: ${commandDetail(deleteResult) || "git branch -D failed"}.`);
    }
  }
  for (const ref of expiredUnmergedPruneCandidates) {
    const deleteResult = await args.execGit(["branch", "-D", ref.name], args.repoRoot);
    if (deleteResult.code === 0) {
      prunedRefs.push(ref.name);
      prunedExpiredUnmergedRefs.push(ref.name);
    } else {
      warnings.push(`Could not prune expired unmerged backup ${ref.name}: ${commandDetail(deleteResult) || "git branch -D failed"}.`);
    }
  }
  return {
    pruned_refs: prunedRefs,
    pruned_superseded_refs: prunedSupersededRefs,
    pruned_expired_unmerged_refs: prunedExpiredUnmergedRefs,
    warnings,
  };
}

class GeneratedAdminReadError extends Error {
  override readonly name = "GeneratedAdminReadError";

  constructor(
    message: string,
    readonly responseReceived: boolean,
  ) {
    super(message);
  }
}

function generatedReadFailureMessage<T, Code extends string>(
  result: Exclude<CalyxResult<T, Code>, { ok: true }>,
): string {
  if (result.kind === "api") {
    return `HTTP ${result.status}: ${String(result.error.error.code)}: ${result.error.error.message}`;
  }
  if (result.kind === "transport") {
    return result.message;
  }
  if (result.kind === "protocol") {
    return result.status > 0 ? `HTTP ${result.status}: ${result.message}` : result.message;
  }
  return "generated read returned an impossible indeterminate result";
}

function requireGeneratedRead<T, Code extends string>(
  result: CalyxResult<T, Code>,
): T {
  if (result.ok) return result.data;
  throw new GeneratedAdminReadError(
    generatedReadFailureMessage(result),
    result.kind !== "transport",
  );
}

export function isFetchTransportError(error: unknown): boolean {
  if (error instanceof GeneratedAdminReadError) {
    return !error.responseReceived;
  }
  if (error instanceof TypeError) {
    return true;
  }
  return false;
}

function uniqueRunsRoots(daemons: Pick<SelfUpgradePlanDaemon, "runs_root">[]): string[] {
  return [...new Set(daemons.map((daemon) => daemon.runs_root))].sort();
}

function uniqueDaemonIds(daemons: Pick<SelfUpgradePlanDaemon, "daemon_id">[]): string[] {
  return [...new Set(daemons.map((daemon) => daemon.daemon_id))].sort();
}

function resolveTokenForHost(
  host: string,
  hostsTruth: HostsTruthFile,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveConsumerApiClientToken(host, hostsTruth.hosts?.[host], "operator_cli", env);
}

async function resolveSelfUpgradeAuthToken(
  host: string,
  explicitToken: string | undefined,
  deps: Required<Pick<SelfUpgradeDependencies, "resolveAgentsInfraRoot" | "readHostsTruth">>,
): Promise<string> {
  if (explicitToken?.trim()) {
    return explicitToken.trim();
  }
  const agentsInfraRoot = await deps.resolveAgentsInfraRoot();
  const hostsTruth = agentsInfraRoot ? await deps.readHostsTruth(agentsInfraRoot) : {};
  return resolveTokenForHost(host, hostsTruth) ?? "";
}

function defaultRunServeUrl(host: string, currentHost: string): string {
  return host === currentHost ? "http://127.0.0.1:8740" : `http://${host}:8740`;
}

function resolveRunServeUrl(host: string, currentHost: string, hostsTruth: HostsTruthFile): string {
  const configuredUrl = hostsTruth.hosts?.[host]?.run_serve_url?.trim();
  return configuredUrl && configuredUrl.length > 0 ? configuredUrl : defaultRunServeUrl(host, currentHost);
}

function categoryForRun(record: RunRecord): ActiveRunCategory {
  if (record.recovery.resumable) {
    return "blocking_resumable";
  }
  if (!record.health) {
    return "blocking_unknown";
  }
  if (record.health.status === "healthy") {
    return "drainable";
  }
  if (record.health.status === "stale") {
    return "blocking_unhealthy";
  }
  return "blocking_unknown";
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function defaultExecGit(args: string[], cwd: string): Promise<CommandResult> {
  try {
    const result = await execFile("git", args, {
      cwd,
      env: process.env,
    });
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const typed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof typed.code === "number" ? typed.code : 1,
      stdout: typed.stdout ?? "",
      stderr: typed.stderr ?? "",
    };
  }
}

async function appendBuildLog(logPath: string, chunk: string): Promise<void> {
  if (!chunk) {
    return;
  }
  await writeFile(logPath, chunk, {
    encoding: "utf8",
    flag: "a",
  });
}

async function runCommandStreaming(
  command: string,
  args: string[],
  cwd: string,
  logPath: string,
): Promise<CommandResult> {
  await mkdir(path.dirname(logPath), { recursive: true });
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawnChild(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      stdout += text;
      void appendBuildLog(logPath, text);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      stderr += text;
      void appendBuildLog(logPath, text);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

async function defaultRunBuild(repoRoot: string, logPath: string): Promise<CommandResult> {
  const install = await runCommandStreaming("pnpm", ["install", "--frozen-lockfile"], repoRoot, logPath);
  if (install.code !== 0) {
    return install;
  }
  return runCommandStreaming("pnpm", ["-w", "build"], repoRoot, logPath);
}

async function defaultRunCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  try {
    const result = await execFile(command, args, {
      cwd,
      env,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const typed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof typed.code === "number" ? typed.code : 1,
      stdout: typed.stdout ?? "",
      stderr: typed.stderr ?? "",
    };
  }
}

function formatCommandFailure(message: string, result: CommandResult): string {
  return [
    `${message} (exit ${result.code}).`,
    "stdout:",
    result.stdout.trimEnd() || "<empty>",
    "stderr:",
    result.stderr.trimEnd() || "<empty>",
  ].join("\n");
}

async function readPackageJson(packageDir: string): Promise<WorkspacePackageManifest> {
  return JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8")) as WorkspacePackageManifest;
}

type PnpmLockDependencyEntry = {
  version?: unknown;
};

type PnpmLockImporter = {
  dependencies?: Record<string, PnpmLockDependencyEntry>;
  optionalDependencies?: Record<string, PnpmLockDependencyEntry>;
};

type PnpmLockSnapshot = {
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
};

type PnpmLockfile = {
  importers?: Record<string, PnpmLockImporter>;
  snapshots?: Record<string, PnpmLockSnapshot>;
};

function normalizedLockfileImporterPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function isExternalLockReference(reference: string): boolean {
  return !/^(link|workspace|file|directory|portal):/.test(reference.trim());
}

function lockedVersionFromReference(reference: string): string | undefined {
  let normalized = reference.trim();
  if (!normalized || !isExternalLockReference(normalized)) {
    return undefined;
  }
  if (normalized.startsWith("npm:")) {
    normalized = normalized.slice("npm:".length);
    const atIndex = normalized.startsWith("@")
      ? normalized.indexOf("@", normalized.indexOf("/") + 1)
      : normalized.indexOf("@");
    normalized = atIndex >= 0 ? normalized.slice(atIndex + 1) : normalized;
  }
  const peerSuffixIndex = normalized.indexOf("(");
  return peerSuffixIndex >= 0 ? normalized.slice(0, peerSuffixIndex) : normalized;
}

function dependencyReference(entry: PnpmLockDependencyEntry | undefined): string | undefined {
  return typeof entry?.version === "string" ? entry.version : undefined;
}

function snapshotDependencyReference(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sortedRecord(entries: Iterable<readonly [string, string]>): Record<string, string> {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function workspaceRuntimeDependencies(manifest: WorkspacePackageManifest): string[] {
  return [...new Set(
    [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]
      .flatMap((dependencies) => Object.entries(dependencies ?? {}))
      .filter(([, reference]) => reference.trim().startsWith("workspace:"))
      .map(([name]) => name),
  )].sort();
}

export async function resolveVersionedInstallWorkspacePackages(args: {
  repoRoot: string;
  entryPackageName?: string;
}): Promise<VersionedInstallWorkspacePackage[]> {
  const repoRoot = path.resolve(args.repoRoot);
  const entryPackageName = args.entryPackageName ?? CALYX_CLI_PACKAGE_NAME;
  const lockfilePath = path.join(repoRoot, "pnpm-lock.yaml");
  const lockfile = YAML.parse(await readFile(lockfilePath, "utf8")) as PnpmLockfile;
  const packagesByName = new Map<string, VersionedInstallWorkspacePackage & {
    manifest: WorkspacePackageManifest;
  }>();

  for (const importerPath of Object.keys(lockfile.importers ?? {}).sort()) {
    const relativePath = normalizedLockfileImporterPath(importerPath);
    if (!relativePath || relativePath === ".") {
      continue;
    }
    const packageDir = path.resolve(repoRoot, relativePath);
    if (packageDir !== repoRoot && !packageDir.startsWith(`${repoRoot}${path.sep}`)) {
      throw new Error(`pnpm lockfile importer escapes the repository root: ${importerPath}.`);
    }
    const manifest = await readPackageJson(packageDir);
    if (!manifest.name) {
      continue;
    }
    if (packagesByName.has(manifest.name)) {
      throw new Error(`pnpm workspace contains duplicate package name ${manifest.name}.`);
    }
    packagesByName.set(manifest.name, {
      name: manifest.name,
      relativePath,
      manifest,
    });
  }

  if (!packagesByName.has(entryPackageName)) {
    throw new Error(`pnpm workspace does not contain versioned-install entry package ${entryPackageName}.`);
  }

  const resolved: VersionedInstallWorkspacePackage[] = [];
  const visited = new Set<string>();
  const visit = (packageName: string, parentName?: string): void => {
    if (visited.has(packageName)) {
      return;
    }
    const workspacePackage = packagesByName.get(packageName);
    if (!workspacePackage) {
      throw new Error(
        `Workspace runtime dependency ${packageName} required by ${parentName ?? entryPackageName} is missing from pnpm lockfile importers.`,
      );
    }
    visited.add(packageName);
    for (const dependencyName of workspaceRuntimeDependencies(workspacePackage.manifest)) {
      visit(dependencyName, packageName);
    }
    resolved.push({
      name: workspacePackage.name,
      relativePath: workspacePackage.relativePath,
    });
  };

  visit(entryPackageName);
  return resolved;
}

export async function buildVersionedInstallThirdPartyOverrides(args: {
  repoRoot: string;
  workspacePackages: readonly VersionedInstallWorkspacePackage[];
}): Promise<Record<string, string>> {
  const lockfilePath = path.join(args.repoRoot, "pnpm-lock.yaml");
  const lockfile = YAML.parse(await readFile(lockfilePath, "utf8")) as PnpmLockfile;
  const workspacePackageNames = new Set(args.workspacePackages.map((workspacePackage) => workspacePackage.name));
  const versionsByName = new Map<string, Set<string>>();
  const edges: Array<{ parentName: string; childName: string; version: string }> = [];
  const queue: Array<{ name: string; reference: string }> = [];
  const seen = new Set<string>();

  const enqueue = (name: string, reference: string | undefined, parentName?: string): void => {
    if (!reference || workspacePackageNames.has(name)) {
      return;
    }
    const version = lockedVersionFromReference(reference);
    if (!version) {
      return;
    }
    if (parentName) {
      edges.push({ parentName, childName: name, version });
    }
    const versions = versionsByName.get(name) ?? new Set<string>();
    versions.add(version);
    versionsByName.set(name, versions);
    queue.push({ name, reference });
  };

  for (const workspacePackage of args.workspacePackages) {
    const importerPath = normalizedLockfileImporterPath(workspacePackage.relativePath);
    const importer = lockfile.importers?.[importerPath];
    if (!importer) {
      throw new Error(`pnpm lockfile is missing importer ${importerPath}; cannot pin versioned install dependencies.`);
    }
    for (const dependencies of [importer.dependencies, importer.optionalDependencies]) {
      for (const [name, entry] of Object.entries(dependencies ?? {})) {
        enqueue(name, dependencyReference(entry), workspacePackage.name);
      }
    }
  }

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) {
      continue;
    }
    const snapshotKey = `${next.name}@${next.reference}`;
    if (seen.has(snapshotKey)) {
      continue;
    }
    seen.add(snapshotKey);
    const snapshot = lockfile.snapshots?.[snapshotKey];
    if (!snapshot) {
      throw new Error(`pnpm lockfile is missing snapshot ${snapshotKey}; cannot pin versioned install dependencies.`);
    }
    for (const dependencies of [snapshot.dependencies, snapshot.optionalDependencies]) {
      for (const [name, reference] of Object.entries(dependencies ?? {})) {
        enqueue(name, snapshotDependencyReference(reference), next.name);
      }
    }
  }

  const overrides = new Map<string, string>();
  for (const [name, versions] of [...versionsByName.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (versions.size === 1) {
      overrides.set(name, [...versions][0]!);
      continue;
    }

    const parentPins = new Map<string, string>();
    for (const edge of edges.filter((candidate) => candidate.childName === name)) {
      const previous = parentPins.get(edge.parentName);
      if (previous && previous !== edge.version) {
        throw new Error(
          `pnpm lockfile pins ${name} to multiple versions under parent ${edge.parentName}; cannot generate unambiguous overrides.`,
        );
      }
      parentPins.set(edge.parentName, edge.version);
    }
    const coveredVersions = new Set(parentPins.values());
    const uncovered = [...versions].filter((version) => !coveredVersions.has(version));
    if (uncovered.length > 0) {
      throw new Error(`pnpm lockfile pins ${name} to multiple versions (${[...versions].join(", ")}) without parent edges for ${uncovered.join(", ")}.`);
    }
    for (const [parentName, version] of [...parentPins.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      overrides.set(`${parentName}>${name}`, version);
    }
  }

  return sortedRecord(overrides);
}

async function packWorkspacePackage(args: {
  repoRoot: string;
  packageName: string;
  tarballsDir: string;
  env: NodeJS.ProcessEnv;
  runCommand: NonNullable<VersionedInstallPrepareOptions["runCommand"]>;
}): Promise<string> {
  const before = new Set((await readdir(args.tarballsDir).catch(() => [])).filter((entry) => entry.endsWith(".tgz")));
  const result = await args.runCommand(
    "pnpm",
    ["--filter", args.packageName, "pack", "--pack-destination", args.tarballsDir],
    args.repoRoot,
    args.env,
  );
  if (result.code !== 0) {
    throw new Error(
      `pnpm pack failed for ${args.packageName}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
    );
  }
  const after = (await readdir(args.tarballsDir)).filter((entry) => entry.endsWith(".tgz"));
  const created = after.filter((entry) => !before.has(entry)).sort();
  if (created.length !== 1) {
    throw new Error(`Expected pnpm pack for ${args.packageName} to create one tarball, got ${created.length}: ${created.join(", ")}`);
  }
  return created[0]!;
}

async function readInstallBuildInfo(installPath: string): Promise<CalyxBuildInfo> {
  try {
    return await readCalyxBuildInfo(resolveCalyxInstallBuildInfoPath(installPath));
  } catch (error) {
    const typed = error as NodeJS.ErrnoException;
    if (typed.code !== "ENOENT") {
      throw error;
    }
    return readCalyxBuildInfo(resolveCalyxInstallPackageBuildInfoPath(installPath));
  }
}

async function verifyInstallExecutable(installPath: string): Promise<{ binPath: string; version: string }> {
  const binPath = resolveCalyxInstallBinPath(installPath);
  const result = await execFile(process.execPath, [binPath, "--version"], {
    cwd: path.parse(installPath).root,
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  const version = result.stdout.trim();
  if (!version) {
    throw new Error(`Installed Calyx executable at ${binPath} did not print a version.`);
  }
  return { binPath, version };
}

function containsCloneReference(text: string, repoRoot: string): boolean {
  return text.includes(repoRoot) || text.includes(path.resolve(repoRoot));
}

async function assertNoCloneReferences(installPath: string, repoRoot: string): Promise<void> {
  const queue = [installPath];
  const textFiles = new Set(["package.json", "pnpm-lock.yaml", ".modules.yaml"]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      const target = await readlink(current);
      if (containsCloneReference(target, repoRoot)) {
        throw new Error(`Versioned install symlink references clone path: ${current} -> ${target}`);
      }
      continue;
    }
    if (stats.isDirectory()) {
      const entries = await readdir(current);
      for (const entry of entries) {
        queue.push(path.join(current, entry));
      }
      continue;
    }
    if (!stats.isFile() || !textFiles.has(path.basename(current))) {
      continue;
    }
    const text = await readFile(current, "utf8");
    if (containsCloneReference(text, repoRoot)) {
      throw new Error(`Versioned install metadata references clone path: ${current}`);
    }
  }
}

interface CurrentInstallLinkSnapshot {
  path: string;
  link_target: string;
  target_real_path: string;
  device: number;
  inode: number;
  parent_identity: SelfUpgradeFilesystemIdentity;
}

export interface AtomicPromoteOptions {
  operationId?: string;
  expectedCurrentInstallPaths?: readonly string[];
  allowCurrentAbsent?: boolean;
}

async function readCurrentInstallLinkSnapshot(
  currentLink: string,
): Promise<CurrentInstallLinkSnapshot | undefined> {
  const parentIdentity = await captureFilesystemIdentity(
    path.dirname(currentLink),
    "directory",
  );
  let before;
  try {
    before = await lstat(currentLink);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await assertFilesystemIdentityCurrent(parentIdentity, "Current-link parent");
      return undefined;
    }
    throw error;
  }
  if (!before.isSymbolicLink()) {
    throw new Error(`Current install authority is not a symbolic link: ${currentLink}`);
  }
  const linkTarget = await readlink(currentLink);
  const targetRealPath = await realpath(currentLink);
  const after = await lstat(currentLink);
  if (
    !after.isSymbolicLink()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || linkTarget !== await readlink(currentLink)
  ) {
    throw new Error("Current install link changed while its point-of-use identity was captured.");
  }
  await assertFilesystemIdentityCurrent(parentIdentity, "Current-link parent");
  return {
    path: path.resolve(currentLink),
    link_target: linkTarget,
    target_real_path: targetRealPath,
    device: after.dev,
    inode: after.ino,
    parent_identity: parentIdentity,
  };
}

function sameCurrentInstallLink(
  left: CurrentInstallLinkSnapshot,
  right: CurrentInstallLinkSnapshot,
): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.link_target === right.link_target
    && left.target_real_path === right.target_real_path
    && sameFilesystemIdentity(left.parent_identity, right.parent_identity);
}

async function syncDirectoryIdentity(identity: SelfUpgradeFilesystemIdentity): Promise<void> {
  await assertFilesystemIdentityCurrent(identity, "Filesystem authority parent");
  const handle = await open(
    identity.real_path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function acquireCurrentLinkWriteLock(
  installsRootIdentity: SelfUpgradeFilesystemIdentity,
): Promise<() => Promise<void>> {
  const lockPath = path.join(installsRootIdentity.real_path, ".current.write-lock");
  const lock = await acquireCooperativeFileLock({
    lockPath,
    timeoutMessage: `Timed out acquiring current-link write lock: ${lockPath}`,
  });
  return async () => {
    await lock.release();
  };
}

async function atomicallyPromoteInstall(
  installsRoot: string,
  installPath: string,
  options: AtomicPromoteOptions = {},
): Promise<string> {
  const installsRootIdentity = await captureFilesystemIdentity(installsRoot, "directory");
  const installIdentity = await captureFilesystemIdentity(installPath, "directory");
  const relativeInstall = path.relative(installsRootIdentity.real_path, installIdentity.real_path);
  if (!relativeInstall || relativeInstall.startsWith("..") || path.isAbsolute(relativeInstall)) {
    throw new Error(`Atomic promote target is outside the canonical installs root: ${installPath}`);
  }
  const currentLink = resolveCurrentCalyxInstallLink(installsRoot);
  const operationSegment = (options.operationId ?? `${process.pid}-${Date.now()}`)
    .replace(/[^A-Za-z0-9_.-]/gu, "_");
  const predecessorLink = path.join(
    installsRoot,
    `.current-${operationSegment}.predecessor`,
  );
  const expectedTargets = await Promise.all(
    (options.expectedCurrentInstallPaths ?? []).map((candidate) => realpath(candidate)),
  );
  const releaseWriteLock = await acquireCurrentLinkWriteLock(installsRootIdentity);
  const installsRootHandle = await open(
    installsRootIdentity.real_path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  const installHandle = await open(
    installIdentity.real_path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  let predecessor: CurrentInstallLinkSnapshot | undefined;
  let publicationDurable = false;
  try {
    await assertOpenDirectoryCurrent(
      installsRootHandle,
      installsRootIdentity,
      "Install root before current-link publication",
    );
    await assertOpenDirectoryCurrent(
      installHandle,
      installIdentity,
      "Prepared install before current-link publication",
    );
    let current = await readCurrentInstallLinkSnapshot(currentLink);
    predecessor = await readCurrentInstallLinkSnapshot(predecessorLink);
    if (current?.target_real_path === installIdentity.real_path) {
      await syncDirectoryIdentity(installsRootIdentity);
      publicationDurable = true;
      if (predecessor) {
        if (
          expectedTargets.length > 0
          && !expectedTargets.includes(predecessor.target_real_path)
        ) {
          throw new Error(
            `Atomic promotion retained a foreign predecessor: ${predecessor.target_real_path}.`,
          );
        }
        await rm(predecessorLink, { force: true }).catch(() => undefined);
        await syncDirectoryIdentity(installsRootIdentity).catch(() => undefined);
      }
      return currentLink;
    }
    if (
      current
      && expectedTargets.length > 0
      && !expectedTargets.includes(current.target_real_path)
    ) {
      throw new Error(
        `Current install changed before atomic promotion: ${current.target_real_path} is not an accepted predecessor.`,
      );
    }
    if (
      !current
      && !predecessor
      && !options.allowCurrentAbsent
    ) {
      throw new Error("Current install disappeared before atomic promotion.");
    }
    if (predecessor) {
      if (
        expectedTargets.length > 0
        && !expectedTargets.includes(predecessor.target_real_path)
      ) {
        throw new Error(
          `Atomic promotion predecessor changed: ${predecessor.target_real_path} is not accepted.`,
        );
      }
      if (current) {
        throw new Error(
          "Atomic promotion found both a non-target current link and a retained predecessor; operator reconciliation is required.",
        );
      }
    } else if (current) {
      // The shared write lock serializes every Calyx publisher. Retaining the
      // exact predecessor makes failures before the publication fsync
      // recoverable without ever accepting a third generation.
      const pointOfUseCurrent = await readCurrentInstallLinkSnapshot(currentLink);
      if (!pointOfUseCurrent || !sameCurrentInstallLink(pointOfUseCurrent, current)) {
        throw new Error("Current install changed at the point-of-use promotion fence.");
      }
      await rename(currentLink, predecessorLink);
      predecessor = await readCurrentInstallLinkSnapshot(predecessorLink);
      if (!predecessor || !sameCurrentInstallLink(predecessor, {
        ...current,
        path: path.resolve(predecessorLink),
      })) {
        throw new Error("Current install predecessor changed during point-of-use fencing.");
      }
      current = undefined;
      await syncDirectoryIdentity(installsRootIdentity);
    }
    await assertOpenDirectoryCurrent(
      installsRootHandle,
      installsRootIdentity,
      "Install root at current-link publication",
    );
    await assertOpenDirectoryCurrent(
      installHandle,
      installIdentity,
      "Prepared install at current-link publication",
    );
    // `symlink` is create-if-absent. A concurrent publisher therefore wins
    // with EEXIST instead of being overwritten by rename(2).
    await symlink(path.basename(installPath), currentLink, "dir");
    const published = await readCurrentInstallLinkSnapshot(currentLink);
    if (!published || published.target_real_path !== installIdentity.real_path) {
      throw new Error("Atomic promotion did not publish the exact prepared install.");
    }
    await syncDirectoryIdentity(installsRootIdentity);
    publicationDurable = true;
    if (predecessor) {
      const retained = await readCurrentInstallLinkSnapshot(predecessorLink);
      if (!retained || !sameCurrentInstallLink(retained, predecessor)) {
        // The target publication is already durable. Predecessor retirement is
        // cleanup only and a later idempotent call may reconcile it.
        return currentLink;
      }
      await rm(predecessorLink, { force: true }).catch(() => undefined);
      await syncDirectoryIdentity(installsRootIdentity).catch(() => undefined);
    }
    await assertOpenDirectoryCurrent(
      installsRootHandle,
      installsRootIdentity,
      "Install root after current-link publication",
    );
  } catch (error) {
    if (predecessor && !publicationDurable) {
      const observedCurrent = await readCurrentInstallLinkSnapshot(currentLink).catch(() => undefined);
      const observedPredecessor = await readCurrentInstallLinkSnapshot(predecessorLink).catch(() => undefined);
      if (observedPredecessor && sameCurrentInstallLink(observedPredecessor, predecessor)) {
        if (!observedCurrent) {
          await rename(predecessorLink, currentLink).catch(() => undefined);
          await syncDirectoryIdentity(installsRootIdentity).catch(() => undefined);
        } else if (observedCurrent.target_real_path === installIdentity.real_path) {
          // This is our not-yet-durable target publication under the shared
          // cooperative-writer lock, so restoring the exact predecessor does
          // not overwrite a sibling generation.
          await rename(predecessorLink, currentLink).catch(() => undefined);
          await syncDirectoryIdentity(installsRootIdentity).catch(() => undefined);
        } else {
          // A non-cooperating third publisher won. Retain the predecessor as
          // explicit reconciliation evidence; never overwrite the third link.
        }
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Atomic promote failed for ${currentLink}: ${message}`);
  } finally {
    await installHandle.close().catch(() => undefined);
    await installsRootHandle.close().catch(() => undefined);
    await releaseWriteLock().catch(() => undefined);
  }
  return currentLink;
}

async function canonicalPath(candidate: string): Promise<string> {
  return realpath(candidate).catch(() => path.resolve(candidate));
}

async function canonicalInstallPathForCandidate(installsRootRealPath: string, candidate: string): Promise<string | undefined> {
  if (!path.isAbsolute(candidate)) {
    return undefined;
  }
  const normalizedRoot = path.resolve(installsRootRealPath);
  const normalizedCandidate = await canonicalPath(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  const [installName] = relative.split(path.sep);
  if (!installName || installName === "current" || installName.startsWith(".")) {
    return undefined;
  }
  return path.join(normalizedRoot, installName);
}

async function protectInstallPath(
  protectedInstalls: Set<string>,
  installsRootRealPath: string,
  candidate: string | undefined,
): Promise<void> {
  if (!candidate) {
    return;
  }
  const direct = await canonicalInstallPathForCandidate(installsRootRealPath, candidate);
  if (direct) {
    protectedInstalls.add(direct);
  }
}

function parseWrapperSourceExecutable(wrapperText: string): string | undefined {
  const line = wrapperText.split(/\r?\n/).find((candidate) => candidate.startsWith("SOURCE_EXECUTABLE_PATH="));
  if (!line) {
    return undefined;
  }
  const raw = line.slice("SOURCE_EXECUTABLE_PATH=".length);
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/'"'"'/g, "'");
  }
  return raw.trim() || undefined;
}

async function protectedVersionedInstalls(args: {
  installsRoot: string;
  descriptors: readonly Pick<CalyxDaemonDescriptor, "argv">[];
  wrapperPath?: string;
}): Promise<Set<string>> {
  const protectedInstalls = new Set<string>();
  const installsRootRealPath = await canonicalPath(args.installsRoot);
  const currentInstall = await realpath(resolveCurrentCalyxInstallLink(args.installsRoot)).catch(() => undefined);
  await protectInstallPath(protectedInstalls, installsRootRealPath, currentInstall);

  for (const descriptor of args.descriptors) {
    for (const argvPart of descriptor.argv) {
      await protectInstallPath(protectedInstalls, installsRootRealPath, argvPart);
    }
  }

  if (args.wrapperPath) {
    const wrapper = await readFile(args.wrapperPath, "utf8").catch(() => undefined);
    await protectInstallPath(protectedInstalls, installsRootRealPath, wrapper ? parseWrapperSourceExecutable(wrapper) : undefined);
  }

  return protectedInstalls;
}

async function sweepStaleInstallResidue(args: {
  installsRoot: string;
  nowMs: number;
  staleResidueAgeMs: number;
}): Promise<string[]> {
  const entries = await readdir(args.installsRoot, { withFileTypes: true }).catch(() => []);
  const swept: string[] = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(".staging-") && !entry.name.startsWith(".current-")) {
      continue;
    }
    const candidate = path.join(args.installsRoot, entry.name);
    const stats = await lstat(candidate).catch(() => undefined);
    if (!stats || args.nowMs - stats.mtimeMs < args.staleResidueAgeMs) {
      continue;
    }
    await rm(candidate, { recursive: true, force: true });
    swept.push(candidate);
  }
  return swept.sort();
}

export async function pruneVersionedInstalls(options: VersionedInstallPruneOptions = {}): Promise<VersionedInstallPruneReceipt> {
  const installsRoot = path.resolve(options.installsRoot ?? resolveCalyxInstallsRoot());
  const installsRootRealPath = await canonicalPath(installsRoot);
  const keep = Math.max(1, options.keep ?? 3);
  const nowMs = options.nowMs ?? Date.now();
  const staleResidueAgeMs = options.staleResidueAgeMs ?? STALE_INSTALL_RESIDUE_AGE_MS;
  const sweptStaleTemps = await sweepStaleInstallResidue({ installsRoot, nowMs, staleResidueAgeMs });
  const protectedInstalls = await protectedVersionedInstalls({
    installsRoot,
    descriptors: options.descriptors ?? [],
    ...(options.wrapperPath ? { wrapperPath: options.wrapperPath } : {}),
  });
  const entries = await readdir(installsRoot, { withFileTypes: true }).catch(() => []);
  const installDirs: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const candidate = path.join(installsRoot, entry.name);
    const candidateIdentity = await canonicalInstallPathForCandidate(installsRootRealPath, candidate);
    if (candidateIdentity && protectedInstalls.has(candidateIdentity)) {
      continue;
    }
    const stats = await stat(candidate).catch(() => undefined);
    if (!stats) {
      continue;
    }
    installDirs.push({ path: candidate, mtimeMs: stats.mtimeMs });
  }

  installDirs.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
  const retainedNonProtected = Math.max(keep - 1, 0);
  const pruned = installDirs.slice(retainedNonProtected).map((entry) => entry.path);
  for (const installPath of pruned) {
    await rm(installPath, { recursive: true, force: true });
  }
  return {
    pruned,
    swept_stale_temps: sweptStaleTemps,
  };
}

function rollbackCommandFor(installsRoot: string): string {
  return `ln -sfn <previous-install-dirname> ${resolveCurrentCalyxInstallLink(installsRoot)}`;
}

async function computeCalyxOwnedArtifactManifest(
  installPath: string,
  workspacePackages: readonly VersionedInstallWorkspacePackage[],
): Promise<string> {
  const unresolved = new Map(
    workspacePackages.map((workspacePackage) => [workspacePackage.name, workspacePackage]),
  );
  const packageRoots = new Map<string, string>();
  while (unresolved.size > 0) {
    let resolvedThisPass = 0;
    for (const [packageName] of [...unresolved].sort(([left], [right]) => left.localeCompare(right))) {
      const packageSegments = packageName.split("/");
      const candidates = [
        path.join(installPath, "node_modules", ...packageSegments),
        ...[...packageRoots.entries()].flatMap(([resolvedName, packageRoot]) => {
          const resolvedSegments = resolvedName.split("/");
          return [
            path.join(packageRoot, "node_modules", ...packageSegments),
            path.resolve(packageRoot, ...resolvedSegments.map(() => ".."), ...packageSegments),
          ];
        }),
      ];
      for (const candidate of candidates) {
        const packageRoot = await realpath(candidate).catch(() => undefined);
        if (!packageRoot) {
          continue;
        }
        const packageJson = await readPackageJson(packageRoot);
        if (packageJson.name !== packageName) {
          throw new Error(
            `Installed Calyx-owned package ${candidate} declares name ${packageJson.name ?? "<missing>"}, expected ${packageName}.`,
          );
        }
        packageRoots.set(packageName, packageRoot);
        unresolved.delete(packageName);
        resolvedThisPass += 1;
        break;
      }
    }
    if (resolvedThisPass === 0) {
      throw new Error(
        `Cannot resolve installed Calyx-owned package(s): ${[...unresolved.keys()].sort().join(", ")}.`,
      );
    }
  }

  const manifest = createHash("sha256");
  for (const workspacePackage of [...workspacePackages].sort((left, right) => left.name.localeCompare(right.name))) {
    const packageRoot = packageRoots.get(workspacePackage.name);
    if (!packageRoot) {
      throw new Error(`Missing resolved Calyx-owned package root for ${workspacePackage.name}.`);
    }
    const visit = async (directory: string, relativeRoot: string): Promise<void> => {
      const entries = (await readdir(directory, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        const relative = path.posix.join(relativeRoot, entry.name);
        if (entry.isDirectory()) {
          await visit(absolute, relative);
          continue;
        }
        if (entry.isSymbolicLink()) {
          manifest.update(`link\0${relative}\0${await readlink(absolute)}\0`);
          continue;
        }
        if (!entry.isFile()) {
          throw new Error(`Unsupported Calyx-owned package artifact: ${absolute}`);
        }
        const metadata = await stat(absolute);
        manifest.update(`file\0${relative}\0${metadata.size}\0${await sha256RegularFileNoFollow(absolute)}\0`);
      }
    };
    await visit(packageRoot, workspacePackage.name);
  }
  return manifest.digest("hex");
}

export async function prepareVersionedInstall(
  options: VersionedInstallPrepareOptions,
): Promise<VersionedInstallReceipt> {
  const repoRoot = path.resolve(options.repoRoot);
  const installsRoot = path.resolve(options.installsRoot ?? resolveCalyxInstallsRoot());
  const gitHead = options.gitHead.trim();
  if (!/^[0-9a-f]{40}$/i.test(gitHead)) {
    throw new Error(`Cannot materialize versioned install for non-SHA git head: ${gitHead || "<empty>"}.`);
  }
  const entryPackageName = options.entryPackageName ?? CALYX_CLI_PACKAGE_NAME;
  const workspacePackages = options.workspacePackages
    ?? await resolveVersionedInstallWorkspacePackages({ repoRoot, entryPackageName });
  const runCommand = options.runCommand ?? defaultRunCommand;
  const env = options.env ?? process.env;
  const finalInstallPath = path.join(installsRoot, gitHead);
  await mkdir(installsRoot, { recursive: true });
  const previousCurrentInstallPath = await readCurrentInstallTarget(installsRoot);

  if (await pathExists(finalInstallPath)) {
    const existingBuild = await readInstallBuildInfo(finalInstallPath);
    if (existingBuild.git_head !== gitHead) {
      throw new Error(`Existing install ${finalInstallPath} has git_head ${existingBuild.git_head}, expected ${gitHead}.`);
    }
    const verified = await verifyInstallExecutable(finalInstallPath);
    await assertNoCloneReferences(finalInstallPath, repoRoot);
    const artifactManifestSha256 = await computeCalyxOwnedArtifactManifest(
      finalInstallPath,
      workspacePackages,
    );
    return {
      install_path: finalInstallPath,
      current_link: resolveCurrentCalyxInstallLink(installsRoot),
      previous_current_install_path: previousCurrentInstallPath ?? null,
      build_info_path: resolveCalyxInstallBuildInfoPath(finalInstallPath),
      bin_path: verified.binPath,
      git_head: gitHead,
      verified_version: verified.version,
      artifact_manifest_sha256: artifactManifestSha256,
      artifact_manifest_packages: workspacePackages.map((entry) => entry.name).sort(),
      pruned: [],
      materialized: false,
      promoted: false,
      mechanism: "pack-install",
      rollback_command: rollbackCommandFor(installsRoot),
    };
  }

  const stagingPath = path.join(installsRoot, `.staging-${gitHead}-${process.pid}-${Date.now()}`);
  await rm(stagingPath, { recursive: true, force: true });
  await mkdir(path.join(stagingPath, "tarballs"), { recursive: true });
  try {
    const tarballsByPackage = new Map<string, string>();
    for (const workspacePackage of workspacePackages) {
      const packageDir = path.join(repoRoot, workspacePackage.relativePath);
      const packageJson = await readPackageJson(packageDir);
      if (packageJson.name !== workspacePackage.name) {
        throw new Error(`Package ${workspacePackage.relativePath} declares name ${packageJson.name ?? "<missing>"}, expected ${workspacePackage.name}.`);
      }
      const tarball = await packWorkspacePackage({
        repoRoot,
        packageName: workspacePackage.name,
        tarballsDir: path.join(stagingPath, "tarballs"),
        env,
        runCommand,
      });
      tarballsByPackage.set(workspacePackage.name, tarball);
    }

    const entryTarball = tarballsByPackage.get(entryPackageName);
    if (!entryTarball) {
      throw new Error(`Entry package ${entryPackageName} was not packed.`);
    }
    const overrides: Record<string, string> = {
      ...await buildVersionedInstallThirdPartyOverrides({ repoRoot, workspacePackages }),
    };
    for (const [packageName, tarball] of tarballsByPackage) {
      overrides[packageName] = `file:./tarballs/${tarball}`;
    }
    const generatedPackageJson = {
      private: true,
      name: "calyx-versioned-install",
      version: "0.0.0",
      type: "module",
      dependencies: {
        [entryPackageName]: `file:./tarballs/${entryTarball}`,
      },
    };
    const generatedWorkspaceConfig = {
      packages: [],
      overrides: sortedRecord(Object.entries(overrides)),
    };
    await writeFile(path.join(stagingPath, "package.json"), `${JSON.stringify(generatedPackageJson, null, 2)}\n`, "utf8");
    await writeFile(path.join(stagingPath, "pnpm-workspace.yaml"), YAML.stringify(generatedWorkspaceConfig), "utf8");
    await writeFile(path.join(stagingPath, ".npmrc"), `minimum-release-age=${STAGING_MINIMUM_RELEASE_AGE_MINUTES}\n`, "utf8");

    const installResult = await runCommand(
      "pnpm",
      ["install", "--prod", "--ignore-scripts", "--prefer-offline"],
      stagingPath,
      env,
    );
    if (installResult.code !== 0) {
      throw new Error(
        formatCommandFailure("pnpm install failed for versioned install", installResult),
      );
    }

    const repoBuildInfoPath = path.join(repoRoot, "packages", "cli", "dist", CALYX_INSTALL_BUILD_INFO_FILENAME);
    const repoBuildInfo = await readCalyxBuildInfo(repoBuildInfoPath);
    if (repoBuildInfo.git_head !== gitHead) {
      throw new Error(`CLI build metadata git_head ${repoBuildInfo.git_head} does not match target ${gitHead}.`);
    }
    const packageBuildInfo = await readCalyxBuildInfo(resolveCalyxInstallPackageBuildInfoPath(stagingPath));
    if (packageBuildInfo.git_head !== gitHead) {
      throw new Error(`Installed CLI build metadata git_head ${packageBuildInfo.git_head} does not match target ${gitHead}.`);
    }
    await copyFile(repoBuildInfoPath, resolveCalyxInstallBuildInfoPath(stagingPath));
    const verified = await verifyInstallExecutable(stagingPath);
    await assertNoCloneReferences(stagingPath, repoRoot);
    const artifactManifestSha256 = await computeCalyxOwnedArtifactManifest(
      stagingPath,
      workspacePackages,
    );
    await rename(stagingPath, finalInstallPath);
    return {
      install_path: finalInstallPath,
      current_link: resolveCurrentCalyxInstallLink(installsRoot),
      previous_current_install_path: previousCurrentInstallPath ?? null,
      build_info_path: resolveCalyxInstallBuildInfoPath(finalInstallPath),
      bin_path: resolveCalyxInstallBinPath(finalInstallPath),
      git_head: gitHead,
      verified_version: verified.version,
      artifact_manifest_sha256: artifactManifestSha256,
      artifact_manifest_packages: workspacePackages.map((entry) => entry.name).sort(),
      pruned: [],
      materialized: true,
      promoted: false,
      mechanism: "pack-install",
      rollback_command: rollbackCommandFor(installsRoot),
    };
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function promoteVersionedInstall(
  receipt: VersionedInstallReceipt,
  options: AtomicPromoteOptions = {},
): Promise<VersionedInstallReceipt> {
  if (receipt.promoted) {
    throw new Error(`Versioned install ${receipt.install_path} is already promoted.`);
  }
  const installsRoot = path.dirname(receipt.current_link);
  const expectedInstallPath = path.join(installsRoot, receipt.git_head);
  if (path.resolve(receipt.install_path) !== path.resolve(expectedInstallPath)) {
    throw new Error(
      `Prepared install path ${receipt.install_path} is not bound to target ${receipt.git_head} under ${installsRoot}.`,
    );
  }
  const build = await readInstallBuildInfo(receipt.install_path);
  if (build.git_head !== receipt.git_head) {
    throw new Error(
      `Prepared install ${receipt.install_path} has git_head ${build.git_head}, expected ${receipt.git_head}.`,
    );
  }
  const verified = await verifyInstallExecutable(receipt.install_path);
  if (verified.binPath !== receipt.bin_path || verified.version !== receipt.verified_version) {
    throw new Error(`Prepared install ${receipt.install_path} changed after verification.`);
  }
  if (receipt.artifact_manifest_sha256) {
    const packages = receipt.artifact_manifest_packages;
    if (!packages || packages.length === 0) {
      throw new Error(`Prepared install ${receipt.install_path} lacks artifact manifest package identity.`);
    }
    const observedManifest = await computeCalyxOwnedArtifactManifest(
      receipt.install_path,
      packages.map((name) => ({ name, relativePath: "" })),
    );
    if (observedManifest !== receipt.artifact_manifest_sha256) {
      throw new Error(`Prepared install ${receipt.install_path} Calyx-owned artifact manifest changed.`);
    }
  }
  const receiptExpected = receipt.previous_current_install_path;
  const currentLink = await atomicallyPromoteInstall(
    installsRoot,
    receipt.install_path,
    {
      ...options,
      expectedCurrentInstallPaths: options.expectedCurrentInstallPaths
        ?? (typeof receiptExpected === "string" ? [receiptExpected] : []),
      allowCurrentAbsent: options.allowCurrentAbsent
        ?? receiptExpected === null,
    },
  );
  return {
    ...receipt,
    current_link: currentLink,
    promoted: true,
  };
}

async function tailLog(logPath: string, lines = BUILD_LOG_TAIL_LINES): Promise<string> {
  const text = await readFile(logPath, "utf8").catch(() => "");
  if (!text.trim()) {
    return "";
  }
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

async function fetchDaemonHealthFromBaseUrl(
  baseUrl: string,
  authToken: string,
  createAdminClient: typeof createCalyxAdminClient,
  signal?: AbortSignal,
): Promise<CalyxDaemonHealth> {
  const client = createAdminClient({
    baseUrl,
    bearerToken: authToken,
    // The caller owns descriptor-host to loopback fallback and its verification budget.
    retry: { maxAttempts: 1 },
  });
  return requireGeneratedRead(await client.admin.health(signal ? { signal } : undefined)) as CalyxDaemonHealth;
}

async function fetchDaemonHealth(
  descriptor: Pick<SelfUpgradePlanDaemon, "health_url">,
  authToken: string,
  createAdminClient: typeof createCalyxAdminClient,
  signal?: AbortSignal,
): Promise<CalyxDaemonHealth> {
  const primaryBaseUrl = descriptor.health_url;
  try {
    return await fetchDaemonHealthFromBaseUrl(primaryBaseUrl, authToken, createAdminClient, signal);
  } catch (error) {
    const fallbackBaseUrl = loopbackBaseUrl(primaryBaseUrl);
    if (!fallbackBaseUrl || !isFetchTransportError(error)) {
      throw error;
    }
    try {
      return await fetchDaemonHealthFromBaseUrl(fallbackBaseUrl, authToken, createAdminClient, signal);
    } catch (fallbackError) {
      throw new Error(`${errorMessage(error)}; loopback fallback ${fallbackBaseUrl} failed: ${errorMessage(fallbackError)}`);
    }
  }
}

async function fetchAdminRunsFromBaseUrl(
  baseUrl: string,
  authToken: string,
  createAdminClient: typeof createCalyxAdminClient,
  signal?: AbortSignal,
): Promise<RunListEntry[]> {
  const client = createAdminClient({
    baseUrl,
    bearerToken: authToken,
    // Pagination and host fallback remain explicit self-upgrade control flow.
    retry: { maxAttempts: 1 },
  });
  const rows: RunListEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = requireGeneratedRead(await client.admin.run.list({
      query: {
        limit: String(CALYX_ADMIN_RUN_LIST_MAX_ITEMS),
        ...(cursor ? { cursor } : {}),
      },
      ...(signal ? { signal } : {}),
    })) as {
      schema_version: "calyx.run-list/v1";
      count: number;
      truncated: boolean;
      next_cursor?: string;
      runs: RunListEntry[];
    };
    rows.push(...page.runs);
    if (rows.length > SELF_UPGRADE_ADMIN_RUN_SCAN_MAX_ITEMS) {
      throw new Error(
        `admin.run.list exceeded the self-upgrade verification scan limit of ${SELF_UPGRADE_ADMIN_RUN_SCAN_MAX_ITEMS} rows`,
      );
    }
    if (!page.truncated) return rows;
    if (!page.next_cursor || page.runs.length === 0) {
      throw new Error("admin.run.list returned an unrecoverable truncated page");
    }
    cursor = page.next_cursor;
  } while (rows.length <= SELF_UPGRADE_ADMIN_RUN_SCAN_MAX_ITEMS);
  throw new Error(
    `admin.run.list exceeded the self-upgrade verification scan limit of ${SELF_UPGRADE_ADMIN_RUN_SCAN_MAX_ITEMS} rows`,
  );
}

async function fetchAdminRuns(
  descriptor: Pick<SelfUpgradePlanDaemon, "health_url">,
  authToken: string,
  createAdminClient: typeof createCalyxAdminClient,
  expectedIdentity: ExpectedDaemonIdentity,
  signal?: AbortSignal,
): Promise<RunListEntry[]> {
  const primaryBaseUrl = descriptor.health_url;
  try {
    return await fetchAdminRunsFromBaseUrl(primaryBaseUrl, authToken, createAdminClient, signal);
  } catch (error) {
    const fallbackBaseUrl = loopbackBaseUrl(primaryBaseUrl);
    if (!fallbackBaseUrl || !isFetchTransportError(error)) {
      throw error;
    }
    const health = await fetchDaemonHealthFromBaseUrl(
      fallbackBaseUrl,
      authToken,
      createAdminClient,
      signal,
    );
    assertVerifiedDaemonIdentity(health, expectedIdentity);
    return fetchAdminRunsFromBaseUrl(fallbackBaseUrl, authToken, createAdminClient, signal);
  }
}

const SELF_UPGRADE_PRESERVATION_FEATURES = [
  CALYX_DAEMON_FEATURES.runReadoptOnBootV1,
  CALYX_DAEMON_FEATURES.detachedWorkerIsolationV1,
] as const;

/**
 * Proves the live daemons can preserve classifier-approved workers. The plan
 * reports the same feature boundary that the cutover rechecks immediately
 * before deciding which run ids may survive the restart.
 */
async function assessPreservationAvailability(
  daemons: Pick<SelfUpgradePlanDaemon, "health_url">[],
  authToken: string,
  createAdminClient: typeof createCalyxAdminClient,
): Promise<Pick<SelfUpgradePreservationPlan, "status" | "unavailable_reasons">> {
  if (daemons.length === 0) {
    return {
      status: "unavailable",
      unavailable_reasons: ["no registered daemon can attest preservation features"],
    };
  }
  if (!authToken) {
    return {
      status: "unavailable",
      unavailable_reasons: ["daemon preservation features cannot be authenticated"],
    };
  }
  const unavailableReasons: string[] = [];
  for (const daemon of daemons) {
    try {
      const health = await fetchDaemonHealth(daemon, authToken, createAdminClient);
      const missingFeatures = SELF_UPGRADE_PRESERVATION_FEATURES.filter(
        (feature) => !health.supports_features.includes(feature),
      );
      if (missingFeatures.length > 0) {
        unavailableReasons.push(
          `${daemon.health_url} is missing ${missingFeatures.join(", ")}`,
        );
      }
    } catch (error) {
      unavailableReasons.push(
        `${daemon.health_url} feature probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return unavailableReasons.length === 0
    ? { status: "available", unavailable_reasons: [] }
    : { status: "unavailable", unavailable_reasons: unavailableReasons };
}

export interface PromotedExecutionVerificationTarget {
  currentLink: string;
  wrapperPath: string;
}

function isPathEqualOrWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertWrapperTargetsPromotedCurrent(target: PromotedExecutionVerificationTarget): Promise<void> {
  const wrapper = await readFile(target.wrapperPath, "utf8").catch(() => undefined);
  if (!wrapper) {
    throw new Error(`bootstrap wrapper ${target.wrapperPath} is missing`);
  }
  const sourceExecutablePath = parseWrapperSourceExecutable(wrapper);
  if (!sourceExecutablePath) {
    throw new Error(`bootstrap wrapper ${target.wrapperPath} has no SOURCE_EXECUTABLE_PATH`);
  }
  if (!path.isAbsolute(sourceExecutablePath)) {
    throw new Error(`bootstrap wrapper ${target.wrapperPath} uses non-absolute SOURCE_EXECUTABLE_PATH ${sourceExecutablePath}`);
  }
  if (!isPathEqualOrWithin(target.currentLink, sourceExecutablePath)) {
    throw new Error(
      `bootstrap wrapper ${target.wrapperPath} points at ${sourceExecutablePath}, expected a path under ${target.currentLink}`,
    );
  }
  const expectedBinRealPath = await realpath(resolveCalyxInstallBinPath(target.currentLink));
  const sourceRealPath = await realpath(sourceExecutablePath);
  if (sourceRealPath !== expectedBinRealPath) {
    throw new Error(
      `bootstrap wrapper ${target.wrapperPath} resolves to ${sourceRealPath}, expected ${expectedBinRealPath}`,
    );
  }
}

function descriptorExecutableCandidate(argvPart: string, cwd: string): string | undefined {
  const resolved = path.isAbsolute(argvPart)
    ? path.resolve(argvPart)
    : argvPart.includes(path.sep)
      ? path.resolve(cwd, argvPart)
      : undefined;
  if (!resolved) {
    return undefined;
  }
  const normalized = resolved.split(path.sep).join("/");
  if (path.basename(resolved) === "calyx" && normalized.includes("/.agents/run/")) {
    return resolved;
  }
  if (path.basename(resolved) !== "bin.js") {
    return undefined;
  }
  if (
    normalized.includes("/@polli-labs/calyx/dist/")
    || normalized.endsWith("/packages/cli/dist/bin.js")
    || normalized.includes("/.calyx/installs/")
  ) {
    return resolved;
  }
  return undefined;
}

function assertDescriptorTargetsPromotedCurrent(
  descriptor: CalyxDaemonDescriptor | undefined,
  target: PromotedExecutionVerificationTarget,
): void {
  if (!descriptor) {
    throw new Error("daemon descriptor missing after restart");
  }
  const candidates = descriptor.argv
    .map((argvPart) => descriptorExecutableCandidate(argvPart, descriptor.cwd))
    .filter((candidate): candidate is string => Boolean(candidate));
  if (candidates.length === 0) {
    throw new Error(
      `daemon descriptor ${descriptor.daemon_id} does not include a concrete executable path for promoted-current verification`,
    );
  }
  for (const candidate of candidates) {
    if (path.resolve(candidate) === path.resolve(target.wrapperPath)) {
      continue;
    }
    if (!isPathEqualOrWithin(target.currentLink, candidate)) {
      throw new Error(
        `daemon descriptor ${descriptor.daemon_id} executable path ${candidate} is not under promoted current install ${target.currentLink}`,
      );
    }
  }
}

function buildOutOfRegistrationDiagnostic(args: {
  host: string;
  repoRoot: string;
  targetRef: string;
  healthUrl: string;
  health: CalyxDaemonHealth;
}): SelfUpgradeDiagnostic {
  const daemonId = args.health.daemon_id || "run-serve";
  const pullTarget = parsePullTarget(args.targetRef);
  return {
    kind: "daemon_out_of_registration",
    severity: "blocking",
    daemon_id: daemonId,
    health_url: args.healthUrl,
    active_runs: args.health.active_runs,
    message:
      `A run-service daemon responded on /v1/admin/health for host "${args.host}", but no descriptor was registered under ~/.calyx/daemons. `
      + "This is an out-of-registration daemon state; self upgrade cannot safely drain or restart it without registered runs_root and supervisor metadata.",
    actions: [
      `Inspect the supervisor: systemctl --user status calyx-run-serve.service`,
      `Inspect active work before mutating: calyx run ps --host ${args.host} --json`,
      `Manual build path: cd ${args.repoRoot} && git pull --ff-only ${pullTarget.remote} ${pullTarget.ref} && pnpm install --frozen-lockfile && pnpm -w build`,
      "Wait for active_runs=0 or explicitly stop/abort active runs before restarting the service.",
      "Restart after the manual build: systemctl --user restart calyx-run-serve.service",
      `Verify convergence: calyx self health --host ${args.host} --json`,
    ],
  };
}

async function diagnoseOutOfRegistrationDaemon(args: {
  host: string;
  currentHost: string;
  repoRoot: string;
  targetRef: string;
  options: SelfUpgradeOptions;
  deps: Required<Pick<SelfUpgradeDependencies, "createAdminClient" | "resolveAgentsInfraRoot" | "readHostsTruth">>;
}): Promise<SelfUpgradeDiagnostic[]> {
  const agentsInfraRoot = await args.deps.resolveAgentsInfraRoot();
  const hostsTruth = agentsInfraRoot ? await args.deps.readHostsTruth(agentsInfraRoot) : {};
  const healthUrl = resolveRunServeUrl(args.host, args.currentHost, hostsTruth);
  const authToken = args.options.authToken?.trim() || resolveTokenForHost(args.host, hostsTruth) || "";
  if (!authToken) {
    return [];
  }

  try {
    const health = await fetchDaemonHealth(
      { health_url: healthUrl },
      authToken,
      args.deps.createAdminClient,
    );
    if (health.daemon_kind !== "run-service") {
      return [];
    }
    return [
      buildOutOfRegistrationDiagnostic({
        host: args.host,
        repoRoot: args.repoRoot,
        targetRef: args.targetRef,
        healthUrl,
        health,
      }),
    ];
  } catch {
    return [];
  }
}

export async function appendControlEvent(
  runsRoots: string[],
  event: CalyxControlEvent,
): Promise<void> {
  // Control events also mirror to the orchestration ledger so daemon
  // health/upgrade/drift telemetry lands in the same SQLite event_log
  // alongside run.terminal events.
  const sink = new OrchestrationLedgerSink({ source: "self-upgrade" });
  try {
    for (const runsRoot of runsRoots) {
      const store = new RunStore(runsRoot, {
        eventLogIngest: (e) => sink.ingestStreamEvent(e),
      });
      await store.ensureRoot();
      await store.appendStreamEvent(event);
    }
  } finally {
    sink.close();
  }
}

export function buildControlEvent(args: {
  now: string;
  eventType: CalyxControlEvent["event_type"];
  emittedBy: CalyxControlEvent["emitted_by"];
  host: string;
  daemonId?: string;
  operationId?: string;
  phase?: CalyxUpgradePhase;
  elapsedMs?: number;
  build?: CalyxControlEvent["control"]["build"];
  error?: string;
  fleet?: CalyxControlEvent["control"]["fleet"];
}): CalyxControlEvent {
  const cursorSuffix = args.daemonId ? `${args.host}-${args.daemonId}` : args.host;
  return {
    schema_version: "1.0",
    event_id: randomUUID(),
    cursor: `${args.now}-control-${cursorSuffix}-${randomUUID()}`,
    emitted_at: args.now,
    event_type: args.eventType,
    emitted_by: args.emittedBy,
    control: {
      host: args.host,
      ...(args.daemonId ? { daemon_id: args.daemonId } : {}),
      ...(args.operationId ? { operation_id: args.operationId } : {}),
      ...(args.phase ? { phase: args.phase } : {}),
      ...(typeof args.elapsedMs === "number" ? { elapsed_ms: args.elapsedMs } : {}),
      ...(args.build ? { build: args.build } : {}),
      ...(args.error ? { error: args.error } : {}),
      ...(args.fleet ? { fleet: args.fleet } : {}),
    },
  };
}

async function resolveRepoRoot(
  host: string,
  deps: Required<Pick<SelfUpgradeDependencies, "homeDir" | "resolveAgentsInfraRoot" | "resolveRepo">>,
): Promise<string> {
  const fallback = path.join(deps.homeDir(), "dev", "calyx", "dev");
  const agentsInfraRoot = await deps.resolveAgentsInfraRoot();
  if (!agentsInfraRoot) {
    return fallback;
  }
  try {
    return await deps.resolveRepo("calyx", host, agentsInfraRoot);
  } catch {
    return fallback;
  }
}

async function collectActiveRuns(
  descriptors: SelfUpgradePlanDaemon[],
  createRunService: Required<SelfUpgradeDependencies>["createRunService"],
): Promise<SelfUpgradeActiveRun[]> {
  const activeRuns: SelfUpgradeActiveRun[] = [];
  for (const runsRoot of uniqueRunsRoots(descriptors)) {
    const service = createRunService({ runsRoot });
    await service.reconcile();
    const runs = await service.listRuns();
    const activeEntries = runs.filter((entry) => !isTerminalState(entry.state));
    const rootRuns: Array<{ record: RunRecord; category: ActiveRunCategory }> = [];
    for (const entry of activeEntries) {
      const record = await service.getRunRecord(entry.run_id);
      if (!record) {
        continue;
      }
      rootRuns.push({ record, category: categoryForRun(record) });
    }
    // POL-1886: classify which runs are live detached agent_runner workers that
    // the boot reconcile will re-adopt. reconcile() above already ran; this
    // reuses the same store without a second reconcile pass.
    const assessments = await service.assessRestartReadopt(rootRuns.map((run) => run.record.run_id));
    const assessmentByRunId = new Map(assessments.map((assessment) => [assessment.run_id, assessment]));
    for (const { record, category } of rootRuns) {
      const assessment = assessmentByRunId.get(record.run_id);
      // A run is restart-safe only when it is both health-drainable (healthy,
      // not resumable) AND a live re-adoptable detached worker. The block
      // reason prefers the health category so resumable/unhealthy runs report
      // their existing classification; otherwise it carries the worker reason.
      const restartSafe = category === "drainable" && (assessment?.readopt_safe ?? false);
      const blockReason = restartSafe
        ? undefined
        : category !== "drainable"
          ? category
          : assessment?.reason ?? "missing_record";
      activeRuns.push({
        run_id: record.run_id,
        runs_root: runsRoot,
        state: record.state,
        ...(record.health ? { health_status: record.health.status } : {}),
        resumable: record.recovery.resumable,
        category,
        restart_safe: restartSafe,
        ...(blockReason ? { restart_block_reason: blockReason } : {}),
        ...(assessment?.worker_supervisor ? { worker_supervisor: assessment.worker_supervisor } : {}),
        summary: record.summary,
      });
    }
  }
  return activeRuns.sort((left, right) => left.run_id.localeCompare(right.run_id));
}

function isTerminalState(state: RunListEntry["state"]): boolean {
  return (
    state === "succeeded"
    || state === "failed"
    || state === "partial"
    || state === "cancelled"
    || state === "auth_error"
    || state === "infra_error"
    || state === "completed_dirty"
  );
}

function buildBlockers(args: {
  options: SelfUpgradeOptions;
  descriptors: SelfUpgradePlanDaemon[];
  diagnostics: SelfUpgradeDiagnostic[];
  dirty: boolean;
  missingBuildArtifacts: string[];
  activeRuns: SelfUpgradeActiveRun[];
  authTokenPresent: boolean;
  selfReferentialDaemonIds: string[];
  targetHead?: string;
}): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (args.options.abortRuns && !args.options.force) {
    blockers.push("--abort-runs requires --force.");
  }
  if (args.descriptors.length === 0) {
    const outOfRegistration = args.diagnostics.find((diagnostic) => diagnostic.kind === "daemon_out_of_registration");
    blockers.push(outOfRegistration?.message ?? "No registered daemons found under ~/.calyx/daemons.");
  }
  if (!args.targetHead) {
    blockers.push(`Unable to resolve target ref "${args.options.to ?? DEFAULT_TARGET_REF}".`);
  }
  if (args.selfReferentialDaemonIds.length > 0) {
    blockers.push(
      `Self-referential upgrade not yet implemented; current process matches registered daemon(s): ${args.selfReferentialDaemonIds.join(", ")}. Run self upgrade from a different host or a non-daemon context.`,
    );
  }
  if (args.dirty) {
    if (args.options.force) {
      warnings.push("Target repo is dirty; continuing because --force was supplied.");
    } else {
      blockers.push("Target repo is dirty; inspect the dirty worktree or retry with --force.");
    }
  }
  if (args.missingBuildArtifacts.length > 0) {
    if (args.options.force) {
      warnings.push("Current build artifacts are missing; continuing because --force was supplied.");
    } else {
      blockers.push(`Missing build artifacts: ${args.missingBuildArtifacts.join(", ")}.`);
    }
  }

  const blockingRuns = args.activeRuns.filter((run) => run.category !== "drainable");
  if (blockingRuns.length > 0 && !(args.options.force && args.options.abortRuns)) {
    blockers.push(
      `Blocking active runs remain after reconcile (${blockingRuns.map((run) => `${run.run_id}:${run.category}`).join(", ")}). Re-run with --force --abort-runs to proceed.`,
    );
  }

  if (!args.options.dryRun && !args.authTokenPresent) {
    blockers.push("self upgrade requires --auth-token or an operator_cli outbound credential for authenticated /v1/admin/health verification.");
  }

  return { blockers, warnings };
}

async function buildPlan(
  options: SelfUpgradeOptions,
  deps: Required<SelfUpgradeDependencies>,
): Promise<SelfUpgradePlan> {
  const requestedHost = normalizeHostAlias(options.host);
  const currentHost = normalizeHostAlias(await deps.resolveCurrentHostAlias());
  if (!requestedHost) {
    throw createSelfUpgradeError("self upgrade requires a non-empty --host.", 2);
  }
  if (requestedHost !== currentHost) {
    throw createSelfUpgradeError(
      `self upgrade only operates on the current host. Requested "${requestedHost}", current host is "${currentHost}".`,
      2,
    );
  }

  const repoRoot = await resolveRepoRoot(requestedHost, deps);
  const descriptors = (await deps.listDescriptors({ root: defaultDaemonsRoot() }))
    .sort((left, right) => left.restart_order - right.restart_order || left.daemon_id.localeCompare(right.daemon_id))
    .map<SelfUpgradePlanDaemon>((descriptor) => ({
      daemon_id: descriptor.daemon_id,
      pid: descriptor.pid,
      runs_root: descriptor.runs_root,
      health_url: descriptor.health_url,
      restart_order: descriptor.restart_order,
      supervisor: descriptor.supervisor,
      build: descriptor.build,
      maintenance_mode: descriptor.maintenance_mode ?? false,
    }));

  const currentHeadResult = await deps.execGit(["rev-parse", "HEAD"], repoRoot);
  if (currentHeadResult.code !== 0) {
    throw createSelfUpgradeError(currentHeadResult.stderr.trim() || currentHeadResult.stdout.trim() || `git rev-parse HEAD failed in ${repoRoot}.`, 6);
  }

  const targetRef = options.to?.trim() || DEFAULT_TARGET_REF;
  const explicitTargetSha = options.targetSha?.trim();
  if (explicitTargetSha && !/^[0-9a-f]{40}$/i.test(explicitTargetSha)) {
    throw createSelfUpgradeError(`--target-sha must be a full 40-character hex SHA, got: ${explicitTargetSha}`, 2);
  }
  // POL-2045: target evidence is mandatory even for a direct single-host
  // invocation. An unpinned `rev-parse origin/main` can be stale during
  // dry-run and then disagree with a later `git pull`. Fetch names the remote
  // object we assess; apply below adopts this exact planned SHA.
  let targetHeadResult: CommandResult;
  if (explicitTargetSha) {
    targetHeadResult = { code: 0, stdout: explicitTargetSha, stderr: "" };
  } else {
    const pullTarget = parsePullTarget(targetRef);
    const fetchResult = await deps.execGit(["fetch", pullTarget.remote, pullTarget.ref], repoRoot);
    if (fetchResult.code !== 0) {
      throw createSelfUpgradeError(
        fetchResult.stderr.trim() || fetchResult.stdout.trim() || `git fetch ${pullTarget.remote} ${pullTarget.ref} failed.`,
        6,
      );
    }
    targetHeadResult = await deps.execGit(["rev-parse", "FETCH_HEAD"], repoRoot);
    if (targetHeadResult.code !== 0) {
      throw createSelfUpgradeError(
        targetHeadResult.stderr.trim() || targetHeadResult.stdout.trim() || "git rev-parse FETCH_HEAD failed.",
        6,
      );
    }
  }
  if (!/^[0-9a-f]{40}$/i.test(targetHeadResult.stdout.trim())) {
    throw createSelfUpgradeError(
      `Target ${targetRef} did not resolve to a full 40-character SHA: ${targetHeadResult.stdout.trim() || "<empty>"}`,
      6,
    );
  }
  const targetHead = targetHeadResult.stdout.trim();
  const defaultFetchTarget = parsePullTarget(targetRef);
  const targetEvidence: SelfUpgradeTargetEvidence = options.targetEvidence ?? {
    original_ref: targetRef,
    target_sha: targetHead,
    fetch_remote: defaultFetchTarget.remote,
    fetch_ref: defaultFetchTarget.ref,
  };
  if (
    targetEvidence.original_ref !== targetRef
    || targetEvidence.target_sha !== targetHead
    || !targetEvidence.fetch_remote.trim()
    || !targetEvidence.fetch_ref.trim()
  ) {
    throw createSelfUpgradeError(
      "Conductor target evidence is incomplete or does not match the requested ref and pinned target SHA.",
      6,
    );
  }
  const dirtyPaths = await readDirtyPaths(repoRoot, deps.execGit);

  const missingBuildArtifacts: string[] = [];
  for (const relativePath of REQUIRED_BUILD_ARTIFACTS) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!(await pathExists(absolutePath))) {
      missingBuildArtifacts.push(relativePath);
    }
  }

  const diagnostics = descriptors.length === 0
    ? await diagnoseOutOfRegistrationDaemon({
        host: requestedHost,
        currentHost,
        repoRoot,
        targetRef,
        options,
        deps,
      })
    : [];
  const activeRuns = await collectActiveRuns(descriptors, deps.createRunService);
  const selfReferentialDaemonIds = descriptors.filter((descriptor) => descriptor.pid === process.pid).map((descriptor) => descriptor.daemon_id);
  const authToken = await resolveSelfUpgradeAuthToken(requestedHost, options.authToken, deps);
  const restartSafeRuns = activeRuns.filter((run) => run.restart_safe);
  let preservation: SelfUpgradePreservationPlan;
  if (options.force && options.abortRuns) {
    // Mirrors execution order: the explicit interrupt path aborts every active
    // run, restart-safe ones included, so the plan must not promise preservation.
    preservation = {
      policy: "abort_runs",
      status: "disabled",
      required_features: [...SELF_UPGRADE_PRESERVATION_FEATURES],
      unavailable_reasons: [],
      note: "disabled by --force --abort-runs",
    };
  } else if (options.drainAll) {
    preservation = {
      policy: "drain_all",
      status: "disabled",
      required_features: [...SELF_UPGRADE_PRESERVATION_FEATURES],
      unavailable_reasons: [],
      note: "disabled by --drain-all",
    };
  } else if (restartSafeRuns.length === 0) {
    preservation = {
      policy: "automatic",
      status: "not_applicable",
      required_features: [...SELF_UPGRADE_PRESERVATION_FEATURES],
      unavailable_reasons: [],
      note: "the classifier found no active restart-safe runs",
    };
  } else {
    const availability = await assessPreservationAvailability(
      descriptors,
      authToken,
      deps.createAdminClient,
    );
    preservation = {
      policy: "automatic",
      ...availability,
      required_features: [...SELF_UPGRADE_PRESERVATION_FEATURES],
    };
  }
  const { blockers, warnings } = buildBlockers({
    options,
    descriptors,
    diagnostics,
    dirty: dirtyPaths.length > 0,
    missingBuildArtifacts,
    activeRuns,
    authTokenPresent: authToken.length > 0,
    selfReferentialDaemonIds,
    ...(targetHeadResult.code === 0 ? { targetHead: targetHeadResult.stdout.trim() } : {}),
  });

  // POL-2045: preflight the target binary's startup-environment contract against
  // the live supervisor definition. Fleet hosts consume the conductor's
  // digest-verified, SHA-bound target payload, so remote object availability is
  // irrelevant to dry-run truth. Verdict status is epistemic; the typed
  // mutation disposition is authoritative and is not overridable by --force.
  // Only proven pre-contract absence is `unknown + allow`; unproved
  // post-contract supervisor semantics remain `unknown` but block. The real
  // run re-checks the adopted worktree and live supervisor before promotion.
  const consumerApiCredentialEnvContract = await resolveHostStartupCredentialEnvContract(requestedHost, deps);
  if (options.dryRun && !explicitTargetSha && targetHead) {
    warnings.push(
      `This dry-run is pinned to ${targetHead}. A later invocation replans the ref; pass --target-sha ${targetHead} to apply this exact assessment.`,
    );
  }
  const startupContract = await computeStartupContractVerdict({
    host: requestedHost,
    repoRoot,
    daemons: descriptors,
    source: options.startupContractPayload && targetHead
      ? { kind: "payload", encoded: options.startupContractPayload, targetSha: targetHead }
      : { kind: "git", ref: targetHead },
    execGit: deps.execGit,
    resolveSupervisorEnvNames: deps.resolveSupervisorEnvNames,
    homeDir: deps.homeDir,
    pathExists,
    ...(consumerApiCredentialEnvContract ? { consumerApiCredentialEnvContract } : {}),
  });
  for (const reason of startupContract.blocking_reasons) {
    blockers.push(reason.message);
  }

  return {
    host: requestedHost,
    repo_root: repoRoot,
    current_head: currentHeadResult.stdout.trim(),
    target_ref: targetRef,
    target_head: targetHead,
    target_evidence: targetEvidence,
    dirty: dirtyPaths.length > 0,
    dirty_paths: dirtyPaths,
    missing_build_artifacts: missingBuildArtifacts,
    daemons: descriptors,
    active_runs_post_reconcile: activeRuns,
    preservation,
    startup_contract: startupContract,
    blockers,
    warnings,
    diagnostics,
  };
}

/**
 * Blocking reasons a pending source-managed supervisor cutover can still
 * repair: both derive from inspecting the *live* supervisor definition, which
 * the cutover replaces. An invalid, missing, or unsupported *target* contract
 * (`target_contract_invalid` — the stale-planner regression) is repairable by
 * no supervisor definition and must refuse before the first mutation.
 */
const SUPERVISOR_REPAIRABLE_BLOCKING_CODES: ReadonlySet<StartupContractBlockingReasonCode> = new Set([
  "startup_contract_incompatible",
  "post_contract_supervisor_semantics_unproved",
]);

function unwaivedStartupContractBlockingReasons(
  verdict: Pick<SelfUpgradeStartupContractVerdict, "blocking_reasons">,
  supervisorRepairPending: boolean,
): string[] {
  return verdict.blocking_reasons
    .filter((reason) =>
      !supervisorRepairPending || !SUPERVISOR_REPAIRABLE_BLOCKING_CODES.has(reason.code))
    .map((reason) => reason.message);
}

async function assertStartupContractCompatibleBeforePromotion(
  plan: SelfUpgradePlan,
  deps: Required<SelfUpgradeDependencies>,
  options: { supervisorRepairPending?: boolean } = {},
): Promise<void> {
  const consumerApiCredentialEnvContract = await resolveHostStartupCredentialEnvContract(plan.host, deps);
  const verdict = await computeStartupContractVerdict({
    host: plan.host,
    repoRoot: plan.repo_root,
    daemons: plan.daemons,
    source: { kind: "worktree", targetSha: plan.target_head ?? plan.current_head },
    execGit: deps.execGit,
    resolveSupervisorEnvNames: deps.resolveSupervisorEnvNames,
    homeDir: deps.homeDir,
    pathExists,
    ...(consumerApiCredentialEnvContract ? { consumerApiCredentialEnvContract } : {}),
  });
  // Refresh the plan with the authoritative worktree-derived verdict so the
  // receipt/JSON reflect the definitive pre-promotion check, not the earlier
  // best-effort `git show` read.
  plan.startup_contract = verdict;
  if (verdict.mutation_disposition !== "block") {
    return;
  }
  const blocking = unwaivedStartupContractBlockingReasons(
    verdict,
    options.supervisorRepairPending === true,
  );
  if (blocking.length === 0) {
    return;
  }
  throw createSelfUpgradeError(
    blocking.join("\n")
      || verdict.remediation
      || "Target binary startup contract does not authorize promotion.",
    1,
  );
}

interface CanonicalSupervisorStageReceipt {
  schema_version: "polli.calyx-run-service-stage/v2";
  status: "staged";
  host: string;
  authority: {
    source: "agents-infra";
    host_binding: true;
  };
  prepared_target: {
    git_head: string;
    install_path: string;
    build_info_sha256: string;
    interface_version: string;
  };
  live: {
    path: string;
    present: boolean;
  };
  staged: {
    path: string;
    desired_service_sha256: string;
    published: true;
    activated: false;
  };
  projector: {
    source_sha256: string;
    installed_sha256: string;
    matches: true;
    executable: true;
  };
  credentials: {
    required_names: string[];
    missing_names: [];
    invalid_names: [];
    ready: true;
  };
  compatibility: {
    startup_contract_version: string;
    target_interface_version: string;
    ready: true;
  };
}

interface SupervisorServiceSnapshot {
  path: string;
  bytes: Buffer;
  mode: number;
  sha256: string;
  identity: SelfUpgradeFilesystemIdentity;
  parentIdentity: SelfUpgradeFilesystemIdentity;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function sameFilesystemIdentity(
  left: SelfUpgradeFilesystemIdentity,
  right: SelfUpgradeFilesystemIdentity,
): boolean {
  return left.kind === right.kind
    && left.device === right.device
    && left.inode === right.inode
    && path.resolve(left.real_path) === path.resolve(right.real_path);
}

function samePhysicalFile(
  left: SelfUpgradeFilesystemIdentity,
  right: SelfUpgradeFilesystemIdentity,
): boolean {
  return left.kind === "file"
    && right.kind === "file"
    && left.device === right.device
    && left.inode === right.inode;
}

function isFilesystemIdentity(value: unknown, kind?: SelfUpgradeFilesystemIdentity["kind"]): value is SelfUpgradeFilesystemIdentity {
  const typed = value as Partial<SelfUpgradeFilesystemIdentity> | undefined;
  return Boolean(
    typed
    && typeof typed.path === "string"
    && path.isAbsolute(typed.path)
    && typeof typed.real_path === "string"
    && path.isAbsolute(typed.real_path)
    && (typed.kind === "file" || typed.kind === "directory")
    && (kind === undefined || typed.kind === kind)
    && Number.isSafeInteger(typed.device)
    && Number.isSafeInteger(typed.inode),
  );
}

async function captureFilesystemIdentity(
  candidatePath: string,
  expectedKind: SelfUpgradeFilesystemIdentity["kind"],
): Promise<SelfUpgradeFilesystemIdentity> {
  const resolvedPath = path.resolve(candidatePath);
  const canonical = await realpath(resolvedPath);
  const handle = await open(
    canonical,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (
      (expectedKind === "file" && !metadata.isFile())
      || (expectedKind === "directory" && !metadata.isDirectory())
    ) {
      throw new Error(`Filesystem authority is not a physical ${expectedKind}: ${candidatePath}`);
    }
    if (!Number.isSafeInteger(metadata.dev) || !Number.isSafeInteger(metadata.ino)) {
      throw new Error(`Filesystem authority has an unsafe device/inode identity: ${candidatePath}`);
    }
    return {
      path: resolvedPath,
      real_path: canonical,
      kind: expectedKind,
      device: metadata.dev,
      inode: metadata.ino,
    };
  } finally {
    await handle.close();
  }
}

async function assertFilesystemIdentityCurrent(
  expected: SelfUpgradeFilesystemIdentity,
  label: string,
): Promise<SelfUpgradeFilesystemIdentity> {
  const current = await captureFilesystemIdentity(expected.path, expected.kind);
  if (!sameFilesystemIdentity(current, expected)) {
    throw new Error(
      `${label} filesystem identity changed `
      + `(expected dev=${expected.device}/ino=${expected.inode}, observed dev=${current.device}/ino=${current.inode}).`,
    );
  }
  return current;
}

async function assertOpenRegularFileCurrent(
  handle: Awaited<ReturnType<typeof open>>,
  expected: SelfUpgradeFilesystemIdentity,
  label: string,
): Promise<void> {
  const held = await handle.stat();
  if (
    !held.isFile()
    || held.dev !== expected.device
    || held.ino !== expected.inode
  ) {
    throw new Error(`${label} retained handle no longer matches its accepted file identity.`);
  }
  const current = await captureFilesystemIdentity(expected.path, "file");
  if (!samePhysicalFile(current, expected)) {
    throw new Error(
      `${label} pathname no longer names the retained file `
      + `(expected dev=${expected.device}/ino=${expected.inode}, observed dev=${current.device}/ino=${current.inode}).`,
    );
  }
}

async function assertOpenDirectoryCurrent(
  handle: Awaited<ReturnType<typeof open>>,
  expected: SelfUpgradeFilesystemIdentity,
  label: string,
): Promise<void> {
  const held = await handle.stat();
  if (
    !held.isDirectory()
    || held.dev !== expected.device
    || held.ino !== expected.inode
  ) {
    throw new Error(`${label} retained handle no longer matches its accepted directory identity.`);
  }
  const current = await captureFilesystemIdentity(expected.path, "directory");
  if (!sameFilesystemIdentity(current, expected)) {
    throw new Error(`${label} pathname no longer names the retained directory.`);
  }
}

async function sha256OpenRegularFile(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.byteLength,
      position,
    );
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

async function copyOpenRegularFile(
  source: Awaited<ReturnType<typeof open>>,
  destination: Awaited<ReturnType<typeof open>>,
): Promise<number> {
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await source.read(
      buffer,
      0,
      buffer.byteLength,
      position,
    );
    if (bytesRead === 0) break;
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(
        buffer,
        written,
        bytesRead - written,
        position + written,
      );
      if (result.bytesWritten <= 0) {
        throw new Error("State snapshot copy made no forward progress.");
      }
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
  await destination.truncate(position);
  return position;
}

async function allocateRollbackReserve(
  reservePath: string,
  bytes: number,
): Promise<{
  identity: SelfUpgradeFilesystemIdentity;
  allocatedBytes: number;
}> {
  const handle = await open(
    reservePath,
    fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | fsConstants.O_RDWR
      | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const block = Buffer.alloc(Math.min(bytes, 1024 * 1024), 0xa5);
    let position = 0;
    while (position < bytes) {
      const length = Math.min(block.byteLength, bytes - position);
      const { bytesWritten } = await handle.write(
        block,
        0,
        length,
        position,
      );
      if (bytesWritten <= 0) {
        throw new Error("Rollback reserve allocation made no forward progress.");
      }
      position += bytesWritten;
    }
    await handle.sync();
    const metadata = await handle.stat();
    const allocatedBytes = metadata.blocks * 512;
    if (metadata.size !== bytes || allocatedBytes < bytes) {
      throw new Error(
        `Rollback reserve is not physically allocated `
        + `(size=${metadata.size}, allocated=${allocatedBytes}, required=${bytes}).`,
      );
    }
    const identity = await captureFilesystemIdentity(reservePath, "file");
    await assertOpenRegularFileCurrent(handle, identity, "Rollback reserve");
    return { identity, allocatedBytes };
  } finally {
    await handle.close();
  }
}

async function readRegularFileNoFollowWithIdentity(filePath: string): Promise<{
  bytes: Buffer;
  identity: SelfUpgradeFilesystemIdentity;
  parentIdentity: SelfUpgradeFilesystemIdentity;
}> {
  const parentIdentity = await captureFilesystemIdentity(path.dirname(filePath), "directory");
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.dev) || !Number.isSafeInteger(metadata.ino)) {
      throw new Error(`Recovery authority is not a physical regular file: ${filePath}`);
    }
    const bytes = await handle.readFile();
    const identity: SelfUpgradeFilesystemIdentity = {
      path: path.resolve(filePath),
      real_path: await realpath(filePath),
      kind: "file",
      device: metadata.dev,
      inode: metadata.ino,
    };
    await assertFilesystemIdentityCurrent(parentIdentity, "Recovery authority parent");
    return { bytes, identity, parentIdentity };
  } finally {
    await handle.close();
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Canonical supervisor stage receipt is missing ${label}.`);
  }
  return value;
}

async function parseCanonicalSupervisorStageReceipt(
  result: CommandResult,
  args: {
    host: string;
    preparedInstall: VersionedInstallReceipt;
  },
): Promise<CanonicalSupervisorStageReceipt> {
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    if (result.code !== 0) {
      throw new Error(
        commandDetail(result)
          || `Canonical agents-infra supervisor stage failed with exit ${result.code}.`,
      );
    }
    throw new Error("Canonical agents-infra supervisor stage did not return one JSON receipt.");
  }
  if (result.code !== 0) {
    const blocked = raw as {
      schema_version?: unknown;
      status?: unknown;
      credentials?: { missing_names?: unknown; invalid_names?: unknown };
    };
    if (
      result.code === 3
      && blocked.schema_version === "polli.calyx-run-service-stage/v2"
      && blocked.status === "blocked"
      && Array.isArray(blocked.credentials?.missing_names)
      && Array.isArray(blocked.credentials.invalid_names)
    ) {
      const missing = blocked.credentials.missing_names.filter(
        (value): value is string => typeof value === "string",
      );
      const invalid = blocked.credentials.invalid_names.filter(
        (value): value is string => typeof value === "string",
      );
      throw new Error(
        `Canonical supervisor staging is blocked by operator credential projection: missing=${
          missing.length > 0 ? missing.join(", ") : "unspecified"
        }; invalid=${invalid.length > 0 ? invalid.join(", ") : "none"}.`,
      );
    }
    throw new Error(
      commandDetail(result)
        || `Canonical agents-infra supervisor stage failed with exit ${result.code}.`,
    );
  }
  const receipt = raw as Partial<CanonicalSupervisorStageReceipt>;
  if (
    receipt.schema_version !== "polli.calyx-run-service-stage/v2"
    || receipt.status !== "staged"
    || receipt.host !== args.host
    || receipt.authority?.source !== "agents-infra"
    || receipt.authority.host_binding !== true
    || receipt.staged?.published !== true
    || receipt.staged.activated !== false
    || receipt.projector?.matches !== true
    || receipt.projector.executable !== true
    || receipt.credentials?.ready !== true
    || receipt.compatibility?.ready !== true
  ) {
    throw new Error("Canonical agents-infra supervisor stage receipt is not authoritative and ready.");
  }
  if (
    !Array.isArray(receipt.credentials.required_names)
    || !Array.isArray(receipt.credentials.missing_names)
    || !Array.isArray(receipt.credentials.invalid_names)
    || receipt.credentials.missing_names.length > 0
    || receipt.credentials.invalid_names.length > 0
  ) {
    throw new Error("Canonical agents-infra supervisor stage receipt has an invalid credential projection.");
  }
  requireString(receipt.live?.path, "live.path");
  requireString(receipt.staged.path, "staged.path");
  const targetInstallPath = requireString(receipt.prepared_target?.install_path, "prepared_target.install_path");
  const targetInterfaceVersion = requireString(
    receipt.prepared_target?.interface_version,
    "prepared_target.interface_version",
  );
  requireString(
    receipt.compatibility.startup_contract_version,
    "compatibility.startup_contract_version",
  );
  if (
    receipt.prepared_target?.git_head !== args.preparedInstall.git_head
    || path.resolve(targetInstallPath) !== path.resolve(args.preparedInstall.install_path)
    || receipt.live?.present !== true
    || receipt.compatibility.target_interface_version !== targetInterfaceVersion
  ) {
    throw new Error("Canonical agents-infra supervisor stage receipt is not bound to the prepared target and service.");
  }
  const buildInfoSha256 = sha256Bytes(await readFile(args.preparedInstall.build_info_path));
  if (receipt.prepared_target.build_info_sha256 !== buildInfoSha256) {
    throw new Error("Canonical supervisor stage receipt is not bound to the prepared target build receipt.");
  }
  for (const [label, value] of [
    ["staged.desired_service_sha256", receipt.staged.desired_service_sha256],
    ["prepared_target.build_info_sha256", receipt.prepared_target.build_info_sha256],
    ["projector.source_sha256", receipt.projector.source_sha256],
    ["projector.installed_sha256", receipt.projector.installed_sha256],
  ] as const) {
    if (!isSha256(value)) {
      throw new Error(`Canonical supervisor stage receipt has invalid ${label}.`);
    }
  }
  return receipt as CanonicalSupervisorStageReceipt;
}

async function readSupervisorServiceSnapshot(filePath: string): Promise<SupervisorServiceSnapshot> {
  const parentIdentity = await captureFilesystemIdentity(path.dirname(filePath), "directory");
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`Live supervisor definition is not a physical regular file: ${filePath}`);
    }
    if (!Number.isSafeInteger(metadata.dev) || !Number.isSafeInteger(metadata.ino)) {
      throw new Error(`Live supervisor definition has an unsafe device/inode identity: ${filePath}`);
    }
    const bytes = await handle.readFile();
    const identity: SelfUpgradeFilesystemIdentity = {
      path: path.resolve(filePath),
      real_path: await realpath(filePath),
      kind: "file",
      device: metadata.dev,
      inode: metadata.ino,
    };
    await assertFilesystemIdentityCurrent(parentIdentity, "Supervisor definition parent");
    return {
      path: filePath,
      bytes,
      mode: metadata.mode & 0o777,
      sha256: sha256Bytes(bytes),
      identity,
      parentIdentity,
    };
  } finally {
    await handle.close();
  }
}

async function replaceSupervisorServiceFile(
  filePath: string,
  bytes: Uint8Array,
  mode: number,
  expected?: Pick<SupervisorServiceSnapshot, "sha256" | "identity" | "parentIdentity">,
): Promise<void> {
  const directory = path.dirname(filePath);
  const directoryIdentity = expected?.parentIdentity
    ? await assertFilesystemIdentityCurrent(expected.parentIdentity, "Supervisor definition parent")
    : await captureFilesystemIdentity(directory, "directory");
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_WRONLY
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(mode);
    await handle.close();
    handle = undefined;
    if (expected) {
      const pointOfUse = await readSupervisorServiceSnapshot(filePath);
      if (
        pointOfUse.sha256 !== expected.sha256
        || !sameFilesystemIdentity(pointOfUse.identity, expected.identity)
        || !sameFilesystemIdentity(pointOfUse.parentIdentity, expected.parentIdentity)
      ) {
        throw new Error(
          "Canonical supervisor definition changed after readiness; refusing to overwrite a concurrent config publication.",
        );
      }
    }
    await assertFilesystemIdentityCurrent(directoryIdentity, "Supervisor definition parent");
    await rename(temporaryPath, filePath);
    await assertFilesystemIdentityCurrent(directoryIdentity, "Supervisor definition parent");
    const directoryHandle = await open(directoryIdentity.real_path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function sha256RegularFileNoFollow(filePath: string): Promise<string> {
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`Recovery authority is not a physical regular file: ${filePath}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function fsyncFileAndParent(filePath: string): Promise<void> {
  const fileHandle = await open(filePath, fsConstants.O_RDONLY);
  try {
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }
  const directoryHandle = await open(path.dirname(filePath), fsConstants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function assertStateDatabaseHealthy(
  dbPath: string,
  _homeDir: string,
): Promise<void> {
  const driver = await loadStateDriver();
  const db = driver.openReadOnly(dbPath);
  try {
    const row = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    if (!row || !Object.values(row).some((value) => value === "ok")) {
      throw new Error(`SQLite quick_check failed for ${dbPath}.`);
    }
  } finally {
    db.close();
  }
}

async function checkpointStateDatabase(
  dbPath: string,
  homeDir: string,
  retainedHandle: Awaited<ReturnType<typeof open>>,
  expectedIdentity: SelfUpgradeFilesystemIdentity,
): Promise<void> {
  await assertOpenRegularFileCurrent(
    retainedHandle,
    expectedIdentity,
    "State database before checkpoint",
  );
  const opened = await openStateStore({
    paths: {
      stateDir: path.dirname(dbPath),
      dbPath,
      source: "env-db",
      dirSource: "env-db-derived",
    },
    homeDir,
  });
  try {
    const row = opened.db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    if (!row || !Object.values(row).some((value) => value === "ok")) {
      throw new Error(`SQLite quick_check failed before checkpoint for ${dbPath}.`);
    }
    opened.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    opened.db.close();
  }
  await assertOpenRegularFileCurrent(
    retainedHandle,
    expectedIdentity,
    "State database after checkpoint",
  );
}

async function restoreStateSnapshot(
  snapshot: SelfUpgradeStateSnapshotReceipt,
  _homeDir: string,
): Promise<SelfUpgradeStateRollbackReceipt> {
  try {
    if (
      snapshot.restore_strategy !== "precreated-same-filesystem-hardlink-rename"
      || !snapshot.database_parent_identity
      || !snapshot.backup_identity
      || !snapshot.backup_parent_identity
      || !snapshot.rollback_candidate_path
      || !snapshot.rollback_candidate_identity
      || !snapshot.rollback_reserve_path
      || !snapshot.rollback_reserve_identity
      || typeof snapshot.rollback_reserve_allocated_bytes !== "number"
    ) {
      throw new Error("State snapshot lacks its pre-created same-filesystem rollback authority.");
    }
    const databaseParent = await assertFilesystemIdentityCurrent(
      snapshot.database_parent_identity,
      "State database parent",
    );
    const backupParent = await assertFilesystemIdentityCurrent(
      snapshot.backup_parent_identity,
      "State snapshot parent",
    );
    if (databaseParent.device !== backupParent.device) {
      throw new Error("State snapshot and database are no longer on the same filesystem.");
    }
    const backupHandle = await open(
      snapshot.backup_path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const rollbackCandidateHandle = await open(
      snapshot.rollback_candidate_path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    try {
      await assertOpenRegularFileCurrent(
        backupHandle,
        snapshot.backup_identity,
        "State snapshot",
      );
      await assertOpenRegularFileCurrent(
        rollbackCandidateHandle,
        snapshot.rollback_candidate_identity,
        "State rollback candidate",
      );
      if (!samePhysicalFile(snapshot.backup_identity, snapshot.rollback_candidate_identity)) {
        throw new Error("State snapshot and rollback candidate no longer pin one physical image.");
      }
      if (await sha256OpenRegularFile(backupHandle) !== snapshot.database_sha256) {
        throw new Error("State snapshot hash changed before rollback.");
      }
      if (await sha256OpenRegularFile(rollbackCandidateHandle) !== snapshot.database_sha256) {
        throw new Error("State rollback candidate hash changed before rollback.");
      }
      const reserveIdentity = await assertFilesystemIdentityCurrent(
        snapshot.rollback_reserve_identity,
        "State rollback reserve",
      );
      const reserveMetadata = await lstat(snapshot.rollback_reserve_path);
      if (
        reserveMetadata.isSymbolicLink()
        || !reserveMetadata.isFile()
        || reserveMetadata.blocks * 512 < snapshot.rollback_reserve_allocated_bytes
        || reserveIdentity.device !== databaseParent.device
      ) {
        throw new Error("State rollback reserve lost its physical allocation.");
      }
      await assertFilesystemIdentityCurrent(databaseParent, "State database parent");
      await assertFilesystemIdentityCurrent(backupParent, "State snapshot parent");
      // The rollback candidate directory entry already exists before target
      // migrations begin. Even a migration that consumes every remaining
      // allocatable block cannot prevent rename(2) from restoring the image.
      await rm(snapshot.rollback_reserve_path, { force: true });
      await syncDirectoryIdentity(backupParent);
      await rm(`${snapshot.database_path}-wal`, { force: true });
      await rm(`${snapshot.database_path}-shm`, { force: true });
      await syncDirectoryIdentity(databaseParent);
      await rename(snapshot.rollback_candidate_path, snapshot.database_path);
    } finally {
      await backupHandle.close();
      await rollbackCandidateHandle.close();
    }
    await assertFilesystemIdentityCurrent(snapshot.backup_identity, "State snapshot");
    const restoredIdentity = await captureFilesystemIdentity(snapshot.database_path, "file");
    if (!samePhysicalFile(restoredIdentity, snapshot.backup_identity)) {
      throw new Error("Restored state database does not retain the snapshot inode.");
    }
    await fsyncFileAndParent(snapshot.database_path);
    const restoredSha256 = await sha256RegularFileNoFollow(snapshot.database_path);
    if (restoredSha256 !== snapshot.database_sha256) {
      throw new Error("Restored state database does not match the quiesced snapshot.");
    }
    await assertStateDatabaseHealthy(snapshot.database_path, _homeDir);
    return {
      schema_version: "self-upgrade-state-rollback/v1",
      status: "succeeded",
      restored_sha256: restoredSha256,
      quick_check: "ok",
    };
  } catch (error) {
    return {
      schema_version: "self-upgrade-state-rollback/v1",
      status: "failed",
      error: errorMessage(error),
    };
  }
}

async function preflightStateCutoverCapacity(
  homeDir: string,
  operationId: string,
  migrationGrowthBounds: SelfUpgradeTargetStateReadinessReceipt["pending_migration_growth_bounds"] = [],
): Promise<{
  database_path: string;
  backup_root: string;
  available_bytes: number;
  required_bytes: number;
  snapshot_bytes: number;
  migration_growth_reserve_bytes: number;
  target_declared_migration_growth_bytes: number;
  rollback_allocation_bytes: number;
  same_device: boolean;
  database_parent_identity: SelfUpgradeFilesystemIdentity;
  database_identity: SelfUpgradeFilesystemIdentity;
  backup_root_identity: SelfUpgradeFilesystemIdentity;
}> {
  const paths = resolveStatePaths({ homeDir });
  const metadata = await lstat(paths.dbPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Calyx state database is not a physical regular file: ${paths.dbPath}`);
  }
  const stateDirectory = path.dirname(paths.dbPath);
  const stateDirectoryIdentity = await captureFilesystemIdentity(stateDirectory, "directory");
  const databaseIdentity = await captureFilesystemIdentity(paths.dbPath, "file");
  // Keep the rollback image on the database filesystem. Recovery can then
  // hard-link + atomically rename it without requiring a second physical copy
  // even after target migrations have consumed their admitted growth budget.
  const backupRoot = path.join(stateDirectory, ".self-upgrade-backups", operationId);
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backupRootMetadata = await lstat(backupRoot);
  if (!backupRootMetadata.isDirectory() || backupRootMetadata.isSymbolicLink()) {
    throw new Error(`State snapshot destination is not a physical directory: ${backupRoot}`);
  }
  const backupRootIdentity = await captureFilesystemIdentity(backupRoot, "directory");
  const fileSystem = await statfs(backupRoot);
  const availableBytes = Number(fileSystem.bavail) * Number(fileSystem.bsize);
  const snapshotBytes = metadata.size;
  const targetDeclaredMigrationGrowthBytes = migrationGrowthBounds.reduce(
    (total, bound) => {
      const migrationBytes =
        snapshotBytes * bound.database_size_multiplier
        + bound.fixed_bytes;
      if (!Number.isSafeInteger(migrationBytes)) {
        throw new Error(
          `Target migration ${bound.migration_id} growth bound exceeds safe integer capacity.`,
        );
      }
      return total + migrationBytes;
    },
    0,
  );
  if (!Number.isSafeInteger(targetDeclaredMigrationGrowthBytes)) {
    throw new Error("Aggregate target migration growth bound exceeds safe integer capacity.");
  }
  const migrationGrowthReserveBytes = Math.max(
    targetDeclaredMigrationGrowthBytes,
    STATE_CUTOVER_MINIMUM_GROWTH_RESERVE_BYTES,
  );
  // Rollback itself allocates no database-sized copy: it uses a hard link and
  // same-filesystem rename. The fixed overhead protects directory/WAL metadata.
  const rollbackAllocationBytes = STATE_CUTOVER_FILESYSTEM_OVERHEAD_BYTES;
  const requiredBytes = snapshotBytes
    + migrationGrowthReserveBytes
    + rollbackAllocationBytes;
  const sameDevice = metadata.dev === backupRootMetadata.dev
    && stateDirectoryIdentity.device === backupRootMetadata.dev;
  if (!sameDevice) {
    throw new Error(
      "Rollback-safe state snapshots must be colocated with the database on one filesystem.",
    );
  }
  if (
    !Number.isSafeInteger(availableBytes)
    || availableBytes < requiredBytes
  ) {
    throw new Error(
      `Insufficient capacity for rollback-safe state snapshot: ${availableBytes} bytes available, ${requiredBytes} required.`,
    );
  }
  return {
    database_path: paths.dbPath,
    backup_root: backupRoot,
    available_bytes: availableBytes,
    required_bytes: requiredBytes,
    snapshot_bytes: snapshotBytes,
    migration_growth_reserve_bytes: migrationGrowthReserveBytes,
    target_declared_migration_growth_bytes: targetDeclaredMigrationGrowthBytes,
    rollback_allocation_bytes: rollbackAllocationBytes,
    same_device: sameDevice,
    database_parent_identity: stateDirectoryIdentity,
    database_identity: databaseIdentity,
    backup_root_identity: backupRootIdentity,
  };
}

export async function prepareStateCutoverSnapshot(args: {
  operationId: string;
  homeDir: string;
  migrationGrowthBounds?: SelfUpgradeTargetStateReadinessReceipt["pending_migration_growth_bounds"];
}): Promise<SelfUpgradeStateCutover> {
  const paths = resolveStatePaths({ homeDir: args.homeDir });
  const capacity = await preflightStateCutoverCapacity(
    args.homeDir,
    args.operationId,
    args.migrationGrowthBounds,
  );
  await assertFilesystemIdentityCurrent(capacity.database_parent_identity, "State database parent");
  const backupRoot = capacity.backup_root;
  const backupPath = path.join(backupRoot, "calyx.db");
  const rollbackReservePath = path.join(backupRoot, "rollback-reserve.bin");
  const rollbackCandidatePath = path.join(
    path.dirname(paths.dbPath),
    `.${path.basename(paths.dbPath)}.${args.operationId}.rollback`,
  );
  await rm(backupPath, { force: true });
  await rm(rollbackReservePath, { force: true });
  await rm(rollbackCandidatePath, { force: true });
  await assertFilesystemIdentityCurrent(capacity.backup_root_identity, "State snapshot parent");
  const databaseParentHandle = await open(
    capacity.database_parent_identity.real_path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  let backupParentHandle: Awaited<ReturnType<typeof open>> | undefined;
  let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
  let backupHandle: Awaited<ReturnType<typeof open>> | undefined;
  let snapshotPrepared = false;
  try {
    backupParentHandle = await open(
      capacity.backup_root_identity.real_path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    sourceHandle = await open(
      paths.dbPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    await assertOpenDirectoryCurrent(
      databaseParentHandle,
      capacity.database_parent_identity,
      "State database parent before snapshot",
    );
    await assertOpenDirectoryCurrent(
      backupParentHandle,
      capacity.backup_root_identity,
      "State snapshot parent before snapshot",
    );
    await assertOpenRegularFileCurrent(
      sourceHandle,
      capacity.database_identity,
      "State database before snapshot",
    );
    await checkpointStateDatabase(
      paths.dbPath,
      args.homeDir,
      sourceHandle,
      capacity.database_identity,
    );
    await assertFilesystemIdentityCurrent(
      capacity.database_parent_identity,
      "State database parent",
    );
    await assertOpenDirectoryCurrent(
      databaseParentHandle,
      capacity.database_parent_identity,
      "State database parent after checkpoint",
    );
    await assertOpenRegularFileCurrent(
      sourceHandle,
      capacity.database_identity,
      "State database after checkpoint",
    );
    await assertFilesystemIdentityCurrent(
      capacity.backup_root_identity,
      "State snapshot parent",
    );
    await assertOpenDirectoryCurrent(
      backupParentHandle,
      capacity.backup_root_identity,
      "State snapshot parent before leaf creation",
    );
    backupHandle = await open(
      backupPath,
      fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_RDWR
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const copiedBytes = await copyOpenRegularFile(sourceHandle, backupHandle);
    await backupHandle.sync();
    const backupIdentity = await captureFilesystemIdentity(backupPath, "file");
    await assertOpenRegularFileCurrent(
      backupHandle,
      backupIdentity,
      "State snapshot after copy",
    );
    await assertFilesystemIdentityCurrent(
      capacity.backup_root_identity,
      "State snapshot parent",
    );
    await assertOpenDirectoryCurrent(
      backupParentHandle,
      capacity.backup_root_identity,
      "State snapshot parent after leaf creation",
    );
    await assertStateDatabaseHealthy(backupPath, args.homeDir);
    await assertOpenRegularFileCurrent(
      backupHandle,
      backupIdentity,
      "State snapshot after quick_check",
    );
    await rm(`${backupPath}-wal`, { force: true });
    await rm(`${backupPath}-shm`, { force: true });
    const databaseSha256 = await sha256OpenRegularFile(backupHandle);
    const backupMetadata = await backupHandle.stat();
    if (copiedBytes !== backupMetadata.size) {
      throw new Error(
        `State snapshot copied ${copiedBytes} bytes but retained ${backupMetadata.size}.`,
      );
    }
    await link(backupPath, rollbackCandidatePath);
    const rollbackCandidateIdentity = await captureFilesystemIdentity(
      rollbackCandidatePath,
      "file",
    );
    if (!samePhysicalFile(backupIdentity, rollbackCandidateIdentity)) {
      throw new Error("Pre-created rollback candidate does not pin the state snapshot inode.");
    }
    const rollbackReserve = await allocateRollbackReserve(
      rollbackReservePath,
      capacity.rollback_allocation_bytes,
    );
    await syncDirectoryIdentity(capacity.database_parent_identity);
    await assertOpenDirectoryCurrent(
      databaseParentHandle,
      capacity.database_parent_identity,
      "State database parent after rollback-candidate creation",
    );
    const backupParentIdentity = await assertFilesystemIdentityCurrent(
      capacity.backup_root_identity,
      "State snapshot parent",
    );
    const databaseParentIdentity = await assertFilesystemIdentityCurrent(
      capacity.database_parent_identity,
      "State database parent",
    );
    if (
      backupIdentity.device !== databaseParentIdentity.device
      || backupParentIdentity.device !== databaseParentIdentity.device
      || rollbackCandidateIdentity.device !== databaseParentIdentity.device
      || rollbackReserve.identity.device !== databaseParentIdentity.device
    ) {
      throw new Error("State snapshot moved off the database filesystem.");
    }
    const remainingFileSystem = await statfs(backupRoot);
    const remainingAvailableBytes = Number(remainingFileSystem.bavail) * Number(remainingFileSystem.bsize);
    const remainingRequiredBytes = capacity.migration_growth_reserve_bytes;
    if (
      !Number.isSafeInteger(remainingAvailableBytes)
      || remainingAvailableBytes < remainingRequiredBytes
    ) {
      throw new Error(
        `State snapshot consumed rollback admission: ${remainingAvailableBytes} bytes remain, `
        + `${remainingRequiredBytes} required for bounded target growth after the rollback reserve was allocated.`,
      );
    }
    const snapshot: SelfUpgradeStateSnapshotReceipt = {
      schema_version: "self-upgrade-state-snapshot/v1",
      status: "snapshotted",
      database_path: paths.dbPath,
      backup_path: backupPath,
      database_sha256: databaseSha256,
      size_bytes: backupMetadata.size,
      wal_checkpoint: "truncate",
      quick_check: "ok",
      restore_strategy: "precreated-same-filesystem-hardlink-rename",
      database_parent_identity: databaseParentIdentity,
      backup_identity: backupIdentity,
      backup_parent_identity: backupParentIdentity,
      rollback_candidate_path: rollbackCandidatePath,
      rollback_candidate_identity: rollbackCandidateIdentity,
      rollback_reserve_path: rollbackReservePath,
      rollback_reserve_identity: rollbackReserve.identity,
      rollback_reserve_allocated_bytes: rollbackReserve.allocatedBytes,
      capacity_preflight: {
        available_bytes: capacity.available_bytes,
        required_bytes: capacity.required_bytes,
        same_device: capacity.same_device,
        snapshot_bytes: capacity.snapshot_bytes,
        migration_growth_reserve_bytes: capacity.migration_growth_reserve_bytes,
        target_declared_migration_growth_bytes:
          capacity.target_declared_migration_growth_bytes,
        rollback_allocation_bytes: capacity.rollback_allocation_bytes,
      },
    };
    snapshotPrepared = true;
    let cleaned = false;
    return {
      snapshot,
      async restore() {
        if (cleaned) {
          return {
            schema_version: "self-upgrade-state-rollback/v1",
            status: "failed",
            error: "State snapshot was already cleaned.",
          };
        }
        return restoreStateSnapshot(snapshot, args.homeDir);
      },
      async cleanup() {
        await rm(rollbackCandidatePath, { force: true });
        await rm(backupRoot, { recursive: true, force: true });
        await syncDirectoryIdentity(databaseParentIdentity);
        cleaned = true;
      },
    };
  } finally {
    await backupHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
    await backupParentHandle?.close().catch(() => undefined);
    await databaseParentHandle.close().catch(() => undefined);
    if (!snapshotPrepared) {
      await rm(rollbackCandidatePath, { force: true }).catch(() => undefined);
      await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function defaultSelfUpgradeCutoverRoot(homeDir: string): string {
  return path.join(homeDir, ".calyx", "self-upgrade-cutovers");
}

function defaultSelfUpgradeHandoffRoot(homeDir: string): string {
  return path.join(homeDir, ".calyx", "self-upgrade-handoffs");
}

function isCanonicalSelfUpgradeOperationId(value: string): boolean {
  return /^self-upgrade-[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u.test(value);
}

async function writeTargetHandoff(
  homeDir: string,
  handoff: SelfUpgradeTargetHandoff,
): Promise<string> {
  if (!isCanonicalSelfUpgradeOperationId(handoff.operation_id)) {
    throw new Error("Self-upgrade target handoff has a non-canonical operation id.");
  }
  return writeSelfUpgradeReceiptDurable(
    defaultSelfUpgradeHandoffRoot(homeDir),
    handoff.operation_id,
    `${JSON.stringify(handoff, null, 2)}\n`,
    {
      retentionCount: Number.MAX_SAFE_INTEGER,
      retentionMs: Number.MAX_SAFE_INTEGER,
    },
  );
}

interface LoadedSelfUpgradeTargetHandoff {
  handoff: SelfUpgradeTargetHandoff;
  identity: SelfUpgradeFilesystemIdentity;
  parentIdentity: SelfUpgradeFilesystemIdentity;
  sha256: string;
}

async function readTargetHandoffWithIdentity(
  homeDir: string,
  operationId: string,
): Promise<LoadedSelfUpgradeTargetHandoff> {
  if (!isCanonicalSelfUpgradeOperationId(operationId)) {
    throw new Error("Self-upgrade target entry has a non-canonical operation id.");
  }
  const handoffPath = path.join(defaultSelfUpgradeHandoffRoot(homeDir), `${operationId}.json`);
  const handoffFile = await readRegularFileNoFollowWithIdentity(handoffPath);
  if ((await stat(handoffPath)).mode & 0o077) {
    throw new Error("Self-upgrade target handoff is not owner-only.");
  }
  const parsed = JSON.parse(handoffFile.bytes.toString("utf8")) as Partial<SelfUpgradeTargetHandoff>;
  if (
    parsed.schema_version !== "self-upgrade-target-handoff/v1"
    || parsed.operation_id !== operationId
    || path.basename(handoffPath) !== `${parsed.operation_id}.json`
    || typeof parsed.created_at !== "string"
    || parsed.planner?.handoff_interface !== "self-upgrade-target-handoff/v1"
    || parsed.planner.operation_schema !== "self-upgrade-operation/v1"
    || typeof parsed.planner.entry_realpath !== "string"
    || typeof parsed.planner.node_realpath !== "string"
    || typeof parsed.planner.node_version !== "string"
    || typeof parsed.target?.git_head !== "string"
    || !/^[0-9a-f]{40}$/iu.test(parsed.target.git_head)
    || typeof parsed.target.install_path !== "string"
    || typeof parsed.target.bin_path !== "string"
    || typeof parsed.target.build_info_path !== "string"
    || !isSha256(parsed.target.build_info_sha256)
    || !isSha256(parsed.target.artifact_manifest_sha256)
    || !Array.isArray(parsed.target.artifact_manifest_packages)
    || parsed.target.artifact_manifest_packages.length === 0
    || parsed.target.artifact_manifest_packages.some((entry) => typeof entry !== "string" || !entry)
    || typeof parsed.target.verified_version !== "string"
    || parsed.target.planning_interface !== "self-upgrade-target-planning/v1"
    || parsed.target.startup_contract_interface !== "calyx-startup-contract/v1"
    || typeof parsed.previous_current?.install_path !== "string"
    || typeof parsed.previous_current.git_head !== "string"
    || typeof parsed.previous_current.current_link !== "string"
    || typeof parsed.request?.host !== "string"
    || typeof parsed.request.target_ref !== "string"
    || typeof parsed.request.force !== "boolean"
    || typeof parsed.request.abort_runs !== "boolean"
    || (
      parsed.request.drain_all !== undefined
      && typeof parsed.request.drain_all !== "boolean"
    )
    || typeof parsed.request.continuous !== "boolean"
    || !Number.isSafeInteger(parsed.request.drain_deadline_ms)
    || parsed.request.drain_deadline_ms < 0
    || typeof parsed.request.target_evidence?.target_sha !== "string"
    || parsed.request.target_evidence.target_sha !== parsed.target.git_head
  ) {
    throw new Error(`Invalid authoritative self-upgrade target handoff: ${operationId}.json`);
  }
  await assertFilesystemIdentityCurrent(handoffFile.parentIdentity, "Target handoff parent");
  await assertFilesystemIdentityCurrent(handoffFile.identity, "Target handoff");
  return {
    handoff: parsed as SelfUpgradeTargetHandoff,
    identity: handoffFile.identity,
    parentIdentity: handoffFile.parentIdentity,
    sha256: sha256Bytes(handoffFile.bytes),
  };
}

async function readTargetHandoff(
  homeDir: string,
  operationId: string,
): Promise<SelfUpgradeTargetHandoff> {
  return (await readTargetHandoffWithIdentity(homeDir, operationId)).handoff;
}

async function discoverPendingTargetHandoffs(
  homeDir: string,
): Promise<LoadedSelfUpgradeTargetHandoff[]> {
  const root = defaultSelfUpgradeHandoffRoot(homeDir);
  let rootIdentity: SelfUpgradeFilesystemIdentity;
  try {
    rootIdentity = await captureFilesystemIdentity(root, "directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));
  await assertFilesystemIdentityCurrent(rootIdentity, "Target handoff parent");
  const handoffs: LoadedSelfUpgradeTargetHandoff[] = [];
  for (const entry of entries) {
    const operationId = entry.name.slice(0, -".json".length);
    if (
      !entry.isFile()
      || !isCanonicalSelfUpgradeOperationId(operationId)
      || entry.name !== `${operationId}.json`
    ) {
      throw new Error(`Invalid pending self-upgrade target handoff entry: ${entry.name}`);
    }
    handoffs.push(await readTargetHandoffWithIdentity(homeDir, operationId));
  }
  await assertFilesystemIdentityCurrent(rootIdentity, "Target handoff parent");
  return handoffs;
}

function targetHandoffRecoveryCommand(handoff: SelfUpgradeTargetHandoff): string {
  return [
    `CALYX_SELF_UPGRADE_TARGET_OPERATION_ID=${JSON.stringify(handoff.operation_id)}`,
    JSON.stringify(process.execPath),
    JSON.stringify(handoff.target.bin_path),
    "self upgrade",
    `--host ${JSON.stringify(handoff.request.host)}`,
    "--json",
  ].join(" ");
}

async function removeTargetHandoff(
  homeDir: string,
  operationId: string,
  expected?: LoadedSelfUpgradeTargetHandoff,
): Promise<void> {
  if (!isCanonicalSelfUpgradeOperationId(operationId)) {
    throw new Error("Refusing to remove a target handoff with a non-canonical operation id.");
  }
  const root = defaultSelfUpgradeHandoffRoot(homeDir);
  const handoffPath = path.join(root, `${operationId}.json`);
  const rootIdentity = expected?.parentIdentity
    ? await assertFilesystemIdentityCurrent(expected.parentIdentity, "Target handoff parent")
    : await captureFilesystemIdentity(root, "directory");
  const handoffFile = await readRegularFileNoFollowWithIdentity(handoffPath);
  if (
    expected
    && (
      !sameFilesystemIdentity(handoffFile.parentIdentity, expected.parentIdentity)
      || !sameFilesystemIdentity(handoffFile.identity, expected.identity)
      || sha256Bytes(handoffFile.bytes) !== expected.sha256
    )
  ) {
    throw new Error(`Target handoff ${operationId} changed after recovery authority was accepted.`);
  }
  await assertFilesystemIdentityCurrent(rootIdentity, "Target handoff parent");
  await assertFilesystemIdentityCurrent(handoffFile.identity, "Target handoff");
  await rm(handoffPath, { force: true });
  await assertFilesystemIdentityCurrent(rootIdentity, "Target handoff parent");
  const rootHandle = await open(rootIdentity.real_path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    await rootHandle.sync();
  } finally {
    await rootHandle.close();
  }
}

async function assertHandoffMatchesExhaustedCutover(
  loadedHandoff: LoadedSelfUpgradeTargetHandoff,
  journal: SelfUpgradeCutoverJournal,
): Promise<void> {
  const handoff = loadedHandoff.handoff;
  const acceptance = journal.target_acceptance;
  const expectedTargetBin = resolveCalyxInstallBinPath(journal.target_install_path);
  const expectedBuildInfo = resolveCalyxInstallBuildInfoPath(journal.target_install_path);
  const mismatch =
    handoff.operation_id !== journal.operation_id
    || normalizeHostAlias(handoff.request.host) !== normalizeHostAlias(journal.host)
    || handoff.target.git_head !== journal.supervisor_readiness.target_git_head
    || handoff.request.target_evidence.target_sha !== handoff.target.git_head
    || path.resolve(handoff.target.install_path) !== path.resolve(journal.target_install_path)
    || path.resolve(handoff.target.build_info_path) !== path.resolve(expectedBuildInfo)
    || handoff.previous_current.git_head !== journal.previous_git_head
    || path.resolve(handoff.previous_current.install_path)
      !== path.resolve(journal.previous_install_path)
    || path.resolve(handoff.previous_current.current_link) !== path.resolve(journal.current_link)
    || !acceptance
    || acceptance.operation_id !== handoff.operation_id
    || acceptance.target_git_head !== handoff.target.git_head
    || acceptance.target_build_info_sha256 !== handoff.target.build_info_sha256
    || acceptance.target_artifact_manifest_sha256 !== handoff.target.artifact_manifest_sha256
    || acceptance.target_artifact_manifest_packages.join("\0")
      !== handoff.target.artifact_manifest_packages.join("\0");
  if (mismatch) {
    throw new Error(
      `Pending self-upgrade ${handoff.operation_id} handoff and exhausted cutover authority disagree.`,
    );
  }
  const [handoffInstall, journalInstall, handoffBin, expectedBin, acceptedBin] = await Promise.all([
    realpath(handoff.target.install_path),
    realpath(journal.target_install_path),
    realpath(handoff.target.bin_path),
    realpath(expectedTargetBin),
    realpath(acceptance.executor_realpath),
  ]);
  if (
    handoffInstall !== journalInstall
    || handoffBin !== expectedBin
    || handoffBin !== acceptedBin
  ) {
    throw new Error(
      `Pending self-upgrade ${handoff.operation_id} physical target authority changed.`,
    );
  }
}

async function acceptTargetHandoff(
  handoff: SelfUpgradeTargetHandoff,
  now: () => string,
): Promise<SelfUpgradeTargetAcceptanceReceipt> {
  const executorRealPath = await realpath(process.argv[1] ?? "");
  const nodeRealPath = await realpath(process.execPath);
  if (executorRealPath !== await realpath(handoff.target.bin_path)) {
    throw new Error(
      `Prepared target entry mismatch: executing ${executorRealPath}, expected ${handoff.target.bin_path}.`,
    );
  }
  if (
    nodeRealPath !== handoff.planner.node_realpath
    || process.version !== handoff.planner.node_version
  ) {
    throw new Error(
      `Prepared target Node identity mismatch: executing ${nodeRealPath} ${process.version}, `
      + `expected ${handoff.planner.node_realpath} ${handoff.planner.node_version}.`,
    );
  }
  const installIdentity = await captureFilesystemIdentity(handoff.target.install_path, "directory");
  const installsRootIdentity = await captureFilesystemIdentity(
    path.dirname(handoff.previous_current.current_link),
    "directory",
  );
  if (installIdentity.device !== installsRootIdentity.device) {
    throw new Error("Prepared target entry changed install filesystems.");
  }
  const build = await readInstallBuildInfo(handoff.target.install_path);
  if (build.git_head !== handoff.target.git_head) {
    throw new Error("Prepared target build identity changed before handoff acceptance.");
  }
  if (
    await sha256RegularFileNoFollow(handoff.target.build_info_path)
      !== handoff.target.build_info_sha256
  ) {
    throw new Error("Prepared target build-info bytes changed before handoff acceptance.");
  }
  const artifactManifest = await computeCalyxOwnedArtifactManifest(
    handoff.target.install_path,
    handoff.target.artifact_manifest_packages.map((name) => ({ name, relativePath: "" })),
  );
  if (artifactManifest !== handoff.target.artifact_manifest_sha256) {
    throw new Error("Prepared target Calyx-owned artifact manifest changed before handoff acceptance.");
  }
  const currentInstall = await readCurrentInstallTarget(path.dirname(handoff.previous_current.current_link));
  const currentInstallRealPath = currentInstall ? await realpath(currentInstall) : undefined;
  if (
    !currentInstallRealPath
    || (
      currentInstallRealPath !== await realpath(handoff.previous_current.install_path)
      && currentInstallRealPath !== await realpath(handoff.target.install_path)
    )
  ) {
    throw new Error("Current install changed during target handoff; fresh target planning is required.");
  }
  return {
    schema_version: "self-upgrade-target-acceptance/v1",
    status: "accepted",
    operation_id: handoff.operation_id,
    executor_realpath: executorRealPath,
    node_realpath: nodeRealPath,
    node_version: process.version,
    target_git_head: handoff.target.git_head,
    target_build_info_sha256: handoff.target.build_info_sha256,
    target_artifact_manifest_sha256: handoff.target.artifact_manifest_sha256,
    target_artifact_manifest_packages: [...handoff.target.artifact_manifest_packages],
    handoff_interface: "self-upgrade-target-handoff/v1",
    planning_interface: "self-upgrade-target-planning/v1",
    startup_contract_interface: "calyx-startup-contract/v1",
    accepted_at: now(),
  };
}

export interface SelfUpgradeTargetEnvironmentDependencies {
  env?: NodeJS.ProcessEnv;
}

/**
 * Build the non-secret launch environment for the prepared target process.
 *
 * The child is not a general descendant of the invoking shell. It receives a
 * small runtime allowlist and the operation id only. In particular, no secret
 * name or value crosses this process boundary. After accepting the exact
 * handoff, the target resolves its own host-scoped custody directly from the
 * canonical Polli secret files.
 */
export async function buildSelfUpgradeTargetEnvironment(
  handoff: SelfUpgradeTargetHandoff,
  dependencies: SelfUpgradeTargetEnvironmentDependencies = {},
): Promise<NodeJS.ProcessEnv> {
  const sourceEnv = dependencies.env ?? process.env;
  const childEnv: NodeJS.ProcessEnv = {};
  for (const name of SELF_UPGRADE_TARGET_NON_SECRET_ENV_ALLOWLIST) {
    const value = sourceEnv[name];
    if (value !== undefined) {
      childEnv[name] = value;
    }
  }
  childEnv.CALYX_SELF_UPGRADE_TARGET_OPERATION_ID = handoff.operation_id;
  return childEnv;
}

const POLLI_SECRET_ASSIGNMENT_PATTERN =
  /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u;

function parsePolliSecretValue(rawValue: string, label: string): string {
  const value = rawValue.trim();
  if (!value) return "";
  if (value.startsWith("'")) {
    if (value.length === 1 || !value.endsWith("'")) {
      throw new Error(`${label} has an unterminated single-quoted value.`);
    }
    return value.slice(1, -1);
  }
  if (value.startsWith("\"")) {
    if (value.length === 1 || !value.endsWith("\"")) {
      throw new Error(`${label} has an unterminated double-quoted value.`);
    }
    return value.slice(1, -1).replace(/\\([\\"nrt])/gu, (_match, escaped: string) => ({
      "\\": "\\",
      "\"": "\"",
      n: "\n",
      r: "\r",
      t: "\t",
    })[escaped] ?? escaped);
  }
  // Unquoted values are inert literal text. Shell expansion, command
  // substitution, tilde expansion, and inline comments never execute.
  return value;
}

function parsePolliSecretSource(text: string, sourcePath: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const match = POLLI_SECRET_ASSIGNMENT_PATTERN.exec(line);
    if (!match) {
      throw new Error(
        `${sourcePath}:${index + 1} must be KEY=VALUE or export KEY=VALUE.`,
      );
    }
    const name = match[1]!;
    if (values.has(name)) {
      throw new Error(`${sourcePath}:${index + 1} duplicates ${name}.`);
    }
    values.set(name, parsePolliSecretValue(match[2]!, `${sourcePath}:${index + 1}`));
  }
  return values;
}

function sameSecretSourceStat(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  );
}

async function readCanonicalPolliSecretSource(
  sourcePath: string,
): Promise<Map<string, string>> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      sourcePath,
      fsConstants.O_RDONLY
        | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Map();
    }
    throw new Error(`Unable to open canonical Polli secret source safely: ${sourcePath}.`, {
      cause: error,
    });
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new Error(`Canonical Polli secret source is not a regular file: ${sourcePath}.`);
    }
    if ((before.mode & BigInt(0o077)) !== BigInt(0)) {
      throw new Error(
        `Canonical Polli secret source must not be group/world accessible: ${sourcePath}.`,
      );
    }
    if (
      typeof process.getuid === "function"
      && before.uid !== BigInt(process.getuid())
    ) {
      throw new Error(`Canonical Polli secret source is not owned by this user: ${sourcePath}.`);
    }
    const text = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat({ bigint: true });
    if (!sameSecretSourceStat(before, after)) {
      throw new Error(`Canonical Polli secret source changed while being read: ${sourcePath}.`);
    }
    return parsePolliSecretSource(text, sourcePath);
  } finally {
    await handle.close();
  }
}

export interface SelfUpgradeTargetCredentialDependencies {
  homeDir?: () => string;
  env?: NodeJS.ProcessEnv;
  resolveAgentsInfraRoot?: typeof resolveAgentsInfraRoot;
  readHostsTruth?: typeof readHostsTruth;
}

/**
 * Resolve the accepted target's exact host credential custody from canonical
 * source files. The returned map contains only the truth-derived server set
 * and the selected outbound operator token; callers must not serialize it.
 */
export async function resolveAcceptedTargetCredentialEnvironment(
  handoff: SelfUpgradeTargetHandoff,
  dependencies: SelfUpgradeTargetCredentialDependencies = {},
): Promise<NodeJS.ProcessEnv> {
  const sourceEnv = dependencies.env ?? process.env;
  const homeDir = (dependencies.homeDir ?? (() => homedir()))();
  const configHome = sourceEnv.XDG_CONFIG_HOME?.trim()
    ? path.resolve(sourceEnv.XDG_CONFIG_HOME)
    : path.join(homeDir, ".config");
  const agentsInfraRoot = await (
    dependencies.resolveAgentsInfraRoot ?? resolveAgentsInfraRoot
  )();
  if (!agentsInfraRoot) {
    throw new Error(
      `Accepted target ${handoff.operation_id} cannot resolve agents-infra credential truth for ${handoff.request.host}.`,
    );
  }
  const hostsTruth = await (
    dependencies.readHostsTruth ?? readHostsTruth
  )(agentsInfraRoot);
  const hostEntry = hostsTruth.hosts?.[handoff.request.host];
  const rows = hostEntry?.consumer_api_credentials;
  if (!rows || rows.length === 0) {
    throw new Error(
      `Accepted target ${handoff.operation_id} has no credential truth for ${handoff.request.host}.`,
    );
  }
  const serverContract = resolveConsumerApiCredentialEnvContract(
    handoff.request.host,
    rows,
  );
  if (!serverContract) {
    throw new Error(
      `Accepted target ${handoff.operation_id} cannot derive the ${handoff.request.host} server credential custody set.`,
    );
  }
  const operatorRow = rows.find(
    (row) => row.client_id === "operator_cli" && row.outbound,
  );
  if (!operatorRow) {
    throw new Error(
      `Accepted target ${handoff.operation_id} has no selected operator_cli credential for ${handoff.request.host}.`,
    );
  }
  const requiredNames = new Set([
    ...serverContract.allowed_secret_env,
    operatorRow.token_env,
  ]);
  const sourceValues = new Map<string, string>();
  for (const sourcePath of [
    path.join(configHome, "polli", "secrets.env"),
    path.join(configHome, "polli", "secrets.d", `${handoff.request.host}.env`),
  ]) {
    for (const [name, value] of await readCanonicalPolliSecretSource(sourcePath)) {
      sourceValues.set(name, value);
    }
  }

  const projected: NodeJS.ProcessEnv = {};
  for (const name of [...requiredNames].sort()) {
    const value = sourceValues.get(name);
    if (value === undefined || value.length === 0) {
      throw new Error(
        `Accepted target ${handoff.operation_id} is missing canonical host credential ${name}.`,
      );
    }
    projected[name] = value;
  }
  // Validate the projected values against the same canonical consumers that
  // will use them. These checks never read or name excluded source values.
  resolveConsumerApiCredentialVerifiers(
    handoff.request.host,
    hostEntry,
    projected,
  );
  resolveConsumerApiClientToken(
    handoff.request.host,
    hostEntry,
    `daemon:${handoff.request.host}`,
    projected,
  );
  if (!resolveTokenForHost(handoff.request.host, hostsTruth, projected)) {
    throw new Error(
      `Accepted target ${handoff.operation_id} cannot resolve its operator_cli credential.`,
    );
  }
  return projected;
}

function installAcceptedTargetCredentialEnvironment(
  projected: NodeJS.ProcessEnv,
): () => void {
  const touchedNames = new Set([
    ...Object.keys(process.env).filter(isConsumerApiSecretEnvName),
    ...Object.keys(projected),
  ]);
  const previous = new Map<string, string | undefined>();
  for (const name of touchedNames) {
    previous.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(projected)) {
    if (value !== undefined) process.env[name] = value;
  }
  return () => {
    for (const name of touchedNames) {
      const value = previous.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

async function defaultRunTargetOwnedUpgrade(
  handoff: SelfUpgradeTargetHandoff,
): Promise<SelfUpgradeResult> {
  const args = [
    handoff.target.bin_path,
    "self",
    "upgrade",
    "--host",
    handoff.request.host,
    "--to",
    handoff.request.target_ref,
    "--target-sha",
    handoff.request.target_evidence.target_sha,
    "--target-fetch-remote",
    handoff.request.target_evidence.fetch_remote,
    "--target-fetch-ref",
    handoff.request.target_evidence.fetch_ref,
    "--drain-deadline",
    `${handoff.request.drain_deadline_ms}`,
    "--json",
    ...(handoff.request.force ? ["--force"] : []),
    ...(handoff.request.abort_runs ? ["--abort-runs"] : []),
    ...(handoff.request.drain_all ? ["--drain-all"] : []),
  ];
  const childEnv = await buildSelfUpgradeTargetEnvironment(handoff);
  const child = spawnChild(process.execPath, args, {
    cwd: path.parse(handoff.target.install_path).root,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  const stdoutLimit = 4 * 1024 * 1024;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (stdout.length < stdoutLimit) {
      stdout += chunk.slice(0, stdoutLimit - stdout.length);
    }
  });
  child.stderr?.pipe(process.stderr, { end: false });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  let envelope: SelfUpgradeTargetProcessEnvelope;
  try {
    envelope = JSON.parse(stdout) as SelfUpgradeTargetProcessEnvelope;
  } catch {
    throw new Error(`Prepared target did not return one valid target-process envelope (exit ${exitCode}).`);
  }
  if (
    envelope.schema_version !== "self-upgrade-target-process-result/v1"
    || envelope.operation_id !== handoff.operation_id
  ) {
    throw new Error("Prepared target process result is not bound to the handoff operation.");
  }
  if (exitCode !== 0 || envelope.failure) {
    const failure = envelope.failure;
    throw createSelfUpgradeError(
      failure?.error ?? `Prepared target exited ${exitCode}.`,
      failure?.exit_code ?? exitCode,
      {
        ...(failure?.plan ? { plan: failure.plan } : {}),
        ...(failure?.receipt_path ? { receipt_path: failure.receipt_path } : {}),
        ...(failure?.receipt ? { receipt: failure.receipt } : {}),
      },
    );
  }
  if (!envelope.result || envelope.result.operation_id !== handoff.operation_id) {
    throw new Error("Prepared target process omitted its authoritative operation result.");
  }
  return envelope.result;
}

export async function writeCutoverJournal(
  root: string,
  journal: SelfUpgradeCutoverJournal,
): Promise<string> {
  if (!isCanonicalSelfUpgradeOperationId(journal.operation_id)) {
    throw new Error("Self-upgrade cutover journal has a non-canonical operation id.");
  }
  return writeSelfUpgradeReceiptDurable(
    root,
    journal.operation_id,
    `${JSON.stringify(journal, null, 2)}\n`,
    {
      // Active cutovers are authority, not retained historical receipts.
      retentionCount: Number.MAX_SAFE_INTEGER,
      retentionMs: Number.MAX_SAFE_INTEGER,
    },
  );
}

async function removeCutoverJournal(
  root: string,
  operationId: string,
  options: {
    removeArtifacts?: boolean;
    expectedJournalIdentity?: SelfUpgradeFilesystemIdentity;
    expectedRootIdentity?: SelfUpgradeFilesystemIdentity;
  } = {},
): Promise<void> {
  if (!isCanonicalSelfUpgradeOperationId(operationId)) {
    throw new Error("Refusing to remove a cutover journal with a non-canonical operation id.");
  }
  const journalPath = path.join(root, `${operationId}.json`);
  const rootIdentity = options.expectedRootIdentity
    ? await assertFilesystemIdentityCurrent(options.expectedRootIdentity, "Cutover journal root")
    : await captureFilesystemIdentity(root, "directory");
  const journalIdentity = options.expectedJournalIdentity
    ? await assertFilesystemIdentityCurrent(options.expectedJournalIdentity, "Cutover journal")
    : await captureFilesystemIdentity(journalPath, "file");
  await assertFilesystemIdentityCurrent(rootIdentity, "Cutover journal root");
  await assertFilesystemIdentityCurrent(journalIdentity, "Cutover journal");
  await rm(journalPath, { force: true });
  await assertFilesystemIdentityCurrent(rootIdentity, "Cutover journal root");
  const handle = await open(rootIdentity.real_path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (options.removeArtifacts !== false) {
    await rm(path.join(root, operationId), { recursive: true, force: true });
  }
}

interface LoadedSelfUpgradeCutoverJournal {
  journal: SelfUpgradeCutoverJournal;
  journalIdentity: SelfUpgradeFilesystemIdentity;
  rootIdentity: SelfUpgradeFilesystemIdentity;
}

async function listCutoverJournals(
  homeDir: string,
): Promise<LoadedSelfUpgradeCutoverJournal[]> {
  const root = defaultSelfUpgradeCutoverRoot(homeDir);
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    const typed = error as NodeJS.ErrnoException;
    if (typed.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  if (entries.length === 0) {
    return [];
  }
  const rootIdentity = await captureFilesystemIdentity(root, "directory");
  const journals: LoadedSelfUpgradeCutoverJournal[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const journalPath = path.join(root, entry.name);
    const journalFile = await readRegularFileNoFollowWithIdentity(journalPath);
    if (!sameFilesystemIdentity(journalFile.parentIdentity, rootIdentity)) {
      throw new Error(`Invalid authoritative self-upgrade cutover journal parent: ${entry.name}`);
    }
    const parsed = JSON.parse(journalFile.bytes.toString("utf8")) as Partial<SelfUpgradeCutoverJournal>;
    const expectedBasename = typeof parsed.operation_id === "string"
      ? `${parsed.operation_id}.json`
      : "";
    if (
      parsed.schema_version !== "self-upgrade-cutover-journal/v1"
      || typeof parsed.operation_id !== "string"
      || !isCanonicalSelfUpgradeOperationId(parsed.operation_id)
      || entry.name !== expectedBasename
      || typeof parsed.host !== "string"
      || typeof parsed.updated_at !== "string"
      || !SELF_UPGRADE_CUTOVER_JOURNAL_PHASES.includes(
        parsed.phase as SelfUpgradeCutoverJournalPhase,
      )
      || typeof parsed.previous_install_path !== "string"
      || typeof parsed.previous_git_head !== "string"
      || typeof parsed.current_link !== "string"
      || typeof parsed.wrapper_path !== "string"
      || typeof parsed.target_install_path !== "string"
      || !Array.isArray(parsed.descriptors)
      || parsed.descriptors.length === 0
      || parsed.descriptors.some((descriptor) =>
        !descriptor
        || descriptor.schema_version !== "calyx-daemon/v1"
        || typeof descriptor.daemon_id !== "string"
        || !descriptor.supervisor
        || (
          descriptor.supervisor.kind !== "systemd"
          && descriptor.supervisor.kind !== "launchd"
          && descriptor.supervisor.kind !== "direct"
        ))
      || !Array.isArray(parsed.plan_daemons)
      || parsed.plan_daemons.length === 0
      || parsed.plan_daemons.some((daemon) =>
        !daemon
        || typeof daemon.daemon_id !== "string"
        || typeof daemon.runs_root !== "string"
        || typeof daemon.health_url !== "string"
        || !daemon.supervisor
        || !daemon.build
        || typeof daemon.build.git_head !== "string")
      || (
        parsed.maintenance_before !== undefined
        && (
          !Array.isArray(parsed.maintenance_before)
          || parsed.maintenance_before.length !== parsed.plan_daemons.length
          || parsed.maintenance_before.some((entry) =>
            !entry
            || typeof entry.daemon_id !== "string"
            || typeof entry.enabled !== "boolean")
        )
      )
      || (
        parsed.target_acceptance !== undefined
        && (
          parsed.target_acceptance.schema_version !== "self-upgrade-target-acceptance/v1"
          || parsed.target_acceptance.status !== "accepted"
          || parsed.target_acceptance.operation_id !== parsed.operation_id
          || typeof parsed.target_acceptance.executor_realpath !== "string"
          || typeof parsed.target_acceptance.node_realpath !== "string"
          || typeof parsed.target_acceptance.node_version !== "string"
          || parsed.target_acceptance.target_git_head !== parsed.supervisor_readiness?.target_git_head
          || !isSha256(parsed.target_acceptance.target_build_info_sha256)
          || !isSha256(parsed.target_acceptance.target_artifact_manifest_sha256)
          || !Array.isArray(parsed.target_acceptance.target_artifact_manifest_packages)
          || parsed.target_acceptance.target_artifact_manifest_packages.length === 0
          || parsed.target_acceptance.target_artifact_manifest_packages.some(
            (entry) => typeof entry !== "string" || !entry,
          )
          || parsed.target_acceptance.handoff_interface !== "self-upgrade-target-handoff/v1"
          || parsed.target_acceptance.planning_interface !== "self-upgrade-target-planning/v1"
          || parsed.target_acceptance.startup_contract_interface !== "calyx-startup-contract/v1"
          || typeof parsed.target_acceptance.accepted_at !== "string"
        )
      )
      || !parsed.supervisor_readiness
      || parsed.supervisor_readiness.schema_version !== "self-upgrade-supervisor-readiness/v1"
      || typeof parsed.supervisor_readiness.target_git_head !== "string"
      || !/^[0-9a-f]{40}$/iu.test(parsed.supervisor_readiness.target_git_head)
      || (
        parsed.supervisor_readiness.previous_service_sha256 !== undefined
        && !isSha256(parsed.supervisor_readiness.previous_service_sha256)
      )
      || (
        parsed.supervisor_readiness.target_effective_config_sha256 !== undefined
        && !isSha256(parsed.supervisor_readiness.target_effective_config_sha256)
      )
      || (
        parsed.supervisor_readiness.restored_effective_config_sha256 !== undefined
        && !isSha256(parsed.supervisor_readiness.restored_effective_config_sha256)
      )
      || (
        parsed.supervisor_readiness.previous_service_identity !== undefined
        && !isFilesystemIdentity(parsed.supervisor_readiness.previous_service_identity, "file")
      )
      || (
        parsed.supervisor_readiness.previous_service_parent_identity !== undefined
        && !isFilesystemIdentity(parsed.supervisor_readiness.previous_service_parent_identity, "directory")
      )
      || (
        parsed.supervisor_readiness.previous_service_backup_identity !== undefined
        && !isFilesystemIdentity(parsed.supervisor_readiness.previous_service_backup_identity, "file")
      )
      || (
        parsed.supervisor_readiness.previous_service_backup_parent_identity !== undefined
        && !isFilesystemIdentity(parsed.supervisor_readiness.previous_service_backup_parent_identity, "directory")
      )
      || (
        parsed.state_snapshot !== undefined
        && (
          parsed.state_snapshot.schema_version !== "self-upgrade-state-snapshot/v1"
          || parsed.state_snapshot.status !== "snapshotted"
          || !isSha256(parsed.state_snapshot.database_sha256)
          || !Number.isSafeInteger(parsed.state_snapshot.size_bytes)
          || (
            parsed.state_snapshot.database_parent_identity !== undefined
            && !isFilesystemIdentity(parsed.state_snapshot.database_parent_identity, "directory")
          )
          || (
            parsed.state_snapshot.backup_identity !== undefined
            && !isFilesystemIdentity(parsed.state_snapshot.backup_identity, "file")
          )
          || (
            parsed.state_snapshot.backup_parent_identity !== undefined
            && !isFilesystemIdentity(parsed.state_snapshot.backup_parent_identity, "directory")
          )
        )
      )
    ) {
      throw new Error(`Invalid authoritative self-upgrade cutover journal: ${entry.name}`);
    }
    await assertFilesystemIdentityCurrent(rootIdentity, "Cutover journal root");
    await assertFilesystemIdentityCurrent(journalFile.identity, "Cutover journal");
    journals.push({
      journal: parsed as SelfUpgradeCutoverJournal,
      journalIdentity: journalFile.identity,
      rootIdentity,
    });
  }
  return journals.sort((left, right) =>
    left.journal.operation_id.localeCompare(right.journal.operation_id));
}

async function defaultRunSupervisorStage(args: {
  agentsInfraRoot: string;
  host: string;
  preparedInstall: VersionedInstallReceipt;
}): Promise<CommandResult> {
  const scriptPath = path.join(args.agentsInfraRoot, "scripts", "calyx-run-service.mjs");
  try {
    const result = await execFile(process.execPath, [
      scriptPath,
      "--stage",
      "--host",
      args.host,
      "--prepared-install",
      args.preparedInstall.install_path,
      "--json",
    ], { env: process.env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const typed = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof typed.code === "number" ? typed.code : 1,
      stdout: typed.stdout ?? "",
      stderr: typed.stderr ?? typed.message ?? "canonical supervisor stage failed",
    };
  }
}

async function runTargetStateCommand(
  preparedInstall: VersionedInstallReceipt,
  mode: "--plan" | "--apply",
): Promise<CommandResult> {
  try {
    const result = await execFile(
      preparedInstall.bin_path,
      ["state", "migrate", mode, "--json"],
      { env: process.env },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const typed = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof typed.code === "number" ? typed.code : 1,
      stdout: typed.stdout ?? "",
      stderr: typed.stderr ?? typed.message ?? `target state migration ${mode} failed`,
    };
  }
}

/** Read the target's migration plan against the live store. Never writes. */
async function defaultRunTargetStatePlan(
  preparedInstall: VersionedInstallReceipt,
): Promise<CommandResult> {
  return runTargetStateCommand(preparedInstall, "--plan");
}

/**
 * Bring the live store to the target's schema, executed by the *prepared*
 * install rather than the promoted one: the cutover owns the migration, so it
 * runs while daemons are stopped and before promotion, not as a side effect of
 * whichever process happens to open the store next.
 */
async function defaultRunTargetStateMigrate(
  preparedInstall: VersionedInstallReceipt,
): Promise<CommandResult> {
  return runTargetStateCommand(preparedInstall, "--apply");
}

export function assertTargetStateSchemaReady(
  result: CommandResult,
  targetGitHead: string,
): SelfUpgradeTargetStateReadinessReceipt {
  if (result.code !== 0) {
    throw new Error(
      `Target state-schema preflight failed: ${commandDetail(result) || `exit ${result.code}`}. `
      + "Run the target's `calyx state migrate --plan`, review it, then apply it with rollback authority before retrying.",
    );
  }
  let plan: unknown;
  try {
    plan = JSON.parse(result.stdout);
  } catch {
    throw new Error("Target state-schema preflight returned invalid JSON; refusing supervisor installation.");
  }
  const typed = plan as {
    driver?: unknown;
    current?: unknown;
    target?: unknown;
    ledgerExists?: unknown;
    applied?: unknown;
    pending?: unknown;
  };
  if (
    typeof typed.driver !== "string"
    || !typed.driver.trim()
    || (typed.current !== null && typeof typed.current !== "string")
    || (typed.target !== null && typeof typed.target !== "string")
    || typeof typed.ledgerExists !== "boolean"
    || !Array.isArray(typed.applied)
    || !Array.isArray(typed.pending)
  ) {
    throw new Error("Target state-schema preflight omitted its typed driver/current/target/ledger migration contract.");
  }
  const readEntries = (
    values: unknown[],
    expectedStatus: "applied" | "pending",
  ): Array<{
    id: string;
    growthBound?: {
      databaseSizeMultiplier: number;
      fixedBytes: number;
    };
  }> => values.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Target state-schema ${expectedStatus}[${index}] is not an object.`);
    }
    const candidate = entry as {
      id?: unknown;
      description?: unknown;
      status?: unknown;
      appliedAt?: unknown;
      growthBound?: {
        databaseSizeMultiplier?: unknown;
        fixedBytes?: unknown;
      };
    };
    if (
      typeof candidate.id !== "string"
      || !/^\d{4}$/u.test(candidate.id)
      || typeof candidate.description !== "string"
      || !candidate.description.trim()
      || (
        expectedStatus === "pending"
          ? candidate.status !== "pending"
          : typeof candidate.appliedAt !== "string" || !candidate.appliedAt.trim()
      )
    ) {
      throw new Error(`Target state-schema ${expectedStatus}[${index}] is malformed.`);
    }
    if (expectedStatus === "pending") {
      const multiplier = candidate.growthBound?.databaseSizeMultiplier;
      const fixedBytes = candidate.growthBound?.fixedBytes;
      if (
        typeof multiplier !== "number"
        || !Number.isSafeInteger(multiplier)
        || multiplier < 0
        || multiplier > 64
        || typeof fixedBytes !== "number"
        || !Number.isSafeInteger(fixedBytes)
        || fixedBytes < 0
      ) {
        throw new Error(
          `Target state-schema pending[${index}] lacks a bounded migration growth declaration.`,
        );
      }
      return {
        id: candidate.id,
        growthBound: {
          databaseSizeMultiplier: multiplier,
          fixedBytes,
        },
      };
    }
    return { id: candidate.id };
  });
  const appliedEntries = readEntries(typed.applied, "applied");
  const pendingEntries = readEntries(typed.pending, "pending");
  const appliedIds = appliedEntries.map((entry) => entry.id);
  const pendingIds = pendingEntries.map((entry) => entry.id);
  const allIds = [...appliedIds, ...pendingIds];
  if (new Set(allIds).size !== allIds.length) {
    throw new Error("Target state-schema preflight contains duplicate migration ids.");
  }
  for (let index = 0; index < allIds.length; index += 1) {
    const expected = String(index + 1).padStart(4, "0");
    if (allIds[index] !== expected) {
      throw new Error(
        `Target state-schema preflight is not one contiguous source/ledger sequence: expected ${expected}, got ${allIds[index] ?? "(none)"}.`,
      );
    }
  }
  const expectedCurrent = appliedIds.at(-1) ?? null;
  const expectedTarget = allIds.at(-1) ?? null;
  if (
    typed.current !== expectedCurrent
    || typed.target !== expectedTarget
    || (typed.ledgerExists ? appliedIds.length === 0 : appliedIds.length > 0)
  ) {
    throw new Error(
      "Target state-schema preflight has source/ledger drift across ledgerExists, current, target, applied, and pending.",
    );
  }
  return {
    schema_version: "self-upgrade-target-state-readiness/v1",
    status: "ready",
    target_git_head: targetGitHead,
    driver: typed.driver,
    current: typed.current,
    target: typed.target,
    ledger_exists: typed.ledgerExists,
    applied_migrations: appliedIds,
    pending_migrations: pendingIds,
    pending_migration_growth_bounds: pendingEntries.map((entry) => ({
      migration_id: entry.id,
      database_size_multiplier: entry.growthBound!.databaseSizeMultiplier,
      fixed_bytes: entry.growthBound!.fixedBytes,
    })),
  };
}

/**
 * Accept the cutover's migration step only when the target applied exactly the
 * migrations the readiness preflight admitted growth for, and converged. An
 * apply that ran migrations outside the admitted set escaped the capacity
 * reserve, so it is a failure even though the ledger moved forward.
 */
export function assertTargetStateSchemaMigrated(
  result: CommandResult,
  targetGitHead: string,
  readiness: SelfUpgradeTargetStateReadinessReceipt,
): SelfUpgradeTargetStateMigratedReceipt {
  if (result.code !== 0) {
    throw new Error(
      `Target state migration failed: ${commandDetail(result) || `exit ${result.code}`}. `
      + "The rollback-safe state snapshot is still pinned; no binary or supervisor change has been made.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Target state migration returned invalid JSON; refusing to promote the target.");
  }
  const typed = parsed as {
    driver?: unknown;
    applied?: unknown;
    alreadyApplied?: unknown;
    current?: unknown;
    target?: unknown;
  };
  if (
    typeof typed.driver !== "string"
    || !typed.driver.trim()
    || typed.driver !== readiness.driver
    || !Array.isArray(typed.applied)
    || !Array.isArray(typed.alreadyApplied)
    || typeof typed.current !== "string"
    || typeof typed.target !== "string"
  ) {
    throw new Error("Target state migration omitted its typed driver/applied/current/target contract.");
  }
  const readAppliedIds = (values: unknown[], field: string): string[] => values.map((entry, index) => {
    const candidate = entry as { id?: unknown; description?: unknown; appliedAt?: unknown };
    if (
      !entry
      || typeof entry !== "object"
      || typeof candidate.id !== "string"
      || !/^\d{4}$/u.test(candidate.id)
      || typeof candidate.description !== "string"
      || !candidate.description.trim()
      || typeof candidate.appliedAt !== "string"
      || !candidate.appliedAt.trim()
    ) {
      throw new Error(`Target state migration ${field}[${index}] is malformed.`);
    }
    return candidate.id;
  });
  const appliedIds = readAppliedIds(typed.applied, "applied");
  const alreadyAppliedIds = readAppliedIds(typed.alreadyApplied, "alreadyApplied");
  const sameSequence = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((entry, index) => entry === right[index]);
  if (!sameSequence(appliedIds, readiness.pending_migrations)) {
    throw new Error(
      "Target state migration executed migrations outside its admitted growth reserve "
      + `(applied=${appliedIds.join(",") || "none"}, admitted=${readiness.pending_migrations.join(",") || "none"}).`,
    );
  }
  if (!sameSequence(alreadyAppliedIds, readiness.applied_migrations)) {
    throw new Error(
      "Target state migration observed a different pre-existing ledger than the readiness preflight "
      + `(observed=${alreadyAppliedIds.join(",") || "none"}, expected=${readiness.applied_migrations.join(",") || "none"}).`,
    );
  }
  if (typed.current !== typed.target || typed.target !== readiness.target) {
    throw new Error(
      "Target state migration did not converge the ledger on the declared target "
      + `(current=${typed.current}, target=${typed.target}, declared=${readiness.target ?? "none"}).`,
    );
  }
  return {
    schema_version: "self-upgrade-target-state-migrated/v1",
    status: "migrated",
    target_git_head: targetGitHead,
    driver: typed.driver,
    current: typed.current,
    target: typed.target,
    applied_migrations: appliedIds,
  };
}

export function assertTargetStateSchemaApplied(
  result: CommandResult,
  targetGitHead: string,
): SelfUpgradeTargetStateAppliedReceipt {
  const readiness = assertTargetStateSchemaReady(result, targetGitHead);
  if (
    readiness.current === null
    || readiness.target === null
    || readiness.current !== readiness.target
    || readiness.pending_migrations.length > 0
  ) {
    throw new Error(
      "Promoted target became healthy without converging its migration ledger "
      + `(current=${readiness.current ?? "none"}, target=${readiness.target ?? "none"}, `
      + `pending=${readiness.pending_migrations.join(",") || "none"}).`,
    );
  }
  return {
    schema_version: "self-upgrade-target-state-applied/v1",
    status: "applied",
    target_git_head: targetGitHead,
    driver: readiness.driver,
    current: readiness.current,
    target: readiness.target,
    applied_migrations: readiness.applied_migrations,
    pending_migrations: [],
  };
}

async function verifyTargetStateGrowthBound(
  snapshot: SelfUpgradeStateSnapshotReceipt,
): Promise<{ boundBytes: number; observedGrowthBytes: number }> {
  const boundBytes =
    snapshot.capacity_preflight?.target_declared_migration_growth_bytes;
  if (
    typeof boundBytes !== "number"
    || !Number.isSafeInteger(boundBytes)
    || boundBytes < 0
  ) {
    throw new Error("State snapshot omitted its admitted target migration growth bound.");
  }
  if (boundBytes === 0) {
    // No target migration was admitted or executed. Runtime database writes
    // after restart are not migration growth.
    return { boundBytes: 0, observedGrowthBytes: 0 };
  }
  let liveBytes = 0;
  for (const candidate of [
    snapshot.database_path,
    `${snapshot.database_path}-wal`,
    `${snapshot.database_path}-shm`,
  ]) {
    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Target state growth evidence is not a physical regular file: ${candidate}`);
    }
    liveBytes += metadata.size;
  }
  const observedGrowthBytes = Math.max(0, liveBytes - snapshot.size_bytes);
  if (
    !Number.isSafeInteger(observedGrowthBytes)
    || observedGrowthBytes > boundBytes
  ) {
    throw new Error(
      `Target state exceeded its admitted migration growth bound: `
      + `${observedGrowthBytes} bytes observed, ${boundBytes} allowed.`,
    );
  }
  return { boundBytes, observedGrowthBytes };
}

async function defaultReloadSupervisorDefinition(
  kind: "systemd" | "launchd",
): Promise<"systemd-daemon-reload" | "launchd-on-restart"> {
  if (kind === "launchd") {
    // The canonical restart path performs bootout + bootstrap against the
    // atomically replaced plist; loading it here would split restart authority.
    return "launchd-on-restart";
  }
  try {
    await execFile("systemctl", ["--user", "daemon-reload"], { env: process.env });
  } catch (error) {
    const typed = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      typed.stderr?.trim()
        || typed.stdout?.trim()
        || typed.message
        || "systemctl --user daemon-reload failed",
    );
  }
  return "systemd-daemon-reload";
}

function normalizedConfigSha256(value: Record<string, unknown>): string {
  return sha256Bytes(Buffer.from(JSON.stringify(value), "utf8"));
}

export function launchdConfigFromPrint(text: string): Record<string, unknown> {
  const argumentsBlock = text.match(/^\s*arguments\s*=\s*\{\s*$([\s\S]*?)^\s*\}\s*$/mu)?.[1] ?? "";
  const properties = text.match(/^\s*properties\s*=\s*(.+)$/mu)?.[1]?.trim() ?? "";
  const exitTimeout = text.match(/^\s*exit timeout\s*=\s*(\d+)\s*$/mu)?.[1];
  const environmentBlock = text.match(/^\s*environment\s*=\s*\{\s*$([\s\S]*?)^\s*\}\s*$/mu)?.[1] ?? "";
  const environment = Object.fromEntries(
    environmentBlock
      .split(/\r?\n/u)
      .map((line) => line.trim().match(/^(HOME|PATH)\s*=>\s*(.*)$/u))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => [match[1]!, match[2]!] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    program_arguments: argumentsBlock
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^\d+\s*=\s*/u, "")),
    working_directory: text.match(/^\s*working directory\s*=\s*(.+)$/mu)?.[1]?.trim() ?? "",
    stdout_path: text.match(/^\s*stdout path\s*=\s*(.+)$/mu)?.[1]?.trim() ?? "",
    stderr_path: text.match(/^\s*stderr path\s*=\s*(.+)$/mu)?.[1]?.trim() ?? "",
    environment,
    exit_timeout_seconds: exitTimeout ? Number.parseInt(exitTimeout, 10) : null,
    keep_alive: /(?:^|\|)\s*keepalive\s*(?:\||$)/u.test(properties),
    run_at_load: /(?:^|\|)\s*runatload\s*(?:\||$)/u.test(properties),
  };
}

function normalizeSystemdDurationUsec(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "infinity") return "infinity";
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(us|ms|s|sec|m|min|h)?$/u);
  if (!match) return normalized;
  const amount = Number.parseFloat(match[1]!);
  const multiplier = match[2] === "us"
    ? 1
    : match[2] === "ms"
      ? 1_000
      : match[2] === "m" || match[2] === "min"
        ? 60_000_000
        : match[2] === "h"
          ? 3_600_000_000
          : 1_000_000;
  return `${Math.round(amount * multiplier)}us`;
}

function normalizeSystemdExecStartFromShow(value: string): string {
  const argv = value.match(/(?:^|;\s*)argv\[\]=(.*?)(?:\s*;|$)/u)?.[1]?.trim();
  if (argv) {
    return argv.replace(/\s+/gu, " ");
  }
  const commandPath = value.match(/(?:^|\{\s*)path=([^;\s}]+)/u)?.[1]?.trim();
  return commandPath ?? value.trim().replace(/\s+/gu, " ");
}

/**
 * Normalize `systemctl --user show` output into the comparable effective
 * configuration. This is the *resolved* definition, not the unit source: on a
 * real host systemd expands specifiers (`%h` → `/home/caleb`), renders
 * `FinalKillSignal=SIGKILL` as `9`, and fills an unset `WorkingDirectory=` with
 * `!<home>`. Only observations of this same surface may be compared with each
 * other; deriving an expectation from unit bytes would require re-implementing
 * systemd's specifier expansion and default table.
 */
export function systemdConfigFromShow(fields: Record<string, string>): Record<string, unknown> {
  const environment = Object.fromEntries(
    (fields.Environment ?? "")
      .split(/\s+/u)
      .map((assignment) => assignment.replace(/^["']|["']$/gu, ""))
      .map((assignment) => {
        const separator = assignment.indexOf("=");
        return separator > 0
          ? [assignment.slice(0, separator), assignment.slice(separator + 1)] as const
          : undefined;
      })
      .filter((entry): entry is readonly [string, string] =>
        entry !== undefined && (entry[0] === "HOME" || entry[0] === "PATH"))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    fragment_path: fields.FragmentPath ? path.resolve(fields.FragmentPath) : "",
    exec_start: normalizeSystemdExecStartFromShow(fields.ExecStart ?? ""),
    working_directory: fields.WorkingDirectory ?? "",
    timeout_stop_usec: normalizeSystemdDurationUsec(fields.TimeoutStopUSec ?? ""),
    kill_mode: fields.KillMode ?? "",
    restart: fields.Restart ?? "",
    restart_usec: normalizeSystemdDurationUsec(fields.RestartUSec ?? ""),
    final_kill_signal: fields.FinalKillSignal ?? "",
    service_type: fields.Type ?? "",
    environment,
  };
}

async function runEffectiveStateCommand(
  file: string,
  args: string[],
): Promise<CommandResult> {
  try {
    const result = await execFile(file, args, { env: process.env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const typed = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof typed.code === "number" ? typed.code : 1,
      stdout: typed.stdout ?? "",
      stderr: typed.stderr ?? typed.message ?? `${file} failed`,
    };
  }
}

async function defaultInspectSupervisorEffectiveState(
  descriptor: CalyxDaemonDescriptor,
): Promise<SelfUpgradeSupervisorEffectiveStateReceipt> {
  if (descriptor.supervisor.kind === "launchd") {
    const getUid = process.getuid?.bind(process);
    if (!getUid) {
      throw new Error("Effective launchd state inspection requires process.getuid().");
    }
    const label = descriptor.supervisor.label?.trim()
      || (descriptor.daemon_id.includes(".")
        ? descriptor.daemon_id
        : `com.pollilabs.calyx.${descriptor.daemon_id}`);
    const identity = `gui/${getUid()}/${label}`;
    const result = await runEffectiveStateCommand("launchctl", ["print", identity]);
    if (result.code !== 0) {
      throw new Error(
        `Unable to inspect effective launchd job ${identity}: ${commandDetail(result) || `exit ${result.code}`}`,
      );
    }
    const config = launchdConfigFromPrint(result.stdout);
    const state = result.stdout.match(/^\s*state\s*=\s*(.+)$/mu)?.[1]?.trim();
    const exitTimeout = config.exit_timeout_seconds;
    return {
      schema_version: "self-upgrade-supervisor-effective-state/v1",
      supervisor_kind: "launchd",
      service_identity: identity,
      loaded: true,
      running: state === "running",
      effective_config_sha256: normalizedConfigSha256(config),
      ...(typeof exitTimeout === "number" ? { exit_timeout_seconds: exitTimeout } : {}),
    };
  }
  if (descriptor.supervisor.kind === "systemd") {
    const unitName = descriptor.supervisor.unit_name?.trim();
    if (!unitName) {
      throw new Error(`Descriptor "${descriptor.daemon_id}" is missing supervisor.unit_name.`);
    }
    const result = await runEffectiveStateCommand("systemctl", [
      "--user",
      "show",
      unitName,
      "--property=LoadState",
      "--property=ActiveState",
      "--property=SubState",
      "--property=FragmentPath",
      "--property=ExecStart",
      "--property=WorkingDirectory",
      "--property=TimeoutStopUSec",
      "--property=KillMode",
      "--property=Restart",
      "--property=RestartUSec",
      "--property=FinalKillSignal",
      "--property=Type",
      "--property=Environment",
      "--no-pager",
    ]);
    if (result.code !== 0) {
      throw new Error(
        `Unable to inspect effective systemd unit ${unitName}: ${commandDetail(result) || `exit ${result.code}`}`,
      );
    }
    const fields = Object.fromEntries(
      result.stdout
        .split(/\r?\n/u)
        .map((line) => {
          const separator = line.indexOf("=");
          return separator < 0
            ? undefined
            : [line.slice(0, separator), line.slice(separator + 1)] as const;
        })
        .filter((entry): entry is readonly [string, string] => entry !== undefined),
    );
    const config = systemdConfigFromShow(fields);
    return {
      schema_version: "self-upgrade-supervisor-effective-state/v1",
      supervisor_kind: "systemd",
      service_identity: unitName,
      loaded: fields.LoadState === "loaded",
      running: fields.ActiveState === "active" && fields.SubState === "running",
      effective_config_sha256: normalizedConfigSha256(config),
    };
  }
  throw new Error("Direct supervisors do not have an effective loaded service definition.");
}

export async function prepareCanonicalSupervisorCutover(args: {
  plan: SelfUpgradePlan;
  preparedInstall: VersionedInstallReceipt;
  descriptors: CalyxDaemonDescriptor[];
  operationId: string;
  homeDir: string;
  resolveAgentsInfraRoot: Required<SelfUpgradeDependencies>["resolveAgentsInfraRoot"];
  runSupervisorStage: Required<SelfUpgradeDependencies>["runSupervisorStage"];
  reloadSupervisorDefinition: Required<SelfUpgradeDependencies>["reloadSupervisorDefinition"];
  createSupervisorAdapter: Required<SelfUpgradeDependencies>["createSupervisorAdapter"];
  inspectSupervisorEffectiveState: Required<SelfUpgradeDependencies>["inspectSupervisorEffectiveState"];
}): Promise<SelfUpgradeSupervisorCutover> {
  const plannedDaemonIds = new Set(args.plan.daemons.map((descriptor) => descriptor.daemon_id));
  const managedDescriptors = args.descriptors.filter((descriptor) => plannedDaemonIds.has(descriptor.daemon_id));
  const supervisorKinds = [...new Set(
    managedDescriptors
      .map((descriptor) => descriptor.supervisor.kind)
      .filter((kind): kind is "systemd" | "launchd" => kind === "systemd" || kind === "launchd"),
  )].sort();
  if (managedDescriptors.length === 0 || supervisorKinds.length !== 1) {
    throw new Error("Target-owned supervisor cutover requires one canonical systemd or launchd supervisor kind.");
  }
  const [supervisorKind] = supervisorKinds;
  if (!supervisorKind || managedDescriptors.some((descriptor) => descriptor.supervisor.kind !== supervisorKind)) {
    throw new Error("Target-owned supervisor cutover cannot span direct or mixed supervisor kinds.");
  }
  if (args.plan.startup_contract?.mutation_disposition === "allow") {
    const readiness: SelfUpgradeSupervisorReadinessReceipt = {
      schema_version: "self-upgrade-supervisor-readiness/v1",
      status: "unchanged",
      target_git_head: args.preparedInstall.git_head,
      source: "live-supervisor",
      supervisor_kinds: [supervisorKind],
    };
    return {
      readiness,
      async install() {
        return {
          schema_version: "self-upgrade-supervisor-install/v1",
          status: "unchanged",
          reload: "none",
        };
      },
      async restore() {
        return {
          schema_version: "self-upgrade-supervisor-rollback/v1",
          status: "skipped",
        };
      },
    };
  }
  const agentsInfraRoot = await args.resolveAgentsInfraRoot();
  if (!agentsInfraRoot) {
    throw new Error(
      "Target requires a source-managed supervisor cutover, but the canonical agents-infra source root is unavailable. "
      + "Refusing to improvise a unit/plist, transient truth pin, or parallel upgrader.",
    );
  }
  const stageResult = await args.runSupervisorStage({
    agentsInfraRoot,
    host: args.plan.host,
    preparedInstall: args.preparedInstall,
  });
  const stage = await parseCanonicalSupervisorStageReceipt(stageResult, {
    host: args.plan.host,
    preparedInstall: args.preparedInstall,
  });
  const stagedSnapshot = await readSupervisorServiceSnapshot(stage.staged.path);
  if (stagedSnapshot.sha256 !== stage.staged.desired_service_sha256) {
    throw new Error("Staged supervisor definition bytes do not match the canonical stage receipt.");
  }
  const previousSnapshot = await readSupervisorServiceSnapshot(stage.live.path);
  const supervisorBackupPath = path.join(
    args.homeDir,
    ".calyx",
    "self-upgrade-cutovers",
    args.operationId,
    "supervisor.previous",
  );
  await mkdir(path.dirname(supervisorBackupPath), { recursive: true, mode: 0o700 });
  await writeFile(supervisorBackupPath, previousSnapshot.bytes, { mode: 0o600 });
  await fsyncFileAndParent(supervisorBackupPath);
  if (await sha256File(supervisorBackupPath) !== previousSnapshot.sha256) {
    throw new Error("Durable previous supervisor snapshot does not match the live definition.");
  }
  const supervisorBackupIdentity = await captureFilesystemIdentity(supervisorBackupPath, "file");
  const supervisorBackupParentIdentity = await captureFilesystemIdentity(
    path.dirname(supervisorBackupPath),
    "directory",
  );
  const statuses = await Promise.all(
    managedDescriptors.map((descriptor) => args.createSupervisorAdapter(descriptor).status(descriptor)),
  );
  if (statuses.some((status) => !status.running)) {
    throw new Error("Target-owned supervisor cutover requires every managed daemon to be loaded and running before snapshot.");
  }
  if (
    supervisorKind === "launchd"
    && managedDescriptors.some((descriptor) =>
      descriptor.supervisor.kind !== "launchd"
      || path.resolve(descriptor.supervisor.plistPath ?? "") !== path.resolve(stage.live.path))
  ) {
    throw new Error("Canonical staged launchd plist path does not match the live daemon descriptor.");
  }
  if (
    supervisorKind === "systemd"
    && managedDescriptors.some((descriptor) =>
      descriptor.supervisor.kind !== "systemd"
      || descriptor.supervisor.unit_name !== path.basename(stage.live.path))
  ) {
    throw new Error("Canonical staged systemd unit does not match the live daemon descriptor.");
  }
  const effectiveDescriptor = managedDescriptors[0];
  if (!effectiveDescriptor) {
    throw new Error("Target-owned supervisor cutover has no effective-state descriptor.");
  }
  const previousEffectiveState = await args.inspectSupervisorEffectiveState(effectiveDescriptor);
  if (!previousEffectiveState.loaded || !previousEffectiveState.running) {
    throw new Error("Target-owned supervisor cutover requires a loaded and running effective supervisor state.");
  }
  // Effective-state verification compares observations of one surface with
  // observations of the same surface. A supervisor's *resolved* definition is
  // not derivable from its source bytes: blade's unit declares `%h`-prefixed
  // paths, `FinalKillSignal=SIGKILL` and no `WorkingDirectory=` while systemd
  // reports expanded paths, `FinalKillSignal=9` and `WorkingDirectory=!/home/caleb`;
  // mba's plist declares `ExitTimeOut=300` while launchd reports
  // `exit timeout = 60`. The restore expectation is therefore the pre-mutation
  // observation itself, and the target expectation is only knowable after the
  // installed definition has actually been loaded (see `verifyInstalled`).
  const restoredEffectiveConfigSha256 = previousEffectiveState.effective_config_sha256;
  const restoredExitTimeout = previousEffectiveState.exit_timeout_seconds;
  const readiness: SelfUpgradeSupervisorReadinessReceipt = {
    schema_version: "self-upgrade-supervisor-readiness/v1",
    status: "ready",
    target_git_head: args.preparedInstall.git_head,
    source: "agents-infra",
    source_sha256: stage.staged.desired_service_sha256,
    supervisor_kinds: [supervisorKind],
    live_service_path: stage.live.path,
    staged_service_path: stage.staged.path,
    previous_service_sha256: previousSnapshot.sha256,
    previous_service_present: true,
    previous_service_backup_path: supervisorBackupPath,
    previous_service_mode: previousSnapshot.mode,
    previous_service_identity: previousSnapshot.identity,
    previous_service_parent_identity: previousSnapshot.parentIdentity,
    previous_service_backup_identity: supervisorBackupIdentity,
    previous_service_backup_parent_identity: supervisorBackupParentIdentity,
    previous_loaded: true,
    previous_running: true,
    previous_effective_state: previousEffectiveState,
    restored_effective_config_sha256: restoredEffectiveConfigSha256,
    ...(typeof restoredExitTimeout === "number"
      ? { restored_exit_timeout_seconds: restoredExitTimeout }
      : {}),
  };
  let installed = false;
  let installedSnapshot: SupervisorServiceSnapshot | undefined;
  const cutover: SelfUpgradeSupervisorCutover = {
    readiness,
    async install() {
      if (installed) {
        throw new Error("Canonical supervisor definition was already installed for this cutover.");
      }
      await replaceSupervisorServiceFile(
        stage.live.path,
        stagedSnapshot.bytes,
        previousSnapshot.mode,
        previousSnapshot,
      );
      // Rollback authority must exist the instant the target bytes are live.
      // A reload that throws below still leaves the new definition on disk, and
      // `restore()` refuses to overwrite bytes it never snapshotted — capturing
      // after the reload would strand the host on the new definition.
      installedSnapshot = await readSupervisorServiceSnapshot(stage.live.path);
      if (installedSnapshot.sha256 !== stage.staged.desired_service_sha256) {
        throw new Error("Installed supervisor definition changed during canonical cutover.");
      }
      installed = true;
      const reload = await args.reloadSupervisorDefinition(supervisorKind);
      return {
        schema_version: "self-upgrade-supervisor-install/v1",
        status: "installed",
        installed_sha256: installedSnapshot.sha256,
        live_service_path: stage.live.path,
        reload,
      };
    },
    async restore() {
      try {
        const liveSnapshot = await readSupervisorServiceSnapshot(previousSnapshot.path);
        if (liveSnapshot.sha256 === previousSnapshot.sha256) {
          if (installed) {
            await args.reloadSupervisorDefinition(supervisorKind);
          }
          installed = false;
          return {
            schema_version: "self-upgrade-supervisor-rollback/v1",
            status: "succeeded",
            restored_sha256: liveSnapshot.sha256,
            restored_present: true,
            restored_loaded: false,
            restored_running: false,
          };
        }
        if (
          !installedSnapshot
          || liveSnapshot.sha256 !== installedSnapshot.sha256
          || !sameFilesystemIdentity(liveSnapshot.identity, installedSnapshot.identity)
          || !sameFilesystemIdentity(liveSnapshot.parentIdentity, installedSnapshot.parentIdentity)
        ) {
          throw new Error(
            "Canonical supervisor definition changed after cutover; refusing to overwrite a concurrent config publication during rollback.",
          );
        }
        await replaceSupervisorServiceFile(
          previousSnapshot.path,
          previousSnapshot.bytes,
          previousSnapshot.mode,
          installedSnapshot,
        );
        await args.reloadSupervisorDefinition(supervisorKind);
        const restored = await readSupervisorServiceSnapshot(previousSnapshot.path);
        if (restored.sha256 !== previousSnapshot.sha256) {
          throw new Error("Restored supervisor definition does not match the pre-cutover snapshot.");
        }
        installed = false;
        return {
          schema_version: "self-upgrade-supervisor-rollback/v1",
          status: "succeeded",
          restored_sha256: restored.sha256,
          restored_present: true,
          restored_loaded: false,
          restored_running: false,
        };
      } catch (error) {
        return {
          schema_version: "self-upgrade-supervisor-rollback/v1",
          status: "failed",
          error: errorMessage(error),
        };
      }
    },
    async verifyInstalled() {
      if (!installed || !installedSnapshot) {
        throw new Error("Canonical supervisor definition was not installed before verification.");
      }
      const live = await readSupervisorServiceSnapshot(stage.live.path);
      if (live.sha256 !== stage.staged.desired_service_sha256) {
        throw new Error(
          "Live supervisor definition no longer matches the staged bytes after restart "
          + `(expected ${stage.staged.desired_service_sha256}, observed ${live.sha256}).`,
        );
      }
      const effective = await args.inspectSupervisorEffectiveState(effectiveDescriptor);
      if (!effective.loaded || !effective.running) {
        throw new Error("Installed supervisor definition is not loaded and running after restart.");
      }
      if (effective.service_identity !== previousEffectiveState.service_identity) {
        throw new Error(
          `Installed supervisor identity is ${effective.service_identity}, `
          + `expected ${previousEffectiveState.service_identity}.`,
        );
      }
      // The resolved target configuration is knowable only now that the
      // supervisor has loaded it. Publish it as the readiness authority so the
      // receipt and committed-phase crash recovery re-require this exact state.
      cutover.readiness = {
        ...readiness,
        target_effective_config_sha256: effective.effective_config_sha256,
      };
      return effective;
    },
    async verifyRestored() {
      const effective = await args.inspectSupervisorEffectiveState(effectiveDescriptor);
      if (!effective.loaded || !effective.running) {
        throw new Error("Restored supervisor definition is not loaded and running after rollback restart.");
      }
      if (effective.service_identity !== previousEffectiveState.service_identity) {
        throw new Error(
          `Restored supervisor identity is ${effective.service_identity}, `
          + `expected ${previousEffectiveState.service_identity}.`,
        );
      }
      if (effective.effective_config_sha256 !== restoredEffectiveConfigSha256) {
        throw new Error(
          "Restored supervisor effective state does not match the pre-cutover observation "
          + `(expected ${restoredEffectiveConfigSha256}, observed ${effective.effective_config_sha256}; `
          + `ExitTimeOut=${effective.exit_timeout_seconds ?? "unknown"}).`,
        );
      }
      if (
        typeof restoredExitTimeout === "number"
        && effective.exit_timeout_seconds !== restoredExitTimeout
      ) {
        throw new Error(
          `Restored ExitTimeOut is ${effective.exit_timeout_seconds ?? "unknown"}, expected ${restoredExitTimeout}.`,
        );
      }
      return effective;
    },
  };
  return cutover;
}

async function resolveHostStartupCredentialEnvContract(
  host: string,
  deps: Required<Pick<SelfUpgradeDependencies, "resolveAgentsInfraRoot" | "readHostsTruth">>,
): Promise<ReturnType<typeof resolveConsumerApiCredentialEnvContract>> {
  try {
    const agentsInfraRoot = await deps.resolveAgentsInfraRoot();
    if (!agentsInfraRoot) {
      return undefined;
    }
    const hostsTruth = await deps.readHostsTruth(agentsInfraRoot);
    return resolveConsumerApiCredentialEnvContract(
      host,
      hostsTruth.hosts?.[host]?.consumer_api_credentials,
    );
  } catch {
    return undefined;
  }
}

/**
 * Pre-fetch mutation gate. A pending source-managed supervisor cutover waives
 * only the blocking reasons it can actually repair; every other blocker — most
 * importantly an invalid or unsupported target contract — still refuses here,
 * before the first fetch, build, daemon stop, or supervisor write. `--force`
 * has no bearing on this: the typed mutation disposition is not overridable.
 */
function ensurePlanReadyForMutation(
  plan: SelfUpgradePlan,
  supervisorCutoverAvailable: boolean,
): void {
  const startupContract = plan.startup_contract;
  const waivedMessages = new Set(
    supervisorCutoverAvailable && startupContract
      ? startupContract.blocking_reasons
        .filter((reason) => SUPERVISOR_REPAIRABLE_BLOCKING_CODES.has(reason.code))
        .map((reason) => reason.message)
      : [],
  );
  if (startupContract?.mutation_disposition === "block") {
    const blocking = unwaivedStartupContractBlockingReasons(
      startupContract,
      supervisorCutoverAvailable,
    );
    if (blocking.length > 0) {
      throw createSelfUpgradeError(
        blocking.join("\n") || "Target startup contract does not authorize mutation.",
        1,
      );
    }
  }
  const remainingBlockers = plan.blockers.filter((blocker) => !waivedMessages.has(blocker));
  if (remainingBlockers.length > 0) {
    throw createSelfUpgradeError(remainingBlockers.join("\n"), 1);
  }
}

async function setMaintenanceMode(
  daemonIds: string[],
  maintenanceMode: boolean,
  deps: Required<Pick<SelfUpgradeDependencies, "readDescriptor" | "writeDescriptor">>,
): Promise<void> {
  for (const daemonId of daemonIds) {
    const descriptor = await deps.readDescriptor(daemonId, { root: defaultDaemonsRoot() });
    if (!descriptor) {
      continue;
    }
    await deps.writeDescriptor(
      {
        ...descriptor,
        maintenance_mode: maintenanceMode,
      },
      {
        root: defaultDaemonsRoot(),
        expectedDescriptor: descriptor,
      },
    );
  }
}

async function restoreMaintenanceModes(
  prior: readonly { daemon_id: string; enabled: boolean }[],
  deps: Required<Pick<SelfUpgradeDependencies, "readDescriptor" | "writeDescriptor">>,
): Promise<void> {
  for (const entry of prior) {
    const descriptor = await deps.readDescriptor(entry.daemon_id, { root: defaultDaemonsRoot() });
    if (!descriptor) {
      throw new Error(
        `Cannot restore prior maintenance state: daemon descriptor ${entry.daemon_id} is missing.`,
      );
    }
    await deps.writeDescriptor(
      {
        ...descriptor,
        maintenance_mode: entry.enabled,
      },
      {
        root: defaultDaemonsRoot(),
        expectedDescriptor: descriptor,
      },
    );
  }
  for (const entry of prior) {
    const descriptor = await deps.readDescriptor(entry.daemon_id, { root: defaultDaemonsRoot() });
    if ((descriptor?.maintenance_mode ?? false) !== entry.enabled) {
      throw new Error(
        `Prior maintenance state did not verify for daemon ${entry.daemon_id}.`,
      );
    }
  }
}

async function abortActiveRuns(
  activeRuns: SelfUpgradeActiveRun[],
  createRunService: Required<SelfUpgradeDependencies>["createRunService"],
): Promise<string[]> {
  const warnings: string[] = [];
  const runsByRoot = new Map<string, SelfUpgradeActiveRun[]>();
  for (const run of activeRuns) {
    const bucket = runsByRoot.get(run.runs_root) ?? [];
    bucket.push(run);
    runsByRoot.set(run.runs_root, bucket);
  }

  for (const [runsRoot, runs] of runsByRoot) {
    const service = createRunService({ runsRoot });
    for (const run of runs) {
      const result = await service.stop(run.run_id);
      if (result.status !== "cancellation_requested") {
        warnings.push(`Run ${run.run_id} did not acknowledge stop request.`);
      }
    }
  }
  return warnings;
}

function readMonotonicNowMs(monotonicNowMs: () => number): number | undefined {
  try {
    const observed = monotonicNowMs();
    return Number.isFinite(observed) ? observed : undefined;
  } catch {
    return undefined;
  }
}

function readMonotonicElapsedMs(
  startedAtMs: number | undefined,
  monotonicNowMs: () => number,
): number | undefined {
  if (startedAtMs === undefined) {
    return undefined;
  }
  const observedAtMs = readMonotonicNowMs(monotonicNowMs);
  if (observedAtMs === undefined) {
    return undefined;
  }
  const elapsedMs = observedAtMs - startedAtMs;
  return Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : undefined;
}

function boundedPollCount(deadlineMs: number, intervalMs: number): number {
  return Math.max(0, Math.ceil(deadlineMs / intervalMs));
}

async function waitForNoActiveRuns(args: {
  descriptors: SelfUpgradePlanDaemon[];
  createRunService: Required<SelfUpgradeDependencies>["createRunService"];
  sleep: (ms: number) => Promise<void>;
  monotonicNowMs: () => number;
  deadlineMs: number;
  preservedRunIds?: ReadonlySet<string>;
}): Promise<SelfUpgradeActiveRun[]> {
  const startedAtMs = readMonotonicNowMs(args.monotonicNowMs);
  let remainingPolls = boundedPollCount(args.deadlineMs, DRAIN_POLL_INTERVAL_MS);
  let activeRuns = await collectActiveRuns(args.descriptors, args.createRunService);
  const runsStillDraining = (): SelfUpgradeActiveRun[] => activeRuns.filter(
    (run) => !args.preservedRunIds?.has(run.run_id),
  );
  while (runsStillDraining().length > 0 && remainingPolls > 0) {
    const elapsedMs = readMonotonicElapsedMs(startedAtMs, args.monotonicNowMs);
    if (elapsedMs !== undefined && elapsedMs >= args.deadlineMs) {
      break;
    }
    await args.sleep(DRAIN_POLL_INTERVAL_MS);
    remainingPolls -= 1;
    activeRuns = await collectActiveRuns(args.descriptors, args.createRunService);
  }
  return runsStillDraining().length === 0 ? activeRuns : runsStillDraining();
}

async function stopDaemons(
  descriptors: CalyxDaemonDescriptor[],
  deps: Required<Pick<SelfUpgradeDependencies, "createSupervisorAdapter" | "readDescriptor">>,
): Promise<Array<{ daemon_id: string; stopped: string }>> {
  const results: Array<{ daemon_id: string; stopped: string }> = [];
  for (const descriptor of [...descriptors].sort((left, right) => right.restart_order - left.restart_order)) {
    const current = await deps.readDescriptor(descriptor.daemon_id, { root: defaultDaemonsRoot() });
    if (!current) {
      continue;
    }
    const stopResult = await deps.createSupervisorAdapter(current).stop(current);
    results.push({
      daemon_id: descriptor.daemon_id,
      stopped: stopResult.signal ?? current.supervisor.kind,
    });
  }
  return results;
}

async function startDaemons(
  descriptors: CalyxDaemonDescriptor[],
  deps: Required<Pick<SelfUpgradeDependencies, "createSupervisorAdapter">>,
): Promise<Array<{ daemon_id: string; started: string }>> {
  const results: Array<{ daemon_id: string; started: string }> = [];
  for (const descriptor of [...descriptors].sort((left, right) => left.restart_order - right.restart_order)) {
    const startResult = await deps.createSupervisorAdapter(descriptor).start(descriptor);
    results.push({
      daemon_id: descriptor.daemon_id,
      started: startResult.detail ?? (typeof startResult.pid === "number" ? `${startResult.pid}` : descriptor.supervisor.kind),
    });
  }
  return results;
}

function daemonRestartReceipt(
  descriptors: SelfUpgradePlanDaemon[],
  stopResults: Array<{ daemon_id: string; stopped: string }>,
  startResults: Array<{ daemon_id: string; started: string }>,
): SelfUpgradeDaemonRestartReceipt[] {
  return descriptors.map((daemon) => ({
    daemon_id: daemon.daemon_id,
    supervisor: daemon.supervisor.kind,
    stopped: stopResults.find((entry) => entry.daemon_id === daemon.daemon_id)?.stopped ?? daemon.supervisor.kind,
    started: startResults.find((entry) => entry.daemon_id === daemon.daemon_id)?.started ?? daemon.supervisor.kind,
  }));
}

async function readCurrentInstallTarget(installsRoot: string): Promise<string | undefined> {
  return realpath(resolveCurrentCalyxInstallLink(installsRoot)).catch((error) => {
    const typed = error as NodeJS.ErrnoException;
    if (typed.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
}

async function migrateBootstrapWrapperToPromotedInstall(args: {
  homeRoot: string;
  repoRoot: string;
  installReceipt: VersionedInstallReceipt;
  installBootstrap: typeof installBootstrap;
}): Promise<InstallBootstrapResult> {
  const result = await args.installBootstrap({
    target: path.join(args.homeRoot, ".agents"),
    apply: true,
    executablePath: path.join(args.repoRoot, "packages", "cli", "dist", "bin.js"),
    installsRoot: path.dirname(args.installReceipt.current_link),
  });
  if (result.action !== "bootstrap" || !result.sourceExecutablePath) {
    throw new Error(`Failed to migrate bootstrap wrapper to promoted install: ${result.action}`);
  }
  return result;
}

async function rollbackPromotedInstall(args: {
  operationId: string;
  installReceipt: VersionedInstallReceipt | undefined;
  previousInstallPath: string | undefined;
  restoreSupervisor?: () => Promise<SelfUpgradeSupervisorRollbackReceipt>;
  verifySupervisorRestored?: () => Promise<SelfUpgradeSupervisorEffectiveStateReceipt>;
  restoreState?: () => Promise<SelfUpgradeStateRollbackReceipt>;
  stopBeforeRestore: boolean;
  initialStopResults: Array<{ daemon_id: string; stopped: string }>;
  plan: SelfUpgradePlan;
  fullDescriptors: CalyxDaemonDescriptor[];
  authToken: string;
  executionTarget: PromotedExecutionVerificationTarget | undefined;
  createAdminClient: typeof createCalyxAdminClient;
  sleep: (ms: number) => Promise<void>;
  monotonicNowMs: () => number;
  readDescriptor: Required<SelfUpgradeDependencies>["readDescriptor"];
  createSupervisorAdapter: Required<SelfUpgradeDependencies>["createSupervisorAdapter"];
}): Promise<SelfUpgradeRollbackReceipt> {
  if (!args.installReceipt) {
    return { status: "skipped", reason: "no promoted install receipt was written" };
  }
  const failedPromote = {
    install_path: args.installReceipt.install_path,
    current_link: args.installReceipt.current_link,
    git_head: args.installReceipt.git_head,
  };
  if (!args.previousInstallPath) {
    return {
      status: args.installReceipt.promoted ? "failed" : "skipped",
      reason: "no previous current install was available",
      failed_promote: failedPromote,
      current_link: args.installReceipt.current_link,
    };
  }
  if (!args.executionTarget) {
    return {
      status: "failed",
      reason: "promoted execution target was not available",
      failed_promote: failedPromote,
      previous_install_path: args.previousInstallPath,
      current_link: args.installReceipt.current_link,
    };
  }

  let supervisor: SelfUpgradeSupervisorRollbackReceipt | undefined;
  let state: SelfUpgradeStateRollbackReceipt | undefined;
  try {
    const previousBuild = await readInstallBuildInfo(args.previousInstallPath);
    const rollbackStopResults = args.stopBeforeRestore
      ? await stopDaemons(args.fullDescriptors, args)
      : args.initialStopResults;
    if (args.restoreState) {
      state = await args.restoreState();
      if (state.status === "failed") {
        throw new Error(`State rollback failed: ${state.error ?? "unknown error"}`);
      }
    }
    await atomicallyPromoteInstall(
      path.dirname(args.installReceipt.current_link),
      args.previousInstallPath,
      {
        operationId: args.operationId,
        expectedCurrentInstallPaths: [
          args.installReceipt.install_path,
          args.previousInstallPath,
        ],
      },
    );
    if (args.restoreSupervisor) {
      supervisor = await args.restoreSupervisor();
      if (supervisor.status === "failed") {
        throw new Error(`Supervisor rollback failed: ${supervisor.error ?? "unknown error"}`);
      }
    }
    const startResults = await startDaemons(args.fullDescriptors, args);
    const verified = await verifySelfUpgradeDaemons(
      args.plan.daemons,
      args.plan.host,
      args.authToken,
      previousBuild.git_head,
      args.executionTarget,
      args.createAdminClient,
      args.sleep,
      args.monotonicNowMs,
      args.readDescriptor,
    );
    if (supervisor && args.verifySupervisorRestored) {
      const effectiveState = await args.verifySupervisorRestored();
      supervisor = {
        ...supervisor,
        restored_loaded: effectiveState.loaded,
        restored_running: effectiveState.running,
        effective_state: effectiveState,
      };
    }
    return {
      status: "succeeded",
      failed_promote: failedPromote,
      previous_install_path: args.previousInstallPath,
      previous_git_head: previousBuild.git_head,
      current_link: args.installReceipt.current_link,
      daemons_restarted: daemonRestartReceipt(args.plan.daemons, rollbackStopResults, startResults),
      verified_daemons: verified,
      ...(supervisor ? { supervisor } : {}),
      ...(state ? { state } : {}),
    };
  } catch (error) {
    return {
      status: "failed",
      failed_promote: failedPromote,
      previous_install_path: args.previousInstallPath,
      current_link: args.installReceipt.current_link,
      ...(supervisor ? { supervisor } : {}),
      ...(state ? { state } : {}),
      error: errorMessage(error),
    };
  }
}

async function hasExhaustedStateRollbackAuthority(
  journal: SelfUpgradeCutoverJournal,
): Promise<boolean> {
  const snapshot = journal.state_snapshot;
  if (
    (journal.phase !== "target_started" && journal.phase !== "target_verified")
    || !snapshot
    || snapshot.restore_strategy !== "precreated-same-filesystem-hardlink-rename"
  ) {
    return false;
  }
  if (
    !snapshot.database_parent_identity
    || !snapshot.backup_identity
    || !snapshot.backup_parent_identity
    || !snapshot.rollback_candidate_path
    || !snapshot.rollback_candidate_identity
    || !snapshot.rollback_reserve_path
    || !snapshot.rollback_reserve_identity
    || typeof snapshot.rollback_reserve_allocated_bytes !== "number"
    || !Number.isSafeInteger(snapshot.rollback_reserve_allocated_bytes)
    || snapshot.rollback_reserve_allocated_bytes < 0
  ) {
    throw new Error(
      `Interrupted cutover ${journal.operation_id} state snapshot lacks complete `
      + "pre-created rollback authority.",
    );
  }
  const recoveryLeafPresent = async (
    candidate: string,
    label: string,
  ): Promise<boolean> => {
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`${label} is not a physical regular file: ${candidate}`);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  };
  const [candidatePresent, reservePresent] = await Promise.all([
    recoveryLeafPresent(snapshot.rollback_candidate_path, "State rollback candidate"),
    recoveryLeafPresent(snapshot.rollback_reserve_path, "State rollback reserve"),
  ]);
  if (candidatePresent || reservePresent) {
    return false;
  }
  const [databaseIdentity, backupIdentity] = await Promise.all([
    captureFilesystemIdentity(snapshot.database_path, "file"),
    captureFilesystemIdentity(snapshot.backup_path, "file"),
  ]);
  return sameFilesystemIdentity(backupIdentity, snapshot.backup_identity)
    && samePhysicalFile(databaseIdentity, backupIdentity);
}

function acceptedInstallFromJournal(
  journal: SelfUpgradeCutoverJournal,
  targetBuild: CalyxBuildInfo,
): VersionedInstallReceipt {
  const acceptance = journal.target_acceptance;
  if (!acceptance) {
    throw new Error(
      `Interrupted cutover journal ${journal.operation_id} cannot finish forward without exact target acceptance.`,
    );
  }
  return {
    install_path: journal.target_install_path,
    current_link: journal.current_link,
    previous_current_install_path: journal.previous_install_path,
    build_info_path: resolveCalyxInstallBuildInfoPath(journal.target_install_path),
    bin_path: resolveCalyxInstallBinPath(journal.target_install_path),
    git_head: targetBuild.git_head,
    verified_version: targetBuild.package_version,
    artifact_manifest_sha256: acceptance.target_artifact_manifest_sha256,
    artifact_manifest_packages: acceptance.target_artifact_manifest_packages,
    pruned: [],
    materialized: true,
    promoted: false,
    mechanism: "pack-install",
    rollback_command: `ln -sfn ${journal.previous_install_path} ${journal.current_link}`,
  };
}

async function verifyAcceptedTargetDaemonForFinishForward(args: {
  journal: SelfUpgradeCutoverJournal;
  authToken: string;
  targetHead: string;
  createAdminClient: typeof createCalyxAdminClient;
  readDescriptor: Required<SelfUpgradeDependencies>["readDescriptor"];
  requireMaintenance?: boolean;
  signal: AbortSignal;
}): Promise<void> {
  for (const planned of args.journal.plan_daemons) {
    const health = await fetchDaemonHealth(
      planned,
      args.authToken,
      args.createAdminClient,
      args.signal,
    );
    const currentDescriptor = await args.readDescriptor(
      planned.daemon_id,
      { root: defaultDaemonsRoot() },
    );
    const { identity } = expectedDaemonIdentity(
      args.journal.host,
      planned,
      currentDescriptor,
    );
    assertVerifiedDaemonIdentity(health, identity);
    if (health.build.git_head !== args.targetHead) {
      throw new Error(
        `Interrupted cutover ${args.journal.operation_id} target daemon reports `
        + `${health.build.git_head}, expected ${args.targetHead}.`,
      );
    }
    if (health.active_runs !== 0) {
      throw new Error(
        `Interrupted cutover ${args.journal.operation_id} cannot finish forward with `
        + `${health.active_runs} active runs.`,
      );
    }
    if (args.requireMaintenance && !health.maintenance_mode) {
      throw new Error(
        `Interrupted cutover ${args.journal.operation_id} target daemon did not re-enter maintenance mode.`,
      );
    }
    const missingFeatures = EXPECTED_DAEMON_BASELINE_FEATURES.filter(
      (feature) => !health.supports_features.includes(feature),
    );
    if (missingFeatures.length > 0) {
      throw new Error(
        `Interrupted cutover ${args.journal.operation_id} target daemon is missing baseline features: `
        + missingFeatures.join(", "),
      );
    }
  }
}

export async function recoverInterruptedCutover(args: {
  homeDir: string;
  host: string;
  authToken: string;
  now?: () => string;
  resolveAgentsInfraRoot?: Required<SelfUpgradeDependencies>["resolveAgentsInfraRoot"];
  runSupervisorStage?: Required<SelfUpgradeDependencies>["runSupervisorStage"];
  runTargetStatePlan?: Required<SelfUpgradeDependencies>["runTargetStatePlan"];
  recoverySignal?: AbortSignal;
  createSupervisorAdapter: Required<SelfUpgradeDependencies>["createSupervisorAdapter"];
  inspectSupervisorEffectiveState: Required<SelfUpgradeDependencies>["inspectSupervisorEffectiveState"];
  reloadSupervisorDefinition: Required<SelfUpgradeDependencies>["reloadSupervisorDefinition"];
  createAdminClient: typeof createCalyxAdminClient;
  sleep: (ms: number) => Promise<void>;
  monotonicNowMs: () => number;
  readDescriptor: Required<SelfUpgradeDependencies>["readDescriptor"];
  writeDescriptor: Required<SelfUpgradeDependencies>["writeDescriptor"];
}): Promise<void> {
  const journals = await listCutoverJournals(args.homeDir);
  if (journals.length === 0) {
    return;
  }
  if (journals.length > 1) {
    throw new Error(
      `Multiple authoritative self-upgrade cutover journals require operator reconciliation: ${
        journals.map((entry) => entry.journal.operation_id).join(", ")
      }.`,
    );
  }
  const loadedJournal = journals[0]!;
  const journal = loadedJournal.journal;
  if (journal.host !== args.host) {
    throw new Error(
      `Interrupted self-upgrade journal ${journal.operation_id} belongs to ${journal.host}, not ${args.host}.`,
    );
  }
  const cutoverRoot = defaultSelfUpgradeCutoverRoot(args.homeDir);
  const installsRoot = resolveCalyxInstallsRoot({ homeDir: () => args.homeDir });
  const installsRootIdentity = await captureFilesystemIdentity(installsRoot, "directory");
  const expectedCurrentLink = resolveCurrentCalyxInstallLink(installsRoot);
  if (path.resolve(journal.current_link) !== path.resolve(expectedCurrentLink)) {
    throw new Error(`Interrupted cutover journal ${journal.operation_id} has a foreign current link.`);
  }
  const expectedWrapperPath = path.join(args.homeDir, ".agents", "run", "calyx");
  if (path.resolve(journal.wrapper_path) !== path.resolve(expectedWrapperPath)) {
    throw new Error(`Interrupted cutover journal ${journal.operation_id} has a foreign wrapper path.`);
  }
  for (const installPath of [journal.previous_install_path, journal.target_install_path]) {
    const relative = path.relative(installsRootIdentity.real_path, await realpath(installPath));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Interrupted cutover journal ${journal.operation_id} has a foreign install path.`);
    }
  }
  const previousInstallIdentity = await captureFilesystemIdentity(journal.previous_install_path, "directory");
  const targetInstallIdentity = await captureFilesystemIdentity(journal.target_install_path, "directory");
  if (
    previousInstallIdentity.device !== installsRootIdentity.device
    || targetInstallIdentity.device !== installsRootIdentity.device
  ) {
    throw new Error(`Interrupted cutover journal ${journal.operation_id} install authority changed filesystems.`);
  }
  const currentLinkParentIdentity = await captureFilesystemIdentity(path.dirname(journal.current_link), "directory");
  const wrapperParentIdentity = await captureFilesystemIdentity(path.dirname(journal.wrapper_path), "directory");
  const rollbackAuthorityExhausted = await hasExhaustedStateRollbackAuthority(journal);
  if (journal.state_snapshot) {
    const expectedDatabasePath = resolveStatePaths({ homeDir: args.homeDir }).dbPath;
    const expectedBackupRoot = path.join(
      path.dirname(expectedDatabasePath),
      ".self-upgrade-backups",
      journal.operation_id,
    );
    const relativeBackup = path.relative(
      expectedBackupRoot,
      path.resolve(journal.state_snapshot.backup_path),
    );
    const expectedRollbackCandidate = path.join(
      path.dirname(expectedDatabasePath),
      `.${path.basename(expectedDatabasePath)}.${journal.operation_id}.rollback`,
    );
    const expectedRollbackReserve = path.join(
      expectedBackupRoot,
      "rollback-reserve.bin",
    );
    if (
      path.resolve(journal.state_snapshot.database_path) !== path.resolve(expectedDatabasePath)
      || !relativeBackup
      || relativeBackup.startsWith("..")
      || path.isAbsolute(relativeBackup)
      || (
        journal.state_snapshot.rollback_candidate_path !== undefined
        && path.resolve(journal.state_snapshot.rollback_candidate_path)
          !== path.resolve(expectedRollbackCandidate)
      )
      || (
        journal.state_snapshot.rollback_reserve_path !== undefined
        && path.resolve(journal.state_snapshot.rollback_reserve_path)
          !== path.resolve(expectedRollbackReserve)
      )
    ) {
      throw new Error(`Interrupted cutover journal ${journal.operation_id} has foreign state recovery paths.`);
    }
    if (
      journal.phase !== "committed"
      &&
      journal.state_snapshot.database_parent_identity
      && journal.state_snapshot.backup_identity
      && journal.state_snapshot.backup_parent_identity
    ) {
      await assertFilesystemIdentityCurrent(
        journal.state_snapshot.database_parent_identity,
        "Interrupted state database parent",
      );
      await assertFilesystemIdentityCurrent(
        journal.state_snapshot.backup_parent_identity,
        "Interrupted state snapshot parent",
      );
      await assertFilesystemIdentityCurrent(
        journal.state_snapshot.backup_identity,
        "Interrupted state snapshot",
      );
      if (
        !rollbackAuthorityExhausted
        &&
        journal.state_snapshot.rollback_candidate_identity
        && journal.state_snapshot.rollback_candidate_path
      ) {
        await assertFilesystemIdentityCurrent(
          journal.state_snapshot.rollback_candidate_identity,
          "Interrupted state rollback candidate",
        );
      }
      if (
        !rollbackAuthorityExhausted
        &&
        journal.state_snapshot.rollback_reserve_identity
        && journal.state_snapshot.rollback_reserve_path
      ) {
        await assertFilesystemIdentityCurrent(
          journal.state_snapshot.rollback_reserve_identity,
          "Interrupted state rollback reserve",
        );
      }
    }
  }
  const recordedReadiness = journal.supervisor_readiness;
  if (recordedReadiness.status === "ready") {
    const [recordedKind] = recordedReadiness.supervisor_kinds;
    const recordedDescriptor = journal.descriptors.find(
      (descriptor) => descriptor.supervisor.kind === recordedKind,
    );
    const recordedLivePath = recordedReadiness.live_service_path;
    const recordedBackupPath = recordedReadiness.previous_service_backup_path;
    const expectedBackupRoot = path.join(cutoverRoot, journal.operation_id);
    const relativeBackup = recordedBackupPath
      ? path.relative(expectedBackupRoot, path.resolve(recordedBackupPath))
      : "";
    const expectedLivePath = recordedKind === "launchd"
      ? recordedDescriptor?.supervisor.kind === "launchd"
        ? recordedDescriptor.supervisor.plistPath
        : undefined
      : recordedKind === "systemd" && recordedDescriptor?.supervisor.kind === "systemd"
        ? path.join(args.homeDir, ".config", "systemd", "user", recordedDescriptor.supervisor.unit_name ?? "")
        : undefined;
    if (
      recordedReadiness.supervisor_kinds.length !== 1
      || !recordedDescriptor
      || !recordedLivePath
      || !recordedBackupPath
      || !expectedLivePath
      || path.resolve(recordedLivePath) !== path.resolve(expectedLivePath)
      || !relativeBackup
      || relativeBackup.startsWith("..")
      || path.isAbsolute(relativeBackup)
    ) {
      throw new Error(`Interrupted cutover journal ${journal.operation_id} has foreign supervisor recovery paths.`);
    }
  }
  const maintenanceBefore = journal.maintenance_before
    ?? journal.plan_daemons.map((daemon) => ({
      daemon_id: daemon.daemon_id,
      enabled: daemon.maintenance_mode,
    }));
  if (journal.phase === "prepared" || journal.phase === "quiesced") {
    await restoreMaintenanceModes(maintenanceBefore, {
      readDescriptor: args.readDescriptor,
      writeDescriptor: args.writeDescriptor,
    });
    await removeCutoverJournal(cutoverRoot, journal.operation_id, {
      removeArtifacts: false,
      expectedJournalIdentity: loadedJournal.journalIdentity,
      expectedRootIdentity: loadedJournal.rootIdentity,
    });
    await rm(path.join(cutoverRoot, journal.operation_id), { recursive: true, force: true });
    return;
  }
  await assertFilesystemIdentityCurrent(targetInstallIdentity, "Target install");
  const targetBuild = await readInstallBuildInfo(journal.target_install_path);
  if (targetBuild.git_head !== journal.supervisor_readiness.target_git_head) {
    throw new Error(`Interrupted cutover journal ${journal.operation_id} target build changed.`);
  }
  if (journal.target_acceptance) {
    const acceptance = journal.target_acceptance;
    if (
      acceptance.operation_id !== journal.operation_id
      || acceptance.target_git_head !== targetBuild.git_head
      || await realpath(resolveCalyxInstallBinPath(journal.target_install_path))
        !== acceptance.executor_realpath
      || await sha256RegularFileNoFollow(resolveCalyxInstallBuildInfoPath(journal.target_install_path))
        !== acceptance.target_build_info_sha256
      || await computeCalyxOwnedArtifactManifest(
        journal.target_install_path,
        acceptance.target_artifact_manifest_packages.map((name) => ({ name, relativePath: "" })),
      ) !== acceptance.target_artifact_manifest_sha256
    ) {
      throw new Error(`Interrupted cutover journal ${journal.operation_id} target acceptance changed.`);
    }
  }
  if (rollbackAuthorityExhausted) {
    if (
      !args.resolveAgentsInfraRoot
      || !args.runSupervisorStage
      || !args.runTargetStatePlan
    ) {
      throw new Error(
        `Interrupted cutover ${journal.operation_id} exhausted rollback authority, `
        + "but finish-forward recovery dependencies are unavailable.",
      );
    }
    const readiness = journal.supervisor_readiness;
    if (readiness.status !== "ready" || readiness.source !== "agents-infra") {
      throw new Error(
        `Interrupted cutover ${journal.operation_id} exhausted rollback authority without `
        + "canonical supervisor readiness; refusing to improvise finish-forward state.",
      );
    }
    const [supervisorKind] = readiness.supervisor_kinds;
    const expectedEffectiveState = readiness.previous_effective_state;
    const effectiveDescriptor = journal.descriptors.find(
      (descriptor) => descriptor.supervisor.kind === supervisorKind,
    );
    if (
      readiness.supervisor_kinds.length !== 1
      || !supervisorKind
      || !readiness.previous_service_sha256
      || !expectedEffectiveState
      || expectedEffectiveState.supervisor_kind !== supervisorKind
      || !effectiveDescriptor
    ) {
      throw new Error(
        `Interrupted cutover ${journal.operation_id} lacks exact supervisor identity authority.`,
      );
    }
    const acceptedInstall = acceptedInstallFromJournal(journal, targetBuild);
    const agentsInfraRoot = await args.resolveAgentsInfraRoot();
    if (!agentsInfraRoot) {
      throw new Error(
        `Interrupted cutover ${journal.operation_id} exhausted rollback authority, `
        + "but canonical agents-infra source is unavailable for finish-forward recovery.",
      );
    }
    assertTargetStateSchemaApplied(
      await args.runTargetStatePlan(acceptedInstall),
      targetBuild.git_head,
    );
    const recoverySignal =
      args.recoverySignal ?? AbortSignal.timeout(DEFAULT_VERIFY_TIMEOUT_MS);
    await verifyAcceptedTargetDaemonForFinishForward({
      journal,
      authToken: args.authToken,
      targetHead: targetBuild.git_head,
      createAdminClient: args.createAdminClient,
      readDescriptor: args.readDescriptor,
      signal: recoverySignal,
    });
    const stage = await parseCanonicalSupervisorStageReceipt(
      await args.runSupervisorStage({
        agentsInfraRoot,
        host: journal.host,
        preparedInstall: acceptedInstall,
      }),
      {
        host: journal.host,
        preparedInstall: acceptedInstall,
      },
    );
    if (
      !readiness.live_service_path
      || path.resolve(stage.live.path) !== path.resolve(readiness.live_service_path)
    ) {
      throw new Error(
        `Interrupted cutover ${journal.operation_id} canonical supervisor target changed paths.`,
      );
    }
    const [liveSnapshot, stagedSnapshot] = await Promise.all([
      readSupervisorServiceSnapshot(stage.live.path),
      readSupervisorServiceSnapshot(stage.staged.path),
    ]);
    if (stagedSnapshot.sha256 !== stage.staged.desired_service_sha256) {
      throw new Error(
        `Interrupted cutover ${journal.operation_id} canonical staged supervisor bytes changed.`,
      );
    }
    const liveIsPrevious = liveSnapshot.sha256 === readiness.previous_service_sha256;
    const liveIsTarget = liveSnapshot.sha256 === stage.staged.desired_service_sha256;
    if (!liveIsPrevious && !liveIsTarget) {
      throw new Error(
        `Interrupted cutover ${journal.operation_id} found a concurrent supervisor publication; `
        + "refusing finish-forward overwrite.",
      );
    }
    await assertWrapperTargetsPromotedCurrent({
      currentLink: journal.current_link,
      wrapperPath: journal.wrapper_path,
    });
    await setMaintenanceMode(
      uniqueDaemonIds(journal.plan_daemons),
      true,
      {
        readDescriptor: args.readDescriptor,
        writeDescriptor: args.writeDescriptor,
      },
    );
    // The first zero-active probe prevents an unnecessary cordon when work is
    // already present. The second closes the race with new dispatch: no target
    // surface moves until every daemon both reports zero work and reflects the
    // re-established maintenance descriptor.
    await verifyAcceptedTargetDaemonForFinishForward({
      journal,
      authToken: args.authToken,
      targetHead: targetBuild.git_head,
      createAdminClient: args.createAdminClient,
      readDescriptor: args.readDescriptor,
      requireMaintenance: true,
      signal: recoverySignal,
    });
    if (!liveIsTarget) {
      await replaceSupervisorServiceFile(
        stage.live.path,
        stagedSnapshot.bytes,
        liveSnapshot.mode,
        liveSnapshot,
      );
    }
    await assertFilesystemIdentityCurrent(installsRootIdentity, "Install root");
    await assertFilesystemIdentityCurrent(currentLinkParentIdentity, "Current-link parent");
    await assertFilesystemIdentityCurrent(wrapperParentIdentity, "Bootstrap-wrapper parent");
    await assertFilesystemIdentityCurrent(targetInstallIdentity, "Target install");
    await atomicallyPromoteInstall(
      installsRoot,
      journal.target_install_path,
      {
        operationId: journal.operation_id,
        expectedCurrentInstallPaths: [
          journal.previous_install_path,
          journal.target_install_path,
        ],
      },
    );
    await assertWrapperTargetsPromotedCurrent({
      currentLink: journal.current_link,
      wrapperPath: journal.wrapper_path,
    });
    await args.reloadSupervisorDefinition(supervisorKind);
    const effective = await args.inspectSupervisorEffectiveState(effectiveDescriptor);
    if (
      !effective.loaded
      || !effective.running
      || effective.service_identity !== expectedEffectiveState.service_identity
    ) {
      throw new Error(
        `Interrupted cutover ${journal.operation_id} did not establish the canonical target supervisor.`,
      );
    }
    const confirmedLiveSnapshot = await readSupervisorServiceSnapshot(stage.live.path);
    if (confirmedLiveSnapshot.sha256 !== stage.staged.desired_service_sha256) {
      throw new Error(
        `Interrupted cutover ${journal.operation_id} found a concurrent supervisor publication `
        + "after target reload; refusing to commit mixed source and effective state.",
      );
    }
    await verifySelfUpgradeDaemons(
      journal.plan_daemons,
      journal.host,
      args.authToken,
      targetBuild.git_head,
      {
        currentLink: journal.current_link,
        wrapperPath: journal.wrapper_path,
      },
      args.createAdminClient,
      args.sleep,
      args.monotonicNowMs,
      args.readDescriptor,
    );
    const committedLiveSnapshot = await readSupervisorServiceSnapshot(stage.live.path);
    if (committedLiveSnapshot.sha256 !== stage.staged.desired_service_sha256) {
      throw new Error(
        `Interrupted cutover ${journal.operation_id} found a concurrent supervisor publication `
        + "during final target verification; refusing to commit mixed source and effective state.",
      );
    }
    await writeCutoverJournal(cutoverRoot, {
      ...journal,
      phase: "committed",
      updated_at: args.now?.() ?? new Date().toISOString(),
      supervisor_readiness: {
        ...readiness,
        source_sha256: stage.staged.desired_service_sha256,
        staged_service_path: stage.staged.path,
        target_effective_config_sha256: effective.effective_config_sha256,
      },
    });
    // The committed journal is the crash boundary. Re-enter the ordinary
    // committed recovery path so its exact target proofs and retirement order
    // remain the single authority for cleanup.
    return recoverInterruptedCutover(args);
  }
  if (journal.phase === "committed") {
    await assertFilesystemIdentityCurrent(installsRootIdentity, "Install root");
    await assertFilesystemIdentityCurrent(currentLinkParentIdentity, "Current-link parent");
    await assertFilesystemIdentityCurrent(wrapperParentIdentity, "Bootstrap-wrapper parent");
    await assertFilesystemIdentityCurrent(targetInstallIdentity, "Target install");
    await atomicallyPromoteInstall(
      installsRoot,
      journal.target_install_path,
      {
        operationId: journal.operation_id,
        expectedCurrentInstallPaths: [
          journal.previous_install_path,
          journal.target_install_path,
        ],
      },
    );
    await verifySelfUpgradeDaemons(
      journal.plan_daemons,
      journal.host,
      args.authToken,
      targetBuild.git_head,
      {
        currentLink: journal.current_link,
        wrapperPath: journal.wrapper_path,
      },
      args.createAdminClient,
      args.sleep,
      args.monotonicNowMs,
      args.readDescriptor,
    );
    const readiness = journal.supervisor_readiness;
    if (readiness.status === "ready") {
      const targetHash = readiness.target_effective_config_sha256;
      const expectedIdentity = readiness.previous_effective_state?.service_identity;
      if (!targetHash || !expectedIdentity) {
        throw new Error(`Committed cutover journal ${journal.operation_id} lacks target effective-state authority.`);
      }
      const descriptor = journal.descriptors.find(
        (candidate) => candidate.supervisor.kind === readiness.supervisor_kinds[0],
      );
      if (!descriptor) {
        throw new Error(`Committed cutover journal ${journal.operation_id} lacks an effective-state descriptor.`);
      }
      const effective = await args.inspectSupervisorEffectiveState(descriptor);
      if (
        !effective.loaded
        || !effective.running
        || effective.service_identity !== expectedIdentity
        || effective.effective_config_sha256 !== targetHash
      ) {
        throw new Error(
          `Committed cutover ${journal.operation_id} has not re-established exact target supervisor state.`,
        );
      }
    }
    await restoreMaintenanceModes(maintenanceBefore, {
      readDescriptor: args.readDescriptor,
      writeDescriptor: args.writeDescriptor,
    });
    await removeCutoverJournal(cutoverRoot, journal.operation_id, {
      removeArtifacts: false,
      expectedJournalIdentity: loadedJournal.journalIdentity,
      expectedRootIdentity: loadedJournal.rootIdentity,
    });
    if (journal.state_snapshot) {
      if (journal.state_snapshot.rollback_candidate_path) {
        await rm(journal.state_snapshot.rollback_candidate_path, { force: true });
      }
      await rm(path.dirname(journal.state_snapshot.backup_path), { recursive: true, force: true });
    }
    await rm(path.join(cutoverRoot, journal.operation_id), { recursive: true, force: true });
    return;
  }

  // Any phase at or beyond the first stop intent is crash-ambiguous. Stop the
  // recorded supervisor identities idempotently before restoring state bytes.
  const stopResults = await stopDaemons(journal.descriptors, args);
  if (journal.state_snapshot) {
    const expectedDatabasePath = resolveStatePaths({ homeDir: args.homeDir }).dbPath;
    const expectedBackupRoot = path.join(
      path.dirname(expectedDatabasePath),
      ".self-upgrade-backups",
      journal.operation_id,
    );
    const relativeBackup = path.relative(expectedBackupRoot, path.resolve(journal.state_snapshot.backup_path));
    if (!relativeBackup || relativeBackup.startsWith("..") || path.isAbsolute(relativeBackup)) {
      throw new Error(`Interrupted cutover journal ${journal.operation_id} has a foreign state backup.`);
    }
    if (path.resolve(journal.state_snapshot.database_path) !== path.resolve(expectedDatabasePath)) {
      throw new Error(`Interrupted cutover journal ${journal.operation_id} has a foreign state database.`);
    }
    const restored = await restoreStateSnapshot(journal.state_snapshot, args.homeDir);
    if (restored.status !== "succeeded") {
      throw new Error(`Interrupted state rollback failed: ${restored.error ?? "unknown error"}`);
    }
  }
  await assertFilesystemIdentityCurrent(previousInstallIdentity, "Previous install");
  await assertFilesystemIdentityCurrent(installsRootIdentity, "Install root");
  await assertFilesystemIdentityCurrent(currentLinkParentIdentity, "Current-link parent");
  const previousBuild = await readInstallBuildInfo(journal.previous_install_path);
  if (previousBuild.git_head !== journal.previous_git_head) {
    throw new Error(`Interrupted cutover journal ${journal.operation_id} previous build changed.`);
  }
  await atomicallyPromoteInstall(
    installsRoot,
    journal.previous_install_path,
    {
      operationId: journal.operation_id,
      expectedCurrentInstallPaths: [
        journal.target_install_path,
        journal.previous_install_path,
      ],
    },
  );

  const readiness = journal.supervisor_readiness;
  if (readiness.status === "ready") {
    const livePath = readiness.live_service_path;
    const backupPath = readiness.previous_service_backup_path;
    const mode = readiness.previous_service_mode;
    if (
      !livePath
      || !backupPath
      || typeof mode !== "number"
      || !readiness.previous_service_sha256
    ) {
      throw new Error(`Interrupted cutover journal ${journal.operation_id} lacks supervisor recovery authority.`);
    }
    const expectedSupervisorBackupRoot = path.join(cutoverRoot, journal.operation_id);
    const relativeBackup = path.relative(expectedSupervisorBackupRoot, path.resolve(backupPath));
    if (!relativeBackup || relativeBackup.startsWith("..") || path.isAbsolute(relativeBackup)) {
      throw new Error(`Interrupted cutover journal ${journal.operation_id} has a foreign supervisor backup.`);
    }
    const backupSnapshot = await readSupervisorServiceSnapshot(backupPath);
    if (
      readiness.previous_service_backup_identity
      && !sameFilesystemIdentity(backupSnapshot.identity, readiness.previous_service_backup_identity)
    ) {
      throw new Error(`Interrupted cutover journal ${journal.operation_id} supervisor backup identity changed.`);
    }
    if (
      readiness.previous_service_backup_parent_identity
      && !sameFilesystemIdentity(
        backupSnapshot.parentIdentity,
        readiness.previous_service_backup_parent_identity,
      )
    ) {
      throw new Error(`Interrupted cutover journal ${journal.operation_id} supervisor backup parent changed.`);
    }
    if (backupSnapshot.sha256 !== readiness.previous_service_sha256) {
      throw new Error(`Interrupted cutover journal ${journal.operation_id} supervisor backup changed.`);
    }
    const supervisorKind = readiness.supervisor_kinds[0];
    const matchingDescriptor = journal.descriptors.find(
      (descriptor) => descriptor.supervisor.kind === supervisorKind,
    );
    if (!matchingDescriptor) {
      throw new Error(`Interrupted cutover journal ${journal.operation_id} has no matching supervisor descriptor.`);
    }
    const expectedLivePath = supervisorKind === "launchd"
      ? matchingDescriptor.supervisor.kind === "launchd"
        ? matchingDescriptor.supervisor.plistPath
        : undefined
      : matchingDescriptor.supervisor.kind === "systemd"
        ? path.join(args.homeDir, ".config", "systemd", "user", matchingDescriptor.supervisor.unit_name ?? "")
        : undefined;
    if (!expectedLivePath || path.resolve(livePath) !== path.resolve(expectedLivePath)) {
      throw new Error(`Interrupted cutover journal ${journal.operation_id} has a foreign live supervisor path.`);
    }
    const liveSnapshot = await readSupervisorServiceSnapshot(livePath);
    if (liveSnapshot.sha256 !== readiness.previous_service_sha256) {
      if (
        !readiness.source_sha256
        || liveSnapshot.sha256 !== readiness.source_sha256
      ) {
        throw new Error(
          `Interrupted cutover journal ${journal.operation_id} found a concurrent supervisor publication; refusing stale rollback.`,
        );
      }
      await replaceSupervisorServiceFile(livePath, backupSnapshot.bytes, mode, liveSnapshot);
    }
    const kinds = readiness.supervisor_kinds;
    if (kinds.length !== 1) {
      throw new Error(`Interrupted cutover journal ${journal.operation_id} has ambiguous supervisor kinds.`);
    }
    await args.reloadSupervisorDefinition(kinds[0]!);
  }

  const startResults = await startDaemons(journal.descriptors, args);
  await verifySelfUpgradeDaemons(
    journal.plan_daemons,
    journal.host,
    args.authToken,
    journal.previous_git_head,
    {
      currentLink: journal.current_link,
      wrapperPath: journal.wrapper_path,
    },
    args.createAdminClient,
    args.sleep,
    args.monotonicNowMs,
    args.readDescriptor,
  );
  if (readiness.status === "ready") {
    const expected = readiness.previous_effective_state;
    if (!expected) {
      throw new Error(`Interrupted cutover journal ${journal.operation_id} lacks prior effective supervisor state.`);
    }
    const expectedRestoredHash = readiness.restored_effective_config_sha256;
    if (!expectedRestoredHash) {
      throw new Error(`Interrupted cutover journal ${journal.operation_id} lacks restored effective-state authority.`);
    }
    const descriptor = journal.descriptors.find(
      (candidate) => candidate.supervisor.kind === expected.supervisor_kind,
    );
    if (!descriptor) {
      throw new Error(`Interrupted cutover journal ${journal.operation_id} lacks an effective-state descriptor.`);
    }
    const effective = await args.inspectSupervisorEffectiveState(descriptor);
    if (
      !effective.loaded
      || !effective.running
      || effective.service_identity !== expected.service_identity
      || effective.effective_config_sha256 !== expectedRestoredHash
      || (
        readiness.restored_exit_timeout_seconds !== undefined
        && effective.exit_timeout_seconds !== readiness.restored_exit_timeout_seconds
      )
    ) {
      throw new Error(
        `Interrupted cutover ${journal.operation_id} restored daemon build but not exact effective supervisor state `
        + `(expected ${expectedRestoredHash}/ExitTimeOut=${readiness.restored_exit_timeout_seconds ?? "n/a"}, `
        + `observed ${effective.effective_config_sha256}/ExitTimeOut=${effective.exit_timeout_seconds ?? "n/a"}).`,
      );
    }
  }
  // Receipt construction uses these results during in-process rollback. Crash
  // recovery itself is authoritative by the verified old health + journal
  // removal; retain variables here to make both stop/start operations explicit.
  void stopResults;
  void startResults;
  await restoreMaintenanceModes(maintenanceBefore, {
    readDescriptor: args.readDescriptor,
    writeDescriptor: args.writeDescriptor,
  });
  // The verified old generation is now authoritative. Retire and fsync the
  // noncommitted journal before deleting any rollback image it references.
  await removeCutoverJournal(cutoverRoot, journal.operation_id, {
    removeArtifacts: false,
    expectedJournalIdentity: loadedJournal.journalIdentity,
    expectedRootIdentity: loadedJournal.rootIdentity,
  });
  if (journal.state_snapshot) {
    await rm(path.dirname(journal.state_snapshot.backup_path), { recursive: true, force: true });
  }
  await rm(path.join(cutoverRoot, journal.operation_id), { recursive: true, force: true });
}

function isPromotedExecutionTargetFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes("bootstrap wrapper ")
    || (message.includes("daemon descriptor ") && !message.includes("daemon descriptor missing after restart"));
}

function isContinuousReadoptIdentityFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes("active_run_ids");
}

interface ExpectedDaemonIdentity {
  host: string;
  daemonId: string;
  startedAt: string;
}

function expectedDaemonIdentity(
  expectedHost: string,
  plannedDescriptor: Pick<SelfUpgradePlanDaemon, "daemon_id">,
  currentDescriptor: CalyxDaemonDescriptor | undefined,
): { identity: ExpectedDaemonIdentity; descriptor: CalyxDaemonDescriptor } {
  if (!currentDescriptor || !currentDescriptor.started_at) {
    // A newly restarted supervisor can answer health before it has atomically
    // persisted its new descriptor. Keep this under the existing bounded retry.
    throw new Error(`daemon descriptor missing after restart: ${plannedDescriptor.daemon_id}`);
  }
  if (currentDescriptor.daemon_id !== plannedDescriptor.daemon_id) {
    throw new Error(
      `daemon descriptor ${plannedDescriptor.daemon_id} identity mismatch: got ${currentDescriptor.daemon_id}`,
    );
  }
  return {
    identity: {
      host: expectedHost,
      daemonId: currentDescriptor.daemon_id,
      startedAt: currentDescriptor.started_at,
    },
    descriptor: currentDescriptor,
  };
}

function assertVerifiedDaemonIdentity(health: CalyxDaemonHealth, expected: ExpectedDaemonIdentity): void {
  if (!health.advertised_host) {
    throw new Error(`expected advertised_host ${expected.host}, but daemon did not advertise a host`);
  }
  if (health.advertised_host !== expected.host) {
    throw new Error(`expected advertised_host ${expected.host}, got ${health.advertised_host}`);
  }
  if (health.daemon_id !== expected.daemonId) {
    throw new Error(`expected daemon_id ${expected.daemonId}, got ${health.daemon_id}`);
  }
  if (health.started_at !== expected.startedAt) {
    throw new Error(`expected started_at ${expected.startedAt}, got ${health.started_at}`);
  }
}

export async function verifySelfUpgradeDaemons(
  descriptors: SelfUpgradePlanDaemon[],
  expectedHost: string,
  authToken: string,
  expectedHead: string,
  executionTarget: PromotedExecutionVerificationTarget,
  createAdminClient: typeof createCalyxAdminClient,
  sleep: (ms: number) => Promise<void>,
  monotonicNowMs: () => number,
  readCurrentDescriptor: Required<SelfUpgradeDependencies>["readDescriptor"],
  // In a preserving upgrade the restarted daemon legitimately reports
  // the re-adopted detached workers as active_runs. Verification tolerates only
  // the exact skipped-drain run ids (keyed by runs_root) and additionally asserts
  // the daemon advertises both preservation features. Omit for the strict
  // drain-and-wait and rollback paths, which still require active_runs===0.
  preservationReadopt?: { expectedActiveRunIdsByRoot: ReadonlyMap<string, readonly string[]> },
): Promise<Array<{ daemon_id: string; pid?: number; build: CalyxDaemonDescriptor["build"] }>> {
  const verified: Array<{ daemon_id: string; pid?: number; build: CalyxDaemonDescriptor["build"] }> = [];
  for (const descriptor of descriptors) {
    const verificationSignal = AbortSignal.timeout(DEFAULT_VERIFY_TIMEOUT_MS);
    const expectedActiveRunIds = preservationReadopt
      ? [...(preservationReadopt.expectedActiveRunIdsByRoot.get(descriptor.runs_root) ?? [])].sort()
      : [];
    const expectedActiveRuns = expectedActiveRunIds.length;
    const requiredFeatures = preservationReadopt
      ? [...EXPECTED_DAEMON_BASELINE_FEATURES, ...SELF_UPGRADE_PRESERVATION_FEATURES]
      : [...EXPECTED_DAEMON_BASELINE_FEATURES];
    const startedAtMs = readMonotonicNowMs(monotonicNowMs);
    let remainingPolls = boundedPollCount(DEFAULT_VERIFY_TIMEOUT_MS, VERIFY_POLL_INTERVAL_MS);
    let lastError = "daemon verification did not start";
    while (true) {
      try {
        const health = await fetchDaemonHealth(
          descriptor,
          authToken,
          createAdminClient,
          verificationSignal,
        );
        // Read after the response: a restarted supervisor can make health
        // reachable before its replacement descriptor is durably visible.
        const currentDescriptor = await readCurrentDescriptor(descriptor.daemon_id, { root: defaultDaemonsRoot() });
        const { identity: expectedIdentity, descriptor: persistedDescriptor } = expectedDaemonIdentity(
          expectedHost,
          descriptor,
          currentDescriptor,
        );
        assertVerifiedDaemonIdentity(health, expectedIdentity);
        if (health.build.git_head !== expectedHead) {
          throw new Error(`expected git_head ${expectedHead}, got ${health.build.git_head}`);
        }
        if (health.active_runs !== expectedActiveRuns) {
          throw new Error(`expected active_runs=${expectedActiveRuns}, got ${health.active_runs}`);
        }
        if (preservationReadopt) {
          const actualActiveRunIds = (
            await fetchAdminRuns(
              descriptor,
              authToken,
              createAdminClient,
              expectedIdentity,
              verificationSignal,
            )
          )
            .filter((entry) => !isTerminalState(entry.state))
            .map((entry) => entry.run_id)
            .sort();
          if (actualActiveRunIds.join("\0") !== expectedActiveRunIds.join("\0")) {
            throw new Error(
              `expected active_run_ids=${expectedActiveRunIds.join(",") || "none"}, got ${actualActiveRunIds.join(",") || "none"}`,
            );
          }
        }
        const missingFeatures = requiredFeatures.filter(
          (feature) => !health.supports_features.includes(feature),
        );
        if (missingFeatures.length > 0) {
          throw new Error(`missing baseline features: ${missingFeatures.join(", ")}`);
        }
        await assertWrapperTargetsPromotedCurrent(executionTarget);
        assertDescriptorTargetsPromotedCurrent(persistedDescriptor, executionTarget);
        verified.push({
          daemon_id: descriptor.daemon_id,
          pid: persistedDescriptor.pid,
          build: health.build,
        });
        lastError = "";
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (isPromotedExecutionTargetFailure(error) || isContinuousReadoptIdentityFailure(error)) {
          throw createSelfUpgradeError(`Failed to verify daemon "${descriptor.daemon_id}": ${lastError}`, 1);
        }
      }
      const elapsedMs = readMonotonicElapsedMs(startedAtMs, monotonicNowMs);
      if (
        verificationSignal.aborted
        || remainingPolls === 0
        || (elapsedMs !== undefined && elapsedMs >= DEFAULT_VERIFY_TIMEOUT_MS)
      ) {
        break;
      }
      await sleep(VERIFY_POLL_INTERVAL_MS);
      remainingPolls -= 1;
    }
    if (lastError) {
      throw createSelfUpgradeError(`Failed to verify daemon "${descriptor.daemon_id}": ${lastError}`, 1);
    }
  }
  return verified;
}

function formatBuildInfoLine(build: { git_head: string; built_at: string }): string {
  return `${build.git_head} @ ${build.built_at}`;
}

export function formatSelfUpgradePlan(plan: SelfUpgradePlan): string {
  const lines = [
    `host: ${plan.host}`,
    `repo_root: ${plan.repo_root}`,
    `current_head: ${plan.current_head}`,
    `target_ref: ${plan.target_ref}`,
    `target_head: ${plan.target_head ?? "unresolved"}`,
    `target_fetch: ${plan.target_evidence.fetch_remote} ${plan.target_evidence.fetch_ref}`,
    `dirty: ${plan.dirty ? "yes" : "no"}`,
    `missing_build_artifacts: ${plan.missing_build_artifacts.length === 0 ? "none" : plan.missing_build_artifacts.join(", ")}`,
    "daemons:",
  ];
  for (const daemon of plan.daemons) {
    lines.push(
      `  - ${daemon.daemon_id} pid=${daemon.pid} restart_order=${daemon.restart_order} supervisor=${daemon.supervisor.kind} build=${formatBuildInfoLine(daemon.build)} maintenance_mode=${daemon.maintenance_mode ? "true" : "false"}`,
    );
  }
  lines.push("active_runs_post_reconcile:");
  if (plan.active_runs_post_reconcile.length === 0) {
    lines.push("  - none");
  } else {
    for (const run of plan.active_runs_post_reconcile) {
      const restartSafe = run.restart_safe ? "restart_safe" : `blocking(${run.restart_block_reason ?? "unknown"})`;
      const supervisor = run.worker_supervisor ? ` supervisor=${run.worker_supervisor}` : "";
      lines.push(`  - ${run.run_id} state=${run.state} category=${run.category} ${restartSafe}${supervisor} resumable=${run.resumable ? "true" : "false"} summary=${run.summary}`);
    }
  }
  lines.push("preservation:");
  lines.push(`  policy: ${plan.preservation.policy}`);
  lines.push(`  status: ${plan.preservation.status}`);
  lines.push(`  required_features: ${plan.preservation.required_features.join(", ")}`);
  if (plan.preservation.note) {
    lines.push(`  note: ${plan.preservation.note}`);
  }
  if (plan.preservation.unavailable_reasons.length > 0) {
    lines.push("  unavailable_reasons:");
    for (const reason of plan.preservation.unavailable_reasons) {
      lines.push(`    - ${reason}`);
    }
  }
  lines.push("startup_contract:");
  if (!plan.startup_contract) {
    lines.push("  - not evaluated");
  } else {
    const verdict = plan.startup_contract;
    lines.push(`  status: ${verdict.status} (contract_source=${verdict.contract_source})`);
    lines.push(`  mutation_disposition: ${verdict.mutation_disposition}`);
    if (verdict.required_env) {
      lines.push(`  required_env: ${verdict.required_env.length === 0 ? "none" : verdict.required_env.join(", ")}`);
    }
    if (verdict.reason) {
      lines.push(`  reason: ${verdict.reason}`);
    }
    if (verdict.contract_invalid_kind) {
      lines.push(`  contract_invalid_kind: ${verdict.contract_invalid_kind}`);
    }
    for (const daemon of verdict.per_daemon) {
      const detail = daemon.status === "incompatible"
        ? ` missing=${(daemon.missing_env ?? []).join(", ") || "none"}`
          + (daemon.missing_consumer_api_secret_env
            ? ` missing_consumer_api_secret_env=${daemon.missing_consumer_api_secret_env.join(", ")}`
            : "")
          + (daemon.foreign_consumer_api_secret_env
            ? ` foreign_consumer_api_secret_env=${daemon.foreign_consumer_api_secret_env.join(", ")}`
            : "")
          + (daemon.mismatched_env ? ` mismatched_env=${daemon.mismatched_env.join(", ")}` : "")
          + (daemon.projection_violation ? ` projection_violation=${daemon.projection_violation}` : "")
        : daemon.status === "unknown"
          ? ` reason=${daemon.reason ?? "unknown"}`
          : ` provided=${(daemon.provided_env ?? []).join(", ") || "none"}`;
      lines.push(`  - ${daemon.daemon_id} supervisor=${daemon.supervisor_kind} status=${daemon.status}${detail}`);
    }
    if (verdict.remediation) {
      lines.push(`  remediation: ${verdict.remediation}`);
    }
    lines.push("  blocking_reasons:");
    if (verdict.blocking_reasons.length === 0) {
      lines.push("    - none");
    } else {
      for (const reason of verdict.blocking_reasons) {
        lines.push(`    - code=${reason.code} message=${reason.message}`);
      }
    }
  }
  lines.push("warnings:");
  if (plan.warnings.length === 0) {
    lines.push("  - none");
  } else {
    for (const warning of plan.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  lines.push("diagnostics:");
  if (plan.diagnostics.length === 0) {
    lines.push("  - none");
  } else {
    for (const diagnostic of plan.diagnostics) {
      lines.push(`  - ${diagnostic.kind} severity=${diagnostic.severity} daemon=${diagnostic.daemon_id} active_runs=${diagnostic.active_runs}`);
      for (const action of diagnostic.actions) {
        lines.push(`    action: ${action}`);
      }
    }
  }
  lines.push("blockers:");
  if (plan.blockers.length === 0) {
    lines.push("  - none");
  } else {
    for (const blocker of plan.blockers) {
      lines.push(`  - ${blocker}`);
    }
  }
  return lines.join("\n");
}

interface SingleHostOperationProjection {
  bindTarget: (targetSha: string, observedAt: string) => Promise<void>;
  transition: (transition: SelfUpgradeOperationTransition) => Promise<void>;
  stop: () => Promise<void>;
}

async function createSingleHostOperationProjection(args: {
  operationId: string;
  host: string;
  targetRef: string;
  startedAt: string;
  homeDir: string;
  now: () => string;
  settleTimeoutMs: number;
  claimOperation: typeof claimSelfUpgradeOperation;
  recordIssue: (issue: SelfUpgradeProjectionIssue) => void;
}): Promise<SingleHostOperationProjection> {
  let record = createSelfUpgradeOperation({
    operationId: args.operationId,
    writerId: `self-upgrade-writer-${randomUUID()}`,
    conductorHost: args.host,
    targetRef: args.targetRef,
    hosts: [args.host],
    dryRun: false,
    parallel: false,
    failFast: false,
    startedAt: args.startedAt,
  });
  let writer: SelfUpgradeOperationWriter | undefined;
  let available = true;
  const claimPromise = Promise.resolve().then(() => args.claimOperation(
    defaultSelfUpgradeOperationRoot(args.homeDir),
    record,
    {
      now: () => args.startedAt,
    },
  ));
  const claim = await settleFailOpenProjection(
    () => claimPromise,
    args.settleTimeoutMs,
  );
  if (claim.status === "fulfilled") {
    writer = claim.value;
    record = writer.record;
  } else {
    available = false;
    const detail = claim.status === "timeout"
      ? `did not settle within ${Math.max(0, args.settleTimeoutMs)}ms`
      : claim.error instanceof Error
        ? claim.error.message
        : String(claim.error);
    args.recordIssue({
      scope: "operation_state",
      code: "projection_unavailable",
      observed_at: args.now(),
      message: `self-upgrade operation projection claim unavailable: ${detail}`,
    });
    if (claim.status === "timeout") {
      // A late claim must not leave a live owner after the mutation path has
      // already stopped depending on this observation projection.
      void claimPromise.then((lateWriter) => lateWriter.release()).catch(() => undefined);
    }
  }

  const persist = async (
    candidate: SelfUpgradeOperationRecord,
    context: string,
  ): Promise<void> => {
    record = candidate;
    if (!available || !writer) {
      return;
    }
    const outcome = await settleFailOpenProjection(
      () => writer!.write(record),
      args.settleTimeoutMs,
    );
    if (outcome.status === "fulfilled") {
      record = outcome.value;
      return;
    }
    available = false;
    const detail = outcome.status === "timeout"
      ? `did not settle within ${Math.max(0, args.settleTimeoutMs)}ms`
      : outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error);
    args.recordIssue({
      scope: "operation_state",
      code: "projection_unavailable",
      observed_at: args.now(),
      message: `self-upgrade operation projection unavailable at ${context}: ${detail}`,
    });
  };

  return {
    async bindTarget(targetSha, observedAt): Promise<void> {
      try {
        await persist(
          bindSelfUpgradeOperationTarget(record, targetSha, observedAt),
          "target binding",
        );
      } catch (error) {
        available = false;
        args.recordIssue({
          scope: "operation_state",
          code: "projection_unavailable",
          observed_at: args.now(),
          message: `self-upgrade operation target projection unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    },
    async transition(transition): Promise<void> {
      try {
        const applied = applySelfUpgradeOperationTransition(record, transition);
        if (
          applied.disposition === "conflict"
          || applied.disposition === "bounded_drop"
        ) {
          available = false;
          args.recordIssue({
            scope: "operation_state",
            code: "projection_unavailable",
            observed_at: args.now(),
            message: `self-upgrade operation projection rejected ${transition.kind} transition ${transition.transition_id} (${applied.disposition})`,
          });
          return;
        }
        if (applied.disposition === "applied") {
          await persist(applied.record, transition.kind);
        }
      } catch (error) {
        available = false;
        args.recordIssue({
          scope: "operation_state",
          code: "projection_unavailable",
          observed_at: args.now(),
          message: `self-upgrade operation projection could not reduce ${transition.kind}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    },
    async stop(): Promise<void> {
      if (!writer) {
        return;
      }
      const release = await settleFailOpenProjection(
        () => writer!.release(),
        args.settleTimeoutMs,
      );
      if (release.status === "fulfilled") {
        return;
      }
      const detail = release.status === "timeout"
        ? `did not settle within ${Math.max(0, args.settleTimeoutMs)}ms; release may still complete`
        : release.error instanceof Error
          ? release.error.message
          : String(release.error);
      args.recordIssue({
        scope: "operation_state",
        code: "cleanup_unavailable",
        observed_at: args.now(),
        message: `self-upgrade operation writer release ${detail}; stale-owner cleanup remains available`,
      });
    },
  };
}

async function executeSelfUpgradePipeline(
  requestedOptions: SelfUpgradeOptions,
  dependencies: SelfUpgradeDependencies = {},
): Promise<SelfUpgradeResult> {
  let options = { ...requestedOptions };
  const homeDir = dependencies.homeDir ?? (() => homedir());
  const resolveAgentsInfraRootDependency =
    dependencies.resolveAgentsInfraRoot ?? resolveAgentsInfraRoot;
  const createSupervisorAdapterDependency =
    dependencies.createSupervisorAdapter
    ?? ((descriptor: CalyxDaemonDescriptor) => createSupervisorAdapter(descriptor));
  const runSupervisorStageDependency =
    dependencies.runSupervisorStage ?? defaultRunSupervisorStage;
  const runTargetStatePlanDependency =
    dependencies.runTargetStatePlan ?? defaultRunTargetStatePlan;
  const runTargetStateMigrateDependency =
    dependencies.runTargetStateMigrate ?? defaultRunTargetStateMigrate;
  const reloadSupervisorDefinitionDependency =
    dependencies.reloadSupervisorDefinition ?? defaultReloadSupervisorDefinition;
  const inspectSupervisorEffectiveStateDependency =
    dependencies.inspectSupervisorEffectiveState ?? defaultInspectSupervisorEffectiveState;
  const prepareSupervisorCutoverDependency =
    dependencies.prepareSupervisorCutover
    ?? ((args: {
      plan: SelfUpgradePlan;
      preparedInstall: VersionedInstallReceipt;
      descriptors: CalyxDaemonDescriptor[];
      operationId: string;
      homeDir: string;
    }) => prepareCanonicalSupervisorCutover({
      ...args,
      resolveAgentsInfraRoot: resolveAgentsInfraRootDependency,
      runSupervisorStage: runSupervisorStageDependency,
      reloadSupervisorDefinition: reloadSupervisorDefinitionDependency,
      createSupervisorAdapter: createSupervisorAdapterDependency,
      inspectSupervisorEffectiveState: inspectSupervisorEffectiveStateDependency,
    }));
  const deps: Required<SelfUpgradeDependencies> = {
    now: dependencies.now ?? (() => new Date().toISOString()),
    sleep: dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    homeDir,
    createAdminClient: dependencies.createAdminClient ?? createCalyxAdminClient,
    resolveAgentsInfraRoot: resolveAgentsInfraRootDependency,
    resolveCurrentHostAlias: dependencies.resolveCurrentHostAlias ?? resolveCurrentHostAlias,
    resolveRepo: dependencies.resolveRepo ?? resolveRepo,
    readHostsTruth: dependencies.readHostsTruth ?? readHostsTruth,
    listDescriptors: dependencies.listDescriptors ?? listDescriptors,
    readDescriptor: dependencies.readDescriptor ?? readDescriptor,
    writeDescriptor: dependencies.writeDescriptor ?? writeDescriptor,
    createRunService:
      dependencies.createRunService
      ?? ((args: { runsRoot: string }) => {
        const sink = new OrchestrationLedgerSink({ source: "self-upgrade" });
        return new RunService({
          runsRoot: args.runsRoot,
          eventLogIngest: (event) => sink.ingestStreamEvent(event),
          runIndex: new RunIndexProjection(),
        });
      }),
    createSupervisorAdapter: createSupervisorAdapterDependency,
    resolveSupervisorEnvNames:
      dependencies.resolveSupervisorEnvNames
      ?? ((descriptor, expectedHost) => defaultResolveSupervisorEnvNames(descriptor, homeDir(), expectedHost)),
    acquireLock: dependencies.acquireLock ?? acquireSelfUpgradeLock,
    monotonicNowMs: dependencies.monotonicNowMs ?? (() => performance.now()),
    appendEventProjection: dependencies.appendEventProjection ?? appendControlEvent,
    eventProjectionSettleTimeoutMs:
      dependencies.eventProjectionSettleTimeoutMs ?? DEFAULT_SELF_UPGRADE_PROJECTION_SETTLE_MS,
    operationProjectionSettleTimeoutMs:
      dependencies.operationProjectionSettleTimeoutMs ?? DEFAULT_SELF_UPGRADE_PROJECTION_SETTLE_MS,
    claimOperation: dependencies.claimOperation ?? claimSelfUpgradeOperation,
    lockReleaseSettleTimeoutMs:
      dependencies.lockReleaseSettleTimeoutMs ?? DEFAULT_SELF_UPGRADE_PROJECTION_SETTLE_MS,
    statusProjectionStream: dependencies.statusProjectionStream ?? process.stderr,
    onPhase: dependencies.onPhase ?? (() => {}),
    writeReceipt: dependencies.writeReceipt ?? writeSelfUpgradeReceiptDurable,
    execGit: dependencies.execGit ?? defaultExecGit,
    runBuild: dependencies.runBuild ?? defaultRunBuild,
    prepareInstall: dependencies.prepareInstall ?? prepareVersionedInstall,
    promoteInstall: dependencies.promoteInstall ?? promoteVersionedInstall,
    prepareSupervisorCutover: prepareSupervisorCutoverDependency,
    runSupervisorStage: runSupervisorStageDependency,
    runTargetStatePlan: runTargetStatePlanDependency,
    runTargetStateMigrate: runTargetStateMigrateDependency,
    runTargetOwnedUpgrade: dependencies.runTargetOwnedUpgrade ?? defaultRunTargetOwnedUpgrade,
    recoverInterruptedCutover:
      dependencies.recoverInterruptedCutover ?? recoverInterruptedCutover,
    removeTargetHandoff: dependencies.removeTargetHandoff ?? removeTargetHandoff,
    reloadSupervisorDefinition: reloadSupervisorDefinitionDependency,
    inspectSupervisorEffectiveState: inspectSupervisorEffectiveStateDependency,
    prepareStateCutover: dependencies.prepareStateCutover ?? prepareStateCutoverSnapshot,
    installBootstrap: dependencies.installBootstrap ?? installBootstrap,
  };
  const supervisorCutoverAvailable =
    dependencies.prepareSupervisorCutover !== undefined
    || await deps.resolveAgentsInfraRoot()
      .then((root) => root
        ? pathExists(path.join(root, "scripts", "calyx-run-service.mjs"))
        : false)
      .catch(() => false);
  const targetHandoff = options.targetHandoffOperationId
    ? await readTargetHandoff(deps.homeDir(), options.targetHandoffOperationId)
    : undefined;
  if (targetHandoff) {
    options = {
      ...options,
      host: targetHandoff.request.host,
      ...(targetHandoff.fleet_operation_id
        ? { fleetOperationId: targetHandoff.fleet_operation_id }
        : {}),
      to: targetHandoff.request.target_ref,
      targetSha: targetHandoff.request.target_evidence.target_sha,
      targetEvidence: targetHandoff.request.target_evidence,
      force: targetHandoff.request.force,
      abortRuns: targetHandoff.request.abort_runs,
      // A pre-POL-2048 installed planner writes no drain_all field: preserve
      // its v1 request semantics while the prepared target takes ownership.
      drainAll: targetHandoff.request.drain_all ?? !targetHandoff.request.continuous,
      drainDeadlineMs: targetHandoff.request.drain_deadline_ms,
      targetOwnedExecution: true,
    };
  }

  const startedAt = deps.now();
  const fleetOperationId = options.fleetOperationId?.trim();
  if (
    fleetOperationId
    && (
      !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254})$/u.test(fleetOperationId)
      || fleetOperationId === "."
      || fleetOperationId === ".."
    )
  ) {
    throw new Error(`Invalid fleet self-upgrade operation id: ${fleetOperationId}`);
  }
  // Numeric anchor for progress-event `elapsed_ms`. The same injectable
  // monotonic clock measures the drain phase independently of the ISO clock
  // used for receipts and event timestamps.
  const operationStartedMs = readMonotonicNowMs(deps.monotonicNowMs);
  const lock = await deps.acquireLock({
    lockPath: defaultSelfUpgradeLockPath(deps.homeDir()),
    payload: {
      pid: process.pid,
      acquired_at: startedAt,
    },
  });
  const receiptRoot = defaultSelfUpgradeReceiptRoot(deps.homeDir());
  const buildLogRoot = path.join(deps.homeDir(), ".calyx", "self-upgrade-logs");
  const drainDeadlineMs = options.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS;
  let authToken = "";
  let restoreTargetCredentialEnvironment: (() => void) | undefined;

  let plan: SelfUpgradePlan | undefined;
  let receiptPath: string | undefined;
  let receipt: SelfUpgradeReceipt | undefined;
  let receiptWriteAttempted = false;
  let installReceipt: VersionedInstallReceipt | undefined;
  let targetAcceptance: SelfUpgradeTargetAcceptanceReceipt | undefined;
  let targetStateReadiness: SelfUpgradeTargetStateReadinessReceipt | undefined;
  let targetStateMigrated: SelfUpgradeTargetStateMigratedReceipt | undefined;
  let targetStateApplied: SelfUpgradeTargetStateAppliedReceipt | undefined;
  let stateCutover: SelfUpgradeStateCutover | undefined;
  let cutoverJournal: SelfUpgradeCutoverJournal | undefined;
  let supervisorCutover: SelfUpgradeSupervisorCutover | undefined;
  let supervisorInstallReceipt: SelfUpgradeSupervisorInstallReceipt | undefined;
  let supervisorInstallAttempted = false;
  let rollbackReceipt: SelfUpgradeRollbackReceipt | undefined;
  let explicitTargetAdoption: SelfUpgradeExplicitTargetAdoptionReceipt | undefined;
  const explicitTargetWarnings: string[] = [];
  let fullDescriptors: CalyxDaemonDescriptor[] = [];
  let previousCurrentInstall: string | undefined;
  let executionTarget: PromotedExecutionVerificationTarget | undefined;
  let cutoverCommitted = false;
  let daemonsStopped = false;
  let daemonStartAttempted = false;
  let initialStopResults: Array<{ daemon_id: string; stopped: string }> = [];
  let maintenanceModeEnabled = false;
  let maintenanceDisposition: NonNullable<SelfUpgradeReceipt["maintenance_disposition"]> | undefined;
  let artifactCleanup: NonNullable<SelfUpgradeReceipt["artifact_cleanup"]> | undefined;
  // Hoisted so the failure receipt can report partial drain duration even if
  // we crash after the drain phase started.
  let drainStartedAtMs: number | undefined;
  let drainDurationMs: number | undefined;
  const freezeDrainDuration = (): number => {
    if (drainDurationMs === undefined && drainStartedAtMs !== undefined) {
      drainDurationMs = Math.floor(
        readMonotonicElapsedMs(drainStartedAtMs, deps.monotonicNowMs) ?? 0,
      );
    }
    return drainDurationMs ?? 0;
  };
  // Hoisted so the failure (`daemon.upgrade.failed`) event can carry the same
  // operation id as the started/progress events for this operation.
  let operationId: string | undefined;
  const persistCutoverPhase = async (
    phase: SelfUpgradeCutoverJournalPhase,
    fields: Partial<Pick<SelfUpgradeCutoverJournal, "state_snapshot" | "supervisor_readiness">> = {},
  ): Promise<void> => {
    if (!cutoverJournal) {
      throw new Error(`Cannot persist self-upgrade cutover phase ${phase} before journal preparation.`);
    }
    cutoverJournal = {
      ...cutoverJournal,
      ...fields,
      phase,
      updated_at: deps.now(),
    };
    await writeCutoverJournal(
      defaultSelfUpgradeCutoverRoot(deps.homeDir()),
      cutoverJournal,
    );
  };
  let operationProjection: SingleHostOperationProjection | undefined;
  // POL-1886: hoisted so the failure receipt reports the chosen upgrade mode
  // and any runs we elected to preserve across the restart.
  let drainMode: "continuous" | "drain" = "drain";
  const readoptedRunIds: string[] = [];
  let lastPhaseElapsedMs = 0;
  let emitUpgradePhase: ((phase: CalyxUpgradePhase) => Promise<void>) | undefined;
  const eventProjectionWarnings: string[] = [];
  const projectionIssues: SelfUpgradeProjectionIssue[] = [];
  const projectionIssueKeys = new Set<string>();
  let terminalResult: SelfUpgradeResult | undefined;
  let terminalError: SelfUpgradeExecutionError | undefined;
  const recordProjectionIssue = (issue: SelfUpgradeProjectionIssue): void => {
    const key = `${issue.scope}\0${issue.code}\0${issue.message}`;
    if (projectionIssueKeys.has(key)) return;
    projectionIssueKeys.add(key);
    projectionIssues.push(issue);
    if (terminalResult) terminalResult.projection_issues = projectionIssues;
    if (terminalError) terminalError.projection_issues = projectionIssues;
  };
  /** Set to the first projection failure detail; latches the projection down. */
  let eventProjectionUnavailableDetail: string | undefined;
  const statusProjection = createFailOpenProjectionWriter(deps.statusProjectionStream, (reason) => {
    const message = `stderr projection unavailable: ${reason}`;
    eventProjectionWarnings.push(message);
    recordProjectionIssue({
      scope: "status_stderr",
      code: "projection_unavailable",
      observed_at: deps.now(),
      message,
    });
  });

  // A proven-broken projection is not re-attempted — later events must not each
  // pay the settle deadline — but every dropped event is still named in the
  // receipt. Latching silently would let a receipt report one dropped event
  // while concealing that everything after it was dropped too.
  const appendEventFailOpen = async (
    roots: readonly string[],
    event: CalyxControlEvent,
  ): Promise<boolean> => {
    if (eventProjectionUnavailableDetail !== undefined) {
      eventProjectionWarnings.push(
        `event-log projection unavailable for ${event.event_type}: `
        + `dropped after an earlier projection failure (${eventProjectionUnavailableDetail})`,
      );
      return false;
    }
    const outcome = await settleFailOpenProjection(
      () => deps.appendEventProjection([...roots], event),
      deps.eventProjectionSettleTimeoutMs,
    );
    if (outcome.status === "fulfilled") {
      return true;
    }
    const detail = outcome.status === "timeout"
      ? `did not settle within ${Math.max(0, deps.eventProjectionSettleTimeoutMs)}ms`
      : outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error);
    eventProjectionUnavailableDetail = detail;
    eventProjectionWarnings.push(
      `event-log projection unavailable for ${event.event_type}: ${detail}`,
    );
    return false;
  };

  try {
    if (targetHandoff) {
      // The first target-owned act is acceptance of the exact prepared image.
      // Only the accepted image may open canonical custody and install the
      // host-scoped credential projection into its own process.
      targetAcceptance = await acceptTargetHandoff(targetHandoff, deps.now);
      const targetCredentials = await resolveAcceptedTargetCredentialEnvironment(
        targetHandoff,
        {
          homeDir: deps.homeDir,
          env: process.env,
          resolveAgentsInfraRoot: deps.resolveAgentsInfraRoot,
          readHostsTruth: deps.readHostsTruth,
        },
      );
      restoreTargetCredentialEnvironment =
        installAcceptedTargetCredentialEnvironment(targetCredentials);
    }
    authToken = await resolveSelfUpgradeAuthToken(
      normalizeHostAlias(options.host),
      targetHandoff ? undefined : options.authToken,
      deps,
    );
    if (options.dryRun) {
      // Journal recovery is a mutation: it stops daemons, restores the SQLite
      // image, re-promotes an install, rewrites the supervisor definition, and
      // restarts. `--dry-run` must never do any of that, so a pending journal
      // is refused the same way a pending handoff is, rather than recovered.
      const pendingJournals = await listCutoverJournals(deps.homeDir());
      if (pendingJournals.length > 0) {
        throw createSelfUpgradeError(
          `Interrupted self-upgrade cutover ${
            pendingJournals.map((entry) => entry.journal.operation_id).join(", ")
          } must be recovered before a new dry-run; recovery is a mutation.\n`
          + `Recover exactly: calyx self upgrade --host ${normalizeHostAlias(options.host)}`,
          6,
        );
      }
    } else {
      await deps.recoverInterruptedCutover({
        homeDir: deps.homeDir(),
        host: normalizeHostAlias(options.host),
        authToken,
        now: deps.now,
        resolveAgentsInfraRoot: deps.resolveAgentsInfraRoot,
        runSupervisorStage: deps.runSupervisorStage,
        runTargetStatePlan: deps.runTargetStatePlan,
        createSupervisorAdapter: deps.createSupervisorAdapter,
        inspectSupervisorEffectiveState: deps.inspectSupervisorEffectiveState,
        reloadSupervisorDefinition: deps.reloadSupervisorDefinition,
        createAdminClient: deps.createAdminClient,
        sleep: deps.sleep,
        monotonicNowMs: deps.monotonicNowMs,
        readDescriptor: deps.readDescriptor,
        writeDescriptor: deps.writeDescriptor,
      });
    }
    plan = await buildPlan(options, deps);
    if (options.dryRun) {
      terminalResult = {
        status: "dry-run",
        plan,
      };
      if (projectionIssues.length > 0) {
        terminalResult.projection_issues = projectionIssues;
      }
      return terminalResult;
    }

    ensurePlanReadyForMutation(plan, supervisorCutoverAvailable);
    fullDescriptors = (await deps.listDescriptors({ root: defaultDaemonsRoot() }))
      .sort((left, right) => left.restart_order - right.restart_order || left.daemon_id.localeCompare(right.daemon_id));
    const daemonIds = uniqueDaemonIds(plan.daemons);
    const runsRoots = uniqueRunsRoots(plan.daemons);
    // Stable collision-resistant operation id == receipt basename (computed
    // up front so it is announced before the long-running phases, not only at
    // completion). The host identity remains in the typed receipt itself.
    operationId = targetHandoff?.operation_id
      ?? `self-upgrade-${formatTimestampForFilename(startedAt)}-${randomUUID()}`;
    // Narrowed const for in-try use; the hoisted `let` (string | undefined)
    // survives into the catch for the failure event.
    const opId = operationId;
    const planHost = plan.host;
    if (!fleetOperationId) {
      operationProjection = await createSingleHostOperationProjection({
        operationId: opId,
        host: planHost,
        targetRef: plan.target_ref,
        startedAt,
        homeDir: deps.homeDir(),
        now: deps.now,
        settleTimeoutMs: deps.operationProjectionSettleTimeoutMs,
        claimOperation: deps.claimOperation,
        recordIssue: recordProjectionIssue,
      });
      if (plan.target_head) {
        await operationProjection.bindTarget(plan.target_head, deps.now());
      }
      const dispatchedAt = deps.now();
      await operationProjection.transition({
        schema_version: "self-upgrade-operation/v1",
        record: "transition",
        kind: "host_dispatched",
        transition_id: selfUpgradeTransitionId([opId, "host_dispatched", planHost]),
        operation_id: opId,
        emitted_at: dispatchedAt,
        observed_at: dispatchedAt,
        host: planHost,
        dispatch: "local",
      });
    }
    // Announce on stderr so `--json` stdout stays pure (the fleet conductor
    // parses each per-host upgrade's stdout as JSON, and a single-host
    // `--json` consumer expects exactly one object). Gives an interactive
    // operator the operation id immediately, before fetch/build/restart.
    statusProjection.write(
      `calyx self upgrade operation_id=${opId} host=${planHost} target_ref=${plan.target_ref}\n`,
    );
    // Reuses `appendControlEvent` (JSONL + SQLite event_log mirror) — no new
    // transport. Watchers see these via `readEventsSince` replay / the `/events
    // /stream` SSE surface (`calyx run subscribe --event-type
    // daemon.upgrade.progress`); we do not push live SSE from the CLI.
    emitUpgradePhase = async (phase: CalyxUpgradePhase): Promise<void> => {
      const emittedAt = deps.now();
      const elapsedMs = Math.max(
        lastPhaseElapsedMs,
        Math.floor(readMonotonicElapsedMs(operationStartedMs, deps.monotonicNowMs) ?? lastPhaseElapsedMs),
      );
      lastPhaseElapsedMs = elapsedMs;
      const phaseEvent = buildControlEvent({
        now: emittedAt,
        eventType: "daemon.upgrade.progress",
        emittedBy: "self-upgrade",
        host: planHost,
        operationId: opId,
        phase,
        elapsedMs,
      }) as SelfUpgradePhaseEvent;
      // Event-log and stderr copies are independent projections. Neither is
      // allowed to roll back or abort the host mutation.
      try {
        deps.onPhase(phaseEvent);
      } catch {
        // The durable host event and final receipt remain authoritative.
      }
      await appendEventFailOpen(runsRoots, phaseEvent);
      await operationProjection?.transition(
        toSelfUpgradeProgressTransition({
          fleetOperationId: opId,
          event: phaseEvent,
          source: "local_event",
          observedAt: deps.now(),
        }),
      );
    };
    await appendEventFailOpen(
      runsRoots,
      buildControlEvent({
        now: deps.now(),
        eventType: "daemon.upgrade.started",
        emittedBy: "self-upgrade",
        host: plan.host,
        operationId: opId,
        build: {
          git_head: plan.current_head,
          built_at: startedAt,
        },
      }),
    );

    await emitUpgradePhase("fetch");

    // POL-1151/POL-1908/POL-2045: planning always supplies a pinned target SHA.
    // Re-fetch the branch, prove the planned SHA belongs to that fresh fetch,
    // then adopt the exact planned SHA. A clean non-fast-forward host can
    // hard-reset, but only after writing a recovery ref for the pre-reset HEAD.
    //
    // We fetch the *ref name* (not the SHA itself) to stay compatible with
    // the default `uploadpack.allowReachableSHA1InWant=false` server policy.
    // `git fetch origin <commit-sha>` is rejected by hosts that don't enable
    // that option (or when the SHA is no longer a ref tip due to a race
    // between conductor resolution and per-host fetch).
    const explicitTargetSha = plan.target_head?.trim();
    if (!explicitTargetSha) {
      throw createSelfUpgradeError("Self-upgrade plan has no pinned target SHA; refusing unpinned mutation.", 6);
    }
    {
      const fetchResult = await deps.execGit(
        ["fetch", plan.target_evidence.fetch_remote, plan.target_evidence.fetch_ref],
        plan.repo_root,
      );
      if (fetchResult.code !== 0) {
        throw createSelfUpgradeError(
          fetchResult.stderr.trim()
            || fetchResult.stdout.trim()
            || `git fetch ${plan.target_evidence.fetch_remote} ${plan.target_evidence.fetch_ref} failed.`,
          6,
        );
      }
      const fetchHead = await resolveGitRef(plan.repo_root, "FETCH_HEAD", deps.execGit);
      await assertExplicitTargetWasFetched({
        repoRoot: plan.repo_root,
        targetRef: plan.target_ref,
        explicitTargetSha,
        fetchHead,
        execGit: deps.execGit,
      });
      const backupPrune = await pruneExplicitTargetBackupRefs({
        repoRoot: plan.repo_root,
        now: startedAt,
        execGit: deps.execGit,
      });
      const backupPruneFields = explicitTargetBackupPruneFields(backupPrune);
      explicitTargetWarnings.push(...backupPrune.warnings);
      if (backupPrune.pruned_superseded_refs.length > 0) {
        explicitTargetWarnings.push(
          `Pruned ${backupPrune.pruned_superseded_refs.length} superseded explicit-target backup ref(s): ${backupPrune.pruned_superseded_refs.join(", ")}.`,
        );
      }
      if (backupPrune.pruned_expired_unmerged_refs.length > 0) {
        explicitTargetWarnings.push(
          `Pruned ${backupPrune.pruned_expired_unmerged_refs.length} expired unmerged explicit-target backup ref(s) after the ${Math.round(EXPLICIT_TARGET_BACKUP_REF_MAX_AGE_MS / (24 * 60 * 60 * 1_000))}-day recovery window; commits may become unrecoverable after git gc: ${backupPrune.pruned_expired_unmerged_refs.join(", ")}.`,
        );
      }
      const mergeResult = await deps.execGit(["merge", "--ff-only", explicitTargetSha], plan.repo_root);
      if (mergeResult.code === 0) {
        explicitTargetAdoption = {
          mode: "ff-only",
          target_head: explicitTargetSha,
          fetch_head: fetchHead,
          ...backupPruneFields,
        };
      } else {
        if (plan.dirty) {
          throw createSelfUpgradeError(
            mergeResult.stderr.trim() || mergeResult.stdout.trim() || `git merge --ff-only ${explicitTargetSha} failed.`,
            6,
          );
        }
        const pointOfUseDirtyPaths = await readDirtyPaths(plan.repo_root, deps.execGit);
        if (pointOfUseDirtyPaths.length > 0) {
          throw createSelfUpgradeError(
            `Refusing git reset --hard ${explicitTargetSha} because the repo became dirty after preflight: ${pointOfUseDirtyPaths.join(", ")}.`,
            6,
          );
        }
        const beforeResetHead = await resolveGitRef(plan.repo_root, "HEAD", deps.execGit);
        const backupRef = backupRefForExplicitTargetAdoption(startedAt, beforeResetHead);
        const backupResult = await deps.execGit(["branch", "--no-track", backupRef, beforeResetHead], plan.repo_root);
        if (backupResult.code !== 0) {
          throw createSelfUpgradeError(
            commandDetail(backupResult) || `git branch --no-track ${backupRef} ${beforeResetHead} failed before hard-reset adoption.`,
            6,
          );
        }
        explicitTargetAdoption = {
          mode: "hard-reset",
          target_head: explicitTargetSha,
          fetch_head: fetchHead,
          before_reset_head: beforeResetHead,
          backup_ref: backupRef,
          ...backupPruneFields,
        };
        const resetResult = await deps.execGit(["reset", "--hard", explicitTargetSha], plan.repo_root);
        if (resetResult.code !== 0) {
          throw createSelfUpgradeError(resetFailureMessage({ explicitTargetSha, mergeResult, resetResult }), 6);
        }
        explicitTargetWarnings.push(
          `Adopted explicit target ${explicitTargetSha} by hard reset; previous HEAD ${beforeResetHead} preserved at ${backupRef}.`,
        );
      }
      const adoptedHead = await resolveGitRef(plan.repo_root, "HEAD", deps.execGit);
      if (adoptedHead !== explicitTargetSha) {
        throw createSelfUpgradeError(
          `Explicit target adoption left HEAD at ${adoptedHead}, expected ${explicitTargetSha}.`,
          6,
        );
      }
    }

    // POL-2045/POL-2072: authoritative pre-mutation startup-contract gate. The
    // worktree is now at the adopted target head, so re-derive the verdict from
    // the adopted worktree + live supervisor and refuse before build/promote —
    // no promotion side-effect on incompatible. A pending source-managed
    // supervisor cutover waives only the reasons it can repair; an invalid or
    // unsupported target contract refuses here, before the first daemon stop,
    // state snapshot, or supervisor write, not three mutations later.
    await assertStartupContractCompatibleBeforePromotion(plan, deps, {
      supervisorRepairPending: supervisorCutoverAvailable,
    });

    await emitUpgradePhase("build");
    const buildLogPath = path.join(buildLogRoot, `${formatTimestampForFilename(startedAt)}-${plan.host}.log`);
    const buildResult = await deps.runBuild(plan.repo_root, buildLogPath);
    if (buildResult.code !== 0) {
      const logTail = await tailLog(buildLogPath);
      throw createSelfUpgradeError(
        `Build failed for ${plan.repo_root}.\n${logTail || buildResult.stderr.trim() || buildResult.stdout.trim()}`,
        6,
      );
    }

    const postBuildMissingArtifacts: string[] = [];
    for (const relativePath of REQUIRED_BUILD_ARTIFACTS) {
      if (!(await pathExists(path.join(plan.repo_root, relativePath)))) {
        postBuildMissingArtifacts.push(relativePath);
      }
    }
    if (postBuildMissingArtifacts.length > 0) {
      throw createSelfUpgradeError(`Build completed without required artifacts: ${postBuildMissingArtifacts.join(", ")}.`, 6);
    }

    const postBuildHeadResult = await deps.execGit(["rev-parse", "HEAD"], plan.repo_root);
    if (postBuildHeadResult.code !== 0) {
      throw createSelfUpgradeError(postBuildHeadResult.stderr.trim() || postBuildHeadResult.stdout.trim() || "Unable to resolve HEAD after build.", 6);
    }
    const postBuildHead = postBuildHeadResult.stdout.trim();
    await emitUpgradePhase("prepare");
    previousCurrentInstall = await readCurrentInstallTarget(resolveCalyxInstallsRoot({ homeDir: deps.homeDir }));
    if (!previousCurrentInstall) {
      throw createSelfUpgradeError(
        "Target-owned self-upgrade requires a previous current install so binary, supervisor, and state can share one rollback domain.",
        6,
      );
    }
    installReceipt = await deps.prepareInstall({
      repoRoot: plan.repo_root,
      gitHead: postBuildHead,
    });
    const previousBuild = await readInstallBuildInfo(previousCurrentInstall);
    if (!options.targetOwnedExecution) {
      // An explicit token authenticates only this installed planner against the
      // daemon it is replacing. It is deliberately absent from the handoff
      // below and from the target child environment. The accepted target
      // reopens canonical host-scoped credential custody from owner-only source
      // files before it performs any cutover mutation. This planner-only bridge
      // is required when a pre-consumer-API daemon cannot yet authenticate the
      // canonical operator credential.
      const artifactManifestSha256 = installReceipt.artifact_manifest_sha256;
      const artifactManifestPackages = installReceipt.artifact_manifest_packages;
      if (
        !artifactManifestSha256
        || !artifactManifestPackages
        || artifactManifestPackages.length === 0
      ) {
        throw createSelfUpgradeError(
          "Prepared target lacks a Calyx-owned artifact manifest; refusing stale-planner fallback.",
          6,
        );
      }
      const handoff: SelfUpgradeTargetHandoff = {
        schema_version: "self-upgrade-target-handoff/v1",
        operation_id: opId,
        ...(fleetOperationId ? { fleet_operation_id: fleetOperationId } : {}),
        created_at: deps.now(),
        planner: {
          entry_realpath: await realpath(process.argv[1] ?? process.execPath),
          node_realpath: await realpath(process.execPath),
          node_version: process.version,
          handoff_interface: "self-upgrade-target-handoff/v1",
          operation_schema: "self-upgrade-operation/v1",
        },
        target: {
          git_head: installReceipt.git_head,
          install_path: await realpath(installReceipt.install_path),
          bin_path: await realpath(installReceipt.bin_path),
          build_info_path: await realpath(installReceipt.build_info_path),
          build_info_sha256: await sha256RegularFileNoFollow(installReceipt.build_info_path),
          artifact_manifest_sha256: artifactManifestSha256,
          artifact_manifest_packages: [...artifactManifestPackages],
          verified_version: installReceipt.verified_version,
          planning_interface: "self-upgrade-target-planning/v1",
          startup_contract_interface: "calyx-startup-contract/v1",
        },
        previous_current: {
          install_path: await realpath(previousCurrentInstall),
          git_head: previousBuild.git_head,
          current_link: installReceipt.current_link,
        },
        request: {
          host: plan.host,
          target_ref: plan.target_ref,
          target_evidence: plan.target_evidence,
          force: options.force === true,
          abort_runs: options.abortRuns === true,
          drain_all: options.drainAll === true,
          continuous: false,
          drain_deadline_ms: drainDeadlineMs,
        },
      };
      await writeTargetHandoff(deps.homeDir(), handoff);
      await operationProjection?.stop();
      operationProjection = undefined;
      await lock.release();
      const targetResult = await deps.runTargetOwnedUpgrade(handoff);
      if (
        targetResult.operation_id !== opId
        || targetResult.receipt?.target_acceptance?.operation_id !== opId
      ) {
        throw createSelfUpgradeError(
          "Prepared target result is missing exact target-acceptance authority.",
          6,
        );
      }
      terminalResult = targetResult;
      return targetResult;
    }
    if (targetHandoff) {
      if (
        installReceipt.git_head !== targetHandoff.target.git_head
        || await realpath(installReceipt.install_path) !== targetHandoff.target.install_path
        || installReceipt.artifact_manifest_sha256 !== targetHandoff.target.artifact_manifest_sha256
      ) {
        throw createSelfUpgradeError(
          "Fresh target planning did not reproduce the accepted prepared-target identity.",
          6,
        );
      }
    }
    targetStateReadiness = assertTargetStateSchemaReady(
      await deps.runTargetStatePlan(installReceipt),
      installReceipt.git_head,
    );
    supervisorCutover = await deps.prepareSupervisorCutover({
      plan,
      preparedInstall: installReceipt,
      descriptors: fullDescriptors,
      operationId: opId,
      homeDir: deps.homeDir(),
    });
    if (supervisorCutover.readiness.target_git_head !== installReceipt.git_head) {
      throw createSelfUpgradeError(
        `Supervisor readiness is bound to ${supervisorCutover.readiness.target_git_head}, expected prepared target ${installReceipt.git_head}.`,
        6,
      );
    }
    cutoverJournal = {
      schema_version: "self-upgrade-cutover-journal/v1",
      operation_id: opId,
      host: plan.host,
      phase: "prepared",
      updated_at: deps.now(),
      previous_install_path: previousCurrentInstall,
      previous_git_head: previousBuild.git_head,
      current_link: installReceipt.current_link,
      wrapper_path: path.join(deps.homeDir(), ".agents", "run", "calyx"),
      target_install_path: installReceipt.install_path,
      descriptors: fullDescriptors,
      plan_daemons: plan.daemons,
      maintenance_before: plan.daemons.map((daemon) => ({
        daemon_id: daemon.daemon_id,
        enabled: daemon.maintenance_mode,
      })),
      ...(targetAcceptance ? { target_acceptance: targetAcceptance } : {}),
      supervisor_readiness: supervisorCutover.readiness,
    };
    await writeCutoverJournal(
      defaultSelfUpgradeCutoverRoot(deps.homeDir()),
      cutoverJournal,
    );
    // Quiesce only after every target/provider/state readiness gate has
    // completed and the prior descriptor state + quiesce intent are durable.
    // A crash during a partial descriptor rewrite therefore has an exact
    // prepared-journal recovery path.
    maintenanceModeEnabled = true;
    await setMaintenanceMode(daemonIds, true, deps);
    await persistCutoverPhase("quiesced");
    await emitUpgradePhase("supervisor_ready");
    await emitUpgradePhase("drain");
    drainStartedAtMs = readMonotonicNowMs(deps.monotonicNowMs);
    const activeRuns = await collectActiveRuns(plan.daemons, deps.createRunService);
    // The health partition still owns refusal. Within the drainable set, the
    // post-U1 classifier and live daemon features decide per run whether it is
    // preserved or must finish before restart.
    const initialBlockingRuns = activeRuns.filter((run) => run.category !== "drainable");
    const restartSafeRuns = activeRuns.filter((run) => run.restart_safe);
    const warnings = [...plan.warnings, ...explicitTargetWarnings];
    const expectedActiveRunIdsByRoot = new Map<string, string[]>();
    let remainingRuns = activeRuns;

    if (remainingRuns.length > 0) {
      const preservationAvailability = options.drainAll
        || (options.force && options.abortRuns)
        || restartSafeRuns.length === 0
        ? undefined
        : await assessPreservationAvailability(
            plan.daemons,
            authToken,
            deps.createAdminClient,
          );
      const preservationAvailable = preservationAvailability?.status === "available";
      if (preservationAvailability?.status === "unavailable") {
        warnings.push(
          `Restart-safe preservation is unavailable; draining all active runs: ${preservationAvailability.unavailable_reasons.join("; ")}.`,
        );
      }

      if (options.force && options.abortRuns) {
        warnings.push(...await abortActiveRuns(remainingRuns, deps.createRunService));
        remainingRuns = await waitForNoActiveRuns({
          descriptors: plan.daemons,
          createRunService: deps.createRunService,
          sleep: deps.sleep,
          monotonicNowMs: deps.monotonicNowMs,
          deadlineMs: drainDeadlineMs,
        });
      } else if (initialBlockingRuns.length > 0) {
        throw createSelfUpgradeError(
          `Blocking active runs remain after reconcile (${initialBlockingRuns.map((run) => `${run.run_id}:${run.category}`).join(", ")}).`,
          1,
        );
      } else {
        const preservedRunIds = preservationAvailable
          ? new Set(restartSafeRuns.map((run) => run.run_id))
          : undefined;
        remainingRuns = await waitForNoActiveRuns({
          descriptors: plan.daemons,
          createRunService: deps.createRunService,
          sleep: deps.sleep,
          monotonicNowMs: deps.monotonicNowMs,
          deadlineMs: drainDeadlineMs,
          ...(preservedRunIds ? { preservedRunIds } : {}),
        });
        if (
          preservedRunIds
          && remainingRuns.every((run) => preservedRunIds.has(run.run_id) && run.restart_safe)
        ) {
          drainMode = remainingRuns.length > 0 ? "continuous" : "drain";
          for (const run of remainingRuns) {
            readoptedRunIds.push(run.run_id);
            const expectedIds = expectedActiveRunIdsByRoot.get(run.runs_root) ?? [];
            expectedIds.push(run.run_id);
            expectedActiveRunIdsByRoot.set(run.runs_root, expectedIds);
          }
          remainingRuns = [];
        }
      }
      if (remainingRuns.length > 0) {
        throw createSelfUpgradeError(
          `Active runs remained after drain deadline (${remainingRuns.map((run) => run.run_id).join(", ")}).`,
          1,
        );
      }
    }

    // Freeze after all drain-phase work, including classification and
    // preservation attestation. Later phases must not inflate it.
    const completedDrainDurationMs = freezeDrainDuration();
    // Prove the rollback-safe snapshot plus bounded target-growth reserve fits
    // before the first daemon stop. Snapshot creation repeats this admission
    // check at point of use.
    await preflightStateCutoverCapacity(
      deps.homeDir(),
      opId,
      targetStateReadiness.pending_migration_growth_bounds,
    );
    await emitUpgradePhase("state_snapshot");
    await persistCutoverPhase("daemons_stopping");
    initialStopResults = await stopDaemons(fullDescriptors, deps);
    daemonsStopped = true;
    await persistCutoverPhase("daemons_stopped");
    await persistCutoverPhase("state_snapshotting");
    stateCutover = await deps.prepareStateCutover({
      operationId: opId,
      homeDir: deps.homeDir(),
      migrationGrowthBounds:
        targetStateReadiness.pending_migration_growth_bounds,
    });
    await persistCutoverPhase("state_snapshotted", {
      state_snapshot: stateCutover.snapshot,
    });
    // Converge the schema here, not as a side effect of the next daemon boot.
    // Daemons are stopped, the rollback image is pinned, and neither the
    // supervisor unit nor the `current` symlink has moved — so a migration
    // failure unwinds state alone, and a host whose store never advanced
    // because nothing ran on it is repaired by the same operation that
    // repairs its binary.
    await persistCutoverPhase("state_migrating");
    targetStateMigrated = assertTargetStateSchemaMigrated(
      await deps.runTargetStateMigrate(installReceipt),
      installReceipt.git_head,
      targetStateReadiness,
    );
    // Measure growth against the snapshot while the store is quiet. After the
    // restart this number is migration growth plus daemon runtime writes.
    const targetGrowth = await verifyTargetStateGrowthBound(stateCutover.snapshot);
    targetStateMigrated = {
      ...targetStateMigrated,
      migration_growth_bound_bytes: targetGrowth.boundBytes,
      observed_state_growth_bytes: targetGrowth.observedGrowthBytes,
    };
    await persistCutoverPhase("state_migrated");
    await emitUpgradePhase("supervisor_install");
    await persistCutoverPhase("supervisor_installing");
    supervisorInstallAttempted = true;
    supervisorInstallReceipt = await supervisorCutover.install();
    await persistCutoverPhase("supervisor_installed");
    // The target manifest remains the final knowledge gate. A source-managed
    // supervisor provider may repair the live definition, but it cannot
    // authorize promotion itself; the target startup contract is re-evaluated
    // against the installed/live definition after the cutover.
    await assertStartupContractCompatibleBeforePromotion(plan, deps);
    await emitUpgradePhase("promote");
    await persistCutoverPhase("binary_promoting");
    installReceipt = await deps.promoteInstall(installReceipt, {
      operationId: opId,
      expectedCurrentInstallPaths: [previousCurrentInstall],
    });
    await persistCutoverPhase("binary_promoted");
    const wrapperBootstrap = await migrateBootstrapWrapperToPromotedInstall({
      homeRoot: deps.homeDir(),
      repoRoot: plan.repo_root,
      installReceipt,
      installBootstrap: deps.installBootstrap,
    });
    executionTarget = {
      currentLink: installReceipt.current_link,
      wrapperPath: wrapperBootstrap.wrapperPath,
    };
    plan.promoted_build = {
      git_head: installReceipt.git_head,
      install_path: installReceipt.install_path,
      current_link: installReceipt.current_link,
    };
    await emitUpgradePhase("restart");
    await persistCutoverPhase("target_starting");
    daemonStartAttempted = true;
    const startResults = await startDaemons(fullDescriptors, deps);
    await persistCutoverPhase("target_started");
    const afterHeadResult = await deps.execGit(["rev-parse", "HEAD"], plan.repo_root);
    if (afterHeadResult.code !== 0) {
      throw createSelfUpgradeError(afterHeadResult.stderr.trim() || afterHeadResult.stdout.trim() || "Unable to resolve HEAD after restart.", 6);
    }
    const afterHead = afterHeadResult.stdout.trim();
    await emitUpgradePhase("health_wait");
    const verifiedDaemons = await verifySelfUpgradeDaemons(
      plan.daemons,
      plan.host,
      authToken,
      afterHead,
      executionTarget,
      deps.createAdminClient,
      deps.sleep,
      deps.monotonicNowMs,
      deps.readDescriptor,
      drainMode === "continuous" ? { expectedActiveRunIdsByRoot } : undefined,
    );
    if (supervisorCutover.verifyInstalled) {
      const effectiveState = await supervisorCutover.verifyInstalled();
      supervisorInstallReceipt = {
        ...supervisorInstallReceipt,
        effective_state: effectiveState,
      };
    }
    // The promoted binary re-reads the ledger it was migrated against. This is
    // the convergence proof, not the convergence: the cutover already applied.
    targetStateApplied = assertTargetStateSchemaApplied(
      await deps.runTargetStatePlan(installReceipt),
      installReceipt.git_head,
    );
    daemonsStopped = false;
    // `verifyInstalled()` republishes the readiness with the effective config it
    // actually observed on the installed supervisor. Bind that observation into
    // the journal so committed-phase crash recovery re-requires the same state.
    await persistCutoverPhase("target_verified", {
      supervisor_readiness: supervisorCutover.readiness,
    });

    // Commit the accepted target while dispatch is still quiesced. Re-opening
    // dispatch is a finish-forward action: a crash after this write must never
    // roll back a target that may already have accepted post-upgrade work.
    await persistCutoverPhase("committed");
    cutoverCommitted = true;
    await restoreMaintenanceModes(cutoverJournal.maintenance_before ?? [], deps);
    maintenanceModeEnabled = false;
    const priorMaintenanceEngaged = (cutoverJournal.maintenance_before ?? [])
      .some((entry) => entry.enabled);
    maintenanceDisposition = {
      status: priorMaintenanceEngaged ? "engaged" : "released",
      reason: "target health, migration convergence, and effective supervisor state verified after durable commit; prior maintenance state restored",
    };

    // Retention is post-commit housekeeping. It cannot reverse an accepted
    // target or delete the prior rollback install before the commit boundary.
    if (installReceipt) {
      try {
        const liveDescriptors = (await Promise.all(
          fullDescriptors.map((descriptor) => deps.readDescriptor(descriptor.daemon_id, { root: defaultDaemonsRoot() })),
        )).filter((descriptor): descriptor is CalyxDaemonDescriptor => Boolean(descriptor));
        const pruneReceipt = await pruneVersionedInstalls({
          installsRoot: path.dirname(installReceipt.current_link),
          keep: 3,
          descriptors: liveDescriptors.length > 0 ? liveDescriptors : fullDescriptors,
          wrapperPath: path.join(deps.homeDir(), ".agents", "run", "calyx"),
        });
        installReceipt = {
          ...installReceipt,
          pruned: pruneReceipt.pruned,
          swept_stale_temps: pruneReceipt.swept_stale_temps,
        };
      } catch (pruneError) {
        warnings.push(`post-commit install pruning failed: ${errorMessage(pruneError)}`);
      }
    }

    const commitListResult = await deps.execGit(["log", `${plan.current_head}..${afterHead}`, "--format=%h %s"], plan.repo_root);
    const commitList = commitListResult.code === 0
      ? commitListResult.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
      : [];

    const supervisorBackupPath = supervisorCutover.readiness.previous_service_backup_path;
    let stateBackupStatus: "cleaned" | "retained" | "not_created" =
      stateCutover ? "retained" : "not_created";
    let supervisorBackupStatus: "cleaned" | "retained" | "not_created" =
      supervisorBackupPath ? "retained" : "not_created";
    artifactCleanup = {
      state_backup: stateBackupStatus,
      supervisor_backup: supervisorBackupStatus,
      retained_paths: [
        ...(stateBackupStatus === "retained"
          ? [
              stateCutover.snapshot.backup_path,
              ...(stateCutover.snapshot.rollback_candidate_path
                ? [stateCutover.snapshot.rollback_candidate_path]
                : []),
              ...(stateCutover.snapshot.rollback_reserve_path
                ? [stateCutover.snapshot.rollback_reserve_path]
                : []),
            ]
          : []),
        ...(supervisorBackupStatus === "retained" && supervisorBackupPath
          ? [supervisorBackupPath]
          : []),
      ],
      errors: [],
    };

    // Finalization: daemons verified, host is at target; now persisting the
    // receipt. Emitted before the write so a watcher can distinguish "still
    // restarting/health-waiting" from "done, writing receipt." Only a phase
    // that actually reached the host event log is relayed as `host_event`.
    await emitUpgradePhase("finalize");
    const completedAt = deps.now();
    receipt = {
      schema_version: "self-upgrade-receipt/v1",
      operation_id: opId,
      ...(fleetOperationId ? { fleet_operation_id: fleetOperationId } : {}),
      host: plan.host,
      target_ref: plan.target_ref,
      target_evidence: plan.target_evidence,
      status: "succeeded",
      started_at: startedAt,
      completed_at: completedAt,
      repo_root: plan.repo_root,
      before_head: plan.current_head,
      after_head: afterHead,
      commit_list: commitList,
      before_builds: plan.daemons.map((daemon) => ({
        daemon_id: daemon.daemon_id,
        pid: daemon.pid,
        build: daemon.build,
      })),
      after_builds: verifiedDaemons,
      active_run_classification: activeRuns,
      drain_mode: drainMode,
      readopted_run_ids: readoptedRunIds,
      drain_duration_ms: completedDrainDurationMs,
      daemons_restarted: daemonRestartReceipt(plan.daemons, initialStopResults, startResults),
      ...(explicitTargetAdoption ? { explicit_target_adoption: explicitTargetAdoption } : {}),
      install: installReceipt,
      ...(targetAcceptance ? { target_acceptance: targetAcceptance } : {}),
      ...(targetStateReadiness ? { target_state_readiness: targetStateReadiness } : {}),
      ...(targetStateMigrated ? { target_state_migrated: targetStateMigrated } : {}),
      ...(targetStateApplied ? { target_state_applied: targetStateApplied } : {}),
      state_snapshot: stateCutover.snapshot,
      supervisor_readiness: supervisorCutover.readiness,
      supervisor_install: supervisorInstallReceipt,
      maintenance_disposition: maintenanceDisposition,
      artifact_cleanup: artifactCleanup,
      warnings: [...warnings, ...eventProjectionWarnings],
    };
    receiptWriteAttempted = true;
    receiptPath = await deps.writeReceipt(receiptRoot, opId, serializeSelfUpgradeReceipt(receipt));
    let journalRetired = false;
    try {
      await removeCutoverJournal(
        defaultSelfUpgradeCutoverRoot(deps.homeDir()),
        opId,
        { removeArtifacts: false },
      );
      journalRetired = true;
    } catch (cleanupError) {
      const warning = `committed cutover journal cleanup failed: ${errorMessage(cleanupError)}`;
      warnings.push(warning);
      statusProjection.write(
        `warning: ${warning}\n`,
      );
    }
    if (journalRetired) {
      const cleanupErrors: string[] = [];
      if (stateCutover) {
        try {
          await stateCutover.cleanup();
        } catch (cleanupError) {
          cleanupErrors.push(`state backup cleanup failed: ${errorMessage(cleanupError)}`);
        }
        stateBackupStatus = await pathExists(stateCutover.snapshot.backup_path)
          || (
            stateCutover.snapshot.rollback_candidate_path !== undefined
            && await pathExists(stateCutover.snapshot.rollback_candidate_path)
          )
          || (
            stateCutover.snapshot.rollback_reserve_path !== undefined
            && await pathExists(stateCutover.snapshot.rollback_reserve_path)
          )
          ? "retained"
          : "cleaned";
        if (
          stateBackupStatus === "retained"
          && !cleanupErrors.some((entry) => entry.startsWith("state backup"))
        ) {
          cleanupErrors.push("state backup cleanup returned without removing every rollback artifact");
        }
      }
      if (supervisorBackupPath) {
        try {
          await rm(path.dirname(supervisorBackupPath), { recursive: true, force: true });
        } catch (cleanupError) {
          cleanupErrors.push(`supervisor backup cleanup failed: ${errorMessage(cleanupError)}`);
        }
        supervisorBackupStatus = await pathExists(supervisorBackupPath)
          ? "retained"
          : "cleaned";
        if (
          supervisorBackupStatus === "retained"
          && !cleanupErrors.some((entry) => entry.startsWith("supervisor backup"))
        ) {
          cleanupErrors.push("supervisor backup cleanup returned without removing the backup");
        }
      }
      const stateArtifactCandidates = stateCutover
        ? [
            stateCutover.snapshot.backup_path,
            ...(stateCutover.snapshot.rollback_candidate_path
              ? [stateCutover.snapshot.rollback_candidate_path]
              : []),
            ...(stateCutover.snapshot.rollback_reserve_path
              ? [stateCutover.snapshot.rollback_reserve_path]
              : []),
          ]
        : [];
      const retainedStatePaths = (
        await Promise.all(stateArtifactCandidates.map(async (candidate) => ({
          candidate,
          retained: await pathExists(candidate),
        })))
      ).filter((entry) => entry.retained).map((entry) => entry.candidate);
      artifactCleanup = {
        state_backup: stateBackupStatus,
        supervisor_backup: supervisorBackupStatus,
        retained_paths: [
          ...retainedStatePaths,
          ...(supervisorBackupStatus === "retained" && supervisorBackupPath
            ? [supervisorBackupPath]
            : []),
        ],
        errors: cleanupErrors,
      };
      warnings.push(...cleanupErrors);
      receipt = {
        ...receipt,
        artifact_cleanup: artifactCleanup,
        warnings: [...warnings, ...eventProjectionWarnings],
      };
      try {
        receiptPath = await deps.writeReceipt(
          receiptRoot,
          opId,
          serializeSelfUpgradeReceipt(receipt),
        );
      } catch (cleanupReceiptError) {
        statusProjection.write(
          `warning: unable to persist post-authority artifact cleanup: ${errorMessage(cleanupReceiptError)}\n`,
        );
      }
    } else {
      receipt = {
        ...receipt,
        artifact_cleanup: artifactCleanup,
        warnings: [...warnings, ...eventProjectionWarnings],
      };
      try {
        receiptPath = await deps.writeReceipt(
          receiptRoot,
          opId,
          serializeSelfUpgradeReceipt(receipt),
        );
      } catch (journalWarningWriteError) {
        statusProjection.write(
          `warning: unable to persist retained-journal warning: ${errorMessage(journalWarningWriteError)}\n`,
        );
      }
    }
    if (targetHandoff && journalRetired) {
      await removeTargetHandoff(deps.homeDir(), opId).catch((cleanupError) => {
        statusProjection.write(
          `warning: target handoff cleanup failed: ${errorMessage(cleanupError)}\n`,
        );
      });
    }
    const completedEventDurable = await appendEventFailOpen(
      runsRoots,
      buildControlEvent({
        now: deps.now(),
        eventType: "daemon.upgrade.completed",
        emittedBy: "self-upgrade",
        host: plan.host,
        operationId: opId,
        build: {
          git_head: afterHead,
          built_at: receipt.completed_at,
        },
      }),
    );
    if (!completedEventDurable) {
      const receiptWithLateWarning: SelfUpgradeReceipt = {
        ...receipt,
        warnings: [...warnings, ...eventProjectionWarnings],
      };
      try {
        await deps.writeReceipt(receiptRoot, opId, serializeSelfUpgradeReceipt(receiptWithLateWarning));
        receipt = receiptWithLateWarning;
      } catch (lateWarningWriteError) {
        // The already-durable success receipt remains authority. Losing the
        // additive projection-warning rewrite cannot reverse the mutation.
        statusProjection.write(
          `warning: unable to append late projection loss to durable receipt: ${lateWarningWriteError instanceof Error ? lateWarningWriteError.message : String(lateWarningWriteError)}\n`,
        );
      }
    }
    if (operationProjection) {
      const projectedAt = deps.now();
      const receiptLocator = {
        host: planHost,
        route: adminOperationRoutes.selfUpgrade.receipt({ operationId: opId }),
      };
      await operationProjection.transition({
        schema_version: "self-upgrade-operation/v1",
        record: "transition",
        kind: "host_result",
        transition_id: selfUpgradeTransitionId([opId, "host_result", planHost]),
        operation_id: opId,
        emitted_at: projectedAt,
        observed_at: projectedAt,
        host: planHost,
        status: "succeeded",
        elapsed_ms: lastPhaseElapsedMs,
        relay_mode: "local",
        before_head: plan.current_head,
        after_head: afterHead,
        receipt_locator: receiptLocator,
      });
      await operationProjection.transition({
        schema_version: "self-upgrade-operation/v1",
        record: "transition",
        kind: "fleet_final",
        transition_id: selfUpgradeTransitionId([opId, "fleet_final"]),
        operation_id: opId,
        emitted_at: projectedAt,
        observed_at: deps.now(),
        status: "succeeded",
        receipt_path: receiptPath,
        rows: [{
          host: planHost,
          status: "succeeded",
          before_head: plan.current_head,
          after_head: afterHead,
          elapsed_ms: lastPhaseElapsedMs,
          receipt_locator: receiptLocator,
        }],
      });
    }

    terminalResult = {
      status: "succeeded",
      plan,
      operation_id: opId,
      receipt_path: receiptPath,
      receipt,
    };
    if (projectionIssues.length > 0) {
      terminalResult.projection_issues = projectionIssues;
    }
    return terminalResult;
  } catch (error) {
    if (cutoverCommitted) {
      const committedError = createSelfUpgradeError(
        `Target cutover is durably committed; post-commit receipt/publication failed without rollback: ${errorMessage(error)}`,
        6,
        plan ? { plan } : {},
      );
      if (projectionIssues.length > 0) {
        committedError.projection_issues = projectionIssues;
      }
      throw committedError;
    }
    if (plan && !options.dryRun) {
      // A drain-phase failure must freeze before rollback/restart work begins;
      // the failure receipt carries the same semantic boundary as success.
      freezeDrainDuration();
      const completedAt = deps.now();
      const message = error instanceof Error ? error.message : String(error);
      const receiptOperationId = operationId
        ?? `self-upgrade-${formatTimestampForFilename(startedAt)}-${randomUUID()}`;
      const durabilityIssues: SelfUpgradeReceiptDurabilityIssue[] = receiptWriteAttempted && !receiptPath
        ? [{
            scope: "final_receipt",
            code: "receipt_persist_failed",
            observed_at: completedAt,
            message,
          }]
        : [];
      const cutoverMutationStarted = Boolean(
        installReceipt
        && (
          daemonsStopped
          || daemonStartAttempted
          || installReceipt.promoted
          || supervisorInstallAttempted
          || (
            cutoverJournal !== undefined
            && cutoverJournal.phase !== "prepared"
            && cutoverJournal.phase !== "quiesced"
          )
        )
      );
      if (installReceipt && !cutoverCommitted && cutoverMutationStarted) {
        await emitUpgradePhase?.("rollback").catch(() => undefined);
        rollbackReceipt = await rollbackPromotedInstall({
          operationId: receiptOperationId,
          installReceipt,
          previousInstallPath: previousCurrentInstall,
          stopBeforeRestore:
            daemonStartAttempted
            || cutoverJournal?.phase === "daemons_stopping",
          initialStopResults,
          ...(stateCutover ? { restoreState: stateCutover.restore } : {}),
          ...(
            supervisorCutover
            && supervisorInstallAttempted
            && supervisorCutover.readiness.status === "ready"
              ? {
                  restoreSupervisor: async () => supervisorCutover!.restore().catch(
                    (restoreError: unknown): SelfUpgradeSupervisorRollbackReceipt => ({
                      schema_version: "self-upgrade-supervisor-rollback/v1",
                      status: "failed",
                      error: errorMessage(restoreError),
                    }),
                  ),
                  ...(supervisorCutover.verifyRestored
                    ? { verifySupervisorRestored: supervisorCutover.verifyRestored }
                    : {}),
                }
              : {}
          ),
          plan,
          fullDescriptors,
          authToken,
          executionTarget: executionTarget ?? {
            currentLink: installReceipt.current_link,
            wrapperPath: path.join(deps.homeDir(), ".agents", "run", "calyx"),
          },
          createAdminClient: deps.createAdminClient,
          sleep: deps.sleep,
          monotonicNowMs: deps.monotonicNowMs,
          readDescriptor: deps.readDescriptor,
          createSupervisorAdapter: deps.createSupervisorAdapter,
        });
      }
      if (maintenanceModeEnabled) {
        const canReleaseAfterRollback = rollbackReceipt?.status === "succeeded";
        let canReleasePreMutation = false;
        if (!cutoverMutationStarted) {
          try {
            const statuses = await Promise.all(
              fullDescriptors.map((descriptor) =>
                deps.createSupervisorAdapter(descriptor).status(descriptor)),
            );
            canReleasePreMutation = statuses.length > 0 && statuses.every((status) => status.running);
          } catch {
            canReleasePreMutation = false;
          }
        }
        if (canReleaseAfterRollback || canReleasePreMutation) {
          try {
            await restoreMaintenanceModes(
              cutoverJournal?.maintenance_before
                ?? plan.daemons.map((daemon) => ({
                  daemon_id: daemon.daemon_id,
                  enabled: daemon.maintenance_mode,
                })),
              deps,
            );
            maintenanceModeEnabled = false;
            const priorMaintenanceEngaged = (
              cutoverJournal?.maintenance_before
                ?? plan.daemons.map((daemon) => ({
                  daemon_id: daemon.daemon_id,
                  enabled: daemon.maintenance_mode,
                }))
            ).some((entry) => entry.enabled);
            maintenanceDisposition = {
              status: priorMaintenanceEngaged ? "engaged" : "released",
              reason: canReleaseAfterRollback
                ? "old state, binary, supervisor, daemon health, and prior maintenance state were verified after rollback"
                : "failure preceded cutover mutation; every original supervisor remained running and prior maintenance state was restored",
            };
          } catch (maintenanceError) {
            maintenanceDisposition = {
              status: "engaged",
              reason: `maintenance release failed: ${errorMessage(maintenanceError)}`,
            };
          }
        } else {
          maintenanceDisposition = {
            status: "engaged",
            reason: rollbackReceipt?.status === "failed"
              ? `rollback did not verify: ${rollbackReceipt.error ?? rollbackReceipt.reason ?? "unknown failure"}`
              : "cutover disposition is not proven safe for dispatch",
          };
        }
      }
      const afterHeadResult = await deps.execGit(["rev-parse", "HEAD"], plan.repo_root).catch(() => ({
        code: 1,
        stdout: "",
        stderr: "",
      }));
      const observedAfterHead = afterHeadResult.stdout.trim();
      receipt = {
        schema_version: "self-upgrade-receipt/v1",
        operation_id: receiptOperationId,
        ...(fleetOperationId ? { fleet_operation_id: fleetOperationId } : {}),
        host: plan.host,
        target_ref: plan.target_ref,
        target_evidence: plan.target_evidence,
        status: "failed",
        started_at: startedAt,
        completed_at: completedAt,
        repo_root: plan.repo_root,
        before_head: plan.current_head,
        ...(afterHeadResult.code === 0 && /^[0-9a-f]{40}$/iu.test(observedAfterHead)
          ? { after_head: observedAfterHead }
          : {}),
        commit_list: [],
        before_builds: plan.daemons.map((daemon) => ({
          daemon_id: daemon.daemon_id,
          pid: daemon.pid,
          build: daemon.build,
        })),
        after_builds: [],
        active_run_classification: plan.active_runs_post_reconcile,
        drain_mode: drainMode,
        readopted_run_ids: readoptedRunIds,
        drain_duration_ms: drainDurationMs ?? 0,
        daemons_restarted: [],
        ...(explicitTargetAdoption ? { explicit_target_adoption: explicitTargetAdoption } : {}),
        ...(installReceipt ? { install: installReceipt } : {}),
        ...(targetAcceptance ? { target_acceptance: targetAcceptance } : {}),
        ...(targetStateReadiness ? { target_state_readiness: targetStateReadiness } : {}),
        ...(targetStateMigrated ? { target_state_migrated: targetStateMigrated } : {}),
        ...(targetStateApplied ? { target_state_applied: targetStateApplied } : {}),
        ...(stateCutover ? { state_snapshot: stateCutover.snapshot } : {}),
        ...(supervisorCutover ? { supervisor_readiness: supervisorCutover.readiness } : {}),
        ...(supervisorInstallReceipt ? { supervisor_install: supervisorInstallReceipt } : {}),
        ...(rollbackReceipt ? { rollback: rollbackReceipt } : {}),
        ...(maintenanceDisposition ? { maintenance_disposition: maintenanceDisposition } : {}),
        ...(artifactCleanup ? { artifact_cleanup: artifactCleanup } : {}),
        warnings: [...plan.warnings, ...explicitTargetWarnings, ...eventProjectionWarnings],
        ...(durabilityIssues.length > 0 ? { durability_issues: durabilityIssues } : {}),
        error: message,
      };
      try {
        receiptWriteAttempted = true;
        receiptPath = await deps.writeReceipt(
          receiptRoot,
          receiptOperationId,
          serializeSelfUpgradeReceipt(receipt),
        );
      } catch (receiptError) {
        const receiptErrorMessage = receiptError instanceof Error ? receiptError.message : String(receiptError);
        receipt = {
          ...receipt,
          durability_issues: [
            ...(receipt.durability_issues ?? []),
            {
              scope: "final_receipt",
              code: "receipt_persist_failed",
              observed_at: deps.now(),
              message: receiptErrorMessage,
            },
          ],
        };
      }
      if (rollbackReceipt?.status === "succeeded") {
        const cleanupErrors: string[] = [];
        const stateBackupPath = stateCutover?.snapshot.backup_path;
        const supervisorBackupPath = supervisorCutover?.readiness.previous_service_backup_path;
        let journalRetired = cutoverJournal === undefined;
        if (cutoverJournal) {
          try {
            // The verified old generation is authoritative. The journal must
            // disappear durably before either recovery image becomes
            // nonauthoritative and eligible for cleanup.
            await removeCutoverJournal(
              defaultSelfUpgradeCutoverRoot(deps.homeDir()),
              cutoverJournal.operation_id,
              { removeArtifacts: false },
            );
            journalRetired = true;
          } catch (journalError) {
            cleanupErrors.push(`cutover journal retirement failed: ${errorMessage(journalError)}`);
          }
        }
        if (journalRetired) {
          if (stateCutover) {
            try {
              await stateCutover.cleanup();
            } catch (cleanupError) {
              cleanupErrors.push(`state backup cleanup failed: ${errorMessage(cleanupError)}`);
            }
          }
          if (supervisorBackupPath) {
            try {
              await rm(path.dirname(supervisorBackupPath), { recursive: true, force: true });
            } catch (cleanupError) {
              cleanupErrors.push(`supervisor backup cleanup failed: ${errorMessage(cleanupError)}`);
            }
          }
          if (targetHandoff) {
            try {
              await removeTargetHandoff(deps.homeDir(), receiptOperationId);
            } catch (cleanupError) {
              cleanupErrors.push(`target handoff cleanup failed: ${errorMessage(cleanupError)}`);
            }
          }
        }
        const stateBackupStatus = stateBackupPath
          ? await pathExists(stateBackupPath) ? "retained" as const : "cleaned" as const
          : "not_created" as const;
        const supervisorBackupStatus = supervisorBackupPath
          ? await pathExists(supervisorBackupPath) ? "retained" as const : "cleaned" as const
          : "not_created" as const;
        artifactCleanup = {
          state_backup: stateBackupStatus,
          supervisor_backup: supervisorBackupStatus,
          retained_paths: [
            ...(stateBackupStatus === "retained" && stateBackupPath ? [stateBackupPath] : []),
            ...(supervisorBackupStatus === "retained" && supervisorBackupPath ? [supervisorBackupPath] : []),
          ],
          errors: cleanupErrors,
        };
        receipt = {
          ...receipt,
          artifact_cleanup: artifactCleanup,
          warnings: [...receipt.warnings, ...cleanupErrors],
        };
        // Cleanup reporting is an additive receipt update. Failure cannot
        // erase an already-durable receipt path or masquerade as the original
        // receipt persistence failing.
        try {
          receiptWriteAttempted = true;
          receiptPath = await deps.writeReceipt(
            receiptRoot,
            receiptOperationId,
            serializeSelfUpgradeReceipt(receipt),
          );
        } catch (updateError) {
          receipt = {
            ...receipt,
            warnings: [
              ...receipt.warnings,
              `cleanup receipt update failed: ${errorMessage(updateError)}`,
            ],
          };
        }
      }
      const failedEventDurable = await appendEventFailOpen(
        uniqueRunsRoots(plan.daemons),
        buildControlEvent({
          now: completedAt,
          eventType: "daemon.upgrade.failed",
          emittedBy: "self-upgrade",
          host: plan.host,
          ...(operationId ? { operationId } : {}),
          error: message,
        }),
      );
      if (!failedEventDurable && receiptPath) {
        const receiptWithLateWarning: SelfUpgradeReceipt = {
          ...receipt,
          warnings: [...plan.warnings, ...explicitTargetWarnings, ...eventProjectionWarnings],
        };
        try {
          await deps.writeReceipt(
            receiptRoot,
            receiptOperationId,
            serializeSelfUpgradeReceipt(receiptWithLateWarning),
          );
          receipt = receiptWithLateWarning;
        } catch {
          // The already-durable failed receipt remains authority. This rewrite
          // carries diagnostics only and must not mask the original failure.
        }
      }
      if (operationProjection && receiptPath) {
        const projectedAt = deps.now();
        const receiptLocator = {
          host: plan.host,
          route: adminOperationRoutes.selfUpgrade.receipt({ operationId: receiptOperationId }),
        };
        await operationProjection.transition({
          schema_version: "self-upgrade-operation/v1",
          record: "transition",
          kind: "host_result",
          transition_id: selfUpgradeTransitionId([
            receiptOperationId,
            "host_result",
            plan.host,
          ]),
          operation_id: receiptOperationId,
          emitted_at: projectedAt,
          observed_at: projectedAt,
          host: plan.host,
          status: "failed",
          elapsed_ms: lastPhaseElapsedMs,
          relay_mode: "local",
          before_head: plan.current_head,
          ...(receipt.after_head ? { after_head: receipt.after_head } : {}),
          receipt_locator: receiptLocator,
          error: message,
        });
        await operationProjection.transition({
          schema_version: "self-upgrade-operation/v1",
          record: "transition",
          kind: "fleet_final",
          transition_id: selfUpgradeTransitionId([receiptOperationId, "fleet_final"]),
          operation_id: receiptOperationId,
          emitted_at: projectedAt,
          observed_at: deps.now(),
          status: "failed",
          receipt_path: receiptPath,
          rows: [{
            host: plan.host,
            status: "failed",
            before_head: plan.current_head,
            ...(receipt.after_head ? { after_head: receipt.after_head } : {}),
            elapsed_ms: lastPhaseElapsedMs,
            receipt_locator: receiptLocator,
          }],
        });
      }
    }
    const typed = error instanceof Error
      ? error as SelfUpgradeExecutionError
      : createSelfUpgradeError(String(error), 1);
    if (plan && !typed.plan) {
      typed.plan = plan;
    }
    if (receiptPath && !typed.receipt_path) {
      typed.receipt_path = receiptPath;
    }
    if (receipt && !typed.receipt) {
      typed.receipt = receipt;
    }
    if (typeof typed.exitCode !== "number") {
      typed.exitCode = 1;
    }
    terminalError = typed;
    if (projectionIssues.length > 0) {
      terminalError.projection_issues = projectionIssues;
    }
    throw typed;
  } finally {
    restoreTargetCredentialEnvironment?.();
    await statusProjection.stop();
    await operationProjection?.stop();
    const release = await settleFailOpenProjection(
      () => lock.release(),
      deps.lockReleaseSettleTimeoutMs,
    );
    if (release.status !== "fulfilled") {
      const detail = release.status === "timeout"
        ? `did not settle within ${Math.max(0, deps.lockReleaseSettleTimeoutMs)}ms; release may still complete`
        : release.error instanceof Error
          ? release.error.message
          : String(release.error);
      recordProjectionIssue({
        scope: "lock_cleanup",
        code: "cleanup_unavailable",
        observed_at: deps.now(),
        message: `self-upgrade lock release ${detail}; stale-lock recovery remains available`,
      });
    }
  }
}

export async function runSelfUpgrade(
  options: SelfUpgradeOptions,
  dependencies: SelfUpgradeDependencies = {},
): Promise<SelfUpgradeResult> {
  if (!options.targetOwnedExecution && !options.targetHandoffOperationId) {
    const homeDir = (dependencies.homeDir ?? (() => homedir()))();
    const pending = await discoverPendingTargetHandoffs(homeDir);
    if (pending.length > 1) {
      throw createSelfUpgradeError(
        "Multiple authoritative self-upgrade target handoffs are pending; refusing to create another operation.\n"
        + pending.map(({ handoff }) =>
          `${handoff.operation_id}: ${targetHandoffRecoveryCommand(handoff)}`
        ).join("\n"),
        6,
      );
    }
    const [preliminary] = pending;
    if (preliminary) {
      const preliminaryHandoff = preliminary.handoff;
      if (
        normalizeHostAlias(options.host)
        !== normalizeHostAlias(preliminaryHandoff.request.host)
      ) {
        throw createSelfUpgradeError(
          `Pending self-upgrade ${preliminaryHandoff.operation_id} belongs to host ${preliminaryHandoff.request.host}; refusing a new ${options.host} operation.\n`
          + `Resume exactly: ${targetHandoffRecoveryCommand(preliminaryHandoff)}`,
          6,
        );
      }
      if (options.dryRun) {
        throw createSelfUpgradeError(
          `Pending self-upgrade ${preliminaryHandoff.operation_id} must be resolved before a new dry-run.\n`
          + `Resume exactly: ${targetHandoffRecoveryCommand(preliminaryHandoff)}`,
          6,
        );
      }
      const acquireLock = dependencies.acquireLock ?? acquireSelfUpgradeLock;
      const recoveryLock = await acquireLock({
        lockPath: defaultSelfUpgradeLockPath(homeDir),
        payload: {
          pid: process.pid,
          acquired_at: dependencies.now?.() ?? new Date().toISOString(),
        },
      });
      let handoffToResume: SelfUpgradeTargetHandoff | undefined;
      let recoveredExhaustedCutover = false;
      try {
        const [lockedPending, cutovers] = await Promise.all([
          discoverPendingTargetHandoffs(homeDir),
          listCutoverJournals(homeDir),
        ]);
        if (lockedPending.length !== 1) {
          throw createSelfUpgradeError(
            "Pending self-upgrade target handoff topology changed before the canonical lock was acquired.",
            6,
          );
        }
        const lockedHandoff = lockedPending[0]!;
        if (
          lockedHandoff.handoff.operation_id !== preliminaryHandoff.operation_id
          || normalizeHostAlias(lockedHandoff.handoff.request.host)
            !== normalizeHostAlias(options.host)
        ) {
          throw createSelfUpgradeError(
            "Pending self-upgrade target handoff authority changed before the canonical lock was acquired.",
            6,
          );
        }
        if (cutovers.length > 1) {
          throw createSelfUpgradeError(
            "Multiple authoritative self-upgrade cutover journals require operator reconciliation.",
            6,
          );
        }
        const [cutover] = cutovers;
        if (cutover && cutover.journal.operation_id !== lockedHandoff.handoff.operation_id) {
          throw createSelfUpgradeError(
            "Pending self-upgrade target handoff and cutover journal authority disagree; "
            + "refusing to choose an operation implicitly.",
            6,
          );
        }
        if (
          cutover
          && await hasExhaustedStateRollbackAuthority(cutover.journal)
        ) {
          await assertHandoffMatchesExhaustedCutover(
            lockedHandoff,
            cutover.journal,
          );
          const resolveAgentsInfraRootDependency =
            dependencies.resolveAgentsInfraRoot ?? resolveAgentsInfraRoot;
          const readHostsTruthDependency = dependencies.readHostsTruth ?? readHostsTruth;
          const authToken = await resolveSelfUpgradeAuthToken(
            normalizeHostAlias(options.host),
            options.authToken,
            {
              resolveAgentsInfraRoot: resolveAgentsInfraRootDependency,
              readHostsTruth: readHostsTruthDependency,
            },
          );
          await (
            dependencies.removeTargetHandoff ?? removeTargetHandoff
          )(
            homeDir,
            lockedHandoff.handoff.operation_id,
            lockedHandoff,
          );
          await (
            dependencies.recoverInterruptedCutover ?? recoverInterruptedCutover
          )({
            homeDir,
            host: normalizeHostAlias(options.host),
            authToken,
            ...(dependencies.now ? { now: dependencies.now } : {}),
            resolveAgentsInfraRoot: resolveAgentsInfraRootDependency,
            runSupervisorStage: dependencies.runSupervisorStage ?? defaultRunSupervisorStage,
            runTargetStatePlan: dependencies.runTargetStatePlan ?? defaultRunTargetStatePlan,
            createSupervisorAdapter:
              dependencies.createSupervisorAdapter
              ?? ((descriptor) => createSupervisorAdapter(descriptor)),
            inspectSupervisorEffectiveState:
              dependencies.inspectSupervisorEffectiveState
              ?? defaultInspectSupervisorEffectiveState,
            reloadSupervisorDefinition:
              dependencies.reloadSupervisorDefinition
              ?? defaultReloadSupervisorDefinition,
            createAdminClient: dependencies.createAdminClient ?? createCalyxAdminClient,
            sleep:
              dependencies.sleep
              ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
            monotonicNowMs: dependencies.monotonicNowMs ?? (() => performance.now()),
            readDescriptor: dependencies.readDescriptor ?? readDescriptor,
            writeDescriptor: dependencies.writeDescriptor ?? writeDescriptor,
          });
          recoveredExhaustedCutover = true;
        } else {
          handoffToResume = lockedHandoff.handoff;
        }
      } finally {
        await recoveryLock.release();
      }
      if (recoveredExhaustedCutover) {
        return executeSelfUpgradePipeline(options, dependencies);
      }
      if (!handoffToResume) {
        throw createSelfUpgradeError(
          "Pending self-upgrade target handoff could not be re-established under the canonical lock.",
          6,
        );
      }
      const targetResult = await (
        dependencies.runTargetOwnedUpgrade ?? defaultRunTargetOwnedUpgrade
      )(handoffToResume);
      if (
        targetResult.operation_id !== handoffToResume.operation_id
        || targetResult.receipt?.target_acceptance?.operation_id !== handoffToResume.operation_id
      ) {
        throw createSelfUpgradeError(
          `Resumed target ${handoffToResume.operation_id} returned without exact target-acceptance authority.`,
          6,
        );
      }
      return targetResult;
    }
  }
  return executeSelfUpgradePipeline(options, dependencies);
}

export async function runSelfUpgradeTargetEntry(
  operationId: string,
  dependencies: SelfUpgradeDependencies = {},
): Promise<SelfUpgradeResult> {
  if (!isCanonicalSelfUpgradeOperationId(operationId)) {
    throw createSelfUpgradeError("Invalid prepared-target self-upgrade operation id.", 2);
  }
  return executeSelfUpgradePipeline(
    {
      host: "target-handoff",
      targetHandoffOperationId: operationId,
      targetOwnedExecution: true,
    },
    dependencies,
  );
}
