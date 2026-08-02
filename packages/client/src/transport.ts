import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { scheduler } from "node:timers/promises";

import { CalyxClientConfigurationError } from "./errors.js";
import type {
  CalyxApiFailure,
  CalyxErrorEnvelope,
  CalyxIndeterminateFailure,
  CalyxIndeterminateReceipt,
  CalyxProtocolFailure,
  CalyxResult,
} from "./errors.js";
import {
  DuplicateJsonMemberScanner,
  hasDuplicateJsonMembers,
  parseJsonWithNumberLexemes,
} from "./json.js";
import type { JsonNumberLexemes } from "./json.js";
import { createCalyxEventStream } from "./sse.js";
import type { CalyxEventStream } from "./sse.js";

export type TokenProvider = (signal?: AbortSignal) => Promise<string> | string;

export interface CalyxBearerTokenContract {
  readonly encoding: "ascii";
  readonly max_bytes: number;
  readonly pattern: string;
}

export interface CalyxRecoveryStore {
  /**
   * Recovery receipts contain exact request bytes and must be treated as
   * sensitive application data, even though transport credentials are absent.
   */
  readonly custody: "encrypted_access_controlled";
  /**
   * Durably reserve exact replay authority before the first keyed-write
   * dispatch. A rejection is a fail-before-dispatch gate.
   */
  reserve(receipt: CalyxIndeterminateReceipt): Promise<void> | void;
  save(receipt: CalyxIndeterminateReceipt): Promise<void> | void;
  /** Best-effort cleanup after a server-authoritative success or API result. */
  release(receipt: CalyxIndeterminateReceipt): Promise<void> | void;
}

export interface CalyxClientOptions {
  baseUrl: string | URL;
  bearerToken: string | TokenProvider;
  /**
   * Recovery-only credential retained across one static-token rotation.
   * Ordinary operations never use it. Do not advance another rotation until
   * every receipt bound to this credential has drained.
   */
  previousBearerToken?: string | TokenProvider;
  fetch?: typeof fetch;
  retry?: {
    maxAttempts?: 1 | 2;
    recoveryAttempts?: 1 | 2 | 3;
    sseReconnectAttempts?: 0 | 1 | 2 | 3;
  };
  recoveryStore?: CalyxRecoveryStore;
  /**
   * Exactly 32 bytes of protected key material used to authenticate recovery
   * receipts across client instances. Required when recoveryStore is present;
   * otherwise a process-local key limits replay to the issuing client instance.
   */
  recoveryReceiptIntegrityKey?: Uint8Array;
}

export interface CalyxReplayOptions {
  /** Cancels credential resolution and the replay request without weakening receipt authority. */
  readonly signal?: AbortSignal;
}

export interface CalyxBinaryMetadata {
  contentLength: number;
  contentType: string;
  etag: string;
  digest: string;
  attachmentRef: string;
  originHost?: string;
  servedByHost?: string;
  sourceTier: string;
  requestId: string;
}

export interface CalyxBinaryResponse extends CalyxBinaryMetadata {
  body: ReadableStream<Uint8Array>;
  /** Settles only after the body reaches EOF and its length and digest are verified. */
  verified: Promise<void>;
}

/** Maximum accepted wire size for a calyx.error/v1 response envelope. */
const CALYX_ERROR_ENVELOPE_MAX_BYTES = 1024 * 1024;
/** Raw bytes retained in a surfaced protocol-failure diagnostic. */
const CALYX_PROTOCOL_BODY_SNIPPET_MAX_BYTES = 2 * 1024;
/** Total bytes observed solely for early-rejection evidence before cancellation. */
const CALYX_PROTOCOL_BODY_OBSERVATION_MAX_BYTES = 1024 * 1024;
/** Absolute wall-clock budget for sampling a body rejected before normal decoding. */
const CALYX_PROTOCOL_BODY_OBSERVATION_DEADLINE_MS = 50;

/**
 * Consumes a one-shot attachment stream and returns bytes only after custody is
 * established. Streaming callers can keep using body + verified directly.
 */
export async function bufferVerifiedBinary(response: CalyxBinaryResponse): Promise<Uint8Array> {
  const reader = response.body.getReader();
  const bytes = new Uint8Array(response.contentLength);
  let offset = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.byteLength > bytes.byteLength) {
        throw new ResponseBodyContractError("custody_mismatch", "Attachment stream exceeded its declared buffered length.");
      }
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
    if (offset !== bytes.byteLength) {
      throw new ResponseBodyContractError("custody_mismatch", "Attachment stream ended before its declared buffered length.");
    }
    await response.verified;
    return bytes;
  } catch (error: unknown) {
    await reader.cancel(error).catch(() => undefined);
    await response.verified.catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export interface OperationRequest<Path = Record<string, string>, Query = unknown, Body = unknown> {
  path?: Path;
  query?: Query;
  body?: Body;
  assertedActor?: string;
  lastEventId?: string;
  signal?: AbortSignal;
}

export type GeneratedRequestSerializer = (value: unknown, active?: WeakSet<object>) => unknown;

export interface GeneratedStructuralDecoder {
  readonly schemaVersions: readonly string[];
  matches(value: unknown, numberLexemes?: JsonNumberLexemes, numberLexeme?: string): boolean;
}

export type GeneratedHeaderDecoder = (value: string) => boolean;

export interface OperationSuccessPlan {
  readonly status: number;
  readonly representation: "json" | "sse" | "bytes" | "head";
  readonly mediaType: string | null;
  readonly decoder: GeneratedStructuralDecoder;
  readonly requiredHeaders: readonly string[];
  /** Every declared success-header schema, including optional headers when present. */
  readonly headerDecoders: Readonly<Record<string, GeneratedHeaderDecoder>>;
  readonly maxBytes?: number;
  readonly maxFrameBytes?: number;
  readonly cursorField?: string;
  readonly cursorMaxLength?: number;
  readonly cursorPattern?: string;
  readonly custodyContract?: Readonly<Record<string, unknown>>;
  readonly condition?: Readonly<Record<string, unknown>>;
  readonly semantics: Readonly<Record<string, unknown>>;
}

export type OperationRetryAuthority =
  | {
    readonly kind: "request_body_field";
    readonly field: string;
  }
  | {
    readonly kind: "operation_identity";
  }
  | {
    readonly kind: "request_target_identity";
  };

export interface OperationPlan {
  readonly operationId: string;
  /** Replay-relevant per-operation request contract; unrelated API edits cannot strand receipts. */
  readonly recoveryContractDigest: string;
  /** Generated projection authority used for schema selection and recovery. */
  readonly surface: "consumer" | "admin";
  /** Validated wire profile retained independently from operationId spelling. */
  readonly profile: "consumer_v1" | "control_plane_admin_v1";
  /** Declared receiver capability; descriptive metadata, not client-side authorization. */
  readonly capability: string;
  /** Declared operation domain; descriptive metadata, not a routing override. */
  readonly domain: string;
  /** Receiver-side effect envelope validated against every success branch at generation time. */
  readonly effects: Readonly<Record<string, unknown>>;
  readonly method: "GET" | "HEAD" | "POST" | "DELETE";
  readonly pathTemplate: string;
  /** Maximum UTF-8 bytes in the complete encoded path and query target. */
  readonly requestTargetMaxBytes: number;
  readonly pathParameterSerializers: Readonly<Record<string, GeneratedRequestSerializer>>;
  readonly requestBody: "none" | "json";
  readonly requestMediaType?: string;
  readonly maxBodyBytes?: number;
  readonly requestSerializer: GeneratedRequestSerializer;
  /** At least one generated query field is required by the request schema. */
  readonly queryRequired?: boolean;
  readonly requestAccept?: string;
  /** Cross-status request identity contract, proven identical by generation. */
  readonly requestIdHeaderDecoder: GeneratedHeaderDecoder;
  readonly assertedActorPattern?: string;
  readonly assertedActorMaxLength?: number;
  readonly lastEventIdAllowed?: boolean;
  readonly lastEventIdMaxLength?: number;
  readonly lastEventIdPattern?: string;
  readonly retryAuthority?: OperationRetryAuthority;
  readonly success: readonly OperationSuccessPlan[];
  readonly errorCodes: Readonly<Record<string, readonly string[]>>;
  /** Canonical rolling-open calyx.error/v1 envelope used to diagnose undeclared non-2xx statuses. */
  readonly errorEnvelopeDecoder: GeneratedStructuralDecoder;
  /** Exact generated calyx.error/v1 refinement for each declared error status. */
  readonly errorDecoders: Readonly<Record<string, GeneratedStructuralDecoder>>;
  readonly errorRequiredHeaders: Readonly<Record<string, readonly string[]>>;
  readonly errorRequiredHeaderDecoders: Readonly<Record<string, Readonly<Record<string, GeneratedHeaderDecoder>>>>;
}

function unkeyedWriteReconciliationOperations(
  plan: OperationPlan,
): readonly [string, ...string[]] | undefined {
  const mappings = plan.success.map((success) => success.semantics["reconciliation_operation_ids"]);
  const isUnkeyedStatefulWrite = plan.method === "POST"
    && plan.retryAuthority === undefined
    && plan.success.length > 0
    && plan.success.every((success) => success.semantics["mutation"] === "stateful_write");
  if (!isUnkeyedStatefulWrite) {
    if (mappings.some((mapping) => mapping !== undefined)) {
      throw new CalyxClientConfigurationError(
        `Generated ${plan.operationId} carries unkeyed reconciliation metadata outside an unkeyed stateful write.`,
      );
    }
    return undefined;
  }
  const first = mappings[0];
  if (
    !Array.isArray(first)
    || first.length === 0
    || first.some((candidate) => typeof candidate !== "string" || candidate.length === 0)
    || mappings.some((mapping) => JSON.stringify(mapping) !== JSON.stringify(first))
  ) {
    throw new CalyxClientConfigurationError(
      `Generated unkeyed stateful write ${plan.operationId} lacks one exact named reconciliation projection.`,
    );
  }
  return Object.freeze([...first]) as unknown as readonly [string, ...string[]];
}

interface PreparedRequest {
  readonly path: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyBytes?: Uint8Array;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  /** Validated path parameters exactly as observed while building `url`. */
  readonly pathParameters: Readonly<Record<string, unknown>>;
  /** One immutable credential authority for this complete logical operation. */
  readonly credential?: {
    readonly bearerToken: string;
    readonly recoveryBinding: string;
  };
}

interface ResponseAuthority {
  readonly status: number;
  readonly requestId: string;
}

interface NormalizedBaseUrl {
  readonly origin: string;
  readonly basePath: string;
}

const textEncoder = new TextEncoder();
const utf8Compare = (left: string, right: string): number => (
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
);

function normalizeBaseUrl(input: string | URL): NormalizedBaseUrl {
  const value = input instanceof URL ? new URL(input.href) : new URL(input);
  if (value.protocol !== "http:" && value.protocol !== "https:") {
    throw new CalyxClientConfigurationError("Calyx baseUrl must use http: or https:.");
  }
  if (value.username || value.password || value.search || value.hash) {
    throw new CalyxClientConfigurationError("Calyx baseUrl must not contain userinfo, query, or fragment data.");
  }
  const basePath = value.pathname === "/" ? "" : value.pathname.replace(/\/$/, "");
  return { origin: value.origin, basePath };
}

function encodePathSegment(value: unknown): string {
  if (typeof value !== "string") {
    throw new CalyxClientConfigurationError("Every generated path parameter must serialize as a string.");
  }
  const text = value;
  if (text === "." || text === "..") {
    throw new CalyxClientConfigurationError("Pure dot path parameters cannot survive standards-compliant URL parsing.");
  }
  if (!isWellFormedUnicodeScalarText(text)) {
    throw new CalyxClientConfigurationError("Generated path parameters must contain well-formed Unicode scalar text.");
  }
  try {
    return encodeURIComponent(text).replaceAll(".", "%2E");
  } catch {
    throw new CalyxClientConfigurationError("Generated path parameter could not be encoded as one URL segment.");
  }
}

export function composeGeneratedOperationPath(
  plan: Pick<OperationPlan, "pathTemplate" | "pathParameterSerializers" | "requestTargetMaxBytes">,
  values: unknown,
): { readonly path: string; readonly parameters: Readonly<Record<string, unknown>> } {
  const pathValues = isRecord(values) ? values : {};
  const parameters: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const path = plan.pathTemplate.replaceAll(/\{([^}]+)\}/g, (_match, name: string) => {
    if (!Object.hasOwn(pathValues, name)) {
      throw new CalyxClientConfigurationError(`Missing path parameter ${name}.`);
    }
    const serializer = plan.pathParameterSerializers[name];
    if (!serializer) throw new CalyxClientConfigurationError(`Generated path parameter ${name} lacks a serializer.`);
    if (!Object.hasOwn(parameters, name)) {
      parameters[name] = serializer(pathValues[name], new WeakSet());
    }
    return encodePathSegment(parameters[name]);
  });
  if (textEncoder.encode(path).byteLength > plan.requestTargetMaxBytes) {
    throw new CalyxClientConfigurationError(
      `Encoded operation route exceeds ${plan.requestTargetMaxBytes} bytes.`,
    );
  }
  return { path, parameters: Object.freeze(parameters) };
}

function freezeGeneratedOperationRouteNode(value: unknown, seen: WeakSet<object>): void {
  if (
    (typeof value !== "object" || value === null)
    && typeof value !== "function"
  ) {
    return;
  }
  const node = value as object;
  if (seen.has(node)) return;
  seen.add(node);
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeGeneratedOperationRouteNode(child, seen);
  }
  Object.freeze(node);
}

