import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

import openapiTS, { astToString } from "openapi-typescript";
import ts from "typescript";

const ALLOWED_EXTENSIONS = new Set([
  "x-calyx-capability",
  "x-calyx-bearer-token-contract",
  "x-calyx-client-omission",
  "x-calyx-client-surfaces",
  "x-calyx-condition",
  "x-calyx-cross-field-contract",
  "x-calyx-custody-contract",
  "x-calyx-dictionary-mode",
  "x-calyx-dictionary-name",
  "x-calyx-domain",
  "x-calyx-effects",
  "x-calyx-enum-closure",
  "x-calyx-enum-mode",
  "x-calyx-error-codes",
  "x-calyx-known-values",
  "x-calyx-max-bytes",
  "x-calyx-max-frame-bytes",
  "x-calyx-pagination-contract",
  "x-calyx-profile",
  "x-calyx-request-accept",
  "x-calyx-request-schema",
  "x-calyx-request-target-max-bytes",
  "x-calyx-request-transport",
  "x-calyx-response-schema",
  "x-calyx-retry-authority",
  "x-calyx-schema-id",
  "x-calyx-schema-role",
  "x-calyx-semantics",
  "x-calyx-sse-cursor-field",
  "x-calyx-sse-event-schema",
  "x-calyx-store-regime",
  "x-calyx-success-contracts",
  "x-calyx-unknown-field-policy",
]);
const RESERVED_SEGMENTS = new Set(["then", "constructor", "prototype", "__proto__"]);
const SURFACES = ["consumer", "admin"];
const EFFECT_LEVELS = new Set(["none", "read", "write", "read_write", "write_on_apply", "write_without_dry_run"]);
const UNKNOWN_FIELD_POLICIES = new Set(["ignore", "preserve", "reject"]);
const CLIENT_SCHEMA_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
const CLIENT_SCHEMA_KEYWORDS = new Set([
  "$ref",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "default",
  "deprecated",
  "description",
  "enum",
  "example",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maximum",
  "maxItems",
  "maxLength",
  "minimum",
  "minItems",
  "minLength",
  "not",
  "nullable",
  "oneOf",
  "pattern",
  "properties",
  "readOnly",
  "required",
  "title",
  "type",
  "writeOnly",
  "x-calyx-cross-field-contract",
  "x-calyx-dictionary-mode",
  "x-calyx-dictionary-name",
  "x-calyx-enum-closure",
  "x-calyx-enum-mode",
  "x-calyx-known-values",
  "x-calyx-pagination-contract",
  "x-calyx-schema-id",
  "x-calyx-schema-role",
  "x-calyx-unknown-field-policy",
]);
const PATH_PARAMETER_SCHEMA_KEYS = new Set([
  "const",
  "default",
  "deprecated",
  "description",
  "enum",
  "example",
  "examples",
  "format",
  "maxLength",
  "minLength",
  "nullable",
  "pattern",
  "readOnly",
  "title",
  "type",
  "writeOnly",
  "x-calyx-enum-closure",
  "x-calyx-enum-mode",
  "x-calyx-known-values",
]);
const SCHEMA_EXTENSIONS = new Set([
  "x-calyx-cross-field-contract",
  "x-calyx-dictionary-mode",
  "x-calyx-dictionary-name",
  "x-calyx-enum-closure",
  "x-calyx-enum-mode",
  "x-calyx-known-values",
  "x-calyx-pagination-contract",
  "x-calyx-schema-id",
  "x-calyx-schema-role",
  "x-calyx-unknown-field-policy",
]);
const OPERATION_EXTENSIONS = new Set([
  "x-calyx-capability",
  "x-calyx-client-omission",
  "x-calyx-client-surfaces",
  "x-calyx-domain",
  "x-calyx-effects",
  "x-calyx-profile",
  "x-calyx-request-accept",
  "x-calyx-request-schema",
  "x-calyx-request-transport",
  "x-calyx-response-schema",
  "x-calyx-retry-authority",
  "x-calyx-store-regime",
  "x-calyx-success-contracts",
]);
const RESPONSE_EXTENSIONS = new Set([
  "x-calyx-condition",
  "x-calyx-custody-contract",
  "x-calyx-effects",
  "x-calyx-error-codes",
  "x-calyx-max-bytes",
  "x-calyx-max-frame-bytes",
  "x-calyx-request-schema",
  "x-calyx-semantics",
]);
const SSE_MEDIA_EXTENSIONS = new Set([
  "x-calyx-max-frame-bytes",
  "x-calyx-sse-cursor-field",
  "x-calyx-sse-event-schema",
]);
const DOCUMENT_KEYS = [
  "components",
  "info",
  "openapi",
  "paths",
  "x-calyx-bearer-token-contract",
  "x-calyx-request-target-max-bytes",
];
const INFO_KEYS = ["description", "title", "version"];
const COMPONENT_KEYS = ["schemas", "securitySchemes"];
const PATH_ITEM_KEYS = ["delete", "get", "head", "post"];
const OPERATION_KEYS = [
  "operationId",
  "parameters",
  "requestBody",
  "responses",
  "security",
  "summary",
  "tags",
  ...OPERATION_EXTENSIONS,
];
const PARAMETER_KEYS = ["in", "name", "required", "schema"];
const REQUEST_BODY_KEYS = ["content", "required", "x-calyx-max-bytes"];
const MEDIA_KEYS = ["schema"];
const SSE_MEDIA_KEYS = ["schema", ...SSE_MEDIA_EXTENSIONS];
const RESPONSE_KEYS = ["content", "description", "headers", ...RESPONSE_EXTENSIONS];
const HEADER_KEYS = ["description", "required", "schema"];
const HTTP_FIELD_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const FETCH_RESPONSE_HEADER_VALUE_PATTERN_SOURCE = "^[\\x21-\\x2B\\x2D-\\x7E](?:[\\x20-\\x2B\\x2D-\\x7E]*[\\x21-\\x2B\\x2D-\\x7E])?$";
const FETCH_RESPONSE_HEADER_VALUE_PATTERN = new RegExp(FETCH_RESPONSE_HEADER_VALUE_PATTERN_SOURCE, "u");
const FETCH_RESPONSE_HEADER_VALUE_MAX_LENGTH = 1024;
const REPRESENTABLE_PATH_SEGMENT_PATTERN_SOURCE = "^(?![\\s\\S]*[\\uD800-\\uDFFF])(?!\\.{1,2}$)[\\s\\S]+$";
const REPRESENTABLE_PATH_SEGMENT_MAX_LENGTH = 4096;
const REQUEST_TARGET_MAX_BYTES = 8000;
const CALYX_BEARER_TOKEN_PATTERN_SOURCE = "^[\\x21-\\x2B\\x2D-\\x7E]+$";
const CALYX_BEARER_TOKEN_MAX_BYTES = 4_096;
const CANONICAL_DATE_TIME_PATTERN_SOURCE = "^((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))T([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?Z$";

function isPositiveLookaheadIntersection(prefix) {
  let cursor = 0;
  while (cursor < prefix.length) {
    if (!prefix.startsWith("(?=", cursor)) return false;
    let depth = 1;
    let inCharacterClass = false;
    let escaped = false;
    let closed = false;
    for (let index = cursor + 3; index < prefix.length; index += 1) {
      const character = prefix[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === "[" && !inCharacterClass) {
        inCharacterClass = true;
        continue;
      }
      if (character === "]" && inCharacterClass) {
        inCharacterClass = false;
        continue;
      }
      if (inCharacterClass) continue;
      if (character === "(") depth += 1;
      if (character !== ")") continue;
      depth -= 1;
      if (depth === 0) {
        cursor = index + 1;
        closed = true;
        break;
      }
    }
    if (!closed) return false;
  }
  return cursor > 0;
}

function isProvenPatternIntersection(pattern, canonicalEnvelope) {
  if (typeof pattern !== "string") return false;
  try {
    new RegExp(pattern, "u");
  } catch {
    return false;
  }
  if (pattern === canonicalEnvelope) return true;
  if (!pattern.endsWith(canonicalEnvelope)) return false;
  const prefix = pattern.slice(0, -canonicalEnvelope.length);
  return isPositiveLookaheadIntersection(prefix);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareUtf8(left, right)));
}

function canonicalContractValue(value) {
  if (Array.isArray(value)) return value.map(canonicalContractValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([key, child]) => [key, canonicalContractValue(child)]),
  );
}

function assertNoUnknownExtensions(value, pointer = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUnknownExtensions(item, `${pointer}/${index}`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const headerMapEntry = pointer.endsWith("/headers");
    if (!headerMapEntry && key.startsWith("x-calyx-") && !ALLOWED_EXTENSIONS.has(key)) {
      throw new Error(`Unknown Calyx contract extension ${key} at ${pointer || "/"}.`);
    }
    assertNoUnknownExtensions(child, `${pointer}/${key}`);
  }
}

function assertExtensionLocation(value, allowed, pointer) {
  for (const key of Object.keys(value)) {
    if (key.startsWith("x-calyx-") && !allowed.has(key)) {
      throw new Error(`Calyx contract extension ${key} is not semantically consumed at ${pointer}.`);
    }
  }
}

function assertNoNestedExtensions(value, pointer) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoNestedExtensions(child, `${pointer}/${String(index)}`));
    return;
  }
  if (!isRecord(value)) return;
  assertExtensionLocation(value, new Set(), pointer);
  Object.entries(value).forEach(([key, child]) => assertNoNestedExtensions(child, `${pointer}/${key}`));
}

function assertBearerSecurity(rawSecurity, label) {
  if (!Array.isArray(rawSecurity) || rawSecurity.length !== 1) {
    throw new Error(`${label} must declare exactly the generated bearerAuth security requirement.`);
  }
  const requirement = requireObject(rawSecurity[0], `${label} requirement`);
  assertExactKeys(requirement, ["bearerAuth"], `${label} requirement`);
  if (!Array.isArray(requirement.bearerAuth) || requirement.bearerAuth.length !== 0) {
    throw new Error(`${label} bearerAuth scopes must be empty.`);
  }
}

function bearerTokenContract(document) {
  const contract = requireObject(
    document["x-calyx-bearer-token-contract"],
    "OpenAPI bearer-token contract",
  );
  assertExactKeys(contract, ["encoding", "max_bytes", "pattern"], "OpenAPI bearer-token contract");
  if (contract.encoding !== "ascii") {
    throw new Error("OpenAPI bearer-token contract encoding must be ascii.");
  }
  requirePositiveInteger(contract.max_bytes, "OpenAPI bearer-token contract max_bytes");
  if (contract.max_bytes !== CALYX_BEARER_TOKEN_MAX_BYTES) {
    throw new Error(
      `OpenAPI bearer-token contract max_bytes must be exactly ${String(CALYX_BEARER_TOKEN_MAX_BYTES)}.`,
    );
  }
  requireString(contract.pattern, "OpenAPI bearer-token contract pattern");
  if (contract.pattern !== CALYX_BEARER_TOKEN_PATTERN_SOURCE) {
    throw new Error("OpenAPI bearer-token contract pattern drifted from the exact Calyx bearer-token language.");
  }
  return Object.freeze({
    encoding: contract.encoding,
    max_bytes: contract.max_bytes,
    pattern: contract.pattern,
  });
}

function assertDocumentStandardVocabulary(document) {
  assertExactKeys(document, DOCUMENT_KEYS, "OpenAPI document");
  bearerTokenContract(document);
  requirePositiveInteger(document["x-calyx-request-target-max-bytes"], "OpenAPI maximum request-target bytes");
  if (document["x-calyx-request-target-max-bytes"] !== REQUEST_TARGET_MAX_BYTES) {
    throw new Error(`OpenAPI maximum request-target bytes must be exactly ${String(REQUEST_TARGET_MAX_BYTES)}.`);
  }
  const info = requireObject(document.info, "OpenAPI info");
  assertExactKeys(info, INFO_KEYS, "OpenAPI info");
  requireString(info.title, "OpenAPI info title");
  requireString(info.version, "OpenAPI info version");
  if (info.description !== undefined) requireString(info.description, "OpenAPI info description");
  const paths = requireObject(document.paths, "OpenAPI paths");
  for (const [path, rawPathItem] of Object.entries(paths)) {
    const pathItem = requireObject(rawPathItem, `OpenAPI path item ${path}`);
    assertExactKeys(pathItem, PATH_ITEM_KEYS, `OpenAPI path item ${path}`);
    if (Object.keys(pathItem).length === 0) throw new Error(`OpenAPI path item ${path} has no supported operation.`);
    for (const [method, rawOperation] of Object.entries(pathItem)) {
      const operation = requireObject(rawOperation, `OpenAPI ${method.toUpperCase()} operation at ${path}`);
      requireString(operation.operationId, `OpenAPI ${method.toUpperCase()} operationId at ${path}`);
    }
  }
  const components = requireObject(document.components, "OpenAPI components");
  assertExactKeys(components, COMPONENT_KEYS, "OpenAPI components");
  requireObject(components.schemas, "OpenAPI components.schemas");
  const securitySchemes = requireObject(components.securitySchemes, "OpenAPI components.securitySchemes");
  assertExactKeys(securitySchemes, ["bearerAuth"], "OpenAPI components.securitySchemes");
  const bearerAuth = requireObject(securitySchemes.bearerAuth, "OpenAPI bearerAuth security scheme");
  assertExactKeys(bearerAuth, ["scheme", "type"], "OpenAPI bearerAuth security scheme");
  if (bearerAuth.type !== "http" || bearerAuth.scheme !== "bearer") {
    throw new Error("OpenAPI bearerAuth security scheme contradicts the generated bearer transport.");
  }
}

function assertProjectedStandardVocabulary(document) {
  for (const { path, method, operation } of operationEntries(document)) {
    const pointer = `#/paths/${path}/${method.toLowerCase()}`;
    assertExactKeys(operation, OPERATION_KEYS, `OpenAPI operation at ${pointer}`);
    requireString(operation.summary, `OpenAPI operation summary at ${pointer}`);
    if (
      !Array.isArray(operation.tags)
      || operation.tags.length !== 1
      || operation.tags[0] !== operation["x-calyx-profile"]
    ) {
      throw new Error(`OpenAPI operation tags at ${pointer} must exactly name its Calyx profile.`);
    }
    assertBearerSecurity(operation.security, `OpenAPI operation security at ${pointer}`);
    const parameters = operation.parameters ?? [];
    if (!Array.isArray(parameters)) throw new Error(`OpenAPI operation parameters at ${pointer} must be an array.`);
    for (const [index, rawParameter] of parameters.entries()) {
      const parameter = requireObject(rawParameter, `OpenAPI parameter at ${pointer}/${String(index)}`);
      assertExactKeys(parameter, PARAMETER_KEYS, `OpenAPI parameter at ${pointer}/${String(index)}`);
    }
    if (operation.requestBody !== undefined) {
      const requestBody = requireObject(operation.requestBody, `OpenAPI request body at ${pointer}`);
      assertExactKeys(requestBody, REQUEST_BODY_KEYS, `OpenAPI request body at ${pointer}`);
      for (const [mediaType, rawMedia] of Object.entries(requireObject(requestBody.content, `OpenAPI request content at ${pointer}`))) {
        const media = requireObject(rawMedia, `OpenAPI request media ${mediaType} at ${pointer}`);
        assertExactKeys(media, MEDIA_KEYS, `OpenAPI request media ${mediaType} at ${pointer}`);
        requireObject(media.schema, `OpenAPI request media schema ${mediaType} at ${pointer}`);
      }
    }
    for (const [status, rawResponse] of Object.entries(requireObject(operation.responses, `OpenAPI responses at ${pointer}`))) {
      if (!/^[1-5][0-9]{2}$/u.test(status)) {
        throw new Error(`OpenAPI response status ${status} at ${pointer} is unsupported.`);
      }
      const response = requireObject(rawResponse, `OpenAPI response ${status} at ${pointer}`);
      assertExactKeys(response, RESPONSE_KEYS, `OpenAPI response ${status} at ${pointer}`);
      requireString(response.description, `OpenAPI response description ${status} at ${pointer}`);
      const headers = response.headers ?? {};
      const headerNames = new Set();
      for (const [name, rawHeader] of Object.entries(requireObject(headers, `OpenAPI response headers ${status} at ${pointer}`))) {
        if (!HTTP_FIELD_NAME_PATTERN.test(name)) {
          throw new Error(`OpenAPI response ${status} at ${pointer} uses non-representable header name ${name}.`);
        }
        const normalizedName = name.toLowerCase();
        if (headerNames.has(normalizedName)) {
          throw new Error(`OpenAPI response ${status} at ${pointer} repeats header ${normalizedName}.`);
        }
        headerNames.add(normalizedName);
        const header = requireObject(rawHeader, `OpenAPI response header ${name} at ${pointer}`);
        assertExactKeys(header, HEADER_KEYS, `OpenAPI response header ${name} at ${pointer}`);
        if (header.description !== undefined) {
          requireString(header.description, `OpenAPI response header description ${name} at ${pointer}`);
        }
        if (typeof header.required !== "boolean") {
          throw new Error(`OpenAPI response header ${name} at ${pointer} must declare required metadata.`);
        }
        requireObject(header.schema, `OpenAPI response header schema ${name} at ${pointer}`);
      }
      const content = response.content ?? {};
      for (const [mediaType, rawMedia] of Object.entries(requireObject(content, `OpenAPI response content ${status} at ${pointer}`))) {
        const media = requireObject(rawMedia, `OpenAPI response media ${mediaType} at ${pointer}`);
        assertExactKeys(
          media,
          mediaType === "text/event-stream" ? SSE_MEDIA_KEYS : MEDIA_KEYS,
          `OpenAPI response media ${mediaType} at ${pointer}`,
        );
        requireObject(media.schema, `OpenAPI response media schema ${mediaType} at ${pointer}`);
      }
    }
  }
}

function operationEntries(document) {
  const entries = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    if (!isRecord(pathItem)) throw new Error(`Invalid OpenAPI path item ${path}.`);
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isRecord(operation) || typeof operation.operationId !== "string") continue;
      entries.push({ path, method: method.toUpperCase(), operation });
    }
  }
  return entries.sort((left, right) => compareUtf8(left.operation.operationId, right.operation.operationId));
}

