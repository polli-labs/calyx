import { readFile } from "node:fs/promises";
import path from "node:path";

import { pathExists } from "./agents-infra";
import { collectSkillExtraFiles, normalizeName } from "./skills-install";
import { loadSkillsRegistryLoose, resolveSkillSourcePath } from "./skills";
import { rematerializeSkill, type RematerializeResult } from "./skills-rematerialize";
import { hashSkillPayload, readSkillContent, upsertSkillContent } from "./state/skill-content";
import type { StateDriverDatabase } from "./state/driver";
import type { SkillRegistryEntry } from "./types";

/**
 * POL-1729 Slice 2 — first-party → db-regime migration (the CAPABILITY only).
 *
 * `migrateSkill` lifts a single first-party (`source.type=internal`) skill from
 * its git source into the agent-owned DB (`skill_content`, regime `db`) and
 * re-materializes the harness mirrors through the SAME Slice-1 re-materializer
 * (path-traversal-guarded, atomic full-directory swap, post-commit hash verify).
 * After migration `calyx skills sync` skips the entry (contract #8) because the
 * re-materializer owns the mirror.
 *
 * What it deliberately does NOT do (split-brain / audit / rollback reasons):
 *   - It NEVER edits SOURCES.json. That file lives in agents-infra, a separate
 *     repo; setting `"regime": "db"` there is a reviewed, operator-gated commit.
 *     The result carries a `next_step` string instructing the operator to make
 *     that edit so `calyx skills sync` starts skipping the entry.
 *   - It refuses any non-`internal` source (`not_first_party`): vendored /
 *     repo-maintained skills stay git in Slice 2.
 *
 * Regime vs provenance are orthogonal: a migrated skill keeps its provenance
 * class (`repo-managed`) but its current source-of-truth becomes the DB.
 */

export type MigrateErrorCode = "not_first_party" | "source_unresolved" | "skill_not_found";

export class MigrateError extends Error {
  readonly code: MigrateErrorCode;
  readonly suggestions: string[];

  constructor(code: MigrateErrorCode, message: string, suggestions: string[] = []) {
    super(message);
    this.name = "MigrateError";
    this.code = code;
    this.suggestions = suggestions;
  }
}

export type MigrateAction = "planned" | "installed" | "noop";

export interface MigrateResult {
  skillId: string;
  hostId: string;
  /** planned (dry-run) | installed (applied) | noop (already db-regime, identical content). */
  action: MigrateAction;
  /** Whether this was a dry-run (no writes performed). */
  dryRun: boolean;
  /** Content hash of the assembled payload. */
  contentHash: string;
  /** Sorted relpaths of the assembled payload (e.g. ["SKILL.md", "references/x.md"]). */
  payloadFiles: string[];
  /** Resolved git source path the content was read from. */
  sourcePath: string;
  /** Per-backend re-materialize results (absent on dry-run / noop). */
  rematerialize?: RematerializeResult;
  /**
   * Operator instruction: this verb never edits SOURCES.json. Set
   * `"regime": "db"` on the entry in agents-infra SOURCES.json + commit, then
   * `calyx skills sync` skips it.
   */
  next_step: string;
}

export interface MigrateSkillInput {
  db: StateDriverDatabase;
  skillId: string;
  /** Local host alias for the skill_content row. */
  hostId: string;
  /** agents-infra root for resolving an `internal` source path. */
  agentsInfraRoot?: string | undefined;
  /** Path to the SOURCES.json registry. */
  registryPath: string;
  /** Plan only; perform no writes. */
  dryRun?: boolean | undefined;
}

function nextStepFor(skillId: string): string {
  return (
    `Set "regime": "db" on the "${skillId}" entry in agents-infra instructions/skills/SOURCES.json ` +
    `and commit, so \`calyx skills sync\` skips it (the re-materializer now owns the mirror). ` +
    `This verb intentionally does NOT edit SOURCES.json.`
  );
}

/**
 * Read the SKILL.md (verbatim, including frontmatter) plus all extra files of a
 * git-sourced skill into a payload map (relpath -> UTF-8 content), mirroring what
 * `calyx skills write --content-file SKILL.md` would persist.
 */
