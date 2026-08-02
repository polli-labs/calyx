import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { loadStateDriver, type StateDriverDatabase } from "./driver";

const inProcessMutexChains = new Map<string, Promise<void>>();

export interface SqliteMutexOptions {
  /** Maximum wall-clock time spent waiting for a different process; `null` waits until ownership is available. */
  acquireTimeoutMs?: number | null | undefined;
  /** Delay between non-blocking BEGIN IMMEDIATE attempts. */
  retryIntervalMs?: number | undefined;
  /**
   * Serialize callers in this process before competing for SQLite's writer
   * lock. Disable only for operations whose contract is explicitly fail-fast.
   */
  queueInProcess?: boolean | undefined;
}

export interface SqliteBusyRetryOptions {
  /** Maximum wall-clock time spent retrying lock contention. */
  timeoutMs?: number | undefined;
  /** Delay between whole-operation retry attempts. */
  retryIntervalMs?: number | undefined;
}

export class SqliteMutexBusyError extends Error {
  readonly code = "sqlite_mutex_busy";
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`SQLite mutex is already owned: ${lockPath}`);
    this.name = "SqliteMutexBusyError";
    this.lockPath = lockPath;
  }
}

export function isSqliteBusyError(error: unknown): boolean {
  const candidate = error as { code?: unknown; errcode?: unknown; message?: unknown };
  return candidate?.errcode === 5
    || candidate?.code === "SQLITE_BUSY"
    || candidate?.code === "SQLITE_BUSY_SNAPSHOT"
    || (typeof candidate?.message === "string"
      && candidate.message.toLowerCase().includes("database is locked"));
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

async function acquireDatabase(
  lockPath: string,
  acquireTimeoutMs: number | null,
  retryIntervalMs: number,
): Promise<StateDriverDatabase> {
  const driver = await loadStateDriver();
  const deadline = acquireTimeoutMs === null ? null : Date.now() + acquireTimeoutMs;

  while (true) {
    const db = driver.open(lockPath);
    try {
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("BEGIN IMMEDIATE");
      return db;
    } catch (error) {
      db.close();
      if (!isSqliteBusyError(error)) throw error;
      if (deadline === null) {
        await delay(Math.max(1, retryIntervalMs));
        continue;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new SqliteMutexBusyError(lockPath);
      await delay(Math.min(Math.max(1, retryIntervalMs), remainingMs));
    }
  }
}

/**
 * Retry one complete SQLite operation after transient writer contention.
 *
 * `busy_timeout` waits for an existing writer, but it cannot repair every WAL
 * snapshot-upgrade conflict. Retrying the complete transaction on an async
 * timer gives the caller a fresh snapshot without blocking the Node event
 * loop between attempts.
 */
export async function withSqliteBusyRetry<T>(
  fn: () => Promise<T>,
  options: SqliteBusyRetryOptions = {},
): Promise<T> {
  const timeoutMs = normalizeNonNegativeInteger(options.timeoutMs, 15_000);
  const retryIntervalMs = normalizeNonNegativeInteger(options.retryIntervalMs, 25);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw error;
      await delay(Math.min(Math.max(1, retryIntervalMs), remainingMs));
    }
  }
}

/**
 * Hold a process- and host-local mutex across an async critical section.
 *
 * SQLite's synchronous busy handler would block the Node event loop, so every
 * cross-process attempt is fail-fast and retries on an async timer instead.
 * The open transaction owns no application rows: its writer lock is the mutex.
 */
export async function withSqliteMutex<T>(
  requestedLockPath: string,
  fn: () => Promise<T>,
  options: SqliteMutexOptions = {},
): Promise<T> {
  const lockPath = resolve(requestedLockPath);
  const acquireTimeoutMs = options.acquireTimeoutMs === null
    ? null
    : normalizeNonNegativeInteger(options.acquireTimeoutMs, 5_000);
  const retryIntervalMs = normalizeNonNegativeInteger(options.retryIntervalMs, 25);
  const queueInProcess = options.queueInProcess ?? true;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

  let releaseTurn: (() => void) | undefined;
  let chain: Promise<void> | undefined;
  if (queueInProcess) {
    const previous = inProcessMutexChains.get(lockPath) ?? Promise.resolve();
    const current = new Promise<void>((resolveCurrent) => {
      releaseTurn = resolveCurrent;
    });
    chain = previous.then(() => current);
    inProcessMutexChains.set(lockPath, chain);
    await previous;
  }

  let db: StateDriverDatabase | undefined;
  try {
    db = await acquireDatabase(lockPath, acquireTimeoutMs, retryIntervalMs);
    return await fn();
  } finally {
    if (db) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Closing the handle releases the OS lock even if rollback cleanup fails.
      }
      try {
        db.close();
      } catch {
        // There is no useful recovery after rollback; always unblock waiters.
      }
    }
    releaseTurn?.();
    if (chain && inProcessMutexChains.get(lockPath) === chain) {
      inProcessMutexChains.delete(lockPath);
    }
  }
}
