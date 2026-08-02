import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { acquireSelfUpgradeLock } from "../self-upgrade-lock";

describe("self-upgrade lock", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "calyx-self-upgrade-lock-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("prevents concurrent acquisitions", async () => {
    const lockPath = path.join(root, "self-upgrade.lock");
    const first = await acquireSelfUpgradeLock({
      lockPath,
      payload: {
        pid: 111,
        acquired_at: "2026-04-20T00:00:00.000Z",
      },
    });

    await expect(
      acquireSelfUpgradeLock({
        lockPath,
        payload: {
          pid: 222,
          acquired_at: "2026-04-20T00:00:01.000Z",
        },
      }),
    ).rejects.toThrow("Self-upgrade lock is already held");

    await first.release();
  });
});
