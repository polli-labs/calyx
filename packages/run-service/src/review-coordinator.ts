import { createHash } from "node:crypto";

import type { StateDriverDatabase } from "@polli-labs/calyx-core";
import { ALL_STATES, type RunState } from "@polli-labs/calyx-runner";
import {
  normalizeReviewLaunchRequest,
  type ReviewLaunchRequestV1,
} from "./review-launch-request.js";
import {
  deriveReviewPublicationRequest,
  type ReviewPublisherIdentities,
} from "./review-publication.js";

export { REVIEW_LAUNCH_REQUEST_SCHEMA_VERSION } from "./review-launch-request.js";
export { REVIEW_PUBLICATION_REQUEST_SCHEMA_VERSION } from "./review-publication.js";

/**
 * Caller A's first durable state machine. These are intentionally review nouns,
 * not provisional aliases for a generic workflow engine. RunService remains
 * authoritative for the reviewer run; this module records only caller-owned
 * request, attempt, intrinsic evidence, publication, and decision state.
 */

export const INDEPENDENT_REVIEW_REQUEST_SCHEMA_VERSION =
  "calyx.independent-review-request/v1";
export const INDEPENDENT_REVIEW_PROJECTION_SCHEMA_VERSION =
  "calyx.independent-review-admin-projection/v1";
export const REVIEW_FINDINGS_SCHEMA_VERSION = "review-findings/v2";
export const REVIEW_EVIDENCE_SCHEMA_VERSION = "calyx.review-evidence/v1";
export const REVIEW_RUN_EVIDENCE_RECEIPT_SCHEMA_VERSION =
  "calyx.review-run-evidence-receipt/v1";
export const REVIEW_PROVIDER_OBSERVATION_SCHEMA_VERSION =
  "calyx.review-provider-observation/v1";
export const REVIEW_LAUNCH_RECONCILIATION_OBSERVATION_SCHEMA_VERSION =
  "calyx.review-launch-reconciliation-observation/v1";

const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_REVIEW_ARTIFACT_BYTES = 1_048_576;
const MAX_REVIEW_FINDINGS = 1_000;
const MAX_REVIEW_ID_BYTES = 256;
const MAX_REVIEW_SUBJECT_BYTES = 512;
const MAX_REVIEW_ACTOR_BYTES = 256;
const MAX_POLICY_VERSION_BYTES = 256;
const MAX_REPOSITORY_BYTES = 512;
const MAX_LAUNCH_REQUEST_BYTES = 262_144;
const MAX_FINDING_TITLE_BYTES = 1_024;
const MAX_FINDING_PATH_BYTES = 4_096;
const MAX_FINDING_LINE = 2_147_483_647;
const MAX_PROVIDER_OBSERVATIONS_PER_ADAPTER = 64;
const MAX_LAUNCH_RECONCILIATION_OBSERVATIONS = 64;
const MAX_PUBLICATION_ADAPTERS = 2;
const MAX_ADAPTER_ID_BYTES = 128;
const MAX_ARTIFACT_LOCATOR_BYTES = 512;
const MAX_PROJECTED_INVALID_REASONS = 64;
const MAX_REVIEW_OBLIGATIONS = 3;

/** A reducer claim is a short serialization epoch, never a public lease. */
export const MAX_REVIEW_CLAIM_TTL_MS = 60_000;

export const REVIEW_COORDINATOR_STATES = [
  "reviewer_launch_pending",
  "reviewing",
  "awaiting_evidence",
  "awaiting_publication",
  "launch_indeterminate",
  "terminal",
] as const;
export type ReviewCoordinatorState = (typeof REVIEW_COORDINATOR_STATES)[number];

export const REVIEW_INTRINSIC_STATUSES = [
  "pending",
  "passed",
  "not_passed",
  "invalid",
] as const;
export type ReviewIntrinsicStatus = (typeof REVIEW_INTRINSIC_STATUSES)[number];

export const REVIEW_PUBLICATION_STATUSES = [
  "not_started",
  "pending",
  "delivered",
  "degraded",
  "indeterminate",
] as const;
export type ReviewPublicationStatus = (typeof REVIEW_PUBLICATION_STATUSES)[number];

export const REVIEW_DISPOSITIONS = [
  "pending",
  "active",
  "awaiting_publication",
  "ready",
  "blocked",
  "failed",
] as const;
export type ReviewDisposition = (typeof REVIEW_DISPOSITIONS)[number];

export const REVIEW_EFFECT_KINDS = [
  "reviewer_launch",
  "provider_publication",
] as const;
export type ReviewEffectKind = (typeof REVIEW_EFFECT_KINDS)[number];

export const REVIEW_EFFECT_STATUSES = [
  "pending",
  "claimed",
  "succeeded",
  "failed",
  "indeterminate",
] as const;
export type ReviewEffectStatus = (typeof REVIEW_EFFECT_STATUSES)[number];

export const REVIEW_ATTEMPT_STATUSES = [
  "planned",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "launch_indeterminate",
] as const;
export type ReviewAttemptStatus = (typeof REVIEW_ATTEMPT_STATUSES)[number];

export const REVIEW_PROVIDER_OUTCOME_STATUSES = [
  "delivered",
  "degraded",
  "indeterminate",
] as const;
export type ReviewProviderOutcomeStatus =
  (typeof REVIEW_PROVIDER_OUTCOME_STATUSES)[number];

export const REVIEW_PROVIDER_ADAPTERS = ["github_review", "linear_comment"] as const;
export type ReviewProviderAdapter = (typeof REVIEW_PROVIDER_ADAPTERS)[number];

export type ReviewFindingSeverity = "P0" | "P1" | "P2" | "P3";

export interface ReviewTargetIdentity {
  repository: string;
  pull_request: number;
  commit_sha: string;
}

export interface SubmitIndependentReviewInput {
  instance_id: string;
  admission_key: string;
  subject: string;
  asserted_actor: string;
  policy_version: string;
  submitted_at: string;
  target: ReviewTargetIdentity;
  publication_target: {
    linear_issue: string;
  };
  round: number;
  calyx_build_sha: string;
  reviewer_definition_digest: string;
  reviewer_run_id: string;
  launch_id: string;
  /**
   * Exact caller-specific launch material. It is persisted for the effect
   * driver but never appears in the admin projection.
   */
  launch_request: ReviewLaunchRequestV1;
  producer_generation: number;
  producer_fence: number;
}

export interface SubmitIndependentReviewAuthority {
  /** Trusted daemon transition clock; distinct from caller-authored request time. */
  now: string;
}

/**
 * Bounded authority minted by RunService after it validates the terminal run
 * receipt and its required findings artifact. It is correspondence evidence,
 * not a portable authorization token.
 */
export interface ReviewRunEvidenceReceipt {
  schema_version: typeof REVIEW_RUN_EVIDENCE_RECEIPT_SCHEMA_VERSION;
  issuer: "run_service";
  run_id: string;
  reviewer_attempt_id: string;
  terminal_receipt_digest: string;
  artifact: {
    name: "findings.json";
    locator: string;
    media_type: "application/json";
    source_sha256: string;
    source_size_bytes: number;
    canonical_sha256: string;
    canonical_size_bytes: number;
  };
  issued_at: string;
}

export interface ReviewClaim {
  instance_id: string;
  owner: string;
  fence: number;
  claim_until: string;
  state_version: number;
}

export interface ReviewClaimRelease {
  instance_id: string;
  fence: number;
  released: boolean;
  state_version: number;
}

export interface ReviewEffectClaim {
  effect_id: string;
  kind: ReviewEffectKind;
  effect_key: string;
  request_hash: string;
  claimed_fence: number;
  claimed: boolean;
  status: ReviewEffectStatus;
}

export type ReviewerLaunchOutcome =
  | {
      status: "created" | "adopted";
      run_id: string;
      observed_intent_hash: string;
      receipt_digest: string;
    }
  | {
      status: "failed" | "indeterminate";
      run_id: string;
      observed_intent_hash: string;
      reason_code: string;
      receipt_digest?: string;
    };

export type ReviewerLaunchReconciliationObservation =
  | {
      schema_version: typeof REVIEW_LAUNCH_RECONCILIATION_OBSERVATION_SCHEMA_VERSION;
      observation_id: string;
      issuer: "run_service";
      status: "adopted";
      run_id: string;
      observed_intent_hash: string;
      supervisor_receipt_digest: string;
    }
  | {
      schema_version: typeof REVIEW_LAUNCH_RECONCILIATION_OBSERVATION_SCHEMA_VERSION;
      observation_id: string;
      issuer: "run_service";
      status: "failed";
      run_id: string;
      observed_intent_hash: string;
      supervisor_receipt_digest: string;
      reason_code: string;
    }
  | {
      schema_version: typeof REVIEW_LAUNCH_RECONCILIATION_OBSERVATION_SCHEMA_VERSION;
      observation_id: string;
      issuer: "run_service";
      status: "indeterminate";
      run_id: string;
      observed_intent_hash: string;
      reason_code: string;
    };

export type ProviderPublicationObservation = {
  schema_version: typeof REVIEW_PROVIDER_OBSERVATION_SCHEMA_VERSION;
  observation_id: string;
  adapter: ReviewProviderAdapter;
  status: "degraded" | "indeterminate";
  failure: {
    reason_code: string;
  };
};

export interface ReviewFindingsV2 {
  schema_version: typeof REVIEW_FINDINGS_SCHEMA_VERSION;
  evidence_id: string;
  review_instance_id: string;
  reviewer_run_id: string;
  reviewer_attempt_id: string;
  round: number;
  producer_generation: number;
  producer_fence: number;
  target: ReviewTargetIdentity;
  review_status: "complete" | "partial" | "invalid";
  coverage_status: "full" | "partial" | "unknown";
  verdict: "mergeable" | "not_mergeable" | null;
  counts: Record<ReviewFindingSeverity | "total", number>;
  findings: Array<{
    id: string;
    severity: ReviewFindingSeverity;
    title?: string;
    path?: string;
    line?: number;
  }>;
}

export interface ReviewEvidenceEvaluation {
  schema_version: typeof REVIEW_EVIDENCE_SCHEMA_VERSION;
  evidence_id: string;
  artifact_digest: string;
  intrinsic_status: Exclude<ReviewIntrinsicStatus, "pending">;
  verdict: "mergeable" | "not_mergeable" | null;
  coverage_status: string;
  finding_count: number;
  counts: Record<ReviewFindingSeverity | "total", number>;
  invalid_reasons: string[];
}

export interface IndependentReviewEvent {
  event_id: string;
  instance_id: string;
  event_seq: number;
  event_type: string;
  payload: unknown;
  payload_hash: string;
  occurred_at: string;
}

export interface IndependentReviewAdminProjection {
  schema_version: typeof INDEPENDENT_REVIEW_PROJECTION_SCHEMA_VERSION;
  instance_id: string;
  request_digest: string;
  target: ReviewTargetIdentity;
  round: number;
  policy_version: string;
  calyx_build_sha: string;
  reviewer_definition_digest: string;
  state: ReviewCoordinatorState;
  state_version: number;
  axes: {
    intrinsic: ReviewIntrinsicStatus;
    publication: ReviewPublicationStatus;
    disposition: ReviewDisposition;
  };
  claim: {
    held: boolean;
    until: string | null;
    fence: number;
  };
  attempt: {
    attempt_id: string;
    attempt_number: number;
    reviewer_run_id: string;
    launch_id: string;
    launch_intent_hash: string;
    producer_generation: number;
    producer_fence: number;
    status: ReviewAttemptStatus;
    run_state: string | null;
  };
  launch: {
    effect_id: string;
    request_hash: string;
    status: ReviewEffectStatus;
    claimed_fence: number | null;
    reconciliation: null | {
      observation_count: number;
      indeterminate_observed: boolean;
      latest_observation: {
        observation_seq: number;
        observation_id: string;
        status: "adopted" | "failed" | "indeterminate";
        receipt_digest: string;
        observed_at: string;
      };
    };
  };
  evidence: null | {
    evidence_id: string;
    schema_version: string;
    receipt_hash: string;
    artifact_locator: string;
    artifact_digest: string;
    intrinsic_status: Exclude<ReviewIntrinsicStatus, "pending">;
    verdict: string | null;
    coverage_status: string;
    finding_count: number;
    invalid_reason_count: number;
    invalid_reasons: string[];
  };
  publication: null | {
    effects: Array<{
      effect_id: string;
      adapter: string;
      request_hash: string;
      status: ReviewEffectStatus;
      claimed_fence: number | null;
      observation_count: number;
      indeterminate_observed: boolean;
      latest_observation: null | {
        observation_seq: number;
        observation_id: string;
        status: ReviewProviderOutcomeStatus;
        receipt_digest: string;
        observed_at: string;
      };
    }>;
  };
  open_obligations: Array<{
    obligation_id: string;
    kind: string;
    obligation_key: string;
    status: string;
  }>;
  event_cursor: number;
  observed_at: string;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

export type ReviewCoordinatorErrorCode =
  | "schema_absent"
  | "not_found"
  | "immutable_request_conflict"
  | "claim_held"
  | "stale_fence"
  | "effect_conflict"
  | "event_payload_conflict"
  | "invalid_evidence"
  | "invalid_transition";

export class ReviewCoordinatorError extends Error {
  readonly code: ReviewCoordinatorErrorCode;

  constructor(code: ReviewCoordinatorErrorCode, message: string) {
    super(message);
    this.name = "ReviewCoordinatorError";
    this.code = code;
  }
}

interface RawReviewInstance {
  instance_id: string;
  schema_version: string;
  admission_key: string;
  subject: string;
  asserted_actor: string;
  policy_version: string;
  request_json: string;
  request_hash: string;
  repository: string;
  pull_request: number | bigint;
  target_sha: string;
  round: number | bigint;
  calyx_build_sha: string;
  reviewer_definition_digest: string;
  state: string;
  state_version: number | bigint;
  claim_owner: string | null;
  claim_until: string | null;
  claim_fence: number | bigint;
  intrinsic_status: string;
  publication_status: string;
  disposition: string;
  next_event_seq: number | bigint;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

interface RawReviewAttempt {
  attempt_id: string;
  instance_id: string;
  attempt_number: number | bigint;
  reviewer_run_id: string;
  launch_id: string;
  launch_request_json: string;
  launch_intent_hash: string;
  producer_generation: number | bigint;
  producer_fence: number | bigint;
  status: string;
  run_state: string | null;
  created_at: string;
  updated_at: string;
}

interface RawReviewEffect {
  effect_id: string;
  instance_id: string;
  attempt_id: string | null;
  kind: string;
  effect_key: string;
  request_json: string;
  request_hash: string;
  status: string;
  claimed_fence: number | bigint | null;
  adoption_json: string | null;
  adoption_hash: string | null;
  created_at: string;
  updated_at: string;
}

interface RawReviewEvidence {
  evidence_id: string;
  instance_id: string;
  attempt_id: string;
  schema_version: string;
  receipt_json: string;
  receipt_hash: string;
  artifact_json: string;
  artifact_digest: string;
  intrinsic_status: string;
  verdict: string | null;
  coverage_status: string;
  finding_count: number | bigint;
  invalid_reasons_json: string;
  created_at: string;
}

interface RawReviewObligation {
  obligation_id: string;
  instance_id: string;
  effect_id: string | null;
  kind: string;
  obligation_key: string;
  status: string;
  detail_json: string;
  created_at: string;
  updated_at: string;
}

interface RawReviewEffectObservation {
  observation_id: string;
  instance_id: string;
  effect_id: string;
  effect_key: string;
  observation_seq: number | bigint;
  schema_version: string;
  status: string;
  receipt_digest: string;
  payload_json: string;
  payload_hash: string;
  observed_at: string;
}

interface RawReviewEvent {
  event_id: string;
  instance_id: string;
  event_seq: number | bigint;
  event_type: string;
  payload_json: string;
  payload_hash: string;
  occurred_at: string;
}

const SELECT_INSTANCE = `SELECT
  instance_id, schema_version, admission_key, subject, asserted_actor,
  policy_version, request_json, request_hash, repository, pull_request,
  target_sha, round, calyx_build_sha, reviewer_definition_digest, state,
  state_version, claim_owner, claim_until, claim_fence, intrinsic_status,
  publication_status, disposition, next_event_seq, created_at, updated_at,
  terminal_at
FROM review_instances`;

const SELECT_ATTEMPT = `SELECT
  attempt_id, instance_id, attempt_number, reviewer_run_id, launch_id,
  launch_request_json, launch_intent_hash, producer_generation,
  producer_fence, status, run_state, created_at, updated_at
FROM review_attempts`;

const SELECT_EFFECT = `SELECT
  effect_id, instance_id, attempt_id, kind, effect_key, request_json, request_hash,
  status, claimed_fence, adoption_json, adoption_hash, created_at, updated_at
FROM review_effects`;

function asNumber(value: number | bigint): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(normalized)) {
    throw new ReviewCoordinatorError(
      "schema_absent",
      `Persisted review integer is outside the JavaScript safe range (${String(value)}).`,
    );
  }
  return normalized;
}