export function freezeGeneratedOperationRoutes<T extends object>(routes: T): T {
  freezeGeneratedOperationRouteNode(routes, new WeakSet());
  return routes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAcyclic(value: unknown, active: WeakSet<object>): void {
  if (typeof value !== "object" || value === null) return;
  if (active.has(value)) throw new CalyxClientConfigurationError("Request data must not contain cycles.");
}

function serializeJsonMetadata(value: unknown, active: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CalyxClientConfigurationError("JSON metadata numbers must be finite.");
    return value;
  }
  if (Array.isArray(value)) {
    assertAcyclic(value, active);
    active.add(value);
    try {
      return value.map((item) => serializeJsonMetadata(item, active));
    } finally {
      active.delete(value);
    }
  }
  if (isRecord(value)) {
    assertAcyclic(value, active);
    active.add(value);
    try {
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(value).sort(utf8Compare)) {
        if (value[key] === undefined) continue;
        result[key] = serializeJsonMetadata(value[key], active);
      }
      return result;
    } finally {
      active.delete(value);
    }
  }
  throw new CalyxClientConfigurationError("JSON metadata contains an unsupported value.");
}

type GeneratedMatch = (
  value: unknown,
  numberLexemes: JsonNumberLexemes | undefined,
  numberLexeme: string | undefined,
) => boolean;

type GeneratedWireType = "array" | "boolean" | "integer" | "null" | "number" | "object" | "string";

function generatedWireTypeMatches(type: GeneratedWireType, value: unknown): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "null") return value === null;
  if (type === "object") return isRecord(value);
  return typeof value === type;
}

/**
 * Schema-agnostic primitives used by generated codec graphs. The compiler
 * resolves refs and OpenAPI vocabulary before emitting calls to these
 * functions; no schema document or runtime schema traversal reaches here.
 */
export const generatedCodec = Object.freeze({
  requestGuard(
    serialize: GeneratedRequestSerializer,
    nullable: boolean,
    enumValues: readonly unknown[] | undefined,
    hasConst: boolean,
    constValue: unknown,
  ): GeneratedRequestSerializer {
    return (value, active = new WeakSet()) => {
      if (value === undefined) return undefined;
      if (value === null) {
        if (nullable) return null;
        throw new CalyxClientConfigurationError("Request contains null where the contract does not allow it.");
      }
      if (enumValues !== undefined && !enumValues.includes(value)) {
        throw new CalyxClientConfigurationError("Request value is not a declared enum member.");
      }
      if (hasConst && value !== constValue) {
        throw new CalyxClientConfigurationError("Request value does not match the declared literal.");
      }
      return serialize(value, active);
    };
  },
  requestObject(
    properties: Readonly<Record<string, GeneratedRequestSerializer>>,
    requiredNames: readonly string[],
    additional: GeneratedRequestSerializer | "json" | undefined,
  ): GeneratedRequestSerializer {
    const required = new Set(requiredNames);
    return (value, active = new WeakSet()) => {
      if (!isRecord(value)) throw new CalyxClientConfigurationError("Request object has the wrong wire type.");
      assertAcyclic(value, active);
      active.add(value);
      try {
        const result = Object.create(null) as Record<string, unknown>;
        for (const key of Object.keys(properties).sort(utf8Compare)) {
          if (!Object.hasOwn(value, key)) {
            if (required.has(key)) throw new CalyxClientConfigurationError(`Request is missing required property ${key}.`);
            continue;
          }
          const serialized = properties[key]!(value[key], active);
          if (required.has(key) && serialized === undefined) {
            throw new CalyxClientConfigurationError(`Request is missing required property ${key}.`);
          }
          if (serialized !== undefined) result[key] = serialized;
        }
        if (additional !== undefined) {
          for (const key of Object.keys(value).sort(utf8Compare)) {
            if (Object.hasOwn(properties, key) || value[key] === undefined) continue;
            result[key] = additional === "json"
              ? serializeJsonMetadata(value[key], active)
              : additional(value[key], active);
          }
        }
        return result;
      } finally {
        active.delete(value);
      }
    };
  },
  requestArray(
    item: GeneratedRequestSerializer | readonly GeneratedRequestSerializer[],
    minimum: number | undefined,
    maximum: number | undefined,
  ): GeneratedRequestSerializer {
    return (value, active = new WeakSet()) => {
      if (!Array.isArray(value)) throw new CalyxClientConfigurationError("Request array has the wrong wire type.");
      if (minimum !== undefined && value.length < minimum) {
        throw new CalyxClientConfigurationError(`Request array must contain at least ${minimum} items.`);
      }
      if (maximum !== undefined && value.length > maximum) {
        throw new CalyxClientConfigurationError(`Request array must contain at most ${maximum} items.`);
      }
      if (value.some((entry) => entry === undefined)) {
        throw new CalyxClientConfigurationError("Request arrays must not contain undefined elements.");
      }
      assertAcyclic(value, active);
      active.add(value);
      try {
        return Array.isArray(item)
          ? value.map((entry, index) => item[index]!(entry, active))
          : value.map((entry) => (item as GeneratedRequestSerializer)(entry, active));
      } finally {
        active.delete(value);
      }
    };
  },
  requestNumber(
    integer: boolean,
    minimum: number | undefined,
    exclusiveMinimum: boolean,
    maximum: number | undefined,
    exclusiveMaximum: boolean,
  ): GeneratedRequestSerializer {
    return (value) => {
      const type = integer ? "integer" : "number";
      if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) {
        throw new CalyxClientConfigurationError(`Request value must be a finite ${type}.`);
      }
      if (minimum !== undefined && (exclusiveMinimum ? value <= minimum : value < minimum)) {
        throw new CalyxClientConfigurationError(`Request ${type} is below its declared minimum.`);
      }
      if (maximum !== undefined && (exclusiveMaximum ? value >= maximum : value > maximum)) {
        throw new CalyxClientConfigurationError(`Request ${type} is above its declared maximum.`);
      }
      return value;
    };
  },
  requestBoolean(): GeneratedRequestSerializer {
    return (value) => {
      if (typeof value !== "boolean") throw new CalyxClientConfigurationError("Request value must be boolean.");
      return value;
    };
  },
  requestNull(): GeneratedRequestSerializer {
    return (value) => {
      if (value !== null) throw new CalyxClientConfigurationError("Request value must be null.");
      return null;
    };
  },
  requestString(
    minimum: number | undefined,
    maximum: number | undefined,
    pattern: string | undefined,
    format: "date-time" | "uri" | undefined,
  ): GeneratedRequestSerializer {
    const expression = pattern === undefined ? undefined : new RegExp(pattern, "u");
    return (value) => {
      if (typeof value !== "string") throw new CalyxClientConfigurationError("Request value must be a string.");
      const length = [...value].length;
      if (minimum !== undefined && length < minimum) {
        throw new CalyxClientConfigurationError(`Request string must contain at least ${minimum} characters.`);
      }
      if (maximum !== undefined && length > maximum) {
        throw new CalyxClientConfigurationError(`Request string must contain at most ${maximum} characters.`);
      }
      if (expression !== undefined && !expression.test(value)) {
        throw new CalyxClientConfigurationError("Request string does not satisfy its declared pattern.");
      }
      if (!executableStringFormat(format, value)) {
        throw new CalyxClientConfigurationError("Request string does not satisfy its declared format.");
      }
      return value;
    };
  },
  requestUnion(
    branches: readonly { readonly serialize: GeneratedRequestSerializer; readonly wireType: GeneratedWireType }[],
    discriminator: { readonly property: string; readonly values: readonly unknown[] } | undefined,
  ): GeneratedRequestSerializer {
    return (value, active = new WeakSet()) => {
      let selected: GeneratedRequestSerializer | undefined;
      if (discriminator !== undefined && isRecord(value)) {
        const index = discriminator.values.findIndex((expected) => Object.is(value[discriminator.property], expected));
        if (index >= 0 && !discriminator.values.some((expected, candidate) => (
          candidate !== index && Object.is(value[discriminator.property], expected)
        ))) selected = branches[index]?.serialize;
      } else {
        const matching = branches.filter((branch) => generatedWireTypeMatches(branch.wireType, value));
        if (matching.length === 1) selected = matching[0]!.serialize;
      }
      if (!selected) {
        throw new CalyxClientConfigurationError("Request union requires exactly one declared discriminator branch.");
      }
      return selected(value, active);
    };
  },
  response(
    body: GeneratedMatch,
    nullable: boolean,
    not: GeneratedStructuralDecoder | undefined,
    allOf: readonly GeneratedStructuralDecoder[],
    oneOf: readonly GeneratedStructuralDecoder[],
    anyOf: readonly GeneratedStructuralDecoder[],
    hasConst: boolean,
    constValue: unknown,
    enumValues: readonly unknown[] | undefined,
    schemaVersions: readonly string[],
    contract?: ((value: unknown) => boolean) | undefined,
  ): GeneratedStructuralDecoder {
    return Object.freeze({
      schemaVersions: Object.freeze([...schemaVersions]),
      matches(
        value: unknown,
        numberLexemes?: JsonNumberLexemes,
        numberLexeme: string | undefined = numberLexemes?.root,
      ): boolean {
        if (nullable && value === null) return true;
        if (not?.matches(value, numberLexemes, numberLexeme)) return false;
        if (!allOf.every((decoder) => decoder.matches(value, numberLexemes, numberLexeme))) return false;
        if (oneOf.length > 0 && oneOf.filter((decoder) => decoder.matches(value, numberLexemes, numberLexeme)).length !== 1) {
          return false;
        }
        if (anyOf.length > 0 && !anyOf.some((decoder) => decoder.matches(value, numberLexemes, numberLexeme))) return false;
        if (!body(value, numberLexemes, numberLexeme)) return false;
        if (contract !== undefined && !contract(value)) return false;
        if (hasConst && !literalMatches(value, constValue, numberLexeme)) return false;
        return enumValues === undefined || enumValues.some((entry) => literalMatches(value, entry, numberLexeme));
      },
    });
  },
  responseAny(): GeneratedMatch {
    return () => true;
  },
  responseObject(
    properties: Readonly<Record<string, GeneratedStructuralDecoder>>,
    requiredNames: readonly string[],
    rejectUnknown: boolean,
    additional: GeneratedStructuralDecoder | undefined,
    contract: ((value: Record<string, unknown>) => boolean) | undefined,
  ): GeneratedMatch {
    return (value, numberLexemes) => {
      if (!isRecord(value) || requiredNames.some((name) => !Object.hasOwn(value, name))) return false;
      for (const [key, decoder] of Object.entries(properties)) {
        if (Object.hasOwn(value, key) && !decoder.matches(
          value[key],
          numberLexemes,
          numberLexemes?.byContainer.get(value)?.get(key),
        )) return false;
      }
      if (rejectUnknown && Object.keys(value).some((key) => !Object.hasOwn(properties, key))) return false;
      if (additional !== undefined) {
        for (const [key, child] of Object.entries(value)) {
          if (!Object.hasOwn(properties, key) && !additional.matches(
            child,
            numberLexemes,
            numberLexemes?.byContainer.get(value)?.get(key),
          )) return false;
        }
      }
      return contract?.(value) ?? true;
    };
  },
  responseArray(
    item: GeneratedStructuralDecoder | readonly GeneratedStructuralDecoder[],
    minimum: number | undefined,
    maximum: number | undefined,
  ): GeneratedMatch {
    return (value, numberLexemes) => {
      if (!Array.isArray(value)) return false;
      if (minimum !== undefined && value.length < minimum) return false;
      if (maximum !== undefined && value.length > maximum) return false;
      if (Array.isArray(item)) {
        return value.length >= item.length && item.every((decoder, index) => decoder.matches(
          value[index],
          numberLexemes,
          numberLexemes?.byContainer.get(value)?.get(String(index)),
        ));
      }
      return value.every((entry, index) => (item as GeneratedStructuralDecoder).matches(
        entry,
        numberLexemes,
        numberLexemes?.byContainer.get(value)?.get(String(index)),
      ));
    };
  },
  responseString(
    minimum: number | undefined,
    maximum: number | undefined,
    pattern: string | undefined,
    format: "date-time" | "uri" | undefined,
  ): GeneratedMatch {
    const expression = pattern === undefined ? undefined : new RegExp(pattern, "u");
    return (value) => typeof value === "string"
      && (minimum === undefined || [...value].length >= minimum)
      && (maximum === undefined || [...value].length <= maximum)
      && (expression === undefined || expression.test(value))
      && executableStringFormat(format, value);
  },
  responseNumber(
    integer: boolean,
    minimum: number | undefined,
    exclusiveMinimum: boolean,
    maximum: number | undefined,
    exclusiveMaximum: boolean,
  ): GeneratedMatch {
    return (value, _numberLexemes, numberLexeme) => typeof value === "number"
      && Number.isFinite(value)
      && (!integer || Number.isSafeInteger(value))
      && (!integer || numberLexeme === undefined || isExactSafeIntegerLexeme(numberLexeme, value))
      && (minimum === undefined || (exclusiveMinimum ? value > minimum : value >= minimum))
      && (maximum === undefined || (exclusiveMaximum ? value < maximum : value <= maximum));
  },
  responseBoolean(): GeneratedMatch {
    return (value) => typeof value === "boolean";
  },
  responseNull(): GeneratedMatch {
    return (value) => value === null;
  },
  header(decoder: GeneratedStructuralDecoder, wireType: "integer" | "string"): GeneratedHeaderDecoder {
    return (raw) => {
      const integer = Number(raw);
      const value = wireType === "integer"
        && /^(?:0|[1-9][0-9]*)$/u.test(raw)
        && Number.isSafeInteger(integer)
        ? integer
        : raw;
      return decoder.matches(value);
    };
  },
  valueAtPath,
  objectsAtPath,
});

function sortObject(value: Record<string, unknown>): Record<string, unknown> {
  const sorted = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort(utf8Compare)) sorted[key] = value[key];
  return sorted;
}

