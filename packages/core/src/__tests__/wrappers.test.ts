import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { syncSkillsRegistry } from "../skills";
import { syncPromptsRegistry } from "../prompts";
import {
  WRAPPER_REGISTRY,
  emitWrapperTelemetry,
  checkWrapperGuardrail,
  getWrapperDeprecationPhase,
  getDeferredWrapperMessage,
  getRetiredWrapperMessage
} from "../wrappers";
import type { WrapperTelemetryEvent } from "../types";

/**
 * Wrapper behavior tests.
 *
 * These tests validate the wrapper lifecycle contract:
 * 1. Retired wrappers (P9) produce clear "removed" messages.
 * 2. Deferred wrappers produce clear "not yet implemented" messages.
 * 3. The canonical WRAPPER_REGISTRY is complete and consistent.
 * 4. Telemetry and guardrail helpers remain functional for audit.
 * 5. Domain functions are called with the correct backend routing.
 */

function fixtureRoot(): string {
  return path.resolve(process.cwd(), "fixtures/domains");
}

function isValidTelemetryEvent(event: WrapperTelemetryEvent): boolean {
  return (
    event.event === "calyx.wrapper.invoked" &&
    typeof event.wrapper === "string" &&
    event.wrapper.length > 0 &&
    typeof event.target === "string" &&
    event.target.length > 0 &&
    typeof event.timestamp === "string" &&
    !isNaN(Date.parse(event.timestamp)) &&
    typeof event.pid === "number" &&
    event.pid > 0 &&
    typeof event.cwd === "string" &&
    event.cwd.length > 0 &&
    typeof event.deprecation_phase === "string" &&
    (event.deprecation_phase === "warn" || event.deprecation_phase === "error" || event.deprecation_phase === "active")
  );
}

afterEach(() => {
  delete process.env["CALYX_FAIL_ON_DEPRECATED"];
});

// ── Telemetry contract ──────────────────────────────────────────────

describe("wrapper telemetry contract", () => {
  test("telemetry event shape is valid with enriched fields", () => {
    const event = emitWrapperTelemetry("test-wrapper", "calyx test command");
    expect(isValidTelemetryEvent(event)).toBe(true);
    expect(event.pid).toBe(process.pid);
    expect(event.cwd).toBe(process.cwd());
    expect(event.deprecation_phase).toBe("warn");
  });

  test("telemetry event rejects invalid timestamp", () => {
    const event: WrapperTelemetryEvent = {
      event: "calyx.wrapper.invoked",
      wrapper: "test-wrapper",
      target: "calyx test command",
      timestamp: "not-a-date",
      pid: 1,
      cwd: "/tmp",
      deprecation_phase: "warn"
    };
    expect(isValidTelemetryEvent(event)).toBe(false);
  });

  test("telemetry event includes deprecation_phase=error when env is set", () => {
    process.env["CALYX_FAIL_ON_DEPRECATED"] = "1";
    const event = emitWrapperTelemetry("test-wrapper", "calyx test command");
    expect(event.deprecation_phase).toBe("error");
  });
});

// ── Guardrail behavior ──────────────────────────────────────────────

describe("wrapper guardrails", () => {
  test("default phase is warn (wrappers allowed)", () => {
    expect(getWrapperDeprecationPhase()).toBe("warn");
  });

  test("CALYX_FAIL_ON_DEPRECATED=1 sets phase to error", () => {
    process.env["CALYX_FAIL_ON_DEPRECATED"] = "1";
    expect(getWrapperDeprecationPhase()).toBe("error");
  });

  test("CALYX_FAIL_ON_DEPRECATED=true sets phase to error", () => {
    process.env["CALYX_FAIL_ON_DEPRECATED"] = "true";
    expect(getWrapperDeprecationPhase()).toBe("error");
  });

  test("checkWrapperGuardrail allows in warn phase", () => {
    const result = checkWrapperGuardrail("test-wrapper", "calyx test command");
    expect(result.allowed).toBe(true);
    expect(result.phase).toBe("warn");
  });

  test("checkWrapperGuardrail blocks in error phase", () => {
    process.env["CALYX_FAIL_ON_DEPRECATED"] = "1";
    const result = checkWrapperGuardrail("test-wrapper", "calyx test command");
    expect(result.allowed).toBe(false);
    expect(result.phase).toBe("error");
    expect(result.message).toContain("CALYX_FAIL_ON_DEPRECATED");
    expect(result.message).toContain("calyx test command");
  });
});