function requiredText(
  value: string,
  field: string,
  maxBytes = MAX_REVIEW_ID_BYTES,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("\0") || normalized.includes("\r") || normalized.includes("\n")) {
    throw new ReviewCoordinatorError("invalid_transition", `${field} must be non-empty.`);
  }
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) {
    throw new ReviewCoordinatorError(
      "invalid_transition",
      `${field} exceeds its ${String(maxBytes)}-byte UTF-8 bound.`,
    );
  }
  return normalized;
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ReviewCoordinatorError(
      "invalid_transition",
      `${field} must be a positive safe integer (got ${String(value)}).`,
    );
  }
}

function assertCanonicalByteBound(value: string, field: string, maxBytes: number): void {
  const sizeBytes = Buffer.byteLength(value, "utf8");
  if (sizeBytes < 1 || sizeBytes > maxBytes) {
    throw new ReviewCoordinatorError(
      "invalid_transition",
      `${field} exceeds its ${String(maxBytes)}-byte canonical JSON bound.`,
    );
  }
}

function assertDigest(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!DIGEST_PATTERN.test(normalized)) {
    throw new ReviewCoordinatorError(
      "invalid_transition",
      `${field} must be a 64-character lowercase sha256 digest.`,
    );
  }
  return normalized;
}

function assertCommitSha(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA_PATTERN.test(normalized)) {
    throw new ReviewCoordinatorError(
      "invalid_transition",
      "target.commit_sha must be a full 40- or 64-character lowercase commit SHA.",
    );
  }
  return normalized;
}

function canonicalTimestamp(value: string, field: string): string {
  const normalized = requiredText(value, field);
  const epochMs = Date.parse(normalized);
  if (!Number.isFinite(epochMs)) {
    throw new ReviewCoordinatorError(
      "invalid_transition",
      `${field} must be an ISO timestamp.`,
    );
  }
  return new Date(epochMs).toISOString();
}

function assertMutationTime(
  transitionAt: string,
  floors: ReadonlyArray<{ field: string; value: string | null }>,
): void {
  for (const floor of floors) {
    if (floor.value !== null && transitionAt < floor.value) {
      throw new ReviewCoordinatorError(
        "invalid_transition",
        `Transition time ${transitionAt} precedes durable ${floor.field} ${floor.value}.`,
      );
    }
  }
}

function assertReviewClaimTtl(ttlMs: number): void {
  assertPositiveInteger(ttlMs, "ttl_ms");
  if (ttlMs > MAX_REVIEW_CLAIM_TTL_MS) {
    throw new ReviewCoordinatorError(
      "invalid_transition",
      `ttl_ms must not exceed ${String(MAX_REVIEW_CLAIM_TTL_MS)}ms.`,
    );
  }
}

function canonicalValue(value: unknown, path = "$"): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new ReviewCoordinatorError(
        "invalid_transition",
        `Cannot canonicalize non-finite or unsafe integer at ${path}.`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalValue(entry, `${path}[${index}]`));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ReviewCoordinatorError(
        "invalid_transition",
        `Cannot canonicalize non-plain object at ${path}.`,
      );
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) {
        throw new ReviewCoordinatorError(
          "invalid_transition",
          `Cannot canonicalize undefined at ${path}.${key}.`,
        );
      }
      result[key] = canonicalValue(entry, `${path}.${key}`);
    }
    return result;
  }
  throw new ReviewCoordinatorError(
    "invalid_transition",
    `Cannot canonicalize ${typeof value} at ${path}.`,
  );
}

/** Stable caller-local JSON. Object keys sort recursively; arrays retain order. */
export function canonicalizeIndependentReviewJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function hashIndependentReviewValue(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeIndependentReviewJson(value), "utf8")
    .digest("hex");
}

function stableId(prefix: string, parts: readonly string[]): string {
  const digest = createHash("sha256")
    .update(canonicalizeIndependentReviewJson(parts), "utf8")
    .digest("hex");
  return `${prefix}-${digest.slice(0, 32)}`;
}

function reviewEventId(
  instanceId: string,
  eventType: string,
  identityParts: readonly string[] = [],
): string {
  const digest = createHash("sha256")
    .update(
      canonicalizeIndependentReviewJson([instanceId, eventType, ...identityParts]),
      "utf8",
    )
    .digest("hex");
  return `review-event-${digest}`;
}

function withImmediateTransaction<T>(db: StateDriverDatabase, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Keep the root failure.
    }
    throw error;
  }
}

function withReadSnapshot<T>(db: StateDriverDatabase, operation: () => T): T {
  db.exec("BEGIN DEFERRED");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Keep the root failure.
    }
    throw error;
  }
}

function readInstance(db: StateDriverDatabase, instanceId: string): RawReviewInstance | undefined {
  return db
    .prepare(`${SELECT_INSTANCE} WHERE instance_id = ?`)
    .get(instanceId) as RawReviewInstance | undefined;
}

function requireInstance(db: StateDriverDatabase, instanceId: string): RawReviewInstance {
  const row = readInstance(db, instanceId);
  if (!row) {
    throw new ReviewCoordinatorError(
      "not_found",
      `Independent review instance ${instanceId} was not found.`,
    );
  }
  return row;
}

function readAttempt(db: StateDriverDatabase, instanceId: string): RawReviewAttempt | undefined {
  return db
    .prepare(`${SELECT_ATTEMPT} WHERE instance_id = ? ORDER BY attempt_number ASC LIMIT 1`)
    .get(instanceId) as RawReviewAttempt | undefined;
}

function requireAttempt(db: StateDriverDatabase, instanceId: string): RawReviewAttempt {
  const row = readAttempt(db, instanceId);
  if (!row) {
    throw new ReviewCoordinatorError(
      "not_found",
      `Independent review instance ${instanceId} has no reviewer attempt.`,
    );
  }
  return row;
}

function readEffect(db: StateDriverDatabase, effectId: string): RawReviewEffect | undefined {
  return db
    .prepare(`${SELECT_EFFECT} WHERE effect_id = ?`)
    .get(effectId) as RawReviewEffect | undefined;
}

function requireEffect(db: StateDriverDatabase, effectId: string): RawReviewEffect {
  const row = readEffect(db, effectId);
  if (!row) {
    throw new ReviewCoordinatorError(
      "not_found",
      `Independent review effect ${effectId} was not found.`,
    );
  }
  return row;
}

function parseJson<T>(value: string, field: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new ReviewCoordinatorError(
      "schema_absent",
      `Independent review ${field} contains invalid JSON.`,
    );
  }
}

