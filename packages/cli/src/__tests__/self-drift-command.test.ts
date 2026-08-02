import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCalyxAdminClient } from "@polli-labs/calyx-client/admin";
import { describe, expect, test, vi } from "vitest";
import { buildProgram } from "../run-cli";
import { STATE_MIGRATIONS } from "@polli-labs/calyx-core";
import {
  collectSelfDriftReports,
  formatSelfDriftTable,
  toSelfDriftJsonResults,
  type ExecFileAsync,
  type SelfDriftJsonResult,
  type SelfDriftReport,
} from "../self-drift.js";

const TARGET_HEAD = "ed6e1fa000000000000000000000000000000000";
const CURRENT_HEAD = TARGET_HEAD;
const MINOR_HEAD = "5806e87000000000000000000000000000000000";
const MAJOR_HEAD = "5806e87100000000000000000000000000000000";
const AGE_MAJOR_HEAD = "5806e87200000000000000000000000000000000";
const CRITICAL_HEAD = "5806e87300000000000000000000000000000000";
const MISSING_HEAD = "1234567000000000000000000000000000000000";
const TEST_REPO_ROOT = "/tmp/calyx-compare";

function makeHealth(gitHead: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "calyx.admin-health/v1",
    protocol_epoch: 1,
    daemon_kind: "run-service",
    daemon_id: "run-serve",
    pid: 123,
    uptime_ms: 1000,
    started_at: "2026-04-20T00:00:00.000Z",
    build: {
      git_head: gitHead,
      built_at: "2026-04-20T00:00:00.000Z",
      package_version: "0.2.0",
    },
    env: {
      inherited_path: "/usr/bin",
    },
    active_runs: 0,
    maintenance_mode: false,
    supports_features: [],
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
      ...(status === 401 ? { "www-authenticate": 'Bearer realm="calyx-run"' } : {}),
    },
  });
}

function createAdminClientFactory(fetchImpl: typeof fetch): typeof createCalyxAdminClient {
  return (options) => createCalyxAdminClient({
    ...options,
    fetch: fetchImpl,
  });
}

function createGitStub(stubs: Record<string, string>): ExecFileAsync {
  return vi.fn(async (_file, args) => {
    const key = args.join(" ");
    const stdout = stubs[key];
    if (stdout === undefined) {
      throw new Error(`Unexpected git args: ${key}`);
    }
    return { stdout, stderr: "" };
  });
}

