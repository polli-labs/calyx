import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  checkActivityIndexSchema,
  countActivityMessagesForSource,
  deleteActivityMessagesForSource,
  listActivitySourceCursors,
  openStateStore,
  readActivitySourceCursor,
  recordActivityIndexRun,
  relocateActivitySource,
  replaceActivityAttachmentsForMessages,
  upsertActivityMessages,
  upsertActivitySourceCursor,
  type ActivityAttachmentRow,
  type ActivityMessageRow,
  type ActivitySourceCursorRow,
  type StateDriverDatabase,
  type StateOpenOptions,
} from "@polli-labs/calyx-core";

import {
  ACTIVITY_RECALL_STORE_BLOCKED_RECONCILIATION,
  ACTIVITY_RECALL_STORE_BLOCKED_PARSE_WARNINGS,
  ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
  activityWarningsRequireLiveRecallRead,
  encodeActivityMessagePayload,
  isActivityRecallStoreBlocked,
  normalizeActivitySlice,
} from "./activity-messages.js";
import {
  discoverInteractiveSessionFiles,
  loadInteractiveSessionEntry,
  resolveCalyxRunsRoot,
  resolveClaudeProjectsRoot,
  resolveCodexSessionRoots,
  type InteractiveSessionFileCandidate,
} from "./interactive-activity.js";
import { codexSessionIdFromPath } from "./activity-id-resolution.js";
import type { InteractiveSessionListEntry } from "./types.js";

const DEFAULT_TAILER_INTERVAL_MS = 15_000;
const DEFAULT_DEBOUNCE_MS = 750;
/**
 * Per-tick page size: the maximum number of transcript sources fully read and
 * ingested in a single tick. This is a *page*, not a coverage cap — sources
 * beyond it are registered as `pending` and backfilled on later ticks until the
 * store has covered the whole local history (see `ActivityTailer` docs). Keeps
 * the resident tick bounded on hosts with thousands of historical transcripts.
 */
const DEFAULT_MAX_SOURCES = 500;

export interface ActivityTailerOptions {
  enabled?: boolean | undefined;
  /** Backstop reconcile interval; file-watch coalesces earlier ticks. */
  intervalMs?: number | undefined;
  /** Host tag recorded on rows and index runs. */
  host?: string | undefined;
  /** State store open options (tests inject an in-memory/temp path). */
  state?: StateOpenOptions | undefined;
  /** Home dir for transcript discovery (tests). */
  homeDir?: string | undefined;
  /** Explicit transcript roots (tests). */
  codexSessionsRoot?: string | undefined;
  codexArchivedSessionsRoot?: string | undefined;
  claudeProjectsRoot?: string | undefined;
  calyxRunsRoot?: string | undefined;
  /** Enable debounced fs.watch over the transcript roots (default true). */
  watch?: boolean | undefined;
  debounceMs?: number | undefined;
  /** Session lookback in ms; 0 (default) = no cutoff. */
  sinceMs?: number | undefined;
  /**
   * Per-tick page size: max transcript sources fully read+ingested per tick
   * (newest-pending first). Not a coverage cap — older sources are registered
   * as `pending` and backfilled across subsequent ticks (default 500).
   */
  maxSources?: number | undefined;
}

export interface ActivityTailerDependencies {
  now: () => string;
  onError?: ((error: Error) => void) | undefined;
}

export interface ActivityTailerTickResult {
  status: "ok" | "disabled" | "schema-unavailable" | "error";
  sourcesScanned: number;
  sourcesChanged: number;
  sourcesPending: number;
  messagesUpserted: number;
  bytesIngested: number;
  errors: number;
  detail?: string;
}

interface CodexSourceMoveReconcileResult {
  blockedPaths: Set<string>;
  errors: number;
}

interface ActivitySourceCursorCanonicalizeResult {
  cursors: Map<string, ActivitySourceCursorRow>;
  blockedPaths: Set<string>;
  errors: number;
}

function emptyTick(status: ActivityTailerTickResult["status"], detail?: string): ActivityTailerTickResult {
  return {
    status,
    sourcesScanned: 0,
    sourcesChanged: 0,
    sourcesPending: 0,
    messagesUpserted: 0,
    bytesIngested: 0,
    errors: status === "error" || status === "schema-unavailable" ? 1 : 0,
    ...(detail ? { detail } : {}),
  };
}

function deleteDerivedActivitySourceProjection(
  db: StateDriverDatabase,
  sourcePath: string,
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    deleteActivityMessagesForSource(db, sourcePath);
    db.prepare("DELETE FROM activity_source_cursors WHERE source_path = ?").run(sourcePath);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* preserve the primary deletion failure */
    }
    throw error;
  }
}

