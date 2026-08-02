import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";
import {
  CALYX_ACTIVITY_ATTACHMENT_MAX_BYTES,
  CALYX_ADMIN_RUN_LIST_RESPONSE_MAX_BYTES,
  CALYX_HTTP_DEFAULT_JSON_RESPONSE_MAX_BYTES,
  CALYX_HTTP_SSE_MAX_FRAME_BYTES,
  HTTP_OPERATION_DESCRIPTORS,
} from "@polli-labs/calyx-core";
import Ajv2020 from "ajv/dist/2020.js";

import { CALYX_BEARER_TOKEN_CONTRACT } from "../bearer-contract.js";
import {
  CONSUMER_ACTIVITY_ATTENTION_STATES,
  CONSUMER_ACTIVITY_MESSAGE_EXCERPT_MAX_CHARS,
  CONSUMER_ACTIVITY_REPO_REF_MAX_CHARS,
  CONSUMER_ACTIVITY_WORKTREE_REF_MAX_CHARS,
} from "../consumer-dtos.js";
import {
  generateCalyxOpenApi,
  intersectStringWireEnvelope,
  renderCalyxOpenApi,
  schemaKey,
} from "../openapi.js";
import {
  CALYX_SCHEMA_REGISTRY,
  EXPLICIT_OPEN_JSON_DICTIONARY_NAMES,
  validateOperationRequest,
  validateOperationResponse,
  validateOperationSuccessResponse,
  validateOperationSuccessResponseForConsumer,
  validateSchema,
} from "../operations.js";

