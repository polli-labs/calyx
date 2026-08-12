import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ActivityMessageSelectorError,
  ActivityTurnSelectorError,
  parseActivityMessageId,
  parseActivityTurnId,
} from "../activity-messages.js";
import {
  ActivityMarkTargetAmbiguousError,
  ActivityMarkTargetNotFoundError,
  ActivityMarkTargetUnavailableError,
} from "../service.js";
import { RunService } from "./support/test-run-service.js";
import type { RunRecord } from "../types.js";

const created: string[] = [];
const SESSION_ID = "019f9000-1111-7222-8333-abcabcabcabc";
const ACTIVITY_ID = `interactive:codex:${SESSION_ID}`;
const NOW = new Date("2026-07-21T12:30:00.000Z");
const MARK_TARGET_MISS = {
  code: "mark_target_unknown",
  message: "Mark target was not found on this daemon's consumer-visible activity projection.",
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
  created.length = 0;
});

async function makeFixture(options: {
  beforeDiscoveryRead?: (directoryPath: string) => Promise<void>;
  beforeCandidateStat?: (candidatePath: string) => Promise<void>;
} = {}): Promise<{
  home: string;
  runsRoot: string;
  service: RunService;
  sessionPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "calyx-activity-mark-target-"));
  created.push(root);
  const home = join(root, "home");
  const runsRoot = join(root, "runs");
  const sessionDir = join(home, ".codex", "sessions", "2026", "07", "21");
  const sessionPath = join(sessionDir, `rollout-2026-07-21T12-00-00-${SESSION_ID}.jsonl`);
  await mkdir(sessionDir, { recursive: true });
  await mkdir(runsRoot, { recursive: true });
  await writeFile(sessionPath, [
    codexSessionMeta(SESSION_ID),
    codexReasoning(),
    codexUserMessage("# AGENTS.md instructions\n<INSTRUCTIONS>hidden</INSTRUCTIONS>"),
    codexUserMessage("Visible consumer request", "2026-07-21T12:00:03.000Z"),
    codexToolCall(),
    codexAssistantMessage("Visible consumer response"),
  ].join("\n") + "\n", "utf8");
  await utimes(sessionPath, NOW, NOW);
  const service = new RunService({
    runsRoot,
    interactiveHomeDir: home,
    activityRecall: { enabled: false },
    handback: { enabled: false },
    leases: { enabled: false },
    subscribers: [],
    ...(options.beforeDiscoveryRead
      ? { interactiveBeforeDiscoveryRead: options.beforeDiscoveryRead }
      : {}),
    ...(options.beforeCandidateStat
      ? { interactiveBeforeCandidateStat: options.beforeCandidateStat }
      : {}),
  }, {
    hostname: () => "blade",
    now: () => NOW.toISOString(),
  });
  return { home, runsRoot, service, sessionPath };
}

function codexSessionMeta(sessionId: string): string {
  return JSON.stringify({
    timestamp: "2026-07-21T12:00:00.000Z",
    type: "session_meta",
    payload: {
      id: sessionId,
      timestamp: "2026-07-21T12:00:00.000Z",
      cwd: "/home/caleb/dev/calyx/dev",
    },
  });
}

function codexUserMessage(text: string, timestamp = "2026-07-21T12:00:02.000Z"): string {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
}

