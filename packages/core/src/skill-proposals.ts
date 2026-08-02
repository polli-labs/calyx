import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { resolveAgentsInfraRoot } from "./agents-infra";
import {
  SKILL_PROPOSAL_KINDS,
  SKILL_PROPOSAL_STATUSES,
  SKILL_PROPOSAL_TARGETS,
  applyStateMigrations,
  createSkillProposal as stateCreateSkillProposal,
  listSkillProposalEvents,
  listSkillProposals,
  openStateStore,
  readSkillProposal,
  updateSkillProposalStatus,
  type SkillProposalEventRow,
  type SkillProposalKind,
  type SkillProposalRow,
  type SkillProposalStatus,
  type SkillProposalTarget,
} from "./state";

/**
 * Wave 2.4 `calyx skills propose`/`calyx skills proposals` operations.
 *
 * High-level orchestrators for the proposal lifecycle. State writes are
 * delegated to the typed helpers in `state/skill-proposals.ts`; this layer
 * adds path resolution, source-truth validation, and patch-artifact
 * materialization on top.
 *
 * The source-truth boundary is enforced here: proposal targets that point
 * at installed harness mirrors (`~/.agents/skills/**`, `~/.claude/skills/**`,
 * `~/.codex/skills/**`) are rejected with an explicit, named alternative.
 * Validation and materialization both honor that boundary; the lifecycle
 * code path never silently writes to install outputs.
 */
export {
  SKILL_PROPOSAL_KINDS,
  SKILL_PROPOSAL_STATUSES,
  SKILL_PROPOSAL_TARGETS,
} from "./state";
export type {
  SkillProposalEventRow,
  SkillProposalKind,
  SkillProposalRow,
  SkillProposalStatus,
  SkillProposalTarget,
} from "./state";

/** Path fragments treated as installed harness mirrors. */
const INSTALL_MIRROR_FRAGMENTS = [
  "/.agents/skills",
  "/.claude/skills",
  "/.codex/skills",
];

function isInstallMirrorPath(candidate: string): boolean {
  const normalized = path.resolve(candidate).replace(/\\/g, "/");
  for (const fragment of INSTALL_MIRROR_FRAGMENTS) {
    const index = normalized.indexOf(fragment);
    if (index === -1) continue;
    const after = normalized[index + fragment.length];
    if (after === undefined || after === "/") return true;
  }
  return false;
}

function sourceRootHint(target: SkillProposalTarget): string {
  if (target === "agents-infra") {
    return "Use the agents-infra source worktree at ~/dev/agents-infra/dev (or pass --source-root to point Calyx at a worktree under wt/<branch>/).";
  }
  return "Use the repo-local source worktree (e.g. ~/dev/<repo>/dev/skills/<id> or a worktree under wt/<branch>/skills/<id>).";
}

export class SkillProposalError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly suggestions: string[];
  constructor(
    code: string,
    message: string,
    options: { exitCode?: number; suggestions?: string[] } = {},
  ) {
    super(message);
    this.name = "SkillProposalError";
    this.code = code;
    this.exitCode = options.exitCode ?? 2;
    this.suggestions = options.suggestions ?? [];
  }
}

export interface SkillProposalCreateInput {
  skill_id: string;
  kind: SkillProposalKind;
  target: SkillProposalTarget;
  source_root?: string;
  relative_source_file?: string;
  summary?: string;
  author?: string;
  origin_activity_id?: string;
  origin_message_id?: string;
  /** Raw content/body for kind=create or kind=file (whole-file). */
  content?: string;
  /** Unified-diff body for kind=patch. */
  diff?: string;
  /** Override the auto-generated proposal_id for tests/idempotency. */
  proposal_id?: string;
  /** Optional explicit "now" injection for tests. */
  now?: () => string;
  /** Optional custom homedir for tests. */
  homeDir?: string;
}

interface ResolvedSourceTarget {
  source_root: string;
  target_source_path: string;
  source_root_source: "explicit" | "agents-infra-canonical" | "agents-infra-env";
}

