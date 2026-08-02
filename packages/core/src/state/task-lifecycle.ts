import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  TaskInstallTargetStatus,
  TaskManifest,
  TaskRenderPreflightReceipt,
  TaskRuntimeBackend,
  TaskTrigger,
} from "../types";
import { preflightCodexTaskRender, TaskRenderError } from "../tasks";
import type { StateDriverDatabase } from "./driver";
import {
  PREDICATE_SCHEMA_VERSION,
  type PredicateEvaluationResult,
  type PredicateV1,
} from "./monitors";
import { TASK_TABLES } from "./migrations";

export const TASK_INSTALL_SCHEMA_VERSION = "calyx.task-install/v1";
export const TASK_RUN_SCHEMA_VERSION = "calyx.task-run/v1";
export const TASK_LAUNCH_POLICY_SCHEMA_VERSION = "calyx.task-launch-policy/v1";
export const TASK_RUN_JSONL_RELATIVE_PATH = "receipts/task-runs.jsonl";

export const TASK_INSTALL_STATUSES = [
  "active",
  "paused",
  "retired",
  "failed_needs_attention",
] as const;
export type TaskInstallStatus = (typeof TASK_INSTALL_STATUSES)[number];

export const TASK_RUN_STATUSES = [
  "planned",
  "launch_intent_recorded",
  "launched",
  "succeeded",
  "failed",
] as const;
export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number];

export const TASK_TRIGGER_KINDS = ["manual", "predicate"] as const;
export type TaskRunTriggerKind = (typeof TASK_TRIGGER_KINDS)[number];

export const TASK_LAUNCH_MODES = ["advisory", "mutating"] as const;
export type TaskLaunchMode = (typeof TASK_LAUNCH_MODES)[number];

export type TaskFindingSeverity = "info" | "warn" | "error";

export interface TaskFinding {
  code: string;
  severity: TaskFindingSeverity;
  message: string;
  task_id?: string | undefined;
  install_id?: string | undefined;
  manifest_path?: string | undefined;
  receipt?: TaskRenderPreflightReceipt | undefined;
}

export interface TaskLaunchPolicyV1 {
  schema_version: typeof TASK_LAUNCH_POLICY_SCHEMA_VERSION;
  runtime_backend: TaskRuntimeBackend;
  host: string;
  mode: TaskLaunchMode;
  prompt: string;
  workspace?: {
    mode?: string | undefined;
    cwd?: string | undefined;
    cwds?: string[] | undefined;
  } | undefined;
  agent?: string | undefined;
  model?: string | undefined;
  reasoning_effort?: string | undefined;
  execution_environment?: string | undefined;
  max_concurrency?: number | undefined;
  timeout_minutes?: number | undefined;
}

export interface TaskInstallRow {
  install_id: string;
  schema_version: typeof TASK_INSTALL_SCHEMA_VERSION;
  status: TaskInstallStatus;
  created_at: string;
  updated_at: string;
  task_id: string;
  host: string;
  owner: string | null;
  installed_by: string;
  manifest_path: string;
  manifest_hash: string;
  task: TaskManifest;
  predicate: PredicateV1;
  launch_policy: TaskLaunchPolicyV1;
  mode: TaskLaunchMode;
  unattended_enabled: boolean;
  app_mutation_enabled: boolean;
  last_evaluated_at: string | null;
  last_match: boolean | null;
  last_transition_hash: string | null;
  last_task_run_id: string | null;
  last_run_id: string | null;
  last_error: string | null;
}

export interface TaskInstallCursorRow {
  install_id: string;
  cursor: Record<string, unknown>;
  updated_at: string;
}

export interface TaskRunRow {
  task_run_id: string;
  schema_version: typeof TASK_RUN_SCHEMA_VERSION;
  task_id: string;
  install_id: string | null;
  trigger_kind: TaskRunTriggerKind;
  status: TaskRunStatus;
  created_at: string;
  updated_at: string;
  run_id: string | null;
  mode: TaskLaunchMode;
  dry_run: boolean;
  launch_policy: TaskLaunchPolicyV1;
  predicate_evaluation: PredicateEvaluationResult | null;
  summary: string;
  receipt_path: string | null;
}

export interface TaskHistoryRow {
  history_id: number;
  install_id: string | null;
  task_id: string;
  task_run_id: string | null;
  occurred_at: string;
  event_type: string;
  detail: string | null;
  payload: unknown;
}

export interface InstallTaskInput {
  task: TaskManifest;
  manifest_path: string;
  host: string;
  installed_by: string;
  status?: TaskInstallStatus | undefined;
  mode?: TaskLaunchMode | undefined;
  unattended_enabled?: boolean | undefined;
  app_mutation_enabled?: boolean | undefined;
  now?: string | undefined;
}

