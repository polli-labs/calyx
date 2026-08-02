import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyStateMigrations,
  describeStatePaths,
  listFleetConvergenceRows,
  openStateStore,
  upsertFleetConvergenceRow,
} from "@polli-labs/calyx-core";
import { createCalyxAdminClient } from "@polli-labs/calyx-client/admin";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildProgram } from "../run-cli";
import {
  formatSelfFreshnessText,
  runSelfFreshnessCommand,
  type SelfFreshnessResult,
} from "../self-freshness.js";
import type { SelfDriftReport } from "../self-drift.js";
import type { SelfHealthCommandResult, SelfHealthErrorPayload } from "../self-health.js";

const NOW = new Date("2026-05-20T21:00:00.000Z");
const CURRENT_HEAD = "970b73907f7b7f63271dbb75bbcb92a5b2705d2a";
const OLD_HEAD = "20a11993e5d19cc9ee3302d1f6fb7b51be29f3b4";
const CHECKOUT_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;
const tempRoots: string[] = [];
let previousEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

function createAdminClientFactory(fetchImpl: typeof fetch): typeof createCalyxAdminClient {
  return (options) => createCalyxAdminClient({
    ...options,
    fetch: fetchImpl,
  });
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "calyx-self-freshness-"));
  tempRoots.push(root);
  return root;
}

async function makeAgentsInfraRoot(): Promise<string> {
  const root = await makeTempRoot();
  await mkdir(join(root, "fleet", "truths"), { recursive: true });
  await writeFile(join(root, "fleet", "truths", "hosts.yaml"), [
    "hosts:",
    "  blade:",
    "    home: /home/caleb",
    "    run_serve_url: http://127.0.0.1:8740",
    "",
  ].join("\n"), "utf8");
  return root;
}

beforeEach(async () => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]] as const)) as Record<(typeof ENV_KEYS)[number], string | undefined>;
  const root = await makeTempRoot();
  process.env.CALYX_STATE_HOME = join(root, "state");
  delete process.env.CALYX_STATE_DB;
});

