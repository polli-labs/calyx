import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecFileAsync } from "./host-resources.js";
import type {
  RunGpuProcessAttributionObservation,
  RunObservedGpuProcess,
  RunObservedProcess,
  RunProcessTreeAttributionObservation,
  RunResourceAttributionObservation,
  RunResourceAttributionStatus,
} from "./types.js";

const execFileAsync = promisify(execFile) as ExecFileAsync;
const DEFAULT_MAX_PROCESSES = 32;
const PS_QUERY_ARGS = ["-eo", "pid=,ppid=,pcpu=,rss=,command="] as const;
const NVIDIA_SMI_COMPUTE_APPS_QUERY_ARGS = [
  "--query-compute-apps=pid,process_name,gpu_uuid,used_gpu_memory",
  "--format=csv,noheader,nounits",
] as const;

export interface CollectResourceAttributionOptions {
  rootPid?: number;
  now: () => string;
  execFile?: ExecFileAsync;
  timeoutMs?: number;
  maxProcesses?: number;
}

function parseOptionalNumber(value: string): number | undefined {
  const normalized = value.trim().replace(/\s*MiB$/i, "");
  if (!normalized || normalized === "[N/A]" || normalized.toLowerCase() === "n/a") {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized === "[N/A]" || normalized.toLowerCase() === "n/a") {
    return undefined;
  }
  return normalized;
}

function providerErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error);
}

function providerUnavailable(error: unknown): boolean {
  const errno = error as NodeJS.ErrnoException;
  return errno.code === "ENOENT";
}

function providerPermissionDenied(error: unknown): boolean {
  const errno = error as NodeJS.ErrnoException;
  return errno.code === "EACCES" || errno.code === "EPERM";
}

export function parsePsProcessRows(text: string): RunObservedProcess[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
      if (!match) {
        return [];
      }
      const pid = parseOptionalNumber(match[1] ?? "");
      const ppid = parseOptionalNumber(match[2] ?? "");
      if (typeof pid !== "number" || typeof ppid !== "number") {
        return [];
      }
      const cpuPercent = parseOptionalNumber(match[3] ?? "");
      const rssKib = parseOptionalNumber(match[4] ?? "");
      const command = match[5]?.trim();
      return [{
        pid,
        ppid,
        ...(typeof cpuPercent === "number" ? { cpu_percent: cpuPercent } : {}),
        ...(typeof rssKib === "number" ? { rss_kib: rssKib } : {}),
        ...(command && command.length > 0 ? { command } : {}),
      }];
    });
}

export function parseNvidiaSmiComputeAppsCsv(text: string): RunObservedGpuProcess[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [rawPid, rawProcessName, rawGpuUuid, rawUsedMemory] = line.split(",").map((part) => part.trim());
      const pid = parseOptionalNumber(rawPid ?? "");
      if (typeof pid !== "number") {
        return [];
      }
      const usedGpuMemory = parseOptionalNumber(rawUsedMemory ?? "");
      const processName = parseOptionalText(rawProcessName);
      const gpuUuid = parseOptionalText(rawGpuUuid);
      return [{
        pid,
        ...(processName ? { process_name: processName } : {}),
        ...(gpuUuid ? { gpu_uuid: gpuUuid } : {}),
        ...(typeof usedGpuMemory === "number" ? { used_gpu_memory_mib: usedGpuMemory } : {}),
      }];
    });
}

function buildAttributedProcessTree(args: {
  rootPid: number;
  checkedAt: string;
  rows: RunObservedProcess[];
  maxProcesses: number;
}): { observation: RunProcessTreeAttributionObservation; pidSet: Set<number> } {
  const byPid = new Map(args.rows.map((row) => [row.pid, row]));
  const root = byPid.get(args.rootPid);
  if (!root) {
    return {
      observation: {
        provider: "ps",
        status: "root_not_found",
        checked_at: args.checkedAt,
        root_pid: args.rootPid,
        processes: [],
        truncated: false,
        max_processes: args.maxProcesses,
        message: `Recorded worker pid ${args.rootPid} was not present in ps output.`,
      },
      pidSet: new Set(),
    };
  }

  const children = new Map<number, RunObservedProcess[]>();
  for (const row of args.rows) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row);
    children.set(row.ppid, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.pid - right.pid);
  }

  const processTree: RunObservedProcess[] = [];
  const seen = new Set<number>();
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.pid)) {
      continue;
    }
    seen.add(current.pid);
    processTree.push(current);
    queue.push(...(children.get(current.pid) ?? []));
  }

  const totalCpu = processTree.reduce((sum, row) => sum + (row.cpu_percent ?? 0), 0);
  const totalRss = processTree.reduce((sum, row) => sum + (row.rss_kib ?? 0), 0);
  const truncated = processTree.length > args.maxProcesses;
  return {
    observation: {
      provider: "ps",
      status: "attributed",
      checked_at: args.checkedAt,
      root_pid: args.rootPid,
      process_count: processTree.length,
      total_cpu_percent: Number(totalCpu.toFixed(3)),
      total_rss_kib: totalRss,
      processes: processTree.slice(0, args.maxProcesses),
      truncated,
      max_processes: args.maxProcesses,
    },
    pidSet: seen,
  };
}