export interface InstallTaskResult {
  install: TaskInstallRow;
  created: boolean;
  findings: TaskFinding[];
}

export interface ListTaskInstallsOptions {
  status?: TaskInstallStatus | "all" | undefined;
  task_id?: string | undefined;
  host?: string | undefined;
  limit?: number | undefined;
}

export interface ListTaskRunsOptions {
  task_id?: string | undefined;
  install_id?: string | undefined;
  status?: TaskRunStatus | "all" | undefined;
  limit?: number | undefined;
}

export interface CreateTaskRunInput {
  task_id: string;
  install_id?: string | null | undefined;
  trigger_kind: TaskRunTriggerKind;
  status?: TaskRunStatus | undefined;
  run_id?: string | null | undefined;
  mode: TaskLaunchMode;
  dry_run?: boolean | undefined;
  launch_policy: TaskLaunchPolicyV1;
  predicate_evaluation?: PredicateEvaluationResult | null | undefined;
  summary: string;
  now?: string | undefined;
}

export interface RecordTaskInstallEvaluationInput {
  install_id: string;
  evaluation: PredicateEvaluationResult;
  task_run_id?: string | null | undefined;
  run_id?: string | null | undefined;
  error?: string | null | undefined;
}

export interface TaskSchemaFinding {
  table: string;
  code: "missing-table" | "missing-column" | "missing-index";
  detail: string;
}

interface RawTaskInstallRow {
  install_id: string;
  schema_version: string;
  status: string;
  created_at: string;
  updated_at: string;
  task_id: string;
  host: string;
  owner: string | null;
  installed_by: string;
  manifest_path: string;
  manifest_hash: string;
  task_json: string;
  predicate_json: string;
  launch_policy_json: string;
  mode: string;
  unattended_enabled: number;
  app_mutation_enabled: number;
  last_evaluated_at: string | null;
  last_match: number | null;
  last_transition_hash: string | null;
  last_task_run_id: string | null;
  last_run_id: string | null;
  last_error: string | null;
}

interface RawTaskRunRow {
  task_run_id: string;
  schema_version: string;
  task_id: string;
  install_id: string | null;
  trigger_kind: string;
  status: string;
  created_at: string;
  updated_at: string;
  run_id: string | null;
  mode: string;
  dry_run: number;
  launch_policy_json: string;
  predicate_evaluation_json: string | null;
  summary: string;
  receipt_path: string | null;
}

interface RawTaskHistoryRow {
  history_id: number | bigint;
  install_id: string | null;
  task_id: string;
  task_run_id: string | null;
  occurred_at: string;
  event_type: string;
  detail: string | null;
  payload_json: string;
}

const SELECT_INSTALL = `SELECT
  install_id, schema_version, status, created_at, updated_at, task_id, host,
  owner, installed_by, manifest_path, manifest_hash, task_json,
  predicate_json, launch_policy_json, mode, unattended_enabled,
  app_mutation_enabled, last_evaluated_at, last_match, last_transition_hash,
  last_task_run_id, last_run_id, last_error
FROM task_installs`;

