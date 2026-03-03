import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { syncSkillsRegistry } from "../skills";
import { syncPromptsRegistry } from "../prompts";
import { bumpToolVersion } from "../tools";
import { execNotify } from "../exec";
import { createExecPlan } from "../knowledge";
import { runDoctor } from "../doctor";
import { installBootstrap } from "../install";
import { buildBundle } from "../bundle";
import {
  WRAPPER_REGISTRY,
  emitWrapperTelemetry,
  checkWrapperGuardrail,
  getWrapperDeprecationPhase,
  getDeferredWrapperMessage,
  getDeprecatedWrapperMessage,
  getRetiredWrapperMessage
} from "../wrappers";
import type { WrapperTelemetryEvent } from "../types";

/**
 * Wrapper behavior tests.
 *
 * These tests validate the wrapper lifecycle contract:
 * 1. Retired wrappers (P9) produce clear "removed" messages.
 * 2. Deferred wrappers produce clear "not yet implemented" messages.
 * 3. Implemented wrappers (POL-679) have canonical command targets.
 * 4. The canonical WRAPPER_REGISTRY is complete and consistent.
 * 5. Telemetry and guardrail helpers remain functional for audit.
 * 6. Domain functions are called with the correct backend routing.
 * 7. New canonical command functions return structured results.
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

// ── Deprecated wrapper messages (POL-680) ───────────────────────────

describe("deprecated wrapper tombstones (POL-680)", () => {
  test("getDeprecatedWrapperMessage returns actionable message for agents-fleet", () => {
    const msg = getDeprecatedWrapperMessage("agents-fleet");
    expect(msg).toContain("will not be implemented in v1");
    expect(msg).toContain("deprecated 2026-03-03");
    expect(msg).toContain("Rationale:");
    expect(msg).toContain("Use instead:");
    expect(msg).toContain("calyx skills sync");
    expect(msg).toContain("calyx verify fleet");
  });

  test("getDeprecatedWrapperMessage returns actionable message for agents-fleet-apply", () => {
    const msg = getDeprecatedWrapperMessage("agents-fleet-apply");
    expect(msg).toContain("will not be implemented in v1");
    expect(msg).toContain("deprecated 2026-03-03");
    expect(msg).toContain("Rationale:");
    expect(msg).toContain("Use instead:");
    expect(msg).toContain("--apply");
  });

  test("getDeprecatedWrapperMessage returns actionable message for agents-worktree-init", () => {
    const msg = getDeprecatedWrapperMessage("agents-worktree-init");
    expect(msg).toContain("will not be implemented in v1");
    expect(msg).toContain("deprecated 2026-03-03");
    expect(msg).toContain("Rationale:");
    expect(msg).toContain("Use instead:");
    expect(msg).toContain("shell script");
  });

  test("getDeprecatedWrapperMessage handles unknown wrapper", () => {
    const msg = getDeprecatedWrapperMessage("nonexistent-wrapper");
    expect(msg).toContain("Unknown wrapper");
  });

  test("all deprecated wrappers have required metadata", () => {
    const deprecated = WRAPPER_REGISTRY.filter((d) => d.status === "deprecated");
    expect(deprecated).toHaveLength(3);
    for (const def of deprecated) {
      expect(def.deprecatedAt, `${def.wrapper} missing deprecatedAt`).toBeTruthy();
      expect(def.rationale, `${def.wrapper} missing rationale`).toBeTruthy();
      expect(def.alternatives, `${def.wrapper} missing alternatives`).toBeDefined();
      expect(def.alternatives!.length, `${def.wrapper} has no alternatives`).toBeGreaterThan(0);
      expect(def.notes, `${def.wrapper} missing notes with sunset info`).toContain("Sunset");
    }
  });

  test("all deprecated wrappers produce messages with alternatives and sunset info", () => {
    const deprecated = WRAPPER_REGISTRY.filter((d) => d.status === "deprecated");
    for (const def of deprecated) {
      const msg = getDeprecatedWrapperMessage(def.wrapper);
      expect(msg).toContain("will not be implemented in v1");
      expect(msg).toContain("Use instead:");
      expect(msg).toContain("Rationale:");
    }
  });

  test("getDeferredWrapperMessage handles unknown wrapper (no deferred wrappers remain)", () => {
    const msg = getDeferredWrapperMessage("nonexistent-wrapper");
    expect(msg).toContain("Unknown wrapper");
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
  const deprecated = WRAPPER_REGISTRY.filter((d) => d.status === "deprecated");
  const deferred = WRAPPER_REGISTRY.filter((d) => d.status === "deferred");
  const implemented = WRAPPER_REGISTRY.filter((d) => d.status === "implemented");

  test("registry has 7 retired wrappers", () => {
    expect(retired).toHaveLength(7);
  });

  test("registry has 3 deprecated wrappers (POL-680 decision)", () => {
    expect(deprecated).toHaveLength(3);
  });

  test("registry has 0 deferred wrappers (all resolved by POL-680)", () => {
    expect(deferred).toHaveLength(0);
  });

  test("registry has 9 implemented wrappers (POL-679)", () => {
    expect(implemented).toHaveLength(9);
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

  test("all implemented wrappers have calyx targets", () => {
    for (const def of implemented) {
      expect(def.target).toMatch(/^calyx /);
    }
  });

  test("all implemented wrappers have P7A-4 phase", () => {
    for (const def of implemented) {
      expect(def.phase).toBe("P7A-4");
    }
  });

  test("POL-679 target set is fully implemented", () => {
    const expectedImplemented = [
      "agents-toolkit-doctor",
      "agents-tools-bump",
      "agent-notify",
      "docstore",
      "agents-fleet-smoke",
      "agents-bundle-build",
      "agent-mail",
      "execplan-new",
      "agents-bootstrap"
    ];

    for (const name of expectedImplemented) {
      const def = implemented.find((d) => d.wrapper === name);
      expect(def, `expected "${name}" to be implemented`).toBeDefined();
    }
  });

  test("POL-680 scope is deprecated (explicit decision)", () => {
    const expectedDeprecated = [
      "agents-fleet",
      "agents-fleet-apply",
      "agents-worktree-init"
    ];

    for (const name of expectedDeprecated) {
      const def = deprecated.find((d) => d.wrapper === name);
      expect(def, `expected "${name}" to be deprecated`).toBeDefined();
    }
  });

  test("all deprecated wrappers have deprecatedAt dates", () => {
    for (const def of deprecated) {
      expect(def.deprecatedAt).toBeTruthy();
      expect(new Date(def.deprecatedAt!).toISOString()).toContain("2026");
    }
  });

  test("all deprecated wrappers have rationale", () => {
    for (const def of deprecated) {
      expect(def.rationale, `${def.wrapper} missing rationale`).toBeTruthy();
    }
  });

  test("all deprecated wrappers have alternatives", () => {
    for (const def of deprecated) {
      expect(def.alternatives, `${def.wrapper} missing alternatives`).toBeDefined();
      expect(def.alternatives!.length).toBeGreaterThan(0);
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

  test("total registry size is 19 (7 retired + 9 implemented + 3 deprecated)", () => {
    expect(WRAPPER_REGISTRY).toHaveLength(19);
  });
});

// ── Implemented wrapper delegation (POL-679) ────────────────────────

describe("implemented wrapper canonical command functions", () => {
  test("execNotify returns structured result", async () => {
    const result = await execNotify({
      message: "test notification",
      level: "info",
      channel: "stdout"
    });
    expect(result.message).toBe("test notification");
    expect(result.level).toBe("info");
    expect(result.channel).toBe("stdout");
    expect(result.delivered).toBe(true);
    expect(result.timestamp).toBeTruthy();
  });

  test("execNotify defaults level and channel", async () => {
    const result = await execNotify({ message: "minimal" });
    expect(result.level).toBe("info");
    expect(result.channel).toBe("stdout");
  });

  test("bumpToolVersion returns plan result for known tool", async () => {
    const registryPath = path.join(fixtureRoot(), "tools/registry.valid.json");
    const result = await bumpToolVersion(registryPath, {
      tool: "cass",
      to: "2.0.0"
    });
    expect(result.tool).toBe("cass");
    expect(result.to).toBe("2.0.0");
    expect(result.action).toBe("plan-bump");
    expect(result.apply).toBe(false);
    expect(result.from).toBeTruthy();
  });

  test("bumpToolVersion returns not-found for unknown tool", async () => {
    const registryPath = path.join(fixtureRoot(), "tools/registry.valid.json");
    const result = await bumpToolVersion(registryPath, {
      tool: "nonexistent-tool",
      to: "2.0.0"
    });
    expect(result.action).toBe("not-found");
    expect(result.from).toBeUndefined();
  });

  test("createExecPlan returns plan result", async () => {
    const result = await createExecPlan({
      title: "Test ExecPlan",
      issueId: "POL-999"
    });
    expect(result.id).toContain("execplan-pol-999");
    expect(result.title).toBe("Test ExecPlan");
    expect(result.action).toBe("plan-create");
    expect(result.apply).toBe(false);
  });

  test("createExecPlan generates id from issueId", async () => {
    const result = await createExecPlan({
      title: "Another Plan",
      issueId: "POL-123"
    });
    expect(result.id).toBe("execplan-pol-123");
  });

  test("runDoctor returns structured health report", async () => {
    const result = await runDoctor();
    expect(result.timestamp).toBeTruthy();
    expect(Array.isArray(result.domains)).toBe(true);
    expect(result.domains.length).toBeGreaterThan(0);
    // Without configured paths, all domains should be unconfigured
    for (const domain of result.domains) {
      expect(domain.domain).toBeTruthy();
      expect(["ok", "warning", "error", "unconfigured"]).toContain(domain.health);
    }
  });

  test("installBootstrap returns plan result", async () => {
    const result = await installBootstrap({ target: "/tmp/test-agents" });
    expect(result.target).toBe("/tmp/test-agents");
    expect(result.action).toBe("plan-bootstrap");
    expect(result.apply).toBe(false);
    expect(result.steps.length).toBeGreaterThan(0);
  });

  test("buildBundle returns plan result for valid package", async () => {
    // Use the calyx-ext-hello example as a test target
    const pkgPath = path.resolve(process.cwd(), "examples/calyx-ext-hello");
    const result = await buildBundle({ path: pkgPath });
    expect(result.name).toBeTruthy();
    expect(result.version).toBeTruthy();
    expect(result.action).toBe("plan-build");
    expect(result.apply).toBe(false);
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
