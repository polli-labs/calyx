import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
  inspectActivityAttachments,
  inspectActivityEvents,
  inspectActivityMessages,
  inspectActivityTurns,
  resolveInteractiveActivity,
} from "../activity-messages.js";
import type { RunRecord } from "../types.js";

const created: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
  created.length = 0;
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "calyx-activity-turns-"));
  created.push(home);
  return home;
}

const CODEX_FILE = "rollout-2026-04-28T12-00-00-019dcafe-1111-7222-8333-abcabcabcabc.jsonl";
const CODEX_SESSION_ID = "019dcafe-1111-7222-8333-abcabcabcabc";
const CODEX_ACTIVITY_ID = `interactive:codex:${CODEX_SESSION_ID}`;
const CODEX_DEEPLINK_FILE_ID = "019dfeed-aaaa-7222-8333-defdefdefdef";
const CODEX_DEEPLINK_META_ID = "019dbabe-bbbb-7222-8333-abcabcabcabc";
const CODEX_DEEPLINK_FILE = `rollout-2026-04-28T12-02-00-${CODEX_DEEPLINK_FILE_ID}.jsonl`;
const CLAUDE_SESSION_ID = "a0db0b5e-a49a-4a51-8733-c71bb2e8047d";
const CLAUDE_ACTIVITY_ID = `interactive:claude:${CLAUDE_SESSION_ID}`;

const AGENTS_PROMPT = "# AGENTS.md instructions for /Users/caleb\n<INSTRUCTIONS>...</INSTRUCTIONS>";

function makeRunRecord(runId: string, sessionPath?: string): RunRecord {
  return {
    schema_version: "1.0",
    run_id: runId,
    state: "succeeded",
    intent: {
      run_id: runId,
      kernel: "agent_runner",
      host: "blade",
      backend: "codex",
      created_at: "2026-04-28T12:00:00.000Z",
    },
    launch: {
      mode: "inline",
      stage: "executing",
      admission_identity: "test-admission",
      request_hash: "test-request",
      accepted_at: "2026-04-28T12:00:00.000Z",
      dispatch_attempts: 0,
    },
    kernel_receipt: {
      schema_version: "1.0",
      run_id: runId,
      state: "succeeded",
      run_spec: {
        run_id: runId,
        host: "blade",
        backend: "codex",
        profile: "medium",
        prompt: "prompt",
        require_execplan: false,
        pull_execplan: false,
        worktree: { mode: "existing", path: "/tmp/worktree" },
      },
      timing: {
        created_at: "2026-04-28T12:00:00.000Z",
        completed_at: "2026-04-28T12:05:00.000Z",
        duration_ms: 300_000,
      },
      exit: { exit_code: 0 },
      artifacts: {
        run_id: runId,
        finalized_at: "2026-04-28T12:05:00.000Z",
        required: [],
        discovered: [],
        gate_passed: true,
        missing: [],
      },
      log_summary: { total: 0, info: 0, warn: 0, error: 0 },
      environment: { host: "blade", backend: "codex", worktree_path: "/tmp/worktree" },
      backend_session: {
        id: CODEX_SESSION_ID,
        path: sessionPath ?? "/missing/session.jsonl",
        backend: "codex",
      },
      summary: "succeeded",
    },
    integrations: { results: [], all_critical_ok: true },
    recovery: {
      mode: "normal",
      resumable: true,
      checkpoint: {
        backend_session_id: CODEX_SESSION_ID,
        last_event_at: "2026-04-28T12:05:00.000Z",
        strategy: "native_session",
      },
    },
    summary: "succeeded",
    created_at: "2026-04-28T12:00:00.000Z",
    updated_at: "2026-04-28T12:05:00.000Z",
    completed_at: "2026-04-28T12:05:00.000Z",
  };
}

function codexUserMessage(text: string, ts = "2026-04-28T12:00:01.000Z"): string {
  return JSON.stringify({
    timestamp: ts,
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
}

function codexAssistantMessage(text: string, ts = "2026-04-28T12:00:03.000Z"): string {
  return JSON.stringify({
    timestamp: ts,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  });
}

function codexUserMessageWithImage(
  text: string,
  image: string,
  ts = "2026-04-28T12:00:01.000Z",
): string {
  return JSON.stringify({
    timestamp: ts,
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text },
        { type: "input_image", image_url: `data:image/png;base64,${Buffer.from(image).toString("base64")}` },
      ],
    },
  });
}

function codexToolCall(name: string, ts = "2026-04-28T12:00:04.000Z"): string {
  return JSON.stringify({
    timestamp: ts,
    type: "response_item",
    payload: {
      type: "function_call",
      name,
      arguments: "{\"cmd\":\"calyx self health\"}",
    },
  });
}

function codexToolResult(text: string, ts = "2026-04-28T12:00:05.000Z"): string {
  return JSON.stringify({
    timestamp: ts,
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "call-1",
      output: text,
    },
  });
}

function codexSessionMetaFor(sessionId: string, ts = "2026-04-28T12:00:00.000Z"): string {
  return JSON.stringify({
    timestamp: ts,
    type: "session_meta",
    payload: {
      id: sessionId,
      timestamp: ts,
      cwd: "/Users/caleb/dev/calyx/dev",
    },
  });
}

function codexSessionMeta(ts = "2026-04-28T12:00:00.000Z"): string {
  return codexSessionMetaFor(CODEX_SESSION_ID, ts);
}

function codexReasoning(ts = "2026-04-28T12:00:02.500Z"): string {
  return JSON.stringify({
    timestamp: ts,
    type: "response_item",
    payload: {
      type: "reasoning",
      content: "redacted reasoning",
    },
  });
}

async function writeCodexSession(
  home: string,
  lines: string[],
  opts: { trailingNewline?: boolean; mtime?: Date; fileName?: string } = {},
): Promise<string> {
  const dir = join(home, ".codex", "sessions", "2026", "04", "28");
  await mkdir(dir, { recursive: true });
  const trailing = opts.trailingNewline === false ? "" : "\n";
  const path = join(dir, opts.fileName ?? CODEX_FILE);
  await writeFile(path, `${lines.join("\n")}${trailing}`, "utf8");
  // Backdate the file by default so the freshness probe classifies it as
  // "complete" rather than "live" (live sessions are within 5 min of "now").
  const targetMtime = opts.mtime ?? new Date("2026-04-28T13:00:00.000Z");
  await utimes(path, targetMtime, targetMtime);
  return path;
}

