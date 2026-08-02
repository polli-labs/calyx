import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
  ACTIVITY_ATTACHMENT_CACHE_OBSERVATION_MAX_ITEMS,
  ACTIVITY_ATTACHMENT_CACHE_PROVENANCE_MAX_BYTES,
  ACTIVITY_ATTACHMENT_MAX_BYTES,
  ActivityAttachmentError,
  ActivityIdAmbiguousError,
  ActivityIdMalformedError,
  ActivityIdNotFoundError,
  ActivityMessageSelectorError,
  ActivityRunMissingMetadataError,
  attachmentDigestFromRef,
  inspectActivityAttachmentRecord,
  inspectActivityAttachments,
  inspectActivityEvents,
  inspectActivityMessages,
  inspectActivityText,
  projectInteractiveSessionToMessages,
  readActivityAttachmentBytes,
  readVerifiedAttachmentCache,
  recordVerifiedAttachmentCacheHit,
  resolveInteractiveActivity,
  writeVerifiedAttachmentCache,
  type ActivityAttachmentRecord,
} from "../activity-messages.js";

// Pin the machine hostname so authorship-alias host comparisons (POL-1774) are
// deterministic: the resolver falls back to os.hostname() when no `host` option
// is passed, and `--host local` resolves to the machine hostname.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  hostname: () => "carbon",
}));

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
  created.length = 0;
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "calyx-activity-messages-"));
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

function cacheAttachment(bytes: Buffer, mimeType = "image/png"): ActivityAttachmentRecord {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    ref: `att:sha256:${sha256}`,
    sha256,
    mime_type: mimeType,
    byte_size: bytes.length,
    source_shape: "codex.input_image.data_url",
    exact_bytes_available: true,
    activity_id: CODEX_ACTIVITY_ID,
    message_id: `${CODEX_ACTIVITY_ID}:msg:1`,
    source_line: 1,
    event_index: 0,
  };
}

const AGENTS_PROMPT = "# AGENTS.md instructions for /Users/caleb\n<INSTRUCTIONS>...</INSTRUCTIONS>";

