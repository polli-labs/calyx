import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ACTIVITY_INDEX_TABLES,
  ACTIVITY_MARKS_TABLES,
  ACTIVITY_MARK_KINDS,
  ACTIVITY_MARK_TARGET_KINDS,
  STATE_DOCTOR_DOMAINS,
  STATE_MIGRATIONS,
  ActivityMarksStateError,
  applyMigrations,
  checkActivityMarksSchema,
  createActivityMark,
  deleteActivityMessagesForSource,
  doctorActivityMarks,
  listActivityMarksSnapshotPage,
  loadStateDriver,
  parseActivityMarkTargetId,
  readActivityMark,
  readActivityMarksMembership,
  readApiIdempotency,
  reportStateHealth,
  recordApiIdempotency,
  revokeActivityMark,
  runStateDoctor,
  upsertActivityMessages,
  type ActivityMarkRow,
  type ApiProvenanceV1,
  type StateDriverDatabase,
} from "../state";

function provenance(
  subject: string,
  at: string,
  assertedActor?: string,
): ApiProvenanceV1 {
  return {
    schema_version: "calyx.provenance/v1",
    request_id: `req_${randomUUID()}`,
    subject,
    ...(assertedActor ? { asserted_actor: assertedActor } : {}),
    host: "blade",
    via: "http",
    at,
  };
}

function createInput(
  id: number,
  options: {
    subject?: string;
    at?: string;
    target_kind?: "activity" | "turn" | "message";
    target_id?: string;
    kind?: "high_signal" | "foundational";
    reason?: string;
    asserted_actor?: string;
  } = {},
) {
  const targetKind = options.target_kind ?? "message";
  const activityId = `interactive:codex:session-${id}`;
  const targetId = options.target_id ?? (
    targetKind === "activity"
      ? activityId
      : `${activityId}:${targetKind === "message" ? "msg" : "turn"}:${id}`
  );
  return {
    target_kind: targetKind,
    target_id: targetId,
    kind: options.kind ?? "high_signal",
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
    provenance: provenance(
      options.subject ?? "switchboard",
      options.at ?? `2026-07-21T00:00:${String(id).padStart(2, "0")}.000Z`,
      options.asserted_actor,
    ),
  } as const;
}

