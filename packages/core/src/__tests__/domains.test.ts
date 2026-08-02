import path from "node:path";
import { describe, expect, test } from "vitest";
import { indexAgentsRegistry, showAgentDefinition, validateAgentsRegistry } from "../agents";
import { indexKnowledgeRegistry, searchKnowledgeRegistry, linkKnowledgeArtifact, validateKnowledgeRegistry } from "../knowledge";
import { indexPromptsRegistry, validatePromptsRegistry } from "../prompts";
import { indexSkillsRegistry, validateSkillsRegistry } from "../skills";
import { indexToolsRegistry, validateToolsRegistry } from "../tools";

function fixtureRoot(): string {
  return path.resolve(process.cwd(), "fixtures/domains");
}

describe("skills domain", () => {
  test("indexes active + deprecated skills by default (retired and archived excluded)", async () => {
    const root = fixtureRoot();
    const indexResult = await indexSkillsRegistry(path.join(root, "skills/registry.valid.json"));

    expect(indexResult.total).toBe(4);
    expect(indexResult.items.map((entry) => entry.id)).toEqual(["agents-fleet", "agents-fleet-bootstrap"]);
  });

  test("can include archived skills in index output", async () => {
    const root = fixtureRoot();
    const indexResult = await indexSkillsRegistry(path.join(root, "skills/registry.valid.json"), {
      includeArchived: true
    });

    expect(indexResult.items.some((entry) => entry.status === "archived")).toBe(true);
  });

  test("can include retired skills in index output", async () => {
    const root = fixtureRoot();
    const indexResult = await indexSkillsRegistry(path.join(root, "skills/registry.valid.json"), {
      includeRetired: true
    });

    expect(indexResult.items.some((entry) => entry.status === "retired")).toBe(true);
    expect(indexResult.items.find((entry) => entry.status === "retired")?.retired_at).toBe("2026-04-02");
  });

  test("retired status does not require deprecated_by (validator accepts it)", async () => {
    const root = fixtureRoot();
    const validation = await validateSkillsRegistry(path.join(root, "skills/registry.valid.json"), {
      strict: true
    });

    expect(validation.ok).toBe(true);
    expect(validation.retired).toBe(1);
    expect(
      validation.errors.some((issue) => issue.code === "skills.deprecated-missing-replacement")
    ).toBe(false);
  });

  test("reports lifecycle validation errors for invalid registry", async () => {
    const root = fixtureRoot();
    const validation = await validateSkillsRegistry(path.join(root, "skills/registry.invalid.json"), {
      strict: true
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors.some((issue) => issue.code === "skills.duplicate-id")).toBe(true);
    expect(validation.errors.some((issue) => issue.code === "skills.deprecated-missing-replacement")).toBe(true);
    expect(validation.errors.some((issue) => issue.code === "skills.archived-missing-date")).toBe(true);
    expect(validation.errors.some((issue) => issue.code === "skills.retired-missing-date")).toBe(true);
  });
});

describe("tools domain", () => {
  test("indexes tool registry entries", async () => {
    const root = fixtureRoot();
    const indexResult = await indexToolsRegistry(path.join(root, "tools/registry.valid.json"));

    expect(indexResult.total).toBe(2);
    expect(indexResult.items.map((entry) => entry.name)).toEqual(["cass", "oracle"]);
  });

  test("reports duplicate and version-format issues", async () => {
    const root = fixtureRoot();
    const validation = await validateToolsRegistry(path.join(root, "tools/registry.invalid.json"), {
      strict: true
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors.some((issue) => issue.code === "tools.duplicate-name")).toBe(true);
    expect(validation.errors.some((issue) => issue.code === "tools.version-format")).toBe(true);
  });
});

describe("prompts domain", () => {
  test("indexes prompt registry entries", async () => {
    const root = fixtureRoot();
    const indexResult = await indexPromptsRegistry(path.join(root, "prompts/registry.valid.json"));

    expect(indexResult.total).toBe(2);
    expect(indexResult.items.map((entry) => entry.id)).toEqual(["execute-execplan", "review-pr"]);
  });

  test("reports duplicate ids and variable contract errors", async () => {
    const root = fixtureRoot();
    const validation = await validatePromptsRegistry(path.join(root, "prompts/registry.invalid.json"), {
      strict: true
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors.some((issue) => issue.code === "prompts.duplicate-id")).toBe(true);
    expect(validation.errors.some((issue) => issue.code === "prompts.duplicate-required-variable")).toBe(true);
    expect(validation.errors.some((issue) => issue.code === "prompts.variable-overlap")).toBe(true);
  });
});

describe("agents domain", () => {
  test("indexes active agent definitions by default", async () => {
    const root = fixtureRoot();
    const indexResult = await indexAgentsRegistry(path.join(root, "agents/AGENTS.json"));

    expect(indexResult.total).toBe(2);
    expect(indexResult.items.map((entry) => entry.id)).toEqual(["fixture-reviewer"]);
    expect(indexResult.items[0]?.description).toBe("Fixture reviewer used by POL-1799 launch tests.");
  });

  test("shows a concrete agent definition", async () => {
    const root = fixtureRoot();
    const result = await showAgentDefinition(path.join(root, "agents/AGENTS.json"), "fixture-reviewer");

    expect(result.agent.id).toBe("fixture-reviewer");
    expect(result.agent.persona.template).toBe("prompt.md");
    expect(result.agent.output?.required_artifacts).toEqual(["findings.md", "findings.json"]);
  });

  test("shows blocked lifecycle metadata without making it default inventory", async () => {
    const root = fixtureRoot();
    const result = await showAgentDefinition(path.join(root, "agents/AGENTS.json"), "fixture-blocked");

    expect(result).toMatchObject({
      status: "blocked",
      lifecycle: {
        blocked_reason: "Prerequisite safety receipts are incomplete.",
        blocked_by: ["POL-2058", "POL-2060"],
      },
    });
  });

  test("reports lifecycle validation errors for invalid registry", async () => {
    const root = fixtureRoot();
    const validation = await validateAgentsRegistry(path.join(root, "agents/registry.invalid.json"), {
      strict: true
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors.some((issue) => issue.code === "agents.duplicate-id")).toBe(true);
    expect(validation.errors.some((issue) => issue.code === "agents.definition-invalid")).toBe(true);
  });
});

describe("knowledge domain", () => {
  test("indexes knowledge artifacts", async () => {
    const root = fixtureRoot();
    const indexResult = await indexKnowledgeRegistry(path.join(root, "knowledge/registry.valid.json"));

    expect(indexResult.total).toBe(3);
    expect(indexResult.items.map((entry) => entry.id)).toEqual([
      "execplan-unified-agents",
      "runbook-async-runner",
      "transcript-sprint-planning"
    ]);
  });

  test("filters by kind", async () => {
    const root = fixtureRoot();
    const indexResult = await indexKnowledgeRegistry(path.join(root, "knowledge/registry.valid.json"), {
      kind: "execplan"
    });

    expect(indexResult.items.length).toBe(1);
    expect(indexResult.items[0]!.id).toBe("execplan-unified-agents");
  });

  test("searches artifacts by query", async () => {
    const root = fixtureRoot();
    const searchResult = await searchKnowledgeRegistry(path.join(root, "knowledge/registry.valid.json"), {
      query: "runner"
    });

    expect(searchResult.total).toBe(1);
    expect(searchResult.items[0]!.id).toBe("runbook-async-runner");
  });

  test("searches artifacts by linked issue", async () => {
    const root = fixtureRoot();
    const searchResult = await searchKnowledgeRegistry(path.join(root, "knowledge/registry.valid.json"), {
      query: "POL-605"
    });

    expect(searchResult.total).toBe(1);
    expect(searchResult.items[0]!.id).toBe("execplan-unified-agents");
  });

  test("searches artifacts by frontmatter selector fields", async () => {
    const root = fixtureRoot();
    const searchResult = await searchKnowledgeRegistry(path.join(root, "knowledge/registry.valid.json"), {
      query: "doc_type:runbook scope:operations"
    });

    expect(searchResult.total).toBe(1);
    expect(searchResult.items[0]!.id).toBe("runbook-async-runner");
  });

  test("searches artifacts by metadata selector fields", async () => {
    const root = fixtureRoot();
    const searchResult = await searchKnowledgeRegistry(path.join(root, "knowledge/registry.valid.json"), {
      query: "meta.docstore_id:ep-2026-0225 metadata.host:blade"
    });

    expect(searchResult.total).toBe(1);
    expect(searchResult.items[0]!.id).toBe("execplan-unified-agents");
  });

  test("links artifact to issue", async () => {
    const root = fixtureRoot();
    const linkResult = await linkKnowledgeArtifact(path.join(root, "knowledge/registry.valid.json"), {
      artifactId: "execplan-unified-agents",
      issueId: "POL-633"
    });

    expect(linkResult.action).toBe("plan-link");
    expect(linkResult.artifactId).toBe("execplan-unified-agents");
    expect(linkResult.issueId).toBe("POL-633");
  });

  test("detects already-linked artifact", async () => {
    const root = fixtureRoot();
    const linkResult = await linkKnowledgeArtifact(path.join(root, "knowledge/registry.valid.json"), {
      artifactId: "execplan-unified-agents",
      issueId: "POL-605"
    });

    expect(linkResult.action).toBe("already-linked");
  });

  test("reports duplicate ids and linked-issue errors for invalid registry", async () => {
    const root = fixtureRoot();
    const validation = await validateKnowledgeRegistry(path.join(root, "knowledge/registry.invalid.json"), {
      strict: true
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors.some((issue) => issue.code === "knowledge.duplicate-id")).toBe(true);
    expect(validation.errors.some((issue) => issue.code === "knowledge.duplicate-linked-issue")).toBe(true);
  });
});