async function writeArchivedCodexSession(home: string, lines: string[]): Promise<string> {
  const dir = join(home, ".codex", "archived_sessions");
  await mkdir(dir, { recursive: true });
  const path = join(dir, CODEX_FILE);
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  await utimes(path, new Date("2026-04-28T13:00:00.000Z"), new Date("2026-04-28T13:00:00.000Z"));
  return path;
}

function claudeUserMessage(content: string | Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    sessionId: CLAUDE_SESSION_ID,
    timestamp: "2026-04-28T12:05:00.000Z",
    cwd: "/Users/caleb/dev/calyx/dev",
    userType: "external",
    message: {
      role: "user",
      content,
    },
    ...extra,
  });
}

function claudeAssistantToolUse(): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: CLAUDE_SESSION_ID,
    timestamp: "2026-04-28T12:05:01.000Z",
    cwd: "/Users/caleb/dev/calyx/dev",
    userType: "external",
    message: {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_01",
        name: "Read",
        input: { file_path: "/tmp/example.txt" },
      }],
    },
  });
}

function claudeToolResult(content = ""): string {
  return JSON.stringify({
    type: "user",
    sessionId: CLAUDE_SESSION_ID,
    timestamp: "2026-04-28T12:05:02.000Z",
    cwd: "/Users/caleb/dev/calyx/dev",
    userType: "external",
    sourceToolAssistantUUID: "assistant-tool-event",
    toolUseResult: { stdout: content },
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_01",
        content,
        is_error: false,
      }],
    },
  });
}

