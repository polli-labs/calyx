import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hashConsumerApiBearer,
  openStateStore,
  parseActivityMarkTargetId,
  readApiIdempotency,
  type StateOpenOptions,
} from "@polli-labs/calyx-core";
import {
  ActivityMarkTargetAmbiguousError,
  ActivityMarkTargetNotFoundError,
  ActivityMarkTargetUnavailableError,
  RunService,
} from "@polli-labs/calyx-run-service";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";

import { startRunServer, type RunServerHandle } from "../server.js";

const CONSUMER_TOKEN = "marks-consumer-token";
const CONTROL_TOKEN = "marks-control-token";
const INTERNAL_TOKEN = "marks-internal-token";
const ACTIVITY_ID = "interactive:codex:019f9000-1111-7222-8333-abcabcabcabc";

const BUILD_INFO = {
  schema_version: "build-info/v1" as const,
  git_head: "activity-marks-test-sha",
  built_at: "2026-07-21T00:00:00.000Z",
  package_version: "0.2.0",
  branch: "test",
  dirty: false,
};

interface Harness {
  root: string;
  state: StateOpenOptions;
  service: RunService;
  resolver: MockInstance<RunService["resolveMarkableActivityTarget"]>;
  handle: RunServerHandle;
  url: string;
}

interface JsonResponse {
  response: Response;
  body: Record<string, unknown>;
}

function stateOptions(stateHome: string): StateOpenOptions {
  const env: Record<string, string | undefined> = { ...process.env, CALYX_STATE_HOME: stateHome };
  delete env.CALYX_STATE_DB;
  return { env };
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "calyx-server-activity-marks-"));
  const state = stateOptions(join(root, "state"));
  const service = new RunService({
    runsRoot: join(root, "runs"),
    interactiveHomeDir: join(root, "home"),
    activityRecall: { enabled: false },
    handback: { enabled: false },
    leases: { enabled: false },
    subscribers: [],
  }, {
    hostname: () => "blade",
    now: () => "2026-07-21T12:00:00.000Z",
  });
  const resolver = vi.spyOn(service, "resolveMarkableActivityTarget").mockImplementation(async ({
    targetKind,
    targetId,
  }) => {
    try {
      parseActivityMarkTargetId(targetKind, targetId);
    } catch {
      throw new ActivityMarkTargetNotFoundError();
    }
    if (targetId.includes("missing") || targetId.includes("hidden")) {
      throw new ActivityMarkTargetNotFoundError();
    }
    if (targetId.includes("duplicate")) {
      throw new ActivityMarkTargetAmbiguousError();
    }
    if (targetId.includes("unavailable")) {
      throw new ActivityMarkTargetUnavailableError();
    }
    if (targetId.includes("programmer-error")) {
      throw new Error("fixture programmer failure with private path /secret/transcript.jsonl");
    }
    const marker = targetKind === "turn" ? ":turn:" : ":msg:";
    const markerIndex = targetKind === "activity" ? -1 : targetId.lastIndexOf(marker);
    return {
      target_kind: targetKind,
      target_id: targetId,
      activity_id: markerIndex < 0 ? targetId : targetId.slice(0, markerIndex),
      ...(markerIndex < 0 ? {} : { source_line: Number(targetId.slice(markerIndex + marker.length)) }),
    };
  });
  const handle = await startRunServer({
    credentials: [
      {
        client_id: "marks_consumer",
        credential_tier: "consumer",
        verifier: hashConsumerApiBearer(CONSUMER_TOKEN),
        verifier_env: "CALYX_CONSUMER_API_TEST_MARKS_CONSUMER_VERIFIER",
        address_grants: { send_as: ["client:marks_consumer@blade"], read: ["run:*"] },
      },
      {
        client_id: "marks_control",
        credential_tier: "control_plane",
        verifier: hashConsumerApiBearer(CONTROL_TOKEN),
        verifier_env: "CALYX_CONSUMER_API_TEST_MARKS_CONTROL_VERIFIER",
        address_grants: { send_as: ["client:marks_control@blade"], read: ["run:*"] },
      },
      {
        client_id: "daemon:blade",
        credential_tier: "internal_runtime",
        verifier: hashConsumerApiBearer(INTERNAL_TOKEN),
        verifier_env: "CALYX_CONSUMER_API_TEST_MARKS_INTERNAL_VERIFIER",
        address_grants: { send_as: ["client:daemon.blade@blade"], read: ["host:blade"] },
      },
    ],
    host: "127.0.0.1",
    advertisedHost: "blade",
    hostname: () => "blade",
    port: 0,
    service,
    registryRoot: join(root, "registry"),
    stateStoreOptions: state,
    buildInfo: BUILD_INFO,
    startedAt: "2026-07-21T12:00:00.000Z",
    inheritedPath: "/usr/bin:/bin",
  });
  return {
    root,
    state,
    service,
    resolver,
    handle,
    url: handle.url.replace("http://blade:", "http://127.0.0.1:"),
  };
}

