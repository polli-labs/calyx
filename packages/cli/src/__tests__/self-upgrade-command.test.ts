import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, link, lutimes, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import YAML from "yaml";
import { createCalyxAdminClient } from "@polli-labs/calyx-client/admin";
import {
  CALYX_SERVER_STARTUP_CONTRACT,
  CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT,
  CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT_ENV,
  CALYX_STARTUP_CONTRACT_MANIFEST_RELATIVE_PATH,
  CALYX_DAEMON_FEATURES,
  applyStateMigrations,
  defaultSelfUpgradeOperationRoot,
  observeSelfUpgradeOperation,
  openStateStore,
  type CalyxDaemonDescriptor,
  type FleetConvergenceToolchainCheck,
} from "@polli-labs/calyx-core";
import type {
  DetachedWorkerSupervisor,
  ReconcileResult,
  RunListEntry,
  RunRecord,
  RunRestartReadoptAssessment,
  RunRestartReadoptReason,
} from "@polli-labs/calyx-run-service";
import {
  EXPECTED_DAEMON_BASELINE_FEATURES,
  assertTargetStateSchemaMigrated,
  assertTargetStateSchemaReady,
  appendControlEvent,
  buildControlEvent,
  buildSelfUpgradeTargetEnvironment,
  buildVersionedInstallThirdPartyOverrides,
  formatSelfUpgradePlan,
  isFetchTransportError,
  launchdConfigFromPrint,
  prepareVersionedInstall,
  prepareCanonicalSupervisorCutover,
  prepareStateCutoverSnapshot,
  recoverInterruptedCutover,
  resolveAcceptedTargetCredentialEnvironment,
  writeCutoverJournal,
  promoteVersionedInstall,
  pruneVersionedInstalls,
  resolveVersionedInstallWorkspacePackages,
  runSelfUpgrade as runSelfUpgradeImpl,
  systemdConfigFromShow,
  verifySelfUpgradeDaemons,
  type SelfUpgradeExecutionError,
  type SelfUpgradePlan,
  type SelfUpgradeCutoverJournal,
  type SelfUpgradeTargetHandoff,
  type VersionedInstallReceipt,
} from "../commands/self-upgrade";
import type { SelfUpgradePhaseEvent } from "../self-upgrade-progress";
import type { SupervisorEnvInspection } from "../self-upgrade-startup-contract";

// These are durable-operation integration tests: the command fsyncs every
// lifecycle transition and several cases exercise repeated health verification.
// Six-worker full-suite contention can legitimately exceed the repository's
// 30-second unit-test ceiling; keep a finite integration-test hang bound.
vi.setConfig({ testTimeout: 60_000 });

const execFile = promisify(execFileCallback);
const STARTUP_CONTRACT_JSON = JSON.stringify(CALYX_SERVER_STARTUP_CONTRACT);

// ---------------------------------------------------------------------------
// Real supervisor captures (POL-2072).
//
// These are verbatim host output, not hand-written approximations. A previous
// generation of these fixtures invented `FinalKillSignal:"SIGKILL"` and
// `WorkingDirectory:""` on the `systemctl show` side — values real systemd
// never emits — which is exactly why the source-vs-show comparison bug shipped.
// Regenerate, do not edit by hand.
// ---------------------------------------------------------------------------

/**
 * `cat ~/.config/systemd/user/calyx-run-serve.service` on blade, 2026-07-25.
 * Note `%h` specifiers and the symbolic `FinalKillSignal`, and that
 * `WorkingDirectory=` is not set at all.
 */
const BLADE_LIVE_UNIT = `[Unit]
Description=Calyx RunService (authenticated remote control plane)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.config/polli/secrets.env
EnvironmentFile=-%h/.config/polli/secrets.d/blade.env
Environment=CALYX_SYSTEMD_UNIT=calyx-run-serve.service
ExecStart=%h/.config/polli/bin/with-polli-secrets %h/.agents/run/calyx run serve --host 0.0.0.0 --port 8740 --runs-root %h/.calyx/runs --worktree-base %h/projects
Restart=on-failure
RestartSec=5
TimeoutStopSec=300s
KillMode=mixed
FinalKillSignal=SIGKILL

[Install]
WantedBy=default.target
`;

/**
 * `systemctl --user show calyx-run-serve.service` on blade, 2026-07-25, reduced
 * to the properties `defaultInspectSupervisorEffectiveState` requests. This is
 * the resolved definition of {@link BLADE_LIVE_UNIT}: `%h` expanded,
 * `SIGKILL` rendered as `9`, and an unset `WorkingDirectory` filled with
 * `!/home/caleb`.
 */
const BLADE_SYSTEMCTL_SHOW: Record<string, string> = {
  LoadState: "loaded",
  ActiveState: "active",
  SubState: "running",
  FragmentPath: "/home/caleb/.config/systemd/user/calyx-run-serve.service",
  ExecStart: "{ path=/home/caleb/.config/polli/bin/with-polli-secrets ; argv[]=/home/caleb/.config/polli/bin/with-polli-secrets /home/caleb/.agents/run/calyx run serve --host 0.0.0.0 --port 8740 --runs-root /home/caleb/.calyx/runs --worktree-base /home/caleb/projects ; ignore_errors=no ; start_time=[Mon 2026-07-20 19:22:14 UTC] ; stop_time=[n/a] ; pid=1347709 ; code=(null) ; status=0/0 }",
  WorkingDirectory: "!/home/caleb",
  TimeoutStopUSec: "5min",
  KillMode: "mixed",
  Restart: "on-failure",
  RestartUSec: "5s",
  FinalKillSignal: "9",
  Type: "simple",
  Environment: "CALYX_SYSTEMD_UNIT=calyx-run-serve.service",
};

/**
 * `cat ~/Library/LaunchAgents/com.pollilabs.calyx.run-serve.plist` on mba,
 * 2026-07-25. Declares `ExitTimeOut=300`.
 */
const MBA_LIVE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pollilabs.calyx.run-serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/caleb/.config/polli/bin/with-polli-secrets</string>
    <string>/Users/caleb/.agents/run/calyx</string>
    <string>run</string>
    <string>serve</string>
    <string>--host</string>
    <string>0.0.0.0</string>
    <string>--port</string>
    <string>8740</string>
    <string>--runs-root</string>
    <string>/Users/caleb/.calyx/runs</string>
    <string>--worktree-base</string>
    <string>/Users/caleb/projects</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/caleb/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>/Users/caleb</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ExitTimeOut</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>/Users/caleb/.calyx/run-serve.launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/caleb/.calyx/run-serve.launchd.err.log</string>
