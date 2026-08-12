import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  type CalyxAdminHealth,
  type FleetConvergenceToolchainCheck,
  type FleetTopologyTargetsV1,
} from "@polli-labs/calyx-core";
import {
  openStateStore,
  planStateMigrations,
  upsertFleetConvergenceRow,
  type FleetConvergenceVerdict,
} from "@polli-labs/calyx-core";
import { SUPPORTED_FEATURES } from "@polli-labs/calyx-server";
import {
  collectSelfDriftReports,
  resolveSelfCompareRepoRoot,
  type SelfDriftDependencies,
  type SelfDriftDiagnostic,
  type SelfDriftReport,
  type SelfDriftSeverity,
} from "./self-drift.js";
import {
  runSelfHealthCommand,
  type SelfHealthCommandOptions,
  type SelfHealthCommandResult,
  type SelfHealthErrorKind,
  type SelfHealthErrorPayload,
  type SelfHealthResult,
} from "./self-health.js";
import {
  fleetTopologyOutput,
  formatExcludedWithdrawn,
  formatFleetTopologyIdentity,
  resolveFleetTopologyForCommand,
  summarizeFleetRead,
  type FleetEffectiveState,
  type FleetReadSummary,
  type FleetTopologyOutput,
  type ResolveFleetTopology,
} from "./fleet-topology.js";

const execFileAsyncDefault = promisify(execFileCallback);

export type SelfFreshnessVerdict =
  | "fresh"
  | "usable_with_warnings"
  | "stale"
  | "blocked";

export interface SelfFreshnessCommandOptions {
  host?: string;
  fleet?: boolean;
  against?: string;
  json?: boolean;
}

export interface SelfFreshnessCommandDeps {
  authToken?: string;
  expectedFeatures?: readonly string[];
  createAdminClient?: SelfDriftDependencies["createAdminClient"];
  now?: () => Date;
  execFileAsync?: SelfDriftDependencies["execFileAsync"];
  agentsInfraRoot?: string;
  repoRoot?: string;
  currentHostAlias?: string;
  tokenForHost?: (host: string) => Promise<string | undefined> | string | undefined;
  accessForHost?: SelfDriftDependencies["accessForHost"];
  toolchainCheckForHost?: SelfDriftDependencies["toolchainCheckForHost"];
  collectHealth?: (options: SelfHealthCommandOptions) => Promise<SelfHealthCommandResult>;
  collectDrift?: (options: {
    host?: string;
    fleet?: boolean;
    against?: string;
    authToken?: string;
  }) => Promise<SelfDriftReport[]>;
  persistConvergence?: boolean;
  fleetTopologyTargets?: FleetTopologyTargetsV1;
  resolveFleetTopology?: ResolveFleetTopology;
}

export interface SelfFreshnessHealthSummary {
  status: "ok" | "error";
  active_runs?: number;
  maintenance_mode?: boolean;
  build_head?: string;
  running_build_head?: string;
  promoted_build_head?: string;
  clone_head?: string;
  advertised_host?: string;
  error_kind?: SelfHealthErrorKind | "missing_health";
  message?: string;
  http_status?: number;
  error_code?: string;
  response_retryable?: boolean;
  response_phase?: SelfHealthErrorPayload["response_phase"];
}

export interface SelfFreshnessInstallDrift {
  status: "converged" | "clone_not_promoted" | "promoted_not_restarted" | "unknown";
  running_head?: string;
  promoted_head?: string;
  clone_head?: string;
  summary: string;
}

export interface SelfFreshnessCapabilitySummary {
  expected_count: number;
  supported_count: number;
  missing: string[];
}

