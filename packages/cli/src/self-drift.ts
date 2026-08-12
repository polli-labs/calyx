import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  classifyStateSchema,
  countStateMigrationsAfter,
  OPERATIONAL_FIXES,
  resolveAgentsInfraRoot,
  resolveCurrentHostAlias,
  resolveRepo,
  STATE_MIGRATIONS,
  type CalyxAdminHealth,
  type FleetTopologyTargetsV1,
  type FleetConvergenceToolchainCheck,
  type OperationalFix,
  type StateSchemaStatus,
} from "@polli-labs/calyx-core";
import {
  createCalyxAdminClient,
  type CalyxResult,
} from "@polli-labs/calyx-client/admin";
import { formatStateSchemaConvergence, type SelfHealthResult } from "./self-health.js";
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
import {
  createUnobservedToolchainCheck,
  type SelfUpgradeToolchainObservation,
  type SelfUpgradeToolchainObservationDiagnostic,
  type ToolchainCheckForHostResult,
} from "./self-upgrade-toolchain.js";

const execFileAsyncDefault = promisify(execFileCallback);
const DEFAULT_SELF_DRIFT_AGAINST_REF = "origin/main";
export const DEFAULT_SELF_DRIFT_AGE_THRESHOLD_COMMITS = 20;

export type SelfDriftSeverity =
  | "blocked"
  | "broken"
  | "current"
  | "needs_fetch"
  | "minor"
  | "major"
  | "critical"
  // TODO(POL-1120): reserve incompatible for requiredFeaturesForIntent cross-checks at dispatch time.
  | "incompatible";

export type SelfDriftDiagnosticKind =
  | "missing_target_ref"
  | "needs_fetch"
  | "compare_repo_unavailable"
  | "operation_cleanup";

export interface SelfDriftDiagnostic {
  readonly kind: SelfDriftDiagnosticKind;
  readonly severity: "warning";
  /** Present only for a non-authoritative operation-local hygiene observation. */
  readonly detail?: "residue" | "inspection_unavailable";
  readonly message: string;
  readonly actions: readonly string[];
}

export interface SelfDriftMissingOperationalFix {
  readonly id: string;
  readonly issue: string;
  readonly severity: OperationalFix["severity"];
  readonly summary: string;
}

/**
 * A host's state-schema position measured against the migration source of the
 * calyx build running this command — one reference frame for every host, which
 * is what makes a fleet-wide spread comparable.
 */
export interface SelfDriftSchemaPosition {
  /** Applied migration id the daemon reported; null when it reported none. */
  readonly current: string | null;
  /** Last migration id declared by the build running this command. */
  readonly target: string;
  /** Migrations this build declares that the host has not applied. */
  readonly behind: number;
  readonly status: StateSchemaStatus;
}

export interface SelfDriftReport {
  readonly host: string;
  readonly drift: SelfDriftSeverity;
  readonly daemonHead: string | null;
  readonly targetHead: string;
  readonly commitsBehind: number | null;
  readonly missingOperationalFixes: readonly SelfDriftMissingOperationalFix[];
  readonly diagnostics: readonly SelfDriftDiagnostic[];
  /** Null when the daemon is unreachable or predates the health field. */
  readonly schema: SelfDriftSchemaPosition | null;
  readonly toolchain_check?: FleetConvergenceToolchainCheck;
  readonly summary: string;
  readonly brokenReason?: string;
  readonly desired_membership?: "active";
  readonly effective_state?: Exclude<FleetEffectiveState, "withdrawn">;
  readonly owner?: string;
  readonly roles?: readonly string[];
}

export interface SelfDriftJsonResult {
  readonly host: string;
  readonly drift: SelfDriftSeverity;
  readonly daemon_head: string | null;
  readonly target_head: string;
  readonly commits_behind: number | null;
  readonly missing_op_fixes: readonly SelfDriftMissingOperationalFix[];
  readonly diagnostics: readonly SelfDriftDiagnostic[];
  readonly schema: SelfDriftSchemaPosition | null;
  readonly toolchain_check?: FleetConvergenceToolchainCheck;
  readonly broken_reason?: string;
  readonly desired_membership?: "active";
  readonly effective_state?: Exclude<FleetEffectiveState, "withdrawn">;
  readonly owner?: string;
  readonly roles?: readonly string[];
}