function appendReviewEventInTransaction(
  db: StateDriverDatabase,
  input: {
    instance_id: string;
    event_type: string;
    identity_parts?: readonly string[];
    payload: unknown;
    occurred_at: string;
  },
): { inserted: boolean; event_seq: number } {
  const eventId = reviewEventId(
    input.instance_id,
    input.event_type,
    input.identity_parts,
  );
  const payloadJson = canonicalizeIndependentReviewJson(input.payload);
  const payloadHash = createHash("sha256").update(payloadJson, "utf8").digest("hex");
  const existing = db
    .prepare(
      `SELECT event_id, instance_id, event_seq, event_type, payload_json,
              payload_hash, occurred_at
       FROM review_events WHERE event_id = ?`,
    )
    .get(eventId) as RawReviewEvent | undefined;
  if (existing) {
    if (
      existing.instance_id !== input.instance_id
      || existing.event_type !== input.event_type
      || existing.payload_hash !== payloadHash
      || existing.payload_json !== payloadJson
    ) {
      throw new ReviewCoordinatorError(
        "event_payload_conflict",
        `Review event ${eventId} already exists with different canonical bytes.`,
      );
    }
    return { inserted: false, event_seq: asNumber(existing.event_seq) };
  }

  const instance = requireInstance(db, input.instance_id);
  const eventSeq = asNumber(instance.next_event_seq);
  db.prepare(
    `INSERT INTO review_events
      (event_id, instance_id, event_seq, event_type, payload_json,
       payload_hash, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    input.instance_id,
    eventSeq,
    input.event_type,
    payloadJson,
    payloadHash,
    input.occurred_at,
  );
  db.prepare(
    `UPDATE review_instances SET next_event_seq = ? WHERE instance_id = ?`,
  ).run(eventSeq + 1, input.instance_id);
  return { inserted: true, event_seq: eventSeq };
}

function updateInstanceInTransaction(
  db: StateDriverDatabase,
  current: RawReviewInstance,
  input: {
    state?: ReviewCoordinatorState;
    intrinsic_status?: ReviewIntrinsicStatus;
    publication_status?: ReviewPublicationStatus;
    disposition?: ReviewDisposition;
    updated_at: string;
    terminal_at?: string | null;
  },
): void {
  assertMutationTime(input.updated_at, [
    { field: "review instance created_at", value: current.created_at },
    { field: "review instance updated_at", value: current.updated_at },
  ]);
  const result = db.prepare(
    `UPDATE review_instances
     SET state = ?, intrinsic_status = ?, publication_status = ?,
         disposition = ?, updated_at = ?, terminal_at = ?,
         state_version = state_version + 1
     WHERE instance_id = ? AND state_version = ?`,
  ).run(
    input.state ?? current.state,
    input.intrinsic_status ?? current.intrinsic_status,
    input.publication_status ?? current.publication_status,
    input.disposition ?? current.disposition,
    input.updated_at,
    input.terminal_at === undefined ? current.terminal_at : input.terminal_at,
    current.instance_id,
    asNumber(current.state_version),
  );
  if (asNumber(result.changes) !== 1) {
    throw new ReviewCoordinatorError(
      "stale_fence",
      `Independent review ${current.instance_id} changed during state CAS.`,
    );
  }
}

function assertCurrentFence(
  instance: RawReviewInstance,
  input: { owner: string; fence: number; now: string },
): void {
  assertMutationTime(input.now, [
    { field: "review instance updated_at", value: instance.updated_at },
  ]);
  if (
    instance.claim_owner !== input.owner
    || asNumber(instance.claim_fence) !== input.fence
    || !instance.claim_until
    || instance.claim_until <= input.now
  ) {
    throw new ReviewCoordinatorError(
      "stale_fence",
      `Review claim ${input.owner}/${input.fence} is not current for ${instance.instance_id}.`,
    );
  }
}

function validateSubmission(input: SubmitIndependentReviewInput): SubmitIndependentReviewInput {
  const instanceId = requiredText(input.instance_id, "instance_id");
  const admissionKey = requiredText(input.admission_key, "admission_key");
  const subject = requiredText(input.subject, "subject", MAX_REVIEW_SUBJECT_BYTES);
  const assertedActor = requiredText(input.asserted_actor, "asserted_actor", MAX_REVIEW_ACTOR_BYTES);
  const policyVersion = requiredText(
    input.policy_version,
    "policy_version",
    MAX_POLICY_VERSION_BYTES,
  );
  const submittedAt = canonicalTimestamp(input.submitted_at, "submitted_at");
  const repository = requiredText(
    input.target.repository,
    "target.repository",
    MAX_REPOSITORY_BYTES,
  );
  const linearIssue = requiredText(
    input.publication_target.linear_issue,
    "publication_target.linear_issue",
  );
  assertPositiveInteger(input.target.pull_request, "target.pull_request");
  const commitSha = assertCommitSha(input.target.commit_sha);
  assertPositiveInteger(input.round, "round");
  const calyxBuildSha = assertCommitSha(input.calyx_build_sha);
  const reviewerDefinitionDigest = assertDigest(
    input.reviewer_definition_digest,
    "reviewer_definition_digest",
  );
  const reviewerRunId = requiredText(input.reviewer_run_id, "reviewer_run_id");
  const launchId = requiredText(input.launch_id, "launch_id");
  assertPositiveInteger(input.producer_generation, "producer_generation");
  assertPositiveInteger(input.producer_fence, "producer_fence");
  let launchRequest: ReviewLaunchRequestV1;
  try {
    launchRequest = normalizeReviewLaunchRequest(input.launch_request, commitSha);
  } catch (error) {
    throw new ReviewCoordinatorError(
      "invalid_transition",
      error instanceof Error ? error.message : "launch_request is invalid.",
    );
  }
  const launchRequestJson = canonicalizeIndependentReviewJson(launchRequest);
  assertCanonicalByteBound(
    launchRequestJson,
    "launch_request",
    MAX_LAUNCH_REQUEST_BYTES,
  );
  return {
    ...input,
    instance_id: instanceId,
    admission_key: admissionKey,
    subject,
    asserted_actor: assertedActor,
    policy_version: policyVersion,
    submitted_at: submittedAt,
    target: {
      repository,
      pull_request: input.target.pull_request,
      commit_sha: commitSha,
    },
    publication_target: { linear_issue: linearIssue },
    calyx_build_sha: calyxBuildSha,
    reviewer_definition_digest: reviewerDefinitionDigest,
    reviewer_run_id: reviewerRunId,
    launch_id: launchId,
    launch_request: launchRequest,
  };
}

function immutableRequest(input: SubmitIndependentReviewInput): Record<string, unknown> {
  return {
    schema_version: INDEPENDENT_REVIEW_REQUEST_SCHEMA_VERSION,
    instance_id: input.instance_id.trim(),
    admission_key: input.admission_key.trim(),
    subject: input.subject.trim(),
    asserted_actor: input.asserted_actor.trim(),
    policy_version: input.policy_version.trim(),
    submitted_at: input.submitted_at,
    target: {
      repository: input.target.repository.trim(),
      pull_request: input.target.pull_request,
      commit_sha: input.target.commit_sha.trim().toLowerCase(),
    },
    publication_target: {
      linear_issue: input.publication_target.linear_issue.trim(),
    },
    round: input.round,
    calyx_build_sha: input.calyx_build_sha.trim().toLowerCase(),
    reviewer_definition_digest: input.reviewer_definition_digest.trim().toLowerCase(),
    reviewer_run_id: input.reviewer_run_id.trim(),
    launch_id: input.launch_id.trim(),
    launch_request: input.launch_request,
    producer_generation: input.producer_generation,
    producer_fence: input.producer_fence,
  };
}

export interface SubmitIndependentReviewResult {
  created: boolean;
  request_hash: string;
  attempt_id: string;
  launch_effect_id: string;
  projection: IndependentReviewAdminProjection;
}

/**
 * Admit one immutable review request and materialize its first reviewer launch
 * intent. Request, attempt, effect, current state, and matching event commit in
 * one SQLite transaction. Same subject/admission key + same bytes adopts;
 * different bytes fail closed.
 */
export function submitIndependentReview(
  db: StateDriverDatabase,
  rawInput: SubmitIndependentReviewInput,
  authority: SubmitIndependentReviewAuthority,
): SubmitIndependentReviewResult {
  const input = validateSubmission(rawInput);
  const admittedAt = canonicalTimestamp(authority.now, "admission authority now");
  const request = immutableRequest(input);
  const requestJson = canonicalizeIndependentReviewJson(request);
  const requestHash = createHash("sha256").update(requestJson, "utf8").digest("hex");
  const launchRequestJson = canonicalizeIndependentReviewJson(input.launch_request);
  const launchIntentHash = createHash("sha256").update(launchRequestJson, "utf8").digest("hex");
  const attemptId = stableId("review-attempt", [input.instance_id, "reviewer", "1"]);
  const launchEffectId = stableId("review-effect", [input.instance_id, "reviewer_launch", "1"]);
  const launchEffectRequest = {
    schema_version: "calyx.review-effect/reviewer-launch/v1",
    instance_id: input.instance_id,
    attempt_id: attemptId,
    launch_id: input.launch_id,
    reviewer_run_id: input.reviewer_run_id,
    launch_intent_hash: launchIntentHash,
    reviewer_definition_digest: input.reviewer_definition_digest,
    launch_request: input.launch_request,
  };
  const launchEffectRequestJson = canonicalizeIndependentReviewJson(launchEffectRequest);
  const launchEffectRequestHash = createHash("sha256")
    .update(launchEffectRequestJson, "utf8")
    .digest("hex");

  const created = withImmediateTransaction(db, () => {
    const existingByInstance = readInstance(db, input.instance_id);
    const existingByAdmission = db
      .prepare(`${SELECT_INSTANCE} WHERE subject = ? AND admission_key = ?`)
      .get(input.subject.trim(), input.admission_key.trim()) as RawReviewInstance | undefined;
    const existing = existingByInstance ?? existingByAdmission;
    if (existing) {
      if (
        existing.instance_id !== input.instance_id.trim()
        || existing.subject !== input.subject.trim()
        || existing.admission_key !== input.admission_key.trim()
        || existing.request_hash !== requestHash
        || existing.request_json !== requestJson
      ) {
        throw new ReviewCoordinatorError(
          "immutable_request_conflict",
          `Review admission ${input.subject}/${input.admission_key} already names different immutable bytes.`,
        );
      }
      return false;
    }

    db.prepare(
      `INSERT INTO review_instances
        (instance_id, schema_version, admission_key, subject, asserted_actor,
         policy_version, request_json, request_hash, repository, pull_request,
         target_sha, round, calyx_build_sha, reviewer_definition_digest,
         state, state_version, claim_owner, claim_until, claim_fence,
         intrinsic_status, publication_status, disposition, next_event_seq,
         created_at, updated_at, terminal_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, 0,
               'pending', 'not_started', 'active', 1, ?, ?, NULL)`,
    ).run(
      input.instance_id.trim(),
      INDEPENDENT_REVIEW_REQUEST_SCHEMA_VERSION,
      input.admission_key.trim(),
      input.subject.trim(),
      input.asserted_actor.trim(),
      input.policy_version.trim(),
      requestJson,
      requestHash,
      input.target.repository.trim(),
      input.target.pull_request,
      input.target.commit_sha.trim().toLowerCase(),
      input.round,
      input.calyx_build_sha.trim().toLowerCase(),
      input.reviewer_definition_digest.trim().toLowerCase(),
      "reviewer_launch_pending",
      admittedAt,
      admittedAt,
    );
    db.prepare(
      `INSERT INTO review_attempts
        (attempt_id, instance_id, attempt_number, reviewer_run_id, launch_id,
         launch_request_json, launch_intent_hash, producer_generation,
         producer_fence, status, run_state, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'planned', NULL, ?, ?)`,
    ).run(
      attemptId,
      input.instance_id.trim(),
      input.reviewer_run_id.trim(),
      input.launch_id.trim(),
      launchRequestJson,
      launchIntentHash,
      input.producer_generation,
      input.producer_fence,
      admittedAt,
      admittedAt,
    );
    db.prepare(
      `INSERT INTO review_effects
        (effect_id, instance_id, attempt_id, kind, effect_key, request_json, request_hash,
         status, claimed_fence, adoption_json, adoption_hash, created_at,
         updated_at)
       VALUES (?, ?, ?, 'reviewer_launch', 'reviewer', ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`,
    ).run(
      launchEffectId,
      input.instance_id.trim(),
      attemptId,
      launchEffectRequestJson,
      launchEffectRequestHash,
      admittedAt,
      admittedAt,
    );
    appendReviewEventInTransaction(db, {
      instance_id: input.instance_id,
      event_type: "review_admitted",
      occurred_at: admittedAt,
      payload: {
        request_hash: requestHash,
        attempt_id: attemptId,
        launch_effect_id: launchEffectId,
        launch_effect_request_hash: launchEffectRequestHash,
        target: request["target"],
        round: input.round,
      },
    });
    return true;
  });

  const projection = requireIndependentReviewAdminProjection(
    db,
    input.instance_id,
    admittedAt,
  );
  return {
    created,
    request_hash: requestHash,
    attempt_id: attemptId,
    launch_effect_id: launchEffectId,
    projection,
  };
}

/** Acquire a short fenced reducer claim. No external work runs in this transaction. */
export function acquireIndependentReviewClaim(
  db: StateDriverDatabase,
  input: {
    instance_id: string;
    owner: string;
    ttl_ms: number;
    now: string;
  },
): ReviewClaim {
  const owner = requiredText(input.owner, "owner");
  assertReviewClaimTtl(input.ttl_ms);
  const acquiredAt = canonicalTimestamp(input.now, "claim now");
  const acquiredAtMs = Date.parse(acquiredAt);
  const claimUntilMs = acquiredAtMs + input.ttl_ms;
  if (!Number.isSafeInteger(claimUntilMs) || !Number.isFinite(new Date(claimUntilMs).getTime())) {
    throw new ReviewCoordinatorError("invalid_transition", "ttl_ms exceeds the timestamp range.");
  }
  const claimUntil = new Date(claimUntilMs).toISOString();

  return withImmediateTransaction(db, () => {
    const current = requireInstance(db, input.instance_id);
    assertMutationTime(acquiredAt, [
      { field: "review instance updated_at", value: current.updated_at },
    ]);
    if (current.claim_owner && current.claim_until && current.claim_until > acquiredAt) {
      throw new ReviewCoordinatorError(
        "claim_held",
        `Review ${input.instance_id} is claimed until ${current.claim_until}; renew the current fence instead of acquiring a new one.`,
      );
    }
    const fence = asNumber(current.claim_fence) + 1;
    const result = db.prepare(
      `UPDATE review_instances
       SET claim_owner = ?, claim_until = ?, claim_fence = ?,
           state_version = state_version + 1, updated_at = ?
       WHERE instance_id = ? AND state_version = ?`,
    ).run(
      owner,
      claimUntil,
      fence,
      acquiredAt,
      input.instance_id,
      asNumber(current.state_version),
    );
    if (asNumber(result.changes) !== 1) {
      throw new ReviewCoordinatorError(
        "stale_fence",
        `Review ${input.instance_id} changed during claim CAS.`,
      );
    }
    appendReviewEventInTransaction(db, {
      instance_id: input.instance_id,
      event_type: "claim_acquired",
      identity_parts: [String(fence)],
      occurred_at: acquiredAt,
      payload: {
        fence,
        claim_until: claimUntil,
        owner_digest: hashIndependentReviewValue(owner),
      },
    });
    return {
      instance_id: input.instance_id,
      owner,
      fence,
      claim_until: claimUntil,
      state_version: asNumber(current.state_version) + 1,
    };
  });
}

/** Renew the current claim without changing its fencing token. */
export function renewIndependentReviewClaim(
  db: StateDriverDatabase,
  input: {
    instance_id: string;
    owner: string;
    fence: number;
    ttl_ms: number;
    now: string;
  },
): ReviewClaim {
  const owner = requiredText(input.owner, "owner");
  assertPositiveInteger(input.fence, "fence");
  assertReviewClaimTtl(input.ttl_ms);
  const renewedAt = canonicalTimestamp(input.now, "renew now");
  const claimUntilMs = Date.parse(renewedAt) + input.ttl_ms;
  if (!Number.isSafeInteger(claimUntilMs) || !Number.isFinite(new Date(claimUntilMs).getTime())) {
    throw new ReviewCoordinatorError("invalid_transition", "ttl_ms exceeds the timestamp range.");
  }
  const claimUntil = new Date(claimUntilMs).toISOString();

  return withImmediateTransaction(db, () => {
    const current = requireInstance(db, input.instance_id);
    assertCurrentFence(current, { owner, fence: input.fence, now: renewedAt });
    if (current.claim_until === claimUntil) {
      return {
        instance_id: input.instance_id,
        owner,
        fence: input.fence,
        claim_until: claimUntil,
        state_version: asNumber(current.state_version),
      };
    }
    if (current.claim_until && claimUntil < current.claim_until) {
      throw new ReviewCoordinatorError(
        "invalid_transition",
        `Review ${input.instance_id} renewal cannot shorten its current claim.`,
      );
    }
    const result = db.prepare(
      `UPDATE review_instances
       SET claim_until = ?, state_version = state_version + 1, updated_at = ?
       WHERE instance_id = ? AND claim_owner = ? AND claim_fence = ?
         AND claim_until > ? AND state_version = ?`,
    ).run(
      claimUntil,
      renewedAt,
      input.instance_id,
      owner,
      input.fence,
      renewedAt,
      asNumber(current.state_version),
    );
    if (asNumber(result.changes) !== 1) {
      throw new ReviewCoordinatorError(
        "stale_fence",
        `Review ${input.instance_id} changed during renewal CAS.`,
      );
    }
    appendReviewEventInTransaction(db, {
      instance_id: input.instance_id,
      event_type: "claim_renewed",
      identity_parts: [String(input.fence), claimUntil],
      occurred_at: renewedAt,
      payload: {
        fence: input.fence,
        claim_until: claimUntil,
        owner_digest: hashIndependentReviewValue(owner),
      },
    });
    return {
      instance_id: input.instance_id,
      owner,
      fence: input.fence,
      claim_until: claimUntil,
      state_version: asNumber(current.state_version) + 1,
    };
  });
}

/**
 * Release only the exact fenced claim. This never changes effect ownership:
 * already-claimed effects still require create-or-adopt reconciliation.
 */
export function releaseIndependentReviewClaim(
  db: StateDriverDatabase,
  input: {
    instance_id: string;
    owner: string;
    fence: number;
    now: string;
  },
): ReviewClaimRelease {
  const owner = requiredText(input.owner, "owner");
  assertPositiveInteger(input.fence, "fence");
  const releasedAt = canonicalTimestamp(input.now, "release now");
  return withImmediateTransaction(db, () => {
    const current = requireInstance(db, input.instance_id);
    assertMutationTime(releasedAt, [
      { field: "review instance updated_at", value: current.updated_at },
    ]);
    if (current.claim_owner === null && current.claim_until === null) {
      if (asNumber(current.claim_fence) !== input.fence) {
        throw new ReviewCoordinatorError(
          "stale_fence",
          `Review claim ${owner}/${String(input.fence)} is stale for ${input.instance_id}.`,
        );
      }
      return {
        instance_id: input.instance_id,
        fence: input.fence,
        released: false,
        state_version: asNumber(current.state_version),
      };
    }
    if (
      current.claim_owner !== owner
      || asNumber(current.claim_fence) !== input.fence
      || current.claim_until === null
    ) {
      throw new ReviewCoordinatorError(
        "stale_fence",
        `Review claim ${owner}/${String(input.fence)} is stale for ${input.instance_id}.`,
      );
    }
    const result = db.prepare(
      `UPDATE review_instances
       SET claim_owner = NULL, claim_until = NULL,
           state_version = state_version + 1, updated_at = ?
       WHERE instance_id = ? AND claim_owner = ? AND claim_fence = ?
         AND state_version = ?`,
    ).run(
      releasedAt,
      input.instance_id,
      owner,
      input.fence,
      asNumber(current.state_version),
    );
    if (asNumber(result.changes) !== 1) {
      throw new ReviewCoordinatorError(
        "stale_fence",
        `Review ${input.instance_id} changed during claim release CAS.`,
      );
    }
    appendReviewEventInTransaction(db, {
      instance_id: input.instance_id,
      event_type: "claim_released",
      identity_parts: [String(input.fence)],
      occurred_at: releasedAt,
      payload: {
        fence: input.fence,
        owner_digest: hashIndependentReviewValue(owner),
      },
    });
    return {
      instance_id: input.instance_id,
      fence: input.fence,
      released: true,
      state_version: asNumber(current.state_version) + 1,
    };
  });
}

/**
 * Fence one already-persisted effect before execution. A claimed effect is not
 * silently reclaimed by a later owner: without provider/supervisor
 * create-or-adopt proof its acceptance is indeterminate.
 */
export function claimIndependentReviewEffect(
  db: StateDriverDatabase,
  input: {
    instance_id: string;
    effect_id: string;
    owner: string;
    fence: number;
    now: string;
  },
): ReviewEffectClaim {
  const now = canonicalTimestamp(input.now, "effect claim now");
  return withImmediateTransaction(db, () => {
    const instance = requireInstance(db, input.instance_id);
    assertCurrentFence(instance, { ...input, now });
    const effect = requireEffect(db, input.effect_id);
    if (effect.instance_id !== input.instance_id) {
      throw new ReviewCoordinatorError(
        "effect_conflict",
        `Effect ${input.effect_id} does not belong to ${input.instance_id}.`,
      );
    }
    if (effect.status === "claimed") {
      if (effect.claimed_fence !== null && asNumber(effect.claimed_fence) === input.fence) {
        return {
          effect_id: effect.effect_id,
          kind: effect.kind as ReviewEffectKind,
          effect_key: effect.effect_key,
          request_hash: effect.request_hash,
          claimed_fence: input.fence,
          claimed: false,
          status: "claimed",
        };
      }
      throw new ReviewCoordinatorError(
        "effect_conflict",
        `Effect ${input.effect_id} was already claimed at fence ${String(effect.claimed_fence)}; reconcile the original identity instead of re-executing it.`,
      );
    }
    if (effect.status !== "pending") {
      return {
        effect_id: effect.effect_id,
        kind: effect.kind as ReviewEffectKind,
        effect_key: effect.effect_key,
        request_hash: effect.request_hash,
        claimed_fence: effect.claimed_fence === null ? input.fence : asNumber(effect.claimed_fence),
        claimed: false,
        status: effect.status as ReviewEffectStatus,
      };
    }
    assertMutationTime(now, [
      { field: "review effect updated_at", value: effect.updated_at },
    ]);
    db.prepare(
      `UPDATE review_effects
       SET status = 'claimed', claimed_fence = ?, updated_at = ?
       WHERE effect_id = ? AND status = 'pending'`,
    ).run(input.fence, now, input.effect_id);
    updateInstanceInTransaction(db, instance, { updated_at: now });
    appendReviewEventInTransaction(db, {
      instance_id: input.instance_id,
      event_type: "effect_claimed",
      identity_parts: [input.effect_id, String(input.fence)],
      occurred_at: now,
      payload: {
        effect_id: effect.effect_id,
        effect_kind: effect.kind,
        request_hash: effect.request_hash,
        fence: input.fence,
      },
    });
    return {
      effect_id: effect.effect_id,
      kind: effect.kind as ReviewEffectKind,
      effect_key: effect.effect_key,
      request_hash: effect.request_hash,
      claimed_fence: input.fence,
      claimed: true,
      status: "claimed",
    };
  });
}

/** A final fence check for effect drivers immediately before external work. */
export function assertIndependentReviewFence(
  db: StateDriverDatabase,
  input: { instance_id: string; owner: string; fence: number; now: string },
): void {
  assertCurrentFence(requireInstance(db, input.instance_id), {
    ...input,
    now: canonicalTimestamp(input.now, "fence check now"),
  });
}

export function adoptReviewerLaunchEffect(
  db: StateDriverDatabase,
  input: {
    instance_id: string;
    effect_id: string;
    effect_request_hash: string;
    claimed_fence: number;
    outcome: ReviewerLaunchOutcome;
    observed_at: string;
  },
): { adopted: boolean; projection: IndependentReviewAdminProjection } {
  const effectRequestHash = assertDigest(input.effect_request_hash, "effect_request_hash");
  assertPositiveInteger(input.claimed_fence, "claimed_fence");
  const observedAt = canonicalTimestamp(input.observed_at, "launch observed_at");
  if (!["created", "adopted", "failed", "indeterminate"].includes(input.outcome.status)) {
    throw new ReviewCoordinatorError(
      "effect_conflict",
      `Unsupported reviewer launch outcome status ${String(input.outcome.status)}.`,
    );
  }
  const reasonCode = input.outcome.status === "failed" || input.outcome.status === "indeterminate"
    ? requiredText(input.outcome.reason_code, "outcome.reason_code")
    : undefined;
  const normalizedOutcome = {
    claimed_fence: input.claimed_fence,
    ...input.outcome,
    run_id: requiredText(input.outcome.run_id, "outcome.run_id"),
    observed_intent_hash: assertDigest(
      input.outcome.observed_intent_hash,
      "outcome.observed_intent_hash",
    ),
    ...(input.outcome.receipt_digest
      ? { receipt_digest: assertDigest(input.outcome.receipt_digest, "outcome.receipt_digest") }
      : {}),
    ...(reasonCode ? { reason_code: reasonCode } : {}),
  };
  if (
    (normalizedOutcome.status === "created" || normalizedOutcome.status === "adopted")
    && !("receipt_digest" in normalizedOutcome)
  ) {
    throw new ReviewCoordinatorError(
      "effect_conflict",
      "Accepted reviewer launch adoption requires a durable supervisor receipt digest.",
    );
  }
  const adoptionJson = canonicalizeIndependentReviewJson(normalizedOutcome);
  const adoptionHash = createHash("sha256").update(adoptionJson, "utf8").digest("hex");

  const adopted = withImmediateTransaction(db, () => {
    const instance = requireInstance(db, input.instance_id);
    const attempt = requireAttempt(db, input.instance_id);
    const effect = requireEffect(db, input.effect_id);
    if (
      effect.instance_id !== input.instance_id
      || effect.kind !== "reviewer_launch"
      || effect.request_hash !== effectRequestHash
      || effect.attempt_id !== attempt.attempt_id
      || effect.claimed_fence === null
      || asNumber(effect.claimed_fence) !== input.claimed_fence
    ) {
      throw new ReviewCoordinatorError(
        "effect_conflict",
        `Reviewer launch effect ${input.effect_id} does not match its persisted identity.`,
      );
    }
    if (attempt.reviewer_run_id !== normalizedOutcome.run_id) {
      throw new ReviewCoordinatorError(
        "effect_conflict",
        `Reviewer launch outcome named run ${normalizedOutcome.run_id}, expected ${attempt.reviewer_run_id}.`,
      );
    }
    if (attempt.launch_intent_hash !== normalizedOutcome.observed_intent_hash) {
      throw new ReviewCoordinatorError(
        "effect_conflict",
        `Reviewer launch ${attempt.launch_id} observed different intent bytes.`,
      );
    }
    if (effect.adoption_hash) {
      if (effect.adoption_hash === adoptionHash && effect.adoption_json === adoptionJson) {
        return false;
      }
      throw new ReviewCoordinatorError(
        "effect_conflict",
        `Reviewer launch effect ${input.effect_id} already adopted different bytes.`,
      );
    }
    if (effect.status !== "claimed") {
      throw new ReviewCoordinatorError(
        "effect_conflict",
        `Reviewer launch effect ${input.effect_id} must be fenced before adoption (status=${effect.status}).`,
      );
    }
    assertMutationTime(observedAt, [
      { field: "review instance updated_at", value: instance.updated_at },
      { field: "review attempt updated_at", value: attempt.updated_at },
      { field: "review effect updated_at", value: effect.updated_at },
    ]);

    const accepted = normalizedOutcome.status === "created" || normalizedOutcome.status === "adopted";
    const indeterminate = normalizedOutcome.status === "indeterminate";
    const effectStatus: ReviewEffectStatus = accepted
      ? "succeeded"
      : indeterminate
        ? "indeterminate"
        : "failed";
    const attemptStatus: ReviewAttemptStatus = accepted
      ? "running"
      : indeterminate
        ? "launch_indeterminate"
        : "failed";
    db.prepare(
      `UPDATE review_effects
       SET status = ?, adoption_json = ?, adoption_hash = ?, updated_at = ?
       WHERE effect_id = ? AND adoption_hash IS NULL`,
    ).run(effectStatus, adoptionJson, adoptionHash, observedAt, input.effect_id);
    db.prepare(
      `UPDATE review_attempts
       SET status = ?, run_state = ?, updated_at = ? WHERE attempt_id = ?`,
    ).run(
      attemptStatus,
      accepted ? "queued" : null,
      observedAt,
      attempt.attempt_id,
    );
    if (indeterminate) {
      const obligationId = stableId(
        "review-obligation",
        [input.instance_id, "reviewer_launch_reconciliation"],
      );
      db.prepare(
        `INSERT INTO review_obligations
          (obligation_id, instance_id, effect_id, kind, obligation_key, status,
           detail_json, created_at, updated_at)
         VALUES (?, ?, ?, 'reviewer_launch_reconciliation', 'reviewer', 'pending', ?, ?, ?)`,
      ).run(
        obligationId,
        input.instance_id,
        input.effect_id,
        canonicalizeIndependentReviewJson({ adoption_hash: adoptionHash }),
        observedAt,
        observedAt,
      );
    }
    updateInstanceInTransaction(db, instance, {
      state: accepted ? "reviewing" : indeterminate ? "launch_indeterminate" : "terminal",
      intrinsic_status: accepted || indeterminate ? "pending" : "invalid",
      publication_status: "not_started",
      disposition: accepted ? "active" : indeterminate ? "pending" : "failed",
      updated_at: observedAt,
      terminal_at: accepted || indeterminate ? null : observedAt,
    });
    appendReviewEventInTransaction(db, {
      instance_id: input.instance_id,
      event_type: "reviewer_launch_adopted",
      identity_parts: [input.effect_id],
      occurred_at: observedAt,
      payload: {
        effect_id: input.effect_id,
        effect_request_hash: effectRequestHash,
        claimed_fence: input.claimed_fence,
        adoption_hash: adoptionHash,
        outcome_status: normalizedOutcome.status,
        reviewer_run_id: normalizedOutcome.run_id,
      },
    });
    return true;
  });
  return {
    adopted,
    projection: requireIndependentReviewAdminProjection(db, input.instance_id, observedAt),
  };
}

function normalizeLaunchReconciliationObservation(
  rawObservation: ReviewerLaunchReconciliationObservation,
  observedAt: string,
): {
  schema_version: typeof REVIEW_LAUNCH_RECONCILIATION_OBSERVATION_SCHEMA_VERSION;
  observation_id: string;
  issuer: "run_service";
  status: "adopted" | "failed" | "indeterminate";
  run_id: string;
  observed_intent_hash: string;
  supervisor_receipt_digest?: string;
  reason_code?: string;
  observed_at: string;
} {
  const root = asRecord(rawObservation);
  const status = root?.["status"];
  const expectedKeys = status === "adopted"
    ? "issuer\0observation_id\0observed_intent_hash\0run_id\0schema_version\0status\0supervisor_receipt_digest"
    : status === "failed"
      ? "issuer\0observation_id\0observed_intent_hash\0reason_code\0run_id\0schema_version\0status\0supervisor_receipt_digest"
      : status === "indeterminate"
        ? "issuer\0observation_id\0observed_intent_hash\0reason_code\0run_id\0schema_version\0status"
        : "";
  if (
    !root
    || (status !== "adopted" && status !== "failed" && status !== "indeterminate")
    || Object.keys(root).sort().join("\0") !== expectedKeys
    || root["schema_version"] !== REVIEW_LAUNCH_RECONCILIATION_OBSERVATION_SCHEMA_VERSION
    || root["issuer"] !== "run_service"
    || typeof root["observation_id"] !== "string"
    || typeof root["run_id"] !== "string"
    || typeof root["observed_intent_hash"] !== "string"
    || ((status === "adopted" || status === "failed")
      && typeof root["supervisor_receipt_digest"] !== "string")
    || ((status === "failed" || status === "indeterminate")
      && typeof root["reason_code"] !== "string")
  ) {
    throw new ReviewCoordinatorError(
      "effect_conflict",
      "RunService launch reconciliation observation must use its closed status-specific contract.",
    );
  }
  return {
    schema_version: REVIEW_LAUNCH_RECONCILIATION_OBSERVATION_SCHEMA_VERSION,
    observation_id: requiredText(root["observation_id"], "observation_id"),
    issuer: "run_service",
    status: status as "adopted" | "failed" | "indeterminate",
    run_id: requiredText(root["run_id"], "reconciliation.run_id"),
    observed_intent_hash: assertDigest(
      root["observed_intent_hash"],
      "reconciliation.observed_intent_hash",
    ),
    ...(status === "adopted" || status === "failed"
      ? {
          supervisor_receipt_digest: assertDigest(
            root["supervisor_receipt_digest"] as string,
            "reconciliation.supervisor_receipt_digest",
          ),
        }
      : {}),
    ...(status === "failed" || status === "indeterminate"
      ? { reason_code: requiredText(root["reason_code"] as string, "reconciliation.reason_code") }
      : {}),
    observed_at: observedAt,
  };
}

/**
 * Append a RunService-minted observation that reconciles an already
 * indeterminate launch. This transition never creates or reclaims a run and
 * deliberately does not require the caller reducer's short-lived claim.
 */
export function recordReviewerLaunchReconciliationFromRunService(
  db: StateDriverDatabase,
  input: {
    instance_id: string;
    observation: ReviewerLaunchReconciliationObservation;
    observed_at: string;
  },
): { recorded: boolean; projection: IndependentReviewAdminProjection } {
  const observedAt = canonicalTimestamp(input.observed_at, "launch reconciliation observed_at");
  const observation = normalizeLaunchReconciliationObservation(input.observation, observedAt);
  const observationJson = canonicalizeIndependentReviewJson(observation);
  const observationHash = createHash("sha256").update(observationJson, "utf8").digest("hex");
  const receiptDigest = hashIndependentReviewValue({
    issuer: observation.issuer,
    status: observation.status,
    run_id: observation.run_id,
    observed_intent_hash: observation.observed_intent_hash,
    ...(observation.supervisor_receipt_digest
      ? { supervisor_receipt_digest: observation.supervisor_receipt_digest }
      : {}),
    ...(observation.reason_code ? { reason_code: observation.reason_code } : {}),
  });

  const recorded = withImmediateTransaction(db, () => {
    const instance = requireInstance(db, input.instance_id);
    const attempt = requireAttempt(db, input.instance_id);
    const effect = effectForKind(db, input.instance_id, "reviewer_launch");
    if (
      !effect
      || effect.instance_id !== input.instance_id
      || effect.kind !== "reviewer_launch"
      || effect.effect_key !== "reviewer"
      || effect.attempt_id !== attempt.attempt_id
      || !effect.adoption_json
      || !effect.adoption_hash
      || createHash("sha256").update(effect.adoption_json, "utf8").digest("hex")
        !== effect.adoption_hash
    ) {
      throw new ReviewCoordinatorError(
        "effect_conflict",
        `Review ${input.instance_id} has no intact indeterminate launch effect to reconcile.`,
      );
    }
    const originalAdoption = asRecord(parseJson<unknown>(
      effect.adoption_json,
      "reviewer launch adoption",
    ));
    if (
      !originalAdoption
      || Object.keys(originalAdoption).sort().join("\0")
        !== "claimed_fence\0observed_intent_hash\0reason_code\0run_id\0status"
      || originalAdoption["status"] !== "indeterminate"
      || typeof originalAdoption["claimed_fence"] !== "number"
      || effect.claimed_fence === null
      || originalAdoption["claimed_fence"] !== asNumber(effect.claimed_fence!)
      || typeof originalAdoption["reason_code"] !== "string"
      || originalAdoption["run_id"] !== attempt.reviewer_run_id
      || originalAdoption["observed_intent_hash"] !== attempt.launch_intent_hash
      || observation.run_id !== attempt.reviewer_run_id
      || observation.observed_intent_hash !== attempt.launch_intent_hash
    ) {
      throw new ReviewCoordinatorError(
        "effect_conflict",
        `Review ${input.instance_id} launch reconciliation does not match the original adoption and attempt.`,
      );
    }

    const obligation = db.prepare(
      `SELECT obligation_id, instance_id, effect_id, kind, obligation_key, status,
              detail_json, created_at, updated_at
         FROM review_obligations
        WHERE instance_id = ? AND effect_id = ?
          AND kind = 'reviewer_launch_reconciliation' AND obligation_key = 'reviewer'`,
    ).get(input.instance_id, effect.effect_id) as RawReviewObligation | undefined;
    const obligationDetail = obligation
      ? asRecord(parseJson<unknown>(obligation.detail_json, "launch reconciliation obligation"))
      : undefined;
    if (
      !obligation
      || obligation.instance_id !== input.instance_id
      || obligation.effect_id !== effect.effect_id
      || obligationDetail?.["adoption_hash"] !== effect.adoption_hash
    ) {
      throw new ReviewCoordinatorError(
        "effect_conflict",
        `Review ${input.instance_id} has no exact launch reconciliation obligation.`,
      );
    }

    const existingObservation = db.prepare(
      `SELECT observation_id, instance_id, effect_id, effect_key, observation_seq, schema_version,
              status, receipt_digest, payload_json, payload_hash, observed_at
         FROM review_effect_observations WHERE effect_id = ? AND observation_id = ?`,
    ).get(effect.effect_id, observation.observation_id) as RawReviewEffectObservation | undefined;
    if (existingObservation) {
      if (
        existingObservation.instance_id !== input.instance_id
        || existingObservation.effect_key !== "reviewer"
        || existingObservation.schema_version
          !== REVIEW_LAUNCH_RECONCILIATION_OBSERVATION_SCHEMA_VERSION
        || existingObservation.status !== observation.status
        || existingObservation.receipt_digest !== receiptDigest
        || existingObservation.payload_json !== observationJson
        || existingObservation.payload_hash !== observationHash
      ) {
        throw new ReviewCoordinatorError(
          "effect_conflict",
          `Launch reconciliation observation ${observation.observation_id} already names different bytes.`,
        );
      }
      return false;
    }

    const observations = launchReconciliationObservationsForEffect(db, effect.effect_id);
    if (
      observations.some((row) => row.status === "adopted" || row.status === "failed")
      || instance.state !== "launch_indeterminate"
      || attempt.status !== "launch_indeterminate"
      || effect.status !== "indeterminate"
      || obligation.status !== "pending"
    ) {
      throw new ReviewCoordinatorError(
        "invalid_transition",
        `Review ${input.instance_id} launch reconciliation is already resolved or no longer pending.`,
      );
    }
    if (observations.length >= MAX_LAUNCH_RECONCILIATION_OBSERVATIONS) {
      throw new ReviewCoordinatorError(
        "effect_conflict",
        `Launch reconciliation observation ledger is bounded to ${String(MAX_LAUNCH_RECONCILIATION_OBSERVATIONS)} rows.`,
      );
    }
    assertMutationTime(observedAt, [
      { field: "review instance updated_at", value: instance.updated_at },
      { field: "review attempt updated_at", value: attempt.updated_at },
      { field: "review launch effect updated_at", value: effect.updated_at },
      { field: "launch reconciliation obligation updated_at", value: obligation.updated_at },
      ...observations.map((row) => ({
        field: "launch reconciliation observation observed_at",
        value: row.observed_at,
      })),
    ]);

    const observationSequence = observations.length + 1;
    db.prepare(
      `INSERT INTO review_effect_observations
        (observation_id, instance_id, effect_id, effect_key, observation_seq, schema_version,
         status, receipt_digest, payload_json, payload_hash, observed_at)
       VALUES (?, ?, ?, 'reviewer', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      observation.observation_id,
      input.instance_id,
      effect.effect_id,
      observationSequence,
      REVIEW_LAUNCH_RECONCILIATION_OBSERVATION_SCHEMA_VERSION,
      observation.status,
      receiptDigest,
      observationJson,
      observationHash,
      observedAt,
    );

    const resolved = observation.status !== "indeterminate";
    const nextEffectStatus: ReviewEffectStatus = observation.status === "adopted"
      ? "succeeded"
      : observation.status === "failed"
        ? "failed"
        : "indeterminate";
    const nextAttemptStatus: ReviewAttemptStatus = observation.status === "adopted"
      ? "running"
      : observation.status === "failed"
        ? "failed"
        : "launch_indeterminate";
    db.prepare(
      `UPDATE review_effects SET status = ?, updated_at = ? WHERE effect_id = ?`,
    ).run(nextEffectStatus, observedAt, effect.effect_id);
    db.prepare(
      `UPDATE review_attempts SET status = ?, run_state = ?, updated_at = ? WHERE attempt_id = ?`,
    ).run(
      nextAttemptStatus,
      observation.status === "adopted" ? "queued" : null,
      observedAt,
      attempt.attempt_id,
    );
    db.prepare(
      `UPDATE review_obligations
       SET status = ?, detail_json = ?, updated_at = ? WHERE obligation_id = ?`,
    ).run(
      resolved ? "resolved" : "pending",
      canonicalizeIndependentReviewJson({
        adoption_hash: effect.adoption_hash,
        latest_observation_id: observation.observation_id,
        latest_observation_status: observation.status,
        observation_count: observationSequence,
      }),
      observedAt,
      obligation.obligation_id,
    );
    updateInstanceInTransaction(db, instance, {
      state: observation.status === "adopted" ? "reviewing"
        : observation.status === "failed" ? "terminal" : "launch_indeterminate",
      intrinsic_status: observation.status === "failed" ? "invalid" : "pending",
      publication_status: "not_started",
      disposition: observation.status === "adopted" ? "active"
        : observation.status === "failed" ? "failed" : "pending",
      updated_at: observedAt,
      terminal_at: observation.status === "failed" ? observedAt : null,
    });
    appendReviewEventInTransaction(db, {
      instance_id: input.instance_id,
      event_type: "reviewer_launch_reconciled",
      identity_parts: [effect.effect_id, observation.observation_id],
      occurred_at: observedAt,
      payload: {
        effect_id: effect.effect_id,
        observation_id: observation.observation_id,
        observation_seq: observationSequence,
        observation_hash: observationHash,
        receipt_digest: receiptDigest,
        status: observation.status,
      },
    });
    return true;
  });

  return {
    recorded,
    projection: requireIndependentReviewAdminProjection(db, input.instance_id, observedAt),
  };
}

