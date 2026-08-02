import type { IncomingMessage } from "node:http";

import { describe, expect, test } from "vitest";

import {
  CALYX_BEARER_TOKEN_CONTRACT,
  CALYX_BEARER_TOKEN_MAX_BYTES,
  CALYX_BEARER_TOKEN_PATTERN_SOURCE,
} from "../bearer-contract.js";
import { readBearerToken } from "../auth.js";

function requestWithAuthorization(
  authorization?: string,
  rawAuthorizationValues?: readonly string[],
): IncomingMessage {
  const rawValues = rawAuthorizationValues ?? (authorization === undefined ? [] : [authorization]);
  return {
    headers: authorization === undefined ? {} : { authorization },
    rawHeaders: rawValues.flatMap((value) => ["Authorization", value]),
  } as IncomingMessage;
}

describe("Bearer framing", () => {
  test.each([
    ["Bearer token", "token"],
    ["bearer alpha._~+/-", "alpha._~+/-"],
    ["BEARER 123", "123"],
    ["Bearer !#$%&'*+-.^_`|~", "!#$%&'*+-.^_`|~"],
  ])("accepts exactly one case-insensitive Bearer credential: %s", (authorization, token) => {
    expect(readBearerToken(requestWithAuthorization(authorization))).toBe(token);
  });

  test.each([
    undefined,
    "",
    "Bearer",
    "Bearer ",
    " Bearer token",
    "Bearer token ",
    "Bearer  token",
    "Bearer\ttoken",
    "Basic token",
    "Bearer token trailing",
    "Bearer token,Bearer other",
    "Bearer token, Basic other",
    "Bearer token\r\nBearer other",
    "Bearer token\u007f",
    "Bearer token\u0080",
    "Bearer token\u00a0",
    "Bearer token\u00ff",
    "Bearer token\u0100",
    "Bearer token😀",
    "Bearer token\ud800",
    "Bearer token\udc00",
  ])("rejects malformed, trailing, or folded authorization material: %s", (authorization) => {
    expect(readBearerToken(requestWithAuthorization(authorization))).toBeUndefined();
  });

  test("rejects repeated physical Authorization fields even when Node normalizes the first", () => {
    expect(readBearerToken(requestWithAuthorization(
      "Bearer accepted-if-cardinality-were-ignored",
      ["Bearer accepted-if-cardinality-were-ignored", "Bearer second"],
    ))).toBeUndefined();
  });

  test("accepts the bearer-token byte boundary and rejects one byte beyond it", () => {
    const maximumToken = "a".repeat(CALYX_BEARER_TOKEN_MAX_BYTES);
    expect(readBearerToken(requestWithAuthorization(`Bearer ${maximumToken}`))).toBe(maximumToken);
    expect(readBearerToken(requestWithAuthorization(`Bearer ${maximumToken}a`))).toBeUndefined();
  });

  test("keeps the published grammar exact, printable, ASCII, and comma-free", () => {
    expect(CALYX_BEARER_TOKEN_CONTRACT).toEqual({
      encoding: "ascii",
      max_bytes: 4_096,
      pattern: "^[\\x21-\\x2B\\x2D-\\x7E]+$",
    });
    const grammar = new RegExp(CALYX_BEARER_TOKEN_PATTERN_SOURCE, "u");
    expect(grammar.test("!")).toBe(true);
    expect(grammar.test("~")).toBe(true);
    expect(grammar.test(",")).toBe(false);
    expect(grammar.test(" ")).toBe(false);
    expect(grammar.test("\u007f")).toBe(false);
    expect(grammar.test("\u0080")).toBe(false);
  });
});