const SELECT_TASK_RUN = `SELECT
  task_run_id, schema_version, task_id, install_id, trigger_kind, status,
  created_at, updated_at, run_id, mode, dry_run, launch_policy_json,
  predicate_evaluation_json, summary, receipt_path
FROM task_runs`;

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function normalizeRequired(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must be non-empty`);
  }
  return trimmed;
}

function normalizeLimit(limit: number | undefined, fallback = 50, max = 500): number {
  if (limit === undefined) return fallback;
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), max);
}

function assertInstallStatus(status: string): asserts status is TaskInstallStatus {
  if (!(TASK_INSTALL_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`task install status must be one of: ${TASK_INSTALL_STATUSES.join(", ")}`);
  }
}

function assertLaunchMode(mode: string): asserts mode is TaskLaunchMode {
  if (!(TASK_LAUNCH_MODES as readonly string[]).includes(mode)) {
    throw new Error(`task launch mode must be one of: ${TASK_LAUNCH_MODES.join(", ")}`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashTaskManifest(task: TaskManifest): string {
  return createHash("sha256").update(stableJson(task)).digest("hex");
}

export function codexTaskRenderLossFinding(
  task: TaskManifest,
  host: string,
  options: {
    install_id?: string | undefined;
    manifest_path?: string | undefined;
    code?: string | undefined;
    subject?: string | undefined;
  } = {},
): TaskFinding | undefined {
  if (task.runtime.backend !== "codex_app") {
    return undefined;
  }
  const receipt = preflightCodexTaskRender(task, {
    host,
    ...(options.manifest_path ? { manifestPath: options.manifest_path } : {}),
  });
  if (receipt.ok) {
    return undefined;
  }
  const paths = receipt.losses.map((loss) => loss.path).join(", ");
  return {
    code: options.code ?? "tasks.codex-render-loss",
    severity: "error",
    message: `${options.subject ?? `codex_app task ${task.id}`} cannot be represented exactly by Codex automation.toml: ${paths}`,
    task_id: task.id,
    ...(options.install_id ? { install_id: options.install_id } : {}),
    ...(options.manifest_path ? { manifest_path: options.manifest_path } : {}),
    receipt,
  };
}

function assertCodexTaskRenderExact(task: TaskManifest, host: string, manifestPath: string): void {
  const finding = codexTaskRenderLossFinding(task, host, { manifest_path: manifestPath });
  if (finding?.receipt) {
    throw new TaskRenderError(finding.receipt);
  }
}

function installIdFor(taskId: string, host: string): string {
  const safeTask = taskId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const safeHost = host.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return `task_${safeTask}_${safeHost}`;
}

function hydrateInstall(row: RawTaskInstallRow): TaskInstallRow {
  return {
    install_id: row.install_id,
    schema_version: row.schema_version as typeof TASK_INSTALL_SCHEMA_VERSION,
    status: row.status as TaskInstallStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
    task_id: row.task_id,
    host: row.host,
    owner: row.owner,
    installed_by: row.installed_by,
    manifest_path: row.manifest_path,
    manifest_hash: row.manifest_hash,
    task: parseJson(row.task_json) as TaskManifest,
    predicate: parseJson(row.predicate_json) as PredicateV1,
    launch_policy: parseJson(row.launch_policy_json) as TaskLaunchPolicyV1,
    mode: row.mode as TaskLaunchMode,
    unattended_enabled: row.unattended_enabled === 1,
    app_mutation_enabled: row.app_mutation_enabled === 1,
    last_evaluated_at: row.last_evaluated_at,
    last_match: row.last_match === null ? null : row.last_match === 1,
    last_transition_hash: row.last_transition_hash,
    last_task_run_id: row.last_task_run_id,
    last_run_id: row.last_run_id,
    last_error: row.last_error,
  };
}

function hydrateTaskRun(row: RawTaskRunRow): TaskRunRow {
  return {
    task_run_id: row.task_run_id,
    schema_version: row.schema_version as typeof TASK_RUN_SCHEMA_VERSION,
    task_id: row.task_id,
    install_id: row.install_id,
    trigger_kind: row.trigger_kind as TaskRunTriggerKind,
    status: row.status as TaskRunStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
    run_id: row.run_id,
    mode: row.mode as TaskLaunchMode,
    dry_run: row.dry_run === 1,
    launch_policy: parseJson(row.launch_policy_json) as TaskLaunchPolicyV1,
    predicate_evaluation: row.predicate_evaluation_json
      ? parseJson(row.predicate_evaluation_json) as PredicateEvaluationResult
      : null,
    summary: row.summary,
    receipt_path: row.receipt_path,
  };
}

function hydrateHistory(row: RawTaskHistoryRow): TaskHistoryRow {
  return {
    history_id: Number(row.history_id),
    install_id: row.install_id,
    task_id: row.task_id,
    task_run_id: row.task_run_id,
    occurred_at: row.occurred_at,
    event_type: row.event_type,
    detail: row.detail,
    payload: parseJson(row.payload_json),
  };
}

function literalPredicateFromTrigger(trigger: TaskTrigger): PredicateV1 | undefined {
  const candidate = (trigger as Record<string, unknown>)["predicate"];
  if (!isRecord(candidate)) return undefined;
  if (candidate["schema_version"] !== PREDICATE_SCHEMA_VERSION) {
    throw new Error("task trigger predicate must use schema_version predicate/v1");
  }
  if (typeof candidate["kind"] !== "string") {
    throw new Error("task trigger predicate must include a kind");
  }
  return candidate as unknown as PredicateV1;
}

function parseRruleValue(rrule: string): Record<string, string> {
  const stripped = rrule.trim().replace(/^RRULE:/i, "");
  const fields: Record<string, string> = {};
  for (const part of stripped.split(";")) {
    const [rawKey, rawValue] = part.split("=", 2);
    const key = rawKey?.trim().toUpperCase();
    const value = rawValue?.trim();
    if (key && value) {
      fields[key] = value;
    }
  }
  return fields;
}

function cronDow(byday: string | undefined): string {
  if (!byday) return "*";
  const map: Record<string, string> = {
    SU: "0",
    MO: "1",
    TU: "2",
    WE: "3",
    TH: "4",
    FR: "5",
    SA: "6",
  };
  return byday.split(",").map((value) => {
    const day = map[value.trim().toUpperCase()];
    if (!day) {
      throw new Error(`unsupported RRULE BYDAY value for native task install: ${value}`);
    }
    return day;
  }).join(",");
}

function rruleToCronPredicate(trigger: Extract<TaskTrigger, { type: "schedule" }>): PredicateV1 {
  if (!trigger.rrule) {
    throw new Error("task schedule trigger must include rrule or predicate/v1 for native install");
  }
  const fields = parseRruleValue(trigger.rrule);
  const freq = fields["FREQ"];
  const hour = fields["BYHOUR"] ?? "0";
  const minute = fields["BYMINUTE"] ?? "0";
  if (!/^\d{1,2}$/.test(hour) || !/^\d{1,2}$/.test(minute)) {
    throw new Error(`unsupported RRULE time fields for native task install: ${trigger.rrule}`);
  }
  if (freq === "DAILY") {
    return {
      schema_version: PREDICATE_SCHEMA_VERSION,
      kind: "time.cron",
      expr: `${Number(minute)} ${Number(hour)} * * *`,
      ...(trigger.timezone ? { timezone: trigger.timezone } : {}),
    };
  }
  if (freq === "WEEKLY") {
    return {
      schema_version: PREDICATE_SCHEMA_VERSION,
      kind: "time.cron",
      expr: `${Number(minute)} ${Number(hour)} * * ${cronDow(fields["BYDAY"])}`,
      ...(trigger.timezone ? { timezone: trigger.timezone } : {}),
    };
  }
  throw new Error(`unsupported RRULE FREQ for native task install: ${freq ?? "(missing)"}`);
}

export function predicateFromTaskManifest(task: TaskManifest): PredicateV1 {
  for (const trigger of task.triggers) {
    const literal = literalPredicateFromTrigger(trigger);
    if (literal) return literal;
    if (trigger.type === "schedule") {
      return rruleToCronPredicate(trigger);
    }
  }
  throw new Error(`task ${task.id} has no schedule or predicate/v1 trigger for native install`);
}

export function launchPolicyFromTaskManifest(
  task: TaskManifest,
  host: string,
  mode: TaskLaunchMode = "advisory",
): TaskLaunchPolicyV1 {
  const workspace = task.runtime.workspace;
  return {
    schema_version: TASK_LAUNCH_POLICY_SCHEMA_VERSION,
    runtime_backend: task.runtime.backend,
    host,
    mode,
    prompt: task.prompt.body,
    ...(workspace
      ? {
          workspace: {
            ...(workspace.mode ? { mode: workspace.mode } : {}),
            ...(workspace.cwd ? { cwd: workspace.cwd } : {}),
            ...(workspace.cwds ? { cwds: workspace.cwds } : {}),
          },
        }
      : {}),
    ...(task.runtime.agent ? { agent: task.runtime.agent } : {}),
    ...(task.runtime.model ? { model: task.runtime.model } : {}),
    ...(task.runtime.reasoning_effort ? { reasoning_effort: task.runtime.reasoning_effort } : {}),
    ...(task.runtime.execution_environment ? { execution_environment: task.runtime.execution_environment } : {}),
    ...(task.safety?.max_concurrency ? { max_concurrency: task.safety.max_concurrency } : {}),
    ...(task.safety?.timeout_minutes ? { timeout_minutes: task.safety.timeout_minutes } : {}),
  };
}

export function appendTaskHistory(
  db: StateDriverDatabase,
  input: {
    install_id?: string | null | undefined;
    task_id: string;
    task_run_id?: string | null | undefined;
    occurred_at?: string | undefined;
    event_type: string;
    detail?: string | null | undefined;
    payload?: unknown;
  },
): TaskHistoryRow {
  const occurredAt = input.occurred_at ?? nowIso();
  const result = db.prepare(
    `INSERT INTO task_history
       (install_id, task_id, task_run_id, occurred_at, event_type, detail, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.install_id ?? null,
    input.task_id,
    input.task_run_id ?? null,
    occurredAt,
    input.event_type,
    input.detail ?? null,
    JSON.stringify(input.payload ?? {}),
  );
  const historyId = Number(result.lastInsertRowid);
  const row = db.prepare(
    `SELECT history_id, install_id, task_id, task_run_id, occurred_at, event_type, detail, payload_json
     FROM task_history WHERE history_id = ?`,
  ).get(historyId) as RawTaskHistoryRow | undefined;
  if (!row) {
    throw new Error(`task history row ${historyId} was not readable after insert`);
  }
  return hydrateHistory(row);
}