function createBody(
  idempotencyKey: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: "calyx.activity-mark-create-request/v1",
    idempotency_key: idempotencyKey,
    target_kind: "activity",
    target_id: ACTIVITY_ID,
    kind: "high_signal",
    ...overrides,
  };
}

async function requestJson(
  harness: Harness,
  path: string,
  options: {
    method?: string;
    token?: string;
    actor?: string;
    body?: unknown;
    contentType?: string;
  } = {},
): Promise<JsonResponse> {
  const response = await fetch(`${harness.url}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.actor ? { "x-calyx-asserted-actor": options.actor } : {}),
      ...(options.contentType ? { "content-type": options.contentType } : {}),
      ...(options.body === undefined || options.contentType ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined
      ? {}
      : { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) }),
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

async function waitForAudit(
  state: StateOpenOptions,
  requestId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const opened = await openStateStore(state);
    try {
      const row = opened.db.prepare(
        `SELECT operation_id, subject, asserted_actor, served_by_host, response_status,
                error_code, outcome
           FROM api_request_audit
          WHERE request_id = ? AND outcome <> 'admitted'`,
      ).get(requestId) as Record<string, unknown> | undefined;
      if (row) return row;
    } finally {
      opened.db.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for audit ${requestId}`);
}

describe("consumer activity mark routes", () => {
  const harnesses: Harness[] = [];
  let priorDisableOtel: string | undefined;

  beforeEach(() => {
    priorDisableOtel = process.env.CALYX_DISABLE_OTEL;
    process.env.CALYX_DISABLE_OTEL = "1";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(harnesses.splice(0).map(async (harness) => {
      await harness.handle.close();
      await rm(harness.root, { recursive: true, force: true });
    }));
    if (priorDisableOtel === undefined) delete process.env.CALYX_DISABLE_OTEL;
    else process.env.CALYX_DISABLE_OTEL = priorDisableOtel;
  });

  async function harness(): Promise<Harness> {
    const created = await createHarness();
    harnesses.push(created);
    return created;
  }

  test("enforces consumer profile law, keeps ownership on subject, and exposes no admin twin", async () => {
    const server = await harness();
    const body = createBody("profile-law");

    const unauthorized = await requestJson(server, "/v1/marks", { method: "POST", body });
    expect(unauthorized.response.status).toBe(401);

    const internal = await requestJson(server, "/v1/marks", {
      method: "POST",
      token: INTERNAL_TOKEN,
      body,
    });
    expect(internal.response.status).toBe(403);
    expect(internal.body).toMatchObject({ error: { code: "profile_forbidden" } });

    const created = await requestJson(server, "/v1/marks", {
      method: "POST",
      token: CONSUMER_TOKEN,
      actor: "operator:not_the_owner",
      body,
    });
    expect(created.response.status).toBe(200);
    expect(created.body).toMatchObject({
      schema_version: "calyx.activity-mark/v1",
      marked_by: "marks_consumer",
      target_id: ACTIVITY_ID,
      created_provenance: {
        subject: "marks_consumer",
        asserted_actor: "operator:not_the_owner",
        host: "blade",
        via: "http",
      },
    });
    expect(created.body).not.toHaveProperty("created");
    expect(created.body).not.toHaveProperty("marked_revision");

    const control = await requestJson(server, "/v1/marks", {
      method: "POST",
      token: CONTROL_TOKEN,
      body: createBody("control-profile"),
    });
    expect(control.response.status).toBe(200);
    expect(control.body).toMatchObject({ marked_by: "marks_control" });
    expect(control.body["mark_id"]).not.toBe(created.body["mark_id"]);

    const noAdminTwin = await requestJson(server, "/v1/admin/marks", {
      method: "POST",
      token: CONTROL_TOKEN,
      body: createBody("no-admin-twin"),
    });
    expect(noAdminTwin.response.status).toBe(404);
  });

  test("persists exact audit/provenance and returns the active snapshot DTO", async () => {
    const server = await harness();
    const created = await requestJson(server, "/v1/marks", {
      method: "POST",
      token: CONSUMER_TOKEN,
      actor: "operator:marks_audit",
      body: createBody("audit-create", { reason: "Durable signal" }),
    });
    expect(created.response.status).toBe(200);
    const requestId = created.response.headers.get("x-calyx-request-id")!;
    const audit = await waitForAudit(server.state, requestId);
    expect(audit).toMatchObject({
      operation_id: "attention.mark.create",
      subject: "marks_consumer",
      asserted_actor: "operator:marks_audit",
      served_by_host: "blade",
      response_status: 200,
      error_code: null,
      outcome: "response_completed",
    });

    const opened = await openStateStore(server.state);
    try {
      const ledger = readApiIdempotency(
        opened.db,
        "marks_consumer",
        "attention.mark.create",
        "audit-create",
      );
      expect(ledger).toMatchObject({
        asserted_actor: "operator:marks_audit",
        first_request_id: requestId,
        first_request_provenance: {
          request_id: requestId,
          subject: "marks_consumer",
          asserted_actor: "operator:marks_audit",
          host: "blade",
          via: "http",
        },
        response_status: 200,
        response: created.body,
      });
    } finally {
      opened.db.close();
    }

    const listed = await requestJson(
      server,
      `/v1/marks?kind=high_signal&target_kind=activity&target_id=${encodeURIComponent(ACTIVITY_ID)}&limit=1`,
      { token: CONSUMER_TOKEN },
    );
    expect(listed.response.status).toBe(200);
    expect(listed.body).toMatchObject({
      schema_version: "calyx.activity-mark-list/v1",
      truncated: false,
      marks: [created.body],
    });
    expect(listed.body).toHaveProperty("snapshot_at");
    expect(listed.body).not.toHaveProperty("count");
    expect(listed.body).not.toHaveProperty("next_cursor");
  });

  test("replays before revalidation, conflicts on changed presence, and preserves immutable revoke retry", async () => {
    const server = await harness();
    const body = createBody("replay-after-revoke");
    const created = await requestJson(server, "/v1/marks", {
      method: "POST",
      token: CONSUMER_TOKEN,
      body,
    });
    expect(created.response.status).toBe(200);
    expect(server.resolver).toHaveBeenCalledTimes(1);
    const markId = String(created.body["mark_id"]);

    const revoked = await requestJson(server, `/v1/marks/${encodeURIComponent(markId)}`, {
      method: "DELETE",
      token: CONSUMER_TOKEN,
      actor: "operator:first_revoke",
    });
    expect(revoked.response.status).toBe(200);
    expect(revoked.body).toMatchObject({
      schema_version: "calyx.activity-mark-revocation/v1",
      mark_id: markId,
      revoked_provenance: { asserted_actor: "operator:first_revoke" },
    });
    expect(revoked.body).not.toHaveProperty("changed");

    const retriedRevoke = await requestJson(server, `/v1/marks/${encodeURIComponent(markId)}`, {
      method: "DELETE",
      token: CONSUMER_TOKEN,
      actor: "operator:later_retry",
      contentType: "text/plain",
    });
    expect(retriedRevoke.response.status).toBe(200);
    expect(retriedRevoke.body).toEqual(revoked.body);

    const drifted = await openStateStore(server.state);
    try {
      drifted.db.exec("DROP INDEX idx_activity_marks_active_natural_key");
    } finally {
      drifted.db.close();
    }

    const replayed = await requestJson(server, "/v1/marks", {
      method: "POST",
      token: CONSUMER_TOKEN,
      body,
    });
    expect(replayed.response.status).toBe(200);
    expect(replayed.body).toEqual(created.body);
    expect(server.resolver).toHaveBeenCalledTimes(1);

    const conflict = await requestJson(server, "/v1/marks", {
      method: "POST",
      token: CONSUMER_TOKEN,
      body: { ...body, reason: "presence changed" },
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: { code: "idempotency_conflict" } });
    expect(server.resolver).toHaveBeenCalledTimes(1);
  });

  test("strips unknown request fields before hashing and replays the admitted projection", async () => {
    const server = await harness();
    const body = createBody("forward-compatible-replay");
    const created = await requestJson(server, "/v1/marks", {
      method: "POST",
      token: CONSUMER_TOKEN,
      body: { ...body, future_field: { from: "newer-client" } },
    });
    expect(created.response.status).toBe(200);

    const replay = await requestJson(server, "/v1/marks", {
      method: "POST",
      token: CONSUMER_TOKEN,
      body,
    });
    expect(replay.response.status).toBe(200);
    expect(replay.body).toEqual(created.body);
    expect(server.resolver).toHaveBeenCalledTimes(1);
  });

  test("fails closed when committed replay authority no longer satisfies the generated success contract", async () => {
    const server = await harness();
    const body = createBody("corrupt-replay");
    const created = await requestJson(server, "/v1/marks", {
      method: "POST",
      token: CONSUMER_TOKEN,
      body,
    });
    expect(created.response.status).toBe(200);

    const opened = await openStateStore(server.state);
    try {
      opened.db.prepare(
        `UPDATE api_idempotency
            SET response_status = 201, response_json = '{}'
          WHERE subject = 'marks_consumer'
            AND operation_id = 'attention.mark.create'
            AND idempotency_key = 'corrupt-replay'`,
      ).run();
    } finally {
      opened.db.close();
    }

    const replay = await requestJson(server, "/v1/marks", {
      method: "POST",
      token: CONSUMER_TOKEN,
      body,
    });
    expect(replay.response.status).toBe(503);
    expect(replay.body).toMatchObject({
      error: { code: "activity_marks_schema_unavailable", retryable: true },
    });
    expect(server.resolver).toHaveBeenCalledTimes(1);
  });

  test("fails closed when authoritative rows contradict their immutable provenance", async () => {
    const server = await harness();
    const created = await requestJson(server, "/v1/marks", {
      method: "POST",
      token: CONSUMER_TOKEN,
      body: createBody("corrupt-positive-projection"),
    });
    expect(created.response.status).toBe(200);

    const opened = await openStateStore(server.state);
    try {
      opened.db.prepare(
        `UPDATE activity_marks
            SET marked_at = '2026-07-21T12:00:01.000Z'
          WHERE mark_id = ?`,
      ).run(String(created.body["mark_id"]));
    } finally {
      opened.db.close();
    }

    const listed = await requestJson(server, "/v1/marks", { token: CONSUMER_TOKEN });
    expect(listed.response.status).toBe(503);
    expect(listed.body).toMatchObject({
      error: { code: "activity_marks_schema_unavailable", retryable: true },
    });
  });

  test("converges concurrent distinct keys to one active row and records each replay authority", async () => {
    const server = await harness();
    const [first, second] = await Promise.all([
      requestJson(server, "/v1/marks", {
        method: "POST",
        token: CONSUMER_TOKEN,
        body: createBody("converge-one", { reason: "first immutable reason" }),
      }),
      requestJson(server, "/v1/marks", {
        method: "POST",
        token: CONSUMER_TOKEN,
        body: createBody("converge-two", { reason: "second ignored reason" }),
      }),
    ]);
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(first.body["mark_id"]).toBe(second.body["mark_id"]);
    expect(new Set([first.body["reason"], second.body["reason"]])).toEqual(new Set(["first immutable reason"]));
    expect(server.resolver).toHaveBeenCalledTimes(2);

    const opened = await openStateStore(server.state);
    try {
      const counts = opened.db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM activity_marks WHERE subject = ? AND revoked_at IS NULL) AS marks,
           (SELECT COUNT(*) FROM api_idempotency
             WHERE subject = ? AND operation_id = 'attention.mark.create') AS receipts`,
      ).get("marks_consumer", "marks_consumer") as { marks: number | bigint; receipts: number | bigint };
      expect(Number(counts.marks)).toBe(1);
      expect(Number(counts.receipts)).toBe(2);
    } finally {
      opened.db.close();
    }
  });

  test("lets a concurrent same-key commit win over the first request's captured target failure", async () => {
    const server = await harness();
    let releaseFirst!: () => void;
    let announceFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      announceFirst = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    server.resolver
      .mockImplementationOnce(async () => {
        announceFirst();
        await firstRelease;
        throw new ActivityMarkTargetNotFoundError();
      })
      .mockImplementationOnce(async ({ targetKind, targetId }) => ({
        target_kind: targetKind,
        target_id: targetId,
        activity_id: targetId,
      }));
    const body = createBody("two-phase-race");
    const firstRequest = requestJson(server, "/v1/marks", {
      method: "POST",
      token: CONSUMER_TOKEN,
      body,
    });
    await firstEntered;
    const concurrent = await requestJson(server, "/v1/marks", {
      method: "POST",
      token: CONSUMER_TOKEN,
      body,
    });
    expect(concurrent.response.status).toBe(200);
    releaseFirst();
    const first = await firstRequest;
    expect(first.response.status).toBe(200);
    expect(first.body).toEqual(concurrent.body);
    expect(server.resolver).toHaveBeenCalledTimes(2);
  });

  test("maps target/state failures without leaks and rejects DELETE bodies as invalid requests", async () => {
    const server = await harness();
    const missingIds = [
      `${ACTIVITY_ID}:missing`,
      `${ACTIVITY_ID}:hidden`,
      "run::bad",
      "codex:carbon:019f9000-1111-7222-8333-abcabcabcabc",
      `${ACTIVITY_ID}:msg:01`,
    ];
    for (const [index, targetId] of missingIds.entries()) {
      const miss = await requestJson(server, "/v1/marks", {
        method: "POST",
        token: CONSUMER_TOKEN,
        body: createBody(`missing-${index}`, {
          target_kind: targetId.endsWith(":msg:01") ? "message" : "activity",
          target_id: targetId,
        }),
      });
      expect(miss.response.status).toBe(404);
      expect(miss.body).toMatchObject({ error: { code: "mark_target_unknown" } });
      expect(JSON.stringify(miss.body)).not.toContain(targetId);
    }

    const ambiguousId = `${ACTIVITY_ID}:duplicate`;
    const ambiguous = await requestJson(server, "/v1/marks", {
      method: "POST",
      token: CONSUMER_TOKEN,
      body: createBody("duplicate", { target_id: ambiguousId }),
    });
    expect(ambiguous.response.status).toBe(409);
    expect(ambiguous.body).toMatchObject({ error: { code: "mark_target_ambiguous" } });
    expect(JSON.stringify(ambiguous.body)).not.toContain(ambiguousId);

    const unavailableId = `${ACTIVITY_ID}:unavailable`;
    const unavailable = await requestJson(server, "/v1/marks", {
      method: "POST",
      token: CONSUMER_TOKEN,
      body: createBody("unavailable", { target_id: unavailableId }),
    });
    expect(unavailable.response.status).toBe(503);
    expect(unavailable.body).toMatchObject({
      error: { code: "mark_target_unavailable", retryable: true },
    });
    expect(JSON.stringify(unavailable.body)).not.toContain(unavailableId);
    expect(JSON.stringify(unavailable.body)).not.toContain("/secret/transcript.jsonl");

    const programmerErrorId = `${ACTIVITY_ID}:programmer-error`;
    const programmerError = await requestJson(server, "/v1/marks", {
      method: "POST",
      token: CONSUMER_TOKEN,
      body: createBody("programmer-error", { target_id: programmerErrorId }),
    });
    expect(programmerError.response.status).toBe(500);
    expect(programmerError.body).toMatchObject({ error: { code: "internal_error" } });
    expect(JSON.stringify(programmerError.body)).not.toContain(programmerErrorId);
    expect(JSON.stringify(programmerError.body)).not.toContain("/secret/transcript.jsonl");

    const created = await requestJson(server, "/v1/marks", {
      method: "POST",
      token: CONSUMER_TOKEN,
      body: createBody("bodyless-delete"),
    });
    const markId = String(created.body["mark_id"]);
    const bodyRejected = await requestJson(server, `/v1/marks/${encodeURIComponent(markId)}`, {
      method: "DELETE",
      token: CONSUMER_TOKEN,
      contentType: "text/plain",
      body: "must not be accepted",
    });
    expect(bodyRejected.response.status).toBe(400);
    expect(bodyRejected.body).toMatchObject({ error: { code: "invalid_request" } });
    expect(bodyRejected.body).not.toMatchObject({ error: { code: "unsupported_media_type" } });

    const ownerForbidden = await requestJson(server, `/v1/marks/${encodeURIComponent(markId)}`, {
      method: "DELETE",
      token: CONTROL_TOKEN,
    });
    expect(ownerForbidden.response.status).toBe(403);
    expect(ownerForbidden.body).toMatchObject({ error: { code: "mark_owner_forbidden" } });

    const malformed = await requestJson(server, "/v1/marks/not-a-mark", {
      method: "DELETE",
      token: CONSUMER_TOKEN,
    });
    expect(malformed.response.status).toBe(400);
    expect(malformed.body).toMatchObject({ error: { code: "invalid_request" } });

    const invalidCursor = await requestJson(server, "/v1/marks?cursor=not-a-cursor", {
      token: CONSUMER_TOKEN,
    });
    expect(invalidCursor.response.status).toBe(400);
    expect(invalidCursor.body).toMatchObject({
      error: {
        code: "invalid_request",
        hint: "Restart the list without a cursor after correcting the filters.",
      },
    });

    const opened = await openStateStore(server.state);
    try {
      const failedReceipts = opened.db.prepare(
        `SELECT COUNT(*) AS count FROM api_idempotency
          WHERE subject = 'marks_consumer' AND operation_id = 'attention.mark.create'
            AND (idempotency_key LIKE 'missing-%'
              OR idempotency_key IN ('duplicate', 'unavailable', 'programmer-error'))`,
      ).get() as { count: number | bigint };
      expect(Number(failedReceipts.count)).toBe(0);
    } finally {
      opened.db.close();
    }
  });
});
