import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CALYX_SERVER_STARTUP_CONTRACT } from "@polli-labs/calyx-core";
import { buildProgram } from "../run-cli";
import type { SelfUpgradeFleetResult } from "../commands/self-upgrade-fleet";

const tempRoots: string[] = [];
const originalHome = process.env["HOME"];
const TARGET_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BEFORE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "calyx-self-upgrade-cli-"));
  tempRoots.push(root);
  return root;
}

async function createAgentsInfraFixture(): Promise<string> {
  const root = await makeTempRoot();
  const hostsPath = path.join(root, "fleet", "truths", "hosts.yaml");
  await mkdir(path.dirname(hostsPath), { recursive: true });
  await writeFile(
    hostsPath,
    `${JSON.stringify({
      hosts: {
        blade: {
          run_serve_url: "http://blade:8740",
          // The preamble's `$1`. It is fleet truth, not a guess from the
          // conductor's own home directory.
          repos: { calyx: { path: "/srv/blade/calyx" } },
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  return root;
}

function extractSshHost(args: readonly unknown[]): string {
  for (let i = 0; i < args.length; i += 1) {
    const value = String(args[i]);
    if (value === "-o") {
      i += 1;
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
 * The plan the conductor piped to the host's stdin.
 *
 * Options the operator typed now travel here, not in the remote command: the
 * preamble's bytes are frozen precisely so the remote never has to recognise a
 * flag the conductor invented.
 */
function extractDispatchedPlan(call: readonly unknown[]): {
  request: Record<string, unknown>;
  target: Record<string, unknown>;
  clone_root: string;
} {
  const stdin = (call[2] as { stdin?: string } | undefined)?.stdin;
  if (typeof stdin !== "string") {
    throw new Error("ssh dispatch sent no plan on stdin");
  }
  return JSON.parse(stdin) as { request: Record<string, unknown>; target: Record<string, unknown>; clone_root: string };
}

function dryRunJson(host: string): string {
  return `${JSON.stringify({
    status: "dry-run",
    plan: {
      host,
      repo_root: `/srv/${host}/calyx`,
      current_head: BEFORE_SHA,
      target_ref: "origin/main",
      target_head: TARGET_SHA,
      target_evidence: {
        original_ref: "origin/main",
        target_sha: TARGET_SHA,
        fetch_remote: "origin",
        fetch_ref: "main",
      },
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
  })}\n`;
}

function createExecFileAsync() {
  return vi.fn(async (file: string, args: readonly unknown[]) => {
    if (file === "git") {
      if (args[0] === "remote") return { stdout: "origin\n", stderr: "" };
      if (args[0] === "fetch") return { stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { stdout: `${TARGET_SHA}\n`, stderr: "" };
      if (args[0] === "show") {
        return { stdout: JSON.stringify(CALYX_SERVER_STARTUP_CONTRACT), stderr: "" };
      }
      throw new Error(`Unexpected git invocation: ${args.join(" ")}`);
    }
    return {
      stdout: dryRunJson(extractSshHost(args)),
      stderr: "",
    };
  });
}

function sshCalls(mock: ReturnType<typeof createExecFileAsync>) {
  return mock.mock.calls.filter((call) => call[0] === "ssh");
}

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (originalHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = originalHome;
  }
  delete process.env["CALYX_SELF_UPGRADE_TARGET_OPERATION_ID"];
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("self upgrade CLI", () => {
  test("self upgrade --host <remote> dispatches one remote host via the fleet runner", async () => {
    const homeRoot = await makeTempRoot();
    process.env["HOME"] = homeRoot;
    const agentsInfraRoot = await createAgentsInfraFixture();
    const execFileAsync = createExecFileAsync();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({
      runCli: {
        agentsInfraRoot,
        currentHostAlias: "carbon",
        execFileAsync,
      },
    });

    await program.parseAsync(["node", "calyx", "self", "upgrade", "--host", "blade", "--dry-run", "--json"]);

    expect(sshCalls(execFileAsync)).toHaveLength(1);
    expect(extractSshHost(sshCalls(execFileAsync)[0]![1] as readonly unknown[])).toBe("blade");
    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      receipt: { per_host: Array<{ host: string; status: string }> };
      exit_code: number;
    };
    expect(payload.exit_code).toBe(0);
    expect(payload.receipt.per_host).toHaveLength(1);
    expect(payload.receipt.per_host[0]).toMatchObject({ host: "blade", status: "dry-run" });
  });

  test("self upgrade --host <remote> forwards force and abort-run flags through the top-level CLI", async () => {
    const homeRoot = await makeTempRoot();
    process.env["HOME"] = homeRoot;
    const agentsInfraRoot = await createAgentsInfraFixture();
    const execFileAsync = createExecFileAsync();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({
      runCli: {
        agentsInfraRoot,
        currentHostAlias: "carbon",
        execFileAsync,
      },
    });

    await program.parseAsync([
      "node",
      "calyx",
      "self",
      "upgrade",
      "--host",
      "blade",
      "--dry-run",
      "--force",
      "--abort-runs",
      "--json",
    ]);

    expect(sshCalls(execFileAsync)).toHaveLength(1);
    expect(extractDispatchedPlan(sshCalls(execFileAsync)[0]!).request)
      .toMatchObject({ force: true, abort_runs: true });
  });

  test("self upgrade --host <remote> forwards --drain-all through the top-level CLI", async () => {
    const homeRoot = await makeTempRoot();
    process.env["HOME"] = homeRoot;
    const agentsInfraRoot = await createAgentsInfraFixture();
    const execFileAsync = createExecFileAsync();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({
      runCli: {
        agentsInfraRoot,
        currentHostAlias: "carbon",
        execFileAsync,
      },
    });

    await program.parseAsync([
      "node",
      "calyx",
      "self",
      "upgrade",
      "--host",
      "blade",
      "--dry-run",
      "--drain-all",
      "--json",
    ]);

    expect(sshCalls(execFileAsync)).toHaveLength(1);
    expect(extractDispatchedPlan(sshCalls(execFileAsync)[0]!).request).toMatchObject({ drain_all: true });
  });

  test("self upgrade --continuous warns once and behaves like the default", async () => {
    const homeRoot = await makeTempRoot();
    process.env["HOME"] = homeRoot;
    const agentsInfraRoot = await createAgentsInfraFixture();
    const execFileAsync = createExecFileAsync();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({
      runCli: {
        agentsInfraRoot,
        currentHostAlias: "carbon",
        execFileAsync,
      },
    });

    await program.parseAsync([
      "node",
      "calyx",
      "self",
      "upgrade",
      "--host",
      "blade",
      "--dry-run",
      "--continuous",
      "--json",
    ]);

    expect(warnings).toHaveBeenCalledOnce();
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("deprecated and has no effect"));
    expect(extractDispatchedPlan(sshCalls(execFileAsync)[0]!).request).toMatchObject({ drain_all: false });
  });

  test("self upgrade --fleet preserves explicit zero drain deadline through the top-level CLI", async () => {
    const homeRoot = await makeTempRoot();
    process.env["HOME"] = homeRoot;
    const agentsInfraRoot = await createAgentsInfraFixture();
    const execFileAsync = createExecFileAsync();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({
      runCli: {
        agentsInfraRoot,
        currentHostAlias: "carbon",
        execFileAsync,
      },
    });

    await program.parseAsync([
      "node",
      "calyx",
      "self",
      "upgrade",
      "--fleet",
      "--dry-run",
      "--drain-deadline",
      "0",
      "--json",
    ]);

    expect(sshCalls(execFileAsync)).toHaveLength(1);
    // An explicit zero must survive as a zero, not be swallowed by a truthy
    // check and silently replaced with the ten-minute default.
    expect(extractDispatchedPlan(sshCalls(execFileAsync)[0]!).request.drain_deadline_ms).toBe(0);
  });

  test.each([
    ["fleet", ["--fleet"]],
    ["remote-host", ["--host", "blade"]],
  ] as const)("emits typed operation projection state for %s JSON", async (_mode, selector) => {
    for (const operationProjection of ["available", "degraded", "unavailable"] as const) {
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const result = {
        operation_id: "fleet-current-test",
        operation_path: "/tmp/self-upgrade-operations/fleet-current-test.json",
        operation_projection: operationProjection,
        operation: {} as SelfUpgradeFleetResult["operation"],
        receipt_path: "/tmp/self-upgrade-receipts/fleet-current-test/summary.json",
        receipt: {} as SelfUpgradeFleetResult["receipt"],
        text: `operation_projection: ${operationProjection}`,
        exitCode: 0,
      } satisfies SelfUpgradeFleetResult;
      const runSelfUpgradeFleet = vi.fn(async () => result);
      const program = buildProgram({
        runCli: {
          currentHostAlias: "carbon",
          runSelfUpgradeFleet,
        },
      });

      await program.parseAsync([
        "node",
        "calyx",
        "self",
        "upgrade",
        ...selector,
        "--json",
      ]);

      expect(runSelfUpgradeFleet).toHaveBeenCalledTimes(1);
      expect(out).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({
        operation_id: "fleet-current-test",
        operation_path: "/tmp/self-upgrade-operations/fleet-current-test.json",
        operation_projection: operationProjection,
      });
      out.mockRestore();
    }
  });

  test("self upgrade --host <remote> rejects inline auth tokens instead of forwarding secrets over ssh", async () => {
    const execFileAsync = vi.fn();
    const program = buildProgram({
      runCli: {
        currentHostAlias: "carbon",
        execFileAsync,
      },
    });

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "self",
        "upgrade",
        "--host",
        "blade",
        "--auth-token",
        "secret-token",
      ]),
    ).rejects.toThrow("--auth-token is only supported when --host targets the current host");
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  test("keeps progress relay negotiation out of the public command surface", () => {
    const program = buildProgram();
    const self = program.commands.find((command) => command.name() === "self");
    const upgrade = self?.commands.find((command) => command.name() === "upgrade");
    const publicFlags = upgrade?.options.flatMap((option) => [option.short, option.long]).filter(Boolean) ?? [];

    expect(publicFlags).not.toContain("--progress-stream");
    expect(publicFlags).not.toContain("--fleet-operation-id");
    expect(publicFlags).not.toContain("--target-operation-id");
    expect(upgrade?.helpInformation()).not.toContain("progress-stream");
    expect(upgrade?.helpInformation()).not.toContain("fleet-operation-id");
    expect(upgrade?.helpInformation()).not.toContain("target-operation-id");
  });

  test("consumes the private prepared-target entry exactly once without entering fleet or stale planning", async () => {
    const operationId = "self-upgrade-target-entry-test";
    process.env["CALYX_SELF_UPGRADE_TARGET_OPERATION_ID"] = operationId;
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const runSelfUpgradeTargetEntry = vi.fn(async () => ({
      status: "succeeded" as const,
      operation_id: operationId,
      plan: { host: "blade" },
      receipt: {
        target_acceptance: { operation_id: operationId },
      },
    }));
    const runSelfUpgrade = vi.fn();
    const runSelfUpgradeFleet = vi.fn();
    const program = buildProgram({
      runCli: {
        runSelfUpgradeTargetEntry: runSelfUpgradeTargetEntry as never,
        runSelfUpgrade,
        runSelfUpgradeFleet,
      },
    });

    await program.parseAsync(["node", "calyx", "self", "upgrade", "--json"]);

    expect(runSelfUpgradeTargetEntry).toHaveBeenCalledOnce();
    expect(runSelfUpgradeTargetEntry).toHaveBeenCalledWith(operationId);
    expect(runSelfUpgrade).not.toHaveBeenCalled();
    expect(runSelfUpgradeFleet).not.toHaveBeenCalled();
    expect(process.env["CALYX_SELF_UPGRADE_TARGET_OPERATION_ID"]).toBeUndefined();
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({
      schema_version: "self-upgrade-target-process-result/v1",
      operation_id: operationId,
      result: {
        operation_id: operationId,
        receipt: {
          target_acceptance: { operation_id: operationId },
        },
      },
    });
  });

  test("exposes status as the read-only child of the live self upgrade grammar", () => {
    const program = buildProgram();
    const self = program.commands.find((command) => command.name() === "self");
    const upgrade = self?.commands.find((command) => command.name() === "upgrade");
    const status = upgrade?.commands.find((command) => command.name() === "status");

    expect(status).toBeDefined();
    expect(status?.helpInformation()).toContain("[operation-id]");
    expect(status?.helpInformation()).toContain("--watch");
    expect(status?.helpInformation()).toContain("--json");
    expect(upgrade?.helpInformation()).toContain("status");
  });

  test.each([
    ["fleet", ["--fleet"]],
    ["remote-host", ["--host", "blade"]],
  ] as const)("prints exactly one terminal JSON document when %s execution throws", async (_mode, selector) => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const runSelfUpgradeFleet = vi.fn(async () => {
      throw Object.assign(new Error("injected fleet authority failure"), { exitCode: 6 });
    });
    const program = buildProgram({
      runCli: {
        currentHostAlias: "carbon",
        runSelfUpgradeFleet,
      },
    });

    await expect(program.parseAsync([
      "node",
      "calyx",
      "self",
      "upgrade",
      ...selector,
      "--json",
    ])).rejects.toThrow("injected fleet authority failure");

    expect(runSelfUpgradeFleet).toHaveBeenCalledTimes(1);
    expect(out).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toEqual({
      status: "failed",
      error: "injected fleet authority failure",
      exit_code: 6,
    });
  });

  test.each([
    ["malformed target", ["--host", "blade", "--target-sha", "bad"], /--target-sha/u, 2],
    ["conflicting selectors", ["--fleet", "--host", "blade"], /either --host/u, 2],
    ["missing selector", [], /requires --host/u, 2],
  ] as const)("prints one failure JSON for the %s pre-execution error", async (_label, args, message, exitCode) => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: { currentHostAlias: "blade" } });

    await expect(program.parseAsync([
      "node",
      "calyx",
      "self",
      "upgrade",
      ...args,
      "--json",
    ])).rejects.toThrow(message);

    expect(out).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({
      status: "failed",
      exit_code: exitCode,
    });
  });

  test("prints one failure JSON when current-host resolution fails", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({
      runCli: {
        resolveCurrentHostAlias: async () => {
          throw new Error("host truth unavailable");
        },
      },
    });

    await expect(program.parseAsync([
      "node",
      "calyx",
      "self",
      "upgrade",
      "--host",
      "blade",
      "--json",
    ])).rejects.toThrow(/host truth unavailable/u);

    expect(out).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toEqual({
      status: "failed",
      error: "Unable to resolve current host alias for self upgrade: host truth unavailable",
      exit_code: 6,
    });
  });

  test("fails a private relay alias mismatch instead of recursively dispatching ssh", async () => {
    const previousSchema = process.env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"];
    const previousOperation = process.env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"];
    process.env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"] = "self-upgrade-operation/v1";
    process.env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"] = "fleet-private-alias-drift";
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const runSelfUpgradeFleet = vi.fn();
    const program = buildProgram({
      runCli: {
        currentHostAlias: "carbon",
        runSelfUpgradeFleet,
      },
    });

    try {
      await expect(program.parseAsync([
        "node",
        "calyx",
        "self",
        "upgrade",
        "--host",
        "blade",
        "--json",
      ])).rejects.toThrow(/refusing recursive fleet dispatch/u);
      expect(runSelfUpgradeFleet).not.toHaveBeenCalled();
      expect(out).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({
        status: "failed",
        exit_code: 6,
      });
      expect(process.env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"]).toBeUndefined();
      expect(process.env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"]).toBeUndefined();
    } finally {
      if (previousSchema === undefined) delete process.env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"];
      else process.env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"] = previousSchema;
      if (previousOperation === undefined) delete process.env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"];
      else process.env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"] = previousOperation;
    }
  });

  test("consumes private relay environment before direct upgrade code can spawn descendants", async () => {
    const previousSchema = process.env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"];
    const previousOperation = process.env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"];
    process.env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"] = "self-upgrade-operation/v1";
    process.env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"] = "fleet-private-test";
    const runSelfUpgrade = vi.fn(async (options) => {
      expect(process.env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"]).toBeUndefined();
      expect(process.env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"]).toBeUndefined();
      expect(options).toMatchObject({ fleetOperationId: "fleet-private-test" });
      return {
        status: "dry-run" as const,
        plan: JSON.parse(dryRunJson("blade"))?.plan,
      };
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({
      runCli: {
        currentHostAlias: "blade",
        runSelfUpgrade,
      },
    });

    try {
      await program.parseAsync([
        "node",
        "calyx",
        "self",
        "upgrade",
        "--host",
        "blade",
        "--dry-run",
        "--json",
      ]);
      expect(runSelfUpgrade).toHaveBeenCalledTimes(1);
    } finally {
      if (previousSchema === undefined) delete process.env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"];
      else process.env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"] = previousSchema;
      if (previousOperation === undefined) delete process.env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"];
      else process.env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"] = previousOperation;
    }
  });

  test("binds receipt authority when progress-schema negotiation is absent", async () => {
    const previousSchema = process.env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"];
    const previousOperation = process.env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"];
    delete process.env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"];
    process.env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"] = "fleet-authority-without-progress";
    const runSelfUpgrade = vi.fn(async (options, dependencies) => {
      expect(options).toMatchObject({ fleetOperationId: "fleet-authority-without-progress" });
      expect(dependencies?.onPhase).toBeUndefined();
      return {
        status: "dry-run" as const,
        plan: JSON.parse(dryRunJson("blade"))?.plan,
      };
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({
      runCli: {
        currentHostAlias: "blade",
        runSelfUpgrade,
      },
    });

    try {
      await program.parseAsync([
        "node",
        "calyx",
        "self",
        "upgrade",
        "--host",
        "blade",
        "--dry-run",
        "--json",
      ]);
      expect(runSelfUpgrade).toHaveBeenCalledOnce();
    } finally {
      if (previousSchema === undefined) delete process.env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"];
      else process.env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"] = previousSchema;
      if (previousOperation === undefined) delete process.env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"];
      else process.env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"] = previousOperation;
    }
  });

  test("keeps the sole final stdout JSON when the private stderr relay hits asynchronous EPIPE", async () => {
    const previousSchema = process.env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"];
    const previousOperation = process.env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"];
    process.env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"] = "self-upgrade-operation/v1";
    process.env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"] = "fleet-private-epipe";
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const progressStream = new Writable({
      write(_chunk, _encoding, callback) {
        queueMicrotask(() => callback(Object.assign(new Error("remote relay EPIPE"), { code: "EPIPE" })));
      },
    });
    const runSelfUpgrade = vi.fn(async (_options, dependencies) => {
      expect(_options).toMatchObject({ fleetOperationId: "fleet-private-epipe" });
      dependencies?.onPhase?.({
        schema_version: "1.0",
        event_id: "remote-relay-build",
        cursor: "2026-07-21T12:00:00.000Z-remote-relay-build",
        emitted_at: "2026-07-21T12:00:00.000Z",
        event_type: "daemon.upgrade.progress",
        emitted_by: "self-upgrade",
        control: {
          host: "blade",
          operation_id: "host-private-epipe",
          phase: "build",
          elapsed_ms: 10,
        },
      });
      return {
        status: "dry-run" as const,
        plan: JSON.parse(dryRunJson("blade"))?.plan,
      };
    });
    const program = buildProgram({
      runCli: {
        currentHostAlias: "blade",
        runSelfUpgrade,
        selfUpgradeProgressStream: progressStream,
      },
    });

    try {
      await program.parseAsync([
        "node",
        "calyx",
        "self",
        "upgrade",
        "--host",
        "blade",
        "--dry-run",
        "--json",
      ]);

      expect(out).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({
        status: "dry-run",
        projection_issues: [expect.objectContaining({
          scope: "remote_phase_stderr",
          code: "projection_unavailable",
          message: "remote relay EPIPE",
        })],
      });
    } finally {
      progressStream.destroy();
      if (previousSchema === undefined) delete process.env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"];
      else process.env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"] = previousSchema;
      if (previousOperation === undefined) delete process.env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"];
      else process.env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"] = previousOperation;
    }
  });
});
