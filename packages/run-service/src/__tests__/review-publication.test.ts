import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  REVIEW_PUBLICATION_CONTENT_SCHEMA_VERSION,
  deriveReviewPublicationRequest,
  type ReviewPublicationContext,
  type ReviewPublisherIdentities,
} from "../review-publication.js";

const TARGET_SHA = "b".repeat(40);

function context(): ReviewPublicationContext {
  return {
    instance_id: "review-instance-1",
    round: 2,
    target: {
      repository: "polli-labs/calyx-dev",
      pull_request: 274,
      commit_sha: TARGET_SHA,
    },
    linear_issue: "POL-1983",
    calyx_build_sha: "a".repeat(40),
    reviewer_definition_digest: "c".repeat(64),
    evidence: {
      evidence_id: "review-evidence-1",
      receipt_hash: "d".repeat(64),
      artifact_digest: "f".repeat(64),
      intrinsic_status: "passed",
      verdict: "mergeable",
      coverage_status: "full",
      counts: { P0: 0, P1: 0, P2: 0, P3: 0, total: 0 },
    },
  };
}

function publisherIdentities(): ReviewPublisherIdentities {
  return {
    github_author_node_id: "MDQ6VXNlcjEyMzQ=",
    linear_actor_id: "linear-actor-1",
  };
}

describe("independent review publication authority", () => {
  test("derives stable self-contained provider envelopes from immutable facts", () => {
    const first = deriveReviewPublicationRequest(context(), publisherIdentities());
    const replay = deriveReviewPublicationRequest(
      structuredClone(context()),
      structuredClone(publisherIdentities()),
    );
    expect(replay).toEqual(first);
    expect(first.required_adapters).toEqual(["github_review", "linear_comment"]);
    expect(first.envelopes.github_review.commit_id).toBe(TARGET_SHA);
    expect(first.envelopes.github_review.body).toBe(first.envelopes.linear_comment.body);
    expect(first.envelopes.github_review.body_digest).toBe(
      createHash("sha256").update(first.envelopes.github_review.body, "utf8").digest("hex"),
    );
    expect(first.envelopes.github_review.content_marker).toContain(first.content_digest);
    expect(first.envelopes.github_review.body).toContain(first.content_marker);
    expect(first.envelopes.github_review.publisher_author_node_id).toBe(
      publisherIdentities().github_author_node_id,
    );
    expect(first.envelopes.linear_comment.publisher_actor_id).toBe(
      publisherIdentities().linear_actor_id,
    );
    expect(REVIEW_PUBLICATION_CONTENT_SCHEMA_VERSION).toBe("calyx.review-publication-content/v1");

    const changed = context();
    changed.evidence.counts.P1 = 1;
    changed.evidence.counts.total = 1;
    changed.evidence.intrinsic_status = "not_passed";
    changed.evidence.verdict = "not_mergeable";
    expect(
      deriveReviewPublicationRequest(changed, publisherIdentities()).content_digest,
    ).not.toBe(first.content_digest);
  });

  test("publisher authority changes effect bytes without changing evidence content", () => {
    const first = deriveReviewPublicationRequest(context(), publisherIdentities());
    const rotated = publisherIdentities();
    rotated.github_author_node_id = "MDQ6VXNlcjU2Nzg=";
    const second = deriveReviewPublicationRequest(context(), rotated);
    expect(second.content_digest).toBe(first.content_digest);
    expect(second.envelopes.github_review.body).toBe(first.envelopes.github_review.body);
    expect(second.envelopes.github_review.publisher_author_node_id).not.toBe(
      first.envelopes.github_review.publisher_author_node_id,
    );
  });

  test.each([
    ["count sum", (value: ReviewPublicationContext) => {
      value.evidence.counts.total = 1;
    }],
    ["finding with passed verdict", (value: ReviewPublicationContext) => {
      value.evidence.counts.P1 = 1;
      value.evidence.counts.total = 1;
    }],
    ["unknown intrinsic status", (value: ReviewPublicationContext) => {
      (value.evidence as { intrinsic_status: unknown }).intrinsic_status = "unknown";
      value.evidence.counts.P1 = 1;
      value.evidence.counts.total = 1;
      value.evidence.verdict = "not_mergeable";
    }],
    ["partial coverage", (value: ReviewPublicationContext) => {
      value.evidence.coverage_status = "partial";
    }],
    ["unsafe round", (value: ReviewPublicationContext) => {
      value.round = Number.POSITIVE_INFINITY;
    }],
    ["malformed digest", (value: ReviewPublicationContext) => {
      value.evidence.receipt_hash = "not-a-digest";
    }],
    ["control character", (value: ReviewPublicationContext) => {
      value.linear_issue = "POL-1983\nforged";
    }],
  ])("rejects contradictory or unbounded publication context: %s", (_label, mutate) => {
    const value = context();
    mutate(value);
    expect(() => deriveReviewPublicationRequest(value, publisherIdentities())).toThrow();
  });

  test("rejects unbounded or control-bearing publisher identities", () => {
    expect(() => deriveReviewPublicationRequest(context(), {
      ...publisherIdentities(),
      linear_actor_id: "actor\nforged",
    })).toThrow(/bounded/);
    expect(() => deriveReviewPublicationRequest(context(), {
      ...publisherIdentities(),
      github_author_node_id: "x".repeat(513),
    })).toThrow(/bounded/);
  });
});