function codexAssistantMessage(text: string): string {
  return JSON.stringify({
    timestamp: "2026-07-21T12:00:05.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  });
}

function codexReasoning(): string {
  return JSON.stringify({
    timestamp: "2026-07-21T12:00:01.000Z",
    type: "response_item",
    payload: { type: "reasoning", content: "hidden reasoning" },
  });
}

function codexToolCall(): string {
  return JSON.stringify({
    timestamp: "2026-07-21T12:00:04.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      arguments: "{\"cmd\":\"true\"}",
    },
  });
}

function makeRunRecord(
  runId: string,
  sessionPath: string,
  host: string,
): RunRecord {
  return {
    schema_version: "1.0",
    run_id: runId,
    state: "succeeded",
    intent: {
      run_id: runId,
      kernel: "agent_runner",
      host,
      backend: "codex",
      created_at: "2026-07-21T12:00:00.000Z",
    },
    launch: {
      mode: "inline",
      stage: "executing",
      admission_identity: "test-admission",
      request_hash: "test-request",
      accepted_at: "2026-07-21T12:00:00.000Z",
      dispatch_attempts: 0,
    },
    kernel_receipt: {
      schema_version: "1.0",
      run_id: runId,
      state: "succeeded",
      run_spec: {
        run_id: runId,
        host,
        backend: "codex",
        profile: "medium",
        prompt: "prompt",
        require_execplan: false,
        pull_execplan: false,
        worktree: { mode: "existing", path: "/tmp/worktree" },
      },
      timing: {
        created_at: "2026-07-21T12:00:00.000Z",
        completed_at: "2026-07-21T12:05:00.000Z",
        duration_ms: 300_000,
      },
      exit: { exit_code: 0 },
      artifacts: {
        run_id: runId,
        finalized_at: "2026-07-21T12:05:00.000Z",
        required: [],
        discovered: [],
        gate_passed: true,
        missing: [],
      },
      log_summary: { total: 0, info: 0, warn: 0, error: 0 },
      environment: { host, backend: "codex", worktree_path: "/tmp/worktree" },
      backend_session: { id: SESSION_ID, path: sessionPath, backend: "codex" },
      summary: "succeeded",
    },
    integrations: { results: [], all_critical_ok: true },
    recovery: {
      mode: "normal",
      resumable: true,
      checkpoint: {
        backend_session_id: SESSION_ID,
        last_event_at: "2026-07-21T12:05:00.000Z",
        strategy: "native_session",
      },
    },
    summary: "succeeded",
    created_at: "2026-07-21T12:00:00.000Z",
    updated_at: "2026-07-21T12:05:00.000Z",
    completed_at: "2026-07-21T12:05:00.000Z",
  };
}

async function expectNonLeakingMiss(
  attempt: Promise<unknown>,
  submittedId: string,
): Promise<void> {
  const error = await attempt.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(ActivityMarkTargetNotFoundError);
  expect(error).toMatchObject(MARK_TARGET_MISS);
  expect((error as Error).message).not.toContain(submittedId);
}

describe("canonical activity mark target ids", () => {
  test("splits message and turn ids on the final marker, preserving colon-rich activity ids", () => {
    expect(parseActivityMessageId("run:team:issue:123:msg:42")).toEqual({
      activityId: "run:team:issue:123",
      sourceLine: 42,
    });
    expect(parseActivityTurnId("interactive:codex:session:with:colons:turn:7")).toEqual({
      activityId: "interactive:codex:session:with:colons",
      sourceLine: 7,
    });
    expect(() => parseActivityMessageId(`${ACTIVITY_ID}:msg:01`))
      .toThrow(ActivityMessageSelectorError);
    expect(() => parseActivityTurnId(`${ACTIVITY_ID}:turn:0`))
      .toThrow(ActivityTurnSelectorError);
    expect(() => parseActivityMessageId(`${ACTIVITY_ID}:msg:9007199254740992`))
      .toThrow(ActivityMessageSelectorError);
  });
});

describe("RunService.resolveMarkableActivityTarget", () => {
  test("admits exact interactive activity, message, and consumer-derived turn DTO ids", async () => {
    const { service } = await makeFixture();
    const messages = await service.inspectActivityMessages({
      activityId: ACTIVITY_ID,
      consumerVisibleOnly: true,
      selector: { first: 100, summary_only: true },
    });
    const turns = await service.inspectActivityTurns({
      activityId: ACTIVITY_ID,
      consumerVisibleOnly: true,
      selector: { first: 100, summary_only: true },
    });
    const message = messages.messages[0];
    const turn = turns.turns[0];
    expect(message).toBeDefined();
    expect(turn).toBeDefined();

    await expect(service.resolveMarkableActivityTarget({
      targetKind: "activity",
      targetId: ACTIVITY_ID,
    })).resolves.toEqual({
      target_kind: "activity",
      target_id: ACTIVITY_ID,
      activity_id: ACTIVITY_ID,
    });
    await expect(service.resolveMarkableActivityTarget({
      targetKind: "message",
      targetId: message!.id,
    })).resolves.toEqual({
      target_kind: "message",
      target_id: message!.id,
      activity_id: ACTIVITY_ID,
      source_line: message!.source_lines[0],
    });
    await expect(service.resolveMarkableActivityTarget({
      targetKind: "turn",
      targetId: turn!.turn_id,
    })).resolves.toEqual({
      target_kind: "turn",
      target_id: turn!.turn_id,
      activity_id: ACTIVITY_ID,
      source_line: turn!.source_lines[0],
    });
  });

  test("makes hidden and unknown message or turn ids indistinguishable", async () => {
    const { service } = await makeFixture();
    const allMessages = await service.inspectActivityMessages({
      activityId: ACTIVITY_ID,
      selector: { visibility: "all", first: 100, summary_only: true },
    });
    const visibleMessages = await service.inspectActivityMessages({
      activityId: ACTIVITY_ID,
      consumerVisibleOnly: true,
      selector: { first: 100, summary_only: true },
    });
    const visibleIds = new Set(visibleMessages.messages.map((message) => message.id));
    const hiddenId = allMessages.messages.find((message) => !visibleIds.has(message.id))?.id;
    expect(hiddenId).toBeDefined();

    const allTurns = await service.inspectActivityTurns({
      activityId: ACTIVITY_ID,
      selector: { first: 100, summary_only: true },
    });
    const visibleTurns = await service.inspectActivityTurns({
      activityId: ACTIVITY_ID,
      consumerVisibleOnly: true,
      selector: { first: 100, summary_only: true },
    });
    const visibleTurnIds = new Set(visibleTurns.turns.map((turn) => turn.turn_id));
    const hiddenTurnId = allTurns.turns.find((turn) => !visibleTurnIds.has(turn.turn_id))?.turn_id;
    expect(hiddenTurnId).toBeDefined();

    await expectNonLeakingMiss(service.resolveMarkableActivityTarget({
      targetKind: "message",
      targetId: hiddenId!,
    }), hiddenId!);
    await expectNonLeakingMiss(service.resolveMarkableActivityTarget({
      targetKind: "message",
      targetId: `${ACTIVITY_ID}:msg:999`,
    }), `${ACTIVITY_ID}:msg:999`);
    await expectNonLeakingMiss(service.resolveMarkableActivityTarget({
      targetKind: "turn",
      targetId: hiddenTurnId!,
    }), hiddenTurnId!);
    await expectNonLeakingMiss(service.resolveMarkableActivityTarget({
      targetKind: "turn",
      targetId: `${ACTIVITY_ID}:turn:999`,
    }), `${ACTIVITY_ID}:turn:999`);
  });

  test("collapses malformed prefix ambiguity, non-local, and absent targets to the same miss", async () => {
    const { home, service, sessionPath } = await makeFixture();
    const secondSessionId = "019f9000-1111-7222-8333-defdefdefdef";
    const secondPath = join(
      home,
      ".codex",
      "sessions",
      "2026",
      "07",
      "21",
      `rollout-2026-07-21T12-01-00-${secondSessionId}.jsonl`,
    );
    await writeFile(secondPath, `${codexSessionMeta(secondSessionId)}\n`, "utf8");
    await utimes(secondPath, NOW, NOW);

    const localRunId = "team:issue:123";
    const remoteRunId = "remote:issue:123";
    const localRecord = makeRunRecord(localRunId, sessionPath, "blade");
    const remoteRecord = makeRunRecord(remoteRunId, sessionPath, "carbon");
    vi.spyOn(service.store, "readRunRecord").mockImplementation(async (runId) => {
      if (runId === localRunId) return localRecord;
      if (runId === remoteRunId) return remoteRecord;
      return undefined;
    });

    await expect(service.resolveMarkableActivityTarget({
      targetKind: "activity",
      targetId: `run:${localRunId}`,
    })).resolves.toEqual({
      target_kind: "activity",
      target_id: `run:${localRunId}`,
      activity_id: `run:${localRunId}`,
    });

    const misses = [
      { targetKind: "message" as const, targetId: `${ACTIVITY_ID}:msg:01` },
      { targetKind: "turn" as const, targetId: `${ACTIVITY_ID}:turn:0` },
      { targetKind: "activity" as const, targetId: "interactive:codex:019f9000" },
      { targetKind: "activity" as const, targetId: `run:${remoteRunId}` },
      { targetKind: "activity" as const, targetId: "run:not-present" },
      { targetKind: "activity" as const, targetId: "run::bad" },
      { targetKind: "activity" as const, targetId: `run:${"a".repeat(257)}` },
      { targetKind: "activity" as const, targetId: `codex:carbon:${SESSION_ID}` },
    ];
    for (const miss of misses) {
      await expectNonLeakingMiss(
        service.resolveMarkableActivityTarget(miss),
        miss.targetId,
      );
    }
  });

  test("reports exact canonical interactive and run-handle source duplicates as generic ambiguity", async () => {
    const { home, service, sessionPath } = await makeFixture();
    const duplicateDir = join(home, ".codex", "sessions", "2026", "07", "20");
    const duplicatePath = join(
      duplicateDir,
      `rollout-2026-07-20T12-00-00-${SESSION_ID}.jsonl`,
    );
    await mkdir(duplicateDir, { recursive: true });
    await writeFile(duplicatePath, `${codexSessionMeta(SESSION_ID)}\n`, "utf8");
    await utimes(duplicatePath, new Date("2026-07-20T12:30:00.000Z"), new Date("2026-07-20T12:30:00.000Z"));

    const error = await service.resolveMarkableActivityTarget({
      targetKind: "activity",
      targetId: ACTIVITY_ID,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ActivityMarkTargetAmbiguousError);
    expect(error).toMatchObject({
      code: "mark_target_ambiguous",
      message: "More than one local activity source claims the same canonical target identity.",
    });
    expect((error as Error).message).not.toContain(ACTIVITY_ID);
    expect((error as Error).message).not.toContain(duplicatePath);

    const runId = "duplicate-run";
    vi.spyOn(service.store, "readRunRecord").mockImplementation(async (candidate) => (
      candidate === runId ? makeRunRecord(runId, sessionPath, "blade") : undefined
    ));
    const runError = await service.resolveMarkableActivityTarget({
      targetKind: "activity",
      targetId: `run:${runId}`,
    }).catch((reason: unknown) => reason);
    expect(runError).toBeInstanceOf(ActivityMarkTargetAmbiguousError);
    expect(runError).toMatchObject({ code: "mark_target_ambiguous" });
    expect((runError as Error).message).not.toContain(runId);
    expect((runError as Error).message).not.toContain(sessionPath);
  });

  test("classifies projection/source failure as generic unavailable without hiding bugs", async () => {
    const privatePath = "/private/source/session.jsonl";
    const unavailableFixture = await makeFixture({
      beforeDiscoveryRead: async () => {
        throw new Error(`fixture discovery failure at ${privatePath}`);
      },
    });
    const unavailable = await unavailableFixture.service.resolveMarkableActivityTarget({
      targetKind: "activity",
      targetId: ACTIVITY_ID,
    }).catch((reason: unknown) => reason);
    expect(unavailable).toBeInstanceOf(ActivityMarkTargetUnavailableError);
    expect(unavailable).toMatchObject({
      code: "mark_target_unavailable",
      message: "Activity target validation is temporarily unavailable on this daemon.",
    });
    expect((unavailable as Error).message).not.toContain(ACTIVITY_ID);
    expect((unavailable as Error).message).not.toContain(privatePath);

    const durablePrivatePath = "/private/run/session.jsonl";
    const runFixture = await makeFixture({
      beforeCandidateStat: async (candidatePath) => {
        if (candidatePath !== durablePrivatePath) return;
        const error = new Error(`fixture permission failure at ${candidatePath}`) as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
    });
    const runId = "unreadable-run";
    const runRecord = makeRunRecord(runId, durablePrivatePath, "blade");
    runRecord.recovery.checkpoint!.backend_session_path = durablePrivatePath;
    vi.spyOn(runFixture.service.store, "readRunRecord").mockImplementation(async (candidate) => (
      candidate === runId ? runRecord : undefined
    ));
    const durableUnavailable = await runFixture.service.resolveMarkableActivityTarget({
      targetKind: "activity",
      targetId: `run:${runId}`,
    }).catch((reason: unknown) => reason);
    expect(durableUnavailable).toBeInstanceOf(ActivityMarkTargetUnavailableError);
    expect(durableUnavailable).toMatchObject({ code: "mark_target_unavailable" });
    expect((durableUnavailable as Error).message).not.toContain(runId);
    expect((durableUnavailable as Error).message).not.toContain(durablePrivatePath);

    const healthyFixture = await makeFixture();
    const bug = new Error("unexpected projection programmer error");
    vi.spyOn(healthyFixture.service, "inspectActivityMessages").mockRejectedValueOnce(bug);
    const unexpected = await healthyFixture.service.resolveMarkableActivityTarget({
      targetKind: "message",
      targetId: `${ACTIVITY_ID}:msg:4`,
    }).catch((reason: unknown) => reason);
    expect(unexpected).toBe(bug);
  });
});
