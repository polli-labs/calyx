import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

const COOPERATIVE_FILE_LOCK_SCHEMA_VERSION = "calyx.cooperative-file-lock/v2";
const MAX_SENTINEL_BYTES = 4_096n;
const OWNER_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTENTION_ERROR_CODES = new Set(["EEXIST", "EISDIR", "ENOTDIR", "ENOTEMPTY"]);

interface DirectoryIdentity {
  device: bigint;
  inode: bigint;
}

interface ObservedLockOwner {
  kind: "owned";
  directoryIdentity: DirectoryIdentity;
  ownerToken: string;
  pid: number;
}

interface ObservedEmptyLock {
  kind: "empty";
  directoryIdentity: DirectoryIdentity;
}

type ObservedLock = ObservedLockOwner | ObservedEmptyLock;

export type CooperativeFileLockErrorCode =
  | "invalid_lock"
  | "timeout"
  | "unsupported_platform";

export class CooperativeFileLockError extends Error {
  readonly code: CooperativeFileLockErrorCode;

  constructor(code: CooperativeFileLockErrorCode, message: string) {
    super(message);
    this.name = "CooperativeFileLockError";
    this.code = code;
  }
}

export interface CooperativeFileLockTestHooks {
  /**
   * Test-only deterministic race seam. This runs only after this contender
   * atomically removed its exact token sentinel and therefore owns the sole
   * authority to attempt removal of the now-empty lock directory.
   */
  afterSentinelUnlink?: ((observation: {
    owner_token: string;
    pid: number;
    purpose: "release" | "stale_break";
  }) => Promise<void>) | undefined;
}

export interface AcquireCooperativeFileLockOptions {
  lockPath: string;
  timeoutMs?: number | undefined;
  retryDelayMs?: number | undefined;
  timeoutMessage?: string | undefined;
  isProcessAlive?: ((pid: number) => boolean) | undefined;
  pid?: number | undefined;
  sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  testHooks?: CooperativeFileLockTestHooks | undefined;
}

export type CooperativeFileLockReleaseStatus =
  | "released"
  | "already_absent"
  | "already_released"
  | "ownership_lost";

export interface CooperativeFileLockReleaseResult {
  status: CooperativeFileLockReleaseStatus;
}