function assertProjectedExtensionLocations(document) {
  for (const { path, method, operation } of operationEntries(document)) {
    const pointer = `#/paths/${path}/${method.toLowerCase()}`;
    assertExtensionLocation(operation, OPERATION_EXTENSIONS, pointer);
    for (const [key, value] of Object.entries(operation)) {
      // Success-contract header schemas are validated against the matching
      // response-header schema by normalizedHeaderContracts. Their enum
      // extensions are therefore consumed as schemas rather than opaque
      // extension payload keys.
      if (key.startsWith("x-calyx-") && key !== "x-calyx-success-contracts") {
        assertNoNestedExtensions(value, `${pointer}/${key}`);
      }
    }
    const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
    for (const [index, rawParameter] of parameters.entries()) {
      const parameter = requireObject(rawParameter, `parameter at ${pointer}/${String(index)}`);
      assertExtensionLocation(parameter, new Set(), `${pointer}/parameters/${String(index)}`);
    }
    const requestBody = isRecord(operation.requestBody) ? operation.requestBody : undefined;
    if (requestBody) {
      assertExtensionLocation(requestBody, new Set(["x-calyx-max-bytes"]), `${pointer}/requestBody`);
      const content = isRecord(requestBody.content) ? requestBody.content : {};
      for (const [mediaType, rawMedia] of Object.entries(content)) {
        const media = requireObject(rawMedia, `request media at ${pointer}/${mediaType}`);
        assertExtensionLocation(media, new Set(), `${pointer}/requestBody/content/${mediaType}`);
      }
    }
    for (const [status, rawResponse] of Object.entries(requireObject(operation.responses, `${pointer} responses`))) {
      const response = requireObject(rawResponse, `response ${status} at ${pointer}`);
      const responsePointer = `${pointer}/responses/${status}`;
      assertExtensionLocation(response, RESPONSE_EXTENSIONS, responsePointer);
      for (const [key, value] of Object.entries(response)) {
        if (key.startsWith("x-calyx-")) assertNoNestedExtensions(value, `${responsePointer}/${key}`);
      }
      const headers = isRecord(response.headers) ? response.headers : {};
      for (const [name, rawHeader] of Object.entries(headers)) {
        const header = requireObject(rawHeader, `response header ${name} at ${responsePointer}`);
        assertExtensionLocation(header, new Set(), `${responsePointer}/headers/${name}`);
      }
      const content = isRecord(response.content) ? response.content : {};
      for (const [mediaType, rawMedia] of Object.entries(content)) {
        const media = requireObject(rawMedia, `response media ${mediaType} at ${responsePointer}`);
        const mediaPointer = `${responsePointer}/content/${mediaType}`;
        assertExtensionLocation(media, mediaType === "text/event-stream" ? SSE_MEDIA_EXTENSIONS : new Set(), mediaPointer);
        for (const [key, value] of Object.entries(media)) {
          if (key.startsWith("x-calyx-") && key !== "x-calyx-sse-event-schema") {
            assertNoNestedExtensions(value, `${mediaPointer}/${key}`);
          }
        }
      }
    }
  }
}

function fullSurfaces(profile, operationId) {
  if (profile === "consumer_v1") return ["consumer", "admin"];
  if (profile === "control_plane_admin_v1") return ["admin"];
  if (profile === "internal_runtime") return [];
  throw new Error(`Operation ${operationId} uses unknown profile ${String(profile)}.`);
}

function assertClientOmission(rawOmission, operationId, missingSurfaces) {
  if (missingSurfaces.length === 0) {
    if (rawOmission !== undefined) {
      throw new Error(`Operation ${operationId} declares client omission provenance without omitting a canonical surface.`);
    }
    return;
  }
  const omission = requireObject(rawOmission, `Operation ${operationId} client omission`);
  assertExactKeys(omission, ["reason", "issue", "expires_on"], `Operation ${operationId} client omission`);
  if (!["predecessor", "decay", "staged"].includes(omission.reason)) {
    throw new Error(`Operation ${operationId} client omission reason is not in the closed lifecycle registry.`);
  }
  const issue = requireString(omission.issue, `Operation ${operationId} client omission issue`);
  if (!/^POL-[1-9][0-9]*$/u.test(issue)) {
    throw new Error(`Operation ${operationId} client omission issue must be a canonical POL issue identifier.`);
  }
  const expiresOn = requireString(omission.expires_on, `Operation ${operationId} client omission expiry`);
  const timestamp = /^\d{4}-\d{2}-\d{2}$/u.test(expiresOn)
    ? Date.parse(`${expiresOn}T00:00:00.000Z`)
    : Number.NaN;
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== expiresOn) {
    throw new Error(`Operation ${operationId} client omission expiry must be an ISO calendar date.`);
  }
}

function assertPolicyDate(rawDate, label) {
  const timestamp = /^\d{4}-\d{2}-\d{2}$/u.test(rawDate)
    ? Date.parse(`${rawDate}T00:00:00.000Z`)
    : Number.NaN;
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== rawDate) {
    throw new Error(`${label} must be an ISO calendar date.`);
  }
  return rawDate;
}

/** Time-dependent omission expiry is a policy check, never compiler authority. */
export function assertClientOmissionPolicy(sourceBytes, asOf) {
  const evaluationDate = assertPolicyDate(asOf, "Client omission policy asOf");
  const source = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes));
  for (const entry of operationEntries(source)) {
    const omission = entry.operation["x-calyx-client-omission"];
    if (!isRecord(omission)) continue;
    const expiresOn = assertPolicyDate(
      requireString(omission.expires_on, `Operation ${entry.operation.operationId} client omission expiry`),
      `Operation ${entry.operation.operationId} client omission expiry`,
    );
    if (expiresOn < evaluationDate) {
      throw new Error(`Operation ${entry.operation.operationId} client omission expired on ${expiresOn} as of ${evaluationDate}.`);
    }
  }
}

function assertProjectionLaw(entry) {
  const { path, operation } = entry;
  const operationId = operation.operationId;
  const profile = operation["x-calyx-profile"];
  const expectedProfile = path.startsWith("/v1/admin/")
    ? "control_plane_admin_v1"
    : path.startsWith("/v1/internal/")
      ? "internal_runtime"
      : "consumer_v1";
  if (profile !== expectedProfile) {
    throw new Error(`Operation ${operationId} contradicts the path-prefix/profile law.`);
  }
  const operationIdPrefixValid = profile === "control_plane_admin_v1"
    ? operationId.startsWith("admin.")
    : profile === "internal_runtime"
      ? operationId.startsWith("internal.")
      : !operationId.startsWith("admin.") && !operationId.startsWith("internal.");
  if (!operationIdPrefixValid) {
    throw new Error(`Operation ${operationId} contradicts the operationId-prefix/profile law.`);
  }
  const surfaces = operation["x-calyx-client-surfaces"];
  if (!Array.isArray(surfaces) || surfaces.some((surface) => !SURFACES.includes(surface))) {
    throw new Error(`Operation ${operationId} has an invalid x-calyx-client-surfaces contract.`);
  }
  const unique = [...new Set(surfaces)].sort(compareUtf8);
  if (JSON.stringify(unique) !== JSON.stringify([...surfaces].sort(compareUtf8))) {
    throw new Error(`Operation ${operationId} repeats a client surface.`);
  }
  const full = fullSurfaces(profile, operationId);
  const unsafe = unique.filter((surface) => !full.includes(surface));
  if (unsafe.length > 0) {
    throw new Error(`Operation ${operationId} publishes to a client surface forbidden by its profile.`);
  }
  const missing = full.filter((surface) => !unique.includes(surface));
  if (profile === "internal_runtime") {
    if (operation["x-calyx-client-omission"] !== undefined) {
      throw new Error(`Operation ${operationId} internal profile cannot carry public-client omission provenance.`);
    }
  } else {
    assertClientOmission(operation["x-calyx-client-omission"], operationId, missing);
  }
  return surfaces;
}

function componentIndex(document) {
  const schemas = document.components?.schemas;
  if (!isRecord(schemas)) throw new Error("OpenAPI components.schemas is required.");
  const byIdentity = new Map();
  for (const [key, schema] of Object.entries(schemas)) {
    if (!isRecord(schema)) throw new Error(`Component schema ${key} is invalid.`);
    const id = schema["x-calyx-schema-id"];
    const role = schema["x-calyx-schema-role"];
    if (typeof id !== "string" || (role !== "request" && role !== "response")) {
      throw new Error(`Component schema ${key} lacks its Calyx identity/role extensions.`);
    }
    const identity = `${role}:${id}`;
    if (byIdentity.has(identity)) throw new Error(`Duplicate component identity ${identity}.`);
    byIdentity.set(identity, { key, ref: { $ref: `#/components/schemas/${key}` }, schema });
  }
  return byIdentity;
}

function requireObject(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

function requireFieldName(value, label) {
  const field = requireString(value, label);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(field)) throw new Error(`${label} is not a supported field name.`);
  return field;
}

function requireScalarPath(value, label) {
  const path = requireString(value, label);
  if (!/^(?:\$|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/u.test(path)) {
    throw new Error(`${label} is not a supported scalar path.`);
  }
  return path;
}

function assertExactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unsupported fields: ${unknown.sort(compareUtf8).join(", ")}.`);
}

function assertOpenOrClosedEnumContract(value, pointer, role) {
  if (!Object.hasOwn(value, "x-calyx-enum-mode")) {
    if (Object.hasOwn(value, "x-calyx-known-values") || Object.hasOwn(value, "x-calyx-enum-closure")) {
      throw new Error(`Enum metadata lacks x-calyx-enum-mode at ${pointer}.`);
    }
    return;
  }
  const mode = value["x-calyx-enum-mode"];
  if (mode !== "open" && mode !== "closed") throw new Error(`Invalid Calyx enum contract at ${pointer}.`);
  if (mode === "open") {
    if (role === "request") throw new Error(`Request schema cannot carry an open enum at ${pointer}.`);
    const knownValues = value["x-calyx-known-values"];
    if (
      value.type !== "string"
      || !Array.isArray(knownValues)
      || knownValues.length === 0
      || knownValues.some((entry) => typeof entry !== "string")
      || new Set(knownValues).size !== knownValues.length
    ) {
      throw new Error(`Invalid open-enum known-values contract at ${pointer}.`);
    }
    if (value.enum !== undefined && (
      !Array.isArray(value.enum)
      || JSON.stringify(value.enum) !== JSON.stringify(knownValues)
    )) {
      throw new Error(`Open enum known-values drift at ${pointer}.`);
    }
    if (value["x-calyx-enum-closure"] !== undefined) {
      throw new Error(`Open enum carries a closed-enum classification at ${pointer}.`);
    }
    return;
  }
  if (
    !Array.isArray(value.enum)
    || value.enum.length === 0
    || !["schema-major-discriminator", "wire-shape-discriminator"].includes(value["x-calyx-enum-closure"])
    || value["x-calyx-known-values"] !== undefined
  ) {
    throw new Error(`Closed enum lacks its audited closure at ${pointer}.`);
  }
}

function assertClientSchemaSubset(document) {
  const visit = (rawSchema, pointer, role, componentRoot = false) => {
    const schema = requireObject(rawSchema, `client schema at ${pointer}`);
    const allowedExtensions = componentRoot
      ? SCHEMA_EXTENSIONS
      : new Set([...SCHEMA_EXTENSIONS].filter((key) => key !== "x-calyx-schema-id" && key !== "x-calyx-schema-role"));
    assertExtensionLocation(schema, allowedExtensions, pointer);
    assertOpenOrClosedEnumContract(schema, pointer, role);
    const unsupported = Object.keys(schema).filter((key) => !CLIENT_SCHEMA_KEYWORDS.has(key));
    if (unsupported.length > 0) {
      throw new Error(`Client schema uses unsupported keywords at ${pointer}: ${unsupported.sort(compareUtf8).join(", ")}.`);
    }
    if (schema.$ref !== undefined) {
      if (
        typeof schema.$ref !== "string"
        || !schema.$ref.startsWith("#/components/schemas/")
        || Object.keys(schema).length !== 1
      ) {
        throw new Error(`Client schema reference has unsupported shape or siblings at ${pointer}.`);
      }
      return;
    }
    if (schema.type !== undefined && (typeof schema.type !== "string" || !CLIENT_SCHEMA_TYPES.has(schema.type))) {
      throw new Error(`Client schema uses an unsupported type shape at ${pointer}.`);
    }
    if (schema.nullable !== undefined && typeof schema.nullable !== "boolean") {
      throw new Error(`Client schema nullable must be boolean at ${pointer}.`);
    }
    for (const keyword of ["minimum", "maximum"]) {
      if (schema[keyword] !== undefined && (typeof schema[keyword] !== "number" || !Number.isFinite(schema[keyword]))) {
        throw new Error(`Client schema ${keyword} must be finite at ${pointer}.`);
      }
    }
    if (typeof schema.minimum === "number" && typeof schema.maximum === "number" && schema.minimum > schema.maximum) {
      throw new Error(`Client schema numeric bounds are inverted at ${pointer}.`);
    }
    for (const [exclusive, bound] of [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]]) {
      if (schema[exclusive] !== undefined && typeof schema[exclusive] !== "boolean") {
        throw new Error(`Client schema ${exclusive} must use the OpenAPI boolean form at ${pointer}.`);
      }
      if (schema[exclusive] === true && typeof schema[bound] !== "number") {
        throw new Error(`Client schema ${exclusive} lacks ${bound} at ${pointer}.`);
      }
    }
    for (const keyword of ["minItems", "maxItems", "minLength", "maxLength"]) {
      if (schema[keyword] !== undefined && (!Number.isSafeInteger(schema[keyword]) || schema[keyword] < 0)) {
        throw new Error(`Client schema ${keyword} must be a non-negative safe integer at ${pointer}.`);
      }
    }
    for (const [minimum, maximum] of [["minItems", "maxItems"], ["minLength", "maxLength"]]) {
      if (typeof schema[minimum] === "number" && typeof schema[maximum] === "number" && schema[minimum] > schema[maximum]) {
        throw new Error(`Client schema ${minimum}/${maximum} bounds are inverted at ${pointer}.`);
      }
    }
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== "string") throw new Error(`Client schema pattern must be a string at ${pointer}.`);
      try {
        new RegExp(schema.pattern, "u");
      } catch {
        throw new Error(`Client schema pattern is invalid at ${pointer}.`);
      }
    }
    if (schema.required !== undefined && (
      !Array.isArray(schema.required)
      || schema.required.some((name) => typeof name !== "string")
      || new Set(schema.required).size !== schema.required.length
    )) {
      throw new Error(`Client schema required must contain unique strings at ${pointer}.`);
    }
    if (
      schema.required !== undefined
      && schema.type !== "object"
      && !isRecord(schema.properties)
    ) {
      throw new Error(`Client schema required is only supported for object schemas at ${pointer}.`);
    }
    if (schema.enum !== undefined && (
      !Array.isArray(schema.enum)
      || schema.enum.length === 0
      || schema.enum.some((value) => value !== null && !["boolean", "number", "string"].includes(typeof value))
      || new Set(schema.enum.map((value) => JSON.stringify(value))).size !== schema.enum.length
    )) {
      throw new Error(`Client schema enum uses unsupported equality semantics at ${pointer}.`);
    }
    if (Object.hasOwn(schema, "const") && schema.const !== null && !["boolean", "number", "string"].includes(typeof schema.const)) {
      throw new Error(`Client schema const uses unsupported equality semantics at ${pointer}.`);
    }
    if (
      (schema.nullable === true || schema.type === "null")
      && (schema.enum !== undefined || Object.hasOwn(schema, "const"))
    ) {
      throw new Error(`Client schema combines nullability with unsupported literal semantics at ${pointer}.`);
    }
    for (const keyword of ["format", "title", "description"]) {
      if (schema[keyword] !== undefined && typeof schema[keyword] !== "string") {
        throw new Error(`Client schema annotation ${keyword} must be a string at ${pointer}.`);
      }
    }
    if (schema.format !== undefined && (
      schema.type !== "string"
      || !["date-time", "uri"].includes(schema.format)
    )) {
      throw new Error(`Client schema format ${String(schema.format)} is not executable at ${pointer}.`);
    }
    if (
      schema.format === "date-time"
      && !isProvenPatternIntersection(schema.pattern, CANONICAL_DATE_TIME_PATTERN_SOURCE)
    ) {
      throw new Error(`Client date-time schema is wider than the canonical UTC wire grammar at ${pointer}.`);
    }
    if (schema.type === "integer") {
      if (
        !Number.isSafeInteger(schema.minimum)
        || !Number.isSafeInteger(schema.maximum)
        || schema.minimum < Number.MIN_SAFE_INTEGER
        || schema.maximum > Number.MAX_SAFE_INTEGER
      ) {
        throw new Error(`Client integer schema lacks a closed safe-integer envelope at ${pointer}.`);
      }
      if (Object.hasOwn(schema, "const") && !Number.isSafeInteger(schema.const)) {
        throw new Error(`Client integer schema has an unsafe literal at ${pointer}.`);
      }
      if (Array.isArray(schema.enum) && schema.enum.some((entry) => !Number.isSafeInteger(entry))) {
        throw new Error(`Client integer schema has an unsafe enum member at ${pointer}.`);
      }
      const insideIntegerBounds = (entry) => (
        (schema.exclusiveMinimum === true ? entry > schema.minimum : entry >= schema.minimum)
        && (schema.exclusiveMaximum === true ? entry < schema.maximum : entry <= schema.maximum)
      );
      if (Object.hasOwn(schema, "const") && !insideIntegerBounds(schema.const)) {
        throw new Error(`Client integer schema has an out-of-bounds literal at ${pointer}.`);
      }
      if (Array.isArray(schema.enum) && schema.enum.some((entry) => !insideIntegerBounds(entry))) {
        throw new Error(`Client integer schema has an out-of-bounds enum member at ${pointer}.`);
      }
    }
    const hasNumericIdentity = (
      (Object.hasOwn(schema, "const") && typeof schema.const === "number")
      || (Array.isArray(schema.enum) && schema.enum.some((entry) => typeof entry === "number"))
    );
    if (hasNumericIdentity && schema.type !== "integer") {
      throw new Error(
        `Client numeric identity must use a bounded integer or a separately designed canonical decimal-string contract at ${pointer}.`,
      );
    }
    if (schema.examples !== undefined && !Array.isArray(schema.examples)) {
      throw new Error(`Client schema annotation examples must be an array at ${pointer}.`);
    }
    for (const keyword of ["deprecated", "readOnly", "writeOnly"]) {
      if (schema[keyword] !== undefined && typeof schema[keyword] !== "boolean") {
        throw new Error(`Client schema annotation ${keyword} must be boolean at ${pointer}.`);
      }
    }
    if (schema.properties !== undefined) {
      for (const [name, child] of Object.entries(requireObject(schema.properties, `properties at ${pointer}`))) {
        visit(child, `${pointer}/properties/${name}`, role);
      }
    }
    if (
      schema.additionalProperties !== undefined
      && typeof schema.additionalProperties !== "boolean"
      && !isRecord(schema.additionalProperties)
    ) {
      throw new Error(`Client schema additionalProperties has an unsupported shape at ${pointer}.`);
    }
    if (schema.additionalProperties === false && role === "response" && schema["x-calyx-unknown-field-policy"] !== "reject") {
      throw new Error(`Closed response object lacks reject unknown-field policy at ${pointer}.`);
    }
    if (isRecord(schema.additionalProperties)) visit(schema.additionalProperties, `${pointer}/additionalProperties`, role);
    if (schema.type === "array" && !Array.isArray(schema.items) && !isRecord(schema.items)) {
      throw new Error(`Client array schema lacks an items contract at ${pointer}.`);
    }
    if (schema.items !== undefined && !Array.isArray(schema.items) && !isRecord(schema.items)) {
      throw new Error(`Client schema items has an unsupported shape at ${pointer}.`);
    }
    if (Array.isArray(schema.items)) {
      if (
        schema.items.length === 0
        || schema.minItems !== schema.items.length
        || schema.maxItems !== schema.items.length
      ) {
        throw new Error(`Client tuple schema must declare its exact generated length at ${pointer}.`);
      }
      schema.items.forEach((child, index) => visit(child, `${pointer}/items/${String(index)}`, role));
    } else if (isRecord(schema.items)) {
      if (role === "request" && Object.keys(schema.items).length === 0) {
        throw new Error(`Request array uses an unsupported unconstrained item schema at ${pointer}.`);
      }
      visit(schema.items, `${pointer}/items`, role);
    }
    if (role === "request" && schema.allOf !== undefined) {
      throw new Error(`Request schema uses unsupported allOf semantics at ${pointer}.`);
    }
    for (const keyword of ["allOf", "oneOf", "anyOf"]) {
      if (schema[keyword] !== undefined && (!Array.isArray(schema[keyword]) || schema[keyword].length === 0)) {
        throw new Error(`Client schema ${keyword} must be a non-empty array at ${pointer}.`);
      }
      if (Array.isArray(schema[keyword])) {
        schema[keyword].forEach((child, index) => visit(child, `${pointer}/${keyword}/${String(index)}`, role));
      }
    }
    if (role === "request" && schema.not !== undefined) throw new Error(`Request schema uses unsupported not semantics at ${pointer}.`);
    if (schema.not !== undefined && !isRecord(schema.not)) throw new Error(`Client schema not must be an object at ${pointer}.`);
    if (isRecord(schema.not)) visit(schema.not, `${pointer}/not`, role);
  };
  for (const [key, schema] of Object.entries(requireObject(document.components?.schemas, "components.schemas"))) {
    const role = isRecord(schema) ? schema["x-calyx-schema-role"] : undefined;
    if (role !== "request" && role !== "response") throw new Error(`Component schema ${key} has no valid schema role.`);
    visit(schema, `#/components/schemas/${key}`, role, true);
  }
  for (const { path, method, operation } of operationEntries(document)) {
    const pointer = `#/paths/${path}/${method.toLowerCase()}`;
    const binarySuccessMedia = new Set(
      (Array.isArray(operation["x-calyx-success-contracts"])
        ? operation["x-calyx-success-contracts"]
        : [])
        .filter((contract) => isRecord(contract) && contract.representation === "bytes")
        .map((contract) => `${String(contract.status)}\u0000${String(
          contract.media_type === "dynamic" ? "*/*" : contract.media_type,
        )}`),
    );
    const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
    for (const [index, parameter] of parameters.entries()) {
      if (isRecord(parameter) && parameter.schema !== undefined) {
        visit(parameter.schema, `${pointer}/parameters/${String(index)}/schema`, "request");
      }
    }
    const requestBody = isRecord(operation.requestBody) ? operation.requestBody : undefined;
    const requestContent = requestBody && isRecord(requestBody.content) ? requestBody.content : {};
    for (const [mediaType, media] of Object.entries(requestContent)) {
      if (isRecord(media) && media.schema !== undefined) {
        visit(media.schema, `${pointer}/requestBody/content/${mediaType}/schema`, "request");
      }
    }
    const responses = isRecord(operation.responses) ? operation.responses : {};
    for (const [status, response] of Object.entries(responses)) {
      if (!isRecord(response)) continue;
      const headers = isRecord(response.headers) ? response.headers : {};
      for (const [name, header] of Object.entries(headers)) {
        if (isRecord(header) && header.schema !== undefined) {
          assertResponseHeaderWireSchema(
            document,
            header.schema,
            `${pointer}/responses/${status}/headers/${name}`,
          );
          visit(header.schema, `${pointer}/responses/${status}/headers/${name}/schema`, "response");
        }
      }
      const content = isRecord(response.content) ? response.content : {};
      for (const [mediaType, media] of Object.entries(content)) {
        if (!isRecord(media)) continue;
        if (media.schema !== undefined) {
          const binaryMediaSchema = isRecord(media.schema)
            && media.schema.type === "string"
            && media.schema.format === "binary"
            && Object.keys(media.schema).length === 2;
          if (binaryMediaSchema && !binarySuccessMedia.has(`${status}\u0000${mediaType}`)) {
            throw new Error(`Client binary schema lacks declared bytes-success authority at ${pointer}/responses/${status}/content/${mediaType}/schema.`);
          }
          if (!binaryMediaSchema) {
            visit(media.schema, `${pointer}/responses/${status}/content/${mediaType}/schema`, "response");
          }
        }
        if (media["x-calyx-sse-event-schema"] !== undefined) {
          visit(
            media["x-calyx-sse-event-schema"],
            `${pointer}/responses/${status}/content/${mediaType}/x-calyx-sse-event-schema`,
            "response",
          );
        }
      }
    }
  }
}

