import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { createCalyxAdminClient } from "@polli-labs/calyx-client/admin";
import {
  CALYX_SERVER_STARTUP_CONTRACT,
  applyStateMigrations,
  claimSelfUpgradeOperation,
  encodeSelfUpgradeOperationTransition,
  listFleetConvergenceRows,
  openStateStore,
  readSelfUpgradeOperation,
  SELF_UPGRADE_OPERATION_MAX_HOSTS,
  SELF_UPGRADE_OPERATION_MAX_PHASE_TRANSITIONS_PER_HOST,
  selfUpgradeHostPhaseTransitionId,
  type SelfUpgradeHostPhaseTransition,
} from "@polli-labs/calyx-core";
import { RunStore } from "@polli-labs/calyx-run-service";
import { validateOperationSuccessResponse } from "@polli-labs/calyx-server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  runSelfUpgradeFleet as runSelfUpgradeFleetCommand,
  partitionRemoteStderr,
  remoteStderrBoundaryMarker,
  resolveFetchedConductorTargetEvidence,
  resolveFetchedConductorTargetSha,
  SELF_UPGRADE_FLEET_RECEIPT_MAX_BYTES,
  type RemoteUpgradePlan,
  type SelfUpgradeFleetDependencies,
  type SelfUpgradeFleetPostflightHost,
  type SelfUpgradeFleetOptions,
} from "../commands/self-upgrade-fleet";
import {
  appendControlEvent,
  serializeSelfUpgradeReceipt,
  type SelfUpgradeOptions,
  type SelfUpgradePlan,
  type SelfUpgradeReceipt,
} from "../commands/self-upgrade";
import type { SelfFreshnessHostResult, SelfFreshnessResult } from "../self-freshness";
import { buildTargetStartupContractPayload } from "../self-upgrade-startup-contract";
import { execSelfUpgradeStreaming } from "../self-upgrade-stream-io";

const execFile = promisify(execFileCallback);

function createAdminClientFactory(fetchImpl: typeof fetch): typeof createCalyxAdminClient {
  return (options) => createCalyxAdminClient({
    ...options,
    fetch: fetchImpl,
  });
}

// The ssh invocation now prefixes `-o OPTION` pairs for connection timeout,
// keepalive, and batch-mode safety. The target host is the first positional
// argument after those `-o`/value pairs. This helper locates it robustly so
// test assertions don't drift if we add or remove `-o` options.
function extractSshHost(args: readonly unknown[]): string {
  for (let i = 0; i < args.length; i++) {
    const value = String(args[i]);
    if (value === "-o") {
      i += 1; // skip the option value
      continue;
    }
    if (value.startsWith("-")) {
      continue;
    }
    return value;
  }
  throw new Error(`Could not extract ssh host from args: ${JSON.stringify(args)}`);
}

/**
 * The plan the conductor piped to this host's stdin.
 *
 * Every variable fact now lives here rather than in the remote command string:
 * the preamble's own bytes are frozen, so a test that asserted on argv would be
 * asserting on the one part of the dispatch that is no longer allowed to move.
 */
function dispatchedPlan(options: unknown): RemoteUpgradePlan {
  const stdin = (options as { stdin?: string } | undefined)?.stdin;
  if (typeof stdin !== "string" || stdin.length === 0) {
    throw new Error("Dispatch sent no upgrade plan on stdin.");
  }
  if (!stdin.endsWith("\n")) {
    throw new Error("Dispatched plan is not newline-terminated.");
  }
  // The frozen contract promises `schema_version` first; assert the bytes, not
  // just the parsed object, so key order cannot drift unnoticed.
  if (!stdin.startsWith('{"schema_version":"calyx-upgrade-plan/v2"')) {
    throw new Error(`Dispatched plan does not lead with its schema version: ${stdin.slice(0, 80)}`);
  }
  return JSON.parse(stdin) as RemoteUpgradePlan;
}

function extractFleetOperationId(args: readonly unknown[]): string {
  const script = String(args.at(-1));
  const match = /fleet-[A-Za-z0-9._-]+/u.exec(script);
  if (!match?.[0]) {
    throw new Error(`Could not extract fleet operation id from script: ${script}`);
  }
  return match[0];
}

/**
 * Pull the stderr attribution marker out of the dispatched script.
 *
 * Reading it back from the script the conductor actually built (rather than
 * recomputing it in the test) is the point: it proves both ends agree on the
 * boundary, and it fails loudly if the dispatch stops emitting one.
 */
function extractStderrBoundary(args: readonly unknown[]): string {
  const script = String(args.at(-1));
  const match = /__calyx_self_upgrade_stderr_boundary\/v1 [^']+/u.exec(script);
  if (!match?.[0]) {
    throw new Error(`Dispatch script emitted no stderr attribution marker: ${script}`);
  }
  return match[0];
}

function makePlan(
  host: string,
  targetSha = STABLE_TARGET_SHA,
  targetRef = "origin/main",
  targetEvidence = testTargetEvidence(targetRef, targetSha),
) {
  return {
    host,
    repo_root: `/srv/${host}/calyx`,
    current_head: CHECKOUT_HEAD,
    target_ref: targetRef,
    target_head: targetSha,
    target_evidence: targetEvidence,
    dirty: false,
    dirty_paths: [],
    missing_build_artifacts: [],
    daemons: [],
    active_runs_post_reconcile: [],
    preservation: {
      policy: "automatic" as const,
      status: "not_applicable" as const,
      required_features: [],
      unavailable_reasons: [],
    },
    blockers: [],
    warnings: [],
    diagnostics: [],
  };
}

function makeReceipt(
  host: string,
  targetSha = STABLE_TARGET_SHA,
  targetRef = "origin/main",
  targetEvidence = testTargetEvidence(targetRef, targetSha),
) {
  return {
    schema_version: "self-upgrade-receipt/v1" as const,
    host,
    target_ref: targetRef,
    target_evidence: targetEvidence,
    status: "succeeded" as const,
    started_at: "2026-04-20T12:00:00.000Z",
    completed_at: "2026-04-20T12:01:00.000Z",
    repo_root: `/srv/${host}/calyx`,
    before_head: CHECKOUT_HEAD,
    after_head: targetSha,
    commit_list: ["abc123 POL-1123 receipt"],
    before_builds: [],
    after_builds: [],
    active_run_classification: [],
    drain_mode: "drain" as const,
    readopted_run_ids: [],
    drain_duration_ms: 0,
    daemons_restarted: [],
    warnings: [],
  };
}

function successJson(
  host: string,
  targetSha = STABLE_TARGET_SHA,
  targetRef = "origin/main",
  targetEvidence = testTargetEvidence(targetRef, targetSha),
): string {
  return `${JSON.stringify({
    status: "succeeded",
    plan: makePlan(host, targetSha, targetRef, targetEvidence),
    receipt_path: `/home/${host}/.calyx/self-upgrade-receipts/${host}.json`,
    receipt: makeReceipt(host, targetSha, targetRef, targetEvidence),
  })}\n`;
}

function bindCanonicalReceipt(
  receipt: SelfUpgradeReceipt,
  receiptPath: string,
  fleetOperationId: string,
): SelfUpgradeReceipt {
  if (!fleetOperationId) {
    throw new Error("Canonical receipt fixture requires the current fleet operation id.");
  }
  return {
    ...receipt,
    operation_id: path.posix.basename(receiptPath, ".json"),
    fleet_operation_id: fleetOperationId,
  };
}

function makeBoundLocalSuccess(
  options: SelfUpgradeOptions,
  projectionIssues?: Array<{
    scope: "status_stderr" | "remote_phase_stderr" | "lock_cleanup";
    code: "projection_unavailable" | "cleanup_unavailable";
    observed_at: string;
    message: string;
  }>,
) {
  const host = options.host;
  const receiptPath = `/home/${host}/.calyx/self-upgrade-receipts/${host}.json`;
  return {
    status: "succeeded" as const,
    plan: makePlan(host),
    operation_id: host,
    receipt_path: receiptPath,
    receipt: bindCanonicalReceipt(makeReceipt(host), receiptPath, options.fleetOperationId ?? ""),
    ...(projectionIssues?.length ? { projection_issues: projectionIssues } : {}),
  };
}

function dryRunJson(
  host: string,
  targetSha = STABLE_TARGET_SHA,
  targetRef = "origin/main",
  targetEvidence = testTargetEvidence(targetRef, targetSha),
): string {
  return `${JSON.stringify({
    status: "dry-run",
    plan: makePlan(host, targetSha, targetRef, targetEvidence),
  })}\n`;
}

function targetInvalidDryRunJson(host: string): string {
  return `${JSON.stringify({
    status: "dry-run",
    plan: {
      ...makePlan(host),
      startup_contract: {
        status: "unknown",
        mutation_disposition: "block",
        blocking_reasons: [{
          code: "target_contract_invalid",
          message: "target manifest is missing and is not proven legacy",
        }],
        contract_source: `conductor-payload:${STABLE_TARGET_SHA}`,
        contract_invalid_kind: "manifest_missing",
        contract_error: "target manifest is missing",
        reason: "target manifest is missing",
        per_daemon: [],
      },
    },
  })}\n`;
}

function failureJson(host: string): string {
  return `${JSON.stringify({
    status: "failed",
    error: `${host} upgrade exploded`,
    exit_code: 9,
    plan: makePlan(host),
    receipt_path: `/home/${host}/.calyx/self-upgrade-receipts/${host}.json`,
    receipt: {
      ...makeReceipt(host),
      status: "failed",
      error: `${host} upgrade exploded`,
    },
  })}\n`;
}

function freshnessJson(
  host: string,
  verdict: "fresh" | "usable_with_warnings" | "stale" | "blocked" = "fresh",
  checkedAt = "2026-04-20T12:03:00.000Z",
) {
  const summary = { fresh: 0, usable_with_warnings: 0, stale: 0, blocked: 0 };
  summary[verdict] = 1;
  return {
    schema_version: "self-freshness/v1" as const,
    checked_at: checkedAt,
    target_ref: "origin/main",
    hosts: [{
      host,
      verdict,
      health: {
        status: "ok" as const,
        active_runs: 0,
        maintenance_mode: false,
        build_head: "after-s",
        running_build_head: "after-sha",
        promoted_build_head: "after-sha",
        clone_head: "after-sha",
      },
      drift: {
        status: "current" as const,
        daemon_head: "after-s",
        target_head: "after-s",
        commits_behind: 0,
        summary: "at after-s",
        diagnostics: [],
      },
      install_drift: {
        status: "converged" as const,
        running_head: "after-sha",
        promoted_head: "after-sha",
        clone_head: "after-sha",
        summary: "running, promoted, and clone are after-s",
      },
      capabilities: {
        expected_count: 1,
        supported_count: verdict === "fresh" ? 1 : 0,
        missing: verdict === "fresh" ? [] : ["run.backend_model/v1"],
      },
      actions: verdict === "fresh" ? [] : [`calyx self upgrade --host ${host} --dry-run`],
    }],
    summary,
    exit_code: verdict === "fresh" ? 0 : verdict === "usable_with_warnings" ? 1 : verdict === "stale" ? 3 : 6,
  };
}

/**
 * POL-1933 shape: the daemon restarted by its own upgrade has not rebound the
 * health plane yet, so the probe sees a health error and — because capabilities
 * are read off that same unreachable health payload — the full expected feature
 * list reads as missing.
 */
function freshnessRestartingJson(
  host: string,
  checkedAt = "2026-04-20T12:02:30.000Z",
): SelfFreshnessResult {
  return {
    schema_version: "self-freshness/v1" as const,
    checked_at: checkedAt,
    target_ref: "origin/main",
    hosts: [{
      host,
      verdict: "blocked" as const,
      health: {
        status: "error" as const,
        error_kind: "unreachable",
        message: "connect ECONNREFUSED 127.0.0.1:8740",
      },
      capabilities: {
        expected_count: 3,
        supported_count: 0,
        missing: [
          "run.backend_model/v1",
          "run.readopt_on_boot/v1",
          "run.detached_worker_isolation/v1",
        ],
      },
      actions: [`calyx self health --host ${host} --json`],
    }],
    summary: { fresh: 0, usable_with_warnings: 0, stale: 0, blocked: 1 },
    exit_code: 6,
  };
}

type StructuralFreshnessCause =
  | "auth_failure"
  | "legacy_daemon"
  | "http_400"
  | "http_500"
  | "invalid_response"
  | "broken"
  | "critical"
  | "incompatible"
  | "major"
  | "needs_fetch"
  | "clone_not_promoted"
  | "target_missing_feature"
  | "unproven_promoted_not_restarted";

function structuralFreshnessJson(
  host: string,
  cause: StructuralFreshnessCause,
): SelfFreshnessResult {
  const base = freshnessJson(host);
  const healthy = base.hosts[0]!;
  let row: SelfFreshnessHostResult;
  if (
    cause === "auth_failure"
    || cause === "legacy_daemon"
    || cause === "http_400"
    || cause === "http_500"
    || cause === "invalid_response"
  ) {
    const responseEvidence = cause === "http_400" || cause === "http_500"
      ? {
          http_status: cause === "http_400" ? 400 : 500,
          error_code: cause === "http_400" ? "invalid_request" : "internal_error",
          response_retryable: false,
        }
      : cause === "invalid_response"
        ? {
            http_status: 200,
            response_phase: "invalid_response" as const,
          }
        : {};
    row = {
      host,
      verdict: "blocked",
      health: {
        status: "error",
        error_kind: cause === "http_400" || cause === "http_500" ? "http_error" : cause,
        message: `${cause} is structural`,
        ...responseEvidence,
      },
      capabilities: { expected_count: 3, supported_count: 0, missing: ["run.backend_model/v1"] },
      actions: [`repair ${cause}`],
    };
  } else if (
    cause === "broken"
    || cause === "critical"
    || cause === "incompatible"
    || cause === "major"
    || cause === "needs_fetch"
  ) {
    row = {
      ...healthy,
      verdict: cause === "broken" || cause === "critical" || cause === "incompatible"
        ? "blocked"
        : "stale",
      drift: { ...healthy.drift!, status: cause },
      actions: [`repair ${cause} drift`],
    };
  } else if (cause === "clone_not_promoted") {
    row = {
      ...healthy,
      verdict: "stale",
      install_drift: {
        ...healthy.install_drift!,
        status: "clone_not_promoted",
        clone_head: "before-sha",
      },
      actions: ["promote the clone"],
    };
  } else if (cause === "target_missing_feature") {
    row = {
      ...healthy,
      verdict: "stale",
      capabilities: { expected_count: 1, supported_count: 0, missing: ["run.backend_model/v1"] },
      actions: ["repair target feature contract"],
    };
  } else {
    row = {
      ...healthy,
      verdict: "stale",
      install_drift: {
        status: "promoted_not_restarted",
        running_head: "before-sha",
        promoted_head: "not-the-target",
        clone_head: "not-the-target",
        summary: "a different build was promoted",
      },
      actions: ["repair promotion authority"],
    };
  }
  const summary = { fresh: 0, usable_with_warnings: 0, stale: 0, blocked: 0 };
  summary[row.verdict] = 1;
  return { ...base, hosts: [row], summary, exit_code: row.verdict === "blocked" ? 6 : 3 };
}

function promotedTargetNotRestartedJson(
  host: string,
  checkedAt = "2026-04-20T12:02:45.000Z",
): SelfFreshnessResult {
  const base = freshnessJson(host, "stale", checkedAt);
  const row = base.hosts[0]!;
  return {
    ...base,
    hosts: [{
      ...row,
      drift: {
        ...row.drift!,
        status: "major",
        daemon_head: "before-sha",
        commits_behind: 21,
        summary: "the old daemon is more than 20 commits behind the target",
      },
      install_drift: {
        status: "promoted_not_restarted",
        running_head: "before-sha",
        promoted_head: STABLE_TARGET_SHA,
        clone_head: STABLE_TARGET_SHA,
        summary: "the exact target is promoted but the old daemon still serves",
      },
      capabilities: {
        expected_count: 1,
        supported_count: 0,
        missing: ["run.backend_model/v1"],
      },
    }],
  };
}

const tempRoots: string[] = [];
const STABLE_TARGET_SHA = "deadbeefcafef00d1234567890abcdef12345678";
const CHECKOUT_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
function validStartupContractPayload(targetSha = STABLE_TARGET_SHA): string {
  return Buffer.from(JSON.stringify({
    schema_version: "calyx-startup-contract-payload/v1",
    target_sha: targetSha,
    classification: "legacy_absent",
    reason: "test fixture predates the startup-contract boundary",
  }), "utf8").toString("base64url");
}
const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;
let previousEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "calyx-self-upgrade-fleet-"));
  tempRoots.push(root);
  return root;
}

type SelfUpgradeFleetTestDependencies = SelfUpgradeFleetDependencies & {
  resolveConductorTargetSha?: (targetRef: string, conductorHost: string) => Promise<string | undefined>;
};

function testTargetEvidence(targetRef: string, targetSha: string) {
  const slash = targetRef.indexOf("/");
  return {
    original_ref: targetRef,
    target_sha: targetSha,
    fetch_remote: slash > 0 ? targetRef.slice(0, slash) : "origin",
    fetch_ref: slash > 0 ? targetRef.slice(slash + 1) : targetRef,
  };
}

function runSelfUpgradeFleet(
  options: SelfUpgradeFleetOptions,
  dependencies: SelfUpgradeFleetTestDependencies = {},
) {
  const { resolveConductorTargetSha, ...typedDependencies } = dependencies;
  return runSelfUpgradeFleetCommand(options, {
    // Dispatch/receipt tests must not fall through to the real freshness
    // collector, nor spend real wall time in the POL-1933 settle window. Tests
    // that exercise the postflight supply their own stubs, which win below.
    sleep: async () => {},
    // Fleet truth for the fixture hosts: the same checkout path `makePlan`
    // reports back, so the conductor's clone-root cross-check passes unless a
    // test deliberately breaks it.
    resolveRemoteCloneRoot: async (host: string) => `/srv/${host}/calyx`,
    ...typedDependencies,
    resolveConductorTargetEvidence: async (targetRef, conductorHost, explicitTargetSha) => {
      const supplied = await resolveConductorTargetSha?.(targetRef, conductorHost);
      return testTargetEvidence(targetRef, explicitTargetSha ?? supplied ?? STABLE_TARGET_SHA);
    },
    resolveConductorStartupContractPayload:
      dependencies.resolveConductorStartupContractPayload ?? (async (targetSha) => validStartupContractPayload(targetSha)),
    runFreshnessCommand:
      dependencies.runFreshnessCommand
      ?? (async (freshnessOptions) => freshnessJson(freshnessOptions.host ?? "unknown")),
    verifyRemoteReceipt: dependencies.verifyRemoteReceipt ?? (async (
      host,
      receiptPath,
      receipt,
      _runServeUrl,
      fleetOperationId,
    ) => ({
      receipt: bindCanonicalReceipt(receipt, receiptPath, fleetOperationId),
      locator: {
        host,
        route: `/v1/admin/self-upgrade-receipts/${path.posix.basename(receiptPath, ".json")}`,
      },
    })),
  });
}

function createFleetEventProjectionBarrier(): {
  appendEventProjection: typeof appendControlEvent;
  flush: () => Promise<void>;
} {
  const pending: Array<{
    roots: string[];
    event: Parameters<typeof appendControlEvent>[1];
  }> = [];
  return {
    appendEventProjection: async (roots, event) => {
      pending.push({ roots: [...roots], event });
    },
    flush: async () => {
      for (const entry of pending) {
        await appendControlEvent(entry.roots, entry.event);
      }
    },
  };
}

