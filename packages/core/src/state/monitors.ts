import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, stat as fsStat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { StateDriverDatabase } from "./driver";
import { MONITOR_TABLES } from "./migrations";
import { parseApiProvenanceJson, validateApiProvenance, type ApiProvenanceV1 } from "./provenance";

export const MONITOR_SCHEMA_VERSION = "calyx.monitor/v1";
export const MONITOR_WAKE_SCHEMA_VERSION = "calyx.monitor-wake/v1";
export const MONITOR_DELIVERY_SCHEMA_VERSION = "calyx.monitor-delivery/v1";
export const PREDICATE_SCHEMA_VERSION = "predicate/v1";
export const PREDICATE_EVALUATION_SCHEMA_VERSION = "predicate-evaluation/v1";
export const MONITOR_WAKE_JSONL_RELATIVE_PATH = "receipts/monitor-wakes.jsonl";

export const MONITOR_STATUSES = ["active", "cancelled"] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

export const MONITOR_CREATE_PROVENANCES = ["conductor", "operator"] as const;
export type MonitorCreateProvenance = (typeof MONITOR_CREATE_PROVENANCES)[number];

export const MONITOR_REARM_POLICIES = [
  "once",
  "rearm_on_reset",
  "every_change",
] as const;
export type MonitorRearmPolicy = (typeof MONITOR_REARM_POLICIES)[number];

export const MONITOR_WAKE_STATUSES = ["pending", "claimed", "acked"] as const;
export type MonitorWakeStatus = (typeof MONITOR_WAKE_STATUSES)[number];
export const MONITOR_WAKE_CLAIM_TTL_MS = 5 * 60 * 1000;

export const MONITOR_DELIVERY_ADAPTERS = [
  "ntfy",
  "linear_comment",
  "vault_receipt",
  "codex_automation",
  "codex_app_server_steer",
  "claude_reinvoke",
  "claude_channel",
] as const;
export type MonitorDeliveryAdapterV1 = (typeof MONITOR_DELIVERY_ADAPTERS)[number];
export const MONITOR_SYSTEM_DELIVERY_ADAPTERS = ["session_ingress"] as const;
export type MonitorObservedDeliveryAdapterV1 =
  | MonitorDeliveryAdapterV1
  | (typeof MONITOR_SYSTEM_DELIVERY_ADAPTERS)[number];

export const MONITOR_DELIVERY_MATERIALITY_KINDS = [
  "always",
  "run_failed_or_stalled",
  "run_success",
  "artifact_churn",
] as const;
export type MonitorDeliveryMaterialityKindV1 =
  (typeof MONITOR_DELIVERY_MATERIALITY_KINDS)[number];

export const MONITOR_DELIVERY_STATUSES = [
  "attempted",
  "delivered",
  "failed",
] as const;
export type MonitorDeliveryStatus = (typeof MONITOR_DELIVERY_STATUSES)[number];

export type PredicateKindV1 =
  | "run.terminal"
  | "run.failed"
  | "run.health_stale"
  | "artifact.exists"
  | "artifact.changed"
  | "receipt.appeared"
  | "tracker.state_changed"
  | "tracker.label_changed"
  | "vault.path_changed"
  | "time.cron"
  | "time.after"
  | "all_of"
  | "any_of"
  | "debounce"
  | "for_duration";

interface PredicateBaseV1 {
  schema_version: typeof PREDICATE_SCHEMA_VERSION;
  kind: PredicateKindV1;
}

export interface RunTerminalPredicateV1 extends PredicateBaseV1 {
  kind: "run.terminal";
  run_id: string;
}

export interface RunFailedPredicateV1 extends PredicateBaseV1 {
  kind: "run.failed";
  run_id: string;
}

export interface RunHealthStalePredicateV1 extends PredicateBaseV1 {
  kind: "run.health_stale";
  run_id: string;
  threshold_ms: number;
}

export interface ArtifactExistsPredicateV1 extends PredicateBaseV1 {
  kind: "artifact.exists";
  path: string;
}

export interface ArtifactChangedPredicateV1 extends PredicateBaseV1 {
  kind: "artifact.changed";
  path: string;
  baseline?: ArtifactIdentity | undefined;
}

export interface ReceiptAppearedPredicateV1 extends PredicateBaseV1 {
  kind: "receipt.appeared";
  run_id: string;
}

export interface TrackerStateChangedPredicateV1 extends PredicateBaseV1 {
  kind: "tracker.state_changed";
  tracker_id: string;
  to_state: string;
}

export interface TrackerLabelChangedPredicateV1 extends PredicateBaseV1 {
  kind: "tracker.label_changed";
  tracker_id: string;
  label: string;
}

export interface VaultPathChangedPredicateV1 extends PredicateBaseV1 {
  kind: "vault.path_changed";
  path: string;
}

export interface TimeCronPredicateV1 extends PredicateBaseV1 {
  kind: "time.cron";
  expr: string;
  timezone?: string | undefined;
}

export interface TimeAfterPredicateV1 extends PredicateBaseV1 {
  kind: "time.after";
  at: string;
}

export interface AllOfPredicateV1 extends PredicateBaseV1 {
  kind: "all_of";
  predicates: PredicateV1[];
}

export interface AnyOfPredicateV1 extends PredicateBaseV1 {
  kind: "any_of";
  predicates: PredicateV1[];
}

export interface DebouncePredicateV1 extends PredicateBaseV1 {
  kind: "debounce";
  predicate: PredicateV1;
  window_ms: number;
}

export interface ForDurationPredicateV1 extends PredicateBaseV1 {
  kind: "for_duration";
  predicate: PredicateV1;
  duration_ms: number;
}

export type PredicateV1 =
  | RunTerminalPredicateV1
  | RunFailedPredicateV1
  | RunHealthStalePredicateV1
  | ArtifactExistsPredicateV1
  | ArtifactChangedPredicateV1
  | ReceiptAppearedPredicateV1
  | TrackerStateChangedPredicateV1
  | TrackerLabelChangedPredicateV1
  | VaultPathChangedPredicateV1
  | TimeCronPredicateV1
  | TimeAfterPredicateV1
  | AllOfPredicateV1
  | AnyOfPredicateV1
  | DebouncePredicateV1
  | ForDurationPredicateV1;

export interface ArtifactIdentity {
  exists?: boolean;
  path?: string;
  mtime_ms?: number;
  size?: number;
  sha256?: string;
}

/**
 * Bounded consumer projection of the runner-owned provider constraint.
 * Runner remains authoritative for the kind/source taxonomy.
 */
export interface PredicateProviderConstraintSnapshot {
  schema_version: "calyx.provider-constraint/v1";
  cause: "provider_capacity_exhausted";
  backend: string;
  kind: string;
  source: string;
  observed_at: string;
  confidence: "definitive";
  provider_code?: string;
  http_status?: number;
  reset_hint?: string;
}

export interface PredicateRunSnapshot {
  run_id: string;
  state: string;
  infra_error_classification?: {
    schema_version: string;
    failure_layer: string;
    failure_reason: string;
    message: string;
  } | null | undefined;
  provider_constraint?: PredicateProviderConstraintSnapshot | null | undefined;
  issue?: string | null | undefined;
  summary?: string | undefined;
  host?: string | undefined;
  health_status?: string | null | undefined;
  last_progress_at?: string | null | undefined;
  updated_at?: string | undefined;
  completed_at?: string | null | undefined;
  receipt_path?: string | null | undefined;
}

export interface PredicateTrackerSnapshot {
  tracker_id: string;
  state?: string | null | undefined;
  labels?: string[] | undefined;
  cursor?: string | undefined;
}

export interface PredicateArtifactSnapshot extends ArtifactIdentity {
  exists: boolean;
  path: string;
}

export interface PredicateEvaluationContext {
  now?: (() => Date) | undefined;
  readRun?: ((runId: string) => Promise<PredicateRunSnapshot | undefined> | PredicateRunSnapshot | undefined) | undefined;
  readReceipt?: ((runId: string) => Promise<ArtifactIdentity | undefined> | ArtifactIdentity | undefined) | undefined;
  statPath?: ((path: string) => Promise<PredicateArtifactSnapshot> | PredicateArtifactSnapshot) | undefined;
  readTracker?: ((trackerId: string) => Promise<PredicateTrackerSnapshot | undefined> | PredicateTrackerSnapshot | undefined) | undefined;
}

export type PredicateEvidenceStatus =
  | "matched"
  | "not_matched"
  | "missing"
  | "unavailable"
  | "error";

export interface PredicateEvidenceRecord {
  schema_version: "predicate-evidence/v1";
  kind: PredicateKindV1;
  source: string;
  locator: string;
  observed_at: string;
  status: PredicateEvidenceStatus;
  detail?: string;
  cursor?: string;
  value?: unknown;
}

export interface PredicateEvaluationResult {
  schema_version: typeof PREDICATE_EVALUATION_SCHEMA_VERSION;
  evaluated_at: string;
  matched: boolean;
  predicate_hash: string;
  transition_hash: string;
  fingerprint: string;
  cursor: Record<string, unknown>;
  evidence: PredicateEvidenceRecord[];
  warnings: string[];
}

export interface MonitorDeliveryMaterialityV1 {
  schema_version: "calyx.monitor-materiality/v1";
  kind: MonitorDeliveryMaterialityKindV1;
}

export interface MonitorDeliveryDigestV1 {
  mode: "debounced";
  window_ms: number;
}

export interface MonitorNtfyDeliveryOptionsV1 {
  url?: string | undefined;
  topic?: string | undefined;
  priority?: "min" | "low" | "default" | "high" | "urgent" | undefined;
}

export interface MonitorLinearCommentDeliveryOptionsV1 {
  issue_id?: string | undefined;
  dry_run?: boolean | undefined;
}

export interface MonitorVaultReceiptDeliveryOptionsV1 {
  vault_root?: string | undefined;
  directory?: string | undefined;
  dry_run?: boolean | undefined;
}

export interface MonitorCodexAutomationDeliveryOptionsV1 {
  codex_home?: string | undefined;
  automation_id?: string | undefined;
  thread_id?: string | undefined;
  cwd?: string | undefined;
  name?: string | undefined;
  rrule?: string | undefined;
  status?: "ACTIVE" | "PAUSED" | undefined;
  model?: string | undefined;
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
  execution_environment?: "local" | "sandbox" | undefined;
  dry_run?: boolean | undefined;
  allow_update?: boolean | undefined;
}

