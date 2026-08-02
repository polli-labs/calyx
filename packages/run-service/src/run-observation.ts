import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ArtifactEntry } from "@polli-labs/calyx-runner";
import type {
  ExecutionReceipt,
  RecordedRunEvent,
  RunArtifactObservation,
  RunArtifactRootObservation,
  RunHostResourceObservation,
  RunLogResult,
  RunObservationResult,
  RunResourceAttributionObservation,
  RunRecord,
  StoredResolvedSpec,
} from "./types.js";
import { readRunLogs, type ReadRunLogsOptions } from "./run-logs.js";

export interface RunObservationStoreLike {
  paths(runId: string): { runDir: string };
  readRunRecord(runId: string): Promise<RunRecord | undefined>;
  readKernelReceipt(runId: string): Promise<ExecutionReceipt | undefined>;
  readEvents(runId: string): Promise<RecordedRunEvent[]>;
}

export interface ObserveRunOptions extends ReadRunLogsOptions {
  now: () => string;
  collectHostResources: () => Promise<RunHostResourceObservation>;
  collectResourceAttribution: (rootPid?: number) => Promise<RunResourceAttributionObservation>;
}

const ARTIFACT_ROOT_SCAN_MAX_ENTRIES = 500;

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function extractWorktreePath(record?: RunRecord, receipt?: ExecutionReceipt): string | undefined {
  if (!record) return undefined;
  if (record.spec?.kernel === "agent_runner" && "worktree" in record.spec) {
    const specPath = normalizeOptionalText(record.spec.worktree.path);
    if (specPath) return specPath;
  }
  const intentPath = normalizeOptionalText(record.intent.worktree_path);
  if (intentPath) return intentPath;
  if (receipt && "environment" in receipt) {
    return normalizeOptionalText(receipt.environment.worktree_path);
  }
  return undefined;
}

function extractReceiptArtifacts(receipt?: ExecutionReceipt): {
  required: ArtifactEntry[];
  discovered: ArtifactEntry[];
  missing: string[];
} {
  if (!receipt || !("artifacts" in receipt)) {
    return { required: [], discovered: [], missing: [] };
  }
  return {
    required: receipt.artifacts.required,
    discovered: receipt.artifacts.discovered,
    missing: receipt.artifacts.missing,
  };
}

function specRequiredArtifacts(spec?: StoredResolvedSpec): string[] {
  return spec?.required_artifacts ?? [];
}

function specArtifactRoots(spec?: StoredResolvedSpec): string[] {
  return spec?.artifact_roots ?? [];
}

function receiptArtifactRoots(receipt?: ExecutionReceipt): string[] {
  if (!receipt || !("run_spec" in receipt)) {
    return [];
  }
  const roots = (receipt.run_spec as { artifact_roots?: unknown }).artifact_roots;
  if (!Array.isArray(roots)) {
    return [];
  }
  return roots.filter((root): root is string => typeof root === "string" && root.trim().length > 0);
}

function addArtifactEntry(
  artifacts: Map<string, RunArtifactObservation>,
  entry: ArtifactEntry,
  required: boolean,
): void {
  const key = entry.path ? `path:${entry.path}` : `name:${entry.name}`;
  const current = artifacts.get(key);
  artifacts.set(key, {
    name: entry.name,
    location: entry.location,
    required: required || current?.required === true || entry.required,
    status: "unknown",
    path: entry.path,
    ...(entry.size_bytes ? { file_size_bytes: entry.size_bytes } : {}),
    ...(entry.detected_at ? { detected_at: entry.detected_at } : {}),
  });
}

