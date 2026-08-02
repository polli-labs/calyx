import { createHash, randomBytes, randomUUID } from "node:crypto";

import { canonicalizeJcs } from "./canonical-json";
import type { StateDriverDatabase } from "./driver";
import { ACTIVITY_MARKS_TABLES } from "./migrations";
import {
  isCanonicalApiTimestamp,
  parseApiProvenanceJson,
  validateApiProvenance,
  type ApiProvenanceV1,
} from "./provenance";

export const ACTIVITY_MARK_TARGET_KINDS = ["activity", "turn", "message"] as const;
export type ActivityMarkTargetKind = (typeof ACTIVITY_MARK_TARGET_KINDS)[number];

export const ACTIVITY_MARK_KINDS = ["high_signal", "foundational"] as const;
export type ActivityMarkKind = (typeof ACTIVITY_MARK_KINDS)[number];

export const ACTIVITY_MARK_ID_PATTERN_SOURCE =
  "^mark_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
export const ACTIVITY_MARK_ACTIVITY_ID_PATTERN_SOURCE =
  "^(?![\\s\\S]*:(?:msg|turn):\\d+$)(?:run:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}|interactive:(?:codex|claude):[^\\s]+)$";
export const ACTIVITY_MARK_SOURCE_LINE_PATTERN_SOURCE = "^[1-9]\\d*$";
export const ACTIVITY_MARK_TARGET_ID_MAX_CHARS = 1_024;
export const ACTIVITY_MARK_REASON_MAX_CHARS = 2_000;
export const ACTIVITY_MARK_LIST_DEFAULT_LIMIT = 50;
export const ACTIVITY_MARK_LIST_MAX_LIMIT = 100;
export const ACTIVITY_MARK_CURSOR_MAX_CHARS = 4_096;

const MARK_ID_PATTERN = new RegExp(ACTIVITY_MARK_ID_PATTERN_SOURCE);
const CANONICAL_ACTIVITY_ID_PATTERN = new RegExp(ACTIVITY_MARK_ACTIVITY_ID_PATTERN_SOURCE, "u");
const SOURCE_LINE_PATTERN = new RegExp(ACTIVITY_MARK_SOURCE_LINE_PATTERN_SOURCE, "u");
const HEX_TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const LIST_CURSOR_SCHEMA_VERSION = "calyx.activity-mark-list-cursor/v1" as const;
const LIST_OPERATION_ID = "attention.mark.list" as const;

export type ActivityMarksStateErrorCode =
  | "invalid_request"
  | "activity_marks_schema_unavailable"
  | "mark_unknown"
  | "mark_owner_forbidden";

export class ActivityMarksStateError extends Error {
  readonly code: ActivityMarksStateErrorCode;

  constructor(code: ActivityMarksStateErrorCode, message: string) {
    super(message);
    this.name = "ActivityMarksStateError";
    this.code = code;
  }
}

export interface ActivityMarkMembership {
  generation: string;
  revision: number;
  root_lineage_token: string;
  lineage_token: string;
  updated_at: string;
}

export interface ActivityMarkRow {
  mark_id: string;
  subject: string;
  target_kind: ActivityMarkTargetKind;
  target_id: string;
  kind: ActivityMarkKind;
  reason: string | null;
  marked_at: string;
  created_provenance: ApiProvenanceV1;
  marked_revision: number;
  marked_lineage_token: string;
  revoked_at: string | null;
  revoked_provenance: ApiProvenanceV1 | null;
  revoked_revision: number | null;
  revoked_lineage_token: string | null;
}

interface RawActivityMarkRow {
  mark_id: string;
  subject: string;
  target_kind: string;
  target_id: string;
  kind: string;
  reason: string | null;
  marked_at: string;
  created_provenance_json: string;
  marked_revision: number | bigint;
  marked_lineage_token: string;
  revoked_at: string | null;
  revoked_provenance_json: string | null;
  revoked_revision: number | bigint | null;
  revoked_lineage_token: string | null;
}

interface RawMembershipRow {
  generation: string;
  revision: number | bigint;
  root_lineage_token: string;
  lineage_token: string;
  updated_at: string;
}

export interface ParsedActivityMarkTarget {
  target_kind: ActivityMarkTargetKind;
  target_id: string;
  activity_id: string;
  source_line?: number;
}

export interface CreateActivityMarkInput {
  target_kind: ActivityMarkTargetKind;
  target_id: string;
  kind: ActivityMarkKind;
  reason?: string | undefined;
  provenance: ApiProvenanceV1;
}

export interface RevokeActivityMarkInput {
  mark_id: string;
  provenance: ApiProvenanceV1;
}

export interface ListActivityMarksOptions {
  kind?: ActivityMarkKind | undefined;
  target_kind?: ActivityMarkTargetKind | undefined;
  target_id?: string | undefined;
  since?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  now?: (() => string) | undefined;
}

export type ActivityMarkListPage = {
  snapshot_at: string;
  generation: string;
  revision: number;
  lineage_token: string;
  marks: ActivityMarkRow[];
} & (
  | { truncated: false; next_cursor?: never }
  | { truncated: true; next_cursor: string }
);

interface ActivityMarkListCursor {
  schema_version: typeof LIST_CURSOR_SCHEMA_VERSION;
  operation_id: typeof LIST_OPERATION_ID;
  filter_digest: string;
  snapshot_at: string;
  generation: string;
  revision: number;
  lineage_token: string;
  after_marked_at: string;
  after_mark_id: string;
}

const ACTIVITY_MARK_SELECT = `SELECT
  mark_id, subject, target_kind, target_id, kind, reason,
  marked_at, created_provenance_json, marked_revision, marked_lineage_token,
  revoked_at, revoked_provenance_json, revoked_revision, revoked_lineage_token
FROM activity_marks`;

