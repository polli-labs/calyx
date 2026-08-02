import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { deriveProvenanceClass, loadSkillsRegistryLoose, resolveSkillRegime, validateSkillsRegistry } from "./skills";
import type {
  SkillFleetInstallationInfo,
  SkillInstallationInfo,
  SkillInstallationState,
  SkillLifecycleStatus,
  SkillRegistryEntry,
  SkillResolvedSource,
  SkillValidationCheck,
  SkillsShowResult,
} from "./types";
import { resolveSourcePath } from "./resolve";
import {
  expandHomePath,
  pathExists,
  readHostsTruth,
  resolveAgentsInfraRoot,
  resolveRepoClone,
} from "./agents-infra";
import {
  type ParsedSkillDocument,
  type SkillBackend,
  bufferMapTreeSha,
  collectSkillExtraFiles,
  compareFileMaps,
  normalizeName,
  parseSkillDocument,
  renderClaudeSkill,
  renderCodexSkill,
  resolveSkillInstallDir,
} from "./skills-install";

interface ResolvedSkillSource {
  source: SkillResolvedSource;
  skillPath?: string;
  skillDir?: string;
}

interface ExpectedInstallationTree {
  files: Map<string, Buffer>;
  skillSha256: string;
  treeSha256: string;
}

interface LiveInstallationTree {
  present: boolean;
  liveSkillPath?: string;
  files?: Map<string, Buffer>;
  skillSha256?: string;
  treeSha256?: string;
}

export class SkillShowLookupError extends Error {
  readonly code: string;
  readonly suggestions: string[];

  constructor(message: string, suggestions: string[] = []) {
    super(message);
    this.name = "SkillShowLookupError";
    this.code = "skill_not_found";
    this.suggestions = suggestions;
  }
}

function sha256Bytes(parts: Array<Buffer | string>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest("hex");
}

async function readLiveInstallationTree(expectedPath: string): Promise<LiveInstallationTree> {
  if (!(await pathExists(expectedPath))) {
    return { present: false };
  }

  const files = new Map<string, Buffer>();
  let liveSkillPath: string | undefined;

  async function walk(currentDir: string, relativePrefix = ""): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(currentDir, entry.name);
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        continue;
      }
      const relativePath = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (relativePath === "SKILL.md") {
        liveSkillPath = absolutePath;
      }
      files.set(relativePath, await readFile(absolutePath));
    }
  }

  await walk(expectedPath);
  return {
    present: true,
    ...(liveSkillPath ? { liveSkillPath } : {}),
    files,
    ...(files.has("SKILL.md") ? { skillSha256: sha256Bytes([files.get("SKILL.md")!]) } : {}),
    treeSha256: bufferMapTreeSha(files),
  };
}

function buildExpectedSkillInstallTree(
  backend: SkillBackend,
  skillId: string,
  parsed: ParsedSkillDocument,
  extraFiles: Map<string, Buffer>,
): ExpectedInstallationTree {
  const files = new Map<string, Buffer>();
  let renderedSkill = parsed.rawText.replace(/\s+$/, "") + "\n";
  if (backend === "claude") {
    renderedSkill = renderClaudeSkill(normalizeName(skillId), parsed.description, parsed.body);
  } else if (backend === "codex") {
    renderedSkill = renderCodexSkill(skillId, parsed.title, parsed.description, parsed.body);
  }
  const skillBuffer = Buffer.from(renderedSkill, "utf8");
  files.set("SKILL.md", skillBuffer);
  for (const [relativePath, contents] of extraFiles.entries()) {
    files.set(relativePath, contents);
  }

  return {
    files,
    skillSha256: sha256Bytes([skillBuffer]),
    treeSha256: bufferMapTreeSha(files),
  };
}

