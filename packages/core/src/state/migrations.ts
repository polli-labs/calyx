import type { StateDriverDatabase } from "./driver";
import {
  messageReceiptAdmissionSnapshotValidationError,
  messageReceiptFileEvidenceError,
  messageReceiptMirrorControlValidationError,
  messageReceiptSnapshotCorrespondenceError,
  messageReceiptSnapshotSourceDomainError,
  messageReceiptSnapshotValidationError,
  scanMessageReceiptFileEvidence,
  type MessageReceiptSnapshotSource,
} from "./message-receipt-snapshot";

interface LegacyReceiptSnapshotRow {
  message_id: string;
  schema_version: string;
  sender: string;
  recipient_address: string;
  recipient_class: string;
  recipient_host: string | null;
  subject: string;
  body: string;
  thread_key: string | null;
  reply_to: string | null;
  idempotency_key: string | null;
  urgency: string;
  ack_required: number | bigint;
  expires_at: string | null;
  status: string;
  claimed_until: string | null;
  claimed_by: string | null;
  expired_claim_cycles: number | bigint;
  dead_letter: number | bigint;
  dead_letter_reason: string | null;
  created_at: string;
  updated_at: string;
  spooled_at: string | null;
  delivered_at: string | null;
  acked_at: string | null;
  acked_by: string | null;
  receipt_path: string | null;
  payload_json: string;
  created_provenance_json?: string | null;
  ingress_provenance_json?: string | null;
}

interface ReceiptSnapshotRepairRow extends LegacyReceiptSnapshotRow {
  receipt_mirror_message_id: unknown;
  receipt_snapshot_json: string | null;
  receipt_mirror_status: string;
  receipt_mirror_attempt_count: number | bigint;
  receipt_mirror_next_attempt_at: string | null;
  receipt_mirror_last_attempt_at: string | null;
  receipt_mirror_completed_at: string | null;
  receipt_mirror_receipt_path: string | null;
  receipt_mirror_last_error_code: string | null;
  receipt_mirror_last_error_message: string | null;
  receipt_mirror_created_at: string;
  receipt_mirror_updated_at: string;
}

export const MESSAGE_RECEIPT_MIRROR_CONTROL_CHECK_SQL = `
  (status = 'pending'
    AND completed_at IS NULL
    AND receipt_path IS NULL
    AND next_attempt_at IS NOT NULL
    AND next_attempt_at >= created_at
    AND (
      (attempt_count = 0
        AND last_attempt_at IS NULL
        AND last_error_code IS NULL
        AND last_error_message IS NULL
        AND updated_at = created_at)
      OR (attempt_count > 0
        AND last_attempt_at IS NOT NULL
        AND last_attempt_at >= created_at
        AND next_attempt_at >= last_attempt_at
        AND updated_at = last_attempt_at
        AND ((last_error_code IS NULL AND last_error_message IS NULL)
          OR (last_error_code IS NOT NULL AND last_error_message IS NOT NULL)))
    ))
  OR (status = 'completed'
    AND attempt_count >= 1
    AND next_attempt_at IS NULL
    AND last_attempt_at IS NOT NULL
    AND last_attempt_at >= created_at
    AND completed_at IS NOT NULL
    AND completed_at >= last_attempt_at
    AND receipt_path IS NOT NULL
    AND trim(receipt_path) <> ''
    AND last_error_code IS NULL
    AND last_error_message IS NULL
    AND updated_at = completed_at)
`;

function parseLegacyReceiptPayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("payload must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `cannot reconstruct an honest receipt snapshot from malformed payload: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseLegacyReceiptProvenance(value: string | null | undefined): unknown {
  if (value === null || value === undefined) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("provenance must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `cannot reconstruct an honest receipt snapshot from malformed provenance: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const ACTIVITY_MARKS_MEMBERSHIP_CREATE_SQL = `CREATE TABLE activity_marks_membership (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation TEXT NOT NULL
    CHECK (length(generation) = 32 AND generation NOT GLOB '*[^0-9a-f]*'),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(revision) = 'integer' AND revision >= 0 AND revision <= 9007199254740991),
  root_lineage_token TEXT NOT NULL
    CHECK (length(root_lineage_token) = 32 AND root_lineage_token NOT GLOB '*[^0-9a-f]*'),
  lineage_token TEXT NOT NULL
    CHECK (length(lineage_token) = 32 AND lineage_token NOT GLOB '*[^0-9a-f]*'),
  updated_at TEXT NOT NULL,
  CHECK (revision <> 0 OR lineage_token = root_lineage_token)
)`;

const ACTIVITY_MARKS_CREATE_SQL = `CREATE TABLE activity_marks (
  mark_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('activity', 'turn', 'message')),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 1024),
  kind TEXT NOT NULL CHECK (kind IN ('high_signal', 'foundational')),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  marked_at TEXT NOT NULL,
  created_provenance_json TEXT NOT NULL CHECK (json_valid(created_provenance_json)),
  marked_revision INTEGER NOT NULL UNIQUE
    CHECK (typeof(marked_revision) = 'integer' AND marked_revision > 0 AND marked_revision <= 9007199254740991),
  marked_lineage_token TEXT NOT NULL UNIQUE
    CHECK (length(marked_lineage_token) = 32 AND marked_lineage_token NOT GLOB '*[^0-9a-f]*'),
  revoked_at TEXT,
  revoked_provenance_json TEXT CHECK (revoked_provenance_json IS NULL OR json_valid(revoked_provenance_json)),
  revoked_revision INTEGER
    CHECK (revoked_revision IS NULL OR (
      typeof(revoked_revision) = 'integer'
      AND revoked_revision > marked_revision
      AND revoked_revision <= 9007199254740991
    )),
  revoked_lineage_token TEXT UNIQUE
    CHECK (revoked_lineage_token IS NULL OR (
      length(revoked_lineage_token) = 32
      AND revoked_lineage_token NOT GLOB '*[^0-9a-f]*'
    )),
  CHECK (
    (revoked_at IS NULL AND revoked_provenance_json IS NULL
      AND revoked_revision IS NULL AND revoked_lineage_token IS NULL)
    OR
    (revoked_at IS NOT NULL AND revoked_provenance_json IS NOT NULL
      AND revoked_revision IS NOT NULL AND revoked_lineage_token IS NOT NULL)
  )
)`;

function legacyReceiptSnapshot(
  row: LegacyReceiptSnapshotRow,
): Record<string, unknown> & MessageReceiptSnapshotSource {
  const sourceDomainError = messageReceiptSnapshotSourceDomainError(row);
  if (sourceDomainError) {
    throw new Error(`cannot validate the authoritative message source: ${sourceDomainError}`);
  }
  return {
    message_id: row.message_id,
    schema_version: row.schema_version,
    sender: row.sender,
    recipient_address: row.recipient_address,
    recipient_class: row.recipient_class,
    recipient_host: row.recipient_host,
    subject: row.subject,
    body: row.body,
    thread_key: row.thread_key,
    reply_to: row.reply_to,
    idempotency_key: row.idempotency_key,
    urgency: row.urgency,
    ack_required: Number(row.ack_required) === 1,
    expires_at: row.expires_at,
    status: row.status,
    claimed_until: row.claimed_until,
    claimed_by: row.claimed_by,
    expired_claim_cycles: Number(row.expired_claim_cycles),
    dead_letter: Number(row.dead_letter) === 1,
    dead_letter_reason: row.dead_letter_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    spooled_at: row.spooled_at!,
    delivered_at: row.delivered_at,
    acked_at: row.acked_at,
    acked_by: row.acked_by,
    receipt_path: row.receipt_path,
    payload: parseLegacyReceiptPayload(row.payload_json),
    created_provenance: parseLegacyReceiptProvenance(row.created_provenance_json),
    ingress_provenance: parseLegacyReceiptProvenance(row.ingress_provenance_json),
  };
}

/**
 * Migration definition. `id` is a zero-padded integer string so lexical
 * sort order matches numeric order. `up` runs idempotently inside a
 * single transaction at apply time; the migrator wraps the `BEGIN/COMMIT`.
 */
export interface StateMigration {
  id: string;
  description: string;
  /**
   * Release-declared upper bound for additional database/WAL/temp bytes while
   * this migration executes. Self-upgrade admits the sum before quiescing and
   * verifies observed post-migration growth against the same contract.
   */
  growthBound: MigrationGrowthBound;
  up: (db: StateDriverDatabase) => void;
}

export interface MigrationGrowthBound {
  databaseSizeMultiplier: number;
  fixedBytes: number;
}

/**
 * Position of a state store's migration ledger relative to the migration
 * source it is measured against.
 *
 * Both divergent values are ordinary fleet states, not corruption. A store
 * only advances when something runs on that host, so `behind` is the default
 * for a quiet host; and a store outlives the build that migrated it, so
 * `ahead` means the *reader* is old, not the store. `unavailable` is reserved
 * for a reader that could not open the ledger at all.
 */
export type StateSchemaStatus = "current" | "behind" | "ahead" | "unavailable";

/**
 * Compare an applied ledger head against a declared migration target.
 *
 * Migration ids are zero-padded integer strings (see `StateMigration.id`), so
 * lexical comparison is numeric comparison. A ledger head above the source's
 * last id means a newer build migrated this store; `applyMigrations` treats
 * that as an empty pending set and is therefore a no-op, which is why an older
 * daemon keeps running against a forward-migrated store.
 */
export function classifyStateSchema(
  current: string | null,
  target: string | null,
): StateSchemaStatus {
  if (target === null) {
    return current === null ? "current" : "ahead";
  }
  if (current === null) {
    return "behind";
  }
  if (current === target) {
    return "current";
  }
  return current > target ? "ahead" : "behind";
}

/**
 * Migrations in `source` newer than an applied ledger head. Callers measuring
 * a *remote* store against their own build cannot read that store's ledger, so
 * they compare heads rather than ledger contents.
 */
export function countStateMigrationsAfter(
  current: string | null,
  source: readonly StateMigration[] = STATE_MIGRATIONS,
): number {
  return source.filter((migration) => current === null || migration.id > current).length;
}

const STATE_MIGRATION_STANDARD_GROWTH_BOUND: MigrationGrowthBound = {
  databaseSizeMultiplier: 4,
  fixedBytes: 8 * 1024 * 1024,
};

export const RUN_INDEX_MEMBERSHIP_DELTA_RETENTION = 65_536;

/**
 * Canonical run-index membership journal triggers. The source mutation,
 * revision advance, per-revision lineage rotation, OLD/NEW delta, and bounded
 * compaction share one SQLite transaction; any journal failure aborts the
 * source mutation. The random lineage edge distinguishes alternate histories
 * after a database snapshot rollback even when their numeric revisions meet.
 */
export const RUN_INDEX_MEMBERSHIP_REVISION_TRIGGERS = [
  {
    name: "run_index_membership_revision_insert",
    sql: `
      CREATE TRIGGER run_index_membership_revision_insert
      AFTER INSERT ON run_index
      BEGIN
        UPDATE run_index_membership_revision
           SET revision = revision + 1,
               lineage_parent_token = lineage_token,
               lineage_token = lower(hex(randomblob(16)))
         WHERE singleton = 1;
        INSERT INTO run_index_membership_deltas (
          revision, operation, lineage_parent_token, lineage_token,
          new_run_id, new_created_at, new_updated_at, new_host, new_backend
        )
        SELECT revision, 'insert', lineage_parent_token, lineage_token,
               NEW.run_id, NEW.created_at, NEW.updated_at, NEW.host, NEW.backend
          FROM run_index_membership_revision
         WHERE singleton = 1;
        UPDATE run_index_membership_revision
           SET compacted_through_revision = max(
             compacted_through_revision,
             revision - ${RUN_INDEX_MEMBERSHIP_DELTA_RETENTION}
           )
         WHERE singleton = 1;
        DELETE FROM run_index_membership_deltas
         WHERE revision <= (
           SELECT compacted_through_revision
             FROM run_index_membership_revision
            WHERE singleton = 1
         );
      END;
    `,
  },
  {
    name: "run_index_membership_revision_delete",
    sql: `
      CREATE TRIGGER run_index_membership_revision_delete
      AFTER DELETE ON run_index
      BEGIN
        UPDATE run_index_membership_revision
           SET revision = revision + 1,
               lineage_parent_token = lineage_token,
               lineage_token = lower(hex(randomblob(16)))
         WHERE singleton = 1;
        INSERT INTO run_index_membership_deltas (
          revision, operation, lineage_parent_token, lineage_token,
          old_run_id, old_created_at, old_updated_at, old_host, old_backend
        )
        SELECT revision, 'delete', lineage_parent_token, lineage_token,
               OLD.run_id, OLD.created_at, OLD.updated_at, OLD.host, OLD.backend
          FROM run_index_membership_revision
         WHERE singleton = 1;
        UPDATE run_index_membership_revision
           SET compacted_through_revision = max(
             compacted_through_revision,
             revision - ${RUN_INDEX_MEMBERSHIP_DELTA_RETENTION}
           )
         WHERE singleton = 1;
        DELETE FROM run_index_membership_deltas
         WHERE revision <= (
           SELECT compacted_through_revision
             FROM run_index_membership_revision
            WHERE singleton = 1
         );
      END;
    `,
  },
  {
    name: "run_index_membership_revision_update",
    sql: `
      CREATE TRIGGER run_index_membership_revision_update
      AFTER UPDATE OF run_id, created_at, updated_at, host, backend ON run_index
      WHEN OLD.run_id IS NOT NEW.run_id
        OR OLD.created_at IS NOT NEW.created_at
        OR OLD.updated_at IS NOT NEW.updated_at
        OR OLD.host IS NOT NEW.host
        OR OLD.backend IS NOT NEW.backend
      BEGIN
        UPDATE run_index_membership_revision
           SET revision = revision + 1,
               lineage_parent_token = lineage_token,
               lineage_token = lower(hex(randomblob(16)))
         WHERE singleton = 1;
        INSERT INTO run_index_membership_deltas (
          revision, operation, lineage_parent_token, lineage_token,
          old_run_id, old_created_at, old_updated_at, old_host, old_backend,
          new_run_id, new_created_at, new_updated_at, new_host, new_backend
        )
        SELECT revision, 'update', lineage_parent_token, lineage_token,
               OLD.run_id, OLD.created_at, OLD.updated_at, OLD.host, OLD.backend,
               NEW.run_id, NEW.created_at, NEW.updated_at, NEW.host, NEW.backend
          FROM run_index_membership_revision
         WHERE singleton = 1;
        UPDATE run_index_membership_revision
           SET compacted_through_revision = max(
             compacted_through_revision,
             revision - ${RUN_INDEX_MEMBERSHIP_DELTA_RETENTION}
           )
         WHERE singleton = 1;
        DELETE FROM run_index_membership_deltas
         WHERE revision <= (
           SELECT compacted_through_revision
             FROM run_index_membership_revision
            WHERE singleton = 1
         );
      END;
    `,
  },
] as const;

/**
 * Wave 1 baseline migrations.
 *
 * Migration `0001` creates `schema_migrations` (the migration ledger) and
 * `state_meta` (a tiny key/value table for store-level metadata). Domain
 * schemas are intentionally out of scope for wave 1 — see the SQLite RFC
 * slice plan and the wave-1 charter.
 */
export const STATE_MIGRATIONS: readonly StateMigration[] = [
  {
    id: "0001",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description: "baseline: schema_migrations + state_meta",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          description TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS state_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    id: "0002",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "orchestration ledger: event_log + event_cursors + locks + source_freshness",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS event_log (
          event_id TEXT PRIMARY KEY,
          domain TEXT NOT NULL,
          aggregate_type TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          cursor TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          host TEXT,
          agent_id TEXT,
          source TEXT,
          payload_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_event_log_aggregate
          ON event_log(aggregate_type, aggregate_id, cursor);
        CREATE INDEX IF NOT EXISTS idx_event_log_domain_cursor
          ON event_log(domain, cursor);
        CREATE INDEX IF NOT EXISTS idx_event_log_occurred_at
          ON event_log(occurred_at);

        CREATE TABLE IF NOT EXISTS event_cursors (
          source TEXT NOT NULL,
          domain TEXT NOT NULL,
          cursor TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          payload_json TEXT,
          PRIMARY KEY (source, domain)
        );

        CREATE TABLE IF NOT EXISTS locks (
          lock_key TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          metadata_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_locks_expires_at
          ON locks(expires_at);

        CREATE TABLE IF NOT EXISTS source_freshness (
          source_kind TEXT NOT NULL,
          source_id TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          status TEXT NOT NULL,
          stale_after_ms INTEGER,
          cursor TEXT,
          detail TEXT,
          payload_json TEXT,
          PRIMARY KEY (source_kind, source_id)
        );

        CREATE INDEX IF NOT EXISTS idx_source_freshness_status
          ON source_freshness(status);
        CREATE INDEX IF NOT EXISTS idx_source_freshness_observed_at
          ON source_freshness(observed_at);
      `);
    },
  },
  {
    id: "0003",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "run index projection: run_index table keyed by run_id (wave 2.2 — replaces racy runs/index.jsonl)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS run_index (
          run_id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          health_status TEXT,
          last_progress_at TEXT,
          issue TEXT,
          host TEXT,
          backend TEXT,
          recovery_mode TEXT NOT NULL,
          run_dir TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_run_index_state
          ON run_index(state);
        CREATE INDEX IF NOT EXISTS idx_run_index_updated_at
          ON run_index(updated_at);
        CREATE INDEX IF NOT EXISTS idx_run_index_issue
          ON run_index(issue);
        CREATE INDEX IF NOT EXISTS idx_run_index_host
          ON run_index(host);
      `);
    },
  },
  {
    id: "0004",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "skill proposals: skill_proposals + skill_proposal_events (wave 2.4 — local proposal lifecycle)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_proposals (
          proposal_id TEXT PRIMARY KEY,
          skill_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          target TEXT NOT NULL,
          source_root TEXT,
          target_source_path TEXT,
          relative_source_file TEXT,
          origin_activity_id TEXT,
          origin_message_id TEXT,
          summary TEXT,
          author TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          validated_at TEXT,
          materialized_at TEXT,
          accepted_at TEXT,
          rejected_at TEXT,
          superseded_at TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_skill_proposals_status
          ON skill_proposals(status);
        CREATE INDEX IF NOT EXISTS idx_skill_proposals_skill_id
          ON skill_proposals(skill_id);
        CREATE INDEX IF NOT EXISTS idx_skill_proposals_created_at
          ON skill_proposals(created_at);

        CREATE TABLE IF NOT EXISTS skill_proposal_events (
          event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          proposal_id TEXT NOT NULL REFERENCES skill_proposals(proposal_id) ON DELETE CASCADE,
          occurred_at TEXT NOT NULL,
          event_type TEXT NOT NULL,
          status_before TEXT,
          status_after TEXT NOT NULL,
          actor TEXT,
          note TEXT,
          payload_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_skill_proposal_events_proposal_id
          ON skill_proposal_events(proposal_id, event_seq);
        CREATE INDEX IF NOT EXISTS idx_skill_proposal_events_occurred_at
          ON skill_proposal_events(occurred_at);
      `);
    },
  },
  {
    id: "0005",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "fleet convergence: per-host per-leg convergence observations (POL-1754)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS fleet_convergence (
          host TEXT NOT NULL,
          leg TEXT NOT NULL,
          target_rev TEXT NOT NULL,
          observed_rev TEXT,
          converged_from TEXT NOT NULL,
          policy TEXT NOT NULL,
          last_checked_at TEXT NOT NULL,
          verdict TEXT NOT NULL,
          receipt_path TEXT,
          receipt_id TEXT,
          detail TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY (host, leg)
        );

        CREATE INDEX IF NOT EXISTS idx_fleet_convergence_verdict
          ON fleet_convergence(verdict);
        CREATE INDEX IF NOT EXISTS idx_fleet_convergence_last_checked_at
          ON fleet_convergence(last_checked_at);
        CREATE INDEX IF NOT EXISTS idx_fleet_convergence_leg
          ON fleet_convergence(leg);
      `);
    },
  },
  {
    id: "0006",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "fleet convergence: allow unknown target_rev while preserving SHA-only target semantics (POL-1754 review)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS fleet_convergence_next (
          host TEXT NOT NULL,
          leg TEXT NOT NULL,
          target_rev TEXT,
          observed_rev TEXT,
          converged_from TEXT NOT NULL,
          policy TEXT NOT NULL,
          last_checked_at TEXT NOT NULL,
          verdict TEXT NOT NULL,
          receipt_path TEXT,
          receipt_id TEXT,
          detail TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY (host, leg)
        );

        INSERT OR REPLACE INTO fleet_convergence_next
          (host, leg, target_rev, observed_rev, converged_from, policy,
           last_checked_at, verdict, receipt_path, receipt_id, detail, payload_json)
        SELECT
          host,
          leg,
          CASE
            WHEN target_rev GLOB '[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]'
              THEN target_rev
            ELSE NULL
          END AS target_rev,
          observed_rev,
          converged_from,
          policy,
          last_checked_at,
          verdict,
          receipt_path,
          receipt_id,
          detail,
          payload_json
        FROM fleet_convergence
        WHERE EXISTS (
          SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fleet_convergence'
        );

        DROP TABLE IF EXISTS fleet_convergence;
        ALTER TABLE fleet_convergence_next RENAME TO fleet_convergence;

        CREATE INDEX IF NOT EXISTS idx_fleet_convergence_verdict
          ON fleet_convergence(verdict);
        CREATE INDEX IF NOT EXISTS idx_fleet_convergence_last_checked_at
          ON fleet_convergence(last_checked_at);
        CREATE INDEX IF NOT EXISTS idx_fleet_convergence_leg
          ON fleet_convergence(leg);
      `);
    },
  },
  {
    id: "0007",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "monitor wake substrate: monitors + cursors + history + wake inbox (POL-1732a)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS monitors (
          monitor_id TEXT PRIMARY KEY,
          schema_version TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          owner TEXT NOT NULL,
          created_by TEXT NOT NULL,
          create_provenance TEXT NOT NULL,
          assigned_host TEXT,
          source_run_id TEXT,
          preset TEXT,
          predicate_json TEXT NOT NULL,
          rearm_policy TEXT NOT NULL,
          delivery_json TEXT NOT NULL,
          last_evaluated_at TEXT,
          last_match INTEGER,
          last_transition_hash TEXT,
          last_wake_id TEXT,
          last_error TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_monitors_status
          ON monitors(status);
        CREATE INDEX IF NOT EXISTS idx_monitors_assigned_host
          ON monitors(assigned_host);
        CREATE INDEX IF NOT EXISTS idx_monitors_source_run_id
          ON monitors(source_run_id);

        CREATE TABLE IF NOT EXISTS monitor_cursors (
          monitor_id TEXT PRIMARY KEY REFERENCES monitors(monitor_id) ON DELETE CASCADE,
          cursor_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS monitor_history (
          history_id INTEGER PRIMARY KEY AUTOINCREMENT,
          monitor_id TEXT NOT NULL REFERENCES monitors(monitor_id) ON DELETE CASCADE,
          occurred_at TEXT NOT NULL,
          event_type TEXT NOT NULL,
          transition_hash TEXT,
          matched INTEGER,
          wake_id TEXT,
          evidence_json TEXT NOT NULL DEFAULT '{}',
          detail TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_monitor_history_monitor_time
          ON monitor_history(monitor_id, occurred_at);
        CREATE INDEX IF NOT EXISTS idx_monitor_history_event_type
          ON monitor_history(event_type);

        CREATE TABLE IF NOT EXISTS monitor_wakes (
          wake_id TEXT PRIMARY KEY,
          schema_version TEXT NOT NULL,
          monitor_id TEXT NOT NULL REFERENCES monitors(monitor_id) ON DELETE CASCADE,
          transition_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          acked_at TEXT,
          acked_by TEXT,
          rearm_policy TEXT NOT NULL,
          predicate_json TEXT NOT NULL,
          evaluation_json TEXT NOT NULL,
          delivery_json TEXT NOT NULL,
          suggested_commands_json TEXT NOT NULL DEFAULT '[]',
          receipt_path TEXT,
          UNIQUE(monitor_id, transition_hash)
        );

        CREATE INDEX IF NOT EXISTS idx_monitor_wakes_status
          ON monitor_wakes(status);
        CREATE INDEX IF NOT EXISTS idx_monitor_wakes_created_at
          ON monitor_wakes(created_at);
        CREATE INDEX IF NOT EXISTS idx_monitor_wakes_monitor
          ON monitor_wakes(monitor_id, created_at);
      `);
    },
  },
  {
    id: "0008",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "task lifecycle substrate: task installs, predicate cursors, task runs, and history (POL-1730)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_installs (
          install_id TEXT PRIMARY KEY,
          schema_version TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          task_id TEXT NOT NULL,
          host TEXT NOT NULL,
          owner TEXT,
          installed_by TEXT NOT NULL,
          manifest_path TEXT NOT NULL,
          manifest_hash TEXT NOT NULL,
          task_json TEXT NOT NULL,
          predicate_json TEXT NOT NULL,
          launch_policy_json TEXT NOT NULL,
          mode TEXT NOT NULL,
          unattended_enabled INTEGER NOT NULL DEFAULT 0,
          app_mutation_enabled INTEGER NOT NULL DEFAULT 0,
          last_evaluated_at TEXT,
          last_match INTEGER,
          last_transition_hash TEXT,
          last_task_run_id TEXT,
          last_run_id TEXT,
          last_error TEXT,
          UNIQUE(task_id, host)
        );

        CREATE INDEX IF NOT EXISTS idx_task_installs_status
          ON task_installs(status);
        CREATE INDEX IF NOT EXISTS idx_task_installs_task_id
          ON task_installs(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_installs_host
          ON task_installs(host);

        CREATE TABLE IF NOT EXISTS task_install_cursors (
          install_id TEXT PRIMARY KEY REFERENCES task_installs(install_id) ON DELETE CASCADE,
          cursor_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS task_runs (
          task_run_id TEXT PRIMARY KEY,
          schema_version TEXT NOT NULL,
          task_id TEXT NOT NULL,
          install_id TEXT REFERENCES task_installs(install_id) ON DELETE SET NULL,
          trigger_kind TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          run_id TEXT,
          mode TEXT NOT NULL,
          dry_run INTEGER NOT NULL DEFAULT 0,
          launch_policy_json TEXT NOT NULL,
          predicate_evaluation_json TEXT,
          summary TEXT NOT NULL,
          receipt_path TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_task_runs_task_id
          ON task_runs(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_runs_install
          ON task_runs(install_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_task_runs_run_id
          ON task_runs(run_id);
        CREATE INDEX IF NOT EXISTS idx_task_runs_status
          ON task_runs(status);

        CREATE TABLE IF NOT EXISTS task_history (
          history_id INTEGER PRIMARY KEY AUTOINCREMENT,
          install_id TEXT REFERENCES task_installs(install_id) ON DELETE SET NULL,
          task_id TEXT NOT NULL,
          task_run_id TEXT REFERENCES task_runs(task_run_id) ON DELETE SET NULL,
          occurred_at TEXT NOT NULL,
          event_type TEXT NOT NULL,
          detail TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_task_history_install_time
          ON task_history(install_id, occurred_at);
        CREATE INDEX IF NOT EXISTS idx_task_history_task_time
          ON task_history(task_id, occurred_at);
        CREATE INDEX IF NOT EXISTS idx_task_history_event_type
          ON task_history(event_type);
      `);
    },
  },
  {
    id: "0009",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "monitor wake delivery state: per-wake delivery attempts and adapter evidence (POL-1732b)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS monitor_deliveries (
          delivery_id TEXT PRIMARY KEY,
          wake_id TEXT NOT NULL REFERENCES monitor_wakes(wake_id) ON DELETE CASCADE,
          monitor_id TEXT NOT NULL REFERENCES monitors(monitor_id) ON DELETE CASCADE,
          binding_id TEXT NOT NULL,
          adapter TEXT NOT NULL,
          status TEXT NOT NULL,
          attempted_at TEXT NOT NULL,
          delivered_at TEXT,
          failed_at TEXT,
          updated_at TEXT NOT NULL,
          target_json TEXT NOT NULL DEFAULT '{}',
          evidence_json TEXT NOT NULL DEFAULT '{}',
          error_code TEXT,
          error_message TEXT,
          UNIQUE(wake_id, binding_id)
        );

        CREATE INDEX IF NOT EXISTS idx_monitor_deliveries_wake
          ON monitor_deliveries(wake_id);
        CREATE INDEX IF NOT EXISTS idx_monitor_deliveries_monitor
          ON monitor_deliveries(monitor_id, attempted_at);
        CREATE INDEX IF NOT EXISTS idx_monitor_deliveries_status
          ON monitor_deliveries(status);
        CREATE INDEX IF NOT EXISTS idx_monitor_deliveries_binding
          ON monitor_deliveries(binding_id);
      `);
    },
  },
  {
    id: "0010",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "runner live bindings: Calyx-owned live transport metadata for monitor delivery adapters (POL-1777)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS runner_live_bindings (
          binding_id TEXT PRIMARY KEY,
          schema_version TEXT NOT NULL,
          run_id TEXT NOT NULL,
          adapter TEXT NOT NULL,
          backend TEXT NOT NULL,
          lifecycle_owner TEXT NOT NULL,
          host TEXT NOT NULL,
          status TEXT NOT NULL,
          codex_home TEXT,
          transport_kind TEXT NOT NULL,
          endpoint_json TEXT NOT NULL DEFAULT '{}',
          thread_id TEXT,
          active_turn_id TEXT,
          active_turn_source TEXT,
          active_turn_observed_at TEXT,
          active_turn_status TEXT,
          adapter_session_id TEXT,
          connection_id TEXT,
          auth_ref_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          closed_at TEXT,
          last_error TEXT,
          UNIQUE(run_id, adapter)
        );

        CREATE INDEX IF NOT EXISTS idx_runner_live_bindings_run
          ON runner_live_bindings(run_id);
        CREATE INDEX IF NOT EXISTS idx_runner_live_bindings_thread
          ON runner_live_bindings(thread_id);
        CREATE INDEX IF NOT EXISTS idx_runner_live_bindings_status
          ON runner_live_bindings(status);
        CREATE INDEX IF NOT EXISTS idx_runner_live_bindings_adapter
          ON runner_live_bindings(adapter, status);
      `);
    },
  },
  {
    id: "0011",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "correspondence messages: recipient-host inbox, sender outbox, and delivery state (POL-1789)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          message_id TEXT PRIMARY KEY,
          schema_version TEXT NOT NULL,
          sender TEXT NOT NULL,
          recipient_address TEXT NOT NULL,
          recipient_class TEXT NOT NULL,
          recipient_host TEXT,
          subject TEXT NOT NULL,
          body TEXT NOT NULL,
          thread_key TEXT,
          reply_to TEXT,
          idempotency_key TEXT,
          urgency TEXT NOT NULL,
          ack_required INTEGER NOT NULL DEFAULT 0,
          expires_at TEXT,
          status TEXT NOT NULL,
          claimed_until TEXT,
          claimed_by TEXT,
          expired_claim_cycles INTEGER NOT NULL DEFAULT 0,
          dead_letter INTEGER NOT NULL DEFAULT 0,
          dead_letter_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          spooled_at TEXT NOT NULL,
          delivered_at TEXT,
          acked_at TEXT,
          acked_by TEXT,
          receipt_path TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}',
          UNIQUE(sender, idempotency_key)
        );

        CREATE INDEX IF NOT EXISTS idx_messages_recipient_status
          ON messages(recipient_address, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_recipient_host
          ON messages(recipient_host, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_thread
          ON messages(thread_key, created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_reply_to
          ON messages(reply_to);
        CREATE INDEX IF NOT EXISTS idx_messages_status
          ON messages(status);
        CREATE INDEX IF NOT EXISTS idx_messages_expires_at
          ON messages(expires_at);
        CREATE INDEX IF NOT EXISTS idx_messages_claimed_until
          ON messages(claimed_until);
        CREATE INDEX IF NOT EXISTS idx_messages_sender_idempotency
          ON messages(sender, idempotency_key);

        CREATE TABLE IF NOT EXISTS message_deliveries (
          delivery_id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
          binding_id TEXT NOT NULL,
          adapter TEXT NOT NULL,
          status TEXT NOT NULL,
          attempted_at TEXT NOT NULL,
          delivered_at TEXT,
          failed_at TEXT,
          updated_at TEXT NOT NULL,
          target_json TEXT NOT NULL DEFAULT '{}',
          evidence_json TEXT NOT NULL DEFAULT '{}',
          error_code TEXT,
          error_message TEXT,
          UNIQUE(message_id, binding_id)
        );

        CREATE INDEX IF NOT EXISTS idx_message_deliveries_message
          ON message_deliveries(message_id);
        CREATE INDEX IF NOT EXISTS idx_message_deliveries_status
          ON message_deliveries(status);
        CREATE INDEX IF NOT EXISTS idx_message_deliveries_binding
          ON message_deliveries(binding_id);

        CREATE TABLE IF NOT EXISTS outbox (
          outbox_id TEXT PRIMARY KEY,
          schema_version TEXT NOT NULL,
          message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
          target_host TEXT NOT NULL,
          target_url TEXT,
          status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_attempt_at TEXT,
          forwarded_at TEXT,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_error_code TEXT,
          last_error_message TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}',
          UNIQUE(message_id, target_host)
        );

        CREATE INDEX IF NOT EXISTS idx_outbox_status_next_attempt
          ON outbox(status, next_attempt_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_outbox_target_host
          ON outbox(target_host, status);
        CREATE INDEX IF NOT EXISTS idx_outbox_expires_at
          ON outbox(expires_at);
      `);
    },
  },
  {
    id: "0012",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "leases: named-resource conflict organ for worktrees, sessions, vault paths, and issues (POL-1790; after POL-1789 messages)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS leases (
          key TEXT PRIMARY KEY,
          holder_activity_id TEXT NOT NULL,
          owner_host TEXT NOT NULL,
          resource_kind TEXT NOT NULL,
          resource_host TEXT,
          resource_path TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          ttl_ms INTEGER NOT NULL,
          renewed_at TEXT,
          expires_at TEXT NOT NULL,
          stolen_from_holder_activity_id TEXT,
          stolen_at TEXT,
          steal_provenance_json TEXT NOT NULL DEFAULT '{}',
          metadata_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_leases_holder
          ON leases(holder_activity_id);
        CREATE INDEX IF NOT EXISTS idx_leases_owner_host
          ON leases(owner_host);
        CREATE INDEX IF NOT EXISTS idx_leases_resource_kind
          ON leases(resource_kind);
        CREATE INDEX IF NOT EXISTS idx_leases_expires_at
          ON leases(expires_at);
      `);
    },
  },
  {
    id: "0013",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "activity recall index: normalized transcript messages, per-source resume cursors, and ingest freshness runs (POL-1838)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS activity_messages (
          message_id TEXT PRIMARY KEY,
          activity_id TEXT NOT NULL,
          turn_id TEXT,
          seq INTEGER NOT NULL,
          origin TEXT NOT NULL,
          text TEXT NOT NULL DEFAULT '',
          token_count INTEGER,
          host TEXT,
          backend TEXT NOT NULL,
          source_path TEXT NOT NULL,
          source_offset INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          classifier_version TEXT NOT NULL,
          attachment_refs TEXT NOT NULL DEFAULT '[]',
          observed_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_activity_messages_activity
          ON activity_messages(activity_id, seq);
        CREATE INDEX IF NOT EXISTS idx_activity_messages_source
          ON activity_messages(source_path);
        CREATE INDEX IF NOT EXISTS idx_activity_messages_turn
          ON activity_messages(turn_id);
        CREATE INDEX IF NOT EXISTS idx_activity_messages_content_hash
          ON activity_messages(content_hash);

        CREATE TABLE IF NOT EXISTS activity_source_cursors (
          source_path TEXT PRIMARY KEY,
          backend TEXT NOT NULL,
          activity_id TEXT,
          byte_offset INTEGER NOT NULL DEFAULT 0,
          next_line INTEGER NOT NULL DEFAULT 1,
          resume_offset INTEGER NOT NULL DEFAULT 0,
          resume_line INTEGER NOT NULL DEFAULT 1,
          size_bytes INTEGER,
          mtime_ms INTEGER,
          content_hash TEXT,
          classifier_version TEXT NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          last_indexed_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_activity_source_cursors_activity
          ON activity_source_cursors(activity_id);
        CREATE INDEX IF NOT EXISTS idx_activity_source_cursors_backend
          ON activity_source_cursors(backend);
        CREATE INDEX IF NOT EXISTS idx_activity_source_cursors_updated_at
          ON activity_source_cursors(updated_at);

        CREATE TABLE IF NOT EXISTS activity_index_runs (
          run_id TEXT PRIMARY KEY,
          host TEXT,
          trigger TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          status TEXT NOT NULL,
          sources_scanned INTEGER NOT NULL DEFAULT 0,
          sources_changed INTEGER NOT NULL DEFAULT 0,
          sources_pending INTEGER NOT NULL DEFAULT 0,
          messages_upserted INTEGER NOT NULL DEFAULT 0,
          bytes_ingested INTEGER NOT NULL DEFAULT 0,
          indexed_through TEXT,
          classifier_version TEXT NOT NULL,
          error TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_activity_index_runs_started_at
          ON activity_index_runs(started_at);
        CREATE INDEX IF NOT EXISTS idx_activity_index_runs_status
          ON activity_index_runs(status);
      `);
    },
  },
  {
    id: "0014",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "activity recall read projection: DTO reconstruction payloads, message timestamps, and attachment metadata (POL-1839)",
    up: (db) => {
      db.exec(`
        ALTER TABLE activity_messages ADD COLUMN timestamp TEXT;
        ALTER TABLE activity_messages ADD COLUMN payload_json TEXT;

        CREATE INDEX IF NOT EXISTS idx_activity_messages_timestamp
          ON activity_messages(timestamp);

        CREATE TABLE IF NOT EXISTS activity_attachments (
          attachment_id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES activity_messages(message_id) ON DELETE CASCADE,
          origin TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          mime TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          observed_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_activity_attachments_message
          ON activity_attachments(message_id);
        CREATE INDEX IF NOT EXISTS idx_activity_attachments_sha256
          ON activity_attachments(sha256);
        CREATE INDEX IF NOT EXISTS idx_activity_attachments_origin
          ON activity_attachments(origin);
      `);
    },
  },
  {
    id: "0015",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "messages: split durable spool time from confirmed delivery time (POL-1830)",
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has("spooled_at")) {
        db.exec("ALTER TABLE messages ADD COLUMN spooled_at TEXT");
      }
      db.exec(`
        UPDATE messages
        SET spooled_at = COALESCE(spooled_at, created_at, delivered_at, updated_at)
        WHERE spooled_at IS NULL
      `);
    },
  },
  {
    id: "0016",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "agent-owned skill content: skill_content (DB-of-record full-document payloads) + skill_write_log (append-only write/delete events) (POL-1729)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_content (
          host_id TEXT NOT NULL,
          skill_name TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          regime TEXT NOT NULL DEFAULT 'db',
          payload_json TEXT NOT NULL,
          deleted_at TEXT,
          origin_activity_id TEXT,
          origin_message_id TEXT,
          author TEXT,
          summary TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          materialized_at TEXT,
          PRIMARY KEY (host_id, skill_name)
        );

        CREATE INDEX IF NOT EXISTS idx_skill_content_regime
          ON skill_content(regime);
        CREATE INDEX IF NOT EXISTS idx_skill_content_updated_at
          ON skill_content(updated_at);

        CREATE TABLE IF NOT EXISTS skill_write_log (
          event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          skill_name TEXT NOT NULL,
          host_id TEXT NOT NULL,
          regime TEXT NOT NULL,
          write_class TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          origin_activity_id TEXT,
          origin_message_id TEXT,
          actor TEXT,
          note TEXT,
          occurred_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_skill_write_log_skill
          ON skill_write_log(skill_name, event_seq);
        CREATE INDEX IF NOT EXISTS idx_skill_write_log_occurred_at
          ON skill_write_log(occurred_at);
      `);
    },
  },
  {
    id: "0017",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "agent-owned skill content: pinned column on skill_content (curator-apply protection fence) (POL-1729 Slice 3)",
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(skill_content)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has("pinned")) {
        db.exec("ALTER TABLE skill_content ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_skill_content_pinned
          ON skill_content(pinned, host_id);
      `);
    },
  },
  {
    id: "0018",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "curated-facts memory: memory_content (curated facts, STRICT review_status posture) + memory_write_log (append-only write/approve/reject/delete events) (POL-1729 Slice 4)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_content (
          host_id TEXT NOT NULL,
          memory_key TEXT NOT NULL,
          value TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          category TEXT NOT NULL,
          review_status TEXT NOT NULL DEFAULT 'pending',
          pinned INTEGER NOT NULL DEFAULT 0,
          deleted_at TEXT,
          origin_activity_id TEXT,
          origin_message_id TEXT,
          author TEXT,
          summary TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          approved_at TEXT,
          PRIMARY KEY (host_id, memory_key)
        );

        CREATE INDEX IF NOT EXISTS idx_memory_content_review_status
          ON memory_content(review_status);
        CREATE INDEX IF NOT EXISTS idx_memory_content_category
          ON memory_content(category);

        CREATE TABLE IF NOT EXISTS memory_write_log (
          event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_key TEXT NOT NULL,
          host_id TEXT NOT NULL,
          write_class TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          review_status TEXT NOT NULL,
          origin_activity_id TEXT,
          origin_message_id TEXT,
          actor TEXT,
          note TEXT,
          occurred_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_memory_write_log_memory
          ON memory_write_log(memory_key, event_seq);
        CREATE INDEX IF NOT EXISTS idx_memory_write_log_occurred_at
          ON memory_write_log(occurred_at);
      `);
    },
  },
  {
    id: "0019",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "forward repair: ensure skill_content pinned fence after migration-0017 collision (POL-1958)",
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(skill_content)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has("pinned")) {
        db.exec("ALTER TABLE skill_content ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_skill_content_pinned
          ON skill_content(pinned, host_id);
      `);
    },
  },
  {
    id: "0020",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "consumer API idempotency: subject-scoped JCS request identity and replay receipts (POL-1980)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS api_idempotency (
          subject TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          canonicalizer TEXT NOT NULL,
          schema_major INTEGER NOT NULL,
          response_status INTEGER NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (subject, operation_id, idempotency_key)
        );

        CREATE INDEX IF NOT EXISTS idx_api_idempotency_created_at
          ON api_idempotency(created_at);
      `);
    },
  },
  {
    id: "0021",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "message receipt mirror retry ledger: immutable receipt snapshots and indexed durable pending work (POL-1980)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS message_receipt_mirrors (
          message_id TEXT NOT NULL PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
          receipt_snapshot_json TEXT NOT NULL CHECK (json_valid(receipt_snapshot_json)),
          status TEXT NOT NULL
            CONSTRAINT receipt_mirror_status CHECK (status IN ('pending', 'completed')),
          attempt_count INTEGER NOT NULL DEFAULT 0
            CONSTRAINT receipt_mirror_attempt_count
            CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
          next_attempt_at TEXT,
          last_attempt_at TEXT,
          completed_at TEXT,
          receipt_path TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CONSTRAINT receipt_mirror_control_state CHECK (${MESSAGE_RECEIPT_MIRROR_CONTROL_CHECK_SQL})
        );

        CREATE INDEX IF NOT EXISTS idx_message_receipt_mirrors_pending
          ON message_receipt_mirrors(status, next_attempt_at, created_at);
      `);
    },
  },
  {
    id: "0022",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "consumer API forward repair: launch provenance and fail-closed receipt evidence upgrade (POL-1980)",
    up: (db) => {
      const receiptMirrorColumns = new Set(
        (db.prepare("PRAGMA table_info(message_receipt_mirrors)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!receiptMirrorColumns.has("receipt_snapshot_json")) {
        const legacyMirrorCount = (db.prepare(
          "SELECT COUNT(*) AS count FROM message_receipt_mirrors",
        ).get() as { count: number }).count;
        if (legacyMirrorCount > 0) {
          // A current message row is mutable after admission. It therefore
          // cannot authenticate the historical state that an older mirror
          // row was meant to preserve. Refuse the upgrade instead of
          // laundering present state into immutable boundary evidence.
          throw new Error(
            `migration 0022 cannot establish authentic immutable receipt snapshots for ${legacyMirrorCount} legacy mirror row(s); preserve the database and migrate those rows with operator-supplied admission evidence`,
          );
        }
        // The empty interim table carries no historical evidence to recover.
        // Adding the nullable column is safe; migration 0027 rebuilds the
        // table with the final NOT NULL and JSON constraints.
        db.exec("ALTER TABLE message_receipt_mirrors ADD COLUMN receipt_snapshot_json TEXT");
      }

      const missingSnapshotCount = (db.prepare(
        `SELECT COUNT(*) AS count
           FROM message_receipt_mirrors
          WHERE receipt_snapshot_json IS NULL`,
      ).get() as { count: number }).count;
      if (missingSnapshotCount > 0) {
        throw new Error(
          `migration 0022 cannot establish authentic immutable receipt snapshots for ${missingSnapshotCount} legacy mirror row(s); preserve the database and migrate those rows with operator-supplied admission evidence`,
        );
      }

      const idempotencyColumns = new Set(
        (db.prepare("PRAGMA table_info(api_idempotency)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!idempotencyColumns.has("asserted_actor")) {
        db.exec("ALTER TABLE api_idempotency ADD COLUMN asserted_actor TEXT");
      }
    },
  },
  {
    id: "0023",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "HTTP mutation request provenance: durable admitted and response lifecycle audit (POL-1980)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS api_request_audit (
          request_id TEXT PRIMARY KEY,
          server_instance_id TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          subject TEXT NOT NULL,
          asserted_actor TEXT,
          served_by_host TEXT NOT NULL,
          via TEXT NOT NULL CHECK (via = 'http'),
          admitted_at TEXT NOT NULL,
          finalized_at TEXT,
          response_status INTEGER,
          error_code TEXT,
          outcome TEXT NOT NULL CHECK (
            outcome IN ('admitted', 'response_completed', 'response_rejected', 'indeterminate')
          ),
          CHECK (
            (outcome = 'admitted'
              AND finalized_at IS NULL AND response_status IS NULL AND error_code IS NULL)
            OR (outcome = 'response_completed'
              AND finalized_at IS NOT NULL AND response_status BETWEEN 200 AND 299)
            OR (outcome = 'response_rejected'
              AND finalized_at IS NOT NULL AND response_status BETWEEN 300 AND 599)
            OR (outcome = 'indeterminate'
              AND finalized_at IS NOT NULL
              AND (response_status IS NULL OR response_status BETWEEN 200 AND 599))
          )
        );

        CREATE INDEX IF NOT EXISTS idx_api_request_audit_admitted_at
          ON api_request_audit(admitted_at);
        CREATE INDEX IF NOT EXISTS idx_api_request_audit_outcome_admitted_at
          ON api_request_audit(outcome, admitted_at);
        CREATE INDEX IF NOT EXISTS idx_api_request_audit_operation_admitted_at
          ON api_request_audit(operation_id, admitted_at);

        ALTER TABLE api_idempotency ADD COLUMN first_request_id TEXT;
        ALTER TABLE messages ADD COLUMN created_provenance_json TEXT
          CHECK (created_provenance_json IS NULL OR json_valid(created_provenance_json));
        ALTER TABLE messages ADD COLUMN ingress_provenance_json TEXT
          CHECK (ingress_provenance_json IS NULL OR json_valid(ingress_provenance_json));
        ALTER TABLE monitors ADD COLUMN created_provenance_json TEXT
          CHECK (created_provenance_json IS NULL OR json_valid(created_provenance_json));
        ALTER TABLE monitor_history ADD COLUMN provenance_json TEXT
          CHECK (provenance_json IS NULL OR json_valid(provenance_json));

        CREATE TABLE lease_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL,
          event_type TEXT NOT NULL CHECK (event_type IN ('acquired', 'renewed', 'released', 'stolen')),
          occurred_at TEXT NOT NULL,
          reason TEXT,
          before_lease_json TEXT CHECK (before_lease_json IS NULL OR json_valid(before_lease_json)),
          after_lease_json TEXT CHECK (after_lease_json IS NULL OR json_valid(after_lease_json)),
          request_provenance_json TEXT
            CHECK (request_provenance_json IS NULL OR json_valid(request_provenance_json)),
          CHECK (
            (event_type = 'acquired' AND after_lease_json IS NOT NULL)
            OR (event_type IN ('renewed', 'stolen') AND before_lease_json IS NOT NULL AND after_lease_json IS NOT NULL)
            OR (event_type = 'released' AND before_lease_json IS NOT NULL AND after_lease_json IS NULL)
          )
        );
        CREATE INDEX idx_lease_events_key_event ON lease_events(key, event_id);
        CREATE INDEX idx_lease_events_request
          ON lease_events(json_extract(request_provenance_json, '$.request_id'));
      `);
    },
  },
  {
    id: "0024",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "consumer API idempotency: preserve complete immutable first-request provenance (POL-1980)",
    up: (db) => {
      db.exec(`
        ALTER TABLE api_idempotency ADD COLUMN first_request_provenance_json TEXT
          CHECK (first_request_provenance_json IS NULL OR json_valid(first_request_provenance_json));
      `);
    },
  },
  {
    id: "0025",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "message outbox attempt fencing: durable in-flight leases and indeterminate crash recovery (POL-1980)",
    up: (db) => {
      db.exec(`
        ALTER TABLE outbox ADD COLUMN attempt_id TEXT;
        ALTER TABLE outbox ADD COLUMN attempt_expires_at TEXT;

        CREATE INDEX idx_outbox_status_attempt_expires
          ON outbox(status, attempt_expires_at, expires_at);
      `);
    },
  },
  {
    id: "0026",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "message outbox acceptance ambiguity: monotonic unknown-outcome evidence across retries (POL-1980)",
    up: (db) => {
      db.exec(`
        ALTER TABLE outbox ADD COLUMN acceptance_ambiguous INTEGER NOT NULL DEFAULT 0
          CHECK (acceptance_ambiguous IN (0, 1));
      `);
    },
  },
  {
    id: "0027",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "message receipt mirror constraint verification: exact immutable snapshot NOT NULL and JSON validity (POL-1980)",
    up: (db) => {
      const receiptMirrorColumns = new Set(
        (db.prepare("PRAGMA table_info(message_receipt_mirrors)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!receiptMirrorColumns.has("receipt_snapshot_json")) {
        // Make the legacy absence queryable inside this transaction. Any row
        // without authentic boundary evidence fails below; an empty table can
        // still advance safely to the constrained canonical schema.
        db.exec("ALTER TABLE message_receipt_mirrors ADD COLUMN receipt_snapshot_json TEXT");
      }
      const orphan = db.prepare(
        `SELECT r.message_id, m.message_id AS source_message_id
           FROM message_receipt_mirrors AS r
           LEFT JOIN messages AS m ON m.message_id = r.message_id
          WHERE r.message_id IS NULL OR m.message_id IS NULL
          LIMIT 1`,
      ).get() as { message_id: string | null; source_message_id: string | null } | undefined;
      if (orphan) {
        throw new Error(
          `migration 0027 cannot preserve a receipt mirror without a non-null authoritative message id: ${orphan.message_id ?? "NULL"}`,
        );
      }
      db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS calyx_migration_0027_expected (
          receipt_path TEXT NOT NULL,
          message_id TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          PRIMARY KEY (receipt_path, message_id)
        ) WITHOUT ROWID;
        CREATE TEMP TABLE IF NOT EXISTS calyx_migration_0027_evidence (
          receipt_path TEXT NOT NULL,
          message_id TEXT NOT NULL,
          first_envelope_json TEXT NOT NULL,
          candidate_count INTEGER NOT NULL CHECK (candidate_count IN (1, 2)),
          PRIMARY KEY (receipt_path, message_id)
        ) WITHOUT ROWID;
        DELETE FROM calyx_migration_0027_expected;
        DELETE FROM calyx_migration_0027_evidence;
      `);
      try {
        const pageSize = 256;
        const retainExpectation = db.prepare(
          `INSERT INTO calyx_migration_0027_expected
             (receipt_path, message_id, snapshot_json)
           VALUES (?, ?, ?)`,
        );
        let afterMessageId: string | undefined;
        while (true) {
          const receiptSnapshots = db.prepare(
            `SELECT
               r.message_id AS receipt_mirror_message_id,
               r.receipt_snapshot_json,
               r.status AS receipt_mirror_status,
               r.attempt_count AS receipt_mirror_attempt_count,
               r.next_attempt_at AS receipt_mirror_next_attempt_at,
               r.last_attempt_at AS receipt_mirror_last_attempt_at,
               r.completed_at AS receipt_mirror_completed_at,
               r.receipt_path AS receipt_mirror_receipt_path,
               r.last_error_code AS receipt_mirror_last_error_code,
               r.last_error_message AS receipt_mirror_last_error_message,
               r.created_at AS receipt_mirror_created_at,
               r.updated_at AS receipt_mirror_updated_at,
               m.message_id, m.schema_version, m.sender, m.recipient_address,
               m.recipient_class, m.recipient_host, m.subject, m.body, m.thread_key,
               m.reply_to, m.idempotency_key, m.urgency, m.ack_required,
               m.expires_at, m.status, m.claimed_until, m.claimed_by,
               m.expired_claim_cycles, m.dead_letter, m.dead_letter_reason,
               m.created_at, m.updated_at, m.spooled_at, m.delivered_at,
               m.acked_at, m.acked_by, m.receipt_path, m.payload_json,
               m.created_provenance_json, m.ingress_provenance_json
             FROM messages AS m
             JOIN message_receipt_mirrors AS r ON r.message_id = m.message_id
             ${afterMessageId === undefined ? "" : "WHERE m.message_id > ?"}
             ORDER BY m.message_id
             LIMIT ?`,
          ).all(...(afterMessageId === undefined ? [pageSize] : [afterMessageId, pageSize])) as
            ReceiptSnapshotRepairRow[];
          if (receiptSnapshots.length === 0) break;
          for (const message of receiptSnapshots) {
            afterMessageId = message.message_id;
            if (
              typeof message.receipt_mirror_message_id !== "string"
              || message.receipt_mirror_message_id.trim() !== message.receipt_mirror_message_id
              || message.receipt_mirror_message_id.length === 0
              || message.receipt_mirror_message_id !== message.message_id
            ) {
              throw new Error(
                `migration 0027 cannot preserve an invalid raw receipt-mirror message id for ${message.message_id}`,
              );
            }
            const controlError = messageReceiptMirrorControlValidationError({
              message_id: message.receipt_mirror_message_id,
              status: message.receipt_mirror_status,
              attempt_count: message.receipt_mirror_attempt_count,
              next_attempt_at: message.receipt_mirror_next_attempt_at,
              last_attempt_at: message.receipt_mirror_last_attempt_at,
              completed_at: message.receipt_mirror_completed_at,
              receipt_path: message.receipt_mirror_receipt_path,
              last_error_code: message.receipt_mirror_last_error_code,
              last_error_message: message.receipt_mirror_last_error_message,
              created_at: message.receipt_mirror_created_at,
              updated_at: message.receipt_mirror_updated_at,
            });
            if (controlError) {
              throw new Error(
                `migration 0027 cannot preserve invalid receipt-mirror control state for ${message.message_id}: ${controlError}`,
              );
            }
            let parsed: unknown;
            try {
              parsed = message.receipt_snapshot_json === null
                ? null
                : JSON.parse(message.receipt_snapshot_json) as unknown;
            } catch {
              parsed = undefined;
            }
            const currentSource = legacyReceiptSnapshot(message);
            const sourceError = messageReceiptSnapshotValidationError(currentSource, message.message_id);
            if (sourceError) {
              throw new Error(
                `migration 0027 cannot validate the authoritative source row for ${message.message_id}: ${sourceError}`,
              );
            }
            const snapshotError = messageReceiptAdmissionSnapshotValidationError(parsed, message.message_id)
              ?? messageReceiptSnapshotCorrespondenceError(parsed, currentSource);
            if (snapshotError) {
              // The live message row may have advanced since the mirror was
              // queued. It can prove correspondence but cannot reconstruct the
              // original mutation-boundary snapshot.
              throw new Error(
                `migration 0027 cannot establish an authentic immutable receipt snapshot for ${message.message_id}: ${snapshotError}`,
              );
            }
            if (message.receipt_mirror_status !== "completed") continue;
            if (message.receipt_mirror_receipt_path !== message.receipt_path) {
              throw new Error(
                `migration 0027 cannot preserve completed receipt mirror ${message.message_id}: mirror receipt_path does not match the authoritative message row`,
              );
            }
            retainExpectation.run(
              message.receipt_mirror_receipt_path!,
              message.message_id,
              JSON.stringify(parsed),
            );
          }
          if (receiptSnapshots.length < pageSize) break;
        }

        const retainEvidence = db.prepare(
          `INSERT INTO calyx_migration_0027_evidence
             (receipt_path, message_id, first_envelope_json, candidate_count)
           SELECT ?, ?, ?, 1
            WHERE EXISTS (
              SELECT 1 FROM calyx_migration_0027_expected
               WHERE receipt_path = ? AND message_id = ?
            )
           ON CONFLICT (receipt_path, message_id) DO UPDATE
             SET candidate_count = 2`,
        );
        const discardPathEvidence = db.prepare(
          "DELETE FROM calyx_migration_0027_evidence WHERE receipt_path = ?",
        );
        const discardPathExpectations = db.prepare(
          "DELETE FROM calyx_migration_0027_expected WHERE receipt_path = ?",
        );
        let afterReceiptPath: string | undefined;
        while (true) {
          const pathRow = db.prepare(
            `SELECT receipt_path
               FROM calyx_migration_0027_expected
              ${afterReceiptPath === undefined ? "" : "WHERE receipt_path > ?"}
              GROUP BY receipt_path
              ORDER BY receipt_path
              LIMIT 1`,
          ).get(...(afterReceiptPath === undefined ? [] : [afterReceiptPath])) as
            | { receipt_path: string }
            | undefined;
          if (!pathRow) break;
          const receiptPath = pathRow.receipt_path;
          afterReceiptPath = receiptPath;
          const scan = scanMessageReceiptFileEvidence(receiptPath, (messageId, envelope) => {
            retainEvidence.run(
              receiptPath,
              messageId,
              JSON.stringify(envelope),
              receiptPath,
              messageId,
            );
          });
          let afterExpectedMessageId: string | undefined;
          while (true) {
            const expectedRows = db.prepare(
              `SELECT expected.message_id, expected.snapshot_json,
                      evidence.first_envelope_json, evidence.candidate_count
                 FROM calyx_migration_0027_expected AS expected
                 LEFT JOIN calyx_migration_0027_evidence AS evidence
                   ON evidence.receipt_path = expected.receipt_path
                  AND evidence.message_id = expected.message_id
                WHERE expected.receipt_path = ?
                  ${afterExpectedMessageId === undefined ? "" : "AND expected.message_id > ?"}
                ORDER BY expected.message_id
                LIMIT ?`,
            ).all(...(
              afterExpectedMessageId === undefined
                ? [receiptPath, pageSize]
                : [receiptPath, afterExpectedMessageId, pageSize]
            )) as Array<{
              message_id: string;
              snapshot_json: string;
              first_envelope_json: string | null;
              candidate_count: number | bigint | null;
            }>;
            if (expectedRows.length === 0) break;
            for (const expected of expectedRows) {
              afterExpectedMessageId = expected.message_id;
              const candidate = expected.first_envelope_json === null
                ? undefined
                : {
                    first_envelope: JSON.parse(expected.first_envelope_json) as unknown,
                    count: Number(expected.candidate_count) === 1 ? 1 as const : 2 as const,
                  };
              const evidenceError = messageReceiptFileEvidenceError({
                receipt_path: receiptPath,
                envelopes_by_message_id: candidate === undefined
                  ? new Map()
                  : new Map([[expected.message_id, candidate]]),
                ...(scan.read_error ? { read_error: scan.read_error } : {}),
                ...(scan.malformed_evidence ? { malformed_evidence: scan.malformed_evidence } : {}),
              }, JSON.parse(expected.snapshot_json) as unknown, expected.message_id);
              if (evidenceError) {
                throw new Error(
                  `migration 0027 cannot preserve completed receipt mirror ${expected.message_id}: ${evidenceError}`,
                );
              }
            }
            if (expectedRows.length < pageSize) break;
          }
          discardPathEvidence.run(receiptPath);
          discardPathExpectations.run(receiptPath);
        }
      } finally {
        db.exec(`
          DROP TABLE IF EXISTS temp.calyx_migration_0027_evidence;
          DROP TABLE IF EXISTS temp.calyx_migration_0027_expected;
        `);
      }

      db.exec(`
        ALTER TABLE message_receipt_mirrors
          RENAME TO message_receipt_mirrors_legacy_0027;

        CREATE TABLE message_receipt_mirrors (
          message_id TEXT NOT NULL PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
          receipt_snapshot_json TEXT NOT NULL CHECK (json_valid(receipt_snapshot_json)),
          status TEXT NOT NULL
            CONSTRAINT receipt_mirror_status CHECK (status IN ('pending', 'completed')),
          attempt_count INTEGER NOT NULL DEFAULT 0
            CONSTRAINT receipt_mirror_attempt_count
            CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
          next_attempt_at TEXT,
          last_attempt_at TEXT,
          completed_at TEXT,
          receipt_path TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CONSTRAINT receipt_mirror_control_state CHECK (${MESSAGE_RECEIPT_MIRROR_CONTROL_CHECK_SQL})
        );

        INSERT INTO message_receipt_mirrors (
          message_id, receipt_snapshot_json, status, attempt_count,
          next_attempt_at, last_attempt_at, completed_at, receipt_path,
          last_error_code, last_error_message, created_at, updated_at
        )
        SELECT
          message_id, receipt_snapshot_json, status, attempt_count,
          next_attempt_at, last_attempt_at, completed_at, receipt_path,
          last_error_code, last_error_message, created_at, updated_at
        FROM message_receipt_mirrors_legacy_0027;

        DROP TABLE message_receipt_mirrors_legacy_0027;

        CREATE INDEX idx_message_receipt_mirrors_pending
          ON message_receipt_mirrors(status, next_attempt_at, created_at);
      `);
    },
  },
  {
    id: "0028",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "consumer message idempotency: topology-independent wire recovery and versioned semantic identity (POL-1980)",
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(api_idempotency)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has("wire_request_hash")) {
        db.exec("ALTER TABLE api_idempotency ADD COLUMN wire_request_hash TEXT");
      }
      if (!columns.has("semantic_canonicalizer")) {
        db.exec("ALTER TABLE api_idempotency ADD COLUMN semantic_canonicalizer TEXT");
      }
      db.prepare(
        `UPDATE api_idempotency
            SET semantic_canonicalizer = 'calyx.msg-send-semantic/v1'
          WHERE operation_id = 'msg.send'
            AND canonicalizer = 'jcs-rfc8785/v1'
            AND schema_major = 1
            AND semantic_canonicalizer IS NULL`,
      ).run();
    },
  },
  {
    id: "0029",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "lease resource quarantine: journal typed before/after transitions with request provenance (POL-1980)",
    up: (db) => {
      db.exec(`
        ALTER TABLE lease_events RENAME TO lease_events_legacy_0029;

        CREATE TABLE lease_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL,
          event_type TEXT NOT NULL CHECK (event_type IN ('acquired', 'renewed', 'quarantined', 'released', 'stolen')),
          occurred_at TEXT NOT NULL,
          reason TEXT,
          before_lease_json TEXT CHECK (before_lease_json IS NULL OR json_valid(before_lease_json)),
          after_lease_json TEXT CHECK (after_lease_json IS NULL OR json_valid(after_lease_json)),
          request_provenance_json TEXT
            CHECK (request_provenance_json IS NULL OR json_valid(request_provenance_json)),
          CHECK (
            (event_type = 'acquired' AND after_lease_json IS NOT NULL)
            OR (event_type IN ('renewed', 'quarantined', 'stolen') AND before_lease_json IS NOT NULL AND after_lease_json IS NOT NULL)
            OR (event_type = 'released' AND before_lease_json IS NOT NULL AND after_lease_json IS NULL)
          )
        );

        INSERT INTO lease_events (
          event_id, key, event_type, occurred_at, reason,
          before_lease_json, after_lease_json, request_provenance_json
        )
        SELECT
          event_id, key, event_type, occurred_at, reason,
          before_lease_json, after_lease_json, request_provenance_json
        FROM lease_events_legacy_0029;

        DROP TABLE lease_events_legacy_0029;
        CREATE INDEX idx_lease_events_key_event ON lease_events(key, event_id);
        CREATE INDEX idx_lease_events_request
          ON lease_events(json_extract(request_provenance_json, '$.request_id'));
      `);
    },
  },
  {
    id: "0030",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "bounded run-index membership delta authority for linear seek pagination",
    up: (db) => {
      db.exec(`
        CREATE TABLE run_index_membership_revision (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          generation TEXT NOT NULL
            CHECK (length(generation) = 32 AND generation NOT GLOB '*[^0-9a-f]*'),
          revision INTEGER NOT NULL DEFAULT 0
            CHECK (typeof(revision) = 'integer' AND revision >= 0 AND revision <= 9007199254740991),
          lineage_parent_token TEXT NOT NULL
            CHECK (length(lineage_parent_token) = 32 AND lineage_parent_token NOT GLOB '*[^0-9a-f]*'),
          lineage_token TEXT NOT NULL
            CHECK (length(lineage_token) = 32 AND lineage_token NOT GLOB '*[^0-9a-f]*'),
          compacted_through_revision INTEGER NOT NULL DEFAULT 0
            CHECK (
              typeof(compacted_through_revision) = 'integer'
              AND compacted_through_revision >= 0
              AND compacted_through_revision <= revision
            ),
          CHECK (
            (revision = 0 AND lineage_parent_token = lineage_token)
            OR (revision > 0 AND lineage_parent_token <> lineage_token)
          )
        );

        INSERT INTO run_index_membership_revision (
          singleton, generation, revision, lineage_parent_token, lineage_token,
          compacted_through_revision
        )
        SELECT 1, lower(hex(randomblob(16))), 0, root_token, root_token, 0
          FROM (SELECT lower(hex(randomblob(16))) AS root_token);

        CREATE TABLE run_index_membership_deltas (
          revision INTEGER PRIMARY KEY,
          operation TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
          lineage_parent_token TEXT NOT NULL
            CHECK (length(lineage_parent_token) = 32 AND lineage_parent_token NOT GLOB '*[^0-9a-f]*'),
          lineage_token TEXT NOT NULL UNIQUE
            CHECK (
              length(lineage_token) = 32
              AND lineage_token NOT GLOB '*[^0-9a-f]*'
              AND lineage_parent_token <> lineage_token
            ),
          old_run_id TEXT,
          old_created_at TEXT,
          old_updated_at TEXT,
          old_host TEXT,
          old_backend TEXT,
          new_run_id TEXT,
          new_created_at TEXT,
          new_updated_at TEXT,
          new_host TEXT,
          new_backend TEXT,
          CHECK (
            (operation = 'insert'
              AND old_run_id IS NULL AND old_created_at IS NULL AND old_updated_at IS NULL
              AND new_run_id IS NOT NULL AND new_created_at IS NOT NULL AND new_updated_at IS NOT NULL)
            OR (operation = 'delete'
              AND old_run_id IS NOT NULL AND old_created_at IS NOT NULL AND old_updated_at IS NOT NULL
              AND new_run_id IS NULL AND new_created_at IS NULL AND new_updated_at IS NULL)
            OR (operation = 'update'
              AND old_run_id IS NOT NULL AND old_created_at IS NOT NULL AND old_updated_at IS NOT NULL
              AND new_run_id IS NOT NULL AND new_created_at IS NOT NULL AND new_updated_at IS NOT NULL)
          )
        );

        CREATE INDEX idx_run_index_created_seek
          ON run_index(created_at DESC, run_id COLLATE BINARY ASC);
      `);
      for (const trigger of RUN_INDEX_MEMBERSHIP_REVISION_TRIGGERS) {
        db.exec(trigger.sql);
      }
    },
  },
  {
    id: "0031",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "run index semantic progress and terminal projection fields (POL-2004)",
    up: (db) => {
      db.exec(`
        ALTER TABLE run_index ADD COLUMN progress_signal_json TEXT;
        ALTER TABLE run_index ADD COLUMN terminal_projection_json TEXT;
      `);
    },
  },
  {
    id: "0032",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "exact activity session-ingress leases and idempotent pointer delivery (POL-2005)",
    up: (db) => {
      db.exec(`
        CREATE TABLE session_ingress_launches (
          launch_id TEXT PRIMARY KEY,
          nonce_hash TEXT NOT NULL UNIQUE
            CHECK (length(nonce_hash) = 64 AND nonce_hash NOT GLOB '*[^0-9a-f]*'),
          generation TEXT NOT NULL UNIQUE,
          backend TEXT NOT NULL CHECK (backend IN ('codex', 'claude')),
          destination_host TEXT NOT NULL,
          adapter TEXT NOT NULL CHECK (adapter IN ('unix_socket')),
          endpoint_ref TEXT NOT NULL UNIQUE,
          capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          CHECK (expires_at > created_at),
          CHECK (consumed_at IS NULL OR consumed_at >= created_at)
        );

        CREATE INDEX idx_session_ingress_launches_expiry
          ON session_ingress_launches(expires_at, consumed_at);

        CREATE TABLE session_ingress_bindings (
          binding_id TEXT PRIMARY KEY,
          schema_version TEXT NOT NULL,
          activity_id TEXT NOT NULL,
          backend TEXT NOT NULL CHECK (backend IN ('codex', 'claude')),
          destination_host TEXT NOT NULL,
          harness_session_id TEXT NOT NULL,
          generation TEXT NOT NULL UNIQUE,
          launch_id TEXT NOT NULL UNIQUE
            REFERENCES session_ingress_launches(launch_id),
          adapter TEXT NOT NULL CHECK (adapter IN ('unix_socket')),
          endpoint_ref TEXT NOT NULL,
          capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
          registered_at TEXT NOT NULL,
          renewed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          retired_at TEXT,
          CHECK (expires_at > renewed_at),
          CHECK (renewed_at >= registered_at),
          CHECK (retired_at IS NULL OR retired_at >= registered_at)
        );

        CREATE UNIQUE INDEX idx_session_ingress_bindings_active_activity
          ON session_ingress_bindings(activity_id) WHERE retired_at IS NULL;
        CREATE INDEX idx_session_ingress_bindings_expiry
          ON session_ingress_bindings(expires_at, retired_at);
        CREATE INDEX idx_session_ingress_bindings_destination
          ON session_ingress_bindings(destination_host, retired_at);

        CREATE TABLE session_wake_deliveries (
          delivery_id TEXT PRIMARY KEY,
          schema_version TEXT NOT NULL,
          pointer_kind TEXT NOT NULL CHECK (pointer_kind IN ('message', 'monitor_wake')),
          pointer_id TEXT NOT NULL,
          activity_id TEXT NOT NULL,
          binding_id TEXT REFERENCES session_ingress_bindings(binding_id),
          binding_generation TEXT,
          adapter TEXT,
          status TEXT NOT NULL CHECK (status IN ('attempted', 'delivered', 'failed')),
          attempted_at TEXT NOT NULL,
          delivered_at TEXT,
          failed_at TEXT,
          updated_at TEXT NOT NULL,
          target_json TEXT NOT NULL CHECK (json_valid(target_json)),
          evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
          error_code TEXT,
          error_message TEXT,
          UNIQUE(pointer_kind, pointer_id, activity_id),
          CHECK (
            (binding_id IS NULL AND binding_generation IS NULL AND adapter IS NULL)
            OR (binding_id IS NOT NULL AND binding_generation IS NOT NULL AND adapter IS NOT NULL)
          ),
          CHECK (
            (status = 'attempted' AND delivered_at IS NULL AND failed_at IS NULL AND error_code IS NULL)
            OR (status = 'delivered' AND delivered_at IS NOT NULL AND failed_at IS NULL AND error_code IS NULL)
            OR (status = 'failed' AND delivered_at IS NULL AND failed_at IS NOT NULL AND error_code IS NOT NULL)
          )
        );

        CREATE INDEX idx_session_wake_deliveries_pointer
          ON session_wake_deliveries(pointer_kind, pointer_id);
        CREATE INDEX idx_session_wake_deliveries_activity
          ON session_wake_deliveries(activity_id, attempted_at);
        CREATE INDEX idx_session_wake_deliveries_status
          ON session_wake_deliveries(status, attempted_at);
      `);
    },
  },
  {
    id: "0033",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "owner-scoped recoverable monitor wake claims (POL-2005)",
    up: (db) => {
      db.exec(`
        ALTER TABLE monitor_wakes ADD COLUMN claimed_until TEXT;
        ALTER TABLE monitor_wakes ADD COLUMN claimed_by TEXT;

        CREATE INDEX idx_monitor_wakes_claimed_until
          ON monitor_wakes(claimed_until);
        CREATE INDEX idx_monitor_wakes_claimant
          ON monitor_wakes(claimed_by, status, created_at);
      `);
    },
  },
  {
    id: "0034",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "independent review coordinator: caller-owned request, attempt, effect, observation, evidence, obligation, and event state (POL-1983)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS review_instances (
          instance_id TEXT PRIMARY KEY,
          schema_version TEXT NOT NULL,
          admission_key TEXT NOT NULL,
          subject TEXT NOT NULL,
          asserted_actor TEXT NOT NULL,
          policy_version TEXT NOT NULL,
          request_json TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          repository TEXT NOT NULL,
          pull_request INTEGER NOT NULL,
          target_sha TEXT NOT NULL,
          round INTEGER NOT NULL,
          calyx_build_sha TEXT NOT NULL,
          reviewer_definition_digest TEXT NOT NULL,
          state TEXT NOT NULL,
          state_version INTEGER NOT NULL DEFAULT 0,
          claim_owner TEXT,
          claim_until TEXT,
          claim_fence INTEGER NOT NULL DEFAULT 0,
          intrinsic_status TEXT NOT NULL,
          publication_status TEXT NOT NULL,
          disposition TEXT NOT NULL,
          next_event_seq INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          terminal_at TEXT,
          UNIQUE(subject, admission_key),
          CHECK (schema_version = 'calyx.independent-review-request/v1'),
          CHECK (pull_request > 0),
          CHECK (round > 0),
          CHECK (state_version >= 0),
          CHECK (claim_fence >= 0),
          CHECK (next_event_seq > 0),
          CHECK (length(request_hash) = 64),
          CHECK (state IN ('reviewer_launch_pending', 'reviewing', 'awaiting_evidence',
                           'awaiting_publication', 'launch_indeterminate', 'terminal')),
          CHECK (intrinsic_status IN ('pending', 'passed', 'not_passed', 'invalid')),
          CHECK (publication_status IN ('not_started', 'pending', 'delivered',
                                        'degraded', 'indeterminate')),
          CHECK (disposition IN ('pending', 'active', 'awaiting_publication',
                                 'ready', 'blocked', 'failed')),
          CHECK ((claim_owner IS NULL AND claim_until IS NULL)
                 OR (claim_owner IS NOT NULL AND claim_until IS NOT NULL))
        );

        CREATE INDEX IF NOT EXISTS idx_review_instances_target
          ON review_instances(repository, pull_request, target_sha);
        CREATE INDEX IF NOT EXISTS idx_review_instances_disposition
          ON review_instances(disposition, updated_at);
        CREATE INDEX IF NOT EXISTS idx_review_instances_claim
          ON review_instances(claim_until);

        CREATE TABLE IF NOT EXISTS review_attempts (
          attempt_id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL REFERENCES review_instances(instance_id) ON DELETE CASCADE,
          attempt_number INTEGER NOT NULL,
          reviewer_run_id TEXT NOT NULL,
          launch_id TEXT NOT NULL,
          launch_request_json TEXT NOT NULL,
          launch_intent_hash TEXT NOT NULL,
          producer_generation INTEGER NOT NULL,
          producer_fence INTEGER NOT NULL,
          status TEXT NOT NULL,
          run_state TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(instance_id, attempt_number),
          UNIQUE(instance_id, attempt_id),
          UNIQUE(launch_id),
          UNIQUE(reviewer_run_id),
          CHECK (attempt_number > 0),
          CHECK (producer_generation > 0),
          CHECK (producer_fence > 0),
          CHECK (length(launch_intent_hash) = 64),
          CHECK (status IN ('planned', 'running', 'succeeded', 'failed', 'cancelled',
                            'launch_indeterminate')),
          CHECK (run_state IS NULL OR run_state IN ('queued', 'dispatching', 'running',
                 'succeeded', 'failed', 'partial', 'cancelled', 'auth_error',
                 'infra_error', 'completed_dirty'))
        );

        CREATE INDEX IF NOT EXISTS idx_review_attempts_instance
          ON review_attempts(instance_id, attempt_number);
        CREATE INDEX IF NOT EXISTS idx_review_attempts_run
          ON review_attempts(reviewer_run_id);

        CREATE TABLE IF NOT EXISTS review_effects (
          effect_id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL REFERENCES review_instances(instance_id) ON DELETE CASCADE,
          attempt_id TEXT,
          kind TEXT NOT NULL,
          effect_key TEXT NOT NULL,
          request_json TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          claimed_fence INTEGER,
          adoption_json TEXT,
          adoption_hash TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(instance_id, kind, effect_key),
          UNIQUE(instance_id, effect_id),
          FOREIGN KEY (instance_id, attempt_id)
            REFERENCES review_attempts(instance_id, attempt_id) ON DELETE CASCADE,
          CHECK (claimed_fence IS NULL OR claimed_fence > 0),
          CHECK (length(request_hash) = 64),
          CHECK (kind IN ('reviewer_launch', 'provider_publication')),
          CHECK (status IN ('pending', 'claimed', 'succeeded', 'failed', 'indeterminate')),
          CHECK ((adoption_json IS NULL AND adoption_hash IS NULL)
                 OR (adoption_json IS NOT NULL AND adoption_hash IS NOT NULL))
        );

        CREATE INDEX IF NOT EXISTS idx_review_effects_ready
          ON review_effects(instance_id, status, kind, effect_key);

        CREATE TABLE IF NOT EXISTS review_effect_observations (
          observation_id TEXT NOT NULL,
          instance_id TEXT NOT NULL REFERENCES review_instances(instance_id) ON DELETE CASCADE,
          effect_id TEXT NOT NULL,
          effect_key TEXT NOT NULL,
          observation_seq INTEGER NOT NULL,
          schema_version TEXT NOT NULL,
          status TEXT NOT NULL,
          receipt_digest TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          PRIMARY KEY(effect_id, observation_id),
          UNIQUE(effect_id, observation_seq),
          FOREIGN KEY (instance_id, effect_id)
            REFERENCES review_effects(instance_id, effect_id) ON DELETE CASCADE,
          CHECK (observation_seq > 0),
          CHECK (
            (schema_version = 'calyx.review-provider-observation/v1'
             AND status IN ('delivered', 'degraded', 'indeterminate'))
            OR
            (schema_version = 'calyx.review-launch-reconciliation-observation/v1'
             AND status IN ('adopted', 'failed', 'indeterminate'))
          ),
          CHECK (length(receipt_digest) = 64),
          CHECK (length(payload_hash) = 64)
        );

        CREATE INDEX IF NOT EXISTS idx_review_effect_observations_effect
          ON review_effect_observations(effect_id, observation_seq);

        CREATE TABLE IF NOT EXISTS review_evidence (
          evidence_id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL REFERENCES review_instances(instance_id) ON DELETE CASCADE,
          attempt_id TEXT NOT NULL,
          schema_version TEXT NOT NULL,
          receipt_json TEXT NOT NULL,
          receipt_hash TEXT NOT NULL,
          artifact_json TEXT NOT NULL,
          artifact_digest TEXT NOT NULL,
          intrinsic_status TEXT NOT NULL,
          verdict TEXT,
          coverage_status TEXT NOT NULL,
          finding_count INTEGER NOT NULL,
          invalid_reasons_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          UNIQUE(instance_id, attempt_id),
          FOREIGN KEY (instance_id, attempt_id)
            REFERENCES review_attempts(instance_id, attempt_id) ON DELETE CASCADE,
          CHECK (finding_count >= 0),
          CHECK (length(receipt_hash) = 64),
          CHECK (length(artifact_digest) = 64),
          CHECK (intrinsic_status IN ('passed', 'not_passed', 'invalid')),
          CHECK (verdict IS NULL OR verdict IN ('mergeable', 'not_mergeable'))
        );

        CREATE INDEX IF NOT EXISTS idx_review_evidence_instance
          ON review_evidence(instance_id, created_at);

        CREATE TABLE IF NOT EXISTS review_obligations (
          obligation_id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL REFERENCES review_instances(instance_id) ON DELETE CASCADE,
          effect_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          obligation_key TEXT NOT NULL,
          status TEXT NOT NULL,
          detail_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(instance_id, kind, obligation_key),
          FOREIGN KEY (instance_id, effect_id)
            REFERENCES review_effects(instance_id, effect_id) ON DELETE CASCADE,
          CHECK (status IN ('pending', 'resolved'))
        );

        CREATE INDEX IF NOT EXISTS idx_review_obligations_open
          ON review_obligations(status, updated_at);

        CREATE TABLE IF NOT EXISTS review_events (
          event_id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL REFERENCES review_instances(instance_id) ON DELETE CASCADE,
          event_seq INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          UNIQUE(instance_id, event_seq),
          CHECK (event_seq > 0),
          CHECK (length(payload_hash) = 64)
        );

        CREATE INDEX IF NOT EXISTS idx_review_events_instance
          ON review_events(instance_id, event_seq);
      `);
    },
  },
  {
    id: "0035",
    growthBound: STATE_MIGRATION_STANDARD_GROWTH_BOUND,
    description:
      "authoritative activity-mark membership and immutable history (POL-1996)",
    up: (db) => {
      db.exec(`
        ${ACTIVITY_MARKS_MEMBERSHIP_CREATE_SQL};

        INSERT INTO activity_marks_membership (
          singleton, generation, revision, root_lineage_token, lineage_token, updated_at
        )
        SELECT 1, lower(hex(randomblob(16))), 0, root_token, root_token,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          FROM (SELECT lower(hex(randomblob(16))) AS root_token);

        ${ACTIVITY_MARKS_CREATE_SQL};

        CREATE UNIQUE INDEX idx_activity_marks_active_natural_key
          ON activity_marks(subject, target_kind, target_id, kind)
          WHERE revoked_at IS NULL;
        CREATE INDEX idx_activity_marks_seek
          ON activity_marks(marked_at DESC, mark_id ASC);
        CREATE INDEX idx_activity_marks_active_target
          ON activity_marks(target_kind, target_id, marked_at DESC, mark_id ASC)
          WHERE revoked_at IS NULL;
        CREATE UNIQUE INDEX idx_activity_marks_revoked_revision
          ON activity_marks(revoked_revision)
          WHERE revoked_revision IS NOT NULL;
      `);
    },
  },
];

