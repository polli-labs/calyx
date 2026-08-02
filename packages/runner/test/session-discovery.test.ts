/**
 * Tests for Claude session discovery utilities.
 *
 * Codex-specific discovery coverage lives under calyx-ext-codex.
 */

import { describe, expect, test } from "vitest";
import {
  discoverClaudeSession,
  findLatestClaudeSession,
} from "@polli-labs/calyx-runner";
import type { SessionDiscoveryFs } from "@polli-labs/calyx-runner";

// ── Mock filesystem helper ──────────────────────────────────────────

function createMockFs(files: Record<string, string>, mtimes: Record<string, number> = {}): SessionDiscoveryFs {
  const dirs = new Map<string, string[]>();

  // Pre-compute directory listings
  for (const filePath of Object.keys(files)) {
    const parts = filePath.split("/");
    const dir = parts.slice(0, -1).join("/");
    const name = parts[parts.length - 1]!;
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir)!.push(name);
  }

  return {
    readdir: async (p: string) => {
      const normalized = p.replace(/\/$/, "");
      const entries = dirs.get(normalized);
      if (!entries) {
        // Check if any subpaths exist (to list subdirectories)
        const subDirs = new Set<string>();
        for (const key of dirs.keys()) {
          if (key.startsWith(normalized + "/")) {
            const rest = key.slice(normalized.length + 1);
            const first = rest.split("/")[0];
            if (first) subDirs.add(first);
          }
        }
        if (subDirs.size > 0) return Array.from(subDirs);
        throw new Error(`ENOENT: ${p}`);
      }
      // Also include subdirectory names
      const subDirs = new Set<string>();
      for (const key of dirs.keys()) {
        if (key.startsWith(normalized + "/")) {
          const rest = key.slice(normalized.length + 1);
          const first = rest.split("/")[0];
          if (first) subDirs.add(first);
        }
      }
      return [...entries, ...Array.from(subDirs)];
    },
    readFile: async (p: string) => {
      const content = files[p];
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    stat: async (p: string) => {
      if (files[p] === undefined) throw new Error(`ENOENT: ${p}`);
      return { mtimeMs: mtimes[p] ?? Date.now() };
    },
    homedir: () => "/home/testuser",
  };
}

// ── Claude session discovery ────────────────────────────────────────