function computeSkillSuggestions(query: string, candidates: string[]): string[] {
  const loweredQuery = query.trim().toLowerCase();
  if (loweredQuery.length === 0) {
    return [];
  }

  function levenshtein(left: string, right: string): number {
    const rows = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
    for (let index = 0; index <= left.length; index += 1) rows[index]![0] = index;
    for (let index = 0; index <= right.length; index += 1) rows[0]![index] = index;
    for (let row = 1; row <= left.length; row += 1) {
      for (let column = 1; column <= right.length; column += 1) {
        const cost = left[row - 1] === right[column - 1] ? 0 : 1;
        rows[row]![column] = Math.min(
          rows[row - 1]![column]! + 1,
          rows[row]![column - 1]! + 1,
          rows[row - 1]![column - 1]! + cost,
        );
      }
    }
    return rows[left.length]![right.length]!;
  }

  return [...candidates]
    .map((candidate) => {
      const loweredCandidate = candidate.toLowerCase();
      let score = levenshtein(loweredQuery, loweredCandidate);
      if (loweredCandidate.startsWith(loweredQuery)) {
        score -= 4;
      } else if (loweredCandidate.includes(loweredQuery)) {
        score -= 2;
      }
      return { candidate, score };
    })
    .sort((left, right) => left.score - right.score || left.candidate.localeCompare(right.candidate))
    .slice(0, 3)
    .map((entry) => entry.candidate);
}

