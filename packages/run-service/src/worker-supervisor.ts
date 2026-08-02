import { createHash } from "node:crypto";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { appendFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isConsumerApiSecretEnvName } from "@polli-labs/calyx-core";

const SYSTEMD_WORKER_CGROUP_FILE = "systemd-worker.cgroup";
const SYSTEMD_WORKER_ENV_FILE = "systemd-worker.env";
const SYSTEMD_WORKER_ENV_DIR_PREFIX = "calyx-systemd-worker-env-";
const SYSTEMD_WORKER_ENV_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export type DetachedWorkerSupervisor = "direct" | "systemd";

export interface DetachedWorkerSpawnArgs {
  entrypoint: string;
  runId: string;
  runsRoot: string;
  runDir: string;
  redactedEnvNames?: readonly string[] | undefined;
}

export interface DetachedWorkerLaunchResult {
  pid?: number;
  supervisor?: DetachedWorkerSupervisor;
  systemdUnit?: string | undefined;
  cgroup?: string | undefined;
  /**
   * Set only when systemd isolation was attempted and fell back to a direct
   * worker (POL-2044). Its presence is the durable, machine-readable proof that
   * a `direct` supervisor was NOT the intended posture; the string is the
   * bounded systemd-unavailable detail for post-hoc diagnosis without scraping
   * stderr. The restart classifier never trusts a fallback worker as
   * preserve-safe.
   */
  supervisorFallbackReason?: string;
}

/** Bound the persisted fallback detail so a launch payload stays compact. */
const SYSTEMD_FALLBACK_REASON_MAX_LENGTH = 512;

export interface DetachedWorkerCommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface DetachedWorkerSupervisorInternals {
  platform?: NodeJS.Platform | undefined;
  cgroupText?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  spawnDirectWorker?: (args: DetachedWorkerSpawnArgs) => Promise<DetachedWorkerLaunchResult>;
  runSystemdCommand?: (command: string, args: string[]) => Promise<DetachedWorkerCommandResult>;
}

interface SystemdWorkerIsolationDecision {
  useSystemd: boolean;
  explicit: boolean;
}

class SystemdWorkerLaunchUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SystemdWorkerLaunchUnavailableError";
  }
}

export function openDetachedLogFiles(
  rootDir: string,
  options: {
    stdoutName: string;
    stderrName: string;
  },
): {
  stdio: ["ignore", number, number];
  closeParentFds: () => void;
} {
  mkdirSync(rootDir, { recursive: true });
  const stdoutFd = openSync(path.join(rootDir, options.stdoutName), "a");
  try {
    const stderrFd = openSync(path.join(rootDir, options.stderrName), "a");
    return {
      stdio: ["ignore", stdoutFd, stderrFd],
      closeParentFds: () => {
        closeSync(stdoutFd);
        closeSync(stderrFd);
      },
    };
  } catch (error) {
    closeSync(stdoutFd);
    throw error;
  }
}

export function isSystemdServiceCgroup(cgroupText: string): boolean {
  return cgroupText
    .split(/\r?\n/)
    .some((line) =>
      line
        .split("/")
        .some((segment) => segment.endsWith(".service") && !/^user@\d+\.service$/.test(segment)),
    );
}

export function systemdWorkerUnitBase(runId: string): string {
  const hash = createHash("sha256").update(runId).digest("hex").slice(0, 8);
  const sanitized = runId
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const stem = sanitized.length > 0 ? sanitized : "run";
  const bounded = stem.length > 150 ? stem.slice(0, 150) : stem;
  return `calyx-run-${bounded}-${hash}`;
}

export function systemdWorkerUnitName(runId: string): string {
  return `${systemdWorkerUnitBase(runId)}.service`;
}

