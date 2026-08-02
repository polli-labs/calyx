import { deriveProvenanceClass } from "./skills";
import { parseSkillDocumentFromString } from "./skills-install";
import type {
  CuratorApplyReceipt,
  CuratorRecommendation,
  CuratorRecommendationAction,
  CuratorReport,
  CuratorStatusReport,
  SkillLifecycleStatus,
  SkillRegistryEntry,
  SkillUsageResult,
} from "./types";
import type { StateDriverDatabase } from "./state/driver";
import {
  archiveSkillContent,
  checkSkillContentSchema,
  listSkillContent,
  readSkillContent,
  listSkillWriteLog,
  restoreArchivedSkillContent,
  skillWriteLogHighWater,
} from "./state/skill-content";
import { rematerializeSkill } from "./skills-rematerialize";

export const CURATOR_CODEX_GAP_NOTE =
  "Codex skill-injection telemetry is broken upstream (POL-1834); recommendations are Claude-signal-only.";

export const DUPLICATE_DETECTION_SKIPPED_NOTE =
  "Duplicate-candidate detection skipped for git-regime skills: registry entries do not carry skill descriptions/titles without extra I/O. Consolidation candidates are computed for db-regime skills, whose content lives in skill_content.";

/**
 * POL-1834 shipped an INTERIM WARN-mining fallback panel, not a clean Codex
 * signal. The curator therefore gates exclusively on Claude-primary 'Skill'-tool
 * usage; Codex injection telemetry remains a blind spot.
 */
export const CURATOR_BLIND_SENSOR_NOTE =
  "POL-1834 shipped an interim WARN-mining fallback panel, NOT a clean signal; the curator gates on Claude-primary usage only.";

/**
 * Near-duplicate similarity threshold for `consolidate-candidate` flagging.
 * Token-overlap (Jaccard) over the normalized name + description + title. NOT an
 * engine — a deliberately simple, deterministic heuristic for recommend-only
 * surfacing; the agent/operator decides whether to actually consolidate.
 */
export const CONSOLIDATE_SIMILARITY_THRESHOLD = 0.85;

/**
 * Read-only registry shape consumed by the stateless curator. This is the
 * loosely-parsed registry (`loadSkillsRegistryLoose`); the curator never
 * touches the state store and never writes.
 */
export interface CuratorRegistryInput {
  path: string;
  version: string;
  skills: SkillRegistryEntry[];
}

/**
 * A db-regime skill descriptor used for consolidation (near-duplicate)
 * detection. Derived from `skill_content.payload["SKILL.md"]` — the curator
 * already needs the state store for apply, so this carries no extra file I/O.
 */
export interface CuratorDbSkill {
  /** Skill name (the `skill_content.skill_name`, which equals the registry id). */
  id: string;
  /** Frontmatter title (or id fallback). */
  title: string;
  /** Frontmatter description (or title fallback). */
  description: string;
}

export interface ComputeCuratorReportInput {
  registry: CuratorRegistryInput;
  usage: SkillUsageResult;
  /**
   * db-regime skill descriptors (name + frontmatter title/description). When
   * supplied, near-duplicate pairs above {@link CONSOLIDATE_SIMILARITY_THRESHOLD}
   * are flagged as `consolidate-candidate`. Absent ⇒ the legacy git-only skipped
   * note (registry entries carry no descriptions without extra I/O).
   */
  dbSkills?: CuratorDbSkill[];
  now?: () => Date;
}

export interface SummarizeCuratorStatusInput {
  registry: CuratorRegistryInput;
  usage: SkillUsageResult;
  endpoint: string;
  now?: () => Date;
}

function lifecycleStatus(entry: SkillRegistryEntry): SkillLifecycleStatus {
  return entry.status ?? "active";
}

function provenanceBreakdown(skills: SkillRegistryEntry[]): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const entry of skills) {
    const klass = deriveProvenanceClass(entry.source) ?? "unclassified";
    breakdown[klass] = (breakdown[klass] ?? 0) + 1;
  }
  return breakdown;
}

