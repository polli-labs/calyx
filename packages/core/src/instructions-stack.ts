import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "@iarna/toml";
import YAML from "yaml";
import { resolveInstructionTargetMatches } from "./instructions-trace";
import type {
  InstructionStackAdvisory,
  InstructionStackLoadReason,
  InstructionStackMetadataValue,
  InstructionStackOptions,
  InstructionStackPartialProvenance,
  InstructionStackProvenanceCandidate,
  InstructionStackResult,
  InstructionStackSource,
  InstructionStackSourceKind,
  InstructionStackStructuralFinding,
  InstructionTraceMatch,
} from "./types";

const execFileAsync = promisify(execFile);
const CODEX_DEFAULT_MAX_BYTES = 32 * 1024;
const CLAUDE_IMPORT_MAX_DEPTH = 5;
const OBSERVED_RULES_VERSION = "calyx.instructions-resolution/observed-2026-07-21" as const;
const CODEX_EVIDENCE = [
  "OpenAI Codex 0.144.6 controlled sentinel probe on 2026-07-21",
  "OpenAI Codex agents_md.rs discovery contract observed on 2026-07-21",
];
const CLAUDE_EVIDENCE = [
  "Claude Code 2.1.216 InstructionsLoaded controlled probe on 2026-07-21",
  "Claude Code memory and hooks reference observed on 2026-07-21",
];

interface SourceCandidate {
  kind: InstructionStackSourceKind;
  loadReason: InstructionStackLoadReason;
  selectedAs: string;
  targetPath: string;
  parentSourcePath?: string;
  metadataScope?: string;
  metadataOwner?: string;
  metadataLifecycle?: string;
  provenanceRequired: boolean;
  includedBytes?: number;
}

interface SourceText {
  text: string;
  bytes: Buffer;
  canonicalPath: string;
  frontmatter: Record<string, unknown>;
}

interface CodexResolutionConfig {
  fallbackFilenames: string[];
  maxBytes: number;
  projectRootMarkers: string[];
  configPath?: string;
}

interface AnalyzableLine {
  source: InstructionStackSource;
  line: number;
  normalized: string;
  raw: string;
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function wcLineCount(bytes: Buffer): number {
  let count = 0;
  for (const byte of bytes) if (byte === 10) count += 1;
  return count;
}

function tokenEstimate(bytes: number): number {
  return Math.ceil(bytes / 4);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isNonEmptyFile(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const values = value.map(scalar).filter((entry): entry is string => Boolean(entry));
    return values.length > 0 ? values.join(", ") : undefined;
  }
  return undefined;
}

function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return {};
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) return {};
  try {
    const parsed = YAML.parse(match[1]) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function readSourceText(filePath: string): Promise<SourceText> {
  const [bytes, canonicalPath] = await Promise.all([
    readFile(filePath),
    realpath(filePath).catch(() => path.resolve(filePath)),
  ]);
  const text = bytes.toString("utf8");
  return { text, bytes, canonicalPath, frontmatter: parseFrontmatter(text) };
}

function orderedDirectories(root: string, cwd: string): string[] {
  const directories: string[] = [];
  let current = path.resolve(cwd);
  const resolvedRoot = path.resolve(root);
  while (true) {
    directories.push(current);
    if (current === resolvedRoot) break;
    const parent = path.dirname(current);
    if (parent === current || !current.startsWith(`${resolvedRoot}${path.sep}`)) break;
    current = parent;
  }
  return directories.reverse();
}

function filesystemAncestors(cwd: string): string[] {
  const directories: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) break;
    directories.push(current);
    current = parent;
  }
  return directories.reverse();
}