export function installTask(db: StateDriverDatabase, input: InstallTaskInput): InstallTaskResult {
  const host = normalizeRequired("host", input.host);
  const installedBy = normalizeRequired("installed_by", input.installed_by);
  const manifestPath = normalizeRequired("manifest_path", input.manifest_path);
  const status = input.status ?? "paused";
  assertInstallStatus(status);
  const mode = input.mode ?? "advisory";
  assertLaunchMode(mode);
  assertCodexTaskRenderExact(input.task, host, manifestPath);
  const now = input.now ?? nowIso();
  const predicate = predicateFromTaskManifest(input.task);
  const launchPolicy = launchPolicyFromTaskManifest(input.task, host, mode);
  const manifestHash = hashTaskManifest(input.task);
  const installId = installIdFor(input.task.id, host);
  const existing = readTaskInstall(db, installId);

  db.prepare(
    `INSERT INTO task_installs
       (install_id, schema_version, status, created_at, updated_at, task_id, host,
        owner, installed_by, manifest_path, manifest_hash, task_json,
        predicate_json, launch_policy_json, mode, unattended_enabled,
        app_mutation_enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(install_id) DO UPDATE SET
       status = excluded.status,
       updated_at = excluded.updated_at,
       owner = excluded.owner,
       installed_by = excluded.installed_by,
       manifest_path = excluded.manifest_path,
       manifest_hash = excluded.manifest_hash,
       task_json = excluded.task_json,
       predicate_json = excluded.predicate_json,
       launch_policy_json = excluded.launch_policy_json,
       mode = excluded.mode,
       unattended_enabled = excluded.unattended_enabled,
       app_mutation_enabled = excluded.app_mutation_enabled,
       last_error = NULL`,
  ).run(
    installId,
    TASK_INSTALL_SCHEMA_VERSION,
    status,
    existing?.created_at ?? now,
    now,
    input.task.id,
    host,
    input.task.owner ?? null,
    installedBy,
    manifestPath,
    manifestHash,
    JSON.stringify(input.task),
    JSON.stringify(predicate),
    JSON.stringify(launchPolicy),
    mode,
    input.unattended_enabled ? 1 : 0,
    input.app_mutation_enabled ? 1 : 0,
  );

  appendTaskHistory(db, {
    install_id: installId,
    task_id: input.task.id,
    occurred_at: now,
    event_type: existing ? "task.install.updated" : "task.install.created",
    detail: existing ? "task install refreshed from manifest" : "task installed",
    payload: {
      status,
      mode,
      manifest_path: manifestPath,
      manifest_hash: manifestHash,
      unattended_enabled: Boolean(input.unattended_enabled),
      app_mutation_enabled: Boolean(input.app_mutation_enabled),
    },
  });

  const install = readTaskInstall(db, installId);
  if (!install) {
    throw new Error(`task install ${installId} was not readable after insert`);
  }
  const findings: TaskFinding[] = [];
  if (status === "active" && !install.unattended_enabled) {
    findings.push({
      code: "tasks.unattended-disabled",
      severity: "info",
      message: "active install will evaluate triggers but records launch intents only; unattended launch is disabled",
      task_id: install.task_id,
      install_id: install.install_id,
      manifest_path: install.manifest_path,
    });
  }
  if (!install.app_mutation_enabled) {
    findings.push({
      code: "tasks.app-mutation-disabled",
      severity: "info",
      message: "app mutation is disabled for this task install",
      task_id: install.task_id,
      install_id: install.install_id,
      manifest_path: install.manifest_path,
    });
  }
  return { install, created: !existing, findings };
}