const ACTIVE_RUN_STATES: ReadonlySet<RunState> = new Set([
  "queued",
  "dispatching",
  "running",
]);
const ALL_RUN_STATES: ReadonlySet<string> = new Set(ALL_STATES);
const RUN_STATE_PHASE: Readonly<Record<RunState, number>> = {
  queued: 0,
  dispatching: 1,
  running: 2,
  succeeded: 3,
  failed: 3,
  partial: 3,
  cancelled: 3,
  auth_error: 3,
  infra_error: 3,
  completed_dirty: 3,
};

function runtimeRunState(value: unknown, field: string): RunState {
  if (typeof value !== "string" || !ALL_RUN_STATES.has(value)) {
    throw new ReviewCoordinatorError(
      "invalid_transition",
      `${field} is not a recognized RunService state.`,
    );
  }
  return value as RunState;
}

function assertMonotonicRunObservation(previous: RunState, next: RunState): void {
  if (previous === next) return;
  if (RUN_STATE_PHASE[next] <= RUN_STATE_PHASE[previous]) {
    throw new ReviewCoordinatorError(
      "invalid_transition",
      `Reviewer run observation cannot regress from ${previous} to ${next}.`,
    );
  }
}

/** Reduce one normalized RunService observation without copying leaf authority. */
/** Internal reducer input; only RunService resolves the authoritative leaf state. */
export function recordReviewerRunObservationFromRunService(
  db: StateDriverDatabase,
  input: {
    instance_id: string;
    observation_id: string;
    reviewer_run_id: string;
    run_state: RunState;
    observed_at: string;
  },
): { recorded: boolean; projection: IndependentReviewAdminProjection } {
  const runState = runtimeRunState(input.run_state, "run_state");
  const observedAt = canonicalTimestamp(input.observed_at, "run observation observed_at");
  const recorded = withImmediateTransaction(db, () => {
    const instance = requireInstance(db, input.instance_id);
    const attempt = requireAttempt(db, input.instance_id);
    if (attempt.reviewer_run_id !== input.reviewer_run_id) {
      throw new ReviewCoordinatorError(
        "invalid_transition",
        `Run observation named ${input.reviewer_run_id}, expected ${attempt.reviewer_run_id}.`,
      );
    }
    const launchEffect = db
      .prepare(`${SELECT_EFFECT} WHERE instance_id = ? AND kind = 'reviewer_launch'`)
      .get(input.instance_id) as RawReviewEffect | undefined;
    if (!launchEffect || launchEffect.status !== "succeeded") {
      throw new ReviewCoordinatorError(
        "invalid_transition",
        "Run observations require an adopted reviewer launch effect.",
      );
    }
    const observationId = requiredText(input.observation_id, "observation_id");
    const observationEvent = {
      instance_id: input.instance_id,
      event_type: "reviewer_run_observed",
      identity_parts: [observationId],
      occurred_at: observedAt,
      payload: {
        reviewer_run_id: input.reviewer_run_id,
        run_state: runState,
      },
    };
    const payloadJson = canonicalizeIndependentReviewJson(observationEvent.payload);
    const payloadHash = createHash("sha256").update(payloadJson, "utf8").digest("hex");
    const eventId = reviewEventId(
      observationEvent.instance_id,
      observationEvent.event_type,
      observationEvent.identity_parts,
    );
    const existingEvent = db
      .prepare(
        `SELECT event_id, instance_id, event_seq, event_type, payload_json,
                payload_hash, occurred_at
         FROM review_events WHERE event_id = ?`,
      )
      .get(eventId) as RawReviewEvent | undefined;
    if (existingEvent) {
      if (
        existingEvent.instance_id !== observationEvent.instance_id
        || existingEvent.event_type !== observationEvent.event_type
        || existingEvent.payload_hash !== payloadHash
        || existingEvent.payload_json !== payloadJson
      ) {
        throw new ReviewCoordinatorError(
          "event_payload_conflict",
          `Review event ${eventId} already exists with different canonical bytes.`,
        );
      }
      return false;
    }
    const previousRunState = runtimeRunState(attempt.run_state, "persisted attempt.run_state");
    if (previousRunState === runState) {
      return false;
    }
    if (instance.state === "terminal" || instance.state === "launch_indeterminate") {
      throw new ReviewCoordinatorError(
        "invalid_transition",
        `Review ${input.instance_id} cannot consume a new run observation from state ${instance.state}.`,
      );
    }
    assertMonotonicRunObservation(previousRunState, runState);
    assertMutationTime(observedAt, [
      { field: "review instance updated_at", value: instance.updated_at },
      { field: "review attempt updated_at", value: attempt.updated_at },
      { field: "review launch effect updated_at", value: launchEffect.updated_at },
    ]);
    const event = appendReviewEventInTransaction(db, observationEvent);
    if (!event.inserted) {
      return false;
    }

    let attemptStatus: ReviewAttemptStatus;
    let state: ReviewCoordinatorState;
    let intrinsic: ReviewIntrinsicStatus = "pending";
    let disposition: ReviewDisposition = "active";
    let terminalAt: string | null = null;
    if (ACTIVE_RUN_STATES.has(runState)) {
      attemptStatus = "running";
      state = "reviewing";
    } else if (runState === "succeeded") {
      attemptStatus = "succeeded";
      state = "awaiting_evidence";
    } else {
      attemptStatus = runState === "cancelled" ? "cancelled" : "failed";
      state = "terminal";
      intrinsic = "invalid";
      disposition = "failed";
      terminalAt = observedAt;
    }
    db.prepare(
      `UPDATE review_attempts
       SET status = ?, run_state = ?, updated_at = ? WHERE attempt_id = ?`,
    ).run(attemptStatus, runState, observedAt, attempt.attempt_id);
    updateInstanceInTransaction(db, instance, {
      state,
      intrinsic_status: intrinsic,
      publication_status: "not_started",
      disposition,
      updated_at: observedAt,
      terminal_at: terminalAt,
    });
    return true;
  });
  return {
    recorded,
    projection: requireIndependentReviewAdminProjection(db, input.instance_id, observedAt),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function objectString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function objectNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function validateExactKeys(
  value: Record<string, unknown> | undefined,
  input: {
    path: string;
    required: readonly string[];
    optional?: readonly string[];
  },
  invalidReasons: string[],
): void {
  if (!value) return;
  const required = new Set(input.required);
  const allowed = new Set([...input.required, ...(input.optional ?? [])]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalidReasons.push(`${input.path}_unknown_field`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalidReasons.push(`${input.path}_${key}_missing`);
  }
}

function exactBoundedString(
  value: unknown,
  input: { path: string; max_bytes: number; allow_newlines?: boolean },
  invalidReasons: string[],
): string | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.includes("\0")
    || (!input.allow_newlines && (value.includes("\r") || value.includes("\n")))
    || Buffer.byteLength(value, "utf8") > input.max_bytes
  ) {
    invalidReasons.push(`${input.path}_invalid`);
    return undefined;
  }
  return value;
}

function exactBoundedInteger(
  value: unknown,
  input: { path: string; minimum: number; maximum: number },
  invalidReasons: string[],
): number | undefined {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < input.minimum
    || value > input.maximum
  ) {
    invalidReasons.push(`${input.path}_invalid`);
    return undefined;
  }
  return value;
}