function canonicalizeActivitySourceCursors(
  db: StateDriverDatabase,
  candidates: readonly InteractiveSessionFileCandidate[],
  now: string,
  onError?: ((error: Error) => void) | undefined,
): ActivitySourceCursorCanonicalizeResult {
  const cursors = new Map<string, ActivitySourceCursorRow>();
  const blockedPaths = new Set<string>();
  let errors = 0;
  const groups = new Map<string, ActivitySourceCursorRow[]>();
  for (const storedCursor of listActivitySourceCursors(db)) {
    const sourcePath = path.resolve(storedCursor.source_path);
    const group = groups.get(sourcePath) ?? [];
    group.push(storedCursor);
    groups.set(sourcePath, group);
  }
  const candidatesByPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));

  for (const [sourcePath, storedCursors] of groups) {
    if (storedCursors.length === 1) {
      const storedCursor = storedCursors[0]!;
      if (sourcePath !== storedCursor.source_path) {
        relocateActivitySource(db, storedCursor.source_path, sourcePath);
      }
      cursors.set(sourcePath, {
        ...storedCursor,
        source_path: sourcePath,
      });
      continue;
    }

    // Multiple legacy path spellings can name one transcript after roots are
    // canonicalized (for example `sessions/../sessions/...` plus its absolute
    // path). The recall store is a rebuildable projection, so never choose one
    // cursor silently and never let this source-local ambiguity abort the
    // whole tick. If truth is present, collapse the aliases to one fail-closed
    // rebuild marker; the next tick re-indexes it from byte zero. If truth is
    // absent, retain every derived row but mark each cursor blocked until a
    // canonical candidate reappears.
    const collision = new Error(
      `Multiple activity source cursors normalize to one path: ${sourcePath}`,
    );
    const candidate = candidatesByPath.get(sourcePath);
    db.exec("BEGIN IMMEDIATE");
    try {
      if (candidate) {
        const projectionPaths = new Set([
          sourcePath,
          ...storedCursors.map((cursor) => cursor.source_path),
        ]);
        for (const projectionPath of projectionPaths) {
          deleteActivityMessagesForSource(db, projectionPath);
        }
        const deleteCursor = db.prepare(
          "DELETE FROM activity_source_cursors WHERE source_path = ?",
        );
        for (const storedCursor of storedCursors) {
          deleteCursor.run(storedCursor.source_path);
        }
        const blockedCursor: ActivitySourceCursorRow = {
          source_path: sourcePath,
          backend: candidate.backend,
          byte_offset: 0,
          next_line: 1,
          resume_offset: 0,
          resume_line: 1,
          size_bytes: candidate.size,
          mtime_ms: candidate.mtimeMs,
          content_hash: ACTIVITY_RECALL_STORE_BLOCKED_RECONCILIATION,
          classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
          message_count: 0,
          updated_at: now,
        };
        upsertActivitySourceCursor(db, blockedCursor);
        cursors.set(sourcePath, blockedCursor);
      } else {
        const blockCursor = db.prepare(
          `UPDATE activity_source_cursors
             SET content_hash = ?, updated_at = ?
           WHERE source_path = ?`,
        );
        for (const storedCursor of storedCursors) {
          blockCursor.run(
            ACTIVITY_RECALL_STORE_BLOCKED_RECONCILIATION,
            now,
            storedCursor.source_path,
          );
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* preserve the primary canonicalization failure */
      }
      throw error;
    }

    blockedPaths.add(sourcePath);
    errors += 1;
    try {
      onError?.(new Error(
        `activity tailer source cursor canonicalization failed (${storedCursors
          .map((cursor) => cursor.source_path)
          .join(", ")} -> ${sourcePath}): ${collision.message}`,
        { cause: collision },
      ));
    } catch {
      // Diagnostics must not widen one bad source into a whole-tick failure.
    }
  }
  return { cursors, blockedPaths, errors };
}

/**
 * Per-host transcript tailer (POL-1838, recall-plane slice 1). Runs inside
 * `calyx run serve`. It watches the harness-native transcript roots, resumes
 * each source from its persisted byte cursor (never re-loading whole files in
 * steady state), feeds the bytes through the one shared streaming reader +
 * semantic-origin normalizer (`normalizeActivitySlice`), strips attachments to
 * `att:sha256:` refs, and upserts the normalized rows idempotently on
 * `content_hash`. The store is derived and rebuildable from transcripts; truth
 * stays in the files. No shipping, embeddings, or redaction — those are later
 * slices (POL-1839 / POL-1840).
 *
 * This is not a second daemon, scheduler, or hook dependency. It mirrors the
 * monitor-evaluator lifecycle: an interval backstop plus a debounced file-watch
 * that coalesces earlier ticks. A single tick is in-flight at a time.
 *
 * Coverage is the whole local history, not just the newest window. Archived
 * Codex sessions remain outside user-facing recent/list/latest projection but
 * are part of this derived recall index. When Codex archives or restores a
 * transcript, the tailer proves the same basename + activity identity and
 * transactionally relocates its cursor and projected rows. Each tick cheaply
 * discovers *every* transcript file, then fully reads+ingests a bounded **page**
 * (`maxSources`, default 500) of the sources that still need work
 * (no cursor, an un-ingested tail, or a classifier bump), newest-pending first.
 * Discovered sources beyond the page are registered as `pending` cursors so a
 * read reports `behind` (catching up), never `absent` (silently unindexed).
 * Because an ingested source drops out of the work set, successive ticks rotate
 * the page across the backlog until the store is caught up, then steady-state
 * on whatever is freshest — so a daemon started against a host with thousands
 * of prior transcripts eventually covers all of them while staying bounded per
 * tick. The store stays derived and rebuildable from the files.
 */