export function readTaskInstall(
  db: StateDriverDatabase,
  installId: string,
): TaskInstallRow | undefined {
  const row = db.prepare(`${SELECT_INSTALL} WHERE install_id = ?`).get(installId) as RawTaskInstallRow | undefined;
  return row ? hydrateInstall(row) : undefined;
}

export function findTaskInstall(
  db: StateDriverDatabase,
  taskIdOrInstallId: string,
  host?: string | undefined,
): TaskInstallRow | undefined {
  const exact = readTaskInstall(db, taskIdOrInstallId);
  if (exact) return exact;
  const clauses = ["task_id = ?"];
  const params: unknown[] = [taskIdOrInstallId];
  if (host) {
    clauses.push("host = ?");
    params.push(host);
  }
  const row = db
    .prepare(`${SELECT_INSTALL} WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT 1`)
    .get(...params) as RawTaskInstallRow | undefined;
  return row ? hydrateInstall(row) : undefined;
}

export function listTaskInstalls(
  db: StateDriverDatabase,
  options: ListTaskInstallsOptions = {},
): TaskInstallRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.status && options.status !== "all") {
    clauses.push("status = ?");
    params.push(options.status);
  }
  if (options.task_id) {
    clauses.push("task_id = ?");
    params.push(options.task_id);
  }
  if (options.host) {
    clauses.push("host = ?");
    params.push(options.host);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`${SELECT_INSTALL}${where} ORDER BY updated_at DESC, install_id ASC LIMIT ?`)
    .all(...params, normalizeLimit(options.limit)) as RawTaskInstallRow[];
  return rows.map(hydrateInstall);
}

