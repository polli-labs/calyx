import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { Server as NetServer } from "node:net";
import { hostname as systemHostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AdapterResult, BackendAdapter, RunDeps, RunReceipt, RunResult, RunSpec } from "@polli-labs/calyx-runner";
import {
  CALYX_DAEMON_FEATURES,
  CALYX_HTTP_SSE_MAX_FRAME_BYTES,
  CALYX_SELF_UPGRADE_RECEIPT_MAX_BYTES,
  HTTP_OPERATION_DESCRIPTORS,
  STATE_MIGRATIONS,
  ackMonitorWake,
  applyStateMigrations,
  claimMessageOutboxAttempt,
  createMonitorWake,
  hashCanonicalJcs,
  hashConsumerApiBearer,
  createMessage,
  enqueueMessageOutbox,
  enqueueMessageReceiptMirror,
  evaluatePredicateV1,
  listLeaseEvents,
  listMonitorHistory,
  listMonitors,
  loadStateDriver,
  openStateStore,
  readApiIdempotency,
  readMessage,
  readMessageOutbox,
  readMonitor,
  readMonitorWake,
  recordApiIdempotency,
  recordMonitorEvaluation,
  recoverExpiredMessageOutboxAttempts,
  requiredFeaturesForIntent,
  RunIndexProjection,
  withSqliteMutex,
} from "@polli-labs/calyx-core";
import type { ApiProvenanceV1, StateOpenOptions } from "@polli-labs/calyx-core";
import {
  ActivityAttachmentError,
  ActivityIdAmbiguousError,
  AgentRunnerKernel,
  InteractiveActivityProjectionNotReadyError,
  isRunServiceEvent,
  resolveRunIntent,
  RunAlreadyExistsError,
  RunNotFoundError,
  type CalyxStreamEvent,
  type RunServiceDependencies,
} from "@polli-labs/calyx-run-service";
import {
  RunService,
  passingTestWorkloadAdmissionReceipt,
} from "./support/test-run-service.js";
import {
  EVENT_STREAM_IDLE_TIMEOUT_MS,
  CALYX_RUN_LAUNCH_ACCEPT_V1,
  handleEventsStream,
  isRuntimeConfigDispatchRequest,
  RunServerPortError,
  SUPPORTED_FEATURES,
  startRunServer,
  type RunLaunchRequest,
  type RuntimeConfigDispatchRequest,
} from "../server.js";
import { resolveServerBuildInfoPath } from "../build-info.js";
import { toRunObservationGapEvent } from "../consumer-dtos.js";

interface StreamEvent {
  schema_version?: string;
  cursor: string;
  event_type: string;
  emitted_by?: string;
  run?: {
    run_id: string;
    state: string;
    host?: string;
    issue?: string;
    branch?: string;
  };
  control?: {
    host: string;
    daemon_id?: string;
    operation_id?: string;
    phase?: string;
  };
  summary?: {
    one_line: string;
  };
  gap?: {
    reason: string;
    source_event_type: string;
  };
}

const BUILD_INFO = {
  schema_version: "build-info/v1" as const,
  git_head: "build-sha-123",
  built_at: "2026-04-20T00:00:00.000Z",
  package_version: "0.2.0",
  branch: "main",
  dirty: false,
};
const TOPOLOGY_PROJECTION_SHA256 = "a".repeat(64);

function makeReceipt(spec: RunSpec): RunReceipt {
  const now = new Date().toISOString();
  return {
    schema_version: "1.0",
    run_id: spec.run_id ?? "unknown",
    state: "succeeded",
    run_spec: spec,
    timing: {
      created_at: now,
      completed_at: now,
    },
    exit: {
      exit_code: 0,
    },
    artifacts: {
      run_id: spec.run_id ?? "unknown",
      finalized_at: now,
      required: [],
      discovered: [],
      gate_passed: true,
      missing: [],
    },
    log_summary: {
      total: 0,
      info: 0,
      warn: 0,
      error: 0,
    },
    environment: {
      host: spec.host,
      backend: spec.backend,
    },
    summary: `Run ${spec.run_id} succeeded`,
  };
}

function currentHostAlias(): string {
  return systemHostname().trim().split(".")[0]?.toLowerCase() ?? "";
}

function buildDeps(
  options: {
    codexSessionCount?: number;
    runtimeAdapterRegistry?: {
      register: () => void;
      create: () => BackendAdapter;
      has: () => boolean;
      list: () => string[];
      activeSessionCount?: (backend: string) => number;
    };
  } = {},
): Partial<RunServiceDependencies> {
  const adapter: BackendAdapter = {
    name: "mock",
    capabilities: {
      streaming: false,
      turnControl: false,
      resumeSession: false,
      forkSession: false,
      approvals: "none",
    },
    spawn: async (): Promise<AdapterResult> => ({
      exit_code: 0,
      stderr: "",
      events: [],
      duration_ms: 1,
    }),
    stop: async (): Promise<void> => {},
  };

  return {
    resolveExecutionKernel: () => new AgentRunnerKernel({
      runtimeAdapterRegistry: options.runtimeAdapterRegistry ?? {
        register: () => {},
        create: () => adapter,
        has: () => true,
        list: () => ["mock"],
        activeSessionCount: (backend: string) => backend === "codex" ? (options.codexSessionCount ?? 0) : 0,
      },
      executeRun: async (rawSpec: unknown, deps: RunDeps): Promise<RunResult> => {
        const spec = rawSpec as RunSpec;
        deps.onEvent?.({
          timestamp: new Date().toISOString(),
          run_id: spec.run_id ?? "unknown",
          event: "state_transition",
          from: "queued",
          to: "running",
        });
        const receipt = makeReceipt(spec);
        if (deps.receiptPath) {
          await writeFile(deps.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
        }
        return { receipt, events: [], dispatch_accepted: true };
      },
    }),
    collectHostResources: async () => ({
      schema_version: "host-resources/v1",
      checked_at: "2026-03-11T12:00:00.000Z",
      gpu: {
        provider: "nvidia-smi",
        status: "unavailable",
        checked_at: "2026-03-11T12:00:00.000Z",
        command: ["nvidia-smi"],
        gpus: [],
        message: "mocked",
      },
    }),
    hostname: () => "blade",
    now: () => "2026-03-11T12:00:00.000Z",
  };
}

function createServerOptions(
  service: RunService,
  registryRoot: string,
  options: {
    advertisedHost?: string;
    actualHost?: string;
    stateStoreOptions?: StateOpenOptions;
    messageHostAliases?: Readonly<Record<string, string>>;
    reconcileIntervalMs?: number | false;
    selfUpgradeReceiptRoot?: string;
    afterSelfUpgradeReceiptRootValidatedBeforeRead?: () => Promise<void>;
  } = {},
) {
  const advertisedHost = options.advertisedHost ?? "127.0.0.1";
  return {
    credentials: [
      {
        client_id: "test-control-plane",
        credential_tier: "control_plane" as const,
        verifier: hashConsumerApiBearer("secret-token"),
        verifier_env: "CALYX_CONSUMER_API_TEST_CONTROL_PLANE_VERIFIER",
        address_grants: { send_as: ["client:test-control-plane@blade"], read: ["run:*"] },
      },
      {
        client_id: `daemon:${advertisedHost}`,
        credential_tier: "internal_runtime" as const,
        verifier: hashConsumerApiBearer("self-daemon-token"),
        verifier_env: "CALYX_CONSUMER_API_TEST_SELF_DAEMON_VERIFIER",
        address_grants: {
          send_as: [`client:daemon:${advertisedHost}@${advertisedHost}`],
          read: [`host:${advertisedHost}`],
        },
      },
    ],
    host: "127.0.0.1",
    advertisedHost,
    hostname: () => options.actualHost ?? "blade",
    port: 0,
    service,
    registryRoot,
    buildInfo: BUILD_INFO,
    startedAt: "2026-04-20T00:00:00.000Z",
    inheritedPath: "/mock/bin:/usr/bin",
    ...(options.stateStoreOptions ? { stateStoreOptions: options.stateStoreOptions } : {}),
    ...(options.messageHostAliases ? { messageHostAliases: options.messageHostAliases } : {}),
    ...(options.reconcileIntervalMs !== undefined
      ? { reconcileIntervalMs: options.reconcileIntervalMs }
      : {}),
    ...(options.selfUpgradeReceiptRoot ? { selfUpgradeReceiptRoot: options.selfUpgradeReceiptRoot } : {}),
    ...(options.afterSelfUpgradeReceiptRootValidatedBeforeRead
      ? {
          afterSelfUpgradeReceiptRootValidatedBeforeRead:
            options.afterSelfUpgradeReceiptRootValidatedBeforeRead,
        }
      : {}),
  };
}

async function rawHttpRequest(
  url: string,
  options: { headers: Record<string, string>; body: Buffer; chunked?: boolean },
): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      agent: false,
      headers: options.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    request.once("error", reject);
    if (options.chunked) {
      const midpoint = Math.floor(options.body.length / 2);
      request.write(options.body.subarray(0, midpoint));
      request.write(options.body.subarray(midpoint));
      request.end();
    } else {
      request.end(options.body);
    }
  });
}

async function rawHttpGet(
  url: string,
  headers: readonly string[],
): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      agent: false,
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    request.once("error", reject);
    request.end();
  });
}

async function collectIndexedEvents(service: RunService, runId?: string): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of service.store.readEventsSince(undefined, runId ? { run_id: runId } : {})) {
    events.push(event as StreamEvent);
  }
  return events;
}

async function readNextStreamEvent(response: Response): Promise<StreamEvent> {
  if (!response.body) {
    throw new Error("Expected an SSE response body.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error("Stream ended before yielding an event.");
      }
      buffer += decoder.decode(value, { stream: true });
      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex >= 0) {
        const frame = buffer.slice(0, separatorIndex).replace(/\r\n/g, "\n").trim();
        buffer = buffer.slice(separatorIndex + 2);
        if (!frame || frame.startsWith(":")) {
          separatorIndex = buffer.indexOf("\n\n");
          continue;
        }
        const dataLines = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart());
        if (dataLines.length === 0) {
          separatorIndex = buffer.indexOf("\n\n");
          continue;
        }
        return JSON.parse(dataLines.join("\n")) as StreamEvent;
      }
    }
  } finally {
    await reader.cancel();
  }
}

class MockStreamRequest extends EventEmitter {
  method = "GET";
  headers: Record<string, string> = {};
}

class MockStreamResponse extends EventEmitter {
  statusCode?: number;
  headers: Record<string, string | number | readonly string[]> = {};
  writes: string[] = [];
  writableEnded = false;
  destroyed = false;
  failWrites = false;
  writeResults: boolean[] = [];

  writeHead(statusCode: number, headers: Record<string, string | number | readonly string[]>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  flushHeaders(): void {}

  write(chunk: string | Uint8Array): boolean {
    if (this.failWrites) {
      throw new Error("socket write failure");
    }
    this.writes.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return this.writeResults.shift() ?? true;
  }

  end(chunk?: string | Uint8Array): this {
    if (typeof chunk !== "undefined") {
      this.write(chunk);
    }
    this.writableEnded = true;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

type ReadEventsPlan = CalyxStreamEvent[] | Error;

function getEventSubscriberCount(service: RunService): number {
  const internals = service as unknown as {
    eventSubscribers: Set<(event: CalyxStreamEvent) => void>;
  };
  return internals.eventSubscribers.size;
}

function notifyEventSubscribers(service: RunService, event: CalyxStreamEvent): void {
  const internals = service as unknown as {
    notifyEventSubscribers: (streamEvent: CalyxStreamEvent) => void;
  };
  internals.notifyEventSubscribers(event);
}

function mockReadEventsSince(service: RunService, plans: ReadEventsPlan[]) {
  const remaining = [...plans];
  return vi.spyOn(service, "readEventsSince").mockImplementation((_cursor, _filter) => {
    const nextPlan = remaining.shift() ?? [];
    return (async function* (): AsyncIterable<CalyxStreamEvent> {
      if (nextPlan instanceof Error) {
        throw nextPlan;
      }
      for (const event of nextPlan) {
        yield event;
      }
    })();
  });
}

function makeTestStreamEvent(cursor: string): CalyxStreamEvent {
  return {
    schema_version: "1.0",
    event_id: `event-${cursor}`,
    cursor,
    emitted_at: "2026-03-11T12:00:00.000Z",
    event_type: "run.terminal",
    emitted_by: "launch",
    run: {
      run_id: "run-stream-test",
      state: "succeeded",
      kernel: "agent_runner",
      backend: "claude",
      host: "blade",
      created_at: "2026-03-11T12:00:00.000Z",
      recovery_mode: "normal",
    },
    origin: {
      launcher_kind: "cli",
    },
    pointers: {
      run_dir: "/tmp/run-stream-test",
      run_record_path: "/tmp/run-stream-test/run_record.json",
      events_path: "/tmp/run-stream-test/events.jsonl",
    },
    summary: {
      one_line: "test terminal event",
    },
  } as CalyxStreamEvent;
}

describe("run server", () => {
  let runsRoot: string;
  let registryRoot: string;
  let stateRoot: string;
  let priorDisableOtel: string | undefined;
  let priorStateHome: string | undefined;
  let priorStateDb: string | undefined;

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), "calyx-run-server-"));
    registryRoot = await mkdtemp(join(tmpdir(), "calyx-run-server-registry-"));
    stateRoot = await mkdtemp(join(tmpdir(), "calyx-run-server-state-"));
    priorDisableOtel = process.env["CALYX_DISABLE_OTEL"];
    priorStateHome = process.env["CALYX_STATE_HOME"];
    priorStateDb = process.env["CALYX_STATE_DB"];
    // Keep this suite focused on health/runs/events behavior; OTel exporter
    // init is covered in run-service/__tests__/otel-metrics.test.ts.
    process.env["CALYX_DISABLE_OTEL"] = "1";
    process.env["CALYX_STATE_HOME"] = join(stateRoot, "state");
    delete process.env["CALYX_STATE_DB"];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (priorDisableOtel === undefined) {
      delete process.env["CALYX_DISABLE_OTEL"];
    } else {
      process.env["CALYX_DISABLE_OTEL"] = priorDisableOtel;
    }
    if (priorStateHome === undefined) {
      delete process.env["CALYX_STATE_HOME"];
    } else {
      process.env["CALYX_STATE_HOME"] = priorStateHome;
    }
    if (priorStateDb === undefined) {
      delete process.env["CALYX_STATE_DB"];
    } else {
      process.env["CALYX_STATE_DB"] = priorStateDb;
    }
    await rm(runsRoot, { recursive: true, force: true });
    await rm(registryRoot, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  });

