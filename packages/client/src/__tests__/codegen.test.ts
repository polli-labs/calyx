import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  assertClientOmissionPolicy,
  buildClientContractIR,
  compileClientContract,
} from "../../../../scripts/lib/client-codegen.mjs";

const repoRoot = resolve(import.meta.dirname, "../../../..");

describe("client contract compiler", () => {
  test("compiles deterministic capability-separated transitive graphs from exact OpenAPI bytes", async () => {
    const bytes = await readFile(resolve(repoRoot, "calyx-openapi.json"));
    const first = await compileClientContract(bytes);
    const second = await compileClientContract(bytes);

    expect(first).toEqual(second);
    expect(first.counts).toEqual({ consumer: 23, admin: 63 });
    expect(first.files["packages/client/src/generated/consumer/digest.ts"]).toContain(first.digest);
    expect(first.files["packages/client/src/generated/consumer/digest.ts"]).toContain(
      'export const BEARER_TOKEN_CONTRACT = {\n  "encoding": "ascii",\n  "max_bytes": 4096,',
    );
    expect(first.files["packages/client/src/generated/admin/operations.ts"]).toContain("reconcilePreserving");
    expect(first.files["packages/client/src/generated/admin/operations.ts"]).not.toMatch(/\breconcile\(/u);
    expect(first.files["packages/client/src/generated/admin/operations.ts"]).toContain(
      "export const adminOperationRoutes: AdminOperationRoutes",
    );
    expect(first.files["packages/client/src/generated/admin/operations.ts"]).toContain(
      "readonly receipt: (path: { operationId: string }) => string;",
    );
    expect(first.files["packages/client/src/generated/admin/operations.ts"]).toContain(
      "export const adminOperationRoutes: AdminOperationRoutes = freezeGeneratedOperationRoutes({",
    );
    expect(first.files["packages/client/src/generated/admin/operations.ts"]).toContain(
      'composeGeneratedOperationPath(operationPlans["admin.self-upgrade.receipt"], path).path',
    );
    expect(first.files["packages/client/src/generated/consumer/operations.ts"]).toContain("readonly attention:");
    expect(first.files["packages/client/src/generated/consumer/operations.ts"]).toMatch(/readonly mark: \{[\s\S]*create\([\s\S]*list\([\s\S]*revoke\(/u);
    expect(first.files["packages/client/src/generated/admin/openapi.ts"]).toContain('"attention.mark.revoke"');
    expect(first.files["packages/client/src/generated/admin/openapi.ts"]).not.toContain('"admin.attention.mark');
    expect(first.files["packages/client/src/generated/admin/openapi.ts"]).not.toContain('"/v1/admin/marks');
    expect(first.files["packages/client/src/generated/admin/operations.ts"]).not.toContain("readonly attention:");
    expect(first.files["packages/client/src/generated/consumer/serializers.ts"]).toMatch(
      /"attention\.mark\.revoke": \{[\s\S]*"method": "DELETE"[\s\S]*"requestBody": "none"[\s\S]*"kind": "request_target_identity"/u,
    );
    expect(first.files["packages/client/src/generated/consumer/operations.ts"]).toMatch(
      /send: \(request: \{ body:/u,
    );
    expect(first.files["packages/client/src/generated/consumer/operations.ts"]).not.toMatch(
      /send: \(request = \{\} as/u,
    );
    expect(first.files["packages/client/src/generated/admin/serializers.ts"]).toMatch(/"provenance": requestCodec\d+/u);
    expect(first.files["packages/client/src/generated/consumer/serializers.ts"]).toContain('"errorRequiredHeaderDecoders"');
    expect(first.files["packages/client/src/generated/consumer/serializers.ts"]).toContain(
      '"(?=[\\\\s\\\\S]*(?:^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$))',
    );
    expect(first.files["packages/client/src/generated/consumer/serializers.ts"]).not.toMatch(/SchemaDocument|schemaDocument|\$ref/u);
    expect(first.files["packages/client/src/generated/consumer/serializers.ts"]).toContain('"profile": "consumer_v1"');
    expect(first.files["packages/client/src/generated/consumer/serializers.ts"]).toContain('"surface": "consumer"');
    expect(first.files["packages/client/src/generated/admin/serializers.ts"]).toContain('"profile": "control_plane_admin_v1"');
    expect(first.files["packages/client/src/generated/admin/serializers.ts"]).toContain('"surface": "admin"');
    expect(first.files["packages/client/src/generated/consumer/serializers.ts"]).toContain(
      '"requestTargetMaxBytes": 8000',
    );
    expect(first.files["packages/client/src/generated/consumer/openapi.ts"]).toMatch(
      /role: "human" \| "assistant" \| CalyxUnknownEnumValue/u,
    );
    expect(first.files["packages/client/src/generated/consumer/openapi.ts"]).toMatch(
      /schema_version: "calyx\.msg-send\/v1"/u,
    );
    expect(first.files["packages/client/src/generated/admin/openapi.ts"]).toMatch(
      /"x-calyx-source-tier": "local-transcript" \| "origin-daemon" \| "blade-archive" \| CalyxUnknownEnumValue/u,
    );
    expect(JSON.stringify(first.files)).not.toContain("internal.runtime");
  });

  test("preserves exact-empty response array bounds in generated codecs", async () => {
    const bytes = await readFile(resolve(repoRoot, "calyx-openapi.json"));
    const compiled = await compileClientContract(bytes);

    expect(compiled.files["packages/client/src/generated/admin/openapi.ts"]).toMatch(
      /pending_migrations: string\[\];/u,
    );
    expect(compiled.files["packages/client/src/generated/admin/serializers.ts"]).toMatch(
      /g\.responseArray\(responseCodec\d+, 0, 0\)/u,
    );
  });

  test("consumes the exact daemon bearer-token grammar into both generated surfaces", async () => {
    const document = JSON.parse(await readFile(resolve(repoRoot, "calyx-openapi.json"), "utf8")) as any;
    const contract = buildClientContractIR(Buffer.from(JSON.stringify(document)));

    expect(contract.bearerTokenContract).toEqual({
      encoding: "ascii",
      max_bytes: 4_096,
      pattern: "^[\\x21-\\x2B\\x2D-\\x7E]+$",
    });

    for (const mutation of [
      { encoding: "utf8" },
      { max_bytes: 4_097 },
      { pattern: "^.+$" },
    ]) {
      const drifted = structuredClone(document);
      Object.assign(drifted["x-calyx-bearer-token-contract"], mutation);
      expect(() => buildClientContractIR(Buffer.from(JSON.stringify(drifted))))
        .toThrow(/bearer-token contract/u);
    }
  });

  test("binds recovery to the replay-relevant operation contract, not the whole OpenAPI document", async () => {
    const original = JSON.parse(await readFile(resolve(repoRoot, "calyx-openapi.json"), "utf8")) as any;
    const initial = buildClientContractIR(Buffer.from(JSON.stringify(original)));
    const initialPlan = initial.surfaces.consumer.plans.find((plan: any) => plan.operationId === "msg.send") as any;

    const unrelated = structuredClone(original);
    unrelated.paths["/v1/internal/health"].get.summary = "Unrelated internal-only wording changed.";
    const unrelatedPlan = buildClientContractIR(Buffer.from(JSON.stringify(unrelated)))
      .surfaces.consumer.plans.find((plan: any) => plan.operationId === "msg.send") as any;
    expect(unrelatedPlan.recoveryContractDigest).toBe(initialPlan.recoveryContractDigest);

    const requestDrift = structuredClone(original);
    requestDrift.components.schemas.calyx_msg_send_v1.properties.subject.maxLength += 1;
    const driftedPlan = buildClientContractIR(Buffer.from(JSON.stringify(requestDrift)))
      .surfaces.consumer.plans.find((plan: any) => plan.operationId === "msg.send") as any;
    expect(driftedPlan.recoveryContractDigest).not.toBe(initialPlan.recoveryContractDigest);
  });

  test("refuses exact bytes whose JSON parse would erase numeric or member authority", async () => {
    const document = JSON.parse(await readFile(resolve(repoRoot, "calyx-openapi.json"), "utf8")) as unknown;
    const canonical = JSON.stringify(document);
    const roundedLiteral = canonical.replace('"enum":[0]', '"enum":[1e-400]');
    const roundedNeighbor = canonical.replace('"enum":[0]', '"enum":[0.99999999999999999]');
    const duplicateRootMember = canonical.replace(
      '{"openapi":"3.0.3"',
      '{"openapi":"3.0.3","openapi":"3.0.3"',
    );
    const decodedKeyCollision = canonical.replace(
      '{"openapi":"3.0.3"',
      '{"openapi":"3.0.3","\\u006fpenapi":"3.0.3"',
    );
    const duplicateNestedMember = canonical.replace('"type":"object"', '"type":"object","type":"object"');
    expect(roundedLiteral).not.toBe(canonical);
    expect(roundedNeighbor).not.toBe(canonical);
    expect(duplicateRootMember).not.toBe(canonical);
    expect(decodedKeyCollision).not.toBe(canonical);
    expect(duplicateNestedMember).not.toBe(canonical);

    expect(() => buildClientContractIR(Buffer.from(roundedLiteral))).toThrow(/exact canonical JSON/u);
    expect(() => buildClientContractIR(Buffer.from(roundedNeighbor))).toThrow(/exact canonical JSON/u);
    expect(() => buildClientContractIR(Buffer.from(duplicateRootMember))).toThrow(/exact canonical JSON/u);
    expect(() => buildClientContractIR(Buffer.from(decodedKeyCollision))).toThrow(/exact canonical JSON/u);
    expect(() => buildClientContractIR(Buffer.from(duplicateNestedMember))).toThrow(/exact canonical JSON/u);
    expect(() => buildClientContractIR(Buffer.from(`${canonical}\n`))).toThrow(/exact canonical JSON/u);
  });

  test("emits required query containers and required method arguments from evolved contracts", async () => {
    const document = JSON.parse(await readFile(resolve(repoRoot, "calyx-openapi.json"), "utf8")) as any;
    const operation = document.paths["/v1/activity"].get;
    const parameter = operation.parameters.find((candidate: any) => (
      candidate.in === "query" && candidate.name === "agent_kind"
    ));
    parameter.required = true;
    document.components.schemas.calyx_activity_list_query_v1.required = ["agent_kind"];
    const bytes = Buffer.from(JSON.stringify(document));

    const plan = buildClientContractIR(bytes).surfaces.consumer.plans.find((candidate: any) => (
      candidate.operationId === "activity.list"
    )) as any;
    expect(plan).toMatchObject({ queryRequired: true });

    const compiled = await compileClientContract(bytes);
    const operations = compiled.files["packages/client/src/generated/consumer/operations.ts"];
    expect(operations).toMatch(
      /list\(request: \{[^}]*query: operations\["activity\.list"\]\["parameters"\]\["query"\]/u,
    );
    expect(operations).toMatch(
      /list: \(request: \{[^}]*query: operations\["activity\.list"\]\["parameters"\]\["query"\]/u,
    );
    expect(operations).not.toContain('list(request?: { query: operations["activity.list"]');
    expect(operations).not.toContain('list: (request = {} as { query: operations["activity.list"]');
  });

  test("carries response limits, all header schemas, and custody into the runtime IR", async () => {
    const bytes = await readFile(resolve(repoRoot, "calyx-openapi.json"));
    const contract = buildClientContractIR(bytes);
    const plans = contract.surfaces.admin.plans as any[];

    const finitePlan = plans.find((plan) => plan.operationId === "work.list");
    expect(finitePlan).toMatchObject({
      capability: "work.observe",
      domain: "run",
      effects: {
        kind: "uniform",
        effects: {
          local_files: "read",
          local_state: "read_write",
          process_launch: false,
        },
      },
    });
    const finite = finitePlan.success[0];
    expect(finite).toMatchObject({
      maxBytes: 16 * 1024 * 1024,
      requiredHeaders: ["x-calyx-request-id"],
      headerSchemas: {
        "x-calyx-request-id": {
          type: "string",
        },
      },
    });

    const stream = plans.find((plan) => plan.operationId === "work.observe").success[0];
    expect(stream).toMatchObject({
      maxFrameBytes: 1024 * 1024,
      cursorField: "cursor",
      cursorMaxLength: 512,
    });
    expect(stream).not.toHaveProperty("maxBytes");
    expect(plans.find((plan) => plan.operationId === "work.observe")).toMatchObject({
      profile: "consumer_v1",
      lastEventIdAllowed: true,
      lastEventIdMaxLength: 512,
    });
    expect(contract.surfaces.consumer.plans.find((plan: any) => plan.operationId === "work.observe")).toMatchObject({
      profile: "consumer_v1",
    });

    const activity = plans.find((plan) => plan.operationId === "activity.list");
    expect(activity.requestIdHeaderSchema).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 1024,
      pattern: expect.stringContaining("^req_[0-9a-f]{8}"),
    });
    expect(activity.errorRequiredHeaderSchemas["400"]).toMatchObject({
      "x-calyx-request-id": {
        type: "string",
        minLength: 1,
        maxLength: 1024,
        pattern: expect.stringContaining("^req_[0-9a-f]{8}"),
      },
    });
    expect(activity.errorRequiredHeaderSchemas["401"]).toMatchObject({
      "www-authenticate": {
        type: "string",
        enum: ['Bearer realm="calyx-run"'],
        minLength: 1,
        maxLength: 1024,
      },
      "x-calyx-request-id": {
        type: "string",
        minLength: 1,
        maxLength: 1024,
        pattern: expect.stringContaining("^req_[0-9a-f]{8}"),
      },
    });
    expect(activity.errorRequiredHeaders["401"]).toEqual(["www-authenticate"]);
    expect(activity.errorEnvelopeSchema).toEqual({ $ref: "#/components/schemas/calyx_error_v1" });
    expect(activity.errorSchemas["400"]).toMatchObject({
      allOf: [
        { $ref: "#/components/schemas/calyx_error_v1" },
        { properties: { error: { properties: { code: { type: "string" } } } } },
      ],
    });

    const optionalReferencedHeader = JSON.parse(await readFile(resolve(repoRoot, "calyx-openapi.json"), "utf8")) as any;
    optionalReferencedHeader.components.schemas.test_header_v1 = {
      type: "string",
      minLength: 1,
      maxLength: 1024,
      pattern: "(?=^safe$)^[\\x21-\\x2B\\x2D-\\x7E](?:[\\x20-\\x2B\\x2D-\\x7E]*[\\x21-\\x2B\\x2D-\\x7E])?$",
      "x-calyx-schema-id": "test.header/v1",
      "x-calyx-schema-role": "response",
    };
    optionalReferencedHeader.paths["/v1/activity"].get.responses["503"].headers["X-Optional-Proof"] = {
      required: false,
      schema: { $ref: "#/components/schemas/test_header_v1" },
    };
    const optionalReferencedPlan = buildClientContractIR(
      Buffer.from(JSON.stringify(optionalReferencedHeader)),
    ).surfaces.admin.plans.find((plan: any) => plan.operationId === "activity.list") as any;
    expect(optionalReferencedPlan.errorRequiredHeaderSchemas["503"]["x-optional-proof"]).toEqual({
      $ref: "#/components/schemas/test_header_v1",
    });
    expect(optionalReferencedPlan.errorRequiredHeaders["503"]).not.toContain("x-optional-proof");

    const attachment = plans.find((plan) => plan.operationId === "admin.activity.attachment-bytes").success[0];
    expect(attachment).toMatchObject({
      maxBytes: 64 * 1024 * 1024,
      headerSchemas: {
        "content-length": { type: "integer", maximum: 64 * 1024 * 1024 },
        "x-calyx-source-tier": {
          type: "string",
          "x-calyx-enum-mode": "open",
          "x-calyx-known-values": ["local-transcript", "origin-daemon", "blade-archive"],
        },
      },
      custodyContract: {
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
      },
    });
    expect(attachment.headerSchemas["x-calyx-source-tier"]).not.toHaveProperty("enum");
    expect(attachment.headerSchemas).toMatchObject({
      "x-calyx-origin-host": { type: "string", pattern: expect.any(String) },
      "x-calyx-served-by-host": { type: "string", pattern: expect.any(String) },
    });
    expect(attachment.requiredHeaders).not.toContain("x-calyx-origin-host");
    expect(attachment.requiredHeaders).not.toContain("x-calyx-served-by-host");
    const attachmentHead = plans.find((plan) => plan.operationId === "admin.activity.attachment-bytes-head").success[0];
    expect(attachmentHead.headerSchemas).toMatchObject({
      "x-calyx-origin-host": { type: "string", pattern: expect.any(String) },
      "x-calyx-served-by-host": { type: "string", pattern: expect.any(String) },
    });
    expect(attachmentHead.requiredHeaders).not.toContain("x-calyx-origin-host");
    expect(attachmentHead.requiredHeaders).not.toContain("x-calyx-served-by-host");

    const retryable = [
      "msg.send",
      "admin.run.launch",
      "admin.monitor.create",
      "admin.lease.acquire",
      "admin.lease.release",
      "admin.lease.renew",
      "admin.lease.steal",
    ];
    for (const operationId of retryable) {
      expect(plans.find((plan) => plan.operationId === operationId)).toMatchObject({
        retryAuthority: { kind: "request_body_field", field: "idempotency_key" },
      });
    }
    expect(plans.find((plan) => plan.operationId === "activity.list")).not.toHaveProperty("retryAuthority");
    expect(plans.find((plan) => plan.operationId === "admin.monitor.ack")).not.toHaveProperty("retryAuthority");
    expect(plans.find((plan) => plan.operationId === "admin.lease.list")).not.toHaveProperty("retryAuthority");
  });

  test("fails closed on unknown Calyx extensions and projection contradictions", async () => {
    const original = JSON.parse(await readFile(resolve(repoRoot, "calyx-openapi.json"), "utf8")) as Record<string, unknown>;
    const unknown = structuredClone(original) as any;
    unknown.paths["/v1/activity"].get["x-calyx-future-escape"] = true;
    await expect(compileClientContract(Buffer.from(JSON.stringify(unknown)))).rejects.toThrow(/Unknown Calyx contract extension/u);

    const contradicted = structuredClone(original) as any;
    contradicted.paths["/v1/activity"].get["x-calyx-client-surfaces"] = ["admin"];
    await expect(compileClientContract(Buffer.from(JSON.stringify(contradicted)))).rejects.toThrow(/client omission/u);

    const declaredOmission = structuredClone(contradicted) as any;
    declaredOmission.paths["/v1/activity"].get["x-calyx-client-omission"] = {
      reason: "staged",
      issue: "POL-1989",
      expires_on: "2026-08-31",
    };
    const omittedContract = buildClientContractIR(Buffer.from(JSON.stringify(declaredOmission)));
    expect(omittedContract.counts).toEqual({ consumer: 22, admin: 63 });

    const invalidReason = structuredClone(declaredOmission) as any;
    invalidReason.paths["/v1/activity"].get["x-calyx-client-omission"].reason = "temporary";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(invalidReason)), { expectedCounts: null }))
      .toThrow(/closed lifecycle registry/u);

    const invalidIssue = structuredClone(declaredOmission) as any;
    invalidIssue.paths["/v1/activity"].get["x-calyx-client-omission"].issue = "github#279";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(invalidIssue)), { expectedCounts: null }))
      .toThrow(/canonical POL issue/u);

    const invalidExpiry = structuredClone(declaredOmission) as any;
    invalidExpiry.paths["/v1/activity"].get["x-calyx-client-omission"].expires_on = "2026-02-30";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(invalidExpiry)), { expectedCounts: null }))
      .toThrow(/ISO calendar date/u);

    const missingExpiry = structuredClone(declaredOmission) as any;
    delete missingExpiry.paths["/v1/activity"].get["x-calyx-client-omission"].expires_on;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(missingExpiry)), { expectedCounts: null }))
      .toThrow(/client omission expiry/u);

    const expired = structuredClone(declaredOmission) as any;
    expired.paths["/v1/activity"].get["x-calyx-client-omission"].expires_on = "2000-01-01";
    const expiredBytes = Buffer.from(JSON.stringify(expired));
    expect(() => buildClientContractIR(expiredBytes, { expectedCounts: null })).not.toThrow();
    expect(() => assertClientOmissionPolicy(expiredBytes, "1999-12-31")).not.toThrow();
    expect(() => assertClientOmissionPolicy(expiredBytes, "2000-01-02"))
      .toThrow(/expired on 2000-01-01 as of 2000-01-02/u);
    expect(() => assertClientOmissionPolicy(expiredBytes, "2026-02-30"))
      .toThrow(/asOf must be an ISO calendar date/u);

    const unnecessaryOmission = structuredClone(original) as any;
    unnecessaryOmission.paths["/v1/activity"].get["x-calyx-client-omission"] = {
      reason: "staged",
      issue: "POL-1989",
    };
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(unnecessaryOmission))))
      .toThrow(/without omitting/u);

    const unsafeProjection = structuredClone(original) as any;
    unsafeProjection.paths["/v1/admin/health"].get["x-calyx-client-surfaces"] = ["consumer"];
    unsafeProjection.paths["/v1/admin/health"].get["x-calyx-client-omission"] = {
      reason: "staged",
      issue: "POL-1989",
    };
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(unsafeProjection)), { expectedCounts: null }))
      .toThrow(/forbidden by its profile/u);

    const misplaced = structuredClone(original) as any;
    misplaced.paths["/v1/activity"].get.responses["200"]["x-calyx-profile"] = "consumer_v1";
    await expect(compileClientContract(Buffer.from(JSON.stringify(misplaced)))).rejects.toThrow(
      /unsupported fields: x-calyx-profile/u,
    );

    const nested = structuredClone(original) as any;
    nested.components.schemas.activity_attachments_v1["x-calyx-pagination-contract"]["x-calyx-domain"] = "activity";
    await expect(compileClientContract(Buffer.from(JSON.stringify(nested)))).rejects.toThrow(/unsupported fields/u);

    const consumerPrefix = structuredClone(original) as any;
    consumerPrefix.paths["/v1/activity"].get.operationId = "admin.activity-projection";
    await expect(compileClientContract(Buffer.from(JSON.stringify(consumerPrefix)))).rejects.toThrow(/operationId-prefix\/profile law/u);

    const adminPrefix = structuredClone(original) as any;
    adminPrefix.paths["/v1/admin/health"].get.operationId = "health.admin-projection";
    await expect(compileClientContract(Buffer.from(JSON.stringify(adminPrefix)))).rejects.toThrow(/operationId-prefix\/profile law/u);
  });

  test("rejects every unsupported standard OpenAPI construct before emission", async () => {
    const original = JSON.parse(await readFile(resolve(repoRoot, "calyx-openapi.json"), "utf8")) as any;
    const compileMutation = (mutate: (document: any) => void): Promise<unknown> => {
      const document = structuredClone(original);
      mutate(document);
      return compileClientContract(Buffer.from(JSON.stringify(document)));
    };

    for (const [key, value] of [["style", "deepObject"], ["explode", true], ["allowReserved", true]] as const) {
      await expect(compileMutation((document) => {
        const parameter = document.paths["/v1/activity"].get.parameters.find((candidate: any) => candidate.in === "query");
        parameter[key] = value;
      })).rejects.toThrow(new RegExp(`OpenAPI parameter.*${key}`, "u"));
    }

    await expect(compileMutation((document) => {
      document.paths["/v1/activity"].get.servers = [{ url: "https://example.invalid" }];
    })).rejects.toThrow(/OpenAPI operation.*servers/u);

    await expect(compileMutation((document) => {
      document.paths["/v1/activity"].get.security = [];
    })).rejects.toThrow(/bearerAuth security requirement/u);

    await expect(compileMutation((document) => {
      document.paths["/v1/activity"].get.callbacks = {};
    })).rejects.toThrow(/OpenAPI operation.*callbacks/u);

    await expect(compileMutation((document) => {
      document.paths["/v1/internal/health"].get.servers = [{ url: "https://example.invalid" }];
    })).rejects.toThrow(/OpenAPI operation.*servers/u);

    await expect(compileMutation((document) => {
      document.paths["/v1/admin/monitors"].post.requestBody.content["application/json"].encoding = {};
    })).rejects.toThrow(/OpenAPI request media.*encoding/u);

    await expect(compileMutation((document) => {
      document.paths["/v1/activity"].get.responses["200"].content["application/json"].encoding = {};
    })).rejects.toThrow(/OpenAPI response media.*encoding/u);

    await expect(compileMutation((document) => {
      document.paths["/v1/activity"].get.responses["200"].links = {};
    })).rejects.toThrow(/OpenAPI response.*links/u);

    await expect(compileMutation((document) => {
      document.servers = [{ url: "https://example.invalid" }];
    })).rejects.toThrow(/OpenAPI document.*servers/u);

    await expect(compileMutation((document) => {
      document.paths["/v1/activity"].parameters = [];
    })).rejects.toThrow(/OpenAPI path item.*parameters/u);

    await expect(compileMutation((document) => {
      document.components.callbacks = {};
    })).rejects.toThrow(/OpenAPI components.*callbacks/u);

    await expect(compileMutation((document) => {
      document.paths["/v1/activity"].get.responses["401"].headers["WWW-Authenticate"].style = "simple";
    })).rejects.toThrow(/OpenAPI response header.*style/u);

    await expect(compileMutation((document) => {
      delete document.paths["/v1/activity"].get.responses["401"]["x-calyx-error-codes"];
    })).rejects.toThrow(/non-success response 401 lacks x-calyx-error-codes authority/u);

    await expect(compileMutation((document) => {
      document.paths["/v1/activity"].get.responses["401"].content["text/html"] = {
        schema: { type: "string" },
      };
    })).rejects.toThrow(/error content.*text\/html/u);

    await expect(compileMutation((document) => {
      document.paths["/v1/activity"].get.responses["401"].content["application/json"].schema = {
        type: "string",
      };
    })).rejects.toThrow(/closed calyx\.error\/v1 envelope refinement/u);

    for (const schema of [
      { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
      { type: "boolean" },
      { type: "array", items: { type: "string" } },
    ]) {
      await expect(compileMutation((document) => {
        document.paths["/v1/runs/{runId}"].get.parameters
          .find((parameter: any) => parameter.in === "path").schema = schema;
      })).rejects.toThrow(/path parameter runId must use an inline string schema/u);
    }

    for (const schema of [
      { type: "string", nullable: true },
      { type: "string", anyOf: [{ type: "string" }, { type: "string", minLength: 2 }] },
      { type: "string", minLength: 1 },
    ]) {
      await expect(compileMutation((document) => {
        document.paths["/v1/runs/{runId}"].get.parameters
          .find((parameter: any) => parameter.in === "path").schema = schema;
      })).rejects.toThrow(/path parameter runId/u);
    }

    for (const schema of [
      { type: "string", const: 1 },
      { type: "string", enum: ["run:fixture", 1] },
    ]) {
      await expect(compileMutation((document) => {
        document.paths["/v1/runs/{runId}"].get.parameters
          .find((parameter: any) => parameter.in === "path").schema = schema;
      })).rejects.toThrow(/numeric identity must use a bounded integer/u);
    }

    for (const value of ["", ".", "..", "\ud800", "\udc00"]) {
      await expect(compileMutation((document) => {
        const schema = document.paths["/v1/runs/{runId}"].get.parameters
          .find((parameter: any) => parameter.in === "path").schema;
        schema.const = value;
      })).rejects.toThrow(/path parameter runId has a non-representable literal/u);
    }

    await expect(compileMutation((document) => {
      const schema = document.paths["/v1/runs/{runId}"].get.parameters
        .find((parameter: any) => parameter.in === "path").schema;
      schema.pattern = `^[\\s\\S]*$|${schema.pattern}`;
    })).rejects.toThrow(/not a proven subset of the executable one-segment envelope/u);

    const rawPathName = JSON.parse(await readFile(resolve(repoRoot, "calyx-openapi.json"), "utf8")) as any;
    const rawPathOperation = rawPathName.paths["/v1/runs/{runId}"].get;
    rawPathOperation.parameters.find((parameter: any) => parameter.in === "path").name = "run-id";
    rawPathName.paths["/v1/runs/{run-id}"] = { get: rawPathOperation };
    delete rawPathName.paths["/v1/runs/{runId}"];
    const rawPathCompiled = await compileClientContract(Buffer.from(JSON.stringify(rawPathName)));
    expect(rawPathCompiled.files["packages/client/src/generated/consumer/operations.ts"]).toContain(
      'path: { "run-id": string }',
    );

    for (const schema of [
      { type: "boolean" },
      { type: "number", minimum: 0, maximum: 1 },
      { type: "array", items: { type: "string" } },
      { type: "object", properties: {}, additionalProperties: false },
      { type: "null" },
      { type: "string", nullable: true },
      { type: "string", oneOf: [{ type: "string" }, { type: "string", minLength: 1 }] },
      { type: "integer", minimum: -1, maximum: 64 },
      { type: "integer", minimum: 0 },
      { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER + 1 },
      { type: "integer", minimum: 0, maximum: 64, const: 65 },
      { type: "integer", minimum: 0, maximum: 64, enum: [0, 65] },
    ]) {
      await expect(compileMutation((document) => {
        document.paths["/v1/admin/activity/{activityId}/attachments/{ref}/bytes"]
          .get.responses["200"].headers["content-length"].schema = schema;
      })).rejects.toThrow(/response-header wire grammar|integer schema|integer literal|integer enum/u);
    }

    for (const value of ["snow-雪", "line\nfeed", "nul\0byte", " leading", "trailing ", "joined,value"]) {
      await expect(compileMutation((document) => {
        document.paths["/v1/activity"].get.responses["401"].headers["WWW-Authenticate"].schema.const = value;
      })).rejects.toThrow(/outside the canonical Fetch response-header value envelope/u);
    }

    await expect(compileMutation((document) => {
      document.paths["/v1/activity"].get.responses["401"].headers["WWW-Authenticate"].schema = {
        type: "string",
        minLength: 1,
        maxLength: 1024,
        pattern: "^[\\s\\S]+$",
      };
    })).rejects.toThrow(/not a proven subset of the canonical Fetch response-header value envelope/u);

    await expect(compileMutation((document) => {
      const schema = document.paths["/v1/activity"].get.responses["401"]
        .headers["WWW-Authenticate"].schema;
      schema.pattern = `^[\\s\\S]*$|${schema.pattern}`;
    })).rejects.toThrow(/not a proven subset of the canonical Fetch response-header value envelope/u);

    await expect(compileMutation((document) => {
      const response = document.paths["/v1/activity"].get.responses["401"];
      response.headers["Bad Header"] = response.headers["WWW-Authenticate"];
      delete response.headers["WWW-Authenticate"];
    })).rejects.toThrow(/non-representable header name/u);

    await expect(compileMutation((document) => {
      document.components.schemas.calyx_fixture_bounded_header_v1 = {
        type: "integer",
        minimum: 0,
        maximum: 64,
        "x-calyx-schema-id": "calyx.fixture-bounded-header/v1",
        "x-calyx-schema-role": "response",
      };
      const operation = document.paths["/v1/admin/activity/{activityId}/attachments/{ref}/bytes"].get;
      const reference = {
          $ref: "#/components/schemas/calyx_fixture_bounded_header_v1",
      };
      operation.responses["200"].headers["content-length"].schema = reference;
      operation["x-calyx-success-contracts"][0].headers
        .find((header: any) => header.name === "content-length").schema = reference;
    })).resolves.toBeDefined();
  });

  test("fails on normalized method collisions and ambiguous request unions", async () => {
    const original = JSON.parse(await readFile(resolve(repoRoot, "calyx-openapi.json"), "utf8")) as any;
    const collision = structuredClone(original);
    const copy = structuredClone(collision.paths["/v1/activity"].get);
    copy.operationId = "activity.list";
    collision.paths["/v1/collision"] = { get: copy };
    await expect(compileClientContract(Buffer.from(JSON.stringify(collision)))).rejects.toThrow(/Duplicate operationId/u);

    const ambiguous = structuredClone(original);
    ambiguous.components.schemas.calyx_msg_send_v1.properties.subject = {
      anyOf: [{ type: "string" }, { type: "string", minLength: 1 }],
    };
    await expect(compileClientContract(Buffer.from(JSON.stringify(ambiguous)))).rejects.toThrow(/Ambiguous request anyOf/u);

    const overlappingNumbers = structuredClone(original);
    overlappingNumbers.components.schemas.calyx_msg_send_v1.properties.subject = {
      anyOf: [
        { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
        { type: "number" },
      ],
    };
    await expect(compileClientContract(Buffer.from(JSON.stringify(overlappingNumbers)))).rejects.toThrow(/Ambiguous request anyOf/u);

    const objectDiscriminator = structuredClone(original);
    objectDiscriminator.components.schemas.calyx_msg_send_v1.properties.subject = {
      oneOf: [
        {
          type: "object",
          required: ["kind", "mode", "value"],
          properties: {
            kind: { type: "string", const: "a" },
            mode: { type: "string", const: "shared" },
            value: { type: "string" },
          },
        },
        {
          type: "object",
          required: ["kind", "mode", "value"],
          properties: {
            kind: { type: "string", const: "b" },
            mode: { type: "string", const: "shared" },
            value: { type: "string" },
          },
        },
      ],
    };
    const discriminatedContract = buildClientContractIR(Buffer.from(JSON.stringify(objectDiscriminator)));
    const discriminatedSchemas = discriminatedContract.surfaces.consumer.schemas as any;
    expect(discriminatedSchemas.calyx_msg_send_v1.properties.subject)
      .toMatchObject({
        "x-calyx-generated-discriminator": { property: "kind", values: ["a", "b"] },
      });
    await expect(compileClientContract(Buffer.from(JSON.stringify(objectDiscriminator)))).resolves.toMatchObject({
      counts: { consumer: 23, admin: 63 },
    });

    const openEnumDiscriminator = structuredClone(original);
    openEnumDiscriminator.components.schemas.calyx_msg_send_v1.properties.subject = {
      oneOf: ["a", "b"].map((value) => ({
        type: "object",
        required: ["kind"],
        properties: {
          kind: {
            type: "string",
            enum: [value],
            "x-calyx-enum-mode": "open",
            "x-calyx-known-values": [value],
          },
        },
      })),
    };
    await expect(compileClientContract(Buffer.from(JSON.stringify(openEnumDiscriminator))))
      .rejects.toThrow(/Request schema cannot carry an open enum/u);
  });

  test("distinguishes typed dictionaries from explicit arbitrary JSON maps", async () => {
    const original = JSON.parse(await readFile(resolve(repoRoot, "calyx-openapi.json"), "utf8")) as any;
    const typed = original.components.schemas.calyx_run_launch_portable_request_v1.properties.intent.properties;
    expect(typed.template_vars.additionalProperties).toEqual({ type: "string" });
    expect(typed.host_process.properties.env.additionalProperties).toEqual({ type: "string", nullable: true });
    await expect(compileClientContract(Buffer.from(JSON.stringify(original)))).resolves.toMatchObject({
      counts: { consumer: 23, admin: 63 },
    });

    const unmarkedTrue = structuredClone(original);
    unmarkedTrue.components.schemas.calyx_run_launch_portable_request_v1.properties.intent.properties.template_vars.additionalProperties = true;
    await expect(compileClientContract(Buffer.from(JSON.stringify(unmarkedTrue)))).rejects.toThrow(
      /lacks explicit-json-metadata mode/u,
    );

    const unmarkedEmpty = structuredClone(original);
    unmarkedEmpty.components.schemas.calyx_run_launch_portable_request_v1.properties.intent.properties.template_vars.additionalProperties = {};
    await expect(compileClientContract(Buffer.from(JSON.stringify(unmarkedEmpty)))).rejects.toThrow(
      /lacks explicit-json-metadata mode/u,
    );
  });

  test("fails closed on drift in effects, bounds, header schemas, and custody", async () => {
    const original = JSON.parse(await readFile(resolve(repoRoot, "calyx-openapi.json"), "utf8")) as any;

    const capability = structuredClone(original);
    capability.paths["/v1/activity"].get["x-calyx-capability"] = "";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(capability)))).toThrow(/capability must be a non-empty string/u);

    const domain = structuredClone(original);
    delete domain.paths["/v1/activity"].get["x-calyx-domain"];
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(domain)))).toThrow(/domain must be a non-empty string/u);

    const effects = structuredClone(original);
    effects.paths["/v1/activity"].get.responses["200"]["x-calyx-effects"].local_files = "write";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(effects)))).toThrow(/uniform effects drift/u);

    const bounds = structuredClone(original);
    bounds.paths["/v1/runs"].get.responses["200"]["x-calyx-max-bytes"] += 1;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(bounds)))).toThrow(/finite response bound drifted/u);

    const headers = structuredClone(original);
    headers.paths["/v1/admin/activity/{activityId}/attachments/{ref}/bytes"].get.responses["200"]
      .headers["content-length"].schema.maximum -= 1;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(headers)))).toThrow(/header content-length drifted/u);

    const custody = structuredClone(original);
    const custodyResponse = custody.paths["/v1/admin/activity/{activityId}/attachments/{ref}/bytes"].get.responses["200"];
    custodyResponse["x-calyx-custody-contract"].bindings.pop();
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(custody)))).toThrow(/success custody drift/u);

    const inventedAuthority = structuredClone(original);
    const inventedAuthorityOperation = inventedAuthority
      .paths["/v1/admin/activity/{activityId}/attachments/{ref}/bytes"].get;
    inventedAuthorityOperation.responses["200"]["x-calyx-custody-contract"].authority_operation_id =
      "admin.activity.attachment-record";
    inventedAuthorityOperation["x-calyx-success-contracts"][0].custody = structuredClone(
      inventedAuthorityOperation.responses["200"]["x-calyx-custody-contract"],
    );
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(inventedAuthority)))).toThrow(
      /custody contract has unsupported fields: authority_operation_id/u,
    );

    const inventedBinding = structuredClone(original);
    const inventedBindingOperation = inventedBinding
      .paths["/v1/admin/activity/{activityId}/attachments/{ref}/bytes"].get;
    inventedBindingOperation.responses["200"]["x-calyx-custody-contract"].bindings.push({
      source: "authority.sha256",
      target: "response.header.digest",
      relation: "sha256_base64",
    });
    inventedBindingOperation["x-calyx-success-contracts"][0].custody = structuredClone(
      inventedBindingOperation.responses["200"]["x-calyx-custody-contract"],
    );
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(inventedBinding)))).toThrow(
      /custody bindings do not exactly match/u,
    );

    const responseRequestSchema = structuredClone(original);
    responseRequestSchema.paths["/v1/admin/runs"].post.responses["202"]["x-calyx-request-schema"] = "calyx.wrong/v1";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(responseRequestSchema)))).toThrow(/response request schema drift/u);
  });

  test("compiles retry authority only from a required bounded top-level request field", async () => {
    const original = JSON.parse(await readFile(resolve(repoRoot, "calyx-openapi.json"), "utf8")) as any;
    const operation = (document: any): any => document.paths["/v1/admin/monitors"].post;
    const request = (document: any): any => document.components.schemas.calyx_monitor_create_request_v1;

    const missing = structuredClone(original);
    delete request(missing).properties.idempotency_key;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(missing)))).toThrow(
      /retry authority field does not resolve field idempotency_key/u,
    );

    const optional = structuredClone(original);
    request(optional).required = request(optional).required.filter((field: string) => field !== "idempotency_key");
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(optional)))).toThrow(
      /retry authority field is not required across every schema branch/u,
    );

    const renamed = structuredClone(original);
    operation(renamed)["x-calyx-retry-authority"].field = "renamed_idempotency_key";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(renamed)))).toThrow(
      /retry authority field does not resolve field renamed_idempotency_key/u,
    );

    const nested = structuredClone(original);
    operation(nested)["x-calyx-retry-authority"].field = "intent.idempotency_key";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(nested)))).toThrow(
      /retry authority field is not a supported field name/u,
    );

    const wrongType = structuredClone(original);
    request(wrongType).properties.idempotency_key = { type: "integer", minimum: 1, maximum: 256 };
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(wrongType)))).toThrow(
      /retry authority field must resolve to string, not integer/u,
    );

    const nullable = structuredClone(original);
    request(nullable).properties.idempotency_key.nullable = true;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(nullable)))).toThrow(
      /retry authority field must not be nullable across any schema branch/u,
    );

    const unbounded = structuredClone(original);
    delete request(unbounded).properties.idempotency_key.maxLength;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(unbounded)))).toThrow(
      /retry authority field is not a bounded nonempty string/u,
    );

    const empty = structuredClone(original);
    delete request(empty).properties.idempotency_key.minLength;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(empty)))).toThrow(
      /retry authority field is not a bounded nonempty string/u,
    );

    const undeclared = structuredClone(original);
    delete operation(undeclared)["x-calyx-retry-authority"];
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(undeclared)))).toThrow(
      /declares retryable mutation semantics without retry authority/u,
    );

    const readAuthority = structuredClone(original);
    readAuthority.paths["/v1/activity"].get["x-calyx-retry-authority"] = {
      kind: "request_body_field",
      field: "idempotency_key",
    };
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(readAuthority)))).toThrow(
      /retry authority requires a JSON request body/u,
    );

    const unkeyedWriteAuthority = structuredClone(original);
    unkeyedWriteAuthority.paths["/v1/admin/monitors/wakes/{wakeId}/ack"].post["x-calyx-retry-authority"] = {
      kind: "request_body_field",
      field: "idempotency_key",
    };
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(unkeyedWriteAuthority)))).toThrow(
      /retry authority contradicts its mutation semantics/u,
    );

    const reconcile = original.paths["/v1/admin/runs/reconcile-preserving/v1"].post;
    expect(reconcile["x-calyx-retry-authority"]).toEqual({ kind: "operation_identity" });
    expect(reconcile["x-calyx-success-contracts"][0].semantics.mutation).toBe("idempotent_write");

    const bodyfulOperationIdentity = structuredClone(original);
    bodyfulOperationIdentity.paths["/v1/admin/monitors"].post["x-calyx-retry-authority"] = {
      kind: "operation_identity",
    };
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(bodyfulOperationIdentity)))).toThrow(
      /operation-identity retry authority requires a bodyless POST request/u,
    );

    const readOperationIdentity = structuredClone(original);
    readOperationIdentity.paths["/v1/activity"].get["x-calyx-retry-authority"] = {
      kind: "operation_identity",
    };
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(readOperationIdentity)))).toThrow(
      /operation-identity retry authority requires a bodyless POST request/u,
    );

    const streamingOperationIdentity = structuredClone(original);
    const streamingReconcile = streamingOperationIdentity
      .paths["/v1/admin/runs/reconcile-preserving/v1"].post;
    streamingReconcile["x-calyx-success-contracts"][0].representation = "bytes";
    streamingReconcile["x-calyx-success-contracts"][0].media_type = "application/octet-stream";
    streamingReconcile.responses["200"].content = {
      "application/octet-stream": { schema: { type: "string", format: "binary" } },
    };
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(streamingOperationIdentity)))).toThrow(
      /operation-identity retry authority requires finite JSON success representations/u,
    );

    const revoke = original.paths["/v1/marks/{markId}"].delete;
    expect(revoke["x-calyx-retry-authority"]).toEqual({ kind: "request_target_identity" });
    const revokePlan = buildClientContractIR(Buffer.from(JSON.stringify(original)))
      .surfaces.consumer.plans.find((plan: any) => plan.operationId === "attention.mark.revoke") as any;
    expect(revokePlan).toMatchObject({
      method: "DELETE",
      pathTemplate: "/v1/marks/{markId}",
      requestBody: "none",
      retryAuthority: { kind: "request_target_identity" },
      pathParameters: { markId: { type: "string", minLength: 41, maxLength: 41 } },
    });

    const bodyfulDelete = structuredClone(original);
    const bodyfulRevoke = bodyfulDelete.paths["/v1/marks/{markId}"].delete;
    const create = bodyfulDelete.paths["/v1/marks"].post;
    bodyfulRevoke["x-calyx-request-transport"] = structuredClone(create["x-calyx-request-transport"]);
    bodyfulRevoke.requestBody = structuredClone(create.requestBody);
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(bodyfulDelete)))).toThrow(
      /request-target retry authority requires a bodyless DELETE request/u,
    );

    const queriedDelete = structuredClone(original);
    queriedDelete.paths["/v1/marks/{markId}"].delete.parameters.push({
      name: "kind",
      in: "query",
      required: false,
      schema: { type: "string", minLength: 1, maxLength: 64 },
    });
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(queriedDelete)))).toThrow(
      /generated DELETE transport cannot send/u,
    );

    const nonemptyDeleteRequest = structuredClone(original);
    nonemptyDeleteRequest.components.schemas.calyx_review_delete_request_v1 = {
      type: "object",
      properties: {
        silently_dropped: { type: "string", minLength: 1, maxLength: 32 },
      },
      required: ["silently_dropped"],
      "x-calyx-unknown-field-policy": "ignore",
      "x-calyx-schema-id": "calyx.review-delete-request/v1",
      "x-calyx-schema-role": "request",
    };
    nonemptyDeleteRequest.paths["/v1/marks/{markId}"].delete["x-calyx-request-schema"] =
      "calyx.review-delete-request/v1";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(nonemptyDeleteRequest)))).toThrow(
      /bodyless transport requires an exactly empty request schema/u,
    );

    const targetlessDelete = structuredClone(original);
    const targetlessRevoke = targetlessDelete.paths["/v1/marks/{markId}"].delete;
    targetlessRevoke.parameters = targetlessRevoke.parameters.filter((parameter: any) => parameter.in !== "path");
    targetlessDelete.paths["/v1/marks/revoke-fixture"] = { delete: targetlessRevoke };
    delete targetlessDelete.paths["/v1/marks/{markId}"];
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(targetlessDelete)))).toThrow(
      /request-target retry authority requires a validated path parameter/u,
    );

    const authoritylessDelete = structuredClone(original);
    const authoritylessRevoke = authoritylessDelete.paths["/v1/marks/{markId}"].delete;
    delete authoritylessRevoke["x-calyx-retry-authority"];
    authoritylessRevoke["x-calyx-success-contracts"][0].semantics.mutation = "read";
    authoritylessRevoke.responses["200"]["x-calyx-semantics"].mutation = "read";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(authoritylessDelete)))).toThrow(
      /generated DELETE transport requires request-target retry authority/u,
    );
  });

  test("fails closed on schema policy, cross-field, and open-known-value drift", async () => {
    const original = JSON.parse(await readFile(resolve(repoRoot, "calyx-openapi.json"), "utf8")) as any;

    const policy = structuredClone(original);
    policy.components.schemas.activity_attachments_v1["x-calyx-unknown-field-policy"] = "ignore";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(policy)))).toThrow(/response unknown-field policy/u);

    const crossField = structuredClone(original);
    crossField.components.schemas.activity_attachments_v1["x-calyx-cross-field-contract"].future_law = {};
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(crossField)))).toThrow(/unsupported fields/u);

    const unresolvedMarkEquality = structuredClone(original);
    unresolvedMarkEquality.components.schemas.calyx_activity_mark_v1["x-calyx-cross-field-contract"]
      .activity_mark_authority.equalities[0].right = "created_provenance.missing";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(unresolvedMarkEquality)))).toThrow(
      /does not resolve field missing/u,
    );

    const unsafeMarkLine = structuredClone(original);
    unsafeMarkLine.components.schemas.calyx_activity_mark_v1["x-calyx-cross-field-contract"]
      .activity_mark_authority.target_identity.source_line_maximum = Number.MAX_SAFE_INTEGER + 1;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(unsafeMarkLine)))).toThrow(
      /source line maximum is not a positive safe integer/u,
    );

    const unsupportedKeyword = structuredClone(original);
    unsupportedKeyword.components.schemas.calyx_message_doctor_v1.properties.subject.multipleOf = 2;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(unsupportedKeyword)))).toThrow(
      /unsupported keywords.*multipleOf/u,
    );

    for (const requestTargetMaxBytes of [undefined, 0, 8001, 16_384]) {
      const requestTarget = structuredClone(original);
      if (requestTargetMaxBytes === undefined) delete requestTarget["x-calyx-request-target-max-bytes"];
      else requestTarget["x-calyx-request-target-max-bytes"] = requestTargetMaxBytes;
      expect(() => buildClientContractIR(Buffer.from(JSON.stringify(requestTarget)))).toThrow(
        /maximum request-target bytes/u,
      );
    }

    const unknownFormat = structuredClone(original);
    unknownFormat.components.schemas.calyx_message_doctor_v1.properties.subject.format = "uuid";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(unknownFormat)))).toThrow(
      /format uuid is not executable/u,
    );

    const nonStringFormat = structuredClone(original);
    nonStringFormat.components.schemas.calyx_message_doctor_v1.properties.counts.properties.total.format = "uri";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(nonStringFormat)))).toThrow(
      /format uri is not executable/u,
    );

    const wideDateTime = structuredClone(original);
    delete wideDateTime.components.schemas.calyx_run_observation_v1.anyOf[0].properties.created_at.pattern;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(wideDateTime)))).toThrow(
      /date-time schema is wider than the canonical UTC wire grammar/u,
    );

    const unboundedInteger = structuredClone(original);
    delete unboundedInteger.components.schemas.calyx_message_doctor_v1.properties.counts.properties.total.maximum;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(unboundedInteger)))).toThrow(
      /integer schema lacks a closed safe-integer envelope/u,
    );

    const unsafeIntegerLiteral = structuredClone(original);
    unsafeIntegerLiteral.components.schemas.calyx_message_doctor_v1.properties.counts.properties.total.const = (
      Number.MAX_SAFE_INTEGER + 1
    );
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(unsafeIntegerLiteral)))).toThrow(
      /integer schema has an unsafe literal/u,
    );

    const outOfBoundsIntegerLiteral = structuredClone(original);
    outOfBoundsIntegerLiteral.components.schemas.calyx_message_doctor_v1.properties.counts.properties.total.const = -1;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(outOfBoundsIntegerLiteral)))).toThrow(
      /integer schema has an out-of-bounds literal/u,
    );

    const nonIntegralNumericIdentity = structuredClone(original);
    const numericIdentity = nonIntegralNumericIdentity.components.schemas.calyx_message_doctor_v1
      .properties.counts.properties.total;
    numericIdentity.type = "number";
    numericIdentity.const = 0.5;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(nonIntegralNumericIdentity)))).toThrow(
      /numeric identity must use a bounded integer or a separately designed canonical decimal-string contract/u,
    );

    for (const [keyword, literal] of [["const", 0.5], ["enum", [0.5]]] as const) {
      const typelessNumericIdentity = structuredClone(original);
      const typeless = typelessNumericIdentity.components.schemas.calyx_message_doctor_v1
        .properties.counts.properties.total;
      delete typeless.type;
      Object.assign(typeless, { [keyword]: literal });
      expect(() => buildClientContractIR(Buffer.from(JSON.stringify(typelessNumericIdentity)))).toThrow(
        /numeric identity must use a bounded integer or a separately designed canonical decimal-string contract/u,
      );
    }

    for (const [keyword, literal] of [["const", 0], ["enum", [0]]] as const) {
      const emptyIntegerLiteral = structuredClone(original);
      Object.assign(
        emptyIntegerLiteral.components.schemas.calyx_message_doctor_v1.properties.counts.properties.total,
        { minimum: 0, maximum: 0, exclusiveMaximum: true, [keyword]: literal },
      );
      expect(() => buildClientContractIR(Buffer.from(JSON.stringify(emptyIntegerLiteral)))).toThrow(
        new RegExp(`integer schema has an out-of-bounds ${keyword === "const" ? "literal" : "enum member"}`, "u"),
      );
    }

    const unusedBinaryMedia = structuredClone(original);
    unusedBinaryMedia.paths["/v1/runs/{runId}"].get.responses["200"].content["application/x-unused-binary"] = {
      schema: { type: "string", format: "binary" },
    };
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(unusedBinaryMedia)))).toThrow(
      /binary schema lacks declared bytes-success authority/u,
    );

    const inlineHeaderKeyword = structuredClone(original);
    inlineHeaderKeyword.paths["/v1/admin/activity/{activityId}/attachments/{ref}/bytes"].get.responses["200"]
      .headers["content-length"].schema.multipleOf = 1;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(inlineHeaderKeyword)))).toThrow(
      /unsupported keywords.*multipleOf/u,
    );

    const inlineErrorKeyword = structuredClone(original);
    const inlineErrorMedia = inlineErrorKeyword.paths["/v1/activity"].get.responses["400"].content["application/json"];
    inlineErrorMedia.schema = { allOf: [inlineErrorMedia.schema, { type: "object", multipleOf: 1 }] };
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(inlineErrorKeyword)))).toThrow(
      /unsupported keywords.*multipleOf/u,
    );

    const inlineErrorEnum = structuredClone(original);
    const inlineErrorCode = inlineErrorEnum.paths["/v1/activity"].get.responses["400"]
      .content["application/json"].schema.allOf[1].properties.error.properties.code;
    delete inlineErrorCode["x-calyx-enum-mode"];
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(inlineErrorEnum)))).toThrow(
      /Enum metadata lacks x-calyx-enum-mode/u,
    );

    const inlinePagination = structuredClone(original);
    inlinePagination.paths["/v1/activity"].get.responses["400"].content["application/json"]
      .schema["x-calyx-pagination-contract"] = { items_field: "missing" };
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(inlinePagination)))).toThrow(
      /Pagination items field drift/u,
    );

    const omittedInternalKeyword = structuredClone(original);
    omittedInternalKeyword.paths["/v1/internal/messages/receive"].post.parameters[0].schema.multipleOf = 1;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(omittedInternalKeyword)))).not.toThrow();

    const arrayType = structuredClone(original);
    arrayType.components.schemas.calyx_message_doctor_v1.properties.subject.type = ["string", "null"];
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(arrayType)))).toThrow(/unsupported type shape/u);

    const numericExclusiveMinimum = structuredClone(original);
    numericExclusiveMinimum.components.schemas.calyx_message_doctor_v1.properties.subject.exclusiveMinimum = 1;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(numericExclusiveMinimum)))).toThrow(
      /exclusiveMinimum must use the OpenAPI boolean form/u,
    );

    const openTuple = structuredClone(original);
    delete openTuple.components.schemas.calyx_message_text_v1.properties.text_cursor.properties.returned.maxItems;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(openTuple)))).toThrow(/exact generated length/u);

    const mismatchedClosure = structuredClone(original);
    mismatchedClosure.components.schemas.calyx_run_observation_event_v1.anyOf[1]["x-calyx-unknown-field-policy"] = "preserve";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(mismatchedClosure)))).toThrow(
      /Closed response object lacks reject unknown-field policy/u,
    );

    const scalarRequired = structuredClone(original);
    scalarRequired.components.schemas.calyx_message_doctor_v1.properties.subject.required = ["value"];
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(scalarRequired)))).toThrow(
      /required is only supported for object schemas/u,
    );

    const nullableLiteral = structuredClone(original);
    const nullableSubject = nullableLiteral.components.schemas.calyx_message_doctor_v1.properties.subject;
    nullableSubject.nullable = true;
    nullableSubject.const = "switchboard";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(nullableLiteral)))).toThrow(
      /combines nullability with unsupported literal semantics/u,
    );

    const unsupportedScalarPath = structuredClone(original);
    unsupportedScalarPath.components.schemas.calyx_admin_reconcile_result_v1["x-calyx-cross-field-contract"]
      .unresolved_histogram.equals = "changed[*].unresolved";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(unsupportedScalarPath)))).toThrow(
      /not a supported scalar path/u,
    );

    const knownValues = structuredClone(original);
    knownValues.paths["/v1/admin/activity/{activityId}/attachments/{ref}/bytes"].get.responses["200"]
      .headers["x-calyx-source-tier"].schema["x-calyx-known-values"].push("local-transcript");
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(knownValues)))).toThrow(/open-enum known-values contract/u);

    const openRequestEnum = structuredClone(original);
    openRequestEnum.components.schemas.calyx_activity_attachment_query_v1.properties.turn = {
      type: "string",
      enum: ["latest"],
      "x-calyx-enum-mode": "open",
      "x-calyx-known-values": ["latest"],
    };
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(openRequestEnum)))).toThrow(
      /Request schema cannot carry an open enum/u,
    );
  });

  test("resolves cross-field selectors through every response branch and transitive reference", async () => {
    const original = JSON.parse(await readFile(resolve(repoRoot, "calyx-openapi.json"), "utf8")) as any;

    const vacuous = structuredClone(original);
    vacuous.components.schemas.activity_attachments_v1["x-calyx-cross-field-contract"]
      .attachment_identity.object_path = "missing[*]";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(vacuous)))).toThrow(/does not resolve field missing/u);

    const wrongTerminal = structuredClone(original);
    wrongTerminal.components.schemas.calyx_admin_activity_attachment_record_v1["x-calyx-cross-field-contract"]
      .attachment_identity.sha256_field = "byte_size";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(wrongTerminal)))).toThrow(/must resolve to string, not integer/u);

    const unresolvedHistogram = structuredClone(original);
    unresolvedHistogram.components.schemas.calyx_admin_reconcile_result_v1["x-calyx-cross-field-contract"]
      .unresolved_histogram.equals = "changed.missing";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(unresolvedHistogram)))).toThrow(/does not resolve field missing/u);

    const transitiveMismatch = structuredClone(original);
    transitiveMismatch.components.schemas.calyx_admin_activity_attachment_record_v1.properties.ref = {
      $ref: "#/components/schemas/calyx_admin_activity_get_v1",
    };
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(transitiveMismatch)))).toThrow(/must resolve to string, not object/u);
  });

  test("requires SSE cursor authority and finite replay header bounds", async () => {
    const original = JSON.parse(await readFile(resolve(repoRoot, "calyx-openapi.json"), "utf8")) as any;

    const missingCursorExtension = structuredClone(original);
    delete missingCursorExtension.paths["/v1/events/observe"].get.responses["200"]
      .content["text/event-stream"]["x-calyx-sse-cursor-field"];
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(missingCursorExtension)))).toThrow(/SSE cursor field/u);

    const optionalCursor = structuredClone(original);
    optionalCursor.components.schemas.calyx_run_observation_event_v1.anyOf[0].required = optionalCursor.components.schemas
      .calyx_run_observation_event_v1.anyOf[0].required.filter((field: string) => field !== "cursor");
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(optionalCursor)))).toThrow(/not required across every schema branch/u);

    const missingReplayBound = structuredClone(original);
    const replayHeader = missingReplayBound.paths["/v1/events/observe"].get.parameters.find(
      (parameter: any) => parameter.name === "Last-Event-ID",
    );
    delete replayHeader.schema.maxLength;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(missingReplayBound)))).toThrow(/Last-Event-ID contract is incomplete/u);

    const unboundedEventCursor = structuredClone(original);
    delete unboundedEventCursor.components.schemas.calyx_stream_event_v1.anyOf[0].properties.cursor.maxLength;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(unboundedEventCursor)))).toThrow(
      /SSE cursor schema is not a subset of its Last-Event-ID length contract/u,
    );

    const oversizedEventCursor = structuredClone(original);
    oversizedEventCursor.components.schemas.calyx_stream_event_v1.anyOf[0].properties.cursor.maxLength = 513;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(oversizedEventCursor)))).toThrow(
      /SSE cursor schema is not a subset of its Last-Event-ID length contract/u,
    );

    const replayPatternWithoutProof = structuredClone(original);
    const adminReplayHeader = replayPatternWithoutProof.paths["/v1/admin/events/stream"].get.parameters.find(
      (parameter: any) => parameter.name === "Last-Event-ID",
    );
    adminReplayHeader.schema.pattern = "^[A-Za-z0-9_-]+$";
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(replayPatternWithoutProof)))).toThrow(
      /SSE cursor schema is not a proven subset of its Last-Event-ID pattern contract/u,
    );

    const replayPatternWithProof = structuredClone(original);
    const provedAdminReplayHeader = replayPatternWithProof.paths["/v1/admin/events/stream"].get.parameters.find(
      (parameter: any) => parameter.name === "Last-Event-ID",
    );
    provedAdminReplayHeader.schema.pattern = "^evt-[0-9]+$";
    for (const variant of replayPatternWithProof.components.schemas.calyx_stream_event_v1.anyOf) {
      variant.properties.cursor.pattern = "^evt-[0-9]+$";
    }
    const replayContract = buildClientContractIR(Buffer.from(JSON.stringify(replayPatternWithProof)));
    expect(replayContract.surfaces.admin.plans.find((plan: any) => plan.operationId === "admin.events"))
      .toMatchObject({
        lastEventIdPattern: "^evt-[0-9]+$",
        success: [{ cursorPattern: "^evt-[0-9]+$" }],
      });

    const nullableEventCursor = structuredClone(original);
    nullableEventCursor.components.schemas.calyx_stream_event_v1.anyOf[0].properties.cursor.nullable = true;
    expect(() => buildClientContractIR(Buffer.from(JSON.stringify(nullableEventCursor)))).toThrow(
      /SSE cursor field must not be nullable/u,
    );
  });
});