async function resolveSourceTarget(
  skillId: string,
  target: SkillProposalTarget,
  explicitRoot: string | undefined,
  homeDir: string,
): Promise<ResolvedSourceTarget> {
  if (explicitRoot && explicitRoot.trim().length > 0) {
    const root = path.resolve(explicitRoot.trim());
    if (isInstallMirrorPath(root)) {
      throw new SkillProposalError(
        "source-root-is-mirror",
        `--source-root "${root}" is an installed harness mirror, not a source worktree.`,
        { suggestions: [sourceRootHint(target)] },
      );
    }
    const targetSourcePath =
      target === "agents-infra"
        ? path.join(root, "instructions", "skills", skillId)
        : path.join(root, "skills", skillId);
    return {
      source_root: root,
      target_source_path: targetSourcePath,
      source_root_source: "explicit",
    };
  }
  if (target === "agents-infra") {
    const detected = await resolveAgentsInfraRoot();
    if (detected) {
      if (isInstallMirrorPath(detected)) {
        throw new SkillProposalError(
          "agents-infra-resolved-to-mirror",
          `Resolved agents-infra root "${detected}" looks like an installed mirror.`,
          { suggestions: [sourceRootHint(target)] },
        );
      }
      return {
        source_root: detected,
        target_source_path: path.join(
          detected,
          "instructions",
          "skills",
          skillId,
        ),
        source_root_source: detected.includes(path.sep + "dev" + path.sep)
          ? "agents-infra-canonical"
          : "agents-infra-env",
      };
    }
    throw new SkillProposalError(
      "agents-infra-root-not-found",
      "Could not locate an agents-infra source worktree.",
      {
        suggestions: [
          "Pass --source-root <path> to point at the agents-infra worktree.",
          `Canonical path: ${path.join(homeDir, "dev/agents-infra/dev")}.`,
        ],
      },
    );
  }
  throw new SkillProposalError(
    "source-root-required",
    `--source-root is required for --target ${target}.`,
    { suggestions: [sourceRootHint(target)] },
  );
}

function validateSkillId(skillId: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(skillId)) {
    throw new SkillProposalError(
      "invalid-skill-id",
      `invalid skill-id "${skillId}": expected a slug like fieldwork-conventions or calyx-dev.`,
      { exitCode: 2 },
    );
  }
}

function validateRelativeSourceFile(rel: string): void {
  const normalized = rel.replace(/\\/g, "/").trim();
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("..") ||
    normalized.includes("\0")
  ) {
    throw new SkillProposalError(
      "invalid-relative-source-file",
      `invalid relative source file "${rel}": must be a non-empty relative path with no leading slash and no parent traversal.`,
      { exitCode: 2 },
    );
  }
}

export interface SkillProposalCreatedResult {
  proposal: SkillProposalRow;
  source_root_source: ResolvedSourceTarget["source_root_source"];
}

/**
 * Create a new proposal. Validates target/kind/content, resolves the
 * source-root and computed source path, and persists the proposal row +
 * `created` event in a single SQLite transaction.
 */
