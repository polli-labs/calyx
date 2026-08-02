import type { InterfaceProfile } from "./consumer-credentials";
import {
  interfaceCapabilityContract,
} from "./interface-capabilities";
import type {
  InterfaceCapabilityEffectLevel,
  InterfaceCapabilityEffectSet,
  InterfaceCapabilityId,
  InterfaceCapabilityReceiverEffects,
} from "./interface-capabilities";
import {
  API_ASSERTED_ACTOR_PATTERN_SOURCE,
  API_PROVENANCE_HOST_PATTERN_SOURCE,
} from "./state/provenance";

export const HTTP_STORE_REGIMES = [
  "filesystem_authoritative",
  "sqlite_authoritative",
  "runtime_process",
] as const;
export const CALYX_ACTIVITY_ATTACHMENT_MAX_BYTES = 64 * 1024 * 1024;
export const CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_MAX_CHARS = 128;
export const CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_PATTERN_SOURCE =
  "^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$";
export const CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_KNOWN_VALUES = [
  "local-transcript",
  "origin-daemon",
  "blade-archive",
] as const;
export const CALYX_HTTP_DEFAULT_JSON_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
export const CALYX_ADMIN_RUN_LIST_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
export const CALYX_ADMIN_RUN_LIST_MAX_ITEMS = 100;
export const CALYX_SELF_UPGRADE_RECEIPT_MAX_BYTES = 4 * 1024 * 1024;
export const CALYX_HTTP_SSE_MAX_FRAME_BYTES = 1024 * 1024;
export const CALYX_HTTP_SSE_CURSOR_MAX_CHARS = 512;
/**
 * Zod description marker for response objects whose unknown members are a
 * safety failure, rather than a rolling-compatible same-major addition.
 */
export const CALYX_CLOSED_RESPONSE_OBJECT_DESCRIPTION_PREFIX =
  "calyx-closed-response-object:" as const;
/**
 * Zod description marker for response unions whose currently known branch-only
 * members are semantically exclusive. Unmarked unions remain rolling-open to
 * lawful same-major optional additions.
 */
export const CALYX_EXCLUSIVE_RESPONSE_UNION_DESCRIPTION_PREFIX =
  "calyx-exclusive-response-union:" as const;

/** Encode the one canonical Calyx SSE frame representation used at admission and delivery. */
export function encodeCalyxSseFrameData(cursor: string, serializedData: string): string {
  if (!cursor || /[\r\n]/u.test(cursor)) {
    throw new Error("Calyx SSE cursors must be non-empty single-line values.");
  }
  return `id: ${cursor}\ndata: ${serializedData}\n\n`;
}

export function encodeCalyxSseFrame(cursor: string, payload: unknown): string {
  const data = JSON.stringify(payload);
  if (data === undefined) {
    throw new Error("Calyx SSE payloads must be JSON-serializable values.");
  }
  return encodeCalyxSseFrameData(cursor, data);
}
export type HttpStoreRegime = (typeof HTTP_STORE_REGIMES)[number];

export type HttpOperationEffectLevel = InterfaceCapabilityEffectLevel;

/** Effects are declared independently of storage regime and route namespace. */
export type HttpOperationEffectSet = InterfaceCapabilityEffectSet;

export type HttpOperationEffects = InterfaceCapabilityReceiverEffects;

export interface HttpOperationError {
  status: number;
  code: string;
}

export interface HttpOperationSuccess {
  status: 200 | 202;
  representation: "json" | "sse" | "bytes" | "head";
  schema: string;
  media_type: "application/json" | "application/vnd.polli.calyx.run-launch-receipt+json;version=1" | "text/event-stream" | "dynamic" | null;
  /** Hard response-body ceiling jointly enforced by server emission and bound clients. */
  max_bytes?: number;
  /** Hard wire-byte ceiling for each complete or unterminated SSE frame. */
  max_frame_bytes?: number;
  /** Payload field whose exact value must equal the SSE id before replay advances. */
  cursor_field?: "cursor";
  condition?: {
    request_accept?: string;
    outcome?: string;
  };
  request_schema?: string;
  semantics: HttpOperationSemantics;
  headers?: readonly {
    name: string;
    schema: Readonly<Record<string, unknown>>;
    required: boolean;
  }[];
  /** Cross-representation custody law for specialized byte/head responses. */
  custody?: HttpOperationCustodyContract;
}

export interface HttpOperationCustodyContract {
  schema_version: "calyx.attachment-custody/v1";
  kind: "content_addressed_attachment";
  requested_ref: { in: "path"; name: string };
  bindings: readonly {
    source: string;
    target: string;
    relation: "equals" | "sha256_base64" | "sha256_etag";
  }[];
}

export type HttpOperationRetryAuthority =
  | {
    kind: "request_body_field";
    field: string;
  }
  | {
    /** The fixed bodyless operation is naturally convergent and safe to repeat. */
    kind: "operation_identity";
  }
  | {
    /** The immutable encoded request target makes a bodyless DELETE safe to repeat. */
    kind: "request_target_identity";
  };

export interface HttpOperationSemantics {
  mutation: "read" | "idempotent_write" | "stateful_write" | "submit";
  /** Named generated reads that reconcile an unkeyed stateful write after result-authority loss. */
  reconciliation_operation_ids?: readonly string[];
  async: {
    kind: "synchronous" | "stream" | "submit" | "conditional";
    background: boolean;
    waitable: boolean;
    resumable: boolean;
    cancellable: boolean;
  };
  receipt: "none" | "inline_result" | "accepted_locator";
  submission?: {
    locator_json_path: string;
    observation_operation_id: string;
    receipt_schema: string;
  };
  negotiation?: {
    request_accept: string;
  };
}

export interface HttpOperationDescriptor {
  operation_id: string;
  /** Stable app-facing capability; deliberately independent of route and CLI nouns. */
  capability: string;
  /** Owning domain, independent of the admin/internal path namespace. */
  domain: string;
  method: "GET" | "HEAD" | "POST" | "DELETE";
  path: string;
  profile: InterfaceProfile;
  store_regime: HttpStoreRegime;
  request_schema: string;
  response_schema: string;
  /** Closed client retry authority. Absence means transport retries are forbidden. */
  retry_authority?: HttpOperationRetryAuthority;
  summary: string;
  request_transport: { body: "none" } | { body: "json"; media_type: "application/json"; max_bytes: number };
  request_headers?: readonly {
    name: string;
    schema: Readonly<Record<string, unknown>>;
    required: boolean;
  }[];
  path_parameters?: readonly {
    name: string;
    schema: Readonly<Record<string, unknown>>;
    required: true;
  }[];
  successes: readonly HttpOperationSuccess[];
  effects: HttpOperationEffects;
  /** Canonical media type for every structured operation error envelope. */
  error_media_type: "application/json";
  errors: readonly HttpOperationError[];
  /** Generated client packages that deliberately expose this operation. */
  client_surfaces: readonly ("consumer" | "admin")[];
  /**
   * Required provenance when a canonical consumer/admin operation is
   * deliberately withheld from one of its otherwise eligible client surfaces.
   * Internal-runtime operations are outside client publication and therefore do
   * not carry omission records.
   */
  client_omission?: {
    reason: "predecessor" | "decay" | "staged";
    issue: `POL-${number}`;
    expires_on: `${number}-${number}-${number}`;
  };
}

const error = (status: number, code: string): HttpOperationError => ({ status, code });
const COMMON_ERRORS = [
  error(401, "unauthorized"),
  error(403, "profile_forbidden"),
  error(500, "internal_error"),
] as const;
const QUERY_ERRORS = [...COMMON_ERRORS, error(400, "invalid_request")] as const;
const WRITE_ERRORS = [...QUERY_ERRORS, error(413, "payload_too_large"), error(415, "unsupported_media_type")] as const;
const ACTIVITY_RESOURCE_ERRORS = [
  error(400, "invalid_activity_selector"),
  error(404, "activity_unknown"),
  error(409, "activity_ambiguous"),
  error(422, "activity_metadata_unavailable"),
  error(503, "activity_projection_not_ready"),
] as const;
const CONSUMER_ACTIVITY_ERRORS = [
  ...QUERY_ERRORS,
  error(400, "consumer_selector_forbidden"),
  ...ACTIVITY_RESOURCE_ERRORS,
] as const;
const ADMIN_ACTIVITY_ERRORS = [...QUERY_ERRORS, ...ACTIVITY_RESOURCE_ERRORS] as const;
const WORK_LIST_ERRORS = [
  ...QUERY_ERRORS,
  error(503, "activity_projection_not_ready"),
] as const;
const CONSUMER_ACTIVITY_LIST_ERRORS = [
  ...WORK_LIST_ERRORS,
  error(400, "consumer_selector_forbidden"),
] as const;
const ATTACHMENT_REF_UNKNOWN_ERROR = error(404, "attachment_ref_unknown");
const ATTACHMENT_BYTES_ERRORS = [
  error(409, "attachment_bytes_unavailable"),
  error(422, "attachment_digest_mismatch"),
] as const;
const ADMIN_ATTACHMENT_LIST_ERRORS = [
  ...ADMIN_ACTIVITY_ERRORS,
  error(422, "attachment_digest_mismatch"),
] as const;
const ADMIN_ATTACHMENT_RECORD_ERRORS = [
  ...COMMON_ERRORS,
  ...ACTIVITY_RESOURCE_ERRORS,
  ATTACHMENT_REF_UNKNOWN_ERROR,
] as const;
const ADMIN_ATTACHMENT_BYTES_ERRORS = [
  ...ADMIN_ATTACHMENT_RECORD_ERRORS,
  ...ATTACHMENT_BYTES_ERRORS,
] as const;
const MONITOR_SCHEMA_ERROR = error(503, "monitor_schema_unavailable");

