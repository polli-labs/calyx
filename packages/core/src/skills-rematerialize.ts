import type { StateDriverDatabase } from "./state/driver";
import {
  readSkillContent,
  stampMaterialized,
  type SkillContentRow,
} from "./state/skill-content";
import { syncBackends } from "./skills";
import {
  type PreparedInstallationMutation,
  type SkillBackend,
  buildExpectedInstallTreeFromContent,
  bufferMapTreeSha,
  cleanupPreparedInstallationMutations,
  commitPreparedInstallationMutations,
  compareFileMaps,
  preparePruneMutations,
  readInstallationTree,
  resolveSkillInstallDir,
  stageInstallationTree,
} from "./skills-install";
import type { CodexSkillsSyncMode, SyncBackend } from "./types";

/**
 * POL-1729 Slice 1 — DB -> harness-mirror re-materializer for agent-owned
 * skills. This is the keystone of the write path: it renders the DB-of-record
 * content into every harness install mirror using the SAME atomic git-sync
 * machinery (`buildExpectedInstallTree*` + stage + rename-to-backup +
 * rename-staged-in + rollback-on-error), so a DB round-trip is byte-identical
 * to a git-sourced `calyx skills sync`.
 *
 * Correctness is paramount: get it wrong and the fleet diverges. The contracts
 * enforced here:
 *   #3/#8  — provenance gate: only regime `db` ever re-materializes from the DB;
 *            git/vendored/repo-maintained rows are refused (`cross_regime_write`).
 *   #2     — idempotency: a second identical re-materialize is a no-op, decided
 *            against the *rendered* tree (`compareFileMaps`).
 *   orphan — the install is a FULL DIRECTORY SWAP, so files that were removed
 *            from the payload are purged from the mirror.
 *   #6     — recoverability: a failed staged-rename rolls back to the prior tree.
 *   #9     — the materialized stamp is a compare-and-set; a write that lands
 *            mid-flight is left for its own re-materialize pass.
 */

export class RematerializeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RematerializeError";
    this.code = code;
  }
}

export type RematerializeAction = "installed" | "noop" | "pruned" | "noop-pruned";

export interface RematerializeBackendResult {
  backend: SkillBackend;
  action: RematerializeAction;
  installDir: string;
  /** sha256 of the expected rendered tree (absent for prune actions). */
  expectedTreeSha256?: string;
}

export interface RematerializeResult {
  skillName: string;
  hostId: string;
  contentHash: string;
  /** Overall action across backends: pruned (tombstone) or installed (live). */
  action: "installed" | "pruned";
  regime: string;
  /** True when the materialized_at stamp was applied (false if a newer write raced in). */
  stamped: boolean;
  backends: RematerializeBackendResult[];
}

export interface RematerializeSkillInput {
  db: StateDriverDatabase;
  hostId: string;
  skillName: string;
  /** Backend selector. Defaults to "all". */
  backends?: SyncBackend;
  /** Codex sync mode. Defaults to "alias-agents" (codex aliases agents). */
  codexMode?: CodexSkillsSyncMode;
}

function resolveExtraFiles(row: SkillContentRow): Map<string, Buffer> {
  const extra = new Map<string, Buffer>();
  for (const [relPath, contents] of Object.entries(row.payload)) {
    if (relPath === "SKILL.md") {
      continue;
    }
    // Path-traversal guard: the keystone must defend itself regardless of how
    // content entered the DB. A payload key like `../../etc/passwd` or an
    // absolute path would make `stageInstallationTree` escape the temp dir and
    // overwrite arbitrary files, so reject it before any mirror is touched.
    if (relPath.startsWith("/") || relPath.split("/").includes("..") || relPath.includes("\0")) {
      throw new RematerializeError("invalid_payload", `payload key contains an unsafe path: ${relPath}`);
    }
    extra.set(relPath, Buffer.from(contents, "utf8"));
  }
  return extra;
}

/**
 * Re-materialize a single skill from the DB-of-record into the harness install
 * mirrors. See the module doc for the contracts enforced.
 */
