import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { parse as parseToml } from "@iarna/toml";
import YAML from "yaml";
import { z } from "zod";

import { loadStateDriver, type StateDriverDatabase } from "./state/driver";
import { hashTaskManifest } from "./state/task-lifecycle";
import {
  listTasks,
  preflightCodexTaskRender,
  showTask,
  validateTasks,
} from "./tasks";
import type {
  CodexAutomationClassification,
  CodexAutomationGovernanceObservation,
  CodexAutomationMutationAuthority,
  CodexAutomationObservationFinding,
  CodexAutomationObservationItem,
  CodexAutomationProjectionRow,
  CodexAutomationProjectionStatus,
  ObserveCodexAutomationsOptions,
  ObserveCodexAutomationsResult,
  TaskManifestDocument,
} from "./types";

const observedAutomationSchema = z.object({
  version: z.literal(1),
  id: z.string().trim().min(1),
  kind: z.literal("cron"),
  name: z.string().trim().min(1),
  prompt: z.string(),
  status: z.enum(["ACTIVE", "PAUSED"]),
  rrule: z.string().trim().min(1),
  cwds: z.array(z.string()).optional(),
}).passthrough();

interface ObservedAutomationDefinition extends z.infer<typeof observedAutomationSchema> {
  cwds?: string[];
}

interface GovernanceEntry {
  id: string;
  sourcePath: string;
  digest: string;
  status: "ACTIVE" | "PAUSED";
  rrule: string;
  cwds: string[] | null;
  expiresAt: string | null;
  classification: string;
}

const governanceImportedSourceSchema = z.object({
  backend: z.literal("codex_app"),
  id: z.string().trim().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).passthrough();

const governanceObservedSchema = z.object({
  status: z.enum(["ACTIVE", "PAUSED"]),
  schedule: z.string().trim().min(1),
  // An explicit null means the TOML omitted cwds. Missing is invalid.
  cwds: z.union([z.array(z.string()), z.null()]),
}).passthrough();

const activeGovernanceEntrySchema = z.object({
  imported_source: governanceImportedSourceSchema,
  observed: governanceObservedSchema.extend({ status: z.literal("ACTIVE") }),
  decision_owner: z.string().trim().min(1),
  decision: z.object({
    classification: z.literal("explicit_time_bounded_exemption"),
    owner: z.string().trim().min(1),
    expires_at: z.string().trim().min(1),
  }).passthrough(),
}).passthrough();

const pausedProjectGovernanceEntrySchema = z.object({
  imported_source: governanceImportedSourceSchema,
  observed: governanceObservedSchema.extend({ status: z.literal("PAUSED") }),
  decision_owner: z.string().trim().min(1),
  classification: z.literal("distinct_paused_project_binding"),
}).passthrough();

const pausedResidueGovernanceEntrySchema = z.object({
  imported_source: governanceImportedSourceSchema,
  observed: governanceObservedSchema.extend({ status: z.literal("PAUSED") }),
  decision_owner: z.string().trim().min(1),
  classification: z.literal("paused_monitor_wake_residue"),
}).passthrough();

const governanceRegistrySchema = z.object({
  version: z.literal(1),
  kind: z.literal("codex_desktop_automation_exemption_registry"),
  owner: z.string().trim().min(1),
  decision_owner: z.string().trim().min(1),
  active_exemptions: z.array(activeGovernanceEntrySchema),
  paused_project_bindings: z.array(pausedProjectGovernanceEntrySchema),
  paused_monitor_wake_residues: z.array(pausedResidueGovernanceEntrySchema),
}).passthrough();

interface CalyxInstallProjection {
  install_id: string;
  task_id: string;
  manifest_hash: string;
  status: string;
}

export interface CodexAutomationObserverDependencies {
  readText?: (filePath: string) => Promise<string>;
  statFile?: typeof stat;
  readDirectory?: typeof readdir;
  pathExists?: (filePath: string) => Promise<boolean>;
  openReadOnlyDatabase?: (filePath: string) => Promise<StateDriverDatabase>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function finding(
  code: string,
  severity: CodexAutomationObservationFinding["severity"],
  message: string,
  details: Partial<CodexAutomationObservationFinding> = {},
): CodexAutomationObservationFinding {
  return { code, severity, message, ...details };
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseJsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseProjectionRow(row: Record<string, unknown>): CodexAutomationProjectionRow {
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    status: String(row.status ?? ""),
    rrule: String(row.rrule ?? ""),
    cwds: parseJsonStringArray(row.cwds),
    next_run_at: typeof row.next_run_at === "number" ? row.next_run_at : null,
    last_run_at: typeof row.last_run_at === "number" ? row.last_run_at : null,
  };
}

async function defaultOpenReadOnlyDatabase(filePath: string): Promise<StateDriverDatabase> {
  const driver = await loadStateDriver();
  return driver.openReadOnly(filePath);
}

async function defaultPathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function automationTableAvailable(db: StateDriverDatabase): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automations'",
  ).get() as { name?: unknown } | undefined;
  if (row?.name !== "automations") {
    return false;
  }
  const columns = db.prepare("PRAGMA table_info(automations)").all() as Array<{ name?: unknown }>;
  const names = new Set(columns.map((column) => String(column.name ?? "")));
  return ["id", "name", "status", "rrule", "cwds", "next_run_at", "last_run_at"]
    .every((name) => names.has(name));
}