function schemaVariants(document, rawSchema, label, activeReferences = new Set()) {
  const schema = requireObject(rawSchema, `selector schema for ${label}`);
  if (typeof schema.$ref === "string") {
    const prefix = "#/components/schemas/";
    if (!schema.$ref.startsWith(prefix)) throw new Error(`Selector ${label} uses unsupported reference ${schema.$ref}.`);
    if (activeReferences.has(schema.$ref)) throw new Error(`Selector ${label} crosses a cyclic schema reference.`);
    const target = document.components?.schemas?.[schema.$ref.slice(prefix.length)];
    if (!isRecord(target)) throw new Error(`Selector ${label} has unresolved reference ${schema.$ref}.`);
    const nextReferences = new Set(activeReferences);
    nextReferences.add(schema.$ref);
    return schemaVariants(document, target, label, nextReferences);
  }
  let variants = [[schema]];
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      const branchVariants = schemaVariants(document, branch, label, activeReferences);
      variants = variants.flatMap((prefix) => branchVariants.map((suffix) => [...prefix, ...suffix]));
    }
  }
  for (const keyword of ["oneOf", "anyOf"]) {
    if (!Array.isArray(schema[keyword])) continue;
    const alternatives = schema[keyword].flatMap((branch) => schemaVariants(document, branch, label, activeReferences));
    variants = variants.flatMap((prefix) => alternatives.map((suffix) => [...prefix, ...suffix]));
  }
  return variants;
}

function conjunctiveSchemaVariants(document, rawSchemas, label) {
  let variants = [[]];
  for (const rawSchema of rawSchemas) {
    const alternatives = schemaVariants(document, rawSchema, label);
    variants = variants.flatMap((prefix) => alternatives.map((suffix) => [...prefix, ...suffix]));
  }
  return variants;
}

function schemaVariantType(variant, label) {
  const declared = [...new Set(variant.map((schema) => schema.type).filter((type) => typeof type === "string"))];
  if (declared.length === 0) {
    if (variant.some((schema) => isRecord(schema.properties))) return "object";
    if (variant.some((schema) => schema.items !== undefined)) return "array";
    throw new Error(`Selector ${label} has no terminal schema type.`);
  }
  if (declared.length === 1) return declared[0];
  if (declared.length === 2 && declared.includes("integer") && declared.includes("number")) return "integer";
  throw new Error(`Selector ${label} resolves to incompatible schema types ${declared.sort(compareUtf8).join(", ")}.`);
}

function assertSelectorTypes(states, accepted, label) {
  if (states.length === 0) throw new Error(`Selector ${label} resolves vacuously.`);
  for (const state of states) {
    const type = schemaVariantType(state.variant, label);
    if (!accepted.includes(type)) {
      throw new Error(`Selector ${label} must resolve to ${accepted.join(" or ")}, not ${type}.`);
    }
  }
}

function selectSchemaProperty(document, states, field, label) {
  const selected = [];
  for (const state of states) {
    assertSelectorTypes([state], ["object"], label);
    const definitions = state.variant.flatMap((schema) => {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      return Object.hasOwn(properties, field) ? [properties[field]] : [];
    });
    if (definitions.length === 0) throw new Error(`Selector ${label} does not resolve field ${field} across every schema branch.`);
    const locallyRequired = state.variant.some((schema) => Array.isArray(schema.required) && schema.required.includes(field));
    const required = state.required && locallyRequired;
    for (const variant of conjunctiveSchemaVariants(document, definitions, `${label}.${field}`)) {
      selected.push({ variant, required, locallyRequired });
    }
  }
  if (selected.length === 0) throw new Error(`Selector ${label}.${field} resolves vacuously.`);
  return selected;
}

function selectArrayItems(document, states, label) {
  assertSelectorTypes(states, ["array"], label);
  const selected = [];
  for (const state of states) {
    const definitions = state.variant.flatMap((schema) => schema.items === undefined ? [] : [schema.items]);
    if (definitions.length === 0) throw new Error(`Selector ${label} reaches an array without an item schema.`);
    for (const variant of conjunctiveSchemaVariants(document, definitions, `${label}[*]`)) {
      selected.push({ variant, required: state.required, locallyRequired: state.locallyRequired });
    }
  }
  if (selected.length === 0) throw new Error(`Selector ${label}[*] resolves vacuously.`);
  return selected;
}

function resolveSchemaSelector(document, ownerSchema, path, label) {
  const states = schemaVariants(document, ownerSchema, label).map((variant) => ({
    variant,
    required: true,
    locallyRequired: true,
  }));
  return resolveSchemaSelectorFromStates(document, states, path, label);
}

function resolveSchemaSelectorFromStates(document, initialStates, path, label) {
  let states = initialStates;
  if (path === "$") return states;
  for (const rawSegment of path.split(".")) {
    const arraySegment = rawSegment.endsWith("[*]");
    const field = arraySegment ? rawSegment.slice(0, -3) : rawSegment;
    states = selectSchemaProperty(document, states, field, label);
    if (arraySegment) states = selectArrayItems(document, states, `${label}.${field}`);
  }
  return states;
}

function requireSelectorPresence(states, label) {
  if (!states.every((state) => state.required)) {
    throw new Error(`Selector ${label} is not required across every schema branch.`);
  }
}

function requireLocalSelectorPresence(states, label) {
  if (!states.every((state) => state.locallyRequired)) {
    throw new Error(`Selector ${label} is not required on every selected object branch.`);
  }
}

function assertAttachmentIdentityContract(rawContract, pointer, document, ownerSchema) {
  const contract = requireObject(rawContract, `attachment identity contract at ${pointer}`);
  assertExactKeys(contract, ["object_path", "ref_field", "sha256_field", "ref_template", "sha256_pattern"], `attachment identity contract at ${pointer}`);
  const objectPath = requireString(contract.object_path, `attachment object path at ${pointer}`);
  const refField = requireString(contract.ref_field, `attachment ref field at ${pointer}`);
  const sha256Field = requireString(contract.sha256_field, `attachment sha256 field at ${pointer}`);
  const template = requireString(contract.ref_template, `attachment ref template at ${pointer}`);
  const pattern = requireString(contract.sha256_pattern, `attachment sha256 pattern at ${pointer}`);
  if (!/^(?:\$|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\*\])*)$/u.test(objectPath)) {
    throw new Error(`Attachment object path is unsupported at ${pointer}.`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(refField) || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(sha256Field)) {
    throw new Error(`Attachment identity field is unsupported at ${pointer}.`);
  }
  if (template.split("{sha256}").length !== 2) throw new Error(`Attachment ref template must bind sha256 exactly once at ${pointer}.`);
  try {
    new RegExp(pattern, "u");
  } catch {
    throw new Error(`Attachment sha256 pattern is invalid at ${pointer}.`);
  }
  const objects = resolveSchemaSelector(document, ownerSchema, objectPath, `${pointer} attachment object_path`);
  assertSelectorTypes(objects, ["object"], `${pointer} attachment object_path`);
  for (const [field, name] of [[refField, "ref_field"], [sha256Field, "sha256_field"]]) {
    const selected = selectSchemaProperty(document, objects, field, `${pointer} attachment ${name}`);
    requireLocalSelectorPresence(selected, `${pointer} attachment ${name}`);
    assertSelectorTypes(selected, ["string"], `${pointer} attachment ${name}`);
  }
}

function assertActivityMarkAuthorityContract(rawContract, pointer, document, ownerSchema) {
  const contract = requireObject(rawContract, `activity mark authority contract at ${pointer}`);
  assertExactKeys(contract, ["object_path", "equalities", "target_identity"], `activity mark authority contract at ${pointer}`);
  const objectPath = requireString(contract.object_path, `activity mark authority object path at ${pointer}`);
  if (!/^(?:\$|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\*\])*)$/u.test(objectPath)) {
    throw new Error(`Activity mark authority object path is unsupported at ${pointer}.`);
  }
  const objects = resolveSchemaSelector(document, ownerSchema, objectPath, `${pointer} activity mark objects`);
  assertSelectorTypes(objects, ["object"], `${pointer} activity mark objects`);
  if (!Array.isArray(contract.equalities) || contract.equalities.length === 0) {
    throw new Error(`Activity mark authority contract has no field equalities at ${pointer}.`);
  }
  const seenEqualities = new Set();
  for (const [index, rawEquality] of contract.equalities.entries()) {
    const equality = requireObject(rawEquality, `activity mark equality ${String(index)} at ${pointer}`);
    assertExactKeys(equality, ["left", "right"], `activity mark equality ${String(index)} at ${pointer}`);
    const left = requireScalarPath(equality.left, `activity mark equality left at ${pointer}`);
    const right = requireScalarPath(equality.right, `activity mark equality right at ${pointer}`);
    const identity = `${left}=${right}`;
    if (seenEqualities.has(identity)) throw new Error(`Activity mark authority repeats equality ${identity} at ${pointer}.`);
    seenEqualities.add(identity);
    const leftStates = resolveSchemaSelectorFromStates(document, objects, left, `${pointer} equality left`);
    const rightStates = resolveSchemaSelectorFromStates(document, objects, right, `${pointer} equality right`);
    requireSelectorPresence(leftStates, `${pointer} equality left`);
    requireSelectorPresence(rightStates, `${pointer} equality right`);
    const scalarTypes = ["string", "number", "integer", "boolean"];
    assertSelectorTypes(leftStates, scalarTypes, `${pointer} equality left`);
    assertSelectorTypes(rightStates, scalarTypes, `${pointer} equality right`);
    const leftTypes = [...new Set(leftStates.map((state) => schemaVariantType(state.variant, `${pointer} equality left`)))].sort(compareUtf8);
    const rightTypes = [...new Set(rightStates.map((state) => schemaVariantType(state.variant, `${pointer} equality right`)))].sort(compareUtf8);
    if (JSON.stringify(leftTypes) !== JSON.stringify(rightTypes)) {
      throw new Error(`Activity mark authority equality has incompatible field types at ${pointer}.`);
    }
  }

  const target = requireObject(contract.target_identity, `activity mark target identity at ${pointer}`);
  assertExactKeys(
    target,
    ["kind_field", "id_field", "activity_id_pattern", "source_line_pattern", "source_line_maximum", "suffix_by_kind"],
    `activity mark target identity at ${pointer}`,
  );
  const kindField = requireFieldName(target.kind_field, `activity mark target kind field at ${pointer}`);
  const idField = requireFieldName(target.id_field, `activity mark target id field at ${pointer}`);
  for (const [field, label] of [[kindField, "kind"], [idField, "id"]]) {
    const selected = resolveSchemaSelectorFromStates(document, objects, field, `${pointer} target ${label} field`);
    requireSelectorPresence(selected, `${pointer} target ${label} field`);
    assertSelectorTypes(selected, ["string"], `${pointer} target ${label} field`);
  }
  for (const [pattern, label] of [
    [target.activity_id_pattern, "activity id"],
    [target.source_line_pattern, "source line"],
  ]) {
    requireString(pattern, `activity mark ${label} pattern at ${pointer}`);
    try { new RegExp(pattern, "u"); } catch { throw new Error(`Activity mark ${label} pattern is invalid at ${pointer}.`); }
  }
  if (!Number.isSafeInteger(target.source_line_maximum) || target.source_line_maximum <= 0) {
    throw new Error(`Activity mark source line maximum is not a positive safe integer at ${pointer}.`);
  }
  const suffixes = requireObject(target.suffix_by_kind, `activity mark target suffixes at ${pointer}`);
  assertExactKeys(suffixes, ["turn", "message"], `activity mark target suffixes at ${pointer}`);
  for (const kind of ["turn", "message"]) {
    const suffix = requireString(suffixes[kind], `activity mark ${kind} suffix at ${pointer}`);
    if (!suffix.startsWith(":") || !suffix.endsWith(":")) {
      throw new Error(`Activity mark ${kind} suffix is not a bounded marker at ${pointer}.`);
    }
  }
  if (suffixes.turn === suffixes.message) throw new Error(`Activity mark target suffixes collide at ${pointer}.`);
}