export interface SelfDriftFleetResult extends FleetTopologyOutput {
  schema_version: "self-drift-fleet/v1";
  checked_at: string;
  target_ref: string;
  hosts: SelfDriftJsonResult[];
  summary: FleetReadSummary;
  exit_code: number;
}

export interface ExecFileAsyncResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecFileAsyncOptions {
  readonly cwd?: string;
  readonly encoding?: BufferEncoding;
  readonly maxBuffer?: number;
}

export type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options?: ExecFileAsyncOptions,
) => Promise<ExecFileAsyncResult>;

export interface SelfDriftDependencies {
  readonly createAdminClient?: typeof createCalyxAdminClient;
  readonly execFileAsync?: ExecFileAsync;
  readonly agentsInfraRoot?: string;
  readonly repoRoot?: string;
  readonly currentHostAlias?: string;
  readonly accessForHost?: (host: string) => Promise<SelfDriftServerAccess> | SelfDriftServerAccess;
  /**
   * Optional daemon observations already collected by a composing command.
   * Reusing them keeps drift and health/install/capability classification on
   * one daemon generation instead of issuing a second racing health request.
   */
  readonly observedHealthResults?: readonly SelfHealthResult[];
  readonly fleetTopologyTargets?: FleetTopologyTargetsV1;
  readonly resolveFleetTopology?: ResolveFleetTopology;
  readonly now?: () => Date;
  readonly toolchainCheckForHost?: (args: {
    host: string;
    repoRoot: string;
    targetSha: string | null;
    checkedAt: string;
  }) => Promise<ToolchainCheckForHostResult>;
}

export interface SelfDriftServerAccess {
  readonly serverUrl: string;
  readonly token?: string | undefined;
}

export interface CollectSelfDriftReportsOptions {
  readonly host?: string;
  readonly fleet?: boolean;
  readonly against?: string;
  readonly authToken?: string;
  readonly ageThresholdCommits?: number;
}

export interface SelfCompareRepoResolution {
  readonly repoRoot?: string;
  readonly diagnostic?: SelfDriftDiagnostic;
}

interface HealthFetchOutcome {
  readonly health?: CalyxAdminHealth;
  readonly brokenReason?: string;
  readonly unavailable?: boolean;
}

function defaultSelfDriftRepoRoot(moduleUrl = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "..", "..");
}

function normalizeHostAlias(value: string): string {
  return value.trim().toLowerCase().split(".")[0] ?? "";
}

function shortSha(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return /^[0-9a-f]{8,40}$/i.test(value) ? value.slice(0, 7) : value;
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isTrackedShortSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value.trim());
}

function toMissingOperationalFix(entry: OperationalFix): SelfDriftMissingOperationalFix {
  return {
    id: entry.id,
    issue: entry.issue,
    severity: entry.severity,
    summary: entry.summary,
  };
}

function buildHealthServerUrl(targetHost: string, currentHostAlias: string): string {
  if (normalizeHostAlias(targetHost) === normalizeHostAlias(currentHostAlias)) {
    return "http://127.0.0.1:8740";
  }
  return `http://${targetHost}:8740`;
}

