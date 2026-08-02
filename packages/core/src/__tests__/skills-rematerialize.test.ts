import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  applyStateMigrations,
  openStateStore,
  readSkillContent,
  stampMaterialized,
  tombstoneSkillContent,
  upsertSkillContent,
} from "../state";
import type { StateDriverDatabase } from "../state";
import { RematerializeError, rematerializeSkill } from "../skills-rematerialize";
import * as skillsInstall from "../skills-install";
import {
  buildExpectedInstallTreeFromContent,
  bufferMapTreeSha,
  readInstallationTree,
  renderClaudeSkill,
  resolveSkillInstallDir,
} from "../skills-install";

const HOST = "testhost";

/**
 * Re-materializer tests. SAFETY (rule 2): every test sandboxes the install
 * mirrors by overriding HOME and CODEX_HOME to a mkdtemp root in beforeEach and
 * restoring in afterEach, exactly like skills.test.ts. The re-materializer is
 * NEVER run against the real HOME. The state DB is also sandboxed via
 * CALYX_STATE_HOME.
 */
describe("rematerializeSkill (POL-1729 Slice 1)", () => {
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
    workRoot = await mkdtemp(path.join(tmpdir(), "calyx-rematerialize-"));
    sandboxHome = path.join(workRoot, "home");
    await mkdir(sandboxHome, { recursive: true });
    // SAFETY rule 2: sandbox the install mirrors.
    process.env["HOME"] = sandboxHome;
    process.env["CODEX_HOME"] = path.join(sandboxHome, ".codex");
    // Sandbox the state DB.
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

  const SKILL_MD = "---\ntitle: My Skill\ndescription: does a thing\n---\n# My Skill\n\nbody text\n";

  test("write -> re-materialize installs the codex mirror, and a second identical pass is a no-op (#2 idempotency, #7 latency)", async () => {
    await applyStateMigrations();
    const first = await withDb(async (db) => {
      upsertSkillContent(db, { host_id: HOST, skill_name: "my-skill", payload: { "SKILL.md": SKILL_MD } });
      return rematerializeSkill({ db, hostId: HOST, skillName: "my-skill" });
    });
    expect(first.action).toBe("installed");
    expect(first.stamped).toBe(true);

    // #7 latency: the codex mirror file exists right after write ("live-after-rematerialize").
    // Default codex mode aliases agents, so codex resolves to the agents mirror.
    const agentsDir = resolveSkillInstallDir("agents", "my-skill");
    const liveSkillMd = await readFile(path.join(agentsDir, "SKILL.md"), "utf8");
    expect(liveSkillMd).toContain("body text");

    // The agents backend writes the document verbatim (trimmed + trailing newline).
    expect(liveSkillMd).toBe(`${SKILL_MD.replace(/\s+$/, "")}\n`);

    // Every installed backend in the first pass actually installed.
    expect(first.backends.every((b) => b.action === "installed")).toBe(true);

    // #2: a second re-materialize with unchanged content is a no-op against the rendered tree.
    const second = await withDb((db) => rematerializeSkill({ db, hostId: HOST, skillName: "my-skill" }));
    expect(second.action).toBe("installed");
    expect(second.backends.every((b) => b.action === "noop")).toBe(true);
  });

  test("the install never hand-edits a mirror: EVERY backend's live tree equals its expected RENDERED tree (#1)", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      upsertSkillContent(db, { host_id: HOST, skill_name: "s", payload: { "SKILL.md": SKILL_MD } });
      return rematerializeSkill({ db, hostId: HOST, skillName: "s" });
    });
    // Assert BOTH target backends (agents + claude) match their rendered expectation
    // byte for byte. The agents mirror is verbatim; claude re-renders frontmatter.
    for (const backend of ["agents", "claude"] as const) {
      const expected = buildExpectedInstallTreeFromContent(backend, "s", SKILL_MD, new Map());
      const dir = resolveSkillInstallDir(backend, "s");
      const live = await readInstallationTree(dir);
      expect(live, `${backend} mirror should exist`).toBeDefined();
      expect(bufferMapTreeSha(live!), `${backend} mirror should equal its rendered tree`).toBe(
        bufferMapTreeSha(expected),
      );
    }
    // Spot-check the claude render explicitly.
    const claudeSkillMd = await readFile(path.join(resolveSkillInstallDir("claude", "s"), "SKILL.md"), "utf8");
    expect(claudeSkillMd).toBe(renderClaudeSkill("s", "does a thing", "# My Skill\n\nbody text"));
  });

  test("multi-file payload installs extra files; removing one purges it from the mirror (orphan-file fix)", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      upsertSkillContent(db, {
        host_id: HOST,
        skill_name: "s",
        payload: { "SKILL.md": SKILL_MD, "references/a.md": "alpha", "references/b.md": "beta" },
      });
      return rematerializeSkill({ db, hostId: HOST, skillName: "s" });
    });
    const agentsDir = resolveSkillInstallDir("agents", "s");
    expect(await readFile(path.join(agentsDir, "references", "a.md"), "utf8")).toBe("alpha");
    expect(await readFile(path.join(agentsDir, "references", "b.md"), "utf8")).toBe("beta");

    // Re-write WITHOUT references/b.md; the full-directory swap must purge it.
    await withDb(async (db) => {
      upsertSkillContent(db, {
        host_id: HOST,
        skill_name: "s",
        payload: { "SKILL.md": SKILL_MD, "references/a.md": "alpha" },
      });
      return rematerializeSkill({ db, hostId: HOST, skillName: "s" });
    });
    expect(await readFile(path.join(agentsDir, "references", "a.md"), "utf8")).toBe("alpha");
    await expect(readFile(path.join(agentsDir, "references", "b.md"), "utf8")).rejects.toThrow();
  });

  test("tombstone delete prunes the mirror (#6 prune path)", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      upsertSkillContent(db, { host_id: HOST, skill_name: "s", payload: { "SKILL.md": SKILL_MD } });
      return rematerializeSkill({ db, hostId: HOST, skillName: "s" });
    });
    const agentsDir = resolveSkillInstallDir("agents", "s");
    expect(await readInstallationTree(agentsDir)).toBeDefined();

    const pruned = await withDb(async (db) => {
      tombstoneSkillContent(db, { host_id: HOST, skill_name: "s" });
      return rematerializeSkill({ db, hostId: HOST, skillName: "s" });
    });
    expect(pruned.action).toBe("pruned");
    expect(pruned.stamped).toBe(true);
    expect(await readInstallationTree(agentsDir)).toBeUndefined();
  });

  test("tombstone -> recreate re-installs the mirror", async () => {
    await applyStateMigrations();
    const agentsDir = resolveSkillInstallDir("agents", "s");
    await withDb(async (db) => {
      upsertSkillContent(db, { host_id: HOST, skill_name: "s", payload: { "SKILL.md": SKILL_MD } });
      return rematerializeSkill({ db, hostId: HOST, skillName: "s" });
    });
    await withDb(async (db) => {
      tombstoneSkillContent(db, { host_id: HOST, skill_name: "s" });
      return rematerializeSkill({ db, hostId: HOST, skillName: "s" });
    });
    expect(await readInstallationTree(agentsDir)).toBeUndefined();

    const recreated = await withDb(async (db) => {
      upsertSkillContent(db, { host_id: HOST, skill_name: "s", payload: { "SKILL.md": SKILL_MD } });
      return rematerializeSkill({ db, hostId: HOST, skillName: "s" });
    });
    expect(recreated.action).toBe("installed");
    expect(await readInstallationTree(agentsDir)).toBeDefined();
  });

  test("provenance gate: a non-db regime row refuses re-materialize (#3 cross_regime_write)", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      // Insert a git-regime row directly (the write verb never produces one).
      db.prepare(
        `INSERT INTO skill_content
           (host_id, skill_name, content_hash, regime, payload_json, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, 'git', ?, NULL, ?, ?)`,
      ).run(HOST, "git-skill", "abc", JSON.stringify({ "SKILL.md": SKILL_MD }), "t", "t");
    });
    await withDb(async (db) => {
      await expect(rematerializeSkill({ db, hostId: HOST, skillName: "git-skill" })).rejects.toMatchObject({
        code: "cross_regime_write",
      });
    });
    // The git mirror must NOT have been written.
    expect(await readInstallationTree(resolveSkillInstallDir("agents", "git-skill"))).toBeUndefined();
  });

  test("a git-regime row never re-materializes even when a mirror already exists (#8)", async () => {
    await applyStateMigrations();
    // Pre-existing mirror content that must remain untouched.
    const agentsDir = resolveSkillInstallDir("agents", "vendored-skill");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(path.join(agentsDir, "SKILL.md"), "PRE-EXISTING\n");

    await withDb(async (db) => {
      db.prepare(
        `INSERT INTO skill_content
           (host_id, skill_name, content_hash, regime, payload_json, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, 'vendored', ?, NULL, ?, ?)`,
      ).run(HOST, "vendored-skill", "abc", JSON.stringify({ "SKILL.md": SKILL_MD }), "t", "t");
    });
    await withDb(async (db) => {
      await expect(rematerializeSkill({ db, hostId: HOST, skillName: "vendored-skill" })).rejects.toBeInstanceOf(
        RematerializeError,
      );
    });
    expect(await readFile(path.join(agentsDir, "SKILL.md"), "utf8")).toBe("PRE-EXISTING\n");
  });

  test("missing row errors with skill_not_found", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      await expect(rematerializeSkill({ db, hostId: HOST, skillName: "nope" })).rejects.toMatchObject({
        code: "skill_not_found",
      });
    });
  });

  test("path-traversal guard: a payload key with a ../escape segment is refused and writes nothing outside the sandbox (FIX A)", async () => {
    await applyStateMigrations();
    // Insert a db-regime row directly with a malicious payload key. The write
    // verb's --payload-file guard would reject this, but the re-materializer is
    // the keystone and must defend itself regardless of how content entered the DB.
    const escapeTarget = path.join(workRoot, "escape-target.txt");
    await withDb(async (db) => {
      db.prepare(
        `INSERT INTO skill_content
           (host_id, skill_name, content_hash, regime, payload_json, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, 'db', ?, NULL, ?, ?)`,
      ).run(
        HOST,
        "evil",
        "abc",
        JSON.stringify({ "SKILL.md": SKILL_MD, "../../../../../../../../escape-target.txt": "PWNED" }),
        "t",
        "t",
      );
    });
    await withDb(async (db) => {
      await expect(rematerializeSkill({ db, hostId: HOST, skillName: "evil" })).rejects.toMatchObject({
        code: "invalid_payload",
      });
    });
    // No file was written outside the sandbox, and no mirror was created.
    await expect(readFile(escapeTarget, "utf8")).rejects.toThrow();
    expect(await readInstallationTree(resolveSkillInstallDir("agents", "evil"))).toBeUndefined();
  });

  test("recoverability: a failed staged rename rolls back to the prior tree (#6)", async () => {
    await applyStateMigrations();
    // Install v1 cleanly.
    await withDb(async (db) => {
      upsertSkillContent(db, { host_id: HOST, skill_name: "s", payload: { "SKILL.md": "VERSION ONE\n" } });
      return rematerializeSkill({ db, hostId: HOST, skillName: "s" });
    });
    const agentsDir = resolveSkillInstallDir("agents", "s");
    const claudeDir = resolveSkillInstallDir("claude", "s");
    expect(await readFile(path.join(agentsDir, "SKILL.md"), "utf8")).toBe("VERSION ONE\n");

    // Now simulate a crash mid-commit: make the claude install dir un-renameable
    // by replacing its parent's target with a file so the rename-staged-in fails.
    // We do this by monkeypatching the claude install path to a location whose
    // parent cannot be created. Simplest deterministic failure: pre-create the
    // claude install dir's PARENT as a regular file.
    // Instead, force failure by making the claude install path a file (so the
    // backup rename of the existing dir is fine, but staging the new tree into a
    // path whose parent is now missing fails). We make the staging area's parent
    // read-only is unreliable cross-platform; instead inject a sentinel by
    // pre-writing v2 then corrupting via an unwritable path is also flaky.
    //
    // Deterministic approach: write v2 to the DB, then delete the claude PARENT
    // dir and replace it with a file so commit's mkdir/rename for claude fails.
    await rm(claudeDir, { recursive: true, force: true });
    const claudeParent = path.dirname(claudeDir);
    await rm(claudeParent, { recursive: true, force: true });
    await writeFile(claudeParent, "not a directory");

    await withDb(async (db) => {
      upsertSkillContent(db, { host_id: HOST, skill_name: "s", payload: { "SKILL.md": "VERSION TWO\n" } });
      await expect(rematerializeSkill({ db, hostId: HOST, skillName: "s" })).rejects.toThrow();
    });

    // The agents mirror must still hold v1 (rolled back), not a half-applied v2.
    // Byte-compare the WHOLE tree to v1's rendered expectation, not just SKILL.md,
    // so a partial/orphaned write would be caught.
    const agentsV1Expected = buildExpectedInstallTreeFromContent("agents", "s", "VERSION ONE\n", new Map());
    const agentsLive = await readInstallationTree(agentsDir);
    expect(agentsLive).toBeDefined();
    expect(bufferMapTreeSha(agentsLive!)).toBe(bufferMapTreeSha(agentsV1Expected));
    // Both backends are consistent after the rollback: the agents parent holds no
    // leftover staging/backup scratch dirs (clean rollback, not a stranded swap).
    const agentsParentEntries = await readdir(path.dirname(agentsDir));
    expect(agentsParentEntries.some((e) => e.startsWith(".calyx-skill-"))).toBe(false);
    // The DB row was written (v2) but materialized_at was NOT stamped (commit failed).
    await withDb((db) => {
      const row = readSkillContent(db, HOST, "s")!;
      expect(row.payload["SKILL.md"]).toBe("VERSION TWO\n");
      expect(row.materialized_at).toBeNull();
    });
  });

  test("CAS: a stamp against a now-stale content_hash is a no-op (#9 rematerializer-level race)", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      // v1: write + materialize. Capture v1's content_hash from the materialized row.
      upsertSkillContent(db, { host_id: HOST, skill_name: "s", payload: { "SKILL.md": "v1\n" } });
      const v1 = await rematerializeSkill({ db, hostId: HOST, skillName: "s" });
      expect(v1.stamped).toBe(true);
      const v1Hash = v1.contentHash;
      const v1MaterializedAt = readSkillContent(db, HOST, "s")!.materialized_at;
      expect(v1MaterializedAt).not.toBeNull();

      // v2: a newer write lands (new content_hash, materialized_at reset to NULL).
      upsertSkillContent(db, { host_id: HOST, skill_name: "s", payload: { "SKILL.md": "v2\n" } });
      const afterV2 = readSkillContent(db, HOST, "s")!;
      expect(afterV2.content_hash).not.toBe(v1Hash);
      expect(afterV2.materialized_at).toBeNull();

      // The earlier pass tries to stamp with v1's NOW-STALE hash: must be a no-op,
      // leaving materialized_at NULL (the not-stale state) so v2's own pass stamps it.
      const stamped = stampMaterialized(db, HOST, "s", v1Hash);
      expect(stamped).toBe(false);
      expect(readSkillContent(db, HOST, "s")!.materialized_at).toBeNull();
    });
  });

  test("post-commit verify_failed: a mirror that diverges from the expected tree after commit throws verify_failed and does NOT stamp (FIX G)", async () => {
    await applyStateMigrations();
    // Install v1 cleanly so the row exists and is stamped.
    await withDb(async (db) => {
      upsertSkillContent(db, { host_id: HOST, skill_name: "s", payload: { "SKILL.md": "v1\n" } });
      return rematerializeSkill({ db, hostId: HOST, skillName: "s" });
    });

    // Write v2 so the next pass goes through the install + post-commit-verify path
    // (not the idempotency no-op). The default target backends are [agents, claude],
    // so per pass: 2 idempotency reads, then 2 post-commit verify reads. We let the
    // idempotency reads pass through (real disk) but corrupt the FIRST verify read so
    // the committed tree no longer matches `expected`.
    const real = skillsInstall.readInstallationTree;
    let call = 0;
    const spy = vi.spyOn(skillsInstall, "readInstallationTree").mockImplementation(async (dir: string) => {
      call += 1;
      // Calls 1-2 are the idempotency phase; call 3 is the first post-commit verify.
      if (call === 3) {
        return new Map<string, Buffer>([["SKILL.md", Buffer.from("CORRUPTED MIRROR\n", "utf8")]]);
      }
      return real(dir);
    });

    try {
      await withDb(async (db) => {
        upsertSkillContent(db, { host_id: HOST, skill_name: "s", payload: { "SKILL.md": "v2\n" } });
        await expect(rematerializeSkill({ db, hostId: HOST, skillName: "s" })).rejects.toMatchObject({
          code: "verify_failed",
        });
      });
    } finally {
      spy.mockRestore();
    }

    // The DB row holds v2 but materialized_at was NOT stamped (verify threw first).
    await withDb((db) => {
      const row = readSkillContent(db, HOST, "s")!;
      expect(row.payload["SKILL.md"]).toBe("v2\n");
      expect(row.materialized_at).toBeNull();
    });
  });
});