async function collectProcessTree(args: {
  rootPid?: number;
  checkedAt: string;
  execFile: ExecFileAsync;
  timeoutMs: number;
  maxProcesses: number;
}): Promise<{ observation: RunProcessTreeAttributionObservation; pidSet: Set<number> }> {
  if (typeof args.rootPid !== "number") {
    return {
      observation: {
        provider: "ps",
        status: "pid_missing",
        checked_at: args.checkedAt,
        processes: [],
        truncated: false,
        max_processes: args.maxProcesses,
        message: "Run has no recorded worker pid.",
      },
      pidSet: new Set(),
    };
  }

  try {
    const result = await args.execFile("ps", PS_QUERY_ARGS, { timeout: args.timeoutMs });
    return buildAttributedProcessTree({
      rootPid: args.rootPid,
      checkedAt: args.checkedAt,
      rows: parsePsProcessRows(result.stdout),
      maxProcesses: args.maxProcesses,
    });
  } catch (error) {
    const status = providerPermissionDenied(error)
      ? "permission_denied"
      : providerUnavailable(error)
        ? "provider_unavailable"
        : "error";
    return {
      observation: {
        provider: "ps",
        status,
        checked_at: args.checkedAt,
        root_pid: args.rootPid,
        processes: [],
        truncated: false,
        max_processes: args.maxProcesses,
        message: providerErrorMessage(error),
      },
      pidSet: new Set(),
    };
  }
}

async function collectGpuProcesses(args: {
  checkedAt: string;
  execFile: ExecFileAsync;
  timeoutMs: number;
  attributedPids: Set<number>;
}): Promise<RunGpuProcessAttributionObservation> {
  try {
    const result = await args.execFile("nvidia-smi", NVIDIA_SMI_COMPUTE_APPS_QUERY_ARGS, { timeout: args.timeoutMs });
    const hostRows = parseNvidiaSmiComputeAppsCsv(result.stdout);
    const attributedRows = hostRows.filter((row) => args.attributedPids.has(row.pid));
    const attributedMemory = attributedRows.reduce((sum, row) => sum + (row.used_gpu_memory_mib ?? 0), 0);
    return {
      provider: "nvidia-smi",
      checked_at: args.checkedAt,
      command: ["nvidia-smi", ...NVIDIA_SMI_COMPUTE_APPS_QUERY_ARGS],
      status: attributedRows.length > 0
        ? "attributed"
        : hostRows.length > 0
          ? "host_only"
          : "none",
      host_process_count: hostRows.length,
      attributed_process_count: attributedRows.length,
      attributed_memory_used_mib: attributedMemory,
      processes: attributedRows,
    };
  } catch (error) {
    return {
      provider: "nvidia-smi",
      status: providerUnavailable(error) ? "unavailable" : "error",
      checked_at: args.checkedAt,
      command: ["nvidia-smi", ...NVIDIA_SMI_COMPUTE_APPS_QUERY_ARGS],
      processes: [],
      message: providerErrorMessage(error),
    };
  }
}

function overallStatus(args: {
  rootPid?: number;
  processTree: RunProcessTreeAttributionObservation;
  gpuProcesses: RunGpuProcessAttributionObservation;
}): RunResourceAttributionStatus {
  if (typeof args.rootPid !== "number") {
    return "pid_missing";
  }
  if (args.processTree.status === "attributed") {
    if ((args.processTree.total_cpu_percent ?? 0) === 0 && args.gpuProcesses.status === "host_only") {
      return "host_only";
    }
    return "attributed";
  }
  if (args.processTree.status === "root_not_found") {
    return "root_not_found";
  }
  if (args.processTree.status === "provider_unavailable") {
    return "process_provider_unavailable";
  }
  if (args.processTree.status === "permission_denied") {
    return "permission_denied";
  }
  return "error";
}

export async function collectResourceAttribution(
  options: CollectResourceAttributionOptions,
): Promise<RunResourceAttributionObservation> {
  const checkedAt = options.now();
  const runExecFile = options.execFile ?? execFileAsync;
  const timeoutMs = options.timeoutMs ?? 1_500;
  const maxProcesses = options.maxProcesses ?? DEFAULT_MAX_PROCESSES;
  const { observation: processTree, pidSet } = await collectProcessTree({
    ...(typeof options.rootPid === "number" ? { rootPid: options.rootPid } : {}),
    checkedAt,
    execFile: runExecFile,
    timeoutMs,
    maxProcesses,
  });
  const gpuProcesses = await collectGpuProcesses({
    checkedAt,
    execFile: runExecFile,
    timeoutMs,
    attributedPids: pidSet,
  });

  return {
    schema_version: "run-resource-attribution/v1",
    checked_at: checkedAt,
    ...(typeof options.rootPid === "number" ? { root_pid: options.rootPid } : {}),
    status: overallStatus({
      ...(typeof options.rootPid === "number" ? { rootPid: options.rootPid } : {}),
      processTree,
      gpuProcesses,
    }),
    process_tree: processTree,
    gpu_processes: gpuProcesses,
  };
}