export interface SelfFreshnessHostResult {
  host: string;
  verdict: SelfFreshnessVerdict;
  health: SelfFreshnessHealthSummary;
  toolchain_check?: FleetConvergenceToolchainCheck;
  drift?: {
    status: SelfDriftSeverity;
    daemon_head: string | null;
    target_head: string;
    commits_behind: number | null;
    summary: string;
    diagnostics: readonly SelfDriftDiagnostic[];
  };
  install_drift?: SelfFreshnessInstallDrift;
  capabilities: SelfFreshnessCapabilitySummary;
  actions: string[];
  owner?: string;
  roles?: readonly string[];
  desired_membership?: "active";
  effective_state?: Exclude<FleetEffectiveState, "withdrawn">;
}

export interface SelfFreshnessWarning {
  code: "fleet_convergence_persist_unavailable";
  message: string;
  detail?: string;
}

export interface SelfFreshnessResult {
  schema_version: "self-freshness/v1";
  checked_at: string;
  target_ref: string;
  hosts: SelfFreshnessHostResult[];
  summary: Record<SelfFreshnessVerdict, number>;
  exit_code: number;
  warnings?: SelfFreshnessWarning[];
  topology_snapshot?: FleetTopologyOutput["topology_snapshot"];
  topology_authority?: FleetTopologyOutput["topology_authority"];
  can_emit_green_verdict?: boolean;
  desired_active_total?: number;
  withdrawn_total?: number;
  excluded_withdrawn?: FleetTopologyOutput["excluded_withdrawn"];
  fleet_summary?: FleetReadSummary;
}

function shortSha(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return /^[0-9a-f]{8,40}$/i.test(value) ? value.slice(0, 7) : value;
}

function healthByHost(results: readonly SelfHealthResult[]): Map<string, SelfHealthResult> {
  return new Map(results.map((result) => [result.host, result]));
}

function driftByHost(results: readonly SelfDriftReport[]): Map<string, SelfDriftReport> {
  return new Map(results.map((result) => [result.host, result]));
}

function capabilitySummary(
  health: CalyxAdminHealth | undefined,
  expectedFeatures: readonly string[],
): SelfFreshnessCapabilitySummary {
  if (!health) {
    return {
      expected_count: expectedFeatures.length,
      supported_count: 0,
      missing: [...expectedFeatures],
    };
  }
  const supported = new Set(health.supports_features);
  return {
    expected_count: expectedFeatures.length,
    supported_count: health.supports_features.length,
    missing: expectedFeatures.filter((feature) => !supported.has(feature)),
  };
}

function verdictFor(args: {
  health: SelfHealthResult | undefined;
  drift: SelfDriftReport | undefined;
  installDrift: SelfFreshnessInstallDrift | undefined;
  capabilities: SelfFreshnessCapabilitySummary;
}): SelfFreshnessVerdict {
  if (!args.health?.ok) {
    return "blocked";
  }
  if (args.drift?.toolchain_check?.status === "blocked") {
    return "blocked";
  }
  if (args.drift?.drift === "broken" || args.drift?.drift === "critical" || args.drift?.drift === "incompatible") {
    return "blocked";
  }
  if (args.installDrift?.status === "promoted_not_restarted" || args.installDrift?.status === "clone_not_promoted") {
    return "stale";
  }
  // Missing required daemon features or a major drift are hard staleness and MUST
  // outrank the needs_fetch convergence reconciliation below: a converged daemon
  // that is missing expected features is stale (and actionsFor still surfaces the
  // self upgrade action). Only after this gate do we reconcile a needs_fetch.
  if (args.drift?.drift === "major" || args.capabilities.missing.length > 0) {
    return "stale";
  }
  if (args.drift?.drift === "needs_fetch") {
    // Health convergence (running === promoted === clone) is stronger evidence than a
    // compare-repo resolution failure: when the install is converged with no active runs,
    // a needs_fetch is a local diagnostic limitation, not daemon staleness — reconcile it
    // down to a warning. With active runs it falls through to the active_runs path below
    // (also a warning). Only without convergence evidence does it stay stale.
    if (args.installDrift?.status === "converged" && args.health.health.active_runs === 0) {
      return "usable_with_warnings";
    }
    if (args.installDrift?.status !== "converged") {
      return "stale";
    }
  }
  if (args.drift?.drift === "minor" || args.health.health.active_runs > 0 || args.health.health.maintenance_mode) {
    return "usable_with_warnings";
  }
  return "fresh";
}