async function readProjectionRows(
  databasePath: string | undefined,
  deps: Required<Pick<CodexAutomationObserverDependencies, "pathExists" | "openReadOnlyDatabase">>,
): Promise<{ rows: Map<string, CodexAutomationProjectionRow>; error: string | null }> {
  if (!databasePath) {
    return { rows: new Map(), error: "Codex runtime projection database was not selected." };
  }
  if (!await deps.pathExists(databasePath)) {
    return { rows: new Map(), error: `Codex runtime projection database is missing: ${databasePath}` };
  }
  let db: StateDriverDatabase | undefined;
  try {
    db = await deps.openReadOnlyDatabase(databasePath);
    if (!automationTableAvailable(db)) {
      return { rows: new Map(), error: "Codex runtime projection database has no compatible automations table." };
    }
    const rawRows = db.prepare(
      `SELECT id, name, status, rrule, cwds, next_run_at, last_run_at
       FROM automations ORDER BY id`,
    ).all() as Record<string, unknown>[];
    return {
      rows: new Map(rawRows.map((row) => {
        const parsed = parseProjectionRow(row);
        return [parsed.id, parsed];
      })),
      error: null,
    };
  } catch (error) {
    return {
      rows: new Map(),
      error: `Codex runtime projection could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    db?.close();
  }
}

function parseGovernanceEntry(
  value: z.infer<typeof activeGovernanceEntrySchema>
    | z.infer<typeof pausedProjectGovernanceEntrySchema>
    | z.infer<typeof pausedResidueGovernanceEntrySchema>,
  sourcePath: string,
): GovernanceEntry {
  const decision = "decision" in value
    ? value.decision as { classification: string; expires_at: string }
    : null;
  const classification = decision?.classification
    ?? (value as { classification: string }).classification;
  return {
    id: value.imported_source.id,
    sourcePath,
    digest: value.imported_source.sha256,
    status: value.observed.status,
    rrule: value.observed.schedule,
    cwds: value.observed.cwds,
    expiresAt: decision?.expires_at ?? null,
    classification,
  };
}

async function loadGovernanceEntries(
  governancePath: string | undefined,
  readText: (filePath: string) => Promise<string>,
): Promise<{
  entries: Map<string, GovernanceEntry>;
  error: string | null;
  errorKind: "invalid" | "unavailable" | null;
}> {
  if (!governancePath) {
    return { entries: new Map(), error: null, errorKind: null };
  }
  try {
    const parsed = governanceRegistrySchema.safeParse(YAML.parse(await readText(governancePath)) as unknown);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
      return {
        entries: new Map(),
        error: `Codex automation governance registry is invalid: ${problems.join("; ")}`,
        errorKind: "invalid",
      };
    }
    const entries = [
      ...parsed.data.active_exemptions,
      ...parsed.data.paused_project_bindings,
      ...parsed.data.paused_monitor_wake_residues,
    ].map((value) => parseGovernanceEntry(value, governancePath));
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.id)) {
        duplicates.add(entry.id);
      }
      seen.add(entry.id);
    }
    if (duplicates.size > 0) {
      return {
        entries: new Map(),
        error: `Codex automation governance registry repeats imported_source ids: ${[...duplicates].sort().join(", ")}`,
        errorKind: "invalid",
      };
    }
    return {
      entries: new Map(entries.map((entry) => [entry.id, entry])),
      error: null,
      errorKind: null,
    };
  } catch (error) {
    return {
      entries: new Map(),
      error: `Codex automation governance registry could not be read: ${error instanceof Error ? error.message : String(error)}`,
      errorKind: "unavailable",
    };
  }
}

async function loadManifestDocuments(
  tasksDir: string | undefined,
  readText: (filePath: string) => Promise<string>,
): Promise<{ documents: Map<string, TaskManifestDocument>; digests: Map<string, string>; error: string | null }> {
  if (!tasksDir) {
    return { documents: new Map(), digests: new Map(), error: null };
  }
  try {
    const validation = await validateTasks(tasksDir);
    if (!validation.ok) {
      return {
        documents: new Map(),
        digests: new Map(),
        error: `Task manifest governance is invalid: ${validation.errors.map((item) => item.message).join("; ")}`,
      };
    }
    const listed = await listTasks(tasksDir, {
      statuses: ["draft", "active", "paused", "retired", "failed_needs_attention"],
    });
    const documents = new Map<string, TaskManifestDocument>();
    const digests = new Map<string, string>();
    for (const item of listed.items) {
      const shown = await showTask(tasksDir, item.id);
      documents.set(item.id, { manifestPath: shown.manifestPath, task: shown.task });
      digests.set(item.id, sha256(await readText(shown.manifestPath)));
    }
    return { documents, digests, error: null };
  } catch (error) {
    return {
      documents: new Map(),
      digests: new Map(),
      error: `Task manifest governance could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function loadCalyxInstalls(
  databasePath: string | undefined,
  deps: Required<Pick<CodexAutomationObserverDependencies, "pathExists" | "openReadOnlyDatabase">>,
): Promise<Map<string, CalyxInstallProjection>> {
  if (!databasePath || !await deps.pathExists(databasePath)) {
    return new Map();
  }
  let db: StateDriverDatabase | undefined;
  try {
    db = await deps.openReadOnlyDatabase(databasePath);
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_installs'",
    ).get() as { name?: unknown } | undefined;
    if (table?.name !== "task_installs") {
      return new Map();
    }
    const rows = db.prepare(
      `SELECT install_id, task_id, manifest_hash, status
       FROM task_installs ORDER BY updated_at DESC`,
    ).all() as CalyxInstallProjection[];
    const byTask = new Map<string, CalyxInstallProjection>();
    for (const row of rows) {
      if (!byTask.has(row.task_id)) {
        byTask.set(row.task_id, row);
      }
    }
    return byTask;
  } catch {
    return new Map();
  } finally {
    db?.close();
  }
}

function projectionStatus(
  definition: ObservedAutomationDefinition,
  row: CodexAutomationProjectionRow | undefined,
  projectionError: string | null,
): { status: CodexAutomationProjectionStatus; differences: Array<{ field: string; expected: unknown; observed: unknown }> } {
  if (projectionError) {
    return { status: "unavailable", differences: [] };
  }
  if (!row) {
    return { status: "missing", differences: [] };
  }
  const differences: Array<{ field: string; expected: unknown; observed: unknown }> = [];
  const expectedCwds = definition.cwds ?? [];
  const comparisons: Array<[string, unknown, unknown, boolean]> = [
    ["name", definition.name, row.name, definition.name === row.name],
    ["status", definition.status, row.status, definition.status === row.status],
    ["rrule", definition.rrule, row.rrule, definition.rrule === row.rrule],
    ["cwds", expectedCwds, row.cwds, sameStringArray(expectedCwds, row.cwds)],
  ];
  for (const [field, expected, observed, equal] of comparisons) {
    if (!equal) {
      differences.push({ field, expected, observed });
    }
  }
  return { status: differences.length === 0 ? "observed" : "drifted", differences };
}

function finiteCount(rrule: string): number | null {
  const match = /(?:^|;)COUNT=(\d+)(?:;|$)/iu.exec(rrule.replace(/^RRULE:/iu, ""));
  return match?.[1] ? Number(match[1]) : null;
}

function currentExemption(
  entry: GovernanceEntry,
  definition: ObservedAutomationDefinition,
  digest: string,
  now: Date,
): { status: CodexAutomationGovernanceObservation["status"]; findings: CodexAutomationObservationFinding[] } {
  const findings: CodexAutomationObservationFinding[] = [];
  const observedCwds = definition.cwds === undefined ? null : definition.cwds;
  const checks: Array<[string, unknown, unknown, boolean]> = [
    ["digest", entry.digest, digest, entry.digest === digest],
    ["status", entry.status, definition.status, entry.status === definition.status],
    ["rrule", entry.rrule, definition.rrule, entry.rrule === definition.rrule],
    ["cwds", entry.cwds, observedCwds,
      entry.cwds === null ? observedCwds === null : Array.isArray(observedCwds) && sameStringArray(entry.cwds, observedCwds)],
  ];
  for (const [field, expected, observed, equal] of checks) {
    if (!equal) {
      findings.push(finding(
        `tasks.codex-governance-${field}-drift`,
        "error",
        `Governance ${field} does not match the observed Codex definition.`,
        { automation_id: definition.id, expected, observed },
      ));
    }
  }
  if (entry.expiresAt !== null) {
    const expiresAt = Date.parse(entry.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
      findings.push(finding(
        "tasks.codex-governance-exemption-expired",
        "error",
        `Codex automation exemption expired at ${entry.expiresAt}.`,
        { automation_id: definition.id },
      ));
      return { status: "expired", findings };
    }
  }
  return { status: findings.length > 0 ? "drifted" : "current", findings };
}

function defaultGovernance(): CodexAutomationGovernanceObservation {
  return {
    kind: "none",
    source_path: null,
    source_digest: null,
    install_id: null,
    status: "missing",
    classification: null,
    loss_receipt: null,
  };
}

function invalidItem(args: {
  id: string;
  definitionPath: string;
  definitionStatus: CodexAutomationObservationItem["definition_status"];
  definitionDigest: string | null;
  mutationAuthority: CodexAutomationMutationAuthority;
  finding: CodexAutomationObservationFinding;
}): CodexAutomationObservationItem {
  return {
    id: args.id,
    definition_path: args.definitionPath,
    definition_status: args.definitionStatus,
    definition_digest: args.definitionDigest,
    definition_authority: "codex_toml",
    mutation_authority: args.mutationAuthority,
    name: null,
    status: null,
    rrule: null,
    cwds: null,
    projection: "unavailable",
    projection_row: null,
    governance: defaultGovernance(),
    classifications: ["definition_invalid"],
    duplicate_of: null,
    findings: [args.finding],
  };
}

async function stableReadDefinition(
  definitionPath: string,
  readText: (filePath: string) => Promise<string>,
  statFile: typeof stat,
): Promise<{ text: string; digest: string; changed: boolean }> {
  const before = await statFile(definitionPath);
  const first = await readText(definitionPath);
  const second = await readText(definitionPath);
  const after = await statFile(definitionPath);
  return {
    text: second,
    digest: sha256(second),
    changed: sha256(first) !== sha256(second)
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs,
  };
}

export async function observeCodexAutomations(
  options: ObserveCodexAutomationsOptions,
  dependencies: CodexAutomationObserverDependencies = {},
): Promise<ObserveCodexAutomationsResult> {
  const readText = dependencies.readText ?? ((filePath: string) => readFile(filePath, "utf8"));
  const statFile = dependencies.statFile ?? stat;
  const readDirectory = dependencies.readDirectory ?? readdir;
  const pathExists = dependencies.pathExists ?? defaultPathExists;
  const openReadOnlyDatabase = dependencies.openReadOnlyDatabase ?? defaultOpenReadOnlyDatabase;
  const deps = { pathExists, openReadOnlyDatabase };
  const now = options.now ?? new Date();
  const codexHome = path.resolve(options.codexHome);
  const automationsDir = path.join(codexHome, "automations");
  const mutationAuthority = options.mutationAuthority ?? "unavailable";
  const globalFindings: CodexAutomationObservationFinding[] = [];

  const [projection, governance, manifests, installs] = await Promise.all([
    readProjectionRows(options.codexDatabasePath, deps),
    loadGovernanceEntries(options.governancePath, readText),
    loadManifestDocuments(options.tasksDir, readText),
    loadCalyxInstalls(options.calyxStateDatabasePath, deps),
  ]);
  if (projection.error) {
    globalFindings.push(finding("tasks.codex-projection-unavailable", "warn", projection.error));
  }
  if (governance.error) {
    globalFindings.push(finding(
      governance.errorKind === "invalid" ? "tasks.codex-governance-invalid" : "tasks.codex-governance-unavailable",
      "error",
      governance.error,
    ));
  }
  if (manifests.error) {
    globalFindings.push(finding("tasks.codex-manifests-unavailable", "error", manifests.error));
  }

  let directories: string[] = [];
  try {
    const entries = await readDirectory(automationsDir, { withFileTypes: true });
    directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    globalFindings.push(finding(
      "tasks.codex-definitions-unavailable",
      "error",
      `Codex automation definitions could not be listed: ${error instanceof Error ? error.message : String(error)}`,
      { path: automationsDir },
    ));
  }

  const items: CodexAutomationObservationItem[] = [];
  const duplicateSignatures = new Map<string, string>();
  for (const directoryId of directories) {
    const definitionPath = path.join(automationsDir, directoryId, "automation.toml");
    let stable: Awaited<ReturnType<typeof stableReadDefinition>>;
    try {
      stable = await stableReadDefinition(definitionPath, readText, statFile);
    } catch (error) {
      items.push(invalidItem({
        id: directoryId,
        definitionPath,
        definitionStatus: "unreadable",
        definitionDigest: null,
        mutationAuthority,
        finding: finding(
          "tasks.codex-definition-unreadable",
          "error",
          `Codex automation definition could not be read: ${error instanceof Error ? error.message : String(error)}`,
          { automation_id: directoryId, path: definitionPath },
        ),
      }));
      continue;
    }
    if (stable.changed) {
      items.push(invalidItem({
        id: directoryId,
        definitionPath,
        definitionStatus: "changed_during_read",
        definitionDigest: stable.digest,
        mutationAuthority,
        finding: finding(
          "tasks.codex-definition-changed-during-read",
          "error",
          "Codex automation definition changed while it was being inventoried; no stable conclusion was emitted.",
          { automation_id: directoryId, path: definitionPath },
        ),
      }));
      continue;
    }

    let definition: ObservedAutomationDefinition;
    try {
      definition = observedAutomationSchema.parse(parseToml(stable.text)) as ObservedAutomationDefinition;
    } catch (error) {
      items.push(invalidItem({
        id: directoryId,
        definitionPath,
        definitionStatus: "malformed",
        definitionDigest: stable.digest,
        mutationAuthority,
        finding: finding(
          "tasks.codex-definition-malformed",
          "error",
          `Codex automation definition is malformed: ${error instanceof Error ? error.message : String(error)}`,
          { automation_id: directoryId, path: definitionPath },
        ),
      }));
      continue;
    }
    duplicateSignatures.set(
      definition.id,
      JSON.stringify([definition.name, definition.prompt, definition.status, definition.rrule, definition.cwds ?? []]),
    );

    const itemFindings: CodexAutomationObservationFinding[] = [];
    if (definition.id !== directoryId) {
      itemFindings.push(finding(
        "tasks.codex-definition-id-path-drift",
        "error",
        `Definition id ${definition.id} does not match directory id ${directoryId}.`,
        { automation_id: definition.id, path: definitionPath, expected: directoryId, observed: definition.id },
      ));
    }
    const projectionRow = projection.rows.get(definition.id);
    const projectionResult = projectionStatus(definition, projectionRow, projection.error);
    if (projectionResult.status === "missing") {
      itemFindings.push(finding(
        "tasks.codex-projection-missing",
        "error",
        "Definition exists but its Codex SQLite runtime projection row is missing.",
        { automation_id: definition.id },
      ));
    }
    if (projectionResult.status === "drifted") {
      for (const difference of projectionResult.differences) {
        itemFindings.push(finding(
          "tasks.codex-definition-projection-drift",
          "error",
          `Definition and runtime projection disagree on ${difference.field}.`,
          {
            automation_id: definition.id,
            expected: difference.expected,
            observed: difference.observed,
          },
        ));
      }
    }

    let governanceObservation = defaultGovernance();
    const taskDocument = manifests.documents.get(definition.id);
    const exemption = governance.entries.get(definition.id);
    const install = installs.get(definition.id);
    if (taskDocument) {
      const receipt = preflightCodexTaskRender(taskDocument.task, {
        manifestPath: taskDocument.manifestPath,
      });
      governanceObservation = {
        kind: "task_manifest",
        source_path: taskDocument.manifestPath,
        source_digest: manifests.digests.get(definition.id) ?? null,
        install_id: install?.install_id ?? null,
        status: receipt.ok ? "current" : "lossy",
        classification: null,
        loss_receipt: receipt,
      };
      if (!receipt.ok) {
        itemFindings.push(finding(
          "tasks.codex-manifest-lossy",
          "error",
          "The governing task manifest cannot represent the Codex definition exactly; POL-1960 remains activation-blocking.",
          { automation_id: definition.id, path: taskDocument.manifestPath },
        ));
      }
      const lifecycleManifestHash = hashTaskManifest(taskDocument.task);
      if (install && install.manifest_hash !== lifecycleManifestHash) {
        itemFindings.push(finding(
          "tasks.codex-install-manifest-drift",
          "error",
          "The Calyx task install hash does not match the governing manifest source digest.",
          { automation_id: definition.id, expected: lifecycleManifestHash, observed: install.manifest_hash },
        ));
        governanceObservation.status = "drifted";
      }
    } else if (exemption) {
      const checked = currentExemption(exemption, definition, stable.digest, now);
      itemFindings.push(...checked.findings);
      governanceObservation = {
        kind: "exemption",
        source_path: exemption.sourcePath,
        source_digest: exemption.digest,
        install_id: install?.install_id ?? null,
        status: checked.status,
        classification: exemption.classification,
        loss_receipt: null,
      };
    }

    const classifications: CodexAutomationClassification[] = [];
    if (projectionResult.status === "missing" || projectionResult.status === "drifted") {
      classifications.push("definition_projection_drift");
    }
    if (governanceObservation.kind === "task_manifest") {
      classifications.push(definition.status === "PAUSED" ? "governed_paused" : "governed_current");
      if (governanceObservation.status === "lossy") {
        classifications.push("lossy_blocked");
      }
    } else if (governanceObservation.kind === "exemption") {
      classifications.push("explicit_exemption");
      if (governanceObservation.classification === "distinct_paused_project_binding") {
        classifications.push("distinct_project_binding");
      }
    } else {
      classifications.push(definition.status === "ACTIVE" ? "ungoverned_active" : "ungoverned_paused");
      itemFindings.push(finding(
        definition.status === "ACTIVE" ? "tasks.codex-ungoverned-active" : "tasks.codex-ungoverned-paused",
        definition.status === "ACTIVE" ? "error" : "warn",
        `Codex ${definition.status.toLowerCase()} definition has no task manifest or explicit governance exemption.`,
        { automation_id: definition.id },
      ));
    }

    const count = finiteCount(definition.rrule);
    if (count !== null && projectionRow) {
      if (projectionRow.next_run_at === null && projectionRow.last_run_at === null) {
        classifications.push("finite_schedule_indeterminate");
        itemFindings.push(finding(
          "tasks.codex-finite-schedule-indeterminate",
          "error",
          `Finite COUNT=${count} schedule has neither next nor last runtime projection; expiry cannot be inferred.`,
          { automation_id: definition.id },
        ));
      } else if (projectionRow.next_run_at === null && projectionRow.last_run_at !== null) {
        classifications.push("expired_finite_schedule");
      }
    }

    items.push({
      id: definition.id,
      definition_path: definitionPath,
      definition_status: "observed",
      definition_digest: stable.digest,
      definition_authority: "codex_toml",
      mutation_authority: mutationAuthority,
      name: definition.name,
      status: definition.status,
      rrule: definition.rrule,
      cwds: definition.cwds ?? [],
      projection: projectionResult.status,
      projection_row: projectionRow ?? null,
      governance: governanceObservation,
      classifications: [...new Set(classifications)],
      duplicate_of: null,
      findings: itemFindings,
    });
  }

  const signatures = new Map<string, string>();
  for (const item of items) {
    if (item.definition_status !== "observed" || !item.name || !item.rrule || !item.cwds) {
      continue;
    }
    const signature = duplicateSignatures.get(item.id);
    if (!signature) {
      continue;
    }
    const first = signatures.get(signature);
    if (first) {
      item.duplicate_of = first;
      item.classifications.push("duplicate");
      item.findings.push(finding(
        "tasks.codex-exact-duplicate",
        "warn",
        `Definition exactly duplicates name, prompt, status, schedule, and cwd coverage of ${first}; same-name definitions with different cwd coverage are not duplicates.`,
        { automation_id: item.id },
      ));
    } else {
      signatures.set(signature, item.id);
    }
  }

  const definitionIds = new Set(items.map((item) => item.id));
  for (const projectionId of [...projection.rows.keys()].sort()) {
    if (!definitionIds.has(projectionId)) {
      globalFindings.push(finding(
        "tasks.codex-definition-missing-for-projection",
        "error",
        "Codex SQLite runtime projection has a row with no automation.toml definition.",
        { automation_id: projectionId },
      ));
    }
  }

  const itemFindings = items.flatMap((item) => item.findings);
  const findings = [...globalFindings, ...itemFindings];
  const errorCount = findings.filter((item) => item.severity === "error").length;
  const warningCount = findings.filter((item) => item.severity === "warn").length;
  return {
    schema_version: "calyx.tasks-codex-observation/v1",
    ok: errorCount === 0,
    observed_at: now.toISOString(),
    codex_home: codexHome,
    codex_database_path: options.codexDatabasePath ? path.resolve(options.codexDatabasePath) : null,
    tasks_dir: options.tasksDir ? path.resolve(options.tasksDir) : null,
    governance_path: options.governancePath ? path.resolve(options.governancePath) : null,
    definition_authority: "codex_toml",
    mutation_authority: mutationAuthority,
    counts: {
      definitions: items.length,
      active: items.filter((item) => item.status === "ACTIVE").length,
      paused: items.filter((item) => item.status === "PAUSED").length,
      projection_observed: items.filter((item) => item.projection === "observed").length,
      projection_missing: items.filter((item) => item.projection === "missing").length,
      projection_drifted: items.filter((item) => item.projection === "drifted").length,
      projection_unavailable: items.filter((item) => item.projection === "unavailable").length,
      errors: errorCount,
      warnings: warningCount,
    },
    items,
    findings,
  };
}
