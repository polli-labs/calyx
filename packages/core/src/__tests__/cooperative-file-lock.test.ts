import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CooperativeFileLockError,
  acquireCooperativeFileLock,
} from "../cooperative-file-lock.js";

interface ChildLockMessage {
  ownerToken?: string;
  pid?: number;
  result?: { status: string };
  type: "acquired" | "error" | "released";
  error?: string;
}

function waitForChildMessage(
  child: ChildProcess,
  expectedType: ChildLockMessage["type"],
): Promise<ChildLockMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: ChildLockMessage): void => {
      if (message.type !== expectedType && message.type !== "error") return;
      cleanup();
      if (message.type === "error") {
        reject(new Error(message.error ?? "child lock fixture failed"));
        return;
      }
      resolve(message);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`child lock fixture exited before ${expectedType} (code ${code ?? "signal"})`));
    };
    const cleanup = (): void => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

async function readOwner(lockPath: string): Promise<{ ownerToken: string; pid: number }> {
  const entries = await readdir(lockPath);
  expect(entries).toHaveLength(1);
  const ownerToken = entries[0]!;
  const record = JSON.parse(await readFile(path.join(lockPath, ownerToken), "utf8")) as {
    schema_version: string;
    pid: number;
  };
  expect(record.schema_version).toBe("calyx.cooperative-file-lock/v2");
  return {
    ownerToken,
    pid: record.pid,
  };
}

describe("cooperative token-sentinel directory lock ownership", () => {
  let root: string;
  let lockPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "calyx-cooperative-lock-"));
    lockPath = path.join(root, "writer.lock");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("atomic acquisition cannot replace a valid nonempty owner directory", async () => {
    const holder = await acquireCooperativeFileLock({
      lockPath,
      pid: 101,
      isProcessAlive: () => true,
    });

    await expect(acquireCooperativeFileLock({
      lockPath,
      pid: 202,
      timeoutMs: 10,
      retryDelayMs: 1,
      isProcessAlive: () => true,
    })).rejects.toMatchObject({
      code: "timeout",
    } satisfies Partial<CooperativeFileLockError>);
    await expect(readOwner(lockPath)).resolves.toEqual({
      ownerToken: holder.ownerToken,
      pid: 101,
    });
    await expect(holder.release()).resolves.toEqual({ status: "released" });
  });

  test("legacy file-lock shapes fail typed without deleting their bytes", async () => {
    await writeFile(lockPath, "101\n", "utf8");
    await expect(acquireCooperativeFileLock({
      lockPath,
      timeoutMs: 10,
    })).rejects.toMatchObject({
      code: "invalid_lock",
    } satisfies Partial<CooperativeFileLockError>);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("101\n");
  });

  test("an old same-pid holder cannot remove a successor token directory", async () => {
    const oldHolder = await acquireCooperativeFileLock({
      lockPath,
      pid: 303,
      isProcessAlive: () => true,
    });
    await unlink(path.join(lockPath, oldHolder.ownerToken));
    await rmdir(lockPath);

    const successor = await acquireCooperativeFileLock({
      lockPath,
      pid: 303,
      isProcessAlive: () => true,
    });
    await expect(oldHolder.release()).resolves.toEqual({ status: "ownership_lost" });
    await expect(readOwner(lockPath)).resolves.toEqual({
      ownerToken: successor.ownerToken,
      pid: 303,
    });
    await expect(successor.release()).resolves.toEqual({ status: "released" });
  });

  test("only one stale breaker removes the sentinel and its delayed rmdir cannot remove the winner", async () => {
    const staleHolder = await acquireCooperativeFileLock({
      lockPath,
      pid: 101,
      isProcessAlive: () => true,
    });

    let releaseBreaker!: () => void;
    const breakerMayContinue = new Promise<void>((resolve) => {
      releaseBreaker = resolve;
    });
    let breakerReachedGap!: () => void;
    const breakerDidUnlinkSentinel = new Promise<void>((resolve) => {
      breakerReachedGap = resolve;
    });

    const delayedBreaker = acquireCooperativeFileLock({
      lockPath,
      pid: 201,
      timeoutMs: 50,
      retryDelayMs: 1,
      isProcessAlive: (pid) => pid !== 101,
      testHooks: {
        afterSentinelUnlink: async ({ purpose }) => {
          if (purpose !== "stale_break") return;
          breakerReachedGap();
          await breakerMayContinue;
        },
      },
    });
    await breakerDidUnlinkSentinel;

    // The now-empty lock directory is the only shape rename may replace. The
    // winner installs its nonempty sentinel before the delayed breaker rmdir.
    const winner = await acquireCooperativeFileLock({
      lockPath,
      pid: 202,
      timeoutMs: 50,
      retryDelayMs: 1,
      isProcessAlive: () => true,
    });
    releaseBreaker();

    await expect(delayedBreaker).rejects.toMatchObject({
      code: "timeout",
    } satisfies Partial<CooperativeFileLockError>);
    await expect(readOwner(lockPath)).resolves.toEqual({
      ownerToken: winner.ownerToken,
      pid: 202,
    });
    await expect(staleHolder.release()).resolves.toEqual({ status: "ownership_lost" });
    await expect(winner.release()).resolves.toEqual({ status: "released" });
  });

  test("a real child-process old holder cannot unlink the parent successor", async () => {
    const fixturePath = fileURLToPath(
      new URL("./fixtures/cooperative-file-lock-child.mjs", import.meta.url),
    );
    const child = fork(fixturePath, [lockPath], {
      execArgv: ["--experimental-strip-types"],
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });

    try {
      const acquired = await waitForChildMessage(child, "acquired");
      expect(acquired.ownerToken).toBeTypeOf("string");
      expect(acquired.pid).toBe(child.pid);
      await unlink(path.join(lockPath, acquired.ownerToken!));
      await rmdir(lockPath);

      const successor = await acquireCooperativeFileLock({ lockPath });
      const releasedMessage = waitForChildMessage(child, "released");
      child.send({ type: "release" });
      const released = await releasedMessage;
      expect(released.result).toEqual({ status: "ownership_lost" });
      await expect(readOwner(lockPath)).resolves.toEqual({
        ownerToken: successor.ownerToken,
        pid: process.pid,
      });
      await expect(successor.release()).resolves.toEqual({ status: "released" });
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});