function codexUserMessage(text: string): string {
  return JSON.stringify({
    timestamp: "2026-04-28T12:00:01.000Z",
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

function codexUserImageMessage(text: string, dataUrl: string): string {
  return JSON.stringify({
    timestamp: "2026-04-28T12:00:01.000Z",
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
    payload: {
      type: "function_call",
      name,
      arguments: "{\"cmd\":\"calyx self health\"}",
    },
  });
}

function codexToolResult(text: string): string {
  return JSON.stringify({
    timestamp: "2026-04-28T12:00:05.000Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "call-1",
      output: text,
    },
  });
}

function codexSessionMetaFor(sessionId: string): string {
  return JSON.stringify({
    timestamp: "2026-04-28T12:00:00.000Z",
    type: "session_meta",
    payload: {
      id: sessionId,
      timestamp: "2026-04-28T12:00:00.000Z",
      cwd: "/Users/caleb/dev/calyx/dev",
    },
  });
}

function codexSessionMeta(): string {
  return codexSessionMetaFor(CODEX_SESSION_ID);
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

async function writeClaudeSession(home: string, lines: string[]): Promise<void> {
  const dir = join(home, ".claude", "projects", "-Users-caleb-dev-calyx");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${CLAUDE_SESSION_ID}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

async function writeCodexSession(
  home: string,
  lines: string[],
  opts: { trailingNewline?: boolean; fileName?: string } = {},
): Promise<void> {
  const dir = join(home, ".codex", "sessions", "2026", "04", "28");
  await mkdir(dir, { recursive: true });
  const trailing = opts.trailingNewline === false ? "" : "\n";
  await writeFile(join(dir, opts.fileName ?? CODEX_FILE), `${lines.join("\n")}${trailing}`, "utf8");
}

async function writeArchivedCodexSession(
  home: string,
  sessionId: string,
  lines: string[],
): Promise<string> {
  const dir = join(home, ".codex", "archived_sessions");
  await mkdir(dir, { recursive: true });
  const sessionPath = join(dir, `rollout-2026-04-28T11-00-00-${sessionId}.jsonl`);
  await writeFile(sessionPath, `${lines.join("\n")}\n`, "utf8");
  return sessionPath;
}

describe("activity messages projection", () => {
  test("attachment refs are exact canonical content identities", () => {
    const digest = "a".repeat(64);
    expect(attachmentDigestFromRef(`att:sha256:${digest}`)).toBe(digest);
    expect(attachmentDigestFromRef(` ATT:SHA256:${digest.toUpperCase()} `)).toBeUndefined();
  });

  test("first --role human skips AGENTS harness payload and returns the actual human prompt", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage(AGENTS_PROMPT),
      codexUserMessage("Please inspect Calyx activity."),
      codexAssistantMessage("Inspecting now."),
    ]);

    const result = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "human", first: 1 },
    });

    expect(result.classifier_version).toBe(ACTIVITY_MESSAGE_CLASSIFIER_VERSION);
    expect(result.activity_id).toBe(CODEX_ACTIVITY_ID);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe("Please inspect Calyx activity.");
    expect(result.messages[0]?.role).toBe("human");
    expect(result.messages[0]?.id).toMatch(/:msg:\d+$/);
    expect(result.messages[0]?.activity.activity_id).toBe(CODEX_ACTIVITY_ID);
  });

  test("--role assistant --last 1 returns latest assistant message even when later events are tool detail", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage("Investigate carbon run service"),
      codexAssistantMessage("Carbon health timed out in the activity scan."),
      codexToolCall("shell"),
      codexToolResult("calyx self health: ok"),
    ]);

    const result = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant", last: 1 },
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[0]?.text).toBe("Carbon health timed out in the activity scan.");
  });

  test("resolves codex deeplinks and rollout filename ids when session_meta id differs", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexSessionMetaFor(CODEX_DEEPLINK_META_ID),
      codexUserMessage("Recall the pasted Codex thread."),
      codexAssistantMessage("Deeplink route restored."),
    ], { fileName: CODEX_DEEPLINK_FILE });

    for (const activityId of [
      `codex://threads/${CODEX_DEEPLINK_FILE_ID}`,
      CODEX_DEEPLINK_FILE_ID,
      `interactive:codex:${CODEX_DEEPLINK_FILE_ID}`,
    ]) {
      const result = await inspectActivityMessages({
        homeDir: home,
        activityId,
        selector: { role: "assistant", last: 1 },
      });

      expect(result.activity_id).toBe(`interactive:codex:${CODEX_DEEPLINK_META_ID}`);
      expect(result.session_id).toBe(CODEX_DEEPLINK_META_ID);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.text).toBe("Deeplink route restored.");
    }

    await expect(resolveInteractiveActivity({
      homeDir: home,
      activityId: `codex://threads/${CODEX_DEEPLINK_FILE_ID}`,
    })).resolves.toMatchObject({
      run_id: `interactive:codex:${CODEX_DEEPLINK_META_ID}`,
      session_id: CODEX_DEEPLINK_META_ID,
    });
  });

  test("resolves exact archived Codex activity while latest remains active-only", async () => {
    const home = await makeHome();
    const archivedId = "019dcafe-9999-7222-8333-abcabcabcabc";
    const archivedPath = await writeArchivedCodexSession(home, archivedId, [
      codexSessionMetaFor(archivedId),
      codexUserMessage("Recall the archived task."),
      codexAssistantMessage("Archived activity resolved."),
    ]);
    await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage("This is the active task."),
      codexAssistantMessage("Active activity remains latest."),
    ]);

    const archived = await inspectActivityMessages({
      homeDir: home,
      activityId: `interactive:codex:${archivedId}`,
      selector: { role: "assistant", last: 1 },
    });
    expect(archived.session_path).toBe(archivedPath);
    expect(archived.messages[0]?.text).toBe("Archived activity resolved.");

    await expect(resolveInteractiveActivity({
      homeDir: home,
      latestSession: true,
      latestSessionBackend: "codex",
    })).resolves.toMatchObject({
      run_id: CODEX_ACTIVITY_ID,
    });
  });

  test("exact activity resolution fails closed on active/archive identity collisions", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [codexSessionMeta(), codexUserMessage("active")]);
    await writeArchivedCodexSession(home, CODEX_SESSION_ID, [
      codexSessionMeta(),
      codexUserMessage("archived duplicate"),
    ]);

    await expect(resolveInteractiveActivity({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
    })).rejects.toMatchObject({
      details: { reason: "identity_collision" },
    });
  });

  test("resolves canonical and filename aliases beyond one thousand newer sessions", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexSessionMetaFor(CODEX_DEEPLINK_META_ID),
      codexUserMessage("Old but addressable."),
      codexAssistantMessage("Complete identity scan found me."),
    ], { fileName: CODEX_DEEPLINK_FILE });
    const dir = join(home, ".codex", "sessions", "2026", "04", "29");
    await mkdir(dir, { recursive: true });
    for (let index = 0; index < 1_001; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      const id = `019e0000-1111-7222-8333-${suffix}`;
      await writeFile(
        join(dir, `rollout-2026-04-29T12-00-00-${id}.jsonl`),
        `${codexSessionMetaFor(id)}\n`,
        "utf8",
      );
    }

    await expect(resolveInteractiveActivity({
      homeDir: home,
      activityId: `interactive:codex:${CODEX_DEEPLINK_META_ID}`,
    })).resolves.toMatchObject({ run_id: `interactive:codex:${CODEX_DEEPLINK_META_ID}` });
    const byFilename = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_DEEPLINK_FILE_ID,
      selector: { role: "assistant", last: 1 },
    });
    expect(byFilename.messages[0]?.text).toBe("Complete identity scan found me.");
  });

  test("resolves <backend>:<host>:<session_id> authorship aliases (POL-1774)", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage("Walk the vault lineage."),
      codexAssistantMessage("Authorship alias resolved."),
    ]);
    await writeClaudeSession(home, [
      claudeUserMessage("Walk the vault lineage."),
    ]);

    // Full-uuid aliases match exactly regardless of the named host (uuids are unique).
    const codexResult = await inspectActivityMessages({
      homeDir: home,
      activityId: `codex:blade:${CODEX_SESSION_ID}`,
      selector: { role: "assistant", last: 1 },
    });
    expect(codexResult.activity_id).toBe(CODEX_ACTIVITY_ID);
    expect(codexResult.session_id).toBe(CODEX_SESSION_ID);
    expect(codexResult.messages[0]?.text).toBe("Authorship alias resolved.");

    // Mixed-case aliases normalize: backend/host/session captures are lowercased.
    const upper = await inspectActivityMessages({
      homeDir: home,
      activityId: `CODEX:Blade:${CODEX_SESSION_ID.toUpperCase()}`,
      selector: { role: "assistant", last: 1 },
    });
    expect(upper.activity_id).toBe(CODEX_ACTIVITY_ID);

    // Truncated aliases resolve via prefix expansion on the named host.
    await expect(resolveInteractiveActivity({
      homeDir: home,
      host: "carbon",
      activityId: `codex:carbon:${CODEX_SESSION_ID.slice(0, 8)}`,
    })).resolves.toMatchObject({ run_id: CODEX_ACTIVITY_ID });

    // `--host local` is the supported alias for this host (mocked hostname: carbon);
    // same-host truncated aliases still prefix-expand under it.
    await expect(resolveInteractiveActivity({
      homeDir: home,
      host: "local",
      activityId: `codex:carbon:${CODEX_SESSION_ID.slice(0, 8)}`,
    })).resolves.toMatchObject({ run_id: CODEX_ACTIVITY_ID });

    await expect(resolveInteractiveActivity({
      homeDir: home,
      activityId: `claude:carbon:${CLAUDE_SESSION_ID}`,
    })).resolves.toMatchObject({
      run_id: CLAUDE_ACTIVITY_ID,
      session_id: CLAUDE_SESSION_ID,
    });
  });

  test("composite `interactive:<host>:<backend>:<id>` ids fail as grammar, not absence (POL-1825)", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage("The session this composite id was aimed at."),
      codexAssistantMessage("Present and indexed."),
    ]);

    // The canonical form resolves; the composite one names a host inside the id.
    await expect(resolveInteractiveActivity({
      homeDir: home,
      host: "blade",
      activityId: CODEX_ACTIVITY_ID,
    })).resolves.toMatchObject({ run_id: CODEX_ACTIVITY_ID });

    const composite = `interactive:blade:codex:${CODEX_SESSION_ID}`;
    const error = await resolveInteractiveActivity({
      homeDir: home,
      host: "blade",
      activityId: composite,
    }).then(() => undefined, (thrown: unknown) => thrown as ActivityIdMalformedError);

    expect(error).toBeInstanceOf(ActivityIdMalformedError);
    expect(error).not.toBeInstanceOf(ActivityIdNotFoundError);
    expect(error?.reason).toBe("not_canonical");
    expect(error?.correctedActivityId).toBe(CODEX_ACTIVITY_ID);
    expect(error?.host).toBe("blade");
    expect(error?.message).toContain(`Use: ${CODEX_ACTIVITY_ID} --host blade`);
    expect(error?.message).not.toContain("not found");

    await expect(inspectActivityMessages({
      homeDir: home,
      activityId: composite,
      selector: { role: "assistant", last: 1 },
    })).rejects.toBeInstanceOf(ActivityIdMalformedError);
  });

  test("authorship alias not-found errors name the locator host when it differs (POL-1774)", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage("Local session only."),
    ]);

    const missing = "0fffffff-1111-7222-8333-abcabcabcabc";
    await expect(resolveInteractiveActivity({
      homeDir: home,
      host: "carbon",
      activityId: `codex:blade:${missing}`,
    })).rejects.toThrow(/retry with --host blade/);

    await expect(resolveInteractiveActivity({
      homeDir: home,
      host: "carbon",
      activityId: `codex:carbon:${missing}`,
    })).rejects.toThrow(/not found on host "carbon"\. Activity ids are host-local/);

    // A truncated alias naming a DIFFERENT host must not silently bind to a local
    // session with a colliding uuidv7 prefix; it errors with the --host hint instead.
    await expect(resolveInteractiveActivity({
      homeDir: home,
      host: "carbon",
      activityId: `codex:blade:${CODEX_SESSION_ID.slice(0, 8)}`,
    })).rejects.toThrow(/retry with --host blade/);

    // Host equality is normalized (domain suffix stripped, lowercased): `blade.local`
    // names the same host as `blade`, so no hint fires.
    await expect(resolveInteractiveActivity({
      homeDir: home,
      host: "blade",
      activityId: `codex:blade.local:${missing}`,
    })).rejects.toThrow(/not found on host "blade"\. Activity ids are host-local/);

    // Without a host option the comparison falls back to os.hostname() (mocked:
    // carbon), so a cross-host alias still gets the hint — direct SDK callers
    // never see a self-referential retry.
    await expect(resolveInteractiveActivity({
      homeDir: home,
      activityId: `codex:blade:${missing}`,
    })).rejects.toThrow(/retry with --host blade/);
    await expect(resolveInteractiveActivity({
      homeDir: home,
      activityId: `codex:carbon:${missing}`,
    })).rejects.toThrow(/not found on host "carbon"\. Activity ids are host-local/);
  });

  test("default visibility excludes harness, tools, system notices, and reasoning", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage(AGENTS_PROMPT),
      codexUserMessage("Please look at the daemon health."),
      codexToolCall("shell"),
      codexToolResult("ok"),
      codexAssistantMessage("Daemon is healthy."),
      JSON.stringify({
        timestamp: "2026-04-28T12:00:06.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          content: "redacted reasoning summary",
        },
      }),
    ]);

    const result = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: {},
    });

    const roles = result.messages.map((message) => message.role);
    expect(roles).toContain("human");
    expect(roles).toContain("assistant");
    expect(roles).not.toContain("harness_context");
    expect(roles).not.toContain("tool_call");
    expect(roles).not.toContain("tool_result");
    expect(roles).not.toContain("system_notice");
    expect(roles).not.toContain("reasoning_summary");
  });

  test("Claude raw user tool and metadata payloads do not project to semantic human", async () => {
    const home = await makeHome();
    await writeClaudeSession(home, [
      claudeUserMessage([{ type: "text", text: "Provider metadata: inspect transcript state." }], { isMeta: true }),
      claudeUserMessage("<task-notification>\n<task-id>task-123</task-id>\n<summary>Monitor event</summary>\n</task-notification>"),
      claudeUserMessage("Please inspect Calyx activity."),
      claudeAssistantToolUse(),
      claudeToolResult(""),
      claudeUserMessage([{ type: "text", text: "[Image: source: /tmp/claude-screenshot.png]" }], { isMeta: true }),
      claudeUserMessage("<command-name>/doctor</command-name>\n<command-message>doctor</command-message>"),
    ]);

    const humans = await inspectActivityMessages({
      homeDir: home,
      activityId: CLAUDE_ACTIVITY_ID,
      selector: { role: "human" },
    });

    expect(humans.matched_messages).toBe(1);
    expect(humans.messages).toHaveLength(1);
    expect(humans.messages[0]?.text).toBe("Please inspect Calyx activity.");

    const rawUsers = await inspectActivityEvents({
      homeDir: home,
      activityId: CLAUDE_ACTIVITY_ID,
      selector: { raw_role: "user", classify: true, tail: 10 },
    });

    expect(rawUsers.matched_events).toBe(6);
    const projections = rawUsers.events.map((event) => event.classification?.projected_role);
    expect(projections).toContain("human");
    expect(projections).toContain("tool_result");
    expect(projections.filter((role) => role === "human")).toHaveLength(1);
    expect(rawUsers.events.find((event) => event.summary.startsWith("<task-notification>"))?.classification?.rule_id)
      .toBe("harness/task-notification");
    expect(rawUsers.events.find((event) => event.kind === "user" && event.summary === "user")?.classification?.rule_id)
      .toBe("tool/result-or-stdout");
  });

  test("Codex provider-user harness, skill, and automation payloads do not project to semantic human", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage("<heartbeat>daemon still alive</heartbeat>"),
      codexUserMessage("<skill id=\"calyx-dev\">loaded repo guidance</skill>"),
      codexUserMessage("<plugins_instructions>plugin routing payload</plugins_instructions>"),
      codexUserMessage("Actual Codex prompt"),
      codexToolResult("tool output"),
    ]);

    const humans = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "human" },
    });

    expect(humans.matched_messages).toBe(1);
    expect(humans.messages[0]?.text).toBe("Actual Codex prompt");

    const rawUsers = await inspectActivityEvents({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { raw_role: "user", classify: true, tail: 10 },
    });

    expect(rawUsers.events.filter((event) => event.classification?.projected_role === "human")).toHaveLength(1);
    expect(rawUsers.events.map((event) => event.classification?.projected_role)).toContain("harness_context");
  });

  test("visibility +hidden surfaces harness_context and reasoning_summary", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexUserMessage(AGENTS_PROMPT),
      codexUserMessage("Real prompt"),
      codexAssistantMessage("Reply."),
    ]);

    const result = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { visibility: "+hidden" },
    });
    const roles = result.messages.map((message) => message.role);
    expect(roles).toContain("harness_context");
    expect(roles).toContain("human");
    expect(roles).toContain("assistant");
  });

  test("explain-classification surfaces classifier metadata; default omits the verbose form", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexUserMessage(AGENTS_PROMPT),
      codexUserMessage("Real prompt"),
      codexAssistantMessage("Reply."),
    ]);

    const verbose = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "human", first: 1, explain_classification: true },
    });
    expect(verbose.messages[0]?.classification.rule_id).toBe("human/user-message");
    expect(verbose.messages[0]?.classification.classifier_version).toBe(ACTIVITY_MESSAGE_CLASSIFIER_VERSION);
    expect(verbose.messages[0]?.classification.source_role).toBe("user");

    const compact = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "human", first: 1 },
    });
    // Even compact form keeps classifier metadata so silent drift is detectable;
    // the difference is documented in the projection helper.
    expect(compact.messages[0]?.classification.rule_id).toBe("human/user-message");
  });

  test("message ids are stable across reads and round-trip via --around-id", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexUserMessage("first"),
      codexAssistantMessage("second"),
      codexUserMessage("third"),
      codexAssistantMessage("fourth"),
    ]);

    const first = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: {},
    });
    const second = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: {},
    });
    expect(first.messages.map((m) => m.id)).toEqual(second.messages.map((m) => m.id));

    const target = first.messages[2]!;
    const around = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { around_id: target.id, context: 1 },
    });
    expect(around.messages.map((m) => m.id)).toContain(target.id);
  });

  test("partial final JSONL line is skipped with a warning instead of failing", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexUserMessage("first"),
      codexAssistantMessage("second"),
      // partial final line: legitimate JSON prefix but no closing brace
      "{\"timestamp\":\"2026-04-28T12:00:09.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"partial",
    ], { trailingNewline: false });

    const result = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: {},
    });

    expect(result.source_state).toBe("partial");
    expect(result.warnings.some((w) => w.code === "partial_final_line")).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
  });

  test("--latest-session --backend codex resolves without a copied opaque id", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexSessionMeta(),
      codexUserMessage("hi there"),
      codexAssistantMessage("hello back"),
    ]);
    const result = await inspectActivityMessages({
      homeDir: home,
      latestSession: true,
      latestSessionBackend: "codex",
      selector: { role: "assistant", last: 1 },
    });
    expect(result.activity_id).toBe(CODEX_ACTIVITY_ID);
    expect(result.messages[0]?.text).toBe("hello back");
  });

  test("short-prefix activity id resolves uniquely and errors loud on ambiguity", async () => {
    const home = await makeHome();
    const dir = join(home, ".codex", "sessions", "2026", "04", "28");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "rollout-2026-04-28T12-00-00-019aaaaa-1111-7222-8333-abcabcabcabc.jsonl"),
      `${[codexUserMessage("alpha"), codexAssistantMessage("alpha-reply")].join("\n")}\n`,
      "utf8",
    );
    await writeFile(
      join(dir, "rollout-2026-04-28T12-01-00-019bbbbb-2222-7222-8333-abcabcabcabc.jsonl"),
      `${[codexUserMessage("beta"), codexAssistantMessage("beta-reply")].join("\n")}\n`,
      "utf8",
    );

    const unique = await inspectActivityMessages({
      homeDir: home,
      activityId: "019aaaaa",
      selector: { role: "assistant", last: 1 },
    });
    expect(unique.messages[0]?.text).toBe("alpha-reply");

    await expect(inspectActivityMessages({
      homeDir: home,
      activityId: "019",
      selector: {},
    })).rejects.toBeInstanceOf(ActivityIdAmbiguousError);
  });

  test("`run:` activity ids fail with actionable missing-metadata errors", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [codexUserMessage("noop")]);
    await expect(
      inspectActivityMessages({ homeDir: home, activityId: "run:abc-123", selector: {} }),
    ).rejects.toBeInstanceOf(ActivityRunMissingMetadataError);
    await expect(
      resolveInteractiveActivity({ homeDir: home, activityId: "run:abc-123" }),
    ).rejects.toThrow(/run record lookup is unavailable/);
  });

  test("--first and --last together fail with selector validation error", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [codexUserMessage("noop")]);
    await expect(
      inspectActivityMessages({
        homeDir: home,
        activityId: CODEX_ACTIVITY_ID,
        selector: { first: 1, last: 1 },
      }),
    ).rejects.toBeInstanceOf(ActivityMessageSelectorError);
  });

  test("--around-id and --around-text together fail with selector validation error", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [codexUserMessage("noop")]);
    await expect(
      inspectActivityMessages({
        homeDir: home,
        activityId: CODEX_ACTIVITY_ID,
        selector: { around_id: "x", around_text: "y" },
      }),
    ).rejects.toBeInstanceOf(ActivityMessageSelectorError);
  });

  test("--max-text-chars truncates text and sets truncated flag", async () => {
    const home = await makeHome();
    const longText = "a".repeat(300);
    await writeCodexSession(home, [
      codexUserMessage("anchor"),
      codexAssistantMessage(longText),
    ]);
    const result = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant", last: 1, max_text_chars: 50 },
    });
    expect(result.messages[0]?.text_cursor).toEqual({
      total_chars: 300,
      returned: [[0, 30], [280, 300]],
      next: 30,
    });
    expect(result.messages[0]?.text).toContain("chars 30-280");
    expect(result.messages[0]?.text).toContain("calyx activity text");
    expect(result.messages[0]?.truncated).toBe(true);
  });

  test("--max-text-chars can raise the cap above the default", async () => {
    const home = await makeHome();
    const longText = "a".repeat(5_000);
    await writeCodexSession(home, [
      codexUserMessage("anchor"),
      codexAssistantMessage(longText),
    ]);

    const defaultResult = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant", last: 1 },
    });
    expect(defaultResult.selector.max_text_chars).toBe(4_000);
    expect(defaultResult.messages[0]?.text_cursor?.returned).toEqual([[0, 2400], [3400, 5000]]);
    expect(defaultResult.messages[0]?.text).toContain("chars 2400-3400");
    expect(defaultResult.messages[0]?.truncated).toBe(true);

    const raised = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant", last: 1, max_text_chars: 4_500 },
    });
    expect(raised.messages[0]?.text_cursor?.returned).toEqual([[0, 2700], [3200, 5000]]);
    expect(raised.messages[0]?.text).toContain("chars 2700-3200");
    expect(raised.messages[0]?.truncated).toBe(true);

    const full = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant", last: 1, max_text_chars: 6_000 },
    });
    expect(full.messages[0]?.text?.length).toBe(5_000);
    expect(full.messages[0]?.truncated).toBeUndefined();
  });

  test("raw message projection keeps the default bounded text contract", () => {
    const longText = "z".repeat(5_000);
    const messages = projectInteractiveSessionToMessages([
      {
        index: 0,
        line: 1,
        role: "assistant",
        kind: "message",
        summary: "Long output",
        text: longText.slice(0, 4_000),
        truncated: true,
        raw_payload: {},
      },
    ], {
      activity_id: CODEX_ACTIVITY_ID,
      backend: "codex",
      session_id: CODEX_SESSION_ID,
      session_path: "/tmp/rollout.jsonl",
      source: "codex_sessions",
    });

    expect(messages[0]?.text?.length).toBe(4_000);
    expect(messages[0]?.truncated).toBe(true);
  });

  test("grep and around-text scan full text beyond the default projection cap", async () => {
    const home = await makeHome();
    const marker = "DEEP_SENTINEL";
    const longText = `${"a".repeat(4_500)}${marker}${"b".repeat(100)}`;
    await writeCodexSession(home, [
      codexUserMessage("before"),
      codexAssistantMessage(longText),
      codexUserMessage("after"),
    ]);

    const defaultGrep = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { grep: marker },
    });
    expect(defaultGrep.messages).toHaveLength(1);
    expect(defaultGrep.messages[0]?.role).toBe("assistant");
    expect(defaultGrep.messages[0]?.text).toContain(marker);
    expect(defaultGrep.messages[0]?.text_cursor?.returned[0]?.[0]).toBeGreaterThan(0);
    expect(defaultGrep.messages[0]?.truncated).toBe(true);

    const grep = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { grep: marker, max_text_chars: 6_000 },
    });
    expect(grep.messages).toHaveLength(1);
    expect(grep.messages[0]?.role).toBe("assistant");
    expect(grep.messages[0]?.text).toContain(marker);
    expect(grep.messages[0]?.truncated).toBeUndefined();

    const defaultAroundText = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { around_text: marker, context: 0 },
    });
    expect(defaultAroundText.messages).toHaveLength(1);
    expect(defaultAroundText.messages[0]?.role).toBe("assistant");
    expect(defaultAroundText.messages[0]?.text).toContain(marker);
    expect(defaultAroundText.messages[0]?.truncated).toBe(true);

    const aroundText = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { around_text: marker, context: 0, max_text_chars: 6_000 },
    });
    expect(aroundText.messages).toHaveLength(1);
    expect(aroundText.messages[0]?.role).toBe("assistant");
    expect(aroundText.messages[0]?.text).toContain(marker);
    expect(aroundText.messages[0]?.truncated).toBeUndefined();
  });

  test("streaming projection replaces inline image bytes with attachment refs and extracts by sha", async () => {
    const codexHome = await makeHome();
    const bytes = Buffer.alloc(1_050_000, 7);
    const base64 = bytes.toString("base64");
    const digest = createHash("sha256").update(bytes).digest("hex");
    await writeCodexSession(codexHome, [
      codexUserImageMessage("please inspect this image", `data:image/png;base64,${base64}`),
      codexAssistantMessage("I can see the referenced image."),
    ]);

    const codex = await inspectActivityMessages({
      homeDir: codexHome,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "human", first: 1, max_text_chars: 6_000 },
    });
    expect(codex.source_receipt.mode).toBe("streaming");
    expect(codex.source_receipt.source_bytes).toBeGreaterThan(1_000_000);
    expect(codex.attachments.images).toBe(1);
    expect(codex.attachments.bytes).toBe(bytes.length);
    expect(codex.attachments.refs).toEqual([`att:sha256:${digest}`]);
    expect(codex.messages[0]?.text).toContain(`att:sha256:${digest}`);
    expect(codex.messages[0]?.text).not.toContain("data:image");
    expect(codex.messages[0]?.text).not.toContain(base64.slice(0, 64));
    expect(codex.messages[0]?.attachments?.[0]?.source_shape).toBe("codex.input_image.data_url");

    const textSlice = await inspectActivityText({
      homeDir: codexHome,
      messageId: codex.messages[0]!.id,
      selector: { range: "0:25", classifier_version: codex.classifier_version },
    });
    expect(textSlice.text).toBe("please inspect this image");
    await expect(inspectActivityText({
      homeDir: codexHome,
      messageId: codex.messages[0]!.id,
      selector: { range: "0:4", classifier_version: "v0.stale" },
    })).rejects.toBeInstanceOf(ActivityMessageSelectorError);

    const extracted = await inspectActivityAttachments({
      homeDir: codexHome,
      activityId: CODEX_ACTIVITY_ID,
      selector: { extract: true },
    });
    expect(extracted.attachments).toHaveLength(1);
    expect(extracted.attachments[0]?.extracted_path).toMatch(new RegExp(`${digest}\\.[0-9a-f]{64}\\.png$`));
    const extractedBytes = await readFile(extracted.attachments[0]!.extracted_path!);
    expect(createHash("sha256").update(extractedBytes).digest("hex")).toBe(digest);
    expect(extracted.attachments[0]?.provenance_path).toMatch(
      new RegExp(`${digest}\\.[0-9a-f]{64}\\.provenance\\.json$`),
    );
    expect(extracted.attachments[0]?.cache_status).toBe("written");
    const provenance = JSON.parse(await readFile(extracted.attachments[0]!.provenance_path!, "utf8")) as {
      observations: Array<{ activity_id: string; source_tier: string; classifier_version: string }>;
    };
    expect(provenance.observations[0]).toMatchObject({
      activity_id: CODEX_ACTIVITY_ID,
      source_tier: "local-transcript",
      classifier_version: ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
    });

    const cached = await inspectActivityAttachments({
      homeDir: codexHome,
      activityId: CODEX_ACTIVITY_ID,
      selector: { extract: true, ref: `att:sha256:${digest}` },
    });
    expect(cached.attachments[0]?.cache_status).toBe("hit");
    const cachedProvenance = JSON.parse(await readFile(cached.attachments[0]!.provenance_path!, "utf8")) as {
      observations: unknown[];
    };
    expect(cachedProvenance.observations).toHaveLength(1);

    await writeFile(extracted.attachments[0]!.extracted_path!, "corrupt", "utf8");
    const repaired = await inspectActivityAttachments({
      homeDir: codexHome,
      activityId: CODEX_ACTIVITY_ID,
      selector: { extract: true, ref: `att:sha256:${digest}` },
    });
    expect(repaired.attachments[0]?.cache_status).toBe("rewritten");
    const repairedBytes = await readFile(repaired.attachments[0]!.extracted_path!);
    expect(createHash("sha256").update(repairedBytes).digest("hex")).toBe(digest);

    const record = await inspectActivityAttachmentRecord({
      homeDir: codexHome,
      activityId: CODEX_ACTIVITY_ID,
      ref: `att:sha256:${digest}`,
      servedByHost: "blade",
      sourceTier: "origin-daemon",
    });
    expect(record).toMatchObject({
      schema_version: "activity.attachment-record/v1",
      ref: `att:sha256:${digest}`,
      source_tier: "origin-daemon",
      served_by_host: "blade",
      source_locator: `codex://threads/${CODEX_SESSION_ID}`,
    });
    const byteResult = await readActivityAttachmentBytes({
      homeDir: codexHome,
      activityId: CODEX_ACTIVITY_ID,
      ref: `att:sha256:${digest}`,
    });
    expect(createHash("sha256").update(byteResult.bytes).digest("hex")).toBe(digest);
    await expect(writeVerifiedAttachmentCache({
      outDir: join(codexHome, ".calyx", "cache", "attachments", "sha256"),
      attachment: record,
      bytes: Buffer.alloc(bytes.length, 8),
      sourceTier: "origin-daemon",
    })).rejects.toMatchObject({
      code: "attachment_digest_mismatch",
    } satisfies Partial<ActivityAttachmentError>);

    const claudeHome = await makeHome();
    await writeClaudeSession(claudeHome, [
      claudeUserMessage([
        { type: "text", text: "source shape" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
      ]),
      claudeUserMessage([
        { type: "text", text: "file shape" },
        { type: "image", file: { media_type: "image/png", base64, detail: "original" } },
      ]),
    ]);

    const claude = await inspectActivityMessages({
      homeDir: claudeHome,
      activityId: CLAUDE_ACTIVITY_ID,
      selector: { role: "human", first: 2, max_text_chars: 6_000 },
    });
    expect(claude.source_receipt.mode).toBe("streaming");
    expect(claude.source_receipt.source_bytes).toBeGreaterThan(2_000_000);
    expect(claude.attachments.images).toBe(1);
    expect(claude.messages.map((message) => message.attachments?.[0]?.source_shape)).toEqual([
      "claude.source.base64",
      "claude.file.base64",
    ]);
    expect(claude.messages[0]?.text).toContain(`att:sha256:${digest}`);
    expect(claude.messages[1]?.text).toContain(`att:sha256:${digest}`);
    expect(claude.messages[0]?.text).not.toContain(base64.slice(0, 64));
    expect(claude.messages[1]?.attachments?.[0]?.detail).toBe("original");
  });

  test("malformed transcript UTF-8 cannot originate attachment custody", async () => {
    const home = await makeHome();
    const dir = join(home, ".codex", "sessions", "2026", "04", "28");
    await mkdir(dir, { recursive: true });
    const imageLine = Buffer.from(codexUserImageMessage(
      "invalid-byte-source",
      `data:image/png;base64,${Buffer.from("custody must fail closed").toString("base64")}`,
    ));
    const marker = Buffer.from("invalid-byte-source");
    const markerOffset = imageLine.indexOf(marker);
    expect(markerOffset).toBeGreaterThanOrEqual(0);
    imageLine[markerOffset] = 0xff;
    await writeFile(join(dir, CODEX_FILE), Buffer.concat([
      Buffer.from(`${codexSessionMeta()}\n`),
      imageLine,
      Buffer.from(`\n${codexAssistantMessage("source corruption was skipped")}\n`),
    ]));

    const messages = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "human", first: 10 },
    });
    expect(messages.messages).toEqual([]);
    expect(messages.attachments).toEqual({ images: 0, bytes: 0, refs: [] });
    expect(messages.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unparseable_line", source_line: 2 }),
    ]));
    expect(messages.source_receipt.guard_hits).toContain("source-invalid-utf8");

    const attachments = await inspectActivityAttachments({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: {},
    });
    expect(attachments.attachments).toEqual([]);
  });

  test("keys cache objects and provenance by digest plus MIME identity", async () => {
    const home = await makeHome();
    const outDir = join(home, "cache");
    const bytes = Buffer.from("same bytes, distinct representation identity");
    const image = cacheAttachment(bytes, "image/png");
    const binary = cacheAttachment(bytes, "application/octet-stream");

    const imageResult = await writeVerifiedAttachmentCache({
      outDir,
      attachment: image,
      bytes,
      sourceTier: "local-transcript",
    });
    const binaryResult = await writeVerifiedAttachmentCache({
      outDir,
      attachment: binary,
      bytes,
      sourceTier: "local-transcript",
    });

    expect(imageResult.path).not.toBe(binaryResult.path);
    expect(imageResult.provenance_path).not.toBe(binaryResult.provenance_path);
    expect(imageResult.path).toMatch(new RegExp(`${image.sha256}\\.[0-9a-f]{64}\\.png$`, "u"));
    const imageProvenance = JSON.parse(await readFile(imageResult.provenance_path, "utf8")) as { mime_type: string };
    const binaryProvenance = JSON.parse(await readFile(binaryResult.provenance_path, "utf8")) as { mime_type: string };
    expect(imageProvenance.mime_type).toBe("image/png");
    expect(binaryProvenance.mime_type).toBe("application/octet-stream");
  });

  test("canonicalizes MIME aliases without losing cache custody observations", async () => {
    const home = await makeHome();
    const outDir = join(home, "cache");
    const bytes = Buffer.from("same representation observed through MIME case aliases");
    const first = cacheAttachment(bytes, " image/PNG ");
    const second: ActivityAttachmentRecord = {
      ...cacheAttachment(bytes, "image/png"),
      message_id: `${CODEX_ACTIVITY_ID}:msg:2`,
      source_line: 2,
    };

    const firstResult = await writeVerifiedAttachmentCache({
      outDir,
      attachment: first,
      bytes,
      sourceTier: "local-transcript",
    });
    const secondResult = await writeVerifiedAttachmentCache({
      outDir,
      attachment: second,
      bytes,
      sourceTier: "origin-daemon",
    });

    expect(secondResult.cache_status).toBe("hit");
    expect(secondResult.path).toBe(firstResult.path);
    expect(secondResult.provenance_path).toBe(firstResult.provenance_path);
    const provenance = JSON.parse(await readFile(secondResult.provenance_path, "utf8")) as {
      mime_type: string;
      observations: Array<{ message_id: string }>;
    };
    expect(provenance.mime_type).toBe("image/png");
    expect(provenance.observations.map((observation) => observation.message_id)).toEqual([
      first.message_id,
      second.message_id,
    ]);
  });

  test("preserves bounded additive source tiers across two old-client cache hits", async () => {
    const home = await makeHome();
    const outDir = join(home, "cache");
    const bytes = Buffer.from("rolling source-tier custody");
    const attachment = cacheAttachment(bytes);
    const initial = await writeVerifiedAttachmentCache({
      outDir,
      attachment,
      bytes,
      sourceTier: "local-transcript",
      fetchedAt: "2026-07-13T10:00:00.000Z",
    });
    const futureTier = "regional-cache/v2";
    const firstRemote = {
      ...attachment,
      message_id: `${attachment.activity_id}:msg:future-1`,
      source_line: 2,
    };
    const secondRemote = {
      ...attachment,
      message_id: `${attachment.activity_id}:msg:future-2`,
      source_line: 3,
    };

    await recordVerifiedAttachmentCacheHit({
      outDir,
      attachment: firstRemote,
      sourceTier: futureTier,
      fetchedAt: "2026-07-13T10:00:01.000Z",
    });
    await recordVerifiedAttachmentCacheHit({
      outDir,
      attachment: secondRemote,
      sourceTier: futureTier,
      fetchedAt: "2026-07-13T10:00:02.000Z",
    });

    const provenance = JSON.parse(await readFile(initial.provenance_path, "utf8")) as {
      observations: Array<{ message_id: string; source_tier: string }>;
    };
    expect(provenance.observations.map(({ message_id, source_tier }) => ({
      message_id,
      source_tier,
    }))).toEqual([
      { message_id: attachment.message_id, source_tier: "local-transcript" },
      { message_id: firstRemote.message_id, source_tier: futureTier },
      { message_id: secondRemote.message_id, source_tier: futureTier },
    ]);

    const beforeInvalidTier = await readFile(initial.provenance_path);
    await expect(recordVerifiedAttachmentCacheHit({
      outDir,
      attachment: { ...attachment, message_id: `${attachment.activity_id}:msg:invalid-tier` },
      sourceTier: "contains whitespace",
    })).rejects.toThrow(/1-128 character ASCII custody token/u);
    expect(await readFile(initial.provenance_path)).toEqual(beforeInvalidTier);
  });

  test("promotes and retires the live legacy cache generation on first verified access", async () => {
    const home = await makeHome();
    const outDir = join(home, "cache");
    const bytes = Buffer.from("legacy cache generation");
    const attachment = cacheAttachment(bytes);
    await mkdir(outDir, { recursive: true });
    const legacyObject = join(outDir, `${attachment.sha256}.png`);
    const legacyProvenance = join(outDir, `${attachment.sha256}.provenance.json`);
    await writeFile(legacyObject, bytes);
    await writeFile(legacyProvenance, JSON.stringify({ ambiguous: "legacy MIME identity" }));

    const promoted = await recordVerifiedAttachmentCacheHit({
      outDir,
      attachment,
      sourceTier: "local-transcript",
    });

    expect(promoted?.cache_status).toBe("hit");
    expect(promoted?.path).not.toBe(legacyObject);
    expect(await readFile(promoted!.path)).toEqual(bytes);
    const names = await readdir(outDir);
    expect(names).not.toContain(`${attachment.sha256}.png`);
    expect(names).not.toContain(`${attachment.sha256}.provenance.json`);
  });

  test("serializes cache observations without lost updates and enforces the provenance cap", async () => {
    const home = await makeHome();
    const outDir = join(home, "cache");
    const bytes = Buffer.from("concurrent provenance");
    const attachment = cacheAttachment(bytes);
    const initial = await writeVerifiedAttachmentCache({
      outDir,
      attachment,
      bytes,
      sourceTier: "local-transcript",
    });
    const observation = (index: number): ActivityAttachmentRecord => ({
      ...attachment,
      activity_id: `interactive:codex:cache-${index}`,
      message_id: `interactive:codex:cache-${index}:msg:1`,
      source_line: index + 2,
    });

    await Promise.all(Array.from({ length: 32 }, (_, index) => recordVerifiedAttachmentCacheHit({
      outDir,
      attachment: observation(index),
      sourceTier: "origin-daemon",
      fetchedAt: new Date(Date.UTC(2026, 6, 13, 0, 0, 0, index)).toISOString(),
    })));
    const afterConcurrent = JSON.parse(await readFile(initial.provenance_path, "utf8")) as {
      observations: Array<{ message_id: string }>;
    };
    expect(afterConcurrent.observations).toHaveLength(33);
    expect(new Set(afterConcurrent.observations.map((item) => item.message_id)).size).toBe(33);

    await Promise.all(Array.from({ length: 80 }, (_, offset) => recordVerifiedAttachmentCacheHit({
      outDir,
      attachment: observation(offset + 32),
      sourceTier: "blade-archive",
      fetchedAt: new Date(Date.UTC(2026, 6, 13, 0, 1, 0, offset)).toISOString(),
    })));
    const capped = JSON.parse(await readFile(initial.provenance_path, "utf8")) as {
      observations: Array<{ message_id: string }>;
    };
    expect(capped.observations).toHaveLength(ACTIVITY_ATTACHMENT_CACHE_OBSERVATION_MAX_ITEMS);
    expect(new Set(capped.observations.map((item) => item.message_id)).size).toBe(
      ACTIVITY_ATTACHMENT_CACHE_OBSERVATION_MAX_ITEMS,
    );
  });

  test("bounds and self-heals oversized or malformed predecessor provenance", async () => {
    const home = await makeHome();
    const outDir = join(home, "cache");
    const bytes = Buffer.from("bounded provenance");
    const attachment = cacheAttachment(bytes);
    const initial = await writeVerifiedAttachmentCache({
      outDir,
      attachment,
      bytes,
      sourceTier: "local-transcript",
    });

    await writeFile(
      initial.provenance_path,
      Buffer.alloc(ACTIVITY_ATTACHMENT_CACHE_PROVENANCE_MAX_BYTES + 1, 0x20),
    );
    await recordVerifiedAttachmentCacheHit({
      outDir,
      attachment: { ...attachment, message_id: `${attachment.activity_id}:msg:oversized` },
      sourceTier: "origin-daemon",
    });
    const healedOversized = JSON.parse(await readFile(initial.provenance_path, "utf8")) as {
      observations: Array<{ message_id: string }>;
    };
    expect(healedOversized.observations.map((entry) => entry.message_id)).toEqual([
      `${attachment.activity_id}:msg:oversized`,
    ]);

    await writeFile(initial.provenance_path, JSON.stringify({
      schema_version: "activity.attachment-cache-entry/v1",
      ref: attachment.ref,
      sha256: attachment.sha256,
      mime_type: attachment.mime_type,
      extension: "png",
      byte_size: attachment.byte_size,
      observations: [null],
    }));
    await recordVerifiedAttachmentCacheHit({
      outDir,
      attachment: { ...attachment, message_id: `${attachment.activity_id}:msg:malformed` },
      sourceTier: "blade-archive",
    });
    const healedMalformed = JSON.parse(await readFile(initial.provenance_path, "utf8")) as {
      observations: Array<{ message_id: string }>;
    };
    expect(healedMalformed.observations.map((entry) => entry.message_id)).toEqual([
      `${attachment.activity_id}:msg:malformed`,
    ]);
  });

  test("fails closed on malformed UTF-8 in permissive provenance strings", async () => {
    const home = await makeHome();
    const bytes = Buffer.from("fatal UTF-8 custody evidence");
    for (const field of ["activity_id", "classifier_version"] as const) {
      const outDir = join(home, `cache-${field}`);
      const attachment = cacheAttachment(bytes);
      const initial = await writeVerifiedAttachmentCache({
        outDir,
        attachment,
        bytes,
        sourceTier: "local-transcript",
      });
      const entry = JSON.parse(await readFile(initial.provenance_path, "utf8")) as {
        observations: Array<Record<string, unknown>>;
      };
      const marker = `malformed-${field}-marker`;
      entry.observations[0]![field] = marker;
      const serialized = Buffer.from(JSON.stringify(entry));
      const markerBytes = Buffer.from(marker);
      const markerOffset = serialized.indexOf(markerBytes);
      expect(markerOffset).toBeGreaterThanOrEqual(0);
      const rawEvidence = Buffer.concat([
        serialized.subarray(0, markerOffset),
        Buffer.from([0xc3, 0x28]),
        serialized.subarray(markerOffset + markerBytes.length),
      ]);
      await writeFile(initial.provenance_path, rawEvidence);

      await expect(recordVerifiedAttachmentCacheHit({
        outDir,
        attachment: {
          ...attachment,
          message_id: `${attachment.activity_id}:msg:after-malformed-${field}`,
        },
        sourceTier: "origin-daemon",
      })).rejects.toThrow(/not valid UTF-8; refusing to replace original custody evidence/u);
      expect(await readFile(initial.provenance_path)).toEqual(rawEvidence);
    }
  });

  test("rejects oversized in-memory cache writes before creating cache state", async () => {
    const home = await makeHome();
    const outDir = join(home, "cache");
    const bytes = Buffer.alloc(ACTIVITY_ATTACHMENT_MAX_BYTES + 1, 0x61);
    const attachment = cacheAttachment(bytes);
    await expect(writeVerifiedAttachmentCache({
      outDir,
      attachment,
      bytes,
      sourceTier: "local-transcript",
    })).rejects.toThrow(`hard maximum of ${ACTIVITY_ATTACHMENT_MAX_BYTES} bytes`);
    await expect(readdir(outDir)).rejects.toThrow();
  });

  test("an exact retry completes provenance after the content-addressed object committed first", async () => {
    const home = await makeHome();
    const outDir = join(home, "cache");
    const bytes = Buffer.from("retryable provenance publication");
    const attachment = cacheAttachment(bytes);
    await mkdir(outDir, { recursive: true });
    const mutexBlocker = join(outDir, "_mutexes");
    await writeFile(mutexBlocker, "block mutex directory creation", "utf8");

    await expect(writeVerifiedAttachmentCache({
      outDir,
      attachment,
      bytes,
      sourceTier: "origin-daemon",
    })).rejects.toThrow();
    await expect(readVerifiedAttachmentCache(outDir, attachment)).resolves.toBeDefined();

    await rm(mutexBlocker);
    const retried = await writeVerifiedAttachmentCache({
      outDir,
      attachment,
      bytes,
      sourceTier: "origin-daemon",
    });
    expect(retried.cache_status).toBe("hit");
    const provenance = JSON.parse(await readFile(retried.provenance_path, "utf8")) as { observations: unknown[] };
    expect(provenance.observations).toHaveLength(1);
  });

  test("--summary-only strips text from message bodies", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexUserMessage("anchor"),
      codexAssistantMessage("verbose body"),
    ]);
    const result = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { role: "assistant", last: 1, summary_only: true },
    });
    expect(result.messages[0]?.text).toBeUndefined();
    expect(result.messages[0]?.summary.length).toBeGreaterThan(0);
  });
});

