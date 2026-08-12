import { hostname as systemHostname } from "node:os";
import {
  readHostsTruth,
  resolveAgentsInfraRoot,
  resolveConsumerApiClientToken,
  resolveCurrentHostAlias,
} from "@polli-labs/calyx-core";
import type {
  CalyxAdminHealth,
  FleetTopologyTarget,
  FleetTopologyTargetsV1,
  HostsTruthFile,
} from "@polli-labs/calyx-core";
import {
  createCalyxAdminClient,
  type CalyxProtocolFailure,
  type CalyxResult,
} from "@polli-labs/calyx-client/admin";
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

const HEALTH_TIMEOUT_MS = 5_000;

export interface SelfHealthCommandOptions {
  host?: string;
  fleet?: boolean;
  json?: boolean;
}

export interface SelfHealthCommandDeps {
  createAdminClient?: typeof createCalyxAdminClient;
  now?: () => Date;
  agentsInfraRoot?: string;
  resolveFleetTopology?: ResolveFleetTopology;
  tokenForHost?: (host: string) => Promise<string | undefined> | string | undefined;
}

export type SelfHealthErrorKind =
  | "auth_failure"
  | "legacy_daemon"
  | "unreachable"
  | "http_error"
  | "invalid_response";

export interface SelfHealthErrorPayload {
  kind: SelfHealthErrorKind;
  message: string;
  /** Present when the daemon returned an HTTP response. */
  http_status?: number;
  /** Declared Calyx error-envelope code, when the response carried one. */
  error_code?: string;
  /** Declared server retryability, retained as evidence rather than policy. */
  response_retryable?: boolean;
  /** Generated-client phase that rejected a received response. */
  response_phase?: CalyxProtocolFailure["stage"];
}

export type SelfHealthResult =
  | {
      host: string;
      ok: true;
      health: CalyxAdminHealth;
    }
  | {
      host: string;
      ok: false;
      error: SelfHealthErrorPayload;
    };

export type SelfHealthFleetResult = SelfHealthResult & FleetTopologyTarget & {
  desired_membership: "active";
  effective_state: Exclude<FleetEffectiveState, "withdrawn">;
};

export interface SelfHealthFleetJsonResult extends FleetTopologyOutput {
  schema_version: "self-health-fleet/v1";
  checked_at: string;
  hosts: SelfHealthFleetResult[];
  summary: FleetReadSummary;
  exit_code: number;
}

export interface SelfHealthCommandResult {
  results: SelfHealthResult[];
  text: string;
  exitCode: number;
  failureMessage?: string;
  fleet?: SelfHealthFleetJsonResult;
}

interface ProbeTarget {
  host: string;
  serverUrl: string;
  token?: string;
}

function normalizeHostAlias(value: string): string {
  return value.trim().toLowerCase().split(".")[0] ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveTokenForHost(host: string, hostsTruth: HostsTruthFile): string | undefined {
  try {
    return resolveConsumerApiClientToken(host, hostsTruth.hosts?.[host], "operator_cli");
  } catch {
    return undefined;
  }
}

function defaultRunServeUrl(host: string, currentHost: string): string {
  if (host === currentHost) {
    return "http://127.0.0.1:8740";
  }
  return `http://${host}:8740`;
}

function resolveRequestedHost(rawHost: string | undefined, currentHost: string): string {
  if (!rawHost) {
    return currentHost;
  }
  const normalized = normalizeHostAlias(rawHost);
  if (!normalized || normalized === "local") {
    return currentHost;
  }
  return normalized;
}

function formatFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return `timeout after ${HEALTH_TIMEOUT_MS}ms`;
    }
    let cursor: unknown = error;
    let message = error.message.trim() || error.name;
    const seen = new Set<unknown>();
    while (isRecord(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      if (cursor instanceof Error && cursor.message.trim()) message = cursor.message.trim();
      if (typeof cursor["code"] === "string") message = String(cursor["code"]);
      if (!("cause" in cursor)) break;
      cursor = cursor["cause"];
    }
    return message;
  }
  return String(error);
}