function asSafeInteger(label: string, value: number | bigint): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ActivityMarksStateError(
      "activity_marks_schema_unavailable",
      `${label} must be a non-negative safe integer`,
    );
  }
  return number;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function canonicalString(label: string, value: unknown, maxChars: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxChars
    || value.trim() !== value
    || hasControlCharacter(value)
  ) {
    throw new ActivityMarksStateError(
      "invalid_request",
      `${label} must be a canonical string of 1..${maxChars} characters`,
    );
  }
  return value;
}

export function validateActivityMarkId(markId: string): string {
  if (!MARK_ID_PATTERN.test(markId)) {
    throw new ActivityMarksStateError("invalid_request", "mark_id must be mark_<uuid-v4>");
  }
  return markId;
}

export function validateActivityMarkKind(kind: string): ActivityMarkKind {
  if (!(ACTIVITY_MARK_KINDS as readonly string[]).includes(kind)) {
    throw new ActivityMarksStateError(
      "invalid_request",
      `mark kind must be one of: ${ACTIVITY_MARK_KINDS.join(", ")}`,
    );
  }
  return kind as ActivityMarkKind;
}

export function validateActivityMarkTargetKind(kind: string): ActivityMarkTargetKind {
  if (!(ACTIVITY_MARK_TARGET_KINDS as readonly string[]).includes(kind)) {
    throw new ActivityMarksStateError(
      "invalid_request",
      `target_kind must be one of: ${ACTIVITY_MARK_TARGET_KINDS.join(", ")}`,
    );
  }
  return kind as ActivityMarkTargetKind;
}

function validateCanonicalActivityId(activityId: string): string {
  canonicalString("activity_id", activityId, ACTIVITY_MARK_TARGET_ID_MAX_CHARS);
  if (!CANONICAL_ACTIVITY_ID_PATTERN.test(activityId)) {
    throw new ActivityMarksStateError(
      "invalid_request",
      "activity target must be a canonical run:<id> or interactive:<backend>:<id> activity_id",
    );
  }
  return activityId;
}

function parseFinalSourceTarget(
  targetId: string,
  targetKind: "turn" | "message",
): ParsedActivityMarkTarget {
  const marker = targetKind === "turn" ? ":turn:" : ":msg:";
  const index = targetId.lastIndexOf(marker);
  if (index <= 0) {
    throw new ActivityMarksStateError(
      "invalid_request",
      `${targetKind} target must have the form <activity-id>${marker}<positive-source-line>`,
    );
  }
  const activityId = targetId.slice(0, index);
  const sourceText = targetId.slice(index + marker.length);
  if (!SOURCE_LINE_PATTERN.test(sourceText)) {
    throw new ActivityMarksStateError(
      "invalid_request",
      `${targetKind} target source line must be a canonical positive integer`,
    );
  }
  const sourceLine = Number(sourceText);
  if (!Number.isSafeInteger(sourceLine) || String(sourceLine) !== sourceText) {
    throw new ActivityMarksStateError(
      "invalid_request",
      `${targetKind} target source line must be a safe positive integer`,
    );
  }
  validateCanonicalActivityId(activityId);
  return { target_kind: targetKind, target_id: targetId, activity_id: activityId, source_line: sourceLine };
}

/** Split only on the final kind marker so activity IDs may themselves contain colons. */
export function parseActivityMarkTargetId(
  targetKind: ActivityMarkTargetKind,
  targetId: string,
): ParsedActivityMarkTarget {
  validateActivityMarkTargetKind(targetKind);
  canonicalString("target_id", targetId, ACTIVITY_MARK_TARGET_ID_MAX_CHARS);
  if (targetKind === "activity") {
    const activityId = validateCanonicalActivityId(targetId);
    return { target_kind: "activity", target_id: targetId, activity_id: activityId };
  }
  return parseFinalSourceTarget(targetId, targetKind);
}

export function validateActivityMarkReason(reason: string | undefined): string | undefined {
  return reason === undefined
    ? undefined
    : canonicalString("reason", reason, ACTIVITY_MARK_REASON_MAX_CHARS);
}

function validateCanonicalTimestamp(label: string, value: string): string {
  if (!isCanonicalApiTimestamp(value)) {
    throw new ActivityMarksStateError(
      "invalid_request",
      `${label} must be a canonical UTC ISO timestamp`,
    );
  }
  return value;
}

function hydrateActivityMark(row: RawActivityMarkRow): ActivityMarkRow {
  return {
    mark_id: row.mark_id,
    subject: row.subject,
    target_kind: row.target_kind as ActivityMarkTargetKind,
    target_id: row.target_id,
    kind: row.kind as ActivityMarkKind,
    reason: row.reason,
    marked_at: row.marked_at,
    created_provenance: parseApiProvenanceJson(row.created_provenance_json),
    marked_revision: asSafeInteger("marked_revision", row.marked_revision),
    marked_lineage_token: row.marked_lineage_token,
    revoked_at: row.revoked_at,
    revoked_provenance: row.revoked_provenance_json
      ? parseApiProvenanceJson(row.revoked_provenance_json)
      : null,
    revoked_revision: row.revoked_revision === null
      ? null
      : asSafeInteger("revoked_revision", row.revoked_revision),
    revoked_lineage_token: row.revoked_lineage_token,
  };
}

function projectActivityMarkAtRevision(
  row: RawActivityMarkRow,
  snapshotRevision: number,
): ActivityMarkRow {
  const hydrated = hydrateActivityMark(row);
  if (hydrated.revoked_revision !== null && hydrated.revoked_revision > snapshotRevision) {
    return {
      ...hydrated,
      revoked_at: null,
      revoked_provenance: null,
      revoked_revision: null,
      revoked_lineage_token: null,
    };
  }
  return hydrated;
}

function rawActivityMark(db: StateDriverDatabase, markId: string): RawActivityMarkRow | undefined {
  return db.prepare(`${ACTIVITY_MARK_SELECT} WHERE mark_id = ?`).get(markId) as
    | RawActivityMarkRow
    | undefined;
}