async function resolveSkillSource(
  entry: SkillRegistryEntry,
  agentsInfraRoot?: string,
): Promise<ResolvedSkillSource> {
  const provenanceClass = deriveProvenanceClass(entry.source);
  const baseSource: SkillResolvedSource = {
    type: entry.source.type,
    ...(entry.source.repo ? { repo: entry.source.repo } : {}),
    path: entry.source.path,
    ref: typeof entry.source.ref === "string" ? entry.source.ref : null,
    license: typeof entry.source.license === "string" ? entry.source.license : null,
    available: false,
    ...(provenanceClass ? { provenance_class: provenanceClass } : {}),
    regime: resolveSkillRegime(entry.source),
  };

  const sourceType = entry.source.type.trim().toLowerCase();
  if (sourceType === "internal") {
    if (!agentsInfraRoot) {
      return { source: baseSource };
    }
    const resolvedSkillPath = path.resolve(agentsInfraRoot, entry.source.path);
    const skillPath = resolvedSkillPath.endsWith(".md")
      ? resolvedSkillPath
      : path.join(resolvedSkillPath, "SKILL.md");
    const skillDir = path.dirname(skillPath);
    return {
      source: {
        ...baseSource,
        resolvedSkillPath: skillPath,
        resolvedSkillDir: skillDir,
        available: await pathExists(skillPath),
      },
      skillPath,
      skillDir,
    };
  }

  if (sourceType === "repo-maintained" && entry.source.repo) {
    const cloneRoot = await resolveRepoClone(entry.source.repo);
    if (!cloneRoot) {
      return { source: baseSource };
    }
    const resolvedSkillPath = path.resolve(cloneRoot, entry.source.path);
    const skillPath = resolvedSkillPath.endsWith(".md")
      ? resolvedSkillPath
      : path.join(resolvedSkillPath, "SKILL.md");
    const skillDir = path.dirname(skillPath);
    return {
      source: {
        ...baseSource,
        resolvedSkillPath: skillPath,
        resolvedSkillDir: skillDir,
        available: await pathExists(skillPath),
      },
      skillPath,
      skillDir,
    };
  }

  if (sourceType === "external" && entry.source.repo) {
    const repoId = entry.source.repo
      .replace(/^https?:\/\/github\.com\//, "")
      .replace(/\.git$/, "")
      .replace(/\/$/, "");
    const cloneRoot = repoId.includes("/") ? await resolveRepoClone(repoId) : undefined;
    if (!cloneRoot) {
      return { source: baseSource };
    }
    const resolvedSkillPath = path.resolve(cloneRoot, entry.source.path);
    const skillPath = resolvedSkillPath.endsWith(".md")
      ? resolvedSkillPath
      : path.join(resolvedSkillPath, "SKILL.md");
    const skillDir = path.dirname(skillPath);
    return {
      source: {
        ...baseSource,
        resolvedSkillPath: skillPath,
        resolvedSkillDir: skillDir,
        available: await pathExists(skillPath),
      },
      skillPath,
      skillDir,
    };
  }

  return { source: baseSource };
}

function localInstallPathForBackend(backend: SkillBackend, skillId: string): { entryName: string; expectedPath: string } {
  const entryName = backend === "claude" ? normalizeName(skillId) : skillId;
  return {
    entryName,
    expectedPath: resolveSkillInstallDir(backend, skillId),
  };
}

function fleetInstallPath(homePath: string, backend: SkillBackend, skillId: string): SkillFleetInstallationInfo {
  const normalizedHome = path.resolve(expandHomePath(homePath));
  if (backend === "agents") {
    return {
      host: "",
      backend,
      entryName: skillId,
      expectedPath: path.join(normalizedHome, ".agents", "skills", skillId),
    };
  }
  if (backend === "claude") {
    const entryName = normalizeName(skillId);
    return {
      host: "",
      backend,
      entryName,
      expectedPath: path.join(normalizedHome, ".claude", "skills", entryName),
    };
  }
  return {
    host: "",
    backend,
    entryName: skillId,
    expectedPath: path.join(normalizedHome, ".codex", "skills", "polli", skillId),
  };
}

function stripHashes(
  installation: SkillInstallationInfo,
  includeHashes: boolean,
): SkillInstallationInfo {
  if (includeHashes) {
    return installation;
  }

  const redacted = { ...installation };
  delete redacted.expectedSkillSha256;
  delete redacted.liveSkillSha256;
  delete redacted.expectedTreeSha256;
  delete redacted.liveTreeSha256;
  return redacted;
}

function validationOk(checks: SkillValidationCheck[]): boolean {
  return !checks.some((check) => check.status === "error");
}

export async function showSkill(
  skillId: string,
  options: {
    registryPath?: string;
    agentsInfraRoot?: string;
    showInstallHashes?: boolean;
  } = {},
): Promise<SkillsShowResult> {
  const agentsInfraRoot = await resolveAgentsInfraRoot({
    ...(options.agentsInfraRoot ? { explicitRoot: options.agentsInfraRoot } : {}),
    ...(options.registryPath ? { registryPath: options.registryPath } : {}),
  });

  const resolvedRegistry = await resolveSourcePath("skills", {
    ...(options.registryPath ? { cliValue: options.registryPath } : {}),
  });
  const fallbackRegistryPath = agentsInfraRoot
    ? path.join(agentsInfraRoot, "instructions", "skills", "SOURCES.json")
    : undefined;
  const registryPath =
    resolvedRegistry.path && (await pathExists(resolvedRegistry.path))
      ? resolvedRegistry.path
      : fallbackRegistryPath;

  if (!registryPath) {
    throw new Error(
      "Unable to resolve a skills registry. Pass --registry <path> or --agents-infra-root <path>.",
    );
  }

  const registry = await loadSkillsRegistryLoose(registryPath);
  const entry =
    registry.skills.find((item) => item.id === skillId) ??
    registry.skills.find((item) => item.id.toLowerCase() === skillId.trim().toLowerCase());
  if (!entry) {
    throw new SkillShowLookupError(
      `Skill "${skillId}" was not found in the registry.`,
      computeSkillSuggestions(skillId, registry.skills.map((item) => item.id)),
    );
  }

  const notes: string[] = [];
  if (agentsInfraRoot) {
    notes.push(`Resolved agents-infra root: ${agentsInfraRoot}`);
  }

  const resolvedSource = await resolveSkillSource(entry, agentsInfraRoot);
  const checks: SkillValidationCheck[] = [
    {
      id: "registry_entry",
      status: "ok",
      detail: `Found skill "${entry.id}" in ${registryPath}.`,
    },
  ];
  try {
    const registryValidation = await validateSkillsRegistry(registryPath, { strict: true });
    if (!registryValidation.ok) {
      const detail =
        registryValidation.errors.length === 1
          ? "Registry contains 1 validation error outside this lookup; show is running in best-effort mode."
          : `Registry contains ${registryValidation.errors.length} validation errors outside this lookup; show is running in best-effort mode.`;
      checks.push({
        id: "registry_validity",
        status: "warning",
        detail,
      });
      notes.push(detail);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({
      id: "registry_validity",
      status: "warning",
      detail: `Registry validation could not complete: ${message}`,
    });
  }
  if (resolvedSource.source.available) {
    checks.push({
      id: "source_exists",
      status: "ok",
      detail: "Resolved source SKILL.md exists.",
    });
  } else if (entry.source.type === "external") {
    checks.push({
      id: "source_exists",
      status: "warning",
      detail: "Source metadata is available, but no local external clone was resolved.",
    });
  } else {
    checks.push({
      id: "source_exists",
      status: "error",
      detail: "Resolved source SKILL.md could not be found locally.",
    });
  }

  let parsedSource: ParsedSkillDocument | undefined;
  let extraFiles = new Map<string, Buffer>();
  if (resolvedSource.skillPath && resolvedSource.source.available) {
    parsedSource = await parseSkillDocument(resolvedSource.skillPath);
    if (resolvedSource.skillDir) {
      extraFiles = await collectSkillExtraFiles(resolvedSource.skillDir);
    }
  }

  const localInstallations: SkillInstallationInfo[] = [];
  const backends: SkillBackend[] = ["agents", "claude", "codex"];
  for (const backend of backends) {
    const { entryName, expectedPath } = localInstallPathForBackend(backend, entry.id);
    const liveTree = await readLiveInstallationTree(expectedPath);

    let state: SkillInstallationState;
    let expectedTree: ExpectedInstallationTree | undefined;
    if (!parsedSource) {
      state = "expected_unavailable";
    } else {
      expectedTree = buildExpectedSkillInstallTree(backend, entry.id, parsedSource, extraFiles);
      if (!liveTree.present) {
        state = "missing";
      } else if (compareFileMaps(expectedTree.files, liveTree.files)) {
        state = "matches_expected";
      } else {
        state = "differs";
      }
    }

    if (state === "missing") {
      checks.push({
        id: `install_${backend}`,
        status: "warning",
        detail: `${backend} install surface is missing at ${expectedPath}.`,
      });
    } else if (state === "differs") {
      checks.push({
        id: `install_${backend}`,
        status: "warning",
        detail: `${backend} install surface differs from the expected rendered skill tree.`,
      });
    }

    localInstallations.push(
      stripHashes(
        {
          backend,
          entryName,
          expectedPath,
          present: liveTree.present,
          state,
          ...(liveTree.liveSkillPath ? { liveSkillPath: liveTree.liveSkillPath } : {}),
          ...(expectedTree?.skillSha256 ? { expectedSkillSha256: expectedTree.skillSha256 } : {}),
          ...(liveTree.skillSha256 ? { liveSkillSha256: liveTree.skillSha256 } : {}),
          ...(expectedTree?.treeSha256 ? { expectedTreeSha256: expectedTree.treeSha256 } : {}),
          ...(liveTree.treeSha256 ? { liveTreeSha256: liveTree.treeSha256 } : {}),
        },
        Boolean(options.showInstallHashes),
      ),
    );
  }

  const fleetInstallations: SkillFleetInstallationInfo[] = [];
  if (agentsInfraRoot) {
    const hostsTruth = await readHostsTruth(agentsInfraRoot);
    for (const [hostAlias, hostEntry] of Object.entries(hostsTruth.hosts ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!hostEntry.home) {
        continue;
      }
      for (const backend of backends) {
        const projection = fleetInstallPath(hostEntry.home, backend, entry.id);
        fleetInstallations.push({ ...projection, host: hostAlias });
      }
    }
  }

  return {
    id: entry.id,
    status: (entry.status ?? "active") as SkillLifecycleStatus,
    registry: {
      path: path.resolve(registryPath),
      version: registry.version,
    },
    source: resolvedSource.source,
    localInstallations,
    fleetInstallations,
    validation: {
      ok: validationOk(checks),
      checks,
    },
    notes,
  };
}