/**
 * Schema parity reference for the orchestration ledger introduced in
 * migration 0002. The doctor uses this to verify the live database schema
 * matches expectations after `migrate --apply`.
 */
export interface ExpectedTableSchema {
  table: string;
  columns: readonly string[];
  /** Exact canonical CREATE TABLE authority when additive/relaxed drift is unsafe. */
  createSql?: string;
  indexes?: readonly string[];
  triggers?: readonly { name: string; sql: string }[];
  requiredSqlFragments?: readonly string[];
}

/**
 * Authoritative activity-mark state. Deliberately separate from
 * `ACTIVITY_INDEX_TABLES`: marks survive projection rebuild and transcript
 * cleanup, and therefore carry no foreign key into the activity index.
 */
export const ACTIVITY_MARKS_TABLES: readonly ExpectedTableSchema[] = [
  {
    table: "activity_marks_membership",
    createSql: ACTIVITY_MARKS_MEMBERSHIP_CREATE_SQL,
    columns: [
      "singleton",
      "generation",
      "revision",
      "root_lineage_token",
      "lineage_token",
      "updated_at",
    ],
    requiredSqlFragments: [
      "singleton INTEGER PRIMARY KEY CHECK (singleton = 1)",
      "length(generation) = 32",
      "revision <= 9007199254740991",
      "length(root_lineage_token) = 32",
      "length(lineage_token) = 32",
      "revision <> 0 OR lineage_token = root_lineage_token",
    ],
  },
  {
    table: "activity_marks",
    createSql: ACTIVITY_MARKS_CREATE_SQL,
    columns: [
      "mark_id",
      "subject",
      "target_kind",
      "target_id",
      "kind",
      "reason",
      "marked_at",
      "created_provenance_json",
      "marked_revision",
      "marked_lineage_token",
      "revoked_at",
      "revoked_provenance_json",
      "revoked_revision",
      "revoked_lineage_token",
    ],
    indexes: [
      "idx_activity_marks_active_natural_key",
      "idx_activity_marks_seek",
      "idx_activity_marks_active_target",
      "idx_activity_marks_revoked_revision",
    ],
    requiredSqlFragments: [
      "target_kind IN ('activity', 'turn', 'message')",
      "kind IN ('high_signal', 'foundational')",
      "length(target_id) BETWEEN 1 AND 1024",
      "length(reason) BETWEEN 1 AND 2000",
      "marked_revision INTEGER NOT NULL UNIQUE",
      "marked_revision > 0",
      "marked_lineage_token TEXT NOT NULL UNIQUE",
      "revoked_revision > marked_revision",
      "revoked_lineage_token TEXT UNIQUE",
      "revoked_at IS NULL AND revoked_provenance_json IS NULL",
      "revoked_at IS NOT NULL AND revoked_provenance_json IS NOT NULL",
    ],
  },
];