export function readActivityMark(
  db: StateDriverDatabase,
  markId: string,
): ActivityMarkRow | undefined {
  validateActivityMarkId(markId);
  const row = rawActivityMark(db, markId);
  return row ? hydrateActivityMark(row) : undefined;
}

export function readActivityMarksMembership(db: StateDriverDatabase): ActivityMarkMembership {
  let rows: RawMembershipRow[];
  try {
    rows = db.prepare(
      `SELECT generation, revision, root_lineage_token, lineage_token, updated_at
         FROM activity_marks_membership
        WHERE singleton = 1`,
    ).all() as RawMembershipRow[];
  } catch (error) {
    throw new ActivityMarksStateError(
      "activity_marks_schema_unavailable",
      `activity marks membership is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (rows.length !== 1) {
    throw new ActivityMarksStateError(
      "activity_marks_schema_unavailable",
      "activity marks membership singleton is missing or duplicated",
    );
  }
  const row = rows[0]!;
  const revision = asSafeInteger("activity marks revision", row.revision);
  if (
    !HEX_TOKEN_PATTERN.test(row.generation)
    || !HEX_TOKEN_PATTERN.test(row.root_lineage_token)
    || !HEX_TOKEN_PATTERN.test(row.lineage_token)
    || !isCanonicalApiTimestamp(row.updated_at)
    || (revision === 0 && row.lineage_token !== row.root_lineage_token)
  ) {
    throw new ActivityMarksStateError(
      "activity_marks_schema_unavailable",
      "activity marks membership singleton is malformed",
    );
  }
  const membership: ActivityMarkMembership = {
    generation: row.generation,
    revision,
    root_lineage_token: row.root_lineage_token,
    lineage_token: row.lineage_token,
    updated_at: row.updated_at,
  };
  const transitionAhead = db.prepare(
    `SELECT marked_revision AS revision
       FROM activity_marks
      WHERE marked_revision > ?
     UNION ALL
     SELECT revoked_revision AS revision
       FROM activity_marks
      WHERE revoked_revision > ?
      LIMIT 1`,
  ).get(revision, revision) as { revision: number | bigint } | undefined;
  if (transitionAhead) {
    throw new ActivityMarksStateError(
      "activity_marks_schema_unavailable",
      "activity marks membership head is behind a retained transition",
    );
  }
  if (revision > 0) {
    const transitions = db.prepare(
      `SELECT marked_lineage_token AS token, marked_at AS at
         FROM activity_marks WHERE marked_revision = ?
       UNION ALL
       SELECT revoked_lineage_token AS token, revoked_at AS at
         FROM activity_marks WHERE revoked_revision = ?`,
    ).all(revision, revision) as Array<{ token: string; at: string }>;
    if (
      transitions.length !== 1
      || transitions[0]!.token !== membership.lineage_token
      || transitions[0]!.at !== membership.updated_at
    ) {
      throw new ActivityMarksStateError(
        "activity_marks_schema_unavailable",
        "activity marks membership head does not match exactly one retained transition",
      );
    }
  }
  return membership;
}

function mintLineageToken(): string {
  return randomBytes(16).toString("hex");
}

function incrementMembership(
  db: StateDriverDatabase,
  current: ActivityMarkMembership,
  lineageToken: string,
  at: string,
): number {
  if (current.revision >= Number.MAX_SAFE_INTEGER) {
    throw new ActivityMarksStateError(
      "activity_marks_schema_unavailable",
      "activity marks revision has reached Number.MAX_SAFE_INTEGER",
    );
  }
  const next = current.revision + 1;
  const result = db.prepare(
    `UPDATE activity_marks_membership
        SET revision = ?, lineage_token = ?, updated_at = ?
      WHERE singleton = 1 AND revision = ? AND lineage_token = ?`,
  ).run(next, lineageToken, at, current.revision, current.lineage_token);
  if (Number(result.changes) !== 1) {
    throw new ActivityMarksStateError(
      "activity_marks_schema_unavailable",
      "activity marks membership changed during its write transaction",
    );
  }
  return next;
}

function activeNaturalKeyMark(
  db: StateDriverDatabase,
  subject: string,
  targetKind: ActivityMarkTargetKind,
  targetId: string,
  kind: ActivityMarkKind,
): ActivityMarkRow | undefined {
  const row = db.prepare(
    `${ACTIVITY_MARK_SELECT}
      WHERE subject = ? AND target_kind = ? AND target_id = ? AND kind = ?
        AND revoked_at IS NULL`,
  ).get(subject, targetKind, targetId, kind) as RawActivityMarkRow | undefined;
  return row ? hydrateActivityMark(row) : undefined;
}

/**
 * Create or adopt one active natural-key mark.
 *
 * This savepoint intentionally composes inside the API layer's outer
 * `api_idempotency` transaction. This primitive carries no idempotency key:
 * natural-key adoption is convergence, not transport retry authority. The API
 * wrapper must replay the keyed ledger result before invoking it.
 */
export function createActivityMark(
  db: StateDriverDatabase,
  input: CreateActivityMarkInput,
): ActivityMarkRow {
  const provenance = validateApiProvenance(input.provenance);
  const targetKind = validateActivityMarkTargetKind(input.target_kind);
  const target = parseActivityMarkTargetId(targetKind, input.target_id);
  const kind = validateActivityMarkKind(input.kind);
  const reason = validateActivityMarkReason(input.reason);

  db.exec("SAVEPOINT create_activity_mark");
  try {
    // Acquire the write reservation before observing the active key. This is
    // a semantic no-op, but makes two standalone callers serialize just as an
    // API caller's outer BEGIN IMMEDIATE does.
    db.prepare(
      `UPDATE activity_marks_membership SET revision = revision WHERE singleton = 1`,
    ).run();
    const membership = readActivityMarksMembership(db);
    const existing = activeNaturalKeyMark(
      db,
      provenance.subject,
      targetKind,
      target.target_id,
      kind,
    );
    if (existing) {
      db.exec("RELEASE SAVEPOINT create_activity_mark");
      return existing;
    }

    const lineageToken = mintLineageToken();
    const revision = incrementMembership(db, membership, lineageToken, provenance.at);
    const markId = `mark_${randomUUID()}`;
    db.prepare(
      `INSERT INTO activity_marks (
         mark_id, subject, target_kind, target_id, kind, reason,
         marked_at, created_provenance_json, marked_revision, marked_lineage_token
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      markId,
      provenance.subject,
      targetKind,
      target.target_id,
      kind,
      reason ?? null,
      provenance.at,
      JSON.stringify(provenance),
      revision,
      lineageToken,
    );
    const created = rawActivityMark(db, markId);
    if (!created) {
      throw new ActivityMarksStateError(
        "activity_marks_schema_unavailable",
        "activity mark was not readable after insertion",
      );
    }
    db.exec("RELEASE SAVEPOINT create_activity_mark");
    return hydrateActivityMark(created);
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT create_activity_mark");
    db.exec("RELEASE SAVEPOINT create_activity_mark");
    throw error;
  }
}

export function revokeActivityMark(
  db: StateDriverDatabase,
  input: RevokeActivityMarkInput,
): ActivityMarkRow {
  const provenance = validateApiProvenance(input.provenance);
  const markId = validateActivityMarkId(input.mark_id);

  db.exec("SAVEPOINT revoke_activity_mark");
  try {
    db.prepare(
      `UPDATE activity_marks_membership SET revision = revision WHERE singleton = 1`,
    ).run();
    const membership = readActivityMarksMembership(db);
    const raw = rawActivityMark(db, markId);
    if (!raw) {
      throw new ActivityMarksStateError("mark_unknown", `activity mark ${markId} does not exist`);
    }
    const existing = hydrateActivityMark(raw);
    if (existing.subject !== provenance.subject) {
      throw new ActivityMarksStateError(
        "mark_owner_forbidden",
        `activity mark ${markId} belongs to another authenticated subject`,
      );
    }
    if (existing.revoked_at !== null) {
      db.exec("RELEASE SAVEPOINT revoke_activity_mark");
      return existing;
    }

    const lineageToken = mintLineageToken();
    const revision = incrementMembership(db, membership, lineageToken, provenance.at);
    const result = db.prepare(
      `UPDATE activity_marks
          SET revoked_at = ?, revoked_provenance_json = ?,
              revoked_revision = ?, revoked_lineage_token = ?
        WHERE mark_id = ? AND revoked_at IS NULL`,
    ).run(provenance.at, JSON.stringify(provenance), revision, lineageToken, markId);
    if (Number(result.changes) !== 1) {
      throw new ActivityMarksStateError(
        "activity_marks_schema_unavailable",
        `activity mark ${markId} changed during its revoke transaction`,
      );
    }
    const revoked = rawActivityMark(db, markId);
    if (!revoked) {
      throw new ActivityMarksStateError(
        "activity_marks_schema_unavailable",
        `activity mark ${markId} disappeared during revoke`,
      );
    }
    db.exec("RELEASE SAVEPOINT revoke_activity_mark");
    return hydrateActivityMark(revoked);
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT revoke_activity_mark");
    db.exec("RELEASE SAVEPOINT revoke_activity_mark");
    throw error;
  }
}

function normalizeListOptions(options: ListActivityMarksOptions): {
  kind?: ActivityMarkKind;
  target_kind?: ActivityMarkTargetKind;
  target_id?: string;
  since?: string;
  limit: number;
} {
  const limit = options.limit ?? ACTIVITY_MARK_LIST_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > ACTIVITY_MARK_LIST_MAX_LIMIT) {
    throw new ActivityMarksStateError(
      "invalid_request",
      `limit must be a positive integer <= ${ACTIVITY_MARK_LIST_MAX_LIMIT}`,
    );
  }
  const normalized = {
    ...(options.kind !== undefined ? { kind: validateActivityMarkKind(options.kind) } : {}),
    ...(options.target_kind !== undefined
      ? { target_kind: validateActivityMarkTargetKind(options.target_kind) }
      : {}),
    ...(options.target_id !== undefined
      ? { target_id: canonicalString("target_id", options.target_id, ACTIVITY_MARK_TARGET_ID_MAX_CHARS) }
      : {}),
    ...(options.since !== undefined
      ? { since: validateCanonicalTimestamp("since", options.since) }
      : {}),
    limit,
  };
  if (normalized.target_kind !== undefined && normalized.target_id !== undefined) {
    parseActivityMarkTargetId(normalized.target_kind, normalized.target_id);
  }
  return normalized;
}

