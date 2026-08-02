import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { OrchestrationEventRow, StateDriverDatabase } from "@polli-labs/calyx-core";
import type { RunRecord } from "./types.js";
import { DaemonStore, defaultDaemonsRoot } from "./daemon-store.js";
import { isTerminalState } from "./store.js";
import type {
  DaemonActivityResolver,
  DaemonDescriptor,
  DaemonEvent,
  DaemonHandoffReceipt,
  DaemonPlanActiveRun,
  DaemonPlanIssueSummary,
  DaemonPlanResult,
  DaemonPlanVerdict,
  DaemonPlanWarning,
  DaemonReconciliationFlag,
  DaemonRecord,
  DaemonStartResult,
  DaemonStatus,
  DaemonTickOptions,
  DaemonTickResult,
  DaemonStateSnapshot,
  IssueRuntimeRecord,
  RunIntent,
  TrackerClaimResult,
  TrackerClient,
  TrackerHandoffResult,
  TrackerIssue,
  TrackerPollResult,
  TrackerRegistry,
  WorkflowFile,
} from "./types.js";
import { loadWorkflowFile, renderWorkflowPrompt } from "./workflow.js";
import { RunService } from "./service.js";
import { DaemonLedger } from "./daemon-ledger.js";

const execFile = promisify(execFileCallback);

type ExecResult = { code: number; stdout: string; stderr: string };
type ExecFn = (cmd: string, args: string[], options?: { cwd?: string | undefined }) => Promise<ExecResult>;

interface WorkspaceBinding {
  workspace_key: string;
  workspace_path: string;
  branch_name: string;
  created: boolean;
}

interface CandidateIssue {
  issue: TrackerIssue;
  reason: "new" | "continuation" | "retry" | "external_update";
  record?: IssueRuntimeRecord | undefined;
}

interface ActiveRunHandle {
  daemonId: string;
  workflowPath: string;
  issueIdentifier: string;
  runId: string;
  promise: Promise<void>;
}

export interface DaemonServiceOptions {
  trackerRegistry: TrackerRegistry;
  runService: RunService;
  daemonsRoot?: string | undefined;
  /**
   * Wave 3 orchestration ledger handle. When set, the daemon mirrors
   * claim/launch/terminal/handoff facts into the SQLite ledger so
   * restart recovery does not rely solely on the daemon file store.
   * Unit tests may omit this; production wires it from openStateStore.
   */
  stateDb?: StateDriverDatabase | undefined;
  /** Host alias attached to ledger events. */
  host?: string | undefined;
  /**
   * Resolver used to build the v0 handoff receipt payload. When omitted,
   * the daemon emits handoff receipts with an explicit missing-activity
   * reason instead of a resolved activity_id.
   */
  activityResolver?: DaemonActivityResolver | undefined;
  /** Default claim lock TTL in ms (defaults to one hour). */
  claimLockTtlMs?: number | undefined;
}

export interface DaemonServiceDependencies {
  now?: (() => string) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  exec?: ExecFn | undefined;
}

const DEFAULT_CLAIM_LOCK_TTL_MS = 60 * 60 * 1000;