// ── Deferred wrapper messages ───────────────────────────────────────

describe("deferred wrapper tombstones", () => {
  test("getDeferredWrapperMessage returns clear message for known deferred wrapper", () => {
    const msg = getDeferredWrapperMessage("agents-fleet");
    expect(msg).toContain("not yet implemented");
    expect(msg).toContain("P2-P4");
    expect(msg).toContain("Split across domain commands");
  });

  test("getDeferredWrapperMessage handles unknown wrapper", () => {
    const msg = getDeferredWrapperMessage("nonexistent-wrapper");
    expect(msg).toContain("Unknown wrapper");
  });

  test("all deferred wrappers produce messages with sunset info", () => {
    const deferred = WRAPPER_REGISTRY.filter((d) => d.status === "deferred");
    expect(deferred.length).toBeGreaterThan(0);
    for (const def of deferred) {
      const msg = getDeferredWrapperMessage(def.wrapper);
      expect(msg).toContain("not yet implemented");
      expect(msg).toContain(def.phase);
      // All deferred wrappers should have sunset criteria in notes
      expect(def.notes).toContain("sunset");
    }
  });
});

// ── Retired wrapper messages ────────────────────────────────────────

describe("retired wrapper tombstones", () => {
  test("getRetiredWrapperMessage returns clear message for known retired wrapper", () => {
    const msg = getRetiredWrapperMessage("skills-sync");
    expect(msg).toContain("removed in P9");
    expect(msg).toContain("calyx skills sync");
    expect(msg).toContain("2026-03-02");
  });

  test("getRetiredWrapperMessage handles unknown wrapper", () => {
    const msg = getRetiredWrapperMessage("nonexistent-wrapper");
    expect(msg).toContain("Unknown wrapper");
  });

  test("all retired wrappers produce messages with retirement date", () => {
    const retired = WRAPPER_REGISTRY.filter((d) => d.status === "retired");
    expect(retired.length).toBeGreaterThan(0);
    for (const def of retired) {
      const msg = getRetiredWrapperMessage(def.wrapper);
      expect(msg).toContain("removed in");
      expect(msg).toContain(def.target);
      expect(def.retiredAt).toBeTruthy();
    }
  });
});

// ── Wrapper registry completeness ───────────────────────────────────

describe("wrapper registry", () => {
  const retired = WRAPPER_REGISTRY.filter((d) => d.status === "retired");
  const deferred = WRAPPER_REGISTRY.filter((d) => d.status === "deferred");
  const implemented = WRAPPER_REGISTRY.filter((d) => d.status === "implemented");

  test("registry has 7 retired wrappers", () => {
    expect(retired).toHaveLength(7);
  });

  test("registry has 12 deferred wrappers", () => {
    expect(deferred).toHaveLength(12);
  });

  test("registry has 0 implemented wrappers (all migrated)", () => {
    expect(implemented).toHaveLength(0);
  });

  test("all retired wrappers have calyx targets", () => {
    for (const def of retired) {
      expect(def.target).toMatch(/^calyx /);
    }
  });

  test("all retired wrappers have retiredAt dates", () => {
    for (const def of retired) {
      expect(def.retiredAt).toBeTruthy();
      expect(new Date(def.retiredAt!).toISOString()).toContain("2026");
    }
  });

  test("no duplicate wrapper names", () => {
    const names = WRAPPER_REGISTRY.map((d) => d.wrapper);
    expect(new Set(names).size).toBe(names.length);
  });

  test("all entries have phase tags", () => {
    for (const def of WRAPPER_REGISTRY) {
      expect(def.phase).toBeTruthy();
    }
  });
});

