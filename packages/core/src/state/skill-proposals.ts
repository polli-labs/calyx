import type { StateDriverDatabase } from "./driver";
import { SKILL_PROPOSAL_TABLES } from "./migrations";

/**
 * Wave 2.4 skill-proposal state helpers. Direct, typed operations against
 * the `skill_proposals` and `skill_proposal_events` tables introduced in
 * migration `0004`.
 *
 * Status vocabulary (closed set):
 *   - `proposed`      — created, awaiting validation/review
 *   - `validated`     — source target and payload passed validation
 *   - `materialized`  — a patch artifact was written for review
 *   - `accepted`      — reviewer accepted the proposal (does not merge or sync)
 *   - `rejected`      — reviewer rejected the proposal
 *   - `superseded`    — a newer proposal replaced this one
 *
 * Kind vocabulary (closed set):
 *   - `create` — propose a brand-new skill
 *   - `patch`  — propose a diff against an existing skill
 *   - `file`   — propose whole-file content for a relative path inside a skill
 */
export const SKILL_PROPOSAL_STATUSES = [
  "proposed",
  "validated",
  "materialized",
  "accepted",
  "rejected",
  "superseded",
] as const;
export type SkillProposalStatus = (typeof SKILL_PROPOSAL_STATUSES)[number];

export const SKILL_PROPOSAL_KINDS = ["create", "patch", "file"] as const;
export type SkillProposalKind = (typeof SKILL_PROPOSAL_KINDS)[number];

export const SKILL_PROPOSAL_TARGETS = ["agents-infra", "repo-local"] as const;
export type SkillProposalTarget = (typeof SKILL_PROPOSAL_TARGETS)[number];

export const SKILL_PROPOSALS_LIST_DEFAULT_LIMIT = 50;
export const SKILL_PROPOSALS_LIST_MAX_LIMIT = 500;

export interface SkillProposalRow {
  proposal_id: string;
  skill_id: string;
  kind: SkillProposalKind;
  status: SkillProposalStatus;
  target: SkillProposalTarget;
  source_root: string | null;
  target_source_path: string | null;
  relative_source_file: string | null;
  origin_activity_id: string | null;
  origin_message_id: string | null;
  summary: string | null;
  author: string | null;
  created_at: string;
  updated_at: string;
  validated_at: string | null;
  materialized_at: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  superseded_at: string | null;
  payload: unknown;
}

interface RawProposalRow {
  proposal_id: string;
  skill_id: string;
  kind: string;
  status: string;
  target: string;
  source_root: string | null;
  target_source_path: string | null;
  relative_source_file: string | null;
  origin_activity_id: string | null;
  origin_message_id: string | null;
  summary: string | null;
  author: string | null;
  created_at: string;
  updated_at: string;
  validated_at: string | null;
  materialized_at: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  superseded_at: string | null;
  payload_json: string;
}

