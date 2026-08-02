import {
  ACTIVITY_MARK_ACTIVITY_ID_PATTERN_SOURCE,
  ACTIVITY_MARK_SOURCE_LINE_PATTERN_SOURCE,
  API_REQUEST_ID_PATTERN_SOURCE,
  CALYX_ADMIN_RECONCILE_DIRECTORY_NAME_MAX_LENGTH,
  CALYX_ADMIN_RECONCILE_NONCANONICAL_MAX_ITEMS,
  CALYX_ADMIN_RECONCILE_RECORD_STATE_MAX_LENGTH,
  CALYX_CLOSED_RESPONSE_OBJECT_DESCRIPTION_PREFIX,
  CALYX_EXCLUSIVE_RESPONSE_UNION_DESCRIPTION_PREFIX,
  HTTP_OPERATION_DESCRIPTORS,
} from "@polli-labs/calyx-core";
import { zodToJsonSchema } from "zod-to-json-schema";

import { CALYX_BEARER_TOKEN_CONTRACT } from "./bearer-contract.js";
import {
  CALYX_SCHEMA_REGISTRY,
  isClosedResponseEnumPath,
  responseSchemaForConsumer,
} from "./operations.js";

function compareUtf8Bytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function schemaKey(schemaId: string): string {
  return schemaId.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

type SchemaRole = "request" | "response";

interface SchemaUsage {
  request: boolean;
  response: boolean;
}

// WHATWG URL parsing normalizes pure dot segments even when percent-encoded;
// encodeURIComponent also rejects lone UTF-16 surrogate code units. Publish a
// bounded scalar-value envelope on every path parameter so the generated
// schema language is a subset of the client's executable one-segment form.
const REPRESENTABLE_PATH_SEGMENT_PATTERN_SOURCE = "^(?![\\s\\S]*[\\uD800-\\uDFFF])(?!\\.{1,2}$)[\\s\\S]+$";
const REPRESENTABLE_PATH_SEGMENT_MAX_LENGTH = 4096;

// One decoded field bound cannot prove that the composed, percent-encoded
// request target fits Node and common proxy request-line envelopes. Publish a
// conservative document-level byte law for the generated client to enforce.
const REQUEST_TARGET_MAX_BYTES = 8000;

// z.string().datetime() is the projected source grammar: calendar-valid UTC
// with uppercase T/Z, optional seconds, and optional fractional seconds only
// when seconds are present. OpenAPI's generic date-time label is wider, so
// retain the exact source language as an executable pattern as well.
const CANONICAL_DATE_TIME_PATTERN_SOURCE = "^((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))T([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?Z$";

// Node's Fetch Headers representation is a normalized scalar string. Keep
// response contracts inside one non-empty, trim-stable printable-ASCII value,
// excluding comma so duplicate wire fields cannot become an accepted joined
// scalar. The compiler independently requires this exact envelope.
const FETCH_RESPONSE_HEADER_VALUE_PATTERN_SOURCE = "^[\\x21-\\x2B\\x2D-\\x7E](?:[\\x20-\\x2B\\x2D-\\x7E]*[\\x21-\\x2B\\x2D-\\x7E])?$";
const FETCH_RESPONSE_HEADER_VALUE_MAX_LENGTH = 1024;

export function intersectStringWireEnvelope(
  rawSchema: Readonly<Record<string, unknown>>,
  pattern: string,
  maximumLength: number,
): Record<string, unknown> {
  if (rawSchema["type"] !== "string") return { ...rawSchema };
  const rawMinimum = rawSchema["minLength"];
  const rawMaximum = rawSchema["maxLength"];
  const rawPattern = rawSchema["pattern"];
  return {
    ...rawSchema,
    minLength: Math.max(1, typeof rawMinimum === "number" ? rawMinimum : 0),
    maxLength: Math.min(maximumLength, typeof rawMaximum === "number" ? rawMaximum : maximumLength),
    // JSON Schema `pattern` uses search semantics. Preserve that language when
    // intersecting it with the anchored transport envelope: the raw pattern
    // may begin at any code-unit offset, while the canonical envelope still
    // proves the complete observable value.
    pattern: typeof rawPattern === "string" ? `(?=[\\s\\S]*(?:${rawPattern}))${pattern}` : pattern,
  };
}

function executablePathParameterSchema(rawSchema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return intersectStringWireEnvelope(
    rawSchema,
    REPRESENTABLE_PATH_SEGMENT_PATTERN_SOURCE,
    REPRESENTABLE_PATH_SEGMENT_MAX_LENGTH,
  );
}

function fetchResponseHeaderSchema(rawSchema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return intersectStringWireEnvelope(
    rawSchema,
    FETCH_RESPONSE_HEADER_VALUE_PATTERN_SOURCE,
    FETCH_RESPONSE_HEADER_VALUE_MAX_LENGTH,
  );
}

const requestIdResponseHeader = {
  required: true,
  description: "Server-generated correlation ID. Its presence does not imply mutation audit admission.",
  schema: fetchResponseHeaderSchema({ type: "string", pattern: API_REQUEST_ID_PATTERN_SOURCE }),
} as const;

function componentKey(schemaId: string, role: SchemaRole, usages: ReadonlyMap<string, SchemaUsage>): string {
  const usage = usages.get(schemaId);
  if (role === "request" && usage?.response) return `${schemaKey(schemaId)}_request`;
  return schemaKey(schemaId);
}

function schemaRef(schemaId: string, role: SchemaRole, usages: ReadonlyMap<string, SchemaUsage>) {
  return { $ref: `#/components/schemas/${componentKey(schemaId, role, usages)}` };
}

function objectSchemaProperties(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const node = value as Record<string, unknown>;
  if (node["type"] !== "object" || !node["properties"] || typeof node["properties"] !== "object") {
    return undefined;
  }
  return node["properties"] as Record<string, unknown>;
}

function unionLeafObjectBranches(node: Record<string, unknown>): Record<string, unknown>[] {
  const anyOf = node["anyOf"];
  if (Array.isArray(anyOf)) {
    return anyOf.flatMap((branch) => (
      branch && typeof branch === "object" && !Array.isArray(branch)
        ? unionLeafObjectBranches(branch as Record<string, unknown>)
        : []
    ));
  }
  return objectSchemaProperties(node) ? [node] : [];
}

function excludeKnownSiblingOnlyUnionFields(node: Record<string, unknown>): void {
  const description = node["description"];
  if (
    typeof description !== "string"
    || (
      !description.startsWith(CALYX_EXCLUSIVE_RESPONSE_UNION_DESCRIPTION_PREFIX)
      && !description.startsWith("calyx-bounded-page:")
    )
  ) return;
  const objectBranches = unionLeafObjectBranches(node);
  if (objectBranches.length < 2) return;

  const knownFields = new Set(objectBranches.flatMap((branch) => (
    Object.keys(objectSchemaProperties(branch) ?? {})
  )));
  for (const branch of objectBranches) {
    const properties = objectSchemaProperties(branch)!;
    const exclusions = [...knownFields]
      .filter((field) => !Object.prototype.hasOwnProperty.call(properties, field))
      .sort(compareUtf8Bytes)
      .map((field) => ({ not: { type: "object", required: [field] } }));
    if (exclusions.length === 0) continue;
    const allOf = branch["allOf"];
    branch["allOf"] = Array.isArray(allOf) ? [...allOf, ...exclusions] : exclusions;
  }
}

function jsonSchema(schemaId: string, role: SchemaRole): Record<string, unknown> {
  const registeredSchema = CALYX_SCHEMA_REGISTRY[schemaId];
  if (!registeredSchema) throw new Error(`OpenAPI references unregistered schema ${schemaId}.`);
  const schema = role === "response"
    ? responseSchemaForConsumer(schemaId, registeredSchema)
    : registeredSchema;
  const rendered = zodToJsonSchema(schema, {
    target: "openApi3",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  const annotateSchema = (value: unknown, pointer: string): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => annotateSchema(child, `${pointer}/${index}`));
      return;
    }
    const node = value as Record<string, unknown>;
    const numericLiterals = Object.hasOwn(node, "const")
      ? [node["const"]]
      : Array.isArray(node["enum"])
        ? node["enum"]
        : [];
    if (
      node["type"] === "number"
      && numericLiterals.length > 0
      && numericLiterals.every((literal) => Number.isSafeInteger(literal))
    ) {
      // zod-to-json-schema renders numeric literals as `number`, even when
      // their complete wire language is integral. Publish the narrower domain
      // truth so binary64 is never the identity carrier for these values.
      node["type"] = "integer";
    }
    if (node["type"] === "integer") {
      const rawMinimum = node["minimum"];
      const rawMaximum = node["maximum"];
      node["minimum"] = Math.max(
        Number.MIN_SAFE_INTEGER,
        typeof rawMinimum === "number" ? rawMinimum : Number.MIN_SAFE_INTEGER,
      );
      node["maximum"] = Math.min(
        Number.MAX_SAFE_INTEGER,
        typeof rawMaximum === "number" ? rawMaximum : Number.MAX_SAFE_INTEGER,
      );
      if ((node["minimum"] as number) > (node["maximum"] as number)) {
        throw new Error(`Integer schema ${schemaId} is outside the JavaScript safe-integer wire envelope.`);
      }
    }
    if (node["format"] === "date-time") {
      const rawPattern = node["pattern"];
      node["pattern"] = typeof rawPattern === "string"
        ? `(?=[\\s\\S]*(?:${rawPattern}))${CANONICAL_DATE_TIME_PATTERN_SOURCE}`
        : CANONICAL_DATE_TIME_PATTERN_SOURCE;
    }
    if (role === "response") excludeKnownSiblingOnlyUnionFields(node);
    if (
      role === "response"
      && typeof node["description"] === "string"
      && node["description"].startsWith(CALYX_EXCLUSIVE_RESPONSE_UNION_DESCRIPTION_PREFIX)
    ) delete node["description"];
    const explicitlyClosedResponseObject = role === "response"
      && typeof node["description"] === "string"
      && node["description"].startsWith(CALYX_CLOSED_RESPONSE_OBJECT_DESCRIPTION_PREFIX);
    if (explicitlyClosedResponseObject) delete node["description"];
    if (typeof node["description"] === "string" && node["description"].startsWith("calyx-bounded-page:")) {
      const [, itemsField, countMode] = node["description"].split(":");
      if (!itemsField || (countMode !== "count" && countMode !== "no-count")) {
        throw new Error(`Invalid bounded-page schema marker for ${schemaId}.`);
      }
      delete node["description"];
      node["x-calyx-pagination-contract"] = {
        items_field: itemsField,
        discriminator_field: "truncated",
        cursor_field: "next_cursor",
        ...(countMode === "count" ? {
          count_field: "count",
          count_equals: `${itemsField}.length`,
        } : {}),
      };
    }
    if (typeof node["description"] === "string" && node["description"].startsWith("calyx-open-dictionary:")) {
      const name = node["description"].slice("calyx-open-dictionary:".length);
      delete node["description"];
      node["x-calyx-dictionary-mode"] = "explicit-json-metadata";
      node["x-calyx-dictionary-name"] = name;
    }
    const explicitlyOpenEnum = typeof node["description"] === "string"
      && node["description"].startsWith("calyx-open-enum:");
    let explicitOpenKnownValues: unknown;
    if (explicitlyOpenEnum) {
      explicitOpenKnownValues = JSON.parse(
        (node["description"] as string).slice("calyx-open-enum:".length),
      );
      if (!Array.isArray(explicitOpenKnownValues) || !explicitOpenKnownValues.every((item) => (
        typeof item === "string"
      ))) {
        throw new Error(`Invalid open-enum schema marker for ${schemaId}.`);
      }
      delete node["description"];
    }
    if (role === "response" && explicitlyOpenEnum && !Array.isArray(node["enum"])) {
      node["x-calyx-enum-mode"] = "open";
      node["x-calyx-known-values"] = explicitOpenKnownValues;
    }
    if (Array.isArray(node["enum"])) {
      if (
        role === "response"
        && (explicitlyOpenEnum || node["enum"].length > 1)
        && !isClosedResponseEnumPath(schemaId, responseDataPath(pointer))
      ) {
        node["x-calyx-enum-mode"] = "open";
        node["x-calyx-known-values"] = [...node["enum"]];
      } else {
        node["x-calyx-enum-mode"] = "closed";
        node["x-calyx-enum-closure"] = pointer.endsWith("/properties/schema_version")
          ? "schema-major-discriminator"
          : "wire-shape-discriminator";
      }
    } else if (typeof node["const"] === "string") {
      node["x-calyx-enum-mode"] = "closed";
      node["x-calyx-enum-closure"] = pointer.endsWith("/properties/schema_version")
        ? "schema-major-discriminator"
        : "wire-shape-discriminator";
    }
    if (node["type"] === "object" && node["properties"] && typeof node["properties"] === "object") {
      if (node["additionalProperties"] === false && !explicitlyClosedResponseObject) {
        delete node["additionalProperties"];
      }
      if (node["x-calyx-dictionary-mode"] !== "explicit-json-metadata") {
        node["x-calyx-unknown-field-policy"] = explicitlyClosedResponseObject
          ? "reject"
          : role === "request" ? "ignore" : "preserve";
      }
    }
    Object.entries(node).forEach(([key, child]) => annotateSchema(child, `${pointer}/${key}`));
  };
  annotateSchema(rendered, "");
  if (role === "response" && schemaId === "calyx.admin-reconcile-result/v1") {
    rendered["x-calyx-cross-field-contract"] = {
      unresolved_histogram: {
        unique_by: "reason",
        sum_field: "count",
        equals: "changed.unresolved",
      },
      noncanonical_directory_examples: {
        field: "noncanonical_directories",
        accepted_length_contracts: [
          {
            generation: "current_bounded_writer",
            length_equals_min_of: [
              "changed.noncanonical_directories",
              CALYX_ADMIN_RECONCILE_NONCANONICAL_MAX_ITEMS,
            ],
            directory_name_max_length: CALYX_ADMIN_RECONCILE_DIRECTORY_NAME_MAX_LENGTH,
            record_state_max_length: CALYX_ADMIN_RECONCILE_RECORD_STATE_MAX_LENGTH,
          },
          {
            generation: "predecessor_v1_writer",
            length_equals: "changed.noncanonical_directories",
            string_bound: "response_max_bytes_only",
          },
        ],
      },
      incomplete_if_any: [
        { field: "changed.repair_pending", operator: ">", value: 0 },
        { field: "changed.unresolved", operator: ">", value: 0 },
        { field: "changed.noncanonical_directories", operator: ">", value: 0 },
        { field: "projection.status", operator: "==", value: "failed" },
      ],
    };
  }
  const attachmentIdentityObjectPath = new Map<string, string>([
    ["calyx.admin-activity-attachment-record/v1", "$"],
    ["activity.attachments/v1", "attachments[*]"],
    ["calyx.admin-activity-attachments/v1", "attachments[*]"],
    ["calyx.admin-activity-messages/v1", "messages[*].attachments[*]"],
  ]).get(schemaId);
  if (role === "response" && attachmentIdentityObjectPath) {
    rendered["x-calyx-cross-field-contract"] = {
      attachment_identity: {
        object_path: attachmentIdentityObjectPath,
        ref_field: "ref",
        sha256_field: "sha256",
        ref_template: "att:sha256:{sha256}",
        sha256_pattern: "^[0-9a-f]{64}$",
      },
    };
  }
  if (
    role === "response"
    && [
      "calyx.activity-mark/v1",
      "calyx.activity-mark-revocation/v1",
      "calyx.activity-mark-list/v1",
    ].includes(schemaId)
  ) {
    const revocation = schemaId === "calyx.activity-mark-revocation/v1";
    rendered["x-calyx-cross-field-contract"] = {
      activity_mark_authority: {
        object_path: schemaId === "calyx.activity-mark-list/v1" ? "marks[*]" : "$",
        equalities: [
          { left: "marked_by", right: "created_provenance.subject" },
          { left: "marked_at", right: "created_provenance.at" },
          ...(revocation
            ? [{ left: "revoked_at", right: "revoked_provenance.at" }]
            : []),
        ],
        target_identity: {
          kind_field: "target_kind",
          id_field: "target_id",
          activity_id_pattern: ACTIVITY_MARK_ACTIVITY_ID_PATTERN_SOURCE,
          source_line_pattern: ACTIVITY_MARK_SOURCE_LINE_PATTERN_SOURCE,
          source_line_maximum: Number.MAX_SAFE_INTEGER,
          suffix_by_kind: { turn: ":turn:", message: ":msg:" },
        },
      },
    };
  }
  rendered["x-calyx-schema-id"] = schemaId;
  rendered["x-calyx-schema-role"] = role;
  return rendered;
}