beforeEach(async () => {
  previousEnv = {
    CALYX_STATE_HOME: process.env.CALYX_STATE_HOME,
    CALYX_STATE_DB: process.env.CALYX_STATE_DB,
  };
  const root = await makeTempRoot();
  process.env.CALYX_STATE_HOME = path.join(root, "state");
  delete process.env.CALYX_STATE_DB;
  await applyStateMigrations();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("partitionRemoteStderr", () => {
  const marker = remoteStderrBoundaryMarker("fleet-op", "carbon");

  test("splits environment noise from the dispatched CLI's output", () => {
    expect(partitionRemoteStderr(`rc noise\n${marker}\nreal failure\n`, marker)).toEqual({
      environment: "rc noise\n",
      attributed: "real failure\n",
    });
  });

  test("attributes everything when the dispatch never reached the marker", () => {
    expect(partitionRemoteStderr("ssh: connect timed out\n", marker)).toEqual({
      environment: "",
      attributed: "ssh: connect timed out\n",
    });
  });

  test("splits on the last marker so echoed input cannot move the boundary", () => {
    // A shell rc that traces the command it was handed replays the marker
    // before the CLI runs. The real boundary is always the final one.
    const stderr = `rc traced: ${marker}\nrc noise\n${marker}\nreal failure\n`;
    expect(partitionRemoteStderr(stderr, marker).attributed).toBe("real failure\n");
  });
});

describe("runSelfUpgradeFleet", () => {
  // Existing tests below use a conductor host (`"conductor"`) that is NOT in
  // the fleet target list, so every dispatch goes through SSH. Local-fast-path
  // coverage (POL-1145) lives in its own describe block at the bottom.

  test("dry-run emits per-host plans and aggregate fleet events", async () => {
    const homeRoot = await makeTempRoot();
    const eventProjection = createFleetEventProjectionBarrier();
    const result = await runSelfUpgradeFleet(
      {
        dryRun: true,
      },
      {
        homeDir: () => homeRoot,
        now: vi.fn()
          .mockReturnValueOnce("2026-04-20T12:00:00.000Z")
          .mockReturnValueOnce("2026-04-20T12:02:00.000Z"),
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
          { host: "worm", runServeUrl: "http://worm:8740" },
        ],
        listDescriptors: async () => [],
        appendEventProjection: eventProjection.appendEventProjection,
        execFileAsync: vi.fn(async (_file, args) => ({
          stdout: dryRunJson(extractSshHost(args)),
          stderr: "",
        })),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.receipt.status).toBe("dry-run");
    expect(result.receipt.per_host).toHaveLength(2);
    expect(result.receipt.per_host.map((entry) => entry.status)).toEqual(["dry-run", "dry-run"]);
    expect(result.receipt.startup_contract).toMatchObject({
      total_hosts: 2,
      compatible: 0,
      incompatible: 0,
      unknown_blocked: 0,
      unknown_nonblocking: 0,
      unassessed: 2,
      unassessed_hosts: ["blade", "worm"],
    });
    expect(result.text).toContain(
      "startup_contract: compatible=0 incompatible=0 unknown_blocked=0 unknown_nonblocking=0 unassessed=2",
    );

    // Projection loss is allowed to be fail-open. Capture the exact requested
    // writes during execution, then materialize them behind an explicit
    // semantic barrier so repository load cannot turn this nominal-path test
    // into a wall-clock race against the production settle bound.
    await eventProjection.flush();
    const eventsPath = path.join(homeRoot, ".calyx", "runs", "events.index.jsonl");
    const events = (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        event_type: string;
        control: { phase?: string; operation_id?: string; fleet?: { hosts?: Record<string, { status: string }> } };
      });
    expect(events.map((event) => event.event_type)).toEqual([
      "daemon.upgrade.fleet.started",
      "daemon.upgrade.progress",
      "daemon.upgrade.fleet.completed",
    ]);
    expect(events[1]?.control.phase).toBe("finalize");
    expect(events[2]?.control.fleet?.hosts).toMatchObject({
      blade: { status: "dry-run" },
      worm: { status: "dry-run" },
    });
  });

  test("retention bounds a hard-stale artifact directory without terminal authority", async () => {
    const homeRoot = await makeTempRoot();
    const incomplete = path.join(
      homeRoot,
      ".calyx",
      "self-upgrade-receipts",
      "fleet-incomplete-authority",
    );
    await mkdir(incomplete, { recursive: true });
    await utimes(incomplete, new Date(0), new Date(0));

    const result = await runSelfUpgradeFleet(
      { dryRun: true, hosts: ["blade"] },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
        listDescriptors: async () => [],
        execFileAsync: vi.fn(async () => ({ stdout: dryRunJson("blade"), stderr: "" })),
      },
    );

    expect(result.exitCode).toBe(0);
    await expect(stat(incomplete)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("forced fallback retention opens and removes a stale child through held authority", async () => {
    const homeRoot = await makeTempRoot();
    const staleDirectory = path.join(
      homeRoot,
      ".calyx",
      "self-upgrade-receipts",
      "fleet-fallback-stale-terminal",
    );
    await mkdir(staleDirectory, { recursive: true });
    await writeFile(path.join(staleDirectory, "summary.json"), `${JSON.stringify({
      schema_version: "self-upgrade-fleet-receipt/v1",
      status: "succeeded",
    })}\n`, "utf8");
    await utimes(staleDirectory, new Date(0), new Date(0));
    let fallbackProbes = 0;

    const result = await runSelfUpgradeFleet(
      { dryRun: true, hosts: ["blade"] },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
        listDescriptors: async () => [],
        execFileAsync: vi.fn(async () => ({ stdout: dryRunJson("blade"), stderr: "" })),
        durableDirectoryOpenOptions: {
          descriptorPathCandidates: () => {
            fallbackProbes += 1;
            return [];
          },
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(fallbackProbes).toBeGreaterThan(1);
    await expect(stat(staleDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("retention preserves an oversized otherwise-terminal aggregate receipt", async () => {
    const homeRoot = await makeTempRoot();
    const oversizedDirectory = path.join(
      homeRoot,
      ".calyx",
      "self-upgrade-receipts",
      "fleet-oversized-terminal",
    );
    await mkdir(oversizedDirectory, { recursive: true });
    await writeFile(path.join(oversizedDirectory, "summary.json"), JSON.stringify({
      schema_version: "self-upgrade-fleet-receipt/v1",
      status: "succeeded",
      padding: " ".repeat(SELF_UPGRADE_FLEET_RECEIPT_MAX_BYTES),
    }), "utf8");
    await utimes(oversizedDirectory, new Date(0), new Date(0));

    const result = await runSelfUpgradeFleet(
      { dryRun: true, hosts: ["blade"] },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
        listDescriptors: async () => [],
        execFileAsync: vi.fn(async () => ({ stdout: dryRunJson("blade"), stderr: "" })),
      },
    );

    expect(result.exitCode).toBe(0);
    await expect(stat(oversizedDirectory)).resolves.toMatchObject({});
  });

  test("forced fallback aggregate retention cannot delete from an ancestor replacement", async () => {
    const homeRoot = await makeTempRoot();
    const receiptRoot = path.join(homeRoot, ".calyx", "self-upgrade-receipts");
    const staleName = "fleet-stale-terminal";
    const staleDirectory = path.join(receiptRoot, staleName);
    await mkdir(staleDirectory, { recursive: true });
    await writeFile(path.join(staleDirectory, "summary.json"), `${JSON.stringify({
      schema_version: "self-upgrade-fleet-receipt/v1",
      status: "succeeded",
    })}\n`, "utf8");
    await utimes(staleDirectory, new Date(0), new Date(0));
    const execFileAsync = vi.fn();

    await expect(runSelfUpgradeFleet(
      { dryRun: true, hosts: ["blade"] },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
        listDescriptors: async () => [],
        execFileAsync,
        durableDirectoryOpenOptions: { descriptorPathCandidates: () => [] },
        afterFleetReceiptRootValidatedBeforeRetention: async () => {
          await rename(path.join(homeRoot, ".calyx"), path.join(homeRoot, ".calyx-held"));
          await mkdir(staleDirectory, { recursive: true });
          await writeFile(path.join(staleDirectory, "summary.json"), "replacement\n", "utf8");
        },
      },
    )).rejects.toThrow(/identity changed/u);

    expect(execFileAsync).not.toHaveBeenCalled();
    await expect(readFile(path.join(staleDirectory, "summary.json"), "utf8"))
      .resolves.toBe("replacement\n");
    await expect(stat(path.join(
      homeRoot,
      ".calyx-held",
      "self-upgrade-receipts",
      staleName,
    ))).resolves.toMatchObject({});
    expect(await readdir(receiptRoot)).toEqual([staleName]);
  });

  test("rejects a symlinked fleet receipt ancestor before claiming or dispatching", async () => {
    const homeRoot = await makeTempRoot();
    const redirect = await makeTempRoot();
    const redirectedOperationRoot = path.join(redirect, "self-upgrade-operations");
    await mkdir(redirectedOperationRoot);
    await symlink(redirect, path.join(homeRoot, ".calyx"), "dir");
    const execFileAsync = vi.fn();

    await expect(runSelfUpgradeFleet(
      { dryRun: true, hosts: ["blade"] },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
        listDescriptors: async () => [],
        execFileAsync,
      },
    )).rejects.toThrow(/not a real directory/u);
    expect(execFileAsync).not.toHaveBeenCalled();
    expect(await readdir(redirectedOperationRoot)).toEqual([]);
  });

  test("emits an operation id + finalize phase and recovers state from a fresh second shell", async () => {
    const homeRoot = await makeTempRoot();
    const eventProjection = createFleetEventProjectionBarrier();
    const result = await runSelfUpgradeFleet(
      {
        dryRun: true,
      },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
          { host: "worm", runServeUrl: "http://worm:8740" },
        ],
        listDescriptors: async () => [],
        appendEventProjection: eventProjection.appendEventProjection,
        execFileAsync: vi.fn(async (_file, args) => ({
          stdout: dryRunJson(extractSshHost(args)),
          stderr: "",
        })),
      },
    );

    // Operation id == aggregate-receipt dir basename, on the result and the
    // started event; the aggregate summary lives under that dir.
    const expectedOpId = path.basename(result.receipt.aggregate_dir);
    expect(result.operation_id).toBe(expectedOpId);
    expect(result.receipt_path).toBe(path.join(result.receipt.aggregate_dir, "summary.json"));

    const eventRoot = path.join(homeRoot, ".calyx", "runs");
    await eventProjection.flush();
    const events = (await readFile(path.join(eventRoot, "events.index.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event_type: string; control: { operation_id?: string; phase?: string } });
    // Finalize fires after the per-host loop and before the aggregate summary
    // write (the fleet.completed event follows the write).
    expect(events.map((event) => event.event_type)).toEqual([
      "daemon.upgrade.fleet.started",
      "daemon.upgrade.progress",
      "daemon.upgrade.fleet.completed",
    ]);
    expect(events[0]?.control.operation_id).toBe(expectedOpId);
    expect(events[1]?.control.phase).toBe("finalize");

    // Second-shell recovery: a fresh RunStore against the same runs root
    // reconstructs the operation id + last phase from the existing event plane
    // — no new status/watch command tree required.
    const recovered: Array<{ operation_id: string | undefined; phase: string | undefined }> = [];
    const store = new RunStore(eventRoot);
    await store.ensureRoot();
    await store.prepareGlobalEventAuthority();
    for await (const event of store.readEventsSince(undefined, { event_type: "daemon.upgrade.progress" })) {
      const control = (event as { control: { operation_id?: string; phase?: string } }).control;
      recovered.push({ operation_id: control.operation_id, phase: control.phase });
    }
    expect(recovered).toEqual([{ operation_id: expectedOpId, phase: "finalize" }]);
  });

  test("serial mode completes each host before starting the next", async () => {
    const homeRoot = await makeTempRoot();
    const calls: string[] = [];
    let resolveBladeStarted: (() => void) | undefined;
    const bladeStarted = new Promise<void>((resolve) => {
      resolveBladeStarted = resolve;
    });
    let resolveBlade: ((value: { stdout: string; stderr: string }) => void) | undefined;
    const bladeDone = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      resolveBlade = resolve;
    });

    const runPromise = runSelfUpgradeFleet(
      {},
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
          { host: "worm", runServeUrl: "http://worm:8740" },
        ],
        listDescriptors: async () => [],
        execFileAsync: vi.fn(async (_file, args) => {
          const host = extractSshHost(args);
          calls.push(`start:${host}`);
          if (host === "blade") {
            resolveBladeStarted?.();
            const result = await bladeDone;
            calls.push(`finish:${host}`);
            return result;
          }
          calls.push(`finish:${host}`);
          return { stdout: successJson(host), stderr: "" };
        }),
      },
    );

    await bladeStarted;
    expect(calls).toEqual(["start:blade"]);

    resolveBlade?.({ stdout: successJson("blade"), stderr: "" });
    const result = await runPromise;

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      "start:blade",
      "finish:blade",
      "start:worm",
      "finish:worm",
    ]);
  });

  test("parallel mode launches hosts concurrently", async () => {
    const homeRoot = await makeTempRoot();
    const calls: string[] = [];
    const resolvers = new Map<string, (value: { stdout: string; stderr: string }) => void>();
    let resolveBothStarted: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });

    const runPromise = runSelfUpgradeFleet(
      {
        parallel: true,
      },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
          { host: "worm", runServeUrl: "http://worm:8740" },
        ],
        listDescriptors: async () => [],
        execFileAsync: vi.fn((_file, args) => {
          const host = extractSshHost(args);
          calls.push(`start:${host}`);
          return new Promise<{ stdout: string; stderr: string }>((resolve) => {
            resolvers.set(host, (value) => {
              calls.push(`finish:${host}`);
              resolve(value);
            });
            if (resolvers.size === 2) {
              resolveBothStarted?.();
            }
          });
        }),
      },
    );

    // The canonical pre-dispatch writes are serialized and crash-durable, so
    // full-suite I/O load may delay the second child beyond a polling helper's
    // default one-second deadline. This barrier proves the actual contract:
    // neither child may finish before both children have started.
    await bothStarted;
    expect(calls).toEqual(["start:blade", "start:worm"]);

    resolvers.get("blade")?.({ stdout: successJson("blade"), stderr: "" });
    resolvers.get("worm")?.({ stdout: successJson("worm"), stderr: "" });
    const result = await runPromise;

    expect(result.exitCode).toBe(0);
    expect(result.receipt.parallel).toBe(true);
  });

  test("default mode continues after one host failure and records aggregate receipts", async () => {
    const homeRoot = await makeTempRoot();
    const execFileAsync = vi.fn(async (_file, args) => {
      const host = extractSshHost(args);
      if (host === "worm") {
        throw {
          code: 9,
          stdout: failureJson(host),
          stderr: "worm stderr line 1\nworm stderr line 2\n",
        };
      }
      return { stdout: successJson(host), stderr: "" };
    });

    const result = await runSelfUpgradeFleet(
      {},
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
          { host: "worm", runServeUrl: "http://worm:8740" },
          { host: "carbon", runServeUrl: "http://carbon:8740" },
        ],
        listDescriptors: async () => [],
        execFileAsync,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(execFileAsync).toHaveBeenCalledTimes(3);
    expect(result.receipt.status).toBe("failed");
    expect(result.receipt.per_host.map((entry) => entry.status)).toEqual([
      "succeeded",
      "failed",
      "succeeded",
    ]);
    const failedHost = result.receipt.per_host.find((entry) => entry.host === "worm");
    expect(failedHost).toMatchObject({
      error: "worm upgrade exploded",
      stderr_tail: "worm stderr line 1\nworm stderr line 2",
    });
    expect(failedHost).not.toHaveProperty("receipt_locator");
    expect(failedHost).not.toHaveProperty("receipt");
    expect(failedHost).not.toHaveProperty("plan");
    expect(result.operation.hosts.worm).toMatchObject({
      relay_mode: "missing",
      execution_status: "failed",
    });
    expect(result.operation.hosts.worm).not.toHaveProperty("latest_phase");
    expect(result.receipt.per_host_receipt_locators).toEqual({
      blade: { host: "blade", route: "/v1/admin/self-upgrade-receipts/blade" },
      carbon: { host: "carbon", route: "/v1/admin/self-upgrade-receipts/carbon" },
    });
  });

  // Regression, carbon 2026-07-25. ssh runs the remote command through the
  // login shell, and bash reads ~/.bashrc when its stdin is a network socket.
  // carbon's rc ran a `codex completion bash` hook whose npm-global launcher
  // pointed at a deleted vendored binary, so the stream the conductor reads
  // opened with a ten-line Node stack trace. The conductor quoted the whole
  // buffer, and "a Codex binary is missing" was recorded as the cause of an
  // upgrade that actually failed on its own last line — an argv contract the
  // host's older CLI did not understand.
  const CODEX_RC_NOISE = [
    "Error: spawn /Users/carbon/.npm-global/lib/node_modules/@openai/codex/node_modules"
      + "/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex ENOENT",
    "    at ChildProcess._handle.onexit (node:internal/child_process:286:19)",
    "    at onErrorNT (node:internal/child_process:524:16)",
    "  errno: -2,",
    "  code: 'ENOENT',",
    "  spawnargs: [ 'completion', 'bash' ]",
    "}",
  ].join("\n");
  const REMOTE_ARGV_FAILURE = "error: unknown option '--target-fetch-remote'";

  test("host failure is attributed to the dispatched CLI, not to shell-rc noise", async () => {
    const homeRoot = await makeTempRoot();
    const execFileAsync = vi.fn(async (_file, args) => {
      const host = extractSshHost(args);
      if (host === "carbon") {
        throw {
          code: 1,
          stdout: "",
          stderr: `${CODEX_RC_NOISE}\n${extractStderrBoundary(args)}\n${REMOTE_ARGV_FAILURE}\n`,
        };
      }
      return { stdout: successJson(host), stderr: "" };
    });

    const result = await runSelfUpgradeFleet(
      {},
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
          { host: "carbon", runServeUrl: "http://carbon:8740" },
        ],
        listDescriptors: async () => [],
        execFileAsync,
      },
    );

    const failedHost = result.receipt.per_host.find((entry) => entry.host === "carbon");
    expect(failedHost?.status).toBe("failed");
    // The diagnosis is the host's own output, and only that.
    expect(failedHost?.error).toBe(REMOTE_ARGV_FAILURE);
    expect(failedHost?.stderr_tail).toBe(REMOTE_ARGV_FAILURE);
    expect(failedHost?.error).not.toContain("codex");
    expect(failedHost?.error).not.toContain("ENOENT");
    // The noise is still evidence — carbon really does have a broken codex
    // install — so it is retained, just never mistaken for the cause.
    expect(failedHost?.remote_environment_noise).toContain("codex");
    expect(failedHost?.remote_environment_noise).toContain("spawnargs: [ 'completion', 'bash' ]");
  });

  test("stderr without an attribution marker stays fully attributed", async () => {
    const homeRoot = await makeTempRoot();
    const execFileAsync = vi.fn(async (_file, args) => {
      const host = extractSshHost(args);
      if (host === "carbon") {
        // No marker: ssh itself failed, or the shell died before the dispatch
        // script ran. Every byte is then genuinely the dispatch's own failure.
        throw { code: 255, stdout: "", stderr: "ssh: connect to host carbon port 22: Connection timed out\n" };
      }
      return { stdout: successJson(host), stderr: "" };
    });

    const result = await runSelfUpgradeFleet(
      {},
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
          { host: "carbon", runServeUrl: "http://carbon:8740" },
        ],
        listDescriptors: async () => [],
        execFileAsync,
      },
    );

    const failedHost = result.receipt.per_host.find((entry) => entry.host === "carbon");
    expect(failedHost?.error).toBe("ssh: connect to host carbon port 22: Connection timed out");
    expect(failedHost).not.toHaveProperty("remote_environment_noise");
  });

  test("the dispatch script marks the boundary before invoking the host CLI", async () => {
    const homeRoot = await makeTempRoot();
    const execFileAsync = vi.fn(async (_file, args) => ({
      stdout: successJson(extractSshHost(args)),
      stderr: "",
    }));

    await runSelfUpgradeFleet(
      { hosts: ["carbon"] },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "carbon", runServeUrl: "http://carbon:8740" },
        ],
        listDescriptors: async () => [],
        execFileAsync,
      },
    );

    const script = String(execFileAsync.mock.calls[0]?.[1]?.at(-1));
    const marker = extractStderrBoundary(execFileAsync.mock.calls[0]![1] as unknown[]);
    // Bound to this operation and host so ambient output cannot forge it.
    expect(marker).toContain(extractFleetOperationId(execFileAsync.mock.calls[0]![1] as unknown[]));
    expect(marker).toContain("carbon");
    // Emitted by a shell builtin before anything else the preamble does: the
    // remote needs no new capability for the conductor to attribute its output.
    expect(script.indexOf("printf")).toBeLessThan(script.indexOf("__calyx_fail"));
    expect(script).toContain(">&2");
  });

  test("dry-run omits postflight instead of writing a pending stub", async () => {
    const homeRoot = await makeTempRoot();
    const runFreshnessCommand = vi.fn(async () => freshnessJson("blade"));

    const result = await runSelfUpgradeFleet(
      { dryRun: true, hosts: ["blade"] },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
        ],
        listDescriptors: async () => [],
        runFreshnessCommand,
        execFileAsync: vi.fn(async () => ({ stdout: dryRunJson("blade"), stderr: "" })),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.receipt.postflight).toBeUndefined();
    expect(runFreshnessCommand).not.toHaveBeenCalled();
  });

  test("records a real fleet postflight from self freshness after successful upgrades", async () => {
    const homeRoot = await makeTempRoot();
    const runFreshnessCommand = vi.fn(async (options) =>
      freshnessJson(options.host ?? "unknown", options.host === "worm" ? "usable_with_warnings" : "fresh"));

    const result = await runSelfUpgradeFleet(
      {},
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
          { host: "worm", runServeUrl: "http://worm:8740" },
        ],
        listDescriptors: async () => [],
        authToken: "secret-token",
        runFreshnessCommand,
        execFileAsync: vi.fn(async (_file, args) => ({
          stdout: successJson(extractSshHost(args)),
          stderr: "",
        })),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.receipt.status).toBe("failed");
    expect(runFreshnessCommand.mock.calls.map((call) => call[0])).toEqual([
      { host: "blade", against: STABLE_TARGET_SHA, json: true },
      { host: "worm", against: STABLE_TARGET_SHA, json: true },
    ]);
    expect(runFreshnessCommand).toHaveBeenNthCalledWith(1, { host: "blade", against: STABLE_TARGET_SHA, json: true }, { authToken: "secret-token" });
    expect(runFreshnessCommand).toHaveBeenNthCalledWith(2, { host: "worm", against: STABLE_TARGET_SHA, json: true }, { authToken: "secret-token" });
    expect(result.receipt.postflight).toMatchObject({
      schema_version: "self-upgrade-fleet-postflight/v1",
      status: "completed",
      source_schema_version: "self-freshness/v1",
      target_ref: "origin/main",
      target_sha: STABLE_TARGET_SHA,
      freshness_exit_code: 1,
      summary: { fresh: 1, usable_with_warnings: 1, stale: 0, blocked: 0 },
      per_host: [
        { host: "blade", upgrade_status: "succeeded", freshness_verdict: "fresh", health_status: "ok" },
        {
          host: "worm",
          upgrade_status: "succeeded",
          freshness_verdict: "usable_with_warnings",
          missing_features: ["run.backend_model/v1"],
          next_action: "calyx self upgrade --host worm --dry-run",
        },
      ],
    });
    expect(result.text).toContain(`postflight: status=completed target_sha=${STABLE_TARGET_SHA} freshness_exit_code=1`);
    // Settled verdicts on the first probe consume no settle window and stay off
    // the per-host text rows, which are reserved for delayed/unsettled hosts.
    expect(result.receipt.postflight?.settle).toMatchObject({
      window_ms: 45_000,
      hosts_probed: 2,
      settled_first_probe: 2,
      settled_after_retries: 0,
      unsettled_after_retries: 0,
      unsettled_no_retries: 0,
      probe_error: 0,
      total_waited_ms: 0,
    });
    expect(result.receipt.postflight?.per_host.map((entry) => entry.settle?.outcome)).toEqual([
      "settled_first_probe",
      "settled_first_probe",
    ]);
    expect(result.text).not.toContain("postflight_host:");
  });

  test("postflight settles a just-restarted daemon while retaining the transient blocked probe", async () => {
    const homeRoot = await makeTempRoot();
    let monotonicMs = 0;
    const sleep = vi.fn(async (ms: number) => {
      monotonicMs += ms;
    });
    // blade converges on the second probe; worm is still restarting when its
    // first probe lands and only reports fresh on the third.
    const probesByHost = new Map<string, number>();
    const runFreshnessCommand = vi.fn(async (options: { host?: string }) => {
      const host = options.host ?? "unknown";
      const probe = (probesByHost.get(host) ?? 0) + 1;
      probesByHost.set(host, probe);
      const settledProbe = host === "worm" ? 3 : 2;
      monotonicMs += 7;
      return probe < settledProbe ? freshnessRestartingJson(host) : freshnessJson(host);
    });

    const result = await runSelfUpgradeFleet(
      {},
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
          { host: "worm", runServeUrl: "http://worm:8740" },
        ],
        listDescriptors: async () => [],
        authToken: "secret-token",
        runFreshnessCommand,
        sleep,
        monotonicNowMs: () => monotonicMs,
        execFileAsync: vi.fn(async (_file, args) => ({
          stdout: successJson(extractSshHost(args)),
          stderr: "",
        })),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(runFreshnessCommand).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([5_000, 5_000, 15_000]);
    // The durable verdict is the settled one, not the restart-race probe.
    expect(result.receipt.postflight).toMatchObject({
      status: "completed",
      freshness_exit_code: 0,
      summary: { fresh: 2, usable_with_warnings: 0, stale: 0, blocked: 0 },
      settle: {
        window_ms: 45_000,
        max_attempts: 8,
        delay_ramp_ms: [5_000, 15_000, 25_000],
        hosts_probed: 2,
        settled_first_probe: 0,
        settled_after_retries: 2,
        unsettled_after_retries: 0,
        total_waited_ms: 25_000,
      },
    });
    expect(result.receipt.postflight?.per_host[0]).toMatchObject({
      host: "blade",
      freshness_verdict: "fresh",
      health_status: "ok",
      settle: {
        outcome: "settled_after_retries",
        stop_reason: "settled",
        attempts: 2,
        waited_ms: 5_000,
        probes: [
          {
            status: "observed",
            attempt: 1,
            delay_before_ms: 0,
            started_after_ms: 0,
            completed_after_ms: 7,
            duration_ms: 7,
            verdict: "blocked",
            health_status: "error",
            missing_feature_count: 3,
          },
          {
            status: "observed",
            attempt: 2,
            delay_before_ms: 5_000,
            started_after_ms: 5_007,
            completed_after_ms: 5_014,
            duration_ms: 7,
            verdict: "fresh",
            health_status: "ok",
            missing_feature_count: 0,
          },
        ],
      },
    });
    expect(result.receipt.postflight?.per_host[1]?.settle).toMatchObject({
      outcome: "settled_after_retries",
      attempts: 3,
      waited_ms: 20_000,
      elapsed_ms: 20_021,
    });
    const durableReceipt = JSON.parse(await readFile(result.receipt_path, "utf8")) as {
      postflight: { per_host: SelfUpgradeFleetPostflightHost[] };
    };
    expect(durableReceipt.postflight.per_host[0]?.settle?.probes).toEqual(
      result.receipt.postflight?.per_host[0]?.settle?.probes,
    );
    expect(durableReceipt.postflight.per_host[0]?.settle?.probes[0]).toMatchObject({
      status: "observed",
      attempt: 1,
      started_after_ms: 0,
      completed_after_ms: 7,
      verdict: "blocked",
    });
    expect(result.text).toContain(
      "postflight_settle: window_ms=45000 max_attempts=8 hosts_probed=2 settled_first_probe=0 settled_after_retries=2 unsettled_after_retries=0 unsettled_no_retries=0 probe_error=0 total_waited_ms=25000",
    );
    expect(result.text).toContain(
      "postflight_host: worm verdict=fresh settle=settled_after_retries stop_reason=settled attempts=3 waited_ms=20000 elapsed_ms=20021 probe_results=blocked>blocked>fresh",
    );
  });

  test("retry failure preserves prior evidence and still probes later upgraded hosts", async () => {
    const homeRoot = await makeTempRoot();
    const eventProjection = createFleetEventProjectionBarrier();
    let monotonicMs = 0;
    const now = vi.fn()
      .mockReturnValueOnce("2026-04-20T12:02:00.000Z")
      .mockReturnValueOnce("2026-04-20T12:02:26.000Z")
      .mockReturnValueOnce("2026-04-20T12:02:28.000Z");
    const sleep = vi.fn(async (ms: number) => {
      monotonicMs += ms;
    });
    const probesByHost = new Map<string, number>();
    const runFreshnessCommand = vi.fn(async (options: { host?: string }) => {
      const host = options.host ?? "unknown";
      const attempt = (probesByHost.get(host) ?? 0) + 1;
      probesByHost.set(host, attempt);
      if (host === "worm") {
        monotonicMs += attempt === 1 ? 7 : 11;
        if (attempt === 2) {
          throw new Error("worm retry transport exploded");
        }
        return freshnessRestartingJson(host, "2026-04-20T12:02:20.000Z");
      }
      monotonicMs += 7;
      return freshnessJson(
        host,
        "fresh",
        host === "blade" ? "2026-04-20T12:02:10.000Z" : "2026-04-20T12:02:27.000Z",
      );
    });

    const result = await runSelfUpgradeFleet(
      {},
      {
        homeDir: () => homeRoot,
        now,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
          { host: "worm", runServeUrl: "http://worm:8740" },
          { host: "raven", runServeUrl: "http://raven:8740" },
        ],
        listDescriptors: async () => [],
        authToken: "secret-token",
        appendEventProjection: eventProjection.appendEventProjection,
        runFreshnessCommand,
        sleep,
        monotonicNowMs: () => monotonicMs,
        execFileAsync: vi.fn(async (_file, args) => ({
          stdout: successJson(extractSshHost(args)),
          stderr: "",
        })),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.receipt.status).toBe("failed");
    expect(result.failureMessage).toBe(
      "Postflight probing failed for worm: worm retry transport exploded",
    );
    expect(runFreshnessCommand.mock.calls.map((call) => call[0].host)).toEqual([
      "blade",
      "worm",
      "worm",
      "raven",
    ]);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([5_000]);
    expect(result.receipt.postflight).toMatchObject({
      status: "failed",
      checked_at: "2026-04-20T12:02:28.000Z",
      freshness_exit_code: null,
      summary: { fresh: 2, usable_with_warnings: 0, stale: 0, blocked: 1 },
      settle: {
        hosts_probed: 3,
        settled_first_probe: 2,
        settled_after_retries: 0,
        unsettled_no_retries: 0,
        unsettled_after_retries: 0,
        probe_error: 1,
        total_waited_ms: 5_000,
      },
      per_host: [
        { host: "blade", freshness_verdict: "fresh" },
        {
          host: "worm",
          freshness_verdict: "blocked",
          health_status: "error",
          error: "worm retry transport exploded",
          settle: {
            outcome: "probe_error",
            stop_reason: "probe_error",
            attempts: 2,
            waited_ms: 5_000,
            elapsed_ms: 5_018,
            probes: [
              {
                status: "observed",
                attempt: 1,
                delay_before_ms: 0,
                started_after_ms: 0,
                completed_after_ms: 7,
                observed_at: "2026-04-20T12:02:20.000Z",
                verdict: "blocked",
                retry_reason: "health_unreachable",
              },
              {
                status: "error",
                attempt: 2,
                delay_before_ms: 5_000,
                started_after_ms: 5_007,
                completed_after_ms: 5_018,
                duration_ms: 11,
                error: {
                  code: "freshness_command_failed",
                  message: "worm retry transport exploded",
                  occurred_at: "2026-04-20T12:02:26.000Z",
                },
              },
            ],
          },
        },
        { host: "raven", freshness_verdict: "fresh" },
      ],
      error: "Postflight probing failed for worm: worm retry transport exploded",
    });
    const durableReceipt = JSON.parse(await readFile(result.receipt_path, "utf8")) as {
      postflight: { per_host: SelfUpgradeFleetPostflightHost[] };
    };
    expect(durableReceipt.postflight.per_host[1]?.settle?.probes).toEqual(
      result.receipt.postflight?.per_host[1]?.settle?.probes,
    );
    expect(result.text).toContain(
      "postflight_host: worm verdict=blocked settle=probe_error stop_reason=probe_error attempts=2 waited_ms=5000 elapsed_ms=5018 probe_results=blocked>error:freshness_command_failed health_error=unreachable error_code=freshness_command_failed",
    );
    await eventProjection.flush();
    const events = (await readFile(
      path.join(homeRoot, ".calyx", "runs", "events.index.jsonl"),
      "utf8",
    ))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event_type: string; control: { error?: string } });
    expect(events.at(-1)).toMatchObject({
      event_type: "daemon.upgrade.fleet.failed",
      control: { error: "Postflight probing failed for worm: worm retry transport exploded" },
    });
  });

  test("a failed settle delay remains a timed durable retry attempt", async () => {
    const homeRoot = await makeTempRoot();
    let monotonicMs = 0;
    const sleep = vi.fn(async (_ms: number) => {
      monotonicMs += 2;
      throw new Error("settle timer aborted");
    });
    const runFreshnessCommand = vi.fn(async (options: { host?: string }) => {
      monotonicMs += 7;
      return freshnessRestartingJson(
        options.host ?? "unknown",
        "2026-04-20T12:03:01.000Z",
      );
    });

    const result = await runSelfUpgradeFleet(
      { hosts: ["blade"] },
      {
        homeDir: () => homeRoot,
        now: vi.fn()
          .mockReturnValueOnce("2026-04-20T12:03:00.000Z")
          .mockReturnValueOnce("2026-04-20T12:03:02.000Z")
          .mockReturnValueOnce("2026-04-20T12:03:03.000Z"),
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
        listDescriptors: async () => [],
        runFreshnessCommand,
        sleep,
        monotonicNowMs: () => monotonicMs,
        execFileAsync: vi.fn(async () => ({ stdout: successJson("blade"), stderr: "" })),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.receipt.status).toBe("failed");
    expect(runFreshnessCommand).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(result.receipt.postflight?.per_host[0]).toMatchObject({
      freshness_verdict: "blocked",
      settle: {
        outcome: "probe_error",
        stop_reason: "probe_error",
        attempts: 2,
        waited_ms: 0,
        elapsed_ms: 9,
        probes: [
          {
            status: "observed",
            attempt: 1,
            observed_at: "2026-04-20T12:03:01.000Z",
            retry_reason: "health_unreachable",
          },
          {
            status: "error",
            attempt: 2,
            delay_before_ms: 5_000,
            started_after_ms: 7,
            completed_after_ms: 9,
            duration_ms: 2,
            error: {
              code: "settle_delay_failed",
              message: "settle timer aborted",
              occurred_at: "2026-04-20T12:03:02.000Z",
            },
          },
        ],
      },
    });
  });

  test.each([
    {
      label: "health/protocol",
      causes: [
        "auth_failure",
        "legacy_daemon",
        "http_400",
        "http_500",
        "invalid_response",
      ] satisfies StructuralFreshnessCause[],
      expectedSummary: { fresh: 0, usable_with_warnings: 0, stale: 0, blocked: 5 },
      expectedExit: 6,
    },
    {
      label: "blocking drift",
      causes: [
        "broken",
        "critical",
        "incompatible",
        "major",
      ] satisfies StructuralFreshnessCause[],
      expectedSummary: { fresh: 0, usable_with_warnings: 0, stale: 1, blocked: 3 },
      expectedExit: 6,
    },
    {
      label: "stale drift/capability",
      causes: [
        "needs_fetch",
        "clone_not_promoted",
        "target_missing_feature",
        "unproven_promoted_not_restarted",
      ] satisfies StructuralFreshnessCause[],
      expectedSummary: { fresh: 0, usable_with_warnings: 0, stale: 4, blocked: 0 },
      expectedExit: 3,
    },
  ])("structural $label causes do not consume the settle window", async ({ causes, expectedSummary, expectedExit }) => {
    const homeRoot = await makeTempRoot();
    const sleep = vi.fn(async (_ms: number) => {});
    const runFreshnessCommand = vi.fn(async (options: { host?: string }) => {
      const cause = options.host as StructuralFreshnessCause;
      return structuralFreshnessJson(cause, cause);
    });

    const result = await runSelfUpgradeFleet(
      {},
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => causes.map((host) => ({
          host,
          runServeUrl: `http://${host}:8740`,
        })),
        listDescriptors: async () => [],
        runFreshnessCommand,
        sleep,
        execFileAsync: vi.fn(async (_file, args) => ({
          stdout: successJson(extractSshHost(args)),
          stderr: "",
        })),
      },
    );

    expect(result.exitCode).toBe(expectedExit);
    expect(result.receipt.status).toBe("failed");
    expect(result.failureMessage).toBe(`Fleet postflight was not fresh (exit ${expectedExit}).`);
    expect(runFreshnessCommand).toHaveBeenCalledTimes(causes.length);
    expect(sleep).not.toHaveBeenCalled();
    expect(result.receipt.postflight).toMatchObject({
      status: "completed",
      freshness_exit_code: expectedExit,
      summary: expectedSummary,
      settle: {
        hosts_probed: causes.length,
        unsettled_no_retries: causes.length,
        unsettled_after_retries: 0,
        probe_error: 0,
        total_waited_ms: 0,
      },
    });
    expect(result.receipt.postflight?.per_host.map((entry) => ({
      host: entry.host,
      outcome: entry.settle?.outcome,
      stop_reason: entry.settle?.stop_reason,
      attempts: entry.settle?.attempts,
      retry_reason: entry.settle?.probes[0]?.status === "observed"
        ? entry.settle.probes[0].retry_reason
        : undefined,
    }))).toEqual(causes.map((host) => ({
      host,
      outcome: "unsettled_no_retries",
      stop_reason: "not_retryable",
      attempts: 1,
      retry_reason: undefined,
    })));
    if ((causes as readonly StructuralFreshnessCause[]).includes("http_400")) {
      for (const [host, httpStatus, errorCode] of [
        ["http_400", 400, "invalid_request"],
        ["http_500", 500, "internal_error"],
      ] as const) {
        expect(result.receipt.postflight?.per_host.find((entry) => entry.host === host))
          .toMatchObject({
            health_error: {
              kind: "http_error",
              http_status: httpStatus,
              error_code: errorCode,
              response_retryable: false,
            },
            settle: {
              probes: [{
                status: "observed",
                health_error: {
                  kind: "http_error",
                  http_status: httpStatus,
                  error_code: errorCode,
                  response_retryable: false,
                },
              }],
            },
          });
      }
      expect(result.receipt.postflight?.per_host.find((entry) => entry.host === "invalid_response"))
        .toMatchObject({
          health_error: {
            kind: "invalid_response",
            http_status: 200,
            response_phase: "invalid_response",
          },
          settle: {
            probes: [{
              status: "observed",
              health_error: {
                kind: "invalid_response",
                http_status: 200,
                response_phase: "invalid_response",
              },
            }],
          },
        });
      expect(result.text).toMatch(
        /postflight_host: http_400 .*stop_reason=not_retryable .*health_error=http_error health_http_status=400/u,
      );
      expect(result.text).toMatch(
        /postflight_host: http_500 .*stop_reason=not_retryable .*health_error=http_error health_http_status=500/u,
      );
      expect(result.text).toMatch(
        /postflight_host: invalid_response .*stop_reason=not_retryable .*health_error=invalid_response health_http_status=200 health_response_phase=invalid_response/u,
      );
    }
  });

  test("retries exact target promotion despite old-daemon drift and capability evidence", async () => {
    const homeRoot = await makeTempRoot();
    let monotonicMs = 0;
    const sleep = vi.fn(async (ms: number) => {
      monotonicMs += ms;
    });
    let attempt = 0;
    const runFreshnessCommand = vi.fn(async (options: { host?: string }) => {
      attempt += 1;
      monotonicMs += 3;
      return attempt === 1
        ? promotedTargetNotRestartedJson(options.host ?? "unknown", "2026-04-20T12:04:00.000Z")
        : freshnessJson(options.host ?? "unknown", "fresh", "2026-04-20T12:04:06.000Z");
    });

    const result = await runSelfUpgradeFleet(
      { hosts: ["blade"] },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
        listDescriptors: async () => [],
        runFreshnessCommand,
        sleep,
        monotonicNowMs: () => monotonicMs,
        execFileAsync: vi.fn(async () => ({ stdout: successJson("blade"), stderr: "" })),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(result.receipt.postflight?.per_host[0]?.settle).toMatchObject({
      outcome: "settled_after_retries",
      stop_reason: "settled",
      attempts: 2,
      waited_ms: 5_000,
      probes: [
        {
          status: "observed",
          observed_at: "2026-04-20T12:04:00.000Z",
          verdict: "stale",
          missing_feature_count: 1,
          retry_reason: "target_promoted_daemon_not_restarted",
        },
        {
          status: "observed",
          observed_at: "2026-04-20T12:04:06.000Z",
          verdict: "fresh",
        },
      ],
    });
  });

  test("blocked stands as final when the bounded settle window is exhausted", async () => {
    const homeRoot = await makeTempRoot();
    const sleep = vi.fn(async (_ms: number) => {});
    const runFreshnessCommand = vi.fn(async (options: { host?: string }) =>
      freshnessRestartingJson(options.host ?? "unknown"));

    const result = await runSelfUpgradeFleet(
      { hosts: ["blade"] },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
        ],
        listDescriptors: async () => [],
        authToken: "secret-token",
        runFreshnessCommand,
        sleep,
        monotonicNowMs: () => 0,
        execFileAsync: vi.fn(async () => ({ stdout: successJson("blade"), stderr: "" })),
      },
    );

    // The ramp fits 5s + 15s + 25s inside the 45s window, so the window is spent
    // after four probes and the honest blocked verdict becomes durable.
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([5_000, 15_000, 25_000]);
    expect(runFreshnessCommand).toHaveBeenCalledTimes(4);
    expect(result.receipt.postflight).toMatchObject({
      status: "completed",
      freshness_exit_code: 6,
      summary: { fresh: 0, usable_with_warnings: 0, stale: 0, blocked: 1 },
      settle: {
        hosts_probed: 1,
        settled_after_retries: 0,
        unsettled_after_retries: 1,
        probe_error: 0,
        total_waited_ms: 45_000,
      },
    });
    expect(result.receipt.postflight?.per_host[0]).toMatchObject({
      host: "blade",
      freshness_verdict: "blocked",
      health_status: "error",
      missing_features: [
        "run.backend_model/v1",
        "run.readopt_on_boot/v1",
        "run.detached_worker_isolation/v1",
      ],
      settle: {
        outcome: "unsettled_after_retries",
        stop_reason: "window_budget",
        attempts: 4,
        waited_ms: 45_000,
      },
    });
    expect(result.text).toContain(
      "postflight_host: blade verdict=blocked settle=unsettled_after_retries stop_reason=window_budget attempts=4 waited_ms=45000",
    );
  });

  test("serial host probes retain a common wall-clock timeline across an exhausted window", async () => {
    const homeRoot = await makeTempRoot();
    const observedAtByHost: Record<string, readonly string[]> = {
      blade: ["2026-04-20T12:00:01.000Z"],
      worm: [
        "2026-04-20T12:00:02.000Z",
        "2026-04-20T12:00:07.000Z",
        "2026-04-20T12:00:22.000Z",
        "2026-04-20T12:00:47.000Z",
      ],
      raven: ["2026-04-20T12:00:48.000Z"],
    };
    const probeByHost = new Map<string, number>();
    let monotonicMs = 0;
    const sleep = vi.fn(async (ms: number) => {
      monotonicMs += ms;
    });
    const runFreshnessCommand = vi.fn(async (options: { host?: string }) => {
      const host = options.host ?? "unknown";
      const attempt = (probeByHost.get(host) ?? 0) + 1;
      probeByHost.set(host, attempt);
      monotonicMs += 1;
      const checkedAt = observedAtByHost[host]?.[attempt - 1];
      if (!checkedAt) throw new Error(`missing test observation time for ${host} attempt ${attempt}`);
      return host === "worm"
        ? freshnessRestartingJson(host, checkedAt)
        : freshnessJson(host, "fresh", checkedAt);
    });

    const result = await runSelfUpgradeFleet(
      {},
      {
        homeDir: () => homeRoot,
        now: vi.fn()
          .mockReturnValueOnce("2026-04-20T12:00:00.000Z")
          .mockReturnValueOnce("2026-04-20T12:00:49.000Z"),
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
          { host: "worm", runServeUrl: "http://worm:8740" },
          { host: "raven", runServeUrl: "http://raven:8740" },
        ],
        listDescriptors: async () => [],
        runFreshnessCommand,
        sleep,
        monotonicNowMs: () => monotonicMs,
        execFileAsync: vi.fn(async (_file, args) => ({
          stdout: successJson(extractSshHost(args)),
          stderr: "",
        })),
      },
    );

    expect(result.exitCode).toBe(6);
    expect(result.receipt.status).toBe("failed");
    expect(result.failureMessage).toBe("Fleet postflight was not fresh (exit 6).");
    expect(result.receipt.postflight).toMatchObject({
      status: "completed",
      checked_at: "2026-04-20T12:00:49.000Z",
      freshness_exit_code: 6,
      summary: { fresh: 2, usable_with_warnings: 0, stale: 0, blocked: 1 },
    });
    expect(result.receipt.postflight?.per_host[1]?.settle).toMatchObject({
      outcome: "unsettled_after_retries",
      stop_reason: "window_budget",
      attempts: 4,
      waited_ms: 45_000,
    });
    const timeline = result.receipt.postflight?.per_host.flatMap((entry) =>
      entry.settle?.probes.flatMap((probe) =>
        probe.status === "observed" ? [`${entry.host}@${probe.observed_at}`] : []) ?? []);
    expect(timeline).toEqual([
      "blade@2026-04-20T12:00:01.000Z",
      "worm@2026-04-20T12:00:02.000Z",
      "worm@2026-04-20T12:00:07.000Z",
      "worm@2026-04-20T12:00:22.000Z",
      "worm@2026-04-20T12:00:47.000Z",
      "raven@2026-04-20T12:00:48.000Z",
    ]);
    const bladeFirstProbe = result.receipt.postflight?.per_host[0]?.settle?.probes[0];
    expect(bladeFirstProbe).toMatchObject({
      status: "observed",
      observed_at: "2026-04-20T12:00:01.000Z",
    });
    const bladeObservedAt = bladeFirstProbe?.status === "observed"
      ? bladeFirstProbe.observed_at
      : "";
    expect(
      Date.parse(result.receipt.postflight!.checked_at)
      - Date.parse(bladeObservedAt),
    ).toBe(48_000);
  });

  test("a positive window shorter than the first delay reports that no delay fits", async () => {
    const homeRoot = await makeTempRoot();
    const sleep = vi.fn(async (_ms: number) => {});
    const runFreshnessCommand = vi.fn(async (options: { host?: string }) =>
      freshnessRestartingJson(options.host ?? "unknown"));

    const result = await runSelfUpgradeFleet(
      { hosts: ["blade"], postflightSettleWindowMs: 4_999 },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
        ],
        listDescriptors: async () => [],
        runFreshnessCommand,
        sleep,
        monotonicNowMs: () => 0,
        execFileAsync: vi.fn(async () => ({ stdout: successJson("blade"), stderr: "" })),
      },
    );

    expect(sleep).not.toHaveBeenCalled();
    expect(runFreshnessCommand).toHaveBeenCalledTimes(1);
    expect(result.receipt.postflight?.per_host[0]?.settle).toMatchObject({
      outcome: "unsettled_no_retries",
      stop_reason: "no_delay_fits",
      attempts: 1,
      waited_ms: 0,
      window_ms: 4_999,
    });
    expect(result.text).toContain(
      "postflight_host: blade verdict=blocked settle=unsettled_no_retries stop_reason=no_delay_fits",
    );
  });

  test("the eight-attempt backstop executes even when the settle window is wider", async () => {
    const homeRoot = await makeTempRoot();
    const sleep = vi.fn(async (_ms: number) => {});
    const runFreshnessCommand = vi.fn(async (options: { host?: string }) =>
      freshnessRestartingJson(options.host ?? "unknown"));

    const result = await runSelfUpgradeFleet(
      { hosts: ["blade"], postflightSettleWindowMs: 1_000_000 },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
        ],
        listDescriptors: async () => [],
        runFreshnessCommand,
        sleep,
        monotonicNowMs: () => 0,
        execFileAsync: vi.fn(async () => ({ stdout: successJson("blade"), stderr: "" })),
      },
    );

    expect(runFreshnessCommand).toHaveBeenCalledTimes(8);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([
      5_000,
      15_000,
      25_000,
      25_000,
      25_000,
      25_000,
      25_000,
    ]);
    expect(result.receipt.postflight).toMatchObject({
      status: "completed",
      freshness_exit_code: 6,
      settle: { hosts_probed: 1, unsettled_after_retries: 1, probe_error: 0 },
    });
    expect(result.receipt.postflight?.per_host[0]?.settle).toMatchObject({
      outcome: "unsettled_after_retries",
      stop_reason: "attempt_backstop",
      attempts: 8,
      waited_ms: 145_000,
      window_ms: 1_000_000,
    });
    expect(result.receipt.postflight?.per_host[0]?.settle?.probes).toHaveLength(8);
    expect(result.text).toContain(
      "postflight_host: blade verdict=blocked settle=unsettled_after_retries stop_reason=attempt_backstop attempts=8 waited_ms=145000",
    );
  });

  test("a zero settle window keeps the first probe durable and says so", async () => {
    const homeRoot = await makeTempRoot();
    const sleep = vi.fn(async (_ms: number) => {});
    const runFreshnessCommand = vi.fn(async (options: { host?: string }) =>
      freshnessRestartingJson(options.host ?? "unknown"));

    const result = await runSelfUpgradeFleet(
      { hosts: ["blade"], postflightSettleWindowMs: 0 },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
        ],
        listDescriptors: async () => [],
        runFreshnessCommand,
        sleep,
        monotonicNowMs: () => 0,
        execFileAsync: vi.fn(async () => ({ stdout: successJson("blade"), stderr: "" })),
      },
    );

    expect(sleep).not.toHaveBeenCalled();
    expect(runFreshnessCommand).toHaveBeenCalledTimes(1);
    expect(result.receipt.postflight?.settle).toMatchObject({
      window_ms: 0,
      hosts_probed: 1,
      unsettled_no_retries: 1,
      unsettled_after_retries: 0,
      probe_error: 0,
      total_waited_ms: 0,
    });
    expect(result.receipt.postflight?.per_host[0]?.settle).toMatchObject({
      outcome: "unsettled_no_retries",
      stop_reason: "retries_disabled",
      attempts: 1,
      waited_ms: 0,
    });
    expect(result.text).toContain(
      "postflight_host: blade verdict=blocked settle=unsettled_no_retries stop_reason=retries_disabled attempts=1 waited_ms=0",
    );
  });

  test("records postflight failure explicitly when self freshness cannot prove the rollout", async () => {
    const homeRoot = await makeTempRoot();
    const eventProjection = createFleetEventProjectionBarrier();
    const now = vi.fn()
      .mockReturnValueOnce("2026-04-20T12:05:00.000Z")
      .mockReturnValueOnce("2026-04-20T12:05:01.000Z")
      .mockReturnValueOnce("2026-04-20T12:05:02.000Z");

    const result = await runSelfUpgradeFleet(
      { hosts: ["blade"] },
      {
        homeDir: () => homeRoot,
        now,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
        ],
        listDescriptors: async () => [],
        authToken: "secret-token",
        appendEventProjection: eventProjection.appendEventProjection,
        runFreshnessCommand: vi.fn(async () => {
          throw new Error("freshness collector exploded");
        }),
        execFileAsync: vi.fn(async () => ({
          stdout: successJson("blade"),
          stderr: "",
        })),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.receipt.status).toBe("failed");
    expect(result.failureMessage).toBe(
      "Postflight probing failed for blade: freshness collector exploded",
    );
    expect(result.receipt.postflight).toMatchObject({
      schema_version: "self-upgrade-fleet-postflight/v1",
      status: "failed",
      checked_at: "2026-04-20T12:05:02.000Z",
      freshness_exit_code: null,
      summary: { fresh: 0, usable_with_warnings: 0, stale: 0, blocked: 0 },
      settle: { hosts_probed: 1, probe_error: 1 },
      error: "Postflight probing failed for blade: freshness collector exploded",
      per_host: [
        {
          host: "blade",
          upgrade_status: "succeeded",
          error: "freshness collector exploded",
          settle: {
            outcome: "probe_error",
            stop_reason: "probe_error",
            attempts: 1,
            probes: [{
              status: "error",
              attempt: 1,
              error: {
                code: "freshness_command_failed",
                message: "freshness collector exploded",
                occurred_at: "2026-04-20T12:05:01.000Z",
              },
            }],
            error: {
              code: "freshness_command_failed",
              message: "freshness collector exploded",
              occurred_at: "2026-04-20T12:05:01.000Z",
            },
          },
        },
      ],
    });
    expect(result.text).toContain(
      "postflight_host: blade verdict=unknown settle=probe_error stop_reason=probe_error attempts=1",
    );
    expect(result.text).toContain("probe_results=error:freshness_command_failed");
    expect(result.text).toContain(
      "postflight_error: Postflight probing failed for blade: freshness collector exploded",
    );
    await eventProjection.flush();
    const events = (await readFile(
      path.join(homeRoot, ".calyx", "runs", "events.index.jsonl"),
      "utf8",
    ))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event_type: string; control: { error?: string } });
    expect(events.at(-1)).toMatchObject({
      event_type: "daemon.upgrade.fleet.failed",
      control: { error: "Postflight probing failed for blade: freshness collector exploded" },
    });
  });

  test("a missing first-probe host row is typed without suppressing later hosts", async () => {
    const homeRoot = await makeTempRoot();
    const runFreshnessCommand = vi.fn(async (options: { host?: string }) => {
      const host = options.host ?? "unknown";
      return host === "blade"
        ? freshnessJson("unexpected-host", "fresh", "2026-04-20T12:06:01.000Z")
        : freshnessJson(host, "fresh", "2026-04-20T12:06:02.000Z");
    });

    const result = await runSelfUpgradeFleet(
      {},
      {
        homeDir: () => homeRoot,
        now: vi.fn()
          .mockReturnValueOnce("2026-04-20T12:06:00.000Z")
          .mockReturnValueOnce("2026-04-20T12:06:01.500Z")
          .mockReturnValueOnce("2026-04-20T12:06:03.000Z"),
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
          { host: "worm", runServeUrl: "http://worm:8740" },
        ],
        listDescriptors: async () => [],
        runFreshnessCommand,
        monotonicNowMs: () => 0,
        execFileAsync: vi.fn(async (_file, args) => ({
          stdout: successJson(extractSshHost(args)),
          stderr: "",
        })),
      },
    );

    expect(runFreshnessCommand.mock.calls.map((call) => call[0].host)).toEqual([
      "blade",
      "worm",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.receipt.status).toBe("failed");
    expect(result.failureMessage).toBe(
      "Postflight probing failed for blade: self freshness did not return a row for upgraded host blade",
    );
    expect(result.receipt.postflight).toMatchObject({
      status: "failed",
      checked_at: "2026-04-20T12:06:03.000Z",
      freshness_exit_code: null,
      summary: { fresh: 1, usable_with_warnings: 0, stale: 0, blocked: 0 },
      settle: { hosts_probed: 2, settled_first_probe: 1, probe_error: 1 },
      per_host: [
        {
          host: "blade",
          upgrade_status: "succeeded",
          error: "self freshness did not return a row for upgraded host blade",
          settle: {
            outcome: "probe_error",
            stop_reason: "probe_error",
            attempts: 1,
            probes: [{
              status: "error",
              attempt: 1,
              error: {
                code: "missing_host_result",
                message: "self freshness did not return a row for upgraded host blade",
                occurred_at: "2026-04-20T12:06:01.500Z",
              },
            }],
          },
        },
        {
          host: "worm",
          upgrade_status: "succeeded",
          freshness_verdict: "fresh",
          settle: { outcome: "settled_first_probe", stop_reason: "settled" },
        },
      ],
    });
    expect(result.receipt.postflight?.per_host[0]).not.toHaveProperty("freshness_verdict");
    expect(result.text).toContain(
      "postflight_host: blade verdict=unknown settle=probe_error stop_reason=probe_error",
    );
    expect(result.text).not.toContain("postflight_host: worm");
  });

  test("partial failure persists pending daemon convergence rows for failed and skipped hosts", async () => {
    const homeRoot = await makeTempRoot();
    const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]] as const));
    process.env.CALYX_STATE_HOME = path.join(homeRoot, "state");
    delete process.env.CALYX_STATE_DB;
    await applyStateMigrations();

    const execFileAsync = vi.fn(async (_file, args) => {
      const host = extractSshHost(args);
      if (host === "worm") {
        throw {
          code: 255,
          stdout: "",
          stderr: "ssh: connect to host worm port 22: Operation timed out\n",
        };
      }
      return { stdout: successJson(host), stderr: "" };
    });

    try {
      const result = await runSelfUpgradeFleet(
        {
          failFast: true,
        },
        {
          homeDir: () => homeRoot,
          now: vi.fn()
            .mockReturnValueOnce("2026-06-10T19:00:00.000Z")
            .mockReturnValueOnce("2026-06-10T19:05:00.000Z"),
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
          listRunServeHosts: async () => [
            { host: "blade", runServeUrl: "http://blade:8740" },
            { host: "worm", runServeUrl: "http://worm:8740" },
            { host: "mba", runServeUrl: "http://mba:8740" },
          ],
        listDescriptors: async () => [],
        execFileAsync,
        resolveConductorCheckoutSha: async () => CHECKOUT_HEAD,
        persistConvergence: true,
      },
      );

      expect(result.exitCode).toBe(1);

      const opened = await openStateStore();
      try {
        const rows = listFleetConvergenceRows(opened.db);
        expect(rows.map((row) => [row.host, row.leg, row.verdict])).toEqual([
          ["mba", "daemon_build", "pending"],
          ["worm", "daemon_build", "pending"],
        ]);
        for (const row of rows) {
          expect(row).toMatchObject({
            target_rev: STABLE_TARGET_SHA,
            converged_from: CHECKOUT_HEAD,
            policy: "auto",
            last_checked_at: "2026-06-10T19:05:00.000Z",
            receipt_path: result.receipt_path,
          });
        }
        expect(rows.find((row) => row.host === "worm")?.detail).toContain("Operation timed out");
        expect(rows.find((row) => row.host === "mba")?.detail).toContain("Skipped because --fail-fast");
      } finally {
        opened.db.close();
      }
    } finally {
      for (const key of ENV_KEYS) {
        const value = previousEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("dry-run partial failures do not persist pending convergence rows", async () => {
    const homeRoot = await makeTempRoot();
    const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]] as const));
    process.env.CALYX_STATE_HOME = path.join(homeRoot, "state");
    delete process.env.CALYX_STATE_DB;
    await applyStateMigrations();

    const execFileAsync = vi.fn(async (_file, args) => {
      const host = extractSshHost(args);
      if (host === "worm") {
        throw {
          code: 255,
          stdout: "",
          stderr: "ssh: connect to host worm port 22: Operation timed out\n",
        };
      }
      return { stdout: dryRunJson(host), stderr: "" };
    });

    try {
      const result = await runSelfUpgradeFleet(
        {
          dryRun: true,
          failFast: true,
        },
        {
          homeDir: () => homeRoot,
          now: vi.fn()
            .mockReturnValueOnce("2026-06-10T19:00:00.000Z")
            .mockReturnValueOnce("2026-06-10T19:05:00.000Z"),
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
          resolveConductorCheckoutSha: async () => CHECKOUT_HEAD,
          listRunServeHosts: async () => [
            { host: "worm", runServeUrl: "http://worm:8740" },
            { host: "mba", runServeUrl: "http://mba:8740" },
          ],
          listDescriptors: async () => [],
          execFileAsync,
          persistConvergence: true,
        },
      );

      expect(result.exitCode).toBe(1);
      const opened = await openStateStore();
      try {
        expect(listFleetConvergenceRows(opened.db)).toEqual([]);
      } finally {
        opened.db.close();
      }
    } finally {
      for (const key of ENV_KEYS) {
        const value = previousEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("pending-row persistence failures do not mask fleet upgrade outcomes", async () => {
    const homeRoot = await makeTempRoot();
    const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]] as const));
    process.env.CALYX_STATE_HOME = path.join(homeRoot, "state");
    delete process.env.CALYX_STATE_DB;

    const execFileAsync = vi.fn(async (_file, args) => {
      const host = extractSshHost(args);
      if (host === "worm") {
        throw {
          code: 255,
          stdout: "",
          stderr: "ssh: connect to host worm port 22: Operation timed out\n",
        };
      }
      return { stdout: successJson(host), stderr: "" };
    });

    try {
      const result = await runSelfUpgradeFleet(
        {
          failFast: true,
        },
        {
          homeDir: () => homeRoot,
          now: vi.fn()
            .mockReturnValueOnce("2026-06-10T19:00:00.000Z")
            .mockReturnValueOnce("2026-06-10T19:05:00.000Z"),
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
          resolveConductorCheckoutSha: async () => CHECKOUT_HEAD,
          listRunServeHosts: async () => [
            { host: "blade", runServeUrl: "http://blade:8740" },
            { host: "worm", runServeUrl: "http://worm:8740" },
            { host: "mba", runServeUrl: "http://mba:8740" },
          ],
          listDescriptors: async () => [],
          execFileAsync,
          persistConvergence: true,
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.failureMessage).toBe("1 host(s) failed: worm");
      expect(result.warnings?.[0]).toMatchObject({
        code: "fleet_convergence_persist_unavailable",
      });
    } finally {
      for (const key of ENV_KEYS) {
        const value = previousEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("subset mode limits execution to the requested hosts", async () => {
    const homeRoot = await makeTempRoot();
    const execFileAsync = vi.fn(async (_file, args) => ({
      stdout: successJson(extractSshHost(args)),
      stderr: "",
    }));

    const result = await runSelfUpgradeFleet(
      {
        hosts: ["blade,worm"],
      },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
          { host: "worm", runServeUrl: "http://worm:8740" },
          { host: "carbon", runServeUrl: "http://carbon:8740" },
        ],
        listDescriptors: async () => [],
        execFileAsync,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(execFileAsync.mock.calls.map((call) => extractSshHost(call[1] as readonly unknown[]))).toEqual(["blade", "worm"]);
    expect(result.receipt.per_host.map((entry) => entry.host)).toEqual(["blade", "worm"]);
  });

  test("fail-fast stops after the first host error in serial mode", async () => {
    const homeRoot = await makeTempRoot();
    const execFileAsync = vi.fn(async (_file, args) => {
      const host = extractSshHost(args);
      if (host === "worm") {
        throw {
          code: 9,
          stdout: failureJson(host),
          stderr: "worm stderr",
        };
      }
      return { stdout: successJson(host), stderr: "" };
    });

    const result = await runSelfUpgradeFleet(
      {
        failFast: true,
      },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
          { host: "worm", runServeUrl: "http://worm:8740" },
          { host: "carbon", runServeUrl: "http://carbon:8740" },
        ],
        listDescriptors: async () => [],
        execFileAsync,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(execFileAsync).toHaveBeenCalledTimes(2);
    expect(result.receipt.per_host.map((entry) => [entry.host, entry.status])).toEqual([
      ["blade", "succeeded"],
      ["worm", "failed"],
      ["carbon", "skipped"],
    ]);
  });

  test("rejects requested hosts that lack a configured run_serve_url", async () => {
    const homeRoot = await makeTempRoot();

    await expect(
      runSelfUpgradeFleet(
        {
          hosts: ["blade,carbon"],
        },
        {
          homeDir: () => homeRoot,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
          listRunServeHosts: async () => [
            { host: "blade", runServeUrl: "http://blade:8740" },
            { host: "worm", runServeUrl: "http://worm:8740" },
          ],
          listDescriptors: async () => [],
          execFileAsync: vi.fn(),
        },
      ),
    ).rejects.toThrow("missing run_serve_url");
  });

  test.each(["../../escape", "blade/../../escape", "\\\\server\\share", ".", ".."])(
    "rejects configured host alias %s before creating path-derived artifacts",
    async (unsafeHost) => {
      const homeRoot = await makeTempRoot();
      const execFileAsync = vi.fn();
      await expect(runSelfUpgradeFleet(
        {},
        {
          homeDir: () => homeRoot,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: unsafeHost, runServeUrl: "http://invalid:8740" }],
          listDescriptors: async () => [],
          execFileAsync,
        },
      )).rejects.toThrow(/path-safe/u);
      expect(execFileAsync).not.toHaveBeenCalled();
    },
  );

  test("rejects a fleet larger than the durable operation host bound before dispatch", async () => {
    const homeRoot = await makeTempRoot();
    const execFileAsync = vi.fn();
    const targets = Array.from({ length: SELF_UPGRADE_OPERATION_MAX_HOSTS + 1 }, (_, index) => ({
      host: `host-${index}`,
      runServeUrl: `http://host-${index}:8740`,
    }));

    await expect(runSelfUpgradeFleet(
      {},
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        listRunServeHosts: async () => targets,
        listDescriptors: async () => [],
        execFileAsync,
      },
    )).rejects.toThrow(`at most ${SELF_UPGRADE_OPERATION_MAX_HOSTS} hosts`);
    expect(execFileAsync).not.toHaveBeenCalled();
    await expect(readdir(path.join(homeRoot, ".calyx", "self-upgrade-operations"))).rejects.toThrow();
  });

  test("the conductor-resolved target SHA reaches every host as argv and plan (POL-1151)", async () => {
    const homeRoot = await makeTempRoot();
    const sshScripts: string[] = [];
    const plans: RemoteUpgradePlan[] = [];

    const result = await runSelfUpgradeFleet(
      { dryRun: true },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
          { host: "worm", runServeUrl: "http://worm:8740" },
        ],
        listDescriptors: async () => [],
        // Stub the conductor-side SHA resolution. In production this would
        // run `git fetch origin && git rev-parse origin/main` against the
        // conductor's calyx-dev checkout. Test injects the resolved SHA
        // directly to keep execFileAsync mock focused on SSH calls.
        resolveConductorTargetSha: async () => "deadbeefcafef00d1234567890abcdef12345678",
        execFileAsync: vi.fn(async (_file, args, options) => {
          // The pinned SHA reaches the host twice, and both must agree: as the
          // preamble's fourth positional argument, and inside the plan.
          sshScripts.push(String(args[args.length - 1]));
          plans.push(dispatchedPlan(options));
          return {
            stdout: dryRunJson(extractSshHost(args)),
            stderr: "",
          };
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(sshScripts).toHaveLength(2);
    for (const script of sshScripts) {
      expect(script.endsWith(" 'deadbeefcafef00d1234567890abcdef12345678'")).toBe(true);
    }
    for (const plan of plans) {
      expect(plan.target.target_sha).toBe("deadbeefcafef00d1234567890abcdef12345678");
    }
  });

  test("fleet dry-run carries conductor-only target contract evidence and persists aggregate verdicts", async () => {
    const homeRoot = await makeTempRoot();
    const plans: RemoteUpgradePlan[] = [];
    const payload = await buildTargetStartupContractPayload(
      STABLE_TARGET_SHA,
      "/conductor-only-repo",
      async (args) => args[0] === "show"
        ? { code: 0, stdout: "{not-json", stderr: "" }
        : { code: 1, stdout: "", stderr: "" },
    );

    const result = await runSelfUpgradeFleet(
      { dryRun: true },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => STABLE_TARGET_SHA,
        resolveConductorStartupContractPayload: async () => payload,
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
        ],
        listDescriptors: async () => [],
        execFileAsync: vi.fn(async (_file, args, options) => {
          plans.push(dispatchedPlan(options));
          const host = extractSshHost(args);
          return { stdout: targetInvalidDryRunJson(host), stderr: "" };
        }),
      },
    );

    expect(plans).toHaveLength(1);
    expect(plans[0]?.startup_contract_payload).toBe(payload);
    expect(result.receipt.startup_contract).toEqual({
      total_hosts: 1,
      compatible: 0,
      incompatible: 0,
      unknown_blocked: 1,
      unknown_nonblocking: 0,
      unassessed: 0,
      compatible_hosts: [],
      incompatible_hosts: [],
      unknown_blocked_hosts: ["blade"],
      unknown_nonblocking_hosts: [],
      unassessed_hosts: [],
    });
    expect(result.receipt.per_host[0]?.plan?.startup_contract).toMatchObject({
      status: "unknown",
      mutation_disposition: "block",
      contract_invalid_kind: "manifest_missing",
      blocking_reasons: [expect.objectContaining({ code: "target_contract_invalid" })],
    });
    expect(result.text).toContain(
      "startup_contract: compatible=0 incompatible=0 unknown_blocked=1 unknown_nonblocking=0 unassessed=0 unknown_blocked_hosts=blade",
    );
    const persisted = JSON.parse(await readFile(result.receipt_path, "utf8")) as {
      startup_contract: typeof result.receipt.startup_contract;
    };
    expect(persisted.startup_contract).toEqual(result.receipt.startup_contract);
  });

  test("--drain-all reaches every host's plan (POL-2048)", async () => {
    const homeRoot = await makeTempRoot();
    const plans: RemoteUpgradePlan[] = [];

    const result = await runSelfUpgradeFleet(
      { dryRun: true, drainAll: true },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
          { host: "worm", runServeUrl: "http://worm:8740" },
        ],
        listDescriptors: async () => [],
        execFileAsync: vi.fn(async (_file, args, options) => {
          plans.push(dispatchedPlan(options));
          return {
            stdout: dryRunJson(extractSshHost(args)),
            stderr: "",
          };
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(plan.request.drain_all).toBe(true);
    }
  });

  test("the remote command carries the frozen preamble and exactly four positional arguments", async () => {
    const homeRoot = await makeTempRoot();
    const sshScripts: string[] = [];
    const plans: RemoteUpgradePlan[] = [];

    const result = await runSelfUpgradeFleet(
      { dryRun: true },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        listRunServeHosts: async () => [
          { host: "worm", runServeUrl: "http://worm:8740" },
        ],
        listDescriptors: async () => [],
        resolveConductorTargetSha: async () => undefined,
        execFileAsync: vi.fn(async (_file, args, options) => {
          expect(String(args[args.length - 1])).toMatch(/^bash -c '/u);
          sshScripts.push(String(args[args.length - 1]));
          plans.push(dispatchedPlan(options));
          return { stdout: dryRunJson(extractSshHost(args)), stderr: "" };
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(sshScripts).toHaveLength(1);
    const command = sshScripts[0]!;
    // Four positional arguments after `bash -c <script> <argv0>`, in the frozen
    // order, and nothing else. The remote never sees a flag it must recognise,
    // which is the entire reason this dispatch survives a version gap.
    const positional = command.slice(command.lastIndexOf("' calyx-upgrade-preamble ") + 2).split(" ");
    expect(positional[0]).toBe("calyx-upgrade-preamble");
    expect(positional).toHaveLength(5);
    expect(positional.slice(1)).toEqual([
      "'/srv/worm/calyx'",
      "'origin'",
      "'main'",
      `'${STABLE_TARGET_SHA}'`,
    ]);
    // Nothing about the *upgrade* is expressible in the remote command: no
    // subcommand, no option, no environment assignment, no path to an
    // installed build whose vocabulary the conductor would have to know.
    expect(command).not.toContain("self upgrade");
    expect(command).not.toContain("$HOME/.agents/run/calyx");
    expect(command).not.toContain("CALYX_SELF_UPGRADE_FLEET_OPERATION_ID=");
    for (const flag of [
      "--host",
      "--to",
      "--json",
      "--dry-run",
      "--target-sha",
      "--target-fetch-remote",
      "--target-fetch-ref",
      "--startup-contract-payload",
      "--drain-deadline",
      "--force",
      "--abort-runs",
      "--drain-all",
      "--continuous",
      "--yes",
    ]) {
      expect(command, `remote command must not name ${flag}`).not.toContain(flag);
    }
    // ...and the preamble reaches the agent by way of the fetched commit, never
    // the installed one.
    expect(command).toContain("git clone --quiet --shared --no-checkout");
    expect(command).toContain("scripts/calyx-upgrade-agent.mjs");
    expect(command).toContain("exec \"$__calyx_node\"");
    // The relay stays private process context; the agent, not the conductor,
    // turns it into the planner's environment.
    expect(plans[0]?.progress_relay).toEqual({ schema: "self-upgrade-operation/v1" });
    expect(plans[0]?.fleet_operation_id).toBe(extractFleetOperationId([command]));
  });

  test("force and abort-run reach the host's plan for one-host dispatch", async () => {
    const homeRoot = await makeTempRoot();
    const plans: RemoteUpgradePlan[] = [];

    const result = await runSelfUpgradeFleet(
      { dryRun: true, force: true, abortRuns: true, hosts: ["blade"] },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
          { host: "worm", runServeUrl: "http://worm:8740" },
        ],
        listDescriptors: async () => [],
        resolveConductorTargetSha: async () => undefined,
        execFileAsync: vi.fn(async (_file, args, options) => {
          plans.push(dispatchedPlan(options));
          return { stdout: dryRunJson(extractSshHost(args)), stderr: "" };
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.receipt.per_host.map((entry) => entry.host)).toEqual(["blade"]);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.request).toMatchObject({ force: true, abort_runs: true });
  });

  test("explicit options.targetSha overrides the conductor's auto-resolution (POL-1151)", async () => {
    const homeRoot = await makeTempRoot();
    const plans: RemoteUpgradePlan[] = [];
    const conductorResolveSpy = vi.fn(async () => "auto-resolved-sha-should-not-be-used");
    const explicitTargetSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    const result = await runSelfUpgradeFleet(
      { dryRun: true, targetSha: explicitTargetSha },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
        ],
        listDescriptors: async () => [],
        resolveConductorTargetSha: conductorResolveSpy,
        execFileAsync: vi.fn(async (_file, args, options) => {
          plans.push(dispatchedPlan(options));
          return { stdout: dryRunJson(extractSshHost(args), explicitTargetSha), stderr: "" };
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    // Even an explicit SHA uses the conductor resolver for normalized fetch
    // provenance, while retaining the operator-supplied SHA as authority.
    expect(conductorResolveSpy).toHaveBeenCalledWith("origin/main", "conductor");
    expect(plans[0]?.target.target_sha).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  test("fresh FETCH_HEAD outranks a stale local main branch", async () => {
    const fixtureRoot = await makeTempRoot();
    const origin = path.join(fixtureRoot, "origin.git");
    const seed = path.join(fixtureRoot, "seed");
    const conductor = path.join(fixtureRoot, "conductor");
    const runGit = async (cwd: string, args: string[]) => {
      const result = await execFile("git", args, { cwd, encoding: "utf8" });
      return result.stdout.trim();
    };
    await execFile("git", ["init", "--bare", origin], { encoding: "utf8" });
    await execFile("git", ["init", seed], { encoding: "utf8" });
    await runGit(seed, ["config", "user.email", "fixture@example.test"]);
    await runGit(seed, ["config", "user.name", "Fixture"]);
    await mkdir(path.join(seed, "packages", "core"), { recursive: true });
    await writeFile(
      path.join(seed, "packages", "core", "startup-contract.json"),
      `${JSON.stringify(CALYX_SERVER_STARTUP_CONTRACT)}\n`,
      "utf8",
    );
    await writeFile(path.join(seed, "target.txt"), "one\n", "utf8");
    await runGit(seed, ["add", "."]);
    await runGit(seed, ["commit", "-m", "one"]);
    await runGit(seed, ["branch", "-M", "main"]);
    await runGit(seed, ["remote", "add", "origin", origin]);
    await runGit(seed, ["push", "-u", "origin", "main"]);
    await execFile("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], { encoding: "utf8" });
    await execFile("git", ["clone", origin, conductor], { encoding: "utf8" });
    const staleMain = await runGit(conductor, ["rev-parse", "main"]);

    await writeFile(path.join(seed, "target.txt"), "two\n", "utf8");
    await runGit(seed, ["commit", "-am", "two"]);
    await runGit(seed, ["push", "origin", "main"]);
    const remoteTip = await runGit(seed, ["rev-parse", "HEAD"]);

    const resolved = await resolveFetchedConductorTargetSha(conductor, "main", execFile);
    expect(resolved).toBe(remoteTip);
    expect(resolved).not.toBe(staleMain);
    expect(await runGit(conductor, ["rev-parse", "main"])).toBe(staleMain);

    const payload = await buildTargetStartupContractPayload(resolved, conductor, async (args, cwd) => {
      try {
        const result = await execFile("git", args, { cwd, encoding: "utf8" });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const typed = error as { code?: number; stdout?: string; stderr?: string };
        return { code: typed.code ?? 1, stdout: typed.stdout ?? "", stderr: typed.stderr ?? "" };
      }
    });
    const decodedPayload = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { target_sha: string };
    expect(decodedPayload.target_sha).toBe(remoteTip);

    const runFreshnessCommand = vi.fn(async () => freshnessJson("blade"));
    const fleet = await runSelfUpgradeFleet(
      { to: "main" },
      {
        homeDir: () => fixtureRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveCurrentHostAlias: async () => "conductor",
        resolveConductorTargetSha: async () => resolved,
        resolveConductorStartupContractPayload: async () => payload,
        listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
        listDescriptors: async () => [],
        runFreshnessCommand,
        execFileAsync: vi.fn(async () => ({ stdout: successJson("blade", remoteTip, "main"), stderr: "" })),
      },
    );
    expect(fleet.receipt.target_evidence).toMatchObject({ status: "resolved", target_sha: remoteTip });
    expect(runFreshnessCommand).toHaveBeenCalledWith(
      { host: "blade", against: remoteTip, json: true },
      { authToken: "" },
    );
  });

  test("fresh FETCH_HEAD survives a non-default remote-tracking refmap", async () => {
    const fixtureRoot = await makeTempRoot();
    const origin = path.join(fixtureRoot, "origin.git");
    const seed = path.join(fixtureRoot, "seed");
    const conductor = path.join(fixtureRoot, "conductor");
    const runGit = async (cwd: string, args: string[]) => {
      const result = await execFile("git", args, { cwd, encoding: "utf8" });
      return result.stdout.trim();
    };
    await execFile("git", ["init", "--bare", origin], { encoding: "utf8" });
    await execFile("git", ["init", seed], { encoding: "utf8" });
    await runGit(seed, ["config", "user.email", "fixture@example.test"]);
    await runGit(seed, ["config", "user.name", "Fixture"]);
    await writeFile(path.join(seed, "target.txt"), "one\n", "utf8");
    await runGit(seed, ["add", "target.txt"]);
    await runGit(seed, ["commit", "-m", "one"]);
    await runGit(seed, ["branch", "-M", "main"]);
    await runGit(seed, ["remote", "add", "origin", origin]);
    await runGit(seed, ["push", "-u", "origin", "main"]);
    await execFile("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], { encoding: "utf8" });
    await execFile("git", ["clone", origin, conductor], { encoding: "utf8" });
    await runGit(conductor, ["config", "--unset-all", "remote.origin.fetch"]);
    await runGit(conductor, ["config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/remotes/cache/*"]);
    await runGit(conductor, ["fetch", "origin"]);
    const staleCacheMain = await runGit(conductor, ["rev-parse", "cache/main"]);

    await writeFile(path.join(seed, "target.txt"), "two\n", "utf8");
    await runGit(seed, ["commit", "-am", "two"]);
    await runGit(seed, ["push", "origin", "main"]);
    const remoteTip = await runGit(seed, ["rev-parse", "HEAD"]);

    const evidence = await resolveFetchedConductorTargetEvidence(conductor, "cache/main", execFile);
    expect(evidence).toEqual({
      original_ref: "cache/main",
      target_sha: remoteTip,
      fetch_remote: "origin",
      fetch_ref: "refs/heads/main",
    });
    expect(evidence.target_sha).not.toBe(staleCacheMain);

    const scripts: string[] = [];
    const plans: RemoteUpgradePlan[] = [];
    for (const dryRun of [true, false]) {
      const result = await runSelfUpgradeFleetCommand(
        { to: "cache/main", ...(dryRun ? { dryRun: true } : {}) },
        {
          homeDir: () => fixtureRoot,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveRemoteCloneRoot: async (host: string) => `/srv/${host}/calyx`,
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          resolveConductorTargetEvidence: async () => evidence,
          resolveConductorStartupContractPayload: async () => validStartupContractPayload(remoteTip),
          runFreshnessCommand: async (options) => freshnessJson(options.host ?? "unknown"),
          verifyRemoteReceipt: async (host, receiptPath, receipt, _runServeUrl, fleetOperationId) => ({
            receipt: bindCanonicalReceipt(receipt, receiptPath, fleetOperationId),
            locator: {
              host,
              route: `/v1/admin/self-upgrade-receipts/${path.posix.basename(receiptPath, ".json")}`,
            },
          }),
          execFileAsync: vi.fn(async (_file, args, options) => {
            scripts.push(String(args[args.length - 1]));
            plans.push(dispatchedPlan(options));
            return {
              stdout: dryRun
                ? dryRunJson("blade", remoteTip, "cache/main", evidence)
                : successJson("blade", remoteTip, "cache/main", evidence),
              stderr: "",
            };
          }),
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.receipt.target_evidence).toMatchObject({
        original_ref: "cache/main",
        target_sha: remoteTip,
        fetch_remote: "origin",
        fetch_ref: "refs/heads/main",
      });
    }
    expect(scripts).toHaveLength(2);
    for (const script of scripts) {
      // The normalized remote/ref travel as the preamble's own `$2`/`$3`: they
      // are what it fetches with, so they cannot be a flag the remote must
      // already understand.
      expect(script).toContain(" 'origin' 'refs/heads/main' ");
    }
    for (const plan of plans) {
      expect(plan.target).toMatchObject({ fetch_remote: "origin", fetch_ref: "refs/heads/main" });
    }
  });

  test("conductor target resolution failure persists a typed non-verdict and dispatches zero hosts", async () => {
    const homeRoot = await makeTempRoot();
    const sshScripts: string[] = [];

    const result = await runSelfUpgradeFleetCommand(
      { dryRun: true },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveRemoteCloneRoot: async (host: string) => `/srv/${host}/calyx`,
        resolveCurrentHostAlias: async () => "conductor",
        listRunServeHosts: async () => [
          { host: "blade", runServeUrl: "http://blade:8740" },
        ],
        listDescriptors: async () => [],
        resolveConductorTargetEvidence: async () => undefined,
        resolveConductorStartupContractPayload: async () => {
          throw new Error("payload resolver must not run");
        },
        execFileAsync: vi.fn(async (_file, args) => {
          sshScripts.push(String(args[args.length - 1]));
          return { stdout: dryRunJson(extractSshHost(args)), stderr: "" };
        }),
      },
    );

    expect(result.exitCode).toBe(6);
    expect(sshScripts).toHaveLength(0);
    expect(result.receipt.target_evidence).toMatchObject({
      status: "failed",
      error_code: "target_sha_unavailable",
    });
    expect(result.receipt.startup_contract).toMatchObject({
      total_hosts: 1,
      unassessed: 1,
      unassessed_hosts: ["blade"],
    });
    expect(result.receipt.per_host).toEqual([expect.objectContaining({ host: "blade", status: "skipped" })]);
    const persisted = JSON.parse(await readFile(result.receipt_path, "utf8")) as typeof result.receipt;
    expect(persisted.target_evidence).toEqual(result.receipt.target_evidence);
  });

  test("malformed conductor startup-contract evidence dispatches zero hosts", async () => {
    const homeRoot = await makeTempRoot();
    const execFileAsync = vi.fn();
    const result = await runSelfUpgradeFleetCommand(
      { dryRun: true },
      {
        homeDir: () => homeRoot,
        resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
        resolveRemoteCloneRoot: async (host: string) => `/srv/${host}/calyx`,
        resolveCurrentHostAlias: async () => "conductor",
        listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
        listDescriptors: async () => [],
        resolveConductorTargetEvidence: async (targetRef) => testTargetEvidence(targetRef, STABLE_TARGET_SHA),
        resolveConductorStartupContractPayload: async () => "not-base64url-json",
        execFileAsync,
      },
    );

    expect(result.exitCode).toBe(6);
    expect(execFileAsync).not.toHaveBeenCalled();
    expect(result.receipt.target_evidence).toMatchObject({
      status: "failed",
      error_code: "startup_contract_evidence_unavailable",
    });
  });

  describe("POL-2046 durable progress relay", () => {
    const fixedNow = "2026-07-21T10:00:00.000Z";

    function phaseLine(args: {
      operationId: string;
      host: string;
      phase: "build" | "restart";
      elapsedMs: number;
      eventId: string;
    }): string {
      const observation = {
        schema_version: "self-upgrade-operation/v1",
        record: "transition",
        kind: "host_phase",
        operation_id: args.operationId,
        emitted_at: fixedNow,
        observed_at: fixedNow,
        host: args.host,
        host_operation_id: `host-op-${args.host}`,
        source_event_id: args.eventId,
        source_cursor: `cursor-${args.eventId}`,
        source: "host_event",
        phase: args.phase,
        elapsed_ms: args.elapsedMs,
        synthetic: false,
      } satisfies Omit<SelfUpgradeHostPhaseTransition, "transition_id">;
      const transition: SelfUpgradeHostPhaseTransition = {
        ...observation,
        transition_id: selfUpgradeHostPhaseTransitionId(observation),
      };
      return encodeSelfUpgradeOperationTransition(transition).trimEnd();
    }

    test("fake SSH stream is idempotent under duplicate and reordered phase frames", async () => {
      const homeRoot = await makeTempRoot();
      const progress: string[] = [];
      let monotonicMs = 0;

      const result = await runSelfUpgradeFleet(
        { json: true },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          monotonicNowMs: () => monotonicMs,
          heartbeatIntervalMs: 0,
          progressWrite: (chunk) => progress.push(chunk),
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          runFreshnessCommand: async () => freshnessJson("blade"),
          execFileAsync: vi.fn(async (_file, _args, options) => {
            const operationId = (JSON.parse(progress[0]!) as { operation_id: string }).operation_id;
            const restart = phaseLine({ operationId, host: "blade", phase: "restart", elapsedMs: 8_000, eventId: "restart" });
            const build = phaseLine({ operationId, host: "blade", phase: "build", elapsedMs: 2_000, eventId: "build" });
            options?.onStderrLine?.(restart);
            options?.onStderrLine?.(build);
            options?.onStderrLine?.(restart);
            options?.onStderrLine?.("arbitrary ssh diagnostic, not a protocol frame");
            monotonicMs = 9_000;
            return {
              stdout: successJson("blade"),
              stderr: `${restart}\n${build}\n${restart}\narbitrary ssh diagnostic, not a protocol frame\n`,
            };
          }),
        },
      );

      const phaseTransitions = result.operation.transitions.filter((entry) => entry.kind === "host_phase");
      const hostProgress = result.receipt.per_host[0]?.progress_relay;
      const progressRecords = progress.map((line) => JSON.parse(line));

      expect(result.exitCode).toBe(0);
      expect(result.operation.status).toBe("succeeded");
      expect(result.operation_projection).toBe("available");
      expect(result.text).toContain("operation_projection: available");
      expect(result.operation.hosts.blade).toMatchObject({
        execution_status: "succeeded",
        relay_mode: "stream",
        latest_phase: "restart",
        latest_phase_elapsed_ms: 8_000,
      });
      expect(phaseTransitions).toHaveLength(2);
      expect(hostProgress?.phases.map((entry) => entry.phase)).toEqual(["build", "restart"]);
      expect(progressRecords.filter((entry) => entry.record === "host_state" && entry.host.state === "restart")).toHaveLength(1);
      expect(progressRecords.at(-1)).toMatchObject({ record: "fleet_final", status: "succeeded" });
      expect(await readFile(result.receipt.per_host[0]!.stdout_path!, "utf8")).toBe(successJson("blade"));
    });

    test("keeps noncanonical diagnostic JSON in evidence-neutral missing mode", async () => {
      const homeRoot = await makeTempRoot();
      const progress: string[] = [];

      const result = await runSelfUpgradeFleet(
        { json: true, hosts: ["blade"] },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          progressWrite: (chunk) => progress.push(chunk),
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          execFileAsync: vi.fn(async (_file, _args, options) => {
            const operationId = (JSON.parse(progress[0]!) as { operation_id: string }).operation_id;
            const canonical = phaseLine({
              operationId,
              host: "blade",
              phase: "build",
              elapsedMs: 2_000,
              eventId: "noncanonical-diagnostic",
            });
            const parsed = JSON.parse(canonical) as Record<string, unknown>;
            const noncanonical = JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()));
            expect(noncanonical).not.toBe(canonical);
            options?.onStderrLine?.(noncanonical);
            return { stdout: successJson("blade"), stderr: `${noncanonical}\n` };
          }),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.receipt.per_host[0]?.progress_relay).toMatchObject({
        mode: "missing",
        phases: [],
      });
      expect(result.operation.hosts.blade).toMatchObject({
        execution_status: "succeeded",
        relay_mode: "missing",
      });
      expect(result.operation.hosts.blade).not.toHaveProperty("latest_phase");
    });

    test("current-binary final JSON without phase frames stays evidence-neutral", async () => {
      const homeRoot = await makeTempRoot();

      const result = await runSelfUpgradeFleet(
        { hosts: ["blade"] },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          execFileAsync: vi.fn(async () => ({
            stdout: successJson("blade"),
            stderr: "current binary completed without relay frames\n",
          })),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.receipt.per_host[0]?.progress_relay).toEqual({ mode: "missing", phases: [] });
      expect(result.operation.hosts.blade).toMatchObject({
        execution_status: "succeeded",
        relay_mode: "missing",
      });
      expect(result.operation.transitions).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "host_relay_degraded", reason: "pre_relay_binary" }),
      ]));
    });

    test("accepts additive fields in a remote terminal envelope", async () => {
      const homeRoot = await makeTempRoot();
      const payload = JSON.parse(dryRunJson("blade")) as Record<string, unknown>;
      const retainedProjectionIssue = {
        scope: "status_stderr",
        code: "projection_unavailable",
        observed_at: fixedNow,
        message: "status stream was unavailable",
      };
      payload["future_projection_summary"] = {
        schema_version: "future-self-upgrade-projection/v2",
        dropped_frames: 3,
      };
      payload["projection_issues"] = [
        {
          scope: "future_status_channel",
          code: "future_projection_code",
          observed_at: fixedNow,
          message: "a future diagnostic must not invalidate authority",
        },
        {
          ...retainedProjectionIssue,
          future_detail: "untrusted-projection-padding".repeat(4_096),
        },
      ];

      const result = await runSelfUpgradeFleet(
        { hosts: ["blade"], dryRun: true },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          execFileAsync: vi.fn(async () => ({ stdout: `${JSON.stringify(payload)}\n`, stderr: "" })),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.receipt.per_host[0]).toMatchObject({
        host: "blade",
        status: "dry-run",
        projection_issues: [retainedProjectionIssue],
      });
    });

    test("malformed additive plan fields cannot throw after terminal authority", async () => {
      const homeRoot = await makeTempRoot();
      const payload = JSON.parse(dryRunJson("blade")) as {
        plan: Record<string, unknown>;
      };
      delete payload.plan["missing_build_artifacts"];

      const result = await runSelfUpgradeFleet(
        { hosts: ["blade"], dryRun: true },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          execFileAsync: vi.fn(async () => ({ stdout: `${JSON.stringify(payload)}\n`, stderr: "" })),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.receipt.per_host[0]).toMatchObject({ host: "blade", status: "dry-run" });
      expect(result.text).toContain("plan: unavailable for blade");
    });

    test("records a typed remote relay sink failure without inventing binary generation", async () => {
      const homeRoot = await makeTempRoot();
      const payload = JSON.parse(dryRunJson("blade")) as Record<string, unknown>;
      payload.projection_issues = [{
        scope: "remote_phase_stderr",
        code: "projection_unavailable",
        observed_at: fixedNow,
        message: "remote relay EPIPE",
      }];

      const result = await runSelfUpgradeFleet(
        { hosts: ["blade"], dryRun: true },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          execFileAsync: vi.fn(async () => ({ stdout: `${JSON.stringify(payload)}\n`, stderr: "" })),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.receipt.per_host[0]?.progress_relay).toEqual({ mode: "missing", phases: [] });
      expect(result.operation.hosts.blade).toMatchObject({
        execution_status: "dry-run",
        relay_mode: "missing",
      });
      expect(result.operation.transitions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "host_relay_degraded",
          host: "blade",
          reason: "projection_unavailable",
        }),
      ]));
    });

    test("persists a retained host phase before the remote command completes when the observation sink is healthy", async () => {
      const homeRoot = await makeTempRoot();
      const progress: string[] = [];
      let releaseHost: (() => void) | undefined;
      const hostGate = new Promise<void>((resolve) => {
        releaseHost = resolve;
      });
      let signalPhasePersisted: (() => void) | undefined;
      const phasePersisted = new Promise<void>((resolve) => {
        signalPhasePersisted = resolve;
      });
      let operationPath: string | undefined;
      const claimOperation: typeof claimSelfUpgradeOperation = async (root, initialRecord, options) => {
        const writer = await claimSelfUpgradeOperation(root, initialRecord, options);
        operationPath = writer.operationPath;
        return {
          operationPath: writer.operationPath,
          writerId: writer.writerId,
          get record() {
            return writer.record;
          },
          async write(candidate) {
            const persisted = await writer.write(candidate);
            if (
              persisted.transitions.some((transition) => transition.kind === "host_phase")
              && !persisted.transitions.some((transition) => transition.kind === "host_result")
            ) {
              signalPhasePersisted?.();
            }
            return persisted;
          },
          release: () => writer.release(),
        };
      };

      const pending = runSelfUpgradeFleet(
        { json: true, hosts: ["blade"] },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          progressWrite: (chunk) => progress.push(chunk),
          claimOperation,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          execFileAsync: vi.fn(async (_file, _args, options) => {
            const fleetOperationId = (JSON.parse(progress[0]!) as { operation_id: string }).operation_id;
            const line = phaseLine({
              operationId: fleetOperationId,
              host: "blade",
              phase: "build",
              elapsedMs: 2_000,
              eventId: "persist-before-command-completion",
            });
            options?.onStderrLine?.(line);
            await hostGate;
            return { stdout: successJson("blade"), stderr: `${line}\n` };
          }),
        },
      );

      await phasePersisted;
      expect(operationPath).toBeTruthy();
      const observed = await readSelfUpgradeOperation(
        path.dirname(operationPath!),
        path.basename(operationPath!, ".json"),
      );
      expect(observed.status).toBe("running");
      expect(observed.hosts.blade).toMatchObject({
        execution_status: "pending",
        relay_mode: "stream",
        latest_phase: "build",
        latest_phase_elapsed_ms: 2_000,
      });
      expect(observed.transitions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "host_phase",
          host: "blade",
          phase: "build",
        }),
      ]));

      releaseHost?.();
      const result = await pending;
      expect(result.exitCode).toBe(0);
      expect(result.receipt.per_host[0]).toMatchObject({ host: "blade", status: "succeeded" });
      expect(result.operation_projection).toBe("available");
    });

    test("bounds a valid remote frame flood while preserving terminal host authority", async () => {
      const overflowCount = 9;
      const runFlood = async (reverse: boolean) => {
        const homeRoot = await makeTempRoot();
        const progress: string[] = [];
        return runSelfUpgradeFleet(
          { json: true, hosts: ["blade"] },
          {
            homeDir: () => homeRoot,
            now: () => fixedNow,
            heartbeatIntervalMs: 0,
            progressWrite: (chunk) => progress.push(chunk),
            appendEventProjection: async () => {},
            resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
            resolveCurrentHostAlias: async () => "conductor",
            listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
            listDescriptors: async () => [],
            execFileAsync: vi.fn(async (_file, _args, options) => {
              const operationId = (JSON.parse(progress[0]!) as { operation_id: string }).operation_id;
              const lines = Array.from(
                { length: SELF_UPGRADE_OPERATION_MAX_PHASE_TRANSITIONS_PER_HOST + overflowCount },
                (_, index) => phaseLine({
                  operationId,
                  host: "blade",
                  phase: index % 2 === 0 ? "build" : "restart",
                  elapsedMs: index,
                  eventId: `flood-${index}`,
                }),
              );
              if (reverse) lines.reverse();
              for (const line of lines) options?.onStderrLine?.(line);
              return { stdout: successJson("blade"), stderr: `${lines.join("\n")}\n` };
            }),
          },
        );
      };

      const [result, reversed] = await Promise.all([runFlood(false), runFlood(true)]);
      const host = result.receipt.per_host[0]!;
      const reversedHost = reversed.receipt.per_host[0]!;
      expect(result.exitCode).toBe(0);
      expect(reversed.exitCode).toBe(0);
      expect(host.status).toBe("succeeded");
      expect(host.progress_relay).toMatchObject({
        mode: "stream",
        truncated: true,
        dropped_frames: 1,
      });
      expect(host.progress_relay?.phases).toHaveLength(SELF_UPGRADE_OPERATION_MAX_PHASE_TRANSITIONS_PER_HOST);
      expect(reversedHost.progress_relay?.phases.map((phase) => ({
        phase: phase.phase,
        elapsed_ms: phase.elapsed_ms,
        emitted_at: phase.emitted_at,
        synthetic: phase.synthetic,
      }))).toEqual(host.progress_relay?.phases.map((phase) => ({
        phase: phase.phase,
        elapsed_ms: phase.elapsed_ms,
        emitted_at: phase.emitted_at,
        synthetic: phase.synthetic,
      })));
      expect(result.operation.transitions.filter((transition) => transition.kind === "host_phase"))
        .toHaveLength(SELF_UPGRADE_OPERATION_MAX_PHASE_TRANSITIONS_PER_HOST);
      expect(result.operation.hosts.blade).toMatchObject({
        execution_status: "succeeded",
        relay_mode: "stream",
        relay_truncated: true,
      });
    });

    test("bounds live persistence under distinct floods and rejects same-id conflicting bytes", async () => {
      const homeRoot = await makeTempRoot();
      const progress: string[] = [];
      let phaseProjectionAttempts = 0;
      const floodCount = SELF_UPGRADE_OPERATION_MAX_PHASE_TRANSITIONS_PER_HOST * 4;

      const result = await runSelfUpgradeFleet(
        { json: true, hosts: ["blade"] },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          progressWrite: (chunk) => progress.push(chunk),
          appendEventProjection: async (_roots, event) => {
            if (event.event_type === "daemon.upgrade.progress" && event.control.host === "blade") {
              phaseProjectionAttempts += 1;
            }
          },
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          execFileAsync: vi.fn(async (_file, _args, options) => {
            const operationId = (JSON.parse(progress[0]!) as { operation_id: string }).operation_id;
            const lines = Array.from({ length: floodCount }, (_, index) => phaseLine({
              operationId,
              host: "blade",
              phase: index % 2 === 0 ? "build" : "restart",
              elapsedMs: index,
              eventId: `bounded-persistence-${index}`,
            }));
            for (const line of lines) options?.onStderrLine?.(line);

            const canonical = JSON.parse(lines[0]!) as Record<string, unknown>;
            for (let index = 0; index < floodCount; index += 1) {
              options?.onStderrLine?.(JSON.stringify({
                ...canonical,
                phase: index % 2 === 0 ? "restart" : "build",
                elapsed_ms: 100_000 + index,
              }));
            }
            return { stdout: successJson("blade"), stderr: "bounded flood diagnostics omitted" };
          }),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(phaseProjectionAttempts).toBe(SELF_UPGRADE_OPERATION_MAX_PHASE_TRANSITIONS_PER_HOST * 2);
      expect(result.receipt.per_host[0]?.progress_relay).toMatchObject({
        mode: "stream",
        truncated: true,
        dropped_frames: 1,
      });
      expect(result.operation.transitions.filter((transition) => transition.kind === "host_phase"))
        .toHaveLength(SELF_UPGRADE_OPERATION_MAX_PHASE_TRANSITIONS_PER_HOST);
    });

    test("composes real fake-SSH bytes, CRLF/tails, capped capture, parallel heartbeats, and final authority", async () => {
      const homeRoot = await makeTempRoot();
      const progress: string[] = [];

      const result = await runSelfUpgradeFleet(
        { json: true, parallel: true },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 10,
          progressWrite: (chunk) => progress.push(chunk),
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [
            { host: "blade", runServeUrl: "http://blade:8740" },
            { host: "worm", runServeUrl: "http://worm:8740" },
          ],
          listDescriptors: async () => [],
          execFileAsync: vi.fn(async (_file, args, options) => {
            const host = extractSshHost(args);
            const operationId = (JSON.parse(progress[0]!) as { operation_id: string }).operation_id;
            const finalJson = successJson(host);
            const script = host === "blade"
              ? [
                  `const build=${JSON.stringify(phaseLine({ operationId, host, phase: "build", elapsedMs: 4, eventId: "byte-build" }))};`,
                  `const restart=${JSON.stringify(phaseLine({ operationId, host, phase: "restart", elapsedMs: 12, eventId: "byte-restart" }))};`,
                  "process.stderr.write('diagnostic-'.repeat(80)+'\\n');",
                  "process.stderr.write(build.slice(0, 17));",
                  "setTimeout(()=>process.stderr.write(build.slice(17)+'\\r\\n'),4);",
                  "setTimeout(()=>process.stderr.write(restart),12);",
                  `setTimeout(()=>process.stdout.write(${JSON.stringify(finalJson)}),36);`,
                ].join("")
              : `setTimeout(()=>process.stdout.write(${JSON.stringify(finalJson)}),36);`;
            return execSelfUpgradeStreaming(process.execPath, ["-e", script], {
              ...options,
              maxBuffer: 128,
            });
          }),
        },
      );

      const blade = result.receipt.per_host.find((host) => host.host === "blade")!;
      const worm = result.receipt.per_host.find((host) => host.host === "worm")!;
      const progressRecords = progress.map((chunk) => JSON.parse(chunk));
      const heartbeats = progressRecords.filter((record) => record.record === "heartbeat");

      expect(result.exitCode, JSON.stringify(result.receipt.per_host, null, 2)).toBe(0);
      expect(blade).toMatchObject({
        status: "succeeded",
        progress_relay: { mode: "stream" },
        stderr_capture: { truncated: true },
      });
      expect(blade.progress_relay?.phases.map((phase) => phase.phase)).toEqual(["build", "restart"]);
      expect(worm).toMatchObject({ status: "succeeded", progress_relay: { mode: "missing", phases: [] } });
      expect(heartbeats.some((record) => (
        record.hosts.some((host: { host: string; state: string }) => (
          host.host === "worm" && host.state === "awaiting-phase-or-receipt"
        ))
      ))).toBe(true);
      expect(progressRecords.at(-1)).toMatchObject({ record: "fleet_final", status: "succeeded" });
      expect(result.operation.status).toBe("succeeded");
    });

    test.each([
      ["rejected", async () => { throw Object.assign(new Error("diagnostic disk unavailable"), { code: "EIO" }); }],
      ["slow", () => new Promise<void>(() => {})],
    ] as const)("keeps remote success authoritative when artifact writes are %s", async (_kind, writeArtifact) => {
      const homeRoot = await makeTempRoot();
      const result = await runSelfUpgradeFleet(
        { hosts: ["blade"] },
        {
          homeDir: () => homeRoot,
          heartbeatIntervalMs: 0,
          artifactSettleTimeoutMs: 5,
          writeArtifact,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          execFileAsync: vi.fn(async () => ({ stdout: successJson("blade"), stderr: "diagnostic" })),
        },
      );

      const host = result.receipt.per_host[0]!;
      expect(result.exitCode).toBe(0);
      expect(result.operation.status).toBe("succeeded");
      expect(host.status).toBe("succeeded");
      expect(host).not.toHaveProperty("stdout_path");
      expect(host).not.toHaveProperty("stderr_path");
      expect(host.artifact_warnings).toHaveLength(2);
    });

    test("keeps parallel host truth authoritative when the conductor observation write fails", async () => {
      const homeRoot = await makeTempRoot();
      let releaseWorm: (() => void) | undefined;
      const wormGate = new Promise<void>((resolve) => {
        releaseWorm = resolve;
      });
      let wormStarted: (() => void) | undefined;
      const wormStart = new Promise<void>((resolve) => {
        wormStarted = resolve;
      });
      let wormCompleted = false;
      let failedBladeResult = false;
      const claimOperation: typeof claimSelfUpgradeOperation = async (root, initialRecord, options) => {
        const writer = await claimSelfUpgradeOperation(root, initialRecord, options);
        return {
          operationPath: writer.operationPath,
          writerId: writer.writerId,
          get record() {
            return writer.record;
          },
          async write(candidate) {
            if (
              !failedBladeResult
              && candidate.transitions.some((transition) => (
                transition.kind === "host_result" && transition.host === "blade"
              ))
            ) {
              failedBladeResult = true;
              throw new Error("injected blade result authority failure");
            }
            return writer.write(candidate);
          },
          release: () => writer.release(),
        };
      };

      const pending = runSelfUpgradeFleet(
        { parallel: true },
        {
          homeDir: () => homeRoot,
          heartbeatIntervalMs: 0,
          claimOperation,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [
            { host: "blade", runServeUrl: "http://blade:8740" },
            { host: "worm", runServeUrl: "http://worm:8740" },
          ],
          listDescriptors: async () => [],
          execFileAsync: vi.fn(async (_file, args) => {
            const host = extractSshHost(args);
            if (host === "worm") {
              wormStarted?.();
              await wormGate;
              wormCompleted = true;
            }
            return { stdout: successJson(host), stderr: "" };
          }),
        },
      );
      let settled = false;
      void pending.finally(() => {
        settled = true;
      }).catch(() => undefined);

      await wormStart;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      releaseWorm?.();
      const result = await pending;
      expect(wormCompleted).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.receipt.per_host.map((host) => [host.host, host.status])).toEqual([
        ["blade", "succeeded"],
        ["worm", "succeeded"],
      ]);
      expect(result.operation.hosts.blade?.execution_status).toBe("succeeded");
      expect(result.operation.hosts.worm?.execution_status).toBe("succeeded");
      expect(result.operation.durability_issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          scope: "operation_state",
          code: "operation_state_projection_failed",
          message: "injected blade result authority failure",
        }),
      ]));
      expect(result.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "upgrade_operation_projection_persist_unavailable",
          detail: "injected blade result authority failure",
        }),
      ]));
    });

    test("missing-frame and streamed hosts form one mixed authoritative final table", async () => {
      const homeRoot = await makeTempRoot();
      const progress: string[] = [];

      const result = await runSelfUpgradeFleet(
        { json: true, parallel: true },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          monotonicNowMs: () => 20_000,
          heartbeatIntervalMs: 0,
          progressWrite: (chunk) => progress.push(chunk),
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [
            { host: "blade", runServeUrl: "http://blade:8740" },
            { host: "worm", runServeUrl: "http://worm:8740" },
          ],
          listDescriptors: async () => [],
          runFreshnessCommand: async () => freshnessJson("blade"),
          execFileAsync: vi.fn(async (_file, args, options) => {
            const host = extractSshHost(args);
            const operationId = (JSON.parse(progress[0]!) as { operation_id: string }).operation_id;
            if (host === "blade") {
              const line = phaseLine({ operationId, host, phase: "build", elapsedMs: 4_000, eventId: "blade-build" });
              options?.onStderrLine?.(line);
              return { stdout: successJson(host), stderr: `${line}\n` };
            }
            return { stdout: failureJson(host), stderr: "remote host failed without phase frames\n" };
          }),
        },
      );

      const noFrames = result.receipt.per_host.find((entry) => entry.host === "worm")!;
      const finalRecord = progress.map((line) => JSON.parse(line)).at(-1);

      expect(result.exitCode).toBe(1);
      expect(noFrames.progress_relay).toEqual({ mode: "missing", phases: [] });
      expect(result.operation.hosts.worm).toMatchObject({
        relay_mode: "missing",
        execution_status: "failed",
      });
      expect(result.operation.hosts.worm).not.toHaveProperty("latest_phase");
      expect(result.text).toMatch(/blade\s+succeeded\s+fresh/u);
      expect(result.text).toMatch(/worm\s+failed/u);
      expect(finalRecord).toMatchObject({
        record: "fleet_final",
        status: "failed",
        rows: [
          expect.objectContaining({ host: "blade", status: "succeeded", freshness_verdict: "fresh" }),
          expect.objectContaining({ host: "worm", status: "failed" }),
        ],
      });
    });

    test("refuses malformed legacy success receipts", async () => {
      const malformedHome = await makeTempRoot();
      const verifyMalformed = vi.fn(async (host: string, receiptPath: string, receipt: SelfUpgradeReceipt) => ({
        receipt,
        locator: {
          host,
          route: `/v1/admin/self-upgrade-receipts/${path.posix.basename(receiptPath, ".json")}`,
        },
      }));
      const malformed = await runSelfUpgradeFleet(
        { hosts: ["blade"] },
        {
          homeDir: () => malformedHome,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          verifyRemoteReceipt: verifyMalformed,
          execFileAsync: vi.fn(async () => ({
            stdout: `${JSON.stringify({
              status: "succeeded",
              plan: makePlan("blade"),
              receipt_path: "/home/blade/.calyx/self-upgrade-receipts/blade.json",
            })}\n`,
            stderr: "",
          })),
        },
      );

      expect(malformed.exitCode).toBe(1);
      expect(malformed.receipt.per_host[0]).toMatchObject({
        status: "failed",
        progress_relay: { mode: "missing", phases: [] },
      });
      expect(malformed.receipt.per_host[0]?.error).toContain("Remote self upgrade JSON parse failed");
      expect(verifyMalformed).not.toHaveBeenCalled();
    });

    test("refuses semantically false canonical success receipts", async () => {
      const semanticHome = await makeTempRoot();
      const verifySemantic = vi.fn(async (
        host: string,
        receiptPath: string,
        receipt: SelfUpgradeReceipt,
        _runServeUrl: string,
        fleetOperationId: string,
      ) => ({
        receipt: bindCanonicalReceipt(receipt, receiptPath, fleetOperationId),
        locator: {
          host,
          route: `/v1/admin/self-upgrade-receipts/${path.posix.basename(receiptPath, ".json")}`,
        },
      }));
      const invalidPayload = JSON.parse(successJson("blade")) as { receipt: SelfUpgradeReceipt };
      invalidPayload.receipt.after_head = CHECKOUT_HEAD;
      const semanticallyInvalid = await runSelfUpgradeFleet(
        { hosts: ["blade"] },
        {
          homeDir: () => semanticHome,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          verifyRemoteReceipt: verifySemantic,
          execFileAsync: vi.fn(async () => ({
            stdout: `${JSON.stringify(invalidPayload)}\n`,
            stderr: "",
          })),
        },
      );

      expect(semanticallyInvalid.exitCode).toBe(1);
      expect(semanticallyInvalid.receipt.per_host[0]).toMatchObject({
        status: "failed",
        error: expect.stringContaining("does not prove target"),
      });
      expect(verifySemantic).toHaveBeenCalledTimes(1);
    });

    test("accepts the exact POL-2099 worm receipt through the strict contract and fleet aggregate", async () => {
      const homeRoot = await makeTempRoot();
      const fixtureRaw = await readFile(
        new URL("./fixtures/pol-2099-worm-self-upgrade.stdout.json", import.meta.url),
        "utf8",
      );
      expect(createHash("sha256").update(fixtureRaw).digest("hex")).toBe(
        "f1adcb6e5610ab1d875fc1ae2bc9a68a190a17c2c07a238f1e441d17ca461ddf",
      );
      const fixture = JSON.parse(fixtureRaw) as {
        plan: SelfUpgradePlan;
        receipt_path: string;
        receipt: SelfUpgradeReceipt;
      };
      const strictReceipt = validateOperationSuccessResponse(
        "admin.self-upgrade.receipt",
        200,
        fixture.receipt,
      ).value as SelfUpgradeReceipt;
      const verifyRemoteReceipt = vi.fn(async (
        host: string,
        receiptPath: string,
        _projectedReceipt: SelfUpgradeReceipt,
        _runServeUrl: string,
        fleetOperationId: string,
      ) => ({
        // The captured bytes are validated above without alteration. A replay
        // must bind the accepted historical receipt to this new invocation
        // before the fleet authority check, just as a live host writer does.
        receipt: {
          ...strictReceipt,
          fleet_operation_id: fleetOperationId,
        },
        locator: {
          host,
          route: `/v1/admin/self-upgrade-receipts/${path.posix.basename(receiptPath, ".json")}`,
        },
      }));

      const result = await runSelfUpgradeFleet(
        { hosts: ["worm"] },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveRemoteCloneRoot: async () => fixture.plan.repo_root,
          resolveConductorTargetSha: async () => fixture.plan.target_head,
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "worm", runServeUrl: "http://worm:8740" }],
          listDescriptors: async () => [],
          verifyRemoteReceipt,
          execFileAsync: vi.fn(async () => ({ stdout: fixtureRaw, stderr: "" })),
        },
      );

      expect(verifyRemoteReceipt).toHaveBeenCalledTimes(1);
      expect(result.exitCode).toBe(0);
      expect(result.receipt.status).toBe("succeeded");
      expect(result.receipt.per_host[0]).toMatchObject({
        host: "worm",
        status: "succeeded",
        exit_code: 0,
        receipt: {
          schema_version: "self-upgrade-receipt/v1",
          status: "succeeded",
          target_acceptance: { status: "accepted" },
          target_state_readiness: { status: "ready" },
          target_state_migrated: { status: "migrated" },
          target_state_applied: { status: "applied" },
          state_snapshot: { status: "snapshotted" },
          supervisor_readiness: { status: "unchanged" },
          supervisor_install: { status: "unchanged" },
          maintenance_disposition: { status: "released" },
          artifact_cleanup: { state_backup: "cleaned" },
        },
      });
    });

    test("rejects malformed nested durability evidence from the exact POL-2099 receipt", async () => {
      const fixtureRaw = await readFile(
        new URL("./fixtures/pol-2099-worm-self-upgrade.stdout.json", import.meta.url),
        "utf8",
      );
      const fixture = JSON.parse(fixtureRaw) as { receipt: SelfUpgradeReceipt };
      const malformedReceipts: unknown[] = [
        {
          ...fixture.receipt,
          target_acceptance: {
            ...fixture.receipt.target_acceptance,
            schema_version: "wrong/v999",
            status: "rejected",
          },
        },
        {
          ...fixture.receipt,
          target_state_readiness: {
            ...fixture.receipt.target_state_readiness,
            status: "not-ready",
            pending_migrations: "not-an-array",
          },
        },
        {
          ...fixture.receipt,
          artifact_cleanup: {
            ...fixture.receipt.artifact_cleanup,
            state_backup: "deleted",
            supervisor_backup: 42,
            errors: "none",
          },
        },
      ];

      for (const malformedReceipt of malformedReceipts) {
        expect(() => validateOperationSuccessResponse(
          "admin.self-upgrade.receipt",
          200,
          malformedReceipt,
        )).toThrow("response did not match any success representation");
      }
    });

    test("fails writer serialization when durability output drifts beyond the declared schema", async () => {
      const fixtureRaw = await readFile(
        new URL("./fixtures/pol-2099-worm-self-upgrade.stdout.json", import.meta.url),
        "utf8",
      );
      const fixture = JSON.parse(fixtureRaw) as { receipt: SelfUpgradeReceipt };
      const driftedWriterReceipt = {
        ...fixture.receipt,
        artifact_cleanup: {
          ...fixture.receipt.artifact_cleanup,
          future_writer_field: "undeclared",
        },
      } as unknown as SelfUpgradeReceipt;

      expect(() => serializeSelfUpgradeReceipt(driftedWriterReceipt)).toThrow(
        "response did not match any success representation",
      );
    });

    test("lets the canonical receipt override a divergent stdout projection", async () => {
      const mismatchedHome = await makeTempRoot();
      const receiptReads: string[] = [];
      let fleetOperationId = "";
      const createAdminClient = createAdminClientFactory(vi.fn(async (input, init) => {
        receiptReads.push(new URL(String(input)).pathname);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
        return new Response(JSON.stringify({
          ...bindCanonicalReceipt(
            makeReceipt("blade"),
            "/home/blade/.calyx/self-upgrade-receipts/blade.json",
            fleetOperationId,
          ),
          warnings: ["durable route diverged from stdout"],
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
          },
        });
      }));
      const mismatched = await runSelfUpgradeFleetCommand(
        { hosts: ["blade"] },
        {
          homeDir: () => mismatchedHome,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveRemoteCloneRoot: async (host: string) => `/srv/${host}/calyx`,
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          resolveConductorTargetEvidence: async () => testTargetEvidence("origin/main", STABLE_TARGET_SHA),
          resolveConductorStartupContractPayload: async () => validStartupContractPayload(STABLE_TARGET_SHA),
          runFreshnessCommand: async () => freshnessJson("blade"),
          authToken: "test-token",
          createAdminClient,
          execFileAsync: vi.fn(async (_file, args) => {
            fleetOperationId = extractFleetOperationId(args);
            return { stdout: successJson("blade"), stderr: "" };
          }),
        },
      );

      expect(mismatched.exitCode).toBe(0);
      expect(mismatched.receipt.per_host[0]).toMatchObject({
        status: "succeeded",
        receipt: { warnings: ["durable route diverged from stdout"] },
        receipt_verification: { status: "verified", attempts: 1 },
      });
      expect(mismatched.receipt.per_host[0]?.progress_relay?.phases).toEqual([]);
      expect(receiptReads).toEqual(["/v1/admin/self-upgrade-receipts/blade"]);
    });

    test("rejects a stale canonical receipt bound to another fleet invocation", async () => {
      const homeRoot = await makeTempRoot();
      const result = await runSelfUpgradeFleet(
        { hosts: ["blade"] },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          verifyRemoteReceipt: async (host, receiptPath, receipt) => ({
            receipt: {
              ...receipt,
              operation_id: path.posix.basename(receiptPath, ".json"),
              fleet_operation_id: "fleet-stale-invocation",
            },
            locator: {
              host,
              route: `/v1/admin/self-upgrade-receipts/${path.posix.basename(receiptPath, ".json")}`,
            },
          }),
          execFileAsync: vi.fn(async () => ({ stdout: successJson("blade"), stderr: "" })),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.receipt.per_host[0]).toMatchObject({
        status: "failed",
        error: expect.stringContaining("does not match the current dispatch"),
      });
    });

    test("keeps an unbound legacy receipt diagnostic-only as unverified", async () => {
      const homeRoot = await makeTempRoot();
      const result = await runSelfUpgradeFleet(
        { hosts: ["blade"] },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          verifyRemoteReceipt: async (host, receiptPath, receipt) => ({
            receipt,
            locator: {
              host,
              route: `/v1/admin/self-upgrade-receipts/${path.posix.basename(receiptPath, ".json")}`,
            },
          }),
          execFileAsync: vi.fn(async () => ({ stdout: successJson("blade"), stderr: "" })),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.receipt).toMatchObject({ status: "unverified" });
      expect(result.receipt.per_host[0]).toMatchObject({
        status: "unverified",
        exit_code: 0,
        receipt_verification: {
          status: "unavailable",
          code: "receipt_binding_unavailable",
        },
      });
      expect(result.text).toContain("verification=receipt_binding_unavailable");
      expect(result.text).toContain(
        "verification_receipt=blade:/v1/admin/self-upgrade-receipts/blade",
      );
    });

    test("fail-fast continues after unverified receipt binding and dispatches every host", async () => {
      const homeRoot = await makeTempRoot();
      const execFileAsync = vi.fn(async (_file, args) => ({
        stdout: successJson(extractSshHost(args)),
        stderr: "",
      }));
      const result = await runSelfUpgradeFleet(
        { hosts: ["blade", "worm"], failFast: true },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [
            { host: "blade", runServeUrl: "http://blade:8740" },
            { host: "worm", runServeUrl: "http://worm:8740" },
          ],
          listDescriptors: async () => [],
          verifyRemoteReceipt: async (host, receiptPath, receipt) => ({
            receipt,
            locator: {
              host,
              route: `/v1/admin/self-upgrade-receipts/${path.posix.basename(receiptPath, ".json")}`,
            },
          }),
          execFileAsync,
        },
      );

      expect(result.exitCode).toBe(1);
      expect(execFileAsync.mock.calls.map((call) => extractSshHost(call[1] as readonly unknown[]))).toEqual([
        "blade",
        "worm",
      ]);
      expect(result.receipt.per_host).toEqual([
        expect.objectContaining({ host: "blade", status: "unverified" }),
        expect.objectContaining({ host: "worm", status: "unverified" }),
      ]);
    });

    test("accepts an alternate host-local receipt root only through its canonical route", async () => {
      const homeRoot = await makeTempRoot();
      const payload = JSON.parse(successJson("blade")) as {
        receipt_path: string;
        receipt: SelfUpgradeReceipt;
      };
      payload.receipt_path = "/opt/calyx-state/.calyx/self-upgrade-receipts/blade.json";
      const requested: string[] = [];
      let fleetOperationId = "";
      const createAdminClient = createAdminClientFactory(vi.fn(async (input) => {
        requested.push(String(input));
        return new Response(JSON.stringify(bindCanonicalReceipt(
          payload.receipt,
          payload.receipt_path,
          fleetOperationId,
        )), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
          },
        });
      }));

      const result = await runSelfUpgradeFleetCommand(
        { hosts: ["blade"] },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveRemoteCloneRoot: async (host: string) => `/srv/${host}/calyx`,
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{
            host: "blade",
            runServeUrl: "http://blade.example:8740/calyx/control/",
          }],
          listDescriptors: async () => [],
          resolveConductorTargetEvidence: async () => testTargetEvidence("origin/main", STABLE_TARGET_SHA),
          resolveConductorStartupContractPayload: async () => validStartupContractPayload(STABLE_TARGET_SHA),
          runFreshnessCommand: async () => freshnessJson("blade"),
          authToken: "test-token",
          createAdminClient,
          execFileAsync: vi.fn(async (_file, args) => {
            fleetOperationId = extractFleetOperationId(args);
            return { stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
          }),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.receipt.per_host[0]).toMatchObject({
        status: "succeeded",
        receipt_locator: {
          host: "blade",
          route: "/v1/admin/self-upgrade-receipts/blade",
        },
      });
      expect(requested).toEqual([
        "http://blade.example:8740/calyx/control/v1/admin/self-upgrade-receipts/blade",
      ]);
    });

    test("resolves a non-normalized hosts-truth key by canonical alias before dereferencing", async () => {
      const homeRoot = await makeTempRoot();
      const agentsInfraRoot = path.join(homeRoot, "agents-infra");
      await mkdir(path.join(agentsInfraRoot, "fleet", "truths"), { recursive: true });
      await writeFile(
        path.join(agentsInfraRoot, "fleet", "truths", "hosts.yaml"),
        [
          "hosts:",
          "  Blade.Example.Com:",
          "    consumer_api_credentials:",
          "      - client_id: operator_cli",
          "        credential_tier: control_plane",
          "        verifier_env: CALYX_CONSUMER_API_OPERATOR_CLI_V1_VERIFIER_SHA256",
          "        token_env: CALYX_CONSUMER_API_OPERATOR_CLI_V1_TOKEN",
          "        outbound: true",
          "        address_grants:",
          "          send_as: [client:operator_cli@blade]",
          "          read: [host:*]",
          "",
        ].join("\n"),
        "utf8",
      );
      const previousToken = process.env["CALYX_CONSUMER_API_OPERATOR_CLI_V1_TOKEN"];
      process.env["CALYX_CONSUMER_API_OPERATOR_CLI_V1_TOKEN"] = "resolved-production-token";
      let fleetOperationId = "";
      const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization"))
          .toBe("Bearer resolved-production-token");
        return new Response(JSON.stringify(bindCanonicalReceipt(
          makeReceipt("blade"),
          "/home/blade/.calyx/self-upgrade-receipts/blade.json",
          fleetOperationId,
        )), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174001",
          },
        });
      });
      try {
        const result = await runSelfUpgradeFleetCommand(
          { hosts: ["blade"] },
          {
            homeDir: () => homeRoot,
            now: () => fixedNow,
            heartbeatIntervalMs: 0,
            resolveAgentsInfraRoot: async () => agentsInfraRoot,
            resolveRemoteCloneRoot: async (host: string) => `/srv/${host}/calyx`,
            resolveCurrentHostAlias: async () => "conductor",
            listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
            listDescriptors: async () => [],
            resolveConductorTargetEvidence: async () => testTargetEvidence("origin/main", STABLE_TARGET_SHA),
            resolveConductorStartupContractPayload: async () => validStartupContractPayload(STABLE_TARGET_SHA),
            runFreshnessCommand: async () => freshnessJson("blade"),
            createAdminClient: createAdminClientFactory(request),
            execFileAsync: vi.fn(async (_file, args) => {
              fleetOperationId = extractFleetOperationId(args);
              return { stdout: successJson("blade"), stderr: "" };
            }),
          },
        );

        expect(result.exitCode).toBe(0);
        expect(result.receipt.per_host[0]).toMatchObject({
          status: "succeeded",
          receipt_verification: { status: "verified", attempts: 1 },
        });
        expect(request).toHaveBeenCalledTimes(1);
      } finally {
        if (previousToken === undefined) delete process.env["CALYX_CONSUMER_API_OPERATOR_CLI_V1_TOKEN"];
        else process.env["CALYX_CONSUMER_API_OPERATOR_CLI_V1_TOKEN"] = previousToken;
      }
    });

    test("warns before dispatch and settles missing receipt credentials as unverified", async () => {
      const homeRoot = await makeTempRoot();
      const progress: string[] = [];
      const agentsInfraRoot = path.join(homeRoot, "agents-infra");
      await mkdir(path.join(agentsInfraRoot, "fleet", "truths"), { recursive: true });
      await writeFile(
        path.join(agentsInfraRoot, "fleet", "truths", "hosts.yaml"),
        [
          "hosts:",
          "  blade: {}",
          "  worm:",
          "    consumer_api_credentials:",
          "      - client_id: operator_cli",
          "        credential_tier: control_plane",
          "        verifier_env: CALYX_CONSUMER_API_OPERATOR_CLI_V1_VERIFIER_SHA256",
          "        token_env: CALYX_CONSUMER_API_OPERATOR_CLI_V1_TOKEN",
          "        outbound: true",
          "        address_grants:",
          "          send_as: [client:operator_cli@worm]",
          "          read: [host:*]",
          "",
        ].join("\n"),
        "utf8",
      );
      const previousToken = process.env["CALYX_CONSUMER_API_OPERATOR_CLI_V1_TOKEN"];
      process.env["CALYX_CONSUMER_API_OPERATOR_CLI_V1_TOKEN"] = "worm-production-token";
      let fleetOperationId = "";
      const request = vi.fn(async (input: string | URL | Request) => {
        const host = new URL(String(input)).hostname.split(".")[0]!;
        return new Response(JSON.stringify(bindCanonicalReceipt(
          makeReceipt(host),
          `/home/${host}/.calyx/self-upgrade-receipts/${host}.json`,
          fleetOperationId,
        )), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174002",
          },
        });
      });
      const dispatch = vi.fn(async (_file, args) => {
        fleetOperationId = extractFleetOperationId(args);
        return {
          stdout: successJson(extractSshHost(args)),
          stderr: "",
        };
      });
      try {
        const result = await runSelfUpgradeFleetCommand(
          { hosts: ["blade", "worm"], failFast: true, json: true },
          {
            homeDir: () => homeRoot,
            now: () => fixedNow,
            heartbeatIntervalMs: 0,
            progressWrite: (chunk) => progress.push(chunk),
            resolveAgentsInfraRoot: async () => agentsInfraRoot,
            resolveRemoteCloneRoot: async (host: string) => `/srv/${host}/calyx`,
            resolveCurrentHostAlias: async () => "conductor",
            listRunServeHosts: async () => [
              { host: "blade", runServeUrl: "http://blade:8740" },
              { host: "worm", runServeUrl: "http://worm:8740" },
            ],
            listDescriptors: async () => [],
            resolveConductorTargetEvidence: async () => testTargetEvidence("origin/main", STABLE_TARGET_SHA),
            resolveConductorStartupContractPayload: async () => validStartupContractPayload(STABLE_TARGET_SHA),
            runFreshnessCommand: async (options) => freshnessJson(options.host ?? "unknown"),
            createAdminClient: createAdminClientFactory(request),
            execFileAsync: dispatch,
          },
        );

        expect(result.exitCode).toBe(1);
        expect(result.receipt).toMatchObject({
          status: "unverified",
          target_evidence: {
            status: "resolved",
          },
          per_host: [
            {
              host: "blade",
              status: "unverified",
              receipt_verification: {
                status: "unavailable",
                code: "conductor_auth_unavailable",
              },
            },
            {
              host: "worm",
              status: "succeeded",
              receipt_verification: { status: "verified" },
            },
          ],
        });
        expect(dispatch.mock.calls.map((call) => extractSshHost(call[1] as readonly unknown[])))
          .toEqual(["blade", "worm"]);
        expect(request).toHaveBeenCalledOnce();
        expect(result.warnings).toEqual(expect.arrayContaining([
          expect.objectContaining({
            code: "upgrade_receipt_auth_unavailable",
            detail: "blade: credential unavailable",
          }),
        ]));
        expect(progress.map((line) => JSON.parse(line))).toEqual(expect.arrayContaining([
          expect.objectContaining({
            record: "warning",
            code: "upgrade_receipt_auth_unavailable",
            operation_projection: "available",
          }),
        ]));
      } finally {
        if (previousToken === undefined) delete process.env["CALYX_CONSUMER_API_OPERATOR_CLI_V1_TOKEN"];
        else process.env["CALYX_CONSUMER_API_OPERATOR_CLI_V1_TOKEN"] = previousToken;
      }
    });

    test("retries transient canonical receipt transport and protocol failures within a fixed bound", async () => {
      const homeRoot = await makeTempRoot();
      const sleep = vi.fn(async () => {});
      let fleetOperationId = "";
      const request = vi.fn()
        .mockRejectedValueOnce(new Error("tailnet reset one"))
        .mockResolvedValueOnce(new Response("{", {
          status: 503,
          headers: {
            "content-type": "application/json",
            "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174002",
          },
        }))
        .mockImplementationOnce(async () => new Response(JSON.stringify(bindCanonicalReceipt(
            makeReceipt("blade"),
            "/home/blade/.calyx/self-upgrade-receipts/blade.json",
            fleetOperationId,
          )), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174003",
            },
          }));
      const result = await runSelfUpgradeFleetCommand(
        { hosts: ["blade"] },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveRemoteCloneRoot: async (host: string) => `/srv/${host}/calyx`,
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          resolveConductorTargetEvidence: async () => testTargetEvidence("origin/main", STABLE_TARGET_SHA),
          resolveConductorStartupContractPayload: async () => validStartupContractPayload(STABLE_TARGET_SHA),
          runFreshnessCommand: async () => freshnessJson("blade"),
          authToken: "test-token",
          sleep,
          createAdminClient: createAdminClientFactory(request),
          execFileAsync: vi.fn(async (_file, args) => {
            fleetOperationId = extractFleetOperationId(args);
            return { stdout: successJson("blade"), stderr: "" };
          }),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.receipt.per_host[0]).toMatchObject({
        status: "succeeded",
        receipt_verification: { status: "verified", attempts: 3 },
      });
      expect(request).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls).toEqual([[500], [1_500]]);
    });

    test("respects an explicit non-retryable receipt outage and emits a failed terminal projection", async () => {
      const homeRoot = await makeTempRoot();
      const sleep = vi.fn(async () => {});
      const projectedEvents: Array<Parameters<typeof appendControlEvent>[1]> = [];
      const request = vi.fn(async () => new Response(JSON.stringify({
        error: {
          schema_version: "calyx.error/v1",
          code: "self_upgrade_receipt_unavailable",
          message: "receipt authority is permission denied",
          retryable: false,
        },
      }), {
        status: 503,
        headers: {
          "content-type": "application/json",
          "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174004",
        },
      }));
      const result = await runSelfUpgradeFleetCommand(
        { hosts: ["blade"] },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          progressNow: () => fixedNow,
          heartbeatIntervalMs: 0,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveRemoteCloneRoot: async (host: string) => `/srv/${host}/calyx`,
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          resolveConductorTargetEvidence: async () => testTargetEvidence("origin/main", STABLE_TARGET_SHA),
          resolveConductorStartupContractPayload: async () => validStartupContractPayload(STABLE_TARGET_SHA),
          runFreshnessCommand: async () => freshnessJson("blade"),
          authToken: "test-token",
          sleep,
          createAdminClient: createAdminClientFactory(request),
          appendEventProjection: async (_roots, event) => { projectedEvents.push(event); },
          execFileAsync: vi.fn(async () => ({ stdout: successJson("blade"), stderr: "" })),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.receipt.status).toBe("unverified");
      expect(result.receipt.per_host[0]).toMatchObject({
        status: "unverified",
        receipt_verification: {
          status: "unavailable",
          code: "transport_unavailable",
          attempts: 1,
        },
      });
      expect(request).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
      expect(projectedEvents.at(-1)?.event_type).toBe("daemon.upgrade.fleet.failed");
    });

    test("does not persist or emit fleet_final before postflight authority resolves", async () => {
      const homeRoot = await makeTempRoot();
      const progress: string[] = [];
      let resolveFreshness: ((value: ReturnType<typeof freshnessJson>) => void) | undefined;
      const freshness = new Promise<ReturnType<typeof freshnessJson>>((resolve) => {
        resolveFreshness = resolve;
      });
      let postflightStarted: (() => void) | undefined;
      const postflightCalled = new Promise<void>((resolve) => {
        postflightStarted = resolve;
      });

      const pending = runSelfUpgradeFleet(
        { json: true },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          monotonicNowMs: () => 10_000,
          heartbeatIntervalMs: 0,
          progressWrite: (chunk) => progress.push(chunk),
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          execFileAsync: vi.fn(async () => ({ stdout: successJson("blade"), stderr: "" })),
          runFreshnessCommand: async () => {
            postflightStarted?.();
            return freshness;
          },
        },
      );

      await postflightCalled;
      const started = progress.map((line) => JSON.parse(line)).find((entry) => entry.record === "operation_started")!;
      const inFlight = JSON.parse(await readFile(started.operation_path, "utf8"));

      expect(started.operation_projection).toBe("available");
      expect(inFlight.status).toBe("running");
      expect(inFlight.final_receipt_path).toBeUndefined();
      expect(progress.map((line) => JSON.parse(line).record)).not.toContain("fleet_final");

      resolveFreshness?.(freshnessJson("blade"));
      const result = await pending;

      expect(result.operation.status).toBe("succeeded");
      expect(progress.map((line) => JSON.parse(line).record).at(-1)).toBe("fleet_final");
    });

    test("projection sink failures cannot change host execution truth", async () => {
      const homeRoot = await makeTempRoot();
      const result = await runSelfUpgradeFleet(
        { dryRun: true, json: true },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          progressWrite: () => {
            throw new Error("stderr projection unavailable");
          },
          appendEventProjection: async () => new Promise<never>(() => undefined),
          eventProjectionSettleTimeoutMs: 0,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          execFileAsync: vi.fn(async () => ({ stdout: dryRunJson("blade"), stderr: "" })),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.receipt.status).toBe("dry-run");
      expect(result.operation.status).toBe("dry-run");
      expect(result.operation_projection).toBe("degraded");
      expect(result.text).toContain("operation_projection: degraded");
      expect(result.operation.hosts.blade?.execution_status).toBe("dry-run");
      expect(result.operation.durability_issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          scope: "event_log",
          code: "event_log_projection_failed",
        }),
      ]));
      expect(result.warnings?.map((warning) => warning.code)).toEqual(expect.arrayContaining([
        "upgrade_progress_projection_unavailable",
        "upgrade_event_projection_unavailable",
      ]));
    });

    test("a never-settling relayed phase event cannot block SSH completion or final authority", async () => {
      const homeRoot = await makeTempRoot();
      const progress: string[] = [];
      let eventProjectionAttempts = 0;

      const result = await runSelfUpgradeFleet(
        { hosts: ["blade"], json: true },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          progressWrite: (chunk) => progress.push(chunk),
          appendEventProjection: async () => {
            eventProjectionAttempts += 1;
            if (eventProjectionAttempts === 1) {
              await new Promise<never>(() => undefined);
            }
          },
          eventProjectionSettleTimeoutMs: 0,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          execFileAsync: vi.fn(async (_file, _args, options) => {
            const operationId = (JSON.parse(progress[0]!) as { operation_id: string }).operation_id;
            const build = phaseLine({
              operationId,
              host: "blade",
              phase: "build",
              elapsedMs: 2_000,
              eventId: "never-settling-event-projection",
            });
            options?.onStderrLine?.(build);
            return { stdout: successJson("blade"), stderr: `${build}\n` };
          }),
        },
      );

      expect(eventProjectionAttempts).toBe(1);
      expect(result.exitCode).toBe(0);
      expect(result.operation.status).toBe("succeeded");
      expect(result.operation.hosts.blade).toMatchObject({
        execution_status: "succeeded",
        latest_phase: "build",
      });
      expect(result.operation.durability_issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          scope: "event_log",
          code: "event_log_projection_failed",
          message: "did not settle within 0ms",
        }),
      ]));
      expect(progress.map((line) => JSON.parse(line)).find((record) => (
        record.record === "fleet_final"
      ))).toMatchObject({
        record: "fleet_final",
        status: "succeeded",
      });
    });

    test("captures a late asynchronous failure of the terminal progress write", async () => {
      const homeRoot = await makeTempRoot();
      const progressStream = new Writable({
        write(chunk, _encoding, callback) {
          if (chunk.toString().includes('"record":"fleet_final"')) {
            queueMicrotask(() => callback(Object.assign(new Error("late terminal EPIPE"), { code: "EPIPE" })));
            return;
          }
          callback();
        },
      });

      const result = await runSelfUpgradeFleet(
        { dryRun: true, json: true },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          progressStream,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          execFileAsync: vi.fn(async () => ({ stdout: dryRunJson("blade"), stderr: "" })),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "upgrade_progress_projection_unavailable",
          detail: "late terminal EPIPE",
        }),
      ]));
    });

    test("captures a next-turn sink error after the terminal callback succeeds", async () => {
      const homeRoot = await makeTempRoot();
      const progressStream = new Writable({
        write(chunk, _encoding, callback) {
          callback();
          if (chunk.toString().includes('"record":"fleet_final"')) {
            setImmediate(() => progressStream.emit("error", new Error("post-callback terminal EPIPE")));
          }
        },
      });

      const result = await runSelfUpgradeFleet(
        { dryRun: true, json: true },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          progressStream,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          execFileAsync: vi.fn(async () => ({ stdout: dryRunJson("blade"), stderr: "" })),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "upgrade_progress_projection_unavailable",
          detail: "post-callback terminal EPIPE",
        }),
      ]));
    });

    test("dispatches and writes final authority when the conductor observation cannot be claimed", async () => {
      const homeRoot = await makeTempRoot();
      const execFileAsync = vi.fn(async () => ({ stdout: successJson("blade"), stderr: "" }));

      const result = await runSelfUpgradeFleet(
        { hosts: ["blade"], json: true },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          progressWrite: () => undefined,
          claimOperation: async () => {
            throw new Error("injected observation claim failure");
          },
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          execFileAsync,
        },
      );

      expect(execFileAsync).toHaveBeenCalledOnce();
      expect(result.exitCode).toBe(0);
      expect(result.receipt).toMatchObject({
        status: "succeeded",
        per_host: [{ host: "blade", status: "succeeded" }],
      });
      expect(result.operation.status).toBe("succeeded");
      expect(result.operation_projection).toBe("unavailable");
      expect(result.text).toContain("operation_projection: unavailable");
      expect(result.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "upgrade_operation_projection_persist_unavailable",
          detail: "injected observation claim failure",
        }),
      ]));
      await expect(readFile(result.operation_path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await readFile(result.receipt_path, "utf8"))).toMatchObject({ status: "succeeded" });
    });

    test("bounds a never-settling conductor observation claim before dispatch", async () => {
      const homeRoot = await makeTempRoot();
      const execFileAsync = vi.fn(async () => ({ stdout: successJson("blade"), stderr: "" }));

      const result = await runSelfUpgradeFleet(
        { hosts: ["blade"], json: true },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          operationClaimSettleTimeoutMs: 0,
          progressWrite: () => undefined,
          claimOperation: () => new Promise<never>(() => undefined),
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          execFileAsync,
        },
      );

      expect(execFileAsync).toHaveBeenCalledOnce();
      expect(result.exitCode).toBe(0);
      expect(result.receipt.per_host[0]).toMatchObject({ host: "blade", status: "succeeded" });
      expect(result.operation_projection).toBe("unavailable");
      expect(result.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "upgrade_operation_projection_persist_unavailable",
          detail: "did not settle within 0ms",
        }),
      ]));
    });

    test("emits a typed projection correction when writer release times out after fleet_final", async () => {
      const homeRoot = await makeTempRoot();
      const progress: string[] = [];
      let releaseStarted = false;
      let finishRelease: (() => void) | undefined;
      const releaseGate = new Promise<void>((resolve) => {
        finishRelease = resolve;
      });
      let releaseFinished: (() => void) | undefined;
      const releaseDone = new Promise<void>((resolve) => {
        releaseFinished = resolve;
      });
      const claimOperation: typeof claimSelfUpgradeOperation = async (root, initialRecord, options) => {
        const writer = await claimSelfUpgradeOperation(root, initialRecord, options);
        return {
          operationPath: writer.operationPath,
          writerId: writer.writerId,
          get record() {
            return writer.record;
          },
          // Keep every pre-terminal projection write immediately healthy so
          // the only degradation in this test is the late release path.
          write: async (candidate) => candidate,
          release: async () => {
            releaseStarted = true;
            await releaseGate;
            await writer.release();
            releaseFinished?.();
          },
        };
      };

      const result = await runSelfUpgradeFleet(
        { dryRun: true, json: true, hosts: ["blade"] },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          heartbeatIntervalMs: 0,
          eventProjectionSettleTimeoutMs: 0,
          progressWrite: (chunk) => progress.push(chunk),
          claimOperation,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          execFileAsync: vi.fn(async () => ({ stdout: dryRunJson("blade"), stderr: "" })),
        },
      );

      expect(releaseStarted).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.operation.status).toBe("dry-run");
      expect(result.operation_projection).toBe("degraded");
      expect(result.text).toContain("operation_projection: degraded");
      expect(result.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "upgrade_operation_projection_persist_unavailable",
          detail: "did not settle within 0ms",
        }),
      ]));
      const progressRecords = progress.map((line) => JSON.parse(line));
      const finalIndex = progressRecords.findIndex((record) => record.record === "fleet_final");
      expect(progressRecords[finalIndex]).toMatchObject({
        record: "fleet_final",
        status: "dry-run",
        operation_projection: "available",
      });
      expect(progressRecords.slice(finalIndex + 1)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          record: "warning",
          code: "upgrade_operation_projection_persist_unavailable",
          operation_projection: "degraded",
        }),
      ]));
      finishRelease?.();
      await releaseDone;
    });

    test("continues every parallel dispatch when the conductor observation write fails", async () => {
      const homeRoot = await makeTempRoot();
      const execFileAsync = vi.fn(async (_file, args) => ({
        stdout: successJson(extractSshHost(args)),
        stderr: "",
      }));
      const progress: string[] = [];
      let failedDispatchWrite = false;

      const claimOperation: typeof claimSelfUpgradeOperation = async (root, initialRecord, options) => {
        const writer = await claimSelfUpgradeOperation(root, initialRecord, options);
        return {
          operationPath: writer.operationPath,
          writerId: writer.writerId,
          get record() {
            return writer.record;
          },
          async write(candidate) {
            if (
              !failedDispatchWrite
              && candidate.transitions.some((transition) => transition.kind === "host_dispatched")
            ) {
              failedDispatchWrite = true;
              throw new Error("injected canonical dispatch write failure");
            }
            return writer.write(candidate);
          },
          release: () => writer.release(),
        };
      };

      const result = await runSelfUpgradeFleet(
        { parallel: true, json: true },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          progressNow: () => fixedNow,
          monotonicNowMs: () => Date.now(),
          heartbeatIntervalMs: 10,
          progressWrite: (chunk) => progress.push(chunk),
          claimOperation,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [
            { host: "blade", runServeUrl: "http://blade:8740" },
            { host: "worm", runServeUrl: "http://worm:8740" },
          ],
          listDescriptors: async () => [],
          execFileAsync,
        },
      );

      expect(execFileAsync).toHaveBeenCalledTimes(2);
      expect(result.exitCode).toBe(0);
      expect(result.receipt.per_host.map((host) => [host.host, host.status])).toEqual([
        ["blade", "succeeded"],
        ["worm", "succeeded"],
      ]);
      expect(result.operation.status).toBe("succeeded");
      expect(result.operation.durability_issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          scope: "operation_state",
          code: "operation_state_projection_failed",
          message: "injected canonical dispatch write failure",
        }),
      ]));
      expect(result.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "upgrade_operation_projection_persist_unavailable",
          detail: "injected canonical dispatch write failure",
        }),
      ]));
      const progressCount = progress.length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(progress).toHaveLength(progressCount);

      const operationRoot = path.join(homeRoot, ".calyx", "self-upgrade-operations");
      const operationFile = (await readdir(operationRoot)).find((name) => name.endsWith(".json") && !name.endsWith(".owner.json"));
      expect(operationFile).toBeTruthy();
      const operationId = operationFile!.slice(0, -".json".length);
      const durable = await readSelfUpgradeOperation(operationRoot, operationId);
      expect(durable.transitions).toEqual([]);
      expect(durable.durability_issues).toEqual([]);
      expect(JSON.parse(await readFile(result.receipt_path, "utf8"))).toMatchObject({
        status: "succeeded",
        per_host: [
          { host: "blade", status: "succeeded" },
          { host: "worm", status: "succeeded" },
        ],
      });
    });

    test("records aggregate-receipt durability loss without inventing fleet_final after host mutation", async () => {
      const homeRoot = await makeTempRoot();
      const execFileAsync = vi.fn(async () => ({ stdout: successJson("blade"), stderr: "" }));
      const writeFleetReceipt = vi.fn(async () => {
        throw new Error("injected aggregate receipt fsync failure");
      });

      await expect(runSelfUpgradeFleet(
        { hosts: ["blade"], json: true },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          progressNow: () => fixedNow,
          heartbeatIntervalMs: 0,
          progressWrite: () => undefined,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          execFileAsync,
          writeFleetReceipt,
        },
      )).rejects.toThrow("injected aggregate receipt fsync failure");

      expect(execFileAsync).toHaveBeenCalledOnce();
      expect(writeFleetReceipt).toHaveBeenCalledOnce();
      const operationRoot = path.join(homeRoot, ".calyx", "self-upgrade-operations");
      const operationFile = (await readdir(operationRoot)).find(
        (name) => name.endsWith(".json") && !name.endsWith(".owner.json"),
      );
      expect(operationFile).toBeTruthy();
      const durable = await readSelfUpgradeOperation(
        operationRoot,
        operationFile!.slice(0, -".json".length),
      );
      expect(durable.status).toBe("running");
      expect(durable.hosts.blade?.execution_status).toBe("succeeded");
      expect(durable.transitions.some((transition) => transition.kind === "fleet_final")).toBe(false);
      expect(durable.durability_issues).toEqual([
        expect.objectContaining({
          scope: "final_receipt",
          code: "fleet_receipt_persist_failed",
          message: "injected aggregate receipt fsync failure",
        }),
      ]);
    });

    test("bounds an oversized aggregate while preserving final host authority and locators", async () => {
      const homeRoot = await makeTempRoot();
      const payload = JSON.parse(successJson("blade")) as {
        receipt_path: string;
        receipt: SelfUpgradeReceipt;
      };
      payload.receipt.warnings = ["diagnostic-padding-".repeat(8_000)];
      const maxBytes = 12_000;
      const result = await runSelfUpgradeFleet(
        { hosts: ["blade"], json: true },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          progressNow: () => fixedNow,
          heartbeatIntervalMs: 0,
          progressWrite: () => undefined,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          runFreshnessCommand: async () => freshnessJson("blade"),
          fleetReceiptMaxBytes: maxBytes,
          verifyRemoteReceipt: async (host, receiptPath, projectedReceipt, _runServeUrl, fleetOperationId) => ({
            receipt: bindCanonicalReceipt(projectedReceipt, receiptPath, fleetOperationId),
            locator: {
              host,
              route: `/v1/admin/self-upgrade-receipts/${path.posix.basename(receiptPath, ".json")}`,
            },
          }),
          execFileAsync: vi.fn(async () => ({ stdout: `${JSON.stringify(payload)}\n`, stderr: "" })),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.receipt.status).toBe("succeeded");
      expect(result.receipt.bounded).toMatchObject({
        reason: "size_limit",
        max_bytes: maxBytes,
        original_bytes: expect.any(Number),
      });
      expect(result.receipt.bounded!.original_bytes).toBeGreaterThan(maxBytes);
      expect(result.receipt.per_host[0]).toMatchObject({
        host: "blade",
        status: "succeeded",
        exit_code: 0,
        before_head: CHECKOUT_HEAD,
        after_head: STABLE_TARGET_SHA,
        receipt_locator: {
          host: "blade",
          route: "/v1/admin/self-upgrade-receipts/blade",
        },
        receipt_verification: { status: "verified", code: "verified" },
      });
      expect(result.receipt.per_host[0]).not.toHaveProperty("receipt");
      expect((await stat(result.receipt_path)).size).toBeLessThanOrEqual(maxBytes);
      expect(JSON.parse(await readFile(result.receipt_path, "utf8"))).toEqual(result.receipt);
      expect(result.operation).toMatchObject({
        status: "succeeded",
        final_rows: [{
          host: "blade",
          status: "succeeded",
          before_head: CHECKOUT_HEAD,
          after_head: STABLE_TARGET_SHA,
          receipt_locator: {
            host: "blade",
            route: "/v1/admin/self-upgrade-receipts/blade",
          },
        }],
        durability_issues: [expect.objectContaining({
          scope: "final_receipt",
          code: "fleet_receipt_bounded",
        })],
      });
    });

    test("bounds only oversized host contributors and retains typed projection loss", async () => {
      const homeRoot = await makeTempRoot();
      const retainedProjectionIssue = {
        scope: "status_stderr" as const,
        code: "projection_unavailable" as const,
        observed_at: fixedNow,
        message: "x".repeat(4_096),
      };
      const boundedProjectionIssue = {
        ...retainedProjectionIssue,
        message: `${"x".repeat(256)}…[bounded]`,
      };
      const maxBytes = 20_000;
      const result = await runSelfUpgradeFleet(
        { hosts: ["blade", "worm"], json: true },
        {
          homeDir: () => homeRoot,
          now: () => fixedNow,
          progressNow: () => fixedNow,
          heartbeatIntervalMs: 0,
          progressWrite: () => undefined,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "conductor",
          listRunServeHosts: async () => [
            { host: "blade", runServeUrl: "http://blade:8740" },
            { host: "worm", runServeUrl: "http://worm:8740" },
          ],
          listDescriptors: async () => [],
          runFreshnessCommand: async (options) => freshnessJson(options.host ?? "unknown"),
          fleetReceiptMaxBytes: maxBytes,
          verifyRemoteReceipt: async (host, receiptPath, projectedReceipt, _runServeUrl, fleetOperationId) => ({
            receipt: bindCanonicalReceipt(projectedReceipt, receiptPath, fleetOperationId),
            locator: {
              host,
              route: `/v1/admin/self-upgrade-receipts/${path.posix.basename(receiptPath, ".json")}`,
            },
          }),
          execFileAsync: vi.fn(async (_file, args) => {
            const host = extractSshHost(args);
            const payload = JSON.parse(successJson(host)) as Record<string, unknown>;
            if (host === "blade") {
              (payload["receipt"] as SelfUpgradeReceipt).warnings = [
                "blade-only-diagnostic-padding-".repeat(8_000),
              ];
              payload["projection_issues"] = [{
                ...retainedProjectionIssue,
                future_detail: "untrusted-projection-padding".repeat(4_096),
              }];
            }
            return { stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
          }),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.receipt.bounded).toMatchObject({
        reason: "size_limit",
        max_bytes: maxBytes,
        omitted: expect.arrayContaining([
          "per_host.blade.plan",
          "per_host.blade.receipt",
          "per_host.blade.projection_issues[].message[bounded]",
        ]),
      });
      expect(result.receipt.bounded!.omitted).not.toEqual(expect.arrayContaining([
        "per_host.worm.plan",
        "per_host.worm.receipt",
      ]));
      expect(result.receipt.per_host).toEqual([
        expect.objectContaining({
          host: "blade",
          status: "succeeded",
          projection_issues: [boundedProjectionIssue],
        }),
        expect.objectContaining({
          host: "worm",
          status: "succeeded",
          plan: expect.any(Object),
          receipt: expect.any(Object),
        }),
      ]);
      expect(result.receipt.per_host[0]).not.toHaveProperty("receipt");
      expect((await stat(result.receipt_path)).size).toBeLessThanOrEqual(maxBytes);
    });
  });

  describe("local-host fast-path (POL-1145)", () => {
    test("when conductor is in the fleet, runLocalUpgrade is invoked instead of SSH", async () => {
      const homeRoot = await makeTempRoot();
      const sshHosts: string[] = [];
      const localHosts: string[] = [];

      const result = await runSelfUpgradeFleet(
        { dryRun: true },
        {
          homeDir: () => homeRoot,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "blade",
          listRunServeHosts: async () => [
            { host: "blade", runServeUrl: "http://blade:8740" },
            { host: "worm", runServeUrl: "http://worm:8740" },
          ],
          listDescriptors: async () => [],
          resolveConductorTargetSha: async () => undefined,
          runLocalUpgrade: vi.fn(async (upgradeOptions) => {
            localHosts.push(upgradeOptions.host ?? "<unknown>");
            return {
              status: "dry-run" as const,
              plan: makePlan(upgradeOptions.host ?? "blade"),
            };
          }),
          execFileAsync: vi.fn(async (_file, args) => {
            const host = extractSshHost(args);
            sshHosts.push(host);
            return { stdout: dryRunJson(host), stderr: "" };
          }),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(localHosts).toEqual(["blade"]);
      expect(sshHosts).toEqual(["worm"]);
      expect(result.receipt.per_host.map((entry) => [entry.host, entry.status])).toEqual([
        ["blade", "dry-run"],
        ["worm", "dry-run"],
      ]);
    });

    test("local fast-path produces stdout/stderr artifacts with parity to the SSH path", async () => {
      const homeRoot = await makeTempRoot();

      const result = await runSelfUpgradeFleet(
        {},
        {
          homeDir: () => homeRoot,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "blade",
          listRunServeHosts: async () => [
            { host: "blade", runServeUrl: "http://blade:8740" },
          ],
          listDescriptors: async () => [],
          resolveConductorTargetSha: async () => undefined,
          runLocalUpgrade: async (upgradeOptions) => makeBoundLocalSuccess(upgradeOptions),
          execFileAsync: vi.fn(),
        },
      );

      expect(result.exitCode).toBe(0);
      const bladeEntry = result.receipt.per_host.find((entry) => entry.host === "blade");
      expect(bladeEntry).toMatchObject({
        status: "succeeded",
        receipt_locator: {
          host: "blade",
          route: "/v1/admin/self-upgrade-receipts/blade",
        },
      });
      expect(bladeEntry?.stdout_path).toBeTruthy();
      expect(bladeEntry?.stderr_path).toBeTruthy();
      expect(result.text).toContain("verification=verified");
      expect(result.text).toContain(
        "receipt=blade:/v1/admin/self-upgrade-receipts/blade",
      );
      expect(result.text).not.toContain(
        "verification_receipt=blade:/v1/admin/self-upgrade-receipts/blade",
      );
      const stdoutBody = await readFile(bladeEntry!.stdout_path!, "utf8");
      expect(JSON.parse(stdoutBody)).toMatchObject({ status: "succeeded" });
    });

    test("local mutation truth survives failed diagnostic artifact persistence", async () => {
      const homeRoot = await makeTempRoot();
      const result = await runSelfUpgradeFleet(
        {},
        {
          homeDir: () => homeRoot,
          artifactSettleTimeoutMs: 5,
          writeArtifact: async () => {
            throw Object.assign(new Error("local diagnostic fsync failed"), { code: "EIO" });
          },
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "blade",
          listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
          listDescriptors: async () => [],
          runLocalUpgrade: async (upgradeOptions) => makeBoundLocalSuccess(upgradeOptions),
          execFileAsync: vi.fn(),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.operation.hosts.blade?.execution_status).toBe("succeeded");
      expect(result.receipt.per_host[0]).toMatchObject({
        status: "succeeded",
        artifact_warnings: [
          expect.objectContaining({ code: "artifact_write_unavailable", artifact: "stdout" }),
          expect.objectContaining({ code: "artifact_write_unavailable", artifact: "stderr" }),
        ],
      });
      expect(result.receipt.per_host[0]).not.toHaveProperty("stdout_path");
      expect(result.receipt.per_host[0]).not.toHaveProperty("stderr_path");
    });

    test.each([
        {
          name: "missing receipt",
          expectedStatus: "unverified",
          expectedCode: "receipt_binding_unavailable",
          expectedError: undefined,
          build: (options: SelfUpgradeOptions) => {
            const bound = makeBoundLocalSuccess(options);
            return {
              status: bound.status,
              plan: bound.plan,
              operation_id: bound.operation_id,
              receipt_path: bound.receipt_path,
            };
          },
        },
        {
          name: "unbound legacy receipt",
          expectedStatus: "unverified",
          expectedCode: "receipt_binding_unavailable",
          expectedError: undefined,
          build: (options: SelfUpgradeOptions) => ({
            ...makeBoundLocalSuccess(options),
            receipt: makeReceipt(options.host),
          }),
        },
        {
          name: "stale fleet binding",
          expectedStatus: "failed",
          expectedCode: undefined,
          expectedError: "does not match the current dispatch",
          build: (options: SelfUpgradeOptions) => {
            const result = makeBoundLocalSuccess(options);
            return {
              ...result,
              receipt: { ...result.receipt, fleet_operation_id: "fleet-stale-local" },
            };
          },
        },
        {
          name: "route and body mismatch",
          expectedStatus: "failed",
          expectedCode: undefined,
          expectedError: "operation_id does not match its route",
          build: (options: SelfUpgradeOptions) => {
            const result = makeBoundLocalSuccess(options);
            return {
              ...result,
              receipt: { ...result.receipt, operation_id: "another-local-operation" },
            };
          },
        },
      ] as const)(
      "local success requires a canonical current-invocation receipt binding: $name",
      async (scenario) => {
        const homeRoot = await makeTempRoot();
        const result = await runSelfUpgradeFleet(
          {},
          {
            homeDir: () => homeRoot,
            resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
            resolveCurrentHostAlias: async () => "blade",
            listRunServeHosts: async () => [{ host: "blade", runServeUrl: "http://blade:8740" }],
            listDescriptors: async () => [],
            runLocalUpgrade: async (options) => scenario.build(options),
            execFileAsync: vi.fn(),
          },
        );

        expect(result.exitCode, scenario.name).toBe(1);
        expect(result.receipt.per_host[0], scenario.name).toMatchObject({
          status: scenario.expectedStatus,
          ...(scenario.expectedCode
            ? { receipt_verification: { status: "unavailable", code: scenario.expectedCode } }
            : {}),
          ...(scenario.expectedError ? { error: expect.stringContaining(scenario.expectedError) } : {}),
        });
      },
    );

    test("retains local and remote projection issues when diagnostic artifacts are unavailable", async () => {
      const homeRoot = await makeTempRoot();
      const observedAt = "2026-04-20T12:01:01.000Z";
      const localIssue = {
        scope: "lock_cleanup" as const,
        code: "cleanup_unavailable" as const,
        observed_at: observedAt,
        message: "local lock release did not settle",
      };
      const remoteIssue = {
        scope: "lock_cleanup" as const,
        code: "cleanup_unavailable" as const,
        observed_at: observedAt,
        message: "remote lock release did not settle",
      };

      const result = await runSelfUpgradeFleet(
        {},
        {
          homeDir: () => homeRoot,
          artifactSettleTimeoutMs: 5,
          writeArtifact: async () => {
            throw Object.assign(new Error("diagnostic artifact fsync failed"), { code: "EIO" });
          },
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "blade",
          listRunServeHosts: async () => [
            { host: "blade", runServeUrl: "http://blade:8740" },
            { host: "worm", runServeUrl: "http://worm:8740" },
          ],
          listDescriptors: async () => [],
          runLocalUpgrade: async (options) => makeBoundLocalSuccess(options, [localIssue]),
          execFileAsync: vi.fn(async (_file, args) => {
            const payload = JSON.parse(successJson(extractSshHost(args))) as Record<string, unknown>;
            payload["projection_issues"] = [remoteIssue];
            return { stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
          }),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.receipt.per_host).toEqual(expect.arrayContaining([
        expect.objectContaining({
          host: "blade",
          status: "succeeded",
          projection_issues: [localIssue],
          artifact_warnings: expect.arrayContaining([
            expect.objectContaining({ code: "artifact_write_unavailable" }),
          ]),
        }),
        expect.objectContaining({
          host: "worm",
          status: "succeeded",
          projection_issues: [remoteIssue],
          artifact_warnings: expect.arrayContaining([
            expect.objectContaining({ code: "artifact_write_unavailable" }),
          ]),
        }),
      ]));
    });

    test("local fast-path failure surfaces a SelfUpgradeFleetHostResult.failed entry", async () => {
      const homeRoot = await makeTempRoot();

      const localFailure = Object.assign(new Error("local upgrade exploded"), {
        exitCode: 9,
      });

      const result = await runSelfUpgradeFleet(
        {},
        {
          homeDir: () => homeRoot,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "blade",
          listRunServeHosts: async () => [
            { host: "blade", runServeUrl: "http://blade:8740" },
            { host: "worm", runServeUrl: "http://worm:8740" },
          ],
          listDescriptors: async () => [],
          resolveConductorTargetSha: async () => undefined,
          runLocalUpgrade: async () => {
            throw localFailure;
          },
          execFileAsync: vi.fn(async (_file, args) => ({
            stdout: successJson(extractSshHost(args)),
            stderr: "",
          })),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.receipt.per_host.map((entry) => [entry.host, entry.status])).toEqual([
        ["blade", "failed"],
        ["worm", "succeeded"],
      ]);
      const bladeEntry = result.receipt.per_host.find((entry) => entry.host === "blade");
      expect(bladeEntry?.error).toContain("local upgrade exploded");
      expect(bladeEntry?.exit_code).toBe(9);
    });

    test("local failure produces stderr_tail in the per-host result for receipt parity with SSH", async () => {
      const homeRoot = await makeTempRoot();

      const multilineFailure = Object.assign(
        new Error([
          "line one of failure",
          "line two of failure",
          "line three (trailing detail)",
        ].join("\n")),
        { exitCode: 7 },
      );

      const result = await runSelfUpgradeFleet(
        {},
        {
          homeDir: () => homeRoot,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "blade",
          listRunServeHosts: async () => [
            { host: "blade", runServeUrl: "http://blade:8740" },
          ],
          listDescriptors: async () => [],
          resolveConductorTargetSha: async () => undefined,
          runLocalUpgrade: async () => {
            throw multilineFailure;
          },
          execFileAsync: vi.fn(),
        },
      );

      expect(result.exitCode).toBe(1);
      const bladeEntry = result.receipt.per_host.find((entry) => entry.host === "blade");
      expect(bladeEntry?.status).toBe("failed");
      expect(bladeEntry?.stderr_tail).toContain("line three (trailing detail)");
      expect(bladeEntry?.stderr_tail).toContain("line one of failure");
    });

    test("forwards drainDeadlineMs: 0 (operator opt-out) without dropping it via truthy check", async () => {
      const homeRoot = await makeTempRoot();
      const seenOptions: SelfUpgradeOptions[] = [];

      const result = await runSelfUpgradeFleet(
        { dryRun: true, drainDeadlineMs: 0 },
        {
          homeDir: () => homeRoot,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "blade",
          listRunServeHosts: async () => [
            { host: "blade", runServeUrl: "http://blade:8740" },
          ],
          listDescriptors: async () => [],
          resolveConductorTargetSha: async () => undefined,
          runLocalUpgrade: async (upgradeOptions) => {
            seenOptions.push(upgradeOptions);
            return { status: "dry-run" as const, plan: makePlan(upgradeOptions.host ?? "blade") };
          },
          execFileAsync: vi.fn(),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(seenOptions).toHaveLength(1);
      expect(seenOptions[0]?.drainDeadlineMs).toBe(0);
    });

    test("forwards --drain-all through the local fast path", async () => {
      const homeRoot = await makeTempRoot();
      const seenOptions: SelfUpgradeOptions[] = [];

      const result = await runSelfUpgradeFleet(
        { dryRun: true, drainAll: true },
        {
          homeDir: () => homeRoot,
          resolveAgentsInfraRoot: async () => "/tmp/agents-infra",
          resolveCurrentHostAlias: async () => "blade",
          listRunServeHosts: async () => [
            { host: "blade", runServeUrl: "http://blade:8740" },
          ],
          listDescriptors: async () => [],
          resolveConductorTargetSha: async () => undefined,
          runLocalUpgrade: async (upgradeOptions) => {
            seenOptions.push(upgradeOptions);
            return { status: "dry-run" as const, plan: makePlan(upgradeOptions.host ?? "blade") };
          },
          execFileAsync: vi.fn(),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(seenOptions).toHaveLength(1);
      expect(seenOptions[0]?.drainAll).toBe(true);
    });
  });
});
