import { randomUUID } from "node:crypto";
import {
  appendMonitorWakeJsonlReceipt,
  cancelMonitor,
  checkMonitorSchema,
  completeMonitorDelivery,
  createMonitorSessionIngressDeliveryAttempt,
  createMonitorWake,
  type CreateMonitorWakeResult,
  evaluatePredicateV1,
  appendTaskRunJsonlReceipt,
  checkTaskSchema,
  createTaskRun,
  listTaskInstalls,
  listMonitors,
  openStateStore,
  readMonitorCursor,
  readTaskInstallCursor,
  recordMonitorEvaluation,
  recordTaskInstallEvaluation,
  setMonitorWakeReceiptPath,
  setTaskRunReceiptPath,
  type MonitorRow,
  type MonitorWakeRow,
  type PredicateEvaluationResult,
  type PredicateRunSnapshot,
  type StateDriverDatabase,
  type StateOpenOptions,
  type TaskInstallRow,
} from "@polli-labs/calyx-core";
import type { RunState } from "@polli-labs/calyx-runner";

import type { RunStore } from "./store.js";
import {
  deliverMonitorWakeBindings,
  type MonitorDeliveryDependencies,
} from "./monitor-delivery.js";
import type { CalyxMonitorEvent } from "./types.js";
import {
  routeSessionWake,
  type SessionWakeRouteDependencies,
} from "./session-ingress.js";

export interface MonitorEvaluatorOptions {
  enabled?: boolean | undefined;
  intervalMs?: number | undefined;
  assignedHost: string;
  state?: StateOpenOptions | undefined;
}

export interface MonitorEvaluatorDependencies {
  store: RunStore;
  now: () => string;
  emit: (event: CalyxMonitorEvent) => Promise<void>;
  delivery?: Omit<MonitorDeliveryDependencies, "now"> | undefined;
  sessionWake?: Omit<SessionWakeRouteDependencies, "now"> | undefined;
  onError?: ((error: Error) => void) | undefined;
}

export interface MonitorEvaluatorTickResult {
  status: "ok" | "disabled" | "schema-unavailable" | "error";
  scanned: number;
  evaluated: number;
  wakesCreated: number;
  duplicates: number;
  deliveriesAttempted: number;
  deliveriesDelivered: number;
  deliveriesFailed: number;
  deliveriesSkipped: number;
  errors: number;
  taskInstallsScanned: number;
  taskLaunchIntentsCreated: number;
  detail?: string;
}

const DEFAULT_MONITOR_INTERVAL_MS = 5_000;

export class MonitorEvaluator {
  private readonly options: Required<Omit<MonitorEvaluatorOptions, "state">> & {
    state?: StateOpenOptions | undefined;
  };
  private readonly deps: MonitorEvaluatorDependencies;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<MonitorEvaluatorTickResult> | null = null;

  constructor(options: MonitorEvaluatorOptions, deps: MonitorEvaluatorDependencies) {
    this.options = {
      enabled: options.enabled ?? true,
      intervalMs: options.intervalMs ?? DEFAULT_MONITOR_INTERVAL_MS,
      assignedHost: normalizeHost(options.assignedHost),
      ...(options.state ? { state: options.state } : {}),
    };
    this.deps = deps;
  }

