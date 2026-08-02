import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, open as openFile, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir, hostname as systemHostname } from "node:os";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";
import {
  API_REQUEST_ID_PATTERN_SOURCE,
  validateApiProvenance,
  type ApiProvenanceV1,
} from "./state/provenance";
import { SqliteMutexBusyError, withSqliteMutex } from "./state/sqlite-mutex";
import type {
  LocalBackendMode,
  LocalBackendReceiptSummaryV1,
  RuntimeConfigComponent,
  RuntimeConfigItemResult,
  RuntimeConfigOptions,
  RuntimeConfigResult,
} from "./types";

const DEFAULT_COMPONENTS: readonly RuntimeConfigComponent[] = ["codex", "claude-settings", "claude-mcp"];
const CLAUDE_ENV_PLACEHOLDER = "{{ SET_VIA_ENVIRONMENT_OR_LOCAL_FILE }}";
const DEFAULT_MANAGED_CONFIGS_RELATIVE_ROOT = path.join("dev", "agents-infra", "dev", "fleet", "configs");
const RUNTIME_CONFIG_STATE_VERSION = "runtime-config-state/v1";
export const RUNTIME_CONFIG_MUTATION_INTENT_SCHEMA_VERSION = "calyx.runtime-config-mutation-intent/v1" as const;
export const RUNTIME_CONFIG_MUTATION_RESULT_SCHEMA_VERSION = "calyx.runtime-config-mutation-result/v1" as const;
const RUNTIME_CONFIG_MUTATION_RECEIPT_MAX_BYTES = 16 * 1024;
const RUNTIME_CONFIG_APPLY_ID_PATTERN = new RegExp(
  `(?:${API_REQUEST_ID_PATTERN_SOURCE})|(?:^local_[0-9a-f]{32}$)`,
);

const RUNTIME_CONFIG_APPLY_LOCK_RELATIVE_PATH = path.join(".calyx", "runtime-config-apply.lock.sqlite3");

export class RuntimeConfigApplyInProgressError extends Error {
  readonly code = "runtime_config_apply_in_progress";

  constructor() {
    super("Another runtime-config apply is already in progress for this home.");
    this.name = "RuntimeConfigApplyInProgressError";
  }
}

export type RuntimeConfigMutationEffectPhase = "backup" | "target" | "state";

export interface RuntimeConfigMutationHashesV1 {
  desired_sha256: string;
  live_sha256?: string | undefined;
  ownership_before_sha256: string;
  ownership_after_sha256: string;
  output_sha256?: string | undefined;
}

interface RuntimeConfigMutationReceiptCommonV1 {
  apply_id: string;
  component: RuntimeConfigComponent;
  target_locator: string;
  hashes: RuntimeConfigMutationHashesV1;
  provenance?: ApiProvenanceV1 | undefined;
  planned_phases: RuntimeConfigMutationEffectPhase[];
}

export interface RuntimeConfigMutationIntentReceiptV1 extends RuntimeConfigMutationReceiptCommonV1 {
  schema_version: typeof RUNTIME_CONFIG_MUTATION_INTENT_SCHEMA_VERSION;
  phase: "intent";
  outcome: "pending";
  recorded_at: string;
}

export interface RuntimeConfigMutationResultReceiptV1 extends RuntimeConfigMutationReceiptCommonV1 {
  schema_version: typeof RUNTIME_CONFIG_MUTATION_RESULT_SCHEMA_VERSION;
  phase: RuntimeConfigMutationEffectPhase | "complete";
  outcome: "applied" | "failed" | "partial";
  completed_phases: RuntimeConfigMutationEffectPhase[];
  failure_id?: `runtime_config_${RuntimeConfigMutationEffectPhase}_failed` | undefined;
  intent_recorded_at: string;
  recorded_at: string;
}

export interface RuntimeConfigMutationReceiptPaths {
  intent: string;
  result: string;
}

interface RuntimeConfigComponentPlan {
  component: RuntimeConfigComponent;
  targetPath: string;
  stagedPath: string;
  liveExists: boolean;
  desiredText: string;
  desiredSha256: string;
  liveText?: string;
  liveSha256?: string;
  changes: string[];
  managedOwnershipUpdate?: Partial<RuntimeConfigManagedOwnershipStateV1>;
}

interface ManagedConfigSource {
  path: string;
  text: string;
}

interface RuntimeConfigManagedOwnershipStateV1 {
  contractVersion: typeof RUNTIME_CONFIG_STATE_VERSION;
  codex?: {
    mcpServers?: string[];
    projects?: string[];
  };
  claudeMcp?: {
    servers?: string[];
  };
}

interface CodexMergeResult {
  changed: boolean;
  changes: string[];
  nextText: string;
}

interface ClaudeSettingsMergeResult {
  changed: boolean;
  changes: string[];
  nextText: string;
}

interface ClaudeMcpMergeResult {
  changed: boolean;
  changes: string[];
  nextText: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    handle = await openFile(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && ["EACCES", "EBADF", "EISDIR", "EINVAL", "EPERM"].includes(code ?? "")) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function ensureDurableDirectory(directory: string): Promise<void> {
  const missing: string[] = [];
  let candidate = path.resolve(directory);
  while (!(await fileExists(candidate))) {
    missing.push(candidate);
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      break;
    }
    candidate = parent;
  }