async function findCodexProjectRoot(cwd: string, markers: string[]): Promise<string | undefined> {
  if (markers.length === 0) return undefined;
  let current = path.resolve(cwd);
  while (true) {
    for (const marker of markers) {
      if (await exists(path.join(current, marker))) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function loadCodexConfig(codexHome: string, options: InstructionStackOptions): Promise<CodexResolutionConfig> {
  const configPath = path.join(codexHome, "config.toml");
  let parsed: Record<string, unknown> = {};
  try {
    parsed = parseToml(await readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    // Missing or invalid config does not change the documented defaults.
  }
  const fallback = options.codexProjectDocFallbackFilenames
    ?? (Array.isArray(parsed["project_doc_fallback_filenames"])
      ? parsed["project_doc_fallback_filenames"].filter((entry): entry is string => typeof entry === "string")
      : []);
  const configuredMax = options.codexProjectDocMaxBytes ?? parsed["project_doc_max_bytes"];
  const configuredMarkers = options.codexProjectRootMarkers ?? parsed["project_root_markers"];
  return {
    fallbackFilenames: [...new Set(fallback.filter(Boolean))],
    maxBytes: typeof configuredMax === "number" && Number.isFinite(configuredMax) && configuredMax >= 0
      ? Math.floor(configuredMax)
      : CODEX_DEFAULT_MAX_BYTES,
    projectRootMarkers: Array.isArray(configuredMarkers)
      ? configuredMarkers.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [".git"],
    ...(await exists(configPath) ? { configPath } : {}),
  };
}

async function discoverCodexSources(
  options: InstructionStackOptions,
  codexHome: string,
): Promise<{
  candidates: SourceCandidate[];
  config: CodexResolutionConfig;
  projectRoot?: string;
  globalCandidates: string[];
  perDirectoryCandidates: string[];
}> {
  const config = await loadCodexConfig(codexHome, options);
  const globalCandidates = [
    path.join(codexHome, "AGENTS.override.md"),
    path.join(codexHome, "AGENTS.md"),
  ];
  const perDirectoryCandidates = [
    "AGENTS.override.md",
    "AGENTS.md",
    ...config.fallbackFilenames.filter((name) => !["AGENTS.override.md", "AGENTS.md"].includes(name)),
  ];
  const candidates: SourceCandidate[] = [];
  const globalTarget = (await Promise.all(globalCandidates.map(async (candidate) => (
    await isNonEmptyFile(candidate) ? candidate : undefined
  )))).find(Boolean);
  if (globalTarget) {
    candidates.push({
      kind: "user",
      loadReason: "session_start",
      selectedAs: path.basename(globalTarget),
      targetPath: globalTarget,
      provenanceRequired: true,
      metadataScope: "global",
    });
  }

  const projectRoot = options.codexProjectRoot
    ? path.resolve(options.codexProjectRoot)
    : await findCodexProjectRoot(options.cwd, config.projectRootMarkers);
  const directories = projectRoot ? orderedDirectories(projectRoot, options.cwd) : [path.resolve(options.cwd)];
  const selected: string[] = [];
  for (const directory of directories) {
    for (const name of perDirectoryCandidates) {
      const candidate = path.join(directory, name);
      if (await isNonEmptyFile(candidate)) {
        selected.push(candidate);
        break;
      }
    }
  }
  let remaining = config.maxBytes;
  for (const targetPath of selected) {
    const rawBytes = (await stat(targetPath)).size;
    const includedBytes = Math.max(0, Math.min(rawBytes, remaining));
    remaining -= includedBytes;
    candidates.push({
      kind: "project",
      loadReason: "cwd_inheritance",
      selectedAs: path.basename(targetPath),
      targetPath,
      provenanceRequired: false,
      metadataScope: projectRoot
        ? path.relative(projectRoot, path.dirname(targetPath)) || "."
        : ".",
      includedBytes,
    });
  }
  return {
    candidates,
    config,
    ...(projectRoot ? { projectRoot } : {}),
    globalCandidates,
    perDirectoryCandidates,
  };
}

async function recursiveMarkdownFiles(directory: string): Promise<string[]> {
  if (!await exists(directory)) return [];
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

function pathScopedRule(frontmatter: Record<string, unknown>): boolean {
  return scalar(frontmatter["paths"]) !== undefined;
}

async function discoverClaudeSources(
  options: InstructionStackOptions,
  homeDir: string,
  claudeConfigDir: string,
): Promise<{
  candidates: SourceCandidate[];
  globalCandidates: string[];
  perDirectoryCandidates: string[];
}> {
  const candidates: SourceCandidate[] = [];
  const managedPaths = options.claudeManagedInstructionPaths ?? (
    process.platform === "darwin"
      ? ["/Library/Application Support/ClaudeCode/CLAUDE.md"]
      : process.platform === "win32"
        ? ["C:\\Program Files\\ClaudeCode\\CLAUDE.md"]
        : ["/etc/claude-code/CLAUDE.md"]
  );
  for (const managedPath of managedPaths) {
    if (await isNonEmptyFile(managedPath)) {
      candidates.push({
        kind: "managed",
        loadReason: "session_start",
        selectedAs: "CLAUDE.md",
        targetPath: managedPath,
        provenanceRequired: false,
        metadataScope: "managed",
      });
    }
  }

  const userPath = path.join(claudeConfigDir, "CLAUDE.md");
  if (await isNonEmptyFile(userPath)) {
    candidates.push({
      kind: "user",
      loadReason: "session_start",
      selectedAs: "CLAUDE.md",
      targetPath: userPath,
      provenanceRequired: true,
      metadataScope: "global",
    });
  }
  for (const rulePath of await recursiveMarkdownFiles(path.join(claudeConfigDir, "rules"))) {
    const rule = await readSourceText(rulePath);
    if (!pathScopedRule(rule.frontmatter)) {
      candidates.push({
        kind: "rule",
        loadReason: "session_start",
        selectedAs: path.relative(claudeConfigDir, rulePath),
        targetPath: rulePath,
        provenanceRequired: false,
        metadataScope: "global",
      });
    }
  }

  const perDirectoryCandidates = ["CLAUDE.md", ".claude/CLAUDE.md", ".claude/rules/**/*.md", "CLAUDE.local.md"];
  for (const directory of filesystemAncestors(options.cwd)) {
    const directSources = [
      { path: path.join(directory, "CLAUDE.md"), kind: "project" as const, selectedAs: "CLAUDE.md" },
      { path: path.join(directory, ".claude", "CLAUDE.md"), kind: "project" as const, selectedAs: ".claude/CLAUDE.md" },
    ];
    for (const source of directSources) {
      if (path.resolve(source.path) === path.resolve(userPath)) continue;
      if (await isNonEmptyFile(source.path)) {
        candidates.push({
          kind: source.kind,
          loadReason: "cwd_inheritance",
          selectedAs: source.selectedAs,
          targetPath: source.path,
          provenanceRequired: false,
          metadataScope: directory,
        });
      }
    }
    if (path.resolve(path.join(directory, ".claude")) === path.resolve(claudeConfigDir)) continue;
    for (const rulePath of await recursiveMarkdownFiles(path.join(directory, ".claude", "rules"))) {
      const rule = await readSourceText(rulePath);
      if (!pathScopedRule(rule.frontmatter)) {
        candidates.push({
          kind: "rule",
          loadReason: "cwd_inheritance",
          selectedAs: path.relative(directory, rulePath),
          targetPath: rulePath,
          provenanceRequired: false,
          metadataScope: directory,
        });
      }
    }
    const localPath = path.join(directory, "CLAUDE.local.md");
    if (await isNonEmptyFile(localPath)) {
      candidates.push({
        kind: "local",
        loadReason: "cwd_inheritance",
        selectedAs: "CLAUDE.local.md",
        targetPath: localPath,
        provenanceRequired: false,
        metadataScope: directory,
      });
    }
  }

  return {
    candidates,
    globalCandidates: [...managedPaths, userPath],
    perDirectoryCandidates,
  };
}

function importedPaths(text: string, sourcePath: string, homeDir: string): Array<{ path: string; line: number }> {
  const imports: Array<{ path: string; line: number }> = [];
  let fenced = false;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.trimStart().startsWith("<!--")) continue;
    const matches = line.matchAll(/(?:^|[\s(])@((?:~\/|\.\.?\/|\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*(?:\.[A-Za-z0-9_-]+)?)/g);
    for (const match of matches) {
      const rawPath = match[1];
      const explicitPathPrefix = Boolean(rawPath && /^(?:~\/|\.\.?\/|\/)/.test(rawPath));
      const finalSegment = rawPath?.split("/").pop() ?? "";
      const pathShaped = Boolean(rawPath && (
        explicitPathPrefix
        || finalSegment.includes(".")
        || /^(README|AGENTS|CLAUDE)$/i.test(rawPath)
      ));
      if (!rawPath || !pathShaped || rawPath.startsWith("anthropic-") || rawPath.includes("@")) continue;
      const resolved = rawPath.startsWith("~/")
        ? path.join(homeDir, rawPath.slice(2))
        : path.isAbsolute(rawPath)
          ? rawPath
          : path.resolve(path.dirname(sourcePath), rawPath);
      imports.push({ path: resolved, line: index + 1 });
    }
  }
  return imports;
}

function sensitiveImportPath(importPath: string): boolean {
  const normalized = importPath.toLowerCase();
  return normalized.split(path.sep).some((segment) => (
    segment === ".ssh"
    || segment === ".aws"
    || segment === ".gnupg"
    || /^\.env(?:\.|$)/.test(segment)
    || /(?:^|[._-])(secret|secrets|credential|credentials|password|private[-_]?key|token)(?:[._-]|$)/.test(segment)
    || /^(id_rsa|id_ed25519|credentials\.json)$/.test(segment)
  ));
}

async function expandClaudeImports(
  candidates: SourceCandidate[],
  homeDir: string,
  findings: InstructionStackStructuralFinding[],
): Promise<SourceCandidate[]> {
  const expanded: SourceCandidate[] = [];
  async function append(candidate: SourceCandidate, depth: number, chain: string[]): Promise<void> {
    expanded.push(candidate);
    let text: string;
    try {
      text = await readFile(candidate.targetPath, "utf8");
    } catch {
      return;
    }
    for (const imported of importedPaths(text, candidate.targetPath, homeDir)) {
      if (sensitiveImportPath(imported.path)) {
        findings.push({
          code: "sensitive_import_refused",
          message: "A Claude import matched a sensitive-path guard and was not read.",
          locators: [{ path: candidate.targetPath, line: imported.line }, { path: imported.path }],
          candidateOwners: [],
          candidateSources: [imported.path],
        });
        expanded.push({
          kind: "import",
          loadReason: "include",
          selectedAs: path.basename(imported.path),
          targetPath: imported.path,
          parentSourcePath: candidate.targetPath,
          provenanceRequired: false,
        });
        continue;
      }
      if (chain.includes(imported.path)) {
        findings.push({
          code: "import_cycle",
          message: "A Claude instruction import cycle was detected.",
          locators: [{ path: candidate.targetPath, line: imported.line }, { path: imported.path }],
          candidateOwners: [],
          candidateSources: [...chain, imported.path],
        });
        continue;
      }
      if (depth >= CLAUDE_IMPORT_MAX_DEPTH) {
        findings.push({
          code: "import_depth_exceeded",
          message: `A Claude instruction import exceeded the ${CLAUDE_IMPORT_MAX_DEPTH}-hop limit.`,
          locators: [{ path: candidate.targetPath, line: imported.line }, { path: imported.path }],
          candidateOwners: [],
          candidateSources: [imported.path],
        });
        continue;
      }
      if (await isNonEmptyFile(imported.path)) {
        await append({
          kind: "import",
          loadReason: "include",
          selectedAs: path.basename(imported.path),
          targetPath: imported.path,
          parentSourcePath: candidate.targetPath,
          provenanceRequired: false,
        }, depth + 1, [...chain, imported.path]);
      } else {
        findings.push({
          code: "unresolved_source",
          message: "A Claude instruction import target could not be resolved.",
          locators: [{ path: candidate.targetPath, line: imported.line }, { path: imported.path }],
          candidateOwners: [],
          candidateSources: [imported.path],
        });
      }
    }
  }
  for (const candidate of candidates) await append(candidate, 0, [candidate.targetPath]);
  return expanded;
}

async function partialProvenance(match: InstructionTraceMatch): Promise<InstructionStackPartialProvenance[]> {
  return Promise.all(match.partials.map(async (partial) => {
    if (!partial.path || partial.missing) {
      return { order: partial.order, name: partial.name, missing: Boolean(partial.missing) };
    }
    try {
      const bytes = await readFile(partial.path);
      return {
        order: partial.order,
        name: partial.name,
        path: partial.path,
        missing: false,
        sha256: sha256Bytes(bytes),
        rawLines: wcLineCount(bytes),
        rawBytes: bytes.length,
      };
    } catch {
      return { order: partial.order, name: partial.name, path: partial.path, missing: true };
    }
  }));
}

async function provenanceCandidate(match: InstructionTraceMatch): Promise<InstructionStackProvenanceCandidate> {
  if (match.kind === "template_fanout") {
    const source = match.source as Extract<InstructionTraceMatch["source"], { templateId: string }>;
    let owner: string | undefined;
    let lifecycle: string | undefined;
    try {
      const frontmatter = parseFrontmatter(await readFile(source.templatePath, "utf8"));
      owner = scalar(frontmatter["owner"]);
      lifecycle = scalar(frontmatter["lifecycle"] ?? frontmatter["status"]);
    } catch {
      // Candidate remains useful without optional metadata.
    }
    return {
      id: match.matchId,
      kind: "template_fanout",
      ...(owner ? { owner } : {}),
      ...(lifecycle ? { lifecycle } : {}),
      sourcePath: source.templatePath,
      templatePath: source.templatePath,
      installedTargetPath: match.targetPath,
      partials: await partialProvenance(match),
    };
  }
  const source = match.source as Extract<InstructionTraceMatch["source"], { surfaceId: string }>;
  let owner: string | undefined;
  let lifecycle: string | undefined;
  try {
    const parsed = YAML.parse(await readFile(source.manifestPath, "utf8")) as Record<string, unknown>;
    owner = scalar(parsed["owner"]);
    lifecycle = scalar(parsed["lifecycle"] ?? parsed["status"]);
  } catch {
    // Candidate remains useful without optional metadata.
  }
  return {
    id: match.matchId,
    kind: "surface_binding",
    ...(owner ? { owner } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    sourcePath: source.sourceRef.templatePath,
    manifestPath: source.manifestPath,
    templatePath: source.sourceRef.templatePath,
    installedTargetPath: match.targetPath,
    partials: await partialProvenance(match),
  };
}

async function resolveProvenance(
  candidate: SourceCandidate,
  options: InstructionStackOptions,
): Promise<InstructionStackProvenanceCandidate[]> {
  if (!candidate.provenanceRequired) {
    return [{
      id: `direct:${candidate.targetPath}`,
      kind: "direct_file",
      sourcePath: candidate.targetPath,
      installedTargetPath: candidate.targetPath,
      partials: [],
    }];
  }
  try {
    const result = await resolveInstructionTargetMatches(candidate.targetPath, {
      ...(options.agentsInfraRoot ? { agentsInfraRoot: options.agentsInfraRoot } : {}),
      host: options.host,
      includeArchived: true,
    });
    return Promise.all(result.matches.map(provenanceCandidate));
  } catch {
    return [];
  }
}

async function gitRevision(filePath: string): Promise<InstructionStackSource["sourceRevision"] | undefined> {
  try {
    const directory = path.dirname(filePath);
    const [{ stdout: rootOut }, { stdout: commitOut }] = await Promise.all([
      execFileAsync("git", ["-C", directory, "rev-parse", "--show-toplevel"]),
      execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"]),
    ]);
    const repoRoot = rootOut.trim();
    const commitSha = commitOut.trim();
    const relative = path.relative(repoRoot, filePath);
    let tracked = false;
    let headBlobSha: string | undefined;
    try {
      const { stdout } = await execFileAsync("git", ["-C", repoRoot, "rev-parse", `HEAD:${relative}`]);
      headBlobSha = stdout.trim();
      tracked = true;
    } catch {
      // Untracked instruction files still receive a working content hash.
    }
    const { stdout: workingOut } = await execFileAsync("git", ["hash-object", filePath]);
    return {
      repoRoot,
      commitSha,
      ...(headBlobSha ? { headBlobSha } : {}),
      workingBlobSha: workingOut.trim(),
      tracked,
    };
  } catch {
    return undefined;
  }
}

async function mirrorTargets(
  targetPath: string,
  bytes: Buffer,
  codexHome: string,
  claudeConfigDir: string,
): Promise<string[]> {
  const candidates = new Set<string>();
  const basename = path.basename(targetPath);
  if (basename.startsWith("CLAUDE")) {
    candidates.add(path.join(path.dirname(targetPath), "AGENTS.md"));
    if (path.basename(path.dirname(targetPath)) === ".claude") {
      candidates.add(path.join(path.dirname(path.dirname(targetPath)), "AGENTS.md"));
    }
  }
  if (basename.startsWith("AGENTS")) {
    candidates.add(path.join(path.dirname(targetPath), "CLAUDE.md"));
  }
  if (path.resolve(targetPath).startsWith(path.resolve(codexHome))) {
    candidates.add(path.join(claudeConfigDir, "CLAUDE.md"));
  }
  if (path.resolve(targetPath).startsWith(path.resolve(claudeConfigDir))) {
    candidates.add(path.join(codexHome, "AGENTS.md"));
  }
  const hash = sha256Bytes(bytes);
  const mirrors: string[] = [];
  for (const candidate of candidates) {
    if (path.resolve(candidate) === path.resolve(targetPath)) continue;
    try {
      const mirrorBytes = await readFile(candidate);
      if (sha256Bytes(mirrorBytes) === hash) mirrors.push(candidate);
    } catch {
      // Missing counterpart is not a structural failure.
    }
  }
  return mirrors.sort();
}

function metadataValue(
  explicit: string | undefined,
  provenanceValues: string[],
  inherited: InstructionStackMetadataValue | undefined,
  sourcePath: string,
): InstructionStackMetadataValue {
  if (explicit) return { value: explicit, source: "frontmatter", sourcePath };
  const uniqueProvenance = [...new Set(provenanceValues.filter(Boolean))];
  if (uniqueProvenance.length === 1) {
    return { value: uniqueProvenance[0]!, source: "provenance", sourcePath };
  }
  if (uniqueProvenance.length > 1) {
    return { source: "unknown", sourcePath, candidates: uniqueProvenance };
  }
  if (inherited?.value) {
    return {
      value: inherited.value,
      source: "inherited",
      ...(inherited.sourcePath ? { sourcePath: inherited.sourcePath } : {}),
    };
  }
  return { source: "unknown", sourcePath };
}

function structuralFinding(
  code: InstructionStackStructuralFinding["code"],
  message: string,
  source: InstructionStackSource,
  options: { owners?: string[]; sources?: string[] } = {},
): InstructionStackStructuralFinding {
  return {
    code,
    message,
    locators: [{ path: source.targetPath }],
    candidateOwners: options.owners ?? [],
    candidateSources: options.sources ?? [],
  };
}

function analyzableLines(sources: InstructionStackSource[], texts: Map<string, string>): AnalyzableLine[] {
  const lines: AnalyzableLine[] = [];
  for (const source of sources) {
    const text = texts.get(source.targetPath);
    if (!text) continue;
    let fenced = false;
    let frontmatter = false;
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      if (index === 0 && raw.trim() === "---") {
        frontmatter = true;
        continue;
      }
      if (frontmatter) {
        if (raw.trim() === "---") frontmatter = false;
        continue;
      }
      if (/^\s*(```|~~~)/.test(raw)) {
        fenced = !fenced;
        continue;
      }
      if (fenced || /^\s*(---|#|<!--|\|)/.test(raw)) continue;
      const normalized = raw
        .replace(/^\s*(?:[-*+] |\d+[.)] )/, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (normalized.length >= 12) lines.push({ source, line: index + 1, normalized, raw });
    }
  }
  return lines;
}

function advisoryId(kind: InstructionStackAdvisory["kind"], fingerprint: string): string {
  return `${kind}:${fingerprint.slice(0, 12)}`;
}

function literalClaimConflicts(
  lines: AnalyzableLine[],
): Array<{ category: "owner" | "version" | "canonical locator"; locators: InstructionStackAdvisory["locators"] }> {
  const claims = new Map<string, Array<{ value: string; line: AnalyzableLine }>>();
  const append = (category: "owner" | "version" | "canonical locator", key: string, value: string, line: AnalyzableLine) => {
    const claimKey = `${category}:${key.toLowerCase().replace(/\s+/g, " ").trim()}`;
    claims.set(claimKey, [...(claims.get(claimKey) ?? []), { value: value.toLowerCase(), line }]);
  };

  for (const line of lines) {
    const owner = line.raw.match(/\b(?:canonical\s+)?owner(?:ship)?\s*(?::|=|\bis\b|\bis owned by\b)\s*([@a-z0-9._/-]+)/i);
    if (owner?.[1]) append("owner", "owner", owner[1], line);

    const version = line.raw.match(/\b(?:canonical\s+)?version\s*(?::|=|\bis\b)\s*([a-z0-9._-]+)/i);
    if (version?.[1]) append("version", "version", version[1], line);

    const locator = line.raw.match(
      /\b([a-z][a-z0-9 _-]{2,40}?)\s+(?:canonical source|source of truth)\s*(?::|=|\bis\b)\s*(`?[^\s`,;]+`?)/i,
    );
    if (locator?.[1] && locator[2]) {
      append("canonical locator", locator[1], locator[2].replace(/^`|`$/g, ""), line);
    }
  }

  const conflicts: Array<{
    category: "owner" | "version" | "canonical locator";
    locators: InstructionStackAdvisory["locators"];
  }> = [];
  for (const [claimKey, matches] of claims) {
    if (new Set(matches.map((match) => match.value)).size < 2) continue;
    const category = claimKey.slice(0, claimKey.indexOf(":")) as "owner" | "version" | "canonical locator";
    conflicts.push({
      category,
      locators: matches.map((match) => ({ path: match.line.source.targetPath, line: match.line.line })),
    });
  }
  return conflicts;
}

function buildAdvisories(sources: InstructionStackSource[], texts: Map<string, string>): InstructionStackAdvisory[] {
  const lines = analyzableLines(sources, texts);
  const advisories: InstructionStackAdvisory[] = [];
  const imperative = /^(must|do not|don't|never|always|use|run|keep|prefer|avoid|treat|read|load|check|ensure|work|fix|update|create|write|commit|stop)\b/;
  const repeated = new Map<string, AnalyzableLine[]>();
  for (const line of lines.filter((entry) => imperative.test(entry.normalized))) {
    repeated.set(line.normalized, [...(repeated.get(line.normalized) ?? []), line]);
  }
  for (const [normalized, matches] of repeated) {
    if (new Set(matches.map((match) => match.source.targetPath)).size < 2) continue;
    const fingerprint = sha256Text(normalized);
    advisories.push({
      id: advisoryId("repeated_imperative", fingerprint),
      kind: "repeated_imperative",
      confidence: "high",
      reason: "The same normalized imperative appears in more than one loaded source.",
      locators: matches.map((match) => ({ path: match.source.targetPath, line: match.line })),
      fingerprint,
    });
  }

  const broadSources = new Set(sources
    .filter((source) => source.kind === "managed" || source.kind === "user" || source.scope.value === ".")
    .map((source) => source.targetPath));
  for (const line of lines) {
    if (!broadSources.has(line.source.targetPath)) continue;
    const signals = [
      /(?:^|\s)POL-\d+\b/i.test(line.raw),
      /(?:^|\s)\/(?:Users|home|etc|Library)\//.test(line.raw),
      /\b(?:carbon|blade|worm|mba)\b/i.test(line.raw),
    ].filter(Boolean).length;
    if (signals === 0) continue;
    const fingerprint = sha256Text(`wrong-altitude:${line.source.targetPath}:${line.line}`);
    advisories.push({
      id: advisoryId("wrong_altitude", fingerprint),
      kind: "wrong_altitude",
      confidence: signals >= 2 ? "high" : "medium",
      reason: "A broad-scope source contains a narrow issue, host, or absolute-path recipe signal.",
      locators: [{ path: line.source.targetPath, line: line.line }],
      fingerprint,
    });
  }

  const reviewLines = lines.filter((line) => /\breview\b/.test(line.normalized));
  const conditional = reviewLines.filter((line) => /\b(not required|optional|only when|risk-proportional|risk proportional)\b/.test(line.normalized));
  const conditionalKeys = new Set(conditional.map((line) => `${line.source.targetPath}:${line.line}`));
  const required = reviewLines.filter((line) => (
    !conditionalKeys.has(`${line.source.targetPath}:${line.line}`)
    && /\b(must|required|always|every|zero findings)\b/.test(line.normalized)
  ));
  if (required.length > 0 && conditional.length > 0) {
    const locators = [...required, ...conditional]
      .map((line) => ({ path: line.source.targetPath, line: line.line }));
    const fingerprint = sha256Text(JSON.stringify(locators));
    advisories.push({
      id: advisoryId("conflicting_claim", fingerprint),
      kind: "conflicting_claim",
      confidence: "high",
      reason: "Loaded sources contain literal universal-review and conditional-review policy signals.",
      locators,
      fingerprint,
    });
  }

  for (const conflict of literalClaimConflicts(lines)) {
    const fingerprint = sha256Text(JSON.stringify({ category: conflict.category, locators: conflict.locators }));
    advisories.push({
      id: advisoryId("conflicting_claim", fingerprint),
      kind: "conflicting_claim",
      confidence: "high",
      reason: `Loaded sources contain literal conflicting ${conflict.category} claims.`,
      locators: conflict.locators,
      fingerprint,
    });
  }

  const authorityMoved = lines.filter((line) => /\b(now lives in|moved to|canonical source|source of truth)\b/.test(line.normalized));
  for (const authority of authorityMoved) {
    const childReview = lines.find((line) => (
      line.source.order > authority.source.order
      && /\breview\b/.test(line.normalized)
      && /\b(must|required|always|every|procedure|round)\b/.test(line.normalized)
    ));
    if (!childReview) continue;
    const locators = [
      { path: authority.source.targetPath, line: authority.line },
      { path: childReview.source.targetPath, line: childReview.line },
    ];
    const fingerprint = sha256Text(JSON.stringify(locators));
    advisories.push({
      id: advisoryId("stale_child_after_authority_moved", fingerprint),
      kind: "stale_child_after_authority_moved",
      confidence: "medium",
      reason: "A broader source moves authority while a later child still carries procedure-shaped text for that topic.",
      locators,
      fingerprint,
    });
  }

  return [...new Map(advisories.map((advisory) => [advisory.id, advisory])).values()]
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function inspectInstructionStack(options: InstructionStackOptions): Promise<InstructionStackResult> {
  const cwd = path.resolve(options.cwd);
  const cwdInfo = await stat(cwd);
  if (!cwdInfo.isDirectory()) throw new Error(`Instruction stack cwd is not a directory: ${cwd}`);
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const codexHome = path.resolve(options.codexHome ?? process.env["CODEX_HOME"] ?? path.join(homeDir, ".codex"));
  const claudeConfigDir = path.resolve(
    options.claudeConfigDir ?? process.env["CLAUDE_CONFIG_DIR"] ?? path.join(homeDir, ".claude"),
  );
  const findings: InstructionStackStructuralFinding[] = [];
  const discovered = options.harness === "codex"
    ? await discoverCodexSources(options, codexHome)
    : await discoverClaudeSources(options, homeDir, claudeConfigDir);
  let candidates = discovered.candidates;
  if (options.harness === "claude") {
    candidates = await expandClaudeImports(candidates, homeDir, findings);
  }
  if (!candidates.some((candidate) => candidate.kind === "user" || candidate.kind === "managed")) {
    findings.push({
      code: "missing_global_source",
      message: `No non-empty ${options.harness} global instruction source was found.`,
      locators: discovered.globalCandidates.map((candidate) => ({ path: candidate })),
      candidateOwners: [],
      candidateSources: discovered.globalCandidates,
    });
  }

  const sources: InstructionStackSource[] = [];
  const texts = new Map<string, string>();
  let inheritedOwner: InstructionStackMetadataValue | undefined;
  let inheritedLifecycle: InstructionStackMetadataValue | undefined;
  for (const candidate of candidates) {
    if (candidate.kind === "import" && sensitiveImportPath(candidate.targetPath)) {
      sources.push({
        order: sources.length + 1,
        kind: candidate.kind,
        loadReason: candidate.loadReason,
        selectedAs: candidate.selectedAs,
        targetPath: candidate.targetPath,
        canonicalPath: candidate.targetPath,
        scope: { source: "unknown", sourcePath: candidate.targetPath },
        owner: { source: "unknown", sourcePath: candidate.targetPath },
        lifecycle: { source: "unknown", sourcePath: candidate.targetPath },
        status: "refused_sensitive_import",
        mirrorTargets: [],
        provenance: [],
        ...(candidate.parentSourcePath ? { parentSourcePath: candidate.parentSourcePath } : {}),
      });
      continue;
    }
    let loaded: SourceText;
    try {
      loaded = await readSourceText(candidate.targetPath);
    } catch {
      const source: InstructionStackSource = {
        order: sources.length + 1,
        kind: candidate.kind,
        loadReason: candidate.loadReason,
        selectedAs: candidate.selectedAs,
        targetPath: candidate.targetPath,
        canonicalPath: candidate.targetPath,
        scope: { source: "unknown", sourcePath: candidate.targetPath },
        owner: { source: "unknown", sourcePath: candidate.targetPath },
        lifecycle: { source: "unknown", sourcePath: candidate.targetPath },
        status: "unresolved_provenance",
        mirrorTargets: [],
        provenance: [],
      };
      sources.push(source);
      findings.push(structuralFinding("unresolved_source", "An instruction source could not be read.", source));
      continue;
    }
    const includedBytes = candidate.includedBytes ?? loaded.bytes.length;
    texts.set(candidate.targetPath, loaded.bytes.subarray(0, includedBytes).toString("utf8"));
    const provenance = await resolveProvenance(candidate, options);
    const provenanceOwners = provenance.flatMap((entry) => entry.owner ? [entry.owner] : []);
    const provenanceLifecycles = provenance.flatMap((entry) => entry.lifecycle ? [entry.lifecycle] : []);
    const explicitOwner = candidate.metadataOwner ?? scalar(loaded.frontmatter["owner"]);
    const explicitLifecycle = candidate.metadataLifecycle
      ?? scalar(loaded.frontmatter["lifecycle"] ?? loaded.frontmatter["status"]);
    const projectScoped = ["project", "local", "rule", "import"].includes(candidate.kind);
    const owner = metadataValue(
      explicitOwner,
      provenanceOwners,
      projectScoped ? inheritedOwner : undefined,
      candidate.targetPath,
    );
    const lifecycle = metadataValue(
      explicitLifecycle,
      provenanceLifecycles,
      projectScoped ? inheritedLifecycle : undefined,
      candidate.targetPath,
    );
    const explicitScope = scalar(loaded.frontmatter["scope"]);
    const scopeValue = explicitScope ?? candidate.metadataScope;
    const scope: InstructionStackMetadataValue = scopeValue
      ? { value: scopeValue, source: explicitScope ? "frontmatter" : "derived", sourcePath: candidate.targetPath }
      : { source: "unknown", sourcePath: candidate.targetPath };
    const uniqueOwners = [...new Set([...(owner.candidates ?? []), ...provenanceOwners, ...(explicitOwner ? [explicitOwner] : [])])];
    const status = candidate.provenanceRequired
      ? provenance.length === 0
        ? "unresolved_provenance"
        : provenance.length > 1
          ? "ambiguous_provenance"
          : "resolved"
      : "resolved";
    const rawBytes = loaded.bytes.length;
    const source: InstructionStackSource = {
      order: sources.length + 1,
      kind: candidate.kind,
      loadReason: candidate.loadReason,
      selectedAs: candidate.selectedAs,
      targetPath: candidate.targetPath,
      canonicalPath: loaded.canonicalPath,
      scope,
      owner,
      lifecycle,
      status,
      contentSha256: sha256Bytes(loaded.bytes),
      ...(await gitRevision(candidate.targetPath).then((revision) => revision ? { sourceRevision: revision } : {})),
      metrics: {
        rawLines: wcLineCount(loaded.bytes),
        rawBytes,
        estimatedTokens: tokenEstimate(rawBytes),
        includedBytes,
        truncated: includedBytes < rawBytes,
      },
      mirrorTargets: await mirrorTargets(candidate.targetPath, loaded.bytes, codexHome, claudeConfigDir),
      provenance,
      ...(candidate.parentSourcePath ? { parentSourcePath: candidate.parentSourcePath } : {}),
    };
    sources.push(source);
    if (projectScoped) {
      if (owner.value) inheritedOwner = owner;
      if (lifecycle.value) inheritedLifecycle = lifecycle;
    }
    const candidateSources = [...new Set(provenance.flatMap((entry) => entry.sourcePath ? [entry.sourcePath] : []))];
    if (status === "unresolved_provenance") {
      findings.push(structuralFinding(
        "unresolved_source",
        "The installed global instruction target has no explaining source provenance.",
        source,
        { owners: uniqueOwners, sources: candidateSources },
      ));
    }
    if (status === "ambiguous_provenance") {
      findings.push(structuralFinding(
        "ambiguous_source",
        "The installed global instruction target has more than one explaining source.",
        source,
        { owners: uniqueOwners, sources: candidateSources },
      ));
    }
    if (uniqueOwners.length > 1 || (owner.candidates?.length ?? 0) > 1) {
      findings.push(structuralFinding(
        "ambiguous_owner",
        "The instruction source resolves to more than one candidate owner.",
        source,
        { owners: uniqueOwners, sources: candidateSources },
      ));
    } else if (!owner.value) {
      findings.push(structuralFinding("missing_owner", "The instruction source has no explicit, inherited, or provenance owner.", source));
    }
    if (!lifecycle.value) {
      findings.push(structuralFinding(
        "missing_lifecycle",
        "The instruction source has no explicit, inherited, or provenance lifecycle.",
        source,
      ));
    }
  }

  const totals = sources.reduce((summary, source) => {
    if (!source.metrics) return summary;
    summary.sourceCount += 1;
    summary.rawLines += source.metrics.rawLines;
    summary.rawBytes += source.metrics.rawBytes;
    summary.estimatedTokens += source.metrics.estimatedTokens;
    summary.includedBytes += source.metrics.includedBytes;
    summary.mirrorTargetCount += source.mirrorTargets.length;
    return summary;
  }, { sourceCount: 0, rawLines: 0, rawBytes: 0, estimatedTokens: 0, includedBytes: 0, mirrorTargetCount: 0 });

  const codexDiscovery = options.harness === "codex"
    ? discovered as Awaited<ReturnType<typeof discoverCodexSources>>
    : undefined;
  return {
    schemaVersion: "calyx.instructions-stack/v1",
    cwd,
    harness: options.harness,
    host: options.host,
    resolution: {
      rulesVersion: OBSERVED_RULES_VERSION,
      ...(codexDiscovery?.projectRoot ? { projectRoot: codexDiscovery.projectRoot } : {}),
      globalCandidates: discovered.globalCandidates,
      perDirectoryCandidates: discovered.perDirectoryCandidates,
      ...(codexDiscovery ? {
        projectDocMaxBytes: codexDiscovery.config.maxBytes,
        projectRootMarkers: codexDiscovery.config.projectRootMarkers,
      } : { importsMaxDepth: CLAUDE_IMPORT_MAX_DEPTH }),
      lazyNestedGuides: true,
      evidence: options.harness === "codex" ? CODEX_EVIDENCE : CLAUDE_EVIDENCE,
    },
    sources,
    totals,
    structural: { ok: findings.length === 0, findings },
    advisories: buildAdvisories(sources, texts),
    limitations: options.harness === "claude"
      ? [
        "The harness-resolution model is a dated observation of the named 2026-07-21 probes and versions; re-probe after harness changes.",
        "The host alias selects local provenance manifests and target bindings; it does not inspect a remote host filesystem.",
        "Path-scoped .claude/rules files are lazy and excluded until a matching file is touched.",
        "claudeMdExcludes and additional --add-dir instruction loading are outside this cwd-only receipt.",
        "Advisories are deterministic candidates, not semantic correctness claims or merge gates.",
      ]
      : [
        "The harness-resolution model is a dated observation of the named 2026-07-21 probes and versions; re-probe after harness changes.",
        "The host alias selects local provenance manifests and target bindings; it does not inspect a remote host filesystem.",
        "The projectDocMaxBytes budget applies to the concatenated project documents; global user guidance is reported separately.",
        "Child AGENTS files below cwd are lazy and excluded until work enters that subtree.",
        "Advisories are deterministic candidates, not semantic correctness claims or merge gates.",
      ],
  };
}