export const RUN_INDEX_TABLES: readonly ExpectedTableSchema[] = [
  {
    table: "run_index",
    columns: [
      "run_id",
      "state",
      "summary",
      "created_at",
      "updated_at",
      "completed_at",
      "health_status",
      "last_progress_at",
      "issue",
      "host",
      "backend",
      "progress_signal_json",
      "terminal_projection_json",
      "recovery_mode",
      "run_dir",
    ],
    indexes: [
      "idx_run_index_state",
      "idx_run_index_updated_at",
      "idx_run_index_issue",
      "idx_run_index_host",
      "idx_run_index_created_seek",
    ],
    triggers: RUN_INDEX_MEMBERSHIP_REVISION_TRIGGERS,
  },
  {
    table: "run_index_membership_revision",
    columns: [
      "singleton", "generation", "revision", "lineage_parent_token",
      "lineage_token", "compacted_through_revision",
    ],
    requiredSqlFragments: [
      "generation TEXT NOT NULL",
      "length(generation) = 32",
      "revision <= 9007199254740991",
      "lineage_parent_token TEXT NOT NULL",
      "length(lineage_parent_token) = 32",
      "lineage_token TEXT NOT NULL",
      "length(lineage_token) = 32",
      "revision = 0 AND lineage_parent_token = lineage_token",
      "revision > 0 AND lineage_parent_token <> lineage_token",
      "compacted_through_revision <= revision",
    ],
  },
  {
    table: "run_index_membership_deltas",
    columns: [
      "revision", "operation", "lineage_parent_token", "lineage_token",
      "old_run_id", "old_created_at", "old_updated_at", "old_host", "old_backend",
      "new_run_id", "new_created_at", "new_updated_at", "new_host", "new_backend",
    ],
    requiredSqlFragments: [
      "operation IN ('insert', 'update', 'delete')",
      "lineage_parent_token TEXT NOT NULL",
      "lineage_token TEXT NOT NULL UNIQUE",
      "lineage_parent_token <> lineage_token",
      "operation = 'insert'",
      "operation = 'delete'",
      "operation = 'update'",
    ],
  },
];

