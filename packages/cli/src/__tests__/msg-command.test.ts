import { mkdir, readFile, readdir, stat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyStateMigrations,
  CALYX_DAEMON_FEATURES,
  claimMessageOutboxAttempt,
  createMessage,
  enqueueMessageOutbox,
  exchangeSessionIngressLaunch,
  hashConsumerApiBearer,
  openStateStore,
  prepareSessionIngressLaunch,
  readMessage,
  readMessageOutbox,
  listSessionWakeDeliveries,
} from "@polli-labs/calyx-core";
import { createCalyxAdminClient } from "@polli-labs/calyx-client/admin";
import { RunService, startSessionIngressReceiver, type RunActivityEntry } from "@polli-labs/calyx-run-service";
import { startRunServer } from "@polli-labs/calyx-server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { openClientRecoveryCustody } from "../client-recovery-custody.js";
import { buildProgram } from "../run-cli";

function createAdminClientFactory(fetchImpl: typeof fetch): typeof createCalyxAdminClient {
  return (options) => createCalyxAdminClient({
    ...options,
    fetch: fetchImpl,
  });
}

function createRoutedAdminClientFactory(
  routes: Readonly<Record<string, string>>,
): typeof createCalyxAdminClient {
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = requestFrom(input, init);
    const logical = new URL(request.url);
    const actualBase = routes[logical.hostname];
    if (!actualBase) throw new Error(`unexpected logical run-server host ${logical.hostname}`);
    const actual = new URL(actualBase);
    actual.pathname = logical.pathname;
    actual.search = logical.search;
    return fetch(actual, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      ...(request.body ? { duplex: "half" } : {}),
      signal: request.signal,
    } as RequestInit);
  };
  return createAdminClientFactory(fetchImpl);
}

function requestFrom(input: Parameters<typeof fetch>[0], init?: RequestInit): Request {
  return input instanceof Request && init === undefined ? input : new Request(input, init);
}

const ENV_KEYS = [
  "CALYX_STATE_HOME",
  "CALYX_STATE_DB",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CALYX_ACTIVITY_ID",
  "CALYX_RUN_SERVER_URL_TEMPLATE",
  "CALYX_RUN_HOST",
] as const;

const BUILD_INFO = {
  schema_version: "build-info/v1" as const,
  git_head: "msg-command-test-sha",
  built_at: "2026-07-14T00:00:00.000Z",
  package_version: "0.2.0",
  branch: "test",
  dirty: false,
};

