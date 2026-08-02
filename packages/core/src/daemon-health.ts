import type { CalyxDaemonBuildSummary } from "./daemon-registry";
import { CALYX_RUN_SERVICE_DAEMON_KIND } from "./daemon-registry";
import type { StateSchemaStatus } from "./state/migrations";

export const CALYX_DAEMON_HEALTH_SCHEMA_VERSION = "daemon-health/v1";
export const CALYX_DAEMON_HEALTH_PROTOCOL_EPOCH = 1;

export interface CalyxDaemonInteractiveSessionSummary {
  window_ms: number;
  scanned_at: string;
  codex: number;
  claude: number;
  total: number;
  status?: "ok" | "unavailable";
  reason?: "timeout" | "error";
  timed_out_ms?: number;
  error?: string;
}

export interface CalyxDaemonPromotedBuildSummary {
  status: "ok" | "missing" | "error";
  install_path?: string;
  current_link?: string;
  build_info_path?: string;
  build?: CalyxDaemonBuildSummary;
  error?: string;
}

export interface CalyxDaemonCloneHeadSummary {
  status: "ok" | "unavailable" | "error";
  repo_root?: string;
  git_head?: string;
  error?: string;
}

/**
 * The state store's migration position, as this daemon's build measures it.
 * A host's schema only advances when something runs there, so without this on
 * the wire a fleet-wide schema spread is invisible until an upgrade fails.
 */
export interface CalyxDaemonStateSchemaSummary {
  status: StateSchemaStatus;
  driver?: string;
  /** Highest migration id in the ledger; null when nothing is applied. */
  current?: string | null;
  /** Highest migration id this daemon's build declares. */
  target?: string | null;
  /** Migrations this build declares that the ledger lacks. */
  pending?: number;
  error?: string;
}

export interface CalyxDaemonHealth {
  schema_version: typeof CALYX_DAEMON_HEALTH_SCHEMA_VERSION;
  protocol_epoch: typeof CALYX_DAEMON_HEALTH_PROTOCOL_EPOCH;
  daemon_kind: typeof CALYX_RUN_SERVICE_DAEMON_KIND;
  daemon_id: string;
  advertised_host?: string;
  pid: number;
  uptime_ms: number;
  started_at: string;
  build: CalyxDaemonBuildSummary;
  env: {
    inherited_path: string;
  };
  promoted_build?: CalyxDaemonPromotedBuildSummary;
  clone_head?: CalyxDaemonCloneHeadSummary;
  state_schema?: CalyxDaemonStateSchemaSummary;
  active_runs: number;
  active_run_ids?: string[];
  maintenance_mode: boolean;
  supports_features: string[];
  interactive_sessions?: CalyxDaemonInteractiveSessionSummary;
}
