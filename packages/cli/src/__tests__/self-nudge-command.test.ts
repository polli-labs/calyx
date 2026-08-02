import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCalyxAdminClient } from "@polli-labs/calyx-client/admin";
import { describe, expect, test, vi, afterEach } from "vitest";
import { buildProgram } from "../run-cli";
import { createLinearGraphqlRequester } from "../linear-graphql-requester.js";
import type { ExecFileAsync } from "../self-drift.js";

const TARGET_HEAD = "ed6e1fa000000000000000000000000000000000";
const MAJOR_HEAD = "5806e87100000000000000000000000000000000";
const MISSING_HEAD = "1234567000000000000000000000000000000000";
const TEST_REPO_ROOT = "/tmp/calyx-compare";

const originalLinearApiKey = process.env["LINEAR_API_KEY"];
const originalLinearTeam = process.env["LINEAR_TEAM"];
const originalLinearProject = process.env["LINEAR_PROJECT"];
const tempRoots: string[] = [];

async function createAgentsInfraRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "calyx-self-nudge-"));
  tempRoots.push(root);
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

function makeHealth(gitHead: string): Record<string, unknown> {
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

function connection<T>(nodes: readonly T[]): {
  nodes: readonly T[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: null;
  };
} {
  return {
    nodes,
    pageInfo: {
      hasNextPage: false,
      endCursor: null,
    },
  };
}

function extractOperationName(query: string): string {
  const match = /\b(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query);
  if (!match?.[1]) {
    throw new Error(`Unable to extract GraphQL operation name from: ${query}`);
  }
  return match[1];
}

function createFetchStub(args: {
  readonly healthPayload: Record<string, unknown>;
  readonly graphql: Record<string, (variables: Record<string, unknown>) => unknown>;
  readonly seenOperations: string[];
}): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url === "http://127.0.0.1:8740/v1/admin/health") {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer run-token");
      return jsonResponse(args.healthPayload);
    }
    if (url !== "https://api.linear.app/graphql") {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }

    const body = JSON.parse(String(init?.body ?? "{}")) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = body.query ?? "";
    const operationName = extractOperationName(query);
    args.seenOperations.push(operationName);
    const handler = args.graphql[operationName];
    if (!handler) {
      throw new Error(`Unexpected GraphQL operation: ${operationName}`);
    }
    return jsonResponse({ data: handler(body.variables ?? {}) });
  });
}

afterEach(async () => {
  vi.restoreAllMocks();

  if (originalLinearApiKey === undefined) {
    delete process.env["LINEAR_API_KEY"];
  } else {
    process.env["LINEAR_API_KEY"] = originalLinearApiKey;
  }

  if (originalLinearTeam === undefined) {
    delete process.env["LINEAR_TEAM"];
  } else {
    process.env["LINEAR_TEAM"] = originalLinearTeam;
  }

  if (originalLinearProject === undefined) {
    delete process.env["LINEAR_PROJECT"];
  } else {
    process.env["LINEAR_PROJECT"] = originalLinearProject;
  }

  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));

});

