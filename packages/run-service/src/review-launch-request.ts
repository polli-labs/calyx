export const REVIEW_LAUNCH_REQUEST_SCHEMA_VERSION =
  "calyx.review-launch-request/v1";

const MAX_REVIEW_LAUNCH_IDENTIFIER_BYTES = 256;
const AGENT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const HOST_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

export interface ReviewLaunchRequestV1 {
  schema_version: typeof REVIEW_LAUNCH_REQUEST_SCHEMA_VERSION;
  agent_ref: string;
  host: string;
  target_sha: string;
  required_artifact: "findings.json";
}

function boundedText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  const normalized = value.trim();
  if (
    !normalized
    || normalized.includes("\0")
    || normalized.includes("\r")
    || normalized.includes("\n")
    || Buffer.byteLength(normalized, "utf8") > MAX_REVIEW_LAUNCH_IDENTIFIER_BYTES
  ) {
    throw new TypeError(`${field} must be a bounded non-empty identifier.`);
  }
  return normalized;
}

/**
 * Close and normalize the only launch capsule admitted by Caller A. The
 * returned object is newly allocated so unknown input properties can never
 * survive into immutable request or effect hashes.
 */
export function normalizeReviewLaunchRequest(
  raw: unknown,
  expectedTargetSha: string,
): ReviewLaunchRequestV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("launch_request must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("launch_request must be a plain object.");
  }
  const input = raw as Record<string, unknown>;
  const expectedKeys = [
    "agent_ref",
    "host",
    "required_artifact",
    "schema_version",
    "target_sha",
  ];
  const actualKeys = Object.keys(input).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(
      `launch_request must contain exactly ${expectedKeys.join(", ")}.`,
    );
  }
  if (input["schema_version"] !== REVIEW_LAUNCH_REQUEST_SCHEMA_VERSION) {
    throw new TypeError(`launch_request must use ${REVIEW_LAUNCH_REQUEST_SCHEMA_VERSION}.`);
  }
  const targetSha = boundedText(input["target_sha"], "launch_request.target_sha").toLowerCase();
  if (targetSha !== expectedTargetSha) {
    throw new TypeError("launch_request.target_sha must match the immutable review target.");
  }
  if (input["required_artifact"] !== "findings.json") {
    throw new TypeError("launch_request.required_artifact must be findings.json.");
  }
  const agentRef = boundedText(input["agent_ref"], "launch_request.agent_ref");
  const host = boundedText(input["host"], "launch_request.host");
  if (!AGENT_REF_PATTERN.test(agentRef)) {
    throw new TypeError("launch_request.agent_ref must be a registered agent identifier.");
  }
  if (!HOST_ALIAS_PATTERN.test(host)) {
    throw new TypeError("launch_request.host must be a registered host alias.");
  }
  return {
    schema_version: REVIEW_LAUNCH_REQUEST_SCHEMA_VERSION,
    agent_ref: agentRef,
    host,
    target_sha: targetSha,
    required_artifact: "findings.json",
  };
}
