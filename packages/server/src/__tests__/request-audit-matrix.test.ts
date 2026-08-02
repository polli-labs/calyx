import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HTTP_OPERATION_DESCRIPTORS,
  admitApiRequestAudit,
  applyStateMigrations,
  createMonitor,
  createMonitorWake,
  createMessage,
  evaluatePredicateV1,
  finalizeApiRequestAudit,
  hashConsumerApiBearer,
  openStateStore,
  readApiRequestAudit,
  readMonitorWake,
  runnerSupervisionPredicate,
  type ApiRequestAuditRow,
  type StateOpenOptions,
} from "@polli-labs/calyx-core";
import { RunService } from "@polli-labs/calyx-run-service";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { startRunServer, type RunServerHandle } from "../server.js";

const ADMIN_TOKEN = "audit-admin-secret-token";
const CONSUMER_TOKEN = "audit-consumer-secret-token";
const DAEMON_TOKEN = "audit-daemon-secret-token";
const ASSERTED_ACTOR = "operator:audit_matrix";
const BODY_SENTINEL = "request-body-must-never-enter-audit";

const BUILD_INFO = {
  schema_version: "build-info/v1" as const,
  git_head: "audit-matrix-sha",
  built_at: "2026-07-14T00:00:00.000Z",
  package_version: "0.2.0",
  branch: "test",
  dirty: false,
};

interface TestHarness {
  root: string;
  stateStoreOptions: StateOpenOptions;
  service: RunService;
  handle: RunServerHandle;
  url: string;
  close: () => Promise<void>;
}

interface MutationCase {
  operationId: string;
  path: string;
  method?: "POST" | "DELETE";
  token: string;
  subject: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function mutationOperationIds(): string[] {
  return HTTP_OPERATION_DESCRIPTORS
    .filter((operation) => operation.successes.every((success) => success.semantics.mutation !== "read"))
    .map((operation) => operation.operation_id);
}

function stateOptions(stateHome: string): StateOpenOptions {
  const env: Record<string, string | undefined> = { ...process.env, CALYX_STATE_HOME: stateHome };
  delete env.CALYX_STATE_DB;
  return { env };
}

async function createHarness(existingRoot?: string): Promise<TestHarness> {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), "calyx-request-audit-matrix-"));
  const runsRoot = join(root, "runs");
  const registryRoot = join(root, "registry");
  const stateStoreOptions = stateOptions(join(root, "state"));
  const service = new RunService({
    runsRoot,
    interactiveHomeDir: join(root, "interactive"),
    leases: { state: stateStoreOptions },
  }, {
    hostname: () => "blade",
    now: () => "2026-07-14T12:00:00.000Z",
  });
  const handle = await startRunServer({
    credentials: [
      {
        client_id: "audit_admin",
        credential_tier: "control_plane",
        verifier: hashConsumerApiBearer(ADMIN_TOKEN),
        verifier_env: "CALYX_CONSUMER_API_TEST_AUDIT_ADMIN_VERIFIER",
        address_grants: {
          send_as: ["client:audit_admin@blade"],
          read: ["run:*"],
        },
      },
      {
        client_id: "audit_consumer",
        credential_tier: "consumer",
        verifier: hashConsumerApiBearer(CONSUMER_TOKEN),
        verifier_env: "CALYX_CONSUMER_API_TEST_AUDIT_CONSUMER_VERIFIER",
        address_grants: {
          send_as: ["client:audit_consumer@blade"],
          read: ["run:*"],
        },
      },
      {
        client_id: "daemon:blade",
        credential_tier: "internal_runtime",
        verifier: hashConsumerApiBearer(DAEMON_TOKEN),
        verifier_env: "CALYX_CONSUMER_API_TEST_AUDIT_DAEMON_VERIFIER",
        address_grants: {
          send_as: ["client:daemon.blade@blade"],
          read: ["host:blade"],
        },
      },
    ],
    host: "127.0.0.1",
    advertisedHost: "blade",
    hostname: () => "blade",
    port: 0,
    service,
    registryRoot,
    stateStoreOptions,
    buildInfo: BUILD_INFO,
    startedAt: "2026-07-14T12:00:00.000Z",
    inheritedPath: "/usr/bin:/bin",
  });
  return {
    root,
    stateStoreOptions,
    service,
    handle,
    url: handle.url.replace("http://blade:", "http://127.0.0.1:"),
    close: async () => {
      await handle.close();
      if (!existingRoot) await rm(root, { recursive: true, force: true });
    },
  };
}

