import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCalyxAdminClient } from "@polli-labs/calyx-client/admin";
import { createCalyxClient } from "@polli-labs/calyx-client";
import {
  CALYX_DAEMON_FEATURES,
  CALYX_DAEMON_HEALTH_PROTOCOL_EPOCH,
} from "@polli-labs/calyx-core";
import type {
  ActivityAttachmentsResult,
  ActivityEventsResult,
  ActivityMessagesResult,
  ActivityTextResult,
  ActivityTurnsResult,
  InteractiveSessionInspectResult,
  RecordedRunEvent,
  RunActivityEntry,
  RunIntent,
  RunListEntry,
  RunRecord,
} from "@polli-labs/calyx-run-service";
import { buildProgram, type RunCliDependencies } from "../run-cli";
import { openClientRecoveryCustody } from "../client-recovery-custody";

function createAdminClientFactory(fetchImpl: typeof fetch): typeof createCalyxAdminClient {
  return (options) => createCalyxAdminClient({
    ...options,
    fetch: fetchImpl,
  });
}

function createConsumerClientFactory(fetchImpl: typeof fetch): typeof createCalyxClient {
  return (options) => createCalyxClient({
    ...options,
    fetch: fetchImpl,
  });
}

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

function makeHealthPayload(overrides?: Record<string, unknown>) {
  return {
    schema_version: "calyx.admin-health/v1",
    protocol_epoch: CALYX_DAEMON_HEALTH_PROTOCOL_EPOCH,
    daemon_kind: "run-service",
    daemon_id: "run-serve",
    pid: 4242,
    uptime_ms: 10_000,
    started_at: "2026-04-20T00:00:00.000Z",
    build: {
      git_head: "945bcf3abcdef1234567890",
      built_at: "2026-04-18T00:00:00.000Z",
      package_version: "0.2.0",
    },
    env: { inherited_path: "/srv/bin:/usr/bin" },
    active_runs: 0,
    maintenance_mode: false,
    supports_features: [
      CALYX_DAEMON_FEATURES.healthV1,
      CALYX_DAEMON_FEATURES.activityMessagesV1,
      CALYX_DAEMON_FEATURES.activityTurnsV1,
      CALYX_DAEMON_FEATURES.activityTextV1,
      CALYX_DAEMON_FEATURES.activityAttachmentsV1,
      CALYX_DAEMON_FEATURES.activityAttachmentBytesV1,
    ],
    ...overrides,
  };
}

const ACTIVITY_MARK_ID = "mark_123e4567-e89b-42d3-a456-426614174000";
const ACTIVITY_MARK_TARGET_ID = "interactive:codex:session-1:msg:42";
const ACTIVITY_MARK_AT = "2026-07-21T00:00:00.000Z";

function makeActivityMark(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "calyx.activity-mark/v1",
    mark_id: ACTIVITY_MARK_ID,
    marked_by: "operator_cli",
    target_kind: "message",
    target_id: ACTIVITY_MARK_TARGET_ID,
    kind: "high_signal",
    reason: "Decision boundary",
    marked_at: ACTIVITY_MARK_AT,
    created_provenance: {
      schema_version: "calyx.provenance/v1",
      request_id: "req_123e4567-e89b-42d3-a456-426614174000",
      subject: "operator_cli",
      host: "blade",
      via: "http",
      at: ACTIVITY_MARK_AT,
    },
    ...overrides,
  };
}

function makeActivityMarkRevocation(overrides: Record<string, unknown> = {}) {
  return {
    ...makeActivityMark(),
    schema_version: "calyx.activity-mark-revocation/v1",
    revoked_at: "2026-07-21T00:01:00.000Z",
    revoked_provenance: {
      schema_version: "calyx.provenance/v1",
      request_id: "req_123e4567-e89b-42d3-a456-426614174000",
      subject: "operator_cli",
      host: "blade",
      via: "http",
      at: "2026-07-21T00:01:00.000Z",
    },
    ...overrides,
  };
}

function makeMessagesResult(overrides: Partial<ActivityMessagesResult> = {}): ActivityMessagesResult {
  return {
    schema_version: "activity.messages/v1",
    classifier_version: "v1.test",
    activity_id: "interactive:codex:session-1",
    backend: "codex",
    session_id: "session-1",
    session_path: "/tmp/session.jsonl",
    source: "codex_sessions",
    source_state: "complete",
    warnings: [],
    source_receipt: SOURCE_RECEIPT,
    total_events: 3,
    total_messages: 2,
    matched_messages: 1,
    returned_messages: 1,
    truncated: false,
    attachments: EMPTY_ATTACHMENTS,
    selector: { visibility: "default" },
    messages: [{
      id: "interactive:codex:session-1:msg:2",
      activity_id: "interactive:codex:session-1",
      activity: {
        activity_id: "interactive:codex:session-1",
        backend: "codex",
        session_id: "session-1",
        session_path: "/tmp/session.jsonl",
        source: "codex_sessions",
      },
      role: "human",
      visibility: "default",
      summary: "Please inspect Calyx activity.",
      text: "Please inspect Calyx activity.",
      event_refs: [1],
      source_lines: [2],
      classification: {
        classifier_version: "v1.test",
        rule_id: "human/user-message",
        reason: "Raw user-role message that is not classified as harness, tool, or system.",
        source_role: "user",
        source_kind: "message",
      },
    }],
    ...overrides,
  };
}

function makeEventsResult(overrides: Partial<ActivityEventsResult> = {}): ActivityEventsResult {
  return {
    schema_version: "activity.events/v1",
    classifier_version: "v1.test",
    activity_id: "interactive:codex:session-1",
    backend: "codex",
    session_id: "session-1",
    session_path: "/tmp/session.jsonl",
    source: "codex_sessions",
    source_state: "complete",
    warnings: [],
    source_receipt: SOURCE_RECEIPT,
    total_events: 3,
    matched_events: 1,
    returned_events: 1,
    truncated: false,
    selector: {},
    events: [{
      index: 1,
      line: 2,
      timestamp: "2026-04-28T12:00:01.000Z",
      role: "user",
      kind: "message",
      summary: "Please inspect Calyx activity.",
      text: "Please inspect Calyx activity.",
    }],
    ...overrides,
  };
}

function makeTurnsResult(overrides: Partial<ActivityTurnsResult> = {}): ActivityTurnsResult {
  return {
    schema_version: "activity.turns/v1",
    classifier_version: "v1.test",
    activity_id: "interactive:codex:session-1",
    backend: "codex",
    session_id: "session-1",
    session_path: "/tmp/session.jsonl",
    source: "codex_sessions",
    source_state: "complete",
    warnings: [],
    source_receipt: SOURCE_RECEIPT,
    total_events: 4,
    total_messages: 3,
    total_turns: 2,
    matched_turns: 1,
    returned_turns: 1,
    truncated: false,
    selector: { role: "assistant", last: 1, with_tools: true },
    turns: [{
      turn_id: "interactive:codex:session-1:turn:3",
      index: 1,
      activity_id: "interactive:codex:session-1",
      role: "assistant",
      state: "complete",
      started_at: "2026-04-28T12:00:02.000Z",
      ended_at: "2026-04-28T12:00:05.000Z",
      source_lines: [3, 5],
      event_refs: [2, 4],
      total_message_count: 3,
      visible_message_count: 1,
      tool_call_count: 1,
      tool_result_count: 1,
      attachments: EMPTY_ATTACHMENTS,
      summary: "Running shell.",
      first_message_id: "interactive:codex:session-1:msg:3",
      last_message_id: "interactive:codex:session-1:msg:5",
      messages: [],
    }],
    ...overrides,
  };
}

function makeTextResult(overrides: Partial<ActivityTextResult> = {}): ActivityTextResult {
  return {
    schema_version: "activity.text/v1",
    classifier_version: "v1.test",
    activity_id: "interactive:codex:session-1",
    backend: "codex",
    session_id: "session-1",
    session_path: "/tmp/session.jsonl",
    message_id: "interactive:codex:session-1:msg:2",
    source_line: 2,
    text: "selected text",
    text_cursor: {
      total_chars: 100,
      returned: [[10, 23]],
      next: 23,
    },
    source_receipt: SOURCE_RECEIPT,
    ...overrides,
  };
}

