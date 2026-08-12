import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  applyStateMigrations,
  countActivityMessages,
  listActivityAttachmentsForMessageIds,
  listActivityMessagesForActivity,
  listActivitySourceCursors,
  openStateStore,
  readActivitySourceCursor,
  readLatestActivityIndexRun,
  summarizeActivityIndexFreshness,
  upsertActivitySourceCursor,
} from "@polli-labs/calyx-core";

import { ActivityTailer } from "../activity-tailer.js";
import { discoverInteractiveSessionFiles } from "../interactive-activity.js";
import {
  ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
  ACTIVITY_RECALL_STORE_BLOCKED_RECONCILIATION,
  ACTIVITY_RECALL_STORE_BLOCKED_PARSE_WARNINGS,
  inspectActivityMessages,
  inspectActivityTurns,
} from "../activity-messages.js";
import { RunService } from "./support/test-run-service.js";

const SESSION_ID = "019dcafe-1111-7222-8333-abcabcabcabc";
const ACTIVITY_ID = `interactive:codex:${SESSION_ID}`;
const CODEX_FILE = `rollout-2026-04-28T12-00-00-${SESSION_ID}.jsonl`;
const RENAMED_CODEX_FILE = `rollout-2026-04-29T13-00-00-${SESSION_ID}.jsonl`;
const TEST_HOST = hostname();

const ENV_KEYS = [
  "CALYX_STATE_HOME",
  "CALYX_STATE_DB",
  "CALYX_RUNS_ROOT",
  "CALYX_CONTEXT_CODEX_SESSIONS_ROOT",
  "CODEX_SESSIONS_ROOT",
  "CODEX_HOME",
  "CALYX_CONTEXT_CLAUDE_PROJECTS_ROOT",
  "CLAUDE_PROJECTS_ROOT",
  "CLAUDE_HOME",
] as const;
const created: string[] = [];

function codexMeta(): string {
  return JSON.stringify({
    timestamp: "2026-04-28T12:00:00.000Z",
    type: "session_meta",
    payload: { id: SESSION_ID, timestamp: "2026-04-28T12:00:00.000Z", cwd: "/tmp/work" },
  });
}
function codexUser(text: string): string {
  return JSON.stringify({
    timestamp: "2026-04-28T12:00:01.000Z",
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
}
function codexAssistant(text: string): string {
  return JSON.stringify({
    timestamp: "2026-04-28T12:00:03.000Z",
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  });
}
function codexUserImage(text: string, dataUrl: string): string {
  return JSON.stringify({
    timestamp: "2026-04-28T12:00:02.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text },
        { type: "input_image", image_url: dataUrl },
      ],
    },
  });
}
function codexToolCall(name: string): string {
  return JSON.stringify({
    timestamp: "2026-04-28T12:00:04.000Z",
    type: "response_item",
    payload: { type: "function_call", name, arguments: "{}" },
  });
}
function codexToolResult(text: string): string {
  return JSON.stringify({
    timestamp: "2026-04-28T12:00:05.000Z",
    type: "response_item",
    payload: { type: "function_call_output", call_id: "call-1", output: text },
  });
}

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "calyx-tailer-home-"));
  created.push(home);
  return home;
}

