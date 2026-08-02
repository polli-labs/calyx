import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { acquireCooperativeFileLock } from "@polli-labs/calyx-core";
import type { CalyxDaemonDescriptor } from "@polli-labs/calyx-core";
import { defaultDaemonsRoot } from "./daemon-store.js";

const DESCRIPTOR_FILENAME = "descriptor.json";
const DEFAULT_DIRECT_STOP_GRACE_MS = 5_000;
const DEFAULT_LAUNCHD_LABEL_PREFIX = "com.pollilabs.calyx.";

export interface DaemonRegistryOptions {
  root?: string | undefined;
  isProcessAlive?: ((pid: number) => boolean) | undefined;
  /**
   * Cooperative point-of-use compare-and-swap. Every registry writer shares
   * the descriptor write lock; a stale expected value is refused.
   */
  expectedDescriptor?: CalyxDaemonDescriptor | undefined;
}

export interface DetectSupervisorOptions {
  homeDir?: string | undefined;
  pathExists?: ((targetPath: string) => boolean) | undefined;
}

function resolveRegistryRoot(root?: string): string {
  return path.resolve(root ?? defaultDaemonsRoot());
}

function descriptorPath(root: string, daemonId: string): string {
  return path.join(root, daemonId, DESCRIPTOR_FILENAME);
}

async function readDescriptorFile(filePath: string): Promise<CalyxDaemonDescriptor | undefined> {
  try {
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text) as CalyxDaemonDescriptor;
  } catch (error) {
    const typed = error as NodeJS.ErrnoException;
    if (typed.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

async function withDescriptorWriteLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  processAlive: (pid: number) => boolean = isProcessAlive,
): Promise<T> {
  const lockPath = `${filePath}.write-lock`;
  const lock = await acquireCooperativeFileLock({
    lockPath,
    isProcessAlive: processAlive,
    timeoutMessage: `Timed out acquiring daemon descriptor write lock: ${lockPath}`,
  });
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
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

export function detectSupervisorKind(
  env: NodeJS.ProcessEnv = process.env,
  platformName: NodeJS.Platform = process.platform,
): "direct" | "systemd" | "launchd" {
  if (
    platformName === "darwin"
    && (
      (typeof env["XPC_SERVICE_NAME"] === "string" && env["XPC_SERVICE_NAME"].trim().length > 0)
      || (typeof env["__CFBundleIdentifier"] === "string" && env["__CFBundleIdentifier"].trim().length > 0)
    )
  ) {
    return "launchd";
  }
  return typeof env["INVOCATION_ID"] === "string" && env["INVOCATION_ID"].trim().length > 0 ? "systemd" : "direct";
}

function defaultLaunchdLabel(daemonId: string): string {
  const trimmed = daemonId.trim();
  return trimmed.includes(".") ? trimmed : `${DEFAULT_LAUNCHD_LABEL_PREFIX}${trimmed}`;
}

function resolveLaunchdLabel(daemonId: string, env: NodeJS.ProcessEnv): string {
  const fromEnv = env["XPC_SERVICE_NAME"]?.trim() || env["__CFBundleIdentifier"]?.trim() || env["LAUNCH_JOB_LABEL"]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : defaultLaunchdLabel(daemonId);
}

function resolveLaunchAgentPath(
  label: string,
  options: DetectSupervisorOptions = {},
): string | undefined {
  const targetPath = path.resolve(options.homeDir ?? homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const pathExists = options.pathExists ?? existsSync;
  return pathExists(targetPath) ? targetPath : undefined;
}

export function detectSupervisor(
  daemonId: string,
  env: NodeJS.ProcessEnv = process.env,
  platformName: NodeJS.Platform = process.platform,
  options: DetectSupervisorOptions = {},
): CalyxDaemonDescriptor["supervisor"] {
  const kind = detectSupervisorKind(env, platformName);
  if (kind === "launchd") {
    const label = resolveLaunchdLabel(daemonId, env);
    const plistPath = resolveLaunchAgentPath(label, options);
    if (plistPath) {
      return {
        kind,
        label,
        plistPath,
      };
    }
    return {
      kind: "direct",
      stop_grace_ms: DEFAULT_DIRECT_STOP_GRACE_MS,
    };
  }
  if (kind === "systemd") {
    const unitName = env["CALYX_SYSTEMD_UNIT"]?.trim() || env["SYSTEMD_UNIT"]?.trim() || daemonId;
    return {
      kind,
      unit_name: unitName,
    };
  }
  return {
    kind,
    stop_grace_ms: DEFAULT_DIRECT_STOP_GRACE_MS,
  };
}

export async function writeDescriptor(
  descriptor: CalyxDaemonDescriptor,
  options: DaemonRegistryOptions = {},
): Promise<string> {
  const root = resolveRegistryRoot(options.root);
  const targetPath = descriptorPath(root, descriptor.daemon_id);
  await withDescriptorWriteLock(targetPath, async () => {
    if (options.expectedDescriptor) {
      const current = await readDescriptorFile(targetPath);
      if (!current || !isDeepStrictEqual(current, options.expectedDescriptor)) {
        throw new Error(
          `Daemon descriptor ${descriptor.daemon_id} changed before compare-and-swap publication.`,
        );
      }
    }
    await writeJsonFile(targetPath, descriptor);
  }, options.isProcessAlive);
  return targetPath;
}

export async function readDescriptor(
  daemonId: string,
  options: DaemonRegistryOptions = {},
): Promise<CalyxDaemonDescriptor | undefined> {
  const root = resolveRegistryRoot(options.root);
  return readDescriptorFile(descriptorPath(root, daemonId));
}

export async function listDescriptors(options: DaemonRegistryOptions = {}): Promise<CalyxDaemonDescriptor[]> {
  const root = resolveRegistryRoot(options.root);
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const descriptors: CalyxDaemonDescriptor[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const descriptor = await readDescriptorFile(descriptorPath(root, entry.name));
    if (descriptor) {
      descriptors.push(descriptor);
    }
  }

  return descriptors;
}

export async function removeDescriptor(daemonId: string, options: DaemonRegistryOptions = {}): Promise<void> {
  const root = resolveRegistryRoot(options.root);
  const targetPath = descriptorPath(root, daemonId);
  await withDescriptorWriteLock(
    targetPath,
    () => rm(targetPath, { force: true }),
    options.isProcessAlive,
  );
}

export async function removeDescriptorForPid(
  daemonId: string,
  pid: number,
  options: DaemonRegistryOptions = {},
): Promise<boolean> {
  const root = resolveRegistryRoot(options.root);
  const targetPath = descriptorPath(root, daemonId);
  return withDescriptorWriteLock(targetPath, async () => {
    const descriptor = await readDescriptorFile(targetPath);
    if (!descriptor || descriptor.pid !== pid) {
      return false;
    }
    await rm(targetPath, { force: true });
    return true;
  }, options.isProcessAlive);
}

export async function pruneStaleDescriptors(options: DaemonRegistryOptions = {}): Promise<string[]> {
  const root = resolveRegistryRoot(options.root);
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const alive = options.isProcessAlive ?? isProcessAlive;
  const pruned: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const targetPath = descriptorPath(root, entry.name);
    const removed = await withDescriptorWriteLock(targetPath, async () => {
      const descriptor = await readDescriptorFile(targetPath);
      if (!descriptor || alive(descriptor.pid)) {
        return undefined;
      }
      await rm(targetPath, { force: true });
      return descriptor.daemon_id;
    }, alive);
    if (removed) pruned.push(removed);
  }

  return pruned;
}
