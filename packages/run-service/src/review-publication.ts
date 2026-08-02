import { createHash } from "node:crypto";

export const REVIEW_PUBLICATION_REQUEST_SCHEMA_VERSION =
  "calyx.review-publication-request/v1";
export const REVIEW_PUBLICATION_CONTENT_SCHEMA_VERSION =
  "calyx.review-publication-content/v1";

const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_IDENTIFIER_BYTES = 512;
const MAX_PROVIDER_BODY_BYTES = 131_072;

export type ReviewPublicationAdapter = "github_review" | "linear_comment";

export interface ReviewPublicationContext {
  instance_id: string;
  round: number;
  target: {
    repository: string;
    pull_request: number;
    commit_sha: string;
  };
  linear_issue: string;
  calyx_build_sha: string;
  reviewer_definition_digest: string;
  evidence: {
    evidence_id: string;
    receipt_hash: string;
    artifact_digest: string;
    intrinsic_status: "passed" | "not_passed";
    verdict: "mergeable" | "not_mergeable";
    coverage_status: string;
    counts: Record<"P0" | "P1" | "P2" | "P3" | "total", number>;
  };
}

/** Daemon-owned provider identities, resolved outside caller admission/evidence. */
export interface ReviewPublisherIdentities {
  github_author_node_id: string;
  linear_actor_id: string;
}

