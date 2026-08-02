import { readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import type { CalyxDaemonDescriptor } from "@polli-labs/calyx-core";
import {
  createLaunchdSupervisorAdapter,
  type LaunchdSupervisorDependencies,
} from "../launchd.js";

function makeDescriptor(overrides: Partial<CalyxDaemonDescriptor> = {}): CalyxDaemonDescriptor {
  return {
    schema_version: "calyx-daemon/v1",
    daemon_id: "run-serve",
    daemon_kind: "run-service",
    pid: 4242,
    argv: ["calyx", "run", "serve", "--host", "127.0.0.1", "--port", "8740"],
    cwd: "/home/caleb/dev/calyx/dev",
    runs_root: "/home/caleb/.calyx/runs",
    health_url: "http://127.0.0.1:8740",
    livez_url: "http://127.0.0.1:8740/livez",
    supervisor: {
      kind: "launchd",
      label: "com.pollilabs.calyx.run-serve",
      plistPath: "/Users/carbon/Library/LaunchAgents/com.pollilabs.calyx.run-serve.plist",
    },
    started_at: "2026-04-20T00:00:00.000Z",
    build: {
      git_head: "build-sha",
      built_at: "2026-04-20T00:00:00.000Z",
      package_version: "0.2.0",
    },
    restart_order: 10,
    depends_on: [],
    maintenance_mode: false,
    ...overrides,
  };
}

describe("launchd supervisor adapter", () => {
  test("stop() calls launchctl bootout with the gui service target", async () => {
    const execFile = vi
      .fn<NonNullable<LaunchdSupervisorDependencies["execFile"]>>()
      .mockResolvedValueOnce({
        code: 0,
        stdout: "state = running\npid = 75012\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: "",
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 3,
        stdout: "",
        stderr: "Could not find service \"gui/501/com.pollilabs.calyx.run-serve\" in domain for user gui: 501\n",
      });
    const adapter = createLaunchdSupervisorAdapter({
      execFile,
      getUid: () => 501,
      sleep: async () => {},
      stopTimeoutMs: 1_000,
    });

    await expect(adapter.stop(makeDescriptor())).resolves.toMatchObject({
      signal: "launchd-bootout",
      pid: 75012,
      forced: false,
    });
    expect(execFile).toHaveBeenNthCalledWith(1, "launchctl", ["print", "gui/501/com.pollilabs.calyx.run-serve"]);
    expect(execFile).toHaveBeenNthCalledWith(2, "launchctl", ["bootout", "gui/501/com.pollilabs.calyx.run-serve"]);
  });

  test("start() bootstraps a cold launchd service with the plist path", async () => {
    const execFile = vi
      .fn<NonNullable<LaunchdSupervisorDependencies["execFile"]>>()
      .mockResolvedValueOnce({
        code: 3,
        stdout: "",
        stderr: "Could not find service \"gui/501/com.pollilabs.calyx.run-serve\" in domain for user gui: 501\n",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: "",
        stderr: "",
      });
    const descriptor = makeDescriptor();
    const adapter = createLaunchdSupervisorAdapter({
      execFile,
      getUid: () => 501,
    });

    await expect(adapter.start(descriptor)).resolves.toMatchObject({
      detail: descriptor.supervisor.kind === "launchd" ? descriptor.supervisor.plistPath : undefined,
    });
    expect(execFile).toHaveBeenNthCalledWith(1, "launchctl", ["print", "gui/501/com.pollilabs.calyx.run-serve"]);
    expect(execFile).toHaveBeenNthCalledWith(2, "launchctl", [
      "bootstrap",
      "gui/501",
      "/Users/carbon/Library/LaunchAgents/com.pollilabs.calyx.run-serve.plist",
    ]);
  });

  test("start() kickstarts an already loaded launchd service", async () => {
    const execFile = vi
      .fn<NonNullable<LaunchdSupervisorDependencies["execFile"]>>()
      .mockResolvedValueOnce({
        code: 0,
        stdout: "state = running\npid = 75012\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: "",
        stderr: "",
      });
    const adapter = createLaunchdSupervisorAdapter({
      execFile,
      getUid: () => 501,
    });

    await expect(adapter.start(makeDescriptor())).resolves.toMatchObject({
      detail: "gui/501/com.pollilabs.calyx.run-serve",
      pid: 75012,
    });
    expect(execFile).toHaveBeenNthCalledWith(2, "launchctl", ["kickstart", "-k", "gui/501/com.pollilabs.calyx.run-serve"]);
  });

  test("status() parses launchctl print output for running state and pid", async () => {
    const fixtureText = await readFile(new URL("./fixtures/launchctl-print-running.txt", import.meta.url), "utf8");
    const execFile = vi.fn<NonNullable<LaunchdSupervisorDependencies["execFile"]>>(async () => ({
      code: 0,
      stdout: fixtureText,
      stderr: "",
    }));
    const adapter = createLaunchdSupervisorAdapter({
      execFile,
      getUid: () => 501,
    });

    await expect(adapter.status(makeDescriptor())).resolves.toEqual({
      running: true,
      pid: 75012,
      detail: "gui/501/com.pollilabs.calyx.run-serve",
    });
  });

  test("status() reports not loaded services as not running", async () => {
    const execFile = vi.fn<NonNullable<LaunchdSupervisorDependencies["execFile"]>>(async () => ({
      code: 3,
      stdout: "",
      stderr: "Could not find service \"gui/501/com.pollilabs.calyx.run-serve\" in domain for user gui: 501\n",
    }));
    const adapter = createLaunchdSupervisorAdapter({
      execFile,
      getUid: () => 501,
    });

    await expect(adapter.status(makeDescriptor())).resolves.toEqual({
      running: false,
      detail: "gui/501/com.pollilabs.calyx.run-serve",
    });
  });

  test("stop() polls until launchd actually unloads the service and enforces a timeout", async () => {
    const execFile = vi
      .fn<NonNullable<LaunchdSupervisorDependencies["execFile"]>>()
      .mockResolvedValue({
        code: 0,
        stdout: "state = running\npid = 75012\n",
        stderr: "",
      });

    let nowMs = 0;
    const adapter = createLaunchdSupervisorAdapter({
      execFile,
      getUid: () => 501,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
      stopTimeoutMs: 250,
    });

    await expect(adapter.stop(makeDescriptor())).rejects.toThrow(
      "Timed out waiting for gui/501/com.pollilabs.calyx.run-serve to stop",
    );
    expect(execFile).toHaveBeenNthCalledWith(2, "launchctl", ["bootout", "gui/501/com.pollilabs.calyx.run-serve"]);
    expect(execFile.mock.calls.length).toBeGreaterThan(3);
  });
});
