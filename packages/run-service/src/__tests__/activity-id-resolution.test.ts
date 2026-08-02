import { describe, expect, test } from "vitest";
import {
  describeMalformedActivityLocator,
  formatMalformedActivityLocator,
  normalizeBackendSessionId,
  parseInteractiveActivityLocator,
} from "../activity-id-resolution.js";

const CODEX_SESSION_ID = "019eb965-56f7-7752-8e56-a51eafd1f518";
const CLAUDE_SESSION_ID = "0baf9eee-11c6-4c10-b6c7-a6cddecf3180";

describe("parseInteractiveActivityLocator", () => {
  test("parses full interactive activity ids without a host", () => {
    expect(parseInteractiveActivityLocator(`interactive:codex:${CODEX_SESSION_ID}`)).toEqual({
      backend: "codex",
      sessionId: CODEX_SESSION_ID,
    });
  });

  test("parses codex thread deeplinks without a host", () => {
    expect(parseInteractiveActivityLocator(`codex://threads/${CODEX_SESSION_ID}`)).toEqual({
      backend: "codex",
      sessionId: CODEX_SESSION_ID,
    });
  });

  test("parses <backend>:<host>:<session_id> authorship aliases (POL-1774)", () => {
    expect(parseInteractiveActivityLocator(`codex:blade:${CODEX_SESSION_ID}`)).toEqual({
      backend: "codex",
      host: "blade",
      sessionId: CODEX_SESSION_ID,
    });
    expect(parseInteractiveActivityLocator(`claude:carbon:${CLAUDE_SESSION_ID}`)).toEqual({
      backend: "claude",
      host: "carbon",
      sessionId: CLAUDE_SESSION_ID,
    });
  });

  test("authorship aliases normalize mixed-case captures", () => {
    expect(parseInteractiveActivityLocator(`CODEX:Blade:${CODEX_SESSION_ID.toUpperCase()}`)).toEqual({
      backend: "codex",
      host: "blade",
      sessionId: CODEX_SESSION_ID,
    });
  });

  test("authorship aliases accept dotted hosts and session-id prefixes", () => {
    expect(parseInteractiveActivityLocator(`codex:blade.local:${CODEX_SESSION_ID}`)).toEqual({
      backend: "codex",
      host: "blade.local",
      sessionId: CODEX_SESSION_ID,
    });
    expect(parseInteractiveActivityLocator("codex:blade:019eb965")).toEqual({
      backend: "codex",
      host: "blade",
      sessionId: "019eb965",
    });
  });

  test("non-uuid session segments do not parse as authorship aliases", () => {
    expect(parseInteractiveActivityLocator("claude:foo:bar")).toEqual({
      sessionId: "claude:foo:bar",
    });
    expect(parseInteractiveActivityLocator("run:blade:0123abcd")).toEqual({
      sessionId: "run:blade:0123abcd",
    });
  });
});

describe("describeMalformedActivityLocator (POL-1825)", () => {
  test("classifies the composite `interactive:<host>:<backend>:<id>` form and names the fix", () => {
    const malformed = describeMalformedActivityLocator(`interactive:blade:codex:${CODEX_SESSION_ID}`);
    expect(malformed).toEqual({
      reason: "not_canonical",
      problem: 'the host segment "blade" belongs in --host, not in the activity id',
      correctedActivityId: `interactive:codex:${CODEX_SESSION_ID}`,
      host: "blade",
    });
    const message = formatMalformedActivityLocator(
      `interactive:blade:codex:${CODEX_SESSION_ID}`,
      malformed!,
    );
    expect(message).toContain("is malformed");
    expect(message).not.toContain("not found");
    expect(message).toContain(`Use: interactive:codex:${CODEX_SESSION_ID} --host blade`);
    expect(message).toContain("interactive:<backend>:<session-id>");
  });

  test("classifies host-first composites without the `interactive:` prefix", () => {
    expect(describeMalformedActivityLocator(`blade:codex:${CLAUDE_SESSION_ID}`)).toMatchObject({
      reason: "not_canonical",
      correctedActivityId: `interactive:codex:${CLAUDE_SESSION_ID}`,
      host: "blade",
    });
  });

  test("classifies unknown backends, missing session ids, and over-segmented ids", () => {
    expect(describeMalformedActivityLocator("interactive:blade:019eb965")).toMatchObject({
      reason: "unparseable",
      problem: "no `codex` or `claude` backend segment is present",
    });
    expect(describeMalformedActivityLocator("interactive:codex:")).toMatchObject({
      reason: "missing_session_id",
    });
    expect(describeMalformedActivityLocator("interactive:blade:codex:019eb965:extra")).toMatchObject({
      reason: "unparseable",
    });
    expect(describeMalformedActivityLocator("run:")).toEqual({
      reason: "missing_run_id",
      problem: "`run:` carries no run id",
    });
  });

  test("leaves every accepted locator form unclassified", () => {
    for (const accepted of [
      `interactive:codex:${CODEX_SESSION_ID}`,
      `interactive:claude:${CLAUDE_SESSION_ID}`,
      `interactive:codex:codex://threads/${CODEX_SESSION_ID}`,
      `codex:blade:${CODEX_SESSION_ID}`,
      `codex://threads/${CODEX_SESSION_ID}`,
      "run:c09d295c",
      `run:${CLAUDE_SESSION_ID}`,
      "019eb965",
      "codex:019eb965",
      "interactive:codex",
    ]) {
      expect(describeMalformedActivityLocator(accepted), accepted).toBeUndefined();
    }
  });
});

describe("normalizeBackendSessionId", () => {
  test("strips authorship alias wrapping for the matching backend", () => {
    expect(normalizeBackendSessionId(`codex:blade:${CODEX_SESSION_ID}`, "codex")).toBe(CODEX_SESSION_ID);
    expect(normalizeBackendSessionId(`claude:carbon:${CLAUDE_SESSION_ID}`, "claude")).toBe(CLAUDE_SESSION_ID);
  });

  test("leaves mismatched-backend values untouched", () => {
    const value = `codex:blade:${CODEX_SESSION_ID}`;
    expect(normalizeBackendSessionId(value, "claude")).toBe(value);
  });

  test("leaves bare session ids untouched", () => {
    expect(normalizeBackendSessionId(CODEX_SESSION_ID, "codex")).toBe(CODEX_SESSION_ID);
  });
});