function emptyCounts(): Record<ReviewFindingSeverity | "total", number> {
  return { P0: 0, P1: 0, P2: 0, P3: 0, total: 0 };
}

/**
 * Pure caller-specific evaluator for intrinsic `review-findings/v2`. It does
 * not inspect delivery fields and rejects the legacy schema outright.
 */
export function evaluateReviewFindingsV2(
  artifact: unknown,
  context: {
    instance_id: string;
    attempt_id: string;
    reviewer_run_id: string;
    round: number;
    producer_generation: number;
    producer_fence: number;
    target: ReviewTargetIdentity;
    expected_artifact_digest: string;
  },
): ReviewEvidenceEvaluation {
  const invalidReasons: string[] = [];
  const evidenceId = stableId("review-evidence", [context.instance_id, context.attempt_id]);
  let artifactDigest: string;
  let artifactJson: string;
  try {
    artifactJson = canonicalizeIndependentReviewJson(artifact);
    artifactDigest = createHash("sha256").update(artifactJson, "utf8").digest("hex");
  } catch (error) {
    return {
      schema_version: REVIEW_EVIDENCE_SCHEMA_VERSION,
      evidence_id: evidenceId,
      artifact_digest: "0".repeat(64),
      intrinsic_status: "invalid",
      verdict: null,
      coverage_status: "unknown",
      finding_count: 0,
      counts: emptyCounts(),
      invalid_reasons: [error instanceof Error ? error.message : String(error)],
    };
  }
  if (Buffer.byteLength(artifactJson, "utf8") > MAX_REVIEW_ARTIFACT_BYTES) {
    invalidReasons.push("artifact_too_large");
  }
  if (artifactDigest !== context.expected_artifact_digest.toLowerCase()) {
    invalidReasons.push("artifact_digest_mismatch");
  }
  const root = asRecord(artifact);
  if (!root) {
    invalidReasons.push("artifact_not_object");
  }
  validateExactKeys(root, {
    path: "artifact",
    required: [
      "schema_version",
      "evidence_id",
      "review_instance_id",
      "reviewer_run_id",
      "reviewer_attempt_id",
      "round",
      "producer_generation",
      "producer_fence",
      "target",
      "review_status",
      "coverage_status",
      "verdict",
      "counts",
      "findings",
    ],
  }, invalidReasons);
  const schemaVersion = root?.["schema_version"];
  if (schemaVersion !== REVIEW_FINDINGS_SCHEMA_VERSION) {
    invalidReasons.push(
      schemaVersion === "review-findings/v1"
        ? "legacy_review_findings_v1_refused"
        : "schema_version_invalid",
    );
  }
  if (root && Object.hasOwn(root, "delivery_status")) {
    invalidReasons.push("worker_delivery_status_forbidden");
  }

  const observedEvidenceId = exactBoundedString(root?.["evidence_id"], {
    path: "evidence_id",
    max_bytes: MAX_REVIEW_ID_BYTES,
  }, invalidReasons);
  exactBoundedString(root?.["review_instance_id"], {
    path: "review_instance_id",
    max_bytes: MAX_REVIEW_ID_BYTES,
  }, invalidReasons);
  exactBoundedString(root?.["reviewer_run_id"], {
    path: "reviewer_run_id",
    max_bytes: MAX_REVIEW_ID_BYTES,
  }, invalidReasons);
  exactBoundedString(root?.["reviewer_attempt_id"], {
    path: "reviewer_attempt_id",
    max_bytes: MAX_REVIEW_ID_BYTES,
  }, invalidReasons);
  exactBoundedInteger(root?.["round"], {
    path: "round",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  }, invalidReasons);
  exactBoundedInteger(root?.["producer_generation"], {
    path: "producer_generation",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  }, invalidReasons);
  exactBoundedInteger(root?.["producer_fence"], {
    path: "producer_fence",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  }, invalidReasons);

  if (observedEvidenceId !== evidenceId) {
    invalidReasons.push("evidence_id_mismatch");
  }
  if (objectString(root?.["review_instance_id"]) !== context.instance_id) {
    invalidReasons.push("review_instance_mismatch");
  }
  if (objectString(root?.["reviewer_attempt_id"]) !== context.attempt_id) {
    invalidReasons.push("review_attempt_mismatch");
  }
  if (objectString(root?.["reviewer_run_id"]) !== context.reviewer_run_id) {
    invalidReasons.push("reviewer_run_mismatch");
  }
  if (objectPositiveInteger(root?.["round"]) !== context.round) {
    invalidReasons.push("review_round_mismatch");
  }
  if (objectPositiveInteger(root?.["producer_generation"]) !== context.producer_generation) {
    invalidReasons.push("producer_generation_mismatch");
  }
  if (objectPositiveInteger(root?.["producer_fence"]) !== context.producer_fence) {
    invalidReasons.push("producer_fence_mismatch");
  }

  const target = asRecord(root?.["target"]);
  if (!target) invalidReasons.push("target_not_object");
  validateExactKeys(target, {
    path: "target",
    required: ["repository", "pull_request", "commit_sha"],
  }, invalidReasons);
  exactBoundedString(target?.["repository"], {
    path: "target_repository",
    max_bytes: MAX_REPOSITORY_BYTES,
  }, invalidReasons);
  exactBoundedInteger(target?.["pull_request"], {
    path: "target_pull_request",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  }, invalidReasons);
  const targetCommit = exactBoundedString(target?.["commit_sha"], {
    path: "target_commit_sha",
    max_bytes: 64,
  }, invalidReasons);
  if (targetCommit && !SHA_PATTERN.test(targetCommit)) {
    invalidReasons.push("target_commit_sha_invalid");
  }
  if (
    objectString(target?.["repository"]) !== context.target.repository
    || objectPositiveInteger(target?.["pull_request"]) !== context.target.pull_request
    || objectString(target?.["commit_sha"])?.toLowerCase() !== context.target.commit_sha.toLowerCase()
  ) {
    invalidReasons.push("review_target_mismatch");
  }

  const reviewStatus = typeof root?.["review_status"] === "string"
    ? root["review_status"]
    : "unknown";
  const coverageStatus = typeof root?.["coverage_status"] === "string"
    ? root["coverage_status"]
    : "unknown";
  if (reviewStatus !== "complete" && reviewStatus !== "partial" && reviewStatus !== "invalid") {
    invalidReasons.push("review_status_invalid");
  }
  if (coverageStatus !== "full" && coverageStatus !== "partial" && coverageStatus !== "unknown") {
    invalidReasons.push("coverage_status_invalid");
  }
  if (reviewStatus !== "complete") {
    invalidReasons.push("review_status_incomplete");
  }
  if (coverageStatus !== "full") {
    invalidReasons.push("coverage_not_full");
  }

  const findingsValue = root?.["findings"];
  const findings = Array.isArray(findingsValue) ? findingsValue : [];
  if (!Array.isArray(findingsValue)) {
    invalidReasons.push("findings_not_array");
  }
  if (findings.length > MAX_REVIEW_FINDINGS) {
    invalidReasons.push("findings_too_many");
  }
  const actualCounts = emptyCounts();
  const ids = new Set<string>();
  for (const [index, value] of findings.slice(0, MAX_REVIEW_FINDINGS).entries()) {
    const finding = asRecord(value);
    if (!finding) invalidReasons.push(`finding_${String(index)}_not_object`);
    validateExactKeys(finding, {
      path: `finding_${String(index)}`,
      required: ["id", "severity"],
      optional: ["title", "path", "line"],
    }, invalidReasons);
    const id = objectString(finding?.["id"]);
    const severity = typeof finding?.["severity"] === "string"
      ? finding["severity"]
      : undefined;
    exactBoundedString(finding?.["id"], {
      path: `finding_${String(index)}_id`,
      max_bytes: MAX_REVIEW_ID_BYTES,
    }, invalidReasons);
    if (Object.hasOwn(finding ?? {}, "title")) {
      exactBoundedString(finding?.["title"], {
        path: `finding_${String(index)}_title`,
        max_bytes: MAX_FINDING_TITLE_BYTES,
        allow_newlines: true,
      }, invalidReasons);
    }
    if (Object.hasOwn(finding ?? {}, "path")) {
      exactBoundedString(finding?.["path"], {
        path: `finding_${String(index)}_path`,
        max_bytes: MAX_FINDING_PATH_BYTES,
      }, invalidReasons);
    }
    if (Object.hasOwn(finding ?? {}, "line")) {
      exactBoundedInteger(finding?.["line"], {
        path: `finding_${String(index)}_line`,
        minimum: 1,
        maximum: MAX_FINDING_LINE,
      }, invalidReasons);
    }
    if (!id) {
      invalidReasons.push(`finding_${String(index)}_id_invalid`);
    } else if (ids.has(id)) {
      invalidReasons.push("duplicate_finding_id");
    } else {
      ids.add(id);
    }
    if (severity === "P0" || severity === "P1" || severity === "P2" || severity === "P3") {
      actualCounts[severity] += 1;
      actualCounts.total += 1;
    } else {
      invalidReasons.push(`finding_${String(index)}_severity_invalid`);
    }
  }

  const counts = asRecord(root?.["counts"]);
  if (!counts) invalidReasons.push("counts_not_object");
  validateExactKeys(counts, {
    path: "counts",
    required: ["P0", "P1", "P2", "P3", "total"],
  }, invalidReasons);
  for (const key of ["P0", "P1", "P2", "P3", "total"] as const) {
    const value = objectNonNegativeInteger(counts?.[key]);
    if (value !== undefined && (!Number.isSafeInteger(value) || value > MAX_REVIEW_FINDINGS)) {
      invalidReasons.push(`finding_count_${key}_invalid`);
    }
    if (value === undefined || value !== actualCounts[key]) {
      invalidReasons.push(`finding_count_${key}_mismatch`);
    }
  }

  const verdictValue = root?.["verdict"];
  if (verdictValue !== "mergeable" && verdictValue !== "not_mergeable" && verdictValue !== null) {
    invalidReasons.push("verdict_invalid");
  }
  const verdict = verdictValue === "mergeable" || verdictValue === "not_mergeable"
    ? verdictValue
    : null;
  if (actualCounts.total === 0 && verdict !== "mergeable") {
    invalidReasons.push("zero_finding_verdict_not_mergeable");
  }
  if (actualCounts.total > 0 && verdict !== "not_mergeable") {
    invalidReasons.push("nonzero_finding_verdict_invalid");
  }

  return {
    schema_version: REVIEW_EVIDENCE_SCHEMA_VERSION,
    evidence_id: evidenceId,
    artifact_digest: artifactDigest,
    intrinsic_status: invalidReasons.length > 0
      ? "invalid"
      : actualCounts.total === 0
        ? "passed"
        : "not_passed",
    verdict,
    coverage_status: coverageStatus,
    finding_count: actualCounts.total,
    counts: actualCounts,
    invalid_reasons: [...new Set(invalidReasons)],
  };
}

