import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  openChildDirectoryDurable,
  openExistingDirectoryDurable,
  openPrivateDirectoryDurable,
} from "../durable-directory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable directory anchors", () => {
  test("accepts the platform temporary-directory ancestry and holds its physical target", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "calyx-durable-normal-"));
    roots.push(home);
    const target = path.join(home, "managed", "receipts");
    const anchor = await openPrivateDirectoryDurable(target, 0o700);

    try {
      if (process.platform === "linux") {
        expect(anchor.descriptorBacked).toBe(true);
        expect(anchor.anchoredDirectory).toMatch(/^\/proc\/self\/fd\/\d+$/u);
      }
      await expect(anchor.assertCanonical()).resolves.toBeUndefined();
      expect(path.basename(anchor.directory)).toBe("receipts");
    } finally {
      await anchor.close();
    }
  });

  test("falls back to held-cwd authority when descriptor child traversal is unavailable", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "calyx-durable-fallback-"));
    roots.push(home);
    const target = path.join(home, "managed", "receipts");
    const anchor = await openPrivateDirectoryDurable(target, 0o700, {
      descriptorPathCandidates: () => [],
    });

    try {
      expect(anchor.descriptorBacked).toBe(false);
      expect(anchor.anchoredDirectory).toBeUndefined();
      await anchor.assertCanonical();
      await anchor.authority.replaceFile(
        "receipt.json",
        "receipt.json.writer.tmp",
        "receipt\n",
        0o600,
      );
      await anchor.assertCanonical();
      await expect(readFile(path.join(anchor.directory, "receipt.json"), "utf8"))
        .resolves.toBe("receipt\n");
    } finally {
      await anchor.close();
    }
  });

  test("selects held-cwd authority when a nominal descriptor path cannot traverse named children", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "calyx-durable-probe-fallback-"));
    roots.push(home);
    const target = path.join(home, "managed", "receipts");
    const probedCandidates: string[] = [];
    const anchor = await openPrivateDirectoryDurable(target, 0o700, {
      descriptorChildTraversalProbe: async (candidate) => {
        probedCandidates.push(candidate);
        return false;
      },
    });

    try {
      expect(probedCandidates.length).toBeGreaterThan(0);
      expect(anchor.descriptorBacked).toBe(false);
      expect(anchor.anchoredDirectory).toBeUndefined();
      await anchor.authority.writeFileExclusive("probe.json", "held\n", 0o600);
      await expect(readFile(path.join(target, "probe.json"), "utf8")).resolves.toBe("held\n");
    } finally {
      await anchor.close();
    }
  });

  test.each([
    ["descriptor path", false],
    ["held-cwd fallback", true],
  ] as const)("rolls back a failed exclusive create through the %s authority", async (_label, fallback) => {
    const home = await mkdtemp(path.join(tmpdir(), "calyx-durable-exclusive-rollback-"));
    roots.push(home);
    const target = path.join(home, "receipts");
    await mkdir(target);
    let injectFailure = true;
    const anchor = await openExistingDirectoryDurable(target, {
      ...(fallback
        ? { descriptorPathCandidates: () => [] }
        : { descriptorChildTraversalProbe: async () => true }),
      afterExclusiveFileCreated: async () => {
        if (injectFailure) throw new Error("injected post-create write failure");
      },
    });

    try {
      expect(anchor.descriptorBacked).toBe(!fallback);
      await expect(anchor.authority.writeFileExclusive("owner.json", "partial\n", 0o600))
        .rejects.toThrow("injected post-create write failure");
      expect(await readdir(target)).toEqual([]);

      injectFailure = false;
      await anchor.authority.writeFileExclusive("owner.json", "complete\n", 0o600);
      await expect(readFile(path.join(target, "owner.json"), "utf8")).resolves.toBe("complete\n");
    } finally {
      await anchor.close();
    }
  });

  test("rejects multi-segment child paths instead of extending no-follow authority", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "calyx-durable-nested-path-"));
    roots.push(home);
    const target = path.join(home, "receipts");
    await mkdir(path.join(target, "nested"), { recursive: true });
    await writeFile(path.join(target, "nested", "receipt.json"), "nested\n", "utf8");
    const anchor = await openExistingDirectoryDurable(target);

    try {
      await expect(anchor.authority.readFile(path.join("nested", "receipt.json")))
        .rejects.toMatchObject({ code: "EINVAL" });
    } finally {
      await anchor.close();
    }
  });

  test("rejects every authority operation after close", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "calyx-durable-closed-"));
    roots.push(home);
    const target = path.join(home, "receipts");
    await mkdir(target);
    await writeFile(path.join(target, "receipt.json"), "held\n", "utf8");
    const anchor = await openExistingDirectoryDurable(target);
    const authority = anchor.authority;

    await anchor.close();

    await expect(authority.readFile("receipt.json")).rejects.toMatchObject({ code: "EBADF" });
    await expect(authority.readdir()).rejects.toMatchObject({ code: "EBADF" });
    await expect(authority.writeFileExclusive("late.json", "late\n", 0o600))
      .rejects.toMatchObject({ code: "EBADF" });
    expect(await readdir(target)).toEqual(["receipt.json"]);
  });

  test.each([
    ["descriptor path", false],
    ["held-cwd fallback", true],
  ] as const)("holds %s authority resources until an already-started operation settles", async (_label, fallback) => {
    const home = await mkdtemp(path.join(tmpdir(), "calyx-durable-close-race-"));
    roots.push(home);
    const target = path.join(home, "receipts");
    await mkdir(target);
    await writeFile(path.join(target, "receipt.json"), "held\n", "utf8");
    let markOperationStarted!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      markOperationStarted = resolve;
    });
    let releaseOperation!: () => void;
    const operationRelease = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const anchor = await openExistingDirectoryDurable(target, {
      ...(fallback
        ? { descriptorPathCandidates: () => [] }
        : { descriptorChildTraversalProbe: async () => true }),
      authorityOperationGate: async () => {
        markOperationStarted();
        await operationRelease;
      },
    });
    const authority = anchor.authority;
    const anchoredDirectory = anchor.anchoredDirectory;
    expect(anchor.descriptorBacked).toBe(!fallback);

    const startedRead = authority.readFile("receipt.json");
    await operationStarted;
    await anchor.close();

    try {
      await expect(authority.readFile("receipt.json")).rejects.toMatchObject({ code: "EBADF" });
      if (anchoredDirectory) {
        await expect(readFile(path.join(anchoredDirectory, "receipt.json"), "utf8"))
          .resolves.toBe("held\n");
      }
      releaseOperation();
      await expect(startedRead).resolves.toBe("held\n");
    } finally {
      releaseOperation();
      await startedRead.catch(() => undefined);
      await anchor.close();
    }
  });

  test("keeps forced-fallback mutation on the held cwd after an ancestor replacement", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "calyx-durable-fallback-swap-"));
    roots.push(home);
    const target = path.join(home, "managed", "receipts");
    const heldParent = path.join(home, "managed-held");
    const anchor = await openPrivateDirectoryDurable(target, 0o700, {
      descriptorPathCandidates: () => [],
    });

    try {
      await rename(path.join(home, "managed"), heldParent);
      await mkdir(target, { recursive: true, mode: 0o700 });
      await anchor.authority.replaceFile(
        "receipt.json",
        "receipt.json.writer.tmp",
        "held\n",
        0o600,
      );

      await expect(anchor.assertCanonical()).rejects.toThrow(/identity changed/u);
      await expect(anchor.authority.readFile("receipt.json", 5)).resolves.toBe("held\n");
      await expect(anchor.authority.readFile("receipt.json", 4)).rejects.toMatchObject({
        code: "EFBIG",
      });
      expect(await readdir(target)).toEqual([]);
      await expect(readFile(path.join(heldParent, "receipts", "receipt.json"), "utf8"))
        .resolves.toBe("held\n");
    } finally {
      await anchor.close();
    }
  });

  test("rejects symlinks inside the managed ancestry", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "calyx-durable-symlink-"));
    const outside = await mkdtemp(path.join(tmpdir(), "calyx-durable-outside-"));
    roots.push(home, outside);
    await symlink(outside, path.join(home, "managed"), "dir");

    await expect(openPrivateDirectoryDurable(path.join(home, "managed", "receipts"), 0o700))
      .rejects.toThrow(/not a real directory/u);
  });

  test("keeps child I/O on the held descriptor and rejects a replacement path", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "calyx-durable-child-swap-"));
    roots.push(home);
    const parentPath = path.join(home, ".calyx", "self-upgrade-receipts");
    const parent = await openPrivateDirectoryDurable(parentPath, 0o700);
    await parent.authority.mkdir("fleet-operation", 0o700);
    await parent.sync();
    const child = await openChildDirectoryDurable(parent, "fleet-operation");
    const heldPath = path.join(parentPath, "fleet-operation-held");

    try {
      await rename(child.directory, heldPath);
      await mkdir(child.directory, { mode: 0o700 });
      await child.authority.replaceFile(
        "summary.json",
        "summary.json.writer.tmp",
        "held\n",
        0o600,
      );

      await expect(child.assertCanonical()).rejects.toThrow(/identity changed/u);
      expect(await readdir(child.directory)).toEqual([]);
      await expect(readFile(path.join(heldPath, "summary.json"), "utf8")).resolves.toBe("held\n");
    } finally {
      await child.close().catch(() => undefined);
      await parent.close().catch(() => undefined);
    }
  });

  test("exercises held-cwd fallback for a child anchor", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "calyx-durable-child-fallback-"));
    roots.push(home);
    const parent = await openPrivateDirectoryDurable(
      path.join(home, ".calyx", "self-upgrade-receipts"),
      0o700,
    );
    await parent.authority.mkdir("fleet-operation", 0o700);
    await parent.sync();
    const child = await openChildDirectoryDurable(parent, "fleet-operation", {
      descriptorPathCandidates: () => [],
    });

    try {
      expect(child.descriptorBacked).toBe(false);
      expect(child.anchoredDirectory).toBeUndefined();
      await child.assertCanonical();
      await child.authority.replaceFile(
        "summary.json",
        "summary.json.writer.tmp",
        "fallback\n",
        0o600,
      );
      await child.assertCanonical();
      await expect(readFile(path.join(child.directory, "summary.json"), "utf8"))
        .resolves.toBe("fallback\n");
    } finally {
      await child.close();
      await parent.close();
    }
  });
});