async function runGit(args: readonly string[], repoRoot: string, deps: SelfDriftDependencies): Promise<string> {
  const execFileAsync = deps.execFileAsync ?? execFileAsyncDefault;

  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed: ${message}`);
  }
}

async function resolveTargetHead(
  againstRef: string,
  repoRoot: string,
  deps: SelfDriftDependencies,
): Promise<string> {
  const targetHead = await runGit(["rev-parse", againstRef], repoRoot, deps);
  if (!targetHead) {
    throw new Error(`Resolved target ref "${againstRef}" to an empty git head.`);
  }
  return targetHead;
}

async function resolveTargetHeadOutcome(
  againstRef: string,
  repoRoot: string,
  deps: SelfDriftDependencies,
): Promise<{ targetHead: string } | { diagnostic: SelfDriftDiagnostic }> {
  try {
    return { targetHead: await resolveTargetHead(againstRef, repoRoot, deps) };
  } catch {
    return {
      diagnostic: {
        kind: "missing_target_ref",
        severity: "warning",
        message: `Local compare repo cannot resolve target ref "${againstRef}". Fetch the compare clone before judging daemon drift.`,
        actions: [gitFetchAction(repoRoot)],
      },
    };
  }
}

async function validateGitRepoRoot(candidate: string, deps: SelfDriftDependencies): Promise<string | undefined> {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const execFileAsync = deps.execFileAsync ?? execFileAsyncDefault;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: path.resolve(trimmed),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const root = stdout.trim();
    return root.length > 0 ? path.resolve(root) : undefined;
  } catch {
    return undefined;
  }
}

function compareRepoUnavailableDiagnostic(candidates: readonly string[]): SelfDriftDiagnostic {
  const candidateList = candidates.length > 0
    ? ` Checked: ${candidates.map((candidate) => path.resolve(candidate)).join(", ")}.`
    : "";
  return {
    kind: "compare_repo_unavailable",
    severity: "warning",
    message: `Unable to find a validated Calyx git checkout for drift comparison.${candidateList}`,
    actions: [
      "register hosts.<conductor>.repos.calyx.path in fleet/truths/hosts.yaml or restore ~/dev/calyx/dev, then rerun calyx self drift",
    ],
  };
}

export async function resolveSelfCompareRepoRoot(
  deps: SelfDriftDependencies = {},
): Promise<SelfCompareRepoResolution> {
  if (deps.repoRoot?.trim()) {
    return { repoRoot: path.resolve(deps.repoRoot) };
  }

  const candidates: string[] = [];
  let agentsInfraRoot = deps.agentsInfraRoot;
  if (!agentsInfraRoot) {
    try {
      agentsInfraRoot = await resolveAgentsInfraRoot();
    } catch {
      agentsInfraRoot = undefined;
    }
  }

  let currentHostAlias = deps.currentHostAlias ? normalizeHostAlias(deps.currentHostAlias) : "";
  if (!currentHostAlias && agentsInfraRoot) {
    try {
      currentHostAlias = normalizeHostAlias(await resolveCurrentHostAlias(undefined, agentsInfraRoot));
    } catch {
      currentHostAlias = "";
    }
  }

  if (agentsInfraRoot && currentHostAlias) {
    try {
      candidates.push(await resolveRepo("calyx", currentHostAlias, agentsInfraRoot));
    } catch {
      // Continue with conventional paths below; the diagnostic reports the
      // repair surface when no candidate validates.
    }
  }

  candidates.push(path.join(homedir(), "dev", "calyx", "dev"));
  candidates.push(defaultSelfDriftRepoRoot());

  const seen = new Set<string>();
  const uniqueCandidates = candidates
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => {
      if (seen.has(candidate)) {
        return false;
      }
      seen.add(candidate);
      return true;
    });

  for (const candidate of uniqueCandidates) {
    const repoRoot = await validateGitRepoRoot(candidate, deps);
    if (repoRoot) {
      return { repoRoot };
    }
  }

  return { diagnostic: compareRepoUnavailableDiagnostic(uniqueCandidates) };
}

async function resolveTargetHosts(
  options: CollectSelfDriftReportsOptions,
  deps: SelfDriftDependencies,
): Promise<{
  currentHostAlias: string;
  targets: string[];
  topology?: FleetTopologyTargetsV1;
}> {
  let agentsInfraRoot = deps.agentsInfraRoot ?? await resolveAgentsInfraRoot();
  const topology = options.fleet
    ? deps.fleetTopologyTargets
      ?? await (deps.resolveFleetTopology
        ?? ((intent) => resolveFleetTopologyForCommand(intent, agentsInfraRoot)))("read_only")
    : undefined;
  agentsInfraRoot = topology?.snapshot.source.root ?? agentsInfraRoot;
  const currentHostAlias = normalizeHostAlias(
    deps.currentHostAlias ?? await resolveCurrentHostAlias(undefined, agentsInfraRoot),
  );

  if (options.fleet) {
    if (options.host && normalizeHostAlias(options.host) !== "local") {
      throw new Error("calyx self drift accepts either --host <h> or --fleet, not both.");
    }
    const targets = topology!.desired_active.map((entry) => normalizeHostAlias(entry.host));

    if (targets.length === 0) {
      return { currentHostAlias, targets, topology: topology! };
    }
    return { currentHostAlias, targets, topology: topology! };
  }

  const requestedHost = normalizeHostAlias(options.host ?? "local");
  const targetHost = requestedHost === "" || requestedHost === "local"
    ? currentHostAlias
    : requestedHost;
  return { currentHostAlias, targets: [targetHost] };
}

async function fetchDaemonHealth(
  serverUrl: string,
  authToken: string,
  deps: SelfDriftDependencies,
): Promise<HealthFetchOutcome> {
  try {
    const createAdminClient = deps.createAdminClient ?? createCalyxAdminClient;
    const client = createAdminClient({
      baseUrl: serverUrl,
      bearerToken: authToken,
    });
    const result = await client.admin.health();
    if (!result.ok) {
      return {
        brokenReason: `Daemon health request failed: ${selfDriftHealthFailureMessage(result)}`,
        unavailable: result.kind === "transport"
          || (result.kind === "protocol" && result.status === 0),
      };
    }
    // The generated response is the wire authority. Core's domain type is
    // narrower only because generated open-enum values carry a branded
    // forward-compatibility type.
    const payload = result.data as CalyxAdminHealth;

    const daemonHead = payload.build?.git_head;
    if (typeof daemonHead !== "string" || daemonHead.trim().length === 0) {
      return { brokenReason: "Daemon health payload is missing build.git_head." };
    }

    return { health: payload };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      brokenReason: `Daemon health request failed: ${message}`,
      unavailable: true,
    };
  }
}

function selfDriftHealthFailureMessage<T, Code extends string>(
  result: Exclude<CalyxResult<T, Code>, { ok: true }>,
): string {
  if (result.kind === "api") {
    return `HTTP ${result.status}: ${result.error.error.message}`;
  }
  if (result.kind === "transport") {
    return result.message;
  }
  if (result.kind === "protocol") {
    return result.status > 0 ? `HTTP ${result.status}: ${result.message}` : result.message;
  }
  return "read operation returned an impossible indeterminate result";
}

/**
 * Migration source of the build running this command. Every host's reported
 * ledger head is measured against this one reference.
 */
const LOCAL_STATE_SCHEMA_TARGET = STATE_MIGRATIONS.at(-1)?.id ?? "0000";

function schemaPositionFor(health: CalyxAdminHealth): SelfDriftSchemaPosition | null {
  const reported = health.state_schema;
  if (!reported || reported.status === "unavailable") {
    return null;
  }
  const current = reported.current ?? null;
  return {
    current,
    target: LOCAL_STATE_SCHEMA_TARGET,
    behind: countStateMigrationsAfter(current),
    status: classifyStateSchema(current, LOCAL_STATE_SCHEMA_TARGET),
  };
}

function schemaNote(schema: SelfDriftSchemaPosition | null): string {
  if (!schema || schema.status === "current") {
    return "";
  }
  if (schema.status === "ahead") {
    return `; state schema ${schema.current ?? "none"} is ahead of this build's ${schema.target}`;
  }
  const plural = schema.behind === 1 ? "" : "s";
  return `; state schema ${schema.current ?? "none"} is ${schema.behind} migration${plural} behind ${schema.target}`;
}