async function createAgentsInfraRoot(
  hosts: string[],
  repos: Record<string, string> = {},
  serverUrls: Record<string, string> = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "calyx-self-drift-"));

  await mkdir(path.join(root, "instructions", "skills"), { recursive: true });
  await mkdir(path.join(root, "instructions", "templates"), { recursive: true });
  await mkdir(path.join(root, "fleet", "truths"), { recursive: true });
  await writeFile(path.join(root, "instructions", "skills", "SOURCES.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "instructions", "templates", "REGISTRY.json"), "{}\n", "utf8");

  const hostsYaml = [
    "hosts:",
    ...hosts.flatMap((host) => [
      `  ${host}:`,
      `    home: /home/${host}`,
      `    run_serve_url: ${serverUrls[host] ?? (host === "blade" ? "http://127.0.0.1:8740" : `http://${host}:8740`)}`,
      ...(repos[host]
        ? [
            "    repos:",
            "      calyx:",
            `        path: ${repos[host]}`,
          ]
        : []),
    ]),
    "",
  ].join("\n");
  await writeFile(path.join(root, "fleet", "truths", "hosts.yaml"), hostsYaml, "utf8");
  return root;
}

describe("self drift state-schema reporting (POL-2090)", () => {
  const LOCAL_TARGET = STATE_MIGRATIONS[STATE_MIGRATIONS.length - 1]!.id;

  async function driftFor(stateSchema: unknown): Promise<SelfDriftReport[]> {
    return collectSelfDriftReports(
      { host: "blade", authToken: "secret-token" },
      {
        currentHostAlias: "blade",
        agentsInfraRoot: "/tmp/unused-agents-infra",
        repoRoot: TEST_REPO_ROOT,
        execFileAsync: createGitStub({ "rev-parse origin/main": `${TARGET_HEAD}\n` }),
        createAdminClient: createAdminClientFactory(
          vi.fn(async () => jsonResponse(makeHealth(CURRENT_HEAD, { state_schema: stateSchema }))),
        ),
      },
    );
  }

  test("measures a reported ledger head against this build's migration source", async () => {
    const reports = await driftFor({ status: "current", current: "0019", target: "0019", pending: 0 });
    expect(reports[0]?.schema).toEqual({
      current: "0019",
      target: LOCAL_TARGET,
      behind: STATE_MIGRATIONS.filter((migration) => migration.id > "0019").length,
      status: "behind",
    });
    expect(reports[0]?.summary).toContain(`state schema 0019 is`);
    expect(reports[0]?.summary).toContain(`behind ${LOCAL_TARGET}`);
  });

  test("schema divergence does NOT escalate the drift severity that gates fleet work", async () => {
    // `calyx self upgrade` is the operation that converges a schema, and
    // `self drift` gating is what fleet tooling consults before dispatch. A
    // schema-driven gate would refuse the repair path, so the two axes stay
    // independent: a build-current host with a stale ledger is still `current`.
    const reports = await driftFor({ status: "current", current: "0019", target: "0019", pending: 0 });
    expect(reports[0]?.drift).toBe("current");
    expect(reports[0]?.commitsBehind).toBe(0);
    expect(reports[0]?.missingOperationalFixes).toEqual([]);
  });

  test("names a store that outran the build reading it", async () => {
    const reports = await driftFor({ status: "ahead", current: "9999", target: "0018", pending: 0 });
    expect(reports[0]?.schema).toMatchObject({ current: "9999", status: "ahead", behind: 0 });
    expect(reports[0]?.summary).toContain("state schema 9999 is ahead of this build's");
    expect(reports[0]?.drift).toBe("current");
  });

  test("a daemon that omits or cannot read the field reports no schema, not parity", async () => {
    expect((await driftFor(undefined))[0]?.schema).toBeNull();
    expect((await driftFor({ status: "unavailable" }))[0]?.schema).toBeNull();
  });

  test("the table gains a schema column and a fleet convergence footer", () => {
    const base = {
      drift: "current" as const,
      daemonHead: TARGET_HEAD,
      targetHead: TARGET_HEAD,
      commitsBehind: 0,
      missingOperationalFixes: [],
      diagnostics: [],
      summary: "at ed6e1fa",
    };
    const table = formatSelfDriftTable([
      { ...base, host: "blade", schema: { current: "0024", target: "0034", behind: 10, status: "behind" } },
      { ...base, host: "worm", schema: { current: "0034", target: "0034", behind: 0, status: "current" } },
      { ...base, host: "mba", schema: null },
    ]);
    expect(table.split("\n")[0]).toContain("schema");
    expect(table).toMatch(/^blade .*\| 0024 -10 \|/m);
    expect(table).toMatch(/^worm .*\| 0034\s+\| at ed6e1fa$/m);
    expect(table).toMatch(/^mba .*\| -\s+\| at ed6e1fa$/m);
    expect(table).toContain(
      "state schema: 3 versions across 3 hosts - 0024 (blade), 0034 (worm), unknown (mba)",
    );
  });

  test("the JSON projection carries the schema position", async () => {
    const reports = await driftFor({ status: "current", current: "0019", target: "0019", pending: 0 });
    expect(toSelfDriftJsonResults(reports)[0]?.schema).toMatchObject({
      current: "0019",
      target: LOCAL_TARGET,
      status: "behind",
    });
  });
});

describe("collectSelfDriftReports", () => {
  test("classifies current when daemon head matches target", async () => {
    const reports = await collectSelfDriftReports(
      {
        host: "blade",
        authToken: "secret-token",
      },
      {
        currentHostAlias: "blade",
        agentsInfraRoot: "/tmp/unused-agents-infra",
        repoRoot: TEST_REPO_ROOT,
        execFileAsync: createGitStub({
          "rev-parse origin/main": `${TARGET_HEAD}\n`,
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async () => jsonResponse(makeHealth(CURRENT_HEAD)))),
      },
    );

    expect(reports).toMatchObject([
      {
        host: "blade",
        drift: "current",
        daemonHead: TARGET_HEAD,
        commitsBehind: 0,
        missingOperationalFixes: [],
      },
    ]);
  });

  test("classifies minor when daemon is behind without registered fixes", async () => {
    const reports = await collectSelfDriftReports(
      {
        host: "blade",
        authToken: "secret-token",
      },
      {
        currentHostAlias: "blade",
        agentsInfraRoot: "/tmp/unused-agents-infra",
        repoRoot: TEST_REPO_ROOT,
        execFileAsync: createGitStub({
          "rev-parse origin/main": `${TARGET_HEAD}\n`,
          [`log --format=%H ${MINOR_HEAD}..${TARGET_HEAD}`]: "1111111\n2222222\n",
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async () => jsonResponse(makeHealth(MINOR_HEAD)))),
      },
    );

    expect(reports[0]).toMatchObject({
      drift: "minor",
      commitsBehind: 2,
      missingOperationalFixes: [],
    });
  });

  test("classifies major when a major operational fix is missing", async () => {
    const reports = await collectSelfDriftReports(
      {
        host: "blade",
        authToken: "secret-token",
      },
      {
        currentHostAlias: "blade",
        agentsInfraRoot: "/tmp/unused-agents-infra",
        repoRoot: TEST_REPO_ROOT,
        execFileAsync: createGitStub({
          "rev-parse origin/main": `${TARGET_HEAD}\n`,
          [`log --format=%H ${MAJOR_HEAD}..${TARGET_HEAD}`]: "f636ca9\n",
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async () => jsonResponse(makeHealth(MAJOR_HEAD)))),
      },
    );

    expect(reports[0]).toMatchObject({
      drift: "major",
      commitsBehind: 1,
      missingOperationalFixes: [
        {
          id: "run.vault_execplan_ref/v1",
          issue: "POL-1102",
          severity: "major",
        },
      ],
    });
  });

  test("classifies major when missing commits exceed the age threshold", async () => {
    const missingCommits = Array.from({ length: 21 }, (_, idx) => `${idx.toString(16).padStart(7, "0")}`).join("\n");
    const reports = await collectSelfDriftReports(
      {
        host: "blade",
        authToken: "secret-token",
      },
      {
        currentHostAlias: "blade",
        agentsInfraRoot: "/tmp/unused-agents-infra",
        repoRoot: TEST_REPO_ROOT,
        execFileAsync: createGitStub({
          "rev-parse origin/main": `${TARGET_HEAD}\n`,
          [`log --format=%H ${AGE_MAJOR_HEAD}..${TARGET_HEAD}`]: `${missingCommits}\n`,
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async () => jsonResponse(makeHealth(AGE_MAJOR_HEAD)))),
      },
    );

    expect(reports[0]).toMatchObject({
      drift: "major",
      commitsBehind: 21,
      missingOperationalFixes: [],
    });
  });

  test("classifies critical when a critical operational fix is missing", async () => {
    const reports = await collectSelfDriftReports(
      {
        host: "blade",
        authToken: "secret-token",
      },
      {
        currentHostAlias: "blade",
        agentsInfraRoot: "/tmp/unused-agents-infra",
        repoRoot: TEST_REPO_ROOT,
        execFileAsync: createGitStub({
          "rev-parse origin/main": `${TARGET_HEAD}\n`,
          [`log --format=%H ${CRITICAL_HEAD}..${TARGET_HEAD}`]: "901bb01\nabcd123\n",
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async () => jsonResponse(makeHealth(CRITICAL_HEAD)))),
      },
    );

    expect(reports[0]).toMatchObject({
      drift: "critical",
      commitsBehind: 2,
      missingOperationalFixes: [
        {
          id: "run.default_path_injection/v1",
          issue: "POL-1100",
          severity: "critical",
        },
      ],
    });
  });

  test("matches op-fix registry entries against full SHAs via prefix (survives git auto-abbrev growth)", async () => {
    // Regression for the Greptile P1 flagged on PR #91 re-review: once the
    // repo grows enough for git to auto-size abbreviated SHAs to 8+ chars,
    // a naive `%h` + exact-set-match would silently miss critical entries
    // whose `introduced_by` is hardcoded at 7. Using `%H` + prefix-match
    // keeps the 7-char registry entries load-bearing.
    const fullSha = "901bb013fbd4f4e2a1dd9e0c7c5b8aa2f31c4000"; // prefix "901bb01" is POL-1100
    const otherFull = "f636ca9" + "0".repeat(33);              // prefix "f636ca9" is POL-1102
    const reports = await collectSelfDriftReports(
      {
        host: "blade",
        authToken: "secret-token",
      },
      {
        currentHostAlias: "blade",
        agentsInfraRoot: "/tmp/unused-agents-infra",
        repoRoot: TEST_REPO_ROOT,
        execFileAsync: createGitStub({
          "rev-parse origin/main": `${TARGET_HEAD}\n`,
          [`log --format=%H ${CRITICAL_HEAD}..${TARGET_HEAD}`]: `${fullSha}\n${otherFull}\n`,
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async () => jsonResponse(makeHealth(CRITICAL_HEAD)))),
      },
    );

    expect(reports[0]).toMatchObject({
      drift: "critical",
      commitsBehind: 2,
      missingOperationalFixes: [
        { id: "run.default_path_injection/v1", severity: "critical" },
        { id: "run.vault_execplan_ref/v1", severity: "major" },
      ],
    });
  });

  test("classifies broken when /health is unreachable", async () => {
    const reports = await collectSelfDriftReports(
      {
        host: "blade",
        authToken: "secret-token",
      },
      {
        currentHostAlias: "blade",
        agentsInfraRoot: "/tmp/unused-agents-infra",
        repoRoot: TEST_REPO_ROOT,
        execFileAsync: createGitStub({
          "rev-parse origin/main": `${TARGET_HEAD}\n`,
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async () => {
          throw new Error("connect ECONNREFUSED");
        })),
      },
    );

    expect(reports[0]).toMatchObject({
      drift: "broken",
      daemonHead: null,
      commitsBehind: null,
    });
    expect(reports[0]?.brokenReason).toContain("Network request failed before response headers");
  });

  test("classifies a missing daemon git head as a local compare repair state", async () => {
    const repoRoot = "/tmp/calyx-compare";
    const reports = await collectSelfDriftReports(
      {
        host: "blade",
        authToken: "secret-token",
      },
      {
        currentHostAlias: "blade",
        agentsInfraRoot: "/tmp/unused-agents-infra",
        repoRoot,
        execFileAsync: vi.fn(async (_file, args) => {
          const key = args.join(" ");
          if (key === "rev-parse origin/main") {
            return { stdout: `${TARGET_HEAD}\n`, stderr: "" };
          }
          if (key === `log --format=%H ${MISSING_HEAD}..${TARGET_HEAD}`) {
            throw new Error(`fatal: Invalid revision range '${MISSING_HEAD}..${TARGET_HEAD}'`);
          }
          throw new Error(`Unexpected git args: ${key}`);
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async () => jsonResponse(makeHealth(MISSING_HEAD)))),
      },
    );

    expect(reports[0]).toMatchObject({
      host: "blade",
      drift: "needs_fetch",
      daemonHead: MISSING_HEAD,
      targetHead: TARGET_HEAD,
      commitsBehind: null,
      diagnostics: [{
        kind: "needs_fetch",
        severity: "warning",
        actions: [`git -C ${repoRoot} fetch --all --prune`],
      }],
    });
    expect(reports[0]?.summary).toContain("Local compare repo cannot compare daemon HEAD");
    expect(reports[0]?.brokenReason).toBeUndefined();
  });

  test("classifies a missing target ref as a local compare repair state", async () => {
    const repoRoot = "/tmp/calyx-compare";
    const reports = await collectSelfDriftReports(
      {
        host: "blade",
        against: "origin/main",
        authToken: "secret-token",
      },
      {
        currentHostAlias: "blade",
        agentsInfraRoot: "/tmp/unused-agents-infra",
        repoRoot,
        execFileAsync: vi.fn(async (_file, args) => {
          const key = args.join(" ");
          if (key === "rev-parse origin/main") {
            throw new Error("fatal: ambiguous argument 'origin/main': unknown revision or path not in the working tree.");
          }
          throw new Error(`Unexpected git args: ${key}`);
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async () => jsonResponse(makeHealth(CURRENT_HEAD)))),
      },
    );

    expect(reports[0]).toMatchObject({
      host: "blade",
      drift: "needs_fetch",
      daemonHead: CURRENT_HEAD,
      targetHead: "origin/main",
      commitsBehind: null,
      diagnostics: [{
        kind: "missing_target_ref",
        severity: "warning",
        actions: [`git -C ${repoRoot} fetch --all --prune`],
      }],
    });
    expect(reports[0]?.summary).toContain('Local compare repo cannot resolve target ref "origin/main"');
    expect(reports[0]?.brokenReason).toBeUndefined();
  });

  test("resolves the compare repo from host truth instead of the package install path", async () => {
    const compareRoot = "/tmp/registered-calyx-dev";
    const agentsInfraRoot = await createAgentsInfraRoot(["blade"], { blade: compareRoot });
    const gitCalls: Array<{ args: string; cwd?: string }> = [];
    const reports = await collectSelfDriftReports(
      {
        host: "blade",
        authToken: "secret-token",
      },
      {
        currentHostAlias: "blade",
        agentsInfraRoot,
        execFileAsync: vi.fn(async (_file, args, options) => {
          const key = args.join(" ");
          gitCalls.push({ args: key, cwd: options?.cwd });
          if (key === "rev-parse --show-toplevel" && options?.cwd === compareRoot) {
            return { stdout: `${compareRoot}\n`, stderr: "" };
          }
          if (key === "rev-parse origin/main") {
            return { stdout: `${TARGET_HEAD}\n`, stderr: "" };
          }
          if (key === `log --format=%H ${MINOR_HEAD}..${TARGET_HEAD}`) {
            return { stdout: "1111111\n", stderr: "" };
          }
          throw new Error(`Unexpected git call ${key} in ${options?.cwd ?? "<no cwd>"}`);
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async () => jsonResponse(makeHealth(MINOR_HEAD)))),
      },
    );

    expect(reports[0]).toMatchObject({
      host: "blade",
      drift: "minor",
      commitsBehind: 1,
    });
    expect(gitCalls).toEqual([
      { args: "rev-parse --show-toplevel", cwd: compareRoot },
      { args: "rev-parse origin/main", cwd: compareRoot },
      { args: `log --format=%H ${MINOR_HEAD}..${TARGET_HEAD}`, cwd: compareRoot },
    ]);
  });

  test("does not emit a bogus git fetch command when no compare checkout can be validated", async () => {
    const agentsInfraRoot = await createAgentsInfraRoot(["blade"]);
    const reports = await collectSelfDriftReports(
      {
        host: "blade",
        against: "origin/main",
        authToken: "secret-token",
      },
      {
        currentHostAlias: "blade",
        agentsInfraRoot,
        execFileAsync: vi.fn(async (_file, args) => {
          if (args.join(" ") === "rev-parse --show-toplevel") {
            throw new Error("not a git checkout");
          }
          throw new Error(`Unexpected git args: ${args.join(" ")}`);
        }),
        createAdminClient: createAdminClientFactory(vi.fn(async () => jsonResponse(makeHealth(CURRENT_HEAD)))),
      },
    );

    expect(reports[0]).toMatchObject({
      host: "blade",
      drift: "needs_fetch",
      daemonHead: CURRENT_HEAD,
      targetHead: "origin/main",
      commitsBehind: null,
      diagnostics: [{
        kind: "compare_repo_unavailable",
        severity: "warning",
      }],
    });
    expect(reports[0]?.diagnostics[0]?.actions.join("\n")).not.toContain("git -C");
    expect(reports[0]?.summary).toContain("Unable to find a validated Calyx git checkout");
  });
});

describe("calyx self drift command", () => {
  test("--host blade emits machine-readable JSON for a known missing critical fix", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const agentsInfraRoot = await createAgentsInfraRoot(["blade"]);

    try {
      const program = buildProgram({
        runCli: {
          currentHostAlias: "blade",
          agentsInfraRoot,
          repoRoot: TEST_REPO_ROOT,
          execFileAsync: createGitStub({
            "rev-parse origin/main": `${TARGET_HEAD}\n`,
            [`log --format=%H ${CRITICAL_HEAD}..${TARGET_HEAD}`]: "901bb01\nabcd123\n",
          }),
          tokenForHost: () => "secret-token",
          createAdminClient: createAdminClientFactory(vi.fn(async (input, init) => {
            expect(String(input)).toBe("http://127.0.0.1:8740/v1/admin/health");
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
            return jsonResponse(makeHealth(CRITICAL_HEAD));
          })),
        },
      });

      await expect(
        program.parseAsync([
          "node",
          "calyx",
          "self",
          "drift",
          "--host",
          "blade",
          "--json",
        ]),
      ).rejects.toMatchObject({ exitCode: 1 });

      const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as SelfDriftJsonResult[];
      expect(payload).toMatchObject([
        {
          host: "blade",
          drift: "critical",
          daemon_head: "5806e87",
          target_head: "ed6e1fa",
          commits_behind: 2,
          missing_op_fixes: [
            {
              id: "run.default_path_injection/v1",
              issue: "POL-1100",
              severity: "critical",
            },
          ],
        },
      ]);
    } finally {
      await rm(agentsInfraRoot, { recursive: true, force: true });
    }
  });

  test("--fleet carries each exact fleet-truth URL with its matching host credential", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const agentsInfraRoot = await createAgentsInfraRoot(
      ["blade", "worm"],
      {},
      { worm: "https://worm.internal:9443" },
    );

    try {
      const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url === "http://127.0.0.1:8740/v1/admin/health") {
          return jsonResponse(makeHealth(CURRENT_HEAD));
        }
        if (url === "https://worm.internal:9443/v1/admin/health") {
          return jsonResponse(makeHealth(MAJOR_HEAD));
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const program = buildProgram({
        runCli: {
          currentHostAlias: "blade",
          agentsInfraRoot,
          repoRoot: TEST_REPO_ROOT,
          execFileAsync: createGitStub({
            "rev-parse origin/main": `${TARGET_HEAD}\n`,
            [`log --format=%H ${MAJOR_HEAD}..${TARGET_HEAD}`]: "f636ca9\n",
          }),
          createAdminClient: createAdminClientFactory(fetchImpl),
          tokenForHost: () => "secret-token",
        },
      });

      await expect(
        program.parseAsync([
          "node",
          "calyx",
          "self",
          "drift",
          "--fleet",
          "--json",
        ]),
      ).rejects.toMatchObject({ exitCode: 1 });

      const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as SelfDriftJsonResult[];
      expect(payload.map((entry) => entry.host)).toEqual(["blade", "worm"]);
      expect(payload).toMatchObject([
        {
          host: "blade",
          drift: "current",
          daemon_head: "ed6e1fa",
          target_head: "ed6e1fa",
          commits_behind: 0,
          missing_op_fixes: [],
          diagnostics: [],
        },
        {
          host: "worm",
          drift: "major",
          daemon_head: "5806e87",
          target_head: "ed6e1fa",
          commits_behind: 1,
          missing_op_fixes: [
            {
              id: "run.vault_execplan_ref/v1",
              issue: "POL-1102",
              severity: "major",
            },
          ],
          diagnostics: [],
        },
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await rm(agentsInfraRoot, { recursive: true, force: true });
    }
  });
});
