declare const unknownEnumBrand: unique symbol;

/** A response enum value introduced after this client contract was generated. */
export type CalyxUnknownEnumValue = string & {
  readonly [unknownEnumBrand]: "CalyxUnknownEnumValue";
};

export interface CalyxErrorBody<Code extends string = string> {
  schema_version: "calyx.error/v1";
  code: Code | CalyxUnknownEnumValue;
  message: string;
  details?: Record<string, unknown>;
  hint?: string;
  retryable?: boolean;
}

export interface CalyxErrorEnvelope<Code extends string = string> {
  error: CalyxErrorBody<Code>;
}

export interface CalyxSuccess<T> {
  ok: true;
  status: number;
  data: T;
  requestId: string;
  attempts: number;
}

export interface CalyxApiFailure<Code extends string = string> {
  ok: false;
  kind: "api";
  status: number;
  error: CalyxErrorEnvelope<Code>;
  requestId: string;
  attempts: number;
}

export interface CalyxTransportFailure {
  ok: false;
  kind: "transport";
  stage: "token" | "network" | "aborted" | "recovery_store";
  message: string;
  attempts: number;
}

export interface CalyxProtocolFailure {
  ok: false;
  kind: "protocol";
  stage:
    | "redirect_refused"
    | "unexpected_status"
    | "unexpected_media_type"
    | "invalid_utf8"
    | "duplicate_json_member"
    | "invalid_json"
    | "invalid_error_envelope"
    | "invalid_response"
    | "response_too_large"
    | "custody_mismatch"
    | "schema_major_mismatch"
    | "missing_required_header";
  message: string;
  status: number;
  requestId?: string;
  attempts: number;
  /** First at most 2 KiB of the Fetch-visible response body, decoded lossily as UTF-8. */
  rawBodySnippet: string;
  /**
   * Fetch-visible response-body bytes observed before EOF, cancellation, or the
   * evidence sampling bound. Exact only when rawBodyComplete is true.
   */
  rawBodyBytes: number;
  /** Whether EOF was observed, making rawBodyBytes the exact original body length. */
  rawBodyComplete: boolean;
  /** Explicitly allowlisted, bounded response metadata; never credential-bearing headers. */
  responseHeaders: Readonly<Record<string, string>>;
}

export interface CalyxIndeterminateReceipt {
  schema_version: "calyx.client-indeterminate-result/v1";
  /** Exact request bytes make every replay receipt sensitive application data. */
  payload_sensitivity: "sensitive_request_payload";
  /** HMAC authority binds this receipt to the client instance that issued it. */
  integrity_algorithm: "HMAC-SHA-256";
  integrity_tag: string;
  /** Opaque HMAC binding to the exact bearer credential used for admission. */
  credential_binding: string;
  /** Replay-relevant request contract for operation_id; unrelated API edits do not strand receipts. */
  contract_digest: string;
  operation_id: string;
  method: string;
  origin: string;
  base_path: string;
  path: string;
  safe_headers: Readonly<Record<string, string>>;
  body_bytes: string;
  idempotency_key: string;
  attempts: number;
  failure_stage: string;
  last_http_status?: number;
  last_request_id?: string;
}

export interface CalyxIndeterminateFailure {
  ok: false;
  kind: "indeterminate";
  receipt: CalyxIndeterminateReceipt;
  /** Durable custody failed, but the immutable replay identity remains available here. */
  persistenceFailure?: {
    stage: "recovery_store";
    message: string;
  };
  requestId?: string;
  attempts: number;
}

/**
 * A stateful write without replay authority lost server-authoritative result
 * evidence after dispatch. The request must not be retried; callers reconcile
 * through the operation's named read projection.
 */
export interface CalyxUnkeyedIndeterminateFailure {
  ok: false;
  kind: "unkeyed_indeterminate";
  /** Generated operation whose admission/result became unknowable. */
  operationId: string;
  /** Unkeyed writes are dispatched exactly once and are never replayed. */
  attempts: 1;
  /** Complete bounded evidence retained from the non-authoritative outcome. */
  cause:
    | (CalyxTransportFailure & { stage: "network" | "aborted"; attempts: 1 })
    | (CalyxProtocolFailure & { attempts: 1 });
  reconciliation: {
    kind: "read_projection";
    /** Generated operation IDs; clients must not invent a caller-local retry dialect. */
    operationIds: readonly [string, ...string[]];
    /** Missing or unchanged read state never proves that the write was not admitted. */
    absence: "inconclusive";
  };
}

export type CalyxResult<T, Code extends string = string> =
  | CalyxSuccess<T>
  | CalyxApiFailure<Code>
  | CalyxTransportFailure
  | CalyxProtocolFailure
  | CalyxIndeterminateFailure
  | CalyxUnkeyedIndeterminateFailure;

/** Configuration failures are local and occur before a request can be sent. */
export class CalyxClientConfigurationError extends Error {
  override readonly name = "CalyxClientConfigurationError";
}
