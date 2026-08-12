import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createCalyxAdminClient } from "@polli-labs/calyx-client/admin";

import {
  CALYX_DAEMON_FEATURES,
  applyStateMigrations,
  hashConsumerApiBearer,
  completeMonitorDelivery,
  createMonitor,
  createMonitorWake,
  createMonitorDeliveryAttempt,
  evaluatePredicateV1,
  listMonitors,
  monitorDeliveryBindings,
  openStateStore,
  readMonitor,
  readMonitorWake,
  recordMonitorEvaluation,
  runnerSupervisionPredicate,
} from "@polli-labs/calyx-core";
import type { RunRecord } from "@polli-labs/calyx-run-service";
import { RunService } from "./support/test-run-service.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { startRunServer } from "@polli-labs/calyx-server";

import { buildProgram, type RunCliDependencies } from "../run-cli";

function createAdminClientFactory(fetchImpl: typeof fetch): typeof createCalyxAdminClient {
  return (options) => createCalyxAdminClient({
    ...options,
    fetch: fetchImpl,
  });
}

async function requestBodyText(body: RequestInit["body"]): Promise<string> {
  return new Response(body ?? null).text();
}

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB", "CALYX_DISABLE_OTEL", "CALYX_ACTIVITY_ID"] as const;
const LOCAL_RUN_IDS = [
  "run-cli-monitor-1",
  "run-cli-monitor-2",
  "run-cli-monitor-delivery",
  "run-cli-monitor-tier2",
];

const BUILD_INFO = {
  schema_version: "build-info/v1" as const,
  git_head: "monitor-test-sha",
  built_at: "2026-06-12T00:00:00.000Z",
  package_version: "0.2.0",
  branch: "main",
  dirty: false,
};

function buildMonitorProgram(
  knownRunIds: readonly string[] = LOCAL_RUN_IDS,
  deps: Omit<RunCliDependencies, "createRunService"> = {},
) {
  const known = new Set(knownRunIds);
  return buildProgram({
    runCli: {
      ...deps,
      createRunService: () => ({
        getRunRecord: async (runId: string) => known.has(runId)
          ? ({ run_id: runId } as RunRecord)
          : undefined,
      } as unknown as RunService),
    },
  });
}

async function listMonitorRowsForState(stateHome: string) {
  const opened = await openStateStore({ env: { ...process.env, CALYX_STATE_HOME: stateHome } });
  try {
    return listMonitors(opened.db, { status: "all" });
  } finally {
    opened.db.close();
  }
}

async function startRemoteMonitorServer(options: {
  remoteRoot: string;
  runIds?: readonly string[];
  supportsRemote?: boolean;
  supportsClaim?: boolean;
}) {
  const remoteStateHome = join(options.remoteRoot, "state");
  await applyStateMigrations({ storeOptions: { env: { ...process.env, CALYX_STATE_HOME: remoteStateHome } } });
  const service = new RunService({ runsRoot: join(options.remoteRoot, "runs") });
  for (const runId of options.runIds ?? []) {
    await service.initializeRun(service.createIntent({
      run_id: runId,
      host: "remote",
      prompt: `Remote run ${runId}`,
      require_execplan: false,
    }));
  }
  const registryRoot = join(options.remoteRoot, "registry");
  await mkdir(registryRoot, { recursive: true });
  const supportedFeatures = options.supportsRemote === false
    ? [CALYX_DAEMON_FEATURES.healthV1]
    : [
        CALYX_DAEMON_FEATURES.healthV1,
        CALYX_DAEMON_FEATURES.monitorRemoteV1,
        ...(options.supportsClaim === false ? [] : [CALYX_DAEMON_FEATURES.monitorClaimV1]),
      ];
  const handle = await startRunServer({
    credentials: [{
      client_id: "test-control-plane",
      credential_tier: "control_plane",
      verifier: hashConsumerApiBearer("remote-secret"),
      verifier_env: "CALYX_CONSUMER_API_TEST_CONTROL_PLANE_VERIFIER",
      address_grants: { send_as: ["client:test-control-plane@blade"], read: ["run:*"] },
    }],
    host: "127.0.0.1",
    advertisedHost: "remote",
    port: 0,
    service,
    registryRoot,
    buildInfo: BUILD_INFO,
    startedAt: "2026-06-12T00:00:00.000Z",
    inheritedPath: "/mock/bin:/usr/bin",
    supportsFeatures: supportedFeatures,
    stateStoreOptions: { env: { ...process.env, CALYX_STATE_HOME: remoteStateHome } },
  });
  return {
    handle,
    remoteStateHome,
    serverUrl: handle.url.replace("http://remote:", "http://127.0.0.1:"),
  };
}

const LOCAL_TEST_HOST = hostname().split(".")[0]?.toLowerCase() ?? "localhost";