export interface CooperativeFileLock {
  lockPath: string;
  ownerToken: string;
  pid: number;
  release(): Promise<CooperativeFileLockReleaseResult>;
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function identityFromStats(stats: BigIntStats): DirectoryIdentity {
  return {
    device: stats.dev,
    inode: stats.ino,
  };
}

function sameDirectoryIdentity(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isDirectoryNotEmpty(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

function invalidLock(lockPath: string, detail: string): CooperativeFileLockError {
  return new CooperativeFileLockError(
    "invalid_lock",
    `Invalid cooperative lock at ${lockPath}: ${detail}`,
  );
}

function parseSentinel(
  lockPath: string,
  ownerToken: string,
  text: string,
): number {
  try {
    const parsed = JSON.parse(text.trim()) as {
      schema_version?: unknown;
      pid?: unknown;
    };
    if (
      parsed.schema_version !== COOPERATIVE_FILE_LOCK_SCHEMA_VERSION
      || !Number.isSafeInteger(parsed.pid)
      || (parsed.pid as number) <= 0
    ) {
      throw invalidLock(lockPath, `owner sentinel ${ownerToken} has an invalid record`);
    }
    return parsed.pid as number;
  } catch (error) {
    if (error instanceof CooperativeFileLockError) throw error;
    throw invalidLock(lockPath, `owner sentinel ${ownerToken} is not valid JSON`);
  }
}

async function observeLock(lockPath: string): Promise<ObservedLock | undefined> {
  let before: BigIntStats;
  try {
    before = await lstat(lockPath, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (!before.isDirectory()) {
    throw invalidLock(
      lockPath,
      "expected a token-sentinel directory; legacy file locks require explicit operator cleanup",
    );
  }
  const beforeIdentity = identityFromStats(before);

  let entries;
  try {
    entries = await readdir(lockPath, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }

  let after: BigIntStats;
  try {
    after = await lstat(lockPath, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const afterIdentity = identityFromStats(after);
  if (!after.isDirectory() || !sameDirectoryIdentity(beforeIdentity, afterIdentity)) {
    return undefined;
  }
  if (entries.length === 0) {
    return {
      kind: "empty",
      directoryIdentity: afterIdentity,
    };
  }
  if (entries.length !== 1) {
    throw invalidLock(lockPath, "expected exactly one owner-token sentinel");
  }

  const entry = entries[0]!;
  const ownerToken = entry.name;
  if (!OWNER_TOKEN_PATTERN.test(ownerToken)) {
    throw invalidLock(lockPath, "owner sentinel name is not a cryptographic UUID token");
  }
  const sentinelPath = path.join(lockPath, ownerToken);
  let handle;
  try {
    handle = await open(
      sentinelPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const sentinelBefore = await handle.stat({ bigint: true });
    if (!sentinelBefore.isFile() || sentinelBefore.size > MAX_SENTINEL_BYTES) {
      throw invalidLock(lockPath, `owner sentinel ${ownerToken} is not a bounded regular file`);
    }
    const text = await handle.readFile({ encoding: "utf8" });
    const sentinelAfter = await handle.stat({ bigint: true });
    if (
      sentinelBefore.dev !== sentinelAfter.dev
      || sentinelBefore.ino !== sentinelAfter.ino
    ) {
      return undefined;
    }
    const pid = parseSentinel(lockPath, ownerToken, text);
    const finalDirectory = await lstat(lockPath, { bigint: true }).catch((error) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (
      !finalDirectory?.isDirectory()
      || !sameDirectoryIdentity(identityFromStats(finalDirectory), afterIdentity)
    ) {
      return undefined;
    }
    return {
      kind: "owned",
      directoryIdentity: afterIdentity,
      ownerToken,
      pid,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(
    directoryPath,
    fsConstants.O_RDONLY
      | (fsConstants.O_DIRECTORY ?? 0)
      | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function encodeSentinel(pid: number): string {
  return `${JSON.stringify({
    schema_version: COOPERATIVE_FILE_LOCK_SCHEMA_VERSION,
    pid,
  })}\n`;
}

async function prepareCandidateDirectory(
  lockPath: string,
  pid: number,
  ownerToken: string,
): Promise<{ candidatePath: string; sentinelPath: string }> {
  const parentPath = path.dirname(lockPath);
  const candidatePath = path.join(
    parentPath,
    `.calyx-lock-candidate-${ownerToken}`,
  );
  const sentinelPath = path.join(candidatePath, ownerToken);
  await mkdir(candidatePath, { mode: 0o700 });
  try {
    const sentinel = await open(sentinelPath, "wx", 0o600);
    try {
      await sentinel.writeFile(encodeSentinel(pid), "utf8");
      await sentinel.sync();
    } finally {
      await sentinel.close();
    }
    await syncDirectory(candidatePath);
    await syncDirectory(parentPath);
    return { candidatePath, sentinelPath };
  } catch (error) {
    await cleanCandidateDirectory(candidatePath, sentinelPath);
    throw error;
  }
}

async function cleanCandidateDirectory(
  candidatePath: string,
  sentinelPath: string,
): Promise<void> {
  await unlink(sentinelPath).catch((error) => {
    if (!isMissing(error)) throw error;
  });
  await rmdir(candidatePath).catch((error) => {
    if (!isMissing(error)) throw error;
  });
}

async function lockPathExists(lockPath: string): Promise<boolean> {
  try {
    await lstat(lockPath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function removeOwnedLockDirectory(
  args: {
    lockPath: string;
    ownerToken: string;
    pid: number;
    purpose: "release" | "stale_break";
    testHooks?: CooperativeFileLockTestHooks | undefined;
  },
): Promise<CooperativeFileLockReleaseStatus> {
  const sentinelPath = path.join(args.lockPath, args.ownerToken);
  try {
    // This exact token path is the ownership CAS. If a successor owns
    // lockPath, its different cryptographic sentinel remains untouched.
    await unlink(sentinelPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return await lockPathExists(args.lockPath)
      ? "ownership_lost"
      : "already_absent";
  }

  await args.testHooks?.afterSentinelUnlink?.({
    owner_token: args.ownerToken,
    pid: args.pid,
    purpose: args.purpose,
  });

  try {
    // Only the contender that removed the exact sentinel reaches rmdir. A
    // successor may atomically rename into the now-empty pathname first; its
    // nonempty sentinel makes rmdir fail without deleting the successor.
    await rmdir(args.lockPath);
    return "released";
  } catch (error) {
    if (isMissing(error)) return "already_absent";
    if (isDirectoryNotEmpty(error)) return "ownership_lost";
    throw error;
  }
}

export async function acquireCooperativeFileLock(
  options: AcquireCooperativeFileLockOptions,
): Promise<CooperativeFileLock> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new CooperativeFileLockError(
      "unsupported_platform",
      `Token-sentinel directory locks are unsupported on ${process.platform}; refusing unsafe pathname unlink fallback.`,
    );
  }

  const lockPath = path.resolve(options.lockPath);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryDelayMs = options.retryDelayMs ?? 10;
  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new CooperativeFileLockError(
      "invalid_lock",
      `Cooperative file lock PID must be a positive safe integer: ${pid}`,
    );
  }
  const ownerToken = randomUUID();
  const processAlive = options.isProcessAlive ?? defaultProcessIsAlive;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + timeoutMs;
  await mkdir(path.dirname(lockPath), { recursive: true });
  const candidate = await prepareCandidateDirectory(lockPath, pid, ownerToken);
  let acquired = false;

  try {
    while (!acquired) {
      try {
        // POSIX rename is the acquisition CAS. Linux and macOS refuse to
        // replace a valid nonempty token-sentinel directory.
        await rename(candidate.candidatePath, lockPath);
        acquired = true;
        await syncDirectory(path.dirname(lockPath));
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!code || !CONTENTION_ERROR_CODES.has(code)) throw error;
      }

      const observed = await observeLock(lockPath);
      if (observed?.kind === "owned" && !processAlive(observed.pid)) {
        await removeOwnedLockDirectory({
          lockPath,
          ownerToken: observed.ownerToken,
          pid: observed.pid,
          purpose: "stale_break",
          testHooks: options.testHooks,
        });
      }

      if (Date.now() >= deadline) {
        throw new CooperativeFileLockError(
          "timeout",
          options.timeoutMessage
          ?? `Timed out acquiring cooperative file lock: ${lockPath}`,
        );
      }
      await sleep(retryDelayMs);
    }

    const installed = await observeLock(lockPath);
    if (
      installed?.kind !== "owned"
      || installed.ownerToken !== ownerToken
      || installed.pid !== pid
    ) {
      throw invalidLock(lockPath, "atomic candidate publication did not retain the exact owner sentinel");
    }
  } catch (error) {
    if (acquired) {
      await removeOwnedLockDirectory({
        lockPath,
        ownerToken,
        pid,
        purpose: "release",
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (!acquired) {
      await cleanCandidateDirectory(candidate.candidatePath, candidate.sentinelPath);
    }
  }

  let released = false;
  return {
    lockPath,
    ownerToken,
    pid,
    async release(): Promise<CooperativeFileLockReleaseResult> {
      if (released) return { status: "already_released" };
      released = true;
      return {
        status: await removeOwnedLockDirectory({
          lockPath,
          ownerToken,
          pid,
          purpose: "release",
          testHooks: options.testHooks,
        }),
      };
    },
  };
}