function buildQuery(serializer: GeneratedRequestSerializer, value: unknown): string {
  if (value === undefined) return "";
  const serialized = serializer(value, new WeakSet());
  if (!isRecord(serialized)) throw new CalyxClientConfigurationError("Query input must serialize to an object.");
  const entries: string[] = [];
  for (const key of Object.keys(serialized).sort(utf8Compare)) {
    const item = serialized[key];
    const values = Array.isArray(item) ? item : [item];
    for (const entry of values) {
      if (entry === undefined) continue;
      if (typeof entry === "object" && entry !== null) {
        throw new CalyxClientConfigurationError(`Query property ${key} is not scalar.`);
      }
      entries.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(entry))}`);
    }
  }
  return entries.length > 0 ? `?${entries.join("&")}` : "";
}

function parseJson(
  bytes: Uint8Array,
  duplicateMembers?: boolean,
):
  | { ok: true; value: unknown; numberLexemes: JsonNumberLexemes }
  | { ok: false; stage: CalyxProtocolFailure["stage"] } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, stage: "invalid_utf8" };
  }
  try {
    const parsed = parseJsonWithNumberLexemes(text);
    if (duplicateMembers ?? hasDuplicateJsonMembers(text)) return { ok: false, stage: "duplicate_json_member" };
    return { ok: true, ...parsed };
  } catch {
    return { ok: false, stage: "invalid_json" };
  }
}

function valueAtPath(value: unknown, path: string): unknown {
  if (path === "$" || path.length === 0) return value;
  return path.split(".").reduce<unknown>((current, segment) => (
    isRecord(current) ? current[segment] : undefined
  ), value);
}

function objectsAtPath(value: unknown, path: string): readonly Record<string, unknown>[] {
  if (path === "$") return isRecord(value) ? [value] : [];
  let current: unknown[] = [value];
  for (const rawSegment of path.split(".")) {
    const arraySegment = rawSegment.endsWith("[*]");
    const segment = arraySegment ? rawSegment.slice(0, -3) : rawSegment;
    const next: unknown[] = [];
    for (const candidate of current) {
      const child = isRecord(candidate) ? candidate[segment] : undefined;
      if (arraySegment) {
        if (Array.isArray(child)) next.push(...child);
      } else if (child !== undefined) next.push(child);
    }
    current = next;
  }
  return current.filter(isRecord);
}

// The generator rejects validation keywords outside this intentionally small
// runtime subset. Do not widen this matcher without widening that exact gate and
// its compiler/runtime regression tests in the same change.
function executableStringFormat(format: unknown, value: string): boolean {
  if (format === undefined) return true;
  if (format === "uri") {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }
  if (format !== "date-time") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?Z$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}

function isExactSafeIntegerLexeme(lexeme: string, value: number): boolean {
  return Number.isSafeInteger(value) && isExactJsonNumberLexeme(lexeme, value);
}

interface NormalizedJsonNumber {
  readonly negative: boolean;
  readonly digits: string;
  /** Base-10 exponent applied to `digits`. */
  readonly exponent: number;
}

function normalizeJsonNumberLexeme(lexeme: string): NormalizedJsonNumber | undefined {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(lexeme);
  if (!match) return undefined;
  const fraction = match[3] ?? "";
  let digits = `${match[2]}${fraction}`.replace(/^0+/u, "") || "0";
  if (digits === "0") return { negative: false, digits, exponent: 0 };
  const sourceExponent = match[4] === undefined ? 0 : Number(match[4]);
  if (!Number.isSafeInteger(sourceExponent)) return undefined;
  const trailingZeroCount = digits.length - digits.replace(/0+$/u, "").length;
  if (trailingZeroCount > 0) digits = digits.slice(0, -trailingZeroCount);
  const exponent = sourceExponent - fraction.length + trailingZeroCount;
  if (!Number.isSafeInteger(exponent)) return undefined;
  return { negative: match[1] === "-", digits, exponent };
}

function isExactJsonNumberLexeme(lexeme: string, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const observed = normalizeJsonNumberLexeme(lexeme);
  const expected = normalizeJsonNumberLexeme(String(value));
  return observed !== undefined
    && expected !== undefined
    && observed.negative === expected.negative
    && observed.digits === expected.digits
    && observed.exponent === expected.exponent;
}

function literalMatches(value: unknown, literal: unknown, numberLexeme: string | undefined): boolean {
  if (typeof value === "number" && typeof literal === "number") {
    return value === literal && (numberLexeme === undefined || isExactJsonNumberLexeme(numberLexeme, literal));
  }
  return value === literal;
}

function schemaMajorMismatch(decoder: GeneratedStructuralDecoder, value: unknown): boolean {
  if (!isRecord(value) || typeof value["schema_version"] !== "string") return false;
  return decoder.schemaVersions.length > 0 && !decoder.schemaVersions.includes(value["schema_version"]);
}

interface ParsedMediaType {
  readonly essence: string;
  readonly parameters: ReadonlyMap<string, string>;
}

function isHttpTokenCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || "!#$%&'*+-.^_`|~".includes(character);
}

function skipOptionalWhitespace(value: string, start: number): number {
  let cursor = start;
  while (value[cursor] === " " || value[cursor] === "\t") cursor += 1;
  return cursor;
}

function parseHttpToken(value: string, start: number): readonly [string, number] | undefined {
  let cursor = start;
  while (cursor < value.length && isHttpTokenCharacter(value[cursor]!)) cursor += 1;
  if (cursor === start) return undefined;
  return [value.slice(start, cursor), cursor];
}

function isQuotedTextCharacter(code: number): boolean {
  return code === 0x09
    || code === 0x20
    || code === 0x21
    || (code >= 0x23 && code <= 0x5b)
    || (code >= 0x5d && code <= 0x7e)
    || (code >= 0x80 && code <= 0xff);
}

function isQuotedPairCharacter(code: number): boolean {
  return code === 0x09 || code === 0x20 || (code >= 0x21 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
}

function parseQuotedString(value: string, start: number): readonly [string, number] | undefined {
  if (value[start] !== '"') return undefined;
  let decoded = "";
  let cursor = start + 1;
  while (cursor < value.length) {
    const character = value[cursor]!;
    if (character === '"') return [decoded, cursor + 1];
    if (character === "\\") {
      cursor += 1;
      if (cursor >= value.length || !isQuotedPairCharacter(value.charCodeAt(cursor))) return undefined;
      decoded += value[cursor]!;
      cursor += 1;
      continue;
    }
    if (!isQuotedTextCharacter(value.charCodeAt(cursor))) return undefined;
    decoded += character;
    cursor += 1;
  }
  return undefined;
}

function parseMediaType(value: string): ParsedMediaType | undefined {
  let cursor = skipOptionalWhitespace(value, 0);
  const type = parseHttpToken(value, cursor);
  if (!type || value[type[1]] !== "/") return undefined;
  const subtype = parseHttpToken(value, type[1] + 1);
  if (!subtype) return undefined;
  cursor = subtype[1];
  const parameters = new Map<string, string>();
  while (true) {
    cursor = skipOptionalWhitespace(value, cursor);
    if (cursor === value.length) {
      return {
        essence: `${type[0].toLowerCase()}/${subtype[0].toLowerCase()}`,
        parameters,
      };
    }
    if (value[cursor] !== ";") return undefined;
    cursor = skipOptionalWhitespace(value, cursor + 1);
    const name = parseHttpToken(value, cursor);
    if (!name || value[name[1]] !== "=") return undefined;
    const normalizedName = name[0].toLowerCase();
    if (parameters.has(normalizedName)) return undefined;
    cursor = name[1] + 1;
    const quotedValue = parseQuotedString(value, cursor);
    const tokenValue = quotedValue ?? parseHttpToken(value, cursor);
    if (!tokenValue) return undefined;
    parameters.set(normalizedName, tokenValue[0]);
    cursor = tokenValue[1];
  }
}

function mediaParameterMatches(name: string, actual: string, expected: string): boolean {
  return name === "charset"
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
}

function responseMediaMatches(actual: string | null, expected: string | null): boolean {
  if (!actual || !expected) return false;
  const parsedActual = parseMediaType(actual);
  const parsedExpected = parseMediaType(expected);
  if (!parsedActual || !parsedExpected || parsedActual.essence !== parsedExpected.essence) return false;
  for (const [name, expectedValue] of parsedExpected.parameters) {
    const actualValue = parsedActual.parameters.get(name);
    if (actualValue === undefined || !mediaParameterMatches(name, actualValue, expectedValue)) return false;
  }
  return true;
}

function invalidHeaderAgainstDecoders(
  response: Response,
  decoders: Readonly<Record<string, GeneratedHeaderDecoder>>,
): string | undefined {
  for (const [name, decoder] of Object.entries(decoders)) {
    const raw = response.headers.get(name);
    if (raw === null) continue;
    if (!decoder(raw)) return name;
  }
  return undefined;
}

class ResponseBodyContractError extends Error {
  constructor(
    readonly stage: "invalid_response" | "response_too_large" | "custody_mismatch",
    message: string,
    readonly bodyObservation?: ProtocolBodyObservation,
  ) {
    super(message);
  }
}

interface ProtocolBodyObservation {
  readonly prefix: Uint8Array;
  readonly observedBytes: number;
  readonly complete: boolean;
}

interface ProtocolBodyObservationState {
  readonly prefix: Uint8Array;
  prefixLength: number;
  observedBytes: number;
}

function createProtocolBodyObservationState(): ProtocolBodyObservationState {
  return {
    prefix: new Uint8Array(CALYX_PROTOCOL_BODY_SNIPPET_MAX_BYTES),
    prefixLength: 0,
    observedBytes: 0,
  };
}

function observeProtocolBodyChunk(state: ProtocolBodyObservationState, chunk: Uint8Array): void {
  state.observedBytes += chunk.byteLength;
  const remaining = state.prefix.byteLength - state.prefixLength;
  if (remaining <= 0) return;
  const retained = chunk.subarray(0, remaining);
  state.prefix.set(retained, state.prefixLength);
  state.prefixLength += retained.byteLength;
}

function finishProtocolBodyObservation(
  state: ProtocolBodyObservationState,
  complete: boolean,
): ProtocolBodyObservation {
  return Object.freeze({
    prefix: state.prefix.slice(0, state.prefixLength),
    observedBytes: state.observedBytes,
    complete,
  });
}

function protocolBodyObservationFromBytes(bytes: Uint8Array): ProtocolBodyObservation {
  return Object.freeze({
    prefix: bytes.slice(0, CALYX_PROTOCOL_BODY_SNIPPET_MAX_BYTES),
    observedBytes: bytes.byteLength,
    complete: true,
  });
}

function unavailableProtocolBodyObservation(response: Response): ProtocolBodyObservation {
  return Object.freeze({
    prefix: new Uint8Array(),
    observedBytes: 0,
    complete: response.body === null,
  });
}

const PROTOCOL_BODY_OBSERVATION_DEADLINE = Symbol("protocol-body-observation-deadline");

async function observeRejectedProtocolBody(response: Response): Promise<ProtocolBodyObservation> {
  if (response.body === null) return protocolBodyObservationFromBytes(new Uint8Array());
  if (response.bodyUsed || response.body.locked) return unavailableProtocolBodyObservation(response);
  const reader = response.body.getReader();
  const state = createProtocolBodyObservationState();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof PROTOCOL_BODY_OBSERVATION_DEADLINE>((resolve) => {
    timeout = setTimeout(() => resolve(PROTOCOL_BODY_OBSERVATION_DEADLINE), CALYX_PROTOCOL_BODY_OBSERVATION_DEADLINE_MS);
  });
  try {
    while (state.observedBytes < CALYX_PROTOCOL_BODY_OBSERVATION_MAX_BYTES) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === PROTOCOL_BODY_OBSERVATION_DEADLINE) {
        await reader.cancel("protocol evidence sampling deadline reached").catch(() => undefined);
        return finishProtocolBodyObservation(state, false);
      }
      if (next.done) return finishProtocolBodyObservation(state, true);
      observeProtocolBodyChunk(state, next.value);
    }
    await reader.cancel("protocol evidence observation limit reached").catch(() => undefined);
    return finishProtocolBodyObservation(state, false);
  } catch {
    await reader.cancel("protocol evidence body read failed").catch(() => undefined);
    return finishProtocolBodyObservation(state, false);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    try {
      reader.releaseLock();
    } catch {
      // Cancellation or a terminal read may already have released the reader.
    }
  }
}

function declaredContentLength(response: Response, maximum: number): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new ResponseBodyContractError("invalid_response", "Response Content-Length is not a canonical non-negative integer.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new ResponseBodyContractError("invalid_response", "Response Content-Length exceeds the safe integer range.");
  }
  if (value > maximum) {
    throw new ResponseBodyContractError("response_too_large", `Response declares ${value} bytes above its ${maximum}-byte contract.`);
  }
  return value;
}

async function readBoundedResponseBody(
  response: Response,
  maximum: number,
  inspectChunk?: (chunk: Uint8Array) => Promise<void> | void,
): Promise<{ readonly bytes: Uint8Array; readonly observation: ProtocolBodyObservation }> {
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw new CalyxClientConfigurationError("Generated response body limit is invalid.");
  }
  try {
    declaredContentLength(response, maximum);
  } catch (error: unknown) {
    await response.body?.cancel(error).catch(() => undefined);
    if (error instanceof ResponseBodyContractError) {
      throw new ResponseBodyContractError(
        error.stage,
        error.message,
        unavailableProtocolBodyObservation(response),
      );
    }
    throw error;
  }
  if (!response.body) {
    const bytes = new Uint8Array();
    return { bytes, observation: protocolBodyObservationFromBytes(bytes) };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const observationState = createProtocolBodyObservationState();
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      observeProtocolBodyChunk(observationState, chunk.value);
      if (total > maximum) {
        await reader.cancel("response body limit exceeded").catch(() => undefined);
        throw new ResponseBodyContractError(
          "response_too_large",
          `Response exceeds its ${maximum}-byte contract.`,
          finishProtocolBodyObservation(observationState, false),
        );
      }
      await inspectChunk?.(chunk.value);
      chunks.push(chunk.value);
    }
  } catch (error: unknown) {
    await reader.cancel(error).catch(() => undefined);
    if (error instanceof ResponseBodyContractError) throw error;
    throw new ResponseBodyContractError(
      "invalid_response",
      error instanceof Error ? error.message : "Response body read failed.",
      finishProtocolBodyObservation(observationState, false),
    );
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, observation: finishProtocolBodyObservation(observationState, true) };
}

