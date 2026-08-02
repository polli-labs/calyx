/**
 * @polli-labs/calyx-runner — Worktree lifecycle manager.
 *
 * Handles creation, locking, and cleanup of git worktrees for isolated
 * runner execution. Lock semantics prevent concurrent use of the same
 * worktree path.
 *
 * Lock protocol:
 *   - DB lease: `worktree:<host>:<path>` when a caller supplies a lease manager
 *   - Lock file: `<worktree-path>/.calyx-runner.lock`
 *   - Lock content: JSON with run_id, pid, acquired_at
 *   - Stale detection: lock_timeout_ms from config (default 30 min)
 *   - steal_lock: forcibly acquire even if locked (with warning)
 *
 * @see docs/architecture/async-runner-vnext-contracts.md
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { WorktreeSpec } from "./types.js";

const LOCK_FILENAME = ".calyx-runner.lock";
const DEFAULT_LOCK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_GIT_REPO_ANCESTOR_DEPTH = 64;
const REMOTE_TRACKING_PREFIX = "refs/remotes/";

// POL-1826: worktree-acquisition contention (held lease / live lock) is
// transient and soft-degradable, so the runner retries a bounded number of
// times with exponential backoff before surfacing an infra_error.
const DEFAULT_CONTENTION_RETRY_ATTEMPTS = 3;
const DEFAULT_CONTENTION_BASE_DELAY_MS = 500;
const DEFAULT_CONTENTION_MAX_DELAY_MS = 5_000;

// A worktree ref that is a full commit object name (SHA-1 or SHA-256) can be
// missing from a partial clone; we attempt a direct fetch before dead-ending
// (POL-1826). Abbreviated SHAs are excluded — remotes only serve full names.
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

type GitExecOptions = { cwd?: string };
type GitExecResult = { code: number; stdout: string; stderr: string };
type GitExecutor = (
  cmd: string,
  args: string[],
  options?: GitExecOptions,
) => Promise<GitExecResult>;

/** Lock file content written to worktree directory. */
export interface WorktreeLock {
  run_id: string;
  pid: number;
  acquired_at: string;
}

export interface WorktreeLease {
  key: string;
  holder_activity_id: string;
  ttl_ms: number;
  expires_at: string;
}

export interface WorktreeLeaseAcquireInput {
  path: string;
  run_id: string;
  ttl_ms: number;
  steal_lock: boolean;
}

export interface WorktreeLeaseAcquireResult {
  acquired: boolean;
  lease?: WorktreeLease | undefined;
  error?: string | undefined;
}

export interface WorktreeLeaseManager {
  acquire(input: WorktreeLeaseAcquireInput): Promise<WorktreeLeaseAcquireResult>;
  renew?(lease: WorktreeLease): Promise<WorktreeLease>;
  release?(lease: WorktreeLease): Promise<void>;
}

/** Result of a worktree acquisition attempt. */
export interface WorktreeAcquireResult {
  acquired: boolean;
  path: string;
  lock?: WorktreeLock;
  lease?: WorktreeLease;
  stale_lock_removed?: boolean;
  stolen?: boolean;
  error?: string;
}

/** Bounded retry policy for transient worktree-acquisition contention. */
export interface WorktreeContentionRetry {
  /** Total acquisition attempts including the first (clamped to >= 1). Default 3. */
  attempts?: number;
  /** Injected sleep for tests. Default: real setTimeout. The backoff schedule is fixed. */
  sleep?: (ms: number) => Promise<void>;
}

/** Options for worktree operations. */
export interface WorktreeManagerOptions {
  base_path: string;
  lock_timeout_ms?: number;
  resolve_repo?: (slug: string) => Promise<string>;
  /** Optional authoritative DB lease; the lock file remains a crash-safety belt. */
  lease?: WorktreeLeaseManager;
  /** Injected shell executor for testability. Default: real exec. */
  exec?: GitExecutor;
  /**
   * Bounded retry for transient lease/lock contention. Defaults are applied
   * when omitted; pass `{ attempts: 1 }` to disable retry for a single-shot
   * acquisition.
   */
  contention_retry?: WorktreeContentionRetry;
}