function summarizeDrift(args: {
  drift: SelfDriftSeverity;
  targetHead: string;
  daemonHead?: string | null;
  commitsBehind?: number | null;
  missingOperationalFixes?: readonly SelfDriftMissingOperationalFix[];
  diagnostics?: readonly SelfDriftDiagnostic[];
  ageThresholdCommits: number;
  brokenReason?: string;
  schema?: SelfDriftSchemaPosition | null;
}): string {
  return `${summarizeBuildDrift(args)}${schemaNote(args.schema ?? null)}`;
}

function summarizeBuildDrift(args: {
  drift: SelfDriftSeverity;
  targetHead: string;
  daemonHead?: string | null;
  commitsBehind?: number | null;
  missingOperationalFixes?: readonly SelfDriftMissingOperationalFix[];
  diagnostics?: readonly SelfDriftDiagnostic[];
  ageThresholdCommits: number;
  brokenReason?: string;
}): string {
  if (args.drift === "blocked") {
    return args.brokenReason ?? "blocked";
  }
  if (args.drift === "broken") {
    return args.brokenReason ?? "health unavailable";
  }

  if (args.drift === "current") {
    return args.daemonHead === args.targetHead
      ? `at ${shortSha(args.targetHead)}`
      : `not behind ${shortSha(args.targetHead)}`;
  }

  if (args.drift === "needs_fetch") {
    return args.diagnostics?.[0]?.message ?? "Local compare repo needs fetch before daemon drift can be classified.";
  }

  const commitsBehind = args.commitsBehind ?? 0;
  const fixes = args.missingOperationalFixes ?? [];
  const fixIssues = fixes.map((entry) => entry.issue).join(", ");
  const behind = `${commitsBehind} commit${commitsBehind === 1 ? "" : "s"} behind`;

  if (fixes.length > 0) {
    return `${behind}; missing ${fixes.length} op-fix${fixes.length === 1 ? "" : "es"} (${fixIssues})`;
  }
  if (args.drift === "major" && commitsBehind > args.ageThresholdCommits) {
    return `${behind}; exceeds ${args.ageThresholdCommits}-commit threshold`;
  }
  return behind;
}