function actionsFor(args: {
  host: string;
  health: SelfHealthResult | undefined;
  drift: SelfDriftReport | undefined;
  installDrift: SelfFreshnessInstallDrift | undefined;
  capabilities: SelfFreshnessCapabilitySummary;
}): string[] {
  const actions: string[] = [];
  const addAction = (action: string): void => {
    if (!actions.includes(action)) {
      actions.push(action);
    }
  };
  if (!args.health?.ok) {
    addAction(`calyx self health --host ${args.host} --json`);
    if (args.health?.error.kind === "auth_failure") {
      addAction("run through with-polli-secrets or repair the host's operator_cli credential truth");
    }
    return actions;
  }
  const toolchainCheck = args.drift?.toolchain_check;
  const toolchainBlocked = toolchainCheck?.status === "blocked";
  if (toolchainBlocked) {
    addAction(
      toolchainCheck.next_action?.description
        ?? `repair ${args.host}'s bootstrap toolchain before retrying self upgrade`,
    );
  }
  if (args.drift?.drift === "needs_fetch") {
    // The git-fetch repair stays surfaced as a local-compare diagnostic, but we never
    // synthesize a daemon upgrade for needs_fetch: when convergence reconciles the verdict
    // to usable_with_warnings (see verdictFor) the fetch is a non-blocking cleanup, not a
    // blocker-style remediation.
    for (const diagnostic of args.drift.diagnostics) {
      for (const action of diagnostic.actions) {
        addAction(action);
      }
    }
  }
  if (args.drift && args.drift.drift !== "current" && !toolchainBlocked) {
    if (args.drift.drift !== "needs_fetch") {
      addAction(`calyx self upgrade --host ${args.host} --dry-run`);
    }
  }
  if (
    (args.installDrift?.status === "promoted_not_restarted" || args.installDrift?.status === "clone_not_promoted")
    && !toolchainBlocked
    && !actions.some((action) => action.startsWith("calyx self upgrade"))
  ) {
    addAction(`calyx self upgrade --host ${args.host} --dry-run`);
  }
  if (
    args.capabilities.missing.length > 0
    && !toolchainBlocked
    && !actions.some((action) => action.startsWith("calyx self upgrade"))
  ) {
    addAction(`calyx self upgrade --host ${args.host} --dry-run`);
  }
  if (args.health.health.active_runs > 0) {
    addAction(`calyx run ps --host ${args.host} --json`);
  }
  if (args.health.health.maintenance_mode) {
    addAction(`calyx self health --host ${args.host} --json`);
  }
  return actions;
}

function toHealthSummary(result: SelfHealthResult | undefined): SelfFreshnessHealthSummary {
  if (!result) {
    return {
      status: "error",
      error_kind: "missing_health",
      message: "No health result was returned for this host.",
    };
  }
  if (!result.ok) {
    return {
      status: "error",
      error_kind: result.error.kind,
      message: result.error.message,
      ...(result.error.http_status !== undefined ? { http_status: result.error.http_status } : {}),
      ...(result.error.error_code ? { error_code: result.error.error_code } : {}),
      ...(result.error.response_retryable !== undefined
        ? { response_retryable: result.error.response_retryable }
        : {}),
      ...(result.error.response_phase ? { response_phase: result.error.response_phase } : {}),
    };
  }
  return {
    status: "ok",
    active_runs: result.health.active_runs,
    maintenance_mode: result.health.maintenance_mode,
    build_head: shortSha(result.health.build.git_head) ?? result.health.build.git_head,
    running_build_head: result.health.build.git_head,
    ...(result.health.promoted_build?.status === "ok" && result.health.promoted_build.build?.git_head
      ? { promoted_build_head: result.health.promoted_build.build.git_head }
      : {}),
    ...(result.health.clone_head?.status === "ok" && result.health.clone_head.git_head
      ? { clone_head: result.health.clone_head.git_head }
      : {}),
    ...(result.health.advertised_host ? { advertised_host: result.health.advertised_host } : {}),
  };
}