export function setTaskInstallStatus(
  db: StateDriverDatabase,
  taskIdOrInstallId: string,
  status: TaskInstallStatus,
  options: { host?: string | undefined; actor?: string | undefined; detail?: string | undefined; now?: string | undefined } = {},
): TaskInstallRow | undefined {
  assertInstallStatus(status);
  const existing = findTaskInstall(db, taskIdOrInstallId, options.host);
  if (!existing) return undefined;
  if (status === "active") {
    assertCodexTaskRenderExact(existing.task, existing.host, existing.manifest_path);
  }
  const now = options.now ?? nowIso();
  db.prepare(
    `UPDATE task_installs SET status = ?, updated_at = ? WHERE install_id = ?`,
  ).run(status, now, existing.install_id);
  appendTaskHistory(db, {
    install_id: existing.install_id,
    task_id: existing.task_id,
    occurred_at: now,
    event_type: `task.install.${status}`,
    detail: options.detail ?? `${status} by ${options.actor ?? "operator"}`,
    payload: { previous_status: existing.status, status },
  });
  return readTaskInstall(db, existing.install_id);
}

export function readTaskInstallCursor(
  db: StateDriverDatabase,
  installId: string,
): TaskInstallCursorRow | undefined {
  const row = db
    .prepare(`SELECT install_id, cursor_json, updated_at FROM task_install_cursors WHERE install_id = ?`)
    .get(installId) as { install_id: string; cursor_json: string; updated_at: string } | undefined;
  return row
    ? { install_id: row.install_id, cursor: parseJson(row.cursor_json) as Record<string, unknown>, updated_at: row.updated_at }
    : undefined;
}

export function writeTaskInstallCursor(
  db: StateDriverDatabase,
  installId: string,
  cursor: Record<string, unknown>,
  updatedAt: string,
): TaskInstallCursorRow {
  db.prepare(
    `INSERT INTO task_install_cursors (install_id, cursor_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(install_id) DO UPDATE SET
       cursor_json = excluded.cursor_json,
       updated_at = excluded.updated_at`,
  ).run(installId, JSON.stringify(cursor), updatedAt);
  const row = readTaskInstallCursor(db, installId);
  if (!row) {
    throw new Error(`task install cursor ${installId} was not readable after write`);
  }
  return row;
}

export function recordTaskInstallEvaluation(
  db: StateDriverDatabase,
  input: RecordTaskInstallEvaluationInput,
): TaskInstallRow | undefined {
  const now = input.evaluation.evaluated_at;
  db.prepare(
    `UPDATE task_installs
     SET updated_at = ?,
         last_evaluated_at = ?,
         last_match = ?,
         last_transition_hash = ?,
         last_task_run_id = COALESCE(?, last_task_run_id),
         last_run_id = COALESCE(?, last_run_id),
         last_error = ?
     WHERE install_id = ?`,
  ).run(
    now,
    now,
    input.evaluation.matched ? 1 : 0,
    input.evaluation.transition_hash,
    input.task_run_id ?? null,
    input.run_id ?? null,
    input.error ?? null,
    input.install_id,
  );
  writeTaskInstallCursor(db, input.install_id, input.evaluation.cursor, now);
  appendTaskHistory(db, {
    install_id: input.install_id,
    task_id: readTaskInstall(db, input.install_id)?.task_id ?? input.install_id,
    task_run_id: input.task_run_id ?? null,
    occurred_at: now,
    event_type: input.task_run_id ? "task.trigger.launch_intent" : "task.trigger.evaluated",
    detail: input.evaluation.matched ? "task predicate matched" : "task predicate did not match",
    payload: {
      matched: input.evaluation.matched,
      transition_hash: input.evaluation.transition_hash,
      warnings: input.evaluation.warnings,
    },
  });
  return readTaskInstall(db, input.install_id);
}