function capability(
  capabilityId: InterfaceCapabilityId,
): Pick<HttpOperationDescriptor, "capability" | "domain" | "effects"> {
  const registered = interfaceCapabilityContract(capabilityId);
  return {
    capability: registered.id,
    domain: registered.domain,
    effects: registered.receiver_effects,
  };
}

function operationCapability(
  capabilityId: InterfaceCapabilityId,
  operationId: string,
): Pick<HttpOperationDescriptor, "capability" | "domain" | "effects"> {
  const registered = interfaceCapabilityContract(capabilityId);
  const effects = registered.operation_receiver_effects?.[operationId];
  if (!effects) throw new Error(`Capability ${capabilityId} has no receiver effects for operation ${operationId}.`);
  return {
    capability: registered.id,
    domain: registered.domain,
    effects,
  };
}

const WORK_OPERATIONS = {
  list: operationCapability("work.observe", "work.list"),
  get: operationCapability("work.observe", "work.get"),
  observe: operationCapability("work.observe", "work.observe"),
};
const RECALL_OPERATIONS = {
  list: operationCapability("recall", "activity.list"),
  get: operationCapability("recall", "activity.get"),
  messages: operationCapability("recall", "activity.messages"),
  turns: operationCapability("recall", "activity.turns"),
  attachments: operationCapability("recall", "activity.attachments"),
  text: operationCapability("recall", "activity.text"),
};
const MSG_READ = capability("msg.read");
const MSG_SEND = capability("msg.send");
const LEASE_OBSERVE = capability("lease.observe");
const DAEMON_HEALTH = capability("daemon.health");
const SELF_UPGRADE_RECEIPT = operationCapability("self.upgrade", "admin.self-upgrade.receipt");
const DAEMON_METRICS = capability("daemon.metrics");
const DISPATCH = capability("run.launch");
const RUN_RECONCILE = capability("run.reconcile");
const RUN_STOP = capability("run.stop");
const REQUEST_AUDIT = capability("request-audit.read");
const RUNTIME_CONFIG_PLAN = capability("runtime-config.plan");
const RUNTIME_CONFIG_APPLY = capability("runtime-config.apply");
const RUNTIME_CONFIG_VERIFY = capability("runtime-config.verify");
const MSG_RECEIVE = capability("msg.receive");
const MSG_ADMIN_OBSERVE = operationCapability("msg.read", "admin.msg.operation");
const MSG_FORWARD = operationCapability("msg.send", "admin.msg.forward");
const SESSION_WAKE_DELIVER = operationCapability("msg.send", "admin.session-wake.deliver");
const RUN_ADMIN_CAPABILITIES = {
  get: operationCapability("work.observe", "admin.run.get"),
  logs: operationCapability("work.observe", "admin.run.logs"),
  events: operationCapability("work.observe", "admin.run.events"),
  observation: operationCapability("work.observe", "admin.run.observation"),
  receipt: operationCapability("work.observe", "admin.run.receipt"),
  stop: RUN_STOP,
} as const;

const ADMIN_ACTIVITY_CAPABILITIES = {
  list: "activity.overview",
  get: "activity.show",
  messages: "activity.messages",
  events: "activity.events",
  turns: "activity.turns",
  attachments: "activity.attachments",
  "attachment-record": "activity.attachments",
  "attachment-bytes": "activity.attachments",
  text: "activity.text",
} as const satisfies Readonly<Record<string, InterfaceCapabilityId>>;

function adminActivityCapability(
  verb: keyof typeof ADMIN_ACTIVITY_CAPABILITIES,
): Pick<HttpOperationDescriptor, "capability" | "domain" | "effects"> {
  const capabilityId = ADMIN_ACTIVITY_CAPABILITIES[verb];
  if (!capabilityId) throw new Error(`Unknown admin activity capability for ${verb}`);
  return capability(capabilityId);
}

type HttpOperationInput = Omit<HttpOperationDescriptor, "client_surfaces" | "client_omission" | "error_media_type" | "errors" | "successes" | "request_transport">
  & {
    errors?: readonly HttpOperationError[];
    request_transport?: HttpOperationDescriptor["request_transport"];
    response_max_bytes?: number;
  };

type ClientPublication = Pick<HttpOperationDescriptor, "client_surfaces" | "client_omission">;

// Publication authority is an explicit operation-id registry. Profile remains
// an authentication/path law, but it cannot silently add an operation to the
// public package. A future partial/empty consumer or admin publication must be
// represented by an operation-local omission record rather than by changing a
// profile-derived default.
const CONSUMER_CLIENT_OPERATION_IDS = new Set<string>([
  "attention.mark.create",
  "attention.mark.list",
  "attention.mark.revoke",
  "activity.attachments",
  "activity.get",
  "activity.list",
  "activity.messages",
  "activity.text",
  "activity.turns",
  "lease.get",
  "lease.list",
  "monitor.get",
  "monitor.list",
  "monitor.wakes",
  "msg.doctor",
  "msg.inbox",
  "msg.operation",
  "msg.send",
  "msg.text",
  "msg.thread",
  "work.get",
  "work.list",
  "work.observe",
] as const);

const ADMIN_CLIENT_OPERATION_IDS = new Set<string>([
  "admin.activity.attachment-bytes",
  "admin.activity.attachment-bytes-head",
  "admin.activity.attachment-record",
  "admin.activity.attachments",
  "admin.activity.events",
  "admin.activity.get",
  "admin.activity.list",
  "admin.activity.messages",
  "admin.activity.text",
  "admin.activity.turns",
  "admin.events",
  "admin.health",
  "admin.lease.acquire",
  "admin.lease.doctor",
  "admin.lease.list",
  "admin.lease.release",
  "admin.lease.renew",
  "admin.lease.steal",
  "admin.monitor.ack",
  "admin.monitor.cancel",
  "admin.monitor.claim",
  "admin.monitor.create",
  "admin.monitor.get",
  "admin.monitor.list",
  "admin.monitor.wakes",
  "admin.msg.operation",
  "admin.msg.forward",
  "admin.request-audit.doctor",
  "admin.request-audit.list",
  "admin.run.events",
  "admin.run.get",
  "admin.run.launch",
  "admin.run.list",
  "admin.run.logs",
  "admin.run.observation",
  "admin.run.receipt",
  "admin.run.reconcile-preserving",
  "admin.run.stop",
  "admin.self-upgrade.receipt",
  "admin.session-wake.deliver",
] as const);

const INTERNAL_RUNTIME_OPERATION_IDS = new Set<string>([
  "internal.health",
  "internal.metrics",
  "internal.msg.receive",
  "internal.run.reconcile",
  "internal.runtime-config.apply",
  "internal.runtime-config.plan",
  "internal.runtime-config.verify",
] as const);

const CLIENT_PUBLICATION_OMISSIONS = new Map<string, NonNullable<HttpOperationDescriptor["client_omission"]>>([
  // Intentionally empty at this head. New canonical-profile omissions must be
  // registered here with a reason, issue, and expiry before emission.
]);

