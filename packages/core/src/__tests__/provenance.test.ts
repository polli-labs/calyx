import { describe, expect, test } from "vitest";

import {
  parseApiProvenanceJson,
  validateApiAssertedActor,
  validateApiProvenance,
} from "../state";

const provenance = {
  schema_version: "calyx.provenance/v1" as const,
  request_id: "req_123e4567-e89b-42d3-a456-426614174000",
  subject: "daemon:blade",
  asserted_actor: "interactive:codex:019abc",
  host: "blade",
  via: "http" as const,
  at: "2026-07-14T04:00:00.000Z",
};

describe("calyx.provenance/v1", () => {
  test("positively reconstructs the canonical privacy-bounded envelope", () => {
    expect(validateApiProvenance({ ...provenance, ignored: "not persisted" } as typeof provenance)).toEqual(provenance);
    expect(parseApiProvenanceJson(JSON.stringify(provenance))).toEqual(provenance);
  });

  test("rejects malformed correlation, identity, host, timestamp, and transport fields", () => {
    for (const mutation of [
      { request_id: "caller-id" },
      { subject: "Operator CLI" },
      { host: "Blade Host" },
      { via: "tcp" },
      { at: "2026-07-14" },
      { asserted_actor: "codex://threads/123" },
    ]) {
      expect(() => validateApiProvenance({ ...provenance, ...mutation } as typeof provenance)).toThrow();
    }
  });

  test("accepts only dereferenceable activity and operator actor forms", () => {
    expect(validateApiAssertedActor("operator:caleb")).toBe("operator:caleb");
    expect(validateApiAssertedActor("run:run-123")).toBe("run:run-123");
    expect(validateApiAssertedActor("interactive:claude:session-123")).toBe("interactive:claude:session-123");
    for (const rejected of [
      "019abcde-1234-4567-89ab-0123456789ab",
      "codex:blade:session",
      "codex://threads/123",
      "run:with/slash",
      "operator:with space",
      "operator:comma,fold",
    ]) expect(() => validateApiAssertedActor(rejected)).toThrow();
  });
});
