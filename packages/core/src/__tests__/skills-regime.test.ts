import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  applyStateMigrations,
  listSkillContent,
  openStateStore,
  readSkillContent,
  upsertSkillContent,
} from "../state";
import type { StateDriverDatabase } from "../state";
import { MigrateError, migrateAllInternalSkills, migrateSkill } from "../skills-migrate";
import { resolveSkillRegime, syncSkillsRegistry } from "../skills";
import { showSkill } from "../skills-show";
import { readInstallationTree, resolveSkillInstallDir } from "../skills-install";

/**
 * POL-1729 Slice 2 — regime + migrate tests.
 *
 * SAFETY (rule 2): every test that re-materializes or migrates sandboxes the
 * install mirrors by overriding HOME + CODEX_HOME to a mkdtemp root in
 * beforeEach and restoring in afterEach (mirrors skills-rematerialize.test.ts).
 * The state DB is sandboxed via CALYX_STATE_HOME. NO live cutover is performed:
 * the registry + git sources are all under the temp fixture root, and migrate is
 * never run against the real agents-infra SOURCES.json or the real HOME.
 */

const HOST_ID = hostname().split(".")[0]?.toLowerCase() ?? hostname().toLowerCase();

const INTERNAL_SKILL_MD =
  "---\ntitle: First Party Skill\ndescription: a first-party skill\n---\n# First Party Skill\n\ninternal body text\n";

