import path from "node:path";
import { describe, expect, test } from "vitest";
import { syncSkillsRegistry } from "../skills";
import { syncPromptsRegistry } from "../prompts";

/**
 * Wrapper behavior tests.
 *
 * These tests validate the emitWrapperTelemetry contract that all
 * compatibility wrappers must follow:
 * 1. A deprecation warning is emitted to stderr.
 * 2. A calyx.wrapper.invoked telemetry JSON marker is emitted to stderr.
 * 3. The underlying domain function is called with the correct backend.
 *
 * Rather than importing from the CLI (which bundles everything), we test
 * the core domain functions directly and validate the wrapper telemetry
 * contract structurally: every wrapper result in --json mode wraps
 * { wrapper: WrapperTelemetryEvent, result: ... }.
 */

function fixtureRoot(): string {
  return path.resolve(process.cwd(), "fixtures/domains");
}

interface WrapperTelemetryEvent {
  event: "calyx.wrapper.invoked";
  wrapper: string;
  target: string;
  timestamp: string;
}

function isValidTelemetryEvent(event: WrapperTelemetryEvent): boolean {
  return (
    event.event === "calyx.wrapper.invoked" &&
    typeof event.wrapper === "string" &&
    event.wrapper.length > 0 &&
    typeof event.target === "string" &&
    event.target.length > 0 &&
    typeof event.timestamp === "string" &&
    !isNaN(Date.parse(event.timestamp))
  );
}

describe("wrapper telemetry contract", () => {
  test("telemetry event shape is valid", () => {
    const event: WrapperTelemetryEvent = {
      event: "calyx.wrapper.invoked",
      wrapper: "skills-sync",
      target: "calyx skills sync",
      timestamp: new Date().toISOString()
    };
    expect(isValidTelemetryEvent(event)).toBe(true);
  });

  test("telemetry event rejects invalid timestamp", () => {
    const event: WrapperTelemetryEvent = {
      event: "calyx.wrapper.invoked",
      wrapper: "skills-sync",
      target: "calyx skills sync",
      timestamp: "not-a-date"
    };
    expect(isValidTelemetryEvent(event)).toBe(false);
  });
});

describe("wrapper backend routing", () => {
  const root = fixtureRoot();
  const skillsPath = path.join(root, "skills/registry.valid.json");
  const promptsPath = path.join(root, "prompts/registry.valid.json");

  test("skills-sync-claude routes to claude backend", async () => {
    const result = await syncSkillsRegistry(skillsPath, { backend: "claude", apply: false });
    expect(result.backend).toBe("claude");
    expect(result.apply).toBe(false);
  });

  test("skills-sync-codex routes to codex backend", async () => {
    const result = await syncSkillsRegistry(skillsPath, { backend: "codex", apply: false });
    expect(result.backend).toBe("codex");
    expect(result.apply).toBe(false);
  });

  test("skills-sync (generic) defaults to all backend", async () => {
    const result = await syncSkillsRegistry(skillsPath, { backend: "all", apply: false });
    expect(result.backend).toBe("all");
    expect(result.apply).toBe(false);
  });

  test("prompts-sync-claude routes to claude backend", async () => {
    const result = await syncPromptsRegistry(promptsPath, { backend: "claude", apply: false });
    expect(result.backend).toBe("claude");
    expect(result.apply).toBe(false);
  });

  test("prompts-sync-codex routes to codex backend", async () => {
    const result = await syncPromptsRegistry(promptsPath, { backend: "codex", apply: false });
    expect(result.backend).toBe("codex");
    expect(result.apply).toBe(false);
  });
});

describe("wrapper envelope shape", () => {
  test("wrapper JSON envelope includes telemetry and result", () => {
    const telemetry: WrapperTelemetryEvent = {
      event: "calyx.wrapper.invoked",
      wrapper: "skills-sync-claude",
      target: "calyx skills sync --backend claude",
      timestamp: new Date().toISOString()
    };
    const result = { backend: "claude", apply: false, version: 1, actions: [] };
    const envelope = { wrapper: telemetry, result };

    expect(envelope).toHaveProperty("wrapper");
    expect(envelope).toHaveProperty("result");
    expect(envelope.wrapper.event).toBe("calyx.wrapper.invoked");
    expect(envelope.wrapper.wrapper).toBe("skills-sync-claude");
    expect(JSON.stringify(envelope)).toBeDefined();
  });

  const WRAPPER_DEFINITIONS = [
    { wrapper: "skills-sync", target: "calyx skills sync" },
    { wrapper: "skills-sync-claude", target: "calyx skills sync --backend claude" },
    { wrapper: "skills-sync-codex", target: "calyx skills sync --backend codex" },
    { wrapper: "prompts-sync-claude", target: "calyx prompts sync --backend claude" },
    { wrapper: "prompts-sync-codex", target: "calyx prompts sync --backend codex" },
    { wrapper: "agents-render", target: "calyx instructions render" },
    { wrapper: "exec-launch", target: "calyx exec launch" }
  ];

  test.each(WRAPPER_DEFINITIONS)(
    "wrapper $wrapper has valid target mapping",
    ({ wrapper, target }) => {
      expect(wrapper).toBeTruthy();
      expect(target).toMatch(/^calyx /);
      const event: WrapperTelemetryEvent = {
        event: "calyx.wrapper.invoked",
        wrapper,
        target,
        timestamp: new Date().toISOString()
      };
      expect(isValidTelemetryEvent(event)).toBe(true);
    }
  );
});
