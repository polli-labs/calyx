import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCalyxAdminClient } from "@polli-labs/calyx-client/admin";

import { buildProgram, type RunCliDependencies } from "../run-cli";

function createAdminClientFactory(fetchImpl: typeof fetch): typeof createCalyxAdminClient {
  return (options) => createCalyxAdminClient({
    ...options,
    fetch: fetchImpl,
  });
}

async function requestBodyText(body: RequestInit["body"]): Promise<string> {
  return new Response(body ?? null).text();
}

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;

interface CapturedIO {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  thrown?: unknown;
}

function makeRemoteLease() {
  return {
    key: "worktree:remote:/tmp/calyx-lease-retry",
    resource_kind: "worktree",
    owner_host: "remote",
    resource_host: "remote",
    resource_path: "/tmp/calyx-lease-retry",
    holder_activity_id: "run:retry-holder",
    acquired_at: "2026-07-15T00:00:00.000Z",
    ttl_ms: 60_000,
    renewed_at: null,
    expires_at: "2026-07-15T00:01:00.000Z",
    stolen_from_holder_activity_id: null,
    stolen_at: null,
    steal_provenance: {},
    metadata: {},
  };
}

async function runCalyx(
  argv: string[],
  deps: Omit<RunCliDependencies, "currentHostAlias"> = {},
): Promise<CapturedIO> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts) => {
    stdout.push(parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...parts) => {
    stderr.push(parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "));
  });

  let thrown: unknown;
  let exitCode: number | null = null;
  try {
    const program = buildProgram({ runCli: { currentHostAlias: "blade", ...deps } });
    program.exitOverride();
    await program.parseAsync(["node", "calyx", ...argv]);
  } catch (error) {
    thrown = error;
    if (error && typeof error === "object" && "exitCode" in error) {
      const code = (error as { exitCode?: unknown }).exitCode;
      if (typeof code === "number") exitCode = code;
    }
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }

  return { stdout, stderr, exitCode, thrown };
}