export const ACTIVITY_INDEX_TABLES: readonly ExpectedTableSchema[] = [
  {
    table: "activity_messages",
    columns: [
      "message_id",
      "activity_id",
      "turn_id",
      "seq",
      "origin",
      "text",
      "token_count",
      "host",
      "backend",
      "source_path",
      "source_offset",
      "content_hash",
      "classifier_version",
      "attachment_refs",
      "observed_at",
      "timestamp",
      "payload_json",
    ],
    indexes: [
      "idx_activity_messages_activity",
      "idx_activity_messages_source",
      "idx_activity_messages_turn",
      "idx_activity_messages_content_hash",
      "idx_activity_messages_timestamp",
    ],
  },
  {
    table: "activity_attachments",
    columns: [
      "attachment_id",
      "message_id",
      "origin",
      "sha256",
      "mime",
      "byte_size",
      "observed_at",
    ],
    indexes: [
      "idx_activity_attachments_message",
      "idx_activity_attachments_sha256",
      "idx_activity_attachments_origin",
    ],
  },
  {
    table: "activity_source_cursors",
    columns: [
      "source_path",
      "backend",
      "activity_id",
      "byte_offset",
      "next_line",
      "resume_offset",
      "resume_line",
      "size_bytes",
      "mtime_ms",
      "content_hash",
      "classifier_version",
      "message_count",
      "updated_at",
      "last_indexed_at",
    ],
    indexes: [
      "idx_activity_source_cursors_activity",
      "idx_activity_source_cursors_backend",
      "idx_activity_source_cursors_updated_at",
    ],
  },
  {
    table: "activity_index_runs",
    columns: [
      "run_id",
      "host",
      "trigger",
      "started_at",
      "finished_at",
      "status",
      "sources_scanned",
      "sources_changed",
      "sources_pending",
      "messages_upserted",
      "bytes_ingested",
      "indexed_through",
      "classifier_version",
      "error",
    ],
    indexes: [
      "idx_activity_index_runs_started_at",
      "idx_activity_index_runs_status",
    ],
  },
];