function assertReconcileCrossFieldContract(contract, pointer, document, ownerSchema) {
  const histogram = requireObject(contract.unresolved_histogram, `unresolved histogram contract at ${pointer}`);
  assertExactKeys(histogram, ["unique_by", "sum_field", "equals"], `unresolved histogram contract at ${pointer}`);
  const uniqueBy = requireFieldName(histogram.unique_by, `unresolved histogram unique_by at ${pointer}`);
  const sumField = requireFieldName(histogram.sum_field, `unresolved histogram sum_field at ${pointer}`);
  const histogramEquals = requireScalarPath(histogram.equals, `unresolved histogram equality at ${pointer}`);
  const histogramRows = resolveSchemaSelector(document, ownerSchema, "unresolved", `${pointer} unresolved histogram rows`);
  requireSelectorPresence(histogramRows, `${pointer} unresolved histogram rows`);
  const histogramEntries = selectArrayItems(document, histogramRows, `${pointer} unresolved histogram rows`);
  assertSelectorTypes(histogramEntries, ["object"], `${pointer} unresolved histogram entries`);
  const histogramKeys = selectSchemaProperty(document, histogramEntries, uniqueBy, `${pointer} unresolved histogram unique_by`);
  requireLocalSelectorPresence(histogramKeys, `${pointer} unresolved histogram unique_by`);
  assertSelectorTypes(histogramKeys, ["string", "number", "integer", "boolean"], `${pointer} unresolved histogram unique_by`);
  const histogramCounts = selectSchemaProperty(document, histogramEntries, sumField, `${pointer} unresolved histogram sum_field`);
  requireLocalSelectorPresence(histogramCounts, `${pointer} unresolved histogram sum_field`);
  assertSelectorTypes(histogramCounts, ["integer"], `${pointer} unresolved histogram sum_field`);
  const histogramTarget = resolveSchemaSelector(document, ownerSchema, histogramEquals, `${pointer} unresolved histogram equality`);
  requireSelectorPresence(histogramTarget, `${pointer} unresolved histogram equality`);
  assertSelectorTypes(histogramTarget, ["integer"], `${pointer} unresolved histogram equality`);

  const examples = requireObject(contract.noncanonical_directory_examples, `noncanonical examples contract at ${pointer}`);
  assertExactKeys(examples, ["field", "accepted_length_contracts"], `noncanonical examples contract at ${pointer}`);
  const examplesField = requireFieldName(examples.field, `noncanonical examples field at ${pointer}`);
  const exampleRows = resolveSchemaSelector(document, ownerSchema, examplesField, `${pointer} noncanonical examples field`);
  requireSelectorPresence(exampleRows, `${pointer} noncanonical examples field`);
  const exampleEntries = selectArrayItems(document, exampleRows, `${pointer} noncanonical examples field`);
  assertSelectorTypes(exampleEntries, ["object"], `${pointer} noncanonical example entries`);
  const directoryNames = selectSchemaProperty(document, exampleEntries, "directory_name", `${pointer} noncanonical directory_name`);
  requireLocalSelectorPresence(directoryNames, `${pointer} noncanonical directory_name`);
  assertSelectorTypes(directoryNames, ["string"], `${pointer} noncanonical directory_name`);
  if (!Array.isArray(examples.accepted_length_contracts) || examples.accepted_length_contracts.length === 0) {
    throw new Error(`Noncanonical examples contract has no accepted generations at ${pointer}.`);
  }
  const generations = new Set();
  for (const [index, rawGeneration] of examples.accepted_length_contracts.entries()) {
    const generation = requireObject(rawGeneration, `noncanonical generation ${String(index)} at ${pointer}`);
    assertExactKeys(
      generation,
      ["generation", "length_equals", "length_equals_min_of", "directory_name_max_length", "record_state_max_length", "string_bound"],
      `noncanonical generation ${String(index)} at ${pointer}`,
    );
    const name = requireString(generation.generation, `noncanonical generation name at ${pointer}`);
    if (generations.has(name)) throw new Error(`Noncanonical generation repeats ${name} at ${pointer}.`);
    generations.add(name);
    const hasExact = typeof generation.length_equals === "string";
    const hasMinimum = Array.isArray(generation.length_equals_min_of)
      && generation.length_equals_min_of.length === 2
      && typeof generation.length_equals_min_of[0] === "string"
      && Number.isSafeInteger(generation.length_equals_min_of[1])
      && generation.length_equals_min_of[1] > 0;
    if (hasExact === hasMinimum) throw new Error(`Noncanonical generation must declare exactly one length law at ${pointer}.`);
    if (hasExact) {
      const path = requireScalarPath(generation.length_equals, `noncanonical generation equality at ${pointer}`);
      const target = resolveSchemaSelector(document, ownerSchema, path, `${pointer} noncanonical generation equality`);
      requireSelectorPresence(target, `${pointer} noncanonical generation equality`);
      assertSelectorTypes(target, ["integer"], `${pointer} noncanonical generation equality`);
    }
    if (hasMinimum) {
      const path = requireScalarPath(generation.length_equals_min_of[0], `noncanonical generation minimum path at ${pointer}`);
      const target = resolveSchemaSelector(document, ownerSchema, path, `${pointer} noncanonical generation minimum path`);
      requireSelectorPresence(target, `${pointer} noncanonical generation minimum path`);
      assertSelectorTypes(target, ["integer"], `${pointer} noncanonical generation minimum path`);
    }
    for (const bound of ["directory_name_max_length", "record_state_max_length"]) {
      if (generation[bound] !== undefined) requirePositiveInteger(generation[bound], `${bound} at ${pointer}`);
    }
    if (generation.string_bound !== undefined && generation.string_bound !== "response_max_bytes_only") {
      throw new Error(`Noncanonical generation has unsupported string bound at ${pointer}.`);
    }
    if (generation.record_state_max_length !== undefined) {
      const recordStates = selectSchemaProperty(document, exampleEntries, "record_state", `${pointer} noncanonical record_state`);
      assertSelectorTypes(recordStates, ["string"], `${pointer} noncanonical record_state`);
    }
  }

  if (!Array.isArray(contract.incomplete_if_any) || contract.incomplete_if_any.length === 0) {
    throw new Error(`Reconcile cross-field contract has no incomplete predicates at ${pointer}.`);
  }
  for (const [index, rawPredicate] of contract.incomplete_if_any.entries()) {
    const predicate = requireObject(rawPredicate, `incomplete predicate ${String(index)} at ${pointer}`);
    assertExactKeys(predicate, ["field", "operator", "value"], `incomplete predicate ${String(index)} at ${pointer}`);
    const field = requireScalarPath(predicate.field, `incomplete predicate field at ${pointer}`);
    if (![[">", "number"], ["==", "string"], ["==", "number"]].some(([operator, type]) => (
      predicate.operator === operator && typeof predicate.value === type
    ))) {
      throw new Error(`Incomplete predicate is unsupported at ${pointer}.`);
    }
    const selected = resolveSchemaSelector(document, ownerSchema, field, `${pointer} incomplete predicate field`);
    requireSelectorPresence(selected, `${pointer} incomplete predicate field`);
    assertSelectorTypes(
      selected,
      typeof predicate.value === "string" ? ["string"] : ["number", "integer"],
      `${pointer} incomplete predicate field`,
    );
  }
}

function assertCrossFieldContract(rawContract, pointer, role, document, ownerSchema) {
  if (role !== "response") throw new Error(`Request schema carries a response cross-field contract at ${pointer}.`);
  const contract = requireObject(rawContract, `cross-field contract at ${pointer}`);
  const keys = Object.keys(contract);
  const allowed = ["activity_mark_authority", "attachment_identity", "unresolved_histogram", "noncanonical_directory_examples", "incomplete_if_any"];
  assertExactKeys(contract, allowed, `cross-field contract at ${pointer}`);
  if (keys.length === 1 && Object.hasOwn(contract, "activity_mark_authority")) {
    assertActivityMarkAuthorityContract(contract.activity_mark_authority, pointer, document, ownerSchema);
    return;
  }
  if (keys.length === 1 && Object.hasOwn(contract, "attachment_identity")) {
    assertAttachmentIdentityContract(contract.attachment_identity, pointer, document, ownerSchema);
    return;
  }
  if (
    keys.length === 3
    && Object.hasOwn(contract, "unresolved_histogram")
    && Object.hasOwn(contract, "noncanonical_directory_examples")
    && Object.hasOwn(contract, "incomplete_if_any")
  ) {
    assertReconcileCrossFieldContract(contract, pointer, document, ownerSchema);
    return;
  }
  throw new Error(`Unsupported cross-field contract shape at ${pointer}.`);
}

function assertSchemaExtensionContracts(document) {
  const visit = (rawSchema, pointer, role) => {
    const schema = requireObject(rawSchema, `extension-bearing schema at ${pointer}`);
    assertOpenOrClosedEnumContract(schema, pointer, role);
    const dictionaryMode = schema["x-calyx-dictionary-mode"];
    const additional = schema.additionalProperties;
    if (dictionaryMode !== undefined) {
      if (dictionaryMode !== "explicit-json-metadata") {
        throw new Error(`Unsupported dictionary mode at ${pointer}.`);
      }
      requireString(schema["x-calyx-dictionary-name"], `dictionary name at ${pointer}`);
      if (additional !== true && !isRecord(additional)) {
        throw new Error(`Explicit dictionary at ${pointer} lacks an additional-properties contract.`);
      }
    }
    if (additional === true || (isRecord(additional) && Object.keys(additional).length === 0)) {
      if (dictionaryMode !== "explicit-json-metadata") {
        throw new Error(`Arbitrary JSON dictionary at ${pointer} lacks explicit-json-metadata mode.`);
      }
    } else if (additional !== undefined && additional !== false && !isRecord(additional)) {
      throw new Error(`Invalid additionalProperties contract at ${pointer}.`);
    }
    if (Object.hasOwn(schema, "x-calyx-unknown-field-policy")) {
      const policy = schema["x-calyx-unknown-field-policy"];
      const roleAllowsPolicy = role === "request" ? policy === "ignore" : policy === "preserve" || policy === "reject";
      if (!UNKNOWN_FIELD_POLICIES.has(policy) || !roleAllowsPolicy) {
        throw new Error(`Unsupported ${role} unknown-field policy at ${pointer}.`);
      }
    }
    if (Object.hasOwn(schema, "x-calyx-cross-field-contract")) {
      assertCrossFieldContract(schema["x-calyx-cross-field-contract"], pointer, role, document, schema);
    }
    const pagination = schema["x-calyx-pagination-contract"];
    if (pagination !== undefined) {
      if (!isRecord(pagination) || typeof pagination.items_field !== "string") {
        throw new Error(`Invalid pagination contract at ${pointer}.`);
      }
      assertExactKeys(
        pagination,
        ["items_field", "count_field", "count_equals", "discriminator_field", "cursor_field"],
        `pagination contract at ${pointer}`,
      );
      const alternatives = Array.isArray(schema.anyOf)
        ? schema.anyOf
        : Array.isArray(schema.oneOf)
          ? schema.oneOf
          : [schema];
      const propertiesByAlternative = alternatives.map((alternative) => (
        isRecord(alternative) && isRecord(alternative.properties) ? alternative.properties : {}
      ));
      const items = propertiesByAlternative.map((properties) => properties[pagination.items_field]);
      if (items.some((item) => !isRecord(item) || item.type !== "array")) {
        throw new Error(`Pagination items field drift at ${pointer}.`);
      }
      if (pagination.count_field !== undefined) {
        const counts = propertiesByAlternative.map((properties) => properties[pagination.count_field]);
        if (counts.some((count) => !isRecord(count) || count.type !== "integer")
          || pagination.count_equals !== `${pagination.items_field}.length`) {
          throw new Error(`Pagination count equality drift at ${pointer}.`);
        }
      }
    }
    if (isRecord(schema.properties)) {
      Object.entries(schema.properties).forEach(([name, child]) => visit(child, `${pointer}/properties/${name}`, role));
    }
    if (isRecord(schema.additionalProperties) && Object.keys(schema.additionalProperties).length > 0) {
      visit(schema.additionalProperties, `${pointer}/additionalProperties`, role);
    }
    if (Array.isArray(schema.items)) {
      schema.items.forEach((child, index) => visit(child, `${pointer}/items/${String(index)}`, role));
    } else if (isRecord(schema.items)) {
      visit(schema.items, `${pointer}/items`, role);
    }
    for (const keyword of ["allOf", "oneOf", "anyOf"]) {
      if (Array.isArray(schema[keyword])) {
        schema[keyword].forEach((child, index) => visit(child, `${pointer}/${keyword}/${String(index)}`, role));
      }
    }
    if (isRecord(schema.not)) visit(schema.not, `${pointer}/not`, role);
  };
  for (const [key, schema] of Object.entries(requireObject(document.components?.schemas, "components.schemas"))) {
    if (!isRecord(schema)) throw new Error(`Component schema ${key} is invalid.`);
    const role = schema["x-calyx-schema-role"];
    if (role !== "request" && role !== "response") throw new Error(`Component schema ${key} has no valid schema role.`);
    visit(schema, `#/components/schemas/${key}`, role);
  }
  for (const { path, method, operation } of operationEntries(document)) {
    const pointer = `#/paths/${path}/${method.toLowerCase()}`;
    const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
    for (const [index, parameter] of parameters.entries()) {
      if (isRecord(parameter) && isRecord(parameter.schema)) {
        visit(parameter.schema, `${pointer}/parameters/${String(index)}/schema`, "request");
      }
    }
    const requestBody = isRecord(operation.requestBody) ? operation.requestBody : undefined;
    const requestContent = requestBody && isRecord(requestBody.content) ? requestBody.content : {};
    for (const [mediaType, media] of Object.entries(requestContent)) {
      if (isRecord(media) && isRecord(media.schema)) {
        visit(media.schema, `${pointer}/requestBody/content/${mediaType}/schema`, "request");
      }
    }
    for (const [status, response] of Object.entries(isRecord(operation.responses) ? operation.responses : {})) {
      if (!isRecord(response)) continue;
      for (const [name, header] of Object.entries(isRecord(response.headers) ? response.headers : {})) {
        if (isRecord(header) && isRecord(header.schema)) {
          visit(header.schema, `${pointer}/responses/${status}/headers/${name}/schema`, "response");
        }
      }
      for (const [mediaType, media] of Object.entries(isRecord(response.content) ? response.content : {})) {
        if (!isRecord(media)) continue;
        if (isRecord(media.schema)) {
          visit(media.schema, `${pointer}/responses/${status}/content/${mediaType}/schema`, "response");
        }
        if (isRecord(media["x-calyx-sse-event-schema"])) {
          visit(
            media["x-calyx-sse-event-schema"],
            `${pointer}/responses/${status}/content/${mediaType}/x-calyx-sse-event-schema`,
            "response",
          );
        }
      }
    }
  }
}

function responseForStatus(operation, status) {
  return requireObject(requireObject(operation.responses, "responses")[String(status)], `response ${status}`);
}

function assertEffectSet(rawEffects, label) {
  const effects = requireObject(rawEffects, label);
  assertExactKeys(
    effects,
    ["local_files", "local_state", "remote_tracker", "remote_provider", "process_launch", "creates_worktree", "dispatches_run", "dry_run_default", "notes"],
    label,
  );
  for (const field of ["local_files", "local_state", "remote_tracker", "remote_provider"]) {
    if (!EFFECT_LEVELS.has(effects[field])) throw new Error(`${label} has unsupported ${field} level.`);
  }
  for (const field of ["process_launch", "creates_worktree", "dispatches_run", "dry_run_default"]) {
    if (typeof effects[field] !== "boolean") throw new Error(`${label} has non-boolean ${field}.`);
  }
  if (effects.notes !== undefined) requireString(effects.notes, `${label} notes`);
  return effects;
}

function assertEffectCondition(rawCondition, label) {
  const condition = requireObject(rawCondition, label);
  assertExactKeys(condition, ["request_accept", "outcome"], label);
  if (condition.request_accept !== undefined) requireString(condition.request_accept, `${label} request_accept`);
  if (condition.outcome !== undefined) requireString(condition.outcome, `${label} outcome`);
  if (condition.request_accept === undefined && condition.outcome === undefined) throw new Error(`${label} is empty.`);
  return condition;
}

function assertReceiverEffects(rawEffects, label) {
  const receiver = requireObject(rawEffects, label);
  if (receiver.kind === "uniform") {
    assertExactKeys(receiver, ["kind", "effects"], label);
    assertEffectSet(receiver.effects, `${label} effects`);
    return receiver;
  }
  if (receiver.kind !== "by_success") throw new Error(`${label} has unsupported effect selection kind.`);
  assertExactKeys(receiver, ["kind", "branches"], label);
  if (!Array.isArray(receiver.branches) || receiver.branches.length === 0) throw new Error(`${label} has no success branches.`);
  const statuses = new Set();
  for (const [index, rawBranch] of receiver.branches.entries()) {
    const branch = requireObject(rawBranch, `${label} branch ${String(index)}`);
    assertExactKeys(branch, ["status", "condition", "effects"], `${label} branch ${String(index)}`);
    if (![200, 202].includes(branch.status) || statuses.has(branch.status)) {
      throw new Error(`${label} has an unsupported or duplicate success status.`);
    }
    statuses.add(branch.status);
    if (branch.condition !== undefined) assertEffectCondition(branch.condition, `${label} branch ${String(index)} condition`);
    assertEffectSet(branch.effects, `${label} branch ${String(index)} effects`);
  }
  return receiver;
}

function assertOperationMetadata(entry) {
  const { operation } = entry;
  const operationId = operation.operationId;
  requireString(operation["x-calyx-capability"], `${operationId} capability`);
  requireString(operation["x-calyx-domain"], `${operationId} domain`);
  const receiver = assertReceiverEffects(operation["x-calyx-effects"], `${operationId} receiver effects`);
  const successContracts = operation["x-calyx-success-contracts"];
  if (!Array.isArray(successContracts) || successContracts.length === 0) {
    throw new Error(`Operation ${operationId} has no x-calyx-success-contracts.`);
  }
  const expectedBranches = successContracts.map((rawContract, index) => {
    const contract = requireObject(rawContract, `${operationId} success contract ${String(index)}`);
    if (![200, 202].includes(contract.status)) throw new Error(`Operation ${operationId} has unsupported success status.`);
    const condition = contract.condition === undefined
      ? undefined
      : assertEffectCondition(contract.condition, `${operationId} success condition ${String(index)}`);
    return { status: contract.status, condition };
  });
  if (new Set(expectedBranches.map((branch) => branch.status)).size !== expectedBranches.length) {
    throw new Error(`Operation ${operationId} repeats a success status.`);
  }
  if (receiver.kind === "uniform") {
    for (const branch of expectedBranches) {
      const response = responseForStatus(operation, branch.status);
      if (JSON.stringify(response["x-calyx-effects"]) !== JSON.stringify(receiver.effects)) {
        throw new Error(`Operation ${operationId} uniform effects drift for status ${String(branch.status)}.`);
      }
    }
    return;
  }
  if (receiver.branches.length !== expectedBranches.length) {
    throw new Error(`Operation ${operationId} effect branches do not cover every success.`);
  }
  for (const expected of expectedBranches) {
    const branch = receiver.branches.find((candidate) => candidate.status === expected.status);
    if (!branch || JSON.stringify(branch.condition ?? null) !== JSON.stringify(expected.condition ?? null)) {
      throw new Error(`Operation ${operationId} effect branch condition drift for status ${String(expected.status)}.`);
    }
    const response = responseForStatus(operation, expected.status);
    if (JSON.stringify(response["x-calyx-effects"]) !== JSON.stringify(branch.effects)) {
      throw new Error(`Operation ${operationId} branch effects drift for status ${String(expected.status)}.`);
    }
  }
}

function schemaReferenceForSuccess(response, contract) {
  if (contract.representation === "head") return { $ref: "#/components/schemas/_head_metadata" };
  const content = requireObject(response.content, "success response content");
  const mediaType = contract.media_type === "dynamic" ? "*/*" : contract.media_type;
  const media = requireObject(content[mediaType], `success media ${String(mediaType)}`);
  if (contract.representation === "sse") {
    return requireObject(media["x-calyx-sse-event-schema"], "x-calyx-sse-event-schema");
  }
  const schema = requireObject(media.schema, "success response schema");
  if (contract.representation === "bytes") {
    assertExactKeys(schema, ["format", "type"], "binary success response schema");
    if (schema.type !== "string" || schema.format !== "binary") {
      throw new Error("Binary success response must use the exact string/binary media schema.");
    }
  }
  return schema;
}