function collectArtifactCandidates(args: {
  record?: RunRecord;
  receipt?: ExecutionReceipt;
  worktreePath?: string;
}): RunArtifactObservation[] {
  const artifacts = new Map<string, RunArtifactObservation>();
  const receiptArtifacts = extractReceiptArtifacts(args.receipt);
  for (const entry of receiptArtifacts.required) {
    addArtifactEntry(artifacts, entry, true);
  }
  for (const entry of receiptArtifacts.discovered) {
    addArtifactEntry(artifacts, entry, entry.required);
  }

  const requiredNames = new Set([
    ...(args.record?.intent.required_artifacts ?? []),
    ...specRequiredArtifacts(args.record?.spec),
    ...receiptArtifacts.missing,
  ]);
  for (const name of requiredNames) {
    const existing = [...artifacts.values()].find((artifact) => artifact.name === name);
    if (existing) {
      existing.required = true;
      continue;
    }
    artifacts.set(`required:${name}`, {
      name,
      location: args.worktreePath ? "worktree" : "unknown",
      required: true,
      status: "unknown",
      ...(args.worktreePath ? { path: path.join(args.worktreePath, name) } : {}),
    });
  }

  return [...artifacts.values()].sort((left, right) => {
    if (left.required !== right.required) return left.required ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

async function statArtifact(artifact: RunArtifactObservation): Promise<RunArtifactObservation> {
  if (!artifact.path) {
    return { ...artifact, status: "unknown" };
  }
  try {
    const stats = await stat(artifact.path);
    return {
      ...artifact,
      status: "present",
      exists: true,
      file_size_bytes: stats.size,
      latest_modified_at: stats.mtime.toISOString(),
    };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return {
        ...artifact,
        status: "missing",
        exists: false,
      };
    }
    return { ...artifact, status: "unknown" };
  }
}

function collectArtifactRootCandidates(args: {
  record?: RunRecord;
  receipt?: ExecutionReceipt;
  worktreePath?: string;
}): RunArtifactRootObservation[] {
  const roots = new Map<string, RunArtifactRootObservation>();
  const declaredRoots = [
    ...(args.record?.intent.artifact_roots ?? []),
    ...specArtifactRoots(args.record?.spec),
    ...receiptArtifactRoots(args.receipt),
  ];
  for (const rawRoot of declaredRoots) {
    const name = rawRoot.trim();
    if (!name) {
      continue;
    }
    const rootPath = path.isAbsolute(name)
      ? name
      : (args.worktreePath ? path.join(args.worktreePath, name) : undefined);
    const key = rootPath ? `path:${rootPath}` : `name:${name}`;
    roots.set(key, {
      name,
      status: "unknown",
      ...(rootPath ? { path: rootPath } : {}),
    });
  }
  return [...roots.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function scanArtifactRoot(root: RunArtifactRootObservation): Promise<RunArtifactRootObservation> {
  if (!root.path) {
    return { ...root, status: "unknown" };
  }

  try {
    const rootStats = await stat(root.path);
    if (!rootStats.isDirectory()) {
      return {
        ...root,
        status: "present",
        exists: true,
        file_count: rootStats.isFile() ? 1 : 0,
        directory_count: 0,
        total_size_bytes: rootStats.isFile() ? rootStats.size : 0,
        latest_modified_at: rootStats.mtime.toISOString(),
        truncated: false,
        max_entries: ARTIFACT_ROOT_SCAN_MAX_ENTRIES,
      };
    }

    let fileCount = 0;
    let directoryCount = 0;
    let totalSize = 0;
    let latestModifiedAt = rootStats.mtime;
    let scannedEntries = 0;
    let truncated = false;
    const pending = [root.path];

    while (pending.length > 0) {
      const current = pending.pop()!;
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (scannedEntries >= ARTIFACT_ROOT_SCAN_MAX_ENTRIES) {
          truncated = true;
          pending.length = 0;
          break;
        }
        scannedEntries += 1;
        const entryPath = path.join(current, entry.name);
        const entryStats = await stat(entryPath);
        if (entryStats.mtime > latestModifiedAt) {
          latestModifiedAt = entryStats.mtime;
        }
        if (entryStats.isDirectory()) {
          directoryCount += 1;
          pending.push(entryPath);
        } else if (entryStats.isFile()) {
          fileCount += 1;
          totalSize += entryStats.size;
        }
      }
    }

    return {
      ...root,
      status: "present",
      exists: true,
      file_count: fileCount,
      directory_count: directoryCount,
      total_size_bytes: totalSize,
      latest_modified_at: latestModifiedAt.toISOString(),
      truncated,
      max_entries: ARTIFACT_ROOT_SCAN_MAX_ENTRIES,
    };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return {
        ...root,
        status: "missing",
        exists: false,
        truncated: false,
        max_entries: ARTIFACT_ROOT_SCAN_MAX_ENTRIES,
      };
    }
    return { ...root, status: "unknown", max_entries: ARTIFACT_ROOT_SCAN_MAX_ENTRIES };
  }
}

function buildWarnings(result: {
  record?: RunRecord;
  logs: RunLogResult;
  artifacts: RunArtifactObservation[];
  artifactRoots: RunArtifactRootObservation[];
}): string[] {
  const warnings = [...result.logs.warnings];
  if (!result.record) {
    warnings.push("Run record is missing; observation is limited to store paths, logs, and host resources.");
  }
  if (result.record && !result.record.kernel_receipt && result.record.state !== "queued" && result.record.state !== "running") {
    warnings.push("Terminal run has no kernel receipt; artifact and backend-session evidence may be incomplete.");
  }
  const missingRequired = result.artifacts.filter((artifact) => artifact.required && artifact.status === "missing");
  if (missingRequired.length > 0) {
    warnings.push(`Missing required artifacts: ${missingRequired.map((artifact) => artifact.name).join(", ")}.`);
  }
  const missingRoots = result.artifactRoots.filter((root) => root.status === "missing");
  if (missingRoots.length > 0) {
    warnings.push(`Missing artifact roots: ${missingRoots.map((root) => root.name).join(", ")}.`);
  }
  return warnings;
}

export async function observeRun(
  store: RunObservationStoreLike,
  runId: string,
  options: ObserveRunOptions,
): Promise<RunObservationResult> {
  const checkedAt = options.now();
  const [record, receipt, logs, hostResources] = await Promise.all([
    store.readRunRecord(runId),
    store.readKernelReceipt(runId),
    readRunLogs(store, runId, options),
    options.collectHostResources(),
  ]);
  const paths = store.paths(runId);
  const worktreePath = extractWorktreePath(record, receipt);
  const artifactInput: { record?: RunRecord; receipt?: ExecutionReceipt; worktreePath?: string } = {
    ...(record ? { record } : {}),
    ...(receipt ? { receipt } : {}),
    ...(worktreePath ? { worktreePath } : {}),
  };
  const artifacts = await Promise.all(collectArtifactCandidates(artifactInput).map(statArtifact));
  const artifactRoots = await Promise.all(collectArtifactRootCandidates(artifactInput).map(scanArtifactRoot));
  const resourceAttribution = await options.collectResourceAttribution();
  const warningInput: {
    record?: RunRecord;
    logs: RunLogResult;
    artifacts: RunArtifactObservation[];
    artifactRoots: RunArtifactRootObservation[];
  } = {
    ...(record ? { record } : {}),
    logs,
    artifacts,
    artifactRoots,
  };
  const warnings = buildWarnings(warningInput);

  return {
    schema_version: "run-observation/v1",
    run_id: runId,
    checked_at: checkedAt,
    run: {
      ...(record ? { state: record.state } : {}),
      ...(record?.summary ? { summary: record.summary } : {}),
      ...(record?.intent.host ? { host: record.intent.host } : {}),
      ...(record?.intent.issue ? { issue: record.intent.issue } : {}),
      ...(record?.intent.backend ? { backend: record.intent.backend } : {}),
      ...(record?.intent.kernel ? { kernel: record.intent.kernel } : {}),
      ...(record?.updated_at ? { updated_at: record.updated_at } : {}),
      ...(record?.health ? { health: record.health } : {}),
    },
    paths: {
      run_dir: paths.runDir,
      ...(worktreePath ? { worktree_path: worktreePath } : {}),
    },
    process: { checked_at: checkedAt, status: "not_recorded" },
    resource_attribution: resourceAttribution,
    logs: {
      sources: logs.sources,
      warnings: logs.warnings,
    },
    artifacts,
    artifact_roots: artifactRoots,
    host_resources: hostResources,
    warnings,
  };
}