function classifyInstallDrift(result: SelfHealthResult | undefined): SelfFreshnessInstallDrift | undefined {
  if (!result?.ok) {
    return undefined;
  }
  const runningHead = result.health.build.git_head;
  const promotedHead = result.health.promoted_build?.status === "ok" ? result.health.promoted_build.build?.git_head : undefined;
  const cloneHead = result.health.clone_head?.status === "ok" ? result.health.clone_head.git_head : undefined;
  const base = {
    running_head: runningHead,
    ...(promotedHead ? { promoted_head: promotedHead } : {}),
    ...(cloneHead ? { clone_head: cloneHead } : {}),
  };
  if (!promotedHead || !cloneHead) {
    return {
      status: "unknown",
      ...base,
      summary: `install drift unknown: promoted=${promotedHead ? shortSha(promotedHead) : result.health.promoted_build?.status ?? "missing"} clone=${cloneHead ? shortSha(cloneHead) : result.health.clone_head?.status ?? "missing"}`,
    };
  }
  if (runningHead !== promotedHead) {
    return {
      status: "promoted_not_restarted",
      ...base,
      summary: `promoted ${shortSha(promotedHead)} but running daemon is ${shortSha(runningHead)}`,
    };
  }
  if (cloneHead !== promotedHead) {
    return {
      status: "clone_not_promoted",
      ...base,
      summary: `clone HEAD ${shortSha(cloneHead)} differs from promoted ${shortSha(promotedHead)}`,
    };
  }
  return {
    status: "converged",
    ...base,
    summary: `running, promoted, and clone are ${shortSha(runningHead)}`,
  };
}

function summarize(hosts: readonly SelfFreshnessHostResult[]): Record<SelfFreshnessVerdict, number> {
  return hosts.reduce<Record<SelfFreshnessVerdict, number>>(
    (summary, host) => {
      summary[host.verdict] += 1;
      return summary;
    },
    { fresh: 0, usable_with_warnings: 0, stale: 0, blocked: 0 },
  );
}

function exitCodeFor(summary: Record<SelfFreshnessVerdict, number>): number {
  if (summary.blocked > 0) {
    return 6;
  }
  if (summary.stale > 0) {
    return 3;
  }
  if (summary.usable_with_warnings > 0) {
    return 1;
  }
  return 0;
}

function isFullSha(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function convergenceVerdictFor(host: SelfFreshnessHostResult): FleetConvergenceVerdict {
  if (host.health.status === "error") return "pending";
  const verdict = host.verdict;
  if (verdict === "fresh") return "fresh";
  if (verdict === "blocked") return "structural";
  return "pending";
}

function persistenceWarning(message: string, detail?: string): SelfFreshnessWarning {
  return {
    code: "fleet_convergence_persist_unavailable",
    message,
    ...(detail ? { detail } : {}),
  };
}

async function resolveCheckoutHead(args: {
  execFileAsync?: SelfDriftDependencies["execFileAsync"];
  repoRoot?: string;
  agentsInfraRoot?: string;
  currentHostAlias?: string;
}): Promise<string> {
  const execFileAsync = args.execFileAsync ?? execFileAsyncDefault;
  const compareRepo = await resolveSelfCompareRepoRoot({
    ...(args.execFileAsync ? { execFileAsync: args.execFileAsync } : {}),
    ...(args.repoRoot ? { repoRoot: args.repoRoot } : {}),
    ...(args.agentsInfraRoot ? { agentsInfraRoot: args.agentsInfraRoot } : {}),
    ...(args.currentHostAlias ? { currentHostAlias: args.currentHostAlias } : {}),
  });
  if (!compareRepo.repoRoot) {
    throw new Error(compareRepo.diagnostic?.message ?? "Unable to resolve a Calyx compare checkout.");
  }
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: compareRepo.repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const sha = stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`Resolved source checkout HEAD is not a full git SHA: ${sha || "(empty)"}`);
  }
  return sha;
}

