import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  applyStateMigrations,
  EVENT_LOG_QUARANTINE_SCHEMA_VERSION,
  eventLogQuarantineDir,
  writeEventLogQuarantineRecord,
  type EventLogQuarantineRecord,
} from "../state";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB", "CALYX_RUNS_ROOT"] as const;
let root: string;
let stateDir: string;
let original: Record<string, string | undefined>;

beforeEach(async () => {
  original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  root = await mkdtemp(join(tmpdir(), "calyx-quarantine-durability-"));
  stateDir = join(root, "state");
  process.env["CALYX_STATE_HOME"] = stateDir;
  process.env["CALYX_RUNS_ROOT"] = join(root, "runs");
  await mkdir(join(root, "runs"), { recursive: true });
  await applyStateMigrations();
});

afterEach(async () => {
  for (const [k, v] of Object.entries(original)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
});

function record(): EventLogQuarantineRecord {
  return {
    schema_version: EVENT_LOG_QUARANTINE_SCHEMA_VERSION,
    quarantine_id: "11111111-1111-4111-8111-111111111111",
    event_id: "evt-durability",
    quarantined_at: "2026-07-27T00:00:00.000Z",
    reason: "identity-conflict",
    origin: "ingest",
    host: "blade",
    committed: null,
    incoming: null,
    resolution: "kept-committed",
    divergent_fields: [],
    detail: "durability fixture",
  };
}

describe("quarantine records publish durably (PR #329 review P1)", () => {
  test("a directory-sync failure throws instead of reporting a preserved record", async () => {
    // The rebuild path deletes the displaced committed row immediately after
    // this write, so an unsynced record is the sole copy of a version the
    // repair is about to destroy. Failure must propagate.
    await expect(
      writeEventLogQuarantineRecord(stateDir, record(), {
        syncDirectory: async () => {
          throw new Error("injected directory sync failure");
        },
      }),
    ).rejects.toThrow(/injected directory sync failure/u);

    // No temp residue: a failure before rename must clean up after itself.
    // A record that was renamed into place before the directory sync failed is
    // deliberately left alone — it is not proven crash-durable, but it is real
    // evidence, and deleting it to satisfy a tidiness rule would destroy the
    // very copy this whole path exists to preserve. The throw is what stops the
    // caller treating the repair as complete.
    const dir = eventLogQuarantineDir(stateDir);
    const entries = await readdir(dir).catch(() => [] as string[]);
    expect(entries.filter((e) => e.includes(".tmp."))).toHaveLength(0);
  });

  test("a write/fsync failure before rename leaves nothing behind at all", async () => {
    const dir = eventLogQuarantineDir(stateDir);
    await mkdir(dir, { recursive: true });
    // Make the quarantine dir read-only so the exclusive temp open fails.
    const { chmod } = await import("node:fs/promises");
    await chmod(dir, 0o500);
    try {
      await expect(writeEventLogQuarantineRecord(stateDir, record())).rejects.toThrow();
      const entries = await readdir(dir).catch(() => [] as string[]);
      expect(entries).toHaveLength(0);
    } finally {
      await chmod(dir, 0o700);
    }
  });

  test("the whole directory lineage is synced, on every attempt (review r2 P1)", async () => {
    // The leaf sync alone left `<stateDir>/quarantine` and `<stateDir>` entries
    // unsynced, so a crash could lose the subtree the record lives in — after
    // rebuild had already deleted the displaced row.
    const first: string[] = [];
    await writeEventLogQuarantineRecord(stateDir, record(), {
      syncDirectory: async (d) => { first.push(d); },
    });
    expect(first).toEqual([
      eventLogQuarantineDir(stateDir),
      join(stateDir, "quarantine"),
      stateDir,
    ]);

    // Second write, directories already present: the lineage must still be
    // synced, because a retry cannot know the earlier fsync completed.
    const second: string[] = [];
    await writeEventLogQuarantineRecord(
      stateDir,
      { ...record(), quarantine_id: "22222222-2222-4222-8222-222222222222" },
      { syncDirectory: async (d) => { second.push(d); } },
    );
    expect(second).toEqual(first);
  });

  test("a parent-directory sync failure throws", async () => {
    const leaf = eventLogQuarantineDir(stateDir);
    await expect(
      writeEventLogQuarantineRecord(stateDir, record(), {
        syncDirectory: async (d) => {
          if (d !== leaf) throw new Error("injected parent sync failure");
        },
      }),
    ).rejects.toThrow(/injected parent sync failure/u);
  });

  test("a successful publish leaves exactly one record and no temp residue", async () => {
    const synced: string[] = [];
    const path = await writeEventLogQuarantineRecord(stateDir, record(), {
      syncDirectory: async (d) => { synced.push(d); },
    });
    expect(path).toContain("evt-durability");
    expect(synced).toContain(eventLogQuarantineDir(stateDir));
    const entries = await readdir(eventLogQuarantineDir(stateDir));
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain(".tmp.");
  });
});
