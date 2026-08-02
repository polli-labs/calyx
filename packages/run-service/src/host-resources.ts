import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  RunGpuDeviceObservation,
  RunGpuResourceObservation,
  RunHostResourceObservation,
} from "./types.js";

export type ExecFileAsync = (
  file: string,
  args?: readonly string[],
  options?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile) as ExecFileAsync;
const NVIDIA_SMI_QUERY_ARGS = [
  "--query-gpu=index,name,utilization.gpu,memory.used,memory.total",
  "--format=csv,noheader,nounits",
] as const;

function parseOptionalNumber(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized || normalized === "[N/A]" || normalized.toLowerCase() === "n/a") {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseNvidiaSmiCsv(text: string): RunGpuDeviceObservation[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [rawIndex, rawName, rawUtilization, rawMemoryUsed, rawMemoryTotal] = line
        .split(",")
        .map((part) => part.trim());
      const index = parseOptionalNumber(rawIndex ?? "") ?? 0;
      const utilization = parseOptionalNumber(rawUtilization ?? "");
      const memoryUsed = parseOptionalNumber(rawMemoryUsed ?? "");
      const memoryTotal = parseOptionalNumber(rawMemoryTotal ?? "");
      const device: RunGpuDeviceObservation = {
        index,
        name: rawName && rawName.length > 0 ? rawName : `gpu-${index}`,
        ...(typeof utilization === "number" ? { utilization_gpu_percent: utilization } : {}),
        ...(typeof memoryUsed === "number" ? { memory_used_mib: memoryUsed } : {}),
        ...(typeof memoryTotal === "number" ? { memory_total_mib: memoryTotal } : {}),
      };
      return device;
    });
}

function unavailableGpuObservation(checkedAt: string, message: string): RunGpuResourceObservation {
  return {
    provider: "nvidia-smi",
    status: "unavailable",
    checked_at: checkedAt,
    command: ["nvidia-smi", ...NVIDIA_SMI_QUERY_ARGS],
    gpus: [],
    message,
  };
}

export async function collectHostResources(options: {
  now: () => string;
  execFile?: ExecFileAsync;
  timeoutMs?: number;
}): Promise<RunHostResourceObservation> {
  const checkedAt = options.now();
  const runExecFile = options.execFile ?? execFileAsync;
  let gpu: RunGpuResourceObservation;
  try {
    const result = await runExecFile("nvidia-smi", NVIDIA_SMI_QUERY_ARGS, {
      timeout: options.timeoutMs ?? 1_500,
    });
    const gpus = parseNvidiaSmiCsv(result.stdout);
    gpu = {
      provider: "nvidia-smi",
      status: gpus.length > 0 ? "available" : "unavailable",
      checked_at: checkedAt,
      command: ["nvidia-smi", ...NVIDIA_SMI_QUERY_ARGS],
      gpus,
      ...(gpus.length === 0 ? { message: "nvidia-smi returned no GPU rows." } : {}),
    };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    const message = errno.code === "ENOENT"
      ? "nvidia-smi not found on PATH."
      : error instanceof Error && error.message
        ? error.message
        : String(error);
    gpu = unavailableGpuObservation(checkedAt, message);
  }

  return {
    schema_version: "host-resources/v1",
    checked_at: checkedAt,
    gpu,
  };
}