function normalizeRunEvidenceReceipt(
  receipt: ReviewRunEvidenceReceipt,
  input: {
    instance_id: string;
    attempt: RawReviewAttempt;
    artifact_json: string;
    recorded_at: string;
  },
): { receipt: ReviewRunEvidenceReceipt; receipt_json: string; receipt_hash: string } {
  const root = asRecord(receipt);
  const artifact = asRecord(root?.["artifact"]);
  if (
    !root
    || Object.keys(root).sort().join("\0") !== [
      "artifact",
      "issued_at",
      "issuer",
      "reviewer_attempt_id",
      "run_id",
      "schema_version",
      "terminal_receipt_digest",
    ].sort().join("\0")
    || receipt.schema_version !== REVIEW_RUN_EVIDENCE_RECEIPT_SCHEMA_VERSION
    || receipt.issuer !== "run_service"
    || !artifact
    || Object.keys(artifact).sort().join("\0") !== [
      "canonical_sha256",
      "canonical_size_bytes",
      "locator",
      "media_type",
      "name",
      "source_sha256",
      "source_size_bytes",
    ].sort().join("\0")
  ) {
    throw new ReviewCoordinatorError(
      "invalid_evidence",
      "RunService evidence receipt has unknown, missing, or unsupported fields.",
    );
  }
  const runId = requiredText(receipt.run_id, "evidence_receipt.run_id");
  const attemptId = requiredText(
    receipt.reviewer_attempt_id,
    "evidence_receipt.reviewer_attempt_id",
  );
  const issuedAt = canonicalTimestamp(receipt.issued_at, "evidence_receipt.issued_at");
  const terminalReceiptDigest = assertDigest(
    receipt.terminal_receipt_digest,
    "evidence_receipt.terminal_receipt_digest",
  );
  const canonicalSha = assertDigest(
    receipt.artifact.canonical_sha256,
    "evidence_receipt.artifact.canonical_sha256",
  );
  const sourceSha = assertDigest(
    receipt.artifact.source_sha256,
    "evidence_receipt.artifact.source_sha256",
  );
  const locator = requiredText(receipt.artifact.locator, "evidence_receipt.artifact.locator");
  if (
    runId !== input.attempt.reviewer_run_id
    || attemptId !== input.attempt.attempt_id
    || receipt.artifact.name !== "findings.json"
    || receipt.artifact.media_type !== "application/json"
    || locator !== `calyx-run-artifact:${runId}:findings.json`
    || Buffer.byteLength(locator, "utf8") > MAX_ARTIFACT_LOCATOR_BYTES
    || !Number.isSafeInteger(receipt.artifact.canonical_size_bytes)
    || !Number.isSafeInteger(receipt.artifact.source_size_bytes)
    || receipt.artifact.source_size_bytes < 1
    || receipt.artifact.source_size_bytes > MAX_REVIEW_ARTIFACT_BYTES
    || receipt.artifact.canonical_size_bytes < 1
    || receipt.artifact.canonical_size_bytes > MAX_REVIEW_ARTIFACT_BYTES
    || receipt.artifact.canonical_size_bytes !== Buffer.byteLength(input.artifact_json, "utf8")
    || canonicalSha !== createHash("sha256").update(input.artifact_json, "utf8").digest("hex")
    || issuedAt > input.recorded_at
  ) {
    throw new ReviewCoordinatorError(
      "invalid_evidence",
      `RunService evidence receipt does not correspond to review ${input.instance_id}.`,
    );
  }
  const normalized: ReviewRunEvidenceReceipt = {
    schema_version: REVIEW_RUN_EVIDENCE_RECEIPT_SCHEMA_VERSION,
    issuer: "run_service",
    run_id: runId,
    reviewer_attempt_id: attemptId,
    terminal_receipt_digest: terminalReceiptDigest,
    artifact: {
      name: "findings.json",
      locator,
      media_type: "application/json",
      source_sha256: sourceSha,
      source_size_bytes: receipt.artifact.source_size_bytes,
      canonical_sha256: canonicalSha,
      canonical_size_bytes: receipt.artifact.canonical_size_bytes,
    },
    issued_at: issuedAt,
  };
  const receiptJson = canonicalizeIndependentReviewJson(normalized);
  return {
    receipt: normalized,
    receipt_json: receiptJson,
    receipt_hash: createHash("sha256").update(receiptJson, "utf8").digest("hex"),
  };
}

function admittedLinearIssue(instance: RawReviewInstance): string {
  const request = asRecord(parseJson<unknown>(instance.request_json, "review request"));
  const publicationTarget = asRecord(request?.["publication_target"]);
  if (
    !publicationTarget
    || Object.keys(publicationTarget).sort().join("\0") !== "linear_issue"
    || typeof publicationTarget["linear_issue"] !== "string"
  ) {
    throw new ReviewCoordinatorError(
      "schema_absent",
      `Review ${instance.instance_id} lacks an immutable Linear publication target.`,
    );
  }
  return requiredText(publicationTarget["linear_issue"], "publication_target.linear_issue");
}