export function recordTaskInstallManualRun(
  db: StateDriverDatabase,
  input: {
    install_id: string;
    task_run_id: string;
    run_id: string;
    occurred_at?: string | undefined;
  },
): TaskInstallRow | undefined {
  const install = readTaskInstall(db, input.install_id);
  if (!install) return undefined;
  const occurredAt = input.occurred_at ?? nowIso();
  db.prepare(
    `UPDATE task_installs
     SET updated_at = ?,
         last_task_run_id = ?,
         last_run_id = ?,
         last_error = NULL
     WHERE install_id = ?`,
  ).run(occurredAt, input.task_run_id, input.run_id, input.install_id);
  appendTaskHistory(db, {
    install_id: input.install_id,
    task_id: install.task_id,
    task_run_id: input.task_run_id,
    occurred_at: occurredAt,
    event_type: "task.run.launched",
    detail: `manual task run launched Calyx run ${input.run_id}`,
    payload: { run_id: input.run_id },
  });
  return readTaskInstall(db, input.install_id);
}

export function createTaskRun(
  db: StateDriverDatabase,
  input: CreateTaskRunInput,
): TaskRunRow {
  const taskRunId = `taskrun_${randomUUID()}`;
  const now = input.now ?? nowIso();
  const status = input.status ?? (input.run_id ? "launched" : "planned");
  db.prepare(
    `INSERT INTO task_runs
       (task_run_id, schema_version, task_id, install_id, trigger_kind, status,
        created_at, updated_at, run_id, mode, dry_run, launch_policy_json,
        predicate_evaluation_json, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskRunId,
    TASK_RUN_SCHEMA_VERSION,
    input.task_id,
    input.install_id ?? null,
    input.trigger_kind,
    status,
    now,
    now,
    input.run_id ?? null,
    input.mode,
    input.dry_run ? 1 : 0,
    JSON.stringify(input.launch_policy),
    input.predicate_evaluation ? JSON.stringify(input.predicate_evaluation) : null,
    input.summary,
  );
  appendTaskHistory(db, {
    install_id: input.install_id ?? null,
    task_id: input.task_id,
    task_run_id: taskRunId,
    occurred_at: now,
    event_type: status === "launch_intent_recorded" ? "task.run.launch_intent_recorded" : "task.run.created",
    detail: input.summary,
    payload: {
      trigger_kind: input.trigger_kind,
      status,
      run_id: input.run_id ?? null,
      dry_run: Boolean(input.dry_run),
    },
  });
  const row = readTaskRun(db, taskRunId);
  if (!row) {
    throw new Error(`task run ${taskRunId} was not readable after insert`);
  }
  return row;
}

export function readTaskRun(
  db: StateDriverDatabase,
  taskRunId: string,
): TaskRunRow | undefined {
  const row = db.prepare(`${SELECT_TASK_RUN} WHERE task_run_id = ?`).get(taskRunId) as RawTaskRunRow | undefined;
  return row ? hydrateTaskRun(row) : undefined;
}

export function listTaskRuns(
  db: StateDriverDatabase,
  options: ListTaskRunsOptions = {},
): TaskRunRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.task_id) {
    clauses.push("task_id = ?");
    params.push(options.task_id);
  }
  if (options.install_id) {
    clauses.push("install_id = ?");
    params.push(options.install_id);
  }
  if (options.status && options.status !== "all") {
    clauses.push("status = ?");
    params.push(options.status);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`${SELECT_TASK_RUN}${where} ORDER BY created_at DESC, task_run_id ASC LIMIT ?`)
    .all(...params, normalizeLimit(options.limit)) as RawTaskRunRow[];
  return rows.map(hydrateTaskRun);
}

export function setTaskRunReceiptPath(
  db: StateDriverDatabase,
  taskRunId: string,
  receiptPath: string,
): TaskRunRow | undefined {
  db.prepare(`UPDATE task_runs SET receipt_path = ?, updated_at = ? WHERE task_run_id = ?`)
    .run(receiptPath, nowIso(), taskRunId);
  return readTaskRun(db, taskRunId);
}

export async function appendTaskRunJsonlReceipt(
  stateDir: string,
  taskRun: TaskRunRow,
): Promise<string> {
  const receiptPath = resolve(stateDir, TASK_RUN_JSONL_RELATIVE_PATH);
  await mkdir(dirname(receiptPath), { recursive: true });
  const receiptRun: TaskRunRow = { ...taskRun, receipt_path: receiptPath };
  await appendFile(receiptPath, `${JSON.stringify(receiptRun)}\n`, "utf8");
  return receiptPath;
}

export function listTaskHistory(
  db: StateDriverDatabase,
  taskIdOrInstallId?: string | undefined,
  options: { limit?: number | undefined } = {},
): TaskHistoryRow[] {
  const limit = normalizeLimit(options.limit);
  const rows = taskIdOrInstallId
    ? db.prepare(
      `SELECT history_id, install_id, task_id, task_run_id, occurred_at, event_type, detail, payload_json
       FROM task_history
       WHERE install_id = ? OR task_id = ?
       ORDER BY occurred_at DESC, history_id DESC
       LIMIT ?`,
    ).all(taskIdOrInstallId, taskIdOrInstallId, limit) as RawTaskHistoryRow[]
    : db.prepare(
      `SELECT history_id, install_id, task_id, task_run_id, occurred_at, event_type, detail, payload_json
       FROM task_history
       ORDER BY occurred_at DESC, history_id DESC
       LIMIT ?`,
    ).all(limit) as RawTaskHistoryRow[];
  return rows.map(hydrateHistory);
}

export function reconcileTaskInstall(
  db: StateDriverDatabase,
  install: TaskInstallRow,
  task: TaskManifest | undefined,
  manifestPath: string | undefined,
): TaskFinding[] {
  const findings: TaskFinding[] = [];
  const installedLoss = codexTaskRenderLossFinding(install.task, install.host, {
    install_id: install.install_id,
    manifest_path: install.manifest_path,
    subject: `installed codex_app task ${install.task_id}`,
  });
  if (installedLoss) {
    findings.push(installedLoss);
  }
  if (!task) {
    findings.unshift({
      code: "tasks.manifest-missing",
      severity: "error",
      message: `installed task ${install.task_id} is missing from the current tasks directory`,
      task_id: install.task_id,
      install_id: install.install_id,
      manifest_path: install.manifest_path,
    });
    return findings;
  }
  const nextHash = hashTaskManifest(task);
  if (nextHash !== install.manifest_hash) {
    const currentLoss = codexTaskRenderLossFinding(task, install.host, {
      install_id: install.install_id,
      manifest_path: manifestPath,
      code: "tasks.current-codex-render-loss",
      subject: `current codex_app task manifest ${install.task_id}`,
    });
    if (currentLoss) {
      findings.push(currentLoss);
    }
  }
  if (nextHash !== install.manifest_hash) {
    findings.push({
      code: "tasks.manifest-drift",
      severity: "warn",
      message: `installed task ${install.task_id} manifest hash differs from current manifest`,
      task_id: install.task_id,
      install_id: install.install_id,
      manifest_path: manifestPath,
    });
  }
  if (task.runtime.backend !== install.launch_policy.runtime_backend) {
    findings.push({
      code: "tasks.runtime-backend-drift",
      severity: "warn",
      message: `installed task ${install.task_id} runtime backend differs from current manifest`,
      task_id: install.task_id,
      install_id: install.install_id,
      manifest_path: manifestPath,
    });
  }
  if (install.status === "active" && !install.unattended_enabled) {
    findings.push({
      code: "tasks.unattended-disabled",
      severity: "info",
      message: "active install evaluates triggers but records launch intents only; unattended launch is disabled",
      task_id: install.task_id,
      install_id: install.install_id,
      manifest_path: manifestPath,
    });
  }
  if (!install.app_mutation_enabled) {
    findings.push({
      code: "tasks.app-mutation-disabled",
      severity: "info",
      message: "app mutation is disabled",
      task_id: install.task_id,
      install_id: install.install_id,
      manifest_path: manifestPath,
    });
  }
  return findings;
}

export function countTaskInstalls(db: StateDriverDatabase): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM task_installs`).get() as { n: number | bigint };
  return Number(row.n);
}

export function countTaskRuns(db: StateDriverDatabase): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM task_runs`).get() as { n: number | bigint };
  return Number(row.n);
}

export function countTaskInstallsByStatus(db: StateDriverDatabase): Record<TaskInstallStatus, number> {
  const counts: Record<TaskInstallStatus, number> = {
    active: 0,
    paused: 0,
    retired: 0,
    failed_needs_attention: 0,
  };
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM task_installs GROUP BY status`)
    .all() as Array<{ status: string; n: number | bigint }>;
  for (const row of rows) {
    if ((TASK_INSTALL_STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status as TaskInstallStatus] = Number(row.n);
    }
  }
  return counts;
}

export function checkTaskSchema(
  db: StateDriverDatabase,
): { status: "ok" | "drift"; findings: TaskSchemaFinding[] } {
  const findings: TaskSchemaFinding[] = [];
  for (const expected of TASK_TABLES) {
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

export function taskStatusToInstallStatus(status: TaskInstallTargetStatus | undefined): TaskInstallStatus {
  if (status === "retired") return "retired";
  if (status === "draft") return "paused";
  if (status === "active" || status === "paused") return status;
  return "paused";
}
