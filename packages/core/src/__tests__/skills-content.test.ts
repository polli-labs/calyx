import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  applyStateMigrations,
  checkSkillContentSchema,
  countSkillContent,
  countSkillWriteLog,
  hashSkillPayload,
  listMalformedSkillContent,
  listSkillContent,
  listSkillWriteLog,
  openStateStore,
  planStateMigrations,
  readSkillContent,
  runStateDoctor,
  SKILL_CONTENT_TABLES,
  STATE_MIGRATIONS,
  stampMaterialized,
  tombstoneSkillContent,
  TOMBSTONE_CONTENT_HASH,
  upsertSkillContent,
} from "../state";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;
const HOST = "testhost";

describe("skill content state (migration 0016)", () => {
  let workRoot: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const k of ENV_KEYS) delete process.env[k];
    workRoot = await mkdtemp(join(tmpdir(), "calyx-skill-content-"));
    process.env["CALYX_STATE_HOME"] = join(workRoot, "state");
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(workRoot, { recursive: true, force: true });
  });

  test("migration 0016 is pending on a fresh DB and applies idempotently", async () => {
    const plan = await planStateMigrations();
    expect(plan.pending.map((p) => p.id)).toContain("0016");
    const apply = await applyStateMigrations();
    expect(apply.applied.map((m) => m.id)).toContain("0016");
    const second = await applyStateMigrations();
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.map((m) => m.id)).toContain("0016");
    expect(STATE_MIGRATIONS.map((m) => m.id)).toContain("0016");
  });

  test("migration 0019 forward-repairs a ledger whose conflicting 0017 skipped the pinned fence", async () => {
    const migrationsThroughSkillContent = STATE_MIGRATIONS.filter(
      (migration) => migration.id <= "0016",
    );
    await applyStateMigrations({ migrations: migrationsThroughSkillContent });

    const opened = await openStateStore();
    try {
      const memoryMigration = STATE_MIGRATIONS.find((migration) => migration.id === "0018")!;
      opened.db.exec("BEGIN IMMEDIATE");
      try {
        // Reproduce the conflicting historical 0017 body before recording its ledger row.
        const monitorColumns = new Set(
          (opened.db.prepare("PRAGMA table_info(monitors)").all() as Array<{ name: string }>)
            .map((column) => column.name),
        );
        if (!monitorColumns.has("action_json")) {
          opened.db.exec("ALTER TABLE monitors ADD COLUMN action_json TEXT");
        }
        if (!monitorColumns.has("expires_at")) {
          opened.db.exec("ALTER TABLE monitors ADD COLUMN expires_at TEXT");
        }
        if (!monitorColumns.has("max_wakes")) {
          opened.db.exec("ALTER TABLE monitors ADD COLUMN max_wakes INTEGER");
        }
        if (!monitorColumns.has("wake_count")) {
          opened.db.exec(
            "ALTER TABLE monitors ADD COLUMN wake_count INTEGER NOT NULL DEFAULT 0",
          );
        }
        opened.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_monitors_expires_at
            ON monitors(expires_at);
        `);

        const wakeColumns = new Set(
          (opened.db.prepare("PRAGMA table_info(monitor_wakes)").all() as Array<{ name: string }>)
            .map((column) => column.name),
        );
        if (!wakeColumns.has("action_result_json")) {
          opened.db.exec("ALTER TABLE monitor_wakes ADD COLUMN action_result_json TEXT");
        }

        opened.db
          .prepare(
            `INSERT INTO schema_migrations (id, description, applied_at) VALUES (?, ?, ?)`,
          )
          .run(
            "0017",
            "monitor scheduled probes: action descriptors, wake action results, and self-retire bounds (POL-1876)",
            "2026-06-22T07:23:46.783Z",
          );
        memoryMigration.up(opened.db);
        opened.db
          .prepare(
            `INSERT INTO schema_migrations (id, description, applied_at) VALUES (?, ?, ?)`,
          )
          .run("0018", memoryMigration.description, "2026-06-23T22:07:37.801Z");
        opened.db.exec("COMMIT");
      } catch (error) {
        opened.db.exec("ROLLBACK");
        throw error;
      }

      const historicalMonitorColumns = opened.db
        .prepare("PRAGMA table_info(monitors)")
        .all() as Array<{ name: string }>;
      const historicalMonitorIndexes = opened.db
        .prepare("PRAGMA index_list(monitors)")
        .all() as Array<{ name: string }>;
      const historicalWakeColumns = opened.db
        .prepare("PRAGMA table_info(monitor_wakes)")
        .all() as Array<{ name: string }>;
      expect(historicalMonitorColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["action_json", "expires_at", "max_wakes", "wake_count"]),
      );
      expect(historicalMonitorIndexes.map((index) => index.name)).toContain(
        "idx_monitors_expires_at",
      );
      expect(historicalWakeColumns.map((column) => column.name)).toContain(
        "action_result_json",
      );
    } finally {
      opened.db.close();
    }

    const repairPlan = await planStateMigrations();
    expect(repairPlan.pending.map((migration) => migration.id)).toEqual([
      "0019",
      "0020",
      "0021",
      "0022",
      "0023",
      "0024",
      "0025",
      "0026",
      "0027",
      "0028",
      "0029",
      "0030",
      "0031",
      "0032",
      "0033",
      "0034",
      "0035",
    ]);

    const before = await runStateDoctor();
    expect(before.ok).toBe(false);
    expect(before.pendingMigrations).toBe(17);
    expect(before.skillContent.schemaParity).toBe("drift");
    expect(before.skillContent.schemaFindings).toContainEqual(
      expect.objectContaining({ table: "skill_content", code: "missing-column" }),
    );
    expect(before.findings).toContainEqual({
      code: "pending-migrations",
      severity: "error",
      message:
        "17 migration(s) pending; run `calyx state migrate --plan`, inspect the pending migrations, then run `calyx state migrate --apply`.",
    });

    const applied = await applyStateMigrations();
    expect(applied.applied.map((migration) => migration.id)).toEqual([
      "0019",
      "0020",
      "0021",
      "0022",
      "0023",
      "0024",
      "0025",
      "0026",
      "0027",
      "0028",
      "0029",
      "0030",
      "0031",
      "0032",
      "0033",
      "0034",
      "0035",
    ]);

    const repaired = await openStateStore();
    try {
      const columns = repaired.db.prepare("PRAGMA table_info(skill_content)").all() as Array<{
        name: string;
      }>;
      const indexes = repaired.db.prepare("PRAGMA index_list(skill_content)").all() as Array<{
        name: string;
      }>;
      const historicalMonitorColumns = repaired.db
        .prepare("PRAGMA table_info(monitors)")
        .all() as Array<{ name: string }>;
      const historicalMonitorIndexes = repaired.db
        .prepare("PRAGMA index_list(monitors)")
        .all() as Array<{ name: string }>;
      const historicalWakeColumns = repaired.db
        .prepare("PRAGMA table_info(monitor_wakes)")
        .all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("pinned");
      expect(indexes.map((index) => index.name)).toContain("idx_skill_content_pinned");
      expect(historicalMonitorColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["action_json", "expires_at", "max_wakes", "wake_count"]),
      );
      expect(historicalMonitorIndexes.map((index) => index.name)).toContain(
        "idx_monitors_expires_at",
      );
      expect(historicalWakeColumns.map((column) => column.name)).toContain(
        "action_result_json",
      );
    } finally {
      repaired.db.close();
    }

    const after = await runStateDoctor();
    expect(after.ok).toBe(true);
    expect(after.pendingMigrations).toBe(0);
    expect(after.skillContent.schemaParity).toBe("ok");
  });

  test("SKILL_CONTENT_TABLES enumerates the two tables", () => {
    const names = SKILL_CONTENT_TABLES.map((t) => t.table).sort();
    expect(names).toEqual(["skill_content", "skill_write_log"]);
  });

  test("doctor reports skill_content schema parity green on a clean database", async () => {
    await applyStateMigrations();
    const report = await runStateDoctor();
    expect(report.skillContent.migrationApplied).toBe(true);
    expect(report.skillContent.schemaParity).toBe("ok");
    expect(report.skillContent.schemaFindings).toEqual([]);
    expect(report.findings.some((f) => f.code === "skill-content-schema")).toBe(false);
    expect(report.ok).toBe(true);
  });

  test("doctor reports schema drift when skill_write_log is dropped", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      opened.db.exec("DROP TABLE skill_write_log");
    } finally {
      opened.db.close();
    }
    const report = await runStateDoctor();
    expect(report.skillContent.schemaParity).toBe("drift");
    expect(report.findings.some((f) => f.code === "skill-content-schema")).toBe(true);
    expect(report.ok).toBe(false);
  });

  test("--domain skill_content resolves to a real domain", async () => {
    await applyStateMigrations();
    const report = await runStateDoctor({ domains: ["skill_content"] });
    const result = report.domains!.find((d) => d.domain === "skill_content")!;
    expect(result.status).toBe("ok");
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("upsertSkillContent seeds the row + a write_log row in one transaction", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      const payload = { "SKILL.md": "---\ntitle: T\n---\nbody" };
      const row = upsertSkillContent(opened.db, {
        host_id: HOST,
        skill_name: "my-skill",
        payload,
        author: "claude:test",
        summary: "first draft",
        origin_activity_id: "interactive:codex:abc",
      });
      expect(row.regime).toBe("db");
      expect(row.deleted_at).toBeNull();
      expect(row.content_hash).toBe(hashSkillPayload(payload));
      expect(row.materialized_at).toBeNull();
      expect(row.payload["SKILL.md"]).toContain("body");

      const log = listSkillWriteLog(opened.db, "my-skill");
      expect(log).toHaveLength(1);
      expect(log[0]!.write_class).toBe("write");
      expect(log[0]!.content_hash).toBe(row.content_hash);
      expect(log[0]!.origin_activity_id).toBe("interactive:codex:abc");
    } finally {
      opened.db.close();
    }
  });

  test("a second write (edit) updates content + appends a second write_log row, clearing the stamp", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      upsertSkillContent(opened.db, { host_id: HOST, skill_name: "s", payload: { "SKILL.md": "v1" } });
      // simulate a materialize stamp on v1
      const v1 = readSkillContent(opened.db, HOST, "s")!;
      expect(stampMaterialized(opened.db, HOST, "s", v1.content_hash)).toBe(true);
      expect(readSkillContent(opened.db, HOST, "s")!.materialized_at).not.toBeNull();

      const v2 = upsertSkillContent(opened.db, { host_id: HOST, skill_name: "s", payload: { "SKILL.md": "v2" } });
      expect(v2.payload["SKILL.md"]).toBe("v2");
      expect(v2.content_hash).not.toBe(v1.content_hash);
      // A new write resets the stamp (the new content has not been materialized).
      expect(v2.materialized_at).toBeNull();
      expect(listSkillWriteLog(opened.db, "s")).toHaveLength(2);
    } finally {
      opened.db.close();
    }
  });

  test("tombstoneSkillContent clears payload, sets deleted_at, and logs a delete", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      upsertSkillContent(opened.db, { host_id: HOST, skill_name: "s", payload: { "SKILL.md": "v1", "ref.md": "x" } });
      const tomb = tombstoneSkillContent(opened.db, { host_id: HOST, skill_name: "s", summary: "retired" });
      expect(tomb.deleted_at).not.toBeNull();
      expect(tomb.payload).toEqual({});
      expect(tomb.content_hash).toBe(TOMBSTONE_CONTENT_HASH);

      const log = listSkillWriteLog(opened.db, "s");
      expect(log.map((l) => l.write_class)).toEqual(["write", "delete"]);

      // listSkillContent excludes tombstones by default, includes them on request.
      expect(listSkillContent(opened.db, {}).find((r) => r.skill_name === "s")).toBeUndefined();
      expect(
        listSkillContent(opened.db, { includeTombstoned: true }).find((r) => r.skill_name === "s"),
      ).toBeDefined();
    } finally {
      opened.db.close();
    }
  });

  test("tombstone then write same name recreates the live row (PK allows it)", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      upsertSkillContent(opened.db, { host_id: HOST, skill_name: "s", payload: { "SKILL.md": "v1" } });
      tombstoneSkillContent(opened.db, { host_id: HOST, skill_name: "s" });
      const recreated = upsertSkillContent(opened.db, { host_id: HOST, skill_name: "s", payload: { "SKILL.md": "v3" } });
      expect(recreated.deleted_at).toBeNull();
      expect(recreated.payload["SKILL.md"]).toBe("v3");
      expect(listSkillWriteLog(opened.db, "s").map((l) => l.write_class)).toEqual([
        "write",
        "delete",
        "write",
      ]);
    } finally {
      opened.db.close();
    }
  });

  test("stampMaterialized is a CAS no-op when the content_hash is stale (contract #9)", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      const v1 = upsertSkillContent(opened.db, { host_id: HOST, skill_name: "s", payload: { "SKILL.md": "v1" } });
      // A newer write lands, changing content_hash.
      upsertSkillContent(opened.db, { host_id: HOST, skill_name: "s", payload: { "SKILL.md": "v2" } });
      // Stamping with the STALE v1 hash must change 0 rows and not error.
      expect(stampMaterialized(opened.db, HOST, "s", v1.content_hash)).toBe(false);
      expect(readSkillContent(opened.db, HOST, "s")!.materialized_at).toBeNull();
      // Stamping with the current hash succeeds.
      const current = readSkillContent(opened.db, HOST, "s")!;
      expect(stampMaterialized(opened.db, HOST, "s", current.content_hash)).toBe(true);
      expect(readSkillContent(opened.db, HOST, "s")!.materialized_at).not.toBeNull();
    } finally {
      opened.db.close();
    }
  });

  test("counts + write-log totals reflect live/tombstoned rows", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      upsertSkillContent(opened.db, { host_id: HOST, skill_name: "live-1", payload: { "SKILL.md": "a" } });
      upsertSkillContent(opened.db, { host_id: HOST, skill_name: "live-2", payload: { "SKILL.md": "b" } });
      tombstoneSkillContent(opened.db, { host_id: HOST, skill_name: "dead-1" });
      const counts = countSkillContent(opened.db);
      expect(counts.live).toBe(2);
      expect(counts.tombstoned).toBe(1);
      expect(counts.byRegime["db"]).toBe(3);
      expect(countSkillWriteLog(opened.db)).toBe(3);
    } finally {
      opened.db.close();
    }
  });

  test("doctor flags a malformed live row missing SKILL.md", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      // Insert a live row whose payload has no SKILL.md entry, bypassing the
      // helper (which would never produce one).
      opened.db
        .prepare(
          `INSERT INTO skill_content
             (host_id, skill_name, content_hash, regime, payload_json, deleted_at, created_at, updated_at)
           VALUES (?, ?, ?, 'db', ?, NULL, ?, ?)`,
        )
        .run(HOST, "broken", "deadbeef", JSON.stringify({ "ref.md": "x" }), "t", "t");
      const malformed = listMalformedSkillContent(opened.db);
      expect(malformed.some((f) => f.code === "live-missing-skill-md")).toBe(true);
      expect(checkSkillContentSchema(opened.db).status).toBe("ok");
    } finally {
      opened.db.close();
    }
  });
});