function listFilterDigest(filters: ReturnType<typeof normalizeListOptions>): string {
  return createHash("sha256").update(canonicalizeJcs(filters)).digest("hex");
}

function encodeListCursor(cursor: ActivityMarkListCursor): string {
  return Buffer.from(canonicalizeJcs(cursor), "utf8").toString("base64url");
}

function parseListCursor(value: string): ActivityMarkListCursor {
  if (value.length === 0 || value.length > ACTIVITY_MARK_CURSOR_MAX_CHARS) {
    throw new ActivityMarksStateError(
      "invalid_request",
      `cursor must be 1..${ACTIVITY_MARK_CURSOR_MAX_CHARS} characters`,
    );
  }
  let parsed: unknown;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) {
      throw new Error("non-canonical base64url");
    }
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new ActivityMarksStateError(
      "invalid_request",
      "activity mark cursor is malformed; restart without a cursor",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ActivityMarksStateError("invalid_request", "activity mark cursor has an invalid shape");
  }
  const record = parsed as Record<string, unknown>;
  const expectedKeys = [
    "after_mark_id",
    "after_marked_at",
    "filter_digest",
    "generation",
    "lineage_token",
    "operation_id",
    "revision",
    "schema_version",
    "snapshot_at",
  ];
  if (Object.keys(record).sort().join("\0") !== expectedKeys.join("\0")) {
    throw new ActivityMarksStateError("invalid_request", "activity mark cursor has an invalid shape");
  }
  if (
    record["schema_version"] !== LIST_CURSOR_SCHEMA_VERSION
    || record["operation_id"] !== LIST_OPERATION_ID
    || typeof record["filter_digest"] !== "string"
    || !/^[0-9a-f]{64}$/u.test(record["filter_digest"])
    || typeof record["generation"] !== "string"
    || !HEX_TOKEN_PATTERN.test(record["generation"])
    || typeof record["lineage_token"] !== "string"
    || !HEX_TOKEN_PATTERN.test(record["lineage_token"])
    || typeof record["revision"] !== "number"
    || !Number.isSafeInteger(record["revision"])
    || record["revision"] < 0
    || typeof record["snapshot_at"] !== "string"
    || !isCanonicalApiTimestamp(record["snapshot_at"])
    || typeof record["after_marked_at"] !== "string"
    || !isCanonicalApiTimestamp(record["after_marked_at"])
    || typeof record["after_mark_id"] !== "string"
    || !MARK_ID_PATTERN.test(record["after_mark_id"])
  ) {
    throw new ActivityMarksStateError(
      "invalid_request",
      "activity mark cursor is stale or invalid; restart without a cursor",
    );
  }
  return record as unknown as ActivityMarkListCursor;
}

