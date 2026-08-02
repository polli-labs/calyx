import { describe, expect, test } from "vitest";
import { detectProviderConstraint } from "../src/provider-constraint.js";

describe("detectProviderConstraint", () => {
  test("normalizes the exact Claude session-limit shape without retaining raw text", () => {
    const raw = "You've hit your session limit · resets 8:10am (UTC)";
    const result = detectProviderConstraint({
      backend: "claude",
      source: "backend_stream",
      observed_at: "2026-07-21T07:06:08.573Z",
      provider_code: "rate_limit",
      http_status: 429,
      message: raw,
    });

    expect(result).toEqual({
      schema_version: "calyx.provider-constraint/v1",
      cause: "provider_capacity_exhausted",
      backend: "claude",
      kind: "session_window",
      source: "backend_stream",
      observed_at: "2026-07-21T07:06:08.573Z",
      confidence: "definitive",
      provider_code: "rate_limit",
      http_status: 429,
      reset_hint: "resets 8:10am (UTC)",
    });
    expect(JSON.stringify(result)).not.toContain("You've hit");
  });

  test("does not misclassify bare HTTP 429 or rate_limit as exhausted capacity", () => {
    expect(detectProviderConstraint({
      backend: "claude",
      source: "backend_stream",
      provider_code: "rate_limit",
      http_status: 429,
      message: "Request throttled.",
    })).toBeUndefined();
  });

  test.each([
    ["wrong provider code", "overloaded_error", 429, "You've hit your session limit · resets 8:10am (UTC)"],
    ["wrong HTTP status", "rate_limit", 503, "You've hit your session limit · resets 8:10am (UTC)"],
    ["near-miss prose", "rate_limit", 429, "The session limit documentation moved."],
  ])("requires Claude's full structured signature: %s", (_label, providerCode, httpStatus, message) => {
    expect(detectProviderConstraint({
      backend: "claude",
      source: "backend_stream",
      provider_code: providerCode,
      http_status: httpStatus,
      message,
    })).toBeUndefined();
  });

  test("normalizes exact terminal Codex credits with a strict reset timestamp", () => {
    const result = detectProviderConstraint({
      backend: "codex",
      source: "backend_stderr",
      observed_at: "2026-07-23T01:00:00Z",
      terminal_failure: true,
      message: "You've hit your usage limit. Purchase more credits or try again at Jul 18th, 2026 2:33 AM. https://example.invalid/account",
    });

    expect(result).toMatchObject({
      cause: "provider_capacity_exhausted",
      backend: "codex",
      kind: "credits",
      source: "backend_stderr",
      reset_hint: "try again at Jul 18th, 2026 2:33 AM",
    });
    expect(JSON.stringify(result)).not.toContain("example.invalid");
  });

  test.each([
    "Warning: usage limit configuration ignored; continuing normally.",
    "You've hit your usage limit. Continuing normally.",
    "Purchase more credits in the billing guide.",
  ])("does not derive Codex capacity from benign or incomplete stderr: %s", (message) => {
    expect(detectProviderConstraint({
      backend: "codex",
      source: "backend_stderr",
      terminal_failure: true,
      message,
    })).toBeUndefined();
  });

  test("never copies arbitrary account, secret, or path data into reset_hint", () => {
    const result = detectProviderConstraint({
      backend: "codex",
      source: "backend_stderr",
      terminal_failure: true,
      message: [
        "You've hit your usage limit. Purchase more credits or try again at 03:00 UTC;",
        "account alice@example.com key sk-proj-secret path /home/caleb/private.",
      ].join(" "),
    });

    expect(result?.reset_hint).toBe("try again at 03:00 UTC");
    expect(JSON.stringify(result)).not.toMatch(/alice|sk-proj|\/home\/caleb/iu);
  });
});
