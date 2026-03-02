import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  DomainValidationIssue,
  ExecLaunchOptions,
  ExecLaunchResult,
  ExecLogsOptions,
  ExecLogsResult,
  ExecReceiptOptions,
  ExecReceiptResult,
  ExecRunRecord,
  ExecRunState,
  ExecRunStore,
  ExecStatusOptions,
  ExecStatusResult,
  ExecValidateOptions,
  ExecValidateResult
} from "./types";

const execRunStateSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);

const logLevelSchema = z.enum(["info", "warn", "error"]);

const execLogEntrySchema = z.object({
  timestamp: z.string().min(1),
  level: logLevelSchema,
  message: z.string().min(1)
});

const execRunRecordSchema = z
  .object({
    run_id: z.string().min(1),
    command: z.string().min(1),
    state: execRunStateSchema,
    created_at: z.string().min(1),
    started_at: z.string().min(1).optional(),
    completed_at: z.string().min(1).optional(),
    exit_code: z.number().int().optional(),
    error: z.string().min(1).optional(),
    metadata: z.record(z.unknown()).optional(),
    logs: z.array(execLogEntrySchema).optional()
  })
  .passthrough();

const execRunStoreSchema = z
  .object({
    version: z.string().min(1),
    runs: z.array(execRunRecordSchema)
  })
  .passthrough();

/** Terminal states that a run cannot transition out of. */
const TERMINAL_STATES: ReadonlySet<ExecRunState> = new Set(["succeeded", "failed", "cancelled"]);

/** Valid state transitions: state → allowed next states. */
const VALID_TRANSITIONS: Record<ExecRunState, ReadonlySet<ExecRunState>> = {
  queued: new Set(["running", "cancelled"]),
  running: new Set(["succeeded", "failed", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set()
};

function toIssue(code: string, message: string, path?: string): DomainValidationIssue {
  return {
    code,
    message,
    ...(path ? { path } : {})
  };
}

function formatSchemaError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${at}: ${issue.message}`;
    })
    .join("; ");
}

async function loadRunStore(storePath: string): Promise<ExecRunStore> {
  let text = "";
  try {
    text = await readFile(storePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read exec run store at ${storePath}: ${message}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON at ${storePath}: ${message}`);
  }

  const parsedStore = execRunStoreSchema.safeParse(parsedJson);
  if (!parsedStore.success) {
    throw new Error(`Invalid exec run store schema at ${storePath}: ${formatSchemaError(parsedStore.error)}`);
  }

  return parsedStore.data as ExecRunStore;
}