export function systemdEnvironmentFileContents(env: NodeJS.ProcessEnv): string {
  return Object.entries(env)
    .filter((entry): entry is [string, string] => isEnvironmentName(entry[0]) && typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${quoteEnvironmentValue(value)}`)
    .join("\n")
    .concat("\n");
}

export function systemdWorkerEnvironmentRoot(env: NodeJS.ProcessEnv = process.env): string {
  const xdgRuntimeDir = env["XDG_RUNTIME_DIR"]?.trim();
  if (xdgRuntimeDir && path.isAbsolute(xdgRuntimeDir)) {
    return xdgRuntimeDir;
  }
  return tmpdir();
}

export function systemdEscapeExecShell(script: string): string {
  return script.replace(/\$/g, () => "$$");
}

export function shouldUseSystemdWorkerIsolation(options: {
  platform?: NodeJS.Platform | undefined;
  cgroupText?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
} = {}): boolean {
  return resolveSystemdWorkerIsolation(options).useSystemd;
}

function resolveSystemdWorkerIsolation(options: {
  platform?: NodeJS.Platform | undefined;
  cgroupText?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
} = {}): SystemdWorkerIsolationDecision {
  const env = options.env ?? process.env;
  const override = env["CALYX_RUN_WORKER_SUPERVISOR"]?.trim().toLowerCase();
  if (override === "direct" || override === "none" || override === "0") {
    return { useSystemd: false, explicit: true };
  }

  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    return { useSystemd: false, explicit: false };
  }
  if (override === "systemd" || override === "1") {
    return { useSystemd: true, explicit: true };
  }

  const cgroupText = options.cgroupText ?? readSelfCgroupText();
  return { useSystemd: isSystemdServiceCgroup(cgroupText), explicit: false };
}

export async function spawnDetachedWorker(
  args: DetachedWorkerSpawnArgs,
  internals: DetachedWorkerSupervisorInternals = {},
): Promise<DetachedWorkerLaunchResult> {
  const directWorker = internals.spawnDirectWorker
    ?? ((spawnArgs) => spawnDirectWorker(spawnArgs, internals.env ?? process.env));
  const decision = resolveSystemdWorkerIsolation({
    ...(internals.platform ? { platform: internals.platform } : {}),
    ...(internals.cgroupText !== undefined ? { cgroupText: internals.cgroupText } : {}),
    ...(internals.env ? { env: internals.env } : {}),
  });
  if (!decision.useSystemd) {
    return directWorker(args);
  }
  try {
    return await spawnSystemdWorker(args, internals);
  } catch (error) {
    if (decision.explicit || !(error instanceof SystemdWorkerLaunchUnavailableError)) {
      throw error;
    }
    await recordSystemdFallback(args, error);
    const fallback = await directWorker(args);
    return { ...fallback, supervisorFallbackReason: boundSystemdFallbackReason(error) };
  }
}

function boundSystemdFallbackReason(error: SystemdWorkerLaunchUnavailableError): string {
  const message = error.message.replace(/\s+/g, " ").trim();
  return message.length > SYSTEMD_FALLBACK_REASON_MAX_LENGTH
    ? `${message.slice(0, SYSTEMD_FALLBACK_REASON_MAX_LENGTH - 1)}…`
    : message;
}

async function spawnDirectWorker(
  args: DetachedWorkerSpawnArgs,
  inheritedEnv: NodeJS.ProcessEnv,
): Promise<DetachedWorkerLaunchResult> {
  const logHandles = openDetachedLogFiles(args.runDir, {
    stdoutName: "stdout.log",
    stderrName: "stderr.log",
  });
  let child: ChildProcess;
  try {
    child = spawnChild(
      process.execPath,
      [args.entrypoint, "run", "execute-stored", "--run-id", args.runId, "--runs-root", args.runsRoot],
      {
        detached: true,
        stdio: logHandles.stdio,
        env: {
          ...redactServerOnlyEnvironment(inheritedEnv, args.redactedEnvNames),
          CALYX_RUNS_ROOT: args.runsRoot,
        },
      },
    );
  } finally {
    logHandles.closeParentFds();
  }
  child.unref();
  if (!child.pid) {
    throw new Error("Detached run worker did not expose a PID.");
  }
  return { pid: child.pid, supervisor: "direct" };
}

async function spawnSystemdWorker(
  args: DetachedWorkerSpawnArgs,
  internals: DetachedWorkerSupervisorInternals,
): Promise<DetachedWorkerLaunchResult> {
  mkdirSync(args.runDir, { recursive: true });
  const cgroupPath = path.join(args.runDir, SYSTEMD_WORKER_CGROUP_FILE);
  const unitBase = systemdWorkerUnitBase(args.runId);
  const unitName = `${unitBase}.service`;
  const stdoutPath = path.join(args.runDir, "stdout.log");
  const stderrPath = path.join(args.runDir, "stderr.log");
  const launchScript = [
    "cgroupfile=$1",
    "stdout=$2",
    "stderr=$3",
    "shift 3",
    'cat "/proc/$$/cgroup" > "$cgroupfile" 2>/dev/null || true',
    'exec "$@" >> "$stdout" 2>> "$stderr"',
  ].join("; ");
  const envContents = systemdEnvironmentFileContents({
    ...redactServerOnlyEnvironment(internals.env ?? process.env, args.redactedEnvNames),
    CALYX_RUNS_ROOT: args.runsRoot,
  });
  const envFile = await createSystemdWorkerEnvironmentFile(args.runId, envContents, systemdWorkerEnvironmentRoot(internals.env)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new SystemdWorkerLaunchUnavailableError(
      `systemd worker environment file staging failed: ${message}`,
      error,
    );
  });

  let result: DetachedWorkerCommandResult;
  try {
    const execStartArgs = [
      "/bin/sh",
      "-c",
      launchScript,
      "calyx-run-worker",
      cgroupPath,
      stdoutPath,
      stderrPath,
      process.execPath,
      args.entrypoint,
      "run",
      "execute-stored",
      "--run-id",
      args.runId,
      "--runs-root",
      args.runsRoot,
    ].map(systemdEscapeExecShell);
    result = await runSystemdCommand(internals, "systemd-run", [
      "--user",
      `--unit=${unitBase}`,
      "--collect",
      "--quiet",
      // systemd-run without --no-block returns after the start job, by which
      // point systemd has consumed EnvironmentFile. Keep env dir deletion
      // tied to that synchronous contract.
      `--property=EnvironmentFile=${envFile.path}`,
      ...execStartArgs,
    ]);
  } finally {
    await rm(envFile.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  if (result.code !== 0) {
    const details = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    throw new SystemdWorkerLaunchUnavailableError(
      `systemd-run failed to launch detached run worker ${args.runId}${details ? `:\n${details}` : "."}`,
    );
  }

  const cgroupText = await readFile(cgroupPath, "utf8").catch(() => "");
  const cgroup = cgroupText.trim();
  return {
    supervisor: "systemd",
    systemdUnit: unitName,
    ...(cgroup.length > 0 ? { cgroup } : {}),
  };
}

const DETACHED_WORKER_SERVER_ONLY_ENV_NAMES = new Set([
  // Transitional pre-catalog bearer. It must never cross the daemon boundary.
  "CALYX_RUN_SERVER_TOKEN",
  // The daemon owns Linear monitor delivery. Execution workers do not publish.
  "LINEAR_API_KEY",
]);

export function serverOnlyEnvironmentNames(
  env: NodeJS.ProcessEnv,
  catalogSecretEnvs: readonly string[] = [],
  additionalNames: readonly string[] = [],
): readonly string[] {
  const names = new Set([
    ...DETACHED_WORKER_SERVER_ONLY_ENV_NAMES,
    ...catalogSecretEnvs,
  ]);
  for (const key of [...Object.keys(env), ...additionalNames]) {
    if (isConsumerApiSecretEnvName(key)) names.add(key);
  }
  return [...names].sort();
}

/** Removes server-only material before either direct or systemd worker spawn. */
export function redactServerOnlyEnvironment(
  env: NodeJS.ProcessEnv,
  catalogSecretEnvs: readonly string[] = [],
): NodeJS.ProcessEnv {
  const redacted = new Set(serverOnlyEnvironmentNames(env, catalogSecretEnvs));
  const result: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(env)) {
    if (redacted.has(key) || isConsumerApiSecretEnvName(key)) continue;
    const value = env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}


async function createSystemdWorkerEnvironmentFile(
  runId: string,
  contents: string,
  root = systemdWorkerEnvironmentRoot(),
): Promise<{ dir: string; path: string }> {
  await cleanupStaleSystemdWorkerEnvironmentDirs(root);
  const dir = await mkdtemp(path.join(root, `${SYSTEMD_WORKER_ENV_DIR_PREFIX}${systemdWorkerUnitBase(runId)}-`));
  const envPath = path.join(dir, SYSTEMD_WORKER_ENV_FILE);
  try {
    await writeFile(envPath, contents, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { dir, path: envPath };
}

async function cleanupStaleSystemdWorkerEnvironmentDirs(
  root = systemdWorkerEnvironmentRoot(),
  nowMs = Date.now(),
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || !entry.name.startsWith(SYSTEMD_WORKER_ENV_DIR_PREFIX)) {
        return;
      }
      const dirPath = path.join(root, entry.name);
      const dirStat = await stat(dirPath).catch(() => undefined);
      if (!dirStat || nowMs - dirStat.mtimeMs < SYSTEMD_WORKER_ENV_MAX_AGE_MS) {
        return;
      }
      await rm(dirPath, { recursive: true, force: true });
    }),
  );
}

async function recordSystemdFallback(
  args: DetachedWorkerSpawnArgs,
  error: SystemdWorkerLaunchUnavailableError,
): Promise<void> {
  mkdirSync(args.runDir, { recursive: true });
  await appendFile(
    path.join(args.runDir, "stderr.log"),
    `[calyx] systemd worker isolation unavailable; falling back to direct supervisor: ${error.message}\n`,
    "utf8",
  ).catch(() => undefined);
}

function readSelfCgroupText(): string {
  try {
    return readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return "";
  }
}

function isEnvironmentName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function quoteEnvironmentValue(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')}"`;
}

function runSystemdCommand(
  internals: DetachedWorkerSupervisorInternals,
  command: string,
  args: string[],
): Promise<DetachedWorkerCommandResult> {
  if (internals.runSystemdCommand) {
    return internals.runSystemdCommand(command, args);
  }
  return collectCommand(spawnChild(command, args));
}

function collectCommand(child: ChildProcess): Promise<DetachedWorkerCommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new SystemdWorkerLaunchUnavailableError(`systemd-run failed to start: ${error.message}`, error));
    });
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}