describe("Calyx OpenAPI emission", () => {
  test("publishes the exact receiver-owned bearer wire contract", () => {
    const document = generateCalyxOpenApi() as Record<string, unknown>;
    expect(document["x-calyx-bearer-token-contract"]).toEqual(CALYX_BEARER_TOKEN_CONTRACT);
    expect(document["x-calyx-bearer-token-contract"]).toEqual({
      encoding: "ascii",
      max_bytes: 4_096,
      pattern: "^[\\x21-\\x2B\\x2D-\\x7E]+$",
    });
  });

  test("preserves JSON Schema search semantics when intersecting string wire envelopes", () => {
    const schema = intersectStringWireEnvelope(
      { type: "string", pattern: "foo" },
      "^[\\x21-\\x7E]+$",
      1024,
    );
    const pattern = schema["pattern"];
    expect(pattern).toBe("(?=[\\s\\S]*(?:foo))^[\\x21-\\x7E]+$");
    if (typeof pattern !== "string") throw new Error("fixture did not emit a string pattern");
    const validator = new RegExp(pattern, "u");
    expect(validator.test("xfoo")).toBe(true);
    expect(validator.test("xbar")).toBe(false);
  });

  test("is a deterministic projection of every operation descriptor", () => {
    const first = renderCalyxOpenApi();
    const second = renderCalyxOpenApi();
    expect(second).toBe(first);

    const document = generateCalyxOpenApi() as {
      paths: Record<string, Record<string, {
        operationId: string;
        tags: string[];
        "x-calyx-profile": string;
        "x-calyx-capability": string;
        "x-calyx-domain": string;
        "x-calyx-store-regime": string;
        "x-calyx-client-surfaces": readonly ("consumer" | "admin")[];
        "x-calyx-client-omission"?: {
          reason: "predecessor" | "decay" | "staged";
          issue: string;
          expires_on?: string;
        };
        "x-calyx-retry-authority"?: { kind: "request_body_field"; field: string };
      }>>;
    };
    const emitted = Object.values(document.paths).flatMap((path) => Object.values(path));
    expect(emitted).toHaveLength(HTTP_OPERATION_DESCRIPTORS.length);

    for (const operation of HTTP_OPERATION_DESCRIPTORS) {
      expect(document.paths[operation.path]?.[operation.method.toLowerCase()]).toMatchObject({
        operationId: operation.operation_id,
        tags: [operation.profile],
        "x-calyx-profile": operation.profile,
        "x-calyx-capability": operation.capability,
        "x-calyx-domain": operation.domain,
        "x-calyx-effects": operation.effects,
        "x-calyx-store-regime": operation.store_regime,
        "x-calyx-client-surfaces": operation.client_surfaces,
        ...(operation.client_omission
          ? { "x-calyx-client-omission": operation.client_omission }
          : {}),
        ...(operation.retry_authority
          ? { "x-calyx-retry-authority": operation.retry_authority }
          : {}),
      });
      expect(document.paths[operation.path]?.[operation.method.toLowerCase()]).not.toHaveProperty(
        "x-calyx-client-projected",
      );
      for (const success of operation.successes) {
        if (success.representation === "json" || success.representation === "bytes") {
          expect(success.max_bytes, operation.operation_id).toBeGreaterThan(0);
        }
        if (success.representation === "sse") {
          expect(success.max_frame_bytes, operation.operation_id).toBeGreaterThan(0);
        }
      }
    }
    expect(HTTP_OPERATION_DESCRIPTORS.find((operation) => operation.operation_id === "admin.health")
      ?.successes[0]?.max_bytes).toBe(CALYX_HTTP_DEFAULT_JSON_RESPONSE_MAX_BYTES);
    expect(HTTP_OPERATION_DESCRIPTORS.find((operation) => operation.operation_id === "admin.run.list")
      ?.successes[0]?.max_bytes).toBe(CALYX_ADMIN_RUN_LIST_RESPONSE_MAX_BYTES);
    expect(HTTP_OPERATION_DESCRIPTORS.find((operation) => operation.operation_id === "admin.events")
      ?.successes[0]?.max_frame_bytes).toBe(CALYX_HTTP_SSE_MAX_FRAME_BYTES);
  });

  test("publishes executable request-target, integer, and string-format wire laws", () => {
    const document = generateCalyxOpenApi() as Record<string, unknown>;
    expect(document["x-calyx-request-target-max-bytes"]).toBe(8000);
    let integerCount = 0;
    let integralNumberLiteralCount = 0;
    let dateTimeCount = 0;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (node["type"] === "integer") {
        integerCount += 1;
        expect(Number.isSafeInteger(node["minimum"])).toBe(true);
        expect(Number.isSafeInteger(node["maximum"])).toBe(true);
        expect(node["minimum"] as number).toBeGreaterThanOrEqual(Number.MIN_SAFE_INTEGER);
        expect(node["maximum"] as number).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
        expect(node["minimum"] as number).toBeLessThanOrEqual(node["maximum"] as number);
      }
      const numericLiterals = Object.hasOwn(node, "const")
        ? [node["const"]]
        : Array.isArray(node["enum"])
          ? node["enum"]
          : [];
      if (
        node["type"] === "number"
        && numericLiterals.length > 0
        && numericLiterals.every((literal) => typeof literal === "number" && Number.isSafeInteger(literal))
      ) integralNumberLiteralCount += 1;
      if (node["format"] !== undefined) {
        expect(["binary", "date-time", "uri"]).toContain(node["format"]);
      }
      if (node["format"] === "date-time") {
        dateTimeCount += 1;
        expect(typeof node["pattern"]).toBe("string");
        const pattern = new RegExp(node["pattern"] as string, "u");
        expect(pattern.test("2024-02-29T23:59Z")).toBe(true);
        expect(pattern.test("2026-07-14T00:00:00.123Z")).toBe(true);
        expect(pattern.test("2026-02-29T00:00:00Z")).toBe(false);
        expect(pattern.test("2026-07-14T00:00:00+00:00")).toBe(false);
      }
      Object.values(node).forEach(visit);
    };
    visit(document);
    expect(integerCount).toBeGreaterThan(300);
    expect(integralNumberLiteralCount).toBe(0);
    expect(dateTimeCount).toBeGreaterThan(200);
  });

  test("emits only executable retry and attachment custody authority", () => {
    const document = generateCalyxOpenApi() as {
      paths: Record<string, Record<string, Record<string, any>>>;
    };
    const retryable = [
      document.paths["/v1/marks"]?.["post"],
      document.paths["/v1/messages/send"]?.["post"],
      document.paths["/v1/admin/runs"]?.["post"],
      document.paths["/v1/admin/monitors"]?.["post"],
      document.paths["/v1/admin/monitors/wakes"]?.["post"],
      document.paths["/v1/admin/leases/acquire"]?.["post"],
      document.paths["/v1/admin/leases/release"]?.["post"],
      document.paths["/v1/admin/leases/renew"]?.["post"],
      document.paths["/v1/admin/leases/steal"]?.["post"],
    ];
    expect(retryable).toHaveLength(9);
    for (const operation of retryable) {
      expect(operation?.["x-calyx-retry-authority"]).toEqual({
        kind: "request_body_field",
        field: "idempotency_key",
      });
    }
    expect(document.paths["/v1/activity"]?.["get"]).not.toHaveProperty("x-calyx-retry-authority");
    expect(document.paths["/v1/admin/monitors/wakes/{wakeId}/ack"]?.["post"])
      .not.toHaveProperty("x-calyx-retry-authority");

    const revoke = document.paths["/v1/marks/{markId}"]?.["delete"];
    expect(revoke).toMatchObject({
      operationId: "attention.mark.revoke",
      "x-calyx-capability": "attention.mark",
      "x-calyx-client-surfaces": ["consumer", "admin"],
      "x-calyx-request-transport": { body: "none" },
      "x-calyx-retry-authority": { kind: "request_target_identity" },
      parameters: [expect.objectContaining({
        name: "markId",
        in: "path",
        required: true,
        schema: expect.objectContaining({
          minLength: 41,
          maxLength: 41,
          pattern: expect.stringContaining("mark_"),
        }),
      }), expect.objectContaining({ name: "X-Calyx-Asserted-Actor", in: "header", required: false })],
    });
    expect(revoke).not.toHaveProperty("requestBody");
    expect(revoke?.responses?.["413"]).toBeUndefined();
    expect(revoke?.responses?.["415"]).toBeUndefined();

    const bytes = document.paths["/v1/admin/activity/{activityId}/attachments/{ref}/bytes"]?.["get"];
    expect(bytes?.responses?.["200"]?.["x-calyx-custody-contract"]).toEqual({
      schema_version: "calyx.attachment-custody/v1",
      kind: "content_addressed_attachment",
      requested_ref: { in: "path", name: "ref" },
      bindings: [
        {
          source: "request.path.ref",
          target: "response.header.x-calyx-attachment-ref",
          relation: "equals",
        },
        {
          source: "response.header.x-calyx-attachment-ref",
          target: "response.header.etag",
          relation: "sha256_etag",
        },
        {
          source: "response.header.x-calyx-attachment-ref",
          target: "response.header.digest",
          relation: "sha256_base64",
        },
        {
          source: "response.body",
          target: "response.header.digest",
          relation: "sha256_base64",
        },
      ],
    });
    expect(bytes?.responses?.["200"]?.headers).toEqual(expect.objectContaining({
      "content-length": expect.objectContaining({ required: true }),
      "content-type": expect.objectContaining({ required: true }),
      digest: expect.objectContaining({ required: true }),
      etag: expect.objectContaining({ required: true }),
      "x-calyx-attachment-ref": expect.objectContaining({ required: true }),
      "x-calyx-source-tier": expect.objectContaining({ required: true }),
      "x-calyx-origin-host": expect.objectContaining({ required: false }),
      "x-calyx-served-by-host": expect.objectContaining({ required: false }),
    }));
  });

  test("publishes closed mark creation and positive mutation-stable mark DTOs", () => {
    const create = {
      schema_version: "calyx.activity-mark-create-request/v1",
      idempotency_key: "switchboard-mark-1",
      target_kind: "message",
      target_id: "interactive:codex:session-1:msg:42",
      kind: "high_signal",
      reason: "Decision boundary.",
    };
    expect(validateOperationRequest("attention.mark.create", create)).toEqual(create);
    expect(validateOperationRequest("attention.mark.create", {
      ...create,
      future_field: true,
    })).toEqual(create);
    expect(validateOperationRequest("attention.mark.create", {
      ...create,
      target_kind: "turn",
    })).toEqual({
      ...create,
      target_kind: "turn",
    });

    expect(validateOperationRequest("attention.mark.list", { target_kind: "message" }))
      .toEqual({ target_kind: "message" });
    expect(validateOperationRequest("attention.mark.list", { target_id: create.target_id }))
      .toEqual({ target_id: create.target_id });
    expect(() => validateOperationRequest("attention.mark.list", {
      target_kind: "turn",
      target_id: create.target_id,
    })).toThrow();

    const provenance = {
      schema_version: "calyx.provenance/v1",
      request_id: "req_123e4567-e89b-42d3-a456-426614174000",
      subject: "client:switchboard",
      asserted_actor: "operator:caleb",
      host: "blade",
      via: "http",
      at: "2026-07-21T00:00:00.000Z",
    };
    const mark = {
      schema_version: "calyx.activity-mark/v1",
      mark_id: "mark_123e4567-e89b-42d3-a456-426614174000",
      marked_by: "client:switchboard",
      target_kind: create.target_kind,
      target_id: create.target_id,
      kind: create.kind,
      reason: create.reason,
      marked_at: provenance.at,
      created_provenance: provenance,
    };
    expect(validateOperationResponse("attention.mark.create", mark)).toEqual(mark);
    expect(() => validateOperationResponse("attention.mark.create", {
      ...mark,
      marked_at: "not-a-time",
    })).toThrow();
    expect(() => validateOperationResponse("attention.mark.create", {
      ...mark,
      marked_revision: 1,
    })).toThrow();
    expect(validateOperationResponse("attention.mark.revoke", {
      ...mark,
      schema_version: "calyx.activity-mark-revocation/v1",
      revoked_at: "2026-07-21T00:01:00.000Z",
      revoked_provenance: { ...provenance, at: "2026-07-21T00:01:00.000Z" },
    })).toBeDefined();
    expect(validateOperationResponse("attention.mark.list", {
      schema_version: "calyx.activity-mark-list/v1",
      snapshot_at: "2026-07-21T00:02:00.000Z",
      truncated: false,
      marks: [mark],
    })).toBeDefined();
    expect(() => validateOperationResponse("attention.mark.list", {
      schema_version: "calyx.activity-mark-list/v1",
      snapshot_at: "2026-07-21T00:02:00.000Z",
      truncated: false,
      next_cursor: "forbidden",
      marks: [mark],
    })).toThrow();

    const document = generateCalyxOpenApi() as any;
    for (const timestamp of [
      document.components.schemas.calyx_activity_mark_v1.properties.marked_at,
      document.components.schemas.calyx_activity_mark_v1.properties.created_provenance.properties.at,
      document.components.schemas.calyx_activity_mark_revocation_v1.properties.revoked_at,
      document.components.schemas.calyx_activity_mark_list_v1.anyOf[0].properties.snapshot_at,
    ]) {
      expect(timestamp).toMatchObject({ type: "string", format: "date-time", maxLength: 64 });
      expect(timestamp.pattern).toBeTypeOf("string");
      expect(new RegExp(timestamp.pattern, "u").test("not-a-time")).toBe(false);
    }
    expect(document.components.schemas.calyx_activity_mark_v1["x-calyx-cross-field-contract"])
      .toMatchObject({
        activity_mark_authority: {
          equalities: [
            { left: "marked_by", right: "created_provenance.subject" },
            { left: "marked_at", right: "created_provenance.at" },
          ],
          target_identity: {
            kind_field: "target_kind",
            id_field: "target_id",
            source_line_maximum: Number.MAX_SAFE_INTEGER,
            suffix_by_kind: { turn: ":turn:", message: ":msg:" },
          },
        },
      });
    expect(document.components.schemas.calyx_activity_mark_revocation_v1["x-calyx-cross-field-contract"]
      .activity_mark_authority.equalities).toContainEqual({
        left: "revoked_at",
        right: "revoked_provenance.at",
      });
  });

  test("publishes stable app capabilities independently of CLI sibling names", () => {
    const document = generateCalyxOpenApi() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(document.paths["/v1/admin/runs/{runId}/logs"]?.["get"]).toMatchObject({
      "x-calyx-capability": "work.observe",
    });
    expect(document.paths["/v1/admin/runs/{runId}/observation"]?.["get"]).toMatchObject({
      "x-calyx-capability": "work.observe",
    });
    expect(document.paths["/v1/admin/runs/{runId}/stop"]?.["post"]).toMatchObject({
      "x-calyx-capability": "run.stop",
    });
    expect(document.paths["/v1/admin/runs/reconcile-preserving/v1"]?.["post"]).toMatchObject({
      "x-calyx-capability": "run.reconcile",
    });
    expect(document.paths["/v1/admin/activity/{activityId}"]?.["get"]).toMatchObject({
      "x-calyx-capability": "activity.show",
    });
    expect(document.paths["/v1/admin/activity/{activityId}/turns"]?.["get"]).toMatchObject({
      "x-calyx-capability": "activity.turns",
    });
    expect(document.paths["/v1/admin/health"]?.["get"]).toMatchObject({
      "x-calyx-capability": "daemon.health",
      "x-calyx-effects": {
        kind: "uniform",
        effects: {
          local_files: "read",
          local_state: "read_write",
          process_launch: true,
        },
      },
    });
    expect(document.paths["/v1/internal/metrics"]?.["get"]).toMatchObject({
      "x-calyx-capability": "daemon.metrics",
      "x-calyx-effects": {
        kind: "uniform",
        effects: {
          local_files: "read_write",
          local_state: "read_write",
          process_launch: false,
        },
      },
    });
  });

  test("preserves branch-specific message submission effects", () => {
    const document = generateCalyxOpenApi() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const send = document.paths["/v1/messages/send"]?.["post"] as {
      responses?: Record<string, Record<string, unknown>>;
    } | undefined;
    expect(send?.responses?.["200"]?.["x-calyx-effects"]).toMatchObject({
      local_state: "read_write",
      remote_provider: "none",
    });
    expect(send?.responses?.["202"]?.["x-calyx-effects"]).toMatchObject({
      local_state: "read_write",
      remote_provider: "write_without_dry_run",
    });
  });

  test("does not fabricate error-effect certainty", () => {
    const document = generateCalyxOpenApi() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const send = document.paths["/v1/messages/send"]?.["post"] as {
      responses?: Record<string, Record<string, unknown>>;
      "x-calyx-effects"?: unknown;
    } | undefined;
    expect(send?.["x-calyx-effects"]).toMatchObject({ kind: "by_success" });
    expect(send?.responses?.["409"]).not.toHaveProperty("x-calyx-effects");
  });

  test("declares both query-validation and replay-cursor failures for admin event streams", () => {
    const document = generateCalyxOpenApi() as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    };
    const response = document.paths["/v1/admin/events/stream"]?.["get"]?.responses?.["400"];
    expect(response).toMatchObject({
      "x-calyx-error-codes": expect.arrayContaining(["invalid_request", "invalid_event_cursor"]),
    });
  });

  test("contains no deleted route family", () => {
    const paths = Object.keys((generateCalyxOpenApi() as { paths: Record<string, unknown> }).paths);
    expect(paths.every((path) => path.startsWith("/v1/"))).toBe(true);
    expect(paths).not.toContain("/v1/messages");
    expect(paths).not.toContain("/runs");
    expect(paths).not.toContain("/events/stream");
    expect(paths).not.toContain("/activity/{activityId}");
    expect(paths).not.toContain("/local-backends/runtime-config/plan");
  });

  test("publishes the required run-launch Accept contract for thin transports", () => {
    const document = generateCalyxOpenApi() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const launch = document.paths["/v1/admin/runs"]?.["post"];
    expect(launch?.["x-calyx-request-accept"]).toBe(
      "application/vnd.polli.calyx.run-launch-receipt+json;version=1",
    );
    expect(launch?.["parameters"]).not.toContainEqual(
      expect.objectContaining({ name: "Accept", in: "header" }),
    );
  });

  test("publishes recoverable nested message bounds for consumer turns", () => {
    const document = generateCalyxOpenApi() as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    type JsonSchema = {
      anyOf?: JsonSchema[];
      enum?: unknown[];
      items?: JsonSchema;
      properties?: Record<string, JsonSchema>;
      required?: string[];
      [key: string]: unknown;
    };
    const turns = document.components.schemas[schemaKey("activity.turns/v1")] as JsonSchema;
    expect(turns.anyOf).toHaveLength(2);
    const completePage = turns.anyOf?.find((branch) => branch.properties?.["truncated"]?.enum?.includes(false));
    const truncatedPage = turns.anyOf?.find((branch) => branch.properties?.["truncated"]?.enum?.includes(true));
    expect(completePage?.required).not.toContain("next_cursor");
    expect(completePage?.properties).not.toHaveProperty("next_cursor");
    expect(truncatedPage?.required).toContain("next_cursor");
    expect(truncatedPage?.properties?.["next_cursor"]).toMatchObject({ type: "string", minLength: 1 });
    expect(completePage?.properties).not.toHaveProperty("returned_turns");
    expect(truncatedPage?.properties).not.toHaveProperty("returned_turns");

    const turn = completePage?.properties?.["turns"]?.items;
    expect(turn?.anyOf).toHaveLength(2);
    const complete = turn?.anyOf?.find((branch) => branch.properties?.["messages_truncated"]?.enum?.includes(false));
    const truncated = turn?.anyOf?.find((branch) => branch.properties?.["messages_truncated"]?.enum?.includes(true));
    expect(complete?.required).toEqual(expect.arrayContaining(["messages_truncated", "messages"]));
    expect(complete?.required).not.toContain("messages_recovery");
    expect(complete?.required).not.toContain("omitted_message_count");
    expect(complete?.properties).not.toHaveProperty("messages_recovery");
    expect(complete?.properties).not.toHaveProperty("omitted_message_count");
    expect(complete?.properties).not.toHaveProperty("activity_id");
    expect(truncated?.required).toEqual(expect.arrayContaining([
      "messages_truncated",
      "omitted_message_count",
      "messages_recovery",
      "messages",
    ]));
    expect(truncated?.properties?.["messages"]).toMatchObject({ type: "array", maxItems: 100 });
    expect(truncated?.properties?.["messages"]?.items?.properties).not.toHaveProperty("activity_id");
    expect(truncated?.properties?.["messages"]?.items?.properties).not.toHaveProperty("turn_id");
    expect(truncated?.properties?.["omitted_message_count"]).toMatchObject({
      type: "integer",
      minimum: 1,
    });
    expect(truncated?.properties?.["messages_recovery"]).toMatchObject({
      type: "object",
      required: ["operation_id"],
      "x-calyx-unknown-field-policy": "preserve",
      properties: {
        operation_id: { type: "string", enum: ["activity.messages"] },
      },
    });

    const activityId = "interactive:codex:session-bounded";
    const message = {
      id: "msg-1",
      role: "assistant",
      summary: "Assistant message.",
      truncated: false,
    };
    const commonTurn = {
      turn_id: "turn-1",
      index: 0,
      role: "assistant",
      state: "complete",
      summary: "Assistant turn is complete.",
      messages: [message],
    };
    const commonPage = {
      schema_version: "activity.turns/v1",
      activity_id: activityId,
      backend: "codex",
      session_id: "session-bounded",
      total_turns: 1,
      matched_turns: 1,
      turns: [{ ...commonTurn, messages_truncated: false }],
    };
    const validateTurns = new Ajv2020({ strict: false, validateFormats: false }).compile(turns);
    expect(validateTurns({ ...commonPage, truncated: false })).toBe(true);
    expect(validateTurns({ ...commonPage, truncated: true, next_cursor: "next-turn" })).toBe(true);
    expect(validateTurns({ ...commonPage, truncated: true })).toBe(false);
    expect(validateTurns({ ...commonPage, truncated: false, next_cursor: "dishonest-cursor" })).toBe(false);
    expect(validateTurns({ ...commonPage, truncated: false, returned_turns: 99 })).toBe(true);
    expect(validateTurns({
      ...commonPage,
      truncated: false,
      turns: [{
        ...commonTurn,
        messages_truncated: false,
        omitted_message_count: 1,
        messages_recovery: { operation_id: "activity.messages" },
      }],
    })).toBe(false);
    expect(validateTurns({
      ...commonPage,
      truncated: false,
      turns: [{ ...commonTurn, messages_truncated: false, future_turn_field: true }],
    })).toBe(true);
    expect(validateTurns({
      ...commonPage,
      truncated: false,
      turns: [{ ...commonTurn, activity_id: activityId, messages_truncated: false }],
    })).toBe(true);
    expect(validateTurns({
      ...commonPage,
      truncated: false,
      turns: [{
        ...commonTurn,
        messages: [{ ...message, activity_id: activityId, turn_id: "turn-1" }],
        messages_truncated: false,
      }],
    })).toBe(true);
    expect(validateTurns({
      ...commonPage,
      truncated: false,
      turns: [{
        ...commonTurn,
        messages_truncated: true,
        omitted_message_count: 1,
        messages_recovery: { operation_id: "activity.messages" },
      }],
    })).toBe(true);
    expect(validateTurns({
      ...commonPage,
      truncated: false,
      turns: [{ ...commonTurn, messages_truncated: true, omitted_message_count: 1 }],
    })).toBe(false);
    expect(validateTurns({
      ...commonPage,
      truncated: false,
      turns: [{
        ...commonTurn,
        messages_truncated: true,
        omitted_message_count: 0,
        messages_recovery: { operation_id: "activity.messages" },
      }],
    })).toBe(false);
    expect(validateTurns({
      ...commonPage,
      truncated: false,
      turns: [{
        ...commonTurn,
        messages_truncated: true,
        omitted_message_count: 1,
        messages_recovery: { operation_id: "activity.turns" },
      }],
    })).toBe(false);
    expect(validateTurns({
      ...commonPage,
      truncated: false,
      turns: [{
        ...commonTurn,
        messages_truncated: true,
        omitted_message_count: 1,
        messages_recovery: { operation_id: "activity.messages" },
        messages_route: `/v1/activity/${encodeURIComponent(activityId)}/messages`,
      }],
    })).toBe(true);

    const messages = document.components.schemas[schemaKey("activity.messages/v1")] as JsonSchema;
    expect(messages.anyOf).toHaveLength(2);
    expect(messages.anyOf?.every((branch) => branch.properties?.["returned_messages"] === undefined)).toBe(true);
    const validateMessages = new Ajv2020({ strict: false, validateFormats: false }).compile(messages);
    const commonMessagesPage = {
      schema_version: "activity.messages/v1",
      activity_id: activityId,
      backend: "codex",
      session_id: "session-bounded",
      total_messages: 1,
      matched_messages: 1,
      messages: [{ ...message, activity_id: activityId, turn_id: "turn-1" }],
    };
    expect(validateMessages({ ...commonMessagesPage, truncated: false })).toBe(true);
    expect(validateMessages({ ...commonMessagesPage, truncated: true, next_cursor: "next-message" })).toBe(true);
    expect(validateMessages({ ...commonMessagesPage, truncated: true })).toBe(false);
    expect(validateMessages({ ...commonMessagesPage, truncated: false, next_cursor: "dishonest-cursor" })).toBe(false);
    expect(validateMessages({ ...commonMessagesPage, truncated: false, returned_messages: 99 })).toBe(true);
  });

  test("publishes exact scalar-string ceilings for consumer observation DTOs", () => {
    const document = generateCalyxOpenApi() as {
      components: { schemas: Record<string, JsonSchema> };
    };
    type JsonSchema = {
      anyOf?: JsonSchema[];
      items?: JsonSchema;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      properties?: Record<string, JsonSchema>;
      "x-calyx-enum-mode"?: string;
      "x-calyx-known-values"?: string[];
    };
    const component = (schemaId: string): JsonSchema => (
      document.components.schemas[schemaKey(schemaId)]!
    );
    const branches = (schema: JsonSchema): JsonSchema[] => schema.anyOf ?? [schema];
    const expectPropertyMaxima = (
      schema: JsonSchema,
      expected: Record<string, number>,
    ): void => {
      for (const branch of branches(schema)) {
        for (const [property, maximum] of Object.entries(expected)) {
          expect(branch.properties?.[property]?.maxLength, property).toBe(maximum);
        }
      }
    };

    const monitor = component("calyx.monitor-observation/v1");
    expectPropertyMaxima(monitor, {
      monitor_id: 1_024,
      preset: 128,
      run_locator: 260,
      created_at: 64,
      updated_at: 64,
    });
    const deliveryBranches = monitor.properties?.["delivery_summary"]?.anyOf ?? [];
    expect(deliveryBranches.filter((branch) => branch.properties?.["last_delivery_at"]))
      .not.toHaveLength(0);
    for (const branch of deliveryBranches.filter((candidate) => candidate.properties?.["last_delivery_at"])) {
      expect(branch.properties?.["last_delivery_at"]?.maxLength).toBe(64);
    }

    const wake = component("calyx.wake-observation/v1");
    expectPropertyMaxima(wake, {
      wake_id: 1_024,
      monitor_id: 1_024,
      run_locator: 260,
      created_at: 64,
    });
    expect(wake.properties?.["receipt_locator"]?.properties).toMatchObject({
      host: { maxLength: 255 },
      route: { maxLength: 4_096 },
    });

    const messages = component("activity.messages/v1");
    expectPropertyMaxima(messages, {
      activity_id: 1_024,
      backend: 64,
      session_id: 1_024,
      host: 255,
    });
    const truncatedMessages = branches(messages).find((branch) => branch.properties?.["next_cursor"]);
    expect(truncatedMessages?.properties?.["next_cursor"]?.maxLength).toBe(4_096);
    for (const branch of branches(messages)) {
      expect(branch.properties?.["messages"]?.items?.properties).toMatchObject({
        id: { maxLength: 1_024 },
        activity_id: { maxLength: 1_024 },
        turn_id: { maxLength: 1_024 },
        timestamp: { maxLength: 64 },
      });
    }

    const turns = component("activity.turns/v1");
    expectPropertyMaxima(turns, {
      activity_id: 1_024,
      backend: 64,
      session_id: 1_024,
      host: 255,
    });
    const truncatedTurns = branches(turns).find((branch) => branch.properties?.["next_cursor"]);
    expect(truncatedTurns?.properties?.["next_cursor"]?.maxLength).toBe(4_096);
    for (const pageBranch of branches(turns)) {
      for (const turnBranch of branches(pageBranch.properties?.["turns"]?.items ?? {})) {
        expect(turnBranch.properties).toMatchObject({
          turn_id: { maxLength: 1_024 },
          started_at: { maxLength: 64 },
          ended_at: { maxLength: 64 },
        });
        expect(turnBranch.properties?.["messages"]?.items?.properties).toMatchObject({
          id: { maxLength: 1_024 },
          timestamp: { maxLength: 64 },
        });
      }
    }

    expectPropertyMaxima(component("activity.text/v1"), {
      activity_id: 1_024,
      backend: 64,
      session_id: 1_024,
      message_id: 1_024,
    });

    const attachments = component("activity.attachments/v1");
    expectPropertyMaxima(attachments, {
      activity_id: 1_024,
      backend: 64,
      session_id: 1_024,
      host: 255,
    });
    const truncatedAttachments = branches(attachments).find((branch) => branch.properties?.["next_cursor"]);
    expect(truncatedAttachments?.properties?.["next_cursor"]?.maxLength).toBe(4_096);
    for (const branch of branches(attachments)) {
      expect(branch.properties?.["attachments"]?.items?.properties).toMatchObject({
        mime_type: { maxLength: 255 },
        activity_id: { maxLength: 1_024 },
        message_id: { maxLength: 1_024 },
        origin_host: { maxLength: 255 },
      });
    }

    expectPropertyMaxima(component("calyx.message-observation/v1"), {
      message_id: 1_024,
      sender: 512,
      recipient_address: 512,
      subject: 500,
      body: 4_000,
      body_locator: 4_096,
      thread_key: 512,
      reply_to: 512,
      expires_at: 64,
      created_at: 64,
      updated_at: 64,
    });
    expectPropertyMaxima(component("calyx.message-text/v1"), {
      message_id: 1_024,
    });
    const messageSend = component("calyx.msg-send-result/v1");
    const outboxSend = branches(messageSend).find((branch) => branch.properties?.["outbox"]);
    expect(outboxSend?.properties?.["operation"]?.properties).toMatchObject({
      locator: { maxLength: 4_096 },
      receipt_locator: { maxLength: 4_096 },
    });
    expect(outboxSend?.properties?.["outbox"]?.properties).toMatchObject({
      outbox_id: { maxLength: 1_024 },
      target_host: { maxLength: 255 },
      created_at: { maxLength: 64 },
      expires_at: { maxLength: 64 },
    });
    for (const branch of branches(component("calyx.message-operation/v1"))) {
      expect(branch.properties).toMatchObject({
        operation_id: { maxLength: 1_024 },
        message_locator: { maxLength: 4_096 },
        target_host: { maxLength: 255 },
        created_at: { maxLength: 64 },
        updated_at: { maxLength: 64 },
      });
    }
    expectPropertyMaxima(component("calyx.message-operation-receipt/v1"), {
      completed_at: 64,
    });
    for (const branch of branches(component("calyx.message-inbox/v1"))) {
      expect(branch.properties?.["subject"]?.maxLength).toBe(500);
    }
    for (const branch of branches(component("calyx.message-thread/v1"))) {
      expect(branch.properties).toMatchObject({
        subject: { maxLength: 500 },
        thread_key: { maxLength: 512 },
      });
    }
    expectPropertyMaxima(component("calyx.message-doctor/v1"), { subject: 500 });

    const attachmentRecord = component("calyx.admin-activity-attachment-record/v1");
    for (const branch of branches(attachmentRecord)) {
      expect(branch.properties?.["source_tier"]).toMatchObject({
        minLength: 1,
        maxLength: 128,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$",
        "x-calyx-enum-mode": "open",
        "x-calyx-known-values": ["local-transcript", "origin-daemon", "blade-archive"],
      });
    }
    expectPropertyMaxima(component("calyx.lease-observation/v1"), {
      owner_host: 255,
      holder_locator: 1_024,
      acquired_at: 64,
      renewed_at: 64,
      expires_at: 64,
    });
  });

  test("publishes the request cursor ceiling on every paged operation", () => {
    const document = generateCalyxOpenApi() as {
      paths: Record<string, Record<string, {
        parameters?: Array<{
          name?: string;
          in?: string;
          schema?: { maxLength?: number };
        }>;
      }>>;
    };
    const cursorParameters = Object.values(document.paths).flatMap((pathItem) => (
      Object.values(pathItem).flatMap((operation) => (
        operation.parameters?.filter((parameter) => (
          parameter.in === "query" && parameter.name === "cursor"
        )) ?? []
      ))
    ));
    expect(cursorParameters.length).toBeGreaterThan(0);
    for (const parameter of cursorParameters) {
      expect(parameter.schema?.maxLength).toBe(4_096);
    }
  });

  test("has a canonical validator and concrete generated component for every descriptor schema", () => {
    const document = generateCalyxOpenApi() as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const schemaIds = new Set(HTTP_OPERATION_DESCRIPTORS.flatMap((operation) => [
      operation.request_schema,
      operation.response_schema,
    ]));
    for (const schemaId of schemaIds) {
      expect(CALYX_SCHEMA_REGISTRY[schemaId], schemaId).toBeDefined();
      const component = document.components.schemas[schemaKey(schemaId)];
      expect(component, schemaId).toBeDefined();
      expect(component).not.toEqual({});
      expect(component).not.toHaveProperty("description", expect.stringContaining("authoritative runtime validator"));
    }
  });

  test("contains no implicit open object and names every explicit JSON metadata dictionary", () => {
    const document = generateCalyxOpenApi() as Record<string, unknown>;
    const permissive: string[] = [];
    const unnamedDictionaries: string[] = [];
    const namedDictionaries = new Set<string>();
    const visit = (value: unknown, pointer: string): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((child, index) => visit(child, `${pointer}/${index}`));
        return;
      }
      const node = value as Record<string, unknown>;
      if (node["additionalProperties"] === true) permissive.push(pointer);
      if (
        node["additionalProperties"]
        && typeof node["additionalProperties"] === "object"
        && !Array.isArray(node["additionalProperties"])
        && Object.keys(node["additionalProperties"] as Record<string, unknown>).length === 0
      ) {
        if (
          node["x-calyx-dictionary-mode"] !== "explicit-json-metadata"
          || typeof node["x-calyx-dictionary-name"] !== "string"
          || node["x-calyx-dictionary-name"] === ""
        ) unnamedDictionaries.push(pointer);
        else namedDictionaries.add(node["x-calyx-dictionary-name"] as string);
      }
      Object.entries(node).forEach(([key, child]) => visit(child, `${pointer}/${key}`));
    };
    visit(document["components"], "#/components");
    expect(permissive).toEqual([]);
    expect(unnamedDictionaries).toEqual([]);
    expect([...namedDictionaries].sort()).toEqual([...EXPLICIT_OPEN_JSON_DICTIONARY_NAMES].sort());

    const consumerSchemaIds = new Set<string>(["calyx.error/v1"]);
    for (const operation of HTTP_OPERATION_DESCRIPTORS.filter((candidate) => candidate.profile === "consumer_v1")) {
      consumerSchemaIds.add(operation.request_schema);
      consumerSchemaIds.add(operation.response_schema);
      operation.successes.forEach((success) => {
        consumerSchemaIds.add(success.schema);
        if (success.request_schema) consumerSchemaIds.add(success.request_schema);
      });
    }
    const consumerDictionaries: string[] = [];
    const collectConsumerDictionaries = (value: unknown, pointer: string): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((child, index) => collectConsumerDictionaries(child, `${pointer}/${index}`));
        return;
      }
      const node = value as Record<string, unknown>;
      if (node["x-calyx-dictionary-mode"] === "explicit-json-metadata") consumerDictionaries.push(pointer);
      Object.entries(node).forEach(([key, child]) => collectConsumerDictionaries(child, `${pointer}/${key}`));
    };
    for (const schemaId of consumerSchemaIds) {
      collectConsumerDictionaries(
        (document["components"] as { schemas: Record<string, unknown> }).schemas[schemaKey(schemaId)],
        `#/components/schemas/${schemaKey(schemaId)}`,
      );
    }
    expect(consumerDictionaries).toEqual([]);
  });

  test("publishes named message and wake observation DTO roots", () => {
    const document = generateCalyxOpenApi() as { components: { schemas: Record<string, unknown> } };
    expect(document.components.schemas[schemaKey("calyx.message-observation/v1")]).toBeDefined();
    expect(document.components.schemas[schemaKey("calyx.wake-observation/v1")]).toBeDefined();
  });

  test("rejects dishonest bounded consumer list metadata", () => {
    const attachments = {
      schema_version: "activity.attachments/v1",
      activity_id: "interactive:codex:bounded",
      backend: "codex",
      session_id: "bounded",
      attachments: [],
      truncated: false,
    };
    expect(validateOperationResponse("activity.attachments", attachments)).toEqual(attachments);
    expect(() => validateOperationResponse("activity.attachments", {
      ...attachments,
      next_cursor: "cursor-without-truncation",
    })).toThrow();
    expect(() => validateOperationResponse("activity.attachments", {
      ...attachments,
      truncated: true,
    })).toThrow();
    expect(() => validateOperationResponse("activity.attachments", {
      ...attachments,
      attachments: [{
        ref: `att:sha256:${"a".repeat(64)}`,
        sha256: "b".repeat(64),
        mime_type: "image/png",
        byte_size: 1,
        exact_bytes_available: true,
        activity_id: attachments.activity_id,
        message_id: "message-1",
      }],
    })).toThrow("attachment ref must encode the exact sha256 digest");

    const inbox = {
      schema_version: "calyx.message-inbox/v1",
      subject: "switchboard",
      count: 0,
      truncated: false,
      messages: [],
    };
    expect(validateOperationResponse("msg.inbox", inbox)).toEqual(inbox);
    expect(() => validateOperationResponse("msg.inbox", { ...inbox, count: 1 })).toThrow();
    expect(() => validateOperationResponse("msg.inbox", { ...inbox, truncated: true })).toThrow();

    const thread = {
      ...inbox,
      schema_version: "calyx.message-thread/v1",
      thread_key: "thread-bounded",
    };
    expect(validateOperationResponse("msg.thread", thread)).toEqual(thread);
    expect(() => validateOperationResponse("msg.thread", {
      ...thread,
      next_cursor: "cursor-without-truncation",
    })).toThrow();
    expect(() => validateOperationResponse("msg.thread", { ...thread, count: 2 })).toThrow();
  });

  test("publishes every generic bounded page as an exact cursor union", () => {
    const document = generateCalyxOpenApi() as {
      components: { schemas: Record<string, {
        anyOf?: Array<{
          properties?: Record<string, { enum?: unknown[] }>;
          required?: string[];
          allOf?: Array<{ not?: { required?: string[]; type?: string } }>;
        }>;
        "x-calyx-pagination-contract"?: {
          items_field: string;
          discriminator_field: string;
          cursor_field: string;
          count_field?: string;
          count_equals?: string;
        };
      }> };
    };
    const boundedSchemaIds = [
      "calyx.run-list/v1",
      "calyx.run-observation-list/v1",
      "calyx.activity-observation-list/v1",
      "activity.attachments/v1",
      "calyx.message-inbox/v1",
      "calyx.message-thread/v1",
      "calyx.monitor-observation-list/v1",
      "calyx.wake-observation-list/v1",
      "calyx.lease-observation-list/v1",
      "calyx.request-audit-list/v1",
    ];

    for (const schemaId of boundedSchemaIds) {
      const schema = document.components.schemas[schemaKey(schemaId)];
      expect(schema?.anyOf, schemaId).toHaveLength(2);
      const complete = schema?.anyOf?.find((branch) => (
        branch.properties?.["truncated"]?.enum?.includes(false)
      ));
      const truncated = schema?.anyOf?.find((branch) => (
        branch.properties?.["truncated"]?.enum?.includes(true)
      ));
      expect(complete?.required, schemaId).not.toContain("next_cursor");
      expect(complete?.properties, schemaId).not.toHaveProperty("next_cursor");
      expect(truncated?.required, schemaId).toContain("next_cursor");
      for (const branch of schema?.anyOf ?? []) {
        for (const exclusion of branch.allOf ?? []) {
          if (exclusion.not?.required) {
            expect(exclusion.not, schemaId).toMatchObject({ type: "object" });
          }
        }
      }
      const contract = schema?.["x-calyx-pagination-contract"];
      expect(contract, schemaId).toMatchObject({
        discriminator_field: "truncated",
        cursor_field: "next_cursor",
      });
      if (schemaId === "activity.attachments/v1") {
        expect(contract, schemaId).not.toHaveProperty("count_field");
      } else {
        expect(contract, schemaId).toMatchObject({
          count_field: "count",
          count_equals: `${contract?.items_field}.length`,
        });
      }
    }

    const inboxSchema = document.components.schemas[schemaKey("calyx.message-inbox/v1")]!;
    const validateInbox = new Ajv2020({
      strict: false,
      validateFormats: false,
      unicodeRegExp: false,
    }).compile(inboxSchema);
    const page = {
      schema_version: "calyx.message-inbox/v1",
      subject: "switchboard",
      count: 0,
      messages: [],
    };
    expect(validateInbox({ ...page, truncated: false })).toBe(true);
    expect(validateInbox({ ...page, truncated: true, next_cursor: "next" })).toBe(true);
    expect(validateInbox({ ...page, truncated: true })).toBe(false);
    expect(validateInbox({ ...page, truncated: false, next_cursor: "dishonest" })).toBe(false);
  });

  test("distinguishes current bound host receipts from bare-1.0 predecessors", () => {
    const schema = CALYX_SCHEMA_REGISTRY["calyx.run-receipt/v1"]!;
    const base = {
      kernel: "host_process",
      run_id: "run-host-receipt-version",
      state: "succeeded",
      timing: {
        created_at: "2026-07-14T17:00:00.000Z",
        completed_at: "2026-07-14T17:00:01.000Z",
        duration_ms: 1_000,
      },
      exit: { exit_code: 0 },
      log_summary: { total: 0, info: 0, warn: 0, error: 0 },
      process: {
        argv: ["node", "worker.js"],
        cwd: "/work",
        env_keys: [],
        stop_grace_ms: 5_000,
        stop_requested: false,
      },
      summary: "Host process succeeded.",
    };
    const executionBinding = {
      schema_version: "calyx.host-process-execution-binding/v1",
      execution_id: "exec-host-receipt-version",
      salt: "s".repeat(43),
      commitment_sha256: "a".repeat(64),
    };

    expect(schema.safeParse({
      ...base,
      schema_version: "calyx.host-process-receipt/v1",
      execution_binding: executionBinding,
    }).success).toBe(true);
    expect(schema.safeParse({ ...base, schema_version: "1.0" }).success).toBe(true);
    expect(schema.safeParse({
      ...base,
      schema_version: "1.0",
      execution_binding: executionBinding,
    }).success).toBe(false);
    expect(schema.safeParse({
      ...base,
      schema_version: "calyx.host-process-receipt/v1",
    }).success).toBe(false);
    expect(schema.safeParse({
      ...base,
      schema_version: "calyx.host-process-receipt/v1",
      execution_binding: executionBinding,
      process: { ...base.process, argv: [] },
    }).success).toBe(false);
    expect(schema.safeParse({
      ...base,
      schema_version: "calyx.host-process-receipt/v1",
      execution_binding: executionBinding,
      process: { ...base.process, argv: [""] },
    }).success).toBe(false);

    const document = generateCalyxOpenApi() as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const generatedReceipt = document.components.schemas[schemaKey("calyx.run-receipt/v1")] as unknown as {
      anyOf: Array<{ anyOf?: Array<{
        properties: {
          schema_version: { enum: string[] };
          process: { properties: { argv: Record<string, unknown> } };
        };
      }> }>;
    };
    const generatedHostBranches = generatedReceipt.anyOf.flatMap((branch) => branch.anyOf ?? []);
    const generatedBound = generatedHostBranches.find((branch) => (
      branch.properties.schema_version.enum[0] === "calyx.host-process-receipt/v1"
    ));
    expect(generatedBound).toBeDefined();
    const validateGenerated = new Ajv2020({
      strict: false,
      validateFormats: false,
      unicodeRegExp: false,
    }).compile(generatedBound!.properties.process.properties.argv);
    expect(validateGenerated(base.process.argv)).toBe(true);
    expect(validateGenerated([])).toBe(false);
    expect(validateGenerated([""])).toBe(false);
  });

  test("consumer activity writers admit only visible conversational roles", () => {
    const message = {
      id: "interactive:codex:visible:msg:1",
      activity_id: "interactive:codex:visible",
      role: "human",
      text: "Authorized visible text.",
      summary: "Human message.",
      truncated: false,
    };
    const messages = {
      schema_version: "activity.messages/v1",
      activity_id: "interactive:codex:visible",
      backend: "codex",
      session_id: "visible",
      total_messages: 1,
      matched_messages: 1,
      truncated: false,
      messages: [message],
    };
    expect(validateOperationResponse("activity.messages", messages)).toEqual(messages);
    expect(() => validateOperationResponse("activity.messages", {
      ...messages,
      messages: [{ ...message, role: "tool_call", summary: "Tool call message." }],
    })).toThrow();

    const turns = {
      schema_version: "activity.turns/v1",
      activity_id: "interactive:codex:visible",
      backend: "codex",
      session_id: "visible",
      total_turns: 1,
      matched_turns: 1,
      truncated: false,
      turns: [{
        turn_id: "interactive:codex:visible:turn:1",
        index: 0,
        role: "human",
        state: "complete",
        summary: "Human turn is complete.",
        messages_truncated: false,
        messages: [{
          id: message.id,
          role: message.role,
          text: message.text,
          summary: message.summary,
          truncated: message.truncated,
        }],
      }],
    };
    expect(validateOperationResponse("activity.turns", turns)).toEqual(turns);
    expect(() => validateOperationResponse("activity.turns", {
      ...turns,
      turns: [{
        ...turns.turns[0],
        role: "unknown",
        messages: [],
        summary: "Classified activity turn is complete.",
      }],
    })).toThrow();
  });

  test("publishes and enforces explicit message-operation and delivery-summary wire states", () => {
    const document = generateCalyxOpenApi() as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const messageOperation = document.components.schemas[schemaKey("calyx.message-operation/v1")]!;
    const messageBranches = messageOperation["anyOf"] as Array<Record<string, unknown>>;
    expect(messageBranches).toHaveLength(2);
    const branchProperties = (branch: Record<string, unknown>) => branch["properties"] as Record<string, Record<string, unknown>>;
    const enumFirst = (schema: Record<string, unknown> | undefined): unknown => (
      Array.isArray(schema?.["enum"]) ? schema["enum"][0] : undefined
    );
    const pendingBranch = messageBranches.find((branch) => enumFirst(branchProperties(branch)["terminal"]) === false)!;
    const terminalBranch = messageBranches.find((branch) => enumFirst(branchProperties(branch)["terminal"]) === true)!;
    expect(pendingBranch["required"]).not.toContain("receipt");
    expect(branchProperties(pendingBranch)["receipt"]).toBeUndefined();
    expect(branchProperties(pendingBranch)["status"]?.["enum"]).toEqual(["pending", "in_flight"]);
    expect(terminalBranch["required"]).toContain("receipt");
    expect(branchProperties(terminalBranch)["receipt"]).toBeDefined();
    expect(branchProperties(terminalBranch)["status"]?.["enum"]).toEqual([
      "forwarded",
      "indeterminate",
      "delivery_failed",
    ]);

    const pendingOperation = {
      schema_version: "calyx.message-operation/v1",
      operation_id: "operation-pending",
      target_host: "worm",
      status: "pending",
      terminal: false,
      attempt_count: 0,
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z",
    };
    expect(validateOperationResponse("msg.operation", pendingOperation)).toEqual(pendingOperation);
    const inFlightOperation = {
      ...pendingOperation,
      status: "in_flight",
      attempt_count: 1,
      updated_at: "2026-07-14T00:00:30.000Z",
    };
    expect(validateOperationResponse("msg.operation", inFlightOperation)).toEqual(inFlightOperation);
    const receipt = {
      schema_version: "calyx.message-operation-receipt/v1",
      outcome: "forwarded",
      completed_at: "2026-07-14T00:01:00.000Z",
    };
    const validateMessageOperation = new Ajv2020({ strict: false, validateFormats: false })
      .compile(messageOperation);
    expect(validateMessageOperation(pendingOperation)).toBe(true);
    expect(validateMessageOperation({ ...pendingOperation, receipt })).toBe(false);
    expect(validateMessageOperation({ ...pendingOperation, future_operation_field: true })).toBe(true);
    expect(() => validateOperationResponse("msg.operation", { ...pendingOperation, receipt })).toThrow();
    expect(() => validateOperationResponse("msg.operation", {
      ...pendingOperation,
      status: "forwarded",
      terminal: true,
    })).toThrow();
    expect(() => validateOperationResponse("msg.operation", {
      ...pendingOperation,
      status: "forwarded",
      receipt,
    })).toThrow();
    const indeterminateOperation = {
      ...pendingOperation,
      status: "indeterminate",
      terminal: true,
      attempt_count: 1,
      receipt: {
        ...receipt,
        outcome: "indeterminate",
      },
    };
    expect(validateOperationResponse("msg.operation", indeterminateOperation)).toEqual(indeterminateOperation);
    expect(() => validateOperationResponse("msg.operation", {
      ...indeterminateOperation,
      terminal: false,
      receipt: undefined,
    })).toThrow();

    const monitorSchema = document.components.schemas[schemaKey("calyx.monitor-observation/v1")]!;
    const monitorProperties = monitorSchema["properties"] as Record<string, Record<string, unknown>>;
    const deliveryBranches = monitorProperties["delivery_summary"]?.["anyOf"] as Array<Record<string, unknown>>;
    expect(deliveryBranches).toHaveLength(5);
    const noneBranch = deliveryBranches.find((branch) => enumFirst(branchProperties(branch)["state"]) === "none")!;
    expect(branchProperties(noneBranch)).not.toHaveProperty("last_delivery_at");
    for (const branch of deliveryBranches.filter((candidate) => candidate !== noneBranch)) {
      expect(branch["required"]).toContain("last_delivery_at");
    }

    const monitor = {
      schema_version: "calyx.monitor-observation/v1",
      monitor_id: "monitor-wire-state",
      status: "active",
      preset: "runner-supervision",
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:01:00.000Z",
      delivery_summary: { state: "none", attempted: 0, delivered: 0, failed: 0 },
      wake_count: 0,
    };
    const validateNoDelivery = new Ajv2020({ strict: false, validateFormats: false }).compile(noneBranch);
    expect(validateNoDelivery(monitor.delivery_summary)).toBe(true);
    expect(validateNoDelivery({
      ...monitor.delivery_summary,
      last_delivery_at: "2026-07-14T00:01:00.000Z",
    })).toBe(false);
    expect(validateNoDelivery({ ...monitor.delivery_summary, future_delivery_field: true })).toBe(true);
    expect(validateOperationResponse("monitor.get", monitor)).toEqual(monitor);
    expect(() => validateOperationResponse("monitor.get", {
      ...monitor,
      delivery_summary: { ...monitor.delivery_summary, last_delivery_at: "2026-07-14T00:01:00.000Z" },
    })).toThrow();
    expect(() => validateOperationResponse("monitor.get", {
      ...monitor,
      delivery_summary: {
        state: "delivered",
        attempted: 2,
        delivered: 1,
        failed: 0,
        last_delivery_at: "2026-07-14T00:01:00.000Z",
      },
    })).toThrow();
    expect(() => validateOperationResponse("monitor.get", {
      ...monitor,
      delivery_summary: { state: "pending", attempted: 1, delivered: 0, failed: 0 },
    })).toThrow();
  });

  test("publishes the exact durable run admission, cancellation, and reconcile DTOs", () => {
    const document = generateCalyxOpenApi() as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const schemas = document.components.schemas;
    const record = schemas[schemaKey("calyx.run-record/v1")]!;
    expect(record).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["schema_version", "run_id", "state", "intent", "launch"]),
      properties: {
        schema_version: { enum: ["calyx.run-record/v1"] },
        launch: {
          type: "object",
          "x-calyx-unknown-field-policy": "preserve",
          required: expect.arrayContaining([
            "mode", "stage", "admission_identity", "request_hash", "accepted_at", "dispatch_attempts",
          ]),
          properties: {
            admission_identity: { type: "string", pattern: "^[0-9a-f]{64}$" },
            request_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
          },
        },
      },
    });
    expect(schemas[schemaKey("calyx.run-get/v1")]).toBeUndefined();

    const cancellation = schemas[schemaKey("calyx.run-cancellation-result/v1")]!;
    expect(cancellation).toHaveProperty("anyOf");
    expect(JSON.stringify(cancellation)).toContain("cancellation_requested");
    expect(JSON.stringify(cancellation)).toContain("already_terminal");
    expect(JSON.stringify(cancellation)).not.toContain("stopped");
    expect(JSON.stringify(cancellation)).not.toContain("pid");
    const stopResponses = (document as unknown as {
      paths: Record<string, Record<string, { responses: Record<string, { "x-calyx-error-codes"?: string[] }> }>>;
    }).paths["/v1/admin/runs/{runId}/stop"]?.post?.responses;
    expect(stopResponses?.["404"]?.["x-calyx-error-codes"]).toEqual(["not_found"]);
    const launchResponses = (document as unknown as {
      paths: Record<string, Record<string, { responses: Record<string, { "x-calyx-error-codes"?: string[] }> }>>;
    }).paths["/v1/admin/runs"]?.post?.responses;
    expect(launchResponses?.["409"]?.["x-calyx-error-codes"]).toContain("run_host_mismatch");

    const reconcile = schemas[schemaKey("calyx.run-reconcile/v1")]!;
    expect(reconcile).toMatchObject({
      required: expect.arrayContaining(["projection"]),
      properties: {
        projection: { anyOf: expect.any(Array) },
      },
    });
    expect(JSON.stringify(reconcile)).toContain("rowCount");
    expect(JSON.stringify(reconcile)).toContain("reason");

    const adminReconcile = schemas[schemaKey("calyx.admin-reconcile-result/v1")]!;
    expect(adminReconcile).toMatchObject({
      required: expect.arrayContaining(["status", "projection", "unresolved"]),
      properties: {
        status: { enum: ["completed", "incomplete"] },
        projection: { anyOf: expect.any(Array) },
        unresolved: { type: "array" },
        noncanonical_directories: {
          type: "array",
          items: {
            properties: {
              directory_name: { minLength: 1 },
              record_state: { minLength: 1 },
            },
          },
        },
      },
      "x-calyx-cross-field-contract": {
        unresolved_histogram: {
          unique_by: "reason",
          sum_field: "count",
          equals: "changed.unresolved",
        },
        noncanonical_directory_examples: {
          accepted_length_contracts: [
            expect.objectContaining({ generation: "current_bounded_writer" }),
            expect.objectContaining({ generation: "predecessor_v1_writer" }),
          ],
        },
      },
    });
    expect(JSON.stringify(adminReconcile)).toContain("canonical_run_record_missing");
    expect(JSON.stringify(adminReconcile)).toContain("legacy_owner_settlement_pending");
    expect(JSON.stringify(adminReconcile)).not.toContain("run_id");

    const attachmentBytes = (document as unknown as {
      paths: Record<string, Record<string, {
        parameters: Array<{ name: string; schema: Record<string, unknown> }>;
        responses: Record<string, {
          headers: Record<string, { schema: Record<string, unknown> }>;
          "x-calyx-max-bytes"?: number;
        }>;
      }>>;
    }).paths["/v1/admin/activity/{activityId}/attachments/{ref}/bytes"]?.get;
    expect(attachmentBytes?.responses["200"]?.headers["content-length"]?.schema).toMatchObject({
      minimum: 0,
      maximum: CALYX_ACTIVITY_ATTACHMENT_MAX_BYTES,
    });
    expect(attachmentBytes?.responses["200"]?.["x-calyx-max-bytes"])
      .toBe(CALYX_ACTIVITY_ATTACHMENT_MAX_BYTES);
    expect(attachmentBytes?.parameters.find((parameter) => parameter.name === "ref")?.schema)
      .toMatchObject({
        type: "string",
        minLength: 75,
        maxLength: 75,
        pattern: expect.stringContaining("^att:sha256:[0-9a-f]{64}$"),
      });
    for (const [schemaId, objectPath] of [
      ["calyx.admin-activity-attachment-record/v1", "$"],
      ["activity.attachments/v1", "attachments[*]"],
      ["calyx.admin-activity-attachments/v1", "attachments[*]"],
      ["calyx.admin-activity-messages/v1", "messages[*].attachments[*]"],
    ] as const) {
      expect(schemas[schemaKey(schemaId)], schemaId).toMatchObject({
        "x-calyx-cross-field-contract": {
          attachment_identity: {
            object_path: objectPath,
            ref_field: "ref",
            sha256_field: "sha256",
            ref_template: "att:sha256:{sha256}",
          },
        },
      });
    }
  });

  test("requires owner-free cancellation settlement fields as a paired response variant", () => {
    const bare = {
      schema_version: "calyx.run-cancellation-result/v1",
      status: "cancellation_requested",
      run_id: "run-cancellation-bare",
      requested_at: "2026-07-17T02:00:00.000Z",
    };
    const paired = {
      ...bare,
      run_id: "run-cancellation-paired",
      worker_ownership: "owner_free",
      settled_state: "infra_error",
    };
    const partials = [
      { ...bare, worker_ownership: "owner_free" },
      { ...bare, settled_state: "infra_error" },
    ];

    expect(validateOperationSuccessResponse("admin.run.stop", 200, bare).value).toEqual(bare);
    expect(validateOperationSuccessResponse("admin.run.stop", 200, paired).value).toEqual(paired);
    expect(validateOperationSuccessResponseForConsumer("admin.run.stop", 200, bare).value).toEqual(bare);
    expect(validateOperationSuccessResponseForConsumer("admin.run.stop", 200, paired).value).toEqual(paired);
    for (const partial of partials) {
      expect(() => validateOperationSuccessResponse("admin.run.stop", 200, partial)).toThrow();
      expect(() => validateOperationSuccessResponseForConsumer("admin.run.stop", 200, partial)).toThrow();
    }

    const document = generateCalyxOpenApi() as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const cancellation = document.components.schemas[schemaKey("calyx.run-cancellation-result/v1")]!;
    const variants = cancellation["anyOf"] as Array<Record<string, unknown>>;
    expect(variants).toHaveLength(3);
    expect(variants).toEqual(expect.arrayContaining([
      expect.objectContaining({
        required: expect.arrayContaining(["worker_ownership", "settled_state"]),
      }),
    ]));
    const validateCancellation = new Ajv2020({ strict: false, validateFormats: false })
      .compile(cancellation);
    expect(validateCancellation(bare)).toBe(true);
    expect(validateCancellation(paired)).toBe(true);
    for (const partial of partials) expect(validateCancellation(partial)).toBe(false);
  });

  test("emits exact query, submit, union, and operation-local error contracts", () => {
    const document = generateCalyxOpenApi() as {
      paths: Record<string, Record<string, {
        parameters?: Array<{ name: string; in: string }>;
        responses: Record<string, {
          "x-calyx-error-codes"?: string[];
          "x-calyx-semantics"?: Record<string, unknown>;
        }>;
      }>>;
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    expect(document.paths["/v1/admin/runs/{runId}/logs"]?.get?.parameters)
      .toContainEqual(expect.objectContaining({ name: "tail", in: "query" }));
    expect(document.paths["/v1/admin/runs"]?.post?.responses).toHaveProperty("202");
    expect(document.paths).not.toHaveProperty("/v1/admin/runs/reconcile");
    expect(document.paths["/v1/messages/send"]?.post?.responses["409"]?.["x-calyx-error-codes"])
      .toEqual(["idempotency_conflict"]);
    expect(() => validateOperationRequest("admin.monitor.claim", {
      claimed_by: "operator",
    })).toThrow();
    expect(() => validateOperationRequest("admin.monitor.claim", {
      idempotency_key: "monitor-claim-openapi",
      claimed_by: "operator",
      limit: 10,
    })).not.toThrow();
    expect(() => validateOperationRequest("admin.run.launch", {
      schema_version: "calyx.run-launch-request/v1",
      idempotency_key: " padded-key ",
      intent: {
        run_id: "run-padded-key",
        host: "blade",
        created_at: "2026-07-15T00:00:00.000Z",
      },
    })).toThrow("idempotency keys must not contain whitespace");
    const runObservation = document.components.schemas[schemaKey("calyx.run-observation/v1")] as {
      anyOf: Array<{ properties?: Record<string, {
        enum?: unknown[];
        maxLength?: number;
        type?: string;
      }> }>;
    };
    expect(runObservation).toHaveProperty("anyOf");
    const runObservationBranch = runObservation.anyOf.find((branch) => (
      branch.properties?.["kind"]?.enum?.includes("run")
    ));
    expect(runObservationBranch?.properties?.["branch"]?.maxLength).toBe(256);
    expect(runObservationBranch?.properties?.["pr_url"]?.maxLength).toBe(2_048);
    for (const branch of runObservation.anyOf) {
      for (const property of Object.values(branch.properties ?? {})) {
        if (property.enum !== undefined || property.type !== "string") continue;
        expect(property.maxLength).toBeTypeOf("number");
      }
    }
    expect(document.paths["/v1/admin/leases/list"]?.post?.responses["200"]?.["x-calyx-semantics"])
      .toMatchObject({ mutation: "read", receipt: "none" });
  });

  test("uses canonical DTOs at request and response edges", () => {
    expect(() => validateOperationRequest("admin.run.launch", {
      schema_version: "calyx.run-launch-request/v1",
      idempotency_key: "portable-launch-tombstone",
      detached: false,
      intent: {
        run_id: "portable-launch-tombstone",
        host: "blade",
        created_at: "2026-07-14T00:00:00.000Z",
        host_process: { argv: ["true"] },
      },
    })).toThrow("detached");
    expect(() => validateOperationRequest("work.list", { limit: "0" })).toThrow();
    expect(() => validateOperationRequest("admin.run.logs", { tail: "20" })).not.toThrow();
    expect(() => validateOperationResponse("work.get", {
      schema_version: "calyx.run-observation/v1",
      run_id: "run-1",
      short_id: "run-1",
      kind: "run",
      host: "blade",
      backend: "codex",
      status: "running",
      health: "healthy",
      created_at: "2026-07-13T00:00:00.000Z",
      updated_at: "2026-07-13T00:01:00.000Z",
      intent: { prompt: "must not cross" },
    })).toThrow();

    expect(() => validateOperationResponse("monitor.get", {
      schema_version: "calyx.monitor-observation/v1",
      monitor_id: "monitor-1",
      status: "future_terminal_state",
      preset: "runner-supervision",
      created_at: "2026-07-13T00:00:00.000Z",
      updated_at: "2026-07-13T00:01:00.000Z",
      delivery_summary: { state: "none", attempted: 0, delivered: 0, failed: 0 },
      wake_count: 0,
    })).toThrow();
    expect(() => validateOperationRequest("admin.monitor.create", {
      schema_version: "calyx.monitor-create-request/v1",
      idempotency_key: "monitor-create-openapi",
      owner: "operator",
      created_by: "operator",
      create_provenance: "future_writer",
      assigned_host: "blade",
      source_run_id: "run-1",
      preset: "runner-supervision",
      stale_after_ms: 60_000,
      rearm_policy: "once",
    })).toThrow();
  });

  test("rejects backend-mismatched execution limits at admin request and receipt boundaries", async () => {
    const launchIntent = {
      run_id: "pol-1982-forged",
      host: "blade",
      backend: "claude",
      prompt: "x",
      require_execplan: false,
      pull_execplan: false,
      worktree_mode: "existing",
      worktree_path: "/tmp",
      backend_options: { max_threads: 4 },
      created_at: "2026-07-21T19:00:00.000Z",
    };
    expect(() => validateOperationRequest("admin.run.launch", {
      schema_version: "calyx.run-launch-request/v1",
      idempotency_key: "pol-1982-forged",
      intent: launchIntent,
    })).toThrow("Claude does not support backend_options.max_threads");
    expect(() => validateOperationRequest("admin.run.launch", {
      schema_version: "calyx.run-launch-request/v1",
      idempotency_key: "pol-1982-wrong-type",
      intent: {
        ...launchIntent,
        backend: "codex",
        backend_options: { max_threads: "4" },
      },
    })).toThrow("backend_options.max_threads must be a positive integer");

    const receipt = JSON.parse(await readFile(
      new URL("../../../../fixtures/domains/runner/receipt.valid.json", import.meta.url),
      "utf8",
    )) as { run_spec: Record<string, unknown> };
    receipt.run_spec["backend_options"] = { max_threads: 4 };
    expect(() => validateSchema("calyx.run-receipt/v1", receipt))
      .toThrow("Claude does not support backend_options.max_threads");
  });

  test("keeps response writers strict while same-major readers preserve compatible additions", () => {
    const launch = {
      schema_version: "calyx.run-launch-result/v1",
      status: "accepted",
      run_id: "run-skew-response",
      operation: {
        route: "/v1/admin/runs/run-skew-response",
        events_route: "/v1/admin/runs/run-skew-response/events",
        receipt_route: "/v1/admin/runs/run-skew-response/receipt",
        future_nested: true,
      },
      future_optional: { emitted_by: "newer-daemon" },
    };
    expect(() => validateOperationSuccessResponse("admin.run.launch", 202, launch)).toThrow();
    expect(validateOperationSuccessResponseForConsumer("admin.run.launch", 202, launch).value)
      .toBe(launch);

    const additiveInteractiveObservation = {
      schema_version: "calyx.run-observation/v1",
      kind: "interactive",
      run_id: "interactive:codex:session-skew",
      short_id: "session-skew",
      host: "blade",
      backend: "codex",
      status: "interactive",
      health: "healthy",
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:01:00.000Z",
      issue: "POL-FUTURE",
    };
    expect(() => validateOperationSuccessResponse("work.get", 200, additiveInteractiveObservation)).toThrow();
    expect(validateOperationSuccessResponseForConsumer("work.get", 200, additiveInteractiveObservation).value)
      .toBe(additiveInteractiveObservation);

    const monitor = {
      schema_version: "calyx.monitor-observation/v1",
      monitor_id: "monitor-skew-response",
      status: "paused_by_policy",
      preset: "runner-supervision",
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:01:00.000Z",
      delivery_summary: { state: "none", attempted: 0, delivered: 0, failed: 0 },
      wake_count: 0,
    };
    expect(() => validateOperationSuccessResponse("monitor.get", 200, monitor)).toThrow();
    expect(validateOperationSuccessResponseForConsumer("monitor.get", 200, monitor).value)
      .toBe(monitor);

    expect(() => validateOperationSuccessResponseForConsumer("monitor.get", 200, {
      ...monitor,
      schema_version: "calyx.monitor-observation/v2",
    })).toThrow();

    expect(() => validateOperationSuccessResponseForConsumer("admin.run.stop", 200, {
      schema_version: "calyx.run-cancellation-result/v1",
      status: "paused_by_policy",
      run_id: "run-skew-response",
    })).toThrow();

    const futureTerminalOperation = {
      schema_version: "calyx.message-operation/v1",
      operation_id: "operation-skew-response",
      target_host: "worm",
      status: "expired",
      terminal: true,
      attempt_count: 3,
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:01:00.000Z",
      receipt: {
        schema_version: "calyx.message-operation-receipt/v1",
        outcome: "delivery_failed",
        completed_at: "2026-07-14T00:01:00.000Z",
      },
    };
    expect(() => validateOperationSuccessResponse("msg.operation", 200, futureTerminalOperation)).toThrow();
    expect(validateOperationSuccessResponseForConsumer("msg.operation", 200, futureTerminalOperation).value)
      .toBe(futureTerminalOperation);

    const futureNonterminalOperation = {
      ...futureTerminalOperation,
      status: "paused_by_policy",
      terminal: false,
      receipt: undefined,
    };
    expect(validateOperationSuccessResponseForConsumer("msg.operation", 200, futureNonterminalOperation).value)
      .toBe(futureNonterminalOperation);

    const futureReconcileStatus = {
      schema_version: "calyx.admin-reconcile-result/v1",
      status: "degraded",
      scanned: 1,
      changed: { rebuilt: 0, repair_pending: 0, classified: 0, adopted: 0, skipped: 1, unresolved: 0, noncanonical_directories: 0 },
      unresolved: [],
      noncanonical_directories: [],
      projection: { status: "repaired", row_count: 1 },
      completed_at: "2026-07-14T00:02:00.000Z",
    };
    expect(() => validateOperationSuccessResponseForConsumer(
      "admin.run.reconcile-preserving",
      200,
      futureReconcileStatus,
    )).toThrow();

    const predecessorDirectories = Array.from({ length: 65 }, (_, index) => ({
      directory_name: `${"legacy-directory-".repeat(20)}${index}`,
      status: "requires_operator_migration",
      record_state: "legacy-state".repeat(10),
    }));
    const predecessorReconcile = {
      schema_version: "calyx.admin-reconcile-result/v1",
      status: "incomplete",
      scanned: 65,
      changed: { rebuilt: 0, repair_pending: 0, classified: 0, adopted: 0, skipped: 0, unresolved: 0, noncanonical_directories: 65 },
      unresolved: [],
      noncanonical_directories: predecessorDirectories,
      projection: { status: "repaired", row_count: 0 },
      completed_at: "2026-07-14T00:02:00.000Z",
    };
    expect(() => validateOperationSuccessResponse(
      "admin.run.reconcile-preserving",
      200,
      predecessorReconcile,
    )).toThrow();
    const normalizedPredecessor = validateOperationSuccessResponseForConsumer(
      "admin.run.reconcile-preserving",
      200,
      predecessorReconcile,
    ).value as typeof predecessorReconcile;
    expect(normalizedPredecessor).not.toBe(predecessorReconcile);
    expect(normalizedPredecessor.changed.noncanonical_directories).toBe(65);
    expect(normalizedPredecessor.noncanonical_directories).toHaveLength(64);
    expect(normalizedPredecessor.noncanonical_directories[0]?.directory_name).toHaveLength(255);
    expect(normalizedPredecessor.noncanonical_directories[0]?.record_state).toHaveLength(64);
    expect(() => validateOperationSuccessResponseForConsumer(
      "admin.run.reconcile-preserving",
      200,
      { ...predecessorReconcile, noncanonical_directories: [...predecessorDirectories, predecessorDirectories[0]] },
    )).toThrow();

    const futureLogKind = {
      schema_version: "run-logs/v1",
      run_id: "run-skew-response",
      entries: Array.from({ length: 6 }, (_, index) => ({
        kind: "structured_metric",
        source: "agent",
        text: `metric_${index}=0.9`,
      })),
      sources: [],
      options: { stream_tail: 0, max_stream_bytes: 1024, stream_tail_defaulted: false },
      warnings: [],
    };
    expect(validateOperationSuccessResponseForConsumer("admin.run.logs", 200, futureLogKind).value)
      .toBe(futureLogKind);

    for (const state of ["running", "future_resumable_state"]) {
      const additiveRunListEntry = {
        run_id: `run-${state}`,
        state,
        summary: "rolling-skew run",
        created_at: "2026-07-14T00:00:00.000Z",
        updated_at: "2026-07-14T00:03:00.000Z",
        recovery_mode: "resume",
        run_dir: `/tmp/run-${state}`,
        entry_kind: "calyx_run",
        future_optional: { emitted_by: "newer-daemon" },
      };
      const additiveRunList = {
        schema_version: "calyx.run-list/v1",
        count: 1,
        truncated: false,
        runs: [additiveRunListEntry],
        future_optional: { emitted_by: "newer-daemon" },
      };
      expect(() => validateOperationSuccessResponse("admin.run.list", 200, additiveRunList)).toThrow();
      expect(validateOperationSuccessResponseForConsumer("admin.run.list", 200, additiveRunList).value)
        .toBe(additiveRunList);
      expect(() => validateOperationSuccessResponseForConsumer("admin.run.list", 200, {
        ...additiveRunList,
        next_cursor: "dishonest-complete-page-cursor",
      })).toThrow();
    }

    const boundedClaudeRunList = {
      schema_version: "calyx.run-list/v1",
      count: 1,
      truncated: false,
      runs: [{
        run_id: "run-bounded-claude-terminal",
        state: "running",
        summary: "Claude retry is in progress.",
        created_at: "2026-07-17T12:00:00.000Z",
        updated_at: "2026-07-17T12:00:01.000Z",
        health_status: "healthy",
        progress_signal: {
          source: "claude_stream",
          status: "available",
          reason: "semantic_event",
          expected_silence_until: "2026-07-17T12:05:31.000Z",
        },
        terminal: {
          evidence: {
            schema_version: "calyx.agent-terminal-evidence/v1",
            source: "claude_stream",
            status: "authoritative",
            reason: "completed",
          },
        },
        recovery_mode: "normal",
        run_dir: "/tmp/run-bounded-claude-terminal",
      }],
    };
    expect(validateOperationSuccessResponse("admin.run.list", 200, boundedClaudeRunList).value)
      .toStrictEqual(boundedClaudeRunList);
    expect(() => validateOperationSuccessResponse("admin.run.list", 200, {
      ...boundedClaudeRunList,
      runs: [{
        ...boundedClaudeRunList.runs[0],
        terminal: {
          ...boundedClaudeRunList.runs[0]!.terminal,
          agent_terminal_message: "unbounded message must remain on the receipt",
        },
      }],
    })).toThrow();

    const consumerGap = {
      schema_version: "calyx.run-observation-gap/v1",
      cursor: "z1-00000000000000000041",
      event_type: "run.projection_gap",
      gap: {
        reason: "source_event_unrepresentable",
        source_event_type: "run.warning",
      },
    };
    expect(validateOperationSuccessResponseForConsumer("work.observe", 200, consumerGap).value)
      .toBe(consumerGap);
    expect(() => validateOperationSuccessResponseForConsumer("work.observe", 200, {
      ...consumerGap,
      raw_event: { token: "must-not-survive-redaction" },
    })).toThrow();
    expect(() => validateOperationSuccessResponseForConsumer("work.observe", 200, {
      ...consumerGap,
      gap: { ...consumerGap.gap, source_path: "/private/events.jsonl" },
    })).toThrow();

    const adminGap = {
      schema_version: "calyx.stream-projection-gap/v1",
      cursor: "z1-00000000000000000042",
      event_type: "stream.projection_gap",
      gap: {
        reason: "source_event_exceeds_frame_limit",
        source_event_type: "monitor.wake.created",
      },
    };
    expect(validateOperationSuccessResponseForConsumer("admin.events", 200, adminGap).value)
      .toBe(adminGap);
    expect(() => validateOperationSuccessResponseForConsumer("admin.events", 200, {
      ...adminGap,
      raw_event: { token: "must-not-survive-redaction" },
    })).toThrow();
    expect(() => validateOperationSuccessResponseForConsumer("admin.events", 200, {
      ...adminGap,
      gap: { ...adminGap.gap, source_path: "/private/events.jsonl" },
    })).toThrow();

    expect(() => validateOperationSuccessResponseForConsumer("admin.run.events", 200, [{
      timestamp: "2026-07-14T00:03:00.000Z",
      run_id: "run-skew-response",
      source: "future-run-service",
      event: "warning",
      message: "a future producer discriminator must not be stripped into another union member",
    }])).toThrow();
    expect(() => validateOperationSuccessResponseForConsumer("admin.run.events", 200, [{
      timestamp: "2026-07-14T00:03:00.000Z",
      run_id: "run-skew-response",
      source: "run-service",
      event: "warning",
      message: "known source rows remain closed",
      future_top_level: "must use payload instead",
    }])).toThrow();
    expect(() => validateOperationSuccessResponseForConsumer("admin.run.events", 200, [{
      timestamp: "2026-07-14T00:03:00.000Z",
      run_id: "run-skew-response",
      source: "run-service",
      event: "warning",
      message: "must not also claim the durable stream family",
      schema_version: "1.0",
      event_id: "evt-mixed-family",
      cursor: "z1-00000000000000000043",
      emitted_at: "2026-07-14T00:03:00.000Z",
      event_type: "run.warning",
      emitted_by: "blade",
    }])).toThrow();
    expect(() => validateOperationSuccessResponseForConsumer("admin.run.events", 200, [{
      timestamp: "2026-07-14T00:03:00.000Z",
      run_id: "run-skew-response",
      event: "warning",
      message: "known lifecycle rows remain closed",
      future_top_level: "must use payload instead",
    }])).toThrow();

    expect(() => validateOperationSuccessResponseForConsumer("monitor.get", 200, {
      ...monitor,
      delivery_summary: { state: "future_delivery_state", attempted: 0, delivered: 0, failed: 0 },
    })).toThrow();
  });

  test("publishes explicit union exclusivity without closing lawful additive observation fields", () => {
    const document = generateCalyxOpenApi() as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validateObservation = ajv.compile(
      document.components.schemas[schemaKey("calyx.run-observation/v1")]!,
    );
    expect(validateObservation({
      schema_version: "calyx.run-observation/v1",
      kind: "interactive",
      run_id: "interactive:codex:session-skew",
      short_id: "session-skew",
      host: "blade",
      backend: "codex",
      status: "interactive",
      health: "healthy",
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:01:00.000Z",
      issue: "POL-FUTURE",
    })).toBe(true);

    const validateRunEvents = ajv.compile(
      document.components.schemas[schemaKey("calyx.run-events/v1")]!,
    );
    expect(validateRunEvents([{
      timestamp: "2026-07-14T00:03:00.000Z",
      run_id: "run-skew-response",
      source: "run-service",
      event: "warning",
      message: "must not also claim the durable stream family",
      schema_version: "1.0",
      event_id: "evt-mixed-family",
      cursor: "z1-00000000000000000043",
      emitted_at: "2026-07-14T00:03:00.000Z",
      event_type: "run.warning",
      emitted_by: "blade",
    }])).toBe(false);
  });

  test("publishes the closed and bounded consumer activity attention projection", () => {
    type ObservationProperty = {
      enum?: unknown[];
      maximum?: number;
      maxLength?: number;
      minimum?: number;
      pattern?: string;
      type?: string;
    };
    const document = generateCalyxOpenApi() as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const observation = document.components.schemas[schemaKey("calyx.run-observation/v1")] as {
      anyOf: Array<{
        properties?: Record<string, ObservationProperty>;
        required?: string[];
      }>;
    };
    const runBranch = observation.anyOf.find((branch) => (
      branch.properties?.["kind"]?.enum?.includes("run")
    ));
    const interactiveBranch = observation.anyOf.find((branch) => (
      branch.properties?.["kind"]?.enum?.includes("interactive")
    ));

    expect(interactiveBranch?.properties?.["attention_state"]).toMatchObject({
      type: "string",
      enum: [...CONSUMER_ACTIVITY_ATTENTION_STATES],
      "x-calyx-enum-mode": "closed",
      "x-calyx-enum-closure": "wire-shape-discriminator",
    });
    expect(interactiveBranch?.required).not.toContain("attention_state");
    expect(runBranch?.properties).not.toHaveProperty("attention_state");
    expect(interactiveBranch?.properties?.["repo_ref"]).toMatchObject({
      type: "string",
      maxLength: CONSUMER_ACTIVITY_REPO_REF_MAX_CHARS,
      pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$",
    });
    expect(interactiveBranch?.properties?.["worktree_ref"]).toMatchObject({
      type: "string",
      maxLength: CONSUMER_ACTIVITY_WORKTREE_REF_MAX_CHARS,
      pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$",
    });
    expect(interactiveBranch?.properties?.["latest_visible_message_excerpt"]).toMatchObject({
      type: "string",
      maxLength: CONSUMER_ACTIVITY_MESSAGE_EXCERPT_MAX_CHARS,
    });
    expect(interactiveBranch?.properties?.["visible_message_count"]).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(runBranch?.properties).not.toHaveProperty("repo_ref");
    expect(runBranch?.properties).not.toHaveProperty("worktree_ref");
    expect(runBranch?.properties).not.toHaveProperty("latest_visible_message_excerpt");
    expect(runBranch?.properties).not.toHaveProperty("visible_message_count");
  });

  test("internal message forwarding ignores additive request fields for rolling skew", () => {
    const parsed = validateOperationRequest("internal.msg.receive", {
      schema_version: "calyx.msg-send/v1",
      future_optional_field: { emitted_by: "newer-daemon" },
      message: {
        future_nested_field: "ignored by an older receiver",
        message_id: "msg-skew",
        schema_version: "calyx.message/v1",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@worm",
        recipient_class: "directed",
        recipient_host: "worm",
        subject: "rolling skew",
        body: "old daemon must ignore the additive field",
        thread_key: null,
        reply_to: null,
        idempotency_key: "skew-1",
        urgency: "normal",
        ack_required: false,
        expires_at: null,
        status: "outbox",
        claimed_until: null,
        claimed_by: null,
        expired_claim_cycles: 0,
        dead_letter: false,
        dead_letter_reason: null,
        created_at: "2026-07-14T00:00:00.000Z",
        updated_at: "2026-07-14T00:00:00.000Z",
        spooled_at: "2026-07-14T00:00:00.000Z",
        delivered_at: null,
        acked_at: null,
        acked_by: null,
        receipt_path: null,
        payload: {},
        created_provenance: {
          schema_version: "calyx.provenance/v1",
          request_id: "req_123e4567-e89b-42d3-a456-426614174000",
          subject: "daemon:blade",
          host: "blade",
          via: "http",
          at: "2026-07-14T00:00:00.000Z",
        },
        ingress_provenance: null,
      },
    }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("future_optional_field");
    expect(parsed).toMatchObject({ schema_version: "calyx.msg-send/v1" });
    expect(parsed.message).not.toHaveProperty("future_nested_field");
  });

  test("request readers recursively ignore additive DTO fields for rolling skew", () => {
    const sessionWake = validateOperationRequest("admin.session-wake.deliver", {
      schema_version: "calyx.session-wake-deliver-request/v1",
      delivery_id: `session_wake_${"a".repeat(64)}`,
      recipient_activity_id: "interactive:codex:rolling-skew",
      pointer: {
        kind: "message",
        id: "msg-rolling-skew",
        future_pointer_hint: "ignored",
      },
      created_at: "2026-07-17T12:00:00.000Z",
      future_transport_hint: { source: "newer-sender" },
    });
    expect(sessionWake).toEqual({
      schema_version: "calyx.session-wake-deliver-request/v1",
      delivery_id: `session_wake_${"a".repeat(64)}`,
      recipient_activity_id: "interactive:codex:rolling-skew",
      pointer: { kind: "message", id: "msg-rolling-skew" },
      created_at: "2026-07-17T12:00:00.000Z",
    });

    const launch = validateOperationRequest("admin.run.launch", {
      schema_version: "calyx.run-launch-request/v1",
      idempotency_key: "run-skew-request",
      future_root: true,
      intent: {
        run_id: "run-skew",
        host: "blade",
        created_at: "2026-07-14T00:00:00.000Z",
        future_intent: true,
        host_process: {
          argv: ["true"],
          future_host_process: true,
          health: {
            stale_after_ms: 60_000,
            future_health: true,
            sources: [{ kind: "stdout", future_source: true }],
          },
        },
      },
    }) as Record<string, unknown>;
    expect(launch).not.toHaveProperty("future_root");
    expect(launch).toMatchObject({
      intent: {
        host_process: {
          health: { sources: [{ kind: "stdout" }] },
        },
      },
    });
    expect(JSON.stringify(launch)).not.toContain("future_");

    expect(validateOperationRequest("admin.run.reconcile-preserving", { future_empty: true })).toEqual({});

    const monitor = validateOperationRequest("admin.monitor.create", {
      schema_version: "calyx.monitor-create-request/v1",
      idempotency_key: "monitor-create-role",
      owner: "operator",
      created_by: "operator",
      create_provenance: "operator",
      assigned_host: "blade",
      source_run_id: "run-skew",
      preset: "runner-supervision",
      stale_after_ms: 60_000,
      rearm_policy: "once",
      delivery: {
        schema_version: "calyx.monitor-delivery/v1",
        tier0: {
          schema_version: "calyx.monitor-delivery/v1",
          tier: "tier0",
          adapters: ["state-row", "jsonl-receipt", "sse"],
          retention: "indefinite",
          future_tier0: true,
        },
        bindings: [{
          schema_version: "calyx.monitor-delivery/v1",
          binding_id: "binding-skew",
          adapter: "ntfy",
          materiality: {
            schema_version: "calyx.monitor-materiality/v1",
            kind: "always",
            future_materiality: true,
          },
        }],
        ntfy_topic_policy: "fleet_default_with_per_lane_override",
        tier2_bridge: "codex_app_automations_first",
        agent_mail_thread: "legacy_provenance_only",
      },
    }) as Record<string, unknown>;
    expect(JSON.stringify(monitor)).not.toContain("future_");
  });

  test("advertises resumable SSE headers and profile-specific event filters", () => {
    const document = generateCalyxOpenApi() as {
      paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string; schema: Record<string, unknown> }> }>>;
    };
    const consumer = document.paths["/v1/events/observe"]?.get?.parameters ?? [];
    const admin = document.paths["/v1/admin/events/stream"]?.get?.parameters ?? [];
    expect(consumer).toContainEqual(expect.objectContaining({ name: "Last-Event-ID", in: "header" }));
    expect(admin).toContainEqual(expect.objectContaining({ name: "Last-Event-ID", in: "header" }));
    expect(consumer.find((parameter) => parameter.name === "event_type")?.schema)
      .toMatchObject({ type: "string", minLength: 1 });
    expect(admin.find((parameter) => parameter.name === "event_type")?.schema).not.toHaveProperty("enum");
  });

  test("publishes the consumer SSE positive-or-gap union with a bounded safe replay cursor", () => {
    const document = generateCalyxOpenApi() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const operation = document.paths["/v1/events/observe"]?.["get"];
    const streamSchemaKey = schemaKey("calyx.run-observation-event/v1");
    const responses = operation?.["responses"] as Record<string, Record<string, unknown>>;
    const content = responses["200"]?.["content"] as Record<string, Record<string, unknown>>;
    expect(content["text/event-stream"]?.["x-calyx-sse-event-schema"]).toEqual({
      $ref: `#/components/schemas/${streamSchemaKey}`,
    });
    expect(content["text/event-stream"]?.["x-calyx-sse-cursor-field"]).toBe("cursor");

    const variants = document.components.schemas[streamSchemaKey]?.["anyOf"] as Array<Record<string, unknown>>;
    expect(variants).toHaveLength(2);
    const gap = variants.find((variant) => {
      const properties = variant["properties"] as Record<string, Record<string, unknown>> | undefined;
      const values = properties?.["schema_version"]?.["enum"] as unknown[] | undefined;
      return values?.[0] === "calyx.run-observation-gap/v1";
    });
    expect(gap).toBeDefined();
    expect(gap).toMatchObject({
      additionalProperties: false,
      "x-calyx-unknown-field-policy": "reject",
    });
    const gapProperties = gap?.["properties"] as Record<string, Record<string, unknown>>;
    expect(gapProperties["cursor"]).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 512,
      pattern: expect.stringContaining("\\r\\n"),
    });
    expect(gapProperties["event_type"]).toMatchObject({
      enum: ["run.projection_gap"],
      "x-calyx-enum-mode": "closed",
    });
    expect(gapProperties).not.toHaveProperty("emitted_at");
    const gapReceipt = gapProperties["gap"]?.["properties"] as Record<string, Record<string, unknown>>;
    expect(gapReceipt["reason"]).toMatchObject({
      enum: ["source_event_unrepresentable"],
      "x-calyx-enum-mode": "closed",
    });
    expect(gapReceipt["source_event_type"]).toMatchObject({
      enum: ["run.terminal", "run.progress", "run.warning"],
      "x-calyx-enum-mode": "closed",
    });
    expect(gapProperties["gap"]).toMatchObject({
      additionalProperties: false,
      "x-calyx-unknown-field-policy": "reject",
    });
    const validateGap = new Ajv2020({ strict: false, validateFormats: false }).compile(gap!);
    const validGap = {
      schema_version: "calyx.run-observation-gap/v1",
      cursor: "z1-00000000000000000051",
      event_type: "run.projection_gap",
      gap: {
        reason: "source_event_unrepresentable",
        source_event_type: "run.warning",
      },
    };
    expect(validateGap(validGap)).toBe(true);
    expect(validateGap({ ...validGap, raw_event: { token: "private" } })).toBe(false);
    expect(validateGap({
      ...validGap,
      gap: { ...validGap.gap, source_path: "/private/events.jsonl" },
    })).toBe(false);
  });

  test("publishes the admin durable-or-projection-gap delivery union without source leakage", () => {
    const document = generateCalyxOpenApi() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const operation = document.paths["/v1/admin/events/stream"]?.["get"];
    const streamSchemaKey = schemaKey("calyx.stream-event/v1");
    const responses = operation?.["responses"] as Record<string, Record<string, unknown>>;
    const content = responses["200"]?.["content"] as Record<string, Record<string, unknown>>;
    expect(content["text/event-stream"]?.["x-calyx-sse-event-schema"]).toEqual({
      $ref: `#/components/schemas/${streamSchemaKey}`,
    });
    expect(content["text/event-stream"]?.["x-calyx-sse-cursor-field"]).toBe("cursor");

    const variants = document.components.schemas[streamSchemaKey]?.["anyOf"] as Array<Record<string, unknown>>;
    expect(variants).toHaveLength(2);
    const gap = variants.find((variant) => {
      const properties = variant["properties"] as Record<string, Record<string, unknown>> | undefined;
      const values = properties?.["schema_version"]?.["enum"] as unknown[] | undefined;
      return values?.[0] === "calyx.stream-projection-gap/v1";
    });
    expect(gap).toBeDefined();
    expect(gap).toMatchObject({
      additionalProperties: false,
      "x-calyx-unknown-field-policy": "reject",
    });
    const properties = gap?.["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["event_type"]).toMatchObject({
      enum: ["stream.projection_gap"],
      "x-calyx-enum-mode": "closed",
    });
    expect(properties).not.toHaveProperty("event_id");
    expect(properties).not.toHaveProperty("emitted_at");
    expect(properties).not.toHaveProperty("run");
    const receipt = properties["gap"]?.["properties"] as Record<string, Record<string, unknown>>;
    expect(receipt["reason"]).toMatchObject({
      enum: ["source_event_exceeds_frame_limit"],
      "x-calyx-enum-mode": "closed",
    });
    expect(receipt["source_event_type"]).toMatchObject({
      enum: expect.arrayContaining(["run.terminal", "monitor.wake.created"]),
      "x-calyx-enum-mode": "closed",
    });
    expect(properties["gap"]).toMatchObject({
      additionalProperties: false,
      "x-calyx-unknown-field-policy": "reject",
    });
    const validateGap = new Ajv2020({ strict: false, validateFormats: false }).compile(gap!);
    const validGap = {
      schema_version: "calyx.stream-projection-gap/v1",
      cursor: "z1-00000000000000000052",
      event_type: "stream.projection_gap",
      gap: {
        reason: "source_event_exceeds_frame_limit",
        source_event_type: "monitor.wake.created",
      },
    };
    expect(validateGap(validGap)).toBe(true);
    expect(validateGap({ ...validGap, raw_event: { token: "private" } })).toBe(false);
    expect(validateGap({
      ...validGap,
      gap: { ...validGap.gap, source_path: "/private/events.jsonl" },
    })).toBe(false);
  });

  test("keeps producer validation strict while marking client-forward enums open", () => {
    const document = generateCalyxOpenApi() as { components: { schemas: Record<string, Record<string, unknown>> } };
    const monitor = document.components.schemas[schemaKey("calyx.monitor-observation/v1")];
    const status = (monitor?.["properties"] as Record<string, Record<string, unknown>> | undefined)?.["status"];
    expect(status).toMatchObject({
      enum: expect.arrayContaining(["active", "cancelled"]),
      "x-calyx-enum-mode": "open",
      "x-calyx-known-values": expect.arrayContaining(["active", "cancelled"]),
    });
  });

  test("declares schema-major and wire-shape discriminants closed explicitly", () => {
    const document = generateCalyxOpenApi() as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const cancellation = document.components.schemas[schemaKey("calyx.run-cancellation-result/v1")];
    const variants = cancellation?.["anyOf"] as Array<Record<string, unknown>> | undefined;
    expect(variants).toBeDefined();
    for (const variant of variants ?? []) {
      const properties = variant["properties"] as Record<string, Record<string, unknown>>;
      expect(properties["schema_version"]).toMatchObject({
        "x-calyx-enum-mode": "closed",
        "x-calyx-enum-closure": "schema-major-discriminator",
      });
      expect(properties["status"]).toMatchObject({
        "x-calyx-enum-mode": "closed",
        "x-calyx-enum-closure": "wire-shape-discriminator",
      });
    }
  });

  test("allows closed multi-value response enums only by exact audited pointer", () => {
    const document = generateCalyxOpenApi() as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const responseSchemas = new Set(HTTP_OPERATION_DESCRIPTORS
      .flatMap((operation) => [
      operation.response_schema,
      ...operation.successes.map((success) => success.schema),
      ...operation.successes.flatMap((success) => success.semantics.submission
        ? [success.semantics.submission.receipt_schema]
        : []),
      ]));
    const visitedRefs = new Set<string>();
    const closed: string[] = [];
    const visit = (value: unknown, pointer: string): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((child, index) => visit(child, `${pointer}/${index}`));
        return;
      }
      const node = value as Record<string, unknown>;
      if (typeof node["$ref"] === "string") {
        const key = (node["$ref"] as string).split("/").at(-1);
        if (key && !visitedRefs.has(key)) {
          visitedRefs.add(key);
          visit(document.components.schemas[key], `#/components/schemas/${key}`);
        }
        return;
      }
      if (
        Array.isArray(node["enum"])
        && node["enum"].length > 1
        && node["x-calyx-enum-mode"] !== "open"
      ) closed.push(pointer);
      Object.entries(node).forEach(([key, child]) => visit(child, `${pointer}/${key}`));
    };
    for (const schemaId of responseSchemas) {
      const key = schemaKey(schemaId);
      if (visitedRefs.has(key)) continue;
      visitedRefs.add(key);
      visit(document.components.schemas[key], `#/components/schemas/${key}`);
    }
    expect(closed.sort()).toEqual([
      "#/components/schemas/calyx_activity_observation_list_v1/anyOf/0/properties/activities/items/anyOf/1/properties/attention_state",
      "#/components/schemas/calyx_activity_observation_list_v1/anyOf/1/properties/activities/items/anyOf/1/properties/attention_state",
      "#/components/schemas/calyx_admin_reconcile_result_v1/properties/status",
      "#/components/schemas/calyx_run_observation_event_v1/anyOf/1/properties/gap/properties/source_event_type",
      "#/components/schemas/calyx_run_observation_list_v1/anyOf/0/properties/runs/items/anyOf/1/properties/attention_state",
      "#/components/schemas/calyx_run_observation_list_v1/anyOf/1/properties/runs/items/anyOf/1/properties/attention_state",
      "#/components/schemas/calyx_run_observation_v1/anyOf/1/properties/attention_state",
      "#/components/schemas/calyx_stream_event_v1/anyOf/1/properties/gap/properties/source_event_type",
    ]);

    const at = (schemaId: string, ...segments: string[]): Record<string, unknown> | undefined => {
      let current: unknown = document.components.schemas[schemaKey(schemaId)];
      for (const segment of segments) {
        current = current && typeof current === "object"
          ? (current as Record<string, unknown>)[segment]
          : undefined;
      }
      return current && typeof current === "object" ? current as Record<string, unknown> : undefined;
    };
    const messageOperationBranches = at("calyx.message-operation/v1", "anyOf") as unknown as Array<Record<string, unknown>>;
    const messageOperationProperties = messageOperationBranches.flatMap((branch) => {
      const properties = branch["properties"] as Record<string, Record<string, unknown>>;
      return [properties["status"], (properties["receipt"]?.["properties"] as Record<string, unknown> | undefined)?.["outcome"]];
    }).filter((node): node is Record<string, unknown> => Boolean(node));
    const attachmentBranches = at("activity.attachments/v1", "anyOf") as unknown as Array<Record<string, unknown>>;
    const attachmentDetailNodes = attachmentBranches.map((branch) => {
      const properties = branch["properties"] as Record<string, Record<string, unknown>>;
      const attachments = properties["attachments"];
      const items = attachments?.["items"] as Record<string, unknown> | undefined;
      const itemProperties = items?.["properties"] as Record<string, Record<string, unknown>> | undefined;
      return itemProperties?.["detail"];
    }).filter((node): node is Record<string, unknown> => Boolean(node));
    for (const [label, node] of [
      ["message recipient class", at("calyx.message-observation/v1", "properties", "recipient_class")],
      ["lease doctor status", at("calyx.lease-doctor/v1", "properties", "status")],
    ] as const) expect(node, label).toMatchObject({ "x-calyx-enum-mode": "open" });
    expect(attachmentDetailNodes).toHaveLength(2);
    for (const node of attachmentDetailNodes) {
      expect(node, "attachment detail").toMatchObject({ "x-calyx-enum-mode": "open" });
    }
    for (const node of messageOperationProperties) {
      expect(node).toMatchObject({ "x-calyx-enum-mode": "open" });
    }
  });

  test("projects request DTOs as additive-field tolerant without opening explicit dictionaries", () => {
    const document = generateCalyxOpenApi() as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const violations: string[] = [];
    const visit = (value: unknown, pointer: string): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((child, index) => visit(child, `${pointer}/${index}`));
        return;
      }
      const node = value as Record<string, unknown>;
      if (node["type"] === "object" && node["properties"] && typeof node["properties"] === "object") {
        if (node["additionalProperties"] === false) violations.push(`${pointer}:closed`);
        if (
          node["x-calyx-dictionary-mode"] !== "explicit-json-metadata"
          && node["x-calyx-unknown-field-policy"] !== "ignore"
        ) violations.push(`${pointer}:unmarked`);
      }
      Object.entries(node).forEach(([key, child]) => visit(child, `${pointer}/${key}`));
    };
    for (const [key, schema] of Object.entries(document.components.schemas)) {
      if (schema["x-calyx-schema-role"] === "request") visit(schema, `#/components/schemas/${key}`);
    }
    expect(violations).toEqual([]);
  });

  test("declares the emitted dialect and represents nullable message hosts with OpenAPI 3.0 semantics", () => {
    const document = generateCalyxOpenApi() as {
      openapi: string;
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    expect(document.openapi).toBe("3.0.3");
    const forwarded = document.components.schemas[schemaKey("calyx.msg-forward/v1")]!;
    const recipientHost = (((forwarded["properties"] as Record<string, unknown>)["message"] as Record<string, unknown>)["properties"] as Record<string, unknown>)["recipient_host"];
    expect(recipientHost).toMatchObject({ type: "string", nullable: true });
  });

  test("declares the required bearer challenge on every unauthorized response", () => {
    const document = generateCalyxOpenApi() as {
      paths: Record<string, Record<string, {
        responses: Record<string, { headers?: Record<string, unknown> }>;
      }>>;
    };
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        expect(operation.responses["401"]?.headers?.["WWW-Authenticate"], `${method.toUpperCase()} ${path}`)
          .toMatchObject({
            required: true,
            schema: {
              type: "string",
              enum: ["Bearer realm=\"calyx-run\""],
              minLength: 1,
              maxLength: 1024,
              pattern: expect.any(String),
            },
          });
      }
    }
  });

  test("declares server correlation on every response and marks operation-local error enums open", () => {
    const document = generateCalyxOpenApi() as {
      paths: Record<string, Record<string, {
        responses: Record<string, {
          headers?: Record<string, unknown>;
          content?: Record<string, { schema?: { allOf?: Array<Record<string, unknown>> } }>;
        }>;
      }>>;
    };
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        for (const [status, response] of Object.entries(operation.responses)) {
          expect(response.headers?.["X-Calyx-Request-Id"], `${method} ${path} ${status}`)
            .toMatchObject({ required: true });
          if (Number(status) < 400) continue;
          const inline = response.content?.["application/json"]?.schema?.allOf?.[1] as {
            properties?: { error?: { properties?: { code?: Record<string, unknown> } } };
          } | undefined;
          expect(inline?.properties?.error?.properties?.code, `${method} ${path} ${status}`).toMatchObject({
            type: "string",
            "x-calyx-enum-mode": "open",
          });
        }
      }
    }
  });

  test("resolves every local OpenAPI reference", () => {
    const document = generateCalyxOpenApi() as Record<string, unknown>;
    const refs: string[] = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === "$ref" && typeof child === "string" && child.startsWith("#/")) refs.push(child);
        visit(child);
      }
    };
    visit(document);
    for (const ref of refs) {
      const resolved = ref.slice(2).split("/").reduce<unknown>((current, segment) => (
        current && typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined
      ), document);
      expect(resolved, ref).toBeDefined();
    }
  });
});
