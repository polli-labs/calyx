import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type {
  CalyxDaemonDescriptor,
  CalyxDaemonStartResult,
  CalyxDaemonStopResult,
  CalyxDaemonSupervisorAdapter,
  CalyxDaemonSupervisorStatus,
} from "@polli-labs/calyx-core";

type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export interface SystemdSupervisorDependencies {
  execFile?: (file: string, args: string[]) => Promise<ExecResult>;
}

const execFile = promisify(execFileCallback);

async function defaultExec(file: string, args: string[]): Promise<ExecResult> {
  try {
    const result = await execFile(file, args, { env: process.env });
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const typed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof typed.code === "number" ? typed.code : 1,
      stdout: typed.stdout ?? "",
      stderr: typed.stderr ?? "",
    };
  }
}

function assertSystemdDescriptor(descriptor: CalyxDaemonDescriptor): string {
  if (descriptor.supervisor.kind !== "systemd") {
    throw new Error(`Systemd supervisor adapter cannot manage ${descriptor.supervisor.kind} descriptors.`);
  }
  const unitName = descriptor.supervisor.unit_name?.trim();
  if (!unitName) {
    throw new Error(`Descriptor "${descriptor.daemon_id}" is missing supervisor.unit_name.`);
  }
  return unitName;
}

async function runSystemctl(
  execFn: (file: string, args: string[]) => Promise<ExecResult>,
  command: "start" | "stop" | "is-active",
  unitName: string,
): Promise<ExecResult> {
  return execFn("systemctl", ["--user", command, unitName]);
}

export function createSystemdSupervisorAdapter(
  dependencies: SystemdSupervisorDependencies = {},
): CalyxDaemonSupervisorAdapter {
  const execFn = dependencies.execFile ?? defaultExec;

  return {
    kind: "systemd",
    async stop(descriptor: CalyxDaemonDescriptor): Promise<CalyxDaemonStopResult> {
      const unitName = assertSystemdDescriptor(descriptor);
      const result = await runSystemctl(execFn, "stop", unitName);
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || `systemctl --user stop ${unitName} failed`);
      }
      return {
        signal: "systemd-stop",
        detail: unitName,
      };
    },
    async start(descriptor: CalyxDaemonDescriptor): Promise<CalyxDaemonStartResult> {
      const unitName = assertSystemdDescriptor(descriptor);
      const result = await runSystemctl(execFn, "start", unitName);
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || `systemctl --user start ${unitName} failed`);
      }
      return {
        detail: unitName,
      };
    },
    async status(descriptor: CalyxDaemonDescriptor): Promise<CalyxDaemonSupervisorStatus> {
      const unitName = assertSystemdDescriptor(descriptor);
      const result = await runSystemctl(execFn, "is-active", unitName);
      return {
        running: result.code === 0 && result.stdout.trim() === "active",
        detail: unitName,
      };
    },
  };
}