function lifecycleBreakdown(skills: SkillRegistryEntry[]): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const entry of skills) {
    const status = lifecycleStatus(entry);
    breakdown[status] = (breakdown[status] ?? 0) + 1;
  }
  return breakdown;
}

function emptySummary(): Record<CuratorRecommendationAction, number> {
  return { "low-signal": 0, "archive-candidate": 0, "duplicate-candidate": 0, "consolidate-candidate": 0 };
}

/**
 * Tokenize a string into a set of lowercase alphanumeric tokens for the
 * token-overlap (Jaccard) similarity. Short noise tokens are dropped.
 */
function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  return new Set(tokens);
}

/** Jaccard token-overlap similarity in [0,1]. */
function tokenOverlapSimilarity(left: string, right: string): number {
  const a = tokenize(left);
  const b = tokenize(right);
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Detect near-duplicate db-regime skill pairs by normalized title+description
 * token overlap. Returns one recommendation per flagged pair (the
 * lexicographically smaller id is `skill_id`, the larger is `consolidate_with`),
 * deduplicated, and only for pairs at/above {@link CONSOLIDATE_SIMILARITY_THRESHOLD}.
 * Pure: it reads the provided descriptors and returns data. NOT an engine — a
 * deterministic O(n^2) token-overlap heuristic for recommend-only surfacing.
 */
export function detectDuplicateCandidates(
  dbSkills: CuratorDbSkill[],
  statusById: Map<string, SkillLifecycleStatus>,
  threshold: number = CONSOLIDATE_SIMILARITY_THRESHOLD,
): CuratorRecommendation[] {
  const recommendations: CuratorRecommendation[] = [];
  const sorted = [...dbSkills].sort((l, r) => l.id.localeCompare(r.id));
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const left = sorted[i]!;
      const right = sorted[j]!;
      const signal = `${left.title} ${left.description}`;
      const peerSignal = `${right.title} ${right.description}`;
      const similarity = tokenOverlapSimilarity(signal, peerSignal);
      if (similarity >= threshold) {
        recommendations.push({
          skill_id: left.id,
          current_status: statusById.get(left.id) ?? "active",
          action: "consolidate-candidate",
          rationale: `Near-duplicate of "${right.id}" (token-overlap ${similarity.toFixed(2)} ≥ ${threshold}); consider \`calyx skills curator consolidate\`.`,
          use_count: 0,
          signal_basis: "none",
          consolidate_with: right.id,
          similarity: Number(similarity.toFixed(4)),
        });
      }
    }
  }
  return recommendations;
}

/**
 * Compute the STATELESS curator recommendations report. Pure: it reads the
 * registry + usage result and returns data. It never writes to the state store,
 * the registry, or any file, and it does not import the state store.
 *
 * Recommendation rules are deterministic and RECOMMEND-ONLY:
 *  - low-signal: use_count === 0 AND usage backend status === "ok".
 *  - archive-candidate: status === "deprecated" AND use_count === 0 (with a
 *    working sensor — see the blind-sensor rule below).
 *  - consolidate-candidate: near-duplicate db-regime skills (normalized
 *    title/description token-overlap ≥ threshold). Computed only when `dbSkills`
 *    is supplied; git-regime entries carry no description without extra I/O and
 *    keep the skipped note. NOT usage-gated (a content-similarity signal).
 *
 * Blind-sensor rule (RFC v2.1, applied to recommendations): when the usage
 * backend is not "ok", ZERO usage-grounded recommendations are emitted and a
 * prominent note is added. Every recommendation carries `signal_basis` so the
 * Claude-only blind spot is explicit per-row.
 */