function nowIso(now: () => string): string {
  return now();
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultExec(
  cmd: string,
  args: string[],
  options: { cwd?: string | undefined } = {},
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFile(cmd, args, {
      cwd: options.cwd,
      env: process.env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const typed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof typed.code === "number" ? typed.code : 1,
      stdout: typed.stdout ?? "",
      stderr: typed.stderr ?? "",
    };
  }
}

function addSeconds(timestamp: string, seconds: number): string {
  return new Date(new Date(timestamp).getTime() + seconds * 1000).toISOString();
}

function sanitizeWorkspaceKey(identifier: string): string {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "issue";
}

function pathWithin(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function renderInlineTemplate(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{{{${key}}}}`, value);
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

function createDescriptor(daemonId: string, workflowPath: string, now: string): DaemonDescriptor {
  return {
    schema_version: "1.0",
    daemon_id: daemonId,
    workflow_path: workflowPath,
    created_at: now,
  };
}

function createDaemonRecord(
  daemonId: string,
  workflowPath: string,
  now: string,
  status: DaemonStatus = "idle",
): DaemonRecord {
  return {
    schema_version: "1.0",
    daemon_id: daemonId,
    workflow_path: workflowPath,
    status,
    created_at: now,
    updated_at: now,
    claimed_issues: 0,
    active_runs: 0,
    ...(status === "running" ? { started_at: now } : {}),
  };
}

function createStateSnapshot(daemonId: string, workflowPath: string, now: string): DaemonStateSnapshot {
  return {
    schema_version: "1.0",
    daemon_id: daemonId,
    workflow_path: workflowPath,
    current_interval_seconds: 0,
    active_run_ids: [],
    issues: {},
    last_tick_at: now,
  };
}

function normalizeStateSnapshot(state: DaemonStateSnapshot): DaemonStateSnapshot {
  const active_run_ids = Object.values(state.issues)
    .map((issue) => issue.active_run_id)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort();
  return {
    ...state,
    active_run_ids,
  };
}

function summarizeRecord(
  daemonId: string,
  workflowPath: string,
  status: DaemonStatus,
  state: DaemonStateSnapshot,
  existing?: DaemonRecord | undefined,
): DaemonRecord {
  const updated_at = new Date().toISOString();
  const claimedIssues = Object.values(state.issues).filter((issue) => issue.claim_status === "claimed").length;
  return {
    schema_version: "1.0",
    daemon_id: daemonId,
    workflow_path: workflowPath,
    status,
    created_at: existing?.created_at ?? updated_at,
    updated_at,
    ...(existing?.started_at ? { started_at: existing.started_at } : {}),
    ...(existing?.stopped_at ? { stopped_at: existing.stopped_at } : {}),
    ...(existing?.pid ? { pid: existing.pid } : {}),
    claimed_issues: claimedIssues,
    active_runs: state.active_run_ids.length,
    ...(state.last_tick_at ? { last_tick_at: state.last_tick_at } : {}),
    ...(state.last_tracker_sync_at ? { last_tracker_sync_at: state.last_tracker_sync_at } : {}),
    ...(state.next_poll_at ? { next_poll_at: state.next_poll_at } : {}),
    ...(state.last_error ? { last_error: state.last_error } : {}),
  };
}

function isIssueTerminal(issue: TrackerIssue, workflow: WorkflowFile): boolean {
  const terminalNames = new Set(workflow.config.tracker.terminal_states.map((value) => value.toLowerCase()));
  if (terminalNames.has(issue.state.name.toLowerCase())) {
    return true;
  }
  const stateType = issue.state.type?.toLowerCase();
  return stateType === "completed" || stateType === "canceled";
}

function isIssueEligible(issue: TrackerIssue, workflow: WorkflowFile): boolean {
  if (isIssueTerminal(issue, workflow)) {
    return false;
  }
  const activeNames = new Set(workflow.config.tracker.active_states.map((value) => value.toLowerCase()));
  if (!activeNames.has(issue.state.name.toLowerCase())) {
    return false;
  }
  const labels = new Set(issue.labels.map((value) => value.toLowerCase()));
  const includeLabels = workflow.config.tracker.include_labels?.map((value) => value.toLowerCase()) ?? [];
  const excludeLabels = workflow.config.tracker.exclude_labels?.map((value) => value.toLowerCase()) ?? [];
  if (includeLabels.length > 0 && !includeLabels.some((value) => labels.has(value))) {
    return false;
  }
  if (excludeLabels.some((value) => labels.has(value))) {
    return false;
  }
  return true;
}

function issueIneligibilityReason(issue: TrackerIssue, workflow: WorkflowFile): string | undefined {
  if (isIssueTerminal(issue, workflow)) {
    return "terminal_state";
  }
  const activeNames = new Set(workflow.config.tracker.active_states.map((value) => value.toLowerCase()));
  if (!activeNames.has(issue.state.name.toLowerCase())) {
    return "inactive_state";
  }
  const labels = new Set(issue.labels.map((value) => value.toLowerCase()));
  const includeLabels = workflow.config.tracker.include_labels?.map((value) => value.toLowerCase()) ?? [];
  const excludeLabels = workflow.config.tracker.exclude_labels?.map((value) => value.toLowerCase()) ?? [];
  if (includeLabels.length > 0 && !includeLabels.some((value) => labels.has(value))) {
    return "missing_include_label";
  }
  if (excludeLabels.some((value) => labels.has(value))) {
    return "excluded_label";
  }
  return undefined;
}

function isContinuationRun(record: RunRecord): boolean {
  if (record.state !== "partial") {
    return false;
  }
  const partialReason = record.kernel_receipt?.exit.partial_reason;
  return partialReason === "max_turns";
}

function isRetriableFailure(record: RunRecord): boolean {
  return record.state === "failed" || record.state === "infra_error" || record.state === "cancelled";
}

function extractBackendSessionId(record: RunRecord): string | undefined {
  const fromRecovery = record.recovery.checkpoint?.backend_session_id;
  if (fromRecovery) {
    return fromRecovery;
  }
  const kernel = record.kernel_receipt;
  if (kernel && "backend_session" in kernel && kernel.backend_session?.id) {
    return kernel.backend_session.id;
  }
  return undefined;
}

function extractBackendThreadId(record: RunRecord): string | undefined {
  return record.recovery.checkpoint?.backend_thread_id;
}

function looksTerminalAssistantMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }
  const normalized = message.toLowerCase();
  const patterns = [
    /\bready[_ -]for[_ -]review\b/,
    /\bready[_ -]for[_ -]handoff\b/,
    /\bhandoff[_ -](?:complete|posted|ready)\b/,
    /\bready for review\b/,
    /\bcompleted\b/,
    /\bfinished\b/,
    /\ball done\b/,
    /\bblocked\b/,
    /\bneed[s]? user input\b/,
    /\bcan't continue\b/,
    /\bcannot continue\b/,
    /\bwaiting on\b/,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

function backoffSeconds(workflow: WorkflowFile, retryCount: number): number {
  const base = workflow.config.polling.failure_backoff_seconds;
  const cap = workflow.config.polling.max_failure_backoff_seconds;
  return Math.min(base * Math.max(1, 2 ** Math.max(retryCount - 1, 0)), cap);
}

function retryLimitReached(workflow: WorkflowFile, retryCount: number): boolean {
  return retryCount > workflow.config.polling.max_retries;
}

/**
 * Liveness check used by the stall guard. A run is considered live when its
 * health snapshot is `healthy`, or when the snapshot recorded any progress
 * or activity within the stall timeout window. This intentionally trusts
 * agent-runner liveness facts (POL-1389 / POL-1390) over wall-clock age.
 */
function isRunHealthLive(record: RunRecord, nowMs: number, stallTimeoutSeconds: number): boolean {
  const health = record.health;
  if (!health) {
    return false;
  }
  if (health.status === "healthy") {
    return true;
  }
  const windowMs = stallTimeoutSeconds * 1000;
  const candidates: Array<string | undefined> = [
    health.last_progress_at,
    health.last_activity_at,
    health.checked_at,
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed) && nowMs - parsed < windowMs) {
      return true;
    }
  }
  return false;
}

function eventPayloadRunId(event: OrchestrationEventRow): string | undefined {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const runId = (payload as { run_id?: unknown }).run_id;
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

function latestLaunchedRunId(events: OrchestrationEventRow[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.event_type !== "issue.launched") {
      continue;
    }
    const runId = eventPayloadRunId(event);
    if (runId) {
      return runId;
    }
  }
  return undefined;
}

function isRunFinalizedInIssueRecord(issue: IssueRuntimeRecord, runId: string): boolean {
  return issue.last_run_id === runId
    && typeof issue.last_run_state === "string"
    && typeof issue.last_run_completed_at === "string";
}

function finalizedIssueStatus(
  issue: IssueRuntimeRecord,
): "released" | "waiting_continuation" | "waiting_retry" | "waiting_external" {
  if (
    issue.status === "released"
    || issue.status === "waiting_continuation"
    || issue.status === "waiting_retry"
    || issue.status === "waiting_external"
  ) {
    return issue.status;
  }
  return "waiting_external";
}

const MAX_HANDOFF_COMMENT_LENGTH = 4000;

function workflowHash(workflow: WorkflowFile): string {
  return createHash("sha256")
    .update(JSON.stringify({
      path: workflow.path,
      frontmatter: workflow.raw_frontmatter,
      prompt_template: workflow.prompt_template,
    }))
    .digest("hex");
}

function issueSummary(issue: TrackerIssue, reason: string, runId?: string | undefined): DaemonPlanIssueSummary {
  return {
    issue_id: issue.id,
    issue_identifier: issue.identifier,
    title: issue.title,
    state_name: issue.state.name,
    ...(issue.state.type ? { state_type: issue.state.type } : {}),
    labels: [...issue.labels],
    reason,
    updated_at: issue.updated_at,
    ...(runId ? { run_id: runId } : {}),
  };
}

function issueRecordSummary(record: IssueRuntimeRecord, reason: string): DaemonPlanIssueSummary {
  return {
    issue_id: record.issue_id,
    issue_identifier: record.issue_identifier,
    title: record.title,
    state_name: record.state_name,
    ...(record.state_type ? { state_type: record.state_type } : {}),
    labels: [],
    reason,
    updated_at: record.tracker_updated_at,
    ...(record.active_run_id ? { run_id: record.active_run_id } : {}),
  };
}

function inReviewHandoffPolicy(workflow: WorkflowFile): boolean {
  return workflow.config.tracker.handoff_state.trim().toLowerCase() !== "done"
    || workflow.config.workflow_policy.allow_done_handoff;
}

export function renderHandoffComment(receipt: DaemonHandoffReceipt): string {
  const lines = [
    `Calyx Symphony daemon ${receipt.daemon_id} handoff receipt`,
    `- workflow_path: ${receipt.workflow_path}`,
    `- issue: ${receipt.issue_identifier} (${receipt.issue_id})`,
    `- run_id: ${receipt.run_id}`,
    ...(receipt.worktree_path ? [`- worktree: ${receipt.worktree_path}`] : []),
    ...(receipt.branch ? [`- branch: ${receipt.branch}`] : []),
    `- handoff_state: ${receipt.handoff.target_state}`,
    `- run_state: ${receipt.run_state}`,
    receipt.activity_id
      ? `- activity_id: ${receipt.activity_id}`
      : `- activity: missing (${receipt.activity_missing_reason ?? "unknown"})`,
    ...(receipt.latest_assistant_turn_id
      ? [`- latest_assistant_turn_id: ${receipt.latest_assistant_turn_id}`]
      : []),
    ...(receipt.ledger_cursor ? [`- ledger_cursor: ${receipt.ledger_cursor}`] : []),
    ...(receipt.transitions.claimed_at ? [`- claimed_at: ${receipt.transitions.claimed_at}`] : []),
    ...(receipt.transitions.launched_at ? [`- launched_at: ${receipt.transitions.launched_at}`] : []),
    ...(receipt.transitions.terminal_at ? [`- terminal_at: ${receipt.transitions.terminal_at}`] : []),
    ...(receipt.transitions.handoff_at ? [`- handoff_at: ${receipt.transitions.handoff_at}`] : []),
    ...(receipt.activity_id
      ? [`- operator surface: calyx activity turns run:${receipt.run_id}`]
      : []),
    `- stop_condition_review: ${receipt.stop_condition_review.status} (${receipt.stop_condition_review.summary})`,
    ...(receipt.warnings.length > 0
      ? [`- warnings: ${receipt.warnings.map((warning) => warning.code).join(", ")}`]
      : []),
    "",
    receipt.summary,
  ];
  const body = lines.join("\n");
  return body.length > MAX_HANDOFF_COMMENT_LENGTH
    ? `${body.slice(0, MAX_HANDOFF_COMMENT_LENGTH - 1)}…`
    : body;
}

export class DaemonService {
  readonly store: DaemonStore;
  readonly ledger: DaemonLedger | undefined;
  private readonly now: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly exec: ExecFn;
  private readonly activeRuns = new Map<string, ActiveRunHandle>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly claimLockTtlMs: number;

  constructor(
    private readonly options: DaemonServiceOptions,
    deps: DaemonServiceDependencies = {},
  ) {
    this.store = new DaemonStore(options.daemonsRoot ?? defaultDaemonsRoot());
    this.now = deps.now ?? (() => new Date().toISOString());
    this.sleep = deps.sleep ?? sleepMs;
    this.exec = deps.exec ?? defaultExec;
    this.ledger = options.stateDb ? new DaemonLedger(options.stateDb, options.host) : undefined;
    this.claimLockTtlMs = options.claimLockTtlMs ?? DEFAULT_CLAIM_LOCK_TTL_MS;
  }

  private recordLedgerEvent(args: {
    daemonId: string;
    issue: TrackerIssue | IssueRuntimeRecord;
    eventType: "issue.claimed" | "issue.launched" | "issue.terminal" | "issue.handoff";
    occurredAt: string;
    payload: Record<string, unknown>;
  }): string | undefined {
    if (!this.ledger) {
      return undefined;
    }
    const identifier = "identifier" in args.issue ? args.issue.identifier : args.issue.issue_identifier;
    const issueId = "id" in args.issue ? args.issue.id : args.issue.issue_id;
    const event = this.ledger.recordEvent({
      daemonId: args.daemonId,
      issueIdentifier: identifier,
      issueId,
      eventType: args.eventType,
      occurredAt: args.occurredAt,
      ...(this.options.host ? { host: this.options.host } : {}),
      payload: args.payload,
    });
    return event.cursor;
  }

  private async mutateDaemon<T>(
    daemonId: string,
    workflowPath: string,
    mutate: (args: {
      state: DaemonStateSnapshot;
      record: DaemonRecord;
    }) =>
      | Promise<{ state?: DaemonStateSnapshot | undefined; record?: DaemonRecord | undefined; result?: T | undefined }>
      | { state?: DaemonStateSnapshot | undefined; record?: DaemonRecord | undefined; result?: T | undefined },
  ): Promise<T | undefined> {
    let resultValue: T | undefined;
    const run = async (): Promise<void> => {
      await this.store.ensureRoot();
      await this.store.ensureDaemonRoot(daemonId);
      const now = nowIso(this.now);
      const state = (await this.store.readStateSnapshot(daemonId)) ?? createStateSnapshot(daemonId, workflowPath, now);
      const record = (await this.store.readDaemonRecord(daemonId)) ?? createDaemonRecord(daemonId, workflowPath, now);
      const mutated = await mutate({ state, record });
      const nextState = normalizeStateSnapshot(mutated.state ?? state);
      const nextRecord = mutated.record ?? summarizeRecord(daemonId, workflowPath, record.status, nextState, record);
      await this.store.writeStateSnapshot(daemonId, nextState);
      await this.store.writeDaemonRecord(daemonId, nextRecord);
      resultValue = mutated.result;
    };

    this.mutationQueue = this.mutationQueue.then(run, run);
    await this.mutationQueue;
    return resultValue;
  }

  private async appendEvent(
    daemonId: string,
    level: DaemonEvent["level"],
    event: string,
    message: string,
    payload?: Record<string, unknown> | undefined,
  ): Promise<void> {
    await this.store.appendEvent(daemonId, {
      timestamp: nowIso(this.now),
      daemon_id: daemonId,
      level,
      event,
      message,
      ...(payload ? { payload } : {}),
    });
  }

  private hasInMemoryActiveRun(daemonId: string, runId: string): boolean {
    const handle = this.activeRuns.get(runId);
    return handle?.daemonId === daemonId;
  }

  private async clearMissingActiveRun(args: {
    daemonId: string;
    workflowPath: string;
    workflow: WorkflowFile;
    issueRecord: IssueRuntimeRecord;
  }): Promise<IssueRuntimeRecord | undefined> {
    const staleRunId = args.issueRecord.active_run_id;
    if (!staleRunId) {
      return args.issueRecord;
    }
    const retryCount = args.issueRecord.retry_count + 1;
    const retryExhausted = retryLimitReached(args.workflow, retryCount);
    const nextStatus = retryExhausted ? "waiting_external" : "waiting_retry";
    const updated = await this.updateIssueRecord(
      args.daemonId,
      args.workflowPath,
      args.issueRecord.issue_identifier,
      (current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          status: nextStatus,
          claim_status: "claimed",
          retry_count: retryCount,
          active_run_id: undefined,
          last_run_id: staleRunId,
          last_error: `Referenced active run ${staleRunId} is missing from the run store.`,
          continuation_due_at: undefined,
          retry_due_at: retryExhausted
            ? undefined
            : addSeconds(nowIso(this.now), backoffSeconds(args.workflow, retryCount)),
        };
      },
    );
    await this.appendEvent(
      args.daemonId,
      "warn",
      "phantom_active_run",
      `Issue ${args.issueRecord.issue_identifier} referenced missing run ${staleRunId}; clearing stale active run.`,
      {
        issue: args.issueRecord.issue_identifier,
        run_id: staleRunId,
        retry_count: retryCount,
        next_status: nextStatus,
      },
    );
    return updated;
  }

  private async ensureInitialized(daemonId: string, workflowPath: string): Promise<void> {
    await this.store.ensureRoot();
    await this.store.ensureDaemonRoot(daemonId);
    const now = nowIso(this.now);
    const descriptor = await this.store.readDescriptor(daemonId);
    if (!descriptor) {
      await this.store.writeDescriptor(daemonId, createDescriptor(daemonId, workflowPath, now));
    }
    const record = await this.store.readDaemonRecord(daemonId);
    if (!record) {
      await this.store.writeDaemonRecord(daemonId, createDaemonRecord(daemonId, workflowPath, now));
    }
    const state = await this.store.readStateSnapshot(daemonId);
    if (!state) {
      await this.store.writeStateSnapshot(daemonId, createStateSnapshot(daemonId, workflowPath, now));
    }
  }

  /**
   * Wave 3 restart reconstruction. After a daemon crashes or is killed,
   * the file-store cache may reflect issues as "running" with an
   * `active_run_id` whose process is gone. We consult both the ledger
   * (canonical claim/launch/terminal/handoff events) and the run store
   * (canonical run-record state) to re-derive each issue's claim/run
   * status without ever re-claiming an issue that already has an open
   * claim or active run.
   */
  async reconcileFromLedger(daemonId: string, workflowPath: string): Promise<{
    reconciled: string[];
    cleared: string[];
    relinked: string[];
  }> {
    if (!this.ledger) {
      return { reconciled: [], cleared: [], relinked: [] };
    }
    await this.ensureInitialized(daemonId, workflowPath);
    const state = await this.store.readStateSnapshot(daemonId);
    if (!state) {
      return { reconciled: [], cleared: [], relinked: [] };
    }
    const reconciled: string[] = [];
    const cleared: string[] = [];
    const relinked: string[] = [];

    for (const issueRecord of Object.values(state.issues)) {
      if (issueRecord.claim_status !== "claimed") {
        continue;
      }
      const events = this.ledger.listIssueEvents({
        daemonId,
        issueIdentifier: issueRecord.issue_identifier,
        limit: 100_000,
      });
      const hasClaim = events.some((event) => event.event_type === "issue.claimed");
      const hasHandoff = events.some((event) => event.event_type === "issue.handoff");
      if (!hasClaim) {
        // No ledger truth — the file cache claim was never durable.
        // Mark released so we do not double-claim on the next tick.
        this.ledger.releaseClaim({
          daemonId,
          issueIdentifier: issueRecord.issue_identifier,
        });
        await this.updateIssueRecord(daemonId, workflowPath, issueRecord.issue_identifier, (current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            claim_status: "released",
            status: "released",
            active_run_id: undefined,
            released_at: nowIso(this.now),
          };
        });
        cleared.push(issueRecord.issue_identifier);
        continue;
      }

      if (hasHandoff) {
        // Already handed off according to the ledger — release locally.
        this.ledger.releaseClaim({
          daemonId,
          issueIdentifier: issueRecord.issue_identifier,
        });
        await this.updateIssueRecord(daemonId, workflowPath, issueRecord.issue_identifier, (current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            claim_status: "released",
            status: "released",
            active_run_id: undefined,
            released_at: nowIso(this.now),
          };
        });
        cleared.push(issueRecord.issue_identifier);
        continue;
      }

      // Claim still open per ledger. Verify the active run from the run
      // store, restoring it from the latest launch event when the file
      // cache missed the run. Terminal runs stay linked so the next tick
      // can finalize handoff through the normal tracker-aware path.
      const activeRunId = issueRecord.active_run_id ?? latestLaunchedRunId(events);
      if (activeRunId) {
        if (!issueRecord.active_run_id && isRunFinalizedInIssueRecord(issueRecord, activeRunId)) {
          reconciled.push(issueRecord.issue_identifier);
          continue;
        }
        const runRecord = await this.options.runService.getRunRecord(activeRunId);
        if (!runRecord) {
          await this.updateIssueRecord(daemonId, workflowPath, issueRecord.issue_identifier, (current) => {
            if (!current) {
              return current;
            }
            return {
              ...current,
              status: "waiting_external",
              claim_status: "claimed",
              active_run_id: undefined,
              last_run_id: activeRunId,
            };
          });
          relinked.push(issueRecord.issue_identifier);
          continue;
        }
        if (issueRecord.active_run_id !== activeRunId || issueRecord.status !== "running") {
          await this.updateIssueRecord(daemonId, workflowPath, issueRecord.issue_identifier, (current) => {
            if (!current) {
              return current;
            }
            return {
              ...current,
              status: "running",
              claim_status: "claimed",
              active_run_id: activeRunId,
              last_run_id: activeRunId,
            };
          });
          relinked.push(issueRecord.issue_identifier);
          continue;
        }
      }
      reconciled.push(issueRecord.issue_identifier);
    }

    if (reconciled.length > 0 || cleared.length > 0 || relinked.length > 0) {
      await this.appendEvent(
        daemonId,
        "info",
        "restart_reconciled",
        `Restart reconciliation reconciled ${reconciled.length}, cleared ${cleared.length}, relinked ${relinked.length} issues from the orchestration ledger.`,
        { reconciled, cleared, relinked },
      );
    }

    return { reconciled, cleared, relinked };
  }

  private async loadWorkflow(daemonId: string, workflowPath: string): Promise<{
    workflow: WorkflowFile;
    fromCache: boolean;
  }> {
    try {
      const workflow = await loadWorkflowFile(workflowPath, { now: this.now });
      await this.store.writeWorkflowSnapshot(daemonId, workflow);
      return { workflow, fromCache: false };
    } catch (error) {
      const cached = await this.store.readWorkflowSnapshot(daemonId);
      if (!cached) {
        throw error;
      }
      await this.appendEvent(
        daemonId,
        "warn",
        "workflow_snapshot_fallback",
        error instanceof Error ? error.message : String(error),
      );
      return { workflow: cached, fromCache: true };
    }
  }

  private async runWorkspaceHook(
    workspaceRoot: string,
    workspacePath: string,
    commands: string[] | undefined,
  ): Promise<void> {
    if (!commands || commands.length === 0) {
      return;
    }
    if (!pathWithin(workspaceRoot, workspacePath)) {
      throw new Error(`Workspace path escapes configured root: ${workspacePath}`);
    }
    for (const command of commands) {
      const result = await this.exec("bash", ["-lc", command], { cwd: workspacePath });
      if (result.code !== 0) {
        throw new Error(`Workspace hook failed (${command}): ${result.stderr || result.stdout || `exit ${result.code}`}`);
      }
    }
  }

  private async ensureWorkspace(
    daemonId: string,
    workflow: WorkflowFile,
    issue: TrackerIssue,
    existing?: IssueRuntimeRecord | undefined,
  ): Promise<WorkspaceBinding> {
    const workspaceKey = existing?.workspace_key ?? sanitizeWorkspaceKey(issue.identifier);
    const workspacePath = existing?.workspace_path
      ?? path.join(workflow.config.workspace.root, workspaceKey);
    const branchName = existing?.branch_name ?? renderInlineTemplate(
      workflow.config.workspace.branch_template,
      {
        identifier: issue.identifier,
        IDENTIFIER: issue.identifier,
        workspace_key: workspaceKey,
        WORKSPACE_KEY: workspaceKey,
      },
    );

    if (!pathWithin(workflow.config.workspace.root, workspacePath)) {
      throw new Error(`Workspace path escapes configured root: ${workspacePath}`);
    }

    try {
      const details = await stat(workspacePath);
      if (!details.isDirectory()) {
        throw new Error(`Existing workspace path is not a directory: ${workspacePath}`);
      }
      return {
        workspace_key: workspaceKey,
        workspace_path: workspacePath,
        branch_name: branchName,
        created: false,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    await mkdir(workflow.config.workspace.root, { recursive: true });
    const showRef = await this.exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
      cwd: workflow.config.workspace.repo_root,
    });

    const addArgs = ["worktree", "add"];
    if (showRef.code === 0) {
      addArgs.push(workspacePath, branchName);
    } else {
      addArgs.push("-b", branchName, workspacePath, workflow.config.workspace.ref);
    }
    const result = await this.exec("git", addArgs, { cwd: workflow.config.workspace.repo_root });
    if (result.code !== 0) {
      throw new Error(`git worktree add failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
    }

    await this.runWorkspaceHook(workflow.config.workspace.root, workspacePath, workflow.config.workspace.after_create);
    await this.appendEvent(
      daemonId,
      "info",
      "workspace_created",
      `Created workspace ${workspacePath} for ${issue.identifier}.`,
      { issue: issue.identifier, branch: branchName },
    );
    return {
      workspace_key: workspaceKey,
      workspace_path: workspacePath,
      branch_name: branchName,
      created: true,
    };
  }

  private async maybeCleanupWorkspace(
    daemonId: string,
    workflow: WorkflowFile,
    issue: IssueRuntimeRecord,
  ): Promise<boolean> {
    const cleanupHours = workflow.config.workspace.cleanup_terminal_after_hours;
    if (!cleanupHours) {
      return false;
    }
    const lastResourceRunId = issue.active_run_id ?? issue.last_run_id;
    if (lastResourceRunId) {
      const lastResourceRun = await this.options.runService.getRunRecord(lastResourceRunId);
      if (!lastResourceRun || !(await this.hasRunResourceTerminalAuthority(lastResourceRun))) {
        return false;
      }
    }
    const since = issue.released_at ?? issue.last_run_completed_at;
    if (!since) {
      return false;
    }
    const dueAt = new Date(since).getTime() + cleanupHours * 60 * 60 * 1000;
    if (Date.now() < dueAt) {
      return false;
    }
    try {
      await stat(issue.workspace_path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
    await this.runWorkspaceHook(workflow.config.workspace.root, issue.workspace_path, workflow.config.workspace.before_remove);
    const removeResult = await this.exec("git", ["worktree", "remove", "--force", issue.workspace_path], {
      cwd: workflow.config.workspace.repo_root,
    });
    if (removeResult.code !== 0) {
      await rm(issue.workspace_path, { recursive: true, force: true });
    }
    await this.appendEvent(
      daemonId,
      "info",
      "workspace_removed",
      `Removed workspace ${issue.workspace_path} for ${issue.issue_identifier}.`,
    );
    return true;
  }

  /**
   * Resource terminality for a current launch is record-local. A synthesized
   * legacy launch is different: its marker-free terminal record is only a
   * projection until RunService proves bound receipt authority. Hooks,
   * handoff, capacity release, and cleanup all consume that single law.
   */
  private async hasRunResourceTerminalAuthority(record: RunRecord): Promise<boolean> {
    try {
      return (await this.options.runService.getResourceTerminalAuthority(record.run_id)) !== undefined;
    } catch {
      return false;
    }
  }

  private buildPromptVariables(args: {
    daemonId: string;
    issue: TrackerIssue;
    workspace: WorkspaceBinding;
    workflow: WorkflowFile;
    runId: string;
    daemonRunKey?: string | undefined;
    backendSessionId?: string | undefined;
    resumeSessionId?: string | undefined;
    lastRunId?: string | undefined;
    turnIndex?: number | undefined;
  }): Record<string, string> {
    const labels = args.issue.labels.join(", ");
    const daemonRunKey = args.daemonRunKey ?? `${args.daemonId}:${args.issue.identifier}`;
    return {
      daemon_id: args.daemonId,
      DAEMON_ID: args.daemonId,
      daemon_run_key: daemonRunKey,
      DAEMON_RUN_KEY: daemonRunKey,
      issue_id: args.issue.id,
      ISSUE_ID: args.issue.id,
      issue_identifier: args.issue.identifier,
      ISSUE_IDENTIFIER: args.issue.identifier,
      issue_title: args.issue.title,
      ISSUE_TITLE: args.issue.title,
      issue_url: args.issue.url ?? "",
      ISSUE_URL: args.issue.url ?? "",
      issue_state: args.issue.state.name,
      ISSUE_STATE: args.issue.state.name,
      issue_state_type: args.issue.state.type ?? "",
      ISSUE_STATE_TYPE: args.issue.state.type ?? "",
      issue_labels: labels,
      ISSUE_LABELS: labels,
      workspace_key: args.workspace.workspace_key,
      WORKSPACE_KEY: args.workspace.workspace_key,
      workspace_path: args.workspace.workspace_path,
      WORKSPACE_PATH: args.workspace.workspace_path,
      worktree_path: args.workspace.workspace_path,
      WORKTREE_PATH: args.workspace.workspace_path,
      branch_name: args.workspace.branch_name,
      BRANCH_NAME: args.workspace.branch_name,
      repo_root: args.workflow.config.workspace.repo_root,
      REPO_ROOT: args.workflow.config.workspace.repo_root,
      run_id: args.runId,
      RUN_ID: args.runId,
      backend_session_id: args.backendSessionId ?? "",
      BACKEND_SESSION_ID: args.backendSessionId ?? "",
      last_run_id: args.lastRunId ?? "",
      LAST_RUN_ID: args.lastRunId ?? "",
      resume_session_id: args.resumeSessionId ?? "",
      RESUME_SESSION_ID: args.resumeSessionId ?? "",
      turn_index: String(args.turnIndex ?? 1),
      TURN_INDEX: String(args.turnIndex ?? 1),
    };
  }

  private createNextTurnInput(args: {
    daemonId: string;
    issue: TrackerIssue;
    workflow: WorkflowFile;
    workspace: WorkspaceBinding;
    currentRunId: string;
    lastRunId?: string | undefined;
    resumeSessionId?: string | undefined;
  }): NonNullable<Parameters<RunService["launch"]>[1]>["nextTurnInput"] {
    return async (context) => {
      if (context.terminal_state !== "succeeded" && context.terminal_state !== "completed_dirty") {
        return null;
      }
      if (looksTerminalAssistantMessage(context.result.agent_terminal_message)) {
        return null;
      }
      const prompt = renderWorkflowPrompt(
        args.workflow,
        this.buildPromptVariables({
          daemonId: args.daemonId,
          issue: args.issue,
          workflow: args.workflow,
          workspace: args.workspace,
          runId: args.currentRunId,
          backendSessionId: context.session_summary.backend_session_id ?? context.session_summary.adapter_session_id,
          lastRunId: args.lastRunId,
          resumeSessionId: args.resumeSessionId,
          turnIndex: context.turn_index + 1,
        }),
      );
      return { prompt };
    };
  }

  private buildRunIntent(args: {
    daemonId: string;
    workflow: WorkflowFile;
    issue: TrackerIssue;
    workspace: WorkspaceBinding;
    reason: CandidateIssue["reason"];
    previous?: IssueRuntimeRecord | undefined;
  }): RunIntent {
    const resumeSessionId = args.previous?.last_backend_session_id;
    const runId = randomUUID();
    const daemonRunKey = `${args.daemonId}:${args.issue.identifier}`;
    const intent = this.options.runService.createIntent({
      run_id: runId,
      host: args.workflow.config.agent.host,
      kernel: "agent_runner",
      issue: args.issue.identifier,
      backend: args.workflow.config.agent.backend,
      ...(args.workflow.config.agent.profile ? { profile: args.workflow.config.agent.profile } : {}),
      prompt: renderWorkflowPrompt(
        args.workflow,
        this.buildPromptVariables({
          daemonId: args.daemonId,
          issue: args.issue,
          workflow: args.workflow,
          workspace: args.workspace,
          runId,
          daemonRunKey,
          lastRunId: args.previous?.last_run_id,
          resumeSessionId,
        }),
      ),
      require_execplan: args.workflow.config.agent.require_execplan,
      pull_execplan: args.workflow.config.agent.pull_execplan,
      max_turns_per_run: args.workflow.config.agent.max_turns_per_run,
      worktree_path: args.workspace.workspace_path,
      branch: args.workspace.branch_name,
      metadata: {
        daemon_id: args.daemonId,
        daemon_issue_id: args.issue.id,
        daemon_issue_identifier: args.issue.identifier,
        daemon_run_key: daemonRunKey,
        daemon_workspace_key: args.workspace.workspace_key,
        daemon_workspace_path: args.workspace.workspace_path,
        daemon_dispatch_reason: args.reason,
      },
      ...(resumeSessionId ? { resume_session_id: resumeSessionId } : {}),
      ...(args.workflow.config.agent.allowed_tools
        || args.workflow.config.agent.dangerously_skip_permissions
        || args.workflow.config.agent.max_threads
        || args.workflow.config.agent.max_turns
        ? {
            backend_options: {
              ...(args.workflow.config.agent.allowed_tools ? { allowed_tools: args.workflow.config.agent.allowed_tools } : {}),
              ...(args.workflow.config.agent.dangerously_skip_permissions
                ? { dangerously_skip_permissions: true }
                : {}),
              ...(typeof args.workflow.config.agent.max_threads === "number"
                ? { max_threads: args.workflow.config.agent.max_threads }
                : {}),
              ...(typeof args.workflow.config.agent.max_turns === "number"
                ? { max_turns: args.workflow.config.agent.max_turns }
                : {}),
            },
          }
        : {}),
    });
    return intent;
  }

  private acquireClaimGuard(
    daemonId: string,
    issue: TrackerIssue | IssueRuntimeRecord,
  ): { acquired: boolean; heldBy?: string | undefined } {
    if (!this.ledger) {
      return { acquired: true };
    }
    const identifier = "identifier" in issue ? issue.identifier : issue.issue_identifier;
    const outcome = this.ledger.acquireClaim({
      daemonId,
      issueIdentifier: identifier,
      ttlMs: this.claimLockTtlMs,
      metadata: {
        issue_identifier: identifier,
        ...(this.options.host ? { host: this.options.host } : {}),
      },
    });
    if (outcome.status === "held") {
      return { acquired: false, heldBy: outcome.holder.owner_id };
    }
    return { acquired: true };
  }

  private async applyTrackerClaim(args: {
    daemonId: string;
    workflow: WorkflowFile;
    tracker: TrackerClient;
    issue: TrackerIssue;
    previous?: IssueRuntimeRecord | undefined;
  }): Promise<TrackerClaimResult | undefined> {
    if (!args.tracker.claimIssue) {
      return undefined;
    }
    const targetState = args.workflow.config.tracker.claim_state;
    const targetLower = targetState.toLowerCase();
    if (args.issue.state.name.toLowerCase() === targetLower) {
      return undefined;
    }
    if (args.previous?.state_name?.toLowerCase() === targetLower) {
      return undefined;
    }
    return args.tracker.claimIssue({ issue: args.issue, target_state: targetState });
  }

  private async applyTrackerHandoff(args: {
    daemonId: string;
    workflow: WorkflowFile;
    tracker: TrackerClient;
    issue: TrackerIssue;
    receipt: DaemonHandoffReceipt;
  }): Promise<TrackerHandoffResult | undefined> {
    if (!args.tracker.handoffIssue) {
      return undefined;
    }
    const targetState = args.workflow.config.tracker.handoff_state;
    const body = renderHandoffComment(args.receipt);
    try {
      return await args.tracker.handoffIssue({
        issue: args.issue,
        target_state: targetState,
        comment_body: body,
      });
    } catch (error) {
      await this.appendEvent(
        args.daemonId,
        "warn",
        "tracker_handoff_failed",
        error instanceof Error ? error.message : String(error),
        { issue: args.issue.identifier },
      );
      return undefined;
    }
  }

  private async resolveHandoffActivity(
    intent: RunIntent,
    record: RunRecord,
  ): Promise<{
    activity_id?: string;
    activity_missing_reason?: string;
    latest_assistant_turn_id?: string;
  }> {
    if (!this.options.activityResolver) {
      return { activity_missing_reason: "no_activity_resolver_configured" };
    }
    try {
      return await this.options.activityResolver.resolve({
        run_id: record.run_id,
        intent,
        record,
      });
    } catch (error) {
      return {
        activity_missing_reason: error instanceof Error
          ? `activity_resolver_error:${error.message}`
          : "activity_resolver_error",
      };
    }
  }

  private buildHandoffReceipt(args: {
    daemonId: string;
    workflow: WorkflowFile;
    issueRecord: IssueRuntimeRecord;
    runRecord: RunRecord;
    intent: RunIntent;
    activity: {
      activity_id?: string;
      activity_missing_reason?: string;
      latest_assistant_turn_id?: string;
    };
    ledgerCursor?: string | undefined;
    occurredAt: string;
    summary: string;
  }): DaemonHandoffReceipt {
    return {
      schema_version: "calyx.daemon.handoff/v1",
      daemon_id: args.daemonId,
      workflow_path: args.workflow.path,
      workflow_hash: workflowHash(args.workflow),
      issue_id: args.issueRecord.issue_id,
      issue_identifier: args.issueRecord.issue_identifier,
      selected_issue: {
        id: args.issueRecord.issue_id,
        identifier: args.issueRecord.issue_identifier,
        title: args.issueRecord.title,
      },
      run_id: args.runRecord.run_id,
      worktree_path: args.intent.worktree_path ?? args.issueRecord.workspace_path,
      branch: args.intent.branch ?? args.issueRecord.branch_name,
      changed_files: [],
      commands: [],
      artifacts: [],
      warnings: args.activity.activity_id
        ? []
        : [{
            code: "missing_activity",
            severity: "warn",
            message: args.activity.activity_missing_reason ?? "No activity id resolved for daemon handoff.",
            issue_identifier: args.issueRecord.issue_identifier,
            run_id: args.runRecord.run_id,
          }],
      stop_condition_review: {
        status: "pending",
        summary: "Conductor review required before marking daemon work Done.",
      },
      handoff: {
        target_state: args.workflow.config.tracker.handoff_state,
        conductor_review_required: args.workflow.config.tracker.handoff_state.trim().toLowerCase() !== "done",
        state: args.workflow.config.tracker.handoff_state.trim().toLowerCase() === "done"
          ? "done_allowed"
          : "ready_for_review",
      },
      ...(args.activity.activity_id ? { activity_id: args.activity.activity_id } : {}),
      ...(args.activity.activity_missing_reason && !args.activity.activity_id
        ? { activity_missing_reason: args.activity.activity_missing_reason }
        : {}),
      ...(args.activity.latest_assistant_turn_id
        ? { latest_assistant_turn_id: args.activity.latest_assistant_turn_id }
        : {}),
      ...(args.ledgerCursor ? { ledger_cursor: args.ledgerCursor } : {}),
      transitions: {
        ...(args.issueRecord.claimed_at ? { claimed_at: args.issueRecord.claimed_at } : {}),
        ...(args.issueRecord.launched_at ? { launched_at: args.issueRecord.launched_at } : {}),
        ...(args.runRecord.completed_at ? { terminal_at: args.runRecord.completed_at } : {}),
        handoff_at: args.occurredAt,
      },
      run_state: args.runRecord.state,
      summary: args.summary,
    };
  }

  private async updateIssueRecord(
    daemonId: string,
    workflowPath: string,
    issueIdentifier: string,
    mutate: (record: IssueRuntimeRecord | undefined) => IssueRuntimeRecord | undefined,
  ): Promise<IssueRuntimeRecord | undefined> {
    return this.mutateDaemon(daemonId, workflowPath, async ({ state, record }) => {
      const current = state.issues[issueIdentifier];
      const nextIssue = mutate(current);
      const nextIssues = { ...state.issues };
      if (nextIssue) {
        nextIssues[issueIdentifier] = nextIssue;
      } else {
        delete nextIssues[issueIdentifier];
      }
      const nextState: DaemonStateSnapshot = {
        ...state,
        issues: nextIssues,
      };
      return {
        state: nextState,
        record: summarizeRecord(daemonId, workflowPath, record.status, nextState, record),
        result: nextIssue,
      };
    });
  }

  private async applyAfterRunHookIfNeeded(
    daemonId: string,
    workflow: WorkflowFile,
    issue: IssueRuntimeRecord,
    record: RunRecord,
  ): Promise<void> {
    if (!(await this.hasRunResourceTerminalAuthority(record))) {
      throw new Error(`Run ${record.run_id} cannot apply after_run while resource settlement is pending.`);
    }
    if (issue.after_run_applied_for_run_id === record.run_id) {
      return;
    }
    await this.runWorkspaceHook(workflow.config.workspace.root, issue.workspace_path, workflow.config.workspace.after_run);
    await this.updateIssueRecord(daemonId, workflow.path, issue.issue_identifier, (current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        after_run_applied_at: nowIso(this.now),
        after_run_applied_for_run_id: record.run_id,
      };
    });
  }

  private async finalizeIssueRun(args: {
    daemonId: string;
    workflow: WorkflowFile;
    tracker?: TrackerClient | undefined;
    issueIdentifier: string;
    latestIssue?: TrackerIssue | undefined;
    runRecord: RunRecord;
  }): Promise<"released" | "waiting_continuation" | "waiting_retry" | "waiting_external"> {
    if (!(await this.hasRunResourceTerminalAuthority(args.runRecord))) {
      throw new Error(`Run ${args.runRecord.run_id} cannot finalize while resource settlement is pending.`);
    }
    const issue = await this.store.readStateSnapshot(args.daemonId).then((state) => state?.issues[args.issueIdentifier]);
    if (!issue) {
      return "released";
    }

    if (isRunFinalizedInIssueRecord(issue, args.runRecord.run_id)) {
      if (issue.active_run_id === args.runRecord.run_id) {
        await this.updateIssueRecord(args.daemonId, args.workflow.path, args.issueIdentifier, (current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            active_run_id: undefined,
          };
        });
      }
      return finalizedIssueStatus(issue);
    }

    await this.applyAfterRunHookIfNeeded(args.daemonId, args.workflow, issue, args.runRecord);

    const latestIssue = args.latestIssue;
    const successfulTerminalState = args.runRecord.state === "succeeded"
      || args.runRecord.state === "completed_dirty";
    // Symphony v0: a successful terminal run is the daemon's handoff
    // contract — it always releases (and posts the handoff receipt)
    // even when the issue technically still matches active_states.
    const latestIssueTerminal = latestIssue ? isIssueTerminal(latestIssue, args.workflow) : false;
    const latestIssueEligible = latestIssue ? isIssueEligible(latestIssue, args.workflow) : false;
    const keepClaimedIssue = Boolean(
      latestIssue
      && issue.claim_status === "claimed"
      && !latestIssueTerminal,
    );
    const shouldRelease =
      successfulTerminalState
      || !latestIssue
      || latestIssueTerminal
      || (!latestIssueEligible && !keepClaimedIssue);
    const backendSessionId = extractBackendSessionId(args.runRecord) ?? issue.last_backend_session_id;
    const backendThreadId = extractBackendThreadId(args.runRecord) ?? issue.last_backend_thread_id;
    const completionTime = args.runRecord.completed_at ?? nowIso(this.now);

    const terminalCursor = this.recordLedgerEvent({
      daemonId: args.daemonId,
      issue,
      eventType: "issue.terminal",
      occurredAt: completionTime,
      payload: {
        run_id: args.runRecord.run_id,
        run_state: args.runRecord.state,
        summary: args.runRecord.summary,
      },
    });
    await this.updateIssueRecord(args.daemonId, args.workflow.path, args.issueIdentifier, (current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        terminal_at: completionTime,
        ...(terminalCursor ? { last_ledger_cursor: terminalCursor } : {}),
      };
    });

    if (shouldRelease) {
      const successfulTerminal = successfulTerminalState;
      let receipt: DaemonHandoffReceipt | undefined;
      let trackerHandoffResult: TrackerHandoffResult | undefined;
      const handoffAt = nowIso(this.now);
      if (successfulTerminal && latestIssue) {
        const refreshedIssue = (await this.store.readStateSnapshot(args.daemonId))?.issues[args.issueIdentifier]
          ?? issue;
        const activity = await this.resolveHandoffActivity(args.runRecord.intent, args.runRecord);
        receipt = this.buildHandoffReceipt({
          daemonId: args.daemonId,
          workflow: args.workflow,
          issueRecord: { ...refreshedIssue, terminal_at: completionTime },
          runRecord: args.runRecord,
          intent: args.runRecord.intent,
          activity,
          ledgerCursor: terminalCursor,
          occurredAt: handoffAt,
          summary: args.runRecord.summary,
        });
        if (args.tracker) {
          trackerHandoffResult = await this.applyTrackerHandoff({
            daemonId: args.daemonId,
            workflow: args.workflow,
            tracker: args.tracker,
            issue: latestIssue,
            receipt,
          });
        }
        const handoffCursor = this.recordLedgerEvent({
          daemonId: args.daemonId,
          issue,
          eventType: "issue.handoff",
          occurredAt: handoffAt,
          payload: {
            run_id: args.runRecord.run_id,
            run_state: args.runRecord.state,
            target_state: args.workflow.config.tracker.handoff_state,
            tracker_transitioned: Boolean(trackerHandoffResult?.transitioned),
            receipt,
          },
        });
        await this.appendEvent(
          args.daemonId,
          "info",
          "handoff_posted",
          `Posted handoff receipt for ${args.issueIdentifier} (run=${args.runRecord.run_id}).`,
          {
            issue: args.issueIdentifier,
            run_id: args.runRecord.run_id,
            target_state: args.workflow.config.tracker.handoff_state,
            tracker_transitioned: Boolean(trackerHandoffResult?.transitioned),
            ...(handoffCursor ? { ledger_cursor: handoffCursor } : {}),
          },
        );
      }

      this.ledger?.releaseClaim({
        daemonId: args.daemonId,
        issueIdentifier: args.issueIdentifier,
      });

      await this.updateIssueRecord(args.daemonId, args.workflow.path, args.issueIdentifier, (current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          status: "released",
          claim_status: "released",
          active_run_id: undefined,
          last_run_id: args.runRecord.run_id,
          last_run_state: args.runRecord.state,
          last_run_completed_at: completionTime,
          last_backend_session_id: backendSessionId,
          last_backend_thread_id: backendThreadId,
          last_error: args.runRecord.state === "succeeded" ? undefined : args.runRecord.summary,
          continuation_due_at: undefined,
          retry_due_at: undefined,
          released_at: nowIso(this.now),
          ...(receipt ? { handoff_at: handoffAt } : {}),
        };
      });
      return "released";
    }

    if (isContinuationRun(args.runRecord) && backendSessionId) {
      await this.updateIssueRecord(args.daemonId, args.workflow.path, args.issueIdentifier, (current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          status: "waiting_continuation",
          claim_status: "claimed",
          active_run_id: undefined,
          last_run_id: args.runRecord.run_id,
          last_run_state: args.runRecord.state,
          last_run_completed_at: completionTime,
          last_backend_session_id: backendSessionId,
          last_backend_thread_id: backendThreadId,
          last_error: undefined,
          continuation_due_at: addSeconds(nowIso(this.now), args.workflow.config.polling.continuation_delay_seconds),
          retry_due_at: undefined,
        };
      });
      return "waiting_continuation";
    }

    if (isRetriableFailure(args.runRecord)) {
      const retryCount = issue.retry_count + 1;
      const retryExhausted = retryLimitReached(args.workflow, retryCount);
      await this.updateIssueRecord(args.daemonId, args.workflow.path, args.issueIdentifier, (current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          status: retryExhausted ? "waiting_external" : "waiting_retry",
          claim_status: "claimed",
          retry_count: retryCount,
          active_run_id: undefined,
          last_run_id: args.runRecord.run_id,
          last_run_state: args.runRecord.state,
          last_run_completed_at: completionTime,
          last_backend_session_id: backendSessionId,
          last_backend_thread_id: backendThreadId,
          last_error: args.runRecord.summary,
          continuation_due_at: undefined,
          retry_due_at: retryExhausted
            ? undefined
            : addSeconds(nowIso(this.now), backoffSeconds(args.workflow, retryCount)),
        };
      });
      return retryExhausted ? "waiting_external" : "waiting_retry";
    }

    await this.updateIssueRecord(args.daemonId, args.workflow.path, args.issueIdentifier, (current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        status: "waiting_external",
        claim_status: "claimed",
        retry_count: 0,
        active_run_id: undefined,
        last_run_id: args.runRecord.run_id,
        last_run_state: args.runRecord.state,
        last_run_completed_at: completionTime,
        last_backend_session_id: backendSessionId,
        last_backend_thread_id: backendThreadId,
        last_error: args.runRecord.state === "succeeded" ? undefined : args.runRecord.summary,
        continuation_due_at: undefined,
        retry_due_at: undefined,
      };
    });
    return "waiting_external";
  }

  private async handleLaunchCompletion(args: {
    daemonId: string;
    workflowPath: string;
    issueIdentifier: string;
    runRecord: RunRecord;
  }): Promise<void> {
    try {
      const { workflow } = await this.loadWorkflow(args.daemonId, args.workflowPath);
      const tracker = this.options.trackerRegistry.create(workflow.config.tracker.kind);
      const polled = await tracker.pollIssues({
        ...(workflow.config.tracker.team ? { team: workflow.config.tracker.team } : {}),
        ...(workflow.config.tracker.project ? { project: workflow.config.tracker.project } : {}),
      });
      const latestIssue = polled.issues.find((issue) => issue.identifier === args.issueIdentifier);
      const nextStatus = await this.finalizeIssueRun({
        daemonId: args.daemonId,
        workflow,
        tracker,
        issueIdentifier: args.issueIdentifier,
        latestIssue,
        runRecord: args.runRecord,
      });
      await this.appendEvent(
        args.daemonId,
        "info",
        "run_completed",
        `Run ${args.runRecord.run_id} completed for ${args.issueIdentifier} with ${args.runRecord.state}.`,
        { next_status: nextStatus },
      );
    } catch (error) {
      await this.appendEvent(
        args.daemonId,
        "error",
        "run_completion_error",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.activeRuns.delete(args.runRecord.run_id);
    }
  }

  private async workspaceMissing(workspacePath: string | undefined): Promise<boolean> {
    if (!workspacePath) {
      return false;
    }
    try {
      const details = await stat(workspacePath);
      return !details.isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return true;
      }
      throw error;
    }
  }

  private async collectReconciliationFlags(state: DaemonStateSnapshot | undefined): Promise<DaemonReconciliationFlag[]> {
    const flags: DaemonReconciliationFlag[] = [];
    if (!state) {
      return flags;
    }
    for (const issue of Object.values(state.issues)) {
      if (issue.status === "running" && !issue.active_run_id) {
        flags.push({
          code: "run_daemon_state_mismatch",
          severity: "error",
          issue_identifier: issue.issue_identifier,
          message: `Daemon issue ${issue.issue_identifier} is marked running without an active run id.`,
        });
      }
      if (!issue.branch_name) {
        flags.push({
          code: "missing_branch",
          severity: "warn",
          issue_identifier: issue.issue_identifier,
          message: `Daemon issue ${issue.issue_identifier} has no branch recorded.`,
        });
      }
      if (await this.workspaceMissing(issue.workspace_path)) {
        flags.push({
          code: "missing_worktree",
          severity: "error",
          issue_identifier: issue.issue_identifier,
          message: `Daemon issue ${issue.issue_identifier} references missing worktree ${issue.workspace_path}.`,
        });
      }
      if (!issue.active_run_id) {
        if (issue.last_run_id && issue.terminal_at && !issue.handoff_at) {
          flags.push({
            code: "missing_receipt",
            severity: "warn",
            issue_identifier: issue.issue_identifier,
            run_id: issue.last_run_id,
            message: `Terminal daemon issue ${issue.issue_identifier} has no handoff receipt timestamp.`,
          });
        }
        continue;
      }
      const runRecord = await this.options.runService.getRunRecord(issue.active_run_id);
      if (!runRecord) {
        flags.push({
          code: "missing_run_record",
          severity: "error",
          issue_identifier: issue.issue_identifier,
          run_id: issue.active_run_id,
          message: `Daemon issue ${issue.issue_identifier} references missing run ${issue.active_run_id}.`,
        });
        continue;
      }
      const lifecycleTerminal = isTerminalState(runRecord.state)
        && await this.hasRunResourceTerminalAuthority(runRecord);
      if (lifecycleTerminal && !issue.handoff_at) {
        flags.push({
          code: "missing_receipt",
          severity: "warn",
          issue_identifier: issue.issue_identifier,
          run_id: runRecord.run_id,
          message: `Run ${runRecord.run_id} is terminal but daemon issue ${issue.issue_identifier} has no handoff receipt.`,
        });
      }
      if (!lifecycleTerminal && issue.status !== "running") {
        flags.push({
          code: "run_daemon_state_mismatch",
          severity: "warn",
          issue_identifier: issue.issue_identifier,
          run_id: runRecord.run_id,
          message: `Run ${runRecord.run_id} is active while daemon issue ${issue.issue_identifier} is ${issue.status}.`,
        });
      }
    }
    return flags;
  }

  private buildPlanVerdict(args: {
    workflow: WorkflowFile;
    selectedCount: number;
    pollOk: boolean;
    pollError?: string | undefined;
    warnings: DaemonPlanWarning[];
  }): DaemonPlanVerdict {
    const checks: DaemonPlanVerdict["checks"] = [];
    const blockingReasons: string[] = [];

    const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    if (nodeMajor >= 22) {
      checks.push({ name: "node_runtime", status: "ok", message: `Node ${process.versions.node} satisfies Calyx runtime floor.` });
    } else {
      checks.push({ name: "node_runtime", status: "error", message: `Node ${process.versions.node} is below the Calyx runtime floor.` });
      blockingReasons.push("node_runtime");
    }

    checks.push({ name: "workflow_config", status: "ok", message: "Workflow parsed successfully." });

    if (args.pollOk) {
      checks.push({ name: "tracker_poll", status: "ok", message: "Tracker poll completed." });
    } else {
      checks.push({
        name: "tracker_poll",
        status: "error",
        message: args.pollError ?? "Tracker poll failed.",
      });
      blockingReasons.push("tracker_poll");
    }

    const maxSelected = args.workflow.config.selection.max_selected_issues;
    if (typeof maxSelected === "number" && args.selectedCount > maxSelected) {
      checks.push({
        name: "selection_cap",
        status: "error",
        message: `Selected ${args.selectedCount} issues, above selection.max_selected_issues=${maxSelected}.`,
      });
      blockingReasons.push("selection_cap");
    } else {
      checks.push({
        name: "selection_cap",
        status: "ok",
        message: typeof maxSelected === "number"
          ? `Selected ${args.selectedCount} issues within selection.max_selected_issues=${maxSelected}.`
          : "No selection.max_selected_issues cap configured.",
      });
    }

    if (inReviewHandoffPolicy(args.workflow)) {
      checks.push({
        name: "handoff_policy",
        status: args.workflow.config.tracker.handoff_state.trim().toLowerCase() === "done" ? "warn" : "ok",
        message: args.workflow.config.tracker.handoff_state.trim().toLowerCase() === "done"
          ? "Workflow explicitly allows Done handoff."
          : `Workflow handoff target is ${args.workflow.config.tracker.handoff_state}.`,
      });
    } else {
      checks.push({
        name: "handoff_policy",
        status: "error",
        message: "Daemon workflows may not hand off directly to Done unless workflow_policy.allow_done_handoff is true.",
      });
      blockingReasons.push("handoff_policy");
    }

    if (args.warnings.some((warning) => warning.severity === "error")) {
      checks.push({
        name: "reconciliation_warnings",
        status: "warn",
        message: "Plan found reconciliation warnings for conductor review.",
      });
    }

    return {
      safe_to_launch: blockingReasons.length === 0,
      verdict: blockingReasons.length === 0 ? "safe" : "unsafe",
      blocking_reasons: [...new Set(blockingReasons)],
      checks,
    };
  }

  async plan(workflowPath: string, daemonId: string): Promise<DaemonPlanResult> {
    const workflow = await loadWorkflowFile(workflowPath, { now: this.now });
    const plannedAt = nowIso(this.now);
    const state = await this.store.readStateSnapshot(daemonId);
    const tracker = this.options.trackerRegistry.create(workflow.config.tracker.kind);
    const warnings: DaemonPlanWarning[] = [];
    const activeRuns: DaemonPlanActiveRun[] = [];
    const resourcePendingRunIds = new Set<string>();
    const skippedIssues: DaemonPlanIssueSummary[] = [];
    const eligibleCandidates: CandidateIssue[] = [];
    const inMemoryActiveIssues = new Set(
      [...this.activeRuns.values()]
        .filter((handle) => handle.daemonId === daemonId)
        .map((handle) => handle.issueIdentifier),
    );
    let pollResult: TrackerPollResult | undefined;
    let pollError: string | undefined;

    try {
      pollResult = await tracker.pollIssues({
        ...(workflow.config.tracker.team ? { team: workflow.config.tracker.team } : {}),
        ...(workflow.config.tracker.project ? { project: workflow.config.tracker.project } : {}),
      });
    } catch (error) {
      pollError = error instanceof Error ? error.message : String(error);
      warnings.push({
        code: "tracker_poll_failed",
        severity: "error",
        message: pollError,
        hint: workflow.config.tracker.kind === "linear"
          ? "Check LINEAR_API_KEY or run through with-polli-secrets."
          : "Check tracker credentials and workflow tracker configuration.",
      });
    }

    const polledIssues = pollResult?.issues ?? [];
    const trackedByIdentifier = new Map(polledIssues.map((issue) => [issue.identifier, issue]));
    const nowMs = new Date(plannedAt).getTime();

    for (const issueRecord of Object.values(state?.issues ?? {})) {
      const latestIssue = trackedByIdentifier.get(issueRecord.issue_identifier);
      if (issueRecord.active_run_id) {
        const runRecord = await this.options.runService.getRunRecord(issueRecord.active_run_id);
        if (runRecord && !(await this.hasRunResourceTerminalAuthority(runRecord))) {
          resourcePendingRunIds.add(issueRecord.active_run_id);
        }
        activeRuns.push({
          issue_identifier: issueRecord.issue_identifier,
          run_id: issueRecord.active_run_id,
          source: "daemon_state",
          state: runRecord?.state ?? "missing",
          worktree_path: issueRecord.workspace_path,
          branch: issueRecord.branch_name,
        });
        skippedIssues.push(latestIssue
          ? issueSummary(latestIssue, "active_run", issueRecord.active_run_id)
          : issueRecordSummary(issueRecord, "active_run"));
        continue;
      }
      if (inMemoryActiveIssues.has(issueRecord.issue_identifier)) {
        const handle = [...this.activeRuns.values()].find(
          (candidate) => candidate.daemonId === daemonId && candidate.issueIdentifier === issueRecord.issue_identifier,
        );
        activeRuns.push({
          issue_identifier: issueRecord.issue_identifier,
          run_id: handle?.runId ?? issueRecord.last_run_id ?? "unknown",
          source: "in_memory",
          state: "running",
          worktree_path: issueRecord.workspace_path,
          branch: issueRecord.branch_name,
        });
        skippedIssues.push(latestIssue
          ? issueSummary(latestIssue, "in_memory_active_run", handle?.runId)
          : issueRecordSummary(issueRecord, "in_memory_active_run"));
        continue;
      }
      if (!latestIssue) {
        if (issueRecord.status !== "released") {
          skippedIssues.push(issueRecordSummary(issueRecord, "missing_from_tracker"));
        }
        continue;
      }
      const ineligibleReason = issueIneligibilityReason(latestIssue, workflow);
      const keepClaimedIssue = issueRecord.claim_status === "claimed" && !isIssueTerminal(latestIssue, workflow);
      if (ineligibleReason && !keepClaimedIssue) {
        skippedIssues.push(issueSummary(latestIssue, ineligibleReason));
        continue;
      }
      const lastCompletedAt = issueRecord.last_run_completed_at
        ? new Date(issueRecord.last_run_completed_at).getTime()
        : 0;
      const trackerUpdatedAt = latestIssue.updated_at ? new Date(latestIssue.updated_at).getTime() : 0;
      if (
        issueRecord.status === "waiting_continuation"
        && issueRecord.continuation_due_at
        && nowMs >= new Date(issueRecord.continuation_due_at).getTime()
      ) {
        eligibleCandidates.push({ issue: latestIssue, reason: "continuation", record: issueRecord });
      } else if (
        issueRecord.status === "waiting_retry"
        && issueRecord.retry_due_at
        && nowMs >= new Date(issueRecord.retry_due_at).getTime()
      ) {
        eligibleCandidates.push({ issue: latestIssue, reason: "retry", record: issueRecord });
      } else if (issueRecord.status === "waiting_external" && trackerUpdatedAt > lastCompletedAt) {
        eligibleCandidates.push({ issue: latestIssue, reason: "external_update", record: issueRecord });
      } else if (issueRecord.status === "idle") {
        eligibleCandidates.push({ issue: latestIssue, reason: "new", record: issueRecord });
      } else {
        skippedIssues.push(issueSummary(latestIssue, issueRecord.status));
      }
    }

    for (const issue of polledIssues) {
      const ineligibleReason = issueIneligibilityReason(issue, workflow);
      if (ineligibleReason) {
        if (!skippedIssues.some((skipped) => skipped.issue_identifier === issue.identifier)) {
          skippedIssues.push(issueSummary(issue, ineligibleReason));
        }
        continue;
      }
      if (inMemoryActiveIssues.has(issue.identifier)) {
        if (!skippedIssues.some((skipped) => skipped.issue_identifier === issue.identifier)) {
          skippedIssues.push(issueSummary(issue, "in_memory_active_run"));
        }
        continue;
      }
      const current = state?.issues[issue.identifier];
      if (!current || current.claim_status === "released") {
        eligibleCandidates.push({ issue, reason: "new", record: current });
      }
    }

    const seenCandidates = new Set<string>();
    const orderedCandidates = eligibleCandidates
      .filter((candidate) => {
        if (seenCandidates.has(candidate.issue.identifier)) {
          skippedIssues.push(issueSummary(candidate.issue, "duplicate_candidate"));
          return false;
        }
        seenCandidates.add(candidate.issue.identifier);
        return true;
      })
      .sort((left, right) => left.issue.updated_at.localeCompare(right.issue.updated_at));
    const activeRunCount = activeRuns.filter((run) => (
      run.state === "missing"
      || !run.state
      || !isTerminalState(run.state)
      || resourcePendingRunIds.has(run.run_id)
    )).length;
    const availableLaunchSlots = Math.max(workflow.config.polling.max_concurrent_agents - activeRunCount, 0);
    const eligibleIssues = orderedCandidates.map((candidate) => issueSummary(candidate.issue, candidate.reason));
    const selectedIssues = orderedCandidates.map((candidate) => issueSummary(candidate.issue, candidate.reason));

    const maxSelected = workflow.config.selection.max_selected_issues;
    if (typeof maxSelected === "number" && selectedIssues.length > maxSelected) {
      warnings.push({
        code: "selection_cap_exceeded",
        severity: "error",
        message: `Plan selected ${selectedIssues.length} issues, above selection.max_selected_issues=${maxSelected}.`,
        hint: "Narrow labels/project/state filters or raise the explicit selection cap.",
      });
    }
    if (!inReviewHandoffPolicy(workflow)) {
      warnings.push({
        code: "unsafe_done_handoff",
        severity: "error",
        message: "Workflow handoff_state is Done without workflow_policy.allow_done_handoff=true.",
        hint: "Use handoff_state: In Review for daemon work that needs conductor review.",
      });
    }

    const reconciliationFlags = await this.collectReconciliationFlags(state);
    for (const flag of reconciliationFlags) {
      warnings.push({
        code: flag.code,
        severity: flag.severity,
        message: flag.message,
        issue_identifier: flag.issue_identifier,
        run_id: flag.run_id,
      });
    }

    return {
      schema_version: "calyx.daemon.plan/v1",
      daemon_id: daemonId,
      workflow_path: workflow.path,
      workflow_snapshot_from_cache: false,
      planned_at: plannedAt,
      tracker_issues: polledIssues.length,
      eligible_issues: eligibleIssues,
      skipped_issues: skippedIssues.sort((left, right) => left.issue_identifier.localeCompare(right.issue_identifier)),
      active_runs: activeRuns.sort((left, right) => left.issue_identifier.localeCompare(right.issue_identifier)),
      available_launch_slots: availableLaunchSlots,
      selected_issues: selectedIssues,
      selection: {
        ...(typeof maxSelected === "number" ? { max_selected_issues: maxSelected } : {}),
        selected_count: selectedIssues.length,
        eligible_count: eligibleIssues.length,
      },
      warnings,
      reconciliation_flags: reconciliationFlags,
      verdict: this.buildPlanVerdict({
        workflow,
        selectedCount: selectedIssues.length,
        pollOk: Boolean(pollResult),
        ...(pollError ? { pollError } : {}),
        warnings,
      }),
    };
  }

  async tick(
    workflowPath: string,
    daemonId: string,
    options: DaemonTickOptions = {},
  ): Promise<DaemonTickResult> {
    await this.ensureInitialized(daemonId, workflowPath);
    const preflightPlan = await this.plan(workflowPath, daemonId);
    if (!preflightPlan.verdict.safe_to_launch) {
      await this.appendEvent(
        daemonId,
        "error",
        "tick_preflight_blocked",
        `Daemon tick blocked by unsafe preflight verdict: ${preflightPlan.verdict.blocking_reasons.join(", ")}`,
        {
          blocking_reasons: preflightPlan.verdict.blocking_reasons,
          selected_issues: preflightPlan.selected_issues.map((issue) => issue.issue_identifier),
          warnings: preflightPlan.warnings.map((warning) => warning.code),
        },
      );
      throw new Error(`Daemon tick blocked by unsafe preflight verdict: ${preflightPlan.verdict.blocking_reasons.join(", ")}`);
    }
    if (this.ledger) {
      await this.reconcileFromLedger(daemonId, workflowPath);
    }
    const reconcileResult = await this.options.runService.reconcile();
    if (reconcileResult.classified.length > 0 || reconcileResult.rebuilt.length > 0) {
      await this.appendEvent(
        daemonId,
        "info",
        "run_reconcile",
        `RunService reconcile scanned ${reconcileResult.scanned} runs.`,
        {
          rebuilt: reconcileResult.rebuilt,
          classified: reconcileResult.classified,
        },
      );
    }

    const { workflow, fromCache } = await this.loadWorkflow(daemonId, workflowPath);
    const tracker = this.options.trackerRegistry.create(workflow.config.tracker.kind);
    const pollResult = await tracker.pollIssues({
      ...(workflow.config.tracker.team ? { team: workflow.config.tracker.team } : {}),
      ...(workflow.config.tracker.project ? { project: workflow.config.tracker.project } : {}),
    });
    const now = nowIso(this.now);
    const nowMs = new Date(now).getTime();
    const trackedByIdentifier = new Map(pollResult.issues.map((issue) => [issue.identifier, issue]));
    const inMemoryActiveIssues = new Set(
      [...this.activeRuns.values()]
        .filter((handle) => handle.daemonId === daemonId)
        .map((handle) => handle.issueIdentifier),
    );

    const state = (await this.store.readStateSnapshot(daemonId)) ?? createStateSnapshot(daemonId, workflow.path, now);
    const launchedRuns: string[] = [];
    const continuedRuns: string[] = [];
    const retriedRuns: string[] = [];
    const cancellationRequestedRuns: string[] = [];
    const releasedIssues: string[] = [];
    const cleanedWorkspaces: string[] = [];
    const candidates: CandidateIssue[] = [];
    let activeRuns = 0;

    for (const issueRecord of Object.values(state.issues)) {
      let currentIssueRecord = issueRecord;
      const latestIssue = trackedByIdentifier.get(issueRecord.issue_identifier);
      await this.updateIssueRecord(daemonId, workflow.path, issueRecord.issue_identifier, (current) => {
        if (!current) {
          return current;
        }
        if (!latestIssue) {
          return current;
        }
        return {
          ...current,
          title: latestIssue.title,
          state_name: latestIssue.state.name,
          ...(latestIssue.state.type ? { state_type: latestIssue.state.type } : {}),
          tracker_updated_at: latestIssue.updated_at,
          last_seen_at: pollResult.fetched_at,
        };
      });

      if (currentIssueRecord.active_run_id) {
        const activeRunId = currentIssueRecord.active_run_id;
        const hasInMemoryHandle = this.hasInMemoryActiveRun(daemonId, activeRunId);
        const runRecord = await this.options.runService.getRunRecord(activeRunId);
        if (!runRecord && hasInMemoryHandle) {
          // A launch promise can be registered just before its run admission is
          // observable. Treat the handle as liveness evidence only for that
          // narrow gap; once a record exists, tracker and stall policy must
          // still be evaluated against the live in-process run.
          activeRuns += 1;
          continue;
        }
        if (!runRecord) {
          currentIssueRecord = (await this.clearMissingActiveRun({
            daemonId,
            workflowPath: workflow.path,
            workflow,
            issueRecord: currentIssueRecord,
          })) ?? currentIssueRecord;
        }
        if (
          runRecord
          && isTerminalState(runRecord.state)
          && await this.hasRunResourceTerminalAuthority(runRecord)
        ) {
          await this.finalizeIssueRun({
            daemonId,
            workflow,
            tracker,
            issueIdentifier: currentIssueRecord.issue_identifier,
            latestIssue,
            runRecord,
          });
          continue;
        }
        if (runRecord && isTerminalState(runRecord.state)) {
          // Publisher completion is not resource completion. Retain the
          // issue, concurrency slot, hooks, handoff, and worktree until the
          // independent settlement authority proves inherited resources gone.
          activeRuns += 1;
          continue;
        }
        if (runRecord && currentIssueRecord.status === "cancellation_requested") {
          // A durable marker proves admission, not terminal teardown. Retain
          // the original run and its concurrency slot until a later tick sees
          // an authoritative terminal record.
          activeRuns += 1;
          continue;
        }
        if (
          runRecord
          && latestIssue
          && (!isIssueEligible(latestIssue, workflow) || isIssueTerminal(latestIssue, workflow))
        ) {
          const stopResult = await this.options.runService.stop(activeRunId);
          if (stopResult.status === "cancellation_requested") {
            cancellationRequestedRuns.push(activeRunId);
            await this.updateIssueRecord(
              daemonId,
              workflow.path,
              currentIssueRecord.issue_identifier,
              (current) => current ? {
                ...current,
                status: "cancellation_requested",
                active_run_id: activeRunId,
                last_error: `Cancellation requested for ${activeRunId} because the tracker issue is no longer eligible.`,
              } : current,
            );
          }
          activeRuns += 1;
          continue;
        }
        if (
          runRecord
          && !isTerminalState(runRecord.state)
          && nowMs >= new Date(runRecord.created_at).getTime() + (workflow.config.polling.stall_timeout_seconds * 1000)
        ) {
          // Wave 3: consult RunRecord.health / agent-runner liveness before
          // stopping silent-but-live work. Elapsed wall-clock age alone is
          // not enough — a run can be quietly making progress within the
          // stall window via the agent-runner heartbeat.
          if (isRunHealthLive(runRecord, nowMs, workflow.config.polling.stall_timeout_seconds)) {
            activeRuns += 1;
            await this.appendEvent(
              daemonId,
              "info",
              "stall_check_skipped_live",
              `Run ${activeRunId} for ${currentIssueRecord.issue_identifier} aged past stall window but health is live; not stopping.`,
              {
                run_id: activeRunId,
                health_status: runRecord.health?.status,
                last_progress_at: runRecord.health?.last_progress_at,
                last_activity_at: runRecord.health?.last_activity_at,
              },
            );
            continue;
          }
          const stopResult = await this.options.runService.stop(activeRunId);
          if (stopResult.status === "cancellation_requested") {
            cancellationRequestedRuns.push(activeRunId);
          }
          await this.updateIssueRecord(daemonId, workflow.path, currentIssueRecord.issue_identifier, (current) => {
            if (!current) {
              return current;
            }
            return {
              ...current,
              status: "cancellation_requested",
              claim_status: "claimed",
              active_run_id: activeRunId,
              last_error: `Cancellation requested after run ${activeRunId} exceeded stall timeout (${workflow.config.polling.stall_timeout_seconds}s).`,
              continuation_due_at: undefined,
              retry_due_at: undefined,
            };
          });
          await this.appendEvent(
            daemonId,
            "warn",
            "run_stalled",
            `Run ${activeRunId} for ${currentIssueRecord.issue_identifier} exceeded stall timeout.`,
            {
              cancellation_status: stopResult.status,
              next_status: "cancellation_requested",
              ...(runRecord.health?.status ? { health_status: runRecord.health.status } : {}),
            },
          );
          activeRuns += 1;
          continue;
        }
        if (runRecord) {
          activeRuns += 1;
          continue;
        }
      }

      if (inMemoryActiveIssues.has(currentIssueRecord.issue_identifier)) {
        activeRuns += 1;
        continue;
      }

      const latestIssueTerminal = latestIssue ? isIssueTerminal(latestIssue, workflow) : false;
      const latestIssueEligible = latestIssue ? isIssueEligible(latestIssue, workflow) : false;
      const keepClaimedIssue = Boolean(
        latestIssue
        && currentIssueRecord.claim_status === "claimed"
        && !latestIssueTerminal,
      );
      if (!latestIssue || (!latestIssueEligible && !keepClaimedIssue)) {
        this.ledger?.releaseClaim({
          daemonId,
          issueIdentifier: currentIssueRecord.issue_identifier,
        });
        if (currentIssueRecord.status === "released" && currentIssueRecord.claim_status === "released") {
          if (await this.maybeCleanupWorkspace(daemonId, workflow, currentIssueRecord)) {
            cleanedWorkspaces.push(currentIssueRecord.issue_identifier);
          }
          continue;
        }
        const released = await this.updateIssueRecord(daemonId, workflow.path, currentIssueRecord.issue_identifier, (current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            status: "released",
            claim_status: "released",
            continuation_due_at: undefined,
            retry_due_at: undefined,
            active_run_id: undefined,
            released_at: nowIso(this.now),
          };
        });
        if (released) {
          releasedIssues.push(issueRecord.issue_identifier);
          if (await this.maybeCleanupWorkspace(daemonId, workflow, released)) {
            cleanedWorkspaces.push(released.issue_identifier);
          }
        }
        continue;
      }

      const lastCompletedAt = currentIssueRecord.last_run_completed_at
        ? new Date(currentIssueRecord.last_run_completed_at).getTime()
        : 0;
      const trackerUpdatedAt = latestIssue.updated_at ? new Date(latestIssue.updated_at).getTime() : 0;
      if (
        currentIssueRecord.status === "waiting_continuation"
        && currentIssueRecord.continuation_due_at
        && nowMs >= new Date(currentIssueRecord.continuation_due_at).getTime()
      ) {
        candidates.push({ issue: latestIssue, reason: "continuation", record: currentIssueRecord });
      } else if (
        currentIssueRecord.status === "waiting_retry"
        && currentIssueRecord.retry_due_at
        && nowMs >= new Date(currentIssueRecord.retry_due_at).getTime()
      ) {
        candidates.push({ issue: latestIssue, reason: "retry", record: currentIssueRecord });
      } else if (currentIssueRecord.status === "waiting_external" && trackerUpdatedAt > lastCompletedAt) {
        candidates.push({ issue: latestIssue, reason: "external_update", record: currentIssueRecord });
      } else if (currentIssueRecord.status === "idle") {
        candidates.push({ issue: latestIssue, reason: "new", record: currentIssueRecord });
      }
    }

    for (const issue of pollResult.issues) {
      if (!isIssueEligible(issue, workflow)) {
        continue;
      }
      if (inMemoryActiveIssues.has(issue.identifier)) {
        continue;
      }
      const current = state.issues[issue.identifier];
      if (!current || current.claim_status === "released") {
        candidates.push({ issue, reason: "new", record: current });
      }
    }

    const slots = Math.max(workflow.config.polling.max_concurrent_agents - activeRuns, 0);
    const waitForRuns: Promise<void>[] = [];
    const seenCandidates = new Set<string>();
    const orderedCandidates = candidates
      .filter((candidate) => {
        if (seenCandidates.has(candidate.issue.identifier)) {
          return false;
        }
        seenCandidates.add(candidate.issue.identifier);
        return true;
      })
      .sort((left, right) => left.issue.updated_at.localeCompare(right.issue.updated_at));

    for (const candidate of orderedCandidates.slice(0, slots)) {
      // Wave 3: enforce single-claim via SQLite lock before launching.
      // The lock holder (this daemon) must succeed; a held lock means
      // another daemon owns the issue and we skip it for this tick.
      const claimGuard = this.acquireClaimGuard(daemonId, candidate.issue);
      if (!claimGuard.acquired) {
        await this.appendEvent(
          daemonId,
          "warn",
          "claim_held_elsewhere",
          `Issue ${candidate.issue.identifier} claim lock held by ${claimGuard.heldBy ?? "another owner"}; skipping.`,
          { issue: candidate.issue.identifier, ...(claimGuard.heldBy ? { held_by: claimGuard.heldBy } : {}) },
        );
        continue;
      }

      const claimedAt = nowIso(this.now);
      let claimMutationResult: TrackerClaimResult | undefined;
      try {
        claimMutationResult = await this.applyTrackerClaim({
          daemonId,
          workflow,
          tracker,
          issue: candidate.issue,
          previous: candidate.record,
        });
      } catch (error) {
        await this.appendEvent(
          daemonId,
          "warn",
          "tracker_claim_failed",
          error instanceof Error ? error.message : String(error),
          { issue: candidate.issue.identifier },
        );
      }

      const claimCursor = this.recordLedgerEvent({
        daemonId,
        issue: candidate.issue,
        eventType: "issue.claimed",
        occurredAt: claimedAt,
        payload: {
          dispatch_reason: candidate.reason,
          tracker_kind: workflow.config.tracker.kind,
          previous_state: claimMutationResult?.previous_state ?? candidate.issue.state.name,
          current_state: claimMutationResult?.current_state ?? candidate.issue.state.name,
          tracker_transitioned: Boolean(claimMutationResult?.transitioned),
        },
      });

      const workspace = await this.ensureWorkspace(daemonId, workflow, candidate.issue, candidate.record);
      await this.runWorkspaceHook(workflow.config.workspace.root, workspace.workspace_path, workflow.config.workspace.before_run);
      const intent = this.buildRunIntent({
        daemonId,
        workflow,
        issue: candidate.issue,
        workspace,
        reason: candidate.reason,
        previous: candidate.record,
      });
      const launchedAt = nowIso(this.now);
      const launchCursor = this.recordLedgerEvent({
        daemonId,
        issue: candidate.issue,
        eventType: "issue.launched",
        occurredAt: launchedAt,
        payload: {
          run_id: intent.run_id,
          dispatch_reason: candidate.reason,
          workspace_path: workspace.workspace_path,
          branch: workspace.branch_name,
        },
      });
      await this.updateIssueRecord(daemonId, workflow.path, candidate.issue.identifier, (current) => ({
        issue_id: candidate.issue.id,
        issue_identifier: candidate.issue.identifier,
        title: candidate.issue.title,
        state_name: claimMutationResult?.current_state ?? candidate.issue.state.name,
        ...(candidate.issue.state.type ? { state_type: candidate.issue.state.type } : {}),
        workspace_key: workspace.workspace_key,
        workspace_path: workspace.workspace_path,
        branch_name: workspace.branch_name,
        status: "running",
        claim_status: "claimed",
        retry_count: current?.retry_count ?? 0,
        last_seen_at: pollResult.fetched_at,
        tracker_updated_at: candidate.issue.updated_at,
        last_run_id: intent.run_id,
        active_run_id: intent.run_id,
        ...(current?.last_backend_session_id ? { last_backend_session_id: current.last_backend_session_id } : {}),
        ...(current?.last_backend_thread_id ? { last_backend_thread_id: current.last_backend_thread_id } : {}),
        claimed_at: current?.claimed_at ?? claimedAt,
        launched_at: launchedAt,
        last_ledger_cursor: launchCursor ?? claimCursor ?? current?.last_ledger_cursor,
      }));
      const nextTurnInput = this.createNextTurnInput({
        daemonId,
        issue: candidate.issue,
        workflow,
        workspace,
        currentRunId: intent.run_id,
        lastRunId: candidate.record?.last_run_id,
        resumeSessionId: candidate.record?.last_backend_session_id,
      });
      const launchPromise = this.options.runService
        .launch(intent, {
          detached: false,
          nextTurnInput,
        })
        .then(async (result) => {
          await this.handleLaunchCompletion({
            daemonId,
            workflowPath: workflow.path,
            issueIdentifier: candidate.issue.identifier,
            runRecord: result.record,
          });
        });
      this.activeRuns.set(intent.run_id, {
        daemonId,
        workflowPath: workflow.path,
        issueIdentifier: candidate.issue.identifier,
        runId: intent.run_id,
        promise: launchPromise,
      });
      inMemoryActiveIssues.add(candidate.issue.identifier);
      activeRuns += 1;

      launchedRuns.push(intent.run_id);
      if (candidate.reason === "continuation") {
        continuedRuns.push(intent.run_id);
      }
      if (candidate.reason === "retry") {
        retriedRuns.push(intent.run_id);
      }
      if (options.awaitLaunchedRuns) {
        waitForRuns.push(launchPromise);
      }
    }

    if (waitForRuns.length > 0) {
      await Promise.allSettled(waitForRuns);
    }

    const refreshedState = (await this.store.readStateSnapshot(daemonId)) ?? state;
    const hadWork = activeRuns > 0;
    const nextIntervalSeconds = hadWork
      ? workflow.config.polling.interval_seconds
      : Math.min(
          Math.max(refreshedState.current_interval_seconds || workflow.config.polling.interval_seconds, workflow.config.polling.interval_seconds)
            + workflow.config.polling.idle_backoff_seconds,
          workflow.config.polling.max_interval_seconds,
        );
    const tickAt = nowIso(this.now);
    const nextPollAt = addSeconds(tickAt, nextIntervalSeconds);

    await this.mutateDaemon(daemonId, workflow.path, async ({ state: liveState, record }) => {
      const nextState: DaemonStateSnapshot = {
        ...liveState,
        current_interval_seconds: nextIntervalSeconds,
        last_tick_at: tickAt,
        last_tracker_sync_at: pollResult.fetched_at,
        next_poll_at: nextPollAt,
        last_error: undefined,
      };
      return {
        state: nextState,
        record: summarizeRecord(daemonId, workflow.path, record.status, nextState, record),
      };
    });

    await this.appendEvent(
      daemonId,
      "info",
      "tick",
      `Tick completed with ${launchedRuns.length} launches and ${activeRuns} active runs.`,
      {
        workflow_snapshot_from_cache: fromCache,
        tracker_issues: pollResult.issues.length,
        eligible_issues: orderedCandidates.length,
      },
    );

    return {
      daemon_id: daemonId,
      workflow_path: workflow.path,
      workflow_snapshot_from_cache: fromCache,
      tracker_issues: pollResult.issues.length,
      eligible_issues: orderedCandidates.length,
      active_runs: refreshedState.active_run_ids.length,
      launched_runs: launchedRuns,
      continued_runs: continuedRuns,
      retried_runs: retriedRuns,
      cancellation_requested_runs: cancellationRequestedRuns,
      released_issues: releasedIssues,
      cleaned_workspaces: cleanedWorkspaces,
      next_poll_at: nextPollAt,
      preflight_verdict: preflightPlan.verdict,
      warnings: preflightPlan.warnings,
    };
  }

  async startForeground(workflowPath: string, daemonId: string): Promise<DaemonStartResult> {
    await this.ensureInitialized(daemonId, workflowPath);
    const descriptor = await this.store.readDescriptor(daemonId);
    const resolvedWorkflowPath = descriptor?.workflow_path ?? path.resolve(workflowPath);
    await this.store.writePid(daemonId, process.pid);
    await this.mutateDaemon(daemonId, resolvedWorkflowPath, async ({ state, record }) => {
      const nextRecord: DaemonRecord = {
        ...record,
        status: "running",
        started_at: record.started_at ?? nowIso(this.now),
        pid: process.pid,
      };
      return {
        state,
        record: summarizeRecord(daemonId, resolvedWorkflowPath, "running", state, nextRecord),
      };
    });
    await this.appendEvent(daemonId, "info", "daemon_started", `Daemon ${daemonId} started in foreground.`);

    let stopRequested = false;
    const requestStop = (): void => {
      stopRequested = true;
    };
    process.once("SIGTERM", requestStop);
    process.once("SIGINT", requestStop);

    try {
      while (!stopRequested) {
        const tickResult = await this.tick(resolvedWorkflowPath, daemonId, { awaitLaunchedRuns: false });
        const delayMs = Math.max(new Date(tickResult.next_poll_at).getTime() - Date.now(), 0);
        const activePromises = [...this.activeRuns.values()]
          .filter((handle) => handle.daemonId === daemonId)
          .map((handle) => handle.promise);
        if (activePromises.length > 0) {
          await Promise.race([this.sleep(delayMs), ...activePromises]);
        } else {
          await this.sleep(delayMs);
        }
      }
    } finally {
      for (const handle of [...this.activeRuns.values()].filter((item) => item.daemonId === daemonId)) {
        await this.options.runService.stop(handle.runId);
      }
      const state = (await this.store.readStateSnapshot(daemonId)) ?? createStateSnapshot(daemonId, resolvedWorkflowPath, nowIso(this.now));
      const record = (await this.store.readDaemonRecord(daemonId)) ?? createDaemonRecord(daemonId, resolvedWorkflowPath, nowIso(this.now));
      const stoppedRecord: DaemonRecord = {
        ...summarizeRecord(daemonId, resolvedWorkflowPath, "stopped", state, record),
        status: "stopped",
        stopped_at: nowIso(this.now),
      };
      await this.store.writeDaemonRecord(daemonId, stoppedRecord);
      await this.store.clearPid(daemonId);
      await this.appendEvent(daemonId, "info", "daemon_stopped", `Daemon ${daemonId} stopped.`);
      process.removeListener("SIGTERM", requestStop);
      process.removeListener("SIGINT", requestStop);
    }

    const record = (await this.store.readDaemonRecord(daemonId)) ?? createDaemonRecord(daemonId, resolvedWorkflowPath, nowIso(this.now), "stopped");
    return {
      daemon_id: daemonId,
      state_root: this.store.paths(daemonId).daemonDir,
      record,
      pid: process.pid,
    };
  }

  async getStatus(daemonId: string): Promise<DaemonRecord | undefined> {
    return this.store.readDaemonRecord(daemonId);
  }

  async readLogs(daemonId: string, tail?: number | undefined): Promise<DaemonEvent[]> {
    const events = await this.store.readEvents(daemonId);
    return typeof tail === "number" ? events.slice(-tail) : events;
  }

  async stop(daemonId: string): Promise<{ stopped: boolean; pid?: number | undefined }> {
    const pid = await this.store.readPid(daemonId);
    if (!pid) {
      return { stopped: false };
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      const typed = error as NodeJS.ErrnoException;
      if (typed.code === "ESRCH") {
        await this.store.clearPid(daemonId);
        return { stopped: false, pid };
      }
      throw error;
    }
    await this.appendEvent(daemonId, "warn", "stop_requested", `Sent SIGTERM to daemon ${daemonId}.`, { pid });
    return { stopped: true, pid };
  }
}