function assertSseCursorContract(media, document, eventSchema, label) {
  const cursorField = media["x-calyx-sse-cursor-field"];
  if (cursorField !== "cursor") throw new Error(`${label} SSE cursor field must be exactly cursor.`);
  const cursor = resolveSchemaSelector(document, eventSchema, cursorField, `${label} SSE cursor field`);
  requireSelectorPresence(cursor, `${label} SSE cursor field`);
  assertSelectorTypes(cursor, ["string"], `${label} SSE cursor field`);
  for (const state of cursor) {
    const minimum = Math.max(0, ...state.variant.map((schema) => schema.minLength).filter(Number.isSafeInteger));
    if (minimum < 1) throw new Error(`${label} SSE cursor field is not a nonempty string across every schema branch.`);
  }
  return cursorField;
}

function assertSseReplaySubset(document, eventSchema, cursorField, replaySchema, label) {
  const cursor = resolveSchemaSelector(document, eventSchema, cursorField, `${label} SSE cursor field`);
  requireSelectorPresence(cursor, `${label} SSE cursor field`);
  assertSelectorTypes(cursor, ["string"], `${label} SSE cursor field`);
  const replayMinimum = replaySchema.minLength;
  const replayMaximum = replaySchema.maxLength;
  const replayPattern = replaySchema.pattern;
  for (const state of cursor) {
    if (state.variant.some((schema) => schema.nullable === true)) {
      throw new Error(`${label} SSE cursor field must not be nullable across any schema branch.`);
    }
    const minimum = Math.max(0, ...state.variant.map((schema) => schema.minLength).filter(Number.isSafeInteger));
    const maximums = state.variant.map((schema) => schema.maxLength).filter(Number.isSafeInteger);
    if (minimum < replayMinimum || maximums.length === 0 || Math.min(...maximums) > replayMaximum) {
      throw new Error(`${label} SSE cursor schema is not a subset of its Last-Event-ID length contract.`);
    }
    if (
      typeof replayPattern === "string"
      && !state.variant.some((schema) => schema.pattern === replayPattern)
    ) {
      throw new Error(`${label} SSE cursor schema is not a proven subset of its Last-Event-ID pattern contract.`);
    }
  }
  return {
    cursorMaxLength: replayMaximum,
    ...(typeof replayPattern === "string" ? { cursorPattern: replayPattern } : {}),
  };
}

function normalizedHeaderContracts(response, contract, label) {
  const responseHeaders = isRecord(response.headers) ? response.headers : {};
  const responseByName = new Map();
  for (const [rawName, rawHeader] of Object.entries(responseHeaders)) {
    if (!HTTP_FIELD_NAME_PATTERN.test(rawName)) throw new Error(`${label} uses non-representable response header name ${rawName}.`);
    const name = rawName.toLowerCase();
    if (responseByName.has(name)) throw new Error(`${label} repeats response header ${name}.`);
    const header = requireObject(rawHeader, `${label} response header ${name}`);
    if (typeof header.required !== "boolean" || !isRecord(header.schema)) {
      throw new Error(`${label} response header ${name} lacks required/schema metadata.`);
    }
    assertOpenOrClosedEnumContract(header.schema, `${label} response header ${name}`, "response");
    responseByName.set(name, { required: header.required, schema: header.schema });
  }
  const contractHeaders = contract.headers ?? [];
  if (!Array.isArray(contractHeaders)) throw new Error(`${label} success headers must be an array.`);
  const contractByName = new Map();
  for (const [index, rawHeader] of contractHeaders.entries()) {
    const header = requireObject(rawHeader, `${label} success header ${String(index)}`);
    assertExactKeys(header, ["name", "schema", "required"], `${label} success header ${String(index)}`);
    const rawName = requireString(header.name, `${label} success header name`);
    if (!HTTP_FIELD_NAME_PATTERN.test(rawName)) throw new Error(`${label} uses non-representable success header name ${rawName}.`);
    const name = rawName.toLowerCase();
    if (contractByName.has(name)) throw new Error(`${label} repeats success header ${name}.`);
    if (typeof header.required !== "boolean" || !isRecord(header.schema)) {
      throw new Error(`${label} success header ${name} lacks required/schema metadata.`);
    }
    assertOpenOrClosedEnumContract(header.schema, `${label} success header ${name}`, "response");
    contractByName.set(name, { required: header.required, schema: header.schema });
  }
  const responseContractNames = [...responseByName.keys()].filter((name) => name !== "x-calyx-request-id").sort(compareUtf8);
  const declaredContractNames = [...contractByName.keys()].sort(compareUtf8);
  if (JSON.stringify(responseContractNames) !== JSON.stringify(declaredContractNames)) {
    throw new Error(`${label} response/success header membership drifted.`);
  }
  for (const name of declaredContractNames) {
    if (JSON.stringify(responseByName.get(name)) !== JSON.stringify(contractByName.get(name))) {
      throw new Error(`${label} response/success header ${name} drifted.`);
    }
  }
  const requestId = responseByName.get("x-calyx-request-id");
  if (!requestId?.required) throw new Error(`${label} omits required X-Calyx-Request-Id metadata.`);
  const headerSchemas = sortedObject(Object.fromEntries(
    [...responseByName.entries()].map(([name, header]) => [name, header.schema]),
  ));
  const requiredHeaders = [...responseByName.entries()]
    .filter(([, header]) => header.required)
    .map(([name]) => name)
    .sort(compareUtf8);
  return {
    requiredHeaders,
    headerSchemas,
  };
}

function assertErrorResponseContract(response, rawCodes, label) {
  const codes = [...rawCodes].sort(compareUtf8);
  if (codes.length === 0 || codes.some((code) => typeof code !== "string" || code.length === 0)) {
    throw new Error(`${label} error-code authority must contain non-empty strings.`);
  }
  const content = requireObject(response.content, `${label} error content`);
  assertExactKeys(content, ["application/json"], `${label} error content`);
  const media = requireObject(content["application/json"], `${label} application/json error media`);
  assertExactKeys(media, MEDIA_KEYS, `${label} application/json error media`);
  const schema = requireObject(media.schema, `${label} error schema`);
  if (!Array.isArray(schema.allOf) || schema.allOf.length !== 2) {
    throw new Error(`${label} must compile as the closed calyx.error/v1 envelope refinement.`);
  }
  const base = requireObject(schema.allOf[0], `${label} error base schema`);
  if (Object.keys(base).length !== 1 || base.$ref !== "#/components/schemas/calyx_error_v1") {
    throw new Error(`${label} must extend the canonical calyx.error/v1 schema.`);
  }
  const refinement = requireObject(schema.allOf[1], `${label} error refinement`);
  const error = requireObject(
    requireObject(refinement.properties, `${label} error refinement properties`).error,
    `${label} error refinement error`,
  );
  const code = requireObject(
    requireObject(error.properties, `${label} error properties`).code,
    `${label} error code schema`,
  );
  if (
    code.type !== "string"
    || code["x-calyx-enum-mode"] !== "open"
    || JSON.stringify([...(code.enum ?? [])].sort(compareUtf8)) !== JSON.stringify(codes)
    || JSON.stringify([...(code["x-calyx-known-values"] ?? [])].sort(compareUtf8)) !== JSON.stringify(codes)
  ) {
    throw new Error(`${label} error schema does not match its open x-calyx-error-codes authority.`);
  }
  return schema;
}

function assertCustodyContract(rawCustody, label, representation, path) {
  const custody = requireObject(rawCustody, `${label} custody contract`);
  assertExactKeys(custody, ["schema_version", "kind", "requested_ref", "bindings"], `${label} custody contract`);
  if (custody.schema_version !== "calyx.attachment-custody/v1" || custody.kind !== "content_addressed_attachment") {
    throw new Error(`${label} has an unsupported custody contract family.`);
  }
  const requestedRef = requireObject(custody.requested_ref, `${label} requested custody ref`);
  assertExactKeys(requestedRef, ["in", "name"], `${label} requested custody ref`);
  const requestedName = requireString(requestedRef.name, `${label} requested custody ref name`);
  if (requestedRef.in !== "path" || !path.includes(`{${requestedName}}`)) {
    throw new Error(`${label} custody ref is not bound to a generated path parameter.`);
  }
  if (!Array.isArray(custody.bindings)) throw new Error(`${label} custody contract bindings must be an array.`);
  const bindings = [];
  for (const [index, rawBinding] of custody.bindings.entries()) {
    const binding = requireObject(rawBinding, `${label} custody binding ${String(index)}`);
    assertExactKeys(binding, ["source", "target", "relation"], `${label} custody binding ${String(index)}`);
    const source = requireString(binding.source, `${label} custody binding source`);
    const target = requireString(binding.target, `${label} custody binding target`);
    if (!["equals", "sha256_etag", "sha256_base64"].includes(binding.relation)) {
      throw new Error(`${label} custody binding has unsupported relation.`);
    }
    bindings.push({ source, target, relation: binding.relation });
  }
  const expectedBindings = [
    { source: "request.path.ref", target: "response.header.x-calyx-attachment-ref", relation: "equals" },
    { source: "response.header.x-calyx-attachment-ref", target: "response.header.etag", relation: "sha256_etag" },
    { source: "response.header.x-calyx-attachment-ref", target: "response.header.digest", relation: "sha256_base64" },
    ...(representation === "bytes"
      ? [{ source: "response.body", target: "response.header.digest", relation: "sha256_base64" }]
      : []),
  ];
  if (JSON.stringify(bindings) !== JSON.stringify(expectedBindings)) {
    throw new Error(`${label} custody bindings do not exactly match the generated response-self checks.`);
  }
  return {
    schema_version: custody.schema_version,
    kind: custody.kind,
    requested_ref: { in: requestedRef.in, name: requestedName },
    bindings: expectedBindings,
  };
}

function assertRetryAuthority(rawAuthority, label, method, transport, successes, document, requestSchema) {
  const retryableSemantics = successes.some((success) => (
    success.semantics.mutation === "idempotent_write" || success.semantics.mutation === "submit"
  ));
  if (rawAuthority === undefined) {
    if (retryableSemantics) {
      throw new Error(`${label} declares retryable mutation semantics without retry authority.`);
    }
    return undefined;
  }
  const authority = requireObject(rawAuthority, `${label} retry authority`);
  if (authority.kind === "operation_identity") {
    assertExactKeys(authority, ["kind"], `${label} retry authority`);
    if (method !== "POST" || transport.body !== "none") {
      throw new Error(`${label} operation-identity retry authority requires a bodyless POST request.`);
    }
    if (successes.some((success) => success.semantics.mutation !== "idempotent_write")) {
      throw new Error(`${label} operation-identity retry authority requires idempotent-write semantics.`);
    }
    if (successes.some((success) => success.representation !== "json")) {
      throw new Error(`${label} operation-identity retry authority requires finite JSON success representations.`);
    }
    return { kind: authority.kind };
  }
  if (authority.kind === "request_target_identity") {
    assertExactKeys(authority, ["kind"], `${label} retry authority`);
    if (method !== "DELETE" || transport.body !== "none") {
      throw new Error(`${label} request-target retry authority requires a bodyless DELETE request.`);
    }
    if (successes.some((success) => success.semantics.mutation !== "idempotent_write")) {
      throw new Error(`${label} request-target retry authority requires idempotent-write semantics.`);
    }
    if (successes.some((success) => success.representation !== "json")) {
      throw new Error(`${label} request-target retry authority requires finite JSON success representations.`);
    }
    return { kind: authority.kind };
  }
  if (transport.body !== "json") throw new Error(`${label} retry authority requires a JSON request body.`);
  if (successes.some((success) => !["idempotent_write", "submit"].includes(success.semantics.mutation))) {
    throw new Error(`${label} retry authority contradicts its mutation semantics.`);
  }
  assertExactKeys(authority, ["kind", "field"], `${label} retry authority`);
  if (authority.kind !== "request_body_field") {
    throw new Error(`${label} retry authority has unsupported kind.`);
  }
  const field = requireFieldName(authority.field, `${label} retry authority field`);
  const selected = resolveSchemaSelector(document, requestSchema, field, `${label} retry authority field`);
  requireSelectorPresence(selected, `${label} retry authority field`);
  assertSelectorTypes(selected, ["string"], `${label} retry authority field`);
  for (const state of selected) {
    if (state.variant.some((schema) => schema.nullable === true)) {
      throw new Error(`${label} retry authority field must not be nullable across any schema branch.`);
    }
    const minimum = Math.max(0, ...state.variant.map((schema) => schema.minLength).filter(Number.isSafeInteger));
    const maximums = state.variant.map((schema) => schema.maxLength).filter(Number.isSafeInteger);
    if (minimum < 1 || maximums.length === 0 || Math.min(...maximums) < minimum) {
      throw new Error(`${label} retry authority field is not a bounded nonempty string across every schema branch.`);
    }
  }
  return { kind: authority.kind, field };
}

function resolveHeaderSchema(document, rawSchema, label, active = new Set()) {
  const schema = requireObject(rawSchema, `${label} schema`);
  if (schema.$ref === undefined) return schema;
  if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/components/schemas/")) {
    throw new Error(`${label} uses an unsupported response-header schema reference.`);
  }
  if (Object.keys(schema).some((key) => key !== "$ref")) {
    throw new Error(`${label} mixes a response-header schema reference with sibling constraints.`);
  }
  if (active.has(schema.$ref)) throw new Error(`${label} has a cyclic response-header schema reference.`);
  const key = schema.$ref.slice("#/components/schemas/".length);
  const resolved = document.components?.schemas?.[key];
  if (!resolved) throw new Error(`${label} has an unresolved response-header schema reference.`);
  active.add(schema.$ref);
  try {
    return resolveHeaderSchema(document, resolved, label, active);
  } finally {
    active.delete(schema.$ref);
  }
}

function assertResponseHeaderWireSchema(document, rawSchema, label) {
  const schema = resolveHeaderSchema(document, rawSchema, label);
  if (schema.nullable === true || ["allOf", "oneOf", "anyOf", "not"].some((key) => schema[key] !== undefined)) {
    throw new Error(`${label} exceeds the generated response-header wire grammar.`);
  }
  if (schema.type !== "string" && schema.type !== "integer") {
    throw new Error(`${label} must use the generated string or non-negative-integer response-header wire grammar.`);
  }
  const values = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (schema.type === "string") {
    if (Object.hasOwn(schema, "const") && typeof schema.const !== "string") {
      throw new Error(`${label} string literal has a non-string value.`);
    }
    if (values && values.some((value) => typeof value !== "string")) {
      throw new Error(`${label} string enum has a non-string value.`);
    }
    if (
      !Number.isSafeInteger(schema.minLength)
      || schema.minLength < 1
      || !Number.isSafeInteger(schema.maxLength)
      || schema.maxLength < schema.minLength
      || schema.maxLength > FETCH_RESPONSE_HEADER_VALUE_MAX_LENGTH
      || !isProvenPatternIntersection(
        schema.pattern,
        FETCH_RESPONSE_HEADER_VALUE_PATTERN_SOURCE,
      )
    ) {
      throw new Error(`${label} string schema is not a proven subset of the canonical Fetch response-header value envelope.`);
    }
    const representable = (value) => (
      typeof value === "string"
      && value.length <= FETCH_RESPONSE_HEADER_VALUE_MAX_LENGTH
      && FETCH_RESPONSE_HEADER_VALUE_PATTERN.test(value)
    );
    if (Object.hasOwn(schema, "const") && !representable(schema.const)) {
      throw new Error(`${label} string literal is outside the canonical Fetch response-header value envelope.`);
    }
    if (values && values.some((value) => !representable(value))) {
      throw new Error(`${label} string enum contains a value outside the canonical Fetch response-header value envelope.`);
    }
    return;
  }
  if (!Number.isSafeInteger(schema.minimum) || schema.minimum < 0) {
    throw new Error(`${label} integer schema must have a non-negative safe-integer minimum.`);
  }
  if (
    !Number.isSafeInteger(schema.maximum)
    || schema.maximum < schema.minimum
    || schema.maximum > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(`${label} integer schema must have a finite safe-integer maximum.`);
  }
  if (
    Object.hasOwn(schema, "const")
    && (
      !Number.isSafeInteger(schema.const)
      || schema.const < schema.minimum
      || schema.const > schema.maximum
    )
  ) {
    throw new Error(`${label} integer literal is not a non-negative safe integer.`);
  }
  if (values && values.some((value) => (
    !Number.isSafeInteger(value)
    || value < schema.minimum
    || value > schema.maximum
  ))) {
    throw new Error(`${label} integer enum contains a value outside the generated wire grammar.`);
  }
}