function createBrokenReport(
  host: string,
  targetHead: string,
  brokenReason: string,
  unavailable = true,
): SelfDriftReport {
  return {
    host,
    drift: "broken",
    daemonHead: null,
    targetHead,
    commitsBehind: null,
    missingOperationalFixes: [],
    diagnostics: [],
    schema: null,
    summary: summarizeDrift({
      drift: "broken",
      targetHead,
      brokenReason,
      ageThresholdCommits: DEFAULT_SELF_DRIFT_AGE_THRESHOLD_COMMITS,
    }),
    brokenReason,
    effective_state: unavailable ? "unavailable" : "repair",
  };
}

function gitFetchAction(repoRoot: string): string {
  return `git -C ${repoRoot} fetch --all --prune`;
}

function createCompareRepairReport(args: {
  host: string;
  targetHead: string;
  daemonHead: string;
  diagnostic: SelfDriftDiagnostic;
  ageThresholdCommits: number;
  schema: SelfDriftSchemaPosition | null;
}): SelfDriftReport {
  return {
    host: args.host,
    drift: "needs_fetch",
    daemonHead: args.daemonHead,
    targetHead: args.targetHead,
    commitsBehind: null,
    missingOperationalFixes: [],
    diagnostics: [args.diagnostic],
    schema: args.schema,
    summary: summarizeDrift({
      drift: "needs_fetch",
      targetHead: args.targetHead,
      daemonHead: args.daemonHead,
      commitsBehind: null,
      diagnostics: [args.diagnostic],
      ageThresholdCommits: args.ageThresholdCommits,
      schema: args.schema,
    }),
  };
}