  for (const nextDirectory of missing.reverse()) {
    try {
      await mkdir(nextDirectory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    await syncDirectory(path.dirname(nextDirectory));
  }
}

async function ensureDurableDirectoryWithoutSymlinks(directory: string, boundary: string): Promise<void> {
  const resolvedBoundary = path.resolve(boundary);
  const resolvedDirectory = path.resolve(directory);
  const relativeDirectory = path.relative(resolvedBoundary, resolvedDirectory);
  if (path.isAbsolute(relativeDirectory) || relativeDirectory === ".." || relativeDirectory.startsWith(`..${path.sep}`)) {
    throw new Error("Runtime-config receipt directory must remain under liveHome.");
  }

  await ensureDurableDirectory(resolvedBoundary);
  const boundaryMetadata = await lstat(resolvedBoundary);
  if (boundaryMetadata.isSymbolicLink() || !boundaryMetadata.isDirectory()) {
    throw new Error("Runtime-config liveHome must be a real directory before receipt persistence.");
  }

  let current = resolvedBoundary;
  for (const segment of relativeDirectory.split(path.sep).filter((value) => value.length > 0)) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Runtime-config receipt directory ${current} is a symbolic link; refusing redirected evidence.`);
      }
      if (!metadata.isDirectory()) {
        throw new Error(`Runtime-config receipt directory ${current} is not a directory.`);
      }
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Runtime-config receipt directory ${current} changed during creation.`);
      }
    }
    await syncDirectory(path.dirname(current));
  }
}