async function persistSelfFreshnessRows(args: {
  checkedAt: string;
  targetRef: string;
  hosts: readonly SelfFreshnessHostResult[];
  driftByHost: Map<string, SelfDriftReport>;
  checkoutHead: string;
}): Promise<void> {
  const plan = await planStateMigrations();
  if (!plan.applied.some((entry) => entry.id === "0006")) {
    throw new Error("fleet_convergence schema migration 0006 is not applied; run `calyx state migrate --apply`.");
  }
  const opened = await openStateStore();
  try {
    for (const host of args.hosts) {
      const drift = args.driftByHost.get(host.host);
      const targetRev = isFullSha(drift?.targetHead) ? drift.targetHead : null;
      const observedRev = isFullSha(host.health.promoted_build_head)
        ? host.health.promoted_build_head
        : isFullSha(drift?.daemonHead)
          ? drift.daemonHead
          : isFullSha(host.health.running_build_head)
            ? host.health.running_build_head
            : null;
      upsertFleetConvergenceRow(opened.db, {
        host: host.host,
        leg: "daemon_build",
        target_rev: targetRev,
        observed_rev: observedRev,
        converged_from: args.checkoutHead,
        policy: "auto",
        last_checked_at: args.checkedAt,
        verdict: convergenceVerdictFor(host),
        detail: host.install_drift?.summary ?? host.drift?.summary ?? host.health.message ?? null,
        payload: {
          source: "self-freshness",
          target_ref: args.targetRef,
          freshness_verdict: host.verdict,
          running_rev: host.health.running_build_head ?? null,
          promoted_rev: host.health.promoted_build_head ?? null,
          clone_head: host.health.clone_head ?? null,
          install_drift: host.install_drift ?? null,
          toolchain_check: host.toolchain_check ?? null,
          actions: host.actions,
        },
      });
    }
  } finally {
    opened.db.close();
  }
}

