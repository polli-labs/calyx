import { describe, expect, test } from "vitest";

import {
  REVIEW_LAUNCH_REQUEST_SCHEMA_VERSION,
  normalizeReviewLaunchRequest,
} from "../review-launch-request.js";

const TARGET_SHA = "b".repeat(40);

function launchRequest(): Record<string, unknown> {
  return {
    schema_version: REVIEW_LAUNCH_REQUEST_SCHEMA_VERSION,
    agent_ref: "reviewer-adversarial@v2",
    host: "blade",
    target_sha: TARGET_SHA,
    required_artifact: "findings.json",
  };
}

describe("independent review launch capsule", () => {
  test("returns a newly allocated normalized closed request", () => {
    const raw = launchRequest();
    raw["agent_ref"] = " reviewer-adversarial@v2 ";
    const normalized = normalizeReviewLaunchRequest(raw, TARGET_SHA);
    expect(normalized).toEqual({
      schema_version: REVIEW_LAUNCH_REQUEST_SCHEMA_VERSION,
      agent_ref: "reviewer-adversarial@v2",
      host: "blade",
      target_sha: TARGET_SHA,
      required_artifact: "findings.json",
    });
    expect(normalized).not.toBe(raw);
  });

  test.each([
    "env",
    "token",
    "api_key",
    "credentials",
    "credential_slot",
    "secret_ref",
    "prompt",
    "cwd",
    "path",
    "tool_config",
    "nested",
  ])("rejects unknown or secret-bearing field %s", (field) => {
    expect(() => normalizeReviewLaunchRequest({
      ...launchRequest(),
      [field]: field === "nested" ? { arbitrary: true } : "forbidden",
    }, TARGET_SHA)).toThrow(/must contain exactly/);
  });

  test("rejects missing fields, target mismatch, and alternate artifact", () => {
    const missing = launchRequest();
    delete missing["host"];
    expect(() => normalizeReviewLaunchRequest(missing, TARGET_SHA)).toThrow(/exactly/);
    expect(() => normalizeReviewLaunchRequest({
      ...launchRequest(),
      target_sha: "c".repeat(40),
    }, TARGET_SHA)).toThrow(/must match/);
    expect(() => normalizeReviewLaunchRequest({
      ...launchRequest(),
      required_artifact: "result.json",
    }, TARGET_SHA)).toThrow(/findings\.json/);
  });

  test.each([
    ["agent_ref", "review this prompt"],
    ["agent_ref", "/tmp/reviewer"],
    ["agent_ref", "TOKEN=secret"],
    ["host", "blade --flag"],
    ["host", "../blade"],
    ["host", "blade:22"],
  ])("rejects executable material smuggled through %s", (field, value) => {
    expect(() => normalizeReviewLaunchRequest({
      ...launchRequest(),
      [field]: value,
    }, TARGET_SHA)).toThrow(/registered/);
  });

  test("rejects non-plain objects and unsupported schema versions", () => {
    expect(() => normalizeReviewLaunchRequest([], TARGET_SHA)).toThrow(/plain object/);
    expect(() => normalizeReviewLaunchRequest(new Map(), TARGET_SHA)).toThrow(/plain object/);
    expect(() => normalizeReviewLaunchRequest({
      ...launchRequest(),
      schema_version: "calyx.review-launch-request/v2",
    }, TARGET_SHA)).toThrow(/v1/);
  });
});