</dict>
</plist>`;

/**
 * `launchctl print gui/501/com.pollilabs.calyx.run-serve` on mba, 2026-07-25 —
 * the resolved form of {@link MBA_LIVE_PLIST}. launchd reports
 * `exit timeout = 60` against the plist's declared 300, prints `arguments`
 * unnumbered, adds `inferred program` to `properties`, and emits `inherited
 * environment` and `default environment` blocks ahead of the real one.
 */
const MBA_LAUNCHCTL_PRINT = `gui/501/com.pollilabs.calyx.run-serve = {
	active count = 1
	path = /Users/caleb/Library/LaunchAgents/com.pollilabs.calyx.run-serve.plist
	type = LaunchAgent
	state = running

	program = /Users/caleb/.config/polli/bin/with-polli-secrets
	arguments = {
		/Users/caleb/.config/polli/bin/with-polli-secrets
		/Users/caleb/.agents/run/calyx
		run
		serve
		--host
		0.0.0.0
		--port
		8740
		--runs-root
		/Users/caleb/.calyx/runs
		--worktree-base
		/Users/caleb/projects
	}

	working directory = /Users/caleb

	stdout path = /Users/caleb/.calyx/run-serve.launchd.out.log
	stderr path = /Users/caleb/.calyx/run-serve.launchd.err.log
	inherited environment = {
		SSH_AUTH_SOCK => /var/run/com.apple.launchd.1hZN1QyMoT/Listeners
	}

	default environment = {
		PATH => /usr/bin:/bin:/usr/sbin:/sbin
	}

	environment = {
		OSLogRateLimit => 64
		PATH => /Users/caleb/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
		XPC_SERVICE_NAME => com.pollilabs.calyx.run-serve
	}

	domain = gui/501 [100023]
	asid = 100023
	minimum runtime = 10
	exit timeout = 60
	runs = 5
	pid = 14481
	immediate reason = inefficient
	forks = 56
	execs = 5
	last terminating signal = Terminated: 15

	spawn type = daemon (3)
	jetsam priority = 40
	cpumon = default

	properties = keepalive | runatload | inferred program
}`;

function createAdminClientFactory(fetchImpl: typeof fetch): typeof createCalyxAdminClient {
  return (options) => createCalyxAdminClient({
    ...options,
    fetch: fetchImpl,
  });
}
function testCredentials(host: string) {
  const envHost = host.toUpperCase().replace(/[^A-Z0-9]+/gu, "_");
  return [{
    client_id: `daemon:${host}`,
    credential_tier: "internal_runtime" as const,
    verifier_env: `CALYX_CONSUMER_API_DAEMON_${envHost}_VERIFIER_SHA256`,
    token_env: `CALYX_CONSUMER_API_DAEMON_${envHost}_TOKEN`,
    outbound: true,
    address_grants: { send_as: [`host:${host}`], read: [`host:${host}`] },
  }];
}

function compatibleStartupInspection(host: string): SupervisorEnvInspection {
  const [credential] = testCredentials(host);
  if (!credential) {
    throw new Error(`Missing test credential for ${host}`);
  }
  return {
    status: "determined",
    source: "legacy-test-fixture",
    projection_contract: CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT,
    provided_env: [
      "CALYX_HOST_ALIAS",
      CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT_ENV,
      credential.token_env,
      credential.verifier_env,
    ],
    projection: {
      required_env: [credential.token_env, credential.verifier_env],
      optional_env: [],
      preserved_env: [],
      fixed_env: {
        CALYX_HOST_ALIAS: "blade",
        [CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT_ENV]: CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT,
      },
      opaque_env: [credential.token_env],
      sha256_env: [credential.verifier_env],
    },
  };
}

function passingToolchainCheck(host: string, targetSha: string | null): FleetConvergenceToolchainCheck {
  return {
    schema_version: "fleet-convergence-check/v1",
    surface: "toolchain",
    status: "pass",
    host,
    expected: {
      node_range: ">=22.13.0",
      package_manager: "pnpm",
      pnpm_version: "10.34.1",
    },
    observed: {
      process_exec_path_realpath: "/usr/bin/node",
      process_node_version: "v22.23.1",
      child_node: { executable_realpath: "/usr/bin/node", version: "v22.23.1", exit_code: 0 },
      child_pnpm: {
        executable_realpath: "/usr/bin/pnpm",
        resolution_source: "pnpm-exec-node-path",
        self_dispatched: { version: "10.34.1", exit_code: 0 },
        intrinsic: { version: "10.34.1", exit_code: 0, probe: "manage-package-manager-versions-disabled" },
        nested: { version: "10.34.1", exit_code: 0 },
      },
      bootstrap_cwd: "$CWD",
      spawn_contract: "@polli-labs/calyx/self-upgrade-child-spawn@v1",
      environment_contract: "self-upgrade-bootstrap-isolated-env/v1",
      path_resolution: { observer: "parent_diagnostic", total_entries: 1, truncated: false, entries: [{ index: 0, directory: "/usr/bin" }] },
    },
    failures: [],
    checked_at: "2026-08-02T00:00:00.000Z",
    evidence: {
      source: "self-upgrade-bootstrap-attestation",
      spawn_contract: "@polli-labs/calyx/self-upgrade-child-spawn@v1",
    },
    freshness: { status: "current", observed_at: "2026-08-02T00:00:00.000Z" },
    topology_identity: { status: "not_bound" },
    target_bundle_identity: { calyx_source_sha: targetSha },
  };
}

function blockedMbaToolchainCheck(targetSha: string | null): FleetConvergenceToolchainCheck {
  const passing = passingToolchainCheck("mba", targetSha);
  return {
    ...passing,
    status: "blocked",
    observed: {
      ...passing.observed,
      child_node: {
        executable_realpath: "/opt/homebrew/bin/node",
        version: "v26.5.0",
        exit_code: 0,
      },
      child_pnpm: {
        executable_realpath: "/opt/homebrew/bin/pnpm",
        resolution_source: "pnpm-exec-node-path",
        self_dispatched: { version: "10.34.1", exit_code: 0 },
        intrinsic: { version: "11.17.0", exit_code: 0, probe: "with-current" },
        nested: { version: "11.17.0", exit_code: 0 },
      },
    },
    failures: [
      { code: "child_pnpm_intrinsic_version_mismatch", message: "Bootstrap child pnpm is intrinsically 11.17.0." },
      { code: "nested_pnpm_version_mismatch", message: "Nested pnpm 11.17.0 does not match pnpm@10.34.1." },
    ],
    repair_owner: "fleet_ops",
    next_action: { kind: "repair_toolchain", description: "Repair mba's bootstrap toolchain." },
  };
}

/** Keep legacy self-upgrade fixtures focused on their named behavior. */
async function runSelfUpgrade(
  options: Parameters<typeof runSelfUpgradeImpl>[0],
  dependencies: Parameters<typeof runSelfUpgradeImpl>[1] = {},
): ReturnType<typeof runSelfUpgradeImpl> {
  const testHost = options.host ?? "blade";
  const testHome = dependencies.homeDir?.();
  if (!options.dryRun && testHome) {
    const currentLink = path.join(testHome, ".calyx", "installs", "current");
    try {
      await access(currentLink);
    } catch {
      await materializeInstallFixture(testHome, "a".repeat(40));
    }
  }
  const testDependencies = {
    ...dependencies,
    attestToolchain: dependencies.attestToolchain
      ?? (async ({ host, targetSha }) => passingToolchainCheck(host, targetSha)),
    readHostsTruth: dependencies.readHostsTruth ?? (async () => ({
      hosts: { [testHost]: { consumer_api_credentials: testCredentials(testHost) } },
    })),
    resolveSupervisorEnvNames: dependencies.resolveSupervisorEnvNames
      ?? (async (_descriptor, expectedHost) => compatibleStartupInspection(expectedHost)),
    runTargetStatePlan: dependencies.runTargetStatePlan
      ?? (async () => ({
        code: 0,
        stdout: JSON.stringify({
          driver: "better-sqlite3",
          current: "0001",
          target: "0001",
          ledgerExists: true,
          applied: [{
            id: "0001",
            description: "baseline",
            appliedAt: "2026-07-23T00:00:00.000Z",
          }],
          pending: [],
        }),
        stderr: "",
      })),
    runTargetStateMigrate: dependencies.runTargetStateMigrate
      ?? (async () => ({
        code: 0,
        stdout: JSON.stringify({
          driver: "better-sqlite3",
          applied: [],
          alreadyApplied: [{
            id: "0001",
            description: "baseline",
            appliedAt: "2026-07-23T00:00:00.000Z",
          }],
          current: "0001",
          target: "0001",
        }),
        stderr: "",
      })),
    prepareStateCutover: dependencies.prepareStateCutover
      ?? (async ({ homeDir }) => ({
        snapshot: {
          schema_version: "self-upgrade-state-snapshot/v1" as const,
          status: "snapshotted" as const,
          database_path: path.join(homeDir, "state", "calyx.db"),
          backup_path: path.join(homeDir, "state-backup", "calyx.db"),
          database_sha256: "d".repeat(64),
          size_bytes: 1,
          wal_checkpoint: "truncate" as const,
          quick_check: "ok" as const,
          capacity_preflight: {
            available_bytes: 128 * 1024 * 1024,
            required_bytes: 81 * 1024 * 1024,
            same_device: true,
            snapshot_bytes: 1,
            migration_growth_reserve_bytes: 64 * 1024 * 1024,
            target_declared_migration_growth_bytes: 0,
            rollback_allocation_bytes: 16 * 1024 * 1024,
          },
        },
        restore: async () => ({
          schema_version: "self-upgrade-state-rollback/v1" as const,
          status: "succeeded" as const,
          restored_sha256: "d".repeat(64),
          quick_check: "ok" as const,
        }),
        cleanup: async () => {},
      })),
    prepareSupervisorCutover: dependencies.prepareSupervisorCutover
      ?? (async ({ preparedInstall }) => ({
        readiness: {
          schema_version: "self-upgrade-supervisor-readiness/v1" as const,
          status: "unchanged" as const,
          target_git_head: preparedInstall.git_head,
          source: "live-supervisor" as const,
          supervisor_kinds: ["systemd" as const],
        },
        install: async () => ({
          schema_version: "self-upgrade-supervisor-install/v1" as const,
          status: "unchanged" as const,
          reload: "none" as const,
        }),
        restore: async () => ({
          schema_version: "self-upgrade-supervisor-rollback/v1" as const,
          status: "skipped" as const,
        }),
      })),
  };
  const execGit = testDependencies.execGit;
  if (!execGit) {
    return runSelfUpgradeImpl({ ...options, targetOwnedExecution: true }, testDependencies);
  }
  let adoptedTarget: string | undefined;
  return runSelfUpgradeImpl({ ...options, targetOwnedExecution: true }, {
    ...testDependencies,
    execGit: async (args, cwd) => {
      if (args[0] === "show" && (args[1] ?? "").endsWith(":packages/core/startup-contract.json")) {
        return { code: 0, stdout: STARTUP_CONTRACT_JSON, stderr: "" };
      }
      if (!options.targetSha && args[0] === "merge" && args[1] === "--ff-only") {
        const targetRef = options.to?.trim() || "origin/main";
        const slash = targetRef.indexOf("/");
        const remote = slash > 0 ? targetRef.slice(0, slash) : "origin";
        const ref = slash > 0 ? targetRef.slice(slash + 1) : targetRef;
        const result = await execGit(["pull", "--ff-only", remote, ref], cwd);
        if (result.code === 0) {
          adoptedTarget = args[2];
        }
        return result;
      }
      if (!options.targetSha && adoptedTarget && args[0] === "rev-parse" && args[1] === "HEAD") {
        return { code: 0, stdout: `${adoptedTarget}\n`, stderr: "" };
      }
      return execGit(args, cwd);
    },
  });
}

function makeDescriptor(args: {
  repoRoot: string;
  runsRoot: string;
  maintenanceMode?: boolean;
  gitHead?: string;
  healthUrl?: string;
  pid?: number;
  argv?: string[];
  supervisor?: CalyxDaemonDescriptor["supervisor"];
}): CalyxDaemonDescriptor {
  return {
    schema_version: "calyx-daemon/v1",
    daemon_id: "run-serve",
    daemon_kind: "run-service",
    pid: args.pid ?? 4242,
    argv: args.argv ?? ["calyx", "run", "serve", "--host", "127.0.0.1", "--port", "8740"],
    cwd: args.repoRoot,
    runs_root: args.runsRoot,
    health_url: args.healthUrl ?? "http://127.0.0.1:8740",
    livez_url: "http://127.0.0.1:8740/livez",
    supervisor: args.supervisor ?? {
      kind: "direct",
      stop_grace_ms: 5_000,
    },
    started_at: "2026-04-20T00:00:00.000Z",
    build: {
      git_head: args.gitHead ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      built_at: "2026-04-20T00:00:00.000Z",
      package_version: "0.2.0",
    },
    restart_order: 10,
    depends_on: [],
    maintenance_mode: args.maintenanceMode ?? false,
  };
}

/** Minimal plan shape a canonical supervisor cutover reads. */
function makeSupervisorCutoverPlan(args: {
  descriptor: CalyxDaemonDescriptor;
  targetHead: string;
  host: string;
}): SelfUpgradePlan {
  const { descriptor, targetHead, host } = args;
  return {
    host,
    repo_root: descriptor.cwd,
    current_head: "a".repeat(40),
    target_ref: "origin/main",
    target_head: targetHead,
    target_evidence: {
      original_ref: "origin/main",
      target_sha: targetHead,
      fetch_remote: "origin",
      fetch_ref: "main",
    },
    dirty: false,
    dirty_paths: [],
    missing_build_artifacts: [],
    daemons: [{
      daemon_id: descriptor.daemon_id,
      pid: descriptor.pid,
      runs_root: descriptor.runs_root,
      health_url: descriptor.health_url,
      restart_order: descriptor.restart_order,
      supervisor: descriptor.supervisor,
      build: descriptor.build,
      maintenance_mode: false,
    }],
    active_runs_post_reconcile: [],
    preservation: {
      policy: "automatic",
      status: "not_applicable",
      required_features: [],
      unavailable_reasons: [],
    },
    startup_contract: { mutation_disposition: "block" },
    blockers: ["supervisor repair required"],
    warnings: [],
    diagnostics: [],
  } as unknown as SelfUpgradePlan;
}

/** A well-formed `polli.calyx-run-service-stage/v2` receipt for the cutover. */
function supervisorStageResult(args: {
  host: string;
  targetHead: string;
  prepared: VersionedInstallReceipt;
  buildInfoSha: string;
  livePath: string;
  stagedPath: string;
  serviceSha: string;
}): { code: number; stdout: string; stderr: string } {
  return {
    code: 0,
    stdout: JSON.stringify({
      schema_version: "polli.calyx-run-service-stage/v2",
      status: "staged",
      host: args.host,
      authority: { source: "agents-infra", host_binding: true },
      prepared_target: {
        git_head: args.targetHead,
        install_path: args.prepared.install_path,
        build_info_sha256: args.buildInfoSha,
        interface_version: "calyx-run-serve/v1",
      },
      compatibility: {
        startup_contract_version: "calyx-startup-contract/v1",
        target_interface_version: "calyx-run-serve/v1",
        ready: true,
      },
      live: { path: args.livePath, present: true },
      staged: {
        path: args.stagedPath,
        desired_service_sha256: args.serviceSha,
        published: true,
        activated: false,
      },
      projector: {
        source_sha256: "b".repeat(64),
        installed_sha256: "b".repeat(64),
        matches: true,
        executable: true,
      },
      credentials: {
        required_names: [],
        missing_names: [],
        invalid_names: [],
        ready: true,
      },
    }),
    stderr: "",
  };
}

function createRunServiceStub(activeRuns: Array<{
  run_id: string;
  state: RunListEntry["state"];
  resumable: boolean;
  health_status?: RunListEntry["health_status"];
  summary: string;
  /** POL-1886: stub the restart-readopt classification for this run. */
  readopt_safe?: boolean;
  readopt_reason?: RunRestartReadoptReason;
  /** POL-2044: stub the supervisor recorded on the run's launch evidence. */
  worker_supervisor?: DetachedWorkerSupervisor;
}> = []) {
  return {
    reconcile: vi.fn(async (): Promise<ReconcileResult> => ({
      scanned: activeRuns.length,
      rebuilt: [],
      classified: [],
      adopted: activeRuns.filter((run) => run.readopt_safe).map((run) => run.run_id),
      unresolved: [],
      skipped: [],
      noncanonical_directories: [],
      projection: { status: "not_configured" },
    })),
    assessRestartReadopt: vi.fn(async (runIds: readonly string[]): Promise<RunRestartReadoptAssessment[]> =>
      runIds.map((runId) => {
        const run = activeRuns.find((entry) => entry.run_id === runId);
        const safe = run?.readopt_safe ?? false;
        return {
          run_id: runId,
          readopt_safe: safe,
          reason: safe ? "detached_agent_runner_worker" : run?.readopt_reason ?? "inline_worker",
          ...(run?.worker_supervisor ? { worker_supervisor: run.worker_supervisor } : {}),
        };
      })),
    listRuns: vi.fn(async (): Promise<RunListEntry[]> => activeRuns.map((run) => ({
      run_id: run.run_id,
      state: run.state,
      summary: run.summary,
      created_at: "2026-04-20T00:00:00.000Z",
      updated_at: "2026-04-20T00:00:00.000Z",
      recovery_mode: run.resumable ? "daemon_crash" : "normal",
      run_dir: `/tmp/${run.run_id}`,
    }))),
    getRunRecord: vi.fn(async (runId: string): Promise<RunRecord | undefined> => {
      const run = activeRuns.find((entry) => entry.run_id === runId);
      if (!run) {
        return undefined;
      }
      const record: RunRecord = {
        schema_version: "1.0" as const,
        run_id: run.run_id,
        state: run.state,
        intent: {
          run_id: run.run_id,
          host: "blade",
          created_at: "2026-04-20T00:00:00.000Z",
        },
        launch: {
          mode: "detached",
          stage: "executing",
          admission_identity: "a".repeat(64),
          request_hash: "b".repeat(64),
          accepted_at: "2026-04-20T00:00:00.000Z",
          dispatch_attempts: 1,
          execution_id: `execution-${run.run_id}`,
          execution_started_at: "2026-04-20T00:00:00.000Z",
        },
        integrations: { results: [], all_critical_ok: true },
        recovery: {
          mode: run.resumable ? "daemon_crash" : "normal",
          resumable: run.resumable,
        },
        summary: run.summary,
        created_at: "2026-04-20T00:00:00.000Z",
        updated_at: "2026-04-20T00:00:00.000Z",
      };
      if (run.health_status) {
        record.health = {
          source: "host_process",
          status: run.health_status,
          checked_at: "2026-04-20T00:00:00.000Z",
          stale_after_ms: 1_000,
          observations: [],
          summary: run.summary,
        };
      }
      return record;
    }),
    stop: vi.fn(async (runId: string) => ({
      schema_version: "calyx.run-cancellation-result/v1" as const,
      status: "cancellation_requested" as const,
      run_id: runId,
      requested_at: "2026-07-14T07:00:00.000Z",
    })),
  };
}

type StubActiveRun = NonNullable<Parameters<typeof createRunServiceStub>[0]>[number];
const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;

function makeInstallReceipt(homeRoot: string, gitHead: string): VersionedInstallReceipt {
  const installPath = path.join(homeRoot, ".calyx", "installs", gitHead);
  return {
    install_path: installPath,
    current_link: path.join(homeRoot, ".calyx", "installs", "current"),
    build_info_path: path.join(installPath, ".build-info.json"),
    bin_path: path.join(installPath, "node_modules", "@polli-labs", "calyx", "dist", "bin.js"),
    git_head: gitHead,
    verified_version: "0.2.0",
    pruned: [],
    materialized: true,
    promoted: true,
    mechanism: "pack-install",
    rollback_command: "ln -sfn <previous-install-dirname> current",
  };
}

function currentInstallBin(homeRoot: string): string {
  return path.join(homeRoot, ".calyx", "installs", "current", "node_modules", "@polli-labs", "calyx", "dist", "bin.js");
}

function repoCloneBin(repoRoot: string): string {
  return path.join(repoRoot, "packages", "cli", "dist", "bin.js");
}

async function writeInstallBuildInfo(installPath: string, gitHead: string): Promise<void> {
  const buildInfo = {
    schema_version: "build-info/v1",
    git_head: gitHead,
    built_at: "2026-06-12T00:00:00.000Z",
    package_version: "0.2.0",
    branch: "main",
    dirty: false,
  };
  await writeFile(path.join(installPath, ".build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
}

async function materializeInstallFixture(homeRoot: string, gitHead: string): Promise<VersionedInstallReceipt> {
  const receipt = makeInstallReceipt(homeRoot, gitHead);
  await mkdir(path.dirname(receipt.bin_path), { recursive: true });
  await writeFile(receipt.bin_path, "#!/usr/bin/env node\nconsole.log('0.2.0');\n", "utf8");
  await chmod(receipt.bin_path, 0o755);
  await writeInstallBuildInfo(receipt.install_path, gitHead);
  await rm(receipt.current_link, { force: true });
  await symlink(path.basename(receipt.install_path), receipt.current_link, "dir");
  return receipt;
}

async function prepareInstallFixture(homeRoot: string, gitHead: string): Promise<VersionedInstallReceipt> {
  const receipt = makeInstallReceipt(homeRoot, gitHead);
  await mkdir(path.dirname(receipt.bin_path), { recursive: true });
  await writeFile(receipt.bin_path, "#!/usr/bin/env node\nconsole.log('0.2.0');\n", "utf8");
  await chmod(receipt.bin_path, 0o755);
  await writeInstallBuildInfo(receipt.install_path, gitHead);
  return {
    ...receipt,
    promoted: false,
  };
}

// Transparent preservation requires both daemon-side proof flags: boot re-adopt
// and detached-worker isolation. Keep the common fixture honest about both.
function readoptHealthResponse(
  gitHead: string,
  opts: {
    withFlag: boolean;
    activeRuns: number;
    advertisedHost?: string | null;
    daemonId?: string;
    startedAt?: string;
  },
): Response {
  const features: string[] = [...EXPECTED_DAEMON_BASELINE_FEATURES];
  if (opts.withFlag) {
    features.push(CALYX_DAEMON_FEATURES.runReadoptOnBootV1);
    features.push(CALYX_DAEMON_FEATURES.detachedWorkerIsolationV1);
  }
  return new Response(JSON.stringify({
    schema_version: "calyx.admin-health/v1",
    protocol_epoch: 1,
    daemon_kind: "run-service",
    daemon_id: opts.daemonId ?? "run-serve",
    ...(opts.advertisedHost === null ? {} : { advertised_host: opts.advertisedHost ?? "blade" }),
    uptime_ms: 10,
    started_at: opts.startedAt ?? "2026-04-20T00:00:00.000Z",
    build: {
      git_head: gitHead,
      built_at: "2026-04-20T00:00:10.000Z",
      package_version: "0.2.0",
    },
    active_runs: opts.activeRuns,
    maintenance_mode: false,
    supports_features: features,
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
    },
  });
}

function adminRunsResponse(activeRunIds: readonly string[]): Response {
  const runs = activeRunIds.map((runId) => ({
    run_id: runId,
    state: "running",
    summary: "detached worker still running",
    created_at: "2026-04-20T00:00:00.000Z",
    updated_at: "2026-04-20T00:00:00.000Z",
    recovery_mode: "normal",
    run_dir: `/tmp/${runId}`,
  }));
  return new Response(JSON.stringify({
    schema_version: "calyx.run-list/v1",
    count: runs.length,
    truncated: false,
    runs,
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
    },
  });
}

function daemonHealthResponse(
  gitHead: string,
  advertisedHost: string | null = "blade",
  opts: {
    daemonId?: string;
    startedAt?: string;
    activeRuns?: number;
    maintenanceMode?: boolean;
  } = {},
): Response {
  return new Response(JSON.stringify({
    schema_version: "calyx.admin-health/v1",
    protocol_epoch: 1,
    daemon_kind: "run-service",
    daemon_id: opts.daemonId ?? "run-serve",
    ...(advertisedHost ? { advertised_host: advertisedHost } : {}),
    uptime_ms: 10,
    started_at: opts.startedAt ?? "2026-04-20T00:00:00.000Z",
    build: {
      git_head: gitHead,
      built_at: "2026-04-20T00:00:10.000Z",
      package_version: "0.2.0",
    },
    active_runs: opts.activeRuns ?? 0,
    maintenance_mode: opts.maintenanceMode ?? false,
    supports_features: [...EXPECTED_DAEMON_BASELINE_FEATURES],
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
    },
  });
}

describe("runSelfUpgrade", () => {
  let root: string;
  let homeRoot: string;
  let repoRoot: string;
  let runsRoot: string;
  let previousEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

  beforeEach(async () => {
    previousEnv = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    root = await mkdtemp(path.join(tmpdir(), "calyx-self-upgrade-command-"));
    homeRoot = path.join(root, "home");
    repoRoot = path.join(root, "repo");
    runsRoot = path.join(root, "runs");
    process.env["CALYX_STATE_HOME"] = path.join(homeRoot, "state");
    delete process.env["CALYX_STATE_DB"];
    await applyStateMigrations();
    await mkdir(path.join(repoRoot, "packages", "cli", "dist"), { recursive: true });
    await mkdir(path.join(repoRoot, "packages", "run-service", "dist"), { recursive: true });
    await mkdir(path.join(repoRoot, "packages", "server", "dist"), { recursive: true });
    await mkdir(runsRoot, { recursive: true });
    await writeFile(path.join(repoRoot, "packages", "cli", "dist", "bin.js"), "", "utf8");
    await writeFile(path.join(repoRoot, "packages", "cli", "dist", "index.js"), "", "utf8");
    await writeFile(path.join(repoRoot, "packages", "run-service", "dist", "index.js"), "", "utf8");
    await writeFile(path.join(repoRoot, "packages", "server", "dist", "index.js"), "", "utf8");
    await writeFile(path.join(repoRoot, "packages", "server", "dist", ".build-info.json"), "{}", "utf8");
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  test("builds staging overrides from the workspace lockfile with parent-qualified multi-version pins", async () => {
    await writeFile(
      path.join(repoRoot, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  packages/cli:",
        "    dependencies:",
        "      '@polli-labs/calyx-core':",
        "        specifier: workspace:*",
        "        version: link:../core",
        "      '@google/genai':",
        "        specifier: ^1.51.0",
        "        version: 1.51.0(@modelcontextprotocol/sdk@1.29.0(zod@3.25.76))",
        "      zod:",
        "        specifier: ^3.24.2",
        "        version: 3.25.76",
        "",
        "  packages/core:",
        "    dependencies:",
        "      raw-body:",
        "        specifier: ^3.0.2",
        "        version: 3.0.2",
        "      zod:",
        "        specifier: ^3.24.2",
        "        version: 3.25.76",
        "",
        "snapshots:",
        "",
        "  '@google/genai@1.51.0(@modelcontextprotocol/sdk@1.29.0(zod@3.25.76))':",
        "    dependencies:",
        "      protobufjs: 7.5.8",
        "      ws: 8.21.0",
        "    optionalDependencies:",
        "      '@modelcontextprotocol/sdk': 1.29.0(zod@3.25.76)",
        "",
        "  '@modelcontextprotocol/sdk@1.29.0(zod@3.25.76)':",
        "    dependencies:",
        "      content-type: 1.0.5",
        "      zod: 3.25.76",
        "",
        "  protobufjs@7.5.8: {}",
        "  raw-body@3.0.2:",
        "    dependencies:",
        "      content-type: 2.0.0",
        "  content-type@1.0.5: {}",
        "  content-type@2.0.0: {}",
        "  ws@8.21.0: {}",
        "  zod@3.25.76: {}",
        "",
      ].join("\n"),
      "utf8",
    );

    const overrides = await buildVersionedInstallThirdPartyOverrides({
      repoRoot,
      workspacePackages: [
        { name: "@polli-labs/calyx", relativePath: "packages/cli" },
        { name: "@polli-labs/calyx-core", relativePath: "packages/core" },
      ],
    });

    expect(overrides).toMatchObject({
      "@google/genai": "1.51.0",
      "@modelcontextprotocol/sdk": "1.29.0",
      "raw-body": "3.0.2",
      "raw-body>content-type": "2.0.0",
      "@modelcontextprotocol/sdk>content-type": "1.0.5",
      protobufjs: "7.5.8",
      ws: "8.21.0",
      zod: "3.25.76",
    });
    expect(overrides).not.toHaveProperty("content-type");
  });

  test("derives the complete transitive workspace runtime closure for versioned installs", async () => {
    const closureRoot = path.join(root, "workspace-closure");
    await mkdir(path.join(closureRoot, "packages", "cli"), { recursive: true });
    await mkdir(path.join(closureRoot, "packages", "client"), { recursive: true });
    await mkdir(path.join(closureRoot, "packages", "core"), { recursive: true });
    await mkdir(path.join(closureRoot, "packages", "unrelated"), { recursive: true });
    await writeFile(path.join(closureRoot, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "importers:",
      "  packages/cli: {}",
      "  packages/client: {}",
      "  packages/core: {}",
      "  packages/unrelated: {}",
      "snapshots: {}",
      "",
    ].join("\n"), "utf8");
    await writeFile(path.join(closureRoot, "packages", "cli", "package.json"), `${JSON.stringify({
      name: "@polli-labs/calyx",
      dependencies: { "@polli-labs/calyx-client": "workspace:*" },
    })}\n`, "utf8");
    await writeFile(path.join(closureRoot, "packages", "client", "package.json"), `${JSON.stringify({
      name: "@polli-labs/calyx-client",
      optionalDependencies: { "@polli-labs/calyx-core": "workspace:*" },
    })}\n`, "utf8");
    await writeFile(path.join(closureRoot, "packages", "core", "package.json"), `${JSON.stringify({
      name: "@polli-labs/calyx-core",
    })}\n`, "utf8");
    await writeFile(path.join(closureRoot, "packages", "unrelated", "package.json"), `${JSON.stringify({
      name: "@polli-labs/unrelated",
    })}\n`, "utf8");

    await expect(resolveVersionedInstallWorkspacePackages({
      repoRoot: closureRoot,
    })).resolves.toEqual([
      { name: "@polli-labs/calyx-core", relativePath: "packages/core" },
      { name: "@polli-labs/calyx-client", relativePath: "packages/client" },
      { name: "@polli-labs/calyx", relativePath: "packages/cli" },
    ]);
  });

  test("prunes only unprotected installs and sweeps stale promote residue", async () => {
    const realInstallsRoot = path.join(root, "real-installs-prune");
    const aliasParent = path.join(root, "alias");
    const installsRoot = path.join(aliasParent, "installs-prune");
    const currentInstall = path.join(installsRoot, "a".repeat(40));
    const descriptorInstall = path.join(installsRoot, "b".repeat(40));
    const pruneableInstall = path.join(installsRoot, "c".repeat(40));
    const currentLink = path.join(installsRoot, "current");
    const descriptorBin = path.join(descriptorInstall, "node_modules", "@polli-labs", "calyx", "dist", "bin.js");
    const oldStaging = path.join(installsRoot, ".staging-old");
    const freshStaging = path.join(installsRoot, ".staging-fresh");
    const oldCurrentTemp = path.join(installsRoot, ".current-old");
    const oldDate = new Date("2026-06-10T00:00:00.000Z");
    const freshDate = new Date("2026-06-12T11:59:00.000Z");

    await mkdir(realInstallsRoot, { recursive: true });
    await mkdir(aliasParent, { recursive: true });
    await symlink(realInstallsRoot, installsRoot, "dir");
    await mkdir(path.join(currentInstall, "node_modules"), { recursive: true });
    await mkdir(path.dirname(descriptorBin), { recursive: true });
    await mkdir(path.join(pruneableInstall, "node_modules"), { recursive: true });
    await mkdir(oldStaging, { recursive: true });
    await mkdir(freshStaging, { recursive: true });
    await writeFile(descriptorBin, "", "utf8");
    await symlink(path.basename(currentInstall), currentLink, "dir");
    await symlink(path.basename(descriptorInstall), oldCurrentTemp, "dir");
    await utimes(currentInstall, freshDate, freshDate);
    await utimes(descriptorInstall, oldDate, oldDate);
    await utimes(pruneableInstall, oldDate, oldDate);
    await utimes(oldStaging, oldDate, oldDate);
    await utimes(freshStaging, freshDate, freshDate);
    await lutimes(oldCurrentTemp, oldDate, oldDate);

    const result = await pruneVersionedInstalls({
      installsRoot,
      keep: 1,
      nowMs: new Date("2026-06-12T12:30:00.000Z").getTime(),
      descriptors: [makeDescriptor({
        repoRoot,
        runsRoot,
        argv: [process.execPath, descriptorBin, "run", "serve"],
      })],
    });

    expect(result.pruned).toEqual([pruneableInstall]);
    expect(result.swept_stale_temps).toEqual([oldCurrentTemp, oldStaging].sort());
    await expect(access(currentInstall)).resolves.toBeUndefined();
    await expect(access(descriptorInstall)).resolves.toBeUndefined();
    await expect(access(pruneableInstall)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(oldCurrentTemp)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(oldStaging)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(freshStaging)).resolves.toBeUndefined();
  });

  test("prepares a self-contained runnable install without changing current", async () => {
    const gitHead = "b".repeat(40);
    const fakeRepo = path.join(root, "fake-pnpm-workspace");
    const fakeCore = path.join(fakeRepo, "packages", "core");
    const fakeCli = path.join(fakeRepo, "packages", "cli");
    const installsRoot = path.join(root, "installs");
    await mkdir(path.join(fakeCore, "dist"), { recursive: true });
    await mkdir(path.join(fakeCli, "dist"), { recursive: true });
    await mkdir(path.join(installsRoot, "old-a"), { recursive: true });
    await mkdir(path.join(installsRoot, "old-b"), { recursive: true });
    await writeFile(path.join(fakeRepo, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
    await writeFile(path.join(fakeRepo, "package.json"), `${JSON.stringify({ private: true, packageManager: "pnpm@10.34.1" }, null, 2)}\n`, "utf8");
    await writeFile(
      path.join(fakeCore, "package.json"),
      `${JSON.stringify({
        name: "fake-core",
        version: "1.0.0",
        type: "module",
        main: "./dist/index.js",
        exports: { ".": "./dist/index.js" },
        files: ["dist"],
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(path.join(fakeCore, "dist", "index.js"), "export const marker = 'fake-core-loaded';\n", "utf8");
    await writeFile(
      path.join(fakeCli, "package.json"),
      `${JSON.stringify({
        name: "@polli-labs/calyx",
        version: "1.0.0",
        type: "module",
        bin: { calyx: "dist/bin.js" },
        main: "./dist/bin.js",
        files: ["dist"],
        dependencies: { "fake-core": "workspace:*" },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(fakeCli, "dist", "bin.js"),
      [
        "#!/usr/bin/env node",
        "import { marker } from 'fake-core';",
        "if (process.argv.includes('--version')) console.log('1.0.0');",
        "else console.log(marker);",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(fakeCli, "dist", ".build-info.json"),
      `${JSON.stringify({
        schema_version: "build-info/v1",
        git_head: gitHead,
        built_at: "2026-06-12T00:00:00.000Z",
        package_version: "1.0.0",
        branch: "main",
        dirty: false,
      }, null, 2)}\n`,
      "utf8",
    );
    await execFile("pnpm", ["install", "--ignore-scripts"], { cwd: fakeRepo, env: process.env });

    const receipt = await prepareVersionedInstall({
      repoRoot: fakeRepo,
      gitHead,
      installsRoot,
      keep: 2,
    });

    expect(receipt).toMatchObject({
      git_head: gitHead,
      verified_version: "1.0.0",
      materialized: true,
      promoted: false,
      mechanism: "pack-install",
    });
    await expect(access(path.join(installsRoot, "current"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(receipt.pruned).toEqual([]);
    await expect(access(path.join(installsRoot, "old-a"))).resolves.toBeUndefined();
    await expect(access(path.join(installsRoot, "old-b"))).resolves.toBeUndefined();
    const generatedPackageJson = JSON.parse(await readFile(path.join(receipt.install_path, "package.json"), "utf8")) as {
      pnpm?: unknown;
    };
    const generatedWorkspaceConfig = YAML.parse(await readFile(path.join(receipt.install_path, "pnpm-workspace.yaml"), "utf8")) as {
      overrides?: Record<string, string>;
    };
    expect(generatedPackageJson.pnpm).toBeUndefined();
    expect(generatedWorkspaceConfig.overrides?.["fake-core"]).toMatch(/^file:\.\/tarballs\/fake-core-/);
    expect(generatedWorkspaceConfig.overrides?.["@polli-labs/calyx"]).toMatch(/^file:\.\/tarballs\/polli-labs-calyx-/);
    await expect(readFile(path.join(receipt.install_path, ".npmrc"), "utf8")).resolves.toContain("minimum-release-age=10080");
    await rm(path.join(fakeRepo, "node_modules"), { recursive: true, force: true });
    await expect(access(path.join(fakeRepo, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    const installedRun = await execFile(process.execPath, [receipt.bin_path], {
      cwd: path.parse(fakeRepo).root,
      env: process.env,
    });
    expect(installedRun.stdout.trim()).toBe("fake-core-loaded");

    const secondReceipt = await prepareVersionedInstall({
      repoRoot: fakeRepo,
      gitHead,
      installsRoot,
      keep: 2,
    });
    expect(secondReceipt.materialized).toBe(false);
    expect(secondReceipt.promoted).toBe(false);
    expect(secondReceipt.pruned).toEqual([]);
    await expect(access(path.join(installsRoot, "current"))).rejects.toMatchObject({ code: "ENOENT" });

    const promoted = await promoteVersionedInstall(secondReceipt);
    expect(promoted.promoted).toBe(true);
    expect(await realpath(path.join(installsRoot, "current"))).toBe(await realpath(path.join(installsRoot, gitHead)));
  });

  test("current-link promotion refuses a third concurrent install generation", async () => {
    const previous = await materializeInstallFixture(homeRoot, "a".repeat(40));
    const target = await prepareInstallFixture(homeRoot, "c".repeat(40));
    const foreign = await materializeInstallFixture(homeRoot, "b".repeat(40));

    await expect(promoteVersionedInstall(target, {
      operationId: "self-upgrade-current-link-cas",
      expectedCurrentInstallPaths: [previous.install_path],
    })).rejects.toThrow(/not an accepted predecessor/);
    await expect(realpath(previous.current_link)).resolves.toBe(
      await realpath(foreign.install_path),
    );
  });

  test("POL-2072: cutover expectations are observations of the loaded supervisor, not derivations from source bytes", async () => {
    const targetHead = "c".repeat(40);
    const prepared = await prepareInstallFixture(homeRoot, targetHead);
    const livePath = path.join(homeRoot, "Library", "LaunchAgents", "com.pollilabs.calyx.run-serve.plist");
    const stagedPath = `${livePath}.staged`;
    await mkdir(path.dirname(livePath), { recursive: true });
    // The live definition is mba's real plist: it declares ExitTimeOut=300
    // while launchd resolves 60 (see MBA_LAUNCHCTL_PRINT). Deriving the restore
    // expectation from these bytes therefore cannot match the loaded state.
    await writeFile(livePath, MBA_LIVE_PLIST, "utf8");
    const stagedPlist = MBA_LIVE_PLIST.replace(
      "<integer>300</integer>",
      "<integer>240</integer>",
    );
    const serviceSha = createHash("sha256").update(stagedPlist).digest("hex");
    const buildInfoSha = createHash("sha256").update(await readFile(prepared.build_info_path)).digest("hex");

    // Every expectation in the receipt must trace back to one of these three
    // observations of the same `launchctl print` surface.
    const observedPreviousSha = createHash("sha256")
      .update(JSON.stringify(launchdConfigFromPrint(MBA_LAUNCHCTL_PRINT)))
      .digest("hex");
    const observedTargetSha = "e".repeat(64);
    const effectiveStates = [
      // pre-cutover: what launchd actually reports for the live plist
      { effective_config_sha256: observedPreviousSha, exit_timeout_seconds: 60 },
      // post-install: the resolved target, unknowable before it is loaded
      { effective_config_sha256: observedTargetSha, exit_timeout_seconds: 55 },
      // post-restore: back to the pre-cutover observation
      { effective_config_sha256: observedPreviousSha, exit_timeout_seconds: 60 },
    ];
    const inspectSupervisorEffectiveState = vi.fn(async () => {
      const next = effectiveStates.shift();
      if (!next) throw new Error("unexpected effective-state read");
      return {
        schema_version: "self-upgrade-supervisor-effective-state/v1" as const,
        supervisor_kind: "launchd" as const,
        service_identity: "gui/501/com.pollilabs.calyx.run-serve",
        loaded: true,
        running: true,
        ...next,
      };
    });
    const descriptor = makeDescriptor({
      repoRoot,
      runsRoot,
      supervisor: { kind: "launchd", label: "com.pollilabs.calyx.run-serve", plistPath: livePath },
    });
    const plan = makeSupervisorCutoverPlan({ descriptor, targetHead, host: "mba" });
    const reloads: string[] = [];
    const cutover = await prepareCanonicalSupervisorCutover({
      plan,
      preparedInstall: prepared,
      descriptors: [descriptor],
      operationId: "mba-loaded-state",
      homeDir: homeRoot,
      resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
      runSupervisorStage: async () => {
        await writeFile(stagedPath, stagedPlist, "utf8");
        return supervisorStageResult({
          host: "mba",
          targetHead,
          prepared,
          buildInfoSha,
          livePath,
          stagedPath,
          serviceSha,
        });
      },
      reloadSupervisorDefinition: async () => {
        reloads.push("launchd");
        return "launchd-on-restart";
      },
      createSupervisorAdapter: () => ({
        kind: "launchd",
        stop: async () => ({}),
        start: async () => ({}),
        status: async () => ({ running: true }),
      }),
      inspectSupervisorEffectiveState,
    });

    expect(cutover.readiness.previous_effective_state).toMatchObject({
      effective_config_sha256: observedPreviousSha,
      exit_timeout_seconds: 60,
    });
    // The restore expectation is the pre-mutation observation itself, NOT a
    // hash of the live plist bytes, and carries launchd's resolved 60 rather
    // than the plist's declared 300.
    expect(cutover.readiness.restored_effective_config_sha256).toBe(observedPreviousSha);
    expect(cutover.readiness.restored_exit_timeout_seconds).toBe(60);
    // The target expectation cannot exist before the definition is loaded.
    expect(cutover.readiness.target_effective_config_sha256).toBeUndefined();

    await writeFile(livePath, MBA_LIVE_PLIST.replace(
      "<integer>300</integer>",
      "<integer>301</integer>",
    ), "utf8");
    await expect(cutover.install()).rejects.toThrow(
      /changed after readiness|concurrent config publication/,
    );
    await writeFile(livePath, MBA_LIVE_PLIST, "utf8");
    await cutover.install();

    await expect(cutover.verifyInstalled?.()).resolves.toMatchObject({
      effective_config_sha256: observedTargetSha,
      exit_timeout_seconds: 55,
    });
    // Publishing the observation is what gives committed-phase crash recovery
    // an authority it can actually re-verify.
    expect(cutover.readiness.target_effective_config_sha256).toBe(observedTargetSha);

    await cutover.restore();
    await expect(cutover.verifyRestored?.()).resolves.toMatchObject({
      effective_config_sha256: observedPreviousSha,
      exit_timeout_seconds: 60,
    });
    expect(reloads).toEqual(["launchd", "launchd"]);
  });

  test("POL-2072: rollback stays possible when the supervisor reload fails after the bytes are live", async () => {
    const targetHead = "c".repeat(40);
    const prepared = await prepareInstallFixture(homeRoot, targetHead);
    const livePath = path.join(homeRoot, "Library", "LaunchAgents", "com.pollilabs.calyx.run-serve.plist");
    const stagedPath = `${livePath}.staged`;
    await mkdir(path.dirname(livePath), { recursive: true });
    await writeFile(livePath, MBA_LIVE_PLIST, "utf8");
    const stagedPlist = MBA_LIVE_PLIST.replace(
      "<integer>300</integer>",
      "<integer>240</integer>",
    );
    const serviceSha = createHash("sha256").update(stagedPlist).digest("hex");
    const buildInfoSha = createHash("sha256").update(await readFile(prepared.build_info_path)).digest("hex");
    const descriptor = makeDescriptor({
      repoRoot,
      runsRoot,
      supervisor: { kind: "launchd", label: "com.pollilabs.calyx.run-serve", plistPath: livePath },
    });
    const plan = makeSupervisorCutoverPlan({ descriptor, targetHead, host: "mba" });
    let failReload = true;
    const cutover = await prepareCanonicalSupervisorCutover({
      plan,
      preparedInstall: prepared,
      descriptors: [descriptor],
      operationId: "mba-reload-failure",
      homeDir: homeRoot,
      resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
      runSupervisorStage: async () => {
        await writeFile(stagedPath, stagedPlist, "utf8");
        return supervisorStageResult({
          host: "mba",
          targetHead,
          prepared,
          buildInfoSha,
          livePath,
          stagedPath,
          serviceSha,
        });
      },
      reloadSupervisorDefinition: async () => {
        if (failReload) {
          throw new Error("bootstrap refused the replaced plist");
        }
        return "launchd-on-restart";
      },
      createSupervisorAdapter: () => ({
        kind: "launchd",
        stop: async () => ({}),
        start: async () => ({}),
        status: async () => ({ running: true }),
      }),
      inspectSupervisorEffectiveState: async () => ({
        schema_version: "self-upgrade-supervisor-effective-state/v1" as const,
        supervisor_kind: "launchd" as const,
        service_identity: "gui/501/com.pollilabs.calyx.run-serve",
        loaded: true,
        running: true,
        effective_config_sha256: "f".repeat(64),
        exit_timeout_seconds: 60,
      }),
    });

    // The reload throws only after `replaceSupervisorServiceFile` has already
    // published the target bytes, so the host is live on the new definition.
    await expect(cutover.install()).rejects.toThrow(/bootstrap refused/);
    await expect(readFile(livePath, "utf8")).resolves.toBe(stagedPlist);

    // Rollback must still be possible: the snapshot is captured before the
    // reload, so `restore()` has the authority to put the old bytes back.
    failReload = false;
    const rollback = await cutover.restore();
    expect(rollback.status).toBe("succeeded");
    expect(rollback.error).toBeUndefined();
    await expect(readFile(livePath, "utf8")).resolves.toBe(MBA_LIVE_PLIST);
  });

  test("POL-2072: launchd's resolved state is not derivable from the plist that produced it", () => {
    const resolved = launchdConfigFromPrint(MBA_LAUNCHCTL_PRINT);

    // `launchctl print` prints `arguments` unnumbered on real macOS, and argv[0]
    // is the program itself.
    expect(resolved.program_arguments).toEqual([
      "/Users/caleb/.config/polli/bin/with-polli-secrets",
      "/Users/caleb/.agents/run/calyx",
      "run",
      "serve",
      "--host",
      "0.0.0.0",
      "--port",
      "8740",
      "--runs-root",
      "/Users/caleb/.calyx/runs",
      "--worktree-base",
      "/Users/caleb/projects",
    ]);
    // The `inherited environment` / `default environment` blocks printed ahead
    // of the real one must not be picked up, and only HOME/PATH are retained.
    expect(resolved.environment).toEqual({
      PATH: "/Users/caleb/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    });
    // `inferred program` is a third property; keepalive/runatload still parse.
    expect(resolved.keep_alive).toBe(true);
    expect(resolved.run_at_load).toBe(true);

    // The load-bearing divergence: the live plist declares 300, launchd
    // resolves 60. Any expectation derived from the plist bytes is wrong.
    expect(MBA_LIVE_PLIST).toContain("<key>ExitTimeOut</key>");
    expect(MBA_LIVE_PLIST).toContain("<integer>300</integer>");
    expect(resolved.exit_timeout_seconds).toBe(60);
  });

  test("POL-2072: systemd's resolved state is not derivable from the unit that produced it", () => {
    const resolved = systemdConfigFromShow(BLADE_SYSTEMCTL_SHOW);

    // Specifier expansion: the unit says `%h`, systemd reports the real home.
    expect(BLADE_LIVE_UNIT).toContain("ExecStart=%h/.config/polli/bin/with-polli-secrets");
    expect(resolved.exec_start).toBe(
      "/home/caleb/.config/polli/bin/with-polli-secrets /home/caleb/.agents/run/calyx run serve"
      + " --host 0.0.0.0 --port 8740 --runs-root /home/caleb/.calyx/runs --worktree-base /home/caleb/projects",
    );

    // Signal rendering: the unit says `SIGKILL`, systemd reports `9`.
    expect(BLADE_LIVE_UNIT).toContain("FinalKillSignal=SIGKILL");
    expect(resolved.final_kill_signal).toBe("9");

    // Implicit default: the unit sets no WorkingDirectory at all, systemd
    // reports the home directory with the missing-ok `!` prefix.
    expect(BLADE_LIVE_UNIT).not.toContain("WorkingDirectory=");
    expect(resolved.working_directory).toBe("!/home/caleb");

    // Durations do round-trip, which is why the bug looked plausible.
    expect(BLADE_LIVE_UNIT).toContain("TimeoutStopSec=300s");
    expect(resolved.timeout_stop_usec).toBe("300000000us");
  });

  test("target state readiness accepts only one exact applied-prefix plus pending-suffix plan", () => {
    const applied = Array.from({ length: 30 }, (_, index) => ({
      id: String(index + 1).padStart(4, "0"),
      description: `migration ${index + 1}`,
      appliedAt: "2026-07-23T00:00:00.000Z",
    }));
    const pending = Array.from({ length: 4 }, (_, index) => ({
      id: String(index + 31).padStart(4, "0"),
      description: `migration ${index + 31}`,
      status: "pending",
      growthBound: {
        databaseSizeMultiplier: 4,
        fixedBytes: 8 * 1024 * 1024,
      },
    }));
    expect(assertTargetStateSchemaReady({
      code: 0,
      stdout: JSON.stringify({
        driver: "better-sqlite3",
        current: "0030",
        target: "0034",
        ledgerExists: true,
        applied,
        pending,
      }),
      stderr: "",
    }, "c".repeat(40))).toMatchObject({
      current: "0030",
      target: "0034",
      applied_migrations: applied.map((entry) => entry.id),
      pending_migrations: pending.map((entry) => entry.id),
      pending_migration_growth_bounds: pending.map((entry) => ({
        migration_id: entry.id,
        database_size_multiplier: 4,
        fixed_bytes: 8 * 1024 * 1024,
      })),
    });

    expect(() => assertTargetStateSchemaReady({
      code: 0,
      stdout: JSON.stringify({
        driver: "better-sqlite3",
        current: "0030",
        target: "0034",
        ledgerExists: true,
        applied,
        pending: [pending[1], pending[0], pending[2], pending[3]],
      }),
      stderr: "",
    }, "c".repeat(40))).toThrow(/contiguous source\/ledger sequence/);

    expect(() => assertTargetStateSchemaReady({
      code: 0,
      stdout: JSON.stringify({
        driver: "better-sqlite3",
        current: "0030",
        target: "0031",
        ledgerExists: true,
        applied,
        pending: [{
          id: "0031",
          description: "unbounded target migration",
          status: "pending",
        }],
      }),
      stderr: "",
    }, "c".repeat(40))).toThrow(/bounded migration growth declaration/);
  });

  test("target state migration accepts only the exact admitted migration set (POL-2090)", () => {
    const readiness = assertTargetStateSchemaReady({
      code: 0,
      stdout: JSON.stringify({
        driver: "better-sqlite3",
        current: "0001",
        target: "0003",
        ledgerExists: true,
        applied: [{ id: "0001", description: "baseline", appliedAt: "2026-07-23T00:00:00.000Z" }],
        pending: [
          { id: "0002", description: "two", status: "pending", growthBound: { databaseSizeMultiplier: 4, fixedBytes: 8 } },
          { id: "0003", description: "three", status: "pending", growthBound: { databaseSizeMultiplier: 4, fixedBytes: 8 } },
        ],
      }),
      stderr: "",
    }, "c".repeat(40));

    const applyResult = (overrides: Record<string, unknown> = {}) => ({
      code: 0,
      stdout: JSON.stringify({
        driver: "better-sqlite3",
        applied: [
          { id: "0002", description: "two", appliedAt: "2026-07-27T00:00:00.000Z" },
          { id: "0003", description: "three", appliedAt: "2026-07-27T00:00:01.000Z" },
        ],
        alreadyApplied: [{ id: "0001", description: "baseline", appliedAt: "2026-07-23T00:00:00.000Z" }],
        current: "0003",
        target: "0003",
        ...overrides,
      }),
      stderr: "",
    });

    expect(assertTargetStateSchemaMigrated(applyResult(), "c".repeat(40), readiness)).toMatchObject({
      status: "migrated",
      current: "0003",
      target: "0003",
      applied_migrations: ["0002", "0003"],
    });

    // A migration outside the admitted set escaped the capacity reserve the
    // preflight sized, so the ledger moving forward is not success.
    expect(() => assertTargetStateSchemaMigrated(
      applyResult({
        applied: [
          { id: "0002", description: "two", appliedAt: "2026-07-27T00:00:00.000Z" },
          { id: "0003", description: "three", appliedAt: "2026-07-27T00:00:01.000Z" },
          { id: "0004", description: "four", appliedAt: "2026-07-27T00:00:02.000Z" },
        ],
        current: "0004",
        target: "0004",
      }),
      "c".repeat(40),
      readiness,
    )).toThrow(/outside its admitted growth reserve/);

    // The store changed under the preflight between plan and apply.
    expect(() => assertTargetStateSchemaMigrated(
      applyResult({ alreadyApplied: [] }),
      "c".repeat(40),
      readiness,
    )).toThrow(/different pre-existing ledger/);

    expect(() => assertTargetStateSchemaMigrated(
      applyResult({ current: "0002", target: "0003" }),
      "c".repeat(40),
      readiness,
    )).toThrow(/did not converge the ledger/);

    expect(() => assertTargetStateSchemaMigrated(
      { code: 1, stdout: "", stderr: "database is locked" },
      "c".repeat(40),
      readiness,
    )).toThrow(/no binary or supervisor change has been made/);
  });

  test("quiesced state snapshot checkpoints WAL and restores exact pre-upgrade bytes", async () => {
    let opened = await openStateStore();
    opened.db.exec("CREATE TABLE pol_2072_probe (value TEXT NOT NULL)");
    opened.db.prepare("INSERT INTO pol_2072_probe (value) VALUES (?)").run("before");
    opened.db.close();

    const cutover = await prepareStateCutoverSnapshot({
      operationId: "state-crash-boundary",
      homeDir: homeRoot,
    });
    expect(cutover.snapshot).toMatchObject({
      restore_strategy: "precreated-same-filesystem-hardlink-rename",
      capacity_preflight: {
        same_device: true,
        snapshot_bytes: cutover.snapshot.size_bytes,
        rollback_allocation_bytes: 16 * 1024 * 1024,
      },
    });
    expect(cutover.snapshot.capacity_preflight?.required_bytes).toBeGreaterThan(
      cutover.snapshot.size_bytes * 2,
    );
    expect(cutover.snapshot.backup_path).toContain(
      `${path.sep}.self-upgrade-backups${path.sep}state-crash-boundary${path.sep}`,
    );
    expect(cutover.snapshot.rollback_candidate_path).toBe(
      path.join(
        path.dirname(cutover.snapshot.database_path),
        ".calyx.db.state-crash-boundary.rollback",
      ),
    );
    const reserve = await stat(cutover.snapshot.rollback_reserve_path!);
    expect(reserve.blocks * 512).toBeGreaterThanOrEqual(16 * 1024 * 1024);
    opened = await openStateStore();
    opened.db.prepare("UPDATE pol_2072_probe SET value = ?").run("after");
    opened.db.close();

    await expect(cutover.restore()).resolves.toMatchObject({
      status: "succeeded",
      restored_sha256: cutover.snapshot.database_sha256,
      quick_check: "ok",
    });
    opened = await openStateStore();
    expect(opened.db.prepare("SELECT value FROM pol_2072_probe").get()).toEqual({ value: "before" });
    opened.db.close();
    await cutover.cleanup();
    await expect(access(cutover.snapshot.backup_path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("state rollback refuses a same-bytes backup leaf replacement", async () => {
    const cutover = await prepareStateCutoverSnapshot({
      operationId: "state-backup-identity-swap",
      homeDir: homeRoot,
    });
    const originalBytes = await readFile(cutover.snapshot.backup_path);
    await rm(cutover.snapshot.backup_path, { force: true });
    await writeFile(cutover.snapshot.backup_path, originalBytes, { mode: 0o600 });

    await expect(cutover.restore()).resolves.toMatchObject({
      status: "failed",
      error: expect.stringMatching(
        /pathname no longer names|filesystem identity changed|pin one physical image|retained handle no longer matches/,
      ),
    });
    await cutover.cleanup();
  });

  test("invocation-start recovery rolls back a crash-durable mixed cutover before new work", async () => {
    const operationId = "self-upgrade-interrupted-cutover";
    const previousHead = "a".repeat(40);
    const targetHead = "c".repeat(40);
    const previous = await materializeInstallFixture(homeRoot, previousHead);
    const target = await prepareInstallFixture(homeRoot, targetHead);
    await promoteVersionedInstall(target);
    const wrapperPath = path.join(homeRoot, ".agents", "run", "calyx");
    await mkdir(path.dirname(wrapperPath), { recursive: true });
    await writeFile(wrapperPath, `SOURCE_EXECUTABLE_PATH='${currentInstallBin(homeRoot)}'\n`, "utf8");

    let opened = await openStateStore();
    opened.db.exec("CREATE TABLE pol_2072_crash (value TEXT NOT NULL)");
    opened.db.prepare("INSERT INTO pol_2072_crash (value) VALUES (?)").run("before");
    opened.db.close();
    const stateCutover = await prepareStateCutoverSnapshot({
      operationId,
      homeDir: homeRoot,
    });
    opened = await openStateStore();
    opened.db.prepare("UPDATE pol_2072_crash SET value = ?").run("after");
    opened.db.close();

    const descriptors = new Map<string, CalyxDaemonDescriptor>();
    const targetDescriptor = makeDescriptor({
      repoRoot,
      runsRoot,
      gitHead: targetHead,
      argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
    });
    descriptors.set(targetDescriptor.daemon_id, targetDescriptor);
    const oldPlanDaemon = {
      daemon_id: targetDescriptor.daemon_id,
      pid: targetDescriptor.pid,
      runs_root: targetDescriptor.runs_root,
      health_url: targetDescriptor.health_url,
      restart_order: targetDescriptor.restart_order,
      supervisor: targetDescriptor.supervisor,
      build: { ...targetDescriptor.build, git_head: previousHead },
      maintenance_mode: false,
    };
    const journal: SelfUpgradeCutoverJournal = {
      schema_version: "self-upgrade-cutover-journal/v1",
      operation_id: operationId,
      host: "blade",
      phase: "binary_promoted",
      updated_at: "2026-07-23T00:00:00.000Z",
      previous_install_path: previous.install_path,
      previous_git_head: previousHead,
      current_link: previous.current_link,
      wrapper_path: wrapperPath,
      target_install_path: target.install_path,
      descriptors: [targetDescriptor],
      plan_daemons: [oldPlanDaemon],
      supervisor_readiness: {
        schema_version: "self-upgrade-supervisor-readiness/v1",
        status: "unchanged",
        target_git_head: targetHead,
        source: "live-supervisor",
        supervisor_kinds: [],
      },
      state_snapshot: stateCutover.snapshot,
    };
    const journalRoot = path.join(homeRoot, ".calyx", "self-upgrade-cutovers");
    await writeCutoverJournal(journalRoot, journal);
    await recoverInterruptedCutover({
      homeDir: homeRoot,
      host: "blade",
      authToken: "secret-token",
      createSupervisorAdapter: () => ({
        kind: "direct",
        stop: async () => ({ signal: "SIGTERM" }),
        start: async () => {
          descriptors.set(targetDescriptor.daemon_id, makeDescriptor({
            repoRoot,
            runsRoot,
            gitHead: previousHead,
            argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
          }));
          return { pid: 5150 };
        },
        status: async () => ({ running: true }),
      }),
      inspectSupervisorEffectiveState: async () => {
        throw new Error("unchanged supervisor recovery must not inspect effective state");
      },
      reloadSupervisorDefinition: async () => "launchd-on-restart",
      createAdminClient: createAdminClientFactory(vi.fn(async () => daemonHealthResponse(previousHead))),
      sleep: async () => {},
      monotonicNowMs: () => 0,
      readDescriptor: async (daemonId) => descriptors.get(daemonId),
      writeDescriptor: async (next) => {
        descriptors.set(next.daemon_id, next);
        return path.join(root, `${next.daemon_id}.json`);
      },
    });

    expect(await realpath(previous.current_link)).toBe(await realpath(previous.install_path));
    opened = await openStateStore();
    expect(opened.db.prepare("SELECT value FROM pol_2072_crash").get()).toEqual({ value: "before" });
    opened.db.close();
    await expect(access(path.join(journalRoot, `${operationId}.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("POL-2095: recovery finishes forward only after rollback authority is exhausted and the target re-verifies", async () => {
    const operationId = "self-upgrade-exhausted-rollback";
    const previousHead = "a".repeat(40);
    const targetHead = "c".repeat(40);
    const previous = await materializeInstallFixture(homeRoot, previousHead);
    const target = await prepareInstallFixture(homeRoot, targetHead);
    const wrapperPath = path.join(homeRoot, ".agents", "run", "calyx");
    await mkdir(path.dirname(wrapperPath), { recursive: true });
    await writeFile(wrapperPath, `SOURCE_EXECUTABLE_PATH='${currentInstallBin(homeRoot)}'\n`, "utf8");

    // Reproduce the live Blade residue: the prior rollback already renamed
    // the pre-created candidate over the database and released its reserve,
    // leaving the retained backup as a hard link to the now-live database.
    const stateCutover = await prepareStateCutoverSnapshot({
      operationId,
      homeDir: homeRoot,
    });
    await expect(stateCutover.restore()).resolves.toMatchObject({ status: "succeeded" });

    const livePath = path.join(
      homeRoot,
      "Library",
      "LaunchAgents",
      "com.pollilabs.calyx.run-serve.plist",
    );
    const stagedPath = `${livePath}.staged`;
    await mkdir(path.dirname(livePath), { recursive: true });
    await writeFile(livePath, MBA_LIVE_PLIST, "utf8");
    const stagedPlist = MBA_LIVE_PLIST.replace(
      "<integer>300</integer>",
      "<integer>240</integer>",
    );
    const stagedSha = createHash("sha256").update(stagedPlist).digest("hex");
    const previousSha = createHash("sha256").update(MBA_LIVE_PLIST).digest("hex");
    const targetPackageRoot = path.dirname(path.dirname(target.bin_path));
    const targetPackageJson = `${JSON.stringify({
      name: "@polli-labs/calyx",
      version: "0.2.0",
    }, null, 2)}\n`;
    await writeFile(path.join(targetPackageRoot, "package.json"), targetPackageJson, "utf8");
    const buildInfoSha = createHash("sha256")
      .update(await readFile(target.build_info_path))
      .digest("hex");
    const targetBinBytes = await readFile(target.bin_path);
    const artifactManifest = createHash("sha256");
    artifactManifest.update(
      `file\0@polli-labs/calyx/dist/bin.js\0${targetBinBytes.length}\0${
        createHash("sha256").update(targetBinBytes).digest("hex")
      }\0`,
    );
    artifactManifest.update(
      `file\0@polli-labs/calyx/package.json\0${Buffer.byteLength(targetPackageJson)}\0${
        createHash("sha256").update(targetPackageJson).digest("hex")
      }\0`,
    );
    const targetArtifactManifestSha = artifactManifest.digest("hex");
    const supervisorBackupPath = path.join(
      homeRoot,
      ".calyx",
      "self-upgrade-cutovers",
      operationId,
      "supervisor.previous",
    );
    await mkdir(path.dirname(supervisorBackupPath), { recursive: true });
    await writeFile(supervisorBackupPath, MBA_LIVE_PLIST, "utf8");

    const targetDescriptor = makeDescriptor({
      repoRoot,
      runsRoot,
      gitHead: targetHead,
      argv: [process.execPath, wrapperPath, "run", "serve"],
      supervisor: {
        kind: "launchd",
        label: "com.pollilabs.calyx.run-serve",
        plistPath: livePath,
      },
      maintenanceMode: false,
    });
    let currentDescriptor = targetDescriptor;
    const planDaemon = {
      daemon_id: targetDescriptor.daemon_id,
      pid: targetDescriptor.pid,
      runs_root: targetDescriptor.runs_root,
      health_url: targetDescriptor.health_url,
      restart_order: targetDescriptor.restart_order,
      supervisor: targetDescriptor.supervisor,
      build: { ...targetDescriptor.build, git_head: previousHead },
      maintenance_mode: false,
    };
    const journal: SelfUpgradeCutoverJournal = {
      schema_version: "self-upgrade-cutover-journal/v1",
      operation_id: operationId,
      host: "blade",
      phase: "target_started",
      updated_at: "2026-07-28T07:30:16.260Z",
      previous_install_path: previous.install_path,
      previous_git_head: previousHead,
      current_link: previous.current_link,
      wrapper_path: wrapperPath,
      target_install_path: target.install_path,
      descriptors: [targetDescriptor],
      plan_daemons: [planDaemon],
      maintenance_before: [{ daemon_id: targetDescriptor.daemon_id, enabled: false }],
      target_acceptance: {
        schema_version: "self-upgrade-target-acceptance/v1",
        status: "accepted",
        operation_id: operationId,
        executor_realpath: await realpath(target.bin_path),
        node_realpath: await realpath(process.execPath),
        node_version: process.version,
        target_git_head: targetHead,
        target_build_info_sha256: buildInfoSha,
        target_artifact_manifest_sha256: targetArtifactManifestSha,
        target_artifact_manifest_packages: ["@polli-labs/calyx"],
        handoff_interface: "self-upgrade-target-handoff/v1",
        planning_interface: "self-upgrade-target-planning/v1",
        startup_contract_interface: "calyx-startup-contract/v1",
        accepted_at: "2026-07-28T07:30:16.260Z",
      },
      supervisor_readiness: {
        schema_version: "self-upgrade-supervisor-readiness/v1",
        status: "ready",
        target_git_head: targetHead,
        source: "agents-infra",
        source_sha256: stagedSha,
        supervisor_kinds: ["launchd"],
        live_service_path: livePath,
        staged_service_path: stagedPath,
        previous_service_sha256: previousSha,
        previous_service_present: true,
        previous_service_backup_path: supervisorBackupPath,
        previous_service_mode: 0o600,
        previous_loaded: true,
        previous_running: true,
        previous_effective_state: {
          schema_version: "self-upgrade-supervisor-effective-state/v1",
          supervisor_kind: "launchd",
          service_identity: "gui/501/com.pollilabs.calyx.run-serve",
          loaded: true,
          running: true,
          effective_config_sha256: "d".repeat(64),
          exit_timeout_seconds: 60,
        },
        restored_effective_config_sha256: "d".repeat(64),
        restored_exit_timeout_seconds: 60,
      },
      state_snapshot: stateCutover.snapshot,
    };
    const journalRoot = path.join(homeRoot, ".calyx", "self-upgrade-cutovers");
    await writeCutoverJournal(journalRoot, journal);
    const createSupervisorAdapter = vi.fn();
    const reloadSupervisorDefinition = vi.fn(async () => "launchd-on-restart" as const);
    const targetEffectiveSha = "e".repeat(64);
    const concurrentSupervisorBytes = stagedPlist.replace(
      "<integer>240</integer>",
      "<integer>241</integer>",
    );
    const inspectSupervisorEffectiveState = vi.fn(async () => {
      return {
        schema_version: "self-upgrade-supervisor-effective-state/v1" as const,
        supervisor_kind: "launchd" as const,
        service_identity: "gui/501/com.pollilabs.calyx.run-serve",
        loaded: true,
        running: true,
        effective_config_sha256: targetEffectiveSha,
        exit_timeout_seconds: 55,
      };
    });

    const recoveryArgs: Omit<
      Parameters<typeof recoverInterruptedCutover>[0],
      "createAdminClient"
    > = {
      homeDir: homeRoot,
      host: "blade",
      authToken: "secret-token",
      now: () => "2026-07-28T08:30:00.000Z",
      resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
      runSupervisorStage: async () => {
        await writeFile(stagedPath, stagedPlist, "utf8");
        return supervisorStageResult({
          host: "blade",
          targetHead,
          prepared: target,
          buildInfoSha,
          livePath,
          stagedPath,
          serviceSha: stagedSha,
        });
      },
      runTargetStatePlan: async () => ({
        code: 0,
        stdout: JSON.stringify({
          driver: "better-sqlite3",
          current: "0001",
          target: "0001",
          ledgerExists: true,
          applied: [{
            id: "0001",
            description: "baseline",
            appliedAt: "2026-07-23T00:00:00.000Z",
          }],
          pending: [],
        }),
        stderr: "",
      }),
      createSupervisorAdapter,
      inspectSupervisorEffectiveState,
      reloadSupervisorDefinition,
      sleep: async () => {},
      monotonicNowMs: () => 0,
      readDescriptor: async () => currentDescriptor,
      writeDescriptor: async (next) => {
        currentDescriptor = next;
        return path.join(root, "run-serve.json");
      },
    };
    const unexpectedHealthClient = createAdminClientFactory(vi.fn(async () => {
      throw new Error("finish-forward reached dynamic health before static authority");
    }));
    const rollbackCandidatePath = stateCutover.snapshot.rollback_candidate_path!;
    await symlink("dangling-rollback-authority", rollbackCandidatePath);
    await expect(recoverInterruptedCutover({
      ...recoveryArgs,
      createAdminClient: unexpectedHealthClient,
    })).rejects.toThrow(/State rollback candidate is not a physical regular file/);
    await rm(rollbackCandidatePath);
    expect(await realpath(previous.current_link)).toBe(await realpath(previous.install_path));
    expect(await readFile(livePath, "utf8")).toBe(MBA_LIVE_PLIST);

    const stateBackupRoot = path.dirname(stateCutover.snapshot.backup_path);
    const displacedStateBackupRoot = `${stateBackupRoot}.recorded`;
    await rename(stateBackupRoot, displacedStateBackupRoot);
    await mkdir(stateBackupRoot);
    await link(
      stateCutover.snapshot.database_path,
      stateCutover.snapshot.backup_path,
    );
    try {
      await expect(recoverInterruptedCutover({
        ...recoveryArgs,
        createAdminClient: unexpectedHealthClient,
      })).rejects.toThrow(/Interrupted state snapshot parent.*identity changed/);
    } finally {
      await rm(stateBackupRoot, { recursive: true, force: true });
      await rename(displacedStateBackupRoot, stateBackupRoot);
    }
    expect(await realpath(previous.current_link)).toBe(await realpath(previous.install_path));
    expect(await readFile(livePath, "utf8")).toBe(MBA_LIVE_PLIST);

    const snapshotWithoutBackupParent = {
      ...stateCutover.snapshot,
    };
    delete snapshotWithoutBackupParent.backup_parent_identity;
    await writeCutoverJournal(journalRoot, {
      ...journal,
      state_snapshot: snapshotWithoutBackupParent,
    });
    await expect(recoverInterruptedCutover({
      ...recoveryArgs,
      createAdminClient: unexpectedHealthClient,
    })).rejects.toThrow(/lacks complete pre-created rollback authority/);
    expect(await realpath(previous.current_link)).toBe(await realpath(previous.install_path));
    expect(await readFile(livePath, "utf8")).toBe(MBA_LIVE_PLIST);

    const journalWithoutAcceptance = { ...journal };
    delete journalWithoutAcceptance.target_acceptance;
    await writeCutoverJournal(journalRoot, journalWithoutAcceptance);
    await expect(recoverInterruptedCutover({
      ...recoveryArgs,
      createAdminClient: unexpectedHealthClient,
    })).rejects.toThrow(/cannot finish forward without exact target acceptance/);
    expect(await realpath(previous.current_link)).toBe(await realpath(previous.install_path));
    expect(await readFile(livePath, "utf8")).toBe(MBA_LIVE_PLIST);

    const readinessWithoutEffectiveState = {
      ...journal.supervisor_readiness,
    };
    delete readinessWithoutEffectiveState.previous_effective_state;
    await writeCutoverJournal(journalRoot, {
      ...journal,
      supervisor_readiness: readinessWithoutEffectiveState,
    });
    await expect(recoverInterruptedCutover({
      ...recoveryArgs,
      createAdminClient: unexpectedHealthClient,
    })).rejects.toThrow(/lacks exact supervisor identity authority/);
    expect(await realpath(previous.current_link)).toBe(await realpath(previous.install_path));
    expect(await readFile(livePath, "utf8")).toBe(MBA_LIVE_PLIST);
    await writeCutoverJournal(journalRoot, journal);

    await expect(recoverInterruptedCutover({
      ...recoveryArgs,
      createAdminClient: createAdminClientFactory(
        vi.fn(async () => readoptHealthResponse(targetHead, {
          withFlag: false,
          activeRuns: 1,
        })),
      ),
    })).rejects.toThrow(/cannot finish forward with 1 active runs/);
    expect(await realpath(previous.current_link)).toBe(await realpath(previous.install_path));
    expect(await readFile(livePath, "utf8")).toBe(MBA_LIVE_PLIST);
    expect(reloadSupervisorDefinition).not.toHaveBeenCalled();
    await expect(access(path.join(journalRoot, `${operationId}.json`))).resolves.toBeUndefined();

    const recoveryAbort = new AbortController();
    let boundedHealthReads = 0;
    await expect(recoverInterruptedCutover({
      ...recoveryArgs,
      recoverySignal: recoveryAbort.signal,
      createAdminClient: createAdminClientFactory(vi.fn(async () => {
        boundedHealthReads += 1;
        if (boundedHealthReads === 1) {
          return daemonHealthResponse(targetHead, "blade", {
            maintenanceMode: currentDescriptor.maintenance_mode ?? false,
          });
        }
        recoveryAbort.abort();
        throw new DOMException("finish-forward health proof aborted", "AbortError");
      })),
    })).rejects.toThrow(/abort|fetch/i);
    expect(currentDescriptor.maintenance_mode).toBe(true);
    expect(await realpath(previous.current_link)).toBe(await realpath(previous.install_path));
    expect(await readFile(livePath, "utf8")).toBe(MBA_LIVE_PLIST);
    currentDescriptor = {
      ...currentDescriptor,
      maintenance_mode: false,
    };

    let concurrentHealthReads = 0;
    await expect(recoverInterruptedCutover({
      ...recoveryArgs,
      createAdminClient: createAdminClientFactory(
        vi.fn(async () => {
          concurrentHealthReads += 1;
          if (concurrentHealthReads === 3) {
            await writeFile(livePath, concurrentSupervisorBytes, "utf8");
          }
          return daemonHealthResponse(targetHead, "blade", {
            maintenanceMode: currentDescriptor.maintenance_mode ?? false,
          });
        }),
      ),
    })).rejects.toThrow(/concurrent supervisor publication during final target verification/);
    expect(currentDescriptor.maintenance_mode).toBe(true);
    expect(await realpath(previous.current_link)).toBe(await realpath(target.install_path));
    expect(await readFile(livePath, "utf8")).toBe(concurrentSupervisorBytes);
    await expect(access(path.join(journalRoot, `${operationId}.json`))).resolves.toBeUndefined();
    await writeFile(livePath, stagedPlist, "utf8");

    await recoverInterruptedCutover({
      ...recoveryArgs,
      createAdminClient: createAdminClientFactory(
        vi.fn(async () => daemonHealthResponse(targetHead, "blade", {
          maintenanceMode: currentDescriptor.maintenance_mode ?? false,
        })),
      ),
    });

    expect(await realpath(previous.current_link)).toBe(await realpath(target.install_path));
    expect(await readFile(livePath, "utf8")).toBe(stagedPlist);
    expect(currentDescriptor.maintenance_mode).toBe(false);
    expect(createSupervisorAdapter).not.toHaveBeenCalled();
    expect(reloadSupervisorDefinition).toHaveBeenCalledTimes(2);
    expect(inspectSupervisorEffectiveState).toHaveBeenCalledTimes(3);
    await expect(access(path.join(journalRoot, `${operationId}.json`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.dirname(stateCutover.snapshot.backup_path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("invocation-start recovery never rolls back a durably committed target", async () => {
    const operationId = "self-upgrade-committed-cutover";
    const previousHead = "a".repeat(40);
    const targetHead = "c".repeat(40);
    const previous = await materializeInstallFixture(homeRoot, previousHead);
    const target = await prepareInstallFixture(homeRoot, targetHead);
    await promoteVersionedInstall(target);
    const descriptor = makeDescriptor({
      repoRoot,
      runsRoot,
      gitHead: targetHead,
      maintenanceMode: true,
      argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
    });
    let committedDescriptor = descriptor;
    const journal: SelfUpgradeCutoverJournal = {
      schema_version: "self-upgrade-cutover-journal/v1",
      operation_id: operationId,
      host: "blade",
      phase: "committed",
      updated_at: "2026-07-23T00:00:00.000Z",
      previous_install_path: previous.install_path,
      previous_git_head: previousHead,
      current_link: previous.current_link,
      wrapper_path: path.join(homeRoot, ".agents", "run", "calyx"),
      target_install_path: target.install_path,
      descriptors: [descriptor],
      plan_daemons: [{
        daemon_id: descriptor.daemon_id,
        pid: descriptor.pid,
        runs_root: descriptor.runs_root,
        health_url: descriptor.health_url,
        restart_order: descriptor.restart_order,
        supervisor: descriptor.supervisor,
        build: descriptor.build,
        maintenance_mode: false,
      }],
      supervisor_readiness: {
        schema_version: "self-upgrade-supervisor-readiness/v1",
        status: "unchanged",
        target_git_head: targetHead,
        source: "live-supervisor",
        supervisor_kinds: [],
      },
      state_snapshot: {
        schema_version: "self-upgrade-state-snapshot/v1",
        status: "snapshotted",
        database_path: path.join(homeRoot, "state", "calyx.db"),
        backup_path: path.join(
          homeRoot,
          "state",
          ".self-upgrade-backups",
          operationId,
          "calyx.db",
        ),
        database_sha256: "d".repeat(64),
        size_bytes: 1,
        wal_checkpoint: "truncate",
        quick_check: "ok",
        rollback_candidate_path: path.join(
          homeRoot,
          "state",
          `.calyx.db.${operationId}.rollback`,
        ),
      },
    };
    const journalRoot = path.join(homeRoot, ".calyx", "self-upgrade-cutovers");
    await writeCutoverJournal(journalRoot, journal);
    await mkdir(path.join(homeRoot, ".agents", "run"), { recursive: true });
    await writeFile(
      path.join(homeRoot, ".agents", "run", "calyx"),
      `SOURCE_EXECUTABLE_PATH='${currentInstallBin(homeRoot)}'\n`,
      "utf8",
    );
    const createSupervisorAdapter = vi.fn(() => ({
      kind: "direct" as const,
      stop: async () => ({ signal: "SIGTERM" }),
      start: async () => ({ pid: descriptor.pid }),
      status: async () => ({ running: true, pid: descriptor.pid }),
    }));
    await recoverInterruptedCutover({
      homeDir: homeRoot,
      host: "blade",
      authToken: "secret-token",
      createSupervisorAdapter,
      inspectSupervisorEffectiveState: async () => {
        throw new Error("unchanged committed recovery must not inspect effective state");
      },
      reloadSupervisorDefinition: async () => "launchd-on-restart",
      createAdminClient: createAdminClientFactory(vi.fn(async () => daemonHealthResponse(targetHead))),
      sleep: async () => {},
      monotonicNowMs: () => 0,
      readDescriptor: async () => committedDescriptor,
      writeDescriptor: async (next) => {
        committedDescriptor = next;
        return path.join(root, "run-serve.json");
      },
    });
    expect(createSupervisorAdapter).not.toHaveBeenCalled();
    expect(await realpath(previous.current_link)).toBe(await realpath(target.install_path));
    expect(committedDescriptor.maintenance_mode).toBe(false);
    await expect(access(path.join(journalRoot, `${operationId}.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("prepared recovery restores the exact prior maintenance state before retiring quiesce intent", async () => {
    const operationId = "self-upgrade-prepared-maintenance";
    const previousHead = "a".repeat(40);
    const targetHead = "c".repeat(40);
    const previous = await materializeInstallFixture(homeRoot, previousHead);
    const target = await prepareInstallFixture(homeRoot, targetHead);
    const wrapperPath = path.join(homeRoot, ".agents", "run", "calyx");
    await mkdir(path.dirname(wrapperPath), { recursive: true });
    await writeFile(wrapperPath, `SOURCE_EXECUTABLE_PATH='${currentInstallBin(homeRoot)}'\n`, "utf8");
    const descriptor = makeDescriptor({
      repoRoot,
      runsRoot,
      gitHead: previousHead,
      maintenanceMode: true,
      argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
    });
    let currentDescriptor = descriptor;
    const journal: SelfUpgradeCutoverJournal = {
      schema_version: "self-upgrade-cutover-journal/v1",
      operation_id: operationId,
      host: "blade",
      phase: "prepared",
      updated_at: "2026-07-23T00:00:00.000Z",
      previous_install_path: previous.install_path,
      previous_git_head: previousHead,
      current_link: previous.current_link,
      wrapper_path: wrapperPath,
      target_install_path: target.install_path,
      descriptors: [descriptor],
      plan_daemons: [{
        daemon_id: descriptor.daemon_id,
        pid: descriptor.pid,
        runs_root: descriptor.runs_root,
        health_url: descriptor.health_url,
        restart_order: descriptor.restart_order,
        supervisor: descriptor.supervisor,
        build: descriptor.build,
        maintenance_mode: false,
      }],
      maintenance_before: [{ daemon_id: descriptor.daemon_id, enabled: false }],
      supervisor_readiness: {
        schema_version: "self-upgrade-supervisor-readiness/v1",
        status: "unchanged",
        target_git_head: targetHead,
        source: "live-supervisor",
        supervisor_kinds: [],
      },
    };
    const journalRoot = path.join(homeRoot, ".calyx", "self-upgrade-cutovers");
    await writeCutoverJournal(journalRoot, journal);
    const createSupervisorAdapter = vi.fn();

    await recoverInterruptedCutover({
      homeDir: homeRoot,
      host: "blade",
      authToken: "secret-token",
      createSupervisorAdapter,
      inspectSupervisorEffectiveState: vi.fn(),
      reloadSupervisorDefinition: vi.fn(),
      createAdminClient: createAdminClientFactory(vi.fn()),
      sleep: async () => {},
      monotonicNowMs: () => 0,
      readDescriptor: async () => currentDescriptor,
      writeDescriptor: async (next) => {
        currentDescriptor = next;
        return path.join(root, "run-serve.json");
      },
    });

    expect(currentDescriptor.maintenance_mode).toBe(false);
    expect(createSupervisorAdapter).not.toHaveBeenCalled();
    await expect(access(path.join(journalRoot, `${operationId}.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("POL-2072: --dry-run refuses a pending cutover journal instead of recovering it", async () => {
    const operationId = "self-upgrade-dry-run-pending-journal";
    const previousHead = "a".repeat(40);
    const targetHead = "c".repeat(40);
    const previous = await materializeInstallFixture(homeRoot, previousHead);
    const target = await prepareInstallFixture(homeRoot, targetHead);
    const wrapperPath = path.join(homeRoot, ".agents", "run", "calyx");
    await mkdir(path.dirname(wrapperPath), { recursive: true });
    await writeFile(wrapperPath, `SOURCE_EXECUTABLE_PATH='${currentInstallBin(homeRoot)}'\n`, "utf8");
    const descriptor = makeDescriptor({
      repoRoot,
      runsRoot,
      gitHead: previousHead,
      maintenanceMode: true,
      argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
    });
    const journalRoot = path.join(homeRoot, ".calyx", "self-upgrade-cutovers");
    // `quiesced` is past the prepared boundary, so recovery would rewrite
    // descriptors; a `daemons_stopped` journal would additionally stop daemons,
    // restore SQLite and re-promote. None of that may happen under --dry-run.
    await writeCutoverJournal(journalRoot, {
      schema_version: "self-upgrade-cutover-journal/v1",
      operation_id: operationId,
      host: "blade",
      phase: "quiesced",
      updated_at: "2026-07-25T00:00:00.000Z",
      previous_install_path: previous.install_path,
      previous_git_head: previousHead,
      current_link: previous.current_link,
      wrapper_path: wrapperPath,
      target_install_path: target.install_path,
      descriptors: [descriptor],
      plan_daemons: [{
        daemon_id: descriptor.daemon_id,
        pid: descriptor.pid,
        runs_root: descriptor.runs_root,
        health_url: descriptor.health_url,
        restart_order: descriptor.restart_order,
        supervisor: descriptor.supervisor,
        build: descriptor.build,
        maintenance_mode: false,
      }],
      maintenance_before: [{ daemon_id: descriptor.daemon_id, enabled: false }],
      supervisor_readiness: {
        schema_version: "self-upgrade-supervisor-readiness/v1",
        status: "unchanged",
        target_git_head: targetHead,
        source: "live-supervisor",
        supervisor_kinds: [],
      },
    });

    const writeDescriptor = vi.fn(async () => "");
    const createSupervisorAdapter = vi.fn();
    const dryRunDeps = {
      homeDir: () => homeRoot,
      acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
      resolveCurrentHostAlias: async () => "blade",
      resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
      resolveRepo: async () => repoRoot,
      listDescriptors: async () => [descriptor],
      readDescriptor: async () => descriptor,
      writeDescriptor,
      createSupervisorAdapter,
      execGit: async (args: string[]) => {
        if (args[0] === "status") {
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: args[1] === "HEAD" ? `${previousHead}\n` : `${targetHead}\n`, stderr: "" };
      },
      createRunService: () => createRunServiceStub([]),
    };

    await expect(runSelfUpgrade({ host: "blade", dryRun: true }, dryRunDeps))
      .rejects.toThrow(new RegExp(`Interrupted self-upgrade cutover ${operationId} must be recovered`));
    // --force is not an override for a mutation the dry-run contract forbids.
    await expect(runSelfUpgrade({ host: "blade", dryRun: true, force: true }, dryRunDeps))
      .rejects.toThrow(/must be recovered before a new dry-run/);

    // Nothing was recovered: the journal survives and no descriptor was touched.
    await expect(access(path.join(journalRoot, `${operationId}.json`))).resolves.toBeUndefined();
    expect(writeDescriptor).not.toHaveBeenCalled();
    expect(createSupervisorAdapter).not.toHaveBeenCalled();
  });

  test("cutover journals reject traversal ids and filename identity drift", async () => {
    const journalRoot = path.join(homeRoot, ".calyx", "self-upgrade-cutovers");
    await expect(writeCutoverJournal(journalRoot, {
      operation_id: "../escape",
    } as SelfUpgradeCutoverJournal)).rejects.toThrow(/non-canonical operation id/);
    await mkdir(journalRoot, { recursive: true });
    await writeFile(
      path.join(journalRoot, "self-upgrade-wrong-name.json"),
      `${JSON.stringify({
        schema_version: "self-upgrade-cutover-journal/v1",
        operation_id: "self-upgrade-right-name",
        host: "blade",
      })}\n`,
      "utf8",
    );
    await expect(recoverInterruptedCutover({
      homeDir: homeRoot,
      host: "blade",
      authToken: "secret-token",
      createSupervisorAdapter: vi.fn(),
      inspectSupervisorEffectiveState: vi.fn(),
      reloadSupervisorDefinition: vi.fn(),
      createAdminClient: createAdminClientFactory(vi.fn()),
      sleep: async () => {},
      monotonicNowMs: () => 0,
      readDescriptor: vi.fn(),
      writeDescriptor: vi.fn(),
    })).rejects.toThrow(/Invalid authoritative self-upgrade cutover journal/);
  });

  test("writes staging overrides to pnpm-workspace.yaml for pnpm 10 installs", async () => {
    const gitHead = "d".repeat(40);
    const fakeRepo = path.join(root, "fake-staging-overrides-workspace");
    const fakeCore = path.join(fakeRepo, "packages", "core");
    const fakeCli = path.join(fakeRepo, "packages", "cli");
    const installsRoot = path.join(root, "staging-overrides-installs");
    await mkdir(fakeCore, { recursive: true });
    await mkdir(fakeCli, { recursive: true });
    await writeFile(path.join(fakeRepo, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "  packages/core: {}",
      "  packages/cli:",
      "    dependencies:",
      "      '@polli-labs/calyx-core':",
      "        specifier: workspace:*",
      "        version: link:../core",
      "",
      "snapshots: {}",
      "",
    ].join("\n"), "utf8");
    await writeFile(path.join(fakeCore, "package.json"), `${JSON.stringify({ name: "@polli-labs/calyx-core" }, null, 2)}\n`, "utf8");
    await writeFile(path.join(fakeCli, "package.json"), `${JSON.stringify({ name: "@polli-labs/calyx" }, null, 2)}\n`, "utf8");

    let installWasInspected = false;
    const runCommand = vi.fn(async (_command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> => {
      if (args.includes("pack")) {
        const packageName = args[args.indexOf("--filter") + 1]!;
        const packDestination = args[args.indexOf("--pack-destination") + 1]!;
        const tarballName = packageName.replace(/^@/, "").replace(/\//g, "-");
        await writeFile(path.join(packDestination, `${tarballName}-0.2.0.tgz`), "", "utf8");
        return { code: 0, stdout: "", stderr: "" };
      }

      if (args[0] === "install") {
        const packageJson = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as {
          pnpm?: unknown;
        };
        const workspaceConfig = YAML.parse(await readFile(path.join(cwd, "pnpm-workspace.yaml"), "utf8")) as {
          overrides?: Record<string, string>;
        };
        expect(packageJson.pnpm).toBeUndefined();
        expect(workspaceConfig.overrides?.["@polli-labs/calyx-core"]).toMatch(
          /^file:\.\/tarballs\/polli-labs-calyx-core-0\.2\.0\.tgz$/,
        );
        expect(workspaceConfig.overrides?.["@polli-labs/calyx"]).toMatch(
          /^file:\.\/tarballs\/polli-labs-calyx-0\.2\.0\.tgz$/,
        );
        installWasInspected = true;
        return {
          code: 42,
          stdout: "real stdout cause",
          stderr: "[WARN] deprecated config masked the failure\nERR_PNPM_REAL_CAUSE",
        };
      }

      return { code: 1, stdout: "", stderr: `unexpected command ${args.join(" ")}` };
    });

    await expect(prepareVersionedInstall({
      repoRoot: fakeRepo,
      gitHead,
      installsRoot,
      workspacePackages: [
        { name: "@polli-labs/calyx-core", relativePath: "packages/core" },
        { name: "@polli-labs/calyx", relativePath: "packages/cli" },
      ],
      runCommand,
    })).rejects.toThrow([
      "pnpm install failed for versioned install (exit 42).",
      "stdout:",
      "real stdout cause",
      "stderr:",
      "[WARN] deprecated config masked the failure",
      "ERR_PNPM_REAL_CAUSE",
    ].join("\n"));
    expect(installWasInspected).toBe(true);
  });

  test("uses the structured runner for versioned pack/install and retains only exit status", async () => {
    const gitHead = "e".repeat(40);
    const fakeRepo = path.join(root, "c1-structured-versioned-install");
    const fakeCore = path.join(fakeRepo, "packages", "core");
    const fakeCli = path.join(fakeRepo, "packages", "cli");
    const installsRoot = path.join(root, "c1-structured-versioned-installs");
    await mkdir(fakeCore, { recursive: true });
    await mkdir(fakeCli, { recursive: true });
    await writeFile(path.join(fakeRepo, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "  packages/core: {}",
      "  packages/cli: {}",
      "",
      "snapshots: {}",
      "",
    ].join("\n"), "utf8");
    await writeFile(path.join(fakeCore, "package.json"), `${JSON.stringify({ name: "@polli-labs/calyx-core" })}\n`, "utf8");
    await writeFile(path.join(fakeCli, "package.json"), `${JSON.stringify({ name: "@polli-labs/calyx" })}\n`, "utf8");
    const frozenEnv = Object.freeze({
      PATH: "/fixture/bin:/usr/bin:/bin",
      HOME: path.join(root, "c1-private-home"),
      XDG_CONFIG_HOME: path.join(root, "c1-private-config"),
      TMPDIR: path.join(root, "c1-private-tmp"),
    }) as NodeJS.ProcessEnv;
    const calls: Array<{ args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
    const runPackageManagerCommand = vi.fn(async (
      _command: "pnpm",
      args: readonly string[],
      cwd: string,
      env: NodeJS.ProcessEnv,
    ) => {
      calls.push({ args, cwd, env });
      if (args.includes("pack")) {
        const packageName = args[args.indexOf("--filter") + 1]!;
        const tarballsDirectory = args[args.indexOf("--pack-destination") + 1]!;
        const tarballName = packageName.replace(/^@/, "").replace(/\//g, "-");
        await writeFile(path.join(tarballsDirectory, `${tarballName}-0.2.0.tgz`), "", "utf8");
        return { code: 0 };
      }
      expect(args).toEqual(["install", "--prod", "--ignore-scripts", "--prefer-offline"]);
      return { code: 42 };
    });

    let thrown: Error | undefined;
    try {
      await prepareVersionedInstall({
        repoRoot: fakeRepo,
        gitHead,
        installsRoot,
        workspacePackages: [
          { name: "@polli-labs/calyx-core", relativePath: "packages/core" },
          { name: "@polli-labs/calyx", relativePath: "packages/cli" },
        ],
        env: frozenEnv,
        runPackageManagerCommand,
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toBe("pnpm install failed for versioned install (exit 42).");
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.env === frozenEnv)).toBe(true);
    expect(calls.filter((call) => call.args.includes("pack"))).toHaveLength(2);
    expect(calls.filter((call) => call.args.includes("pack"))).toEqual(expect.arrayContaining([
      expect.objectContaining({ args: expect.arrayContaining(["--ignore-scripts"]) }),
    ]));
    expect(calls.at(-1)?.cwd).toContain(".staging-");
  });

  test("dry-run returns a non-empty plan without mutating descriptors", async () => {
    const descriptor = makeDescriptor({ repoRoot, runsRoot });
    const descriptors = new Map([[descriptor.daemon_id, descriptor]]);
    const writeDescriptor = vi.fn(async (next: CalyxDaemonDescriptor) => {
      descriptors.set(next.daemon_id, next);
      return path.join(root, `${next.daemon_id}.json`);
    });

    const result = await runSelfUpgrade(
      {
        host: "blade",
        dryRun: true,
      },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [...descriptors.values()],
        readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
        writeDescriptor,
        execGit: async (args: string[]) => {
          if (args[0] === "status") {
            return { code: 0, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: args[1] === "HEAD" ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", stderr: "" };
        },
        createRunService: () => createRunServiceStub([]),
      },
    );

    expect(result.status).toBe("dry-run");
    expect(result.plan.daemons).toHaveLength(1);
    expect(result.plan.target_head).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(result.plan.warnings).toContain(
      "This dry-run is pinned to bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb. A later invocation replans the ref; pass --target-sha bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb to apply this exact assessment.",
    );
    expect(formatSelfUpgradePlan(result.plan)).toContain("run-serve");
    expect(writeDescriptor).not.toHaveBeenCalled();
    expect(descriptors.get("run-serve")?.maintenance_mode).toBe(false);
  });

  test("dry-run diagnoses an empty daemon registry when run-service health is reachable", async () => {
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0]) => new Response(JSON.stringify({
      schema_version: "calyx.admin-health/v1",
      protocol_epoch: 1,
      daemon_kind: "run-service",
      daemon_id: "run-serve",
      advertised_host: "blade",
      uptime_ms: 10,
      started_at: "2026-04-20T00:00:00.000Z",
      build: {
        git_head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        built_at: "2026-04-20T00:00:10.000Z",
        package_version: "0.2.0",
      },
      active_runs: 0,
      maintenance_mode: false,
      supports_features: [...EXPECTED_DAEMON_BASELINE_FEATURES],
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
      },
    }));

    const result = await runSelfUpgrade(
      {
        host: "blade",
        dryRun: true,
        authToken: "secret-token",
      },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => undefined,
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [],
        readDescriptor: async () => undefined,
        writeDescriptor: vi.fn(async () => ""),
        execGit: async (args: string[]) => {
          if (args[0] === "status") {
            return { code: 0, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: args[1] === "HEAD" ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", stderr: "" };
        },
        createRunService: () => createRunServiceStub([]),
        createAdminClient: createAdminClientFactory(fetchImpl),
      },
    );

    const plan = result.plan as typeof result.plan & {
      diagnostics?: Array<{
        kind: string;
        severity: string;
        daemon_id?: string;
        active_runs?: number;
        actions: string[];
      }>;
    };
    expect(result.status).toBe("dry-run");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://127.0.0.1:8740/v1/admin/health");
    expect(plan.daemons).toEqual([]);
    expect(plan.diagnostics).toEqual([
      expect.objectContaining({
        kind: "daemon_out_of_registration",
        severity: "blocking",
        daemon_id: "run-serve",
        active_runs: 0,
        actions: expect.arrayContaining([
          expect.stringContaining("systemctl --user status calyx-run-serve.service"),
          expect.stringContaining("systemctl --user restart calyx-run-serve.service"),
        ]),
      }),
    ]);
    expect(plan.blockers.join("\n")).toContain("run-service daemon responded on /v1/admin/health");
  });

  test("rejects a dirty tree without force", async () => {
    const descriptor = makeDescriptor({ repoRoot, runsRoot });

    await expect(
      runSelfUpgrade(
        {
          host: "blade",
          authToken: "secret-token",
        },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [descriptor],
          readDescriptor: async () => descriptor,
          writeDescriptor: vi.fn(async () => ""),
          execGit: async (args: string[]) => {
            if (args[0] === "status") {
              return { code: 0, stdout: " M packages/cli/src/run-cli.ts\n", stderr: "" };
            }
            return { code: 0, stdout: args[1] === "HEAD" ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", stderr: "" };
          },
          createRunService: () => createRunServiceStub([]),
        },
      ),
    ).rejects.toThrow("dirty");
  });

  test("treats partial runs as terminal during self-upgrade planning", async () => {
    const descriptor = makeDescriptor({ repoRoot, runsRoot });
    const partialRuns: StubActiveRun[] = [{
      run_id: "old-partial",
      state: "partial",
      resumable: false,
      summary: "Run old-partial partial; recovery=orchestrator_crash.",
    }];

    const result = await runSelfUpgrade(
      {
        host: "blade",
        dryRun: true,
      },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [descriptor],
        readDescriptor: async () => descriptor,
        writeDescriptor: vi.fn(async () => ""),
        execGit: async (args: string[]) => {
          if (args[0] === "status") {
            return { code: 0, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: args[1] === "HEAD" ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", stderr: "" };
        },
        createRunService: () => createRunServiceStub(partialRuns),
      },
    );

    expect(result.status).toBe("dry-run");
    expect(result.plan.active_runs_post_reconcile).toEqual([]);
    expect(result.plan.blockers).toEqual([]);
  });

  test("bounds a never-settling lock release without suppressing the terminal result", async () => {
    const descriptor = makeDescriptor({ repoRoot, runsRoot });
    const result = await runSelfUpgrade(
      {
        host: "blade",
        dryRun: true,
      },
      {
        homeDir: () => homeRoot,
        eventProjectionSettleTimeoutMs: 10_000,
        lockReleaseSettleTimeoutMs: 0,
        acquireLock: vi.fn(async () => ({
          lockPath: path.join(homeRoot, "lock"),
          release: async () => new Promise<never>(() => undefined),
        })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [descriptor],
        readDescriptor: async () => descriptor,
        writeDescriptor: vi.fn(async () => ""),
        execGit: async (args: string[]) => {
          if (args[0] === "status") {
            return { code: 0, stdout: "", stderr: "" };
          }
          return {
            code: 0,
            stdout: args[1] === "HEAD"
              ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
              : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
            stderr: "",
          };
        },
        createRunService: () => createRunServiceStub([]),
      },
    );

    expect(result.status).toBe("dry-run");
    expect(result.projection_issues).toContainEqual(expect.objectContaining({
      scope: "lock_cleanup",
      code: "cleanup_unavailable",
      message: expect.stringContaining("did not settle within 0ms"),
    }));
    expect(result.projection_issues?.find((issue) => issue.scope === "lock_cleanup")?.message)
      .toContain("release may still complete; stale-lock recovery remains available");
  });

  test("retains a mid-plan stderr projection failure on the terminal result", async () => {
    const descriptor = makeDescriptor({ repoRoot, runsRoot });
    const statusProjectionStream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    let projectionFailed = false;
    const result = await runSelfUpgrade(
      { host: "blade", dryRun: true },
      {
        homeDir: () => homeRoot,
        statusProjectionStream,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => {
          if (!projectionFailed) {
            projectionFailed = true;
            statusProjectionStream.emit("error", new Error("injected mid-plan stderr loss"));
          }
          return repoRoot;
        },
        listDescriptors: async () => [descriptor],
        readDescriptor: async () => descriptor,
        writeDescriptor: vi.fn(async () => ""),
        execGit: async (args: string[]) => ({
          code: 0,
          stdout: args[0] === "status"
            ? ""
            : args[1] === "HEAD"
              ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
              : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
          stderr: "",
        }),
        createRunService: () => createRunServiceStub([]),
      },
    );

    expect(result.status).toBe("dry-run");
    expect(result.projection_issues).toContainEqual(expect.objectContaining({
      scope: "status_stderr",
      code: "projection_unavailable",
      message: expect.stringContaining("injected mid-plan stderr loss"),
    }));
  });

  test("prepared target custody excludes provider, foreign-host, and shell secrets", async () => {
    const daemonToken = "CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN";
    const daemonVerifier = "CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256";
    const operatorToken = "CALYX_CONSUMER_API_BLADE_OPERATOR_TOKEN";
    const operatorVerifier = "CALYX_CONSUMER_API_BLADE_OPERATOR_VERIFIER_SHA256";
    const handoff = {
      operation_id: "self-upgrade-env-custody",
      request: { host: "blade" },
    } as SelfUpgradeTargetHandoff;
    const sourceEnv: NodeJS.ProcessEnv = {
      HOME: homeRoot,
      PATH: "/usr/bin:/bin",
      CALYX_STATE_HOME: path.join(homeRoot, "state"),
      [daemonToken]: "daemon-token",
      [daemonVerifier]: `sha256:${"a".repeat(64)}`,
      [operatorToken]: "operator-token",
      [operatorVerifier]: `sha256:${"b".repeat(64)}`,
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      ANTHROPIC_API_KEY: "must-not-cross",
      OPENAI_API_KEY: "must-not-cross",
      CALYX_CONSUMER_API_DAEMON_CARBON_TOKEN: "foreign-must-not-cross",
      NODE_OPTIONS: "--require=/tmp/inject-secrets.cjs",
    };
    const credentialTruth = {
      hosts: {
        blade: {
          consumer_api_credentials: [
            {
              client_id: "daemon:blade",
              credential_tier: "internal_runtime" as const,
              verifier_env: daemonVerifier,
              token_env: daemonToken,
              outbound: true,
              address_grants: { send_as: ["host:blade"], read: ["host:blade"] },
            },
            {
              client_id: "operator_cli",
              credential_tier: "control_plane" as const,
              verifier_env: operatorVerifier,
              token_env: operatorToken,
              outbound: true,
              address_grants: {
                send_as: ["client:operator_cli@blade"],
                read: ["host:*"],
              },
            },
          ],
        },
      },
    };

    const childEnv = await buildSelfUpgradeTargetEnvironment(handoff, {
      env: sourceEnv,
    });

    expect(childEnv).toEqual({
      HOME: homeRoot,
      PATH: "/usr/bin:/bin",
      CALYX_STATE_HOME: path.join(homeRoot, "state"),
      // The target owns the supervisor cutover, so `systemctl --user` must be
      // reachable from the child; without these the systemd adapter reports
      // every managed daemon as not running and the cutover gate refuses.
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      CALYX_SELF_UPGRADE_TARGET_OPERATION_ID: handoff.operation_id,
    });
    expect(Object.keys(childEnv).some((name) =>
      name.startsWith("CALYX_CONSUMER_API_")
    )).toBe(false);
    expect(JSON.stringify(childEnv)).not.toContain("daemon-token");
    expect(JSON.stringify(childEnv)).not.toContain("operator-token");
    expect(JSON.stringify(handoff)).not.toContain("operator-token");

    const polliRoot = path.join(homeRoot, ".config", "polli");
    await mkdir(path.join(polliRoot, "secrets.d"), { recursive: true });
    await writeFile(
      path.join(polliRoot, "secrets.env"),
      [
        `${daemonToken}=daemon-token`,
        `${daemonVerifier}=sha256:${"a".repeat(64)}`,
        "ANTHROPIC_API_KEY=canonical-but-excluded",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(polliRoot, "secrets.d", "blade.env"),
      [
        `${operatorToken}='operator-token'`,
        `${operatorVerifier}=sha256:${"b".repeat(64)}`,
        "CALYX_CONSUMER_API_DAEMON_CARBON_TOKEN=foreign-canonical-but-excluded",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const targetOwnedCredentials = await resolveAcceptedTargetCredentialEnvironment(
      handoff,
      {
        homeDir: () => homeRoot,
        env: { HOME: homeRoot },
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        readHostsTruth: async () => credentialTruth,
      },
    );
    expect(targetOwnedCredentials).toEqual({
      [daemonToken]: "daemon-token",
      [daemonVerifier]: `sha256:${"a".repeat(64)}`,
      [operatorToken]: "operator-token",
      [operatorVerifier]: `sha256:${"b".repeat(64)}`,
    });
    expect(targetOwnedCredentials).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(targetOwnedCredentials).not.toHaveProperty(
      "CALYX_CONSUMER_API_DAEMON_CARBON_TOKEN",
    );
  });

  test("the installed planner stops at a durable target handoff and cannot execute cutover", async () => {
    const previousHead = "a".repeat(40);
    const targetHead = "c".repeat(40);
    const previousInstall = await materializeInstallFixture(homeRoot, previousHead);
    const descriptor = makeDescriptor({
      repoRoot,
      runsRoot,
      gitHead: previousHead,
      argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
    });
    const writeDescriptor = vi.fn();
    const runTargetStatePlan = vi.fn();
    const prepareSupervisorCutover = vi.fn();
    const promoteInstall = vi.fn();
    const release = vi.fn(async () => {});
    let currentHead = previousHead;
    const operatorTokenEnv = "CALYX_CONSUMER_API_TEST_BLADE_OPERATOR_TOKEN";
    const previousOperatorToken = process.env[operatorTokenEnv];
    process.env[operatorTokenEnv] = "target-handoff-test-token";
    let orphanedOperationId: string | undefined;

    try {
      await expect(runSelfUpgradeImpl(
        {
          host: "blade",
          targetSha: targetHead,
          authToken: "planner-only-legacy-token",
        },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({
            lockPath: path.join(homeRoot, "lock"),
            release,
          })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          readHostsTruth: async () => ({
            hosts: {
              blade: {
                consumer_api_credentials: [
                  ...testCredentials("blade"),
                  {
                    client_id: "operator_cli",
                    credential_tier: "control_plane" as const,
                    verifier_env: "CALYX_CONSUMER_API_TEST_BLADE_OPERATOR_VERIFIER",
                    token_env: operatorTokenEnv,
                    outbound: true,
                    address_grants: {
                      send_as: ["client:operator_cli@blade"],
                      read: ["host:*"],
                    },
                  },
                ],
              },
            },
          }),
          listDescriptors: async () => [descriptor],
          readDescriptor: async () => descriptor,
          writeDescriptor,
          resolveSupervisorEnvNames: async () => compatibleStartupInspection("blade"),
          createRunService: () => createRunServiceStub([]),
          execGit: async (args) => {
            if (args[0] === "status") {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "show") {
              return { code: 0, stdout: STARTUP_CONTRACT_JSON, stderr: "" };
            }
            if (args[0] === "fetch") {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "rev-parse") {
              return {
                code: 0,
                stdout: `${args[1] === "FETCH_HEAD" ? targetHead : currentHead}\n`,
                stderr: "",
              };
            }
            if (args[0] === "for-each-ref") {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "merge" && args[1] === "--ff-only") {
              currentHead = targetHead;
              return { code: 0, stdout: "updated\n", stderr: "" };
            }
            if (args[0] === "log") {
              return { code: 0, stdout: "abc123 POL-2072 target-owned cutover\n", stderr: "" };
            }
            return { code: 0, stdout: "", stderr: "" };
          },
          runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
          attestToolchain: async ({ host, targetSha }) => passingToolchainCheck(host, targetSha),
          prepareInstall: async ({ gitHead }) => ({
            ...await prepareInstallFixture(homeRoot, gitHead),
            artifact_manifest_sha256: "e".repeat(64),
            artifact_manifest_packages: ["@polli-labs/calyx"],
          }),
          runTargetStatePlan,
          prepareSupervisorCutover,
          promoteInstall,
          runTargetOwnedUpgrade: async (handoff) => {
            expect(release).toHaveBeenCalledTimes(1);
            expect(await realpath(previousInstall.current_link)).toBe(
              await realpath(previousInstall.install_path),
            );
            expect(handoff).not.toHaveProperty("plan");
            expect(handoff.request).not.toHaveProperty("auth_token");
            expect(JSON.stringify(handoff)).not.toContain("planner-only-legacy-token");
            const durableHandoff = JSON.parse(await readFile(
              path.join(
                homeRoot,
                ".calyx",
                "self-upgrade-handoffs",
                `${handoff.operation_id}.json`,
              ),
              "utf8",
            )) as Record<string, unknown>;
            expect(durableHandoff).toEqual(handoff);
            expect(JSON.stringify(durableHandoff)).not.toContain(
              "planner-only-legacy-token",
            );
            orphanedOperationId = handoff.operation_id;
            throw new Error("injected parent crash before target spawn");
          },
        },
      )).rejects.toThrow("injected parent crash before target spawn");

      expect(runTargetStatePlan).not.toHaveBeenCalled();
      expect(prepareSupervisorCutover).not.toHaveBeenCalled();
      expect(writeDescriptor).not.toHaveBeenCalled();
      expect(promoteInstall).not.toHaveBeenCalled();
      expect(await realpath(previousInstall.current_link)).toBe(
        await realpath(previousInstall.install_path),
      );

      const resumedRelease = vi.fn(async () => {});
      const resumedAcquireLock = vi.fn(async () => ({
        lockPath: path.join(homeRoot, ".calyx", "self-upgrade.lock"),
        release: resumedRelease,
      }));
      const resumed = await runSelfUpgradeImpl(
        { host: "blade" },
        {
          homeDir: () => homeRoot,
          acquireLock: resumedAcquireLock,
          runTargetOwnedUpgrade: async (handoff) => {
            expect(handoff.operation_id).toBe(orphanedOperationId);
            return {
              status: "succeeded",
              operation_id: handoff.operation_id,
              plan: {
                host: "blade",
                repo_root: repoRoot,
                current_head: targetHead,
                target_ref: "origin/main",
                target_head: targetHead,
                target_evidence: handoff.request.target_evidence,
                dirty: false,
                dirty_paths: [],
                missing_build_artifacts: [],
                daemons: [],
                active_runs_post_reconcile: [],
                preservation: {
                  policy: "automatic",
                  status: "not_applicable",
                  required_features: [],
                  unavailable_reasons: [],
                },
                blockers: [],
                warnings: [],
                diagnostics: [],
              },
              receipt: {
                target_acceptance: {
                  schema_version: "self-upgrade-target-acceptance/v1",
                  status: "accepted",
                  operation_id: handoff.operation_id,
                },
              },
            } as never;
          },
        },
      );
      expect(resumed.operation_id).toBe(orphanedOperationId);
      expect(resumed.receipt?.target_acceptance?.operation_id).toBe(orphanedOperationId);
      expect(resumedAcquireLock).toHaveBeenCalledTimes(1);
      expect(resumedRelease).toHaveBeenCalledTimes(1);
    } finally {
      if (previousOperatorToken === undefined) {
        delete process.env[operatorTokenEnv];
      } else {
        process.env[operatorTokenEnv] = previousOperatorToken;
      }
    }
  });

  test("source planner composes its local cleanup warning with the prepared target result", async () => {
    const previousHead = "a".repeat(40);
    const targetHead = "c".repeat(40);
    await materializeInstallFixture(homeRoot, previousHead);
    const descriptor = makeDescriptor({
      repoRoot,
      runsRoot,
      gitHead: previousHead,
      argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
    });
    const release = vi.fn(async () => {});
    const cleanupBootstrapSandbox = vi.fn(async () => ({ status: "residue" as const }));
    let currentHead = previousHead;
    const operatorTokenEnv = "CALYX_CONSUMER_API_TEST_BLADE_OPERATOR_TOKEN";
    const previousOperatorToken = process.env[operatorTokenEnv];
    process.env[operatorTokenEnv] = "target-handoff-composition-test-token";
    const targetCleanupIssue = {
      scope: "operation_cleanup" as const,
      code: "best_effort_cleanup" as const,
      detail: "residue" as const,
      observed_at: "2026-08-04T00:00:00.000Z",
      message: "prepared target retained its own local cleanup residue",
    };

    try {
      const result = await runSelfUpgradeImpl(
        {
          host: "blade",
          targetSha: targetHead,
          authToken: "planner-only-legacy-token",
        },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({
            lockPath: path.join(homeRoot, "lock"),
            release,
          })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          readHostsTruth: async () => ({
            hosts: {
              blade: {
                consumer_api_credentials: [
                  ...testCredentials("blade"),
                  {
                    client_id: "operator_cli",
                    credential_tier: "control_plane" as const,
                    verifier_env: "CALYX_CONSUMER_API_TEST_BLADE_OPERATOR_VERIFIER",
                    token_env: operatorTokenEnv,
                    outbound: true,
                    address_grants: {
                      send_as: ["client:operator_cli@blade"],
                      read: ["host:*"],
                    },
                  },
                ],
              },
            },
          }),
          listDescriptors: async () => [descriptor],
          readDescriptor: async () => descriptor,
          writeDescriptor: vi.fn(),
          resolveSupervisorEnvNames: async () => compatibleStartupInspection("blade"),
          createRunService: () => createRunServiceStub([]),
          execGit: async (args) => {
            if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
            if (args[0] === "show") return { code: 0, stdout: STARTUP_CONTRACT_JSON, stderr: "" };
            if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
            if (args[0] === "rev-parse") {
              return {
                code: 0,
                stdout: `${args[1] === "FETCH_HEAD" ? targetHead : currentHead}\n`,
                stderr: "",
              };
            }
            if (args[0] === "for-each-ref") return { code: 0, stdout: "", stderr: "" };
            if (args[0] === "merge" && args[1] === "--ff-only") {
              currentHead = targetHead;
              return { code: 0, stdout: "updated\n", stderr: "" };
            }
            if (args[0] === "log") {
              return { code: 0, stdout: "abc123 POL-2072 target-owned cutover\n", stderr: "" };
            }
            return { code: 0, stdout: "", stderr: "" };
          },
          runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
          attestToolchain: async ({ host, targetSha }) => passingToolchainCheck(host, targetSha),
          prepareInstall: async ({ gitHead }) => ({
            ...await prepareInstallFixture(homeRoot, gitHead),
            artifact_manifest_sha256: "e".repeat(64),
            artifact_manifest_packages: ["@polli-labs/calyx"],
          }),
          // The source planner delegates before this can run, but its
          // availability makes this otherwise repairable supervisor mismatch
          // non-blocking during source-side planning.
          prepareSupervisorCutover: vi.fn(),
          cleanupBootstrapSandbox,
          runTargetOwnedUpgrade: async (handoff) => ({
            status: "succeeded",
            operation_id: handoff.operation_id,
            plan: {} as SelfUpgradePlan,
            receipt: {
              target_acceptance: {
                schema_version: "self-upgrade-target-acceptance/v1",
                status: "accepted",
                operation_id: handoff.operation_id,
              },
            },
            projection_issues: [targetCleanupIssue],
          }) as never,
        },
      );

      const cleanupIssues = result.projection_issues?.filter(
        (issue) => issue.scope === "operation_cleanup",
      );
      expect(cleanupBootstrapSandbox).toHaveBeenCalledTimes(1);
      expect(cleanupIssues).toEqual([
        targetCleanupIssue,
        expect.objectContaining({
          scope: "operation_cleanup",
          code: "best_effort_cleanup",
          detail: "residue",
          message: expect.stringContaining("left residue"),
        }),
      ]);
      expect(result.projection_issues).toHaveLength(2);
    } finally {
      if (previousOperatorToken === undefined) {
        delete process.env[operatorTokenEnv];
      } else {
        process.env[operatorTokenEnv] = previousOperatorToken;
      }
    }
  });

  test("POL-2095: invocation recovery preempts an orphaned target handoff for the same cutover", async () => {
    const operationId = "self-upgrade-pending-handoff-cutover";
    const previousHead = "a".repeat(40);
    const targetHead = "c".repeat(40);
    const previous = await materializeInstallFixture(homeRoot, previousHead);
    const target = await prepareInstallFixture(homeRoot, targetHead);
    const physicalTargetBin = path.join(
      target.install_path,
      "node_modules",
      ".pnpm",
      "@polli-labs+calyx@file+fixture",
      "node_modules",
      "@polli-labs",
      "calyx",
      "dist",
      "bin.js",
    );
    await mkdir(path.dirname(physicalTargetBin), { recursive: true });
    await rename(target.bin_path, physicalTargetBin);
    await symlink(
      path.relative(path.dirname(target.bin_path), physicalTargetBin),
      target.bin_path,
    );
    const descriptor = makeDescriptor({
      repoRoot,
      runsRoot,
      gitHead: previousHead,
      argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
    });
    const handoff: SelfUpgradeTargetHandoff = {
      schema_version: "self-upgrade-target-handoff/v1",
      operation_id: operationId,
      created_at: "2026-07-28T07:30:16.000Z",
      planner: {
        entry_realpath: process.execPath,
        node_realpath: process.execPath,
        node_version: process.version,
        handoff_interface: "self-upgrade-target-handoff/v1",
        operation_schema: "self-upgrade-operation/v1",
      },
      target: {
        git_head: targetHead,
        install_path: target.install_path,
        bin_path: await realpath(target.bin_path),
        build_info_path: target.build_info_path,
        build_info_sha256: "d".repeat(64),
        artifact_manifest_sha256: "e".repeat(64),
        artifact_manifest_packages: ["@polli-labs/calyx"],
        verified_version: target.verified_version,
        planning_interface: "self-upgrade-target-planning/v1",
        startup_contract_interface: "calyx-startup-contract/v1",
      },
      previous_current: {
        install_path: previous.install_path,
        git_head: previousHead,
        current_link: previous.current_link,
      },
      request: {
        host: "blade",
        target_ref: "origin/main",
        target_evidence: {
          original_ref: "origin/main",
          target_sha: targetHead,
          fetch_remote: "origin",
          fetch_ref: "main",
        },
        force: false,
        abort_runs: false,
        continuous: false,
        drain_deadline_ms: 600_000,
      },
    };
    const handoffRoot = path.join(homeRoot, ".calyx", "self-upgrade-handoffs");
    const handoffPath = path.join(handoffRoot, `${operationId}.json`);
    await mkdir(handoffRoot, { recursive: true });
    await writeFile(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(handoffPath, 0o600);
    const stateCutover = await prepareStateCutoverSnapshot({
      operationId,
      homeDir: homeRoot,
    });
    await expect(stateCutover.restore()).resolves.toMatchObject({
      status: "succeeded",
    });

    const journal: SelfUpgradeCutoverJournal = {
      schema_version: "self-upgrade-cutover-journal/v1",
      operation_id: operationId,
      host: "blade",
      phase: "target_started",
      updated_at: "2026-07-28T07:54:14.000Z",
      previous_install_path: previous.install_path,
      previous_git_head: previousHead,
      current_link: previous.current_link,
      wrapper_path: path.join(homeRoot, ".agents", "run", "calyx"),
      target_install_path: target.install_path,
      descriptors: [descriptor],
      plan_daemons: [{
        daemon_id: descriptor.daemon_id,
        pid: descriptor.pid,
        runs_root: descriptor.runs_root,
        health_url: descriptor.health_url,
        restart_order: descriptor.restart_order,
        supervisor: descriptor.supervisor,
        build: descriptor.build,
        maintenance_mode: false,
      }],
      target_acceptance: {
        schema_version: "self-upgrade-target-acceptance/v1",
        status: "accepted",
        operation_id: operationId,
        executor_realpath: await realpath(target.bin_path),
        node_realpath: await realpath(process.execPath),
        node_version: process.version,
        target_git_head: targetHead,
        target_build_info_sha256: handoff.target.build_info_sha256,
        target_artifact_manifest_sha256: handoff.target.artifact_manifest_sha256,
        target_artifact_manifest_packages: handoff.target.artifact_manifest_packages,
        handoff_interface: "self-upgrade-target-handoff/v1",
        planning_interface: "self-upgrade-target-planning/v1",
        startup_contract_interface: "calyx-startup-contract/v1",
        accepted_at: "2026-07-28T07:54:14.000Z",
      },
      supervisor_readiness: {
        schema_version: "self-upgrade-supervisor-readiness/v1",
        status: "unchanged",
        target_git_head: targetHead,
        source: "live-supervisor",
        supervisor_kinds: [],
      },
      state_snapshot: stateCutover.snapshot,
    };
    await writeCutoverJournal(
      path.join(homeRoot, ".calyx", "self-upgrade-cutovers"),
      journal,
    );

    const authFailureRelease = vi.fn(async () => {});
    const authFailureRecovery = vi.fn();
    const authFailureRetirement = vi.fn();
    await expect(runSelfUpgradeImpl(
      { host: "blade", targetSha: "f".repeat(40) },
      {
        homeDir: () => homeRoot,
        acquireLock: async () => ({
          lockPath: path.join(homeRoot, ".calyx", "self-upgrade.lock"),
          release: authFailureRelease,
        }),
        resolveAgentsInfraRoot: async () => {
          throw new Error("injected operator credential resolution failure");
        },
        recoverInterruptedCutover: authFailureRecovery,
        removeTargetHandoff: authFailureRetirement,
      },
    )).rejects.toThrow("injected operator credential resolution failure");
    expect(authFailureRelease).toHaveBeenCalledTimes(1);
    expect(authFailureRecovery).not.toHaveBeenCalled();
    expect(authFailureRetirement).not.toHaveBeenCalled();
    await expect(access(handoffPath)).resolves.toBeUndefined();

    const mismatchHead = "b".repeat(40);
    await writeCutoverJournal(
      path.join(homeRoot, ".calyx", "self-upgrade-cutovers"),
      {
        ...journal,
        target_acceptance: {
          ...journal.target_acceptance!,
          target_git_head: mismatchHead,
        },
        supervisor_readiness: {
          ...journal.supervisor_readiness,
          target_git_head: mismatchHead,
        },
      },
    );
    const mismatchRelease = vi.fn(async () => {});
    const mismatchRecovery = vi.fn();
    const mismatchRetirement = vi.fn();
    await expect(runSelfUpgradeImpl(
      {
        host: "blade",
        targetSha: "f".repeat(40),
        authToken: "operator-token",
      },
      {
        homeDir: () => homeRoot,
        acquireLock: async () => ({
          lockPath: path.join(homeRoot, ".calyx", "self-upgrade.lock"),
          release: mismatchRelease,
        }),
        recoverInterruptedCutover: mismatchRecovery,
        removeTargetHandoff: mismatchRetirement,
      },
    )).rejects.toThrow(/handoff and exhausted cutover authority disagree/);
    expect(mismatchRelease).toHaveBeenCalledTimes(1);
    expect(mismatchRecovery).not.toHaveBeenCalled();
    expect(mismatchRetirement).not.toHaveBeenCalled();
    await expect(access(handoffPath)).resolves.toBeUndefined();
    await writeCutoverJournal(
      path.join(homeRoot, ".calyx", "self-upgrade-cutovers"),
      journal,
    );

    const replacementTokenEnv = "CALYX_CONSUMER_API_TEST_HANDOFF_REPLACEMENT_TOKEN";
    process.env[replacementTokenEnv] = "operator-token";
    const replacementRelease = vi.fn(async () => {});
    const replacementRecovery = vi.fn();
    try {
      await expect(runSelfUpgradeImpl(
        { host: "blade", targetSha: "f".repeat(40) },
        {
          homeDir: () => homeRoot,
          acquireLock: async () => ({
            lockPath: path.join(homeRoot, ".calyx", "self-upgrade.lock"),
            release: replacementRelease,
          }),
          resolveAgentsInfraRoot: async () => {
            await writeFile(
              handoffPath,
              `${JSON.stringify({
                ...handoff,
                created_at: "2026-07-28T07:30:17.000Z",
              }, null, 2)}\n`,
              { encoding: "utf8", mode: 0o600 },
            );
            return path.join(root, "agents-infra");
          },
          readHostsTruth: async () => ({
            hosts: {
              blade: {
                consumer_api_credentials: [{
                  client_id: "operator_cli",
                  credential_tier: "control_plane" as const,
                  verifier_env: "CALYX_CONSUMER_API_TEST_HANDOFF_REPLACEMENT_VERIFIER",
                  token_env: replacementTokenEnv,
                  outbound: true,
                  address_grants: {
                    send_as: ["client:operator_cli@blade"],
                    read: ["host:*"],
                  },
                }],
              },
            },
          }),
          recoverInterruptedCutover: replacementRecovery,
        },
      )).rejects.toThrow(/changed after recovery authority was accepted/);
    } finally {
      delete process.env[replacementTokenEnv];
    }
    expect(replacementRelease).toHaveBeenCalledTimes(1);
    expect(replacementRecovery).not.toHaveBeenCalled();
    await writeFile(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(handoffPath, 0o600);

    const retirementFailureRelease = vi.fn(async () => {});
    const retirementFailureRecovery = vi.fn();
    await expect(runSelfUpgradeImpl(
      {
        host: "blade",
        targetSha: "f".repeat(40),
        authToken: "operator-token",
      },
      {
        homeDir: () => homeRoot,
        acquireLock: async () => ({
          lockPath: path.join(homeRoot, ".calyx", "self-upgrade.lock"),
          release: retirementFailureRelease,
        }),
        removeTargetHandoff: async () => {
          throw new Error("injected handoff retirement failure");
        },
        recoverInterruptedCutover: retirementFailureRecovery,
      },
    )).rejects.toThrow("injected handoff retirement failure");
    expect(retirementFailureRelease).toHaveBeenCalledTimes(1);
    expect(retirementFailureRecovery).not.toHaveBeenCalled();
    await expect(access(handoffPath)).resolves.toBeUndefined();

    const committedCrashRelease = vi.fn(async () => {});
    await expect(runSelfUpgradeImpl(
      {
        host: "blade",
        targetSha: "f".repeat(40),
        authToken: "operator-token",
      },
      {
        homeDir: () => homeRoot,
        acquireLock: async () => ({
          lockPath: path.join(homeRoot, ".calyx", "self-upgrade.lock"),
          release: committedCrashRelease,
        }),
        recoverInterruptedCutover: async () => {
          await expect(access(handoffPath)).rejects.toMatchObject({ code: "ENOENT" });
          await writeCutoverJournal(
            path.join(homeRoot, ".calyx", "self-upgrade-cutovers"),
            {
              ...journal,
              phase: "committed",
            },
          );
          throw new Error("injected crash after committed recovery authority");
        },
      },
    )).rejects.toThrow("injected crash after committed recovery authority");
    expect(committedCrashRelease).toHaveBeenCalledTimes(1);
    await expect(access(handoffPath)).rejects.toMatchObject({ code: "ENOENT" });

    const resumedCurrentPlanner = vi.fn(async () => {
      throw new Error("current planner resumed committed recovery");
    });
    const oldTargetAfterCrash = vi.fn();
    await expect(runSelfUpgradeImpl(
      {
        host: "blade",
        targetSha: "f".repeat(40),
        authToken: "operator-token",
      },
      {
        homeDir: () => homeRoot,
        acquireLock: async () => ({
          lockPath: path.join(homeRoot, ".calyx", "self-upgrade.lock"),
          release: async () => {},
        }),
        prepareSupervisorCutover: async () => {
          throw new Error("unreachable supervisor preparation");
        },
        recoverInterruptedCutover: resumedCurrentPlanner,
        runTargetOwnedUpgrade: oldTargetAfterCrash,
      },
    )).rejects.toThrow("current planner resumed committed recovery");
    expect(resumedCurrentPlanner).toHaveBeenCalledTimes(1);
    expect(oldTargetAfterCrash).not.toHaveBeenCalled();

    await writeCutoverJournal(
      path.join(homeRoot, ".calyx", "self-upgrade-cutovers"),
      journal,
    );
    await writeFile(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(handoffPath, 0o600);

    const runTargetOwnedUpgrade = vi.fn();
    const recoverCutover = vi.fn(async () => {
      await expect(access(handoffPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(path.join(
        homeRoot,
        ".calyx",
        "self-upgrade-cutovers",
        `${operationId}.json`,
      ))).resolves.toBeUndefined();
    });
    const releaseRecoveryLock = vi.fn(async () => {});
    const acquireLock = vi.fn(async () => {
      if (acquireLock.mock.calls.length === 1) {
        return {
          lockPath: path.join(homeRoot, ".calyx", "self-upgrade.lock"),
          release: releaseRecoveryLock,
        };
      }
      throw new Error("new planner pipeline reached");
    });
    await expect(runSelfUpgradeImpl(
      {
        host: "blade",
        targetSha: "f".repeat(40),
        authToken: "operator-token",
      },
      {
        homeDir: () => homeRoot,
        recoverInterruptedCutover: recoverCutover,
        runTargetOwnedUpgrade,
        prepareSupervisorCutover: async () => {
          throw new Error("unreachable supervisor preparation");
        },
        acquireLock,
      },
    )).rejects.toThrow("new planner pipeline reached");

    expect(recoverCutover).toHaveBeenCalledTimes(1);
    expect(runTargetOwnedUpgrade).not.toHaveBeenCalled();
    expect(acquireLock).toHaveBeenCalledTimes(2);
    expect(releaseRecoveryLock).toHaveBeenCalledTimes(1);
    await expect(access(handoffPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("happy path writes a receipt and upgrade control events", async () => {
    let currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({ repoRoot, runsRoot, gitHead: currentHead })],
    ]);
    const writeDescriptor = vi.fn(async (next: CalyxDaemonDescriptor) => {
      descriptors.set(next.daemon_id, next);
      return path.join(root, `${next.daemon_id}.json`);
    });

    // Strictly-increasing ISO clock so the event_log `ORDER BY occurred_at`
    // assertion below is deterministic across the rapid-fire progress events.
    let nowTick = 0;
    const now = (): string => new Date(Date.UTC(2026, 3, 20, 0, 0, 0, 0) + (nowTick++)).toISOString();
    let monotonicMs = 100;
    const advanceMonotonicBy = (deltaMs: number): void => {
      monotonicMs += deltaMs;
    };
    let currentPhase: SelfUpgradePhaseEvent["control"]["phase"] | undefined;
    let drainClassificationObserved = false;
    const observedPhases: SelfUpgradePhaseEvent[] = [];
    const runService = createRunServiceStub([]);
    const listRuns = runService.listRuns;
    runService.listRuns = vi.fn(async () => {
      const runs = await listRuns();
      if (currentPhase === "drain" && !drainClassificationObserved) {
        advanceMonotonicBy(2);
        drainClassificationObserved = true;
      }
      return runs;
    });

    const result = await runSelfUpgrade(
      {
        host: "blade",
        fleetOperationId: "fleet-current-test",
        authToken: "secret-token",
      },
      {
        now,
        monotonicNowMs: () => monotonicMs,
        onPhase: (event) => {
          observedPhases.push(event);
          currentPhase = event.control.phase;
        },
        appendEventProjection: async (roots, event) => {
          // Model a completed-event sink that wrote its projection but never
          // settles. The host receipt is already authoritative here, so the
          // mutation and sole final result must still complete.
          await appendControlEvent(roots, event);
          if (event.event_type === "daemon.upgrade.completed") {
            await new Promise<never>(() => undefined);
          }
        },
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => {
          advanceMonotonicBy(10);
          return { lockPath: path.join(homeRoot, "lock"), release: async () => {} };
        }),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [...descriptors.values()],
        readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
        writeDescriptor,
        execGit: async (args: string[]) => {
          if (args[0] === "status") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "pull") {
            currentHead = "cccccccccccccccccccccccccccccccccccccccc";
            return { code: 0, stdout: "updated\n", stderr: "" };
          }
          if (args[0] === "log") {
            return { code: 0, stdout: "abc123 POL-1122 test commit\n", stderr: "" };
          }
          return { code: 0, stdout: args[1] === "HEAD" ? `${currentHead}\n` : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
        },
        runBuild: async () => {
          advanceMonotonicBy(10);
          return { code: 0, stdout: "build ok\n", stderr: "" };
        },
        prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
        createRunService: () => runService,
        createSupervisorAdapter: () => ({
          kind: "direct",
          stop: async () => ({ signal: "SIGTERM", forced: false }),
          start: async () => {
            advanceMonotonicBy(18);
            descriptors.set("run-serve", makeDescriptor({
              repoRoot,
              runsRoot,
              gitHead: currentHead,
              pid: 5150,
              argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
            }));
            return { pid: 5150 };
          },
          status: async () => ({ running: true, pid: 5150 }),
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async () => {
          advanceMonotonicBy(10);
          return daemonHealthResponse(currentHead);
        })),
      },
    );

    expect(result.status).toBe("succeeded");
    // This fixture has zero active runs, so the automatic policy truthfully
    // reports nothing-to-preserve rather than probing daemon features.
    // Feature-probe availability (and its failure modes) are covered by the
    // dedicated preservation tests with live restart-safe fixture runs.
    expect(result.plan.preservation).toEqual({
      policy: "automatic",
      status: "not_applicable",
      required_features: [
        CALYX_DAEMON_FEATURES.runReadoptOnBootV1,
        CALYX_DAEMON_FEATURES.detachedWorkerIsolationV1,
      ],
      unavailable_reasons: [],
      note: "the classifier found no active restart-safe runs",
    });
    expect(result.receipt?.status).toBe("succeeded");
    expect(result.plan.promoted_build).toEqual({
      git_head: "cccccccccccccccccccccccccccccccccccccccc",
      install_path: path.join(homeRoot, ".calyx", "installs", "cccccccccccccccccccccccccccccccccccccccc"),
      current_link: path.join(homeRoot, ".calyx", "installs", "current"),
    });
    expect(result.receipt?.install).toMatchObject({
      git_head: "cccccccccccccccccccccccccccccccccccccccc",
      mechanism: "pack-install",
      verified_version: "0.2.0",
    });
    expect(result.receipt?.target_state_applied).toMatchObject({
      status: "applied",
      current: "0001",
      target: "0001",
      pending_migrations: [],
    });
    expect(result.receipt?.maintenance_disposition).toMatchObject({
      status: "released",
    });
    expect(result.receipt?.artifact_cleanup).toMatchObject({
      state_backup: "cleaned",
      supervisor_backup: "not_created",
      retained_paths: [],
      errors: [],
    });
    expect(result.receipt_path).toBeTruthy();
    // Operation id == receipt basename, exposed on the result for the CLI to
    // print and for the fleet local-fast-path to surface.
    expect(result.operation_id).toBeTruthy();
    expect(result.receipt_path).toContain(result.operation_id!);
    expect(result.receipt).toMatchObject({
      operation_id: result.operation_id,
      fleet_operation_id: "fleet-current-test",
    });
    expect(descriptors.get("run-serve")?.maintenance_mode).toBe(false);
    expect(result.receipt?.drain_duration_ms).toBe(2);
    expect(observedPhases.map((event) => event.control.elapsed_ms)).toEqual([
      10,
      10,
      20,
      20,
      20,
      22,
      22,
      22,
      22,
      40,
      50,
    ]);
    expect(observedPhases.every((event) => Number.isFinite(Date.parse(event.emitted_at)))).toBe(true);
    // Every event this projection failed to durably record must be named in the
    // receipt. Asserting the exact failure *detail* would make this test depend
    // on which event happened to cross the 1000ms settle deadline first under
    // load — the completed event only times out itself when it is the first
    // casualty; otherwise it is reported as dropped after an earlier failure.
    expect(result.receipt?.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("event-log projection unavailable for daemon.upgrade.completed"),
    ]));
    const durableReceipt = JSON.parse(await readFile(result.receipt_path!, "utf8")) as {
      operation_id?: string;
      fleet_operation_id?: string;
      warnings: string[];
    };
    expect(durableReceipt).toMatchObject({
      operation_id: result.operation_id,
      fleet_operation_id: "fleet-current-test",
    });
    expect(durableReceipt.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("event-log projection unavailable for daemon.upgrade.completed"),
    ]));

    const eventsPath = path.join(runsRoot, "events.index.jsonl");
    const indexedEvents = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      event_type: string;
      control: { operation_id?: string; phase?: string };
    });
    const startedEvent = indexedEvents.find((event) => event.event_type === "daemon.upgrade.started");
    const completedEvent = indexedEvents.find((event) => event.event_type === "daemon.upgrade.completed");
    expect(startedEvent?.control.operation_id).toBe(result.operation_id);
    expect(completedEvent?.control.operation_id).toBe(result.operation_id);

    // Progress events fire on entry to each phase boundary, in a stable order,
    // all carrying the one operation id (the kill for the "silent 1-2 min").
    const progressPhases = indexedEvents
      .filter((event) => event.event_type === "daemon.upgrade.progress")
      .map((event) => event.control.phase);
    expect(progressPhases).toEqual([
      "fetch",
      "build",
      "prepare",
      "supervisor_ready",
      "drain",
      "state_snapshot",
      "supervisor_install",
      "promote",
      "restart",
      "health_wait",
      "finalize",
    ]);
    const progressOperationIds = new Set(
      indexedEvents
        .filter((event) => event.event_type === "daemon.upgrade.progress")
        .map((event) => event.control.operation_id),
    );
    expect([...progressOperationIds]).toEqual([result.operation_id]);

    const opened = await openStateStore();
    try {
      const rows = opened.db.prepare(
        "SELECT event_type FROM event_log WHERE event_type LIKE 'daemon.upgrade.%' ORDER BY occurred_at",
      ).all() as Array<{ event_type: string }>;
      expect(rows.map((row) => row.event_type)).toEqual([
        "daemon.upgrade.started",
        "daemon.upgrade.progress",
        "daemon.upgrade.progress",
        "daemon.upgrade.progress",
        "daemon.upgrade.progress",
        "daemon.upgrade.progress",
        "daemon.upgrade.progress",
        "daemon.upgrade.progress",
        "daemon.upgrade.progress",
        "daemon.upgrade.progress",
        "daemon.upgrade.progress",
        "daemon.upgrade.progress",
        "daemon.upgrade.completed",
      ]);
      expect(opened.paths.stateDir).toBe(path.join(homeRoot, "state"));
    } finally {
      opened.db.close();
    }
  });

  test("post-commit terminal errors retain a local cleanup diagnostic without rewriting authority", async () => {
    let currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({ repoRoot, runsRoot, gitHead: currentHead })],
    ]);
    const cleanupBootstrapSandbox = vi.fn(async () => ({ status: "residue" as const }));
    const writeDescriptor = vi.fn(async (next: CalyxDaemonDescriptor) => {
      const current = descriptors.get(next.daemon_id);
      // Maintenance is released only after the durable `committed` phase.
      // Fail there to take the otherwise bypassed committed-error funnel.
      if (current?.maintenance_mode && !next.maintenance_mode) {
        throw new Error("injected post-commit maintenance publication failure");
      }
      descriptors.set(next.daemon_id, next);
      return path.join(root, `${next.daemon_id}.json`);
    });

    let thrown: SelfUpgradeExecutionError | undefined;
    try {
      await runSelfUpgrade(
        { host: "blade", authToken: "secret-token" },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({
            lockPath: path.join(homeRoot, "lock"),
            release: async () => {},
          })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [...descriptors.values()],
          readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
          writeDescriptor,
          execGit: async (args: string[]) => {
            if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
            if (args[0] === "pull") {
              currentHead = "cccccccccccccccccccccccccccccccccccccccc";
              return { code: 0, stdout: "updated\n", stderr: "" };
            }
            return {
              code: 0,
              stdout: args[1] === "HEAD"
                ? `${currentHead}\n`
                : "cccccccccccccccccccccccccccccccccccccccc\n",
              stderr: "",
            };
          },
          runBuild: async () => ({ code: 0, stdout: "", stderr: "" }),
          prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
          cleanupBootstrapSandbox,
          createRunService: () => createRunServiceStub([]),
          createSupervisorAdapter: () => ({
            kind: "direct" as const,
            stop: async () => ({ signal: "SIGTERM" as const, forced: false }),
            start: async () => {
              const restartedMaintenanceMode = descriptors.get("run-serve")?.maintenance_mode;
              descriptors.set("run-serve", makeDescriptor({
                repoRoot,
                runsRoot,
                gitHead: currentHead,
                pid: 5150,
                argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
                maintenanceMode: restartedMaintenanceMode ?? false,
              }));
              return { pid: 5150 };
            },
            status: async () => ({ running: true, pid: 5150 }),
          }),
          createAdminClient: createAdminClientFactory(vi.fn(async () => daemonHealthResponse(currentHead))),
        },
      );
    } catch (error) {
      thrown = error as SelfUpgradeExecutionError;
    }

    expect(thrown?.message).toContain("Target cutover is durably committed");
    expect(thrown?.message).toContain("injected post-commit maintenance publication failure");
    expect(thrown?.exitCode).toBe(6);
    expect(cleanupBootstrapSandbox).toHaveBeenCalledTimes(1);
    expect(thrown?.projection_issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: "operation_cleanup",
        code: "best_effort_cleanup",
        detail: "residue",
      }),
    ]));
    expect(thrown?.receipt).toBeUndefined();
  });

  test("progress events are idempotent on event_id across re-append", async () => {
    const runsRoot2 = path.join(root, "runs-idem");
    await mkdir(runsRoot2, { recursive: true });
    const progressEvent = buildControlEvent({
      now: "2026-04-20T00:00:01.000Z",
      eventType: "daemon.upgrade.progress",
      emittedBy: "self-upgrade",
      host: "blade",
      operationId: "2026-04-20T00-00-00-000Z-blade",
      phase: "build",
      elapsedMs: 42,
    });

    // A second-shell replay (e.g. reconcile) can re-deliver the same event;
    // the JSONL index and the SQLite event_log both dedupe on event_id.
    await appendControlEvent([runsRoot2], progressEvent);
    await appendControlEvent([runsRoot2], progressEvent);

    const lines = (await readFile(path.join(runsRoot2, "events.index.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);

    const opened = await openStateStore();
    try {
      const rows = opened.db.prepare(
        "SELECT event_id FROM event_log WHERE event_type = 'daemon.upgrade.progress'",
      ).all() as Array<{ event_id: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.event_id).toBe(progressEvent.event_id);
    } finally {
      opened.db.close();
    }
  });

  test("POL-2072: an unrepairable target contract blocks before the first mutation even when a supervisor cutover is staged", async () => {
    // The stale-planner regression: planning reads a supported contract from
    // `git show`, but the adopted worktree carries a schema this upgrader
    // cannot evaluate. No supervisor definition can repair that, so it must
    // refuse before stop/snapshot/supervisor-install — not after all three.
    await mkdir(path.join(repoRoot, "packages", "core"), { recursive: true });
    await writeFile(
      path.join(repoRoot, CALYX_STARTUP_CONTRACT_MANIFEST_RELATIVE_PATH),
      JSON.stringify({ ...CALYX_SERVER_STARTUP_CONTRACT, schema_version: "calyx-startup-contract/v9" }),
      "utf8",
    );
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({ repoRoot, runsRoot })],
    ]);
    const stopSpy = vi.fn(async () => ({ signal: "SIGTERM", forced: false }));
    const runBuild = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const prepareStateCutover = vi.fn();
    const supervisorInstall = vi.fn();

    const attempt = async (force: boolean): Promise<unknown> => {
      const observedPhases: SelfUpgradePhaseEvent[] = [];
      let thrown: unknown;
      try {
        await runSelfUpgrade(
          {
            host: "blade",
            authToken: "secret-token",
            ...(force ? { force: true } : {}),
          },
          {
            homeDir: () => homeRoot,
            onPhase: (event) => observedPhases.push(event),
            acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
            resolveCurrentHostAlias: async () => "blade",
            resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
            resolveRepo: async () => repoRoot,
            listDescriptors: async () => [...descriptors.values()],
            readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
            writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
              descriptors.set(next.daemon_id, next);
              return "";
            }),
            execGit: async (args: string[]) => {
              if (args[0] === "status") {
                return { code: 0, stdout: "", stderr: "" };
              }
              if (args[0] === "pull") {
                return { code: 0, stdout: "updated\n", stderr: "" };
              }
              return {
                code: 0,
                stdout: args[1] === "HEAD" ? `${"a".repeat(40)}\n` : `${"c".repeat(40)}\n`,
                stderr: "",
              };
            },
            runBuild,
            prepareStateCutover,
            prepareSupervisorCutover: async ({ preparedInstall }) => ({
              readiness: {
                schema_version: "self-upgrade-supervisor-readiness/v1" as const,
                status: "ready" as const,
                target_git_head: preparedInstall.git_head,
                source: "agents-infra" as const,
                supervisor_kinds: ["systemd" as const],
              },
              install: supervisorInstall,
              restore: async () => ({
                schema_version: "self-upgrade-supervisor-rollback/v1" as const,
                status: "skipped" as const,
              }),
            }),
            createRunService: () => createRunServiceStub([]),
            createSupervisorAdapter: () => ({
              kind: "direct",
              stop: stopSpy,
              start: async () => ({ pid: 5150 }),
              status: async () => ({ running: true, pid: 5150 }),
            }),
          },
        );
      } catch (error) {
        thrown = error;
      }
      // The gate fires between the fetch and build phases.
      expect(observedPhases.map((event) => event.control.phase)).toEqual(["fetch"]);
      return thrown;
    };

    for (const force of [false, true]) {
      const thrown = await attempt(force);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("Upgrade the local Calyx upgrader");
    }

    // --force never reaches a mutation: no daemon stop, no state snapshot, no
    // supervisor install, and the daemon is left uncordoned.
    expect(stopSpy).not.toHaveBeenCalled();
    expect(prepareStateCutover).not.toHaveBeenCalled();
    expect(supervisorInstall).not.toHaveBeenCalled();
    expect(runBuild).not.toHaveBeenCalled();
    expect(descriptors.get("run-serve")?.maintenance_mode).toBe(false);
  });

  test("POL-2140: blocked toolchain persists a failed receipt and operation observation before build", async () => {
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({ repoRoot, runsRoot })],
    ]);
    const runBuild = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    let thrown: SelfUpgradeExecutionError | undefined;
    try {
      await runSelfUpgrade(
        { host: "mba", authToken: "secret-token" },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "mba",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [...descriptors.values()],
          readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
          writeDescriptor: async (next) => {
            descriptors.set(next.daemon_id, next);
            return "";
          },
          execGit: async (args) => {
            if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
            if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
            if (args[0] === "rev-parse") {
              return {
                code: 0,
                stdout: `${args[1] === "HEAD" ? "a".repeat(40) : "c".repeat(40)}\n`,
                stderr: "",
              };
            }
            return { code: 0, stdout: "", stderr: "" };
          },
          attestToolchain: async ({ targetSha }) => blockedMbaToolchainCheck(targetSha),
          runBuild,
          createRunService: () => createRunServiceStub([]),
          createSupervisorAdapter: () => ({
            kind: "direct",
            stop: async () => ({ signal: "SIGTERM", forced: false }),
            start: async () => ({ pid: 5150 }),
            status: async () => ({ running: true, pid: 5150 }),
          }),
        },
      );
    } catch (error) {
      thrown = error as SelfUpgradeExecutionError;
    }

    expect(thrown?.message).toContain("blocked/toolchain");
    expect(runBuild).not.toHaveBeenCalled();
    expect(thrown?.receipt_path).toBeTruthy();
    expect(thrown?.receipt).toMatchObject({
      status: "failed",
      host: "mba",
      toolchain_check: { status: "blocked", surface: "toolchain" },
    });
    const operationId = thrown!.receipt!.operation_id!;
    const observation = await observeSelfUpgradeOperation(
      defaultSelfUpgradeOperationRoot(homeRoot),
      operationId,
    );
    expect(observation.operation.hosts.mba).toMatchObject({
      execution_status: "failed",
      toolchain_check: { status: "blocked", surface: "toolchain" },
      receipt_locator: { host: "mba" },
    });
  });

  test("POL-2072: a latched event projection names every dropped event, not only the first", async () => {
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({ repoRoot, runsRoot })],
    ]);
    // Fail deterministically on the very first event so the latch engages
    // immediately; every later event must still be reported as dropped.
    const appendEventProjection = vi.fn(async () => {
      throw new Error("event log offline");
    });

    let thrown: unknown;
    try {
      await runSelfUpgrade(
        {
          host: "blade",
          authToken: "secret-token",
        },
        {
          homeDir: () => homeRoot,
          appendEventProjection,
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [...descriptors.values()],
          readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
          writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
            descriptors.set(next.daemon_id, next);
            return "";
          }),
          execGit: async (args: string[]) => {
            if (args[0] === "status") {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "pull") {
              return { code: 0, stdout: "updated\n", stderr: "" };
            }
            return {
              code: 0,
              stdout: args[1] === "HEAD" ? `${"a".repeat(40)}\n` : `${"c".repeat(40)}\n`,
              stderr: "",
            };
          },
          // Stop at the build so the run terminates quickly with a receipt.
          runBuild: async () => ({ code: 1, stdout: "", stderr: "build exploded" }),
          createRunService: () => createRunServiceStub([]),
          createSupervisorAdapter: () => ({
            kind: "direct",
            stop: async () => ({ signal: "SIGTERM", forced: false }),
            start: async () => ({ pid: 5150 }),
            status: async () => ({ running: true, pid: 5150 }),
          }),
        },
      );
    } catch (error) {
      thrown = error;
    }

    const warnings = (thrown as { receipt?: { warnings?: string[] } }).receipt?.warnings ?? [];
    // Only the first attempt actually pays the projection call; the rest are
    // dropped by the latch — but the receipt still names each one.
    expect(appendEventProjection).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual(expect.arrayContaining([
      "event-log projection unavailable for daemon.upgrade.started: event log offline",
      expect.stringContaining("event-log projection unavailable for daemon.upgrade.progress:"),
      expect.stringContaining("event-log projection unavailable for daemon.upgrade.failed:"),
    ]));
    expect(warnings.filter((warning) => warning.startsWith("event-log projection unavailable")).length)
      .toBeGreaterThan(1);
  });

  test("rejects a SHA-matching daemon that restarts through the clone executable path", async () => {
    let currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let runningHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let startCalls = 0;
    const previousInstall = await materializeInstallFixture(homeRoot, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({
        repoRoot,
        runsRoot,
        gitHead: currentHead,
        argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
      })],
    ]);

    let thrown: unknown;
    try {
      await runSelfUpgrade(
        {
          host: "blade",
          authToken: "secret-token",
        },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [...descriptors.values()],
          readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
          writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
            descriptors.set(next.daemon_id, next);
            return path.join(root, `${next.daemon_id}.json`);
          }),
          execGit: async (args: string[]) => {
            if (args[0] === "status") {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "pull") {
              currentHead = "cccccccccccccccccccccccccccccccccccccccc";
              return { code: 0, stdout: "updated\n", stderr: "" };
            }
            if (args[0] === "log") {
              return { code: 0, stdout: "abc123 POL-1786 stale wrapper regression\n", stderr: "" };
            }
            return { code: 0, stdout: args[1] === "HEAD" ? `${currentHead}\n` : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
          },
          runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
          prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
          createRunService: () => createRunServiceStub([]),
          createSupervisorAdapter: () => ({
            kind: "direct",
            stop: async () => ({ signal: "SIGTERM", forced: false }),
            start: async () => {
              startCalls += 1;
              if (startCalls === 1) {
                runningHead = "cccccccccccccccccccccccccccccccccccccccc";
                descriptors.set("run-serve", makeDescriptor({
                  repoRoot,
                  runsRoot,
                  gitHead: runningHead,
                  pid: 5150,
                  argv: [process.execPath, repoCloneBin(repoRoot), "run", "serve"],
                }));
              } else {
                runningHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
                descriptors.set("run-serve", makeDescriptor({
                  repoRoot,
                  runsRoot,
                  gitHead: runningHead,
                  pid: 5150,
                  argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
                }));
              }
              return { pid: 5150 };
            },
            status: async () => ({ running: true, pid: 5150 }),
          }),
          createAdminClient: createAdminClientFactory(vi.fn(async () => daemonHealthResponse(runningHead))),
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("is not under promoted current install");
    const typed = thrown as Error & { receipt?: { rollback?: { status: string } } };
    expect(typed.receipt?.rollback?.status).toBe("succeeded");
    expect(startCalls).toBe(2);
    expect(await realpath(previousInstall.current_link)).toBe(await realpath(previousInstall.install_path));
  });

  test("rejects a SHA-matching daemon whose descriptor only records synthetic argv", async () => {
    let currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let runningHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let startCalls = 0;
    const previousInstall = await materializeInstallFixture(homeRoot, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({
        repoRoot,
        runsRoot,
        gitHead: currentHead,
        argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
      })],
    ]);

    let thrown: unknown;
    try {
      await runSelfUpgrade(
        {
          host: "blade",
          authToken: "secret-token",
        },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [...descriptors.values()],
          readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
          writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
            descriptors.set(next.daemon_id, next);
            return path.join(root, `${next.daemon_id}.json`);
          }),
          execGit: async (args: string[]) => {
            if (args[0] === "status") {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "pull") {
              currentHead = "cccccccccccccccccccccccccccccccccccccccc";
              return { code: 0, stdout: "updated\n", stderr: "" };
            }
            if (args[0] === "log") {
              return { code: 0, stdout: "abc123 POL-1786 synthetic descriptor argv regression\n", stderr: "" };
            }
            return { code: 0, stdout: args[1] === "HEAD" ? `${currentHead}\n` : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
          },
          runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
          prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
          createRunService: () => createRunServiceStub([]),
          createSupervisorAdapter: () => ({
            kind: "direct",
            stop: async () => ({ signal: "SIGTERM", forced: false }),
            start: async () => {
              startCalls += 1;
              if (startCalls === 1) {
                runningHead = "cccccccccccccccccccccccccccccccccccccccc";
                descriptors.set("run-serve", makeDescriptor({
                  repoRoot,
                  runsRoot,
                  gitHead: runningHead,
                  pid: 5150,
                  argv: ["calyx", "run", "serve", "--host", "127.0.0.1", "--port", "8740"],
                }));
              } else {
                runningHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
                descriptors.set("run-serve", makeDescriptor({
                  repoRoot,
                  runsRoot,
                  gitHead: runningHead,
                  pid: 5150,
                  argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
                }));
              }
              return { pid: 5150 };
            },
            status: async () => ({ running: true, pid: 5150 }),
          }),
          createAdminClient: createAdminClientFactory(vi.fn(async () => daemonHealthResponse(runningHead))),
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("does not include a concrete executable path");
    const typed = thrown as Error & { receipt?: { rollback?: { status: string } } };
    expect(typed.receipt?.rollback?.status).toBe("succeeded");
    expect(startCalls).toBe(2);
    expect(await realpath(previousInstall.current_link)).toBe(await realpath(previousInstall.install_path));
  });

  // POL-2090: schema convergence is a step the cutover owns, not a side effect
  // of whichever process opens the store after the restart.
  async function runUpgradeWithPendingMigration(args: {
    migrate: (order: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  }): Promise<{
    order: string[];
    stateRestored: boolean;
    promoted: boolean;
    startCalls: number;
    finalDescriptor: CalyxDaemonDescriptor | undefined;
    maintenanceDisposition: string | undefined;
    result?: Awaited<ReturnType<typeof runSelfUpgradeImpl>>;
    thrown?: unknown;
  }> {
    let currentHead = "a".repeat(40);
    const order: string[] = [];
    let stateRestored = false;
    let promoted = false;
    let startCalls = 0;
    let planCalls = 0;
    // A stand-in for the snapshotted database: `verifyTargetStateGrowthBound`
    // only stats the path the snapshot receipt names, and the live state store
    // (CALYX_STATE_HOME) must stay a real SQLite file for the event sink.
    const databasePath = path.join(root, "state-growth-fixture", "calyx.db");
    await mkdir(path.dirname(databasePath), { recursive: true });
    await writeFile(databasePath, "x".repeat(4096), "utf8");
    const databaseBytes = (await stat(databasePath)).size;
    await materializeInstallFixture(homeRoot, "a".repeat(40));
    const bootstrapWrapper = path.join(homeRoot, ".agents", "run", "calyx");
    await mkdir(path.dirname(bootstrapWrapper), { recursive: true });
    await writeFile(
      bootstrapWrapper,
      `SOURCE_EXECUTABLE_PATH='${currentInstallBin(homeRoot)}'\n`,
      "utf8",
    );
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({
        repoRoot,
        runsRoot,
        gitHead: currentHead,
        argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
      })],
    ]);

    const pendingPlan = JSON.stringify({
      driver: "better-sqlite3",
      current: "0001",
      target: "0002",
      ledgerExists: true,
      applied: [{ id: "0001", description: "baseline", appliedAt: "2026-07-23T00:00:00.000Z" }],
      pending: [{
        id: "0002",
        description: "two",
        status: "pending",
        growthBound: { databaseSizeMultiplier: 4, fixedBytes: 8 * 1024 * 1024 },
      }],
    });
    const convergedPlan = JSON.stringify({
      driver: "better-sqlite3",
      current: "0002",
      target: "0002",
      ledgerExists: true,
      applied: [
        { id: "0001", description: "baseline", appliedAt: "2026-07-23T00:00:00.000Z" },
        { id: "0002", description: "two", appliedAt: "2026-07-27T00:00:00.000Z" },
      ],
      pending: [],
    });

    const dependencies = {
      homeDir: () => homeRoot,
      acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
      resolveCurrentHostAlias: async () => "blade",
      resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
      resolveRepo: async () => repoRoot,
      listDescriptors: async () => [...descriptors.values()],
      readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
      writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
        descriptors.set(next.daemon_id, next);
        return path.join(root, `${next.daemon_id}.json`);
      }),
      execGit: async (execArgs: string[]) => {
        if (execArgs[0] === "status") return { code: 0, stdout: "", stderr: "" };
        if (execArgs[0] === "pull") {
          currentHead = "c".repeat(40);
          return { code: 0, stdout: "updated\n", stderr: "" };
        }
        if (execArgs[0] === "log") return { code: 0, stdout: "abc123 POL-2090\n", stderr: "" };
        return {
          code: 0,
          stdout: execArgs[1] === "HEAD" ? `${currentHead}\n` : `${"c".repeat(40)}\n`,
          stderr: "",
        };
      },
      runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
      prepareInstall: vi.fn(async ({ gitHead }: { gitHead: string }) => prepareInstallFixture(homeRoot, gitHead)),
      promoteInstall: async (receipt: VersionedInstallReceipt) => {
        order.push("promote");
        promoted = true;
        return promoteVersionedInstall(receipt);
      },
      runTargetStatePlan: async () => {
        planCalls += 1;
        return { code: 0, stdout: planCalls === 1 ? pendingPlan : convergedPlan, stderr: "" };
      },
      runTargetStateMigrate: async () => args.migrate(order),
      prepareStateCutover: async () => ({
        snapshot: {
          schema_version: "self-upgrade-state-snapshot/v1" as const,
          status: "snapshotted" as const,
          database_path: databasePath,
          backup_path: path.join(homeRoot, "state-backup", "calyx.db"),
          database_sha256: "d".repeat(64),
          size_bytes: databaseBytes,
          wal_checkpoint: "truncate" as const,
          quick_check: "ok" as const,
          capacity_preflight: {
            available_bytes: 512 * 1024 * 1024,
            required_bytes: 96 * 1024 * 1024,
            same_device: true,
            snapshot_bytes: databaseBytes,
            migration_growth_reserve_bytes: 64 * 1024 * 1024,
            target_declared_migration_growth_bytes: databaseBytes * 4 + 8 * 1024 * 1024,
            rollback_allocation_bytes: 16 * 1024 * 1024,
          },
        },
        restore: async () => {
          stateRestored = true;
          return {
            schema_version: "self-upgrade-state-rollback/v1" as const,
            status: "succeeded" as const,
            restored_sha256: "d".repeat(64),
            quick_check: "ok" as const,
          };
        },
        cleanup: async () => {},
      }),
      prepareSupervisorCutover: vi.fn(async ({ preparedInstall }: { preparedInstall: VersionedInstallReceipt }) => ({
        readiness: {
          schema_version: "self-upgrade-supervisor-readiness/v1" as const,
          status: "ready" as const,
          target_git_head: preparedInstall.git_head,
          source: "agents-infra" as const,
          source_sha256: "b".repeat(64),
          supervisor_kinds: ["systemd" as const],
        },
        install: async () => {
          order.push("supervisor_install");
          return {
            schema_version: "self-upgrade-supervisor-install/v1" as const,
            status: "installed" as const,
            installed_sha256: "b".repeat(64),
          };
        },
        restore: async () => ({
          schema_version: "self-upgrade-supervisor-rollback/v1" as const,
          status: "succeeded" as const,
          restored_sha256: "a".repeat(64),
        }),
      })),
      createRunService: () => createRunServiceStub([]),
      createSupervisorAdapter: () => ({
        kind: "direct" as const,
        stop: async () => {
          descriptors.delete("run-serve");
          return { signal: "SIGTERM", forced: false };
        },
        start: async () => {
          startCalls += 1;
          const runningHead = path.basename(await realpath(path.join(homeRoot, ".calyx", "installs", "current")));
          descriptors.set("run-serve", makeDescriptor({
            repoRoot,
            runsRoot,
            gitHead: runningHead,
            pid: 5150,
            argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
          }));
          return { pid: 5150 };
        },
        status: async () => ({ running: true, pid: 5150 }),
      }),
      createAdminClient: createAdminClientFactory(vi.fn(async () => {
        const runningHead = descriptors.get("run-serve")?.build.git_head ?? currentHead;
        return daemonHealthResponse(runningHead);
      })),
    };

    try {
      const result = await runSelfUpgrade({ host: "blade", authToken: "secret-token" }, dependencies);
      return {
        order,
        stateRestored,
        promoted,
        startCalls,
        finalDescriptor: descriptors.get("run-serve"),
        maintenanceDisposition: result.receipt?.maintenance_disposition?.status,
        result,
      };
    } catch (thrown) {
      const receipt = (thrown as SelfUpgradeExecutionError).receipt;
      return {
        order,
        stateRestored,
        promoted,
        startCalls,
        finalDescriptor: descriptors.get("run-serve"),
        maintenanceDisposition: receipt?.maintenance_disposition?.status,
        thrown,
      };
    }
  }

  test("the cutover migrates the store itself, before the supervisor unit or current symlink moves (POL-2090)", async () => {
    const observed = await runUpgradeWithPendingMigration({
      migrate: async (order) => {
        order.push("migrate");
        return {
          code: 0,
          stdout: JSON.stringify({
            driver: "better-sqlite3",
            applied: [{ id: "0002", description: "two", appliedAt: "2026-07-27T00:00:00.000Z" }],
            alreadyApplied: [{ id: "0001", description: "baseline", appliedAt: "2026-07-23T00:00:00.000Z" }],
            current: "0002",
            target: "0002",
          }),
          stderr: "",
        };
      },
    });

    expect(observed.thrown).toBeUndefined();
    expect(observed.result?.status).toBe("succeeded");
    expect(observed.order).toEqual(["migrate", "supervisor_install", "promote"]);
    expect(observed.result?.receipt?.target_state_migrated).toMatchObject({
      status: "migrated",
      current: "0002",
      target: "0002",
      applied_migrations: ["0002"],
      observed_state_growth_bytes: 0,
    });
    // The post-restart plan is now a convergence proof, not the convergence.
    expect(observed.result?.receipt?.target_state_applied).toMatchObject({
      status: "applied",
      current: "0002",
      pending_migrations: [],
    });
  });

  test("a failed pre-promotion migration restores state and the running daemon before reporting rollback success (POL-2090/POL-2095)", async () => {
    const observed = await runUpgradeWithPendingMigration({
      migrate: async (order) => {
        order.push("migrate");
        return { code: 1, stdout: "", stderr: "disk I/O error" };
      },
    });

    expect(observed.thrown).toBeInstanceOf(Error);
    expect((observed.thrown as Error).message).toContain("Target state migration failed");
    expect(observed.order).toEqual(["migrate"]);
    expect(observed.promoted).toBe(false);
    expect(observed.stateRestored).toBe(true);
    expect(observed.startCalls).toBe(1);
    const rollback = (observed.thrown as SelfUpgradeExecutionError).receipt?.rollback;
    expect(rollback?.error).toBeUndefined();
    expect(rollback).toMatchObject({
      status: "succeeded",
    });
    expect(observed.maintenanceDisposition).toBe("released");
    expect(observed.finalDescriptor).toMatchObject({
      build: { git_head: "a".repeat(40) },
      maintenance_mode: false,
    });
  });

  test("automatically rolls current back to the previous install when restart fails after promote", async () => {
    let currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let runningHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let startCalls = 0;
    let supervisorDefinition = "old-definition";
    let cleanupObservedRetiredJournal = false;
    const supervisorTransitions: string[] = [];
    const observedPhases: Array<SelfUpgradePhaseEvent["control"]["phase"]> = [];
    const previousInstall = await materializeInstallFixture(homeRoot, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({
        repoRoot,
        runsRoot,
        gitHead: currentHead,
        argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
      })],
    ]);

    let thrown: unknown;
    try {
      await runSelfUpgrade(
        {
          host: "blade",
          authToken: "secret-token",
        },
        {
          homeDir: () => homeRoot,
          onPhase: (event) => observedPhases.push(event.control.phase),
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [...descriptors.values()],
          readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
          writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
            descriptors.set(next.daemon_id, next);
            return path.join(root, `${next.daemon_id}.json`);
          }),
          execGit: async (args: string[]) => {
            if (args[0] === "status") {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "pull") {
              currentHead = "cccccccccccccccccccccccccccccccccccccccc";
              return { code: 0, stdout: "updated\n", stderr: "" };
            }
            if (args[0] === "log") {
              return { code: 0, stdout: "abc123 POL-1786 rollback regression\n", stderr: "" };
            }
            return { code: 0, stdout: args[1] === "HEAD" ? `${currentHead}\n` : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
          },
          runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
          prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
          prepareStateCutover: async ({ operationId, homeDir }) => ({
            snapshot: {
              schema_version: "self-upgrade-state-snapshot/v1" as const,
              status: "snapshotted" as const,
              database_path: path.join(homeDir, "state", "calyx.db"),
              backup_path: path.join(homeDir, "state-backup", "calyx.db"),
              database_sha256: "d".repeat(64),
              size_bytes: 1,
              wal_checkpoint: "truncate" as const,
              quick_check: "ok" as const,
              capacity_preflight: {
                available_bytes: 128 * 1024 * 1024,
                required_bytes: 81 * 1024 * 1024,
                same_device: true,
                snapshot_bytes: 1,
                migration_growth_reserve_bytes: 64 * 1024 * 1024,
                target_declared_migration_growth_bytes: 0,
                rollback_allocation_bytes: 16 * 1024 * 1024,
              },
            },
            restore: async () => ({
              schema_version: "self-upgrade-state-rollback/v1" as const,
              status: "succeeded" as const,
              restored_sha256: "d".repeat(64),
              quick_check: "ok" as const,
            }),
            cleanup: async () => {
              await expect(access(path.join(
                homeRoot,
                ".calyx",
                "self-upgrade-cutovers",
                `${operationId}.json`,
              ))).rejects.toMatchObject({ code: "ENOENT" });
              cleanupObservedRetiredJournal = true;
            },
          }),
          prepareSupervisorCutover: vi.fn(async ({ preparedInstall }) => ({
            readiness: {
              schema_version: "self-upgrade-supervisor-readiness/v1" as const,
              status: "ready" as const,
              target_git_head: preparedInstall.git_head,
              source: "agents-infra" as const,
              source_sha256: "b".repeat(64),
              supervisor_kinds: ["systemd" as const],
            },
            install: async () => {
              expect(await realpath(previousInstall.current_link)).toBe(await realpath(previousInstall.install_path));
              supervisorDefinition = "new-definition";
              supervisorTransitions.push("installed");
              return {
                schema_version: "self-upgrade-supervisor-install/v1" as const,
                status: "installed" as const,
                installed_sha256: "b".repeat(64),
              };
            },
            restore: async () => {
              expect(await realpath(previousInstall.current_link)).toBe(await realpath(previousInstall.install_path));
              supervisorDefinition = "old-definition";
              supervisorTransitions.push("restored");
              return {
                schema_version: "self-upgrade-supervisor-rollback/v1" as const,
                status: "succeeded" as const,
                restored_sha256: "a".repeat(64),
              };
            },
          })),
          createRunService: () => createRunServiceStub([]),
          createSupervisorAdapter: () => ({
            kind: "direct",
            stop: async () => ({ signal: "SIGTERM", forced: false }),
            start: async () => {
              startCalls += 1;
              if (startCalls === 1) {
                expect(supervisorDefinition).toBe("new-definition");
                expect(await realpath(previousInstall.current_link)).toBe(
                  await realpath(makeInstallReceipt(homeRoot, "cccccccccccccccccccccccccccccccccccccccc").install_path),
                );
                throw new Error("restart exploded");
              }
              expect(supervisorDefinition).toBe("old-definition");
              expect(await realpath(previousInstall.current_link)).toBe(await realpath(previousInstall.install_path));
              runningHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
              descriptors.set("run-serve", makeDescriptor({
                repoRoot,
                runsRoot,
                gitHead: runningHead,
                pid: 5150,
                argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
              }));
              return { pid: 5150 };
            },
            status: async () => ({ running: true, pid: 5150 }),
          }),
          createAdminClient: createAdminClientFactory(vi.fn(async () => daemonHealthResponse(runningHead))),
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("restart exploded");
    const typed = thrown as Error & {
      receipt?: {
        install?: { git_head: string };
        maintenance_disposition?: { status: string; reason: string };
        rollback?: {
          status: string;
          previous_install_path?: string;
          previous_git_head?: string;
          supervisor?: { status: string; restored_sha256?: string };
        };
      };
    };
    expect(typed.receipt?.install?.git_head).toBe("cccccccccccccccccccccccccccccccccccccccc");
    expect(typed.receipt?.rollback).toMatchObject({
      status: "succeeded",
      previous_install_path: await realpath(previousInstall.install_path),
      previous_git_head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      supervisor: {
        status: "succeeded",
        restored_sha256: "a".repeat(64),
      },
    });
    expect(typed.receipt?.maintenance_disposition).toMatchObject({
      status: "released",
      reason: expect.stringContaining("verified after rollback"),
    });
    expect(supervisorTransitions).toEqual(["installed", "restored"]);
    expect(observedPhases).toEqual([
      "fetch",
      "build",
      "prepare",
      "supervisor_ready",
      "drain",
      "state_snapshot",
      "supervisor_install",
      "promote",
      "restart",
      "rollback",
    ]);
    expect(startCalls).toBe(2);
    expect(cleanupObservedRetiredJournal).toBe(true);
    expect(await realpath(previousInstall.current_link)).toBe(await realpath(previousInstall.install_path));
  });

  test("keeps maintenance engaged when rollback state authority cannot be verified", async () => {
    let currentHead = "a".repeat(40);
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({
        repoRoot,
        runsRoot,
        gitHead: currentHead,
        argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
      })],
    ]);
    let thrown: unknown;
    try {
      await runSelfUpgrade(
        { host: "blade", authToken: "secret-token" },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({
            lockPath: path.join(homeRoot, "lock"),
            release: async () => {},
          })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [...descriptors.values()],
          readDescriptor: async (daemonId) => descriptors.get(daemonId),
          writeDescriptor: async (next) => {
            descriptors.set(next.daemon_id, next);
            return path.join(root, `${next.daemon_id}.json`);
          },
          execGit: async (args) => {
            if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
            if (args[0] === "pull") {
              currentHead = "c".repeat(40);
              return { code: 0, stdout: "updated\n", stderr: "" };
            }
            return {
              code: 0,
              stdout: args[1] === "HEAD" ? `${currentHead}\n` : `${"c".repeat(40)}\n`,
              stderr: "",
            };
          },
          runBuild: async () => ({ code: 0, stdout: "ok\n", stderr: "" }),
          prepareInstall: async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead),
          prepareStateCutover: async ({ homeDir }) => ({
            snapshot: {
              schema_version: "self-upgrade-state-snapshot/v1" as const,
              status: "snapshotted" as const,
              database_path: path.join(homeDir, "state", "calyx.db"),
              backup_path: path.join(homeDir, "state-backup", "calyx.db"),
              database_sha256: "d".repeat(64),
              size_bytes: 1,
              wal_checkpoint: "truncate" as const,
              quick_check: "ok" as const,
              capacity_preflight: {
                available_bytes: 128 * 1024 * 1024,
                required_bytes: 81 * 1024 * 1024,
                same_device: true,
                snapshot_bytes: 1,
                migration_growth_reserve_bytes: 64 * 1024 * 1024,
                target_declared_migration_growth_bytes: 0,
                rollback_allocation_bytes: 16 * 1024 * 1024,
              },
            },
            restore: async () => ({
              schema_version: "self-upgrade-state-rollback/v1" as const,
              status: "failed" as const,
              error: "injected rollback integrity failure",
            }),
            cleanup: async () => {},
          }),
          prepareSupervisorCutover: async ({ preparedInstall }) => ({
            readiness: {
              schema_version: "self-upgrade-supervisor-readiness/v1" as const,
              status: "ready" as const,
              target_git_head: preparedInstall.git_head,
              source: "agents-infra" as const,
              source_sha256: "b".repeat(64),
              supervisor_kinds: ["systemd" as const],
            },
            install: async () => {
              throw new Error("injected supervisor install failure");
            },
            restore: async () => ({
              schema_version: "self-upgrade-supervisor-rollback/v1" as const,
              status: "succeeded" as const,
            }),
          }),
          createRunService: () => createRunServiceStub([]),
          createSupervisorAdapter: () => ({
            kind: "systemd",
            stop: async () => ({ signal: "SIGTERM" }),
            start: async () => ({ pid: 5150 }),
            status: async () => ({ running: true, pid: 5150 }),
          }),
          createAdminClient: createAdminClientFactory(vi.fn(async () => daemonHealthResponse("a".repeat(40)))),
        },
      );
    } catch (error) {
      thrown = error;
    }
    const typed = thrown as Error & {
      receipt?: {
        rollback?: { status: string; state?: { status: string; error?: string } };
        maintenance_disposition?: { status: string; reason: string };
      };
    };
    expect(typed.message).toContain("injected supervisor install failure");
    expect(typed.receipt?.rollback).toMatchObject({
      status: "failed",
      state: {
        status: "failed",
        error: "injected rollback integrity failure",
      },
    });
    expect(typed.receipt?.maintenance_disposition).toMatchObject({
      status: "engaged",
      reason: expect.stringContaining("rollback did not verify"),
    });
    expect(descriptors.get("run-serve")?.maintenance_mode).toBe(true);
  });

  test("bounds post-restart health verification on the semantic clock before verifying rollback", async () => {
    let currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let runningHead = currentHead;
    let monotonicMs = 0;
    let startCalls = 0;
    let healthSleepCalls = 0;
    const previousInstall = await materializeInstallFixture(homeRoot, currentHead);
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({
        repoRoot,
        runsRoot,
        gitHead: currentHead,
        argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
      })],
    ]);

    const outcome = await runSelfUpgrade(
      {
        host: "blade",
        authToken: "secret-token",
      },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [...descriptors.values()],
        readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
        writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
          descriptors.set(next.daemon_id, next);
          return path.join(root, `${next.daemon_id}.json`);
        }),
        execGit: async (args: string[]) => {
          if (args[0] === "status") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "pull") {
            currentHead = "cccccccccccccccccccccccccccccccccccccccc";
            return { code: 0, stdout: "updated\n", stderr: "" };
          }
          if (args[0] === "log") {
            return { code: 0, stdout: "abc123 POL-1886 bounded health deadline\n", stderr: "" };
          }
          return { code: 0, stdout: args[1] === "HEAD" ? `${currentHead}\n` : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
        },
        runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
        prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
        createRunService: () => createRunServiceStub([]),
        createSupervisorAdapter: () => ({
          kind: "direct",
          stop: async () => ({ signal: "SIGTERM", forced: false }),
          start: async () => {
            startCalls += 1;
            runningHead = startCalls === 1
              ? "cccccccccccccccccccccccccccccccccccccccc"
              : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            descriptors.set("run-serve", makeDescriptor({
              repoRoot,
              runsRoot,
              gitHead: runningHead,
              pid: 5150,
              argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
            }));
            return { pid: 5150 };
          },
          status: async () => ({ running: true, pid: 5150 }),
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async () => daemonHealthResponse(
          startCalls === 1
            ? "dddddddddddddddddddddddddddddddddddddddd"
            : runningHead,
        ))),
        monotonicNowMs: () => monotonicMs,
        sleep: async (ms: number) => {
          expect(ms).toBe(500);
          healthSleepCalls += 1;
          monotonicMs += 600_000;
        },
      },
    ).catch((error: unknown) => error as SelfUpgradeExecutionError);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as SelfUpgradeExecutionError).message).toContain(
      "expected git_head cccccccccccccccccccccccccccccccccccccccc, got dddddddddddddddddddddddddddddddddddddddd",
    );
    expect((outcome as SelfUpgradeExecutionError).receipt?.rollback?.status).toBe("succeeded");
    expect(startCalls).toBe(2);
    expect(healthSleepCalls).toBe(1);
    expect(monotonicMs).toBe(600_000);
    expect(await realpath(previousInstall.current_link)).toBe(await realpath(previousInstall.install_path));
  });

  test("keeps restart verification open past 30 seconds but closes at ten minutes", async () => {
    const expectedHead = "c".repeat(40);
    const observedHead = "d".repeat(40);
    const descriptor = makeDescriptor({
      repoRoot,
      runsRoot,
      gitHead: expectedHead,
      argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
    });
    let monotonicMs = 0;
    let sleepCalls = 0;
    const healthSignals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) {
        healthSignals.push(init.signal);
      }
      return daemonHealthResponse(observedHead);
    };

    const outcome = await verifySelfUpgradeDaemons(
      [{
        daemon_id: descriptor.daemon_id,
        pid: descriptor.pid,
        runs_root: descriptor.runs_root,
        health_url: descriptor.health_url,
        restart_order: descriptor.restart_order,
        supervisor: descriptor.supervisor,
        build: descriptor.build,
        maintenance_mode: descriptor.maintenance_mode ?? false,
      }],
      "blade",
      "secret-token",
      expectedHead,
      {
        currentLink: path.join(homeRoot, ".calyx", "installs", "current"),
        wrapperPath: path.join(homeRoot, ".agents", "run", "calyx"),
      },
      createAdminClientFactory(fetchImpl),
      async (ms) => {
        expect(ms).toBe(500);
        sleepCalls += 1;
        monotonicMs += sleepCalls === 1 ? 60_000 : 540_000;
      },
      () => monotonicMs,
      async () => descriptor,
    ).catch((error: unknown) => error as Error);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(`expected git_head ${expectedHead}, got ${observedHead}`);
    expect(sleepCalls).toBe(2);
    expect(monotonicMs).toBe(600_000);
    expect(healthSignals).toHaveLength(3);
    expect(healthSignals.every((signal) => signal === healthSignals[0] && !signal.aborted)).toBe(true);
  });

  test("bounds preserving verification health and run-list reads with one signal", async () => {
    const expectedHead = "c".repeat(40);
    await materializeInstallFixture(homeRoot, expectedHead);
    const wrapperPath = path.join(homeRoot, ".agents", "run", "calyx");
    await mkdir(path.dirname(wrapperPath), { recursive: true });
    await writeFile(
      wrapperPath,
      `SOURCE_EXECUTABLE_PATH='${currentInstallBin(homeRoot)}'\n`,
      "utf8",
    );
    const descriptor = makeDescriptor({
      repoRoot,
      runsRoot,
      gitHead: expectedHead,
      argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
    });
    const observedSignals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.signal) {
        observedSignals.push(init.signal);
      }
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      return url.includes("/v1/admin/runs")
        ? adminRunsResponse(["run-1"])
        : readoptHealthResponse(expectedHead, { withFlag: true, activeRuns: 1 });
    };

    const result = await verifySelfUpgradeDaemons(
      [{
        daemon_id: descriptor.daemon_id,
        pid: descriptor.pid,
        runs_root: descriptor.runs_root,
        health_url: descriptor.health_url,
        restart_order: descriptor.restart_order,
        supervisor: descriptor.supervisor,
        build: descriptor.build,
        maintenance_mode: descriptor.maintenance_mode ?? false,
      }],
      "blade",
      "secret-token",
      expectedHead,
      {
        currentLink: path.join(homeRoot, ".calyx", "installs", "current"),
        wrapperPath,
      },
      createAdminClientFactory(fetchImpl),
      async () => {
        throw new Error("verification unexpectedly retried");
      },
      () => 0,
      async () => descriptor,
      { expectedActiveRunIdsByRoot: new Map([[runsRoot, ["run-1"]]]) },
    );

    expect(result).toHaveLength(1);
    expect(observedSignals).toHaveLength(2);
    expect(observedSignals.every((signal) => signal === observedSignals[0] && !signal.aborted)).toBe(true);
  });

  test("falls back to loopback health when descriptor host fetch fails during verification", async () => {
    let currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const descriptorHealthUrl = "http://calebs-macbook-air-2:8740/calyx/control/";
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({ repoRoot, runsRoot, gitHead: currentHead, healthUrl: descriptorHealthUrl })],
    ]);
    const fetchRequests: string[] = [];

    const result = await runSelfUpgrade(
      {
        host: "mba",
        authToken: "secret-token",
      },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "mba",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [...descriptors.values()],
        readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
        writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
          descriptors.set(next.daemon_id, next);
          return path.join(root, `${next.daemon_id}.json`);
        }),
        execGit: async (args: string[]) => {
          if (args[0] === "status") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "pull") {
            currentHead = "cccccccccccccccccccccccccccccccccccccccc";
            return { code: 0, stdout: "updated\n", stderr: "" };
          }
          if (args[0] === "log") {
            return { code: 0, stdout: "abc123 POL-1163 test commit\n", stderr: "" };
          }
          return { code: 0, stdout: args[1] === "HEAD" ? `${currentHead}\n` : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
        },
        runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
        prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
        createRunService: () => createRunServiceStub([]),
        createSupervisorAdapter: () => ({
          kind: "direct",
          stop: async () => ({ signal: "SIGTERM", forced: false }),
          start: async () => {
            descriptors.set("run-serve", makeDescriptor({
              repoRoot,
              runsRoot,
              gitHead: currentHead,
              healthUrl: descriptorHealthUrl,
              pid: 5150,
              argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
            }));
            return { pid: 5150 };
          },
          status: async () => ({ running: true, pid: 5150 }),
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async (input) => {
          fetchRequests.push(String(input));
          if (fetchRequests.length === 1) {
            throw new TypeError("fetch failed");
          }
          return daemonHealthResponse(currentHead, "mba");
        })),
      },
    );

    expect(result.status).toBe("succeeded");
    expect(result.receipt?.after_builds).toHaveLength(1);
    const afterBuild = result.receipt?.after_builds.at(0);
    expect(afterBuild).toBeDefined();
    expect(afterBuild!.build?.git_head).toBe("cccccccccccccccccccccccccccccccccccccccc");
    expect(fetchRequests).toEqual([
      "http://calebs-macbook-air-2:8740/calyx/control/v1/admin/health",
      "http://127.0.0.1:8740/calyx/control/v1/admin/health",
    ]);
    const operation = await observeSelfUpgradeOperation(
      defaultSelfUpgradeOperationRoot(homeRoot),
      result.operation_id!,
    );
    expect(operation).toMatchObject({
      projection_status: "available",
      running_state: "terminal",
      owner_liveness: "released",
      operation: {
        operation_id: result.operation_id,
        target_sha: "cccccccccccccccccccccccccccccccccccccccc",
        status: "succeeded",
        final_receipt_path: result.receipt_path,
        hosts: {
          mba: {
            dispatch: "local",
            latest_phase: "finalize",
            execution_status: "succeeded",
            relay_mode: "local",
            before_head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            after_head: "cccccccccccccccccccccccccccccccccccccccc",
          },
        },
      },
    });
  });

  test("retries loopback verification until host, daemon ID, and start time match the persisted descriptor", async () => {
    let currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const descriptorHealthUrl = "http://carbon:8740";
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({ repoRoot, runsRoot, gitHead: currentHead, healthUrl: descriptorHealthUrl })],
    ]);
    const fetchRequests: string[] = [];
    let loopbackResponses = 0;
    let sleepCalls = 0;

    const result = await runSelfUpgrade(
      {
        host: "carbon",
        authToken: "secret-token",
      },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "carbon",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [...descriptors.values()],
        readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
        writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
          descriptors.set(next.daemon_id, next);
          return path.join(root, `${next.daemon_id}.json`);
        }),
        execGit: async (args: string[]) => {
          if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
          if (args[0] === "pull") {
            currentHead = "cccccccccccccccccccccccccccccccccccccccc";
            return { code: 0, stdout: "updated\n", stderr: "" };
          }
          if (args[0] === "log") return { code: 0, stdout: "abc123 POL-1163 test commit\n", stderr: "" };
          return { code: 0, stdout: args[1] === "HEAD" ? `${currentHead}\n` : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
        },
        runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
        prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
        createRunService: () => createRunServiceStub([]),
        createSupervisorAdapter: () => ({
          kind: "direct",
          stop: async () => ({ signal: "SIGTERM", forced: false }),
          start: async () => {
            descriptors.set("run-serve", makeDescriptor({
              repoRoot,
              runsRoot,
              gitHead: currentHead,
              healthUrl: descriptorHealthUrl,
              pid: 5150,
              argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
            }));
            return { pid: 5150 };
          },
          status: async () => ({ running: true, pid: 5150 }),
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async (input) => {
          const request = String(input);
          fetchRequests.push(request);
          if (new URL(request).hostname !== "127.0.0.1") {
            throw new TypeError("fetch failed");
          }
          loopbackResponses += 1;
          if (loopbackResponses === 1) return daemonHealthResponse(currentHead, "blade");
          if (loopbackResponses === 2) return daemonHealthResponse(currentHead, null);
          if (loopbackResponses === 3) return daemonHealthResponse(currentHead, "carbon", { daemonId: "other-daemon" });
          if (loopbackResponses === 4) return daemonHealthResponse(currentHead, "carbon", { startedAt: "2026-04-20T00:00:01.000Z" });
          return daemonHealthResponse(currentHead, "carbon");
        })),
        sleep: async () => {
          sleepCalls += 1;
        },
      },
    );

    expect(result.status).toBe("succeeded");
    expect(sleepCalls).toBeGreaterThanOrEqual(4);
    expect(fetchRequests).toEqual([
      "http://carbon:8740/v1/admin/health",
      "http://127.0.0.1:8740/v1/admin/health",
      "http://carbon:8740/v1/admin/health",
      "http://127.0.0.1:8740/v1/admin/health",
      "http://carbon:8740/v1/admin/health",
      "http://127.0.0.1:8740/v1/admin/health",
      "http://carbon:8740/v1/admin/health",
      "http://127.0.0.1:8740/v1/admin/health",
      "http://carbon:8740/v1/admin/health",
      "http://127.0.0.1:8740/v1/admin/health",
    ]);
  });

  test("does not classify a received HTTP response as a fetch failure from server-controlled wording", () => {
    expect(isFetchTransportError(new Error("HTTP 503: fetch failed while processing the request")))
      .toBe(false);
    expect(isFetchTransportError(new TypeError("fetch failed"))).toBe(true);
  });

  test("retries when daemon health is reachable before the restarted descriptor is persisted", async () => {
    let currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let descriptorMissingOnce = false;
    let sleepCalls = 0;
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({
        repoRoot,
        runsRoot,
        gitHead: currentHead,
        argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
      })],
    ]);

    const result = await runSelfUpgrade(
      {
        host: "blade",
        authToken: "secret-token",
      },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [...descriptors.values()],
        readDescriptor: async (daemonId: string) => {
          if (descriptorMissingOnce) {
            descriptorMissingOnce = false;
            return undefined;
          }
          return descriptors.get(daemonId);
        },
        writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
          descriptors.set(next.daemon_id, next);
          return path.join(root, `${next.daemon_id}.json`);
        }),
        execGit: async (args: string[]) => {
          if (args[0] === "status") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "pull") {
            currentHead = "cccccccccccccccccccccccccccccccccccccccc";
            return { code: 0, stdout: "updated\n", stderr: "" };
          }
          if (args[0] === "log") {
            return { code: 0, stdout: "abc123 POL-1786 descriptor retry regression\n", stderr: "" };
          }
          return { code: 0, stdout: args[1] === "HEAD" ? `${currentHead}\n` : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
        },
        runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
        prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
        createRunService: () => createRunServiceStub([]),
        createSupervisorAdapter: () => ({
          kind: "direct",
          stop: async () => ({ signal: "SIGTERM", forced: false }),
          start: async () => {
            descriptors.set("run-serve", makeDescriptor({
              repoRoot,
              runsRoot,
              gitHead: currentHead,
              pid: 5150,
              argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
            }));
            descriptorMissingOnce = true;
            return { pid: 5150 };
          },
          status: async () => ({ running: true, pid: 5150 }),
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async () => daemonHealthResponse(currentHead))),
        sleep: async () => {
          sleepCalls += 1;
        },
      },
    );

    expect(result.status).toBe("succeeded");
    expect(result.receipt?.rollback).toBeUndefined();
    expect(result.receipt?.after_builds.at(0)?.build?.git_head).toBe("cccccccccccccccccccccccccccccccccccccccc");
    expect(sleepCalls).toBeGreaterThanOrEqual(1);
  });

  test("build failure leaves the daemon running and uncordons", async () => {
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({ repoRoot, runsRoot })],
    ]);
    const stopSpy = vi.fn(async () => ({ signal: "SIGTERM", forced: false }));
    const observedPhases: SelfUpgradePhaseEvent[] = [];

    let thrown: unknown;
    try {
      await runSelfUpgrade(
        {
          host: "blade",
          authToken: "secret-token",
        },
        {
          homeDir: () => homeRoot,
          onPhase: (event) => observedPhases.push(event),
          appendEventProjection: async () => {
            throw new Error("event log unavailable");
          },
          eventProjectionSettleTimeoutMs: 0,
          claimOperation: vi.fn(async () => {
            throw new Error("operation projection unavailable");
          }),
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [...descriptors.values()],
          readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
          writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
            descriptors.set(next.daemon_id, next);
            return "";
          }),
          execGit: async (args: string[]) => {
            if (args[0] === "status") {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "pull") {
              return { code: 0, stdout: "updated\n", stderr: "" };
            }
            return { code: 0, stdout: args[1] === "HEAD" ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
          },
          runBuild: async () => ({ code: 1, stdout: "", stderr: "build exploded" }),
          writeReceipt: async () => {
            throw Object.assign(new Error("injected receipt fsync failure"), { code: "EIO" });
          },
          createRunService: () => createRunServiceStub([]),
          createSupervisorAdapter: () => ({
            kind: "direct",
            stop: stopSpy,
            start: async () => ({ pid: 5150 }),
            status: async () => ({ running: true, pid: 5150 }),
          }),
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Build failed");
    expect(thrown).not.toHaveProperty("receipt_path");
    expect(thrown).toHaveProperty("receipt.durability_issues", [
      expect.objectContaining({
        scope: "final_receipt",
        code: "receipt_persist_failed",
        message: "injected receipt fsync failure",
      }),
    ]);
    expect(thrown).toHaveProperty("projection_issues", [
      expect.objectContaining({
        scope: "operation_state",
        code: "projection_unavailable",
        message: expect.stringContaining("operation projection unavailable"),
      }),
    ]);
    expect(stopSpy).not.toHaveBeenCalled();
    expect(descriptors.get("run-serve")?.maintenance_mode).toBe(false);
    expect(observedPhases.map((event) => event.control.phase)).toEqual(["fetch", "build"]);
  });

  test("build failure drops generic child output and appends cleanup residue without rewriting the outcome", async () => {
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({ repoRoot, runsRoot })],
    ]);
    const parentCanary = "generic-parent-canary";
    const childCanary = "generic-child-output-canary";
    const cleanupBootstrapSandbox = vi.fn(async () => ({ status: "residue" as const }));
    const localWarnings: string[] = [];
    const statusProjectionStream = new Writable({
      write(chunk, _encoding, callback) {
        localWarnings.push(String(chunk));
        callback();
      },
    });
    let bootstrapChildEnv: NodeJS.ProcessEnv | undefined;
    const spawnBootstrapChild = vi.fn(async (_command: string, _args: readonly string[], options: {
      env: NodeJS.ProcessEnv;
      captureOutput?: boolean;
    }) => {
      bootstrapChildEnv = options.env;
      expect(options.captureOutput).toBe(false);
      return {
        code: 1,
        stdout: childCanary,
        stderr: childCanary,
      };
    });
    let thrown: SelfUpgradeExecutionError | undefined;
    try {
      await runSelfUpgrade(
        { host: "blade", authToken: "secret-token" },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [...descriptors.values()],
          readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
          writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
            descriptors.set(next.daemon_id, next);
            return "";
          }),
          execGit: async (args: string[]) => {
            if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
            if (args[0] === "pull") return { code: 0, stdout: "updated\n", stderr: "" };
            return {
              code: 0,
              stdout: args[1] === "HEAD"
                ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
                : "cccccccccccccccccccccccccccccccccccccccc\n",
              stderr: "",
            };
          },
          bootstrapEnv: {
            PATH: "/fixture/bin:/usr/bin:/bin",
            LANG: "C.UTF-8",
            TZ: "UTC",
            HOME: "/host/home",
            XDG_CONFIG_HOME: "/host/config",
            TMPDIR: "/host/tmp",
            PARENT_CANARY: parentCanary,
          },
          statusProjectionStream,
          spawnBootstrapChild,
          cleanupBootstrapSandbox,
          createRunService: () => createRunServiceStub([]),
          createSupervisorAdapter: () => ({
            kind: "direct",
            stop: async () => ({ signal: "SIGTERM", forced: false }),
            start: async () => ({ pid: 5150 }),
            status: async () => ({ running: true, pid: 5150 }),
          }),
        },
      );
    } catch (error) {
      thrown = error as SelfUpgradeExecutionError;
    }

    expect(thrown).toBeDefined();
    expect(spawnBootstrapChild).toHaveBeenCalledTimes(1);
    expect(bootstrapChildEnv).toBeDefined();
    expect(Object.isFrozen(bootstrapChildEnv)).toBe(true);
    expect(bootstrapChildEnv).toMatchObject({
      PATH: "/fixture/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      TZ: "UTC",
    });
    expect(bootstrapChildEnv).not.toHaveProperty("PARENT_CANARY");
    expect(bootstrapChildEnv?.HOME).not.toBe("/host/home");
    expect(bootstrapChildEnv?.XDG_CONFIG_HOME).not.toBe("/host/config");
    expect(bootstrapChildEnv?.TMPDIR).not.toBe("/host/tmp");
    expect(thrown?.message).toContain("Build failed during install phase");
    expect(thrown?.message).not.toContain(parentCanary);
    expect(thrown?.message).not.toContain(childCanary);
    expect(JSON.stringify(thrown?.receipt)).not.toContain(parentCanary);
    expect(JSON.stringify(thrown?.receipt)).not.toContain(childCanary);
    expect(thrown?.receipt_path).toBeTruthy();
    const durableReceipt = await readFile(thrown!.receipt_path!, "utf8");
    expect(durableReceipt).not.toContain(parentCanary);
    expect(durableReceipt).not.toContain(childCanary);
    const durableEvents = await readFile(path.join(runsRoot, "events.index.jsonl"), "utf8");
    expect(durableEvents).not.toContain(parentCanary);
    expect(durableEvents).not.toContain(childCanary);
    const operation = await observeSelfUpgradeOperation(
      defaultSelfUpgradeOperationRoot(homeRoot),
      thrown!.receipt!.operation_id!,
    );
    expect(JSON.stringify(operation)).not.toContain(parentCanary);
    expect(JSON.stringify(operation)).not.toContain(childCanary);
    expect(cleanupBootstrapSandbox).toHaveBeenCalledTimes(1);
    expect(localWarnings.join("")).toContain(
      "best-effort local self-upgrade cleanup left residue",
    );
    expect(thrown?.projection_issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: "operation_cleanup",
        code: "best_effort_cleanup",
        detail: "residue",
        message: expect.stringContaining("left residue"),
      }),
    ]));
    expect(thrown?.exitCode).toBe(6);
    expect(JSON.stringify(thrown?.receipt)).not.toContain("bootstrap_sandbox");
    expect(durableReceipt).not.toContain("bootstrap_sandbox");
    expect(durableEvents).not.toContain("bootstrap_sandbox");
    expect(JSON.stringify(operation)).not.toContain("bootstrap_sandbox");
    expect(JSON.stringify(thrown?.receipt)).not.toContain("operation_cleanup");
    expect(durableReceipt).not.toContain("operation_cleanup");
    expect(durableEvents).not.toContain("operation_cleanup");
    expect(JSON.stringify(operation)).not.toContain("operation_cleanup");
    await expect(access(path.dirname(bootstrapChildEnv!.HOME!))).resolves.toBeUndefined();
  });

  test("prepare failure routes package-manager and executable verification through the same frozen child environment", async () => {
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({ repoRoot, runsRoot })],
    ]);
    const parentCanary = "generic-parent-canary";
    const childCanary = "generic-child-output-canary";
    let prepareEnvironment: NodeJS.ProcessEnv | undefined;
    const spawnBootstrapChild = vi.fn(async (_command: string, args: readonly string[], options: {
      env: NodeJS.ProcessEnv;
      captureOutput?: boolean;
      maxCaptureBytes?: number;
    }) => {
      if (args.at(-1) === "--version") {
        return {
          code: 0,
          // The first line is the one allowable typed observation; the tail
          // is hostile raw child output and must not reach a receipt.
          stdout: `0.2.0\n${childCanary}`,
          stderr: childCanary,
          ...(options.captureOutput === false ? {} : { stdout_truncated: true }),
        };
      }
      return {
        code: 23,
        stdout: childCanary,
        stderr: childCanary,
        ...(options.captureOutput === false ? {} : { stdout_truncated: true }),
      };
    });
    const prepareInstall = vi.fn(async (options: Parameters<typeof prepareVersionedInstall>[0]) => {
      prepareEnvironment = options.env;
      expect(options.runPackageManagerCommand).toBeTypeOf("function");
      expect(options.runVerificationCommand).toBeTypeOf("function");
      const verified = await options.runVerificationCommand!(
        process.execPath,
        ["/private/install/calyx", "--version"],
        options.repoRoot,
        options.env!,
      );
      expect(verified).toEqual({ code: 0, version: "0.2.0" });
      const result = await options.runPackageManagerCommand!(
        "pnpm",
        ["install", "--prod", "--ignore-scripts", "--prefer-offline"],
        options.repoRoot,
        options.env!,
      );
      expect(result).toEqual({ code: 23 });
      throw new Error(`pnpm install failed for versioned install (exit ${result.code}).`);
    });
    let thrown: SelfUpgradeExecutionError | undefined;
    try {
      await runSelfUpgrade(
        { host: "blade", authToken: "secret-token" },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [...descriptors.values()],
          readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
          writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
            descriptors.set(next.daemon_id, next);
            return "";
          }),
          execGit: async (args: string[]) => {
            if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
            if (args[0] === "pull") return { code: 0, stdout: "updated\n", stderr: "" };
            return {
              code: 0,
              stdout: args[1] === "HEAD"
                ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
                : "cccccccccccccccccccccccccccccccccccccccc\n",
              stderr: "",
            };
          },
          bootstrapEnv: {
            PATH: "/fixture/bin:/usr/bin:/bin",
            LANG: "C.UTF-8",
            TZ: "UTC",
            HOME: "/host/home",
            XDG_CONFIG_HOME: "/host/config",
            TMPDIR: "/host/tmp",
            PARENT_CANARY: parentCanary,
          },
          runBuild: async () => ({ code: 0 }),
          prepareInstall,
          spawnBootstrapChild,
          createRunService: () => createRunServiceStub([]),
          createSupervisorAdapter: () => ({
            kind: "direct",
            stop: async () => ({ signal: "SIGTERM", forced: false }),
            start: async () => ({ pid: 5150 }),
            status: async () => ({ running: true, pid: 5150 }),
          }),
        },
      );
    } catch (error) {
      thrown = error as SelfUpgradeExecutionError;
    }

    expect(thrown?.message).toBe("pnpm install failed for versioned install (exit 23).");
    expect(prepareInstall).toHaveBeenCalledTimes(1);
    expect(spawnBootstrapChild).toHaveBeenCalledTimes(2);
    const verifierCall = spawnBootstrapChild.mock.calls.find(([, args]) => args.at(-1) === "--version");
    const packageManagerCall = spawnBootstrapChild.mock.calls.find(([command]) => command === "pnpm");
    expect(verifierCall?.[2]).toMatchObject({ captureOutput: true, maxCaptureBytes: 512 });
    expect(packageManagerCall?.[2]).toMatchObject({ captureOutput: false });
    expect(prepareEnvironment).toBeDefined();
    expect(Object.isFrozen(prepareEnvironment)).toBe(true);
    expect(verifierCall?.[2]?.env).toBe(prepareEnvironment);
    expect(packageManagerCall?.[2]?.env).toBe(prepareEnvironment);
    expect(prepareEnvironment).not.toHaveProperty("PARENT_CANARY");
    expect(JSON.stringify(thrown?.receipt)).not.toContain(parentCanary);
    expect(JSON.stringify(thrown?.receipt)).not.toContain(childCanary);
    expect(thrown?.receipt_path).toBeTruthy();
    const durableReceipt = await readFile(thrown!.receipt_path!, "utf8");
    expect(durableReceipt).not.toContain(parentCanary);
    expect(durableReceipt).not.toContain(childCanary);
  });

  test("respects the drain deadline for healthy non-resumable runs", async () => {
    const descriptor = makeDescriptor({ repoRoot, runsRoot });
    let monotonicMs = 0;
    let sleepCalls = 0;
    const activeRuns: StubActiveRun[] = [{
      run_id: "run-1",
      state: "running",
      resumable: false,
      health_status: "healthy" as const,
      summary: "still running",
    }];

    const outcome = await runSelfUpgrade(
        {
          host: "blade",
          authToken: "secret-token",
          drainDeadlineMs: 5_000,
        },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [descriptor],
          readDescriptor: async () => descriptor,
          writeDescriptor: vi.fn(async () => ""),
          execGit: async (args: string[]) => {
            if (args[0] === "status") {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "pull") {
              return { code: 0, stdout: "updated\n", stderr: "" };
            }
            return { code: 0, stdout: args[1] === "HEAD" ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
          },
          runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
          prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
          createRunService: () => createRunServiceStub(activeRuns),
          createSupervisorAdapter: () => ({
            kind: "direct",
            stop: async () => ({ signal: "SIGTERM", forced: false }),
            start: async () => ({ pid: 5150 }),
            status: async () => ({ running: true, pid: 5150 }),
          }),
          monotonicNowMs: () => monotonicMs,
          sleep: async (ms: number) => {
            expect(ms).toBe(1_000);
            sleepCalls += 1;
            monotonicMs += ms;
          },
        },
      ).catch((error: unknown) => error as SelfUpgradeExecutionError);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as SelfUpgradeExecutionError).message).toContain("drain deadline");
    expect((outcome as SelfUpgradeExecutionError).receipt?.drain_duration_ms).toBe(5_000);
    expect(sleepCalls).toBe(5);
    expect(monotonicMs).toBe(5_000);
  });

  test.each<[string, () => number]>([
    ["stalls", () => 0],
    ["is non-finite", () => Number.NaN],
    ["throws", () => { throw new Error("broken test clock"); }],
  ])("bounds drain polling and writes a finite receipt when the semantic clock %s", async (_label, monotonicNowMs) => {
    const descriptor = makeDescriptor({ repoRoot, runsRoot });
    let sleepCalls = 0;
    const activeRuns: StubActiveRun[] = [{
      run_id: "run-1",
      state: "running",
      resumable: false,
      health_status: "healthy" as const,
      summary: "still running",
    }];

    const outcome = await runSelfUpgrade(
      {
        host: "blade",
        authToken: "secret-token",
        drainDeadlineMs: 5_000,
      },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [descriptor],
        readDescriptor: async () => descriptor,
        writeDescriptor: vi.fn(async () => ""),
        execGit: async (args: string[]) => {
          if (args[0] === "status") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "pull") {
            return { code: 0, stdout: "updated\n", stderr: "" };
          }
          return { code: 0, stdout: args[1] === "HEAD" ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
        },
        runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
        prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
        createRunService: () => createRunServiceStub(activeRuns),
        createSupervisorAdapter: () => ({
          kind: "direct",
          stop: async () => ({ signal: "SIGTERM", forced: false }),
          start: async () => ({ pid: 5150 }),
          status: async () => ({ running: true, pid: 5150 }),
        }),
        monotonicNowMs,
        sleep: async (ms: number) => {
          expect(ms).toBe(1_000);
          sleepCalls += 1;
        },
      },
    ).catch((error: unknown) => error as SelfUpgradeExecutionError);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as SelfUpgradeExecutionError).message).toContain("drain deadline");
    expect((outcome as SelfUpgradeExecutionError).receipt?.drain_duration_ms).toBe(0);
    expect(Number.isFinite((outcome as SelfUpgradeExecutionError).receipt?.drain_duration_ms)).toBe(true);
    expect(sleepCalls).toBe(5);
  });

  test("the default transparent update preserves a restart-safe run without draining (POL-2048)", async () => {
    let currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let monotonicMs = 0;
    await materializeInstallFixture(homeRoot, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({
        repoRoot,
        runsRoot,
        gitHead: currentHead,
        argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
      })],
    ]);
    // Shared stub so reconcile call-count reflects the whole upgrade: a skipped
    // drain wait means only buildPlan + the drain-phase collect run reconcile.
    const stub = createRunServiceStub([{
      run_id: "run-1",
      state: "running",
      resumable: false,
      health_status: "healthy" as const,
      summary: "detached worker still running",
      readopt_safe: true,
    }]);

    const result = await runSelfUpgrade(
      {
        host: "blade",
        authToken: "secret-token",
        // A zero drain deadline + no-op sleep would make any drain wait throw
        // immediately, so a clean success proves the wait was skipped.
        drainDeadlineMs: 0,
      },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [...descriptors.values()],
        readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
        writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
          descriptors.set(next.daemon_id, next);
          return path.join(root, `${next.daemon_id}.json`);
        }),
        execGit: async (args: string[]) => {
          if (args[0] === "status") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "pull") {
            currentHead = "cccccccccccccccccccccccccccccccccccccccc";
            return { code: 0, stdout: "updated\n", stderr: "" };
          }
          if (args[0] === "log") {
            return { code: 0, stdout: "abc123 POL-2048 transparent update\n", stderr: "" };
          }
          return { code: 0, stdout: args[1] === "HEAD" ? `${currentHead}\n` : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
        },
        runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
        prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
        createRunService: () => stub,
        createSupervisorAdapter: () => ({
          kind: "direct",
          stop: async () => ({ signal: "SIGTERM", forced: false }),
          start: async () => {
            // Receipt drain timing must already be frozen. Make every later
            // restart/health phase visibly expensive on the semantic clock.
            monotonicMs = 10_000;
            descriptors.set("run-serve", makeDescriptor({
              repoRoot,
              runsRoot,
              gitHead: currentHead,
              pid: 5150,
              argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
            }));
            return { pid: 5150 };
          },
          status: async () => ({ running: true, pid: 5150 }),
        }),
        // Health proves the active count and capability; the privileged run
        // collection proves the exact re-adopted identity.
        createAdminClient: createAdminClientFactory(vi.fn(async (input) => new URL(String(input)).pathname === "/v1/admin/runs"
          ? adminRunsResponse(["run-1"])
          : readoptHealthResponse(currentHead, { withFlag: true, activeRuns: 1 }))),
        monotonicNowMs: () => monotonicMs,
        sleep: async () => {},
      },
    );

    expect(result.status).toBe("succeeded");
    expect(result.receipt?.drain_mode).toBe("continuous");
    expect(result.receipt?.readopted_run_ids).toEqual(["run-1"]);
    expect(result.receipt?.drain_duration_ms).toBe(0);
    expect(monotonicMs).toBe(10_000);
    expect(result.receipt?.active_run_classification.at(0)).toMatchObject({
      run_id: "run-1",
      restart_safe: true,
    });
    // buildPlan + drain-phase collect + the wait helper's initial snapshot;
    // no polling reconcile occurs because only the preserved run remains.
    expect(stub.reconcile).toHaveBeenCalledTimes(3);
  }, 20_000);

  test("mixed run set: the default preserves the proven-safe run while the unproven run drains first (POL-2048)", async () => {
    let currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await materializeInstallFixture(homeRoot, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({
        repoRoot,
        runsRoot,
        gitHead: currentHead,
        argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
      })],
    ]);
    // One classifier-proven restart-safe worker plus one healthy-but-unproven
    // run. The default must drain ONLY the unproven run, then preserve the
    // proven one — the per-run partition that is the whole point of the flip.
    const fixtureRuns = [
      {
        run_id: "run-safe",
        state: "running" as const,
        resumable: false,
        health_status: "healthy" as const,
        summary: "detached worker still running",
        readopt_safe: true,
      },
      {
        run_id: "run-unsafe",
        state: "running" as const,
        resumable: false,
        health_status: "healthy" as const,
        summary: "inline worker finishing up",
        readopt_safe: false,
      },
    ];
    const stub = createRunServiceStub(fixtureRuns);
    let sleepCalls = 0;

    const result = await runSelfUpgrade(
      {
        host: "blade",
        authToken: "secret-token",
        drainDeadlineMs: 60_000,
      },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [...descriptors.values()],
        readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
        writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
          descriptors.set(next.daemon_id, next);
          return path.join(root, `${next.daemon_id}.json`);
        }),
        execGit: async (args: string[]) => {
          if (args[0] === "status") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "pull") {
            currentHead = "cccccccccccccccccccccccccccccccccccccccc";
            return { code: 0, stdout: "updated\n", stderr: "" };
          }
          if (args[0] === "log") {
            return { code: 0, stdout: "abc123 POL-2048 transparent update\n", stderr: "" };
          }
          return { code: 0, stdout: args[1] === "HEAD" ? `${currentHead}\n` : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
        },
        runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
        prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
        createRunService: () => stub,
        createSupervisorAdapter: () => ({
          kind: "direct",
          stop: async () => ({ signal: "SIGTERM", forced: false }),
          start: async () => {
            descriptors.set("run-serve", makeDescriptor({
              repoRoot,
              runsRoot,
              gitHead: currentHead,
              pid: 5150,
              argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
            }));
            return { pid: 5150 };
          },
          status: async () => ({ running: true, pid: 5150 }),
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async (input) => new URL(String(input)).pathname === "/v1/admin/runs"
          ? adminRunsResponse(["run-safe"])
          : readoptHealthResponse(currentHead, { withFlag: true, activeRuns: 1 }))),
        monotonicNowMs: () => 0,
        sleep: async () => {
          // The unproven run finishes during the drain wait's first poll gap.
          sleepCalls += 1;
          const unsafeIndex = fixtureRuns.findIndex((run) => run.run_id === "run-unsafe");
          if (unsafeIndex >= 0) {
            fixtureRuns.splice(unsafeIndex, 1);
          }
        },
      },
    );

    expect(result.status).toBe("succeeded");
    // P0-1/P1-2 coverage: the PLAN reports live availability for a mixed set.
    expect(result.plan.preservation).toEqual({
      policy: "automatic",
      status: "available",
      required_features: [
        CALYX_DAEMON_FEATURES.runReadoptOnBootV1,
        CALYX_DAEMON_FEATURES.detachedWorkerIsolationV1,
      ],
      unavailable_reasons: [],
    });
    // The unproven run drained (at least one wait poll happened)...
    expect(sleepCalls).toBeGreaterThan(0);
    // ...and only the proven-safe run was preserved and re-adopted.
    expect(result.receipt?.drain_mode).toBe("continuous");
    expect(result.receipt?.readopted_run_ids).toEqual(["run-safe"]);
    expect(result.receipt?.active_run_classification.map((run) => ({
      run_id: run.run_id,
      restart_safe: run.restart_safe,
    }))).toEqual([
      { run_id: "run-safe", restart_safe: true },
      { run_id: "run-unsafe", restart_safe: false },
    ]);
  }, 20_000);

  test("--force --abort-runs plan reports preservation disabled instead of promising availability (POL-2048)", async () => {
    const descriptor = makeDescriptor({ repoRoot, runsRoot });
    const descriptors = new Map([[descriptor.daemon_id, descriptor]]);
    const healthProbe = vi.fn(async () => readoptHealthResponse("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { withFlag: true, activeRuns: 1 }));

    const result = await runSelfUpgrade(
      {
        host: "blade",
        dryRun: true,
        force: true,
        abortRuns: true,
        authToken: "secret-token",
      },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [...descriptors.values()],
        readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
        writeDescriptor: vi.fn(),
        execGit: async (args: string[]) => {
          if (args[0] === "status") {
            return { code: 0, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: args[1] === "HEAD" ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", stderr: "" };
        },
        createRunService: () => createRunServiceStub([{
          run_id: "run-safe",
          state: "running",
          resumable: false,
          health_status: "healthy" as const,
          summary: "detached worker still running",
          readopt_safe: true,
        }]),
        createAdminClient: createAdminClientFactory(healthProbe),
      },
    );

    expect(result.status).toBe("dry-run");
    // The explicit interrupt path aborts restart-safe runs too, so the plan
    // must not promise preservation (review P2-3), and the pointless feature
    // probe is skipped entirely.
    expect(result.plan.preservation).toEqual({
      policy: "abort_runs",
      status: "disabled",
      required_features: [
        CALYX_DAEMON_FEATURES.runReadoptOnBootV1,
        CALYX_DAEMON_FEATURES.detachedWorkerIsolationV1,
      ],
      unavailable_reasons: [],
      note: "disabled by --force --abort-runs",
    });
    expect(healthProbe).not.toHaveBeenCalled();
    expect(formatSelfUpgradePlan(result.plan)).toContain("note: disabled by --force --abort-runs");
  }, 20_000);

  test("default preservation loopback fallback rejects a same-host foreign daemon before accepting re-adoption", async () => {
    let currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const descriptorHealthUrl = "http://carbon:8740/calyx/control/";
    let fallbackHealthCalls = 0;
    let sleepCalls = 0;
    const fetchRequests: string[] = [];
    await materializeInstallFixture(homeRoot, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({
        repoRoot,
        runsRoot,
        gitHead: currentHead,
        healthUrl: descriptorHealthUrl,
        argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
      })],
    ]);
    const stub = createRunServiceStub([{
      run_id: "run-1",
      state: "running",
      resumable: false,
      health_status: "healthy" as const,
      summary: "detached worker still running",
      readopt_safe: true,
    }]);

    const result = await runSelfUpgrade(
      {
        host: "carbon",
        authToken: "secret-token",
        drainDeadlineMs: 0,
      },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "carbon",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [...descriptors.values()],
        readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
        writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
          descriptors.set(next.daemon_id, next);
          return path.join(root, `${next.daemon_id}.json`);
        }),
        execGit: async (args: string[]) => {
          if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
          if (args[0] === "pull") {
            currentHead = "cccccccccccccccccccccccccccccccccccccccc";
            return { code: 0, stdout: "updated\n", stderr: "" };
          }
          if (args[0] === "log") return { code: 0, stdout: "abc123 POL-1163 fallback identity\n", stderr: "" };
          return { code: 0, stdout: args[1] === "HEAD" ? `${currentHead}\n` : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
        },
        runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
        prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
        createRunService: () => stub,
        createSupervisorAdapter: () => ({
          kind: "direct",
          stop: async () => ({ signal: "SIGTERM", forced: false }),
          start: async () => {
            descriptors.set("run-serve", makeDescriptor({
              repoRoot,
              runsRoot,
              gitHead: currentHead,
              healthUrl: descriptorHealthUrl,
              pid: 5150,
              argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
            }));
            return { pid: 5150 };
          },
          status: async () => ({ running: true, pid: 5150 }),
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async (input) => {
          const request = new URL(String(input));
          fetchRequests.push(request.toString());
          if (request.pathname === "/calyx/control/v1/admin/runs") {
            if (request.hostname !== "127.0.0.1") throw new TypeError("fetch failed");
            return adminRunsResponse(["run-1"]);
          }
          if (request.hostname === "127.0.0.1") {
            fallbackHealthCalls += 1;
            return readoptHealthResponse(currentHead, {
              withFlag: true,
              activeRuns: 1,
              advertisedHost: "carbon",
              ...(fallbackHealthCalls === 1 ? { daemonId: "foreign-run-serve" } : {}),
            });
          }
          return readoptHealthResponse(currentHead, {
            withFlag: true,
            activeRuns: 1,
            advertisedHost: "carbon",
          });
        })),
        sleep: async () => {
          sleepCalls += 1;
        },
      },
    );

    expect(result.status).toBe("succeeded");
    expect(result.receipt?.readopted_run_ids).toEqual(["run-1"]);
    expect(fallbackHealthCalls).toBe(2);
    expect(sleepCalls).toBeGreaterThanOrEqual(1);
    expect(fetchRequests.map((request) => {
      const url = new URL(request);
      return `${url.hostname}${url.pathname}`;
    })).toEqual(expect.arrayContaining([
      "carbon/calyx/control/v1/admin/health",
      "carbon/calyx/control/v1/admin/runs",
      "127.0.0.1/calyx/control/v1/admin/health",
      "127.0.0.1/calyx/control/v1/admin/runs",
    ]));
    expect(fetchRequests.every((request) => new URL(request).pathname.startsWith("/calyx/control/v1/admin/")))
      .toBe(true);
  });

  test("default preservation rejects a matching active count with the wrong re-adopted run id (POL-1886)", async () => {
    let currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await materializeInstallFixture(homeRoot, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({
        repoRoot,
        runsRoot,
        gitHead: currentHead,
        argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
      })],
    ]);
    const stub = createRunServiceStub([{
      run_id: "run-1",
      state: "running",
      resumable: false,
      health_status: "healthy" as const,
      summary: "detached worker still running",
      readopt_safe: true,
    }]);
    await expect(
      runSelfUpgrade(
        {
          host: "blade",
          authToken: "secret-token",
          drainDeadlineMs: 0,
        },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [...descriptors.values()],
          readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
          writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
            descriptors.set(next.daemon_id, next);
            return path.join(root, `${next.daemon_id}.json`);
          }),
          execGit: async (args: string[]) => {
            if (args[0] === "status") {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "pull") {
              currentHead = "cccccccccccccccccccccccccccccccccccccccc";
              return { code: 0, stdout: "updated\n", stderr: "" };
            }
            if (args[0] === "log") {
              return { code: 0, stdout: "abc123 POL-2048 transparent update\n", stderr: "" };
            }
            return { code: 0, stdout: args[1] === "HEAD" ? `${currentHead}\n` : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
          },
          runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
          prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
          createRunService: () => stub,
          createSupervisorAdapter: () => ({
            kind: "direct",
            stop: async () => ({ signal: "SIGTERM", forced: false }),
            start: async () => {
              descriptors.set("run-serve", makeDescriptor({
                repoRoot,
                runsRoot,
                gitHead: currentHead,
                pid: 5150,
                argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
              }));
              return { pid: 5150 };
            },
            status: async () => ({ running: true, pid: 5150 }),
          }),
          // Same count as expected, wrong identity: count-only verification would
          // pass here, but preservation must prove the exact skipped-drain run.
          createAdminClient: createAdminClientFactory(vi.fn(async (input) => {
            if (new URL(String(input)).pathname === "/v1/admin/runs") {
              return adminRunsResponse(["run-other"]);
            }
            return readoptHealthResponse(currentHead, { withFlag: true, activeRuns: 1 });
          })),
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow("expected active_run_ids=run-1, got run-other");
  });

  test("--drain-all drains a restart-safe run even when the daemon proves preservation support (POL-2048)", async () => {
    // Explicit drain-all overrides both capability proof and per-run restart
    // safety. A zero deadline therefore proves that the wait path was entered.
    const descriptor = makeDescriptor({ repoRoot, runsRoot });
    const stub = createRunServiceStub([{
      run_id: "run-1",
      state: "running",
      resumable: false,
      health_status: "healthy" as const,
      summary: "detached worker still running",
      readopt_safe: true,
    }]);

    await expect(
      runSelfUpgrade(
        { host: "blade", authToken: "secret-token", drainAll: true, drainDeadlineMs: 0 },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [descriptor],
          readDescriptor: async () => descriptor,
          writeDescriptor: vi.fn(async () => ""),
          execGit: async (args: string[]) => {
            if (args[0] === "status") {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "pull") {
              return { code: 0, stdout: "updated\n", stderr: "" };
            }
            return { code: 0, stdout: args[1] === "HEAD" ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
          },
          runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
          prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
          createRunService: () => stub,
          createSupervisorAdapter: () => ({
            kind: "direct",
            stop: async () => ({ signal: "SIGTERM", forced: false }),
            start: async () => ({ pid: 5150 }),
            status: async () => ({ running: true, pid: 5150 }),
          }),
          // The daemon proves both preservation features, so only --drain-all
          // can force this restart-safe run through the wait path.
          createAdminClient: createAdminClientFactory(vi.fn(async () => readoptHealthResponse("cccccccccccccccccccccccccccccccccccccccc", { withFlag: true, activeRuns: 1 }))),
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow("drain deadline");
  });

  test("reports preservation unavailable and drains when required daemon features are absent (POL-2048)", async () => {
    const previousHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let runningHead = previousHead;
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({
        repoRoot,
        runsRoot,
        gitHead: runningHead,
        argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
      })],
    ]);
    let monotonicMs = 0;
    let rollbackRestarted = false;
    await materializeInstallFixture(homeRoot, previousHead);
    const stub = createRunServiceStub([{
      run_id: "run-1",
      state: "running",
      resumable: false,
      health_status: "healthy" as const,
      summary: "detached worker still running",
      readopt_safe: true,
    }]);

    const outcome = await runSelfUpgrade(
        {
          host: "blade",
          authToken: "secret-token",
          drainDeadlineMs: 0,
        },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [...descriptors.values()],
          readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
          writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
            descriptors.set(next.daemon_id, next);
            return path.join(root, `${next.daemon_id}.json`);
          }),
          execGit: async (args: string[]) => {
            if (args[0] === "status") {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "pull") {
              return { code: 0, stdout: "updated\n", stderr: "" };
            }
            return { code: 0, stdout: args[1] === "HEAD" ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
          },
          runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
          prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
          createRunService: () => stub,
          createSupervisorAdapter: () => ({
            kind: "direct",
            stop: async () => ({ signal: "SIGTERM", forced: false }),
            start: async () => {
              // A pre-promotion drain failure must never reach restart.
              monotonicMs = 10_000;
              rollbackRestarted = true;
              runningHead = previousHead;
              descriptors.set("run-serve", makeDescriptor({
                repoRoot,
                runsRoot,
                gitHead: runningHead,
                pid: 5150,
                argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
              }));
              return { pid: 5150 };
            },
            status: async () => ({ running: true, pid: 5150 }),
          }),
          // Missing feature proof makes preservation unavailable even though
          // the run is restart-safe, so the update falls back to drain-and-wait.
          createAdminClient: createAdminClientFactory(vi.fn(async () => readoptHealthResponse(
            runningHead,
            { withFlag: false, activeRuns: rollbackRestarted ? 0 : 1 },
          ))),
          monotonicNowMs: () => monotonicMs,
          sleep: async () => {},
        },
      ).catch((error: unknown) => error as SelfUpgradeExecutionError);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as SelfUpgradeExecutionError).message).toContain("drain deadline");
    expect((outcome as SelfUpgradeExecutionError).receipt?.drain_duration_ms).toBe(0);
    expect((outcome as SelfUpgradeExecutionError).receipt?.rollback).toBeUndefined();
    expect((outcome as SelfUpgradeExecutionError).plan?.preservation).toMatchObject({
      policy: "automatic",
      status: "unavailable",
      required_features: [
        CALYX_DAEMON_FEATURES.runReadoptOnBootV1,
        CALYX_DAEMON_FEATURES.detachedWorkerIsolationV1,
      ],
      unavailable_reasons: [expect.stringContaining(CALYX_DAEMON_FEATURES.runReadoptOnBootV1)],
    });
    expect((outcome as SelfUpgradeExecutionError).plan?.preservation.unavailable_reasons.join(" "))
      .toContain(CALYX_DAEMON_FEATURES.detachedWorkerIsolationV1);
    expect(formatSelfUpgradePlan((outcome as SelfUpgradeExecutionError).plan!))
      .toContain("status: unavailable");
    expect(rollbackRestarted).toBe(false);
    expect(monotonicMs).toBe(0);
  });

  test("a non-restart-safe run still blocks in preservation-capable conditions unless --force --abort-runs (POL-1886)", async () => {
    const descriptor = makeDescriptor({ repoRoot, runsRoot });
    // A resumable run is never restart-safe (blocking_resumable category).
    const resumableRuns: StubActiveRun[] = [{
      run_id: "run-resumable",
      state: "running",
      resumable: true,
      health_status: "healthy" as const,
      summary: "resumable run",
      readopt_reason: "inline_worker",
    }];

    const stub = createRunServiceStub(resumableRuns);
    const buildDeps = () => ({
      homeDir: () => homeRoot,
      acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
      resolveCurrentHostAlias: async () => "blade",
      resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
      resolveRepo: async () => repoRoot,
      listDescriptors: async () => [descriptor],
      readDescriptor: async () => descriptor,
      writeDescriptor: vi.fn(async () => ""),
      execGit: async (args: string[]) => {
        if (args[0] === "status") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "pull") {
          return { code: 0, stdout: "updated\n", stderr: "" };
        }
        return { code: 0, stdout: args[1] === "HEAD" ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
      },
      runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
      prepareInstall: vi.fn(async ({ gitHead }: { gitHead: string }) => prepareInstallFixture(homeRoot, gitHead)),
      createRunService: () => stub,
      createSupervisorAdapter: () => ({
        kind: "direct" as const,
        stop: async () => ({ signal: "SIGTERM", forced: false }),
        start: async () => ({ pid: 5150 }),
        status: async () => ({ running: true, pid: 5150 }),
      }),
      // Daemon advertises boot re-adopt, but the run itself is not restart-safe.
      createAdminClient: createAdminClientFactory(vi.fn(async () => readoptHealthResponse("cccccccccccccccccccccccccccccccccccccccc", { withFlag: true, activeRuns: 0 }))),
      sleep: async () => {},
    });

    // Without --force --abort-runs the resumable run blocks the upgrade.
    await expect(
      runSelfUpgrade({ host: "blade", authToken: "secret-token", drainDeadlineMs: 0 }, buildDeps()),
    ).rejects.toThrow("Blocking active runs remain after reconcile");

    // With --force --abort-runs it bypasses the block and takes the abort+drain
    // path instead (the static stub never drains, so it stops at the deadline —
    // a different error than the blocking guard, proving the guard was passed).
    await expect(
      runSelfUpgrade(
        { host: "blade", authToken: "secret-token", drainDeadlineMs: 0, force: true, abortRuns: true },
        buildDeps(),
      ),
    ).rejects.toThrow("drain deadline");
    expect(stub.stop).toHaveBeenCalledWith("run-resumable");
  });

  test("POL-2044: the plan surfaces supervisor kind and the direct-supervisor block reason", async () => {
    const descriptor = makeDescriptor({ repoRoot, runsRoot });
    // Healthy, non-resumable — drainable on health, but a `direct` supervisor is
    // not restart-safe (silent systemd→direct fallback), so it must NOT preserve.
    const directRuns: StubActiveRun[] = [{
      run_id: "run-direct-supervisor",
      state: "running",
      resumable: false,
      health_status: "healthy" as const,
      summary: "detached worker on a direct supervisor",
      readopt_safe: false,
      readopt_reason: "unproven_supervisor_isolation:direct",
      worker_supervisor: "direct",
    }];

    const result = await runSelfUpgrade(
      { host: "blade", dryRun: true },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [descriptor],
        readDescriptor: async () => descriptor,
        writeDescriptor: vi.fn(async () => ""),
        execGit: async (args: string[]) => {
          if (args[0] === "status") {
            return { code: 0, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: args[1] === "HEAD" ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", stderr: "" };
        },
        createRunService: () => createRunServiceStub(directRuns),
      },
    );

    expect(result.status).toBe("dry-run");
    expect(result.plan.active_runs_post_reconcile.at(0)).toMatchObject({
      run_id: "run-direct-supervisor",
      restart_safe: false,
      restart_block_reason: "unproven_supervisor_isolation:direct",
      worker_supervisor: "direct",
    });
    expect(formatSelfUpgradePlan(result.plan)).toContain(
      "blocking(unproven_supervisor_isolation:direct) supervisor=direct",
    );
  });

  test("POL-2044: the default treats a direct-supervisor run as unsafe and drains it", async () => {
    // A healthy direct-supervisor run would be preserved by the pre-POL-2044
    // classifier. It must remain outside the preserved set and drain-and-wait,
    // so a zero drain deadline throws instead of skipping the drain.
    const descriptor = makeDescriptor({ repoRoot, runsRoot });
    const stub = createRunServiceStub([{
      run_id: "run-direct-supervisor",
      state: "running",
      resumable: false,
      health_status: "healthy" as const,
      summary: "detached worker on a direct supervisor",
      readopt_safe: false,
      readopt_reason: "unproven_supervisor_isolation:direct",
      worker_supervisor: "direct",
    }]);

    await expect(
      runSelfUpgrade(
        { host: "blade", authToken: "secret-token", drainDeadlineMs: 0 },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [descriptor],
          readDescriptor: async () => descriptor,
          writeDescriptor: vi.fn(async () => ""),
          execGit: async (args: string[]) => {
            if (args[0] === "status") {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "pull") {
              return { code: 0, stdout: "updated\n", stderr: "" };
            }
            return { code: 0, stdout: args[1] === "HEAD" ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" : "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
          },
          runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
          prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
          createRunService: () => stub,
          createSupervisorAdapter: () => ({
            kind: "direct",
            stop: async () => ({ signal: "SIGTERM", forced: false }),
            start: async () => ({ pid: 5150 }),
            status: async () => ({ running: true, pid: 5150 }),
          }),
          // The daemon proves preservation support; the run's direct supervisor
          // is what keeps this individual run out of the preservation set.
          createAdminClient: createAdminClientFactory(vi.fn(async () => readoptHealthResponse("cccccccccccccccccccccccccccccccccccccccc", { withFlag: true, activeRuns: 1 }))),
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow("drain deadline");
  });

  test("explicit targetSha skips per-host rev-parse and uses fetch+merge by SHA (POL-1151)", async () => {
    const explicitSha = "feedfacef00d1234567890abcdef1234567890ab";
    const advancedRemoteSha = "decafbadf00d1234567890abcdef1234567890ab";
    const gitCalls: Array<readonly string[]> = [];
    let currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({ repoRoot, runsRoot, gitHead: currentHead })],
    ]);

    const result = await runSelfUpgrade(
      {
        host: "blade",
        authToken: "secret-token",
        to: "cache/main",
        targetSha: explicitSha,
        targetEvidence: {
          original_ref: "cache/main",
          target_sha: explicitSha,
          fetch_remote: "origin",
          fetch_ref: "refs/heads/main",
        },
      },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [...descriptors.values()],
        readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
        writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
          descriptors.set(next.daemon_id, next);
          return path.join(root, `${next.daemon_id}.json`);
        }),
        execGit: async (args: string[]) => {
          gitCalls.push(args);
          if (args[0] === "status") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "rev-parse" && args[1] === "HEAD") {
            return { code: 0, stdout: `${currentHead}\n`, stderr: "" };
          }
          if (args[0] === "rev-parse" && args[1] === "FETCH_HEAD") {
            return { code: 0, stdout: `${advancedRemoteSha}\n`, stderr: "" };
          }
          if (args[0] === "fetch" && args[1] === "origin" && args[2] === "refs/heads/main") {
            // Per Greptile P1: we fetch the branch ref (not the SHA itself)
            // for compatibility with default uploadpack server policy.
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "merge-base" && args[1] === "--is-ancestor" && args[2] === explicitSha && args[3] === advancedRemoteSha) {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "merge" && args[1] === "--ff-only" && args[2] === explicitSha) {
            currentHead = explicitSha;
            return { code: 0, stdout: "Fast-forward\n", stderr: "" };
          }
          if (args[0] === "log") {
            return { code: 0, stdout: "abc123 POL-1151 test commit\n", stderr: "" };
          }
          // The conventional `git pull --ff-only origin <ref>` MUST NOT be called
          // when an explicit targetSha is supplied. The test below asserts this.
          if (args[0] === "pull") {
            return { code: 0, stdout: "should-not-have-been-called\n", stderr: "" };
          }
          // Default for any other git invocation (e.g. extra rev-parse) — return
          // the current head so the test stays focused on the fetch/merge path.
          return { code: 0, stdout: `${currentHead}\n`, stderr: "" };
        },
        runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
        prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
        createRunService: () => createRunServiceStub([]),
        createSupervisorAdapter: () => ({
          kind: "direct",
          stop: async () => ({ signal: "SIGTERM", forced: false }),
          start: async () => {
            descriptors.set("run-serve", makeDescriptor({
              repoRoot,
              runsRoot,
              gitHead: explicitSha,
              pid: 5150,
              argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
            }));
            return { pid: 5150 };
          },
          status: async () => ({ running: true, pid: 5150 }),
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async () => daemonHealthResponse(explicitSha))),
      },
    );

    expect(result.status).toBe("succeeded");
    // Plan should report the explicit SHA as target_head — no per-host
    // rev-parse needed (so origin/main rev-parse should NOT be in gitCalls).
    expect(result.plan.target_head).toBe(explicitSha);
    const revParseTargets = gitCalls
      .filter((call) => call[0] === "rev-parse")
      .map((call) => call[1]);
    // Only `rev-parse HEAD` is expected (current_head detection); no
    // `rev-parse origin/main` call should happen because targetSha was supplied.
    expect(revParseTargets).not.toContain("cache/main");
    // The fetch (by branch ref, not by SHA — Greptile P1 fix) + merge-by-sha
    // path was used; the conventional pull was NOT.
    expect(gitCalls.some((call) => call[0] === "fetch" && call[1] === "origin" && call[2] === "refs/heads/main")).toBe(true);
    expect(result.plan.target_evidence).toEqual({
      original_ref: "cache/main",
      target_sha: explicitSha,
      fetch_remote: "origin",
      fetch_ref: "refs/heads/main",
    });
    expect(result.receipt?.target_evidence).toEqual(result.plan.target_evidence);
    expect(gitCalls.some((call) => call[0] === "merge" && call[1] === "--ff-only" && call[2] === explicitSha)).toBe(true);
    expect(gitCalls.some((call) =>
      call[0] === "merge-base"
      && call[1] === "--is-ancestor"
      && call[2] === explicitSha
      && call[3] === advancedRemoteSha
    )).toBe(true);
    expect(result.receipt?.after_head).toBe(explicitSha);
    expect(gitCalls.some((call) => call[0] === "pull")).toBe(false);
    // Specifically: we did NOT pass the raw SHA to fetch (would fail on
    // servers without uploadpack.allowReachableSHA1InWant).
    expect(gitCalls.some((call) => call[0] === "fetch" && call[2] === explicitSha)).toBe(false);
  });

  test("explicit targetSha adopts a non-fast-forward clean checkout by hard reset (POL-1908)", async () => {
    const explicitSha = "facefeedf00d1234567890abcdef1234567890ab";
    const gitCalls: Array<readonly string[]> = [];
    const staleBackupRefs = Array.from({ length: 13 }, (_, index) =>
      `backup/self-upgrade/2026-06-${String(index + 1).padStart(2, "0")}T00-00-00-000Z-old-${index}`,
    );
    const deletedBackupRefs: string[] = [];
    let currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({ repoRoot, runsRoot, gitHead: currentHead })],
    ]);

    const result = await runSelfUpgrade(
      {
        host: "blade",
        authToken: "secret-token",
        targetSha: explicitSha,
      },
      {
        now: () => "2026-06-27T00:00:00.000Z",
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [...descriptors.values()],
        readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
        writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
          descriptors.set(next.daemon_id, next);
          return path.join(root, `${next.daemon_id}.json`);
        }),
        execGit: async (args: string[]) => {
          gitCalls.push(args);
          if (args[0] === "status") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "rev-parse" && args[1] === "HEAD") {
            return { code: 0, stdout: `${currentHead}\n`, stderr: "" };
          }
          if (args[0] === "rev-parse" && args[1] === "FETCH_HEAD") {
            return { code: 0, stdout: `${explicitSha}\n`, stderr: "" };
          }
          if (args[0] === "fetch" && args[1] === "origin" && args[2] === "main") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "for-each-ref" && args[1] === "--format=%(refname:short)") {
            return { code: 0, stdout: `${staleBackupRefs.join("\n")}\n`, stderr: "" };
          }
          if (args[0] === "branch" && args[1] === "-D") {
            deletedBackupRefs.push(args[2] ?? "");
            return { code: 0, stdout: `Deleted branch ${args[2]}\n`, stderr: "" };
          }
          if (args[0] === "merge" && args[1] === "--ff-only" && args[2] === explicitSha) {
            return { code: 128, stdout: "", stderr: "fatal: Not possible to fast-forward, aborting.\n" };
          }
          if (args[0] === "branch" && args[1] === "--no-track" && args[2]?.startsWith("backup/self-upgrade/")) {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "reset" && args[1] === "--hard" && args[2] === explicitSha) {
            currentHead = explicitSha;
            return { code: 0, stdout: `HEAD is now at ${explicitSha}\n`, stderr: "" };
          }
          if (args[0] === "log") {
            return { code: 0, stdout: "abc123 POL-1908 test commit\n", stderr: "" };
          }
          return { code: 0, stdout: `${currentHead}\n`, stderr: "" };
        },
        runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
        prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
        createRunService: () => createRunServiceStub([]),
        createSupervisorAdapter: () => ({
          kind: "direct",
          stop: async () => ({ signal: "SIGTERM", forced: false }),
          start: async () => {
            descriptors.set("run-serve", makeDescriptor({
              repoRoot,
              runsRoot,
              gitHead: explicitSha,
              pid: 5150,
              argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
            }));
            return { pid: 5150 };
          },
          status: async () => ({ running: true, pid: 5150 }),
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async () => daemonHealthResponse(explicitSha))),
      },
    );

    expect(result.status).toBe("succeeded");
    expect(result.plan.dirty).toBe(false);
    expect(result.plan.target_head).toBe(explicitSha);
    expect(gitCalls.some((call) => call[0] === "merge" && call[1] === "--ff-only" && call[2] === explicitSha)).toBe(true);
    const backupCall = gitCalls.find((call) => call[0] === "branch" && call[1] === "--no-track");
    expect(backupCall?.[2]).toMatch(/^backup\/self-upgrade\//);
    expect(backupCall?.[3]).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(gitCalls.some((call) => call[0] === "reset" && call[1] === "--hard" && call[2] === explicitSha)).toBe(true);
    expect(gitCalls.some((call) => call[0] === "pull")).toBe(false);
    expect(deletedBackupRefs).toEqual([staleBackupRefs[0]]);
    expect(result.receipt?.explicit_target_adoption).toMatchObject({
      mode: "hard-reset",
      target_head: explicitSha,
      fetch_head: explicitSha,
      before_reset_head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      backup_ref: backupCall?.[2],
      pruned_backup_refs: [staleBackupRefs[0]],
      pruned_superseded_backup_refs: [staleBackupRefs[0]],
    });
    expect(result.receipt?.warnings).toContain(
      `Pruned 1 superseded explicit-target backup ref(s): ${staleBackupRefs[0]}.`,
    );
    expect(result.receipt?.warnings).toContain(
      `Adopted explicit target ${explicitSha} by hard reset; previous HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa preserved at ${backupCall?.[2]}.`,
    );
  });

  test("explicit targetSha preserves recent unmerged backup refs beyond the count bound", async () => {
    const explicitSha = "dddddddddddddddddddddddddddddddddddddddd";
    const recentUnmergedRefs = Array.from({ length: 13 }, (_, index) =>
      `backup/self-upgrade/2026-06-${String(index + 10).padStart(2, "0")}T00-00-00-000Z-unmerged-${index}`,
    );
    const expiredUnmergedRef = "backup/self-upgrade/2026-05-01T00-00-00-000Z-expired-unmerged";
    const deletedBackupRefs: string[] = [];
    const gitCalls: Array<readonly string[]> = [];
    let currentHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({ repoRoot, runsRoot, gitHead: currentHead })],
    ]);

    const result = await runSelfUpgrade(
      {
        host: "blade",
        authToken: "secret-token",
        targetSha: explicitSha,
      },
      {
        now: () => "2026-06-27T00:00:00.000Z",
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [...descriptors.values()],
        readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
        writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
          descriptors.set(next.daemon_id, next);
          return path.join(root, `${next.daemon_id}.json`);
        }),
        execGit: async (args: string[]) => {
          gitCalls.push(args);
          if (args[0] === "status") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "rev-parse" && args[1] === "HEAD") {
            return { code: 0, stdout: `${currentHead}\n`, stderr: "" };
          }
          if (args[0] === "rev-parse" && args[1] === "FETCH_HEAD") {
            return { code: 0, stdout: `${explicitSha}\n`, stderr: "" };
          }
          if (args[0] === "fetch" && args[1] === "origin" && args[2] === "main") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "for-each-ref" && args[1] === "--format=%(refname:short)") {
            return { code: 0, stdout: `${[...recentUnmergedRefs, expiredUnmergedRef].join("\n")}\n`, stderr: "" };
          }
          if (args[0] === "merge-base" && args[1] === "--is-ancestor" && args[2] === explicitSha && args[3] === "FETCH_HEAD") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "merge-base" && args[1] === "--is-ancestor" && args[2]?.startsWith("backup/self-upgrade/") && args[3] === "HEAD") {
            return { code: 1, stdout: "", stderr: "" };
          }
          if (args[0] === "branch" && args[1] === "-D") {
            deletedBackupRefs.push(args[2] ?? "");
            return { code: 0, stdout: `Deleted branch ${args[2]}\n`, stderr: "" };
          }
          if (args[0] === "merge" && args[1] === "--ff-only" && args[2] === explicitSha) {
            currentHead = explicitSha;
            return { code: 0, stdout: "Fast-forward\n", stderr: "" };
          }
          if (args[0] === "log") {
            return { code: 0, stdout: "abc123 POL-1908 test commit\n", stderr: "" };
          }
          return { code: 0, stdout: `${currentHead}\n`, stderr: "" };
        },
        runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
        prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
        createRunService: () => createRunServiceStub([]),
        createSupervisorAdapter: () => ({
          kind: "direct",
          stop: async () => ({ signal: "SIGTERM", forced: false }),
          start: async () => {
            descriptors.set("run-serve", makeDescriptor({
              repoRoot,
              runsRoot,
              gitHead: explicitSha,
              pid: 5150,
              argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
            }));
            return { pid: 5150 };
          },
          status: async () => ({ running: true, pid: 5150 }),
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async () => daemonHealthResponse(explicitSha))),
      },
    );

    expect(result.status).toBe("succeeded");
    expect(deletedBackupRefs).toEqual([expiredUnmergedRef]);
    expect(deletedBackupRefs.some((ref) => recentUnmergedRefs.includes(ref))).toBe(false);
    expect(result.receipt?.explicit_target_adoption).toMatchObject({
      mode: "ff-only",
      target_head: explicitSha,
      fetch_head: explicitSha,
      pruned_backup_refs: [expiredUnmergedRef],
      pruned_expired_unmerged_backup_refs: [expiredUnmergedRef],
    });
    expect(result.receipt?.explicit_target_adoption).not.toHaveProperty("pruned_superseded_backup_refs");
    expect(result.receipt?.warnings).toContain(
      `Pruned 1 expired unmerged explicit-target backup ref(s) after the 30-day recovery window; commits may become unrecoverable after git gc: ${expiredUnmergedRef}.`,
    );
  });

  test("explicit targetSha preserves refs when backup prune classification or deletion fails", async () => {
    const explicitSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const ambiguousRef = "backup/self-upgrade/2026-05-03T00-00-00-000Z-ambiguous";
    const expiredUnmergedRef = "backup/self-upgrade/2026-05-02T00-00-00-000Z-expired-unmerged";
    const supersededRef = "backup/self-upgrade/2026-05-01T00-00-00-000Z-superseded";
    const deleteAttempts: string[] = [];
    let currentHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const descriptors = new Map<string, CalyxDaemonDescriptor>([
      ["run-serve", makeDescriptor({ repoRoot, runsRoot, gitHead: currentHead })],
    ]);

    const result = await runSelfUpgrade(
      {
        host: "blade",
        authToken: "secret-token",
        targetSha: explicitSha,
      },
      {
        now: () => "2026-06-27T00:00:00.000Z",
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [...descriptors.values()],
        readDescriptor: async (daemonId: string) => descriptors.get(daemonId),
        writeDescriptor: vi.fn(async (next: CalyxDaemonDescriptor) => {
          descriptors.set(next.daemon_id, next);
          return path.join(root, `${next.daemon_id}.json`);
        }),
        execGit: async (args: string[]) => {
          if (args[0] === "status") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "rev-parse" && args[1] === "HEAD") {
            return { code: 0, stdout: `${currentHead}\n`, stderr: "" };
          }
          if (args[0] === "rev-parse" && args[1] === "FETCH_HEAD") {
            return { code: 0, stdout: `${explicitSha}\n`, stderr: "" };
          }
          if (args[0] === "fetch" && args[1] === "origin" && args[2] === "main") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "for-each-ref" && args[1] === "--format=%(refname:short)") {
            return { code: 0, stdout: `${[ambiguousRef, expiredUnmergedRef, supersededRef].join("\n")}\n`, stderr: "" };
          }
          if (args[0] === "merge-base" && args[1] === "--is-ancestor" && args[2] === explicitSha && args[3] === "FETCH_HEAD") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "merge-base" && args[1] === "--is-ancestor" && args[2] === ambiguousRef && args[3] === "HEAD") {
            return { code: 128, stdout: "", stderr: "fatal: not a valid object name\n" };
          }
          if (args[0] === "merge-base" && args[1] === "--is-ancestor" && args[2] === expiredUnmergedRef && args[3] === "HEAD") {
            return { code: 1, stdout: "", stderr: "" };
          }
          if (args[0] === "merge-base" && args[1] === "--is-ancestor" && args[2] === supersededRef && args[3] === "HEAD") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "branch" && args[1] === "-D") {
            deleteAttempts.push(args[2] ?? "");
            return { code: 1, stdout: "", stderr: `error: cannot delete ${args[2]}\n` };
          }
          if (args[0] === "merge" && args[1] === "--ff-only" && args[2] === explicitSha) {
            currentHead = explicitSha;
            return { code: 0, stdout: "Fast-forward\n", stderr: "" };
          }
          if (args[0] === "log") {
            return { code: 0, stdout: "abc123 POL-1908 test commit\n", stderr: "" };
          }
          return { code: 0, stdout: `${currentHead}\n`, stderr: "" };
        },
        runBuild: async () => ({ code: 0, stdout: "build ok\n", stderr: "" }),
        prepareInstall: vi.fn(async ({ gitHead }) => prepareInstallFixture(homeRoot, gitHead)),
        createRunService: () => createRunServiceStub([]),
        createSupervisorAdapter: () => ({
          kind: "direct",
          stop: async () => ({ signal: "SIGTERM", forced: false }),
          start: async () => {
            descriptors.set("run-serve", makeDescriptor({
              repoRoot,
              runsRoot,
              gitHead: explicitSha,
              pid: 5150,
              argv: [process.execPath, currentInstallBin(homeRoot), "run", "serve"],
            }));
            return { pid: 5150 };
          },
          status: async () => ({ running: true, pid: 5150 }),
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async () => daemonHealthResponse(explicitSha))),
      },
    );

    expect(result.status).toBe("succeeded");
    expect(deleteAttempts).toEqual([supersededRef, expiredUnmergedRef]);
    expect(result.receipt?.explicit_target_adoption).toMatchObject({
      mode: "ff-only",
      target_head: explicitSha,
      fetch_head: explicitSha,
    });
    expect(result.receipt?.explicit_target_adoption).not.toHaveProperty("pruned_backup_refs");
    expect(result.receipt?.warnings).toContain(
      `Could not determine whether ${ambiguousRef} is merged into HEAD before pruning; preserving it: fatal: not a valid object name.`,
    );
    expect(result.receipt?.warnings).toContain(
      `Could not prune superseded backup ${supersededRef}: error: cannot delete ${supersededRef}.`,
    );
    expect(result.receipt?.warnings).toContain(
      `Could not prune expired unmerged backup ${expiredUnmergedRef}: error: cannot delete ${expiredUnmergedRef}.`,
    );
  });

  test("explicit targetSha does not hard reset a dirty checkout after non-fast-forward failure", async () => {
    const explicitSha = "badc0deaf00d1234567890abcdef1234567890ab";
    const gitCalls: Array<readonly string[]> = [];
    const descriptor = makeDescriptor({ repoRoot, runsRoot, gitHead: "local-sha" });

    await expect(
      runSelfUpgrade(
        {
          host: "blade",
          authToken: "secret-token",
          force: true,
          targetSha: explicitSha,
        },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [descriptor],
          readDescriptor: async () => descriptor,
          writeDescriptor: vi.fn(async () => ""),
          execGit: async (args: string[]) => {
            gitCalls.push(args);
            if (args[0] === "status") {
              return { code: 0, stdout: " M packages/cli/src/run-cli.ts\n", stderr: "" };
            }
            if (args[0] === "rev-parse" && args[1] === "HEAD") {
              return { code: 0, stdout: "local-sha\n", stderr: "" };
            }
            if (args[0] === "rev-parse" && args[1] === "FETCH_HEAD") {
              return { code: 0, stdout: `${explicitSha}\n`, stderr: "" };
            }
            if (args[0] === "fetch" && args[1] === "origin" && args[2] === "main") {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "merge" && args[1] === "--ff-only" && args[2] === explicitSha) {
              return { code: 128, stdout: "", stderr: "fatal: Not possible to fast-forward, aborting.\n" };
            }
            return { code: 0, stdout: "local-sha\n", stderr: "" };
          },
          createRunService: () => createRunServiceStub([]),
          createSupervisorAdapter: () => ({
            kind: "direct",
            stop: async () => ({ signal: "SIGTERM", forced: false }),
            start: async () => ({ pid: 5150 }),
            status: async () => ({ running: true, pid: 5150 }),
          }),
        },
      ),
    ).rejects.toThrow("Not possible to fast-forward");

    expect(gitCalls.some((call) => call[0] === "reset")).toBe(false);
  });

  test("explicit targetSha refuses a stale local SHA not reachable from the fetched ref", async () => {
    const explicitSha = "1111111111111111111111111111111111111111";
    const fetchedHead = "2222222222222222222222222222222222222222";
    const gitCalls: Array<readonly string[]> = [];
    const descriptor = makeDescriptor({ repoRoot, runsRoot, gitHead: "local-sha" });

    await expect(
      runSelfUpgrade(
        {
          host: "blade",
          authToken: "secret-token",
          targetSha: explicitSha,
        },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [descriptor],
          readDescriptor: async () => descriptor,
          writeDescriptor: vi.fn(async () => ""),
          execGit: async (args: string[]) => {
            gitCalls.push(args);
            if (args[0] === "status") {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "rev-parse" && args[1] === "HEAD") {
              return { code: 0, stdout: "local-sha\n", stderr: "" };
            }
            if (args[0] === "rev-parse" && args[1] === "FETCH_HEAD") {
              return { code: 0, stdout: `${fetchedHead}\n`, stderr: "" };
            }
            if (args[0] === "fetch" && args[1] === "origin" && args[2] === "main") {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "merge-base" && args[1] === "--is-ancestor" && args[2] === explicitSha && args[3] === fetchedHead) {
              return { code: 1, stdout: "", stderr: "" };
            }
            return { code: 0, stdout: "local-sha\n", stderr: "" };
          },
          createRunService: () => createRunServiceStub([]),
          createSupervisorAdapter: () => ({
            kind: "direct",
            stop: async () => ({ signal: "SIGTERM", forced: false }),
            start: async () => ({ pid: 5150 }),
            status: async () => ({ running: true, pid: 5150 }),
          }),
        },
      ),
    ).rejects.toThrow("not reachable from the fetched ref");

    expect(gitCalls.some((call) => call[0] === "merge")).toBe(false);
    expect(gitCalls.some((call) => call[0] === "reset")).toBe(false);
  });

  test("explicit targetSha rechecks dirtiness before hard-reset adoption", async () => {
    const explicitSha = "3333333333333333333333333333333333333333";
    const gitCalls: Array<readonly string[]> = [];
    let statusCalls = 0;
    const descriptor = makeDescriptor({ repoRoot, runsRoot, gitHead: "local-sha" });

    await expect(
      runSelfUpgrade(
        {
          host: "blade",
          authToken: "secret-token",
          targetSha: explicitSha,
        },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [descriptor],
          readDescriptor: async () => descriptor,
          writeDescriptor: vi.fn(async () => ""),
          execGit: async (args: string[]) => {
            gitCalls.push(args);
            if (args[0] === "status") {
              statusCalls += 1;
              return {
                code: 0,
                stdout: statusCalls === 1 ? "" : " M packages/cli/src/run-cli.ts\n",
                stderr: "",
              };
            }
            if (args[0] === "rev-parse" && args[1] === "HEAD") {
              return { code: 0, stdout: "local-sha\n", stderr: "" };
            }
            if (args[0] === "rev-parse" && args[1] === "FETCH_HEAD") {
              return { code: 0, stdout: `${explicitSha}\n`, stderr: "" };
            }
            if (args[0] === "fetch" && args[1] === "origin" && args[2] === "main") {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "merge" && args[1] === "--ff-only" && args[2] === explicitSha) {
              return { code: 128, stdout: "", stderr: "fatal: Not possible to fast-forward, aborting.\n" };
            }
            return { code: 0, stdout: "local-sha\n", stderr: "" };
          },
          createRunService: () => createRunServiceStub([]),
          createSupervisorAdapter: () => ({
            kind: "direct",
            stop: async () => ({ signal: "SIGTERM", forced: false }),
            start: async () => ({ pid: 5150 }),
            status: async () => ({ running: true, pid: 5150 }),
          }),
        },
      ),
    ).rejects.toThrow("became dirty after preflight");

    expect(statusCalls).toBe(2);
    expect(gitCalls.some((call) => call[0] === "branch")).toBe(false);
    expect(gitCalls.some((call) => call[0] === "reset")).toBe(false);
  });
});