function clientPublicationForOperation(operationId: string): ClientPublication {
  const omission = CLIENT_PUBLICATION_OMISSIONS.get(operationId);
  if (CONSUMER_CLIENT_OPERATION_IDS.has(operationId)) {
    return { client_surfaces: ["consumer", "admin"], ...(omission ? { client_omission: omission } : {}) };
  }
  if (ADMIN_CLIENT_OPERATION_IDS.has(operationId)) {
    return { client_surfaces: ["admin"], ...(omission ? { client_omission: omission } : {}) };
  }
  if (INTERNAL_RUNTIME_OPERATION_IDS.has(operationId)) {
    if (omission) throw new Error(`Internal operation ${operationId} must not carry client-publication omission metadata.`);
    return { client_surfaces: [] };
  }
  if (omission) {
    // A canonical-profile operation may be withheld from every public package,
    // but only by entering the provenance registry explicitly.
    return { client_surfaces: [], client_omission: omission };
  }
  throw new Error(`HTTP operation ${operationId} is absent from the explicit client-publication registry.`);
}

function operation(
  descriptor: HttpOperationInput,
  successes: readonly HttpOperationSuccess[],
): HttpOperationDescriptor {
  const operationDescriptor = { ...descriptor };
  delete operationDescriptor.response_max_bytes;
  const requestTransport = descriptor.request_transport
    ?? (descriptor.method === "POST"
      ? { body: "json" as const, media_type: "application/json" as const, max_bytes: 1_048_576 }
      : { body: "none" as const });
  const semanticClasses = new Set(successes.map((success) => success.semantics.mutation === "read" ? "read" : "mutation"));
  if (semanticClasses.size !== 1) {
    throw new Error(`HTTP operation ${descriptor.operation_id} mixes read and mutation success semantics`);
  }
  if (descriptor.effects.kind === "by_success") {
    const branchKeys = descriptor.effects.branches.map((branch) => JSON.stringify({
      status: branch.status,
      condition: branch.condition ?? null,
    }));
    const successKeys = successes.map((success) => JSON.stringify({
      status: success.status,
      condition: success.condition ?? null,
    }));
    if (new Set(branchKeys).size !== branchKeys.length
      || branchKeys.length !== successKeys.length
      || successKeys.some((key) => !branchKeys.includes(key))) {
      throw new Error(`HTTP operation ${descriptor.operation_id} effects do not cover its success branches exactly`);
    }
  }
  const mutation = successes.every((success) => success.semantics.mutation !== "read");
  const declaredErrors = [...(descriptor.errors ?? COMMON_ERRORS)];
  if (mutation && !declaredErrors.some((failure) => failure.status === 400 && failure.code === "invalid_request")) {
    declaredErrors.push(error(400, "invalid_request"));
  }
  if (mutation && !declaredErrors.some((failure) => failure.code === "provenance_audit_unavailable")) {
    declaredErrors.push(error(503, "provenance_audit_unavailable"));
  }
  const errors = declaredErrors
    .filter((failure) => requestTransport.body === "json"
      || (failure.code !== "payload_too_large" && failure.code !== "unsupported_media_type"));
  const requestHeaders = [
    ...(descriptor.request_headers ?? []),
    ...(mutation ? [assertedActorRequestHeader] : []),
  ];
  if (descriptor.retry_authority?.kind === "request_target_identity") {
    const placeholders = [...descriptor.path.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]!);
    const declaredPathParameters = descriptor.path_parameters ?? [];
    if (
      descriptor.method !== "DELETE"
      || requestTransport.body !== "none"
      || placeholders.length === 0
      || declaredPathParameters.length !== placeholders.length
      || placeholders.some((name) => !declaredPathParameters.some((parameter) => parameter.name === name))
      || successes.some((success) => (
        success.representation !== "json"
        || success.max_bytes === undefined
        || success.semantics.mutation !== "idempotent_write"
      ))
    ) {
      throw new Error(
        `HTTP operation ${descriptor.operation_id} request-target retry authority requires a bodyless DELETE, validated path parameters, and finite JSON idempotent-write success.`,
      );
    }
  }
  const publication = clientPublicationForOperation(descriptor.operation_id);
  const eligibleSurfaces: readonly ("consumer" | "admin")[] = descriptor.profile === "consumer_v1"
    ? ["consumer", "admin"] as const
    : descriptor.profile === "control_plane_admin_v1"
      ? ["admin"] as const
      : [];
  if (publication.client_surfaces.some((surface) => !eligibleSurfaces.includes(surface))) {
    throw new Error(`HTTP operation ${descriptor.operation_id} publishes outside its authenticated profile.`);
  }
  if (
    descriptor.profile !== "internal_runtime"
    && publication.client_surfaces.length < eligibleSurfaces.length
    && !publication.client_omission
  ) {
    throw new Error(`HTTP operation ${descriptor.operation_id} is omitted from a client surface without provenance.`);
  }
  if (publication.client_omission && publication.client_surfaces.length === eligibleSurfaces.length) {
    throw new Error(`HTTP operation ${descriptor.operation_id} carries stale client-publication omission metadata.`);
  }
  return {
    ...operationDescriptor,
    ...publication,
    request_transport: requestTransport,
    ...(requestHeaders.length > 0 ? { request_headers: requestHeaders } : {}),
    successes,
    error_media_type: "application/json",
    errors,
  };
}

const synchronousRead: HttpOperationSemantics = {
  mutation: "read",
  async: { kind: "synchronous", background: false, waitable: false, resumable: false, cancellable: false },
  receipt: "none",
};
const synchronousWrite: HttpOperationSemantics = {
  mutation: "stateful_write",
  async: { kind: "synchronous", background: false, waitable: false, resumable: false, cancellable: false },
  receipt: "inline_result",
};
const synchronousIdempotentWrite: HttpOperationSemantics = {
  mutation: "idempotent_write",
  async: { kind: "synchronous", background: false, waitable: false, resumable: false, cancellable: false },
  receipt: "inline_result",
};
const asyncSubmit: HttpOperationSemantics = {
  mutation: "submit",
  async: { kind: "submit", background: true, waitable: true, resumable: true, cancellable: true },
  receipt: "accepted_locator",
};
const messageAsyncSubmit: HttpOperationSemantics = {
  mutation: "submit",
  async: { kind: "submit", background: true, waitable: true, resumable: true, cancellable: false },
  receipt: "accepted_locator",
  submission: {
    locator_json_path: "operation.locator",
    observation_operation_id: "msg.operation",
    receipt_schema: "calyx.message-operation-receipt/v1",
  },
};
const streamRead: HttpOperationSemantics = {
  mutation: "read",
  async: { kind: "stream", background: false, waitable: true, resumable: true, cancellable: true },
  receipt: "none",
};

function jsonSuccess(
  schema: string,
  semantics: HttpOperationSemantics,
  status: 200 | 202 = 200,
  mediaType: HttpOperationSuccess["media_type"] = "application/json",
  condition?: HttpOperationSuccess["condition"],
  requestSchema?: string,
  maxBytes = CALYX_HTTP_DEFAULT_JSON_RESPONSE_MAX_BYTES,
): HttpOperationSuccess {
  return {
    status,
    representation: "json",
    schema,
    media_type: mediaType,
    max_bytes: maxBytes,
    semantics,
    ...(condition ? { condition } : {}),
    ...(requestSchema ? { request_schema: requestSchema } : {}),
  };
}