export async function runSelfFreshnessCommand(
  options: SelfFreshnessCommandOptions,
  deps: SelfFreshnessCommandDeps = {},
): Promise<SelfFreshnessResult> {
  if (options.fleet && options.host?.trim()) {
    throw new Error("Provide either --host or --fleet for calyx self freshness, not both.");
  }

  const authToken = deps.authToken?.trim();

  const against = options.against?.trim() || "origin/main";
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const topologyTargets = options.fleet
    ? deps.fleetTopologyTargets
      ?? await (deps.resolveFleetTopology
        ?? ((intent) => resolveFleetTopologyForCommand(intent, deps.agentsInfraRoot)))("read_only")
    : undefined;
  const expectedFeatures = deps.expectedFeatures ?? SUPPORTED_FEATURES;
  const healthCommand = deps.collectHealth ?? ((healthOptions: SelfHealthCommandOptions) =>
    runSelfHealthCommand(healthOptions, {
      ...(deps.createAdminClient ? { createAdminClient: deps.createAdminClient } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.agentsInfraRoot ? { agentsInfraRoot: deps.agentsInfraRoot } : {}),
      ...(topologyTargets ? { resolveFleetTopology: async () => topologyTargets } : {}),
      ...(deps.tokenForHost ? { tokenForHost: deps.tokenForHost } : {}),
    }));
  const health = await healthCommand({
    ...(options.host ? { host: options.host } : {}),
    fleet: Boolean(options.fleet),
  });
  const driftOptions = {
    ...(options.host ? { host: options.host } : {}),
    fleet: Boolean(options.fleet),
    against,
    ...(authToken ? { authToken } : {}),
  };
  // The default drift path must reuse the exact health payload that supplies
  // install and capability evidence. A second concurrent daemon request can
  // straddle a restart and create a mixed-generation freshness row.
  const drift = deps.collectDrift
    ? await deps.collectDrift(driftOptions)
    : await collectSelfDriftReports(driftOptions, {
        ...(deps.createAdminClient ? { createAdminClient: deps.createAdminClient } : {}),
        ...(deps.execFileAsync ? { execFileAsync: deps.execFileAsync } : {}),
        ...(deps.agentsInfraRoot ? { agentsInfraRoot: deps.agentsInfraRoot } : {}),
        ...(deps.repoRoot ? { repoRoot: deps.repoRoot } : {}),
        ...(deps.currentHostAlias ? { currentHostAlias: deps.currentHostAlias } : {}),
        ...(deps.accessForHost ? { accessForHost: deps.accessForHost } : {}),
        ...(deps.toolchainCheckForHost ? { toolchainCheckForHost: deps.toolchainCheckForHost } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        observedHealthResults: health.results,
        ...(topologyTargets ? { fleetTopologyTargets: topologyTargets } : {}),
      });

  const healthMap = healthByHost(health.results);
  const driftMap = driftByHost(drift);
  const topologyByHost = new Map(
    (topologyTargets?.desired_active ?? []).map((target) => [target.host, target]),
  );
  const hostNames = topologyTargets
    ? topologyTargets.desired_active.map((target) => target.host)
    : [...new Set([...healthMap.keys(), ...driftMap.keys()])].sort();
  const hosts = hostNames.map((host) => {
    const healthResult = healthMap.get(host);
    const driftResult = driftMap.get(host);
    const installDrift = classifyInstallDrift(healthResult);
    const capabilities = capabilitySummary(healthResult?.ok ? healthResult.health : undefined, expectedFeatures);
    const verdict = verdictFor({ health: healthResult, drift: driftResult, installDrift, capabilities });
    const target = topologyByHost.get(host);
    const effectiveState: Exclude<FleetEffectiveState, "withdrawn"> = !healthResult
      || (!healthResult.ok
        && (healthResult.error.kind === "unreachable"
          || (healthResult.error.kind === "auth_failure"
            && healthResult.error.http_status === undefined)))
      ? "unavailable"
      : verdict === "fresh"
        ? "active"
        : "repair";
    return {
      host,
      verdict,
      health: toHealthSummary(healthResult),
      ...(driftResult?.toolchain_check ? { toolchain_check: driftResult.toolchain_check } : {}),
      ...(driftResult
        ? {
            drift: {
              status: driftResult.drift,
              daemon_head: shortSha(driftResult.daemonHead),
              target_head: shortSha(driftResult.targetHead) ?? driftResult.targetHead,
              commits_behind: driftResult.commitsBehind,
              summary: driftResult.summary,
              diagnostics: driftResult.diagnostics,
            },
          }
        : {}),
      ...(installDrift ? { install_drift: installDrift } : {}),
      capabilities,
      actions: actionsFor({ host, health: healthResult, drift: driftResult, installDrift, capabilities }),
      ...(target
        ? {
            owner: target.owner,
            roles: target.roles,
            desired_membership: "active" as const,
            effective_state: effectiveState,
          }
        : {}),
    };
  });
  const summary = summarize(hosts);
  const topology = topologyTargets ? fleetTopologyOutput(topologyTargets) : undefined;
  const fleetSummary = topology
    ? summarizeFleetRead(
        topology,
        hosts.map((host) => host.effective_state ?? "repair"),
      )
    : undefined;
  const warnings: SelfFreshnessWarning[] = [];
  const result = {
    schema_version: "self-freshness/v1",
    checked_at: checkedAt,
    target_ref: against,
    hosts,
    summary,
    exit_code: fleetSummary?.green === false ? exitCodeFor(summary) || 6 : exitCodeFor(summary),
    ...(topology ? topology : {}),
    ...(fleetSummary ? { fleet_summary: fleetSummary } : {}),
  } satisfies SelfFreshnessResult;
  if (deps.persistConvergence) {
    try {
      const checkoutHead = await resolveCheckoutHead({
        ...(deps.execFileAsync ? { execFileAsync: deps.execFileAsync } : {}),
        ...(deps.repoRoot ? { repoRoot: deps.repoRoot } : {}),
        ...(deps.agentsInfraRoot ? { agentsInfraRoot: deps.agentsInfraRoot } : {}),
        ...(deps.currentHostAlias ? { currentHostAlias: deps.currentHostAlias } : {}),
      });
      await persistSelfFreshnessRows({
        checkedAt,
        targetRef: against,
        hosts,
        driftByHost: driftMap,
        checkoutHead,
      });
    } catch (error) {
      warnings.push(persistenceWarning(
        "Unable to persist fleet convergence rows; freshness result is still authoritative for this invocation.",
        error instanceof Error ? error.message : String(error),
      ));
    }
  }
  return warnings.length > 0 ? { ...result, warnings } : result;
}

export function formatSelfFreshnessText(result: SelfFreshnessResult): string {
  const topology: FleetTopologyOutput | undefined = result.topology_snapshot
    && result.topology_authority
    && result.can_emit_green_verdict !== undefined
    && result.desired_active_total !== undefined
    && result.withdrawn_total !== undefined
    && result.excluded_withdrawn
    ? {
        topology_snapshot: result.topology_snapshot,
        topology_authority: result.topology_authority,
        can_emit_green_verdict: result.can_emit_green_verdict,
        desired_active_total: result.desired_active_total,
        withdrawn_total: result.withdrawn_total,
        excluded_withdrawn: result.excluded_withdrawn,
      }
    : undefined;
  const lines = [
    ...(topology ? [formatFleetTopologyIdentity(topology)] : []),
    topology
      ? "host | desired | effective | verdict | running | promoted | clone | daemon_drift | toolchain | install_drift | active_runs | missing_features | next_action"
      : "host | verdict | running | promoted | clone | daemon_drift | toolchain | install_drift | active_runs | missing_features | next_action",
  ];
  for (const host of result.hosts) {
    const nextAction = host.actions[0] ?? "-";
    lines.push([
      host.host,
      ...(topology ? [host.desired_membership ?? "active", host.effective_state ?? "repair"] : []),
      host.verdict,
      shortSha(host.health.running_build_head) ?? host.health.build_head ?? host.health.error_kind ?? "-",
      shortSha(host.health.promoted_build_head) ?? "-",
      shortSha(host.health.clone_head) ?? "-",
      host.drift?.status ?? "-",
      host.toolchain_check?.status ?? "unknown",
      host.install_drift?.status ?? "-",
      host.health.active_runs === undefined ? "-" : String(host.health.active_runs),
      String(host.capabilities.missing.length),
      nextAction,
    ].join(" | "));
  }
  lines.push(
    `summary fresh=${result.summary.fresh} usable_with_warnings=${result.summary.usable_with_warnings} stale=${result.summary.stale} blocked=${result.summary.blocked}`,
  );
  if (topology && result.fleet_summary) {
    lines.push(formatExcludedWithdrawn(topology));
    lines.push(
      `fleet_summary active=${result.fleet_summary.active} repair=${result.fleet_summary.repair} unavailable=${result.fleet_summary.unavailable} desired_active_total=${result.fleet_summary.desired_active_total} withdrawn_total=${result.fleet_summary.withdrawn_total} green=${String(result.fleet_summary.green)}`,
    );
  }
  for (const warning of result.warnings ?? []) {
    lines.push(`warning ${warning.code}: ${warning.message}${warning.detail ? ` (${warning.detail})` : ""}`);
  }
  return lines.join("\n");
}