function makeAttachmentsResult(overrides: Partial<ActivityAttachmentsResult> = {}): ActivityAttachmentsResult {
  return {
    schema_version: "activity.attachments/v1",
    classifier_version: "v1.test",
    activity_id: "interactive:codex:session-1",
    backend: "codex",
    session_id: "session-1",
    session_path: "/tmp/session.jsonl",
    source_receipt: SOURCE_RECEIPT,
    attachments: [{
      ref: "att:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mime_type: "image/png",
      byte_size: 12,
      source_shape: "codex.input_image.data_url",
      exact_bytes_available: true,
      activity_id: "interactive:codex:session-1",
      message_id: "interactive:codex:session-1:msg:2",
      source_line: 2,
      event_index: 1,
      extracted_path: "/tmp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
    }],
    rollup: {
      images: 1,
      bytes: 12,
      refs: ["att:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    },
    ...overrides,
  };
}

function codexArchiveSessionMeta(sessionId: string): string {
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

function codexArchiveImageMessage(text: string, dataUrl: string): string {
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

async function writeArchiveCodexSession(
  archiveRoot: string,
  host: string,
  sessionId: string,
  lines: string[],
  subtree: "sessions" | "archived_sessions" = "sessions",
): Promise<void> {
  const dir = subtree === "sessions"
    ? join(archiveRoot, host, "codex", subtree, "2026", "04", "28")
    : join(archiveRoot, host, "codex", subtree);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `rollout-2026-04-28T12-00-00-${sessionId}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

function buildActivityDeps(args?: {
  messagesResult?: ActivityMessagesResult;
  eventsResult?: ActivityEventsResult;
  turnsResult?: ActivityTurnsResult;
  textResult?: ActivityTextResult;
  attachmentsResult?: ActivityAttachmentsResult;
  listActivitySpy?: ReturnType<typeof vi.fn>;
  fetchSpy?: ReturnType<typeof vi.fn>;
  inspectMessagesSpy?: ReturnType<typeof vi.fn>;
  inspectEventsSpy?: ReturnType<typeof vi.fn>;
  inspectTurnsSpy?: ReturnType<typeof vi.fn>;
  inspectTextSpy?: ReturnType<typeof vi.fn>;
  inspectAttachmentsSpy?: ReturnType<typeof vi.fn>;
  agentsInfraRoot?: string;
  tokenForHost?: RunCliDependencies["tokenForHost"];
}) {
  const inspectActivityMessagesSpy = args?.inspectMessagesSpy ?? vi.fn(async (): Promise<ActivityMessagesResult> => args?.messagesResult ?? makeMessagesResult());
  const inspectActivityEventsSpy = args?.inspectEventsSpy ?? vi.fn(async (): Promise<ActivityEventsResult> => args?.eventsResult ?? makeEventsResult());
  const inspectActivityTurnsSpy = args?.inspectTurnsSpy ?? vi.fn(async (): Promise<ActivityTurnsResult> => args?.turnsResult ?? makeTurnsResult());
  const inspectActivityTextSpy = args?.inspectTextSpy ?? vi.fn(async (): Promise<ActivityTextResult> => args?.textResult ?? makeTextResult());
  const inspectActivityAttachmentsSpy = args?.inspectAttachmentsSpy ?? vi.fn(async (): Promise<ActivityAttachmentsResult> => args?.attachmentsResult ?? makeAttachmentsResult());

  const deps: RunCliDependencies = {
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
      listActivity: args?.listActivitySpy ?? vi.fn(async (): Promise<RunActivityEntry[]> => []),
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
      inspectActivityMessages: inspectActivityMessagesSpy,
      inspectActivityEvents: inspectActivityEventsSpy,
      inspectActivityTurns: inspectActivityTurnsSpy,
      inspectActivityText: inspectActivityTextSpy,
      inspectActivityAttachments: inspectActivityAttachmentsSpy,
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
    ...(args?.fetchSpy ? {
      createAdminClient: createAdminClientFactory((async (...fetchArgs: Parameters<typeof fetch>) => {
        const [input, init] = fetchArgs;
        const response = await args.fetchSpy!(new URL(String(input)), init);
        if (response && typeof response === "object" && !("headers" in response)) {
          const fixture = response as {
            status: number;
            statusText?: string;
            text(): Promise<string>;
          };
          return new Response(await fixture.text(), {
            status: fixture.status,
            ...(fixture.statusText ? { statusText: fixture.statusText } : {}),
            headers: {
              "content-type": "application/json",
              "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
            },
          });
        }
        if (response instanceof Response) {
          response.headers.set("x-calyx-request-id", "req_123e4567-e89b-42d3-a456-426614174000");
          if (response.status === 401) {
            response.headers.set("www-authenticate", 'Bearer realm="calyx-run"');
          }
        }
        return response as Response;
      }) as typeof fetch),
      createConsumerClient: createConsumerClientFactory((async (...fetchArgs: Parameters<typeof fetch>) => {
        const [input, init] = fetchArgs;
        const response = await args.fetchSpy!(new URL(String(input)), init);
        if (response instanceof Response) {
          response.headers.set("x-calyx-request-id", "req_123e4567-e89b-42d3-a456-426614174000");
          if (response.status === 401) {
            response.headers.set("www-authenticate", 'Bearer realm="calyx-run"');
          }
        }
        return response as Response;
      }) as typeof fetch),
    } : {}),
    ...(args?.agentsInfraRoot ? { agentsInfraRoot: args.agentsInfraRoot } : {}),
    ...(args?.tokenForHost ? { tokenForHost: args.tokenForHost } : {}),
  };
  return {
    deps,
    inspectActivityMessagesSpy,
    inspectActivityEventsSpy,
    inspectActivityTurnsSpy,
    inspectActivityTextSpy,
    inspectActivityAttachmentsSpy,
  };
}

describe("calyx activity command", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  test("activity mark infers the canonical target kind and uses only the generated consumer client", async () => {
    const recoveryRoot = await mkdtemp(join(tmpdir(), "calyx-mark-recovery-"));
    try {
      const requests: Request[] = [];
      const fetchSpy = vi.fn(async (url: URL, init?: RequestInit) => {
        requests.push(new Request(url, init));
        return new Response(JSON.stringify(makeActivityMark({ kind: "foundational" })), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      const activityDeps = buildActivityDeps({ fetchSpy });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const program = buildProgram({
        runCli: {
          ...activityDeps.deps,
          createAdminClient: () => {
            throw new Error("activity marks must not construct the admin client");
          },
          openRecoveryCustody: async () => openClientRecoveryCustody({ root: recoveryRoot }),
        },
      });

      await program.parseAsync([
        "node", "calyx", "activity", "mark", ACTIVITY_MARK_TARGET_ID,
        "--kind", "foundational",
        "--reason", "Decision boundary",
        "--idempotency-key", "mark:POL-1996:message-42",
        "--asserted-actor", "operator:caleb",
        "--server-url", "http://blade:8740/base",
        "--auth-token", "consumer-secret",
        "--json",
      ]);

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe("http://blade:8740/base/v1/marks");
      expect(requests[0]!.method).toBe("POST");
      expect(requests[0]!.headers.get("authorization")).toBe("Bearer consumer-secret");
      expect(requests[0]!.headers.get("x-calyx-asserted-actor")).toBe("operator:caleb");
      expect(await requests[0]!.json()).toEqual({
        schema_version: "calyx.activity-mark-create-request/v1",
        idempotency_key: "mark:POL-1996:message-42",
        target_kind: "message",
        target_id: ACTIVITY_MARK_TARGET_ID,
        kind: "foundational",
        reason: "Decision boundary",
      });
      expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toEqual(makeActivityMark({ kind: "foundational" }));
    } finally {
      await rm(recoveryRoot, { recursive: true, force: true });
    }
  });

  test("activity mark accepts an explicit matching target kind and rejects enum or grammar mismatches before dispatch", async () => {
    const requests: Request[] = [];
    const fetchSpy = vi.fn(async (url: URL, init?: RequestInit) => {
      requests.push(new Request(url, init));
      return new Response(JSON.stringify(makeActivityMark()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const activityDeps = buildActivityDeps({ fetchSpy });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: activityDeps.deps }).parseAsync([
      "node", "calyx", "activity", "mark", ACTIVITY_MARK_TARGET_ID,
      "--kind", "high_signal",
      "--target-kind", "message",
      "--server-url", "http://blade:8740",
      "--auth-token", "consumer-secret",
      "--json",
    ]);

    expect(requests).toHaveLength(1);
    expect(await requests[0]!.json()).toMatchObject({
      target_kind: "message",
      target_id: ACTIVITY_MARK_TARGET_ID,
    });

    await expect(buildProgram({ runCli: activityDeps.deps }).parseAsync([
      "node", "calyx", "activity", "mark", ACTIVITY_MARK_TARGET_ID,
      "--kind", "high_signal",
      "--target-kind", "turn",
      "--server-url", "http://blade:8740",
      "--auth-token", "consumer-secret",
    ])).rejects.toThrow("does not match the target id's exact message grammar");
    await expect(buildProgram({ runCli: activityDeps.deps }).parseAsync([
      "node", "calyx", "activity", "mark", ACTIVITY_MARK_TARGET_ID,
      "--kind", "high_signal",
      "--target-kind", "session",
      "--server-url", "http://blade:8740",
      "--auth-token", "consumer-secret",
    ])).rejects.toThrow("Expected one of: activity, turn, message");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("activity unmark dispatches the generated bodyless request-target DELETE", async () => {
    const requests: Request[] = [];
    const fetchSpy = vi.fn(async (url: URL, init?: RequestInit) => {
      requests.push(new Request(url, init));
      return new Response(JSON.stringify(makeActivityMarkRevocation()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const activityDeps = buildActivityDeps({ fetchSpy });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({
      runCli: {
        ...activityDeps.deps,
        createAdminClient: () => {
          throw new Error("activity marks must not construct the admin client");
        },
      },
    });

    await program.parseAsync([
      "node", "calyx", "activity", "unmark", ACTIVITY_MARK_ID,
      "--asserted-actor", "interactive:codex:session-1",
      "--server-url", "http://blade:8740",
      "--auth-token", "consumer-secret",
      "--json",
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`http://blade:8740/v1/marks/${ACTIVITY_MARK_ID}`);
    expect(requests[0]!.method).toBe("DELETE");
    expect(requests[0]!.headers.has("content-type")).toBe(false);
    expect(requests[0]!.headers.get("x-calyx-asserted-actor")).toBe("interactive:codex:session-1");
    expect(await requests[0]!.text()).toBe("");
    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toEqual(makeActivityMarkRevocation());
  });

  test("activity marks preserves independent filters and generated DTO output", async () => {
    const seenUrls: URL[] = [];
    const fetchSpy = vi.fn(async (url: URL) => {
      seenUrls.push(url);
      return new Response(JSON.stringify({
        schema_version: "calyx.activity-mark-list/v1",
        snapshot_at: "2026-07-21T00:02:00.000Z",
        marks: [makeActivityMark()],
        truncated: false,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const targetOnly = buildActivityDeps({ fetchSpy });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    await buildProgram({ runCli: targetOnly.deps }).parseAsync([
      "node", "calyx", "activity", "marks",
      "--target-id", ACTIVITY_MARK_TARGET_ID,
      "--kind", "high_signal",
      "--since", "2026-07-21T00:00:00.000Z",
      "--limit", "25",
      "--cursor", "opaque-cursor",
      "--server-url", "http://blade:8740",
      "--auth-token", "consumer-secret",
      "--json",
    ]);
    const targetOnlyUrl = seenUrls[0]!;
    expect(targetOnlyUrl.pathname).toBe("/v1/marks");
    expect(Object.fromEntries(targetOnlyUrl.searchParams)).toEqual({
      cursor: "opaque-cursor",
      kind: "high_signal",
      limit: "25",
      since: "2026-07-21T00:00:00.000Z",
      target_id: ACTIVITY_MARK_TARGET_ID,
    });
    expect(targetOnlyUrl.searchParams.has("target_kind")).toBe(false);
    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
      schema_version: "calyx.activity-mark-list/v1",
      marks: [{ mark_id: ACTIVITY_MARK_ID }],
      truncated: false,
    });

    const kindOnly = buildActivityDeps({ fetchSpy });
    await buildProgram({ runCli: kindOnly.deps }).parseAsync([
      "node", "calyx", "activity", "marks",
      "--target-kind", "turn",
      "--server-url", "http://blade:8740",
      "--auth-token", "consumer-secret",
      "--json",
    ]);
    expect(Object.fromEntries(seenUrls[1]!.searchParams)).toEqual({ target_kind: "turn" });
    expect(seenUrls[1]!.searchParams.has("target_id")).toBe(false);
  });

  test("activity marks prints a copyable filtered continuation with the selected host", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      schema_version: "calyx.activity-mark-list/v1",
      snapshot_at: "2026-07-21T00:02:00.000Z",
      marks: [makeActivityMark()],
      truncated: true,
      next_cursor: "opaque-next-cursor",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const activityDeps = buildActivityDeps({ fetchSpy });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await buildProgram({ runCli: activityDeps.deps }).parseAsync([
      "node", "calyx", "activity", "marks",
      "--kind", "high_signal",
      "--target-kind", "message",
      "--target-id", ACTIVITY_MARK_TARGET_ID,
      "--since", "2026-07-21T00:00:00.000Z",
      "--limit", "25",
      "--host", "blade",
      "--server-url", "http://blade:8740",
      "--auth-token", "consumer-secret",
    ]);

    expect(error).toHaveBeenLastCalledWith(
      `next: calyx activity marks --kind high_signal --target-kind message --target-id ${ACTIVITY_MARK_TARGET_ID} --since 2026-07-21T00:00:00.000Z --limit 25 --cursor opaque-next-cursor --host blade --json`,
    );
  });

  test.each([
    ["stale cursor invalid request", ["activity", "marks", "--cursor", "stale-cursor"], 400, "invalid_request", 2],
    ["unknown mark target", [
      "activity", "mark", ACTIVITY_MARK_TARGET_ID,
      "--kind", "high_signal",
      "--idempotency-key", "unknown-target-exit-map",
    ], 404, "mark_target_unknown", 3],
    ["unknown mark", ["activity", "unmark", ACTIVITY_MARK_ID], 404, "mark_unknown", 3],
    ["unavailable store", ["activity", "marks"], 503, "activity_marks_schema_unavailable", 6],
    ["unauthorized", ["activity", "marks"], 401, "unauthorized", 8],
    ["profile forbidden", ["activity", "marks"], 403, "profile_forbidden", 8],
    ["owner forbidden", ["activity", "unmark", ACTIVITY_MARK_ID], 403, "mark_owner_forbidden", 8],
    ["internal error", ["activity", "marks"], 500, "internal_error", 10],
  ])("maps marks-only API failure for %s", async (_name, command, status, code, exitCode) => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      error: {
        schema_version: "calyx.error/v1",
        code,
        message: `${code} fixture`,
      },
    }), {
      status,
      headers: { "content-type": "application/json" },
    }));
    const activityDeps = buildActivityDeps({ fetchSpy });
    const recoveryRoot = await mkdtemp(join(tmpdir(), "calyx-mark-exit-map-"));
    try {
      await expect(buildProgram({
        runCli: {
          ...activityDeps.deps,
          openRecoveryCustody: async () => openClientRecoveryCustody({ root: recoveryRoot }),
        },
      }).parseAsync([
        "node", "calyx", ...command,
        "--server-url", "http://blade:8740",
        "--auth-token", "consumer-secret",
        "--json",
      ])).rejects.toMatchObject({ exitCode });
    } finally {
      await rm(recoveryRoot, { recursive: true, force: true });
    }
  });

  test("activity marks resolves authenticated localhost and rejects malformed input before dispatch", async () => {
    const seenUrls: URL[] = [];
    const fetchSpy = vi.fn(async (url: URL) => {
      seenUrls.push(url);
      return new Response(JSON.stringify({
        schema_version: "calyx.activity-mark-list/v1",
        snapshot_at: "2026-07-21T00:02:00.000Z",
        marks: [],
        truncated: false,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const activityDeps = buildActivityDeps({ fetchSpy });
    const program = buildProgram({ runCli: activityDeps.deps });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync([
      "node", "calyx", "activity", "marks",
      "--auth-token", "consumer-secret",
      "--json",
    ]);
    expect(seenUrls[0]?.toString()).toBe("http://127.0.0.1:8740/v1/marks");
    await expect(program.parseAsync([
      "node", "calyx", "activity", "marks", "--json",
    ])).rejects.toThrow("Activity marks require --auth-token");
    await expect(program.parseAsync([
      "node", "calyx", "activity", "mark", "interactive:codex:session-1:msg:0",
      "--kind", "high_signal",
      "--server-url", "http://blade:8740",
      "--auth-token", "consumer-secret",
      "--json",
    ])).rejects.toThrow("Invalid activity mark target");
    await expect(program.parseAsync([
      "node", "calyx", "activity", "mark", ACTIVITY_MARK_TARGET_ID,
      "--kind", "high_signal",
      "--asserted-actor", "free prose",
      "--server-url", "http://blade:8740",
      "--auth-token", "consumer-secret",
      "--json",
    ])).rejects.toThrow("Invalid --asserted-actor value");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test.each([
    {
      name: "wrong JSON schema",
      body: JSON.stringify({ schema_version: "activity.attachments/v1" }),
      contentType: "application/json",
    },
    {
      name: "wrong media type",
      body: JSON.stringify(makeAttachmentsResult()),
      contentType: "text/plain",
    },
  ])("generated attachment transport rejects $name", async ({ body, contentType }) => {
    const client = createAdminClientFactory(vi.fn(async () => new Response(body, {
      status: 200,
      headers: {
        "content-type": contentType,
        "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
      },
    })))({
      baseUrl: "http://mba:8740",
      bearerToken: "secret",
    });

    await expect(client.admin.activity.attachments({
      path: { activityId: "interactive:codex:session-1" },
    })).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: contentType === "application/json" ? "invalid_response" : "unexpected_media_type",
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    delete process.env["CODEX_THREAD_ID"];
    delete process.env["CODEX_SESSION_ID"];
    delete process.env["CLAUDE_CODE_SESSION_ID"];
    delete process.env["CALYX_AGENT_SESSION_ARCHIVE_RAW_ROOT"];
    vi.restoreAllMocks();
  });

  test("activity command is a top-level domain command", () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("activity");
    const activity = program.commands.find((c) => c.name() === "activity")!;
    expect(activity.commands.map((c) => c.name()).sort()).toEqual([
      "attachments",
      "events",
      "export",
      "list",
      "mark",
      "marks",
      "messages",
      "overview",
      "self",
      "show",
      "text",
      "turns",
      "unmark",
    ]);
  });

  test("activity overview defaults to recent Claude sessions and compact latest-turn JSON", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T12:10:00.000Z"));
    try {
      const listActivitySpy = vi.fn(async (): Promise<RunActivityEntry[]> => [{
        entry_kind: "interactive_session",
        run_id: "interactive:claude:claude-1",
        state: "interactive",
        summary: "Claude session claude-1",
        created_at: "2026-04-28T11:00:00.000Z",
        updated_at: "2026-04-28T12:05:00.000Z",
        host: "carbon",
        backend: "claude",
        session_id: "claude-1",
        session_path: "/tmp/claude-1.jsonl",
        cwd: "/Users/carbon",
        source: "claude_projects",
        bytes: 4096,
      }]);
      const overviewMessages: ActivityTurnsResult["turns"][number]["messages"] = [1, 2, 3, 4, 5].map((index) => ({
        id: `interactive:claude:claude-1:msg:${index}`,
        activity_id: "interactive:claude:claude-1",
        activity: {
          activity_id: "interactive:claude:claude-1",
          backend: "claude",
          session_id: "claude-1",
          session_path: "/tmp/claude-1.jsonl",
          source: "claude_projects",
        },
        turn_id: "interactive:claude:claude-1:turn:8",
        role: "assistant",
        visibility: "default",
        summary: `Latest assistant handoff summary ${index}`,
        text: `Latest assistant handoff summary ${index} with enough detail for a birds-eye scan.`,
        timestamp: `2026-04-28T12:05:0${index}.000Z`,
        event_refs: [index],
        source_lines: [index],
        classification: {
          classifier_version: "v1.test",
          rule_id: "assistant/message",
          reason: "Raw assistant-role message.",
          source_role: "assistant",
          source_kind: "assistant",
        },
      }));
      const inspectTurnsSpy = vi.fn(async (): Promise<ActivityTurnsResult> => makeTurnsResult({
        activity_id: "interactive:claude:claude-1",
        backend: "claude",
        session_id: "claude-1",
        session_path: "/tmp/claude-1.jsonl",
        source: "claude_projects",
        turns: [{
          ...makeTurnsResult().turns[0]!,
          turn_id: "interactive:claude:claude-1:turn:8",
          activity_id: "interactive:claude:claude-1",
          role: "assistant",
          state: "complete",
          started_at: "2026-04-28T12:04:00.000Z",
          ended_at: "2026-04-28T12:05:00.000Z",
          total_message_count: overviewMessages.length,
          visible_message_count: overviewMessages.length,
          summary: "Latest assistant handoff summary",
          messages: overviewMessages,
        }],
      }));
      const { deps } = buildActivityDeps({ listActivitySpy, inspectTurnsSpy });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const program = buildProgram({ runCli: deps });

      await program.parseAsync(["node", "calyx", "activity", "overview", "--json"]);

      expect(listActivitySpy).toHaveBeenCalledWith(expect.objectContaining({
        includeInteractive: true,
        agentKind: "claude",
        sinceMs: 43_200_000,
        limit: 20,
      }));
      expect(inspectTurnsSpy).toHaveBeenCalledWith(expect.objectContaining({
        activityId: "interactive:claude:claude-1",
        selector: {
          role: "all",
          last: 1,
          max_text_chars: 240,
        },
      }));
      const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        schema_version: string;
        filters: {
          agent_kind: string;
          since_hours: number;
          turn_role: string;
          max_messages: number;
        };
        rows: Array<{
          backend: string;
          updated_age_seconds: number;
          turn?: {
            role: string;
            age_seconds: number;
            returned_message_count: number;
            omitted_message_count: number;
            messages: Array<{ role: string; age_seconds: number; text: string }>;
          };
        }>;
      };
      expect(payload.schema_version).toBe("activity.overview/v1");
      expect(payload.filters).toMatchObject({
        agent_kind: "claude",
        since_hours: 12,
        turn_role: "all",
        max_messages: 4,
      });
      expect(payload.rows[0]).toMatchObject({
        backend: "claude",
        updated_age_seconds: 300,
        turn: {
          role: "assistant",
          age_seconds: 300,
          returned_message_count: 4,
          omitted_message_count: 1,
        },
      });
      expect(payload.rows[0]?.turn?.messages[0]).toMatchObject({
        role: "assistant",
        age_seconds: 298,
        text: "Latest assistant handoff summary 2 with enough detail for a birds-eye scan.",
      });
      expect(payload.rows[0]?.turn?.messages.map((message) => message.text)).toEqual([
        "Latest assistant handoff summary 2 with enough detail for a birds-eye scan.",
        "Latest assistant handoff summary 3 with enough detail for a birds-eye scan.",
        "Latest assistant handoff summary 4 with enough detail for a birds-eye scan.",
        "Latest assistant handoff summary 5 with enough detail for a birds-eye scan.",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("activity overview surfaces the session without a turn preview when the latest matching turn is older than --since-hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T12:10:00.000Z"));
    try {
      const listActivitySpy = vi.fn(async (): Promise<RunActivityEntry[]> => [{
        entry_kind: "interactive_session",
        run_id: "interactive:claude:claude-1",
        state: "interactive",
        summary: "Claude session claude-1",
        created_at: "2026-04-27T19:00:00.000Z",
        updated_at: "2026-04-28T12:05:00.000Z",
        host: "carbon",
        backend: "claude",
        session_id: "claude-1",
        session_path: "/tmp/claude-1.jsonl",
        cwd: "/Users/carbon",
        source: "claude_projects",
        bytes: 4096,
      }]);
      const inspectTurnsSpy = vi.fn(async (): Promise<ActivityTurnsResult> => makeTurnsResult({
        activity_id: "interactive:claude:claude-1",
        backend: "claude",
        session_id: "claude-1",
        session_path: "/tmp/claude-1.jsonl",
        source: "claude_projects",
        turns: [{
          ...makeTurnsResult().turns[0]!,
          turn_id: "interactive:claude:claude-1:turn:2",
          activity_id: "interactive:claude:claude-1",
          role: "assistant",
          state: "complete",
          started_at: "2026-04-27T19:59:00.000Z",
          ended_at: "2026-04-27T20:00:00.000Z",
          messages: [],
        }],
      }));
      const { deps } = buildActivityDeps({ listActivitySpy, inspectTurnsSpy });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const program = buildProgram({ runCli: deps });

      await program.parseAsync(["node", "calyx", "activity", "overview", "--json"]);

      const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        scanned_activities: number;
        returned_activities: number;
        skipped_activities: number;
        warnings: Array<{ code: string; activity_id?: string }>;
        rows: Array<{ activity_id: string; turn?: unknown }>;
      };
      expect(payload.scanned_activities).toBe(1);
      expect(payload.returned_activities).toBe(1);
      expect(payload.skipped_activities).toBe(1);
      expect(payload.rows).toHaveLength(1);
      expect(payload.rows[0]?.activity_id).toBe("interactive:claude:claude-1");
      expect(payload.rows[0]?.turn).toBeUndefined();
      expect(payload.warnings).toContainEqual(expect.objectContaining({
        code: "turn_outside_window",
        activity_id: "interactive:claude:claude-1",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  test("activity self resolves the current Codex thread to an indexed activity id", async () => {
    process.env["CODEX_THREAD_ID"] = "session-1";
    const listActivitySpy = vi.fn(async (): Promise<RunActivityEntry[]> => [{
      entry_kind: "interactive_session",
      run_id: "interactive:codex:session-1",
      state: "interactive",
      summary: "Codex session session-1",
      created_at: "2026-04-28T12:00:00.000Z",
      updated_at: "2026-04-28T12:05:00.000Z",
      host: "carbon",
      backend: "codex",
      session_id: "session-1",
      session_path: "/tmp/session.jsonl",
      cwd: "/Users/carbon/dev/calyx/dev",
      source: "codex_sessions",
      bytes: 1200,
    }]);
    const { deps } = buildActivityDeps({ listActivitySpy });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync(["node", "calyx", "activity", "self", "--json"]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      activity_id: string;
      backend: string;
      session_id: string;
      resolution_source: string;
      indexed: boolean;
      session_path?: string;
      cwd?: string;
      warnings: Array<{ code: string; message: string }>;
    };
    expect(payload).toMatchObject({
      schema_version: "activity.self/v1",
      activity_id: "interactive:codex:session-1",
      backend: "codex",
      session_id: "session-1",
      resolution_source: "env:CODEX_THREAD_ID",
      indexed: true,
      session_path: "/tmp/session.jsonl",
      cwd: "/Users/carbon/dev/calyx/dev",
      warnings: [],
    });
    expect(listActivitySpy).toHaveBeenCalledWith(expect.objectContaining({
      includeInteractive: true,
      agentKind: "codex",
    }));
  });

  test("activity messages --role user is rejected with the corrective error", async () => {
    const { deps } = buildActivityDeps();
    const program = buildProgram({ runCli: deps });
    await expect(
      program.parseAsync(["node", "calyx", "activity", "messages", "interactive:codex:s", "--role", "user", "--first", "1"]),
    ).rejects.toThrow(/ambiguous role `user`/);
  });

  test("activity messages --first and --last together are rejected before service call", async () => {
    const { deps, inspectActivityMessagesSpy } = buildActivityDeps();
    const program = buildProgram({ runCli: deps });
    await expect(
      program.parseAsync(["node", "calyx", "activity", "messages", "interactive:codex:s", "--first", "1", "--last", "1"]),
    ).rejects.toThrow(/--first and --last are mutually exclusive/);
    expect(inspectActivityMessagesSpy).not.toHaveBeenCalled();
  });

  test("activity messages --around-id and --around-text together are rejected", async () => {
    const { deps, inspectActivityMessagesSpy } = buildActivityDeps();
    const program = buildProgram({ runCli: deps });
    await expect(
      program.parseAsync([
        "node", "calyx", "activity", "messages", "interactive:codex:s",
        "--around-id", "x:msg:1",
        "--around-text", "anything",
      ]),
    ).rejects.toThrow(/--around-id and --around-text are mutually exclusive/);
    expect(inspectActivityMessagesSpy).not.toHaveBeenCalled();
  });

  test.each([
    ["messages"],
    ["events"],
    ["turns"],
    ["attachments"],
  ])("activity %s rejects a composite host-in-id locator with exit 2 before dispatch (POL-1825)", async (subcommand) => {
    const {
      deps,
      inspectActivityMessagesSpy,
      inspectActivityEventsSpy,
      inspectActivityTurnsSpy,
      inspectActivityAttachmentsSpy,
    } = buildActivityDeps();
    const program = buildProgram({ runCli: deps });

    const thrown = await program.parseAsync([
      "node", "calyx", "activity", subcommand,
      "interactive:blade:codex:019f869d-d664-7870-a1ee-6bc3d66626c3",
      "--json",
    ]).then(() => undefined, (error: unknown) => error as Error & { exitCode?: number });

    // Exit 2 (invalid argument), never exit 3 (not found): the id is a syntax error.
    expect(thrown?.exitCode).toBe(2);
    expect(thrown?.message).toContain("is malformed");
    expect(thrown?.message).not.toContain("not found");
    expect(thrown?.message).toContain(
      "Use: interactive:codex:019f869d-d664-7870-a1ee-6bc3d66626c3 --host blade",
    );
    expect(thrown?.message).toContain("interactive:<backend>:<session-id>");
    // No daemon round trip and no credentials are needed to learn this.
    expect(inspectActivityMessagesSpy).not.toHaveBeenCalled();
    expect(inspectActivityEventsSpy).not.toHaveBeenCalled();
    expect(inspectActivityTurnsSpy).not.toHaveBeenCalled();
    expect(inspectActivityAttachmentsSpy).not.toHaveBeenCalled();
  });

  test("a remote --host does not change the grammar verdict or its exit code (POL-1825)", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const { deps, inspectActivityTurnsSpy } = buildActivityDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });

    const thrown = await program.parseAsync([
      "node", "calyx", "activity", "turns",
      "interactive:blade:codex:019f869d-d664-7870-a1ee-6bc3d66626c3",
      "--host", "carbon",
      "--json",
    ]).then(() => undefined, (error: unknown) => error as Error & { exitCode?: number });

    expect(thrown?.exitCode).toBe(2);
    expect(thrown?.message).toContain("is malformed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(inspectActivityTurnsSpy).not.toHaveBeenCalled();
  });

  test("activity turns accepts a short run: handle and forwards it unchanged (POL-1825)", async () => {
    const { deps, inspectActivityTurnsSpy } = buildActivityDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync(["node", "calyx", "activity", "turns", "run:c09d295c", "--json"]);

    expect(inspectActivityTurnsSpy).toHaveBeenCalledTimes(1);
    const callArg = inspectActivityTurnsSpy.mock.calls[0]?.[0] as { activityId: string };
    expect(callArg.activityId).toBe("run:c09d295c");
  });

  test("activity messages run:<id> dispatches locally and prints run resolution metadata", async () => {
    const runId = "abc-123";
    const { deps, inspectActivityMessagesSpy } = buildActivityDeps({
      messagesResult: makeMessagesResult({ run_id: runId }),
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });
    await program.parseAsync(["node", "calyx", "activity", "messages", `run:${runId}`, "--first", "1", "--json"]);
    expect(inspectActivityMessagesSpy).toHaveBeenCalledTimes(1);
    const callArg = inspectActivityMessagesSpy.mock.calls[0]?.[0] as { activityId: string };
    expect(callArg.activityId).toBe(`run:${runId}`);
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as ActivityMessagesResult;
    expect(payload.run_id).toBe(runId);
    expect(payload.activity_id).toBe("interactive:codex:session-1");
  });

  test("activity messages with --latest-session requires --backend", async () => {
    const { deps } = buildActivityDeps();
    const program = buildProgram({ runCli: deps });
    await expect(
      program.parseAsync(["node", "calyx", "activity", "messages", "--latest-session", "--first", "1"]),
    ).rejects.toThrow(/--latest-session requires --backend/);
  });

  test("activity messages dispatches locally with selector and prints JSON", async () => {
    const { deps, inspectActivityMessagesSpy } = buildActivityDeps();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node", "calyx", "activity", "messages", "interactive:codex:session-1",
      "--role", "human",
      "--first", "1",
      "--visibility", "+detail",
      "--explain-classification",
      "--max-text-chars", "200",
      "--json",
    ]);

    expect(inspectActivityMessagesSpy).toHaveBeenCalledTimes(1);
    const callArg = inspectActivityMessagesSpy.mock.calls[0]?.[0] as { activityId: string; selector: Record<string, unknown> };
    expect(callArg.activityId).toBe("interactive:codex:session-1");
    expect(callArg.selector).toMatchObject({
      role: "human",
      first: 1,
      visibility: "+detail",
      explain_classification: true,
      max_text_chars: 200,
    });
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as ActivityMessagesResult;
    expect(payload.messages[0]?.role).toBe("human");
  });

  test("activity messages remote query is gated on activity.messages/v1 and built /v1/admin/activity URL", async () => {
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return {
          ok: true,
          text: async () => JSON.stringify(makeHealthPayload()),
          status: 200,
          statusText: "OK",
        };
      }
      expect(String(url)).toBe(
        "http://mba:8740/v1/admin/activity/interactive%3Acodex%3Asession-1/messages?last=1&role=assistant&visibility=default",
      );
      return {
        ok: true,
        text: async () => JSON.stringify(makeMessagesResult({
          messages: [{
            id: "interactive:codex:session-1:msg:5",
            activity_id: "interactive:codex:session-1",
            activity: {
              activity_id: "interactive:codex:session-1",
              backend: "codex",
              session_id: "session-1",
              session_path: "/tmp/session.jsonl",
              source: "codex_sessions",
            },
            role: "assistant",
            visibility: "default",
            summary: "Latest assistant reply.",
            text: "Latest assistant reply.",
            event_refs: [4],
            source_lines: [5],
            classification: {
              classifier_version: "v1.test",
              rule_id: "assistant/message",
              reason: "Raw assistant-role message.",
              source_role: "assistant",
              source_kind: "message",
            },
          }],
          matched_messages: 1,
          returned_messages: 1,
        })),
        status: 200,
        statusText: "OK",
      };
    });
    const { deps } = buildActivityDeps({ fetchSpy });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node", "calyx", "activity", "messages", "interactive:codex:session-1",
      "--host", "mba",
      "--server-url", "http://mba:8740",
      "--auth-token", "secret",
      "--role", "assistant",
      "--last", "1",
      "--visibility", "default",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as ActivityMessagesResult;
    expect(payload.messages[0]?.role).toBe("assistant");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("activity remote auth miss points agents to with-polli-secrets", async () => {
    const expectedMessage = [
      "Remote activity queries require --auth-token or the target host's operator_cli outbound credential.",
      "Try: with-polli-secrets calyx activity ...",
      "Managed wrapper path: ${XDG_CONFIG_HOME:-$HOME/.config}/polli/bin/with-polli-secrets calyx activity ...",
    ].join("\n");
    const remote = ["--host", "example-remote-no-token", "--server-url", "http://example-remote-no-token:8740"];
    const cases = [
      ["messages", "interactive:codex:s", ...remote, "--role", "assistant", "--last", "1"],
      ["events", "interactive:codex:s", ...remote, "--tail", "1"],
      ["turns", "interactive:codex:s", ...remote, "--role", "assistant", "--last", "1"],
      ["text", "interactive:codex:s:msg:2", ...remote, "--from", "0"],
      [
        "attachments", "interactive:codex:s", ...remote,
        "--ref", "att:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ],
    ];
    for (const args of cases) {
      const fetchSpy = vi.fn(async () => {
        throw new Error("remote activity should fail before querying daemon without auth");
      });
      const { deps } = buildActivityDeps({ fetchSpy });
      const program = buildProgram({ runCli: deps });
      await expect(program.parseAsync(["node", "calyx", "activity", ...args])).rejects.toThrow(expectedMessage);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  test("activity attachments never resolve a named-host token for an origin-rebound URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-activity-authority-"));
    const agentsInfraRoot = join(root, "agents-infra");
    await mkdir(join(agentsInfraRoot, "fleet", "truths"), { recursive: true });
    await writeFile(
      join(agentsInfraRoot, "fleet", "truths", "hosts.yaml"),
      "hosts:\n  mba:\n    run_serve_url: https://mba.internal:8740\n",
      "utf8",
    );
    const tokenForHost = vi.fn(() => "ambient-operator-token");
    const fetchSpy = vi.fn();
    const { deps } = buildActivityDeps({ agentsInfraRoot, fetchSpy, tokenForHost });
    const program = buildProgram({ runCli: deps });
    try {
      await expect(program.parseAsync([
        "node", "calyx", "activity", "attachments", "interactive:codex:session-1",
        "--host", "mba",
        "--server-url", "https://attacker.example:8740",
        "--json",
      ])).rejects.toThrow(/require --auth-token/);
      expect(tokenForHost).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("activity messages remote refuses when daemon lacks activity.messages/v1", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T00:00:00.000Z"));
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return {
          ok: true,
          text: async () => JSON.stringify(makeHealthPayload({
            supports_features: [CALYX_DAEMON_FEATURES.healthV1],
          })),
          status: 200,
          statusText: "OK",
        };
      }
      throw new Error("activity messages should not query /v1/admin/activity when the health guard fails");
    });
    const { deps } = buildActivityDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });
    try {
      await expect(program.parseAsync([
        "node", "calyx", "activity", "messages", "interactive:codex:s",
        "--host", "mba",
        "--server-url", "http://mba:8740",
        "--auth-token", "secret",
        "--role", "human",
        "--first", "1",
      ])).rejects.toThrow(/activity\.messages\/v1/);
    } finally {
      vi.useRealTimers();
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("activity text dispatches locally with range and classifier validation", async () => {
    const { deps, inspectActivityTextSpy } = buildActivityDeps();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node", "calyx", "activity", "text", "interactive:codex:session-1:msg:2",
      "--range", "10:23",
      "--classifier-version", "v1.test",
      "--json",
    ]);

    expect(inspectActivityTextSpy).toHaveBeenCalledTimes(1);
    expect(inspectActivityTextSpy.mock.calls[0]?.[0]).toMatchObject({
      messageId: "interactive:codex:session-1:msg:2",
      selector: { range: "10:23", classifier_version: "v1.test" },
    });
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as ActivityTextResult;
    expect(payload.schema_version).toBe("activity.text/v1");
  });

  test("activity text remote query is gated on activity.text/v1 and builds /v1/admin/activity-text URL", async () => {
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return {
          ok: true,
          text: async () => JSON.stringify(makeHealthPayload()),
          status: 200,
          statusText: "OK",
        };
      }
      expect(String(url)).toBe(
        "http://mba:8740/v1/admin/activity-text/interactive%3Acodex%3Asession-1%3Amsg%3A2?classifier_version=v1.test&range=10%3A23",
      );
      return {
        ok: true,
        text: async () => JSON.stringify(makeTextResult()),
        status: 200,
        statusText: "OK",
      };
    });
    const { deps } = buildActivityDeps({ fetchSpy });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node", "calyx", "activity", "text", "interactive:codex:session-1:msg:2",
      "--host", "mba",
      "--server-url", "http://mba:8740",
      "--auth-token", "secret",
      "--range", "10:23",
      "--classifier-version", "v1.test",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as ActivityTextResult;
    expect(payload.text).toBe("selected text");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("activity attachments dispatches locally with filters and extraction", async () => {
    const { deps, inspectActivityAttachmentsSpy } = buildActivityDeps();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node", "calyx", "activity", "attachments", "interactive:codex:session-1",
      "--turn", "2",
      "--message", "interactive:codex:session-1:msg:2",
      "--ref", "att:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "--extract",
      "--out", "/tmp/calyx-attachments",
      "--json",
    ]);

    expect(inspectActivityAttachmentsSpy).toHaveBeenCalledTimes(1);
    expect(inspectActivityAttachmentsSpy.mock.calls[0]?.[0]).toMatchObject({
      activityId: "interactive:codex:session-1",
      selector: {
        turn: 2,
        message_id: "interactive:codex:session-1:msg:2",
        ref: "att:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        extract: true,
        out_dir: "/tmp/calyx-attachments",
      },
    });
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as ActivityAttachmentsResult;
    expect(payload.schema_version).toBe("activity.attachments/v1");
  });

  test("activity attachments remote extract pulls bytes into the local verified cache", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "calyx-activity-attachments-"));
    try {
      const bytes = Buffer.from("remote image bytes");
      const digest = createHash("sha256").update(bytes).digest("hex");
      const ref = `att:sha256:${digest}`;
      const { extracted_path: _remotePath, ...baseAttachment } = makeAttachmentsResult().attachments[0]!;
      void _remotePath;
      const inventory = makeAttachmentsResult({
        attachments: [{
          ...baseAttachment,
          ref,
          sha256: digest,
          byte_size: bytes.length,
        }],
        rollup: {
          images: 1,
          bytes: bytes.length,
          refs: [ref],
        },
      });
      const record = {
        schema_version: "activity.attachment-record/v1",
        classifier_version: "v1.test",
        ...inventory.attachments[0]!,
        source_tier: "origin-daemon",
        origin_host: "mba",
        served_by_host: "mba",
        source_locator: "codex://threads/session-1",
        source_receipt: SOURCE_RECEIPT,
      };
      let bytesTransfers = 0;
      const fetchSpy = vi.fn(async (url: URL) => {
        if (url.pathname === "/v1/admin/health") {
          return {
            ok: true,
            text: async () => JSON.stringify(makeHealthPayload()),
            status: 200,
            statusText: "OK",
          };
        }
        if (url.pathname === "/v1/admin/activity/interactive%3Acodex%3Asession-1/attachments") {
          expect(url.searchParams.get("message")).toBe("interactive:codex:session-1:msg:2");
          expect(url.searchParams.has("extract")).toBe(false);
          return {
            ok: true,
            text: async () => JSON.stringify(inventory),
            status: 200,
            statusText: "OK",
          };
        }
        if (url.pathname === `/v1/admin/activity/interactive%3Acodex%3Asession-1/attachments/${encodeURIComponent(ref)}`) {
          return {
            ok: true,
            text: async () => JSON.stringify(record),
            status: 200,
            statusText: "OK",
          };
        }
        if (url.pathname === `/v1/admin/activity/interactive%3Acodex%3Asession-1/attachments/${encodeURIComponent(ref)}/bytes`) {
          bytesTransfers += 1;
          return new Response(bytes, {
            status: 200,
            headers: {
              "content-type": "image/png",
              "content-length": String(bytes.length),
              digest: `sha-256=${Buffer.from(digest, "hex").toString("base64")}`,
              etag: `"sha256:${digest}"`,
              "x-calyx-attachment-ref": ref,
              "x-calyx-source-tier": "origin-daemon",
              "x-calyx-origin-host": "mba",
              "x-calyx-served-by-host": "mba",
            },
          });
        }
        throw new Error(`unexpected URL ${String(url)}`);
      });
      const { deps } = buildActivityDeps({ fetchSpy });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const program = buildProgram({ runCli: deps });

      const args = [
        "node", "calyx", "activity", "attachments", "interactive:codex:session-1",
        "--host", "mba",
        "--server-url", "http://mba:8740",
        "--auth-token", "secret",
        "--message", "interactive:codex:session-1:msg:2",
        "--extract",
        "--out", outDir,
        "--json",
      ];
      await program.parseAsync(args);

      const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as ActivityAttachmentsResult;
      expect(payload.attachments[0]?.extracted_path).toMatch(
        new RegExp(`${digest}\\.[0-9a-f]{64}\\.png$`),
      );
      expect(payload.attachments[0]?.cache_status).toBe("written");
      expect(await readFile(payload.attachments[0]!.extracted_path!, "utf8")).toBe("remote image bytes");
      expect(bytesTransfers).toBe(1);

      await program.parseAsync(args);
      const cachedPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as ActivityAttachmentsResult;
      expect(cachedPayload.attachments[0]?.cache_status).toBe("hit");
      expect(bytesTransfers).toBe(1);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("activity attachments remote extract preserves metadata-only records without byte fetch", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "calyx-activity-attachments-"));
    try {
      const { extracted_path: _remotePath, ...baseAttachment } = makeAttachmentsResult().attachments[0]!;
      void _remotePath;
      const metadataOnlyAttachment = {
        ...baseAttachment,
        exact_bytes_available: false,
      };
      const inventory = makeAttachmentsResult({
        attachments: [metadataOnlyAttachment],
      });
      const record = {
        schema_version: "activity.attachment-record/v1",
        classifier_version: "v1.test",
        ...metadataOnlyAttachment,
        source_tier: "origin-daemon",
        origin_host: "mba",
        served_by_host: "mba",
        source_locator: "codex://threads/session-1",
        source_receipt: SOURCE_RECEIPT,
      };
      const fetchSpy = vi.fn(async (url: URL) => {
        if (url.pathname === "/v1/admin/health") {
          return {
            ok: true,
            text: async () => JSON.stringify(makeHealthPayload()),
            status: 200,
            statusText: "OK",
          };
        }
        if (url.pathname === "/v1/admin/activity/interactive%3Acodex%3Asession-1/attachments") {
          return {
            ok: true,
            text: async () => JSON.stringify(inventory),
            status: 200,
            statusText: "OK",
          };
        }
        if (url.pathname === `/v1/admin/activity/interactive%3Acodex%3Asession-1/attachments/${encodeURIComponent(metadataOnlyAttachment.ref)}`) {
          return {
            ok: true,
            text: async () => JSON.stringify(record),
            status: 200,
            statusText: "OK",
          };
        }
        throw new Error(`unexpected URL ${String(url)}`);
      });
      const { deps } = buildActivityDeps({ fetchSpy });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const program = buildProgram({ runCli: deps });

      await program.parseAsync([
        "node", "calyx", "activity", "attachments", "interactive:codex:session-1",
        "--host", "mba",
        "--server-url", "http://mba:8740",
        "--auth-token", "secret",
        "--ref", metadataOnlyAttachment.ref,
        "--extract",
        "--out", outDir,
        "--json",
      ]);

      const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as ActivityAttachmentsResult;
      expect(payload.attachments[0]).toMatchObject({
        ref: metadataOnlyAttachment.ref,
        exact_bytes_available: false,
        origin_host: "mba",
        served_by_host: "mba",
        source_tier: "origin-daemon",
      });
      expect(payload.attachments[0]?.extracted_path).toBeUndefined();
      expect(payload.attachments[0]?.cache_status).toBeUndefined();
      expect(await readdir(outDir)).toEqual([]);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("activity attachments remote extract rejects digest mismatch without a partial cache write", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "calyx-activity-attachments-"));
    try {
      const expectedBytes = Buffer.from("expected image bytes");
      const digest = createHash("sha256").update(expectedBytes).digest("hex");
      const ref = `att:sha256:${digest}`;
      const { extracted_path: _remotePath, ...baseAttachment } = makeAttachmentsResult().attachments[0]!;
      void _remotePath;
      const inventory = makeAttachmentsResult({
        attachments: [{
          ...baseAttachment,
          ref,
          sha256: digest,
          byte_size: expectedBytes.length,
        }],
        rollup: {
          images: 1,
          bytes: expectedBytes.length,
          refs: [ref],
        },
      });
      const record = {
        schema_version: "activity.attachment-record/v1",
        classifier_version: "v1.test",
        ...inventory.attachments[0]!,
        source_tier: "origin-daemon",
        origin_host: "mba",
        served_by_host: "mba",
        source_receipt: SOURCE_RECEIPT,
      };
      const fetchSpy = vi.fn(async (url: URL) => {
        if (url.pathname === "/v1/admin/health") {
          return {
            ok: true,
            text: async () => JSON.stringify(makeHealthPayload()),
            status: 200,
            statusText: "OK",
          };
        }
        if (url.pathname === "/v1/admin/activity/interactive%3Acodex%3Asession-1/attachments") {
          return {
            ok: true,
            text: async () => JSON.stringify(inventory),
            status: 200,
            statusText: "OK",
          };
        }
        if (url.pathname === `/v1/admin/activity/interactive%3Acodex%3Asession-1/attachments/${encodeURIComponent(ref)}`) {
          return {
            ok: true,
            text: async () => JSON.stringify(record),
            status: 200,
            statusText: "OK",
          };
        }
        if (url.pathname === `/v1/admin/activity/interactive%3Acodex%3Asession-1/attachments/${encodeURIComponent(ref)}/bytes`) {
          return new Response(Buffer.alloc(expectedBytes.length, 0x78), {
            status: 200,
            headers: {
              "content-type": "image/png",
              "content-length": String(expectedBytes.length),
              digest: `sha-256=${Buffer.from(digest, "hex").toString("base64")}`,
              etag: `"sha256:${digest}"`,
              "x-calyx-attachment-ref": ref,
              "x-calyx-source-tier": "origin-daemon",
              "x-calyx-origin-host": "mba",
              "x-calyx-served-by-host": "mba",
            },
          });
        }
        throw new Error(`unexpected URL ${String(url)}`);
      });
      const { deps } = buildActivityDeps({ fetchSpy });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const program = buildProgram({ runCli: deps });

      await expect(program.parseAsync([
        "node", "calyx", "activity", "attachments", "interactive:codex:session-1",
        "--host", "mba",
        "--server-url", "http://mba:8740",
        "--auth-token", "secret",
        "--ref", ref,
        "--extract",
        "--out", outDir,
        "--json",
      ])).rejects.toThrow("attachment_digest_mismatch");
      expect(await readdir(outDir)).toEqual([]);
      expect(out).toHaveBeenCalledTimes(0);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test.each(["sessions", "archived_sessions"] as const)(
    "activity attachments fallback searches the POL-1041 codex/%s subtree",
    async (subtree) => {
      const root = await mkdtemp(join(tmpdir(), "calyx-activity-archive-"));
      try {
        const archiveRoot = join(root, "raw");
        const outDir = join(root, "cache");
        process.env["CALYX_AGENT_SESSION_ARCHIVE_RAW_ROOT"] = archiveRoot;
        const sessionId = "019dcafe-1111-7222-8333-abcabcabcabc";
        const activityId = `interactive:codex:${sessionId}`;
        const bytes = Buffer.from("archive image bytes");
        const digest = createHash("sha256").update(bytes).digest("hex");
        const ref = `att:sha256:${digest}`;
        await writeArchiveCodexSession(archiveRoot, "carbon", sessionId, [
          codexArchiveSessionMeta(sessionId),
          codexArchiveImageMessage("archive image", `data:image/png;base64,${bytes.toString("base64")}`),
        ], subtree);
        const fetchSpy = vi.fn(async (_url: URL) => {
          throw new Error("ECONNREFUSED");
        });
        const { deps } = buildActivityDeps({ fetchSpy });
        const out = vi.spyOn(console, "log").mockImplementation(() => {});
        const program = buildProgram({ runCli: deps });

        await program.parseAsync([
          "node", "calyx", "activity", "attachments", activityId,
          "--host", "carbon",
          "--server-url", "http://carbon:8740",
          "--auth-token", "secret",
          "--ref", ref,
          "--extract",
          "--out", outDir,
          "--json",
        ]);

        const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as ActivityAttachmentsResult;
        const attachment = payload.attachments[0]!;
        expect(attachment.ref).toBe(ref);
        expect(attachment.source_tier).toBe("blade-archive");
        expect(attachment.origin_host).toBe("carbon");
        expect(attachment.extracted_path).toMatch(
          new RegExp(`${digest}\\.[0-9a-f]{64}\\.png$`),
        );
        expect(await readFile(attachment.extracted_path!, "utf8")).toBe("archive image bytes");
        const provenance = JSON.parse(await readFile(attachment.provenance_path!, "utf8")) as {
          observations: Array<{ source_tier?: string; origin_host?: string }>;
        };
        expect(provenance.observations.at(-1)).toMatchObject({
          source_tier: "blade-archive",
          origin_host: "carbon",
        });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy.mock.calls.map(([url]) => url.pathname)).toEqual([
          "/v1/admin/health",
          "/v1/admin/health",
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("activity events --classify dispatches locally and prints classification metadata", async () => {
    const { deps, inspectActivityEventsSpy } = buildActivityDeps({
      eventsResult: makeEventsResult({
        events: [{
          index: 0,
          line: 1,
          role: "user",
          kind: "message",
          summary: "harness payload",
          text: "# AGENTS.md instructions",
          classification: {
            classifier_version: "v1.test",
            rule_id: "harness/agents-md-prefix",
            reason: "Codex AGENTS.md harness payload, not a human prompt.",
            source_role: "user",
            source_kind: "message",
            projected_role: "harness_context",
            visibility: "hidden",
            message_id: "interactive:codex:session-1:msg:1",
          },
        }],
      }),
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });
    await program.parseAsync([
      "node", "calyx", "activity", "events", "interactive:codex:session-1",
      "--raw-role", "user",
      "--classify",
      "--tail", "1",
      "--json",
    ]);
    expect(inspectActivityEventsSpy).toHaveBeenCalledTimes(1);
    const arg = inspectActivityEventsSpy.mock.calls[0]?.[0] as { selector: { classify?: boolean; raw_role?: string } };
    expect(arg.selector.classify).toBe(true);
    expect(arg.selector.raw_role).toBe("user");
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as ActivityEventsResult;
    expect(payload.events[0]?.classification?.projected_role).toBe("harness_context");
  });

  test("activity events run:<id> dispatches locally through the shared resolver path", async () => {
    const runId = "abc-123";
    const { deps, inspectActivityEventsSpy } = buildActivityDeps({
      eventsResult: makeEventsResult({ run_id: runId }),
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });
    await program.parseAsync(["node", "calyx", "activity", "events", `run:${runId}`, "--tail", "1", "--json"]);
    expect(inspectActivityEventsSpy).toHaveBeenCalledTimes(1);
    const callArg = inspectActivityEventsSpy.mock.calls[0]?.[0] as { activityId: string };
    expect(callArg.activityId).toBe(`run:${runId}`);
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as ActivityEventsResult;
    expect(payload.run_id).toBe(runId);
    expect(payload.activity_id).toBe("interactive:codex:session-1");
  });

  test("run activity show emits stderr deprecation warning pointing to calyx activity", async () => {
    const { deps } = buildActivityDeps();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });
    await program.parseAsync([
      "node", "calyx", "run", "activity", "show",
      "--activity-id", "interactive:codex:session-1",
    ]);
    const messages = errSpy.mock.calls.map((call) => String(call[0]));
    expect(messages.some((msg) => msg.includes("deprecated") && msg.includes("calyx activity"))).toBe(true);
  });

  test("activity turns --role user is rejected with the corrective error", async () => {
    const { deps, inspectActivityTurnsSpy } = buildActivityDeps();
    const program = buildProgram({ runCli: deps });
    await expect(
      program.parseAsync(["node", "calyx", "activity", "turns", "interactive:codex:s", "--role", "user", "--last", "1"]),
    ).rejects.toThrow(/ambiguous role `user`/);
    expect(inspectActivityTurnsSpy).not.toHaveBeenCalled();
  });

  test("activity turns run:<id> dispatches locally and prints run resolution metadata", async () => {
    const runId = "abc-123";
    const { deps, inspectActivityTurnsSpy } = buildActivityDeps({
      turnsResult: makeTurnsResult({ run_id: runId }),
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });
    await program.parseAsync(["node", "calyx", "activity", "turns", `run:${runId}`, "--last", "1", "--json"]);
    expect(inspectActivityTurnsSpy).toHaveBeenCalledTimes(1);
    const callArg = inspectActivityTurnsSpy.mock.calls[0]?.[0] as { activityId: string };
    expect(callArg.activityId).toBe(`run:${runId}`);
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as ActivityTurnsResult;
    expect(payload.run_id).toBe(runId);
    expect(payload.activity_id).toBe("interactive:codex:session-1");
  });

  test("activity turns dispatches locally with selector and prints JSON", async () => {
    const { deps, inspectActivityTurnsSpy } = buildActivityDeps();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node", "calyx", "activity", "turns", "interactive:codex:session-1",
      "--role", "assistant",
      "--last", "1",
      "--with-tools",
      "--json",
    ]);

    expect(inspectActivityTurnsSpy).toHaveBeenCalledTimes(1);
    const callArg = inspectActivityTurnsSpy.mock.calls[0]?.[0] as { activityId: string; selector: Record<string, unknown> };
    expect(callArg.activityId).toBe("interactive:codex:session-1");
    expect(callArg.selector).toMatchObject({ role: "assistant", last: 1, with_tools: true });
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as ActivityTurnsResult;
    expect(payload.turns[0]?.turn_id).toBe("interactive:codex:session-1:turn:3");
    expect(payload.turns[0]?.role).toBe("assistant");
  });

  test("activity turns remote query is gated on activity.turns/v1 and builds /v1/admin/activity/.../turns URL", async () => {
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return {
          ok: true,
          text: async () => JSON.stringify(makeHealthPayload()),
          status: 200,
          statusText: "OK",
        };
      }
      expect(String(url)).toBe(
        "http://mba:8740/v1/admin/activity/interactive%3Acodex%3Asession-1/turns?last=1&role=assistant&with_tools=1",
      );
      return {
        ok: true,
        text: async () => JSON.stringify(makeTurnsResult()),
        status: 200,
        statusText: "OK",
      };
    });
    const { deps } = buildActivityDeps({ fetchSpy });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node", "calyx", "activity", "turns", "interactive:codex:session-1",
      "--host", "mba",
      "--server-url", "http://mba:8740",
      "--auth-token", "secret",
      "--role", "assistant",
      "--last", "1",
      "--with-tools",
      "--json",
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("activity turns remote refuses when daemon lacks activity.turns/v1", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T00:00:00.000Z"));
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return {
          ok: true,
          text: async () => JSON.stringify(makeHealthPayload({
            supports_features: [
              CALYX_DAEMON_FEATURES.healthV1,
              CALYX_DAEMON_FEATURES.activityMessagesV1,
            ],
          })),
          status: 200,
          statusText: "OK",
        };
      }
      throw new Error("activity turns should not query /v1/admin/activity when the health guard fails");
    });
    const { deps } = buildActivityDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });
    try {
      await expect(program.parseAsync([
        "node", "calyx", "activity", "turns", "interactive:codex:s",
        "--host", "mba",
        "--server-url", "http://mba:8740",
        "--auth-token", "secret",
        "--role", "assistant",
        "--last", "1",
      ])).rejects.toThrow(/activity\.turns\/v1/);
    } finally {
      vi.useRealTimers();
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("activity events --within-turn requires --around-id", async () => {
    const { deps, inspectActivityEventsSpy } = buildActivityDeps();
    const program = buildProgram({ runCli: deps });
    await expect(
      program.parseAsync(["node", "calyx", "activity", "events", "interactive:codex:s", "--within-turn"]),
    ).rejects.toThrow(/--within-turn requires --around-id/);
    expect(inspectActivityEventsSpy).not.toHaveBeenCalled();
  });

  test("activity events --within-turn forwards within_turn flag to the service", async () => {
    const { deps, inspectActivityEventsSpy } = buildActivityDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });
    await program.parseAsync([
      "node", "calyx", "activity", "events", "interactive:codex:session-1",
      "--around-id", "interactive:codex:session-1:msg:3",
      "--within-turn",
      "--json",
    ]);
    expect(inspectActivityEventsSpy).toHaveBeenCalledTimes(1);
    const arg = inspectActivityEventsSpy.mock.calls[0]?.[0] as { selector: { within_turn?: boolean; around_id?: string } };
    expect(arg.selector.within_turn).toBe(true);
    expect(arg.selector.around_id).toBe("interactive:codex:session-1:msg:3");
  });

  test("activity events --within-turn remote query is gated on activity.turns/v1 and serializes within_turn", async () => {
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return {
          ok: true,
          text: async () => JSON.stringify(makeHealthPayload()),
          status: 200,
          statusText: "OK",
        };
      }
      expect(String(url)).toBe(
        "http://mba:8740/v1/admin/activity/interactive%3Acodex%3Asession-1/events?around_id=interactive%3Acodex%3Asession-1%3Amsg%3A3&within_turn=1",
      );
      return {
        ok: true,
        text: async () => JSON.stringify(makeEventsResult({
          selector: {
            around_id: "interactive:codex:session-1:msg:3",
            within_turn: true,
          },
        })),
        status: 200,
        statusText: "OK",
      };
    });
    const { deps } = buildActivityDeps({ fetchSpy });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node", "calyx", "activity", "events", "interactive:codex:session-1",
      "--host", "mba",
      "--server-url", "http://mba:8740",
      "--auth-token", "secret",
      "--around-id", "interactive:codex:session-1:msg:3",
      "--within-turn",
      "--json",
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("activity events --within-turn remote refuses when daemon lacks activity.turns/v1", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T00:00:00.000Z"));
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return {
          ok: true,
          text: async () => JSON.stringify(makeHealthPayload({
            supports_features: [
              CALYX_DAEMON_FEATURES.healthV1,
              CALYX_DAEMON_FEATURES.activityMessagesV1,
            ],
          })),
          status: 200,
          statusText: "OK",
        };
      }
      throw new Error("activity events --within-turn should not query /v1/admin/activity when the health guard fails");
    });
    const { deps } = buildActivityDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });
    try {
      await expect(program.parseAsync([
        "node", "calyx", "activity", "events", "interactive:codex:s",
        "--host", "mba",
        "--server-url", "http://mba:8740",
        "--auth-token", "secret",
        "--around-id", "interactive:codex:s:msg:3",
        "--within-turn",
      ])).rejects.toThrow(/activity\.turns\/v1/);
    } finally {
      vi.useRealTimers();
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
