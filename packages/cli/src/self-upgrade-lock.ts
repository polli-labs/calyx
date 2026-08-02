import { mkdir, open, readFile, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export interface SelfUpgradeLockHandle {
  lockPath: string;
  release: () => Promise<void>;
}

export function defaultSelfUpgradeLockPath(home = homedir()): string {
  return path.join(home, ".calyx", "self-upgrade.lock");
}

export async function acquireSelfUpgradeLock(args: {
  lockPath?: string;
  payload: {
    pid: number;
    acquired_at: string;
  };
}): Promise<SelfUpgradeLockHandle> {
  const lockPath = path.resolve(args.lockPath ?? defaultSelfUpgradeLockPath());
  await mkdir(path.dirname(lockPath), { recursive: true });
  let fileHandle;
  try {
    fileHandle = await open(lockPath, "wx");
  } catch (error) {
    const typed = error as NodeJS.ErrnoException;
    if (typed.code !== "EEXIST") {
      throw error;
    }
    const existing = await readFile(lockPath, "utf8").catch(() => "");
    const detail = existing.trim().length > 0 ? ` Existing lock payload: ${existing.trim()}` : "";
    throw new Error(`Self-upgrade lock is already held at ${lockPath}.${detail}`);
  }

  await fileHandle.writeFile(`${JSON.stringify(args.payload, null, 2)}\n`, "utf8");
  let released = false;
  const cleanupSync = (): void => {
    if (released) {
      return;
    }
    released = true;
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // Best effort during fatal process teardown.
    }
  };

  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const uncaughtHandler = (err: unknown): void => {
    cleanupSync();
    // Node only prints + exits when there are no uncaughtException listeners.
    // Our handler registers one, so we must surface the error and exit 1
    // ourselves — otherwise the process silently continues in an indeterminate
    // state after a crash during `self upgrade`.
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  };

  process.once("exit", cleanupSync);
  process.once("uncaughtException", uncaughtHandler);
  for (const signal of SIGNALS) {
    const handler = (): void => {
      cleanupSync();
      process.exitCode = 1;
      process.kill(process.pid, signal);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  return {
    lockPath,
    release: async (): Promise<void> => {
      if (released) {
        return;
      }
      released = true;
      process.removeListener("exit", cleanupSync);
      process.removeListener("uncaughtException", uncaughtHandler);
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
      await fileHandle.close().catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
    },
  };
}
