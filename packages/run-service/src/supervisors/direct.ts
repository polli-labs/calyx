import { spawn as spawnChild } from "node:child_process";
import type {
  CalyxDaemonDescriptor,
  CalyxDirectDaemonSupervisor,
  CalyxDaemonStartResult,
  CalyxDaemonStopResult,
  CalyxDaemonSupervisorAdapter,
  CalyxDaemonSupervisorStatus,
} from "@polli-labs/calyx-core";

export interface DirectSupervisorDependencies {
  spawn?: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      detached: boolean;
      stdio: "ignore";
    },
  ) => {
    pid: number | undefined;
    unref: () => void;
  };
  processKill?: typeof process.kill;
  sleep?: (ms: number) => Promise<void>;
}

function isProcessAlive(pid: number, processKill: typeof process.kill): boolean {
  try {
    processKill(pid, 0);
    return true;
  } catch (error) {
    const typed = error as NodeJS.ErrnoException;
    if (typed.code === "ESRCH") {
      return false;
    }
    if (typed.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

async function waitForExit(
  pid: number,
  deadlineMs: number,
  processKill: typeof process.kill,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= deadlineMs) {
    if (!isProcessAlive(pid, processKill)) {
      return true;
    }
    await sleep(100);
  }
  return !isProcessAlive(pid, processKill);
}

function assertDirectDescriptor(
  descriptor: CalyxDaemonDescriptor,
): asserts descriptor is CalyxDaemonDescriptor & { supervisor: CalyxDirectDaemonSupervisor } {
  if (descriptor.supervisor.kind !== "direct") {
    throw new Error(`Direct supervisor adapter cannot manage ${descriptor.supervisor.kind} descriptors.`);
  }
}

export function createDirectSupervisorAdapter(
  dependencies: DirectSupervisorDependencies = {},
): CalyxDaemonSupervisorAdapter {
  const spawn = dependencies.spawn ?? spawnChild;
  const processKill = dependencies.processKill ?? process.kill;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  return {
    kind: "direct",
    async stop(descriptor: CalyxDaemonDescriptor): Promise<CalyxDaemonStopResult> {
      assertDirectDescriptor(descriptor);
      const supervisor = descriptor.supervisor;
      const pid = descriptor.pid;
      if (!isProcessAlive(pid, processKill)) {
        return {
          pid,
          signal: "SIGTERM",
          forced: false,
          detail: "process already stopped",
        };
      }

      processKill(pid, "SIGTERM");
      const stopGraceMs = supervisor.stop_grace_ms ?? 5_000;
      const exitedGracefully = await waitForExit(pid, stopGraceMs, processKill, sleep);
      if (exitedGracefully) {
        return {
          pid,
          signal: "SIGTERM",
          forced: false,
        };
      }

      processKill(pid, "SIGKILL");
      await waitForExit(pid, 1_000, processKill, sleep);
      return {
        pid,
        signal: "SIGKILL",
        forced: true,
      };
    },
    async start(descriptor: CalyxDaemonDescriptor): Promise<CalyxDaemonStartResult> {
      assertDirectDescriptor(descriptor);
      if (descriptor.argv.length === 0) {
        throw new Error(`Descriptor "${descriptor.daemon_id}" has no argv to restart.`);
      }
      const child = spawn(descriptor.argv[0]!, descriptor.argv.slice(1), {
        cwd: descriptor.cwd,
        env: process.env,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return child.pid === undefined ? {} : { pid: child.pid };
    },
    async status(descriptor: CalyxDaemonDescriptor): Promise<CalyxDaemonSupervisorStatus> {
      assertDirectDescriptor(descriptor);
      return {
        running: isProcessAlive(descriptor.pid, processKill),
        pid: descriptor.pid,
      };
    },
  };
}