interface RemoteBranchRef {
  remote: string;
  branch: string;
  fetchRefspec: string;
}

/**
 * Resolve the full worktree path from spec and base_path.
 *
 * Returns `spec.path` when explicit, otherwise `<base_path>/<spec.branch>`.
 * When neither is set the function returns `base_path` so callers building
 * structured error responses still have a usable identifier; the branch
 * presence check for managed/create modes lives in `acquireWorktree`.
 */
export function resolveWorktreePath(spec: WorktreeSpec, base_path: string): string {
  if (spec.path) return spec.path;
  if (spec.branch) return join(base_path, spec.branch);
  return base_path;
}

/** Read an existing lock file, or return null if none exists. */
async function readLock(lockPath: string): Promise<WorktreeLock | null> {
  try {
    const raw = await readFile(lockPath, "utf-8");
    return JSON.parse(raw) as WorktreeLock;
  } catch {
    return null;
  }
}

/** Check whether a lock is stale based on timeout. */
function isLockStale(lock: WorktreeLock, timeout_ms: number): boolean {
  const age = Date.now() - new Date(lock.acquired_at).getTime();
  return age > timeout_ms;
}

/** Write a lock file to the given path. */
async function writeLock(lockPath: string, lock: WorktreeLock): Promise<void> {
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf-8");
}

