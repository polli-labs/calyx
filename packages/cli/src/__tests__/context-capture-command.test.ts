import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  ActivityMessage,
  ActivityMessagesResult,
  ActivityTurnsResult,
  InteractiveSessionInspectResult,
  RecordedRunEvent,
  RunActivityEntry,
  RunIntent,
  RunListEntry,
  RunRecord,
} from "@polli-labs/calyx-run-service";
import { buildProgram, type RunCliDependencies } from "../run-cli";

const tempDirs: string[] = [];

const SOURCE_RECEIPT = {
  mode: "streaming" as const,
  bytes_scanned: 128,
  records_scanned: 3,
  records_decoded: 3,
  oversized_records_skipped: 0,
  max_record_bytes: 64 * 1024 * 1024,
  source_bytes: 128,
  guard_hits: [],
};

const EMPTY_ATTACHMENTS = {
  images: 0,
  bytes: 0,
  refs: [],
};

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env["VAULT_PATH"];
  delete process.env["LINEAR_API_KEY"];
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function makeMessage(args: {
  id: string;
  turnId: string;
  role: "human" | "assistant";
  text: string;
  line: number;
  truncated?: boolean;
}): ActivityMessage {
  return {
    id: args.id,
    activity_id: "interactive:codex:session-1",
    activity: {
      activity_id: "interactive:codex:session-1",
      backend: "codex",
      session_id: "session-1",
      session_path: "/tmp/session.jsonl",
      source: "codex_sessions",
      cwd: "/Users/carbon/dev/calyx/dev",
      host: "carbon",
    },
    turn_id: args.turnId,
    role: args.role,
    visibility: "default",
    text: args.text,
    summary: args.text,
    timestamp: "2026-04-28T12:00:00.000Z",
    ...(args.truncated ? { truncated: true } : {}),
    event_refs: [args.line],
    source_lines: [args.line],
    classification: {
      classifier_version: "v1.test",
      rule_id: `${args.role}/message`,
      reason: "test",
      source_role: args.role === "human" ? "user" : "assistant",
      source_kind: "message",
    },
  };
}

function makeTurnsResult(role: "human" | "assistant", text: string, index: number): ActivityTurnsResult {
  const turnId = `interactive:codex:session-1:turn:${index}`;
  const message = makeMessage({
    id: `interactive:codex:session-1:msg:${index}`,
    turnId,
    role,
    text,
    line: index,
  });
  return {
    schema_version: "activity.turns/v1",
    classifier_version: "v1.test",
    activity_id: "interactive:codex:session-1",
    backend: "codex",
    session_id: "session-1",
    session_path: "/tmp/session.jsonl",
    source: "codex_sessions",
    cwd: "/Users/carbon/dev/calyx/dev",
    host: "carbon",
    source_state: "complete",
    warnings: [],
    source_receipt: SOURCE_RECEIPT,
    total_events: 2,
    total_messages: 2,
    total_turns: 2,
    matched_turns: 1,
    returned_turns: 1,
    truncated: false,
    selector: { role, last: 1, max_text_chars: 4000 },
    turns: [{
      turn_id: turnId,
      index,
      activity_id: "interactive:codex:session-1",
      role,
      state: "complete",
      started_at: "2026-04-28T12:00:00.000Z",
      ended_at: "2026-04-28T12:00:05.000Z",
      source_lines: [index, index],
      event_refs: [index, index],
      total_message_count: 1,
      visible_message_count: 1,
      tool_call_count: 0,
      tool_result_count: 0,
      attachments: EMPTY_ATTACHMENTS,
      summary: text,
      first_message_id: message.id,
      last_message_id: message.id,
      messages: [message],
    }],
  };
}

function makeMessagesResult(messages: ActivityMessage[]): ActivityMessagesResult {
  return {
    schema_version: "activity.messages/v1",
    classifier_version: "v1.test",
    activity_id: "interactive:codex:session-1",
    backend: "codex",
    session_id: "session-1",
    session_path: "/tmp/session.jsonl",
    source: "codex_sessions",
    cwd: "/Users/carbon/dev/calyx/dev",
    host: "carbon",
    source_state: "complete",
    warnings: [],
    source_receipt: SOURCE_RECEIPT,
    total_events: 4,
    total_messages: messages.length,
    matched_messages: messages.length,
    returned_messages: messages.length,
    truncated: false,
    attachments: EMPTY_ATTACHMENTS,
    selector: { visibility: "default", around_text: "handoff", context: 1, max_text_chars: 4000 },
    messages,
  };
}