function historicalLineageToken(
  db: StateDriverDatabase,
  membership: ActivityMarkMembership,
  revision: number,
): string | undefined {
  if (revision === 0) return membership.root_lineage_token;
  const rows = db.prepare(
    `SELECT marked_lineage_token AS token FROM activity_marks WHERE marked_revision = ?
     UNION ALL
     SELECT revoked_lineage_token AS token FROM activity_marks WHERE revoked_revision = ?`,
  ).all(revision, revision) as Array<{ token: string }>;
  return rows.length === 1 ? rows[0]!.token : undefined;
}

function appendSnapshotMembership(
  clauses: string[],
  params: unknown[],
  revision: number,
): void {
  clauses.push("marked_revision <= ?");
  params.push(revision);
  clauses.push("(revoked_revision IS NULL OR revoked_revision > ?)");
  params.push(revision);
}

function appendListFilters(
  clauses: string[],
  params: unknown[],
  filters: ReturnType<typeof normalizeListOptions>,
): void {
  if (filters.kind) {
    clauses.push("kind = ?");
    params.push(filters.kind);
  }
  if (filters.target_kind) {
    clauses.push("target_kind = ?");
    params.push(filters.target_kind);
  }
  if (filters.target_id) {
    clauses.push("target_id = ?");
    params.push(filters.target_id);
  }
  if (filters.since) {
    clauses.push("marked_at >= ?");
    params.push(filters.since);
  }
}

function assertCursorAnchor(
  db: StateDriverDatabase,
  cursor: ActivityMarkListCursor,
  filters: ReturnType<typeof normalizeListOptions>,
): void {
  const clauses = ["mark_id = ?", "marked_at = ?"];
  const params: unknown[] = [cursor.after_mark_id, cursor.after_marked_at];
  appendSnapshotMembership(clauses, params, cursor.revision);
  appendListFilters(clauses, params, filters);
  const row = db.prepare(
    `SELECT mark_id FROM activity_marks WHERE ${clauses.join(" AND ")}`,
  ).get(...params) as { mark_id: string } | undefined;
  if (!row) {
    throw new ActivityMarksStateError(
      "invalid_request",
      "activity mark cursor seek does not belong to its snapshot; restart without a cursor",
    );
  }
}

export function listActivityMarksSnapshotPage(
  db: StateDriverDatabase,
  options: ListActivityMarksOptions = {},
): ActivityMarkListPage {
  const filters = normalizeListOptions(options);
  const filterDigest = listFilterDigest(filters);
  const cursor = options.cursor === undefined ? undefined : parseListCursor(options.cursor);
  const currentNow = options.now?.() ?? new Date().toISOString();
  validateCanonicalTimestamp("snapshot_at", currentNow);

  db.exec("SAVEPOINT list_activity_marks_snapshot");
  try {
    const membership = readActivityMarksMembership(db);
    let snapshotAt: string;
    let snapshotRevision: number;
    let snapshotLineage: string;
    let seek: { marked_at: string; mark_id: string } | undefined;

    if (cursor) {
      if (
        cursor.filter_digest !== filterDigest
        || cursor.generation !== membership.generation
        || cursor.revision > membership.revision
        || historicalLineageToken(db, membership, cursor.revision) !== cursor.lineage_token
      ) {
        throw new ActivityMarksStateError(
          "invalid_request",
          "activity mark cursor is stale or belongs to another query; restart without a cursor",
        );
      }
      assertCursorAnchor(db, cursor, filters);
      snapshotAt = cursor.snapshot_at;
      snapshotRevision = cursor.revision;
      snapshotLineage = cursor.lineage_token;
      seek = { marked_at: cursor.after_marked_at, mark_id: cursor.after_mark_id };
    } else {
      snapshotAt = currentNow;
      snapshotRevision = membership.revision;
      snapshotLineage = membership.lineage_token;
    }

    const clauses: string[] = [];
    const params: unknown[] = [];
    appendSnapshotMembership(clauses, params, snapshotRevision);
    appendListFilters(clauses, params, filters);
    if (seek) {
      clauses.push("(marked_at < ? OR (marked_at = ? AND mark_id > ? COLLATE BINARY))");
      params.push(seek.marked_at, seek.marked_at, seek.mark_id);
    }
    params.push(filters.limit + 1);
    const rows = db.prepare(
      `${ACTIVITY_MARK_SELECT}
        WHERE ${clauses.join(" AND ")}
        ORDER BY marked_at DESC, mark_id COLLATE BINARY ASC
        LIMIT ?`,
    ).all(...params) as RawActivityMarkRow[];
    const truncated = rows.length > filters.limit;
    const pageRows = rows.slice(0, filters.limit);
    const marks = pageRows.map((row) => projectActivityMarkAtRevision(row, snapshotRevision));
    db.exec("RELEASE SAVEPOINT list_activity_marks_snapshot");

    if (!truncated) {
      return {
        snapshot_at: snapshotAt,
        generation: membership.generation,
        revision: snapshotRevision,
        lineage_token: snapshotLineage,
        marks,
        truncated: false,
      };
    }
    const anchor = pageRows[pageRows.length - 1]!;
    return {
      snapshot_at: snapshotAt,
      generation: membership.generation,
      revision: snapshotRevision,
      lineage_token: snapshotLineage,
      marks,
      truncated: true,
      next_cursor: encodeListCursor({
        schema_version: LIST_CURSOR_SCHEMA_VERSION,
        operation_id: LIST_OPERATION_ID,
        filter_digest: filterDigest,
        snapshot_at: snapshotAt,
        generation: membership.generation,
        revision: snapshotRevision,
        lineage_token: snapshotLineage,
        after_marked_at: anchor.marked_at,
        after_mark_id: anchor.mark_id,
      }),
    };
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT list_activity_marks_snapshot");
    db.exec("RELEASE SAVEPOINT list_activity_marks_snapshot");
    throw error;
  }
}