async function writeCodexSession(home: string, lines: string[]): Promise<string> {
  const dir = join(home, ".codex", "sessions", "2026", "04", "28");
  await mkdir(dir, { recursive: true });
  const path = join(dir, CODEX_FILE);
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

async function writeArchivedCodexSession(
  home: string,
  lines: string[],
  filename = CODEX_FILE,
): Promise<string> {
  const dir = join(home, ".codex", "archived_sessions");
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

function makeTailer(home: string, maxSources?: number): ActivityTailer {
  return new ActivityTailer(
    {
      enabled: true,
      host: TEST_HOST,
      homeDir: home,
      calyxRunsRoot: join(home, ".calyx", "runs"),
      watch: false,
      sinceMs: 0,
      ...(maxSources !== undefined ? { maxSources } : {}),
    },
    { now: () => "2026-06-19T00:00:00.000Z" },
  );
}

/**
 * Write one minimal codex session file with a distinct session id and an
 * explicit mtime (older index => older file). Returns the file path and the
 * activity id the tailer/read path will mint for it.
 */
async function writeCodexSessionAt(
  home: string,
  index: number,
  mtimeSeconds: number,
): Promise<{ path: string; activityId: string }> {
  const sessionId = `019dcafe-2222-7333-8444-${String(index).padStart(12, "0")}`;
  const lines = [
    JSON.stringify({
      timestamp: "2026-04-28T12:00:00.000Z",
      type: "session_meta",
      payload: { id: sessionId, timestamp: "2026-04-28T12:00:00.000Z", cwd: "/tmp/work" },
    }),
    codexUser(`Prompt ${index}.`),
    codexAssistant(`Reply ${index}.`),
  ];
  const dir = join(home, ".codex", "sessions", "2026", "04", "28");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-2026-04-28T12-00-00-${sessionId}.jsonl`);
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  // Deterministic mtime ordering so "newest page first" is well-defined.
  await utimes(path, mtimeSeconds, mtimeSeconds);
  return { path, activityId: `interactive:codex:${sessionId}` };
}

describe("ActivityTailer ingest (POL-1838)", () => {
  let stateHome: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const k of ENV_KEYS) delete process.env[k];
    const root = await mkdtemp(join(tmpdir(), "calyx-tailer-state-"));
    created.push(root);
    stateHome = join(root, "state");
    process.env["CALYX_STATE_HOME"] = stateHome;
    await applyStateMigrations();
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
    created.length = 0;
  });

  test("ingests a transcript and the stored rows match the live projection (one normalizer)", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexMeta(),
      codexUser("First human prompt."),
      codexAssistant("First assistant reply."),
    ]);

    const tailer = makeTailer(home);
    const tick = await tailer.tickOnce();
    expect(tick.status).toBe("ok");
    expect(tick.sourcesScanned).toBe(1);
    expect(tick.sourcesChanged).toBe(1);

    // Live projection over the same file via the canonical read path.
    const live = await inspectActivityMessages({
      homeDir: home,
      activityId: ACTIVITY_ID,
      selector: { visibility: "all", first: 1000, max_text_chars: 100000 },
    });

    const opened = await openStateStore();
    try {
      const stored = listActivityMessagesForActivity(opened.db, ACTIVITY_ID);
      // Same set of message ids and same normalized text/origin — the store is
      // the normalizer's output, not a re-derivation.
      expect(stored.map((r) => r.message_id).sort()).toEqual(
        live.messages.map((m) => m.id).sort(),
      );
      for (const message of live.messages) {
        const row = stored.find((r) => r.message_id === message.id);
        expect(row, `stored row for ${message.id}`).toBeDefined();
        expect(row!.origin).toBe(message.role);
        expect(row!.text).toBe(message.text ?? "");
        expect(row!.turn_id ?? undefined).toBe(message.turn_id);
        expect(row!.classifier_version).toBe(ACTIVITY_MESSAGE_CLASSIFIER_VERSION);
        expect(row!.timestamp).toBe(message.timestamp);
        expect(row!.payload_json).toBeDefined();
        expect(JSON.parse(row!.payload_json!).schema_version).toBe("activity.message-payload/v1");
      }

      const cursor = readActivitySourceCursor(opened.db, live.session_path);
      expect(cursor).toBeDefined();
      // Cursor fully consumed (file ends with a newline): no pending tail.
      expect(cursor!.byte_offset).toBe(cursor!.size_bytes);
      expect(cursor!.classifier_version).toBe(ACTIVITY_MESSAGE_CLASSIFIER_VERSION);

      const run = readLatestActivityIndexRun(opened.db);
      expect(run?.status).toBe("ok");
      expect(run?.messages_upserted).toBeGreaterThan(0);
    } finally {
      opened.db.close();
    }
  });

  test("uses one ambient Claude root for watching, discovery, and ingestion", async () => {
    const home = await makeHome();
    const claudeHome = join(home, "custom-claude-home");
    const claudeRoot = join(claudeHome, "projects");
    const claudePath = join(
      claudeRoot,
      "-tmp-coherent",
      "a0db0b5e-a49a-4a51-8733-c71bb2e8047d.jsonl",
    );
    const codexHome = join(home, "empty-codex");
    const calyxRoot = join(home, "empty-calyx-runs");
    process.env["CLAUDE_HOME"] = claudeHome;
    await mkdir(join(claudeRoot, "-tmp-coherent"), { recursive: true });
    await mkdir(join(codexHome, "sessions"), { recursive: true });
    await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
    await mkdir(calyxRoot, { recursive: true });
    await writeFile(claudePath, `${JSON.stringify({
      type: "user",
      sessionId: "a0db0b5e-a49a-4a51-8733-c71bb2e8047d",
      timestamp: "2026-04-28T12:05:00.000Z",
      cwd: "/tmp/coherent",
      message: { role: "user", content: "One Claude root." },
    })}\n`, "utf8");

    const tailer = new ActivityTailer(
      {
        enabled: true,
        host: TEST_HOST,
        codexSessionsRoot: join(codexHome, "sessions"),
        codexArchivedSessionsRoot: join(codexHome, "archived_sessions"),
        calyxRunsRoot: calyxRoot,
        watch: false,
        sinceMs: 0,
      },
      { now: () => "2026-06-19T00:00:00.000Z" },
    );

    const watchedRoots = (tailer as unknown as { watchedRoots(): string[] }).watchedRoots();
    expect(watchedRoots[2]).toBe(claudeRoot);
    await expect(discoverInteractiveSessionFiles({ kinds: ["claude"], sinceMs: 0 }))
      .resolves.toEqual([expect.objectContaining({ path: claudePath })]);
    await expect(tailer.tickOnce()).resolves.toMatchObject({
      status: "ok",
      sourcesScanned: 1,
      sourcesChanged: 1,
      errors: 0,
    });

    const opened = await openStateStore();
    try {
      expect(readActivitySourceCursor(opened.db, claudePath)?.activity_id).toBe(
        "interactive:claude:a0db0b5e-a49a-4a51-8733-c71bb2e8047d",
      );
    } finally {
      opened.db.close();
    }
  });

  test("indexes archived Codex truth without surfacing it through discovery", async () => {
    const home = await makeHome();
    const archivedPath = await writeArchivedCodexSession(home, [
      codexMeta(),
      codexUser("Archived prompt."),
      codexAssistant("Archived reply."),
    ]);

    const tailer = makeTailer(home);
    await expect(tailer.tickOnce()).resolves.toMatchObject({
      status: "ok",
      sourcesScanned: 1,
      sourcesChanged: 1,
    });

    const service = new RunService({
      runsRoot: join(home, ".calyx", "runs"),
      interactiveHomeDir: home,
    });
    const result = await service.inspectActivityMessages({
      activityId: ACTIVITY_ID,
      selector: { role: "assistant", last: 1 },
    });
    expect(result.session_path).toBe(archivedPath);
    expect(result.messages[0]?.text).toBe("Archived reply.");
    expect(result.recall_freshness?.store_state).toBe("fresh");
  });

  test("relocates one Codex cursor and stable rows across archive and restore", async () => {
    const home = await makeHome();
    process.env["CODEX_HOME"] = join(home, "foreign-codex-home");
    const activePath = await writeCodexSession(home, [
      codexMeta(),
      codexUser("Move me."),
      codexAssistant("Identity stays stable."),
    ]);
    const archiveDir = join(home, ".codex", "archived_sessions");
    const archivedPath = join(archiveDir, CODEX_FILE);
    await mkdir(archiveDir, { recursive: true });

    const tailer = makeTailer(home);
    await expect(tailer.tickOnce()).resolves.toMatchObject({ status: "ok", sourcesChanged: 1 });
    let originalIds: string[];
    let originalCount: number;
    {
      const opened = await openStateStore();
      try {
        const rows = listActivityMessagesForActivity(opened.db, ACTIVITY_ID);
        originalIds = rows.map((row) => row.message_id);
        originalCount = rows.length;
        expect(readActivitySourceCursor(opened.db, activePath)?.activity_id).toBe(ACTIVITY_ID);
      } finally {
        opened.db.close();
      }
    }

    await rename(activePath, archivedPath);
    await expect(tailer.tickOnce()).resolves.toMatchObject({
      status: "ok",
      sourcesScanned: 0,
      sourcesChanged: 0,
      messagesUpserted: 0,
    });
    {
      const opened = await openStateStore();
      try {
        expect(readActivitySourceCursor(opened.db, activePath)).toBeUndefined();
        expect(readActivitySourceCursor(opened.db, archivedPath)?.activity_id).toBe(ACTIVITY_ID);
        expect(listActivitySourceCursors(opened.db).map((cursor) => cursor.source_path)).toEqual([
          archivedPath,
        ]);
        const rows = listActivityMessagesForActivity(opened.db, ACTIVITY_ID);
        expect(rows).toHaveLength(originalCount);
        expect(rows.map((row) => row.message_id)).toEqual(originalIds);
        expect(new Set(rows.map((row) => row.source_path))).toEqual(new Set([archivedPath]));
      } finally {
        opened.db.close();
      }
    }

    await rename(archivedPath, activePath);
    await expect(tailer.tickOnce()).resolves.toMatchObject({
      status: "ok",
      sourcesScanned: 0,
      sourcesChanged: 0,
      messagesUpserted: 0,
    });
    {
      const opened = await openStateStore();
      try {
        expect(readActivitySourceCursor(opened.db, archivedPath)).toBeUndefined();
        expect(readActivitySourceCursor(opened.db, activePath)?.activity_id).toBe(ACTIVITY_ID);
        expect(listActivitySourceCursors(opened.db).map((cursor) => cursor.source_path)).toEqual([
          activePath,
        ]);
        const rows = listActivityMessagesForActivity(opened.db, ACTIVITY_ID);
        expect(rows).toHaveLength(originalCount);
        expect(rows.map((row) => row.message_id)).toEqual(originalIds);
        expect(new Set(rows.map((row) => row.source_path))).toEqual(new Set([activePath]));
      } finally {
        opened.db.close();
      }
    }
  });

  test("contains a Codex active/archive collision while ingesting unrelated Calyx activity", async () => {
    const home = await makeHome();
    const lines = [
      codexMeta(),
      codexUser("Conflicting copy."),
      codexAssistant("Do not ingest either copy."),
    ];
    const activePath = await writeCodexSession(home, lines);
    const archivedPath = await writeArchivedCodexSession(home, lines, RENAMED_CODEX_FILE);
    const activeDir = dirname(activePath);
    const nonCanonicalActivePath = `${activeDir}${sep}..${sep}${basename(activeDir)}${sep}${basename(activePath)}`;
    const activeInfo = await stat(activePath);
    {
      const seeded = await openStateStore();
      try {
        upsertActivitySourceCursor(seeded.db, {
          source_path: nonCanonicalActivePath,
          backend: "codex",
          activity_id: ACTIVITY_ID,
          byte_offset: 17,
          next_line: 4,
          resume_offset: 5,
          resume_line: 2,
          size_bytes: activeInfo.size,
          mtime_ms: activeInfo.mtimeMs,
          classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
          message_count: 1,
          updated_at: "2026-06-18T00:00:00.000Z",
        });
      } finally {
        seeded.db.close();
      }
    }
    const runDir = join(home, ".calyx", "runs", "run-collision-bystander");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run_record.json"), JSON.stringify({
      run_id: "run-collision-bystander",
      intent: { backend: "codex" },
    }), "utf8");
    const eventsPath = join(runDir, "events.jsonl");
    await writeFile(eventsPath, `${JSON.stringify({
      timestamp: "2026-04-28T12:00:00.000Z",
      run_id: "run-collision-bystander",
      event: "created",
      message: "Unrelated Calyx activity survives.",
    })}\n`, "utf8");
    const errors: Error[] = [];
    const tailer = new ActivityTailer(
      {
        enabled: true,
        host: TEST_HOST,
        homeDir: home,
        calyxRunsRoot: join(home, ".calyx", "runs"),
        watch: false,
        sinceMs: 0,
      },
      {
        now: () => "2026-06-19T00:00:00.000Z",
        onError: (error) => errors.push(error),
      },
    );

    await expect(tailer.tickOnce()).resolves.toMatchObject({
      status: "ok",
      sourcesScanned: 1,
      sourcesChanged: 1,
      sourcesPending: 0,
      errors: 1,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("exists in active and archive roots");

    const opened = await openStateStore();
    try {
      expect(listActivityMessagesForActivity(opened.db, ACTIVITY_ID)).toEqual([]);
      expect(readActivitySourceCursor(opened.db, activePath)).toMatchObject({
        byte_offset: 17,
        next_line: 4,
        resume_offset: 5,
        resume_line: 2,
        message_count: 1,
        content_hash: ACTIVITY_RECALL_STORE_BLOCKED_RECONCILIATION,
      });
      expect(readActivitySourceCursor(opened.db, nonCanonicalActivePath)).toBeUndefined();
      expect(readActivitySourceCursor(opened.db, archivedPath)).toMatchObject({
        byte_offset: 0,
        content_hash: ACTIVITY_RECALL_STORE_BLOCKED_RECONCILIATION,
      });
      const bystanderActivityId = "interactive:codex:run-collision-bystander";
      expect(listActivityMessagesForActivity(opened.db, bystanderActivityId).map((row) => row.text))
        .toEqual(["Unrelated Calyx activity survives."]);
      expect(readActivitySourceCursor(opened.db, eventsPath)?.activity_id).toBe(bystanderActivityId);
      expect(readLatestActivityIndexRun(opened.db)).toMatchObject({
        status: "error",
        sources_scanned: 1,
        sources_pending: 0,
        error: "1 source(s) failed",
      });
    } finally {
      opened.db.close();
    }

    await rm(archivedPath);
    await expect(tailer.tickOnce()).resolves.toMatchObject({
      status: "ok",
      sourcesScanned: 1,
      sourcesChanged: 1,
      sourcesPending: 0,
      errors: 0,
    });

    const recovered = await openStateStore();
    try {
      expect(readActivitySourceCursor(recovered.db, archivedPath)).toBeUndefined();
      expect(readActivitySourceCursor(recovered.db, activePath)).toMatchObject({
        activity_id: ACTIVITY_ID,
      });
      expect(readActivitySourceCursor(recovered.db, activePath)?.content_hash).toBeUndefined();
      expect(listActivityMessagesForActivity(recovered.db, ACTIVITY_ID)).toHaveLength(3);
      expect(listActivitySourceCursors(recovered.db).map((cursor) => cursor.source_path).sort())
        .toEqual([activePath, eventsPath].sort());
    } finally {
      recovered.db.close();
    }
  });

  test("quarantines aliased cursor spellings without wedging unrelated sources and rebuilds", async () => {
    const home = await makeHome();
    const activePath = await writeCodexSession(home, [
      codexMeta(),
      codexUser("Canonical transcript truth."),
      codexAssistant("Rebuild this projection."),
    ]);
    const runDir = join(home, ".calyx", "runs", "run-alias-bystander");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run_record.json"), JSON.stringify({
      run_id: "run-alias-bystander",
      intent: { backend: "codex" },
    }), "utf8");
    const eventsPath = join(runDir, "events.jsonl");
    await writeFile(eventsPath, `${JSON.stringify({
      timestamp: "2026-04-28T12:00:00.000Z",
      run_id: "run-alias-bystander",
      event: "created",
      message: "Bystander before alias repair.",
    })}\n`, "utf8");

    await expect(makeTailer(home).tickOnce()).resolves.toMatchObject({
      status: "ok",
      sourcesScanned: 2,
      sourcesChanged: 2,
      errors: 0,
    });

    const activeDir = dirname(activePath);
    const nonCanonicalActivePath = `${activeDir}${sep}..${sep}${basename(activeDir)}${sep}${basename(activePath)}`;
    {
      const seeded = await openStateStore();
      try {
        const canonicalCursor = readActivitySourceCursor(seeded.db, activePath);
        expect(canonicalCursor).toBeDefined();
        upsertActivitySourceCursor(seeded.db, {
          ...canonicalCursor!,
          source_path: nonCanonicalActivePath,
          byte_offset: 17,
          next_line: 2,
          resume_offset: 0,
          resume_line: 1,
          message_count: 1,
          updated_at: "2026-06-19T00:00:01.000Z",
        });
      } finally {
        seeded.db.close();
      }
    }
    await appendFile(eventsPath, `${JSON.stringify({
      timestamp: "2026-04-28T12:00:01.000Z",
      run_id: "run-alias-bystander",
      event: "started",
      message: "Bystander progresses during alias repair.",
    })}\n`, "utf8");

    const errors: Error[] = [];
    let now = "2026-06-19T00:00:02.000Z";
    const tailer = new ActivityTailer(
      {
        enabled: true,
        host: TEST_HOST,
        homeDir: home,
        calyxRunsRoot: join(home, ".calyx", "runs"),
        watch: false,
        sinceMs: 0,
      },
      {
        now: () => now,
        onError: (error) => errors.push(error),
      },
    );

    await expect(tailer.tickOnce()).resolves.toMatchObject({
      status: "ok",
      sourcesScanned: 1,
      sourcesChanged: 1,
      sourcesPending: 0,
      errors: 1,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("Multiple activity source cursors normalize to one path");

    {
      const quarantined = await openStateStore();
      try {
        expect(readActivitySourceCursor(quarantined.db, nonCanonicalActivePath)).toBeUndefined();
        expect(readActivitySourceCursor(quarantined.db, activePath)).toMatchObject({
          byte_offset: 0,
          next_line: 1,
          resume_offset: 0,
          resume_line: 1,
          message_count: 0,
          content_hash: ACTIVITY_RECALL_STORE_BLOCKED_RECONCILIATION,
        });
        expect(listActivityMessagesForActivity(quarantined.db, ACTIVITY_ID)).toEqual([]);
        const bystanderActivityId = "interactive:codex:run-alias-bystander";
        expect(listActivityMessagesForActivity(quarantined.db, bystanderActivityId).map((row) => row.text))
          .toEqual([
            "Bystander before alias repair.",
            "Bystander progresses during alias repair.",
          ]);
        expect(readLatestActivityIndexRun(quarantined.db)).toMatchObject({
          status: "error",
          sources_scanned: 1,
          sources_changed: 1,
          error: "1 source(s) failed",
        });
      } finally {
        quarantined.db.close();
      }
    }

    now = "2026-06-19T00:00:03.000Z";
    await expect(tailer.tickOnce()).resolves.toMatchObject({
      status: "ok",
      sourcesScanned: 1,
      sourcesChanged: 1,
      sourcesPending: 0,
      messagesUpserted: 3,
      errors: 0,
    });
    expect(errors).toHaveLength(1);

    const recovered = await openStateStore();
    try {
      expect(readActivitySourceCursor(recovered.db, nonCanonicalActivePath)).toBeUndefined();
      expect(readActivitySourceCursor(recovered.db, activePath)).toMatchObject({
        activity_id: ACTIVITY_ID,
        message_count: 3,
      });
      expect(readActivitySourceCursor(recovered.db, activePath)?.content_hash).toBeUndefined();
      expect(listActivityMessagesForActivity(recovered.db, ACTIVITY_ID)).toHaveLength(3);
      expect(readLatestActivityIndexRun(recovered.db)).toMatchObject({
        status: "ok",
        sources_scanned: 1,
        sources_changed: 1,
      });
    } finally {
      recovered.db.close();
    }
  });

  test("ingests attachment metadata without bytes into activity_attachments", async () => {
    const home = await makeHome();
    const imageBytes = Buffer.from("tiny image bytes");
    const dataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
    const digest = createHash("sha256").update(imageBytes).digest("hex");
    await writeCodexSession(home, [
      codexMeta(),
      codexUserImage("Inspect this image.", dataUrl),
    ]);

    const tailer = makeTailer(home);
    const tick = await tailer.tickOnce();
    expect(tick.status).toBe("ok");

    const opened = await openStateStore();
    try {
      const stored = listActivityMessagesForActivity(opened.db, ACTIVITY_ID);
      const imageRow = stored.find((row) => row.attachment_refs.includes(digest));
      expect(imageRow).toBeDefined();
      const attachments = listActivityAttachmentsForMessageIds(opened.db, [imageRow!.message_id]);
      expect(attachments).toEqual([
        {
          attachment_id: `${imageRow!.message_id}:att:${digest}`,
          message_id: imageRow!.message_id,
          origin: "human",
          sha256: digest,
          mime: "image/png",
          byte_size: imageBytes.length,
          observed_at: "2026-06-19T00:00:00.000Z",
        },
      ]);
      const payload = JSON.parse(imageRow!.payload_json!);
      expect(payload.attachments).toEqual([
        {
          ref: `att:sha256:${digest}`,
          source_shape: "codex.input_image.data_url",
          exact_bytes_available: true,
          source_line: 2,
          event_index: 1,
        },
      ]);
    } finally {
      opened.db.close();
    }
  });

  test("discovers and ingests ~/.calyx/runs event streams as a source class", async () => {
    const home = await makeHome();
    const runDir = join(home, ".calyx", "runs", "run-calyx-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run_record.json"), JSON.stringify({
      run_id: "run-calyx-1",
      intent: { backend: "codex" },
    }), "utf8");
    await writeFile(join(runDir, "events.jsonl"), `${JSON.stringify({
      timestamp: "2026-04-28T12:00:00.000Z",
      run_id: "run-calyx-1",
      event: "created",
      message: "Created Calyx run.",
    })}\n`, "utf8");

    const tailer = makeTailer(home);
    const tick = await tailer.tickOnce();
    expect(tick.status).toBe("ok");
    expect(tick.sourcesScanned).toBe(1);

    const opened = await openStateStore();
    try {
      const activityId = "interactive:codex:run-calyx-1";
      const rows = listActivityMessagesForActivity(opened.db, activityId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.source_path).toBe(join(runDir, "events.jsonl"));
      expect(rows[0]?.text).toBe("Created Calyx run.");
      const cursor = readActivitySourceCursor(opened.db, join(runDir, "events.jsonl"));
      expect(cursor?.activity_id).toBe(activityId);
    } finally {
      opened.db.close();
    }

    const service = new RunService({
      runsRoot: join(home, ".calyx", "runs"),
      interactiveHomeDir: home,
    });
    const result = await service.inspectActivityMessages({
      activityId: "interactive:codex:run-calyx-1",
      selector: { visibility: "all", first: 10, max_text_chars: 100000 },
    });
    expect(result.source).toBe("calyx_runs");
    expect(result.messages.map((message) => message.text)).toEqual(["Created Calyx run."]);
    expect(result.recall_freshness?.store_state).toBe("fresh");

    const messageId = result.messages[0]!.id;
    const events = await service.inspectActivityEvents({
      activityId: "interactive:codex:run-calyx-1",
      selector: { tail: 10, classify: true },
    });
    expect(events.source).toBe("calyx_runs");
    expect(events.events.map((event) => event.text)).toEqual(["Created Calyx run."]);
    const text = await service.inspectActivityText({ messageId });
    expect(text.text).toBe("Created Calyx run.");

    {
      const opened = await openStateStore();
      try {
        opened.db
          .prepare("UPDATE activity_messages SET payload_json = NULL WHERE activity_id = ?")
          .run("interactive:codex:run-calyx-1");
      } finally {
        opened.db.close();
      }
    }
    const fallback = await service.inspectActivityMessages({
      activityId: "interactive:codex:run-calyx-1",
      selector: { visibility: "all", first: 10, max_text_chars: 100000 },
    });
    expect(fallback.source).toBe("calyx_runs");
    expect(fallback.messages.map((message) => message.text)).toEqual(["Created Calyx run."]);
    expect(fallback.recall_freshness?.store_state).toBe("fresh");
  });

  test("service tailer follows a custom runsRoot for Calyx run event streams", async () => {
    const home = await makeHome();
    const runsRoot = join(home, "custom-runs-root");
    const runDir = join(runsRoot, "run-custom-root");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run_record.json"), JSON.stringify({
      run_id: "run-custom-root",
      intent: { backend: "codex" },
    }), "utf8");
    await writeFile(join(runDir, "events.jsonl"), `${JSON.stringify({
      timestamp: "2026-04-28T12:00:00.000Z",
      run_id: "run-custom-root",
      event: "created",
      message: "Created custom-root run.",
    })}\n`, "utf8");

    const service = new RunService({
      runsRoot,
      interactiveHomeDir: home,
      activityTailer: { enabled: true, host: TEST_HOST, watch: false },
    });
    const tick = await service.tickActivityTailerOnce();
    expect(tick.status).toBe("ok");
    expect(tick.sourcesScanned).toBe(1);

    const result = await service.inspectActivityMessages({
      activityId: "interactive:codex:run-custom-root",
      selector: { visibility: "all", first: 10, max_text_chars: 100000 },
    });
    expect(result.source).toBe("calyx_runs");
    expect(result.messages.map((message) => message.text)).toEqual(["Created custom-root run."]);
    expect(result.recall_freshness?.store_state).toBe("fresh");
  });

  test("resumes from the cursor on append without re-ingesting prior lines", async () => {
    const home = await makeHome();
    const path = await writeCodexSession(home, [codexMeta(), codexUser("One.")]);
    const tailer = makeTailer(home);
    await tailer.tickOnce();

    const opened1 = await openStateStore();
    let firstOffset: number;
    let firstCount: number;
    try {
      const cursor = readActivitySourceCursor(opened1.db, path)!;
      firstOffset = cursor.byte_offset;
      firstCount = countActivityMessages(opened1.db);
    } finally {
      opened1.db.close();
    }
    expect(firstCount).toBeGreaterThan(0);

    // Append a new committed line; the next tick should read only the delta.
    const appended = `${codexAssistant("Two.")}\n`;
    await appendFile(path, appended, "utf8");
    const tick2 = await tailer.tickOnce();
    expect(tick2.status).toBe("ok");
    // Only the appended bytes were read on the resume, not the whole file.
    expect(tick2.bytesIngested).toBe(Buffer.byteLength(appended, "utf8"));

    const opened2 = await openStateStore();
    try {
      const cursor = readActivitySourceCursor(opened2.db, path)!;
      expect(cursor.byte_offset).toBeGreaterThan(firstOffset);
      expect(cursor.byte_offset).toBe(cursor.size_bytes);
      expect(countActivityMessages(opened2.db)).toBe(firstCount + 1);
    } finally {
      opened2.db.close();
    }

    // A third tick with no change ingests nothing (idempotent / incremental).
    const tick3 = await tailer.tickOnce();
    expect(tick3.sourcesChanged).toBe(0);
    expect(tick3.bytesIngested).toBe(0);
  });

  test("incremental ticks keep turn ids identical to a full live projection (P1-2)", async () => {
    const home = await makeHome();
    // An assistant turn that opens before the first byte cursor and then grows.
    const path = await writeCodexSession(home, [
      codexMeta(),
      codexUser("Investigate."),
      codexAssistant("Working on it."),
      codexToolCall("shell"),
      codexToolResult("ok"),
    ]);
    const tailer = makeTailer(home);
    await tailer.tickOnce();

    // Append more tool activity that canonically belongs to the SAME assistant
    // turn (no new human/assistant message). A naive mid-turn byte resume would
    // open a spurious new turn for these records.
    await appendFile(path, `${codexToolCall("grep")}\n${codexToolResult("found")}\n`, "utf8");
    await tailer.tickOnce();

    // Full live projection over the whole file is the canonical truth.
    const live = await inspectActivityMessages({
      homeDir: home,
      activityId: ACTIVITY_ID,
      selector: { visibility: "all", first: 1000, max_text_chars: 100000 },
    });
    const liveTurnById = new Map(live.messages.map((m) => [m.id, m.turn_id]));

    const opened = await openStateStore();
    try {
      const stored = listActivityMessagesForActivity(opened.db, ACTIVITY_ID);
      // Every stored row's turn id matches the canonical full-parse turn id —
      // the appended tool records attach to the original assistant turn, not a
      // spurious new one.
      expect(stored.map((r) => r.message_id).sort()).toEqual(
        live.messages.map((m) => m.id).sort(),
      );
      for (const row of stored) {
        expect(row.turn_id ?? undefined, `turn_id for ${row.message_id}`).toBe(
          liveTurnById.get(row.message_id),
        );
      }
      // Sanity: the appended tool result shares the assistant message's turn.
      const assistantRow = stored.find((r) => r.origin === "assistant");
      const lastToolRow = stored.filter((r) => r.origin === "tool_result").at(-1);
      expect(assistantRow?.turn_id).toBeDefined();
      expect(lastToolRow?.turn_id).toBe(assistantRow?.turn_id);
    } finally {
      opened.db.close();
    }
  });

  test("backfills sources beyond the per-tick page instead of trapping them outside the newest window (P2-1)", async () => {
    const home = await makeHome();
    // More discovered sources than a single page can hold: 5 files, page size 2.
    // The two oldest sit beyond the newest-2 window and must still be reached.
    const baseMtime = 1_700_000_000; // fixed epoch seconds; index adds offset.
    const sessions: Array<{ path: string; activityId: string }> = [];
    for (let i = 0; i < 5; i += 1) {
      sessions.push(await writeCodexSessionAt(home, i, baseMtime + i));
    }
    const oldest = sessions[0]!; // smallest mtime => last to be paged in.
    const newest = sessions[4]!;
    const tailer = makeTailer(home, 2);

    // Tick 1: only the newest page (2 sources) is fully ingested. The remaining
    // older sources are registered as `pending` cursors, not left `absent`.
    const tick1 = await tailer.tickOnce();
    expect(tick1.status).toBe("ok");
    expect(tick1.sourcesScanned).toBe(2);
    expect(tick1.sourcesPending).toBe(3);

    {
      const opened = await openStateStore();
      try {
        // Newest is ingested immediately (steady-state freshness).
        expect(listActivityMessagesForActivity(opened.db, newest.activityId).length).toBeGreaterThan(0);
        // Oldest is NOT yet ingested, but IS cursored as pending (visible, not absent).
        const oldestCursor = readActivitySourceCursor(opened.db, oldest.path);
        expect(oldestCursor, "oldest source cursored as pending after tick 1").toBeDefined();
        expect(oldestCursor!.byte_offset).toBe(0);
        expect(oldestCursor!.message_count).toBe(0);
        expect(oldestCursor!.size_bytes).toBeGreaterThan(0);
        expect(listActivityMessagesForActivity(opened.db, oldest.activityId).length).toBe(0);
        // Freshness reflects the whole backlog as pending, not a phantom-complete store.
        const freshness = summarizeActivityIndexFreshness(opened.db);
        expect(freshness.source_count).toBe(5);
        expect(freshness.pending_sources).toBe(3);
      } finally {
        opened.db.close();
      }
    }

    // Successive ticks rotate the page across the backlog until every source —
    // including the oldest, beyond the newest window — is fully ingested.
    for (let i = 0; i < 3; i += 1) {
      await tailer.tickOnce();
    }

    {
      const opened = await openStateStore();
      try {
        for (const session of sessions) {
          const cursor = readActivitySourceCursor(opened.db, session.path);
          expect(cursor, `cursor for ${session.path}`).toBeDefined();
          expect(cursor!.byte_offset).toBe(cursor!.size_bytes);
          expect(
            listActivityMessagesForActivity(opened.db, session.activityId).length,
            `messages ingested for ${session.activityId}`,
          ).toBeGreaterThan(0);
        }
        // Caught up: no pending sources remain.
        expect(summarizeActivityIndexFreshness(opened.db).pending_sources).toBe(0);
      } finally {
        opened.db.close();
      }
    }
  });

  test("backfills a >500-file history (default page) so older sources are not stuck behind the newest 500", async () => {
    const home = await makeHome();
    // One more than the default page (500). The single oldest source sits one
    // slot beyond the newest-500 window on tick 1 and must backfill on tick 2.
    const total = 501;
    const baseMtime = 1_700_000_000;
    const oldest = await writeCodexSessionAt(home, 0, baseMtime); // smallest mtime.
    for (let i = 1; i < total; i += 1) {
      await writeCodexSessionAt(home, i, baseMtime + i);
    }
    const tailer = makeTailer(home); // default page size = 500.

    const tick1 = await tailer.tickOnce();
    expect(tick1.sourcesScanned).toBe(500);
    expect(tick1.sourcesPending).toBe(1);

    {
      const opened = await openStateStore();
      try {
        // Oldest is cursored as pending (not silently absent) but not yet ingested.
        const cursor = readActivitySourceCursor(opened.db, oldest.path);
        expect(cursor, "oldest source cursored as pending").toBeDefined();
        expect(cursor!.byte_offset).toBe(0);
        expect(listActivityMessagesForActivity(opened.db, oldest.activityId).length).toBe(0);
      } finally {
        opened.db.close();
      }
    }

    // Tick 2 pages in the lone backlog source.
    await tailer.tickOnce();

    {
      const opened = await openStateStore();
      try {
        const cursor = readActivitySourceCursor(opened.db, oldest.path)!;
        expect(cursor.byte_offset).toBe(cursor.size_bytes);
        expect(listActivityMessagesForActivity(opened.db, oldest.activityId).length).toBeGreaterThan(0);
        expect(summarizeActivityIndexFreshness(opened.db).pending_sources).toBe(0);
      } finally {
        opened.db.close();
      }
    }
  });

  test("re-ingests from scratch when the classifier version changes", async () => {
    const home = await makeHome();
    const path = await writeCodexSession(home, [codexMeta(), codexUser("Hi."), codexAssistant("Hello.")]);
    const tailer = makeTailer(home);
    await tailer.tickOnce();

    // Simulate a classifier bump by rewriting the cursor with a stale version.
    {
      const opened = await openStateStore();
      try {
        const cursor = readActivitySourceCursor(opened.db, path)!;
        upsertActivitySourceCursor(opened.db, {
          ...cursor,
          classifier_version: "v0.legacy",
        });
      } finally {
        opened.db.close();
      }
    }

    const tick = await tailer.tickOnce();
    expect(tick.status).toBe("ok");
    expect(tick.sourcesChanged).toBe(1);

    const opened = await openStateStore();
    try {
      const cursor = readActivitySourceCursor(opened.db, path)!;
      expect(cursor.classifier_version).toBe(ACTIVITY_MESSAGE_CLASSIFIER_VERSION);
      expect(countActivityMessages(opened.db)).toBeGreaterThan(0);
    } finally {
      opened.db.close();
    }
  });
});

describe("recall freshness read-through (POL-1838)", () => {
  let stateHome: string;
  let runsRoot: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const k of ENV_KEYS) delete process.env[k];
    const root = await mkdtemp(join(tmpdir(), "calyx-tailer-fresh-"));
    created.push(root);
    stateHome = join(root, "state");
    runsRoot = join(root, "runs");
    await mkdir(runsRoot, { recursive: true });
    process.env["CALYX_STATE_HOME"] = stateHome;
    await applyStateMigrations();
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
    created.length = 0;
  });

  test("messages result carries recall_freshness: absent -> fresh -> behind", async () => {
    const home = await makeHome();
    const path = await writeCodexSession(home, [codexMeta(), codexUser("Q."), codexAssistant("A.")]);
    const service = new RunService({ runsRoot, interactiveHomeDir: home });

    // Before any ingest: the source has no cursor.
    const before = await service.inspectActivityMessages({
      activityId: ACTIVITY_ID,
      selector: { visibility: "all" },
    });
    expect(before.recall_freshness?.store_state).toBe("absent");

    // After a tailer tick: fully indexed.
    await makeTailer(home).tickOnce();
    const fresh = await service.inspectActivityMessages({
      activityId: ACTIVITY_ID,
      selector: { visibility: "all" },
    });
    expect(fresh.recall_freshness?.store_state).toBe("fresh");
    expect(fresh.recall_freshness?.fully_indexed).toBe(true);
    expect(fresh.recall_freshness?.pending_bytes).toBe(0);
    expect(fresh.recall_freshness?.store_message_count).toBeGreaterThan(0);

    // After an un-ingested append: the store is behind with a pending tail.
    await appendFile(path, `${codexUser("Follow-up.")}\n`, "utf8");
    const behind = await service.inspectActivityMessages({
      activityId: ACTIVITY_ID,
      selector: { visibility: "all" },
    });
    expect(behind.recall_freshness?.store_state).toBe("behind");
    expect(behind.recall_freshness!.pending_bytes).toBeGreaterThan(0);
  });

  test("fresh messages and turns are served from the store, with live fallback for pre-0014 rows", async () => {
    const home = await makeHome();
    const imageBytes = Buffer.from("store parity image");
    const dataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
    await writeCodexSession(home, [
      codexMeta(),
      codexUser("Store-backed prompt."),
      codexUserImage("Store-backed image.", dataUrl),
      codexAssistant("Store-backed reply."),
      codexToolCall("shell"),
      codexToolResult("ok"),
    ]);
    await makeTailer(home).tickOnce();
    const service = new RunService({ runsRoot, interactiveHomeDir: home });

    const liveMessages = await inspectActivityMessages({
      homeDir: home,
      host: TEST_HOST,
      activityId: ACTIVITY_ID,
      selector: { visibility: "all", first: 1000, max_text_chars: 100000 },
    });
    const storeMessages = await service.inspectActivityMessages({
      activityId: ACTIVITY_ID,
      selector: { visibility: "all", first: 1000, max_text_chars: 100000 },
    });
    expect(storeMessages.messages).toEqual(liveMessages.messages);
    expect(storeMessages.recall_freshness?.store_state).toBe("fresh");

    const liveConsumerMessages = await inspectActivityMessages({
      homeDir: home,
      host: TEST_HOST,
      activityId: ACTIVITY_ID,
      consumerVisibleOnly: true,
      selector: { visibility: "all", first: 2, max_text_chars: 100000 },
    });
    const storeConsumerMessages = await service.inspectActivityMessages({
      activityId: ACTIVITY_ID,
      consumerVisibleOnly: true,
      selector: { visibility: "all", first: 2, max_text_chars: 100000 },
    });
    expect(storeConsumerMessages.messages).toEqual(liveConsumerMessages.messages);
    expect(storeConsumerMessages).toMatchObject({
      total_messages: 3,
      matched_messages: 3,
      returned_messages: 2,
      truncated: true,
    });
    expect(storeConsumerMessages.messages.every((message) => (
      message.visibility === "default" && message.role !== "tool_call" && message.role !== "tool_result"
    ))).toBe(true);

    const liveTurns = await inspectActivityTurns({
      homeDir: home,
      host: TEST_HOST,
      activityId: ACTIVITY_ID,
      selector: { last: 20, with_tools: true, max_text_chars: 100000 },
    });
    const storeTurns = await service.inspectActivityTurns({
      activityId: ACTIVITY_ID,
      selector: { last: 20, with_tools: true, max_text_chars: 100000 },
    });
    expect(storeTurns.turns).toEqual(liveTurns.turns);

    const liveConsumerTurns = await inspectActivityTurns({
      homeDir: home,
      host: TEST_HOST,
      activityId: ACTIVITY_ID,
      consumerVisibleOnly: true,
      selector: { last: 20, max_text_chars: 100000 },
    });
    const storeConsumerTurns = await service.inspectActivityTurns({
      activityId: ACTIVITY_ID,
      consumerVisibleOnly: true,
      selector: { last: 20, max_text_chars: 100000 },
    });
    expect(storeConsumerTurns.turns).toEqual(liveConsumerTurns.turns);
    expect(storeConsumerTurns.total_messages).toBe(3);
    expect(storeConsumerTurns.total_turns).toBe(3);
    expect(storeConsumerTurns.turns.map((turn) => turn.role)).toEqual(["human", "human", "assistant"]);
    expect(storeConsumerTurns.turns.flatMap((turn) => turn.messages).every((message) => (
      message.visibility === "default"
    ))).toBe(true);

    const assistantId = liveMessages.messages.find((message) => message.role === "assistant")!.id;
    {
      const opened = await openStateStore();
      try {
        opened.db
          .prepare("UPDATE activity_messages SET text = ? WHERE message_id = ?")
          .run("STORE ONLY REPLY", assistantId);
      } finally {
        opened.db.close();
      }
    }
    const mutatedStore = await service.inspectActivityMessages({
      activityId: ACTIVITY_ID,
      selector: { role: "assistant", last: 1, max_text_chars: 100000 },
    });
    expect(mutatedStore.messages[0]?.text).toBe("STORE ONLY REPLY");

    {
      const opened = await openStateStore();
      try {
        opened.db
          .prepare("UPDATE activity_messages SET payload_json = NULL WHERE message_id = ?")
          .run(assistantId);
      } finally {
        opened.db.close();
      }
    }
    const fallback = await service.inspectActivityMessages({
      activityId: ACTIVITY_ID,
      selector: { role: "assistant", last: 1, max_text_chars: 100000 },
    });
    expect(fallback.messages[0]?.text).toBe("Store-backed reply.");
    expect(fallback.recall_freshness?.store_state).toBe("fresh");
  });

  test("incremental re-ingest preserves full-file event_refs in store-served DTOs", async () => {
    const home = await makeHome();
    const path = await writeCodexSession(home, [
      codexMeta(),
      codexUser("First prompt."),
      codexAssistant("First reply."),
    ]);
    await makeTailer(home).tickOnce();

    await appendFile(path, `${codexUser("Second prompt.")}\n${codexAssistant("Second reply.")}\n`, "utf8");
    await makeTailer(home).tickOnce();
    const service = new RunService({ runsRoot, interactiveHomeDir: home });

    const live = await inspectActivityMessages({
      homeDir: home,
      host: TEST_HOST,
      activityId: ACTIVITY_ID,
      selector: { visibility: "all", first: 1000, max_text_chars: 100000 },
    });
    const store = await service.inspectActivityMessages({
      activityId: ACTIVITY_ID,
      selector: { visibility: "all", first: 1000, max_text_chars: 100000 },
    });
    expect(store.messages).toEqual(live.messages);
    expect(store.messages.find((message) => message.text === "Second reply.")?.event_refs).toEqual([4]);
    expect(store.recall_freshness?.store_state).toBe("fresh");
  });

  test("parse-warning cursors stay live-served so source_state evidence is preserved", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexMeta(),
      codexUser("Before corrupt line."),
      "{not json",
      codexAssistant("Live reply after corrupt line."),
    ]);
    await makeTailer(home).tickOnce();
    const service = new RunService({ runsRoot, interactiveHomeDir: home });

    const opened = await openStateStore();
    try {
      const cursor = readActivitySourceCursor(opened.db, join(
        home,
        ".codex",
        "sessions",
        "2026",
        "04",
        "28",
        CODEX_FILE,
      ));
      expect(cursor?.content_hash).toBe(ACTIVITY_RECALL_STORE_BLOCKED_PARSE_WARNINGS);
      const assistant = listActivityMessagesForActivity(opened.db, ACTIVITY_ID)
        .find((row) => row.origin === "assistant");
      expect(assistant).toBeDefined();
      opened.db
        .prepare("UPDATE activity_messages SET text = ? WHERE message_id = ?")
        .run("STORE SHOULD NOT SERVE", assistant!.message_id);
    } finally {
      opened.db.close();
    }

    const messages = await service.inspectActivityMessages({
      activityId: ACTIVITY_ID,
      selector: { role: "assistant", last: 1, max_text_chars: 100000 },
    });
    expect(messages.messages[0]?.text).toBe("Live reply after corrupt line.");
    expect(messages.source_state).toBe("partial");
    expect(messages.warnings.map((warning) => warning.code)).toContain("unparseable_line");
    expect(messages.recall_freshness?.store_state).toBe("fresh");

    const turns = await service.inspectActivityTurns({
      activityId: ACTIVITY_ID,
      selector: { last: 10, max_text_chars: 100000 },
    });
    expect(turns.source_state).toBe("partial");
    expect(turns.warnings.map((warning) => warning.code)).toContain("unparseable_line");
  });

  test("transient partial final lines do not permanently block store serving", async () => {
    const home = await makeHome();
    const assistantLine = codexAssistant("Completed reply after partial write.");
    const splitAt = Math.floor(assistantLine.length / 2);
    const dir = join(home, ".codex", "sessions", "2026", "04", "28");
    await mkdir(dir, { recursive: true });
    const path = join(dir, CODEX_FILE);
    await writeFile(path, [
      codexMeta(),
      codexUser("Before partial write."),
      assistantLine.slice(0, splitAt),
    ].join("\n"), "utf8");

    await makeTailer(home).tickOnce();
    {
      const opened = await openStateStore();
      try {
        const cursor = readActivitySourceCursor(opened.db, path);
        expect(cursor?.content_hash).toBeUndefined();
        expect(cursor!.byte_offset).toBeLessThan(cursor!.size_bytes!);
      } finally {
        opened.db.close();
      }
    }

    await appendFile(path, `${assistantLine.slice(splitAt)}\n`, "utf8");
    await makeTailer(home).tickOnce();
    const service = new RunService({ runsRoot, interactiveHomeDir: home });
    {
      const opened = await openStateStore();
      try {
        const cursor = readActivitySourceCursor(opened.db, path);
        expect(cursor?.content_hash).toBeUndefined();
        expect(cursor?.byte_offset).toBe(cursor?.size_bytes);
        const assistant = listActivityMessagesForActivity(opened.db, ACTIVITY_ID)
          .find((row) => row.origin === "assistant");
        expect(assistant).toBeDefined();
        opened.db
          .prepare("UPDATE activity_messages SET text = ? WHERE message_id = ?")
          .run("STORE SERVED AFTER PARTIAL", assistant!.message_id);
      } finally {
        opened.db.close();
      }
    }

    const messages = await service.inspectActivityMessages({
      activityId: ACTIVITY_ID,
      selector: { role: "assistant", last: 1, max_text_chars: 100000 },
    });
    expect(messages.messages[0]?.text).toBe("STORE SERVED AFTER PARTIAL");
    expect(messages.recall_freshness?.store_state).toBe("fresh");
  });

  test("freshness degrades to unavailable when the recall migration is absent", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [codexMeta(), codexUser("Q."), codexAssistant("A.")]);
    // Drop the recall tables to mimic an un-migrated store.
    {
      const opened = await openStateStore();
      try {
        opened.db.exec("DROP TABLE activity_messages");
      } finally {
        opened.db.close();
      }
    }
    const service = new RunService({ runsRoot, interactiveHomeDir: home });
    const result = await service.inspectActivityMessages({
      activityId: ACTIVITY_ID,
      selector: { visibility: "all" },
    });
    expect(result.recall_freshness?.store_state).toBe("unavailable");
    // The live read still returns messages — the store is a cache, not truth.
    expect(result.messages.length).toBeGreaterThan(0);
  });
});