function formatCell(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function isSelfUpgradeToolchainObservation(
  value: ToolchainCheckForHostResult,
): value is SelfUpgradeToolchainObservation {
  return "check" in value && "diagnostics" in value && Array.isArray(value.diagnostics);
}

function toSelfDriftToolchainDiagnostic(
  diagnostic: SelfUpgradeToolchainObservationDiagnostic,
): SelfDriftDiagnostic {
  return {
    kind: diagnostic.kind,
    severity: diagnostic.severity,
    detail: diagnostic.detail,
    message: diagnostic.message,
    actions: diagnostic.actions,
  };
}

function normalizeToolchainCheckObservation(
  value: ToolchainCheckForHostResult,
): SelfUpgradeToolchainObservation {
  return isSelfUpgradeToolchainObservation(value)
    ? value
    : { check: value, diagnostics: [] };
}

export async function collectSelfDriftReports(
  options: CollectSelfDriftReportsOptions,
  deps: SelfDriftDependencies = {},
): Promise<SelfDriftReport[]> {
  const ageThresholdCommits = options.ageThresholdCommits ?? DEFAULT_SELF_DRIFT_AGE_THRESHOLD_COMMITS;
  const againstRef = options.against?.trim() || DEFAULT_SELF_DRIFT_AGAINST_REF;
  const { currentHostAlias, targets, topology } = await resolveTargetHosts(options, deps);
  const topologyByHost = new Map(
    (topology?.desired_active ?? []).map((target) => [normalizeHostAlias(target.host), target]),
  );
  const compareRepo = await resolveSelfCompareRepoRoot({ ...deps, currentHostAlias });
  const targetOutcome = compareRepo.repoRoot
    ? await resolveTargetHeadOutcome(againstRef, compareRepo.repoRoot, deps)
    : { diagnostic: compareRepo.diagnostic ?? compareRepoUnavailableDiagnostic([]) };
  const targetHead = "targetHead" in targetOutcome ? targetOutcome.targetHead : againstRef;
  const observedHealthByHost = new Map(
    (deps.observedHealthResults ?? []).map((result) => [normalizeHostAlias(result.host), result]),
  );
  const reports: SelfDriftReport[] = [];

  for (const host of targets) {
    const observedHealth = observedHealthByHost.get(normalizeHostAlias(host));
    let healthOutcome: HealthFetchOutcome;
    if (observedHealth) {
      healthOutcome = observedHealth.ok
        ? { health: observedHealth.health }
        : {
            brokenReason: observedHealth.error.message,
            unavailable: observedHealth.error.kind === "unreachable"
              || (observedHealth.error.kind === "auth_failure"
                && observedHealth.error.http_status === undefined),
          };
    } else {
      const access = await deps.accessForHost?.(host);
      const authToken = options.authToken?.trim() || access?.token?.trim();
      if (!authToken) {
        reports.push(createBrokenReport(
          host,
          targetHead,
          `Missing operator_cli outbound credential for ${host}.`,
          true,
        ));
        continue;
      }
      const serverUrl = topologyByHost.get(normalizeHostAlias(host))?.run_serve_url
        ?? access?.serverUrl
        ?? buildHealthServerUrl(host, currentHostAlias);
      healthOutcome = await fetchDaemonHealth(serverUrl, authToken, deps);
    }
    if (!healthOutcome.health) {
      reports.push(createBrokenReport(
        host,
        targetHead,
        healthOutcome.brokenReason ?? "health unavailable",
        healthOutcome.unavailable ?? true,
      ));
      continue;
    }

    const daemonHead = healthOutcome.health.build.git_head.trim();
    const schema = schemaPositionFor(healthOutcome.health);
    if ("diagnostic" in targetOutcome) {
      reports.push(createCompareRepairReport({
        host,
        targetHead,
        daemonHead,
        diagnostic: targetOutcome.diagnostic,
        ageThresholdCommits,
        schema,
      }));
      continue;
    }

    if (daemonHead === targetHead) {
      reports.push({
        host,
        drift: "current",
        daemonHead,
        targetHead,
        commitsBehind: 0,
        missingOperationalFixes: [],
        diagnostics: [],
        schema,
        summary: summarizeDrift({
          drift: "current",
          targetHead,
          daemonHead,
          commitsBehind: 0,
          ageThresholdCommits,
          schema,
        }),
      });
      continue;
    }

    let missingCommits: string[];
    try {
      missingCommits = splitLines(await runGit(["log", "--format=%H", `${daemonHead}..${targetHead}`], compareRepo.repoRoot!, deps));
    } catch {
      reports.push(createCompareRepairReport({
        host,
        targetHead,
        daemonHead,
        diagnostic: {
          kind: "needs_fetch",
          severity: "warning",
          message: `Local compare repo cannot compare daemon HEAD ${shortSha(daemonHead)} against target ${shortSha(targetHead)}. Fetch the compare clone before judging daemon drift.`,
          actions: [gitFetchAction(compareRepo.repoRoot!)],
        },
        ageThresholdCommits,
        schema,
      }));
      continue;
    }

    // Use full SHAs + prefix-match so `OPERATIONAL_FIXES.introduced_by`
    // short SHAs (7 chars today) keep matching even after git auto-grows
    // the abbreviation length as the repo scales.
    const missingFullShas = missingCommits.map((entry) => entry.toLowerCase());
    const missingOperationalFixes = OPERATIONAL_FIXES
      .filter((entry) => {
        if (!isTrackedShortSha(entry.introduced_by)) {
          return false;
        }
        const prefix = entry.introduced_by.toLowerCase();
        return missingFullShas.some((full) => full.startsWith(prefix));
      })
      .map((entry) => toMissingOperationalFix(entry));

    const hasCriticalFix = missingOperationalFixes.some((entry) => entry.severity === "critical");
    const hasMajorFix = missingOperationalFixes.some((entry) => entry.severity === "major");
    // Schema position is deliberately absent from this classification. `drift`
    // gates fleet operations (`calyx self drift` exits non-zero, `self nudge`
    // files on it), and `calyx self upgrade` — the operation that converges a
    // schema — is exactly what a schema-driven gate would refuse. Divergence is
    // reported on its own axis so the repair path stays open.
    const drift: SelfDriftSeverity =
      hasCriticalFix
        ? "critical"
        : hasMajorFix
          ? "major"
          : missingCommits.length > ageThresholdCommits
            ? "major"
            : missingCommits.length > 0
              ? "minor"
              : "current";

    reports.push({
      host,
      drift,
      daemonHead,
      targetHead,
      commitsBehind: missingCommits.length,
      missingOperationalFixes,
      diagnostics: [],
      schema,
      summary: summarizeDrift({
        drift,
        targetHead,
        daemonHead,
        commitsBehind: missingCommits.length,
        missingOperationalFixes,
        ageThresholdCommits,
        schema,
      }),
    });
  }

  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const toolchainRepoRoot = compareRepo.repoRoot ?? deps.repoRoot ?? defaultSelfDriftRepoRoot();
  const withToolchain = await Promise.all(reports.map(async (report): Promise<SelfDriftReport> => {
    const targetSha = /^[0-9a-f]{40}$/iu.test(report.targetHead) ? report.targetHead : null;
    const toolchainCheckResult = deps.toolchainCheckForHost
      ? await deps.toolchainCheckForHost({
          host: report.host,
          repoRoot: toolchainRepoRoot,
          targetSha,
          checkedAt,
        })
      : await createUnobservedToolchainCheck({
          host: report.host,
          repoRoot: toolchainRepoRoot,
          targetSha,
          checkedAt,
        });
    const toolchainObservation = normalizeToolchainCheckObservation(toolchainCheckResult);
    const toolchainCheck = toolchainObservation.check;
    const diagnostics = [
      ...report.diagnostics,
      ...toolchainObservation.diagnostics.map(toSelfDriftToolchainDiagnostic),
    ];
    if (toolchainCheck.status !== "blocked") {
      return { ...report, diagnostics, toolchain_check: toolchainCheck };
    }
    return {
      ...report,
      drift: "blocked",
      diagnostics,
      toolchain_check: toolchainCheck,
      summary: `blocked/toolchain: ${toolchainCheck.failures.map((failure) => failure.message).join(" ") || "bootstrap toolchain is blocked"}`,
      effective_state: "repair",
    };
  }));

  if (!topology) return withToolchain;
  return withToolchain.map((report) => {
    const target = topologyByHost.get(normalizeHostAlias(report.host))!;
    return {
      ...report,
      owner: target.owner,
      roles: target.roles,
      desired_membership: "active" as const,
      effective_state: report.effective_state
        ?? (report.drift === "current" ? "active" : "repair"),
    };
  });
}

function formatSchemaCell(schema: SelfDriftSchemaPosition | null): string {
  if (!schema) {
    return "-";
  }
  const current = schema.current ?? "none";
  if (schema.status === "current") {
    return current;
  }
  return schema.status === "ahead" ? `${current} ahead` : `${current} -${schema.behind}`;
}

export function formatSelfDriftTable(reports: readonly SelfDriftReport[]): string {
  const rows = reports.map((report) => ({
    host: report.host,
    drift: report.drift,
    daemonHead: shortSha(report.daemonHead) ?? "-",
    commitsBehind: report.commitsBehind === null ? "-" : String(report.commitsBehind),
    missingFixes: String(report.missingOperationalFixes.length),
    toolchain: report.toolchain_check?.status ?? "unknown",
    schema: formatSchemaCell(report.schema),
    summary: report.summary,
  }));

  const widths = {
    host: Math.max("host".length, ...rows.map((row) => row.host.length)),
    drift: Math.max("drift".length, ...rows.map((row) => row.drift.length)),
    daemonHead: Math.max("daemon HEAD".length, ...rows.map((row) => row.daemonHead.length)),
    commitsBehind: Math.max("commits behind".length, ...rows.map((row) => row.commitsBehind.length)),
    missingFixes: Math.max("missing op-fixes".length, ...rows.map((row) => row.missingFixes.length)),
    toolchain: Math.max("toolchain".length, ...rows.map((row) => row.toolchain.length)),
    schema: Math.max("schema".length, ...rows.map((row) => row.schema.length)),
  };

  const header = [
    formatCell("host", widths.host),
    formatCell("drift", widths.drift),
    formatCell("daemon HEAD", widths.daemonHead),
    formatCell("commits behind", widths.commitsBehind),
    formatCell("missing op-fixes", widths.missingFixes),
    formatCell("toolchain", widths.toolchain),
    formatCell("schema", widths.schema),
    "summary",
  ].join(" | ");

  const divider = [
    "-".repeat(widths.host),
    "-".repeat(widths.drift),
    "-".repeat(widths.daemonHead),
    "-".repeat(widths.commitsBehind),
    "-".repeat(widths.missingFixes),
    "-".repeat(widths.toolchain),
    "-".repeat(widths.schema),
    "-".repeat("summary".length),
  ].join("-+-");

  const lines = rows.map((row) =>
    [
      formatCell(row.host, widths.host),
      formatCell(row.drift, widths.drift),
      formatCell(row.daemonHead, widths.daemonHead),
      formatCell(row.commitsBehind, widths.commitsBehind),
      formatCell(row.missingFixes, widths.missingFixes),
      formatCell(row.toolchain, widths.toolchain),
      formatCell(row.schema, widths.schema),
      row.summary,
    ].join(" | "),
  );

  const footer = reports.length > 1
    ? [formatStateSchemaConvergence(
        reports.map((report) => ({ host: report.host, schema: report.schema?.current ?? null })),
      )]
    : [];

  return [header, divider, ...lines, ...footer].join("\n");
}

export function toSelfDriftJsonResults(
  reports: readonly SelfDriftReport[],
): SelfDriftJsonResult[] {
  return reports.map((report) => ({
    host: report.host,
    drift: report.drift,
    daemon_head: shortSha(report.daemonHead),
    target_head: shortSha(report.targetHead) ?? report.targetHead,
    commits_behind: report.commitsBehind,
    missing_op_fixes: report.missingOperationalFixes,
    diagnostics: report.diagnostics,
    schema: report.schema,
    ...(report.toolchain_check ? { toolchain_check: report.toolchain_check } : {}),
    ...(report.brokenReason ? { broken_reason: report.brokenReason } : {}),
    ...(report.desired_membership ? { desired_membership: report.desired_membership } : {}),
    ...(report.effective_state ? { effective_state: report.effective_state } : {}),
    ...(report.owner ? { owner: report.owner } : {}),
    ...(report.roles ? { roles: report.roles } : {}),
  }));
}

export async function runSelfDriftFleetCommand(
  options: Omit<CollectSelfDriftReportsOptions, "fleet">,
  deps: SelfDriftDependencies = {},
): Promise<{ reports: SelfDriftReport[]; result: SelfDriftFleetResult; text: string }> {
  const topologyTargets = deps.fleetTopologyTargets
    ?? await (deps.resolveFleetTopology
      ?? ((intent) => resolveFleetTopologyForCommand(intent, deps.agentsInfraRoot)))("read_only");
  const reports = await collectSelfDriftReports(
    { ...options, fleet: true },
    { ...deps, fleetTopologyTargets: topologyTargets },
  );
  const topology = fleetTopologyOutput(topologyTargets);
  const states = reports.map((report) => report.effective_state ?? "repair");
  const summary = summarizeFleetRead(topology, states);
  const targetRef = options.against?.trim() || DEFAULT_SELF_DRIFT_AGAINST_REF;
  const result: SelfDriftFleetResult = {
    schema_version: "self-drift-fleet/v1",
    checked_at: new Date().toISOString(),
    target_ref: targetRef,
    ...topology,
    hosts: toSelfDriftJsonResults(reports),
    summary,
    exit_code: summary.green ? 0 : 1,
  };
  return {
    reports,
    result,
    text: [
      formatFleetTopologyIdentity(topology),
      formatSelfDriftTable(reports),
      formatExcludedWithdrawn(topology),
      `summary active=${summary.active} repair=${summary.repair} unavailable=${summary.unavailable} desired_active_total=${summary.desired_active_total} withdrawn_total=${summary.withdrawn_total} green=${String(summary.green)}`,
    ].join("\n"),
  };
}