function responseDataPath(pointer: string): Array<string | number> {
  const segments = pointer.split("/").slice(1).map((segment) => (
    segment.replaceAll("~1", "/").replaceAll("~0", "~")
  ));
  const path: Array<string | number> = [];
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] === "properties" && segments[index + 1] !== undefined) {
      path.push(segments[index + 1]!);
      index += 1;
    } else if (segments[index] === "items") {
      path.push("*");
    }
  }
  return path;
}

function pathParameters(descriptor: typeof HTTP_OPERATION_DESCRIPTORS[number]): Record<string, unknown>[] {
  const declared = new Map(descriptor.path_parameters?.map((parameter) => [parameter.name, parameter]) ?? []);
  const placeholders = [...descriptor.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
  const unknownDeclarations = [...declared.keys()].filter((name) => !placeholders.includes(name));
  if (unknownDeclarations.length > 0) {
    throw new Error(
      `HTTP operation ${descriptor.operation_id} declares absent path parameters: ${unknownDeclarations.join(", ")}`,
    );
  }
  return placeholders.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: executablePathParameterSchema(declared.get(name)?.schema ?? { type: "string" }),
  }));
}

function queryParameters(schemaId: string): Record<string, unknown>[] {
  const schema = jsonSchema(schemaId, "request");
  const properties = schema["properties"];
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  const required = new Set(Array.isArray(schema["required"]) ? schema["required"] as string[] : []);
  return Object.entries(properties as Record<string, unknown>)
    .sort(([left], [right]) => compareUtf8Bytes(left, right))
    .map(([name, propertySchema]) => ({
      name,
      in: "query",
      required: required.has(name),
      schema: propertySchema,
    }));
}