export function computeCuratorReport(input: ComputeCuratorReportInput): CuratorReport {
  const now = input.now ?? (() => new Date());
  const observedAt = now().toISOString();
  const usage = input.usage;
  const skills = input.registry.skills;

  const usageCounts = new Map<string, number>();
  for (const row of usage.skills) {
    usageCounts.set(row.skill_name, row.use_count);
  }

  const usageBackendOk = usage.status === "ok";
  const recommendations: CuratorRecommendation[] = [];
  const notes: string[] = [...usage.notes, CURATOR_BLIND_SENSOR_NOTE];

  if (!usageBackendOk) {
    notes.unshift(
      `Usage backend ${usage.status}; usage-grounded recommendations suppressed. Provenance + lifecycle breakdown only.`,
    );
  }

  for (const entry of skills) {
    const status = lifecycleStatus(entry);
    const provenanceClass = deriveProvenanceClass(entry.source);
    const useCount = usageCounts.get(entry.id) ?? 0;

    // Blind sensor never drives an actuator (or a recommendation).
    if (!usageBackendOk) {
      continue;
    }

    if (status === "deprecated" && useCount === 0) {
      recommendations.push({
        skill_id: entry.id,
        ...(provenanceClass ? { provenance_class: provenanceClass } : {}),
        current_status: status,
        action: "archive-candidate",
        rationale: `Deprecated and observed zero Claude 'Skill' loads in the ${usage.since} window.`,
        use_count: useCount,
        signal_basis: "claude-only",
      });
      continue;
    }

    if (useCount === 0) {
      recommendations.push({
        skill_id: entry.id,
        ...(provenanceClass ? { provenance_class: provenanceClass } : {}),
        current_status: status,
        action: "low-signal",
        rationale: `Zero Claude 'Skill' loads observed in the ${usage.since} window.`,
        use_count: useCount,
        signal_basis: "claude-only",
      });
    }
  }

  // Consolidation (near-duplicate) detection: db-regime skills carry their
  // content in skill_content.payload, so the curator can compute a normalized
  // title/description token-overlap WITHOUT extra file I/O. Git-regime registry
  // entries still carry no description without extra reads — note the skip for
  // them. The blind sensor does NOT gate consolidation detection: it is a
  // content-similarity signal, not a usage-grounded recommendation.
  if (input.dbSkills && input.dbSkills.length > 0) {
    const statusById = new Map<string, SkillLifecycleStatus>(
      skills.map((entry) => [entry.id, lifecycleStatus(entry)]),
    );
    recommendations.push(...detectDuplicateCandidates(input.dbSkills, statusById));
  } else {
    notes.push(DUPLICATE_DETECTION_SKIPPED_NOTE);
  }

  const summary = emptySummary();
  for (const recommendation of recommendations) {
    summary[recommendation.action] += 1;
  }

  return {
    schema_version: "skills.curator-report/v1",
    mode: "dry-run",
    observed_at: observedAt,
    registry: { path: input.registry.path, version: input.registry.version },
    total_skills: skills.length,
    provenance_breakdown: provenanceBreakdown(skills),
    usage_backend: {
      status: usage.status,
      signal_scope: "claude-only",
      codex_gap: CURATOR_CODEX_GAP_NOTE,
    },
    recommendations,
    summary,
    notes,
  };
}

/**
 * Summarize curator status: registry size, provenance breakdown, lifecycle
 * breakdown, and usage backend status. Pure and read-only.
 */
export function summarizeCuratorStatus(input: SummarizeCuratorStatusInput): CuratorStatusReport {
  const now = input.now ?? (() => new Date());
  const observedAt = now().toISOString();
  const skills = input.registry.skills;
  const notes: string[] = [...input.usage.notes];
  if (input.usage.status !== "ok" && input.usage.unavailable_reason) {
    notes.push(input.usage.unavailable_reason);
  }

  return {
    schema_version: "skills.curator-status/v1",
    observed_at: observedAt,
    registry: { path: input.registry.path, version: input.registry.version },
    total_skills: skills.length,
    provenance_breakdown: provenanceBreakdown(skills),
    lifecycle_breakdown: lifecycleBreakdown(skills),
    usage_backend: {
      status: input.usage.status,
      endpoint: input.endpoint,
      signal_scope: "claude-only",
    },
    notes,
  };
}