export const SKILL_PROPOSAL_TABLES: readonly ExpectedTableSchema[] = [
  {
    table: "skill_proposals",
    columns: [
      "proposal_id",
      "skill_id",
      "kind",
      "status",
      "target",
      "source_root",
      "target_source_path",
      "relative_source_file",
      "origin_activity_id",
      "origin_message_id",
      "summary",
      "author",
      "created_at",
      "updated_at",
      "validated_at",
      "materialized_at",
      "accepted_at",
      "rejected_at",
      "superseded_at",
      "payload_json",
    ],
    indexes: [
      "idx_skill_proposals_status",
      "idx_skill_proposals_skill_id",
      "idx_skill_proposals_created_at",
    ],
  },
  {
    table: "skill_proposal_events",
    columns: [
      "event_seq",
      "proposal_id",
      "occurred_at",
      "event_type",
      "status_before",
      "status_after",
      "actor",
      "note",
      "payload_json",
    ],
    indexes: [
      "idx_skill_proposal_events_proposal_id",
      "idx_skill_proposal_events_occurred_at",
    ],
  },
];

export const SKILL_CONTENT_TABLES: readonly ExpectedTableSchema[] = [
  {
    table: "skill_content",
    columns: [
      "host_id",
      "skill_name",
      "content_hash",
      "regime",
      "payload_json",
      "deleted_at",
      "origin_activity_id",
      "origin_message_id",
      "author",
      "summary",
      "created_at",
      "updated_at",
      "materialized_at",
      "pinned",
    ],
    indexes: [
      "idx_skill_content_regime",
      "idx_skill_content_updated_at",
      "idx_skill_content_pinned",
    ],
  },
  {
    table: "skill_write_log",
    columns: [
      "event_seq",
      "skill_name",
      "host_id",
      "regime",
      "write_class",
      "content_hash",
      "origin_activity_id",
      "origin_message_id",
      "actor",
      "note",
      "occurred_at",
    ],
    indexes: [
      "idx_skill_write_log_skill",
      "idx_skill_write_log_occurred_at",
    ],
  },
];

