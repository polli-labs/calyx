import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { SyncBackend } from "./types";
import { expandHomePath, pathExists } from "./agents-infra";

/**
 * Shared atomic skill-installation machinery.
 *
 * These helpers were originally duplicated across `skills.ts` (the sync writer)
 * and `skills-show.ts` (the read-only inspector). They are the single source of
 * truth for: normalizing skill ids, parsing SKILL.md frontmatter, rendering the
 * per-backend SKILL.md, collecting a skill's extra files, reading the live
 * install tree, comparing/hashing buffer maps, resolving install dirs, building
 * the expected install tree, and the staged rename-to-backup / rename-staged-in
 * / rollback-on-error directory swap.
 *
 * SAFETY: every reader of `process.env.HOME` / `process.env.CODEX_HOME` /
 * `homedir()` lives INSIDE a function body (see `resolveSkillInstallDir`), never
 * at module top-level. The test runner imports this module once; a cached real
 * HOME would defeat the per-test sandbox and the destructive create/delete tests
 * would wipe the real `~/.agents|.claude|.codex/skills`.
 */

export type SkillBackend = Exclude<SyncBackend, "all">;

export interface ParsedSkillDocument {
  rawText: string;
  body: string;
  title: string;
  description: string;
}

export interface PreparedInstallationMutation {
  kind: "install" | "prune";
  installDir: string;
  stagedDir?: string;
  backupDir: string;
  hadExistingInstall: boolean;
  movedExistingInstall: boolean;
  installedNewTree: boolean;
}

export function normalizeName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 64) : "skill";
}

export function parseFrontmatter(text: string): Record<string, unknown> | undefined {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/);
  if (!match) {
    return undefined;
  }

  try {
    const parsed = YAML.parse(match[1] ?? "") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function stripFrontmatterBody(rawText: string): string {
  return rawText.startsWith("---")
    ? rawText.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/, "")
    : rawText;
}

/**
 * Parse a SKILL.md document from a path. The title falls back to the skill
 * directory name when no frontmatter title is present; the description falls
 * back to the title.
 */
export async function parseSkillDocument(skillPath: string): Promise<ParsedSkillDocument> {
  const rawText = await readFile(skillPath, "utf8");
  const frontmatter = parseFrontmatter(rawText);
  const body = stripFrontmatterBody(rawText);

  const title =
    (typeof frontmatter?.title === "string" && frontmatter.title.trim().length > 0
      ? frontmatter.title.trim()
      : path.basename(path.dirname(skillPath))) || path.basename(path.dirname(skillPath));
  const description =
    (typeof frontmatter?.description === "string" && frontmatter.description.trim().length > 0
      ? frontmatter.description.trim()
      : title) || title;

  return {
    rawText,
    body,
    title,
    description
  };
}

/**
 * Parse a SKILL.md document from an in-memory string. Mirrors
 * {@link parseSkillDocument} but takes the raw text directly. The title falls
 * back to `idFallback` (the skill id) when no frontmatter title is present; the
 * description falls back to the title. Used by the re-materializer, which reads
 * the document body out of the database `payload_json` rather than a path.
 */
export function parseSkillDocumentFromString(rawText: string, idFallback: string): ParsedSkillDocument {
  const frontmatter = parseFrontmatter(rawText);
  const body = stripFrontmatterBody(rawText);

  const title =
    typeof frontmatter?.title === "string" && frontmatter.title.trim().length > 0
      ? frontmatter.title.trim()
      : idFallback;
  const description =
    typeof frontmatter?.description === "string" && frontmatter.description.trim().length > 0
      ? frontmatter.description.trim()
      : title;

  return {
    rawText,
    body,
    title,
    description
  };
}

export function renderClaudeSkill(name: string, description: string, body: string): string {
  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description.replace(/\r?\n/g, " ").trim())}`,
    "---",
    "",
    body.replace(/\s+$/, ""),
    ""
  ].join("\n");
}

export function renderCodexSkill(skillId: string, title: string, description: string, body: string): string {
  return [
    "---",
    `name: ${JSON.stringify(skillId)}`,
    `description: ${JSON.stringify(description.replace(/\r?\n/g, " ").trim().slice(0, 500))}`,
    "---",
    "",
    `# ${title}`,
    "",
    body.replace(/\s+$/, ""),
    ""
  ].join("\n");
}

/**
 * Render the SKILL.md for a backend. `agents` is verbatim (rawText, trimmed +
 * a single trailing newline); `claude`/`codex` re-render the frontmatter.
 */
function renderSkillForBackend(backend: SkillBackend, skillId: string, parsed: ParsedSkillDocument): string {
  if (backend === "claude") {
    return renderClaudeSkill(normalizeName(skillId), parsed.description, parsed.body);
  }
  if (backend === "codex") {
    return renderCodexSkill(skillId, parsed.title, parsed.description, parsed.body);
  }
  return `${parsed.rawText.replace(/\s+$/, "")}\n`;
}