async function auditRows(options: StateOpenOptions): Promise<ApiRequestAuditRow[]> {
  const opened = await openStateStore(options);
  try {
    return (opened.db.prepare(
      `SELECT request_id, server_instance_id, operation_id, subject, asserted_actor,
              served_by_host, via, admitted_at, finalized_at, response_status,
              error_code, outcome
         FROM api_request_audit
        ORDER BY admitted_at, request_id`,
    ).all() as Array<Record<string, unknown>>).map((row) => ({
      request_id: String(row["request_id"]),
      server_instance_id: String(row["server_instance_id"]),
      operation_id: String(row["operation_id"]),
      subject: String(row["subject"]),
      asserted_actor: typeof row["asserted_actor"] === "string" ? row["asserted_actor"] : null,
      served_by_host: String(row["served_by_host"]),
      via: "http",
      admitted_at: String(row["admitted_at"]),
      finalized_at: typeof row["finalized_at"] === "string" ? row["finalized_at"] : null,
      response_status: row["response_status"] === null ? null : Number(row["response_status"]),
      error_code: typeof row["error_code"] === "string" ? row["error_code"] : null,
      outcome: row["outcome"] as ApiRequestAuditRow["outcome"],
    }));
  } finally {
    opened.db.close();
  }
}

async function waitForAudit(
  options: StateOpenOptions,
  predicate: (row: ApiRequestAuditRow) => boolean,
): Promise<ApiRequestAuditRow> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const row = (await auditRows(options)).find(predicate);
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for request audit row");
}

async function seedForwardMessage(options: StateOpenOptions): Promise<Record<string, unknown>> {
  const opened = await openStateStore(options);
  try {
    return createMessage(opened.db, {
      message_id: "msg_audit_matrix_forward",
      sender: "client:source@carbon",
      recipient_address: "client:audit_admin@blade",
      recipient_class: "directed",
      recipient_host: "blade",
      subject: "request audit forward",
      body: BODY_SENTINEL,
      created_provenance: null,
    }).message as unknown as Record<string, unknown>;
  } finally {
    opened.db.close();
  }
}