export class ActivityTailer {
  private readonly options: ActivityTailerOptions & {
    enabled: boolean;
    intervalMs: number;
    watch: boolean;
    debounceMs: number;
    sinceMs: number;
    maxSources: number;
    homeDir: string;
    codexSessionsRoot: string;
    codexArchivedSessionsRoot: string;
    claudeProjectsRoot: string;
    calyxRunsRoot: string;
  };
  private readonly deps: ActivityTailerDependencies;
  private timer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private watchers: FSWatcher[] = [];
  private inFlight: Promise<ActivityTailerTickResult> | null = null;

  constructor(options: ActivityTailerOptions, deps: ActivityTailerDependencies) {
    const homeDir = options.homeDir ?? homedir();
    const codexRoots = resolveCodexSessionRoots({
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      ...(options.codexSessionsRoot !== undefined
        ? { codexSessionsRoot: options.codexSessionsRoot }
        : {}),
      ...(options.codexArchivedSessionsRoot !== undefined
        ? { codexArchivedSessionsRoot: options.codexArchivedSessionsRoot }
        : {}),
    });
    const claudeProjectsRoot = resolveClaudeProjectsRoot({
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      ...(options.claudeProjectsRoot !== undefined
        ? { claudeProjectsRoot: options.claudeProjectsRoot }
        : {}),
    });
    const calyxRunsRoot = resolveCalyxRunsRoot({
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      ...(options.calyxRunsRoot !== undefined ? { calyxRunsRoot: options.calyxRunsRoot } : {}),
    });
    this.options = {
      ...options,
      enabled: options.enabled ?? true,
      intervalMs: options.intervalMs ?? DEFAULT_TAILER_INTERVAL_MS,
      watch: options.watch ?? true,
      debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      sinceMs: options.sinceMs ?? 0,
      maxSources: options.maxSources ?? DEFAULT_MAX_SOURCES,
      homeDir,
      codexSessionsRoot: codexRoots.sessionsRoot,
      codexArchivedSessionsRoot: codexRoots.archivedSessionsRoot,
      claudeProjectsRoot,
      calyxRunsRoot,
    };
    this.deps = deps;
  }

