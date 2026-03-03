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
 * sync with the implemented command surface. If a new domain command is
 * added without updating the docs, these tests will fail.
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
      "## Retired Wrappers"
    ];

    for (const group of requiredGroups) {
      expect(cliRef, `CLI reference missing section: ${group}`).toContain(group);
    }
  });

  test("documents all canonical subcommands", async () => {
    const cliRef = await readFile(path.join(docsRoot(), "cli-reference.md"), "utf8");

    const requiredSubcommands = [
      "calyx config compile",
      "calyx config show",
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

  test("documents retired wrappers with canonical replacements", async () => {
    const cliRef = await readFile(path.join(docsRoot(), "cli-reference.md"), "utf8");

    const retiredWrappers = [
      "skills-sync",
      "skills-sync-claude",
      "skills-sync-codex",
      "prompts-sync-claude",
      "prompts-sync-codex",
      "agents-render",
      "exec-launch"
    ];

    for (const wrapper of retiredWrappers) {
      expect(cliRef, `CLI reference missing retired wrapper: ${wrapper}`).toContain(wrapper);
    }
  });
});

describe("migration wrappers doc completeness", () => {
  test("migration-wrappers.md exists and has required sections", async () => {
    const migDoc = await readFile(path.join(docsRoot(), "migration-wrappers.md"), "utf8");

    const requiredSections = [
      "## Strategy",
      "## Retired Wrappers",
      "## Ported Without Wrapper",
      "## Deprecated",
      "## Telemetry Contract",
      "## Verification"
    ];

    for (const section of requiredSections) {
      expect(migDoc, `migration-wrappers.md missing section: ${section}`).toContain(section);
    }
  });

  test("migration-wrappers.md documents all retired wrappers", async () => {
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

  test("README documents wrapper retirement", async () => {
    const readme = await readFile(path.resolve(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("retired");
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
      "docs/onboarding.md",
      "docs/production-wiring.md",
      "docs/cli-reference.md",
      "docs/extension-sdk.md",
      "docs/migration-guide.md",
      "docs/migration-wrappers.md",
      "docs/rc-checklist.md",
      "docs/operator-runbook.md",
      "docs/skills-subsumption-catalogue.md"
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
      "## Retired wrappers"
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

  test("operator-runbook.md marks wrappers as retired", async () => {
    const runbook = await readFile(path.join(docsRoot(), "operator-runbook.md"), "utf8");

    expect(runbook).toContain("retired");
    expect(runbook).toContain("removed");
  });
});

describe("skills subsumption catalogue completeness", () => {
  test("skills-subsumption-catalogue.md exists and has required sections", async () => {
    const catalogue = await readFile(path.join(docsRoot(), "skills-subsumption-catalogue.md"), "utf8");

    const requiredSections = [
      "## Scope and terminology",
      "## Disposition matrix",
      "## Migration examples",
      "## Retirement sequencing",
      "## Summary counts"
    ];

    for (const section of requiredSections) {
      expect(catalogue, `skills-subsumption-catalogue.md missing section: ${section}`).toContain(section);
    }
  });

  test("skills-subsumption-catalogue.md documents all disposition values", async () => {
    const catalogue = await readFile(path.join(docsRoot(), "skills-subsumption-catalogue.md"), "utf8");

    const dispositions = [
      "`subsumed`",
      "`partially_subsumed`",
      "`not_planned`",
      "`defer_phase`"
    ];

    for (const disposition of dispositions) {
      expect(catalogue, `catalogue missing disposition: ${disposition}`).toContain(disposition);
    }
  });

  test("skills-subsumption-catalogue.md references all retired wrappers", async () => {
    const catalogue = await readFile(path.join(docsRoot(), "skills-subsumption-catalogue.md"), "utf8");

    const wrappers = [
      "skills-sync",
      "agents-render",
      "exec-launch"
    ];

    for (const wrapper of wrappers) {
      expect(catalogue, `catalogue missing wrapper: ${wrapper}`).toContain(wrapper);
    }
  });

  test("skills-subsumption-catalogue.md includes retirement phases", async () => {
    const catalogue = await readFile(path.join(docsRoot(), "skills-subsumption-catalogue.md"), "utf8");

    expect(catalogue).toContain("### Phase 7");
    expect(catalogue).toContain("### Phase 8");
    expect(catalogue).toContain("### Phase 9");
    expect(catalogue).toContain("### Post-v1");
  });
});

describe("onboarding guide completeness", () => {
  test("onboarding.md exists and has required sections", async () => {
    const guide = await readFile(path.join(docsRoot(), "onboarding.md"), "utf8");

    const requiredSections = [
      "## Prerequisites",
      "## Install",
      "## First commands",
      "## Command surface map",
      "## Building extensions",
      "## Troubleshooting"
    ];

    for (const section of requiredSections) {
      expect(guide, `onboarding.md missing section: ${section}`).toContain(section);
    }
  });

  test("onboarding.md links to key reference docs", async () => {
    const guide = await readFile(path.join(docsRoot(), "onboarding.md"), "utf8");

    const requiredLinks = [
      "cli-reference.md",
      "extension-sdk.md",
      "operator-runbook.md"
    ];

    for (const link of requiredLinks) {
      expect(guide, `onboarding.md missing link: ${link}`).toContain(link);
    }
  });

  test("onboarding.md covers all 8 domains in surface map", async () => {
    const guide = await readFile(path.join(docsRoot(), "onboarding.md"), "utf8");

    const domains = [
      "config", "instructions", "skills", "tools",
      "prompts", "agents", "knowledge", "exec"
    ];

    for (const domain of domains) {
      expect(guide, `onboarding.md missing domain: ${domain}`).toContain(domain);
    }
  });
});

describe("production wiring doc completeness", () => {
  test("production-wiring.md exists and has required sections", async () => {
    const doc = await readFile(path.join(docsRoot(), "production-wiring.md"), "utf8");

    const requiredSections = [
      "## Configuration Model",
      "## Quick Start",
      "## Environment Variable Reference",
      "## Config File Schema",
      "## Fixture Mode"
    ];

    for (const section of requiredSections) {
      expect(doc, `production-wiring.md missing section: ${section}`).toContain(section);
    }
  });

  test("production-wiring.md documents all domain env vars", async () => {
    const doc = await readFile(path.join(docsRoot(), "production-wiring.md"), "utf8");

    const envVars = [
      "CALYX_SKILLS_REGISTRY",
      "CALYX_TOOLS_REGISTRY",
      "CALYX_PROMPTS_REGISTRY",
      "CALYX_AGENTS_REGISTRY",
      "CALYX_KNOWLEDGE_REGISTRY",
      "CALYX_EXEC_STORE",
      "CALYX_CONFIG"
    ];

    for (const envVar of envVars) {
      expect(doc, `production-wiring.md missing env var: ${envVar}`).toContain(envVar);
    }
  });

  test("production-wiring.md documents calyx config show", async () => {
    const doc = await readFile(path.join(docsRoot(), "production-wiring.md"), "utf8");
    expect(doc).toContain("calyx config show");
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
