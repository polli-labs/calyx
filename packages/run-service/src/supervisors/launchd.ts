import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type {
  CalyxDaemonDescriptor,
  CalyxLaunchdDaemonSupervisor,
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

type LaunchdServiceState = {
  loaded: boolean;
  state?: string;
  pid?: number;
};

export interface LaunchdSupervisorDependencies {
  execFile?: (file: string, args: string[]) => Promise<ExecResult>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  getUid?: () => number;
  stopTimeoutMs?: number;
}

const DEFAULT_LAUNCHD_LABEL_PREFIX = "com.pollilabs.calyx.";
const DEFAULT_STOP_TIMEOUT_MS = 305_000;
const POLL_INTERVAL_MS = 100;
const MISSING_SERVICE_PATTERN = /could not find service/i;

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

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultLaunchdLabel(daemonId: string): string {
  const trimmed = daemonId.trim();
  return trimmed.includes(".") ? trimmed : `${DEFAULT_LAUNCHD_LABEL_PREFIX}${trimmed}`;
}

function assertLaunchdDescriptor(
  descriptor: CalyxDaemonDescriptor,
): asserts descriptor is CalyxDaemonDescriptor & { supervisor: CalyxLaunchdDaemonSupervisor } {
  if (descriptor.supervisor.kind !== "launchd") {
    throw new Error(`Launchd supervisor adapter cannot manage ${descriptor.supervisor.kind} descriptors.`);
  }
}

function launchdLabel(descriptor: CalyxDaemonDescriptor & { supervisor: CalyxLaunchdDaemonSupervisor }): string {
  return descriptor.supervisor.label?.trim() || defaultLaunchdLabel(descriptor.daemon_id);
}

function launchdServiceTarget(uid: number, label: string): string {
  return `gui/${uid}/${label}`;
}

function launchdDomainTarget(uid: number): string {
  return `gui/${uid}`;
}

function extractOutput(result: ExecResult): string {
  return `${result.stdout}${result.stderr}`.trim();
}

function missingService(result: ExecResult): boolean {
  return MISSING_SERVICE_PATTERN.test(extractOutput(result));
}

function ensureSuccess(result: ExecResult, args: string[]): void {
  if (result.code === 0) {
    return;
  }
  const detail = extractOutput(result);
  throw new Error(detail || `launchctl ${args.join(" ")} failed`);
}

function parseLaunchctlPrint(output: string): LaunchdServiceState {
  const state = output.match(/^\s*state\s*=\s*(.+)$/m)?.[1]?.trim();
  const pidText = output.match(/^\s*pid\s*=\s*(\d+)\b/m)?.[1];
  const pid = pidText ? Number.parseInt(pidText, 10) : undefined;
  return {
    loaded: true,
    ...(state ? { state } : {}),
    ...(typeof pid === "number" ? { pid } : {}),
  };
}

async function inspectLaunchdService(
  execFn: (file: string, args: string[]) => Promise<ExecResult>,
  serviceTarget: string,
): Promise<LaunchdServiceState> {
  const result = await execFn("launchctl", ["print", serviceTarget]);
  if (result.code !== 0) {
    if (missingService(result)) {
      return { loaded: false };
    }
    ensureSuccess(result, ["print", serviceTarget]);
  }
  return parseLaunchctlPrint(result.stdout);
}

export function createLaunchdSupervisorAdapter(
  dependencies: LaunchdSupervisorDependencies = {},
): CalyxDaemonSupervisorAdapter {
  const execFn = dependencies.execFile ?? defaultExec;
  const sleep = dependencies.sleep ?? defaultSleep;
  const now = dependencies.now ?? Date.now;
  const getUid = dependencies.getUid ?? process.getuid?.bind(process);
  if (!getUid) {
    throw new Error("launchd supervisor adapter requires process.getuid().");
  }

  return {
    kind: "launchd",
    async stop(descriptor: CalyxDaemonDescriptor): Promise<CalyxDaemonStopResult> {
      assertLaunchdDescriptor(descriptor);
      const uid = getUid();
      const label = launchdLabel(descriptor);
      const serviceTarget = launchdServiceTarget(uid, label);
      const initial = await inspectLaunchdService(execFn, serviceTarget);
      if (!initial.loaded) {
        return {
          signal: "launchd-bootout",
          forced: false,
          detail: "service already stopped",
          ...(typeof initial.pid === "number" ? { pid: initial.pid } : {}),
        };
      }

      const bootoutResult = await execFn("launchctl", ["bootout", serviceTarget]);
      if (bootoutResult.code !== 0 && !missingService(bootoutResult)) {
        ensureSuccess(bootoutResult, ["bootout", serviceTarget]);
      }

      const deadlineMs = dependencies.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
      const deadlineAt = now() + deadlineMs;
      while (now() <= deadlineAt) {
        const current = await inspectLaunchdService(execFn, serviceTarget);
        if (!current.loaded) {
          return {
            signal: "launchd-bootout",
            forced: false,
            detail: serviceTarget,
            ...(typeof (initial.pid ?? current.pid) === "number" ? { pid: initial.pid ?? current.pid } : {}),
          };
        }
        await sleep(POLL_INTERVAL_MS);
      }

      const current = await inspectLaunchdService(execFn, serviceTarget);
      if (!current.loaded) {
        return {
          signal: "launchd-bootout",
          forced: false,
          detail: serviceTarget,
          ...(typeof (initial.pid ?? current.pid) === "number" ? { pid: initial.pid ?? current.pid } : {}),
        };
      }
      const suffix = current.state ? `state=${current.state}` : "state=unknown";
      const pidSuffix = typeof current.pid === "number" ? ` pid=${current.pid}` : "";
      throw new Error(`Timed out waiting for ${serviceTarget} to stop (${suffix}${pidSuffix})`);
    },
    async start(descriptor: CalyxDaemonDescriptor): Promise<CalyxDaemonStartResult> {
      assertLaunchdDescriptor(descriptor);
      const uid = getUid();
      const label = launchdLabel(descriptor);
      const serviceTarget = launchdServiceTarget(uid, label);
      const current = await inspectLaunchdService(execFn, serviceTarget);
      if (current.loaded) {
        const kickstartResult = await execFn("launchctl", ["kickstart", "-k", serviceTarget]);
        ensureSuccess(kickstartResult, ["kickstart", "-k", serviceTarget]);
        return {
          detail: serviceTarget,
          ...(typeof current.pid === "number" ? { pid: current.pid } : {}),
        };
      }

      const plistPath = descriptor.supervisor.plistPath?.trim();
      if (!plistPath) {
        throw new Error(`Descriptor "${descriptor.daemon_id}" is missing supervisor.plistPath.`);
      }
      const domainTarget = launchdDomainTarget(uid);
      const bootstrapResult = await execFn("launchctl", ["bootstrap", domainTarget, plistPath]);
      ensureSuccess(bootstrapResult, ["bootstrap", domainTarget, plistPath]);
      return {
        detail: plistPath,
      };
    },
    async status(descriptor: CalyxDaemonDescriptor): Promise<CalyxDaemonSupervisorStatus> {
      assertLaunchdDescriptor(descriptor);
      const uid = getUid();
      const label = launchdLabel(descriptor);
      const serviceTarget = launchdServiceTarget(uid, label);
      const current = await inspectLaunchdService(execFn, serviceTarget);
      return {
        running: current.loaded && current.state === "running",
        detail: serviceTarget,
        ...(typeof current.pid === "number" ? { pid: current.pid } : {}),
      };
    },
  };
}