  start(): void {
    if (!this.options.enabled || this.timer) return;
    void this.tickOnce();
    this.timer = setInterval(() => {
      void this.tickOnce();
    }, this.options.intervalMs);
    this.timer.unref?.();
    if (this.options.watch) {
      this.startWatchers();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        /* best effort */
      }
    }
    this.watchers = [];
  }

  private watchedRoots(): string[] {
    return [
      this.options.codexSessionsRoot,
      this.options.codexArchivedSessionsRoot,
      this.options.claudeProjectsRoot,
      this.options.calyxRunsRoot,
    ];
  }

  private startWatchers(): void {
    for (const root of this.watchedRoots()) {
      try {
        const watcher = watch(root, { recursive: true, persistent: false }, () => {
          this.scheduleDebouncedTick();
        });
        watcher.on("error", () => {
          /* a transient watch error must not crash the daemon */
        });
        this.watchers.push(watcher);
      } catch {
        // Root may not exist yet, or recursive watch may be unsupported here;
        // the interval backstop still reconciles. Degrade quietly.
      }
    }
  }

  private scheduleDebouncedTick(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.tickOnce();
    }, this.options.debounceMs);
    this.debounceTimer.unref?.();
  }

  async tickOnce(): Promise<ActivityTailerTickResult> {
    if (!this.options.enabled) return emptyTick("disabled");
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runTick()
      .catch((err) => this.handleTickError(err))
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private handleTickError(err: unknown): ActivityTailerTickResult {
    const cause = err instanceof Error ? err : new Error(String(err));
    const error = new Error(`activity tailer tick failed: ${cause.message}`, { cause });
    try {
      this.deps.onError?.(error);
    } catch {
      // Logging hooks must not turn a bounded tailer failure into a daemon crash.
    }
    return emptyTick("error", error.message);
  }

  private async runTick(trigger = "interval"): Promise<ActivityTailerTickResult> {
    const opened = await openStateStore(this.options.state ?? {});
    const startedAt = this.deps.now();
    try {
      const schema = checkActivityIndexSchema(opened.db);
      if (schema.status !== "ok") {
        return emptyTick("schema-unavailable", schema.findings.map((f) => f.detail).join("; "));
      }

      // Cheap discovery of the whole local history (no per-file prefix read),
      // then select a bounded page of sources that still need work. Newest
      // first, so the steady state keeps active sessions fresh and the backlog
      // backfills oldest-last across ticks.
      const candidates = (await discoverInteractiveSessionFiles({
        homeDir: this.options.homeDir,
        ...(this.options.codexSessionsRoot ? { codexSessionsRoot: this.options.codexSessionsRoot } : {}),
        ...(this.options.codexArchivedSessionsRoot
          ? { codexArchivedSessionsRoot: this.options.codexArchivedSessionsRoot }
          : {}),
        ...(this.options.claudeProjectsRoot ? { claudeProjectsRoot: this.options.claudeProjectsRoot } : {}),
        ...(this.options.calyxRunsRoot ? { calyxRunsRoot: this.options.calyxRunsRoot } : {}),
        ...(this.options.host ? { host: this.options.host } : {}),
        includeCalyxRuns: true,
        includeCodexArchivedSessions: true,
        sinceMs: this.options.sinceMs,
      })).map((candidate) => ({
        ...candidate,
        path: path.resolve(candidate.path),
      }));

      const canonicalization = canonicalizeActivitySourceCursors(
        opened.db,
        candidates,
        startedAt,
        this.deps.onError,
      );
      const cursors = canonicalization.cursors;
      const reconciliation = await this.reconcileCodexSourceMoves(opened.db, candidates, cursors);
      const blockedPaths = new Set([
        ...canonicalization.blockedPaths,
        ...reconciliation.blockedPaths,
      ]);
      const blockedCandidates = candidates.filter((candidate) => (
        blockedPaths.has(path.resolve(candidate.path))
      ));
      const dirty = candidates.filter((candidate) => (
        !blockedPaths.has(path.resolve(candidate.path))
        && this.needsIngest(candidate, cursors.get(candidate.path))
      ));
      const page = dirty.slice(0, Math.max(this.options.maxSources, 0));
      const pagePaths = new Set(page.map((candidate) => candidate.path));
      const backlog = dirty.filter((candidate) => !pagePaths.has(candidate.path));

      let sourcesChanged = 0;
      let pagePending = 0;
      let messagesUpserted = 0;
      let bytesIngested = 0;
      let errors = canonicalization.errors + reconciliation.errors;
      let indexedThrough: string | undefined;

      for (const candidate of page) {
        try {
          const session = await loadInteractiveSessionEntry(candidate, { host: this.options.host });
          if (!session) {
            // File vanished between discovery and read; nothing to ingest.
            continue;
          }
          const result = await this.ingestSource(opened.db, session);
          if (result.changed) sourcesChanged += 1;
          if (result.pending) pagePending += 1;
          messagesUpserted += result.messagesUpserted;
          bytesIngested += result.bytesIngested;
          if (result.observedAt && (!indexedThrough || result.observedAt > indexedThrough)) {
            indexedThrough = result.observedAt;
          }
        } catch (err) {
          errors += 1;
          try {
            this.deps.onError?.(
              new Error(
                `activity tailer source ingest failed (${candidate.path}): ${
                  err instanceof Error ? err.message : String(err)
                }`,
              ),
            );
          } catch {
            /* swallow */
          }
        }
      }

      // Register the un-paged backlog as `pending` cursors so reads report
      // `behind` (catching up), not `absent` (silently unindexed). Only sources
      // without an existing cursor are written; cursors with real progress are
      // never clobbered. The whole backlog (these + already-cursored tails) is
      // pending after this tick.
      const finishedAt = this.deps.now();
      this.registerPendingSources(opened.db, backlog, cursors, finishedAt);
      this.quarantineBlockedSources(opened.db, blockedCandidates, cursors, finishedAt);
      // Quarantine is a durable store-blocked state, not ordinary catch-up.
      // Its error receipt stays visible without making sources_pending a
      // permanently non-draining backlog counter.
      const sourcesPending = pagePending + backlog.length;

      recordActivityIndexRun(opened.db, {
        run_id: `${finishedAt}:${trigger}`,
        ...(this.options.host ? { host: this.options.host } : {}),
        trigger,
        started_at: startedAt,
        finished_at: finishedAt,
        status: errors > 0 ? "error" : "ok",
        sources_scanned: page.length,
        sources_changed: sourcesChanged,
        sources_pending: sourcesPending,
        messages_upserted: messagesUpserted,
        bytes_ingested: bytesIngested,
        ...(indexedThrough ? { indexed_through: indexedThrough } : {}),
        classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
        ...(errors > 0 ? { error: `${errors} source(s) failed` } : {}),
      });

      return {
        status: "ok",
        sourcesScanned: page.length,
        sourcesChanged,
        sourcesPending,
        messagesUpserted,
        bytesIngested,
        errors,
      };
    } finally {
      opened.db.close();
    }
  }

  /**
   * Preserve one logical source while Codex moves its rollout between the
   * active and recoverable archive roots. The basename contains the Codex
   * session id, so a move is accepted only when the old path is absent, the
   * roots are opposite, the basename is unchanged, and the transcript's
   * canonical identity agrees with both filename and persisted cursor.
   */
  private async reconcileCodexSourceMoves(
    db: StateDriverDatabase,
    candidates: readonly InteractiveSessionFileCandidate[],
    cursors: Map<string, ActivitySourceCursorRow>,
  ): Promise<CodexSourceMoveReconcileResult> {
    const blockedPaths = new Set<string>();
    let errors = 0;
    const blockSources = (sourcePaths: readonly string[], cause: unknown): void => {
      const normalizedPaths = sourcePaths.map((sourcePath) => path.resolve(sourcePath));
      for (const sourcePath of normalizedPaths) blockedPaths.add(sourcePath);
      errors += 1;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      try {
        this.deps.onError?.(new Error(
          `activity tailer Codex source reconcile failed (${normalizedPaths.join(", ")}): ${error.message}`,
          { cause: error },
        ));
      } catch {
        // Reconcile diagnostics must not widen one bad source into a whole-tick failure.
      }
    };

    const activeRoot = path.resolve(this.options.codexSessionsRoot);
    const archiveRoot = path.resolve(this.options.codexArchivedSessionsRoot);
    const rootKind = (sourcePath: string): "active" | "archive" | undefined => {
      const absolute = path.resolve(sourcePath);
      const activeRelative = path.relative(activeRoot, absolute);
      if (activeRelative === "" || (!activeRelative.startsWith("..") && !path.isAbsolute(activeRelative))) {
        return "active";
      }
      const archiveRelative = path.relative(archiveRoot, absolute);
      if (archiveRelative === "" || (!archiveRelative.startsWith("..") && !path.isAbsolute(archiveRelative))) {
        return "archive";
      }
      return undefined;
    };

    const codexCandidates = candidates.filter((candidate) => (
      candidate.backend === "codex" && rootKind(candidate.path) !== undefined
    ));
    const discoveredPaths = new Set(codexCandidates.map((candidate) => path.resolve(candidate.path)));
    const sourceIdentity = (sourcePath: string): string => (
      codexSessionIdFromPath(sourcePath) ?? path.basename(sourcePath)
    );
    const byFilenameId = new Map<string, InteractiveSessionFileCandidate[]>();
    for (const candidate of codexCandidates) {
      const filenameId = sourceIdentity(candidate.path);
      const peers = byFilenameId.get(filenameId) ?? [];
      peers.push(candidate);
      byFilenameId.set(filenameId, peers);
    }
    for (const [filenameId, peers] of byFilenameId) {
      const roots = new Set(peers.map((candidate) => rootKind(candidate.path)));
      if (roots.has("active") && roots.has("archive")) {
        blockSources(
          peers.map((candidate) => candidate.path),
          new Error(`Codex activity source exists in active and archive roots: ${filenameId}`),
        );
      }
    }

    const orphanCursors = [...cursors.values()].filter((cursor) => (
      cursor.backend === "codex"
      && rootKind(cursor.source_path) !== undefined
      && !discoveredPaths.has(path.resolve(cursor.source_path))
    ));
    // A collision marker belongs to a filesystem conflict, not to either
    // surviving path forever. Once exactly one opposite-root peer remains and
    // the marked path is proved absent, discard that rebuildable orphan so the
    // survivor can be re-indexed cleanly on this tick.
    for (const cursor of orphanCursors) {
      if (cursor.content_hash !== ACTIVITY_RECALL_STORE_BLOCKED_RECONCILIATION) continue;
      const peers = codexCandidates.filter((candidate) => (
        sourceIdentity(candidate.path) === sourceIdentity(cursor.source_path)
        && rootKind(candidate.path) !== rootKind(cursor.source_path)
        && !blockedPaths.has(path.resolve(candidate.path))
      ));
      if (peers.length !== 1) continue;
      try {
        await stat(cursor.source_path);
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          deleteDerivedActivitySourceProjection(db, cursor.source_path);
          cursors.delete(cursor.source_path);
          continue;
        }
        blockSources([peers[0]!.path], error);
      }
    }
    const orphanByBasename = new Map<string, ActivitySourceCursorRow[]>();
    for (const cursor of orphanCursors.filter((candidate) => cursors.has(candidate.source_path))) {
      const basename = path.basename(cursor.source_path);
      const peers = orphanByBasename.get(basename) ?? [];
      peers.push(cursor);
      orphanByBasename.set(basename, peers);
    }

    for (const candidate of codexCandidates) {
      const targetPath = path.resolve(candidate.path);
      if (blockedPaths.has(targetPath)) continue;
      if (cursors.has(targetPath)) continue;
      const oldCandidates = (orphanByBasename.get(path.basename(targetPath)) ?? []).filter((cursor) => (
        rootKind(cursor.source_path) !== rootKind(targetPath)
      ));
      if (oldCandidates.length === 0) continue;
      try {
        if (oldCandidates.length > 1) {
          throw new Error(`Multiple orphan cursors could relocate to Codex source: ${targetPath}`);
        }
        const oldCursor = oldCandidates[0]!;
        try {
          await stat(oldCursor.source_path);
          throw new Error(`Codex source relocation refused because old path still exists: ${oldCursor.source_path}`);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
            throw error;
          }
        }

        const oldFilenameId = codexSessionIdFromPath(oldCursor.source_path);
        const newFilenameId = codexSessionIdFromPath(targetPath);
        if (!oldFilenameId || oldFilenameId !== newFilenameId) {
          throw new Error(`Codex source relocation basename does not prove one session: ${targetPath}`);
        }
        const session = await loadInteractiveSessionEntry(candidate, {
          ...(this.options.host ? { host: this.options.host } : {}),
          failClosed: true,
        });
        const filenameActivityId = `interactive:codex:${newFilenameId}`;
        if (!session || session.run_id !== filenameActivityId) {
          throw new Error(`Codex source relocation transcript identity disagrees with basename: ${targetPath}`);
        }
        if (oldCursor.activity_id && oldCursor.activity_id !== session.run_id) {
          throw new Error(`Codex source relocation transcript identity disagrees with cursor: ${targetPath}`);
        }

        relocateActivitySource(db, oldCursor.source_path, targetPath);
        cursors.delete(oldCursor.source_path);
        cursors.set(targetPath, { ...oldCursor, source_path: targetPath });
      } catch (error) {
        blockSources([targetPath], error);
      }
    }
    return { blockedPaths, errors };
  }

  /**
   * A source needs ingest work when it has no cursor (never scanned, including
   * a `pending` placeholder), its committed byte offset differs from the
   * current file size (an un-ingested tail or a truncation/rewrite), or the
   * classifier version was bumped since it was last ingested. Sources that are
   * fully consumed at the current classifier drop out of the work set, so the
   * page rotates across the backlog over successive ticks.
   */
  private needsIngest(
    candidate: InteractiveSessionFileCandidate,
    cursor: ActivitySourceCursorRow | undefined,
  ): boolean {
    if (!cursor) return true;
    if (cursor.content_hash === ACTIVITY_RECALL_STORE_BLOCKED_RECONCILIATION) return true;
    if (cursor.classifier_version !== ACTIVITY_MESSAGE_CLASSIFIER_VERSION) return true;
    return cursor.byte_offset !== candidate.size;
  }

  /**
   * Persist a fail-closed marker for sources that reconciliation cannot prove.
   * Existing projection rows remain rebuildable evidence but are never served
   * while the marker is present. When the filesystem conflict is removed,
   * `needsIngest` forces one clean rebuild that clears the marker.
   */
  private quarantineBlockedSources(
    db: StateDriverDatabase,
    blocked: readonly InteractiveSessionFileCandidate[],
    cursors: ReadonlyMap<string, ActivitySourceCursorRow>,
    now: string,
  ): void {
    if (blocked.length === 0) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const candidate of blocked) {
        const cursor = cursors.get(candidate.path);
        upsertActivitySourceCursor(db, {
          source_path: candidate.path,
          backend: candidate.backend,
          ...(cursor?.activity_id ? { activity_id: cursor.activity_id } : {}),
          byte_offset: cursor?.byte_offset ?? 0,
          next_line: cursor?.next_line ?? 1,
          resume_offset: cursor?.resume_offset ?? 0,
          resume_line: cursor?.resume_line ?? 1,
          size_bytes: candidate.size,
          mtime_ms: candidate.mtimeMs,
          content_hash: ACTIVITY_RECALL_STORE_BLOCKED_RECONCILIATION,
          classifier_version: cursor?.classifier_version ?? ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
          message_count: cursor?.message_count ?? 0,
          updated_at: now,
          ...(cursor?.last_indexed_at ? { last_indexed_at: cursor.last_indexed_at } : {}),
        });
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* preserve the primary quarantine failure */
      }
      throw error;
    }
  }

  /**
   * Write `pending` placeholder cursors (byte_offset 0, no rows yet) for
   * discovered sources that have no cursor at all, so freshness counts them as
   * pending instead of leaving them invisible/`absent`. Sources that already
   * have a cursor keep their real progress untouched. Batched in one
   * transaction since the first ticks after a cold start can register a large
   * backlog. Returns the number of placeholders written.
   */
  private registerPendingSources(
    db: StateDriverDatabase,
    backlog: readonly InteractiveSessionFileCandidate[],
    cursors: ReadonlyMap<string, ActivitySourceCursorRow>,
    now: string,
  ): number {
    const toRegister = backlog.filter((candidate) => !cursors.has(candidate.path));
    if (toRegister.length === 0) return 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const candidate of toRegister) {
        upsertActivitySourceCursor(db, {
          source_path: candidate.path,
          backend: candidate.backend,
          byte_offset: 0,
          next_line: 1,
          resume_offset: 0,
          resume_line: 1,
          size_bytes: candidate.size,
          mtime_ms: candidate.mtimeMs,
          classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
          message_count: 0,
          updated_at: now,
        });
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* swallow secondary error */
      }
      throw err;
    }
    return toRegister.length;
  }

  private async ingestSource(
    db: StateDriverDatabase,
    session: InteractiveSessionListEntry,
  ): Promise<{
    changed: boolean;
    pending: boolean;
    messagesUpserted: number;
    bytesIngested: number;
    observedAt?: string;
  }> {
    const sourcePath = session.session_path;
    let size: number;
    let mtimeMs: number;
    try {
      const info = await stat(sourcePath);
      size = info.size;
      mtimeMs = info.mtimeMs;
    } catch {
      // Source vanished between listing and ingest; nothing to do this tick.
      return { changed: false, pending: false, messagesUpserted: 0, bytesIngested: 0 };
    }

    const cursor = readActivitySourceCursor(db, sourcePath);
    const classifierChanged =
      cursor !== undefined && cursor.classifier_version !== ACTIVITY_MESSAGE_CLASSIFIER_VERSION;
    const truncated = cursor !== undefined && cursor.byte_offset > size;
    const quarantineReleased =
      cursor?.content_hash === ACTIVITY_RECALL_STORE_BLOCKED_RECONCILIATION;
    const reset = classifierChanged || truncated || quarantineReleased;
    if (reset) {
      // Re-ingest from scratch: the prior projection is stale or the file was
      // rewritten. Evict old rows so the store stays a faithful mirror.
      deleteActivityMessagesForSource(db, sourcePath);
    }

    // `committedOffset` is the last fully-consumed boundary (drives freshness and
    // the no-new-bytes skip). `readFrom*` is the turn-aware re-read start: the
    // opening line of the last (possibly in-flight) turn, so every slice begins
    // at a turn boundary and turn ids are assigned with full context — never
    // mid-turn (POL-1838 adversarial finding P1-2).
    const committedOffset = reset || !cursor ? 0 : cursor.byte_offset;
    const readFromOffset = reset || !cursor ? 0 : cursor.resume_offset;
    const readFromLine = reset || !cursor ? 1 : cursor.resume_line;
    const now = this.deps.now();

    if (committedOffset >= size && !reset) {
      // No new bytes. Refresh the observed size/mtime so freshness stays honest
      // without re-reading the file; preserve the turn-aware resume point.
      if (!cursor || cursor.size_bytes !== size || cursor.mtime_ms !== mtimeMs) {
        upsertActivitySourceCursor(db, {
          source_path: sourcePath,
          backend: session.backend,
          activity_id: session.run_id,
          byte_offset: cursor?.byte_offset ?? committedOffset,
          next_line: cursor?.next_line ?? 1,
          resume_offset: cursor?.resume_offset ?? readFromOffset,
          resume_line: cursor?.resume_line ?? readFromLine,
          size_bytes: size,
          mtime_ms: mtimeMs,
          ...(cursor?.content_hash ? { content_hash: cursor.content_hash } : {}),
          classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
          message_count: cursor?.message_count ?? 0,
          updated_at: now,
          ...(cursor?.last_indexed_at ? { last_indexed_at: cursor.last_indexed_at } : {}),
        });
      }
      return { changed: false, pending: false, messagesUpserted: 0, bytesIngested: 0 };
    }

    const startEventIndex = reset ? 0 : countStoredMessagesBeforeLine(db, sourcePath, readFromLine);
    const slice = await normalizeActivitySlice({
      session,
      startOffset: readFromOffset,
      startLine: readFromLine,
      startEventIndex,
    });
    const storeBlocked = (!reset && isActivityRecallStoreBlocked(cursor?.content_hash))
      || activityWarningsRequireLiveRecallRead(slice.warnings);

    const rows: ActivityMessageRow[] = slice.messages.map((entry) => {
      const message = entry.message;
      const attachmentRefs = (message.attachments ?? [])
        .map((a) => a.ref)
        .filter((ref): ref is string => typeof ref === "string");
      const origin = message.role;
      const text = message.text ?? "";
      const turnId = message.turn_id ?? null;
      const attachmentRefsJson = JSON.stringify(attachmentRefs);
      const payloadJson = encodeActivityMessagePayload(message);
      return {
        message_id: message.id,
        activity_id: message.activity_id,
        turn_id: turnId,
        seq: entry.sourceLine,
        origin,
        text,
        host: message.activity.host ?? this.options.host ?? null,
        backend: message.activity.backend,
        source_path: sourcePath,
        source_offset: entry.sourceByteOffset,
        content_hash: contentHashForRow({
          origin,
          text,
          turnId,
          attachmentRefsJson,
          timestamp: message.timestamp ?? null,
          payloadJson,
          classifierVersion: message.classification.classifier_version,
          seq: entry.sourceLine,
        }),
        classifier_version: message.classification.classifier_version,
        attachment_refs: attachmentRefsJson,
        observed_at: now,
        timestamp: message.timestamp ?? null,
        payload_json: payloadJson,
      };
    });
    const attachmentRows: ActivityAttachmentRow[] = slice.messages.flatMap((entry) => {
      const message = entry.message;
      return (message.attachments ?? []).map((attachment) => ({
        attachment_id: `${message.id}:att:${attachment.sha256}`,
        message_id: message.id,
        origin: message.role,
        sha256: attachment.sha256,
        mime: attachment.mime_type,
        byte_size: attachment.byte_size,
        observed_at: now,
      }));
    });

    const { upserted } = upsertActivityMessages(db, rows);
    replaceActivityAttachmentsForMessages(db, rows.map((row) => row.message_id), attachmentRows);
    // Genuinely-new committed bytes (excludes the re-read open-turn overlap).
    const bytesIngested = Math.max(0, slice.resume.byteOffset - committedOffset);
    const pending = slice.resume.byteOffset < size;

    // Next tick re-reads from the opening line of the last turn in this slice, so
    // that turn is always projected with full context. Falls back to the
    // committed boundary when the tail has no turn (pre-first-turn preamble).
    const turnResume = lastTurnResume(slice.messages);
    const resumeOffset = turnResume?.offset ?? slice.resume.byteOffset;
    const resumeLine = turnResume?.line ?? slice.resume.nextLine;

    upsertActivitySourceCursor(db, {
      source_path: sourcePath,
      backend: session.backend,
      activity_id: session.run_id,
      byte_offset: slice.resume.byteOffset,
      next_line: slice.resume.nextLine,
      resume_offset: resumeOffset,
      resume_line: resumeLine,
      size_bytes: size,
      mtime_ms: mtimeMs,
      content_hash: storeBlocked ? ACTIVITY_RECALL_STORE_BLOCKED_PARSE_WARNINGS : null,
      classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
      message_count: countActivityMessagesForSource(db, sourcePath),
      updated_at: now,
      last_indexed_at: now,
    });

    return {
      changed: slice.resume.byteOffset > committedOffset,
      pending,
      messagesUpserted: upserted,
      bytesIngested,
      observedAt: new Date(mtimeMs).toISOString(),
    };
  }
}