export interface MonitorCodexAppServerSteerDeliveryOptionsV1 {
  run_id?: string | undefined;
  live_binding_id?: string | undefined;
  dry_run?: boolean | undefined;
  timeout_ms?: number | undefined;
}

export interface MonitorClaudeReinvokeDeliveryOptionsV1 {
  command?: string | undefined;
  cwd?: string | undefined;
  session_id?: string | undefined;
  continue_latest?: boolean | undefined;
  dry_run?: boolean | undefined;
  timeout_ms?: number | undefined;
  model?: string | undefined;
  permission_mode?: "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan" | undefined;
  allowed_tools?: string[] | undefined;
}

export interface MonitorClaudeChannelDeliveryOptionsV1 {
  receiver_url?: string | undefined;
  channel?: string | undefined;
  token_env?: string | undefined;
  dry_run?: boolean | undefined;
  timeout_ms?: number | undefined;
}

export interface MonitorDeliveryAdapterBindingV1 {
  schema_version: typeof MONITOR_DELIVERY_SCHEMA_VERSION;
  binding_id: string;
  adapter: MonitorDeliveryAdapterV1;
  materiality: MonitorDeliveryMaterialityV1;
  enabled?: boolean | undefined;
  digest?: MonitorDeliveryDigestV1 | undefined;
  ntfy?: MonitorNtfyDeliveryOptionsV1 | undefined;
  linear_comment?: MonitorLinearCommentDeliveryOptionsV1 | undefined;
  vault_receipt?: MonitorVaultReceiptDeliveryOptionsV1 | undefined;
  codex_automation?: MonitorCodexAutomationDeliveryOptionsV1 | undefined;
  codex_app_server_steer?: MonitorCodexAppServerSteerDeliveryOptionsV1 | undefined;
  claude_reinvoke?: MonitorClaudeReinvokeDeliveryOptionsV1 | undefined;
  claude_channel?: MonitorClaudeChannelDeliveryOptionsV1 | undefined;
}

export interface MonitorTier0DeliveryV1 {
  schema_version: typeof MONITOR_DELIVERY_SCHEMA_VERSION;
  tier: "tier0";
  adapters: readonly ["state-row", "jsonl-receipt", "sse"];
  retention: "indefinite";
}

export interface MonitorDeliveryBindingV1 {
  schema_version: typeof MONITOR_DELIVERY_SCHEMA_VERSION;
  tier0: MonitorTier0DeliveryV1;
  bindings: MonitorDeliveryAdapterBindingV1[];
  ntfy_topic_policy: "fleet_default_with_per_lane_override";
  tier2_bridge: "codex_app_automations_first";
  agent_mail_thread: "legacy_provenance_only";
}

export interface MonitorRow {
  monitor_id: string;
  schema_version: typeof MONITOR_SCHEMA_VERSION;
  status: MonitorStatus;
  created_at: string;
  updated_at: string;
  owner: string;
  created_by: string;
  create_provenance: MonitorCreateProvenance;
  created_request_provenance: ApiProvenanceV1 | null;
  assigned_host: string | null;
  source_run_id: string | null;
  preset: string | null;
  predicate: PredicateV1;
  rearm_policy: MonitorRearmPolicy;
  delivery: MonitorDeliveryBindingV1 | Record<string, unknown>;
  last_evaluated_at: string | null;
  last_match: boolean | null;
  last_transition_hash: string | null;
  last_wake_id: string | null;
  last_error: string | null;
}

export interface CreateMonitorInput {
  monitor_id?: string | undefined;
  owner: string;
  created_by: string;
  create_provenance: MonitorCreateProvenance;
  created_request_provenance?: ApiProvenanceV1 | null | undefined;
  assigned_host?: string | null | undefined;
  source_run_id?: string | null | undefined;
  preset?: string | null | undefined;
  predicate: PredicateV1;
  rearm_policy: MonitorRearmPolicy;
  delivery?: MonitorDeliveryBindingV1 | Record<string, unknown> | undefined;
  now?: string | undefined;
}

export interface ListMonitorsOptions {
  status?: MonitorStatus | "all" | undefined;
  assigned_host?: string | undefined;
  source_run_id?: string | undefined;
  limit?: number | undefined;
  after?: { created_at: string; monitor_id: string } | undefined;
}

export interface MonitorCursorRow {
  monitor_id: string;
  cursor: Record<string, unknown>;
  updated_at: string;
}

export interface MonitorHistoryRow {
  history_id: number;
  monitor_id: string;
  occurred_at: string;
  event_type: string;
  transition_hash: string | null;
  matched: boolean | null;
  wake_id: string | null;
  evidence: unknown;
  detail: string | null;
  provenance: ApiProvenanceV1 | null;
}

export interface AppendMonitorHistoryInput {
  monitor_id: string;
  occurred_at: string;
  event_type: string;
  transition_hash?: string | null | undefined;
  matched?: boolean | null | undefined;
  wake_id?: string | null | undefined;
  evidence?: unknown;
  detail?: string | null | undefined;
  provenance?: ApiProvenanceV1 | null | undefined;
}

export interface MonitorWakeRow {
  wake_id: string;
  schema_version: typeof MONITOR_WAKE_SCHEMA_VERSION;
  monitor_id: string;
  transition_hash: string;
  status: MonitorWakeStatus;
  created_at: string;
  claimed_until: string | null;
  claimed_by: string | null;
  acked_at: string | null;
  acked_by: string | null;
  rearm_policy: MonitorRearmPolicy;
  predicate: PredicateV1;
  evaluation: PredicateEvaluationResult;
  delivery: MonitorDeliveryBindingV1 | Record<string, unknown>;
  suggested_commands: string[];
  receipt_path: string | null;
}

export interface CreateMonitorWakeInput {
  wake_id?: string | undefined;
  monitor: MonitorRow;
  evaluation: PredicateEvaluationResult;
  suggested_commands: string[];
  created_at?: string | undefined;
}

export interface CreateMonitorWakeResult {
  wake: MonitorWakeRow;
  inserted: boolean;
}

export interface ListMonitorWakesOptions {
  status?: MonitorWakeStatus | "all" | undefined;
  monitor_id?: string | undefined;
  limit?: number | undefined;
  after?: { created_at: string; wake_id: string } | undefined;
}

export interface ClaimMonitorWakesOptions {
  claimed_by: string;
  claimed_at?: string | undefined;
  claim_ttl_ms?: number | undefined;
  monitor_id?: string | undefined;
  limit?: number | undefined;
  provenance?: ApiProvenanceV1 | undefined;
}

export type MonitorWakeAckConflictCode =
  | "monitor_wake_not_claimed"
  | "monitor_wake_claimant_mismatch"
  | "monitor_wake_claim_expired";

export class MonitorWakeAckConflictError extends Error {
  readonly code: MonitorWakeAckConflictCode;
  readonly wake_id: string;

  constructor(code: MonitorWakeAckConflictCode, wakeId: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "MonitorWakeAckConflictError";
    this.code = code;
    this.wake_id = wakeId;
  }
}

export interface MonitorDeliveryRow {
  delivery_id: string;
  wake_id: string;
  monitor_id: string;
  binding_id: string;
  adapter: MonitorObservedDeliveryAdapterV1;
  status: MonitorDeliveryStatus;
  attempted_at: string;
  delivered_at: string | null;
  failed_at: string | null;
  updated_at: string;
  target: Record<string, unknown>;
  evidence: unknown;
  error_code: string | null;
  error_message: string | null;
}

export interface ListMonitorDeliveriesOptions {
  wake_id?: string | undefined;
  monitor_id?: string | undefined;
  status?: MonitorDeliveryStatus | "all" | undefined;
  limit?: number | undefined;
}

export interface CreateMonitorDeliveryAttemptInput {
  wake: MonitorWakeRow;
  binding: MonitorDeliveryAdapterBindingV1;
  attempted_at?: string | undefined;
  target?: Record<string, unknown> | undefined;
  evidence?: unknown;
}

export interface CreateMonitorDeliveryAttemptResult {
  delivery: MonitorDeliveryRow;
  inserted: boolean;
}

export interface CreateMonitorSessionIngressDeliveryAttemptInput {
  wake: MonitorWakeRow;
  activity_id: string;
  attempted_at?: string | undefined;
  target?: Record<string, unknown> | undefined;
  evidence?: unknown;
}

export interface CompleteMonitorDeliveryInput {
  delivery_id: string;
  status: Exclude<MonitorDeliveryStatus, "attempted">;
  completed_at?: string | undefined;
  target?: Record<string, unknown> | undefined;
  evidence?: unknown;
  error_code?: string | null | undefined;
  error_message?: string | null | undefined;
}

export type MonitorDeliveryStatusCounts = Record<MonitorDeliveryStatus, number>;
export interface MonitorDeliveryAggregate extends MonitorDeliveryStatusCounts {
  last_delivery_at: string | null;
}

export interface MonitorSchemaFinding {
  table: string;
  code: "missing-table" | "missing-column" | "missing-index";
  detail: string;
}

const TERMINAL_RUN_STATES = new Set([
  "succeeded",
  "failed",
  "partial",
  "cancelled",
  "auth_error",
  "infra_error",
  "completed_dirty",
]);

const FAILED_RUN_STATES = new Set(["failed", "auth_error", "infra_error"]);

const SELECT_MONITOR = `SELECT
  monitor_id, schema_version, status, created_at, updated_at, owner, created_by,
  create_provenance, assigned_host, source_run_id, preset, predicate_json,
  rearm_policy, delivery_json, last_evaluated_at, last_match,
  last_transition_hash, last_wake_id, last_error, created_provenance_json
FROM monitors`;

const SELECT_WAKE = `SELECT
  wake_id, schema_version, monitor_id, transition_hash, status, created_at,
  claimed_until, claimed_by, acked_at, acked_by, rearm_policy, predicate_json, evaluation_json,
  delivery_json, suggested_commands_json, receipt_path
FROM monitor_wakes`;

