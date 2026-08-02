import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_INTERACTIVE_PAGE_CANDIDATE_LIMIT,
  inspectInteractiveSession,
  InteractiveActivityProjectionNotReadyError,
  InteractiveActivityRootConfigurationError,
  listInteractiveSessions,
  listInteractiveSessionsPage,
  listInteractiveSessionsSnapshotPage,
  resolveCalyxRunsRoot,
  resolveClaudeProjectsRoot,
  resolveCodexSessionRoots,
  summarizeInteractiveSessions,
} from "../interactive-activity.js";

describe("interactive activity", () => {
  const created: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
    created.length = 0;
  });

  async function makeHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "calyx-interactive-activity-"));
    created.push(home);
    return home;
  }

  const CODEX_DEEPLINK_FILE_ID = "019dfeed-aaaa-7222-8333-defdefdefdef";
  const CODEX_DEEPLINK_META_ID = "019dbabe-bbbb-7222-8333-abcabcabcabc";

  test("resolves Codex active and archive roots as one explicit-home or environment pair", async () => {
    const home = await makeHome();
    const sandboxHome = join(home, "sandbox");
    const ambientCodexHome = join(home, "ambient-codex");
    vi.stubEnv("CALYX_CONTEXT_CODEX_SESSIONS_ROOT", "");
    vi.stubEnv("CODEX_SESSIONS_ROOT", "");
    vi.stubEnv("CODEX_HOME", ambientCodexHome);

    expect(resolveCodexSessionRoots({ homeDir: sandboxHome })).toEqual({
      sessionsRoot: join(sandboxHome, ".codex", "sessions"),
      archivedSessionsRoot: join(sandboxHome, ".codex", "archived_sessions"),
    });
    expect(resolveCodexSessionRoots({})).toEqual({
      sessionsRoot: join(ambientCodexHome, "sessions"),
      archivedSessionsRoot: join(ambientCodexHome, "archived_sessions"),
    });

    const legacySessionsRoot = join(home, "legacy-codex", "sessions");
    vi.stubEnv("CODEX_SESSIONS_ROOT", legacySessionsRoot);
    expect(resolveCodexSessionRoots({})).toEqual({
      sessionsRoot: legacySessionsRoot,
      archivedSessionsRoot: join(ambientCodexHome, "archived_sessions"),
    });

    const freeFormContextRoot = join(home, "operator-transcripts");
    vi.stubEnv("CALYX_CONTEXT_CODEX_SESSIONS_ROOT", freeFormContextRoot);
    expect(resolveCodexSessionRoots({})).toEqual({
      sessionsRoot: freeFormContextRoot,
      archivedSessionsRoot: join(ambientCodexHome, "archived_sessions"),
    });

    const explicitArchiveRoot = join(home, "explicit-codex", "archived_sessions");
    expect(resolveCodexSessionRoots({ codexArchivedSessionsRoot: explicitArchiveRoot })).toEqual({
      sessionsRoot: join(home, "explicit-codex", "sessions"),
      archivedSessionsRoot: explicitArchiveRoot,
    });
  });

  test("resolves single-root backends with explicit-home isolation before ambient overrides", async () => {
    const home = await makeHome();
    const sandboxHome = join(home, "sandbox");
    const ambientClaudeHome = join(home, "ambient-claude");
    const ambientCalyxRoot = join(home, "ambient-calyx-runs");
    vi.stubEnv("CLAUDE_HOME", ambientClaudeHome);
    vi.stubEnv("CALYX_RUNS_ROOT", ambientCalyxRoot);

    expect(resolveClaudeProjectsRoot({ homeDir: sandboxHome })).toBe(
      join(sandboxHome, ".claude", "projects"),
    );
    expect(resolveCalyxRunsRoot({ homeDir: sandboxHome })).toBe(
      join(sandboxHome, ".calyx", "runs"),
    );
    expect(resolveClaudeProjectsRoot({})).toBe(join(ambientClaudeHome, "projects"));
    expect(resolveCalyxRunsRoot({})).toBe(ambientCalyxRoot);
  });

  test("rejects ambiguous or overlapping partial Codex root authority", async () => {
    const home = await makeHome();
    const sandboxHome = join(home, "sandbox");
    const canonicalSessionsRoot = join(sandboxHome, ".codex", "sessions");

    expect(resolveCodexSessionRoots({
      homeDir: sandboxHome,
      codexSessionsRoot: canonicalSessionsRoot,
    })).toEqual({
      sessionsRoot: canonicalSessionsRoot,
      archivedSessionsRoot: join(sandboxHome, ".codex", "archived_sessions"),
    });

    const invalidOptions: Array<Parameters<typeof resolveCodexSessionRoots>[0]> = [
      {
        homeDir: sandboxHome,
        codexSessionsRoot: join(home, "outside", "sessions"),
      },
      {
        codexArchivedSessionsRoot: join(home, "misnamed", "sessions"),
      },
      {
        codexSessionsRoot: join(home, "same"),
        codexArchivedSessionsRoot: join(home, "same"),
      },
    ];
    const errors = invalidOptions.map((options) => {
      try {
        resolveCodexSessionRoots(options);
        throw new Error("expected invalid Codex roots to fail closed");
      } catch (error) {
        expect(error).toBeInstanceOf(InteractiveActivityRootConfigurationError);
        return error as InteractiveActivityRootConfigurationError;
      }
    });
    expect(errors.map((error) => error.code)).toEqual([
      "activity_root_configuration_invalid",
      "activity_root_configuration_invalid",
      "activity_root_configuration_invalid",
    ]);
    expect(errors.map((error) => error.details.reason)).toEqual([
      "conflicting_home",
      "invalid_root_name",
      "overlapping_roots",
    ]);
  });

  test("lists codex and claude sessions as recent interactive activity", async () => {
    const home = await makeHome();
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    const claudeDir = join(home, ".claude", "projects", "-Users-caleb-dev-calyx");
    const claudeSubagentDir = join(claudeDir, "subagents");
    await mkdir(codexDir, { recursive: true });
    await mkdir(claudeSubagentDir, { recursive: true });

    await writeFile(
      join(codexDir, "rollout-2026-04-28T12-00-00-019dcafe-1111-7222-8333-abcabcabcabc.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-04-28T12:00:01.000Z",
          type: "session_meta",
          payload: {
            id: "019dcafe-1111-7222-8333-abcabcabcabc",
            timestamp: "2026-04-28T12:00:00.000Z",
            cwd: "/Users/caleb/dev/calyx/dev",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-28T12:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Audit the run surface" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      join(claudeDir, "a0db0b5e-a49a-4a51-8733-c71bb2e8047d.jsonl"),
      [
        JSON.stringify({
          type: "user",
          sessionId: "a0db0b5e-a49a-4a51-8733-c71bb2e8047d",
          timestamp: "2026-04-28T12:05:00.000Z",
          cwd: "/Users/caleb/dev/calyx/dev",
          message: {
            role: "user",
            content: "Review daemon health",
          },
        }),
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      join(claudeSubagentDir, "agent-noise.jsonl"),
      JSON.stringify({
        type: "user",
        sessionId: "agent-noise",
        timestamp: "2026-04-28T12:10:00.000Z",
        message: { role: "user", content: "Ignore subagent transcript" },
      }),
      "utf8",
    );

    const sessions = await listInteractiveSessions({
      homeDir: home,
      host: "MBA.local",
      sinceMs: 0,
      limit: 10,
    });

    expect(sessions).toHaveLength(2);
    expect(sessions.map((session) => session.backend).sort()).toEqual(["claude", "codex"]);
    expect(sessions.find((session) => session.backend === "codex")).toMatchObject({
      entry_kind: "interactive_session",
      run_id: "interactive:codex:019dcafe-1111-7222-8333-abcabcabcabc",
      state: "interactive",
      summary: "Audit the run surface",
      created_at: "2026-04-28T12:00:00.000Z",
      host: "mba",
      cwd: "/Users/caleb/dev/calyx/dev",
      source: "codex_sessions",
    });
    expect(sessions.find((session) => session.backend === "claude")).toMatchObject({
      run_id: "interactive:claude:a0db0b5e-a49a-4a51-8733-c71bb2e8047d",
      summary: "Review daemon health",
      created_at: "2026-04-28T12:05:00.000Z",
      source: "claude_projects",
    });
  });

  test("summarizes interactive sessions by backend", async () => {
    const home = await makeHome();
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    const claudeDir = join(home, ".claude", "projects", "-Users-caleb-dev-calyx");
    await mkdir(codexDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(codexDir, "rollout-2026-04-28T12-00-00-019dcafe-1111-7222-8333-abcabcabcabc.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: "019dcafe-1111-7222-8333-abcabcabcabc" } }),
      "utf8",
    );
    await writeFile(
      join(claudeDir, "a0db0b5e-a49a-4a51-8733-c71bb2e8047d.jsonl"),
      JSON.stringify({ type: "user", sessionId: "a0db0b5e-a49a-4a51-8733-c71bb2e8047d" }),
      "utf8",
    );

    await expect(summarizeInteractiveSessions({
      homeDir: home,
      sinceMs: 0,
      now: () => new Date("2026-04-28T13:00:00.000Z"),
    })).resolves.toMatchObject({
      window_ms: 0,
      scanned_at: "2026-04-28T13:00:00.000Z",
      codex: 1,
      claude: 1,
      total: 2,
    });
  });

  test("keeps archived Codex sessions out of discovery but resolves an exact activity id", async () => {
    const home = await makeHome();
    const archivedDir = join(home, ".codex", "archived_sessions");
    const sessionId = "019dcafe-9999-7222-8333-abcabcabcabc";
    const archivedPath = join(
      archivedDir,
      `rollout-2026-04-28T11-00-00-${sessionId}.jsonl`,
    );
    await mkdir(archivedDir, { recursive: true });
    await writeFile(
      archivedPath,
      [
        JSON.stringify({
          timestamp: "2026-04-28T11:00:00.000Z",
          type: "session_meta",
          payload: { id: sessionId, timestamp: "2026-04-28T11:00:00.000Z" },
        }),
        JSON.stringify({
          timestamp: "2026-04-28T11:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Archived but still addressable." }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    await expect(listInteractiveSessions({ homeDir: home, sinceMs: 0, limit: 10 }))
      .resolves.toEqual([]);
    await expect(summarizeInteractiveSessions({ homeDir: home, sinceMs: 0 }))
      .resolves.toMatchObject({ codex: 0, total: 0 });

    const inspected = await inspectInteractiveSession({
      homeDir: home,
      activityId: `interactive:codex:${sessionId}`,
      tail: 1,
    });
    expect(inspected.session_path).toBe(archivedPath);
    expect(inspected.events[0]?.summary).toBe("Archived but still addressable.");
  });

  test("fails closed when active and archived Codex files claim the same exact identity", async () => {
    const home = await makeHome();
    const sessionId = "019dcafe-aaaa-7222-8333-abcabcabcabc";
    const line = JSON.stringify({
      timestamp: "2026-04-28T11:00:00.000Z",
      type: "session_meta",
      payload: { id: sessionId, timestamp: "2026-04-28T11:00:00.000Z" },
    });
    const activeDir = join(home, ".codex", "sessions", "2026", "04", "28");
    const archivedDir = join(home, ".codex", "archived_sessions");
    await mkdir(activeDir, { recursive: true });
    await mkdir(archivedDir, { recursive: true });
    await writeFile(join(activeDir, `rollout-2026-04-28T11-00-00-${sessionId}.jsonl`), line, "utf8");
    await writeFile(join(archivedDir, `rollout-2026-04-28T11-00-00-${sessionId}.jsonl`), line, "utf8");

    await expect(inspectInteractiveSession({
      homeDir: home,
      activityId: `interactive:codex:${sessionId}`,
    })).rejects.toMatchObject({
      details: { reason: "identity_collision" },
    });
  });

  test("inspects bounded codex transcript slices and hides tools by default", async () => {
    const home = await makeHome();
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, "rollout-2026-04-28T12-00-00-019dcafe-1111-7222-8333-abcabcabcabc.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "019dcafe-1111-7222-8333-abcabcabcabc" } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Investigate carbon run service" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "shell",
            arguments: "{\"cmd\":\"calyx self health\"}",
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Carbon health timed out in the activity scan." }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const withoutTools = await inspectInteractiveSession({
      homeDir: home,
      activityId: "interactive:codex:019dcafe-1111-7222-8333-abcabcabcabc",
      around: "carbon health",
      context: 1,
    });

    expect(withoutTools).toMatchObject({
      activity_id: "interactive:codex:019dcafe-1111-7222-8333-abcabcabcabc",
      backend: "codex",
      total_events: 4,
      include_tools: false,
      truncated: false,
    });
    expect(withoutTools.events.map((event) => event.role)).not.toContain("tool");
    expect(withoutTools.events.map((event) => event.summary)).toContain("Carbon health timed out in the activity scan.");

    const withTools = await inspectInteractiveSession({
      homeDir: home,
      activityId: "interactive:codex:019dcafe-1111-7222-8333-abcabcabcabc",
      tail: 4,
      includeTools: true,
    });
    expect(withTools.events.map((event) => event.role)).toContain("tool");
    expect(withTools.truncated).toBe(false);

    await expect(inspectInteractiveSession({
      homeDir: home,
      activityId: "interactive:codex:019dcafe-1111-7222-8333-abcabcabcabc",
      tail: 0,
    })).resolves.toMatchObject({
      returned_events: 0,
      truncated: true,
    });
  });

  test("inspects codex sessions by deeplink and rollout filename id", async () => {
    const home = await makeHome();
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, `rollout-2026-04-28T12-02-00-${CODEX_DEEPLINK_FILE_ID}.jsonl`),
      [
        JSON.stringify({ type: "session_meta", payload: { id: CODEX_DEEPLINK_META_ID } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Resolved from the thread deeplink." }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    for (const activityId of [
      `codex://threads/${CODEX_DEEPLINK_FILE_ID}`,
      CODEX_DEEPLINK_FILE_ID,
      `interactive:codex:${CODEX_DEEPLINK_FILE_ID}`,
    ]) {
      const result = await inspectInteractiveSession({
        homeDir: home,
        activityId,
        tail: 1,
      });

      expect(result).toMatchObject({
        activity_id: `interactive:codex:${CODEX_DEEPLINK_META_ID}`,
        backend: "codex",
        session_id: CODEX_DEEPLINK_META_ID,
        total_events: 2,
      });
      expect(result.events[0]?.summary).toBe("Resolved from the thread deeplink.");
    }
  });

  test("pages by immutable identity while loading rich metadata only for selected rows", async () => {
    const home = await makeHome();
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    await mkdir(codexDir, { recursive: true });
    const sessions = [
      ["019dcafe-1111-7222-8333-abcabcabcab1", "2026-04-28T12:00:00.000Z", "first"],
      ["019dcafe-1111-7222-8333-abcabcabcab2", "2026-04-28T12:01:00.000Z", "second"],
      ["019dcafe-1111-7222-8333-abcabcabcab3", "2026-04-28T12:02:00.000Z", "third"],
    ] as const;
    for (const [id, timestamp, summary] of sessions) {
      const filenameTime = timestamp.slice(11, 19).replaceAll(":", "-");
      await writeFile(
        join(codexDir, `rollout-2026-04-28T${filenameTime}-${id}.jsonl`),
        [
          JSON.stringify({ type: "session_meta", payload: { id, timestamp } }),
          JSON.stringify({
            type: "response_item",
            payload: { type: "message", role: "user", content: [{ type: "input_text", text: summary }] },
          }),
        ].join("\n"),
        "utf8",
      );
    }

    const firstPage = await listInteractiveSessionsPage({ homeDir: home, sinceMs: 0, limit: 2 });
    expect(firstPage.map((entry) => entry.summary)).toEqual(["third", "second"]);
    const secondPage = await listInteractiveSessionsPage({
      homeDir: home,
      sinceMs: 0,
      limit: 2,
      after: {
        created_at: firstPage[1]!.created_at,
        run_id: firstPage[1]!.run_id,
      },
    });
    expect(secondPage.map((entry) => entry.summary)).toEqual(["first"]);
  });

  test("rejects a continuation when a backdated interactive identity is admitted after page one", async () => {
    const home = await makeHome();
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    await mkdir(codexDir, { recursive: true });
    for (const [id, second] of [
      ["019dcafe-1111-7222-8333-abcabcabcab1", "03"],
      ["019dcafe-1111-7222-8333-abcabcabcab2", "02"],
    ]) {
      await writeFile(
        join(codexDir, `rollout-2026-04-28T12-00-${second}-${id}.jsonl`),
        JSON.stringify({
          type: "session_meta",
          payload: { id, timestamp: `2026-04-28T12:00:${second}.000Z` },
        }),
        "utf8",
      );
    }
    const first = await listInteractiveSessionsSnapshotPage({ homeDir: home, sinceMs: 0, limit: 1 });
    await writeFile(
      join(codexDir, "rollout-2026-04-28T12-00-01-019dcafe-1111-7222-8333-abcabcabcab3.jsonl"),
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "019dcafe-1111-7222-8333-abcabcabcab3",
          timestamp: "2026-04-28T12:00:01.000Z",
        },
      }),
      "utf8",
    );

    await expect(listInteractiveSessionsSnapshotPage({
      homeDir: home,
      sinceMs: 0,
      limit: 1,
      after: { created_at: first.entries[0]!.created_at, run_id: first.entries[0]!.run_id },
      expectedMembershipFingerprint: first.membershipFingerprint,
    })).rejects.toMatchObject({
      code: "activity_projection_not_ready",
      details: { reason: "snapshot_drift" },
    });
  });

  test.each(["codex", "claude"] as const)(
    "fails closed when duplicate %s sources resolve to one public list identity",
    async (backend) => {
      const home = await makeHome();
      if (backend === "codex") {
        const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
        await mkdir(codexDir, { recursive: true });
        const publicSessionId = "019dcafe-1111-7222-8333-duplicate0001";
        for (const fileSessionId of [
          "019dcafe-1111-7222-8333-copy00000001",
          "019dcafe-1111-7222-8333-copy00000002",
        ]) {
          await writeFile(
            join(codexDir, `rollout-2026-04-28T12-00-00-${fileSessionId}.jsonl`),
            JSON.stringify({
              type: "session_meta",
              payload: {
                id: publicSessionId,
                timestamp: "2026-04-28T12:00:00.000Z",
              },
            }),
            "utf8",
          );
        }
      } else {
        for (const project of ["project-a", "project-b"]) {
          const claudeDir = join(home, ".claude", "projects", project);
          await mkdir(claudeDir, { recursive: true });
          await writeFile(
            join(claudeDir, "duplicate-session.jsonl"),
            JSON.stringify({
              type: "user",
              timestamp: "2026-04-28T12:00:00.000Z",
              message: { role: "user", content: "same public session identity" },
            }),
            "utf8",
          );
        }
      }

      await expect(listInteractiveSessionsSnapshotPage({
        homeDir: home,
        sinceMs: 0,
        limit: 1,
      })).rejects.toMatchObject({
        code: "activity_projection_not_ready",
        details: { reason: "identity_collision" },
      });
    },
  );

  test("fails typed instead of returning an incomplete page beyond the source budget", async () => {
    const home = await makeHome();
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    await mkdir(codexDir, { recursive: true });
    for (const suffix of ["1", "2", "3"]) {
      const id = `019dcafe-1111-7222-8333-abcabcabcab${suffix}`;
      await writeFile(
        join(codexDir, `rollout-2026-04-28T12-00-00-${id}.jsonl`),
        JSON.stringify({ type: "session_meta", payload: { id, timestamp: "2026-04-28T12:00:00.000Z" } }),
        "utf8",
      );
    }

    const rejection = listInteractiveSessionsPage({
      homeDir: home,
      sinceMs: 0,
      limit: 2,
      candidateLimit: 2,
    });
    await expect(rejection).rejects.toBeInstanceOf(InteractiveActivityProjectionNotReadyError);
    await expect(rejection).rejects.toMatchObject({
      name: "InteractiveActivityProjectionNotReadyError",
      code: "activity_projection_not_ready",
      retryable: true,
      details: {
        reason: "candidate_limit",
        candidate_limit: 2,
        candidates_seen: 3,
      },
    });
  });

  test("raw exact detail fails typed when its complete identity budget is exhausted", async () => {
    const home = await makeHome();
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    await mkdir(codexDir, { recursive: true });
    const ids = [
      "019dcafe-1111-7222-8333-abcabcabcab1",
      "019dcafe-1111-7222-8333-abcabcabcab2",
      "019dcafe-1111-7222-8333-abcabcabcab3",
    ];
    for (const id of ids) {
      await writeFile(
        join(codexDir, `rollout-2026-04-28T12-00-00-${id}.jsonl`),
        JSON.stringify({ type: "session_meta", payload: { id, timestamp: "2026-04-28T12:00:00.000Z" } }),
        "utf8",
      );
    }

    await expect(inspectInteractiveSession({
      homeDir: home,
      activityId: `interactive:codex:${ids[0]}`,
      candidateLimit: 2,
    })).rejects.toMatchObject({
      code: "activity_projection_not_ready",
      retryable: true,
      details: {
        reason: "candidate_limit",
        candidate_limit: 2,
        candidates_seen: 3,
      },
    });
  });

  test("managed journals consume the bounded source budget only when explicitly included", async () => {
    const home = await makeHome();
    const calyxRoot = join(home, ".calyx", "runs");
    await mkdir(calyxRoot, { recursive: true });
    const journalCount = DEFAULT_INTERACTIVE_PAGE_CANDIDATE_LIMIT + 1;
    for (let offset = 0; offset < journalCount; offset += 128) {
      const batch = Array.from(
        { length: Math.min(128, journalCount - offset) },
        (_, index) => offset + index,
      );
      await Promise.all(batch.map(async (index) => {
        const runDir = join(calyxRoot, `run-managed-journal-${String(index).padStart(4, "0")}`);
        await mkdir(runDir);
        await writeFile(
          join(runDir, "events.jsonl"),
          JSON.stringify({
            timestamp: "2026-04-28T12:00:00.000Z",
            run_id: `run-managed-journal-${index}`,
            event: "intent_persisted",
          }),
          "utf8",
        );
      }));
    }

    await expect(listInteractiveSessionsPage({
      homeDir: home,
      calyxRunsRoot: calyxRoot,
      includeCalyxRuns: false,
      limit: 1,
    })).resolves.toEqual([]);
    await expect(listInteractiveSessionsPage({
      homeDir: home,
      calyxRunsRoot: calyxRoot,
      includeCalyxRuns: true,
      limit: 1,
    })).rejects.toMatchObject({
      code: "activity_projection_not_ready",
      details: {
        reason: "candidate_limit",
        candidate_limit: DEFAULT_INTERACTIVE_PAGE_CANDIDATE_LIMIT,
        candidates_seen: DEFAULT_INTERACTIVE_PAGE_CANDIDATE_LIMIT + 1,
      },
    });
  });

  test("suppresses missing optional roots but fails typed on non-ENOENT directory discovery errors", async () => {
    const home = await makeHome();
    await expect(listInteractiveSessionsPage({ homeDir: home, limit: 1 })).resolves.toEqual([]);

    const codexRoot = join(home, ".codex", "sessions");
    await mkdir(codexRoot, { recursive: true });
    await expect(listInteractiveSessionsPage({
      homeDir: home,
      limit: 1,
      beforeDiscoveryRead: async (directoryPath) => {
        if (directoryPath === codexRoot) {
          throw Object.assign(new Error("private filesystem detail"), { code: "EACCES" });
        }
      },
    })).rejects.toMatchObject({
      code: "activity_projection_not_ready",
      message: "Interactive activity source discovery is temporarily unavailable.",
      details: { reason: "discovery_read_failed", source_path: codexRoot },
    });
  });

  test("fails typed on non-ENOENT candidate stat errors", async () => {
    const home = await makeHome();
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    const source = join(
      codexDir,
      "rollout-2026-04-28T12-00-00-019dcafe-1111-7222-8333-abcabcabcabc.jsonl",
    );
    await mkdir(codexDir, { recursive: true });
    await writeFile(source, "{}", "utf8");

    await expect(listInteractiveSessionsPage({
      homeDir: home,
      limit: 1,
      beforeCandidateStat: async (candidatePath) => {
        if (candidatePath === source) {
          throw Object.assign(new Error("private filesystem detail"), { code: "EIO" });
        }
      },
    })).rejects.toMatchObject({
      code: "activity_projection_not_ready",
      message: "Interactive activity source discovery is temporarily unavailable.",
      details: { reason: "discovery_read_failed", source_path: source },
    });
  });

  test("fails typed when an identity source is unreadable", async () => {
    const home = await makeHome();
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    await mkdir(codexDir, { recursive: true });
    const source = join(
      codexDir,
      "rollout-2026-04-28T12-00-00-019dcafe-1111-7222-8333-abcabcabcabc.jsonl",
    );
    await writeFile(
      source,
      JSON.stringify({
        type: "session_meta",
        payload: { id: "019dcafe-1111-7222-8333-abcabcabcabc", timestamp: "2026-04-28T12:00:00.000Z" },
      }),
      "utf8",
    );
    await expect(listInteractiveSessionsPage({
      homeDir: home,
      limit: 1,
      beforeIdentityRead: async () => rm(source),
    })).rejects.toMatchObject({
      code: "activity_projection_not_ready",
      details: { reason: "identity_read_failed", source_path: source },
    });
  });

  test("fails typed when a selected source disappears before its rich read", async () => {
    const home = await makeHome();
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    await mkdir(codexDir, { recursive: true });
    const source = join(
      codexDir,
      "rollout-2026-04-28T12-00-00-019dcafe-1111-7222-8333-abcabcabcabc.jsonl",
    );
    await writeFile(
      source,
      JSON.stringify({
        type: "session_meta",
        payload: { id: "019dcafe-1111-7222-8333-abcabcabcabc", timestamp: "2026-04-28T12:00:00.000Z" },
      }),
      "utf8",
    );
    await expect(listInteractiveSessionsPage({
      homeDir: home,
      limit: 1,
      beforePageMetadataRead: async () => rm(source),
    })).rejects.toMatchObject({
      code: "activity_projection_not_ready",
      details: { reason: "metadata_read_failed", source_path: source },
    });
  });
});