describe("discoverClaudeSession", () => {
  const baseTime = new Date("2026-03-18T10:00:00Z").getTime();
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const sessionPath = `/home/testuser/.claude/projects/proj-hash/${sessionId}.jsonl`;
  const request = {
    sessionId,
    cwd: "/work/expected",
    startTime: baseTime,
    endTime: baseTime + 60000,
  };

  function transcript(
    id = sessionId,
    cwd = request.cwd,
    timestamp = baseTime + 1000,
  ): string {
    return JSON.stringify({ type: "user", sessionId: id, cwd, timestamp });
  }

  test("finds the exact assigned session after validating its transcript", async () => {
    const fs = createMockFs(
      { [sessionPath]: transcript() },
      { [sessionPath]: baseTime + 2000 },
    );

    await expect(discoverClaudeSession(request, fs)).resolves.toEqual({
      id: sessionId,
      path: sessionPath,
      backend: "claude",
    });
  });

  test("ignores a newer unrelated transcript instead of guessing by recency", async () => {
    const unrelatedId = "22222222-2222-4222-8222-222222222222";
    const unrelatedPath = `/home/testuser/.claude/projects/proj-hash/${unrelatedId}.jsonl`;
    const fs = createMockFs(
      {
        [sessionPath]: transcript(),
        [unrelatedPath]: transcript(unrelatedId, request.cwd, baseTime + 30000),
      },
      {
        [sessionPath]: baseTime + 2000,
        [unrelatedPath]: baseTime + 30000,
      },
    );

    const result = await discoverClaudeSession(request, fs);
    expect(result?.id).toBe(sessionId);
    expect(result?.path).toBe(sessionPath);
  });

  test("returns undefined when the exact assigned transcript is absent", async () => {
    const otherPath = "/home/testuser/.claude/projects/proj-hash/other.jsonl";
    const fs = createMockFs({ [otherPath]: transcript("other") });

    await expect(discoverClaudeSession(request, fs)).resolves.toBeUndefined();
  });

  test("rejects a transcript whose embedded session id disagrees", async () => {
    const fs = createMockFs(
      { [sessionPath]: transcript("wrong-session") },
      { [sessionPath]: baseTime + 2000 },
    );

    await expect(discoverClaudeSession(request, fs)).resolves.toBeUndefined();
  });

  test("rejects a transcript from another working directory", async () => {
    const fs = createMockFs(
      { [sessionPath]: transcript(sessionId, "/work/other") },
      { [sessionPath]: baseTime + 2000 },
    );

    await expect(discoverClaudeSession(request, fs)).resolves.toBeUndefined();
  });

  test("rejects a fresh transcript that began before this execution", async () => {
    const fs = createMockFs(
      {
        [sessionPath]: [
          transcript(sessionId, request.cwd, baseTime - 60000),
          transcript(sessionId, request.cwd, baseTime + 1000),
        ].join("\n"),
      },
      { [sessionPath]: baseTime + 2000 },
    );

    await expect(discoverClaudeSession(request, fs)).resolves.toBeUndefined();
  });

  test("accepts an old resumed transcript with a new matching event", async () => {
    const fs = createMockFs(
      {
        [sessionPath]: [
          transcript(sessionId, request.cwd, baseTime - 60000),
          transcript(sessionId, request.cwd, baseTime + 1000),
        ].join("\n"),
      },
      { [sessionPath]: baseTime + 2000 },
    );

    await expect(
      discoverClaudeSession({ ...request, isResume: true }, fs),
    ).resolves.toEqual({ id: sessionId, path: sessionPath, backend: "claude" });
  });

  test("rejects a transcript that was not touched during this execution", async () => {
    const fs = createMockFs(
      { [sessionPath]: transcript() },
      { [sessionPath]: baseTime - 1 },
    );

    await expect(discoverClaudeSession(request, fs)).resolves.toBeUndefined();
  });
});

// ── findLatestClaudeSession ──────────────────────────────────────────

describe("findLatestClaudeSession", () => {
  const baseTime = new Date("2026-03-18T10:00:00Z").getTime();

  test("finds the most recent claude session", async () => {
    const fs = createMockFs({
      "/home/testuser/.claude/sessions/sess-old.json": JSON.stringify({
        sessionId: "sess-old",
        startedAt: baseTime - 60000,
      }),
      "/home/testuser/.claude/sessions/sess-new.json": JSON.stringify({
        sessionId: "sess-new",
        startedAt: baseTime + 5000,
      }),
      "/home/testuser/.claude/projects/proj-hash/sess-new.jsonl": '{"type":"assistant"}',
    });

    const result = await findLatestClaudeSession(fs);
    expect(result).toBeDefined();
    expect(result!.id).toBe("sess-new");
    expect(result!.backend).toBe("claude");
    expect(result!.startedAt).toBe(baseTime + 5000);
    expect(result!.path).toContain("sess-new.jsonl");
  });

  test("returns undefined when no sessions exist", async () => {
    const fs = createMockFs({});
    const result = await findLatestClaudeSession(fs);
    expect(result).toBeUndefined();
  });

  test("skips malformed session metadata", async () => {
    const fs = createMockFs({
      "/home/testuser/.claude/sessions/bad.json": "not json",
      "/home/testuser/.claude/sessions/good.json": JSON.stringify({
        sessionId: "good",
        startedAt: baseTime + 1000,
      }),
    });

    const result = await findLatestClaudeSession(fs);
    expect(result).toBeDefined();
    expect(result!.id).toBe("good");
  });
});