const SELECT_DELIVERY = `SELECT
  delivery_id, wake_id, monitor_id, binding_id, adapter, status, attempted_at,
  delivered_at, failed_at, updated_at, target_json, evidence_json, error_code,
  error_message
FROM monitor_deliveries`;

function nowIso(): string {
  return new Date().toISOString();
}

function addMs(iso: string, milliseconds: number): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`timestamp must be an ISO-8601 instant: ${iso}`);
  }
  return new Date(instant.getTime() + milliseconds).toISOString();
}

function normalizeRequired(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must be non-empty`);
  }
  return trimmed;
}

function assertInSet<T extends string>(
  label: string,
  value: string,
  allowed: readonly T[],
): asserts value is T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
}

function normalizeLimit(limit: number | undefined, fallback = 50, max = 500): number {
  if (limit === undefined) return fallback;
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), max);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseObjectJson(value: string): Record<string, unknown> {
  const parsed = parseJson(value);
  return isRecord(parsed) ? parsed : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMonitorDeliveryAdapterBinding(
  value: unknown,
): value is MonitorDeliveryAdapterBindingV1 {
  if (!isRecord(value)) return false;
  if (value["schema_version"] !== MONITOR_DELIVERY_SCHEMA_VERSION) return false;
  if (typeof value["binding_id"] !== "string" || value["binding_id"].trim() === "") {
    return false;
  }
  if (
    typeof value["adapter"] !== "string"
    || !(MONITOR_DELIVERY_ADAPTERS as readonly string[]).includes(value["adapter"])
  ) {
    return false;
  }
  const materiality = value["materiality"];
  if (!isRecord(materiality)) return false;
  if (materiality["schema_version"] !== "calyx.monitor-materiality/v1") return false;
  if (
    typeof materiality["kind"] !== "string"
    || !(MONITOR_DELIVERY_MATERIALITY_KINDS as readonly string[]).includes(materiality["kind"])
  ) {
    return false;
  }
  return true;
}

function hydrateMonitor(row: RawMonitorRow): MonitorRow {
  return {
    monitor_id: row.monitor_id,
    schema_version: row.schema_version as typeof MONITOR_SCHEMA_VERSION,
    status: row.status as MonitorStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
    owner: row.owner,
    created_by: row.created_by,
    create_provenance: row.create_provenance as MonitorCreateProvenance,
    created_request_provenance: row.created_provenance_json
      ? parseApiProvenanceJson(row.created_provenance_json)
      : null,
    assigned_host: row.assigned_host,
    source_run_id: row.source_run_id,
    preset: row.preset,
    predicate: parseJson(row.predicate_json) as PredicateV1,
    rearm_policy: row.rearm_policy as MonitorRearmPolicy,
    delivery: parseJson(row.delivery_json) as MonitorDeliveryBindingV1 | Record<string, unknown>,
    last_evaluated_at: row.last_evaluated_at,
    last_match: row.last_match === null ? null : row.last_match === 1,
    last_transition_hash: row.last_transition_hash,
    last_wake_id: row.last_wake_id,
    last_error: row.last_error,
  };
}

function hydrateWake(row: RawWakeRow): MonitorWakeRow {
  return {
    wake_id: row.wake_id,
    schema_version: row.schema_version as typeof MONITOR_WAKE_SCHEMA_VERSION,
    monitor_id: row.monitor_id,
    transition_hash: row.transition_hash,
    status: row.status as MonitorWakeStatus,
    created_at: row.created_at,
    claimed_until: row.claimed_until,
    claimed_by: row.claimed_by,
    acked_at: row.acked_at,
    acked_by: row.acked_by,
    rearm_policy: row.rearm_policy as MonitorRearmPolicy,
    predicate: parseJson(row.predicate_json) as PredicateV1,
    evaluation: parseJson(row.evaluation_json) as PredicateEvaluationResult,
    delivery: parseJson(row.delivery_json) as MonitorDeliveryBindingV1 | Record<string, unknown>,
    suggested_commands: parseJson(row.suggested_commands_json) as string[],
    receipt_path: row.receipt_path,
  };
}

function hydrateDelivery(row: RawDeliveryRow): MonitorDeliveryRow {
  return {
    delivery_id: row.delivery_id,
    wake_id: row.wake_id,
    monitor_id: row.monitor_id,
    binding_id: row.binding_id,
    adapter: row.adapter as MonitorObservedDeliveryAdapterV1,
    status: row.status as MonitorDeliveryStatus,
    attempted_at: row.attempted_at,
    delivered_at: row.delivered_at,
    failed_at: row.failed_at,
    updated_at: row.updated_at,
    target: parseObjectJson(row.target_json),
    evidence: parseJson(row.evidence_json),
    error_code: row.error_code,
    error_message: row.error_message,
  };
}

interface RawMonitorRow {
  monitor_id: string;
  schema_version: string;
  status: string;
  created_at: string;
  updated_at: string;
  owner: string;
  created_by: string;
  create_provenance: string;
  assigned_host: string | null;
  source_run_id: string | null;
  preset: string | null;
  predicate_json: string;
  rearm_policy: string;
  delivery_json: string;
  last_evaluated_at: string | null;
  last_match: number | null;
  last_transition_hash: string | null;
  last_wake_id: string | null;
  last_error: string | null;
  created_provenance_json: string | null;
}

interface RawWakeRow {
  wake_id: string;
  schema_version: string;
  monitor_id: string;
  transition_hash: string;
  status: string;
  created_at: string;
  claimed_until: string | null;
  claimed_by: string | null;
  acked_at: string | null;
  acked_by: string | null;
  rearm_policy: string;
  predicate_json: string;
  evaluation_json: string;
  delivery_json: string;
  suggested_commands_json: string;
  receipt_path: string | null;
}

interface RawDeliveryRow {
  delivery_id: string;
  wake_id: string;
  monitor_id: string;
  binding_id: string;
  adapter: string;
  status: string;
  attempted_at: string;
  delivered_at: string | null;
  failed_at: string | null;
  updated_at: string;
  target_json: string;
  evidence_json: string;
  error_code: string | null;
  error_message: string | null;
}

interface RawHistoryRow {
  history_id: number | bigint;
  monitor_id: string;
  occurred_at: string;
  event_type: string;
  transition_hash: string | null;
  matched: number | null;
  wake_id: string | null;
  evidence_json: string;
  detail: string | null;
  provenance_json: string | null;
}

function tier0Delivery(): MonitorTier0DeliveryV1 {
  return {
    schema_version: MONITOR_DELIVERY_SCHEMA_VERSION,
    tier: "tier0",
    adapters: ["state-row", "jsonl-receipt", "sse"],
    retention: "indefinite",
  };
}

export function defaultMonitorDeliveryBinding(): MonitorDeliveryBindingV1 {
  return createMonitorDeliveryPolicy([]);
}

export function createMonitorDeliveryPolicy(
  bindings: readonly MonitorDeliveryAdapterBindingV1[],
): MonitorDeliveryBindingV1 {
  return {
    schema_version: MONITOR_DELIVERY_SCHEMA_VERSION,
    tier0: tier0Delivery(),
    bindings: bindings.map((binding) => ({ ...binding })),
    ntfy_topic_policy: "fleet_default_with_per_lane_override",
    tier2_bridge: "codex_app_automations_first",
    agent_mail_thread: "legacy_provenance_only",
  };
}

export function runnerSupervisionPredicate(
  runId: string,
  staleAfterMs = 1_800_000,
): PredicateV1 {
  const normalizedRunId = normalizeRequired("run_id", runId);
  return {
    schema_version: PREDICATE_SCHEMA_VERSION,
    kind: "any_of",
    predicates: [
      { schema_version: PREDICATE_SCHEMA_VERSION, kind: "run.failed", run_id: normalizedRunId },
      {
        schema_version: PREDICATE_SCHEMA_VERSION,
        kind: "run.health_stale",
        run_id: normalizedRunId,
        threshold_ms: staleAfterMs,
      },
      { schema_version: PREDICATE_SCHEMA_VERSION, kind: "run.terminal", run_id: normalizedRunId },
    ],
  };
}

/**
 * The runner-supervision default delivery is **Tier-0 only** (durable local
 * state row, JSONL receipt, SSE) — no Tier-1 push binding.
 *
 * A static preset cannot carry a valid Tier-1 target: ntfy has no operator
 * topic, linear_comment has no issue id, vault_receipt has no path, and an
 * agent-wake (claude_reinvoke/claude_channel/codex_*) has no session id at
 * create time. The previous default named three Tier-1 bindings (ntfy /
 * linear_comment / vault_receipt) that were *all* guaranteed to
 * `target_unavailable` — a non-functional materiality skeleton that
 * manufactured false confidence and silently `delivery_failed`d (POL-1899).
 *
 * The portable wake for a runner-supervision conductor is harness-side
 * completion-reinvoke around finite `calyx run await`, plus the durable
 * `calyx monitor inbox` pull surface. Tier-1 push
 * adapters are **explicit `--deliver` opt-ins**: agent-wakes (claude_reinvoke /
 * claude_channel / codex_*) accelerate a live/resumable conductor, while
 * ntfy / linear_comment are human-facing notifications that never re-invoke an
 * agent and so must never be a runner-supervision default.
 */
export function defaultRunnerSupervisionDeliveryBinding(): MonitorDeliveryBindingV1 {
  return createMonitorDeliveryPolicy([]);
}

export function monitorDeliveryBindings(
  delivery: MonitorDeliveryBindingV1 | Record<string, unknown>,
): MonitorDeliveryAdapterBindingV1[] {
  if (!isRecord(delivery) || delivery["schema_version"] !== MONITOR_DELIVERY_SCHEMA_VERSION) {
    return [];
  }
  const bindings = delivery["bindings"];
  if (!Array.isArray(bindings)) return [];
  return bindings
    .filter(isMonitorDeliveryAdapterBinding)
    .map((binding) => ({ ...binding }));
}

function withMonitorMutation<T>(db: StateDriverDatabase, name: string, fn: () => T): T {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    try { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); } catch { /* preserve the mutation failure */ }
    throw error;
  }
}

export function createMonitor(db: StateDriverDatabase, input: CreateMonitorInput): MonitorRow {
  const owner = normalizeRequired("owner", input.owner);
  const createdBy = normalizeRequired("created_by", input.created_by);
  const createProvenance = input.create_provenance;
  assertInSet("create_provenance", createProvenance, MONITOR_CREATE_PROVENANCES);
  const rearmPolicy = input.rearm_policy;
  assertInSet("rearm_policy", rearmPolicy, MONITOR_REARM_POLICIES);
  const monitorId = normalizeRequired("monitor_id", input.monitor_id ?? `mon_${randomUUID()}`);
  const now = input.now ?? nowIso();
  const delivery = input.delivery ?? defaultMonitorDeliveryBinding();
  const createdRequestProvenance = input.created_request_provenance
    ? validateApiProvenance(input.created_request_provenance)
    : null;

  return withMonitorMutation(db, "monitor_create", () => {
    db.prepare(
    `INSERT INTO monitors
       (monitor_id, schema_version, status, created_at, updated_at, owner,
        created_by, create_provenance, assigned_host, source_run_id, preset,
        predicate_json, rearm_policy, delivery_json, created_provenance_json)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    monitorId,
    MONITOR_SCHEMA_VERSION,
    now,
    now,
    owner,
    createdBy,
    createProvenance,
    input.assigned_host ?? null,
    input.source_run_id ?? null,
    input.preset ?? null,
    JSON.stringify(input.predicate),
    rearmPolicy,
    JSON.stringify(delivery),
    createdRequestProvenance ? JSON.stringify(createdRequestProvenance) : null,
  );

    appendMonitorHistory(db, {
      monitor_id: monitorId,
      occurred_at: now,
      event_type: "monitor.created",
      evidence: { preset: input.preset ?? null, source_run_id: input.source_run_id ?? null },
      provenance: createdRequestProvenance,
    });

    const row = readMonitor(db, monitorId);
    if (!row) {
      throw new Error(`monitor ${monitorId} was not readable after insert`);
    }
    return row;
  });
}

