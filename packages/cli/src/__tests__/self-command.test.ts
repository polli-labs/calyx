import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCalyxAdminClient } from "@polli-labs/calyx-client/admin";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildProgram } from "../run-cli";

const tempRoots: string[] = [];
const originalHome = process.env["HOME"];
const originalAgentsInfraRoot = process.env["CALYX_AGENTS_INFRA_ROOT"];
const originalOperatorToken = process.env["CALYX_CONSUMER_API_TEST_WORM_OPERATOR_TOKEN"];

interface AgentsInfraFixtureOptions {
  hosts: Record<string, Record<string, unknown>>;
}

function operatorCredential(host: string): Record<string, unknown> {
  return {
    client_id: "operator_cli",
    credential_tier: "control_plane",
    verifier_env: `CALYX_CONSUMER_API_TEST_${host.toUpperCase()}_OPERATOR_VERIFIER`,
    token_env: "CALYX_CONSUMER_API_TEST_WORM_OPERATOR_TOKEN",
    outbound: true,
    address_grants: {
      send_as: [`client:operator_cli@${host}`],
      read: ["host:*"],
    },
  };
}

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function createAgentsInfraFixture(options: AgentsInfraFixtureOptions): Promise<{
  root: string;
  bladeHome: string;
}> {
  const root = await makeTempRoot("calyx-self-health-");
  const bladeHome = path.join(root, "home", "caleb");
  const skillsRegistryPath = path.join(root, "instructions", "skills", "SOURCES.json");
  const templateRegistryPath = path.join(root, "instructions", "templates", "REGISTRY.json");
  const hostsPath = path.join(root, "fleet", "truths", "hosts.yaml");

  await mkdir(path.dirname(skillsRegistryPath), { recursive: true });
  await mkdir(path.dirname(templateRegistryPath), { recursive: true });
  await mkdir(path.dirname(hostsPath), { recursive: true });
  await mkdir(bladeHome, { recursive: true });

  await writeFile(skillsRegistryPath, `${JSON.stringify({ version: "test", skills: [] }, null, 2)}\n`, "utf8");
  await writeFile(
    templateRegistryPath,
    `${JSON.stringify({
      globals: {
        hot: "instructions/templates/global/AGENTS.global.hot.md.mustache",
        variants: [],
        legacy: [],
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(hostsPath, `${JSON.stringify({ hosts: options.hosts }, null, 2)}\n`, "utf8");

  return { root, bladeHome };
}

function makeHealthPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schema_version: "calyx.admin-health/v1",
    protocol_epoch: 1,
    daemon_kind: "run-service",
    daemon_id: "run-serve",
    pid: 1234,
    uptime_ms: 3_723_000,
    started_at: "2026-04-20T09:58:00.000Z",
    build: {
      git_head: "ed6e1fa1e6745e2c7b410cf59e033657b0978f15",
      built_at: "2026-04-20T10:00:00.000Z",
      package_version: "0.2.0",
    },
    promoted_build: {
      status: "ok",
      install_path: "/tmp/calyx-installs/current",
      current_link: "/tmp/calyx-installs/current",
      build_info_path: "/tmp/calyx-installs/current/.build-info.json",
      build: {
        git_head: "ed6e1fa1e6745e2c7b410cf59e033657b0978f15",
        built_at: "2026-04-20T10:00:00.000Z",
        package_version: "0.2.0",
      },
    },
    clone_head: {
      status: "ok",
      repo_root: "/repo",
      git_head: "ed6e1fa1e6745e2c7b410cf59e033657b0978f15",
    },
    state_schema: {
      status: "current",
      driver: "node-sqlite",
      current: "0034",
      target: "0034",
      pending: 0,
    },
    env: {
      inherited_path: "/srv/bin:/usr/bin",
    },
    active_runs: 2,
    maintenance_mode: false,
    supports_features: ["run.default_path_injection/v1", "run.detached_worker_diagnostics/v1"],
    ...overrides,
  };
}

function createAdminClientFactory(fetchImpl: typeof fetch): typeof createCalyxAdminClient {
  return (options) => createCalyxAdminClient({
    ...options,
    fetch: fetchImpl,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = originalHome;
  }
  if (originalAgentsInfraRoot === undefined) {
    delete process.env["CALYX_AGENTS_INFRA_ROOT"];
  } else {
    process.env["CALYX_AGENTS_INFRA_ROOT"] = originalAgentsInfraRoot;
  }
  if (originalOperatorToken === undefined) {
    delete process.env["CALYX_CONSUMER_API_TEST_WORM_OPERATOR_TOKEN"];
  } else {
    process.env["CALYX_CONSUMER_API_TEST_WORM_OPERATOR_TOKEN"] = originalOperatorToken;
  }
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("self command", () => {
  test("self health defaults to the local host and prints a compact table", async () => {
    const fixture = await createAgentsInfraFixture({
      hosts: {
        blade: {
          home: "/placeholder",
        },
      },
    });
    process.env["HOME"] = fixture.bladeHome;
    process.env["CALYX_AGENTS_INFRA_ROOT"] = fixture.root;

    await writeFile(
      path.join(fixture.root, "fleet", "truths", "hosts.yaml"),
      `${JSON.stringify({
        hosts: {
          blade: {
            home: fixture.bladeHome,
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:8740/v1/admin/health");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer env-token");
      return new Response(JSON.stringify(makeHealthPayload()), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
        },
      });
    });
    const program = buildProgram({
      runCli: {
        createAdminClient: createAdminClientFactory(fetchImpl),
        now: () => new Date("2026-04-20T12:00:00.000Z"),
        tokenForHost: () => "env-token",
      },
    });

    await program.parseAsync(["node", "calyx", "self", "health"]);

    const rendered = String(out.mock.calls[0]?.[0]);
    expect(rendered).toContain("host | daemon_kind | uptime | running_build | promoted_build | clone_head | state_schema | built_at | active_runs | features | maintenance");
    expect(rendered).toContain("blade | run-service | 1h2m | ed6e1fa | ed6e1fa | ed6e1fa | 0034 | 2h ago | 2 | 2 | no");
  });

  test("self health --host queries a named host using truth-store token fallback", async () => {
    const fixture = await createAgentsInfraFixture({
      hosts: {
        blade: {
          home: "/home/caleb",
        },
        worm: {
          home: "/home/caleb",
          run_serve_url: "http://worm.internal:8740",
          consumer_api_credentials: [operatorCredential("worm")],
        },
      },
    });
    process.env["HOME"] = fixture.bladeHome;
    process.env["CALYX_AGENTS_INFRA_ROOT"] = fixture.root;
    process.env["CALYX_CONSUMER_API_TEST_WORM_OPERATOR_TOKEN"] = "truth-token";

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe("http://worm.internal:8740/v1/admin/health");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer truth-token");
      return new Response(JSON.stringify(makeHealthPayload({ active_runs: 0 })), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
        },
      });
    });
    const program = buildProgram({ runCli: { createAdminClient: createAdminClientFactory(fetchImpl) } });

    await program.parseAsync(["node", "calyx", "self", "health", "--host", "worm", "--json"]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as Array<{ host: string; ok: boolean }>;
    expect(payload).toEqual([
      {
        host: "worm",
        ok: true,
        health: expect.objectContaining({
          daemon_kind: "run-service",
          active_runs: 0,
        }),
      },
    ]);
  });

  test("self health reports auth failures distinctly", async () => {
    const fixture = await createAgentsInfraFixture({
      hosts: {
        worm: {
          home: "/home/caleb",
          run_serve_url: "http://worm:8740",
          consumer_api_credentials: [operatorCredential("worm")],
        },
      },
    });
    process.env["CALYX_AGENTS_INFRA_ROOT"] = fixture.root;
    process.env["CALYX_CONSUMER_API_TEST_WORM_OPERATOR_TOKEN"] = "truth-token";

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("Unauthorized", {
      status: 401,
      headers: {
        "www-authenticate": 'Bearer realm="calyx-run"',
        "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
      },
    }));
    const program = buildProgram({ runCli: { createAdminClient: createAdminClientFactory(fetchImpl) } });

    await expect(
      program.parseAsync(["node", "calyx", "self", "health", "--host", "worm", "--json"]),
    ).rejects.toMatchObject({ exitCode: 8 });

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as Array<{
      host: string;
      ok: boolean;
      error?: { kind: string };
    }>;
    expect(payload).toEqual([
      {
        host: "worm",
        ok: false,
        error: {
          kind: "auth_failure",
          message: "Unauthorized",
        },
      },
    ]);
  });

  test("self health reports surface-only payloads as legacy daemons", async () => {
    const fixture = await createAgentsInfraFixture({
      hosts: {
        worm: {
          home: "/home/caleb",
          run_serve_url: "http://worm:8740",
          consumer_api_credentials: [operatorCredential("worm")],
        },
      },
    });
    process.env["CALYX_AGENTS_INFRA_ROOT"] = fixture.root;
    process.env["CALYX_CONSUMER_API_TEST_WORM_OPERATOR_TOKEN"] = "truth-token";

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, surface: "run" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
        },
      }));
    const program = buildProgram({ runCli: { createAdminClient: createAdminClientFactory(fetchImpl) } });

    await expect(
      program.parseAsync(["node", "calyx", "self", "health", "--host", "worm", "--json"]),
    ).rejects.toMatchObject({ exitCode: 6 });

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as Array<{
      host: string;
      ok: boolean;
      error?: { kind: string; message: string };
    }>;
    expect(payload).toEqual([
      {
        host: "worm",
        ok: false,
        error: {
          kind: "legacy_daemon",
          message: "pre-PR1 daemon; upgrade required",
        },
      },
    ]);
  });

  test.each([
    {
      name: "HTTP 400",
      response: () => new Response(JSON.stringify({
        error: {
          schema_version: "calyx.error/v1",
          code: "invalid_request",
          message: "bad health request",
          retryable: false,
        },
      }), {
        status: 400,
        headers: {
          "content-type": "application/json",
          "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
        },
      }),
      expectedError: {
        kind: "http_error",
        http_status: 400,
        error_code: "invalid_request",
        response_retryable: false,
      },
    },
    {
      name: "HTTP 500",
      response: () => new Response(JSON.stringify({
        error: {
          schema_version: "calyx.error/v1",
          code: "internal_error",
          message: "health projection failed",
          retryable: false,
        },
      }), {
        status: 500,
        headers: {
          "content-type": "application/json",
          "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
        },
      }),
      expectedError: {
        kind: "http_error",
        http_status: 500,
        error_code: "internal_error",
        response_retryable: false,
      },
    },
    {
      name: "malformed current-schema response",
      response: () => new Response(JSON.stringify({
        schema_version: "calyx.admin-health/v1",
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
        },
      }),
      expectedError: {
        kind: "invalid_response",
        http_status: 200,
        response_phase: "invalid_response",
      },
    },
  ])("self health preserves $name as a non-transport error", async ({ response, expectedError }) => {
    const fixture = await createAgentsInfraFixture({
      hosts: {
        worm: {
          home: "/home/caleb",
          run_serve_url: "http://worm:8740",
          consumer_api_credentials: [operatorCredential("worm")],
        },
      },
    });
    process.env["CALYX_AGENTS_INFRA_ROOT"] = fixture.root;
    process.env["CALYX_CONSUMER_API_TEST_WORM_OPERATOR_TOKEN"] = "truth-token";

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({
      runCli: {
        createAdminClient: createAdminClientFactory(vi.fn(async () => response())),
      },
    });

    await expect(
      program.parseAsync(["node", "calyx", "self", "health", "--host", "worm", "--json"]),
    ).rejects.toMatchObject({ exitCode: 6 });

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as Array<{
      host: string;
      ok: boolean;
      error?: Record<string, unknown>;
    }>;
    expect(payload).toEqual([{
      host: "worm",
      ok: false,
      error: expect.objectContaining(expectedError),
    }]);
    expect(payload[0]?.error?.["kind"]).not.toBe("unreachable");
  });

  test("self health --fleet skips hosts without configured URLs and aggregates partial failures", async () => {
    const fixture = await createAgentsInfraFixture({
      hosts: {
        blade: {
          home: "/home/caleb",
          run_serve_url: "http://blade:8740",
        },
        worm: {
          home: "/home/caleb",
          run_serve_url: "http://worm:8740",
        },
        carbon: {
          home: "/Users/carbon",
        },
      },
    });
    process.env["CALYX_AGENTS_INFRA_ROOT"] = fixture.root;

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === "http://blade:8740/v1/admin/health") {
        return new Response(JSON.stringify(makeHealthPayload({ active_runs: 1 })), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
          },
        });
      }
      if (url === "http://worm:8740/v1/admin/health") {
        const error = new Error("fetch failed") as Error & { cause?: Error };
        error.cause = new Error("connect ECONNREFUSED 127.0.0.1:8740");
        throw error;
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const program = buildProgram({
      runCli: {
        createAdminClient: createAdminClientFactory(fetchImpl),
        tokenForHost: () => "env-token",
      },
    });

    await expect(
      program.parseAsync(["node", "calyx", "self", "health", "--fleet", "--json"]),
    ).rejects.toMatchObject({ exitCode: 6 });

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as Array<{
      host: string;
      ok: boolean;
      error?: { kind: string; message: string };
    }>;
    expect(payload).toHaveLength(2);
    expect(payload[0]).toMatchObject({ host: "blade", ok: true });
    expect(payload[1]).toMatchObject({
      host: "worm",
      ok: false,
      error: {
        kind: "unreachable",
        message: "Network request failed before response headers.",
      },
    });
    expect(payload.some((entry) => entry.host === "carbon")).toBe(false);
  });

  test("self health --fleet returns an empty array when no hosts have configured URLs", async () => {
    const fixture = await createAgentsInfraFixture({
      hosts: {
        blade: { home: "/home/caleb" },
        worm: { home: "/home/caleb" },
      },
    });
    process.env["CALYX_AGENTS_INFRA_ROOT"] = fixture.root;

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({
      runCli: { createAdminClient: createAdminClientFactory(vi.fn()) },
    });

    await program.parseAsync(["node", "calyx", "self", "health", "--fleet", "--json"]);

    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toEqual([]);
  });
});
