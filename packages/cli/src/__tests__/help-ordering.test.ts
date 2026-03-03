import { describe, expect, test } from "vitest";
import { buildProgram } from "../run-cli";
import { WRAPPER_REGISTRY } from "@polli-labs/calyx-core";

/**
 * Help ordering regression tests.
 *
 * These tests enforce that `calyx --help` lists canonical domain commands
 * before compatibility wrapper tombstones, preventing regression to the
 * old ordering where wrappers dominated the top of help output.
 */

const DOMAIN_COMMANDS = [
  "config",
  "instructions",
  "skills",
  "tools",
  "prompts",
  "agents",
  "knowledge",
  "exec",
  "extensions"
];

describe("help ordering", () => {
  const program = buildProgram();
  const commandNames = program.commands.map((c) => c.name());

  test("all 9 domain commands are registered", () => {
    for (const domain of DOMAIN_COMMANDS) {
      expect(commandNames, `missing domain command: ${domain}`).toContain(domain);
    }
  });

  test("domain commands appear before any wrapper tombstones", () => {
    const wrapperNames = new Set(WRAPPER_REGISTRY.map((d) => d.wrapper));

    // Find the index of the last domain command and the first wrapper
    const domainIndices = DOMAIN_COMMANDS.map((d) => commandNames.indexOf(d));
    const lastDomainIndex = Math.max(...domainIndices);

    const firstWrapperIndex = commandNames.findIndex((name) => wrapperNames.has(name));

    expect(firstWrapperIndex).toBeGreaterThan(-1);
    expect(
      lastDomainIndex,
      `last domain command (${commandNames[lastDomainIndex]}) at index ${lastDomainIndex} must come before first wrapper (${commandNames[firstWrapperIndex]}) at index ${firstWrapperIndex}`
    ).toBeLessThan(firstWrapperIndex);
  });

  test("domain commands appear in canonical order", () => {
    const domainIndices = DOMAIN_COMMANDS.map((d) => commandNames.indexOf(d));

    for (let i = 1; i < domainIndices.length; i++) {
      expect(
        domainIndices[i],
        `${DOMAIN_COMMANDS[i]} (index ${domainIndices[i]}) should come after ${DOMAIN_COMMANDS[i - 1]} (index ${domainIndices[i - 1]})`
      ).toBeGreaterThan(domainIndices[i - 1]!);
    }
  });

  test("all retired wrappers are registered after domain commands", () => {
    const retired = WRAPPER_REGISTRY.filter((d) => d.status === "retired");
    const lastDomainIndex = Math.max(
      ...DOMAIN_COMMANDS.map((d) => commandNames.indexOf(d))
    );

    for (const def of retired) {
      const idx = commandNames.indexOf(def.wrapper);
      expect(idx, `retired wrapper "${def.wrapper}" must be registered`).toBeGreaterThan(-1);
      expect(
        idx,
        `retired wrapper "${def.wrapper}" (index ${idx}) must come after last domain command (index ${lastDomainIndex})`
      ).toBeGreaterThan(lastDomainIndex);
    }
  });

  test("all deferred wrappers are registered after domain commands", () => {
    const deferred = WRAPPER_REGISTRY.filter((d) => d.status === "deferred");
    const lastDomainIndex = Math.max(
      ...DOMAIN_COMMANDS.map((d) => commandNames.indexOf(d))
    );

    for (const def of deferred) {
      const idx = commandNames.indexOf(def.wrapper);
      expect(idx, `deferred wrapper "${def.wrapper}" must be registered`).toBeGreaterThan(-1);
      expect(
        idx,
        `deferred wrapper "${def.wrapper}" (index ${idx}) must come after last domain command (index ${lastDomainIndex})`
      ).toBeGreaterThan(lastDomainIndex);
    }
  });

  test("retired wrappers appear before deferred wrappers", () => {
    const retired = WRAPPER_REGISTRY.filter((d) => d.status === "retired");
    const deferred = WRAPPER_REGISTRY.filter((d) => d.status === "deferred");

    const lastRetiredIndex = Math.max(
      ...retired.map((d) => commandNames.indexOf(d.wrapper))
    );
    const firstDeferredIndex = Math.min(
      ...deferred.map((d) => commandNames.indexOf(d.wrapper))
    );

    expect(
      lastRetiredIndex,
      "retired wrappers should be grouped before deferred wrappers"
    ).toBeLessThan(firstDeferredIndex);
  });
});
