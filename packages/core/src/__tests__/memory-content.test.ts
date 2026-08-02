import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  applyStateMigrations,
  checkMemoryContentSchema,
  countMemoryContent,
  countMemoryWriteLog,
  hashMemoryValue,
  listMalformedMemoryContent,
  listMemoryContent,
  listMemoryWriteLog,
  MEMORY_CONTENT_TABLES,
  MEMORY_TOMBSTONE_CONTENT_HASH,
  MemoryReviewAborted,
  openStateStore,
  planStateMigrations,
  readMemoryContent,
  runStateDoctor,
  searchMemoryContent,
  setMemoryReviewStatus,
  STATE_MIGRATIONS,
  tombstoneMemoryContent,
  upsertMemoryContent,
} from "../state";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;
const HOST = "testhost";

describe("memory content state (migration 0018)", () => {
  let workRoot: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const k of ENV_KEYS) delete process.env[k];
    workRoot = await mkdtemp(join(tmpdir(), "calyx-memory-content-"));
    process.env["CALYX_STATE_HOME"] = join(workRoot, "state");
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(workRoot, { recursive: true, force: true });
  });

  test("migration 0018 is pending on a fresh DB and applies idempotently", async () => {
    const plan = await planStateMigrations();
    expect(plan.pending.map((p) => p.id)).toContain("0018");
    const apply = await applyStateMigrations();
    expect(apply.applied.map((m) => m.id)).toContain("0018");
    const second = await applyStateMigrations();
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.map((m) => m.id)).toContain("0018");
    expect(STATE_MIGRATIONS.map((m) => m.id)).toContain("0018");
  });

  test("MEMORY_CONTENT_TABLES enumerates the two tables", () => {
    const names = MEMORY_CONTENT_TABLES.map((t) => t.table).sort();
    expect(names).toEqual(["memory_content", "memory_write_log"]);
  });

  test("doctor reports memory_content schema parity green on a clean database", async () => {
    await applyStateMigrations();
    const report = await runStateDoctor();
    expect(report.memoryContent.migrationApplied).toBe(true);
    expect(report.memoryContent.schemaParity).toBe("ok");
    expect(report.memoryContent.schemaFindings).toEqual([]);
    expect(report.findings.some((f) => f.code === "memory-content-schema")).toBe(false);
    expect(report.ok).toBe(true);
  });

  test("doctor reports schema drift when memory_write_log is dropped", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      opened.db.exec("DROP TABLE memory_write_log");
    } finally {
      opened.db.close();
    }
    const report = await runStateDoctor();
    expect(report.memoryContent.schemaParity).toBe("drift");
    expect(report.findings.some((f) => f.code === "memory-content-schema")).toBe(true);
    expect(report.ok).toBe(false);
  });

  test("--domain memory_content resolves to a real domain", async () => {
    await applyStateMigrations();
    const report = await runStateDoctor({ domains: ["memory_content"] });
    const result = report.domains!.find((d) => d.domain === "memory_content")!;
    expect(result.status).toBe("ok");
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("a write lands PENDING (not approved/active) and seeds a write_log row in one transaction", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      const row = upsertMemoryContent(opened.db, {
        host_id: HOST,
        memory_key: "caleb-prefers-organic",
        value: "Caleb prefers organic shapes over glassmorphism.",
        category: "user",
        author: "claude:test",
        summary: "design preference",
        origin_activity_id: "interactive:codex:abc",
      });
      // STRICT POSTURE: a write is NOT active. It lands pending, unapproved.
      expect(row.review_status).toBe("pending");
      expect(row.approved_at).toBeNull();
      expect(row.deleted_at).toBeNull();
      expect(row.category).toBe("user");
      expect(row.content_hash).toBe(hashMemoryValue("Caleb prefers organic shapes over glassmorphism."));
      expect(row.value).toContain("organic");

      const log = listMemoryWriteLog(opened.db, "caleb-prefers-organic");
      expect(log).toHaveLength(1);
      expect(log[0]!.write_class).toBe("write");
      expect(log[0]!.review_status).toBe("pending");
      expect(log[0]!.content_hash).toBe(row.content_hash);
      expect(log[0]!.origin_activity_id).toBe("interactive:codex:abc");
    } finally {
      opened.db.close();
    }
  });

  test("approve transitions pending -> approved and stamps approved_at; reject -> rejected", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      upsertMemoryContent(opened.db, { host_id: HOST, memory_key: "k1", value: "fact one", category: "reference" });
      const approved = setMemoryReviewStatus(opened.db, { host_id: HOST, memory_key: "k1", status: "approved", actor: "caleb" });
      expect(approved.review_status).toBe("approved");
      expect(approved.approved_at).not.toBeNull();

      upsertMemoryContent(opened.db, { host_id: HOST, memory_key: "k2", value: "fact two", category: "reference" });
      const rejected = setMemoryReviewStatus(opened.db, { host_id: HOST, memory_key: "k2", status: "rejected", actor: "caleb" });
      expect(rejected.review_status).toBe("rejected");
      expect(rejected.approved_at).toBeNull();

      // write_log captures the review transitions.
      expect(listMemoryWriteLog(opened.db, "k1").map((l) => l.write_class)).toEqual(["write", "approve"]);
      expect(listMemoryWriteLog(opened.db, "k2").map((l) => l.write_class)).toEqual(["write", "reject"]);
    } finally {
      opened.db.close();
    }
  });

  test("approve refuses an unknown key (MemoryReviewAborted not_found)", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      expect(() => setMemoryReviewStatus(opened.db, { host_id: HOST, memory_key: "ghost", status: "approved" })).toThrow(
        MemoryReviewAborted,
      );
    } finally {
      opened.db.close();
    }
  });

  test("approve CAS refuses on content_hash drift", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      const v1 = upsertMemoryContent(opened.db, { host_id: HOST, memory_key: "k", value: "v1", category: "user" });
      // A newer write lands, changing content_hash and resetting review to pending.
      upsertMemoryContent(opened.db, { host_id: HOST, memory_key: "k", value: "v2", category: "user" });
      let aborted: MemoryReviewAborted | undefined;
      try {
        setMemoryReviewStatus(opened.db, { host_id: HOST, memory_key: "k", status: "approved", expected_content_hash: v1.content_hash });
      } catch (err) {
        aborted = err as MemoryReviewAborted;
      }
      expect(aborted).toBeInstanceOf(MemoryReviewAborted);
      expect(aborted!.code).toBe("concurrent_write");
      // The fact is still pending (the stale approval did not land).
      expect(readMemoryContent(opened.db, HOST, "k")!.review_status).toBe("pending");
    } finally {
      opened.db.close();
    }
  });

  test("a re-write of an approved fact resets it to pending (re-approval required)", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      upsertMemoryContent(opened.db, { host_id: HOST, memory_key: "k", value: "v1", category: "user" });
      setMemoryReviewStatus(opened.db, { host_id: HOST, memory_key: "k", status: "approved" });
      expect(readMemoryContent(opened.db, HOST, "k")!.review_status).toBe("approved");

      const v2 = upsertMemoryContent(opened.db, { host_id: HOST, memory_key: "k", value: "v2", category: "user" });
      expect(v2.value).toBe("v2");
      expect(v2.review_status).toBe("pending");
      expect(v2.approved_at).toBeNull();
      expect(listMemoryWriteLog(opened.db, "k").map((l) => l.write_class)).toEqual(["write", "approve", "write"]);
    } finally {
      opened.db.close();
    }
  });

  test("get/list/search round-trip; status + category filters work", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      upsertMemoryContent(opened.db, { host_id: HOST, memory_key: "ein", value: "Polli Labs Inc EIN is 93-4073368.", category: "reference", summary: "tax id" });
      upsertMemoryContent(opened.db, { host_id: HOST, memory_key: "caleb-pref", value: "Prefers terse noun-forward UI copy.", category: "user" });
      setMemoryReviewStatus(opened.db, { host_id: HOST, memory_key: "caleb-pref", status: "approved" });

      // get
      expect(readMemoryContent(opened.db, HOST, "ein")!.value).toContain("93-4073368");

      // list all live
      expect(listMemoryContent(opened.db, {}).map((r) => r.memory_key).sort()).toEqual(["caleb-pref", "ein"]);
      // category filter
      expect(listMemoryContent(opened.db, { category: "reference" }).map((r) => r.memory_key)).toEqual(["ein"]);
      // review_status filter
      expect(listMemoryContent(opened.db, { review_status: "approved" }).map((r) => r.memory_key)).toEqual(["caleb-pref"]);
      expect(listMemoryContent(opened.db, { review_status: "pending" }).map((r) => r.memory_key)).toEqual(["ein"]);

      // search: by substring in value (case-insensitive)
      expect(searchMemoryContent(opened.db, HOST, "ein is").map((r) => r.memory_key)).toEqual(["ein"]);
      // search: by substring in key
      expect(searchMemoryContent(opened.db, HOST, "caleb").map((r) => r.memory_key)).toEqual(["caleb-pref"]);
      // search: by substring in summary
      expect(searchMemoryContent(opened.db, HOST, "tax id").map((r) => r.memory_key)).toEqual(["ein"]);
      // search: status filter applies
      expect(searchMemoryContent(opened.db, HOST, "prefers", { review_status: "approved" }).map((r) => r.memory_key)).toEqual(["caleb-pref"]);
      expect(searchMemoryContent(opened.db, HOST, "prefers", { review_status: "pending" })).toEqual([]);
      // search: a literal % is escaped, not treated as a wildcard
      expect(searchMemoryContent(opened.db, HOST, "%")).toEqual([]);
    } finally {
      opened.db.close();
    }
  });

  test("delete tombstones (clears value, resets review to pending), excluded from list by default; a re-write recreates", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      upsertMemoryContent(opened.db, { host_id: HOST, memory_key: "k", value: "to be retired", category: "project" });
      setMemoryReviewStatus(opened.db, { host_id: HOST, memory_key: "k", status: "approved" });

      const tomb = tombstoneMemoryContent(opened.db, { host_id: HOST, memory_key: "k", summary: "retired" });
      expect(tomb.deleted_at).not.toBeNull();
      expect(tomb.value).toBe("");
      expect(tomb.review_status).toBe("pending");
      expect(tomb.content_hash).toBe(MEMORY_TOMBSTONE_CONTENT_HASH);

      const log = listMemoryWriteLog(opened.db, "k");
      expect(log.map((l) => l.write_class)).toEqual(["write", "approve", "delete"]);

      // excluded by default; included on request
      expect(listMemoryContent(opened.db, {}).find((r) => r.memory_key === "k")).toBeUndefined();
      expect(listMemoryContent(opened.db, { includeTombstoned: true }).find((r) => r.memory_key === "k")).toBeDefined();

      // re-write over the tombstone recreates the live row (back to pending).
      const recreated = upsertMemoryContent(opened.db, { host_id: HOST, memory_key: "k", value: "v-new", category: "project" });
      expect(recreated.deleted_at).toBeNull();
      expect(recreated.value).toBe("v-new");
      expect(recreated.review_status).toBe("pending");
      expect(listMemoryWriteLog(opened.db, "k").map((l) => l.write_class)).toEqual(["write", "approve", "delete", "write"]);
    } finally {
      opened.db.close();
    }
  });

  test("composite PK (host_id, memory_key): same key on two hosts are distinct rows", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      upsertMemoryContent(opened.db, { host_id: "hostA", memory_key: "shared", value: "A-value", category: "reference" });
      upsertMemoryContent(opened.db, { host_id: "hostB", memory_key: "shared", value: "B-value", category: "reference" });
      expect(readMemoryContent(opened.db, "hostA", "shared")!.value).toBe("A-value");
      expect(readMemoryContent(opened.db, "hostB", "shared")!.value).toBe("B-value");
      expect(listMemoryContent(opened.db, { host_id: "hostA" })).toHaveLength(1);
    } finally {
      opened.db.close();
    }
  });

  test("content_hash is deterministic and stable for the same value", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      const a = upsertMemoryContent(opened.db, { host_id: HOST, memory_key: "k1", value: "identical fact", category: "user" });
      const b = upsertMemoryContent(opened.db, { host_id: HOST, memory_key: "k2", value: "identical fact", category: "user" });
      expect(a.content_hash).toBe(b.content_hash);
      expect(a.content_hash).toBe(hashMemoryValue("identical fact"));
    } finally {
      opened.db.close();
    }
  });

  test("counts + write-log totals reflect live/tombstoned/review-status/category", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      upsertMemoryContent(opened.db, { host_id: HOST, memory_key: "u1", value: "a", category: "user" });
      upsertMemoryContent(opened.db, { host_id: HOST, memory_key: "r1", value: "b", category: "reference" });
      setMemoryReviewStatus(opened.db, { host_id: HOST, memory_key: "r1", status: "approved" });
      tombstoneMemoryContent(opened.db, { host_id: HOST, memory_key: "dead" });

      const counts = countMemoryContent(opened.db);
      expect(counts.live).toBe(2);
      expect(counts.tombstoned).toBe(1);
      expect(counts.byReviewStatus["pending"]).toBe(1);
      expect(counts.byReviewStatus["approved"]).toBe(1);
      expect(counts.byCategory["user"]).toBe(1);
      expect(counts.byCategory["reference"]).toBe(1);
      // write(u1) + write(r1) + approve(r1) + delete(dead) = 4
      expect(countMemoryWriteLog(opened.db)).toBe(4);
    } finally {
      opened.db.close();
    }
  });

  test("doctor flags a malformed live row with an empty value", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      // Insert a live row whose value is empty, bypassing the helper (which would
      // never produce one for a live row).
      opened.db
        .prepare(
          `INSERT INTO memory_content
             (host_id, memory_key, value, content_hash, category, review_status, pinned, deleted_at, created_at, updated_at)
           VALUES (?, ?, '', ?, 'user', 'pending', 0, NULL, ?, ?)`,
        )
        .run(HOST, "broken", "deadbeef", "t", "t");
      const malformed = listMalformedMemoryContent(opened.db);
      expect(malformed.some((f) => f.code === "live-empty-value")).toBe(true);
      expect(checkMemoryContentSchema(opened.db).status).toBe("ok");
    } finally {
      opened.db.close();
    }
  });
});