function buildContextCaptureDeps(args: {
  inspectTurnsSpy: ReturnType<typeof vi.fn>;
  inspectMessagesSpy?: ReturnType<typeof vi.fn>;
  now?: Date;
}): RunCliDependencies {
  return {
    now: () => args.now ?? new Date("2026-04-28T12:34:56.000Z"),
    createRunService: () => ({
      createIntent: vi.fn((input: Partial<RunIntent> & Pick<RunIntent, "host">) => ({
        run_id: input.run_id ?? "noop",
        host: input.host,
        created_at: "2026-04-28T12:00:00.000Z",
      })),
      launch: vi.fn(async () => ({
        run_id: "noop",
        state: "queued" as RunRecord["state"],
        mode: "background" as const,
        run_dir: "/tmp",
        record: {} as RunRecord,
      })),
      getRunRecord: vi.fn(async () => undefined),
      getKernelReceipt: vi.fn(async () => undefined),
      listRuns: vi.fn(async (): Promise<RunListEntry[]> => []),
      listActivity: vi.fn(async (): Promise<RunActivityEntry[]> => []),
      inspectInteractiveSession: vi.fn(async (): Promise<InteractiveSessionInspectResult> => ({
        activity_id: "interactive:codex:session-1",
        backend: "codex",
        session_id: "session-1",
        session_path: "/tmp/session.jsonl",
        source: "codex_sessions",
        total_events: 0,
        returned_events: 0,
        truncated: false,
        include_tools: false,
        events: [],
      })),
      inspectActivityTurns: args.inspectTurnsSpy,
      inspectActivityMessages: args.inspectMessagesSpy ?? vi.fn(async (): Promise<ActivityMessagesResult> => makeMessagesResult([])),
      readEvents: vi.fn(async (): Promise<RecordedRunEvent[]> => []),
      resolveResumeWorktreePath: vi.fn(async () => ({ path: "/tmp/resolved", source: "run_spec" as const })),
      stop: vi.fn(async (runId: string) => ({
        schema_version: "calyx.run-cancellation-result/v1" as const,
        status: "already_terminal" as const,
        run_id: runId,
      })),
      reconcile: vi.fn(async () => ({ scanned: 0, rebuilt: [], classified: [], adopted: [], unresolved: [], skipped: [], noncanonical_directories: [], projection: { status: "not_configured" as const } })),
      executeStoredRun: vi.fn(async () => ({} as RunRecord)),
    }),
  };
}