export interface ActivityMarksSchemaFinding {
  table: string;
  code:
    | "missing-table"
    | "missing-column"
    | "missing-index"
    | "invalid-index"
    | "invalid-table-constraint";
  detail: string;
}

function canonicalSql(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim().replace(/;$/u, "").toLowerCase();
}

const ACTIVITY_MARK_INDEX_CONTRACTS = [
  {
    name: "idx_activity_marks_active_natural_key",
    unique: 1,
    partial: 1,
    columns: ["subject", "target_kind", "target_id", "kind"],
    sql: `CREATE UNIQUE INDEX idx_activity_marks_active_natural_key
      ON activity_marks(subject, target_kind, target_id, kind)
      WHERE revoked_at IS NULL`,
  },
  {
    name: "idx_activity_marks_seek",
    unique: 0,
    partial: 0,
    columns: ["marked_at", "mark_id"],
    sql: `CREATE INDEX idx_activity_marks_seek
      ON activity_marks(marked_at DESC, mark_id ASC)`,
  },
  {
    name: "idx_activity_marks_active_target",
    unique: 0,
    partial: 1,
    columns: ["target_kind", "target_id", "marked_at", "mark_id"],
    sql: `CREATE INDEX idx_activity_marks_active_target
      ON activity_marks(target_kind, target_id, marked_at DESC, mark_id ASC)
      WHERE revoked_at IS NULL`,
  },
  {
    name: "idx_activity_marks_revoked_revision",
    unique: 1,
    partial: 1,
    columns: ["revoked_revision"],
    sql: `CREATE UNIQUE INDEX idx_activity_marks_revoked_revision
      ON activity_marks(revoked_revision)
      WHERE revoked_revision IS NOT NULL`,
  },
] as const;

export function checkActivityMarksSchema(
  db: StateDriverDatabase,
): { status: "ok" | "drift"; findings: ActivityMarksSchemaFinding[] } {
  const findings: ActivityMarksSchemaFinding[] = [];
  for (const expected of ACTIVITY_MARKS_TABLES) {
    const table = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(expected.table) as { sql: string | null } | undefined;
    if (!table) {
      findings.push({
        table: expected.table,
        code: "missing-table",
        detail: `expected table "${expected.table}" not present in schema`,
      });
      continue;
    }
    const columns = (db.prepare(`PRAGMA table_info(${expected.table})`).all() as Array<{ name: string }>)
      .map((column) => column.name);
    for (const required of expected.columns) {
      if (!columns.includes(required)) {
        findings.push({
          table: expected.table,
          code: "missing-column",
          detail: `expected column "${required}" not present on "${expected.table}"`,
        });
      }
    }
    const sql = canonicalSql(table.sql ?? "");
    if (
      expected.createSql !== undefined
      && sql !== canonicalSql(expected.createSql)
    ) {
      findings.push({
        table: expected.table,
        code: "invalid-table-constraint",
        detail: `table "${expected.table}" does not match its exact canonical CREATE TABLE authority`,
      });
    } else if (expected.requiredSqlFragments?.some((fragment) => !sql.includes(canonicalSql(fragment)))) {
      findings.push({
        table: expected.table,
        code: "invalid-table-constraint",
        detail: `table "${expected.table}" does not carry its canonical constraints`,
      });
    }
    const indexRows = db.prepare(`PRAGMA index_list(${expected.table})`).all() as Array<{
      name: string;
      unique: number | bigint;
      partial: number | bigint;
    }>;
    const indexes = new Set(indexRows.map((index) => index.name));
    for (const expectedIndex of expected.indexes ?? []) {
      if (!indexes.has(expectedIndex)) {
        findings.push({
          table: expected.table,
          code: "missing-index",
          detail: `expected index "${expectedIndex}" not present on "${expected.table}"`,
        });
      }
    }
  }
  for (const contract of ACTIVITY_MARK_INDEX_CONTRACTS) {
    const index = (db.prepare("PRAGMA index_list(activity_marks)").all() as Array<{
      name: string;
      unique: number | bigint;
      partial: number | bigint;
    }>).find((candidate) => candidate.name === contract.name);
    if (!index) continue;
    const columns = (db.prepare(`PRAGMA index_info(${contract.name})`).all() as Array<{
      seqno: number | bigint;
      name: string;
    }>).sort((left, right) => Number(left.seqno) - Number(right.seqno)).map((entry) => entry.name);
    const definition = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
    ).get(contract.name) as { sql: string | null } | undefined;
    if (
      Number(index.unique) !== contract.unique
      || Number(index.partial) !== contract.partial
      || columns.join("\0") !== contract.columns.join("\0")
      || canonicalSql(definition?.sql ?? "") !== canonicalSql(contract.sql)
    ) {
      findings.push({
        table: "activity_marks",
        code: "invalid-index",
        detail: `index "${contract.name}" does not carry its canonical uniqueness, ordering, columns, and predicate`,
      });
    }
  }
  return { status: findings.length === 0 ? "ok" : "drift", findings };
}