/**
 * Build {@link CuratorDbSkill} descriptors from the live db-regime rows in the
 * state store, parsing each SKILL.md frontmatter for title/description. This is
 * the curator's consolidation-detection input; it reuses the store the apply
 * path already opens, so it adds NO extra file I/O.
 */
export function gatherCuratorDbSkills(db: StateDriverDatabase, hostId: string): CuratorDbSkill[] {
  const rows = listSkillContent(db, { host_id: hostId, regime: "db", limit: 2000 });
  const result: CuratorDbSkill[] = [];
  for (const row of rows) {
    const skillMd = row.payload["SKILL.md"];
    if (typeof skillMd !== "string" || skillMd.length === 0) {
      continue;
    }
    const parsed = parseSkillDocumentFromString(skillMd, row.skill_name);
    result.push({ id: row.skill_name, title: parsed.title, description: parsed.description });
  }
  return result;
}

export interface ApplyCuratorReportInput {
  db: StateDriverDatabase;
  registry: CuratorRegistryInput;
  usage: SkillUsageResult;
  hostId: string;
  /** When true, compute the receipt without mutating anything. */
  dryRun: boolean;
  now?: () => Date;
}

const CURATOR_BLOCKED_NOTE = (status: string): string =>
  `usage backend ${status}; mutations blocked per blind-sensor contract (a blind sensor never drives an auto-mutating actuator).`;

/**
 * Apply the curator's DETERMINISTIC archive recommendations (POL-1729 Slice 3).
 *
 * Contracts enforced:
 *   - BLIND-SENSOR GATE (critical): if `usage.status !== "ok"`, REFUSE all
 *     mutations and return a `blocked` receipt with NOTHING applied. A blind
 *     sensor never drives an auto-mutating actuator.
 *   - Backup-first: capture the `skill_write_log` high-water mark (the rollback
 *     cursor) BEFORE any mutation; record the deterministic pass id.
 *   - Deterministic archive ONLY: for each `archive-candidate` (deprecated +
 *     zero usage) that is NOT pinned and is a live db-regime row, recoverable-
 *     archive it (`archiveSkillContent`, payload retained) and re-materialize
 *     (prune the mirrors). Pinned candidates go to `pinned_skipped`. Stale
 *     (use_count=0 + active) is RECOMMEND-ONLY and is never applied here.
 *   - NO auto-consolidation: consolidation needs judgment; candidates are
 *     reported for the agent/operator `curator consolidate` verb.
 *   - Never-gates-a-write (#4): each archive is its own SHORT transaction
 *     (`archiveSkillContent` opens/commits per skill); there is NO long lock
 *     across the whole pass, so a free `calyx skills write` is never blocked.
 *
 * The CALLER has already opened the store. This function does its own per-skill
 * short transactions and re-materializes inside the pass.
 */