function isLegacyHealthProtocolFailure(result: CalyxProtocolFailure): boolean {
  if (result.status === 404) {
    return true;
  }
  if (result.stage !== "invalid_response" || !result.rawBodyComplete) {
    return false;
  }
  try {
    const payload: unknown = JSON.parse(result.rawBodySnippet);
    return isRecord(payload) && !Object.hasOwn(payload, "schema_version");
  } catch {
    return false;
  }
}

function failureMessage<T, Code extends string>(
  result: Exclude<CalyxResult<T, Code>, { ok: true }>,
): string {
  if (result.kind === "api") {
    return result.error.error.message;
  }
  if (result.kind === "transport") {
    return result.stage === "aborted"
      ? `timeout after ${HEALTH_TIMEOUT_MS}ms`
      : result.message;
  }
  if (result.kind === "protocol") {
    return result.status > 0 ? `HTTP ${result.status}: ${result.message}` : result.message;
  }
  return "Daemon health result was indeterminate.";
}

function authFailureMessage<T, Code extends string>(
  result: Extract<Exclude<CalyxResult<T, Code>, { ok: true }>, { kind: "api" | "protocol" }>,
): string {
  if (result.kind === "api") {
    return result.error.error.message;
  }
  const boundedBody = result.rawBodySnippet.trim();
  return result.rawBodyComplete && boundedBody.length > 0
    ? boundedBody
    : failureMessage(result);
}