/** Internal DB writer; RunService owns receipt/artifact resolution and issuance. */
export function recordIndependentReviewEvidenceFromRunService(
  db: StateDriverDatabase,
  input: {
    instance_id: string;
    artifact: unknown;
    evidence_receipt: ReviewRunEvidenceReceipt;
    reviewer_run_issue: string;
    publisher_identities: ReviewPublisherIdentities;
    recorded_at: string;
  },
): {
  recorded: boolean;
  evaluation: ReviewEvidenceEvaluation;
  publication_effect_ids: string[];
  projection: IndependentReviewAdminProjection;
} {
  const recordedAt = canonicalTimestamp(input.recorded_at, "evidence recorded_at");
  const instanceBefore = requireInstance(db, input.instance_id);
  const attemptBefore = requireAttempt(db, input.instance_id);
  const linearIssue = admittedLinearIssue(instanceBefore);
  if (requiredText(input.reviewer_run_issue, "reviewer_run_issue") !== linearIssue) {
    throw new ReviewCoordinatorError(
      "invalid_transition",
      "Reviewer run issue correspondence does not match the immutable publication target.",
    );
  }
  const artifactJson = canonicalizeIndependentReviewJson(input.artifact);
  const evidenceAuthority = normalizeRunEvidenceReceipt(input.evidence_receipt, {
    instance_id: input.instance_id,
    attempt: attemptBefore,
    artifact_json: artifactJson,
    recorded_at: recordedAt,
  });
  const evaluation = evaluateReviewFindingsV2(input.artifact, {
    instance_id: input.instance_id,
    attempt_id: attemptBefore.attempt_id,
    reviewer_run_id: attemptBefore.reviewer_run_id,
    round: asNumber(instanceBefore.round),
    producer_generation: asNumber(attemptBefore.producer_generation),
    producer_fence: asNumber(attemptBefore.producer_fence),
    target: {
      repository: instanceBefore.repository,
      pull_request: asNumber(instanceBefore.pull_request),
      commit_sha: instanceBefore.target_sha,
    },
    expected_artifact_digest: evidenceAuthority.receipt.artifact.canonical_sha256,
  });
  const rawArtifactSchema = objectString(asRecord(input.artifact)?.["schema_version"]);
  const observedArtifactSchema = rawArtifactSchema
    && Buffer.byteLength(rawArtifactSchema, "utf8") <= MAX_POLICY_VERSION_BYTES
    ? rawArtifactSchema
    : "unknown";
  let publication: ReturnType<typeof deriveReviewPublicationRequest> | null = null;
  if (evaluation.intrinsic_status !== "invalid" && evaluation.verdict !== null) {
    try {
      publication = deriveReviewPublicationRequest({
        instance_id: input.instance_id,
        round: asNumber(instanceBefore.round),
        target: {
          repository: instanceBefore.repository,
          pull_request: asNumber(instanceBefore.pull_request),
          commit_sha: instanceBefore.target_sha,
        },
        linear_issue: linearIssue,
        calyx_build_sha: instanceBefore.calyx_build_sha,
        reviewer_definition_digest: instanceBefore.reviewer_definition_digest,
        evidence: {
          evidence_id: evaluation.evidence_id,
          receipt_hash: evidenceAuthority.receipt_hash,
          artifact_digest: evaluation.artifact_digest,
          intrinsic_status: evaluation.intrinsic_status,
          verdict: evaluation.verdict,
          coverage_status: evaluation.coverage_status,
          counts: evaluation.counts,
        },
      }, input.publisher_identities);
    } catch (error) {
      throw new ReviewCoordinatorError(
        "invalid_evidence",
        error instanceof Error ? error.message : "Publication rendering failed closed.",
      );
    }
  }
  const publicationEffects = publication === null
    ? []
    : publication.required_adapters.map((adapter) => {
        const effectId = stableId(
          "review-effect",
          [input.instance_id, "provider_publication", adapter],
        );
        const request = {
          schema_version: "calyx.review-effect/provider-publication/v1",
          review_instance_id: input.instance_id,
          adapter,
          envelope: publication.envelopes[adapter],
          evidence_id: evaluation.evidence_id,
          evidence_receipt_hash: evidenceAuthority.receipt_hash,
          evidence_digest: evaluation.artifact_digest,
          intrinsic_status: evaluation.intrinsic_status,
          verdict: evaluation.verdict,
          target: {
            repository: instanceBefore.repository,
            pull_request: asNumber(instanceBefore.pull_request),
            commit_sha: instanceBefore.target_sha,
          },
        };
        const requestJson = canonicalizeIndependentReviewJson(request);
        return {
          adapter,
          effect_id: effectId,
          request_json: requestJson,
          request_hash: createHash("sha256").update(requestJson, "utf8").digest("hex"),
        };
      });

  const recorded = withImmediateTransaction(db, () => {
    const instance = requireInstance(db, input.instance_id);
    const attempt = requireAttempt(db, input.instance_id);
    const existing = db
      .prepare(
        `SELECT evidence_id, instance_id, attempt_id, schema_version,
                receipt_json, receipt_hash, artifact_json, artifact_digest, intrinsic_status, verdict,
                coverage_status, finding_count, invalid_reasons_json, created_at
         FROM review_evidence WHERE instance_id = ? AND attempt_id = ?`,
      )
      .get(input.instance_id, attempt.attempt_id) as RawReviewEvidence | undefined;
    if (existing) {
      if (
        existing.evidence_id !== evaluation.evidence_id
        || existing.receipt_hash !== evidenceAuthority.receipt_hash
        || existing.receipt_json !== evidenceAuthority.receipt_json
        || existing.artifact_digest !== evaluation.artifact_digest
        || existing.artifact_json !== artifactJson
      ) {
        throw new ReviewCoordinatorError(
          "invalid_evidence",
          `Review attempt ${attempt.attempt_id} already accepted different evidence bytes.`,
        );
      }
      for (const expected of publicationEffects) {
        const existingEffect = requireEffect(db, expected.effect_id);
        if (
          existingEffect.effect_key !== expected.adapter
          || existingEffect.request_hash !== expected.request_hash
          || existingEffect.request_json !== expected.request_json
        ) {
          throw new ReviewCoordinatorError(
            "effect_conflict",
            `Publication effect ${expected.effect_id} already names different request bytes.`,
          );
        }
      }
      return false;
    }
    assertMutationTime(recordedAt, [
      { field: "review instance updated_at", value: instance.updated_at },
      { field: "review attempt updated_at", value: attempt.updated_at },
    ]);
    if (instance.state !== "awaiting_evidence" || attempt.status !== "succeeded") {
      throw new ReviewCoordinatorError(
        "invalid_transition",
        `Review evidence requires a succeeded reviewer attempt awaiting evidence (state=${instance.state}, attempt=${attempt.status}).`,
      );
    }

    db.prepare(
      `INSERT INTO review_evidence
        (evidence_id, instance_id, attempt_id, schema_version, receipt_json,
         receipt_hash, artifact_json, artifact_digest, intrinsic_status, verdict,
         coverage_status, finding_count, invalid_reasons_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      evaluation.evidence_id,
      input.instance_id,
      attempt.attempt_id,
      observedArtifactSchema,
      evidenceAuthority.receipt_json,
      evidenceAuthority.receipt_hash,
      artifactJson,
      evaluation.artifact_digest,
      evaluation.intrinsic_status,
      evaluation.verdict,
      evaluation.coverage_status,
      evaluation.finding_count,
      canonicalizeIndependentReviewJson(evaluation.invalid_reasons),
      recordedAt,
    );

    for (const effect of publicationEffects) {
      db.prepare(
        `INSERT INTO review_effects
          (effect_id, instance_id, attempt_id, kind, effect_key, request_json,
           request_hash, status, claimed_fence, adoption_json, adoption_hash,
           created_at, updated_at)
         VALUES (?, ?, ?, 'provider_publication', ?, ?, ?, 'pending', NULL, NULL,
                 NULL, ?, ?)`,
      ).run(
        effect.effect_id,
        input.instance_id,
        attempt.attempt_id,
        effect.adapter,
        effect.request_json,
        effect.request_hash,
        recordedAt,
        recordedAt,
      );
      const obligationId = stableId(
        "review-obligation",
        [input.instance_id, "provider_publication", effect.adapter],
      );
      db.prepare(
        `INSERT INTO review_obligations
          (obligation_id, instance_id, effect_id, kind, obligation_key, status,
           detail_json, created_at, updated_at)
         VALUES (?, ?, ?, 'provider_publication', ?, 'pending', ?, ?, ?)`,
      ).run(
        obligationId,
        input.instance_id,
        effect.effect_id,
        effect.adapter,
        canonicalizeIndependentReviewJson({
          adapter: effect.adapter,
          request_hash: effect.request_hash,
        }),
        recordedAt,
        recordedAt,
      );
    }
    const valid = evaluation.intrinsic_status !== "invalid";
    updateInstanceInTransaction(db, instance, {
      state: valid ? "awaiting_publication" : "terminal",
      intrinsic_status: evaluation.intrinsic_status,
      publication_status: valid ? "pending" : "not_started",
      disposition: valid ? "awaiting_publication" : "failed",
      updated_at: recordedAt,
      terminal_at: valid ? null : recordedAt,
    });
    appendReviewEventInTransaction(db, {
      instance_id: input.instance_id,
      event_type: "review_evidence_recorded",
      identity_parts: [evaluation.evidence_id],
      occurred_at: recordedAt,
      payload: {
        evidence_id: evaluation.evidence_id,
        artifact_digest: evaluation.artifact_digest,
        evidence_receipt_hash: evidenceAuthority.receipt_hash,
        intrinsic_status: evaluation.intrinsic_status,
        verdict: evaluation.verdict,
        finding_count: evaluation.finding_count,
        invalid_reasons: evaluation.invalid_reasons,
        ...(publicationEffects.length > 0
          ? {
              publication_effects: publicationEffects.map((effect) => ({
                adapter: effect.adapter,
                effect_id: effect.effect_id,
                request_hash: effect.request_hash,
              })),
            }
          : {}),
      },
    });
    return true;
  });

  return {
    recorded,
    evaluation,
    publication_effect_ids: publicationEffects.map((effect) => effect.effect_id),
    projection: requireIndependentReviewAdminProjection(db, input.instance_id, recordedAt),
  };
}

function normalizeProviderFailure(
  observation: ProviderPublicationObservation,
): { reason_code: string } {
  const root = asRecord(observation);
  const failure = asRecord(root?.["failure"]);
  if (
    !root
    || Object.keys(root).sort().join("\0")
      !== "adapter\0failure\0observation_id\0schema_version\0status"
    || !failure
    || Object.keys(failure).join("\0") !== "reason_code"
    || typeof failure["reason_code"] !== "string"
  ) {
    throw new ReviewCoordinatorError(
      "effect_conflict",
      "Provider unresolved observation must be a closed reason-only contract.",
    );
  }
  return { reason_code: requiredText(failure["reason_code"], "failure.reason_code") };
}

/**
 * Record only unresolved provider state. Delivery remains unreachable until a
 * real daemon adapter owns live provider readback and its authority proof.
 */
export function recordReviewPublicationObservation(
  db: StateDriverDatabase,
  input: {
    instance_id: string;
    effect_id: string;
    effect_request_hash: string;
    claimed_fence: number;
    observation: ProviderPublicationObservation;
    observed_at: string;
  },
): { recorded: boolean; projection: IndependentReviewAdminProjection } {
  const effectRequestHash = assertDigest(input.effect_request_hash, "effect_request_hash");
  assertPositiveInteger(input.claimed_fence, "claimed_fence");
  const observedAt = canonicalTimestamp(input.observed_at, "publication observed_at");
  if (input.observation.schema_version !== REVIEW_PROVIDER_OBSERVATION_SCHEMA_VERSION) {
    throw new ReviewCoordinatorError(
      "effect_conflict",
      `Provider observation must use ${REVIEW_PROVIDER_OBSERVATION_SCHEMA_VERSION}.`,
    );
  }
  const failure = normalizeProviderFailure(input.observation);
  const observation = {
    schema_version: REVIEW_PROVIDER_OBSERVATION_SCHEMA_VERSION,
    observation_id: requiredText(input.observation.observation_id, "observation_id"),
    adapter: requiredText(input.observation.adapter, "provider.adapter"),
    status: input.observation.status,
    failure,
    observed_at: observedAt,
  };
  if (
    Buffer.byteLength(observation.observation_id, "utf8") > MAX_REVIEW_ID_BYTES
    || Buffer.byteLength(observation.adapter, "utf8") > MAX_ADAPTER_ID_BYTES
    || (observation.status !== "degraded" && observation.status !== "indeterminate")
  ) {
    throw new ReviewCoordinatorError("effect_conflict", "Provider observation is invalid or unbounded.");
  }
  const observationJson = canonicalizeIndependentReviewJson(observation);
  const observationHash = createHash("sha256").update(observationJson, "utf8").digest("hex");
  const receiptDigest = hashIndependentReviewValue({
    adapter: observation.adapter,
    status: observation.status,
    failure: observation.failure,
  });

  const recorded = withImmediateTransaction(db, () => {
    const instance = requireInstance(db, input.instance_id);
    const effect = requireEffect(db, input.effect_id);
    if (
      effect.instance_id !== input.instance_id
      || effect.kind !== "provider_publication"
      || effect.effect_key !== observation.adapter
      || effect.request_hash !== effectRequestHash
      || effect.claimed_fence === null
      || asNumber(effect.claimed_fence) !== input.claimed_fence
    ) {
      throw new ReviewCoordinatorError(
        "effect_conflict",
        `Publication effect ${input.effect_id} does not match its persisted identity.`,
      );
    }
    const request = asRecord(parseJson<unknown>(effect.request_json, "publication effect request"));
    if (
      !request
      || request["schema_version"] !== "calyx.review-effect/provider-publication/v1"
      || request["adapter"] !== observation.adapter
    ) {
      throw new ReviewCoordinatorError(
        "effect_conflict",
        "Publication observation does not match its provider-specific immutable request.",
      );
    }
    const existingObservation = db.prepare(
      `SELECT observation_id, instance_id, effect_id, effect_key, observation_seq, schema_version,
              status, receipt_digest, payload_json, payload_hash, observed_at
       FROM review_effect_observations WHERE effect_id = ? AND observation_id = ?`,
    ).get(effect.effect_id, observation.observation_id) as RawReviewEffectObservation | undefined;
    if (existingObservation) {
      if (
        existingObservation.instance_id !== input.instance_id
        || existingObservation.effect_id !== input.effect_id
        || existingObservation.effect_key !== observation.adapter
        || existingObservation.payload_json !== observationJson
        || existingObservation.payload_hash !== observationHash
      ) {
        throw new ReviewCoordinatorError(
          "effect_conflict",
          `Provider observation ${observation.observation_id} already names different bytes.`,
        );
      }
      return false;
    }
    assertMutationTime(observedAt, [
      { field: "review instance updated_at", value: instance.updated_at },
      { field: "review publication effect updated_at", value: effect.updated_at },
    ]);
    const observationCount = asNumber((db.prepare(
      "SELECT COUNT(*) AS count FROM review_effect_observations WHERE effect_id = ?",
    ).get(effect.effect_id) as { count: number | bigint }).count);
    if (observationCount === 0 && effect.status !== "claimed") {
      throw new ReviewCoordinatorError(
        "effect_conflict",
        `Publication effect ${input.effect_id} must be fenced before first adoption (status=${effect.status}).`,
      );
    }
    if (observationCount >= MAX_PROVIDER_OBSERVATIONS_PER_ADAPTER) {
      throw new ReviewCoordinatorError(
        "effect_conflict",
        `Publication observation ledger is bounded to ${String(MAX_PROVIDER_OBSERVATIONS_PER_ADAPTER)} rows per adapter.`,
      );
    }
    const observationSequence = observationCount + 1;
    if (instance.state !== "awaiting_publication") {
      throw new ReviewCoordinatorError(
        "invalid_transition",
        `Provider observation requires awaiting_publication (got ${instance.state}).`,
      );
    }
    db.prepare(
      `INSERT INTO review_effect_observations
        (observation_id, instance_id, effect_id, effect_key, observation_seq, schema_version,
         status, receipt_digest, payload_json, payload_hash, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      observation.observation_id,
      input.instance_id,
      effect.effect_id,
      effect.effect_key,
      observationSequence,
      REVIEW_PROVIDER_OBSERVATION_SCHEMA_VERSION,
      observation.status,
      receiptDigest,
      observationJson,
      observationHash,
      observedAt,
    );
    const effectObservations = providerObservationsForEffect(db, effect.effect_id);
    const indeterminateObserved = effectObservations.some((row) => row.status === "indeterminate");
    const effectStatus: ReviewEffectStatus = indeterminateObserved ? "indeterminate" : "failed";
    db.prepare(
      `UPDATE review_effects
       SET status = ?, updated_at = ?
       WHERE effect_id = ? AND claimed_fence = ?`,
    ).run(effectStatus, observedAt, input.effect_id, input.claimed_fence);
    db.prepare(
      `UPDATE review_obligations
       SET status = ?, updated_at = ?, detail_json = ?
       WHERE effect_id = ? AND kind = 'provider_publication'`,
    ).run(
      "pending",
      observedAt,
      canonicalizeIndependentReviewJson({
        adapter: effect.effect_key,
        effect_status: effectStatus,
        observation_count: effectObservations.length,
        indeterminate_observed: indeterminateObserved,
        latest_observation_id: observation.observation_id,
      }),
      effect.effect_id,
    );
    const effectStatuses = (db.prepare(
      `SELECT status FROM review_effects
        WHERE instance_id = ? AND kind = 'provider_publication'
        ORDER BY effect_key`,
    ).all(input.instance_id) as Array<{ status: string }>).map((row) => row.status);
    const publicationStatus: ReviewPublicationStatus = effectStatuses.some(
      (status) => status === "indeterminate",
    )
      ? "indeterminate"
      : effectStatuses.some((status) => status === "failed")
        ? "degraded"
        : "pending";
    const disposition: ReviewDisposition = "awaiting_publication";
    updateInstanceInTransaction(db, instance, {
      state: "awaiting_publication",
      publication_status: publicationStatus,
      disposition,
      updated_at: observedAt,
      terminal_at: null,
    });
    appendReviewEventInTransaction(db, {
      instance_id: input.instance_id,
      event_type: "review_provider_observed",
      identity_parts: [effect.effect_id, observation.observation_id],
      occurred_at: observedAt,
      payload: {
        effect_id: input.effect_id,
        effect_request_hash: effectRequestHash,
        claimed_fence: input.claimed_fence,
        adapter: observation.adapter,
        observation_id: observation.observation_id,
        observation_seq: observationSequence,
        observation_hash: observationHash,
        observation_status: observation.status,
        publication_status: publicationStatus,
        disposition,
      },
    });
    return true;
  });
  return {
    recorded,
    projection: requireIndependentReviewAdminProjection(db, input.instance_id, observedAt),
  };
}

function readEvidence(db: StateDriverDatabase, instanceId: string): RawReviewEvidence | undefined {
  return db
    .prepare(
      `SELECT evidence_id, instance_id, attempt_id, schema_version,
              receipt_json, receipt_hash, artifact_json, artifact_digest, intrinsic_status, verdict,
              coverage_status, finding_count, invalid_reasons_json, created_at
       FROM review_evidence WHERE instance_id = ? ORDER BY created_at ASC LIMIT 1`,
    )
    .get(instanceId) as RawReviewEvidence | undefined;
}

function effectForKind(
  db: StateDriverDatabase,
  instanceId: string,
  kind: ReviewEffectKind,
): RawReviewEffect | undefined {
  return db
    .prepare(`${SELECT_EFFECT} WHERE instance_id = ? AND kind = ?`)
    .get(instanceId, kind) as RawReviewEffect | undefined;
}

function providerObservationsForEffect(
  db: StateDriverDatabase,
  effectId: string,
): RawReviewEffectObservation[] {
  const rows = db.prepare(
    `SELECT observation_id, instance_id, effect_id, effect_key, observation_seq, schema_version,
            status, receipt_digest, payload_json, payload_hash, observed_at
       FROM review_effect_observations
      WHERE effect_id = ?
      ORDER BY observation_seq ASC
      LIMIT ?`,
  ).all(effectId, MAX_PROVIDER_OBSERVATIONS_PER_ADAPTER + 1) as RawReviewEffectObservation[];
  if (rows.length > MAX_PROVIDER_OBSERVATIONS_PER_ADAPTER) {
    throw new ReviewCoordinatorError(
      "effect_conflict",
      `Publication effect ${effectId} exceeds its bounded observation ledger.`,
    );
  }
  for (const [index, row] of rows.entries()) {
    const observedHash = createHash("sha256").update(row.payload_json, "utf8").digest("hex");
    const payload = asRecord(parseJson<unknown>(row.payload_json, "provider observation"));
    const failure = asRecord(payload?.["failure"]);
    if (
      row.schema_version !== REVIEW_PROVIDER_OBSERVATION_SCHEMA_VERSION
      || asNumber(row.observation_seq) !== index + 1
      || observedHash !== row.payload_hash
      || !payload
      || payload["schema_version"] !== REVIEW_PROVIDER_OBSERVATION_SCHEMA_VERSION
      || payload["observation_id"] !== row.observation_id
      || payload["adapter"] !== row.effect_key
      || payload["status"] !== row.status
      || payload["observed_at"] !== row.observed_at
      || !failure
      || Object.keys(failure).join("\0") !== "reason_code"
      || typeof failure["reason_code"] !== "string"
      || Object.keys(payload).sort().join("\0")
        !== "adapter\0failure\0observation_id\0observed_at\0schema_version\0status"
      || hashIndependentReviewValue({
        adapter: payload["adapter"],
        status: payload["status"],
        failure,
      }) !== row.receipt_digest
    ) {
      throw new ReviewCoordinatorError(
        "effect_conflict",
        `Publication effect ${effectId} has malformed observation ${row.observation_id}.`,
      );
    }
  }
  return rows;
}

function launchReconciliationObservationsForEffect(
  db: StateDriverDatabase,
  effectId: string,
): RawReviewEffectObservation[] {
  const rows = db.prepare(
    `SELECT observation_id, instance_id, effect_id, effect_key, observation_seq, schema_version,
            status, receipt_digest, payload_json, payload_hash, observed_at
       FROM review_effect_observations
      WHERE effect_id = ?
      ORDER BY observation_seq ASC
      LIMIT ?`,
  ).all(
    effectId,
    MAX_LAUNCH_RECONCILIATION_OBSERVATIONS + 1,
  ) as RawReviewEffectObservation[];
  if (rows.length > MAX_LAUNCH_RECONCILIATION_OBSERVATIONS) {
    throw new ReviewCoordinatorError(
      "effect_conflict",
      `Launch effect ${effectId} exceeds its bounded reconciliation ledger.`,
    );
  }
  for (const [index, row] of rows.entries()) {
    const observedHash = createHash("sha256").update(row.payload_json, "utf8").digest("hex");
    const payload = asRecord(parseJson<unknown>(row.payload_json, "launch reconciliation observation"));
    const status = payload?.["status"];
    const expectedKeys = status === "adopted"
      ? "issuer\0observation_id\0observed_at\0observed_intent_hash\0run_id\0schema_version\0status\0supervisor_receipt_digest"
      : status === "failed"
        ? "issuer\0observation_id\0observed_at\0observed_intent_hash\0reason_code\0run_id\0schema_version\0status\0supervisor_receipt_digest"
        : status === "indeterminate"
          ? "issuer\0observation_id\0observed_at\0observed_intent_hash\0reason_code\0run_id\0schema_version\0status"
          : "";
    const expectedReceiptDigest = payload
      ? hashIndependentReviewValue({
          issuer: payload["issuer"],
          status,
          run_id: payload["run_id"],
          observed_intent_hash: payload["observed_intent_hash"],
          ...(typeof payload["supervisor_receipt_digest"] === "string"
            ? { supervisor_receipt_digest: payload["supervisor_receipt_digest"] }
            : {}),
          ...(typeof payload["reason_code"] === "string"
            ? { reason_code: payload["reason_code"] }
            : {}),
        })
      : "";
    if (
      row.schema_version !== REVIEW_LAUNCH_RECONCILIATION_OBSERVATION_SCHEMA_VERSION
      || row.effect_key !== "reviewer"
      || asNumber(row.observation_seq) !== index + 1
      || observedHash !== row.payload_hash
      || !payload
      || Object.keys(payload).sort().join("\0") !== expectedKeys
      || payload["schema_version"] !== REVIEW_LAUNCH_RECONCILIATION_OBSERVATION_SCHEMA_VERSION
      || payload["observation_id"] !== row.observation_id
      || payload["issuer"] !== "run_service"
      || payload["status"] !== row.status
      || payload["observed_at"] !== row.observed_at
      || typeof payload["run_id"] !== "string"
      || payload["run_id"].trim() !== payload["run_id"]
      || Buffer.byteLength(payload["run_id"], "utf8") > MAX_REVIEW_ID_BYTES
      || typeof payload["observed_intent_hash"] !== "string"
      || !DIGEST_PATTERN.test(payload["observed_intent_hash"])
      || ((status === "adopted" || status === "failed")
        && (
          typeof payload["supervisor_receipt_digest"] !== "string"
          || !DIGEST_PATTERN.test(payload["supervisor_receipt_digest"])
        ))
      || ((status === "failed" || status === "indeterminate")
        && (
          typeof payload["reason_code"] !== "string"
          || !payload["reason_code"].trim()
          || payload["reason_code"].trim() !== payload["reason_code"]
          || Buffer.byteLength(payload["reason_code"], "utf8") > MAX_REVIEW_ID_BYTES
        ))
      || expectedReceiptDigest !== row.receipt_digest
    ) {
      throw new ReviewCoordinatorError(
        "effect_conflict",
        `Launch effect ${effectId} has malformed reconciliation observation ${row.observation_id}.`,
      );
    }
  }
  return rows;
}

export interface ReadIndependentReviewAdminProjectionOptions {
  /** Explicit observation time; projection truth never depends on an ambient clock. */
  now: string;
}

function readIndependentReviewAdminProjectionInSnapshot(
  db: StateDriverDatabase,
  instanceId: string,
  now: string,
): IndependentReviewAdminProjection | undefined {
  const instance = readInstance(db, instanceId);
  if (!instance) return undefined;
  const attempt = readAttempt(db, instanceId);
  const launch = effectForKind(db, instanceId, "reviewer_launch");
  if (!attempt || !launch) {
    throw new ReviewCoordinatorError(
      "schema_absent",
      `Review ${instanceId} is missing its first attempt or launch effect.`,
    );
  }
  const evidence = readEvidence(db, instanceId);
  const launchReconciliationObservations = launchReconciliationObservationsForEffect(
    db,
    launch.effect_id,
  );
  for (const observation of launchReconciliationObservations) {
    const payload = asRecord(parseJson<unknown>(
      observation.payload_json,
      "launch reconciliation observation",
    ));
    if (
      payload?.["run_id"] !== attempt.reviewer_run_id
      || payload["observed_intent_hash"] !== attempt.launch_intent_hash
    ) {
      throw new ReviewCoordinatorError(
        "effect_conflict",
        `Launch effect ${launch.effect_id} reconciliation does not match its persisted attempt.`,
      );
    }
  }
  const publicationEffects = db.prepare(
    `${SELECT_EFFECT}
      WHERE instance_id = ? AND kind = 'provider_publication'
      ORDER BY effect_key ASC LIMIT ?`,
  ).all(instanceId, MAX_PUBLICATION_ADAPTERS + 1) as RawReviewEffect[];
  if (publicationEffects.length > MAX_PUBLICATION_ADAPTERS) {
    throw new ReviewCoordinatorError(
      "schema_absent",
      `Review ${instanceId} exceeds its bounded publication-effect projection.`,
    );
  }
  const obligations = db
    .prepare(
      `SELECT obligation_id, instance_id, effect_id, kind, obligation_key, status, detail_json,
              created_at, updated_at
       FROM review_obligations
       WHERE instance_id = ? AND status != 'resolved'
       ORDER BY kind ASC, obligation_key ASC LIMIT ?`,
    )
    .all(instanceId, MAX_REVIEW_OBLIGATIONS + 1) as RawReviewObligation[];
  if (obligations.length > MAX_REVIEW_OBLIGATIONS) {
    throw new ReviewCoordinatorError(
      "schema_absent",
      `Review ${instanceId} exceeds its bounded obligation projection.`,
    );
  }
  const evidenceReceipt = evidence
    ? parseJson<ReviewRunEvidenceReceipt>(evidence.receipt_json, "RunService evidence receipt")
    : undefined;
  if (
    evidence
    && (
      createHash("sha256").update(evidence.receipt_json, "utf8").digest("hex") !== evidence.receipt_hash
      || evidenceReceipt?.schema_version !== REVIEW_RUN_EVIDENCE_RECEIPT_SCHEMA_VERSION
      || evidenceReceipt.artifact.canonical_sha256 !== evidence.artifact_digest
    )
  ) {
    throw new ReviewCoordinatorError(
      "schema_absent",
      `Review ${instanceId} has malformed persisted RunService evidence authority.`,
    );
  }

  return {
    schema_version: INDEPENDENT_REVIEW_PROJECTION_SCHEMA_VERSION,
    instance_id: instance.instance_id,
    request_digest: instance.request_hash,
    target: {
      repository: instance.repository,
      pull_request: asNumber(instance.pull_request),
      commit_sha: instance.target_sha,
    },
    round: asNumber(instance.round),
    policy_version: instance.policy_version,
    calyx_build_sha: instance.calyx_build_sha,
    reviewer_definition_digest: instance.reviewer_definition_digest,
    state: instance.state as ReviewCoordinatorState,
    state_version: asNumber(instance.state_version),
    axes: {
      intrinsic: instance.intrinsic_status as ReviewIntrinsicStatus,
      publication: instance.publication_status as ReviewPublicationStatus,
      disposition: instance.disposition as ReviewDisposition,
    },
    claim: {
      held: Boolean(
        instance.claim_owner
        && instance.claim_until
        && instance.claim_until > now,
      ),
      until: instance.claim_until,
      fence: asNumber(instance.claim_fence),
    },
    attempt: {
      attempt_id: attempt.attempt_id,
      attempt_number: asNumber(attempt.attempt_number),
      reviewer_run_id: attempt.reviewer_run_id,
      launch_id: attempt.launch_id,
      launch_intent_hash: attempt.launch_intent_hash,
      producer_generation: asNumber(attempt.producer_generation),
      producer_fence: asNumber(attempt.producer_fence),
      status: attempt.status as ReviewAttemptStatus,
      run_state: attempt.run_state,
    },
    launch: {
      effect_id: launch.effect_id,
      request_hash: launch.request_hash,
      status: launch.status as ReviewEffectStatus,
      claimed_fence: launch.claimed_fence === null ? null : asNumber(launch.claimed_fence),
      reconciliation: launchReconciliationObservations.length > 0
        ? (() => {
            const latest = launchReconciliationObservations.at(-1)!;
            return {
              observation_count: launchReconciliationObservations.length,
              indeterminate_observed: launchReconciliationObservations.some(
                (row) => row.status === "indeterminate",
              ),
              latest_observation: {
                observation_seq: asNumber(latest.observation_seq),
                observation_id: latest.observation_id,
                status: latest.status as "adopted" | "failed" | "indeterminate",
                receipt_digest: latest.receipt_digest,
                observed_at: latest.observed_at,
              },
            };
          })()
        : null,
    },
    evidence: evidence
      ? (() => {
          const invalidReasons = [...new Set(
            parseJson<string[]>(evidence.invalid_reasons_json, "evidence invalid reasons"),
          )].sort();
          return {
          evidence_id: evidence.evidence_id,
          schema_version: evidence.schema_version,
          receipt_hash: evidence.receipt_hash,
          artifact_locator: evidenceReceipt!.artifact.locator,
          artifact_digest: evidence.artifact_digest,
          intrinsic_status: evidence.intrinsic_status as Exclude<ReviewIntrinsicStatus, "pending">,
          verdict: evidence.verdict,
          coverage_status: evidence.coverage_status,
          finding_count: asNumber(evidence.finding_count),
          invalid_reason_count: invalidReasons.length,
          invalid_reasons: invalidReasons.slice(0, MAX_PROJECTED_INVALID_REASONS),
          };
        })()
      : null,
    publication: publicationEffects.length > 0
      ? {
          effects: publicationEffects.map((effect) => {
            const observations = providerObservationsForEffect(db, effect.effect_id);
            const latest = observations.at(-1);
            return {
              effect_id: effect.effect_id,
              adapter: effect.effect_key,
              request_hash: effect.request_hash,
              status: effect.status as ReviewEffectStatus,
              claimed_fence: effect.claimed_fence === null
                ? null
                : asNumber(effect.claimed_fence),
              observation_count: observations.length,
              indeterminate_observed: observations.some((row) => row.status === "indeterminate"),
              latest_observation: latest
                  ? {
                    observation_seq: asNumber(latest.observation_seq),
                    observation_id: latest.observation_id,
                    status: latest.status as ReviewProviderOutcomeStatus,
                    receipt_digest: latest.receipt_digest,
                    observed_at: latest.observed_at,
                  }
                : null,
            };
          }),
        }
      : null,
    open_obligations: obligations.map((obligation) => ({
      obligation_id: obligation.obligation_id,
      kind: obligation.kind,
      obligation_key: obligation.obligation_key,
      status: obligation.status,
    })),
    event_cursor: asNumber(instance.next_event_seq) - 1,
    observed_at: now,
    created_at: instance.created_at,
    updated_at: instance.updated_at,
    terminal_at: instance.terminal_at,
  };
}

/** Positive, bounded, admin-only projection from one SQLite read snapshot. */
export function readIndependentReviewAdminProjection(
  db: StateDriverDatabase,
  instanceId: string,
  options: ReadIndependentReviewAdminProjectionOptions,
): IndependentReviewAdminProjection | undefined {
  const now = canonicalTimestamp(options.now, "projection now");
  return withReadSnapshot(db, () => (
    readIndependentReviewAdminProjectionInSnapshot(db, instanceId, now)
  ));
}

function requireIndependentReviewAdminProjection(
  db: StateDriverDatabase,
  instanceId: string,
  now: string,
): IndependentReviewAdminProjection {
  const projection = readIndependentReviewAdminProjection(db, instanceId, { now });
  if (!projection) {
    throw new ReviewCoordinatorError("not_found", `Independent review ${instanceId} was not found.`);
  }
  return projection;
}

export interface ListIndependentReviewEventsOptions {
  after_seq?: number;
  limit?: number;
}

export function listIndependentReviewEvents(
  db: StateDriverDatabase,
  instanceId: string,
  options: ListIndependentReviewEventsOptions = {},
): IndependentReviewEvent[] {
  const after = options.after_seq ?? 0;
  const limit = Math.min(500, Math.max(0, Math.floor(options.limit ?? 100)));
  const rows = db
    .prepare(
      `SELECT event_id, instance_id, event_seq, event_type, payload_json,
              payload_hash, occurred_at
       FROM review_events
       WHERE instance_id = ? AND event_seq > ?
       ORDER BY event_seq ASC LIMIT ?`,
    )
    .all(instanceId, after, limit) as RawReviewEvent[];
  return rows.map((row) => ({
    event_id: row.event_id,
    instance_id: row.instance_id,
    event_seq: asNumber(row.event_seq),
    event_type: row.event_type,
    payload: parseJson<unknown>(row.payload_json, "event payload"),
    payload_hash: row.payload_hash,
    occurred_at: row.occurred_at,
  }));
}

export interface ReviewCoordinatorSchemaFinding {
  table: string;
  code: "missing-table" | "missing-column" | "missing-index" | "missing-foreign-key"
    | "invalid-index" | "missing-key" | "missing-check";
  detail: string;
}

interface ExpectedReviewIndex {
  name: string;
  columns: readonly string[];
}

interface ExpectedReviewForeignKey {
  columns: readonly string[];
  referencedTable: string;
  referencedColumns: readonly string[];
  onDelete: "CASCADE";
}

const EXPECTED_REVIEW_SCHEMA: ReadonlyArray<{
  table: string;
  columns: readonly string[];
  primaryKey: readonly string[];
  uniqueKeys: readonly (readonly string[])[];
  indexes: readonly ExpectedReviewIndex[];
  foreignKeys: readonly ExpectedReviewForeignKey[];
  sqlChecks?: readonly string[];
}> = [
  {
    table: "review_instances",
    columns: [
      "instance_id", "schema_version", "admission_key", "subject", "asserted_actor",
      "policy_version", "request_json", "request_hash", "repository", "pull_request",
      "target_sha", "round", "calyx_build_sha", "reviewer_definition_digest", "state",
      "state_version", "claim_owner", "claim_until", "claim_fence", "intrinsic_status",
      "publication_status", "disposition", "next_event_seq", "created_at", "updated_at",
      "terminal_at",
    ],
    primaryKey: ["instance_id"],
    uniqueKeys: [["subject", "admission_key"]],
    indexes: [
      { name: "idx_review_instances_target", columns: ["repository", "pull_request", "target_sha"] },
      { name: "idx_review_instances_disposition", columns: ["disposition", "updated_at"] },
      { name: "idx_review_instances_claim", columns: ["claim_until"] },
    ],
    foreignKeys: [],
  },
  {
    table: "review_attempts",
    columns: [
      "attempt_id", "instance_id", "attempt_number", "reviewer_run_id", "launch_id",
      "launch_request_json", "launch_intent_hash", "producer_generation",
      "producer_fence", "status", "run_state", "created_at", "updated_at",
    ],
    primaryKey: ["attempt_id"],
    uniqueKeys: [
      ["instance_id", "attempt_number"],
      ["instance_id", "attempt_id"],
      ["launch_id"],
      ["reviewer_run_id"],
    ],
    indexes: [
      { name: "idx_review_attempts_instance", columns: ["instance_id", "attempt_number"] },
      { name: "idx_review_attempts_run", columns: ["reviewer_run_id"] },
    ],
    foreignKeys: [{
      columns: ["instance_id"],
      referencedTable: "review_instances",
      referencedColumns: ["instance_id"],
      onDelete: "CASCADE",
    }],
  },
  {
    table: "review_effects",
    columns: [
      "effect_id", "instance_id", "attempt_id", "kind", "effect_key", "request_json", "request_hash",
      "status", "claimed_fence", "adoption_json", "adoption_hash", "created_at", "updated_at",
    ],
    primaryKey: ["effect_id"],
    uniqueKeys: [["instance_id", "kind", "effect_key"], ["instance_id", "effect_id"]],
    indexes: [{
      name: "idx_review_effects_ready",
      columns: ["instance_id", "status", "kind", "effect_key"],
    }],
    foreignKeys: [
      {
        columns: ["instance_id"],
        referencedTable: "review_instances",
        referencedColumns: ["instance_id"],
        onDelete: "CASCADE",
      },
      {
        columns: ["instance_id", "attempt_id"],
        referencedTable: "review_attempts",
        referencedColumns: ["instance_id", "attempt_id"],
        onDelete: "CASCADE",
      },
    ],
  },
  {
    table: "review_effect_observations",
    columns: [
      "observation_id", "instance_id", "effect_id", "effect_key", "observation_seq", "schema_version",
      "status", "receipt_digest", "payload_json", "payload_hash", "observed_at",
    ],
    primaryKey: ["effect_id", "observation_id"],
    uniqueKeys: [["effect_id", "observation_seq"]],
    indexes: [{
      name: "idx_review_effect_observations_effect",
      columns: ["effect_id", "observation_seq"],
    }],
    sqlChecks: [
      "(schema_version = 'calyx.review-provider-observation/v1' and status in ('delivered', 'degraded', 'indeterminate')) or (schema_version = 'calyx.review-launch-reconciliation-observation/v1' and status in ('adopted', 'failed', 'indeterminate'))",
    ],
    foreignKeys: [
      {
        columns: ["instance_id"],
        referencedTable: "review_instances",
        referencedColumns: ["instance_id"],
        onDelete: "CASCADE",
      },
      {
        columns: ["instance_id", "effect_id"],
        referencedTable: "review_effects",
        referencedColumns: ["instance_id", "effect_id"],
        onDelete: "CASCADE",
      },
    ],
  },
  {
    table: "review_evidence",
    columns: [
      "evidence_id", "instance_id", "attempt_id", "schema_version", "receipt_json",
      "receipt_hash", "artifact_json",
      "artifact_digest", "intrinsic_status", "verdict", "coverage_status", "finding_count",
      "invalid_reasons_json", "created_at",
    ],
    primaryKey: ["evidence_id"],
    uniqueKeys: [["instance_id", "attempt_id"]],
    indexes: [{ name: "idx_review_evidence_instance", columns: ["instance_id", "created_at"] }],
    foreignKeys: [
      {
        columns: ["instance_id"],
        referencedTable: "review_instances",
        referencedColumns: ["instance_id"],
        onDelete: "CASCADE",
      },
      {
        columns: ["instance_id", "attempt_id"],
        referencedTable: "review_attempts",
        referencedColumns: ["instance_id", "attempt_id"],
        onDelete: "CASCADE",
      },
    ],
  },
  {
    table: "review_obligations",
    columns: [
      "obligation_id", "instance_id", "effect_id", "kind", "obligation_key", "status", "detail_json",
      "created_at", "updated_at",
    ],
    primaryKey: ["obligation_id"],
    uniqueKeys: [["instance_id", "kind", "obligation_key"]],
    indexes: [{ name: "idx_review_obligations_open", columns: ["status", "updated_at"] }],
    foreignKeys: [
      {
        columns: ["instance_id"],
        referencedTable: "review_instances",
        referencedColumns: ["instance_id"],
        onDelete: "CASCADE",
      },
      {
        columns: ["instance_id", "effect_id"],
        referencedTable: "review_effects",
        referencedColumns: ["instance_id", "effect_id"],
        onDelete: "CASCADE",
      },
    ],
  },
  {
    table: "review_events",
    columns: [
      "event_id", "instance_id", "event_seq", "event_type", "payload_json", "payload_hash",
      "occurred_at",
    ],
    primaryKey: ["event_id"],
    uniqueKeys: [["instance_id", "event_seq"]],
    indexes: [{ name: "idx_review_events_instance", columns: ["instance_id", "event_seq"] }],
    foreignKeys: [{
      columns: ["instance_id"],
      referencedTable: "review_instances",
      referencedColumns: ["instance_id"],
      onDelete: "CASCADE",
    }],
  },
];

interface RawReviewForeignKey {
  id: number | bigint;
  seq: number | bigint;
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

interface RawReviewIndexList {
  name: string;
  unique: number | bigint;
  origin: string;
  partial: number | bigint;
}

interface RawReviewIndexInfo {
  seqno: number | bigint;
  name: string | null;
}

function actualReviewIndexColumns(
  db: StateDriverDatabase,
  indexName: string,
): string[] {
  return (db.prepare(
    "SELECT seqno, name FROM pragma_index_info(?) ORDER BY seqno",
  ).all(indexName) as RawReviewIndexInfo[]).map((row) => row.name ?? "<expression>");
}

function reviewKeySignature(columns: readonly string[]): string {
  return columns.join(",");
}

function actualReviewPrimaryKey(
  db: StateDriverDatabase,
  table: string,
): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    pk: number | bigint;
  }>)
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name);
}