export function readMonitor(
  db: StateDriverDatabase,
  monitorId: string,
): MonitorRow | undefined {
  const row = db
    .prepare(`${SELECT_MONITOR} WHERE monitor_id = ?`)
    .get(monitorId) as RawMonitorRow | undefined;
  return row ? hydrateMonitor(row) : undefined;
}

export function listMonitors(
  db: StateDriverDatabase,
  options: ListMonitorsOptions = {},
): MonitorRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.status && options.status !== "all") {
    clauses.push("status = ?");
    params.push(options.status);
  }
  if (options.assigned_host) {
    clauses.push("assigned_host = ?");
    params.push(options.assigned_host);
  }
  if (options.source_run_id) {
    clauses.push("source_run_id = ?");
    params.push(options.source_run_id);
  }
  if (options.after) {
    clauses.push("(created_at < ? OR (created_at = ? AND monitor_id > ?))");
    params.push(options.after.created_at, options.after.created_at, options.after.monitor_id);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = normalizeLimit(options.limit);
  const rows = db
    .prepare(`${SELECT_MONITOR}${where} ORDER BY created_at DESC, monitor_id ASC LIMIT ?`)
    .all(...params, limit) as RawMonitorRow[];
  return rows.map(hydrateMonitor);
}

export function cancelMonitor(
  db: StateDriverDatabase,
  monitorId: string,
  options: { cancelled_at?: string | undefined; detail?: string | undefined; provenance?: ApiProvenanceV1 | undefined } = {},
): MonitorRow | undefined {
  const now = options.cancelled_at ?? nowIso();
  const provenance = options.provenance ? validateApiProvenance(options.provenance) : undefined;
  return withMonitorMutation(db, "monitor_cancel", () => {
    const changed = db.prepare(
      `UPDATE monitors
       SET status = 'cancelled', updated_at = ?
       WHERE monitor_id = ? AND status = 'active'`,
    ).run(now, monitorId).changes;
    if (Number(changed) !== 1) {
      return readMonitor(db, monitorId);
    }
    appendMonitorHistory(db, {
      monitor_id: monitorId,
      occurred_at: now,
      event_type: "monitor.cancelled",
      detail: options.detail ?? null,
      provenance,
    });
    return readMonitor(db, monitorId);
  });
}

export function readMonitorCursor(
  db: StateDriverDatabase,
  monitorId: string,
): MonitorCursorRow | undefined {
  const row = db
    .prepare(`SELECT monitor_id, cursor_json, updated_at FROM monitor_cursors WHERE monitor_id = ?`)
    .get(monitorId) as { monitor_id: string; cursor_json: string; updated_at: string } | undefined;
  if (!row) return undefined;
  return {
    monitor_id: row.monitor_id,
    cursor: parseObjectJson(row.cursor_json),
    updated_at: row.updated_at,
  };
}

export function writeMonitorCursor(
  db: StateDriverDatabase,
  monitorId: string,
  cursor: Record<string, unknown>,
  updatedAt: string,
): MonitorCursorRow {
  db.prepare(
    `INSERT INTO monitor_cursors (monitor_id, cursor_json, updated_at)
       VALUES (?, ?, ?)
     ON CONFLICT(monitor_id) DO UPDATE SET
       cursor_json = excluded.cursor_json,
       updated_at = excluded.updated_at`,
  ).run(monitorId, JSON.stringify(cursor), updatedAt);
  const row = readMonitorCursor(db, monitorId);
  if (!row) {
    throw new Error(`monitor cursor ${monitorId} was not readable after write`);
  }
  return row;
}

export function appendMonitorHistory(
  db: StateDriverDatabase,
  input: AppendMonitorHistoryInput,
): MonitorHistoryRow {
  db.prepare(
    `INSERT INTO monitor_history
       (monitor_id, occurred_at, event_type, transition_hash, matched,
        wake_id, evidence_json, detail, provenance_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.monitor_id,
    input.occurred_at,
    normalizeRequired("event_type", input.event_type),
    input.transition_hash ?? null,
    input.matched === undefined || input.matched === null ? null : input.matched ? 1 : 0,
    input.wake_id ?? null,
    JSON.stringify(input.evidence ?? {}),
    input.detail ?? null,
    input.provenance ? JSON.stringify(validateApiProvenance(input.provenance)) : null,
  );
  const row = db
    .prepare(`SELECT last_insert_rowid() AS id`)
    .get() as { id: number | bigint } | undefined;
  const historyId = row ? Number(row.id) : 0;
  const inserted = db
    .prepare(
      `SELECT history_id, monitor_id, occurred_at, event_type, transition_hash,
              matched, wake_id, evidence_json, detail, provenance_json
       FROM monitor_history WHERE history_id = ?`,
    )
    .get(historyId) as RawHistoryRow | undefined;
  if (!inserted) {
    throw new Error(`monitor history row ${historyId} was not readable after insert`);
  }
  return hydrateHistory(inserted);
}

export function listMonitorHistory(
  db: StateDriverDatabase,
  monitorId: string,
  options: { limit?: number | undefined } = {},
): MonitorHistoryRow[] {
  const limit = normalizeLimit(options.limit);
  const rows = db
    .prepare(
      `SELECT history_id, monitor_id, occurred_at, event_type, transition_hash,
              matched, wake_id, evidence_json, detail, provenance_json
       FROM monitor_history
       WHERE monitor_id = ?
       ORDER BY history_id DESC
       LIMIT ?`,
    )
    .all(monitorId, limit) as RawHistoryRow[];
  return rows.map(hydrateHistory);
}

function hydrateHistory(row: RawHistoryRow): MonitorHistoryRow {
  return {
    history_id: Number(row.history_id),
    monitor_id: row.monitor_id,
    occurred_at: row.occurred_at,
    event_type: row.event_type,
    transition_hash: row.transition_hash,
    matched: row.matched === null ? null : row.matched === 1,
    wake_id: row.wake_id,
    evidence: parseJson(row.evidence_json),
    detail: row.detail,
    provenance: row.provenance_json ? parseApiProvenanceJson(row.provenance_json) : null,
  };
}

export function recordMonitorEvaluation(
  db: StateDriverDatabase,
  monitorId: string,
  evaluation: PredicateEvaluationResult,
  options: { error?: string | null | undefined } = {},
): MonitorRow | undefined {
  db.prepare(
    `UPDATE monitors
     SET updated_at = ?,
         last_evaluated_at = ?,
         last_match = ?,
         last_transition_hash = ?,
         last_error = ?
     WHERE monitor_id = ?`,
  ).run(
    evaluation.evaluated_at,
    evaluation.evaluated_at,
    evaluation.matched ? 1 : 0,
    evaluation.transition_hash,
    options.error ?? null,
    monitorId,
  );
  writeMonitorCursor(db, monitorId, evaluation.cursor, evaluation.evaluated_at);
  appendMonitorHistory(db, {
    monitor_id: monitorId,
    occurred_at: evaluation.evaluated_at,
    event_type: "monitor.evaluated",
    transition_hash: evaluation.transition_hash,
    matched: evaluation.matched,
    evidence: evaluation,
    detail: options.error ?? null,
  });
  return readMonitor(db, monitorId);
}

export function createMonitorWake(
  db: StateDriverDatabase,
  input: CreateMonitorWakeInput,
): CreateMonitorWakeResult {
  const createdAt = input.created_at ?? nowIso();
  const wakeId = input.wake_id ?? `wake_${randomUUID()}`;
  const monitor = input.monitor;
  const result = db.prepare(
    `INSERT OR IGNORE INTO monitor_wakes
       (wake_id, schema_version, monitor_id, transition_hash, status, created_at,
        rearm_policy, predicate_json, evaluation_json, delivery_json,
        suggested_commands_json)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
  ).run(
    wakeId,
    MONITOR_WAKE_SCHEMA_VERSION,
    monitor.monitor_id,
    input.evaluation.transition_hash,
    createdAt,
    monitor.rearm_policy,
    JSON.stringify(monitor.predicate),
    JSON.stringify(input.evaluation),
    JSON.stringify(monitor.delivery),
    JSON.stringify(input.suggested_commands),
  );
  const changes = typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
  const wake = readMonitorWakeByTransition(db, monitor.monitor_id, input.evaluation.transition_hash);
  if (!wake) {
    throw new Error(`monitor wake for ${monitor.monitor_id} was not readable after insert`);
  }
  if (changes > 0) {
    db.prepare(
      `UPDATE monitors
       SET updated_at = ?, last_wake_id = ?
       WHERE monitor_id = ?`,
    ).run(createdAt, wake.wake_id, monitor.monitor_id);
    appendMonitorHistory(db, {
      monitor_id: monitor.monitor_id,
      occurred_at: createdAt,
      event_type: "monitor.wake.created",
      transition_hash: input.evaluation.transition_hash,
      matched: true,
      wake_id: wake.wake_id,
      evidence: input.evaluation,
    });
  }
  return { wake, inserted: changes > 0 };
}