async function writeDurableText(
  filePath: string,
  text: string,
  options: { symlinkBoundary?: string | undefined } = {},
): Promise<void> {
  const directory = path.dirname(filePath);
  if (options.symlinkBoundary) {
    await ensureDurableDirectoryWithoutSymlinks(directory, options.symlinkBoundary);
  } else {
    await ensureDurableDirectory(directory);
  }
  const temporaryPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    handle = await openFile(temporaryPath, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function withRuntimeConfigApplyLock<T>(liveHome: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(liveHome, RUNTIME_CONFIG_APPLY_LOCK_RELATIVE_PATH);
  await ensureDurableDirectoryWithoutSymlinks(path.dirname(lockPath), liveHome);
  try {
    return await withSqliteMutex(lockPath, fn, {
      acquireTimeoutMs: 0,
      queueInProcess: false,
    });
  } catch (error) {
    if (error instanceof SqliteMutexBusyError) throw new RuntimeConfigApplyInProgressError();
    throw error;
  }
}

async function writeMutationReceipt(
  filePath: string,
  receipt: RuntimeConfigMutationIntentReceiptV1 | RuntimeConfigMutationResultReceiptV1,
  liveHome: string,
): Promise<void> {
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > RUNTIME_CONFIG_MUTATION_RECEIPT_MAX_BYTES) {
    throw new Error(`Runtime-config mutation receipt exceeds ${RUNTIME_CONFIG_MUTATION_RECEIPT_MAX_BYTES} bytes.`);
  }
  await writeDurableText(filePath, text, { symlinkBoundary: liveHome });
}

function targetLocator(component: RuntimeConfigComponent): string {
  if (component === "codex") {
    return "~/.codex/config.toml";
  }
  if (component === "claude-settings") {
    return "~/.claude/settings.json";
  }
  return "~/.claude.json";
}

/** Resolves the fixed two-file receipt contract for one component mutation. */
export function resolveRuntimeConfigMutationReceiptPaths(
  liveHome: string,
  applyId: string,
  component: RuntimeConfigComponent,
): RuntimeConfigMutationReceiptPaths {
  if (!RUNTIME_CONFIG_APPLY_ID_PATTERN.test(applyId)) {
    throw new Error("Runtime-config apply_id must be a validated request id or deterministic local id.");
  }
  if (!(DEFAULT_COMPONENTS as readonly string[]).includes(component)) {
    throw new Error(`Runtime-config receipt component must be one of: ${DEFAULT_COMPONENTS.join(", ")}.`);
  }
  const root = path.join(path.resolve(liveHome), ".calyx", "receipts", "runtime-config", applyId);
  return {
    intent: path.join(root, `${component}.intent.json`),
    result: path.join(root, `${component}.result.json`),
  };
}

async function readUtf8IfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function isSymbolicLink(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function normalizeHostAlias(value: string): string {
  return value.trim().split(".")[0]?.toLowerCase() ?? "";
}

function resolveActualHost(): string {
  return normalizeHostAlias(systemHostname());
}

function resolveManagedConfigsRoot(options: RuntimeConfigOptions, liveHome: string): string {
  return path.resolve(options.managedConfigsRoot ?? path.join(liveHome, DEFAULT_MANAGED_CONFIGS_RELATIVE_ROOT));
}

function runtimeConfigStatePath(liveHome: string): string {
  return path.join(liveHome, ".calyx", "runtime-config-state.json");
}

function normalizeStringList(values?: string[]): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOwnershipState(
  state: Partial<RuntimeConfigManagedOwnershipStateV1> | undefined,
): RuntimeConfigManagedOwnershipStateV1 {
  const codexMcpServers = normalizeStringList(state?.codex?.mcpServers);
  const codexProjects = normalizeStringList(state?.codex?.projects);
  const claudeMcpServers = normalizeStringList(state?.claudeMcp?.servers);

  return {
    contractVersion: RUNTIME_CONFIG_STATE_VERSION,
    ...((codexMcpServers || codexProjects)
      ? {
          codex: {
            ...(codexMcpServers ? { mcpServers: codexMcpServers } : {}),
            ...(codexProjects ? { projects: codexProjects } : {}),
          },
        }
      : {}),
    ...(claudeMcpServers
      ? {
          claudeMcp: {
            servers: claudeMcpServers,
          },
        }
      : {}),
  };
}

async function readRuntimeConfigState(liveHome: string): Promise<RuntimeConfigManagedOwnershipStateV1> {
  const statePath = runtimeConfigStatePath(liveHome);
  const text = await readUtf8IfExists(statePath);
  if (!text) {
    return normalizeOwnershipState(undefined);
  }
  const parsed = JSON.parse(text) as Partial<RuntimeConfigManagedOwnershipStateV1>;
  if (parsed.contractVersion !== RUNTIME_CONFIG_STATE_VERSION) {
    return normalizeOwnershipState(undefined);
  }
  return normalizeOwnershipState(parsed);
}

async function writeRuntimeConfigState(
  liveHome: string,
  state: RuntimeConfigManagedOwnershipStateV1,
): Promise<void> {
  const statePath = runtimeConfigStatePath(liveHome);
  await writeDurableText(statePath, `${JSON.stringify(normalizeOwnershipState(state), null, 2)}\n`);
}

function resolveComponents(requested?: RuntimeConfigComponent[]): RuntimeConfigComponent[] {
  if (!requested || requested.length === 0) {
    return [...DEFAULT_COMPONENTS];
  }
  return [...new Set(requested)];
}

function requireRuntimeConfigHostSegment(host: string): string {
  if (host !== host.trim().toLowerCase() || !/^[a-z0-9][a-z0-9-]*$/u.test(host)) {
    throw new Error(`Runtime-config host ${JSON.stringify(host)} is not a canonical host segment.`);
  }
  return host;
}

function pathBelongsToRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0
    && !path.isAbsolute(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`);
}

function sameFileIdentity(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function resolveOpenedFilePath(fileDescriptor: number): Promise<string> {
  const descriptorPaths = [
    `/proc/self/fd/${fileDescriptor}`,
    `/dev/fd/${fileDescriptor}`,
  ];
  const failures: string[] = [];
  for (const descriptorPath of descriptorPaths) {
    try {
      return await realpath(descriptorPath);
    } catch (error) {
      failures.push(`${descriptorPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `Cannot prove the opened managed runtime-config source path from file descriptor ${fileDescriptor}: `
    + failures.join("; "),
  );
}

async function assertManagedSourceParentsUnchanged(args: {
  managedConfigsRoot: string;
  managedConfigsRealRoot: string;
  rootMetadata: Stats;
  directoryPath: string;
  directoryRealPath: string;
  directoryMetadata: Stats;
}): Promise<void> {
  const [currentRootMetadata, currentDirectoryMetadata] = await Promise.all([
    lstat(args.managedConfigsRoot),
    lstat(args.directoryPath),
  ]);
  if (
    !currentRootMetadata.isDirectory()
    || currentRootMetadata.isSymbolicLink()
    || !sameFileIdentity(currentRootMetadata, args.rootMetadata)
    || await realpath(args.managedConfigsRoot) !== args.managedConfigsRealRoot
  ) {
    throw new Error(`Managed runtime-config root ${args.managedConfigsRoot} changed during source open.`);
  }
  if (
    !currentDirectoryMetadata.isDirectory()
    || currentDirectoryMetadata.isSymbolicLink()
    || !sameFileIdentity(currentDirectoryMetadata, args.directoryMetadata)
    || await realpath(args.directoryPath) !== args.directoryRealPath
  ) {
    throw new Error(`Managed runtime-config directory ${args.directoryPath} changed during source open.`);
  }
}

async function readManagedConfigCandidate(
  managedConfigsRoot: string,
  managedConfigsRealRoot: string,
  rootMetadata: Stats,
  directory: string,
  fileName: string,
): Promise<ManagedConfigSource | undefined> {
  const directoryPath = path.join(managedConfigsRoot, directory);
  const candidatePath = path.join(directoryPath, fileName);
  let directoryMetadata: Stats;
  let metadata;
  try {
    directoryMetadata = await lstat(directoryPath);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new Error(`Managed runtime-config directory ${directoryPath} must be a real directory.`);
    }
    metadata = await lstat(candidatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Managed runtime-config source ${candidatePath} must be a real regular file.`);
  }
  const directoryRealPath = await realpath(directoryPath);
  if (!pathBelongsToRoot(directoryRealPath, managedConfigsRealRoot)) {
    throw new Error(`Managed runtime-config directory ${directoryPath} escapes ${managedConfigsRoot}.`);
  }
  const resolvedCandidate = await realpath(candidatePath);
  if (!pathBelongsToRoot(resolvedCandidate, managedConfigsRealRoot)) {
    throw new Error(`Managed runtime-config source ${candidatePath} escapes ${managedConfigsRoot}.`);
  }
  const handle = await openFile(
    candidatePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile() || !sameFileIdentity(openedMetadata, metadata)) {
      throw new Error(`Managed runtime-config source ${candidatePath} changed before it could be opened.`);
    }
    const openedPath = await resolveOpenedFilePath(handle.fd);
    if (!pathBelongsToRoot(openedPath, managedConfigsRealRoot)) {
      throw new Error(`Opened managed runtime-config source ${openedPath} escapes ${managedConfigsRoot}.`);
    }
    await assertManagedSourceParentsUnchanged({
      managedConfigsRoot,
      managedConfigsRealRoot,
      rootMetadata,
      directoryPath,
      directoryRealPath,
      directoryMetadata,
    });
    const text = await handle.readFile("utf8");
    await assertManagedSourceParentsUnchanged({
      managedConfigsRoot,
      managedConfigsRealRoot,
      rootMetadata,
      directoryPath,
      directoryRealPath,
      directoryMetadata,
    });
    return { path: openedPath, text };
  } finally {
    await handle.close();
  }
}

async function readManagedConfigSource(
  managedConfigsRoot: string,
  host: string,
  hostFileName: string,
  sharedFileName: string,
): Promise<ManagedConfigSource> {
  requireRuntimeConfigHostSegment(host);
  const rootMetadata = await lstat(managedConfigsRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`Managed runtime-config root ${managedConfigsRoot} must be a real directory.`);
  }
  const managedConfigsRealRoot = await realpath(managedConfigsRoot);
  const hostSource = await readManagedConfigCandidate(
    managedConfigsRoot,
    managedConfigsRealRoot,
    rootMetadata,
    host,
    hostFileName,
  );
  if (hostSource) {
    return hostSource;
  }

  const sharedSource = await readManagedConfigCandidate(
    managedConfigsRoot,
    managedConfigsRealRoot,
    rootMetadata,
    "shared",
    sharedFileName,
  );
  if (sharedSource) {
    return sharedSource;
  }

  throw new Error(
    `Managed runtime-config source missing for host ${host}: checked `
    + `${path.join(managedConfigsRoot, host, hostFileName)} and `
    + `${path.join(managedConfigsRoot, "shared", sharedFileName)}.`,
  );
}

function extractLeadingCommentBlock(text: string): string {
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index]?.trim() ?? "";
    if (trimmed === "" || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }
    break;
  }
  const prefix = lines.slice(0, index).join("\n");
  return prefix.length > 0 ? `${prefix}\n` : "";
}

function cloneValue<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableJson(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeForStableJson(child)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

function normalizeClaudePermissions(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const next = cloneValue(value);
  for (const fieldName of ["allow", "deny"] as const) {
    const items = next[fieldName];
    if (Array.isArray(items)) {
      next[fieldName] = [...new Set(items.map((item) => String(item)))].sort();
    }
  }
  return next;
}

function mergeCodexManagedMap(
  label: "mcp_servers" | "projects",
  existingValue: unknown,
  desiredValue: unknown,
  previouslyManagedKeys: string[],
): {
  changed: boolean;
  changes: string[];
  nextValue: Record<string, unknown>;
  managedKeys: string[];
} {
  const existingEntries = isRecord(existingValue) ? cloneValue(existingValue) : {};
  const desiredEntries = isRecord(desiredValue) ? desiredValue : {};
  const nextEntries = cloneValue(existingEntries);
  const changes: string[] = [];
  const desiredKeys = Object.keys(desiredEntries).sort();

  for (const managedKey of previouslyManagedKeys) {
    if (!(managedKey in desiredEntries) && managedKey in nextEntries) {
      changes.push(`codex: remove ${label}.${managedKey} absent from managed truth`);
      delete nextEntries[managedKey];
    }
  }

  for (const [entryKey, desiredEntryValue] of Object.entries(desiredEntries)) {
    if (stableJson(nextEntries[entryKey]) !== stableJson(desiredEntryValue)) {
      changes.push(`codex: converge ${label}.${entryKey} from managed truth`);
      nextEntries[entryKey] = cloneValue(desiredEntryValue);
    }
  }

  return { changed: changes.length > 0, changes, nextValue: nextEntries, managedKeys: desiredKeys };
}

function mergeCodexConfig(
  existingText: string | undefined,
  stagedText: string,
  existingOwnership: RuntimeConfigManagedOwnershipStateV1,
): CodexMergeResult & { managedOwnershipUpdate: Partial<RuntimeConfigManagedOwnershipStateV1> } {
  const existingObject = existingText ? (parseToml(existingText) as Record<string, unknown>) : {};
  const stagedObject = parseToml(stagedText) as Record<string, unknown>;
  const nextObject = cloneValue(existingObject) ?? {};
  const changes: string[] = [];

  const managedFields = [
    "profile",
    "model",
    "model_reasoning_effort",
    "model_reasoning_summary",
    "model_verbosity",
    "model_supports_reasoning_summaries",
    "show_raw_agent_reasoning",
    "tool_output_token_limit",
    "web_search",
    "project_doc_fallback_filenames",
    "file_opener",
    "personality",
    "approval_policy",
    "sandbox_mode",
    "profiles",
    "otel",
    "history",
    "notice",
    "agents",
    "features",
  ];

  // Codex Desktop/plugins can write app-owned runtime state into config.toml.
  // Only manage notify when staged truth deliberately owns it; otherwise
  // preserve plugin-owned notifiers such as Computer Use's turn-ended hook.
  if (stagedObject["notify"] !== undefined) {
    managedFields.push("notify");
  }

  for (const fieldName of managedFields) {
    if (stagedObject[fieldName] === undefined) {
      if (fieldName in nextObject) {
        changes.push(`codex: remove ${fieldName} absent from managed truth`);
        delete nextObject[fieldName];
      }
      continue;
    }

    if (stableJson(existingObject[fieldName]) !== stableJson(stagedObject[fieldName])) {
      changes.push(`codex: converge ${fieldName} from managed truth`);
    }
    nextObject[fieldName] = cloneValue(stagedObject[fieldName]);
  }

  for (const fieldName of ["mcp_servers", "projects"] as const) {
    const mergedMap = mergeCodexManagedMap(
      fieldName,
      existingObject[fieldName],
      stagedObject[fieldName],
      fieldName === "mcp_servers"
        ? (existingOwnership.codex?.mcpServers ?? [])
        : (existingOwnership.codex?.projects ?? []),
    );
    if (mergedMap.changed) {
      changes.push(...mergedMap.changes);
    }
    nextObject[fieldName] = mergedMap.nextValue;
  }

  if (stableJson(existingObject) !== stableJson(nextObject) && changes.length === 0) {
    changes.push("codex: converge managed config surface from managed truth");
  }

  if (changes.length === 0) {
    return {
      changed: false,
      changes,
      nextText: existingText ?? `${stringifyToml(nextObject as never)}`,
      managedOwnershipUpdate: {
        codex: {
          ...(Object.keys(isRecord(stagedObject["mcp_servers"]) ? stagedObject["mcp_servers"] : {}).length > 0
            ? { mcpServers: Object.keys(stagedObject["mcp_servers"] as Record<string, unknown>).sort() }
            : {}),
          ...(Object.keys(isRecord(stagedObject["projects"]) ? stagedObject["projects"] : {}).length > 0
            ? { projects: Object.keys(stagedObject["projects"] as Record<string, unknown>).sort() }
            : {}),
        },
      },
    };
  }

  const prefix = extractLeadingCommentBlock(stagedText);
  const body = stringifyToml(nextObject as never);
  return {
    changed: true,
    changes,
    nextText: `${prefix}${body}`,
    managedOwnershipUpdate: {
      codex: {
        ...(Object.keys(isRecord(stagedObject["mcp_servers"]) ? stagedObject["mcp_servers"] : {}).length > 0
          ? { mcpServers: Object.keys(stagedObject["mcp_servers"] as Record<string, unknown>).sort() }
          : {}),
        ...(Object.keys(isRecord(stagedObject["projects"]) ? stagedObject["projects"] : {}).length > 0
          ? { projects: Object.keys(stagedObject["projects"] as Record<string, unknown>).sort() }
          : {}),
      },
    },
  };
}

function mergeClaudeSettings(existingText: string | undefined, stagedText: string): ClaudeSettingsMergeResult {
  const stagedObject = JSON.parse(stagedText) as Record<string, unknown>;
  const existingObject = existingText ? (JSON.parse(existingText) as Record<string, unknown>) : {};
  const nextObject = cloneValue(existingObject) ?? {};
  const changes: string[] = [];

  if (stagedObject["$schema"] !== undefined && nextObject["$schema"] !== stagedObject["$schema"]) {
    changes.push("claude-settings: converge $schema");
    nextObject["$schema"] = stagedObject["$schema"];
  }

  for (const key of ["alwaysThinkingEnabled", "includeCoAuthoredBy"] as const) {
    if (!Object.prototype.hasOwnProperty.call(stagedObject, key)) {
      if (Object.prototype.hasOwnProperty.call(nextObject, key)) {
        changes.push(`claude-settings: remove ${key} absent from managed truth`);
        delete nextObject[key];
      }
      continue;
    }
    if (nextObject[key] !== stagedObject[key]) {
      changes.push(`claude-settings: converge ${key}`);
      nextObject[key] = stagedObject[key];
    }
  }

  if (
    stableJson(normalizeClaudePermissions(nextObject["permissions"] ?? null))
    !== stableJson(normalizeClaudePermissions(stagedObject["permissions"] ?? null))
  ) {
    changes.push("claude-settings: converge permissions");
    nextObject["permissions"] = cloneValue(stagedObject["permissions"]);
  }

  const stagedEnv = cloneValue((stagedObject["env"] as Record<string, unknown> | undefined) ?? {});
  const existingEnv = (existingObject["env"] as Record<string, unknown> | undefined) ?? {};
  for (const [key, existingValue] of Object.entries(existingEnv)) {
    if (stagedEnv[key] === CLAUDE_ENV_PLACEHOLDER && typeof existingValue === "string" && existingValue.length > 0) {
      stagedEnv[key] = existingValue;
    }
  }
  if (stableJson(nextObject["env"] ?? null) !== stableJson(stagedEnv)) {
    changes.push("claude-settings: converge env");
    nextObject["env"] = stagedEnv;
  }

  if (changes.length === 0) {
    return { changed: false, changes, nextText: existingText ?? `${JSON.stringify(stagedObject, null, 2)}\n` };
  }

  return {
    changed: true,
    changes,
    nextText: `${JSON.stringify(nextObject, null, 2)}\n`,
  };
}

function mergeClaudeMcp(
  existingText: string | undefined,
  stagedText: string,
  existingOwnership: RuntimeConfigManagedOwnershipStateV1,
): ClaudeMcpMergeResult & { managedOwnershipUpdate: Partial<RuntimeConfigManagedOwnershipStateV1> } {
  const stagedObject = JSON.parse(stagedText) as unknown;
  const desiredMcpServers = (isRecord(stagedObject) && isRecord(stagedObject["mcpServers"]))
    ? stagedObject["mcpServers"]
    : stagedObject;
  if (!isRecord(desiredMcpServers)) {
    throw new Error("Managed Claude MCP truth must be a JSON object or an object with an mcpServers map.");
  }
  const existingObject = existingText ? (JSON.parse(existingText) as Record<string, unknown>) : {};
  const nextObject = cloneValue(existingObject) ?? {};
  const changes: string[] = [];

  if (!nextObject["mcpServers"] || typeof nextObject["mcpServers"] !== "object") {
    changes.push("claude-mcp: add mcpServers");
    nextObject["mcpServers"] = {};
  }

  const nextMcpServers = nextObject["mcpServers"] as Record<string, Record<string, unknown>>;
  for (const managedServerName of existingOwnership.claudeMcp?.servers ?? []) {
    if (!(managedServerName in desiredMcpServers) && managedServerName in nextMcpServers) {
      changes.push(`claude-mcp: remove mcpServers.${managedServerName} absent from managed truth`);
      delete nextMcpServers[managedServerName];
    }
  }
  for (const [serverName, desiredConfig] of Object.entries(desiredMcpServers)) {
    if (!isRecord(desiredConfig)) {
      throw new Error(`Managed Claude MCP truth entry ${serverName} must be a JSON object.`);
    }
    const currentConfig = nextMcpServers[serverName];
    if (!isRecord(currentConfig)) {
      changes.push(`claude-mcp: add mcpServers.${serverName}`);
      nextMcpServers[serverName] = cloneValue(desiredConfig);
      continue;
    }

    for (const [fieldName, desiredValue] of Object.entries(desiredConfig)) {
      if (stableJson(currentConfig[fieldName]) !== stableJson(desiredValue)) {
        changes.push(`claude-mcp: set mcpServers.${serverName}.${fieldName}`);
        currentConfig[fieldName] = cloneValue(desiredValue);
      }
    }
    for (const fieldName of Object.keys(currentConfig)) {
      if (!(fieldName in desiredConfig)) {
        changes.push(`claude-mcp: remove mcpServers.${serverName}.${fieldName}`);
        delete currentConfig[fieldName];
      }
    }
  }

  if (changes.length === 0) {
    return {
      changed: false,
      changes,
      nextText: existingText ?? `${JSON.stringify(nextObject, null, 2)}\n`,
      managedOwnershipUpdate: {
        claudeMcp: {
          servers: Object.keys(desiredMcpServers).sort(),
        },
      },
    };
  }

  return {
    changed: true,
    changes,
    nextText: `${JSON.stringify(nextObject, null, 2)}\n`,
    managedOwnershipUpdate: {
      claudeMcp: {
        servers: Object.keys(desiredMcpServers).sort(),
      },
    },
  };
}

function mergeOwnershipStateUpdate(
  current: RuntimeConfigManagedOwnershipStateV1,
  update: Partial<RuntimeConfigManagedOwnershipStateV1> | undefined,
): RuntimeConfigManagedOwnershipStateV1 {
  return normalizeOwnershipState({
    ...current,
    ...(update?.codex
      ? {
          codex: {
            ...(current.codex ?? {}),
            ...update.codex,
          },
        }
      : {}),
    ...(update?.claudeMcp
      ? {
          claudeMcp: {
            ...(current.claudeMcp ?? {}),
            ...update.claudeMcp,
          },
        }
      : {}),
  });
}

async function planComponent(
  component: RuntimeConfigComponent,
  options: RuntimeConfigOptions & { managedConfigsRoot: string },
  liveHome: string,
  existingOwnership: RuntimeConfigManagedOwnershipStateV1,
): Promise<RuntimeConfigComponentPlan> {
  const { managedConfigsRoot, host } = options;

  if (component === "codex") {
    const staged = await readManagedConfigSource(managedConfigsRoot, host, "config.toml", "config.toml");
    const targetPath = path.join(liveHome, ".codex", "config.toml");
    const liveText = await readUtf8IfExists(targetPath);
    const merged = mergeCodexConfig(liveText, staged.text, existingOwnership);
    return {
      component,
      targetPath,
      stagedPath: staged.path,
      liveExists: typeof liveText === "string",
      desiredText: merged.nextText,
      desiredSha256: sha256(merged.nextText),
      ...(typeof liveText === "string"
        ? {
            liveText,
            liveSha256: sha256(liveText),
          }
        : {}),
      changes: merged.changes,
      managedOwnershipUpdate: merged.managedOwnershipUpdate,
    };
  }

  if (component === "claude-mcp") {
    const staged = await readManagedConfigSource(
      managedConfigsRoot,
      host,
      "claude.mcp.json",
      "claude.mcp.json",
    );
    const targetPath = path.join(liveHome, ".claude.json");
    const liveText = await readUtf8IfExists(targetPath);
    const merged = mergeClaudeMcp(liveText, staged.text, existingOwnership);
    return {
      component,
      targetPath,
      stagedPath: staged.path,
      liveExists: typeof liveText === "string",
      desiredText: merged.nextText,
      desiredSha256: sha256(merged.nextText),
      ...(typeof liveText === "string"
        ? {
            liveText,
            liveSha256: sha256(liveText),
          }
        : {}),
      changes: merged.changes,
      managedOwnershipUpdate: merged.managedOwnershipUpdate,
    };
  }

  const staged = await readManagedConfigSource(
    managedConfigsRoot,
    host,
    "claude.user.global.settings.json",
    "claude.user.global.settings.template.json",
  );
  const targetPath = path.join(liveHome, ".claude", "settings.json");
  const liveText = await readUtf8IfExists(targetPath);
  const merged = mergeClaudeSettings(liveText, staged.text);
  return {
    component,
    targetPath,
    stagedPath: staged.path,
    liveExists: typeof liveText === "string",
    desiredText: merged.nextText,
    desiredSha256: sha256(merged.nextText),
    ...(typeof liveText === "string"
      ? {
          liveText,
          liveSha256: sha256(liveText),
        }
      : {}),
    changes: merged.changes,
  };
}

function summarizeItems(items: RuntimeConfigItemResult[]): LocalBackendReceiptSummaryV1 {
  return items.reduce<LocalBackendReceiptSummaryV1>(
    (summary, item) => {
      summary.total += 1;
      if (item.status === "ok") {
        summary.ok += 1;
      }
      if (item.status === "drift") {
        summary.drift += 1;
        summary.changed += 1;
      }
      if (item.status === "applied") {
        summary.applied += 1;
        summary.changed += 1;
      }
      return summary;
    },
    { total: 0, ok: 0, drift: 0, changed: 0, applied: 0 },
  );
}

function buildResult(
  mode: LocalBackendMode,
  args: {
    requestedHost: string;
    actualHost: string;
    managedConfigsRoot: string;
  },
  liveHome: string,
  items: RuntimeConfigItemResult[],
): RuntimeConfigResult {
  const summary = summarizeItems(items);
  return {
    contractVersion: "local-backend/v1",
    backend: "runtime-config",
    mode,
    host: args.actualHost,
    requestedHost: args.requestedHost,
    ok: items.every((item) => item.status === "ok" || item.status === "applied"),
    generatedAt: new Date().toISOString(),
    summary,
    items,
    managedConfigsRoot: args.managedConfigsRoot,
    liveHome,
  };
}

function planToItem(plan: RuntimeConfigComponentPlan): RuntimeConfigItemResult {
  return {
    component: plan.component,
    status: plan.liveSha256 === plan.desiredSha256 ? "ok" : "drift",
    targetPath: plan.targetPath,
    stagedPath: plan.stagedPath,
    liveExists: plan.liveExists,
    desiredSha256: plan.desiredSha256,
    ...(plan.liveSha256 ? { liveSha256: plan.liveSha256 } : {}),
    changes: plan.changes,
  };
}

async function collectPlans(
  options: RuntimeConfigOptions & { managedConfigsRoot: string },
  liveHome: string,
  existingOwnership: RuntimeConfigManagedOwnershipStateV1,
): Promise<{ plans: RuntimeConfigComponentPlan[]; nextOwnership: RuntimeConfigManagedOwnershipStateV1 }> {
  const components = resolveComponents(options.components);
  const plans: RuntimeConfigComponentPlan[] = [];
  let nextOwnership = existingOwnership;
  for (const component of components) {
    const plan = await planComponent(component, options, liveHome, existingOwnership);
    plans.push(plan);
    nextOwnership = mergeOwnershipStateUpdate(nextOwnership, plan.managedOwnershipUpdate);
  }
  return { plans, nextOwnership };
}

function ownershipSha256(state: RuntimeConfigManagedOwnershipStateV1): string {
  return sha256(`${stableJson(normalizeOwnershipState(state))}\n`);
}

function resolveLocalApplyId(args: {
  requestedHost: string;
  actualHost: string;
  plans: RuntimeConfigComponentPlan[];
  existingOwnership: RuntimeConfigManagedOwnershipStateV1;
  nextOwnership: RuntimeConfigManagedOwnershipStateV1;
}): string {
  const identity = stableJson({
    requested_host: args.requestedHost,
    actual_host: args.actualHost,
    components: args.plans.map((plan) => ({
      component: plan.component,
      desired_sha256: plan.desiredSha256,
      ...(plan.liveSha256 ? { live_sha256: plan.liveSha256 } : {}),
    })),
    ownership_before_sha256: ownershipSha256(args.existingOwnership),
    ownership_after_sha256: ownershipSha256(args.nextOwnership),
  });
  return `local_${sha256(identity).slice(0, 32)}`;
}

function mutationEffectPhases(
  plan: RuntimeConfigComponentPlan,
  ownershipBefore: RuntimeConfigManagedOwnershipStateV1,
  ownershipAfter: RuntimeConfigManagedOwnershipStateV1,
): RuntimeConfigMutationEffectPhase[] {
  const phases: RuntimeConfigMutationEffectPhase[] = [];
  if (plan.liveSha256 !== plan.desiredSha256) {
    if (plan.liveExists && plan.liveText !== undefined) {
      phases.push("backup");
    }
    phases.push("target");
  }
  if (stableJson(ownershipBefore) !== stableJson(ownershipAfter)) {
    phases.push("state");
  }
  return phases;
}

function mutationFailureId(
  phase: RuntimeConfigMutationEffectPhase,
): `runtime_config_${RuntimeConfigMutationEffectPhase}_failed` {
  if (phase === "backup") {
    return "runtime_config_backup_failed";
  }
  if (phase === "target") {
    return "runtime_config_target_failed";
  }
  return "runtime_config_state_failed";
}

export async function planRuntimeConfig(options: RuntimeConfigOptions): Promise<RuntimeConfigResult> {
  requireRuntimeConfigHostSegment(options.host);
  const liveHome = path.resolve(options.liveHome ?? homedir());
  const managedConfigsRoot = resolveManagedConfigsRoot(options, liveHome);
  const existingOwnership = await readRuntimeConfigState(liveHome);
  const actualHost = resolveActualHost();
  const { plans } = await collectPlans({ ...options, managedConfigsRoot }, liveHome, existingOwnership);
  return buildResult("plan", {
    requestedHost: options.host,
    actualHost,
    managedConfigsRoot,
  }, liveHome, plans.map(planToItem));
}

export async function verifyRuntimeConfig(options: RuntimeConfigOptions): Promise<RuntimeConfigResult> {
  requireRuntimeConfigHostSegment(options.host);
  const liveHome = path.resolve(options.liveHome ?? homedir());
  const managedConfigsRoot = resolveManagedConfigsRoot(options, liveHome);
  const existingOwnership = await readRuntimeConfigState(liveHome);
  const actualHost = resolveActualHost();
  const { plans } = await collectPlans({ ...options, managedConfigsRoot }, liveHome, existingOwnership);
  return buildResult("verify", {
    requestedHost: options.host,
    actualHost,
    managedConfigsRoot,
  }, liveHome, plans.map(planToItem));
}

/**
 * Applies runtime configuration one component at a time.
 *
 * Each component that mutates target or ownership state persists its own
 * intent/result pair. A thrown error therefore means the request stopped; it
 * does not imply rollback of components whose result receipts say applied.
 */
export async function applyRuntimeConfig(
  options: RuntimeConfigOptions,
  provenance?: ApiProvenanceV1,
): Promise<RuntimeConfigResult> {
  requireRuntimeConfigHostSegment(options.host);
  const validatedProvenance = provenance === undefined ? undefined : validateApiProvenance(provenance);
  const liveHome = path.resolve(options.liveHome ?? homedir());
  return withRuntimeConfigApplyLock(liveHome, () => applyRuntimeConfigLocked(
    options,
    validatedProvenance,
    liveHome,
  ));
}

async function applyRuntimeConfigLocked(
  options: RuntimeConfigOptions,
  validatedProvenance: ApiProvenanceV1 | undefined,
  liveHome: string,
): Promise<RuntimeConfigResult> {
  const managedConfigsRoot = resolveManagedConfigsRoot(options, liveHome);
  const existingOwnership = await readRuntimeConfigState(liveHome);
  const actualHost = resolveActualHost();
  const { plans, nextOwnership } = await collectPlans({ ...options, managedConfigsRoot }, liveHome, existingOwnership);
  const applyId = validatedProvenance?.request_id ?? resolveLocalApplyId({
    requestedHost: options.host,
    actualHost,
    plans,
    existingOwnership,
    nextOwnership,
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "").replace("Z", "Z");
  const items: RuntimeConfigItemResult[] = [];
  let persistedOwnership = existingOwnership;

  for (const plan of plans) {
    const componentOwnership = mergeOwnershipStateUpdate(persistedOwnership, plan.managedOwnershipUpdate);
    const plannedPhases = mutationEffectPhases(plan, persistedOwnership, componentOwnership);
    if (plannedPhases.length === 0) {
      items.push(planToItem(plan));
      continue;
    }

    const receiptPaths = resolveRuntimeConfigMutationReceiptPaths(liveHome, applyId, plan.component);
    const intentRecordedAt = new Date().toISOString();
    const hashes: RuntimeConfigMutationHashesV1 = {
      desired_sha256: plan.desiredSha256,
      ...(plan.liveSha256 ? { live_sha256: plan.liveSha256 } : {}),
      ownership_before_sha256: ownershipSha256(persistedOwnership),
      ownership_after_sha256: ownershipSha256(componentOwnership),
    };
    const commonReceipt = {
      apply_id: applyId,
      component: plan.component,
      target_locator: targetLocator(plan.component),
      hashes,
      ...(validatedProvenance ? { provenance: validatedProvenance } : {}),
      planned_phases: plannedPhases,
    };
    const intentReceipt: RuntimeConfigMutationIntentReceiptV1 = {
      schema_version: RUNTIME_CONFIG_MUTATION_INTENT_SCHEMA_VERSION,
      ...commonReceipt,
      phase: "intent",
      outcome: "pending",
      recorded_at: intentRecordedAt,
    };
    await writeMutationReceipt(receiptPaths.intent, intentReceipt, liveHome);

    let backupPath: string | undefined;
    let observedOutputSha256: string | undefined;
    const completedPhases: RuntimeConfigMutationEffectPhase[] = [];
    let activePhase = plannedPhases[0];
    if (!activePhase) {
      throw new Error(`Runtime-config component ${plan.component} has no mutation phase after intent creation.`);
    }
    try {
      if (plannedPhases.includes("target") && await isSymbolicLink(plan.targetPath)) {
        activePhase = "target";
        throw new Error(
          `Runtime-config component ${plan.component} target is a symbolic link; refusing non-atomic convergence.`,
        );
      }
      if (plannedPhases.includes("backup")) {
        activePhase = "backup";
        backupPath = `${plan.targetPath}.bak.${stamp}`;
        if (plan.liveText === undefined) {
          throw new Error(`Runtime-config component ${plan.component} cannot back up an unreadable live target.`);
        }
        await writeDurableText(backupPath, plan.liveText);
        completedPhases.push("backup");
      }
      if (plannedPhases.includes("target")) {
        activePhase = "target";
        await writeDurableText(plan.targetPath, plan.desiredText);
        observedOutputSha256 = sha256(await readFile(plan.targetPath, "utf8"));
        if (observedOutputSha256 !== plan.desiredSha256) {
          throw new Error(`Runtime-config component ${plan.component} target hash changed during durable apply.`);
        }
        completedPhases.push("target");
      }
      if (plannedPhases.includes("state")) {
        activePhase = "state";
        await writeRuntimeConfigState(liveHome, componentOwnership);
        completedPhases.push("state");
      }
    } catch (error) {
      const failedReceipt: RuntimeConfigMutationResultReceiptV1 = {
        schema_version: RUNTIME_CONFIG_MUTATION_RESULT_SCHEMA_VERSION,
        ...commonReceipt,
        hashes: {
          ...hashes,
          ...(observedOutputSha256 ? { output_sha256: observedOutputSha256 } : {}),
        },
        phase: activePhase,
        outcome: completedPhases.length > 0 ? "partial" : "failed",
        completed_phases: completedPhases,
        failure_id: mutationFailureId(activePhase),
        intent_recorded_at: intentRecordedAt,
        recorded_at: new Date().toISOString(),
      };
      try {
        await writeMutationReceipt(receiptPaths.result, failedReceipt, liveHome);
      } catch (receiptError) {
        throw new AggregateError(
          [error, receiptError],
          `Runtime-config component ${plan.component} effect and failure-receipt persistence both failed.`,
          { cause: error },
        );
      }
      throw error;
    }

    const resultReceipt: RuntimeConfigMutationResultReceiptV1 = {
      schema_version: RUNTIME_CONFIG_MUTATION_RESULT_SCHEMA_VERSION,
      ...commonReceipt,
      hashes: {
        ...hashes,
        ...(observedOutputSha256 ? { output_sha256: observedOutputSha256 } : {}),
      },
      phase: "complete",
      outcome: "applied",
      completed_phases: completedPhases,
      intent_recorded_at: intentRecordedAt,
      recorded_at: new Date().toISOString(),
    };
    await writeMutationReceipt(receiptPaths.result, resultReceipt, liveHome);
    persistedOwnership = componentOwnership;

    items.push({
      component: plan.component,
      status: "applied",
      targetPath: plan.targetPath,
      stagedPath: plan.stagedPath,
      liveExists: plan.liveExists,
      desiredSha256: plan.desiredSha256,
      ...(plan.liveSha256 ? { liveSha256: plan.liveSha256 } : {}),
      ...(observedOutputSha256 ? { outputSha256: observedOutputSha256 } : {}),
      ...(backupPath ? { backupPath } : {}),
      changes: plan.changes,
    });
  }

  return buildResult("apply", {
    requestedHost: options.host,
    actualHost,
    managedConfigsRoot,
  }, liveHome, items);
}