export const MEMORY_CONTENT_TABLES: readonly ExpectedTableSchema[] = [
  {
    table: "memory_content",
    columns: [
      "host_id",
      "memory_key",
      "value",
      "content_hash",
      "category",
      "review_status",
      "pinned",
      "deleted_at",
      "origin_activity_id",
      "origin_message_id",
      "author",
      "summary",
      "created_at",
      "updated_at",
      "approved_at",
    ],
    indexes: [
      "idx_memory_content_review_status",
      "idx_memory_content_category",
    ],
  },
  {
    table: "memory_write_log",
    columns: [
      "event_seq",
      "memory_key",
      "host_id",
      "write_class",
      "content_hash",
      "review_status",
      "origin_activity_id",
      "origin_message_id",
      "actor",
      "note",
      "occurred_at",
    ],
    indexes: [
      "idx_memory_write_log_memory",
      "idx_memory_write_log_occurred_at",
    ],
  },
];

export const ORCHESTRATION_LEDGER_TABLES: readonly ExpectedTableSchema[] = [
  {
    table: "event_log",
    columns: [
      "event_id",
      "domain",
      "aggregate_type",
      "aggregate_id",
      "event_type",
      "cursor",
      "occurred_at",
      "recorded_at",
      "host",
      "agent_id",
      "source",
      "payload_json",
    ],
    indexes: [
      "idx_event_log_aggregate",
      "idx_event_log_domain_cursor",
      "idx_event_log_occurred_at",
    ],
  },
  {
    table: "event_cursors",
    columns: ["source", "domain", "cursor", "observed_at", "payload_json"],
  },
  {
    table: "locks",
    columns: [
      "lock_key",
      "owner_id",
      "acquired_at",
      "expires_at",
      "metadata_json",
    ],
    indexes: ["idx_locks_expires_at"],
  },
  {
    table: "source_freshness",
    columns: [
      "source_kind",
      "source_id",
      "observed_at",
      "status",
      "stale_after_ms",
      "cursor",
      "detail",
      "payload_json",
    ],
    indexes: [
      "idx_source_freshness_status",
      "idx_source_freshness_observed_at",
    ],
  },
];

export const FLEET_CONVERGENCE_TABLES: readonly ExpectedTableSchema[] = [
  {
    table: "fleet_convergence",
    columns: [
      "host",
      "leg",
      "target_rev",
      "observed_rev",
      "converged_from",
      "policy",
      "last_checked_at",
      "verdict",
      "receipt_path",
      "receipt_id",
      "detail",
      "payload_json",
    ],
    indexes: [
      "idx_fleet_convergence_verdict",
      "idx_fleet_convergence_last_checked_at",
      "idx_fleet_convergence_leg",
    ],
  },
];

export const MONITOR_TABLES: readonly ExpectedTableSchema[] = [
  {
    table: "monitors",
    columns: [
      "monitor_id",
      "schema_version",
      "status",
      "created_at",
      "created_provenance_json",
      "updated_at",
      "owner",
      "created_by",
      "create_provenance",
      "assigned_host",
      "source_run_id",
      "preset",
      "predicate_json",
      "rearm_policy",
      "delivery_json",
      "last_evaluated_at",
      "last_match",
      "last_transition_hash",
      "last_wake_id",
      "last_error",
    ],
    indexes: [
      "idx_monitors_status",
      "idx_monitors_assigned_host",
      "idx_monitors_source_run_id",
    ],
  },
  {
    table: "monitor_cursors",
    columns: ["monitor_id", "cursor_json", "updated_at"],
  },
  {
    table: "monitor_history",
    columns: [
      "history_id",
      "monitor_id",
      "occurred_at",
      "event_type",
      "transition_hash",
      "matched",
      "wake_id",
      "evidence_json",
      "detail",
      "provenance_json",
    ],
    indexes: [
      "idx_monitor_history_monitor_time",
      "idx_monitor_history_event_type",
    ],
  },
  {
    table: "monitor_wakes",
    columns: [
      "wake_id",
      "schema_version",
      "monitor_id",
      "transition_hash",
      "status",
      "created_at",
      "claimed_until",
      "claimed_by",
      "acked_at",
      "acked_by",
      "rearm_policy",
      "predicate_json",
      "evaluation_json",
      "delivery_json",
      "suggested_commands_json",
      "receipt_path",
    ],
    indexes: [
      "idx_monitor_wakes_status",
      "idx_monitor_wakes_created_at",
      "idx_monitor_wakes_monitor",
      "idx_monitor_wakes_claimed_until",
      "idx_monitor_wakes_claimant",
    ],
  },
  {
    table: "monitor_deliveries",
    columns: [
      "delivery_id",
      "wake_id",
      "monitor_id",
      "binding_id",
      "adapter",
      "status",
      "attempted_at",
      "delivered_at",
      "failed_at",
      "updated_at",
      "target_json",
      "evidence_json",
      "error_code",
      "error_message",
    ],
    indexes: [
      "idx_monitor_deliveries_wake",
      "idx_monitor_deliveries_monitor",
      "idx_monitor_deliveries_status",
      "idx_monitor_deliveries_binding",
    ],
  },
];

