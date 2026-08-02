import { describe, expect, test, vi } from "vitest";
import type { CalyxDaemonDescriptor } from "@polli-labs/calyx-core";
import {
  createDirectSupervisorAdapter,
  type DirectSupervisorDependencies,
} from "../supervisors/direct.js";
import { createSystemdSupervisorAdapter } from "../supervisors/systemd.js";

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
      kind: "direct",
      stop_grace_ms: 25,
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

describe("direct supervisor adapter", () => {
  test("stops a live process with SIGTERM", async () => {
    let running = true;
    const processKill = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      expect(pid).toBe(4242);
      if (signal === "SIGTERM") {
        running = false;
        return true;
      }
      if (signal === 0) {
        if (running) {
          return true;
        }
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    }) as unknown as typeof process.kill;

    const adapter = createDirectSupervisorAdapter({
      processKill,
      sleep: async () => {},
    });

    await expect(adapter.stop(makeDescriptor())).resolves.toMatchObject({
      pid: 4242,
      signal: "SIGTERM",
      forced: false,
    });
  });

  test("restarts a descriptor using the captured argv and cwd", async () => {
    const unref = vi.fn();
    const spawnCalls = vi.fn();
    const spawnDependency: NonNullable<DirectSupervisorDependencies["spawn"]> = (
      command,
      args,
      options,
    ) => {
      spawnCalls(command, args, options);
      return {
        pid: 5150,
        unref,
      };
    };
    const adapter = createDirectSupervisorAdapter({
      spawn: spawnDependency,
    });

    await expect(adapter.start(makeDescriptor())).resolves.toMatchObject({
      pid: 5150,
    });
    expect(spawnCalls).toHaveBeenCalledWith(
      "calyx",
      ["run", "serve", "--host", "127.0.0.1", "--port", "8740"],
      expect.objectContaining({
        cwd: "/home/caleb/dev/calyx/dev",
        detached: true,
        stdio: "ignore",
      }),
    );
    expect(unref).toHaveBeenCalled();
  });
});

describe("systemd supervisor adapter", () => {
  test("uses systemctl --user for stop, start, and status", async () => {
    const execFile = vi.fn(async (_file: string, args: string[]) => ({
      code: args[1] === "is-active" ? 0 : 0,
      stdout: args[1] === "is-active" ? "active\n" : "",
      stderr: "",
    }));
    const adapter = createSystemdSupervisorAdapter({ execFile });
    const descriptor = makeDescriptor({
      supervisor: {
        kind: "systemd",
        unit_name: "calyx-run-serve.service",
      },
    });

    await expect(adapter.stop(descriptor)).resolves.toMatchObject({ signal: "systemd-stop" });
    await expect(adapter.start(descriptor)).resolves.toMatchObject({ detail: "calyx-run-serve.service" });
    await expect(adapter.status(descriptor)).resolves.toMatchObject({ running: true, detail: "calyx-run-serve.service" });
  });
});