describe("lease command", () => {
  let root: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of ENV_KEYS) delete process.env[key];
    root = await mkdtemp(join(tmpdir(), "calyx-lease-command-"));
    process.env["CALYX_STATE_HOME"] = join(root, "state");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  test("acquire reports conflicts with holder evidence", async () => {
    const key = "worktree:blade:/tmp/calyx-lease-command";
    const first = await runCalyx([
      "lease",
      "acquire",
      key,
      "--holder",
      "run:first",
      "--ttl-ms",
      "60000",
      "--json",
    ]);
    expect(first.thrown).toBeUndefined();
    const acquired = JSON.parse(first.stdout.join("\n")) as {
      schema_version: string;
      lease: { key: string; holder_activity_id: string; owner_host: string };
    };
    expect(acquired.schema_version).toBe("calyx.lease-acquire/v1");
    expect(acquired.lease).toMatchObject({
      key,
      holder_activity_id: "run:first",
      owner_host: "blade",
    });

    const second = await runCalyx([
      "lease",
      "acquire",
      key,
      "--holder",
      "run:second",
      "--ttl-ms",
      "60000",
    ]);
    expect(second.exitCode).toBe(6);
    expect(second.thrown).toBeDefined();
    expect(String((second.thrown as Error).message)).toContain("run:first");
    expect(String((second.thrown as Error).message)).toContain(key);
  });

  test("steal records provenance and degrades notification to receipt-only when msg is absent", async () => {
    const key = "worktree:blade:/tmp/calyx-lease-steal";
    await runCalyx([
      "lease",
      "acquire",
      key,
      "--holder",
      "run:first",
      "--ttl-ms",
      "60000",
      "--json",
    ]);

    const stolen = await runCalyx([
      "lease",
      "steal",
      key,
      "--holder",
      "run:second",
      "--ttl-ms",
      "60000",
      "--provenance",
      "first holder abandoned the worktree",
      "--json",
    ]);
    expect(stolen.thrown).toBeUndefined();
    const payload = JSON.parse(stolen.stdout.join("\n")) as {
      schema_version: string;
      lease: {
        holder_activity_id: string;
        stolen_from_holder_activity_id: string;
        steal_provenance: Record<string, unknown>;
      };
      notification: { status: string; previous_holder_activity_id?: string };
    };
    expect(payload.schema_version).toBe("calyx.lease-steal/v1");
    expect(payload.lease).toMatchObject({
      holder_activity_id: "run:second",
      stolen_from_holder_activity_id: "run:first",
    });
    expect(payload.lease.steal_provenance).toMatchObject({
      text: "first holder abandoned the worktree",
      stolen_by: "run:second",
    });
    expect(payload.notification).toMatchObject({
      status: "receipt_only",
      previous_holder_activity_id: "run:first",
    });
  });

  test("list and doctor expose local lease state", async () => {
    const key = "issue:POL-1790";
    await runCalyx([
      "lease",
      "acquire",
      key,
      "--holder",
      "codex:blade:session-1",
      "--coordinator-host",
      "blade",
      "--json",
    ]);

    const listed = await runCalyx(["lease", "list", "--kind", "issue", "--json"]);
    expect(listed.thrown).toBeUndefined();
    const listPayload = JSON.parse(listed.stdout.join("\n")) as {
      schema_version: string;
      count: number;
      leases: Array<{ key: string; resource_kind: string }>;
    };
    expect(listPayload.schema_version).toBe("calyx.lease-list/v1");
    expect(listPayload.count).toBe(1);
    expect(listPayload.leases[0]).toMatchObject({ key, resource_kind: "issue" });

    const doctor = await runCalyx(["lease", "doctor", "--json"]);
    expect(doctor.thrown).toBeUndefined();
    const doctorPayload = JSON.parse(doctor.stdout.join("\n")) as {
      schema_version: string;
      ok: boolean;
      leases: { rowCount: number; schemaParity: string };
    };
    expect(doctorPayload).toMatchObject({
      schema_version: "calyx.lease-doctor/v1",
      ok: true,
      leases: { rowCount: 1, schemaParity: "ok" },
    });
  });

  test("remote acquire replays the same generated key after response loss", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(await requestBodyText(init?.body));
      if (bodies.length === 1) throw new Error("response lost after commit");
      return new Response(JSON.stringify({
        acquired: true,
        lease: makeRemoteLease(),
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
        },
      });
    });

    const result = await runCalyx([
      "lease", "acquire", "worktree:remote:/tmp/calyx-lease-retry",
      "--holder", "run:retry-holder",
      "--server-url", "http://remote.example:8740",
      "--auth-token", "remote-secret",
      "--json",
    ], { createAdminClient: createAdminClientFactory(fetchImpl) });

    expect(result.thrown).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      idempotency_key: expect.stringMatching(/^lease-acquire:/),
    });
  });

  test.each([
    {
      name: "valid JSON with the wrong schema",
      body: JSON.stringify({ acquired: true, lease: {} }),
      contentType: "application/json",
    },
    {
      name: "a valid committed result with the wrong media type",
      body: JSON.stringify({ acquired: true, lease: makeRemoteLease() }),
      contentType: "text/plain",
    },
  ])("remote acquire keeps recovery indeterminate after $name", async ({ body, contentType }) => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(await requestBodyText(init?.body));
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": contentType,
          "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
        },
      });
    });

    const result = await runCalyx([
      "lease", "acquire", "worktree:remote:/tmp/calyx-lease-retry",
      "--holder", "run:retry-holder",
      "--server-url", "http://remote.example:8740",
      "--auth-token", "remote-secret",
      "--json",
    ], { createAdminClient: createAdminClientFactory(fetchImpl) });

    expect(result.exitCode).toBe(6);
    expect(String((result.thrown as Error).message)).toContain("is indeterminate");
    expect(String((result.thrown as Error).message)).toContain("calyx.client-indeterminate-result/v1");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(new Set(bodies)).toHaveLength(1);
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      idempotency_key: expect.stringMatching(/^lease-acquire:/),
    });
  });
});