describe("authoritative activity marks", () => {
  let root: string;
  let db: StateDriverDatabase;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "calyx-activity-marks-"));
    const driver = await loadStateDriver();
    db = driver.open(join(root, "marks.db"));
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    applyMigrations(db, STATE_MIGRATIONS, driver.id, () => "2026-07-21T00:00:00.000Z");
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  test("migration 0035 creates a separate authoritative store with no activity-index foreign key", () => {
    expect(STATE_MIGRATIONS.at(-1)?.id).toBe("0035");
    expect(checkActivityMarksSchema(db)).toEqual({ status: "ok", findings: [] });
    expect(ACTIVITY_MARKS_TABLES.map((entry) => entry.table)).toEqual([
      "activity_marks_membership",
      "activity_marks",
    ]);
    expect(ACTIVITY_INDEX_TABLES.map((entry) => entry.table)).not.toContain("activity_marks");
    expect(db.prepare("PRAGMA foreign_key_list(activity_marks)").all()).toEqual([]);
    const membership = readActivityMarksMembership(db);
    expect(membership).toMatchObject({ revision: 0 });
    expect(membership.generation).toMatch(/^[0-9a-f]{32}$/);
    expect(membership.root_lineage_token).toMatch(/^[0-9a-f]{32}$/);
    expect(membership.lineage_token).toBe(membership.root_lineage_token);
  });

  test("schema parity rejects same-name indexes that lost uniqueness, columns, or partial predicates", () => {
    db.exec(`
      DROP INDEX idx_activity_marks_active_natural_key;
      CREATE INDEX idx_activity_marks_active_natural_key ON activity_marks(mark_id);
    `);
    expect(checkActivityMarksSchema(db)).toMatchObject({
      status: "drift",
      findings: [expect.objectContaining({
        code: "invalid-index",
        detail: expect.stringContaining("idx_activity_marks_active_natural_key"),
      })],
    });
  });

  test("schema parity rejects additive table drift outside the exact CREATE TABLE authority", () => {
    db.exec("ALTER TABLE activity_marks ADD COLUMN shadow_subject TEXT");
    expect(checkActivityMarksSchema(db)).toMatchObject({
      status: "drift",
      findings: [expect.objectContaining({
        table: "activity_marks",
        code: "invalid-table-constraint",
        detail: expect.stringContaining("exact canonical CREATE TABLE authority"),
      })],
    });
  });

  test("canonical parsers split on the final marker and reject aliases, sessions, zero lines, and kind mismatches", () => {
    expect(ACTIVITY_MARK_TARGET_KINDS).toEqual(["activity", "turn", "message"]);
    expect(ACTIVITY_MARK_KINDS).toEqual(["high_signal", "foundational"]);
    expect(parseActivityMarkTargetId(
      "message",
      "interactive:codex:session:with:colons:msg:42",
    )).toEqual({
      target_kind: "message",
      target_id: "interactive:codex:session:with:colons:msg:42",
      activity_id: "interactive:codex:session:with:colons",
      source_line: 42,
    });
    expect(parseActivityMarkTargetId("turn", "run:run-1:turn:7")).toMatchObject({
      activity_id: "run:run-1",
      source_line: 7,
    });
    for (const [kind, id] of [
      ["message", "interactive:codex:s:msg:0"],
      ["message", "interactive:codex:s:msg:01"],
      ["turn", "interactive:codex:s:msg:1"],
      ["activity", "interactive:codex:s:msg:1"],
      ["activity", "session:codex:s"],
      ["activity", "codex:blade:s"],
      ["activity", "run::bad"],
      ["activity", `run:${"a".repeat(257)}`],
    ] as const) {
      expect(() => parseActivityMarkTargetId(kind, id)).toThrow(ActivityMarksStateError);
    }
  });

  test("create converges the active natural key without changing immutable reason/provenance or revision", () => {
    const firstInput = createInput(1, {
      reason: "first reason",
      asserted_actor: "operator:caleb",
    });
    const first = createActivityMark(db, firstInput);
    const afterFirst = readActivityMarksMembership(db);
    const retry = createActivityMark(db, {
      ...firstInput,
      reason: "different reason",
      provenance: provenance("switchboard", "2026-07-21T00:00:59.000Z", "run:other"),
    });
    expect(retry).toEqual(first);
    expect(retry.reason).toBe("first reason");
    expect(retry.created_provenance.asserted_actor).toBe("operator:caleb");
    expect(readActivityMarksMembership(db)).toEqual(afterFirst);

    const otherSubject = createActivityMark(db, createInput(1, {
      subject: "another_client",
      reason: "separate namespace",
    }));
    expect(otherSubject.mark_id).not.toBe(first.mark_id);
    expect(otherSubject.subject).toBe("another_client");
  });

  test("ordinary membership reads reject a rolled-back head with retained transitions ahead", () => {
    createActivityMark(db, createInput(1));
    const earlier = readActivityMarksMembership(db);
    createActivityMark(db, createInput(2));
    db.prepare(
      `UPDATE activity_marks_membership
          SET revision = ?, lineage_token = ?, updated_at = ?
        WHERE singleton = 1`,
    ).run(earlier.revision, earlier.lineage_token, earlier.updated_at);

    expect(() => readActivityMarksMembership(db)).toThrowError(expect.objectContaining({
      code: "activity_marks_schema_unavailable",
      message: "activity marks membership head is behind a retained transition",
    }));
    expect(() => listActivityMarksSnapshotPage(db)).toThrowError(expect.objectContaining({
      code: "activity_marks_schema_unavailable",
    }));
  });

  test("activity-index source eviction and rebuild cannot cascade into authoritative marks", () => {
    const targetId = "interactive:codex:rebuild-proof:msg:7";
    upsertActivityMessages(db, [{
      message_id: targetId,
      activity_id: "interactive:codex:rebuild-proof",
      turn_id: "interactive:codex:rebuild-proof:turn:7",
      seq: 7,
      origin: "assistant",
      text: "durable mark target",
      backend: "codex",
      source_path: "/tmp/rebuild-proof.jsonl",
      source_offset: 100,
      content_hash: "a".repeat(64),
      classifier_version: "test",
      attachment_refs: "[]",
      observed_at: "2026-07-21T00:00:07.000Z",
    }]);
    const mark = createActivityMark(db, createInput(7, { target_id: targetId }));
    expect(deleteActivityMessagesForSource(db, "/tmp/rebuild-proof.jsonl")).toEqual({ deleted: 1 });
    expect(readActivityMark(db, mark.mark_id)).toEqual(mark);
    upsertActivityMessages(db, [{
      message_id: targetId,
      activity_id: "interactive:codex:rebuild-proof",
      turn_id: "interactive:codex:rebuild-proof:turn:7",
      seq: 7,
      origin: "assistant",
      text: "rebuilt projection",
      backend: "codex",
      source_path: "/tmp/rebuild-proof.jsonl",
      source_offset: 120,
      content_hash: "b".repeat(64),
      classifier_version: "test-2",
      attachment_refs: "[]",
      observed_at: "2026-07-21T01:00:07.000Z",
    }]);
    expect(readActivityMark(db, mark.mark_id)).toEqual(mark);
  });

  test("keyed API replay survives revoke while a fresh key explicitly creates a fresh mark", () => {
    const submitKeyed = (
      input: ReturnType<typeof createInput>,
      idempotencyKey: string,
    ): ActivityMarkRow => {
      const requestHash = `hash-${input.target_id}-${input.kind}-${input.reason ?? ""}`;
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = readApiIdempotency(
          db,
          input.provenance.subject,
          "attention.mark.create",
          idempotencyKey,
        );
        if (existing) {
          if (existing.request_hash !== requestHash) throw new Error("idempotency conflict");
          db.exec("COMMIT");
          return existing.response as ActivityMarkRow;
        }
        const mark = createActivityMark(db, input);
        recordApiIdempotency(db, {
          subject: input.provenance.subject,
          operation_id: "attention.mark.create",
          idempotency_key: idempotencyKey,
          first_request_provenance: input.provenance,
          request_hash: requestHash,
          response_status: 200,
          response: mark,
          created_at: input.provenance.at,
        });
        db.exec("COMMIT");
        return mark;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };

    const input = createInput(2);
    const first = submitKeyed(input, "lost-response-key");
    const converged = submitKeyed({
      ...input,
      provenance: provenance("switchboard", "2026-07-21T00:00:03.000Z"),
    }, "second-intent-key");
    expect(converged.mark_id).toBe(first.mark_id);
    expect(readActivityMarksMembership(db).revision).toBe(1);
    expect(readApiIdempotency(
      db,
      "switchboard",
      "attention.mark.create",
      "lost-response-key",
    )?.response).toMatchObject({ mark_id: first.mark_id });
    expect(readApiIdempotency(
      db,
      "switchboard",
      "attention.mark.create",
      "second-intent-key",
    )?.response).toMatchObject({ mark_id: first.mark_id });
    expect(() => submitKeyed({
      ...input,
      kind: "foundational",
      provenance: provenance("switchboard", "2026-07-21T00:00:04.000Z"),
    }, "lost-response-key")).toThrow("idempotency conflict");
    expect(readActivityMarksMembership(db).revision).toBe(1);
    revokeActivityMark(db, {
      mark_id: first.mark_id,
      provenance: provenance("switchboard", "2026-07-21T00:01:00.000Z"),
    });
    const replay = submitKeyed({
      ...input,
      provenance: provenance("switchboard", "2026-07-21T00:02:00.000Z"),
    }, "lost-response-key");
    expect(replay.mark_id).toBe(first.mark_id);
    expect(readActivityMarksMembership(db).revision).toBe(2);

    const fresh = submitKeyed({
      ...input,
      provenance: provenance("switchboard", "2026-07-21T00:03:00.000Z"),
    }, "intentional-fresh-mark-key");
    expect(fresh.mark_id).not.toBe(first.mark_id);
    expect(fresh.marked_revision).toBe(3);
  });

  test("revoke is owner-scoped, history-retaining, and exact repeated revoke preserves first provenance", () => {
    const mark = createActivityMark(db, createInput(3));
    expect(() => revokeActivityMark(db, {
      mark_id: mark.mark_id,
      provenance: provenance("other_client", "2026-07-21T00:01:00.000Z"),
    })).toThrowError(expect.objectContaining({ code: "mark_owner_forbidden" }));
    expect(readActivityMarksMembership(db).revision).toBe(1);

    const firstRevoke = revokeActivityMark(db, {
      mark_id: mark.mark_id,
      provenance: provenance("switchboard", "2026-07-21T00:02:00.000Z", "operator:caleb"),
    });
    const secondRevoke = revokeActivityMark(db, {
      mark_id: mark.mark_id,
      provenance: provenance("switchboard", "2026-07-21T00:03:00.000Z", "run:later"),
    });
    expect(secondRevoke).toEqual(firstRevoke);
    expect(secondRevoke.revoked_at).toBe("2026-07-21T00:02:00.000Z");
    expect(secondRevoke.revoked_provenance?.asserted_actor).toBe("operator:caleb");
    expect(readActivityMarksMembership(db).revision).toBe(2);
    expect(readActivityMark(db, mark.mark_id)?.revoked_revision).toBe(2);
  });

  test("seek pagination retains page-one membership across later create, revoke, re-mark, equal timestamps, and clock rollback", () => {
    const marks = [
      createActivityMark(db, createInput(10, { at: "2026-07-21T10:00:03.000Z" })),
      createActivityMark(db, createInput(11, { at: "2026-07-21T10:00:02.000Z" })),
      createActivityMark(db, createInput(12, { at: "2026-07-21T10:00:02.000Z" })),
      createActivityMark(db, createInput(13, { at: "2026-07-21T10:00:01.000Z" })),
    ];
    const first = listActivityMarksSnapshotPage(db, {
      limit: 2,
      now: () => "2026-07-21T10:00:04.000Z",
    });
    expect(first.truncated).toBe(true);
    if (!first.truncated) throw new Error("expected a continuation cursor");

    const pageOneIds = new Set(first.marks.map((mark) => mark.mark_id));
    const laterTarget = marks.find((mark) => !pageOneIds.has(mark.mark_id))!;
    revokeActivityMark(db, {
      mark_id: laterTarget.mark_id,
      provenance: provenance("switchboard", "2026-07-21T10:00:05.000Z"),
    });
    const rolledBackClock = createActivityMark(db, createInput(14, {
      at: "2026-07-21T09:00:00.000Z",
    }));
    const replacement = createActivityMark(db, {
      ...createInput(99, {
        at: "2026-07-21T10:00:06.000Z",
        target_kind: laterTarget.target_kind,
        target_id: laterTarget.target_id,
        kind: laterTarget.kind,
      }),
      provenance: provenance("switchboard", "2026-07-21T10:00:06.000Z"),
    });

    const second = listActivityMarksSnapshotPage(db, {
      limit: 2,
      cursor: first.next_cursor,
      now: () => "2026-07-21T08:00:00.000Z",
    });
    const snapshotRows = [...first.marks, ...second.marks];
    expect(new Set(snapshotRows.map((mark) => mark.mark_id))).toEqual(
      new Set(marks.map((mark) => mark.mark_id)),
    );
    expect(snapshotRows.find((mark) => mark.mark_id === laterTarget.mark_id)?.revoked_at).toBeNull();
    expect(snapshotRows.map((mark) => mark.mark_id)).not.toContain(rolledBackClock.mark_id);
    expect(snapshotRows.map((mark) => mark.mark_id)).not.toContain(replacement.mark_id);
    expect(second.snapshot_at).toBe(first.snapshot_at);
    expect(second.revision).toBe(first.revision);
    expect(second.lineage_token).toBe(first.lineage_token);
  });

  test("continuation rejects an alternate lineage created from an actual database rollback copy", async () => {
    createActivityMark(db, createInput(40));
    createActivityMark(db, createInput(41));
    createActivityMark(db, createInput(42));
    const rollbackPath = join(root, "rollback-copy.db");
    db.exec(`VACUUM INTO '${rollbackPath.replaceAll("'", "''")}'`);

    createActivityMark(db, createInput(43));
    const original = listActivityMarksSnapshotPage(db, {
      limit: 1,
      now: () => "2026-07-21T12:00:00.000Z",
    });
    if (!original.truncated) throw new Error("expected original continuation");

    const rollbackDb = (await loadStateDriver()).open(rollbackPath);
    try {
      createActivityMark(rollbackDb, createInput(44));
      expect(readActivityMarksMembership(rollbackDb).revision).toBe(original.revision);
      expect(readActivityMarksMembership(rollbackDb).lineage_token).not.toBe(original.lineage_token);
      expect(() => listActivityMarksSnapshotPage(rollbackDb, {
        limit: 1,
        cursor: original.next_cursor,
      })).toThrowError(/stale|another query/u);
    } finally {
      rollbackDb.close();
    }
  });

  test("cursor binds filters and exact seek membership", () => {
    createActivityMark(db, createInput(20, { kind: "foundational" }));
    createActivityMark(db, createInput(21, { kind: "foundational" }));
    const page = listActivityMarksSnapshotPage(db, {
      kind: "foundational",
      limit: 1,
      now: () => "2026-07-21T10:00:00.000Z",
    });
    if (!page.truncated) throw new Error("expected cursor");
    expect(() => listActivityMarksSnapshotPage(db, {
      kind: "high_signal",
      limit: 1,
      cursor: page.next_cursor,
    })).toThrowError(/stale|another query/u);

    const parsed = JSON.parse(Buffer.from(page.next_cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    parsed["after_mark_id"] = `mark_${randomUUID()}`;
    const tampered = Buffer.from(JSON.stringify(parsed)).toString("base64url");
    expect(() => listActivityMarksSnapshotPage(db, {
      kind: "foundational",
      limit: 1,
      cursor: tampered,
    })).toThrowError(/seek/u);
    expect(() => listActivityMarksSnapshotPage(db, {
      target_kind: "message",
      target_id: "run:r1:turn:7",
    })).toThrowError(/message target/u);
  });

  test("doctor reports clean counts/head and detects provenance and lineage corruption without consulting targets", async () => {
    const live = createActivityMark(db, createInput(30));
    const revoked = createActivityMark(db, createInput(31));
    revokeActivityMark(db, {
      mark_id: revoked.mark_id,
      provenance: provenance("switchboard", "2026-07-21T11:00:00.000Z"),
    });
    expect(doctorActivityMarks(db)).toMatchObject({
      schema: { status: "ok", findings: [] },
      total: 2,
      active: 1,
      revoked: 1,
      malformed: 0,
      findings: [],
      membership: { revision: 3 },
    });
    expect(STATE_DOCTOR_DOMAINS).toContain("marks");
    const stateDoctor = await runStateDoctor({
      storeOptions: {
        paths: {
          stateDir: root,
          dbPath: join(root, "marks.db"),
          source: "env-db",
          dirSource: "env-db-derived",
        },
      },
      domains: ["marks"],
    });
    expect(stateDoctor.domains).toEqual([
      expect.objectContaining({ domain: "marks", status: "ok", findings: [] }),
    ]);
    expect(stateDoctor.activityMarks).toMatchObject({
      total: 2,
      active: 1,
      revoked: 1,
      malformed: 0,
      membership: { revision: 3 },
    });

    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare("UPDATE activity_marks SET subject = ? WHERE mark_id = ?")
      .run("corrupt_owner", live.mark_id);
    db.prepare("UPDATE activity_marks_membership SET lineage_token = ? WHERE singleton = 1")
      .run("f".repeat(32));
    const health = await reportStateHealth({
      storeOptions: {
        paths: {
          stateDir: root,
          dbPath: join(root, "marks.db"),
          source: "env-db",
          dirSource: "env-db-derived",
        },
      },
    });
    expect(health.ok).toBe(false);
    expect(health.activityMarks).toMatchObject({ malformed: 1, membership: null });
    const corrupt = doctorActivityMarks(db);
    expect(corrupt.schema.status).toBe("ok");
    expect(corrupt.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "created-provenance-correspondence",
      "membership-head-mismatch",
    ]));
    expect(corrupt.findings.map((finding) => finding.code)).not.toContain("target");

    db.prepare(
      `UPDATE activity_marks_membership
          SET revision = ?, lineage_token = ?, updated_at = ?
        WHERE singleton = 1`,
    ).run(Number.MAX_SAFE_INTEGER, "e".repeat(32), "2026-07-21T12:00:00.000Z");
    const hugeHead = doctorActivityMarks(db);
    expect(hugeHead.findings).toContainEqual(expect.objectContaining({
      code: "transition-revision-missing",
      detail: expect.stringContaining(String(Number.MAX_SAFE_INTEGER)),
    }));
  });
});