export async function collectSkillExtraFiles(skillDir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();

  async function walk(currentDir: string, relativePrefix = ""): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const absolutePath = path.join(currentDir, entry.name);
      // Intentional harmonization (dedup of skills.ts + skills-show.ts): skip
      // symlinks via lstat. The prior skills-show collector did NOT skip them,
      // but the sync path did; we harmonized to skip — it is safer and keeps a
      // git-sourced collect byte-identical to the DB-rendered tree.
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        continue;
      }

      const relativePath = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name;
      if (relativePath === "SKILL.md") {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      files.set(relativePath, await readFile(absolutePath));
    }
  }

  await walk(skillDir);
  return files;
}

export async function readInstallationTree(installDir: string): Promise<Map<string, Buffer> | undefined> {
  if (!(await pathExists(installDir))) {
    return undefined;
  }

  const files = new Map<string, Buffer>();

  async function walk(currentDir: string, relativePrefix = ""): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".")) {
        continue;
      }

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

      files.set(relativePath, await readFile(absolutePath));
    }
  }

  await walk(installDir);
  return files;
}

export function compareFileMaps(left: Map<string, Buffer>, right?: Map<string, Buffer>): boolean {
  if (!right || left.size !== right.size) {
    return false;
  }

  for (const [relativePath, contents] of left.entries()) {
    const rightContents = right.get(relativePath);
    if (!rightContents || !contents.equals(rightContents)) {
      return false;
    }
  }

  return true;
}

/**
 * Deterministic sha256 over a buffer-map tree: each relpath + content is hashed
 * in sorted order with NUL separators so the digest is stable regardless of
 * insertion order. Used for hash-verified post-commit assertions.
 */
export function bufferMapTreeSha(files: Map<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const relativePath of [...files.keys()].sort((left, right) => left.localeCompare(right))) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(files.get(relativePath)!);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function resolveSkillInstallDir(backend: SkillBackend, skillId: string): string {
  if (backend === "agents") {
    return path.join(path.resolve(expandHomePath("~/.agents/skills")), skillId);
  }

  if (backend === "claude") {
    return path.join(path.resolve(expandHomePath("~/.claude/skills")), normalizeName(skillId));
  }

  const codexHome = process.env.CODEX_HOME?.trim().length
    ? expandHomePath(process.env.CODEX_HOME)
    : path.join(path.resolve(homedir()), ".codex");
  return path.join(codexHome, "skills", "polli", skillId);
}

function resolveNestedDeprecatedSkillInstallDir(backend: SkillBackend, skillId: string): string {
  const installDir = resolveSkillInstallDir(backend, skillId);
  return path.join(path.dirname(installDir), "_deprecated", path.basename(installDir));
}

export async function buildExpectedInstallTree(
  backend: SkillBackend,
  skillId: string,
  skillPath: string
): Promise<Map<string, Buffer>> {
  const parsed = await parseSkillDocument(skillPath);
  const extraFiles = await collectSkillExtraFiles(path.dirname(skillPath));
  const files = new Map<string, Buffer>();

  files.set("SKILL.md", Buffer.from(renderSkillForBackend(backend, skillId, parsed), "utf8"));
  for (const [relativePath, contents] of extraFiles.entries()) {
    files.set(relativePath, contents);
  }

  return files;
}

/**
 * Build the expected install tree from in-memory content rather than a path.
 * Mirrors {@link buildExpectedInstallTree} but takes the SKILL.md text + a map
 * of extra files (relpath -> Buffer). Reuses the same per-backend renderers, so
 * a DB round-trip produces byte-identical mirrors to a git-sourced sync.
 */
export function buildExpectedInstallTreeFromContent(
  backend: SkillBackend,
  skillId: string,
  rawSkillMd: string,
  extraFiles: Map<string, Buffer>
): Map<string, Buffer> {
  const parsed = parseSkillDocumentFromString(rawSkillMd, skillId);
  const files = new Map<string, Buffer>();

  files.set("SKILL.md", Buffer.from(renderSkillForBackend(backend, skillId, parsed), "utf8"));
  for (const [relativePath, contents] of extraFiles.entries()) {
    files.set(relativePath, contents);
  }

  return files;
}