export async function applyCuratorReport(input: ApplyCuratorReportInput): Promise<CuratorApplyReceipt> {
  const now = input.now ?? (() => new Date());
  const observedAt = now().toISOString();
  const passId = `curator-${input.hostId}-${observedAt}`;
  const dryRun = input.dryRun;

  // db-regime descriptors drive consolidation detection (reported, never applied).
  const dbSkills = gatherCuratorDbSkills(input.db, input.hostId);
  const report = computeCuratorReport({
    registry: input.registry,
    usage: input.usage,
    dbSkills,
    ...(input.now ? { now: input.now } : {}),
  });
  const consolidateCandidates = report.recommendations.filter(
    (r) => r.action === "consolidate-candidate",
  );

  const baseReceipt: CuratorApplyReceipt = {
    schema_version: "skills.curator-apply/v1",
    pass_id: passId,
    host_id: input.hostId,
    observed_at: observedAt,
    dry_run: dryRun,
    rollback_cursor: null,
    archived: [],
    pinned_skipped: [],
    skipped: [],
    consolidate_candidates: consolidateCandidates,
    notes: [...report.notes],
  };

  // BLIND-SENSOR GATE: a non-ok usage backend blocks ALL mutations. Apply nothing.
  if (input.usage.status !== "ok") {
    return {
      ...baseReceipt,
      blocked: { reason: CURATOR_BLOCKED_NOTE(input.usage.status) },
      notes: [CURATOR_BLOCKED_NOTE(input.usage.status), ...baseReceipt.notes],
    };
  }

  // Migration guard: refuse if skill_content is absent/drifted (caller may also
  // check, but the apply path must never write blind).
  const schema = checkSkillContentSchema(input.db);
  if (schema.status !== "ok") {
    const reason = "skill_content schema absent/drifted; run `calyx state migrate --apply`.";
    return {
      ...baseReceipt,
      blocked: { reason },
      notes: [reason, ...baseReceipt.notes],
    };
  }

  const archiveCandidates = report.recommendations.filter((r) => r.action === "archive-candidate");

  // Backup-first: the rollback cursor is the write-log high-water mark BEFORE
  // any mutation. Rollback replays rows with event_seq > rollback_cursor.
  const rollbackCursor = skillWriteLogHighWater(input.db);

  const archived: string[] = [];
  const pinnedSkipped: string[] = [];
  const skipped: string[] = [];

  for (const candidate of archiveCandidates) {
    const row = readSkillContent(input.db, input.hostId, candidate.skill_id);
    // Only db-regime, live rows are archivable. A deprecated git-regime skill is
    // owned by its source repo — never auto-archived from the DB.
    if (!row || row.regime !== "db" || row.deleted_at !== null) {
      skipped.push(candidate.skill_id);
      continue;
    }
    if (row.pinned) {
      pinnedSkipped.push(candidate.skill_id);
      continue;
    }
    if (dryRun) {
      archived.push(candidate.skill_id);
      continue;
    }
    // SHORT transaction per skill (never-gates-a-write): archive (recoverable,
    // payload retained), then re-materialize to prune the mirrors.
    const result = archiveSkillContent(input.db, {
      host_id: input.hostId,
      skill_name: candidate.skill_id,
      summary: `curator archive (${passId})`,
      note: passId,
    });
    if (!result) {
      skipped.push(candidate.skill_id);
      continue;
    }
    await rematerializeSkill({ db: input.db, hostId: input.hostId, skillName: candidate.skill_id });
    archived.push(candidate.skill_id);
  }

  return {
    ...baseReceipt,
    rollback_cursor: rollbackCursor,
    archived,
    pinned_skipped: pinnedSkipped,
    skipped,
    notes: [
      `Deterministic apply: archived ${archived.length}, pinned-skipped ${pinnedSkipped.length}, skipped ${skipped.length}. Consolidation candidates (${consolidateCandidates.length}) are recommend-only — invoke \`calyx skills curator consolidate\`.`,
      ...baseReceipt.notes,
    ],
  };
}

export interface LatestCuratorPass {
  passId: string;
  /** event_seq just BEFORE the pass's first delete; replay event_seq > cursor restores the pass. */
  cursor: number;
}

/**
 * Derive the most recent curator apply pass on a host from the write-log
 * (`curator rollback --last`). A curator archive stamps each `delete` row's note
 * with the pass id (`curator-<host>-<iso>`). The latest pass is the
 * lexicographically-greatest such id (ISO timestamps sort correctly); its cursor
 * is `min(event_seq of that pass) - 1`, so replaying `event_seq > cursor`
 * restores exactly that pass's archives. Returns `undefined` when no curator
 * pass is recorded.
 */
