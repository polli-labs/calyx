import { describe, expect, test } from "vitest";
import { buildProgram } from "../run-cli";
import { INTERFACE_DOMAIN_CLASSIFICATIONS, WRAPPER_REGISTRY } from "@polli-labs/calyx-core";

/**
 * Help ordering regression tests.
 *
 * These tests enforce that `calyx --help` lists canonical command groups only.
 * Legacy wrappers are handled before Commander parsing so they do not pollute
 * the first operator-facing surface.
 */

const DOMAIN_COMMANDS = INTERFACE_DOMAIN_CLASSIFICATIONS.map((record) => record.domain);

describe("help ordering", () => {
  const program = buildProgram();
  const commandNames = program.commands.map((c) => c.name());

  test("all canonical command groups are registered", () => {
    for (const domain of DOMAIN_COMMANDS) {
      expect(commandNames, `missing domain command: ${domain}`).toContain(domain);
    }
  });

  test("legacy wrappers are not registered as visible help commands", () => {
    const wrapperNames = new Set(WRAPPER_REGISTRY.map((d) => d.wrapper));
    const visibleWrappers = commandNames.filter((name) => wrapperNames.has(name));
    expect(visibleWrappers).toEqual([]);
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

  test("help output omits wrapper and tombstone rows", () => {
    const help = buildProgram().helpInformation();
    for (const def of WRAPPER_REGISTRY) {
      expect(help, `help should omit legacy wrapper ${def.wrapper}`).not.toContain(def.wrapper);
    }
  });
});
