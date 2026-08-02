/**
 * @polli-labs/calyx-runner — Session discovery utilities.
 *
 * After a backend adapter finishes execution, these functions locate the
 * session file produced by the backend CLI. Run-scoped Claude discovery uses
 * the exact session id assigned at launch, then validates transcript identity.
 *
 * Claude session discovery gracefully returns undefined on any error.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { SessionInfo } from "./types.js";

/** Filesystem abstraction for testing. */
export interface SessionDiscoveryFs {
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding: "utf-8"): Promise<string>;
  stat(path: string): Promise<{ mtimeMs: number }>;
  homedir(): string;
}

const defaultFs: SessionDiscoveryFs = {
  readdir: async (p) => {
    const entries = await readdir(p);
    return entries;
  },
  readFile: (p, enc) => readFile(p, enc),
  stat: async (p) => {
    const s = await stat(p);
    return { mtimeMs: s.mtimeMs };
  },
  homedir,
};

/** Exact identity and execution window expected for a spawned Claude session. */
export interface ClaudeSessionDiscoveryRequest {
  sessionId: string;
  cwd: string;
  startTime: number;
  endTime: number;
  /** Resume transcripts may contain events created before this execution. */
  isResume?: boolean;
}

/**
 * Discover the exact Claude Code session assigned to a run.
 *
 * The filename alone is not trusted. The transcript must have been touched in
 * the execution window, contain only the assigned session id, and contain an
 * event from the expected working directory during that window. Fresh sessions
 * must also begin in the window; resumed sessions may contain older events.
 */
export async function discoverClaudeSession(
  request: ClaudeSessionDiscoveryRequest,
  fs: SessionDiscoveryFs = defaultFs,
): Promise<SessionInfo | undefined> {
  try {
    const home = fs.homedir();
    const projectsDir = join(home, ".claude", "projects");
    const sessionJsonlPath = await findClaudeSessionJsonl(
      projectsDir,
      request.sessionId,
      fs,
    );
    if (!sessionJsonlPath) return undefined;

    const details = await fs.stat(sessionJsonlPath);
    if (details.mtimeMs < request.startTime || details.mtimeMs > request.endTime) {
      return undefined;
    }

    const identity = await readClaudeTranscriptIdentity(sessionJsonlPath, request, fs);
    if (!identity) return undefined;
    if (!request.isResume && identity.startedAt < request.startTime) return undefined;
    if (!request.isResume && identity.startedAt > request.endTime) return undefined;

    return {
      id: request.sessionId,
      path: sessionJsonlPath,
      backend: "claude",
    };
  } catch {
    return undefined;
  }
}

/** Scan ~/.claude/projects/ subdirectories for a session JSONL file. */
async function findClaudeSessionJsonl(
  projectsDir: string,
  sessionId: string,
  fs: SessionDiscoveryFs,
): Promise<string | undefined> {
  try {
    const projectDirs = await fs.readdir(projectsDir);
    for (const proj of projectDirs) {
      const projPath = join(projectsDir, proj);
      try {
        const files = await fs.readdir(projPath);
        const match = files.find((f) => f === `${sessionId}.jsonl`);
        if (match) {
          return join(projPath, match);
        }
      } catch {
        // Not a directory or inaccessible
      }
    }
  } catch {
    // projects dir doesn't exist
  }
  return undefined;
}

interface ClaudeTranscriptIdentity {
  startedAt: number;
}

async function readClaudeTranscriptIdentity(
  sessionPath: string,
  request: ClaudeSessionDiscoveryRequest,
  fs: SessionDiscoveryFs,
): Promise<ClaudeTranscriptIdentity | undefined> {
  try {
    const content = await fs.readFile(sessionPath, "utf-8");
    let sawExpectedSessionId = false;
    let sawExpectedCwdInWindow = false;
    let startedAt: number | undefined;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (typeof event.sessionId === "string") {
          if (event.sessionId !== request.sessionId) return undefined;
          sawExpectedSessionId = true;
        }
        const timestamp = typeof event.timestamp === "string"
          ? new Date(event.timestamp).getTime()
          : typeof event.timestamp === "number"
            ? event.timestamp
            : NaN;
        if (Number.isFinite(timestamp) && (startedAt === undefined || timestamp < startedAt)) {
          startedAt = timestamp;
        }
        if (
          Number.isFinite(timestamp)
          && timestamp >= request.startTime
          && timestamp <= request.endTime
          && typeof event.cwd === "string"
          && sameWorkingDirectory(event.cwd, request.cwd)
        ) {
          sawExpectedCwdInWindow = true;
        }
      } catch {
        // Ignore malformed lines while looking for the transcript identity.
      }
    }
    return sawExpectedSessionId && sawExpectedCwdInWindow && startedAt !== undefined
      ? { startedAt }
      : undefined;
  } catch {
    return undefined;
  }
}

function sameWorkingDirectory(actual: string, expected: string): boolean {
  return resolve(actual) === resolve(expected);
}

// ── Latest-session discovery ───────────────────────────────────────

/** Extended session info that includes timestamp and backend for cross-backend comparison. */
export interface LatestSessionInfo extends SessionInfo {
  /** Epoch-ms timestamp of when the session was started. */
  startedAt: number;
}

/**
 * Find the most recent Claude session regardless of time window.
 *
 * Scans `~/.claude/sessions/*.json`, parses `startedAt` from each, and
 * returns the one with the highest timestamp.
 */
export async function findLatestClaudeSession(
  fs: SessionDiscoveryFs = defaultFs,
): Promise<LatestSessionInfo | undefined> {
  try {
    const home = fs.homedir();
    const sessionsDir = join(home, ".claude", "sessions");

    let entries: string[];
    try {
      entries = await fs.readdir(sessionsDir);
    } catch {
      return undefined;
    }

    const jsonFiles = entries.filter((f) => f.endsWith(".json"));

    let best: { sessionId: string; startedAt: number } | undefined;
    for (const file of jsonFiles) {
      try {
        const content = await fs.readFile(join(sessionsDir, file), "utf-8");
        const meta = JSON.parse(content) as Record<string, unknown>;
        const startedAtRaw = meta.startedAt;
        if (startedAtRaw === undefined) continue;

        const startedAt =
          typeof startedAtRaw === "number"
            ? startedAtRaw
            : typeof startedAtRaw === "string"
              ? new Date(startedAtRaw).getTime()
              : NaN;

        if (Number.isNaN(startedAt)) continue;

        if (!best || startedAt > best.startedAt) {
          const sessionId =
            typeof meta.sessionId === "string"
              ? meta.sessionId
              : file.replace(/\.json$/, "");
          best = { sessionId, startedAt };
        }
      } catch {
        // Skip malformed files
      }
    }

    if (!best) return undefined;

    // Derive the JSONL path
    const projectsDir = join(home, ".claude", "projects");
    const sessionJsonlPath = await findClaudeSessionJsonl(
      projectsDir,
      best.sessionId,
      fs,
    );

    return {
      id: best.sessionId,
      path: sessionJsonlPath ?? "",
      backend: "claude",
      startedAt: best.startedAt,
    };
  } catch {
    return undefined;
  }
}
