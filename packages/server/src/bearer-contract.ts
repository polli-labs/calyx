const CALYX_BEARER_TOKEN_BODY_PATTERN_SOURCE = "[\\x21-\\x2B\\x2D-\\x7E]+";

/**
 * One exact bearer-token language shared by daemon ingress and the generated
 * client contract. It is deliberately narrower than a generic HTTP field
 * value: printable ASCII excluding comma is trim-stable, cardinality-stable,
 * and exactly representable by Fetch without ByteString conversion failures.
 */
export const CALYX_BEARER_TOKEN_PATTERN_SOURCE = `^${CALYX_BEARER_TOKEN_BODY_PATTERN_SOURCE}$`;
export const CALYX_BEARER_TOKEN_MAX_BYTES = 4_096;

export const CALYX_BEARER_TOKEN_CONTRACT = Object.freeze({
  encoding: "ascii",
  max_bytes: CALYX_BEARER_TOKEN_MAX_BYTES,
  pattern: CALYX_BEARER_TOKEN_PATTERN_SOURCE,
} as const);

const bearerTokenPattern = new RegExp(CALYX_BEARER_TOKEN_PATTERN_SOURCE, "u");
const bearerAuthorizationPattern = new RegExp(`^Bearer (${CALYX_BEARER_TOKEN_BODY_PATTERN_SOURCE})$`, "iu");

export function isCalyxBearerToken(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= CALYX_BEARER_TOKEN_MAX_BYTES
    && bearerTokenPattern.test(value);
}

export function parseCalyxBearerAuthorization(value: string): string | undefined {
  const token = bearerAuthorizationPattern.exec(value)?.[1];
  return token !== undefined && isCalyxBearerToken(token) ? token : undefined;
}