export async function stageInstallationTree(
  installDir: string,
  files: Map<string, Buffer>
): Promise<PreparedInstallationMutation> {
  const parentDir = path.dirname(installDir);
  await mkdir(parentDir, { recursive: true });

  const stagedDir = await mkdtemp(path.join(parentDir, ".calyx-skill-stage-"));
  try {
    for (const [relativePath, contents] of files.entries()) {
      const destinationPath = path.join(stagedDir, relativePath);
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, contents);
    }
    return {
      kind: "install",
      installDir,
      stagedDir,
      backupDir: path.join(parentDir, `.calyx-skill-backup-${randomUUID()}`),
      hadExistingInstall: await pathExists(installDir),
      movedExistingInstall: false,
      installedNewTree: false
    };
  } catch (error) {
    if (await pathExists(stagedDir)) {
      await rm(stagedDir, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function preparePruneMutations(
  backend: SkillBackend,
  skillId: string
): Promise<PreparedInstallationMutation[]> {
  const installDirs = [resolveSkillInstallDir(backend, skillId), resolveNestedDeprecatedSkillInstallDir(backend, skillId)];
  const preparedMutations: PreparedInstallationMutation[] = [];
  const seenInstallDirs = new Set<string>();

  for (const rawInstallDir of installDirs) {
    const installDir = path.resolve(rawInstallDir);
    if (seenInstallDirs.has(installDir)) {
      continue;
    }
    seenInstallDirs.add(installDir);

    if (!(await pathExists(installDir))) {
      continue;
    }

    preparedMutations.push({
      kind: "prune",
      installDir,
      backupDir: path.join(path.dirname(installDir), `.calyx-skill-backup-${randomUUID()}`),
      hadExistingInstall: true,
      movedExistingInstall: false,
      installedNewTree: false
    });
  }

  return preparedMutations;
}

async function pruneEmptyNestedDeprecatedParents(preparedMutations: PreparedInstallationMutation[]): Promise<void> {
  const parentDirs = new Set<string>();

  for (const preparedMutation of preparedMutations) {
    if (preparedMutation.kind !== "prune") {
      continue;
    }

    const parentDir = path.dirname(preparedMutation.installDir);
    if (path.basename(parentDir) === "_deprecated") {
      parentDirs.add(parentDir);
    }
  }

  for (const parentDir of [...parentDirs].sort((left, right) => right.length - left.length)) {
    await rmdir(parentDir).catch(() => undefined);
  }
}

export async function cleanupPreparedInstallationMutations(
  preparedMutations: PreparedInstallationMutation[]
): Promise<void> {
  for (const preparedMutation of preparedMutations) {
    if (preparedMutation.stagedDir && (await pathExists(preparedMutation.stagedDir))) {
      await rm(preparedMutation.stagedDir, { recursive: true, force: true });
    }
    if (preparedMutation.movedExistingInstall && (await pathExists(preparedMutation.backupDir))) {
      await rm(preparedMutation.backupDir, { recursive: true, force: true });
    }
  }
}

export async function commitPreparedInstallationMutations(
  preparedMutations: PreparedInstallationMutation[]
): Promise<void> {
  const committedMutations: PreparedInstallationMutation[] = [];

  try {
    for (const preparedMutation of preparedMutations) {
      if (preparedMutation.hadExistingInstall) {
        await rename(preparedMutation.installDir, preparedMutation.backupDir);
        preparedMutation.movedExistingInstall = true;
      }

      if (preparedMutation.kind === "prune") {
        committedMutations.push(preparedMutation);
        continue;
      }

      try {
        await rename(preparedMutation.stagedDir!, preparedMutation.installDir);
        preparedMutation.installedNewTree = true;
        committedMutations.push(preparedMutation);
      } catch (error) {
        if (
          preparedMutation.movedExistingInstall &&
          !(await pathExists(preparedMutation.installDir)) &&
          (await pathExists(preparedMutation.backupDir))
        ) {
          await rename(preparedMutation.backupDir, preparedMutation.installDir).catch(() => undefined);
          preparedMutation.movedExistingInstall = false;
        }
        throw error;
      }
    }

    for (const preparedMutation of preparedMutations) {
      if (preparedMutation.movedExistingInstall && (await pathExists(preparedMutation.backupDir))) {
        await rm(preparedMutation.backupDir, { recursive: true, force: true });
        preparedMutation.movedExistingInstall = false;
      }
    }

    await pruneEmptyNestedDeprecatedParents(preparedMutations);
  } catch (error) {
    for (const committedMutation of committedMutations.reverse()) {
      if (committedMutation.installedNewTree && (await pathExists(committedMutation.installDir))) {
        await rm(committedMutation.installDir, { recursive: true, force: true });
        committedMutation.installedNewTree = false;
      }
      if (committedMutation.movedExistingInstall && (await pathExists(committedMutation.backupDir))) {
        await rename(committedMutation.backupDir, committedMutation.installDir).catch(() => undefined);
        committedMutation.movedExistingInstall = false;
      }
    }
    throw error;
  } finally {
    for (const preparedMutation of preparedMutations) {
      if (preparedMutation.stagedDir && (await pathExists(preparedMutation.stagedDir))) {
        await rm(preparedMutation.stagedDir, { recursive: true, force: true });
      }
      if (preparedMutation.movedExistingInstall && (await pathExists(preparedMutation.backupDir))) {
        await rm(preparedMutation.backupDir, { recursive: true, force: true });
      }
    }
  }
}