describe("activity events", () => {
  test("--classify exposes classifier metadata + projected role on raw events", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexUserMessage(AGENTS_PROMPT),
      codexUserMessage("Real prompt"),
    ]);
    const result = await inspectActivityEvents({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { raw_role: "user", classify: true },
    });
    expect(result.events.length).toBeGreaterThan(1);
    const harnessEvent = result.events.find((event) => event.classification?.projected_role === "harness_context");
    const humanEvent = result.events.find((event) => event.classification?.projected_role === "human");
    expect(harnessEvent).toBeDefined();
    expect(humanEvent).toBeDefined();
    expect(harnessEvent?.classification?.rule_id).toMatch(/^harness\//);
    expect(humanEvent?.classification?.rule_id).toBe("human/user-message");
  });

  test("--around-id resolves message-id and event-line forms", async () => {
    const home = await makeHome();
    await writeCodexSession(home, [
      codexUserMessage("anchor"),
      codexAssistantMessage("middle"),
      codexUserMessage("after"),
    ]);
    const messages = await inspectActivityMessages({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: {},
    });
    const target = messages.messages.find((m) => m.role === "assistant")!;
    const events = await inspectActivityEvents({
      homeDir: home,
      activityId: CODEX_ACTIVITY_ID,
      selector: { around_id: target.id, context: 0 },
    });
    expect(events.events).toHaveLength(1);
    expect(events.events[0]?.line).toBe(target.source_lines[0]);
  });
});