describe("POL-1729 Slice 2 — regime + migrate", () => {
  let workRoot: string;
  let sandboxHome: string;
  let agentsInfraRoot: string;
  let registryPath: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      HOME: process.env["HOME"],
      CODEX_HOME: process.env["CODEX_HOME"],
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    workRoot = await mkdtemp(path.join(tmpdir(), "calyx-skills-regime-"));
    sandboxHome = path.join(workRoot, "home");
    await mkdir(sandboxHome, { recursive: true });
    // SAFETY rule 2: sandbox the install mirrors + state DB.
    process.env["HOME"] = sandboxHome;
    process.env["CODEX_HOME"] = path.join(sandboxHome, ".codex");
    delete process.env["CALYX_STATE_DB"];
    process.env["CALYX_STATE_HOME"] = path.join(workRoot, "state");

    // Build a SANDBOXED agents-infra-like tree: an internal git source skill
    // plus a mixed-regime SOURCES.json. This never touches the real one.
    agentsInfraRoot = path.join(workRoot, "agents-infra");
    const internalDir = path.join(agentsInfraRoot, "skills", "first-party");
    await mkdir(path.join(internalDir, "references"), { recursive: true });
    await writeFile(path.join(internalDir, "SKILL.md"), INTERNAL_SKILL_MD, "utf8");
    await writeFile(path.join(internalDir, "references", "extra.md"), "EXTRA REF", "utf8");

    // A second internal skill that stays git (to prove sync still syncs git).
    const gitDir = path.join(agentsInfraRoot, "skills", "stays-git");
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, "SKILL.md"), INTERNAL_SKILL_MD, "utf8");

    // The git source for the already-db registry entry (so --all-internal can
    // resolve + migrate it rather than failing source_unresolved).
    const alreadyDbDir = path.join(agentsInfraRoot, "skills", "already-db");
    await mkdir(alreadyDbDir, { recursive: true });
    await writeFile(path.join(alreadyDbDir, "SKILL.md"), INTERNAL_SKILL_MD, "utf8");

    // An internal skill whose REGISTRY id has uppercase, while its git source
    // dir is the normalized name (the on-disk convention). Used to prove the
    // idempotency read keys by the canonical (normalized) id (FIX 1).
    const mixedDir = path.join(agentsInfraRoot, "skills", "some-mixed-case-id");
    await mkdir(mixedDir, { recursive: true });
    await writeFile(path.join(mixedDir, "SKILL.md"), INTERNAL_SKILL_MD, "utf8");

    // An internal skill whose SKILL.md is a DIRECTORY, not a file: it passes the
    // pathExists guard but readFile throws EISDIR (a plain Error, NOT a
    // MigrateError). Used to prove --all-internal collects non-MigrateError
    // failures instead of aborting the batch (FIX 2).
    await mkdir(path.join(agentsInfraRoot, "skills", "broken-source", "SKILL.md"), {
      recursive: true,
    });

    // The registry: a db-regime entry (already migrated), a git internal entry,
    // and a non-internal (external) entry.
    registryPath = path.join(workRoot, "SOURCES.json");
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          version: "2026-06-22",
          skills: [
            { id: "already-db", source: { type: "internal", path: "skills/already-db", regime: "db" } },
            { id: "stays-git", source: { type: "internal", path: "skills/stays-git" } },
            {
              id: "vendored-skill",
              source: { type: "external", repo: "https://github.com/x/y", path: "vendored-skill" },
            },
            { id: "first-party", source: { type: "internal", path: "skills/first-party" } },
            { id: "Some-Mixed-Case-Id", source: { type: "internal", path: "skills/some-mixed-case-id" } },
            { id: "broken-source", source: { type: "internal", path: "skills/broken-source" } },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
  });

  afterEach(async () => {
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

  // (a) sync SKIPS a regime:db entry (plan-skip) and still syncs git entries (#8).
  // Plan mode (no --apply) does not need agents-infra source resolution for
  // internal skills, so the db-skip is observable without a marker tree.
  test("sync plan-skips a db-regime entry but plans-sync a git internal entry (#8 no-cross-regime-clobber)", async () => {
    const result = await syncSkillsRegistry(registryPath, { backend: "agents" });

    const byId = new Map(result.actions.map((a) => [a.id, a]));
    // The already-db skill is skipped with the re-materializer-owned reason.
    expect(byId.get("already-db")?.action).toBe("plan-skip");
    expect(byId.get("already-db")?.details).toContain("db-regime");
    // The git internal skill is planned for sync (NOT skipped).
    expect(byId.get("stays-git")?.action).toBe("plan-sync");
    // The git first-party skill is also planned for sync (it has NOT been migrated yet).
    expect(byId.get("first-party")?.action).toBe("plan-sync");
  });

  // resolveSkillRegime defaults absent -> git and honors db.
  test("resolveSkillRegime: absent regime is git; explicit db is db", () => {
    expect(resolveSkillRegime({ type: "internal", path: "x" })).toBe("git");
    expect(resolveSkillRegime({ type: "internal", path: "x", regime: "db" })).toBe("db");
    expect(resolveSkillRegime({ type: "internal", path: "x", regime: "git" })).toBe("git");
  });

  // (b) migrate an internal skill -> seeds skill_content regime=db + re-materializes.
  test("migrate an internal skill seeds skill_content regime=db, re-materializes all backends, and the live mirror matches", async () => {
    await applyStateMigrations();
    const result = await withDb((db) =>
      migrateSkill({ db, skillId: "first-party", hostId: HOST_ID, agentsInfraRoot, registryPath }),
    );
    expect(result.action).toBe("installed");
    expect(result.payloadFiles).toContain("SKILL.md");
    expect(result.payloadFiles).toContain(path.join("references", "extra.md"));
    expect(result.rematerialize?.action).toBe("installed");
    expect(result.next_step).toContain("SOURCES.json");

    // The DB row is regime=db and live.
    await withDb((db) => {
      const row = readSkillContent(db, HOST_ID, "first-party")!;
      expect(row.regime).toBe("db");
      expect(row.deleted_at).toBeNull();
      expect(row.payload["SKILL.md"]).toBe(INTERNAL_SKILL_MD);
    });

    // The agents mirror exists with the verbatim content (codex aliases agents).
    const agentsDir = resolveSkillInstallDir("agents", "first-party");
    const liveSkillMd = await readFile(path.join(agentsDir, "SKILL.md"), "utf8");
    expect(liveSkillMd).toBe(`${INTERNAL_SKILL_MD.replace(/\s+$/, "")}\n`);
    expect(await readFile(path.join(agentsDir, "references", "extra.md"), "utf8")).toBe("EXTRA REF");
  });

  // (c) migrate idempotency: a second migrate is a noop against the rendered tree.
  test("migrate idempotency: a second migrate of identical content is a noop", async () => {
    await applyStateMigrations();
    await withDb((db) =>
      migrateSkill({ db, skillId: "first-party", hostId: HOST_ID, agentsInfraRoot, registryPath }),
    );
    const second = await withDb((db) =>
      migrateSkill({ db, skillId: "first-party", hostId: HOST_ID, agentsInfraRoot, registryPath }),
    );
    expect(second.action).toBe("noop");
    expect(second.rematerialize).toBeUndefined();
  });

  // (d) migrate REFUSES a non-internal (external) skill.
  test("migrate refuses a non-internal (external) skill with not_first_party", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      await expect(
        migrateSkill({ db, skillId: "vendored-skill", hostId: HOST_ID, agentsInfraRoot, registryPath }),
      ).rejects.toMatchObject({ code: "not_first_party" });
    });
    // No db row was created and no mirror was written.
    await withDb((db) => {
      expect(readSkillContent(db, HOST_ID, "vendored-skill")).toBeUndefined();
    });
    expect(await readInstallationTree(resolveSkillInstallDir("agents", "vendored-skill"))).toBeUndefined();
  });

  test("migrate not_first_party error lists the valid (internal) skills", async () => {
    await applyStateMigrations();
    await withDb(async (db) => {
      try {
        await migrateSkill({ db, skillId: "vendored-skill", hostId: HOST_ID, agentsInfraRoot, registryPath });
        throw new Error("expected MigrateError");
      } catch (error) {
        expect(error).toBeInstanceOf(MigrateError);
        const suggestions = (error as MigrateError).suggestions.join(" ");
        expect(suggestions).toContain("first-party");
        expect(suggestions).toContain("stays-git");
      }
    });
  });

  // (e) skills show surfaces regime (db on a migrated entry, git default otherwise).
  test("skills show surfaces regime: db for the db-regime entry, git for the default entry", async () => {
    const dbShow = await showSkill("already-db", { registryPath, agentsInfraRoot });
    expect(dbShow.source.regime).toBe("db");

    const gitShow = await showSkill("stays-git", { registryPath, agentsInfraRoot });
    expect(gitShow.source.regime).toBe("git");
  });

  // (f) dry-run writes nothing.
  test("migrate --dry-run reports planned with the hash + payload files and writes NOTHING", async () => {
    await applyStateMigrations();
    const result = await withDb((db) =>
      migrateSkill({ db, skillId: "first-party", hostId: HOST_ID, agentsInfraRoot, registryPath, dryRun: true }),
    );
    expect(result.action).toBe("planned");
    expect(result.dryRun).toBe(true);
    expect(result.contentHash.length).toBeGreaterThan(0);
    expect(result.payloadFiles).toContain("SKILL.md");
    expect(result.rematerialize).toBeUndefined();

    // No db row, no mirror written.
    await withDb((db) => {
      expect(readSkillContent(db, HOST_ID, "first-party")).toBeUndefined();
    });
    expect(await readInstallationTree(resolveSkillInstallDir("agents", "first-party"))).toBeUndefined();
  });

  test("migrate over a previously-migrated entry whose source content CHANGED re-materializes the new content", async () => {
    await applyStateMigrations();
    await withDb((db) =>
      migrateSkill({ db, skillId: "first-party", hostId: HOST_ID, agentsInfraRoot, registryPath }),
    );
    // Seed a DIFFERENT db row content first to simulate drift, then re-migrate
    // from the (unchanged) git source: it should re-materialize to git content.
    await withDb((db) => {
      upsertSkillContent(db, {
        host_id: HOST_ID,
        skill_name: "first-party",
        payload: { "SKILL.md": "STALE DB CONTENT\n" },
        regime: "db",
      });
    });
    const remigrated = await withDb((db) =>
      migrateSkill({ db, skillId: "first-party", hostId: HOST_ID, agentsInfraRoot, registryPath }),
    );
    expect(remigrated.action).toBe("installed");
    const agentsDir = resolveSkillInstallDir("agents", "first-party");
    expect(await readFile(path.join(agentsDir, "SKILL.md"), "utf8")).toBe(
      `${INTERNAL_SKILL_MD.replace(/\s+$/, "")}\n`,
    );
  });

  // (g) FIX 1: idempotency keys by the canonical (normalized) id. Migrating a
  // registry entry whose id has uppercase, then re-migrating identical content,
  // is a noop — and the DB has exactly ONE row under the normalized id (no
  // split-brain, no needless re-write).
  test("migrate of a mixed-case registry id is idempotent and keyed by the normalized id", async () => {
    await applyStateMigrations();
    const first = await withDb((db) =>
      migrateSkill({ db, skillId: "Some-Mixed-Case-Id", hostId: HOST_ID, agentsInfraRoot, registryPath }),
    );
    expect(first.action).toBe("installed");
    // The reported id is the canonical (normalized) one.
    expect(first.skillId).toBe("some-mixed-case-id");

    // A second identical migrate of the SAME mixed-case id is a noop (the read
    // found the canonical row), and does NOT re-materialize.
    const second = await withDb((db) =>
      migrateSkill({ db, skillId: "Some-Mixed-Case-Id", hostId: HOST_ID, agentsInfraRoot, registryPath }),
    );
    expect(second.action).toBe("noop");
    expect(second.rematerialize).toBeUndefined();

    // Exactly one skill_content row, stored under the normalized id.
    await withDb((db) => {
      const rows = listSkillContent(db, { includeTombstoned: true, host_id: HOST_ID }).filter(
        (r) => r.skill_name === "some-mixed-case-id" || r.skill_name === "Some-Mixed-Case-Id",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.skill_name).toBe("some-mixed-case-id");
      // The raw-cased id resolves to NO row (proves the canonical-key fix).
      expect(readSkillContent(db, HOST_ID, "Some-Mixed-Case-Id")).toBeUndefined();
      expect(readSkillContent(db, HOST_ID, "some-mixed-case-id")).toBeDefined();
    });
  });

  // (h) FIX 2: a non-MigrateError on one internal skill (broken source whose
  // SKILL.md is a directory -> EISDIR, a plain Error) is COLLECTED, not fatal —
  // the other internal skills still migrate and the failure is reported.
  test("--all-internal collects a non-MigrateError (broken source) failure without aborting the batch", async () => {
    await applyStateMigrations();
    const result = await withDb((db) =>
      migrateAllInternalSkills({ db, hostId: HOST_ID, agentsInfraRoot, registryPath }),
    );

    // The broken-source skill failed but did not abort the batch.
    const brokenFailure = result.failures.find((f) => f.skillId === "broken-source");
    expect(brokenFailure).toBeDefined();
    expect(brokenFailure!.code).toBe("source_unresolved");

    // The healthy internal skills still migrated (canonical ids reported).
    const installedIds = result.results
      .filter((r) => r.action === "installed")
      .map((r) => r.skillId);
    expect(installedIds).toContain("first-party");
    expect(installedIds).toContain("stays-git");
    expect(installedIds).toContain("some-mixed-case-id");
    // ONLY broken-source failed; every other internal skill landed a result.
    expect(result.failures.map((f) => f.skillId)).toEqual(["broken-source"]);
  });

  // (i) FIX 3: a registry with ONLY external/repo-maintained skills completes
  // with empty results + failures and a clear "none found" note, writing nothing.
  test("--all-internal against a registry with no internal skills returns empty + a note and writes nothing", async () => {
    await applyStateMigrations();
    // A registry whose only entries are non-internal.
    const externalOnlyRegistry = path.join(workRoot, "external-only.json");
    await writeFile(
      externalOnlyRegistry,
      JSON.stringify(
        {
          version: "2026-06-22",
          skills: [
            { id: "vendored-a", source: { type: "external", repo: "https://github.com/x/a", path: "vendored-a" } },
            { id: "repo-b", source: { type: "repo-maintained", repo: "org/repo-b", path: "repo-b" } },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await withDb((db) =>
      migrateAllInternalSkills({ db, hostId: HOST_ID, agentsInfraRoot, registryPath: externalOnlyRegistry }),
    );
    expect(result.results).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
    expect(result.note).toContain("no first-party (internal) skills");

    // Nothing was written to the DB.
    await withDb((db) => {
      expect(listSkillContent(db, { includeTombstoned: true, host_id: HOST_ID })).toHaveLength(0);
    });
  });
});
