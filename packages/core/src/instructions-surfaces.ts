import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { renderInstructionsFromFiles, verifyInstructionsFromFiles } from "./instructions";
import type {
  InstructionManagedMarker,
  InstructionManagedFile,
  InstructionMutationAction,
  InstructionMutationChange,
  InstructionMutationMode,
  InstructionMutationPlannedChange,
  InstructionMutationSummary,
  InstructionReconcileEvidence,
  InstructionReconcileFinding,
  InstructionReconcileReason,
  InstructionReconcileStatus,
  InstructionSurfaceManifest,
  InstructionSurfaceResolvedSourceRef,
  InstructionTargetBinding,
  InstructionTargetClass,
  InstructionTargetEntry,
  InstructionsListOptions,
  InstructionsListResult,
  InstructionsRenderInputFiles,
  InstructionsShowResult,
  InstructionsSurfaceReconcileOptions,
  InstructionsSurfaceReconcileResult,
  InstructionsSurfaceRenderOptions,
  InstructionsSurfaceRenderResult,
  InstructionsSurfaceMutationOptions,
  InstructionsSurfaceMutationResult,
  InstructionSurfaceStatus,
  InstructionsSurfaceSummary,
  InstructionsSurfaceVerifyOptions,
  InstructionsSurfaceVerifyResult,
  InstructionsTargetsOptions,
  InstructionsTargetsResult,
} from "./types";

const MANIFEST_FILE_PATTERN = /\.(ya?ml)$/i;

interface LoadedSurface {
  manifestPath: string;
  manifest: InstructionSurfaceManifest;
}

interface ParsedFrontmatterDocument {
  frontmatter?: Record<string, unknown>;
  body: string;
  parseError?: string;
}

interface ReadTargetState {
  exists: boolean;
  targetRootExists: boolean;
  rawText?: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
  marker?: InstructionManagedMarker;
  markerMalformed: boolean;
  hasNestedFrontmatter: boolean;
  liveContentSha256?: string;
  evidence: InstructionReconcileEvidence;
}

interface PlannedInstructionMutation {
  loaded: LoadedSurface;
  binding: InstructionTargetBinding;
  managedFile: string;
  targetPath: string;
  expectedOutput: string;
  markerMode: "frontmatter" | "none";
  finding: InstructionReconcileFinding;
  action: InstructionMutationAction;
}

function instructionSurfaceNotFoundMessage(surfacesDir: string, surfaceId: string): string {
  return `Instruction surface "${surfaceId}" not found under ${path.resolve(surfacesDir)}.`;
}

function instructionSurfaceArchivedMessage(surfacesDir: string, surfaceId: string): string {
  return `Instruction surface "${surfaceId}" is archived under ${path.resolve(surfacesDir)}. Pass --include-archived to include it.`;
}

function parseYamlText<T>(yamlText: string, filePath: string): T {
  try {
    return YAML.parse(yamlText) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse YAML at ${filePath}: ${message}`);
  }
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function assertSurfaceStatus(value: unknown, label: string): InstructionSurfaceStatus {
  if (value === "active" || value === "archived") {
    return value;
  }
  throw new Error(`${label} must be "active" or "archived".`);
}

function assertManagedFiles(value: unknown, label: string): InstructionManagedFile[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of file names.`);
  }
  return value.map((entry, index) => {
    if (typeof entry === "string") {
      return { path: assertString(entry, `${label}[${index}]`) };
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${label}[${index}] must be a file name or object.`);
    }
    const record = entry as Record<string, unknown>;
    const context = record.context === undefined
      ? undefined
      : assertInstructionFileContext(record.context, `${label}[${index}].context`);
    return {
      path: assertString(record.path, `${label}[${index}].path`),
      ...(typeof record.source_path === "string" && record.source_path.trim().length > 0
        ? { sourcePath: record.source_path.trim() }
        : {}),
      ...(context ? { context } : {}),
      ...(record.marker === "none" ? { marker: "none" as const } : {}),
    };
  });
}

function assertInstructionFileContext(value: unknown, label: string): Record<string, string | number | boolean> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object with scalar values.`);
  }
  const context: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      context[key] = entry;
      continue;
    }
    throw new Error(`${label}.${key} must be a string, number, or boolean.`);
  }
  return context;
}

function managedFilePath(managedFile: InstructionManagedFile): string {
  return managedFile.path;
}

function managedFileMarkerMode(managedFile: InstructionManagedFile): "frontmatter" | "none" {
  return managedFile.marker ?? "frontmatter";
}

function liveIsoTimestamp(frontmatter: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = frontmatter?.[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && Number.isFinite(Date.parse(trimmed)) ? trimmed : undefined;
}

function liveRenderTimeContext(state: ReadTargetState): Record<string, string> | undefined {
  const nowIso = liveIsoTimestamp(state.frontmatter, "rendered_at")
    ?? liveIsoTimestamp(state.frontmatter, "last_modified");
  return nowIso ? { NOW_ISO: nowIso } : undefined;
}

function resolveManagedFileSourcePath(loaded: LoadedSurface, managedFile: InstructionManagedFile): string | undefined {
  if (!managedFile.sourcePath) {
    return undefined;
  }
  const baseDir = path.dirname(loaded.manifestPath);
  return path.isAbsolute(managedFile.sourcePath)
    ? managedFile.sourcePath
    : path.resolve(baseDir, managedFile.sourcePath);
}

function assertSelectors(
  value: unknown,
  label: string,
): { hosts?: string[] } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const rawHosts = (value as { hosts?: unknown }).hosts;
  if (rawHosts === undefined) {
    return {};
  }
  if (!Array.isArray(rawHosts)) {
    throw new Error(`${label}.hosts must be an array of host aliases.`);
  }
  return {
    hosts: rawHosts.map((entry, index) => assertString(entry, `${label}.hosts[${index}]`)),
  };
}