  test("serves bounded host-authoritative self-upgrade receipts through an admin route", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const receiptRoot = join(stateRoot, "self-upgrade-receipts");
    await mkdir(receiptRoot, { recursive: true });
    const receipt = {
      schema_version: "self-upgrade-receipt/v1",
      operation_id: "self-upgrade-test",
      fleet_operation_id: "fleet-current-test",
      host: "blade",
      target_ref: "origin/main",
      target_evidence: {
        original_ref: "origin/main",
        target_sha: "b".repeat(40),
        fetch_remote: "origin",
        fetch_ref: "main",
      },
      status: "succeeded",
      started_at: "2026-07-21T10:00:00.000Z",
      completed_at: "2026-07-21T10:01:00.000Z",
      repo_root: "/srv/blade/calyx",
      before_head: "a".repeat(40),
      after_head: "b".repeat(40),
      commit_list: [],
      before_builds: [],
      after_builds: [],
      active_run_classification: [],
      drain_mode: "drain",
      readopted_run_ids: [],
      drain_duration_ms: 1_000,
      daemons_restarted: [],
      warnings: [],
    };
    await writeFile(
      join(receiptRoot, "self-upgrade-test.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(receiptRoot, "self-upgrade-invalid.json"), "{}\n", "utf8");
    await writeFile(
      join(receiptRoot, "self-upgrade-mismatched.json"),
      `${JSON.stringify({ ...receipt, operation_id: "another-operation" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(receiptRoot, "self-upgrade-legacy.json"),
      `${JSON.stringify({
        ...receipt,
        operation_id: undefined,
        fleet_operation_id: undefined,
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(receiptRoot, "self-upgrade-oversized.json"),
      Buffer.alloc(CALYX_SELF_UPGRADE_RECEIPT_MAX_BYTES + 1, 0x61),
    );
    let injectCanonicalReplacement = false;
    const canonicalReplacementHeld = `${receiptRoot}-canonical-race-held`;
    const handle = await startRunServer(createServerOptions(service, registryRoot, {
      selfUpgradeReceiptRoot: receiptRoot,
      afterSelfUpgradeReceiptRootValidatedBeforeRead: async () => {
        if (!injectCanonicalReplacement) return;
        injectCanonicalReplacement = false;
        await rename(receiptRoot, canonicalReplacementHeld);
        await mkdir(receiptRoot);
      },
    }));

    try {
      const served = await fetch(`${handle.url}/v1/admin/self-upgrade-receipts/self-upgrade-test`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(served.status).toBe(200);
      expect(await served.json()).toEqual(receipt);

      const forbidden = await fetch(`${handle.url}/v1/admin/self-upgrade-receipts/self-upgrade-test`, {
        headers: { authorization: "Bearer self-daemon-token" },
      });
      expect(forbidden.status).toBe(403);

      const missing = await fetch(`${handle.url}/v1/admin/self-upgrade-receipts/missing`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: { code: "self_upgrade_receipt_unknown" } });

      const invalid = await fetch(`${handle.url}/v1/admin/self-upgrade-receipts/self-upgrade-invalid`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(invalid.status).toBe(422);
      expect(await invalid.json()).toMatchObject({ error: { code: "self_upgrade_receipt_invalid" } });

      const mismatched = await fetch(`${handle.url}/v1/admin/self-upgrade-receipts/self-upgrade-mismatched`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(mismatched.status).toBe(422);
      expect(await mismatched.json()).toMatchObject({ error: { code: "self_upgrade_receipt_invalid" } });

      const legacy = await fetch(`${handle.url}/v1/admin/self-upgrade-receipts/self-upgrade-legacy`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(legacy.status).toBe(200);

      const oversized = await fetch(`${handle.url}/v1/admin/self-upgrade-receipts/self-upgrade-oversized`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(oversized.status).toBe(422);
      expect(await oversized.json()).toMatchObject({ error: { code: "self_upgrade_receipt_invalid" } });

      const temporarilyMissingRoot = `${receiptRoot}-temporarily-missing`;
      await rename(receiptRoot, temporarilyMissingRoot);
      const missingRoot = await fetch(`${handle.url}/v1/admin/self-upgrade-receipts/self-upgrade-test`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(missingRoot.status).toBe(503);
      expect(await missingRoot.json()).toMatchObject({
        error: { code: "self_upgrade_receipt_unavailable", retryable: true },
      });
      await rename(temporarilyMissingRoot, receiptRoot);

      await chmod(receiptRoot, 0o000);
      try {
        const unavailable = await fetch(`${handle.url}/v1/admin/self-upgrade-receipts/self-upgrade-test`, {
          headers: { authorization: "Bearer secret-token" },
        });
        expect(unavailable.status).toBe(503);
        expect(await unavailable.json()).toMatchObject({
          error: {
            code: "self_upgrade_receipt_unavailable",
            retryable: false,
          },
        });
      } finally {
        await chmod(receiptRoot, 0o700);
      }

      injectCanonicalReplacement = true;
      const raced = await fetch(`${handle.url}/v1/admin/self-upgrade-receipts/self-upgrade-test`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(raced.status).toBe(503);
      expect(await raced.json()).toMatchObject({
        error: {
          code: "self_upgrade_receipt_unavailable",
          retryable: true,
        },
      });
      await rm(receiptRoot, { recursive: true, force: true });
      await rename(canonicalReplacementHeld, receiptRoot);

      const malformedPath = await fetch(`${handle.url}/v1/admin/self-upgrade-receipts/%ZZ`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(malformedPath.status).toBe(400);
      expect(await malformedPath.json()).toMatchObject({ error: { code: "invalid_request" } });

      const originalReceiptRoot = `${receiptRoot}-original`;
      const redirectRoot = `${receiptRoot}-redirect`;
      await rename(receiptRoot, originalReceiptRoot);
      await mkdir(redirectRoot);
      await writeFile(
        join(redirectRoot, "self-upgrade-test.json"),
        `${JSON.stringify({ ...receipt, after_head: "c".repeat(40) })}\n`,
        "utf8",
      );
      await symlink(redirectRoot, receiptRoot, "dir");
      const redirected = await fetch(`${handle.url}/v1/admin/self-upgrade-receipts/self-upgrade-test`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(redirected.status).toBe(422);
      expect(await redirected.json()).toMatchObject({ error: { code: "self_upgrade_receipt_invalid" } });
    } finally {
      await handle.close();
    }
  });

  test("steady-state reconcile interval fires after boot and stops on close (POL-1897)", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const reconcileSpy = vi.spyOn(service, "reconcile");
    const handle = await startRunServer(createServerOptions(service, registryRoot, {
      reconcileIntervalMs: 100,
    }));

    try {
      // Boot reconcile is call 1; the steady-state interval must add more.
      await vi.waitFor(() => {
        expect(reconcileSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
      }, { timeout: 5_000 });
      // Boot owns the full estate; steady-state ticks are scoped to active runs.
      expect(reconcileSpy.mock.calls[0]).toEqual([]);
      expect(reconcileSpy.mock.calls[1]).toEqual([{ scope: "active" }]);
    } finally {
      await handle.close();
    }
    const callsAtClose = reconcileSpy.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(reconcileSpy.mock.calls.length).toBe(callsAtClose);
  });

  test("admin message observation and forwarding use the resident forwarder's exact store without address grants", async () => {
    const forwarderState = {
      env: { ...process.env, CALYX_STATE_DB: join(stateRoot, "forwarder.sqlite") },
    };
    const serverState = {
      env: { ...process.env, CALYX_STATE_DB: join(stateRoot, "server.sqlite") },
    };
    await applyStateMigrations({ storeOptions: forwarderState });
    await applyStateMigrations({ storeOptions: serverState });
    const opened = await openStateStore(forwarderState);
    let outbox: ReturnType<typeof enqueueMessageOutbox>;
    let expiredOutbox: ReturnType<typeof enqueueMessageOutbox>;
    let expiredInFlightOutbox: ReturnType<typeof enqueueMessageOutbox>;
    let unrelatedExpiredOutbox: ReturnType<typeof enqueueMessageOutbox>;
    try {
      createMessage(opened.db, {
        message_id: "msg_admin_forward",
        sender: "client:test-control-plane@blade",
        recipient_address: "role:reviewer@worm",
        recipient_class: "directed",
        recipient_host: "worm",
        subject: "source daemon forward",
        status: "outbox",
        now: "2026-07-20T00:00:00.000Z",
      });
      outbox = enqueueMessageOutbox(opened.db, {
        message_id: "msg_admin_forward",
        target_host: "worm",
        now: "2026-07-20T00:00:00.000Z",
      });
      createMessage(opened.db, {
        message_id: "msg_admin_forward_expired",
        sender: "client:test-control-plane@blade",
        recipient_address: "role:reviewer@worm",
        recipient_class: "directed",
        recipient_host: "worm",
        subject: "expired source daemon forward",
        status: "outbox",
        now: "2026-07-20T00:00:00.000Z",
      });
      expiredOutbox = enqueueMessageOutbox(opened.db, {
        message_id: "msg_admin_forward_expired",
        target_host: "worm",
        expires_at: "2026-07-20T00:00:04.000Z",
        now: "2026-07-20T00:00:00.000Z",
      });
      createMessage(opened.db, {
        message_id: "msg_admin_forward_expired_in_flight",
        sender: "client:test-control-plane@blade",
        recipient_address: "role:reviewer@worm",
        recipient_class: "directed",
        recipient_host: "worm",
        subject: "expired in-flight source daemon forward",
        status: "outbox",
        now: "2026-07-20T00:00:00.000Z",
      });
      expiredInFlightOutbox = enqueueMessageOutbox(opened.db, {
        message_id: "msg_admin_forward_expired_in_flight",
        target_host: "worm",
        expires_at: "2026-07-20T00:00:04.000Z",
        now: "2026-07-20T00:00:00.000Z",
      });
      expect(claimMessageOutboxAttempt(opened.db, expiredInFlightOutbox.outbox_id, {
        attempt_id: "attempt-expired-exact-read",
        attempt_ttl_ms: 1_000,
        now: "2026-07-20T00:00:01.000Z",
      })).toMatchObject({
        status: "in_flight",
        attempt_expires_at: "2026-07-20T00:00:02.000Z",
      });
      createMessage(opened.db, {
        message_id: "msg_admin_forward_unrelated_expired",
        sender: "client:test-control-plane@blade",
        recipient_address: "role:reviewer@worm",
        recipient_class: "directed",
        recipient_host: "worm",
        subject: "unrelated expired source daemon forward",
        status: "outbox",
        now: "2026-07-20T00:00:00.000Z",
      });
      unrelatedExpiredOutbox = enqueueMessageOutbox(opened.db, {
        message_id: "msg_admin_forward_unrelated_expired",
        target_host: "worm",
        expires_at: "2026-07-20T00:00:04.000Z",
        now: "2026-07-20T00:00:00.000Z",
      });
    } finally {
      opened.db.close();
    }
    const service = new RunService({
      runsRoot,
      messageOutbox: {
        enabled: true,
        state: forwarderState,
        serverUrlForHost: () => "https://worm.internal.example:8740",
        tokenForHost: () => undefined,
        now: () => "2026-07-20T00:00:05.000Z",
      },
    }, buildDeps());
    const serverOptions = createServerOptions(service, registryRoot, {
      advertisedHost: "blade",
      stateStoreOptions: serverState,
    });
    serverOptions.credentials[0]!.address_grants = { send_as: [], read: [] };
    const handle = await startRunServer(serverOptions);
    const serverUrl = handle.url.replace("http://blade:", "http://127.0.0.1:");

    try {
      const observationResponse = await fetch(
        `${serverUrl}/v1/admin/message-operations/${encodeURIComponent(outbox.outbox_id)}`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(observationResponse.status).toBe(200);
      expect(await observationResponse.json()).toMatchObject({
        schema_version: "calyx.message-operation/v1",
        operation_id: outbox.outbox_id,
        target_host: "worm",
        status: "pending",
        terminal: false,
      });

      const response = await fetch(
        `${serverUrl}/v1/admin/message-operations/${encodeURIComponent(outbox.outbox_id)}/forward`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer secret-token",
            "X-Calyx-Asserted-Actor": "interactive:codex:source-conductor",
          },
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        schema_version: "calyx.message-operation/v1",
        operation_id: outbox.outbox_id,
        target_host: "worm",
        status: "pending",
        terminal: false,
      });

      const forwardedState = await openStateStore(forwarderState);
      try {
        expect(forwardedState.db.prepare(
          "SELECT status, attempt_count, last_error_code FROM outbox WHERE outbox_id = ?",
        ).get(outbox.outbox_id)).toEqual({
          status: "pending",
          attempt_count: 1,
          last_error_code: "auth_token_missing",
        });
      } finally {
        forwardedState.db.close();
      }

      const expiredObservation = await fetch(
        `${serverUrl}/v1/admin/message-operations/${encodeURIComponent(expiredOutbox.outbox_id)}`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(expiredObservation.status).toBe(200);
      expect(await expiredObservation.json()).toMatchObject({
        operation_id: expiredOutbox.outbox_id,
        status: "delivery_failed",
        terminal: true,
        updated_at: expiredOutbox.expires_at,
        receipt: {
          outcome: "delivery_failed",
          completed_at: expiredOutbox.expires_at,
        },
      });
      const afterReadProjection = await openStateStore(forwarderState);
      try {
        expect(readMessageOutbox(afterReadProjection.db, expiredOutbox.outbox_id)).toMatchObject({
          status: "pending",
        });
      } finally {
        afterReadProjection.db.close();
      }

      const expiredInFlightObservation = await fetch(
        `${serverUrl}/v1/admin/message-operations/${encodeURIComponent(expiredInFlightOutbox.outbox_id)}`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(expiredInFlightObservation.status).toBe(200);
      expect(await expiredInFlightObservation.json()).toMatchObject({
        operation_id: expiredInFlightOutbox.outbox_id,
        status: "indeterminate",
        terminal: true,
        updated_at: expiredInFlightOutbox.expires_at,
        receipt: {
          outcome: "indeterminate",
          completed_at: expiredInFlightOutbox.expires_at,
        },
      });
      const afterInFlightReadProjection = await openStateStore(forwarderState);
      try {
        expect(readMessageOutbox(afterInFlightReadProjection.db, expiredInFlightOutbox.outbox_id)).toMatchObject({
          status: "in_flight",
          attempt_id: "attempt-expired-exact-read",
          attempt_expires_at: "2026-07-20T00:00:02.000Z",
        });
      } finally {
        afterInFlightReadProjection.db.close();
      }

      const expiredForward = await fetch(
        `${serverUrl}/v1/admin/message-operations/${encodeURIComponent(expiredOutbox.outbox_id)}/forward`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer secret-token",
            "X-Calyx-Asserted-Actor": "interactive:codex:source-conductor",
          },
        },
      );
      expect(expiredForward.status).toBe(200);
      expect(await expiredForward.json()).toMatchObject({
        operation_id: expiredOutbox.outbox_id,
        status: "delivery_failed",
        terminal: true,
        updated_at: expiredOutbox.expires_at,
        receipt: { outcome: "delivery_failed", completed_at: expiredOutbox.expires_at },
      });
      const afterExpiredForward = await openStateStore(forwarderState);
      try {
        expect(readMessageOutbox(afterExpiredForward.db, expiredOutbox.outbox_id)).toMatchObject({
          status: "delivery_failed",
          last_error_code: "outbox_expired",
        });
        expect(readMessageOutbox(afterExpiredForward.db, unrelatedExpiredOutbox.outbox_id)).toMatchObject({
          status: "pending",
        });
      } finally {
        afterExpiredForward.db.close();
      }

      const audited = await openStateStore(serverState);
      try {
        expect(audited.db.prepare(
          `SELECT operation_id, subject, asserted_actor, response_status
             FROM api_request_audit
            WHERE operation_id = 'admin.msg.forward'`,
        ).get()).toEqual({
          operation_id: "admin.msg.forward",
          subject: "test-control-plane",
          asserted_actor: "interactive:codex:source-conductor",
          response_status: 200,
        });
      } finally {
        audited.db.close();
      }
    } finally {
      await handle.close();
    }
  });

  test("admin message forwarding returns typed schema unavailability before dispatch", async () => {
    const forwarderState = {
      env: { ...process.env, CALYX_STATE_DB: join(stateRoot, "unmigrated-forwarder.sqlite") },
    };
    const serverState = {
      env: { ...process.env, CALYX_STATE_DB: join(stateRoot, "migrated-server.sqlite") },
    };
    await applyStateMigrations({ storeOptions: serverState });
    const fetchImpl = vi.fn();
    const service = new RunService({
      runsRoot,
      messageOutbox: {
        enabled: true,
        state: forwarderState,
        fetch: fetchImpl,
        serverUrlForHost: () => "https://worm.internal.example:8740",
        tokenForHost: () => "daemon-token",
      },
    }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot, {
      advertisedHost: "blade",
      stateStoreOptions: serverState,
    }));
    const serverUrl = handle.url.replace("http://blade:", "http://127.0.0.1:");

    try {
      const response = await fetch(
        `${serverUrl}/v1/admin/message-operations/outbox-missing/forward`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer secret-token",
            "X-Calyx-Asserted-Actor": "interactive:codex:source-conductor",
          },
        },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { schema_version: "calyx.error/v1", code: "message_schema_unavailable" },
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  test("steady-state reconcile ticks are single-flight under a slow pass", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    let inFlight = 0;
    let maxInFlight = 0;
    const reconcileSpy = vi.spyOn(service, "reconcile").mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 300));
      inFlight -= 1;
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" as const },
      } satisfies Awaited<ReturnType<RunService["reconcile"]>>;
    });
    const handle = await startRunServer(createServerOptions(service, registryRoot, {
      reconcileIntervalMs: 100,
    }));

    try {
      await vi.waitFor(() => {
        expect(reconcileSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      }, { timeout: 5_000 });
      expect(maxInFlight).toBe(1);
    } finally {
      await handle.close();
    }
  });

  test("concurrent close and signal shutdown await the same in-flight reconcile drain (POL-1897)", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const emptyResult = {
      scanned: 0,
      rebuilt: [],
      classified: [],
      adopted: [],
      unresolved: [],
      skipped: [],
      noncanonical_directories: [],
      projection: { status: "not_configured" as const },
    } satisfies Awaited<ReturnType<RunService["reconcile"]>>;
    let releaseReconcile!: () => void;
    const reconcileBlocked = new Promise<void>((resolve) => {
      releaseReconcile = resolve;
    });
    let reconcileEntered!: () => void;
    const enteredReconcile = new Promise<void>((resolve) => {
      reconcileEntered = resolve;
    });
    let bootPass = true;
    let blockedPassFinished = false;
    const reconcileSpy = vi.spyOn(service, "reconcile").mockImplementation(async () => {
      if (bootPass) {
        bootPass = false;
        return emptyResult;
      }
      reconcileEntered();
      await reconcileBlocked;
      blockedPassFinished = true;
      return emptyResult;
    });
    const existingSignalHandlers = new Set(process.listeners("SIGTERM"));
    const handle = await startRunServer(createServerOptions(service, registryRoot, {
      reconcileIntervalMs: 100,
    }));
    const signalHandler = process.listeners("SIGTERM")
      .find((handler) => !existingSignalHandlers.has(handler));
    if (!signalHandler) throw new Error("run server did not install its SIGTERM handler");

    await enteredReconcile;
    let firstCloseResolved = false;
    let secondCloseResolved = false;
    const firstClosing = handle.close().then(() => {
      firstCloseResolved = true;
    });
    const secondClosing = handle.close().then(() => {
      secondCloseResolved = true;
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    signalHandler("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 250));
    // Every close caller, including the signal handler that exits in finally,
    // must stay behind the deliberately blocked pass.
    expect(firstCloseResolved).toBe(false);
    expect(secondCloseResolved).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(blockedPassFinished).toBe(false);

    releaseReconcile();
    await Promise.all([firstClosing, secondClosing]);
    expect(blockedPassFinished).toBe(true);
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    // No pass may start after close resolves.
    const callsAtClose = reconcileSpy.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(reconcileSpy.mock.calls.length).toBe(callsAtClose);
  });

  test("reconcileIntervalMs false disables the steady-state interval but not boot reconcile", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const reconcileSpy = vi.spyOn(service, "reconcile");
    const handle = await startRunServer(createServerOptions(service, registryRoot, {
      reconcileIntervalMs: false,
    }));

    try {
      expect(reconcileSpy.mock.calls.length).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(reconcileSpy.mock.calls.length).toBe(1);
    } finally {
      await handle.close();
    }
  });

  test("exposes public health and protects run routes with bearer auth", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      const livez = await fetch(`${handle.url}/livez`);
      expect(livez.status).toBe(200);
      expect(await livez.json()).toEqual({ ok: true });

      const health = await fetch(`${handle.url}/v1/internal/health`);
      expect(health.status).toBe(401);

      const metrics = await fetch(`${handle.url}/v1/internal/metrics`);
      expect(metrics.status).toBe(401);

      const unauthorized = await fetch(`${handle.url}/v1/admin/runs`);
      expect(unauthorized.status).toBe(401);

      const unauthorizedStream = await fetch(`${handle.url}/v1/admin/events/stream`);
      expect(unauthorizedStream.status).toBe(401);
    } finally {
      await handle.close();
    }
  });

  test("rejects repeated physical Authorization fields before credential verification", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      const response = await rawHttpGet(`${handle.url}/v1/admin/health`, [
        "Authorization", "Bearer secret-token",
        "Authorization", "Bearer second-token",
      ]);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      if (response.status === 401) {
        expect(response.body).toMatchObject({ error: { code: "unauthorized" } });
      }
    } finally {
      await handle.close();
    }
  });

  test("hard-deletes every unversioned and legacy route family", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    const legacyRoutes = [
      ["GET", "/health"],
      ["GET", "/metrics"],
      ["GET", "/runs"],
      ["GET", "/runs/run-legacy"],
      ["GET", "/events/stream"],
      ["GET", "/activity/interactive%3Acodex%3Alegacy"],
      ["POST", "/v1/messages"],
      ["POST", "/local-backends/runtime-config/plan"],
    ] as const;

    try {
      for (const [method, pathname] of legacyRoutes) {
        const response = await fetch(`${handle.url}${pathname}`, {
          method,
          headers: { authorization: "Bearer secret-token" },
        });
        expect(response.status, `${method} ${pathname}`).toBe(404);
        expect(await response.json(), `${method} ${pathname}`).toMatchObject({
          error: { schema_version: "calyx.error/v1", code: "not_found" },
        });
      }
    } finally {
      await handle.close();
    }
  });

  test("names only versioned admin run routes in not-found responses", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    try {
      for (const pathname of [
        "/v1/admin/runs/missing-run",
        "/v1/admin/runs/missing-run/receipt",
      ]) {
        const response = await fetch(`${handle.url}${pathname}`, {
          headers: { authorization: "Bearer secret-token" },
        });
        expect(response.status, pathname).toBe(404);
        expect(await response.json(), pathname).toMatchObject({
          error: {
            code: "not_found",
            message: `Not found: ${pathname}`,
          },
        });
      }
    } finally {
      await handle.close();
    }
  });

  test("enforces JSON media type and body limits for declared and chunked writes", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    const endpoint = `${handle.url}/v1/admin/runs`;
    try {
      const unsupported = await rawHttpRequest(endpoint, {
        headers: { authorization: "Bearer secret-token", "content-type": "text/plain" },
        body: Buffer.from("{}"),
      });
      expect(unsupported).toMatchObject({
        status: 415,
        body: { error: { schema_version: "calyx.error/v1", code: "unsupported_media_type" } },
      });

      const declared = await rawHttpRequest(endpoint, {
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
          "content-length": "1048577",
        },
        body: Buffer.alloc(0),
      });
      expect(declared).toMatchObject({
        status: 413,
        body: { error: { schema_version: "calyx.error/v1", code: "payload_too_large" } },
      });

      const chunked = await rawHttpRequest(endpoint, {
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: Buffer.alloc(1_048_577, 0x20),
        chunked: true,
      });
      expect(chunked).toMatchObject({
        status: 413,
        body: { error: { schema_version: "calyx.error/v1", code: "payload_too_large" } },
      });

      const invalidUnicodeIntent = service.createIntent({
        host: "local",
        prompt: "\ud800",
        require_execplan: false,
      });
      const invalidUnicode = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema_version: "calyx.run-launch-request/v1",
          idempotency_key: "invalid-unicode",
          topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
          intent: invalidUnicodeIntent,
        }),
      });
      expect(invalidUnicode.status).toBe(400);
      expect(await invalidUnicode.json()).toMatchObject({
        error: {
          code: "invalid_request",
          message: expect.stringContaining("lone Unicode surrogates"),
        },
      });

      const invalidUnicodeKey = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ["\ud800"]: "invalid-key" }),
      });
      expect(invalidUnicodeKey.status).toBe(400);
      expect(await invalidUnicodeKey.json()).toMatchObject({
        error: {
          code: "invalid_request",
          message: expect.stringContaining("lone Unicode surrogates"),
        },
      });

      const invalidUtf8 = await rawHttpRequest(endpoint, {
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: Buffer.concat([
          Buffer.from('{"schema_version":"calyx.run-launch-request/v1","idempotency_key":"invalid-utf8","intent":{"host":"local","prompt":"'),
          Buffer.from([0xc3, 0x28]),
          Buffer.from('","require_execplan":false}}'),
        ]),
      });
      expect(invalidUtf8.status).toBe(400);
      expect(invalidUtf8.body).toMatchObject({
        error: {
          code: "invalid_request",
          message: "Request body must be valid UTF-8 JSON.",
        },
      });

      const validIntent = service.createIntent({ host: "local", prompt: "duplicate guard", require_execplan: false });
      const intentJson = JSON.stringify(validIntent);
      for (const [label, body, duplicateName] of [
        [
          "top-level escape-equivalent",
          `{"schema_version":"calyx.run-launch-request/v1","idempotency_key":"duplicate","\\u0069dempotency_key":"duplicate","intent":${intentJson}}`,
          "idempotency_key",
        ],
        [
          "nested open dictionary",
          `{"schema_version":"calyx.run-launch-request/v1","idempotency_key":"duplicate-nested","intent":${intentJson.slice(0, -1)},"metadata":{"same":1,"same":2}}}`,
          "same",
        ],
      ] as const) {
        const duplicate = await rawHttpRequest(endpoint, {
          headers: {
            authorization: "Bearer secret-token",
            "content-type": "application/json",
          },
          body: Buffer.from(body),
        });
        expect(duplicate.status, label).toBe(400);
        expect(duplicate.body, label).toMatchObject({
          error: {
            code: "invalid_request",
            message: expect.stringContaining(`duplicate JSON object member "${duplicateName}"`),
          },
        });
      }
    } finally {
      await handle.close();
    }
  });

  test("preserves exact decoded JSON bytes and accepts only RFC JSON boundary whitespace", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const launchSpy = vi.spyOn(service, "submitDetached").mockImplementation(async (intent) => ({
      run_id: intent.run_id,
    }) as never);
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    const endpoint = `${handle.url}/v1/admin/runs`;
    try {
      const intent = service.createIntent({ host: "local", prompt: "JSON whitespace", require_execplan: false });
      const payload = JSON.stringify({
        schema_version: "calyx.run-launch-request/v1",
        idempotency_key: "json-whitespace",
        topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
        intent,
      });
      const legalBoundaryWhitespace = await rawHttpRequest(endpoint, {
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
          accept: CALYX_RUN_LAUNCH_ACCEPT_V1,
        },
        body: Buffer.from(`\t\r\n ${payload} \t\r\n`),
      });
      expect(legalBoundaryWhitespace.status).toBe(202);

      const legalWhitespaceOnly = await rawHttpRequest(endpoint, {
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: Buffer.from("\t\r\n "),
      });
      expect(legalWhitespaceOnly).toMatchObject({
        status: 400,
        body: { error: { code: "invalid_request", message: "Expected a JSON request body." } },
      });

      const invalidUnicodeBoundaryWhitespace = await rawHttpRequest(endpoint, {
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: Buffer.from(`\u00a0${payload}\u00a0`),
      });
      expect(invalidUnicodeBoundaryWhitespace).toMatchObject({
        status: 400,
        body: { error: { code: "invalid_request", message: "Request body must be valid JSON." } },
      });
    } finally {
      launchSpy.mockRestore();
      await handle.close();
    }
  });

  test("binds bearer credentials to subjects and rejects consumer access to privileged profiles", async () => {
    const service = new RunService({
      runsRoot,
      interactiveHomeDir: join(runsRoot, "empty-interactive-home"),
    }, buildDeps());
    const options = createServerOptions(service, registryRoot, { advertisedHost: "blade" });
    const handle = await startRunServer({
      ...options,
      credentials: [
        ...options.credentials,
        {
          client_id: "switchboard",
          credential_tier: "consumer",
          verifier: hashConsumerApiBearer("consumer-token"),
          verifier_env: "CALYX_CONSUMER_API_TEST_CONSUMER_VERIFIER",
          address_grants: { send_as: ["client:switchboard@blade"], read: ["run:*"] },
        },
        {
          client_id: "daemon:carbon",
          credential_tier: "internal_runtime",
          verifier: hashConsumerApiBearer("foreign-daemon-token"),
          verifier_env: "CALYX_CONSUMER_API_TEST_DAEMON_CARBON_VERIFIER",
          address_grants: { send_as: ["client:daemon.carbon@carbon"], read: ["host:carbon"] },
        },
      ],
    });

    try {
      const missing = await fetch(`${handle.url}/v1/consumer-probe`);
      expect(missing.status).toBe(401);
      expect(await missing.json()).toEqual({
        error: {
          schema_version: "calyx.error/v1",
          code: "unauthorized",
          message: "A recognized bearer credential is required.",
          retryable: false,
        },
      });

      const consumer = await fetch(`${handle.url}/v1/consumer-probe`, {
        headers: { authorization: "Bearer consumer-token" },
      });
      expect(consumer.status).toBe(404);

      for (const pathname of ["/runs", "/health", "/local-backends/runtime-config/plan"]) {
        const deleted = await fetch(`${handle.url}${pathname}`, {
          headers: { authorization: "Bearer consumer-token" },
        });
        expect(deleted.status).toBe(404);
        expect(await deleted.json()).toMatchObject({
          error: {
            schema_version: "calyx.error/v1",
            code: "not_found",
          },
        });
      }

      const forbidden = await fetch(`${handle.url}/v1/internal/health`, {
        headers: { authorization: "Bearer consumer-token" },
      });
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toMatchObject({
        error: {
          schema_version: "calyx.error/v1",
          code: "profile_forbidden",
          details: { credential_tier: "consumer" },
        },
      });

      const controlPlane = await fetch(`${handle.url}/v1/internal/health`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(controlPlane.status).toBe(403);
      const controlPlaneHealth = await fetch(`${handle.url}/v1/admin/health`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(controlPlaneHealth.status).toBe(200);
      const controlPlaneHealthPayload = await controlPlaneHealth.json() as Record<string, unknown>;
      expect(controlPlaneHealthPayload).toMatchObject({ schema_version: "calyx.admin-health/v1" });
      expect(controlPlaneHealthPayload).not.toHaveProperty("pid");
      expect(controlPlaneHealthPayload).not.toHaveProperty("env");
      expect(controlPlaneHealthPayload).not.toHaveProperty("active_run_ids");
      const controlPlaneConsumer = await fetch(`${handle.url}/v1/runs`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(controlPlaneConsumer.status).toBe(200);
      const controlPlaneAdmin = await fetch(`${handle.url}/v1/admin/runs`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(controlPlaneAdmin.status).toBe(200);

      const wrongClient = await fetch(`${handle.url}/health`, {
        headers: { authorization: "Bearer not-any-client-token" },
      });
      expect(wrongClient.status).toBe(401);

      const daemon = await fetch(`${handle.url}/v1/internal/health`, {
        headers: { authorization: "Bearer self-daemon-token" },
      });
      expect(daemon.status).toBe(200);
      const daemonConsumer = await fetch(`${handle.url}/v1/runs`, {
        headers: { authorization: "Bearer self-daemon-token" },
      });
      const daemonAdmin = await fetch(`${handle.url}/v1/admin/health`, {
        headers: { authorization: "Bearer self-daemon-token" },
      });
      expect(daemonAdmin.status).toBe(403);
      expect(daemonConsumer.status).toBe(403);
      expect(await daemonConsumer.json()).toMatchObject({
        error: {
          code: "profile_forbidden",
          message: "Credential daemon:blade cannot use consumer_v1 operations.",
        },
      });

      for (const [method, pathname] of [
        ["GET", "/v1/internal/health"],
        ["GET", "/v1/internal/metrics"],
        ["POST", "/v1/internal/runs/reconcile"],
        ["POST", "/v1/internal/runtime-config/plan"],
        ["POST", "/v1/internal/runtime-config/apply"],
        ["POST", "/v1/internal/runtime-config/verify"],
      ] as const) {
        const foreign = await fetch(`${handle.url}${pathname}`, {
          method,
          headers: { authorization: "Bearer foreign-daemon-token" },
        });
        expect(foreign.status, `${method} ${pathname}`).toBe(403);
        expect(await foreign.json(), `${method} ${pathname}`).toMatchObject({
          error: { code: "internal_subject_forbidden", schema_version: "calyx.error/v1" },
        });
      }
    } finally {
      await handle.close();
    }
  });

  test("refuses direct server composition with a mis-tiered daemon subject", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const options = createServerOptions(service, registryRoot);
    await expect(startRunServer({
      ...options,
      credentials: options.credentials.map((credential) => credential.client_id.startsWith("daemon:")
        ? { ...credential, credential_tier: "consumer" as const }
        : credential),
    })).rejects.toThrow("if and only if client_id is daemon:<host>");
  });

  test("rejects an explicit Fetch-forbidden port before publishing a listener or descriptor", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const descriptorPath = join(registryRoot, "run-serve", "descriptor.json");

    await expect(startRunServer({
      ...createServerOptions(service, registryRoot),
      port: 6667,
    })).rejects.toMatchObject({
      name: "RunServerPortError",
      code: "fetch_forbidden_port",
      requestedPort: 6667,
      assignedPort: 6667,
      attempts: 0,
    } satisfies Partial<RunServerPortError>);
    await expect(readFile(descriptorPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rebinds a port-0 listener whose first assignment is forbidden by Fetch", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const realAddress = NetServer.prototype.address;
    let addressReads = 0;
    vi.spyOn(NetServer.prototype, "address").mockImplementation(function (this: NetServer) {
      addressReads += 1;
      if (addressReads === 1) {
        return { address: "127.0.0.1", family: "IPv4", port: 6667 };
      }
      return realAddress.call(this);
    });
    const closeSpy = vi.spyOn(NetServer.prototype, "close");

    const handle = await startRunServer(createServerOptions(service, registryRoot));
    try {
      expect(addressReads).toBe(2);
      expect(new URL(handle.url).port).not.toBe("6667");
      expect(closeSpy).toHaveBeenCalledTimes(1);
      const live = await fetch(`${handle.url}/livez`);
      expect(live.status).toBe(200);
    } finally {
      await handle.close();
    }
    expect(closeSpy).toHaveBeenCalledTimes(2);
  });

  test("bounds forbidden port-0 assignments and closes every rejected listener", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const descriptorPath = join(registryRoot, "run-serve", "descriptor.json");
    vi.spyOn(NetServer.prototype, "address").mockReturnValue({
      address: "127.0.0.1",
      family: "IPv4",
      port: 6667,
    });
    const closeSpy = vi.spyOn(NetServer.prototype, "close");

    await expect(startRunServer(createServerOptions(service, registryRoot))).rejects.toMatchObject({
      name: "RunServerPortError",
      code: "fetch_compatible_ephemeral_port_unavailable",
      requestedPort: 0,
      assignedPort: 6667,
      attempts: 16,
    } satisfies Partial<RunServerPortError>);
    expect(closeSpy).toHaveBeenCalledTimes(16);
    await expect(readFile(descriptorPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("preserves the primary startup error and releases server-owned projection state", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const blockedRegistryRoot = join(registryRoot, "not-a-directory");
    await writeFile(blockedRegistryRoot, "blocks descriptor setup", "utf8");

    const nativeProjectionClose = RunIndexProjection.prototype.close;
    const projectionCloseSpy = vi.spyOn(RunIndexProjection.prototype, "close")
      .mockImplementationOnce(function (this: RunIndexProjection) {
        nativeProjectionClose.call(this);
        throw Object.assign(new Error("simulated projection cleanup failure"), { code: "EIO" });
      });
    const nativeClose = NetServer.prototype.close;
    const listenerCloseSpy = vi.spyOn(NetServer.prototype, "close").mockImplementation(function (
      this: NetServer,
      callback?: (error?: Error) => void,
    ) {
      return nativeClose.call(this, () => {
        callback?.(Object.assign(new Error("simulated listener cleanup failure"), { code: "EIO" }));
      });
    });

    try {
      await expect(startRunServer(createServerOptions(service, blockedRegistryRoot)))
        .rejects.toMatchObject({ code: "EEXIST" });
      expect(projectionCloseSpy).toHaveBeenCalledTimes(1);
    } finally {
      listenerCloseSpy.mockRestore();
    }

    const handle = await startRunServer(createServerOptions(service, registryRoot));
    await handle.close();
    expect(projectionCloseSpy).toHaveBeenCalledTimes(2);
  });

  test("refuses message host truth that reclassifies a pinned local identity as remote", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const options = createServerOptions(service, registryRoot, {
      advertisedHost: "blade",
      messageHostAliases: { blade: "worm" },
    });
    await expect(startRunServer(options)).rejects.toThrow(
      "Message host identity \"blade\" is pinned local as blade but maps to worm.",
    );
  });

  test("pins the canonical self-daemon subject at startup even if the hostname callback later changes", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const options = createServerOptions(service, registryRoot, { advertisedHost: "worm" });
    let currentHostname = "blade";
    const handle = await startRunServer({
      ...options,
      hostname: () => currentHostname,
      credentials: [
        ...options.credentials.filter((credential) => !credential.client_id.startsWith("daemon:")),
        {
          client_id: "daemon:blade",
          credential_tier: "internal_runtime",
          verifier: hashConsumerApiBearer("pinned-blade-token"),
          verifier_env: "CALYX_CONSUMER_API_TEST_PINNED_BLADE_VERIFIER",
          address_grants: { send_as: ["client:daemon:blade@blade"], read: ["host:blade"] },
        },
        {
          client_id: "daemon:carbon",
          credential_tier: "internal_runtime",
          verifier: hashConsumerApiBearer("mutable-carbon-token"),
          verifier_env: "CALYX_CONSUMER_API_TEST_MUTABLE_CARBON_VERIFIER",
          address_grants: { send_as: ["client:daemon:carbon@carbon"], read: ["host:carbon"] },
        },
        {
          client_id: "daemon:blade.evil",
          credential_tier: "internal_runtime",
          verifier: hashConsumerApiBearer("suffix-blade-token"),
          verifier_env: "CALYX_CONSUMER_API_TEST_SUFFIX_BLADE_VERIFIER",
          address_grants: { send_as: ["client:daemon:blade.evil@blade.evil"], read: ["host:blade.evil"] },
        },
      ],
    });
    try {
      currentHostname = "carbon";
      const pinned = await fetch(`${handle.url}/v1/internal/health`, {
        headers: { authorization: "Bearer pinned-blade-token" },
      });
      expect(pinned.status).toBe(200);
      const mutable = await fetch(`${handle.url}/v1/internal/health`, {
        headers: { authorization: "Bearer mutable-carbon-token" },
      });
      expect(mutable.status).toBe(403);
      expect(await mutable.json()).toMatchObject({ error: { code: "internal_subject_forbidden" } });
      const suffixCollision = await fetch(`${handle.url}/v1/internal/health`, {
        headers: { authorization: "Bearer suffix-blade-token" },
      });
      expect(suffixCollision.status).toBe(403);
      expect(await suffixCollision.json()).toMatchObject({ error: { code: "internal_subject_forbidden" } });

      const driftedRuntimeTarget = await fetch(`${handle.url}/v1/internal/runtime-config/plan`, {
        method: "POST",
        headers: {
          authorization: "Bearer pinned-blade-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          contractVersion: "host-backend/v1",
          backend: "runtime-config",
          options: { host: "carbon", components: ["codex"] },
        }),
      });
      expect(driftedRuntimeTarget.status).toBe(409);
      expect(await driftedRuntimeTarget.json()).toMatchObject({
        error: { message: expect.stringContaining("requested carbon, but server is blade") },
      });
    } finally {
      await handle.close();
    }
  });

  test("rejects a recognized consumer credential at every admin and internal operation", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const options = createServerOptions(service, registryRoot);
    const handle = await startRunServer({
      ...options,
      credentials: [
        ...options.credentials,
        {
          client_id: "consumer-probe",
          credential_tier: "consumer",
          verifier: hashConsumerApiBearer("consumer-probe-token"),
          verifier_env: "CALYX_CONSUMER_API_TEST_CONSUMER_PROBE_VERIFIER",
          address_grants: { send_as: ["client:consumer-probe@blade"], read: ["run:*"] },
        },
      ],
    });

    try {
      const privileged = HTTP_OPERATION_DESCRIPTORS.filter((operation) => operation.profile !== "consumer_v1");
      expect(privileged.length).toBeGreaterThan(0);
      for (const operation of privileged) {
        const pathname = operation.path.replaceAll(/\{[^}]+\}/g, "probe");
        const response = await fetch(`${handle.url}${pathname}`, {
          method: operation.method,
          headers: { authorization: "Bearer consumer-probe-token" },
        });
        expect(response.status, `${operation.method} ${operation.path}`).toBe(403);
        if (operation.method !== "HEAD") {
          expect(await response.json(), `${operation.method} ${operation.path}`).toMatchObject({
            error: {
              schema_version: "calyx.error/v1",
              code: "profile_forbidden",
              details: { required_profile: operation.profile, credential_tier: "consumer" },
            },
          });
        }
      }
    } finally {
      await handle.close();
    }
  });

  test("sanitizes unexpected internal failures at the HTTP boundary", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const rawInternalMessage = "sqlite failed at /secret/state/calyx.db";
    const listSpy = vi.spyOn(service, "listActivitySnapshotPage").mockRejectedValue(new Error(rawInternalMessage));
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    try {
      const response = await fetch(`${handle.url}/v1/runs`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain(rawInternalMessage);
      expect(JSON.parse(text)).toEqual({
        error: {
          schema_version: "calyx.error/v1",
          code: "internal_error",
          message: "The server could not complete the request.",
        },
      });
    } finally {
      listSpy.mockRestore();
      await handle.close();
    }
  });

  test("applies central query validation before operation-specific policy errors", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    try {
      const forbiddenEvent = await fetch(`${handle.url}/v1/events/observe?event_type=daemon.started`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(forbiddenEvent.status).toBe(400);
      expect(await forbiddenEvent.json()).toMatchObject({
        error: { code: "consumer_event_type_forbidden" },
      });

      for (const path of [
        "/v1/monitors?limit=0",
        "/v1/monitors/wakes?limit=nope",
        "/v1/admin/monitors?limit=0",
        "/v1/admin/monitors/wakes?limit=nope",
        "/v1/leases?resource_kind=future-kind",
      ]) {
        const response = await fetch(`${handle.url}${path}`, {
          headers: { authorization: "Bearer secret-token" },
        });
        expect(response.status, path).toBe(400);
        expect(await response.json(), path).toMatchObject({ error: { code: "invalid_request" } });
      }
    } finally {
      await handle.close();
    }
  });

  test("consumer message submission is inert, subject-idempotent, and filtered before pagination", async () => {
    const stateStoreOptions = { env: { ...process.env, CALYX_STATE_HOME: join(runsRoot, "consumer-message-state") } };
    await applyStateMigrations({ storeOptions: stateStoreOptions });
    const receiptBlocker = await openStateStore(stateStoreOptions);
    try {
      await writeFile(join(receiptBlocker.paths.stateDir, "receipts"), "block receipt directory creation", "utf8");
    } finally {
      receiptBlocker.db.close();
    }
    const service = new RunService({ runsRoot }, buildDeps());
    const options = createServerOptions(service, registryRoot, {
      advertisedHost: "blade",
      stateStoreOptions,
      messageHostAliases: {
        worm: "worm",
        "worm.internal.example": "worm",
        "blade.remote.example": "worm",
      },
    });
    const handle = await startRunServer({
      ...options,
      hostname: () => "blade.internal.example",
      receiptMirrorRetryIntervalMs: 60_000,
      credentials: [
        ...options.credentials,
        {
          client_id: "switchboard",
          credential_tier: "consumer",
          verifier: hashConsumerApiBearer("switch-token"),
          verifier_env: "CALYX_CONSUMER_API_TEST_SWITCH_VERIFIER",
          address_grants: {
            send_as: ["client:switchboard@blade"],
            read: ["role:reviewer@blade"],
          },
        },
        {
          client_id: "spectator",
          credential_tier: "consumer",
          verifier: hashConsumerApiBearer("spectator-token"),
          verifier_env: "CALYX_CONSUMER_API_TEST_SPECTATOR_VERIFIER",
          address_grants: { send_as: ["client:spectator@blade"], read: [] },
        },
      ],
    });
    const consumerHeaders = {
      authorization: "Bearer switch-token",
      "content-type": "application/json",
    };
    const requestBody = {
      schema_version: "calyx.msg-send/v1",
      idempotency_key: "consumer-send-1",
      recipient_address: "role:reviewer@blade",
      reply_address: "client:switchboard@blade",
      subject: "Review this result",
      body: "The correspondence must remain inert.",
      thread_key: "mixed-thread",
    };

    try {
      const opened = await openStateStore(stateStoreOptions);
      try {
        createMessage(opened.db, {
          message_id: "msg_unauthorized_first",
          sender: "role:outsider@blade",
          recipient_address: "role:secret@blade",
          recipient_class: "directed",
          subject: "must not perturb pagination",
          thread_key: "mixed-thread",
          now: "2026-01-01T00:00:00.000Z",
        });
      } finally {
        opened.db.close();
      }

      const sent = await fetch(`${handle.url}/v1/messages/send`, {
        method: "POST",
        headers: { ...consumerHeaders, "x-calyx-asserted-actor": "operator:one" },
        body: JSON.stringify(requestBody),
      });
      expect(sent.status).toBe(200);
      const sentBody = await sent.json() as Record<string, unknown>;
      expect(sentBody).toMatchObject({
        schema_version: "calyx.msg-send-result/v1",
        inserted: true,
        delivery_state: "inert",
        message: {
          schema_version: "calyx.message-observation/v1",
          sender: "client:switchboard@blade",
          recipient_address: "role:reviewer@blade",
          subject: "Review this result",
        },
      });
      expect(JSON.stringify(sentBody)).not.toMatch(/payload|receipt_path|claimed_by|delivery_binding/);
      const sentMessage = sentBody["message"] as { message_id: string; body_locator: string };

      const fqdnAliasBody = {
        ...requestBody,
        idempotency_key: "consumer-send-fqdn-alias",
        recipient_address: "role:fqdn-reviewer@blade.internal.example",
        reply_address: "client:switchboard@blade.internal.example",
        thread_key: "fqdn-alias-thread",
      };
      const fqdnAlias = await fetch(`${handle.url}/v1/messages/send`, {
        method: "POST",
        headers: consumerHeaders,
        body: JSON.stringify(fqdnAliasBody),
      });
      expect(fqdnAlias.status).toBe(200);
      const fqdnAliasResult = await fqdnAlias.json();
      expect(fqdnAliasResult).toMatchObject({
        message: {
          sender: "client:switchboard@blade",
          recipient_address: "role:fqdn-reviewer@blade",
        },
      });
      const canonicalAliasReplay = await fetch(`${handle.url}/v1/messages/send`, {
        method: "POST",
        headers: consumerHeaders,
        body: JSON.stringify({
          ...fqdnAliasBody,
          recipient_address: "role:fqdn-reviewer@blade",
          reply_address: "client:switchboard@blade",
        }),
      });
      expect(canonicalAliasReplay.status).toBe(200);
      expect(await canonicalAliasReplay.json()).toEqual(fqdnAliasResult);

      for (const [label, recipientAddress, replyAddress, errorCode] of [
        ["noncanonical-recipient", "role:Bad@blade", requestBody.reply_address, "invalid_recipient_address"],
        ["noncanonical-reply", requestBody.recipient_address, "role:Bad@blade", "invalid_reply_address"],
        ["local-suffix-collision", "role:reviewer@blade.evil", requestBody.reply_address, "invalid_recipient_address"],
        ["unknown-remote-host", "role:reviewer@attacker.example", requestBody.reply_address, "invalid_recipient_address"],
      ] as const) {
        const rejected = await fetch(`${handle.url}/v1/messages/send`, {
          method: "POST",
          headers: consumerHeaders,
          body: JSON.stringify({
            ...requestBody,
            idempotency_key: `consumer-send-${label}`,
            recipient_address: recipientAddress,
            reply_address: replyAddress,
          }),
        });
        expect(rejected.status, label).toBe(400);
        expect(await rejected.json(), label).toMatchObject({
          error: { code: errorCode, schema_version: "calyx.error/v1" },
        });
      }
      const rejectedState = await openStateStore(stateStoreOptions);
      try {
        const rejectedReceipts = rejectedState.db.prepare(
          `SELECT COUNT(*) AS count FROM api_idempotency
           WHERE subject = 'switchboard'
             AND idempotency_key IN (?, ?, ?, ?)`,
        ).get(
          "consumer-send-noncanonical-recipient",
          "consumer-send-noncanonical-reply",
          "consumer-send-local-suffix-collision",
          "consumer-send-unknown-remote-host",
        ) as { count: number | bigint };
        expect(Number(rejectedReceipts.count)).toBe(0);
        const attackerEffects = rejectedState.db.prepare(
          `SELECT
             (SELECT COUNT(*) FROM messages WHERE recipient_host = 'attacker.example') AS messages,
             (SELECT COUNT(*) FROM outbox WHERE target_host = 'attacker.example') AS outbox`,
        ).get() as { messages: number | bigint; outbox: number | bigint };
        expect(Number(attackerEffects.messages)).toBe(0);
        expect(Number(attackerEffects.outbox)).toBe(0);
      } finally {
        rejectedState.db.close();
      }

      const mirrorState = await openStateStore(stateStoreOptions);
      try {
        const row = mirrorState.db.prepare(
          "SELECT status, attempt_count, last_error_code FROM message_receipt_mirrors WHERE message_id = ?",
        ).get(sentMessage.message_id) as { status: string; attempt_count: number; last_error_code: string };
        expect(row).toMatchObject({
          status: "pending",
          attempt_count: 1,
          last_error_code: expect.any(String),
        });
      } finally {
        mirrorState.db.close();
      }

      const text = await fetch(`${handle.url}${sentMessage.body_locator}?from=4`, {
        headers: { authorization: "Bearer switch-token" },
      });
      expect(text.status).toBe(200);
      expect(await text.json()).toMatchObject({
        schema_version: "calyx.message-text/v1",
        message_id: sentMessage.message_id,
        text: "correspondence must remain inert.",
        text_cursor: { returned: [4, expect.any(Number)] },
      });
      const concealedText = await fetch(`${handle.url}${sentMessage.body_locator}`, {
        headers: { authorization: "Bearer spectator-token" },
      });
      expect(concealedText.status).toBe(404);
      expect(await concealedText.json()).toMatchObject({ error: { code: "message_unknown" } });

      const crossHost = await fetch(`${handle.url}/v1/messages/send`, {
        method: "POST",
        headers: consumerHeaders,
        body: JSON.stringify({
          ...requestBody,
          idempotency_key: "consumer-send-cross-host",
          recipient_address: "role:reviewer@blade.remote.example",
          thread_key: "cross-host-thread",
        }),
      });
      expect(crossHost.status).toBe(202);
      const crossHostBody = await crossHost.json() as {
        delivery_state: string;
        operation: { locator: string; status: string };
        message: { recipient_address: string };
      };
      expect(crossHostBody).toMatchObject({
        delivery_state: "outbox",
        message: { recipient_address: "role:reviewer@worm" },
        operation: { status: "accepted", locator: expect.stringMatching(/^\/v1\/message-operations\//) },
      });
      const canonicalCrossHostReplay = await fetch(`${handle.url}/v1/messages/send`, {
        method: "POST",
        headers: consumerHeaders,
        body: JSON.stringify({
          ...requestBody,
          idempotency_key: "consumer-send-cross-host",
          recipient_address: "role:reviewer@worm",
          thread_key: "cross-host-thread",
        }),
      });
      expect(canonicalCrossHostReplay.status).toBe(202);
      expect(await canonicalCrossHostReplay.json()).toEqual(crossHostBody);
      const pendingOperation = await fetch(`${handle.url}${crossHostBody.operation.locator}`, {
        headers: { authorization: "Bearer switch-token" },
      });
      expect(pendingOperation.status).toBe(200);
      expect(await pendingOperation.json()).toMatchObject({
        schema_version: "calyx.message-operation/v1",
        status: "pending",
      });
      const operationId = decodeURIComponent(crossHostBody.operation.locator.split("/").at(-1)!);
      const operationClaimedAt = new Date().toISOString();
      const operationState = await openStateStore(stateStoreOptions);
      try {
        expect(claimMessageOutboxAttempt(operationState.db, operationId, {
          attempt_id: "server-operation-attempt",
          attempt_ttl_ms: 1,
          now: operationClaimedAt,
        })).toMatchObject({ status: "in_flight" });
      } finally {
        operationState.db.close();
      }
      const inFlightOperation = await fetch(`${handle.url}${crossHostBody.operation.locator}`, {
        headers: { authorization: "Bearer switch-token" },
      });
      expect(inFlightOperation.status).toBe(200);
      const inFlightBody = await inFlightOperation.json() as Record<string, unknown>;
      expect(inFlightBody).toMatchObject({
        schema_version: "calyx.message-operation/v1",
        status: "in_flight",
        terminal: false,
      });
      expect(inFlightBody).not.toHaveProperty("receipt");

      const expiredAttemptState = await openStateStore(stateStoreOptions);
      try {
        expect(recoverExpiredMessageOutboxAttempts(expiredAttemptState.db, {
          now: new Date(Date.parse(operationClaimedAt) + 4 * 24 * 60 * 60 * 1000).toISOString(),
        })).toEqual([
          expect.objectContaining({ status: "indeterminate" }),
        ]);
      } finally {
        expiredAttemptState.db.close();
      }
      const indeterminateOperation = await fetch(`${handle.url}${crossHostBody.operation.locator}`, {
        headers: { authorization: "Bearer switch-token" },
      });
      expect(indeterminateOperation.status).toBe(200);
      expect(await indeterminateOperation.json()).toMatchObject({
        schema_version: "calyx.message-operation/v1",
        status: "indeterminate",
        terminal: true,
        receipt: {
          schema_version: "calyx.message-operation-receipt/v1",
          outcome: "indeterminate",
        },
      });
      const concealedOperation = await fetch(`${handle.url}${crossHostBody.operation.locator}`, {
        headers: { authorization: "Bearer spectator-token" },
      });
      expect(concealedOperation.status).toBe(404);
      expect(await concealedOperation.json()).toMatchObject({ error: { code: "message_operation_unknown" } });

      await rm(join(receiptBlocker.paths.stateDir, "receipts"));

      const replay = await fetch(`${handle.url}/v1/messages/send`, {
        method: "POST",
        headers: consumerHeaders,
        body: JSON.stringify({
          subject: requestBody.subject,
          reply_address: requestBody.reply_address,
          recipient_address: requestBody.recipient_address,
          idempotency_key: requestBody.idempotency_key,
          schema_version: requestBody.schema_version,
          thread_key: requestBody.thread_key,
          body: requestBody.body,
        }),
      });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(sentBody);
      const recovered = await openStateStore(stateStoreOptions);
      try {
        const mirror = recovered.db.prepare(
          "SELECT status, attempt_count, receipt_path, last_error_code FROM message_receipt_mirrors WHERE message_id = ?",
        ).get(sentMessage.message_id) as {
          status: string;
          attempt_count: number;
          receipt_path: string;
          last_error_code: string | null;
        };
        expect(mirror).toMatchObject({
          status: "completed",
          attempt_count: 2,
          receipt_path: join(receiptBlocker.paths.stateDir, "receipts", "messages.jsonl"),
          last_error_code: null,
        });
        const receiptLines = (await readFile(mirror.receipt_path, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { message: { message_id: string } })
          .filter((line) => line.message.message_id === sentMessage.message_id);
        expect(receiptLines).toHaveLength(1);
      } finally {
        recovered.db.close();
      }
      const doctor = await fetch(`${handle.url}/v1/messages/doctor`, {
        headers: { authorization: "Bearer switch-token" },
      });
      expect(doctor.status).toBe(200);
      expect(await doctor.json()).toMatchObject({
        receipt_mirrors: { pending: 2, completed: 1 },
      });
      const spectatorDoctor = await fetch(`${handle.url}/v1/messages/doctor`, {
        headers: { authorization: "Bearer spectator-token" },
      });
      expect(spectatorDoctor.status).toBe(200);
      expect(await spectatorDoctor.json()).toMatchObject({
        subject: "spectator",
        counts: { total: 0 },
        receipt_mirrors: { pending: 0, completed: 0 },
      });

      const conflict = await fetch(`${handle.url}/v1/messages/send`, {
        method: "POST",
        headers: consumerHeaders,
        body: JSON.stringify({ ...requestBody, subject: "Changed request" }),
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: { code: "idempotency_conflict" } });

      for (const [recipientAddress, recipientKind, idempotencyKey] of [
        ["run:danger", "run", "consumer-send-run"],
        ["interactive:codex:danger", "interactive", "consumer-send-interactive"],
        ["codex:blade:danger", "interactive", "consumer-send-authorship-alias"],
      ] as const) {
        const executionTarget = await fetch(`${handle.url}/v1/messages/send`, {
          method: "POST",
          headers: consumerHeaders,
          body: JSON.stringify({
            ...requestBody,
            idempotency_key: idempotencyKey,
            recipient_address: recipientAddress,
          }),
        });
        expect(executionTarget.status, recipientAddress).toBe(403);
        expect(await executionTarget.json(), recipientAddress).toMatchObject({
          error: {
            code: "execution_recipient_forbidden",
            schema_version: "calyx.error/v1",
            details: { recipient_kind: recipientKind },
          },
        });
      }

      const inbox = await fetch(`${handle.url}/v1/messages/inbox?status=all&limit=1`, {
        headers: { authorization: "Bearer switch-token" },
      });
      expect(inbox.status).toBe(200);
      const inboxBody = await inbox.json() as { next_cursor: string };
      expect(inboxBody).toMatchObject({
        count: 1,
        truncated: true,
        next_cursor: expect.any(String),
        messages: [{ recipient_address: "role:reviewer@blade" }],
      });
      for (const [label, path, token] of [
        ["tampered", "/v1/messages/inbox?status=all&cursor=not-a-cursor", "switch-token"],
        [
          "filter-mismatch",
          `/v1/messages/inbox?status=open&cursor=${encodeURIComponent(inboxBody.next_cursor)}`,
          "switch-token",
        ],
        [
          "subject-mismatch",
          `/v1/messages/inbox?status=all&cursor=${encodeURIComponent(inboxBody.next_cursor)}`,
          "spectator-token",
        ],
      ] as const) {
        const invalidCursor = await fetch(`${handle.url}${path}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(invalidCursor.status, label).toBe(400);
        expect(await invalidCursor.json(), label).toMatchObject({ error: { code: "invalid_request" } });
      }

      const malformedScope = await fetch(`${handle.url}/v1/messages/inbox?scope=not-an-address`, {
        headers: { authorization: "Bearer switch-token" },
      });
      expect(malformedScope.status).toBe(400);
      expect(await malformedScope.json()).toMatchObject({ error: { code: "invalid_request" } });

      const thread = await fetch(`${handle.url}/v1/messages/threads/mixed-thread?limit=10`, {
        headers: { authorization: "Bearer switch-token" },
      });
      expect(thread.status).toBe(200);
      const threadBody = await thread.json() as { messages: Array<{ message_id: string }> };
      expect(threadBody.messages).toHaveLength(1);
      expect(threadBody.messages[0]?.message_id).not.toBe("msg_unauthorized_first");
      const invalidThreadCursor = await fetch(
        `${handle.url}/v1/messages/threads/mixed-thread?cursor=not-a-cursor`,
        { headers: { authorization: "Bearer switch-token" } },
      );
      expect(invalidThreadCursor.status).toBe(400);
      expect(await invalidThreadCursor.json()).toMatchObject({ error: { code: "invalid_request" } });

      const actorBound = await fetch(`${handle.url}/v1/messages/send`, {
        method: "POST",
        headers: consumerHeaders,
        body: JSON.stringify({
          ...requestBody,
          idempotency_key: "consumer-send-actor",
          recipient_address: "role:idempotency-probe@blade",
          thread_key: "idempotency-actor",
        }),
      });
      expect(actorBound.status).toBe(200);
      const actorReplay = await fetch(`${handle.url}/v1/messages/send`, {
        method: "POST",
        headers: { ...consumerHeaders, "x-calyx-asserted-actor": "operator:two" },
        body: JSON.stringify({
          ...requestBody,
          idempotency_key: "consumer-send-actor",
          recipient_address: "role:idempotency-probe@blade",
          thread_key: "idempotency-actor",
        }),
      });
      expect(actorReplay.status).toBe(200);
      expect(await actorReplay.json()).toEqual(await actorBound.json());

      const absentBody = await fetch(`${handle.url}/v1/messages/send`, {
        method: "POST",
        headers: consumerHeaders,
        body: JSON.stringify({
          ...requestBody,
          idempotency_key: "consumer-send-presence",
          recipient_address: "role:idempotency-probe@blade",
          thread_key: "idempotency-presence",
          body: undefined,
        }),
      });
      expect(absentBody.status).toBe(200);
      const emptyBodyConflict = await fetch(`${handle.url}/v1/messages/send`, {
        method: "POST",
        headers: consumerHeaders,
        body: JSON.stringify({
          ...requestBody,
          idempotency_key: "consumer-send-presence",
          recipient_address: "role:idempotency-probe@blade",
          thread_key: "idempotency-presence",
          body: "",
        }),
      });
      expect(emptyBodyConflict.status).toBe(409);
      expect(await emptyBodyConflict.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    } finally {
      await handle.close();
    }
  });

  test("consumer message submission atomically binds concurrent idempotency keys", async () => {
    const stateStoreOptions = { env: { ...process.env, CALYX_STATE_HOME: join(runsRoot, "consumer-message-atomic-state") } };
    await applyStateMigrations({ storeOptions: stateStoreOptions });
    const service = new RunService({ runsRoot }, buildDeps());
    const options = createServerOptions(service, registryRoot, { advertisedHost: "blade", stateStoreOptions });
    const handle = await startRunServer({
      ...options,
      credentials: [
        ...options.credentials,
        {
          client_id: "switchboard-atomic",
          credential_tier: "consumer",
          verifier: hashConsumerApiBearer("switch-atomic-token"),
          verifier_env: "CALYX_CONSUMER_API_TEST_SWITCH_ATOMIC_VERIFIER",
          address_grants: {
            send_as: ["client:switchboard-atomic@blade"],
            read: ["role:reviewer@blade"],
          },
        },
      ],
    });
    const headers = {
      authorization: "Bearer switch-atomic-token",
      "content-type": "application/json",
    };
    const requestBody = {
      schema_version: "calyx.msg-send/v1",
      idempotency_key: "concurrent-same-request",
      recipient_address: "role:reviewer@blade",
      reply_address: "client:switchboard-atomic@blade",
      subject: "Atomic send",
      body: "Only one message and one API receipt may be committed.",
    };
    const send = async (body: typeof requestBody): Promise<{ status: number; body: unknown }> => {
      const response = await fetch(`${handle.url}/v1/messages/send`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };

    try {
      const sameRequest = await Promise.all([send(requestBody), send(requestBody)]);
      expect(sameRequest.map((result) => result.status)).toEqual([200, 200]);
      expect(sameRequest[0]?.body).toEqual(sameRequest[1]?.body);
      expect(sameRequest[0]?.body).toMatchObject({
        schema_version: "calyx.msg-send-result/v1",
        inserted: true,
        message: { subject: "Atomic send" },
      });

      const conflictingRequests = await Promise.all([
        send({ ...requestBody, idempotency_key: "concurrent-conflict", subject: "First binding" }),
        send({ ...requestBody, idempotency_key: "concurrent-conflict", subject: "Second binding" }),
      ]);
      expect(conflictingRequests.map((result) => result.status).sort()).toEqual([200, 409]);
      const conflict = conflictingRequests.find((result) => result.status === 409);
      expect(conflict?.body).toMatchObject({
        error: {
          schema_version: "calyx.error/v1",
          code: "idempotency_conflict",
          details: { operation: "msg.send", reason: "request_mismatch" },
        },
      });

      const opened = await openStateStore(stateStoreOptions);
      try {
        const messageCount = opened.db.prepare(
          `SELECT COUNT(*) AS count FROM messages WHERE sender = ?`,
        ).get("client:switchboard-atomic@blade") as { count: number | bigint };
        const receiptCount = opened.db.prepare(
          `SELECT COUNT(*) AS count FROM api_idempotency WHERE subject = ? AND operation_id = 'msg.send'`,
        ).get("switchboard-atomic") as { count: number | bigint };
        expect(Number(messageCount.count)).toBe(2);
        expect(Number(receiptCount.count)).toBe(2);
      } finally {
        opened.db.close();
      }
    } finally {
      await handle.close();
    }
  });

  test("consumer message exact-wire replay survives alias remapping while canonical semantic replay remains equivalent", async () => {
    const stateStoreOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(runsRoot, "consumer-message-topology-drift") },
    };
    await applyStateMigrations({ storeOptions: stateStoreOptions });
    const credentials = {
      client_id: "switchboard-topology",
      credential_tier: "consumer" as const,
      verifier: hashConsumerApiBearer("switch-topology-token"),
      verifier_env: "CALYX_CONSUMER_API_TEST_SWITCH_TOPOLOGY_VERIFIER",
      address_grants: {
        send_as: ["client:switchboard-topology@blade"],
        read: ["role:reviewer@worm"],
      },
    };
    const startWithAliases = async (messageHostAliases: Readonly<Record<string, string>>) => {
      const service = new RunService({ runsRoot }, buildDeps());
      const options = createServerOptions(service, registryRoot, {
        advertisedHost: "blade",
        stateStoreOptions,
        messageHostAliases,
      });
      return await startRunServer({
        ...options,
        credentials: [...options.credentials, credentials],
      });
    };
    const headers = {
      authorization: "Bearer switch-topology-token",
      "content-type": "application/json",
    };
    const requestBody = {
      schema_version: "calyx.msg-send/v1",
      idempotency_key: "topology-drift-recovery",
      recipient_address: "role:reviewer@relay.internal.example",
      reply_address: "client:switchboard-topology@blade",
      subject: "Retain the admitted effect",
      body: "The retry bytes must recover the original worm submission.",
    };
    const retainedWireBytes = JSON.stringify(requestBody);

    const first = await startWithAliases({
      worm: "worm",
      carbon: "carbon",
      "relay.internal.example": "worm",
    });
    let admitted: unknown;
    try {
      const response = await fetch(`${first.url}/v1/messages/send`, {
        method: "POST",
        headers,
        body: retainedWireBytes,
      });
      expect(response.status).toBe(202);
      admitted = await response.json();
      expect(admitted).toMatchObject({
        delivery_state: "outbox",
        message: { recipient_address: "role:reviewer@worm" },
        outbox: { target_host: "worm" },
      });
    } finally {
      await first.close();
    }

    const remapped = await startWithAliases({
      worm: "worm",
      carbon: "carbon",
      "relay.internal.example": "carbon",
    });
    try {
      const exactReplay = await fetch(`${remapped.url}/v1/messages/send`, {
        method: "POST",
        headers,
        body: retainedWireBytes,
      });
      expect(exactReplay.status).toBe(202);
      expect(await exactReplay.json()).toEqual(admitted);

      const canonicalSemanticReplay = await fetch(`${remapped.url}/v1/messages/send`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...requestBody,
          recipient_address: "role:reviewer@worm",
        }),
      });
      expect(canonicalSemanticReplay.status).toBe(202);
      expect(await canonicalSemanticReplay.json()).toEqual(admitted);

      const remappedDifferentRequest = await fetch(`${remapped.url}/v1/messages/send`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...requestBody,
          body: "Changed bytes must not retarget the admitted key to carbon.",
        }),
      });
      expect(remappedDifferentRequest.status).toBe(409);
      expect(await remappedDifferentRequest.json()).toMatchObject({
        error: {
          code: "idempotency_conflict",
          details: { operation: "msg.send", reason: "request_mismatch" },
        },
      });

      const removedAliasReplay = await fetch(`${remapped.url}/v1/messages/send`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...requestBody,
          recipient_address: "role:reviewer@removed.internal.example",
        }),
      });
      expect(removedAliasReplay.status).toBe(409);
      expect(await removedAliasReplay.json()).toMatchObject({
        error: {
          code: "idempotency_conflict",
          details: { operation: "msg.send", reason: "request_mismatch" },
        },
      });

      const opened = await openStateStore(stateStoreOptions);
      try {
        expect(readApiIdempotency(
          opened.db,
          "switchboard-topology",
          "msg.send",
          requestBody.idempotency_key,
        )).toMatchObject({
          wire_request_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
          semantic_canonicalizer: "calyx.msg-send-semantic/v1",
        });
        const counts = opened.db.prepare(
          `SELECT
             (SELECT COUNT(*) FROM messages WHERE idempotency_key = ?) AS messages,
             (SELECT COUNT(*) FROM outbox WHERE target_host = 'worm') AS worm_outbox,
             (SELECT COUNT(*) FROM outbox WHERE target_host = 'carbon') AS carbon_outbox`,
        ).get(`switchboard-topology:${requestBody.idempotency_key}`) as {
          messages: number | bigint;
          worm_outbox: number | bigint;
          carbon_outbox: number | bigint;
        };
        expect(Number(counts.messages)).toBe(1);
        expect(Number(counts.worm_outbox)).toBe(1);
        expect(Number(counts.carbon_outbox)).toBe(0);
      } finally {
        opened.db.close();
      }
    } finally {
      await remapped.close();
    }
  });

  test("boot retry drains receipt work committed before any append attempt", async () => {
    const stateStoreOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(runsRoot, "message-receipt-boot-retry") },
    };
    await applyStateMigrations({ storeOptions: stateStoreOptions });
    const seeded = await openStateStore(stateStoreOptions);
    try {
      seeded.db.exec("BEGIN IMMEDIATE");
      const message = createMessage(seeded.db, {
        message_id: "msg_committed_before_append",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "survive death before append",
      }).message;
      enqueueMessageReceiptMirror(seeded.db, message.message_id);
      seeded.db.exec("COMMIT");
    } finally {
      seeded.db.close();
    }

    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer({
      ...createServerOptions(service, registryRoot, { stateStoreOptions }),
      receiptMirrorRetryIntervalMs: 100,
    });
    try {
      await vi.waitFor(async () => {
        const opened = await openStateStore(stateStoreOptions);
        try {
          const mirror = opened.db.prepare(
            "SELECT status, receipt_path FROM message_receipt_mirrors WHERE message_id = ?",
          ).get("msg_committed_before_append") as { status: string; receipt_path: string | null };
          expect(mirror).toMatchObject({ status: "completed", receipt_path: expect.any(String) });
        } finally {
          opened.db.close();
        }
      }, { timeout: 2_000, interval: 50 });
      const receiptPath = join(
        stateStoreOptions.env.CALYX_STATE_HOME,
        "receipts",
        "messages.jsonl",
      );
      const matches = (await readFile(receiptPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { message: { message_id: string } })
        .filter((line) => line.message.message_id === "msg_committed_before_append");
      expect(matches).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  test("forward migration 0022 does not manufacture admission receipts from mutable legacy messages", async () => {
    const stateStoreOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(runsRoot, "message-receipt-legacy-adoption") },
    };
    await applyStateMigrations({
      storeOptions: stateStoreOptions,
      migrations: STATE_MIGRATIONS.filter((migration) => migration.id <= "0020"),
    });
    const seeded = await openStateStore(stateStoreOptions);
    try {
      seeded.db.prepare(
        `INSERT INTO messages
           (message_id, schema_version, sender, recipient_address, recipient_class,
            subject, body, urgency, ack_required, status, created_at, updated_at,
            spooled_at, payload_json)
         VALUES ('msg_legacy_pending_mirror', 'calyx.message/v1', 'client:legacy@blade',
                 'role:reviewer@blade', 'directed', 'adopt legacy mirror work', '',
                 'normal', 0, 'pending', ?, ?, ?, ?)`,
      ).run(
        "2026-07-13T12:00:00.000Z",
        "2026-07-13T12:00:00.000Z",
        "2026-07-13T12:00:00.000Z",
        JSON.stringify({
          receipt_mirror: {
            status: "pending",
            attempt_count: 3,
            attempted_at: "2026-07-13T12:00:01.000Z",
            last_error: "legacy append failed",
          },
        }),
      );
    } finally {
      seeded.db.close();
    }

    const migrated = await applyStateMigrations({ storeOptions: stateStoreOptions });
    expect(migrated.applied.map((migration) => migration.id)).toEqual([
      "0021",
      "0022",
      "0023",
      "0024",
      "0025",
      "0026",
      "0027",
      "0028",
      "0029",
      "0030",
      "0031",
      "0032",
      "0033",
      "0034",
      "0035",
    ]);
    const migratedStore = await openStateStore(stateStoreOptions);
    try {
      expect(migratedStore.db.prepare(
        "SELECT message_id FROM message_receipt_mirrors WHERE message_id = ?",
      ).get("msg_legacy_pending_mirror")).toBeUndefined();
      const legacyMessage = migratedStore.db.prepare(
        "SELECT receipt_path, payload_json FROM messages WHERE message_id = ?",
      ).get("msg_legacy_pending_mirror") as { receipt_path: string | null; payload_json: string };
      expect(legacyMessage.receipt_path).toBeNull();
      expect(JSON.parse(legacyMessage.payload_json)).toMatchObject({
        receipt_mirror: {
          status: "pending",
          attempt_count: 3,
          last_error: "legacy append failed",
        },
      });
    } finally {
      migratedStore.db.close();
    }
  });

  test("serves admin run observations from the single named launch representation", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const launchInline = service.runInline.bind(service);
    vi.spyOn(service, "submitDetached").mockImplementation((intent, options) => launchInline(intent, options));
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      const launchRequest: RunLaunchRequest = {
        schema_version: "calyx.run-launch-request/v1",
        idempotency_key: "admin-observation-contract",
        topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
        intent: service.createIntent({
          run_id: "run:admin-observation-contract",
          host: "local",
          prompt: "Server launch",
          require_execplan: false,
        }),
      };

      const launch = await fetch(`${handle.url}/v1/admin/runs`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
          accept: CALYX_RUN_LAUNCH_ACCEPT_V1,
        },
        body: JSON.stringify(launchRequest),
      });
      expect(launch.status, await launch.clone().text()).toBe(202);
      const launched = await launch.json() as {
        run_id: string;
        status: string;
        operation: { route: string; events_route: string; receipt_route: string };
      };
      const encodedRunId = encodeURIComponent(launchRequest.intent.run_id);
      expect(launched).toMatchObject({
        run_id: "run:admin-observation-contract",
        status: "accepted",
        operation: {
          route: `/v1/admin/runs/${encodedRunId}`,
          events_route: `/v1/admin/runs/${encodedRunId}/events`,
          receipt_route: `/v1/admin/runs/${encodedRunId}/receipt`,
        },
      });

      const duplicate = await fetch(`${handle.url}/v1/admin/runs`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
          accept: CALYX_RUN_LAUNCH_ACCEPT_V1,
        },
        body: JSON.stringify(launchRequest),
      });
      expect(duplicate.status).toBe(202);
      expect(await duplicate.json()).toEqual(launched);

      const recordResponse = await fetch(`${handle.url}${launched.operation.route}`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(recordResponse.status, await recordResponse.clone().text()).toBe(200);
      const record = await recordResponse.json() as {
        schema_version: string;
        run_id: string;
        summary: string;
        launch: { mode: string; stage: string; accepted_at: string; dispatch_attempts: number; execution_id?: string };
      };
      expect(record.schema_version).toBe("calyx.run-record/v1");
      expect(record.run_id).toBe(launched.run_id);
      expect(record.summary).toContain("succeeded");
      expect(record.launch).toMatchObject({
        mode: "inline",
        stage: "executing",
        accepted_at: expect.any(String),
        dispatch_attempts: 0,
        execution_id: expect.any(String),
      });

      const receiptResponse = await fetch(`${handle.url}${launched.operation.receipt_route}`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(receiptResponse.status).toBe(200);
      const receipt = await receiptResponse.json() as { state: string; run_spec: { host: string }; integrations?: unknown };
      expect(receipt.state).toBe("succeeded");
      expect(receipt.run_spec.host).toBe("local");
      expect(receipt.integrations).toBeUndefined();

      const eventsResponse = await fetch(`${handle.url}${launched.operation.events_route}`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(eventsResponse.status).toBe(200);
      const events = await eventsResponse.json() as Array<{ event: string }>;
      expect(events.some((event) => event.event === "launch_completed")).toBe(true);

      const logsResponse = await fetch(`${handle.url}/v1/admin/runs/${launched.run_id}/logs?tail=20`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(logsResponse.status).toBe(200);
      const logs = await logsResponse.json() as {
        schema_version: string;
        run_id: string;
        entries: Array<{ kind: string; source: string; text: string }>;
        sources: Array<{ stream?: string; exists: boolean }>;
        options: { tail?: number };
      };
      expect(logs.schema_version).toBe("run-logs/v1");
      expect(logs.run_id).toBe(launched.run_id);
      expect(logs.options.tail).toBe(20);
      expect(logs.entries.some((entry) => entry.kind === "event" && entry.source === "lifecycle")).toBe(true);
      expect(logs.sources.some((source) => source.stream === "stdout" && source.exists === false)).toBe(true);

      const observationResponse = await fetch(`${handle.url}/v1/admin/runs/${launched.run_id}/observation?tail=20`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(observationResponse.status).toBe(200);
      const observation = await observationResponse.json() as {
        schema_version: string;
        run_id: string;
        logs: { sources: Array<{ stream?: string; exists: boolean }> };
        host_resources: { gpu: { provider: string; status: string } };
      };
      expect(observation.schema_version).toBe("run-observation/v1");
      expect(observation.run_id).toBe(launched.run_id);
      expect(observation.logs.sources.some((source) => source.stream === "stdout" && source.exists === false)).toBe(true);
      expect(observation.host_resources.gpu.provider).toBe("nvidia-smi");

      const listResponse = await fetch(`${handle.url}/v1/admin/runs`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(listResponse.status).toBe(200);
      const list = await listResponse.json() as {
        schema_version: string;
        count: number;
        truncated: boolean;
        runs: Array<{ run_id: string }>;
      };
      expect(list).toMatchObject({
        schema_version: "calyx.run-list/v1",
        count: expect.any(Number),
        truncated: expect.any(Boolean),
      });
      expect(list.runs.some((entry) => entry.run_id === launched.run_id)).toBe(true);

      const reconcileResponse = await fetch(`${handle.url}/v1/admin/runs/reconcile-preserving/v1`, {
        method: "POST",
        headers: { authorization: "Bearer secret-token" },
      });
      expect(reconcileResponse.status).toBe(200);
      const reconcile = await reconcileResponse.json() as { schema_version: string; scanned: number; changed: Record<string, number> };
      expect(reconcile.schema_version).toBe("calyx.admin-reconcile-result/v1");
      expect(reconcile.scanned).toBeGreaterThanOrEqual(1);
      expect(reconcile.changed).toEqual(expect.objectContaining({
        rebuilt: expect.any(Number),
        repair_pending: expect.any(Number),
      }));
      expect(reconcile).not.toHaveProperty("rebuilt");
      const internalReconcileResponse = await fetch(`${handle.url}/v1/internal/runs/reconcile`, {
        method: "POST",
        headers: { authorization: "Bearer self-daemon-token" },
      });
      expect(internalReconcileResponse.status).toBe(200);
      const internalReconcile = await internalReconcileResponse.json() as { rebuilt: string[]; repair_pending: string[] };
      expect(internalReconcile.rebuilt).toEqual(expect.any(Array));
      expect(internalReconcile.repair_pending).toEqual(expect.any(Array));
    } finally {
      await handle.close();
    }
  });

  test("returns a typed topology refusal before the HTTP launch path creates a run", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    const intent = service.createIntent({
      run_id: "run-http-stale-topology",
      host: "local",
      prompt: "Stale topology",
      require_execplan: false,
    });

    try {
      const response = await fetch(`${handle.url}/v1/admin/runs`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
          accept: CALYX_RUN_LAUNCH_ACCEPT_V1,
        },
        body: JSON.stringify({
          schema_version: "calyx.run-launch-request/v1",
          idempotency_key: "http-stale-topology",
          topology_projection_sha256: "d".repeat(64),
          intent,
        }),
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: {
          code: "workload_admission_fenced",
          retryable: false,
          details: {
            reason: "topology_mismatch",
            failed_surface: "topology",
            admission: "open",
            planned_topology_projection_sha256: "d".repeat(64),
            accepted_topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
            next_action: expect.stringContaining("Retry"),
          },
        },
      });
      await expect(service.getRunRecord(intent.run_id)).resolves.toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  test("returns exact cancellation admission, terminal, and unknown-run results", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const stopSpy = vi.spyOn(service, "stop")
      .mockResolvedValueOnce({
        schema_version: "calyx.run-cancellation-result/v1",
        status: "cancellation_requested",
        run_id: "run-stop-contract",
        requested_at: "2026-07-14T07:00:00.000Z",
        worker_ownership: "owner_free",
        settled_state: "infra_error",
      })
      .mockResolvedValueOnce({
        schema_version: "calyx.run-cancellation-result/v1",
        status: "already_terminal",
        run_id: "run-stop-contract",
      })
      .mockRejectedValueOnce(new RunNotFoundError("run-stop-contract"));
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    const stop = () => fetch(`${handle.url}/v1/admin/runs/run-stop-contract/stop`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason: "contract test" }),
    });
    try {
      const stopped = await stop();
      expect(stopped.status).toBe(200);
      expect(await stopped.json()).toEqual({
        schema_version: "calyx.run-cancellation-result/v1",
        status: "cancellation_requested",
        run_id: "run-stop-contract",
        requested_at: "2026-07-14T07:00:00.000Z",
        worker_ownership: "owner_free",
        settled_state: "infra_error",
      });
      const alreadyStopped = await stop();
      expect(alreadyStopped.status).toBe(200);
      expect(await alreadyStopped.json()).toEqual({
        schema_version: "calyx.run-cancellation-result/v1",
        status: "already_terminal",
        run_id: "run-stop-contract",
      });
      const missing = await stop();
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({
        error: {
          schema_version: "calyx.error/v1",
          code: "not_found",
        },
      });
      expect(stopSpy).toHaveBeenNthCalledWith(1, "run-stop-contract", {
        reason: "contract test",
        provenance: expect.objectContaining({
          schema_version: "calyx.provenance/v1",
          subject: "test-control-plane",
          via: "http",
        }),
      });
    } finally {
      stopSpy.mockRestore();
      await handle.close();
    }
  });

  test("HTTP owner-free stop settles the run and the 200 carries the settlement fields (POL-1897)", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot, {
      reconcileIntervalMs: false,
    }));
    try {
      // Created after boot reconcile so only the stop-path targeted reconcile
      // can settle it.
      const intent = service.createIntent({
        run_id: "run-http-owner-free-stop",
        host: "local",
        prompt: "Owner-free stop settles over HTTP",
        require_execplan: false,
      });
      const queued = await service.initializeRun(intent, { launchMode: "detached" });
      const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
      await service.store.writeSpec(intent.run_id, spec);
      await service.store.writeRunRecord(intent.run_id, {
        ...queued,
        state: "running",
        spec,
        launch: {
          ...queued.launch,
          stage: "executing",
          execution_id: "worker-crashed-before-receipt",
          execution_started_at: "2026-03-11T12:00:01.000Z",
        },
        updated_at: "2026-03-11T12:00:01.000Z",
      });

      const stopped = await fetch(`${handle.url}/v1/admin/runs/${intent.run_id}/stop`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: "operator stop" }),
      });

      // The durable settlement and the strict producer response schema must
      // agree: the 200 passes the canonical writer gate WITH the new fields.
      expect(stopped.status).toBe(200);
      expect(await stopped.json()).toMatchObject({
        schema_version: "calyx.run-cancellation-result/v1",
        status: "cancellation_requested",
        run_id: intent.run_id,
        worker_ownership: "owner_free",
        settled_state: "infra_error",
      });
      await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
        state: "infra_error",
      });
    } finally {
      await handle.close();
    }
  });

  test("HTTP stop of a possibly-live legacy run makes no ownership claim (POL-1897)", async () => {
    const service = new RunService({ runsRoot }, {
      ...buildDeps(),
      observeLegacyWorkerPid: async () => "possibly_live" as const,
    });
    const handle = await startRunServer(createServerOptions(service, registryRoot, {
      reconcileIntervalMs: false,
    }));
    try {
      const legacyPid = 45_779;
      const intent = service.createIntent({
        run_id: "run-http-legacy-possibly-live-stop",
        host: "local",
        prompt: "Possibly-live legacy publishers defer settlement over HTTP",
        require_execplan: false,
      });
      const queued = await service.initializeRun(intent, { launchMode: "detached" });
      const launchedAt = "2026-03-11T12:00:01.000Z";
      await service.store.appendEvent(intent.run_id, {
        timestamp: launchedAt,
        run_id: intent.run_id,
        source: "run-service",
        event: "launch_dispatched",
        message: "Spawned detached run worker.",
        payload: { pid: legacyPid, worker_supervisor: "direct" },
      });
      const paths = service.store.paths(intent.run_id);
      await writeFile(join(paths.runDir, "pid"), `${legacyPid}\n`, "utf8");
      const legacyRecord: Record<string, unknown> = {
        ...queued,
        state: "running",
        updated_at: launchedAt,
      };
      delete legacyRecord["launch"];
      await writeFile(paths.runRecordPath, `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");

      const stopped = await fetch(`${handle.url}/v1/admin/runs/${intent.run_id}/stop`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: "operator stop" }),
      });

      expect(stopped.status).toBe(200);
      const body = await stopped.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        schema_version: "calyx.run-cancellation-result/v1",
        status: "cancellation_requested",
        run_id: intent.run_id,
      });
      expect(body).not.toHaveProperty("worker_ownership");
      expect(body).not.toHaveProperty("settled_state");
      await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
        state: "running",
      });
    } finally {
      await handle.close();
    }
  });

  test("admin reconcile reports an incomplete bounded receipt when projection repair fails", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const reconcileSpy = vi.spyOn(service, "reconcile").mockResolvedValue({
      scanned: 3,
      rebuilt: ["run-private-1"],
      repair_pending: [],
      classified: [],
      adopted: [],
      unresolved: [],
      skipped: ["run-private-2", "run-private-3"],
      noncanonical_directories: [],
      projection: { status: "failed", reason: "private sqlite path and raw error" },
    });
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      const response = await fetch(`${handle.url}/v1/admin/runs/reconcile-preserving/v1`, {
        method: "POST",
        headers: { authorization: "Bearer secret-token" },
      });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toEqual({
        schema_version: "calyx.admin-reconcile-result/v1",
        status: "incomplete",
        scanned: 3,
        changed: {
          rebuilt: 1,
          repair_pending: 0,
          classified: 0,
          adopted: 0,
          skipped: 2,
          unresolved: 0,
          noncanonical_directories: 0,
        },
        unresolved: [],
        noncanonical_directories: [],
        projection: { status: "failed" },
        completed_at: expect.any(String),
      });
      expect(JSON.stringify(payload)).not.toContain("private sqlite path");
      const predecessor = await fetch(`${handle.url}/v1/admin/runs/reconcile`, {
        method: "POST",
        headers: { authorization: "Bearer secret-token" },
      });
      expect(predecessor.status).toBe(405);
    } finally {
      reconcileSpy.mockRestore();
      await handle.close();
    }
  });

  test("negotiates portable run launch with durable idempotency and terminal run-id conflicts", async () => {
    const stateStoreOptions = { env: { ...process.env, CALYX_STATE_HOME: join(runsRoot, "portable-launch-state") } };
    const service = new RunService({ runsRoot }, buildDeps());
    const serverOptions = createServerOptions(service, registryRoot, { advertisedHost: "blade", stateStoreOptions });
    const handle = await startRunServer({ ...serverOptions, hostname: () => "blade.internal.example" });
    const serverUrl = handle.url.replace("http://blade:", "http://127.0.0.1:");
    const intent = service.createIntent({ host: "local", prompt: "Portable launch", require_execplan: false });
    let storedRecord: { intent: typeof intent; creation_provenance?: ApiProvenanceV1 } | undefined;
    let durableDispatches = 0;
    const launchSpy = vi.spyOn(service, "submitDetached").mockImplementation(async (received, options) => {
      if (storedRecord) {
        if (
          hashCanonicalJcs(storedRecord.intent) !== hashCanonicalJcs(received)
          || hashCanonicalJcs(storedRecord.creation_provenance) !== hashCanonicalJcs(options?.provenance)
        ) throw new RunAlreadyExistsError(received.run_id, "queued");
        return { run_id: received.run_id } as never;
      }
      durableDispatches += 1;
      storedRecord = { intent: received, ...(options?.provenance ? { creation_provenance: options.provenance } : {}) };
      return { run_id: received.run_id } as never;
    });
    const post = (body: Record<string, unknown>, accept: string | undefined = CALYX_RUN_LAUNCH_ACCEPT_V1, actor = "operator:one") => fetch(
      `${serverUrl}/v1/admin/runs`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
          ...(accept ? { accept } : {}),
          "x-calyx-asserted-actor": actor,
        },
        body: JSON.stringify(body),
      },
    );

    try {
      const traversalKey = "portable-launch-traversal";
      const traversalTarget = join(runsRoot, "..", "portable-run-escape");
      const traversal = await post({
        schema_version: "calyx.run-launch-request/v1",
        intent: { ...intent, run_id: "../portable-run-escape" },
        idempotency_key: traversalKey,
        topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
      });
      expect(traversal.status).toBe(400);
      expect(await traversal.json()).toMatchObject({ error: { code: "invalid_request" } });
      await expect(stat(traversalTarget)).rejects.toMatchObject({ code: "ENOENT" });
      const traversalState = await openStateStore(stateStoreOptions);
      try {
        const binding = traversalState.db.prepare(
          `SELECT COUNT(*) AS count
             FROM api_idempotency
            WHERE operation_id = 'admin.run.launch' AND idempotency_key = ?`,
        ).get(traversalKey) as { count: number };
        expect(binding.count).toBe(0);
      } finally {
        traversalState.db.close();
      }
      expect(launchSpy).not.toHaveBeenCalled();

      for (const requestedHost of ["worm", "blade.evil"] as const) {
        const hostileIntent = service.createIntent({
          run_id: `run-host-mismatch-${requestedHost.replace(".", "-")}`,
          host: requestedHost,
          kernel: "host_process",
          host_process: { argv: [process.execPath, "-e", "process.exit(0)"] },
        });
        const idempotencyKey = `portable-host-mismatch-${requestedHost}`;
        const mismatch = await post({
          schema_version: "calyx.run-launch-request/v1",
          intent: hostileIntent,
          idempotency_key: idempotencyKey,
          topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
        });
        expect(mismatch.status, requestedHost).toBe(409);
        expect(await mismatch.json(), requestedHost).toMatchObject({
          error: {
            code: "run_host_mismatch",
            details: {
              requested_host: requestedHost,
              actual_host: "blade.internal.example",
              advertised_host: "blade",
            },
          },
        });
        const afterMismatch = await openStateStore(stateStoreOptions);
        try {
          expect(afterMismatch.db.prepare(
            `SELECT idempotency_key
               FROM api_idempotency
              WHERE operation_id = 'admin.run.launch' AND idempotency_key = ?`,
          ).get(idempotencyKey)).toBeUndefined();
        } finally {
          afterMismatch.db.close();
        }
        expect(await service.getRunRecord(hostileIntent.run_id)).toBeUndefined();
        expect(launchSpy).not.toHaveBeenCalled();
      }

      const body = {
        schema_version: "calyx.run-launch-request/v1",
        intent,
        idempotency_key: "portable-launch-1",
        topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
      };
      const unnamed = await post(body, "");
      expect(unnamed.status).toBe(406);
      expect(await unnamed.json()).toMatchObject({ error: { code: "unsupported_accept" } });
      expect(launchSpy).not.toHaveBeenCalled();

      const retiredDetachedKey = "portable-retired-detached";
      const retiredDetached = await post({
        ...body,
        idempotency_key: retiredDetachedKey,
        detached: false,
      });
      expect(retiredDetached.status).toBe(400);
      expect(await retiredDetached.json()).toMatchObject({
        error: { code: "invalid_request", message: expect.stringContaining("detached is retired") },
      });
      const retiredState = await openStateStore(stateStoreOptions);
      try {
        const binding = retiredState.db.prepare(
          `SELECT COUNT(*) AS count
             FROM api_idempotency
            WHERE operation_id = 'admin.run.launch' AND idempotency_key = ?`,
        ).get(retiredDetachedKey) as { count: number };
        expect(binding.count).toBe(0);
      } finally {
        retiredState.db.close();
      }
      expect(launchSpy).not.toHaveBeenCalled();

      const [first, concurrentReplay] = await Promise.all([post(body), post(body)]);
      expect([first.status, concurrentReplay.status]).toEqual([202, 202]);
      expect(first.headers.get("content-type")).toContain(CALYX_RUN_LAUNCH_ACCEPT_V1);
      const firstReceipt = await first.json();
      expect(firstReceipt).toMatchObject({
        schema_version: "calyx.run-launch-result/v1",
        run_id: intent.run_id,
        operation: { route: `/v1/admin/runs/${intent.run_id}` },
      });
      expect(durableDispatches).toBe(1);

      const actorReplay = await post(body, CALYX_RUN_LAUNCH_ACCEPT_V1, "operator:two");
      expect(actorReplay.status).toBe(202);
      expect(await actorReplay.json()).toEqual(firstReceipt);
      const opened = await openStateStore(stateStoreOptions);
      try {
        const binding = opened.db.prepare(
          `SELECT asserted_actor, request_hash
             FROM api_idempotency
            WHERE subject = ? AND operation_id = ? AND idempotency_key = ?`,
        ).get("test-control-plane", "admin.run.launch", "portable-launch-1") as {
          asserted_actor: string | null;
          request_hash: string;
        };
        const sentIntent = JSON.parse(JSON.stringify(intent)) as Record<string, unknown>;
        expect(binding).toEqual({
          asserted_actor: "operator:one",
          request_hash: hashCanonicalJcs({
            schema_version: "calyx.run-launch-request/v1",
            intent: sentIntent,
            topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
          }),
        });
        expect(binding.request_hash).not.toBe(hashCanonicalJcs({ intent: sentIntent }));
        expect(binding.request_hash).not.toBe(hashCanonicalJcs({
          schema_version: "calyx.run-launch-request/v1",
          intent: sentIntent,
          detached: true,
          topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
        }));
      } finally {
        opened.db.close();
      }

      const changed = await post({
        ...body,
        intent: { ...intent, prompt: "Different request" },
      });
      expect(changed.status).toBe(409);
      expect(await changed.json()).toMatchObject({ error: { code: "idempotency_conflict" } });

      const missingKey = await post({ schema_version: "calyx.run-launch-request/v1", intent });
      expect(missingKey.status).toBe(400);
      expect(await missingKey.json()).toMatchObject({ error: { code: "idempotency_key_required" } });

      const missingTopologyProjection = await post({
        schema_version: "calyx.run-launch-request/v1",
        idempotency_key: "portable-launch-missing-topology",
        intent,
      });
      expect(missingTopologyProjection.status).toBe(400);
      expect(await missingTopologyProjection.json()).toMatchObject({
        error: { code: "topology_projection_required" },
      });

      const conflictingRunId = await post({ ...body, idempotency_key: "portable-launch-2" });
      expect(conflictingRunId.status).toBe(409);
      expect(await conflictingRunId.json()).toMatchObject({ error: { code: "run_id_conflict" } });
      const conflictingReplay = await post({ ...body, idempotency_key: "portable-launch-2" });
      expect(conflictingReplay.status).toBe(409);
      expect(await conflictingReplay.json()).toMatchObject({ error: { code: "run_id_conflict" } });

      const acceptListReplay = await post(
        body,
        `application/json;q=0.2, ${CALYX_RUN_LAUNCH_ACCEPT_V1};q=0.8`,
      );
      expect(acceptListReplay.status).toBe(202);
      const rollingMajorReplay = await post(
        body,
        "application/vnd.polli.calyx.run-launch-receipt+json;version=2;q=1, "
          + 'application/vnd.polli.calyx.run-launch-receipt+json;version="1";q=0.4;note="quoted,semi;colon"',
      );
      expect(rollingMajorReplay.status).toBe(202);
      const boundaryQvalueReplay = await post(
        body,
        "application/vnd.polli.calyx.run-launch-receipt+json;version=1;q=1.000",
      );
      expect(boundaryQvalueReplay.status).toBe(202);
      const positiveFallbackReplay = await post(
        body,
        "application/vnd.polli.calyx.run-launch-receipt+json;version=1;q=0, "
          + "application/vnd.polli.calyx.run-launch-receipt+json;version=1;q=0.1",
      );
      expect(positiveFallbackReplay.status).toBe(202);
      const unsupported = await post(body, "application/vnd.polli.calyx.run-launch-receipt+json;version=2");
      expect(unsupported.status).toBe(406);
      expect(await unsupported.json()).toMatchObject({ error: { code: "unsupported_accept" } });
      const unsupportedMediaParameter = await post(
        body,
        "application/vnd.polli.calyx.run-launch-receipt+json;version=1;profile=bogus;q=1",
      );
      expect(unsupportedMediaParameter.status).toBe(406);
      expect(await unsupportedMediaParameter.json()).toMatchObject({
        error: { code: "unsupported_accept" },
      });
      const malformed = await post(
        body,
        'application/vnd.polli.calyx.run-launch-receipt+json;version="1;q=0.8',
      );
      expect(malformed.status).toBe(406);
      expect(await malformed.json()).toMatchObject({ error: { code: "unsupported_accept" } });
      for (const invalidQvalue of ["0.0001", ".5", "1e-1", "+0.5", '"0.4"']) {
        const invalidWeight = await post(
          body,
          `application/vnd.polli.calyx.run-launch-receipt+json;version=1;q=${invalidQvalue}`,
        );
        expect(invalidWeight.status, invalidQvalue).toBe(406);
        expect(await invalidWeight.json(), invalidQvalue).toMatchObject({
          error: { code: "unsupported_accept" },
        });
      }
    } finally {
      launchSpy.mockRestore();
      await handle.close();
    }
  });

  test("portable launch returns a declared retryable 503 while admission is contended", async () => {
    let blockAdmission = false;
    let admissionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      admissionStarted = resolve;
    });
    let releaseAdmission!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const stateStoreOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(runsRoot, "portable-launch-busy-state") },
    };
    const service = new RunService({
      runsRoot,
      workloadAdmission: {
        acquireTimeoutMs: 5,
        reconcile: async ({ host }) => {
          if (blockAdmission) {
            admissionStarted();
            await released;
          }
          return passingTestWorkloadAdmissionReceipt(host);
        },
      },
    }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot, {
      advertisedHost: "blade",
      stateStoreOptions,
    }));
    const serverUrl = handle.url.replace("http://blade:", "http://127.0.0.1:");
    const intent = service.createIntent({
      run_id: "run-portable-admission-busy",
      host: "local",
      prompt: "Retry after admission contention",
      require_execplan: false,
    });

    blockAdmission = true;
    const heldAdmission = service.reconcileWorkloadAdmission();
    await started;
    try {
      const response = await fetch(`${serverUrl}/v1/admin/runs`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
          accept: CALYX_RUN_LAUNCH_ACCEPT_V1,
        },
        body: JSON.stringify({
          schema_version: "calyx.run-launch-request/v1",
          idempotency_key: "portable-launch-admission-busy",
          topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
          intent,
        }),
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: {
          schema_version: "calyx.error/v1",
          code: "workload_admission_busy",
          retryable: true,
          details: {
            reason: "admission_evidence_missing",
            failed_surface: "admission_evidence",
            admission: "open",
            planned_topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
            accepted_topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
          },
        },
      });
      await expect(service.getRunRecord(intent.run_id)).resolves.toBeUndefined();
    } finally {
      releaseAdmission();
      await heldAdmission;
      await handle.close();
    }
  });

  test("portable run replay preserves the first creator after binding commits before launch", async () => {
    const stateStoreOptions = { env: { ...process.env, CALYX_STATE_HOME: join(runsRoot, "portable-launch-crash-state") } };
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot, { stateStoreOptions }));
    const intent = service.createIntent({
      run_id: "run-portable-crash-window",
      host: "local",
      prompt: "Preserve the first creator",
      require_execplan: false,
    });
    let launchAttempts = 0;
    const launchSpy = vi.spyOn(service, "submitDetached").mockImplementation(async (received) => {
      launchAttempts += 1;
      if (launchAttempts === 1) throw new Error("simulated failure after durable binding commit");
      return { run_id: received.run_id } as never;
    });
    const body = {
      schema_version: "calyx.run-launch-request/v1",
      intent,
      idempotency_key: "portable-crash-binding",
      topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
    };
    const post = (actor: string) => fetch(`${handle.url}/v1/admin/runs`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json",
        accept: CALYX_RUN_LAUNCH_ACCEPT_V1,
        "x-calyx-asserted-actor": actor,
      },
      body: JSON.stringify(body),
    });

    try {
      const first = await post("operator:one");
      expect(first.status).toBe(500);
      const firstRequestId = first.headers.get("x-calyx-request-id");
      expect(firstRequestId).toMatch(/^req_[0-9a-f-]{36}$/);

      const replay = await post("operator:two");
      expect(replay.status).toBe(202);
      expect(launchSpy).toHaveBeenCalledTimes(2);
      const replayOptions = launchSpy.mock.calls[1]?.[1];
      expect(replayOptions?.provenance).toMatchObject({
        request_id: firstRequestId,
        asserted_actor: "operator:one",
        subject: "test-control-plane",
      });
      expect(replayOptions?.provenance).not.toMatchObject({ asserted_actor: "operator:two" });

      const opened = await openStateStore(stateStoreOptions);
      try {
        const binding = opened.db.prepare(
          `SELECT first_request_id, first_request_provenance_json
             FROM api_idempotency
            WHERE subject = ? AND operation_id = ? AND idempotency_key = ?`,
        ).get("test-control-plane", "admin.run.launch", "portable-crash-binding") as {
          first_request_id: string;
          first_request_provenance_json: string;
        };
        expect(binding.first_request_id).toBe(firstRequestId);
        expect(JSON.parse(binding.first_request_provenance_json)).toMatchObject({
          request_id: firstRequestId,
          asserted_actor: "operator:one",
        });
      } finally {
        opened.db.close();
      }
    } finally {
      launchSpy.mockRestore();
      await handle.close();
    }
  });

  test("portable exact replay adopts the stored normalized intent after resume defaults drift", async () => {
    const stateStoreOptions = { env: { ...process.env, CALYX_STATE_HOME: join(runsRoot, "portable-resume-drift-state") } };
    await applyStateMigrations({ storeOptions: stateStoreOptions });
    const service = new RunService({ runsRoot }, buildDeps());
    const rawIntent = service.createIntent({
      run_id: "run-portable-resume-drift",
      host: "local",
      backend: "codex",
      resume_session_id: "session-portable-resume-drift",
      prompt: "Resume without rebinding mutable defaults",
      require_execplan: false,
    });
    const firstProvenance: ApiProvenanceV1 = {
      schema_version: "calyx.provenance/v1",
      request_id: "req_12345678-1234-4123-8123-123456789abc",
      subject: "test-control-plane",
      asserted_actor: "operator:one",
      host: "blade",
      via: "http",
      at: "2026-07-14T04:00:00.000Z",
    };
    const normalizedIntent = {
      ...rawIntent,
      worktree_path: join(runsRoot, "original-resume-worktree"),
      worktree_source: "activity_inventory_cwd" as const,
    };
    const requestHash = hashCanonicalJcs({
      schema_version: "calyx.run-launch-request/v1",
      intent: rawIntent,
      topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
    });
    const admissionIdentity = hashCanonicalJcs({
      domain: "calyx.admin.run.launch-idempotency/v1",
      subject: "test-control-plane",
      operation_id: "admin.run.launch",
      idempotency_key: "portable-resume-drift",
    });
    const seeded = await service.initializeRun(normalizedIntent, {
      creationProvenance: firstProvenance,
      launchMode: "detached",
      admissionIdentity,
      requestHash,
    });
    await service.store.writeRunRecord(rawIntent.run_id, {
      ...seeded,
      state: "succeeded",
      summary: "Completed from the originally resolved worktree.",
      completed_at: "2026-07-14T04:01:00.000Z",
      updated_at: "2026-07-14T04:01:00.000Z",
    });
    const receipt = {
      schema_version: "calyx.run-launch-result/v1",
      status: "accepted",
      run_id: rawIntent.run_id,
      operation: {
        route: `/v1/admin/runs/${rawIntent.run_id}`,
        events_route: `/v1/admin/runs/${rawIntent.run_id}/events`,
        receipt_route: `/v1/admin/runs/${rawIntent.run_id}/receipt`,
      },
    };
    const opened = await openStateStore(stateStoreOptions);
    try {
      recordApiIdempotency(opened.db, {
        subject: "test-control-plane",
        operation_id: "admin.run.launch",
        idempotency_key: "portable-resume-drift",
        asserted_actor: "operator:one",
        first_request_provenance: firstProvenance,
        request_hash: requestHash,
        response_status: 202,
        response: receipt,
      });
    } finally {
      opened.db.close();
    }
    const mutableDefault = vi.spyOn(service, "resolveResumeWorktreePath").mockResolvedValue({
      path: join(runsRoot, "newer-resume-worktree"),
      source: "activity_inventory_cwd",
    });
    const handle = await startRunServer(createServerOptions(service, registryRoot, { stateStoreOptions }));
    try {
      const replay = await fetch(`${handle.url}/v1/admin/runs`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
          accept: CALYX_RUN_LAUNCH_ACCEPT_V1,
          "x-calyx-asserted-actor": "operator:two",
        },
        body: JSON.stringify({
          schema_version: "calyx.run-launch-request/v1",
          idempotency_key: "portable-resume-drift",
          topology_projection_sha256: TOPOLOGY_PROJECTION_SHA256,
          intent: rawIntent,
        }),
      });
      expect(replay.status).toBe(202);
      expect(await replay.json()).toEqual(receipt);
      expect(mutableDefault).not.toHaveBeenCalled();
      await expect(service.getRunRecord(rawIntent.run_id)).resolves.toMatchObject({
        intent: { worktree_path: normalizedIntent.worktree_path },
      });
    } finally {
      mutableDefault.mockRestore();
      await handle.close();
    }
  });

  test("boot reconcile re-adopts a non-terminal execution owner on startup", async () => {
    const service = new RunService({ runsRoot }, buildDeps());

    // Pre-seed a detached run whose execution owner survives the daemon restart.
    const intent = service.createIntent({
      run_id: "run-boot-adopt",
      host: "local",
      prompt: "Survive the restart",
      require_execplan: false,
    });
    const seeded = await service.initializeRun(intent, { launchMode: "detached" });
    await service.store.writeRunRecord(intent.run_id, {
      ...seeded,
      state: "running",
      launch: {
        ...seeded.launch,
        stage: "executing",
        execution_id: "execution-boot-adopt",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      summary: "Detached run alive across restart.",
      updated_at: "2026-03-11T12:00:01.000Z",
    });
    let ownerAcquired!: () => void;
    let releaseOwner!: () => void;
    const acquired = new Promise<void>((resolve) => { ownerAcquired = resolve; });
    const release = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const held = withSqliteMutex(service.store.paths(intent.run_id).executionMutexPath, async () => {
      ownerAcquired();
      await release;
    });
    await acquired;

    // A fresh daemon runs reconcile once on boot, before serving requests.
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    try {
      const record = await service.store.readRunRecord(intent.run_id);
      expect(record?.state).toBe("running");
      expect(record?.launch).toMatchObject({ stage: "executing", execution_id: "execution-boot-adopt" });
      expect(await service.store.hasTerminalEventForRun(intent.run_id)).toBe(false);

      const adoptionEvents = (await service.store.readEvents(intent.run_id)).filter(
        (event) =>
          isRunServiceEvent(event)
          && event.event === "reconciled"
          && (event.payload as { reconcile?: unknown } | undefined)?.reconcile === "adopted",
      );
      expect(adoptionEvents).toHaveLength(1);

      // The adopted run still lists as running, not reclassified to terminal.
      const listResponse = await fetch(`${handle.url}/v1/admin/runs`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(listResponse.status).toBe(200);
      const list = await listResponse.json() as {
        schema_version: string;
        count: number;
        truncated: boolean;
        runs: Array<{ run_id: string; state: string }>;
      };
      expect(list.schema_version).toBe("calyx.run-list/v1");
      expect(list.runs.find((entry) => entry.run_id === intent.run_id)?.state).toBe("running");
    } finally {
      await handle.close();
      releaseOwner();
      await held;
    }
  });

  test("boot reconcile gates readiness — the daemon does not become ready until reconcile completes (POL-1879)", async () => {
    // Regression (POL-1860 Codex review): boot reconcile must be part of readiness,
    // not a post-ready side effect. Hold reconcile open and assert startRunServer
    // (which resolves descriptorReady, gating request handling and /health) does not
    // resolve until the reconcile attempt finishes.
    const service = new RunService({ runsRoot }, buildDeps());
    let releaseReconcile: (() => void) | undefined;
    const reconcileGate = new Promise<void>((resolve) => {
      releaseReconcile = resolve;
    });
    let reconcileStarted = false;
    const reconcileSpy = vi.spyOn(service, "reconcile").mockImplementation(async () => {
      reconcileStarted = true;
      await reconcileGate;
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
    });

    const startPromise = startRunServer(createServerOptions(service, registryRoot));
    let started = false;
    void startPromise.then(() => {
      started = true;
    });

    await vi.waitFor(() => expect(reconcileStarted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(false);

    releaseReconcile?.();
    const handle = await startPromise;
    try {
      expect(started).toBe(true);
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
    } finally {
      reconcileSpy.mockRestore();
      await handle.close();
    }
  });

  test("boot admission contention preserves the fenced management listener", async () => {
    let admissionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      admissionStarted = resolve;
    });
    let releaseAdmission!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const service = new RunService({
      runsRoot,
      workloadAdmission: {
        acquireTimeoutMs: 5,
        reconcile: async ({ host }) => {
          admissionStarted();
          await released;
          return passingTestWorkloadAdmissionReceipt(host);
        },
      },
    }, buildDeps());
    const heldAdmission = service.reconcileWorkloadAdmission();
    await started;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let handle: Awaited<ReturnType<typeof startRunServer>> | undefined;
    try {
      handle = await startRunServer(createServerOptions(service, registryRoot));
      const health = await fetch(`${handle.url}/v1/internal/health`, {
        headers: { authorization: "Bearer self-daemon-token" },
      });

      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({
        workload_admission: {
          admission: "fenced",
          reason: "admission_evidence_missing",
          failed_surface: "admission_evidence",
        },
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("serving with the current fenced decision"),
        expect.stringContaining("Workload admission is busy"),
      );
    } finally {
      releaseAdmission();
      await heldAdmission;
      await handle?.close();
      warnSpy.mockRestore();
    }
  });

  test("serves monitor create/read/cancel routes from the daemon state store", async () => {
    const stateHome = join(runsRoot, "monitor-state");
    const stateStoreOptions = { env: { ...process.env, CALYX_STATE_HOME: stateHome } };
    await applyStateMigrations({ storeOptions: stateStoreOptions });
    const service = new RunService({ runsRoot }, buildDeps());
    await service.initializeRun(service.createIntent({
      run_id: "server-monitor-run",
      host: "blade",
      prompt: "Server monitor route run",
      require_execplan: false,
    }));
    const handle = await startRunServer(createServerOptions(service, registryRoot, {
      advertisedHost: "blade",
      stateStoreOptions,
    }));
    const serverUrl = handle.url.replace("http://blade:", "http://127.0.0.1:");
    const createBody = {
      schema_version: "calyx.monitor-create-request/v1",
      idempotency_key: "monitor-create-main",
      owner: "operator",
      created_by: "server-test",
      create_provenance: "operator",
      assigned_host: "blade",
      source_run_id: "server-monitor-run",
      preset: "runner-supervision",
      stale_after_ms: 1_800_000,
      rearm_policy: "every_change",
    };

    try {
      const createResponse = await fetch(`${serverUrl}/v1/admin/monitors`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(createBody),
      });
      expect(createResponse.status).toBe(200);
      const created = await createResponse.json() as {
        schema_version: string;
        owner_host: string;
        note: string;
        monitor: { monitor_id: string; assigned_host: string; source_run_id: string };
      };
      expect(created.schema_version).toBe("calyx.monitor-create/v1");
      expect(created.owner_host).toBe("blade");
      expect(created.note).toContain("inspect with --host blade");
      expect(created.monitor).toMatchObject({
        assigned_host: "blade",
        source_run_id: "server-monitor-run",
      });

      await rm(service.store.paths("server-monitor-run").runRecordPath);
      const replayAfterSourceDisappears = await fetch(`${serverUrl}/v1/admin/monitors`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(createBody),
      });
      expect(replayAfterSourceDisappears.status).toBe(200);
      expect(await replayAfterSourceDisappears.json()).toEqual(created);

      const opened = await openStateStore(stateStoreOptions);
      try {
        const rows = listMonitors(opened.db, { status: "all" });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.monitor_id).toBe(created.monitor.monitor_id);
      } finally {
        opened.db.close();
      }

      const listResponse = await fetch(`${serverUrl}/v1/admin/monitors?status=active`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(listResponse.status).toBe(200);
      const listed = await listResponse.json() as { count: number; monitors: Array<{ monitor_id: string }> };
      expect(listed.count).toBe(1);
      expect(listed.monitors[0]?.monitor_id).toBe(created.monitor.monitor_id);

      const showResponse = await fetch(`${serverUrl}/v1/admin/monitors/${created.monitor.monitor_id}`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(showResponse.status).toBe(200);
      const shown = await showResponse.json() as { monitor: { monitor_id: string }; delivery_state: { count: number } };
      expect(shown.monitor.monitor_id).toBe(created.monitor.monitor_id);
      expect(shown.delivery_state.count).toBe(0);

      let wakeId = "";
      const seeded = await openStateStore(stateStoreOptions);
      try {
        const monitor = readMonitor(seeded.db, created.monitor.monitor_id);
        expect(monitor).toBeTruthy();
        const evaluation = await evaluatePredicateV1(monitor!.predicate, {
          now: () => new Date("2026-07-21T01:00:00.000Z"),
          readRun: () => ({
            run_id: "server-monitor-run",
            state: "succeeded",
            updated_at: "2026-07-21T01:00:00.000Z",
            completed_at: "2026-07-21T01:00:00.000Z",
          }),
        });
        const updated = recordMonitorEvaluation(seeded.db, monitor!.monitor_id, evaluation);
        expect(updated).toBeTruthy();
        wakeId = createMonitorWake(seeded.db, {
          monitor: updated!,
          evaluation,
          suggested_commands: ["calyx monitor inbox --json"],
          created_at: evaluation.evaluated_at,
        }).wake.wake_id;
        seeded.db.exec(`
          CREATE TRIGGER fail_monitor_claim_idempotency
          BEFORE INSERT ON api_idempotency
          WHEN NEW.operation_id = 'admin.monitor.claim'
          BEGIN
            SELECT RAISE(ABORT, 'fixture monitor claim idempotency failure');
          END;
        `);
      } finally {
        seeded.db.close();
      }

      const atomicFailureBody = {
        idempotency_key: "monitor-claim-atomic-failure",
        claimed_by: "operator",
      };
      const atomicFailure = await fetch(`${serverUrl}/v1/admin/monitors/wakes`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(atomicFailureBody),
      });
      expect(atomicFailure.status).toBe(500);

      const afterFailure = await openStateStore(stateStoreOptions);
      try {
        expect(readMonitorWake(afterFailure.db, wakeId)?.status).toBe("pending");
        expect(readApiIdempotency(
          afterFailure.db,
          "test-control-plane",
          "admin.monitor.claim",
          atomicFailureBody.idempotency_key,
        )).toBeUndefined();
        expect(listMonitorHistory(afterFailure.db, created.monitor.monitor_id)
          .filter((entry) => entry.event_type === "monitor.wake.claimed")).toHaveLength(0);
        afterFailure.db.exec("DROP TRIGGER fail_monitor_claim_idempotency");
      } finally {
        afterFailure.db.close();
      }

      const claimBody = {
        idempotency_key: "monitor-claim-main",
        claimed_by: "operator",
      };
      const claimResponse = await fetch(`${serverUrl}/v1/admin/monitors/wakes`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(claimBody),
      });
      expect(claimResponse.status).toBe(200);
      const claimed = await claimResponse.json() as {
        schema_version: string;
        count: number;
        wakes: Array<{ wake_id: string; status: string }>;
      };
      expect(claimed).toMatchObject({
        schema_version: "calyx.monitor-inbox/v1",
        count: 1,
        wakes: [{ wake_id: wakeId, status: "claimed" }],
      });

      const afterClaim = await openStateStore(stateStoreOptions);
      try {
        expect(ackMonitorWake(afterClaim.db, wakeId, { acked_by: "operator" }).wake?.status).toBe("acked");
        const monitor = readMonitor(afterClaim.db, created.monitor.monitor_id);
        const originalWake = readMonitorWake(afterClaim.db, wakeId);
        expect(monitor).toBeTruthy();
        expect(originalWake).toBeTruthy();
        for (const [index, createdAt] of [
          "2026-07-21T02:00:00.000Z",
          "2026-07-21T03:00:00.000Z",
        ].entries()) {
          createMonitorWake(afterClaim.db, {
            wake_id: `wake-newer-${index + 1}`,
            monitor: monitor!,
            evaluation: {
              ...originalWake!.evaluation,
              evaluated_at: createdAt,
              transition_hash: `transition-newer-${index + 1}`,
              fingerprint: `fingerprint-newer-${index + 1}`,
            },
            suggested_commands: ["calyx monitor inbox --json"],
            created_at: createdAt,
          });
        }
      } finally {
        afterClaim.db.close();
      }

      const firstPageResponse = await fetch(`${serverUrl}/v1/admin/monitors/wakes?limit=1`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(firstPageResponse.status).toBe(200);
      expect(await firstPageResponse.json()).toMatchObject({
        count: 1,
        wakes: [{ wake_id: "wake-newer-2" }],
      });

      const exactWakeResponse = await fetch(
        `${serverUrl}/v1/admin/monitors/wakes?wake_id=${encodeURIComponent(wakeId)}`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(exactWakeResponse.status).toBe(200);
      expect(await exactWakeResponse.json()).toMatchObject({
        schema_version: "calyx.monitor-inbox/v1",
        owner_host: "blade",
        count: 1,
        wakes: [{ wake_id: wakeId, status: "acked", acked_by: "operator" }],
      });

      const mixedExactWakeResponse = await fetch(
        `${serverUrl}/v1/admin/monitors/wakes?wake_id=${encodeURIComponent(wakeId)}&status=pending`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(mixedExactWakeResponse.status).toBe(400);
      expect(await mixedExactWakeResponse.json()).toMatchObject({
        error: { code: "invalid_request", details: { conflicting_parameters: ["status"] } },
      });

      const missingExactWakeResponse = await fetch(
        `${serverUrl}/v1/admin/monitors/wakes?wake_id=wake-missing`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(missingExactWakeResponse.status).toBe(200);
      expect(await missingExactWakeResponse.json()).toMatchObject({ count: 0, wakes: [] });

      const replayResponse = await fetch(`${serverUrl}/v1/admin/monitors/wakes`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(claimBody),
      });
      expect(replayResponse.status).toBe(200);
      expect(await replayResponse.json()).toEqual(claimed);

      const conflictResponse = await fetch(`${serverUrl}/v1/admin/monitors/wakes`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...claimBody, limit: 1 }),
      });
      expect(conflictResponse.status).toBe(409);
      expect(await conflictResponse.json()).toMatchObject({ error: { code: "idempotency_conflict" } });

      const missingKeyResponse = await fetch(`${serverUrl}/v1/admin/monitors/wakes`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ claimed_by: "operator" }),
      });
      expect(missingKeyResponse.status).toBe(400);

      const replayLedger = await openStateStore(stateStoreOptions);
      try {
        const row = readApiIdempotency(
          replayLedger.db,
          "test-control-plane",
          "admin.monitor.claim",
          claimBody.idempotency_key,
        );
        expect(row?.request_hash).toBe(hashCanonicalJcs({ claimed_by: "operator" }));
        expect(row?.response).toEqual(claimed);
      } finally {
        replayLedger.db.close();
      }

      const cancelResponse = await fetch(`${serverUrl}/v1/admin/monitors/${created.monitor.monitor_id}/cancel`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: "server route test" }),
      });
      expect(cancelResponse.status).toBe(200);
      const cancelled = await cancelResponse.json() as { monitor: { monitor_id: string; status: string } };
      expect(cancelled.monitor).toMatchObject({
        monitor_id: created.monitor.monitor_id,
        status: "cancelled",
      });
    } finally {
      await handle.close();
    }
  });

  test("accepts rolling message replay when only legacy origin provenance was absent", async () => {
    const stateStoreOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(runsRoot, "message-origin-rolling") },
    };
    await applyStateMigrations({ storeOptions: stateStoreOptions });
    const seeded = await openStateStore(stateStoreOptions);
    let legacyMessage: ReturnType<typeof createMessage>["message"];
    try {
      legacyMessage = createMessage(seeded.db, {
        message_id: "msg_rolling_origin",
        sender: "client:source@carbon",
        recipient_address: "client:test-control-plane@blade",
        recipient_class: "directed",
        subject: "rolling origin",
        body: "same immutable content",
        created_provenance: null,
      }).message;
    } finally {
      seeded.db.close();
    }

    const service = new RunService({ runsRoot }, buildDeps());
    const options = createServerOptions(service, registryRoot, {
      advertisedHost: "blade",
      stateStoreOptions,
      messageHostAliases: { carbon: "carbon" },
    });
    const handle = await startRunServer({
      ...options,
      credentials: [
        ...options.credentials,
        {
          client_id: "daemon:carbon",
          credential_tier: "internal_runtime",
          verifier: hashConsumerApiBearer("carbon-daemon-token"),
          verifier_env: "CALYX_CONSUMER_API_TEST_DAEMON_CARBON_VERIFIER",
          address_grants: { send_as: ["client:daemon.carbon@carbon"], read: ["host:carbon"] },
        },
      ],
    });
    const serverUrl = handle.url.replace("http://blade:", "http://127.0.0.1:");
    const originProvenance = {
      schema_version: "calyx.provenance/v1",
      request_id: "req_12345678-1234-4123-8123-123456789abc",
      subject: "source",
      asserted_actor: "operator:caleb",
      host: "carbon",
      via: "http",
      at: "2026-07-14T04:00:00.000Z",
    };
    const forward = (message: Record<string, unknown>) => fetch(
      `${serverUrl}/v1/internal/messages/receive`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer carbon-daemon-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ schema_version: "calyx.msg-send/v1", message }),
      },
    );

    try {
      for (const [label, message, code] of [
        ["forged-origin", { ...legacyMessage, sender: "client:source@worm" }, "internal_origin_forbidden"],
        ["wrong-target", { ...legacyMessage, recipient_address: "client:test-control-plane@worm" }, "internal_target_forbidden"],
      ] as const) {
        const rejected = await forward({ ...message, message_id: `msg_${label}` });
        expect(rejected.status, label).toBe(403);
        expect(await rejected.json(), label).toMatchObject({
          error: { code, schema_version: "calyx.error/v1" },
        });
      }

      const executionTarget = await forward({
        ...legacyMessage,
        message_id: "msg_execution_target",
        recipient_address: "run:remote-resume",
        created_provenance: originProvenance,
      });
      expect(executionTarget.status).toBe(200);
      expect(await executionTarget.json()).toMatchObject({ inserted: true });

      const invalidScope = await forward({
        ...legacyMessage,
        message_id: "msg_invalid_scope_without_expiry",
        recipient_class: "scope",
        expires_at: null,
        created_provenance: originProvenance,
      });
      expect(invalidScope.status).toBe(400);
      const invalidScopeRequestId = invalidScope.headers.get("x-calyx-request-id");
      expect(invalidScopeRequestId).toBeTruthy();
      const afterInvalid = await openStateStore(stateStoreOptions);
      try {
        expect(afterInvalid.db.prepare(
          "SELECT request_id FROM api_request_audit WHERE request_id = ?",
        ).get(invalidScopeRequestId)).toBeUndefined();
      } finally {
        afterInvalid.db.close();
      }

      const replay = await forward({ ...legacyMessage, created_provenance: originProvenance });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ inserted: false });

      const opened = await openStateStore(stateStoreOptions);
      try {
        expect(opened.db.prepare(
          "SELECT created_provenance_json FROM messages WHERE message_id = ?",
        ).get(legacyMessage.message_id)).toEqual({ created_provenance_json: null });
      } finally {
        opened.db.close();
      }

      const conflict = await forward({
        ...legacyMessage,
        subject: "different immutable content",
        created_provenance: originProvenance,
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({
        error: { code: "message_identity_conflict" },
      });
    } finally {
      await handle.close();
    }
  });

  test("canonicalizes only exact internal message aliases and pinned host FQDNs before persistence", async () => {
    const stateStoreOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(runsRoot, "message-ingress-canonical-addresses") },
    };
    await applyStateMigrations({ storeOptions: stateStoreOptions });
    const seeded = await openStateStore(stateStoreOptions);
    let aliasMessage: ReturnType<typeof createMessage>["message"];
    try {
      aliasMessage = createMessage(seeded.db, {
        message_id: "msg_alias_ingress",
        sender: "source@carbon.internal.example",
        recipient_address: "worker@blade.internal.example",
        recipient_class: "directed",
        recipient_host: "blade.internal.example",
        subject: "Canonical ingress",
        body: "Persist the resolved routing identity.",
        thread_key: "canonical-ingress",
      }).message;
      for (const [messageId, sender, recipientAddress, recipientClass, recipientHost] of [
        ["msg_cross_host_collision", "role:source@worm", "role:worker@worm", "directed", "worm"],
        ["msg_stored_class_mismatch", "role:source@carbon", "role:collision@blade", "scope", "blade"],
        ["msg_stored_host_mismatch", "role:source@carbon", "role:collision@blade", "directed", "worm"],
        ["msg_stored_unresolvable", "client:source", "role:collision@blade", "directed", "blade"],
      ] as const) {
        createMessage(seeded.db, {
          message_id: messageId,
          sender,
          recipient_address: recipientAddress,
          recipient_class: recipientClass,
          recipient_host: recipientHost,
          subject: "Canonical ingress",
          body: "Persist the resolved routing identity.",
          thread_key: "canonical-ingress",
          expires_at: recipientClass === "scope" ? "2026-07-15T00:00:00.000Z" : undefined,
        });
      }
    } finally {
      seeded.db.prepare("DELETE FROM messages WHERE message_id = ?").run("msg_alias_ingress");
      seeded.db.close();
    }

    const service = new RunService({ runsRoot }, buildDeps());
    const options = createServerOptions(service, registryRoot, {
      advertisedHost: "blade",
      stateStoreOptions,
      messageHostAliases: {
        blade: "blade",
        "blade.internal.example": "blade",
        carbon: "carbon",
        "carbon.internal.example": "carbon",
      },
    });
    const handle = await startRunServer({
      ...options,
      hostname: () => "blade.internal.example",
      credentials: [
        ...options.credentials,
        {
          client_id: "canonical-reader",
          credential_tier: "consumer",
          verifier: hashConsumerApiBearer("canonical-reader-token"),
          verifier_env: "CALYX_CONSUMER_API_TEST_CANONICAL_READER_VERIFIER",
          address_grants: {
            send_as: ["client:canonical-reader@blade"],
            read: ["role:worker@blade"],
          },
        },
        {
          client_id: "daemon:carbon",
          credential_tier: "internal_runtime",
          verifier: hashConsumerApiBearer("canonical-carbon-daemon-token"),
          verifier_env: "CALYX_CONSUMER_API_TEST_CANONICAL_CARBON_VERIFIER",
          address_grants: { send_as: ["client:daemon.carbon@carbon"], read: ["host:carbon"] },
        },
        {
          client_id: "daemon:carbon.evil",
          credential_tier: "internal_runtime",
          verifier: hashConsumerApiBearer("suffix-carbon-daemon-token"),
          verifier_env: "CALYX_CONSUMER_API_TEST_SUFFIX_CARBON_VERIFIER",
          address_grants: { send_as: ["client:daemon.carbon.evil@carbon.evil"], read: ["host:carbon.evil"] },
        },
        {
          client_id: "daemon:ghost",
          credential_tier: "internal_runtime",
          verifier: hashConsumerApiBearer("orphan-ghost-daemon-token"),
          verifier_env: "CALYX_CONSUMER_API_TEST_ORPHAN_GHOST_VERIFIER",
          address_grants: { send_as: ["client:daemon.ghost@ghost"], read: ["host:ghost"] },
        },
      ],
    });
    const serverUrl = handle.url.replace("http://blade:", "http://127.0.0.1:");
    const forward = (message: unknown) => fetch(
      `${serverUrl}/v1/internal/messages/receive`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer canonical-carbon-daemon-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ schema_version: "calyx.msg-send/v1", message }),
      },
    );

    try {
      const orphanMessageId = "msg_orphan_origin_subject";
      const orphanOrigin = await fetch(
        `${serverUrl}/v1/internal/messages/receive`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer orphan-ghost-daemon-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            schema_version: "calyx.msg-send/v1",
            message: { ...aliasMessage, message_id: orphanMessageId },
          }),
        },
      );
      expect(orphanOrigin.status).toBe(403);
      expect(await orphanOrigin.json()).toMatchObject({
        error: { code: "internal_origin_forbidden" },
      });
      const orphanRequestId = orphanOrigin.headers.get("x-calyx-request-id");
      expect(orphanRequestId).toBeTruthy();
      const afterOrphan = await openStateStore(stateStoreOptions);
      try {
        expect(afterOrphan.db.prepare("SELECT message_id FROM messages WHERE message_id = ?").get(orphanMessageId))
          .toBeUndefined();
        expect(afterOrphan.db.prepare("SELECT request_id FROM api_request_audit WHERE request_id = ?").get(orphanRequestId))
          .toBeUndefined();
      } finally {
        afterOrphan.db.close();
      }
      const forgedProvenanceMessageId = "msg_forged_created_provenance_host";
      const forgedProvenance = await forward({
        ...aliasMessage,
        message_id: forgedProvenanceMessageId,
        created_provenance: {
          schema_version: "calyx.provenance/v1",
          request_id: "req_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          subject: "consumer:forged",
          host: "worm",
          via: "http",
          at: "2026-07-14T08:00:00.000Z",
        },
      });
      expect(forgedProvenance.status).toBe(403);
      expect(await forgedProvenance.json()).toMatchObject({
        error: {
          code: "internal_origin_forbidden",
          message: expect.stringContaining("created_provenance.host"),
        },
      });
      const afterForgedProvenance = await openStateStore(stateStoreOptions);
      try {
        expect(afterForgedProvenance.db.prepare("SELECT message_id FROM messages WHERE message_id = ?")
          .get(forgedProvenanceMessageId)).toBeUndefined();
      } finally {
        afterForgedProvenance.db.close();
      }

      const suffixOrigin = await fetch(
        `${serverUrl}/v1/internal/messages/receive`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer suffix-carbon-daemon-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            schema_version: "calyx.msg-send/v1",
            message: { ...aliasMessage, message_id: "msg_suffix_origin_subject" },
          }),
        },
      );
      expect(suffixOrigin.status).toBe(403);
      expect(await suffixOrigin.json()).toMatchObject({
        error: { code: "internal_origin_forbidden" },
      });

      const rejectedReservedMessageIds: string[] = [];
      for (const reservedKey of [
        "remote_sender_receipt_path",
        "remote_sender_spooled_at",
      ] as const) {
        const messageId = `msg_forged_${reservedKey}`;
        rejectedReservedMessageIds.push(messageId);
        const rejected = await forward({
          ...aliasMessage,
          message_id: messageId,
          payload: {
            ...aliasMessage.payload,
            [reservedKey]: "forged-sender-claim",
          },
        });
        expect(rejected.status, reservedKey).toBe(400);
        expect(await rejected.json(), reservedKey).toMatchObject({
          error: {
            code: "invalid_request",
            message: `message.payload.${reservedKey} is receiver-owned and must not be supplied.`,
          },
        });
      }
      const afterReservedRejections = await openStateStore(stateStoreOptions);
      try {
        for (const messageId of rejectedReservedMessageIds) {
          expect(readMessage(afterReservedRejections.db, messageId), messageId).toBeUndefined();
        }
      } finally {
        afterReservedRejections.db.close();
      }

      const remoteSenderReceiptPath = "/sender/state/receipts/messages.jsonl";
      const remoteSenderSpooledAt = "2026-07-14T08:30:00.000Z";
      const accepted = await forward({
        ...aliasMessage,
        receipt_path: remoteSenderReceiptPath,
        spooled_at: remoteSenderSpooledAt,
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({
        inserted: true,
        message: {
          sender: "role:source@carbon",
          recipient_address: "role:worker@blade",
          recipient_class: "directed",
          recipient_host: "blade",
          payload: {
            remote_sender_receipt_path: remoteSenderReceiptPath,
            remote_sender_spooled_at: remoteSenderSpooledAt,
          },
        },
      });

      const canonicalReplay = await forward({
        ...aliasMessage,
        sender: "role:source@carbon",
        recipient_address: "role:worker@blade",
      });
      expect(canonicalReplay.status).toBe(200);
      expect(await canonicalReplay.json()).toMatchObject({ inserted: false });

      for (const [label, message] of [
        ["foreign-host", {
          ...aliasMessage,
          message_id: "msg_cross_host_collision",
        }],
        ["stored-class", {
          ...aliasMessage,
          message_id: "msg_stored_class_mismatch",
          recipient_address: "role:collision@blade",
          expires_at: "2026-07-15T00:00:00.000Z",
        }],
        ["stored-host", {
          ...aliasMessage,
          message_id: "msg_stored_host_mismatch",
          recipient_address: "role:collision@blade",
        }],
        ["stored-unresolvable", {
          ...aliasMessage,
          message_id: "msg_stored_unresolvable",
          recipient_address: "role:collision@blade",
        }],
      ] as const) {
        const conflict = await forward(message);
        expect(conflict.status, label).toBe(409);
        expect(await conflict.json(), label).toMatchObject({
          error: { code: "message_identity_conflict" },
        });
      }

      const inbox = await fetch(
        `${serverUrl}/v1/messages/inbox?scope=${encodeURIComponent("role:worker@blade")}&status=all`,
        { headers: { authorization: "Bearer canonical-reader-token" } },
      );
      expect(inbox.status).toBe(200);
      expect(await inbox.json()).toMatchObject({
        count: 1,
        messages: [{
          message_id: aliasMessage.message_id,
          sender: "role:source@carbon",
          recipient_address: "role:worker@blade",
          recipient_class: "directed",
        }],
      });

      const inconsistent = await forward({
        ...aliasMessage,
        message_id: "msg_inconsistent_classification",
        recipient_class: "scope",
        expires_at: "2026-07-15T00:00:00.000Z",
      });
      expect(inconsistent.status).toBe(400);
      expect(await inconsistent.json()).toMatchObject({
        error: {
          code: "invalid_request",
          message: "message.recipient_class must match the resolved recipient address (directed).",
        },
      });

      for (const [label, message, field] of [
        ["sender-role-case", {
          ...aliasMessage,
          message_id: "msg_noncanonical_sender_role",
          sender: "role:Source@carbon",
        }, "sender"],
        ["recipient-backend-case", {
          ...aliasMessage,
          message_id: "msg_noncanonical_recipient_backend",
          recipient_address: "interactive:Codex:session-1",
        }, "recipient_address"],
        ["recipient-run-case", {
          ...aliasMessage,
          message_id: "msg_noncanonical_recipient_run",
          recipient_address: "run:Run-1",
        }, "recipient_address"],
        ["recipient-run-wildcard", {
          ...aliasMessage,
          message_id: "msg_nonconcrete_recipient_run",
          recipient_address: "run:*",
        }, "recipient_address"],
      ] as const) {
        const rejected = await forward(message);
        expect(rejected.status, label).toBe(400);
        expect(await rejected.json(), label).toMatchObject({
          error: {
            code: "invalid_request",
            message: `message.${field} must resolve to a canonical message address.`,
          },
        });
      }

      for (const [label, message, code] of [
        ["sender-suffix-collision", {
          ...aliasMessage,
          message_id: "msg_sender_suffix_collision",
          sender: "role:source@carbon.evil",
        }, "internal_origin_forbidden"],
        ["recipient-suffix-collision", {
          ...aliasMessage,
          message_id: "msg_recipient_suffix_collision",
          recipient_address: "role:worker@blade.evil",
          recipient_host: "blade.evil",
        }, "internal_target_forbidden"],
        ["declared-host-suffix-collision", {
          ...aliasMessage,
          message_id: "msg_declared_host_suffix_collision",
          recipient_host: "blade.evil",
        }, "internal_target_forbidden"],
      ] as const) {
        const rejected = await forward(message);
        expect(rejected.status, label).toBe(403);
        expect(await rejected.json(), label).toMatchObject({
          error: { code },
        });
      }

      const opened = await openStateStore(stateStoreOptions);
      try {
        expect(readMessage(opened.db, "msg_inconsistent_classification")).toBeUndefined();
        expect(readMessage(opened.db, "msg_noncanonical_sender_role")).toBeUndefined();
        expect(readMessage(opened.db, "msg_noncanonical_recipient_backend")).toBeUndefined();
        expect(readMessage(opened.db, "msg_noncanonical_recipient_run")).toBeUndefined();
        expect(readMessage(opened.db, "msg_nonconcrete_recipient_run")).toBeUndefined();
        expect(readMessage(opened.db, "msg_sender_suffix_collision")).toBeUndefined();
        expect(readMessage(opened.db, "msg_recipient_suffix_collision")).toBeUndefined();
        expect(readMessage(opened.db, "msg_declared_host_suffix_collision")).toBeUndefined();
      } finally {
        opened.db.close();
      }
    } finally {
      await handle.close();
    }
  });

  test("keeps generic internal message ingress inert for resumable run addresses", async () => {
    const stateStoreOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(runsRoot, "message-run-admission-replay") },
    };
    const foreignStateOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(runsRoot, "message-run-admission-foreign") },
    };
    await applyStateMigrations({ storeOptions: foreignStateOptions });
    const foreign = await openStateStore(foreignStateOptions);
    const incoming = createMessage(foreign.db, {
      message_id: "msg_run_admission_replay",
      sender: "client:source@carbon",
      recipient_address: "run:source-run-admission",
      recipient_class: "directed",
      recipient_host: "blade",
      subject: "Correspond without implicit execution",
      body: "A control-plane operation must authorize any later turn.",
      idempotency_key: "message-run-admission-replay",
      now: "2026-07-14T06:00:00.000Z",
      created_provenance: {
        schema_version: "calyx.provenance/v1",
        request_id: "req_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        subject: "source",
        host: "carbon",
        via: "http",
        at: "2026-07-14T06:00:00.000Z",
      },
    }).message;
    foreign.db.close();

    const service = new RunService({ runsRoot }, buildDeps());
    await service.initializeRun(service.createIntent({
      run_id: "source-run-admission",
      host: "blade",
      backend: "codex",
      resume_session_id: "session-run-admission",
      worktree_path: runsRoot,
      require_execplan: false,
    }));
    const submitSpy = vi.spyOn(service, "submitDetached");
    const options = createServerOptions(service, registryRoot, {
      advertisedHost: "blade",
      stateStoreOptions,
      messageHostAliases: { carbon: "carbon" },
    });
    const handle = await startRunServer({
      ...options,
      credentials: [
        ...options.credentials,
        {
          client_id: "daemon:carbon",
          credential_tier: "internal_runtime",
          verifier: hashConsumerApiBearer("carbon-daemon-token"),
          verifier_env: "CALYX_CONSUMER_API_TEST_DAEMON_CARBON_VERIFIER",
          address_grants: { send_as: ["client:source@carbon"], read: ["host:carbon"] },
        },
      ],
    });
    const serverUrl = handle.url.replace("http://blade:", "http://127.0.0.1:");
    const forward = () => fetch(`${serverUrl}/v1/internal/messages/receive`, {
      method: "POST",
      headers: {
        authorization: "Bearer carbon-daemon-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ schema_version: "calyx.msg-send/v1", message: incoming }),
    });

    try {
      const first = await forward();
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual(expect.objectContaining({
        schema_version: "calyx.msg-receive/v1",
        inserted: true,
        escalation: {
          mode: "pointer_only",
          reason: "execution_requires_control_plane_authority",
        },
      }));
      expect(submitSpy).not.toHaveBeenCalled();

      const opened = await openStateStore(stateStoreOptions);
      try {
        expect(readMessage(opened.db, incoming.message_id)).toMatchObject({ status: "pending", acked_by: null });
        expect(opened.db.prepare(
          "SELECT delivery_id FROM message_deliveries WHERE message_id = ?",
        ).get(incoming.message_id)).toBeUndefined();
      } finally {
        opened.db.close();
      }

      const replay = await forward();
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        inserted: false,
        escalation: {
          mode: "pointer_only",
          reason: "execution_requires_control_plane_authority",
        },
      });
      expect(submitSpy).not.toHaveBeenCalled();
      expect(await service.getRunRecord("source-run-admission")).toMatchObject({
        run_id: "source-run-admission",
      });
    } finally {
      submitSpy.mockRestore();
      await handle.close();
    }
  });

  test("monitor create refuses unknown target-store runs before writing rows", async () => {
    const stateHome = join(runsRoot, "monitor-state-missing-run");
    const stateStoreOptions = { env: { ...process.env, CALYX_STATE_HOME: stateHome } };
    await applyStateMigrations({ storeOptions: stateStoreOptions });
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot, {
      advertisedHost: "blade",
      stateStoreOptions,
    }));
    const serverUrl = handle.url.replace("http://blade:", "http://127.0.0.1:");

    try {
      const createResponse = await fetch(`${serverUrl}/v1/admin/monitors`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema_version: "calyx.monitor-create-request/v1",
          idempotency_key: "monitor-create-unknown",
          owner: "operator",
          created_by: "server-test",
          create_provenance: "operator",
          assigned_host: "blade",
          source_run_id: "server-monitor-missing-run",
          preset: "runner-supervision",
          stale_after_ms: 1_800_000,
          rearm_policy: "every_change",
        }),
      });
      expect(createResponse.status).toBe(404);
      const body = await createResponse.json() as {
        error: { code: string; message: string; retryable: boolean; details: { hint: string } };
      };
      expect(body.error.code).toBe("monitor_run_unknown");
      expect(body.error.retryable).toBe(false);
      expect(body.error.message).toContain("server-monitor-missing-run");
      expect(body.error.details.hint).toBe("calyx run ps --host blade");

      const opened = await openStateStore(stateStoreOptions);
      try {
        expect(listMonitors(opened.db, { status: "all" })).toHaveLength(0);
      } finally {
        opened.db.close();
      }
    } finally {
      await handle.close();
    }
  });

  test("monitor create refuses assigned-host mismatch before writing rows", async () => {
    const stateHome = join(runsRoot, "monitor-state-host-mismatch");
    const stateStoreOptions = { env: { ...process.env, CALYX_STATE_HOME: stateHome } };
    await applyStateMigrations({ storeOptions: stateStoreOptions });
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot, {
      advertisedHost: "blade",
      stateStoreOptions,
    }));
    const serverUrl = handle.url.replace("http://blade:", "http://127.0.0.1:");

    try {
      const createResponse = await fetch(`${serverUrl}/v1/admin/monitors`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema_version: "calyx.monitor-create-request/v1",
          idempotency_key: "monitor-create-wrong-host",
          owner: "operator",
          created_by: "server-test",
          create_provenance: "operator",
          assigned_host: "worm",
          source_run_id: "server-monitor-mismatch-run",
          preset: "runner-supervision",
          stale_after_ms: 1_800_000,
          rearm_policy: "every_change",
        }),
      });
      expect(createResponse.status).toBe(409);
      const body = await createResponse.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe("monitor_assigned_host_mismatch");
      expect(body.error.message).toContain("worm");

      const opened = await openStateStore(stateStoreOptions);
      try {
        expect(listMonitors(opened.db, { status: "all" })).toHaveLength(0);
      } finally {
        opened.db.close();
      }
    } finally {
      await handle.close();
    }
  });

  test("lease endpoints reject wrong-owner writes and no-holder releases", async () => {
    const priorStateHome = process.env["CALYX_STATE_HOME"];
    const priorStateDb = process.env["CALYX_STATE_DB"];
    const stateRoot = await mkdtemp(join(tmpdir(), "calyx-run-server-leases-"));
    process.env["CALYX_STATE_HOME"] = join(stateRoot, "state");
    delete process.env["CALYX_STATE_DB"];
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer({
      ...createServerOptions(service, registryRoot),
      advertisedHost: "blade",
      hostname: () => "blade",
    });
    const postLease = (path: string, body: Record<string, unknown>) => fetch(`${handle.url}${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    try {
      const wrongOwnerHost = ["carbon", "worm", "mba"]
        .find((host) => host !== currentHostAlias() && host !== "blade") ?? "wrong-owner";
      const wrongOwner = await postLease("/v1/admin/leases/acquire", {
        key: `worktree:${wrongOwnerHost}:/tmp/calyx-pol-1790`,
        idempotency_key: "lease-wrong-owner",
        holder_activity_id: "run:first",
        ttl_ms: 60_000,
      });
      expect(wrongOwner.status).toBe(409);
      expect(await wrongOwner.json()).toMatchObject({
        error: {
          schema_version: "calyx.error/v1",
          code: "lease_owner_mismatch",
        },
      });

      const invalidKey = await postLease("/v1/admin/leases/acquire", {
        key: "garbage",
        idempotency_key: "lease-invalid-key",
        holder_activity_id: "run:first",
        ttl_ms: 60_000,
      });
      expect(invalidKey.status).toBe(400);
      expect(await invalidKey.json()).toMatchObject({
        error: { code: "invalid_request" },
      });
      const invalidKeyRequestId = invalidKey.headers.get("x-calyx-request-id");
      expect(invalidKeyRequestId).toBeTruthy();
      await vi.waitFor(async () => {
        const afterInvalidKey = await openStateStore();
        try {
          expect(afterInvalidKey.db.prepare(
            "SELECT operation_id, response_status, outcome FROM api_request_audit WHERE request_id = ?",
          ).get(invalidKeyRequestId)).toEqual({
            operation_id: "admin.lease.acquire",
            response_status: 400,
            outcome: "response_rejected",
          });
        } finally {
          afterInvalidKey.db.close();
        }
      });

      const key = "worktree:blade:/tmp/calyx-pol-1790";
      const acquired = await postLease("/v1/admin/leases/acquire", {
        key,
        idempotency_key: "lease-acquire-main",
        holder_activity_id: "run:first",
        ttl_ms: 60_000,
      });
      expect(acquired.status).toBe(200);
      const firstRequestId = acquired.headers.get("x-calyx-request-id");
      expect(firstRequestId).toMatch(/^req_[0-9a-f-]{36}$/);
      const acquiredBody = await acquired.json();

      const acquireReplay = await postLease("/v1/admin/leases/acquire", {
        key,
        idempotency_key: "lease-acquire-main",
        holder_activity_id: "run:first",
        ttl_ms: 60_000,
      });
      expect(acquireReplay.status).toBe(200);
      expect(await acquireReplay.json()).toEqual(acquiredBody);
      expect(acquireReplay.headers.get("x-calyx-request-id")).not.toBe(firstRequestId);

      const acquireMismatch = await postLease("/v1/admin/leases/acquire", {
        key,
        idempotency_key: "lease-acquire-main",
        holder_activity_id: "run:second",
        ttl_ms: 60_000,
      });
      expect(acquireMismatch.status).toBe(409);
      expect(await acquireMismatch.json()).toMatchObject({
        error: { code: "idempotency_conflict" },
      });

      const releaseWithoutHolder = await postLease("/v1/admin/leases/release", {
        key,
        idempotency_key: "lease-release-missing-holder",
      });
      expect(releaseWithoutHolder.status).toBe(409);
      const payload = await releaseWithoutHolder.json() as { error: { code: string; message: string } };
      expect(payload.error.code).toBe("lease_conflict");
      expect(payload.error.message).toContain("holder_activity_id");

      const releaseErrorReplay = await postLease("/v1/admin/leases/release", {
        key,
        idempotency_key: "lease-release-missing-holder",
      });
      expect(releaseErrorReplay.status).toBe(409);
      expect(await releaseErrorReplay.json()).toEqual(payload);

      const opened = await openStateStore();
      try {
        expect(listLeaseEvents(opened.db, key)).toHaveLength(1);
        expect(listLeaseEvents(opened.db, key)[0]).toMatchObject({
          event_type: "acquired",
          request_provenance: { request_id: firstRequestId },
        });
        expect(opened.db.prepare(
          `SELECT first_request_id FROM api_idempotency
            WHERE operation_id = 'admin.lease.acquire' AND idempotency_key = 'lease-acquire-main'`,
        ).get()).toEqual({ first_request_id: firstRequestId });
      } finally {
        opened.db.close();
      }
    } finally {
      await handle.close();
      if (priorStateHome === undefined) delete process.env["CALYX_STATE_HOME"];
      else process.env["CALYX_STATE_HOME"] = priorStateHome;
      if (priorStateDb === undefined) delete process.env["CALYX_STATE_DB"];
      else process.env["CALYX_STATE_DB"] = priorStateDb;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("honors limit for plain /runs lists", async () => {
    const interactiveHome = await mkdtemp(join(tmpdir(), "calyx-empty-interactive-home-"));
    const service = new RunService({ runsRoot, interactiveHomeDir: interactiveHome }, buildDeps());
    const persistRun = async (
      runId: string,
      updatedAt: string,
      prUrl?: string,
      host = "local",
    ): Promise<void> => {
      const record = await service.initializeRun(service.createIntent({
        run_id: runId,
        host,
        prompt: `Prompt for ${runId}`,
        require_execplan: false,
        ...(prUrl ? { metadata: { pr_url: prUrl } } : {}),
      }));
      await service.store.writeRunRecord(record.run_id, {
        ...record,
        state: "succeeded",
        created_at: updatedAt,
        updated_at: updatedAt,
        completed_at: updatedAt,
        summary: `Run ${runId} succeeded.`,
      });
    };
    await persistRun("run-a-old", "2026-05-09T12:01:00.000Z");
    await persistRun("run-z-new", "2026-05-09T12:03:00.000Z");
    await persistRun("run-m-middle", "2026-05-09T12:02:00.000Z", "PR #273");
    await persistRun("run-long-host", "2026-05-09T12:00:00.000Z", undefined, "h".repeat(256));
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      const listResponse = await fetch(`${handle.url}/v1/admin/runs?limit=1`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(listResponse.status).toBe(200);
      const list = await listResponse.json() as {
        schema_version: string;
        count: number;
        truncated: boolean;
        runs: Array<{ run_id: string }>;
      };
      expect(list).toMatchObject({
        schema_version: "calyx.run-list/v1",
        count: 1,
        truncated: true,
      });
      expect(list.runs).toHaveLength(1);
      expect(list.runs[0]?.run_id).toBe("run-z-new");

      const firstPageResponse = await fetch(`${handle.url}/v1/runs?limit=1&host=local`, {
        headers: { authorization: "Bearer secret-token" },
      });
      const firstPage = await firstPageResponse.json() as {
        runs: Array<{ run_id: string }>;
        next_cursor?: string;
      };
      expect(firstPageResponse.status).toBe(200);
      expect(firstPage.runs.map((run) => run.run_id)).toEqual(["run-z-new"]);
      expect(firstPage.next_cursor).toBeTruthy();

      const newest = await service.getRunRecord("run-z-new");
      await service.store.writeRunRecord("run-z-new", {
        ...newest!,
        updated_at: "2026-05-09T11:00:00.000Z",
      });
      const secondPageResponse = await fetch(
        `${handle.url}/v1/runs?limit=1&host=local&cursor=${encodeURIComponent(firstPage.next_cursor!)}`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      const secondPage = await secondPageResponse.json() as { runs: Array<{ run_id: string }>; next_cursor?: string };
      expect(secondPageResponse.status).toBe(200);
      expect(secondPage.runs.map((run) => run.run_id)).toEqual(["run-m-middle"]);
      expect(secondPage.runs[0]?.run_id).not.toBe(firstPage.runs[0]?.run_id);

      const firstActivityResponse = await fetch(`${handle.url}/v1/activity?limit=1&host=local`, {
        headers: { authorization: "Bearer secret-token" },
      });
      const firstActivity = await firstActivityResponse.json() as {
        activities: Array<{ run_id: string }>;
        next_cursor?: string;
      };
      expect(firstActivityResponse.status).toBe(200);
      expect(firstActivity.next_cursor).toBeTruthy();
      const secondActivityResponse = await fetch(
        `${handle.url}/v1/activity?limit=1&host=local&cursor=${encodeURIComponent(firstActivity.next_cursor!)}`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      const secondActivity = await secondActivityResponse.json() as { activities: Array<{ run_id: string }> };
      expect(secondActivityResponse.status).toBe(200);
      expect(secondActivity.activities[0]?.run_id).not.toBe(firstActivity.activities[0]?.run_id);

      const snapshotResponse = await fetch(`${handle.url}/v1/runs?limit=1&host=local`, {
        headers: { authorization: "Bearer secret-token" },
      });
      const snapshotPage = await snapshotResponse.json() as {
        runs: Array<{ run_id: string }>;
        next_cursor?: string;
      };
      expect(snapshotResponse.status).toBe(200);
      expect(snapshotPage.next_cursor).toBeTruthy();
      await persistRun("run-backdated-after-page-one", "2026-05-09T12:01:30.000Z");
      const staleContinuation = await fetch(
        `${handle.url}/v1/runs?limit=1&host=local&cursor=${encodeURIComponent(snapshotPage.next_cursor!)}`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(staleContinuation.status).toBe(400);
      await expect(staleContinuation.json()).resolves.toMatchObject({
        error: {
          code: "invalid_request",
          message: "cursor membership snapshot is stale; restart pagination",
        },
      });

      const poisonSafeList = await fetch(`${handle.url}/v1/runs?limit=100&host=local`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(poisonSafeList.status).toBe(200);
      const poisonSafeRuns = await poisonSafeList.json() as { runs: Array<{ run_id: string; pr_url?: string }> };
      expect(poisonSafeRuns.runs.find((run) => run.run_id === "run-m-middle")).toEqual(
        expect.not.objectContaining({ pr_url: expect.anything() }),
      );

      const poisonSafeGet = await fetch(`${handle.url}/v1/runs/run-m-middle`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(poisonSafeGet.status).toBe(200);
      expect(await poisonSafeGet.json()).toEqual(expect.not.objectContaining({ pr_url: expect.anything() }));

      const boundedHostList = await fetch(`${handle.url}/v1/runs?limit=100`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(boundedHostList.status).toBe(200);
      const boundedHostRuns = await boundedHostList.json() as { runs: Array<{ run_id: string; host: string }> };
      expect(boundedHostRuns.runs.find((run) => run.run_id === "run-long-host")?.host).toBe("unknown");
      const boundedHostGet = await fetch(`${handle.url}/v1/runs/run-long-host`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(boundedHostGet.status).toBe(200);
      await expect(boundedHostGet.json()).resolves.toMatchObject({ run_id: "run-long-host", host: "unknown" });
    } finally {
      await handle.close();
      await rm(interactiveHome, { recursive: true, force: true });
    }
  });

  test("seek pagination uses the same UTF-8 binary run-id order as its cursor predicate", async () => {
    const interactiveHome = await mkdtemp(join(tmpdir(), "calyx-binary-order-interactive-home-"));
    const service = new RunService({ runsRoot, interactiveHomeDir: interactiveHome }, buildDeps());
    const createdAt = "2026-05-09T12:03:00.000Z";
    for (const runId of ["run-z-tie", "run-A-tie"]) {
      const record = await service.initializeRun(service.createIntent({
        run_id: runId,
        host: "local",
        prompt: `Prompt for ${runId}`,
        require_execplan: false,
      }));
      await service.store.writeRunRecord(runId, {
        ...record,
        state: "succeeded",
        created_at: createdAt,
        updated_at: createdAt,
        completed_at: createdAt,
      });
    }
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      const firstResponse = await fetch(`${handle.url}/v1/runs?limit=1&host=local`, {
        headers: { authorization: "Bearer secret-token" },
      });
      const first = await firstResponse.json() as {
        runs: Array<{ run_id: string }>;
        next_cursor?: string;
      };
      expect(first.runs.map((run) => run.run_id)).toEqual(["run-A-tie"]);
      expect(first.next_cursor).toBeTruthy();

      const secondResponse = await fetch(
        `${handle.url}/v1/runs?limit=1&host=local&cursor=${encodeURIComponent(first.next_cursor!)}`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      const second = await secondResponse.json() as { runs: Array<{ run_id: string }> };
      expect(second.runs.map((run) => run.run_id)).toEqual(["run-z-tie"]);
    } finally {
      await handle.close();
      await rm(interactiveHome, { recursive: true, force: true });
    }
  });

  test("merged run and activity cursors preserve an equal-key interactive row after its managed run", async () => {
    const interactiveHome = await mkdtemp(join(tmpdir(), "calyx-equal-key-interactive-home-"));
    const codexDir = join(interactiveHome, ".codex", "sessions", "2026", "04", "28");
    const sessionId = "019dcafe-1111-7222-8333-equalkey00002";
    const runId = `interactive:codex:${sessionId}`;
    const createdAt = "2026-04-28T12:00:00.000Z";
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, `rollout-2026-04-28T12-00-00-${sessionId}.jsonl`),
      JSON.stringify({
        type: "session_meta",
        payload: { id: sessionId, timestamp: createdAt },
      }),
      "utf8",
    );
    const service = new RunService({ runsRoot, interactiveHomeDir: interactiveHome }, buildDeps());
    const record = await service.initializeRun(service.createIntent({
      run_id: runId,
      host: "local",
      backend: "codex",
      prompt: "Managed half of an equal public activity key",
      require_execplan: false,
    }));
    await service.store.writeRunRecord(runId, {
      ...record,
      state: "succeeded",
      created_at: createdAt,
      updated_at: createdAt,
      completed_at: createdAt,
    });
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      for (const route of [
        {
          path: "/v1/admin/runs?include_interactive=true&limit=1",
          collection: "runs",
          discriminator: "entry_kind",
          expected: ["calyx_run", "interactive_session"],
        },
        {
          path: "/v1/runs?limit=1",
          collection: "runs",
          discriminator: "kind",
          expected: ["run", "interactive"],
        },
        {
          path: "/v1/activity?limit=1",
          collection: "activities",
          discriminator: "kind",
          expected: ["run", "interactive"],
        },
      ] as const) {
        const firstResponse = await fetch(`${handle.url}${route.path}`, {
          headers: { authorization: "Bearer secret-token" },
        });
        expect(firstResponse.status).toBe(200);
        const first = await firstResponse.json() as Record<string, unknown> & {
          next_cursor?: string;
        };
        const firstEntries = first[route.collection] as Array<Record<string, unknown>>;
        expect(firstEntries).toEqual([
          expect.objectContaining({
            run_id: runId,
            [route.discriminator]: route.expected[0],
          }),
        ]);
        expect(first.next_cursor).toBeTruthy();

        const secondResponse = await fetch(
          `${handle.url}${route.path}&cursor=${encodeURIComponent(first.next_cursor!)}`,
          { headers: { authorization: "Bearer secret-token" } },
        );
        expect(secondResponse.status).toBe(200);
        const second = await secondResponse.json() as Record<string, unknown>;
        const secondEntries = second[route.collection] as Array<Record<string, unknown>>;
        expect(secondEntries).toEqual([
          expect.objectContaining({
            run_id: runId,
            [route.discriminator]: route.expected[1],
          }),
        ]);
      }
    } finally {
      await handle.close();
      await rm(interactiveHome, { recursive: true, force: true });
    }
  });

  test("fails consumer activity lists typed when immutable identity discovery exceeds its bound", async () => {
    const interactiveHome = await mkdtemp(join(tmpdir(), "calyx-bounded-interactive-home-"));
    const codexDir = join(interactiveHome, ".codex", "sessions", "2026", "04", "28");
    await mkdir(codexDir, { recursive: true });
    for (const suffix of ["1", "2", "3"]) {
      const id = `019dcafe-1111-7222-8333-abcabcabcab${suffix}`;
      await writeFile(
        join(codexDir, `rollout-2026-04-28T12-00-0${suffix}-${id}.jsonl`),
        JSON.stringify({ type: "session_meta", payload: { id, timestamp: `2026-04-28T12:00:0${suffix}.000Z` } }),
        "utf8",
      );
    }
    const service = new RunService({
      runsRoot,
      interactiveHomeDir: interactiveHome,
      interactivePageCandidateLimit: 2,
    }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    try {
      for (const route of [
        "/v1/runs?limit=1",
        "/v1/activity?limit=1",
        "/v1/runs/interactive%3Acodex%3A019dcafe-1111-7222-8333-abcabcabcab1",
      ]) {
        const response = await fetch(`${handle.url}${route}`, {
          headers: { authorization: "Bearer secret-token" },
        });
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
          error: {
            schema_version: "calyx.error/v1",
            code: "activity_projection_not_ready",
            retryable: true,
            details: {
              reason: "candidate_limit",
              candidate_limit: 2,
              candidates_seen: 3,
            },
          },
        });
      }
    } finally {
      await handle.close();
      await rm(interactiveHome, { recursive: true, force: true });
    }
  });

  test("fails consumer list and detail projections typed on transcript discovery I/O errors", async () => {
    const interactiveHome = await mkdtemp(join(tmpdir(), "calyx-unreadable-interactive-home-"));
    const codexRoot = join(interactiveHome, ".codex", "sessions");
    const codexDir = join(codexRoot, "2026", "04", "28");
    const sessionId = "019dcafe-2222-7222-8333-abcabcabcabc";
    const source = join(codexDir, `rollout-2026-04-28T12-00-00-${sessionId}.jsonl`);
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      source,
      JSON.stringify({ type: "session_meta", payload: { id: sessionId, timestamp: "2026-04-28T12:00:00.000Z" } }),
      "utf8",
    );
    let fault: "root" | "child" | "candidate" = "root";
    const ioFailure = () => Object.assign(new Error("private filesystem detail"), { code: "EIO" });
    const service = new RunService({
      runsRoot,
      interactiveHomeDir: interactiveHome,
      interactiveBeforeDiscoveryRead: async (directoryPath) => {
        if ((fault === "root" && directoryPath === codexRoot) || (fault === "child" && directoryPath === codexDir)) {
          throw ioFailure();
        }
      },
      interactiveBeforeCandidateStat: async (candidatePath) => {
        if (fault === "candidate" && candidatePath === source) throw ioFailure();
      },
    }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot, { advertisedHost: "blade" }));
    try {
      const activityId = `interactive:codex:${sessionId}`;
      for (const nextFault of ["root", "child", "candidate"] as const) {
        fault = nextFault;
        for (const route of [
          "/v1/runs?limit=1",
          "/v1/activity?limit=1",
          `/v1/runs/${encodeURIComponent(activityId)}`,
          `/v1/activity/${encodeURIComponent(activityId)}/messages`,
          `/v1/activity/${encodeURIComponent(activityId)}/turns`,
        ]) {
          const response = await fetch(`${handle.url}${route}`, {
            headers: { authorization: "Bearer secret-token" },
          });
          expect(response.status, `${fault} ${route}`).toBe(503);
          const body = await response.json();
          expect(body, `${fault} ${route}`).toMatchObject({
            error: {
              code: "activity_projection_not_ready",
              retryable: true,
              details: { reason: "discovery_read_failed" },
            },
          });
          expect(JSON.stringify(body)).not.toMatch(/private filesystem detail|calyx-unreadable-interactive-home/);
        }
      }
    } finally {
      await handle.close();
      await rm(interactiveHome, { recursive: true, force: true });
    }
  });

  test("preserves typed retryability on every consumer activity detail handler", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const failure = () => new InteractiveActivityProjectionNotReadyError(
      "Interactive activity source discovery is temporarily unavailable.",
      { reason: "discovery_read_failed", source_path: "/private/transcript/root" },
    );
    vi.spyOn(service, "inspectActivityMessages").mockRejectedValue(failure());
    vi.spyOn(service, "inspectActivityTurns").mockRejectedValue(failure());
    vi.spyOn(service, "inspectActivityAttachments").mockRejectedValue(failure());
    vi.spyOn(service, "inspectActivityText").mockRejectedValue(failure());
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    const activityId = "interactive:codex:019dcafe-3333-7222-8333-abcabcabcabc";
    try {
      for (const route of [
        `/v1/activity/${encodeURIComponent(activityId)}/messages`,
        `/v1/activity/${encodeURIComponent(activityId)}/turns`,
        `/v1/activity/${encodeURIComponent(activityId)}/attachments`,
        `/v1/activity-text/${encodeURIComponent(`${activityId}:msg:1`)}`,
      ]) {
        const response = await fetch(`${handle.url}${route}`, {
          headers: { authorization: "Bearer secret-token" },
        });
        expect(response.status, route).toBe(503);
        const body = await response.json();
        expect(body, route).toMatchObject({
          error: {
            code: "activity_projection_not_ready",
            retryable: true,
            details: { reason: "discovery_read_failed" },
          },
        });
        expect(JSON.stringify(body), route).not.toContain("/private/transcript/root");
      }
    } finally {
      await handle.close();
    }
  });

  test("maps only reachable interactive resolver failures on work.get", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const resolveSpy = vi.spyOn(service, "resolveInteractiveSession")
      .mockRejectedValueOnce(new ActivityIdAmbiguousError("019dcafe", "sessions", []))
      .mockRejectedValueOnce(new Error("unexpected /secret/resolver detail"));
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    try {
      const ambiguous = await fetch(`${handle.url}/v1/runs/019dcafe`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(ambiguous.status).toBe(409);
      expect(await ambiguous.json()).toMatchObject({ error: { code: "activity_ambiguous" } });

      const unexpected = await fetch(`${handle.url}/v1/runs/unexpected`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(unexpected.status).toBe(500);
      const text = await unexpected.text();
      expect(text).not.toContain("/secret/resolver");
      expect(JSON.parse(text)).toMatchObject({
        error: {
          code: "internal_error",
          message: "The server could not complete the request.",
        },
      });
    } finally {
      resolveSpy.mockRestore();
      await handle.close();
    }
  });

  test("bounds consumer activity page enrichment concurrency at eight", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const entries = Array.from({ length: 10 }, (_, index) => {
      const sessionId = `019dcafe-${String(index).padStart(4, "0")}-7222-8333-abcabcabcabc`;
      return {
        entry_kind: "interactive_session" as const,
        run_id: `interactive:codex:${sessionId}`,
        state: "interactive" as const,
        summary: "private",
        created_at: `2026-07-31T00:${String(59 - index).padStart(2, "0")}:00.000Z`,
        updated_at: "2026-07-31T01:00:00.000Z",
        host: "blade",
        backend: "codex" as const,
        session_id: sessionId,
        session_path: `/private/${sessionId}.jsonl`,
        cwd: `/Users/caleb/dev/calyx/wt/feature-${index}`,
        source: "codex_sessions" as const,
      };
    });
    vi.spyOn(service, "listActivitySnapshotPage").mockResolvedValue({
      entries,
      membershipFence: "test-membership-fence",
    });
    let active = 0;
    let maximumActive = 0;
    let releaseProjection = (): void => {
      throw new Error("projection gate was not initialized");
    };
    const projectionGate = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    const inspectSpy = vi.spyOn(service, "inspectActivityTurns").mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await projectionGate;
      active -= 1;
      return { total_messages: 0, turns: [] } as never;
    });
    const handle = await startRunServer(createServerOptions(service, registryRoot, {
      advertisedHost: "blade",
    }));

    try {
      const responsePromise = fetch(`${handle.url}/v1/activity?limit=10`, {
        headers: { authorization: "Bearer secret-token" },
      });
      await vi.waitFor(() => {
        expect(inspectSpy).toHaveBeenCalledTimes(8);
      });
      expect(maximumActive).toBe(8);
      releaseProjection();

      const response = await responsePromise;
      expect(response.status).toBe(200);
      const body = await response.json() as { activities: unknown[]; count: number };
      expect(body.count).toBe(10);
      expect(body.activities).toHaveLength(10);
      expect(inspectSpy).toHaveBeenCalledTimes(10);
      expect(maximumActive).toBe(8);
    } finally {
      releaseProjection();
      await handle.close();
    }
  });

  test("includes interactive sessions in /runs and /health when requested", async () => {
    const home = join(runsRoot, "home");
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    await mkdir(codexDir, { recursive: true });
    const oldSessionFilenameId = "019dcafe-ffff-7222-8333-abcabcabcabc";
    const oldSessionCanonicalId = "019dcafe-0000-7222-8333-abcabcabcabc";
    const oldSessionPath = join(codexDir, `rollout-2026-04-01T12-00-00-${oldSessionFilenameId}.jsonl`);
    await writeFile(
      oldSessionPath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: oldSessionCanonicalId,
            timestamp: "2026-04-01T12:00:00.000Z",
            cwd: "/Users/caleb/dev/calyx/dev",
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Historical activity" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-01T12:00:00.500Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Ready for operator review" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-01T12:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "private_tool",
            arguments: '{"token":"must-not-cross"}',
          },
        }),
      ].join("\n"),
      "utf8",
    );
    await utimes(
      oldSessionPath,
      new Date("2026-03-01T00:00:00.000Z"),
      new Date("2026-03-01T00:00:00.000Z"),
    );
    await writeFile(
      join(codexDir, "rollout-2026-03-11T11-30-00-019dcafe-1111-7222-8333-abcabcabcabc.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "019dcafe-1111-7222-8333-abcabcabcabc",
            timestamp: "2026-03-10T12:00:00.000Z",
            cwd: "/Users/caleb/dev/calyx/dev",
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Unify activity" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const service = new RunService({ runsRoot, interactiveHomeDir: home }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot, { advertisedHost: "blade" }));

    try {
      const remoteFiltered = await fetch(`${handle.url}/v1/admin/runs?include_interactive=1&host=carbon&agent_kind=codex`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(remoteFiltered.status).toBe(200);
      const remoteList = await remoteFiltered.json() as {
        schema_version: string;
        count: number;
        truncated: boolean;
        runs: Array<{ entry_kind?: string; run_id: string; host?: string }>;
      };
      expect(remoteList.schema_version).toBe("calyx.run-list/v1");
      expect(remoteList.runs).not.toContainEqual(expect.objectContaining({
        entry_kind: "interactive_session",
        run_id: `interactive:codex:${oldSessionCanonicalId}`,
      }));

      const listResponse = await fetch(`${handle.url}/v1/admin/runs?include_interactive=1&host=blade&agent_kind=codex`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(listResponse.status).toBe(200);
      const list = await listResponse.json() as {
        schema_version: string;
        count: number;
        truncated: boolean;
        runs: Array<{ entry_kind?: string; run_id: string; host?: string }>;
      };
      expect(list.schema_version).toBe("calyx.run-list/v1");
      expect(list.runs).toContainEqual(expect.objectContaining({
        entry_kind: "interactive_session",
        run_id: `interactive:codex:${oldSessionCanonicalId}`,
        host: "blade",
      }));

      for (const route of ["/v1/runs?limit=100&host=carbon", "/v1/activity?limit=100&host=carbon"]) {
        const response = await fetch(`${handle.url}${route}`, {
          headers: { authorization: "Bearer secret-token" },
        });
        expect(response.status, route).toBe(200);
        expect(JSON.stringify(await response.json()), route).not.toContain(oldSessionCanonicalId);
      }

      const consumerList = await fetch(`${handle.url}/v1/runs?limit=100`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(consumerList.status).toBe(200);
      expect(await consumerList.json()).toMatchObject({
        runs: expect.arrayContaining([
          expect.objectContaining({
            run_id: `interactive:codex:${oldSessionCanonicalId}`,
            kind: "interactive",
          }),
        ]),
      });
      const consumerActivity = await fetch(`${handle.url}/v1/activity?limit=100`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(consumerActivity.status).toBe(200);
      const consumerActivityBody = await consumerActivity.json();
      expect(consumerActivityBody).toMatchObject({
        activities: expect.arrayContaining([
          expect.objectContaining({
            run_id: `interactive:codex:${oldSessionCanonicalId}`,
            kind: "interactive",
            attention_state: "awaiting",
            repo_ref: "calyx",
            latest_visible_message_excerpt: "Ready for operator review",
            visible_message_count: 1,
          }),
        ]),
      });
      expect(JSON.stringify(consumerActivityBody)).not.toMatch(/private_tool|must-not-cross|session_path|cwd/u);
      for (const locator of [`interactive:codex:${oldSessionCanonicalId}`, oldSessionFilenameId]) {
        const detail = await fetch(`${handle.url}/v1/runs/${encodeURIComponent(locator)}`, {
          headers: { authorization: "Bearer secret-token" },
        });
        expect(detail.status, locator).toBe(200);
        expect(await detail.json(), locator).toMatchObject({
          schema_version: "calyx.run-observation/v1",
          run_id: `interactive:codex:${oldSessionCanonicalId}`,
          kind: "interactive",
          backend: "codex",
        });
      }

      const health = await fetch(`${handle.url}/v1/admin/health`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({
        interactive_sessions: {
          codex: 1,
          total: 1,
        },
      });
    } finally {
      await handle.close();
    }
  });

  test("keeps /health responsive when interactive session summary is slow", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    vi.spyOn(service, "interactiveSessionSummary").mockImplementation(async () => (
      new Promise((resolve) => {
        setTimeout(() => resolve({
          window_ms: 0,
          scanned_at: "2026-03-10T12:00:00.000Z",
          codex: 1,
          claude: 0,
          total: 1,
          status: "ok",
        }), 5_000);
      })
    ));
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      const started = Date.now();
      const health = await fetch(`${handle.url}/v1/admin/health`, {
        headers: { authorization: "Bearer secret-token" },
      });
      const elapsed = Date.now() - started;
      expect(health.status).toBe(200);
      expect(elapsed).toBeLessThan(1_500);
      expect(await health.json()).toMatchObject({
        interactive_sessions: {
          status: "unavailable",
          reason: "timeout",
          timed_out_ms: 250,
        },
      });
    } finally {
      await handle.close();
    }
  });

  test("serves bounded interactive activity detail", async () => {
    const home = await mkdtemp(join(tmpdir(), "calyx-server-interactive-detail-"));
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, "rollout-2026-03-10T12-00-00-019dcafe-1111-7222-8333-abcabcabcabc.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "019dcafe-1111-7222-8333-abcabcabcabc" } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Diagnose run service pothole" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Use calyx activity detail for progressive disclosure." }],
          },
        }),
      ].join("\n"),
      "utf8",
    );
    const service = new RunService({ runsRoot, interactiveHomeDir: home }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      const response = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent("interactive:codex:019dcafe-1111-7222-8333-abcabcabcabc")}?around=progressive&context=1`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        activity_id: "interactive:codex:019dcafe-1111-7222-8333-abcabcabcabc",
        backend: "codex",
        returned_events: 2,
        events: [
          expect.objectContaining({ role: "user", summary: "Diagnose run service pothole" }),
          expect.objectContaining({ role: "assistant", summary: "Use calyx activity detail for progressive disclosure." }),
        ],
      });
    } finally {
      await handle.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("serves /v1/activity messages/events and validates selector queries", async () => {
    const home = await mkdtemp(join(tmpdir(), "calyx-server-activity-v1-"));
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    const activityId = "interactive:codex:019dcafe-1111-7222-8333-abcabcabcabc";
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, "rollout-2026-03-10T12-00-00-019dcafe-1111-7222-8333-abcabcabcabc.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "019dcafe-1111-7222-8333-abcabcabcabc" } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>..." }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Review activity API selectors" },
              { type: "input_image", image_url: `data:image/png;base64,${Buffer.from("image bytes").toString("base64")}` },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );
    const service = new RunService({ runsRoot, interactiveHomeDir: home }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      const messages = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/messages?role=harness-context&visibility=%2Bhidden&first=1`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(messages.status).toBe(200);
      expect(await messages.json()).toMatchObject({
        schema_version: "activity.messages/v1",
        messages: [
          expect.objectContaining({
            role: "harness_context",
            visibility: "hidden",
          }),
        ],
      });

      const events = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/events?raw_role=user&tail=1&classify=1`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(events.status).toBe(200);
      expect(await events.json()).toMatchObject({
        schema_version: "activity.events/v1",
        events: [
          expect.objectContaining({
            role: "user",
            classification: expect.objectContaining({ projected_role: "human" }),
          }),
        ],
      });

      const humanMessages = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/messages?role=human&first=1&max_text_chars=2000`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(humanMessages.status).toBe(200);
      const humanBody = await humanMessages.json() as {
        classifier_version: string;
        messages: Array<{ id: string; text: string; attachments: Array<{ ref: string; source_shape: string }> }>;
      };
      const messageId = humanBody.messages[0]?.id;
      expect(messageId).toBeTruthy();
      expect(humanBody.messages[0]?.text).toContain("att:sha256:");
      expect(humanBody.messages[0]?.text).not.toContain("data:image");
      expect(humanBody.messages[0]?.attachments[0]?.source_shape).toBe("codex.input_image.data_url");

      const text = await fetch(
        `${handle.url}/v1/admin/activity-text/${encodeURIComponent(messageId!)}?range=0:6&classifier_version=${humanBody.classifier_version}`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(text.status).toBe(200);
      expect(await text.json()).toMatchObject({
        schema_version: "activity.text/v1",
        text: "Review",
        text_cursor: { returned: [[0, 6]] },
      });

      const attachments = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/attachments?message=${encodeURIComponent(messageId!)}&extract=1`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(attachments.status).toBe(200);
      const attachmentBody = await attachments.json() as {
        schema_version: string;
        attachments: Array<{ ref: string; extracted_path: string; source_shape: string }>;
      };
      expect(attachmentBody.schema_version).toBe("activity.attachments/v1");
      expect(attachmentBody.attachments[0]?.ref).toBe(humanBody.messages[0]?.attachments[0]?.ref);
      expect(attachmentBody.attachments[0]?.source_shape).toBe("codex.input_image.data_url");
      expect(await readFile(attachmentBody.attachments[0]!.extracted_path!, "utf8")).toBe("image bytes");
      const ref = attachmentBody.attachments[0]!.ref;

      const record = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/attachments/${encodeURIComponent(ref)}`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(record.status).toBe(200);
      expect(await record.json()).toMatchObject({
        schema_version: "activity.attachment-record/v1",
        ref,
        mime_type: "image/png",
        byte_size: Buffer.from("image bytes").length,
        source_tier: "origin-daemon",
        served_by_host: "127.0.0.1",
        exact_bytes_available: true,
      });

      const bytes = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/attachments/${encodeURIComponent(ref)}/bytes`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(bytes.status).toBe(200);
      expect(bytes.headers.get("content-type")).toBe("image/png");
      expect(bytes.headers.get("x-calyx-attachment-ref")).toBe(ref);
      expect(bytes.headers.get("x-calyx-source-tier")).toBe("origin-daemon");
      expect(await bytes.text()).toBe("image bytes");

      const head = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/attachments/${encodeURIComponent(ref)}/bytes`,
        { method: "HEAD", headers: { authorization: "Bearer secret-token" } },
      );
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(Buffer.from("image bytes").length));
      expect(await head.text()).toBe("");

      const unknown = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/attachments/${encodeURIComponent(`att:sha256:${"b".repeat(64)}`)}`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({
        error: {
          code: "attachment_ref_unknown",
        },
      });

      const unauthorized = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/attachments/${encodeURIComponent(ref)}`,
      );
      expect(unauthorized.status).toBe(401);

      const mismatchSpy = vi.spyOn(service, "readActivityAttachmentBytes").mockRejectedValueOnce(
        new ActivityAttachmentError(
          "attachment_digest_mismatch",
          "Attachment digest mismatch in test.",
          {
            details: {
              ref,
              activity_id: activityId,
              expected_sha256: "a".repeat(64),
              actual_sha256: "b".repeat(64),
            },
          },
        ),
      );
      const mismatch = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/attachments/${encodeURIComponent(ref)}/bytes`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(mismatch.status).toBe(422);
      expect(await mismatch.json()).toMatchObject({
        error: {
          code: "attachment_digest_mismatch",
          details: {
            expected_sha256: "a".repeat(64),
            actual_sha256: "b".repeat(64),
          },
        },
      });
      mismatchSpy.mockRestore();

      const unavailableSpy = vi.spyOn(service, "readActivityAttachmentBytes").mockRejectedValueOnce(
        new ActivityAttachmentError(
          "attachment_bytes_unavailable",
          "Attachment bytes unavailable in test.",
          { details: { ref, activity_id: activityId } },
        ),
      );
      const unavailable = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/attachments/${encodeURIComponent(ref)}/bytes`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(unavailable.status).toBe(409);
      expect(await unavailable.json()).toMatchObject({
        error: { code: "attachment_bytes_unavailable" },
      });
      unavailableSpy.mockRestore();

      const listMismatchSpy = vi.spyOn(service, "inspectActivityAttachments").mockRejectedValueOnce(
        new ActivityAttachmentError(
          "attachment_digest_mismatch",
          "Attachment digest mismatch during extract in test.",
          { details: { ref, activity_id: activityId } },
        ),
      );
      const listMismatch = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/attachments?extract=1`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(listMismatch.status).toBe(422);
      expect(await listMismatch.json()).toMatchObject({
        error: { code: "attachment_digest_mismatch" },
      });
      listMismatchSpy.mockRestore();

      const ambiguousRole = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/messages?role=user`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(ambiguousRole.status).toBe(400);
      expect(await ambiguousRole.json()).toMatchObject({
        error: { schema_version: "calyx.error/v1", code: "invalid_activity_selector", message: expect.stringContaining("ambiguous role") },
      });

      const invalidVisibility = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/messages?visibility=nope`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(invalidVisibility.status).toBe(400);
      expect(await invalidVisibility.json()).toMatchObject({
        error: { schema_version: "calyx.error/v1", code: "invalid_activity_selector", message: expect.stringContaining("Invalid visibility") },
      });

      const invalidTail = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/events?tail=latest`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(invalidTail.status).toBe(400);
      expect(await invalidTail.json()).toMatchObject({
        error: { schema_version: "calyx.error/v1", code: "invalid_request", message: expect.stringContaining("tail must be") },
      });

      const invalidRawRole = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/events?raw_role=human`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(invalidRawRole.status).toBe(400);
      expect(await invalidRawRole.json()).toMatchObject({
        error: { schema_version: "calyx.error/v1", code: "invalid_activity_selector", message: expect.stringContaining("Invalid raw_role") },
      });
    } finally {
      await handle.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("cursor-pages consumer activity messages, turns, and attachments across live appends", async () => {
    const home = await mkdtemp(join(tmpdir(), "calyx-server-consumer-activity-pages-"));
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    const sessionId = "019dcafe-3333-7222-8333-abcabcabcabc";
    const activityId = `interactive:codex:${sessionId}`;
    const sessionPath = join(codexDir, `rollout-2026-03-10T12-00-00-${sessionId}.jsonl`);
    const responseMessage = (role: "user" | "assistant", text: string, image?: string) => JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role,
        content: [
          { type: role === "user" ? "input_text" : "output_text", text },
          ...(image ? [{ type: "input_image", image_url: `data:image/png;base64,${Buffer.from(image).toString("base64")}` }] : []),
        ],
      },
    });
    await mkdir(codexDir, { recursive: true });
    await writeFile(sessionPath, [
      JSON.stringify({ type: "session_meta", payload: { id: sessionId } }),
      responseMessage("user", "one", "image-one"),
      responseMessage("assistant", "two"),
      responseMessage("user", "three", "image-three"),
      responseMessage("assistant", "four"),
    ].join("\n"), "utf8");
    const service = new RunService({ runsRoot, interactiveHomeDir: home }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    const auth = { authorization: "Bearer secret-token" };

    try {
      const firstMessages = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/messages?limit=2`,
        { headers: auth },
      );
      expect(firstMessages.status).toBe(200);
      const firstMessageBody = await firstMessages.json() as {
        messages: Array<{ id: string }>;
        truncated: boolean;
        next_cursor?: string;
      };
      expect(firstMessageBody.messages).toHaveLength(2);
      expect(firstMessageBody.truncated).toBe(true);
      expect(firstMessageBody.next_cursor).toBeTruthy();

      const firstTurns = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/turns?limit=1`,
        { headers: auth },
      );
      const firstTurnBody = await firstTurns.json() as {
        turns: Array<{ turn_id: string }>;
        next_cursor?: string;
      };
      expect(firstTurns.status).toBe(200);
      expect(firstTurnBody.turns).toHaveLength(1);
      expect(firstTurnBody.next_cursor).toBeTruthy();

      const newestMessages = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/messages?limit=2&order=newest_first`,
        { headers: auth },
      );
      expect(newestMessages.status).toBe(200);
      const newestMessageBody = await newestMessages.json() as {
        messages: Array<{ id: string; text?: string }>;
        truncated: boolean;
        next_cursor?: string;
      };
      expect(newestMessageBody.messages).toMatchObject([
        { text: "four" },
        { text: expect.stringContaining("three") },
      ]);
      expect(newestMessageBody.truncated).toBe(true);
      expect(newestMessageBody.next_cursor).toBeTruthy();

      const olderMessages = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/messages?limit=2&order=newest_first&cursor=${encodeURIComponent(newestMessageBody.next_cursor!)}`,
        { headers: auth },
      );
      expect(olderMessages.status).toBe(200);
      const olderMessageBody = await olderMessages.json() as {
        messages: Array<{ id: string; text?: string }>;
        truncated: boolean;
        next_cursor?: string;
      };
      expect(olderMessageBody.messages).toMatchObject([
        { text: "two" },
        { text: expect.stringContaining("one") },
      ]);
      expect(olderMessageBody.truncated).toBe(false);
      expect(olderMessageBody.next_cursor).toBeUndefined();

      const mismatchedOrder = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/messages?limit=2&cursor=${encodeURIComponent(newestMessageBody.next_cursor!)}`,
        { headers: auth },
      );
      expect(mismatchedOrder.status).toBe(400);
      expect(await mismatchedOrder.json()).toMatchObject({ error: { code: "invalid_request" } });

      const newestTurns = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/turns?limit=1&order=newest_first`,
        { headers: auth },
      );
      expect(newestTurns.status).toBe(200);
      const newestTurnBody = await newestTurns.json() as {
        turns: Array<{ index: number }>;
        truncated: boolean;
        next_cursor?: string;
      };
      expect(newestTurnBody.turns).toEqual([expect.objectContaining({ index: 3 })]);
      expect(newestTurnBody.truncated).toBe(true);
      expect(newestTurnBody.next_cursor).toBeTruthy();

      const olderTurns = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/turns?limit=1&order=newest_first&cursor=${encodeURIComponent(newestTurnBody.next_cursor!)}`,
        { headers: auth },
      );
      expect(olderTurns.status).toBe(200);
      expect(await olderTurns.json()).toMatchObject({
        truncated: true,
        turns: [expect.objectContaining({ index: 2 })],
      });

      const firstAttachments = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/attachments?limit=1`,
        { headers: auth },
      );
      const firstAttachmentBody = await firstAttachments.json() as {
        attachments: Array<{ ref: string }>;
        next_cursor?: string;
      };
      expect(firstAttachments.status).toBe(200);
      expect(firstAttachmentBody.attachments).toHaveLength(1);
      expect(firstAttachmentBody.next_cursor).toBeTruthy();

      await appendFile(sessionPath, `\n${responseMessage("user", "five", "image-five")}`, "utf8");

      const secondMessages = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/messages?limit=2&cursor=${encodeURIComponent(firstMessageBody.next_cursor!)}`,
        { headers: auth },
      );
      const secondMessageBody = await secondMessages.json() as {
        messages: Array<{ id: string }>;
        next_cursor?: string;
      };
      expect(secondMessages.status).toBe(200);
      expect(secondMessageBody.messages).toHaveLength(2);
      expect(secondMessageBody.messages.map((message) => message.id))
        .not.toEqual(expect.arrayContaining(firstMessageBody.messages.map((message) => message.id)));
      expect(secondMessageBody.next_cursor).toBeTruthy();

      const finalMessages = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/messages?limit=2&cursor=${encodeURIComponent(secondMessageBody.next_cursor!)}`,
        { headers: auth },
      );
      const finalMessageBody = await finalMessages.json() as { messages: Array<{ id: string }>; truncated: boolean; next_cursor?: string };
      expect(finalMessageBody.messages).toHaveLength(1);
      expect(finalMessageBody.truncated).toBe(false);
      expect(finalMessageBody.next_cursor).toBeUndefined();

      const secondTurns = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/turns?limit=1&cursor=${encodeURIComponent(firstTurnBody.next_cursor!)}`,
        { headers: auth },
      );
      const secondTurnBody = await secondTurns.json() as { turns: Array<{ turn_id: string }> };
      expect(secondTurns.status).toBe(200);
      expect(secondTurnBody.turns[0]?.turn_id).not.toBe(firstTurnBody.turns[0]?.turn_id);

      const secondAttachments = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/attachments?limit=1&cursor=${encodeURIComponent(firstAttachmentBody.next_cursor!)}`,
        { headers: auth },
      );
      const secondAttachmentBody = await secondAttachments.json() as { attachments: Array<{ ref: string }> };
      expect(secondAttachments.status).toBe(200);
      expect(secondAttachmentBody.attachments[0]?.ref).not.toBe(firstAttachmentBody.attachments[0]?.ref);

      const forbidden = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/messages?last=1`,
        { headers: auth },
      );
      expect(forbidden.status).toBe(400);
      expect(await forbidden.json()).toMatchObject({
        error: { code: "consumer_selector_forbidden" },
      });
      const forbiddenList = await fetch(`${handle.url}/v1/activity?last=1`, { headers: auth });
      expect(forbiddenList.status).toBe(400);
      expect(await forbiddenList.json()).toMatchObject({
        error: { code: "consumer_selector_forbidden" },
      });
    } finally {
      await handle.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("accepts each emitted consumer activity text cursor and advances through long text", async () => {
    const home = await mkdtemp(join(tmpdir(), "calyx-server-consumer-activity-text-cursor-"));
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    const sessionId = "019dcafe-5555-7222-8333-abcabcabcabc";
    const activityId = `interactive:codex:${sessionId}`;
    const sessionPath = join(codexDir, `rollout-2026-03-10T12-00-00-${sessionId}.jsonl`);
    const longText = `${"a".repeat(4_000)}${"b".repeat(1_250)}`;
    await mkdir(codexDir, { recursive: true });
    await writeFile(sessionPath, [
      JSON.stringify({ type: "session_meta", payload: { id: sessionId } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: longText }],
        },
      }),
    ].join("\n"), "utf8");
    const service = new RunService({ runsRoot, interactiveHomeDir: home }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    const auth = { authorization: "Bearer secret-token" };

    try {
      const messagesResponse = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/messages?limit=1`,
        { headers: auth },
      );
      expect(messagesResponse.status).toBe(200);
      const messagesBody = await messagesResponse.json() as { messages: Array<{ id: string }> };
      const messageId = messagesBody.messages[0]?.id;
      expect(messageId).toBeTruthy();

      const firstResponse = await fetch(
        `${handle.url}/v1/activity-text/${encodeURIComponent(messageId!)}`,
        { headers: auth },
      );
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json() as {
        text: string;
        text_cursor: { total_chars: number; returned: Array<[number, number]>; next?: number };
      };
      expect(first).toMatchObject({
        text_cursor: {
          total_chars: longText.length,
          returned: [[0, 4_000]],
          next: 4_000,
        },
      });
      expect(first.text).toBe(longText.slice(0, 4_000));

      const secondResponse = await fetch(
        `${handle.url}/v1/activity-text/${encodeURIComponent(messageId!)}?from=${first.text_cursor.next}`,
        { headers: auth },
      );
      expect(secondResponse.status).toBe(200);
      const second = await secondResponse.json() as {
        text: string;
        text_cursor: { total_chars: number; returned: Array<[number, number]>; next?: number };
      };
      expect(second).toMatchObject({
        text_cursor: {
          total_chars: longText.length,
          returned: [[4_000, longText.length]],
        },
      });
      expect(second.text_cursor.next).toBeUndefined();
      expect(second.text).toBe(longText.slice(4_000));
      expect(first.text + second.text).toBe(longText);
    } finally {
      await handle.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("consumer turn and attachment cursors are derived only from default-visible messages", async () => {
    const home = await mkdtemp(join(tmpdir(), "calyx-server-consumer-activity-authority-"));
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    const sessionId = "019dcafe-4444-7222-8333-abcabcabcabc";
    const activityId = `interactive:codex:${sessionId}`;
    const sessionPath = join(codexDir, `rollout-2026-03-10T12-00-00-${sessionId}.jsonl`);
    const imageData = (value: string) => `data:image/png;base64,${Buffer.from(value).toString("base64")}`;
    const responseMessage = (
      role: "user" | "assistant",
      text: string,
      image?: string,
    ) => JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role,
        content: [
          { type: role === "user" ? "input_text" : "output_text", text },
          ...(image ? [{ type: "input_image", image_url: imageData(image) }] : []),
        ],
      },
    });
    await mkdir(codexDir, { recursive: true });
    await writeFile(sessionPath, [
      JSON.stringify({
        type: "session_meta",
        payload: { id: sessionId, hidden_image: imageData("hidden-session-image") },
      }),
      responseMessage("user", "# AGENTS.md instructions for /private\n<INSTRUCTIONS>hidden</INSTRUCTIONS>", "hidden-harness-image"),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          arguments: JSON.stringify({ hidden_image: imageData("hidden-tool-image") }),
        },
      }),
      responseMessage("user", "Visible Silver Dragonfly acquisition prompt", "visible-image"),
      responseMessage("assistant", "Visible Silver Dragonfly acquisition response"),
    ].join("\n"), "utf8");
    const service = new RunService({ runsRoot, interactiveHomeDir: home }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    const auth = { authorization: "Bearer secret-token" };

    try {
      const firstTurns = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/turns?limit=1`,
        { headers: auth },
      );
      expect(firstTurns.status).toBe(200);
      const firstTurnBody = await firstTurns.json() as {
        total_turns: number;
        matched_turns: number;
        truncated: boolean;
        next_cursor?: string;
        turns: Array<{
          index: number;
          role: string;
          summary: string;
          activity_id?: string;
          messages: Array<{
            role: string;
            text?: string;
            summary: string;
            activity_id?: string;
            turn_id?: string;
          }>;
        }>;
      };
      expect(firstTurnBody).toMatchObject({
        total_turns: 2,
        matched_turns: 2,
        truncated: true,
      });
      expect(firstTurnBody).not.toHaveProperty("returned_turns");
      expect(firstTurnBody.next_cursor).toBeTruthy();
      expect(firstTurnBody.turns[0]).toMatchObject({
        index: 0,
        role: "human",
        summary: "Human turn is complete.",
      });
      expect(firstTurnBody.turns[0]?.messages).toHaveLength(1);
      expect(firstTurnBody.turns[0]?.messages[0]).toMatchObject({
        role: "human",
        summary: "Human message.",
      });
      expect(firstTurnBody.turns[0]).not.toHaveProperty("activity_id");
      expect(firstTurnBody.turns[0]?.messages[0]).not.toHaveProperty("activity_id");
      expect(firstTurnBody.turns[0]?.messages[0]).not.toHaveProperty("turn_id");
      expect(firstTurnBody.turns[0]?.messages[0]?.text)
        .toContain("Visible Silver Dragonfly acquisition prompt");

      const secondTurns = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/turns?limit=1&cursor=${encodeURIComponent(firstTurnBody.next_cursor!)}`,
        { headers: auth },
      );
      expect(secondTurns.status).toBe(200);
      const secondTurnBody = await secondTurns.json() as {
        truncated: boolean;
        next_cursor?: string;
        turns: Array<{ index: number; role: string; summary: string }>;
      };
      expect(secondTurnBody.turns).toEqual([expect.objectContaining({
        index: 1,
        role: "assistant",
        summary: "Assistant turn is complete.",
      })]);
      expect(secondTurnBody.truncated).toBe(false);
      expect(secondTurnBody.next_cursor).toBeUndefined();

      const firstMessages = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/messages?limit=1`,
        { headers: auth },
      );
      expect(firstMessages.status).toBe(200);
      const firstMessageBody = await firstMessages.json() as {
        total_messages: number;
        matched_messages: number;
        truncated: boolean;
        next_cursor?: string;
        messages: Array<{ id: string; role: string; text?: string }>;
      };
      expect(firstMessageBody).toMatchObject({
        total_messages: 2,
        matched_messages: 2,
        truncated: true,
        next_cursor: expect.any(String),
        messages: [expect.objectContaining({ role: "human" })],
      });
      expect(firstMessageBody).not.toHaveProperty("returned_messages");
      expect(JSON.stringify(firstMessageBody)).not.toMatch(/hidden-(?:session|harness|tool)-image/i);

      const secondMessages = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/messages?limit=1&cursor=${encodeURIComponent(firstMessageBody.next_cursor!)}`,
        { headers: auth },
      );
      expect(secondMessages.status).toBe(200);
      const secondMessageBody = await secondMessages.json() as {
        total_messages: number;
        matched_messages: number;
        truncated: boolean;
        next_cursor?: string;
        messages: Array<{ id: string; role: string }>;
      };
      expect(secondMessageBody).toMatchObject({
        total_messages: 2,
        matched_messages: 2,
        truncated: false,
        messages: [expect.objectContaining({ role: "assistant" })],
      });
      expect(secondMessageBody).not.toHaveProperty("returned_messages");
      expect(secondMessageBody.next_cursor).toBeUndefined();
      expect(secondMessageBody.messages[0]?.id).not.toBe(firstMessageBody.messages[0]?.id);

      const newestVisibleMessages = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/messages?order=newest_first&limit=2`,
        { headers: auth },
      );
      expect(newestVisibleMessages.status).toBe(200);
      const newestVisibleBody = await newestVisibleMessages.json() as {
        total_messages: number;
        matched_messages: number;
        messages: Array<{ role: string; text?: string }>;
      };
      expect(newestVisibleBody).toMatchObject({ total_messages: 2, matched_messages: 2 });
      expect(newestVisibleBody.messages.map((message) => message.role)).toEqual(["assistant", "human"]);
      expect(JSON.stringify(newestVisibleBody)).not.toMatch(/hidden-(?:session|harness|tool)-image/i);

      for (const [label, sourceLine, privateText] of [
        ["hidden harness", 2, "AGENTS.md instructions"],
        ["detail tool call", 3, "hidden-tool-image"],
      ] as const) {
        const hiddenText = await fetch(
          `${handle.url}/v1/activity-text/${encodeURIComponent(`${activityId}:msg:${sourceLine}`)}`,
          { headers: auth },
        );
        expect(hiddenText.status, label).toBe(404);
        const hiddenBody = await hiddenText.json();
        expect(hiddenBody, label).toMatchObject({ error: { code: "activity_message_not_found" } });
        expect(JSON.stringify(hiddenBody), label).not.toContain(privateText);
      }

      const consumerAttachments = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/attachments?limit=1`,
        { headers: auth },
      );
      expect(consumerAttachments.status).toBe(200);
      const consumerAttachmentBody = await consumerAttachments.json() as {
        attachments: Array<{ message_id: string }>;
        truncated: boolean;
        next_cursor?: string;
      };
      expect(consumerAttachmentBody.attachments).toHaveLength(1);
      expect(consumerAttachmentBody.attachments[0]?.message_id)
        .toBe(`${activityId}:msg:4`);
      expect(consumerAttachmentBody.truncated).toBe(false);
      expect(consumerAttachmentBody.next_cursor).toBeUndefined();

      const adminAttachments = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/attachments`,
        { headers: auth },
      );
      expect(adminAttachments.status).toBe(200);
      const adminAttachmentBody = await adminAttachments.json() as { attachments: unknown[] };
      expect(adminAttachmentBody.attachments.length).toBeGreaterThan(consumerAttachmentBody.attachments.length);

      const summaryOnlyMessages = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/messages?summary_only=1&limit=10`,
        { headers: auth },
      );
      expect(summaryOnlyMessages.status).toBe(200);
      const summaryOnlyBody = await summaryOnlyMessages.json() as {
        total_messages: number;
        matched_messages: number;
        messages: Array<{ text?: string; summary: string }>;
      };
      expect(summaryOnlyBody).toMatchObject({ total_messages: 2, matched_messages: 2 });
      expect(summaryOnlyBody.messages.map((message) => message.summary))
        .toEqual(["Human message.", "Assistant message."]);
      expect(summaryOnlyBody.messages.every((message) => message.text === undefined)).toBe(true);
      expect(JSON.stringify(summaryOnlyBody)).not.toMatch(/silver dragonfly|acquisition|hidden-(?:session|harness|tool)-image/i);
    } finally {
      await handle.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("consumer turns disclose nested truncation and recover omitted rows through the activity.messages operation", async () => {
    const home = await mkdtemp(join(tmpdir(), "calyx-server-consumer-turn-message-bounds-"));
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    const sessionId = "019dcafe-6666-7222-8333-abcabcabcabc";
    const activityId = `interactive:codex:${sessionId}`;
    const sessionPath = join(codexDir, `rollout-2026-03-10T12-00-00-${sessionId}.jsonl`);
    const responseMessage = (role: "user" | "assistant", text: string) => JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role,
        content: [{ type: role === "user" ? "input_text" : "output_text", text }],
      },
    });
    await mkdir(codexDir, { recursive: true });
    await writeFile(sessionPath, [
      JSON.stringify({ type: "session_meta", payload: { id: sessionId } }),
      responseMessage("user", "Open one human turn."),
      ...Array.from({ length: 101 }, (_, index) =>
        responseMessage("assistant", `Visible assistant message ${index}`)),
    ].join("\n"), "utf8");
    const stale = new Date("2026-03-10T13:00:00.000Z");
    await utimes(sessionPath, stale, stale);

    const service = new RunService({ runsRoot, interactiveHomeDir: home }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    const auth = { authorization: "Bearer secret-token" };

    try {
      const turnsResponse = await fetch(
        `${handle.url}/v1/activity/${encodeURIComponent(activityId)}/turns?limit=20`,
        { headers: auth },
      );
      expect(turnsResponse.status).toBe(200);
      const turnsBody = await turnsResponse.json() as {
        truncated: boolean;
        next_cursor?: string;
        turns: Array<{
          turn_id: string;
          role: string;
          messages_truncated: boolean;
          omitted_message_count?: number;
          messages_recovery?: { operation_id: "activity.messages" };
          activity_id?: string;
          messages: Array<{ id: string; activity_id?: string; turn_id?: string }>;
        }>;
      };
      expect(turnsBody.truncated).toBe(false);
      expect(turnsBody.next_cursor).toBeUndefined();
      const assistantTurn = turnsBody.turns.find((turn) => turn.role === "assistant");
      expect(assistantTurn).toMatchObject({
        messages_truncated: true,
        omitted_message_count: 1,
        messages_recovery: { operation_id: "activity.messages" },
      });
      expect(assistantTurn?.messages).toHaveLength(100);
      expect(assistantTurn).not.toHaveProperty("activity_id");
      expect(assistantTurn?.messages.every((message) => (
        message.activity_id === undefined && message.turn_id === undefined
      ))).toBe(true);

      const messagesRoute = `/v1/activity/${encodeURIComponent(activityId)}/messages`;

      const firstMessagesResponse = await fetch(
        `${handle.url}${messagesRoute}?limit=100`,
        { headers: auth },
      );
      expect(firstMessagesResponse.status).toBe(200);
      const firstMessages = await firstMessagesResponse.json() as {
        truncated: boolean;
        next_cursor?: string;
        messages: Array<{ id: string; turn_id?: string }>;
      };
      expect(firstMessages.truncated).toBe(true);
      expect(firstMessages.next_cursor).toBeTruthy();

      const secondMessagesResponse = await fetch(
        `${handle.url}${messagesRoute}?limit=100&cursor=${encodeURIComponent(firstMessages.next_cursor!)}`,
        { headers: auth },
      );
      expect(secondMessagesResponse.status).toBe(200);
      const secondMessages = await secondMessagesResponse.json() as {
        truncated: boolean;
        next_cursor?: string;
        messages: Array<{ id: string; turn_id?: string }>;
      };
      expect(secondMessages.truncated).toBe(false);
      expect(secondMessages.next_cursor).toBeUndefined();

      const recoveredTurnMessages = [...firstMessages.messages, ...secondMessages.messages]
        .filter((message) => message.turn_id === assistantTurn!.turn_id);
      expect(recoveredTurnMessages).toHaveLength(101);
      const nestedIds = new Set(assistantTurn!.messages.map((message) => message.id));
      expect(recoveredTurnMessages.filter((message) => !nestedIds.has(message.id))).toHaveLength(1);
    } finally {
      await handle.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("serves /v1/activity/.../turns and /v1/activity/.../events?within_turn=1", async () => {
    const home = await mkdtemp(join(tmpdir(), "calyx-server-activity-turns-"));
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    const activityId = "interactive:codex:019dbeef-2222-7222-8333-abcabcabcabc";
    const sessionId = "019dbeef-2222-7222-8333-abcabcabcabc";
    await mkdir(codexDir, { recursive: true });
    const sessionPath = join(codexDir, "rollout-2026-03-10T12-00-00-019dbeef-2222-7222-8333-abcabcabcabc.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ timestamp: "2026-03-10T12:00:00.000Z", type: "session_meta", payload: { id: sessionId } }),
        JSON.stringify({
          timestamp: "2026-03-10T12:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "kick the tires" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-10T12:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "running checks" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-10T12:00:03.000Z",
          type: "response_item",
          payload: { type: "function_call", name: "shell", arguments: "{}" },
        }),
        JSON.stringify({
          timestamp: "2026-03-10T12:00:04.000Z",
          type: "response_item",
          payload: { type: "function_call_output", call_id: "call-1", output: "ok" },
        }),
      ].join("\n"),
      "utf8",
    );
    // Backdate the session file mtime so source_state is `complete`.
    const stale = new Date("2026-03-10T13:00:00.000Z");
    await utimes(sessionPath, stale, stale);

    const service = new RunService({ runsRoot, interactiveHomeDir: home }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      const turns = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/turns?role=assistant&last=1&with_tools=1`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(turns.status).toBe(200);
      const turnsBody = await turns.json() as {
        schema_version: string;
        turns: Array<{ role: string; state: string; turn_id: string; tool_call_count: number; tool_result_count: number; messages: Array<{ role: string }> }>;
      };
      expect(turnsBody.schema_version).toBe("activity.turns/v1");
      expect(turnsBody.turns).toHaveLength(1);
      expect(turnsBody.turns[0]?.role).toBe("assistant");
      expect(turnsBody.turns[0]?.state).toBe("complete");
      expect(turnsBody.turns[0]?.tool_call_count).toBeGreaterThanOrEqual(1);
      expect(turnsBody.turns[0]?.tool_result_count).toBeGreaterThanOrEqual(1);
      const messageRoles = turnsBody.turns[0]?.messages.map((message) => message.role) ?? [];
      expect(messageRoles).toContain("tool_call");
      expect(messageRoles).toContain("tool_result");

      const turnId = turnsBody.turns[0]?.turn_id;
      expect(turnId).toMatch(new RegExp(`^${activityId}:turn:\\d+$`));

      const messages = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/messages?role=assistant&last=1`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(messages.status).toBe(200);
      const messagesBody = await messages.json() as { messages: Array<{ id: string; turn_id?: string }> };
      const assistantMessage = messagesBody.messages[0]!;
      expect(assistantMessage.turn_id).toBe(turnId);

      const within = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/events?around_id=${encodeURIComponent(assistantMessage.id)}&within_turn=1`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      const withinBody = await within.json() as { events: Array<{ line: number; text?: string }> };
      // Within-turn should include all assistant + tool events for the same turn:
      // line 3 (assistant), 4 (tool_call), 5 (tool_result).
      const lines = withinBody.events.map((event) => event.line).sort((a, b) => a - b);
      expect(lines).toEqual([3, 4, 5]);

      const invalidWithin = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/events?within_turn=1`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(invalidWithin.status).toBe(400);
      expect(await invalidWithin.json()).toMatchObject({
        error: { schema_version: "calyx.error/v1", code: "invalid_activity_selector", message: expect.stringContaining("--within-turn requires --around-id") },
      });

      const invalidTurnsRole = await fetch(
        `${handle.url}/v1/admin/activity/${encodeURIComponent(activityId)}/turns?role=harness`,
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(invalidTurnsRole.status).toBe(400);
      expect(await invalidTurnsRole.json()).toMatchObject({
        error: { schema_version: "calyx.error/v1", code: "invalid_activity_selector", message: expect.stringContaining("Invalid role") },
      });
    } finally {
      await handle.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("replays /events/stream from a cursor and honors run_id, event_type, and Last-Event-ID filters", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      const firstIntent = service.createIntent({
        run_id: "run-stream-a",
        host: "local",
        prompt: "First stream run",
        require_execplan: false,
      });
      const secondIntent = service.createIntent({
        run_id: "run-stream-b",
        host: "local",
        prompt: "Second stream run",
        require_execplan: false,
      });
      await service.launch(firstIntent, { detached: false });
      await service.launch(secondIntent, { detached: false });

      const indexedRunA = await collectIndexedEvents(service, firstIntent.run_id);
      const indexedRunB = await collectIndexedEvents(service, secondIntent.run_id);
      const firstCursor = indexedRunA[0]?.cursor;
      expect(firstCursor).toBeTypeOf("string");

      await service.store.appendEvent({
        schema_version: "1.0",
        event_id: "progress-run-stream-b",
        cursor: "2026-03-11T12:00:01.000Z-run-stream-b-000001",
        emitted_at: "2026-03-11T12:00:01.000Z",
        event_type: "run.progress",
        emitted_by: "launch",
        run: {
          run_id: secondIntent.run_id,
          state: "succeeded",
          kernel: "agent_runner",
          backend: "claude",
          host: "blade",
          created_at: "2026-03-11T12:00:00.000Z",
          recovery_mode: "normal",
        },
        origin: {
          launcher_kind: "cli",
        },
        pointers: {
          run_dir: service.store.paths(secondIntent.run_id).runDir,
          run_record_path: service.store.paths(secondIntent.run_id).runRecordPath,
          events_path: service.store.paths(secondIntent.run_id).eventsPath,
        },
        summary: {
          one_line: "run-stream-b progress update",
        },
      });

      const replay = await fetch(`${handle.url}/v1/admin/events/stream?after=${encodeURIComponent(firstCursor!)}&event_type=run.terminal`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(replay.status).toBe(200);
      const replayEvent = await readNextStreamEvent(replay);
      expect(replayEvent.run!.run_id).toBe(secondIntent.run_id);
      expect(replayEvent.event_type).toBe("run.terminal");

      const runFiltered = await fetch(`${handle.url}/v1/admin/events/stream?run_id=${encodeURIComponent(secondIntent.run_id)}`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(runFiltered.status).toBe(200);
      const runFilteredEvent = await readNextStreamEvent(runFiltered);
      expect(runFilteredEvent.run!.run_id).toBe(secondIntent.run_id);

      const typeFiltered = await fetch(`${handle.url}/v1/admin/events/stream?event_type=run.progress`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(typeFiltered.status).toBe(200);
      const typeFilteredEvent = await readNextStreamEvent(typeFiltered);
      expect(typeFilteredEvent.event_type).toBe("run.progress");
      expect(typeFilteredEvent.run!.run_id).toBe(secondIntent.run_id);

      const replayFromHeader = await fetch(`${handle.url}/v1/admin/events/stream`, {
        headers: {
          authorization: "Bearer secret-token",
          "Last-Event-ID": firstCursor!,
        },
      });
      expect(replayFromHeader.status).toBe(200);
      const replayHeaderEvent = await readNextStreamEvent(replayFromHeader);
      expect(replayHeaderEvent.run!.run_id).toBe(secondIntent.run_id);
      expect(replayHeaderEvent.cursor).toBe(indexedRunB[0]?.cursor);
    } finally {
      await handle.close();
    }
  });

  test("rejects malformed, unknown, and future replay cursors before opening SSE", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const committed = await service.store.appendStreamEvent(
      makeTestStreamEvent("2026-03-11T12:00:00.000Z-run-cursor-proof-000001"),
    );
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    const auth = { authorization: "Bearer secret-token" };
    const unknownLegacy = "2026-03-11T12:00:00.000Z-unknown-cursor";
    const future = "z1-99999999999999999999";

    try {
      for (const cursor of ["zz", unknownLegacy, future]) {
        const query = await fetch(
          `${handle.url}/v1/events/observe?after=${encodeURIComponent(cursor)}`,
          { headers: auth },
        );
        expect(query.status, `query cursor ${cursor}`).toBe(400);
        expect(await query.json()).toMatchObject({
          error: { code: "invalid_event_cursor" },
        });

        const header = await fetch(`${handle.url}/v1/events/observe`, {
          headers: { ...auth, "Last-Event-ID": cursor },
        });
        expect(header.status, `header cursor ${cursor}`).toBe(400);
        expect(await header.json()).toMatchObject({
          error: { code: "invalid_event_cursor" },
        });
      }

      for (const cursor of ["", "x".repeat(513)]) {
        const header = await fetch(`${handle.url}/v1/events/observe`, {
          headers: { ...auth, "Last-Event-ID": cursor },
        });
        expect(header.status, `header cursor length ${cursor.length}`).toBe(400);
        expect(await header.json()).toMatchObject({
          error: { code: "invalid_event_cursor" },
        });
      }

      const repeatedHeader = await rawHttpGet(`${handle.url}/v1/events/observe`, [
        "Authorization", "Bearer secret-token",
        "Last-Event-ID", committed.cursor,
        "Last-Event-ID", future,
      ]);
      expect(repeatedHeader.status).toBe(400);
      if (repeatedHeader.body !== undefined) {
        expect(repeatedHeader.body).toMatchObject({
          error: { code: "invalid_event_cursor" },
        });
      }

      const tail = await fetch(
        `${handle.url}/v1/events/observe?after=${encodeURIComponent(committed.cursor)}`,
        { headers: auth },
      );
      expect(tail.status).toBe(200);
      await tail.body?.cancel();

      const tailHeader = await fetch(`${handle.url}/v1/events/observe`, {
        headers: { ...auth, "Last-Event-ID": committed.cursor },
      });
      expect(tailHeader.status).toBe(200);
      await tailHeader.body?.cancel();
    } finally {
      await handle.close();
    }
  });

  test("returns declared invalid_request errors for malformed admin event queries", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    const auth = { authorization: "Bearer secret-token" };

    try {
      for (const query of [
        "event_type=not.a.real.event",
        "event_type=stream.projection_gap",
        "after=first&after=second",
        `after=${"x".repeat(513)}`,
      ]) {
        const response = await fetch(`${handle.url}/v1/admin/events/stream?${query}`, { headers: auth });
        expect(response.status, query).toBe(400);
        expect(await response.json(), query).toMatchObject({
          error: { code: "invalid_request" },
        });
      }
    } finally {
      await handle.close();
    }
  });

  test("admin replay publishes a bounded gap for a historical oversized row and resumes after it", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    await service.prepareGlobalEventAuthority();
    const poisonAuthorityRow = await service.store.appendStreamEvent(
      makeTestStreamEvent("historical-admin-poison"),
    );
    const poison = {
      ...poisonAuthorityRow,
      summary: { one_line: `private-${"x".repeat(CALYX_HTTP_SSE_MAX_FRAME_BYTES)}` },
    } as CalyxStreamEvent;
    const valid = await service.store.appendStreamEvent({
      ...makeTestStreamEvent("admin-event-after-gap"),
      summary: { one_line: "reachable after explicit gap" },
    } as CalyxStreamEvent);
    mockReadEventsSince(service, [[poison, valid], [valid], []]);
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      const firstResponse = await fetch(`${handle.url}/v1/admin/events/stream?event_type=run.terminal`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(firstResponse.status).toBe(200);
      const gap = await readNextStreamEvent(firstResponse);
      expect(gap).toEqual({
        schema_version: "calyx.stream-projection-gap/v1",
        cursor: poison.cursor,
        event_type: "stream.projection_gap",
        gap: {
          reason: "source_event_exceeds_frame_limit",
          source_event_type: "run.terminal",
        },
      });
      expect(Buffer.byteLength(JSON.stringify(gap), "utf8")).toBeLessThan(CALYX_HTTP_SSE_MAX_FRAME_BYTES);
      expect(JSON.stringify(gap)).not.toContain("private-");
      expect(gap).not.toHaveProperty("event_id");
      expect(gap).not.toHaveProperty("emitted_at");

      const replay = await fetch(`${handle.url}/v1/admin/events/stream`, {
        headers: {
          authorization: "Bearer secret-token",
          "Last-Event-ID": poison.cursor,
        },
      });
      expect(replay.status).toBe(200);
      const next = await readNextStreamEvent(replay);
      expect(next).toMatchObject({
        cursor: valid.cursor,
        event_type: "run.terminal",
        summary: { one_line: "reachable after explicit gap" },
      });
    } finally {
      await handle.close();
    }
  });

  test("consumer replay sanitizes an oversized historical event and reconnects after its cursor", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const poisonCursor = "2026-03-11T12:00:00.000Z-run-consumer-poison-000001";
    const nextCursor = "2026-03-11T12:00:01.000Z-run-consumer-poison-000002";
    const event = (cursor: string, oversized: boolean): CalyxStreamEvent => ({
      schema_version: "1.0",
      event_id: `event-${cursor}`,
      cursor,
      emitted_at: cursor.slice(0, 24),
      event_type: "run.terminal",
      emitted_by: "launch",
      run: {
        run_id: "run-consumer-poison",
        state: "succeeded",
        kernel: "agent_runner",
        backend: "codex",
        host: oversized ? "h".repeat(256) : "blade",
        ...(oversized ? { issue: "P".repeat(129) } : {}),
        created_at: "2026-03-11T12:00:00.000Z",
        recovery_mode: "normal",
      },
      origin: { launcher_kind: "cli" },
      pointers: {
        run_dir: service.store.paths("run-consumer-poison").runDir,
        run_record_path: service.store.paths("run-consumer-poison").runRecordPath,
        events_path: service.store.paths("run-consumer-poison").eventsPath,
      },
      summary: { one_line: "consumer replay projection" },
      ...(oversized ? { enrichment: { branch: "b".repeat(257) } } : {}),
    });
    const poison = await service.store.appendStreamEvent(event(poisonCursor, true));
    const nextEvent = await service.store.appendStreamEvent(event(nextCursor, false));
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      const firstResponse = await fetch(`${handle.url}/v1/events/observe`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(firstResponse.status).toBe(200);
      const first = await readNextStreamEvent(firstResponse);
      expect(first.cursor).toBe(poison.cursor);
      expect(first.run).toMatchObject({ run_id: "run-consumer-poison", host: "unknown" });
      expect(first.run).not.toHaveProperty("issue");
      expect(first.run).not.toHaveProperty("branch");

      const reconnect = await fetch(`${handle.url}/v1/events/observe`, {
        headers: {
          authorization: "Bearer secret-token",
          "Last-Event-ID": poison.cursor,
        },
      });
      expect(reconnect.status).toBe(200);
      const next = await readNextStreamEvent(reconnect);
      expect(next.cursor).toBe(nextEvent.cursor);
      expect(next.run).toMatchObject({ run_id: "run-consumer-poison", host: "blade" });
    } finally {
      await handle.close();
    }
  });

  test("consumer replay publishes a bounded gap for a poison row and resumes from its cursor", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const poisonCursor = "2026-03-11T12:00:00.000Z-run-consumer-gap-000001";
    const nextCursor = "2026-03-11T12:00:01.000Z-run-consumer-gap-000002";
    const event = (cursor: string, poison: boolean): CalyxStreamEvent => ({
      schema_version: "1.0",
      event_id: `event-${cursor}`,
      cursor,
      emitted_at: cursor.slice(0, 24),
      event_type: "run.terminal",
      emitted_by: "launch",
      run: {
        run_id: poison ? "run-consumer-gap" : "run-consumer-after-gap",
        state: "succeeded",
        kernel: "agent_runner",
        backend: poison ? "b".repeat(65) as never : "codex",
        host: "blade",
        created_at: "2026-03-11T12:00:00.000Z",
        recovery_mode: "normal",
      },
      origin: { launcher_kind: "cli" },
      pointers: {
        run_dir: "/private/run-dir",
        run_record_path: "/private/run-record.json",
        events_path: "/private/events.jsonl",
      },
      summary: { one_line: "private source summary" },
    });
    const poison = await service.store.appendStreamEvent(event(poisonCursor, true));
    const nextEvent = await service.store.appendStreamEvent(event(nextCursor, false));
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      const firstResponse = await fetch(`${handle.url}/v1/events/observe`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(firstResponse.status).toBe(200);
      const gap = await readNextStreamEvent(firstResponse);
      expect(gap).toEqual({
        schema_version: "calyx.run-observation-gap/v1",
        cursor: poison.cursor,
        event_type: "run.projection_gap",
        gap: {
          reason: "source_event_unrepresentable",
          source_event_type: "run.terminal",
        },
      });
      expect(JSON.stringify(gap)).not.toContain("private");
      expect(gap).not.toHaveProperty("run");

      const reconnect = await fetch(`${handle.url}/v1/events/observe`, {
        headers: {
          authorization: "Bearer secret-token",
          "Last-Event-ID": poison.cursor,
        },
      });
      expect(reconnect.status).toBe(200);
      const next = await readNextStreamEvent(reconnect);
      expect(next.cursor).toBe(nextEvent.cursor);
      expect(next.event_type).toBe("run.terminal");
      expect(next.run?.run_id).toBe("run-consumer-after-gap");
    } finally {
      await handle.close();
    }
  });

  test("streams newly indexed events that arrive after the SSE connection opens", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      const runId = "run-stream-live";
      const liveResponse = await fetch(`${handle.url}/v1/admin/events/stream?run_id=${encodeURIComponent(runId)}`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(liveResponse.status).toBe(200);
      const nextEvent = readNextStreamEvent(liveResponse);

      await service.store.appendEvent({
        schema_version: "1.0",
        event_id: "live-run-stream-live",
        cursor: "2026-03-11T12:00:02.000Z-run-stream-live-000001",
        emitted_at: "2026-03-11T12:00:02.000Z",
        event_type: "run.terminal",
        emitted_by: "launch",
        run: {
          run_id: runId,
          state: "succeeded",
          kernel: "agent_runner",
          backend: "claude",
          host: "blade",
          created_at: "2026-03-11T12:00:00.000Z",
          completed_at: "2026-03-11T12:00:02.000Z",
          duration_ms: 2000,
          recovery_mode: "normal",
        },
        origin: {
          launcher_kind: "cli",
        },
        pointers: {
          run_dir: service.store.paths(runId).runDir,
          run_record_path: service.store.paths(runId).runRecordPath,
          events_path: service.store.paths(runId).eventsPath,
        },
        summary: {
          one_line: "run-stream-live succeeded",
        },
      });

      const event = await nextEvent;
      expect(event.run!.run_id).toBe(runId);
      expect(event.event_type).toBe("run.terminal");
      expect(event.summary!.one_line).toContain("succeeded");
    } finally {
      await handle.close();
    }
  });

  test("uses process-local notifications only to wake an ordered shared-authority drain", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    await service.prepareGlobalEventAuthority();
    const remoteLower = makeTestStreamEvent("z1-00000000000000000006");
    const localHigher = makeTestStreamEvent("z1-00000000000000000007");
    const reads = mockReadEventsSince(service, [[], [remoteLower, localHigher]]);
    const request = new MockStreamRequest();
    const response = new MockStreamResponse();

    await handleEventsStream(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      service,
      new URL("http://localhost/events/stream"),
    );
    notifyEventSubscribers(service, localHigher);

    await vi.waitFor(() => expect(response.writes).toHaveLength(2));
    expect(response.writes[0]).toContain(`id: ${remoteLower.cursor}`);
    expect(response.writes[1]).toContain(`id: ${localHigher.cursor}`);
    expect(reads).toHaveBeenNthCalledWith(1, undefined, {});
    expect(reads).toHaveBeenNthCalledWith(2, undefined, {});
    response.emit("close");
  });

  test("streams non-lexical legacy cursors in authority order before the first allocated cursor", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    await service.prepareGlobalEventAuthority();
    const first = makeTestStreamEvent(
      "2026-07-20T19:23:21.248Z-control-mba-0d500000-0000-4000-8000-000000000000",
    );
    const descending = makeTestStreamEvent(
      "2026-07-20T19:23:21.248Z-control-mba-0bfd0000-0000-4000-8000-000000000000",
    );
    const allocated = makeTestStreamEvent("z1-00000000000000000003");
    const reads = mockReadEventsSince(service, [[first, descending, allocated]]);
    const request = new MockStreamRequest();
    const response = new MockStreamResponse();

    await handleEventsStream(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      service,
      new URL("http://localhost/events/stream"),
    );

    expect(response.writes).toHaveLength(3);
    expect(response.writes[0]).toContain(`id: ${first.cursor}`);
    expect(response.writes[1]).toContain(`id: ${descending.cursor}`);
    expect(response.writes[2]).toContain(`id: ${allocated.cursor}`);
    expect(reads).toHaveBeenCalledWith(undefined, {});
    response.emit("close");
  });

  test("a suppressed local wake cannot advance past an unseen lower remote event", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    await service.prepareGlobalEventAuthority();
    const remoteLower = makeTestStreamEvent("z1-00000000000000000008");
    const suppressedLocalHigher = makeTestStreamEvent("z1-00000000000000000009");
    mockReadEventsSince(service, [[], [remoteLower, suppressedLocalHigher]]);
    const request = new MockStreamRequest();
    const response = new MockStreamResponse();

    await handleEventsStream(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      service,
      new URL("http://localhost/events/stream"),
      {
        eventPredicate: (event) => event.event_id !== suppressedLocalHigher.event_id,
      },
    );
    notifyEventSubscribers(service, suppressedLocalHigher);

    await vi.waitFor(() => expect(response.writes).toHaveLength(1));
    expect(response.writes[0]).toContain(`id: ${remoteLower.cursor}`);
    expect(response.writes.join("")).not.toContain(suppressedLocalHigher.cursor);
    response.emit("close");
  });

  test("streams control events from the shared index with event_type filtering", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      await service.store.appendStreamEvent({
        schema_version: "1.0",
        event_id: "control-upgrade-completed",
        cursor: "2026-03-11T12:00:03.000Z-control-blade-1",
        emitted_at: "2026-03-11T12:00:03.000Z",
        event_type: "daemon.upgrade.completed",
        emitted_by: "self-upgrade",
        control: {
          host: "blade",
          daemon_id: "run-serve",
          build: {
            git_head: "after-sha",
            built_at: "2026-03-11T12:00:03.000Z",
          },
        },
      });

      const response = await fetch(`${handle.url}/v1/admin/events/stream?event_type=daemon.upgrade.completed`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(response.status).toBe(200);

      const event = await readNextStreamEvent(response);
      expect(event.event_type).toBe("daemon.upgrade.completed");
      expect(event.control?.host).toBe("blade");
      expect(event.control?.daemon_id).toBe("run-serve");
    } finally {
      await handle.close();
    }
  });

  test("streams daemon.upgrade.progress phase events (event_type filter is not a stale whitelist)", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      await service.store.appendStreamEvent({
        schema_version: "1.0",
        event_id: "control-upgrade-progress",
        cursor: "2026-03-11T12:00:04.000Z-control-blade-2",
        emitted_at: "2026-03-11T12:00:04.000Z",
        event_type: "daemon.upgrade.progress",
        emitted_by: "self-upgrade",
        control: {
          host: "blade",
          operation_id: "2026-03-11T12-00-00-000Z-blade",
          phase: "build",
          elapsed_ms: 1234,
        },
      });

      // A new control event type must pass the SSE `event_type` validator and
      // be served — not silently dropped by a hardcoded allowlist.
      const response = await fetch(`${handle.url}/v1/admin/events/stream?event_type=daemon.upgrade.progress`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(response.status).toBe(200);

      const event = await readNextStreamEvent(response);
      expect(event.event_type).toBe("daemon.upgrade.progress");
      expect(event.control?.host).toBe("blade");
      expect(event.control?.operation_id).toBe("2026-03-11T12-00-00-000Z-blade");
      expect(event.control?.phase).toBe("build");
    } finally {
      await handle.close();
    }
  });

  test("cleans up SSE subscribers on request or response errors after replay completes", async () => {
    vi.useFakeTimers();
    const service = new RunService({ runsRoot }, buildDeps());
    await service.prepareGlobalEventAuthority();
    mockReadEventsSince(service, [[], []]);
    const request = new MockStreamRequest();
    const response = new MockStreamResponse();
    const baselineSubscribers = getEventSubscriberCount(service);

    await handleEventsStream(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      service,
      new URL("http://localhost/events/stream"),
    );

    expect(request.listenerCount("error")).toBeGreaterThan(0);
    expect(response.listenerCount("error")).toBeGreaterThan(0);
    expect(getEventSubscriberCount(service)).toBe(baselineSubscribers + 1);

    response.emit("error", new Error("socket write failure"));

    expect(getEventSubscriberCount(service)).toBe(baselineSubscribers);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("pauses authority replay at socket backpressure and resumes only after drain", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    await service.prepareGlobalEventAuthority();
    const first = makeTestStreamEvent("2026-03-11T12:00:00.000Z-run-stream-backpressure-000001");
    const second = makeTestStreamEvent("2026-03-11T12:00:01.000Z-run-stream-backpressure-000002");
    mockReadEventsSince(service, [[first, second]]);
    const request = new MockStreamRequest();
    const response = new MockStreamResponse();
    response.writeResults = [false, true];

    const opening = handleEventsStream(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      service,
      new URL("http://localhost/events/stream"),
      {
        catchupIntervalMs: 10_000,
        keepaliveIntervalMs: 10_000,
        idleTimeoutMs: 10_000,
      },
    );

    await vi.waitFor(() => {
      expect(response.writes).toHaveLength(1);
    });
    expect(response.writes[0]).toContain(`id: ${first.cursor}`);
    expect(response.writes[0]).not.toContain(second.cursor);

    response.emit("drain");
    await opening;

    expect(response.writes).toHaveLength(2);
    expect(response.writes[1]).toContain(`id: ${second.cursor}`);
    response.emit("close");
  });

  test("cleans up SSE subscribers when the periodic catchup loop throws after replay", async () => {
    vi.useFakeTimers();
    const service = new RunService({ runsRoot }, buildDeps());
    await service.prepareGlobalEventAuthority();
    const readEventsSince = mockReadEventsSince(service, [[], new Error("catchup failed")]);
    const request = new MockStreamRequest();
    const response = new MockStreamResponse();
    const baselineSubscribers = getEventSubscriberCount(service);

    await handleEventsStream(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      service,
      new URL("http://localhost/events/stream"),
      {
        catchupIntervalMs: 25,
        keepaliveIntervalMs: 1_000,
        idleTimeoutMs: 5_000,
      },
    );

    expect(getEventSubscriberCount(service)).toBe(baselineSubscribers + 1);

    await vi.advanceTimersByTimeAsync(25);

    expect(readEventsSince).toHaveBeenCalledTimes(2);
    expect(getEventSubscriberCount(service)).toBe(baselineSubscribers);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("consumer projection publishes poison and next cursors as observable data-envelope events", async () => {
    vi.useFakeTimers();
    const service = new RunService({ runsRoot }, buildDeps());
    await service.prepareGlobalEventAuthority();
    const poison = makeTestStreamEvent("2026-03-11T12:00:00.000Z-run-stream-test-000001");
    const valid = makeTestStreamEvent("2026-03-11T12:00:01.000Z-run-stream-test-000002");
    mockReadEventsSince(service, [[poison, valid], []]);
    const request = new MockStreamRequest();
    const response = new MockStreamResponse();
    const baselineSubscribers = getEventSubscriberCount(service);

    await handleEventsStream(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      service,
      new URL("http://localhost/v1/events/observe"),
      {
        eventProjector: (event) => {
          if (event.event_id === poison.event_id) throw new Error("unrepresentable legacy row");
          return { cursor: event.cursor };
        },
        projectionFailureProjector: (event) => toRunObservationGapEvent(event as never),
      },
    );

    const wire = response.writes.join("");
    expect(wire).toContain(`id: ${poison.cursor}`);
    expect(wire).toContain(`id: ${valid.cursor}`);
    expect(wire).toContain('"event_type":"run.projection_gap"');
    expect(wire).not.toMatch(/^event:/mu);
    expect(response.writes).toHaveLength(2);
    expect(getEventSubscriberCount(service)).toBe(baselineSubscribers + 1);
    response.emit("close");
  });

  test("consumer projection publishes a lone poison cursor instead of rereading it invisibly", async () => {
    vi.useFakeTimers();
    const service = new RunService({ runsRoot }, buildDeps());
    await service.prepareGlobalEventAuthority();
    const poison = makeTestStreamEvent("2026-03-11T12:00:00.000Z-run-stream-lone-poison-000001");
    mockReadEventsSince(service, [[poison], []]);
    const request = new MockStreamRequest();
    const response = new MockStreamResponse();

    await handleEventsStream(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      service,
      new URL("http://localhost/v1/events/observe"),
      {
        eventProjector: () => {
          throw new Error("unrepresentable legacy row");
        },
        projectionFailureProjector: (event) => toRunObservationGapEvent(event as never),
      },
    );

    expect(response.writes).toHaveLength(1);
    expect(response.writes[0]).toContain(`id: ${poison.cursor}`);
    expect(response.writes[0]).toContain('"event_type":"run.projection_gap"');
    response.emit("close");
  });

  test("a failed gap-frame write cleans up without claiming delivery and remains replayable", async () => {
    vi.useFakeTimers();
    const service = new RunService({ runsRoot }, buildDeps());
    await service.prepareGlobalEventAuthority();
    const poison = makeTestStreamEvent("2026-03-11T12:00:00.000Z-run-stream-write-failure-000001");
    mockReadEventsSince(service, [[poison], [poison], []]);
    const baselineSubscribers = getEventSubscriberCount(service);
    const failureProjector = (event: CalyxStreamEvent) => toRunObservationGapEvent(event as never);

    const failedRequest = new MockStreamRequest();
    const failedResponse = new MockStreamResponse();
    failedResponse.failWrites = true;
    await handleEventsStream(
      failedRequest as unknown as IncomingMessage,
      failedResponse as unknown as ServerResponse,
      service,
      new URL("http://localhost/v1/events/observe"),
      {
        eventProjector: () => { throw new Error("unrepresentable legacy row"); },
        projectionFailureProjector: failureProjector,
      },
    );

    expect(failedResponse.writes).toEqual([]);
    expect(getEventSubscriberCount(service)).toBe(baselineSubscribers);

    const replayRequest = new MockStreamRequest();
    const replayResponse = new MockStreamResponse();
    await handleEventsStream(
      replayRequest as unknown as IncomingMessage,
      replayResponse as unknown as ServerResponse,
      service,
      new URL("http://localhost/v1/events/observe"),
      {
        eventProjector: () => { throw new Error("unrepresentable legacy row"); },
        projectionFailureProjector: failureProjector,
      },
    );

    expect(replayResponse.writes).toHaveLength(1);
    expect(replayResponse.writes[0]).toContain(`id: ${poison.cursor}`);
    expect(getEventSubscriberCount(service)).toBe(baselineSubscribers + 1);
    replayResponse.emit("close");
  });

  test("refuses an oversized SSE frame without advancing replay authority", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    await service.prepareGlobalEventAuthority();
    const event = makeTestStreamEvent("z1-00000000000000000031");
    const readEventsSince = mockReadEventsSince(service, [[event], []]);
    const request = new MockStreamRequest();
    const response = new MockStreamResponse();
    const baselineSubscribers = getEventSubscriberCount(service);

    await handleEventsStream(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      service,
      new URL("http://localhost/v1/events/observe"),
      { eventProjector: () => ({ payload: "x".repeat(CALYX_HTTP_SSE_MAX_FRAME_BYTES) }) },
    );

    expect(response.writes).toEqual([]);
    expect(readEventsSince).toHaveBeenCalledWith(undefined, {});
    expect(getEventSubscriberCount(service)).toBe(baselineSubscribers);
  });

  test("cleans up abandoned SSE subscribers after the idle timeout window with no writes", async () => {
    vi.useFakeTimers();
    const service = new RunService({ runsRoot }, buildDeps());
    await service.prepareGlobalEventAuthority();
    mockReadEventsSince(service, [[], []]);
    const request = new MockStreamRequest();
    const response = new MockStreamResponse();
    const baselineSubscribers = getEventSubscriberCount(service);
    const idleTimeoutMs = 50;

    await handleEventsStream(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      service,
      new URL("http://localhost/events/stream"),
      {
        catchupIntervalMs: 1_000,
        keepaliveIntervalMs: EVENT_STREAM_IDLE_TIMEOUT_MS,
        idleTimeoutMs,
      },
    );

    expect(getEventSubscriberCount(service)).toBe(baselineSubscribers + 1);

    await vi.advanceTimersByTimeAsync(idleTimeoutMs - 1);
    expect(getEventSubscriberCount(service)).toBe(baselineSubscribers + 1);

    await vi.advanceTimersByTimeAsync(1);

    expect(getEventSubscriberCount(service)).toBe(baselineSubscribers);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("cleans up SSE subscribers on the next live write attempt after the response is destroyed", async () => {
    vi.useFakeTimers();
    const service = new RunService({ runsRoot }, buildDeps());
    await service.prepareGlobalEventAuthority();
    const event = makeTestStreamEvent("2026-03-11T12:00:01.000Z-run-stream-test-000001");
    mockReadEventsSince(service, [[], [event]]);
    const request = new MockStreamRequest();
    const response = new MockStreamResponse();
    const baselineSubscribers = getEventSubscriberCount(service);

    await handleEventsStream(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      service,
      new URL("http://localhost/events/stream"),
      {
        catchupIntervalMs: 1_000,
        keepaliveIntervalMs: 1_000,
        idleTimeoutMs: 5_000,
      },
    );

    expect(getEventSubscriberCount(service)).toBe(baselineSubscribers + 1);

    response.destroy();
    notifyEventSubscribers(service, event);

    await vi.waitFor(() => {
      expect(getEventSubscriberCount(service)).toBe(baselineSubscribers);
    });
    expect(response.writes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("returns authenticated rich health with pinned build and inherited PATH", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer({
      ...createServerOptions(service, registryRoot),
      inheritedPath: "/srv/bin:/usr/bin",
      supportsFeatures: [],
    });

    try {
      const health = await fetch(`${handle.url}/v1/internal/health`, {
        headers: { authorization: "Bearer self-daemon-token" },
      });
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({
        schema_version: "daemon-health/v1",
        protocol_epoch: 1,
        daemon_kind: "run-service",
        daemon_id: "run-serve",
        advertised_host: "127.0.0.1",
        pid: process.pid,
        started_at: "2026-04-20T00:00:00.000Z",
        build: {
          git_head: BUILD_INFO.git_head,
          built_at: BUILD_INFO.built_at,
          package_version: BUILD_INFO.package_version,
        },
        env: {
          inherited_path: "/srv/bin:/usr/bin",
        },
        active_runs: 0,
        active_run_ids: [],
        workload_admission: {
          admission: "open",
          accepted_topology: { projection_sha256: TOPOLOGY_PROJECTION_SHA256 },
          gate_receipt: {
            profile: "d1-interim-topology-reachability-build-schema",
            evaluated_surfaces: ["topology", "reachability", "running", "state_schema"],
          },
        },
        maintenance_mode: false,
        supports_features: [],
      });
    } finally {
      await handle.close();
    }
  });

  test("returns exact active run ids in authenticated health", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      const intent = service.createIntent({
        run_id: "run-health-active-id",
        host: "local",
        prompt: "Health active id",
        require_execplan: false,
      });
      const record = await service.initializeRun(intent);
      await service.store.writeRunRecord(intent.run_id, {
        ...record,
        state: "running",
        updated_at: "2026-03-11T12:00:01.000Z",
      });

      const health = await fetch(`${handle.url}/v1/internal/health`, {
        headers: { authorization: "Bearer self-daemon-token" },
      });
      expect(health.status).toBe(200);
      const payload = await health.json() as { active_runs: number; active_run_ids?: string[] };
      expect(payload.active_runs).toBe(1);
      expect(payload.active_run_ids).toEqual(["run-health-active-id"]);
    } finally {
      await handle.close();
    }
  });

  test("returns authenticated daemon metrics and excludes phantom-active runs", async () => {
    const runtimeAdapterRegistry = {
      register: () => {},
      create: () => ({
        name: "mock",
        capabilities: {
          streaming: false,
          turnControl: false,
          resumeSession: false,
          forkSession: false,
          approvals: "none" as const,
        },
        spawn: async (): Promise<AdapterResult> => ({
          exit_code: 0,
          stderr: "",
          events: [],
          duration_ms: 1,
        }),
        stop: async (): Promise<void> => {},
      }),
      has: () => true,
      list: () => ["mock"],
      activeSessionCount: (backend: string) => backend === "codex" ? 3 : 0,
    };
    const service = new RunService(
      { runsRoot, runtimeAdapterRegistry },
      buildDeps({ runtimeAdapterRegistry }),
    );
    const handle = await startRunServer(createServerOptions(service, registryRoot));
    const unsubscribe = service.subscribeToEvents(() => {});
    let releaseAliveOwner: (() => void) | undefined;
    let heldAlive: Promise<void> | undefined;
    try {
      await service.launch(service.createIntent({
        host: "local",
        prompt: "Launch one",
        require_execplan: false,
      }), { detached: false });
      await service.launch(service.createIntent({
        host: "local",
        prompt: "Launch two",
        require_execplan: false,
      }), { detached: false });

      const aliveIntent = service.createIntent({
        run_id: "run-active-alive",
        host: "local",
        prompt: "Alive run",
        require_execplan: false,
      });
      const phantomIntent = service.createIntent({
        run_id: "run-active-phantom",
        host: "local",
        prompt: "Phantom run",
        require_execplan: false,
      });

      const aliveRecord = await service.initializeRun(aliveIntent);
      const phantomRecord = await service.initializeRun(phantomIntent);
      await service.store.writeRunRecord(aliveIntent.run_id, {
        ...aliveRecord,
        state: "running",
        launch: {
          ...aliveRecord.launch,
          stage: "executing",
          execution_id: "execution-active-alive",
          execution_started_at: "2026-03-11T12:00:01.000Z",
        },
        summary: "Alive detached run.",
        updated_at: "2026-03-11T12:00:01.000Z",
      });
      await service.store.writeRunRecord(phantomIntent.run_id, {
        ...phantomRecord,
        state: "running",
        launch: {
          ...phantomRecord.launch,
          stage: "executing",
          execution_id: "execution-active-phantom",
          execution_started_at: "2026-03-11T12:00:02.000Z",
        },
        summary: "Phantom detached run.",
        updated_at: "2026-03-11T12:00:02.000Z",
      });
      let signalAliveOwnerAcquired!: () => void;
      const aliveOwnerAcquired = new Promise<void>((resolve) => { signalAliveOwnerAcquired = resolve; });
      const releaseAlive = new Promise<void>((resolve) => { releaseAliveOwner = resolve; });
      heldAlive = withSqliteMutex(service.store.paths(aliveIntent.run_id).executionMutexPath, async () => {
        signalAliveOwnerAcquired();
        await releaseAlive;
      });
      await aliveOwnerAcquired;

      const metrics = await fetch(`${handle.url}/v1/internal/metrics`, {
        headers: { authorization: "Bearer self-daemon-token" },
      });
      expect(metrics.status).toBe(200);
      const payload = await metrics.json() as {
        schema_version: string;
        memory: Record<string, number>;
        event_loop: { lag_ms_p50: number; lag_ms_p99: number };
        connections: { sse_subscribers: number; codex_app_server_sessions: number };
        runs: { active: number; total_serviced_since_start: number };
      };

      expect(payload.schema_version).toBe("daemon-metrics/v1");
      expect(payload.memory.rss).toBeGreaterThan(0);
      expect(payload.memory.heap_total).toBeGreaterThan(0);
      expect(payload.memory.heap_used).toBeGreaterThan(0);
      expect(payload.memory.external).toBeGreaterThanOrEqual(0);
      expect(payload.memory.array_buffers).toBeGreaterThanOrEqual(0);
      expect(payload.event_loop.lag_ms_p50).toBeGreaterThanOrEqual(0);
      expect(payload.event_loop.lag_ms_p99).toBeGreaterThanOrEqual(0);
      expect(payload.connections).toEqual({
        sse_subscribers: 1,
        codex_app_server_sessions: 3,
      });
      expect(payload.runs).toEqual({
        active: 1,
        total_serviced_since_start: 2,
      });
    } finally {
      releaseAliveOwner?.();
      await heldAlive;
      vi.restoreAllMocks();
      unsubscribe();
      await handle.close();
    }
  });

  test("surfaces maintenance_mode changes from the descriptor at health-serve time", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const registryRoot = await mkdtemp(join(tmpdir(), "calyx-run-server-registry-"));
    const descriptorPath = join(registryRoot, "run-serve", "descriptor.json");
    const handle = await startRunServer({
      ...createServerOptions(service, registryRoot),
      registryRoot,
    });

    try {
      const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as { maintenance_mode?: boolean };
      await writeFile(
        descriptorPath,
        `${JSON.stringify({ ...descriptor, maintenance_mode: true }, null, 2)}\n`,
        "utf8",
      );

      const health = await fetch(`${handle.url}/v1/internal/health`, {
        headers: { authorization: "Bearer self-daemon-token" },
      });
      expect(health.status).toBe(200);
      const payload = await health.json() as { maintenance_mode: boolean };
      expect(payload.maintenance_mode).toBe(true);
    } finally {
      await handle.close();
      await rm(registryRoot, { recursive: true, force: true });
    }
  });

  test("defaults health features to the current daemon feature set", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      const health = await fetch(`${handle.url}/v1/internal/health`, {
        headers: { authorization: "Bearer self-daemon-token" },
      });
      expect(health.status).toBe(200);
      const payload = await health.json() as { supports_features: string[] };
      expect(payload).toMatchObject({
        supports_features: [...SUPPORTED_FEATURES],
      });
      expect(payload.supports_features).toContain(CALYX_DAEMON_FEATURES.agentRunnerActivityV1);
      expect(payload.supports_features).toContain(CALYX_DAEMON_FEATURES.runObservationV1);
      expect(payload.supports_features).toContain(CALYX_DAEMON_FEATURES.runResourceAttributionV1);
      expect(payload.supports_features).toContain(CALYX_DAEMON_FEATURES.artifactRootsV1);
      expect(payload.supports_features).toContain(CALYX_DAEMON_FEATURES.outputCaptureV1);
      expect(payload.supports_features).toContain(CALYX_DAEMON_FEATURES.runHandbackV1);
      expect(payload.supports_features).toContain(CALYX_DAEMON_FEATURES.backendModelV1);
      expect(payload.supports_features).toContain(CALYX_DAEMON_FEATURES.runReadoptOnBootV1);
    } finally {
      await handle.close();
    }
  });

  test("health reports the live state-schema position, not the one it booted with (POL-2090)", async () => {
    const stateStoreOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(runsRoot, "state-schema-health") },
    };
    await applyStateMigrations({ storeOptions: stateStoreOptions });
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot, { stateStoreOptions }));

    try {
      const converged = await (await fetch(`${handle.url}/v1/internal/health`, {
        headers: { authorization: "Bearer self-daemon-token" },
      })).json() as { state_schema?: Record<string, unknown> };
      const target = STATE_MIGRATIONS[STATE_MIGRATIONS.length - 1]!.id;
      expect(converged.state_schema).toMatchObject({
        status: "current",
        current: target,
        target,
        pending: 0,
      });

      // Another process on this host migrates past the running build. The
      // ledger is read per request, so the daemon reports being behind its own
      // store instead of the parity it converged to at boot.
      const opened = await openStateStore(stateStoreOptions);
      try {
        opened.db
          .prepare("INSERT INTO schema_migrations (id, description, applied_at) VALUES (?, ?, ?)")
          .run("9999", "applied by a newer build", "2026-07-27T00:00:00.000Z");
      } finally {
        opened.db.close();
      }

      const ahead = await (await fetch(`${handle.url}/v1/admin/health`, {
        headers: { authorization: "Bearer secret-token" },
      })).json() as { state_schema?: Record<string, unknown> };
      expect(ahead.state_schema).toMatchObject({ status: "ahead", current: "9999", target });
    } finally {
      await handle.close();
    }
  });

  test("default supported features cover default launch requirements", () => {
    expect(SUPPORTED_FEATURES).toEqual(expect.arrayContaining(requiredFeaturesForIntent({})));
  });

  test("default supported features cover handback-bound launch requirements", () => {
    expect(SUPPORTED_FEATURES).toEqual(expect.arrayContaining(
      requiredFeaturesForIntent({ handback: { key: "review-thread" } }),
    ));
  });

  test("default supported features cover backend model launch requirements", () => {
    expect(SUPPORTED_FEATURES).toEqual(expect.arrayContaining(
      requiredFeaturesForIntent({ backend_options: { model: "gpt-5" } }),
    ));
  });

  test("reads build info from stamped metadata instead of current git HEAD", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const buildInfoPath = resolveServerBuildInfoPath();
    const actualHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
    const pinnedHead = actualHead === "pinned-build-sha" ? "pinned-build-sha-2" : "pinned-build-sha";
    const originalBuildInfo = await readFile(buildInfoPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    await mkdir(dirname(buildInfoPath), { recursive: true });
    await writeFile(
      buildInfoPath,
      `${JSON.stringify({ ...BUILD_INFO, git_head: pinnedHead }, null, 2)}\n`,
      "utf8",
    );

    const handle = await startRunServer({
      credentials: [{
        client_id: "test-control-plane",
        credential_tier: "control_plane",
        verifier: hashConsumerApiBearer("secret-token"),
        verifier_env: "CALYX_CONSUMER_API_TEST_CONTROL_PLANE_VERIFIER",
        address_grants: { send_as: ["client:test-control-plane@blade"], read: ["run:*"] },
      }],
      host: "127.0.0.1",
      port: 0,
      service,
      registryRoot,
      startedAt: "2026-04-20T00:00:00.000Z",
      inheritedPath: "/mock/bin:/usr/bin",
    });

    try {
      const health = await fetch(`${handle.url}/v1/admin/health`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(health.status).toBe(200);
      const payload = await health.json() as { build: { git_head: string } };
      expect(payload.build.git_head).toBe(pinnedHead);
      expect(payload.build.git_head).not.toBe(actualHead);
    } finally {
      await handle.close();
      if (typeof originalBuildInfo === "string") {
        await writeFile(buildInfoPath, originalBuildInfo, "utf8");
      } else {
        await rm(buildInfoPath, { force: true });
      }
    }
  });

  test("writes a daemon descriptor on start and removes it on close", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const registryRoot = await mkdtemp(join(tmpdir(), "calyx-run-server-registry-"));
    const descriptorPath = join(registryRoot, "run-serve", "descriptor.json");
    const handle = await startRunServer({
      ...createServerOptions(service, registryRoot),
      advertisedHost: "127.0.0.1",
      descriptorArgv: [
        "calyx",
        "run",
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
      ],
      registryRoot,
    });

    try {
      const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as {
        daemon_id: string;
        livez_url: string;
      };
      expect(descriptor.daemon_id).toBe("run-serve");
      expect(descriptor.livez_url).toContain("/livez");
    } finally {
      await handle.close();
    }

    await expect(readFile(descriptorPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await rm(registryRoot, { recursive: true, force: true });
  });

  test("close preserves a descriptor registered by a newer daemon process", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const registryRoot = await mkdtemp(join(tmpdir(), "calyx-run-server-registry-"));
    const descriptorPath = join(registryRoot, "run-serve", "descriptor.json");
    const handle = await startRunServer({
      ...createServerOptions(service, registryRoot),
      advertisedHost: "127.0.0.1",
      registryRoot,
    });

    const originalDescriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as { pid: number };
    await writeFile(
      descriptorPath,
      `${JSON.stringify({ ...originalDescriptor, pid: originalDescriptor.pid + 1 }, null, 2)}\n`,
      "utf8",
    );

    await handle.close();

    const saved = JSON.parse(await readFile(descriptorPath, "utf8")) as { pid: number };
    expect(saved.pid).toBe(originalDescriptor.pid + 1);
    await rm(registryRoot, { recursive: true, force: true });
  });

  test("executes authenticated runtime-config backends over the server plane", async () => {
    const managedConfigsRoot = join(runsRoot, "managed-configs");
    const liveHome = join(runsRoot, "home");
    const localHost = currentHostAlias();
    await mkdir(join(managedConfigsRoot, "shared"), { recursive: true });
    await writeFile(
      join(managedConfigsRoot, "shared", "config.toml"),
      'profile = "full-auto"\nmodel = "gpt-5.4"\n',
      { encoding: "utf8", flag: "w" },
    );
    await writeFile(
      join(managedConfigsRoot, "shared", "claude.user.global.settings.template.json"),
      `${JSON.stringify(
        {
          $schema: "https://json.schemastore.org/claude-code-settings.json",
          permissions: { defaultMode: "allowEdits" },
          env: {},
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "w" },
    );
    await writeFile(
      join(managedConfigsRoot, "shared", "claude.mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            executor_carbon: {
              type: "http",
              url: "https://carbon.tailc29f0.ts.net/mcp",
            },
          },
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "w" },
    );

    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer({
      ...createServerOptions(service, registryRoot, { actualHost: localHost }),
      runtimeConfigRoots: { managedConfigsRoot, liveHome },
    });

    try {
      const unauthorized = await fetch(`${handle.url}/v1/internal/runtime-config/plan`, {
        method: "POST",
      });
      expect(unauthorized.status).toBe(401);

      const requestBody: RuntimeConfigDispatchRequest = {
        contractVersion: "host-backend/v1",
        backend: "runtime-config",
        options: {
          host: localHost,
        },
      };

      const adminResponse = await fetch(`${handle.url}/v1/admin/runtime-config/plan`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
      expect(adminResponse.status).toBe(404);

      const operatorInternal = await fetch(`${handle.url}/v1/internal/runtime-config/plan`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
      expect(operatorInternal.status).toBe(403);

      const daemonAdmin = await fetch(`${handle.url}/v1/admin/runtime-config/plan`, {
        method: "POST",
        headers: {
          authorization: "Bearer self-daemon-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
      expect(daemonAdmin.status).toBe(403);

      const response = await fetch(`${handle.url}/v1/internal/runtime-config/plan`, {
        method: "POST",
        headers: {
          authorization: "Bearer self-daemon-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);

      const payload = await response.json() as {
        backend: string;
        mode: string;
        requestedHost: string;
        summary: { total: number; drift: number };
      };
      expect(payload.backend).toBe("runtime-config");
      expect(payload.mode).toBe("plan");
      expect(payload.requestedHost).toBe(localHost);
      expect(payload.summary.total).toBe(3);
      expect(payload.summary.drift).toBe(3);

      const forgedRoots = await fetch(`${handle.url}/v1/internal/runtime-config/plan`, {
        method: "POST",
        headers: {
          authorization: "Bearer self-daemon-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...requestBody,
          options: {
            ...requestBody.options,
            managedConfigsRoot: join(runsRoot, "attacker-managed-configs"),
            liveHome: join(runsRoot, "attacker-home"),
          },
        }),
      });
      expect(forgedRoots.status).toBe(200);
      expect(await forgedRoots.json()).toMatchObject({ managedConfigsRoot, liveHome });

      const lockPath = join(liveHome, ".calyx", "runtime-config-apply.lock.sqlite3");
      await mkdir(dirname(lockPath), { recursive: true });
      const driver = await loadStateDriver();
      const lockHolder = driver.open(lockPath);
      lockHolder.exec("BEGIN IMMEDIATE");
      try {
        const contended = await fetch(`${handle.url}/v1/internal/runtime-config/apply`, {
          method: "POST",
          headers: {
            authorization: "Bearer self-daemon-token",
            "content-type": "application/json",
          },
          body: JSON.stringify(requestBody),
        });
        expect(contended.status).toBe(409);
        expect(await contended.json()).toMatchObject({
          error: {
            schema_version: "calyx.error/v1",
            code: "runtime_config_apply_in_progress",
            retryable: true,
          },
        });
        await expect(stat(join(liveHome, ".codex", "config.toml")))
          .rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        lockHolder.exec("ROLLBACK");
        lockHolder.close();
      }

      const applied = await fetch(`${handle.url}/v1/internal/runtime-config/apply`, {
        method: "POST",
        headers: {
          authorization: "Bearer self-daemon-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
      expect(applied.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  test("accepts runtime-config requests for the daemon advertised host alias", async () => {
    const managedConfigsRoot = join(runsRoot, "managed-configs-advertised-host");
    await mkdir(join(managedConfigsRoot, "shared"), { recursive: true });
    await writeFile(
      join(managedConfigsRoot, "shared", "config.toml"),
      'profile = "full-auto"\nmodel = "gpt-5.4"\n',
      { encoding: "utf8", flag: "w" },
    );

    const service = new RunService({ runsRoot }, buildDeps());
    const baseOptions = createServerOptions(service, registryRoot, { advertisedHost: "worm" });
    const handle = await startRunServer({
      ...baseOptions,
      credentials: baseOptions.credentials.map((credential) => credential.client_id.startsWith("daemon:")
        ? {
            ...credential,
            client_id: "daemon:blade",
            address_grants: { send_as: ["client:daemon:blade@blade"], read: ["host:blade"] },
          }
        : credential),
      advertisedHost: "worm",
      hostname: () => "blade",
      runtimeConfigRoots: { managedConfigsRoot, liveHome: runsRoot },
    });

    try {
      const requestBody: RuntimeConfigDispatchRequest = {
        contractVersion: "host-backend/v1",
        backend: "runtime-config",
        options: {
          host: "worm",
          components: ["codex"],
        },
      };

      const response = await fetch(`${handle.url}/v1/internal/runtime-config/plan`, {
        method: "POST",
        headers: {
          authorization: "Bearer self-daemon-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
      const payload = await response.json() as { backend: string; requestedHost: string; summary: { total: number } };
      expect(payload.backend).toBe("runtime-config");
      expect(payload.requestedHost).toBe("worm");
      expect(payload.summary.total).toBe(1);
    } finally {
      await handle.close();
    }
  });

  test("rejects runtime-config requests whose requested host does not match the receiving machine", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const handle = await startRunServer(createServerOptions(service, registryRoot));

    try {
      const traversal = await fetch(`${handle.url}/v1/internal/runtime-config/plan`, {
        method: "POST",
        headers: {
          authorization: "Bearer self-daemon-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          contractVersion: "host-backend/v1",
          backend: "runtime-config",
          options: { host: "blade.../../../attacker" },
        }),
      });
      expect(traversal.status).toBe(400);
      expect(await traversal.json()).toMatchObject({
        error: { message: expect.stringContaining("canonical host segment") },
      });

      const requestBody: RuntimeConfigDispatchRequest = {
        contractVersion: "host-backend/v1",
        backend: "runtime-config",
        options: {
          host: "worm",
        },
      };

      const response = await fetch(`${handle.url}/v1/internal/runtime-config/plan`, {
        method: "POST",
        headers: {
          authorization: "Bearer self-daemon-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
      expect(response.status).toBe(409);
      const payload = await response.json() as { error: { message: string } };
      expect(payload.error.message).toContain("host mismatch");
    } finally {
      await handle.close();
    }
  });

  test("validates only host and component selectors in runtime-config dispatch requests", () => {
    expect(isRuntimeConfigDispatchRequest({
      contractVersion: "host-backend/v1",
      backend: "runtime-config",
      options: {
        host: "",
      },
    })).toBe(false);

    expect(isRuntimeConfigDispatchRequest({
      contractVersion: "host-backend/v1",
      backend: "runtime-config",
      options: {
        host: "blade",
        components: ["unsupported"],
      },
    })).toBe(false);
  });
});