function isWellFormedUnicodeScalarText(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isRepresentablePathSegment(value) {
  return typeof value === "string"
    && value.length > 0
    && value !== "."
    && value !== ".."
    && isWellFormedUnicodeScalarText(value);
}

function assertPathParameterSchema(rawSchema, operationId, parameterName) {
  const schema = requireObject(rawSchema, `Operation ${operationId} path parameter ${parameterName} schema`);
  if (schema.type !== "string" || schema.nullable === true) {
    throw new Error(`Operation ${operationId} path parameter ${parameterName} must use an inline string schema that is non-null.`);
  }
  if (Object.keys(schema).some((key) => !PATH_PARAMETER_SCHEMA_KEYS.has(key))) {
    throw new Error(`Operation ${operationId} path parameter ${parameterName} exceeds the inline scalar grammar.`);
  }
  if (Object.hasOwn(schema, "const") && typeof schema.const !== "string") {
    throw new Error(`Operation ${operationId} path parameter ${parameterName} has a non-string literal.`);
  }
  if (Array.isArray(schema.enum) && schema.enum.some((value) => typeof value !== "string")) {
    throw new Error(`Operation ${operationId} path parameter ${parameterName} has a non-string enum member.`);
  }
  if (
    !Number.isSafeInteger(schema.minLength)
    || schema.minLength < 1
    || !Number.isSafeInteger(schema.maxLength)
    || schema.maxLength < schema.minLength
    || schema.maxLength > REPRESENTABLE_PATH_SEGMENT_MAX_LENGTH
    || !isProvenPatternIntersection(
      schema.pattern,
      REPRESENTABLE_PATH_SEGMENT_PATTERN_SOURCE,
    )
  ) {
    throw new Error(`Operation ${operationId} path parameter ${parameterName} is not a proven subset of the executable one-segment envelope.`);
  }
  if (Object.hasOwn(schema, "const") && !isRepresentablePathSegment(schema.const)) {
    throw new Error(`Operation ${operationId} path parameter ${parameterName} has a non-representable literal.`);
  }
  if (Array.isArray(schema.enum) && schema.enum.some((value) => !isRepresentablePathSegment(value))) {
    throw new Error(`Operation ${operationId} path parameter ${parameterName} has a non-representable enum member.`);
  }
}

function boundedSuccessMetadata(response, contract, label, representation) {
  const maxBytes = contract.max_bytes;
  const maxFrameBytes = contract.max_frame_bytes;
  if (representation === "sse") {
    requirePositiveInteger(maxFrameBytes, `${label} max_frame_bytes`);
    if (
      maxBytes !== undefined
      || response["x-calyx-max-bytes"] !== undefined
      || response["x-calyx-max-frame-bytes"] !== maxFrameBytes
    ) {
      throw new Error(`${label} SSE response bound drifted.`);
    }
    const media = requireObject(requireObject(response.content, `${label} response content`)[contract.media_type], `${label} response media`);
    if (media["x-calyx-max-frame-bytes"] !== maxFrameBytes) throw new Error(`${label} SSE media frame bound drifted.`);
    return { maxFrameBytes };
  }
  requirePositiveInteger(maxBytes, `${label} max_bytes`);
  if (
    maxFrameBytes !== undefined
    || response["x-calyx-max-frame-bytes"] !== undefined
    || response["x-calyx-max-bytes"] !== maxBytes
  ) {
    throw new Error(`${label} finite response bound drifted.`);
  }
  return { maxBytes };
}

function assertExactlyEmptyBodylessRequestSchema(schema, operationId) {
  const annotationKeys = new Set([
    "deprecated",
    "description",
    "example",
    "examples",
    "title",
    "x-calyx-schema-id",
    "x-calyx-schema-role",
    "x-calyx-unknown-field-policy",
  ]);
  const semanticKeys = Object.keys(schema)
    .filter((key) => !annotationKeys.has(key))
    .sort(compareUtf8);
  if (
    schema.type !== "object"
    || !isRecord(schema.properties)
    || Object.keys(schema.properties).length !== 0
    || JSON.stringify(semanticKeys) !== JSON.stringify(["properties", "type"])
  ) {
    throw new Error(`Operation ${operationId} bodyless transport requires an exactly empty request schema.`);
  }
}

function operationPlan(entry, index, document) {
  const { method, path, operation } = entry;
  const operationId = operation.operationId;
  const requestTargetMaxBytes = document["x-calyx-request-target-max-bytes"];
  if (!["GET", "HEAD", "POST", "DELETE"].includes(method)) {
    throw new Error(`Operation ${operationId} uses unsupported HTTP method ${method}.`);
  }
  const requestSchemaId = requireString(operation["x-calyx-request-schema"], `${operationId} request schema`);
  const requestSchema = index.get(`request:${requestSchemaId}`);
  if (!requestSchema) throw new Error(`Operation ${operationId} request schema is unresolved.`);
  const responseSchemaId = requireString(operation["x-calyx-response-schema"], `${operationId} response schema`);
  if (!index.has(`response:${responseSchemaId}`)) throw new Error(`Operation ${operationId} response schema is unresolved.`);
  if (!["filesystem_authoritative", "runtime_process", "sqlite_authoritative"].includes(operation["x-calyx-store-regime"])) {
    throw new Error(`Operation ${operationId} has an unsupported store regime.`);
  }
  const transport = requireObject(operation["x-calyx-request-transport"], `${operationId} request transport`);
  if (transport.body !== "none" && transport.body !== "json") {
    throw new Error(`Operation ${operationId} has unsupported request transport.`);
  }
  const successContracts = operation["x-calyx-success-contracts"];
  if (!Array.isArray(successContracts) || successContracts.length === 0) {
    throw new Error(`Operation ${operationId} has no x-calyx-success-contracts.`);
  }
  const success = successContracts.map((rawContract) => {
    const contract = requireObject(rawContract, `${operationId} success contract`);
    assertExactKeys(
      contract,
      ["condition", "custody", "headers", "max_bytes", "max_frame_bytes", "media_type", "representation", "request_schema", "schema", "semantics", "status"],
      `${operationId} success contract`,
    );
    const contractSchemaId = requireString(contract.schema, `${operationId} success schema`);
    const contractSchema = index.get(`response:${contractSchemaId}`);
    if (!contractSchema) throw new Error(`Operation ${operationId} success schema ${contractSchemaId} is unresolved.`);
    if (!["json", "sse", "bytes", "head"].includes(contract.representation)) {
      throw new Error(`Operation ${operationId} has unsupported success representation.`);
    }
    const response = responseForStatus(operation, contract.status);
    const responseSemantics = response["x-calyx-semantics"];
    if (JSON.stringify(responseSemantics) !== JSON.stringify(contract.semantics)) {
      throw new Error(`Operation ${operationId} success semantics drift between contract and response.`);
    }
    if (JSON.stringify(response["x-calyx-condition"] ?? null) !== JSON.stringify(contract.condition ?? null)) {
      throw new Error(`Operation ${operationId} success condition drift.`);
    }
    const { requiredHeaders, headerSchemas } = normalizedHeaderContracts(
      response,
      contract,
      `${operationId} status ${String(contract.status)}`,
    );
    const schema = schemaReferenceForSuccess(response, contract);
    if ((contract.representation === "json" || contract.representation === "sse")
      && schema.$ref !== contractSchema.ref.$ref) {
      throw new Error(`Operation ${operationId} success schema drift for status ${String(contract.status)}.`);
    }
    if (contract.request_schema !== undefined && contract.request_schema !== requestSchemaId) {
      throw new Error(`Operation ${operationId} success request schema drift for status ${String(contract.status)}.`);
    }
    if (JSON.stringify(response["x-calyx-request-schema"] ?? null) !== JSON.stringify(contract.request_schema ?? null)) {
      throw new Error(`Operation ${operationId} response request schema drift for status ${String(contract.status)}.`);
    }
    const bounds = boundedSuccessMetadata(
      response,
      contract,
      `${operationId} status ${String(contract.status)}`,
      contract.representation,
    );
    const cursorField = contract.representation === "sse"
      ? assertSseCursorContract(
          requireObject(
            requireObject(response.content, `${operationId} SSE response content`)[contract.media_type],
            `${operationId} SSE response media`,
          ),
          document,
          contractSchema.schema,
          `${operationId} status ${String(contract.status)}`,
        )
      : undefined;
    const responseCustody = response["x-calyx-custody-contract"];
    if (JSON.stringify(responseCustody ?? null) !== JSON.stringify(contract.custody ?? null)) {
      throw new Error(`Operation ${operationId} success custody drift for status ${String(contract.status)}.`);
    }
    if (contract.custody !== undefined && contract.representation !== "bytes" && contract.representation !== "head") {
      throw new Error(`Operation ${operationId} attaches custody to a non-binary success.`);
    }
    const custodyContract = contract.custody === undefined
      ? undefined
      : assertCustodyContract(
          contract.custody,
          `${operationId} status ${String(contract.status)}`,
          contract.representation,
          path,
        );
    return {
      status: contract.status,
      representation: contract.representation,
      mediaType: contract.media_type,
      schema,
      requiredHeaders,
      headerSchemas,
      ...bounds,
      ...(cursorField ? { cursorField } : {}),
      ...(custodyContract ? { custodyContract } : {}),
      ...(contract.condition ? { condition: contract.condition } : {}),
      semantics: contract.semantics,
    };
  });
  if (new Set(success.map((contract) => contract.status)).size !== success.length) {
    throw new Error(`Operation ${operationId} repeats a success status.`);
  }
  const retryAuthority = assertRetryAuthority(
    operation["x-calyx-retry-authority"],
    operationId,
    method,
    transport,
    success,
    document,
    requestSchema.schema,
  );
  if (method === "DELETE" && retryAuthority?.kind !== "request_target_identity") {
    throw new Error(`Operation ${operationId} generated DELETE transport requires request-target retry authority.`);
  }
  const errorCodes = {};
  const errorSchemas = {};
  const errorRequiredHeaders = {};
  const errorRequiredHeaderSchemas = {};
  const responses = requireObject(operation.responses, `${operationId} responses`);
  const requestIdSchemas = Object.entries(responses).map(([status, rawResponse]) => {
    const response = requireObject(rawResponse, `${operationId} response ${status}`);
    const headers = requireObject(response.headers ?? {}, `${operationId} response ${status} headers`);
    const requestIdEntry = Object.entries(headers).find(([name]) => name.toLowerCase() === "x-calyx-request-id");
    if (!requestIdEntry) {
      throw new Error(`Operation ${operationId} response ${status} omits X-Calyx-Request-Id authority.`);
    }
    const header = requireObject(requestIdEntry[1], `${operationId} response ${status} X-Calyx-Request-Id`);
    if (header.required !== true) {
      throw new Error(`Operation ${operationId} response ${status} must require X-Calyx-Request-Id.`);
    }
    return header.schema;
  });
  const requestIdHeaderSchema = requestIdSchemas[0];
  if (
    !isRecord(requestIdHeaderSchema)
    || requestIdSchemas.some((schema) => JSON.stringify(schema) !== JSON.stringify(requestIdHeaderSchema))
  ) {
    throw new Error(`Operation ${operationId} response X-Calyx-Request-Id schemas drift across statuses.`);
  }
  const successStatuses = new Set(success.map((contract) => String(contract.status)));
  for (const [status, response] of Object.entries(responses)) {
    if (successStatuses.has(status)) continue;
    if (!isRecord(response) || !Array.isArray(response["x-calyx-error-codes"])) {
      throw new Error(`Operation ${operationId} non-success response ${status} lacks x-calyx-error-codes authority.`);
    }
    errorSchemas[status] = assertErrorResponseContract(
      response,
      response["x-calyx-error-codes"],
      `Operation ${operationId} response ${status}`,
    );
    errorCodes[status] = [...response["x-calyx-error-codes"]].sort(compareUtf8);
    const headers = isRecord(response.headers) ? response.headers : {};
    const headerEntries = Object.entries(headers)
      .map(([name, header]) => [name.toLowerCase(), requireObject(header, `${operationId} error header ${name}`).schema]);
    const requiredHeaderEntries = Object.entries(headers)
      .filter(([, header]) => isRecord(header) && header.required === true)
      .map(([name, header]) => [name.toLowerCase(), header.schema]);
    errorRequiredHeaders[status] = requiredHeaderEntries
      .map(([name]) => name)
      .filter((name) => name !== "x-calyx-request-id")
      .sort(compareUtf8);
    errorRequiredHeaderSchemas[status] = sortedObject(Object.fromEntries(headerEntries));
  }
  const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
  const parameterKeys = new Set();
  for (const parameter of parameters) {
    if (!isRecord(parameter) || typeof parameter.name !== "string" || typeof parameter.in !== "string") {
      throw new Error(`Operation ${operationId} has an invalid parameter contract.`);
    }
    const key = `${parameter.in}:${parameter.name.toLowerCase()}`;
    if (parameterKeys.has(key)) throw new Error(`Operation ${operationId} repeats parameter ${key}.`);
    parameterKeys.add(key);
    if (!isRecord(parameter.schema)) throw new Error(`Operation ${operationId} parameter ${key} lacks a schema.`);
    if (parameter.in === "path") assertPathParameterSchema(parameter.schema, operationId, parameter.name);
    if (parameter.in === "header" && !["last-event-id", "x-calyx-asserted-actor"].includes(parameter.name.toLowerCase())) {
      throw new Error(`Operation ${operationId} exposes unsupported generated header ${parameter.name}.`);
    }
    if (!["path", "query", "header"].includes(parameter.in)) {
      throw new Error(`Operation ${operationId} exposes unsupported ${parameter.in} parameter ${parameter.name}.`);
    }
  }
  const pathParameters = parameters.filter((parameter) => parameter.in === "path");
  const placeholders = [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]);
  if (
    new Set(placeholders).size !== placeholders.length
    || placeholders.some((name) => !pathParameters.some((parameter) => parameter.name === name))
    || pathParameters.some((parameter) => parameter.required !== true || !placeholders.includes(parameter.name))
  ) {
    throw new Error(`Operation ${operationId} path template/parameter contract drifted.`);
  }
  if (retryAuthority?.kind === "request_target_identity" && pathParameters.length === 0) {
    throw new Error(`Operation ${operationId} request-target retry authority requires a validated path parameter.`);
  }
  const queryParameters = parameters.filter((parameter) => parameter.in === "query");
  const queryRequired = queryParameters.some((parameter) => parameter.required === true);
  const requestProperties = isRecord(requestSchema.schema.properties) ? requestSchema.schema.properties : {};
  const requestRequired = new Set(Array.isArray(requestSchema.schema.required) ? requestSchema.schema.required : []);
  const queryNames = queryParameters.map((parameter) => parameter.name).sort(compareUtf8);
  if ((method === "GET" || method === "HEAD")
    && JSON.stringify(queryNames) !== JSON.stringify(Object.keys(requestProperties).sort(compareUtf8))) {
    throw new Error(`Operation ${operationId} query parameters drift from its request schema.`);
  }
  if ((method === "POST" || method === "DELETE") && queryParameters.length > 0) {
    throw new Error(`Operation ${operationId} has query parameters that the generated ${method} transport cannot send.`);
  }
  for (const parameter of queryParameters) {
    if ((parameter.required === true) !== requestRequired.has(parameter.name)
      || JSON.stringify(parameter.schema) !== JSON.stringify(requestProperties[parameter.name])) {
      throw new Error(`Operation ${operationId} query parameter ${parameter.name} drifted from its request schema.`);
    }
  }
  const assertedActor = parameters.find((parameter) => isRecord(parameter)
    && parameter.in === "header" && String(parameter.name).toLowerCase() === "x-calyx-asserted-actor");
  const lastEventId = parameters.find((parameter) => isRecord(parameter)
    && parameter.in === "header" && String(parameter.name).toLowerCase() === "last-event-id");
  if (assertedActor && (
    assertedActor.required === true
    || assertedActor.schema.type !== "string"
    || typeof assertedActor.schema.pattern !== "string"
    || typeof assertedActor.schema.maxLength !== "number"
  )) {
    throw new Error(`Operation ${operationId} asserted-actor header contract is incomplete.`);
  }
  if (lastEventId && (
    lastEventId.required === true
    || lastEventId.schema.type !== "string"
    || lastEventId.schema.minLength !== 1
    || !Number.isSafeInteger(lastEventId.schema.maxLength)
    || lastEventId.schema.maxLength < 1
    || (lastEventId.schema.pattern !== undefined && typeof lastEventId.schema.pattern !== "string")
  )) {
    throw new Error(`Operation ${operationId} Last-Event-ID contract is incomplete.`);
  }
  if (lastEventId) {
    assertExactKeys(lastEventId.schema, ["maxLength", "minLength", "pattern", "type"], `${operationId} Last-Event-ID schema`);
  }
  const hasSseSuccess = success.some((contract) => contract.representation === "sse");
  if (hasSseSuccess !== Boolean(lastEventId)) {
    throw new Error(`Operation ${operationId} SSE/Last-Event-ID replay authority is incomplete.`);
  }
  const plannedSuccess = success.map((contract) => contract.representation === "sse"
    ? {
        ...contract,
        ...assertSseReplaySubset(
          document,
          contract.schema,
          contract.cursorField,
          lastEventId.schema,
          `${operationId} status ${String(contract.status)}`,
        ),
      }
    : contract);
  const requestBody = isRecord(operation.requestBody) ? operation.requestBody : undefined;
  const content = requestBody && isRecord(requestBody.content) ? requestBody.content : undefined;
  const mediaTypes = content ? Object.keys(content) : [];
  const mediaType = mediaTypes[0];
  const media = mediaType && isRecord(content[mediaType]) ? content[mediaType] : undefined;
  if (transport.body === "json") {
    if (
      !requestBody
      || requestBody.required !== true
      || mediaTypes.length !== 1
      || !media
      || typeof requestBody["x-calyx-max-bytes"] !== "number"
      || requestBody["x-calyx-max-bytes"] !== transport.max_bytes
      || mediaType !== transport.media_type
      || !isRecord(media.schema)
      || media.schema.$ref !== requestSchema.ref.$ref
    ) {
      throw new Error(`Operation ${operationId} JSON transport lacks its exact generated body/size/schema contract.`);
    }
  } else {
    if (requestBody || content || transport.media_type !== undefined || transport.max_bytes !== undefined) {
      throw new Error(`Operation ${operationId} bodyless transport contradicts its request-body contract.`);
    }
    if (method === "POST" || method === "DELETE") {
      assertExactlyEmptyBodylessRequestSchema(requestSchema.schema, operationId);
    }
  }
  const requestAccept = operation["x-calyx-request-accept"];
  if (requestAccept !== undefined) {
    requireString(requestAccept, `${operationId} request Accept`);
    const negotiated = success.some((contract) => contract.condition?.request_accept === requestAccept
      || contract.semantics?.negotiation?.request_accept === requestAccept);
    if (!negotiated) throw new Error(`Operation ${operationId} request Accept is not bound to a success contract.`);
  }
  const plan = {
    operationId,
    method,
    pathTemplate: path,
    profile: operation["x-calyx-profile"],
    capability: operation["x-calyx-capability"],
    domain: operation["x-calyx-domain"],
    effects: operation["x-calyx-effects"],
    requestBody: transport.body,
    requestTargetMaxBytes,
    ...(mediaType ? { requestMediaType: mediaType } : {}),
    ...(requestBody ? { maxBodyBytes: requestBody["x-calyx-max-bytes"] } : {}),
    requestSchema: requestSchema.ref,
    ...(queryRequired ? { queryRequired: true } : {}),
    pathParameters: sortedObject(Object.fromEntries(pathParameters.map((parameter) => [parameter.name, parameter.schema]))),
    ...(typeof requestAccept === "string" ? { requestAccept } : {}),
    requestIdHeaderSchema,
    ...(assertedActor && isRecord(assertedActor.schema) && typeof assertedActor.schema.pattern === "string"
      ? { assertedActorPattern: assertedActor.schema.pattern }
      : {}),
    ...(assertedActor && isRecord(assertedActor.schema) && typeof assertedActor.schema.maxLength === "number"
      ? { assertedActorMaxLength: assertedActor.schema.maxLength }
      : {}),
    ...(lastEventId
      ? {
          lastEventIdAllowed: true,
          lastEventIdMaxLength: lastEventId.schema.maxLength,
          ...(typeof lastEventId.schema.pattern === "string"
            ? { lastEventIdPattern: lastEventId.schema.pattern }
            : {}),
        }
      : {}),
    ...(retryAuthority ? { retryAuthority } : {}),
    success: plannedSuccess,
    errorCodes: sortedObject(errorCodes),
    errorEnvelopeSchema: { $ref: "#/components/schemas/calyx_error_v1" },
    errorSchemas: sortedObject(errorSchemas),
    errorRequiredHeaders: sortedObject(errorRequiredHeaders),
    errorRequiredHeaderSchemas: sortedObject(errorRequiredHeaderSchemas),
  };
  return {
    ...plan,
    recoveryContractDigest: recoveryContractDigest(plan, document),
  };
}

function normalizedSegment(segment) {
  const normalized = segment.replace(/-([a-z0-9])/gu, (_match, value) => value.toUpperCase());
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(normalized) || RESERVED_SEGMENTS.has(normalized)) {
    throw new Error(`Operation namespace segment ${segment} normalizes to reserved/invalid ${normalized}.`);
  }
  return normalized;
}