function normalizeTargetBindings(value: unknown, label: string): InstructionTargetBinding[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${label}[${index}] must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const bindingClass = assertString(record.class, `${label}[${index}].class`);
    if (
      bindingClass !== "host_home" &&
      bindingClass !== "repo_root" &&
      bindingClass !== "directory_root" &&
      bindingClass !== "staged_preview" &&
      bindingClass !== "bundle_output"
    ) {
      throw new Error(`${label}[${index}].class has unsupported value: ${bindingClass}`);
    }
    const managedFiles = assertManagedFiles(record.managed_files, `${label}[${index}].managed_files`);
    const selectors = assertSelectors(record.selectors, `${label}[${index}].selectors`);
    return {
      bindingId: assertString(record.binding_id, `${label}[${index}].binding_id`),
      class: bindingClass,
      path: assertString(record.path, `${label}[${index}].path`),
      ...(managedFiles ? { managedFiles } : {}),
      ...(selectors ? { selectors } : {}),
      ...(typeof record.description === "string" && record.description.trim().length > 0
        ? { description: record.description.trim() }
        : {}),
    };
  });
}

function normalizeManifest(filePath: string, raw: unknown): InstructionSurfaceManifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Instruction surface manifest at ${filePath} must be an object.`);
  }
  const record = raw as Record<string, unknown>;
  const sourceRefRaw = record.source_ref;
  if (typeof sourceRefRaw !== "object" || sourceRefRaw === null || Array.isArray(sourceRefRaw)) {
    throw new Error(`${filePath}: source_ref must be an object.`);
  }
  const sourceRef = sourceRefRaw as Record<string, unknown>;
  const expectedDir =
    typeof sourceRef.expected_dir === "string" && sourceRef.expected_dir.trim().length > 0
      ? sourceRef.expected_dir.trim()
      : undefined;

  return {
    surfaceId: assertString(record.surface_id, `${filePath}: surface_id`),
    status: assertSurfaceStatus(record.status, `${filePath}: status`),
    ...(typeof record.owner === "string" && record.owner.trim().length > 0
      ? { owner: record.owner.trim() }
      : {}),
    ...(typeof record.description === "string" && record.description.trim().length > 0
      ? { description: record.description.trim() }
      : {}),
    sourceRef: {
      fleetPath: assertString(sourceRef.fleet_path, `${filePath}: source_ref.fleet_path`),
      hostsDir: assertString(sourceRef.hosts_dir, `${filePath}: source_ref.hosts_dir`),
      templatePath: assertString(sourceRef.template_path, `${filePath}: source_ref.template_path`),
      partialsDir: assertString(sourceRef.partials_dir, `${filePath}: source_ref.partials_dir`),
      ...(expectedDir ? { expectedDir } : {}),
    },
    targetBindings: normalizeTargetBindings(record.target_bindings, `${filePath}: target_bindings`),
  };
}

async function loadSurfaceFile(filePath: string): Promise<LoadedSurface> {
  const yamlText = await fs.readFile(filePath, "utf8");
  return {
    manifestPath: path.resolve(filePath),
    manifest: normalizeManifest(filePath, parseYamlText(yamlText, filePath)),
  };
}

async function loadSurfaces(surfacesDir: string): Promise<LoadedSurface[]> {
  const resolvedDir = path.resolve(surfacesDir);
  const entries = await fs.readdir(resolvedDir, { withFileTypes: true });
  const nestedDirectories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (nestedDirectories.length > 0) {
    throw new Error(
      `Instruction surfaces directory ${resolvedDir} must be flat. Nested directories are not supported: ${nestedDirectories.join(", ")}.`,
    );
  }
  const manifests = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && MANIFEST_FILE_PATTERN.test(entry.name))
      .map((entry) => loadSurfaceFile(path.join(resolvedDir, entry.name))),
  );
  const sortedManifests = manifests.sort((left, right) => left.manifest.surfaceId.localeCompare(right.manifest.surfaceId));
  const seenSurfaceIds = new Map<string, string>();
  for (const loaded of sortedManifests) {
    const previousManifestPath = seenSurfaceIds.get(loaded.manifest.surfaceId);
    if (previousManifestPath) {
      throw new Error(
        `Duplicate surface_id "${loaded.manifest.surfaceId}" found under ${resolvedDir}: ${previousManifestPath} and ${loaded.manifestPath}. Each manifest must declare a unique surface_id.`,
      );
    }
    seenSurfaceIds.set(loaded.manifest.surfaceId, loaded.manifestPath);
  }
  return sortedManifests;
}

function maybeFilterArchived<T extends LoadedSurface>(surfaces: T[], includeArchived: boolean): T[] {
  if (includeArchived) {
    return surfaces;
  }
  return surfaces.filter((entry) => entry.manifest.status !== "archived");
}

function resolveSurfaceSourceRef(loaded: LoadedSurface): InstructionSurfaceResolvedSourceRef {
  const baseDir = path.dirname(loaded.manifestPath);
  const toAbsolute = (value: string): string => (path.isAbsolute(value) ? value : path.resolve(baseDir, value));
  return {
    fleetPath: toAbsolute(loaded.manifest.sourceRef.fleetPath),
    hostsDir: toAbsolute(loaded.manifest.sourceRef.hostsDir),
    templatePath: toAbsolute(loaded.manifest.sourceRef.templatePath),
    partialsDir: toAbsolute(loaded.manifest.sourceRef.partialsDir),
    ...(loaded.manifest.sourceRef.expectedDir ? { expectedDir: toAbsolute(loaded.manifest.sourceRef.expectedDir) } : {}),
  };
}

function resolveTargetBinding(
  loaded: LoadedSurface,
  binding: InstructionTargetBinding,
  options: { repoRoot?: string } = {},
): InstructionTargetBinding {
  const baseDir = path.dirname(loaded.manifestPath);
  const overriddenPath =
    binding.class === "repo_root" && options.repoRoot && options.repoRoot.trim().length > 0
      ? options.repoRoot
      : binding.path;
  return {
    ...binding,
    path: path.isAbsolute(overriddenPath) ? overriddenPath : path.resolve(baseDir, overriddenPath),
  };
}

function summarizeSurface(loaded: LoadedSurface): InstructionsSurfaceSummary {
  const { manifest } = loaded;
  return {
    surfaceId: manifest.surfaceId,
    status: manifest.status,
    manifestPath: loaded.manifestPath,
    ...(manifest.owner ? { owner: manifest.owner } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    bindingCount: manifest.targetBindings?.length ?? 0,
  };
}

async function requireSurface(surfacesDir: string, surfaceId: string): Promise<LoadedSurface> {
  const loaded = (await loadSurfaces(surfacesDir)).find((entry) => entry.manifest.surfaceId === surfaceId);
  if (!loaded) {
    throw new Error(instructionSurfaceNotFoundMessage(surfacesDir, surfaceId));
  }
  return loaded;
}

function toShowResult(loaded: LoadedSurface, options: { repoRoot?: string } = {}): InstructionsShowResult {
  const { manifest } = loaded;
  return {
    surfaceId: manifest.surfaceId,
    status: manifest.status,
    manifestPath: loaded.manifestPath,
    ...(manifest.owner ? { owner: manifest.owner } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    sourceRef: resolveSurfaceSourceRef(loaded),
    targetBindings: (manifest.targetBindings ?? []).map((binding) => resolveTargetBinding(loaded, binding, options)),
  };
}

function resolveExpectedDir(showResult: InstructionsShowResult, explicitExpectedDir?: string): string {
  if (explicitExpectedDir && explicitExpectedDir.trim().length > 0) {
    return path.resolve(explicitExpectedDir);
  }
  if (showResult.sourceRef.expectedDir) {
    return showResult.sourceRef.expectedDir;
  }
  const previewBinding = showResult.targetBindings.find((binding) => binding.class === "staged_preview");
  if (previewBinding) {
    return previewBinding.path;
  }
  throw new Error(
    `Instruction surface "${showResult.surfaceId}" does not define an expected_dir or staged_preview binding.`,
  );
}

function buildRenderInputFiles(showResult: InstructionsShowResult): InstructionsRenderInputFiles {
  return {
    fleetPath: showResult.sourceRef.fleetPath,
    hostsDir: showResult.sourceRef.hostsDir,
    templatePath: showResult.sourceRef.templatePath,
    partialsDir: showResult.sourceRef.partialsDir,
  };
}

function selectLoadedSurfaces(
  surfacesDir: string,
  allLoaded: LoadedSurface[],
  options: { surfaceId?: string; includeArchived?: boolean },
): LoadedSurface[] {
  const loaded = maybeFilterArchived(allLoaded, Boolean(options.includeArchived));
  const filtered = options.surfaceId
    ? loaded.filter((entry) => entry.manifest.surfaceId === options.surfaceId)
    : loaded;

  if (options.surfaceId && filtered.length === 0) {
    const archivedSurface = allLoaded.find(
      (entry) => entry.manifest.surfaceId === options.surfaceId && entry.manifest.status === "archived",
    );
    throw new Error(
      archivedSurface
        ? instructionSurfaceArchivedMessage(surfacesDir, options.surfaceId)
        : instructionSurfaceNotFoundMessage(surfacesDir, options.surfaceId),
    );
  }

  return filtered;
}

const LOCAL_RECONCILE_TARGET_CLASSES = new Set<InstructionTargetClass>(["directory_root", "host_home", "repo_root"]);

function isLocalReconcileTarget(bindingClass: InstructionTargetClass): boolean {
  return LOCAL_RECONCILE_TARGET_CLASSES.has(bindingClass);
}

function bindingAppliesToHost(binding: InstructionTargetBinding, host: string): boolean {
  const selectorHosts = binding.selectors?.hosts;
  return !selectorHosts || selectorHosts.includes(host);
}

function createEmptyStatusSummary(): Record<InstructionReconcileStatus, number> {
  return {
    managed_ok: 0,
    managed_drift: 0,
    unmanaged_match: 0,
    unmanaged_present: 0,
    missing_expected: 0,
    archived_managed_present: 0,
    ownership_conflict: 0,
  };
}

function createEmptyMutationActionSummary(): Record<InstructionMutationAction, number> {
  return {
    write_missing: 0,
    update_managed: 0,
    reviewed_overwrite: 0,
    adopt_unmanaged: 0,
    already_managed: 0,
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function buildInstructionManagedMarker(options: {
  surfaceId: string;
  bindingId: string;
  host: string;
  expectedOutput: string;
}): InstructionManagedMarker {
  const contentSha256 = sha256(options.expectedOutput);
  return {
    managedBy: "instructions",
    surfaceId: options.surfaceId,
    bindingId: options.bindingId,
    bundleId: `instructions:${options.surfaceId}:${options.host}:${contentSha256.slice(0, 12)}`,
    renderedHost: options.host,
    contentSha256,
    appliedAt: new Date().toISOString(),
  };
}

function toManagedInstructionFrontmatter(marker: InstructionManagedMarker): Record<string, unknown> {
  return {
    calyx: {
      managed_by: marker.managedBy,
      surface_id: marker.surfaceId,
      binding_id: marker.bindingId,
      ...(marker.bundleId ? { bundle_id: marker.bundleId } : {}),
      ...(marker.renderedHost ? { rendered_host: marker.renderedHost } : {}),
      ...(marker.contentSha256 ? { content_sha256: marker.contentSha256 } : {}),
      ...(marker.appliedAt ? { applied_at: marker.appliedAt } : {}),
    },
  };
}

function wrapManagedInstructionDocument(body: string, marker: InstructionManagedMarker): string {
  const parsedDocument = parseFrontmatterDocument(body, "<rendered instruction output>");
  if (parsedDocument.parseError) {
    throw new Error(parsedDocument.parseError);
  }

  const frontmatter = {
    ...(parsedDocument.frontmatter ?? {}),
    ...toManagedInstructionFrontmatter(marker),
  };

  return [
    "---",
    YAML.stringify(frontmatter).trimEnd(),
    "---",
    parsedDocument.body,
  ].join("\n");
}

function parseFrontmatterDocument(text: string, filePath: string): ParsedFrontmatterDocument {
  const normalizedText = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const frontmatterMatch = normalizedText.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/);
  if (!frontmatterMatch) {
    return { body: normalizedText };
  }

  const yamlText = frontmatterMatch[1] ?? "";
  const body = normalizedText.slice(frontmatterMatch[0].length);

  if (yamlText.trim().length === 0) {
    return { body, frontmatter: {} };
  }

  try {
    const parsed = parseYamlText<unknown>(yamlText, `${filePath} frontmatter`);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        body,
        parseError: `${filePath} frontmatter must parse to an object.`,
      };
    }
    return {
      body,
      frontmatter: parsed as Record<string, unknown>,
    };
  } catch (error) {
    return {
      body,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function optionalMarkerString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stripManagedInstructionFrontmatter(
  frontmatter: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!frontmatter) {
    return undefined;
  }
  const rest = Object.fromEntries(
    Object.entries(frontmatter).filter(([key]) => key !== "calyx"),
  );
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function normalizeStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeStructuredValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeStructuredValue(entry)]),
    );
  }
  return value;
}

function structuredValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeStructuredValue(left)) === JSON.stringify(normalizeStructuredValue(right));
}

function parseInstructionManagedMarker(
  frontmatter: Record<string, unknown> | undefined,
  parseError?: string,
): { marker?: InstructionManagedMarker; malformed: boolean } {
  if (parseError) {
    return { malformed: true };
  }
  if (!frontmatter || !Object.prototype.hasOwnProperty.call(frontmatter, "calyx")) {
    return { malformed: false };
  }

  const rawCalyx = frontmatter["calyx"];
  if (typeof rawCalyx !== "object" || rawCalyx === null || Array.isArray(rawCalyx)) {
    return { malformed: true };
  }

  const calyxRecord = rawCalyx as Record<string, unknown>;
  if (calyxRecord["managed_by"] !== "instructions") {
    return { malformed: true };
  }

  const surfaceId = optionalMarkerString(calyxRecord["surface_id"]);
  const bindingId = optionalMarkerString(calyxRecord["binding_id"]);
  const bundleId = optionalMarkerString(calyxRecord["bundle_id"]);
  const renderedHost = optionalMarkerString(calyxRecord["rendered_host"]);
  const contentSha256 = optionalMarkerString(calyxRecord["content_sha256"]);
  const appliedAt = optionalMarkerString(calyxRecord["applied_at"]);

  const marker: InstructionManagedMarker = {
    managedBy: "instructions",
    ...(surfaceId ? { surfaceId } : {}),
    ...(bindingId ? { bindingId } : {}),
    ...(bundleId ? { bundleId } : {}),
    ...(renderedHost ? { renderedHost } : {}),
    ...(contentSha256 ? { contentSha256 } : {}),
    ...(appliedAt ? { appliedAt } : {}),
  };

  if (!marker.surfaceId || !marker.bindingId) {
    return { marker, malformed: true };
  }

  return { marker, malformed: false };
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await fs.access(pathname);
    return true;
  } catch {
    return false;
  }
}

async function readTargetState(targetPath: string, targetRootPath: string): Promise<ReadTargetState> {
  const targetRootExists = await pathExists(targetRootPath);

  try {
    const targetLstat = await fs.lstat(targetPath);
    const rawText = await fs.readFile(targetPath, "utf8");
    const parsedDocument = parseFrontmatterDocument(rawText, targetPath);
    const parsedMarker = parseInstructionManagedMarker(parsedDocument.frontmatter, parsedDocument.parseError);
    const nestedDocument = parseFrontmatterDocument(
      parsedDocument.body,
      `${targetPath} nested managed body`,
    );
    const hasNestedFrontmatter = Boolean(nestedDocument.frontmatter);

    let symlinkTarget: string | undefined;
    if (targetLstat.isSymbolicLink()) {
      try {
        symlinkTarget = await fs.realpath(targetPath);
      } catch {
        try {
          symlinkTarget = await fs.readlink(targetPath);
        } catch {
          symlinkTarget = undefined;
        }
      }
    }

    return {
      exists: true,
      targetRootExists,
      rawText,
      ...(parsedDocument.frontmatter ? { frontmatter: parsedDocument.frontmatter } : {}),
      body: parsedDocument.body,
      ...(parsedMarker.marker ? { marker: parsedMarker.marker } : {}),
      markerMalformed: parsedMarker.malformed,
      hasNestedFrontmatter,
      liveContentSha256: sha256(parsedDocument.body),
      evidence: {
        liveExists: true,
        targetRootExists,
        ...(hasNestedFrontmatter ? { nestedFrontmatter: true } : {}),
        ...(targetLstat.isSymbolicLink() ? { isSymlink: true } : {}),
        ...(symlinkTarget ? { symlinkTarget } : {}),
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        exists: false,
        targetRootExists,
        markerMalformed: false,
        hasNestedFrontmatter: false,
        evidence: {
          liveExists: false,
          targetRootExists,
        },
      };
    }
    throw error;
  }
}

function makeFinding(
  loaded: LoadedSurface,
  binding: InstructionTargetBinding,
  managedFile: string,
  targetPath: string,
  expectedContentSha256: string,
  status: InstructionReconcileStatus,
  reason: InstructionReconcileReason,
  state: ReadTargetState,
): InstructionReconcileFinding {
  return {
    surfaceId: loaded.manifest.surfaceId,
    bindingId: binding.bindingId,
    manifestPath: loaded.manifestPath,
    targetClass: binding.class,
    targetPath,
    managedFile,
    status,
    reason,
    expectedContentSha256,
    ...(state.liveContentSha256 ? { liveContentSha256: state.liveContentSha256 } : {}),
    ...(state.marker ? { marker: state.marker } : {}),
    evidence: state.evidence,
  };
}

function classifyActiveTarget(
  loaded: LoadedSurface,
  binding: InstructionTargetBinding,
  managedFile: string,
  targetPath: string,
  expectedOutput: string,
  state: ReadTargetState,
  archivedSurfaceIds: Set<string>,
): InstructionReconcileFinding {
  const expectedContentSha256 = sha256(expectedOutput);
  const expectedDocument = parseFrontmatterDocument(expectedOutput, "<rendered instruction output>");
  if (expectedDocument.parseError) {
    throw new Error(expectedDocument.parseError);
  }

  if (!state.exists) {
    return makeFinding(
      loaded,
      binding,
      managedFile,
      targetPath,
      expectedContentSha256,
      "missing_expected",
      state.targetRootExists ? "file_missing" : "target_root_missing",
      state,
    );
  }

  if (state.markerMalformed) {
    return makeFinding(
      loaded,
      binding,
      managedFile,
      targetPath,
      expectedContentSha256,
      "ownership_conflict",
      "marker_malformed",
      state,
    );
  }

  const markerSurfaceId = state.marker?.surfaceId;
  if (markerSurfaceId && archivedSurfaceIds.has(markerSurfaceId)) {
    return makeFinding(
      loaded,
      binding,
      managedFile,
      targetPath,
      expectedContentSha256,
      "archived_managed_present",
      "archived_surface_target_present",
      state,
    );
  }

  const liveFrontmatterWithoutMarker = stripManagedInstructionFrontmatter(state.frontmatter);
  const expectedFrontmatter = expectedDocument.frontmatter;
  const liveMatchesExpected = state.marker
    ? structuredValuesEqual(liveFrontmatterWithoutMarker, expectedFrontmatter) && state.body === expectedDocument.body
    : state.rawText === expectedOutput;
  if (state.marker) {
    if (state.marker.surfaceId !== loaded.manifest.surfaceId) {
      return makeFinding(
        loaded,
        binding,
        managedFile,
        targetPath,
        expectedContentSha256,
        "ownership_conflict",
        "marker_surface_mismatch",
        state,
      );
    }
    if (state.marker.bindingId !== binding.bindingId) {
      return makeFinding(
        loaded,
        binding,
        managedFile,
        targetPath,
        expectedContentSha256,
        "ownership_conflict",
        "marker_binding_mismatch",
        state,
      );
    }
    if (state.hasNestedFrontmatter) {
      return makeFinding(
        loaded,
        binding,
        managedFile,
        targetPath,
        expectedContentSha256,
        "managed_drift",
        "marker_document_shape_mismatch",
        state,
      );
    }
    return makeFinding(
      loaded,
      binding,
      managedFile,
      targetPath,
      expectedContentSha256,
      liveMatchesExpected ? "managed_ok" : "managed_drift",
      liveMatchesExpected ? "marker_matches" : "marker_content_mismatch",
      state,
    );
  }

  return makeFinding(
    loaded,
    binding,
    managedFile,
    targetPath,
    expectedContentSha256,
    liveMatchesExpected ? "unmanaged_match" : "unmanaged_present",
    liveMatchesExpected ? "content_matches_without_marker" : "content_differs_without_marker",
    state,
  );
}

function classifyRawManagedTarget(
  loaded: LoadedSurface,
  binding: InstructionTargetBinding,
  managedFile: string,
  targetPath: string,
  expectedOutput: string,
  state: ReadTargetState,
): InstructionReconcileFinding {
  const expectedContentSha256 = sha256(expectedOutput);
  if (!state.exists) {
    return makeFinding(
      loaded,
      binding,
      managedFile,
      targetPath,
      expectedContentSha256,
      "missing_expected",
      state.targetRootExists ? "file_missing" : "target_root_missing",
      state,
    );
  }
  return makeFinding(
    loaded,
    binding,
    managedFile,
    targetPath,
    expectedContentSha256,
    state.rawText === expectedOutput ? "managed_ok" : "managed_drift",
    state.rawText === expectedOutput ? "marker_matches" : "marker_content_mismatch",
    state,
  );
}

async function reconcileLoadedSurface(
  loaded: LoadedSurface,
  host: string,
  archivedSurfaceIds: Set<string>,
  options: { repoRoot?: string } = {},
): Promise<InstructionReconcileFinding[]> {
  const showResult = toShowResult(loaded, {
    ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
  });

  const applicableBindings = showResult.targetBindings.filter(
    (binding) => isLocalReconcileTarget(binding.class) && bindingAppliesToHost(binding, host),
  );
  const findings: InstructionReconcileFinding[] = [];

  for (const binding of applicableBindings) {
    if (!binding.managedFiles || binding.managedFiles.length === 0) {
      throw new Error(
        `Instruction surface "${loaded.manifest.surfaceId}" binding "${binding.bindingId}" must declare managed_files for reconcile.`,
      );
    }

    for (const managedFile of binding.managedFiles) {
      const managedPath = managedFilePath(managedFile);
      const targetPath = path.join(binding.path, managedPath);
      const state = await readTargetState(targetPath, binding.path);
      const expectedOutput = await renderManagedFileOutput(
        loaded,
        showResult,
        host,
        managedFile,
        liveRenderTimeContext(state),
      );

      if (loaded.manifest.status === "archived") {
        if (!state.exists) {
          continue;
        }
        findings.push(
          makeFinding(
            loaded,
            binding,
            managedPath,
            targetPath,
            sha256(expectedOutput),
            "archived_managed_present",
            "archived_surface_target_present",
            state,
          ),
        );
        continue;
      }

      findings.push(
        managedFileMarkerMode(managedFile) === "none"
          ? classifyRawManagedTarget(loaded, binding, managedPath, targetPath, expectedOutput, state)
          : classifyActiveTarget(
              loaded,
              binding,
              managedPath,
              targetPath,
              expectedOutput,
              state,
              archivedSurfaceIds,
            ),
      );
    }
  }

  return findings;
}

async function renderManagedFileOutput(
  loaded: LoadedSurface,
  showResult: InstructionsShowResult,
  host: string,
  managedFile: InstructionManagedFile,
  contextOverrides: Record<string, string | number | boolean> | undefined = undefined,
): Promise<string> {
  const sourcePath = resolveManagedFileSourcePath(loaded, managedFile);
  if (sourcePath) {
    return fs.readFile(sourcePath, "utf8");
  }

  const rendered = await renderInstructionsFromFiles(buildRenderInputFiles(showResult), {
    host,
    ...((managedFile.context || contextOverrides) ? { contextOverrides: { ...contextOverrides, ...managedFile.context } } : {}),
  });
  const hostOutput = rendered.results.find((result) => result.host === host);
  if (!hostOutput) {
    throw new Error(`Instruction surface "${loaded.manifest.surfaceId}" did not render host "${host}".`);
  }
  return hostOutput.output;
}

function detectDuplicateMutationTargets(planned: PlannedInstructionMutation[]): void {
  const seenTargets = new Map<string, PlannedInstructionMutation>();
  for (const entry of planned) {
    const previous = seenTargets.get(entry.targetPath);
    if (previous) {
      throw new Error(
        `Instruction mutation target collision at ${entry.targetPath}: ` +
          `${previous.loaded.manifest.surfaceId}/${previous.binding.bindingId}/${previous.managedFile} and ` +
          `${entry.loaded.manifest.surfaceId}/${entry.binding.bindingId}/${entry.managedFile}.`,
      );
    }
    seenTargets.set(entry.targetPath, entry);
  }
}

function mutationActionForFinding(
  mode: InstructionMutationMode,
  finding: InstructionReconcileFinding,
  options: InstructionsSurfaceMutationOptions,
): InstructionMutationAction | undefined {
  if (mode === "apply") {
    switch (finding.status) {
      case "managed_ok":
        return "already_managed";
      case "managed_drift":
        return "update_managed";
      case "unmanaged_present":
        return options.reviewedOverwrite ? "reviewed_overwrite" : undefined;
      case "missing_expected":
        return finding.reason === "file_missing" ? "write_missing" : undefined;
      default:
        return undefined;
    }
  }

  switch (finding.status) {
    case "managed_ok":
      return "already_managed";
    case "unmanaged_match":
      return "adopt_unmanaged";
    default:
      return undefined;
  }
}

async function planInstructionMutations(
  surfacesDir: string,
  options: InstructionsSurfaceMutationOptions,
  mode: InstructionMutationMode,
): Promise<{
  planned: PlannedInstructionMutation[];
  blockedFindings: InstructionReconcileFinding[];
  resolvedSurfaces: InstructionsSurfaceSummary[];
}> {
  const allLoaded = await loadSurfaces(surfacesDir);
  const selected = selectLoadedSurfaces(surfacesDir, allLoaded, {
    ...(options.surfaceId ? { surfaceId: options.surfaceId } : {}),
    includeArchived: Boolean(options.includeArchived),
  });
  const archivedSurfaceIds = new Set(
    allLoaded.filter((entry) => entry.manifest.status === "archived").map((entry) => entry.manifest.surfaceId),
  );

  const planned: PlannedInstructionMutation[] = [];
  const blockedFindings: InstructionReconcileFinding[] = [];

  for (const loaded of selected) {
    if (loaded.manifest.status === "archived") {
      throw new Error(`Instruction surface "${loaded.manifest.surfaceId}" is archived and cannot be mutated.`);
    }

    const showResult = toShowResult(loaded, {
      ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
    });

    const applicableBindings = showResult.targetBindings.filter(
      (binding) => isLocalReconcileTarget(binding.class) && bindingAppliesToHost(binding, options.host),
    );
    for (const binding of applicableBindings) {
      if (!binding.managedFiles || binding.managedFiles.length === 0) {
        throw new Error(
          `Instruction surface "${loaded.manifest.surfaceId}" binding "${binding.bindingId}" must declare managed_files for ${mode}.`,
        );
      }

      for (const managedFile of binding.managedFiles) {
        const managedPath = managedFilePath(managedFile);
        const targetPath = path.join(binding.path, managedPath);
        const state = await readTargetState(targetPath, binding.path);
        const expectedOutput = await renderManagedFileOutput(
          loaded,
          showResult,
          options.host,
          managedFile,
          liveRenderTimeContext(state),
        );
        const markerMode = managedFileMarkerMode(managedFile);
        const finding = markerMode === "none"
          ? classifyRawManagedTarget(loaded, binding, managedPath, targetPath, expectedOutput, state)
          : classifyActiveTarget(
              loaded,
              binding,
              managedPath,
              targetPath,
              expectedOutput,
              state,
              archivedSurfaceIds,
            );
        const action = mutationActionForFinding(mode, finding, options);
        if (!action) {
          blockedFindings.push(finding);
          continue;
        }
        planned.push({
          loaded,
          binding,
          managedFile: managedPath,
          targetPath,
          expectedOutput,
          markerMode,
          finding,
          action,
        });
      }
    }
  }

  detectDuplicateMutationTargets(planned);
  return {
    planned,
    blockedFindings,
    resolvedSurfaces: selected.map((entry) => summarizeSurface(entry)),
  };
}

function toPlannedInstructionMutationChange(entry: PlannedInstructionMutation): InstructionMutationPlannedChange {
  return {
    surfaceId: entry.loaded.manifest.surfaceId,
    bindingId: entry.binding.bindingId,
    manifestPath: entry.loaded.manifestPath,
    targetClass: entry.binding.class,
    targetPath: entry.targetPath,
    managedFile: entry.managedFile,
    action: entry.action,
    expectedContentSha256: entry.finding.expectedContentSha256,
    ...(entry.finding.liveContentSha256 ? { liveContentSha256: entry.finding.liveContentSha256 } : {}),
  };
}

function sanitizeBackupPathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "target";
}

function defaultReviewedOverwriteBackupRoot(): string {
  const envRoot = process.env.CALYX_INSTRUCTION_BACKUP_DIR;
  if (envRoot && envRoot.trim().length > 0) {
    return path.resolve(envRoot.trim());
  }
  return path.join(homedir(), ".calyx", "instruction-backups");
}

function reviewedOverwriteBackupPath(
  entry: PlannedInstructionMutation,
  host: string,
  options: InstructionsSurfaceMutationOptions,
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const explicitBackupRoot = options.reviewedOverwriteBackupDir;
  if (!explicitBackupRoot && entry.binding.class !== "repo_root") {
    return `${entry.targetPath}.calyx-backup-${timestamp}`;
  }

  const backupRoot = explicitBackupRoot && explicitBackupRoot.trim().length > 0
    ? path.resolve(explicitBackupRoot.trim())
    : defaultReviewedOverwriteBackupRoot();
  const managedSegments = entry.managedFile.split(/[\\/]+/).filter(Boolean).map((segment) =>
    sanitizeBackupPathSegment(segment),
  );
  const fallbackName = sanitizeBackupPathSegment(path.basename(entry.targetPath));
  const fileName = managedSegments.pop() ?? fallbackName;
  return path.join(
    backupRoot,
    sanitizeBackupPathSegment(entry.loaded.manifest.surfaceId),
    sanitizeBackupPathSegment(host),
    sanitizeBackupPathSegment(entry.binding.bindingId),
    ...managedSegments,
    `${fileName}.calyx-backup-${timestamp}`,
  );
}

async function executeInstructionMutations(
  planned: PlannedInstructionMutation[],
  host: string,
  options: InstructionsSurfaceMutationOptions,
): Promise<InstructionMutationChange[]> {
  const changes: InstructionMutationChange[] = [];

  for (const entry of planned) {
    if (entry.action === "already_managed") {
      continue;
    }

    const marker = entry.markerMode === "frontmatter"
      ? buildInstructionManagedMarker({
          surfaceId: entry.loaded.manifest.surfaceId,
          bindingId: entry.binding.bindingId,
          host,
          expectedOutput: entry.expectedOutput,
        })
      : undefined;
    const document = marker ? wrapManagedInstructionDocument(entry.expectedOutput, marker) : entry.expectedOutput;
    let backupPath: string | undefined;
    if (entry.action === "reviewed_overwrite") {
      backupPath = reviewedOverwriteBackupPath(entry, host, options);
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.copyFile(entry.targetPath, backupPath);
    }
    await fs.writeFile(entry.targetPath, document, "utf8");
    changes.push({
      ...toPlannedInstructionMutationChange(entry),
      ...(marker ? { marker } : {}),
      ...(backupPath ? { backupPath } : {}),
    });
  }

  return changes;
}

function summarizeInstructionMutations(
  planned: PlannedInstructionMutation[],
  blockedFindings: InstructionReconcileFinding[],
  changes: InstructionMutationChange[],
): InstructionMutationSummary {
  const byAction = createEmptyMutationActionSummary();
  for (const entry of planned) {
    byAction[entry.action] += 1;
  }
  return {
    totalTargets: planned.length + blockedFindings.length,
    changedTargets: changes.length,
    unchangedTargets: byAction["already_managed"],
    blockedTargets: blockedFindings.length,
    byAction,
  };
}

export async function listInstructionSurfaces(
  surfacesDir: string,
  options: InstructionsListOptions = {},
): Promise<InstructionsListResult> {
  const surfaces = maybeFilterArchived(await loadSurfaces(surfacesDir), Boolean(options.includeArchived));
  return {
    total: surfaces.length,
    items: surfaces.map((entry) => summarizeSurface(entry)),
  };
}

export async function showInstructionSurface(
  surfacesDir: string,
  surfaceId: string,
): Promise<InstructionsShowResult> {
  return toShowResult(await requireSurface(surfacesDir, surfaceId));
}

export async function listInstructionTargets(
  surfacesDir: string,
  options: InstructionsTargetsOptions = {},
): Promise<InstructionsTargetsResult> {
  const allLoaded = await loadSurfaces(surfacesDir);
  const filtered = selectLoadedSurfaces(surfacesDir, allLoaded, {
    ...(options.surfaceId ? { surfaceId: options.surfaceId } : {}),
    ...(typeof options.includeArchived === "boolean" ? { includeArchived: options.includeArchived } : {}),
  });

  const items: InstructionTargetEntry[] = filtered.flatMap((entry) =>
    (entry.manifest.targetBindings ?? []).map((binding) => ({
      ...resolveTargetBinding(entry, binding),
      surfaceId: entry.manifest.surfaceId,
      manifestPath: entry.manifestPath,
      status: entry.manifest.status,
    })),
  );

  return {
    total: items.length,
    items,
  };
}

export async function renderInstructionSurface(
  surfacesDir: string,
  surfaceId: string,
  options: InstructionsSurfaceRenderOptions = {},
): Promise<InstructionsSurfaceRenderResult> {
  const showResult = await showInstructionSurface(surfacesDir, surfaceId);
  const rendered = await renderInstructionsFromFiles(buildRenderInputFiles(showResult), options);
  return {
    surfaceId: showResult.surfaceId,
    manifestPath: showResult.manifestPath,
    sourceRef: showResult.sourceRef,
    targetBindings: showResult.targetBindings,
    results: rendered.results,
  };
}

export async function verifyInstructionSurface(
  surfacesDir: string,
  surfaceId: string,
  options: InstructionsSurfaceVerifyOptions = {},
): Promise<InstructionsSurfaceVerifyResult> {
  const showResult = await showInstructionSurface(surfacesDir, surfaceId);
  const expectedDir = resolveExpectedDir(showResult, options.expectedDir);
  const verified = await verifyInstructionsFromFiles(buildRenderInputFiles(showResult), {
    ...options,
    expectedDir,
  });
  return {
    surfaceId: showResult.surfaceId,
    manifestPath: showResult.manifestPath,
    sourceRef: showResult.sourceRef,
    targetBindings: showResult.targetBindings,
    expectedDir,
    ok: verified.ok,
    drifts: verified.drifts,
    results: verified.results,
  };
}

export async function reconcileInstructionSurfaces(
  surfacesDir: string,
  options: InstructionsSurfaceReconcileOptions,
): Promise<InstructionsSurfaceReconcileResult> {
  const allLoaded = await loadSurfaces(surfacesDir);
  const selected = selectLoadedSurfaces(surfacesDir, allLoaded, {
    ...(options.surfaceId ? { surfaceId: options.surfaceId } : {}),
    ...(typeof options.includeArchived === "boolean" ? { includeArchived: options.includeArchived } : {}),
  });
  const archivedSurfaceIds = new Set(
    allLoaded
      .filter((entry) => entry.manifest.status === "archived")
      .map((entry) => entry.manifest.surfaceId),
  );

  const findings = (
    await Promise.all(
      selected.map((loaded) =>
        reconcileLoadedSurface(loaded, options.host, archivedSurfaceIds, {
          ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
        }),
      ),
    )
  ).flat();

  const byStatus = createEmptyStatusSummary();
  for (const finding of findings) {
    byStatus[finding.status] += 1;
  }

  return {
    host: options.host,
    findings,
    summary: {
      totalTargets: findings.length,
      okTargets: byStatus["managed_ok"],
      findings: findings.filter((finding) => finding.status !== "managed_ok").length,
      byStatus,
    },
    resolvedSurfaces: selected.map((loaded) => summarizeSurface(loaded)),
  };
}

async function mutateInstructionSurfaces(
  surfacesDir: string,
  options: InstructionsSurfaceMutationOptions,
  mode: InstructionMutationMode,
): Promise<InstructionsSurfaceMutationResult> {
  const { planned, blockedFindings, resolvedSurfaces } = await planInstructionMutations(surfacesDir, options, mode);
  const plannedChanges = planned.map((entry) => toPlannedInstructionMutationChange(entry));
  const changes = blockedFindings.length === 0 && !options.dryRun
    ? await executeInstructionMutations(planned, options.host, options)
    : [];
  return {
    host: options.host,
    mode,
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.reviewedOverwrite ? { reviewedOverwrite: true } : {}),
    plannedChanges,
    changes,
    blockedFindings,
    summary: summarizeInstructionMutations(planned, blockedFindings, changes),
    resolvedSurfaces,
  };
}

export async function applyInstructionSurfaces(
  surfacesDir: string,
  options: InstructionsSurfaceMutationOptions,
): Promise<InstructionsSurfaceMutationResult> {
  return mutateInstructionSurfaces(surfacesDir, options, "apply");
}

export async function adoptInstructionSurfaces(
  surfacesDir: string,
  options: InstructionsSurfaceMutationOptions,
): Promise<InstructionsSurfaceMutationResult> {
  return mutateInstructionSurfaces(surfacesDir, options, "adopt");
}