  start(): void {
    if (!this.options.enabled || this.timer) return;
    void this.tickOnce();
    this.timer = setInterval(() => {
      void this.tickOnce();
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tickOnce(): Promise<MonitorEvaluatorTickResult> {
    if (!this.options.enabled) {
      return {
        status: "disabled",
        scanned: 0,
        evaluated: 0,
        wakesCreated: 0,
        duplicates: 0,
        deliveriesAttempted: 0,
        deliveriesDelivered: 0,
        deliveriesFailed: 0,
        deliveriesSkipped: 0,
        errors: 0,
        taskInstallsScanned: 0,
        taskLaunchIntentsCreated: 0,
      };
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runTick()
      .catch((err) => this.handleTickError(err))
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private handleTickError(err: unknown): MonitorEvaluatorTickResult {
    const cause = err instanceof Error ? err : new Error(String(err));
    const error = new Error(
      `monitor evaluator tick failed (assigned_host=${this.options.assignedHost}): ${cause.message}`,
      { cause },
    );
    try {
      this.deps.onError?.(error);
    } catch {
      // Logging hooks must not turn a bounded evaluator failure into a daemon crash.
    }
    return {
      status: "error",
      scanned: 0,
      evaluated: 0,
      wakesCreated: 0,
      duplicates: 0,
      deliveriesAttempted: 0,
      deliveriesDelivered: 0,
      deliveriesFailed: 0,
      deliveriesSkipped: 0,
      errors: 1,
      taskInstallsScanned: 0,
      taskLaunchIntentsCreated: 0,
      detail: error.message,
    };
  }

  private async runTick(): Promise<MonitorEvaluatorTickResult> {
    const opened = await openStateStore(this.options.state ?? {});
    try {
      const schema = checkMonitorSchema(opened.db);
      if (schema.status !== "ok") {
        return {
          status: "schema-unavailable",
          scanned: 0,
          evaluated: 0,
          wakesCreated: 0,
          duplicates: 0,
          deliveriesAttempted: 0,
          deliveriesDelivered: 0,
          deliveriesFailed: 0,
          deliveriesSkipped: 0,
          errors: schema.findings.length,
          taskInstallsScanned: 0,
          taskLaunchIntentsCreated: 0,
          detail: schema.findings.map((finding) => finding.detail).join("; "),
        };
      }

      const taskSchema = checkTaskSchema(opened.db);
      const monitors = listMonitors(opened.db, { status: "active", limit: 500 })
        .filter((monitor) => shouldEvaluateOnHost(monitor, this.options.assignedHost));
      const taskInstalls = taskSchema.status === "ok"
        ? listTaskInstalls(opened.db, { status: "active", limit: 500 })
          .filter((install) => shouldEvaluateTaskOnHost(install, this.options.assignedHost))
        : [];
      let evaluated = 0;
      let wakesCreated = 0;
      let taskLaunchIntentsCreated = 0;
      let duplicates = 0;
      let deliveriesAttempted = 0;
      let deliveriesDelivered = 0;
      let deliveriesFailed = 0;
      let deliveriesSkipped = 0;
      let errors = 0;

      for (const monitor of monitors) {
        try {
          const cursor = readMonitorCursor(opened.db, monitor.monitor_id)?.cursor ?? {};
          const evaluation = await evaluatePredicateV1(
            monitor.predicate,
            {
              now: () => new Date(this.deps.now()),
              readRun: (runId) => this.readRunSnapshot(runId),
            },
            cursor,
          );
          evaluated += 1;
          const wakeRecord = recordEvaluationAndCreateWake(opened.db, monitor, evaluation);
          if (!wakeRecord.result || !wakeRecord.updated) {
            continue;
          }
          if (!wakeRecord.result.inserted) {
            duplicates += 1;
            continue;
          }
          const receiptPath = await appendMonitorWakeJsonlReceipt(
            opened.paths.stateDir,
            wakeRecord.result.wake,
          );
          const wake = setMonitorWakeReceiptPath(opened.db, wakeRecord.result.wake.wake_id, receiptPath)
            ?? wakeRecord.result.wake;
          const exactSessionOwner = isExactInteractiveActivity(wakeRecord.updated.owner);
          const deliverySummary = await deliverMonitorWakeBindings(opened.db, wakeRecord.updated, wake, {
            now: this.deps.now,
            ...(this.deps.delivery ?? {}),
            ...(exactSessionOwner ? { audience: "human_only" as const } : {}),
          });
          deliveriesAttempted += deliverySummary.attempted;
          deliveriesDelivered += deliverySummary.delivered;
          deliveriesFailed += deliverySummary.failed;
          deliveriesSkipped += deliverySummary.skipped;
          if (exactSessionOwner) {
            const projection = createMonitorSessionIngressDeliveryAttempt(opened.db, {
              wake,
              activity_id: wakeRecord.updated.owner,
              attempted_at: wake.created_at,
              target: {
                pointer_kind: "monitor_wake",
                pointer_id: wake.wake_id,
              },
            });
            const sessionWake = await routeSessionWake(opened.db, {
              recipient_activity_id: wakeRecord.updated.owner,
              pointer_kind: "monitor_wake",
              pointer_id: wake.wake_id,
              created_at: wake.created_at,
            }, {
              now: this.deps.now,
              ...(this.deps.sessionWake ?? {}),
            });
            completeMonitorDelivery(opened.db, {
              delivery_id: projection.delivery.delivery_id,
              status: sessionWake.wake_state === "wake_delivered" ? "delivered" : "failed",
              completed_at: sessionWake.delivery.delivered_at ?? sessionWake.delivery.failed_at ?? this.deps.now(),
              target: {
                activity_id: wakeRecord.updated.owner,
                pointer_kind: sessionWake.pointer.kind,
                pointer_id: sessionWake.pointer.id,
                session_wake_delivery_id: sessionWake.delivery.delivery_id,
              },
              evidence: {
                wake_state: sessionWake.wake_state,
                first_command: sessionWake.first_command,
                session_wake_status: sessionWake.delivery.status,
              },
              ...(sessionWake.wake_state === "wake_delivered" ? {} : {
                error_code: sessionWake.delivery.error_code ?? sessionWake.wake_state,
                error_message: sessionWake.delivery.error_message,
              }),
            });
            deliveriesAttempted += 1;
            if (sessionWake.wake_state === "wake_delivered") deliveriesDelivered += 1;
            else deliveriesFailed += 1;
          }
          await this.deps.emit(buildMonitorEvent(wakeRecord.updated, wake, evaluation));
          wakesCreated += 1;
        } catch (err) {
          errors += 1;
          const error = err instanceof Error ? err : new Error(String(err));
          this.deps.onError?.(error);
        }
      }

      for (const install of taskInstalls) {
        try {
          const cursor = readTaskInstallCursor(opened.db, install.install_id)?.cursor ?? {};
          const evaluation = await evaluatePredicateV1(
            install.predicate,
            {
              now: () => new Date(this.deps.now()),
              readRun: (runId) => this.readRunSnapshot(runId),
            },
            cursor,
          );
          evaluated += 1;
          const shouldRecordIntent = shouldCreateTaskLaunchIntent(install, evaluation);
          if (!shouldRecordIntent) {
            recordTaskInstallEvaluation(opened.db, {
              install_id: install.install_id,
              evaluation,
            });
            continue;
          }
          const taskRun = createTaskRun(opened.db, {
            task_id: install.task_id,
            install_id: install.install_id,
            trigger_kind: "predicate",
            status: "launch_intent_recorded",
            mode: install.mode,
            dry_run: true,
            launch_policy: install.launch_policy,
            predicate_evaluation: evaluation,
            summary: `Task ${install.task_id} trigger matched; unattended launch is disabled in POL-1730 v1.`,
            now: evaluation.evaluated_at,
          });
          const receiptPath = await appendTaskRunJsonlReceipt(opened.paths.stateDir, taskRun);
          setTaskRunReceiptPath(opened.db, taskRun.task_run_id, receiptPath);
          recordTaskInstallEvaluation(opened.db, {
            install_id: install.install_id,
            evaluation,
            task_run_id: taskRun.task_run_id,
          });
          taskLaunchIntentsCreated += 1;
        } catch (err) {
          errors += 1;
          const error = err instanceof Error ? err : new Error(String(err));
          this.deps.onError?.(error);
        }
      }

      return {
        status: "ok",
        scanned: monitors.length,
        evaluated,
        wakesCreated,
        duplicates,
        deliveriesAttempted,
        deliveriesDelivered,
        deliveriesFailed,
        deliveriesSkipped,
        errors,
        taskInstallsScanned: taskInstalls.length,
        taskLaunchIntentsCreated,
      };
    } finally {
      opened.db.close();
    }
  }

  private async readRunSnapshot(runId: string): Promise<PredicateRunSnapshot | undefined> {
    const record = await this.deps.store.readRunRecord(runId);
    if (!record) return undefined;
    const receipt = await this.deps.store.readKernelReceipt(runId);
    const providerConstraint = receipt && !("kernel" in receipt)
      ? receipt.terminal_evidence?.provider_constraint
      : undefined;
    const paths = this.deps.store.paths(runId);
    return {
      run_id: record.run_id,
      state: record.state,
      ...(record.infra_error_classification
        ? { infra_error_classification: record.infra_error_classification }
        : {}),
      ...(providerConstraint ? { provider_constraint: providerConstraint } : {}),
      summary: record.summary,
      host: record.intent.host,
      ...(record.intent.issue ? { issue: record.intent.issue } : {}),
      updated_at: record.updated_at,
      ...(record.completed_at ? { completed_at: record.completed_at } : {}),
      ...(record.health?.status ? { health_status: record.health.status } : {}),
      ...(record.health?.last_progress_at ? { last_progress_at: record.health.last_progress_at } : {}),
      ...(receipt ? { receipt_path: paths.kernelReceiptPath } : {}),
    };
  }
}

function isExactInteractiveActivity(value: string): boolean {
  return /^interactive:(codex|claude):.+$/u.test(value);
}

interface EvaluationWakeRecord {
  updated: MonitorRow | null;
  result: CreateMonitorWakeResult | null;
}

function recordEvaluationAndCreateWake(
  db: StateDriverDatabase,
  monitor: MonitorRow,
  evaluation: PredicateEvaluationResult,
): EvaluationWakeRecord {
  db.exec("BEGIN IMMEDIATE");
  try {
    const shouldWake = shouldCreateWake(monitor, evaluation);
    const updated = recordMonitorEvaluation(db, monitor.monitor_id, evaluation);
    if (!shouldWake || !updated) {
      if (updated && shouldCompleteTerminalRunnerSupervisionMonitor(updated, evaluation)) {
        const completed = cancelMonitor(db, updated.monitor_id, {
          cancelled_at: evaluation.evaluated_at,
          detail: "terminal runner-supervision monitor completed",
        }) ?? updated;
        db.exec("COMMIT");
        return { updated: completed, result: null };
      }
      db.exec("COMMIT");
      return { updated: updated ?? null, result: null };
    }
    const result = createMonitorWake(db, {
      monitor: updated,
      evaluation,
      suggested_commands: suggestedCommands(updated),
      created_at: evaluation.evaluated_at,
    });
    const completed = shouldCompleteTerminalRunnerSupervisionMonitor(updated, evaluation)
      ? cancelMonitor(db, updated.monitor_id, {
        cancelled_at: evaluation.evaluated_at,
        detail: "terminal runner-supervision monitor completed after wake creation",
      }) ?? updated
      : updated;
    db.exec("COMMIT");
    return { updated: completed, result };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original evaluation/wake error.
    }
    throw err;
  }
}

function shouldEvaluateOnHost(monitor: MonitorRow, assignedHost: string): boolean {
  if (!monitor.assigned_host) return true;
  return normalizeHost(monitor.assigned_host) === assignedHost;
}

function shouldEvaluateTaskOnHost(install: TaskInstallRow, assignedHost: string): boolean {
  return normalizeHost(install.host) === assignedHost || normalizeHost(install.host) === "local";
}

function shouldCreateWake(
  monitor: MonitorRow,
  evaluation: PredicateEvaluationResult,
): boolean {
  if (!evaluation.matched) return false;
  if (monitor.rearm_policy === "once") {
    return !monitor.last_wake_id;
  }
  if (monitor.rearm_policy === "rearm_on_reset") {
    return monitor.last_match !== true;
  }
  return monitor.last_transition_hash !== evaluation.transition_hash;
}

function shouldCompleteTerminalRunnerSupervisionMonitor(
  monitor: MonitorRow,
  evaluation: PredicateEvaluationResult,
): boolean {
  if (monitor.preset !== "runner-supervision" || !monitor.source_run_id) return false;
  // Runner-supervision predicates only observe live run state/health; once the
  // source run is terminal, this monitor has no later materiality to carry.
  return (
    evaluation.matched
    && evaluation.evidence.some((record) => record.kind === "run.terminal" && record.status === "matched")
  );
}

function shouldCreateTaskLaunchIntent(
  install: TaskInstallRow,
  evaluation: PredicateEvaluationResult,
): boolean {
  if (!evaluation.matched) return false;
  if (install.unattended_enabled) {
    return install.last_transition_hash !== evaluation.transition_hash;
  }
  return install.last_transition_hash !== evaluation.transition_hash;
}

function suggestedCommands(monitor: MonitorRow): string[] {
  return [
    "calyx monitor inbox --json",
    `calyx monitor show ${monitor.monitor_id} --json`,
    ...(monitor.source_run_id ? [`calyx run status --run-id ${monitor.source_run_id} --json`] : []),
  ];
}

function buildMonitorEvent(
  monitor: MonitorRow,
  wake: MonitorWakeRow,
  evaluation: PredicateEvaluationResult,
): CalyxMonitorEvent {
  const emittedAt = evaluation.evaluated_at;
  return {
    schema_version: "1.0",
    event_id: randomUUID(),
    cursor: `${emittedAt}-${monitor.monitor_id}-${wake.wake_id}`,
    emitted_at: emittedAt,
    event_type: "monitor.wake.created",
    emitted_by: "monitor",
    monitor: {
      monitor_id: monitor.monitor_id,
      wake_id: wake.wake_id,
      status: wake.status,
      transition_hash: wake.transition_hash,
      rearm_policy: wake.rearm_policy,
      owner: monitor.owner,
      ...(monitor.assigned_host ? { assigned_host: monitor.assigned_host } : {}),
      ...(monitor.source_run_id ? { source_run_id: monitor.source_run_id } : {}),
      ...(monitor.preset ? { preset: monitor.preset } : {}),
      ...(wake.receipt_path ? { receipt_path: wake.receipt_path } : {}),
      suggested_commands: wake.suggested_commands,
    },
    predicate: monitor.predicate,
    evaluation,
    summary: {
      one_line: summarizeWake(monitor, wake),
    },
  };
}

function summarizeWake(monitor: MonitorRow, wake: MonitorWakeRow): string {
  const target = monitor.source_run_id ? `run ${monitor.source_run_id}` : `monitor ${monitor.monitor_id}`;
  return `Monitor ${monitor.monitor_id} woke for ${target} (${wake.transition_hash.slice(0, 12)}).`;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\..*$/, "");
}

export function isTerminalRunState(state: RunState): boolean {
  return (
    state === "succeeded"
    || state === "failed"
    || state === "partial"
    || state === "cancelled"
    || state === "auth_error"
    || state === "infra_error"
    || state === "completed_dirty"
  );
}