function assertMethodCollisions(plans, surface) {
  const seen = new Map();
  for (const plan of plans) {
    if (surface === "admin" && plan.profile !== "control_plane_admin_v1") continue;
    const segments = plan.operationId.split(".");
    if (surface === "admin" && segments[0] === "admin") segments.shift();
    const normalized = segments.map(normalizedSegment).join(".");
    const previous = seen.get(normalized);
    if (previous) throw new Error(`Client method collision: ${previous} and ${plan.operationId} normalize to ${normalized}.`);
    seen.set(normalized, plan.operationId);
  }
}

function collectReferences(value, references) {
  if (Array.isArray(value)) {
    value.forEach((child) => collectReferences(child, references));
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.$ref === "string") references.add(value.$ref);
  Object.values(value).forEach((child) => collectReferences(child, references));
}

function recoveryContractDigest(plan, document) {
  const schemas = document.components.schemas;
  const needed = new Set();
  collectReferences(plan.requestSchema, needed);
  collectReferences(plan.pathParameters, needed);
  const queue = [...needed];
  while (queue.length > 0) {
    const reference = queue.shift();
    const prefix = "#/components/schemas/";
    if (!reference.startsWith(prefix)) continue;
    const key = reference.slice(prefix.length);
    const schema = schemas[key];
    if (!schema) throw new Error(`Recovery contract has unresolved request schema ${reference}.`);
    const discovered = new Set();
    collectReferences(schema, discovered);
    for (const next of discovered) {
      if (!needed.has(next)) {
        needed.add(next);
        queue.push(next);
      }
    }
  }
  const requestSchemas = Object.fromEntries([...needed]
    .filter((reference) => reference.startsWith("#/components/schemas/"))
    .sort(compareUtf8)
    .map((reference) => {
      const key = reference.slice("#/components/schemas/".length);
      return [key, schemas[key]];
    }));
  const replayAuthority = canonicalContractValue({
    schema_version: "calyx.client-recovery-contract/v1",
    operation_id: plan.operationId,
    profile: plan.profile,
    method: plan.method,
    path_template: plan.pathTemplate,
    request_target_max_bytes: plan.requestTargetMaxBytes,
    path_parameters: plan.pathParameters,
    request_body: plan.requestBody,
    request_media_type: plan.requestMediaType ?? null,
    max_body_bytes: plan.maxBodyBytes ?? null,
    request_schema: plan.requestSchema,
    request_schemas: requestSchemas,
    query_required: plan.queryRequired === true,
    request_accept: plan.requestAccept ?? null,
    asserted_actor_pattern: plan.assertedActorPattern ?? null,
    asserted_actor_max_length: plan.assertedActorMaxLength ?? null,
    retry_authority: plan.retryAuthority ?? null,
  });
  return createHash("sha256").update(JSON.stringify(replayAuthority), "utf8").digest("hex");
}

function prunedDocument(source, entries) {
  const schemas = source.components.schemas;
  const needed = new Set();
  entries.forEach((entry) => {
    collectReferences(entry.operation, needed);
    const requestSchemaId = entry.operation["x-calyx-request-schema"];
    const requestComponent = Object.entries(schemas).find(([, schema]) => (
      isRecord(schema)
      && schema["x-calyx-schema-role"] === "request"
      && schema["x-calyx-schema-id"] === requestSchemaId
    ));
    if (!requestComponent) throw new Error(`Projected request schema ${String(requestSchemaId)} is unresolved.`);
    needed.add(`#/components/schemas/${requestComponent[0]}`);
  });
  const queue = [...needed];
  while (queue.length > 0) {
    const reference = queue.shift();
    const prefix = "#/components/schemas/";
    if (!reference.startsWith(prefix)) continue;
    const key = reference.slice(prefix.length);
    const schema = schemas[key];
    if (!schema) throw new Error(`Unresolved projected schema reference ${reference}.`);
    const discovered = new Set();
    collectReferences(schema, discovered);
    for (const next of discovered) {
      if (!needed.has(next)) {
        needed.add(next);
        queue.push(next);
      }
    }
  }
  const selectedPaths = {};
  for (const entry of entries) {
    selectedPaths[entry.path] ??= {};
    selectedPaths[entry.path][entry.method.toLowerCase()] = entry.operation;
  }
  const selectedSchemas = {};
  for (const reference of [...needed].sort(compareUtf8)) {
    const prefix = "#/components/schemas/";
    if (reference.startsWith(prefix)) {
      selectedSchemas[reference.slice(prefix.length)] = globalThis.structuredClone(schemas[reference.slice(prefix.length)]);
    }
  }
  return {
    openapi: source.openapi,
    "x-calyx-bearer-token-contract": source["x-calyx-bearer-token-contract"],
    "x-calyx-request-target-max-bytes": source["x-calyx-request-target-max-bytes"],
    info: source.info,
    paths: sortedObject(selectedPaths),
    components: {
      securitySchemes: source.components.securitySchemes,
      schemas: sortedObject(selectedSchemas),
    },
  };
}

function assertRequestUnionLaw(document) {
  const schemas = document.components.schemas;
  const literalDiscriminators = (branch) => {
    const required = Array.isArray(branch.required) ? branch.required : [];
    const properties = isRecord(branch.properties) ? branch.properties : {};
    const discriminators = new Map();
    for (const key of required) {
      const property = isRecord(properties[key]) && typeof properties[key].$ref === "string"
        ? schemas[properties[key].$ref.replace("#/components/schemas/", "")]
        : properties[key];
      if (!isRecord(property)) continue;
      if (Object.hasOwn(property, "const")) discriminators.set(key, property.const);
      else if (
        property["x-calyx-enum-mode"] === "closed"
        && Array.isArray(property.enum)
        && property.enum.length === 1
      ) discriminators.set(key, property.enum[0]);
    }
    return discriminators;
  };
  const canonicalWireType = (branch) => {
    if (!isRecord(branch) || branch.nullable === true) return undefined;
    if (branch.type === "integer") return "number";
    return ["array", "boolean", "null", "number", "object", "string"].includes(branch.type)
      ? branch.type
      : undefined;
  };
  const visit = (value, pointer) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${pointer}/${index}`));
      return;
    }
    if (!isRecord(value)) return;
    for (const keyword of ["oneOf", "anyOf"]) {
      if (!Array.isArray(value[keyword])) continue;
      const resolvedBranches = value[keyword].map((branch) => (
        isRecord(branch) && typeof branch.$ref === "string"
          ? schemas[branch.$ref.replace("#/components/schemas/", "")]
          : branch
      ));
      const branchTypes = resolvedBranches.map(canonicalWireType);
      const disjointWireTypes = branchTypes.every((type) => typeof type === "string")
        && new Set(branchTypes).size === branchTypes.length;
      const discriminatorSets = resolvedBranches.map((branch) => isRecord(branch) ? literalDiscriminators(branch) : new Map());
      const commonDiscriminator = [...(discriminatorSets[0]?.keys() ?? [])].find((key) => {
        const values = discriminatorSets.map((discriminators) => discriminators.get(key));
        return values.every((item) => item !== undefined) && new Set(values.map((item) => JSON.stringify(item))).size === values.length;
      });
      for (const resolved of resolvedBranches) {
        if (!isRecord(resolved)) throw new Error(`Invalid request union branch at ${pointer}.`);
      }
      if (!commonDiscriminator && !disjointWireTypes) throw new Error(`Ambiguous request ${keyword} branch at ${pointer}.`);
      if (commonDiscriminator) {
        value["x-calyx-generated-discriminator"] = {
          property: commonDiscriminator,
          values: discriminatorSets.map((discriminators) => discriminators.get(commonDiscriminator)),
        };
      }
    }
    Object.entries(value).forEach(([key, child]) => visit(child, `${pointer}/${key}`));
  };
  for (const [key, schema] of Object.entries(schemas)) {
    if (schema["x-calyx-schema-role"] === "request") visit(schema, `#/components/schemas/${key}`);
  }
}

async function renderTypes(document, digest, surface, operationIds) {
  const ast = await openapiTS(document, {
    alphabetize: true,
    transform(schemaObject) {
      const knownValues = schemaObject["x-calyx-known-values"];
      if (schemaObject["x-calyx-enum-mode"] !== "open" || !Array.isArray(knownValues)) return undefined;
      const literals = knownValues.map((value) => ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(value)));
      literals.push(ts.factory.createTypeReferenceNode("CalyxUnknownEnumValue"));
      return ts.factory.createUnionTypeNode(literals);
    },
  });
  return [
    "// Generated by scripts/generate-client.mjs. Do not edit.",
    `// OpenAPI SHA-256: ${digest}; surface: ${surface}; operations: ${operationIds.join(",")}`,
    'import type { CalyxUnknownEnumValue } from "../../errors.js";',
    "",
    astToString(ast),
  ].join("\n");
}

function refComponentKey(reference) {
  const value = reference?.$ref;
  if (typeof value !== "string" || !value.startsWith("#/components/schemas/")) {
    throw new Error(`Generated operation success lacks a component ref: ${JSON.stringify(reference)}.`);
  }
  return value.slice("#/components/schemas/".length);
}

function responseType(plan) {
  const types = plan.success.map((success) => {
    if (success.representation === "sse") return `CalyxEventStream<components["schemas"]["${refComponentKey(success.schema)}"]>`;
    if (success.representation === "bytes") return "CalyxBinaryResponse";
    if (success.representation === "head") return "CalyxBinaryMetadata";
    return `components["schemas"]["${refComponentKey(success.schema)}"]`;
  });
  return [...new Set(types)].join(" | ");
}

function errorType(plan) {
  const codes = [...new Set(Object.values(plan.errorCodes).flat())].sort(compareUtf8);
  return codes.length > 0 ? codes.map((code) => JSON.stringify(code)).join(" | ") : "never";
}

function pathType(plan) {
  const pathNames = [...plan.pathTemplate.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]);
  if (pathNames.length === 0) return undefined;
  const property = (name) => (
    /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) && !RESERVED_SEGMENTS.has(name)
      ? name
      : JSON.stringify(name)
  );
  return `{ ${pathNames.map((name) => `${property(name)}: string`).join("; ")} }`;
}

function requestType(plan) {
  const parts = [];
  const path = pathType(plan);
  if (path) parts.push(`path: ${path}`);
  if (plan.method === "GET" || plan.method === "HEAD") {
    parts.push(`query${plan.queryRequired === true ? "" : "?"}: operations[${JSON.stringify(plan.operationId)}]["parameters"]["query"]`);
  } else if (plan.requestBody === "json") {
    parts.push(`body: operations[${JSON.stringify(plan.operationId)}]["requestBody"]["content"][${JSON.stringify(plan.requestMediaType)}]`);
  }
  if (plan.assertedActorPattern) parts.push("assertedActor?: string");
  if (plan.success.some((success) => success.representation === "sse")) parts.push("lastEventId?: string");
  parts.push("signal?: AbortSignal");
  return `{ ${parts.join("; ")} }`;
}

function operationRequiresRequest(plan) {
  return plan.requestBody === "json"
    || plan.queryRequired === true
    || plan.pathTemplate.includes("{");
}

function methodTree(plans, surface) {
  const root = { children: new Map(), plan: undefined };
  for (const plan of plans) {
    if (surface === "admin" && plan.profile !== "control_plane_admin_v1") continue;
    const rawSegments = plan.operationId.split(".");
    if (surface === "admin") rawSegments.shift();
    const segments = rawSegments.map(normalizedSegment);
    let node = root;
    for (const segment of segments) {
      if (node.plan) throw new Error(`Method/namespace collision at ${segment}.`);
      if (!node.children.has(segment)) node.children.set(segment, { children: new Map(), plan: undefined });
      node = node.children.get(segment);
    }
    if (node.children.size > 0 || node.plan) throw new Error(`Method/namespace collision for ${plan.operationId}.`);
    node.plan = plan;
  }
  return root;
}

function renderTreeType(node, indent = "  ") {
  return [...node.children.entries()].sort(([left], [right]) => compareUtf8(left, right)).map(([name, child]) => {
    if (child.plan) {
      const requestOptional = !operationRequiresRequest(child.plan);
      return `${indent}${name}(request${requestOptional ? "?" : ""}: ${requestType(child.plan)}): Promise<CalyxResult<${responseType(child.plan)}, ${errorType(child.plan)}>>;`;
    }
    return `${indent}readonly ${name}: {\n${renderTreeType(child, `${indent}  `)}\n${indent}};`;
  }).join("\n");
}

function renderRouteTreeType(node, indent = "  ") {
  return [...node.children.entries()].sort(([left], [right]) => compareUtf8(left, right)).map(([name, child]) => {
    if (child.plan) {
      const path = pathType(child.plan);
      return `${indent}readonly ${name}: (${path ? `path: ${path}` : ""}) => string;`;
    }
    return `${indent}readonly ${name}: {\n${renderRouteTreeType(child, `${indent}  `)}\n${indent}};`;
  }).join("\n");
}

function renderOperations(plans, surface, digest, operationIds) {
  const tree = methodTree(plans, surface);
  const typeName = surface === "consumer" ? "ConsumerClient" : "AdminClient";
  const factoryName = surface === "consumer" ? "createConsumerOperations" : "createAdminOperations";
  const routesTypeName = surface === "consumer" ? "ConsumerOperationRoutes" : "AdminOperationRoutes";
  const routesName = surface === "consumer" ? "consumerOperationRoutes" : "adminOperationRoutes";
  // Generated method bodies deliberately contain only operation identity plus
  // one call into the repo-owned transport; serializers/decoders live there.
  const renderValue = (node, indent = "  ") => [...node.children.entries()].sort(([left], [right]) => compareUtf8(left, right)).map(([name, child]) => {
    if (child.plan) {
      const request = operationRequiresRequest(child.plan)
        ? `request: ${requestType(child.plan)}`
        : `request = {} as ${requestType(child.plan)}`;
      return `${indent}${name}: (${request}) => transport.execute(${JSON.stringify(surface)}, operationPlans[${JSON.stringify(child.plan.operationId)}], request) as Promise<CalyxResult<${responseType(child.plan)}, ${errorType(child.plan)}>>,`;
    }
    return `${indent}${name}: {\n${renderValue(child, `${indent}  `)}\n${indent}},`;
  }).join("\n");
  const renderRouteValue = (node, indent = "  ") => [...node.children.entries()].sort(([left], [right]) => compareUtf8(left, right)).map(([name, child]) => {
    if (child.plan) {
      const path = pathType(child.plan);
      return `${indent}${name}: (${path ? `path: ${path}` : ""}) => composeGeneratedOperationPath(operationPlans[${JSON.stringify(child.plan.operationId)}], ${path ? "path" : "undefined"}).path,`;
    }
    return `${indent}${name}: {\n${renderRouteValue(child, `${indent}  `)}\n${indent}},`;
  }).join("\n");
  const hasSse = plans.some((plan) => plan.success.some((success) => success.representation === "sse"));
  const hasBytes = plans.some((plan) => plan.success.some((success) => success.representation === "bytes"));
  const hasHead = plans.some((plan) => plan.success.some((success) => success.representation === "head"));
  const transportTypes = [
    ...(hasHead ? ["CalyxBinaryMetadata"] : []),
    ...(hasBytes ? ["CalyxBinaryResponse"] : []),
    "CalyxTransport",
  ];
  return [
    "// Generated by scripts/generate-client.mjs. Do not edit.",
    `// OpenAPI SHA-256: ${digest}; surface: ${surface}; operations: ${operationIds.join(",")}`,
    'import type { CalyxResult } from "../../errors.js";',
    ...(hasSse ? ['import type { CalyxEventStream } from "../../sse.js";'] : []),
    `import type { ${transportTypes.join(", ")} } from "../../transport.js";`,
    'import { composeGeneratedOperationPath, freezeGeneratedOperationRoutes } from "../../transport.js";',
    'import type { components, operations } from "./openapi.js";',
    'import { operationPlans } from "./serializers.js";',
    "",
    `export interface ${typeName} {`,
    renderTreeType(tree),
    "}",
    "",
    `export interface ${routesTypeName} {`,
    renderRouteTreeType(tree),
    "}",
    "",
    `export const ${routesName}: ${routesTypeName} = freezeGeneratedOperationRoutes({`,
    renderRouteValue(tree),
    "});",
    "",
    `export function ${factoryName}(transport: CalyxTransport): ${typeName} {`,
    "  return {",
    renderValue(tree, "    "),
    "  };",
    "}",
    "",
  ].join("\n");
}

const GENERATED_SOURCE = Symbol("generated-source");

function generatedSource(source) {
  return { [GENERATED_SOURCE]: true, source };
}