async function hasGitMarker(dirPath: string): Promise<boolean> {
  try {
    await stat(join(dirPath, ".git"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function isWithinGitRepository(basePath: string): Promise<boolean> {
  let current = resolve(basePath);

  for (let depth = 0; depth < MAX_GIT_REPO_ANCESTOR_DEPTH; depth += 1) {
    if (await hasGitMarker(current)) {
      return true;
    }

    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }

  return false;
}

function buildWorktreeBaseValidationError(basePath: string): string {
  return [
    `Worktree base ${resolve(basePath)} is not a git repository.`,
    "",
    "Pass --worktree-path <absolute-path> explicitly to point at a pre-existing",
    "worktree directory, OR run `git worktree add` manually on the target host",
    "before launching.",
    "",
    "You can also pass --repo <slug> to resolve the clean clone from",
    "fleet/truths/hosts.yaml.",
  ].join("\n");
}

function buildMissingExplicitWorktreePathError(wtPath: string): string {
  return [
    `Explicit worktree path does not exist: ${wtPath}`,
    "",
    "To use a managed worktree, omit --worktree-path and pass:",
    "  --repo <slug> --worktree-branch <branch>",
    "",
    "To create that exact path intentionally, pass:",
    "  --worktree-mode create --repo <slug> --worktree-path <path> --worktree-branch <branch>",
  ].join("\n");
}

async function releaseDbLease(lease: WorktreeLease | undefined, opts: WorktreeManagerOptions): Promise<void> {
  if (!lease || !opts.lease?.release) return;
  await opts.lease.release(lease);
}

/** Exponential backoff delay (ms) for contention retry attempt `attempt` (0-indexed). */
function backoffDelayMs(attempt: number): number {
  return Math.min(DEFAULT_CONTENTION_MAX_DELAY_MS, DEFAULT_CONTENTION_BASE_DELAY_MS * 2 ** attempt);
}

/** Default sleep used between contention-retry attempts. */
async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

/**
 * Enrich a contention error message with the next remediation command so the
 * runner/operator is never left at a bare dead-end (POL-1826). When the caller
 * already passed `--steal-lock` the wait was bypassed, so no remediation is
 * appended.
 */
function withContentionRemediation(
  message: string,
  opts: { attempts: number; steal: boolean },
): string {
  if (opts.steal) return message;
  const lines = [message];
  if (opts.attempts > 1) {
    lines.push(`Retried ${opts.attempts}× with backoff, but the holder did not release.`);
  }
  lines.push(
    "Wait for the holder to release, or pass --steal-lock to forcibly acquire (only when you are certain the holder is dead).",
  );
  return lines.join("\n");
}

function commandDetail(result: GitExecResult): string {
  return [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n") || `exit ${result.code}`;
}

function parseRemoteNames(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function remoteBranchCandidates(ref: string, remotes: string[]): RemoteBranchRef[] {
  const body = ref.startsWith(REMOTE_TRACKING_PREFIX)
    ? ref.slice(REMOTE_TRACKING_PREFIX.length)
    : ref;

  return remotes.flatMap((remote) => {
    const prefix = `${remote}/`;
    if (!body.startsWith(prefix)) {
      return [];
    }

    const branch = body.slice(prefix.length);
    if (!branch) {
      return [];
    }

    return [{
      remote,
      branch,
      fetchRefspec: `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
    }];
  });
}

async function revParseCommit(
  ref: string,
  exec: GitExecutor,
  gitCwd: GitExecOptions | undefined,
): Promise<string | undefined> {
  const result = await exec(
    "git",
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    gitCwd,
  );
  const value = result.stdout.trim();
  return result.code === 0 && value.length > 0 ? value : undefined;
}

async function refResolves(
  ref: string,
  exec: GitExecutor,
  gitCwd: GitExecOptions | undefined,
): Promise<boolean> {
  const result = await exec(
    "git",
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    gitCwd,
  );
  return result.code === 0;
}

async function lsRemoteTrackingHead(
  candidate: RemoteBranchRef,
  exec: GitExecutor,
  gitCwd: GitExecOptions | undefined,
): Promise<string | undefined> {
  const result = await exec(
    "git",
    ["ls-remote", candidate.remote, `refs/heads/${candidate.branch}`],
    gitCwd,
  );
  if (result.code !== 0) {
    return undefined;
  }

  const head = result.stdout.trim().split(/\s+/)[0]?.trim();
  return head && COMMIT_SHA_PATTERN.test(head) ? head.toLowerCase() : undefined;
}

async function fetchRemoteTrackingRef(
  ref: string,
  exec: GitExecutor,
  gitCwd: GitExecOptions | undefined,
  retry: WorktreeContentionRetry | undefined,
): Promise<string | undefined> {
  const remotesResult = await exec("git", ["remote"], gitCwd);
  if (remotesResult.code !== 0) {
    return undefined;
  }

  const candidates = remoteBranchCandidates(ref, parseRemoteNames(remotesResult.stdout));
  if (candidates.length === 0) {
    return undefined;
  }
  if (candidates.length > 1) {
    const remotes = candidates.map((candidate) => candidate.remote).join(", ");
    return `Worktree ref "${ref}" is ambiguous across configured remotes (${remotes}); pass an unambiguous ref before git worktree add.`;
  }

  const candidate = candidates[0]!;
  const maxAttempts = Math.max(1, retry?.attempts ?? DEFAULT_CONTENTION_RETRY_ATTEMPTS);
  const sleep = retry?.sleep ?? defaultSleep;
  let fetchResult: GitExecResult | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    fetchResult = await exec(
      "git",
      ["fetch", candidate.remote, candidate.fetchRefspec],
      gitCwd,
    );
    if (fetchResult.code === 0) {
      return undefined;
    }
    if (attempt < maxAttempts) {
      await sleep(backoffDelayMs(attempt - 1));
    }
  }

  fetchResult ??= { code: 1, stdout: "", stderr: "git fetch was not attempted" };
  if (fetchResult.code === 0) {
    return undefined;
  }

  const advertisedHead = await lsRemoteTrackingHead(candidate, exec, gitCwd);
  const localHead = await revParseCommit(ref, exec, gitCwd);
  if (advertisedHead && localHead?.toLowerCase() === advertisedHead) {
    return undefined;
  }

  const verificationDetail = advertisedHead
    ? localHead
      ? `Remote advertised ${advertisedHead}, but local ${ref} resolves to ${localHead}.`
      : `Remote advertised ${advertisedHead}, but local ${ref} does not resolve.`
    : `Could not verify the advertised remote head for ${candidate.remote}/${candidate.branch}.`;

  return [
    `Worktree ref "${ref}" could not be refreshed from remote "${candidate.remote}" before git worktree add.`,
    `git fetch ${candidate.remote} ${candidate.fetchRefspec} failed after ${maxAttempts} attempt(s) (code ${fetchResult.code}): ${commandDetail(fetchResult)}`,
    verificationDetail,
    "For intentional local-only/offline work, use --worktree-mode existing --worktree-path <path> with an operator-prepared checkout.",
  ].join("\n");
}

/**
 * Fetch a bare commit SHA directly from configured remotes when it is absent
 * from the local clone (POL-1826: "worktree ref <sha> could not be resolved").
 * Returns undefined when the commit resolves after fetching, otherwise a
 * remediation-bearing error string.
 */
async function fetchCommitFromRemotes(
  sha: string,
  remotes: string[],
  exec: GitExecutor,
  gitCwd: GitExecOptions | undefined,
): Promise<string | undefined> {
  const failures: string[] = [];
  for (const remote of remotes) {
    const fetchResult = await exec("git", ["fetch", remote, sha], gitCwd);
    if (fetchResult.code === 0 && (await refResolves(sha, exec, gitCwd))) {
      return undefined;
    }
    failures.push(`${remote} (code ${fetchResult.code})`);
  }
  return [
    `Worktree ref "${sha}" could not be resolved before git worktree add, and a direct fetch from configured remotes did not recover it.`,
    `Tried: ${failures.join(", ")}.`,
    "Push the commit to a configured remote (hosts such as GitHub only serve a SHA reachable from an advertised ref).",
  ].join("\n");
}

async function ensureWorktreeAddRef(
  ref: string,
  exec: GitExecutor,
  gitCwd: GitExecOptions | undefined,
  retry: WorktreeContentionRetry | undefined,
): Promise<string | undefined> {
  const trimmedRef = ref.trim();
  if (!trimmedRef) {
    return "Worktree ref is empty; cannot resolve before git worktree add.";
  }

  const refreshError = await fetchRemoteTrackingRef(trimmedRef, exec, gitCwd, retry);
  if (refreshError) {
    return refreshError;
  }

  if (await refResolves(trimmedRef, exec, gitCwd)) {
    return undefined;
  }

  const remotesResult = await exec("git", ["remote"], gitCwd);
  if (remotesResult.code !== 0) {
    return [
      `Worktree ref "${trimmedRef}" could not be resolved before git worktree add.`,
      `git remote failed (code ${remotesResult.code}): ${commandDetail(remotesResult)}`,
    ].join("\n");
  }

  const remotes = parseRemoteNames(remotesResult.stdout);
  const candidates = remoteBranchCandidates(trimmedRef, remotes);
  if (candidates.length === 0) {
    // A bare commit SHA does not match <remote>/<branch>; it may simply be
    // absent from this clone. Fetch it directly before dead-ending (POL-1826).
    if (COMMIT_SHA_PATTERN.test(trimmedRef) && remotes.length > 0) {
      return await fetchCommitFromRemotes(trimmedRef, remotes, exec, gitCwd);
    }
    return [
      `Worktree ref "${trimmedRef}" could not be resolved before git worktree add.`,
      "If this is a remote branch, pass it as <remote>/<branch> for a configured remote.",
    ].join("\n");
  }
  if (candidates.length > 1) {
    const remotes = candidates.map((candidate) => candidate.remote).join(", ");
    return `Worktree ref "${trimmedRef}" is ambiguous across configured remotes (${remotes}); pass an unambiguous ref before git worktree add.`;
  }

  const candidate = candidates[0]!;
  return [
    `Worktree ref "${trimmedRef}" was refreshed from remote "${candidate.remote}" but still could not be resolved before git worktree add.`,
    `refspec: ${candidate.fetchRefspec}`,
  ].join("\n");
}

async function resetManagedWorktreeToRef(
  wtPath: string,
  branch: string,
  ref: string,
  exec: GitExecutor,
): Promise<string | undefined> {
  if (!branch.startsWith("calyx-review/")) {
    return `Refusing reset_on_reuse for non-review branch "${branch}". Only calyx-review/* branches may be reset by the runner.`;
  }

  const status = await exec("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: wtPath });
  if (status.code !== 0) {
    return `git status --porcelain --untracked-files=no failed in ${wtPath} before reset (code ${status.code}): ${commandDetail(status)}`;
  }
  if (status.stdout.trim().length > 0) {
    return [
      `Refusing git reset --hard ${ref} in ${wtPath} because tracked local changes are present.`,
      "Use --worktree-mode existing --worktree-path <path> after preserving or discarding those changes explicitly.",
    ].join("\n");
  }

  const result = await exec("git", ["reset", "--hard", ref], { cwd: wtPath });
  if (result.code === 0) {
    return undefined;
  }
  return `git reset --hard ${ref} failed in ${wtPath} (code ${result.code}): ${commandDetail(result)}`;
}

/**
 * Acquire a worktree for a run.
 *
 * For runtime-managed worktrees, creates the git worktree (via
 * `git worktree add`) and writes a lock file. When `spec.path` is explicit,
 * the runner only locks and uses that existing workspace; it does not create
 * or mutate the workspace itself.
 * Handles stale lock removal and steal_lock semantics.
 */
export async function acquireWorktree(
  spec: WorktreeSpec,
  run_id: string,
  opts: WorktreeManagerOptions,
): Promise<WorktreeAcquireResult> {
  const mode = spec.mode ?? (spec.path ? "existing" : "managed");

  if ((mode === "managed" || mode === "create") && !spec.branch) {
    const message = mode === "managed"
      ? [
          'Worktree mode "managed" requires --worktree-branch <branch>.',
          "",
          "Pass --worktree-branch <branch> to pin an explicit Calyx-owned branch, or",
          "pass --issue <id> so the resolver can derive the managed branch as",
          "calyx-run/<lowercase issue> (for example, calyx-run/pol-1325).",
        ].join("\n")
      : 'Worktree mode "create" requires --worktree-branch <branch>.';
    return {
      acquired: false,
      path: resolveWorktreePath(spec, opts.base_path),
      error: message,
    };
  }

  let resolvedRepoPath: string | undefined;
  if (spec.repo && (mode === "managed" || mode === "create")) {
    if (!opts.resolve_repo) {
      return {
        acquired: false,
        path: resolveWorktreePath(spec, opts.base_path),
        error: `Repo slug "${spec.repo}" cannot be resolved because no repo resolver is configured.`,
      };
    }
    try {
      resolvedRepoPath = await opts.resolve_repo(spec.repo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        acquired: false,
        path: resolveWorktreePath(spec, opts.base_path),
        error: message,
      };
    }
  }
  if (spec.repo && (mode === "managed" || mode === "create") && !resolvedRepoPath) {
    return {
      acquired: false,
      path: resolveWorktreePath(spec, opts.base_path),
      error: mode === "create"
        ? `Repo slug "${spec.repo}" could not be resolved. Configure fleet/truths/hosts.yaml so Calyx can create the requested worktree path.`
        : `Repo slug "${spec.repo}" could not be resolved. Configure fleet/truths/hosts.yaml or pass --worktree-path explicitly.`,
    };
  }

  const managedBasePath = resolvedRepoPath
    ? join(dirname(resolvedRepoPath), "wt")
    : opts.base_path;
  const wtPath = resolveWorktreePath(spec, managedBasePath);
  const lockPath = join(wtPath, LOCK_FILENAME);
  const timeout = opts.lock_timeout_ms ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryCfg = opts.contention_retry ?? {};
  const maxAttempts = Math.max(1, retryCfg.attempts ?? DEFAULT_CONTENTION_RETRY_ATTEMPTS);
  const sleep = retryCfg.sleep ?? defaultSleep;
  const steal = spec.steal_lock === true;

  // Acquire the DB lease and crash-safety file lock, retrying transient
  // contention (held lease or live lock) with bounded backoff before giving up
  // (POL-1826). `--steal-lock` bypasses the wait entirely.
  let dbLease: WorktreeLease | undefined;
  let staleLockRemoved = false;
  let stolen = false;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const lastAttempt = attempt === maxAttempts - 1;

    const dbLeaseResult = opts.lease
      ? await opts.lease.acquire({
          path: wtPath,
          run_id,
          ttl_ms: timeout,
          steal_lock: steal,
        })
      : undefined;
    if (dbLeaseResult && !dbLeaseResult.acquired) {
      // `--steal-lock` is deterministic at the lease layer, so do not retry it.
      if (!lastAttempt && !steal) {
        await sleep(backoffDelayMs(attempt));
        continue;
      }
      return {
        acquired: false,
        path: wtPath,
        error: withContentionRemediation(
          dbLeaseResult.error ?? `Worktree DB lease unavailable for ${wtPath}`,
          { attempts: maxAttempts, steal },
        ),
      };
    }
    dbLease = dbLeaseResult?.lease;

    const existingLock = await readLock(lockPath);
    if (existingLock) {
      const stale = isLockStale(existingLock, timeout);
      if (!stale && !steal) {
        // Live lock held by another run — release our lease and retry.
        await releaseDbLease(dbLease, opts);
        dbLease = undefined;
        if (!lastAttempt) {
          await sleep(backoffDelayMs(attempt));
          continue;
        }
        return {
          acquired: false,
          path: wtPath,
          lock: existingLock,
          error: withContentionRemediation(
            `Worktree locked by run ${existingLock.run_id} (pid ${existingLock.pid}, acquired ${existingLock.acquired_at})`,
            { attempts: maxAttempts, steal: false },
          ),
        };
      }
      // Stale or stolen lock — remove it and proceed with acquisition.
      try {
        await rm(lockPath);
      } catch {
        // Lock file may have been removed concurrently.
      }
      if (stale) {
        staleLockRemoved = true;
      } else {
        stolen = true;
      }
    }
    break;
  }

  if (mode === "existing") {
    if (!spec.path) {
      await releaseDbLease(dbLease, opts);
      return {
        acquired: false,
        path: wtPath,
        error: [
          "Existing worktree mode requires --worktree-path <path>.",
          "",
          "To use a managed worktree, omit --worktree-path and pass:",
          "  --repo <slug> --worktree-branch <branch>",
          "",
          "To create an exact path intentionally, pass:",
          "  --worktree-mode create --repo <slug> --worktree-path <path> --worktree-branch <branch>",
        ].join("\n"),
      };
    }
    try {
      const info = await stat(wtPath);
      if (!info.isDirectory()) {
        await releaseDbLease(dbLease, opts);
        return {
          acquired: false,
          path: wtPath,
          error: `Explicit worktree path is not a directory: ${wtPath}`,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await releaseDbLease(dbLease, opts);
        return {
          acquired: false,
          path: wtPath,
          error: buildMissingExplicitWorktreePathError(wtPath),
        };
      }
      throw error;
    }

    const lock: WorktreeLock = {
      run_id,
      pid: process.pid,
      acquired_at: new Date().toISOString(),
    };
    await writeLock(lockPath, lock);

    const acquireResult: WorktreeAcquireResult = {
      acquired: true,
      path: wtPath,
      lock,
      ...(dbLease ? { lease: dbLease } : {}),
    };
    if (staleLockRemoved) {
      acquireResult.stale_lock_removed = true;
    }
    if (stolen) {
      acquireResult.stolen = true;
    }
    return acquireResult;
  }

  if (mode === "managed" && spec.path) {
    await releaseDbLease(dbLease, opts);
    return {
      acquired: false,
      path: wtPath,
      error: "Managed worktree mode does not accept an explicit worktree path. Omit --worktree-path and pass --repo <slug> --worktree-branch <branch>.",
    };
  }

  if (mode === "create" && !spec.path) {
    await releaseDbLease(dbLease, opts);
    return {
      acquired: false,
      path: wtPath,
      error: "Create worktree mode requires --worktree-path <path>.",
    };
  }

  if (mode === "create" && !resolvedRepoPath) {
    await releaseDbLease(dbLease, opts);
    return {
      acquired: false,
      path: wtPath,
      error: "Create worktree mode requires --repo <slug> so Calyx can run git worktree add from the source clone.",
    };
  }

  if (!resolvedRepoPath && !(await isWithinGitRepository(opts.base_path))) {
    await releaseDbLease(dbLease, opts);
    return {
      acquired: false,
      path: wtPath,
      error: buildWorktreeBaseValidationError(opts.base_path),
    };
  }

  // Ensure the parent directory exists; git worktree add owns the target path.
  await mkdir(dirname(wtPath), { recursive: true });

  // Create the git worktree
  const ref = spec.ref ?? "origin/main";
  const branch = spec.branch;
  const exec = opts.exec ?? defaultExec;
  const gitCwd = resolvedRepoPath ? { cwd: resolvedRepoPath } : undefined;

  // Detect whether the target branch already exists locally. When it does, use
  // `git worktree add <path> <branch>` (without -b) so we adopt the existing
  // Calyx-owned branch instead of failing with `branch already exists`.
  let branchExists = false;
  if (branch) {
    const showRef = await exec(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      gitCwd,
    );
    branchExists = showRef.code === 0;
  }

  if (!branch || !branchExists || spec.reset_on_reuse) {
    const refError = await ensureWorktreeAddRef(ref, exec, gitCwd, opts.contention_retry);
    if (refError) {
      await releaseDbLease(dbLease, opts);
      return {
        acquired: false,
        path: wtPath,
        error: refError,
      };
    }
  }

  const args = ["worktree", "add"];
  if (branch && !branchExists) {
    args.push("-b", branch, wtPath, ref);
  } else if (branch && branchExists) {
    args.push(wtPath, branch);
  } else {
    args.push(wtPath, ref);
  }

  const result = await exec("git", args, gitCwd);

  // git worktree add returns non-zero if it already exists — that's fine for us
  // as long as the directory exists. Code 128 = worktree already exists.
  if (result.code !== 0 && !result.stderr.includes("already exists")) {
    await releaseDbLease(dbLease, opts);
    return {
      acquired: false,
      path: wtPath,
      error: `git worktree add failed (code ${result.code}): ${result.stderr}`,
    };
  }

  if (result.code !== 0) {
    try {
      const info = await stat(wtPath);
      if (!info.isDirectory()) {
        await releaseDbLease(dbLease, opts);
        return {
          acquired: false,
          path: wtPath,
          error: `git worktree add reported an existing non-directory path: ${wtPath}`,
        };
      }
    } catch {
      await releaseDbLease(dbLease, opts);
      return {
        acquired: false,
        path: wtPath,
        error: `git worktree add reported an existing path, but it is not available: ${wtPath}`,
      };
    }
  }

  if (branch && branchExists && spec.reset_on_reuse) {
    const resetError = await resetManagedWorktreeToRef(wtPath, branch, ref, exec);
    if (resetError) {
      await releaseDbLease(dbLease, opts);
      return {
        acquired: false,
        path: wtPath,
        error: resetError,
      };
    }
  }

  // Write lock
  const lock: WorktreeLock = {
    run_id,
    pid: process.pid,
    acquired_at: new Date().toISOString(),
  };
  await writeLock(lockPath, lock);

  const acquireResult: WorktreeAcquireResult = {
    acquired: true,
    path: wtPath,
    lock,
    ...(dbLease ? { lease: dbLease } : {}),
  };
  if (staleLockRemoved) {
    acquireResult.stale_lock_removed = true;
  }
  if (stolen) {
    acquireResult.stolen = true;
  }
  return acquireResult;
}

/**
 * Release a worktree lock. Does NOT remove the git worktree itself
 * (that's a separate cleanup concern).
 */
export async function releaseWorktree(
  wtPath: string,
  opts?: WorktreeManagerOptions,
  acquisition?: WorktreeAcquireResult,
): Promise<void> {
  const lockPath = join(wtPath, LOCK_FILENAME);
  try {
    await rm(lockPath);
  } catch {
    // Already released or never locked
  }
  if (opts && acquisition?.lease) {
    await releaseDbLease(acquisition.lease, opts);
  }
}

/** Default shell executor using child_process. */
async function defaultExec(
  cmd: string,
  args: string[],
  options?: GitExecOptions,
): Promise<GitExecResult> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  try {
    const { stdout, stderr } = await execFileP(cmd, args, options);
    return {
      code: 0,
      stdout: stdout.toString(),
      stderr: stderr.toString(),
    };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}
