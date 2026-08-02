import type { StateDriverDatabase } from "./driver";
import {
  parseApiProvenanceJson,
  validateApiProvenance,
  type ApiProvenanceV1,
} from "./provenance";

export const API_IDEMPOTENCY_CANONICALIZER = "jcs-rfc8785/v1";
export const API_IDEMPOTENCY_SCHEMA_MAJOR = 1;

export interface ApiIdempotencyRow {
  subject: string;
  operation_id: string;
  idempotency_key: string;
  asserted_actor: string | null;
  first_request_id: string | null;
  first_request_provenance: ApiProvenanceV1 | null;
  wire_request_hash: string | null;
  request_hash: string;
  canonicalizer: typeof API_IDEMPOTENCY_CANONICALIZER;
  schema_major: typeof API_IDEMPOTENCY_SCHEMA_MAJOR;
  semantic_canonicalizer: string | null;
  response_status: number;
  response: unknown;
  created_at: string;
}

export interface RecordApiIdempotencyInput {
  subject: string;
  operation_id: string;
  idempotency_key: string;
  asserted_actor?: string | undefined;
  first_request_id?: string | undefined;
  first_request_provenance?: ApiProvenanceV1 | undefined;
  wire_request_hash?: string | undefined;
  request_hash: string;
  semantic_canonicalizer?: string | undefined;
  response_status: number;
  response: unknown;
  created_at?: string | undefined;
}

function normalizeRequired(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must be non-empty`);
  }
  return trimmed;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function readApiIdempotency(
  db: StateDriverDatabase,
  subject: string,
  operationId: string,
  idempotencyKey: string,
): ApiIdempotencyRow | undefined {
  const normalizedSubject = normalizeRequired("subject", subject);
  const normalizedOperationId = normalizeRequired("operation_id", operationId);
  const normalizedIdempotencyKey = normalizeRequired("idempotency_key", idempotencyKey);
  const row = db.prepare(
    `SELECT subject, operation_id, idempotency_key, asserted_actor, first_request_id,
            first_request_provenance_json, wire_request_hash, request_hash,
            canonicalizer, schema_major, semantic_canonicalizer,
            response_status, response_json, created_at
       FROM api_idempotency
      WHERE subject = ? AND operation_id = ? AND idempotency_key = ?`,
  ).get(normalizedSubject, normalizedOperationId, normalizedIdempotencyKey) as {
    subject: string;
    operation_id: string;
    idempotency_key: string;
    asserted_actor: string | null;
    first_request_id: string | null;
    first_request_provenance_json: string | null;
    wire_request_hash: string | null;
    request_hash: string;
    canonicalizer: string;
    schema_major: number | bigint;
    semantic_canonicalizer: string | null;
    response_status: number | bigint;
    response_json: string;
    created_at: string;
  } | undefined;
  return row ? {
    subject: row.subject,
    operation_id: row.operation_id,
    idempotency_key: row.idempotency_key,
    asserted_actor: row.asserted_actor,
    first_request_id: row.first_request_id,
    first_request_provenance: row.first_request_provenance_json
      ? parseApiProvenanceJson(row.first_request_provenance_json)
      : null,
    wire_request_hash: row.wire_request_hash,
    request_hash: row.request_hash,
    canonicalizer: row.canonicalizer as typeof API_IDEMPOTENCY_CANONICALIZER,
    schema_major: Number(row.schema_major) as typeof API_IDEMPOTENCY_SCHEMA_MAJOR,
    semantic_canonicalizer: row.semantic_canonicalizer,
    response_status: Number(row.response_status),
    response: parseJson(row.response_json),
    created_at: row.created_at,
  } : undefined;
}

export function recordApiIdempotency(
  db: StateDriverDatabase,
  input: RecordApiIdempotencyInput,
): ApiIdempotencyRow {
  const subject = normalizeRequired("subject", input.subject);
  const provenance = input.first_request_provenance
    ? validateApiProvenance(input.first_request_provenance)
    : undefined;
  if (provenance && provenance.subject !== subject) {
    throw new Error("first request provenance subject must match the idempotency subject");
  }
  const assertedActor = input.asserted_actor?.trim() || provenance?.asserted_actor || null;
  if (provenance && assertedActor !== (provenance.asserted_actor ?? null)) {
    throw new Error("first request provenance asserted_actor must match the idempotency asserted_actor");
  }
  const firstRequestId = input.first_request_id?.trim() || provenance?.request_id || null;
  if (provenance && firstRequestId !== provenance.request_id) {
    throw new Error("first request provenance request_id must match the idempotency first_request_id");
  }
  db.prepare(
    `INSERT INTO api_idempotency
      (subject, operation_id, idempotency_key, asserted_actor, first_request_id,
        first_request_provenance_json, wire_request_hash, request_hash,
        canonicalizer, schema_major, semantic_canonicalizer, response_status,
        response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    subject,
    normalizeRequired("operation_id", input.operation_id),
    normalizeRequired("idempotency_key", input.idempotency_key),
    assertedActor,
    firstRequestId,
    provenance ? JSON.stringify(provenance) : null,
    input.wire_request_hash ?? null,
    input.request_hash,
    API_IDEMPOTENCY_CANONICALIZER,
    API_IDEMPOTENCY_SCHEMA_MAJOR,
    input.semantic_canonicalizer ?? null,
    input.response_status,
    JSON.stringify(input.response),
    input.created_at ?? new Date().toISOString(),
  );
  return readApiIdempotency(db, input.subject, input.operation_id, input.idempotency_key)!;
}