export function readMonitorWake(
  db: StateDriverDatabase,
  wakeId: string,
): MonitorWakeRow | undefined {
  const row = db
    .prepare(`${SELECT_WAKE} WHERE wake_id = ?`)
    .get(wakeId) as RawWakeRow | undefined;
  return row ? hydrateWake(row) : undefined;
}

export function readMonitorWakeByTransition(
  db: StateDriverDatabase,
  monitorId: string,
  transitionHash: string,
): MonitorWakeRow | undefined {
  const row = db
    .prepare(`${SELECT_WAKE} WHERE monitor_id = ? AND transition_hash = ?`)
    .get(monitorId, transitionHash) as RawWakeRow | undefined;
  return row ? hydrateWake(row) : undefined;
}

export function listMonitorWakes(
  db: StateDriverDatabase,
  options: ListMonitorWakesOptions = {},
): MonitorWakeRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.status && options.status !== "all") {
    clauses.push("status = ?");
    params.push(options.status);
  }
  if (options.monitor_id) {
    clauses.push("monitor_id = ?");
    params.push(options.monitor_id);
  }
  if (options.after) {
    clauses.push("(created_at < ? OR (created_at = ? AND wake_id > ?))");
    params.push(options.after.created_at, options.after.created_at, options.after.wake_id);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = normalizeLimit(options.limit);
  const rows = db
    .prepare(`${SELECT_WAKE}${where} ORDER BY created_at DESC, wake_id ASC LIMIT ?`)
    .all(...params, limit) as RawWakeRow[];
  return rows.map(hydrateWake);
}

export function claimMonitorWakes(
  db: StateDriverDatabase,
  options: ClaimMonitorWakesOptions,
): MonitorWakeRow[] {
  const claimedBy = normalizeRequired("claimed_by", options.claimed_by);
  const claimedAt = options.claimed_at ?? nowIso();
  const claimTtlMs = options.claim_ttl_ms ?? MONITOR_WAKE_CLAIM_TTL_MS;
  if (!Number.isFinite(claimTtlMs) || claimTtlMs <= 0) {
    throw new Error("claim_ttl_ms must be a positive finite number");
  }
  const claimedUntil = addMs(claimedAt, claimTtlMs);
  const provenance = options.provenance ? validateApiProvenance(options.provenance) : undefined;
  return withMonitorMutation(db, "monitor_wake_claim", () => {
    const ownerMonitorClause = `monitor_id IN (SELECT monitor_id FROM monitors WHERE owner = ?)`;
    const expiredClauses = [
      "status = 'claimed'",
      "claimed_until IS NOT NULL",
      "claimed_until <= ?",
      ownerMonitorClause,
    ];
    const expiredParams: unknown[] = [claimedAt, claimedBy];
    if (options.monitor_id) {
      expiredClauses.push("monitor_id = ?");
      expiredParams.push(options.monitor_id);
    }
    const expired = db.prepare(
      `${SELECT_WAKE} WHERE ${expiredClauses.join(" AND ")}`,
    ).all(...expiredParams) as RawWakeRow[];
    for (const row of expired) {
      const wake = hydrateWake(row);
      const changed = Number(db.prepare(
        `UPDATE monitor_wakes
         SET status = 'pending', claimed_until = NULL, claimed_by = NULL
         WHERE wake_id = ? AND status = 'claimed' AND claimed_until <= ?`,
      ).run(wake.wake_id, claimedAt).changes) === 1;
      if (!changed) continue;
      appendMonitorHistory(db, {
        monitor_id: wake.monitor_id,
        occurred_at: claimedAt,
        event_type: "monitor.wake.claim.expired",
        transition_hash: wake.transition_hash,
        matched: true,
        wake_id: wake.wake_id,
        evidence: { claimed_by: wake.claimed_by, claimed_until: wake.claimed_until },
        provenance,
      });
    }

    const claimClauses = [
      ownerMonitorClause,
      "(status = 'pending' OR (status = 'claimed' AND claimed_by = ?))",
    ];
    const claimParams: unknown[] = [claimedBy, claimedBy];
    if (options.monitor_id) {
      claimClauses.push("monitor_id = ?");
      claimParams.push(options.monitor_id);
    }
    const limit = normalizeLimit(options.limit);
    const candidates = db.prepare(
      `${SELECT_WAKE} WHERE ${claimClauses.join(" AND ")}
       ORDER BY created_at ASC, wake_id ASC LIMIT ?`,
    ).all(...claimParams, limit) as RawWakeRow[];
    const claimed: MonitorWakeRow[] = [];
    for (const row of candidates) {
      const wake = hydrateWake(row);
      if (wake.status === "claimed") {
        claimed.push(wake);
        continue;
      }
      const changed = Number(db.prepare(
        `UPDATE monitor_wakes
         SET status = 'claimed', claimed_until = ?, claimed_by = ?
         WHERE wake_id = ? AND status = 'pending'`,
      ).run(claimedUntil, claimedBy, wake.wake_id).changes) === 1;
      if (!changed) continue;
      appendMonitorHistory(db, {
        monitor_id: wake.monitor_id,
        occurred_at: claimedAt,
        event_type: "monitor.wake.claimed",
        transition_hash: wake.transition_hash,
        matched: true,
        wake_id: wake.wake_id,
        evidence: { claimed_by: claimedBy, claimed_until: claimedUntil },
        provenance,
      });
      const updated = readMonitorWake(db, wake.wake_id);
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

export function readMonitorDelivery(
  db: StateDriverDatabase,
  deliveryId: string,
): MonitorDeliveryRow | undefined {
  const row = db
    .prepare(`${SELECT_DELIVERY} WHERE delivery_id = ?`)
    .get(deliveryId) as RawDeliveryRow | undefined;
  return row ? hydrateDelivery(row) : undefined;
}

export function readMonitorDeliveryByWakeBinding(
  db: StateDriverDatabase,
  wakeId: string,
  bindingId: string,
): MonitorDeliveryRow | undefined {
  const row = db
    .prepare(`${SELECT_DELIVERY} WHERE wake_id = ? AND binding_id = ?`)
    .get(wakeId, bindingId) as RawDeliveryRow | undefined;
  return row ? hydrateDelivery(row) : undefined;
}

export function listMonitorDeliveries(
  db: StateDriverDatabase,
  options: ListMonitorDeliveriesOptions = {},
): MonitorDeliveryRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.wake_id) {
    clauses.push("wake_id = ?");
    params.push(options.wake_id);
  }
  if (options.monitor_id) {
    clauses.push("monitor_id = ?");
    params.push(options.monitor_id);
  }
  if (options.status && options.status !== "all") {
    clauses.push("status = ?");
    params.push(options.status);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = normalizeLimit(options.limit);
  const rows = db
    .prepare(`${SELECT_DELIVERY}${where} ORDER BY attempted_at DESC, delivery_id ASC LIMIT ?`)
    .all(...params, limit) as RawDeliveryRow[];
  return rows.map(hydrateDelivery);
}

export function createMonitorDeliveryAttempt(
  db: StateDriverDatabase,
  input: CreateMonitorDeliveryAttemptInput,
): CreateMonitorDeliveryAttemptResult {
  assertInSet("adapter", input.binding.adapter, MONITOR_DELIVERY_ADAPTERS);
  return createMonitorDeliveryAttemptForAdapter(db, {
    wake: input.wake,
    binding_id: input.binding.binding_id,
    adapter: input.binding.adapter,
    ...(input.attempted_at ? { attempted_at: input.attempted_at } : {}),
    ...(input.target ? { target: input.target } : {}),
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
  });
}

export function createMonitorSessionIngressDeliveryAttempt(
  db: StateDriverDatabase,
  input: CreateMonitorSessionIngressDeliveryAttemptInput,
): CreateMonitorDeliveryAttemptResult {
  const activityId = normalizeRequired("activity_id", input.activity_id);
  return createMonitorDeliveryAttemptForAdapter(db, {
    wake: input.wake,
    binding_id: `session_ingress:${activityId}`,
    adapter: "session_ingress",
    ...(input.attempted_at ? { attempted_at: input.attempted_at } : {}),
    target: { activity_id: activityId, ...(input.target ?? {}) },
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
  });
}

function createMonitorDeliveryAttemptForAdapter(
  db: StateDriverDatabase,
  input: {
    wake: MonitorWakeRow;
    binding_id: string;
    adapter: MonitorObservedDeliveryAdapterV1;
    attempted_at?: string | undefined;
    target?: Record<string, unknown> | undefined;
    evidence?: unknown;
  },
): CreateMonitorDeliveryAttemptResult {
  const bindingId = normalizeRequired("binding_id", input.binding_id);
  const attemptedAt = input.attempted_at ?? nowIso();
  const deliveryId = monitorDeliveryId(input.wake.wake_id, bindingId);
  const target = input.target ?? {};
  const result = db.prepare(
    `INSERT OR IGNORE INTO monitor_deliveries
       (delivery_id, wake_id, monitor_id, binding_id, adapter, status, attempted_at,
        updated_at, target_json, evidence_json)
       VALUES (?, ?, ?, ?, ?, 'attempted', ?, ?, ?, ?)`,
  ).run(
    deliveryId,
    input.wake.wake_id,
    input.wake.monitor_id,
    bindingId,
    input.adapter,
    attemptedAt,
    attemptedAt,
    JSON.stringify(target),
    JSON.stringify(input.evidence ?? {}),
  );
  const changes = typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
  const delivery = readMonitorDelivery(db, deliveryId);
  if (!delivery) {
    throw new Error(`monitor delivery ${deliveryId} was not readable after insert`);
  }
  if (changes > 0) {
    appendMonitorHistory(db, {
      monitor_id: input.wake.monitor_id,
      occurred_at: attemptedAt,
      event_type: "monitor.delivery.attempted",
      transition_hash: input.wake.transition_hash,
      matched: true,
      wake_id: input.wake.wake_id,
      evidence: {
        delivery_id: delivery.delivery_id,
        binding_id: bindingId,
        adapter: input.adapter,
        target,
      },
    });
  }
  return { delivery, inserted: changes > 0 };
}

export function completeMonitorDelivery(
  db: StateDriverDatabase,
  input: CompleteMonitorDeliveryInput,
): MonitorDeliveryRow | undefined {
  assertInSet("status", input.status, ["delivered", "failed"] as const);
  const existing = readMonitorDelivery(db, input.delivery_id);
  if (!existing) return undefined;
  if (existing.status !== "attempted") return existing;
  const completedAt = input.completed_at ?? nowIso();
  const target = input.target ?? existing.target;
  const evidence = input.evidence ?? existing.evidence;
  const errorCode = input.status === "failed" ? input.error_code ?? "delivery_failed" : null;
  const errorMessage = input.status === "failed" ? input.error_message ?? null : null;
  db.prepare(
    `UPDATE monitor_deliveries
     SET status = ?,
         delivered_at = ?,
         failed_at = ?,
         updated_at = ?,
         target_json = ?,
         evidence_json = ?,
         error_code = ?,
         error_message = ?
     WHERE delivery_id = ? AND status = 'attempted'`,
  ).run(
    input.status,
    input.status === "delivered" ? completedAt : null,
    input.status === "failed" ? completedAt : null,
    completedAt,
    JSON.stringify(target),
    JSON.stringify(evidence),
    errorCode,
    errorMessage,
    input.delivery_id,
  );
  const updated = readMonitorDelivery(db, input.delivery_id);
  if (updated && updated.status === input.status) {
    appendMonitorHistory(db, {
      monitor_id: updated.monitor_id,
      occurred_at: completedAt,
      event_type: `monitor.delivery.${input.status}`,
      wake_id: updated.wake_id,
      evidence: {
        delivery_id: updated.delivery_id,
        binding_id: updated.binding_id,
        adapter: updated.adapter,
        target,
        evidence,
        ...(errorCode ? { error_code: errorCode } : {}),
        ...(errorMessage ? { error_message: errorMessage } : {}),
      },
      detail: errorMessage,
    });
  }
  return updated;
}

export function ackMonitorWake(
  db: StateDriverDatabase,
  wakeId: string,
  options: { acked_by: string; acked_at?: string | undefined; provenance?: ApiProvenanceV1 | undefined },
): { wake: MonitorWakeRow | undefined; changed: boolean } {
  const ackedBy = normalizeRequired("acked_by", options.acked_by);
  const provenance = options.provenance ? validateApiProvenance(options.provenance) : undefined;
  const ackedAt = options.acked_at ?? nowIso();
  return withMonitorMutation(db, "monitor_wake_ack", () => {
    const existing = readMonitorWake(db, wakeId);
    if (!existing) return { wake: undefined, changed: false };
    if (existing.status === "acked") {
      if (existing.acked_by !== ackedBy) {
        throw new MonitorWakeAckConflictError(
          "monitor_wake_claimant_mismatch",
          wakeId,
          `wake was acknowledged by ${JSON.stringify(existing.acked_by)}; ${JSON.stringify(ackedBy)} cannot replay it`,
        );
      }
      return { wake: existing, changed: false };
    }
    if (existing.status !== "claimed") {
      throw new MonitorWakeAckConflictError(
        "monitor_wake_not_claimed",
        wakeId,
        "wake must be claimed before acknowledgement",
      );
    }
    if (existing.claimed_by !== ackedBy) {
      throw new MonitorWakeAckConflictError(
        "monitor_wake_claimant_mismatch",
        wakeId,
        `wake is claimed by ${JSON.stringify(existing.claimed_by)}; ${JSON.stringify(ackedBy)} cannot acknowledge it`,
      );
    }
    if (!existing.claimed_until || existing.claimed_until <= ackedAt) {
      throw new MonitorWakeAckConflictError(
        "monitor_wake_claim_expired",
        wakeId,
        `claim expired at ${JSON.stringify(existing.claimed_until)}`,
      );
    }
    const changed = Number(db.prepare(
      `UPDATE monitor_wakes
       SET status = 'acked', claimed_until = NULL, claimed_by = NULL,
           acked_at = ?, acked_by = ?
       WHERE wake_id = ? AND status = 'claimed' AND claimed_by = ? AND claimed_until > ?`,
    ).run(ackedAt, ackedBy, wakeId, ackedBy, ackedAt).changes) === 1;
    if (!changed) return { wake: readMonitorWake(db, wakeId), changed: false };
    appendMonitorHistory(db, {
      monitor_id: existing.monitor_id,
      occurred_at: ackedAt,
      event_type: "monitor.wake.acked",
      transition_hash: existing.transition_hash,
      matched: true,
      wake_id: wakeId,
      evidence: { acked_by: ackedBy },
      provenance,
    });
    return { wake: readMonitorWake(db, wakeId), changed: true };
  });
}

export function setMonitorWakeReceiptPath(
  db: StateDriverDatabase,
  wakeId: string,
  receiptPath: string,
): MonitorWakeRow | undefined {
  db.prepare(`UPDATE monitor_wakes SET receipt_path = ? WHERE wake_id = ?`).run(
    receiptPath,
    wakeId,
  );
  return readMonitorWake(db, wakeId);
}

export async function appendMonitorWakeJsonlReceipt(
  stateDir: string,
  wake: MonitorWakeRow,
): Promise<string> {
  const receiptPath = resolve(stateDir, MONITOR_WAKE_JSONL_RELATIVE_PATH);
  await mkdir(dirname(receiptPath), { recursive: true });
  const receiptWake: MonitorWakeRow = { ...wake, receipt_path: receiptPath };
  await appendFile(
    receiptPath,
    `${JSON.stringify({ schema_version: MONITOR_WAKE_SCHEMA_VERSION, wake: receiptWake })}\n`,
    "utf8",
  );
  return receiptPath;
}

export function countMonitors(db: StateDriverDatabase): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM monitors`)
    .get() as { n: number | bigint } | undefined;
  if (!row) return 0;
  return typeof row.n === "bigint" ? Number(row.n) : row.n;
}

export function countMonitorWakes(db: StateDriverDatabase, monitorId?: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM monitor_wakes${monitorId ? " WHERE monitor_id = ?" : ""}`)
    .get(...(monitorId ? [monitorId] : [])) as { n: number | bigint } | undefined;
  if (!row) return 0;
  return typeof row.n === "bigint" ? Number(row.n) : row.n;
}

export function countMonitorDeliveries(db: StateDriverDatabase): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM monitor_deliveries`)
    .get() as { n: number | bigint } | undefined;
  if (!row) return 0;
  return typeof row.n === "bigint" ? Number(row.n) : row.n;
}

export function countMonitorDeliveriesByStatus(
  db: StateDriverDatabase,
  monitorId?: string,
): MonitorDeliveryStatusCounts {
  const counts: MonitorDeliveryStatusCounts = {
    attempted: 0,
    delivered: 0,
    failed: 0,
  };
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM monitor_deliveries${monitorId ? " WHERE monitor_id = ?" : ""} GROUP BY status`)
    .all(...(monitorId ? [monitorId] : [])) as Array<{ status: string; n: number | bigint }>;
  for (const row of rows) {
    if ((MONITOR_DELIVERY_STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status as MonitorDeliveryStatus] =
        typeof row.n === "bigint" ? Number(row.n) : row.n;
    }
  }
  return counts;
}

