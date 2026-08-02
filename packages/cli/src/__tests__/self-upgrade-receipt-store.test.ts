import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  SELF_UPGRADE_RECEIPT_MAX_BYTES,
  writeSelfUpgradeReceiptDurable,
} from "../self-upgrade-receipt-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-receipt-store-"));
  roots.push(home);
  return path.join(home, ".calyx", "self-upgrade-receipts");
}

function receipt(status: "succeeded" | "failed", marker: string): string {
  return `${JSON.stringify({
    schema_version: "self-upgrade-receipt/v1",
    status,
    marker,
  }, null, 2)}\n`;
}

describe("host self-upgrade receipt store", () => {
  test("atomically replaces private receipt authority and leaves no temporary residue", async () => {
    const root = await makeRoot();
    const target = await writeSelfUpgradeReceiptDurable(root, "self-upgrade-operation-a", receipt("succeeded", "first"));
    await writeSelfUpgradeReceiptDurable(root, "self-upgrade-operation-a", receipt("succeeded", "replacement"));

    expect((await stat(path.dirname(root))).mode & 0o777).toBe(0o700);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(["self-upgrade-operation-a.json"]);
    await expect(readFile(target, "utf8")).resolves.toContain("replacement");
  });

  test("sweeps stale temps and retains the current receipt within the count bound", async () => {
    const root = await makeRoot();
    const first = await writeSelfUpgradeReceiptDurable(root, "self-upgrade-operation-a", receipt("succeeded", "a"));
    await utimes(first, new Date(1_000), new Date(1_000));
    const second = await writeSelfUpgradeReceiptDurable(root, "self-upgrade-operation-b", receipt("failed", "b"));
    await utimes(second, new Date(2_000), new Date(2_000));
    const staleTemp = path.join(root, "abandoned.json.writer.tmp");
    await writeFile(staleTemp, "partial", "utf8");
    await utimes(staleTemp, new Date(0), new Date(0));

    await writeSelfUpgradeReceiptDurable(
      root,
      "self-upgrade-operation-c",
      receipt("succeeded", "c"),
      {
        nowMs: 10_000,
        staleTempMs: 1_000,
        retentionMs: 100_000,
        retentionCount: 2,
      },
    );

    expect((await readdir(root)).sort()).toEqual([
      "self-upgrade-operation-b.json",
      "self-upgrade-operation-c.json",
    ]);
  });

  test("never prunes an oversized otherwise-valid receipt during bounded retention scans", async () => {
    const root = await makeRoot();
    await mkdir(root, { recursive: true });
    const oversized = path.join(root, "self-upgrade-operation-oversized.json");
    await writeFile(oversized, JSON.stringify({
      schema_version: "self-upgrade-receipt/v1",
      status: "succeeded",
      padding: " ".repeat(SELF_UPGRADE_RECEIPT_MAX_BYTES),
    }), "utf8");
    await utimes(oversized, new Date(0), new Date(0));

    await writeSelfUpgradeReceiptDurable(
      root,
      "self-upgrade-operation-current",
      receipt("succeeded", "current"),
      { nowMs: 10_000, retentionMs: 0, retentionCount: 1 },
    );

    await expect(stat(oversized)).resolves.toMatchObject({});
    expect((await readdir(root)).sort()).toEqual([
      "self-upgrade-operation-current.json",
      "self-upgrade-operation-oversized.json",
    ]);
  });

  test("rejects unsafe identities and oversized receipts before creating authority", async () => {
    const root = await makeRoot();
    await expect(writeSelfUpgradeReceiptDurable(root, "../escape", "{}\n"))
      .rejects.toThrow(/Invalid self-upgrade receipt operation id/u);
    await expect(writeSelfUpgradeReceiptDurable(
      root,
      "self-upgrade-operation-large",
      "x".repeat(SELF_UPGRADE_RECEIPT_MAX_BYTES + 1),
    )).rejects.toThrow(/exceeds/u);
  });

  test("rejects a symlinked receipt ancestor without writing into its target", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-receipt-symlink-home-"));
    const redirect = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-receipt-symlink-target-"));
    roots.push(home, redirect);
    const redirectedRoot = path.join(redirect, "self-upgrade-receipts");
    await mkdir(redirectedRoot);
    await symlink(redirect, path.join(home, ".calyx"), "dir");

    await expect(writeSelfUpgradeReceiptDurable(
      path.join(home, ".calyx", "self-upgrade-receipts"),
      "self-upgrade-operation-symlink",
      receipt("succeeded", "redirected"),
    )).rejects.toThrow(/not a real directory/u);
    expect(await readdir(redirectedRoot)).toEqual([]);
  });

  test("rejects a post-validation ancestor swap without following the replacement", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-receipt-swap-home-"));
    const redirect = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-receipt-swap-target-"));
    roots.push(home, redirect);
    const root = path.join(home, ".calyx", "self-upgrade-receipts");
    const redirectedRoot = path.join(redirect, "self-upgrade-receipts");

    await expect(writeSelfUpgradeReceiptDurable(
      root,
      "self-upgrade-operation-swap",
      receipt("succeeded", "redirected"),
      {
        afterRootAnchored: async () => {
          await rename(path.join(home, ".calyx"), path.join(home, ".calyx-held"));
          await mkdir(redirectedRoot);
          await symlink(redirect, path.join(home, ".calyx"), "dir");
        },
      },
    )).rejects.toThrow(/not a real directory|identity changed/u);
    expect(await readdir(redirectedRoot)).toEqual([]);
  });

  test("forced fallback retention cannot delete from an ancestor replacement", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-receipt-fallback-home-"));
    roots.push(home);
    const root = path.join(home, ".calyx", "self-upgrade-receipts");
    await mkdir(root, { recursive: true });
    const oldName = "self-upgrade-operation-old.json";
    await writeFile(path.join(root, oldName), receipt("succeeded", "held-old"), "utf8");
    await utimes(path.join(root, oldName), new Date(0), new Date(0));

    await expect(writeSelfUpgradeReceiptDurable(
      root,
      "self-upgrade-operation-current",
      receipt("succeeded", "current"),
      {
        nowMs: 10_000,
        retentionMs: 0,
        retentionCount: 1,
        directoryOpenOptions: { descriptorPathCandidates: () => [] },
        afterRootValidatedBeforeRetention: async () => {
          await rename(path.join(home, ".calyx"), path.join(home, ".calyx-held"));
          await mkdir(root, { recursive: true });
          await writeFile(path.join(root, oldName), receipt("succeeded", "replacement"), "utf8");
        },
      },
    )).rejects.toThrow(/identity changed/u);

    await expect(readFile(path.join(root, oldName), "utf8")).resolves.toContain("replacement");
    await expect(stat(path.join(home, ".calyx-held", "self-upgrade-receipts", oldName)))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root)).toEqual([oldName]);
  });
});