describe("calyx self nudge command", () => {
  test("creates a standing Linear issue for a drifted host", async () => {
    const agentsInfraRoot = await createAgentsInfraRoot();
    process.env["LINEAR_API_KEY"] = "linear-token";
    process.env["LINEAR_TEAM"] = "Polli Labs";
    process.env["LINEAR_PROJECT"] = "Agents Tooling (Ongoing)";

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const seenOperations: string[] = [];
    const fetchImpl = createFetchStub({
      healthPayload: makeHealth(MAJOR_HEAD),
      seenOperations,
      graphql: {
        CalyxSelfNudgeTeams: () => ({
          teams: connection([{ id: "team-1", name: "Polli Labs" }]),
        }),
        CalyxSelfNudgeProjects: () => ({
          projects: connection([{ id: "project-1", name: "Agents Tooling (Ongoing)", slugId: "agents-tooling" }]),
        }),
        CalyxSelfNudgeProjectIssues: () => ({
          project: {
            issues: connection([]),
          },
        }),
        CalyxSelfNudgeIssueLabels: () => ({
          issueLabels: connection([]),
        }),
        CalyxSelfNudgeIssueLabelCreate: (variables) => {
          expect(variables).toMatchObject({
            input: {
              name: "drift-fingerprint-blade",
              teamId: "team-1",
            },
          });
          return {
            issueLabelCreate: {
              success: true,
              issueLabel: {
                id: "label-1",
                name: "drift-fingerprint-blade",
              },
            },
          };
        },
        CalyxSelfNudgeIssueCreate: (variables) => {
          expect(variables).toMatchObject({
            input: {
              title: "calyx daemon drift — blade (major)",
              teamId: "team-1",
              projectId: "project-1",
              labelIds: ["label-1"],
            },
          });
          return {
            issueCreate: {
              success: true,
              issue: {
                id: "issue-1",
                identifier: "POL-2000",
                title: "calyx daemon drift — blade (major)",
                description: String((variables.input as { description?: unknown }).description ?? ""),
                url: "https://linear.app/polli-labs/issue/POL-2000",
                updatedAt: "2026-04-20T12:00:00.000Z",
                state: {
                  name: "Backlog",
                  type: "backlog",
                },
                labels: connection([{ id: "label-1", name: "drift-fingerprint-blade" }]),
              },
            },
          };
        },
      },
    });

    const program = buildProgram({
      runCli: {
        currentHostAlias: "blade",
        agentsInfraRoot,
        tokenForHost: () => "run-token",
        repoRoot: TEST_REPO_ROOT,
        execFileAsync: createGitStub({
          "rev-parse origin/main": `${TARGET_HEAD}\n`,
          [`log --format=%H ${MAJOR_HEAD}..${TARGET_HEAD}`]: "f636ca9\n",
        }),
        createAdminClient: createAdminClientFactory(fetchImpl),
        linearGraphql: createLinearGraphqlRequester({ apiKey: "linear-token", fetchImpl }),
        now: () => new Date("2026-04-20T12:00:00.000Z"),
      },
    });

    await program.parseAsync(["node", "calyx", "self", "nudge", "--json"]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      actions: Array<{ action: string; issue_identifier?: string; title?: string; description?: string }>;
    };

    expect(payload.actions).toMatchObject([
      {
        action: "create",
        issue_identifier: "POL-2000",
        title: "calyx daemon drift — blade (major)",
      },
    ]);
    expect(payload.actions[0]?.description).toContain("calyx self upgrade --host blade");
    expect(seenOperations).toEqual([
      "CalyxSelfNudgeTeams",
      "CalyxSelfNudgeProjects",
      "CalyxSelfNudgeProjectIssues",
      "CalyxSelfNudgeIssueLabels",
      "CalyxSelfNudgeIssueLabelCreate",
      "CalyxSelfNudgeIssueCreate",
    ]);
  });

  test("updates the existing standing issue in place", async () => {
    const agentsInfraRoot = await createAgentsInfraRoot();
    process.env["LINEAR_API_KEY"] = "linear-token";
    process.env["LINEAR_TEAM"] = "Polli Labs";
    process.env["LINEAR_PROJECT"] = "Agents Tooling (Ongoing)";

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const seenOperations: string[] = [];
    const fetchImpl = createFetchStub({
      healthPayload: makeHealth(MAJOR_HEAD),
      seenOperations,
      graphql: {
        CalyxSelfNudgeTeams: () => ({
          teams: connection([{ id: "team-1", name: "Polli Labs" }]),
        }),
        CalyxSelfNudgeProjects: () => ({
          projects: connection([{ id: "project-1", name: "Agents Tooling (Ongoing)", slugId: "agents-tooling" }]),
        }),
        CalyxSelfNudgeProjectIssues: () => ({
          project: {
            issues: connection([
              {
                id: "issue-1",
                identifier: "POL-2000",
                title: "calyx daemon drift — blade (minor)",
                description: "old body",
                url: "https://linear.app/polli-labs/issue/POL-2000",
                updatedAt: "2026-04-19T12:00:00.000Z",
                state: {
                  name: "Backlog",
                  type: "backlog",
                },
                labels: connection([{ id: "label-1", name: "drift-fingerprint-blade" }]),
              },
            ]),
          },
        }),
        CalyxSelfNudgeIssueLabels: () => ({
          issueLabels: connection([{ id: "label-1", name: "drift-fingerprint-blade" }]),
        }),
        CalyxSelfNudgeIssueUpdate: (variables) => {
          expect(variables).toMatchObject({
            issueId: "issue-1",
            input: {
              title: "calyx daemon drift — blade (major)",
            },
          });
          return {
            issueUpdate: {
              success: true,
              issue: {
                id: "issue-1",
                identifier: "POL-2000",
                title: "calyx daemon drift — blade (major)",
                description: String(((variables.input as { description?: unknown })?.description) ?? ""),
                url: "https://linear.app/polli-labs/issue/POL-2000",
                updatedAt: "2026-04-20T12:00:00.000Z",
                state: {
                  name: "Backlog",
                  type: "backlog",
                },
                labels: connection([{ id: "label-1", name: "drift-fingerprint-blade" }]),
              },
            },
          };
        },
      },
    });

    const program = buildProgram({
      runCli: {
        currentHostAlias: "blade",
        agentsInfraRoot,
        tokenForHost: () => "run-token",
        repoRoot: TEST_REPO_ROOT,
        execFileAsync: createGitStub({
          "rev-parse origin/main": `${TARGET_HEAD}\n`,
          [`log --format=%H ${MAJOR_HEAD}..${TARGET_HEAD}`]: "f636ca9\n",
        }),
        createAdminClient: createAdminClientFactory(fetchImpl),
        linearGraphql: createLinearGraphqlRequester({ apiKey: "linear-token", fetchImpl }),
        now: () => new Date("2026-04-20T12:00:00.000Z"),
      },
    });

    await program.parseAsync(["node", "calyx", "self", "nudge", "--json"]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      actions: Array<{ action: string; issue_identifier?: string }>;
    };

    expect(payload.actions).toEqual([
      expect.objectContaining({
        action: "update",
        issue_identifier: "POL-2000",
      }),
    ]);
    expect(seenOperations).toEqual([
      "CalyxSelfNudgeTeams",
      "CalyxSelfNudgeProjects",
      "CalyxSelfNudgeProjectIssues",
      "CalyxSelfNudgeIssueLabels",
      "CalyxSelfNudgeIssueUpdate",
    ]);
  });

  test("closes the standing issue when drift resolves", async () => {
    const agentsInfraRoot = await createAgentsInfraRoot();
    process.env["LINEAR_API_KEY"] = "linear-token";
    process.env["LINEAR_TEAM"] = "Polli Labs";
    process.env["LINEAR_PROJECT"] = "Agents Tooling (Ongoing)";

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const seenOperations: string[] = [];
    const fetchImpl = createFetchStub({
      healthPayload: makeHealth(TARGET_HEAD),
      seenOperations,
      graphql: {
        CalyxSelfNudgeTeams: () => ({
          teams: connection([{ id: "team-1", name: "Polli Labs" }]),
        }),
        CalyxSelfNudgeProjects: () => ({
          projects: connection([{ id: "project-1", name: "Agents Tooling (Ongoing)", slugId: "agents-tooling" }]),
        }),
        CalyxSelfNudgeProjectIssues: () => ({
          project: {
            issues: connection([
              {
                id: "issue-1",
                identifier: "POL-2000",
                title: "calyx daemon drift — blade (major)",
                description: "old body",
                url: "https://linear.app/polli-labs/issue/POL-2000",
                updatedAt: "2026-04-19T12:00:00.000Z",
                state: {
                  name: "In Progress",
                  type: "started",
                },
                labels: connection([{ id: "label-1", name: "drift-fingerprint-blade" }]),
              },
            ]),
          },
        }),
        CalyxSelfNudgeIssueLabels: () => ({
          issueLabels: connection([{ id: "label-1", name: "drift-fingerprint-blade" }]),
        }),
        CalyxSelfNudgeTeamStates: () => ({
          team: {
            states: connection([
              { id: "state-backlog", name: "Backlog", type: "backlog" },
              { id: "state-done", name: "Done", type: "completed" },
            ]),
          },
        }),
        CalyxSelfNudgeCommentCreate: (variables) => {
          expect(variables).toMatchObject({
            input: {
              issueId: "issue-1",
              body: "drift resolved 2026-04-20",
            },
          });
          return {
            commentCreate: {
              success: true,
            },
          };
        },
        CalyxSelfNudgeIssueUpdate: (variables) => {
          expect(variables).toMatchObject({
            issueId: "issue-1",
            input: {
              stateId: "state-done",
            },
          });
          return {
            issueUpdate: {
              success: true,
              issue: {
                id: "issue-1",
                identifier: "POL-2000",
                title: "calyx daemon drift — blade (major)",
                description: "old body",
                url: "https://linear.app/polli-labs/issue/POL-2000",
                updatedAt: "2026-04-20T12:00:00.000Z",
                state: {
                  name: "Done",
                  type: "completed",
                },
                labels: connection([{ id: "label-1", name: "drift-fingerprint-blade" }]),
              },
            },
          };
        },
      },
    });

    const program = buildProgram({
      runCli: {
        currentHostAlias: "blade",
        agentsInfraRoot,
        tokenForHost: () => "run-token",
        repoRoot: TEST_REPO_ROOT,
        execFileAsync: createGitStub({
          "rev-parse origin/main": `${TARGET_HEAD}\n`,
        }),
        createAdminClient: createAdminClientFactory(fetchImpl),
        linearGraphql: createLinearGraphqlRequester({ apiKey: "linear-token", fetchImpl }),
        now: () => new Date("2026-04-20T12:00:00.000Z"),
      },
    });

    await program.parseAsync(["node", "calyx", "self", "nudge", "--json"]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      actions: Array<{ action: string; comment?: string; issue_identifier?: string }>;
    };

    expect(payload.actions).toEqual([
      expect.objectContaining({
        action: "close",
        issue_identifier: "POL-2000",
        comment: "drift resolved 2026-04-20",
      }),
    ]);
    expect(seenOperations).toEqual([
      "CalyxSelfNudgeTeams",
      "CalyxSelfNudgeProjects",
      "CalyxSelfNudgeProjectIssues",
      "CalyxSelfNudgeIssueLabels",
      "CalyxSelfNudgeTeamStates",
      "CalyxSelfNudgeCommentCreate",
      "CalyxSelfNudgeIssueUpdate",
    ]);
  });

  test("reports a noop when the host is current and no standing issue is open", async () => {
    const agentsInfraRoot = await createAgentsInfraRoot();
    process.env["LINEAR_API_KEY"] = "linear-token";
    process.env["LINEAR_TEAM"] = "Polli Labs";
    process.env["LINEAR_PROJECT"] = "Agents Tooling (Ongoing)";

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const seenOperations: string[] = [];
    const fetchImpl = createFetchStub({
      healthPayload: makeHealth(TARGET_HEAD),
      seenOperations,
      graphql: {
        CalyxSelfNudgeTeams: () => ({
          teams: connection([{ id: "team-1", name: "Polli Labs" }]),
        }),
        CalyxSelfNudgeProjects: () => ({
          projects: connection([{ id: "project-1", name: "Agents Tooling (Ongoing)", slugId: "agents-tooling" }]),
        }),
        CalyxSelfNudgeProjectIssues: () => ({
          project: {
            issues: connection([]),
          },
        }),
        CalyxSelfNudgeIssueLabels: () => ({
          issueLabels: connection([]),
        }),
      },
    });

    const program = buildProgram({
      runCli: {
        currentHostAlias: "blade",
        agentsInfraRoot,
        tokenForHost: () => "run-token",
        repoRoot: TEST_REPO_ROOT,
        execFileAsync: createGitStub({
          "rev-parse origin/main": `${TARGET_HEAD}\n`,
        }),
        createAdminClient: createAdminClientFactory(fetchImpl),
        linearGraphql: createLinearGraphqlRequester({ apiKey: "linear-token", fetchImpl }),
        now: () => new Date("2026-04-20T12:00:00.000Z"),
      },
    });

    await program.parseAsync(["node", "calyx", "self", "nudge", "--json"]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      actions: Array<{ action: string; reason?: string }>;
    };

    expect(payload.actions).toEqual([
      expect.objectContaining({
        action: "noop",
      }),
    ]);
    expect(payload.actions[0]?.reason).toContain("host is current");
    expect(seenOperations).toEqual([
      "CalyxSelfNudgeTeams",
      "CalyxSelfNudgeProjects",
      "CalyxSelfNudgeProjectIssues",
      "CalyxSelfNudgeIssueLabels",
    ]);
  });

  test("--dry-run prints intended mutations without writing to Linear", async () => {
    const agentsInfraRoot = await createAgentsInfraRoot();
    process.env["LINEAR_API_KEY"] = "linear-token";
    process.env["LINEAR_TEAM"] = "Polli Labs";
    process.env["LINEAR_PROJECT"] = "Agents Tooling (Ongoing)";

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const seenOperations: string[] = [];
    const fetchImpl = createFetchStub({
      healthPayload: makeHealth(MAJOR_HEAD),
      seenOperations,
      graphql: {
        CalyxSelfNudgeTeams: () => ({
          teams: connection([{ id: "team-1", name: "Polli Labs" }]),
        }),
        CalyxSelfNudgeProjects: () => ({
          projects: connection([{ id: "project-1", name: "Agents Tooling (Ongoing)", slugId: "agents-tooling" }]),
        }),
        CalyxSelfNudgeProjectIssues: () => ({
          project: {
            issues: connection([]),
          },
        }),
        CalyxSelfNudgeIssueLabels: () => ({
          issueLabels: connection([]),
        }),
      },
    });

    const program = buildProgram({
      runCli: {
        currentHostAlias: "blade",
        agentsInfraRoot,
        tokenForHost: () => "run-token",
        repoRoot: TEST_REPO_ROOT,
        execFileAsync: createGitStub({
          "rev-parse origin/main": `${TARGET_HEAD}\n`,
          [`log --format=%H ${MAJOR_HEAD}..${TARGET_HEAD}`]: "f636ca9\n",
        }),
        createAdminClient: createAdminClientFactory(fetchImpl),
        linearGraphql: createLinearGraphqlRequester({ apiKey: "linear-token", fetchImpl }),
        now: () => new Date("2026-04-20T12:00:00.000Z"),
      },
    });

    await program.parseAsync(["node", "calyx", "self", "nudge", "--dry-run"]);

    const rendered = String(out.mock.calls[0]?.[0]);
    expect(rendered).toContain("[dry-run] create host=blade drift=major");
    expect(rendered).toContain("calyx daemon drift — blade (major)");
    expect(seenOperations).toEqual([
      "CalyxSelfNudgeTeams",
      "CalyxSelfNudgeProjects",
      "CalyxSelfNudgeProjectIssues",
      "CalyxSelfNudgeIssueLabels",
    ]);
  });

  test("does not file daemon drift issues for local compare repair states", async () => {
    const agentsInfraRoot = await createAgentsInfraRoot();
    process.env["LINEAR_API_KEY"] = "linear-token";
    process.env["LINEAR_TEAM"] = "Polli Labs";
    process.env["LINEAR_PROJECT"] = "Agents Tooling (Ongoing)";

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const seenOperations: string[] = [];
    const fetchImpl = createFetchStub({
      healthPayload: makeHealth(MISSING_HEAD),
      seenOperations,
      graphql: {
        CalyxSelfNudgeTeams: () => ({
          teams: connection([{ id: "team-1", name: "Polli Labs" }]),
        }),
        CalyxSelfNudgeProjects: () => ({
          projects: connection([{ id: "project-1", name: "Agents Tooling (Ongoing)", slugId: "agents-tooling" }]),
        }),
        CalyxSelfNudgeProjectIssues: () => ({
          project: {
            issues: connection([]),
          },
        }),
        CalyxSelfNudgeIssueLabels: () => ({
          issueLabels: connection([]),
        }),
      },
    });

    const program = buildProgram({
      runCli: {
        currentHostAlias: "blade",
        agentsInfraRoot,
        tokenForHost: () => "run-token",
        repoRoot: "/repo",
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
        createAdminClient: createAdminClientFactory(fetchImpl),
        linearGraphql: createLinearGraphqlRequester({ apiKey: "linear-token", fetchImpl }),
        now: () => new Date("2026-04-20T12:00:00.000Z"),
      },
    });

    await program.parseAsync(["node", "calyx", "self", "nudge", "--dry-run", "--json"]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      drift_reports: Array<{ drift: string; diagnostics?: Array<{ kind: string; actions: string[] }> }>;
      actions: Array<{ action: string; reason: string; title?: string }>;
    };
    expect(payload.drift_reports[0]).toMatchObject({
      drift: "needs_fetch",
      diagnostics: [{
        kind: "needs_fetch",
        actions: ["git -C /repo fetch --all --prune"],
      }],
    });
    expect(payload.actions).toEqual([
      expect.objectContaining({
        action: "noop",
        reason: "local compare repo needs repair: git -C /repo fetch --all --prune",
      }),
    ]);
    expect(payload.actions[0]?.title).toBeUndefined();
    expect(seenOperations).toEqual([
      "CalyxSelfNudgeTeams",
      "CalyxSelfNudgeProjects",
      "CalyxSelfNudgeProjectIssues",
      "CalyxSelfNudgeIssueLabels",
    ]);
  });
});
