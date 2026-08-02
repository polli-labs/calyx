import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ACTIVITY_INDEX_TABLES,
  applyStateMigrations,
  checkActivityIndexSchema,
  countActivityMessages,
  deleteActivityMessagesForSource,
  listActivityAttachmentsForMessageIds,
  listActivityMessagesForActivity,
  listActivitySourceCursors,
  listMalformedActivityMessages,
  openStateStore,
  readActivitySourceCursor,
  readLatestActivityIndexRun,
  recordActivityIndexRun,
  replaceActivityAttachmentsForMessages,
  runStateDoctor,
  STATE_MIGRATIONS,
  summarizeActivityIndexFreshness,
  upsertActivityMessages,
  upsertActivitySourceCursor,
  type ActivityMessageRow,
} from "../state";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;

async function makeStateHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "calyx-activity-index-"));
  return join(root, "state");
}

function makeRow(id: string, overrides: Partial<ActivityMessageRow> = {}): ActivityMessageRow {
  return {
    message_id: `interactive:codex:sess-1:msg:${id}`,
    activity_id: "interactive:codex:sess-1",
    turn_id: "interactive:codex:sess-1:turn:1",
    seq: Number(id),
    origin: "human",
    text: `text ${id}`,
    backend: "codex",
    source_path: "/tmp/sess-1.jsonl",
    source_offset: Number(id) * 100,
    content_hash: `sha256:hash-${id}`,
    classifier_version: "v1.2026.06.02",
    attachment_refs: "[]",
    observed_at: "2026-06-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("activity recall index (migration 0013)", () => {
  let stateHome: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const k of ENV_KEYS) delete process.env[k];
    stateHome = await makeStateHome();
    process.env["CALYX_STATE_HOME"] = stateHome;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const parent = stateHome.replace(/\/state$/, "");
    await rm(parent, { recursive: true, force: true });
  });

  test("STATE_MIGRATIONS includes 0013 in order after 0012", () => {
    const ids = STATE_MIGRATIONS.map((m) => m.id);
    expect(ids).toContain("0013");
    expect(ids.indexOf("0013")).toBeGreaterThan(ids.indexOf("0012"));
  });

  test("ACTIVITY_INDEX_TABLES enumerates the recall tables", () => {
    const names = ACTIVITY_INDEX_TABLES.map((t) => t.table);
    expect(names).toEqual([
      "activity_messages",
      "activity_attachments",
      "activity_source_cursors",
      "activity_index_runs",
    ]);
  });

  test("applyStateMigrations creates the recall tables and indexes", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      const parity = checkActivityIndexSchema(opened.db);
      expect(parity.status).toBe("ok");
      expect(parity.findings).toEqual([]);
    } finally {
      opened.db.close();
    }
  });

  test("upsert is idempotent and reports changed rows by content_hash", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      const rows = [makeRow("1"), makeRow("2")];
      const first = upsertActivityMessages(opened.db, rows);
      expect(first).toEqual({ upserted: 2, changed: 2 });
      expect(countActivityMessages(opened.db)).toBe(2);

      // Re-upserting identical rows changes nothing.
      const second = upsertActivityMessages(opened.db, rows);
      expect(second.changed).toBe(0);
      expect(countActivityMessages(opened.db)).toBe(2);

      // A content-hash flip on the same id counts as one change, no new row.
      const reclassified = [makeRow("1", { content_hash: "sha256:new", text: "edited" })];
      const third = upsertActivityMessages(opened.db, reclassified);
      expect(third.changed).toBe(1);
      expect(countActivityMessages(opened.db)).toBe(2);
      const stored = listActivityMessagesForActivity(opened.db, "interactive:codex:sess-1");
      expect(stored.find((r) => r.seq === 1)?.text).toBe("edited");
      // Ordered by seq.
      expect(stored.map((r) => r.seq)).toEqual([1, 2]);
    } finally {
      opened.db.close();
    }
  });

  test("0014 reconstruction fields and attachment metadata round-trip", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      const payload = JSON.stringify({
        schema_version: "activity.message-payload/v1",
        classification: {
          rule_id: "human/user-message",
          reason: "Raw user-role message.",
          source_role: "user",
          source_kind: "message",
        },
        event_refs: [1],
        source_lines: [2],
      });
      const row = makeRow("1", {
        timestamp: "2026-06-19T00:00:01.000Z",
        payload_json: payload,
        attachment_refs: JSON.stringify(["att:sha256:abc"]),
      });
      upsertActivityMessages(opened.db, [row]);
      replaceActivityAttachmentsForMessages(opened.db, [row.message_id], [
        {
          attachment_id: `${row.message_id}:att:abc`,
          message_id: row.message_id,
          origin: "human",
          sha256: "abc",
          mime: "image/png",
          byte_size: 123,
          observed_at: "2026-06-19T00:00:02.000Z",
        },
      ]);

      const stored = listActivityMessagesForActivity(opened.db, row.activity_id);
      expect(stored[0]?.timestamp).toBe("2026-06-19T00:00:01.000Z");
      expect(stored[0]?.payload_json).toBe(payload);
      expect(listActivityAttachmentsForMessageIds(opened.db, [row.message_id])).toEqual([
        {
          attachment_id: `${row.message_id}:att:abc`,
          message_id: row.message_id,
          origin: "human",
          sha256: "abc",
          mime: "image/png",
          byte_size: 123,
          observed_at: "2026-06-19T00:00:02.000Z",
        },
      ]);

      replaceActivityAttachmentsForMessages(opened.db, [row.message_id], []);
      expect(listActivityAttachmentsForMessageIds(opened.db, [row.message_id])).toEqual([]);
    } finally {
      opened.db.close();
    }
  });

  test("source cursor + index run round-trip and freshness summary", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      upsertActivityMessages(opened.db, [makeRow("1"), makeRow("2")]);
      upsertActivitySourceCursor(opened.db, {
        source_path: "/tmp/sess-1.jsonl",
        backend: "codex",
        activity_id: "interactive:codex:sess-1",
        byte_offset: 200,
        next_line: 3,
        resume_offset: 100,
        resume_line: 2,
        size_bytes: 350,
        mtime_ms: 1_000,
        classifier_version: "v1.2026.06.02",
        message_count: 2,
        updated_at: "2026-06-19T00:00:00.000Z",
        last_indexed_at: "2026-06-19T00:00:00.000Z",
      });
      const cursor = readActivitySourceCursor(opened.db, "/tmp/sess-1.jsonl");
      expect(cursor?.byte_offset).toBe(200);
      expect(cursor?.next_line).toBe(3);
      expect(cursor?.resume_offset).toBe(100);
      expect(cursor?.resume_line).toBe(2);
      expect(listActivitySourceCursors(opened.db)).toHaveLength(1);

      recordActivityIndexRun(opened.db, {
        run_id: "2026-06-19T00:00:01.000Z:interval",
        host: "carbon",
        trigger: "interval",
        started_at: "2026-06-19T00:00:00.000Z",
        finished_at: "2026-06-19T00:00:01.000Z",
        status: "ok",
        sources_scanned: 1,
        sources_changed: 1,
        sources_pending: 1,
        messages_upserted: 2,
        bytes_ingested: 200,
        indexed_through: "2026-06-19T00:00:00.000Z",
        classifier_version: "v1.2026.06.02",
      });
      expect(readLatestActivityIndexRun(opened.db)?.run_id).toBe(
        "2026-06-19T00:00:01.000Z:interval",
      );

      const freshness = summarizeActivityIndexFreshness(opened.db);
      expect(freshness.message_count).toBe(2);
      expect(freshness.source_count).toBe(1);
      // size_bytes (350) > byte_offset (200) => one pending source.
      expect(freshness.pending_sources).toBe(1);
      expect(freshness.indexed_through).toBe("2026-06-19T00:00:00.000Z");
    } finally {
      opened.db.close();
    }
  });

  test("deleteActivityMessagesForSource evicts a source for rebuild", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      upsertActivityMessages(opened.db, [makeRow("1"), makeRow("2")]);
      const result = deleteActivityMessagesForSource(opened.db, "/tmp/sess-1.jsonl");
      expect(result.deleted).toBe(2);
      expect(countActivityMessages(opened.db)).toBe(0);
    } finally {
      opened.db.close();
    }
  });

  test("malformed-row scan flags structural corruption", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      upsertActivityMessages(opened.db, [
        makeRow("1"),
        makeRow("2", { content_hash: "" }),
        makeRow("3", { attachment_refs: "not-json" }),
        makeRow("4", { payload_json: "not-json" }),
      ]);
      const findings = listMalformedActivityMessages(opened.db);
      const codes = findings.map((f) => f.code).sort();
      expect(codes).toContain("blank-content-hash");
      expect(codes).toContain("invalid-attachment-refs");
      expect(codes).toContain("invalid-payload-json");
    } finally {
      opened.db.close();
    }
  });

  test("doctor reports the activity domain green when applied", async () => {
    await applyStateMigrations();
    const report = await runStateDoctor({ domains: ["activity"] });
    expect(report.activityIndex.migrationApplied).toBe(true);
    expect(report.activityIndex.schemaParity).toBe("ok");
    expect(report.findings.some((f) => f.code === "activity-index-schema")).toBe(false);
    const domain = report.domains?.find((d) => d.domain === "activity");
    expect(domain?.status).toBe("ok");
    expect(report.ok).toBe(true);
  });

  test("doctor reports activity schema drift when a table is dropped", async () => {
    await applyStateMigrations();
    {
      const opened = await openStateStore();
      try {
        opened.db.exec("DROP TABLE activity_messages");
      } finally {
        opened.db.close();
      }
    }
    const report = await runStateDoctor({ domains: ["activity"] });
    expect(report.activityIndex.schemaParity).toBe("drift");
    expect(report.findings.some((f) => f.code === "activity-index-schema")).toBe(true);
    const domain = report.domains?.find((d) => d.domain === "activity");
    expect(domain?.status).toBe("drift");
    expect(report.ok).toBe(false);
  });

  test("doctor flags malformed activity rows as blocking", async () => {
    await applyStateMigrations();
    {
      const opened = await openStateStore();
      try {
        upsertActivityMessages(opened.db, [makeRow("1", { content_hash: "" })]);
      } finally {
        opened.db.close();
      }
    }
    const report = await runStateDoctor({ domains: ["activity"] });
    expect(report.activityIndex.malformed.length).toBeGreaterThan(0);
    expect(
      report.findings.some((f) => f.code === "activity-index-blank-content-hash"),
    ).toBe(true);
    expect(report.ok).toBe(false);
  });
});
