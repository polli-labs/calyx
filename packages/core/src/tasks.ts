import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type {
  CodexAutomationDocument,
  DomainValidationIssue,
  TaskInstallTarget,
  TaskListItem,
  TaskManifest,
  TaskManifestDocument,
  TaskReasoningEffort,
  TaskRenderLoss,
  TaskRenderPreflightReceipt,
  TaskStatus,
  TasksCodexImportItem,
  TasksCodexImportOptions,
  TasksCodexImportResult,
  TasksCodexRenderOptions,
  TasksCodexRenderPreflightOptions,
  TasksCodexRenderResult,
  TasksListOptions,
  TasksListResult,
  TasksShowResult,
  TasksValidateOptions,
  TasksValidateResult,
} from "./types";

const taskStatusValues = ["draft", "active", "paused", "retired", "failed_needs_attention"] as const;
const taskStatusSchema = z.enum(taskStatusValues);

const taskIdSchema = z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/);

const scheduleTriggerSchema = z
  .object({
    type: z.literal("schedule"),
    rrule: z.string().trim().min(1).optional(),
    predicate: z
      .object({
        schema_version: z.literal("predicate/v1"),
        kind: z.string().trim().min(1),
      })
      .passthrough()
      .optional(),
    timezone: z.string().trim().min(1).optional(),
    misfire_policy: z.string().trim().min(1).optional(),
  })
  .passthrough();

const taskTriggerSchema = z.union([
  scheduleTriggerSchema,
  z.object({ type: z.literal("manual") }).passthrough(),
  z.object({ type: z.literal("event"), event: z.string().trim().min(1).optional() }).passthrough(),
]);

const taskRuntimeBackendSchema = z.enum(["calyx", "codex_app", "claude_desktop", "claude_routine"]);
const taskReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);

const taskWorkspaceSchema = z
  .object({
    mode: z.string().trim().min(1).optional(),
    cwd: z.string().trim().min(1).optional(),
    cwds: z.array(z.string().trim().min(1)).optional(),
  })
  .passthrough();

const taskRuntimeSchema = z
  .object({
    backend: taskRuntimeBackendSchema,
    agent: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    reasoning_effort: taskReasoningEffortSchema.optional(),
    execution_environment: z.string().trim().min(1).optional(),
    workspace: taskWorkspaceSchema.optional(),
  })
  .passthrough();

const taskPromptSchema = z
  .object({
    body: z.string().min(1),
    skills: z.array(z.string().trim().min(1)).optional(),
  })
  .passthrough();

const taskStateSchema = z
  .object({
    memory: z.string().trim().min(1).optional(),
    control: z.string().trim().min(1).optional(),
    outputs: z.array(z.string().trim().min(1)).optional(),
  })
  .passthrough();

const taskSafetySchema = z
  .object({
    max_concurrency: z.number().int().positive().optional(),
    timeout_minutes: z.number().int().positive().optional(),
    stale_lock_minutes: z.number().int().positive().optional(),
    unattended_writes: z.string().trim().min(1).optional(),
    destructive_actions: z.string().trim().min(1).optional(),
    requires_activity_quiet_window: z.boolean().optional(),
  })
  .passthrough();

const taskInstallTargetSchema = z
  .object({
    host: z.string().trim().min(1),
    backend: taskRuntimeBackendSchema,
    status: z.enum(["active", "paused", "retired", "draft"]).optional(),
  })
  .passthrough();

const taskInstallSchema = z
  .object({
    targets: z.array(taskInstallTargetSchema).optional(),
  })
  .passthrough();

const taskManifestSchema = z
  .object({
    version: z.literal(1),
    id: taskIdSchema,
    name: z.string().trim().min(1),
    status: taskStatusSchema,
    kind: z.literal("task").optional(),
    owner: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    triggers: z.array(taskTriggerSchema).min(1),
    runtime: taskRuntimeSchema,
    prompt: taskPromptSchema,
    state: taskStateSchema.optional(),
    safety: taskSafetySchema.optional(),
    install: taskInstallSchema.optional(),
  })
  .passthrough();