export function deriveLatestCuratorPass(
  db: StateDriverDatabase,
  hostId: string,
): LatestCuratorPass | undefined {
  const rows = listSkillContent(db, {
    host_id: hostId,
    regime: "db",
    includeTombstoned: true,
    limit: 2000,
  });
  // Collect every curator delete event across the host's db-regime skills.
  const byPass = new Map<string, number[]>();
  for (const row of rows) {
    for (const entry of listSkillWriteLog(db, row.skill_name)) {
      if (
        entry.host_id === hostId &&
        entry.write_class === "delete" &&
        typeof entry.note === "string" &&
        entry.note.startsWith(`curator-${hostId}-`)
      ) {
        const seqs = byPass.get(entry.note) ?? [];
        seqs.push(entry.event_seq);
        byPass.set(entry.note, seqs);
      }
    }
  }
  if (byPass.size === 0) {
    return undefined;
  }
  const latestPassId = [...byPass.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).at(-1)!;
  const seqs = byPass.get(latestPassId)!;
  return { passId: latestPassId, cursor: Math.min(...seqs) - 1 };
}

export interface RollbackCuratorPassResult {
  schema_version: "skills.curator-rollback/v1";
  pass_id: string | null;
  host_id: string;
  /** Skill ids restored (un-archived) this rollback. */
  restored: string[];
  /** Skill ids whose delete rows were in the window but could not be restored (e.g. hard tombstone). */
  unrestorable: string[];
  /** The write-log cursor the rollback replayed FROM (event_seq > cursor). */
  from_cursor: number;
  notes: string[];
}

export interface RollbackCuratorPassInput {
  db: StateDriverDatabase;
  hostId: string;
  /** Replay every `delete` row with event_seq > cursor, restoring those skills. */
  cursor: number;
  passId?: string | null;
  now?: () => Date;
}

/**
 * Roll back a curator apply pass by replaying its `skill_write_log` window in
 * reverse (POL-1729 Slice 3). Every `delete` event with `event_seq > cursor`
 * naming a still-archived db-regime skill is un-archived
 * ({@link restoreArchivedSkillContent}) and re-materialized. Recoverable
 * archives (payload retained — the only kind the curator apply produces) restore
 * cleanly; a hard tombstone (payload cleared) is reported `unrestorable`.
 *
 * Guarantees: rollback only un-archives — it never re-deletes a skill that was
 * (re)created after the pass, and it is idempotent (a second rollback of the
 * same window restores nothing because the rows are already live).
 */
export async function rollbackCuratorPass(input: RollbackCuratorPassInput): Promise<RollbackCuratorPassResult> {
  // Collect the delete events in the window across all db-regime skills on this
  // host, newest-first (reverse replay).
  const liveAndDead = listSkillContent(input.db, {
    host_id: input.hostId,
    regime: "db",
    includeTombstoned: true,
    limit: 2000,
  });
  const restored: string[] = [];
  const unrestorable: string[] = [];

  // For each archived (deleted) db-regime skill, check whether its most recent
  // delete event falls in the rollback window.
  const archivedRows = liveAndDead.filter((r) => r.deleted_at !== null);
  for (const row of archivedRows) {
    const log = listSkillWriteLog(input.db, row.skill_name).filter(
      (entry) => entry.host_id === input.hostId,
    );
    const lastDelete = [...log].reverse().find((entry) => entry.write_class === "delete");
    if (!lastDelete || lastDelete.event_seq <= input.cursor) {
      continue;
    }
    const result = restoreArchivedSkillContent(
      input.db,
      input.hostId,
      row.skill_name,
      { note: `curator rollback${input.passId ? ` (${input.passId})` : ""}` },
    );
    if (!result) {
      unrestorable.push(row.skill_name);
      continue;
    }
    await rematerializeSkill({ db: input.db, hostId: input.hostId, skillName: row.skill_name });
    restored.push(row.skill_name);
  }

  return {
    schema_version: "skills.curator-rollback/v1",
    pass_id: input.passId ?? null,
    host_id: input.hostId,
    restored,
    unrestorable,
    from_cursor: input.cursor,
    notes: [
      `Replayed write-log window event_seq > ${input.cursor}: restored ${restored.length}, unrestorable ${unrestorable.length}.`,
      ...(unrestorable.length > 0
        ? ["unrestorable rows are hard tombstones (payload cleared); curator archives are recoverable, manual `skills delete` is not."]
        : []),
    ],
  };
}