// ── Backend routing ─────────────────────────────────────────────────

describe("domain backend routing", () => {
  const root = fixtureRoot();
  const skillsPath = path.join(root, "skills/registry.valid.json");
  const promptsPath = path.join(root, "prompts/registry.valid.json");

  test("skills sync routes to claude backend", async () => {
    const result = await syncSkillsRegistry(skillsPath, { backend: "claude", apply: false });
    expect(result.backend).toBe("claude");
    expect(result.apply).toBe(false);
  });

  test("skills sync routes to codex backend", async () => {
    const result = await syncSkillsRegistry(skillsPath, { backend: "codex", apply: false });
    expect(result.backend).toBe("codex");
    expect(result.apply).toBe(false);
  });

  test("skills sync defaults to all backend", async () => {
    const result = await syncSkillsRegistry(skillsPath, { backend: "all", apply: false });
    expect(result.backend).toBe("all");
    expect(result.apply).toBe(false);
  });

  test("prompts sync routes to claude backend", async () => {
    const result = await syncPromptsRegistry(promptsPath, { backend: "claude", apply: false });
    expect(result.backend).toBe("claude");
    expect(result.apply).toBe(false);
  });

  test("prompts sync routes to codex backend", async () => {
    const result = await syncPromptsRegistry(promptsPath, { backend: "codex", apply: false });
    expect(result.backend).toBe("codex");
    expect(result.apply).toBe(false);
  });
});

// ── E2E telemetry validation ────────────────────────────────────────

describe("e2e telemetry validation", () => {
  test("telemetry emit writes valid events to stderr", () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    emitWrapperTelemetry("test-wrapper", "calyx test command");

    expect(stderrSpy).toHaveBeenCalledTimes(2);

    // First call: deprecation warning
    const deprecationCall = stderrSpy.mock.calls[0]?.[0] as string;
    expect(deprecationCall).toContain("[calyx][deprecated]");
    expect(deprecationCall).toContain("test-wrapper");
    expect(deprecationCall).toContain("calyx test command");

    // Second call: telemetry JSON
    const telemetryCall = stderrSpy.mock.calls[1]?.[0] as string;
    expect(telemetryCall).toContain("[calyx][telemetry]");
    const jsonPart = telemetryCall.replace("[calyx][telemetry] ", "");
    const parsed = JSON.parse(jsonPart) as WrapperTelemetryEvent;
    expect(isValidTelemetryEvent(parsed)).toBe(true);
    expect(parsed.wrapper).toBe("test-wrapper");
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.deprecation_phase).toBe("warn");

    stderrSpy.mockRestore();
  });

  test("telemetry with domain function produces enriched envelope", async () => {
    const root = fixtureRoot();
    const skillsPath = path.join(root, "skills/registry.valid.json");

    const telemetry = emitWrapperTelemetry("test-wrapper", "calyx skills sync --backend claude");
    const result = await syncSkillsRegistry(skillsPath, { backend: "claude", apply: false });
    const envelope = { wrapper: telemetry, result };

    // Validate complete envelope
    expect(envelope.wrapper.event).toBe("calyx.wrapper.invoked");
    expect(envelope.wrapper.pid).toBeGreaterThan(0);
    expect(envelope.wrapper.cwd).toBeTruthy();
    expect(envelope.wrapper.deprecation_phase).toBe("warn");
    expect(envelope.result.backend).toBe("claude");
    expect(envelope.result.apply).toBe(false);
    expect(Array.isArray(envelope.result.actions)).toBe(true);

    // JSON round-trip
    const serialized = JSON.stringify(envelope);
    const deserialized = JSON.parse(serialized);
    expect(deserialized.wrapper.event).toBe("calyx.wrapper.invoked");
    expect(deserialized.wrapper.pid).toBe(process.pid);
  });
});