const codexAutomationSchema = z
  .object({
    version: z.literal(1),
    id: taskIdSchema,
    kind: z.literal("cron"),
    name: z.string().trim().min(1),
    prompt: z.string().min(1),
    status: z.enum(["ACTIVE", "PAUSED"]),
    rrule: z.string().trim().min(1),
    model: z.string().trim().min(1).optional(),
    reasoning_effort: taskReasoningEffortSchema.optional(),
    execution_environment: z.enum(["local", "sandbox"]).optional(),
    cwds: z.array(z.string().trim().min(1)).optional(),
    created_at: z.number().int().nonnegative().optional(),
    updated_at: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export class TaskLookupError extends Error {
  readonly id: string;
  readonly suggestions: string[];

  constructor(id: string, suggestions: string[]) {
    super(`Task "${id}" was not found.`);
    this.id = id;
    this.suggestions = suggestions;
  }
}

export class TaskRenderError extends Error {
  readonly exitCode = 3;

  constructor(readonly receipt: TaskRenderPreflightReceipt) {
    const details = receipt.losses
      .map((loss) => `${loss.path}: ${loss.message}`)
      .join("; ");
    super(
      `Task "${receipt.task_id}" cannot be rendered as a Codex app automation without semantic loss.${
        details ? ` ${details}` : ""
      }`,
    );
    this.name = "TaskRenderError";
  }
}

function toIssue(code: string, message: string, issuePath?: string): DomainValidationIssue {
  return {
    code,
    message,
    ...(issuePath ? { path: issuePath } : {}),
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

async function collectTaskManifestPaths(tasksDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (entry.isFile() && /\.task\.ya?ml$/i.test(entry.name)) {
        files.push(absolutePath);
      }
    }
  }

  await walk(path.resolve(tasksDir));
  return files.sort();
}

function relativePath(tasksDir: string, filePath: string): string {
  return path.relative(path.resolve(tasksDir), path.resolve(filePath)) || path.basename(filePath);
}

async function parseTaskManifestFile(tasksDir: string, manifestPath: string): Promise<{
  document?: TaskManifestDocument;
  error?: DomainValidationIssue;
}> {
  const displayPath = relativePath(tasksDir, manifestPath);
  let text = "";
  try {
    text = await readFile(manifestPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: toIssue("tasks.read-failed", `Failed to read task manifest: ${message}`, displayPath) };
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = YAML.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: toIssue("tasks.yaml-parse-failed", `Failed to parse YAML: ${message}`, displayPath) };
  }

  const parsedTask = taskManifestSchema.safeParse(parsedYaml);
  if (!parsedTask.success) {
    return {
      error: toIssue(
        "tasks.invalid-schema",
        `Invalid task manifest schema: ${formatSchemaError(parsedTask.error)}`,
        displayPath,
      ),
    };
  }

  return {
    document: {
      manifestPath,
      task: parsedTask.data as TaskManifest,
    },
  };
}

async function loadTaskManifestDocuments(tasksDir: string): Promise<{
  documents: TaskManifestDocument[];
  errors: DomainValidationIssue[];
}> {
  const manifestPaths = await collectTaskManifestPaths(tasksDir);
  const documents: TaskManifestDocument[] = [];
  const errors: DomainValidationIssue[] = [];

  for (const manifestPath of manifestPaths) {
    const result = await parseTaskManifestFile(tasksDir, manifestPath);
    if (result.error) {
      errors.push(result.error);
      continue;
    }
    if (result.document) {
      documents.push(result.document);
    }
  }

  return { documents, errors };
}

function evaluateTaskDocuments(
  tasksDir: string,
  documents: TaskManifestDocument[],
  initialErrors: DomainValidationIssue[],
  options: TasksValidateOptions = {},
): TasksValidateResult {
  const strict = options.strict ?? false;
  const errors = [...initialErrors];
  const warnings: DomainValidationIssue[] = [];
  const ids = new Map<string, string>();
  const counts: Record<TaskStatus, number> = {
    draft: 0,
    active: 0,
    paused: 0,
    retired: 0,
    failed_needs_attention: 0,
  };

  for (const document of documents) {
    const displayPath = relativePath(tasksDir, document.manifestPath);
    const task = document.task;
    counts[task.status] += 1;

    const previousPath = ids.get(task.id);
    if (previousPath) {
      errors.push(
        toIssue(
          "tasks.duplicate-id",
          `Duplicate task id "${task.id}" also appears in ${previousPath}.`,
          `${displayPath}:id`,
        ),
      );
    } else {
      ids.set(task.id, displayPath);
    }

    for (const [index, trigger] of task.triggers.entries()) {
      if (trigger.type !== "schedule") {
        continue;
      }
      if (!trigger.rrule && !trigger.predicate) {
        errors.push(
          toIssue(
            "tasks.schedule-missing-trigger",
            `Scheduled task "${task.id}" must set either rrule or predicate/v1.`,
            `${displayPath}:triggers[${index}]`,
          ),
        );
      }
      if (trigger.rrule && !trigger.timezone) {
        const issue = toIssue(
          "tasks.schedule-missing-timezone",
          `Scheduled task "${task.id}" should set an explicit timezone.`,
          `${displayPath}:triggers[${index}].timezone`,
        );
        if (strict) {
          errors.push(issue);
        } else {
          warnings.push(issue);
        }
      }
    }
  }

  return {
    tasksDir: path.resolve(tasksDir),
    ok: errors.length === 0,
    errors,
    warnings,
    total: documents.length,
    ...counts,
  };
}

function ensureValidTasks(validation: TasksValidateResult, tasksDir: string): void {
  if (validation.ok) {
    return;
  }

  const details = validation.errors
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("; ");
  throw new Error(`Task manifest validation failed in ${path.resolve(tasksDir)}: ${details}`);
}

function toTaskListItem(document: TaskManifestDocument): TaskListItem {
  const task = document.task;
  return {
    id: task.id,
    name: task.name,
    status: task.status,
    manifestPath: document.manifestPath,
    ...(task.description ? { description: task.description } : {}),
    runtimeBackend: task.runtime.backend,
    ...(task.runtime.agent ? { agent: task.runtime.agent } : {}),
    ...(task.runtime.model ? { model: task.runtime.model } : {}),
    installTargets: task.install?.targets ?? [],
  };
}

function includeTaskByStatus(status: TaskStatus, options: TasksListOptions): boolean {
  if (options.statuses && options.statuses.length > 0) {
    return options.statuses.includes(status);
  }
  if (status === "paused") {
    return Boolean(options.includePaused);
  }
  if (status === "retired") {
    return Boolean(options.includeRetired);
  }
  return true;
}

export function isTaskStatus(value: string): value is TaskStatus {
  return (taskStatusValues as readonly string[]).includes(value);
}

export async function validateTasks(
  tasksDir: string,
  options: TasksValidateOptions = {},
): Promise<TasksValidateResult> {
  const loaded = await loadTaskManifestDocuments(tasksDir);
  return evaluateTaskDocuments(tasksDir, loaded.documents, loaded.errors, options);
}

export async function listTasks(
  tasksDir: string,
  options: TasksListOptions = {},
): Promise<TasksListResult> {
  const loaded = await loadTaskManifestDocuments(tasksDir);
  const validation = evaluateTaskDocuments(tasksDir, loaded.documents, loaded.errors);
  ensureValidTasks(validation, tasksDir);

  const items = loaded.documents
    .map(toTaskListItem)
    .filter((item) => includeTaskByStatus(item.status, options));

  return {
    tasksDir: path.resolve(tasksDir),
    total: loaded.documents.length,
    items,
  };
}

export async function showTask(tasksDir: string, taskId: string): Promise<TasksShowResult> {
  const loaded = await loadTaskManifestDocuments(tasksDir);
  const validation = evaluateTaskDocuments(tasksDir, loaded.documents, loaded.errors);
  ensureValidTasks(validation, tasksDir);

  const document = loaded.documents.find((candidate) => candidate.task.id === taskId);
  if (!document) {
    throw new TaskLookupError(taskId, loaded.documents.map((candidate) => candidate.task.id).sort());
  }

  return {
    tasksDir: path.resolve(tasksDir),
    manifestPath: document.manifestPath,
    task: document.task,
  };
}

function codexStatusToTaskStatus(status: "ACTIVE" | "PAUSED"): TaskStatus {
  return status === "ACTIVE" ? "active" : "paused";
}

function taskStatusToCodexStatus(status: "active" | "paused"): "ACTIVE" | "PAUSED" {
  return status === "active" ? "ACTIVE" : "PAUSED";
}

function readCodexAutomationToml(tomlText: string, automationPath: string): CodexAutomationDocument {
  let parsedToml: unknown;
  try {
    parsedToml = parseToml(tomlText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse Codex automation TOML at ${automationPath}: ${message}`);
  }

  const parsedAutomation = codexAutomationSchema.safeParse(parsedToml);
  if (!parsedAutomation.success) {
    throw new Error(
      `Invalid Codex automation TOML at ${automationPath}: ${formatSchemaError(parsedAutomation.error)}`,
    );
  }

  const data = parsedAutomation.data;
  return {
    ...data,
    created_at: data.created_at ?? Date.now(),
    updated_at: data.updated_at ?? Date.now(),
  } as CodexAutomationDocument;
}

function codexAutomationToTask(automation: CodexAutomationDocument, automationPath: string): {
  task: TaskManifest;
  warnings: DomainValidationIssue[];
} {
  const warnings: DomainValidationIssue[] = [];
  const cwds = automation.cwds ?? [];
  const firstCwd = cwds[0];
  if (cwds.length > 1) {
    warnings.push(
      toIssue(
        "tasks.codex-import-multiple-cwds",
        `Codex automation "${automation.id}" has multiple cwds; preserving all in runtime.workspace.cwds and using the first as cwd.`,
        automationPath,
      ),
    );
  }
  warnings.push(
    toIssue(
      "tasks.codex-import-timezone-unset",
      `Codex automation "${automation.id}" does not expose an explicit timezone; leaving trigger.timezone unset so validation remains advisory instead of inventing one.`,
      automationPath,
    ),
  );
  warnings.push(
    toIssue(
      "tasks.codex-import-local-memory",
      `Codex automation "${automation.id}" may have host-local memory beside automation.toml; leaving task state.memory unset so the imported manifest stays portable.`,
      automationPath,
    ),
  );

  const task: TaskManifest = {
    version: 1,
    kind: "task",
    id: automation.id,
    name: automation.name,
    status: codexStatusToTaskStatus(automation.status),
    triggers: [
      {
        type: "schedule",
        rrule: automation.rrule,
      },
    ],
    runtime: {
      backend: "codex_app",
      agent: "codex",
      ...(automation.model ? { model: automation.model } : {}),
      ...(automation.reasoning_effort ? { reasoning_effort: automation.reasoning_effort } : {}),
      ...(automation.execution_environment ? { execution_environment: automation.execution_environment } : {}),
      workspace: {
        ...(firstCwd ? { cwd: firstCwd } : {}),
        ...(cwds.length > 0 ? { cwds } : {}),
      },
    },
    prompt: {
      body: automation.prompt,
    },
    install: {
      targets: [
        {
          host: "local",
          backend: "codex_app",
          status: codexStatusToTaskStatus(automation.status) === "active" ? "active" : "paused",
        },
      ],
    },
    imported_from: {
      backend: "codex_app",
      automation_path: automationPath,
      created_at: automation.created_at,
      updated_at: automation.updated_at,
    },
  };

  return { task, warnings };
}

function renderTaskYaml(task: TaskManifest): string {
  return `${YAML.stringify(task).trimEnd()}\n`;
}

async function importOneCodexAutomation(
  codexHome: string,
  outDir: string,
  automationId: string,
): Promise<TasksCodexImportItem> {
  const automationPath = path.join(path.resolve(codexHome), "automations", automationId, "automation.toml");
  const text = await readFile(automationPath, "utf8");
  const automation = readCodexAutomationToml(text, automationPath);
  const { task, warnings } = codexAutomationToTask(automation, automationPath);
  const outputPath = path.join(path.resolve(outDir), `${task.id}.task.yaml`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderTaskYaml(task), "utf8");

  return {
    id: task.id,
    sourcePath: automationPath,
    outputPath,
    task,
    warnings,
  };
}

async function listCodexAutomationIds(codexHome: string): Promise<string[]> {
  const automationsDir = path.join(path.resolve(codexHome), "automations");
  const entries = await readdir(automationsDir, { withFileTypes: true });
  const ids: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    ids.push(entry.name);
  }
  return ids;
}

export async function importCodexAutomationTasks(
  options: TasksCodexImportOptions,
): Promise<TasksCodexImportResult> {
  const ids = options.id ? [options.id] : await listCodexAutomationIds(options.codexHome);
  const imported: TasksCodexImportItem[] = [];
  for (const id of ids) {
    imported.push(await importOneCodexAutomation(options.codexHome, options.outDir, id));
  }

  return {
    codexHome: path.resolve(options.codexHome),
    outDir: path.resolve(options.outDir),
    imported,
  };
}

interface IndexedCodexTarget {
  target: TaskInstallTarget;
  index: number | null;
  path: string;
}

interface CodexRenderPlan {
  target: TaskInstallTarget;
  schedule: Extract<TaskManifest["triggers"][number], { type: "schedule" }> & { rrule: string };
  executionEnvironment: "local" | "sandbox";
  cwds: string[];
  status: "active" | "paused";
}

interface CodexRenderPreflight {
  receipt: TaskRenderPreflightReceipt;
  plan?: CodexRenderPlan;
}

function fieldPath(basePath: string, key: string): string {
  if (basePath.length === 0) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      ? key
      : `[${JSON.stringify(key)}]`;
  }
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? `${basePath}.${key}`
    : `${basePath}[${JSON.stringify(key)}]`;
}

function appendUnrepresentableFields(
  losses: TaskRenderLoss[],
  value: Record<string, unknown>,
  representedKeys: readonly string[],
  basePath: string,
  code: TaskRenderLoss["code"],
  subject: string,
): void {
  const represented = new Set(representedKeys);
  for (const key of Object.keys(value).sort()) {
    if (represented.has(key)) {
      continue;
    }
    const lossPath = fieldPath(basePath, key);
    losses.push({
      code,
      path: lossPath,
      message: `${subject} field ${lossPath} is not represented by Codex automation.toml.`,
    });
  }
}

function buildCodexRenderPreflight(
  task: TaskManifest,
  options: TasksCodexRenderPreflightOptions = {},
): CodexRenderPreflight {
  const losses: TaskRenderLoss[] = [];
  appendUnrepresentableFields(
    losses,
    task,
    [
      "version",
      "kind",
      "id",
      "name",
      "status",
      "triggers",
      "runtime",
      "prompt",
      "state",
      "safety",
      "install",
      "imported_from",
    ],
    "",
    "manifest.field_not_representable",
    "Manifest",
  );
  const requestedHost = options.host ?? null;
  const codexTargets = (task.install?.targets ?? [])
    .map((target, index) => ({ target, index, path: `install.targets[${index}]` }))
    .filter(({ target }) => target.backend === "codex_app");
  const matchingTargets = requestedHost === null
    ? codexTargets
    : codexTargets.filter(({ target }) => target.host === requestedHost);
  let selectedTarget: IndexedCodexTarget | undefined;

  if (matchingTargets.length === 1) {
    selectedTarget = matchingTargets[0];
  } else if (matchingTargets.length > 1) {
    losses.push({
      code: "target.ambiguous",
      path: "install.targets",
      message: `Task has ${matchingTargets.length} matching Codex app install targets. Pass --host to select one.`,
    });
  } else if (requestedHost !== null) {
    losses.push({
      code: "target.missing",
      path: "install.targets",
      message: `Task has no Codex app install target for host "${requestedHost}".`,
    });
  } else if (codexTargets.length === 0 && task.runtime.backend === "codex_app") {
    selectedTarget = {
      target: {
        host: "local",
        backend: "codex_app",
      },
      index: null,
      path: "runtime.backend",
    };
  } else {
    losses.push({
      code: "target.missing",
      path: "install.targets",
      message: "Task has no Codex app install target.",
    });
  }

  const rruleScheduleIndexes = task.triggers
    .map((trigger, index) => ({ trigger, index }))
    .filter(({ trigger }) =>
      trigger.type === "schedule"
      && typeof trigger.rrule === "string"
      && trigger.rrule.trim().length > 0
    )
    .map(({ index }) => index);
  const scheduleIndexes = task.triggers
    .map((trigger, index) => ({ trigger, index }))
    .filter(({ trigger }) => trigger.type === "schedule")
    .map(({ index }) => index);
  const primaryScheduleIndex = rruleScheduleIndexes[0] ?? scheduleIndexes[0];
  let schedule: CodexRenderPlan["schedule"] | undefined;

  if (primaryScheduleIndex === undefined) {
    losses.push({
      code: "trigger.missing_rrule",
      path: "triggers",
      message: "Codex automation render requires one schedule trigger with rrule.",
    });
  } else {
    const primarySchedule = task.triggers[primaryScheduleIndex];
    if (primarySchedule?.type !== "schedule" || !primarySchedule.rrule) {
      losses.push({
        code: "trigger.missing_rrule",
        path: `triggers[${primaryScheduleIndex}].rrule`,
        message: "Codex automation render requires a non-empty rrule.",
      });
    } else {
      schedule = primarySchedule as CodexRenderPlan["schedule"];
    }

    if (primarySchedule?.type === "schedule") {
      if (Object.hasOwn(primarySchedule, "timezone")) {
        losses.push({
          code: "trigger.field_not_representable",
          path: `triggers[${primaryScheduleIndex}].timezone`,
          message: "Codex automation.toml does not carry an explicit schedule timezone.",
        });
      }
      if (Object.hasOwn(primarySchedule, "misfire_policy")) {
        losses.push({
          code: "trigger.field_not_representable",
          path: `triggers[${primaryScheduleIndex}].misfire_policy`,
          message: "Codex automation.toml does not carry schedule misfire policy.",
        });
      }
      if (Object.hasOwn(primarySchedule, "predicate")) {
        losses.push({
          code: "trigger.field_not_representable",
          path: `triggers[${primaryScheduleIndex}].predicate`,
          message: "Codex automation.toml cannot preserve a predicate/v1 trigger.",
        });
      }
      appendUnrepresentableFields(
        losses,
        primarySchedule,
        ["type", "rrule", "timezone", "misfire_policy", "predicate"],
        `triggers[${primaryScheduleIndex}]`,
        "trigger.field_not_representable",
        "Trigger",
      );
    }
  }

  for (const index of task.triggers.keys()) {
    if (index === primaryScheduleIndex) {
      continue;
    }
    losses.push({
      code: "trigger.extra",
      path: `triggers[${index}]`,
      message: "Codex automation.toml represents exactly one schedule trigger; this trigger would be dropped.",
    });
  }

  appendUnrepresentableFields(
    losses,
    task.prompt,
    ["body"],
    "prompt",
    "prompt.field_not_representable",
    "Prompt",
  );

  if (task.state) {
    appendUnrepresentableFields(
      losses,
      task.state,
      [],
      "state",
      "state.field_not_representable",
      "State",
    );
  }

  if (task.safety) {
    appendUnrepresentableFields(
      losses,
      task.safety,
      [],
      "safety",
      "safety.field_not_representable",
      "Safety",
    );
  }

  if (task.runtime.backend !== "codex_app") {
    losses.push({
      code: "runtime.backend_not_codex",
      path: "runtime.backend",
      message: `Codex render cannot preserve runtime backend "${task.runtime.backend}".`,
    });
  }
  if (task.runtime.agent !== undefined && task.runtime.agent !== "codex") {
    losses.push({
      code: "runtime.agent_not_codex",
      path: "runtime.agent",
      message: `Codex render cannot preserve runtime agent "${task.runtime.agent}".`,
    });
  }

  let executionEnvironment: CodexRenderPlan["executionEnvironment"] | undefined;
  const requestedEnvironment = task.runtime.execution_environment;
  if (requestedEnvironment === undefined) {
    executionEnvironment = "local";
  } else if (requestedEnvironment === "local" || requestedEnvironment === "sandbox") {
    executionEnvironment = requestedEnvironment;
  } else {
    losses.push({
      code: "runtime.execution_environment_not_supported",
      path: "runtime.execution_environment",
      message: `Codex automation.toml supports local or sandbox, not "${requestedEnvironment}".`,
    });
  }
  appendUnrepresentableFields(
    losses,
    task.runtime,
    ["backend", "agent", "model", "reasoning_effort", "execution_environment", "workspace"],
    "runtime",
    "runtime.field_not_representable",
    "Runtime",
  );

  let cwds: string[] | undefined;
  const workspace = task.runtime.workspace;
  if (!workspace) {
    losses.push({
      code: "workspace.missing",
      path: "runtime.workspace",
      message: "Codex automation render requires runtime.workspace.cwd or runtime.workspace.cwds.",
    });
  } else {
    if (Object.hasOwn(workspace, "mode")) {
      losses.push({
        code: "workspace.field_not_representable",
        path: "runtime.workspace.mode",
        message: "Codex automation.toml does not carry workspace mode.",
      });
    }
    appendUnrepresentableFields(
      losses,
      workspace,
      ["mode", "cwd", "cwds"],
      "runtime.workspace",
      "workspace.field_not_representable",
      "Workspace",
    );

    const hasCwd = typeof workspace.cwd === "string" && workspace.cwd.length > 0;
    const hasCwds = Array.isArray(workspace.cwds);
    if (hasCwd && hasCwds && (workspace.cwds!.length === 0 || workspace.cwds![0] !== workspace.cwd)) {
      losses.push({
        code: "workspace.cwd_conflict",
        path: "runtime.workspace.cwd",
        related_paths: ["runtime.workspace.cwds[0]"],
        message: "runtime.workspace.cwd must equal runtime.workspace.cwds[0] when both are declared.",
      });
    }
    if (hasCwds && workspace.cwds!.length > 0) {
      cwds = workspace.cwds!;
    } else if (hasCwd) {
      cwds = [workspace.cwd!];
    } else {
      losses.push({
        code: "workspace.missing",
        path: hasCwds ? "runtime.workspace.cwds" : "runtime.workspace",
        message: "Codex automation render requires a non-empty cwd or cwds list.",
      });
    }
  }

  let status: CodexRenderPlan["status"] | undefined;
  let statusSourcePath = "status";
  if (selectedTarget) {
    if (selectedTarget.index !== null && selectedTarget.target.status !== undefined) {
      statusSourcePath = `${selectedTarget.path}.status`;
    }
    const selectedStatus = selectedTarget.target.status ?? task.status;
    if (selectedStatus === "active" || selectedStatus === "paused") {
      status = selectedStatus;
    } else {
      losses.push({
        code: "status.not_representable",
        path: statusSourcePath,
        message: `Codex automation.toml supports active or paused, not "${selectedStatus}".`,
      });
    }
    if (selectedTarget.index !== null) {
      appendUnrepresentableFields(
        losses,
        selectedTarget.target,
        ["host", "backend", "status"],
        selectedTarget.path,
        "target.field_not_representable",
        "Selected install target",
      );
    }
  }

  const receipt: TaskRenderPreflightReceipt = {
    schema_version: "calyx.task-render-preflight/v1",
    renderer: "codex_app",
    task_id: task.id,
    ...(options.manifestPath ? { manifest_path: options.manifestPath } : {}),
    requested_host: requestedHost,
    selected_target: selectedTarget
      ? {
          index: selectedTarget.index,
          path: selectedTarget.path,
          host: selectedTarget.target.host,
          status_source_path: statusSourcePath,
        }
      : null,
    ok: losses.length === 0,
    losses,
  };

  if (
    !receipt.ok
    || !selectedTarget
    || !schedule
    || !executionEnvironment
    || !cwds
    || !status
  ) {
    return { receipt };
  }
  return {
    receipt,
    plan: {
      target: selectedTarget.target,
      schedule,
      executionEnvironment,
      cwds,
      status,
    },
  };
}

export function preflightCodexTaskRender(
  task: TaskManifest,
  options: TasksCodexRenderPreflightOptions = {},
): TaskRenderPreflightReceipt {
  return buildCodexRenderPreflight(task, options).receipt;
}

function getImportedCodexCreatedAt(task: TaskManifest): number | undefined {
  const importedFrom = task.imported_from;
  if (!importedFrom || typeof importedFrom !== "object" || Array.isArray(importedFrom)) {
    return undefined;
  }
  const createdAt = (importedFrom as Record<string, unknown>).created_at;
  return typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : undefined;
}

export async function renderCodexAutomationTask(
  options: TasksCodexRenderOptions,
): Promise<TasksCodexRenderResult> {
  const shown = await showTask(options.tasksDir, options.taskId);
  const task = shown.task;
  const preflight = buildCodexRenderPreflight(task, {
    ...(options.host ? { host: options.host } : {}),
    manifestPath: shown.manifestPath,
  });
  if (!preflight.plan) {
    throw new TaskRenderError(preflight.receipt);
  }
  const { target, schedule, executionEnvironment, cwds, status: selectedStatus } = preflight.plan;
  const warnings: DomainValidationIssue[] = [];
  const timestamp = options.now?.getTime() ?? Date.now();
  const createdAt = getImportedCodexCreatedAt(task) ?? timestamp;
  const status = taskStatusToCodexStatus(selectedStatus);

  const automation: CodexAutomationDocument = {
    version: 1,
    id: task.id,
    kind: "cron",
    name: task.name,
    prompt: task.prompt.body,
    status,
    rrule: schedule.rrule,
    ...(task.runtime.model ? { model: task.runtime.model } : {}),
    ...(task.runtime.reasoning_effort ? { reasoning_effort: task.runtime.reasoning_effort as TaskReasoningEffort } : {}),
    execution_environment: executionEnvironment,
    cwds,
    created_at: createdAt,
    updated_at: timestamp,
  };
  const tomlText = stringifyToml(automation as never);
  const automationDir = path.join(path.resolve(options.outDir), task.id);
  const automationPath = path.join(automationDir, "automation.toml");
  await mkdir(automationDir, { recursive: true });
  await writeFile(automationPath, tomlText, "utf8");

  return {
    id: automation.id,
    taskId: task.id,
    host: target.host,
    outDir: path.resolve(options.outDir),
    automationDir,
    automationPath,
    automation,
    tomlText,
    warnings,
  };
}