export const MESSAGE_TABLES: readonly ExpectedTableSchema[] = [
  {
    table: "messages",
    columns: [
      "message_id",
      "schema_version",
      "sender",
      "recipient_address",
      "recipient_class",
      "recipient_host",
      "subject",
      "body",
      "thread_key",
      "reply_to",
      "idempotency_key",
      "urgency",
      "ack_required",
      "expires_at",
      "status",
      "claimed_until",
      "claimed_by",
      "expired_claim_cycles",
      "dead_letter",
      "dead_letter_reason",
      "created_at",
      "updated_at",
      "spooled_at",
      "delivered_at",
      "acked_at",
      "acked_by",
      "receipt_path",
      "payload_json",
      "created_provenance_json",
      "ingress_provenance_json",
    ],
    indexes: [
      "idx_messages_recipient_status",
      "idx_messages_recipient_host",
      "idx_messages_thread",
      "idx_messages_reply_to",
      "idx_messages_status",
      "idx_messages_expires_at",
      "idx_messages_claimed_until",
      "idx_messages_sender_idempotency",
    ],
  },
  {
    table: "message_deliveries",
    columns: [
      "delivery_id",
      "message_id",
      "binding_id",
      "adapter",
      "status",
      "attempted_at",
      "delivered_at",
      "failed_at",
      "updated_at",
      "target_json",
      "evidence_json",
      "error_code",
      "error_message",
    ],
    indexes: [
      "idx_message_deliveries_message",
      "idx_message_deliveries_status",
      "idx_message_deliveries_binding",
    ],
  },
  {
    table: "outbox",
    columns: [
      "outbox_id",
      "schema_version",
      "message_id",
      "target_host",
      "target_url",
      "status",
      "attempt_count",
      "acceptance_ambiguous",
      "attempt_id",
      "attempt_expires_at",
      "next_attempt_at",
      "last_attempt_at",
      "forwarded_at",
      "expires_at",
      "created_at",
      "updated_at",
      "last_error_code",
      "last_error_message",
      "payload_json",
    ],
    indexes: [
      "idx_outbox_status_next_attempt",
      "idx_outbox_status_attempt_expires",
      "idx_outbox_target_host",
      "idx_outbox_expires_at",
    ],
  },
  {
    table: "api_idempotency",
    columns: [
      "subject",
      "operation_id",
      "idempotency_key",
      "asserted_actor",
      "first_request_id",
      "first_request_provenance_json",
      "wire_request_hash",
      "request_hash",
      "canonicalizer",
      "schema_major",
      "semantic_canonicalizer",
      "response_status",
      "response_json",
      "created_at",
    ],
    indexes: ["idx_api_idempotency_created_at"],
  },
  {
    table: "message_receipt_mirrors",
    columns: [
      "message_id",
      "receipt_snapshot_json",
      "status",
      "attempt_count",
      "next_attempt_at",
      "last_attempt_at",
      "completed_at",
      "receipt_path",
      "last_error_code",
      "last_error_message",
      "created_at",
      "updated_at",
    ],
    indexes: ["idx_message_receipt_mirrors_pending"],
  },
  {
    table: "session_ingress_launches",
    columns: [
      "launch_id",
      "nonce_hash",
      "generation",
      "backend",
      "destination_host",
      "adapter",
      "endpoint_ref",
      "capabilities_json",
      "created_at",
      "expires_at",
      "consumed_at",
    ],
    indexes: ["idx_session_ingress_launches_expiry"],
  },
  {
    table: "session_ingress_bindings",
    columns: [
      "binding_id",
      "schema_version",
      "activity_id",
      "backend",
      "destination_host",
      "harness_session_id",
      "generation",
      "launch_id",
      "adapter",
      "endpoint_ref",
      "capabilities_json",
      "registered_at",
      "renewed_at",
      "expires_at",
      "retired_at",
    ],
    indexes: [
      "idx_session_ingress_bindings_active_activity",
      "idx_session_ingress_bindings_expiry",
      "idx_session_ingress_bindings_destination",
    ],
  },
  {
    table: "session_wake_deliveries",
    columns: [
      "delivery_id",
      "schema_version",
      "pointer_kind",
      "pointer_id",
      "activity_id",
      "binding_id",
      "binding_generation",
      "adapter",
      "status",
      "attempted_at",
      "delivered_at",
      "failed_at",
      "updated_at",
      "target_json",
      "evidence_json",
      "error_code",
      "error_message",
    ],
    indexes: [
      "idx_session_wake_deliveries_pointer",
      "idx_session_wake_deliveries_activity",
      "idx_session_wake_deliveries_status",
    ],
  },
];

export const API_REQUEST_AUDIT_TABLES: readonly ExpectedTableSchema[] = [{
  table: "api_request_audit",
  columns: [
    "request_id",
    "server_instance_id",
    "operation_id",
    "subject",
    "asserted_actor",
    "served_by_host",
    "via",
    "admitted_at",
    "finalized_at",
    "response_status",
    "error_code",
    "outcome",
  ],
  indexes: [
    "idx_api_request_audit_admitted_at",
    "idx_api_request_audit_outcome_admitted_at",
    "idx_api_request_audit_operation_admitted_at",
  ],
}];

export const RUNNER_LIVE_BINDING_TABLES: readonly ExpectedTableSchema[] = [
  {
    table: "runner_live_bindings",
    columns: [
      "binding_id",
      "schema_version",
      "run_id",
      "adapter",
      "backend",
      "lifecycle_owner",
      "host",
      "status",
      "codex_home",
      "transport_kind",
      "endpoint_json",
      "thread_id",
      "active_turn_id",
      "active_turn_source",
      "active_turn_observed_at",
      "active_turn_status",
      "adapter_session_id",
      "connection_id",
      "auth_ref_json",
      "created_at",
      "updated_at",
      "closed_at",
      "last_error",
    ],
    indexes: [
      "idx_runner_live_bindings_run",
      "idx_runner_live_bindings_thread",
      "idx_runner_live_bindings_status",
      "idx_runner_live_bindings_adapter",
    ],
  },
];

export const TASK_TABLES: readonly ExpectedTableSchema[] = [
  {
    table: "task_installs",
    columns: [
      "install_id",
      "schema_version",
      "status",
      "created_at",
      "updated_at",
      "task_id",
      "host",
      "owner",
      "installed_by",
      "manifest_path",
      "manifest_hash",
      "task_json",
      "predicate_json",
      "launch_policy_json",
      "mode",
      "unattended_enabled",
      "app_mutation_enabled",
      "last_evaluated_at",
      "last_match",
      "last_transition_hash",
      "last_task_run_id",
      "last_run_id",
      "last_error",
    ],
    indexes: [
      "idx_task_installs_status",
      "idx_task_installs_task_id",
      "idx_task_installs_host",
    ],
  },
  {
    table: "task_install_cursors",
    columns: ["install_id", "cursor_json", "updated_at"],
  },
  {
    table: "task_runs",
    columns: [
      "task_run_id",
      "schema_version",
      "task_id",
      "install_id",
      "trigger_kind",
      "status",
      "created_at",
      "updated_at",
      "run_id",
      "mode",
      "dry_run",
      "launch_policy_json",
      "predicate_evaluation_json",
      "summary",
      "receipt_path",
    ],
    indexes: [
      "idx_task_runs_task_id",
      "idx_task_runs_install",
      "idx_task_runs_run_id",
      "idx_task_runs_status",
    ],
  },
  {
    table: "task_history",
    columns: [
      "history_id",
      "install_id",
      "task_id",
      "task_run_id",
      "occurred_at",
      "event_type",
      "detail",
      "payload_json",
    ],
    indexes: [
      "idx_task_history_install_time",
      "idx_task_history_task_time",
      "idx_task_history_event_type",
    ],
  },
];

export const LEASE_TABLES: readonly ExpectedTableSchema[] = [
  {
    table: "leases",
    columns: [
      "key",
      "holder_activity_id",
      "owner_host",
      "resource_kind",
      "resource_host",
      "resource_path",
      "acquired_at",
      "ttl_ms",
      "renewed_at",
      "expires_at",
      "stolen_from_holder_activity_id",
      "stolen_at",
      "steal_provenance_json",
      "metadata_json",
    ],
    indexes: [
      "idx_leases_holder",
      "idx_leases_owner_host",
      "idx_leases_resource_kind",
      "idx_leases_expires_at",
    ],
  },
  {
    table: "lease_events",
    columns: [
      "event_id",
      "key",
      "event_type",
      "occurred_at",
      "reason",
      "before_lease_json",
      "after_lease_json",
      "request_provenance_json",
    ],
    indexes: ["idx_lease_events_key_event", "idx_lease_events_request"],
    requiredSqlFragments: [
      "event_type TEXT NOT NULL CHECK (event_type IN ('acquired', 'renewed', 'quarantined', 'released', 'stolen'))",
      "event_type IN ('renewed', 'quarantined', 'stolen') AND before_lease_json IS NOT NULL AND after_lease_json IS NOT NULL",
    ],
  },
];

export interface AppliedMigration {
  id: string;
  description: string;
  appliedAt: string;
}

export interface MigrationPlanEntry {
  id: string;
  description: string;
  /** "pending" — not yet applied. "applied" — already in the ledger. */
  status: "pending" | "applied";
  growthBound: MigrationGrowthBound;
}

export interface MigrationPlan {
  driver: string;
  current: string | null;
  target: string | null;
  pending: MigrationPlanEntry[];
  applied: AppliedMigration[];
  /**
   * True when the schema_migrations table exists. False on a brand-new
   * database; the plan is still produced (every migration is pending).
   */
  ledgerExists: boolean;
}

export interface MigrationApplyResult {
  driver: string;
  applied: AppliedMigration[];
  /** Migrations skipped because the ledger already recorded them. */
  alreadyApplied: AppliedMigration[];
  current: string | null;
  target: string | null;
}

/**
 * Migration consistency check. "ok" means the ledger only contains
 * migrations that exist in the source set, in order, and the highest
 * applied id is contiguous with `0001`. "drift" reports the offending
 * migration and a structured reason.
 */
export interface MigrationConsistency {
  status: "ok" | "drift" | "no-ledger";
  reason?: string;
  unknownIds?: string[];
  missingIds?: string[];
}

function tableExists(db: StateDriverDatabase, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name?: string } | undefined;
  return Boolean(row && row.name === table);
}

function readApplied(db: StateDriverDatabase): AppliedMigration[] {
  if (!tableExists(db, "schema_migrations")) return [];
  const rows = db
    .prepare(`SELECT id, description, applied_at FROM schema_migrations ORDER BY id ASC`)
    .all() as Array<{ id: string; description: string; applied_at: string }>;
  return rows.map((r) => ({ id: r.id, description: r.description, appliedAt: r.applied_at }));
}

export function computeMigrationPlan(
  db: StateDriverDatabase,
  source: readonly StateMigration[] = STATE_MIGRATIONS,
  driverId: string,
): MigrationPlan {
  const ledgerExists = tableExists(db, "schema_migrations");
  const applied = readApplied(db);
  const appliedSet = new Set(applied.map((m) => m.id));
  const pending: MigrationPlanEntry[] = source
    .filter((m) => !appliedSet.has(m.id))
    .map((m) => ({
      id: m.id,
      description: m.description,
      status: "pending",
      growthBound: m.growthBound,
    }));

  const current = applied.length === 0 ? null : applied[applied.length - 1]!.id;
  const target = source.length === 0 ? null : source[source.length - 1]!.id;

  return {
    driver: driverId,
    current,
    target,
    pending,
    applied,
    ledgerExists,
  };
}

export function applyMigrations(
  db: StateDriverDatabase,
  source: readonly StateMigration[] = STATE_MIGRATIONS,
  driverId: string,
  now: () => string = () => new Date().toISOString(),
): MigrationApplyResult {
  const before = computeMigrationPlan(db, source, driverId);
  const applied: AppliedMigration[] = [];

  if (before.pending.length > 0) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of before.pending) {
        const def = source.find((m) => m.id === entry.id);
        if (!def) {
          throw new Error(`migration ${entry.id} declared pending but not found in source`);
        }
        def.up(db);
        const appliedAt = now();
        // Prepare per iteration: migration 0001 creates the ledger table,
        // so the prepared insert can only be valid after `up` has run.
        db.prepare(
          `INSERT INTO schema_migrations (id, description, applied_at) VALUES (?, ?, ?)`,
        ).run(def.id, def.description, appliedAt);
        applied.push({ id: def.id, description: def.description, appliedAt });
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* swallow secondary error; surface the original */
      }
      throw err;
    }
  }

  const after = computeMigrationPlan(db, source, driverId);
  const appliedIds = new Set(applied.map((m) => m.id));
  const alreadyApplied = after.applied.filter((m) => !appliedIds.has(m.id));

  return {
    driver: driverId,
    applied,
    alreadyApplied,
    current: after.current,
    target: after.target,
  };
}

export function checkMigrationConsistency(
  db: StateDriverDatabase,
  source: readonly StateMigration[] = STATE_MIGRATIONS,
): MigrationConsistency {
  if (!tableExists(db, "schema_migrations")) {
    return { status: "no-ledger" };
  }
  const applied = readApplied(db);
  const sourceIds = source.map((m) => m.id);
  const sourceSet = new Set(sourceIds);
  const unknownIds = applied.map((m) => m.id).filter((id) => !sourceSet.has(id));

  // Applied ids must be a contiguous prefix of source ids (in order).
  const expected = sourceIds.slice(0, applied.length);
  const orderMismatch = applied.some((m, i) => m.id !== expected[i]);

  if (unknownIds.length > 0) {
    return {
      status: "drift",
      reason: "ledger contains migrations not in source",
      unknownIds,
    };
  }
  if (orderMismatch) {
    const missingIds = expected.filter((id) => !applied.find((m) => m.id === id));
    return {
      status: "drift",
      reason: "ledger order or contents diverge from source migrations",
      missingIds,
    };
  }
  return { status: "ok" };
}