export interface DerivedReviewPublicationRequest {
  schema_version: typeof REVIEW_PUBLICATION_REQUEST_SCHEMA_VERSION;
  required_adapters: readonly ["github_review", "linear_comment"];
  content_digest: string;
  content_marker: string;
  envelopes: {
    github_review: {
      repository: string;
      pull_request: number;
      commit_id: string;
      event: "COMMENT";
      body: string;
      body_digest: string;
      content_digest: string;
      content_marker: string;
      publisher_author_node_id: string;
    };
    linear_comment: {
      issue: string;
      body: string;
      body_digest: string;
      content_digest: string;
      content_marker: string;
      publisher_actor_id: string;
    };
  };
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number"
    || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalValue(record[key])]),
    );
  }
  throw new TypeError(`Unsupported publication content value: ${typeof value}.`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedText(value: string, field: string): string {
  const normalized = value.trim();
  if (
    !normalized
    || normalized.includes("\0")
    || normalized.includes("\r")
    || normalized.includes("\n")
    || Buffer.byteLength(normalized, "utf8") > MAX_IDENTIFIER_BYTES
  ) {
    throw new TypeError(`${field} must be a bounded non-empty identifier.`);
  }
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function commitSha(value: string, field: string): string {
  const normalized = boundedText(value, field).toLowerCase();
  if (!COMMIT_PATTERN.test(normalized)) throw new TypeError(`${field} must be a full commit SHA.`);
  return normalized;
}

function digest(value: string, field: string): string {
  const normalized = boundedText(value, field).toLowerCase();
  if (!DIGEST_PATTERN.test(normalized)) throw new TypeError(`${field} must be sha256.`);
  return normalized;
}

function normalizeContext(
  context: ReviewPublicationContext,
  publisherIdentities: ReviewPublisherIdentities,
): { context: ReviewPublicationContext; publisherIdentities: ReviewPublisherIdentities } {
  if (
    context.evidence.intrinsic_status !== "passed"
    && context.evidence.intrinsic_status !== "not_passed"
  ) {
    throw new TypeError("evidence.intrinsic_status must be passed or not_passed.");
  }
  const counts = {
    P0: nonNegativeInteger(context.evidence.counts.P0, "evidence.counts.P0"),
    P1: nonNegativeInteger(context.evidence.counts.P1, "evidence.counts.P1"),
    P2: nonNegativeInteger(context.evidence.counts.P2, "evidence.counts.P2"),
    P3: nonNegativeInteger(context.evidence.counts.P3, "evidence.counts.P3"),
    total: nonNegativeInteger(context.evidence.counts.total, "evidence.counts.total"),
  };
  if (counts.total !== counts.P0 + counts.P1 + counts.P2 + counts.P3) {
    throw new TypeError("evidence.counts.total must equal the severity sum.");
  }
  const passed = context.evidence.intrinsic_status === "passed";
  if (
    context.evidence.coverage_status !== "full"
    || passed !== (counts.total === 0 && context.evidence.verdict === "mergeable")
    || (!passed && (counts.total === 0 || context.evidence.verdict !== "not_mergeable"))
  ) {
    throw new TypeError("Publication evidence is internally inconsistent or incomplete.");
  }
  return {
    context: {
      instance_id: boundedText(context.instance_id, "instance_id"),
      round: positiveInteger(context.round, "round"),
      target: {
        repository: boundedText(context.target.repository, "target.repository"),
        pull_request: positiveInteger(context.target.pull_request, "target.pull_request"),
        commit_sha: commitSha(context.target.commit_sha, "target.commit_sha"),
      },
      linear_issue: boundedText(context.linear_issue, "linear_issue"),
      calyx_build_sha: commitSha(context.calyx_build_sha, "calyx_build_sha"),
      reviewer_definition_digest: digest(
        context.reviewer_definition_digest,
        "reviewer_definition_digest",
      ),
      evidence: {
        evidence_id: boundedText(context.evidence.evidence_id, "evidence.evidence_id"),
        receipt_hash: digest(context.evidence.receipt_hash, "evidence.receipt_hash"),
        artifact_digest: digest(context.evidence.artifact_digest, "evidence.artifact_digest"),
        intrinsic_status: context.evidence.intrinsic_status,
        verdict: context.evidence.verdict,
        coverage_status: "full",
        counts,
      },
    },
    publisherIdentities: {
      github_author_node_id: boundedText(
        publisherIdentities.github_author_node_id,
        "publisher_identities.github_author_node_id",
      ),
      linear_actor_id: boundedText(
        publisherIdentities.linear_actor_id,
        "publisher_identities.linear_actor_id",
      ),
    },
  };
}

function renderBody(
  context: ReviewPublicationContext,
  contentDigest: string,
  contentMarker: string,
): string {
  const { evidence, target } = context;
  return [
    "Calyx independent review receipt",
    "",
    `- Result: ${evidence.intrinsic_status} (${evidence.verdict}, ${evidence.coverage_status} coverage)`,
    `- Findings: ${evidence.counts.total} total (P0 ${evidence.counts.P0}, P1 ${evidence.counts.P1}, P2 ${evidence.counts.P2}, P3 ${evidence.counts.P3})`,
    `- Target: ${target.repository}#${target.pull_request} @ ${target.commit_sha}`,
    `- Review instance: ${context.instance_id} (round ${context.round})`,
    `- Evidence: ${evidence.evidence_id} / ${evidence.artifact_digest}`,
    `- Evidence receipt: ${evidence.receipt_hash}`,
    `- Reviewer definition: ${context.reviewer_definition_digest}`,
    `- Calyx build: ${context.calyx_build_sha}`,
    `- Content digest: ${contentDigest}`,
    "",
    contentMarker,
  ].join("\n");
}

/**
 * Render the two exact provider envelopes from immutable admission and
 * evaluated RunService evidence. No caller-supplied body, digest, or adapter
 * choice crosses this boundary.
 */
export function deriveReviewPublicationRequest(
  rawContext: ReviewPublicationContext,
  rawPublisherIdentities: ReviewPublisherIdentities,
): DerivedReviewPublicationRequest {
  const { context, publisherIdentities } = normalizeContext(
    rawContext,
    rawPublisherIdentities,
  );
  const content = {
    schema_version: REVIEW_PUBLICATION_CONTENT_SCHEMA_VERSION,
    instance_id: context.instance_id,
    round: context.round,
    target: context.target,
    linear_issue: context.linear_issue,
    calyx_build_sha: context.calyx_build_sha,
    reviewer_definition_digest: context.reviewer_definition_digest,
    evidence: context.evidence,
  };
  const contentDigest = sha256(canonicalJson(content));
  const contentMarker = `<!-- calyx-independent-review/v1 content-sha256=${contentDigest} -->`;
  const body = renderBody(context, contentDigest, contentMarker);
  if (Buffer.byteLength(body, "utf8") > MAX_PROVIDER_BODY_BYTES) {
    throw new TypeError(`Publication body exceeds ${String(MAX_PROVIDER_BODY_BYTES)} UTF-8 bytes.`);
  }
  const bodyDigest = sha256(body);
  return {
    schema_version: REVIEW_PUBLICATION_REQUEST_SCHEMA_VERSION,
    required_adapters: ["github_review", "linear_comment"],
    content_digest: contentDigest,
    content_marker: contentMarker,
    envelopes: {
      github_review: {
        repository: context.target.repository,
        pull_request: context.target.pull_request,
        commit_id: context.target.commit_sha,
        event: "COMMENT",
        body,
        body_digest: bodyDigest,
        content_digest: contentDigest,
        content_marker: contentMarker,
        publisher_author_node_id: publisherIdentities.github_author_node_id,
      },
      linear_comment: {
        issue: context.linear_issue,
        body,
        body_digest: bodyDigest,
        content_digest: contentDigest,
        content_marker: contentMarker,
        publisher_actor_id: publisherIdentities.linear_actor_id,
      },
    },
  };
}
