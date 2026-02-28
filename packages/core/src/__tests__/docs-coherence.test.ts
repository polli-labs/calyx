import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

function docsRoot(): string {
  return path.resolve(process.cwd(), "docs");
}

/**
 * Docs coherence tests.
 *
 * These assertions verify that the CLI reference documentation stays in
 * sync with the implemented command surface. If a new domain command or
 * wrapper is added without updating the docs, these tests will fail.
 */

describe("CLI reference completeness", () => {
  test("documents all domain command groups", async () => {
    const cliRef = await readFile(path.join(docsRoot(), "cli-reference.md"), "utf8");

    const requiredGroups = [
      "## Config Commands",
      "## Instructions Commands",
      "## Skills Commands",
      "## Tools Commands",
      "## Prompts Commands",
      "## Agents Commands",
      "## Knowledge Commands",
      "## Exec Commands",
      "## Compatibility Wrappers"
    ];

    for (const group of requiredGroups) {
      expect(cliRef, `CLI reference missing section: ${group}`).toContain(group);
    }
  });

  test("documents all canonical subcommands", async () => {
    const cliRef = await readFile(path.join(docsRoot(), "cli-reference.md"), "utf8");

    const requiredSubcommands = [
      "calyx config compile",
      "calyx instructions render",
      "calyx instructions verify",
      "calyx skills index",
      "calyx skills sync",
      "calyx skills validate",
      "calyx tools index",
      "calyx tools sync",
      "calyx tools validate",
      "calyx prompts index",
      "calyx prompts sync",
      "calyx prompts validate",
      "calyx agents index",
      "calyx agents render-profiles",
      "calyx agents deploy",
      "calyx agents sync",
      "calyx agents validate",
      "calyx knowledge index",
      "calyx knowledge search",
      "calyx knowledge link",
      "calyx knowledge validate",
      "calyx exec launch",
      "calyx exec status",
      "calyx exec logs",
      "calyx exec receipt",
      "calyx exec validate"
    ];

    for (const cmd of requiredSubcommands) {
      expect(cliRef, `CLI reference missing subcommand: ${cmd}`).toContain(cmd);
    }
  });

  test("documents all compatibility wrappers", async () => {
    const cliRef = await readFile(path.join(docsRoot(), "cli-reference.md"), "utf8");

    const requiredWrappers = [
      "calyx skills-sync",
      "calyx skills-sync-claude",
      "calyx skills-sync-codex",
      "calyx prompts-sync-claude",
      "calyx prompts-sync-codex",
      "calyx agents-render",
      "calyx exec-launch"
    ];

    for (const wrapper of requiredWrappers) {
      expect(cliRef, `CLI reference missing wrapper: ${wrapper}`).toContain(wrapper);
    }
  });
});

describe("migration wrappers doc completeness", () => {
  test("migration-wrappers.md exists and has required sections", async () => {
    const migDoc = await readFile(path.join(docsRoot(), "migration-wrappers.md"), "utf8");

    const requiredSections = [
      "## Strategy",
      "## Implemented Wrappers",
      "## Ported Without Wrapper",
      "## Deferred",
      "## Telemetry Contract",
      "## Verification"
    ];

    for (const section of requiredSections) {
      expect(migDoc, `migration-wrappers.md missing section: ${section}`).toContain(section);
    }
  });

  test("migration-wrappers.md documents all implemented wrappers", async () => {
    const migDoc = await readFile(path.join(docsRoot(), "migration-wrappers.md"), "utf8");

    const wrappers = [
      "skills-sync",
      "skills-sync-claude",
      "skills-sync-codex",
      "prompts-sync-claude",
      "prompts-sync-codex",
      "agents-render",
      "exec-launch"
    ];

    for (const wrapper of wrappers) {
      expect(migDoc, `migration-wrappers.md missing wrapper: ${wrapper}`).toContain(wrapper);
    }
  });
});

describe("README completeness", () => {
  test("README covers all domain command groups", async () => {
    const readme = await readFile(path.resolve(process.cwd(), "README.md"), "utf8");

    const requiredDomains = [
      "Config compile",
      "Instructions render",
      "Skills index",
      "Tools index",
      "Prompts index",
      "Agents index",
      "Knowledge index",
      "Exec launch"
    ];

    for (const domain of requiredDomains) {
      expect(readme, `README missing domain coverage: ${domain}`).toContain(domain);
    }
  });

  test("README documents migration wrappers", async () => {
    const readme = await readFile(path.resolve(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("Migration wrappers");
    expect(readme).toContain("migration-wrappers.md");
  });
});
