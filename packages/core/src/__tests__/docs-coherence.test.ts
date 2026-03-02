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

  test("README documents extension model", async () => {
    const readme = await readFile(path.resolve(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("extension-sdk.md");
    expect(readme).toContain("calyx-ext-hello");
    expect(readme).toContain("@polli-labs/calyx-sdk");
  });

  test("README documents package boundaries", async () => {
    const readme = await readFile(path.resolve(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("@polli-labs/calyx-core");
    expect(readme).toContain("@polli-labs/calyx");
    expect(readme).toContain("@polli-labs/calyx-sdk");
    expect(readme).toContain("@polli-labs/calyx-web");
  });

  test("README links to all docs", async () => {
    const readme = await readFile(path.resolve(process.cwd(), "README.md"), "utf8");

    const requiredLinks = [
      "docs/cli-reference.md",
      "docs/extension-sdk.md",
      "docs/migration-guide.md",
      "docs/migration-wrappers.md",
      "docs/rc-checklist.md",
      "docs/operator-runbook.md"
    ];

    for (const link of requiredLinks) {
      expect(readme, `README missing link: ${link}`).toContain(link);
    }
  });
});

describe("extension SDK doc completeness", () => {
  test("extension-sdk.md exists and has required sections", async () => {
    const sdkDoc = await readFile(path.join(docsRoot(), "extension-sdk.md"), "utf8");

    const requiredSections = [
      "## Concepts",
      "## Quick start",
      "## API Reference",
      "## Lifecycle",
      "## Compatibility"
    ];

    for (const section of requiredSections) {
      expect(sdkDoc, `extension-sdk.md missing section: ${section}`).toContain(section);
    }
  });

  test("extension-sdk.md documents all 8 domains", async () => {
    const sdkDoc = await readFile(path.join(docsRoot(), "extension-sdk.md"), "utf8");

    const domains = [
      "config", "instructions", "skills", "tools",
      "prompts", "agents", "knowledge", "exec"
    ];

    for (const domain of domains) {
      expect(sdkDoc, `extension-sdk.md missing domain: ${domain}`).toContain(domain);
    }
  });
});

describe("migration guide completeness", () => {
  test("migration-guide.md exists and covers key topics", async () => {
    const guide = await readFile(path.join(docsRoot(), "migration-guide.md"), "utf8");

    const requiredTopics = [
      "Prerequisites",
      "compatibility wrappers",
      "canonical commands",
      "Exit codes",
      "--json"
    ];

    for (const topic of requiredTopics) {
      expect(guide, `migration-guide.md missing topic: ${topic}`).toContain(topic);
    }
  });
});

describe("operator runbook completeness", () => {
  test("operator-runbook.md exists and has required sections", async () => {
    const runbook = await readFile(path.join(docsRoot(), "operator-runbook.md"), "utf8");

    const requiredSections = [
      "## Prerequisites",
      "## Command pattern",
      "## Daily operator workflows",
      "## Operator verification checklist",
      "## Failure classification",
      "## Wrapper deprecation notice"
    ];

    for (const section of requiredSections) {
      expect(runbook, `operator-runbook.md missing section: ${section}`).toContain(section);
    }
  });

  test("operator-runbook.md covers all 8 domain commands", async () => {
    const runbook = await readFile(path.join(docsRoot(), "operator-runbook.md"), "utf8");

    const domains = [
      "calyx config compile",
      "calyx instructions render",
      "calyx instructions verify",
      "calyx skills validate",
      "calyx tools validate",
      "calyx prompts validate",
      "calyx agents validate",
      "calyx knowledge validate",
      "calyx exec validate"
    ];

    for (const cmd of domains) {
      expect(runbook, `operator-runbook.md missing command: ${cmd}`).toContain(cmd);
    }
  });

  test("operator-runbook.md marks wrappers as deprecated", async () => {
    const runbook = await readFile(path.join(docsRoot(), "operator-runbook.md"), "utf8");

    expect(runbook).toContain("deprecated");
    expect(runbook).toContain("calyx.wrapper.invoked");
  });
});

describe("RC checklist completeness", () => {
  test("rc-checklist.md exists and has required sections", async () => {
    const checklist = await readFile(path.join(docsRoot(), "rc-checklist.md"), "utf8");

    const requiredSections = [
      "## Pre-release checklist",
      "## Release process",
      "## Rollback",
      "## Post-RC"
    ];

    for (const section of requiredSections) {
      expect(checklist, `rc-checklist.md missing section: ${section}`).toContain(section);
    }
  });
});