function errorResponse(status: string, codes: readonly string[], usages: ReadonlyMap<string, SchemaUsage>): Record<string, unknown> {
  return {
    description: "Typed Calyx error.",
    "x-calyx-error-codes": [...codes].sort(),
    headers: {
      "X-Calyx-Request-Id": requestIdResponseHeader,
      ...(status === "401" ? {
        "WWW-Authenticate": {
          required: true,
          schema: fetchResponseHeaderSchema({ type: "string", enum: ["Bearer realm=\"calyx-run\""] }),
        },
      } : {}),
    },
    content: {
      "application/json": {
        schema: {
          allOf: [
            schemaRef("calyx.error/v1", "response", usages),
            {
              type: "object",
              properties: {
                error: {
                  type: "object",
                  properties: {
                    code: {
                      type: "string",
                      enum: [...codes].sort(),
                      "x-calyx-enum-mode": "open",
                      "x-calyx-known-values": [...codes].sort(),
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
  };
}

export function generateCalyxOpenApi(): Record<string, unknown> {
  const schemaUsages = new Map<string, SchemaUsage>();
  const useSchema = (schemaId: string, role: SchemaRole): void => {
    const usage = schemaUsages.get(schemaId) ?? { request: false, response: false };
    usage[role] = true;
    schemaUsages.set(schemaId, usage);
  };
  useSchema("calyx.error/v1", "response");
  useSchema("calyx.message-observation/v1", "response");
  useSchema("calyx.wake-observation/v1", "response");
  for (const descriptor of HTTP_OPERATION_DESCRIPTORS) {
    useSchema(descriptor.request_schema, "request");
    useSchema(descriptor.response_schema, "response");
    descriptor.successes.forEach((success) => {
      useSchema(success.schema, "response");
      if (success.request_schema) useSchema(success.request_schema, "request");
      if (success.semantics.submission) useSchema(success.semantics.submission.receipt_schema, "response");
    });
  }
  const paths: Record<string, Record<string, unknown>> = {};
  const sorted = [...HTTP_OPERATION_DESCRIPTORS].sort((left, right) => (
    compareUtf8Bytes(left.path, right.path) || compareUtf8Bytes(left.method, right.method)
  ));
  for (const descriptor of sorted) {
    const responses: Record<string, unknown> = {};
    for (const success of descriptor.successes) {
      const successHeaders = success.headers?.map((header) => ({
        ...header,
        schema: fetchResponseHeaderSchema(header.schema),
      }));
      const successEffects = descriptor.effects.kind === "uniform"
        ? descriptor.effects.effects
        : descriptor.effects.branches.find((branch) => (
          branch.status === success.status
          && JSON.stringify(branch.condition ?? null) === JSON.stringify(success.condition ?? null)
        ))?.effects;
      if (!successEffects) {
        throw new Error(`HTTP operation ${descriptor.operation_id} has no effects for success ${success.status}`);
      }
      const status = String(success.status);
      const existing = responses[status] as Record<string, unknown> | undefined;
      const content = existing?.["content"] as Record<string, unknown> | undefined ?? {};
      if (success.representation !== "head") {
        const mediaType = success.media_type === "dynamic" ? "*/*" : success.media_type!;
        content[mediaType] = {
          schema: success.representation === "bytes"
            ? { type: "string", format: "binary" }
            : success.representation === "sse"
              ? { type: "string", description: "UTF-8 Server-Sent Events framing." }
            : schemaRef(success.schema, "response", schemaUsages),
          ...(success.representation === "sse" ? {
            "x-calyx-sse-event-schema": schemaRef(success.schema, "response", schemaUsages),
            "x-calyx-sse-cursor-field": success.cursor_field,
          } : {}),
          ...(success.max_frame_bytes === undefined
            ? {}
            : { "x-calyx-max-frame-bytes": success.max_frame_bytes }),
        };
      }
      responses[status] = {
        description: success.status === 202
          ? "Operation accepted. Observe the returned operation locator."
          : "Successful operation.",
        ...(Object.keys(content).length > 0 ? { content } : {}),
        headers: {
          "X-Calyx-Request-Id": requestIdResponseHeader,
          ...(successHeaders ? Object.fromEntries(successHeaders.map((header) => [header.name, {
            required: header.required,
            schema: header.schema,
          }])) : {}),
        },
        "x-calyx-semantics": success.semantics,
        "x-calyx-effects": successEffects,
        ...(success.custody ? { "x-calyx-custody-contract": success.custody } : {}),
        ...(success.max_bytes === undefined ? {} : { "x-calyx-max-bytes": success.max_bytes }),
        ...(success.max_frame_bytes === undefined
          ? {}
          : { "x-calyx-max-frame-bytes": success.max_frame_bytes }),
        ...(success.condition ? { "x-calyx-condition": success.condition } : {}),
        ...(success.request_schema ? { "x-calyx-request-schema": success.request_schema } : {}),
      };
    }
    const errorsByStatus = new Map<string, string[]>();
    for (const error of descriptor.errors) {
      const status = String(error.status);
      const codes = errorsByStatus.get(status) ?? [];
      codes.push(error.code);
      errorsByStatus.set(status, codes);
    }
    for (const [status, codes] of errorsByStatus) {
      responses[status] = errorResponse(status, codes, schemaUsages);
    }
    const parameters = [
      ...pathParameters(descriptor),
      ...(descriptor.request_headers ?? []).map((header) => ({
        name: header.name,
        in: "header",
        required: header.required,
        schema: header.schema,
      })),
      ...(descriptor.method === "GET" || descriptor.method === "HEAD"
        ? queryParameters(descriptor.request_schema)
        : []),
    ];
    const requestAcceptValues = [...new Set(descriptor.successes
      .map((success) => success.semantics.negotiation?.request_accept)
      .filter((value): value is string => Boolean(value)))];
    if (requestAcceptValues.length > 1) {
      throw new Error(
        `HTTP operation ${descriptor.operation_id} declares multiple request Accept contracts: ${requestAcceptValues.join(", ")}`,
      );
    }
    const operation: Record<string, unknown> = {
      operationId: descriptor.operation_id,
      summary: descriptor.summary,
      tags: [descriptor.profile],
      security: [{ bearerAuth: [] }],
      "x-calyx-profile": descriptor.profile,
      "x-calyx-capability": descriptor.capability,
      "x-calyx-domain": descriptor.domain,
      "x-calyx-effects": descriptor.effects,
      "x-calyx-store-regime": descriptor.store_regime,
      "x-calyx-request-schema": descriptor.request_schema,
      "x-calyx-request-transport": descriptor.request_transport,
      "x-calyx-response-schema": descriptor.response_schema,
      ...(descriptor.retry_authority
        ? { "x-calyx-retry-authority": descriptor.retry_authority }
        : {}),
      "x-calyx-client-surfaces": descriptor.client_surfaces,
      ...(descriptor.client_omission
        ? { "x-calyx-client-omission": descriptor.client_omission }
        : {}),
      ...(requestAcceptValues[0] ? { "x-calyx-request-accept": requestAcceptValues[0] } : {}),
      "x-calyx-success-contracts": descriptor.successes.map((success) => ({
        status: success.status,
        representation: success.representation,
        schema: success.schema,
        media_type: success.media_type,
        ...(success.max_bytes === undefined ? {} : { max_bytes: success.max_bytes }),
        ...(success.max_frame_bytes === undefined
          ? {}
          : { max_frame_bytes: success.max_frame_bytes }),
        ...(success.headers === undefined ? {} : {
          headers: success.headers.map((header) => ({
            ...header,
            schema: fetchResponseHeaderSchema(header.schema),
          })),
        }),
        ...(success.custody === undefined ? {} : { custody: success.custody }),
        semantics: success.semantics,
        ...(success.condition ? { condition: success.condition } : {}),
        ...(success.request_schema ? { request_schema: success.request_schema } : {}),
      })),
      ...(parameters.length > 0 ? { parameters } : {}),
      responses,
    };
    if (descriptor.request_transport.body === "json") {
      const requestSchemaIds = [...new Set(descriptor.successes.map((success) => success.request_schema).filter((value): value is string => Boolean(value)))];
      if (requestSchemaIds.length === 0) requestSchemaIds.push(descriptor.request_schema);
      operation.requestBody = {
        required: true,
        "x-calyx-max-bytes": descriptor.request_transport.max_bytes,
        content: {
          [descriptor.request_transport.media_type]: {
            schema: requestSchemaIds.length === 1
              ? schemaRef(requestSchemaIds[0]!, "request", schemaUsages)
              : { oneOf: requestSchemaIds.map((schemaId) => schemaRef(schemaId, "request", schemaUsages)) },
            ...(requestSchemaIds.length > 1 ? {
              "x-calyx-negotiated-request-schemas": descriptor.successes
                .filter((success) => success.request_schema)
                .map((success) => ({
                  schema: success.request_schema,
                  condition: success.condition,
                })),
            } : {}),
          },
        },
      };
    }
    (paths[descriptor.path] ??= {})[descriptor.method.toLowerCase()] = operation;
  }
  const componentOwners = new Map<string, string>();
  const schemas = Object.fromEntries([...schemaUsages]
    .sort(([left], [right]) => compareUtf8Bytes(left, right))
    .flatMap(([id, usage]) => (["response", "request"] as const)
      .filter((role) => usage[role])
      .map((role) => {
        const key = componentKey(id, role, schemaUsages);
        const identity = `${id}:${role}`;
        const owner = componentOwners.get(key);
        if (owner && owner !== identity) {
          throw new Error(`OpenAPI schema key collision: ${owner} and ${identity} both normalize to ${key}.`);
        }
        componentOwners.set(key, identity);
        return [key, jsonSchema(id, role)];
      })));
  return {
    openapi: "3.0.3",
    "x-calyx-bearer-token-contract": CALYX_BEARER_TOKEN_CONTRACT,
    "x-calyx-request-target-max-bytes": REQUEST_TARGET_MAX_BYTES,
    info: {
      title: "Calyx Consumer and Control API",
      version: "1.0.0",
      description: "Generated deterministically from the Calyx HTTP operation descriptors and canonical Zod schema registry.",
    },
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
      schemas,
    },
  };
}

export function renderCalyxOpenApi(): string {
  return `${JSON.stringify(generateCalyxOpenApi(), null, 2)}\n`;
}