function mutationCases(harness: TestHarness, forwardedMessage: Record<string, unknown>): MutationCase[] {
  const launchIntent = harness.service.createIntent({
    run_id: "run-audit-matrix-launch",
    host: "local",
    prompt: BODY_SENTINEL,
    require_execplan: false,
  });
  return [
    {
      operationId: "attention.mark.create",
      path: "/v1/marks",
      token: CONSUMER_TOKEN,
      subject: "audit_consumer",
      body: {
        schema_version: "calyx.activity-mark-create-request/v1",
        idempotency_key: "audit-mark-create",
        target_kind: "activity",
        target_id: "interactive:codex:019f9000-1111-7222-8333-abcabcabcabc",
        kind: "high_signal",
        reason: BODY_SENTINEL,
      },
    },
    {
      operationId: "attention.mark.revoke",
      path: "/v1/marks/mark_00000000-0000-4000-8000-000000000000",
      method: "DELETE",
      token: CONSUMER_TOKEN,
      subject: "audit_consumer",
    },
    {
      operationId: "msg.send",
      path: "/v1/messages/send",
      token: ADMIN_TOKEN,
      subject: "audit_admin",
      body: {
        schema_version: "calyx.msg-send/v1",
        idempotency_key: "audit-msg-send",
        recipient_address: "role:reviewer@blade",
        reply_address: "client:not_granted@blade",
        subject: "audit matrix",
        body: BODY_SENTINEL,
      },
    },
    {
      operationId: "admin.msg.forward",
      path: "/v1/admin/message-operations/outbox_audit_matrix_missing/forward",
      token: ADMIN_TOKEN,
      subject: "audit_admin",
    },
    {
      operationId: "admin.session-wake.deliver",
      path: "/v1/admin/session-wakes/deliver",
      token: ADMIN_TOKEN,
      subject: "audit_admin",
      body: {
        schema_version: "calyx.session-wake-deliver-request/v1",
        delivery_id: `session_wake_${"0".repeat(64)}`,
        recipient_activity_id: "interactive:codex:audit-matrix",
        pointer: { kind: "message", id: "msg_audit_matrix_wake" },
        created_at: "2026-07-14T12:00:00.000Z",
      },
    },
    {
      operationId: "admin.run.launch",
      path: "/v1/admin/runs",
      token: ADMIN_TOKEN,
      subject: "audit_admin",
      body: {
        schema_version: "calyx.run-launch-request/v1",
        intent: launchIntent,
        idempotency_key: "audit-run-launch",
      },
      headers: { accept: "application/vnd.polli.calyx.run-launch-receipt+json;version=2" },
    },
    {
      operationId: "admin.run.reconcile-preserving",
      path: "/v1/admin/runs/reconcile-preserving/v1",
      token: ADMIN_TOKEN,
      subject: "audit_admin",
    },
    {
      operationId: "admin.run.stop",
      path: "/v1/admin/runs/run-audit-missing/stop",
      token: ADMIN_TOKEN,
      subject: "audit_admin",
      body: { reason: BODY_SENTINEL },
    },
    {
      operationId: "internal.run.reconcile",
      path: "/v1/internal/runs/reconcile",
      token: DAEMON_TOKEN,
      subject: "daemon:blade",
    },
    {
      operationId: "admin.monitor.create",
      path: "/v1/admin/monitors",
      token: ADMIN_TOKEN,
      subject: "audit_admin",
      body: {
        schema_version: "calyx.monitor-create-request/v1",
        idempotency_key: "audit-monitor-create",
        owner: "operator",
        created_by: "audit-matrix",
        create_provenance: "operator",
        assigned_host: "not-blade",
        source_run_id: "run-audit-missing",
        preset: "runner-supervision",
        stale_after_ms: 60_000,
        rearm_policy: "once",
      },
    },
    {
      operationId: "admin.monitor.claim",
      path: "/v1/admin/monitors/wakes",
      token: ADMIN_TOKEN,
      subject: "audit_admin",
      body: { idempotency_key: "audit-monitor-claim", claimed_by: "audit-matrix", limit: 10 },
    },
    {
      operationId: "admin.monitor.ack",
      path: "/v1/admin/monitors/wakes/wake-audit-missing/ack",
      token: ADMIN_TOKEN,
      subject: "audit_admin",
      body: { acked_by: "audit-matrix" },
    },
    {
      operationId: "admin.monitor.cancel",
      path: "/v1/admin/monitors/monitor-audit-missing/cancel",
      token: ADMIN_TOKEN,
      subject: "audit_admin",
      body: { reason: BODY_SENTINEL },
    },
    ...(["acquire", "renew", "release", "steal"] as const).map((action) => ({
      operationId: `admin.lease.${action}`,
      path: `/v1/admin/leases/${action}`,
      token: ADMIN_TOKEN,
      subject: "audit_admin",
      body: {
        key: `worktree:not-blade:/tmp/${BODY_SENTINEL}`,
        idempotency_key: `audit-lease-${action}`,
        holder_activity_id: "run:audit-matrix",
        ...(action === "release" ? {} : { ttl_ms: 60_000 }),
        ...(action === "steal" ? { provenance: { reason: BODY_SENTINEL } } : {}),
      },
    })),
    {
      operationId: "internal.runtime-config.apply",
      path: "/v1/internal/runtime-config/apply",
      token: DAEMON_TOKEN,
      subject: "daemon:blade",
      body: {
        contractVersion: "host-backend/v1",
        backend: "runtime-config",
        options: { host: "not-blade", liveHome: `/tmp/${BODY_SENTINEL}` },
      },
    },
    {
      operationId: "internal.msg.receive",
      path: "/v1/internal/messages/receive",
      token: DAEMON_TOKEN,
      subject: "daemon:blade",
      body: { schema_version: "calyx.msg-send/v1", message: forwardedMessage },
    },
  ];
}

