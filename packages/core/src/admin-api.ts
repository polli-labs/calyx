import type { CalyxDaemonBuildSummary } from "./daemon-registry";
import { CALYX_RUN_SERVICE_DAEMON_KIND } from "./daemon-registry";
import type { StateSchemaStatus } from "./state/migrations";

export const CALYX_ADMIN_HEALTH_SCHEMA_VERSION = "calyx.admin-health/v1";
export const CALYX_ADMIN_RECONCILE_SCHEMA_VERSION = "calyx.admin-reconcile-result/v1";
export const CALYX_ADMIN_RECONCILE_NONCANONICAL_MAX_ITEMS = 64;
export const CALYX_ADMIN_RECONCILE_DIRECTORY_NAME_MAX_LENGTH = 255;
export const CALYX_ADMIN_RECONCILE_RECORD_STATE_MAX_LENGTH = 64;

export const CALYX_ADMIN_RECONCILE_UNRESOLVED_REASONS = [
  "canonical_run_record_missing",
  "legacy_owner_settlement_pending",
  "legacy_resource_settlement_pending",
  "legacy_publication_authority_unproven",
  "reconcile_candidate_failed",
] as const;
export type CalyxAdminReconcileUnresolvedReason =
  (typeof CALYX_ADMIN_RECONCILE_UNRESOLVED_REASONS)[number];

export interface CalyxAdminNonCanonicalRunDirectoryDisposition {
  directory_name: string;
  /**
   * Readers retain predecessor v1 variants for rolling-fleet compatibility.
   * Current daemons emit only requires_operator_migration.
   */
  status:
    | "quarantined"
    | "already_absent"
    | "requires_operator_migration"
    | "quarantine_failed";
  record_state?: string;
}

export interface CalyxAdminHealth {
  schema_version: typeof CALYX_ADMIN_HEALTH_SCHEMA_VERSION;
  protocol_epoch: number;
  daemon_kind: typeof CALYX_RUN_SERVICE_DAEMON_KIND;
  daemon_id: string;
  advertised_host?: string;
  uptime_ms: number;
  started_at: string;
  build: CalyxDaemonBuildSummary;
  promoted_build?: {
    status: "ok" | "missing" | "error";
    build?: CalyxDaemonBuildSummary;
  };
  clone_head?: {
    status: "ok" | "unavailable" | "error";
    git_head?: string;
  };
  /**
   * State-store migration position. Absent from daemons predating
   * POL-2090 — readers render an unknown schema rather than assume parity.
   */
  state_schema?: {
    status: StateSchemaStatus;
    driver?: string;
    current?: string | null;
    target?: string | null;
    pending?: number;
  };
  active_runs: number;
  maintenance_mode: boolean;
  supports_features: string[];
  interactive_sessions?: {
    window_ms: number;
    scanned_at: string;
    codex: number;
    claude: number;
    total: number;
    status?: "ok" | "unavailable";
    reason?: "timeout" | "error";
    timed_out_ms?: number;
  };
}

export interface CalyxAdminReconcileResult {
  schema_version: typeof CALYX_ADMIN_RECONCILE_SCHEMA_VERSION;
  status: "completed" | "incomplete";
  scanned: number;
  changed: {
    rebuilt: number;
    repair_pending: number;
    classified: number;
    adopted: number;
    skipped: number;
    unresolved: number;
    noncanonical_directories: number;
  };
  /** Bounded reason histogram. Run identifiers remain on the internal surface. */
  unresolved: Array<{
    reason: CalyxAdminReconcileUnresolvedReason;
    count: number;
  }>;
  /**
   * Bounded examples only. `changed.noncanonical_directories` is the
   * authoritative total; a greater total than this array's length is the v1
   * truncation signal.
   */
  noncanonical_directories: CalyxAdminNonCanonicalRunDirectoryDisposition[];
  projection:
    | { status: "repaired"; row_count: number }
    | { status: "not_configured" }
    | { status: "failed" };
  completed_at: string;
}