export async function createProposal(
  input: SkillProposalCreateInput,
): Promise<SkillProposalCreatedResult> {
  validateSkillId(input.skill_id);
  if (!SKILL_PROPOSAL_KINDS.includes(input.kind)) {
    throw new SkillProposalError(
      "invalid-kind",
      `invalid --kind "${input.kind}". Valid: ${SKILL_PROPOSAL_KINDS.join(", ")}.`,
      { exitCode: 2 },
    );
  }
  if (!SKILL_PROPOSAL_TARGETS.includes(input.target)) {
    throw new SkillProposalError(
      "invalid-target",
      `invalid --target "${input.target}". Valid: ${SKILL_PROPOSAL_TARGETS.join(", ")}.`,
      { exitCode: 2 },
    );
  }
  if (input.kind === "patch" && !input.diff) {
    throw new SkillProposalError(
      "missing-diff",
      "kind=patch requires a --diff-file, --diff, or --stdin diff body.",
      { exitCode: 2 },
    );
  }
  if (input.kind === "file") {
    if (!input.relative_source_file) {
      throw new SkillProposalError(
        "missing-relative-source-file",
        "kind=file requires <relative-source-file>.",
        { exitCode: 2 },
      );
    }
    validateRelativeSourceFile(input.relative_source_file);
    if (input.content === undefined) {
      throw new SkillProposalError(
        "missing-content",
        "kind=file requires --content-file, --body-file, --content, or --stdin content body.",
        { exitCode: 2 },
      );
    }
  }
  if (input.kind === "create" && input.content === undefined) {
    throw new SkillProposalError(
      "missing-content",
      "kind=create requires --content-file, --body-file, --content, or --stdin content body.",
      { exitCode: 2 },
    );
  }

  const home = input.homeDir ?? homedir();
  const resolved = await resolveSourceTarget(
    input.skill_id,
    input.target,
    input.source_root,
    home,
  );

  await applyStateMigrations();
  const opened = await openStateStore();
  try {
    const proposalId = input.proposal_id ?? `prop_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const payload: Record<string, unknown> = {};
    if (input.kind === "patch" && input.diff !== undefined) {
      payload["diff"] = input.diff;
    }
    if (
      (input.kind === "create" || input.kind === "file") &&
      input.content !== undefined
    ) {
      payload["content"] = input.content;
    }
    const proposal = stateCreateSkillProposal(
      opened.db,
      {
        proposal_id: proposalId,
        skill_id: input.skill_id,
        kind: input.kind,
        target: input.target,
        source_root: resolved.source_root,
        target_source_path: resolved.target_source_path,
        relative_source_file: input.relative_source_file ?? null,
        origin_activity_id: input.origin_activity_id ?? null,
        origin_message_id: input.origin_message_id ?? null,
        summary: input.summary ?? null,
        author: input.author ?? null,
        payload,
      },
      input.now,
    );
    return { proposal, source_root_source: resolved.source_root_source };
  } finally {
    opened.db.close();
  }
}

export interface SkillProposalListInput {
  status?: SkillProposalStatus;
  skill_id?: string;
  limit?: number;
}

export interface SkillProposalListResult {
  proposals: SkillProposalRow[];
  total: number;
  limit: number;
  truncated: boolean;
}

export async function listProposals(
  input: SkillProposalListInput = {},
): Promise<SkillProposalListResult> {
  if (input.status !== undefined && !SKILL_PROPOSAL_STATUSES.includes(input.status)) {
    throw new SkillProposalError(
      "invalid-status",
      `invalid --status "${input.status}". Valid: ${SKILL_PROPOSAL_STATUSES.join(", ")}.`,
      { exitCode: 2 },
    );
  }
  await applyStateMigrations();
  const opened = await openStateStore();
  try {
    const requestedLimit = input.limit;
    const proposals = listSkillProposals(opened.db, {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.skill_id ? { skill_id: input.skill_id } : {}),
      ...(requestedLimit !== undefined ? { limit: requestedLimit } : {}),
    });
    const limit = proposals.length;
    return {
      proposals,
      total: proposals.length,
      limit,
      truncated: false,
    };
  } finally {
    opened.db.close();
  }
}

export interface SkillProposalShowResult {
  proposal: SkillProposalRow;
  events: SkillProposalEventRow[];
}

export async function showProposal(
  proposalId: string,
): Promise<SkillProposalShowResult> {
  await applyStateMigrations();
  const opened = await openStateStore();
  try {
    const proposal = readSkillProposal(opened.db, proposalId);
    if (!proposal) {
      throw new SkillProposalError(
        "not-found",
        `proposal "${proposalId}" not found.`,
        { exitCode: 3 },
      );
    }
    const events = listSkillProposalEvents(opened.db, proposalId);
    return { proposal, events };
  } finally {
    opened.db.close();
  }
}

export interface SkillProposalValidateResult {
  proposal: SkillProposalRow;
  event: SkillProposalEventRow;
  checks: Array<{
    code: string;
    status: "ok" | "error";
    detail: string;
  }>;
}

/**
 * Validate proposal payload + target path. Walks the recorded source path
 * to refuse installed-mirror targets explicitly, with an actionable
 * alternative for source-root review. Transitions `proposed` -> `validated`
 * on success.
 */
export async function validateProposal(
  proposalId: string,
  options: { now?: () => string; actor?: string | undefined } = {},
): Promise<SkillProposalValidateResult> {
  await applyStateMigrations();
  const opened = await openStateStore();
  try {
    const proposal = readSkillProposal(opened.db, proposalId);
    if (!proposal) {
      throw new SkillProposalError(
        "not-found",
        `proposal "${proposalId}" not found.`,
        { exitCode: 3 },
      );
    }
    const checks: SkillProposalValidateResult["checks"] = [];

    if (!SKILL_PROPOSAL_KINDS.includes(proposal.kind)) {
      checks.push({
        code: "kind-vocabulary",
        status: "error",
        detail: `proposal has unknown kind "${proposal.kind}".`,
      });
    } else {
      checks.push({
        code: "kind-vocabulary",
        status: "ok",
        detail: `kind=${proposal.kind} is in the closed vocabulary.`,
      });
    }
    if (!SKILL_PROPOSAL_TARGETS.includes(proposal.target)) {
      checks.push({
        code: "target-vocabulary",
        status: "error",
        detail: `proposal has unknown target "${proposal.target}".`,
      });
    } else {
      checks.push({
        code: "target-vocabulary",
        status: "ok",
        detail: `target=${proposal.target} is in the closed vocabulary.`,
      });
    }

    const sourceRoot = proposal.source_root;
    if (!sourceRoot) {
      checks.push({
        code: "source-root-present",
        status: "error",
        detail: "proposal has no recorded source_root.",
      });
    } else if (isInstallMirrorPath(sourceRoot)) {
      checks.push({
        code: "source-root-not-mirror",
        status: "error",
        detail: `source_root "${sourceRoot}" points at an installed harness mirror. ${sourceRootHint(proposal.target)}`,
      });
    } else {
      checks.push({
        code: "source-root-not-mirror",
        status: "ok",
        detail: `source_root "${sourceRoot}" is not an installed mirror.`,
      });
    }

    const targetSourcePath = proposal.target_source_path;
    if (!targetSourcePath) {
      checks.push({
        code: "target-source-path-present",
        status: "error",
        detail: "proposal has no recorded target_source_path.",
      });
    } else if (isInstallMirrorPath(targetSourcePath)) {
      checks.push({
        code: "target-source-path-not-mirror",
        status: "error",
        detail: `target_source_path "${targetSourcePath}" points at an installed harness mirror. ${sourceRootHint(proposal.target)}`,
      });
    } else {
      checks.push({
        code: "target-source-path-not-mirror",
        status: "ok",
        detail: `target_source_path "${targetSourcePath}" is not an installed mirror.`,
      });
    }

    if (proposal.kind === "file") {
      if (!proposal.relative_source_file) {
        checks.push({
          code: "relative-source-file-present",
          status: "error",
          detail: "kind=file proposal is missing relative_source_file.",
        });
      } else {
        try {
          validateRelativeSourceFile(proposal.relative_source_file);
          checks.push({
            code: "relative-source-file-safe",
            status: "ok",
            detail: `relative_source_file "${proposal.relative_source_file}" is a safe relative path.`,
          });
        } catch (err) {
          checks.push({
            code: "relative-source-file-safe",
            status: "error",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const payload = (proposal.payload && typeof proposal.payload === "object"
      ? (proposal.payload as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    if (proposal.kind === "patch") {
      const diff = typeof payload["diff"] === "string" ? (payload["diff"] as string) : "";
      if (diff.trim().length === 0) {
        checks.push({
          code: "diff-present",
          status: "error",
          detail: "kind=patch proposal has empty diff payload.",
        });
      } else {
        checks.push({
          code: "diff-present",
          status: "ok",
          detail: `diff body is ${diff.length} bytes.`,
        });
      }
    }
    if (proposal.kind === "create" || proposal.kind === "file") {
      const content =
        typeof payload["content"] === "string" ? (payload["content"] as string) : null;
      if (content === null) {
        checks.push({
          code: "content-present",
          status: "error",
          detail: `kind=${proposal.kind} proposal has no content payload.`,
        });
      } else {
        checks.push({
          code: "content-present",
          status: "ok",
          detail: `content body is ${content.length} bytes.`,
        });
      }
    }

    const blocked = checks.some((c) => c.status === "error");
    if (blocked) {
      throw new SkillProposalError(
        "validation-failed",
        `proposal "${proposalId}" failed validation: ${checks.filter((c) => c.status === "error").map((c) => c.code).join(", ")}.`,
        {
          exitCode: 3,
          suggestions: checks
            .filter((c) => c.status === "error")
            .map((c) => c.detail),
        },
      );
    }

    const { proposal: updated, event } = updateSkillProposalStatus(
      opened.db,
      {
        proposal_id: proposalId,
        expected_status: "proposed",
        next_status: "validated",
        event_type: "validated",
        actor: options.actor ?? null,
        status_timestamp_column: "validated_at",
        payload: { checks },
        payload_patch: {
          validation: {
            checks,
            validated_at_via: "calyx skills proposals validate",
          },
        },
      },
      options.now,
    );
    return { proposal: updated, event, checks };
  } finally {
    opened.db.close();
  }
}

export interface SkillProposalMaterializeInput {
  /**
   * Either an explicit `--output <file>` path or a `--worktree <dir>`
   * under which the artifact is written. Exactly one must be provided.
   */
  output_path?: string;
  worktree?: string;
  actor?: string;
  now?: () => string;
}

export interface SkillProposalMaterializeResult {
  proposal: SkillProposalRow;
  event: SkillProposalEventRow;
  artifact_path: string;
  manifest_path: string;
}

function summarizeArtifactKind(proposal: SkillProposalRow): "diff" | "content" | "manifest-only" {
  if (proposal.kind === "patch") return "diff";
  if (proposal.kind === "create" || proposal.kind === "file") return "content";
  return "manifest-only";
}

function buildArtifactBody(proposal: SkillProposalRow): string {
  const payload = (proposal.payload && typeof proposal.payload === "object"
    ? (proposal.payload as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  if (proposal.kind === "patch") {
    const diff = typeof payload["diff"] === "string" ? (payload["diff"] as string) : "";
    return diff;
  }
  const content = typeof payload["content"] === "string" ? (payload["content"] as string) : "";
  return content;
}

/**
 * Write a reviewable patch artifact to disk and transition the proposal to
 * `materialized`. The artifact is either a unified-diff file (kind=patch)
 * or a whole-file content snapshot (kind=create/file). A sibling JSON
 * manifest is always written so reviewers can replay the artifact without
 * re-reading SQLite.
 *
 * Materialization never invokes `calyx skills sync` and never writes to
 * installed harness mirrors. Output paths under those mirrors are refused
 * with an explicit alternative.
 */
export async function materializeProposal(
  proposalId: string,
  input: SkillProposalMaterializeInput,
): Promise<SkillProposalMaterializeResult> {
  if (Boolean(input.output_path) === Boolean(input.worktree)) {
    throw new SkillProposalError(
      "materialize-target-required",
      "calyx skills proposals materialize requires exactly one of --output <path> or --worktree <dir>.",
      { exitCode: 2 },
    );
  }
  await applyStateMigrations();
  const opened = await openStateStore();
  try {
    const proposal = readSkillProposal(opened.db, proposalId);
    if (!proposal) {
      throw new SkillProposalError(
        "not-found",
        `proposal "${proposalId}" not found.`,
        { exitCode: 3 },
      );
    }
    if (proposal.status === "rejected" || proposal.status === "superseded") {
      throw new SkillProposalError(
        "invalid-status-transition",
        `proposal "${proposalId}" is in status "${proposal.status}" and cannot be materialized.`,
        { exitCode: 3 },
      );
    }

    let artifactPath: string;
    let manifestPath: string;
    if (input.output_path) {
      artifactPath = path.resolve(input.output_path);
      const dir = path.dirname(artifactPath);
      manifestPath = path.join(
        dir,
        `${path.basename(artifactPath, path.extname(artifactPath))}.manifest.json`,
      );
    } else {
      const worktreeRoot = path.resolve(input.worktree!);
      const dir = path.join(worktreeRoot, "calyx-skill-proposals");
      const extension = proposal.kind === "patch" ? "patch" : "content";
      artifactPath = path.join(dir, `${proposalId}.${extension}`);
      manifestPath = path.join(dir, `${proposalId}.manifest.json`);
    }

    if (isInstallMirrorPath(artifactPath)) {
      throw new SkillProposalError(
        "output-is-mirror",
        `materialization output "${artifactPath}" is under an installed harness mirror.`,
        {
          exitCode: 3,
          suggestions: [sourceRootHint(proposal.target)],
        },
      );
    }

    const body = buildArtifactBody(proposal);
    const dir = path.dirname(artifactPath);
    await mkdir(dir, { recursive: true });
    await writeFile(artifactPath, body, "utf8");

    const manifest = {
      proposal_id: proposal.proposal_id,
      skill_id: proposal.skill_id,
      kind: proposal.kind,
      target: proposal.target,
      source_root: proposal.source_root,
      target_source_path: proposal.target_source_path,
      relative_source_file: proposal.relative_source_file,
      summary: proposal.summary,
      author: proposal.author,
      origin_activity_id: proposal.origin_activity_id,
      origin_message_id: proposal.origin_message_id,
      created_at: proposal.created_at,
      materialized_at: input.now ? input.now() : new Date().toISOString(),
      artifact_kind: summarizeArtifactKind(proposal),
      artifact_path: artifactPath,
      artifact_bytes: Buffer.byteLength(body, "utf8"),
      replay_hint:
        proposal.kind === "patch"
          ? `Review with: git -C ${proposal.source_root ?? "<source-root>"} apply --check ${artifactPath}`
          : proposal.kind === "file"
            ? `Apply by copying ${artifactPath} to ${proposal.target_source_path}/${proposal.relative_source_file ?? "<relative-path>"}`
            : `Apply by copying ${artifactPath} into ${proposal.target_source_path}`,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const { proposal: updated, event } = updateSkillProposalStatus(
      opened.db,
      {
        proposal_id: proposalId,
        expected_status: ["validated", "proposed", "accepted"],
        next_status: "materialized",
        event_type: "materialized",
        actor: input.actor ?? null,
        status_timestamp_column: "materialized_at",
        payload: { artifact_path: artifactPath, manifest_path: manifestPath },
        payload_patch: {
          materialization: {
            artifact_path: artifactPath,
            manifest_path: manifestPath,
            artifact_kind: summarizeArtifactKind(proposal),
            artifact_bytes: Buffer.byteLength(body, "utf8"),
          },
        },
      },
      input.now,
    );
    return {
      proposal: updated,
      event,
      artifact_path: artifactPath,
      manifest_path: manifestPath,
    };
  } finally {
    opened.db.close();
  }
}

export interface SkillProposalReviewInput {
  /** `accepted`, `rejected`, or `superseded`. */
  status: "accepted" | "rejected" | "superseded";
  actor?: string;
  note?: string;
  now?: () => string;
}

export interface SkillProposalReviewResult {
  proposal: SkillProposalRow;
  event: SkillProposalEventRow;
}

export async function reviewProposal(
  proposalId: string,
  input: SkillProposalReviewInput,
): Promise<SkillProposalReviewResult> {
  if (
    input.status !== "accepted" &&
    input.status !== "rejected" &&
    input.status !== "superseded"
  ) {
    throw new SkillProposalError(
      "invalid-review-status",
      `invalid --status "${input.status}" for review. Valid: accepted, rejected, superseded.`,
      { exitCode: 2 },
    );
  }
  await applyStateMigrations();
  const opened = await openStateStore();
  try {
    const proposal = readSkillProposal(opened.db, proposalId);
    if (!proposal) {
      throw new SkillProposalError(
        "not-found",
        `proposal "${proposalId}" not found.`,
        { exitCode: 3 },
      );
    }
    const stampMap = {
      accepted: "accepted_at" as const,
      rejected: "rejected_at" as const,
      superseded: "superseded_at" as const,
    };
    const expected: SkillProposalStatus[] =
      input.status === "rejected" || input.status === "superseded"
        ? ["proposed", "validated", "materialized", "accepted"]
        : ["proposed", "validated", "materialized"];
    const { proposal: updated, event } = updateSkillProposalStatus(
      opened.db,
      {
        proposal_id: proposalId,
        expected_status: expected,
        next_status: input.status,
        event_type: `review:${input.status}`,
        actor: input.actor ?? null,
        note: input.note ?? null,
        status_timestamp_column: stampMap[input.status],
        payload: input.note ? { note: input.note } : undefined,
      },
      input.now,
    );
    return { proposal: updated, event };
  } finally {
    opened.db.close();
  }
}