async function issueMutation(harness: TestHarness, testCase: MutationCase): Promise<{
  status: number;
  requestId: string;
  errorCode: string | null;
}> {
  const response = await fetch(`${harness.url}${testCase.path}`, {
    method: testCase.method ?? "POST",
    headers: {
      authorization: `Bearer ${testCase.token}`,
      "x-calyx-asserted-actor": ASSERTED_ACTOR,
      ...(testCase.body === undefined ? {} : { "content-type": "application/json" }),
      ...testCase.headers,
    },
    ...(testCase.body === undefined ? {} : { body: JSON.stringify(testCase.body) }),
  });
  const requestId = response.headers.get("x-calyx-request-id");
  expect(requestId, testCase.operationId).toMatch(/^req_[0-9a-f-]{36}$/);
  const text = await response.text();
  const payload = text ? JSON.parse(text) as { error?: { code?: string } } : undefined;
  return {
    status: response.status,
    requestId: requestId!,
    errorCode: payload?.error?.code ?? null,
  };
}

describe("HTTP request-audit admission matrix", () => {
  let priorDisableOtel: string | undefined;

  beforeEach(() => {
    priorDisableOtel = process.env.CALYX_DISABLE_OTEL;
    process.env.CALYX_DISABLE_OTEL = "1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (priorDisableOtel === undefined) delete process.env.CALYX_DISABLE_OTEL;
    else process.env.CALYX_DISABLE_OTEL = priorDisableOtel;
  });

  test("pins and finalizes the complete 19-operation mutation matrix without retaining request bodies or credentials", async () => {
    const harness = await createHarness();
    try {
      const forwardedMessage = await seedForwardMessage(harness.stateStoreOptions);
      const cases = mutationCases(harness, forwardedMessage);
      expect(mutationOperationIds()).toEqual([
        "attention.mark.create",
        "attention.mark.revoke",
        "msg.send",
        "admin.msg.forward",
        "admin.session-wake.deliver",
        "admin.run.launch",
        "admin.run.reconcile-preserving",
        "admin.run.stop",
        "internal.run.reconcile",
        "admin.monitor.create",
        "admin.monitor.claim",
        "admin.monitor.ack",
        "admin.monitor.cancel",
        "admin.lease.acquire",
        "admin.lease.renew",
        "admin.lease.release",
        "admin.lease.steal",
        "internal.runtime-config.apply",
        "internal.msg.receive",
      ]);
      expect(cases.map((testCase) => testCase.operationId)).toEqual(mutationOperationIds());

      for (const testCase of cases) {
        const result = await issueMutation(harness, testCase);
        const row = await waitForAudit(
          harness.stateStoreOptions,
          (candidate) => candidate.request_id === result.requestId && candidate.outcome !== "admitted",
        );
        expect(row, testCase.operationId).toMatchObject({
          operation_id: testCase.operationId,
          request_id: result.requestId,
          subject: testCase.subject,
          asserted_actor: ASSERTED_ACTOR,
          served_by_host: "blade",
          via: "http",
          response_status: result.status,
          error_code: result.errorCode,
          outcome: result.status < 300 ? "response_completed" : "response_rejected",
        });
        expect(row.finalized_at, testCase.operationId).toBeTruthy();
      }

      const rows = await auditRows(harness.stateStoreOptions);
      expect(rows).toHaveLength(19);
      const serialized = JSON.stringify(rows);
      for (const forbidden of [ADMIN_TOKEN, CONSUMER_TOKEN, DAEMON_TOKEN, BODY_SENTINEL]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      await harness.close();
    }
  });

  test("audits pending and cross-claimant ack refusals before exact-claimant success", async () => {
    const harness = await createHarness();
    const claimant = "interactive:codex:audit-monitor-claimant";
    const intruder = "interactive:codex:audit-monitor-intruder";
    let wakeId = "";
    try {
      const opened = await openStateStore(harness.stateStoreOptions);
      try {
        const predicate = runnerSupervisionPredicate("run-audit-monitor-ack");
        const monitor = createMonitor(opened.db, {
          monitor_id: "mon_audit_ack_contract",
          owner: claimant,
          created_by: "audit-matrix",
          create_provenance: "operator",
          assigned_host: "blade",
          source_run_id: "run-audit-monitor-ack",
          preset: "runner-supervision",
          predicate,
          rearm_policy: "once",
          now: "2026-07-14T11:58:00.000Z",
        });
        const evaluation = await evaluatePredicateV1(predicate, {
          now: () => new Date("2026-07-14T11:59:00.000Z"),
          readRun: () => ({
            run_id: "run-audit-monitor-ack",
            state: "failed",
            updated_at: "2026-07-14T11:59:00.000Z",
            completed_at: "2026-07-14T11:59:00.000Z",
          }),
        });
        wakeId = createMonitorWake(opened.db, {
          monitor,
          evaluation,
          suggested_commands: ["calyx monitor inbox --json"],
          created_at: evaluation.evaluated_at,
        }).wake.wake_id;
      } finally {
        opened.db.close();
      }

      const mutate = async (path: string, body: unknown) => {
        const response = await fetch(`${harness.url}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "application/json",
            "x-calyx-asserted-actor": ASSERTED_ACTOR,
          },
          body: JSON.stringify(body),
        });
        const requestId = response.headers.get("x-calyx-request-id")!;
        const payload = await response.json() as Record<string, unknown>;
        await waitForAudit(
          harness.stateStoreOptions,
          (row) => row.request_id === requestId && row.outcome !== "admitted",
        );
        return { response, requestId, payload };
      };
      const ackPath = `/v1/admin/monitors/wakes/${wakeId}/ack`;

      const pending = await mutate(ackPath, { acked_by: claimant });
      expect(pending.response.status).toBe(409);
      expect(pending.payload).toMatchObject({ error: { code: "monitor_wake_not_claimed" } });

      const claim = await mutate("/v1/admin/monitors/wakes", {
        idempotency_key: "audit-monitor-wake-claim",
        claimed_by: claimant,
      });
      expect(claim.response.status).toBe(200);
      expect(claim.payload).toMatchObject({
        count: 1,
        wakes: [expect.objectContaining({ wake_id: wakeId, claimed_by: claimant })],
      });

      const crossClaimant = await mutate(ackPath, { acked_by: intruder });
      expect(crossClaimant.response.status).toBe(409);
      expect(crossClaimant.payload).toMatchObject({ error: { code: "monitor_wake_claimant_mismatch" } });

      const accepted = await mutate(ackPath, { acked_by: claimant });
      expect(accepted.response.status).toBe(200);
      expect(accepted.payload).toMatchObject({
        changed: true,
        wake: { wake_id: wakeId, status: "acked", acked_by: claimant },
      });
      const replay = await mutate(ackPath, { acked_by: claimant });
      expect(replay.response.status).toBe(200);
      expect(replay.payload).toMatchObject({ changed: false });

      const verify = await openStateStore(harness.stateStoreOptions);
      try {
        expect(readMonitorWake(verify.db, wakeId)).toMatchObject({
          status: "acked",
          claimed_by: null,
          claimed_until: null,
          acked_by: claimant,
        });
      } finally {
        verify.db.close();
      }

      const rows = await auditRows(harness.stateStoreOptions);
      const ackRows = rows.filter((row) => row.operation_id === "admin.monitor.ack").map((row) => ({
        status: row.response_status,
        error: row.error_code,
        outcome: row.outcome,
      }));
      expect(ackRows).toHaveLength(4);
      expect(ackRows).toEqual(expect.arrayContaining([
        { status: 409, error: "monitor_wake_not_claimed", outcome: "response_rejected" },
        { status: 409, error: "monitor_wake_claimant_mismatch", outcome: "response_rejected" },
      ]));
      expect(ackRows.filter((row) => row.status === 200)).toEqual([
        { status: 200, error: null, outcome: "response_completed" },
        { status: 200, error: null, outcome: "response_completed" },
      ]);
    } finally {
      await harness.close();
    }
  });

  test("never admits pre-auth, profile, path, actor, media, or body failures and never audits any read descriptor", async () => {
    const harness = await createHarness();
    try {
      const failures = [
        fetch(`${harness.url}/v1/admin/runs/reconcile-preserving/v1`, { method: "POST" }),
        fetch(`${harness.url}/v1/admin/runs/reconcile-preserving/v1`, {
          method: "POST",
          headers: { authorization: `Bearer ${CONSUMER_TOKEN}` },
        }),
        fetch(`${harness.url}/v1/admin/runs/%ZZ/stop`, {
          method: "POST",
          headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
          body: "{}",
        }),
        fetch(`${harness.url}/v1/admin/leases/acquire`, {
          method: "POST",
          headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
          body: "{}",
        }),
        fetch(`${harness.url}/v1/admin/leases/acquire`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "application/json",
            "x-calyx-asserted-actor": "not-a-canonical-actor",
          },
          body: JSON.stringify({
            key: "worktree:blade:/tmp/audit",
            idempotency_key: "invalid-actor",
            holder_activity_id: "run:audit",
            ttl_ms: 60_000,
          }),
        }),
        fetch(`${harness.url}/v1/admin/leases/acquire`, {
          method: "POST",
          headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "text/plain" },
          body: "not-json",
        }),
        fetch(`${harness.url}/v1/admin/leases/acquire`, {
          method: "POST",
          headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({
            key: "worktree:blade:/tmp/audit",
            idempotency_key: "whitespace-holder",
            holder_activity_id: "   ",
            ttl_ms: 60_000,
          }),
        }),
        fetch(`${harness.url}/v1/messages/send`, {
          method: "POST",
          headers: { authorization: `Bearer ${CONSUMER_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({
            schema_version: "calyx.msg-send/v1",
            idempotency_key: "whitespace-subject",
            recipient_address: "role:reviewer@blade",
            reply_address: "client:switchboard@blade",
            subject: "   ",
          }),
        }),
      ];
      const responses = await Promise.all(failures);
      expect(responses.map((response) => response.status)).toEqual([401, 403, 400, 400, 400, 415, 400, 400]);
      await Promise.all(responses.map((response) => response.arrayBuffer()));
      expect(await auditRows(harness.stateStoreOptions)).toEqual([]);

      const reads = HTTP_OPERATION_DESCRIPTORS.filter((operation) => (
        operation.successes.every((success) => success.semantics.mutation === "read")
      ));
      expect(reads.length).toBeGreaterThan(40);
      for (const operation of reads) {
        const path = operation.path.replaceAll(/\{[^}]+\}/g, "probe");
        const token = operation.profile === "consumer_v1" ? DAEMON_TOKEN : CONSUMER_TOKEN;
        const response = await fetch(`${harness.url}${path}`, {
          method: operation.method,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.status, `${operation.method} ${operation.path}`).toBe(403);
        await response.arrayBuffer();
      }
      expect(await auditRows(harness.stateStoreOptions)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test("fails closed before a lease effect when the audit schema is unavailable", async () => {
    const harness = await createHarness();
    try {
      const opened = await openStateStore(harness.stateStoreOptions);
      try {
        opened.db.exec("DROP TABLE api_request_audit");
      } finally {
        opened.db.close();
      }
      const key = "worktree:blade:/tmp/audit-schema-fail-closed";
      const response = await fetch(`${harness.url}/v1/admin/leases/acquire`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
          "x-calyx-asserted-actor": ASSERTED_ACTOR,
        },
        body: JSON.stringify({
          key,
          idempotency_key: "audit-schema-fail-closed",
          holder_activity_id: "run:audit-schema",
          ttl_ms: 60_000,
        }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "provenance_audit_unavailable" } });
      const after = await openStateStore(harness.stateStoreOptions);
      try {
        expect(after.db.prepare("SELECT key FROM leases WHERE key = ?").get(key)).toBeUndefined();
      } finally {
        after.db.close();
      }
    } finally {
      await harness.close();
    }
  });

  test("seek-pages the request-audit API through every retained row", async () => {
    const harness = await createHarness();
    try {
      const opened = await openStateStore(harness.stateStoreOptions);
      try {
        for (let index = 1; index <= 5; index += 1) {
          const requestId = `req_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
          admitApiRequestAudit(opened.db, {
            request_id: requestId,
            server_instance_id: "server_page_fixture",
            operation_id: "admin.run.reconcile",
            subject: "audit_admin",
            served_by_host: "blade",
            admitted_at: index <= 3
              ? "2026-07-14T00:00:02.000Z"
              : "2026-07-14T00:00:01.000Z",
          });
          finalizeApiRequestAudit(opened.db, {
            request_id: requestId,
            response_status: 200,
            finalized_at: "2026-07-14T00:00:03.000Z",
          });
        }
      } finally {
        opened.db.close();
      }

      const observed: string[] = [];
      let cursor: string | undefined;
      do {
        const url = new URL(`${harness.url}/v1/admin/request-audit`);
        url.searchParams.set("limit", "2");
        if (cursor) url.searchParams.set("cursor", cursor);
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        });
        expect(response.status).toBe(200);
        const page = await response.json() as {
          requests: Array<{ request_id: string }>;
          truncated: boolean;
          next_cursor?: string;
        };
        observed.push(...page.requests.map((row) => row.request_id));
        cursor = page.next_cursor;
        expect(Boolean(cursor)).toBe(page.truncated);
      } while (cursor);

      expect(observed).toHaveLength(5);
      expect(new Set(observed).size).toBe(5);
      expect(observed).toEqual([
        "req_00000000-0000-4000-8000-000000000001",
        "req_00000000-0000-4000-8000-000000000002",
        "req_00000000-0000-4000-8000-000000000003",
        "req_00000000-0000-4000-8000-000000000004",
        "req_00000000-0000-4000-8000-000000000005",
      ]);
    } finally {
      await harness.close();
    }
  });

  test("marks an admitted request indeterminate when the client aborts before a response finishes", async () => {
    const harness = await createHarness();
    try {
      vi.spyOn(harness.service, "reconcile").mockImplementation(async () => await new Promise(() => {}));
      const target = new URL(`${harness.url}/v1/admin/runs/reconcile-preserving/v1`);
      const request = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "x-calyx-asserted-actor": ASSERTED_ACTOR,
        },
      });
      request.on("error", () => {});
      request.end();
      const admitted = await waitForAudit(
        harness.stateStoreOptions,
        (row) => row.operation_id === "admin.run.reconcile-preserving" && row.outcome === "admitted",
      );
      request.destroy();
      const abandoned = await waitForAudit(
        harness.stateStoreOptions,
        (row) => row.request_id === admitted.request_id && row.outcome === "indeterminate",
      );
      expect(abandoned).toMatchObject({
        response_status: null,
        error_code: null,
        finalized_at: expect.any(String),
      });
    } finally {
      await harness.close();
    }
  });

  test("startup recovery conservatively marks a prior server instance's admitted row indeterminate", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-request-audit-recovery-"));
    const options = stateOptions(join(root, "state"));
    await applyStateMigrations({ storeOptions: options });
    const requestId = "req_12345678-1234-4123-8123-123456789abc";
    const opened = await openStateStore(options);
    try {
      admitApiRequestAudit(opened.db, {
        request_id: requestId,
        server_instance_id: "server_previous_instance",
        operation_id: "admin.run.reconcile",
        subject: "audit_admin",
        asserted_actor: ASSERTED_ACTOR,
        served_by_host: "blade",
        admitted_at: "2026-07-14T11:59:00.000Z",
      });
    } finally {
      opened.db.close();
    }

    const harness = await createHarness(root);
    try {
      const recovered = await openStateStore(options);
      try {
        expect(readApiRequestAudit(recovered.db, requestId)).toMatchObject({
          server_instance_id: "server_previous_instance",
          outcome: "indeterminate",
          response_status: null,
          error_code: null,
          finalized_at: expect.any(String),
        });
      } finally {
        recovered.db.close();
      }
    } finally {
      await harness.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
