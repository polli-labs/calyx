import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, test } from "vitest";

import {
  HTTP_OPERATION_DESCRIPTORS,
  assertHttpOperationErrorDeclared,
  encodeCalyxSseFrame,
  encodeCalyxSseFrameData,
  resolveHttpOperation,
} from "../http-operations";
import {
  INTERFACE_CAPABILITY_CONTRACTS,
  findInterfaceCapabilityContract,
} from "../interface-capabilities";
import type { InterfaceCapabilityEffectSet } from "../interface-capabilities";
import { API_ASSERTED_ACTOR_PATTERN_SOURCE } from "../state/provenance";
import {
  INTERFACE_DOMAIN_CLASSIFICATIONS,
  INTERFACE_MANIFEST_RECORDS,
} from "../interface-manifest";
import type { InterfaceManifestRecord } from "../interface-manifest";

function containsRawFetchIdentifier(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === "fetch") {
      found = true;
      return;
    }
    if (
      ts.isElementAccessExpression(node)
      && node.argumentExpression
      && ts.isStringLiteral(node.argumentExpression)
      && node.argumentExpression.text === "fetch"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe("HTTP operation descriptors", () => {
  test("uses one injection-safe canonical SSE encoder for admission and delivery", () => {
    const cursor = "z1-00000000000000000001";
    const data = JSON.stringify({ cursor, summary: "line one\nline two" });
    expect(encodeCalyxSseFrame(cursor, JSON.parse(data))).toBe(
      encodeCalyxSseFrameData(cursor, data),
    );
    expect(encodeCalyxSseFrameData(cursor, data)).toBe(
      `id: ${cursor}\ndata: ${data}\n\n`,
    );
    expect(() => encodeCalyxSseFrameData("bad\ncursor", data)).toThrow("single-line");
    expect(() => encodeCalyxSseFrame(cursor, undefined)).toThrow("JSON-serializable");
  });

  test("pins the complete mutation set and injects one canonical attribution header plus fail-closed audit error", () => {
    const mutations = HTTP_OPERATION_DESCRIPTORS.filter((operation) => (
      operation.successes.every((success) => success.semantics.mutation !== "read")
    ));
    expect(mutations.map((operation) => operation.operation_id)).toEqual([
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
    for (const operation of HTTP_OPERATION_DESCRIPTORS) {
      const semanticClasses = new Set(operation.successes.map((success) => (
        success.semantics.mutation === "read" ? "read" : "mutation"
      )));
      expect([...semanticClasses], operation.operation_id).toHaveLength(1);
      const actorHeaders = operation.request_headers?.filter((header) => header.name === "X-Calyx-Asserted-Actor") ?? [];
      if (mutations.includes(operation)) {
        expect(actorHeaders, operation.operation_id).toEqual([expect.objectContaining({
          required: false,
          schema: expect.objectContaining({ pattern: API_ASSERTED_ACTOR_PATTERN_SOURCE }),
        })]);
        expect(operation.errors, operation.operation_id).toContainEqual({
          status: 503,
          code: "provenance_audit_unavailable",
        });
      } else {
        expect(actorHeaders, operation.operation_id).toEqual([]);
      }
    }
    expect(HTTP_OPERATION_DESCRIPTORS.find((operation) => operation.operation_id === "lease.list")?.successes)
      .toSatisfy((successes: typeof HTTP_OPERATION_DESCRIPTORS[number]["successes"]) => (
        successes.every((success) => success.semantics.mutation === "read")
      ));
    expect(HTTP_OPERATION_DESCRIPTORS.some((operation) => operation.path.startsWith("/v1/admin/runtime-config")))
      .toBe(false);
    expect(resolveHttpOperation("POST", "/v1/admin/runs/reconcile")).toBeUndefined();
  });

  test("names read projections for every client-visible unkeyed stateful write", () => {
    const expected = new Map<string, readonly string[]>([
      ["admin.msg.forward", ["admin.msg.operation"]],
      ["admin.run.stop", ["admin.run.get"]],
      ["admin.monitor.ack", ["admin.monitor.wakes"]],
      ["admin.monitor.cancel", ["admin.monitor.get"]],
    ]);
    const unkeyedStatefulWrites = HTTP_OPERATION_DESCRIPTORS.filter((operation) => (
      operation.client_surfaces.length > 0
      && operation.successes.some((success) => success.semantics.mutation === "stateful_write")
    ));

    expect(unkeyedStatefulWrites.map((operation) => operation.operation_id)).toEqual([...expected.keys()]);
    for (const operation of unkeyedStatefulWrites) {
      expect(operation.successes.map((success) => success.semantics.reconciliation_operation_ids))
        .toEqual(operation.successes.map(() => expected.get(operation.operation_id)));
    }
    expect(HTTP_OPERATION_DESCRIPTORS.find((operation) => (
      operation.operation_id === "admin.session-wake.deliver"
    ))?.retry_authority).toEqual({ kind: "request_body_field", field: "delivery_id" });
  });

  test("are unique and obey the path-prefix profile law", () => {
    const operationIds = new Set<string>();
    const methodPaths = new Set<string>();
    const domainCatalog = new Set(INTERFACE_DOMAIN_CLASSIFICATIONS.map((entry) => entry.domain));

    for (const operation of HTTP_OPERATION_DESCRIPTORS) {
      expect(operationIds.has(operation.operation_id), operation.operation_id).toBe(false);
      operationIds.add(operation.operation_id);
      const methodPath = `${operation.method} ${operation.path}`;
      expect(methodPaths.has(methodPath), methodPath).toBe(false);
      methodPaths.add(methodPath);

      const expectedProfile = operation.path.startsWith("/v1/admin/")
        ? "control_plane_admin_v1"
        : operation.path.startsWith("/v1/internal/")
          ? "internal_runtime"
          : "consumer_v1";
      expect(operation.profile, methodPath).toBe(expectedProfile);
      expect(resolveHttpOperation(operation.method, operation.path.replaceAll(/\{[^}]+\}/g, "probe"))?.operation_id)
        .toBe(operation.operation_id);
      expect(operation.capability, operation.operation_id).toMatch(/\S/);
      expect(operation.domain, operation.operation_id).toMatch(/\S/);
      expect(domainCatalog, `${operation.operation_id} uses an unclassified domain`).toContain(operation.domain);
      if (operation.effects.kind === "by_success") {
        expect(operation.effects.branches.map((branch) => ({
          status: branch.status,
          condition: branch.condition,
        })), operation.operation_id).toEqual(operation.successes.map((success) => ({
          status: success.status,
          condition: success.condition,
        })));
      }
    }
  });

  test("projects every HTTP capability from the canonical receiver contract", () => {
    for (const operation of HTTP_OPERATION_DESCRIPTORS) {
      const registered = findInterfaceCapabilityContract(operation.capability);
      expect(registered, `${operation.operation_id} uses an unregistered capability`).toBeDefined();
      expect(operation.domain, operation.operation_id).toBe(registered?.domain);
      expect(operation.effects, operation.operation_id).toEqual(
        registered?.operation_receiver_effects?.[operation.operation_id] ?? registered?.receiver_effects,
      );
    }
  });

  test("publishes exact work.observe operation effects and the conservative capability union", () => {
    const operations = new Map(HTTP_OPERATION_DESCRIPTORS.map((operation) => [operation.operation_id, operation]));
    expect(findInterfaceCapabilityContract("work.observe")?.receiver_effects).toMatchObject({
      kind: "uniform",
      effects: { local_files: "read", local_state: "read_write", process_launch: true },
    });
    expect(operations.get("work.list")).toMatchObject({
      capability: "work.observe",
      effects: {
        kind: "uniform",
        effects: { local_files: "read", local_state: "read_write" },
      },
    });
    expect(operations.get("work.get")).toMatchObject({
      capability: "work.observe",
      effects: {
        kind: "uniform",
        effects: { local_files: "read", local_state: "read" },
      },
    });
    expect(operations.get("work.observe")).toMatchObject({
      capability: "work.observe",
      effects: {
        kind: "uniform",
        effects: { local_files: "none", local_state: "read" },
      },
    });
    expect(operations.get("admin.events")).toMatchObject({
      capability: "work.observe",
      effects: { kind: "uniform", effects: { local_files: "none", local_state: "read" } },
    });
    expect(operations.get("admin.run.list")).toMatchObject({
      capability: "work.observe",
      effects: { kind: "uniform", effects: { local_files: "read", local_state: "read_write" } },
    });
    expect(operations.get("admin.run.events")).toMatchObject({
      capability: "work.observe",
      effects: { kind: "uniform", effects: { local_files: "read", local_state: "read_write" } },
    });
    expect(operations.get("admin.run.observation")).toMatchObject({
      capability: "work.observe",
      effects: { kind: "uniform", effects: { local_files: "read", process_launch: true } },
    });
    expect(findInterfaceCapabilityContract("work.observe")?.cli_sibling_ids).toEqual([
      "run.ps", "run.subscribe", "run.status", "run.logs", "run.doctor", "run.receipt",
    ]);
    for (const staleCapability of [
      "work.observe.admin", "run.events", "run.status", "run.logs", "run.observation", "run.receipt",
    ]) {
      expect(findInterfaceCapabilityContract(staleCapability), staleCapability).toBeUndefined();
    }
    const manifest = new Map(INTERFACE_MANIFEST_RECORDS.map((record) => [record.id, record]));
    for (const sibling of ["run.ps", "run.subscribe", "run.status", "run.logs", "run.doctor", "run.receipt"]) {
      expect(manifest.get(sibling), sibling).toMatchObject({ capability: "work.observe", domain: "run" });
    }
  });

  test("declares mixed file and SQLite receiver authority for activity listing", () => {
    const activityList = HTTP_OPERATION_DESCRIPTORS.find((operation) => (
      operation.operation_id === "activity.list"
    ));
    expect(findInterfaceCapabilityContract("recall")?.receiver_effects).toMatchObject({
      kind: "uniform",
      effects: { local_files: "read", local_state: "read_write" },
    });
    expect(activityList).toMatchObject({
      capability: "recall",
      effects: { kind: "uniform", effects: { local_files: "read", local_state: "read_write" } },
    });
  });

  test("publishes one honest attention.mark capability with exact per-operation effects and CLI siblings", () => {
    const contract = findInterfaceCapabilityContract("attention.mark");
    expect(contract).toMatchObject({
      domain: "activity",
      receiver_effects: {
        kind: "uniform",
        effects: {
          local_files: "read",
          local_state: "read_write",
          remote_provider: "none",
          process_launch: false,
          creates_worktree: false,
          dispatches_run: false,
        },
      },
      cli_sibling_ids: ["activity.mark", "activity.unmark", "activity.marks"],
    });
    const operations = new Map(HTTP_OPERATION_DESCRIPTORS.map((operation) => [operation.operation_id, operation]));
    expect(operations.get("attention.mark.create")?.effects).toMatchObject({
      kind: "uniform",
      effects: { local_files: "read", local_state: "read_write" },
    });
    expect(operations.get("attention.mark.revoke")?.effects).toMatchObject({
      kind: "uniform",
      effects: { local_files: "none", local_state: "read_write" },
    });
    expect(operations.get("attention.mark.list")?.effects).toMatchObject({
      kind: "uniform",
      effects: { local_files: "none", local_state: "read" },
    });
    const manifest = new Map(INTERFACE_MANIFEST_RECORDS.map((record) => [record.id, record]));
    for (const sibling of ["activity.mark", "activity.unmark", "activity.marks"]) {
      expect(manifest.get(sibling), sibling).toMatchObject({ capability: "attention.mark", domain: "activity" });
    }
  });

  test("binds attention marks to keyed create and bodyless request-target revoke authority", () => {
    const operations = new Map(HTTP_OPERATION_DESCRIPTORS.map((operation) => [operation.operation_id, operation]));
    expect(operations.get("attention.mark.create")).toMatchObject({
      method: "POST",
      path: "/v1/marks",
      profile: "consumer_v1",
      store_regime: "sqlite_authoritative",
      request_schema: "calyx.activity-mark-create-request/v1",
      response_schema: "calyx.activity-mark/v1",
      retry_authority: { kind: "request_body_field", field: "idempotency_key" },
      client_surfaces: ["consumer", "admin"],
      successes: [expect.objectContaining({
        representation: "json",
        semantics: expect.objectContaining({ mutation: "idempotent_write" }),
      })],
    });
    expect(operations.get("attention.mark.revoke")).toMatchObject({
      method: "DELETE",
      path: "/v1/marks/{markId}",
      request_transport: { body: "none" },
      retry_authority: { kind: "request_target_identity" },
      path_parameters: [expect.objectContaining({
        name: "markId",
        required: true,
        schema: expect.objectContaining({ pattern: expect.stringContaining("mark_") }),
      })],
      client_surfaces: ["consumer", "admin"],
      successes: [expect.objectContaining({
        representation: "json",
        semantics: expect.objectContaining({ mutation: "idempotent_write" }),
      })],
    });
    expect(operations.get("attention.mark.revoke")?.errors).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "payload_too_large" }),
      expect.objectContaining({ code: "unsupported_media_type" }),
    ]));
  });

  test("declares first-use projection and ownership writes for daemon observations", () => {
    const operations = new Map(HTTP_OPERATION_DESCRIPTORS.map((operation) => [operation.operation_id, operation]));
    for (const operationId of ["admin.health", "internal.health"]) {
      expect(operations.get(operationId)).toMatchObject({
        capability: "daemon.health",
        effects: {
          kind: "uniform",
          effects: {
            local_files: "read",
            local_state: "read_write",
            process_launch: true,
          },
        },
      });
    }
    expect(operations.get("internal.metrics")).toMatchObject({
      capability: "daemon.metrics",
      effects: {
        kind: "uniform",
        effects: {
          local_files: "read_write",
          local_state: "read_write",
          process_launch: false,
        },
      },
    });
  });

  test("binds all ratified message-read operations and CLI siblings to msg.read", () => {
    const operationIds = ["msg.inbox", "msg.thread", "msg.text", "msg.operation", "msg.doctor", "admin.msg.operation"];
    const operations = new Map(HTTP_OPERATION_DESCRIPTORS.map((operation) => [operation.operation_id, operation]));
    expect(operationIds.map((operationId) => operations.get(operationId)?.capability))
      .toEqual(operationIds.map(() => "msg.read"));
    expect(findInterfaceCapabilityContract("msg.read")?.cli_sibling_ids)
      .toEqual(["msg.inbox", "msg.thread", "msg.operation", "msg.doctor"]);
    for (const staleCapability of operationIds) {
      expect(findInterfaceCapabilityContract(staleCapability), staleCapability).toBeUndefined();
    }
    const manifest = new Map(INTERFACE_MANIFEST_RECORDS.map((record) => [record.id, record]));
    for (const siblingId of ["msg.inbox", "msg.thread", "msg.operation", "msg.doctor"]) {
      expect(manifest.get(siblingId), siblingId).toMatchObject({ capability: "msg.read", domain: "msg" });
    }
    expect(manifest.get("msg.send")).toMatchObject({ capability: "msg.send", domain: "msg" });
  });

  test("accounts for the receiver audit ledger in every HTTP mutation effect", () => {
    const mutations = HTTP_OPERATION_DESCRIPTORS.filter((operation) => (
      operation.successes.every((success) => success.semantics.mutation !== "read")
    ));

    for (const operation of mutations) {
      const effectSets = operation.effects.kind === "uniform"
        ? [operation.effects.effects]
        : operation.effects.branches.map((branch) => branch.effects);
      for (const effects of effectSets) {
        expect(effects.local_state, operation.operation_id).toBe("read_write");
      }
    }
  });

  test("binds monitor claim retries to one caller-generated idempotency key", () => {
    const claim = HTTP_OPERATION_DESCRIPTORS.find((operation) => (
      operation.operation_id === "admin.monitor.claim"
    ));
    expect(claim).toMatchObject({
      request_schema: "calyx.monitor-claim-request/v1",
      retry_authority: { kind: "request_body_field", field: "idempotency_key" },
      successes: [expect.objectContaining({
        semantics: expect.objectContaining({ mutation: "idempotent_write" }),
      })],
      errors: expect.arrayContaining([{ status: 409, code: "idempotency_conflict" }]),
    });
  });

  test("binds both replay streams to the SQLite event authority and receiver-side state reads", () => {
    for (const operationId of ["work.observe", "admin.events"]) {
      const operation = HTTP_OPERATION_DESCRIPTORS.find((candidate) => (
        candidate.operation_id === operationId
      ));
      expect(operation, operationId).toMatchObject({
        store_regime: "sqlite_authoritative",
        effects: {
          kind: "uniform",
          effects: { local_state: "read" },
        },
      });
    }
  });

  test("binds every declared capability to a real semantic CLI sibling", () => {
    const cliRecords = new Map<string, InterfaceManifestRecord>(INTERFACE_MANIFEST_RECORDS
      .filter((record) => record.invocation_kind !== "http_api")
      .map((record) => [record.id, record as InterfaceManifestRecord]));
    const receiverEffectKeys = [
      "local_files",
      "local_state",
      "remote_tracker",
      "remote_provider",
      "process_launch",
      "creates_worktree",
      "dispatches_run",
      "dry_run_default",
    ] as const satisfies readonly (keyof InterfaceCapabilityEffectSet)[];

    for (const registered of Object.values(INTERFACE_CAPABILITY_CONTRACTS)) {
      const siblingIds = [
        ...(registered.cli_sibling_id ? [registered.cli_sibling_id] : []),
        ...(registered.cli_sibling_ids ?? []),
      ];
      for (const siblingId of siblingIds) {
        const sibling = cliRecords.get(siblingId);
        expect(sibling, `${registered.id} has no real CLI sibling ${siblingId}`).toBeDefined();
        expect(sibling?.capability, siblingId).toBe(registered.id);
        expect(sibling?.domain, siblingId).toBe(registered.domain);
        if (!registered.cli_effects_match_receiver) continue;
        const receiverEffects = registered.receiver_effects;
        expect(receiverEffects.kind, registered.id).toBe("uniform");
        if (receiverEffects.kind !== "uniform" || !sibling) continue;
        expect(Object.fromEntries(receiverEffectKeys.map((key) => [key, sibling.effects[key]])), siblingId)
          .toEqual(Object.fromEntries(receiverEffectKeys.map((key) => [key, receiverEffects.effects[key]])));
      }
    }
  });

  test("keeps generated clients as the only daemon HTTP transport owner in CLI production code", () => {
    const configPath = fileURLToPath(new URL("../../../cli/tsconfig.json", import.meta.url));
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
    const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath));
    const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
    const cliSourceRoot = fileURLToPath(new URL("../../../cli/src/", import.meta.url));
    const sourceFiles = program.getSourceFiles().filter((sourceFile) => (
      sourceFile.fileName.startsWith(cliSourceRoot)
      && !sourceFile.fileName.includes("/__tests__/")
    ));
    const source = sourceFiles.map((file) => file.text).join("\n");
    expect(source).not.toContain("cliHttpTransportBinding");
    expect(source).not.toContain("bound-http-transport");
    expect(source).not.toContain("/v1/admin/self-upgrade-receipts");

    const rawTransportOwners = sourceFiles
      .filter((file) => (
        containsRawFetchIdentifier(file)
        || /\btypeof\s+fetch\b|\bfetchImpl\b|\bglobalThis\.fetch\b/.test(file.text)
      ))
      .map((file) => file.fileName.slice(cliSourceRoot.length))
      .sort();
    expect(rawTransportOwners).toEqual(["linear-graphql-requester.ts"]);
    expect(sourceFiles.find((file) => file.fileName.endsWith("/run-cli.ts"))?.text)
      .not.toMatch(/\btypeof\s+fetch\b|\bfetchImpl\b|\bglobalThis\.fetch\b/);
    expect(sourceFiles.find((file) => file.fileName.endsWith("/commands/self-nudge.ts"))?.text)
      .not.toMatch(/\btypeof\s+fetch\b|\bfetchImpl\b|\bglobalThis\.fetch\b|\/v1\//);
  });

  test.each([
    ["direct ambient fetch", "fetch(url);"],
    ["ambient fetch alias", "const send = fetch; send(url);"],
    ["computed global fetch", "globalThis['fetch'](url);"],
  ])("the raw-transport owner scan detects %s", (_name, source) => {
    const sourceFile = ts.createSourceFile(
      "/virtual/raw-fetch.ts",
      source,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    expect(containsRawFetchIdentifier(sourceFile)).toBe(true);
  });

  test("maps monitor and lease routes to exact stable verbs", () => {
    const expected = new Map<string, string>([
      ["monitor.list", "monitor.list"],
      ["monitor.get", "monitor.show"],
      ["monitor.wakes", "monitor.inbox"],
      ["admin.monitor.list", "monitor.list"],
      ["admin.monitor.create", "monitor.create"],
      ["admin.monitor.get", "monitor.show"],
      ["admin.monitor.wakes", "monitor.inbox"],
      ["admin.monitor.claim", "monitor.inbox"],
      ["admin.monitor.ack", "monitor.ack"],
      ["admin.monitor.cancel", "monitor.cancel"],
      ["lease.list", "lease.list"],
      ["lease.get", "lease.observe"],
      ["admin.lease.acquire", "lease.acquire"],
      ["admin.lease.renew", "lease.renew"],
      ["admin.lease.release", "lease.release"],
      ["admin.lease.steal", "lease.steal"],
      ["admin.lease.list", "lease.list"],
      ["admin.lease.doctor", "lease.doctor"],
    ]);
    const operations = HTTP_OPERATION_DESCRIPTORS.filter((operation) => (
      operation.domain === "monitor" || operation.domain === "lease"
    ));
    expect(operations).toHaveLength(expected.size);
    for (const operation of operations) {
      expect(operation.capability, operation.operation_id).toBe(expected.get(operation.operation_id));
    }
  });

  test("drives the http_api manifest projection without a second route registry", () => {
    const manifestHttp = INTERFACE_MANIFEST_RECORDS.filter((record) => record.invocation_kind === "http_api");
    expect(manifestHttp).toHaveLength(HTTP_OPERATION_DESCRIPTORS.length);
    for (const operation of HTTP_OPERATION_DESCRIPTORS) {
      expect(manifestHttp).toContainEqual(expect.objectContaining({
        id: `http.${operation.operation_id}`,
        capability: operation.capability,
        domain: operation.domain,
        operation_effects: operation.effects,
        profile: operation.profile,
        store_regime: operation.store_regime,
        request_schema: operation.request_schema,
        response_schema: operation.response_schema,
        operation_successes: operation.successes,
        request_transport: operation.request_transport,
        operation_errors: operation.errors,
        client_surfaces: operation.client_surfaces,
      }));
    }
    expect(manifestHttp.find((record) => record.id === "http.admin.run.launch")?.effects.process_launch)
      .toBe(true);
    expect(manifestHttp.find((record) => record.id === "http.internal.msg.receive")?.effects.process_launch)
      .toBe(false);
    expect(manifestHttp.find((record) => record.id === "http.admin.run.launch"))
      .toMatchObject({ capability: "run.launch", domain: "run" });
    expect(manifestHttp.find((record) => record.id === "http.admin.activity.messages"))
      .toMatchObject({ capability: "activity.messages", domain: "activity" });
    expect(manifestHttp.find((record) => record.id === "http.internal.msg.receive"))
      .toMatchObject({ capability: "msg.receive", domain: "msg" });
    expect(manifestHttp.find((record) => record.id === "http.internal.runtime-config.apply")?.effects)
      .toMatchObject({ local_files: "read_write", local_state: "read_write" });
    expect(manifestHttp.find((record) => record.id === "http.internal.run.reconcile")?.effects)
      .toMatchObject({ local_files: "read_write", local_state: "read_write" });
    expect(manifestHttp.find((record) => record.id === "http.admin.run.launch")?.effects)
      .toMatchObject({ local_files: "read_write", local_state: "read_write" });
    const messageSend = manifestHttp.find(
      (record) => record.id === "http.msg.send",
    ) as InterfaceManifestRecord | undefined;
    expect(messageSend?.effects.receipt_required).toBe(true);
    expect(messageSend?.mutation_class).toBe("mixed");
    expect(messageSend?.async_contract).toMatchObject({
      background: "mixed",
      waitable: "mixed",
      resumable: "mixed",
      cancellable: false,
      receipt_bearing: true,
    });
    expect(messageSend?.effects).toMatchObject({
      local_state: "read_write",
      remote_provider: "write_without_dry_run",
      receipt_required: true,
    });
    expect(messageSend?.operation_effects).toEqual({
      kind: "by_success",
      branches: [
        expect.objectContaining({
          status: 200,
          condition: { outcome: "local_inert" },
          effects: expect.objectContaining({ remote_provider: "none" }),
        }),
        expect.objectContaining({
          status: 202,
          condition: { outcome: "cross_host_outbox" },
          effects: expect.objectContaining({ remote_provider: "write_without_dry_run" }),
        }),
      ],
    });
    expect(messageSend?.output_contract.receipt_schema_ref).toBeNull();
    expect(messageSend?.operation_successes).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 200, semantics: expect.objectContaining({ receipt: "inline_result" }) }),
      expect.objectContaining({ status: 202, semantics: expect.objectContaining({ receipt: "accepted_locator" }) }),
    ]));
  });

  test("projects capability-separated client surfaces without hidden control-plane omissions", () => {
    const consumer = HTTP_OPERATION_DESCRIPTORS.filter((operation) => operation.client_surfaces.includes("consumer"));
    const admin = HTTP_OPERATION_DESCRIPTORS.filter((operation) => operation.client_surfaces.includes("admin"));
    const omitted = HTTP_OPERATION_DESCRIPTORS.filter((operation) => operation.client_surfaces.length === 0);

    expect(consumer).toHaveLength(23);
    expect(consumer.every((operation) => operation.profile === "consumer_v1")).toBe(true);
    expect(admin).toHaveLength(63);
    expect(admin.every((operation) => operation.profile !== "internal_runtime")).toBe(true);
    expect(omitted.filter((operation) => operation.profile === "control_plane_admin_v1")).toEqual([]);
    expect(admin.map((operation) => operation.operation_id)).toContain("admin.run.reconcile-preserving");
    expect(admin.map((operation) => operation.operation_id)).toEqual(expect.arrayContaining([
      "admin.monitor.claim",
      "admin.self-upgrade.receipt",
      "admin.msg.operation",
      "admin.msg.forward",
      "admin.session-wake.deliver",
    ]));
  });

  test("keeps an exhaustive operation-local error inventory enforced at runtime", () => {
    for (const operation of HTTP_OPERATION_DESCRIPTORS) {
      const unique = new Set(operation.errors.map((failure) => `${failure.status}:${failure.code}`));
      expect(unique.size, operation.operation_id).toBe(operation.errors.length);
      for (const failure of operation.errors) {
        expect(() => assertHttpOperationErrorDeclared(
          operation.operation_id,
          failure.status,
          failure.code,
        )).not.toThrow();
      }
      expect(() => assertHttpOperationErrorDeclared(
        operation.operation_id,
        599,
        "undeclared_inventory_probe",
      )).toThrow(/emitted undeclared error/);
      if (operation.request_schema === "calyx.empty-query/v1" && operation.path_parameters === undefined) {
        expect(operation.errors, operation.operation_id).not.toContainEqual({
          status: 400,
          code: "invalid_request",
        });
      }
      if (operation.request_transport.body === "none") {
        expect(operation.errors, operation.operation_id).not.toContainEqual({
          status: 413,
          code: "payload_too_large",
        });
        expect(operation.errors, operation.operation_id).not.toContainEqual({
          status: 415,
          code: "unsupported_media_type",
        });
      }
    }
  });

  test("keeps consumer-only activity selector failures off admin and unrelated catalogs", () => {
    const selectorFailure = { status: 400, code: "consumer_selector_forbidden" };
    const consumerActivity = HTTP_OPERATION_DESCRIPTORS.filter((operation) => (
      operation.operation_id === "activity.list"
      || operation.operation_id.startsWith("activity.")
    ));
    expect(consumerActivity.map((operation) => operation.operation_id)).toEqual([
      "activity.list",
      "activity.get",
      "activity.messages",
      "activity.turns",
      "activity.attachments",
      "activity.text",
    ]);
    for (const operation of consumerActivity) {
      expect(operation.errors, operation.operation_id).toContainEqual(selectorFailure);
    }

    const adminActivity = HTTP_OPERATION_DESCRIPTORS.filter((operation) => (
      operation.operation_id.startsWith("admin.activity.")
    ));
    expect(adminActivity.length).toBeGreaterThan(0);
    for (const operation of adminActivity) {
      expect(operation.errors, operation.operation_id).not.toContainEqual(selectorFailure);
    }
    expect(
      HTTP_OPERATION_DESCRIPTORS.find((operation) => operation.operation_id === "work.list")?.errors,
    ).not.toContainEqual(selectorFailure);
  });

  test("advertises only endpoint-reachable attachment resource failures", () => {
    const attachmentFailures = [
      { status: 404, code: "attachment_ref_unknown" },
      { status: 409, code: "attachment_bytes_unavailable" },
      { status: 422, code: "attachment_digest_mismatch" },
    ];
    const errorsFor = (operationId: string) => HTTP_OPERATION_DESCRIPTORS
      .find((operation) => operation.operation_id === operationId)!.errors
      .filter((failure) => attachmentFailures.some((expected) => (
        expected.status === failure.status && expected.code === failure.code
      )));

    expect(errorsFor("activity.attachments")).toEqual([]);
    expect(errorsFor("admin.activity.attachments")).toEqual([
      { status: 422, code: "attachment_digest_mismatch" },
    ]);
    expect(errorsFor("admin.activity.attachment-record")).toEqual([
      { status: 404, code: "attachment_ref_unknown" },
    ]);
    for (const operationId of ["admin.activity.attachment-bytes", "admin.activity.attachment-bytes-head"]) {
      expect(errorsFor(operationId)).toEqual(attachmentFailures);
    }

    for (const operation of HTTP_OPERATION_DESCRIPTORS) {
      for (const unreachable of [
        "activity_owner_unresolved",
        "activity_owner_unreachable",
        "attachment_archive_unavailable",
      ]) {
        expect(operation.errors.map((failure) => failure.code), operation.operation_id)
          .not.toContain(unreachable);
      }
    }
  });

  test("uses only executable response-self digest bindings for attachment custody", () => {
    const get = HTTP_OPERATION_DESCRIPTORS.find((operation) => (
      operation.operation_id === "admin.activity.attachment-bytes"
    ))!;
    const head = HTTP_OPERATION_DESCRIPTORS.find((operation) => (
      operation.operation_id === "admin.activity.attachment-bytes-head"
    ))!;
    const getBindings = get.successes[0]!.custody?.bindings ?? [];
    const headBindings = head.successes[0]!.custody?.bindings ?? [];

    expect(getBindings).toContainEqual({
      source: "response.body",
      target: "response.header.digest",
      relation: "sha256_base64",
    });
    expect(headBindings.some((binding) => binding.source === "response.body")).toBe(false);
    expect(headBindings).toContainEqual({
      source: "response.header.x-calyx-attachment-ref",
      target: "response.header.digest",
      relation: "sha256_base64",
    });
    expect([...getBindings, ...headBindings].some((binding) => binding.source.startsWith("authority."))).toBe(false);
  });

  test("keeps centrally validated query failures out of handler-specific catalogs", () => {
    const errorsFor = (operationId: string) => HTTP_OPERATION_DESCRIPTORS
      .find((operation) => operation.operation_id === operationId)!.errors;
    expect(errorsFor("work.observe")).toContainEqual({
      status: 400,
      code: "consumer_event_type_forbidden",
    });
    for (const operationId of [
      "monitor.list",
      "monitor.wakes",
      "admin.monitor.list",
      "admin.monitor.wakes",
    ]) {
      expect(errorsFor(operationId), operationId).not.toContainEqual({
        status: 400,
        code: "monitor_invalid_limit",
      });
    }
    expect(errorsFor("lease.list")).not.toContainEqual({
      status: 400,
      code: "invalid_resource_kind",
    });
  });
});