async function writeClaudeSession(home: string, lines: string[]): Promise<string> {
  const dir = join(home, ".claude", "projects", "-Users-caleb-dev-calyx");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${CLAUDE_SESSION_ID}.jsonl`);
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  await utimes(path, new Date("2026-04-28T13:00:00.000Z"), new Date("2026-04-28T13:00:00.000Z"));
  return path;
}

void stat;

describe("activity turns projection", () => {
  test("run-backed messages resolve to the backend activity and include run metadata", async () => {
    const home = await makeHome();
    const sessionPath = await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage(AGENTS_PROMPT),
      codexUserMessage("Please inspect Calyx activity.", "2026-04-28T12:00:01.500Z"),
      codexAssistantMessage("Inspecting now.", "2026-04-28T12:00:03.000Z"),
    ]);
    const runId = "run-message-1";

    const result = await inspectActivityMessages({
      homeDir: home,
      activityId: `run:${runId}`,
      selector: { role: "human", first: 1 },
      runActivityResolver: {
        getRunRecord: async () => makeRunRecord(runId, sessionPath),
      },
    });

    expect(result.schema_version).toBe("activity.messages/v1");
    expect(result.run_id).toBe(runId);
    expect(result.activity_id).toBe(CODEX_ACTIVITY_ID);
    expect(result.activity_resolution).toMatchObject({
      handle: `run:${runId}`,
      run_id: runId,
      activity_id: CODEX_ACTIVITY_ID,
      backend: "codex",
      session_id: CODEX_SESSION_ID,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe("Please inspect Calyx activity.");
  });

  test("run handles follow a Codex transcript moved into archived_sessions", async () => {
    const home = await makeHome();
    vi.stubEnv("CODEX_HOME", join(home, "foreign-codex-home"));
    const archivedPath = await writeArchivedCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage("Recall this completed runner.", "2026-04-28T12:00:01.500Z"),
      codexAssistantMessage("Archived runner activity resolved.", "2026-04-28T12:00:03.000Z"),
    ]);
    const formerActivePath = join(home, ".codex", "sessions", "2026", "04", "28", CODEX_FILE);
    const runId = "run-archived-turns-1";

    const result = await inspectActivityTurns({
      homeDir: home,
      activityId: `run:${runId}`,
      selector: { role: "assistant", last: 1 },
      runActivityResolver: {
        getRunRecord: async () => makeRunRecord(runId, formerActivePath),
      },
    });

    expect(result.run_id).toBe(runId);
    expect(result.activity_id).toBe(CODEX_ACTIVITY_ID);
    expect(result.session_path).toBe(archivedPath);
    expect(result.turns[0]?.messages[0]?.text).toBe("Archived runner activity resolved.");
  });

  test("run archive discovery and relocation proof share CODEX_HOME without an explicit home", async () => {
    const home = await makeHome();
    const codexHome = join(home, "custom-codex-home");
    vi.stubEnv("CODEX_HOME", codexHome);
    const archiveDir = join(codexHome, "archived_sessions");
    await mkdir(archiveDir, { recursive: true });
    const archivedPath = join(archiveDir, CODEX_FILE);
    await writeFile(archivedPath, `${[
      codexSessionMeta(),
      codexUserMessage("Recall this custom-home runner.", "2026-04-28T12:00:01.500Z"),
      codexAssistantMessage("Custom-home archive resolved.", "2026-04-28T12:00:03.000Z"),
    ].join("\n")}\n`, "utf8");
    const formerActivePath = join(codexHome, "sessions", "2026", "04", "28", CODEX_FILE);
    const runId = "run-custom-codex-home-archived";

    const result = await inspectActivityTurns({
      activityId: `run:${runId}`,
      selector: { role: "assistant", last: 1 },
      runActivityResolver: {
        getRunRecord: async () => makeRunRecord(runId, formerActivePath),
      },
    });

    expect(result.run_id).toBe(runId);
    expect(result.activity_id).toBe(CODEX_ACTIVITY_ID);
    expect(result.session_path).toBe(archivedPath);
    expect(result.turns[0]?.messages[0]?.text).toBe("Custom-home archive resolved.");
  });

  test("run-backed turns reuse the backend turn grouping and include run metadata", async () => {
    const home = await makeHome();
    const sessionPath = await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage("Inspect the daemon health.", "2026-04-28T12:00:01.500Z"),
      codexAssistantMessage("Checking daemon.", "2026-04-28T12:00:03.000Z"),
      codexToolCall("shell", "2026-04-28T12:00:04.000Z"),
      codexToolResult("daemon ok", "2026-04-28T12:00:05.000Z"),
    ]);
    const runId = "run-turns-1";

    const result = await inspectActivityTurns({
      homeDir: home,
      activityId: `run:${runId}`,
      selector: { role: "assistant", last: 1, with_tools: true },
      runActivityResolver: {
        getRunRecord: async () => makeRunRecord(runId, sessionPath),
      },
    });

    expect(result.schema_version).toBe("activity.turns/v1");
    expect(result.run_id).toBe(runId);
    expect(result.activity_id).toBe(CODEX_ACTIVITY_ID);
    expect(result.activity_resolution?.resolution_source).toBe("run_record.recovery.checkpoint.backend_session_id");
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.turn_id).toMatch(new RegExp(`^${CODEX_ACTIVITY_ID}:turn:\\d+$`));
    expect(result.turns[0]?.messages.map((message) => message.role)).toContain("tool_call");
  });

  test("turns resolve codex deeplinks backed by rollout filename ids", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexSessionMetaFor(CODEX_DEEPLINK_META_ID),
      codexUserMessage("Please recover this pasted thread.", "2026-04-28T12:02:01.500Z"),
      codexAssistantMessage("Recovered via the rollout filename id.", "2026-04-28T12:02:03.000Z"),
    ], { fileName: CODEX_DEEPLINK_FILE });

    const result = await inspectActivityTurns({
      homeDir: home,
      activityId: `codex://threads/${CODEX_DEEPLINK_FILE_ID}`,
      selector: { role: "assistant", last: 1 },
    });

    expect(result.schema_version).toBe("activity.turns/v1");
    expect(result.activity_id).toBe(`interactive:codex:${CODEX_DEEPLINK_META_ID}`);
    expect(result.session_id).toBe(CODEX_DEEPLINK_META_ID);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.messages[0]?.text).toBe("Recovered via the rollout filename id.");
  });

  test("turns resolve <backend>:<host>:<session_id> authorship aliases (POL-1774)", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage("Walk the vault lineage.", "2026-04-28T12:00:01.500Z"),
      codexAssistantMessage("Authorship alias resolved.", "2026-04-28T12:00:03.000Z"),
    ]);

    const result = await inspectActivityTurns({
      homeDir: home,
      activityId: `codex:blade:${CODEX_SESSION_ID}`,
      selector: { role: "assistant", last: 1 },
    });

    expect(result.schema_version).toBe("activity.turns/v1");
    expect(result.activity_id).toBe(CODEX_ACTIVITY_ID);
    expect(result.session_id).toBe(CODEX_SESSION_ID);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.messages[0]?.text).toBe("Authorship alias resolved.");
  });

  test("run-backed terminal records mark fresh transcript turns complete", async () => {
    const home = await makeHome();
    const fresh = new Date();
    const sessionPath = await writeCodexSession(
      home,
      [
        codexSessionMeta(),
        codexUserMessage("Run a tiny smoke.", "2026-04-28T12:00:01.500Z"),
        codexAssistantMessage("Smoke complete.", "2026-04-28T12:00:03.000Z"),
      ],
      { mtime: fresh },
    );
    const runId = "run-terminal-fresh-turns-1";

    const result = await inspectActivityTurns({
      homeDir: home,
      activityId: `run:${runId}`,
      selector: { role: "assistant", last: 1 },
      now: () => fresh,
      runActivityResolver: {
        getRunRecord: async () => makeRunRecord(runId, sessionPath),
      },
    });

    expect(result.source_state).toBe("live");
    expect(result.activity_resolution?.run_state).toBe("succeeded");
    expect(result.turns[0]?.state).toBe("complete");
  });

  test("run-backed turns resolve active records from recovery checkpoints before receipt materialization", async () => {
    const home = await makeHome();
    const sessionPath = await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage("Stay on top of this runner.", "2026-04-28T12:00:01.500Z"),
      codexAssistantMessage("I am working through the runner state now.", "2026-04-28T12:00:03.000Z"),
    ]);
    const runId = "run-active-turns-1";
    const { kernel_receipt: _kernelReceipt, completed_at: _completedAt, ...baseRecord } = makeRunRecord(runId, sessionPath);
    void _kernelReceipt;
    void _completedAt;
    const activeRecord: RunRecord = {
      ...baseRecord,
      state: "running",
      recovery: {
        mode: "normal",
        resumable: true,
        checkpoint: {
          adapter_session_id: "codex-app-server-live",
          backend_session_id: CODEX_SESSION_ID,
          backend_session_path: sessionPath,
          last_event_at: "2026-04-28T12:00:02.000Z",
          strategy: "native_session",
        },
      },
      summary: "Run run-active-turns-1 running.",
      updated_at: "2026-04-28T12:00:02.000Z",
    };

    const result = await inspectActivityTurns({
      homeDir: home,
      activityId: `run:${runId}`,
      selector: { role: "assistant", last: 1, with_tools: true },
      runActivityResolver: {
        getRunRecord: async () => activeRecord,
      },
    });

    expect(result.run_id).toBe(runId);
    expect(result.activity_id).toBe(CODEX_ACTIVITY_ID);
    expect(result.activity_resolution?.resolution_source).toBe("run_record.recovery.checkpoint.backend_session_id");
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.role).toBe("assistant");
    expect(result.turns[0]?.messages[0]?.text).toBe("I am working through the runner state now.");
  });

  test("active Claude run with missing backend metadata reports terminal discovery is pending", async () => {
    const home = await makeHome();
    await writeClaudeSession(home, [
      claudeUserMessage("This is the transcript being resumed."),
    ]);
    const runId = "run-without-session";
    await expect(inspectActivityTurns({
      homeDir: home,
      activityId: `run:${runId}`,
      selector: { role: "assistant", last: 1 },
      runActivityResolver: {
        getRunRecord: async () => {
          const {
            kernel_receipt: _kernelReceipt,
            completed_at: _completedAt,
            ...record
          } = makeRunRecord(runId);
          void _kernelReceipt;
          void _completedAt;
          return {
            ...record,
            state: "running",
            intent: {
              ...record.intent,
              backend: "claude",
              resume_session_id: CLAUDE_SESSION_ID,
            },
            recovery: { mode: "normal", resumable: false },
          };
        },
      },
    })).rejects.toThrow(
      /spawn-backed Claude run is still "running"; backend session discovery remains pending until terminal receipt materialization/,
    );
  });

  test("active Codex run with missing backend metadata reports its absent checkpoint", async () => {
    const runId = "codex-run-without-checkpoint";
    await expect(inspectActivityTurns({
      activityId: `run:${runId}`,
      selector: { role: "assistant", last: 1 },
      runActivityResolver: {
        getRunRecord: async () => {
          const {
            kernel_receipt: _kernelReceipt,
            completed_at: _completedAt,
            ...record
          } = makeRunRecord(runId);
          void _kernelReceipt;
          void _completedAt;
          return {
            ...record,
            state: "running",
            recovery: { mode: "normal", resumable: false },
          };
        },
      },
    })).rejects.toThrow(
      /Codex app-server run is still "running", but its expected active recovery checkpoint is absent/,
    );
  });

  test("terminal run with missing backend metadata reports failed terminal discovery", async () => {
    const home = await makeHome();
    await writeClaudeSession(home, [
      claudeUserMessage("This old transcript must not stand in for terminal discovery."),
    ]);
    const runId = "terminal-run-without-session";
    await expect(inspectActivityTurns({
      homeDir: home,
      activityId: `run:${runId}`,
      selector: { role: "assistant", last: 1 },
      runActivityResolver: {
        getRunRecord: async () => {
          const { kernel_receipt: _kernelReceipt, ...record } = makeRunRecord(runId);
          void _kernelReceipt;
          return {
            ...record,
            intent: {
              ...record.intent,
              backend: "claude",
              resume_session_id: CLAUDE_SESSION_ID,
            },
            recovery: { mode: "normal", resumable: false },
          };
        },
      },
    })).rejects.toThrow(
      /terminal agent_runner run in state "succeeded" has no backend session discovery result; no terminal receipt is available/,
    );
  });

  test("terminal receipt without session metadata names the materialized receipt gap", async () => {
    const runId = "terminal-receipt-without-session";
    const record = makeRunRecord(runId);
    record.recovery = { mode: "normal", resumable: false };
    if (record.kernel_receipt && "backend_session" in record.kernel_receipt) {
      delete record.kernel_receipt.backend_session;
    }

    await expect(inspectActivityTurns({
      activityId: `run:${runId}`,
      selector: { role: "assistant", last: 1 },
      runActivityResolver: { getRunRecord: async () => record },
    })).rejects.toThrow(
      /terminal agent_runner run in state "succeeded" has no backend session discovery result after terminal receipt materialization/,
    );
  });

  test("short `run:` handles resolve through the store listing (POL-1825)", async () => {
    const home = await makeHome();
    const sessionPath = await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage("Recall the finished runner.", "2026-04-28T12:00:01.500Z"),
      codexAssistantMessage("Short handle resolved.", "2026-04-28T12:00:03.000Z"),
    ]);
    const runId = "c09d295c-f1b9-485f-bebb-67f311423247";
    const resolver = {
      getRunRecord: async (id: string) => (id === runId ? makeRunRecord(runId, sessionPath) : undefined),
      listRunIds: async () => [runId, "797e9ebf-1111-4222-8333-abcabcabcabc"],
    };

    const result = await inspectActivityTurns({
      homeDir: home,
      host: "blade",
      activityId: "run:c09d295c",
      selector: { role: "assistant", last: 1 },
      runActivityResolver: resolver,
    });
    expect(result.run_id).toBe(runId);
    expect(result.activity_id).toBe(CODEX_ACTIVITY_ID);
    expect(result.turns[0]?.messages[0]?.text).toBe("Short handle resolved.");
  });

  test("ambiguous and unmatched `run:` prefixes say so instead of reporting absence (POL-1825)", async () => {
    const listRunIds = async () => [
      "c09d295c-f1b9-485f-bebb-67f311423247",
      "c09d295c-aaaa-4222-8333-abcabcabcabc",
    ];

    await expect(inspectActivityTurns({
      host: "blade",
      activityId: "run:c09d295c",
      selector: { role: "assistant", last: 1 },
      runActivityResolver: { getRunRecord: async () => undefined, listRunIds },
    })).rejects.toThrow(/matches 2 runs[\s\S]*Pass a longer prefix or the full run id/);

    await expect(inspectActivityTurns({
      host: "blade",
      activityId: "run:deadbeef",
      selector: { role: "assistant", last: 1 },
      runActivityResolver: { getRunRecord: async () => undefined, listRunIds },
    })).rejects.toThrow(/no run record matches the "deadbeef" prefix among 2 known run\(s\); pass the full run id\./);
  });

  test("an unresolvable run handle names the executing host when it is not the queried host (POL-1825)", async () => {
    const runId = "run-resident-on-another-host";
    const record = makeRunRecord(runId);
    record.recovery = { mode: "normal", resumable: false };
    if (record.kernel_receipt && "backend_session" in record.kernel_receipt) {
      delete record.kernel_receipt.backend_session;
    }
    // `makeRunRecord` pins `intent.host` to blade; the fixture never reads the machine.
    const resolver = { getRunRecord: async () => record };

    await expect(inspectActivityTurns({
      host: "carbon",
      activityId: `run:${runId}`,
      selector: { role: "assistant", last: 1 },
      runActivityResolver: resolver,
    })).rejects.toThrow(/The run record names host "blade" as its executor; retry with --host blade\./);

    // Queried on its own host the same miss carries no locality pointer.
    const sameHost = await inspectActivityTurns({
      host: "blade",
      activityId: `run:${runId}`,
      selector: { role: "assistant", last: 1 },
      runActivityResolver: resolver,
    }).then(() => undefined, (error: unknown) => error as Error);
    expect(sameHost?.message).toContain("has no resolvable backend activity session");
    expect(sameHost?.message).not.toContain("retry with --host");
  });

  test("conflicting durable session identities fail closed", async () => {
    const runId = "run-conflicting-session-metadata";
    const record = makeRunRecord(runId);
    record.recovery.checkpoint = {
      backend_session_id: "019dbbbb-1111-7222-8333-abcabcabcabc",
      last_event_at: "2026-04-28T12:05:00.000Z",
      strategy: "native_session",
    };

    await expect(inspectActivityTurns({
      activityId: `run:${runId}`,
      selector: { role: "assistant", last: 1 },
      runActivityResolver: { getRunRecord: async () => record },
    })).rejects.toThrow(/conflicting durable backend session identities/);
  });

  test("a durable session id and path that name different transcripts fail closed", async () => {
    const home = await makeHome();
    const wrongPath = await writeClaudeSession(home, [
      claudeUserMessage("This belongs to another session."),
    ]);
    const runId = "run-conflicting-id-and-path";
    const record = makeRunRecord(runId, wrongPath);
    const expectedSessionId = "b0db0b5e-a49a-4a51-8733-c71bb2e8047d";
    record.intent.backend = "claude";
    if (record.kernel_receipt && "backend_session" in record.kernel_receipt) {
      record.kernel_receipt.run_spec.backend = "claude";
      record.kernel_receipt.environment.backend = "claude";
      record.kernel_receipt.backend_session = {
        id: expectedSessionId,
        path: wrongPath,
        backend: "claude",
      };
    }
    record.recovery.checkpoint = {
      backend_session_id: expectedSessionId,
      backend_session_path: wrongPath,
      last_event_at: "2026-04-28T12:05:00.000Z",
      strategy: "native_session",
    };

    await expect(inspectActivityTurns({
      homeDir: home,
      activityId: `run:${runId}`,
      selector: { role: "assistant", last: 1 },
      runActivityResolver: { getRunRecord: async () => record },
    })).rejects.toThrow(
      /durable backend session id and path identify different transcripts/,
    );
  });

  test("an ID-only checkpoint cannot bypass a contradictory extant receipt path", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage("The checkpoint identity exists."),
    ]);
    const wrongId = "019dbbbb-1111-7222-8333-abcabcabcabc";
    const wrongPath = await writeCodexSession(home, [
      codexSessionMetaFor(wrongId),
      codexUserMessage("The receipt path belongs to a different transcript."),
    ], { fileName: `rollout-2026-04-28T12-01-00-${wrongId}.jsonl` });
    const runId = "run-id-only-checkpoint-contradictory-receipt";
    const record = makeRunRecord(runId, wrongPath);

    await expect(inspectActivityTurns({
      homeDir: home,
      activityId: `run:${runId}`,
      selector: { role: "assistant", last: 1 },
      runActivityResolver: { getRunRecord: async () => record },
    })).rejects.toThrow(/durable backend session id and path identify different transcripts/);
  });

  test("run resolution fails typed when complete active collision discovery exceeds its budget", async () => {
    const home = await makeHome();
    const sessionPath = await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage("A direct durable path is not permission to skip discovery."),
    ]);
    const otherId = "019dbbbb-1111-7222-8333-abcabcabcabc";
    await writeCodexSession(home, [codexSessionMetaFor(otherId)], {
      fileName: `rollout-2026-04-28T12-01-00-${otherId}.jsonl`,
    });
    const runId = "run-bounded-exact-discovery";

    await expect(resolveInteractiveActivity({
      homeDir: home,
      activityId: `run:${runId}`,
      candidateLimit: 1,
      runActivityResolver: { getRunRecord: async () => makeRunRecord(runId, sessionPath) },
    })).rejects.toMatchObject({
      code: "activity_projection_not_ready",
      retryable: true,
      details: { reason: "candidate_limit", candidate_limit: 1 },
    });
  });

  test("run collision checks remain complete beyond one thousand newer sessions", async () => {
    const home = await makeHome();
    const sessionPath = await writeCodexSession(home, [codexSessionMeta()]);
    const duplicateFileId = "019daaaa-1111-7222-8333-abcabcabcabc";
    await writeCodexSession(home, [codexSessionMeta()], {
      fileName: `rollout-2026-04-28T12-01-00-${duplicateFileId}.jsonl`,
    });
    const newerDir = join(home, ".codex", "sessions", "2026", "04", "29");
    await mkdir(newerDir, { recursive: true });
    for (let index = 0; index < 1_001; index += 1) {
      const id = `019e0000-1111-7222-8333-${index.toString(16).padStart(12, "0")}`;
      await writeFile(
        join(newerDir, `rollout-2026-04-29T12-00-00-${id}.jsonl`),
        `${codexSessionMetaFor(id)}\n`,
        "utf8",
      );
    }
    const runId = "run-collision-beyond-one-thousand";

    await expect(inspectActivityTurns({
      homeDir: home,
      activityId: `run:${runId}`,
      selector: { role: "assistant", last: 1 },
      runActivityResolver: { getRunRecord: async () => makeRunRecord(runId, sessionPath) },
    })).rejects.toMatchObject({
      code: "activity_projection_not_ready",
      details: { reason: "identity_collision" },
    });
  });

  test("terminal Claude receipt resolves through its persisted backend session", async () => {
    const home = await makeHome();
    const sessionPath = await writeClaudeSession(home, [
      claudeUserMessage("Inspect the terminal receipt."),
      JSON.stringify({
        type: "assistant",
        sessionId: CLAUDE_SESSION_ID,
        timestamp: "2026-04-28T12:05:01.000Z",
        cwd: "/Users/caleb/dev/calyx/dev",
        message: { role: "assistant", content: [{ type: "text", text: "Receipt resolved." }] },
      }),
    ]);
    const runId = "run-claude-terminal-receipt";
    const record = makeRunRecord(runId, sessionPath);
    record.intent.backend = "claude";
    if (record.kernel_receipt && "run_spec" in record.kernel_receipt) {
      record.kernel_receipt.run_spec.backend = "claude";
      record.kernel_receipt.environment.backend = "claude";
      record.kernel_receipt.backend_session = {
        id: CLAUDE_SESSION_ID,
        path: sessionPath,
        backend: "claude",
      };
    }
    record.recovery.checkpoint = {
      backend_session_id: CLAUDE_SESSION_ID,
      backend_session_path: sessionPath,
      last_event_at: "2026-04-28T12:05:01.000Z",
      strategy: "native_session",
    };

    const result = await inspectActivityTurns({
      homeDir: home,
      activityId: `run:${runId}`,
      selector: { role: "assistant", last: 1 },
      runActivityResolver: { getRunRecord: async () => record },
    });

    expect(result.activity_id).toBe(CLAUDE_ACTIVITY_ID);
    expect(result.activity_resolution).toMatchObject({
      backend: "claude",
      session_id: CLAUDE_SESSION_ID,
    });
    expect(result.turns[0]?.messages[0]?.text).toBe("Receipt resolved.");
  });

  test("empty run handles still fail with their syntax diagnostic", async () => {

    await expect(inspectActivityTurns({
      activityId: "run:",
      selector: { role: "assistant", last: 1 },
      runActivityResolver: {
        getRunRecord: async () => undefined,
      },
    })).rejects.toThrow(/is malformed: `run:` carries no run id/);
  });

  test("direct interactive activity ids do not gain run-resolution metadata", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage("Inspect the daemon health.", "2026-04-28T12:00:01.500Z"),
      codexAssistantMessage("Checking daemon.", "2026-04-28T12:00:03.000Z"),
    ]);

    const result = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant", last: 1 },
    });

    expect(result.activity_id).toBe(CODEX_ACTIVITY_ID);
    expect(result.run_id).toBeUndefined();
    expect(result.activity_resolution).toBeUndefined();
    expect(result.turns[0]?.role).toBe("assistant");
  });

  test("groups assistant message + tool calls into one assistant turn with stable turn_id", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage(AGENTS_PROMPT),
      codexUserMessage("Inspect the daemon health.", "2026-04-28T12:00:01.500Z"),
      codexAssistantMessage("Checking daemon.", "2026-04-28T12:00:03.000Z"),
      codexToolCall("shell", "2026-04-28T12:00:04.000Z"),
      codexToolResult("daemon ok", "2026-04-28T12:00:05.000Z"),
      codexAssistantMessage("Daemon is healthy.", "2026-04-28T12:00:06.000Z"),
    ]);

    const turns = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant", last: 1, with_tools: true },
    });

    expect(turns.schema_version).toBe("activity.turns/v1");
    expect(turns.classifier_version).toBe(ACTIVITY_MESSAGE_CLASSIFIER_VERSION);
    expect(turns.returned_turns).toBe(1);
    const last = turns.turns[0]!;
    expect(last.role).toBe("assistant");
    expect(last.state).toBe("complete");
    expect(last.turn_id).toMatch(/:turn:\d+$/);
    expect(last.tool_call_count).toBeGreaterThanOrEqual(1);
    expect(last.tool_result_count).toBeGreaterThanOrEqual(1);
    const roles = last.messages.map((message) => message.role);
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool_call");
    expect(roles).toContain("tool_result");

    // Re-read: same turn_id (stable across reads).
    const turnsAgain = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant", last: 1 },
    });
    expect(turnsAgain.turns[0]?.turn_id).toBe(last.turn_id);
  });

  test("human turn boundary closes when assistant message starts", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexUserMessage("first human prompt", "2026-04-28T12:00:01.000Z"),
      codexAssistantMessage("first assistant reply", "2026-04-28T12:00:02.000Z"),
      codexUserMessage("second human prompt", "2026-04-28T12:00:03.000Z"),
      codexAssistantMessage("second assistant reply", "2026-04-28T12:00:04.000Z"),
    ]);

    const all = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: {},
    });

    const roles = all.turns.map((turn) => turn.role);
    // Expect alternating human/assistant turns.
    expect(roles).toEqual(["human", "assistant", "human", "assistant"]);
    expect(all.total_turns).toBe(4);
    expect(all.turns.every((turn) => turn.turn_id.startsWith(`${CODEX_ACTIVITY_ID}:turn:`))).toBe(true);
  });

  test("--role human / --role assistant filter turns correctly", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexUserMessage("h1", "2026-04-28T12:00:01.000Z"),
      codexAssistantMessage("a1", "2026-04-28T12:00:02.000Z"),
      codexUserMessage("h2", "2026-04-28T12:00:03.000Z"),
      codexAssistantMessage("a2", "2026-04-28T12:00:04.000Z"),
    ]);

    const humans = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "human" },
    });
    expect(humans.returned_turns).toBe(2);
    expect(humans.turns.every((turn) => turn.role === "human")).toBe(true);
    const firstHumanMessage = humans.turns[0]?.messages.find((message) => message.role === "human");
    expect(firstHumanMessage?.text).toBe("h1");

    const assistants = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant" },
    });
    expect(assistants.returned_turns).toBe(2);
    expect(assistants.turns.every((turn) => turn.role === "assistant")).toBe(true);

    const last = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant", last: 1 },
    });
    expect(last.returned_turns).toBe(1);
    expect(last.turns[0]?.messages.find((message) => message.role === "assistant")?.text).toBe("a2");
  });

  test("reasoning summary attaches to assistant turn (preceding-event behavior)", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexUserMessage("ask", "2026-04-28T12:00:01.000Z"),
      codexAssistantMessage("respond", "2026-04-28T12:00:02.000Z"),
      codexReasoning("2026-04-28T12:00:02.500Z"),
    ]);

    const assistants = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant", last: 1 },
    });
    const turn = assistants.turns[0]!;
    expect(turn.total_message_count).toBeGreaterThanOrEqual(2);
    expect(turn.role).toBe("assistant");
  });

  test("--with-tools omitted: tool messages are filtered from turn output but counts remain", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexUserMessage("anchor", "2026-04-28T12:00:01.000Z"),
      codexAssistantMessage("running", "2026-04-28T12:00:02.000Z"),
      codexToolCall("shell", "2026-04-28T12:00:03.000Z"),
      codexToolResult("ok", "2026-04-28T12:00:04.000Z"),
    ]);

    const turns = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant", last: 1 },
    });
    const turn = turns.turns[0]!;
    expect(turn.tool_call_count).toBe(1);
    expect(turn.tool_result_count).toBe(1);
    const visibleRoles = turn.messages.map((message) => message.role);
    expect(visibleRoles).not.toContain("tool_call");
    expect(visibleRoles).not.toContain("tool_result");
    expect(visibleRoles).toContain("assistant");

    const withTools = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant", last: 1, with_tools: true },
    });
    const exposedRoles = withTools.turns[0]?.messages.map((message) => message.role) ?? [];
    expect(exposedRoles).toContain("tool_call");
    expect(exposedRoles).toContain("tool_result");
  });

  test("--summary-only and --max-text-chars decorations propagate", async () => {
    const home = await makeHome();
    const longText = "x".repeat(300);
    await writeCodexSession(home, [
      codexUserMessage("anchor", "2026-04-28T12:00:01.000Z"),
      codexAssistantMessage(longText, "2026-04-28T12:00:02.000Z"),
    ]);

    const truncated = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant", last: 1, max_text_chars: 50 },
    });
    const message = truncated.turns[0]?.messages.find((m) => m.role === "assistant");
    expect(message?.text_cursor).toEqual({
      total_chars: 300,
      returned: [[0, 30], [280, 300]],
      next: 30,
    });
    expect(message?.text).toContain("chars 30-280");
    expect(message?.text).toContain("calyx activity text");
    expect(message?.truncated).toBe(true);

    const summarised = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant", last: 1, summary_only: true },
    });
    const summary = summarised.turns[0]?.messages.find((m) => m.role === "assistant");
    expect(summary?.text).toBeUndefined();
    expect(summary?.summary.length).toBeGreaterThan(0);
  });

  test("turn --max-text-chars can raise the cap above the default", async () => {
    const home = await makeHome();
    const longText = "x".repeat(5_000);
    await writeCodexSession(home, [
      codexUserMessage("anchor", "2026-04-28T12:00:01.000Z"),
      codexAssistantMessage(longText, "2026-04-28T12:00:02.000Z"),
    ]);

    const defaultTurns = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant", last: 1 },
    });
    const defaultMessage = defaultTurns.turns[0]?.messages.find((m) => m.role === "assistant");
    expect(defaultTurns.selector.max_text_chars).toBe(4_000);
    expect(defaultMessage?.text_cursor?.returned).toEqual([[0, 2400], [3400, 5000]]);
    expect(defaultMessage?.text).toContain("chars 2400-3400");
    expect(defaultMessage?.truncated).toBe(true);

    const raised = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant", last: 1, max_text_chars: 4_500 },
    });
    const raisedMessage = raised.turns[0]?.messages.find((m) => m.role === "assistant");
    expect(raisedMessage?.text_cursor?.returned).toEqual([[0, 2700], [3200, 5000]]);
    expect(raisedMessage?.text).toContain("chars 2700-3200");
    expect(raisedMessage?.truncated).toBe(true);

    const full = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant", last: 1, max_text_chars: 6_000 },
    });
    const fullMessage = full.turns[0]?.messages.find((m) => m.role === "assistant");
    expect(fullMessage?.text?.length).toBe(5_000);
    expect(fullMessage?.truncated).toBeUndefined();
  });

  test("in-flight state marks the last turn when session file is live", async () => {
    const home = await makeHome();
    const fresh = new Date();
    await writeCodexSession(
      home,
      [
        codexUserMessage("anchor", "2026-04-28T12:00:01.000Z"),
        codexAssistantMessage("incomplete reply", "2026-04-28T12:00:02.000Z"),
      ],
      { mtime: fresh },
    );

    const turns = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: {},
      now: () => fresh,
    });
    expect(turns.source_state).toBe("live");
    expect(turns.turns[turns.turns.length - 1]?.state).toBe("in_flight");
    expect(turns.turns.slice(0, -1).every((turn) => turn.state === "complete")).toBe(true);
  });

  test("messages carry turn_id values that match the turn projection", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexUserMessage("hi", "2026-04-28T12:00:01.000Z"),
      codexAssistantMessage("hello", "2026-04-28T12:00:02.000Z"),
      codexToolCall("shell", "2026-04-28T12:00:03.000Z"),
      codexToolResult("ok", "2026-04-28T12:00:04.000Z"),
    ]);

    const messages = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { visibility: "+hidden" },
    });
    const turnsResult = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: {},
    });

    // Every returned message has a turn_id; every turn_id corresponds to a real turn.
    expect(messages.messages.every((message) => typeof message.turn_id === "string" && message.turn_id.length > 0)).toBe(true);
    const turnIds = new Set(turnsResult.turns.map((turn) => turn.turn_id));
    for (const message of messages.messages) {
      expect(turnIds.has(message.turn_id!)).toBe(true);
    }
  });

  test("preamble harness/system events form an unknown turn (filtered by default)", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage(AGENTS_PROMPT, "2026-04-28T12:00:00.500Z"),
      codexUserMessage("real prompt", "2026-04-28T12:00:01.000Z"),
      codexAssistantMessage("real reply", "2026-04-28T12:00:02.000Z"),
    ]);

    const all = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "all" },
    });
    // Preamble session_meta + AGENTS harness form an unknown turn.
    expect(all.turns[0]?.role).toBe("unknown");
    expect(all.total_turns).toBeGreaterThanOrEqual(3);

    const conversational = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "human" },
    });
    expect(conversational.turns.every((turn) => turn.role === "human")).toBe(true);
  });

  test("consumer turns and attachments are derived after default-visibility classification", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessageWithImage(
        AGENTS_PROMPT,
        "hidden-harness-image",
        "2026-04-28T12:00:00.500Z",
      ),
      codexToolCall("hidden-tool-image-data:image/png;base64,aGlkZGVuLXRvb2wtaW1hZ2U=", "2026-04-28T12:00:00.750Z"),
      codexUserMessageWithImage(
        "Visible consumer prompt",
        "visible-image",
        "2026-04-28T12:00:01.000Z",
      ),
      codexAssistantMessage("Visible consumer response", "2026-04-28T12:00:02.000Z"),
    ]);

    const consumerTurns = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      consumerVisibleOnly: true,
      selector: {},
    });

    expect(consumerTurns.total_messages).toBe(2);
    expect(consumerTurns.total_turns).toBe(2);
    expect(consumerTurns.matched_turns).toBe(2);
    expect(consumerTurns.turns.map((turn) => turn.role)).toEqual(["human", "assistant"]);
    expect(consumerTurns.turns.map((turn) => turn.index)).toEqual([0, 1]);
    expect(consumerTurns.turns.flatMap((turn) => turn.messages).map((message) => message.visibility))
      .toEqual(["default", "default"]);
    expect(consumerTurns.turns[0]?.total_message_count).toBe(1);
    expect(consumerTurns.turns[0]?.visible_message_count).toBe(1);
    expect(consumerTurns.turns[0]?.tool_call_count).toBe(0);
    expect(consumerTurns.turns[0]?.tool_result_count).toBe(0);
    expect(consumerTurns.turns[0]?.attachments.images).toBe(1);

    const afterFirstConsumerTurn = await inspectActivityTurns({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      consumerVisibleOnly: true,
      selector: { after_turn_index: 0, first: 1 },
    });
    expect(afterFirstConsumerTurn.total_turns).toBe(2);
    expect(afterFirstConsumerTurn.returned_turns).toBe(1);
    expect(afterFirstConsumerTurn.turns[0]?.role).toBe("assistant");
    expect(afterFirstConsumerTurn.turns[0]?.index).toBe(1);

    const consumerAttachments = await inspectActivityAttachments({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      consumerVisibleOnly: true,
    });
    expect(consumerAttachments.attachments).toHaveLength(1);
    expect(consumerAttachments.attachments[0]?.message_id)
      .toBe(consumerTurns.turns[0]?.messages[0]?.id);
    expect(consumerAttachments.rollup.images).toBe(1);

    const hiddenAdminAttachments = await inspectActivityAttachments({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
    });
    expect(hiddenAdminAttachments.attachments.length).toBeGreaterThan(consumerAttachments.attachments.length);
  });

  test("Claude tool and metadata user-role records do not open human turns", async () => {
    const home = await makeHome();
    await writeClaudeSession(home, [
      claudeUserMessage([{ type: "text", text: "Provider metadata: inspect transcript state." }], { isMeta: true }),
      claudeUserMessage("<task-notification>\n<task-id>task-123</task-id>\n<summary>Monitor event</summary>\n</task-notification>"),
      claudeUserMessage("Please inspect Calyx activity.", { timestamp: "2026-04-28T12:05:00.500Z" }),
      claudeAssistantToolUse(),
      claudeToolResult(""),
      claudeUserMessage([{ type: "text", text: "[Image: source: /tmp/claude-screenshot.png]" }], { isMeta: true }),
    ]);

    const humans = await inspectActivityTurns({
      homeDir: home,
      activityId: CLAUDE_ACTIVITY_ID,
      selector: { role: "human" },
    });

    expect(humans.returned_turns).toBe(1);
    expect(humans.turns[0]?.messages.filter((message) => message.role === "human")).toHaveLength(1);
    expect(humans.turns[0]?.messages[0]?.text).toBe("Please inspect Calyx activity.");

    const all = await inspectActivityTurns({
      homeDir: home,
      activityId: CLAUDE_ACTIVITY_ID,
      selector: { role: "all", with_tools: true },
    });

    expect(all.turns.map((turn) => turn.role)).toEqual(["unknown", "human", "assistant"]);
    expect(all.turns.filter((turn) => turn.role === "human")).toHaveLength(1);
    expect(all.turns.find((turn) => turn.role === "assistant")?.tool_result_count).toBe(1);
  });
});