function renderGeneratedValue(value, indent = 0) {
  if (isRecord(value) && value[GENERATED_SOURCE] === true) return value.source;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const childIndent = " ".repeat(indent + 2);
    return `[\n${value.map((entry) => `${childIndent}${renderGeneratedValue(entry, indent + 2)}`).join(",\n")}\n${" ".repeat(indent)}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const childIndent = " ".repeat(indent + 2);
    return `{\n${entries.map(([key, entry]) => (
      `${childIndent}${JSON.stringify(key)}: ${renderGeneratedValue(entry, indent + 2)}`
    )).join(",\n")}\n${" ".repeat(indent)}}`;
  }
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

function resolvedGeneratedSchema(document, rawSchema, active = new Set()) {
  const schema = requireObject(rawSchema, "generated codec schema");
  if (typeof schema.$ref !== "string") return schema;
  const prefix = "#/components/schemas/";
  if (!schema.$ref.startsWith(prefix)) throw new Error(`Generated codec uses unsupported reference ${schema.$ref}.`);
  if (active.has(schema.$ref)) throw new Error(`Generated codec cannot compile cyclic reference ${schema.$ref}.`);
  const target = document.components?.schemas?.[schema.$ref.slice(prefix.length)];
  if (!isRecord(target)) throw new Error(`Generated codec reference ${schema.$ref} is unresolved.`);
  const next = new Set(active);
  next.add(schema.$ref);
  return resolvedGeneratedSchema(document, target, next);
}

function generatedSchemaWireType(document, rawSchema) {
  const schema = resolvedGeneratedSchema(document, rawSchema);
  if (typeof schema.type === "string") return schema.type;
  if (isRecord(schema.properties)) return "object";
  for (const keyword of ["oneOf", "anyOf", "allOf"]) {
    if (!Array.isArray(schema[keyword]) || schema[keyword].length === 0) continue;
    const types = [...new Set(schema[keyword].map((branch) => generatedSchemaWireType(document, branch)))];
    if (types.length === 1) return types[0];
  }
  throw new Error("Generated codec schema has no singular wire type.");
}

function generatedSchemaVersions(document, rawSchema, active = new Set()) {
  const schema = resolvedGeneratedSchema(document, rawSchema, active);
  const versions = new Set();
  for (const keyword of ["allOf", "oneOf", "anyOf"]) {
    if (!Array.isArray(schema[keyword])) continue;
    for (const branch of schema[keyword]) {
      generatedSchemaVersions(document, branch, active).forEach((version) => versions.add(version));
    }
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  if (isRecord(properties.schema_version)) {
    const version = resolvedGeneratedSchema(document, properties.schema_version, active);
    if (typeof version.const === "string") versions.add(version.const);
    if (Array.isArray(version.enum)) version.enum.forEach((entry) => { if (typeof entry === "string") versions.add(entry); });
  }
  return [...versions].sort(compareUtf8);
}

function renderCrossFieldPredicate(schema) {
  const checks = [];
  const pagination = schema["x-calyx-pagination-contract"];
  if (isRecord(pagination) && typeof pagination.count_field === "string") {
    checks.push(
      `if (!Array.isArray(value[${JSON.stringify(pagination.items_field)}]) || value[${JSON.stringify(pagination.count_field)}] !== value[${JSON.stringify(pagination.items_field)}].length) return false;`,
    );
  }
  const contract = schema["x-calyx-cross-field-contract"];
  if (!isRecord(contract)) return checks.length === 0 ? "undefined" : `(value: any) => { ${checks.join(" ")} return true; }`;
  const markAuthority = contract.activity_mark_authority;
  if (isRecord(markAuthority)) {
    const target = markAuthority.target_identity;
    const equalityChecks = markAuthority.equalities.map((equality) => (
      `if (g.valueAtPath(object, ${JSON.stringify(equality.left)}) !== g.valueAtPath(object, ${JSON.stringify(equality.right)})) return false;`
    )).join(" ");
    checks.push(
      `{ const objects = g.objectsAtPath(value, ${JSON.stringify(markAuthority.object_path)});`,
      ...(markAuthority.object_path === "$" ? ["if (objects.length === 0) return false;"] : []),
      `if (!objects.every((object) => { ${equalityChecks} const kind = object[${JSON.stringify(target.kind_field)}]; const targetId = object[${JSON.stringify(target.id_field)}]; if (typeof kind !== "string" || typeof targetId !== "string") return false; let activityId = targetId; if (kind !== "activity") { const suffix = (${JSON.stringify(target.suffix_by_kind)} as Record<string, string>)[kind]; if (typeof suffix !== "string") return false; const marker = targetId.lastIndexOf(suffix); if (marker <= 0) return false; activityId = targetId.slice(0, marker); const sourceLine = targetId.slice(marker + suffix.length); const numericLine = Number(sourceLine); if (!new RegExp(${JSON.stringify(target.source_line_pattern)}, "u").test(sourceLine) || !Number.isSafeInteger(numericLine) || numericLine > ${JSON.stringify(target.source_line_maximum)} || String(numericLine) !== sourceLine) return false; } return new RegExp(${JSON.stringify(target.activity_id_pattern)}, "u").test(activityId); })) return false; }`,
    );
  }
  const attachment = contract.attachment_identity;
  if (isRecord(attachment)) {
    checks.push(
      `{ const objects = g.objectsAtPath(value, ${JSON.stringify(attachment.object_path)});`,
      ...(attachment.object_path === "$" ? ["if (objects.length === 0) return false;"] : []),
      `if (!objects.every((object) => { const ref = object[${JSON.stringify(attachment.ref_field)}]; const sha256 = object[${JSON.stringify(attachment.sha256_field)}]; return typeof ref === "string" && typeof sha256 === "string" && new RegExp(${JSON.stringify(attachment.sha256_pattern)}, "u").test(sha256) && ref === ${JSON.stringify(attachment.ref_template)}.replace("{sha256}", sha256); })) return false; }`,
    );
  }
  const histogram = contract.unresolved_histogram;
  if (isRecord(histogram)) {
    checks.push(
      `{ const entries = value["unresolved"]; if (!Array.isArray(entries)) return false; const keys = new Set(); let sum = 0;`,
      `for (const entry of entries as any[]) { if (typeof entry !== "object" || entry === null || Array.isArray(entry) || keys.has(entry[${JSON.stringify(histogram.unique_by)}]) || !Number.isSafeInteger(entry[${JSON.stringify(histogram.sum_field)}])) return false; keys.add(entry[${JSON.stringify(histogram.unique_by)}]); sum += entry[${JSON.stringify(histogram.sum_field)}]; }`,
      `if (sum !== g.valueAtPath(value, ${JSON.stringify(histogram.equals)})) return false; }`,
    );
  }
  const examples = contract.noncanonical_directory_examples;
  if (isRecord(examples)) {
    const accepted = examples.accepted_length_contracts.map((candidate) => {
      if (Array.isArray(candidate.length_equals_min_of)) {
        const [path, maximum] = candidate.length_equals_min_of;
        return `() => { const count = g.valueAtPath(value, ${JSON.stringify(path)}); return Number.isSafeInteger(count) && rows.length === Math.min(count as number, ${JSON.stringify(maximum)}) && rows.every((row: any) => typeof row === "object" && row !== null && !Array.isArray(row) && typeof row.directory_name === "string" && [...row.directory_name].length <= ${JSON.stringify(candidate.directory_name_max_length)} && (row.record_state === undefined || (typeof row.record_state === "string" && [...row.record_state].length <= ${JSON.stringify(candidate.record_state_max_length)}))); }`;
      }
      return `() => rows.length === g.valueAtPath(value, ${JSON.stringify(candidate.length_equals)})`;
    });
    checks.push(
      `{ const rows = value[${JSON.stringify(examples.field)}]; if (!Array.isArray(rows) || ![${accepted.join(", ")}].some((accept) => accept())) return false; }`,
    );
  }
  if (Array.isArray(contract.incomplete_if_any)) {
    const conditions = contract.incomplete_if_any.map((condition) => (
      condition.operator === ">"
        ? `(typeof g.valueAtPath(value, ${JSON.stringify(condition.field)}) === "number" && (g.valueAtPath(value, ${JSON.stringify(condition.field)}) as number) > ${JSON.stringify(condition.value)})`
        : `(g.valueAtPath(value, ${JSON.stringify(condition.field)}) === ${JSON.stringify(condition.value)})`
    ));
    checks.push(`if ((${conditions.join(" || ")}) && value["status"] !== "incomplete") return false;`);
  }
  return `(value: any) => { ${checks.join(" ")} return true; }`;
}

function compileGeneratedCodecs(document) {
  const requestNames = new Map();
  const responseNames = new Map();
  const declarations = [];
  let nextId = 0;
  const literal = (value) => renderGeneratedValue(value);
  const request = (rawSchema) => {
    const schema = resolvedGeneratedSchema(document, rawSchema);
    const key = JSON.stringify(schema);
    if (requestNames.has(key)) return requestNames.get(key);
    const name = `requestCodec${String(nextId++)}`;
    requestNames.set(key, name);
    let body;
    const union = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
    if (union) {
      const branches = union.map((branch) => `{ serialize: ${request(branch)}, wireType: ${JSON.stringify(generatedSchemaWireType(document, branch))} }`);
      const discriminator = schema["x-calyx-generated-discriminator"];
      body = `g.requestUnion([${branches.join(", ")}], ${isRecord(discriminator) ? literal({ property: discriminator.property, values: discriminator.values }) : "undefined"})`;
    } else if (schema.type === "object" || isRecord(schema.properties)) {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const renderedProperties = Object.entries(properties).sort(([left], [right]) => compareUtf8(left, right))
        .map(([keyName, child]) => `${JSON.stringify(keyName)}: ${request(child)}`).join(", ");
      let additional = "undefined";
      if (schema["x-calyx-dictionary-mode"] === "explicit-json-metadata") additional = JSON.stringify("json");
      else if (isRecord(schema.additionalProperties) && Object.keys(schema.additionalProperties).length > 0) additional = request(schema.additionalProperties);
      body = `g.requestObject({ ${renderedProperties} }, ${literal(schema.required ?? [])}, ${additional})`;
    } else if (schema.type === "array") {
      const item = Array.isArray(schema.items)
        ? `[${schema.items.map((entry) => request(entry)).join(", ")}]`
        : request(schema.items);
      body = `g.requestArray(${item}, ${literal(schema.minItems)}, ${literal(schema.maxItems)})`;
    } else if (schema.type === "number" || schema.type === "integer") {
      body = `g.requestNumber(${String(schema.type === "integer")}, ${literal(schema.minimum)}, ${String(schema.exclusiveMinimum === true)}, ${literal(schema.maximum)}, ${String(schema.exclusiveMaximum === true)})`;
    } else if (schema.type === "boolean") body = "g.requestBoolean()";
    else if (schema.type === "null") body = "g.requestNull()";
    else body = `g.requestString(${literal(schema.minLength)}, ${literal(schema.maxLength)}, ${literal(schema.pattern)}, ${literal(schema.format)})`;
    const enumValues = Array.isArray(schema.enum) && schema["x-calyx-enum-mode"] !== "open" ? schema.enum : undefined;
    declarations.push(`const ${name} = g.requestGuard(${body}, ${String(schema.nullable === true || schema.type === "null")}, ${literal(enumValues)}, ${String(Object.hasOwn(schema, "const"))}, ${literal(schema.const)});`);
    return name;
  };
  const response = (rawSchema) => {
    const schema = resolvedGeneratedSchema(document, rawSchema);
    if (schema.type === "string" && schema.format === "binary") return response({});
    const key = JSON.stringify(schema);
    if (responseNames.has(key)) return responseNames.get(key);
    const name = `responseCodec${String(nextId++)}`;
    responseNames.set(key, name);
    let body = "g.responseAny()";
    if (schema.type === "object" || isRecord(schema.properties)) {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const renderedProperties = Object.entries(properties).sort(([left], [right]) => compareUtf8(left, right))
        .map(([keyName, child]) => `${JSON.stringify(keyName)}: ${response(child)}`).join(", ");
      const additional = isRecord(schema.additionalProperties) ? response(schema.additionalProperties) : "undefined";
      body = `g.responseObject({ ${renderedProperties} }, ${literal(schema.required ?? [])}, ${String(schema["x-calyx-unknown-field-policy"] === "reject")}, ${additional}, ${renderCrossFieldPredicate(schema)})`;
    } else if (schema.type === "array") {
      const item = Array.isArray(schema.items)
        ? `[${schema.items.map((entry) => response(entry)).join(", ")}]`
        : response(schema.items ?? {});
      body = `g.responseArray(${item}, ${literal(schema.minItems)}, ${literal(schema.maxItems)})`;
    } else if (schema.type === "string") {
      body = `g.responseString(${literal(schema.minLength)}, ${literal(schema.maxLength)}, ${literal(schema.pattern)}, ${literal(schema.format)})`;
    } else if (schema.type === "number" || schema.type === "integer") {
      body = `g.responseNumber(${String(schema.type === "integer")}, ${literal(schema.minimum)}, ${String(schema.exclusiveMinimum === true)}, ${literal(schema.maximum)}, ${String(schema.exclusiveMaximum === true)})`;
    } else if (schema.type === "boolean") body = "g.responseBoolean()";
    else if (schema.type === "null") body = "g.responseNull()";
    const allOf = Array.isArray(schema.allOf) ? schema.allOf.map(response) : [];
    const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf.map(response) : [];
    const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf.map(response) : [];
    const not = isRecord(schema.not) ? response(schema.not) : "undefined";
    const enumValues = Array.isArray(schema.enum) && schema["x-calyx-enum-mode"] !== "open" ? schema.enum : undefined;
    const globalContract = schema.type === "object" || isRecord(schema.properties)
      ? "undefined"
      : renderCrossFieldPredicate(schema);
    declarations.push(`const ${name} = g.response(${body}, ${String(schema.nullable === true)}, ${not}, [${allOf.join(", ")}], [${oneOf.join(", ")}], [${anyOf.join(", ")}], ${String(Object.hasOwn(schema, "const"))}, ${literal(schema.const)}, ${literal(enumValues)}, ${literal(generatedSchemaVersions(document, schema))}, ${globalContract});`);
    return name;
  };
  const header = (schema) => `g.header(${response(schema)}, ${JSON.stringify(generatedSchemaWireType(document, schema))})`;
  return { request, response, header, declarations };
}

function renderSerializers(document, plans, digest, surface, operationIds) {
  const codecs = compileGeneratedCodecs(document);
  const serializablePlans = Object.fromEntries(plans.map((plan) => {
    const {
      requestSchema,
      pathParameters,
      requestIdHeaderSchema,
      errorEnvelopeSchema,
      errorSchemas,
      errorRequiredHeaderSchemas,
      success,
      ...metadata
    } = plan;
    return [plan.operationId, {
      ...metadata,
      surface,
      pathParameterSerializers: Object.fromEntries(Object.entries(pathParameters).map(([name, schema]) => (
        [name, generatedSource(codecs.request(schema))]
      ))),
      requestSerializer: generatedSource(codecs.request(requestSchema)),
      requestIdHeaderDecoder: generatedSource(codecs.header(requestIdHeaderSchema)),
      success: success.map(({ schema, headerSchemas, ...contract }) => ({
        ...contract,
        decoder: generatedSource(codecs.response(
          contract.representation === "bytes" || contract.representation === "head" ? {} : schema,
        )),
        headerDecoders: Object.fromEntries(Object.entries(headerSchemas).map(([name, headerSchema]) => (
          [name, generatedSource(codecs.header(headerSchema))]
        ))),
      })),
      errorEnvelopeDecoder: generatedSource(codecs.response(errorEnvelopeSchema)),
      errorDecoders: Object.fromEntries(Object.entries(errorSchemas).map(([status, schema]) => (
        [status, generatedSource(codecs.response(schema))]
      ))),
      errorRequiredHeaderDecoders: Object.fromEntries(Object.entries(errorRequiredHeaderSchemas).map(([status, schemas]) => (
        [status, Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, generatedSource(codecs.header(schema))]))]
      ))),
    }];
  }));
  return [
    "// Generated by scripts/generate-client.mjs. Do not edit.",
    `// OpenAPI SHA-256: ${digest}; surface: ${surface}; operations: ${operationIds.join(",")}`,
    'import { generatedCodec as g } from "../../transport.js";',
    'import type { OperationPlan } from "../../transport.js";',
    "",
    ...codecs.declarations,
    "",
    `export const operationPlans = ${renderGeneratedValue(serializablePlans)} as const satisfies Readonly<Record<string, OperationPlan>>;`,
    "",
  ].join("\n");
}

function renderDigest(digest, byteCount, surface, operationIds, bearerContract) {
  return [
    "// Generated by scripts/generate-client.mjs. Do not edit.",
    "/** Whole-document provenance only; never use as durable replay or recovery authority. */",
    `export const OPENAPI_PROVENANCE_SHA256 = ${JSON.stringify(digest)};`,
    "/** Whole-document provenance only; recovery compatibility is operation-bound. */",
    `export const OPENAPI_PROVENANCE_BYTE_COUNT = ${byteCount};`,
    `export const CLIENT_SURFACE = ${JSON.stringify(surface)};`,
    `export const OPERATION_IDS = ${JSON.stringify(operationIds, null, 2)} as const;`,
    `export const BEARER_TOKEN_CONTRACT = ${JSON.stringify(bearerContract, null, 2)} as const;`,
    "",
  ].join("\n");
}

function assertCanonicalCompilerInput(sourceText, source) {
  const compact = JSON.stringify(source);
  const generated = `${JSON.stringify(source, null, 2)}\n`;
  if (sourceText !== compact && sourceText !== generated) {
    throw new Error(
      "Client compiler input must be exact canonical JSON emitted by JSON.stringify or the repo spec generator; "
      + "duplicate members, lossy numeric tokens, and noncanonical whitespace are refused.",
    );
  }
}

export function buildClientContractIR(sourceBytes, options = {}) {
  const digest = createHash("sha256").update(sourceBytes).digest("hex");
  const sourceText = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  const source = JSON.parse(sourceText);
  assertCanonicalCompilerInput(sourceText, source);
  if (!isRecord(source) || source.openapi !== "3.0.3") throw new Error("Client compiler requires Calyx OpenAPI 3.0.3 bytes.");
  assertNoUnknownExtensions(source);
  assertDocumentStandardVocabulary(source);
  assertProjectedStandardVocabulary(source);
  const index = componentIndex(source);
  const entries = operationEntries(source);
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.operation.operationId)) throw new Error(`Duplicate operationId ${entry.operation.operationId}.`);
    ids.add(entry.operation.operationId);
    assertProjectionLaw(entry);
    assertOperationMetadata(entry);
  }
  const projections = Object.fromEntries(SURFACES.map((surface) => [surface, entries.filter((entry) => (
    entry.operation["x-calyx-client-surfaces"].includes(surface)
  ))]));
  const counts = {};
  const surfaces = {};
  for (const surface of SURFACES) {
    const projectedEntries = projections[surface];
    const document = prunedDocument(source, projectedEntries);
    assertProjectedStandardVocabulary(document);
    assertProjectedExtensionLocations(document);
    assertSchemaExtensionContracts(document);
    assertClientSchemaSubset(document);
    assertRequestUnionLaw(document);
    const plans = projectedEntries.map((entry) => ({ ...operationPlan(entry, index, document), surface }));
    assertMethodCollisions(plans, surface);
    const operationIds = plans.map((plan) => plan.operationId);
    counts[surface] = operationIds.length;
    surfaces[surface] = {
      openapiDocument: document,
      schemas: document.components.schemas,
      plans,
      operationIds,
    };
  }
  const expectedCounts = options.expectedCounts ?? null;
  if (expectedCounts && (counts.consumer !== expectedCounts.consumer || counts.admin !== expectedCounts.admin)) {
    throw new Error(`Unexpected projected operation counts consumer=${counts.consumer} admin=${counts.admin}.`);
  }
  return {
    digest,
    byteCount: sourceBytes.byteLength,
    bearerTokenContract: bearerTokenContract(source),
    counts,
    surfaces,
  };
}

export async function compileClientContract(sourceBytes, options = {}) {
  const contract = buildClientContractIR(sourceBytes, options);
  const files = {};
  for (const surface of SURFACES) {
    const { openapiDocument, plans, operationIds } = contract.surfaces[surface];
    const prefix = `packages/client/src/generated/${surface}`;
    files[`${prefix}/openapi.ts`] = await renderTypes(openapiDocument, contract.digest, surface, operationIds);
    files[`${prefix}/operations.ts`] = renderOperations(plans, surface, contract.digest, operationIds);
    files[`${prefix}/serializers.ts`] = renderSerializers(openapiDocument, plans, contract.digest, surface, operationIds);
    files[`${prefix}/digest.ts`] = renderDigest(
      contract.digest,
      contract.byteCount,
      surface,
      operationIds,
      contract.bearerTokenContract,
    );
  }
  return { files: sortedObject(files), digest: contract.digest, byteCount: contract.byteCount, counts: contract.counts };
}