export type ActivityMarksDoctorFindingCode =
  | "membership-singleton"
  | "membership-generation"
  | "membership-revision"
  | "membership-lineage"
  | "membership-updated-at"
  | "mark-id"
  | "subject"
  | "target"
  | "kind"
  | "reason"
  | "created-provenance"
  | "created-provenance-correspondence"
  | "marked-revision"
  | "marked-lineage"
  | "partial-revocation"
  | "revoked-provenance"
  | "revoked-provenance-correspondence"
  | "revoked-order"
  | "revoked-lineage"
  | "active-natural-key-duplicate"
  | "transition-revision-duplicate"
  | "transition-revision-missing"
  | "transition-lineage-duplicate"
  | "membership-head-mismatch";

export interface ActivityMarksDoctorFinding {
  mark_id: string | null;
  code: ActivityMarksDoctorFindingCode;
  detail: string;
}

export interface ActivityMarksDoctorReport {
  schema: { status: "ok" | "drift"; findings: ActivityMarksSchemaFinding[] };
  total: number;
  active: number;
  revoked: number;
  malformed: number;
  membership: ActivityMarkMembership | null;
  findings: ActivityMarksDoctorFinding[];
}

function safeRawNumber(value: number | bigint | null): number | null {
  if (value === null) return null;
  const number = typeof value === "bigint" ? Number(value) : value;
  return Number.isSafeInteger(number) ? number : null;
}