export function readMonitorDeliveryAggregate(
  db: StateDriverDatabase,
  monitorId: string,
): MonitorDeliveryAggregate {
  const counts = countMonitorDeliveriesByStatus(db, monitorId);
  const row = db.prepare(
    `SELECT MAX(updated_at) AS last_delivery_at FROM monitor_deliveries WHERE monitor_id = ?`,
  ).get(monitorId) as { last_delivery_at: string | null } | undefined;
  return {
    attempted: counts.attempted + counts.delivered + counts.failed,
    delivered: counts.delivered,
    failed: counts.failed,
    last_delivery_at: row?.last_delivery_at ?? null,
  };
}

export function checkMonitorSchema(
  db: StateDriverDatabase,
): { status: "ok" | "drift"; findings: MonitorSchemaFinding[] } {
  const findings: MonitorSchemaFinding[] = [];
  for (const expected of MONITOR_TABLES) {
    const tableRow = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
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
    if (expected.indexes && expected.indexes.length > 0) {
      const indexes = (db
        .prepare(`PRAGMA index_list(${expected.table})`)
        .all() as Array<{ name: string }>)
        .map((index) => index.name);
      for (const index of expected.indexes) {
        if (!indexes.includes(index)) {
          findings.push({
            table: expected.table,
            code: "missing-index",
            detail: `expected index "${index}" not present on "${expected.table}"`,
          });
        }
      }
    }
  }
  return { status: findings.length === 0 ? "ok" : "drift", findings };
}

export async function defaultStatPath(path: string): Promise<PredicateArtifactSnapshot> {
  try {
    const entry = await fsStat(path);
    return {
      exists: true,
      path,
      mtime_ms: Math.trunc(entry.mtimeMs),
      size: entry.size,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { exists: false, path };
    }
    throw err;
  }
}

export async function evaluatePredicateV1(
  predicate: PredicateV1,
  context: PredicateEvaluationContext = {},
  cursor: Record<string, unknown> = {},
): Promise<PredicateEvaluationResult> {
  const now = context.now?.() ?? new Date();
  const evaluatedAt = now.toISOString();
  const evaluated = await evaluatePredicateNode(predicate, context, cursor, now);
  const predicateHash = hashJson(predicate);
  const transitionHash = hashJson({
    schema_version: PREDICATE_EVALUATION_SCHEMA_VERSION,
    predicate_hash: predicateHash,
    matched: evaluated.matched,
    fingerprint: evaluated.fingerprint,
  });
  return {
    schema_version: PREDICATE_EVALUATION_SCHEMA_VERSION,
    evaluated_at: evaluatedAt,
    matched: evaluated.matched,
    predicate_hash: predicateHash,
    transition_hash: transitionHash,
    fingerprint: evaluated.fingerprint,
    cursor: evaluated.cursor,
    evidence: evaluated.evidence,
    warnings: evaluated.warnings,
  };
}