afterEach(async () => {
  vi.restoreAllMocks();
  expect(describeStatePaths().source).not.toBe("default");
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function healthResult(overrides: {
  host?: string;
  activeRuns?: number;
  features?: string[];
  ok?: boolean;
  runningHead?: string;
  promotedHead?: string;
  cloneHead?: string;
  error?: SelfHealthErrorPayload;
} = {}): SelfHealthCommandResult {
  const host = overrides.host ?? "blade";
  if (overrides.ok === false) {
    return {
      results: [{
        host,
        ok: false,
        error: overrides.error ?? {
          kind: "unreachable",
          message: "ECONNREFUSED",
        },
      }],
      text: "",
      exitCode: 6,
      failureMessage: "failed",
    };
  }
  return {
    results: [{
      host,
      ok: true,
      health: {
        schema_version: "calyx.admin-health/v1",
        protocol_epoch: 1,
        daemon_kind: "run-service",
        daemon_id: "run-serve",
        uptime_ms: 60_000,
        started_at: "2026-05-20T20:59:00.000Z",
        build: {
          git_head: overrides.runningHead ?? CURRENT_HEAD,
          built_at: "2026-05-20T20:58:00.000Z",
          package_version: "0.2.0",
        },
        promoted_build: {
          status: "ok",
          build: {
            git_head: overrides.promotedHead ?? CURRENT_HEAD,
            built_at: "2026-05-20T20:58:00.000Z",
            package_version: "0.2.0",
          },
        },
        clone_head: {
          status: "ok",
          git_head: overrides.cloneHead ?? CURRENT_HEAD,
        },
        active_runs: overrides.activeRuns ?? 0,
        maintenance_mode: false,
        supports_features: overrides.features ?? ["daemon.health/v1", "run.resource_attribution/v1"],
        advertised_host: host,
      },
    }],
    text: "",
    exitCode: 0,
  };
}

function driftReport(overrides: {
  host?: string;
  drift?: SelfDriftReport["drift"];
  commitsBehind?: number | null;
  daemonHead?: string;
  diagnostics?: SelfDriftReport["diagnostics"];
} = {}): SelfDriftReport {
  const drift = overrides.drift ?? "current";
  const commitsBehind = "commitsBehind" in overrides ? overrides.commitsBehind ?? null : (drift === "current" ? 0 : 1);
  return {
    host: overrides.host ?? "blade",
    drift,
    daemonHead: overrides.daemonHead ?? (drift === "current" ? CURRENT_HEAD : OLD_HEAD),
    targetHead: CURRENT_HEAD,
    commitsBehind,
    missingOperationalFixes: [],
    schema: null,
    summary: drift === "current" ? "at 970b739" : `${commitsBehind} commit behind`,
    diagnostics: overrides.diagnostics ?? [],
  };
}

describe("self freshness", () => {
  test.each([
    {
      name: "old health followed by a new-daemon drift read",
      first: healthResult({
        runningHead: OLD_HEAD,
        promotedHead: CURRENT_HEAD,
        cloneHead: CURRENT_HEAD,
        features: ["daemon.health/v1"],
      }),
      wouldBeSecond: healthResult({
        runningHead: CURRENT_HEAD,
        promotedHead: CURRENT_HEAD,
        cloneHead: CURRENT_HEAD,
        features: ["daemon.health/v1", "target.feature/v1"],
      }),
      expected: {
        verdict: "stale",
        drift: { status: "major", daemon_head: OLD_HEAD.slice(0, 7), commits_behind: 21 },
        install_drift: { status: "promoted_not_restarted", running_head: OLD_HEAD },
        capabilities: { missing: ["target.feature/v1"] },
      },
    },
    {
      name: "new health followed by an old-daemon drift read",
      first: healthResult({
        runningHead: CURRENT_HEAD,
        promotedHead: CURRENT_HEAD,
        cloneHead: CURRENT_HEAD,
        features: ["daemon.health/v1", "target.feature/v1"],
      }),
      wouldBeSecond: healthResult({
        runningHead: OLD_HEAD,
        promotedHead: CURRENT_HEAD,
        cloneHead: CURRENT_HEAD,
        features: ["daemon.health/v1"],
      }),
      expected: {
        verdict: "fresh",
        drift: { status: "current", daemon_head: CURRENT_HEAD.slice(0, 7), commits_behind: 0 },
        install_drift: { status: "converged", running_head: CURRENT_HEAD },
        capabilities: { missing: [] },
      },
    },
  ])("reuses one daemon generation instead of mixing $name", async ({ first, wouldBeSecond, expected }) => {
    const agentsInfraRoot = await makeAgentsInfraRoot();
    const secondHealthFetch = vi.fn(async () => {
      const observed = wouldBeSecond.results[0]!;
      return new Response(JSON.stringify(observed.ok ? observed.health : {}), {
        headers: { "content-type": "application/json" },
      });
    });
    const missingCommits = Array.from(
      { length: 21 },
      (_, index) => `${String(index + 1).padStart(40, "0")}\n`,
    ).join("");

    const result = await runSelfFreshnessCommand(
      { host: "blade", against: "origin/main" },
      {
        now: () => NOW,
        authToken: "secret-token",
        expectedFeatures: ["daemon.health/v1", "target.feature/v1"],
        agentsInfraRoot,
        repoRoot: "/tmp/calyx-compare",
        currentHostAlias: "blade",
        collectHealth: async () => first,
        createAdminClient: createAdminClientFactory(secondHealthFetch),
        execFileAsync: vi.fn(async (file, args) => {
          const command = `${file} ${args.join(" ")}`;
          if (command === "git rev-parse origin/main") {
            return { stdout: `${CURRENT_HEAD}\n`, stderr: "" };
          }
          if (command === `git log --format=%H ${OLD_HEAD}..${CURRENT_HEAD}`) {
            return { stdout: missingCommits, stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }),
      },
    );

    expect(secondHealthFetch).not.toHaveBeenCalled();
    expect(result.hosts[0]).toMatchObject(expected);
  });

  test("summarizes a fresh host with no actions", async () => {
    const result = await runSelfFreshnessCommand(
      { host: "blade" },
      {
        now: () => NOW,
        authToken: "secret-token",
        expectedFeatures: ["daemon.health/v1", "run.resource_attribution/v1"],
        collectHealth: async () => healthResult(),
        collectDrift: async () => [driftReport()],
      },
    );

    expect(result).toMatchObject({
      schema_version: "self-freshness/v1",
      summary: { fresh: 1, usable_with_warnings: 0, stale: 0, blocked: 0 },
      exit_code: 0,
      hosts: [{
        host: "blade",
        verdict: "fresh",
        capabilities: {
          missing: [],
        },
        actions: [],
      }],
    });
  });

  test("marks missing daemon capabilities as stale and points at self upgrade", async () => {
    const result = await runSelfFreshnessCommand(
      { host: "blade" },
      {
        now: () => NOW,
        authToken: "secret-token",
        expectedFeatures: ["daemon.health/v1", "run.resource_attribution/v1", "activity.turns/v1"],
        collectHealth: async () => healthResult(),
        collectDrift: async () => [driftReport()],
      },
    );

    expect(result.exit_code).toBe(3);
    expect(result.hosts[0]).toMatchObject({
      verdict: "stale",
      capabilities: {
        missing: ["activity.turns/v1"],
      },
      actions: ["calyx self upgrade --host blade --dry-run"],
    });
  });

  test("distinguishes healthy minor drift and active runs as usable warnings", async () => {
    const result = await runSelfFreshnessCommand(
      { host: "blade" },
      {
        now: () => NOW,
        authToken: "secret-token",
        expectedFeatures: ["daemon.health/v1", "run.resource_attribution/v1"],
        collectHealth: async () => healthResult({ activeRuns: 2 }),
        collectDrift: async () => [driftReport({ drift: "minor" })],
      },
    );

    expect(result.exit_code).toBe(1);
    expect(result.hosts[0]).toMatchObject({
      verdict: "usable_with_warnings",
      actions: [
        "calyx self upgrade --host blade --dry-run",
        "calyx run ps --host blade --json",
      ],
    });
  });

  test("reconciles a converged daemon with a local compare needs_fetch to usable_with_warnings", async () => {
    const result = await runSelfFreshnessCommand(
      { host: "blade" },
      {
        now: () => NOW,
        authToken: "secret-token",
        expectedFeatures: ["daemon.health/v1", "run.resource_attribution/v1"],
        collectHealth: async () => healthResult(),
        collectDrift: async () => [driftReport({
          drift: "needs_fetch",
          commitsBehind: null,
          diagnostics: [{
            kind: "needs_fetch",
            severity: "warning",
            message: "Local compare repo cannot compare daemon HEAD 20a1199 against target 970b739.",
            actions: ["git -C /repo fetch --all --prune"],
          }],
        })],
      },
    );

    // Health shows running===promoted===clone (converged) with no active runs, so the
    // needs_fetch is a local compare limitation, not daemon staleness: verdict downgrades
    // to usable_with_warnings while the raw drift diagnostic stays visible.
    expect(result.exit_code).toBe(1);
    expect(result.hosts[0]).toMatchObject({
      verdict: "usable_with_warnings",
      install_drift: {
        status: "converged",
      },
      drift: {
        status: "needs_fetch",
        commits_behind: null,
        diagnostics: [{
          kind: "needs_fetch",
          severity: "warning",
          actions: ["git -C /repo fetch --all --prune"],
        }],
      },
      actions: ["git -C /repo fetch --all --prune"],
    });
    expect(formatSelfFreshnessText(result)).toContain(
      "blade | usable_with_warnings | 970b739 | 970b739 | 970b739 | needs_fetch | converged | 0 | 0 | git -C /repo fetch --all --prune",
    );
  });

  test("keeps a converged needs_fetch daemon stale when it is missing required features", async () => {
    // Regression (POL-1860 Codex review): convergence reconciliation must NOT mask
    // missing-feature staleness. A converged+idle daemon with needs_fetch AND a missing
    // expected feature stays stale, with the self upgrade action surfaced.
    const result = await runSelfFreshnessCommand(
      { host: "blade" },
      {
        now: () => NOW,
        authToken: "secret-token",
        expectedFeatures: ["daemon.health/v1", "run.resource_attribution/v1", "activity.turns/v1"],
        collectHealth: async () => healthResult(),
        collectDrift: async () => [driftReport({
          drift: "needs_fetch",
          commitsBehind: null,
          diagnostics: [{
            kind: "needs_fetch",
            severity: "warning",
            message: "Local compare repo cannot compare daemon HEAD 20a1199 against target 970b739.",
            actions: ["git -C /repo fetch --all --prune"],
          }],
        })],
      },
    );

    expect(result.exit_code).toBe(3);
    expect(result.hosts[0]).toMatchObject({
      verdict: "stale",
      capabilities: { missing: ["activity.turns/v1"] },
      drift: { status: "needs_fetch" },
    });
    expect(result.hosts[0]?.actions).toContain("calyx self upgrade --host blade --dry-run");
  });

  test("keeps needs_fetch stale when convergence evidence is absent", async () => {
    const result = await runSelfFreshnessCommand(
      { host: "blade" },
      {
        now: () => NOW,
        authToken: "secret-token",
        expectedFeatures: ["daemon.health/v1", "run.resource_attribution/v1"],
        // Promoted install is ahead of the running daemon: genuinely behind, not converged.
        collectHealth: async () => healthResult({ runningHead: OLD_HEAD, promotedHead: CURRENT_HEAD, cloneHead: CURRENT_HEAD }),
        collectDrift: async () => [driftReport({
          drift: "needs_fetch",
          daemonHead: OLD_HEAD,
          commitsBehind: null,
          diagnostics: [{
            kind: "needs_fetch",
            severity: "warning",
            message: "Local compare repo cannot compare daemon HEAD 20a1199 against target 970b739.",
            actions: ["git -C /repo fetch --all --prune"],
          }],
        })],
      },
    );

    expect(result.exit_code).toBe(3);
    expect(result.hosts[0]).toMatchObject({
      verdict: "stale",
      install_drift: {
        status: "promoted_not_restarted",
      },
      drift: {
        status: "needs_fetch",
      },
      actions: [
        "git -C /repo fetch --all --prune",
        "calyx self upgrade --host blade --dry-run",
      ],
    });
  });

  test("reconciles needs_fetch with active runs to usable_with_warnings, not fresh", async () => {
    const result = await runSelfFreshnessCommand(
      { host: "blade" },
      {
        now: () => NOW,
        authToken: "secret-token",
        expectedFeatures: ["daemon.health/v1", "run.resource_attribution/v1"],
        collectHealth: async () => healthResult({ activeRuns: 2 }),
        collectDrift: async () => [driftReport({
          drift: "needs_fetch",
          commitsBehind: null,
          diagnostics: [{
            kind: "needs_fetch",
            severity: "warning",
            message: "Local compare repo cannot compare daemon HEAD 20a1199 against target 970b739.",
            actions: ["git -C /repo fetch --all --prune"],
          }],
        })],
      },
    );

    // Converged install + needs_fetch + active runs: not fresh, and not stale — it lands on
    // usable_with_warnings (the active-runs warning path) with run ps surfaced alongside fetch.
    expect(result.exit_code).toBe(1);
    expect(result.hosts[0]).toMatchObject({
      verdict: "usable_with_warnings",
      install_drift: {
        status: "converged",
      },
      drift: {
        status: "needs_fetch",
      },
      actions: [
        "git -C /repo fetch --all --prune",
        "calyx run ps --host blade --json",
      ],
    });
  });

  test("keeps healthy and current hosts fresh", async () => {
    const result = await runSelfFreshnessCommand(
      { host: "blade" },
      {
        now: () => NOW,
        authToken: "secret-token",
        expectedFeatures: ["daemon.health/v1", "run.resource_attribution/v1"],
        collectHealth: async () => healthResult(),
        collectDrift: async () => [driftReport()],
      },
    );

    expect(result.exit_code).toBe(0);
    expect(result.hosts[0]).toMatchObject({
      verdict: "fresh",
      drift: {
        status: "current",
        diagnostics: [],
      },
      actions: [],
    });
  });

  test("reports clone/promoted/running install drift as stale typed states", async () => {
    const promotedNotRestarted = await runSelfFreshnessCommand(
      { host: "blade" },
      {
        now: () => NOW,
        authToken: "secret-token",
        expectedFeatures: ["daemon.health/v1", "run.resource_attribution/v1"],
        collectHealth: async () => healthResult({ runningHead: OLD_HEAD, promotedHead: CURRENT_HEAD, cloneHead: CURRENT_HEAD }),
        collectDrift: async () => [driftReport()],
      },
    );
    expect(promotedNotRestarted.hosts[0]).toMatchObject({
      verdict: "stale",
      install_drift: {
        status: "promoted_not_restarted",
        running_head: OLD_HEAD,
        promoted_head: CURRENT_HEAD,
        clone_head: CURRENT_HEAD,
      },
      actions: ["calyx self upgrade --host blade --dry-run"],
    });

    const cloneNotPromoted = await runSelfFreshnessCommand(
      { host: "blade" },
      {
        now: () => NOW,
        authToken: "secret-token",
        expectedFeatures: ["daemon.health/v1", "run.resource_attribution/v1"],
        collectHealth: async () => healthResult({ runningHead: OLD_HEAD, promotedHead: OLD_HEAD, cloneHead: CURRENT_HEAD }),
        collectDrift: async () => [driftReport({ daemonHead: OLD_HEAD })],
      },
    );
    expect(cloneNotPromoted.hosts[0]).toMatchObject({
      verdict: "stale",
      install_drift: {
        status: "clone_not_promoted",
        running_head: OLD_HEAD,
        promoted_head: OLD_HEAD,
        clone_head: CURRENT_HEAD,
      },
      actions: ["calyx self upgrade --host blade --dry-run"],
    });
  });

  test("keeps broken daemon drift blocked even when install drift is stale", async () => {
    const result = await runSelfFreshnessCommand(
      { host: "blade" },
      {
        now: () => NOW,
        authToken: "secret-token",
        expectedFeatures: ["daemon.health/v1", "run.resource_attribution/v1"],
        collectHealth: async () => healthResult({ runningHead: OLD_HEAD, promotedHead: CURRENT_HEAD, cloneHead: CURRENT_HEAD }),
        collectDrift: async () => [driftReport({
          drift: "broken",
          daemonHead: OLD_HEAD,
          commitsBehind: null,
          diagnostics: [],
        })],
      },
    );

    expect(result.exit_code).toBe(6);
    expect(result.hosts[0]).toMatchObject({
      verdict: "blocked",
      drift: {
        status: "broken",
      },
      install_drift: {
        status: "promoted_not_restarted",
      },
    });
  });

  test("marks unreachable hosts as blocked", async () => {
    const result = await runSelfFreshnessCommand(
      { host: "worm" },
      {
        now: () => NOW,
        authToken: "secret-token",
        expectedFeatures: ["daemon.health/v1"],
        collectHealth: async () => healthResult({ host: "worm", ok: false }),
        collectDrift: async () => [{
          ...driftReport({ host: "worm", drift: "broken" }),
          daemonHead: null,
          commitsBehind: null,
          brokenReason: "GET /health failed",
        }],
      },
    );

    expect(result.exit_code).toBe(6);
    expect(result.hosts[0]).toMatchObject({
      host: "worm",
      verdict: "blocked",
      health: {
        status: "error",
        error_kind: "unreachable",
      },
      actions: ["calyx self health --host worm --json"],
    });
  });

  test.each([
    {
      name: "HTTP 400 failure",
      error: {
        kind: "http_error" as const,
        message: "HTTP 400: bad health request",
        http_status: 400,
        error_code: "invalid_request",
        response_retryable: false,
      },
    },
    {
      name: "HTTP 500 failure",
      error: {
        kind: "http_error" as const,
        message: "HTTP 500: health projection failed",
        http_status: 500,
        error_code: "internal_error",
        response_retryable: false,
      },
    },
    {
      name: "protocol failure",
      error: {
        kind: "invalid_response" as const,
        message: "health response failed schema validation",
        http_status: 200,
        response_phase: "invalid_response" as const,
      },
    },
  ] satisfies readonly { name: string; error: SelfHealthErrorPayload }[])(
    "preserves typed $name evidence in freshness",
    async ({ error }) => {
      const result = await runSelfFreshnessCommand(
        { host: "worm" },
        {
          now: () => NOW,
          authToken: "secret-token",
          expectedFeatures: ["daemon.health/v1"],
          collectHealth: async () => healthResult({ host: "worm", ok: false, error }),
          collectDrift: async () => [{
            ...driftReport({ host: "worm", drift: "broken" }),
            daemonHead: null,
            commitsBehind: null,
            brokenReason: error.message,
          }],
        },
      );

      expect(result.exit_code).toBe(6);
      expect(result.hosts[0]).toMatchObject({
        host: "worm",
        verdict: "blocked",
        health: {
          status: "error",
          error_kind: error.kind,
          ...(error.http_status !== undefined ? { http_status: error.http_status } : {}),
          ...(error.error_code ? { error_code: error.error_code } : {}),
          ...(error.response_retryable !== undefined
            ? { response_retryable: error.response_retryable }
            : {}),
          ...(error.response_phase ? { response_phase: error.response_phase } : {}),
        },
      });
    },
  );

  test("formats a compact text table with next actions", async () => {
    const result = await runSelfFreshnessCommand(
      { host: "blade" },
      {
        now: () => NOW,
        authToken: "secret-token",
        expectedFeatures: ["daemon.health/v1", "run.resource_attribution/v1", "activity.turns/v1"],
        collectHealth: async () => healthResult(),
        collectDrift: async () => [driftReport()],
      },
    );

    expect(formatSelfFreshnessText(result)).toContain(
      "blade | stale | 970b739 | 970b739 | 970b739 | current | converged | 0 | 1 | calyx self upgrade --host blade --dry-run",
    );
  });

  test("CLI exposes calyx self freshness --json", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const agentsInfraRoot = await makeAgentsInfraRoot();
    const program = buildProgram({
        runCli: {
          currentHostAlias: "blade",
          agentsInfraRoot,
          repoRoot: "/tmp/calyx-compare",
          execFileAsync: vi.fn(async (file, args) => {
            const command = `${file} ${args.join(" ")}`;
            if (command === "git rev-parse origin/main") {
              return { stdout: `${CURRENT_HEAD}\n`, stderr: "" };
            }
            if (command === "git rev-parse HEAD") {
              return { stdout: `${CHECKOUT_HEAD}\n`, stderr: "" };
            }
            if (command === `git log --format=%H ${CURRENT_HEAD}..${CURRENT_HEAD}`) {
              return { stdout: "", stderr: "" };
            }
            return { stdout: "", stderr: "" };
          }),
          createAdminClient: createAdminClientFactory(vi.fn(async () => {
            const health = healthResult().results[0]!;
            return new Response(JSON.stringify(health.ok ? health.health : {}), {
              headers: {
                "content-type": "application/json",
                "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
              },
            });
          })),
          now: () => NOW,
          tokenForHost: () => "secret-token",
        },
    });

    await expect(
      program.parseAsync(["node", "calyx", "self", "freshness", "--host", "blade", "--json"]),
    ).rejects.toMatchObject({ exitCode: 3 });

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as SelfFreshnessResult;
    expect(payload.schema_version).toBe("self-freshness/v1");
    expect(payload.hosts[0]?.host).toBe("blade");
    expect(payload.warnings?.[0]).toMatchObject({
      code: "fleet_convergence_persist_unavailable",
    });
  });

  test("CLI persists daemon convergence rows from freshness observations", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const agentsInfraRoot = await makeAgentsInfraRoot();
    await applyStateMigrations();

    try {
      const program = buildProgram({
        runCli: {
          currentHostAlias: "blade",
          agentsInfraRoot,
          repoRoot: "/tmp/calyx-compare",
          execFileAsync: vi.fn(async (file, args) => {
            const command = `${file} ${args.join(" ")}`;
            if (command === "git rev-parse origin/main") {
              return { stdout: `${CURRENT_HEAD}\n`, stderr: "" };
            }
            if (command === "git rev-parse HEAD") {
              return { stdout: `${CHECKOUT_HEAD}\n`, stderr: "" };
            }
            if (command === `git log --format=%H ${OLD_HEAD}..${CURRENT_HEAD}`) {
              return { stdout: "commit-a\ncommit-b\n", stderr: "" };
            }
            return { stdout: "", stderr: "" };
          }),
          createAdminClient: createAdminClientFactory(vi.fn(async () => {
            const health = healthResult().results[0]!;
            return new Response(JSON.stringify(health.ok ? health.health : {}), {
              headers: {
                "content-type": "application/json",
                "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
              },
            });
          })),
          now: () => NOW,
          tokenForHost: () => "secret-token",
        },
      });

      await expect(
        program.parseAsync(["node", "calyx", "self", "freshness", "--host", "blade", "--against", "origin/main", "--json"]),
      ).rejects.toMatchObject({ exitCode: 3 });

      expect(JSON.parse(String(out.mock.calls[0]?.[0])).schema_version).toBe("self-freshness/v1");

      const opened = await openStateStore();
      try {
        const rows = listFleetConvergenceRows(opened.db, { host: "blade" });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          host: "blade",
          leg: "daemon_build",
          target_rev: CURRENT_HEAD,
          observed_rev: CURRENT_HEAD,
          converged_from: CHECKOUT_HEAD,
          policy: "auto",
          verdict: "pending",
          last_checked_at: NOW.toISOString(),
        });
        expect(rows[0]?.payload).toMatchObject({
          source: "self-freshness",
          promoted_rev: CURRENT_HEAD,
          running_rev: CURRENT_HEAD,
          clone_head: CURRENT_HEAD,
          install_drift: {
            status: "converged",
          },
        });
      } finally {
        opened.db.close();
      }
    } finally {
      // State-store assertions own their cleanup above; auth is injected through tokenForHost.
    }
  });

  test("persists unreachable hosts as pending and preserves upgrade receipt linkage", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      upsertFleetConvergenceRow(opened.db, {
        host: "worm",
        leg: "daemon_build",
        target_rev: CURRENT_HEAD,
        observed_rev: null,
        converged_from: CHECKOUT_HEAD,
        policy: "auto",
        last_checked_at: "2026-06-10T19:00:00.000Z",
        verdict: "pending",
        receipt_path: "/receipts/fleet/summary.json",
        receipt_id: "fleet-20260610",
      });
    } finally {
      opened.db.close();
    }

    const result = await runSelfFreshnessCommand(
      { host: "worm", against: "origin/main" },
      {
        now: () => NOW,
        authToken: "secret-token",
        expectedFeatures: ["daemon.health/v1"],
        execFileAsync: vi.fn(async (file, args) => {
          const command = `${file} ${args.join(" ")}`;
          if (command === "git rev-parse HEAD") {
            return { stdout: `${CHECKOUT_HEAD}\n`, stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }),
        collectHealth: async () => healthResult({ host: "worm", ok: false }),
        collectDrift: async () => [{
          ...driftReport({ host: "worm", drift: "broken" }),
          targetHead: CURRENT_HEAD,
          daemonHead: null,
          commitsBehind: null,
          brokenReason: "GET /health failed",
        }],
        persistConvergence: true,
      },
    );

    expect(result.hosts[0]).toMatchObject({
      host: "worm",
      verdict: "blocked",
    });

    const after = await openStateStore();
    try {
      const rows = listFleetConvergenceRows(after.db, { host: "worm" });
      expect(rows[0]).toMatchObject({
        verdict: "pending",
        receipt_path: "/receipts/fleet/summary.json",
        receipt_id: "fleet-20260610",
        converged_from: CHECKOUT_HEAD,
      });
    } finally {
      after.db.close();
    }
  });

  test("persistence warnings do not change freshness exit codes", async () => {
    const result = await runSelfFreshnessCommand(
      { host: "blade", against: "origin/main" },
      {
        now: () => NOW,
        authToken: "secret-token",
        expectedFeatures: ["daemon.health/v1", "run.resource_attribution/v1"],
        execFileAsync: vi.fn(async () => ({ stdout: `${CHECKOUT_HEAD}\n`, stderr: "" })),
        collectHealth: async () => healthResult(),
        collectDrift: async () => [driftReport()],
        persistConvergence: true,
      },
    );

    expect(result.exit_code).toBe(0);
    expect(result.warnings?.[0]).toMatchObject({
      code: "fleet_convergence_persist_unavailable",
    });
    const opened = await openStateStore();
    try {
      expect(() => listFleetConvergenceRows(opened.db)).toThrow();
    } finally {
      opened.db.close();
    }
  });
});