function parseJsonOrNull(input: string | null): unknown {
  if (input === null || input === undefined) return null;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function hydrateProposalRow(row: RawProposalRow): SkillProposalRow {
  return {
    proposal_id: row.proposal_id,
    skill_id: row.skill_id,
    kind: row.kind as SkillProposalKind,
    status: row.status as SkillProposalStatus,
    target: row.target as SkillProposalTarget,
    source_root: row.source_root,
    target_source_path: row.target_source_path,
    relative_source_file: row.relative_source_file,
    origin_activity_id: row.origin_activity_id,
    origin_message_id: row.origin_message_id,
    summary: row.summary,
    author: row.author,
    created_at: row.created_at,
    updated_at: row.updated_at,
    validated_at: row.validated_at,
    materialized_at: row.materialized_at,
    accepted_at: row.accepted_at,
    rejected_at: row.rejected_at,
    superseded_at: row.superseded_at,
    payload: parseJsonOrNull(row.payload_json),
  };
}

const PROPOSAL_SELECT = `SELECT
  proposal_id, skill_id, kind, status, target,
  source_root, target_source_path, relative_source_file,
  origin_activity_id, origin_message_id, summary, author,
  created_at, updated_at,
  validated_at, materialized_at, accepted_at, rejected_at, superseded_at,
  payload_json
FROM skill_proposals`;

export interface CreateSkillProposalInput {
  proposal_id: string;
  skill_id: string;
  kind: SkillProposalKind;
  target: SkillProposalTarget;
  source_root?: string | null | undefined;
  target_source_path?: string | null | undefined;
  relative_source_file?: string | null | undefined;
  origin_activity_id?: string | null | undefined;
  origin_message_id?: string | null | undefined;
  summary?: string | null | undefined;
  author?: string | null | undefined;
  payload?: unknown;
}

export interface SkillProposalEventRow {
  event_seq: number;
  proposal_id: string;
  occurred_at: string;
  event_type: string;
  status_before: SkillProposalStatus | null;
  status_after: SkillProposalStatus;
  actor: string | null;
  note: string | null;
  payload: unknown;
}

interface RawProposalEventRow {
  event_seq: number | bigint;
  proposal_id: string;
  occurred_at: string;
  event_type: string;
  status_before: string | null;
  status_after: string;
  actor: string | null;
  note: string | null;
  payload_json: string | null;
}

function hydrateEventRow(row: RawProposalEventRow): SkillProposalEventRow {
  return {
    event_seq:
      typeof row.event_seq === "bigint" ? Number(row.event_seq) : row.event_seq,
    proposal_id: row.proposal_id,
    occurred_at: row.occurred_at,
    event_type: row.event_type,
    status_before: row.status_before as SkillProposalStatus | null,
    status_after: row.status_after as SkillProposalStatus,
    actor: row.actor,
    note: row.note,
    payload: parseJsonOrNull(row.payload_json),
  };
}

/**
 * Create a proposal in `proposed` state and append the corresponding
 * `created` event. Both inserts share a single transaction so the proposal
 * row cannot exist without its initial event.
 *
 * Duplicate `proposal_id` raises an error rather than silently merging.
 * Callers that need retry idempotency should supply deterministic
 * `proposal_id` values and catch the constraint failure.
 */
export function createSkillProposal(
  db: StateDriverDatabase,
  input: CreateSkillProposalInput,
  now: () => string = () => new Date().toISOString(),
): SkillProposalRow {
  const timestamp = now();
  const payloadJson = JSON.stringify(input.payload ?? {});
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO skill_proposals
        (proposal_id, skill_id, kind, status, target,
         source_root, target_source_path, relative_source_file,
         origin_activity_id, origin_message_id, summary, author,
         created_at, updated_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.proposal_id,
      input.skill_id,
      input.kind,
      "proposed",
      input.target,
      input.source_root ?? null,
      input.target_source_path ?? null,
      input.relative_source_file ?? null,
      input.origin_activity_id ?? null,
      input.origin_message_id ?? null,
      input.summary ?? null,
      input.author ?? null,
      timestamp,
      timestamp,
      payloadJson,
    );
    db.prepare(
      `INSERT INTO skill_proposal_events
        (proposal_id, occurred_at, event_type, status_before, status_after, actor, note, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.proposal_id,
      timestamp,
      "created",
      null,
      "proposed",
      input.author ?? null,
      input.summary ?? null,
      payloadJson,
    );
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* swallow secondary error */
    }
    throw err;
  }
  return readSkillProposal(db, input.proposal_id)!;
}

export function readSkillProposal(
  db: StateDriverDatabase,
  proposal_id: string,
): SkillProposalRow | undefined {
  const row = db
    .prepare(`${PROPOSAL_SELECT} WHERE proposal_id = ?`)
    .get(proposal_id) as RawProposalRow | undefined;
  return row ? hydrateProposalRow(row) : undefined;
}

export interface ListSkillProposalsOptions {
  status?: SkillProposalStatus | readonly SkillProposalStatus[];
  skill_id?: string;
  limit?: number;
}

function clampListLimit(limit: number | undefined): number {
  if (limit === undefined) return SKILL_PROPOSALS_LIST_DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    return SKILL_PROPOSALS_LIST_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), SKILL_PROPOSALS_LIST_MAX_LIMIT);
}

export function listSkillProposals(
  db: StateDriverDatabase,
  options: ListSkillProposalsOptions = {},
): SkillProposalRow[] {
  const limit = clampListLimit(options.limit);
  const filters: string[] = [];
  const args: unknown[] = [];

  if (options.status !== undefined) {
    const statuses = Array.isArray(options.status)
      ? options.status
      : [options.status];
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    filters.push(`status IN (${placeholders})`);
    args.push(...statuses);
  }
  if (options.skill_id) {
    filters.push("skill_id = ?");
    args.push(options.skill_id);
  }

  const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
  args.push(limit);
  const rows = db
    .prepare(
      `${PROPOSAL_SELECT}${where} ORDER BY created_at DESC, proposal_id ASC LIMIT ?`,
    )
    .all(...args) as RawProposalRow[];
  return rows.map(hydrateProposalRow);
}

export interface SkillProposalStatusCounts {
  proposed: number;
  validated: number;
  materialized: number;
  accepted: number;
  rejected: number;
  superseded: number;
}

export function countSkillProposalsByStatus(
  db: StateDriverDatabase,
): SkillProposalStatusCounts {
  const counts: SkillProposalStatusCounts = {
    proposed: 0,
    validated: 0,
    materialized: 0,
    accepted: 0,
    rejected: 0,
    superseded: 0,
  };
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM skill_proposals GROUP BY status`)
    .all() as Array<{ status: string; n: number | bigint }>;
  for (const row of rows) {
    const n = typeof row.n === "bigint" ? Number(row.n) : row.n;
    if (row.status in counts) {
      counts[row.status as SkillProposalStatus] = n;
    }
  }
  return counts;
}

export function listSkillProposalEvents(
  db: StateDriverDatabase,
  proposal_id: string,
): SkillProposalEventRow[] {
  const rows = db
    .prepare(
      `SELECT event_seq, proposal_id, occurred_at, event_type,
              status_before, status_after, actor, note, payload_json
       FROM skill_proposal_events
       WHERE proposal_id = ?
       ORDER BY event_seq ASC`,
    )
    .all(proposal_id) as RawProposalEventRow[];
  return rows.map(hydrateEventRow);
}

export interface UpdateSkillProposalStatusInput {
  proposal_id: string;
  /** Expected current status; transition aborts if the live row differs. */
  expected_status: SkillProposalStatus | readonly SkillProposalStatus[];
  next_status: SkillProposalStatus;
  event_type: string;
  actor?: string | null | undefined;
  note?: string | null | undefined;
  payload?: unknown;
  /** When set, record this column on `skill_proposals` (e.g. `accepted_at`). */
  status_timestamp_column?:
    | "validated_at"
    | "materialized_at"
    | "accepted_at"
    | "rejected_at"
    | "superseded_at"
    | undefined;
  /** When set, merge into the proposal `payload_json` (top-level). */
  payload_patch?: Record<string, unknown> | undefined;
}

export interface UpdateSkillProposalStatusResult {
  proposal: SkillProposalRow;
  event: SkillProposalEventRow;
}

/**
 * Atomically transition a proposal status and append the corresponding
 * event. Validates the expected current status to prevent lost-update
 * races. Accepts an optional `payload_patch` so reviewers can attach diff
 * locations, validation receipts, or materialization artifact paths
 * without overwriting prior payload state.
 */
export function updateSkillProposalStatus(
  db: StateDriverDatabase,
  input: UpdateSkillProposalStatusInput,
  now: () => string = () => new Date().toISOString(),
): UpdateSkillProposalStatusResult {
  const timestamp = now();
  const eventPayloadJson =
    input.payload === undefined ? null : JSON.stringify(input.payload);
  const expectedSet = new Set(
    Array.isArray(input.expected_status) ? input.expected_status : [input.expected_status],
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare(`${PROPOSAL_SELECT} WHERE proposal_id = ?`)
      .get(input.proposal_id) as RawProposalRow | undefined;
    if (!existing) {
      throw new Error(`skill proposal not found: ${input.proposal_id}`);
    }
    if (!expectedSet.has(existing.status as SkillProposalStatus)) {
      throw new Error(
        `skill proposal ${input.proposal_id} is in status "${existing.status}", not ${[...expectedSet].join("|")}`,
      );
    }

    const mergedPayload = (() => {
      if (!input.payload_patch) return existing.payload_json;
      let current: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(existing.payload_json) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          current = parsed as Record<string, unknown>;
        }
      } catch {
        current = {};
      }
      return JSON.stringify({ ...current, ...input.payload_patch });
    })();

    const stamp = input.status_timestamp_column;
    if (stamp) {
      db.prepare(
        `UPDATE skill_proposals
            SET status = ?, updated_at = ?, ${stamp} = ?, payload_json = ?
          WHERE proposal_id = ?`,
      ).run(
        input.next_status,
        timestamp,
        timestamp,
        mergedPayload,
        input.proposal_id,
      );
    } else {
      db.prepare(
        `UPDATE skill_proposals
            SET status = ?, updated_at = ?, payload_json = ?
          WHERE proposal_id = ?`,
      ).run(input.next_status, timestamp, mergedPayload, input.proposal_id);
    }

    db.prepare(
      `INSERT INTO skill_proposal_events
        (proposal_id, occurred_at, event_type, status_before, status_after, actor, note, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.proposal_id,
      timestamp,
      input.event_type,
      existing.status,
      input.next_status,
      input.actor ?? null,
      input.note ?? null,
      eventPayloadJson,
    );
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* swallow secondary error */
    }
    throw err;
  }

  const proposal = readSkillProposal(db, input.proposal_id)!;
  const events = listSkillProposalEvents(db, input.proposal_id);
  const event = events[events.length - 1]!;
  return { proposal, event };
}

/** Schema parity check used by `calyx state doctor` (migration 0004). */
export interface SkillProposalsSchemaFinding {
  table: string;
  code: "missing-table" | "missing-column" | "missing-index";
  detail: string;
}

export function checkSkillProposalsSchema(
  db: StateDriverDatabase,
): { status: "ok" | "drift"; findings: SkillProposalsSchemaFinding[] } {
  const findings: SkillProposalsSchemaFinding[] = [];
  for (const expected of SKILL_PROPOSAL_TABLES) {
    const tableRow = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(expected.table) as { name?: string } | undefined;
    if (!tableRow || tableRow.name !== expected.table) {
      findings.push({
        table: expected.table,
        code: "missing-table",
        detail: `expected table "${expected.table}" not present in schema`,
      });
      continue;
    }
    const columns = (db
      .prepare(`PRAGMA table_info(${expected.table})`)
      .all() as Array<{ name: string }>)
      .map((c) => c.name);
    for (const required of expected.columns) {
      if (!columns.includes(required)) {
        findings.push({
          table: expected.table,
          code: "missing-column",
          detail: `expected column "${required}" not present on "${expected.table}"`,
        });
      }
    }
    if (expected.indexes && expected.indexes.length > 0) {
      const liveIndexes = (db
        .prepare(`PRAGMA index_list(${expected.table})`)
        .all() as Array<{ name: string }>)
        .map((i) => i.name);
      for (const idx of expected.indexes) {
        if (!liveIndexes.includes(idx)) {
          findings.push({
            table: expected.table,
            code: "missing-index",
            detail: `expected index "${idx}" not present on "${expected.table}"`,
          });
        }
      }
    }
  }
  return { status: findings.length === 0 ? "ok" : "drift", findings };
}

/**
 * Doctor-level malformed-row scan. Flags rows whose `status` or `kind`
 * are not in the closed vocabularies, rows whose recorded source target
 * points at an installed harness mirror, plus materialized proposals whose
 * recorded artifact path looks like an installed harness mirror.
 */
export interface MalformedSkillProposalFinding {
  proposal_id: string;
  code:
    | "unknown-status"
    | "unknown-kind"
    | "unknown-target"
    | "source-root-to-mirror"
    | "target-source-to-mirror"
    | "materialized-to-mirror";
  detail: string;
}

const INSTALL_MIRROR_PATH_FRAGMENTS = [
  "/.agents/skills",
  "/.claude/skills",
  "/.codex/skills",
];

function looksLikeInstallMirrorPath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, "/");
  for (const fragment of INSTALL_MIRROR_PATH_FRAGMENTS) {
    const index = normalized.indexOf(fragment);
    if (index === -1) continue;
    const after = normalized[index + fragment.length];
    if (after === undefined || after === "/") return true;
  }
  return false;
}

export function listMalformedSkillProposals(
  db: StateDriverDatabase,
): MalformedSkillProposalFinding[] {
  const findings: MalformedSkillProposalFinding[] = [];
  const rows = db
    .prepare(
      `SELECT proposal_id, status, kind, target, source_root, target_source_path, payload_json
       FROM skill_proposals`,
    )
    .all() as Array<{
    proposal_id: string;
    status: string;
    kind: string;
    target: string;
    source_root: string | null;
    target_source_path: string | null;
    payload_json: string;
  }>;
  const statusSet = new Set<string>(SKILL_PROPOSAL_STATUSES);
  const kindSet = new Set<string>(SKILL_PROPOSAL_KINDS);
  const targetSet = new Set<string>(SKILL_PROPOSAL_TARGETS);
  for (const row of rows) {
    if (!statusSet.has(row.status)) {
      findings.push({
        proposal_id: row.proposal_id,
        code: "unknown-status",
        detail: `proposal ${row.proposal_id} has unknown status "${row.status}"`,
      });
    }
    if (!kindSet.has(row.kind)) {
      findings.push({
        proposal_id: row.proposal_id,
        code: "unknown-kind",
        detail: `proposal ${row.proposal_id} has unknown kind "${row.kind}"`,
      });
    }
    if (!targetSet.has(row.target)) {
      findings.push({
        proposal_id: row.proposal_id,
        code: "unknown-target",
        detail: `proposal ${row.proposal_id} has unknown target "${row.target}"`,
      });
    }
    if (row.source_root && looksLikeInstallMirrorPath(row.source_root)) {
      findings.push({
        proposal_id: row.proposal_id,
        code: "source-root-to-mirror",
        detail: `proposal ${row.proposal_id} source_root points at install mirror path "${row.source_root}"`,
      });
    }
    if (row.target_source_path && looksLikeInstallMirrorPath(row.target_source_path)) {
      findings.push({
        proposal_id: row.proposal_id,
        code: "target-source-to-mirror",
        detail: `proposal ${row.proposal_id} target_source_path points at install mirror path "${row.target_source_path}"`,
      });
    }
    if (row.status === "materialized") {
      let artifactPath: unknown = null;
      try {
        const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
        artifactPath =
          (parsed?.["materialization"] as Record<string, unknown> | undefined)
            ?.["artifact_path"] ??
          parsed?.["artifact_path"] ??
          null;
      } catch {
        artifactPath = null;
      }
      if (typeof artifactPath === "string") {
        if (looksLikeInstallMirrorPath(artifactPath)) {
          findings.push({
            proposal_id: row.proposal_id,
            code: "materialized-to-mirror",
            detail: `proposal ${row.proposal_id} materialized to install mirror path "${artifactPath}"`,
          });
        }
      }
    }
  }
  return findings;
}