async function probeHealth(target: ProbeTarget, deps: SelfHealthCommandDeps): Promise<SelfHealthResult> {
  if (!target.token) {
    return {
      host: target.host,
      ok: false,
      error: {
        kind: "auth_failure",
        message: "Missing operator_cli consumer API credential for this host.",
      },
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const createAdminClient = deps.createAdminClient ?? createCalyxAdminClient;
    const client = createAdminClient({
      baseUrl: target.serverUrl,
      bearerToken: target.token,
    });
    const result = await client.admin.health({ signal: controller.signal });

    if (
      !result.ok
      && (result.kind === "api" || result.kind === "protocol")
      && (result.status === 401 || result.status === 403)
    ) {
      return {
        host: target.host,
        ok: false,
        error: {
          kind: "auth_failure",
          message: authFailureMessage(result),
        },
      };
    }

    if (!result.ok && result.kind === "protocol" && isLegacyHealthProtocolFailure(result)) {
      return {
        host: target.host,
        ok: false,
        error: {
          kind: "legacy_daemon",
          message: "pre-PR1 daemon; upgrade required",
        },
      };
    }

    if (!result.ok) {
      if (result.kind === "api") {
        return {
          host: target.host,
          ok: false,
          error: {
            kind: "http_error",
            message: `HTTP ${result.status}: ${result.error.error.message}`,
            http_status: result.status,
            error_code: result.error.error.code,
            ...(result.error.error.retryable !== undefined
              ? { response_retryable: result.error.error.retryable }
              : {}),
          },
        };
      }
      if (result.kind === "protocol") {
        return {
          host: target.host,
          ok: false,
          error: {
            kind: "invalid_response",
            message: failureMessage(result),
            ...(result.status > 0 ? { http_status: result.status } : {}),
            response_phase: result.stage,
          },
        };
      }
      return {
        host: target.host,
        ok: false,
        error: {
          kind: result.kind === "transport" ? "unreachable" : "invalid_response",
          message: failureMessage(result),
        },
      };
    }

    return {
      host: target.host,
      ok: true,
      // The generated response is the wire authority. Core's domain type is
      // narrower only because generated open-enum values carry a branded
      // forward-compatibility type.
      health: result.data as CalyxAdminHealth,
    };
  } catch (error) {
    return {
      host: target.host,
      ok: false,
      error: {
        kind: error instanceof Error && error.name === "AbortError"
          ? "unreachable"
          : "invalid_response",
        message: formatFetchError(error),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function shortSha(gitHead: string): string {
  const trimmed = gitHead.trim();
  return trimmed.length > 7 ? trimmed.slice(0, 7) : trimmed;
}

function formatCompactDuration(durationMs: number): string {
  const totalSeconds = Math.max(Math.floor(durationMs / 1_000), 0);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d${hours > 0 ? `${hours}h` : ""}`;
  }
  if (hours > 0) {
    return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds > 0 ? `${seconds}s` : ""}`;
  }
  return `${seconds}s`;
}

function formatRelativeTime(timestamp: string, now: Date): string {
  const thenMs = new Date(timestamp).getTime();
  if (Number.isNaN(thenMs)) {
    return timestamp;
  }
  const diffSeconds = Math.round((thenMs - now.getTime()) / 1_000);
  const absSeconds = Math.abs(diffSeconds);

  const unit =
    absSeconds >= 86_400
      ? { value: Math.round(diffSeconds / 86_400), label: "d" }
      : absSeconds >= 3_600
        ? { value: Math.round(diffSeconds / 3_600), label: "h" }
        : absSeconds >= 60
          ? { value: Math.round(diffSeconds / 60), label: "m" }
          : { value: diffSeconds, label: "s" };

  if (unit.value === 0) {
    return "now";
  }
  if (unit.value > 0) {
    return `in ${unit.value}${unit.label}`;
  }
  return `${Math.abs(unit.value)}${unit.label} ago`;
}

/**
 * Applied migration id a host reports, or `null` when it did not report one.
 * A daemon predating the `state_schema` health field and a daemon that could
 * not read its ledger are both unknown — neither is evidence of parity.
 */
export function appliedStateSchemaId(result: SelfHealthResult): string | null {
  if (!result.ok || result.health.state_schema?.status === "unavailable") {
    return null;
  }
  return result.health.state_schema?.current ?? null;
}

function formatStateSchemaCell(schema: CalyxAdminHealth["state_schema"]): string {
  if (!schema) {
    return "unknown";
  }
  if (schema.status === "unavailable") {
    return "unavailable";
  }
  const current = schema.current ?? "none";
  if (schema.status === "current") {
    return current;
  }
  // `0019 behind 0034` / `0034 ahead 0018`: applied id, direction, and the
  // migration source the daemon's own build declares.
  return `${current} ${schema.status} ${schema.target ?? "none"}`;
}

/**
 * One line answering "how many schema versions is this fleet running?".
 * Per-host cells make a single host legible; only the aggregate makes a
 * fleet-wide spread legible, which is the failure this surface exists for.
 */
export function formatStateSchemaConvergence(
  entries: ReadonlyArray<{ host: string; schema: string | null }>,
): string {
  if (entries.length === 0) {
    return "state schema: no hosts reported.";
  }
  const byVersion = new Map<string, string[]>();
  for (const entry of entries) {
    const key = entry.schema ?? "unknown";
    byVersion.set(key, [...(byVersion.get(key) ?? []), entry.host].sort());
  }
  const hostWord = entries.length === 1 ? "host" : "hosts";
  if (byVersion.size === 1) {
    const [version] = [...byVersion.keys()];
    return version === "unknown"
      ? `state schema: unknown across ${entries.length} ${hostWord} (no daemon reported a migration ledger).`
      : `state schema: converged at ${version} across ${entries.length} ${hostWord}.`;
  }
  // Zero-padded ids sort lexically in migration order; unknown trails the set.
  const groups = [...byVersion.entries()]
    .sort(([left], [right]) =>
      left === "unknown" ? 1 : right === "unknown" ? -1 : left.localeCompare(right))
    .map(([version, hosts]) => `${version} (${hosts.join(", ")})`);
  return `state schema: ${byVersion.size} versions across ${entries.length} ${hostWord} - ${groups.join(", ")}`;
}

function formatTextRow(result: SelfHealthResult, now: Date): string {
  if (!result.ok) {
    return `${result.host} | ${result.error.kind.toUpperCase()}: ${result.error.message}`;
  }

  const promoted = result.health.promoted_build?.status === "ok"
    ? shortSha(result.health.promoted_build.build?.git_head ?? "")
    : result.health.promoted_build?.status ?? "unknown";
  const clone = result.health.clone_head?.status === "ok"
    ? shortSha(result.health.clone_head.git_head ?? "")
    : result.health.clone_head?.status ?? "unknown";

  return [
    result.host,
    result.health.daemon_kind,
    formatCompactDuration(result.health.uptime_ms),
    shortSha(result.health.build.git_head),
    promoted || "unknown",
    clone || "unknown",
    formatStateSchemaCell(result.health.state_schema),
    formatRelativeTime(result.health.build.built_at, now),
    String(result.health.active_runs),
    String(result.health.supports_features.length),
    result.health.workload_admission?.admission === "open"
      ? `open@${shortSha(result.health.workload_admission.accepted_topology.projection_sha256)}`
      : result.health.workload_admission
        ? `fenced:${result.health.workload_admission.reason}`
        : "unknown",
    result.health.maintenance_mode ? "yes" : "no",
  ].join(" | ");
}

function formatFleetTextRow(result: SelfHealthFleetResult, now: Date): string {
  return [
    result.host,
    result.desired_membership,
    result.effective_state,
    result.ok ? formatTextRow(result, now).split(" | ").slice(1).join(" | ") : result.error.message,
  ].join(" | ");
}

/**
 * Exported for the same reason `formatSelfDriftTable` is: the rendering is the
 * operator-facing contract, and it must be assertable without standing up a
 * fleet truth fixture or reading the host this test happens to run on.
 */
export function renderSelfHealthText(
  results: readonly SelfHealthResult[],
  now: Date,
  isFleet: boolean,
): string {
  if (results.length === 0) {
    if (isFleet) {
      return "No desired-active hosts in the topology snapshot.";
    }
    return "No daemon health results.";
  }

  if (isFleet && results.every(
    (result) => "desired_membership" in result && "effective_state" in result,
  )) {
    const fleetResults = results as readonly SelfHealthFleetResult[];
    const lines = [
      "host | desired | effective | daemon_kind | uptime | running_build | promoted_build | clone_head | state_schema | built_at | active_runs | features | admission | maintenance",
      ...fleetResults.map((result) => formatFleetTextRow(result, now)),
    ];
    if (fleetResults.length > 1) {
      lines.push(formatStateSchemaConvergence(
        fleetResults.map((result) => ({ host: result.host, schema: appliedStateSchemaId(result) })),
      ));
    }
    return lines.join("\n");
  }

  const lines = [
    "host | daemon_kind | uptime | running_build | promoted_build | clone_head | state_schema | built_at | active_runs | features | admission | maintenance",
    ...results.map((result) => formatTextRow(result, now)),
  ];
  // One host has nothing to converge with; two or more do.
  if (results.length > 1) {
    lines.push(formatStateSchemaConvergence(
      results.map((result) => ({ host: result.host, schema: appliedStateSchemaId(result) })),
    ));
  }
  return lines.join("\n");
}

function exitCodeForResults(results: SelfHealthResult[]): number {
  const failures = results.filter((result) => !result.ok);
  if (failures.length === 0) {
    return 0;
  }
  return failures.some((result) => result.error.kind === "auth_failure") ? 8 : 6;
}

function failureMessageForResults(results: SelfHealthResult[]): string | undefined {
  const firstFailure = results.find((result) => !result.ok);
  if (!firstFailure) {
    return undefined;
  }
  const failureCount = results.filter((result) => !result.ok).length;
  return `${failureCount} host(s) failed; first: ${firstFailure.host} ${firstFailure.error.kind} ${firstFailure.error.message}`;
}

function resolveConfiguredServerUrl(host: string, hostsTruth: HostsTruthFile, currentHost: string): string {
  const configuredUrl = hostsTruth.hosts?.[host]?.run_serve_url?.trim();
  return configuredUrl && configuredUrl.length > 0 ? configuredUrl : defaultRunServeUrl(host, currentHost);
}

async function resolveSingleTarget(
  requestedHost: string | undefined,
  agentsInfraRoot: string | undefined,
  deps: SelfHealthCommandDeps,
): Promise<ProbeTarget> {
  const currentHost = agentsInfraRoot
    ? await resolveCurrentHostAlias(undefined, agentsInfraRoot)
    : normalizeHostAlias(systemHostname()) || "local";
  const host = resolveRequestedHost(requestedHost, currentHost);
  const hostsTruth = agentsInfraRoot ? await readHostsTruth(agentsInfraRoot) : {};
  const token = await deps.tokenForHost?.(host) ?? resolveTokenForHost(host, hostsTruth);
  return {
    host,
    serverUrl: resolveConfiguredServerUrl(host, hostsTruth, currentHost),
    ...(token ? { token } : {}),
  };
}

async function resolveFleetTargets(
  targets: FleetTopologyTargetsV1,
  deps: SelfHealthCommandDeps,
): Promise<ProbeTarget[]> {
  const sourceRoot = deps.agentsInfraRoot ?? targets.snapshot.source.root;
  const hostsTruth = sourceRoot && targets.desired_active.length > 0
    ? await readHostsTruth(sourceRoot)
    : {};
  return Promise.all(targets.desired_active.map(async (target) => {
    if (!target.run_serve_url) {
      throw new Error(`Desired-active topology target ${target.host} has no run_serve_url.`);
    }
    const token = await deps.tokenForHost?.(target.host) ?? resolveTokenForHost(target.host, hostsTruth);
    return {
      host: target.host,
      serverUrl: target.run_serve_url,
      ...(token ? { token } : {}),
    };
  }));
}

function healthEffectiveState(result: SelfHealthResult): Exclude<FleetEffectiveState, "withdrawn"> {
  if (result.ok) return "active";
  if (result.error.kind === "unreachable") return "unavailable";
  if (result.error.kind === "auth_failure" && result.error.http_status === undefined) {
    return "unavailable";
  }
  return "repair";
}

export async function runSelfHealthCommand(
  options: SelfHealthCommandOptions,
  deps: SelfHealthCommandDeps = {},
): Promise<SelfHealthCommandResult> {
  if (options.fleet && options.host?.trim()) {
    throw new Error("Provide either --host or --fleet, not both.");
  }

  const agentsInfraRoot = deps.agentsInfraRoot ?? await resolveAgentsInfraRoot();
  const topologyTargets = options.fleet
    ? await (deps.resolveFleetTopology
        ?? ((intent) => resolveFleetTopologyForCommand(intent, agentsInfraRoot)))("read_only")
    : undefined;
  const targets = topologyTargets
    ? await resolveFleetTargets(topologyTargets, deps)
    : [await resolveSingleTarget(options.host, agentsInfraRoot, deps)];
  const probedResults = await Promise.all(targets.map((target) => probeHealth(target, deps)));
  const now = deps.now?.() ?? new Date();
  const results: SelfHealthResult[] = topologyTargets
    ? probedResults.map((result, index) => ({
        ...topologyTargets.desired_active[index]!,
        ...result,
        desired_membership: "active" as const,
        effective_state: healthEffectiveState(result),
      }))
    : probedResults;
  const failureMessage = failureMessageForResults(results);

  if (topologyTargets) {
    const topology = fleetTopologyOutput(topologyTargets);
    const fleetResults = results as SelfHealthFleetResult[];
    const summary = summarizeFleetRead(
      topology,
      fleetResults.map((result) => result.effective_state),
    );
    const exitCode = summary.green ? 0 : exitCodeForResults(results) || 6;
    const topologyFailure = topology.can_emit_green_verdict
      ? undefined
      : `Topology snapshot is ${topology.topology_authority.status}: ${topology.topology_authority.reasons.join(", ")}.`;
    const fleetFailureMessage = failureMessage ?? topologyFailure;
    const fleet: SelfHealthFleetJsonResult = {
      schema_version: "self-health-fleet/v1",
      checked_at: now.toISOString(),
      ...topology,
      hosts: fleetResults,
      summary,
      exit_code: exitCode,
    };
    return {
      results,
      text: [
        formatFleetTopologyIdentity(topology),
        renderSelfHealthText(results, now, true),
        formatExcludedWithdrawn(topology),
        `summary active=${summary.active} repair=${summary.repair} unavailable=${summary.unavailable} desired_active_total=${summary.desired_active_total} withdrawn_total=${summary.withdrawn_total} green=${String(summary.green)}`,
      ].join("\n"),
      exitCode,
      ...(fleetFailureMessage
        ? { failureMessage: fleetFailureMessage }
        : {}),
      fleet,
    };
  }

  return {
    results,
    text: renderSelfHealthText(results, now, Boolean(options.fleet)),
    exitCode: exitCodeForResults(results),
    ...(failureMessage ? { failureMessage } : {}),
  };
}