export interface CalyxAdminReconcileSource {
  scanned: number;
  rebuilt: readonly string[];
  repair_pending?: readonly string[];
  classified: readonly string[];
  adopted: readonly string[];
  skipped: readonly string[];
  unresolved: ReadonlyArray<{
    run_id: string;
    reason: CalyxAdminReconcileUnresolvedReason;
  }>;
  noncanonical_directories: ReadonlyArray<{
    directory_name: string;
    status: "requires_operator_migration";
    record_state?: string;
  }>;
  projection:
    | { status: "repaired"; rowCount: number }
    | { status: "not_configured" }
    | { status: "failed"; reason: string };
}

/** Project the internal run-service result into the bounded admin wire receipt. */
export function toCalyxAdminReconcileResult(
  source: CalyxAdminReconcileSource,
  completedAt = new Date().toISOString(),
): CalyxAdminReconcileResult {
  const unresolved = source.unresolved;
  const unresolvedByReason = CALYX_ADMIN_RECONCILE_UNRESOLVED_REASONS.flatMap((reason) => {
    const count = unresolved.filter((entry) => entry.reason === reason).length;
    return count > 0 ? [{ reason, count }] : [];
  });
  const boundedNonCanonicalDirectories = source.noncanonical_directories
    .slice(0, CALYX_ADMIN_RECONCILE_NONCANONICAL_MAX_ITEMS)
    .map((entry) => ({
      directory_name: truncateReconcileReceiptString(
        entry.directory_name,
        CALYX_ADMIN_RECONCILE_DIRECTORY_NAME_MAX_LENGTH,
      ),
      status: entry.status,
      ...(entry.record_state
        ? {
            record_state: truncateReconcileReceiptString(
              entry.record_state,
              CALYX_ADMIN_RECONCILE_RECORD_STATE_MAX_LENGTH,
            ),
          }
        : {}),
    }));
  return {
    schema_version: CALYX_ADMIN_RECONCILE_SCHEMA_VERSION,
    status: source.projection.status === "failed"
      || (source.repair_pending?.length ?? 0) > 0
      || unresolved.length > 0
      || source.noncanonical_directories.length > 0
      ? "incomplete"
      : "completed",
    scanned: source.scanned,
    changed: {
      rebuilt: source.rebuilt.length,
      repair_pending: source.repair_pending?.length ?? 0,
      classified: source.classified.length,
      adopted: source.adopted.length,
      skipped: source.skipped.length,
      unresolved: unresolved.length,
      noncanonical_directories: source.noncanonical_directories.length,
    },
    unresolved: unresolvedByReason,
    noncanonical_directories: boundedNonCanonicalDirectories,
    projection: source.projection.status === "repaired"
      ? { status: "repaired", row_count: source.projection.rowCount }
      : { status: source.projection.status },
    completed_at: completedAt,
  };
}

/**
 * Normalize only the current bounded fields on an accepted same-major receipt.
 * Callers validate a compatibility shadow first, then pass the original wire
 * object here so additive members and open-enum values survive the read path.
 */
export function normalizeCalyxAdminReconcileResultForConsumer(
  result: CalyxAdminReconcileResult,
): CalyxAdminReconcileResult {
  return {
    ...result,
    noncanonical_directories: result.noncanonical_directories
      .slice(0, CALYX_ADMIN_RECONCILE_NONCANONICAL_MAX_ITEMS)
      .map((entry) => ({
        ...entry,
        directory_name: truncateReconcileReceiptString(
          entry.directory_name,
          CALYX_ADMIN_RECONCILE_DIRECTORY_NAME_MAX_LENGTH,
        ),
        ...(entry.record_state !== undefined
          ? {
              record_state: truncateReconcileReceiptString(
                entry.record_state,
                CALYX_ADMIN_RECONCILE_RECORD_STATE_MAX_LENGTH,
              ),
            }
          : {}),
      })),
  };
}

function truncateReconcileReceiptString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const truncated = value.slice(0, maxLength);
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff
    ? truncated.slice(0, -1)
    : truncated;
}