async function saveRunStore(storePath: string, store: ExecRunStore): Promise<void> {
  try {
    await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write exec run store at ${storePath}: ${message}`);
  }
}

function findRun(store: ExecRunStore, runId: string, storePath: string): ExecRunRecord {
  const run = store.runs.find((r) => r.run_id === runId);
  if (!run) {
    throw new Error(`Run "${runId}" not found in exec store at ${storePath}.`);
  }
  return run;
}

function computeDurationMs(run: ExecRunRecord): number | undefined {
  if (!run.started_at || !run.completed_at) {
    return undefined;
  }
  const start = new Date(run.started_at).getTime();
  const end = new Date(run.completed_at).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return undefined;
  }
  return end - start;
}

function buildSummaryText(run: ExecRunRecord, durationMs: number | undefined): string {
  const parts: string[] = [`run ${run.run_id}: ${run.state}`];

  if (run.exit_code !== undefined) {
    parts.push(`exit_code=${run.exit_code}`);
  }

  if (durationMs !== undefined) {
    if (durationMs < 1000) {
      parts.push(`duration=${durationMs}ms`);
    } else {
      parts.push(`duration=${(durationMs / 1000).toFixed(1)}s`);
    }
  }

  if (run.error) {
    parts.push(`error: ${run.error}`);
  }

  return parts.join(", ");
}

function evaluateRunStore(store: ExecRunStore, options: ExecValidateOptions = {}): ExecValidateResult {
  const strict = options.strict ?? false;
  const errors: DomainValidationIssue[] = [];
  const warnings: DomainValidationIssue[] = [];
  const knownIds = new Set<string>();

  let queued = 0;
  let running = 0;
  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;

  for (const [index, run] of store.runs.entries()) {
    if (knownIds.has(run.run_id)) {
      errors.push(toIssue("exec.duplicate-run-id", `Duplicate run_id "${run.run_id}".`, `runs[${index}].run_id`));
    }
    knownIds.add(run.run_id);

    switch (run.state) {
      case "queued":
        queued += 1;
        break;
      case "running":
        running += 1;
        break;
      case "succeeded":
        succeeded += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "cancelled":
        cancelled += 1;
        break;
    }

    // Terminal states should have completed_at
    if (TERMINAL_STATES.has(run.state) && !run.completed_at) {
      const issue = toIssue(
        "exec.terminal-missing-completed-at",
        `Run "${run.run_id}" is in terminal state "${run.state}" but missing completed_at.`,
        `runs[${index}].completed_at`
      );
      if (strict) {
        errors.push(issue);
      } else {
        warnings.push(issue);
      }
    }

    // Running and terminal states should have started_at
    if (run.state !== "queued" && run.state !== "cancelled" && !run.started_at) {
      const issue = toIssue(
        "exec.active-missing-started-at",
        `Run "${run.run_id}" is in state "${run.state}" but missing started_at.`,
        `runs[${index}].started_at`
      );
      if (strict) {
        errors.push(issue);
      } else {
        warnings.push(issue);
      }
    }

    // Failed runs should have exit_code or error
    if (run.state === "failed" && run.exit_code === undefined && !run.error) {
      const issue = toIssue(
        "exec.failed-missing-cause",
        `Failed run "${run.run_id}" should set exit_code or error.`,
        `runs[${index}]`
      );
      if (strict) {
        errors.push(issue);
      } else {
        warnings.push(issue);
      }
    }

    // Succeeded runs should have exit_code 0
    if (run.state === "succeeded" && run.exit_code !== undefined && run.exit_code !== 0) {
      errors.push(
        toIssue(
          "exec.succeeded-nonzero-exit",
          `Succeeded run "${run.run_id}" has non-zero exit_code ${run.exit_code}.`,
          `runs[${index}].exit_code`
        )
      );
    }

    // Timestamp ordering: created_at <= started_at <= completed_at
    if (run.started_at) {
      const created = new Date(run.created_at).getTime();
      const started = new Date(run.started_at).getTime();
      if (!Number.isNaN(created) && !Number.isNaN(started) && started < created) {
        errors.push(
          toIssue(
            "exec.timestamp-order",
            `Run "${run.run_id}" has started_at before created_at.`,
            `runs[${index}].started_at`
          )
        );
      }
    }

    if (run.started_at && run.completed_at) {
      const started = new Date(run.started_at).getTime();
      const completed = new Date(run.completed_at).getTime();
      if (!Number.isNaN(started) && !Number.isNaN(completed) && completed < started) {
        errors.push(
          toIssue(
            "exec.timestamp-order",
            `Run "${run.run_id}" has completed_at before started_at.`,
            `runs[${index}].completed_at`
          )
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    version: store.version,
    total: store.runs.length,
    queued,
    running,
    succeeded,
    failed,
    cancelled
  };
}

function ensureValidOrThrow(validation: ExecValidateResult, storePath: string): void {
  if (validation.ok) {
    return;
  }

  const details = validation.errors
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("; ");
  throw new Error(`Exec run store validation failed at ${storePath}: ${details}`);
}

export async function validateExecStore(
  storePath: string,
  options: ExecValidateOptions = {}
): Promise<ExecValidateResult> {
  const store = await loadRunStore(storePath);
  return evaluateRunStore(store, options);
}

export async function launchExecRun(
  storePath: string,
  options: ExecLaunchOptions
): Promise<ExecLaunchResult> {
  // Load and validate the store to ensure it's structurally sound
  const store = await loadRunStore(storePath);
  const validation = evaluateRunStore(store);
  ensureValidOrThrow(validation, storePath);

  const apply = Boolean(options.apply);
  const runId = randomUUID();
  const now = new Date().toISOString();
  const runRecord: ExecRunRecord = {
    run_id: runId,
    command: options.command,
    state: "queued",
    created_at: now
  };

  if (apply) {
    const nextStore: ExecRunStore = {
      ...store,
      runs: [...store.runs, runRecord]
    };
    const nextValidation = evaluateRunStore(nextStore);
    ensureValidOrThrow(nextValidation, storePath);
    await saveRunStore(storePath, nextStore);
  }

  return {
    run_id: runRecord.run_id,
    command: runRecord.command,
    state: runRecord.state,
    created_at: runRecord.created_at,
    apply
  };
}

export async function getExecStatus(
  storePath: string,
  options: ExecStatusOptions
): Promise<ExecStatusResult> {
  const store = await loadRunStore(storePath);
  const validation = evaluateRunStore(store);
  ensureValidOrThrow(validation, storePath);

  const run = findRun(store, options.run_id, storePath);

  return {
    run_id: run.run_id,
    command: run.command,
    state: run.state,
    created_at: run.created_at,
    ...(run.started_at ? { started_at: run.started_at } : {}),
    ...(run.completed_at ? { completed_at: run.completed_at } : {}),
    ...(run.exit_code !== undefined ? { exit_code: run.exit_code } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.metadata ? { metadata: run.metadata } : {})
  };
}

export async function getExecLogs(
  storePath: string,
  options: ExecLogsOptions
): Promise<ExecLogsResult> {
  const store = await loadRunStore(storePath);
  const validation = evaluateRunStore(store);
  ensureValidOrThrow(validation, storePath);

  const run = findRun(store, options.run_id, storePath);

  let entries = run.logs ?? [];

  if (options.level) {
    entries = entries.filter((entry) => entry.level === options.level);
  }

  if (options.tail !== undefined && options.tail > 0) {
    entries = entries.slice(-options.tail);
  }

  return {
    run_id: run.run_id,
    total: entries.length,
    entries
  };
}

export async function getExecReceipt(
  storePath: string,
  options: ExecReceiptOptions
): Promise<ExecReceiptResult> {
  const store = await loadRunStore(storePath);
  const validation = evaluateRunStore(store);
  ensureValidOrThrow(validation, storePath);

  const run = findRun(store, options.run_id, storePath);

  const allLogs = run.logs ?? [];
  const logSummary = {
    total: allLogs.length,
    info: allLogs.filter((e) => e.level === "info").length,
    warn: allLogs.filter((e) => e.level === "warn").length,
    error: allLogs.filter((e) => e.level === "error").length
  };

  const durationMs = computeDurationMs(run);
  const summary = buildSummaryText(run, durationMs);

  return {
    run_id: run.run_id,
    command: run.command,
    state: run.state,
    created_at: run.created_at,
    ...(run.started_at ? { started_at: run.started_at } : {}),
    ...(run.completed_at ? { completed_at: run.completed_at } : {}),
    ...(run.exit_code !== undefined ? { exit_code: run.exit_code } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    ...(run.metadata ? { metadata: run.metadata } : {}),
    log_summary: logSummary,
    summary
  };
}

export { VALID_TRANSITIONS, TERMINAL_STATES };