/**
 * Resume bookmark for the last (possibly in-flight) turn in a slice: the byte
 * offset and 1-based line of that turn's opening message. Returns undefined when
 * the slice's tail has no turn id (e.g. pre-first-turn session preamble), in
 * which case the caller resumes from the committed boundary instead.
 */
function lastTurnResume(
  messages: ReadonlyArray<{ message: { turn_id?: string }; sourceByteOffset: number; sourceLine: number }>,
): { offset: number; line: number } | undefined {
  let lastTurnId: string | undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const turnId = messages[i]!.message.turn_id;
    if (turnId) {
      lastTurnId = turnId;
      break;
    }
  }
  if (!lastTurnId) return undefined;
  let best: { offset: number; line: number } | undefined;
  for (const entry of messages) {
    if (entry.message.turn_id === lastTurnId && (!best || entry.sourceLine < best.line)) {
      best = { offset: entry.sourceByteOffset, line: entry.sourceLine };
    }
  }
  return best;
}

function countStoredMessagesBeforeLine(
  db: StateDriverDatabase,
  sourcePath: string,
  sourceLine: number,
): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM activity_messages WHERE source_path = ? AND seq < ?")
    .get(sourcePath, sourceLine) as { count?: number | bigint } | undefined;
  return Number(row?.count ?? 0);
}

function contentHashForRow(input: {
  origin: string;
  text: string;
  turnId: string | null;
  attachmentRefsJson: string;
  timestamp: string | null;
  payloadJson: string;
  classifierVersion: string;
  seq: number;
}): string {
  const canonical = JSON.stringify([
    input.origin,
    input.text,
    input.turnId,
    input.attachmentRefsJson,
    input.timestamp,
    input.payloadJson,
    input.classifierVersion,
    input.seq,
  ]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