function readOperation(descriptor: HttpOperationInput): HttpOperationDescriptor {
  return operation(descriptor, [jsonSuccess(
    descriptor.response_schema,
    synchronousRead,
    200,
    "application/json",
    undefined,
    undefined,
    descriptor.response_max_bytes,
  )]);
}
function writeOperation(descriptor: HttpOperationInput): HttpOperationDescriptor {
  return operation(descriptor, [jsonSuccess(
    descriptor.response_schema,
    synchronousWrite,
    200,
    "application/json",
    undefined,
    undefined,
    descriptor.response_max_bytes,
  )]);
}
function reconcilableWriteOperation(
  descriptor: HttpOperationInput,
  reconciliationOperationIds: readonly string[],
): HttpOperationDescriptor {
  if (reconciliationOperationIds.length === 0) {
    throw new Error(`HTTP operation ${descriptor.operation_id} requires a named reconciliation projection`);
  }
  return operation(descriptor, [jsonSuccess(
    descriptor.response_schema,
    { ...synchronousWrite, reconciliation_operation_ids: [...reconciliationOperationIds] },
    200,
    "application/json",
    undefined,
    undefined,
    descriptor.response_max_bytes,
  )]);
}
function idempotentWriteOperation(descriptor: HttpOperationInput): HttpOperationDescriptor {
  return operation(descriptor, [jsonSuccess(
    descriptor.response_schema,
    synchronousIdempotentWrite,
    200,
    "application/json",
    undefined,
    undefined,
    descriptor.response_max_bytes,
  )]);
}
function noBodyIdempotentWriteOperation(descriptor: HttpOperationInput): HttpOperationDescriptor {
  return operation({ ...descriptor, request_transport: { body: "none" } }, [jsonSuccess(
    descriptor.response_schema,
    synchronousIdempotentWrite,
    200,
    "application/json",
    undefined,
    undefined,
    descriptor.response_max_bytes,
  )]);
}
function noBodyReconcilableWriteOperation(
  descriptor: HttpOperationInput,
  reconciliationOperationIds: readonly string[],
): HttpOperationDescriptor {
  return reconcilableWriteOperation(
    { ...descriptor, request_transport: { body: "none" } },
    reconciliationOperationIds,
  );
}
function noBodyReadOperation(descriptor: HttpOperationInput): HttpOperationDescriptor {
  return operation({ ...descriptor, request_transport: { body: "none" } }, [jsonSuccess(
    descriptor.response_schema,
    synchronousRead,
    200,
    "application/json",
    undefined,
    undefined,
    descriptor.response_max_bytes,
  )]);
}
function submitOperation(descriptor: HttpOperationInput): HttpOperationDescriptor {
  const runLaunchAccept = "application/vnd.polli.calyx.run-launch-receipt+json;version=1";
  const portableRunSubmit: HttpOperationSemantics = {
    ...asyncSubmit,
    negotiation: {
      request_accept: runLaunchAccept,
    },
    submission: {
      locator_json_path: "operation.route",
      observation_operation_id: "admin.run.get",
      receipt_schema: "calyx.run-receipt/v1",
    },
  };
  return operation(descriptor, [
    jsonSuccess(
      descriptor.response_schema,
      portableRunSubmit,
      202,
      descriptor.operation_id === "admin.run.launch" ? runLaunchAccept : "application/json",
      descriptor.operation_id === "admin.run.launch" ? { request_accept: runLaunchAccept } : undefined,
      descriptor.operation_id === "admin.run.launch" ? "calyx.run-launch-portable-request/v1" : undefined,
    ),
  ]);
}
function streamOperation(descriptor: HttpOperationInput): HttpOperationDescriptor {
  return operation(descriptor, [{
    status: 200,
    representation: "sse",
    schema: descriptor.response_schema,
    media_type: "text/event-stream",
    max_frame_bytes: CALYX_HTTP_SSE_MAX_FRAME_BYTES,
    cursor_field: "cursor",
    semantics: streamRead,
  }]);
}
const attachmentRefSchema = {
  type: "string",
  minLength: 75,
  maxLength: 75,
  pattern: "^att:sha256:[0-9a-f]{64}$",
} as const;
const attachmentRefPathParameters = [{
  name: "ref",
  schema: attachmentRefSchema,
  required: true,
}] as const;
const attachmentHeaders = [
  {
    name: "content-type",
    schema: {
      type: "string",
      minLength: 3,
      maxLength: 255,
      pattern: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$",
    },
    required: true,
  },
  {
    name: "content-length",
    schema: { type: "integer", minimum: 0, maximum: CALYX_ACTIVITY_ATTACHMENT_MAX_BYTES },
    required: true,
  },
  { name: "etag", schema: { type: "string", pattern: "^\"sha256:[0-9a-f]{64}\"$" }, required: true },
  { name: "digest", schema: { type: "string", pattern: "^sha-256=[A-Za-z0-9+/]{43}=$" }, required: true },
  { name: "x-calyx-attachment-ref", schema: attachmentRefSchema, required: true },
  {
    name: "x-calyx-origin-host",
    schema: { type: "string", pattern: API_PROVENANCE_HOST_PATTERN_SOURCE },
    required: false,
  },
  {
    name: "x-calyx-served-by-host",
    schema: { type: "string", pattern: API_PROVENANCE_HOST_PATTERN_SOURCE },
    required: false,
  },
  {
    name: "x-calyx-source-tier",
    schema: {
      type: "string",
      minLength: 1,
      maxLength: CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_MAX_CHARS,
      pattern: CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_PATTERN_SOURCE,
      "x-calyx-enum-mode": "open",
      "x-calyx-known-values": CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_KNOWN_VALUES,
    },
    required: true,
  },
] as const;
const attachmentCustodyContract = {
  schema_version: "calyx.attachment-custody/v1",
  kind: "content_addressed_attachment",
  requested_ref: { in: "path", name: "ref" },
  bindings: [
    { source: "request.path.ref", target: "response.header.x-calyx-attachment-ref", relation: "equals" },
    { source: "response.header.x-calyx-attachment-ref", target: "response.header.etag", relation: "sha256_etag" },
    { source: "response.header.x-calyx-attachment-ref", target: "response.header.digest", relation: "sha256_base64" },
    { source: "response.body", target: "response.header.digest", relation: "sha256_base64" },
  ],
} as const satisfies HttpOperationCustodyContract;
const attachmentHeadCustodyContract = {
  ...attachmentCustodyContract,
  bindings: attachmentCustodyContract.bindings.filter((binding) => (
    binding.source !== "response.body"
  )),
} as const satisfies HttpOperationCustodyContract;
const resumableSseRequestHeaders = [
  {
    name: "Last-Event-ID",
    schema: { type: "string", minLength: 1, maxLength: CALYX_HTTP_SSE_CURSOR_MAX_CHARS },
    required: false,
  },
] as const;
const assertedActorRequestHeader = {
  name: "X-Calyx-Asserted-Actor",
  schema: {
    type: "string",
    minLength: 1,
    maxLength: 256,
    pattern: API_ASSERTED_ACTOR_PATTERN_SOURCE,
  },
  required: false,
} as const;
const requestBodyIdempotencyAuthority = {
  kind: "request_body_field",
  field: "idempotency_key",
} as const satisfies HttpOperationRetryAuthority;
const requestTargetRetryAuthority = {
  kind: "request_target_identity",
} as const satisfies HttpOperationRetryAuthority;
const fixedOperationRetryAuthority = {
  kind: "operation_identity",
} as const satisfies HttpOperationRetryAuthority;
const selfUpgradeReceiptOperationIdPathParameters = [{
  name: "operationId",
  schema: {
    type: "string",
    minLength: 1,
    maxLength: 255,
    pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254})$",
  },
  required: true,
}] as const;
const activityMarkIdPathParameters = [{
  name: "markId",
  schema: {
    type: "string",
    minLength: 41,
    maxLength: 41,
    pattern: "^mark_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  },
  required: true,
}] as const;
function bytesOperation(descriptor: HttpOperationInput): HttpOperationDescriptor {
  return operation(descriptor, [{ status: 200, representation: "bytes", schema: descriptor.response_schema, media_type: "dynamic", max_bytes: CALYX_ACTIVITY_ATTACHMENT_MAX_BYTES, headers: attachmentHeaders, custody: attachmentCustodyContract, semantics: synchronousRead }]);
}
function headOperation(descriptor: HttpOperationInput): HttpOperationDescriptor {
  return operation(descriptor, [{ status: 200, representation: "head", schema: descriptor.response_schema, media_type: null, max_bytes: CALYX_ACTIVITY_ATTACHMENT_MAX_BYTES, headers: attachmentHeaders, custody: attachmentHeadCustodyContract, semantics: synchronousRead }]);
}
function messageSubmitOperation(descriptor: HttpOperationInput): HttpOperationDescriptor {
  return operation(descriptor, [
    jsonSuccess("calyx.msg-send-local-result/v1", synchronousIdempotentWrite, 200, "application/json", { outcome: "local_inert" }),
    jsonSuccess("calyx.msg-send-outbox-result/v1", messageAsyncSubmit, 202, "application/json", { outcome: "cross_host_outbox" }),
  ]);
}

export const HTTP_OPERATION_DESCRIPTORS = [
  readOperation({ ...WORK_OPERATIONS.list, operation_id: "work.list", method: "GET", path: "/v1/runs", profile: "consumer_v1", store_regime: "filesystem_authoritative", request_schema: "calyx.run-list-query/v1", response_schema: "calyx.run-observation-list/v1", summary: "List bounded run observations.", errors: WORK_LIST_ERRORS }),
  readOperation({ ...WORK_OPERATIONS.get, operation_id: "work.get", method: "GET", path: "/v1/runs/{runId}", profile: "consumer_v1", store_regime: "filesystem_authoritative", request_schema: "calyx.empty-query/v1", response_schema: "calyx.run-observation/v1", summary: "Read one bounded work observation.", errors: [...COMMON_ERRORS, error(404, "not_found"), error(409, "activity_ambiguous"), error(503, "activity_projection_not_ready")] }),
  streamOperation({ ...WORK_OPERATIONS.observe, operation_id: "work.observe", method: "GET", path: "/v1/events/observe", profile: "consumer_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.event-observe-query/v1", response_schema: "calyx.run-observation-event/v1", summary: "Observe run projection events.", request_headers: resumableSseRequestHeaders, errors: [...QUERY_ERRORS, error(400, "consumer_event_type_forbidden"), error(400, "invalid_event_cursor")] }),
  readOperation({ ...RECALL_OPERATIONS.list, operation_id: "activity.list", method: "GET", path: "/v1/activity", profile: "consumer_v1", store_regime: "filesystem_authoritative", request_schema: "calyx.activity-list-query/v1", response_schema: "calyx.activity-observation-list/v1", summary: "List bounded activity observations.", errors: CONSUMER_ACTIVITY_LIST_ERRORS }),
  readOperation({ ...RECALL_OPERATIONS.get, operation_id: "activity.get", method: "GET", path: "/v1/activity/{activityId}", profile: "consumer_v1", store_regime: "filesystem_authoritative", request_schema: "calyx.activity-turn-query/v1", response_schema: "activity.turns/v1", summary: "Read bounded activity turns.", errors: CONSUMER_ACTIVITY_ERRORS }),
  readOperation({ ...RECALL_OPERATIONS.messages, operation_id: "activity.messages", method: "GET", path: "/v1/activity/{activityId}/messages", profile: "consumer_v1", store_regime: "filesystem_authoritative", request_schema: "calyx.activity-message-query/v1", response_schema: "activity.messages/v1", summary: "Read consumer-visible activity messages.", errors: CONSUMER_ACTIVITY_ERRORS }),
  readOperation({ ...RECALL_OPERATIONS.turns, operation_id: "activity.turns", method: "GET", path: "/v1/activity/{activityId}/turns", profile: "consumer_v1", store_regime: "filesystem_authoritative", request_schema: "calyx.activity-turn-query/v1", response_schema: "activity.turns/v1", summary: "Read consumer-visible activity turns.", errors: CONSUMER_ACTIVITY_ERRORS }),
  readOperation({ ...RECALL_OPERATIONS.attachments, operation_id: "activity.attachments", method: "GET", path: "/v1/activity/{activityId}/attachments", profile: "consumer_v1", store_regime: "filesystem_authoritative", request_schema: "calyx.activity-attachment-query/v1", response_schema: "activity.attachments/v1", summary: "Read sanitized attachment metadata.", errors: CONSUMER_ACTIVITY_ERRORS }),
  readOperation({ ...RECALL_OPERATIONS.text, operation_id: "activity.text", method: "GET", path: "/v1/activity-text/{messageId}", profile: "consumer_v1", store_regime: "filesystem_authoritative", request_schema: "calyx.activity-text-query/v1", response_schema: "activity.text/v1", summary: "Read a bounded visible message text span.", errors: [...CONSUMER_ACTIVITY_ERRORS, error(404, "activity_message_not_found")] }),
  idempotentWriteOperation({ ...operationCapability("attention.mark", "attention.mark.create"), operation_id: "attention.mark.create", method: "POST", path: "/v1/marks", profile: "consumer_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.activity-mark-create-request/v1", response_schema: "calyx.activity-mark/v1", retry_authority: requestBodyIdempotencyAuthority, summary: "Create or converge one host-local consumer-visible activity mark.", errors: [...WRITE_ERRORS, error(409, "idempotency_conflict"), error(404, "mark_target_unknown"), error(409, "mark_target_ambiguous"), error(503, "activity_marks_schema_unavailable"), error(503, "mark_target_unavailable"), error(503, "provenance_audit_unavailable")] }),
  idempotentWriteOperation({ ...operationCapability("attention.mark", "attention.mark.revoke"), operation_id: "attention.mark.revoke", method: "DELETE", path: "/v1/marks/{markId}", profile: "consumer_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.empty-query/v1", response_schema: "calyx.activity-mark-revocation/v1", retry_authority: requestTargetRetryAuthority, summary: "Revoke one owned activity mark while retaining its history.", request_transport: { body: "none" }, path_parameters: activityMarkIdPathParameters, errors: [...COMMON_ERRORS, error(400, "invalid_request"), error(403, "mark_owner_forbidden"), error(404, "mark_unknown"), error(503, "activity_marks_schema_unavailable"), error(503, "provenance_audit_unavailable")] }),
  readOperation({ ...operationCapability("attention.mark", "attention.mark.list"), operation_id: "attention.mark.list", method: "GET", path: "/v1/marks", profile: "consumer_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.activity-mark-list-query/v1", response_schema: "calyx.activity-mark-list/v1", summary: "List active host-local marks at one mutation-stable snapshot.", errors: [...QUERY_ERRORS, error(503, "activity_marks_schema_unavailable")] }),
  messageSubmitOperation({ ...MSG_SEND, operation_id: "msg.send", method: "POST", path: "/v1/messages/send", profile: "consumer_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.msg-send/v1", response_schema: "calyx.msg-send-result/v1", retry_authority: requestBodyIdempotencyAuthority, summary: "Submit inert correspondence with subject-scoped idempotency.", errors: [...WRITE_ERRORS, error(400, "invalid_reply_address"), error(400, "invalid_recipient_address"), error(400, "scope_expiry_required"), error(403, "address_grant_forbidden"), error(403, "execution_recipient_forbidden"), error(409, "idempotency_conflict"), error(503, "message_schema_unavailable")] }),
  readOperation({ ...MSG_READ, operation_id: "msg.inbox", method: "GET", path: "/v1/messages/inbox", profile: "consumer_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.message-inbox-query/v1", response_schema: "calyx.message-inbox/v1", summary: "Peek caller-authorized inbox rows.", errors: [...QUERY_ERRORS, error(403, "address_grant_forbidden"), error(503, "message_schema_unavailable")] }),
  readOperation({ ...MSG_READ, operation_id: "msg.thread", method: "GET", path: "/v1/messages/threads/{threadKey}", profile: "consumer_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.message-thread-query/v1", response_schema: "calyx.message-thread/v1", summary: "Read authorized rows in one thread.", errors: [...QUERY_ERRORS, error(503, "message_schema_unavailable")] }),
  readOperation({ ...MSG_READ, operation_id: "msg.text", method: "GET", path: "/v1/message-text/{messageId}", profile: "consumer_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.message-text-query/v1", response_schema: "calyx.message-text/v1", summary: "Read one bounded span of an authorized message body.", errors: [...QUERY_ERRORS, error(404, "message_unknown"), error(503, "message_schema_unavailable")] }),
  readOperation({ ...MSG_READ, operation_id: "msg.operation", method: "GET", path: "/v1/message-operations/{outboxId}", profile: "consumer_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.empty-query/v1", response_schema: "calyx.message-operation/v1", summary: "Observe an authorized cross-host message submission and its terminal receipt.", errors: [...COMMON_ERRORS, error(404, "message_operation_unknown"), error(503, "message_schema_unavailable")] }),
  readOperation({ ...MSG_READ, operation_id: "msg.doctor", method: "GET", path: "/v1/messages/doctor", profile: "consumer_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.empty-query/v1", response_schema: "calyx.message-doctor/v1", summary: "Inspect only caller-authorized message counts.", errors: [...COMMON_ERRORS, error(503, "message_schema_unavailable")] }),
  readOperation({ ...capability("monitor.list"), operation_id: "monitor.list", method: "GET", path: "/v1/monitors", profile: "consumer_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.monitor-list-query/v1", response_schema: "calyx.monitor-observation-list/v1", summary: "List bounded monitor observations.", errors: [...QUERY_ERRORS, error(400, "monitor_invalid_status"), MONITOR_SCHEMA_ERROR] }),
  readOperation({ ...capability("monitor.show"), operation_id: "monitor.get", method: "GET", path: "/v1/monitors/{monitorId}", profile: "consumer_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.empty-query/v1", response_schema: "calyx.monitor-observation/v1", summary: "Read one bounded monitor observation.", errors: [...COMMON_ERRORS, error(404, "monitor_unknown"), MONITOR_SCHEMA_ERROR] }),
  readOperation({ ...capability("monitor.inbox"), operation_id: "monitor.wakes", method: "GET", path: "/v1/monitors/wakes", profile: "consumer_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.monitor-wake-query/v1", response_schema: "calyx.wake-observation-list/v1", summary: "List bounded wake observations.", errors: [...QUERY_ERRORS, error(400, "monitor_invalid_wake_status"), MONITOR_SCHEMA_ERROR] }),
  readOperation({ ...capability("lease.list"), operation_id: "lease.list", method: "GET", path: "/v1/leases", profile: "consumer_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.lease-list-query/v1", response_schema: "calyx.lease-observation-list/v1", summary: "List bounded lease observations.", errors: [...QUERY_ERRORS, error(503, "lease_schema_unavailable")] }),
  readOperation({ ...LEASE_OBSERVE, operation_id: "lease.get", method: "GET", path: "/v1/leases/{leaseKey}", profile: "consumer_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.empty-query/v1", response_schema: "calyx.lease-observation/v1", summary: "Read one bounded lease observation.", errors: [...COMMON_ERRORS, error(404, "lease_unknown"), error(503, "lease_schema_unavailable")] }),

  readOperation({ ...DAEMON_HEALTH, operation_id: "internal.health", method: "GET", path: "/v1/internal/health", profile: "internal_runtime", store_regime: "runtime_process", request_schema: "calyx.empty-query/v1", response_schema: "daemon-health/v1", summary: "Read full daemon health.", errors: [...COMMON_ERRORS, error(403, "internal_subject_forbidden")] }),
  readOperation({ ...DAEMON_METRICS, operation_id: "internal.metrics", method: "GET", path: "/v1/internal/metrics", profile: "internal_runtime", store_regime: "runtime_process", request_schema: "calyx.empty-query/v1", response_schema: "daemon-metrics/v1", summary: "Read full daemon metrics.", errors: [...COMMON_ERRORS, error(403, "internal_subject_forbidden")] }),
  readOperation({ ...DAEMON_HEALTH, operation_id: "admin.health", method: "GET", path: "/v1/admin/health", profile: "control_plane_admin_v1", store_regime: "runtime_process", request_schema: "calyx.empty-query/v1", response_schema: "calyx.admin-health/v1", summary: "Read a bounded daemon health projection." }),
  readOperation({ ...SELF_UPGRADE_RECEIPT, operation_id: "admin.self-upgrade.receipt", method: "GET", path: "/v1/admin/self-upgrade-receipts/{operationId}", profile: "control_plane_admin_v1", store_regime: "filesystem_authoritative", request_schema: "calyx.empty-query/v1", response_schema: "self-upgrade-receipt/v1", response_max_bytes: CALYX_SELF_UPGRADE_RECEIPT_MAX_BYTES, summary: "Read one host-authoritative durable self-upgrade receipt.", path_parameters: selfUpgradeReceiptOperationIdPathParameters, errors: [...QUERY_ERRORS, error(404, "self_upgrade_receipt_unknown"), error(422, "self_upgrade_receipt_invalid"), error(503, "self_upgrade_receipt_unavailable")] }),
  readOperation({ ...MSG_ADMIN_OBSERVE, operation_id: "admin.msg.operation", method: "GET", path: "/v1/admin/message-operations/{outboxId}", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.empty-query/v1", response_schema: "calyx.message-operation/v1", summary: "Observe one source-daemon message outbox operation from the resident forwarder's store.", errors: [...COMMON_ERRORS, error(404, "message_operation_unknown"), error(503, "message_outbox_forwarder_unavailable"), error(503, "message_schema_unavailable")] }),
  noBodyReconcilableWriteOperation({ ...MSG_FORWARD, operation_id: "admin.msg.forward", method: "POST", path: "/v1/admin/message-operations/{outboxId}/forward", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.empty/v1", response_schema: "calyx.message-operation/v1", summary: "Ask the source daemon to forward one already-admitted message outbox operation.", errors: [...COMMON_ERRORS, error(404, "message_operation_unknown"), error(503, "message_outbox_forwarder_unavailable"), error(503, "message_schema_unavailable")] }, ["admin.msg.operation"]),
  idempotentWriteOperation({ ...SESSION_WAKE_DELIVER, operation_id: "admin.session-wake.deliver", method: "POST", path: "/v1/admin/session-wakes/deliver", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.session-wake-deliver-request/v1", response_schema: "calyx.session-wake-result/v1", retry_authority: { kind: "request_body_field", field: "delivery_id" }, summary: "Deliver one body-free pointer to an exact activity binding over daemon-local private IPC.", errors: [...WRITE_ERRORS, error(409, "delivery_id_mismatch"), error(503, "session_ingress_schema_unavailable")] }),
  streamOperation({ ...operationCapability("work.observe", "admin.events"), operation_id: "admin.events", method: "GET", path: "/v1/admin/events/stream", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.event-stream-query/v1", response_schema: "calyx.stream-event/v1", summary: "Stream full control-plane events.", request_headers: resumableSseRequestHeaders, errors: [...QUERY_ERRORS, error(400, "invalid_event_cursor")] }),
  readOperation({ ...operationCapability("work.observe", "admin.run.list"), operation_id: "admin.run.list", method: "GET", path: "/v1/admin/runs", profile: "control_plane_admin_v1", store_regime: "filesystem_authoritative", request_schema: "calyx.admin-run-list-query/v1", response_schema: "calyx.run-list/v1", response_max_bytes: CALYX_ADMIN_RUN_LIST_RESPONSE_MAX_BYTES, summary: "List full run records.", errors: [...COMMON_ERRORS, error(503, "activity_projection_not_ready")] }),
  submitOperation({ ...DISPATCH, operation_id: "admin.run.launch", method: "POST", path: "/v1/admin/runs", profile: "control_plane_admin_v1", store_regime: "filesystem_authoritative", request_schema: "calyx.run-launch-portable-request/v1", response_schema: "calyx.run-launch-result/v1", retry_authority: requestBodyIdempotencyAuthority, summary: "Launch a run.", errors: [...WRITE_ERRORS, error(400, "idempotency_key_required"), error(406, "unsupported_accept"), error(409, "idempotency_conflict"), error(409, "idempotency_provenance_unavailable"), error(409, "run_host_mismatch"), error(409, "run_id_conflict"), error(503, "idempotency_schema_unavailable")] }),
  noBodyIdempotentWriteOperation({ ...RUN_RECONCILE, operation_id: "admin.run.reconcile-preserving", method: "POST", path: "/v1/admin/runs/reconcile-preserving/v1", profile: "control_plane_admin_v1", store_regime: "filesystem_authoritative", request_schema: "calyx.empty/v1", response_schema: "calyx.admin-reconcile-result/v1", retry_authority: fixedOperationRetryAuthority, summary: "Convergently reconcile run projections while preserving noncanonical run-root entries.", errors: COMMON_ERRORS }),
  ...(["get", "logs", "events", "observation", "receipt", "stop"] as const).map((verb) => {
    const descriptor = { ...RUN_ADMIN_CAPABILITIES[verb], operation_id: `admin.run.${verb}`, method: verb === "stop" ? "POST" as const : "GET" as const, path: verb === "get" ? "/v1/admin/runs/{runId}" : `/v1/admin/runs/{runId}/${verb}`, profile: "control_plane_admin_v1" as const, store_regime: "filesystem_authoritative" as const, request_schema: verb === "stop" ? "calyx.run-stop-request/v1" : verb === "logs" || verb === "observation" ? "calyx.run-detail-query/v1" : "calyx.empty-query/v1", response_schema: verb === "get" ? "calyx.run-record/v1" : verb === "stop" ? "calyx.run-cancellation-result/v1" : verb === "observation" ? "calyx.admin-run-observation/v1" : `calyx.run-${verb}/v1`, summary: `${verb} full run state.`, errors: verb === "stop" ? [...WRITE_ERRORS, error(404, "not_found")] : (verb === "get" || verb === "receipt" ? [...COMMON_ERRORS, error(404, "not_found")] : (verb === "logs" || verb === "observation" ? QUERY_ERRORS : COMMON_ERRORS)) };
    return verb === "stop"
      ? reconcilableWriteOperation(descriptor, ["admin.run.get"])
      : readOperation(descriptor);
  }),
  noBodyIdempotentWriteOperation({ ...RUN_RECONCILE, operation_id: "internal.run.reconcile", method: "POST", path: "/v1/internal/runs/reconcile", profile: "internal_runtime", store_regime: "filesystem_authoritative", request_schema: "calyx.empty/v1", response_schema: "calyx.run-reconcile/v1", retry_authority: fixedOperationRetryAuthority, summary: "Convergently reconcile daemon-owned run state.", errors: [...COMMON_ERRORS, error(403, "internal_subject_forbidden")] }),
  ...(["list", "get", "messages", "events", "turns", "attachments", "attachment-record", "attachment-bytes", "text"] as const).map((verb) => {
    const paths: Record<string, string> = {
      list: "/v1/admin/activity", get: "/v1/admin/activity/{activityId}", messages: "/v1/admin/activity/{activityId}/messages", events: "/v1/admin/activity/{activityId}/events", turns: "/v1/admin/activity/{activityId}/turns", attachments: "/v1/admin/activity/{activityId}/attachments", "attachment-record": "/v1/admin/activity/{activityId}/attachments/{ref}", "attachment-bytes": "/v1/admin/activity/{activityId}/attachments/{ref}/bytes", text: "/v1/admin/activity-text/{messageId}",
    };
    const activityErrors = verb === "attachment-record"
      ? ADMIN_ATTACHMENT_RECORD_ERRORS
      : verb === "attachment-bytes"
        ? ADMIN_ATTACHMENT_BYTES_ERRORS
        : verb === "attachments"
          ? ADMIN_ATTACHMENT_LIST_ERRORS
          : verb === "list" ? QUERY_ERRORS : ADMIN_ACTIVITY_ERRORS;
    return (verb === "attachment-bytes" ? bytesOperation : readOperation)({ ...adminActivityCapability(verb), operation_id: `admin.activity.${verb}`, method: "GET", path: paths[verb]!, profile: "control_plane_admin_v1", store_regime: "filesystem_authoritative", request_schema: verb === "attachment-record" || verb === "attachment-bytes" ? "calyx.empty-query/v1" : `calyx.admin-activity-${verb}-query/v1`, response_schema: `calyx.admin-activity-${verb}/v1`, summary: `Read privileged activity ${verb}.`, errors: activityErrors, ...(verb === "attachment-record" || verb === "attachment-bytes" ? { path_parameters: attachmentRefPathParameters } : {}) });
  }),
  headOperation({ ...adminActivityCapability("attachment-bytes"), operation_id: "admin.activity.attachment-bytes-head", method: "HEAD", path: "/v1/admin/activity/{activityId}/attachments/{ref}/bytes", profile: "control_plane_admin_v1", store_regime: "filesystem_authoritative", request_schema: "calyx.empty-query/v1", response_schema: "calyx.admin-activity-attachment-bytes/v1", summary: "Read privileged attachment byte metadata.", errors: ADMIN_ATTACHMENT_BYTES_ERRORS, path_parameters: attachmentRefPathParameters }),
  readOperation({ ...REQUEST_AUDIT, operation_id: "admin.request-audit.list", method: "GET", path: "/v1/admin/request-audit", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.request-audit-query/v1", response_schema: "calyx.request-audit-list/v1", summary: "List bounded HTTP mutation request-attribution rows.", errors: [...QUERY_ERRORS, error(503, "provenance_audit_unavailable")] }),
  readOperation({ ...REQUEST_AUDIT, operation_id: "admin.request-audit.doctor", method: "GET", path: "/v1/admin/request-audit/doctor", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.empty-query/v1", response_schema: "calyx.request-audit-doctor/v1", summary: "Inspect HTTP mutation request-attribution schema and retention state.", errors: [...COMMON_ERRORS, error(503, "provenance_audit_unavailable")] }),
  readOperation({ ...capability("monitor.list"), operation_id: "admin.monitor.list", method: "GET", path: "/v1/admin/monitors", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.monitor-list-request/v1", response_schema: "calyx.monitor-list/v1", summary: "List full monitor state.", errors: [...QUERY_ERRORS, error(400, "monitor_invalid_status"), MONITOR_SCHEMA_ERROR] }),
  idempotentWriteOperation({ ...capability("monitor.create"), operation_id: "admin.monitor.create", method: "POST", path: "/v1/admin/monitors", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.monitor-create-request/v1", response_schema: "calyx.monitor-create/v1", retry_authority: requestBodyIdempotencyAuthority, summary: "Create full monitor state.", errors: [...WRITE_ERRORS, error(400, "monitor_invalid_request"), error(404, "monitor_run_unknown"), error(409, "monitor_assigned_host_mismatch"), error(409, "idempotency_conflict"), MONITOR_SCHEMA_ERROR] }),
  readOperation({ ...capability("monitor.show"), operation_id: "admin.monitor.get", method: "GET", path: "/v1/admin/monitors/{monitorId}", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.empty-query/v1", response_schema: "calyx.monitor-get/v1", summary: "Read full monitor state.", errors: [...COMMON_ERRORS, error(404, "monitor_unknown"), MONITOR_SCHEMA_ERROR] }),
  readOperation({ ...capability("monitor.inbox"), operation_id: "admin.monitor.wakes", method: "GET", path: "/v1/admin/monitors/wakes", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.monitor-wakes-request/v1", response_schema: "calyx.monitor-wakes/v1", summary: "List full monitor wake state.", errors: [...QUERY_ERRORS, error(400, "monitor_invalid_wake_status"), MONITOR_SCHEMA_ERROR] }),
  idempotentWriteOperation({ ...operationCapability("monitor.inbox", "admin.monitor.claim"), operation_id: "admin.monitor.claim", method: "POST", path: "/v1/admin/monitors/wakes", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.monitor-claim-request/v1", response_schema: "calyx.monitor-wakes/v1", retry_authority: requestBodyIdempotencyAuthority, summary: "Claim pending monitor wakes for one actor.", errors: [...WRITE_ERRORS, error(400, "monitor_invalid_request"), error(409, "idempotency_conflict"), MONITOR_SCHEMA_ERROR] }),
  reconcilableWriteOperation({ ...capability("monitor.ack"), operation_id: "admin.monitor.ack", method: "POST", path: "/v1/admin/monitors/wakes/{wakeId}/ack", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.monitor-ack-request/v1", response_schema: "calyx.monitor-ack/v1", summary: "Acknowledge a monitor wake held by the exact claimant.", errors: [...WRITE_ERRORS, error(400, "monitor_invalid_request"), error(404, "monitor_wake_unknown"), error(409, "monitor_wake_not_claimed"), error(409, "monitor_wake_claimant_mismatch"), error(409, "monitor_wake_claim_expired"), MONITOR_SCHEMA_ERROR] }, ["admin.monitor.wakes"]),
  reconcilableWriteOperation({ ...capability("monitor.cancel"), operation_id: "admin.monitor.cancel", method: "POST", path: "/v1/admin/monitors/{monitorId}/cancel", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.monitor-cancel-request/v1", response_schema: "calyx.monitor-cancel/v1", summary: "Cancel full monitor state.", errors: [...WRITE_ERRORS, error(400, "monitor_invalid_request"), error(404, "monitor_unknown"), MONITOR_SCHEMA_ERROR] }, ["admin.monitor.get"]),
  idempotentWriteOperation({ ...capability("lease.acquire"), operation_id: "admin.lease.acquire", method: "POST", path: "/v1/admin/leases/acquire", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.lease-acquire-request/v1", response_schema: "calyx.lease-acquire/v1", retry_authority: requestBodyIdempotencyAuthority, summary: "Acquire lease state.", errors: [...WRITE_ERRORS, error(409, "lease_conflict"), error(409, "lease_owner_mismatch"), error(409, "idempotency_conflict"), error(503, "lease_schema_unavailable")] }),
  idempotentWriteOperation({ ...capability("lease.renew"), operation_id: "admin.lease.renew", method: "POST", path: "/v1/admin/leases/renew", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.lease-renew-request/v1", response_schema: "calyx.lease-renew/v1", retry_authority: requestBodyIdempotencyAuthority, summary: "Renew lease state.", errors: [...WRITE_ERRORS, error(404, "lease_conflict"), error(409, "lease_conflict"), error(409, "lease_owner_mismatch"), error(409, "idempotency_conflict"), error(503, "lease_schema_unavailable")] }),
  idempotentWriteOperation({ ...capability("lease.release"), operation_id: "admin.lease.release", method: "POST", path: "/v1/admin/leases/release", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.lease-release-request/v1", response_schema: "calyx.lease-release/v1", retry_authority: requestBodyIdempotencyAuthority, summary: "Release lease state.", errors: [...WRITE_ERRORS, error(404, "lease_conflict"), error(409, "lease_conflict"), error(409, "lease_owner_mismatch"), error(409, "idempotency_conflict"), error(503, "lease_schema_unavailable")] }),
  idempotentWriteOperation({ ...capability("lease.steal"), operation_id: "admin.lease.steal", method: "POST", path: "/v1/admin/leases/steal", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.lease-steal-request/v1", response_schema: "calyx.lease-steal/v1", retry_authority: requestBodyIdempotencyAuthority, summary: "Steal lease state.", errors: [...WRITE_ERRORS, error(409, "lease_owner_mismatch"), error(409, "idempotency_conflict"), error(503, "lease_schema_unavailable")] }),
  readOperation({ ...capability("lease.list"), operation_id: "admin.lease.list", method: "POST", path: "/v1/admin/leases/list", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.lease-list-request/v1", response_schema: "calyx.lease-list/v1", summary: "List lease state.", errors: [...WRITE_ERRORS, error(409, "lease_owner_mismatch"), error(503, "lease_schema_unavailable")] }),
  noBodyReadOperation({ ...capability("lease.doctor"), operation_id: "admin.lease.doctor", method: "POST", path: "/v1/admin/leases/doctor", profile: "control_plane_admin_v1", store_regime: "sqlite_authoritative", request_schema: "calyx.lease-doctor-request/v1", response_schema: "calyx.lease-doctor/v1", summary: "Inspect lease schema state.", errors: [...COMMON_ERRORS, error(503, "lease_schema_unavailable")] }),
  readOperation({ ...RUNTIME_CONFIG_PLAN, operation_id: "internal.runtime-config.plan", method: "POST", path: "/v1/internal/runtime-config/plan", profile: "internal_runtime", store_regime: "runtime_process", request_schema: "calyx.runtime-config-request/v1", response_schema: "calyx.runtime-config-result/v1", summary: "Plan runtime configuration.", errors: [...WRITE_ERRORS, error(403, "internal_subject_forbidden"), error(409, "conflict")] }),
  writeOperation({ ...RUNTIME_CONFIG_APPLY, operation_id: "internal.runtime-config.apply", method: "POST", path: "/v1/internal/runtime-config/apply", profile: "internal_runtime", store_regime: "runtime_process", request_schema: "calyx.runtime-config-request/v1", response_schema: "calyx.runtime-config-result/v1", summary: "Apply runtime configuration.", errors: [...WRITE_ERRORS, error(403, "internal_subject_forbidden"), error(409, "conflict"), error(409, "runtime_config_apply_in_progress")] }),
  readOperation({ ...RUNTIME_CONFIG_VERIFY, operation_id: "internal.runtime-config.verify", method: "POST", path: "/v1/internal/runtime-config/verify", profile: "internal_runtime", store_regime: "runtime_process", request_schema: "calyx.runtime-config-request/v1", response_schema: "calyx.runtime-config-result/v1", summary: "Verify runtime configuration.", errors: [...WRITE_ERRORS, error(403, "internal_subject_forbidden"), error(409, "conflict")] }),
  writeOperation({ ...MSG_RECEIVE, operation_id: "internal.msg.receive", method: "POST", path: "/v1/internal/messages/receive", profile: "internal_runtime", store_regime: "sqlite_authoritative", request_schema: "calyx.msg-forward/v1", response_schema: "calyx.msg-receive/v1", summary: "Persist inert daemon-to-daemon correspondence on the recipient host.", errors: [...WRITE_ERRORS, error(403, "internal_origin_forbidden"), error(403, "internal_target_forbidden"), error(409, "message_identity_conflict"), error(503, "message_schema_unavailable")] }),
] as const satisfies readonly HttpOperationDescriptor[];

function assertClientPublicationRegistryExhaustive(
  descriptors: readonly HttpOperationDescriptor[],
): void {
  const registries = [
    CONSUMER_CLIENT_OPERATION_IDS,
    ADMIN_CLIENT_OPERATION_IDS,
    INTERNAL_RUNTIME_OPERATION_IDS,
  ] as const;
  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.operation_id, descriptor]));
  const classified = new Set<string>();
  for (const registry of registries) {
    for (const operationId of registry) {
      if (classified.has(operationId)) {
        throw new Error(`HTTP operation ${operationId} appears in multiple client-publication registries.`);
      }
      if (!descriptorById.has(operationId)) {
        throw new Error(`Client-publication registry contains stale operation ${operationId}.`);
      }
      classified.add(operationId);
    }
  }
  for (const [operationId, omission] of CLIENT_PUBLICATION_OMISSIONS) {
    const descriptor = descriptorById.get(operationId);
    if (!descriptor) {
      throw new Error(`Client-publication omission registry contains stale operation ${operationId}.`);
    }
    if (descriptor.profile === "internal_runtime") {
      throw new Error(`Internal operation ${operationId} must not enter the client-publication omission registry.`);
    }
    if (descriptor.client_omission !== omission) {
      throw new Error(`HTTP operation ${operationId} did not consume its exact client-publication omission record.`);
    }
  }
  for (const descriptor of descriptors) {
    const hasClassification = classified.has(descriptor.operation_id);
    const hasOmission = CLIENT_PUBLICATION_OMISSIONS.has(descriptor.operation_id);
    if (!hasClassification && !hasOmission) {
      throw new Error(`HTTP operation ${descriptor.operation_id} is absent from publication and omission registries.`);
    }
    if ((descriptor.client_omission !== undefined) !== hasOmission) {
      throw new Error(`HTTP operation ${descriptor.operation_id} has inconsistent client-publication omission authority.`);
    }
  }
}

assertClientPublicationRegistryExhaustive(HTTP_OPERATION_DESCRIPTORS);

function assertUnkeyedWriteReconciliationExhaustive(
  descriptors: readonly HttpOperationDescriptor[],
): void {
  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.operation_id, descriptor]));
  for (const descriptor of descriptors) {
    const mappings = descriptor.successes.map((success) => success.semantics.reconciliation_operation_ids);
    const isUnkeyedStatefulWrite = descriptor.client_surfaces.length > 0
      && descriptor.method === "POST"
      && descriptor.retry_authority === undefined
      && descriptor.successes.length > 0
      && descriptor.successes.every((success) => success.semantics.mutation === "stateful_write");
    if (!isUnkeyedStatefulWrite) {
      if (mappings.some((mapping) => mapping !== undefined)) {
        throw new Error(`HTTP operation ${descriptor.operation_id} carries forbidden unkeyed reconciliation metadata.`);
      }
      continue;
    }
    const reconciliationIds = mappings[0] ?? [];
    if (
      reconciliationIds.length === 0
      || new Set(reconciliationIds).size !== reconciliationIds.length
      || mappings.some((mapping) => JSON.stringify(mapping) !== JSON.stringify(reconciliationIds))
    ) {
      throw new Error(`Client-projected unkeyed write ${descriptor.operation_id} lacks one exact unique reconciliation mapping.`);
    }
    for (const operationId of reconciliationIds) {
      const reconciliation = descriptorById.get(operationId);
      if (
        operationId === descriptor.operation_id
        || !reconciliation
        || !reconciliation.successes.every((candidate) => candidate.semantics.mutation === "read")
        || !descriptor.client_surfaces.every((surface) => reconciliation.client_surfaces.includes(surface))
      ) {
        throw new Error(
          `Client-projected unkeyed write ${descriptor.operation_id} names invalid reconciliation operation ${operationId}.`,
        );
      }
    }
  }
}

assertUnkeyedWriteReconciliationExhaustive(HTTP_OPERATION_DESCRIPTORS);

function pathPattern(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\{[^/]+\\\}/g, "[^/]+")}$`);
}

export function httpOperationMatchesPath(descriptor: HttpOperationDescriptor, pathname: string): boolean {
  return pathPattern(descriptor.path).test(pathname);
}

function pathSpecificity(path: string): number {
  return path.split("/").reduce((score, segment) => (
    score + (segment.startsWith("{") ? 0 : segment.length + 1)
  ), 0);
}

export function resolveHttpOperation(method: string | undefined, pathname: string): HttpOperationDescriptor | undefined {
  return HTTP_OPERATION_DESCRIPTORS
    .filter((descriptor) => descriptor.method === method && httpOperationMatchesPath(descriptor, pathname))
    .sort((left, right) => pathSpecificity(right.path) - pathSpecificity(left.path))[0];
}

export function resolveHttpPathProfile(pathname: string): InterfaceProfile | undefined {
  return HTTP_OPERATION_DESCRIPTORS
    .filter((descriptor) => httpOperationMatchesPath(descriptor, pathname))
    .sort((left, right) => pathSpecificity(right.path) - pathSpecificity(left.path))[0]?.profile;
}

export function assertHttpOperationErrorDeclared(
  operationId: string,
  status: number,
  code: string,
): void {
  const descriptor = HTTP_OPERATION_DESCRIPTORS.find((candidate) => candidate.operation_id === operationId);
  if (!descriptor?.errors.some((failure) => failure.status === status && failure.code === code)) {
    throw new Error(`Operation ${operationId} emitted undeclared error ${status}:${code}.`);
  }
}