function actualReviewUniqueKeySignatures(
  db: StateDriverDatabase,
  indexes: readonly RawReviewIndexList[],
): Set<string> {
  return new Set(indexes
    .filter((index) => index.origin === "u" && Number(index.unique) === 1)
    .map((index) => reviewKeySignature(actualReviewIndexColumns(db, index.name))));
}

function reviewForeignKeySignature(foreignKey: ExpectedReviewForeignKey): string {
  return `${foreignKey.columns.join(",")} -> ${foreignKey.referencedTable}(`
    + `${foreignKey.referencedColumns.join(",")}) ON DELETE ${foreignKey.onDelete}`;
}

function actualReviewForeignKeySignatures(
  db: StateDriverDatabase,
  table: string,
): Set<string> {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as RawReviewForeignKey[];
  const grouped = new Map<number, RawReviewForeignKey[]>();
  for (const row of rows) {
    const id = Number(row.id);
    const group = grouped.get(id) ?? [];
    group.push(row);
    grouped.set(id, group);
  }
  return new Set([...grouped.values()].map((group) => {
    const ordered = [...group].sort((left, right) => Number(left.seq) - Number(right.seq));
    return reviewForeignKeySignature({
      columns: ordered.map((row) => row.from),
      referencedTable: ordered[0]!.table,
      referencedColumns: ordered.map((row) => row.to),
      onDelete: ordered[0]!.on_delete.toUpperCase() as "CASCADE",
    });
  }));
}

export function checkIndependentReviewCoordinatorSchema(
  db: StateDriverDatabase,
): { status: "ok" | "error"; findings: ReviewCoordinatorSchemaFinding[] } {
  const findings: ReviewCoordinatorSchemaFinding[] = [];
  for (const expected of EXPECTED_REVIEW_SCHEMA) {
    const table = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(expected.table) as { name: string; sql: string } | undefined;
    if (!table) {
      findings.push({
        table: expected.table,
        code: "missing-table",
        detail: `missing table ${expected.table}`,
      });
      continue;
    }
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${expected.table})`).all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    for (const column of expected.columns) {
      if (!columns.has(column)) {
        findings.push({
          table: expected.table,
          code: "missing-column",
          detail: `missing column ${expected.table}.${column}`,
        });
      }
    }
    const indexes = (
      db.prepare(`PRAGMA index_list(${expected.table})`).all() as RawReviewIndexList[]
    );
    const indexesByName = new Map(indexes.map((index) => [index.name, index]));
    for (const expectedIndex of expected.indexes) {
      const actualIndex = indexesByName.get(expectedIndex.name);
      if (!actualIndex) {
        findings.push({
          table: expected.table,
          code: "missing-index",
          detail: `missing index ${expectedIndex.name}`,
        });
        continue;
      }
      const actualColumns = actualReviewIndexColumns(db, actualIndex.name);
      if (
        reviewKeySignature(actualColumns) !== reviewKeySignature(expectedIndex.columns)
        || Number(actualIndex.unique) !== 0
        || Number(actualIndex.partial) !== 0
      ) {
        findings.push({
          table: expected.table,
          code: "invalid-index",
          detail: `invalid index ${expectedIndex.name}: expected (`
            + `${reviewKeySignature(expectedIndex.columns)}) non-unique full; actual (`
            + `${reviewKeySignature(actualColumns)}) unique=${String(Number(actualIndex.unique))} `
            + `partial=${String(Number(actualIndex.partial))}`,
        });
      }
    }
    const primaryKey = actualReviewPrimaryKey(db, expected.table);
    if (reviewKeySignature(primaryKey) !== reviewKeySignature(expected.primaryKey)) {
      findings.push({
        table: expected.table,
        code: "missing-key",
        detail: `missing primary key ${expected.table}(${reviewKeySignature(expected.primaryKey)})`,
      });
    }
    const uniqueKeys = actualReviewUniqueKeySignatures(db, indexes);
    for (const uniqueKey of expected.uniqueKeys) {
      const signature = reviewKeySignature(uniqueKey);
      if (!uniqueKeys.has(signature)) {
        findings.push({
          table: expected.table,
          code: "missing-key",
          detail: `missing unique key ${expected.table}(${signature})`,
        });
      }
    }
    const foreignKeys = actualReviewForeignKeySignatures(db, expected.table);
    for (const expectedForeignKey of expected.foreignKeys) {
      const signature = reviewForeignKeySignature(expectedForeignKey);
      if (!foreignKeys.has(signature)) {
        findings.push({
          table: expected.table,
          code: "missing-foreign-key",
          detail: `missing foreign key ${expected.table}.${signature}`,
        });
      }
    }
    const normalizedTableSql = table.sql.toLowerCase().replace(/\s+/g, " ");
    for (const sqlCheck of expected.sqlChecks ?? []) {
      if (!normalizedTableSql.includes(sqlCheck)) {
        findings.push({
          table: expected.table,
          code: "missing-check",
          detail: `missing conditional check on ${expected.table}`,
        });
      }
    }
  }
  return { status: findings.length === 0 ? "ok" : "error", findings };
}
