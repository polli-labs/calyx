import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  applyStateMigrations,
  consolidateSkillContent,
  ConsolidationAborted,
  listSkillContent,
  openStateStore,
  readSkillContent,
  setPinned,
  skillWriteLogHighWater,
  upsertSkillContent,
} from "../state";
import type { StateDriverDatabase } from "../state";
import {
  applyCuratorReport,
  detectDuplicateCandidates,
  gatherCuratorDbSkills,
  rollbackCuratorPass,
  type CuratorRegistryInput,
} from "../skills-curator";
import type { SkillLifecycleStatus, SkillUsageBackendStatus, SkillUsageResult } from "../types";
import { resolveSkillInstallDir } from "../skills-install";

const HOST = "testhost";

/**
 * Curator APPLY mechanics (POL-1729 Slice 3). SAFETY rule 2: every test
 * sandboxes the install mirrors (HOME + CODEX_HOME) and the state DB
 * (CALYX_STATE_HOME) to a mkdtemp root in beforeEach and restores in afterEach,
 * reusing the Slice-1/2 pattern. The re-materializer is NEVER run against the
 * real HOME. Loki usage is ALWAYS mocked (a constructed result object) — no
 * network.
 */
describe("curator apply mechanics (POL-1729 Slice 3)", () => {
  let workRoot: string;
  let sandboxHome: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      HOME: process.env["HOME"],
      CODEX_HOME: process.env["CODEX_HOME"],
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    workRoot = await mkdtemp(path.join(tmpdir(), "calyx-curator-apply-"));
    sandboxHome = path.join(workRoot, "home");
    await mkdir(sandboxHome, { recursive: true });
    process.env["HOME"] = sandboxHome;
    process.env["CODEX_HOME"] = path.join(sandboxHome, ".codex");
    delete process.env["CALYX_STATE_DB"];
    process.env["CALYX_STATE_HOME"] = path.join(workRoot, "state");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(workRoot, { recursive: true, force: true });
  });

  async function withDb<T>(fn: (db: StateDriverDatabase) => Promise<T> | T): Promise<T> {
    const opened = await openStateStore();
    try {
      return await fn(opened.db);
    } finally {
      opened.db.close();
    }
  }

  function skillMd(title: string, description: string, body = "hello body"): string {
    return `---\ntitle: ${title}\ndescription: ${description}\n---\n# ${title}\n\n${body}\n`;
  }

  /** Mock Loki usage result (NEVER hits the network). */
  function usage(
    status: SkillUsageBackendStatus,
    rows: Array<{ skill_name: string; use_count: number }> = [],
  ): SkillUsageResult {
    return {
      schema_version: "skills.usage/v1",
      status,
      source: "loki",
      endpoint: "http://blade:3100",
      since: "7d",
      observed_at: "2026-06-22T00:00:00.000Z",
      signal_scope: "claude-only",
      skills: rows,
      notes: ["mock"],
      ...(status === "ok" ? {} : { unavailable_reason: "mock unavailable" }),
    };
  }

  function registry(
    entries: Array<{ id: string; status?: SkillLifecycleStatus }>,
  ): CuratorRegistryInput {
    return {
      path: "/tmp/SOURCES.json",
      version: "slice3-test",
      skills: entries.map((e) => ({
        id: e.id,
        ...(e.status ? { status: e.status } : {}),
        // Migrated first-party shape: internal + regime db.
        source: { type: "internal", repo: "polli-labs/agents-infra", path: `${e.id}/SKILL.md`, regime: "db" },
      })),
    };
  }

  async function mirrorExists(backend: "claude" | "agents", name: string): Promise<boolean> {
    try {
      await readFile(path.join(resolveSkillInstallDir(backend, name), "SKILL.md"), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  test("archive apply round-trip: deprecated+0-usage db skill is tombstoned and the mirror pruned", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      upsertSkillContent(db, { host_id: HOST, skill_name: "stale-skill", payload: { "SKILL.md": skillMd("Stale", "an old skill") } });
      // Materialize the mirror so we can prove the prune.
      const { rematerializeSkill } = await import("../skills-rematerialize");
      await rematerializeSkill({ db, hostId: HOST, skillName: "stale-skill" });
      expect(await mirrorExists("agents", "stale-skill")).toBe(true);

      const receipt = await applyCuratorReport({
        db,
        registry: registry([{ id: "stale-skill", status: "deprecated" }]),
        usage: usage("ok", []), // zero usage → archive-candidate
        hostId: HOST,
        dryRun: false,
      });

      expect(receipt.blocked).toBeUndefined();
      expect(receipt.archived).toEqual(["stale-skill"]);
      expect(receipt.rollback_cursor).not.toBeNull();
      // DB row is tombstoned (excluded from the default live list).
      expect(listSkillContent(db, { host_id: HOST }).find((r) => r.skill_name === "stale-skill")).toBeUndefined();
      // Mirror pruned.
      expect(await mirrorExists("agents", "stale-skill")).toBe(false);
    });
  });

  test("dry-run reports the archive but mutates nothing", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      upsertSkillContent(db, { host_id: HOST, skill_name: "stale-skill", payload: { "SKILL.md": skillMd("Stale", "an old skill") } });
      const receipt = await applyCuratorReport({
        db,
        registry: registry([{ id: "stale-skill", status: "deprecated" }]),
        usage: usage("ok", []),
        hostId: HOST,
        dryRun: true,
      });
      expect(receipt.dry_run).toBe(true);
      expect(receipt.archived).toEqual(["stale-skill"]);
      // Still LIVE — nothing was tombstoned.
      expect(readSkillContent(db, HOST, "stale-skill")!.deleted_at).toBeNull();
    });
  });

  test("pinning fences archive: a pinned archive-candidate is skipped, not tombstoned", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      upsertSkillContent(db, { host_id: HOST, skill_name: "pinned-skill", payload: { "SKILL.md": skillMd("Pinned", "do not touch") } });
      expect(setPinned(db, HOST, "pinned-skill", true)!.pinned).toBe(true);

      const receipt = await applyCuratorReport({
        db,
        registry: registry([{ id: "pinned-skill", status: "deprecated" }]),
        usage: usage("ok", []),
        hostId: HOST,
        dryRun: false,
      });

      expect(receipt.archived).toEqual([]);
      expect(receipt.pinned_skipped).toEqual(["pinned-skill"]);
      // Still live.
      expect(readSkillContent(db, HOST, "pinned-skill")!.deleted_at).toBeNull();
    });
  });

  test("blind-sensor gate: a non-ok usage backend refuses all mutations", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      upsertSkillContent(db, { host_id: HOST, skill_name: "stale-skill", payload: { "SKILL.md": skillMd("Stale", "an old skill") } });

      const receipt = await applyCuratorReport({
        db,
        registry: registry([{ id: "stale-skill", status: "deprecated" }]),
        usage: usage("unavailable"),
        hostId: HOST,
        dryRun: false,
      });

      expect(receipt.blocked).toBeDefined();
      expect(receipt.blocked!.reason).toContain("blind-sensor");
      expect(receipt.archived).toEqual([]);
      expect(receipt.rollback_cursor).toBeNull();
      // NOTHING mutated.
      expect(readSkillContent(db, HOST, "stale-skill")!.deleted_at).toBeNull();
    });
  });

  test("rollback restores: archive then rollback → skill live + mirror restored", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      upsertSkillContent(db, { host_id: HOST, skill_name: "recover-me", payload: { "SKILL.md": skillMd("Recover", "bring me back") } });
      const { rematerializeSkill } = await import("../skills-rematerialize");
      await rematerializeSkill({ db, hostId: HOST, skillName: "recover-me" });

      const cursorBefore = skillWriteLogHighWater(db);
      const receipt = await applyCuratorReport({
        db,
        registry: registry([{ id: "recover-me", status: "deprecated" }]),
        usage: usage("ok", []),
        hostId: HOST,
        dryRun: false,
      });
      expect(receipt.archived).toEqual(["recover-me"]);
      expect(receipt.rollback_cursor).toBe(cursorBefore);
      expect(readSkillContent(db, HOST, "recover-me")!.deleted_at).not.toBeNull();
      expect(await mirrorExists("agents", "recover-me")).toBe(false);

      const rb = await rollbackCuratorPass({
        db,
        hostId: HOST,
        cursor: receipt.rollback_cursor!,
        passId: receipt.pass_id,
      });
      expect(rb.restored).toEqual(["recover-me"]);
      // Live again + content intact + mirror restored.
      const restored = readSkillContent(db, HOST, "recover-me")!;
      expect(restored.deleted_at).toBeNull();
      expect(restored.payload["SKILL.md"]).toContain("bring me back");
      expect(await mirrorExists("agents", "recover-me")).toBe(true);
    });
  });

  test("consolidate success: A+B→C — C live + materialized, A/B tombstoned + pruned", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      upsertSkillContent(db, { host_id: HOST, skill_name: "skill-a", payload: { "SKILL.md": skillMd("A", "first dup") } });
      upsertSkillContent(db, { host_id: HOST, skill_name: "skill-b", payload: { "SKILL.md": skillMd("B", "second dup") } });
      const { rematerializeSkill } = await import("../skills-rematerialize");
      await rematerializeSkill({ db, hostId: HOST, skillName: "skill-a" });
      await rematerializeSkill({ db, hostId: HOST, skillName: "skill-b" });
      expect(await mirrorExists("agents", "skill-a")).toBe(true);
      expect(await mirrorExists("agents", "skill-b")).toBe(true);

      const targetPayload = { "SKILL.md": skillMd("C", "the merged skill") };
      const result = consolidateSkillContent(db, {
        hostId: HOST,
        sourceIds: ["skill-a", "skill-b"],
        targetId: "skill-c",
        targetPayload,
        summary: "merge a+b into c",
      });
      expect(result.consolidated.sort()).toEqual(["skill-a", "skill-b"]);

      // Caller re-materializes target + prunes sources.
      await rematerializeSkill({ db, hostId: HOST, skillName: "skill-c" });
      await rematerializeSkill({ db, hostId: HOST, skillName: "skill-a" });
      await rematerializeSkill({ db, hostId: HOST, skillName: "skill-b" });

      // C is live + materialized.
      const c = readSkillContent(db, HOST, "skill-c")!;
      expect(c.deleted_at).toBeNull();
      expect(c.payload["SKILL.md"]).toContain("the merged skill");
      expect(c.materialized_at).not.toBeNull();
      expect(await mirrorExists("agents", "skill-c")).toBe(true);

      // A + B tombstoned + pruned.
      expect(readSkillContent(db, HOST, "skill-a")!.deleted_at).not.toBeNull();
      expect(readSkillContent(db, HOST, "skill-b")!.deleted_at).not.toBeNull();
      expect(await mirrorExists("agents", "skill-a")).toBe(false);
      expect(await mirrorExists("agents", "skill-b")).toBe(false);
    });
  });

  test("consolidate refuses a pinned source (nothing committed)", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      upsertSkillContent(db, { host_id: HOST, skill_name: "src-pinned", payload: { "SKILL.md": skillMd("P", "pinned src") } });
      upsertSkillContent(db, { host_id: HOST, skill_name: "src-ok", payload: { "SKILL.md": skillMd("O", "ok src") } });
      setPinned(db, HOST, "src-pinned", true);

      expect(() =>
        consolidateSkillContent(db, {
          hostId: HOST,
          sourceIds: ["src-pinned", "src-ok"],
          targetId: "target",
          targetPayload: { "SKILL.md": skillMd("T", "target") },
        }),
      ).toThrow(ConsolidationAborted);

      // Nothing committed: both sources still live, target never created.
      expect(readSkillContent(db, HOST, "src-pinned")!.deleted_at).toBeNull();
      expect(readSkillContent(db, HOST, "src-ok")!.deleted_at).toBeNull();
      expect(readSkillContent(db, HOST, "target")).toBeUndefined();
    });
  });

  test("consolidate refuses self-consolidation and empty sources", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      upsertSkillContent(db, { host_id: HOST, skill_name: "solo", payload: { "SKILL.md": skillMd("S", "solo") } });
      expect(() =>
        consolidateSkillContent(db, { hostId: HOST, sourceIds: ["solo"], targetId: "solo", targetPayload: { "SKILL.md": "x" } }),
      ).toThrow(/self-consolidation/);
      expect(() =>
        consolidateSkillContent(db, { hostId: HOST, sourceIds: [], targetId: "t", targetPayload: { "SKILL.md": "x" } }),
      ).toThrow(/at least one source/);
    });
  });

  test("consolidate CAS-abort: a concurrent content_hash change on a source aborts the WHOLE consolidation", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      upsertSkillContent(db, { host_id: HOST, skill_name: "cas-a", payload: { "SKILL.md": skillMd("A", "alpha") } });
      upsertSkillContent(db, { host_id: HOST, skill_name: "cas-b", payload: { "SKILL.md": skillMd("B", "bravo") } });
      const aBefore = readSkillContent(db, HOST, "cas-a")!;
      const bBefore = readSkillContent(db, HOST, "cas-b")!;

      // Wrap db.prepare so that the FIRST source-tombstone UPDATE is preceded by
      // a raw concurrent mutation of cas-a's content_hash (the race window
      // between the txn-start hash read and the guarded UPDATE). The guarded
      // UPDATE then matches 0 rows → ConsolidationAborted, all-or-nothing.
      const realPrepare = db.prepare.bind(db);
      let raced = false;
      const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        const stmt = realPrepare(sql);
        const isSourceTombstone =
          sql.includes("SET content_hash = ?, payload_json = ?, deleted_at = ?") &&
          sql.includes("materialized_at = NULL");
        if (!isSourceTombstone) {
          return stmt;
        }
        const realRun = stmt.run.bind(stmt);
        return new Proxy(stmt, {
          get(target, prop, receiver) {
            if (prop === "run") {
              return (...args: unknown[]) => {
                if (!raced) {
                  raced = true;
                  // Concurrent writer changes cas-a out from under the CAS guard.
                  realPrepare(
                    `UPDATE skill_content SET content_hash = 'RACED-HASH' WHERE host_id = ? AND skill_name = ?`,
                  ).run(HOST, "cas-a");
                }
                return realRun(...(args as []));
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
      });

      expect(() =>
        consolidateSkillContent(db, {
          hostId: HOST,
          sourceIds: ["cas-a", "cas-b"],
          targetId: "cas-c",
          targetPayload: { "SKILL.md": skillMd("C", "charlie") },
        }),
      ).toThrow(ConsolidationAborted);

      spy.mockRestore();

      // NOTHING committed (transaction rolled back). The raced hash write was
      // inside the aborted transaction, so cas-a is back to its original hash.
      const aAfter = readSkillContent(db, HOST, "cas-a")!;
      const bAfter = readSkillContent(db, HOST, "cas-b")!;
      expect(aAfter.deleted_at).toBeNull();
      expect(bAfter.deleted_at).toBeNull();
      expect(aAfter.content_hash).toBe(aBefore.content_hash);
      expect(bAfter.content_hash).toBe(bBefore.content_hash);
      expect(readSkillContent(db, HOST, "cas-c")).toBeUndefined();
    });
  });

  test("near-dup detection flags a consolidate-candidate pair", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      // Two skills with nearly identical title+description → high token overlap.
      upsertSkillContent(db, {
        host_id: HOST,
        skill_name: "dup-one",
        payload: { "SKILL.md": skillMd("Vault Search Helper", "search the vault for notes and documents quickly") },
      });
      upsertSkillContent(db, {
        host_id: HOST,
        skill_name: "dup-two",
        payload: { "SKILL.md": skillMd("Vault Search Helper", "search the vault for notes and documents quickly") },
      });
      // A clearly different skill → no pairing.
      upsertSkillContent(db, {
        host_id: HOST,
        skill_name: "unrelated",
        payload: { "SKILL.md": skillMd("Train Model", "launch a dinov3 training run on the blade host") },
      });

      const dbSkills = gatherCuratorDbSkills(db, HOST);
      expect(dbSkills.map((s) => s.id).sort()).toEqual(["dup-one", "dup-two", "unrelated"]);

      const recs = detectDuplicateCandidates(dbSkills, new Map());
      expect(recs).toHaveLength(1);
      expect(recs[0]!.action).toBe("consolidate-candidate");
      expect(recs[0]!.skill_id).toBe("dup-one");
      expect(recs[0]!.consolidate_with).toBe("dup-two");
      expect(recs[0]!.similarity!).toBeGreaterThanOrEqual(0.85);

      // And the apply receipt surfaces it as a recommend-only candidate even
      // when archiving nothing.
      const receipt = await applyCuratorReport({
        db,
        registry: registry([{ id: "dup-one" }, { id: "dup-two" }, { id: "unrelated" }]),
        usage: usage("ok", [
          { skill_name: "dup-one", use_count: 3 },
          { skill_name: "dup-two", use_count: 3 },
          { skill_name: "unrelated", use_count: 3 },
        ]),
        hostId: HOST,
        dryRun: false,
      });
      expect(receipt.archived).toEqual([]);
      expect(receipt.consolidate_candidates).toHaveLength(1);
      expect(receipt.consolidate_candidates[0]!.consolidate_with).toBe("dup-two");
    });
  });

  test("stale (active + 0 usage) is recommend-only — never auto-archived", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      // Active (not deprecated) + zero usage → low-signal recommend, NOT archive.
      upsertSkillContent(db, { host_id: HOST, skill_name: "active-unused", payload: { "SKILL.md": skillMd("Active", "unused but active") } });
      const receipt = await applyCuratorReport({
        db,
        registry: registry([{ id: "active-unused" }]), // status defaults to active
        usage: usage("ok", []),
        hostId: HOST,
        dryRun: false,
      });
      expect(receipt.archived).toEqual([]);
      // Still live.
      expect(readSkillContent(db, HOST, "active-unused")!.deleted_at).toBeNull();
    });
  });
});