async function assembleGitSourcePayload(
  sourcePath: string,
): Promise<Record<string, string>> {
  const payload: Record<string, string> = {};
  payload["SKILL.md"] = await readFile(sourcePath, "utf8");
  const extra = await collectSkillExtraFiles(path.dirname(sourcePath));
  for (const [relPath, contents] of extra.entries()) {
    payload[relPath] = contents.toString("utf8");
  }
  return payload;
}

function findRegistryEntry(
  skills: SkillRegistryEntry[],
  skillId: string,
): SkillRegistryEntry | undefined {
  return (
    skills.find((item) => item.id === skillId) ??
    skills.find((item) => item.id.toLowerCase() === skillId.trim().toLowerCase())
  );
}

/**
 * Migrate a single first-party skill to the db regime. See module doc for the
 * contracts and the deliberate SOURCES.json non-edit.
 */
export async function migrateSkill(input: MigrateSkillInput): Promise<MigrateResult> {
  const { db, skillId, hostId, registryPath } = input;
  const dryRun = Boolean(input.dryRun);

  const registry = await loadSkillsRegistryLoose(registryPath);
  const entry = findRegistryEntry(registry.skills, skillId);
  if (!entry) {
    throw new MigrateError(
      "skill_not_found",
      `Skill "${skillId}" was not found in the registry at ${registryPath}.`,
    );
  }

  // Refuse non-first-party sources: only `internal` skills migrate to db in
  // Slice 2. vendored (external) / repo-maintained stay git.
  if (entry.source.type.trim().toLowerCase() !== "internal") {
    const firstParty = registry.skills
      .filter((item) => item.source.type.trim().toLowerCase() === "internal")
      .map((item) => item.id);
    throw new MigrateError(
      "not_first_party",
      `Skill "${entry.id}" has source.type "${entry.source.type}"; only first-party (internal) skills migrate to the db regime in Slice 2.`,
      [
        `first-party (internal) skills you can migrate: ${firstParty.length > 0 ? firstParty.join(", ") : "(none)"}`,
        "vendored/repo-maintained skills stay in their source repos (git regime).",
      ],
    );
  }

  const sourcePath = await resolveSkillSourcePath(entry, input.agentsInfraRoot);
  if (!sourcePath || !(await pathExists(sourcePath))) {
    throw new MigrateError(
      "source_unresolved",
      `Unable to resolve the git source for "${entry.id}" (path=${entry.source.path}). Pass --agents-infra-root <path> or check the source path.`,
      ["pass --agents-infra-root <path>", "or set CALYX_AGENTS_INFRA_ROOT"],
    );
  }

  const payload = await assembleGitSourcePayload(sourcePath);
  const payloadFiles = Object.keys(payload).sort((a, b) => a.localeCompare(b));

  // The would-be content hash uses the SAME canonical hash the write path
  // persists, so dry-run / idempotency decisions match the applied row exactly.
  const contentHash = hashSkillPayload(payload);

  // Slice 1 keys `skill_content` rows by the NORMALIZED name (`upsertSkillContent`
  // runs `normalizeName` on `skill_name`), but `readSkillContent` does NOT
  // normalize its lookup. Resolve the canonical id ONCE here and use it for the
  // idempotency read, the upsert, AND the re-materialize so all three address the
  // same row the write path stores under — otherwise `migrate My-Skill` misses
  // the canonical `my-skill` row and needlessly re-writes + re-materializes every
  // run. `normalizeName` is idempotent, so an already-canonical id is unchanged.
  const canonicalId = normalizeName(entry.id);

  const existing = readSkillContent(db, hostId, canonicalId);
  // Idempotent no-op: already db-regime, live, with identical content.
  const isIdenticalDbRow =
    existing !== undefined &&
    existing.regime === "db" &&
    existing.deleted_at === null &&
    existing.content_hash === contentHash;

  if (isIdenticalDbRow) {
    return {
      skillId: canonicalId,
      hostId,
      action: "noop",
      dryRun,
      contentHash,
      payloadFiles,
      sourcePath,
      next_step: nextStepFor(canonicalId),
    };
  }

  if (dryRun) {
    return {
      skillId: canonicalId,
      hostId,
      action: "planned",
      dryRun: true,
      contentHash,
      payloadFiles,
      sourcePath,
      next_step: nextStepFor(canonicalId),
    };
  }

  // Apply: write the db-regime row (Slice 1), then re-materialize through the
  // SAME path-traversal-guarded re-materializer. Provenance for the row records
  // the migration origin. All three address the canonical id.
  upsertSkillContent(db, {
    host_id: hostId,
    skill_name: canonicalId,
    payload,
    regime: "db",
    author: `migrate:${hostId}`,
    summary: `migrated ${canonicalId} from git source ${entry.source.path} to db regime`,
    note: `POL-1729 Slice 2 migrate from ${sourcePath}`,
  });
  const rematerialize = await rematerializeSkill({ db, hostId, skillName: canonicalId });

  return {
    skillId: canonicalId,
    hostId,
    action: "installed",
    dryRun: false,
    contentHash,
    payloadFiles,
    sourcePath,
    rematerialize,
    next_step: nextStepFor(canonicalId),
  };
}