describe("msg command", () => {
  let root: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
      CODEX_THREAD_ID: process.env["CODEX_THREAD_ID"],
      CODEX_SESSION_ID: process.env["CODEX_SESSION_ID"],
      CLAUDE_CODE_SESSION_ID: process.env["CLAUDE_CODE_SESSION_ID"],
      CALYX_ACTIVITY_ID: process.env["CALYX_ACTIVITY_ID"],
      CALYX_RUN_SERVER_URL_TEMPLATE: process.env["CALYX_RUN_SERVER_URL_TEMPLATE"],
      CALYX_RUN_HOST: process.env["CALYX_RUN_HOST"],
    };
    for (const key of ENV_KEYS) delete process.env[key];
    process.env["CODEX_SESSION_ID"] = "sender-session";
    root = await mkdtemp(join(tmpdir(), "calyx-msg-command-"));
    process.env["CALYX_STATE_HOME"] = join(root, "state");
    await applyStateMigrations();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  async function writeRunServeTruth(host: string, serverUrl: string): Promise<string> {
    return writeRunServeTruths({ [host]: serverUrl });
  }

  async function writeRunServeTruths(hosts: Readonly<Record<string, string>>): Promise<string> {
    const agentsInfraRoot = join(root, "agents-infra");
    await mkdir(join(agentsInfraRoot, "fleet", "truths"), { recursive: true });
    const hostRows = Object.entries(hosts)
      .map(([host, serverUrl]) => `  ${host}:\n    run_serve_url: ${serverUrl}`)
      .join("\n");
    await writeFile(
      join(agentsInfraRoot, "fleet", "truths", "hosts.yaml"),
      `hosts:\n${hostRows}\n`,
      "utf8",
    );
    return agentsInfraRoot;
  }

  test("send, inbox claim, ack, and thread operate on local directed messages", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "msg",
      "send",
      "--to",
      "interactive:codex:target-session",
      "--subject",
      "Baton",
      "--body",
      "continue from the latest receipt",
      "--thread",
      "thread-baton",
      "--json",
    ]);
    const sent = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      message: { message_id: string; status: string; receipt_path: string | null; spooled_at: string; delivered_at: string | null };
      delivery_notice: { code: string; delivery_state: string; wake: string };
      delivery_state: { count: number; counts: { attempted: number; delivered: number; failed: number } };
    };
    expect(sent.schema_version).toBe("calyx.msg-send/v1");
    expect(sent.message).toMatchObject({ status: "pending", delivered_at: null });
    expect(sent.message.spooled_at).toMatch(/^20/);
    expect(sent.message.receipt_path).toContain("receipts/messages.jsonl");
    expect(sent.delivery_notice).toMatchObject({
      code: "spooled_to_durable_inbox",
      delivery_state: "spooled",
      wake: "not_attempted",
    });
    expect(sent.delivery_state).toMatchObject({
      count: 0,
      counts: { attempted: 0, delivered: 0, failed: 0 },
    });

    await program.parseAsync([
      "node",
      "calyx",
      "msg",
      "inbox",
      "--for",
      "interactive:codex:target-session",
      "--json",
    ]);
    const inbox = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      count: number;
      messages: Array<{ message_id: string; status: string; claimed_by: string | null }>;
    };
    expect(inbox.count).toBe(1);
    expect(inbox.messages[0]).toMatchObject({
      message_id: sent.message.message_id,
      status: "claimed",
      claimed_by: "interactive:codex:sender-session",
    });

    await program.parseAsync(["node", "calyx", "msg", "ack", sent.message.message_id, "--json"]);
    const ack = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      changed: boolean;
      message: { status: string; acked_by: string };
    };
    expect(ack.changed).toBe(true);
    expect(ack.message).toMatchObject({ status: "acked", acked_by: "interactive:codex:sender-session" });

    await program.parseAsync(["node", "calyx", "msg", "thread", "thread-baton", "--json"]);
    const thread = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as { count: number };
    expect(thread.count).toBe(1);
  });

  test("local send rolls back correspondence when its receipt obligation cannot commit", async () => {
    const opened = await openStateStore();
    try {
      opened.db.exec(`
        CREATE TRIGGER reject_local_message_receipt_obligation
        BEFORE INSERT ON message_receipt_mirrors
        BEGIN
          SELECT RAISE(ABORT, 'injected receipt obligation failure');
        END
      `);
    } finally {
      opened.db.close();
    }

    const program = buildProgram();
    await expect(program.parseAsync([
      "node",
      "calyx",
      "msg",
      "send",
      "--to",
      "interactive:codex:target-session",
      "--subject",
      "Atomic receipt",
      "--body",
      "must not outlive its receipt obligation",
      "--json",
    ])).rejects.toThrow(/injected receipt obligation failure/);

    const verified = await openStateStore();
    try {
      const messages = verified.db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number };
      const mirrors = verified.db.prepare("SELECT COUNT(*) AS count FROM message_receipt_mirrors").get() as { count: number };
      expect(messages.count).toBe(0);
      expect(mirrors.count).toBe(0);
    } finally {
      verified.db.close();
    }
  });

  test("reply infers the counterpart, preserves the thread, and sets reply_to", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "msg",
      "send",
      "--to",
      "interactive:codex:target-session",
      "--subject",
      "Baton",
      "--body",
      "continue from the latest receipt",
      "--thread",
      "thread-baton",
      "--json",
    ]);
    const sent = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      message: { message_id: string; sender: string };
    };

    process.env["CALYX_ACTIVITY_ID"] = "interactive:codex:target-session";
    await program.parseAsync([
      "node",
      "calyx",
      "msg",
      "reply",
      sent.message.message_id,
      "--body",
      "acknowledged; taking it",
      "--json",
    ]);

    const reply = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      reply_to: string;
      reply_recipient: { address: string; inferred: boolean };
      message: {
        recipient_address: string;
        subject: string;
        thread_key: string;
        reply_to: string;
      };
    };
    expect(reply.schema_version).toBe("calyx.msg-reply/v1");
    expect(reply.reply_to).toBe(sent.message.message_id);
    expect(reply.reply_recipient).toMatchObject({
      address: sent.message.sender,
      inferred: true,
    });
    expect(reply.message).toMatchObject({
      recipient_address: sent.message.sender,
      subject: "Re: Baton",
      thread_key: "thread-baton",
      reply_to: sent.message.message_id,
    });
  });

  test("scope bulletins require a ttl and are read through peek-only inbox", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: { currentHostAlias: "blade", hostname: () => "blade" } });
    const hostScope = "host:blade";

    await program.parseAsync([
      "node",
      "calyx",
      "msg",
      "send",
      "--to",
      hostScope,
      "--subject",
      "Heads up",
      "--body",
      "bulletin",
      "--ttl-ms",
      "3600000",
      "--json",
    ]);
    const sent = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      message: { recipient_class: string; status: string };
    };
    expect(sent.message).toMatchObject({ recipient_class: "scope", status: "pending" });

    await program.parseAsync(["node", "calyx", "msg", "inbox", "--scope", hostScope, "--json"]);
    const scopeInbox = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      peek: boolean;
      count: number;
      messages: Array<{ recipient_class: string }>;
    };
    expect(scopeInbox.peek).toBe(true);
    expect(scopeInbox.count).toBe(1);
    expect(scopeInbox.messages[0]?.recipient_class).toBe("scope");
  });

  test("bare run sends are durable-only and never launch, deliver, claim, or ack", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const getRunRecord = vi.fn();
    const launch = vi.fn();
    const program = buildProgram({
      runCli: {
        createRunService: () => ({ getRunRecord, launch }) as never,
      },
    });
    await program.parseAsync([
      "node", "calyx", "msg", "send",
      "--to", "run:source-run",
      "--subject", "Baton",
      "--body", "please continue",
      "--json",
    ]);
    const sent = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      message: { message_id: string };
      delivery_notice: { code: string; delivery_state: string; wake: string };
      delivery_state: { counts: { attempted: number; delivered: number; failed: number } };
    };
    expect(sent.delivery_notice).toMatchObject({
      code: "spooled_to_durable_inbox",
      delivery_state: "spooled",
      wake: "not_attempted",
    });
    expect(sent.delivery_state.counts).toEqual({ attempted: 0, delivered: 0, failed: 0 });
    expect(getRunRecord).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();

    const opened = await openStateStore();
    try {
      expect(readMessage(opened.db, sent.message.message_id)).toMatchObject({
        status: "pending",
        acked_by: null,
        delivered_at: null,
      });
      expect(opened.db.prepare("SELECT COUNT(*) AS count FROM session_wake_deliveries").get())
        .toEqual({ count: 0 });
    } finally {
      opened.db.close();
    }
  });

  test("--wake preserves a typed durable-success result when no binding exists", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();
    await program.parseAsync([
      "node", "calyx", "msg", "send",
      "--to", "interactive:claude:ordinary-session",
      "--subject", "Wake",
      "--body", "pull the durable row",
      "--wake",
      "--json",
    ]);
    const sent = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      message: { status: string; acked_at: string | null };
      wake: { delivery_state: string; wake_state: string; delivery: { status: string; error_code: string } };
      delivery_notice: { code: string; delivery_state: string; wake: string };
    };
    expect(sent.message).toMatchObject({ status: "pending", acked_at: null });
    expect(sent.wake).toMatchObject({
      delivery_state: "spooled",
      wake_state: "binding_unavailable",
      delivery: { status: "failed", error_code: "binding_unavailable" },
    });
    expect(sent.delivery_notice).toMatchObject({
      code: "wake_not_delivered",
      delivery_state: "spooled",
      wake: "not_delivered",
    });
  });

  test("--wake delivers a pointer to an explicitly registered conductor without auto-ack", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const runtimeDir = join(root, "runtime");
    const opened = await openStateStore();
    const prepared = prepareSessionIngressLaunch(opened.db, {
      backend: "claude",
      destination_host: "carbon",
    });
    const received: unknown[] = [];
    const receiver = await startSessionIngressReceiver({
      endpoint_ref: prepared.launch.endpoint_ref,
      generation: prepared.launch.generation,
      runtimeDir,
      onWake: (envelope) => { received.push(envelope); },
    });
    exchangeSessionIngressLaunch(opened.db, {
      launch_nonce: prepared.launch_nonce,
      activity_id: "interactive:claude:conductor-session",
      harness_session_id: "conductor-session",
    });
    opened.db.close();
    try {
      const program = buildProgram({ runCli: { sessionWake: { runtimeDir } } });
      await program.parseAsync([
        "node", "calyx", "msg", "send",
        "--to", "interactive:claude:conductor-session",
        "--subject", "Wake",
        "--body", "secret body remains in inbox",
        "--wake",
        "--json",
      ]);
      const sent = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        message: { message_id: string; status: string; acked_at: string | null };
        wake: { wake_state: string; delivery: { status: string } };
        delivery_notice: { code: string; wake: string };
      };
      expect(sent.message).toMatchObject({ status: "pending", acked_at: null });
      expect(sent.wake).toMatchObject({ wake_state: "wake_delivered", delivery: { status: "delivered" } });
      expect(sent.delivery_notice).toMatchObject({ code: "wake_delivered", wake: "delivered" });
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        pointer: { kind: "message", id: sent.message.message_id },
        first_command: "calyx msg inbox --for interactive:claude:conductor-session --json",
      });
      expect(JSON.stringify(received[0])).not.toContain("secret body");
    } finally {
      await receiver.close();
    }
  });

  test("run-target --wake admits one message to the resolved activity inbox before waking it", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const runtimeDir = await mkdtemp(join(tmpdir(), "cmi-run-"));
    const activityId = "interactive:claude:run-owner-session";
    const opened = await openStateStore();
    const prepared = prepareSessionIngressLaunch(opened.db, {
      backend: "claude",
      destination_host: "carbon",
    });
    const received: unknown[] = [];
    const receiver = await startSessionIngressReceiver({
      endpoint_ref: prepared.launch.endpoint_ref,
      generation: prepared.launch.generation,
      runtimeDir,
      onWake: (envelope) => { received.push(envelope); },
    });
    exchangeSessionIngressLaunch(opened.db, {
      launch_nonce: prepared.launch_nonce,
      activity_id: activityId,
      harness_session_id: "run-owner-session",
    });
    opened.db.close();
    try {
      const getRunRecord = vi.fn(async (runId: string) => runId === "source-run"
        ? {
            intent: {
              kernel: "agent_runner",
              backend: "claude",
              resume_session_id: "run-owner-session",
            },
            recovery: {},
          }
        : undefined);
      const program = buildProgram({
        runCli: {
          sessionWake: { runtimeDir },
          createRunService: () => ({ getRunRecord }) as never,
        },
      });
      await program.parseAsync([
        "node", "calyx", "msg", "send",
        "--to", "run:source-run",
        "--subject", "Run baton",
        "--body", "same durable body",
        "--wake",
        "--json",
      ]);
      const sent = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        message: {
          message_id: string;
          recipient_address: string;
          status: string;
          acked_at: string | null;
        };
        resolved: { kind: string; address: string };
        wake: { wake_state: string; first_command: string };
        delivery_state: {
          counts: { attempted: number; delivered: number; failed: number };
          deliveries: Array<{ adapter: string; status: string }>;
        };
      };
      expect(getRunRecord).toHaveBeenCalledWith("source-run");
      expect(sent.message).toMatchObject({
        recipient_address: activityId,
        status: "pending",
        acked_at: null,
      });
      expect(sent.resolved).toMatchObject({ kind: "interactive", address: activityId });
      expect(sent.wake).toMatchObject({
        wake_state: "wake_delivered",
        first_command: `calyx msg inbox --for ${activityId} --json`,
      });
      expect(sent.delivery_state.counts).toEqual({ attempted: 0, delivered: 1, failed: 0 });
      expect(sent.delivery_state.deliveries).toEqual([
        expect.objectContaining({ adapter: "session_ingress", status: "delivered" }),
      ]);
      expect(received).toEqual([
        expect.objectContaining({
          pointer: { kind: "message", id: sent.message.message_id },
          first_command: `calyx msg inbox --for ${activityId} --json`,
        }),
      ]);

      await program.parseAsync([
        "node", "calyx", "msg", "inbox",
        "--for", "run:source-run",
        "--peek",
        "--json",
      ]);
      const runInbox = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as { count: number };
      expect(runInbox.count).toBe(0);

      await program.parseAsync([
        "node", "calyx", "msg", "inbox",
        "--for", activityId,
        "--claimed-by", activityId,
        "--json",
      ]);
      const activityInbox = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        count: number;
        messages: Array<{
          message_id: string;
          recipient_address: string;
          status: string;
          claimed_by: string | null;
          acked_at: string | null;
        }>;
      };
      expect(activityInbox.count).toBe(1);
      expect(activityInbox.messages).toEqual([
        expect.objectContaining({
          message_id: sent.message.message_id,
          recipient_address: activityId,
          status: "claimed",
          claimed_by: activityId,
          acked_at: null,
        }),
      ]);

      const state = await openStateStore();
      try {
        expect(state.db.prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE message_id = ? AND recipient_address = ? AND acked_at IS NULL",
        ).get(sent.message.message_id, activityId)).toEqual({ count: 1 });
      } finally {
        state.db.close();
      }
    } finally {
      await receiver.close();
      await rm(runtimeDir, { recursive: true, force: true });
    }
  });

  test("--wake rejects an unsupported exact backend before durable admission", async () => {
    const program = buildProgram();
    await expect(program.parseAsync([
      "node", "calyx", "msg", "send",
      "--to", "interactive:gemini:unsupported-session",
      "--subject", "Unsupported wake",
      "--body", "must not be admitted",
      "--wake",
      "--json",
    ])).rejects.toThrow(/does not support interactive backend gemini.*no message was written/u);

    const state = await openStateStore();
    try {
      expect(state.db.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 0 });
      expect(state.db.prepare("SELECT COUNT(*) AS count FROM session_wake_deliveries").get()).toEqual({ count: 0 });
    } finally {
      state.db.close();
    }
  });

  test("cross-host --wake uses named-host admin routing and destination-private IPC", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const sourceControlToken = "carbon-control-plane-token";
    const destinationToken = "blade-control-plane-token";
    const destinationInternalToken = "carbon-daemon-token";
    const destinationState = join(root, "blade-state");
    const destinationEnv = { ...process.env, CALYX_STATE_HOME: destinationState };
    const runtimeDir = await mkdtemp(join(tmpdir(), "calyx-session-wake-"));
    await applyStateMigrations({ storeOptions: { env: destinationEnv } });
    const destination = await openStateStore({ env: destinationEnv });
    const prepared = prepareSessionIngressLaunch(destination.db, {
      backend: "claude",
      destination_host: "blade",
    });
    exchangeSessionIngressLaunch(destination.db, {
      launch_nonce: prepared.launch_nonce,
      activity_id: "interactive:claude:remote-conductor",
      harness_session_id: "remote-conductor",
    });
    destination.db.close();
    const received: unknown[] = [];
    const receiver = await startSessionIngressReceiver({
      endpoint_ref: prepared.launch.endpoint_ref,
      generation: prepared.launch.generation,
      state: { env: destinationEnv },
      runtimeDir,
      onWake: (envelope) => { received.push(envelope); },
    });
    const server = await startRunServer({
      credentials: [
        {
          client_id: "operator_cli",
          credential_tier: "control_plane",
          verifier: hashConsumerApiBearer(destinationToken),
          verifier_env: "CALYX_CONSUMER_API_TEST_BLADE_CONTROL_VERIFIER",
          address_grants: { send_as: [], read: [] },
        },
        {
          client_id: "daemon:carbon",
          credential_tier: "internal_runtime",
          verifier: hashConsumerApiBearer(destinationInternalToken),
          verifier_env: "CALYX_CONSUMER_API_TEST_BLADE_INTERNAL_VERIFIER",
          address_grants: { send_as: ["interactive:codex:sender-session"], read: ["host:carbon"] },
        },
      ],
      host: "127.0.0.1",
      hostname: () => "blade",
      advertisedHost: "blade",
      port: 0,
      service: new RunService({ runsRoot: join(root, "blade-runs") }),
      registryRoot: join(root, "blade-registry"),
      stateStoreOptions: { env: destinationEnv },
      messageHostAliases: { carbon: "carbon" },
      sessionWake: { runtimeDir },
      buildInfo: BUILD_INFO,
      startedAt: "2026-07-17T00:00:00.000Z",
      inheritedPath: "/usr/bin:/bin",
    });
    let source: Awaited<ReturnType<typeof startRunServer>> | undefined;
    try {
      const destinationUrl = server.url.replace("http://blade:", "http://127.0.0.1:");
      const sourceService = new RunService({
        runsRoot: join(root, "carbon-runs"),
        messageOutbox: {
          enabled: true,
          state: { env: { ...process.env } },
          serverUrlForHost: (host) => {
            if (host !== "blade") throw new Error(`unexpected message target ${host}`);
            return destinationUrl;
          },
          tokenForHost: (host) => host === "blade" ? destinationInternalToken : undefined,
        },
      });
      source = await startRunServer({
        credentials: [
          {
            client_id: "operator_cli",
            credential_tier: "control_plane",
            verifier: hashConsumerApiBearer(sourceControlToken),
            verifier_env: "CALYX_CONSUMER_API_TEST_CARBON_CONTROL_VERIFIER",
            address_grants: { send_as: [], read: [] },
          },
        ],
        host: "127.0.0.1",
        hostname: () => "carbon",
        advertisedHost: "carbon",
        port: 0,
        service: sourceService,
        registryRoot: join(root, "carbon-registry"),
        stateStoreOptions: { env: { ...process.env } },
        messageHostAliases: { blade: "blade" },
        buildInfo: BUILD_INFO,
        startedAt: "2026-07-17T00:00:00.000Z",
        inheritedPath: "/usr/bin:/bin",
      });
      const sourceUrl = source.url.replace("http://carbon:", "http://127.0.0.1:");
      const agentsInfraRoot = await writeRunServeTruths({
        carbon: "http://carbon.test:8740",
        blade: "http://blade.test:8740",
      });
      const tokenForHost = vi.fn((host: string) => (
        host === "carbon" ? sourceControlToken : host === "blade" ? destinationToken : undefined
      ));
      const program = buildProgram({
        runCli: {
          agentsInfraRoot,
          currentHostAlias: "carbon",
          tokenForHost,
          createAdminClient: createRoutedAdminClientFactory({
            "carbon.test": sourceUrl,
            "blade.test": destinationUrl,
          }),
        },
      });
      await program.parseAsync([
        "node", "calyx", "msg", "send",
        "--to", "interactive:claude:remote-conductor",
        "--host", "blade",
        "--subject", "Cross-host wake",
        "--body", "body stays in the durable correspondence store",
        "--wake",
        "--json",
      ]);

      const outputText = String(out.mock.calls.at(-1)?.[0]);
      const sent = JSON.parse(outputText) as {
        message: { message_id: string; status: string; acked_at: string | null; delivered_at: string | null };
        wake: { wake_state: string; delivery: { delivery_id: string; status: string } };
        delivery_state: { counts: { delivered: number } };
      };
      expect(sent.delivery_state.counts.delivered, outputText).toBeGreaterThanOrEqual(1);
      expect(sent.message, outputText).toMatchObject({ status: "outbox", acked_at: null, delivered_at: expect.any(String) });
      expect(sent.wake, outputText).toMatchObject({ wake_state: "wake_delivered", delivery: { status: "delivered" } });
      expect(tokenForHost).toHaveBeenCalledWith("carbon");
      expect(tokenForHost).toHaveBeenCalledWith("blade");
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        delivery_id: sent.wake.delivery.delivery_id,
        recipient_activity_id: "interactive:claude:remote-conductor",
        pointer: { kind: "message", id: sent.message.message_id },
      });
      expect(JSON.stringify(received[0])).not.toContain("body stays");
      expect(outputText).not.toContain(runtimeDir);
      expect(outputText).not.toContain(prepared.launch.endpoint_ref);

      const destinationAfter = await openStateStore({ env: destinationEnv });
      try {
        expect(listSessionWakeDeliveries(destinationAfter.db, {
          pointer_id: sent.message.message_id,
        })).toHaveLength(1);
        expect(readMessage(destinationAfter.db, sent.message.message_id)).toMatchObject({
          recipient_address: "interactive:claude:remote-conductor",
          status: "pending",
          delivered_at: expect.any(String),
          acked_at: null,
        });
      } finally {
        destinationAfter.db.close();
      }
    } finally {
      await source?.close();
      await server.close();
      await receiver.close();
      await rm(runtimeDir, { recursive: true, force: true });
    }
  });

  test("cross-host --wake reports a typed durable-success result for an unsupported daemon", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const sourceControlToken = "carbon-old-control-token";
    const destinationToken = "blade-old-daemon-token";
    const destinationInternalToken = "carbon-old-daemon-token";
    const destinationEnv = { ...process.env, CALYX_STATE_HOME: join(root, "old-blade-state") };
    await applyStateMigrations({ storeOptions: { env: destinationEnv } });
    const server = await startRunServer({
      credentials: [
        {
          client_id: "operator_cli",
          credential_tier: "control_plane",
          verifier: hashConsumerApiBearer(destinationToken),
          verifier_env: "CALYX_CONSUMER_API_TEST_OLD_BLADE_CONTROL_VERIFIER",
          address_grants: { send_as: [], read: [] },
        },
        {
          client_id: "daemon:carbon",
          credential_tier: "internal_runtime",
          verifier: hashConsumerApiBearer(destinationInternalToken),
          verifier_env: "CALYX_CONSUMER_API_TEST_OLD_BLADE_INTERNAL_VERIFIER",
          address_grants: { send_as: ["interactive:codex:sender-session"], read: ["host:carbon"] },
        },
      ],
      host: "127.0.0.1",
      hostname: () => "blade",
      advertisedHost: "blade",
      port: 0,
      service: new RunService({ runsRoot: join(root, "old-blade-runs") }),
      registryRoot: join(root, "old-blade-registry"),
      stateStoreOptions: { env: destinationEnv },
      messageHostAliases: { carbon: "carbon" },
      supportsFeatures: [CALYX_DAEMON_FEATURES.healthV1],
      buildInfo: BUILD_INFO,
      inheritedPath: "/usr/bin:/bin",
    });
    let source: Awaited<ReturnType<typeof startRunServer>> | undefined;
    try {
      const destinationUrl = server.url.replace("http://blade:", "http://127.0.0.1:");
      source = await startRunServer({
        credentials: [
          {
            client_id: "operator_cli",
            credential_tier: "control_plane",
            verifier: hashConsumerApiBearer(sourceControlToken),
            verifier_env: "CALYX_CONSUMER_API_TEST_OLD_CARBON_CONTROL_VERIFIER",
            address_grants: { send_as: [], read: [] },
          },
        ],
        host: "127.0.0.1",
        hostname: () => "carbon",
        advertisedHost: "carbon",
        port: 0,
        service: new RunService({
          runsRoot: join(root, "old-carbon-runs"),
          messageOutbox: {
            enabled: true,
            state: { env: { ...process.env } },
            serverUrlForHost: (host) => {
              if (host !== "blade") throw new Error(`unexpected message target ${host}`);
              return destinationUrl;
            },
            tokenForHost: (host) => host === "blade" ? destinationInternalToken : undefined,
          },
        }),
        registryRoot: join(root, "old-carbon-registry"),
        stateStoreOptions: { env: { ...process.env } },
        messageHostAliases: { blade: "blade" },
        buildInfo: BUILD_INFO,
        inheritedPath: "/usr/bin:/bin",
      });
      const sourceUrl = source.url.replace("http://carbon:", "http://127.0.0.1:");
      const agentsInfraRoot = await writeRunServeTruths({
        carbon: "http://carbon.test:8740",
        blade: "http://blade.test:8740",
      });
      const program = buildProgram({
        runCli: {
          agentsInfraRoot,
          currentHostAlias: "carbon",
          tokenForHost: (host) => host === "carbon" ? sourceControlToken : destinationToken,
          createAdminClient: createRoutedAdminClientFactory({
            "carbon.test": sourceUrl,
            "blade.test": destinationUrl,
          }),
        },
      });
      await program.parseAsync([
        "node", "calyx", "msg", "send",
        "--to", "interactive:claude:ordinary-remote",
        "--host", "blade",
        "--subject", "Durable only",
        "--body", "keep this row",
        "--wake",
        "--json",
      ]);
      const sent = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        message: { status: string };
        wake: { delivery_state: string; wake_state: string; error_code: string };
      };
      expect(sent.message.status).toBe("outbox");
      expect(sent.wake).toMatchObject({
        delivery_state: "spooled",
        wake_state: "destination_unsupported",
        error_code: "missing_features",
      });
    } finally {
      await source?.close();
      await server.close();
    }
  });

  test("cross-host --wake preserves unknown live-delivery authority when the generated receipt is recoverable", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const requests: Array<{ url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = requestFrom(input, init);
      const url = request.url;
      const bodyText = request.method === "GET" || request.method === "HEAD"
        ? ""
        : await request.clone().text();
      requests.push({
        url,
        ...(bodyText ? { body: JSON.parse(bodyText) as unknown } : {}),
      });
      if (url.endsWith("/v1/admin/health")) {
        return new Response(JSON.stringify({
          schema_version: "calyx.admin-health/v1",
          protocol_epoch: 1,
          daemon_kind: "run-service",
          daemon_id: "blade-test",
          advertised_host: "blade",
          uptime_ms: 1,
          started_at: "2026-07-17T00:00:00.000Z",
          build: {
            git_head: BUILD_INFO.git_head,
            built_at: BUILD_INFO.built_at,
            package_version: BUILD_INFO.package_version,
          },
          active_runs: 0,
          maintenance_mode: false,
          supports_features: [CALYX_DAEMON_FEATURES.healthV1, CALYX_DAEMON_FEATURES.sessionWakeV1],
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
          },
        });
      }
      if (url.includes("/v1/admin/message-operations/") && url.endsWith("/forward")) {
        return new Response(JSON.stringify({
          schema_version: "calyx.message-operation/v1",
          operation_id: "mock-source-forward",
          target_host: "blade",
          status: "forwarded",
          terminal: true,
          attempt_count: 1,
          created_at: "2026-07-17T00:00:00.000Z",
          updated_at: "2026-07-17T00:00:01.000Z",
          receipt: {
            schema_version: "calyx.message-operation-receipt/v1",
            outcome: "forwarded",
            completed_at: "2026-07-17T00:00:01.000Z",
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
          },
        });
      }
      throw new Error("destination connection dropped");
    });
    const agentsInfraRoot = await writeRunServeTruths({
      carbon: "http://carbon-source.invalid:8740",
      blade: "http://blade.invalid:8740",
    });
    const program = buildProgram({
      runCli: {
        agentsInfraRoot,
        currentHostAlias: "carbon",
        tokenForHost: (host) => host === "carbon" ? "carbon-control-token" : "blade-control-token",
        createAdminClient: createAdminClientFactory(fetchImpl),
      },
    });
    await program.parseAsync([
      "node", "calyx", "msg", "send",
      "--to", "interactive:codex:remote-live",
      "--host", "blade",
      "--subject", "Transport partial",
      "--body", "durable content",
      "--wake",
      "--json",
    ]);
    const sent = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      message: { message_id: string; status: string };
      wake: { delivery_state: string; wake_state: string; error_code: string; first_command: string };
      delivery_notice: { code: string; delivery_state: string; wake: string; next_command: string };
    };
    expect(sent.message.status).toBe("outbox");
    expect(sent.wake, JSON.stringify(sent.wake)).toMatchObject({
      delivery_state: "spooled",
      wake_state: "delivery_indeterminate",
      error_code: "destination_transport_indeterminate",
      first_command: expect.stringMatching(/^calyx client replay /u),
    });
    expect(sent.delivery_notice).toMatchObject({
      code: "wake_delivery_indeterminate",
      delivery_state: "spooled",
      wake: "unknown",
      next_command: sent.wake.first_command,
    });
    const deliveryRequest = requests.find((request) => request.url.endsWith("/v1/admin/session-wakes/deliver"));
    expect(deliveryRequest?.body).toEqual({
      schema_version: "calyx.session-wake-deliver-request/v1",
      delivery_id: expect.stringMatching(/^session_wake_[0-9a-f]{64}$/u),
      recipient_activity_id: "interactive:codex:remote-live",
      pointer: { kind: "message", id: sent.message.message_id },
      created_at: expect.any(String),
    });
    expect(JSON.stringify(deliveryRequest?.body)).not.toContain("durable content");
    expect(requests.some((request) => (
      request.url.includes("carbon-source.invalid")
      && request.url.includes("/v1/admin/message-operations/")
      && request.url.endsWith("/forward")
    ))).toBe(true);
  });

  test("cross-host --wake preserves indeterminate destination admission and names the exact source operation", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const requests: Request[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = requestFrom(input, init);
      requests.push(request);
      if (request.method === "GET" && request.url.includes("/v1/admin/message-operations/")) {
        const outboxId = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1) ?? "");
        return new Response(JSON.stringify({
          schema_version: "calyx.message-operation/v1",
          operation_id: outboxId,
          message_locator: "/v1/message-text/local-message",
          target_host: "blade",
          status: "pending",
          terminal: false,
          attempt_count: 0,
          created_at: "2026-07-17T00:00:00.000Z",
          updated_at: "2026-07-17T00:00:00.000Z",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
          },
        });
      }
      if (request.url.includes("/v1/admin/message-operations/") && request.url.endsWith("/forward")) {
        throw new Error("response lost after dispatch");
      }
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    });
    const agentsInfraRoot = await writeRunServeTruths({
      carbon: "https://carbon-source.example:9443/calyx/control",
      blade: "https://blade.example:9443/calyx/control",
    });
    const program = buildProgram({
      runCli: {
        agentsInfraRoot,
        currentHostAlias: "carbon",
        tokenForHost: (host) => host === "carbon" ? "carbon-control-token" : "blade-control-token",
        createAdminClient: createAdminClientFactory(fetchImpl),
      },
    });

    await program.parseAsync([
      "node", "calyx", "msg", "send",
      "--to", "interactive:codex:remote-live",
      "--host", "blade",
      "--subject", "Indeterminate admission",
      "--body", "durable content",
      "--wake",
      "--json",
    ]);

    const sent = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      message: { message_id: string; status: string };
      outbox: { outbox_id: string; status: string };
      wake: {
        delivery_state: string;
        wake_state: string;
        error_code: string;
        first_command: string;
      };
      delivery_notice: {
        code: string;
        delivery_state: string;
        wake: string;
        next_command: string;
      };
    };
    const reconciliation = `calyx msg operation ${sent.outbox.outbox_id} --server-url https://carbon-source.example:9443/calyx/control --json`;
    expect(sent.message.status).toBe("outbox");
    expect(sent.outbox.status).toBe("pending");
    expect(sent.wake).toMatchObject({
      delivery_state: "outbox",
      wake_state: "message_forward_indeterminate",
      error_code: "destination_admission_indeterminate",
      first_command: reconciliation,
    });
    expect(sent.delivery_notice).toMatchObject({
      code: "message_forward_indeterminate",
      delivery_state: "outbox",
      wake: "not_attempted",
      next_command: reconciliation,
    });
    expect(sent.delivery_notice).not.toMatchObject({ code: "wake_not_delivered" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain(
      `https://carbon-source.example:9443/calyx/control/v1/admin/message-operations/${sent.outbox.outbox_id}/forward`,
    );

    await program.parseAsync([
      "node", "calyx", "msg", "operation", sent.outbox.outbox_id,
      "--server-url", "https://carbon-source.example:9443/calyx/control",
      "--auth-token", "carbon-control-token",
      "--json",
    ]);
    const observed = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      operation_id: string;
      status: string;
      terminal: boolean;
    };
    expect(observed).toMatchObject({
      schema_version: "calyx.message-operation/v1",
      operation_id: sent.outbox.outbox_id,
      status: "pending",
      terminal: false,
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe(
      `https://carbon-source.example:9443/calyx/control/v1/admin/message-operations/${sent.outbox.outbox_id}`,
    );
  });

  test("local msg operation purely projects elapsed attempt leases at the exact observation time", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const opened = await openStateStore();
    let terminalOutbox: ReturnType<typeof enqueueMessageOutbox>;
    let retryableOutbox: ReturnType<typeof enqueueMessageOutbox>;
    try {
      for (const row of [
        {
          messageId: "msg_local_operation_terminal",
          outboxExpiresAt: "2026-07-20T00:00:04.000Z",
          subject: "terminal exact local observation",
        },
        {
          messageId: "msg_local_operation_retryable",
          outboxExpiresAt: "2026-07-20T00:00:10.000Z",
          subject: "retryable exact local observation",
        },
      ]) {
        createMessage(opened.db, {
          message_id: row.messageId,
          sender: "interactive:codex:source-conductor",
          recipient_address: "role:reviewer@worm",
          recipient_class: "directed",
          recipient_host: "worm",
          subject: row.subject,
          status: "outbox",
          now: "2026-07-20T00:00:00.000Z",
        });
      }
      terminalOutbox = enqueueMessageOutbox(opened.db, {
        message_id: "msg_local_operation_terminal",
        target_host: "worm",
        expires_at: "2026-07-20T00:00:04.000Z",
        now: "2026-07-20T00:00:00.000Z",
      });
      retryableOutbox = enqueueMessageOutbox(opened.db, {
        message_id: "msg_local_operation_retryable",
        target_host: "worm",
        expires_at: "2026-07-20T00:00:10.000Z",
        now: "2026-07-20T00:00:00.000Z",
      });
      for (const row of [terminalOutbox, retryableOutbox]) {
        expect(claimMessageOutboxAttempt(opened.db, row.outbox_id, {
          attempt_id: `attempt-${row.outbox_id}`,
          attempt_ttl_ms: 1_000,
          now: "2026-07-20T00:00:01.000Z",
        })).toMatchObject({ status: "in_flight" });
      }
    } finally {
      opened.db.close();
    }

    const program = buildProgram({
      runCli: {
        currentHostAlias: "blade",
        now: () => new Date("2026-07-20T00:00:05.000Z"),
      },
    });
    await program.parseAsync(["node", "calyx", "msg", "operation", terminalOutbox.outbox_id, "--json"]);
    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
      operation_id: terminalOutbox.outbox_id,
      status: "indeterminate",
      terminal: true,
      updated_at: terminalOutbox.expires_at,
      receipt: {
        outcome: "indeterminate",
        completed_at: terminalOutbox.expires_at,
      },
    });

    await program.parseAsync(["node", "calyx", "msg", "operation", retryableOutbox.outbox_id, "--json"]);
    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
      operation_id: retryableOutbox.outbox_id,
      status: "pending",
      terminal: false,
      updated_at: "2026-07-20T00:00:02.000Z",
    });

    const afterReadProjection = await openStateStore();
    try {
      for (const row of [terminalOutbox, retryableOutbox]) {
        expect(readMessageOutbox(afterReadProjection.db, row.outbox_id)).toMatchObject({
          status: "in_flight",
          attempt_id: `attempt-${row.outbox_id}`,
          attempt_expires_at: "2026-07-20T00:00:02.000Z",
        });
      }
    } finally {
      afterReadProjection.db.close();
    }
  });

  test("--to-active idempotency is scoped per active target", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const now = "2026-06-12T00:00:00.000Z";
    const activityEntries: RunActivityEntry[] = [
      {
        entry_kind: "interactive_session",
        run_id: "interactive:codex:target-one",
        state: "interactive",
        summary: "Codex session target-one",
        created_at: now,
        updated_at: now,
        host: "localhost",
        backend: "codex",
        session_id: "target-one",
        session_path: join(root, "target-one.jsonl"),
        source: "codex_sessions",
      },
      {
        entry_kind: "interactive_session",
        run_id: "interactive:codex:target-two",
        state: "interactive",
        summary: "Codex session target-two",
        created_at: now,
        updated_at: now,
        host: "localhost",
        backend: "codex",
        session_id: "target-two",
        session_path: join(root, "target-two.jsonl"),
        source: "codex_sessions",
      },
    ];
    const fakeService = {
      listActivity: vi.fn(async () => activityEntries),
      listRuns: vi.fn(async () => []),
      getRunRecord: vi.fn(async () => undefined),
    };
    const program = buildProgram({
      runCli: {
        createRunService: () => fakeService as never,
      },
    });

    await program.parseAsync([
      "node",
      "calyx",
      "msg",
      "send",
      "--to-active",
      "host:local",
      "--subject",
      "Baton fanout",
      "--body",
      "continue",
      "--idempotency-key",
      "baton-once",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      mode: string;
      count: number;
      messages: Array<{ recipient_address: string; idempotency_key: string | null }>;
    };
    expect(payload).toMatchObject({ mode: "to_active", count: 2 });
    expect(payload.messages.map((message) => message.recipient_address)).toEqual([
      "interactive:codex:target-one",
      "interactive:codex:target-two",
    ]);
    expect(payload.messages.map((message) => message.idempotency_key)).toEqual([
      "baton-once:interactive:codex:target-one",
      "baton-once:interactive:codex:target-two",
    ]);

    const opened = await openStateStore();
    try {
      const rows = opened.db
        .prepare(`SELECT recipient_address, idempotency_key FROM messages ORDER BY recipient_address`)
        .all() as Array<{ recipient_address: string; idempotency_key: string | null }>;
      expect(rows).toEqual([
        {
          recipient_address: "interactive:codex:target-one",
          idempotency_key: "baton-once:interactive:codex:target-one",
        },
        {
          recipient_address: "interactive:codex:target-two",
          idempotency_key: "baton-once:interactive:codex:target-two",
        },
      ]);
    } finally {
      opened.db.close();
    }
  });

  test("--wake plus --to-active is rejected before session discovery or durable writes", async () => {
    const listActivity = vi.fn();
    const program = buildProgram({
      runCli: {
        createRunService: () => ({
          listActivity,
          listRuns: vi.fn(),
          getRunRecord: vi.fn(),
        }) as never,
      },
    });
    await expect(program.parseAsync([
      "node", "calyx", "msg", "send",
      "--to-active", "host:carbon",
      "--subject", "must not fan out",
      "--wake",
      "--json",
    ])).rejects.toThrow(/--wake cannot be combined with --to-active/);
    expect(listActivity).not.toHaveBeenCalled();
    const opened = await openStateStore();
    try {
      expect(opened.db.prepare(`SELECT COUNT(*) AS count FROM messages`).get()).toEqual({ count: 0 });
    } finally {
      opened.db.close();
    }
  });

  test("--to-active fleet fails loudly instead of silently querying only local sessions", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: { currentHostAlias: "blade" } });

    await expect(program.parseAsync([
      "node",
      "calyx",
      "msg",
      "send",
      "--to-active",
      "fleet",
      "--subject",
      "Baton fanout",
      "--body",
      "continue",
      "--json",
    ])).rejects.toThrow(/--to-active fleet is not supported/);
  });

  test("cross-host send submits to the source daemon and returns its durable outbox acceptance", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const operatorToken = "blade-operator-token";
    const registryRoot = join(root, "source-registry");
    await mkdir(registryRoot, { recursive: true });
    const source = await startRunServer({
      credentials: [{
        client_id: "operator_cli",
        credential_tier: "consumer",
        verifier: hashConsumerApiBearer(operatorToken),
        verifier_env: "CALYX_CONSUMER_API_TEST_BLADE_OPERATOR_VERIFIER",
        address_grants: {
          send_as: ["client:operator_cli@blade"],
          read: ["client:operator_cli@blade"],
        },
      }],
      host: "127.0.0.1",
      hostname: () => "blade",
      advertisedHost: "blade",
      port: 0,
      service: new RunService({ runsRoot: join(root, "source-runs") }),
      registryRoot,
      stateStoreOptions: { env: { ...process.env } },
      messageHostAliases: {
        carbon: "carbon",
        "carbon.example": "carbon",
      },
      buildInfo: BUILD_INFO,
      startedAt: "2026-07-14T00:00:00.000Z",
      inheritedPath: "/usr/bin:/bin",
    });
    try {
      const sourceUrl = source.url.replace("http://blade:", "http://127.0.0.1:");
      const agentsInfraRoot = await writeRunServeTruths({
        blade: sourceUrl,
        carbon: "http://carbon-target.invalid:9",
      });
      const tokenForHost = vi.fn((host: string) => {
        if (host === "blade") return operatorToken;
        throw new Error(`target credential must not be resolved: ${host}`);
      });
      const program = buildProgram({
        runCli: {
          agentsInfraRoot,
          currentHostAlias: "blade",
          tokenForHost,
        },
      });

      await program.parseAsync([
        "node", "calyx", "msg", "send",
        "--to", "client:target@carbon.example",
        "--subject", "Remote baton",
        "--body", "queue through blade",
        "--idempotency-key", "blade-to-carbon",
        "--json",
      ]);

      expect(tokenForHost).toHaveBeenCalledOnce();
      expect(tokenForHost).toHaveBeenCalledWith("blade");
      const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
      expect(payload).toMatchObject({
        inserted: true,
        message: {
          sender: "client:operator_cli@blade",
          recipient_address: "client:target@carbon",
          status: "outbox",
        },
        operation: {
          status: "accepted",
          locator: expect.stringMatching(/^\/v1\/message-operations\//),
        },
        outbox: {
          target_host: "carbon",
          status: "pending",
        },
        delivery_notice: {
          code: "sender_outbox_queued",
          delivery_state: "outbox",
        },
      });
      expect(payload).not.toHaveProperty("forwarded");

      const opened = await openStateStore();
      try {
        const stored = opened.db.prepare(
          "SELECT sender, recipient_address, recipient_host, status FROM messages",
        ).get() as Record<string, unknown>;
        expect(stored).toEqual({
          sender: "client:operator_cli@blade",
          recipient_address: "client:target@carbon",
          recipient_host: "carbon",
          status: "outbox",
        });
        const queued = opened.db.prepare(
          "SELECT target_host, status, attempt_count FROM outbox",
        ).get() as Record<string, unknown>;
        expect(queued).toEqual({ target_host: "carbon", status: "pending", attempt_count: 0 });
        const audit = opened.db.prepare(
          `SELECT operation_id, subject, asserted_actor, served_by_host, response_status
             FROM api_request_audit
            WHERE operation_id = 'msg.send'`,
        ).get() as Record<string, unknown>;
        expect(audit).toEqual({
          operation_id: "msg.send",
          subject: "operator_cli",
          asserted_actor: "interactive:codex:sender-session",
          served_by_host: "blade",
          response_status: 202,
        });
      } finally {
        opened.db.close();
      }
    } finally {
      await source.close();
    }
  });

  test("remote send never resolves a source-host token for an origin-rebound URL", async () => {
    const agentsInfraRoot = await writeRunServeTruth("blade", "https://blade.internal:8740");
    const tokenForHost = vi.fn(() => "ambient-operator-token");
    const fetchImpl = vi.fn();
    const program = buildProgram({
      runCli: {
        agentsInfraRoot,
        currentHostAlias: "blade",
        createAdminClient: createAdminClientFactory(fetchImpl),
        tokenForHost,
      },
    });
    const args = [
      "node", "calyx", "msg", "send",
      "--to", "client:target@remote",
      "--subject", "Authority boundary",
      "--server-url", "https://attacker.example:8740",
      "--json",
    ];

    await expect(program.parseAsync(args)).rejects.toThrow(/must match the configured source daemon endpoint/);
    expect(tokenForHost).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    const explicitFetch = vi.fn();
    const explicitProgram = buildProgram({
      runCli: {
        agentsInfraRoot,
        currentHostAlias: "blade",
        createAdminClient: createAdminClientFactory(explicitFetch),
        tokenForHost,
      },
    });
    await expect(explicitProgram.parseAsync([
      ...args.slice(0, -1),
      "--auth-token", "caller-token",
      "--sender", "client:operator_cli@blade",
      "--json",
    ])).rejects.toThrow(/must match the configured source daemon endpoint/);
    expect(tokenForHost).not.toHaveBeenCalled();
    expect(explicitFetch).not.toHaveBeenCalled();
  });

  test("remote send replays exact bytes after an interrupted response body", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = requestFrom(input, init);
      bodies.push(await request.clone().text());
      if (bodies.length === 1) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.error(new Error("response body lost after commit"));
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
          },
        });
      }
      return new Response(JSON.stringify({
        schema_version: "calyx.msg-send-result/v1",
        inserted: false,
        delivery_state: "outbox",
        message: {
          schema_version: "calyx.message-observation/v1",
          message_id: "remote-replay-message",
          sender: "client:operator_cli@blade",
          recipient_address: "client:target@remote",
          recipient_class: "directed",
          subject: "Replay-safe baton",
          body: "",
          body_truncated: false,
          body_total_chars: 0,
          body_locator: "/v1/message-text/remote-replay-message",
          urgency: "normal",
          ack_required: false,
          status: "outbox",
          created_at: "2026-07-13T00:00:00.000Z",
          updated_at: "2026-07-13T00:00:00.000Z",
        },
        operation: {
          status: "accepted",
          locator: "/v1/message-operations/remote-replay-outbox",
          receipt_locator: "/v1/message-operations/remote-replay-outbox",
        },
        outbox: {
          outbox_id: "remote-replay-outbox",
          target_host: "remote",
          status: "pending",
          created_at: "2026-07-13T00:00:00.000Z",
          expires_at: "2026-07-16T00:00:00.000Z",
        },
      }), {
        status: 202,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
        },
      });
    });
    const program = buildProgram({
      runCli: {
        currentHostAlias: "blade",
        createAdminClient: createAdminClientFactory(fetchImpl),
        tokenForHost: () => "operator-token",
      },
    });

    await program.parseAsync([
      "node", "calyx", "msg", "send",
      "--to", "client:target@remote",
      "--subject", "Replay-safe baton",
      "--server-url", "http://blade:8740",
      "--auth-token", "operator-token",
      "--sender", "client:operator_cli@blade",
      "--json",
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toBe(bodies[0]);
    const body = JSON.parse(bodies[0]!) as { idempotency_key: string };
    expect(body.idempotency_key).toMatch(/^cli-msg:/);
  });

  test("remote send emits the generated key in an indeterminate receipt after bounded recovery", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = requestFrom(input, init);
      bodies.push(await request.clone().text());
      throw new Error("response lost after commit");
    });
    const custody = await openClientRecoveryCustody();
    const program = buildProgram({
      runCli: {
        currentHostAlias: "blade",
        createAdminClient: createAdminClientFactory(fetchImpl),
        openRecoveryCustody: async () => custody,
        tokenForHost: () => "operator-token",
      },
    });

    let thrown: unknown;
    try {
      await program.parseAsync([
        "node", "calyx", "msg", "send",
        "--to", "client:target@remote",
        "--subject", "Receipt-safe baton",
        "--ttl-ms", "60000",
        "--server-url", "http://blade:8740",
        "--auth-token", "operator-token",
        "--sender", "client:operator_cli@blade",
        "--json",
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(new Set(bodies).size).toBe(1);
    const generatedKey = (JSON.parse(bodies[0]!) as { idempotency_key: string }).idempotency_key;
    expect(generatedKey).toMatch(/^cli-msg:/);
    expect(String((thrown as Error).message)).toContain("calyx.client-indeterminate-result/v1");
    expect(String((thrown as Error).message)).toContain("calyx msg send --replay-request");

    const [artifactName] = await readdir(custody.receiptsRoot);
    const artifactPath = join(custody.receiptsRoot, artifactName!);
    expect((await stat(artifactPath)).mode & 0o777).toBe(0o600);
    const envelope = JSON.parse(await readFile(artifactPath, "utf8")) as {
      schema_version: string;
      encryption_algorithm: string;
      ciphertext: string;
    };
    expect(envelope).toMatchObject({
      schema_version: "calyx.client-recovery-envelope/v1",
      encryption_algorithm: "AES-256-GCM",
      ciphertext: expect.any(String),
    });
    expect(JSON.stringify(envelope)).not.toContain("Receipt-safe baton");
    const receipt = await custody.readReceipt(artifactPath);
    const receiptBody = Buffer.from(receipt.body_bytes, "base64").toString("utf8");
    expect(receipt).toMatchObject({
      schema_version: "calyx.client-indeterminate-result/v1",
      operation_id: "msg.send",
      idempotency_key: generatedKey,
    });
    expect(Object.keys(receipt.safe_headers).map((key) => key.toLowerCase())).not.toContain("authorization");
    expect(receiptBody).toBe(bodies[0]);
    expect(JSON.parse(receiptBody)).toMatchObject({
      idempotency_key: generatedKey,
      expires_at: expect.stringMatching(/^20/),
    });

    const replayBodies: string[] = [];
    const replayFetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = requestFrom(input, init);
      replayBodies.push(await request.clone().text());
      return new Response(JSON.stringify({
        schema_version: "calyx.msg-send-result/v1",
        inserted: false,
        delivery_state: "outbox",
        message: {
          schema_version: "calyx.message-observation/v1",
          message_id: "remote-recovery-message",
          sender: "client:operator_cli@blade",
          recipient_address: "client:target@remote",
          recipient_class: "directed",
          subject: "Receipt-safe baton",
          body: "",
          body_truncated: false,
          body_total_chars: 0,
          body_locator: "/v1/message-text/remote-recovery-message",
          urgency: "normal",
          ack_required: false,
          expires_at: (JSON.parse(receiptBody) as { expires_at: string }).expires_at,
          status: "outbox",
          created_at: "2026-07-14T00:00:00.000Z",
          updated_at: "2026-07-14T00:00:00.000Z",
        },
        operation: {
          status: "accepted",
          locator: "/v1/message-operations/remote-recovery-outbox",
          receipt_locator: "/v1/message-operations/remote-recovery-outbox",
        },
        outbox: {
          outbox_id: "remote-recovery-outbox",
          target_host: "remote",
          status: "pending",
          created_at: "2026-07-14T00:00:00.000Z",
          expires_at: "2026-07-17T00:00:00.000Z",
        },
      }), {
        status: 202,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
        },
      });
    });
    const replayProgram = buildProgram({
      runCli: {
        currentHostAlias: "blade",
        createAdminClient: createAdminClientFactory(replayFetch),
        openRecoveryCustody: async () => custody,
        tokenForHost: () => "operator-token",
      },
    });
    await replayProgram.parseAsync([
      "node", "calyx", "msg", "send",
      "--replay-request", artifactPath,
      "--auth-token", "operator-token",
      "--json",
    ]);
    expect(replayBodies).toEqual([receiptBody]);
    await expect(stat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("remote consumer failure is loud and leaves no sender outbox side door", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("injected ambiguous transport failure");
    });
    const program = buildProgram({
      runCli: {
        currentHostAlias: "blade",
        createAdminClient: createAdminClientFactory(fetchImpl),
      },
    });

    await expect(program.parseAsync([
      "node",
      "calyx",
      "msg",
      "send",
      "--to",
      "client:target@remote",
      "--subject",
      "Remote baton",
      "--body",
      "try target daemon",
      "--server-url",
      "http://blade:8740",
      "--auth-token",
      "test-token",
      "--sender",
      "client:operator_cli@blade",
      "--json",
    ])).rejects.toThrow(/indeterminate_result[\s\S]*calyx msg send --replay-request/);
    expect(fetchImpl).toHaveBeenCalled();

    const opened = await openStateStore();
    try {
      const rows = opened.db
        .prepare(`SELECT message_id, status FROM messages WHERE recipient_host = 'remote'`)
        .all() as Array<{ message_id: string; status: string }>;
      expect(rows).toHaveLength(0);
      const outboxCount = opened.db.prepare(`SELECT COUNT(*) AS count FROM outbox`).get() as { count: number };
      expect(outboxCount.count).toBe(0);
    } finally {
      opened.db.close();
    }
  });

  test("bare remote execution-capable recipients queue authenticated outbox delivery without waking", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const tokenForHost = vi.fn(() => "operator-token");
    for (const recipientAddress of [
      "interactive:codex:remote-session",
      "codex:remote:remote-session",
    ]) {
      const program = buildProgram({
        runCli: { currentHostAlias: "blade", tokenForHost },
      });
      await program.parseAsync([
        "node", "calyx", "msg", "send",
        "--to", recipientAddress,
        "--host", "remote",
        "--subject", "Do work",
        "--json",
      ]);
      const sent = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        message: { status: string; acked_at: string | null };
        delivery_notice: { wake: string; delivery_state: string };
      };
      expect(sent.message).toMatchObject({ status: "outbox", acked_at: null });
      expect(sent.delivery_notice).toMatchObject({ wake: "not_applicable", delivery_state: "outbox" });
    }

    const opened = await openStateStore();
    try {
      const messageCount = opened.db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number };
      const outboxCount = opened.db.prepare(`SELECT COUNT(*) AS count FROM outbox`).get() as { count: number };
      expect(messageCount.count).toBe(2);
      expect(outboxCount.count).toBe(2);
      expect(tokenForHost).not.toHaveBeenCalled();
    } finally {
      opened.db.close();
    }
  });

  test("explicit remote bearer requires an explicit grant-compatible client sender", async () => {
    const program = buildProgram({ runCli: { currentHostAlias: "blade" } });
    await expect(program.parseAsync([
      "node",
      "calyx",
      "msg",
      "send",
      "--to",
      "client:target@remote",
      "--subject",
      "Remote note",
      "--server-url",
      "http://blade:8740",
      "--auth-token",
      "opaque-token",
      "--json",
    ])).rejects.toThrow(/requires --sender client:<client-id>@<source-host>/);

    await expect(program.parseAsync([
      "node",
      "calyx",
      "msg",
      "send",
      "--to",
      "client:target@remote",
      "--subject",
      "Remote note",
      "--server-url",
      "http://blade:8740",
      "--auth-token",
      "opaque-token",
      "--sender",
      "client:operator_cli@carbon",
      "--json",
    ])).rejects.toThrow(/requires --sender client:<client-id>@<source-host>/);
  });

  test("explicit bearer client reply addresses are not misreported as asserted actors", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = requestFrom(input, init);
      const headers = request.headers;
      expect(headers.get("authorization")).toBe("Bearer opaque-token");
      expect(headers.get("X-Calyx-Asserted-Actor")).toBeNull();
      expect(JSON.parse(await request.clone().text())).toMatchObject({
        reply_address: "client:operator_cli@blade",
      });
      return new Response(JSON.stringify({
        schema_version: "calyx.msg-send-result/v1",
        inserted: true,
        delivery_state: "outbox",
        message: {
          schema_version: "calyx.message-observation/v1",
          message_id: "explicit-token-message",
          sender: "client:operator_cli@blade",
          recipient_address: "client:target@remote",
          recipient_class: "directed",
          subject: "Remote note",
          body: "",
          body_truncated: false,
          body_total_chars: 0,
          body_locator: "/v1/message-text/explicit-token-message",
          urgency: "normal",
          ack_required: false,
          status: "outbox",
          created_at: "2026-07-13T00:00:00.000Z",
          updated_at: "2026-07-13T00:00:00.000Z",
        },
        operation: {
          status: "accepted",
          locator: "/v1/message-operations/explicit-token-outbox",
          receipt_locator: "/v1/message-operations/explicit-token-outbox",
        },
        outbox: {
          outbox_id: "explicit-token-outbox",
          target_host: "remote",
          status: "pending",
          created_at: "2026-07-13T00:00:00.000Z",
          expires_at: "2026-07-16T00:00:00.000Z",
        },
      }), {
        status: 202,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
        },
      });
    });
    const program = buildProgram({
      runCli: { currentHostAlias: "blade", createAdminClient: createAdminClientFactory(fetchImpl) },
    });
    await program.parseAsync([
      "node", "calyx", "msg", "send",
      "--to", "client:target@remote",
      "--subject", "Remote note",
      "--server-url", "http://blade:8740",
      "--auth-token", "opaque-token",
      "--sender", "client:operator_cli@blade",
      "--json",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
      operation: { status: "accepted" },
      outbox: { target_host: "remote", status: "pending" },
      delivery_notice: { code: "sender_outbox_queued", delivery_state: "outbox" },
    });
  });
});