describe("activity events --within-turn", () => {
  test("returns the raw events for the turn containing the message", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexUserMessage("anchor", "2026-04-28T12:00:01.000Z"),
      codexAssistantMessage("running", "2026-04-28T12:00:02.000Z"),
      codexToolCall("shell", "2026-04-28T12:00:03.000Z"),
      codexToolResult("ok", "2026-04-28T12:00:04.000Z"),
      codexAssistantMessage("done", "2026-04-28T12:00:05.000Z"),
      codexUserMessage("next", "2026-04-28T12:00:06.000Z"),
    ]);

    const messages = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { visibility: "+detail" },
    });
    const toolCall = messages.messages.find((message) => message.role === "tool_call")!;
    expect(toolCall).toBeDefined();

    const withinTurn = await inspectActivityEvents({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { around_id: toolCall.id, within_turn: true },
    });
    expect(withinTurn.returned_events).toBeGreaterThanOrEqual(4);
    expect(withinTurn.events.every((event) => event.line >= 2 && event.line <= 5)).toBe(true);
    // Should not include the trailing user "next" event (different turn).
    expect(withinTurn.events.some((event) => event.text === "next")).toBe(false);
    // Should include all assistant + tool events for that turn.
    expect(withinTurn.events.some((event) => event.text === "running")).toBe(true);
    expect(withinTurn.events.some((event) => event.text === "ok")).toBe(true);
  });

  test("--within-turn without --around-id fails loudly", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [codexUserMessage("noop")]);
    await expect(
      inspectActivityEvents({
        homeDir: home,
        activityId: CODEX_ACTIVITY_ID,
        selector: { within_turn: true },
      }),
    ).rejects.toThrow(/--within-turn requires --around-id/);
  });

  test("--within-turn rejects --context and --tail", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [codexUserMessage("noop")]);
    await expect(
      inspectActivityEvents({
        homeDir: home,
        activityId: CODEX_ACTIVITY_ID,
        selector: { within_turn: true, around_id: "x", context: 1 },
      }),
    ).rejects.toThrow(/mutually exclusive/);
    await expect(
      inspectActivityEvents({
        homeDir: home,
        activityId: CODEX_ACTIVITY_ID,
        selector: { within_turn: true, around_id: "x", tail: 1 },
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });
});