interface NodeEvaluation {
  matched: boolean;
  fingerprint: string;
  cursor: Record<string, unknown>;
  evidence: PredicateEvidenceRecord[];
  warnings: string[];
}

async function evaluatePredicateNode(
  predicate: PredicateV1,
  context: PredicateEvaluationContext,
  cursor: Record<string, unknown>,
  now: Date,
): Promise<NodeEvaluation> {
  switch (predicate.kind) {
    case "run.terminal":
    case "run.failed":
    case "run.health_stale":
      return evaluateRunPredicate(predicate, context, now);
    case "receipt.appeared":
      return evaluateReceiptPredicate(predicate, context, now);
    case "artifact.exists":
    case "artifact.changed":
      return evaluateArtifactPredicate(predicate, context, cursor, now, "artifact");
    case "vault.path_changed":
      return evaluateVaultPredicate(predicate, context, cursor, now);
    case "tracker.state_changed":
    case "tracker.label_changed":
      return evaluateTrackerPredicate(predicate, context, cursor, now);
    case "time.after":
    case "time.cron":
      return evaluateTimePredicate(predicate, cursor, now);
    case "all_of":
    case "any_of":
      return evaluateBooleanCombinator(predicate, context, cursor, now);
    case "debounce":
    case "for_duration":
      return evaluateTemporalCombinator(predicate, context, cursor, now);
    default: {
      const exhaustive: never = predicate;
      throw new Error(`unsupported predicate kind: ${String(exhaustive)}`);
    }
  }
}

async function evaluateRunPredicate(
  predicate: RunTerminalPredicateV1 | RunFailedPredicateV1 | RunHealthStalePredicateV1,
  context: PredicateEvaluationContext,
  now: Date,
): Promise<NodeEvaluation> {
  if (!context.readRun) {
    return singleEvidenceEvaluation(predicate, now, false, {
      source: "run",
      locator: predicate.run_id,
      status: "unavailable",
      detail: "run reader not available",
      value: { run_id: predicate.run_id },
    });
  }
  const run = await context.readRun(predicate.run_id);
  if (!run) {
    return singleEvidenceEvaluation(predicate, now, false, {
      source: "run",
      locator: predicate.run_id,
      status: "missing",
      detail: "run not found",
      value: { run_id: predicate.run_id },
    });
  }

  let matched = false;
  if (predicate.kind === "run.terminal") {
    matched = TERMINAL_RUN_STATES.has(run.state);
  } else if (predicate.kind === "run.failed") {
    matched = FAILED_RUN_STATES.has(run.state);
  } else {
    const lastProgress = run.last_progress_at ? Date.parse(run.last_progress_at) : NaN;
    const updatedAt = run.updated_at ? Date.parse(run.updated_at) : NaN;
    const basis = Number.isFinite(lastProgress)
      ? lastProgress
      : Number.isFinite(updatedAt)
        ? updatedAt
        : NaN;
    matched =
      run.health_status === "stale" ||
      (!TERMINAL_RUN_STATES.has(run.state) &&
        Number.isFinite(basis) &&
        now.getTime() - basis >= predicate.threshold_ms);
  }

  const evidenceValue = {
    run_id: run.run_id,
    state: run.state,
    infra_error_classification: run.infra_error_classification ?? null,
    provider_constraint: run.provider_constraint ?? null,
    issue: run.issue ?? null,
    health_status: run.health_status ?? null,
    last_progress_at: run.last_progress_at ?? null,
    updated_at: run.updated_at ?? null,
    completed_at: run.completed_at ?? null,
  };

  return singleEvidenceEvaluation(predicate, now, matched, {
    source: "run",
    locator: predicate.run_id,
    status: matched ? "matched" : "not_matched",
    value: evidenceValue,
    fingerprint_value: runPredicateFingerprintValue(predicate, evidenceValue),
  });
}

function runPredicateFingerprintValue(
  predicate: RunTerminalPredicateV1 | RunFailedPredicateV1 | RunHealthStalePredicateV1,
  run: {
    run_id: string;
    state: PredicateRunSnapshot["state"];
    infra_error_classification?: PredicateRunSnapshot["infra_error_classification"];
    provider_constraint?: PredicateRunSnapshot["provider_constraint"];
    health_status: string | null;
    last_progress_at: string | null;
  },
): Record<string, unknown> {
  const base = {
    run_id: run.run_id,
    state: run.state,
  };
  if (predicate.kind !== "run.health_stale") {
    return {
      ...base,
      ...(run.infra_error_classification ? { infra_error_classification: run.infra_error_classification } : {}),
      ...(run.provider_constraint ? { provider_constraint: run.provider_constraint } : {}),
    };
  }
  return {
    ...base,
    ...(run.infra_error_classification ? { infra_error_classification: run.infra_error_classification } : {}),
    health_status: run.health_status,
    last_progress_at: run.last_progress_at,
    threshold_ms: predicate.threshold_ms,
  };
}

async function evaluateReceiptPredicate(
  predicate: ReceiptAppearedPredicateV1,
  context: PredicateEvaluationContext,
  now: Date,
): Promise<NodeEvaluation> {
  const run = context.readRun ? await context.readRun(predicate.run_id) : undefined;
  const receipt = context.readReceipt ? await context.readReceipt(predicate.run_id) : undefined;
  const path = run?.receipt_path ?? receipt?.path ?? null;
  const exists = Boolean(path || receipt?.exists);
  return singleEvidenceEvaluation(predicate, now, exists, {
    source: "receipt",
    locator: predicate.run_id,
    status: exists ? "matched" : run || receipt ? "not_matched" : "missing",
    value: { run_id: predicate.run_id, receipt_path: path },
  });
}

async function evaluateArtifactPredicate(
  predicate: ArtifactExistsPredicateV1 | ArtifactChangedPredicateV1,
  context: PredicateEvaluationContext,
  cursor: Record<string, unknown>,
  now: Date,
  source: "artifact" | "vault",
): Promise<NodeEvaluation> {
  const statPath = context.statPath ?? defaultStatPath;
  let snapshot: PredicateArtifactSnapshot;
  try {
    snapshot = await statPath(predicate.path);
  } catch (err) {
    return singleEvidenceEvaluation(predicate, now, false, {
      source,
      locator: predicate.path,
      status: "error",
      detail: (err as Error).message,
    });
  }

  const identity = artifactIdentity(snapshot);
  if (predicate.kind === "artifact.exists") {
    return singleEvidenceEvaluation(predicate, now, snapshot.exists, {
      source,
      locator: predicate.path,
      status: snapshot.exists ? "matched" : "missing",
      value: identity,
    });
  }

  const currentFingerprint = hashJson(identity);
  const baselineFingerprint = predicate.baseline ? hashJson(predicate.baseline) : null;
  const previousFingerprint = typeof cursor.last_fingerprint === "string"
    ? cursor.last_fingerprint
    : null;
  const matched = snapshot.exists
    ? baselineFingerprint
      ? currentFingerprint !== baselineFingerprint
      : previousFingerprint !== null && currentFingerprint !== previousFingerprint
    : false;
  return {
    matched,
    fingerprint: hashJson({
      kind: predicate.kind,
      path: predicate.path,
      identity,
      baseline: predicate.baseline ?? null,
      previous_fingerprint: previousFingerprint,
    }),
    cursor: { last_fingerprint: currentFingerprint, last_identity: identity },
    evidence: [
      evidence(predicate.kind, source, predicate.path, now, matched ? "matched" : snapshot.exists ? "not_matched" : "missing", {
        value: {
          current: identity,
          baseline: predicate.baseline ?? null,
          previous_fingerprint: previousFingerprint,
        },
      }),
    ],
    warnings: [],
  };
}

async function evaluateVaultPredicate(
  predicate: VaultPathChangedPredicateV1,
  context: PredicateEvaluationContext,
  cursor: Record<string, unknown>,
  now: Date,
): Promise<NodeEvaluation> {
  const artifactPredicate: ArtifactChangedPredicateV1 = {
    schema_version: PREDICATE_SCHEMA_VERSION,
    kind: "artifact.changed",
    path: predicate.path,
  };
  const evaluated = await evaluateArtifactPredicate(
    artifactPredicate,
    context,
    cursor,
    now,
    "vault",
  );
  return {
    ...evaluated,
    fingerprint: hashJson({ kind: predicate.kind, path: predicate.path, child: evaluated.fingerprint }),
    evidence: evaluated.evidence.map((record) => ({
      ...record,
      kind: predicate.kind,
      source: "vault",
    })),
  };
}

async function evaluateTrackerPredicate(
  predicate: TrackerStateChangedPredicateV1 | TrackerLabelChangedPredicateV1,
  context: PredicateEvaluationContext,
  cursor: Record<string, unknown>,
  now: Date,
): Promise<NodeEvaluation> {
  if (!context.readTracker) {
    return singleEvidenceEvaluation(predicate, now, false, {
      source: "tracker",
      locator: predicate.tracker_id,
      status: "unavailable",
      detail: "tracker reader not available",
    });
  }
  const tracker = await context.readTracker(predicate.tracker_id);
  if (!tracker) {
    return singleEvidenceEvaluation(predicate, now, false, {
      source: "tracker",
      locator: predicate.tracker_id,
      status: "missing",
      detail: "tracker not found",
    });
  }

  const previousState = typeof cursor.last_state === "string" ? cursor.last_state : null;
  const rawPreviousLabels = cursor.last_labels;
  const previousLabelsObserved = Array.isArray(rawPreviousLabels);
  const previousLabels = previousLabelsObserved
    ? rawPreviousLabels.filter((label): label is string => typeof label === "string")
    : [];
  const labels = tracker.labels ?? [];
  let matched: boolean;
  if (predicate.kind === "tracker.state_changed") {
    matched = tracker.state === predicate.to_state && previousState !== null && previousState !== tracker.state;
  } else {
    matched =
      labels.includes(predicate.label) &&
      previousLabelsObserved &&
      !previousLabels.includes(predicate.label);
  }
  return {
    matched,
    fingerprint: hashJson({
      kind: predicate.kind,
      tracker_id: predicate.tracker_id,
      state: tracker.state ?? null,
      labels,
      cursor: tracker.cursor ?? null,
    }),
    cursor: { last_state: tracker.state ?? null, last_labels: labels, cursor: tracker.cursor ?? null },
    evidence: [
      evidence(predicate.kind, "tracker", predicate.tracker_id, now, matched ? "matched" : "not_matched", {
        value: { state: tracker.state ?? null, labels, previous_state: previousState, previous_labels: previousLabels },
        ...(tracker.cursor ? { cursor: tracker.cursor } : {}),
      }),
    ],
    warnings: [],
  };
}