export interface MigrateAllInternalInput {
  db: StateDriverDatabase;
  hostId: string;
  agentsInfraRoot?: string | undefined;
  registryPath: string;
  dryRun?: boolean | undefined;
}

export interface MigrateAllInternalResult {
  hostId: string;
  dryRun: boolean;
  /** Skill ids that were planned/installed/no-op'd. */
  results: MigrateResult[];
  /** Per-skill failures (skill id + error code + message). */
  failures: Array<{ skillId: string; code: MigrateErrorCode; message: string }>;
  /**
   * Present only when the registry has no first-party (`source.type=internal`)
   * skills: a clear signal that the batch matched nothing (so an empty
   * `results`/`failures` is not silently ambiguous).
   */
  note?: string;
  next_step: string;
}

const NO_INTERNAL_SKILLS_NOTE = "no first-party (internal) skills found to migrate";

/**
 * Migrate every first-party (`source.type=internal`) skill. Failures on one
 * skill are collected, not fatal, so a partial migration still reports what
 * landed AND what failed — including non-`MigrateError` failures (e.g. an
 * ENOENT from a broken extra-file symlink while assembling a payload). The
 * caller (CLI) gates `--all-internal` apply behind `--confirm`. When there are
 * no internal skills the result carries a `note` so the empty batch is explicit.
 */
export async function migrateAllInternalSkills(
  input: MigrateAllInternalInput,
): Promise<MigrateAllInternalResult> {
  const dryRun = Boolean(input.dryRun);
  const registry = await loadSkillsRegistryLoose(input.registryPath);
  const internalIds = registry.skills
    .filter((item) => item.source.type.trim().toLowerCase() === "internal")
    .map((item) => item.id);

  const results: MigrateResult[] = [];
  const failures: Array<{ skillId: string; code: MigrateErrorCode; message: string }> = [];
  for (const skillId of internalIds) {
    try {
      results.push(
        await migrateSkill({
          db: input.db,
          skillId,
          hostId: input.hostId,
          agentsInfraRoot: input.agentsInfraRoot,
          registryPath: input.registryPath,
          dryRun,
        }),
      );
    } catch (error) {
      // Collect ALL errors, not just MigrateError: a plain Error from one skill
      // (e.g. a broken source symlink) must NOT abort the whole batch. An
      // unexpected error is reported under `source_unresolved` so the partial
      // batch still surfaces what landed and what failed.
      if (error instanceof MigrateError) {
        failures.push({ skillId, code: error.code, message: error.message });
      } else {
        failures.push({ skillId, code: "source_unresolved", message: String(error) });
      }
    }
  }

  return {
    hostId: input.hostId,
    dryRun,
    results,
    failures,
    ...(internalIds.length === 0 ? { note: NO_INTERNAL_SKILLS_NOTE } : {}),
    next_step:
      "For each migrated skill, set \"regime\": \"db\" on its entry in agents-infra instructions/skills/SOURCES.json and commit, then `calyx skills sync` skips them.",
  };
}