function validateRowForDoctor(row: RawActivityMarkRow): ActivityMarksDoctorFinding[] {
  const findings: ActivityMarksDoctorFinding[] = [];
  const add = (code: ActivityMarksDoctorFindingCode, detail: string): void => {
    findings.push({ mark_id: row.mark_id, code, detail });
  };
  if (!MARK_ID_PATTERN.test(row.mark_id)) add("mark-id", `${row.mark_id}: invalid mark_<uuid-v4>`);
  let created: ApiProvenanceV1 | undefined;
  try {
    created = parseApiProvenanceJson(row.created_provenance_json);
  } catch (error) {
    add("created-provenance", `${row.mark_id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (created && (created.subject !== row.subject || created.at !== row.marked_at)) {
    add(
      "created-provenance-correspondence",
      `${row.mark_id}: subject/marked_at do not match immutable creation provenance`,
    );
  }
  if (!created && (typeof row.subject !== "string" || row.subject.length === 0)) {
    add("subject", `${row.mark_id}: subject is empty`);
  }
  try {
    parseActivityMarkTargetId(row.target_kind as ActivityMarkTargetKind, row.target_id);
  } catch (error) {
    add("target", `${row.mark_id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    validateActivityMarkKind(row.kind);
  } catch (error) {
    add("kind", `${row.mark_id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (row.reason !== null) validateActivityMarkReason(row.reason);
  } catch (error) {
    add("reason", `${row.mark_id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isCanonicalApiTimestamp(row.marked_at)) {
    add("created-provenance-correspondence", `${row.mark_id}: marked_at is not canonical UTC`);
  }
  const markedRevision = safeRawNumber(row.marked_revision);
  if (markedRevision === null || markedRevision <= 0) {
    add("marked-revision", `${row.mark_id}: marked_revision is not a positive safe integer`);
  }
  if (!HEX_TOKEN_PATTERN.test(row.marked_lineage_token)) {
    add("marked-lineage", `${row.mark_id}: marked_lineage_token is malformed`);
  }
  const quartet = [
    row.revoked_at,
    row.revoked_provenance_json,
    row.revoked_revision,
    row.revoked_lineage_token,
  ];
  const present = quartet.filter((value) => value !== null).length;
  if (present !== 0 && present !== quartet.length) {
    add("partial-revocation", `${row.mark_id}: revocation quartet is partially populated`);
  }
  if (present === quartet.length) {
    let revoked: ApiProvenanceV1 | undefined;
    try {
      revoked = parseApiProvenanceJson(row.revoked_provenance_json!);
    } catch (error) {
      add("revoked-provenance", `${row.mark_id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (revoked && (revoked.subject !== row.subject || revoked.at !== row.revoked_at)) {
      add(
        "revoked-provenance-correspondence",
        `${row.mark_id}: subject/revoked_at do not match immutable revocation provenance`,
      );
    }
    const revokedRevision = safeRawNumber(row.revoked_revision);
    if (
      revokedRevision === null
      || markedRevision === null
      || revokedRevision <= markedRevision
      || !isCanonicalApiTimestamp(row.revoked_at!)
    ) {
      add("revoked-order", `${row.mark_id}: revocation does not follow creation canonically`);
    }
    if (!HEX_TOKEN_PATTERN.test(row.revoked_lineage_token!)) {
      add("revoked-lineage", `${row.mark_id}: revoked_lineage_token is malformed`);
    }
  }
  return findings;
}

export function doctorActivityMarks(db: StateDriverDatabase): ActivityMarksDoctorReport {
  const schema = checkActivityMarksSchema(db);
  const structurallyUnavailable = schema.findings.some((finding) =>
    finding.code === "missing-table" || finding.code === "missing-column",
  );
  if (structurallyUnavailable) {
    return {
      schema,
      total: 0,
      active: 0,
      revoked: 0,
      malformed: 0,
      membership: null,
      findings: [],
    };
  }

  const rawMembershipRows = db.prepare(
    `SELECT generation, revision, root_lineage_token, lineage_token, updated_at
       FROM activity_marks_membership`,
  ).all() as RawMembershipRow[];
  const findings: ActivityMarksDoctorFinding[] = [];
  const add = (code: ActivityMarksDoctorFindingCode, detail: string): void => {
    findings.push({ mark_id: null, code, detail });
  };
  let membership: ActivityMarkMembership | null = null;
  if (rawMembershipRows.length !== 1) {
    add("membership-singleton", `expected exactly one membership row; found ${rawMembershipRows.length}`);
  } else {
    const raw = rawMembershipRows[0]!;
    const revision = safeRawNumber(raw.revision);
    if (!HEX_TOKEN_PATTERN.test(raw.generation)) add("membership-generation", "generation is not 32 lowercase hex chars");
    if (revision === null || revision < 0) add("membership-revision", "revision is not a non-negative safe integer");
    if (
      !HEX_TOKEN_PATTERN.test(raw.root_lineage_token)
      || !HEX_TOKEN_PATTERN.test(raw.lineage_token)
      || (revision === 0 && raw.root_lineage_token !== raw.lineage_token)
    ) {
      add("membership-lineage", "membership root/current lineage tokens are malformed or inconsistent");
    }
    if (!isCanonicalApiTimestamp(raw.updated_at)) add("membership-updated-at", "membership updated_at is not canonical UTC");
    if (revision !== null) {
      membership = {
        generation: raw.generation,
        revision,
        root_lineage_token: raw.root_lineage_token,
        lineage_token: raw.lineage_token,
        updated_at: raw.updated_at,
      };
    }
  }

  const rows = db.prepare(ACTIVITY_MARK_SELECT).all() as RawActivityMarkRow[];
  for (const row of rows) findings.push(...validateRowForDoctor(row));

  const activeDuplicates = db.prepare(
    `SELECT subject, target_kind, target_id, kind, COUNT(*) AS count
       FROM activity_marks
      WHERE revoked_at IS NULL
      GROUP BY subject, target_kind, target_id, kind
     HAVING COUNT(*) > 1`,
  ).all() as Array<{
    subject: string;
    target_kind: string;
    target_id: string;
    kind: string;
    count: number | bigint;
  }>;
  for (const duplicate of activeDuplicates) {
    add(
      "active-natural-key-duplicate",
      `active natural key ${duplicate.subject}/${duplicate.target_kind}/${duplicate.target_id}/${duplicate.kind} has ${Number(duplicate.count)} rows`,
    );
  }

  const transitions = new Map<number, string[]>();
  const transitionTimes = new Map<number, string[]>();
  const addTransition = (
    revision: number | null,
    token: string | null,
    at: string | null,
  ): void => {
    if (revision === null || token === null) return;
    const tokens = transitions.get(revision) ?? [];
    tokens.push(token);
    transitions.set(revision, tokens);
    if (at !== null) {
      const times = transitionTimes.get(revision) ?? [];
      times.push(at);
      transitionTimes.set(revision, times);
    }
  };
  for (const row of rows) {
    addTransition(safeRawNumber(row.marked_revision), row.marked_lineage_token, row.marked_at);
    addTransition(safeRawNumber(row.revoked_revision), row.revoked_lineage_token, row.revoked_at);
  }
  const tokenOwners = new Map<string, number[]>();
  if (membership) tokenOwners.set(membership.root_lineage_token, [0]);
  for (const [revision, tokens] of transitions) {
    if (tokens.length !== 1) {
      add("transition-revision-duplicate", `revision ${revision} has ${tokens.length} transitions`);
    }
    for (const token of tokens) {
      const revisions = tokenOwners.get(token) ?? [];
      revisions.push(revision);
      tokenOwners.set(token, revisions);
    }
  }
  for (const [token, revisions] of tokenOwners) {
    if (revisions.length > 1) {
      add("transition-lineage-duplicate", `lineage token ${token} is reused by revisions ${revisions.join(", ")}`);
    }
  }
  if (membership) {
    const observed = [...transitions.keys()]
      .filter((revision) => revision > 0 && revision <= membership.revision)
      .sort((left, right) => left - right);
    let expectedRevision = 1;
    for (const revision of observed) {
      if (revision > expectedRevision) {
        add(
          "transition-revision-missing",
          `revisions ${expectedRevision}..${revision - 1} have no creation or revocation transition`,
        );
      }
      expectedRevision = Math.max(expectedRevision, revision + 1);
    }
    if (expectedRevision <= membership.revision) {
      add(
        "transition-revision-missing",
        `revisions ${expectedRevision}..${membership.revision} have no creation or revocation transition`,
      );
    }
    for (const revision of transitions.keys()) {
      if (revision > membership.revision) {
        add("membership-head-mismatch", `transition revision ${revision} is ahead of membership head ${membership.revision}`);
      }
    }
    const headToken = membership.revision === 0
      ? membership.root_lineage_token
      : transitions.get(membership.revision)?.[0];
    if (headToken !== membership.lineage_token) {
      add("membership-head-mismatch", "membership lineage token does not match the transition at its head revision");
    }
    const headTime = membership.revision === 0
      ? membership.updated_at
      : transitionTimes.get(membership.revision)?.[0];
    if (headTime !== membership.updated_at) {
      add("membership-head-mismatch", "membership updated_at does not match the transition at its head revision");
    }
  }

  const malformedIds = new Set(findings.filter((finding) => finding.mark_id !== null).map((finding) => finding.mark_id));
  return {
    schema,
    total: rows.length,
    active: rows.filter((row) => row.revoked_at === null).length,
    revoked: rows.filter((row) => row.revoked_at !== null).length,
    malformed: malformedIds.size + findings.filter((finding) => finding.mark_id === null).length,
    membership,
    findings,
  };
}