interface BoundedJsonBody {
  readonly bytes: Uint8Array;
  readonly duplicateMembers: boolean;
  readonly observation: ProtocolBodyObservation;
}

const JSON_SCAN_BYTE_QUANTUM = 256 * 1024;

async function readBoundedJsonResponseBody(response: Response, maximum: number): Promise<BoundedJsonBody> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const scanner = new DuplicateJsonMemberScanner();
  let duplicateMembers = false;
  let decoderFailed = false;
  let scanBytesRemaining = JSON_SCAN_BYTE_QUANTUM;
  const inspectChunk = async (chunk: Uint8Array): Promise<void> => {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (scanBytesRemaining === 0) {
        await scheduler.yield();
        scanBytesRemaining = JSON_SCAN_BYTE_QUANTUM;
      }
      const end = Math.min(chunk.byteLength, offset + scanBytesRemaining);
      const part = chunk.subarray(offset, end);
      if (!decoderFailed && !duplicateMembers) {
        try {
          duplicateMembers = scanner.write(decoder.decode(part, { stream: true }));
        } catch {
          // parseJson remains the UTF-8 and JSON syntax authority.
          decoderFailed = true;
        }
      }
      scanBytesRemaining -= part.byteLength;
      offset = end;
    }
  };
  const bounded = await readBoundedResponseBody(response, maximum, inspectChunk);
  const { bytes } = bounded;
  if (!decoderFailed && !duplicateMembers) {
    try {
      duplicateMembers = scanner.write(decoder.decode());
    } catch {
      // parseJson reports invalid_utf8 after the bounded read.
    }
  }
  return { bytes, duplicateMembers, observation: bounded.observation };
}

function verifiedBinaryBody(
  source: ReadableStream<Uint8Array>,
  maximum: number,
  contentLength: number,
  expectedDigest: string,
): { body: ReadableStream<Uint8Array>; verified: Promise<void> } {
  const reader = source.getReader();
  const hash = createHash("sha256");
  let total = 0;
  let settled = false;
  let resolveVerified!: () => void;
  let rejectVerified!: (error: Error) => void;
  const verified = new Promise<void>((resolve, reject) => {
    resolveVerified = resolve;
    rejectVerified = reject;
  });
  // Consumers may rely solely on the stream error; keep the companion promise from becoming unhandled.
  void verified.catch(() => undefined);
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    rejectVerified(error);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          if (total !== contentLength) {
            throw new ResponseBodyContractError("custody_mismatch", "Attachment body length does not match Content-Length.");
          }
          const observedDigest = `sha-256=${hash.digest("base64")}`;
          if (observedDigest !== expectedDigest) {
            throw new ResponseBodyContractError("custody_mismatch", "Attachment body digest does not match the custody headers.");
          }
          settled = true;
          resolveVerified();
          controller.close();
          reader.releaseLock();
          return;
        }
        total += chunk.value.byteLength;
        if (total > maximum || total > contentLength) {
          await reader.cancel("attachment custody limit exceeded").catch(() => undefined);
          throw new ResponseBodyContractError("response_too_large", "Attachment body exceeds its declared custody bound.");
        }
        hash.update(chunk.value);
        controller.enqueue(chunk.value);
      } catch (error: unknown) {
        const failure = error instanceof Error ? error : new Error("Attachment body verification failed.");
        fail(failure);
        controller.error(failure);
        try {
          reader.releaseLock();
        } catch {
          // The reader may already have released after a terminal read.
        }
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        // Cancellation may race a terminal read.
      }
      fail(new Error("Attachment body was cancelled before custody verification completed."));
    },
  });
  return { body, verified };
}

const SAFE_PROTOCOL_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "retry-after",
  "server",
  "via",
  "x-request-id",
] as const;
const SAFE_PROTOCOL_RESPONSE_HEADER_VALUE_MAX_BYTES = 512;
const SAFE_PROTOCOL_RESPONSE_HEADERS_MAX_BYTES = 2 * 1024;

function safeProtocolResponseHeaders(
  response: Response,
  validatedRequestId: string | null | undefined,
): Readonly<Record<string, string>> {
  const result = Object.create(null) as Record<string, string>;
  let retainedBytes = 0;
  const retain = (name: string, value: string | null): void => {
    if (value === null || value.length === 0 || !/^[\x20-\x7e]+$/u.test(value)) return;
    const bytes = Buffer.byteLength(name, "ascii") + Buffer.byteLength(value, "ascii");
    if (
      Buffer.byteLength(value, "ascii") > SAFE_PROTOCOL_RESPONSE_HEADER_VALUE_MAX_BYTES
      || retainedBytes + bytes > SAFE_PROTOCOL_RESPONSE_HEADERS_MAX_BYTES
    ) return;
    result[name] = value;
    retainedBytes += bytes;
  };
  for (const name of SAFE_PROTOCOL_RESPONSE_HEADERS) retain(name, response.headers.get(name));
  if (validatedRequestId) retain("x-calyx-request-id", validatedRequestId);
  return Object.freeze(result);
}

function protocolFailure(
  stage: CalyxProtocolFailure["stage"],
  message: string,
  response: Response,
  attempts: number,
  requestIdOverride?: string | null,
  bodyObservation: ProtocolBodyObservation = unavailableProtocolBodyObservation(response),
): CalyxProtocolFailure {
  const requestId = requestIdOverride === undefined
    ? response.headers.get("x-calyx-request-id")
    : requestIdOverride;
  return {
    ok: false,
    kind: "protocol",
    stage,
    message,
    status: response.status,
    ...(requestId ? { requestId } : {}),
    attempts,
    rawBodySnippet: new TextDecoder("utf-8").decode(bodyObservation.prefix),
    rawBodyBytes: bodyObservation.observedBytes,
    rawBodyComplete: bodyObservation.complete,
    responseHeaders: safeProtocolResponseHeaders(response, requestId),
  };
}

async function rejectProtocolResponse(
  stage: CalyxProtocolFailure["stage"],
  message: string,
  response: Response,
  attempts: number,
  requestIdOverride?: string | null,
): Promise<CalyxProtocolFailure> {
  const bodyObservation = await observeRejectedProtocolBody(response);
  return protocolFailure(stage, message, response, attempts, requestIdOverride, bodyObservation);
}

async function cancelResponseBody(response: Response, reason: string): Promise<void> {
  await response.body?.cancel(reason).catch(() => undefined);
}