export async function rematerializeSkill(input: RematerializeSkillInput): Promise<RematerializeResult> {
  const { db, hostId, skillName } = input;
  const targetBackends = syncBackends(input.backends ?? "all", input.codexMode ?? "alias-agents");

  const row = readSkillContent(db, hostId, skillName);
  if (!row) {
    throw new RematerializeError("skill_not_found", `skill content not found for ${hostId}/${skillName}`);
  }

  // Provenance gate (contracts #3/#8): the DB is only the source of truth for
  // regime `db`. git/vendored/repo-maintained skills live in their source repos
  // and must never be re-materialized from the database.
  if (row.regime !== "db") {
    throw new RematerializeError(
      "cross_regime_write",
      `refusing to re-materialize ${hostId}/${skillName}: regime "${row.regime}" is not "db" (the DB is not its source of truth)`,
    );
  }

  // Tombstone path: prune every backend mirror.
  if (row.deleted_at !== null) {
    const backendResults: RematerializeBackendResult[] = [];
    const preparedMutations: PreparedInstallationMutation[] = [];
    try {
      for (const backend of targetBackends) {
        const installDir = resolveSkillInstallDir(backend, skillName);
        const prunes = await preparePruneMutations(backend, skillName);
        preparedMutations.push(...prunes);
        backendResults.push({
          backend,
          action: prunes.length > 0 ? "pruned" : "noop-pruned",
          installDir,
        });
      }
      if (preparedMutations.length > 0) {
        await commitPreparedInstallationMutations(preparedMutations);
      }
    } catch (error) {
      await cleanupPreparedInstallationMutations(preparedMutations);
      throw error;
    }

    const stamped = stampMaterialized(db, hostId, skillName, row.content_hash);
    return {
      skillName,
      hostId,
      contentHash: row.content_hash,
      action: "pruned",
      regime: row.regime,
      stamped,
      backends: backendResults,
    };
  }

  // Live path: render + atomic full-directory swap per backend.
  const rawSkillMd = row.payload["SKILL.md"];
  if (typeof rawSkillMd !== "string" || rawSkillMd.length === 0) {
    throw new RematerializeError(
      "invalid_payload",
      `live skill content for ${hostId}/${skillName} is missing a SKILL.md payload entry`,
    );
  }
  const extraFiles = resolveExtraFiles(row);

  const backendResults: RematerializeBackendResult[] = [];
  const preparedMutations: PreparedInstallationMutation[] = [];
  const verifyTargets: Array<{ backend: SkillBackend; installDir: string; expected: Map<string, Buffer> }> = [];

  try {
    for (const backend of targetBackends) {
      const installDir = resolveSkillInstallDir(backend, skillName);
      const expected = buildExpectedInstallTreeFromContent(backend, skillName, rawSkillMd, extraFiles);
      const expectedTreeSha256 = bufferMapTreeSha(expected);
      const live = await readInstallationTree(installDir);

      // Idempotency (#2): decide against the rendered tree, not the raw source.
      if (compareFileMaps(expected, live)) {
        backendResults.push({ backend, action: "noop", installDir, expectedTreeSha256 });
        continue;
      }

      preparedMutations.push(await stageInstallationTree(installDir, expected));
      verifyTargets.push({ backend, installDir, expected });
      backendResults.push({ backend, action: "installed", installDir, expectedTreeSha256 });
    }

    if (preparedMutations.length > 0) {
      await commitPreparedInstallationMutations(preparedMutations);
    }
  } catch (error) {
    await cleanupPreparedInstallationMutations(preparedMutations);
    throw error;
  }

  // Post-commit hash verification: re-read each committed mirror and assert it
  // equals the expected rendered tree. A mismatch here means the atomic swap
  // did not produce the intended tree — surface it loudly rather than stamping.
  for (const target of verifyTargets) {
    const liveAfter = await readInstallationTree(target.installDir);
    if (!compareFileMaps(target.expected, liveAfter)) {
      throw new RematerializeError(
        "verify_failed",
        `post-commit verification failed for ${target.backend} mirror at ${target.installDir}: live tree does not match the expected rendered tree`,
      );
    }
  }

  // CAS stamp (#9): only stamp if the row's content_hash is still ours.
  const stamped = stampMaterialized(db, hostId, skillName, row.content_hash);

  return {
    skillName,
    hostId,
    contentHash: row.content_hash,
    action: "installed",
    regime: row.regime,
    stamped,
    backends: backendResults,
  };
}