describe("calyx context capture command", () => {
  test("capture plan previews selected activity turns for a vault note", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-context-capture-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    await mkdir(vaultPath, { recursive: true });
    const inspectTurnsSpy = vi.fn(async (input: { selector?: { role?: string } }) => {
      return input.selector?.role === "human"
        ? makeTurnsResult("human", "Please write down the handoff.", 1)
        : makeTurnsResult("assistant", "I will capture the key context.", 2);
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: buildContextCaptureDeps({ inspectTurnsSpy }) });

    await program.parseAsync([
      "node", "calyx", "context", "capture", "plan",
      "--from-activity", "interactive:codex:session-1",
      "--turn", "human:last:1",
      "--turn", "assistant:last:1",
      "--daily",
      "--title", "Session Handoff",
      "--issue", "POL-1513",
      "--notes", "Carry this forward.",
      "--vault-path", vaultPath,
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      mode: string;
      dry_run: boolean;
      selected_turn_ids: string[];
      vault: { relative_path: string };
      estimated_bytes: number;
      apply_command: string;
      warnings: Array<{ code: string; message: string }>;
    };
    expect(payload).toMatchObject({
      schema_version: "context.capture/v1",
      mode: "plan",
      dry_run: true,
      selected_turn_ids: [
        "interactive:codex:session-1:turn:1",
        "interactive:codex:session-1:turn:2",
      ],
      vault: {
        relative_path: "10-daily/2026-04-28/pol-1513-session-handoff.md",
      },
      warnings: [],
    });
    expect(payload.estimated_bytes).toBeGreaterThan(0);
    expect(payload.apply_command).toContain("calyx context capture apply");
    expect(payload.apply_command).toContain("--from-activity interactive:codex:session-1");
    expect(inspectTurnsSpy).toHaveBeenCalledTimes(2);
  });

  test("capture plan resolves latest backend selectors and prints apply guidance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-context-capture-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    await mkdir(vaultPath, { recursive: true });
    const inspectTurnsSpy = vi.fn(async (input: {
      latestSession?: boolean;
      latestSessionBackend?: string;
      activityId?: string;
      selector?: { role?: string };
    }) => {
      return input.selector?.role === "human"
        ? makeTurnsResult("human", "Please roll this into the vault.", 1)
        : makeTurnsResult("assistant", "I will capture it.", 2);
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: buildContextCaptureDeps({ inspectTurnsSpy }) });

    await program.parseAsync([
      "node", "calyx", "context", "capture", "plan",
      "--from-activity", "latest:codex",
      "--daily",
      "--title", "Latest Codex Handoff",
      "--vault-path", vaultPath,
      "--json",
    ]);

    const firstCall = inspectTurnsSpy.mock.calls[0]?.[0] as {
      latestSession?: boolean;
      latestSessionBackend?: string;
      activityId?: string;
    };
    expect(firstCall).toMatchObject({
      latestSession: true,
      latestSessionBackend: "codex",
    });
    expect(firstCall.activityId).toBeUndefined();
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      source_activity_id: string;
      estimated_bytes: number;
      apply_command: string;
    };
    expect(payload.source_activity_id).toBe("interactive:codex:session-1");
    expect(payload.estimated_bytes).toBeGreaterThan(0);
    expect(payload.apply_command).toContain("--from-activity latest:codex");
  });

  test("capture plan rejects ambiguous daily and typed destinations", async () => {
    const inspectTurnsSpy = vi.fn(async () => makeTurnsResult("assistant", "unused", 1));
    const program = buildProgram({ runCli: buildContextCaptureDeps({ inspectTurnsSpy }) });

    await expect(program.parseAsync([
      "node", "calyx", "context", "capture", "plan",
      "--from-activity", "interactive:codex:session-1",
      "--daily",
      "--type", "context",
      "--title", "Ambiguous Destination",
      "--json",
    ])).rejects.toThrow(/--daily and --type are mutually exclusive/);
    expect(inspectTurnsSpy).not.toHaveBeenCalled();
  });

  test("capture plan includes around-text message context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-context-capture-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    await mkdir(vaultPath, { recursive: true });
    const inspectTurnsSpy = vi.fn(async (input: { selector?: { role?: string } }) => {
      return input.selector?.role === "human"
        ? makeTurnsResult("human", "The current turn names the handoff.", 1)
        : makeTurnsResult("assistant", "I can capture nearby context too.", 2);
    });
    const nearby = makeMessage({
      id: "interactive:codex:session-1:msg:nearby",
      turnId: "interactive:codex:session-1:turn:0",
      role: "assistant",
      text: "Earlier handoff detail worth retaining.",
      line: 10,
    });
    const inspectMessagesSpy = vi.fn(async () => makeMessagesResult([nearby]));
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: buildContextCaptureDeps({ inspectTurnsSpy, inspectMessagesSpy }) });

    await program.parseAsync([
      "node", "calyx", "context", "capture", "plan",
      "--from-activity", "interactive:codex:session-1",
      "--around-text", "handoff detail",
      "--context", "1",
      "--daily",
      "--title", "Context Window",
      "--vault-path", vaultPath,
      "--json",
    ]);

    expect(inspectMessagesSpy).toHaveBeenCalledWith(expect.objectContaining({
      activityId: "interactive:codex:session-1",
      selector: expect.objectContaining({
        around_text: "handoff detail",
        context: 1,
        max_text_chars: 4000,
      }),
    }));
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      selected_message_ids: string[];
    };
    expect(payload.selected_message_ids).toContain("interactive:codex:session-1:msg:nearby");
  });

  test("capture apply writes the vault note and a receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-context-capture-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    await mkdir(vaultPath, { recursive: true });
    const inspectTurnsSpy = vi.fn(async (input: { selector?: { role?: string } }) => {
      return input.selector?.role === "human"
        ? makeTurnsResult("human", "The conductor needs this context.", 1)
        : makeTurnsResult("assistant", "The next step is implementation.", 2);
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: buildContextCaptureDeps({ inspectTurnsSpy }) });

    await program.parseAsync([
      "node", "calyx", "context", "capture", "apply",
      "--from-activity", "interactive:codex:session-1",
      "--turn", "human:last:1",
      "--turn", "assistant:last:1",
      "--daily",
      "--title", "Session Handoff",
      "--issue", "POL-1513",
      "--notes", "Operator-selected handoff note.",
      "--vault-path", vaultPath,
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      mode: string;
      dry_run: boolean;
      vault: { output_path: string; relative_path: string };
      receipt_path: string;
      selected_message_ids: string[];
      estimated_bytes: number;
    };
    expect(payload.mode).toBe("apply");
    expect(payload.dry_run).toBe(false);
    expect(payload.vault.relative_path).toBe("10-daily/2026-04-28/pol-1513-session-handoff.md");
    expect(payload.selected_message_ids).toEqual([
      "interactive:codex:session-1:msg:1",
      "interactive:codex:session-1:msg:2",
    ]);
    expect(payload.estimated_bytes).toBeGreaterThan(0);

    const note = await readFile(payload.vault.output_path, "utf8");
    expect(note).toContain("capture_version: context.capture/v1");
    expect(note).toContain("source_activity_id: interactive:codex:session-1");
    expect(note).toContain("Operator-selected handoff note.");
    expect(note).toContain("The conductor needs this context.");
    expect(note).toContain("The next step is implementation.");

    const receipt = JSON.parse(await readFile(payload.receipt_path, "utf8")) as {
      schema_version: string;
      output_path: string;
      selected_turn_ids: string[];
      estimated_bytes: number;
    };
    expect(receipt).toMatchObject({
      schema_version: "context.capture.receipt/v1",
      output_path: payload.vault.output_path,
      estimated_bytes: payload.estimated_bytes,
      selected_turn_ids: [
        "interactive:codex:session-1:turn:1",
        "interactive:codex:session-1:turn:2",
      ],
    });
  });

  test("capture apply surfaces selected message truncation in result, note, and receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-context-capture-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    await mkdir(vaultPath, { recursive: true });
    const inspectTurnsSpy = vi.fn(async (input: { selector?: { role?: string; max_text_chars?: number } }) => {
      const result = makeTurnsResult("human", "x".repeat(30_000), 1);
      const message = result.turns[0]?.messages[0];
      if (message) {
        message.text = "x".repeat(12_000);
        message.summary = "Long selected scratch note.";
        message.truncated = true;
      }
      result.selector = {
        role: input.selector?.role === "assistant" ? "assistant" : "human",
        last: 1,
        max_text_chars: input.selector?.max_text_chars ?? 4_000,
      };
      return result;
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: buildContextCaptureDeps({ inspectTurnsSpy }) });

    await program.parseAsync([
      "node", "calyx", "context", "capture", "apply",
      "--from-activity", "interactive:codex:session-1",
      "--turn", "human:last:1",
      "--daily",
      "--title", "Long Scratch Capture",
      "--max-text-chars", "30000",
      "--vault-path", vaultPath,
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      requested_max_text_chars: number;
      effective_max_text_chars: number;
      truncated_message_ids: string[];
      warnings: Array<{ code: string; message_id?: string }>;
      vault: { output_path: string };
      receipt_path: string;
    };
    const expectedMessageId = "interactive:codex:session-1:msg:1";
    expect(payload.requested_max_text_chars).toBe(30_000);
    expect(payload.effective_max_text_chars).toBe(30_000);
    expect(payload.truncated_message_ids).toEqual([expectedMessageId]);
    expect(payload.warnings).toContainEqual(expect.objectContaining({
      code: "message_text_truncated",
      message_id: expectedMessageId,
    }));
    expect(inspectTurnsSpy.mock.calls[0]?.[0]).toMatchObject({
      selector: expect.objectContaining({ max_text_chars: 30_000 }),
    });

    const note = await readFile(payload.vault.output_path, "utf8");
    expect(note).toContain("- requested_max_text_chars: 30000");
    expect(note).toContain("- effective_max_text_chars: 30000");
    expect(note).toContain("- truncated_messages: 1");
    expect(note).toContain("## Capture Warnings");
    expect(note).toContain(`message_text_truncated \`${expectedMessageId}\``);
    expect(note).toContain("- truncated: `true`");

    const receipt = JSON.parse(await readFile(payload.receipt_path, "utf8")) as {
      requested_max_text_chars: number;
      effective_max_text_chars: number;
      truncated_message_ids: string[];
      warnings: Array<{ code: string; message_id?: string }>;
    };
    expect(receipt.requested_max_text_chars).toBe(30_000);
    expect(receipt.effective_max_text_chars).toBe(30_000);
    expect(receipt.truncated_message_ids).toEqual([expectedMessageId]);
    expect(receipt.warnings).toContainEqual(expect.objectContaining({
      code: "message_text_truncated",
      message_id: expectedMessageId,
    }));
  });

  test("capture apply reads extra framing from --notes-file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-context-capture-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    await mkdir(vaultPath, { recursive: true });
    const notesPath = path.join(root, "notes.md");
    await writeFile(notesPath, "File-backed framing note.", "utf8");
    const inspectTurnsSpy = vi.fn(async (input: { selector?: { role?: string } }) => {
      return input.selector?.role === "human"
        ? makeTurnsResult("human", "Please save this.", 1)
        : makeTurnsResult("assistant", "Saved with file notes.", 2);
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: buildContextCaptureDeps({ inspectTurnsSpy }) });

    await program.parseAsync([
      "node", "calyx", "context", "capture", "apply",
      "--from-activity", "interactive:codex:session-1",
      "--daily",
      "--title", "Notes File Handoff",
      "--notes-file", notesPath,
      "--vault-path", vaultPath,
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      vault: { output_path: string };
      apply_command: string;
    };
    const note = await readFile(payload.vault.output_path, "utf8");
    expect(note).toContain("File-backed framing note.");
    expect(payload.apply_command).toContain("--notes-file");
  });
});