describe("monitor command", () => {
  let root: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
      CALYX_DISABLE_OTEL: process.env["CALYX_DISABLE_OTEL"],
      CALYX_ACTIVITY_ID: process.env["CALYX_ACTIVITY_ID"],
    };
    for (const key of ENV_KEYS) delete process.env[key];
    root = await mkdtemp(join(tmpdir(), "calyx-monitor-command-"));
    process.env["CALYX_STATE_HOME"] = join(root, "state");
    process.env["CALYX_DISABLE_OTEL"] = "1";
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

  test("create and list runner-supervision monitors", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildMonitorProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "monitor",
      "create",
      "--preset",
      "runner-supervision",
      "--run",
      "run-cli-monitor-1",
      "--assigned-host",
      LOCAL_TEST_HOST,
      "--json",
    ]);

    const created = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      monitor: { monitor_id: string; source_run_id: string; create_provenance: string; rearm_policy: string };
    };
    expect(created.schema_version).toBe("calyx.monitor-create/v1");
    expect(created.monitor).toMatchObject({
      source_run_id: "run-cli-monitor-1",
      create_provenance: "operator",
      rearm_policy: "every_change",
    });

    await program.parseAsync(["node", "calyx", "monitor", "list", "--json"]);
    const listed = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      count: number;
      monitors: Array<{ monitor_id: string }>;
    };
    expect(listed.schema_version).toBe("calyx.monitor-list/v1");
    expect(listed.count).toBe(1);
    expect(listed.monitors[0]?.monitor_id).toBe(created.monitor.monitor_id);
  });

  test("default create owner is drained and acknowledged by the default activity identity", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const defaultOwner = "interactive:codex:cli-default-monitor-owner";
    process.env["CALYX_ACTIVITY_ID"] = defaultOwner;
    const program = buildMonitorProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "monitor",
      "create",
      "--preset",
      "runner-supervision",
      "--run",
      "run-cli-monitor-2",
      "--assigned-host",
      LOCAL_TEST_HOST,
      "--json",
    ]);
    const created = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      monitor: { monitor_id: string; owner: string };
    };
    expect(created.monitor.owner).toBe(defaultOwner);

    const opened = await openStateStore();
    let wakeId = "";
    try {
      const monitor = readMonitor(opened.db, created.monitor.monitor_id);
      expect(monitor).toBeTruthy();
      const evaluation = await evaluatePredicateV1(monitor!.predicate, {
        now: () => new Date("2026-06-11T02:00:00.000Z"),
        readRun: () => ({
          run_id: "run-cli-monitor-2",
          state: "succeeded",
          updated_at: "2026-06-11T02:00:00.000Z",
          completed_at: "2026-06-11T02:00:00.000Z",
        }),
      });
      const updated = recordMonitorEvaluation(opened.db, monitor!.monitor_id, evaluation);
      const wake = createMonitorWake(opened.db, {
        monitor: updated!,
        evaluation,
        suggested_commands: ["calyx monitor inbox --json"],
        created_at: evaluation.evaluated_at,
      });
      wakeId = wake.wake.wake_id;
    } finally {
      opened.db.close();
    }

    await program.parseAsync(["node", "calyx", "monitor", "inbox", "--peek", "--json"]);
    const peeked = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      count: number;
      wakes: Array<{ wake_id: string; status: string }>;
    };
    expect(peeked.wakes[0]).toMatchObject({ wake_id: wakeId, status: "pending" });
    await expect(program.parseAsync(["node", "calyx", "monitor", "ack", wakeId, "--json"]))
      .rejects.toThrow(/monitor_wake_not_claimed/);

    await program.parseAsync(["node", "calyx", "monitor", "inbox", "--json"]);
    const inbox = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      count: number;
      wakes: Array<{ wake_id: string; status: string }>;
    };
    expect(inbox.count).toBe(1);
    expect(inbox.wakes[0]).toMatchObject({ wake_id: wakeId, status: "claimed" });

    await program.parseAsync([
      "node", "calyx", "monitor", "inbox", "--claimed-by", "interactive:codex:other", "--json",
    ]);
    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({ count: 0, wakes: [] });

    await expect(program.parseAsync([
      "node", "calyx", "monitor", "ack", wakeId,
      "--acked-by", "interactive:codex:other", "--json",
    ])).rejects.toThrow(/monitor_wake_claimant_mismatch/);
    await program.parseAsync(["node", "calyx", "monitor", "ack", wakeId, "--json"]);
    const ack = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      changed: boolean;
      wake: { wake_id: string; status: string; acked_by: string };
    };
    expect(ack.changed).toBe(true);
    expect(ack.wake).toMatchObject({ wake_id: wakeId, status: "acked", acked_by: defaultOwner });
  });

  test("explicit delivery bindings and delivery state appear in show and doctor", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildMonitorProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "monitor",
      "create",
      "--preset",
      "runner-supervision",
      "--run",
      "run-cli-monitor-delivery",
      "--assigned-host",
      LOCAL_TEST_HOST,
      "--no-default-deliveries",
      "--deliver",
      "ntfy,materiality=always,topic=scratch",
      "--json",
    ]);

    const created = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      monitor: {
        monitor_id: string;
        delivery: { bindings: Array<{ binding_id: string; adapter: string; materiality: { kind: string } }> };
      };
    };
    expect(created.monitor.delivery.bindings[0]).toMatchObject({
      adapter: "ntfy",
      materiality: { kind: "always" },
    });

    const opened = await openStateStore();
    try {
      const monitor = readMonitor(opened.db, created.monitor.monitor_id);
      expect(monitor).toBeTruthy();
      const evaluation = await evaluatePredicateV1(monitor!.predicate, {
        now: () => new Date("2026-06-11T03:00:00.000Z"),
        readRun: () => ({
          run_id: "run-cli-monitor-delivery",
          state: "succeeded",
          updated_at: "2026-06-11T03:00:00.000Z",
          completed_at: "2026-06-11T03:00:00.000Z",
        }),
      });
      const updated = recordMonitorEvaluation(opened.db, monitor!.monitor_id, evaluation);
      const wake = createMonitorWake(opened.db, {
        monitor: updated!,
        evaluation,
        suggested_commands: ["calyx monitor inbox --json"],
        created_at: evaluation.evaluated_at,
      }).wake;
      const binding = monitorDeliveryBindings(monitor!.delivery)[0]!;
      const attempt = createMonitorDeliveryAttempt(opened.db, {
        wake,
        binding,
        attempted_at: "2026-06-11T03:00:01.000Z",
        target: { topic: "scratch" },
      });
      completeMonitorDelivery(opened.db, {
        delivery_id: attempt.delivery.delivery_id,
        status: "delivered",
        completed_at: "2026-06-11T03:00:02.000Z",
        evidence: { http_status: 200 },
      });
    } finally {
      opened.db.close();
    }

    await program.parseAsync(["node", "calyx", "monitor", "show", created.monitor.monitor_id, "--json"]);
    const shown = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      delivery_state: { count: number; counts: { delivered: number } };
    };
    expect(shown.delivery_state).toMatchObject({ count: 1, counts: { delivered: 1 } });

    await program.parseAsync(["node", "calyx", "monitor", "doctor", "--json"]);
    const doctor = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      monitors: { deliveryCount: number; deliveryCounts: { delivered: number } };
    };
    expect(doctor.monitors.deliveryCount).toBe(1);
    expect(doctor.monitors.deliveryCounts.delivered).toBe(1);
  });

  test("parses Tier-2 harness bridge delivery bindings", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildMonitorProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "monitor",
      "create",
      "--preset",
      "runner-supervision",
      "--run",
      "run-cli-monitor-tier2",
      "--assigned-host",
      LOCAL_TEST_HOST,
      "--no-default-deliveries",
      "--deliver",
      "codex_automation,materiality=always,thread=019e7637-f599-7811-a4c1-c2edc6297666,dry_run=true",
      "--deliver",
      "claude_reinvoke,materiality=always,session=session-123,cwd=/tmp/calyx,dry_run=true,allowed_tools=Bash(calyx monitor inbox --json)|Bash(calyx monitor ack *)",
      "--deliver",
      "codex_app_server_steer,materiality=always,run=run-cli-monitor-tier2,timeout_ms=2000,dry_run=true",
      "--deliver",
      "claude_channel,materiality=always,channel=server:calyx-monitor,url=http://127.0.0.1:8788/calyx/monitor-wake,token_env=CALYX_MONITOR_CLAUDE_CHANNEL_TOKEN,dry_run=true",
      "--json",
    ]);

    const created = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      monitor: {
        delivery: {
          bindings: Array<{
            adapter: string;
            codex_automation?: { thread_id?: string; dry_run?: boolean };
            codex_app_server_steer?: { run_id?: string; timeout_ms?: number; dry_run?: boolean };
            claude_reinvoke?: { session_id?: string; dry_run?: boolean; allowed_tools?: string[] };
            claude_channel?: { receiver_url?: string; channel?: string; token_env?: string; dry_run?: boolean };
          }>;
        };
      };
    };
    expect(created.monitor.delivery.bindings.map((binding) => binding.adapter)).toEqual([
      "codex_automation",
      "claude_reinvoke",
      "codex_app_server_steer",
      "claude_channel",
    ]);
    expect(created.monitor.delivery.bindings[0]?.codex_automation).toMatchObject({
      thread_id: "019e7637-f599-7811-a4c1-c2edc6297666",
      dry_run: true,
    });
    expect(created.monitor.delivery.bindings[1]?.claude_reinvoke).toMatchObject({
      session_id: "session-123",
      dry_run: true,
      allowed_tools: [
        "Bash(calyx monitor inbox --json)",
        "Bash(calyx monitor ack *)",
      ],
    });
    expect(created.monitor.delivery.bindings[2]?.codex_app_server_steer).toMatchObject({
      run_id: "run-cli-monitor-tier2",
      timeout_ms: 2_000,
      dry_run: true,
    });
    expect(created.monitor.delivery.bindings[3]?.claude_channel).toMatchObject({
      receiver_url: "http://127.0.0.1:8788/calyx/monitor-wake",
      channel: "server:calyx-monitor",
      token_env: "CALYX_MONITOR_CLAUDE_CHANNEL_TOKEN",
      dry_run: true,
    });
  });

  test("proxied create writes only to the recipient host store and --host drains wakes", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const remoteRoot = await mkdtemp(join(root, "remote-"));
    const remote = await startRemoteMonitorServer({
      remoteRoot,
      runIds: ["remote-run-1"],
    });
    let claimAttempts = 0;
    const claimBodies: string[] = [];
    let ackAttempts = 0;
    let cancelAttempts = 0;
    const wakeReadUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/admin/monitors/wakes" && (init?.method ?? "GET") === "GET") {
        wakeReadUrls.push(url.href);
      }
      if (url.pathname === "/v1/admin/monitors/wakes" && init?.method === "POST") {
        claimAttempts += 1;
        claimBodies.push(await requestBodyText(init.body));
        const response = await fetch(input, init);
        if (claimAttempts === 1) {
          await response.arrayBuffer();
          throw new Error("connection lost after committed monitor claim");
        }
        return response;
      }
      if (/^\/v1\/admin\/monitors\/wakes\/[^/]+\/ack$/.test(url.pathname) && init?.method === "POST") {
        ackAttempts += 1;
        const response = await fetch(input, init);
        await response.arrayBuffer();
        throw new Error("connection lost after committed monitor acknowledgement");
      }
      if (/^\/v1\/admin\/monitors\/[^/]+\/cancel$/.test(url.pathname) && init?.method === "POST") {
        cancelAttempts += 1;
        const response = await fetch(input, init);
        await response.arrayBuffer();
        throw new Error("connection lost after committed monitor cancellation");
      }
      return fetch(input, init);
    });
    const program = buildMonitorProgram([], {
      agentsInfraRoot: join(root, "empty-agents"),
      createAdminClient: createAdminClientFactory(fetchImpl),
    });

    try {
      await program.parseAsync([
        "node",
        "calyx",
        "monitor",
        "create",
        "--preset",
        "runner-supervision",
        "--run",
        "remote-run-1",
        "--assigned-host",
        "remote",
        "--owner",
        "operator",
        "--server-url",
        remote.serverUrl,
        "--auth-token",
        "remote-secret",
        "--json",
      ]);

      const created = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        owner_host: string;
        note: string;
        monitor: { monitor_id: string; assigned_host: string; source_run_id: string };
      };
      expect(created.owner_host).toBe("remote");
      expect(created.note).toContain("inspect with --host remote");
      expect(created.monitor).toMatchObject({
        assigned_host: "remote",
        source_run_id: "remote-run-1",
      });
      expect(await listMonitorRowsForState(process.env["CALYX_STATE_HOME"]!)).toHaveLength(0);
      expect(await listMonitorRowsForState(remote.remoteStateHome)).toHaveLength(1);

      const opened = await openStateStore({ env: { ...process.env, CALYX_STATE_HOME: remote.remoteStateHome } });
      let wakeId = "";
      try {
        const monitor = readMonitor(opened.db, created.monitor.monitor_id);
        expect(monitor).toBeTruthy();
        const evaluation = await evaluatePredicateV1(monitor!.predicate, {
          now: () => new Date("2026-06-12T04:00:00.000Z"),
          readRun: () => ({
            run_id: "remote-run-1",
            state: "succeeded",
            updated_at: "2026-06-12T04:00:00.000Z",
            completed_at: "2026-06-12T04:00:00.000Z",
          }),
        });
        const updated = recordMonitorEvaluation(opened.db, monitor!.monitor_id, evaluation);
        wakeId = createMonitorWake(opened.db, {
          monitor: updated!,
          evaluation,
          suggested_commands: ["calyx monitor inbox --host remote --json"],
          created_at: evaluation.evaluated_at,
        }).wake.wake_id;
      } finally {
        opened.db.close();
      }

      await program.parseAsync([
        "node",
        "calyx",
        "monitor",
        "list",
        "--host",
        "remote",
        "--server-url",
        remote.serverUrl,
        "--auth-token",
        "remote-secret",
        "--json",
      ]);
      const listed = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        owner_host: string;
        count: number;
        monitors: Array<{ monitor_id: string }>;
      };
      expect(listed.owner_host).toBe("remote");
      expect(listed.count).toBe(1);
      expect(listed.monitors[0]?.monitor_id).toBe(created.monitor.monitor_id);

      await program.parseAsync([
        "node",
        "calyx",
        "monitor",
        "inbox",
        "--host",
        "remote",
        "--server-url",
        remote.serverUrl,
        "--auth-token",
        "remote-secret",
        "--claimed-by",
        "operator",
        "--json",
      ]);
      const inbox = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        count: number;
        wakes: Array<{ wake_id: string; status: string }>;
      };
      expect(inbox.count).toBe(1);
      expect(inbox.wakes[0]).toMatchObject({ wake_id: wakeId, status: "claimed" });
      expect(claimAttempts).toBe(2);
      expect(claimBodies[1]).toBe(claimBodies[0]);
      expect(JSON.parse(claimBodies[0]!)).toMatchObject({
        idempotency_key: expect.stringMatching(/^monitor-claim:/u),
        claimed_by: "operator",
      });

      const claimedStore = await openStateStore({ env: { ...process.env, CALYX_STATE_HOME: remote.remoteStateHome } });
      try {
        expect(readMonitorWake(claimedStore.db, wakeId)).toMatchObject({
          status: "claimed",
          claimed_by: "operator",
          claimed_until: expect.any(String),
        });
      } finally {
        claimedStore.db.close();
      }

      await expect(program.parseAsync([
        "node",
        "calyx",
        "monitor",
        "ack",
        wakeId,
        "--host",
        "remote",
        "--server-url",
        remote.serverUrl,
        "--auth-token",
        "remote-secret",
        "--acked-by",
        "operator",
        "--json",
      ])).rejects.toThrow(
        new RegExp(`admin\\.monitor\\.ack[\\s\\S]*Do not repeat[\\s\\S]*calyx monitor inbox --wake-id ${wakeId} --peek --server-url ${remote.serverUrl} --json[\\s\\S]*inconclusive`),
      );
      expect(ackAttempts).toBe(1);

      const ackedStore = await openStateStore({ env: { ...process.env, CALYX_STATE_HOME: remote.remoteStateHome } });
      try {
        expect(readMonitorWake(ackedStore.db, wakeId)).toMatchObject({
          status: "acked",
          acked_by: "operator",
        });
      } finally {
        ackedStore.db.close();
      }

      await program.parseAsync([
        "node", "calyx", "monitor", "inbox",
        "--host", "remote",
        "--server-url", remote.serverUrl,
        "--auth-token", "remote-secret",
        "--wake-id", wakeId,
        "--peek",
        "--json",
      ]);
      expect(wakeReadUrls.at(-1)).toBe(
        `${remote.serverUrl}/v1/admin/monitors/wakes?wake_id=${encodeURIComponent(wakeId)}`,
      );
      expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
        count: 1,
        wakes: [{ wake_id: wakeId, status: "acked", acked_by: "operator" }],
      });

      await expect(program.parseAsync([
        "node", "calyx", "monitor", "cancel", created.monitor.monitor_id,
        "--host", "remote",
        "--server-url", remote.serverUrl,
        "--auth-token", "remote-secret",
        "--json",
      ])).rejects.toThrow(
        new RegExp(`admin\\.monitor\\.cancel[\\s\\S]*Do not repeat[\\s\\S]*calyx monitor show ${created.monitor.monitor_id} --server-url ${remote.serverUrl} --json[\\s\\S]*inconclusive`),
      );
      expect(cancelAttempts).toBe(1);
      const cancelledStore = await openStateStore({ env: { ...process.env, CALYX_STATE_HOME: remote.remoteStateHome } });
      try {
        expect(readMonitor(cancelledStore.db, created.monitor.monitor_id)).toMatchObject({ status: "cancelled" });
      } finally {
        cancelledStore.db.close();
      }
    } finally {
      await remote.handle.close();
    }
  });

  test("remote monitor never resolves a named-host token for an origin-rebound URL", async () => {
    const agentsInfraRoot = join(root, "agents-infra-authority");
    await mkdir(join(agentsInfraRoot, "fleet", "truths"), { recursive: true });
    await writeFile(
      join(agentsInfraRoot, "fleet", "truths", "hosts.yaml"),
      "hosts:\n  remote:\n    run_serve_url: https://remote.internal:8740\n",
      "utf8",
    );
    const tokenForHost = vi.fn(() => "ambient-operator-token");
    const fetchImpl = vi.fn();
    const program = buildMonitorProgram([], {
      agentsInfraRoot,
      createAdminClient: createAdminClientFactory(fetchImpl),
      tokenForHost,
    });

    await expect(program.parseAsync([
      "node", "calyx", "monitor", "list",
      "--host", "remote",
      "--server-url", "https://attacker.example:8740",
      "--json",
    ])).rejects.toThrow(/monitor_remote_auth_missing/);
    expect(tokenForHost).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("remote list sends the declared source_run_id query and filters to one run", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const remoteRoot = await mkdtemp(join(root, "remote-list-filter-"));
    const remote = await startRemoteMonitorServer({
      remoteRoot,
      runIds: ["remote-run-filter-one", "remote-run-filter-two"],
    });
    const observedQueries: string[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/admin/monitors" && init?.method === "GET") {
        observedQueries.push(url.search);
      }
      return fetch(input, init);
    });
    const program = buildMonitorProgram([], {
      agentsInfraRoot: join(root, "empty-agents-list-filter"),
      createAdminClient: createAdminClientFactory(fetchImpl),
    });

    try {
      for (const runId of ["remote-run-filter-one", "remote-run-filter-two"]) {
        await program.parseAsync([
          "node", "calyx", "monitor", "create",
          "--preset", "runner-supervision",
          "--run", runId,
          "--assigned-host", "remote",
          "--idempotency-key", `monitor-create:${runId}`,
          "--server-url", remote.serverUrl,
          "--auth-token", "remote-secret",
          "--json",
        ]);
      }

      await program.parseAsync([
        "node", "calyx", "monitor", "list",
        "--run", "remote-run-filter-one",
        "--host", "remote",
        "--server-url", remote.serverUrl,
        "--auth-token", "remote-secret",
        "--json",
      ]);

      expect(observedQueries).toHaveLength(1);
      expect(Object.fromEntries(new URLSearchParams(observedQueries[0]))).toEqual({
        source_run_id: "remote-run-filter-one",
        status: "active",
      });
      const listed = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        count: number;
        monitors: Array<{ source_run_id: string }>;
      };
      expect(listed.count).toBe(1);
      expect(listed.monitors).toEqual([
        expect.objectContaining({ source_run_id: "remote-run-filter-one" }),
      ]);
    } finally {
      await remote.handle.close();
    }
  });

  test("remote create recovers a committed result with the same generated key", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const remoteRoot = await mkdtemp(join(root, "remote-retry-"));
    const remote = await startRemoteMonitorServer({
      remoteRoot,
      runIds: ["remote-run-retry"],
    });
    const mutationBodies: string[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith("/v1/admin/monitors") && init?.method === "POST") {
        mutationBodies.push(await requestBodyText(init.body));
        const response = await fetch(input, init);
        if (mutationBodies.length === 1) {
          await response.arrayBuffer();
          throw new Error("response lost after commit");
        }
        return response;
      }
      return fetch(input, init);
    });
    const program = buildMonitorProgram([], {
      agentsInfraRoot: join(root, "empty-agents-retry"),
      createAdminClient: createAdminClientFactory(fetchImpl),
    });

    try {
      await program.parseAsync([
        "node", "calyx", "monitor", "create",
        "--preset", "runner-supervision",
        "--run", "remote-run-retry",
        "--assigned-host", "remote",
        "--server-url", remote.serverUrl,
        "--auth-token", "remote-secret",
        "--json",
      ]);

      expect(mutationBodies).toHaveLength(2);
      expect(mutationBodies[1]).toBe(mutationBodies[0]);
      expect(JSON.parse(mutationBodies[0]!)).toMatchObject({
        idempotency_key: expect.stringMatching(/^monitor-create:/),
      });
      expect(await listMonitorRowsForState(remote.remoteStateHome)).toHaveLength(1);
      expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
        monitor: { source_run_id: "remote-run-retry" },
      });
    } finally {
      await remote.handle.close();
    }
  });

  test("remote create treats malformed or undeclared 2xx representations as indeterminate", async () => {
    const remoteRoot = await mkdtemp(join(root, "remote-invalid-success-"));
    const runIds = ["remote-run-future-success", "remote-run-undeclared-success"];
    const remote = await startRemoteMonitorServer({ remoteRoot, runIds });
    const fixtures = [
      {
        name: "future-success",
        runId: runIds[0]!,
        status: 200,
        body: JSON.stringify({ schema_version: "calyx.monitor-create/v2" }),
      },
      {
        name: "undeclared-success",
        runId: runIds[1]!,
        status: 201,
        body: JSON.stringify({ schema_version: "calyx.monitor-create/v1" }),
      },
    ] as const;

    try {
      for (const fixture of fixtures) {
        let mutationAttempts = 0;
        const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          if (String(input).endsWith("/v1/admin/monitors") && init?.method === "POST") {
            mutationAttempts += 1;
            const committed = await fetch(input, init);
            await committed.arrayBuffer();
            return new Response(fixture.body, { status: fixture.status });
          }
          return fetch(input, init);
        });
        const program = buildMonitorProgram([], {
          agentsInfraRoot: join(root, `empty-agents-${fixture.name}`),
          createAdminClient: createAdminClientFactory(fetchImpl),
        });

        const result = expect(program.parseAsync([
          "node", "calyx", "monitor", "create",
          "--preset", "runner-supervision",
          "--run", fixture.runId,
          "--assigned-host", "remote",
          "--idempotency-key", `monitor-create-${fixture.name}`,
          "--server-url", remote.serverUrl,
          "--auth-token", "remote-secret",
          "--json",
        ]), fixture.name).rejects;
        await result.toThrow("is indeterminate");
        await result.toThrow("calyx.client-indeterminate-result/v1");
        expect(mutationAttempts, fixture.name).toBe(4);
      }
      expect(await listMonitorRowsForState(remote.remoteStateHome)).toHaveLength(fixtures.length);
    } finally {
      await remote.handle.close();
    }
  });

  test("remote monitor reads reject an empty undeclared 2xx representation", async () => {
    const remoteRoot = await mkdtemp(join(root, "remote-empty-success-"));
    const remote = await startRemoteMonitorServer({ remoteRoot });
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/admin/monitors" && init?.method === "GET") {
        return new Response(null, { status: 204 });
      }
      return fetch(input, init);
    });
    const program = buildMonitorProgram([], {
      agentsInfraRoot: join(root, "empty-agents-empty-success"),
      createAdminClient: createAdminClientFactory(fetchImpl),
    });

    try {
      await expect(program.parseAsync([
        "node", "calyx", "monitor", "list",
        "--host", "remote",
        "--server-url", remote.serverUrl,
        "--auth-token", "remote-secret",
        "--json",
      ])).rejects.toThrow("daemon returned an invalid success representation");
    } finally {
      await remote.handle.close();
    }
  });

  test("remote claim and ack refuse mutation against a monitor.remote/v1-only daemon", async () => {
    const remoteRoot = await mkdtemp(join(root, "remote-pre-claim-feature-"));
    const remote = await startRemoteMonitorServer({ remoteRoot, supportsClaim: false });
    const opened = await openStateStore({ env: { ...process.env, CALYX_STATE_HOME: remote.remoteStateHome } });
    let wakeId = "";
    try {
      const predicate = runnerSupervisionPredicate("remote-pre-claim-run");
      const monitor = createMonitor(opened.db, {
        monitor_id: "mon_remote_pre_claim",
        owner: "operator",
        created_by: "tester",
        create_provenance: "operator",
        assigned_host: "remote",
        source_run_id: "remote-pre-claim-run",
        preset: "runner-supervision",
        predicate,
        rearm_policy: "once",
      });
      const evaluation = await evaluatePredicateV1(predicate, {
        now: () => new Date("2026-06-12T05:00:00.000Z"),
        readRun: () => ({
          run_id: "remote-pre-claim-run",
          state: "failed",
          updated_at: "2026-06-12T05:00:00.000Z",
          completed_at: "2026-06-12T05:00:00.000Z",
        }),
      });
      wakeId = createMonitorWake(opened.db, {
        monitor,
        evaluation,
        suggested_commands: ["calyx monitor inbox --host remote --json"],
        created_at: evaluation.evaluated_at,
      }).wake.wake_id;
    } finally {
      opened.db.close();
    }

    let claimPosts = 0;
    let ackPosts = 0;
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/v1/admin/monitors/wakes" && init?.method === "POST") {
        claimPosts += 1;
      }
      if (/^\/v1\/admin\/monitors\/wakes\/[^/]+\/ack$/.test(pathname) && init?.method === "POST") {
        ackPosts += 1;
      }
      return fetch(input, init);
    });
    const program = buildMonitorProgram([], {
      agentsInfraRoot: join(root, "empty-agents-pre-claim"),
      createAdminClient: createAdminClientFactory(fetchImpl),
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await program.parseAsync([
        "node", "calyx", "monitor", "inbox", "--peek",
        "--host", "remote", "--server-url", remote.serverUrl,
        "--auth-token", "remote-secret", "--json",
      ]);
      expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
        count: 1,
        wakes: [expect.objectContaining({ wake_id: wakeId, status: "pending" })],
      });

      await expect(program.parseAsync([
        "node", "calyx", "monitor", "inbox", "--claimed-by", "operator",
        "--host", "remote", "--server-url", remote.serverUrl,
        "--auth-token", "remote-secret", "--json",
      ])).rejects.toThrow(/monitor_remote_unsupported: [\s\S]*monitor\.claim\/v1/);
      expect(claimPosts).toBe(0);

      await expect(program.parseAsync([
        "node", "calyx", "monitor", "ack", wakeId, "--acked-by", "operator",
        "--host", "remote", "--server-url", remote.serverUrl,
        "--auth-token", "remote-secret", "--json",
      ])).rejects.toThrow(/monitor_remote_unsupported: [\s\S]*monitor\.claim\/v1/);
      expect(ackPosts).toBe(0);

      const verify = await openStateStore({ env: { ...process.env, CALYX_STATE_HOME: remote.remoteStateHome } });
      try {
        expect(readMonitorWake(verify.db, wakeId)).toMatchObject({
          status: "pending",
          claimed_by: null,
          claimed_until: null,
        });
      } finally {
        verify.db.close();
      }
    } finally {
      await remote.handle.close();
    }
  });

  test("remote create refusals write no local or remote monitor rows", async () => {
    const agentsInfraRoot = join(root, "agents-infra");
    await mkdir(join(agentsInfraRoot, "fleet", "truths"), { recursive: true });
    await writeFile(
      join(agentsInfraRoot, "fleet", "truths", "hosts.yaml"),
      "hosts:\n  blade: {}\n  carbon: {}\n",
      "utf8",
    );
    const unknownHostProgram = buildMonitorProgram([], { agentsInfraRoot });
    await expect(unknownHostProgram.parseAsync([
      "node",
      "calyx",
      "monitor",
      "create",
      "--preset",
      "runner-supervision",
      "--run",
      "remote-run-unknown-host",
      "--assigned-host",
      "worm",
      "--server-url",
      "http://127.0.0.1:9",
      "--auth-token",
      "remote-secret",
      "--json",
    ])).rejects.toThrow(/monitor_unknown_host: unknown host "worm". Known hosts: blade, carbon/);
    expect(await listMonitorRowsForState(process.env["CALYX_STATE_HOME"]!)).toHaveLength(0);

    const emptyAgentsRoot = join(root, "empty-agents");
    const unreachableProgram = buildMonitorProgram([], { agentsInfraRoot: emptyAgentsRoot });
    await expect(unreachableProgram.parseAsync([
      "node",
      "calyx",
      "monitor",
      "create",
      "--preset",
      "runner-supervision",
      "--run",
      "remote-run-unreachable",
      "--assigned-host",
      "remote",
      "--server-url",
      "http://127.0.0.1:9",
      "--auth-token",
      "remote-secret",
      "--json",
    ])).rejects.toThrow(/monitor_remote_unreachable: daemon for remote is unreachable\. Fallback: ssh remote/);
    expect(await listMonitorRowsForState(process.env["CALYX_STATE_HOME"]!)).toHaveLength(0);

    const unsupportedRoot = await mkdtemp(join(root, "unsupported-"));
    const unsupportedRemote = await startRemoteMonitorServer({
      remoteRoot: unsupportedRoot,
      supportsRemote: false,
    });
    try {
      const unsupportedProgram = buildMonitorProgram([], { agentsInfraRoot: emptyAgentsRoot });
      await expect(unsupportedProgram.parseAsync([
        "node",
        "calyx",
        "monitor",
        "create",
        "--preset",
        "runner-supervision",
        "--run",
        "remote-run-unsupported",
        "--assigned-host",
        "remote",
        "--server-url",
        unsupportedRemote.serverUrl,
        "--auth-token",
        "remote-secret",
        "--json",
      ])).rejects.toThrow(/monitor_remote_unsupported: [\s\S]*monitor\.remote\/v1[\s\S]*Fallback: ssh remote/);
      expect(await listMonitorRowsForState(process.env["CALYX_STATE_HOME"]!)).toHaveLength(0);
      expect(await listMonitorRowsForState(unsupportedRemote.remoteStateHome)).toHaveLength(0);
    } finally {
      await unsupportedRemote.handle.close();
    }

    const missingRunRoot = await mkdtemp(join(root, "missing-run-"));
    const missingRunRemote = await startRemoteMonitorServer({ remoteRoot: missingRunRoot });
    try {
      const missingRunProgram = buildMonitorProgram([], { agentsInfraRoot: emptyAgentsRoot });
      await expect(missingRunProgram.parseAsync([
        "node",
        "calyx",
        "monitor",
        "create",
        "--preset",
        "runner-supervision",
        "--run",
        "remote-run-missing",
        "--assigned-host",
        "remote",
        "--server-url",
        missingRunRemote.serverUrl,
        "--auth-token",
        "remote-secret",
        "--json",
      ])).rejects.toThrow(/monitor_run_unknown: runner-supervision run "remote-run-missing" is not resolvable in remote's run store/);
      expect(await listMonitorRowsForState(process.env["CALYX_STATE_HOME"]!)).toHaveLength(0);
      expect(await listMonitorRowsForState(missingRunRemote.remoteStateHome)).toHaveLength(0);
    } finally {
      await missingRunRemote.handle.close();
    }
  });

  test("doctor reports active monitors assigned to a foreign host", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const opened = await openStateStore();
    try {
      createMonitor(opened.db, {
        owner: "operator",
        created_by: "tester",
        create_provenance: "operator",
        assigned_host: "pol1788-foreign-host",
        source_run_id: "run-foreign-monitor",
        preset: "runner-supervision",
        predicate: runnerSupervisionPredicate("run-foreign-monitor", 1_800_000),
        rearm_policy: "every_change",
      });
    } finally {
      opened.db.close();
    }

    const program = buildMonitorProgram();
    await program.parseAsync(["node", "calyx", "monitor", "doctor", "--json"]);
    const doctor = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      ok: boolean;
      findings: Array<{ code: string; severity: string; message: string }>;
    };
    expect(doctor.ok).toBe(false);
    expect(doctor.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "monitors-foreign-assigned-host",
          severity: "error",
          message: expect.stringContaining("pol1788-foreign-host"),
        }),
      ]),
    );
  });

});
