export const API_PROVENANCE_SCHEMA_VERSION = "calyx.provenance/v1" as const;

export interface ApiProvenanceV1 {
  schema_version: typeof API_PROVENANCE_SCHEMA_VERSION;
  request_id: string;
  subject: string;
  asserted_actor?: string | undefined;
  host: string;
  via: "http";
  at: string;
}

function required(label: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${label} must be a non-empty canonical string`);
  }
  return value;
}

export const API_REQUEST_ID_PATTERN_SOURCE = "^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const REQUEST_ID_PATTERN = new RegExp(API_REQUEST_ID_PATTERN_SOURCE);
export const API_PROVENANCE_SUBJECT_PATTERN_SOURCE = "^[a-z][a-z0-9_.:-]*$";
export const API_PROVENANCE_HOST_PATTERN_SOURCE = "^(?:[a-z0-9][a-z0-9.-]*|[0-9a-f:]+)$";
const SUBJECT_PATTERN = new RegExp(API_PROVENANCE_SUBJECT_PATTERN_SOURCE);
const HOST_PATTERN = new RegExp(API_PROVENANCE_HOST_PATTERN_SOURCE);
export const API_ASSERTED_ACTOR_PATTERN_SOURCE = "^(?:operator:[a-z0-9][a-z0-9._-]*|run:[a-z0-9][a-z0-9._:-]*|interactive:(?:codex|claude):[A-Za-z0-9][A-Za-z0-9._:-]*)$";
const ASSERTED_ACTOR_PATTERN = new RegExp(API_ASSERTED_ACTOR_PATTERN_SOURCE);

export function validateApiAssertedActor(value: string): string {
  const actor = required("asserted actor", value);
  if (Buffer.byteLength(actor, "utf8") > 256 || !ASSERTED_ACTOR_PATTERN.test(actor)) {
    throw new Error("asserted actor must be operator:<handle>, run:<run-id>, or interactive:(codex|claude):<backend-session-id>");
  }
  return actor;
}

export function isCanonicalApiTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function validateApiProvenance(value: ApiProvenanceV1): ApiProvenanceV1 {
  if (value.schema_version !== API_PROVENANCE_SCHEMA_VERSION) {
    throw new Error(`provenance schema_version must be ${API_PROVENANCE_SCHEMA_VERSION}`);
  }
  if (value.via !== "http") throw new Error("provenance via must be http");
  const at = required("provenance at", value.at);
  if (!isCanonicalApiTimestamp(at)) {
    throw new Error("provenance at must be a canonical UTC ISO timestamp");
  }
  const requestId = required("provenance request_id", value.request_id);
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("provenance request_id must be req_<uuid-v4>");
  const subject = required("provenance subject", value.subject);
  if (!SUBJECT_PATTERN.test(subject)) throw new Error("provenance subject must be a canonical credential client_id");
  const host = required("provenance host", value.host);
  if (!HOST_PATTERN.test(host)) throw new Error("provenance host must be canonical");
  const assertedActor = value.asserted_actor === undefined
    ? undefined
    : validateApiAssertedActor(value.asserted_actor);
  return {
    schema_version: API_PROVENANCE_SCHEMA_VERSION,
    request_id: requestId,
    subject,
    ...(assertedActor ? { asserted_actor: assertedActor } : {}),
    host,
    via: "http",
    at,
  };
}

export function parseApiProvenanceJson(value: string): ApiProvenanceV1 {
  const parsed = JSON.parse(value) as ApiProvenanceV1;
  return validateApiProvenance(parsed);
}