function evaluateTimePredicate(
  predicate: TimeAfterPredicateV1 | TimeCronPredicateV1,
  cursor: Record<string, unknown>,
  now: Date,
): NodeEvaluation {
  if (predicate.kind === "time.after") {
    const target = Date.parse(predicate.at);
    if (!Number.isFinite(target)) {
      return singleEvidenceEvaluationSync(predicate, now, false, {
        source: "time",
        locator: predicate.at,
        status: "error",
        detail: "invalid ISO timestamp",
      });
    }
    const matched = now.getTime() >= target;
    return {
      matched,
      fingerprint: hashJson({ kind: predicate.kind, at: predicate.at, reached: matched }),
      cursor: {},
      evidence: [
        evidence(predicate.kind, "time", predicate.at, now, matched ? "matched" : "not_matched", {
          value: { now: now.toISOString(), at: predicate.at },
        }),
      ],
      warnings: [],
    };
  }

  const cron = cronMatches(predicate.expr, now);
  if (!cron.ok) {
    return singleEvidenceEvaluationSync(predicate, now, false, {
      source: "time",
      locator: predicate.expr,
      status: "error",
      detail: cron.error,
    });
  }
  const minuteBucket = now.toISOString().slice(0, 16);
  const lastBucket = typeof cursor.last_bucket === "string" ? cursor.last_bucket : null;
  const matched = cron.matched && lastBucket !== minuteBucket;
  return {
    matched,
    fingerprint: hashJson({ kind: predicate.kind, expr: predicate.expr, minute_bucket: minuteBucket }),
    cursor: { last_bucket: cron.matched ? minuteBucket : lastBucket },
    evidence: [
      evidence(predicate.kind, "time", predicate.expr, now, matched ? "matched" : "not_matched", {
        value: { now: now.toISOString(), minute_bucket: minuteBucket, last_bucket: lastBucket },
      }),
    ],
    warnings: predicate.timezone && predicate.timezone !== "UTC"
      ? ["time.cron currently evaluates against the daemon clock; non-UTC timezone is metadata only in POL-1732a"]
      : [],
  };
}

async function evaluateBooleanCombinator(
  predicate: AllOfPredicateV1 | AnyOfPredicateV1,
  context: PredicateEvaluationContext,
  cursor: Record<string, unknown>,
  now: Date,
): Promise<NodeEvaluation> {
  const priorChildren = Array.isArray(cursor.children) ? cursor.children : [];
  const childResults: NodeEvaluation[] = [];
  for (let index = 0; index < predicate.predicates.length; index += 1) {
    const child = predicate.predicates[index]!;
    const childCursor = isRecord(priorChildren[index]) ? priorChildren[index] : {};
    childResults.push(await evaluatePredicateNode(child, context, childCursor, now));
  }
  const matched = predicate.kind === "all_of"
    ? childResults.length > 0 && childResults.every((result) => result.matched)
    : childResults.some((result) => result.matched);
  const children = childResults.map((result) => result.cursor);
  const matchedFingerprints = childResults
    .filter((result) => result.matched)
    .map((result) => result.fingerprint);
  return {
    matched,
    fingerprint: hashJson({
      kind: predicate.kind,
      children: matched ? matchedFingerprints : childResults.map((result) => result.fingerprint),
    }),
    cursor: { children },
    evidence: [
      evidence(predicate.kind, "predicate", predicate.kind, now, matched ? "matched" : "not_matched", {
        value: {
          child_count: childResults.length,
          matched_count: childResults.filter((result) => result.matched).length,
        },
      }),
      ...childResults.flatMap((result) => result.evidence),
    ],
    warnings: childResults.flatMap((result) => result.warnings),
  };
}

async function evaluateTemporalCombinator(
  predicate: DebouncePredicateV1 | ForDurationPredicateV1,
  context: PredicateEvaluationContext,
  cursor: Record<string, unknown>,
  now: Date,
): Promise<NodeEvaluation> {
  const childCursor = isRecord(cursor.child) ? cursor.child : {};
  const child = await evaluatePredicateNode(predicate.predicate, context, childCursor, now);
  const requiredMs = predicate.kind === "debounce" ? predicate.window_ms : predicate.duration_ms;
  const priorHash = typeof cursor.pending_hash === "string" ? cursor.pending_hash : null;
  const priorSince = typeof cursor.pending_since === "string" ? Date.parse(cursor.pending_since) : NaN;
  const samePending = child.matched && priorHash === child.fingerprint;
  const pendingSince = child.matched
    ? samePending && Number.isFinite(priorSince)
      ? new Date(priorSince).toISOString()
      : now.toISOString()
    : null;
  const elapsedMs = pendingSince ? now.getTime() - Date.parse(pendingSince) : 0;
  const matched = child.matched && elapsedMs >= requiredMs;
  const nextCursor: Record<string, unknown> = {
    child: child.cursor,
    pending_hash: child.matched ? child.fingerprint : null,
    pending_since: pendingSince,
  };
  return {
    matched,
    fingerprint: hashJson({
      kind: predicate.kind,
      child: child.fingerprint,
      required_ms: requiredMs,
      pending_since: pendingSince,
    }),
    cursor: nextCursor,
    evidence: [
      evidence(predicate.kind, "predicate", predicate.kind, now, matched ? "matched" : "not_matched", {
        value: { required_ms: requiredMs, elapsed_ms: elapsedMs, child_matched: child.matched },
      }),
      ...child.evidence,
    ],
    warnings: child.warnings,
  };
}

function artifactIdentity(snapshot: PredicateArtifactSnapshot): ArtifactIdentity {
  return {
    exists: snapshot.exists,
    path: snapshot.path,
    ...(snapshot.mtime_ms !== undefined ? { mtime_ms: snapshot.mtime_ms } : {}),
    ...(snapshot.size !== undefined ? { size: snapshot.size } : {}),
    ...(snapshot.sha256 !== undefined ? { sha256: snapshot.sha256 } : {}),
  };
}

function singleEvidenceEvaluation(
  predicate: PredicateV1,
  now: Date,
  matched: boolean,
  input: {
    source: string;
    locator: string;
    status: PredicateEvidenceStatus;
    detail?: string | undefined;
    cursor?: string | undefined;
    value?: unknown;
    fingerprint_value?: unknown;
  },
): Promise<NodeEvaluation> {
  return Promise.resolve(singleEvidenceEvaluationSync(predicate, now, matched, input));
}

function singleEvidenceEvaluationSync(
  predicate: PredicateV1,
  now: Date,
  matched: boolean,
  input: {
    source: string;
    locator: string;
    status: PredicateEvidenceStatus;
    detail?: string | undefined;
    cursor?: string | undefined;
    value?: unknown;
    fingerprint_value?: unknown;
  },
): NodeEvaluation {
  const value = input.value ?? null;
  const fingerprintValue = input.fingerprint_value ?? value;
  return {
    matched,
    fingerprint: hashJson({ kind: predicate.kind, locator: input.locator, value: fingerprintValue }),
    cursor: {},
    evidence: [
      evidence(predicate.kind, input.source, input.locator, now, input.status, {
        ...(input.detail ? { detail: input.detail } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        value,
      }),
    ],
    warnings: [],
  };
}

function evidence(
  kind: PredicateKindV1,
  source: string,
  locator: string,
  now: Date,
  status: PredicateEvidenceStatus,
  extras: { detail?: string | undefined; cursor?: string | undefined; value?: unknown } = {},
): PredicateEvidenceRecord {
  return {
    schema_version: "predicate-evidence/v1",
    kind,
    source,
    locator,
    observed_at: now.toISOString(),
    status,
    ...(extras.detail ? { detail: extras.detail } : {}),
    ...(extras.cursor ? { cursor: extras.cursor } : {}),
    ...("value" in extras ? { value: extras.value } : {}),
  };
}

function cronMatches(expr: string, now: Date): { ok: true; matched: boolean } | { ok: false; error: string } {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { ok: false, error: "time.cron expects a 5-field cron expression" };
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return { ok: false, error: "time.cron contains an empty field" };
  }
  const checks = [
    cronFieldMatches(minute, now.getUTCMinutes(), 0, 59),
    cronFieldMatches(hour, now.getUTCHours(), 0, 23),
    cronFieldMatches(dayOfMonth, now.getUTCDate(), 1, 31),
    cronFieldMatches(month, now.getUTCMonth() + 1, 1, 12),
    cronFieldMatches(dayOfWeek, now.getUTCDay(), 0, 7),
  ];
  const error = checks.find((check): check is { ok: false; error: string } => !check.ok);
  if (error) return error;
  return { ok: true, matched: checks.every((check) => check.ok && check.matched) };
}

function cronFieldMatches(
  field: string,
  value: number,
  min: number,
  max: number,
): { ok: true; matched: boolean } | { ok: false; error: string } {
  if (field === "*") return { ok: true, matched: true };
  if (field.startsWith("*/")) {
    const step = Number(field.slice(2));
    if (!Number.isInteger(step) || step <= 0) {
      return { ok: false, error: `invalid cron step "${field}"` };
    }
    return { ok: true, matched: value % step === 0 };
  }
  const values = field.split(",").map((part) => Number(part));
  if (values.some((part) => !Number.isInteger(part) || part < min || part > max)) {
    return { ok: false, error: `invalid cron field "${field}"` };
  }
  return { ok: true, matched: values.includes(value) || (max === 7 && value === 0 && values.includes(7)) };
}

function monitorDeliveryId(wakeId: string, bindingId: string): string {
  return `delivery_${hashJson({ wake_id: wakeId, binding_id: bindingId }).slice(0, 24)}`;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child !== undefined) {
        out[key] = stableValue(child);
      }
    }
    return out;
  }
  return value;
}