async function rejectResponseWithError(response: Response, message: string): Promise<never> {
  await cancelResponseBody(response, message);
  throw new Error(message);
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function isWellFormedUnicodeScalarText(value: string): boolean {
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

function exceedsCodePointLength(value: string, maximum: number): boolean {
  let length = 0;
  for (let offset = 0; offset < value.length;) {
    const codePoint = value.codePointAt(offset)!;
    offset += codePoint > 0xffff ? 2 : 1;
    length += 1;
    if (length > maximum) return true;
  }
  return false;
}

function validLastEventId(value: string, maximum: number, pattern: string | undefined): boolean {
  return value.length > 0
    && !exceedsCodePointLength(value, maximum)
    && !containsControlCharacter(value)
    && (pattern === undefined || new RegExp(pattern, "u").test(value));
}

function bearerTokenValidator(contract: CalyxBearerTokenContract): (value: string) => string {
  const encoding = contract.encoding;
  const maxBytes = contract.max_bytes;
  const patternSource = contract.pattern;
  if (
    encoding !== "ascii"
    || !Number.isSafeInteger(maxBytes)
    || maxBytes <= 0
    || typeof patternSource !== "string"
    || patternSource.length === 0
  ) {
    throw new CalyxClientConfigurationError("Generated bearer-token contract is invalid.");
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(patternSource, "u");
  } catch {
    throw new CalyxClientConfigurationError("Generated bearer-token contract pattern is invalid.");
  }
  return (value: string): string => {
    if (Buffer.byteLength(value, "utf8") > maxBytes || !pattern.test(value)) {
      throw new CalyxClientConfigurationError(
        "Bearer token provider returned material outside the generated receiver contract.",
      );
    }
    return value;
  };
}

const TOKEN_RESOLUTION_ABORTED = Symbol("token_resolution_aborted");

async function resolveToken(
  provider: TokenProvider,
  signal: AbortSignal | undefined,
  validate: (value: string) => string,
): Promise<string | typeof TOKEN_RESOLUTION_ABORTED> {
  if (signal?.aborted) return TOKEN_RESOLUTION_ABORTED;
  const resolution = Promise.resolve().then(() => provider(signal)).then(validate);
  if (!signal) return resolution;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof TOKEN_RESOLUTION_ABORTED>((resolve) => {
    onAbort = () => resolve(TOKEN_RESOLUTION_ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([resolution, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort!);
  }
}

function retryAuthorityValue(value: unknown, authority: OperationRetryAuthority | undefined): string | undefined {
  if (!authority || authority.kind !== "request_body_field") return undefined;
  if (!isRecord(value) || !Object.hasOwn(value, authority.field)) {
    throw new CalyxClientConfigurationError("Generated retry authority selected an absent request-body field.");
  }
  const key = value[authority.field];
  if (typeof key !== "string" || key.length === 0) {
    throw new CalyxClientConfigurationError("Generated retry authority selected an invalid request-body field.");
  }
  return key;
}

function validateRetryOption(
  name: string,
  value: unknown,
  allowed: readonly number[],
  fallback: number,
): number {
  const resolved = value ?? fallback;
  if (
    typeof resolved !== "number"
    || !Number.isSafeInteger(resolved)
    || !allowed.includes(resolved)
  ) {
    throw new CalyxClientConfigurationError(
      `${name} must be one of ${allowed.join(", ")}.`,
    );
  }
  return resolved;
}

type UnsignedCalyxIndeterminateReceipt = Omit<
  CalyxIndeterminateReceipt,
  "integrity_algorithm" | "integrity_tag"
>;

const RECOVERY_RECEIPT_INTEGRITY_ALGORITHM = "HMAC-SHA-256" as const;
const RECOVERY_RECEIPT_INTEGRITY_KEY_BYTES = 32;
const RECOVERY_RECEIPT_KEYS = new Set([
  "schema_version",
  "payload_sensitivity",
  "integrity_algorithm",
  "integrity_tag",
  "credential_binding",
  "contract_digest",
  "operation_id",
  "method",
  "origin",
  "base_path",
  "path",
  "safe_headers",
  "body_bytes",
  "idempotency_key",
  "attempts",
  "failure_stage",
  "last_http_status",
  "last_request_id",
]);

function recoveryReceiptIntegrityPayload(receipt: UnsignedCalyxIndeterminateReceipt): string {
  return JSON.stringify([
    "calyx.client-recovery-receipt-integrity/v1",
    receipt.schema_version,
    receipt.payload_sensitivity,
    receipt.credential_binding,
    receipt.contract_digest,
    receipt.operation_id,
    receipt.method,
    receipt.origin,
    receipt.base_path,
    receipt.path,
    Object.entries(receipt.safe_headers).sort(([left], [right]) => utf8Compare(left, right)),
    receipt.body_bytes,
    receipt.idempotency_key,
    receipt.attempts,
    receipt.failure_stage,
    receipt.last_http_status ?? null,
    receipt.last_request_id ?? null,
  ]);
}

function recoveryReceiptIntegrityTag(
  key: Uint8Array,
  receipt: UnsignedCalyxIndeterminateReceipt,
): string {
  return createHmac("sha256", key)
    .update(recoveryReceiptIntegrityPayload(receipt), "utf8")
    .digest("base64url");
}

function recoveryCredentialBinding(key: Uint8Array, token: string): string {
  return createHmac("sha256", key)
    .update("calyx.client-recovery-credential/v1\0", "utf8")
    .update(token, "utf8")
    .digest("base64url");
}

function authenticatedBindingMatches(expected: string, candidate: string): boolean {
  const expectedBytes = Buffer.from(expected, "base64url");
  const candidateBytes = Buffer.from(candidate, "base64url");
  return expectedBytes.byteLength === candidateBytes.byteLength
    && expectedBytes.toString("base64url") === expected
    && candidateBytes.toString("base64url") === candidate
    && timingSafeEqual(expectedBytes, candidateBytes);
}

export class CalyxTransport {
  private readonly base: NormalizedBaseUrl;
  private readonly fetchImplementation: typeof fetch;
  private readonly maxAttempts: number;
  private readonly recoveryAttempts: number;
  private readonly sseReconnectAttempts: number;
  private readonly tokenProvider: TokenProvider;
  private readonly previousTokenProvider: TokenProvider | undefined;
  private readonly recoveryReceiptIntegrityKey: Uint8Array;
  private readonly validateBearerToken: (value: string) => string;

  constructor(
    options: CalyxClientOptions,
    private readonly operations: Readonly<Record<string, OperationPlan>>,
    bearerTokenContract: CalyxBearerTokenContract,
  ) {
    this.base = normalizeBaseUrl(options.baseUrl);
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (!this.fetchImplementation) throw new CalyxClientConfigurationError("A fetch implementation is required.");
    this.maxAttempts = validateRetryOption("retry.maxAttempts", options.retry?.maxAttempts, [1, 2], 2);
    this.recoveryAttempts = validateRetryOption("retry.recoveryAttempts", options.retry?.recoveryAttempts, [1, 2, 3], 2);
    this.sseReconnectAttempts = validateRetryOption(
      "retry.sseReconnectAttempts",
      options.retry?.sseReconnectAttempts,
      [0, 1, 2, 3],
      2,
    );
    this.tokenProvider = typeof options.bearerToken === "function" ? options.bearerToken : () => options.bearerToken as string;
    this.previousTokenProvider = options.previousBearerToken === undefined
      ? undefined
      : typeof options.previousBearerToken === "function"
        ? options.previousBearerToken
      : () => options.previousBearerToken as string;
    this.validateBearerToken = bearerTokenValidator(bearerTokenContract);
    if (options.recoveryStore !== undefined && options.recoveryStore.custody !== "encrypted_access_controlled") {
      throw new CalyxClientConfigurationError(
        "recoveryStore must declare encrypted_access_controlled custody for sensitive replay receipts.",
      );
    }
    if (
      options.recoveryStore !== undefined
      && (
        typeof options.recoveryStore.reserve !== "function"
        || typeof options.recoveryStore.save !== "function"
        || typeof options.recoveryStore.release !== "function"
      )
    ) {
      throw new CalyxClientConfigurationError(
        "recoveryStore must implement reserve, save, and release so keyed writes cannot dispatch without durable replay authority.",
      );
    }
    if (
      options.recoveryReceiptIntegrityKey !== undefined
      && (
        !(options.recoveryReceiptIntegrityKey instanceof Uint8Array)
        || options.recoveryReceiptIntegrityKey.byteLength !== RECOVERY_RECEIPT_INTEGRITY_KEY_BYTES
      )
    ) {
      throw new CalyxClientConfigurationError(
        `recoveryReceiptIntegrityKey must contain exactly ${RECOVERY_RECEIPT_INTEGRITY_KEY_BYTES} bytes.`,
      );
    }
    if (options.recoveryStore !== undefined && options.recoveryReceiptIntegrityKey === undefined) {
      throw new CalyxClientConfigurationError(
        "recoveryStore requires a protected recoveryReceiptIntegrityKey so persisted receipts remain authenticated after restart.",
      );
    }
    this.recoveryReceiptIntegrityKey = options.recoveryReceiptIntegrityKey === undefined
      ? randomBytes(RECOVERY_RECEIPT_INTEGRITY_KEY_BYTES)
      : Uint8Array.from(options.recoveryReceiptIntegrityKey);
    this.recoveryStore = options.recoveryStore;
    for (const plan of Object.values(operations)) {
      if (
        (plan.surface === "consumer" && plan.profile !== "consumer_v1")
        || (plan.profile === "control_plane_admin_v1" && plan.surface !== "admin")
      ) {
        throw new CalyxClientConfigurationError(
          `Generated operation ${plan.operationId} contradicts its ${plan.surface}/${plan.profile} projection authority.`,
        );
      }
      if (plan.queryRequired === true && plan.method !== "GET" && plan.method !== "HEAD") {
        throw new CalyxClientConfigurationError(
          `Generated operation ${plan.operationId} requires query input on a body-only method.`,
        );
      }
      const retryableMutation = plan.success.some((success) => (
        success.semantics["mutation"] === "idempotent_write" || success.semantics["mutation"] === "submit"
      ));
      if (plan.retryAuthority === undefined && retryableMutation) {
        throw new CalyxClientConfigurationError(
          `Generated operation ${plan.operationId} declares retryable mutation semantics without retry authority.`,
        );
      }
      if (plan.retryAuthority !== undefined && (
        (
          plan.retryAuthority.kind === "request_body_field"
          && (
            !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(plan.retryAuthority.field)
            || plan.requestBody !== "json"
            || plan.success.some((success) => !["idempotent_write", "submit"].includes(String(success.semantics["mutation"])))
          )
        )
        || (
          plan.retryAuthority.kind === "operation_identity"
          && (
            plan.method !== "POST"
            || plan.requestBody !== "none"
            || plan.success.some((success) => success.semantics["mutation"] !== "idempotent_write")
          )
        )
        || (
          plan.retryAuthority.kind === "request_target_identity"
          && (
            plan.method !== "DELETE"
            || plan.requestBody !== "none"
            || Object.keys(plan.pathParameterSerializers).length === 0
            || plan.success.some((success) => success.semantics["mutation"] !== "idempotent_write")
            || plan.success.some((success) => success.representation !== "json")
          )
        )
        || !["request_body_field", "operation_identity", "request_target_identity"].includes(plan.retryAuthority.kind)
      )) {
        throw new CalyxClientConfigurationError(
          `Generated operation ${plan.operationId} carries invalid retry authority.`,
        );
      }
      if (
        plan.lastEventIdAllowed === true
        && (!Number.isSafeInteger(plan.lastEventIdMaxLength) || plan.lastEventIdMaxLength! <= 0)
      ) {
        throw new CalyxClientConfigurationError(
          `Generated operation ${plan.operationId} lacks a finite Last-Event-ID bound.`,
        );
      }
      if (!Number.isSafeInteger(plan.requestTargetMaxBytes) || plan.requestTargetMaxBytes <= 0) {
        throw new CalyxClientConfigurationError(
          `Generated operation ${plan.operationId} lacks a finite request-target bound.`,
        );
      }
      if (typeof plan.requestIdHeaderDecoder !== "function") {
        throw new CalyxClientConfigurationError(
          `Generated operation ${plan.operationId} lacks a cross-status request-id schema.`,
        );
      }
      if (
        typeof plan.errorEnvelopeDecoder?.matches !== "function"
        || !isRecord(plan.errorDecoders)
        || Object.keys(plan.errorCodes).some((status) => typeof plan.errorDecoders[status]?.matches !== "function")
      ) {
        throw new CalyxClientConfigurationError(
          `Generated operation ${plan.operationId} lacks complete error-envelope schemas.`,
        );
      }
      for (const success of plan.success) {
        if (
          !isRecord(success.headerDecoders)
          || success.requiredHeaders.some((header) => !Object.hasOwn(success.headerDecoders, header))
        ) {
          throw new CalyxClientConfigurationError(
            `Generated operation ${plan.operationId} lacks complete success-header schemas.`,
          );
        }
        if (
          (success.representation === "json" || success.representation === "bytes" || success.representation === "head")
          && (!Number.isSafeInteger(success.maxBytes) || success.maxBytes! <= 0)
        ) {
          throw new CalyxClientConfigurationError(`Generated operation ${plan.operationId} lacks a finite success body bound.`);
        }
        if (
          success.representation === "sse"
          && (!Number.isSafeInteger(success.maxFrameBytes) || success.maxFrameBytes! <= 0)
        ) {
          throw new CalyxClientConfigurationError(`Generated operation ${plan.operationId} lacks a finite SSE frame bound.`);
        }
        if (success.representation === "sse" && (!success.cursorField || success.cursorField.length === 0)) {
          throw new CalyxClientConfigurationError(`Generated operation ${plan.operationId} lacks an SSE cursor correspondence field.`);
        }
      }
    }
  }

  private readonly recoveryStore: CalyxRecoveryStore | undefined;

  async execute<T, Code extends string = string>(
    surface: string,
    plan: OperationPlan,
    request: OperationRequest = {},
  ): Promise<CalyxResult<T | CalyxEventStream<T>, Code>> {
    if (surface !== plan.surface) {
      throw new CalyxClientConfigurationError(
        `Generated operation ${plan.operationId} cannot execute through the ${surface} schema surface.`,
      );
    }
    const unboundPrepared = this.prepare(plan, request);
    if (unboundPrepared.signal?.aborted) {
      return { ok: false, kind: "transport", stage: "aborted", message: "Request was aborted by the caller.", attempts: 1 };
    }
    let bearerToken: string | typeof TOKEN_RESOLUTION_ABORTED;
    try {
      bearerToken = await resolveToken(this.tokenProvider, unboundPrepared.signal, this.validateBearerToken);
    } catch (error: unknown) {
      if (error instanceof CalyxClientConfigurationError) throw error;
      return { ok: false, kind: "transport", stage: "token", message: "Bearer token resolution failed.", attempts: 1 };
    }
    if (bearerToken === TOKEN_RESOLUTION_ABORTED) {
      return { ok: false, kind: "transport", stage: "aborted", message: "Request was aborted by the caller.", attempts: 1 };
    }
    const prepared = Object.freeze({
      ...unboundPrepared,
      credential: Object.freeze({
        bearerToken,
        recoveryBinding: recoveryCredentialBinding(this.recoveryReceiptIntegrityKey, bearerToken),
      }),
    });
    const reconciliationOperationIds = unkeyedWriteReconciliationOperations(plan);
    let dispatchAttempted = false;
    const executePrepared = async (): Promise<CalyxResult<T | CalyxEventStream<T>, Code>> => {
    const ordinaryEligible = plan.method === "GET"
      || plan.method === "HEAD"
      || prepared.idempotencyKey !== undefined
      || plan.retryAuthority?.kind === "operation_identity"
      || plan.retryAuthority?.kind === "request_target_identity";
    const hasConvergentRetry = plan.retryAuthority?.kind === "operation_identity"
      || plan.retryAuthority?.kind === "request_target_identity";
    let keyedWriteAmbiguous = false;
    let ambiguousAuthority: ResponseAuthority | undefined;
    let attempts = 0;
    attemptLoop: while (attempts < this.maxAttempts) {
      attempts += 1;
      if (prepared.signal?.aborted) {
        if (keyedWriteAmbiguous) {
          return this.recordIndeterminate(
            plan,
            prepared,
            attempts,
            "aborted_after_ambiguous_dispatch",
            ambiguousAuthority,
          );
        }
        return { ok: false, kind: "transport", stage: "aborted", message: "Request was aborted by the caller.", attempts };
      }
      let response: Response;
      try {
        // Once fetch owns the request, a rejection or caller abort cannot prove
        // that an unkeyed stateful write was not admitted by the daemon.
        dispatchAttempted = true;
        response = await this.fetchImplementation(prepared.url, {
          method: plan.method,
          headers: { ...prepared.headers, Authorization: `Bearer ${prepared.credential.bearerToken}` },
          ...(prepared.bodyBytes ? { body: prepared.bodyBytes } : {}),
          redirect: "manual",
          ...(prepared.signal ? { signal: prepared.signal } : {}),
        });
      } catch {
        if (prepared.signal?.aborted) {
          if (prepared.idempotencyKey) {
            return this.recordIndeterminate(
              plan,
              prepared,
              attempts,
              "aborted_after_ambiguous_dispatch",
              ambiguousAuthority,
            );
          }
          return { ok: false, kind: "transport", stage: "aborted", message: "Request was aborted by the caller.", attempts };
        }
        if (prepared.idempotencyKey) keyedWriteAmbiguous = true;
        if (ordinaryEligible && attempts < this.maxAttempts) continue;
        if (prepared.idempotencyKey) {
          return this.recover<T, Code>(
            surface,
            plan,
            prepared,
            attempts,
            "network",
            ambiguousAuthority,
          );
        }
        return {
          ok: false,
          kind: "transport",
          stage: "network",
          message: "Network request failed before response headers.",
          attempts,
        };
      }
      if (response.status >= 300 && response.status < 400) {
        const candidateRequestId = response.headers.get("x-calyx-request-id");
        const validatedRequestId = candidateRequestId !== null
          && invalidHeaderAgainstDecoders(
            response,
            { "x-calyx-request-id": plan.requestIdHeaderDecoder },
          ) === undefined
          ? candidateRequestId
          : undefined;
        if (prepared.idempotencyKey) {
          await cancelResponseBody(response, "Calyx refused a redirect for a keyed write.");
          return this.recover<T, Code>(
            surface,
            plan,
            prepared,
            attempts,
            "redirect_refused",
            validatedRequestId
              ? { status: response.status, requestId: validatedRequestId }
              : ambiguousAuthority,
          );
        }
        if (hasConvergentRetry && attempts < this.maxAttempts) {
          await cancelResponseBody(response, "Convergent-operation response was a redirect; repeating it without following the redirect.");
          continue attemptLoop;
        }
        return rejectProtocolResponse(
          "redirect_refused",
          "Calyx refuses redirects before forwarding bearer credentials.",
          response,
          attempts,
          validatedRequestId ?? null,
        );
      }
      const requestId = response.headers.get("x-calyx-request-id");
      if (!requestId) {
        if (prepared.idempotencyKey) {
          await cancelResponseBody(response, "Keyed-write response omitted X-Calyx-Request-Id.");
          return this.recover<T, Code>(
            surface,
            plan,
            prepared,
            attempts,
            "missing_required_header",
            ambiguousAuthority,
          );
        }
        if (hasConvergentRetry && attempts < this.maxAttempts) {
          await cancelResponseBody(response, "Convergent-operation response omitted X-Calyx-Request-Id; repeating the operation.");
          continue attemptLoop;
        }
        return rejectProtocolResponse(
          "missing_required_header",
          "Response omitted X-Calyx-Request-Id.",
          response,
          attempts,
        );
      }
      const invalidRequestId = invalidHeaderAgainstDecoders(
        response,
        { "x-calyx-request-id": plan.requestIdHeaderDecoder },
      );
      if (invalidRequestId) {
        if (prepared.idempotencyKey) {
          await cancelResponseBody(response, "Keyed-write response carried an invalid X-Calyx-Request-Id.");
          return this.recover<T, Code>(
            surface,
            plan,
            prepared,
            attempts,
            "invalid_response",
            ambiguousAuthority,
          );
        }
        if (hasConvergentRetry && attempts < this.maxAttempts) {
          await cancelResponseBody(response, "Convergent-operation response carried an invalid X-Calyx-Request-Id; repeating the operation.");
          continue attemptLoop;
        }
        return rejectProtocolResponse(
          "invalid_response",
          "Response X-Calyx-Request-Id violates its generated schema.",
          response,
          attempts,
          null,
        );
      }
      const success = plan.success.find((candidate) => candidate.status === response.status);
      if (!success) {
        if (response.status >= 200 && response.status < 300) {
          if (prepared.idempotencyKey) {
            await cancelResponseBody(response, "Keyed-write response returned an undeclared success-class status.");
            return this.recover<T, Code>(
              surface,
              plan,
              prepared,
              attempts,
              "unexpected_status",
              { status: response.status, requestId },
            );
          }
          if (hasConvergentRetry && attempts < this.maxAttempts) {
            await cancelResponseBody(response, "Convergent-operation response returned an undeclared success status; repeating the operation.");
            continue attemptLoop;
          }
          return rejectProtocolResponse(
            "unexpected_status",
            "Response returned an undeclared success-class status.",
            response,
            attempts,
            requestId,
          );
        }
        const failure = await this.decodeApiFailure<Code>(response, attempts, plan);
        if (failure.kind === "api") {
          const knownError = (plan.errorCodes[String(failure.status)] ?? [])
            .includes(failure.error.error.code);
          if (
            prepared.idempotencyKey
            && !knownError
            && failure.error.error.retryable !== false
          ) {
            keyedWriteAmbiguous = true;
            ambiguousAuthority = { status: failure.status, requestId: failure.requestId };
            if (failure.error.error.retryable === true && ordinaryEligible && attempts < this.maxAttempts) continue;
            return this.recover<T, Code>(
              surface,
              plan,
              prepared,
              attempts,
              "unknown_api_result",
              ambiguousAuthority,
            );
          }
          if (failure.error.error.retryable === true && ordinaryEligible && attempts < this.maxAttempts) continue;
          if (keyedWriteAmbiguous) {
            return this.recover<T, Code>(
              surface,
              plan,
              prepared,
              attempts,
              "api_after_ambiguous_dispatch",
              { status: failure.status, requestId: failure.requestId },
            );
          }
          return failure;
        }
        if (prepared.idempotencyKey) {
          return this.recover<T, Code>(
            surface,
            plan,
            prepared,
            attempts,
            failure.stage,
            { status: response.status, requestId },
          );
        }
        if (hasConvergentRetry && attempts < this.maxAttempts) continue attemptLoop;
        return failure;
      }
      for (const header of success.requiredHeaders) {
        if (!response.headers.has(header)) {
          if (prepared.idempotencyKey) {
            await cancelResponseBody(response, `Keyed-write response omitted required header ${header}.`);
            return this.recover<T, Code>(
              surface,
              plan,
              prepared,
              attempts,
              "missing_required_header",
              { status: response.status, requestId },
            );
          }
          if (hasConvergentRetry && attempts < this.maxAttempts) {
            await cancelResponseBody(response, `Convergent-operation response omitted required header ${header}; repeating the operation.`);
            continue attemptLoop;
          }
          return rejectProtocolResponse(
            "missing_required_header",
            `Response omitted required header ${header}.`,
            response,
            attempts,
          );
        }
      }
      const invalidHeader = invalidHeaderAgainstDecoders(response, success.headerDecoders);
      if (invalidHeader) {
        if (prepared.idempotencyKey) {
          await cancelResponseBody(response, `Keyed-write response header ${invalidHeader} violated its generated schema.`);
          return this.recover<T, Code>(
            surface,
            plan,
            prepared,
            attempts,
            "invalid_response",
            { status: response.status, requestId },
          );
        }
        if (hasConvergentRetry && attempts < this.maxAttempts) {
          await cancelResponseBody(response, `Convergent-operation response header ${invalidHeader} was invalid; repeating the operation.`);
          continue attemptLoop;
        }
        return rejectProtocolResponse(
          "invalid_response",
          `Response header ${invalidHeader} violates its generated schema.`,
          response,
          attempts,
        );
      }
      if (success.representation === "head") {
        try {
          const metadata = this.binaryMetadata(response, success, prepared, false);
          await cancelResponseBody(response, "HEAD response body is not consumable.");
          return { ok: true, status: response.status, data: metadata as T, requestId, attempts };
        } catch (error: unknown) {
          const stage = error instanceof ResponseBodyContractError ? error.stage : "invalid_response";
          const message = error instanceof Error ? error.message : "HEAD response carried invalid binary metadata.";
          return rejectProtocolResponse(stage, message, response, attempts);
        }
      }
      if (success.representation === "bytes") {
        if (!response.body) return protocolFailure("invalid_response", "Binary response omitted its stream body.", response, attempts);
        try {
          const binary = this.binaryMetadata(response, success, prepared, true);
          return { ok: true, status: response.status, data: binary as T, requestId, attempts };
        } catch (error: unknown) {
          const stage = error instanceof ResponseBodyContractError ? error.stage : "invalid_response";
          const message = error instanceof Error ? error.message : "Binary response carried invalid metadata.";
          return rejectProtocolResponse(stage, message, response, attempts);
        }
      }
      const mediaType = response.headers.get("content-type");
      if (!responseMediaMatches(mediaType, success.mediaType)) {
        if (prepared.idempotencyKey) {
          await cancelResponseBody(response, "Keyed-write response returned an unexpected media type.");
          return this.recover<T, Code>(
            surface,
            plan,
            prepared,
            attempts,
            "unexpected_media_type",
            { status: response.status, requestId },
          );
        }
        if (hasConvergentRetry && attempts < this.maxAttempts) {
          await cancelResponseBody(response, "Convergent-operation response returned an unexpected media type; repeating the operation.");
          continue attemptLoop;
        }
        return rejectProtocolResponse(
          "unexpected_media_type",
          `Unexpected response media type ${mediaType ?? "<missing>"}.`,
          response,
          attempts,
        );
      }
      if (success.representation === "sse") {
        if (!response.body) return protocolFailure("invalid_response", "SSE response omitted its stream body.", response, attempts);
        const stream = createCalyxEventStream<T>(
          response.body,
          (value, numberLexemes) => success.decoder.matches(value, numberLexemes),
          (value) => {
            if (!isRecord(value) || !success.cursorField) return undefined;
            const cursor = value[success.cursorField];
            return typeof cursor === "string" ? cursor : undefined;
          },
          prepared.signal,
          {
            maxAttempts: this.sseReconnectAttempts,
            minDelayMs: 250,
            maxDelayMs: 5_000,
            ...(prepared.headers["Last-Event-ID"] !== undefined
              ? { initialEventId: prepared.headers["Last-Event-ID"] }
              : {}),
            validateEventId: (eventId) => validLastEventId(
              eventId,
              success.cursorMaxLength ?? 0,
              success.cursorPattern,
            ),
            connect: (lastEventId, signal) => this.reconnectSse(
              prepared,
              plan,
              success,
              lastEventId,
              signal,
            ),
          },
          success.maxFrameBytes,
        );
        return { ok: true, status: response.status, data: stream, requestId, attempts };
      }
      let body: BoundedJsonBody;
      try {
        body = await readBoundedJsonResponseBody(response, success.maxBytes!);
      } catch (error: unknown) {
        const stage = error instanceof ResponseBodyContractError ? error.stage : "invalid_response";
        if (prepared.idempotencyKey) {
          return this.recover<T, Code>(
            surface,
            plan,
            prepared,
            attempts,
            stage,
            { status: response.status, requestId },
          );
        }
        if (hasConvergentRetry && attempts < this.maxAttempts) continue attemptLoop;
        return protocolFailure(
          stage,
          error instanceof Error ? error.message : "Response body ended before it could be decoded.",
          response,
          attempts,
          undefined,
          error instanceof ResponseBodyContractError && error.bodyObservation
            ? error.bodyObservation
            : unavailableProtocolBodyObservation(response),
        );
      }
      const decoded = parseJson(body.bytes, body.duplicateMembers);
      if (!decoded.ok || !success.decoder.matches(decoded.value, decoded.numberLexemes)) {
        const stage = decoded.ok
          ? schemaMajorMismatch(success.decoder, decoded.value)
            ? "schema_major_mismatch"
            : "invalid_response"
          : decoded.stage;
        if (prepared.idempotencyKey) {
          return this.recover<T, Code>(
            surface,
            plan,
            prepared,
            attempts,
            stage,
            { status: response.status, requestId },
          );
        }
        if (hasConvergentRetry && attempts < this.maxAttempts) continue attemptLoop;
        return protocolFailure(
          stage,
          "Response body did not satisfy the generated structural contract.",
          response,
          attempts,
          undefined,
          body.observation,
        );
      }
      return { ok: true, status: response.status, data: decoded.value as T, requestId, attempts };
    }
    throw new CalyxClientConfigurationError("Ordinary retry loop exhausted without a result.");
    };

    const reservation = prepared.idempotencyKey && this.recoveryStore
      ? this.createRecoveryReceipt(plan, prepared, 0, "reserved_before_dispatch")
      : undefined;
    if (reservation) {
      try {
        await this.recoveryStore!.reserve(reservation);
      } catch {
        return {
          ok: false,
          kind: "transport",
          stage: "recovery_store",
          message: "Durable recovery reservation failed before request dispatch.",
          attempts: 0,
        };
      }
    }

    const result: CalyxResult<T | CalyxEventStream<T>, Code> = await executePrepared();
    if (
      reconciliationOperationIds
      && dispatchAttempted
      && !result.ok
      && result.kind === "transport"
      && (result.stage === "network" || result.stage === "aborted")
    ) {
      return {
        ok: false,
        kind: "unkeyed_indeterminate",
        operationId: plan.operationId,
        attempts: 1,
        cause: {
          ok: false,
          kind: "transport",
          stage: result.stage as "network" | "aborted",
          message: result.message,
          attempts: 1,
        },
        reconciliation: {
          kind: "read_projection",
          operationIds: reconciliationOperationIds,
          absence: "inconclusive",
        },
      };
    }
    if (reconciliationOperationIds && !result.ok && result.kind === "protocol") {
      return {
        ok: false,
        kind: "unkeyed_indeterminate",
        operationId: plan.operationId,
        attempts: 1,
        cause: { ...result, attempts: 1 },
        reconciliation: {
          kind: "read_projection",
          operationIds: reconciliationOperationIds,
          absence: "inconclusive",
        },
      };
    }
    if (reservation && (result.ok || result.kind === "api")) {
      try { await this.recoveryStore!.release(reservation); } catch { /* server authority outranks cleanup */ }
    }
    return result;
  }

  async replay<T, Code extends string = string>(
    candidate: CalyxIndeterminateReceipt,
    options: CalyxReplayOptions = {},
  ): Promise<CalyxResult<T | CalyxEventStream<T>, Code>> {
    const signal = options.signal;
    if (!isRecord(candidate)) {
      throw new CalyxClientConfigurationError("Recovery receipt has an invalid runtime shape.");
    }
    const captured = Object.fromEntries(Object.entries(candidate)) as Record<string, unknown>;
    if (isRecord(captured["safe_headers"])) {
      captured["safe_headers"] = Object.freeze(Object.fromEntries(Object.entries(captured["safe_headers"])));
    }
    // Capture every replay-authoritative value before authentication. The
    // validated request must not retain caller-owned references across token
    // resolution or any other asynchronous boundary.
    const receipt = Object.freeze(captured) as unknown as CalyxIndeterminateReceipt;
    if (
      typeof receipt.schema_version !== "string"
      || receipt.payload_sensitivity !== "sensitive_request_payload"
      || receipt.integrity_algorithm !== RECOVERY_RECEIPT_INTEGRITY_ALGORITHM
      || typeof receipt.integrity_tag !== "string"
      || typeof receipt.credential_binding !== "string"
      || Object.keys(receipt).some((key) => !RECOVERY_RECEIPT_KEYS.has(key))
      || typeof receipt.contract_digest !== "string"
      || typeof receipt.operation_id !== "string"
      || typeof receipt.method !== "string"
      || typeof receipt.origin !== "string"
      || typeof receipt.base_path !== "string"
      || typeof receipt.path !== "string"
      || !isRecord(receipt.safe_headers)
      || Object.values(receipt.safe_headers).some((value) => typeof value !== "string")
      || typeof receipt.body_bytes !== "string"
      || typeof receipt.idempotency_key !== "string"
      || !Number.isSafeInteger(receipt.attempts)
      || receipt.attempts < 0
      || typeof receipt.failure_stage !== "string"
      || (receipt.last_http_status !== undefined && !Number.isSafeInteger(receipt.last_http_status))
      || (receipt.last_request_id !== undefined && typeof receipt.last_request_id !== "string")
      || ((receipt.last_http_status === undefined) !== (receipt.last_request_id === undefined))
    ) {
      throw new CalyxClientConfigurationError("Recovery receipt has an invalid runtime shape.");
    }
    const suppliedTag = receipt.integrity_tag;
    const unsignedReceipt = Object.fromEntries(
      Object.entries(receipt).filter(([key]) => key !== "integrity_algorithm" && key !== "integrity_tag"),
    ) as UnsignedCalyxIndeterminateReceipt;
    const suppliedTagBytes = Buffer.from(suppliedTag, "base64url");
    const expectedTagBytes = Buffer.from(
      recoveryReceiptIntegrityTag(this.recoveryReceiptIntegrityKey, unsignedReceipt),
      "base64url",
    );
    if (
      suppliedTagBytes.byteLength !== expectedTagBytes.byteLength
      || suppliedTagBytes.toString("base64url") !== suppliedTag
      || !timingSafeEqual(suppliedTagBytes, expectedTagBytes)
    ) {
      throw new CalyxClientConfigurationError(
        "Recovery receipt integrity authority does not match the originally issued request.",
      );
    }
    if (receipt.schema_version !== "calyx.client-indeterminate-result/v1") {
      throw new CalyxClientConfigurationError("Recovery receipt uses an unsupported schema version.");
    }
    const plan = this.operations[receipt.operation_id];
    if (!plan || plan.method !== receipt.method) {
      throw new CalyxClientConfigurationError("Recovery receipt names no generated operation in this client.");
    }
    if (receipt.contract_digest !== plan.recoveryContractDigest) {
      throw new CalyxClientConfigurationError(
        "Recovery receipt belongs to a different generated request contract for this operation.",
      );
    }
    if (textEncoder.encode(receipt.path).byteLength > plan.requestTargetMaxBytes) {
      throw new CalyxClientConfigurationError(
        `Recovery receipt request target exceeds ${plan.requestTargetMaxBytes} bytes.`,
      );
    }
    if (receipt.origin !== this.base.origin || receipt.base_path !== this.base.basePath) {
      throw new CalyxClientConfigurationError("Recovery receipt origin/base-path binding does not match this client.");
    }
    if (plan.method !== "POST" || plan.requestBody !== "json" || !plan.retryAuthority) {
      throw new CalyxClientConfigurationError("Only generated keyed JSON writes can carry recovery receipts.");
    }
    if (
      receipt.last_request_id !== undefined
      && !plan.requestIdHeaderDecoder(receipt.last_request_id)
    ) {
      throw new CalyxClientConfigurationError("Recovery receipt last request ID violates its generated schema.");
    }
    if (!Number.isSafeInteger(plan.maxBodyBytes) || plan.maxBodyBytes! <= 0) {
      throw new CalyxClientConfigurationError("Recovery operation has no finite generated request-body bound.");
    }
    const maximumEncodedLength = Math.ceil(plan.maxBodyBytes! / 3) * 4;
    if (receipt.body_bytes.length > maximumEncodedLength) {
      throw new CalyxClientConfigurationError("Recovery receipt body exceeds its generated request-body bound.");
    }
    const bodyBytes = Buffer.from(receipt.body_bytes, "base64");
    if (bodyBytes.toString("base64") !== receipt.body_bytes) {
      throw new CalyxClientConfigurationError("Recovery receipt body bytes are not canonical base64.");
    }
    if (bodyBytes.byteLength > plan.maxBodyBytes!) {
      throw new CalyxClientConfigurationError("Recovery receipt body exceeds its generated request-body bound.");
    }
    const body = parseJson(bodyBytes);
    if (
      !body.ok
      || retryAuthorityValue(body.value, plan.retryAuthority) !== receipt.idempotency_key
    ) {
      throw new CalyxClientConfigurationError("Recovery receipt body/idempotency binding is invalid.");
    }
    const serialized = plan.requestSerializer(body.value, new WeakSet());
    const canonicalBody = textEncoder.encode(JSON.stringify(serialized));
    if (!Buffer.from(canonicalBody).equals(bodyBytes)) {
      throw new CalyxClientConfigurationError("Recovery receipt body is not the exact generated serialization.");
    }
    const escapedTemplate = `${this.base.basePath}${plan.pathTemplate}`
      .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
      .replace(/\\\{[^/]+\\\}/gu, "[^/?]+");
    if (!new RegExp(`^${escapedTemplate}$`, "u").test(receipt.path)) {
      throw new CalyxClientConfigurationError("Recovery receipt path escapes its named generated operation.");
    }
    const canonicalUrl = new URL(receipt.path, this.base.origin);
    if (canonicalUrl.origin !== this.base.origin || canonicalUrl.pathname !== receipt.path || canonicalUrl.search || canonicalUrl.hash) {
      throw new CalyxClientConfigurationError("Recovery receipt path is not canonical and may escape its named generated operation.");
    }
    const headerNames = Object.keys(receipt.safe_headers);
    const allowedHeaders = new Set([
      "Content-Type",
      ...(plan.requestAccept ? ["Accept"] : []),
      ...(plan.assertedActorPattern ? ["X-Calyx-Asserted-Actor"] : []),
    ]);
    if (headerNames.some((name) => !allowedHeaders.has(name)) || new Set(headerNames.map((name) => name.toLowerCase())).size !== headerNames.length) {
      throw new CalyxClientConfigurationError("Recovery receipt contains a non-generated or case-colliding header.");
    }
    if (receipt.safe_headers["Content-Type"] !== (plan.requestMediaType ?? "application/json")) {
      throw new CalyxClientConfigurationError("Recovery receipt Content-Type binding is invalid.");
    }
    if (
      (plan.requestAccept !== undefined && receipt.safe_headers["Accept"] !== plan.requestAccept)
      || (plan.requestAccept === undefined && receipt.safe_headers["Accept"] !== undefined)
    ) {
      throw new CalyxClientConfigurationError("Recovery receipt Accept binding is invalid.");
    }
    const actor = receipt.safe_headers["X-Calyx-Asserted-Actor"];
    if (actor !== undefined && (
      !plan.assertedActorPattern
      || actor.length > (plan.assertedActorMaxLength ?? Number.POSITIVE_INFINITY)
      || !new RegExp(plan.assertedActorPattern, "u").test(actor)
    )) {
      throw new CalyxClientConfigurationError("Recovery receipt asserted-actor binding is invalid.");
    }
    let bearerToken: string | undefined;
    let recoveryBinding: string | undefined;
    try {
      const resolved = await resolveToken(this.tokenProvider, signal, this.validateBearerToken);
      if (resolved === TOKEN_RESOLUTION_ABORTED) {
        return {
          ok: false,
          kind: "transport",
          stage: "aborted",
          message: "Recovery replay was aborted by the caller.",
          attempts: receipt.attempts,
        };
      }
      bearerToken = resolved;
      recoveryBinding = recoveryCredentialBinding(this.recoveryReceiptIntegrityKey, bearerToken);
    } catch (error: unknown) {
      if (error instanceof CalyxClientConfigurationError) throw error;
      if (signal?.aborted) {
        return {
          ok: false,
          kind: "transport",
          stage: "aborted",
          message: "Recovery replay was aborted by the caller.",
          attempts: receipt.attempts,
        };
      }
      if (this.previousTokenProvider === undefined) {
        return {
          ok: false,
          kind: "transport",
          stage: "token",
          message: "Bearer token resolution failed during recovery replay.",
          attempts: receipt.attempts,
        };
      }
    }
    if (
      (recoveryBinding === undefined || !authenticatedBindingMatches(receipt.credential_binding, recoveryBinding))
      && this.previousTokenProvider !== undefined
    ) {
      try {
        const resolved = await resolveToken(this.previousTokenProvider, signal, this.validateBearerToken);
        if (resolved === TOKEN_RESOLUTION_ABORTED) {
          return {
            ok: false,
            kind: "transport",
            stage: "aborted",
            message: "Recovery replay was aborted by the caller.",
            attempts: receipt.attempts,
          };
        }
        bearerToken = resolved;
      } catch (error: unknown) {
        if (error instanceof CalyxClientConfigurationError) throw error;
        if (signal?.aborted) {
          return {
            ok: false,
            kind: "transport",
            stage: "aborted",
            message: "Recovery replay was aborted by the caller.",
            attempts: receipt.attempts,
          };
        }
        return {
          ok: false,
          kind: "transport",
          stage: "token",
          message: "Previous bearer token resolution failed during recovery replay.",
          attempts: receipt.attempts,
        };
      }
      recoveryBinding = recoveryCredentialBinding(this.recoveryReceiptIntegrityKey, bearerToken);
    }
    if (
      bearerToken === undefined
      || recoveryBinding === undefined
      || !authenticatedBindingMatches(receipt.credential_binding, recoveryBinding)
    ) {
      throw new CalyxClientConfigurationError(
        "Recovery receipt belongs to a different bearer credential authority.",
      );
    }
    return this.executeRawRecovery<T, Code>(plan, receipt, bodyBytes, {
      bearerToken,
      recoveryBinding,
    }, signal);
  }

  private prepare(plan: OperationPlan, request: OperationRequest): PreparedRequest {
    const {
      path: pathInput,
      query: queryInput,
      body: bodyInput,
      assertedActor,
      lastEventId,
      signal,
    } = request;
    const preparedPath = composeGeneratedOperationPath(plan, pathInput);
    const path = preparedPath.path;
    if (plan.queryRequired === true && queryInput === undefined) {
      throw new CalyxClientConfigurationError("This operation requires generated query input.");
    }
    const query = plan.method === "GET" || plan.method === "HEAD"
      ? buildQuery(plan.requestSerializer, queryInput)
      : "";
    const requestTarget = `${this.base.basePath}${path}${query}`;
    if (textEncoder.encode(requestTarget).byteLength > plan.requestTargetMaxBytes) {
      throw new CalyxClientConfigurationError(
        `Encoded request target exceeds ${plan.requestTargetMaxBytes} bytes.`,
      );
    }
    const headers: Record<string, string> = {};
    if (plan.requestAccept) headers["Accept"] = plan.requestAccept;
    if (lastEventId !== undefined && !plan.lastEventIdAllowed) {
      throw new CalyxClientConfigurationError("This operation does not accept Last-Event-ID.");
    }
    if (lastEventId !== undefined) {
      if (!validLastEventId(lastEventId, plan.lastEventIdMaxLength ?? 0, plan.lastEventIdPattern)) {
        throw new CalyxClientConfigurationError(
          "lastEventId does not satisfy the generated replay-header contract.",
        );
      }
      headers["Last-Event-ID"] = lastEventId;
    }
    if (assertedActor !== undefined) {
      if (
        !plan.assertedActorPattern
        || assertedActor.length > (plan.assertedActorMaxLength ?? Number.POSITIVE_INFINITY)
        || !new RegExp(plan.assertedActorPattern, "u").test(assertedActor)
      ) {
        throw new CalyxClientConfigurationError("assertedActor does not satisfy the generated header contract.");
      }
      headers["X-Calyx-Asserted-Actor"] = assertedActor;
    }
    let bodyBytes: Uint8Array | undefined;
    let idempotencyKey: string | undefined;
    if (plan.requestBody === "json") {
      if (bodyInput === undefined) {
        throw new CalyxClientConfigurationError("This operation requires a JSON request body.");
      }
      const serialized = plan.requestSerializer(bodyInput, new WeakSet());
      bodyBytes = textEncoder.encode(JSON.stringify(serialized));
      idempotencyKey = retryAuthorityValue(serialized, plan.retryAuthority);
      if (plan.maxBodyBytes !== undefined && bodyBytes.byteLength > plan.maxBodyBytes) {
        throw new CalyxClientConfigurationError(`Serialized request exceeds ${plan.maxBodyBytes} bytes.`);
      }
      headers["Content-Type"] = plan.requestMediaType ?? "application/json";
    } else if (bodyInput !== undefined) {
      throw new CalyxClientConfigurationError("This operation does not accept a request body.");
    }
    return {
      path: requestTarget,
      url: `${this.base.origin}${requestTarget}`,
      headers: sortObject(headers) as Readonly<Record<string, string>>,
      ...(bodyBytes ? { bodyBytes } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(signal ? { signal } : {}),
      pathParameters: preparedPath.parameters,
    };
  }

  private async reconnectSse(
    prepared: PreparedRequest,
    plan: OperationPlan,
    success: OperationSuccessPlan,
    lastEventId: string | undefined,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    if (!prepared.credential) throw new CalyxClientConfigurationError("SSE reconnect lacks bound credential authority.");
    const headers: Record<string, string> = { ...prepared.headers };
    delete headers["Last-Event-ID"];
    if (lastEventId !== undefined) {
      if (!validLastEventId(lastEventId, plan.lastEventIdMaxLength ?? 0, plan.lastEventIdPattern)) {
        throw new Error("SSE reconnect cursor violates its generated Last-Event-ID contract.");
      }
      headers["Last-Event-ID"] = lastEventId;
    }
    let response: Response;
    try {
      response = await this.fetchImplementation(prepared.url, {
        method: plan.method,
        headers: { ...headers, Authorization: `Bearer ${prepared.credential.bearerToken}` },
        redirect: "manual",
        signal,
      });
    } catch {
      if (signal.aborted) throw new Error("SSE reconnect was aborted by the caller.");
      throw new Error("SSE reconnect failed before response headers.");
    }
    if (response.status >= 300 && response.status < 400) {
      return rejectResponseWithError(response, "SSE reconnect refused a redirect before forwarding credentials.");
    }
    if (response.status !== success.status) {
      return rejectResponseWithError(response, `SSE reconnect returned unexpected status ${response.status}.`);
    }
    if (!response.headers.has("x-calyx-request-id")) {
      return rejectResponseWithError(response, "SSE reconnect omitted X-Calyx-Request-Id.");
    }
    const invalidRequestId = invalidHeaderAgainstDecoders(
      response,
      { "x-calyx-request-id": plan.requestIdHeaderDecoder },
    );
    if (invalidRequestId) {
      return rejectResponseWithError(response, "SSE reconnect X-Calyx-Request-Id violates its generated schema.");
    }
    for (const header of success.requiredHeaders) {
      if (!response.headers.has(header)) {
        return rejectResponseWithError(response, `SSE reconnect omitted required header ${header}.`);
      }
    }
    const invalidHeader = invalidHeaderAgainstDecoders(response, success.headerDecoders);
    if (invalidHeader) {
      return rejectResponseWithError(response, `SSE reconnect header ${invalidHeader} violates its generated schema.`);
    }
    if (!responseMediaMatches(response.headers.get("content-type"), success.mediaType)) {
      return rejectResponseWithError(response, "SSE reconnect returned an unexpected media type.");
    }
    if (!response.body) throw new Error("SSE reconnect omitted its stream body.");
    return response.body;
  }

  private async decodeApiFailure<Code extends string>(
    response: Response,
    attempts: number,
    plan: OperationPlan,
  ): Promise<CalyxApiFailure<Code> | CalyxProtocolFailure> {
    if (response.status >= 200 && response.status < 300) {
      return rejectProtocolResponse(
        "unexpected_status",
        "Success-class response cannot carry calyx.error/v1 authority.",
        response,
        attempts,
        response.headers.get("x-calyx-request-id"),
      );
    }
    for (const header of plan.errorRequiredHeaders[String(response.status)] ?? []) {
      if (!response.headers.has(header)) {
        return rejectProtocolResponse(
          "missing_required_header",
          `Error response omitted required header ${header}.`,
          response,
          attempts,
        );
      }
    }
    const invalidHeader = invalidHeaderAgainstDecoders(
      response,
      plan.errorRequiredHeaderDecoders[String(response.status)] ?? {},
    );
    if (invalidHeader) {
      return rejectProtocolResponse(
        "invalid_response",
        `Error response header ${invalidHeader} violates its generated schema.`,
        response,
        attempts,
      );
    }
    if (!responseMediaMatches(response.headers.get("content-type"), "application/json")) {
      return rejectProtocolResponse(
        "unexpected_media_type",
        "Error response was not application/json.",
        response,
        attempts,
      );
    }
    let body: BoundedJsonBody;
    try {
      body = await readBoundedJsonResponseBody(response, CALYX_ERROR_ENVELOPE_MAX_BYTES);
    } catch (error: unknown) {
      const stage = error instanceof ResponseBodyContractError ? error.stage : "invalid_error_envelope";
      return protocolFailure(
        stage,
        error instanceof Error ? error.message : "Error response body could not be read.",
        response,
        attempts,
        undefined,
        error instanceof ResponseBodyContractError && error.bodyObservation
          ? error.bodyObservation
          : unavailableProtocolBodyObservation(response),
      );
    }
    const decoded = parseJson(body.bytes, body.duplicateMembers);
    const errorDecoder = plan.errorDecoders[String(response.status)] ?? plan.errorEnvelopeDecoder;
    if (!decoded.ok || !errorDecoder.matches(decoded.value, decoded.numberLexemes)) {
      return protocolFailure(
        "invalid_error_envelope",
        "Non-success response was not calyx.error/v1.",
        response,
        attempts,
        undefined,
        body.observation,
      );
    }
    const decodedCode = (decoded.value as CalyxErrorEnvelope).error.code;
    const declaredCodes = plan.errorCodes[String(response.status)];
    const mutationOperation = plan.success.some((success) => (
      success.semantics["mutation"] !== "read"
    ));
    if (
      mutationOperation
      && (declaredCodes === undefined || !declaredCodes.includes(decodedCode))
    ) {
      return protocolFailure(
        "invalid_response",
        `Non-success response status/code pair ${response.status}/${decodedCode} was not declared by the generated operation contract.`,
        response,
        attempts,
        undefined,
        body.observation,
      );
    }
    return {
      ok: false,
      kind: "api",
      status: response.status,
      error: decoded.value as unknown as CalyxErrorEnvelope<Code>,
      requestId: response.headers.get("x-calyx-request-id")!,
      attempts,
    };
  }

  private async recover<T, Code extends string>(
    surface: string,
    plan: OperationPlan,
    prepared: PreparedRequest,
    ordinaryAttempts: number,
    failureStage: string,
    authority?: ResponseAuthority,
  ): Promise<CalyxResult<T | CalyxEventStream<T>, Code>> {
    let recoveryAttempts = 0;
    while (recoveryAttempts < this.recoveryAttempts) {
      recoveryAttempts += 1;
      const result = await this.executeOnce<T, Code>(surface, plan, prepared, ordinaryAttempts + recoveryAttempts);
      if (result.ok) return result;
      if (result.kind === "api") {
        // A later error response does not prove that the earlier keyed attempt
        // was not admitted. Only a valid generated success closes ambiguity.
        failureStage = "api_during_recovery";
        authority = { status: result.status, requestId: result.requestId };
        continue;
      }
      if (result.kind === "indeterminate") return result;
      if (result.kind === "unkeyed_indeterminate") {
        throw new CalyxClientConfigurationError(
          "A keyed recovery attempt produced an impossible unkeyed-indeterminate result.",
        );
      }
      failureStage = result.stage;
      if (result.kind === "transport" && result.stage === "aborted") {
        // Caller cancellation is terminal for this recovery invocation. Persist
        // the still-indeterminate write once, but never consult fetch again.
        return this.recordIndeterminate(
          plan,
          prepared,
          ordinaryAttempts + recoveryAttempts,
          failureStage,
          authority,
        );
      }
      if (result.kind === "protocol" && result.requestId !== undefined) {
        authority = { status: result.status, requestId: result.requestId };
      }
    }
    return this.recordIndeterminate(plan, prepared, ordinaryAttempts + recoveryAttempts, failureStage, authority);
  }

  private createRecoveryReceipt(
    plan: OperationPlan,
    prepared: PreparedRequest,
    attempts: number,
    failureStage: string,
    authority?: ResponseAuthority,
  ): CalyxIndeterminateReceipt {
    if (!prepared.idempotencyKey || !prepared.bodyBytes || !prepared.credential || !plan.retryAuthority) {
      throw new CalyxClientConfigurationError("Only a generated keyed JSON write can become indeterminate.");
    }
    const unsignedReceipt: UnsignedCalyxIndeterminateReceipt = {
      schema_version: "calyx.client-indeterminate-result/v1",
      payload_sensitivity: "sensitive_request_payload",
      credential_binding: prepared.credential.recoveryBinding,
      contract_digest: plan.recoveryContractDigest,
      operation_id: plan.operationId,
      method: plan.method,
      origin: this.base.origin,
      base_path: this.base.basePath,
      path: prepared.path,
      safe_headers: Object.freeze({ ...prepared.headers }),
      body_bytes: Buffer.from(prepared.bodyBytes).toString("base64"),
      idempotency_key: prepared.idempotencyKey,
      attempts,
      failure_stage: failureStage,
      ...(authority ? {
        last_http_status: authority.status,
        last_request_id: authority.requestId,
      } : {}),
    };
    return Object.freeze({
      ...unsignedReceipt,
      integrity_algorithm: RECOVERY_RECEIPT_INTEGRITY_ALGORITHM,
      integrity_tag: recoveryReceiptIntegrityTag(this.recoveryReceiptIntegrityKey, unsignedReceipt),
    });
  }

  private async recordIndeterminate(
    plan: OperationPlan,
    prepared: PreparedRequest,
    attempts: number,
    failureStage: string,
    authority?: ResponseAuthority,
  ): Promise<CalyxIndeterminateFailure> {
    const receipt = this.createRecoveryReceipt(plan, prepared, attempts, failureStage, authority);
    let persistenceFailure: CalyxIndeterminateFailure["persistenceFailure"];
    try {
      await this.recoveryStore?.save(receipt);
    } catch {
      persistenceFailure = {
        stage: "recovery_store",
        message: "The immutable recovery receipt could not be persisted by the configured recovery store.",
      };
    }
    return {
      ok: false,
      kind: "indeterminate",
      receipt,
      ...(persistenceFailure ? { persistenceFailure } : {}),
      ...(authority ? { requestId: authority.requestId } : {}),
      attempts: receipt.attempts,
    };
  }

  private async executeOnce<T, Code extends string>(
    surface: string,
    plan: OperationPlan,
    prepared: PreparedRequest,
    attempts: number,
  ): Promise<CalyxResult<T | CalyxEventStream<T>, Code>> {
    if (!prepared.credential) throw new CalyxClientConfigurationError("Recovery request lacks bound credential authority.");
    let response: Response | undefined;
    try {
      const received = await this.fetchImplementation(prepared.url, {
        method: plan.method,
        headers: { ...prepared.headers, Authorization: `Bearer ${prepared.credential.bearerToken}` },
        ...(prepared.bodyBytes ? { body: prepared.bodyBytes } : {}),
        redirect: "manual",
        ...(prepared.signal ? { signal: prepared.signal } : {}),
      });
      response = received;
      if (received.status >= 300 && received.status < 400) {
        const candidateRequestId = received.headers.get("x-calyx-request-id");
        const validatedRequestId = candidateRequestId !== null
          && invalidHeaderAgainstDecoders(
            received,
            { "x-calyx-request-id": plan.requestIdHeaderDecoder },
          ) === undefined
          ? candidateRequestId
          : undefined;
        return rejectProtocolResponse(
          "redirect_refused",
          "Recovery replay refused a redirect before forwarding credentials.",
          received,
          attempts,
          validatedRequestId ?? null,
        );
      }
      const requestId = received.headers.get("x-calyx-request-id");
      if (!requestId) {
        return rejectProtocolResponse(
          "missing_required_header",
          "Response omitted X-Calyx-Request-Id.",
          received,
          attempts,
        );
      }
      const invalidRequestId = invalidHeaderAgainstDecoders(
        received,
        { "x-calyx-request-id": plan.requestIdHeaderDecoder },
      );
      if (invalidRequestId) {
        return rejectProtocolResponse(
          "invalid_response",
          "Recovery response X-Calyx-Request-Id violates its generated schema.",
          received,
          attempts,
          null,
        );
      }
      const success = plan.success.find((candidate) => candidate.status === received.status);
      if (!success) {
        if (received.status >= 200 && received.status < 300) {
          return rejectProtocolResponse(
            "unexpected_status",
            "Recovery replay returned an undeclared success-class status.",
            received,
            attempts,
            requestId,
          );
        }
        return this.decodeApiFailure<Code>(received, attempts, plan);
      }
      for (const header of success.requiredHeaders) {
        if (!received.headers.has(header)) {
          return rejectProtocolResponse(
            "missing_required_header",
            `Recovery replay omitted required header ${header}.`,
            received,
            attempts,
          );
        }
      }
      const invalidHeader = invalidHeaderAgainstDecoders(received, success.headerDecoders);
      if (invalidHeader) {
        return rejectProtocolResponse(
          "invalid_response",
          `Recovery replay header ${invalidHeader} violates its generated schema.`,
          received,
          attempts,
        );
      }
      if (success.representation !== "json") {
        return rejectProtocolResponse(
          "invalid_response",
          "Recovery replay returned a non-JSON representation.",
          received,
          attempts,
        );
      }
      const mediaType = received.headers.get("content-type");
      if (!responseMediaMatches(mediaType, success.mediaType)) {
        return rejectProtocolResponse(
          "unexpected_media_type",
          "Recovery replay returned the wrong media type.",
          received,
          attempts,
        );
      }
      const body = await readBoundedJsonResponseBody(received, success.maxBytes!);
      const decoded = parseJson(body.bytes, body.duplicateMembers);
      if (!decoded.ok || !success.decoder.matches(decoded.value, decoded.numberLexemes)) {
        const stage = decoded.ok && schemaMajorMismatch(success.decoder, decoded.value)
          ? "schema_major_mismatch"
          : decoded.ok ? "invalid_response" : decoded.stage;
        return protocolFailure(
          stage,
          "Recovery replay returned an invalid response.",
          received,
          attempts,
          undefined,
          body.observation,
        );
      }
      return { ok: true, status: received.status, data: decoded.value as T, requestId, attempts };
    } catch (error: unknown) {
      if (error instanceof ResponseBodyContractError && response) {
        return protocolFailure(
          error.stage,
          error.message,
          response,
          attempts,
          undefined,
          error.bodyObservation ?? unavailableProtocolBodyObservation(response),
        );
      }
      return {
        ok: false,
        kind: "transport",
        stage: prepared.signal?.aborted ? "aborted" : "network",
        message: prepared.signal?.aborted ? "Recovery request was aborted by the caller." : "Recovery request failed before a valid result.",
        attempts,
      };
    }
  }

  private async executeRawRecovery<T, Code extends string>(
    plan: OperationPlan,
    receipt: CalyxIndeterminateReceipt,
    bodyBytes: Uint8Array,
    credential: NonNullable<PreparedRequest["credential"]>,
    signal: AbortSignal | undefined,
  ): Promise<CalyxResult<T | CalyxEventStream<T>, Code>> {
    const surface = plan.surface;
    const prepared: PreparedRequest = {
      path: receipt.path,
      url: `${this.base.origin}${receipt.path}`,
      headers: { ...receipt.safe_headers },
      bodyBytes,
      idempotencyKey: receipt.idempotency_key,
      pathParameters: Object.freeze({}),
      credential,
      ...(signal ? { signal } : {}),
    };
    const authority = receipt.last_http_status !== undefined && receipt.last_request_id !== undefined
      ? { status: receipt.last_http_status, requestId: receipt.last_request_id }
      : undefined;
    return this.recover<T, Code>(surface, plan, prepared, 0, receipt.failure_stage, authority);
  }

  private binaryMetadata(
    response: Response,
    success: OperationSuccessPlan,
    prepared: PreparedRequest,
    includeBody: boolean,
  ): Record<string, unknown> {
    const maximum = success.maxBytes!;
    const contentLength = declaredContentLength(response, maximum);
    if (contentLength === undefined) {
      throw new ResponseBodyContractError("custody_mismatch", "Attachment response omitted Content-Length.");
    }
    const contentType = response.headers.get("content-type");
    const etag = response.headers.get("etag");
    const digest = response.headers.get("digest");
    const attachmentRef = response.headers.get("x-calyx-attachment-ref");
    const sourceTier = response.headers.get("x-calyx-source-tier");
    const originHost = response.headers.get("x-calyx-origin-host");
    const servedByHost = response.headers.get("x-calyx-served-by-host");
    if (!contentType || !etag || !digest || !attachmentRef || !sourceTier) {
      throw new ResponseBodyContractError("custody_mismatch", "Attachment response omitted required custody metadata.");
    }
    const custody = success.custodyContract;
    if (
      !isRecord(custody)
      || custody["schema_version"] !== "calyx.attachment-custody/v1"
      || custody["kind"] !== "content_addressed_attachment"
      || !isRecord(custody["requested_ref"])
      || custody["requested_ref"]["in"] !== "path"
      || typeof custody["requested_ref"]["name"] !== "string"
    ) {
      throw new ResponseBodyContractError("custody_mismatch", "Generated attachment custody contract is unavailable.");
    }
    const requestedRef = prepared.pathParameters[custody["requested_ref"]["name"]];
    const match = /^att:sha256:([0-9a-f]{64})$/u.exec(attachmentRef);
    if (typeof requestedRef !== "string" || requestedRef !== attachmentRef || !match) {
      throw new ResponseBodyContractError("custody_mismatch", "Requested and returned attachment identities do not match.");
    }
    const sha256 = match[1]!;
    const expectedDigest = `sha-256=${Buffer.from(sha256, "hex").toString("base64")}`;
    if (etag !== `"sha256:${sha256}"` || digest !== expectedDigest) {
      throw new ResponseBodyContractError("custody_mismatch", "Attachment ref, ETag, and Digest do not name the same bytes.");
    }
    const verified = includeBody
      ? verifiedBinaryBody(response.body!, maximum, contentLength, digest)
      : undefined;
    return {
      contentLength,
      contentType,
      etag,
      digest,
      attachmentRef,
      sourceTier,
      requestId: response.headers.get("x-calyx-request-id")!,
      ...(originHost ? { originHost } : {}),
      ...(servedByHost ? { servedByHost } : {}),
      ...(verified ?? {}),
    };
  }
}
